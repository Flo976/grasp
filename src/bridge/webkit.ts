/**
 * Moteur WebKit (rendu proche de Safari, iPhone compris) — mode MINIMAL.
 *
 * Grasp pilote Chrome par CDP direct ; WebKit n'a pas de CDP. Ici, et seulement ici, Grasp LANCE un navigateur par
 * playwright-core (`webkit.launch`, build WebKit de Playwright : `npx playwright-core install webkit`) et sert la
 * même API HTTP de bridge qu'une session Chrome, sur un sous-ensemble de routes : nav, back, forward, reload, snap,
 * find, text, click, fill, type, select, check, press, hover, wait, expect (texte, url, titre, élément, valeur, mise
 * en page), screenshot, viewport, eval, cookies, storage, state import. Le reste répond 501 en le disant.
 *
 * Mêmes garde-fous que le moteur Chrome, appliqués par `context.route` :
 * - allowlist et protection SSRF sur CHAQUE document (page et iframes), redirections HTTP comprises — Playwright
 *   n'intercepte pas les sauts d'une redirection : le document est donc demandé sans la suivre (`route.fetch`,
 *   `maxRedirects: 0`), la cible est jugée, puis le navigateur y est envoyé (voir `guard`) ;
 * - téléchargements refusés, popups fermés avant tout chargement, service workers bloqués ;
 * - traqueurs bloqués (blockTrackers), frontières de contenu (même enveloppe que le bridge Chrome), masquage des
 *   secrets et des valeurs de recette, eval / cookies / stockage soumis à allowEval / allowCookies.
 * Limites assumées (docs/moteur-webkit.md) : pas de contrôle de l'adresse distante effective (rebinding DNS), ni
 * proxy, ni hostResolverRules, ni ignoreCertErrorsFor, ni profil persistant ; un seul onglet.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { GraspError, badRequest, conflict, forbidden, notFound } from '../core/errors.js';
import { readJson, sendBuffer, sendError, sendJson, str, optStr, optBool, optInt, optCount, optFlag } from '../core/http.js';
import { EVAL_REFUSAL, checkNavigation, checkUrl, policyRefusal, withAllowlistAdvice, type EffectivePolicy, type SsrfContext } from '../core/policy.js';
import { DEFAULT_LIMITS, truncateText, type Limits } from '../core/limits.js';
import { EXPECT_DEFAULT_MS, POLLED, describeExpected, excerpt, around, expectSpecOf, findText, matchValue, normSpace, type ExpectSpec } from '../core/expect.js';
import { DEVICES, describeViewport, viewportSpecOf, type ViewportSpec } from '../core/viewport.js';
import { STATE_MAX_BYTES, cookieAllowed, normalizeOrigin, parseState, type StateItem } from '../core/state.js';
import { maskedOf } from '../core/recipe.js';
import { Redactor, secretAllowedOn, type SecretUse } from '../core/secrets.js';
import { saveCapture } from '../core/captures.js';
import { imageSize, type ImageFormat } from '../core/image.js';
import { decideDialog, dialogLine, parseDialogOption, type DialogPolicy } from '../core/dialog.js';
import { redactResponse } from '../control/redact.js';
import { GEOM_FN, OVERFLOW_FN, judgeHorizontalOverflow, judgeInViewport, judgeNotClipped, type ElementGeometry, type PageOverflow } from './geometry.js';
import { compileFind, FIND_LIMIT_MAX } from './snapshot.js';
import { TrackerList } from './trackers.js';
import { defaultModule, playwrightVersion } from './playwright.js';
import { WK_REF_RE, diffAria, matchText, renderAria, type WkRenderOptions } from './webkit-snapshot.js';

// ---------- Types locaux (sous-ensemble de l'API publique de playwright-core : aucune dépendance de compilation) ----------

interface WkTimeout { timeout?: number }
interface WkLocator {
  click(o?: WkTimeout): Promise<void>;
  hover(o?: WkTimeout): Promise<void>;
  fill(v: string, o?: WkTimeout): Promise<void>;
  pressSequentially(t: string, o?: WkTimeout & { delay?: number }): Promise<void>;
  press(k: string, o?: WkTimeout): Promise<void>;
  selectOption(v: { value?: string; label?: string }, o?: WkTimeout): Promise<string[]>;
  setChecked(c: boolean, o?: WkTimeout): Promise<void>;
  isChecked(o?: WkTimeout): Promise<boolean>;
  inputValue(o?: WkTimeout): Promise<string>;
  innerText(o?: WkTimeout): Promise<string>;
  isVisible(): Promise<boolean>;
  count(): Promise<number>;
  first(): WkLocator;
  evaluate<R>(fn: (el: unknown) => R, arg?: unknown, o?: WkTimeout): Promise<R>;
  ariaSnapshot(o?: { mode?: 'ai'; boxes?: boolean; timeout?: number }): Promise<string>;
  screenshot(o?: Record<string, unknown>): Promise<Buffer>;
  waitFor(o?: WkTimeout & { state?: 'attached' | 'visible' }): Promise<void>;
}
interface WkFrame { page(): WkPage; url(): string }
interface WkRequest { url(): string; isNavigationRequest(): boolean; frame(): WkFrame }
interface WkApiResponse { status(): number; headers(): Record<string, string> }
interface WkRoute {
  request(): WkRequest;
  abort(code?: string): Promise<void>;
  continue(): Promise<void>;
  fetch(o?: { maxRedirects?: number; timeout?: number }): Promise<WkApiResponse>;
  fulfill(o: { response?: WkApiResponse; status?: number; contentType?: string; body?: string }): Promise<void>;
}
interface WkDialog { type(): string; message(): string; defaultValue(): string; accept(t?: string): Promise<void>; dismiss(): Promise<void> }
interface WkPage {
  goto(url: string, o?: WkTimeout & { waitUntil?: string }): Promise<unknown>;
  goBack(o?: WkTimeout & { waitUntil?: string }): Promise<unknown>;
  goForward(o?: WkTimeout & { waitUntil?: string }): Promise<unknown>;
  reload(o?: WkTimeout & { waitUntil?: string }): Promise<unknown>;
  url(): string;
  title(): Promise<string>;
  mainFrame(): WkFrame;
  locator(sel: string): WkLocator;
  ariaSnapshot(o?: { mode?: 'ai'; boxes?: boolean; timeout?: number }): Promise<string>;
  evaluate<R>(fn: string | ((arg: any) => R), arg?: unknown): Promise<R>;
  screenshot(o?: Record<string, unknown>): Promise<Buffer>;
  setViewportSize(s: { width: number; height: number }): Promise<void>;
  waitForLoadState(s: string, o?: WkTimeout): Promise<void>;
  keyboard: { press(k: string): Promise<void> };
  close(): Promise<void>;
  on(ev: string, f: (x: any) => void): void;
}
interface WkContext {
  newPage(): Promise<WkPage>;
  route(pattern: string, h: (r: WkRoute) => Promise<void>): Promise<void>;
  addCookies(c: Array<Record<string, unknown>>): Promise<void>;
  cookies(): Promise<unknown[]>;
  addInitScript(s: { content: string }): Promise<void>;
  on(ev: string, f: (x: any) => void): void;
}
interface WkBrowser { newContext(o: Record<string, unknown>): Promise<WkContext>; close(): Promise<void>; version(): string; on(ev: string, f: () => void): void }
interface WkModule { webkit: { launch(o: Record<string, unknown>): Promise<WkBrowser> }; devices: Record<string, { userAgent: string; defaultBrowserType?: string }> }

export const WEBKIT_INSTALL_HINT = 'npx playwright-core install webkit (dans le dossier de Grasp), puis les bibliothèques système : sudo npx playwright-core install-deps webkit';
/** Délai d'une action : Playwright attend que l'élément soit actionnable jusque-là. */
const ACTION_TIMEOUT_MS = 10_000;
const NAV_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 20;
const STORAGE_GET_MAX = 4000;
const ROUTES = 'nav, back, forward, reload, snap, find, text, click, fill, type, select, check, press, hover, wait, expect, screenshot, viewport, eval, cookies, storage, state import';

