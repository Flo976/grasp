import { statSync } from 'node:fs';
import type { CdpClient, CdpEvent } from '../browser/cdp.js';
import { checkUrl, type EffectivePolicy } from '../core/policy.js';
import { GraspError, badRequest, conflict, forbidden, notFound } from '../core/errors.js';
import { buildSnapshot, diffSnapshots, INTERACTIVE, type AXNode, type Snapshot } from './snapshot.js';
import { parseKey } from './keys.js';

export interface ActionOptions { snapDiff?: boolean | undefined; maxBytes?: number | undefined }
export interface ActionResult { ok: true; diff?: string; detail?: string }
export interface Blocked { url: string; reason: string; at: number }

interface ElementInfo { tag: string; type: string; disabled: boolean; readOnly: boolean; editable: boolean; checkable: boolean; checked: boolean | null }

const REF_RE = /^e[0-9a-z]{1,4}$/;
const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'submit', 'button', 'file', 'image', 'reset', 'hidden', 'range', 'color']);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Contrôle d'un onglet via CDP. Détient le garde de navigation : la même `policy` (gelée) sert
 * au pré-contrôle de /navigate, à l'interception Fetch dans le navigateur, et au rapport.
 */
export class PageController {
  private loading = false;
  private pendingNavAt = 0;
  private blocked: Blocked | null = null;
  private lastDialog: string | null = null;
  private mainFrameId = '';

  private constructor(
    private readonly cdp: CdpClient,
    private readonly sessionId: string,
    private readonly targetId: string,
    readonly policy: Readonly<EffectivePolicy>,
  ) {}

