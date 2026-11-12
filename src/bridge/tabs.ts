import type { CdpClient, CdpEvent } from '../browser/cdp.js';
import { GraspError, conflict, notFound, badRequest } from '../core/errors.js';
import { redactUrl } from '../core/console.js';
import { TAB_ID_RE, type TabInfo } from '../core/tabs.js';
import { PageController, type TargetInfo } from './page.js';

/**
 * Onglets d'une session : un PageController par onglet (garde de navigation, traqueurs, protection SSRF,
 * console et refs propres à chacun), sur la connexion CDP du bridge. Les popups (window.open, target=_blank)
 * sont attachés EN PAUSE par l'auto-attach du navigateur, gardés avant leur premier document, puis adoptés
 * comme onglets ; l'action qui les a ouverts le dit (« nouvel onglet t2 ouvert : … »), et `--follow` y bascule.
 * Quand l'onglet actif se ferme (popup OAuth qui appelle window.close()), l'onglet actif redevient celui qui
 * l'avait ouvert, et la réponse suivante le dit.
 */

interface Tab {
  id: string;
  pc: PageController;
  /** Onglet qui l'a ouvert (popup), s'il était à nous. */
  opener: string | undefined;
  closed: boolean;
}

/** Nouvelle cible traitée : onglet adopté, ou popup refusé (plafond, adoption impossible) avec sa raison. */
interface Opened { tab?: Tab; refused?: string; openerTarget: string | undefined }

/** Onglet fermé hors d'une commande Grasp : annoncé par la réponse suivante. */
interface Closure { id: string; next: Tab | undefined; last: boolean }

/** Méthodes du contrôleur qui peuvent ouvrir ou fermer un onglet : enveloppées par `act`. */
const ACTIONS = new Set(['nav', 'click', 'fill', 'select', 'check', 'press', 'hover', 'type', 'upload', 'evaluateTyped']);
/** Délai d'arrivée d'un popup demandé (Page.windowOpen → onglet adopté), puis de son premier document. */
const POPUP_WAIT_MS = 2000;
/** Délai d'adoption d'un onglet créé par `tab new`. */
const NEW_TAB_WAIT_MS = 5000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const blank = (url: string) => url === '' || url === 'about:blank';

export class Tabs {
  private readonly tabs = new Map<string, Tab>();
  private activeId: string | undefined;
  private seq = 1;
  /** Ordre d'activation (plus récent à la fin) : repli quand l'onglet actif se ferme sans ouvreur vivant. */
  private readonly history: string[] = [];
  /** Adoptions en cours : targetId → onglet (undefined : popup refusé). */
  private readonly adopting = new Map<string, Promise<Tab | undefined>>();
  /** Sessions en cours d'adoption, et celles d'entre elles déjà détachées (popup refermé aussitôt). */
  private readonly adoptingSids = new Set<string>();
  private readonly goneSids = new Set<string>();
  /** Journal des nouvelles cibles, lu par l'action qui les a fait naître (index de départ). Borné. */
  private log: Opened[] = [];
  private logBase = 0;
  private readonly closures: Closure[] = [];
  /** Dernier contrôleur connu : réglages repris par `tab new` quand plus aucun onglet n'est ouvert. */
  private template: PageController;
  private stopping = false;
  private readonly onCdp = (e: CdpEvent): void => { this.onEvent(e); };

  constructor(private readonly cdp: CdpClient, first: PageController, private readonly max: number) {
    if (!Number.isInteger(max) || max < 1) throw new Error(`maxTabs invalide : ${max}`);
    this.template = first;
    this.register(first, undefined);
    first.hub.adopt = (sid, info, waiting) => this.adopt(sid, info, waiting);
    first.hub.refElsewhere = (ref, self) => {
      const here = this.tabOf(self);
      for (const t of this.tabs.values()) if (t.pc !== self && t.pc.knowsRef(ref)) return { tab: t.id, here: here?.id ?? '?' };
      return undefined;
    };
    cdp.on('event', this.onCdp);
  }

  /** Contrôleur de l'onglet actif. Plus aucun onglet (le dernier a été fermé hors de Grasp) → 409. */
  get active(): PageController {
    const t = this.activeTab;
    if (t === undefined) throw conflict('plus aucun onglet ouvert dans cette session (le dernier a été fermé) : `grasp tab new [url]` pour en ouvrir un');
    return t.pc;
  }

  private get activeTab(): Tab | undefined { return this.activeId !== undefined ? this.tabs.get(this.activeId) : undefined; }

  get size(): number { return this.tabs.size; }