const unsupported = (what: string) => new GraspError(501, `${what} : non pris en charge par le moteur WebKit (mode minimal : ${ROUTES}) — pour cette commande, ouvrez une session Chrome (grasp session create, sans --browser webkit)`);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const firstLine = (e: unknown) => String((e as Error).message ?? e).split('\n')[0]!.replace(/^[\w.]+: /, '');

/** Charge playwright-core et vérifie qu'il sait lancer WebKit ; absent → 501 qui dit quoi installer. */
export async function loadWebKitModule(spec: string = defaultModule()): Promise<WkModule> {
  let m: unknown;
  try { m = await import(spec); } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') throw new GraspError(501, `moteur WebKit indisponible : le module « ${spec} » n'est pas installé — npm i playwright-core, puis ${WEBKIT_INSTALL_HINT}`);
    throw new GraspError(500, `moteur WebKit : chargement de « ${spec} » impossible : ${(e as Error).message}`);
  }
  const mod = m as Partial<WkModule> & { default?: Partial<WkModule> };
  const pw = typeof mod.webkit?.launch === 'function' ? mod : mod.default;
  if (typeof pw?.webkit?.launch !== 'function') throw new GraspError(500, `moteur WebKit : « ${spec} » n'expose pas webkit.launch (ce n'est pas playwright-core ?)`);
  return pw as WkModule;
}

/**
 * Échec de lancement de WebKit rendu actionnable. Deux causes connues (diagnostiquées sur Ubuntu 26.04) :
 * build absent ou d'une autre révision que celle qu'attend playwright-core (« Executable doesn't exist »), et
 * bibliothèques système manquantes (« Host system is missing dependencies », « error while loading shared libraries »).
 */
export function explainLaunchError(message: string, pwVersion: string | null): string {
  const v = pwVersion !== null ? ` ${pwVersion}` : '';
  if (/Executable doesn't exist/.test(message)) {
    return `WebKit n'est pas installé pour playwright-core${v} (chaque version attend SA révision du build, celle d'une autre version ne sert pas) — npx playwright-core install webkit, dans le dossier de Grasp`;
  }
  const libs = new Set<string>();
  for (const m of message.matchAll(/\b(lib[\w.+-]+\.so(?:\.\d+)*)/g)) libs.add(m[1]!);
  if (/missing dependencies|error while loading shared libraries/.test(message)) {
    return `WebKit ne démarre pas : bibliothèques système manquantes${libs.size > 0 ? ` (${[...libs].join(', ')})` : ''} — sudo npx playwright-core install-deps webkit ; Ubuntu récent : sudo apt-get install libevent-2.1-7t64 libmanette-0.2-0 libhidapi-hidraw0 (une bibliothèque peut en cacher une autre : relancez jusqu'à ce que WebKit démarre)`;
  }
  return `WebKit ne démarre pas : ${message.split('\n').slice(0, 3).join(' ').slice(0, 400)}`;
}

/** Options de contexte Playwright pour un viewport de Grasp : en mode mobile, user agent Safari d'iPhone ou d'iPad. */
export function contextOptionsOf(spec: ViewportSpec | undefined, devices: WkModule['devices']): Record<string, unknown> {
  const base: Record<string, unknown> = { acceptDownloads: false, serviceWorkers: 'block' };
  if (spec === undefined) return base;
  const out: Record<string, unknown> = { ...base, viewport: { width: spec.width, height: spec.height }, screen: { width: spec.width, height: spec.height }, deviceScaleFactor: spec.dpr > 0 ? spec.dpr : 1, isMobile: spec.mobile, hasTouch: spec.touch };
  if (spec.mobile || spec.mobileUa) {
    const label = spec.device !== undefined ? DEVICES[spec.device]?.label : undefined;
    const own = label !== undefined ? devices[label] : undefined;
    const d = own !== undefined && own.defaultBrowserType === 'webkit' ? own : devices['iPhone 14'];
    if (d !== undefined) out.userAgent = d.userAgent;
  }
  return out;
}

export interface WebKitInit {
  id: string;
  headless: boolean;
  policy: Readonly<EffectivePolicy>;
  limits?: Limits | undefined;
  capturesDir?: string | undefined;
  viewport?: ViewportSpec | undefined;
  log: (m: string) => void;
}

interface Blocked { url: string; reason: string; at: number }
interface ActOpts { snapDiff?: boolean | undefined; max?: number | undefined; scope?: string | undefined; dialog?: string | undefined; shotOnError?: boolean | undefined }

export class WebKitSession {
  readonly redactor = new Redactor();
  private readonly limits: Limits;
  private readonly ssrfCtx: SsrfContext;
  private readonly trackers: TrackerList | undefined;
  private scratch: WkPage | undefined;
  private scratchOrigin: string | undefined;
  private openingScratch = false;
  private blocked: Blocked | null = null;
  private redirectTo: string | undefined;
  private hops = 0;
  private fetchError: string | undefined;
  private readonly inflight = new Set<unknown>();
  private lastActivity = Date.now();
  private notes: string[] = [];
  private dialogPolicy: DialogPolicy | undefined;
  private trackersBlocked = 0;
  /** Génération du document principal : une ref remise sur un document précédent n'est jamais cherchée. */
  private docGen = 0;
  private refsDoc = -1;
  private vp: ViewportSpec | undefined;
  private readonly created: ViewportSpec | undefined;
  private pendingSeq = 0;
  private popupNoted = 0;

  private constructor(private readonly browser: WkBrowser, private readonly context: WkContext, private readonly page: WkPage, private readonly init: WebKitInit, readonly version: string) {
    this.limits = init.limits ?? DEFAULT_LIMITS;
    this.ssrfCtx = { allowedDomains: init.policy.allowedDomains, allowPrivateNetwork: init.policy.allowPrivateNetwork };
    this.trackers = init.policy.blockTrackers ? TrackerList.embedded() : undefined;
    this.vp = init.viewport;
    this.created = init.viewport;
  }

  get policy(): Readonly<EffectivePolicy> { return this.init.policy; }

  static async launch(init: WebKitInit, onDisconnect: () => void): Promise<WebKitSession> {
    const p = init.policy;
    // Jamais ignoré en silence : ce que ce moteur ne sait pas appliquer est refusé au démarrage.
    if (p.proxyServer !== null) throw new GraspError(501, 'moteur WebKit : proxyServer n\'est pas pris en charge (la protection SSRF ne saurait pas juger ce que le proxy résout) — session Chrome pour passer par un proxy');
    if (p.hostResolverRules.length > 0) throw new GraspError(501, 'moteur WebKit : hostResolverRules n\'est pas pris en charge — session Chrome pour un vhost joint par un tunnel');
    const pw = await loadWebKitModule();
    let browser: WkBrowser;
    try { browser = await pw.webkit.launch({ headless: init.headless }); } catch (e) {
      throw new GraspError(502, explainLaunchError((e as Error).message, playwrightVersion()));
    }
    try {
      if (p.ignoreCertErrorsFor.length > 0) init.log('AVERTISSEMENT : moteur WebKit : ignoreCertErrorsFor n\'est pas appliqué (les certificats sont toujours vérifiés)');
      const context = await browser.newContext(contextOptionsOf(init.viewport, pw.devices));
      const page = await context.newPage();
      const s = new WebKitSession(browser, context, page, init, browser.version());
      await context.route('**/*', (r) => s.guard(r).catch(async (e: Error) => { init.log(`garde WebKit : ${e.message}`); await r.abort('failed').catch(() => undefined); }));
      // Popup : sa première requête a déjà été refusée par le garde (qui en a rendu l'URL) ; l'onglet est fermé ici.
      context.on('page', (np: WkPage) => {
        if (np === page || s.openingScratch || np === s.scratch) return;
        if (Date.now() - s.popupNoted > 2000) s.notes.push('popup fermé : les onglets ne sont pas pris en charge par le moteur WebKit');
        void np.close().catch(() => undefined);
      });
      page.on('dialog', (d: WkDialog) => s.onDialog(d));
      page.on('framenavigated', (f: WkFrame) => { if (f === page.mainFrame()) s.onMainNavigated(f.url()); });
      page.on('request', (r: unknown) => { s.inflight.add(r); s.lastActivity = Date.now(); });
      const done = (r: unknown) => { s.inflight.delete(r); s.lastActivity = Date.now(); };
      page.on('requestfinished', done);
      page.on('requestfailed', done);
      page.on('download', () => s.notes.push('téléchargement refusé : non pris en charge par le moteur WebKit'));
      browser.on('disconnected', onDisconnect);
      return s;
    } catch (e) { await browser.close().catch(() => undefined); throw e; }
  }

