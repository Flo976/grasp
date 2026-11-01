import { statSync } from 'node:fs';
import type { CdpClient, CdpEvent } from '../browser/cdp.js';
import { checkUrl, type EffectivePolicy } from '../core/policy.js';
import { GraspError, badRequest, conflict, forbidden, notFound } from '../core/errors.js';
import { ConsoleBuffer, formatArg, formatArgs, levelOfConsoleType, levelOfLog, redactUrl, type ConsoleEntry, type ConsoleQuery, type ConsoleResult, type NewEntry, type RemoteObjectLike } from '../core/console.js';
import { imageSize, type ImageFormat } from '../core/image.js';
import { saveCapture } from '../core/captures.js';
import { buildSnapshot, diffSnapshots, INTERACTIVE, type AXNode, type Snapshot } from './snapshot.js';
import { parseKey } from './keys.js';

export interface ActionOptions {
  snapDiff?: boolean | undefined;
  maxBytes?: number | undefined;
  /** Renvoie les entrées console produites pendant l'action. */
  console?: boolean | undefined;
  /** En cas d'échec, capture du viewport ; son chemin est ajouté au message d'erreur. */
  shotOnError?: boolean | undefined;
}
export interface ConsoleSlice { entries: ConsoleEntry[]; seq: number }
export interface ActionResult { ok: true; diff?: string; detail?: string; console?: ConsoleSlice }
export interface Blocked { url: string; reason: string; at: number }

export interface ShotOptions {
  full?: boolean | undefined;
  /** Sélecteur (ref, CSS, text:) : découpe sur la boîte de l'élément. */
  el?: string | undefined;
  format?: string | undefined;
  quality?: number | undefined;
  /** Largeur maximale de l'image en pixels : l'échelle est réduite, jamais agrandie. */
  maxWidth?: number | undefined;
  /** Dessine temporairement les refs du snapshot sur les éléments interactifs visibles. */
  refs?: boolean | undefined;
}
export interface Shot { data: Buffer; width: number; height: number; format: ImageFormat; truncated?: boolean }
export interface SavedShot { path: string; width: number; height: number; bytes: number; format: ImageFormat; truncated?: boolean }

interface Box { x: number; y: number; width: number; height: number }
interface CallFrame { functionName: string; url: string; lineNumber: number; columnNumber: number }

const FORMATS = new Set(['png', 'jpeg', 'webp']);
/** Limite de texture de Chrome : au-delà, une capture pleine page est tronquée (et signalée). */
const MAX_CAPTURE_PX = 16_384;
/** Entrées console renvoyées au plus avec une action (--console). */
const ACTION_CONSOLE_LIMIT = 200;
const OVERLAY_COLOR = 'rgb(255, 0, 170)';

/**
 * Overlay des refs, exécuté dans un monde isolé : la page ne voit ni la fonction ni ses variables,
 * seulement un hôte <grasp-overlay> (shadow root fermé, aria-hidden) retiré juste après la capture.
 */