  private tabOf(pc: PageController): Tab | undefined {
    for (const t of this.tabs.values()) if (t.pc === pc) return t;
    return undefined;
  }

  private byTarget(targetId: string): Tab | undefined {
    for (const t of this.tabs.values()) if (t.pc.target === targetId) return t;
    return undefined;
  }

  private register(pc: PageController, opener: string | undefined): Tab {
    const tab: Tab = { id: `t${this.seq++}`, pc, opener, closed: false };
    this.tabs.set(tab.id, tab);
    this.template = pc;
    if (this.activeId === undefined || !this.tabs.has(this.activeId)) this.setActive(tab);
    return tab;
  }

  private record(o: Opened): void {
    this.log.push(o);
    // Borné : une page qui ouvre des popups en boucle ne fait pas grossir la mémoire du bridge.
    if (this.log.length > 200) { this.log = this.log.slice(100); this.logBase += 100; }
  }

  private get logEnd(): number { return this.logBase + this.log.length; }

  private logSince(mark: number): Opened[] { return this.log.slice(Math.max(0, mark - this.logBase)); }

  /**
   * Nouvelle cible « page » attachée EN PAUSE par le navigateur (popup, target=_blank, tab new). Plafond atteint :
   * fermée avant d'avoir rien exécuté. Sinon adoptée (garde, console, traqueurs posés) puis relancée.
   */
  private adopt(sid: string, info: TargetInfo, waiting: boolean): Promise<boolean> {
    const openerTab = info.openerId !== undefined ? this.byTarget(info.openerId) : undefined;
    // Fermer une cible EN PAUSE bloque l'ouvreur (son window.open reste sans retour, et le clic qui l'a appelé avec :
    // mesuré, Chrome 150). Une cible refusée est donc relancée, toutes ses requêtes échouant (hub.denied), puis fermée :
    // rien ne part.
    const hub = (openerTab?.pc ?? this.template).hub;
    const close = async () => {
      hub.denied.add(sid);
      try {
        await this.cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, sid);
        if (waiting) await this.cdp.send('Runtime.runIfWaitingForDebugger', {}, sid);
      } catch { /* cible déjà partie, ou déjà relancée */ }
      await this.cdp.send('Target.closeTarget', { targetId: info.targetId }).catch(() => undefined);
      hub.denied.delete(sid);
    };
    // Évalué AVANT l'enregistrement de cette adoption : les adoptions concurrentes comptent, pas celle-ci.
    const full = this.tabs.size + this.adopting.size >= this.max;
    this.adoptingSids.add(sid);
    const run = (async (): Promise<Tab | undefined> => {
      if (this.stopping) { await close(); return undefined; }
      if (full) {
        await close();
        this.record({ refused: `popup fermé sans rien charger : plafond de ${this.max} onglets atteint (maxTabs) — fermez un onglet (grasp tab close <id>) ou relevez maxTabs`, openerTarget: info.openerId });
        return undefined;
      }
      let pc: PageController;
      try {
        // Garde, console et traqueurs posés avant que la cible ne s'exécute (relancée par `adopt` au bon moment).
        pc = await PageController.adopt(openerTab?.pc ?? this.activeTab?.pc ?? this.template, sid, info.targetId,
          waiting ? () => this.cdp.send('Runtime.runIfWaitingForDebugger', {}, sid) : undefined);
      } catch (e) {
        const gone = this.goneSids.has(sid);
        if (!gone) await close();
        this.record({ refused: gone ? 'popup refermé par la page avant d\'avoir pu être piloté' : `popup fermé : adoption impossible (${(e as Error).message})`, openerTarget: info.openerId });
        return undefined;
      }
      const tab = this.register(pc, openerTab?.id);
      this.record({ tab, openerTarget: info.openerId });
      if (this.goneSids.has(sid)) this.closed(tab);
      return tab;
    })();
    this.adopting.set(info.targetId, run);
    return run.catch(() => undefined).then(() => {
      this.adopting.delete(info.targetId);
      this.adoptingSids.delete(sid);
      this.goneSids.delete(sid);
      return true;
    });
  }

  private onEvent(e: CdpEvent): void {
    if (e.sessionId !== undefined || e.method !== 'Target.detachedFromTarget') return;
    const sid = String(e.params.sessionId ?? '');
    if (this.adoptingSids.has(sid)) this.goneSids.add(sid);
    for (const t of this.tabs.values()) if (t.pc.session === sid) { this.closed(t); return; }
  }

  /**
   * Onglet fermé (par la page, par l'utilisateur ou par `tab close`). Onglet actif fermé → l'onglet qui l'avait
   * ouvert redevient actif (retour du flux OAuth), à défaut le dernier activé.
   */
  private closed(tab: Tab, byGrasp = false): void {
    if (tab.closed) return;
    tab.closed = true;
    this.tabs.delete(tab.id);
    tab.pc.dispose();
    const h = this.history.indexOf(tab.id);
    if (h >= 0) this.history.splice(h, 1);
    let next: Tab | undefined;
    if (this.activeId === tab.id) {
      const opener = tab.opener !== undefined ? this.tabs.get(tab.opener) : undefined;
      const recent = [...this.history].reverse().map((id) => this.tabs.get(id)).find((t) => t !== undefined);
      next = opener ?? recent ?? this.tabs.values().next().value;
      this.activeId = undefined;
      if (next !== undefined) void this.focus(next);
    }
    if (!byGrasp && !this.stopping) this.closures.push({ id: tab.id, next, last: this.tabs.size === 0 });
  }

  private setActive(tab: Tab): void {
    this.activeId = tab.id;
    const h = this.history.indexOf(tab.id);
    if (h >= 0) this.history.splice(h, 1);
    this.history.push(tab.id);
  }

  /** Onglet actif, ramené au premier plan (pas en mode attach : jamais dans le Chrome de l'utilisateur). */
  private async focus(tab: Tab): Promise<void> {
    this.setActive(tab);
    if (!tab.pc.attachedMode) await this.cdp.send('Page.bringToFront', {}, tab.pc.session).catch(() => undefined);
  }

  private async info(tab: Tab): Promise<TabInfo> {
    const loc = await tab.pc.location().catch(() => ({ url: '', title: '' }));
    return { id: tab.id, url: loc.url, title: loc.title, active: tab.id === this.activeId, ...(tab.opener !== undefined ? { opener: tab.opener } : {}) };
  }

  private async describe(tab: Tab | undefined): Promise<string> {
    if (tab === undefined || tab.closed) return '';
    const i = await this.info(tab);
    return `${i.id}${i.title !== '' ? ` « ${i.title} »` : ''} ${i.url}`;
  }

  private find(id: string): Tab {
    if (!TAB_ID_RE.test(id)) throw badRequest(`onglet « ${id} » : identifiant t1, t2… attendu (grasp tabs)`);
    const t = this.tabs.get(id);
    if (t === undefined) throw notFound(`onglet ${id} inconnu ou fermé (onglets : ${[...this.tabs.keys()].join(', ') || 'aucun'}) — grasp tabs`);
    return t;
  }

  /** `grasp tabs` : onglets ouverts, dans l'ordre d'ouverture. */
  async list(): Promise<TabInfo[]> {
    return Promise.all([...this.tabs.values()].map((t) => this.info(t)));
  }

  /** `grasp tab <id>` : bascule. */
  async select(id: string): Promise<TabInfo> {
    const t = this.find(id);
    await this.focus(t);
    return this.info(t);
  }

  /**
   * `grasp tab new [url]` : onglet vierge, gardé comme les autres, puis navigation (pré-contrôle AVANT de créer
   * l'onglet : une URL refusée ne laisse rien derrière elle). Navigation en échec → onglet refermé.
   */
  async open(url?: string): Promise<TabInfo & { detail?: string }> {
    if (this.tabs.size + this.adopting.size >= this.max) throw conflict(`plafond de ${this.max} onglets atteint (maxTabs) : fermez-en un (grasp tab close <id>) ou relevez maxTabs`);
    const sibling = this.activeTab?.pc ?? this.template;
    if (url !== undefined) await sibling.assertNavigable(url);
    let tab: Tab | undefined;
    if (!sibling.attachedMode) {
      // Auto-attach du navigateur : la cible arrive en pause et passe par `adopt`, comme un popup.
      const { targetId } = await sibling.hub.creation('tab', () => this.cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' }));
      const end = Date.now() + NEW_TAB_WAIT_MS;
      while (this.byTarget(targetId) === undefined && !this.adopting.has(targetId) && Date.now() < end) await sleep(10);
      tab = this.byTarget(targetId) ?? await this.adopting.get(targetId);
      if (tab === undefined) {
        await this.cdp.send('Target.closeTarget', { targetId }).catch(() => undefined);
        throw new GraspError(502, 'nouvel onglet : le navigateur ne l\'a pas rattaché à Grasp à temps (onglet refermé)');
      }
    } else {
      // Mode attach : pas d'auto-attach du navigateur (onglets de l'utilisateur) ; attachement explicite.
      // La cible est réclamée (hub.claimed) : sans cela, le meneur prendrait son attachement pour celui d'un onglet
      // de l'utilisateur et le détacherait aussitôt.
      const { targetId } = await this.cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
      sibling.hub.claimed.add(targetId);
      try {
        const { sessionId } = await this.cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
        tab = this.register(await PageController.adopt(sibling, sessionId, targetId), undefined);
      } catch (e) {
        await this.cdp.send('Target.closeTarget', { targetId }).catch(() => undefined);
        throw e;
      } finally { sibling.hub.claimed.delete(targetId); }
    }
    const prev = this.activeTab;
    await this.focus(tab);
    let detail: string | undefined;
    if (url !== undefined) {
      try {
        detail = (await tab.pc.nav(url)).detail;
      } catch (e) {
        await this.shut(tab);
        if (prev !== undefined && !prev.closed) await this.focus(prev);
        if (e instanceof GraspError) throw new GraspError(e.status, `${e.message} — nouvel onglet refermé`, e.extra);
        throw e;
      }
    }
    return { ...(await this.info(tab)), ...(detail !== undefined ? { detail } : {}) };
  }

  /** Fermeture par Grasp (pas de note différée : la commande le dit elle-même). */
  private async shut(tab: Tab): Promise<void> {
    await this.cdp.send('Target.closeTarget', { targetId: tab.pc.target }).catch(() => undefined);
    this.closed(tab, true);
  }

  /** `grasp tab close [id]` : défaut l'onglet actif ; le dernier onglet de la session n'est jamais fermé. */
  async close(id?: string): Promise<{ closed: string; active: TabInfo }> {
    const tab = id !== undefined ? this.find(id) : this.activeTab;
    if (tab === undefined) throw conflict('aucun onglet actif à fermer (grasp tabs)');
    if (this.tabs.size === 1) throw conflict(`${tab.id} est le dernier onglet de la session : il reste ouvert (grasp session close pour fermer la session)`);
    await this.shut(tab);
    return { closed: tab.id, active: await this.info(this.activeTab ?? this.tabs.values().next().value!) };
  }

  /** Notes d'onglets fermés hors de toute commande (popup refermé par la page…) : à joindre à la réponse suivante. */
  async takeNotices(): Promise<string | undefined> {
    if (this.closures.length === 0) return undefined;
    const cs = this.closures.splice(0);
    const parts: string[] = [];
    for (const c of cs) parts.push(await this.closureNote(c));
    return parts.join(' ; ');
  }

  private async closureNote(c: Closure): Promise<string> {
    if (c.last) return `onglet ${c.id} fermé hors de Grasp : c'était le dernier de la session — grasp tab new [url] pour en ouvrir un`;
    const next = c.next !== undefined && !c.next.closed ? await this.describe(c.next) : '';
    return `onglet ${c.id} fermé par la page${next !== '' ? ` — onglet actif : ${next}` : ''}`;
  }

  /**
   * Action sur l'onglet `pc` : les popups qu'elle ouvre sont attendus (au plus 2 s), annoncés, et bloqués par le
   * garde s'ils visent un document refusé (onglet fermé, raison dite) ; `follow` y bascule. L'onglet de l'action
   * fermé par la page pendant l'action (popup OAuth) : l'action a eu lieu, le retour sur l'ouvreur est dit.
   */
  async act<T>(pc: PageController, fn: () => Promise<T>, follow: boolean, lenient = true): Promise<T> {
    const tab = this.tabOf(pc);
    if (tab === undefined) return fn();
    const mark = this.logEnd;
    const opens0 = pc.windowOpens;
    const c0 = this.closures.length;
    let res: T;
    let lost: unknown;
    try { res = await fn(); } catch (e) {
      // Échec dû à la fermeture de l'onglet par la page elle-même (window.close()) : l'action a eu lieu.
      // `lenient` faux (eval) : aucune valeur à rendre, l'erreur reste une erreur.
      if (!tab.closed || !lenient) throw e;
      lost = e;
      res = { ok: true } as T;
    }
    const notes: string[] = [];
    // Popups demandés (Page.windowOpen) : l'onglet arrive juste après, par l'auto-attach du navigateur.
    const wanted = pc.windowOpens - opens0;
    const mine = () => this.logSince(mark).filter((o) => o.openerTarget === pc.target).length;
    const end = Date.now() + POPUP_WAIT_MS;
    while (mine() < wanted && Date.now() < end) await sleep(20);
    await Promise.allSettled([...this.adopting.values()]);
    let followTo: Tab | undefined;
    for (const o of this.logSince(mark)) {
      if (o.refused !== undefined || o.tab === undefined) { if (o.refused !== undefined) notes.push(o.refused); continue; }
      const t = o.tab;
      const st = await t.pc.opened(POPUP_WAIT_MS, follow);
      if (t.closed) { notes.push(`onglet ${t.id} ouvert puis refermé par la page`); continue; }
      if (st.blocked !== null && blank(st.url)) {
        await this.shut(t);
        notes.push(`popup bloqué par Grasp : ${st.blocked.reason} — ${redactUrl(st.blocked.url)} ; onglet ${t.id} fermé`);
        continue;
      }
      notes.push(`nouvel onglet ${t.id} ouvert : ${st.url}${st.title !== '' ? ` « ${st.title} »` : ''}${st.blocked !== null ? ` (navigation bloquée : ${st.blocked.reason})` : ''}${follow ? '' : ` — grasp tab ${t.id} pour y basculer`}`);
      followTo = t;
    }
    const missing = wanted - mine();
    if (missing > 0) notes.push(`${missing} ouverture(s) de fenêtre demandée(s) par la page sans nouvel onglet (bloqueur de popups de Chrome, ouverture sans geste de l'utilisateur, ou fenêtre nommée déjà ouverte)`);
    if (follow) {
      if (followTo !== undefined && !followTo.closed) { await this.focus(followTo); notes.push(`onglet actif : ${followTo.id} (--follow)`); } else notes.push("--follow : aucun nouvel onglet ouvert par l'action, onglet actif inchangé");
    }
    // Onglets fermés pendant l'action : dits ici, pas à la réponse suivante.
    const during = this.closures.splice(c0);
    const fresh = new Set(this.logSince(mark).map((o) => o.tab?.id));
    for (const c of during) {
      if (fresh.has(c.id)) continue; // popup de cette action : déjà dit (« ouvert puis refermé »)
      if (c.id === tab.id) {
        // Retour sur l'ouvreur (flux OAuth) : sa page réagit (postMessage, rechargement) ; on attend qu'elle soit
        // stable, comme après une action, pour que la lecture suivante voie le résultat.
        if (c.next !== undefined && !c.next.closed) await c.next.pc.stable();
        notes.push(`l'onglet ${tab.id} s'est fermé pendant l'action (fermé par la page${lost !== undefined ? ' ; vérification de l\'action interrompue par la fermeture' : ''})${c.next !== undefined && !c.next.closed ? ` — onglet actif : ${await this.describe(c.next)}` : ''}`);
      }
      else notes.push(await this.closureNote(c));
    }
    if (notes.length > 0 && typeof res === 'object' && res !== null) {
      const r = res as { detail?: string };
      r.detail = [r.detail, ...notes].filter((x): x is string => typeof x === 'string' && x !== '').join(' ; ');
    }
    return res;
  }

  /**
   * Contrôleur de l'onglet actif vu comme UN PageController (API du bridge inchangée) : chaque accès vise
   * l'onglet actif du moment ; les actions passent par `act` (popups annoncés, --follow, onglet fermé).
   */
  facade(): PageController {
    return new Proxy({} as PageController, {
      get: (_t, k) => {
        // Plus aucun onglet : la politique reste lisible (rapport de sécurité), toute opération → 409.
        if (this.activeTab === undefined && k === 'policy') return this.template.policy;
        const pc = this.active;
        const v = (pc as unknown as Record<string | symbol, unknown>)[k];
        if (typeof v !== 'function') return v;
        const f = v as (...a: unknown[]) => unknown;
        if (typeof k === 'string' && ACTIONS.has(k)) {
          return (...args: unknown[]) => {
            const last = args.at(-1);
            const follow = typeof last === 'object' && last !== null && (last as { follow?: unknown }).follow === true;
            return this.act(pc, () => f.apply(pc, args) as Promise<unknown>, follow, k !== 'evaluateTyped');
          };
        }
        return f.bind(pc);
      },
    });
  }

  /** Arrêt du bridge : connexions Playwright de tous les onglets. */
  async closeEngines(): Promise<void> {
    await Promise.all([...this.tabs.values()].map((t) => t.pc.closeEngine().catch(() => undefined)));
  }

  /** Arrêt en mode attach : nos onglets sont fermés, le navigateur de l'utilisateur reste ouvert. */
  async closeAll(): Promise<void> {
    this.stopping = true;
    this.cdp.off('event', this.onCdp);
    await Promise.all([...this.tabs.values()].map((t) => t.pc.closeTab()));
  }
}