  static async attach(cdp: CdpClient, policy: Readonly<EffectivePolicy>, opts: { downloadDir: string }): Promise<PageController> {
    const { targetInfos } = await cdp.send<{ targetInfos: Array<{ targetId: string; type: string }> }>('Target.getTargets');
    let targetId = targetInfos.find((t) => t.type === 'page')?.targetId;
    if (targetId === undefined) targetId = (await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' })).targetId;
    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    const pc = new PageController(cdp, sessionId, targetId, policy);
    await pc.init(opts.downloadDir);
    return pc;
  }

  private s<T = any>(method: string, params: object = {}): Promise<T> {
    return this.cdp.send<T>(method, params, this.sessionId);
  }

  private async init(downloadDir: string): Promise<void> {
    this.cdp.on('event', (e: CdpEvent) => { void this.onEvent(e); });
    await this.s('Page.enable');
    await this.s('DOM.enable');
    await this.s('Accessibility.enable');
    await this.guard(this.sessionId);
    const { frameTree } = await this.s<{ frameTree: { frame: { id: string } } }>('Page.getFrameTree');
    this.mainFrameId = frameTree.frame.id;
    await this.cdp.send('Browser.setDownloadBehavior', this.policy.allowDownload
      ? { behavior: 'allow', downloadPath: downloadDir }
      : { behavior: 'deny' });
    // Popups (window.open, target=_blank) : attachés en pause, gardés AVANT de s'exécuter.
    await this.cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  }

  /** Interception de toutes les requêtes de document (navigation, redirection, iframe). */
  private guard(sessionId: string): Promise<unknown> {
    return this.cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] }, sessionId);
  }

  private async onEvent(e: CdpEvent): Promise<void> {
    try {
      if (e.method === 'Fetch.requestPaused') {
        const url: string = e.params.request.url;
        const v = checkUrl(this.policy.allowedDomains, url);
        if (v.allowed) {
          await this.cdp.send('Fetch.continueRequest', { requestId: e.params.requestId }, e.sessionId);
        } else {
          this.blocked = { url, reason: v.reason, at: Date.now() };
          // « Aborted » : la navigation est annulée et la page courante reste affichée (pas de page d'erreur).
          await this.cdp.send('Fetch.failRequest', { requestId: e.params.requestId, errorReason: 'Aborted' }, e.sessionId);
          if (e.sessionId === this.sessionId) this.pendingNavAt = 0;
        }
        return;
      }
      if (e.method === 'Target.attachedToTarget' && e.sessionId === undefined) {
        const sid: string = e.params.sessionId;
        const info = e.params.targetInfo as { targetId: string; type: string };
        if (info.targetId === this.targetId) { await this.cdp.send('Target.detachFromTarget', { sessionId: sid }); return; }
        if (info.type === 'page' || info.type === 'iframe') await this.guard(sid);
        if (e.params.waitingForDebugger) await this.cdp.send('Runtime.runIfWaitingForDebugger', {}, sid);
        return;
      }
      if (e.sessionId !== this.sessionId) return;
      const main = e.params?.frameId === this.mainFrameId;
      switch (e.method) {
        case 'Page.frameRequestedNavigation': if (main && e.params.disposition === 'currentTab') this.pendingNavAt = Date.now(); break;
        case 'Page.frameStartedLoading': if (main) { this.loading = true; this.pendingNavAt = 0; } break;
        case 'Page.frameStoppedLoading': if (main) this.loading = false; break;
        case 'Page.navigatedWithinDocument': if (main) this.pendingNavAt = 0; break;
        case 'Page.javascriptDialogOpening': {
          // Un dialogue bloque tout l'onglet : on le ferme et on le signale.
          const type: string = e.params.type;
          this.lastDialog = `${type}: ${e.params.message}`;
          await this.s('Page.handleJavaScriptDialog', { accept: type === 'alert' || type === 'beforeunload' });
          break;
        }
      }
    } catch { /* cible fermée entre-temps */ }
  }

  lastBlocked(): Blocked | null { return this.blocked; }

  async location(): Promise<{ url: string; title: string }> {
    const h = await this.s<{ currentIndex: number; entries: Array<{ url: string; title: string }> }>('Page.getNavigationHistory');
    const cur = h.entries[h.currentIndex];
    return { url: cur?.url ?? 'about:blank', title: cur?.title ?? '' };
  }

  /** Attend la fin d'une éventuelle navigation déclenchée par une action. */
  private async settle(): Promise<void> {
    await sleep(60);
    const end = Date.now() + 30_000;
    while (Date.now() < end) {
      const pending = this.pendingNavAt !== 0 && Date.now() - this.pendingNavAt < 1500;
      if (!this.loading && !pending) break;
      await sleep(25);
    }
  }

  async navigate(url: string): Promise<{ url: string; title: string }> {
    const v = checkUrl(this.policy.allowedDomains, url);
    if (!v.allowed) throw forbidden(`navigation bloquée : ${v.reason}`);
    this.blocked = null;
    const loaded = this.onceEvent('Page.loadEventFired', 30_000);
    let r: { errorText?: string; loaderId?: string };
    try {
      r = await this.s('Page.navigate', { url });
    } catch (e) { loaded.cancel(); throw e; }
    if (r.errorText) {
      loaded.cancel();
      if (this.blocked !== null) {
        const b: Blocked = this.blocked;
        throw forbidden(`navigation bloquée par le garde : ${b.reason} (${b.url})`);
      }
      throw new GraspError(502, `navigation échouée : ${r.errorText}`);
    }
    if (r.loaderId) await loaded.promise; else loaded.cancel();
    await this.settle();
    return this.location();
  }

  private onceEvent(method: string, timeoutMs: number): { promise: Promise<void>; cancel(): void } {
    let done = false;
    let cleanup = () => {};
    const promise = new Promise<void>((resolve, reject) => {
      const on = (e: CdpEvent) => { if (e.method === method && e.sessionId === this.sessionId) { cleanup(); resolve(); } };
      const t = setTimeout(() => { cleanup(); reject(new GraspError(504, `délai dépassé en attendant ${method}`)); }, timeoutMs);
      cleanup = () => { if (done) return; done = true; clearTimeout(t); this.cdp.off('event', on); };
      this.cdp.on('event', on);
    });
    return { promise, cancel: () => { cleanup(); promise.catch(() => undefined); } };
  }

  async snapshot(opts: { maxBytes?: number | undefined } = {}): Promise<Snapshot> {
    const { nodes } = await this.s<{ nodes: AXNode[] }>('Accessibility.getFullAXTree');
    const { url, title } = await this.location();
    return buildSnapshot(nodes, opts.maxBytes !== undefined ? { url, title, maxBytes: opts.maxBytes } : { url, title });
  }

  async text(maxBytes = 64 * 1024): Promise<string> {
    const r = await this.s<{ result: { value?: string } }>('Runtime.evaluate', { expression: 'document.body ? document.body.innerText : ""', returnByValue: true });
    const t = r.result.value ?? '';
    const buf = Buffer.from(t);
    return buf.length <= maxBytes ? t : `${buf.subarray(0, maxBytes).toString('utf8')}\n… (tronqué à ${maxBytes} o)`;
  }

  // ---------- Sélecteurs : ref e5, CSS #id, texte text:Valider ----------

  private async resolve(sel: string, snap?: Snapshot): Promise<number> {
    const s = sel.trim();
    if (s === '') throw badRequest('sélecteur vide');
    if (REF_RE.test(s)) {
      const sn = snap ?? await this.snapshot();
      const id = sn.refs.get(s);
      if (id === undefined) throw notFound(`ref ${s} introuvable dans la page actuelle — refaites \`snap\``);
      return id;
    }
    if (s.startsWith('text:')) return this.resolveText(s.slice(5).trim(), snap ?? await this.snapshot());
    return this.resolveCss(s.startsWith('css:') ? s.slice(4) : s);
  }

  private resolveText(t: string, snap: Snapshot): number {
    if (!t) throw badRequest('text: attend un texte');
    const lower = t.toLowerCase();
    const all = [...snap.meta].map(([ref, m]) => ({ ref, ...m, id: snap.refs.get(ref) }));
    const tiers = [
      all.filter((c) => c.name === t && INTERACTIVE.has(c.role)),
      all.filter((c) => c.name === t),
      all.filter((c) => c.name.toLowerCase() === lower),
      all.filter((c) => INTERACTIVE.has(c.role) && c.name.toLowerCase().includes(lower)),
    ];
    for (const tier of tiers) {
      const hits = tier.filter((c) => c.id !== undefined);
      if (hits.length === 1) return hits[0]!.id!;
      if (hits.length > 1) throw conflict(`text:${t} est ambigu (${hits.length} correspondances : ${hits.slice(0, 8).map((h) => `${h.ref} ${h.role} "${h.name}"`).join(', ')}) — utilisez une ref`);
    }
    const textHits = snap.textNodes.filter((n) => n.text === t || n.text.toLowerCase().includes(lower));
    if (textHits.length === 1) return textHits[0]!.backendNodeId;
    if (textHits.length > 1) throw conflict(`text:${t} est ambigu (${textHits.length} textes correspondent) — utilisez une ref`);
    throw notFound(`aucun élément nommé « ${t} » — vérifiez avec \`snap\``);
  }

  private async resolveCss(selector: string): Promise<number> {
    const { root } = await this.s<{ root: { nodeId: number } }>('DOM.getDocument', { depth: 0 });
    let ids: number[];
    try {
      ({ nodeIds: ids } = await this.s<{ nodeIds: number[] }>('DOM.querySelectorAll', { nodeId: root.nodeId, selector }));
    } catch { throw badRequest(`sélecteur CSS invalide : ${selector}`); }
    if (ids.length === 0) throw notFound(`aucun élément ne correspond à ${selector}`);
    if (ids.length > 1) throw conflict(`${ids.length} éléments correspondent à ${selector} — précisez le sélecteur ou utilisez une ref`);
    const { node } = await this.s<{ node: { backendNodeId: number } }>('DOM.describeNode', { nodeId: ids[0] });
    return node.backendNodeId;
  }

  private async callOn<T>(backendNodeId: number, fn: string, ...args: unknown[]): Promise<T> {
    let objectId: string;
    try {
      ({ object: { objectId } } = await this.s<{ object: { objectId: string } }>('DOM.resolveNode', { backendNodeId, objectGroup: 'grasp' }));
    } catch { throw notFound("l'élément n'existe plus — refaites `snap`"); }
    const r = await this.s<{ result: { value?: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>('Runtime.callFunctionOn', {
      objectId, functionDeclaration: fn, arguments: args.map((value) => ({ value })), returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) throw new GraspError(500, `erreur dans la page : ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value as T;
  }

  private describe(id: number): Promise<ElementInfo> {
    return this.callOn<ElementInfo>(id, `function () {
      const el = this.nodeType === 1 ? this : this.parentElement;
      const type = (el.type || '').toLowerCase();
      const native = el.nodeName === 'INPUT' && (type === 'checkbox' || type === 'radio');
      const aria = el.getAttribute && el.getAttribute('aria-checked');
      return { tag: el.nodeName, type, disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
        readOnly: !!el.readOnly, editable: !!el.isContentEditable,
        checkable: native || aria !== null, checked: native ? el.checked : (aria === null ? null : aria === 'true') };
    }`);
  }

  private async act(opts: ActionOptions, fn: (snap: Snapshot | undefined) => Promise<string | void>): Promise<ActionResult> {
    this.lastDialog = null;
    const before = opts.snapDiff ? await this.snapshot({ maxBytes: opts.maxBytes }) : undefined;
    let detail: string | void;
    try { detail = await fn(before); } finally { void this.s('Runtime.releaseObjectGroup', { objectGroup: 'grasp' }).catch(() => undefined); }
    await this.settle();
    const res: ActionResult = { ok: true };
    const notes = [detail, this.lastDialog !== null ? `dialogue fermé — ${this.lastDialog}` : undefined, this.blocked !== null && Date.now() - this.blocked.at < 5000 ? `navigation bloquée : ${this.blocked.reason}` : undefined].filter((x): x is string => typeof x === 'string' && x !== '');
    if (notes.length) res.detail = notes.join(' ; ');
    if (before) res.diff = diffSnapshots(before, await this.snapshot({ maxBytes: opts.maxBytes }));
    return res;
  }

  private async clickNode(id: number): Promise<void> {
    const info = await this.describe(id);
    if (info.disabled) throw conflict('élément désactivé');
    await this.s('DOM.scrollIntoViewIfNeeded', { backendNodeId: id }).catch(() => undefined);
    let quads: number[][] = [];
    try { ({ quads } = await this.s<{ quads: number[][] }>('DOM.getContentQuads', { backendNodeId: id })); } catch { /* invisible */ }
    const q = quads[0];
    if (!q || q.length < 8) throw conflict("l'élément n'a pas de zone cliquable (invisible ou hors rendu)");
    const x = (q[0]! + q[2]! + q[4]! + q[6]!) / 4;
    const y = (q[1]! + q[3]! + q[5]! + q[7]!) / 4;
    await this.s('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.s('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await this.s('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  }

  click(sel: string, opts: ActionOptions = {}): Promise<ActionResult> {
    return this.act(opts, async (snap) => { await this.clickNode(await this.resolve(sel, snap)); });
  }

  fill(sel: string, value: string, opts: ActionOptions = {}): Promise<ActionResult> {
    return this.act(opts, async (snap) => {
      const id = await this.resolve(sel, snap);
      const info = await this.describe(id);
      const isField = (info.tag === 'INPUT' && !NON_TEXT_INPUTS.has(info.type)) || info.tag === 'TEXTAREA' || info.editable;
      if (!isField) throw badRequest(`fill attend un champ de saisie, reçu <${info.tag.toLowerCase()}${info.type ? ` type=${info.type}` : ''}> — utilisez click, check ou select`);
      if (info.disabled || info.readOnly) throw conflict('champ désactivé ou en lecture seule');
      await this.s('DOM.focus', { backendNodeId: id });
      await this.callOn(id, `function () { if (typeof this.select === 'function') this.select(); else { const r = document.createRange(); r.selectNodeContents(this); const s = getSelection(); s.removeAllRanges(); s.addRange(r); } }`);
      if (value === '') {
        await this.s('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
        await this.s('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
      } else {
        await this.s('Input.insertText', { text: value });
      }
      const read = `function () { return this.isContentEditable ? this.innerText.trim() : this.value; }`;
      let actual = await this.callOn<string>(id, read);
      if (actual !== value) {
        // Champs que la frappe ne remplit pas (date, time…) : setter natif + événements.
        await this.callOn(id, `function (v) { const p = this instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(p, 'value').set.call(this, v); this.dispatchEvent(new Event('input', { bubbles: true })); }`, value);
        actual = await this.callOn<string>(id, read);
      }
      // On vérifie l'effet, pas l'émission : une valeur tronquée (maxlength, masque) est une erreur.
      if (actual !== value) throw conflict(`la valeur effective est « ${actual} » et non « ${value} » (maxlength, masque de saisie ?)`);
      await this.callOn(id, `function () { this.dispatchEvent(new Event('change', { bubbles: true })); }`);
    });
  }

  select(sel: string, value: string, opts: ActionOptions = {}): Promise<ActionResult> {
    return this.act(opts, async (snap) => {
      const id = await this.resolve(sel, snap);
      const info = await this.describe(id);
      if (info.tag !== 'SELECT') throw badRequest(`select attend un <select>, reçu <${info.tag.toLowerCase()}> — pour une liste ARIA, utilisez click sur l'option`);
      if (info.disabled) throw conflict('liste désactivée');
      const r = await this.callOn<{ error?: string; options?: string[]; label?: string }>(id, `function (v) {
        const opts = [...this.options];
        const lv = v.toLowerCase();
        const o = opts.find((o) => o.value === v) || opts.find((o) => o.label.trim() === v) || opts.find((o) => o.label.trim().toLowerCase() === lv);
        if (!o) return { error: 'absent', options: opts.map((o) => o.label.trim() + (o.value !== o.label.trim() ? ' (' + o.value + ')' : '')) };
        this.value = o.value;
        this.dispatchEvent(new Event('input', { bubbles: true }));
        this.dispatchEvent(new Event('change', { bubbles: true }));
        return { label: o.label.trim() };
      }`, value);
      if (r.error) throw badRequest(`aucune option « ${value} » ; options : ${(r.options === undefined ? [] : r.options).join(', ')}`);
      return `sélectionné : ${r.label}`;
    });
  }

  check(sel: string, desired = true, opts: ActionOptions = {}): Promise<ActionResult> {
    return this.act(opts, async (snap) => {
      const id = await this.resolve(sel, snap);
      const info = await this.describe(id);
      if (!info.checkable) throw badRequest(`check attend une case à cocher ou un bouton radio, reçu <${info.tag.toLowerCase()}>`);
      if (info.type === 'radio' && !desired) throw badRequest('un bouton radio ne se décoche pas : cochez une autre option du groupe');
      if (info.checked === desired) return 'déjà dans cet état';
      try { await this.clickNode(id); } catch (e) {
        if (!(e instanceof GraspError) || e.status !== 409) throw e;
        // case masquée (case stylée) : on clique son label
        await this.callOn(id, `function () { const el = this.labels && this.labels[0] ? this.labels[0] : this; el.click(); }`);
      }
      await sleep(30);
      const after = await this.describe(id);
      if (after.checked !== desired) throw conflict("l'état de la case n'a pas changé (un gestionnaire annule-t-il le clic ?)");
    });
  }

  press(key: string, sel?: string, opts: ActionOptions = {}): Promise<ActionResult> {
    let parsed: ReturnType<typeof parseKey>;
    try { parsed = parseKey(key); } catch (e) { return Promise.reject(badRequest((e as Error).message)); }
    return this.act(opts, async (snap) => {
      if (sel !== undefined && sel !== '') await this.s('DOM.focus', { backendNodeId: await this.resolve(sel, snap) });
      const { def, modifiers } = parsed;
      const base = { key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode, modifiers };
      await this.s('Input.dispatchKeyEvent', def.text !== undefined
        ? { ...base, type: 'keyDown', text: def.text, unmodifiedText: def.text }
        : { ...base, type: 'rawKeyDown' });
      await this.s('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
    });
  }

  async screenshot(): Promise<Buffer> {
    const { data } = await this.s<{ data: string }>('Page.captureScreenshot', { format: 'png' });
    return Buffer.from(data, 'base64');
  }

  async pdf(): Promise<Buffer> {
    const { data } = await this.s<{ data: string }>('Page.printToPDF', { printBackground: true });
    return Buffer.from(data, 'base64');
  }

  // ---------- Capacités sensibles : désactivées par défaut ----------

  async evaluate(expression: string): Promise<unknown> {
    if (!this.policy.allowEval) throw forbidden('eval est désactivé (grasp config set allowEval true pour l\'autoriser)');
    const r = await this.s<{ result: { value?: unknown }; exceptionDetails?: { text: string; exception?: { description?: string } } }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) throw badRequest(`exception : ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  }

  async cookies(): Promise<unknown[]> {
    if (!this.policy.allowCookies) throw forbidden('l\'accès aux cookies est désactivé (grasp config set allowCookies true)');
    const { cookies } = await this.s<{ cookies: unknown[] }>('Network.getCookies');
    return cookies;
  }

  async upload(sel: string, files: string[]): Promise<ActionResult> {
    if (!this.policy.allowUpload) throw forbidden('l\'upload est désactivé (grasp config set allowUpload true)');
    for (const f of files) {
      if (!f.startsWith('/')) throw badRequest(`chemin absolu attendu : ${f}`);
      try { if (!statSync(f).isFile()) throw new Error(); } catch { throw badRequest(`fichier introuvable : ${f}`); }
    }
    return this.act({}, async (snap) => {
      const id = await this.resolve(sel, snap);
      const info = await this.describe(id);
      if (info.tag !== 'INPUT' || info.type !== 'file') throw badRequest('upload attend un <input type=file>');
      await this.s('DOM.setFileInputFiles', { files, backendNodeId: id });
    });
  }
}