const OVERLAY_FN = `function (labels, color) {
  const prev = globalThis.__graspOverlay; if (prev) prev.remove();
  const css = (el, props) => { for (const [k, v] of Object.entries(props)) el.style.setProperty(k, v, 'important'); };
  const host = document.createElement('grasp-overlay');
  host.setAttribute('aria-hidden', 'true');
  css(host, { position: 'absolute', left: '0px', top: '0px', width: '0px', height: '0px', margin: '0', padding: '0', border: '0', overflow: 'visible', display: 'block', 'z-index': '2147483647', 'pointer-events': 'none' });
  const root = host.attachShadow({ mode: 'closed' });
  for (const l of labels) {
    const b = document.createElement('div');
    css(b, { position: 'absolute', left: l.x + 'px', top: l.y + 'px', width: l.w + 'px', height: l.h + 'px', outline: '2px solid ' + color, 'box-sizing': 'border-box' });
    const t = document.createElement('span');
    t.textContent = l.ref;
    css(t, { position: 'absolute', left: '0px', top: (l.y >= 14 ? -14 : 0) + 'px', background: color, color: '#fff', font: 'bold 11px/14px monospace', padding: '0 3px', 'white-space': 'nowrap' });
    b.appendChild(t);
    root.appendChild(b);
  }
  (document.documentElement || document.body).appendChild(host);
  // Hôte positionné par rapport au document, quel que soit le bloc conteneur réel.
  const r = host.getBoundingClientRect();
  css(host, { left: -(r.left + scrollX) + 'px', top: -(r.top + scrollY) + 'px' });
  globalThis.__graspOverlay = host;
  return labels.length;
}`;

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
  /** Navigateur qui ne nous appartient pas : pas d'auto-attach sur les autres onglets. */
  private foreign = false;
  private capturesDir: string | undefined;
  /** Console de l'onglet : survit aux navigations (repère « navigation → url »). */
  private readonly consoleBuf = new ConsoleBuffer();
  /** requestId → méthode et URL, le temps de la requête (jamais d'en-têtes ni de corps). */
  private readonly requests = new Map<string, { method: string; url: string }>();
  /** Requêtes réseau annulées par le garde : déjà signalées comme « bloqué par Grasp ». */
  private readonly blockedNet = new Set<string>();
  /** Contextes d'exécution → cadre, pour signaler les messages venant d'une iframe. */
  private readonly contexts = new Map<string, string>();
  private readonly frames = new Map<string, string>();
  /** Sessions CDP des iframes hors processus (OOPIF) de l'onglet : gardées et écoutées comme lui. */
  private readonly children = new Set<string>();

  private constructor(
    private readonly cdp: CdpClient,
    private readonly sessionId: string,
    private readonly targetId: string,
    readonly policy: Readonly<EffectivePolicy>,
  ) {}

  static async attach(cdp: CdpClient, policy: Readonly<EffectivePolicy>, opts: { downloadDir: string; newTab?: boolean; capturesDir?: string | undefined }): Promise<PageController> {
    const { targetInfos } = await cdp.send<{ targetInfos: Array<{ targetId: string; type: string }> }>('Target.getTargets');
    // Navigateur partagé (mode attach) : on ouvre notre propre onglet, sans toucher à ceux de l'utilisateur.
    let targetId = opts.newTab ? undefined : targetInfos.find((t) => t.type === 'page')?.targetId;
    if (targetId === undefined) targetId = (await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' })).targetId;
    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    const pc = new PageController(cdp, sessionId, targetId, policy);
    pc.foreign = opts.newTab === true;
    pc.capturesDir = opts.capturesDir;
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
    // Console : seulement si la politique l'autorise. Runtime.enable est détectable par la page.
    if (this.policy.allowConsole) await this.enableConsole(this.sessionId);
    await this.guard(this.sessionId);
    // Iframes hors processus (OOPIF) de NOTRE onglet : attachées en pause, gardées (leurs propres
    // navigations ne passent pas par l'interception de la page) et écoutées, puis relâchées.
    await this.s('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    const { frameTree } = await this.s<{ frameTree: { frame: { id: string } } }>('Page.getFrameTree');
    this.mainFrameId = frameTree.frame.id;
    const dl = this.policy.allowDownload ? { behavior: 'allow', downloadPath: downloadDir } : { behavior: 'deny' };
    // Navigateur partagé : réglage limité à notre onglet, pas à tout le navigateur de l'utilisateur.
    if (this.foreign) await this.s('Page.setDownloadBehavior', dl).catch(() => undefined);
    else await this.cdp.send('Browser.setDownloadBehavior', dl);
    // Popups (window.open, target=_blank) : attachés en pause, gardés AVANT de s'exécuter.
    // En mode attach, on ne s'impose pas aux autres onglets de l'utilisateur.
    if (!this.foreign) await this.cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  }

  /** Domaines CDP de la console. Pas de tampon de corps réseau : Grasp ne lit jamais les corps. */
  private async enableConsole(sessionId: string): Promise<void> {
    await this.cdp.send('Runtime.enable', {}, sessionId);
    await this.cdp.send('Log.enable', {}, sessionId);
    await this.cdp.send('Network.enable', { maxTotalBufferSize: 0, maxResourceBufferSize: 0 }, sessionId)
      .catch(() => this.cdp.send('Network.enable', {}, sessionId));
  }

  private log(e: NewEntry): void { this.consoleBuf.push(e); }

  private frameOf(sessionId: string | undefined, contextId: unknown): string | undefined {
    const frameId = this.contexts.get(`${sessionId}:${String(contextId)}`);
    if (frameId === undefined || frameId === this.mainFrameId) return undefined;
    return this.frames.get(frameId) ?? frameId;
  }

  private static where(f: { url?: string; lineNumber?: number; columnNumber?: number } | undefined): Pick<ConsoleEntry, 'url' | 'line' | 'col'> {
    if (f === undefined || f.url === undefined || f.url === '') return {};
    return { url: redactUrl(f.url, 300), ...(f.lineNumber !== undefined ? { line: f.lineNumber + 1 } : {}), ...(f.columnNumber !== undefined ? { col: f.columnNumber + 1 } : {}) };
  }

  /** Pile courte (3 appels) : « fn:ligne » dans le fichier de l'entrée, « fn (fichier:ligne) » ailleurs. */
  private static shortStack(frames: CallFrame[] | undefined, url: string | undefined): string {
    if (frames === undefined || frames.length === 0) return '';
    const file = (u: string) => { try { return new URL(u).pathname.split('/').pop() || u; } catch { return u; } };
    const fmt = (f: CallFrame) => {
      const fn = f.functionName !== '' ? f.functionName : '(anonyme)';
      return f.url === url ? `${fn}:${f.lineNumber + 1}` : `${fn} (${file(f.url)}:${f.lineNumber + 1})`;
    };
    return ` ← ${frames.slice(0, 3).map(fmt).join(' ← ')}`;
  }

  /** « hors allowlist » : le garde ne couvre que les documents, une sous-ressource n'est pas bloquée. */
  private offList(url: string): string {
    return checkUrl(this.policy.allowedDomains, url).allowed || !/^https?:/.test(url) ? '' : ' [hors allowlist : non bloqué par Grasp, le garde ne couvre que les documents]';
  }

  /** Événements de la console (Runtime, Log, Network, Page) d'une session de l'onglet. */
  private onConsoleEvent(e: CdpEvent): void {
    const p = e.params;
    switch (e.method) {
      case 'Runtime.executionContextCreated': {
        const frameId = p.context?.auxData?.frameId;
        if (typeof frameId === 'string') this.contexts.set(`${e.sessionId}:${p.context.id}`, frameId);
        return;
      }
      case 'Runtime.executionContextDestroyed': this.contexts.delete(`${e.sessionId}:${p.executionContextId}`); return;
      case 'Runtime.executionContextsCleared':
        for (const k of [...this.contexts.keys()]) if (k.startsWith(`${e.sessionId}:`)) this.contexts.delete(k);
        return;
      // « swap » : le cadre passe dans un autre processus (OOPIF), il existe toujours.
      case 'Page.frameDetached': if (p.frameId !== this.mainFrameId && p.reason !== 'swap') this.frames.delete(p.frameId); return;
      case 'Runtime.consoleAPICalled': {
        if (p.type === 'clear' || p.type === 'endGroup') return;
        const args = (Array.isArray(p.args) ? p.args : []) as RemoteObjectLike[];
        let text = formatArgs(args);
        if (p.type === 'assert') text = `Assertion failed${text !== '' ? `: ${text}` : ''}`;
        const frame = this.frameOf(e.sessionId, p.executionContextId);
        this.log({ level: levelOfConsoleType(p.type), source: 'console', text, ...PageController.where(p.stackTrace?.callFrames?.[0]), ...(frame !== undefined ? { frame } : {}) });
        return;
      }
      case 'Runtime.exceptionThrown': {
        const d = p.exceptionDetails ?? {};
        const ex = d.exception as RemoteObjectLike | undefined;
        const desc = ex === undefined ? '' : ex.subtype === 'error' && ex.description !== undefined ? ex.description.split('\n')[0]! : formatArg(ex);
        const frames = d.stackTrace?.callFrames as CallFrame[] | undefined;
        const frame = this.frameOf(e.sessionId, d.executionContextId);
        const loc = d.url !== undefined ? { url: d.url, lineNumber: d.lineNumber, columnNumber: d.columnNumber } : frames?.[0];
        const text = `${d.text ?? 'Uncaught'}${desc !== '' ? ` ${desc}` : ''}${PageController.shortStack(frames, loc?.url)}`;
        this.log({ level: 'error', source: 'exception', text, ...PageController.where(loc), ...(frame !== undefined ? { frame } : {}) });
        return;
      }
      case 'Log.entryAdded': {
        const en = p.entry ?? {};
        // Erreurs réseau et CORS : rapportées (sans doublon) par les événements Network ci-dessous.
        if ((en.source === 'network' && en.networkRequestId !== undefined) || en.category === 'cors') return;
        this.log({ level: levelOfLog(en.level), source: String(en.source ?? 'other'), text: String(en.text ?? ''), ...PageController.where(en.url !== undefined ? { url: en.url, lineNumber: en.lineNumber } : en.stackTrace?.callFrames?.[0]) });
        return;
      }
      case 'Network.requestWillBeSent': {
        if (this.requests.size > 2000) this.requests.delete(this.requests.keys().next().value as string);
        this.requests.set(p.requestId, { method: String(p.request?.method ?? 'GET'), url: String(p.request?.url ?? '') });
        return;
      }
      case 'Network.responseReceived': {
        const st = Number(p.response?.status);
        if (!(st >= 400)) return;
        const req = this.requests.get(p.requestId);
        const url = String(p.response?.url ?? req?.url ?? '');
        this.log({ level: 'error', source: 'network', text: `${req?.method ?? 'GET'} ${redactUrl(url)} → ${st}${p.response?.statusText ? ` ${p.response.statusText}` : ''}${this.offList(url)}` });
        return;
      }
      case 'Network.loadingFinished': this.requests.delete(p.requestId); return;
      case 'Network.loadingFailed': {
        const req = this.requests.get(p.requestId);
        this.requests.delete(p.requestId);
        if (this.blockedNet.delete(p.requestId)) return;
        // Annulations (navigation qui part, AbortController) : du bruit, pas une erreur.
        if (p.canceled === true && p.blockedReason === undefined) return;
        const url = req?.url ?? '';
        const why = [p.blockedReason !== undefined ? `bloqué : ${p.blockedReason}` : '', p.corsErrorStatus?.corsError !== undefined ? `CORS : ${p.corsErrorStatus.corsError}` : ''].filter((x) => x !== '').join(', ');
        this.log({ level: 'error', source: 'network', text: `${req?.method ?? 'GET'} ${redactUrl(url)} → ${p.errorText ?? 'échec'}${why !== '' ? ` (${why})` : ''}${this.offList(url)}` });
        return;
      }
      case 'Page.frameNavigated': {
        const f = p.frame ?? {};
        if (typeof f.id === 'string') this.frames.set(f.id, String(f.url ?? ''));
        if (e.sessionId === this.sessionId && f.parentId === undefined) this.log({ level: 'info', source: 'navigation', text: redactUrl(String(f.url ?? ''), 300) });
        return;
      }
      case 'Page.navigatedWithinDocument':
        if (e.sessionId === this.sessionId && p.frameId === this.mainFrameId) this.log({ level: 'info', source: 'navigation', text: `${redactUrl(String(p.url ?? ''), 300)} (même document)` });
        return;
    }
  }

  /** Lecture du tampon console (403 si la politique l'interdit). `clear` vide le tampon après lecture. */
  async consoleQuery(q: ConsoleQuery & { clear?: boolean | undefined }): Promise<ConsoleResult> {
    this.assertConsole();
    const r = this.consoleBuf.query(q);
    if (q.clear === true) this.consoleBuf.clear();
    return r;
  }

  private assertConsole(): void {
    if (!this.policy.allowConsole) throw forbidden('la console est désactivée (grasp config set allowConsole true pour l\'autoriser)');
  }

  private consoleSince(seq: number): ConsoleSlice {
    return { entries: this.consoleBuf.query({ since: seq, limit: ACTION_CONSOLE_LIMIT }).entries, seq: this.consoleBuf.seq };
  }

  /** Enrichit l'erreur d'une action : chemin d'une capture (--shot-on-error), entrées console (--console). */
  private async decorate(e: unknown, opts: ActionOptions, seq: number): Promise<unknown> {
    if (opts.shotOnError !== true && opts.console !== true) return e;
    const base = e instanceof GraspError ? e : new GraspError(500, e instanceof Error ? e.message : String(e));
    let msg = base.message;
    const extra: Record<string, unknown> = { ...(base.extra !== undefined ? base.extra : {}) };
    if (opts.shotOnError === true) {
      try {
        const shot = await this.saveShot({});
        msg += ` (capture : ${shot.path})`;
        extra.screenshot = shot.path;
      } catch (se) { msg += ` (capture impossible : ${(se as Error).message})`; }
    }
    if (opts.console === true && this.policy.allowConsole) {
      const c = this.consoleSince(seq);
      extra.console = c.entries;
      extra.consoleSeq = c.seq;
    }
    return new GraspError(base.status, msg, extra);
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
          if (this.policy.allowConsole) {
            if (typeof e.params.networkId === 'string') this.blockedNet.add(e.params.networkId);
            this.log({ level: 'error', source: 'grasp', text: `bloqué par Grasp : ${v.reason} — ${redactUrl(url)}`, blocked: true });
          }
          // « Aborted » : la navigation est annulée et la page courante reste affichée (pas de page d'erreur).
          await this.cdp.send('Fetch.failRequest', { requestId: e.params.requestId, errorReason: 'Aborted' }, e.sessionId);
          if (e.sessionId === this.sessionId) this.pendingNavAt = 0;
        }
        return;
      }
      if (e.sessionId !== undefined && (e.sessionId === this.sessionId || this.children.has(e.sessionId))) {
        if (e.method === 'Target.attachedToTarget') { await this.onChildAttached(e); return; }
        if (e.method === 'Target.detachedFromTarget') { this.children.delete(e.params.sessionId); return; }
      }
      if (e.sessionId !== undefined && this.children.has(e.sessionId)) {
        if (this.policy.allowConsole) this.onConsoleEvent(e);
        return;
      }
      if (e.method === 'Target.attachedToTarget' && e.sessionId === undefined) {
        const sid: string = e.params.sessionId;
        const info = e.params.targetInfo as { targetId: string; type: string };
        if (info.targetId === this.targetId || this.foreign) {
          // Onglets de l'utilisateur (mode attach) : on ne les garde pas, on les laisse vivre.
          if (e.params.waitingForDebugger) await this.cdp.send('Runtime.runIfWaitingForDebugger', {}, sid);
          await this.cdp.send('Target.detachFromTarget', { sessionId: sid });
          return;
        }
        if (info.type === 'page' || info.type === 'iframe') await this.guard(sid);
        if (e.params.waitingForDebugger) await this.cdp.send('Runtime.runIfWaitingForDebugger', {}, sid);
        return;
      }
      if (e.sessionId !== this.sessionId) return;
      if (this.policy.allowConsole) this.onConsoleEvent(e);
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

  /** Cible attachée par l'auto-attach de l'onglet : iframe hors processus (gardée, écoutée) ou worker (relâché). */
  private async onChildAttached(e: CdpEvent): Promise<void> {
    const sid: string = e.params.sessionId;
    const info = e.params.targetInfo as { targetId: string; type: string; url: string };
    try {
      if (info.type === 'iframe') {
        this.children.add(sid);
        this.frames.set(info.targetId, info.url);
        await this.guard(sid);
        if (this.policy.allowConsole) {
          await this.cdp.send('Page.enable', {}, sid);
          await this.enableConsole(sid);
        }
        await this.cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sid);
      }
    } finally {
      if (e.params.waitingForDebugger) await this.cdp.send('Runtime.runIfWaitingForDebugger', {}, sid).catch(() => undefined);
      if (info.type !== 'iframe') await this.cdp.send('Target.detachFromTarget', { sessionId: sid }).catch(() => undefined);
    }
  }

  lastBlocked(): Blocked | null { return this.blocked; }

  /** Ferme l'onglet de la session (mode attach : le navigateur, lui, reste ouvert). */
  async closeTab(): Promise<void> {
    await this.cdp.send('Target.closeTarget', { targetId: this.targetId }).catch(() => undefined);
  }

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

  /** Navigation comme action : --snap-diff, --console, --shot-on-error. */
  async nav(url: string, opts: ActionOptions = {}): Promise<ActionResult & { url: string; title: string }> {
    if (opts.console === true) this.assertConsole();
    const seq = this.consoleBuf.seq;
    try {
      const before = opts.snapDiff === true ? await this.snapshot({ maxBytes: opts.maxBytes }) : undefined;
      const loc = await this.navigate(url);
      const out: ActionResult & { url: string; title: string } = { ok: true, ...loc };
      if (before) out.diff = diffSnapshots(before, await this.snapshot({ maxBytes: opts.maxBytes }));
      if (opts.console === true) out.console = this.consoleSince(seq);
      return out;
    } catch (e) { throw await this.decorate(e, opts, seq); }
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
    if (opts.console === true) this.assertConsole();
    this.lastDialog = null;
    const seq = this.consoleBuf.seq;
    const t0 = Date.now();
    try {
      const before = opts.snapDiff ? await this.snapshot({ maxBytes: opts.maxBytes }) : undefined;
      let detail: string | void;
      try { detail = await fn(before); } finally { void this.s('Runtime.releaseObjectGroup', { objectGroup: 'grasp' }).catch(() => undefined); }
      await this.settle();
      const res: ActionResult = { ok: true };
      const notes = [detail, this.lastDialog !== null ? `dialogue fermé — ${this.lastDialog}` : undefined, this.blocked !== null && this.blocked.at >= t0 ? `navigation bloquée : ${this.blocked.reason}` : undefined].filter((x): x is string => typeof x === 'string' && x !== '');
      if (notes.length) res.detail = notes.join(' ; ');
      if (before) res.diff = diffSnapshots(before, await this.snapshot({ maxBytes: opts.maxBytes }));
      if (opts.console === true) res.console = this.consoleSince(seq);
      return res;
    } catch (e) { throw await this.decorate(e, opts, seq); }
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
    return (await this.capture({})).data;
  }

  /** Boîte englobante (CSS px, relative au viewport) des quads de l'élément ; null s'il n'est pas rendu. */
  private async boxOf(id: number): Promise<Box | null> {
    let quads: number[][] = [];
    try { ({ quads } = await this.s<{ quads: number[][] }>('DOM.getContentQuads', { backendNodeId: id })); } catch { return null; }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const q of quads) for (let i = 0; i + 1 < q.length; i += 2) {
      x0 = Math.min(x0, q[i]!); x1 = Math.max(x1, q[i]!);
      y0 = Math.min(y0, q[i + 1]!); y1 = Math.max(y1, q[i + 1]!);
    }
    if (!(x1 - x0 >= 1 && y1 - y0 >= 1)) return null;
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  }

  /**
   * Capture : viewport (défaut), page entière (--full) ou boîte d'un élément (--el), mise à l'échelle
   * (--max-width), refs dessinées (--refs). Tout passe par CDP : marche à l'identique en mode
   * Windows et attach. Les dimensions renvoyées sont lues dans l'image produite.
   */
  async capture(o: ShotOptions = {}): Promise<Shot> {
    const format = (o.format !== undefined ? o.format : 'png') as ImageFormat;
    if (!FORMATS.has(format)) throw badRequest(`format « ${format} » non géré (png, jpeg ou webp)`);
    if (o.quality !== undefined) {
      if (format === 'png') throw badRequest('quality ne s\'applique qu\'à jpeg et webp');
      if (!Number.isInteger(o.quality) || o.quality < 1 || o.quality > 100) throw badRequest('quality : entier de 1 à 100 attendu');
    }
    if (o.maxWidth !== undefined && (!Number.isInteger(o.maxWidth) || o.maxWidth < 1)) throw badRequest('max-width : entier positif attendu');
    if (o.full === true && o.el !== undefined) throw badRequest('full et el sont incompatibles');

    let elId: number | undefined;
    if (o.el !== undefined) {
      elId = await this.resolve(o.el);
      await this.s('DOM.scrollIntoViewIfNeeded', { backendNodeId: elId }).catch(() => undefined);
    }
    const m = await this.s<{ cssVisualViewport: { pageX: number; pageY: number; clientWidth: number; clientHeight: number }; cssLayoutViewport: { clientWidth: number }; cssContentSize: { width: number; height: number } }>('Page.getLayoutMetrics');
    const vv = m.cssVisualViewport;
    // Monde isolé : la page ne peut pas fausser ces valeurs. innerWidth/innerHeight incluent les barres de
    // défilement, comme une capture sans découpe : mêmes dimensions avec ou sans --max-width.
    const win = await this.inIsolatedWorld('[devicePixelRatio, innerWidth, innerHeight]').catch(() => undefined) as number[] | undefined;
    const dpr = Array.isArray(win) && typeof win[0] === 'number' && win[0] > 0 ? win[0] : 1;
    const surface = Array.isArray(win) && typeof win[1] === 'number' && typeof win[2] === 'number' && win[1] > 0 ? { width: win[1], height: win[2] } : { width: vv.clientWidth, height: vv.clientHeight };
    const viewport: Box = { x: vv.pageX, y: vv.pageY, width: vv.clientWidth, height: vv.clientHeight };
    const inViewport = (r: Box) => r.x >= viewport.x - 0.5 && r.y >= viewport.y - 0.5 && r.x + r.width <= viewport.x + viewport.width + 0.5 && r.y + r.height <= viewport.y + viewport.height + 0.5;

    // Zone en coordonnées du document. `expand` : la zone déborde du viewport, on l'agrandit le temps
    // de la capture (setDeviceMetricsOverride puis clear). Pas de captureBeyondViewport : Chrome y fait
    // disparaître la barre de défilement jusqu'au rechargement (reflow de la page), ce qui l'altère.
    let region: Box | undefined;
    let expand = false;
    let truncated = false;
    if (elId !== undefined) {
      const b = await this.boxOf(elId);
      if (b === null) throw conflict("l'élément n'a pas de boîte visible (invisible ou hors rendu)");
      const x = Math.floor(b.x + vv.pageX), y = Math.floor(b.y + vv.pageY);
      region = { x, y, width: Math.ceil(b.x + vv.pageX + b.width) - x, height: Math.ceil(b.y + vv.pageY + b.height) - y };
      expand = !inViewport(region);
    } else if (o.full === true) {
      region = { x: 0, y: 0, width: Math.ceil(m.cssContentSize.width), height: Math.ceil(m.cssContentSize.height) };
      expand = true;
    } else if (o.maxWidth !== undefined) {
      region = { x: vv.pageX, y: vv.pageY, width: surface.width, height: surface.height };
    }
    if (region !== undefined && expand) {
      const maxH = Math.floor(MAX_CAPTURE_PX / dpr);
      if (region.y + region.height > maxH) { region = { ...region, height: Math.max(1, maxH - region.y) }; truncated = true; }
    }
    let scale = 1;
    if (o.maxWidth !== undefined) {
      const w = (region !== undefined ? region.width : viewport.width) * dpr;
      if (w > o.maxWidth) scale = o.maxWidth / w;
    }
    const params: Record<string, unknown> = { format, fromSurface: true, captureBeyondViewport: false };
    if (o.quality !== undefined) params.quality = o.quality;
    if (region !== undefined) params.clip = { ...region, scale };

    const removeOverlay = o.refs === true ? await this.drawRefs(region !== undefined ? region : viewport, vv) : undefined;
    let data: string;
    try {
      if (expand && region !== undefined) {
        await this.s('Emulation.setDeviceMetricsOverride', { width: Math.ceil(m.cssLayoutViewport.clientWidth), height: Math.max(Math.ceil(region.y + region.height), Math.ceil(viewport.height)), deviceScaleFactor: 0, mobile: false });
      }
      data = await new Promise<string>((resolve, reject) => {
        const t = setTimeout(() => reject(new GraspError(504, 'capture : délai dépassé (onglet en arrière-plan ou fenêtre minimisée ?)')), 30_000);
        this.s<{ data: string }>('Page.captureScreenshot', params).then((r) => { clearTimeout(t); resolve(r.data); }, (e: Error) => { clearTimeout(t); reject(new GraspError(502, `capture impossible : ${e.message}`)); });
      });
    } finally {
      if (expand) {
        await this.s('Emulation.clearDeviceMetricsOverride').catch(() => undefined);
        // Le retour à la taille d'origine est asynchrone : on l'attend avant de rendre la main
        // (sinon la mesure suivante, ou le défilement restauré, porteraient sur le viewport agrandi).
        for (let i = 0; i < 80; i++) {
          const cur = await this.s<{ cssVisualViewport: { clientWidth: number; clientHeight: number } }>('Page.getLayoutMetrics').catch(() => undefined);
          if (cur === undefined || (Math.abs(cur.cssVisualViewport.clientHeight - vv.clientHeight) < 1 && Math.abs(cur.cssVisualViewport.clientWidth - vv.clientWidth) < 1)) break;
          await sleep(25);
        }
        await this.inIsolatedWorld(`scrollTo(${Number(vv.pageX)}, ${Number(vv.pageY)})`).catch(() => undefined);
      }
      if (removeOverlay !== undefined) await removeOverlay();
    }
    const buf = Buffer.from(data, 'base64');
    const size = imageSize(buf);
    return { data: buf, width: size.width, height: size.height, format, ...(truncated ? { truncated: true } : {}) };
  }

  /** Évalue du code FIXE de Grasp dans un monde isolé (jamais une expression de l'agent). */
  private async inIsolatedWorld(expression: string): Promise<unknown> {
    const { executionContextId } = await this.s<{ executionContextId: number }>('Page.createIsolatedWorld', { frameId: this.mainFrameId, worldName: 'grasp', grantUniveralAccess: false });
    const r = await this.s<{ result: { value?: unknown }; exceptionDetails?: { text: string } }>('Runtime.evaluate', { contextId: executionContextId, expression, returnByValue: true });
    if (r.exceptionDetails) throw new GraspError(500, `script interne de Grasp en échec : ${r.exceptionDetails.text}`);
    return r.result.value;
  }

  /** Capture enregistrée dans le répertoire d'état (0600, rotation). */
  async saveShot(o: ShotOptions): Promise<SavedShot> {
    if (this.capturesDir === undefined) throw new GraspError(500, 'aucun répertoire de captures configuré pour ce bridge');
    const s = await this.capture(o);
    const path = saveCapture(this.capturesDir, s.data, s.format);
    return { path, width: s.width, height: s.height, bytes: s.data.length, format: s.format, ...(s.truncated === true ? { truncated: true } : {}) };
  }

  /**
   * Dessine les refs des éléments interactifs visibles dans `region` (coordonnées du document).
   * Code fixe de Grasp, injecté dans un monde isolé : autorisé même si allowEval=false (ce n'est pas
   * du code de l'agent). Renvoie la fonction qui retire l'overlay.
   */
  private async drawRefs(region: Box, vv: { pageX: number; pageY: number }): Promise<() => Promise<void>> {
    const snap = await this.snapshot({ maxBytes: 4 * 1024 * 1024 });
    const labels: Array<{ ref: string; x: number; y: number; w: number; h: number }> = [];
    let checked = 0;
    for (const [ref, meta] of snap.meta) {
      if (!INTERACTIVE.has(meta.role)) continue;
      const id = snap.refs.get(ref);
      if (id === undefined) continue;
      if (++checked > 2000 || labels.length >= 500) break;
      const b = await this.boxOf(id);
      if (b === null) continue;
      const x = b.x + vv.pageX, y = b.y + vv.pageY;
      if (x + b.width <= region.x || y + b.height <= region.y || x >= region.x + region.width || y >= region.y + region.height) continue;
      labels.push({ ref, x: Math.round(x), y: Math.round(y), w: Math.round(b.width), h: Math.round(b.height) });
    }
    const { executionContextId } = await this.s<{ executionContextId: number }>('Page.createIsolatedWorld', { frameId: this.mainFrameId, worldName: 'grasp-overlay', grantUniveralAccess: false });
    const r = await this.s<{ exceptionDetails?: { text: string } }>('Runtime.evaluate', { contextId: executionContextId, expression: `(${OVERLAY_FN})(${JSON.stringify(labels)}, ${JSON.stringify(OVERLAY_COLOR)})`, returnByValue: true });
    if (r.exceptionDetails) throw new GraspError(500, `overlay des refs impossible : ${r.exceptionDetails.text}`);
    return async () => {
      await this.s('Runtime.evaluate', { contextId: executionContextId, expression: 'globalThis.__graspOverlay && globalThis.__graspOverlay.remove(); delete globalThis.__graspOverlay; 0', returnByValue: true }).catch(() => undefined);
    };
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