  async close(): Promise<void> { await this.browser.close().catch(() => undefined); }

  // ---------- Garde : allowlist, SSRF, redirections, téléchargements, popups, traqueurs ----------

  private advise(reason: string): string { return withAllowlistAdvice(this.policy.allowedDomains, reason); }

  private async guard(route: WkRoute): Promise<void> {
    const rq = route.request();
    const url = rq.url();
    let frame: WkFrame | undefined;
    let pg: WkPage | undefined;
    try { frame = rq.frame(); pg = frame.page(); } catch { /* cadre pas encore créé (première requête d'un popup), ou worker */ }
    const popup = (): Promise<void> => {
      this.popupNoted = Date.now();
      this.notes.push(`popup vers ${url} fermé avant tout chargement : les onglets ne sont pas pris en charge par le moteur WebKit — grasp nav ${url} pour l'ouvrir dans l'onglet de la session`);
      return route.abort('blockedbyclient');
    };
    // Document demandé avant que son cadre n'existe : c'est la première requête d'un popup (window.open, target=_blank).
    if (frame === undefined && rq.isNavigationRequest()) return popup();
    // Onglet d'état : document vide servi par Grasp pour l'origine visée, tout le reste refusé — aucune requête ne part.
    if (pg !== undefined && pg === this.scratch) {
      if (rq.isNavigationRequest() && url === `${this.scratchOrigin ?? ''}/.grasp-etat`) return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><title>grasp</title>' });
      return route.abort('blockedbyclient');
    }
    // Requête d'un autre onglet que celui de la session : rien n'y charge.
    if (pg !== undefined && pg !== this.page) return rq.isNavigationRequest() ? popup() : route.abort('blockedbyclient');
    if (!rq.isNavigationRequest()) {
      // Sous-ressource : comme le moteur Chrome, le garde ne couvre que les documents ; les traqueurs sont annulés.
      if (this.trackers?.matchUrl(url) !== undefined) { this.trackersBlocked++; return route.abort('blockedbyclient'); }
      return route.continue();
    }
    const main = frame !== undefined && frame === this.page.mainFrame();
    const chained = main && this.redirectTo === url;
    if (main) { this.redirectTo = undefined; if (!chained) this.hops = 0; }
    // Seul le refus du document PRINCIPAL fait échouer la commande : une iframe refusée (publicité, widget) est
    // annulée sans bruit, comme avec le moteur Chrome.
    const block = (u: string, reason: string) => { if (main) this.blocked = { url: u, reason, at: Date.now() }; return route.abort('blockedbyclient'); };
    const v = await checkNavigation(this.ssrfCtx, url);
    if (!v.allowed) return block(url, v.reason);
    let resp: WkApiResponse;
    try { resp = await route.fetch({ maxRedirects: 0, timeout: NAV_TIMEOUT_MS }); } catch (e) {
      if (main) this.fetchError = firstLine(e);
      return route.abort('failed');
    }
    const status = resp.status();
    const headers = resp.headers();
    const location = headers.location;
    if (status >= 300 && status < 400 && location !== undefined && location !== '') {
      // Redirection : la cible est jugée AVANT que le navigateur ne la demande (détecter ≠ bloquer). Playwright ne
      // sait pas répondre par un 3xx : un document minimal, servi sous l'URL d'origine, remplace l'entrée courante
      // par la cible, dont la requête repasse par ce garde (chaîne de redirections comprise).
      let target: string;
      try { target = new URL(location, url).href; } catch { return route.abort('failed'); }
      const tv = await checkNavigation(this.ssrfCtx, target);
      if (!tv.allowed) return block(`${target} — cible d'une redirection de ${url}`, tv.reason);
      if (main && ++this.hops > MAX_REDIRECTS) { this.fetchError = `trop de redirections (${MAX_REDIRECTS})`; return route.abort('failed'); }
      if (main) this.redirectTo = target;
      return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title></title><script>location.replace(${JSON.stringify(target).replace(/</g, '\\u003c')})</script>` });
    }
    if (/^\s*attachment/i.test(headers['content-disposition'] ?? '')) return block(url, 'téléchargement refusé (non pris en charge par le moteur WebKit)');
    return route.fulfill({ response: resp });
  }

  /** Filet : document principal arrivé sur une URL que le garde n'a pas vue (data:, blob:…) — page quittée, dit. */
  private onMainNavigated(url: string): void {
    this.docGen++;
    if (url === 'about:blank' || url === '') return;
    const v = checkUrl(this.policy.allowedDomains, url);
    if (v.allowed) return;
    this.blocked = { url, reason: v.reason, at: Date.now() };
    void this.page.goto('about:blank').catch(() => undefined);
  }

  private onDialog(d: WkDialog): void {
    const { params, seen } = decideDialog(d.type(), d.message(), d.defaultValue(), this.dialogPolicy);
    this.notes.push(dialogLine(seen));
    void (params.accept ? d.accept(params.promptText) : d.dismiss()).catch(() => undefined);
  }

  // ---------- Stabilité ----------

  /** Redirection en vol suivie, document chargé, puis réseau calme (300 ms sans requête), dans la limite du plafond. */
  private async settle(): Promise<string | undefined> {
    const cap = this.limits.stableTimeoutMs > 0 ? this.limits.stableTimeoutMs : DEFAULT_LIMITS.stableTimeoutMs;
    const end = Date.now() + cap;
    while (this.redirectTo !== undefined && Date.now() < end) await sleep(20);
    await this.page.waitForLoadState('load', { timeout: Math.max(1, end - Date.now()) }).catch(() => undefined);
    for (;;) {
      if (this.redirectTo === undefined && this.inflight.size === 0 && Date.now() - this.lastActivity >= 300) return undefined;
      if (Date.now() >= end) return `page non stabilisée en ${cap} ms (${this.inflight.size} requête(s) en vol) : la page peut encore changer`;
      await sleep(40);
    }
  }

  private takeNotes(extra?: string): string | undefined {
    const all = [...this.notes, ...(extra !== undefined ? [extra] : [])];
    this.notes = [];
    return all.length > 0 ? this.redactor.redact(all.join(' ; ')) : undefined;
  }

  // ---------- Navigation ----------

  async location(): Promise<{ url: string; title: string }> {
    return { url: this.redactor.redact(this.page.url()), title: this.redactor.redact(await this.page.title().catch(() => '')) };
  }

  private async navigated(run: () => Promise<unknown>, opts: ActOpts, what: string): Promise<Record<string, unknown>> {
    this.dialogPolicy = parseDialogOption(opts.dialog);
    const before = opts.snapDiff === true ? await this.snapRaw(opts.scope) : undefined;
    const t0 = Date.now();
    this.blocked = null;
    this.fetchError = undefined;
    try {
      let err: unknown;
      try { await run(); } catch (e) { err = e; }
      const b = this.blocked as Blocked | null;
      if (b !== null && b.at >= t0) throw forbidden(`navigation bloquée par le garde : ${this.advise(b.reason)} (${b.url})`);
      // Une redirection en vol interrompt la première navigation : ce n'est pas un échec.
      if (err !== undefined && this.redirectTo === undefined && !/interrupted|aborted/i.test(String((err as Error).message))) {
        throw new GraspError(502, `${what} échouée : ${this.fetchError ?? firstLine(err)}`);
      }
      const unstable = await this.settle();
      const b2 = this.blocked as Blocked | null;
      if (b2 !== null && b2.at >= t0) throw forbidden(`navigation bloquée par le garde : ${this.advise(b2.reason)} (${b2.url})`);
      const out: Record<string, unknown> = { ok: true, ...(await this.location()) };
      if (this.trackersBlocked > 0) { out.trackersBlocked = this.trackersBlocked; this.trackersBlocked = 0; }
      if (before !== undefined) out.diff = await this.diffSince(before, opts);
      const detail = this.takeNotes(unstable);
      if (detail !== undefined) out.detail = detail;
      return out;
    } finally { this.dialogPolicy = undefined; }
  }

  async nav(url: string, opts: ActOpts): Promise<Record<string, unknown>> {
    const v = await checkNavigation(this.ssrfCtx, url);
    if (!v.allowed) throw forbidden(`navigation bloquée : ${this.advise(v.reason)}`);
    return this.navigated(() => this.page.goto(url, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS }), opts, 'navigation');
  }

  async history(delta: -1 | 1, opts: ActOpts): Promise<Record<string, unknown>> {
    const from = this.page.url();
    let none = false;
    const o = { waitUntil: 'load', timeout: NAV_TIMEOUT_MS };
    const r = await this.navigated(async () => { if (await (delta < 0 ? this.page.goBack(o) : this.page.goForward(o)) === null) none = true; }, opts, delta < 0 ? 'retour' : 'avance');
    // null sans changement d'URL : aucune entrée d'historique dans ce sens (une route pushState, elle, change l'URL).
    if (none && this.page.url() === from) throw conflict(delta < 0 ? 'aucune page précédente dans l\'historique de l\'onglet' : 'aucune page suivante dans l\'historique de l\'onglet');
    return r;
  }

  reload(opts: ActOpts): Promise<Record<string, unknown>> {
    if (this.page.url() === 'about:blank') throw conflict('aucun document à recharger (historique de l\'onglet vide)');
    return this.navigated(() => this.page.reload({ waitUntil: 'load', timeout: NAV_TIMEOUT_MS }), opts, 'rechargement');
  }

  // ---------- Lecture ----------

  private async scroll(): Promise<{ x: number; y: number }> {
    return this.page.evaluate<{ x: number; y: number }>('({ x: window.scrollX, y: window.scrollY })').catch(() => ({ x: 0, y: 0 }));
  }

  /** Arbre ARIA brut (YAML de Playwright). Un snapshot de la page entière renouvelle les refs utilisables. */
  private async snapRaw(scope?: string, boxes = false): Promise<string> {
    const o = { mode: 'ai' as const, timeout: ACTION_TIMEOUT_MS, ...(boxes ? { boxes: true } : {}) };
    try {
      if (scope !== undefined) return await (await this.resolve(scope)).ariaSnapshot(o);
      const y = await this.page.ariaSnapshot(o);
      this.refsDoc = this.docGen;
      return y;
    } catch (e) {
      if (e instanceof GraspError) throw e;
      throw new GraspError(502, `snapshot impossible : ${firstLine(e)}`);
    }
  }

  async snapText(o: { maxBytes?: number | undefined; scope?: string | undefined; nameMax?: number | undefined; mode?: string | null; find?: string | null; role?: string | null; limit?: number | undefined; boxes?: boolean }): Promise<string> {
    const r: WkRenderOptions = { ...(o.nameMax !== undefined ? { nameMax: o.nameMax } : {}) };
    if (o.mode !== null && o.mode !== undefined) {
      if (o.mode !== 'outline' && o.mode !== 'interactive') throw badRequest(`mode de snap inconnu « ${o.mode} » (outline, interactive)`);
      r.mode = o.mode;
    }
    if (o.find !== null && o.find !== undefined) {
      if (r.mode !== undefined) throw badRequest(`find et --${r.mode} sont exclusifs`);
      let pattern;
      try { pattern = compileFind(o.find); } catch (e) { throw badRequest((e as Error).message); }
      if (o.limit !== undefined && o.limit > FIND_LIMIT_MAX) throw badRequest(`find --max : ${FIND_LIMIT_MAX} au plus`);
      const roles = o.role !== null && o.role !== undefined ? o.role.split(',').map((x) => x.trim()).filter((x) => x !== '') : undefined;
      r.find = { test: pattern.test, ...(roles !== undefined ? { roles } : {}), ...(o.limit !== undefined ? { limit: o.limit } : {}) };
    } else if ((o.role !== null && o.role !== undefined) || o.limit !== undefined) throw badRequest('« role » et « limit » ne s\'appliquent qu\'avec find');
    if (o.boxes === true) { r.boxes = true; r.scroll = await this.scroll(); }
    const yaml = await this.snapRaw(o.scope, o.boxes === true);
    const text = this.redactor.redact(renderAria(yaml, r));
    return truncateText(text === '' ? (r.find !== undefined ? '(aucune correspondance)' : '(page vide)') : text, o.maxBytes ?? this.limits.snapMax, { wholeLines: true });
  }

  private async diffSince(before: string, opts: ActOpts): Promise<string> {
    const after = await this.snapRaw(opts.scope);
    return truncateText(this.redactor.redact(diffAria(renderAria(before), renderAria(after))), opts.max ?? this.limits.diffMax, { wholeLines: true });
  }

  private async rawText(scope?: string): Promise<string> {
    const loc = scope !== undefined ? await this.resolve(scope) : this.page.locator('body');
    try { return await loc.innerText({ timeout: ACTION_TIMEOUT_MS }); } catch (e) { throw new GraspError(502, `lecture du texte impossible : ${firstLine(e)}`); }
  }

  async text(max: number | undefined, scope: string | undefined): Promise<string> {
    const t = (await this.rawText(scope)).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    return truncateText(this.redactor.redact(t), max ?? this.limits.textMax);
  }

  // ---------- Sélecteurs ----------

  /**
   * ref (`e12`, `f1e3` : du dernier `snap`), `text:Libellé` (nom accessible, mêmes paliers que le moteur Chrome),
   * CSS (`css:` facultatif, `>> nth=N`). Jamais de choix arbitraire : ambigu → 409 avec les candidats.
   */
  private async resolve(sel: string): Promise<WkLocator> {
    const s = sel.trim();
    if (s === '') throw badRequest('sélecteur vide');
    if (s.startsWith('frame=')) throw badRequest('sélecteur frame=… sans objet avec le moteur WebKit : le snapshot contient déjà les cadres, agissez par leurs refs (f1e3)');
    if (WK_REF_RE.test(s)) return this.byRef(s);
    if (/^e[0-9a-z]{1,4}$/.test(s)) throw notFound(`ref ${s} inconnue du moteur WebKit : ses refs sont de la forme e12 ou f1e3 (celles du moteur Chrome ne s'y transportent pas) — refaites \`snap\``);
    if (s.startsWith('text:')) {
      const t = s.slice(5).trim();
      if (t === '') throw badRequest('text: attend un texte');
      const m = matchText(await this.snapRaw(), t);
      if (m.ref !== undefined) return this.page.locator(`aria-ref=${m.ref}`);
      if (m.candidates.length > 1) throw new GraspError(409, `text:${t} est ambigu (${m.candidates.length} correspondances : ${m.candidates.slice(0, 8).map((c) => `${c.ref} ${c.role} "${c.name}"`).join(', ')}) — utilisez une ref`, { candidates: m.candidates.slice(0, 8) });
      throw notFound(`aucun élément nommé « ${t} » — \`grasp snap --interactive\` pour voir les éléments actionnables, ou \`grasp find ${t}\``);
    }
    const css = s.startsWith('css:') ? s.slice(4) : s;
    const loc = this.page.locator(css);
    let n: number;
    try { n = await loc.count(); } catch (e) { throw badRequest(`sélecteur invalide « ${css} » : ${firstLine(e)}`); }
    if (n === 0) throw notFound(`aucun élément ne correspond à ${css}`);
    if (n > 1) throw new GraspError(409, `${css} est ambigu : ${n} éléments correspondent — précisez le sélecteur, ou choisissez-en un par son rang : '${css} >> nth=0' (0 à ${n - 1})`);
    return loc;
  }

  private async byRef(ref: string): Promise<WkLocator> {
    const stale = () => notFound(`ref ${ref} vient d'une page précédente : la page a changé depuis le snapshot qui l'a remise — refaites \`snap\` (\`grasp snap --interactive\` suffit pour agir)`);
    if (this.refsDoc === -1) throw notFound(`ref ${ref} inconnue : elle ne vient d'aucun snapshot de cette session — refaites \`snap\` (\`grasp snap --interactive\` : seulement les éléments actionnables)`);
    if (this.refsDoc !== this.docGen) throw stale();
    const loc = this.page.locator(`aria-ref=${ref}`);
    let n: number;
    try { n = await loc.count(); } catch { n = 0; }
    if (n === 0) throw notFound(`ref ${ref} n'est plus dans la page (re-rendue depuis le snapshot ?) : les refs du moteur WebKit valent jusqu'au rendu suivant — refaites \`snap\` (\`grasp snap --interactive\` suffit pour agir)`);
    return loc;
  }

  // ---------- Actions ----------

  private actionError(e: unknown, what: string): GraspError {
    if (e instanceof GraspError) return e;
    const msg = String((e as Error).message ?? e);
    if (/Timeout \d+ms exceeded/.test(msg)) {
      const why = /element is not (visible|enabled|stable|editable)|intercepts pointer events|outside of the viewport/.exec(msg)?.[0];
      return new GraspError(409, `${what} : élément non actionnable en ${ACTION_TIMEOUT_MS} ms${why !== undefined ? ` (${why})` : ''} — masqué, désactivé ou recouvert ? refaites \`snap\``);
    }
    return new GraspError(502, `${what} : ${firstLine(e)}`);
  }

  private async act(what: string, opts: ActOpts, run: () => Promise<string | undefined>): Promise<Record<string, unknown>> {
    this.dialogPolicy = parseDialogOption(opts.dialog);
    const before = opts.snapDiff === true ? await this.snapRaw(opts.scope) : undefined;
    const t0 = Date.now();
    try {
      let detail: string | undefined;
      try { detail = await run(); } catch (e) { throw this.actionError(e, what); }
      const unstable = await this.settle();
      const out: Record<string, unknown> = { ok: true };
      if (this.trackersBlocked > 0) { out.trackersBlocked = this.trackersBlocked; this.trackersBlocked = 0; }
      if (before !== undefined) out.diff = await this.diffSince(before, opts);
      const b = this.blocked;
      if (detail !== undefined) this.notes.unshift(detail);
      if (b !== null && b.at >= t0) this.notes.push(`navigation bloquée : ${this.advise(b.reason)} (${b.url})`);
      const d = this.takeNotes(unstable);
      if (d !== undefined) out.detail = d;
      return out;
    } catch (e) {
      if (opts.shotOnError === true && e instanceof GraspError) {
        const shot = await this.saveShot({}).catch(() => undefined);
        if (shot !== undefined) throw new GraspError(e.status, `${e.message} (capture : ${shot.path})`, { ...e.extra, screenshot: shot.path });
      }
      throw e;
    } finally { this.dialogPolicy = undefined; }
  }

  click(target: string, opts: ActOpts): Promise<Record<string, unknown>> {
    return this.act('click', opts, async () => { await (await this.resolve(target)).click({ timeout: ACTION_TIMEOUT_MS }); return undefined; });
  }

  hover(target: string, opts: ActOpts): Promise<Record<string, unknown>> {
    return this.act('hover', opts, async () => { await (await this.resolve(target)).hover({ timeout: ACTION_TIMEOUT_MS }); return undefined; });
  }

  fill(target: string, value: string, opts: ActOpts, secret?: SecretUse): Promise<Record<string, unknown>> {
    return this.act('fill', opts, async () => {
      if (secret !== undefined) {
        // Le secret n'est saisi que sur une page d'un de ses domaines ; sa valeur est masquée dès maintenant.
        this.redactor.add(secret.name, value);
        if (!secretAllowedOn(secret.domains, this.page.url())) throw forbidden(`secret:${secret.name} n'est pas autorisé sur cette page (${new URL(this.page.url()).hostname || this.page.url()}) : ses domaines sont ${secret.domains.join(', ')}`);
      }
      const loc = await this.resolve(target);
      await loc.fill(value, { timeout: ACTION_TIMEOUT_MS });
      const actual = await loc.inputValue({ timeout: ACTION_TIMEOUT_MS }).catch(() => undefined);
      if (actual !== undefined && actual !== value) {
        if (secret !== undefined) { this.redactor.add(secret.name, actual); throw conflict(`la valeur effective du champ (${actual.length} caractère(s)) n'est pas celle de secret:${secret.name} (le champ a-t-il transformé la saisie ?)`); }
        throw conflict(`la valeur effective du champ est « ${actual} » et non « ${value} » (le champ a-t-il refusé ou transformé la saisie ?)`);
      }
      return undefined;
    });
  }

  type(target: string, text: string, opts: ActOpts & { delay?: number | undefined }): Promise<Record<string, unknown>> {
    if (opts.delay !== undefined && (opts.delay < 0 || opts.delay > 1000)) throw badRequest('--delay : 0 à 1000 ms');
    return this.act('type', opts, async () => { await (await this.resolve(target)).pressSequentially(text, { timeout: ACTION_TIMEOUT_MS + text.length * (opts.delay ?? 0), ...(opts.delay !== undefined ? { delay: opts.delay } : {}) }); return undefined; });
  }

  select(target: string, value: string, opts: ActOpts): Promise<Record<string, unknown>> {
    return this.act('select', opts, async () => {
      const loc = await this.resolve(target);
      // Valeur d'abord, libellé ensuite (comme le moteur Chrome) ; délai court : une option absente est une erreur immédiate.
      try { await loc.selectOption({ value }, { timeout: 1500 }); } catch {
        try { await loc.selectOption({ label: value }, { timeout: 1500 }); } catch (e) {
          if (/not a <select>|Element is not a/i.test(String((e as Error).message))) throw conflict('l\'élément n\'est pas un <select> natif (liste personnalisée : click puis click sur l\'option)');
          throw notFound(`aucune option « ${value} » (ni valeur ni libellé) dans cette liste`);
        }
      }
      return undefined;
    });
  }

  check(target: string, checked: boolean, opts: ActOpts): Promise<Record<string, unknown>> {
    return this.act('check', opts, async () => {
      const loc = await this.resolve(target);
      if (await loc.isChecked({ timeout: ACTION_TIMEOUT_MS }) === checked) return `case déjà ${checked ? 'cochée' : 'décochée'}`;
      await loc.setChecked(checked, { timeout: ACTION_TIMEOUT_MS });
      return undefined;
    });
  }

  press(key: string, target: string | undefined, opts: ActOpts): Promise<Record<string, unknown>> {
    return this.act('press', opts, async () => {
      try {
        if (target !== undefined) await (await this.resolve(target)).press(key, { timeout: ACTION_TIMEOUT_MS });
        else await this.page.keyboard.press(key);
      } catch (e) {
        if (/Unknown key/i.test(String((e as Error).message))) throw badRequest(`touche inconnue « ${key} » (Enter, Tab, Escape, ArrowDown, Control+a…)`);
        throw e;
      }
      return undefined;
    });
  }

  // ---------- Attente et assertions ----------

  async wait(o: { text?: string | undefined; sel?: string | undefined; idle?: boolean | undefined; timeout?: number | undefined }): Promise<Record<string, unknown>> {
    const modes = [o.text !== undefined, o.sel !== undefined, o.idle === true].filter((x) => x).length;
    if (modes > 1) throw badRequest('wait : une seule condition à la fois (--text, --sel ou --idle)');
    const t0 = Date.now();
    if (o.text === undefined && o.sel === undefined) {
      const why = await this.settle();
      if (why !== undefined) throw new GraspError(504, why.replace(/ : la page peut encore changer$/, ''));
      return { ok: true, waited: Date.now() - t0, condition: 'idle' };
    }
    const end = t0 + (o.timeout ?? 10_000);
    for (;;) {
      try {
        if (o.text !== undefined) { if (normSpace(await this.rawText()).includes(normSpace(o.text))) return { ok: true, waited: Date.now() - t0, condition: 'text' }; }
        else if (await (await this.resolve(o.sel!)).first().isVisible()) return { ok: true, waited: Date.now() - t0, condition: 'sel' };
      } catch (e) { if (e instanceof GraspError && [400, 409].includes(e.status)) throw e; }
      if (Date.now() >= end) throw new GraspError(504, `${o.text !== undefined ? `texte « ${o.text} »` : o.sel!} absent après ${o.timeout ?? 10_000} ms`);
      await sleep(100);
    }
  }

  private async geometry(target: string): Promise<ElementGeometry> {
    const loc = await this.resolve(target);
    // Code FIXE de Grasp (bridge/geometry.ts), enveloppé en fonction : aucune évaluation de code venu de l'agent.
    const fn = new Function('el', `return (${GEOM_FN}).call(el);`) as (el: unknown) => ElementGeometry;
    return loc.evaluate(fn, undefined, { timeout: ACTION_TIMEOUT_MS });
  }

  private async observe(spec: ExpectSpec): Promise<{ ok: boolean; observed: string; items?: string[] }> {
    switch (spec.kind) {
      case 'text': case 'no-text': {
        const t = normSpace(this.redactor.redact(await this.rawText(spec.scope)));
        const hit = findText(t, spec);
        if (spec.kind === 'text') return hit.index >= 0 ? { ok: true, observed: '' } : { ok: false, observed: `texte absent ; début de la zone : ${excerpt(t)}` };
        return hit.index < 0 ? { ok: true, observed: '' } : { ok: false, observed: `texte présent : ${around(t, hit.index, hit.length)}` };
      }
      case 'url': case 'title': {
        const loc = await this.location();
        const v = spec.kind === 'url' ? loc.url : loc.title;
        return matchValue(v, spec) ? { ok: true, observed: '' } : { ok: false, observed: `${spec.kind === 'url' ? 'url' : 'titre'} « ${v} »` };
      }
      case 'sel': case 'no-sel': {
        let visible = false;
        try { visible = await (await this.resolve(spec.target!)).first().isVisible(); } catch (e) { if (!(e instanceof GraspError) || e.status !== 404) throw e; }
        if (spec.kind === 'sel') return visible ? { ok: true, observed: '' } : { ok: false, observed: 'élément absent ou invisible' };
        return visible ? { ok: false, observed: 'élément visible' } : { ok: true, observed: '' };
      }
      case 'value': {
        const raw = await (await this.resolve(spec.target!)).inputValue({ timeout: 2000 });
        const v = this.redactor.redact(raw);
        return matchValue(v, spec) ? { ok: true, observed: '' } : { ok: false, observed: `valeur « ${v} »` };
      }
      case 'in-viewport': case 'not-clipped': {
        const g = await this.geometry(spec.target!);
        return spec.kind === 'in-viewport' ? judgeInViewport(g, spec.fully === true) : judgeNotClipped(g);
      }
      case 'no-horizontal-overflow': return judgeHorizontalOverflow(await this.page.evaluate<PageOverflow>(OVERFLOW_FN));
      default: throw unsupported(`expect ${spec.kind}`);
    }
  }

  async expect(spec: ExpectSpec, opts: { shotOnError?: boolean | undefined }): Promise<Record<string, unknown>> {
    if (!POLLED.has(spec.kind) || spec.kind === 'request') throw unsupported(`expect ${spec.kind}`);
    const t0 = Date.now();
    const end = t0 + (spec.timeout ?? EXPECT_DEFAULT_MS);
    let last: { ok: boolean; observed: string; items?: string[] };
    for (;;) {
      try { last = await this.observe(spec); } catch (e) {
        if (e instanceof GraspError && [400, 403, 409, 501].includes(e.status)) throw e;
        last = { ok: false, observed: `lecture impossible (${firstLine(e)})` };
      }
      if (last.ok) return { ok: true, kind: spec.kind, waited: Date.now() - t0 };
      if (Date.now() >= end) break;
      await sleep(100);
    }
    let shot: string | undefined;
    if (opts.shotOnError === true && this.init.capturesDir !== undefined) shot = await this.saveShot({}).then((s) => s.path).catch(() => undefined);
    throw new GraspError(417, `attendu ${describeExpected(spec)} ; constaté : ${last.observed}${shot !== undefined ? ` (capture : ${shot})` : ''}`, { expect: { kind: spec.kind, expected: describeExpected(spec), observed: last.observed, ...(last.items !== undefined ? { items: last.items } : {}) }, ...(shot !== undefined ? { screenshot: shot } : {}) });
  }

  // ---------- Capture et viewport ----------

  async capture(o: { full?: boolean | undefined; el?: string | undefined; format?: string | undefined; quality?: number | undefined; maxWidth?: number | undefined; refs?: boolean | undefined }): Promise<{ data: Buffer; width: number; height: number; format: ImageFormat }> {
    if (o.refs === true) throw unsupported('screenshot --refs');
    const format = o.format ?? 'png';
    if (format !== 'png' && format !== 'jpeg') throw badRequest(`format « ${format} » non pris en charge par le moteur WebKit (png, jpeg)`);
    if (o.quality !== undefined && (format !== 'jpeg' || o.quality < 1 || o.quality > 100)) throw badRequest('--quality : 1 à 100, avec --format jpeg');
    if (o.full === true && o.el !== undefined) throw badRequest('--full et --el s\'excluent');
    // --max-width : seule réduction possible ici, l'échelle CSS (un pixel par px CSS au lieu de la densité de l'appareil).
    const opts: Record<string, unknown> = { type: format, timeout: ACTION_TIMEOUT_MS, ...(o.quality !== undefined ? { quality: o.quality } : {}), ...(o.maxWidth !== undefined ? { scale: 'css' } : {}), ...(o.full === true ? { fullPage: true } : {}) };
    let data: Buffer;
    try { data = o.el !== undefined ? await (await this.resolve(o.el)).screenshot(opts) : await this.page.screenshot(opts); } catch (e) {
      if (e instanceof GraspError) throw e;
      throw new GraspError(502, `capture impossible : ${firstLine(e)}`);
    }
    const size = imageSize(data);
    return { data, width: size.width, height: size.height, format };
  }

  async saveShot(o: Parameters<WebKitSession['capture']>[0]): Promise<{ path: string; width: number; height: number; bytes: number; format: ImageFormat }> {
    if (this.init.capturesDir === undefined) throw new GraspError(500, 'aucun répertoire de captures configuré pour ce bridge');
    const s = await this.capture(o);
    return { path: saveCapture(this.init.capturesDir, s.data, s.format), width: s.width, height: s.height, bytes: s.data.length, format: s.format };
  }

  async viewportInfo(detail?: string): Promise<Record<string, unknown>> {
    const m = await this.page.evaluate<{ width: number; height: number; dpr: number; touchPoints: number; pointer: string; ua: string }>(
      '({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, touchPoints: navigator.maxTouchPoints, pointer: matchMedia("(pointer: coarse)").matches ? "coarse" : matchMedia("(pointer: fine)").matches ? "fine" : "none", ua: navigator.userAgent })',
    ).catch(() => undefined);
    return {
      ok: true, viewport: this.vp === undefined ? null : { ...this.vp }, engine: 'webkit',
      ...(this.vp !== undefined ? { description: describeViewport(this.vp) } : {}),
      ...(detail !== undefined ? { detail } : {}),
      ...(m !== undefined ? { measured: { width: m.width, height: m.height, dpr: m.dpr, touchPoints: m.touchPoints, pointer: m.pointer, mobileUa: /\bMobile\b/.test(m.ua) } } : {}),
    };
  }

  /**
   * Seule la TAILLE change en cours de session : densité, mode mobile, tactile et user agent sont des réglages du
   * contexte WebKit, fixés à `session create --browser webkit --viewport …`. Les changer = 409 qui le dit.
   */
  async setViewport(given: ViewportSpec | null, sizeOnly = false): Promise<Record<string, unknown>> {
    const cur = this.created;
    const fixed = (v: ViewportSpec | undefined) => `${v !== undefined && v.dpr > 0 ? v.dpr : 1}/${v?.mobile === true}/${v?.touch === true}`;
    // Taille seule (`grasp viewport 360x800`) : densité, mode mobile et tactile de la création sont gardés.
    const spec: ViewportSpec | null = given !== null && sizeOnly && cur !== undefined ? { width: given.width, height: given.height, dpr: cur.dpr, mobile: cur.mobile, touch: cur.touch, mobileUa: cur.mobileUa } : given;
    const want = spec ?? cur;
    if (spec !== null && fixed(spec) !== fixed(cur)) {
      throw conflict(`moteur WebKit : densité (dpr), mode mobile et tactile sont fixés à la création de la session (ici : ${cur !== undefined ? describeViewport(cur) : 'viewport du navigateur'}) ; seule la taille change en cours de route — pour ${describeViewport(spec)} : grasp session create --browser webkit --viewport ${spec.device ?? `${spec.width}x${spec.height}`}`);
    }
    await this.page.setViewportSize(want !== undefined ? { width: want.width, height: want.height } : { width: 1280, height: 720 });
    this.vp = want;
    return this.viewportInfo();
  }

  // ---------- Sensibles : eval, cookies, stockage, état ----------

  async evaluate(expression: string): Promise<{ value?: unknown; type: string }> {
    if (!this.policy.allowEval) throw forbidden(EVAL_REFUSAL);
    let v: unknown;
    try { v = await this.page.evaluate<unknown>(expression); } catch (e) { throw badRequest(`exception : ${firstLine(e)}`); }
    return v === undefined ? { type: 'undefined' } : { value: v, type: v === null ? 'null' : typeof v };
  }

  private stateAllowed(): void {
    if (!this.policy.allowCookies) throw forbidden(policyRefusal('l\'export et l\'import de l\'état (cookies, stockage Web) sont désactivés', 'allowCookies'));
  }

  async cookies(): Promise<unknown[]> {
    if (!this.policy.allowCookies) throw forbidden(policyRefusal('l\'accès aux cookies est désactivé', 'allowCookies'));
    return this.context.cookies();
  }

  /** Ouvre `origin` dans l'onglet d'état (document vide servi par le garde : aucune requête au site) et y exécute du code FIXE. */
  private async inOrigin<R>(origin: string, fn: (a: any) => R, arg: unknown): Promise<R> {
    this.openingScratch = true;
    let pg: WkPage | undefined;
    try {
      pg = await this.context.newPage();
      this.scratch = pg;
      this.scratchOrigin = origin;
      this.openingScratch = false;
      await pg.goto(`${origin}/.grasp-etat`, { timeout: ACTION_TIMEOUT_MS });
      return await pg.evaluate(fn, arg);
    } finally {
      this.openingScratch = false;
      this.scratch = undefined;
      this.scratchOrigin = undefined;
      await pg?.close().catch(() => undefined);
    }
  }

  /**
   * sessionStorage d'une origine pas encore affichée : posé au PREMIER document de cette origine dans l'onglet.
   * Un script d'initialisation de contexte ne se retire pas : il se neutralise lui-même par un témoin
   * (`__grasp_etat_<n>`) qu'il laisse dans le sessionStorage — seule trace visible de la page.
   */
  private async pendingSession(origin: string, items: StateItem[]): Promise<void> {
    const mark = `__grasp_etat_${++this.pendingSeq}`;
    const content = `(() => { try { if (location.origin !== ${JSON.stringify(origin)} || window.top !== window || sessionStorage.getItem(${JSON.stringify(mark)}) !== null) return; for (const it of ${JSON.stringify(items)}) sessionStorage.setItem(it.name, it.value); sessionStorage.setItem(${JSON.stringify(mark)}, '1'); } catch {} })();`;
    await this.context.addInitScript({ content });
  }

  async importState(raw: unknown): Promise<Record<string, unknown>> {
    this.stateAllowed();
    const st = parseState(raw);
    const allowed = this.policy.allowedDomains;
    const skipped: string[] = [];
    const now = Date.now() / 1000;
    let cookies = 0;
    for (const c of st.cookies) {
      const what = `cookie ${c.name} (${c.domain}${c.path})`;
      if (!cookieAllowed(allowed, c.domain)) { skipped.push(`${what} : domaine hors allowlist`); continue; }
      if (c.expires > 0 && c.expires < now) { skipped.push(`${what} : expiré`); continue; }
      try {
        await this.context.addCookies([{ name: c.name, value: c.value, domain: c.domain, path: c.path, httpOnly: c.httpOnly, secure: c.secure, ...(c.expires > 0 ? { expires: c.expires } : {}), ...(c.sameSite !== undefined ? { sameSite: c.sameSite } : {}) }]);
        cookies++;
      } catch (e) { skipped.push(`${what} : refusé par le navigateur (${firstLine(e)})`); }
    }
    let origins = 0;
    let keys = 0;
    for (const o of st.origins) {
      if (o.localStorage.length === 0) continue;
      if (!checkUrl(allowed, o.origin).allowed) { skipped.push(`localStorage de ${o.origin} : origine hors allowlist`); continue; }
      try {
        await this.inOrigin(o.origin, (items: StateItem[]) => { for (const it of items) localStorage.setItem(it.name, it.value); return items.length; }, o.localStorage);
        origins++; keys += o.localStorage.length;
      } catch (e) { skipped.push(`localStorage de ${o.origin} : ${firstLine(e)}`); }
    }
    let session: 'applied' | 'pending' | null = null;
    const ss = st.sessionStorage;
    if (ss !== undefined && ss.items.length > 0) {
      if (!checkUrl(allowed, ss.origin).allowed) skipped.push(`sessionStorage de ${ss.origin} : origine hors allowlist`);
      else if (normalizeOrigin(this.page.url()) === ss.origin) {
        await this.page.evaluate((items: StateItem[]) => { for (const it of items) sessionStorage.setItem(it.name, it.value); }, ss.items);
        session = 'applied';
      } else { await this.pendingSession(ss.origin, ss.items); session = 'pending'; }
    }
    return { ok: true, cookies, origins, localStorageKeys: keys, sessionStorage: session, skipped };
  }

  async storage(op: string, area: string, key: string, value?: string, originArg?: string): Promise<Record<string, unknown>> {
    this.stateAllowed();
    if (op !== 'get' && op !== 'set' && op !== 'rm') throw badRequest(`opération inconnue « ${op} » (get, set, rm)`);
    if (area !== 'local' && area !== 'session') throw badRequest(`stockage inconnu « ${area} » (local ou session)`);
    if (key === '' || key.length > 1000) throw badRequest('clé attendue (1 à 1000 caractères)');
    if (op === 'set' && value === undefined) throw badRequest('storage set : valeur attendue');
    const here = normalizeOrigin(this.page.url());
    let origin = here;
    if (originArg !== undefined) {
      origin = normalizeOrigin(originArg);
      if (origin === null) throw badRequest(`--origin : origine http(s) attendue (ex. https://app.exemple.com), reçu « ${originArg} »`);
      const v = await checkNavigation(this.ssrfCtx, `${origin}/`);
      if (!v.allowed) throw forbidden(`--origin refusée : ${this.advise(v.reason)}`);
    }
    if (origin === null) throw conflict('la page affichée n\'a pas d\'origine http(s) (about:blank ?) : naviguez d\'abord vers le site, ou désignez l\'origine avec --origin <url> (valeur posée avant le premier chargement)');
    if (!checkUrl(this.policy.allowedDomains, origin).allowed) throw forbidden(`origine hors allowlist : ${origin}`);
    const fn = (a: { area: string; op: string; key: string; value: string | null }) => {
      const s = a.area === 'local' ? localStorage : sessionStorage;
      const old = s.getItem(a.key);
      if (a.op === 'set') s.setItem(a.key, a.value as string); else if (a.op === 'rm') s.removeItem(a.key);
      return { value: old, existed: old !== null };
    };
    const arg = { area, op, key, value: value ?? null };
    const base = { ok: true, op, origin, area, key };
    let r: { value: string | null; existed: boolean };
    if (origin === here) r = await this.page.evaluate(fn, arg);
    else if (area === 'local') {
      try { r = await this.inOrigin(origin, fn, arg); } catch (e) { throw new GraspError(502, `localStorage de ${origin} : ${firstLine(e)}`); }
    } else {
      if (op !== 'set') throw conflict(`sessionStorage de ${origin} : propre à l'onglet, lisible seulement une fois l'origine affichée (avec --origin, seul storage set l'est : valeur appliquée au premier document de cette origine)`);
      await this.pendingSession(origin, [{ name: key, value: value! }]);
      return { ...base, pending: true };
    }
    if (op !== 'get') return { ...base, existed: r.existed };
    if (r.value !== null) r.value = this.redactor.redact(r.value);
    if (r.value !== null && r.value.length > STORAGE_GET_MAX) return { ...base, value: r.value.slice(0, STORAGE_GET_MAX), truncated: r.value.length };
    return { ...base, value: r.value };
  }

  // ---------- API HTTP du bridge (mêmes routes et mêmes formes que le bridge Chrome) ----------

  handler(info: () => Record<string, unknown>): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
    const MIME: Record<string, string> = { png: 'image/png', jpeg: 'image/jpeg' };
    return async (req, res) => {
      redactResponse(res, this.redactor);
      try {
        const url = new URL(req.url ?? '/', 'http://bridge');
        const q = url.searchParams;
        const route = `${req.method} ${url.pathname}`;
        const body = req.method === 'POST' ? await readJson(req, url.pathname === '/state/import' ? STATE_MAX_BYTES : undefined) : {};
        // Options d'action sans objet ici : refusées, jamais ignorées.
        if (optBool(body, 'console') === true) throw unsupported('--console');
        if (optBool(body, 'network') === true) throw unsupported('--network');
        if (optBool(body, 'follow') === true) throw unsupported('--follow (onglets)');
        const engine = optStr(body, 'engine');
        if (engine !== undefined) throw badRequest(`--engine ${engine} sans objet : cette session est pilotée par le moteur WebKit`);
        const opts: ActOpts = { snapDiff: optBool(body, 'snapDiff'), max: optInt(body.max, 'max'), scope: optStr(body, 'scope'), dialog: optStr(body, 'dialog'), shotOnError: optBool(body, 'shotOnError') };
        const scope = q.get('scope') ?? undefined;
        const shot = () => ({ full: optFlag(q.get('full'), 'full'), refs: optFlag(q.get('refs'), 'refs'), el: q.get('el') ?? undefined, format: q.get('format') ?? undefined, quality: optInt(q.get('quality'), 'quality'), maxWidth: optInt(q.get('maxWidth'), 'maxWidth') });
        switch (route) {
          case 'GET /health': return sendJson(res, 200, { ok: true, ...info() });
          case 'GET /policy': return sendJson(res, 200, this.policy);
          case 'GET /session-options': return sendJson(res, 200, { proxyServer: null, httpAuth: [], engine: 'webkit', ...(this.vp !== undefined ? { viewport: this.vp } : {}) });
          case 'GET /location': return sendJson(res, 200, { ...(await this.location()), lastBlocked: this.blocked });
          case 'POST /navigate': return sendJson(res, 200, await this.nav(str(body, 'url'), opts));
          case 'POST /back': return sendJson(res, 200, await this.history(-1, opts));
          case 'POST /forward': return sendJson(res, 200, await this.history(1, opts));
          case 'POST /reload': return sendJson(res, 200, await this.reload(opts));
          case 'GET /snap': {
            const boxes = q.get('boxes');
            if (boxes !== null && boxes !== '1' && boxes !== 'true') throw badRequest('« boxes » : 1 attendu');
            return sendBuffer(res, 200, 'text/plain; charset=utf-8', await this.snapText({ maxBytes: optInt(q.get('max'), 'max'), scope, nameMax: optCount(q.get('nameMax'), 'name-max'), mode: q.get('mode'), find: q.get('find'), role: q.get('role'), limit: optInt(q.get('limit'), 'max'), boxes: boxes !== null }));
          }
          case 'GET /text': {
            if (optFlag(q.get('markdown'), 'markdown') === true) throw unsupported('text --markdown');
            return sendBuffer(res, 200, 'text/plain; charset=utf-8', await this.text(optInt(q.get('max'), 'max'), scope));
          }
          case 'POST /wait': return sendJson(res, 200, await this.wait({ text: optStr(body, 'text'), sel: optStr(body, 'sel'), idle: optBool(body, 'idle'), timeout: optInt(body.timeout, 'timeout') }));
          case 'POST /expect': return sendJson(res, 200, await this.expect(expectSpecOf(body), { shotOnError: opts.shotOnError }));
          case 'POST /click': return sendJson(res, 200, await this.click(str(body, 'target'), opts));
          case 'POST /fill': {
            const su = body.secretUse as { name?: unknown; domains?: unknown } | undefined;
            if (su !== undefined && (su === null || typeof su.name !== 'string' || !Array.isArray(su.domains) || !su.domains.every((d) => typeof d === 'string'))) throw badRequest('secretUse : { name, domains } attendu');
            return sendJson(res, 200, await this.fill(str(body, 'target'), str(body, 'value'), opts, su as SecretUse | undefined));
          }
          case 'POST /hover': return sendJson(res, 200, await this.hover(str(body, 'target'), opts));
          case 'POST /type': return sendJson(res, 200, await this.type(str(body, 'target'), str(body, 'text'), { ...opts, delay: optInt(body.delay, 'delay') }));
          case 'POST /select': return sendJson(res, 200, await this.select(str(body, 'target'), str(body, 'value'), opts));
          case 'POST /check': { const c = optBool(body, 'checked'); return sendJson(res, 200, await this.check(str(body, 'target'), c === undefined ? true : c, opts)); }
          case 'POST /press': return sendJson(res, 200, await this.press(str(body, 'key'), optStr(body, 'target'), opts));
          case 'GET /screenshot': {
            if (optFlag(q.get('save'), 'save')) return sendJson(res, 200, await this.saveShot(shot()));
            const s = await this.capture(shot());
            return sendBuffer(res, 200, MIME[s.format]!, s.data, { 'x-grasp-width': String(s.width), 'x-grasp-height': String(s.height), 'x-grasp-format': s.format });
          }
          case 'GET /viewport': return sendJson(res, 200, await this.viewportInfo());
          case 'POST /viewport': {
            if (body.reset === true) {
              if (Object.keys(body).length > 1) throw badRequest('viewport : reset ne se combine avec aucune autre option');
              return sendJson(res, 200, await this.setViewport(null));
            }
            return sendJson(res, 200, await this.setViewport(viewportSpecOf(body), !['device', 'dpr', 'mobile', 'touch', 'mobileUa'].some((k) => body[k] !== undefined && body[k] !== null && body[k] !== false)));
          }
          case 'POST /eval': return sendJson(res, 200, { ok: true, ...await this.evaluate(str(body, 'expression')) });
          case 'GET /cookies': return sendJson(res, 200, await this.cookies());
          case 'POST /state/import': {
            if (body.state === undefined) throw badRequest('champ « state » (objet d\'état exporté) requis');
            for (const m of maskedOf(body.masked)) this.redactor.mask(m.label, m.value);
            return sendJson(res, 200, await this.importState(body.state));
          }
          case 'POST /storage': return sendJson(res, 200, await this.storage(str(body, 'op'), str(body, 'area'), str(body, 'key'), optStr(body, 'value'), optStr(body, 'origin')));
          // Routes du moteur Chrome absentes du mode minimal : dites, jamais « route inconnue ».
          case 'GET /console': case 'POST /console': throw unsupported('console');
          case 'GET /network': case 'POST /network': throw unsupported('network');
          case 'GET /a11y': throw unsupported('a11y');
          case 'POST /scroll': throw unsupported('scroll');
          case 'GET /pdf': throw unsupported('pdf');
          case 'POST /upload': throw unsupported('upload');
          case 'GET /state/export': throw unsupported('state export');
          case 'GET /tabs': case 'POST /tabs/select': case 'POST /tabs/new': case 'POST /tabs/close': throw unsupported('onglets (tabs, tab)');
          case 'GET /inventory': case 'POST /check-links': throw unsupported('audit et diff multi-pages');
          case 'POST /internal/durable': throw unsupported('historique rejouable (sélecteur durable)');
          default: throw new GraspError(404, `route inconnue : ${route}`);
        }
      } catch (e) { sendError(res, e); }
    };
  }
}
