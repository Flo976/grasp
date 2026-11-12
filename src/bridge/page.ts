import { AsyncLocalStorage } from 'node:async_hooks';
import { statSync } from 'node:fs';
import type { CdpClient, CdpEvent } from '../browser/cdp.js';
import { checkNavigation, checkUrl, isExplicitLocal, normalizeHost, routeOf, urlPort, type EffectivePolicy, type SsrfContext } from '../core/policy.js';
import { credentialFor, credentialLabel, hostMatches, maskCredentials, type HttpCredential, type MaskedCredential } from '../core/remote.js';
import { classifyIp, systemResolver, type Resolver } from '../core/ssrf.js';
import { GraspError, badRequest, conflict, forbidden, notFound } from '../core/errors.js';
import { DIALOGS_REPORTED_MAX, decideDialog, dialogLines, parseDialogOption, type DialogPolicy, type DialogSeen } from '../core/dialog.js';
import { ConsoleBuffer, formatArg, formatEntry, formatArgs, levelOfConsoleType, levelOfLog, redactUrl, redactUrlsIn, urlBase, type ConsoleEntry, type ConsoleQuery, type ConsoleResult, type NewEntry, type RemoteObjectLike } from '../core/console.js';
import { imageSize, type ImageFormat } from '../core/image.js';
import { DEFAULT_REQUEST_STATUS, NetworkLog, formatNet, parseRequestTarget, parseStatus, requestMatches, type NetEntry, type NetQuery, type NetResult } from '../core/network.js';
import { saveCapture } from '../core/captures.js';
import { EXPECT_DEFAULT_MS, POLLED, around, compileRegex, describeExpected, excerpt, findText, matchValue, normSpace, type ExpectSpec } from '../core/expect.js';
import { buildSnapshot, diffSnapshots, INTERACTIVE, type AXNode, type FormErrors, type Snapshot, type SnapMode, type FindSpec } from './snapshot.js';
import { parseKey } from './keys.js';
import { ACTION_GRACE_MS, ACTION_REQUEST_MS, ACTION_WINDOW_MS, DEFAULT_LIMITS, LONG_REQUEST_MS, STABLE_QUIET_MS, truncateText, type Limits } from '../core/limits.js';
import { fmtCandidate, nearest, type Candidate } from './match.js';
import { TrackerList } from './trackers.js';
import { STATE_FORMAT, STATE_VERSION, cookieAllowed, cookieOrigin, fromCdpCookie, normalizeOrigin, parseState, toCdpCookieParam, type CdpCookie, type GraspState, type StateItem } from '../core/state.js';
import { MARKDOWN_FN, SCOPE_MARKDOWN_FN, markdownInPage } from './markdown.js';
import { SCROLL_BUDGET_MS, SCROLL_FN, SCROLL_STEPS_DEFAULT, scrollNote, type ScrollMeasure, type ScrollReport, type ScrollSpec } from './scroll.js';
import { describeViewport, mobileUserAgent, type ViewportSpec } from '../core/viewport.js';
import { Redactor, secretAllowedOn, type SecretUse } from '../core/secrets.js';
import { A11Y_DEFAULT_MAX, A11Y_DESC_FN, A11Y_DOM_FN, A11Y_KINDS, A11Y_MAX, A11Y_NOTE, axIssues, domIssue, imageFix, renderA11y, scopeNodes, type A11yIssue, type A11yKind, type A11yReport, type DomItem, type RawIssue } from './a11y.js';
import { CHECK_LINKS_MAX, INVENTORY_FN, checkLinksFn, splitLinks, type Inventory, type LinkCheck } from './inventory.js';
import { PlaywrightEngine, PW_ACTION_TIMEOUT_MS, PW_FALLBACK_TIMEOUT_MS, PW_IDLE_MS, parseFrameTarget, playwrightKey, pwError, type PwLocator, type PwPage } from './playwright.js';

export interface ActionOptions {
  snapDiff?: boolean | undefined;
  /** Limite de la sortie --snap-diff, en caractères (défaut : `diffMax`). */
  max?: number | undefined;
  /** Zone du --snap-diff (ref, CSS ou text:) : seuls ses nœuds sont comparés. */
  scope?: string | undefined;
  /** Renvoie les entrées console produites pendant l'action. */
  console?: boolean | undefined;
  /** En cas d'échec, capture du viewport ; son chemin est ajouté au message d'erreur. */
  shotOnError?: boolean | undefined;
  /** Moteur de l'action : « native » (CDP direct, défaut) ou « playwright » (repli optionnel). frame= impose Playwright. */
  engine?: string | undefined;
  /** Réponse aux dialogues ouverts pendant l'action : accept, dismiss, ou texte d'un prompt (défaut : sûr, voir dialog.ts). */
  dialog?: string | undefined;
  /** Renvoie les requêtes réseau parties pendant l'action (journal réseau, exige allowConsole). */
  network?: boolean | undefined;
  /** Historique (control plane) : sélecteur de la cible à décrire pendant la résolution (`target` du résultat). */
  describeTarget?: string | undefined;
  /** Onglets : bascule sur l'onglet (popup, target=_blank) ouvert par l'action (voir tabs.ts). */
  follow?: boolean | undefined;
}

/** Cible CDP rapportée par Target.attachedToTarget (openerId : onglet qui l'a ouverte). */
export interface TargetInfo { targetId: string; type: string; url?: string; openerId?: string }

/**
 * Coordination des onglets d'un même navigateur : un PageController par onglet, sur UNE connexion CDP. Chaque
 * événement d'une session va au contrôleur qui la possède (onglet, iframes hors processus, onglets d'état) ; les
 * événements du navigateur et des sessions sans propriétaire vont au contrôleur « meneur » (le premier, puis le
 * suivant s'il est fermé), qui garde les nouvelles cibles et les confie à `adopt` (tabs.ts) quand c'est un onglet.
 */
export class TabHub {
  readonly pages = new Set<PageController>();
  lead: PageController | undefined;
  /** Cibles auto-attachées pendant la création d'un onglet d'état : targetId → session prête (gardée, relancée). */
  readonly attaching = new Map<string, Promise<string>>();
  /** Création de cible en cours (sérialisée) : distingue l'onglet d'état d'export/import d'un onglet à adopter. */
  creating: 'scratch' | 'tab' | undefined;
  /**
   * Cibles que Grasp attache lui-même (Target.attachToTarget : `tab new` et onglet d'état en mode attach). Leur
   * Target.attachedToTarget n'est pas celui d'un onglet de l'utilisateur : le meneur ne doit pas les détacher.
   */
  readonly claimed = new Set<string>();
  private lock: Promise<unknown> = Promise.resolve();
  /** Popups refusés (plafond) : toutes leurs requêtes échouent, le temps de les relancer puis de les fermer. */
  readonly denied = new Set<string>();
  /** Nouvel onglet (popup, target=_blank, tab new) en pause : adopté (gardé, piloté) → true ; sinon garde seule. */
  adopt: ((sessionId: string, info: TargetInfo, waiting: boolean) => Promise<boolean>) | undefined;
  /** Ref remise par un snapshot d'un AUTRE onglet que `self` : { tab: cet onglet, here: l'onglet de `self` }. */
  refElsewhere: ((ref: string, self: PageController) => { tab: string; here: string } | undefined) | undefined;

  ownerOf(sessionId: string): PageController | undefined {
    for (const p of this.pages) if (p.owns(sessionId)) return p;
    return undefined;
  }

  ownsTarget(targetId: string): boolean {
    for (const p of this.pages) if (p.target === targetId) return true;
    return false;
  }

  /** Événement pour `pc` ? Session possédée par lui, ou (navigateur, session sans propriétaire) s'il mène. */
  routes(pc: PageController, sessionId: string | undefined): boolean {
    const owner = sessionId !== undefined ? this.ownerOf(sessionId) : undefined;
    return owner !== undefined ? owner === pc : this.lead === pc;
  }

  /** Création de cible sérialisée : l'événement d'attachement (qui précède la réponse) sait de quoi il s'agit. */
  creation<T>(kind: 'scratch' | 'tab', fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(async () => {
      this.creating = kind;
      try { return await fn(); } finally { this.creating = undefined; }
    });
    this.lock = run.catch(() => undefined);
    return run;
  }
}

/** Cible décrite pour l'historique : sélecteur durable (absent = ref non traduite), rôle, nom, champ secret. */
export interface DurableTarget { given: string; durable?: string; how?: 'text' | 'css' | 'given'; role?: string; name?: string; note?: string; secret: boolean | null }

/** Moteur Playwright du bridge (voir playwright.ts). */
export interface EngineConfig {
  /** URL WebSocket DevTools du navigateur ; absente : moteur Playwright indisponible. */
  devtoolsUrl?: string | undefined;
  /** fallbackEngine de la config : rejeu automatique des clics natifs non livrés ou non actionnables. */
  fallback?: 'none' | 'playwright' | undefined;
  /** Module chargé (défaut : playwright-core, ou GRASP_PLAYWRIGHT_MODULE). */
  module?: string | undefined;
  idleMs?: number | undefined;
  /** Navigateur sur le même système de fichiers (upload par chemin) ; false : chrome.exe, mode attach. */
  isLocal?: boolean | undefined;
}
/**
 * Console d'une action (--console) : `since` = seq de départ, `omitted` = lignes plus anciennes écartées
 * (200 au plus sont jointes), `dropped` = entrées tombées du tampon circulaire. Jamais de perte silencieuse.
 */
export interface ConsoleSlice { entries: ConsoleEntry[]; seq: number; since: number; omitted: number; dropped: number }
/**
 * Journal réseau d'une action (--network) : requêtes parties depuis `since` (celles encore en vol : « en cours »),
 * 100 au plus (les plus récentes) ; `omitted` et `dropped` comme pour la console.
 */
export interface NetworkSlice { entries: NetEntry[]; seq: number; since: number; omitted: number; dropped: number }
/** `trackersBlocked` : requêtes vers des traqueurs annulées pendant l'action (absent si aucune). */
export interface ActionResult { ok: true; diff?: string; detail?: string; console?: ConsoleSlice; network?: NetworkSlice; trackersBlocked?: number; dialogs?: DialogSeen[]; dialogsOmitted?: number; target?: DurableTarget }
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
/** Viewport : réglage de Grasp (null = natif) et mesures lues dans la page. */
export interface ViewportResult {
  ok: true; viewport: ViewportSpec | null; description?: string; detail?: string;
  measured?: { width: number; height: number; dpr: number; touchPoints: number; pointer: string; mobileUa: boolean };
}
export interface Shot { data: Buffer; width: number; height: number; format: ImageFormat; truncated?: boolean }
export interface SavedShot { path: string; width: number; height: number; bytes: number; format: ImageFormat; truncated?: boolean }

/** Bilan d'un export d'état (sur stderr côté CLI) : rien d'écarté en silence. */
export interface StateExportReport {
  cookies: number; cookiesExcluded: number; origins: string[]; originsExcluded: string[];
  localStorageKeys: number; sessionStorage: string | null; errors: string[];
}
/** `sessionStorage` : applied = onglet déjà sur l'origine ; pending = appliqué au premier document de l'origine. */
export interface StateImportResult {
  ok: true; cookies: number; origins: number; localStorageKeys: number;
  sessionStorage: 'applied' | 'pending' | null; skipped: string[];
}

export interface WaitOptions { text?: string | undefined; sel?: string | undefined; idle?: boolean | undefined; timeout?: number | undefined }
export interface ExpectResult { ok: true; kind: string; waited: number; detail?: string }
export interface WaitResult { ok: true; waited: number; condition: 'text' | 'sel' | 'idle' }
/**
 * Résultat d'une attente de stabilité (DOM et réseau). `error` : l'attente elle-même a échoué (jamais
 * silencieux). `requests` : requêtes encore en vol au plafond. `challenge` : page de challenge anti-bot
 * toujours affichée (aucune redirection dans le plafond). `ongoing` : stable « suffisamment » — le document est
 * chargé, le réseau calme, seules des mutations de faible ampleur continuent (carrousel, minuterie).
 */
interface Stability { stable: boolean; ms: number; mutations: number; error?: string; requests?: number; challenge?: boolean; ongoing?: boolean; background?: boolean }
/**
 * Options de l'attente de stabilité : `since` = seules les requêtes parties depuis cet instant comptent ;
 * `until` (action) = fin de la fenêtre d'attribution : une requête partie après ne compte que si elle
 * s'enchaîne à une requête comptée (partie dans les CHAIN_MS après sa fin) — un polling de fond n'est pas
 * une réaction de la page à l'action.
 */
interface StableOptions { since?: number; until?: number; challenge?: boolean }

/** Requête suivie par l'attente de stabilité. `periodic` : répétition régulière d'une même requête (polling). */
interface TrackedRequest { start: number; end?: number; periodic: boolean }

/** Requête partie au plus tant de ms après la fin d'une requête comptée : sa suite (chaîne de requêtes). */
const CHAIN_MS = 250;

/**
 * Types de requêtes attendus par l'attente de stabilité : celles qui peuvent changer l'arbre d'accessibilité
 * (document, XHR, fetch, script). Images, polices, feuilles de style, médias, balises de mesure (Ping) et flux
 * permanents (EventSource, WebSocket) n'en font pas partie : sinon une page chargée d'images irait au plafond.
 */
const TRACKED_REQUESTS = new Set(['Document', 'XHR', 'Fetch', 'Script']);

/**
 * Page de challenge anti-bot (Cloudflare, AWS WAF de Booking, DataDome…) : elle se remplace d'elle-même par la
 * vraie page (location.replace) après quelques secondes ; l'attente de stabilité guette cette navigation.
 * Renvoie 'strong' : marqueur propre à un service anti-bot (titre « Just a moment… », #challenge-running,
 * _cf_chl_opt, challenge-platform, awswaf, captcha-delivery…) → attente jusqu'au plafond, et c'est dit ;
 * 'weak' : page très courte SANS champ de saisie, aux mots ou classes évocateurs → attente courte
 * (WEAK_CHALLENGE_MS), sans note ; '' sinon. Une page de connexion avec reCAPTCHA et « Veuillez patienter »
 * n'est pas un challenge : elle a des champs. textContent (sans mise en page) est mesuré avant innerText.
 */
const CHALLENGE_FN = `function () {
  const body = document.body;
  const raw = body ? body.textContent || '' : '';
  if (raw.length > 20000) return '';
  const title = (document.title || '').trim();
  const strongTitle = /^(just a moment|un instant|un moment|einen moment|un momento|attention required|checking your browser|verifying you are human|pardon our interruption|ddos-guard)/i.test(title);
  const strongMark = !!document.querySelector('#challenge-running, #challenge-stage, #challenge-form, #challenge-body-text, #cf-challenge-running, form[action*="__cf_chl"], script[src*="/cdn-cgi/challenge-platform/"], script[src*="awswaf"], script[src*="captcha-delivery"], iframe[src*="captcha-delivery"], script[src*="/_Incapsula_Resource"]')
    || [...document.scripts].slice(0, 30).some((s) => !s.src && /_cf_chl_opt|AwsWafIntegration/.test(s.textContent.slice(0, 4000)));
  const short = raw.replace(/\\s+/g, ' ').trim().length <= 2000;
  if (short && (strongTitle || strongMark)) return 'strong';
  if (raw.length > 3000) return '';
  if (document.querySelector('input:not([type=hidden]), textarea, select, [contenteditable=""], [contenteditable="true"]')) return '';
  const t = (body ? body.innerText : '').trim();
  if (t.length > 600) return '';
  const words = /just a moment|un (instant|moment)\\b|checking (your|if)|v[ée]rification|verify(ing)? (you|that)|are you (a )?human|[êe]tes[- ]vous (un )?humain|security check|please wait|veuillez patienter/i;
  if (words.test(title + ' ' + t.slice(0, 400))) return 'weak';
  return document.querySelector('[id*="challenge" i], [class*="challenge" i], meta[http-equiv="refresh" i], iframe[src*="captcha" i]') ? 'weak' : '';
}`;
/** Indice faible de challenge : attente de sa redirection bornée à ce délai, sans note. */
const WEAK_CHALLENGE_MS = 1500;

interface Box { x: number; y: number; width: number; height: number }
interface CallFrame { functionName: string; url: string; lineNumber: number; columnNumber: number }

const FORMATS = new Set(['png', 'jpeg', 'webp']);
/** Limite de texture de Chrome : au-delà, une capture pleine page est tronquée (et signalée). */
const MAX_CAPTURE_PX = 16_384;
/** Entrées console renvoyées au plus avec une action (--console). */
const ACTION_CONSOLE_LIMIT = 200;
/** Requêtes renvoyées au plus avec une action (--network) : une page qui se charge en lance des centaines. */
const ACTION_NETWORK_LIMIT = 100;
const OVERLAY_COLOR = 'rgb(255, 0, 170)';
/** wait --text / --sel : délai par défaut et maximum (le client HTTP abandonne à 120 s). */
const WAIT_DEFAULT_MS = 10_000;
const WAIT_MAX_MS = 60_000;
/** refs déjà remises à l'agent (ref → rôle, nom), pour retrouver un élément re-rendu. */
const KNOWN_REFS_MAX = 50_000;

/**
 * Stabilité du DOM, exécutée dans un monde isolé (code fixe de Grasp, autorisé même si allowEval=false) :
 * résout quand aucune mutation n'a eu lieu pendant `quiet` ms, ou au plafond `cap`. Seules les mutations
 * qui changent l'arbre d'accessibilité comptent (structure, texte, attributs ARIA/visibilité) : les
 * animations (style, class) d'un carrousel ne doivent pas faire attendre 5 s à chaque page.
 *
 * Stabilité « suffisante » (`lenient` ms, 0 = jamais) : une page qui ne se tait jamais (carrousels, minuteries
 * d'Amazon) rend la main après `lenient` ms si le document est chargé et que la dernière seconde n'a vu que des
 * mutations de faible ampleur : au plus LENIENT_ADDED éléments ajoutés (descendants compris) et LENIENT_TARGETS
 * cibles distinctes, et soit un poids (nœuds touchés) d'au plus LENIENT_TINY, soit d'au plus LENIENT_WEIGHT
 * dont 80 % sur des cibles déjà touchées (une animation qui tourne, pas un rendu qui avance). Un gros contenu
 * ajouté (liste rendue, résultats) dépasse ces seuils : il est attendu. Résultat `ongoing: true`.
 */
const LENIENT_ADDED = 10;
const LENIENT_TARGETS = 30;
const LENIENT_TINY = 40;
const LENIENT_WEIGHT = 200;
/** Délai (depuis le début de l'observation du DOM) après lequel la stabilité « suffisante » est admise. */
const STABLE_LENIENT_MS = 1000;
/** Champs de saisie : un remplaçant peut changer de rôle entre eux (searchbox → combobox de Wikipédia). */
const TEXT_FIELD_ROLES = new Set(['textbox', 'searchbox', 'combobox']);
/** Note d'une stabilité « suffisante » : courte, la page est utilisable. */
const ONGOING_NOTE = 'animations continues ignorées';
/**
 * Requêtes de fond (mesures d'audience, publicités d'Amazon : chemins toujours différents, rythme irrégulier, donc
 * pas reconnues comme polling) : si le DOM reste calme pendant NET_BACKGROUND_MS alors que seul le réseau s'agite,
 * la page est jugée stable. Un rendu qui suit une chaîne de requêtes plus longue que ce délai sans toucher au DOM
 * peut être manqué : `grasp wait --text|--sel` reste le recours.
 */
const NET_BACKGROUND_MS = 1000;
const BACKGROUND_NOTE = 'requêtes de fond ignorées';
const STABLE_FN = `function (quiet, cap, lenient) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    let last = t0, n = 0;
    const log = [];
    const seen = new Set();
    const obs = new MutationObserver((recs) => {
      n += recs.length; last = performance.now();
      if (!lenient) return;
      for (const r of recs) {
        let w = 1, added = 0;
        if (r.type === 'childList') {
          w = r.addedNodes.length + r.removedNodes.length;
          for (const a of r.addedNodes) if (a.nodeType === 1) added += 1 + Math.min(1000, a.getElementsByTagName('*').length);
        }
        const t = r.type === 'characterData' ? r.target.parentNode : r.target;
        log.push({ at: last, t, w: w + added, added, seen: seen.has(t) });
        seen.add(t);
      }
      while (log.length > 2000) log.shift();
    });
    obs.observe(document, { subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ['hidden', 'aria-hidden', 'aria-expanded', 'aria-label', 'aria-busy', 'aria-checked', 'aria-selected', 'role', 'disabled', 'open'] });
    const minor = (now) => {
      if (document.readyState !== 'complete') return false;
      let w = 0, added = 0, again = 0;
      const targets = new Set();
      for (const e of log) {
        if (e.at < now - 1000) continue;
        w += e.w; added += e.added; targets.add(e.t); if (e.seen) again += e.w;
      }
      if (added > ${LENIENT_ADDED} || targets.size > ${LENIENT_TARGETS}) return false;
      return w <= ${LENIENT_TINY} || (w <= ${LENIENT_WEIGHT} && again >= 0.8 * w);
    };
    const tick = () => {
      const now = performance.now();
      if (now - last >= quiet) { obs.disconnect(); resolve({ stable: true, mutations: n }); }
      else if (lenient > 0 && now - t0 >= lenient && minor(now)) { obs.disconnect(); resolve({ stable: true, mutations: n, ongoing: true }); }
      else if (now - t0 >= cap) { obs.disconnect(); resolve({ stable: false, mutations: n }); }
      else setTimeout(tick, Math.max(10, Math.min(50, quiet - (now - last))));
    };
    setTimeout(tick, Math.min(50, quiet));
  });
}`;

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

/**
 * Sonde de livraison des entrées, armée dans le monde isolé (code fixe de Grasp, autorisé même si
 * allowEval=false) : écouteurs en capture sur window qui comptent les événements de confiance (isTrusted)
 * et synthétiques, et MutationObserver (effet observable d'un repli synthétique). `at` : point du clic
 * (hit-test) ou focus (touche, saisie) ; renvoie la balise touchée, pour reconnaître un cadre (iframe) dont
 * les événements n'arrivent jamais à cette fenêtre.
 */
const PROBE_ARM_FN = `function (types, token, at) {
  const prev = globalThis.__graspProbe; if (prev) prev.stop();
  const p = { token, trusted: 0, synthetic: 0, mutations: 0 };
  const on = (e) => { if (e.isTrusted) p.trusted++; else p.synthetic++; };
  for (const t of types) addEventListener(t, on, true);
  const mo = new MutationObserver((r) => { p.mutations += r.length; });
  mo.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
  p.stop = () => { for (const t of types) removeEventListener(t, on, true); mo.disconnect(); };
  globalThis.__graspProbe = p;
  const hit = at === null ? document.activeElement : document.elementFromPoint(at.x, at.y);
  return hit ? hit.nodeName : null;
}`;
const PROBE_READ_FN = `function (token) {
  const p = globalThis.__graspProbe;
  return p && p.token === token ? { trusted: p.trusted, synthetic: p.synthetic, mutations: p.mutations } : null;
}`;
const PROBE_STOP_FN = `function (token) {
  const p = globalThis.__graspProbe;
  if (p && p.token === token) { p.stop(); delete globalThis.__graspProbe; }
  return true;
}`;
/** Repli d'un clic : séquence pointeur/souris puis el.click() sur l'élément, depuis le monde isolé (isTrusted=false). */
const SYNTH_CLICK_FN = `function (x, y) {
  const el = this.nodeType === 1 ? this : this.parentElement;
  const o = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, view: window };
  const p = { pointerId: 1, isPrimary: true, pointerType: 'mouse' };
  el.dispatchEvent(new PointerEvent('pointerdown', { ...o, ...p, buttons: 1 }));
  el.dispatchEvent(new MouseEvent('mousedown', { ...o, buttons: 1 }));
  if (typeof el.focus === 'function') el.focus({ preventScroll: true });
  el.dispatchEvent(new PointerEvent('pointerup', { ...o, ...p, buttons: 0 }));
  el.dispatchEvent(new MouseEvent('mouseup', { ...o, buttons: 0 }));
  el.click();
  return true;
}`;
/**
 * Repli d'une touche, sur l'élément qui a le focus : keydown/keypress/keyup synthétiques, et l'action par
 * défaut qu'un événement synthétique ne déclenche pas : Entrée = soumission implicite du formulaire
 * (requestSubmit) ou activation d'un bouton/lien ; Espace = activation ; caractère = insertion.
 */
const SYNTH_KEY_FN = `function (key, code, keyCode, text, mods) {
  const el = document.activeElement || document.body;
  const o = { key, code, keyCode, which: keyCode, bubbles: true, cancelable: true, composed: true, altKey: !!(mods & 1), ctrlKey: !!(mods & 2), metaKey: !!(mods & 4), shiftKey: !!(mods & 8) };
  const go = el.dispatchEvent(new KeyboardEvent('keydown', o));
  if (go && text) el.dispatchEvent(new KeyboardEvent('keypress', { ...o, charCode: text.charCodeAt(0) }));
  if (go && !o.altKey && !o.ctrlKey && !o.metaKey) {
    const tag = el.nodeName, type = (el.type || '').toLowerCase();
    const activable = tag === 'BUTTON' || tag === 'SUMMARY' || (tag === 'INPUT' && ['submit', 'button', 'reset', 'image'].includes(type));
    if (key === 'Enter') {
      if (tag === 'A' && el.href) el.click();
      else if (activable) el.click();
      else if (tag === 'INPUT' && el.form) el.form.requestSubmit();
    } else if (key === ' ' && (activable || (tag === 'INPUT' && (type === 'checkbox' || type === 'radio')))) el.click();
    else if (text && (el.isContentEditable || tag === 'TEXTAREA' || tag === 'INPUT')) document.execCommand('insertText', false, text);
  }
  el.dispatchEvent(new KeyboardEvent('keyup', o));
  return true;
}`;
/** Repli d'un survol : pointerover/mouseover/mouseenter/mousemove sur l'élément, depuis le monde isolé (isTrusted=false). */
const SYNTH_HOVER_FN = `function (x, y) {
  const el = this.nodeType === 1 ? this : this.parentElement;
  const o = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window };
  el.dispatchEvent(new PointerEvent('pointerover', { ...o, pointerId: 1, isPrimary: true, pointerType: 'mouse' }));
  el.dispatchEvent(new MouseEvent('mouseover', o));
  el.dispatchEvent(new MouseEvent('mouseenter', { ...o, bubbles: false }));
  el.dispatchEvent(new MouseEvent('mousemove', o));
  return true;
}`;
/** Repli d'une saisie : setter natif de value + input (contenteditable : un paragraphe par ligne, texte brut). */
const SYNTH_FILL_FN = `function (v) {
  if (this.isContentEditable) {
    let h = this.nodeType === 1 ? this : this.parentElement;
    while (h.parentElement && h.parentElement.isContentEditable) h = h.parentElement;
    const lines = v.split('\\n');
    if (lines.length < 2) h.textContent = v;
    else h.replaceChildren(...lines.map((l) => { const p = document.createElement('p'); if (l === '') p.append(document.createElement('br')); else p.textContent = l; return p; }));
    h.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: v }));
    return true;
  }
  const p = this instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(p, 'value').set.call(this, v);
  this.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}`;

/** fill sur un contenteditable : sélectionne TOUT le contenu de l'hôte d'édition (pas seulement le bloc visé). */
const SELECT_EDITABLE_FN = `function () {
  let h = this.nodeType === 1 ? this : this.parentElement;
  while (h.parentElement && h.parentElement.isContentEditable) h = h.parentElement;
  if (document.activeElement !== h && typeof h.focus === 'function') h.focus();
  const r = document.createRange(); r.selectNodeContents(h);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  return true;
}`;

/**
 * Après suppression du contenu d'un contenteditable : le bloc restant garde son format (titre, liste,
 * citation…) et le curseur ses styles (gras…) — le texte inséré en hériterait. Commandes d'édition natives
 * (beforeinput formatBlock / insert*List, que les éditeurs riches interceptent ou observent) : bloc ramené
 * à un paragraphe, styles de caractère désactivés. Renvoie les formats retirés.
 */
const PLAIN_FORMAT_FN = `function () {
  let h = this.nodeType === 1 ? this : this.parentElement;
  while (h.parentElement && h.parentElement.isContentEditable) h = h.parentElement;
  const out = [];
  const blockAt = () => {
    let n = getSelection().anchorNode;
    if (n && n.nodeType !== 1) n = n.parentElement;
    for (; n && n !== h && h.contains(n); n = n.parentElement) if (/^(H[1-6]|LI|BLOCKQUOTE|PRE)$/.test(n.nodeName)) return n;
    return null;
  };
  for (let i = 0; i < 4; i++) {
    const b = blockAt();
    if (!b) break;
    out.push(b.nodeName);
    if (b.nodeName === 'LI') document.execCommand(b.parentElement && b.parentElement.nodeName === 'OL' ? 'insertOrderedList' : 'insertUnorderedList');
    else document.execCommand('formatBlock', false, 'p');
  }
  for (const c of ['bold', 'italic', 'underline', 'strikeThrough']) {
    try { if (document.queryCommandState(c)) { document.execCommand(c); out.push(c); } } catch (e) { /* commande inconnue */ }
  }
  return out;
}`;

/**
 * innerText d'une zone (text --scope). Iframe : texte de son document s'il est accessible (même origine),
 * sinon { frame, src } — jamais une chaîne vide muette (l'innerText d'une <iframe> est toujours vide).
 */
const SCOPE_TEXT_FN = `function () {
  const el = this.nodeType === 1 ? this : this.parentElement;
  if (!el) return { text: this.textContent || '' };
  if (el.nodeName === 'IFRAME' || el.nodeName === 'FRAME') {
    let doc = null;
    try { doc = el.contentDocument; } catch (e) { doc = null; }
    if (doc) return { text: doc.body ? doc.body.innerText : '', frame: true };
    return { frame: true, src: el.src || el.getAttribute('src') || '' };
  }
  return { text: el.innerText };
}`;

/**
 * Erreurs de formulaire relevées dans le DOM, sous `root` (document ou élément) — ce que l'arbre
 * d'accessibilité ne dit pas. Relevé sur Malt (Vue « joy ») : champ sans aucun aria-*, seule la classe
 * `joy-input--field-invalid` ; message dans un `div role="alert" aria-hidden="true"` (absent de l'arbre).
 * Pour chaque champ visible : invalide si aria-invalid ou :user-invalid ; message par aria-errormessage,
 * aria-describedby (les éléments d'allure « erreur » en priorité), validationMessage, ou message
 * d'erreur visible non relié (classe/id error|invalid|erreur, role=alert, aria-live=assertive) trouvé
 * en remontant au plus 4 ancêtres. Un champ seulement marqué par une classe « invalid » sans message
 * visible est ignoré (Angular met ng-invalid sur un champ vierge). Messages aria-hidden rattachés à
 * aucun champ : `alerts`. Retour : { meta (JSON), els (champs, indexés par meta.fields[].i) }.
 */
const FORM_ERRORS_FN = `function (root) {
  const scope = root.nodeType === 9 ? root.documentElement : (root.nodeType === 1 ? root : root.parentElement);
  const doc = scope.ownerDocument;
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const shown = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none';
  };
  const ERR = /(^|[^a-z])(err|errors?|invalid|erreurs?)([^a-z]|$)/i;
  const cls = (el) => (typeof el.className === 'string' ? el.className : (el.getAttribute('class') || ''));
  const errorish = (el) => ERR.test(cls(el)) || ERR.test(el.id || '') || el.getAttribute('role') === 'alert' || el.getAttribute('aria-live') === 'assertive';
  const FIELD = 'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]),textarea,select,[contenteditable=""],[contenteditable="true"],[role=textbox],[role=combobox],[role=searchbox],[role=spinbutton],[role=checkbox],[role=radio],[role=switch],[role=listbox],[role=slider]';
  const fields = [...scope.querySelectorAll(FIELD)].slice(0, 3000).filter(shown);
  const refs = (el, a) => norm(el.getAttribute(a)).split(' ').filter(Boolean).map((id) => doc.getElementById(id)).filter(Boolean);
  const ariaInvalid = (f) => { const v = f.getAttribute('aria-invalid'); return v !== null && v !== 'false'; };
  const userInvalid = (f) => { try { return f.matches(':user-invalid'); } catch (e) { return false; } };
  const recs = new Map();
  // Source du message (audit a11y) : errormessage, describedby, native, voisin (message visible NON relié), ou
  // decrit (message trouvé à côté, relié par aria-describedby, mais champ ni aria-invalid ni :user-invalid).
  const how = new Map();
  const used = [];
  for (const f of fields) {
    const strong = ariaInvalid(f) || userInvalid(f);
    let msg = '';
    for (const el of refs(f, 'aria-errormessage')) if (shown(el) && norm(el.innerText)) { msg = norm(el.innerText); used.push(el); how.set(f, 'errormessage'); break; }
    if (!msg && strong) {
      const ds = refs(f, 'aria-describedby').filter((el) => shown(el) && norm(el.innerText));
      const errs = ds.filter(errorish);
      const pick = errs.length ? errs : ds;
      if (pick.length) { msg = pick.map((el) => norm(el.innerText)).join(' '); used.push(...pick); how.set(f, 'describedby'); }
    }
    if (!msg && userInvalid(f) && f.validationMessage) { msg = norm(f.validationMessage); how.set(f, 'native'); }
    if (strong || msg) recs.set(f, msg);
  }
  const cands = [...scope.querySelectorAll('[role=alert],[aria-live=assertive],[class*=err i],[class*=invalid i],[id*=err i],[id*=invalid i]')].slice(0, 500)
    .filter((el) => !el.matches(FIELD) && errorish(el) && !el.querySelector(FIELD + ',button,a[href]') && shown(el));
  const outer = cands.filter((el) => !cands.some((o) => o !== el && o.contains(el)));
  const alerts = [];
  for (const m of outer) {
    const t = norm(m.innerText);
    if (!t || t.length > 300 || used.some((u) => u.contains(m) || m.contains(u))) continue;
    let field = null;
    let a = m.parentElement;
    for (let k = 0; k < 4 && a && !field; k++, a = a.parentElement) {
      const inside = fields.filter((f) => a.contains(f));
      if (inside.length === 1) field = inside[0];
      else if (inside.length > 1) {
        const prev = inside.filter((f) => f.compareDocumentPosition(m) & Node.DOCUMENT_POSITION_FOLLOWING);
        field = prev.length ? prev[prev.length - 1] : null;
        break;
      }
    }
    if (field && !recs.get(field) && (recs.has(field) || ERR.test(cls(field)) || ERR.test(cls(m)))) {
      // Relié malgré tout (aria-describedby lu seulement pour un champ invalide, plus haut) : le défaut est l'état.
      const linked = refs(field, 'aria-describedby').some((el) => el.contains(m) || m.contains(el));
      recs.set(field, t); used.push(m); how.set(field, linked ? 'decrit' : 'voisin');
    }
    else if (!field && m.closest('[aria-hidden="true"]')) alerts.push(t);
  }
  const els = [];
  const metaFields = [];
  for (const [f, t] of recs) { if (els.length >= 100) break; metaFields.push({ i: els.length, t: t.slice(0, 300), s: how.get(f) || '' }); els.push(f); }
  return { meta: JSON.stringify({ fields: metaFields, alerts: alerts.slice(0, 20) }), els };
}`;

/**
 * Textes DOM mis en forme par text-transform (au plus 2000, sur 50 000 nœuds texte parcourus) : JSON de
 * [texte affiché, texte source]. Un seul appel, sans describeNode par nœud : le rapprochement avec l'arbre se
 * fait par contenu (voir sourceTexts). Texte affiché ambigu (deux sources, ou présent tel quel ailleurs sans
 * transformation) : écarté, jamais deviné.
 */
const SOURCE_TEXTS_FN = `function () {
  const sp = (t) => t.replace(/\\s+/g, ' ').trim();
  const apply = (t, tt) => tt === 'uppercase' ? t.toUpperCase() : tt === 'lowercase' ? t.toLowerCase() : t.replace(/(^|\\s)(\\p{L})/gu, (m, a, c) => a + c.toUpperCase());
  const shown = new Map();
  const plain = new Set();
  const style = new Map();
  const root = document.body || document.documentElement;
  if (!root) return '[]';
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n;
  let seen = 0;
  while ((n = tw.nextNode()) && shown.size < 2000 && seen++ < 50000) {
    const p = n.parentElement;
    if (!p || !n.data.trim()) continue;
    let tt = style.get(p);
    if (tt === undefined) { tt = getComputedStyle(p).textTransform || 'none'; style.set(p, tt); }
    const src = sp(n.data);
    if (tt !== 'uppercase' && tt !== 'lowercase' && tt !== 'capitalize') { if (src.length < 200) plain.add(src); continue; }
    const t = sp(apply(src, tt));
    const prev = shown.get(t);
    shown.set(t, prev === undefined || prev === src ? src : null);
  }
  const out = [];
  for (const [t, src] of shown) if (src !== null && src !== t && !plain.has(t)) out.push([t, src]);
  return JSON.stringify(out);
}`;

/** Élément d'une ref absente du snapshot : '' retiré, 'modal' hors de la modale ouverte, 'hidden' sous aria-hidden/inert, 'present' sinon. */
const MASKED_FN = `function () {
  const el = this.nodeType === 1 ? this : this.parentElement;
  if (!el || !el.isConnected) return '';
  const isModal = (m) => {
    if (m.localName === 'dialog') { try { if (m.matches(':modal')) return true; } catch (e) {} }
    return m.getAttribute('aria-modal') === 'true' && m.getClientRects().length > 0;
  };
  const modals = [...document.querySelectorAll('dialog[open], [aria-modal=true]')].filter(isModal);
  if (modals.length > 0 && !modals.some((m) => m.contains(el))) return 'modal';
  if (el.closest('[aria-hidden=true], [inert]')) return 'hidden';
  return 'present';
}`;

/** Conteneur de formulaire d'un bouton cliqué (form, dialogue) ; null si l'élément n'est pas un bouton. */
const BUTTON_FORM_FN = `function () {
  const el = this.nodeType === 1 ? this : this.parentElement;
  const b = el && el.closest('button, input[type=submit], input[type=button], input[type=image], [role=button]');
  if (!b) return null;
  return b.form || b.closest('form, dialog, [role=dialog], [role=alertdialog], [aria-modal=true]') || b.ownerDocument.body;
}`;

/** Valeur d'un champ (value ; select : valeur de l'option choisie), sinon texte de l'élément (contenteditable…). */
const VALUE_FN = `function () {
  const el = this.nodeType === 1 ? this : this.parentElement;
  if (!el) return '';
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return String(el.value);
  return String(el.isContentEditable ? el.innerText : el.textContent || '').replace(/\\s+/g, ' ').trim();
}`;
/** Texte lu par expect text / no-text (au-delà, la fin de la page n'est pas examinée). */
const EXPECT_TEXT_MAX = 2_000_000;

const CLICK_EVENTS = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
const HOVER_EVENTS = ['pointerover', 'pointermove', 'mouseover', 'mousemove'];
const KEY_EVENTS = ['keydown', 'keyup', 'keypress', 'beforeinput', 'input'];
/** Champs que la frappe ne remplit pas : valeur posée par le setter natif, sans vérification de livraison. */
const SETTER_ONLY_INPUTS = new Set(['date', 'time', 'datetime-local', 'month', 'week']);
/** Balises dont les événements partent vers un autre document : livraison non vérifiable depuis cette fenêtre. */
const FRAME_TAGS = new Set(['IFRAME', 'FRAME', 'OBJECT', 'EMBED', 'FENCEDFRAME', 'PORTAL']);
const NO_CHANGE = '(aucun changement)';

/**
 * Marqueur data-grasp-pw (moteur Playwright) posé sur l'élément, ou sur le parent d'un nœud texte ; renvoie
 * alors le centre du (premier fragment du) texte relatif à la boîte du parent, comme le point du clic natif.
 */
const TAG_FN = `function (t) {
  const el = this.nodeType === 1 ? this : this.parentElement;
  el.setAttribute('data-grasp-pw', t);
  if (this.nodeType === 1) return null;
  const r = document.createRange(); r.selectNodeContents(this);
  const q = [...r.getClientRects()].find((x) => x.width > 0 && x.height > 0);
  if (!q) return null;
  const b = el.getBoundingClientRect();
  return { x: q.left + q.width / 2 - b.left, y: q.top + q.height / 2 - b.top };
}`;
/** Deux frames rendues (au plus 300 ms : un onglet sans rendu ne bloque pas). */
const FRAMES_FN = `new Promise((r) => { const t = setTimeout(() => r(false), 300); requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(t); r(true); })); })`;
/** Locator dont les actions au pointeur visent `position` (centre d'un nœud texte dans son parent). */
function atPosition(loc: PwLocator, position: { x: number; y: number }): PwLocator {
  const pointer = new Set<PropertyKey>(['click', 'hover', 'check', 'uncheck']);
  return new Proxy(loc, {
    get(t, k) {
      const v: unknown = Reflect.get(t, k, t);
      if (typeof v !== 'function') return v;
      if (pointer.has(k)) return (o: Record<string, unknown> = {}) => (v as (o: object) => Promise<void>).call(t, { ...o, position });
      return (v as (...a: unknown[]) => unknown).bind(t);
    },
  });
}
/** Vérification d'une action Playwright : au pointeur (clic, case ; survol `hover`, `soft`) ou au clavier (`focused` : touche sans cible). */
interface PwCheck { pointer?: boolean; hover?: boolean; soft?: boolean; focused?: boolean }

type DeliveryKind = 'clic' | 'touche' | 'saisie' | 'survol';
const KIND: Record<DeliveryKind, { failed: string; synth: string; note: string }> = {
  clic: { failed: 'clic non livré', synth: 'le clic synthétique', note: 'clic synthétique' },
  survol: { failed: 'survol non livré', synth: 'le survol synthétique', note: 'survol synthétique' },
  touche: { failed: 'touche non livrée', synth: 'la touche synthétique', note: 'touche synthétique' },
  saisie: { failed: 'saisie non livrée', synth: 'la saisie synthétique', note: 'saisie synthétique' },
};
interface Probe { trusted: number; synthetic: number; mutations: number }
interface DeliverOptions {
  kind: DeliveryKind;
  types: string[];
  /** Point du clic (recalculé à chaque essai) ; absent : l'élément qui a le focus reçoit l'entrée. */
  point?: () => Promise<{ x: number; y: number }>;
  /** Envoi natif par CDP (Input.*). */
  native: (at: { x: number; y: number } | undefined) => Promise<void>;
  /** Avant le 2e essai natif (ex. refocaliser et resélectionner un champ). */
  prepare?: () => Promise<void>;
  /** Repli DOM depuis le monde isolé (isTrusted=false). */
  synthetic: (at: { x: number; y: number } | undefined) => Promise<void>;
  /** Effet observable du repli ; défaut : mutation du DOM ou navigation. */
  effect?: () => Promise<boolean>;
  /** Rejeu par le moteur Playwright (fallbackEngine=playwright), entre l'étage (a) et le repli synthétique. */
  replay?: () => Promise<void>;
}
/** Crochets de test : simulent une reprise de la livraison pendant un étage. */
export interface TestHooks { recovering?(stage: 'front' | 'playwright' | 'synthetic'): void | Promise<void> }

interface ElementInfo { tag: string; type: string; disabled: boolean; readOnly: boolean; editable: boolean; checkable: boolean; checked: boolean | null }

const REF_RE = /^e[0-9a-z]{1,4}$/;
const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'submit', 'button', 'file', 'image', 'reset', 'hidden', 'range', 'color']);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Code FIXE de lecture d'un stockage Web : JSON de [{name, value}] dans l'ordre des clés. */
const READ_STORAGE_FN = (area: 'localStorage' | 'sessionStorage') =>
  `(() => { const s = ${area}, out = []; for (let i = 0; i < s.length; i++) { const k = s.key(i); out.push({ name: k, value: s.getItem(k) }); } return JSON.stringify(out); })()`;
/** `grasp storage get` : au-delà, la valeur est tronquée (et la troncature annoncée). */
export const STORAGE_GET_MAX = 4000;
/** Code FIXE d'écriture ; les données n'y entrent que sérialisées en JSON. */
const WRITE_STORAGE_FN = (area: 'localStorage' | 'sessionStorage', items: StateItem[]) =>
  `((items) => { for (const it of items) ${area}.setItem(it.name, it.value); return ${area}.length; })(${JSON.stringify(items)})`;

/**
 * Contrôle d'un onglet via CDP. Détient le garde de navigation : la même `policy` (gelée) sert
 * au pré-contrôle de /navigate, à l'interception Fetch dans le navigateur, et au rapport.
 */
/** Cookie de session transféré d'un navigateur à son remplaçant (recyclage). */
export interface SessionCookie {
  name: string; value: string; domain: string; path: string; secure: boolean; httpOnly: boolean;
  sameSite?: string; priority?: string; sourceScheme?: string; sourcePort?: number; partitionKey?: unknown;
}

export class PageController {
  private loading = false;
  private pendingNavAt = 0;
  private blocked: Blocked | null = null;
  /**
   * Dernier document du CADRE PRINCIPAL refusé par le garde Fetch (`blocked` couvre aussi les documents des
   * iframes) : ce qui fait échouer back/forward/reload, dont la commande CDP ne rend pas d'erreur.
   */
  private blockedMain: Blocked | null = null;
  /**
   * Page d'erreur de Chrome (chrome-error://) chargée dans le cadre principal : URL inaccessible et erreur réseau
   * du document (Network.loadingFailed, si le domaine Network est actif). Lu par back/forward/reload.
   */
  private mainFailed: { url: string; error: string | undefined; at: number } | null = null;
  /** requestId du dernier document demandé par le cadre principal, et son échec réseau éventuel. */
  private mainDocReq: { id: string; error: string | undefined } | undefined;
  /** Document servi par une adresse privée alors que le DNS de Grasp en donnait une publique (rebinding). */
  private rebound: Blocked | null = null;
  /** Résolveur DNS de la protection SSRF (injectable pour les tests). */
  private dns: Resolver = systemResolver;
  /** Politique + proxy effectif de la session : contexte réseau de la protection SSRF. */
  private netCtx: Readonly<SsrfContext> | undefined;
  private get ssrfCtx(): Readonly<SsrfContext> { return this.netCtx ?? this.policy; }
  /** Réponse aux dialogues pendant l'action en cours (--dialog) ; undefined : défaut sûr. */
  private dialogPolicy: DialogPolicy | undefined;
  /** Une action est en cours : un dialogue ouvert hors action est rapporté à la suivante, marqué comme tel. */
  private inAction = false;
  /** Dialogues vus depuis le dernier rapport (bornés), et ceux au-delà de la borne. */
  private dialogs: DialogSeen[] = [];
  private dialogsOmitted = 0;
  private mainFrameId = '';
  /** Navigateur qui ne nous appartient pas : pas d'auto-attach sur les autres onglets. */
  private foreign = false;
  private capturesDir: string | undefined;
  /** Console de l'onglet : survit aux navigations (repère « navigation → url »). */
  private readonly consoleBuf = new ConsoleBuffer();
  /**
   * Journal réseau de l'onglet, nourri par les événements Network que la console écoute déjà (allowConsole) ; il
   * garde aussi méthode et URL brutes des requêtes en vol pour les messages de la console. Jamais d'en-têtes ni de corps.
   */
  private readonly netLog = new NetworkLog();
  /** seq réseau juste avant la requête du document courant du cadre principal (expect request). */
  private docNetSeq = 0;
  /**
   * seq réseau au début de la dernière action (nav, clic, saisie, eval…) : un « Enregistrer » qui poste puis change
   * de page (fetch puis location, formulaire POST en PRG) a sa requête AVANT le document courant (expect request).
   */
  private actNetSeq: number | undefined;
  /** Requêtes réseau annulées par le garde : déjà signalées comme « bloqué par Grasp ». */
  private readonly blockedNet = new Set<string>();
  /** Liste de traqueurs (blockTrackers=true), sinon undefined : aucun motif Fetch au-delà des documents. */
  private trackers: TrackerList | undefined;
  /** Requêtes vers des traqueurs annulées dans cet onglet (cumul, jamais remis à zéro). */
  trackersBlocked = 0;
  /** Domaine de la liste qui couvre le document principal courant (page ouverte exprès sur un tel domaine). */
  private topTracker: string | undefined;
  /** Contextes d'exécution → cadre, pour signaler les messages venant d'une iframe. */
  private readonly contexts = new Map<string, string>();
  private readonly frames = new Map<string, string>();
  /** Sessions CDP des iframes hors processus (OOPIF) de l'onglet : gardées et écoutées comme lui. */
  private readonly children = new Set<string>();
  private limits: Limits = { ...DEFAULT_LIMITS };
  /**
   * ref → (rôle, nom, nœud DOM, document) de chaque ref vue dans un snapshot : base de la résolution d'une
   * ref disparue. Le nœud dit si l'élément est encore là ; `doc` (compteur de documents du cadre principal)
   * empêche qu'une ref d'une page précédente désigne un élément du document courant.
   */
  private readonly knownRefs = new Map<string, { role: string; name: string; key: string; id: number | undefined; doc: number }>();
  /** seq console juste avant la requête du document courant du cadre principal (expect no-console-errors). */
  private docSeq = 0;
  /** Documents chargés dans le cadre principal (incrémenté à chaque Page.frameNavigated du cadre principal). */
  private docGen = 0;
  /** Monde isolé « grasp-lecture » du document courant (invalidé à chaque navigation du cadre principal). */
  private isoCtx: number | undefined;
  /** Document (docGen) sur lequel Page.bringToFront a été tenté : une seule tentative par document. */
  private frontTriedDoc = -1;
  /** Navigations du cadre principal : une action qui navigue attend aussi la stabilité. */
  private navCount = 0;
  /** Notes de l'action en cours (ex. ref retrouvée après re-rendu). */
  private notes: string[] | undefined;
  /** Chargements démarrés dans le cadre principal (une action qui navigue a été livrée). */
  private loadStarts = 0;
  /**
   * Requêtes réseau du document courant (cadre principal seulement), en vol ou terminées depuis peu, pour
   * l'attente de stabilité : départ et fin horodatés (jamais évincées tant qu'elles sont récentes).
   */
  private readonly net = new Map<string, TrackedRequest>();
  /** Derniers départs par requête (méthode, origine, chemin) : reconnaissance d'un polling périodique. */
  private readonly netStarts = new Map<string, number[]>();
  /** L'action en cours a dû être rejouée en synthétique (l'entrée native n'a pas atteint la page). */
  private undelivered = false;
  /**
   * Élément visé par l'action en cours (fill, type, click) : s'il a été détaché pendant la fenêtre
   * d'observation qui suit l'action, son remplaçant est cherché et signalé (voir replacementNote).
   */
  private actTarget: number | undefined;
  /**
   * Historique : cible à décrire (une fois) et sa description, PROPRES à chaque appel d'action. Deux actions
   * concurrentes d'une session ne sont pas sérialisées : un champ partagé de l'instance laissait l'une renvoyer
   * la description de la cible de l'autre (mot de passe conservé, mauvais élément rejoué).
   */
  private readonly describeCtx = new AsyncLocalStorage<{ want: string | undefined; described?: DurableTarget | undefined }>();
  private probeSeq = 0;
  /** Moteur Playwright (connexion paresseuse) et repli automatique des clics. */
  private pw: PlaywrightEngine | undefined;
  private fallback: 'none' | 'playwright' = 'none';
  /** Identifiants HTTP basic de la session (mémoire seulement ; jamais journalisés ni rapportés en clair). */
  private creds: readonly HttpCredential[] = [];
  /** Secrets saisis par `fill … secret:NOM` dans cette session : masqués à la source (avant toute coupure). */
  readonly secretRedactor = new Redactor();
  /** Champs remplis avec un secret (backendNodeId → nom) : leur valeur est rendue `secret:NOM`, même tronquée. */
  private readonly secretNodes = new Map<number, string>();
  /** Requêtes auxquelles des identifiants ont déjà été fournis : un second défi = identifiants refusés. */
  private readonly authTried = new Set<string>();
  /** Hôtes dont un certificat non vérifié a déjà été signalé dans la console. */
  private readonly certNoted = new Set<string>();
  /** Crochets de test (jamais utilisés en production). */
  testHooks: TestHooks | undefined;
  /** Origines des documents chargés par cette session : candidates à l'export du localStorage. */
  private readonly seenOrigins = new Set<string>();
  /** Onglets d'état (export/import) : session CDP → origine attendue ; leurs documents sont servis vides par Fetch. */
  private readonly scratch = new Map<string, string>();
  /** Cibles auto-attachées pendant la création d'un onglet d'état : targetId → session prête (gardée, relancée). */
  /** Demandes d'ouverture de fenêtre (window.open, target=_blank) vues dans cet onglet : popups attendus (tabs.ts). */
  windowOpens = 0;
  /** Répertoire de téléchargement et moteur Playwright : repris par les onglets ouverts depuis celui-ci. */
  private downloadDir = '';
  private engineCfg: { endpoint: string | undefined; module: string | undefined; idleMs: number; isLocal: boolean } = { endpoint: undefined, module: undefined, idleMs: PW_IDLE_MS, isLocal: false };
  private readonly listener = (e: CdpEvent): void => { void this.onEvent(e); };
  /** sessionStorage importé, en attente du premier document de son origine dans l'onglet. */
  private pendingSession: { origin: string; identifier: string } | undefined;
  /** Viewport émulé de la session (grasp viewport), réappliqué après un agrandissement de capture ; undefined = natif. */
  private vp: ViewportSpec | undefined;
  /** Un user agent mobile a été posé sur l'onglet (à retirer au reset). */
  private uaOverridden = false;
  /** Écran réel [largeur, hauteur], lu avant le premier override : cible de l'attente au reset. */
  private nativeScreen: number[] | undefined;

  private constructor(
    private readonly cdp: CdpClient,
    private readonly sessionId: string,
    private readonly targetId: string,
    readonly policy: Readonly<EffectivePolicy>,
    readonly hub: TabHub,
  ) { hub.pages.add(this); }

  static async attach(cdp: CdpClient, policy: Readonly<EffectivePolicy>, opts: { downloadDir: string; newTab?: boolean; capturesDir?: string | undefined; limits?: Partial<Limits> | undefined; engine?: EngineConfig | undefined; httpAuth?: readonly HttpCredential[] | undefined; resolve?: Resolver | undefined; proxyServer?: string | null | undefined; viewport?: ViewportSpec | undefined }): Promise<PageController> {
    const { targetInfos } = await cdp.send<{ targetInfos: Array<{ targetId: string; type: string }> }>('Target.getTargets');
    // Navigateur partagé (mode attach) : on ouvre notre propre onglet, sans toucher à ceux de l'utilisateur.
    let targetId = opts.newTab ? undefined : targetInfos.find((t) => t.type === 'page')?.targetId;
    if (targetId === undefined) targetId = (await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' })).targetId;
    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    const hub = new TabHub();
    const pc = new PageController(cdp, sessionId, targetId, policy, hub);
    hub.lead = pc;
    // Liste illisible : la session échoue (jamais un blocage annoncé mais inactif).
    if (policy.blockTrackers) pc.trackers = TrackerList.embedded();
    pc.foreign = opts.newTab === true;
    pc.capturesDir = opts.capturesDir;
    if (opts.httpAuth !== undefined) pc.creds = Object.freeze(opts.httpAuth.map((c) => Object.freeze({ ...c })));
    if (opts.resolve !== undefined) pc.dns = opts.resolve;
    // Proxy effectif (celui de la session s'il surcharge la config) : la protection SSRF en dépend.
    pc.netCtx = Object.freeze({ ...policy, proxyServer: opts.proxyServer !== undefined ? opts.proxyServer : policy.proxyServer });
    if (opts.limits !== undefined) pc.limits = { ...DEFAULT_LIMITS, ...opts.limits };
    const en = opts.engine ?? {};
    pc.fallback = en.fallback ?? 'none';
    pc.engineCfg = { endpoint: en.devtoolsUrl, module: en.module, idleMs: en.idleMs ?? PW_IDLE_MS, isLocal: en.isLocal === true };
    pc.pw = new PlaywrightEngine({ ...pc.engineCfg, targetId });
    pc.downloadDir = opts.downloadDir;
    await pc.init(opts.downloadDir);
    // Viewport de la session (session create --viewport, ou conservé à travers une bascule / un recyclage) :
    // posé avant toute navigation, la première page est rendue à cette taille.
    if (opts.viewport !== undefined) await pc.setViewport(opts.viewport);
    return pc;
  }

  /**
   * Onglet de plus (popup, target=_blank, tab new) sur une session déjà attachée, avec les réglages de
   * `sibling` : même politique, mêmes identifiants HTTP, même liste de traqueurs, mêmes limites. La cible est
   * normalement EN PAUSE (waitForDebuggerOnStart) : garde et console sont en place avant son premier document.
   */
  static async adopt(sibling: PageController, sessionId: string, targetId: string, resume?: () => Promise<unknown>): Promise<PageController> {
    const pc = new PageController(sibling.cdp, sessionId, targetId, sibling.policy, sibling.hub);
    pc.trackers = sibling.trackers;
    pc.foreign = sibling.foreign;
    pc.capturesDir = sibling.capturesDir;
    pc.creds = sibling.creds;
    pc.dns = sibling.dns;
    pc.netCtx = sibling.netCtx;
    pc.limits = sibling.limits;
    pc.fallback = sibling.fallback;
    pc.testHooks = sibling.testHooks;
    pc.engineCfg = sibling.engineCfg;
    pc.pw = new PlaywrightEngine({ ...sibling.engineCfg, targetId });
    pc.downloadDir = sibling.downloadDir;
    try {
      if (resume !== undefined) {
        // Cible en pause : Page.enable et les autres domaines n'aboutissent qu'après la relance (mesuré, Chrome 150 :
        // Page.enable reste sans réponse). Le garde, lui, est posé EN PAUSE ; les domaines sont demandés avant la
        // relance (la cible les traite dans l'ordre, avant son premier document), puis attendus.
        pc.cdp.on('event', pc.listener);
        await pc.guard(sessionId);
        const pre = [pc.s('Page.enable'), pc.s('DOM.enable'), pc.s('Accessibility.enable'), ...(pc.policy.allowConsole ? [pc.enableConsole(sessionId)] : [])];
        await resume();
        await Promise.all(pre);
      }
      await pc.init(sibling.downloadDir);
    } catch (e) { pc.dispose(); throw e; }
    return pc;
  }

  /** Cible CDP de l'onglet. */
  get target(): string { return this.targetId; }

  /** Session CDP de l'onglet. */
  get session(): string { return this.sessionId; }

  /** Session de cet onglet, d'une de ses iframes hors processus ou d'un de ses onglets d'état. */
  owns(sessionId: string): boolean { return sessionId === this.sessionId || this.children.has(sessionId) || this.scratch.has(sessionId); }

  /** Ref remise par un snapshot de cet onglet. */
  knowsRef(ref: string): boolean { return this.knownRefs.has(ref); }

  /** Navigateur partagé (mode attach) : rien n'est imposé aux onglets de l'utilisateur. */
  get attachedMode(): boolean { return this.foreign; }

  /**
   * Onglet fermé : plus aucun événement de ses sessions, moteur Playwright déconnecté. Le meneur passe au
   * suivant ; s'il n'y en a plus (dernier onglet fermé), ce contrôleur reste meneur pour les seuls événements du
   * navigateur, sans rien posséder : un nouvel onglet doit encore être gardé avant de s'exécuter, puis adopté.
   */
  dispose(): void {
    this.hub.pages.delete(this);
    void this.pw?.disconnect().catch(() => undefined);
    if (this.hub.lead === this) {
      const next = this.hub.pages.values().next().value;
      if (next === undefined) return;
      this.hub.lead = next;
    }
    this.cdp.off('event', this.listener);
  }

  /**
   * Nouvel onglet : attend son premier document (chargé, ou bloqué par le garde), au plus `capMs`. `stable` :
   * attend ensuite la stabilité du DOM et du réseau, comme `nav` (bascule --follow), au plus stableTimeoutMs.
   */
  async opened(capMs: number, stable = false): Promise<{ url: string; title: string; blocked: Blocked | null }> {
    const end = Date.now() + capMs;
    while (Date.now() < end && this.blocked === null && !(this.docGen > 0 && !this.loading)) await sleep(25);
    if (stable && this.blocked === null) await this.waitStable(this.limits.stableTimeoutMs).catch(() => undefined);
    const loc = await this.location().catch(() => ({ url: '', title: '' }));
    return { ...loc, blocked: this.blocked };
  }

  /** Attente de stabilité (DOM et réseau), comme après une action ; plafond stableTimeoutMs. */
  async stable(): Promise<void> { await this.waitStable(this.limits.stableTimeoutMs).catch(() => undefined); }

  /** Pré-contrôle d'une URL (allowlist, schémas, protection SSRF), sans naviguer : 403 si refusée. */
  async assertNavigable(url: string): Promise<void> {
    const v = await checkNavigation(this.ssrfCtx, url, this.dns);
    if (!v.allowed) throw forbidden(`navigation bloquée : ${v.reason}`);
  }

  // ---------- Moteur Playwright de repli (optionnel, connexion paresseuse) ----------

  /** Ferme la connexion Playwright (jamais le navigateur ni l'onglet) : arrêt du bridge, tests. */
  async closeEngine(): Promise<void> { await this.pw?.disconnect(); }

  get playwrightConnected(): boolean { return this.pw?.connected === true; }

  /** Connexions Playwright encore ouvertes, suivies ou non (diagnostic : 0 attendu après closeEngine). */
  get playwrightLinks(): number { return this.pw?.liveLinks ?? 0; }

  /** Moteur d'une action : --engine (validé), et frame= impose Playwright. */
  private engineFor(opts: { engine?: string | undefined }, sel?: string): 'native' | 'playwright' {
    const e = opts.engine;
    if (e !== undefined && e !== 'native' && e !== 'playwright') throw badRequest(`moteur inconnu « ${e} » (native, playwright)`);
    const framed = sel !== undefined && parseFrameTarget(sel) !== null;
    if (framed && e === 'native') throw badRequest('frame= exige le moteur Playwright (retirez --engine native)');
    return framed || e === 'playwright' ? 'playwright' : 'native';
  }

  /**
   * Opération sur la page Playwright de l'onglet : la première connexion est notée (coût visible), et la
   * déconnexion d'inactivité attend la fin de l'opération (une longue attente n'est jamais coupée).
   */
  private pwUse<T>(fn: (page: PwPage) => Promise<T>): Promise<T> {
    if (this.pw === undefined) return Promise.reject(new GraspError(501, 'moteur Playwright non configuré pour ce bridge'));
    return this.pw.use(fn, (ms) => { this.notes?.push(`moteur Playwright connecté en ${ms} ms`); });
  }

  /**
   * Élément Grasp (backendNodeId) → locator Playwright : marqueur temporaire data-grasp-pw posé depuis le
   * monde isolé, retiré après l'action (seule trace visible par la page, le temps de l'action). Nœud TEXTE
   * (cible text:) : le marqueur va sur son parent, et `position` désigne le centre du texte dans la boîte du
   * parent — sans elle, Playwright cliquerait au centre du parent, peut-être sur un lien voisin.
   */
  private async tagged(page: PwPage, id: number): Promise<{ loc: PwLocator; untag: () => Promise<void> }> {
    const tok = `g${process.pid}-${++this.probeSeq}`;
    const position = await this.callIsolated<{ x: number; y: number } | null>(id, TAG_FN, tok);
    const loc = page.locator(`[data-grasp-pw="${tok}"]`);
    return {
      loc: position !== null ? atPosition(loc, position) : loc,
      untag: async () => { await this.callIsolated(id, `function () { const el = this.nodeType === 1 ? this : this.parentElement; if (el) el.removeAttribute('data-grasp-pw'); return true; }`).catch(() => undefined); },
    };
  }

  /**
   * Sélecteur Grasp → locator Playwright. Document principal : ref et text: résolus par Grasp (mêmes règles
   * qu'en natif), CSS laissé à Playwright (il attend que l'élément apparaisse). Cadre (frame=… >> …) : CSS ou
   * text: dans le cadre, même d'une autre origine ; `whole` : cadre entier si aucun élément n'est précisé (lectures).
   */
  private async pwLocator(page: PwPage, sel: string, snap: Snapshot | undefined, whole?: string): Promise<{ loc: PwLocator; untag?: () => Promise<void>; id?: number }> {
    const s = sel.trim();
    if (s === '') throw badRequest('sélecteur vide');
    const ft = parseFrameTarget(s);
    if (ft !== null) {
      let fl = page.frameLocator(ft.frames[0]!);
      for (const f of ft.frames.slice(1)) fl = fl.frameLocator(f);
      const t = ft.target;
      if (t === '') {
        if (whole === undefined) throw badRequest(`frame=… >> <sélecteur> : précisez l'élément du cadre (ex. ${s} >> button, ${s} >> text:Valider)`);
        return { loc: fl.locator(whole) };
      }
      if (REF_RE.test(t)) throw badRequest('les refs ne désignent que des éléments du document principal : dans un cadre, utilisez un sélecteur CSS ou text: (frame=… >> #id, frame=… >> text:Valider)');
      if (t.startsWith('text:')) {
        const txt = t.slice(5).trim();
        if (txt === '') throw badRequest('text: attend un texte');
        const exact = fl.getByText(txt, { exact: true });
        return { loc: (await exact.count()) > 0 ? exact : fl.getByText(txt) };
      }
      return { loc: fl.locator(`css=${t.startsWith('css:') ? t.slice(4) : t}`) };
    }
    if (REF_RE.test(s) || s.startsWith('text:')) { const id = await this.resolve(s, snap); return { ...(await this.tagged(page, id)), id }; }
    return { loc: page.locator(`css=${s.startsWith('css:') ? s.slice(4) : s}`) };
  }

  /**
   * Action par le moteur Playwright, dans le même cadre qu'une action native (--snap-diff, --console, notes,
   * garde). Livraison vérifiée par la sonde dans le document principal : `pointer` (clic, survol, case) ou
   * `keys` (frappe, touche). Dans un cadre, la sonde ne voit rien : c'est dit.
   */
  private pwAct(opts: ActionOptions, sel: string, what: string, fn: (loc: PwLocator, page: PwPage) => Promise<string | void>, check?: PwCheck, post?: (res: ActionResult, id: number | undefined) => Promise<string | undefined>): Promise<ActionResult> {
    let target: number | undefined;
    // `post` reçoit l'élément du document principal (ref, text: : déjà résolu ; CSS : résolu par Grasp après
    // l'action) ; dans un cadre, aucun : les notes d'invalidité ne portent que sur le document principal.
    const after = post === undefined ? undefined : async (res: ActionResult) => {
      if (target === undefined && parseFrameTarget(sel) === null) target = await this.resolve(sel).catch(() => undefined);
      return post(res, target);
    };
    return this.act(opts, (snap) => this.pwUse(async (page) => {
      const { loc, untag, id } = await this.pwLocator(page, sel, snap);
      target = id;
      try {
        if (check === undefined) return await fn(loc, page);
        if (check.pointer === true) await this.pwReady(loc, PW_ACTION_TIMEOUT_MS);
        if (parseFrameTarget(sel) !== null) {
          const r = await fn(loc, page);
          this.notes?.push('action dans un cadre : livraison non vérifiable depuis la page (actionnabilité vérifiée par Playwright)');
          return r;
        }
        let out: string | void = undefined;
        await this.pwVerified(check, what, async () => { out = await fn(loc, page); });
        return out;
      } catch (e) { throw pwError(e, what); } finally { await untag?.(); }
    }), after);
  }

  /**
   * Avant une action Playwright au pointeur. (1) Onglet en arrière-plan : Playwright attend un rendu (élément
   * « stable ») qui n'arrive jamais — on ramène l'onglet au premier plan, comme l'étage (a) natif, et c'est dit.
   * (2) Défilement fait PAR AVANCE, puis deux frames : sinon Chrome route le clic qui suit aussitôt un
   * défilement d'après un hit-test périmé, vers l'iframe hors processus qui occupait ce point (constaté sur
   * Chrome 150 : clic reçu par l'iframe, invisible pour la sonde du document principal).
   */
  private async pwReady(loc: PwLocator, timeout: number): Promise<void> {
    await this.ensureVisible(": Playwright n'agit au pointeur que sur un onglet rendu");
    await loc.scrollIntoViewIfNeeded({ timeout });
    await this.evalIsolated(FRAMES_FN, true).catch(() => undefined);
  }

  /**
   * Action Playwright VÉRIFIÉE comme une entrée native : Playwright peut répondre OK alors que la page n'a rien
   * reçu. JAMAIS rejouée : un clic dont la page principale n'a rien vu a pu atteindre un autre document (iframe
   * sous le point, focus dans un cadre) — le rejouer ferait deux actions. Aucun événement de confiance → 502
   * (ou note si `soft` : un survol sur un pointeur déjà en place peut ne produire aucun événement).
   */
  private async pwVerified(check: PwCheck, what: string, run: () => Promise<void>): Promise<void> {
    const types = check.pointer === true ? (check.hover === true ? HOVER_EVENTS : CLICK_EVENTS) : KEY_EVENTS;
    let probe: { token: string; hit: string | null };
    try { probe = await this.armProbe(types, undefined); } catch (e) {
      await run();
      this.notes?.push(`livraison de l'entrée non vérifiée (sonde impossible : ${(e as Error).message})`);
      return;
    }
    try {
      // Touche sans cible : elle part vers l'élément focalisé ; une iframe focalisée = un autre document.
      if (check.focused === true && probe.hit !== null && FRAME_TAGS.has(probe.hit)) {
        await run();
        this.notes?.push(`touche envoyée dans un cadre (<${probe.hit.toLowerCase()}> focalisé) : livraison non vérifiable depuis la page`);
        return;
      }
      const m = this.mark();
      let err: unknown;
      try { await run(); } catch (e) { err = e; }
      const seen = await this.awaitProbe(probe.token, m, (p) => p.trusted > 0);
      if (seen !== 'no') {
        if (err !== undefined) throw err;
        return;
      }
      // Échec réel (élément invisible, délai…) : remonté tel quel. « État inchangé » sans événement : entrée perdue.
      if (err !== undefined && !/did not change its state/.test(err instanceof Error ? err.message : String(err))) throw err;
      if (check.soft === true) { this.notes?.push(`${what} Playwright : aucun événement reçu par la page (pointeur déjà sur l'élément ?)`); return; }
      throw new GraspError(502, check.pointer === true
        ? `${what} non livré (moteur Playwright) : Playwright a répondu sans erreur mais la page n'a reçu aucun événement de confiance — non rejoué : l'entrée a pu atteindre un autre document (iframe) ou être jetée par Chrome (écran Windows verrouillé, fenêtre sans rendu) ; vérifiez l'état de la page (snap) avant de recommencer`
        : `${what} non livrée (moteur Playwright) : Playwright a répondu sans erreur mais la page n'a reçu aucun événement clavier de confiance — non rejouée (risque de double saisie) ; vérifiez le champ (snap), ou reprenez sans --engine playwright : le moteur natif a un repli synthétique annoncé`);
    } finally { this.stopProbe(probe.token); }
  }

  /** Clic Playwright sur un élément résolu par Grasp (rejeu automatique) ; `verify` : sonde propre (hors de deliver). */
  private pwClickNode(id: number, timeout: number, verify: boolean): Promise<void> {
    return this.pwUse(async (page) => {
      const { loc, untag } = await this.tagged(page, id);
      try {
        await this.pwReady(loc, timeout);
        if (verify) await this.pwVerified({ pointer: true }, 'clic', () => loc.click({ timeout }));
        else await loc.click({ timeout });
      } catch (e) { throw pwError(e, 'click'); } finally { await untag(); }
    });
  }

  /** Départ d'une requête suivie (cadre principal) ; une redirection garde son instant de départ. */
  private netStart(requestId: string, method: string, url: string): void {
    const now = Date.now();
    if (this.net.has(requestId)) return;
    let key = `${method} ${url}`;
    try { const u = new URL(url); key = `${method} ${urlBase(u)}`; } catch { /* URL opaque */ }
    let ts = this.netStarts.get(key);
    if (ts === undefined) ts = [];
    ts.push(now);
    if (ts.length > 4) ts.shift();
    this.netStarts.set(key, ts);
    if (this.netStarts.size > 500) this.netStarts.delete(this.netStarts.keys().next().value as string);
    this.net.set(requestId, { start: now, periodic: PageController.periodic(ts) });
    // Purge : terminées depuis plus de 30 s (plus utiles à aucune attente), et au-delà de 1000 entrées.
    for (const [id, r] of this.net) {
      if (this.net.size <= 200) break;
      if ((r.end !== undefined && now - r.end > 30_000) || this.net.size > 1000) this.net.delete(id);
    }
  }

  /** Fin (ou échec) d'une requête suivie, quelle que soit la session qui la rapporte (OOPIF : session enfant). */
  private netEnd(requestId: string): void {
    const r = this.net.get(requestId);
    if (r !== undefined && r.end === undefined) r.end = Date.now();
  }

  /**
   * Polling : les 3 derniers départs d'une même requête, espacés d'au moins 150 ms et à intervalles
   * réguliers (écart ≤ 30 % + 50 ms). Une rafale (GraphQL, autocomplétion) n'est pas régulière.
   */
  private static periodic(ts: number[]): boolean {
    if (ts.length < 3) return false;
    const d1 = ts[ts.length - 2]! - ts[ts.length - 3]!;
    const d2 = ts[ts.length - 1]! - ts[ts.length - 2]!;
    return d1 >= 150 && d2 >= 150 && Math.abs(d1 - d2) <= 0.3 * Math.max(d1, d2) + 50;
  }

  private s<T = any>(method: string, params: object = {}): Promise<T> {
    return this.cdp.send<T>(method, params, this.sessionId);
  }

  private async init(downloadDir: string): Promise<void> {
    this.cdp.off('event', this.listener);
    this.cdp.on('event', this.listener);
    await this.s('Page.enable');
    await this.s('DOM.enable');
    await this.s('Accessibility.enable');
    // Console : seulement si la politique l'autorise. Runtime.enable est détectable par la page.
    if (this.policy.allowConsole) await this.enableConsole(this.sessionId);
    // Les événements Network (activés avec la console) nourrissent aussi l'attente de stabilité : requêtes
    // déclenchées par une navigation ou une action. allowConsole=false : aucun domaine Network (discrétion,
    // voir console.test.ts), l'attente ne porte alors que sur le DOM et les navigations.
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
    // En mode attach, on ne s'impose pas aux autres onglets de l'utilisateur. Une fois par navigateur (meneur).
    if (!this.foreign && this.hub.lead === this) await this.cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  }

  /** Domaines CDP de la console. Pas de tampon de corps réseau : Grasp ne lit jamais les corps. */
  private async enableConsole(sessionId: string): Promise<void> {
    await this.cdp.send('Runtime.enable', {}, sessionId);
    await this.cdp.send('Log.enable', {}, sessionId);
    await this.cdp.send('Network.enable', { maxTotalBufferSize: 0, maxResourceBufferSize: 0 }, sessionId)
      .catch(() => this.cdp.send('Network.enable', {}, sessionId));
  }

  private log(e: NewEntry): void {
    const r = this.secretRedactor;
    this.consoleBuf.push(r.size === 0 ? e : { ...e, text: r.redact(e.text), ...(e.url !== undefined ? { url: r.redact(e.url) } : {}), ...(e.frame !== undefined ? { frame: r.redact(e.frame) } : {}) });
  }

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
        // Texte rédigé par Chrome, qui y recopie l'URL complète de la ressource (CSP, contenu mixte…).
        this.log({ level: levelOfLog(en.level), source: String(en.source ?? 'other'), text: redactUrlsIn(String(en.text ?? '')), ...PageController.where(en.url !== undefined ? { url: en.url, lineNumber: en.lineNumber } : en.stackTrace?.callFrames?.[0]) });
        return;
      }
      case 'Network.requestWillBeSent': {
        // Début d'un document du cadre principal : point de départ de `expect no-console-errors` (sa propre
        // réponse 4xx/5xx arrive avant le repère de navigation).
        const mainDoc = e.sessionId === this.sessionId && p.type === 'Document' && p.frameId === this.mainFrameId;
        if (mainDoc) { this.docSeq = this.consoleBuf.seq; this.docNetSeq = this.netLog.seq; }
        const rr = p.redirectResponse;
        this.netLog.start(String(p.requestId), {
          method: String(p.request?.method ?? 'GET'), url: String(p.request?.url ?? ''), type: String(p.type ?? 'Other'), ts: p.timestamp, wallTime: p.wallTime,
          frame: !(e.sessionId === this.sessionId && (p.frameId === undefined || p.frameId === this.mainFrameId)),
          redirect: rr !== undefined && rr !== null ? { status: Number(rr.status), statusText: typeof rr.statusText === 'string' ? rr.statusText : undefined } : undefined,
        });
        return;
      }
      case 'Network.responseReceived': {
        const st = Number(p.response?.status);
        this.netLog.response(String(p.requestId), st, typeof p.response?.statusText === 'string' ? p.response.statusText : undefined, p.response?.fromDiskCache === true || p.response?.fromPrefetchCache === true);
        if (!(st >= 400)) return;
        const req = this.netLog.request(p.requestId);
        const url = String(p.response?.url ?? req?.url ?? '');
        this.log({ level: 'error', source: 'network', text: `${req?.method ?? 'GET'} ${redactUrl(url)} → ${st}${p.response?.statusText ? ` ${p.response.statusText}` : ''}${this.offList(url)}` });
        return;
      }
      case 'Network.requestServedFromCache': this.netLog.cached(String(p.requestId)); return;
      case 'Network.loadingFinished': this.netLog.finish(String(p.requestId), p.timestamp); return;
      case 'Network.loadingFailed': {
        const req = this.netLog.request(p.requestId);
        this.netLog.fail(String(p.requestId), p.timestamp, typeof p.errorText === 'string' ? p.errorText : undefined, { canceled: p.canceled === true && p.blockedReason === undefined, blocked: this.blockedNet.has(p.requestId) });
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
        // URL de cadre masquée dès le stockage : elle sort telle quelle dans le champ `frame` des entrées.
        if (typeof f.id === 'string') this.frames.set(f.id, redactUrl(String(f.url ?? ''), 300));
        if (e.sessionId === this.sessionId && f.parentId === undefined) {
          this.log({ level: 'info', source: 'navigation', text: redactUrl(String(f.url ?? ''), 300) });
          this.netLog.abandonPending(this.docNetSeq);
        }
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

  /** Lecture du journal réseau (403 si la politique l'interdit : sans console, aucun domaine Network). */
  networkQuery(q: NetQuery): NetResult {
    this.assertNetwork();
    return this.netLog.query(q);
  }

  /**
   * Le journal réseau repose sur le domaine CDP Network, activé avec la console seulement : allowConsole=false →
   * 403 explicite, jamais un journal vide qui ferait croire qu'aucune requête n'est partie.
   */
  private assertNetwork(): void {
    if (!this.policy.allowConsole) throw forbidden('journal réseau indisponible : allowConsole=false, le domaine CDP Network n\'est pas activé (grasp config set allowConsole true pour l\'autoriser)');
  }

  private networkSince(seq: number): NetworkSlice {
    const r = this.netLog.query({ since: seq, limit: ACTION_NETWORK_LIMIT });
    return { entries: r.entries, seq: r.seq, since: seq, omitted: r.omitted, dropped: r.dropped };
  }

  private consoleSince(seq: number): ConsoleSlice {
    const r = this.consoleBuf.query({ since: seq, limit: ACTION_CONSOLE_LIMIT });
    return { entries: r.entries, seq: r.seq, since: seq, omitted: r.omitted, dropped: r.dropped };
  }

  /** Enrichit l'erreur d'une action : chemin d'une capture (--shot-on-error), entrées console (--console). */
  private async decorate(e: unknown, opts: ActionOptions, seq: number, netSeq = 0): Promise<unknown> {
    if (opts.shotOnError !== true && opts.console !== true && opts.network !== true) return e;
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
      extra.consoleSince = c.since;
      extra.consoleOmitted = c.omitted;
      extra.consoleDropped = c.dropped;
    }
    if (opts.network === true && this.policy.allowConsole) extra.network = this.networkSince(netSeq);
    return new GraspError(base.status, msg, extra);
  }

  /**
   * Seconde ligne contre le DNS rebinding : Chrome résout lui-même, après le contrôle de Grasp. L'adresse à
   * laquelle il s'est réellement connecté (`remoteIPAddress`) est rejugée ; privée et non autorisée → le cadre
   * est renvoyé sur about:blank et la navigation est signalée bloquée. La requête est déjà partie : c'est une
   * protection de la LECTURE, pas de la requête. Exige le domaine Network (actif avec allowConsole).
   */
  private async checkRemoteAddress(e: CdpEvent): Promise<void> {
    if (this.policy.allowPrivateNetwork) return;
    const ip = String(e.params.response?.remoteIPAddress ?? '');
    const url = String(e.params.response?.url ?? '');
    if (ip === '' || !/^https?:/.test(url)) return;
    const c = classifyIp(ip);
    if (c === null || c === undefined) return;
    const u = new URL(url);
    const host = normalizeHost(u.hostname);
    if (isExplicitLocal(this.policy.allowedDomains, host)) return;
    // Adresse sans rapport avec la résolution de Grasp : celle du proxy (il a résolu le nom lui-même), ou la
    // cible d'une règle MAP de l'utilisateur (adresse écrite telle quelle, admise par le pré-contrôle).
    const r = routeOf(this.ssrfCtx, host, urlPort(u));
    if (r.kind === 'proxy') return;
    if (r.kind === 'mapped' && (classifyIp(r.target) !== undefined || r.target === 'localhost' || r.target.endsWith('.localhost'))) return;
    const reason = `${new URL(url).hostname} servi par une adresse ${c} (${ip}) alors que la résolution de Grasp était publique (DNS rebinding) — protection SSRF`;
    const b: Blocked = { url, reason, at: Date.now() };
    this.blocked = b;
    if (e.sessionId === this.sessionId && e.params.frameId === this.mainFrameId) this.rebound = b;
    if (this.policy.allowConsole) this.log({ level: 'error', source: 'grasp', text: `bloqué par Grasp : ${reason} — ${redactUrl(url)}`, blocked: true });
    await this.cdp.send('Page.navigate', { url: 'about:blank', frameId: e.params.frameId }, e.sessionId).catch(() => undefined);
  }

  /** Hôtes munis d'identifiants HTTP, sans les identifiants (rapport de `grasp security`, liste des sessions). */
  httpAuthReport(): MaskedCredential[] { return maskCredentials(this.creds); }

  /**
   * Interception de toutes les requêtes de document (navigation, redirection, iframe) et, si blockTrackers,
   * des requêtes de tout type vers un domaine de la liste de traqueurs (préfiltre par motif, voir trackers.ts).
   * Avec des identifiants HTTP : défis d'authentification reçus aussi (Fetch.authRequired) ; Chrome réutilise
   * ensuite les identifiants acceptés pour les sous-ressources du même espace de protection (mesuré, Chrome 150).
   * Avec ignoreCertErrorsFor : les erreurs de certificat de la cible passent par Security.certificateError,
   * où seuls les hôtes listés sont acceptés (réglage par cible, jamais pour tout le navigateur).
   */
  private async guard(sessionId: string): Promise<void> {
    const patterns: object[] = [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }];
    if (this.trackers !== undefined) patterns.push(...this.trackers.fetchPatterns());
    await this.cdp.send('Fetch.enable', { patterns, ...(this.creds.length > 0 ? { handleAuthRequests: true } : {}) }, sessionId);
    if (this.policy.ignoreCertErrorsFor.length > 0) {
      await this.cdp.send('Security.enable', {}, sessionId);
      try {
        await this.cdp.send('Security.setOverrideCertificateErrors', { override: true }, sessionId);
      } catch (e) {
        throw new Error(`ignoreCertErrorsFor : ce navigateur refuse Security.setOverrideCertificateErrors (${(e as Error).message}) ; retirez ignoreCertErrorsFor ou changez de version de Chrome`);
      }
    }
  }

  /** Erreur de certificat : acceptée seulement pour un hôte de ignoreCertErrorsFor, signalée une fois par hôte. */
  private async onCertificateError(e: CdpEvent): Promise<void> {
    const url = String(e.params.requestURL ?? '');
    let host = '';
    try { host = new URL(url).hostname; } catch { /* URL illisible : refusée */ }
    const ok = host !== '' && hostMatches(this.policy.ignoreCertErrorsFor, host) !== null;
    await this.cdp.send('Security.handleCertificateError', { eventId: e.params.eventId, action: ok ? 'continue' : 'cancel' }, e.sessionId);
    if (!this.policy.allowConsole) return;
    if (ok && !this.certNoted.has(host)) {
      this.certNoted.add(host);
      this.log({ level: 'warn', source: 'grasp', text: `certificat TLS NON vérifié accepté pour ${host} (${String(e.params.errorType)}, ignoreCertErrorsFor)` });
    } else if (!ok) {
      this.log({ level: 'error', source: 'grasp', text: `certificat TLS refusé (${String(e.params.errorType)}) — ${redactUrl(url)} ; hôte absent de ignoreCertErrorsFor` });
    }
  }

  /**
   * Défi d'authentification HTTP : identifiants fournis seulement à leur hôte (nom demandé, port s'il est
   * précisé), si l'URL est dans l'allowlist et que le défi vient du serveur (jamais d'un proxy). Un second
   * défi sur la même requête = identifiants refusés : on abandonne, sans boucle.
   */
  private async onAuthRequired(e: CdpEvent): Promise<void> {
    const requestId: string = e.params.requestId;
    const url = String(e.params.request?.url ?? '');
    const source = String(e.params.authChallenge?.source ?? '');
    const cred = source === 'Server' && checkUrl(this.policy.allowedDomains, url).allowed ? credentialFor(this.creds, url) : undefined;
    let response: Record<string, string>;
    // Hôte sans identifiants : la réponse 401 s'affiche, comme sans Grasp en headless (« Default » ferait échouer
    // la navigation en ERR_INVALID_AUTH_CREDENTIALS, ou ouvrirait une boîte de dialogue en fenêtré).
    if (cred === undefined) response = { response: 'CancelAuth' };
    else if (this.authTried.has(requestId)) {
      response = { response: 'CancelAuth' };
      if (this.policy.allowConsole) this.log({ level: 'error', source: 'grasp', text: `authentification HTTP refusée par ${credentialLabel(cred)} (identifiants de la session rejetés) — ${redactUrl(url)}` });
    } else {
      this.authTried.add(requestId);
      if (this.authTried.size > 1000) this.authTried.delete(this.authTried.values().next().value as string);
      response = { response: 'ProvideCredentials', username: cred.username, password: cred.password };
    }
    await this.cdp.send('Fetch.continueWithAuth', { requestId, authChallengeResponse: response }, e.sessionId);
  }

  /**
   * Domaine de la liste de traqueurs visé par une requête, sinon undefined. Le document principal de l'onglet
   * n'est jamais bloqué à ce titre : y naviguer est un choix explicite, que seule l'allowlist arbitre ; ses
   * propres ressources (même domaine de la liste : favicon, scripts) non plus.
   */
  private trackerOf(url: string, type: unknown, frameId: unknown, sessionId: string | undefined): string | undefined {
    if (this.trackers === undefined) return undefined;
    if (type === 'Document' && sessionId === this.sessionId && frameId === this.mainFrameId) return undefined;
    const d = this.trackers.matchUrl(url);
    return d !== undefined && d === this.topTracker ? undefined : d;
  }

  private async onEvent(e: CdpEvent): Promise<void> {
    // Plusieurs onglets sur une connexion : chaque événement n'est traité que par le contrôleur qui le possède.
    if (!this.hub.routes(this, e.sessionId)) return;
    try {
      if (e.method === 'Fetch.requestPaused' && e.sessionId !== undefined && this.scratch.has(e.sessionId)) { await this.onScratchPaused(e); return; }
      if (e.method === 'Fetch.requestPaused' && e.sessionId !== undefined && this.hub.denied.has(e.sessionId)) {
        await this.cdp.send('Fetch.failRequest', { requestId: e.params.requestId, errorReason: 'BlockedByClient' }, e.sessionId);
        return;
      }
      if (e.method === 'Fetch.authRequired') { await this.onAuthRequired(e); return; }
      if (e.method === 'Security.certificateError') { await this.onCertificateError(e); return; }
      if (e.method === 'Fetch.requestPaused') {
        const url: string = e.params.request.url;
        const tracker = this.trackerOf(url, e.params.resourceType, e.params.frameId, e.sessionId);
        if (tracker !== undefined) {
          this.trackersBlocked++;
          if (this.policy.allowConsole) {
            if (typeof e.params.networkId === 'string') this.blockedNet.add(e.params.networkId);
            // Hôte seul (pas l'URL) : les répétitions consécutives se fusionnent (×N) dans la console.
            this.log({ level: 'info', source: 'grasp', text: `traqueur bloqué : ${new URL(url).hostname} (liste ${tracker})`, blocked: true });
          }
          // net::ERR_BLOCKED_BY_CLIENT pour la page, comme un bloqueur de publicité : aucune requête ne part.
          await this.cdp.send('Fetch.failRequest', { requestId: e.params.requestId, errorReason: 'BlockedByClient' }, e.sessionId);
          return;
        }
        // Préfiltre des traqueurs : faux positif d'un motif (sous-ressource), relâché sans autre contrôle.
        if (e.params.resourceType !== 'Document') {
          await this.cdp.send('Fetch.continueRequest', { requestId: e.params.requestId }, e.sessionId);
          return;
        }
        const v = await checkNavigation(this.ssrfCtx, url, this.dns);
        if (v.allowed) {
          await this.cdp.send('Fetch.continueRequest', { requestId: e.params.requestId }, e.sessionId);
        } else {
          this.blocked = { url, reason: v.reason, at: Date.now() };
          if (e.sessionId === this.sessionId && e.params.frameId === this.mainFrameId) this.blockedMain = this.blocked;
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
      // Synchrone jusqu'au renvoi sur about:blank : `rebound` est posé avant que le load de ce document soit traité.
      if (e.method === 'Network.responseReceived' && e.params.type === 'Document') void this.checkRemoteAddress(e);
      if (e.sessionId !== undefined && (e.sessionId === this.sessionId || this.children.has(e.sessionId))) {
        if (e.method === 'Target.attachedToTarget') { await this.onChildAttached(e); return; }
        if (e.method === 'Target.detachedFromTarget') { this.children.delete(e.params.sessionId); return; }
      }
      if (e.sessionId !== undefined && this.children.has(e.sessionId)) {
        if (this.policy.allowConsole) this.onConsoleEvent(e);
        // Document d'une iframe hors processus : son départ est rapporté par la session de l'onglet, sa fin
        // par la session du cadre. Jamais de requête orpheline « en vol ».
        if (e.method === 'Network.loadingFinished' || e.method === 'Network.loadingFailed') this.netEnd(e.params.requestId);
        return;
      }
      if (e.method === 'Target.attachedToTarget' && e.sessionId === undefined) {
        const sid: string = e.params.sessionId;
        const info = e.params.targetInfo as TargetInfo;
        // Session ouverte par Grasp lui-même (attachToTarget) : son appelant la reprend telle quelle (y compris si
        // l'événement est traité après que la session a déjà un propriétaire).
        if (this.hub.claimed.has(info.targetId) || this.hub.ownerOf(sid) !== undefined) return;
        if (info.targetId === this.targetId || this.foreign || this.hub.ownsTarget(info.targetId)) {
          // Onglets de l'utilisateur (mode attach) : on ne les garde pas, on les laisse vivre.
          if (e.params.waitingForDebugger) await this.cdp.send('Runtime.runIfWaitingForDebugger', {}, sid);
          await this.cdp.send('Target.detachFromTarget', { sessionId: sid });
          return;
        }
        // Nouvel onglet (popup, target=_blank, tab new), sauf l'onglet d'état en création : adopté comme onglet
        // pilotable (gardé AVANT de s'exécuter, voir tabs.ts) ; à défaut, gardé seul comme avant.
        if (info.type === 'page' && this.hub.adopt !== undefined && !(info.openerId === undefined && this.hub.creating === 'scratch')) {
          if (await this.hub.adopt(sid, info, e.params.waitingForDebugger === true)) return;
        }
        const ready = (async () => {
          if (info.type === 'page' || info.type === 'iframe') await this.guard(sid);
          if (e.params.waitingForDebugger) await this.cdp.send('Runtime.runIfWaitingForDebugger', {}, sid);
          return sid;
        })();
        // Onglet d'état en cours de création : il reprend cette session (un seul client Fetch par onglet).
        if (this.hub.creating === 'scratch' && info.type === 'page') this.hub.attaching.set(info.targetId, ready);
        await ready;
        return;
      }
      if (e.sessionId !== this.sessionId) return;
      if (this.policy.allowConsole) this.onConsoleEvent(e);
      const main = e.params?.frameId === this.mainFrameId;
      switch (e.method) {
        case 'Network.requestWillBeSent': {
          const url = String(e.params.request?.url ?? '');
          if (e.params.type === 'Document' && main) this.mainDocReq = { id: String(e.params.requestId), error: undefined };
          if (!TRACKED_REQUESTS.has(String(e.params.type)) || /^(data|blob):/.test(url)) break;
          // Requête vers un traqueur : annulée par le garde avant de partir, elle n'est jamais attendue (ni une
          // « réaction » de la page à une action). Son requestWillBeSent peut précéder Fetch.requestPaused.
          if (this.trackerOf(url, e.params.type, e.params.frameId, e.sessionId) !== undefined) break;
          // Requêtes d'un autre cadre (document d'une iframe, ses XHR) : le contenu des cadres n'entre pas dans
          // le snapshot, et la fin du document d'une iframe hors processus arrive sur une autre session.
          if (typeof e.params.frameId === 'string' && e.params.frameId !== this.mainFrameId) break;
          this.netStart(e.params.requestId, String(e.params.request?.method ?? 'GET'), url);
          break;
        }
        case 'Network.loadingFinished': case 'Network.loadingFailed':
          if (e.method === 'Network.loadingFailed') {
            const d = this.mainDocReq;
            if (d !== undefined && d.id === e.params.requestId) d.error = String(e.params.errorText ?? '');
          }
          this.netEnd(e.params.requestId);
          break;
        case 'Page.frameRequestedNavigation': if (main && e.params.disposition === 'currentTab') this.pendingNavAt = Date.now(); break;
        // Popup ou target=_blank demandé : l'onglet attendu est attaché par le navigateur (tabs.ts le compte).
        case 'Page.windowOpen': this.windowOpens++; break;
        case 'Page.frameStartedLoading': if (main) { this.loading = true; this.pendingNavAt = 0; this.loadStarts++; } break;
        case 'Page.frameStoppedLoading': if (main) this.loading = false; break;
        // Route d'une application monopage (pushState) : même document, mais le rendu suit, on l'attendra.
        case 'Page.navigatedWithinDocument': if (main) { this.pendingNavAt = 0; this.navCount++; } break;
        case 'Page.frameNavigated':
          this.noteOrigin(String(e.params.frame?.url ?? ''), e.params.frame?.parentId === undefined);
          if (e.params.frame?.parentId === undefined) {
            this.navCount++; this.docGen++; this.isoCtx = undefined;
            const fu = String(e.params.frame?.url ?? '');
            const unreachable = e.params.frame?.unreachableUrl as string | undefined;
            this.mainFailed = unreachable !== undefined || fu.startsWith('chrome-error:')
              ? { url: unreachable ?? fu, error: this.mainDocReq?.error || undefined, at: Date.now() } : null;
            this.topTracker = this.trackers?.matchUrl(String(e.params.frame?.url ?? ''));
            // Nouveau document : les requêtes de l'ancien sont mortes (leur fin n'est pas toujours rapportée),
            // et son historique de polling ne vaut plus.
            const now = Date.now();
            for (const r of this.net.values()) if (r.end === undefined) r.end = now;
            this.netStarts.clear();
          }
          break;
        case 'Page.javascriptDialogOpening': {
          // Un dialogue bloque tout l'onglet : on y répond aussitôt (défaut sûr, ou --dialog de l'action) et on le signale.
          const d = decideDialog(String(e.params.type), String(e.params.message ?? ''), String(e.params.defaultPrompt ?? ''), this.dialogPolicy);
          if (!this.inAction) d.seen.outside = true;
          if (this.dialogs.length < DIALOGS_REPORTED_MAX) this.dialogs.push(d.seen); else this.dialogsOmitted++;
          await this.s('Page.handleJavaScriptDialog', d.params);
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
        this.frames.set(info.targetId, redactUrl(String(info.url ?? ''), 300));
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

  /**
   * URL et titre COURANTS. Le titre est relu dans le document (document.title) : celui de l'historique de
   * navigation peut rester celui d'avant une route SPA ou un changement de document.title.
   */
  async location(): Promise<{ url: string; title: string }> {
    const h = await this.s<{ currentIndex: number; entries: Array<{ url: string; title: string }> }>('Page.getNavigationHistory');
    const cur = h.entries[h.currentIndex];
    let title = cur?.title ?? '';
    try {
      const t = await this.evalIsolated<unknown>('document.title');
      if (typeof t === 'string') title = t;
    } catch { /* document en cours de remplacement : titre de l'historique */ }
    return { url: cur?.url ?? 'about:blank', title };
  }

  /** Attend la fin d'une éventuelle navigation déclenchée par une action. */
  private async settle(maxMs = 30_000): Promise<void> {
    await sleep(Math.min(60, maxMs));
    const end = Date.now() + maxMs;
    while (Date.now() < end) {
      const pending = this.pendingNavAt !== 0 && Date.now() - this.pendingNavAt < 1500;
      if (!this.loading && !pending) break;
      await sleep(25);
    }
  }

  /** Navigation comme action : --snap-diff, --console, --shot-on-error. */
  async nav(url: string, opts: ActionOptions = {}): Promise<ActionResult & { url: string; title: string }> {
    if (opts.console === true) this.assertConsole();
    const policy = parseDialogOption(opts.dialog);
    if (opts.network === true) this.assertNetwork();
    const seq = this.consoleBuf.seq;
    const netSeq = this.netLog.seq;
    this.actNetSeq = netSeq;
    const trk0 = this.trackersBlocked;
    this.beginDialogs(policy);
    try {
      const before = opts.snapDiff === true ? await this.snapshot({ scope: opts.scope }) : undefined;
      const doc0 = this.docGen;
      const { loc, stab } = await this.navigateStable(url);
      const out: ActionResult & { url: string; title: string } = { ok: true, ...loc };
      if (this.trackersBlocked > trk0) out.trackersBlocked = this.trackersBlocked - trk0;
      if (!stab.stable) out.detail = PageController.unstableNote(stab);
      else if (stab.ongoing === true) out.detail = ONGOING_NOTE;
      else if (stab.background === true) out.detail = BACKGROUND_NOTE;
      if (before) out.diff = await this.diffAfter(before, opts, doc0);
      // Dialogues (beforeunload de la page quittée, alert du nouveau document…) : note, et en tête du diff ;
      // relevés après le diff, politique close au même moment (comme act).
      this.endDialogs();
      const dlg = this.takeDialogs(out);
      if (dlg.length > 0) {
        out.detail = [...dlg, ...(out.detail !== undefined ? [out.detail] : [])].join(' ; ');
        if (out.diff !== undefined) out.diff = `${dlg.map((l) => `! ${l}`).join('\n')}\n${out.diff}`;
      }
      if (opts.console === true) out.console = this.consoleSince(seq);
      if (opts.network === true) out.network = this.networkSince(netSeq);
      return out;
    } catch (e) { throw this.dialogError(await this.decorate(e, opts, seq, netSeq)); } finally { this.endDialogs(); }
  }

  /** Navigue, attend le load PUIS la stabilité du DOM (rendu côté client), et lit titre et URL après. */
  async navigate(url: string): Promise<{ url: string; title: string }> {
    return (await this.navigateStable(url)).loc;
  }

  /**
   * Navigue, attend le load, puis la stabilité (DOM et réseau) — en suivant une navigation de document qui
   * démarre pendant l'attente (challenge anti-bot qui se remplace par la vraie page), dans le plafond.
   */
  private async navigateStable(url: string): Promise<{ loc: { url: string; title: string }; stab: Stability }> {
    const since = Date.now();
    await this.navigateLoaded(url);
    const stab = await this.waitStable(this.limits.stableTimeoutMs, { since, challenge: true });
    return { loc: await this.location(), stab };
  }

  private static unstableNote(st: Stability): string {
    if (st.challenge === true) return `page de challenge anti-bot probable, toujours affichée après ${st.ms} ms (aucune redirection) : la page peut encore changer`;
    if (st.requests !== undefined && st.requests > 0) return `réseau encore actif après ${st.ms} ms (${st.requests} requête(s) en cours) : la page peut encore changer`;
    return `DOM encore instable après ${st.ms} ms (${st.mutations} mutations)${st.error !== undefined ? ` — attente impossible : ${st.error}` : ''} : la page peut encore changer`;
  }

  /**
   * Diff après l'action, borné (diffMax ou --max), sur la zone --scope s'il y en a une. `doc0` : document
   * (docGen) du snapshot d'avant. Nouveau document → snapshot complet, annoncé ; changement d'URL dans le même
   * document (route SPA) → diff, précédé de « ~ url ».
   */
  private async diffAfter(before: Snapshot, opts: ActionOptions, doc0: number): Promise<string> {
    let after: Snapshot;
    try { after = await this.snapshot({ scope: opts.scope }); } catch (e) {
      // L'action a eu lieu : une zone disparue n'en fait pas un échec, mais c'est dit.
      if (opts.scope !== undefined && e instanceof GraspError && (e.status === 404 || e.status === 409)) return `(zone ${opts.scope} introuvable après l'action : ${e.message})`;
      throw e;
    }
    let out: string;
    if (this.docGen !== doc0) out = `navigation → ${after.url} (nouvelle page : snapshot complet)\n${after.text}`;
    else if (before.url !== after.url) {
      const d = diffSnapshots({ ...before, url: after.url }, after);
      out = `~ url ${after.url}${d === NO_CHANGE ? '' : `\n${d}`}`;
    } else out = diffSnapshots(before, after);
    return truncateText(out, opts.max ?? this.limits.diffMax, { wholeLines: true });
  }

  private async navigateLoaded(url: string): Promise<void> {
    const v = await checkNavigation(this.ssrfCtx, url, this.dns);
    if (!v.allowed) throw forbidden(`navigation bloquée : ${v.reason}`);
    this.blocked = null;
    this.rebound = null;
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
    const rb = this.rebound as Blocked | null; // posé par checkRemoteAddress pendant l'attente
    if (rb !== null) throw forbidden(`navigation bloquée par le garde : ${rb.reason} (${rb.url})`);
    await this.settle();
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

  // ---------- Historique de l'onglet et défilement (back, forward, reload, scroll) ----------

  /**
   * back (-1) / forward (+1) : entrée voisine de l'historique de l'onglet (route pushState comprise). Garde
   * appliqué comme pour nav : l'URL de l'entrée est rejugée (allowlist, SSRF) avant de partir, et le garde Fetch
   * juge la requête du document s'il y en a une. Même attente de stabilité que nav, mêmes options.
   */
  history(delta: -1 | 1, opts: ActionOptions = {}): Promise<ActionResult & { url: string; title: string }> {
    return this.historyNav(delta === -1 ? 'back' : 'forward', opts, false);
  }

  /** reload [--hard] : recharge le document courant (--hard : sans le cache HTTP), comme nav. */
  reload(opts: ActionOptions & { hard?: boolean | undefined } = {}): Promise<ActionResult & { url: string; title: string }> {
    return this.historyNav('reload', opts, opts.hard === true);
  }

  private async historyNav(kind: 'back' | 'forward' | 'reload', opts: ActionOptions, hard: boolean): Promise<ActionResult & { url: string; title: string }> {
    if (opts.console === true) this.assertConsole();
    const seq = this.consoleBuf.seq;
    const trk0 = this.trackersBlocked;
    try {
      const h = await this.s<{ currentIndex: number; entries: Array<{ id: number; url: string; title: string }> }>('Page.getNavigationHistory');
      const n = h.entries.length;
      const entry = h.entries[h.currentIndex + (kind === 'back' ? -1 : kind === 'forward' ? 1 : 0)];
      if (entry === undefined) {
        if (kind === 'back') throw conflict(`aucune page précédente dans l'historique de l'onglet (entrée 1 sur ${n})`);
        if (kind === 'forward') throw conflict(`aucune page suivante dans l'historique de l'onglet (entrée ${h.currentIndex + 1} sur ${n})`);
        throw conflict("aucun document à recharger (historique de l'onglet vide)");
      }
      // Pré-contrôle, comme nav : une entrée restaurée sans requête (cache aller-retour) passe aussi par lui.
      const v = await checkNavigation(this.ssrfCtx, entry.url, this.dns);
      if (!v.allowed) throw forbidden(`navigation bloquée : ${v.reason}`);
      const before = opts.snapDiff === true ? await this.snapshot({ scope: opts.scope }) : undefined;
      const doc0 = this.docGen;
      const nav0 = this.navCount;
      this.blocked = null;
      this.blockedMain = null;
      this.rebound = null;
      this.mainFailed = null;
      const since = Date.now();
      if (kind === 'reload') await this.s('Page.reload', { ignoreCache: hard });
      else await this.s('Page.navigateToHistoryEntry', { entryId: entry.id });
      await this.historyCommitted(nav0, since);
      const stab = await this.waitStable(this.limits.stableTimeoutMs, { since, challenge: true });
      const loc = await this.location();
      const out: ActionResult & { url: string; title: string } = { ok: true, ...loc };
      if (this.trackersBlocked > trk0) out.trackersBlocked = this.trackersBlocked - trk0;
      const notes: string[] = [];
      // Où l'on est arrivé : l'agent ne le sait pas d'avance (contrairement à nav).
      if (kind !== 'reload') notes.push(`${kind === 'back' ? 'retour' : 'avance'} : ${loc.url}${loc.title !== '' ? ` « ${loc.title} »` : ''}${this.docGen === doc0 ? ' (même document)' : ''}`);
      // Document d'une iframe refusé par le garde : la page, elle, est affichée (comme pour une action).
      const fb = this.blocked as Blocked | null;
      if (fb !== null && fb.at >= since) notes.push(`cadre bloqué : ${fb.reason}`);
      if (!stab.stable) notes.push(PageController.unstableNote(stab));
      else if (stab.ongoing === true) notes.push(ONGOING_NOTE);
      else if (stab.background === true) notes.push(BACKGROUND_NOTE);
      if (notes.length > 0) out.detail = notes.join(' ; ');
      if (before) out.diff = await this.diffAfter(before, opts, doc0);
      if (opts.console === true) out.console = this.consoleSince(seq);
      return out;
    } catch (e) { throw await this.decorate(e, opts, seq); }
  }

  /**
   * Attend que la navigation d'historique ait abouti : document (ou route du même document) changé et chargement
   * terminé. Page.reload / navigateToHistoryEntry ne rendent pas d'erreur quand le garde annule la requête : le
   * blocage est lu dans `blockedMain` (garde Fetch, document du cadre principal seulement : une iframe refusée
   * n'empêche pas la page d'arriver) et `rebound` (rebinding), comme pour nav. Ni l'une ni l'autre ne rend non
   * plus l'échec réseau du document : il se lit à la page d'erreur de Chrome chargée à sa place (502, comme nav).
   */
  private async historyCommitted(nav0: number, since: number): Promise<void> {
    const end = Date.now() + 30_000;
    for (;;) {
      const b = this.blockedMain as Blocked | null;
      if (b !== null && b.at >= since) throw forbidden(`navigation bloquée par le garde : ${b.reason} (${b.url})`);
      if (this.navCount !== nav0 && !this.navigating()) break;
      if (Date.now() > end) throw new GraspError(504, 'délai dépassé : la navigation n\'a pas abouti en 30 s');
      await sleep(25);
    }
    const rb = this.rebound as Blocked | null;
    if (rb !== null) throw forbidden(`navigation bloquée par le garde : ${rb.reason} (${rb.url})`);
    const f = this.mainFailed as { url: string; error: string | undefined; at: number } | null;
    if (f !== null && f.at >= since) throw new GraspError(502, `navigation échouée : ${f.error ?? 'page d\'erreur du navigateur'} (${redactUrl(f.url)})`);
  }

  /**
   * scroll [<sél>] [--by px | --to top|bottom] [--until-stable [--max-steps N]]. Défilement en code fixe du monde
   * isolé (autorisé avec allowEval=false) : la page reçoit ses événements scroll et ses IntersectionObserver comme
   * pour un défilement de l'utilisateur. Sans option : un écran (90 % de la hauteur visible) vers le bas ; un
   * sélecteur désigne le conteneur à faire défiler (s'il ne défile pas : son plus proche ancêtre défilant, sinon
   * la page ; sans --by/--to ni --until-stable, l'élément est seulement amené dans la vue). --until-stable : pas
   * successifs (jusqu'en bas, ou de --by), chacun suivi de l'attente de stabilité, jusqu'à ce qu'un pas n'ajoute
   * plus rien au bout de la zone (liste à défilement infini) ; plafonds annoncés. Compte rendu : position et
   * éléments DOM apparus (absents au départ, toujours présents), dans `scroll` et en note.
   */
  async scroll(sel: string | undefined, spec: ScrollSpec, opts: ActionOptions = {}): Promise<ActionResult & { scroll: ScrollReport }> {
    if (sel !== undefined && /^\s*frame=/.test(sel)) throw badRequest('scroll : sélecteur frame=… non pris en charge (défilement du document principal seulement)');
    const key = `__graspScroll${process.pid}_${++this.probeSeq}`;
    const maxSteps = spec.maxSteps ?? SCROLL_STEPS_DEFAULT;
    let id: number | undefined;
    const call = (op: string, by?: number, to?: string): Promise<ScrollMeasure> => id === undefined
      ? this.evalIsolated<ScrollMeasure>(`(${SCROLL_FN}).call(document, ${JSON.stringify(key)}, ${JSON.stringify(op)}, ${JSON.stringify(by ?? null)}, ${JSON.stringify(to ?? null)})`)
      : this.callIsolated<ScrollMeasure>(id, SCROLL_FN, key, op, by ?? null, to ?? null);
    let report: ScrollReport | undefined;
    let from = 0;
    let steps = 0;
    let settled: boolean | undefined;
    let stoppedBy: ScrollReport['stoppedBy'];
    const res = await this.act(opts, async (snap) => {
      if (sel !== undefined) id = await this.resolve(sel, snap);
      const init = await call('init');
      from = init.top;
      if (sel !== undefined && init.how !== 'element' && spec.by === undefined && spec.to === undefined && spec.untilStable !== true) {
        await call('into');
        steps = 1;
        return;
      }
      if (spec.untilStable !== true) {
        await call('step', spec.by, spec.to);
        steps = 1;
        return;
      }
      const up = spec.by !== undefined && spec.by < 0;
      const t0 = Date.now();
      let last = init;
      settled = false;
      for (;;) {
        if (steps >= maxSteps) { stoppedBy = 'steps'; break; }
        if (Date.now() - t0 > SCROLL_BUDGET_MS) { stoppedBy = 'budget'; break; }
        const tStep = Date.now();
        await call('step', spec.by, spec.by === undefined ? 'bottom' : undefined);
        steps++;
        // Ce que le pas a déclenché (requête de la page suivante, rendu) : attendu comme après une action.
        await this.waitStable(Math.min(this.limits.stableTimeoutMs, Math.max(0, SCROLL_BUDGET_MS - (Date.now() - t0))), { since: tStep, until: Date.now() + ACTION_WINDOW_MS });
        const m = await call('measure');
        if (m.lost === true) break;
        const grew = m.height > last.height || m.added > last.added;
        const atEnd = up ? m.top <= 0 : m.top >= m.max - 1;
        last = m;
        if (!grew && atEnd) { settled = true; break; }
      }
    }, async () => {
      const m = await call('done');
      report = m.lost === true
        ? { how: 'page', from, to: from, max: 0, height: 0, added: null, steps }
        : { how: m.how, from, to: m.top, max: m.max, height: m.height, added: m.added, steps };
      if (settled !== undefined) report.settled = settled;
      if (stoppedBy !== undefined) report.stoppedBy = stoppedBy;
      return scrollNote(report, maxSteps) + (m.rootLost === true ? ` (zone ${sel ?? ''} retirée de la page : compte fait sur tout le document)` : '');
    });
    // Compte rendu impossible (page remplacée pendant le défilement) : dit, jamais un faux zéro.
    if (report === undefined) {
      report = { how: 'page', from, to: from, max: 0, height: 0, added: null, steps };
      res.detail = [res.detail, scrollNote(report, maxSteps)].filter((x) => x !== undefined && x !== '').join(' ; ');
    }
    return { ...res, scroll: report };
  }

  /**
   * Snapshot d'accessibilité. `maxBytes` : budget en octets (défaut `snapMax`). `scope` (ref, CSS, text:) :
   * seules les lignes du sous-arbre de cet élément, avec les mêmes refs que le snapshot complet.
   */
  async snapshot(opts: { maxBytes?: number | undefined; scope?: string | undefined; nameMax?: number | undefined; mode?: SnapMode | undefined; find?: FindSpec | undefined } = {}): Promise<Snapshot> {
    if (opts.nameMax !== undefined && (!Number.isInteger(opts.nameMax) || opts.nameMax < 0)) throw badRequest('name-max : entier positif ou nul attendu (0 = noms entiers)');
    const scope = opts.scope !== undefined && opts.scope.trim() !== '' ? opts.scope.trim() : undefined;
    const scopeBackendId = scope !== undefined ? await this.resolve(scope) : undefined;
    // Arbre, historique (URL) et monde isolé en un aller-retour ; puis les deux relevés DOM en parallèle.
    const [{ nodes }, hist] = await Promise.all([
      this.s<{ nodes: AXNode[] }>('Accessibility.getFullAXTree'),
      this.s<{ currentIndex: number; entries: Array<{ url: string; title: string }> }>('Page.getNavigationHistory'),
      this.isolatedContext().catch(() => undefined),
    ]);
    this.scrubSecrets(nodes);
    const [formErrors, sourceTexts] = await Promise.all([
      this.formErrors(scopeBackendId),
      PageController.mayBeTransformed(nodes) ? this.sourceTexts(nodes) : Promise.resolve(undefined),
    ]);
    const cur = hist.entries[hist.currentIndex];
    const url = cur?.url ?? 'about:blank';
    // Titre COURANT : nom de la racine de l'arbre (document.title, à jour après une route SPA), sans appel de plus.
    const root = nodes.find((n) => n.parentId === undefined);
    // Racine sans nom (moteurs CDP autres que Chrome, ex. Obscura ; ou page sans titre) : document.title relu.
    const rootName = root !== undefined && root.role?.value === 'RootWebArea' && typeof root.name?.value === 'string' ? root.name.value : '';
    const title = rootName !== '' ? rootName : (await this.location()).title;
    const snap = buildSnapshot(nodes, { url, title, maxBytes: opts.maxBytes ?? this.limits.snapMax, ...(opts.nameMax !== undefined ? { nameMax: opts.nameMax } : {}), ...(formErrors !== undefined ? { formErrors } : {}), ...(sourceTexts !== undefined ? { sourceTexts } : {}), ...(scopeBackendId !== undefined ? { scopeBackendId } : {}), ...(opts.mode !== undefined ? { mode: opts.mode } : {}), ...(opts.find !== undefined ? { find: opts.find } : {}) });
    this.remember(snap);
    if (scope !== undefined && snap.scopeFound !== true) throw notFound(`la zone ${scope} n'a pas de nœud dans l'arbre d'accessibilité (élément masqué ou retiré ?)`);
    return snap;
  }

  /**
   * Texte de `snap`. Zone frame=… : arbre ARIA du cadre par le moteur Playwright (même d'une autre origine),
   * sans refs (elles ne désignent que le document principal) ; on agit dans le cadre avec frame=… >> css|text:.
   */
  async snapText(opts: { maxBytes?: number | undefined; scope?: string | undefined; nameMax?: number | undefined; mode?: SnapMode | undefined; find?: FindSpec | undefined } = {}): Promise<string> {
    if (opts.scope === undefined || parseFrameTarget(opts.scope) === null) return (await this.snapshot(opts)).text;
    // Lecture partielle et find reposent sur les refs, que l'arbre ARIA d'un cadre n'a pas : refusé, jamais ignoré.
    if (opts.find !== undefined || opts.mode !== undefined) throw badRequest(`${opts.find !== undefined ? 'find' : `snap --${opts.mode}`} ne s'applique pas à une zone frame=… (arbre ARIA sans refs) : snap --scope '${opts.scope.trim()}'`);
    const scope = opts.scope.trim();
    const aria = await this.pwUse(async (page) => {
      const { loc } = await this.pwLocator(page, scope, undefined, 'body');
      try { return await loc.ariaSnapshot({ timeout: PW_ACTION_TIMEOUT_MS }); } catch (e) { throw pwError(e, 'snap'); }
    });
    const frames = scope.split(/\s*>>\s*/).filter((x) => x.startsWith('frame=')).join(' >> ');
    return truncateText(`cadre ${scope} (arbre ARIA de Playwright, sans refs : agissez avec « ${frames} >> <css|text:…> »)\n${this.secretRedactor.redact(aria)}`, opts.maxBytes ?? this.limits.snapMax, { wholeLines: true });
  }

  /**
   * Texte que text-transform a pu changer : un nom de StaticText tout en majuscules (2 lettres au moins), ou
   * de 2 mots au moins tous capitalisés. Sinon le relevé du texte source (coûteux) n'est pas lancé.
   */
  private static mayBeTransformed(nodes: AXNode[]): boolean {
    for (const n of nodes) {
      if (n.role?.value !== 'StaticText' || n.ignored === true) continue;
      const t = typeof n.name?.value === 'string' ? n.name.value : '';
      if (!/\p{L}.*\p{L}/su.test(t)) continue;
      if (t === t.toUpperCase() && t !== t.toLowerCase()) return true;
      const w = t.trim().split(/\s+/).filter((x) => /^\p{L}/u.test(x));
      if (w.length >= 2 && w.every((x) => x[0] === x[0]!.toUpperCase() && x[0] !== x[0]!.toLowerCase())) return true;
    }
    return false;
  }

  /**
   * Erreurs de formulaire relevées dans le DOM sous `root` (défaut : le document), code fixe dans le monde
   * isolé de lecture. Enrichissement du snapshot : un échec (navigation en cours, contexte détruit) ne fait
   * jamais échouer la lecture ; il donne `undefined` : le snapshot s'en tient alors à l'arbre d'accessibilité
   * (un relevé vide effacerait tous les [invalide]).
   */
  private async formErrors(root?: number): Promise<FormErrors | undefined> {
    const group = 'grasp-erreurs';
    try {
      const ctx = await this.isolatedContext();
      type Res = { result: { objectId?: string }; exceptionDetails?: unknown };
      let res: Res;
      if (root === undefined) {
        res = await this.s<Res>('Runtime.evaluate', { contextId: ctx, expression: `(${FORM_ERRORS_FN})(document)`, objectGroup: group });
      } else {
        const { object } = await this.s<{ object: { objectId: string } }>('DOM.resolveNode', { backendNodeId: root, executionContextId: ctx, objectGroup: group });
        res = await this.s<Res>('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: `function () { return (${FORM_ERRORS_FN})(this); }`, objectGroup: group });
      }
      if (res.exceptionDetails !== undefined || res.result.objectId === undefined) return undefined;
      type Props = { result: Array<{ name: string; value?: { value?: unknown; objectId?: string } }> };
      const props = await this.s<Props>('Runtime.getProperties', { objectId: res.result.objectId, ownProperties: true });
      const meta = JSON.parse(String(props.result.find((p) => p.name === 'meta')?.value?.value ?? '{}')) as { fields?: Array<{ i: number; t: string; s?: string }>; alerts?: string[] };
      const fields = new Map<number, string>();
      const unlinked = new Set<number>();
      const uninvalid = new Set<number>();
      const elsId = props.result.find((p) => p.name === 'els')?.value?.objectId;
      if (elsId !== undefined && meta.fields !== undefined && meta.fields.length > 0) {
        const items = await this.s<Props>('Runtime.getProperties', { objectId: elsId, ownProperties: true });
        const byIndex = new Map(items.result.filter((p) => /^\d+$/.test(p.name)).map((p) => [Number(p.name), p.value?.objectId]));
        for (const f of meta.fields) {
          const objectId = byIndex.get(f.i);
          if (objectId === undefined) continue;
          const { node } = await this.s<{ node: { backendNodeId: number } }>('DOM.describeNode', { objectId });
          fields.set(node.backendNodeId, f.t);
          if (f.s === 'voisin') unlinked.add(node.backendNodeId);
          if (f.s === 'decrit') uninvalid.add(node.backendNodeId);
        }
      }
      return { fields, alerts: Array.isArray(meta.alerts) ? meta.alerts : [], unlinked, uninvalid };
    } catch {
      this.isoCtx = undefined;
      return undefined;
    } finally { void this.s('Runtime.releaseObjectGroup', { objectGroup: group }).catch(() => undefined); }
  }

  /**
   * Texte DOM des nœuds texte sous text-transform (backendDOMNodeId du StaticText → texte), dans le monde
   * isolé de lecture. Un appel : les textes transformés du DOM sont rapprochés des StaticText de l'arbre par
   * contenu (transformation appliquée au texte source = nom de l'arbre) ; deux sources différentes pour un
   * même texte affiché : aucune n'est retenue. Enrichissement du snapshot : un échec donne un relevé vide,
   * jamais une erreur ; les refs n'en dépendent pas (hash sur le nom brut de l'arbre), seul l'affichage change.
   */
  private async sourceTexts(nodes: AXNode[]): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    let pairs: Array<[string, string]>;
    try { pairs = JSON.parse(await this.evalIsolated<string>(`(${SOURCE_TEXTS_FN})()`)) as Array<[string, string]>; } catch { return out; }
    const bySeen = new Map(pairs);
    if (bySeen.size === 0) return out;
    for (const n of nodes) {
      if (n.role?.value !== 'StaticText' || n.backendDOMNodeId === undefined) continue;
      const src = bySeen.get((typeof n.name?.value === 'string' ? n.name.value : '').replace(/\s+/g, ' ').trim());
      if (src !== undefined) out.set(n.backendDOMNodeId, this.secretRedactor.redact(src));
    }
    return out;
  }

  /**
   * Après un clic sur un bouton : champs invalides de son formulaire (form, dialogue, sinon la page),
   * en lignes de snapshot. Vide si l'élément n'est pas un bouton ou n'existe plus (navigation).
   */
  private async invalidAround(id: number): Promise<string[]> {
    const group = 'grasp-erreurs';
    let container: number | undefined;
    try {
      const { object } = await this.s<{ object: { objectId: string } }>('DOM.resolveNode', { backendNodeId: id, objectGroup: group });
      const r = await this.s<{ result: { objectId?: string; subtype?: string } }>('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: BUTTON_FORM_FN, objectGroup: group });
      if (r.result.objectId === undefined) return [];
      container = (await this.s<{ node: { backendNodeId: number } }>('DOM.describeNode', { objectId: r.result.objectId })).node.backendNodeId;
    } catch { return []; } finally { void this.s('Runtime.releaseObjectGroup', { objectGroup: group }).catch(() => undefined); }
    const around = await this.formErrors(container);
    if (around === undefined || around.fields.size === 0) return [];
    const snap = await this.snapshot();
    return snap.invalid.filter((i) => i.backendId !== undefined && around.fields.has(i.backendId)).map((i) => i.line);
  }

  /** Mémorise (rôle, nom) de chaque ref remise à l'agent ; borné, les plus anciennes sortent d'abord. */
  private remember(snap: Snapshot): void {
    for (const [ref, m] of snap.meta) { this.knownRefs.delete(ref); this.knownRefs.set(ref, { role: m.role, name: m.name, key: m.alt ?? m.name, id: snap.refs.get(ref), doc: this.docGen }); }
    for (const k of this.knownRefs.keys()) {
      if (this.knownRefs.size <= KNOWN_REFS_MAX) break;
      this.knownRefs.delete(k);
    }
  }

  /**
   * innerText de la page (ou de la zone `scope`), coupé à `max` caractères (défaut `textMax`) avec une ligne
   * explicite. `markdown` : le contenu visible converti en Markdown (code fixe, monde isolé), même budget.
   */
  async text(max?: number, scope?: string, opts: { markdown?: boolean } = {}): Promise<string> {
    const md = opts.markdown === true;
    let t: string;
    if (scope !== undefined && parseFrameTarget(scope) !== null) {
      // Cadre (même d'une autre origine) : lu par le moteur Playwright.
      t = await this.pwUse(async (page) => {
        const { loc } = await this.pwLocator(page, scope, undefined, 'body');
        try {
          // Markdown dans un cadre : même fonction fixe, évaluée par Playwright dans le monde de la page du cadre.
          if (md) return await loc.evaluate<string>(markdownInPage(), undefined, { timeout: PW_ACTION_TIMEOUT_MS });
          return await loc.innerText({ timeout: PW_ACTION_TIMEOUT_MS });
        } catch (e) { throw pwError(e, 'text'); }
      });
    } else if (scope !== undefined && scope.trim() !== '') {
      const id = await this.resolve(scope.trim());
      const r = await this.callIsolated<{ text?: string; frame?: boolean; src?: string }>(id, md ? SCOPE_MARKDOWN_FN : SCOPE_TEXT_FN);
      if (r.text === undefined) {
        // Cadre d'une autre origine (ou hors processus) : son document n'est pas accessible depuis la page.
        const src = r.src !== undefined && r.src !== '' ? redactUrl(r.src, 300) : '(sans src)';
        throw conflict(`la zone ${scope.trim()} est une iframe d'une autre origine (${src}) : son contenu n'est pas lisible depuis la page — pour le lire : grasp text${md ? ' --markdown' : ''} --scope 'frame=${scope.trim()}' (moteur Playwright, npm i playwright-core), ou grasp nav <URL du cadre> (si l'allowlist l'autorise)`);
      }
      t = r.text;
    } else if (md) {
      t = await this.evalIsolated<string | undefined>(`(${MARKDOWN_FN})(document.body)`) ?? '';
    } else {
      const r = await this.s<{ result: { value?: string } }>('Runtime.evaluate', { expression: 'document.body ? document.body.innerText : ""', returnByValue: true });
      t = r.result.value ?? '';
    }
    return truncateText(this.secretRedactor.redact(t), max ?? this.limits.textMax);
  }

  /**
   * Arbre d'accessibilité : un champ rempli avec un secret rend `secret:NOM` (même si la page a tronqué la
   * valeur, maxlength) ; ailleurs, toute valeur saisie dans la session est masquée avant la coupure des noms.
   */
  private scrubSecrets(nodes: AXNode[]): void {
    if (this.secretRedactor.size === 0) return;
    const r = this.secretRedactor;
    for (const n of nodes) {
      const own = n.backendDOMNodeId !== undefined ? this.secretNodes.get(n.backendDOMNodeId) : undefined;
      if (own !== undefined && n.value !== undefined && n.value.value !== undefined && n.value.value !== '') n.value = { ...n.value, value: `secret:${own}` };
      for (const k of ['name', 'value', 'description'] as const) {
        const v = n[k];
        if (v !== undefined && typeof v.value === 'string') n[k] = { ...v, value: r.redact(v.value) };
      }
    }
  }

  /**
   * Secret : la page courante doit être sur l'un de ses domaines (vérifié juste avant la saisie). La valeur
   * n'est connue du bridge qu'à partir d'ici, pour être masquée dans toutes ses sorties.
   */
  private async assertSecretDomain(secret: SecretUse, sel: string): Promise<void> {
    if (parseFrameTarget(sel) !== null) throw badRequest(`secret:${secret.name} : saisie dans une iframe (frame=…) non prise en charge — le domaine contrôlé est celui de la page`);
    const { url } = await this.location();
    if (!secretAllowedOn(secret.domains, url)) {
      let host = url;
      try { host = new URL(url).host || url; } catch { /* about:blank */ }
      throw forbidden(`secret:${secret.name} réservé à ${secret.domains.join(', ')} : la page courante est sur ${redactUrl(host, 120)} — rien n'a été saisi`);
    }
  }

  // ---------- Monde isolé de lecture : stabilité, wait, text --scope (code fixe, jamais celui de l'agent) ----------

  private async isolatedContext(): Promise<number> {
    if (this.isoCtx !== undefined) return this.isoCtx;
    const { executionContextId } = await this.s<{ executionContextId: number }>('Page.createIsolatedWorld', { frameId: this.mainFrameId, worldName: 'grasp-lecture', grantUniveralAccess: false });
    this.isoCtx = executionContextId;
    return executionContextId;
  }

  /**
   * Évalue du code FIXE de Grasp dans le monde isolé de lecture ; les données de l'agent n'y entrent
   * que sérialisées en JSON. Un contexte périmé (navigation) est recréé une fois.
   */
  private async evalIsolated<T>(expression: string, awaitPromise = false): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const ctx = await this.isolatedContext();
      let r: { result: { value?: unknown }; exceptionDetails?: { text: string; exception?: { description?: string } } };
      try {
        r = await this.s('Runtime.evaluate', { contextId: ctx, expression, returnByValue: true, awaitPromise });
      } catch (e) {
        this.isoCtx = undefined;
        if (attempt >= 1) throw e;
        continue;
      }
      if (r.exceptionDetails) throw new GraspError(500, `script interne de Grasp en échec : ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
      return r.result.value as T;
    }
  }

  /** Appelle une fonction fixe sur un nœud, dans le monde isolé de lecture. */
  private async callIsolated<T>(backendNodeId: number, fn: string, ...args: unknown[]): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const ctx = await this.isolatedContext();
      let objectId: string;
      try {
        ({ object: { objectId } } = await this.s<{ object: { objectId: string } }>('DOM.resolveNode', { backendNodeId, executionContextId: ctx }));
      } catch {
        this.isoCtx = undefined;
        if (attempt >= 1) throw notFound("l'élément n'existe plus — refaites `snap`");
        continue;
      }
      try {
        const r = await this.s<{ result: { value?: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>('Runtime.callFunctionOn', { objectId, functionDeclaration: fn, arguments: args.map((value) => ({ value })), returnByValue: true });
        if (r.exceptionDetails) throw new GraspError(500, `script interne de Grasp en échec : ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
        return r.result.value as T;
      } finally { void this.s('Runtime.releaseObject', { objectId }).catch(() => undefined); }
    }
  }

  /**
   * Requêtes qui comptent pour une attente : parties depuis `since` ; avec `until` (action), parties avant
   * `until`, ou enchaînées à une requête comptée. Hors fenêtre d'action, un polling périodique ne compte pas.
   */
  private counted(o: StableOptions): TrackedRequest[] {
    const since = o.since ?? 0;
    const out: TrackedRequest[] = [];
    for (const r of this.net.values()) {
      if (r.start < since) continue;
      if (o.until !== undefined && r.start <= o.until) { out.push(r); continue; }
      if (r.periodic) continue;
      if (o.until === undefined || out.some((c) => c.end !== undefined && r.start >= c.end && r.start - c.end <= CHAIN_MS)) out.push(r);
    }
    return out;
  }

  /**
   * Requêtes en vol qui comptent, hors requêtes de longue durée (long-polling, flux) : LONG_REQUEST_MS, ou
   * ACTION_REQUEST_MS pour une requête partie dans la fenêtre de l'action.
   */
  private activeRequests(o: StableOptions): number {
    const now = Date.now();
    let n = 0;
    for (const r of this.counted(o)) {
      const limit = o.until !== undefined && r.start <= o.until ? ACTION_REQUEST_MS : LONG_REQUEST_MS;
      if (r.end === undefined && now - r.start < limit) n++;
    }
    return n;
  }

  /** Requête partie dans la fenêtre d'attribution d'une action, encore en vol (dans ACTION_REQUEST_MS). */
  private actionInFlight(o: StableOptions): boolean {
    const until = o.until;
    if (until === undefined) return false;
    const now = Date.now();
    return this.counted(o).some((r) => r.start <= until && r.end === undefined && now - r.start < ACTION_REQUEST_MS);
  }

  /** Activité réseau (départ ou fin d'une requête qui compte) après l'instant `after`. */
  private netActiveAfter(o: StableOptions, after: number): boolean {
    return this.counted(o).some((r) => r.start > after || (r.end !== undefined && r.end > after));
  }

  /** Navigation de document en cours ou demandée (location.replace, lien, formulaire). */
  private navigating(): boolean {
    return this.loading || (this.pendingNavAt !== 0 && Date.now() - this.pendingNavAt < 1500);
  }

  /**
   * Attend que la page soit STABLE : ni mutation du DOM (MutationObserver dans un monde isolé) ni activité
   * réseau pendant STABLE_QUIET_MS, aucune requête en vol (partie depuis `o.since`), aucune navigation en cours
   * — au plus `capMs`. Une navigation de document qui démarre pendant l'attente est suivie : on attend la fin du
   * chargement et on recommence avec le temps restant. `o.challenge` : une page de challenge anti-bot stable
   * est guettée jusqu'à sa redirection. Ne lève jamais : le résultat dit si la page est stable.
   */
  private async waitStable(capMs = this.limits.stableTimeoutMs, o: StableOptions = {}): Promise<Stability> {
    const t0 = Date.now();
    let mutations = 0;
    let error: string | undefined;
    let weakDone = false;
    /** Depuis quand le DOM est calme alors que seul le réseau empêche de conclure (requêtes de fond). */
    let netOnlySince: number | undefined;
    if (capMs <= 0) return { stable: true, ms: 0, mutations: 0 };
    const elapsed = () => Date.now() - t0;
    const unstable = (extra: Partial<Stability> = {}): Stability => {
      const requests = this.activeRequests(o);
      return { stable: false, ms: elapsed(), mutations, ...(error !== undefined ? { error } : {}), ...(requests > 0 ? { requests } : {}), ...extra };
    };
    for (;;) {
      if (capMs - elapsed() <= 0) return unstable();
      // Navigation de document en cours : on attend la fin du chargement (le nouveau document repart de zéro).
      if (this.navigating()) { netOnlySince = undefined; await this.settle(Math.max(0, capMs - elapsed())); continue; }
      // Requête déclenchée par l'action encore en vol (« Enregistrer ») : sa réponse mettra le DOM à jour, on
      // l'attend. Les autres requêtes en vol n'empêchent pas d'observer le DOM en même temps (voir plus bas).
      if (this.actionInFlight(o)) { netOnlySince = undefined; await sleep(Math.min(25, Math.max(1, capMs - elapsed()))); continue; }
      const left = capMs - elapsed();
      let timer: NodeJS.Timeout | undefined;
      let r: { stable: boolean; mutations: number; ongoing?: boolean };
      try {
        r = await Promise.race([
          this.evalIsolated<{ stable: boolean; mutations: number; ongoing?: boolean }>(`(${STABLE_FN})(${STABLE_QUIET_MS}, ${left}, ${STABLE_LENIENT_MS})`, true),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('le navigateur ne répond pas')), left + 3000); }),
        ]);
      } catch (e) {
        // Navigation pendant l'attente (contexte détruit) : on attend la fin du chargement, puis on recommence.
        error = (e as Error).message;
        mutations++;
        this.isoCtx = undefined;
        await this.settle(Math.max(0, capMs - elapsed()));
        continue;
      } finally { clearTimeout(timer); }
      mutations += r.mutations;
      if (!r.stable) return unstable();
      if (r.mutations > 0 || r.ongoing === true) netOnlySince = undefined;
      // DOM calme : encore faut-il que le réseau l'ait été pendant la même fenêtre, et qu'aucune navigation
      // n'ait démarré (redirection JS juste après le load) — sinon on recommence.
      if (this.navigating()) { netOnlySince = undefined; continue; }
      if (this.activeRequests(o) > 0 || this.netActiveAfter(o, Date.now() - STABLE_QUIET_MS)) {
        // DOM calme, réseau agité : on recommence, mais pas indéfiniment (requêtes de fond).
        netOnlySince ??= Date.now() - STABLE_QUIET_MS;
        if (this.actionInFlight(o) || Date.now() - netOnlySince < NET_BACKGROUND_MS) continue;
        return { stable: true, ms: elapsed(), mutations, background: true };
      }
      const ch = o.challenge === true && !weakDone ? await this.evalIsolated<string>(`(${CHALLENGE_FN})()`).catch(() => '') : '';
      if (ch === 'strong' || ch === 'weak') {
        // Challenge anti-bot : il se remplace lui-même par la vraie page ; on guette cette navigation (indice
        // faible : brièvement, et sans rien affirmer).
        const m = this.mark();
        const end = ch === 'strong' ? t0 + capMs : Math.min(t0 + capMs, Date.now() + WEAK_CHALLENGE_MS);
        while (!this.navigatedSince(m) && !this.navigating() && end - Date.now() > 0) await sleep(Math.min(50, Math.max(1, end - Date.now())));
        if (this.navigatedSince(m) || this.navigating()) continue;
        if (ch === 'strong') return unstable({ challenge: true });
        weakDone = true;
      }
      return { stable: true, ms: elapsed(), mutations, ...(r.ongoing === true ? { ongoing: true } : {}) };
    }
  }

  /**
   * `grasp wait` : --text (texte visible), --sel (élément visible : CSS, ou présent : ref / text:), --idle
   * (DOM stable, défaut). Délai dépassé = 504 qui dit ce qui manque.
   */
  async wait(o: WaitOptions): Promise<WaitResult> {
    const modes = [o.text !== undefined, o.sel !== undefined, o.idle === true].filter((x) => x).length;
    if (modes > 1) throw badRequest('wait : une seule condition à la fois (--text, --sel ou --idle)');
    if (o.text !== undefined && o.text.trim() === '') throw badRequest('wait --text attend un texte non vide');
    if (o.sel !== undefined && o.sel.trim() === '') throw badRequest('wait --sel attend un sélecteur');
    if (o.timeout !== undefined && (!Number.isInteger(o.timeout) || o.timeout < 1 || o.timeout > WAIT_MAX_MS)) throw badRequest(`timeout : entier de 1 à ${WAIT_MAX_MS} ms attendu`);
    const t0 = Date.now();
    if (o.text === undefined && o.sel === undefined) {
      const cap = o.timeout ?? (this.limits.stableTimeoutMs > 0 ? this.limits.stableTimeoutMs : DEFAULT_LIMITS.stableTimeoutMs);
      // Réseau ET DOM : requêtes en vol comprises (même parties avant l'appel), 400 ms de calme exigées.
      const st = await this.waitStable(cap);
      if (!st.stable) throw new GraspError(504, `${PageController.unstableNote(st).replace(/ : la page peut encore changer$/, '')} — --timeout <ms> pour attendre plus longtemps`);
      return { ok: true, waited: Date.now() - t0, condition: 'idle' };
    }
    const timeout = o.timeout ?? WAIT_DEFAULT_MS;
    if (o.sel !== undefined && parseFrameTarget(o.sel) !== null) {
      // Élément visible dans un cadre (même d'une autre origine) : attente du moteur Playwright.
      const sel = o.sel;
      await this.pwUse(async (page) => {
        const { loc } = await this.pwLocator(page, sel, undefined, 'body');
        try { await loc.waitFor({ state: 'visible', timeout }); } catch (e) {
          const ge = pwError(e, 'wait');
          throw ge.status === 504 ? new GraspError(504, `${sel} absent ou invisible après ${timeout} ms`) : ge;
        }
      });
      return { ok: true, waited: Date.now() - t0, condition: 'sel' };
    }
    const end = t0 + timeout;
    let state: 'absent' | 'hidden' = 'absent';
    let lastErr: string | undefined;
    for (;;) {
      let r: 'ok' | 'absent' | 'hidden';
      try { r = o.text !== undefined ? await this.hasText(o.text) : await this.hasSel(o.sel!.trim()); lastErr = undefined; } catch (e) {
        if (e instanceof GraspError && e.status === 400) throw e;
        // Navigation en cours, document qui se recharge : on réessaie jusqu'au délai.
        r = 'absent';
        lastErr = (e as Error).message;
      }
      if (r === 'ok') return { ok: true, waited: Date.now() - t0, condition: o.text !== undefined ? 'text' : 'sel' };
      state = r;
      const left = end - Date.now();
      if (left <= 0) break;
      await sleep(Math.min(100, left));
    }
    const why = lastErr !== undefined ? ` (dernière erreur : ${lastErr})` : '';
    if (o.text !== undefined) throw new GraspError(504, `« ${o.text} » absent de la page après ${timeout} ms${why}`);
    throw new GraspError(504, `${state === 'hidden' ? `${o.sel} présent mais invisible` : `aucun élément ne correspond à ${o.sel}`} après ${timeout} ms${why}`);
  }

  private async hasText(t: string): Promise<'ok' | 'absent'> {
    if (this.secretRedactor.size > 0) {
      // Secret saisi dans la session : comparaison sur le texte masqué (pas d'oracle sur une valeur recopiée).
      const n = (s: string) => s.replace(/\s+/g, ' ');
      const body = await this.evalIsolated<string>('document.body ? document.body.innerText : ""');
      return n(this.secretRedactor.redact(body ?? '')).includes(n(t)) ? 'ok' : 'absent';
    }
    const found = await this.evalIsolated<boolean>(`((t) => { const n = (s) => s.replace(/\\s+/g, ' '); return !!document.body && n(document.body.innerText).includes(n(t)); })(${JSON.stringify(t)})`);
    return found ? 'ok' : 'absent';
  }

  private async hasSel(sel: string): Promise<'ok' | 'absent' | 'hidden'> {
    if (REF_RE.test(sel) || sel.startsWith('text:')) {
      // Ref ou texte accessible : présent dans le snapshot. Une ambiguïté de text: veut dire « présent » ; un
      // 409 sur une ref veut dire que SON élément n'est plus là (seuls des homonymes subsistent) : absent.
      try { await this.resolve(sel); return 'ok'; } catch (e) {
        if (e instanceof GraspError && e.status === 409) return REF_RE.test(sel) ? 'absent' : 'ok';
        if (e instanceof GraspError && e.status === 404) return 'absent';
        throw e;
      }
    }
    const css = sel.startsWith('css:') ? sel.slice(4) : sel;
    const r = await this.evalIsolated<number>(`((s) => {
      let els; try { els = document.querySelectorAll(s); } catch { return -1; }
      for (const el of els) if (el.checkVisibility ? el.checkVisibility() : el.getClientRects().length > 0) return 1;
      return els.length > 0 ? 2 : 0;
    })(${JSON.stringify(css)})`);
    if (r === -1) throw badRequest(`sélecteur CSS invalide : ${css}`);
    return r === 1 ? 'ok' : r === 2 ? 'hidden' : 'absent';
  }

  // ---------- Assertions de recette (expect) : lecture seule, code fixe ----------

  /**
   * Vérifie une assertion. text, no-text, url, title, sel, no-sel, value : relues toutes les 100 ms jusqu'au
   * délai (5000 ms par défaut, 0 = une lecture) ; console et formulaire : constat immédiat. Échec = 417 dont le
   * message dit l'attendu et le constaté (extrait borné), détail dans `expect` ; --shot-on-error y joint une capture.
   */
  async expect(spec: ExpectSpec, opts: { shotOnError?: boolean | undefined } = {}): Promise<ExpectResult> {
    try { return await this.expectOnce(spec); } catch (e) {
      throw await this.decorate(e, { shotOnError: opts.shotOnError === true }, 0);
    }
  }

  private async expectOnce(spec: ExpectSpec): Promise<ExpectResult> {
    const t0 = Date.now();
    const fail = (observed: string, items?: string[]) => new GraspError(417, `attendu ${describeExpected(spec)} ; constaté : ${observed}`, { expect: { kind: spec.kind, expected: describeExpected(spec), observed, ...(items !== undefined ? { items } : {}) } });
    const list = (items: string[]) => `${items.slice(0, 5).join(' | ')}${items.length > 5 ? ` | … et ${items.length - 5} autre(s)` : ''}`;
    if (spec.kind === 'no-console-errors') {
      this.assertConsole();
      let since = spec.since ?? this.docSeq;
      let note: string | undefined;
      if (since > this.consoleBuf.seq) {
        note = `tampon console recréé (seq ${since} > seq courant ${this.consoleBuf.seq}) : erreurs relues depuis le début du tampon`;
        since = 0;
      }
      const ignore = spec.ignore !== undefined ? compileRegex(spec.ignore) : undefined;
      const r = this.consoleBuf.query({ since, level: 'error', limit: 1000 });
      const errs = r.entries.filter((e) => e.source !== 'navigation' && e.level === 'error' && !(ignore !== undefined && (ignore.test(e.text) || (e.url !== undefined && ignore.test(e.url)))));
      if (errs.length > 0) {
        const items = errs.map(formatEntry);
        throw fail(`${errs.length} erreur(s) depuis #${since} : ${list(items)}`, items.slice(0, 50));
      }
      return { ok: true, kind: spec.kind, waited: Date.now() - t0, ...(note !== undefined ? { detail: note } : {}) };
    }
    if (spec.kind === 'a11y') {
      if (spec.scope !== undefined && parseFrameTarget(spec.scope) !== null) throw badRequest('expect a11y --scope : zone frame=… non prise en charge');
      const r = await this.a11y({ scope: spec.scope, max: 50 });
      const tolerated = spec.max ?? 0;
      const items = r.issues.map((i) => `${i.kind} ${i.who} — ${i.detail}`);
      const counts = A11Y_KINDS.filter((k) => (r.counts[k] ?? 0) > 0).map((k) => `${k} ${r.counts[k]}`).join(', ');
      if (r.total > tolerated) throw fail(`${r.total} problème(s) (${counts}) : ${list(items)}`, items.slice(0, 50));
      return { ok: true, kind: spec.kind, waited: Date.now() - t0, ...(r.total > 0 ? { detail: `${r.total} problème(s) d'accessibilité toléré(s) (--max ${tolerated}) : ${counts}` } : {}) };
    }
    if (spec.kind === 'no-form-errors') {
      const items = await this.formErrorLines();
      if (items.length > 0) throw fail(`${items.length} erreur(s) : ${list(items)}`, items.slice(0, 50));
      return { ok: true, kind: spec.kind, waited: Date.now() - t0 };
    }
    if (!POLLED.has(spec.kind)) throw badRequest(`assertion inconnue ${spec.kind}`);
    if (spec.target !== undefined && parseFrameTarget(spec.target) !== null) throw badRequest(`expect ${spec.kind} : sélecteur frame=… non pris en charge — wait --sel '${spec.target}' pour un élément dans un cadre`);
    if (spec.scope !== undefined && parseFrameTarget(spec.scope) !== null) throw badRequest(`expect ${spec.kind} --scope : zone frame=… non prise en charge`);
    const timeout = spec.timeout ?? EXPECT_DEFAULT_MS;
    const end = t0 + timeout;
    let observed = '';
    for (;;) {
      let r: { ok: boolean; observed: string };
      try { r = await this.observe(spec); } catch (e) {
        // Erreur du script (sélecteur invalide, ambigu, interdit) : immédiate. Page en transition : on relit.
        if (e instanceof GraspError && [400, 403, 409].includes(e.status)) throw e;
        r = { ok: false, observed: `lecture impossible (${(e as Error).message})` };
      }
      if (r.ok) return { ok: true, kind: spec.kind, waited: Date.now() - t0 };
      observed = r.observed;
      const left = end - Date.now();
      if (left <= 0) break;
      await sleep(Math.min(100, left));
    }
    throw fail(`${observed}${timeout > 0 ? ` (après ${timeout} ms)` : ''}`);
  }

  /** Une lecture de l'assertion : tenue ou non, et ce qui a été constaté (borné, une ligne). */
  private async observe(spec: ExpectSpec): Promise<{ ok: boolean; observed: string }> {
    const short = (v: string) => `« ${v.length > 300 ? `${v.slice(0, 300)}…` : v} »`;
    switch (spec.kind) {
      case 'text': case 'no-text': {
        const zone = spec.scope !== undefined ? 'de la zone' : 'de la page';
        const raw = spec.scope !== undefined ? await this.text(EXPECT_TEXT_MAX, spec.scope) : await this.evalIsolated<string>(`document.body ? document.body.innerText.slice(0, ${EXPECT_TEXT_MAX}) : ''`);
        // Comparé sur le texte MASQUÉ : sinon `--regex '^préfixe'` servirait d'oracle sur un secret recopié.
        const t = normSpace(this.secretRedactor.redact(raw));
        const f = findText(t, spec);
        if (spec.kind === 'text') return { ok: f.index >= 0, observed: t === '' ? `aucun texte visible ${zone === 'de la zone' ? 'dans la zone' : 'dans la page'}` : `absent ; texte ${zone} : ${excerpt(t)}` };
        return { ok: f.index < 0, observed: `présent : ${around(t, f.index, f.length)}` };
      }
      case 'url': case 'title': {
        const loc = await this.location();
        const v = this.secretRedactor.redact(spec.kind === 'url' ? loc.url : loc.title);
        return { ok: matchValue(v, spec), observed: short(v) };
      }
      case 'sel': case 'no-sel': {
        const st = await this.hasSel(spec.target!);
        const desc = st === 'ok' ? 'visible' : st === 'hidden' ? 'présent mais invisible' : 'aucun élément ne correspond';
        return { ok: spec.kind === 'sel' ? st === 'ok' : st !== 'ok', observed: desc };
      }
      case 'value': {
        let id: number;
        try { id = await this.resolve(spec.target!); } catch (e) {
          if (e instanceof GraspError && e.status === 404) return { ok: false, observed: e.message };
          throw e;
        }
        const raw = await this.callIsolated<string>(id, VALUE_FN);
        // Champ marqué (fill … secret:NOM) : seule sa forme masquée est comparée, `secret:NOM` (même valeur
        // reformatée ou tronquée par la page) ; sinon ~ et --regex reconstitueraient la valeur caractère par caractère.
        const own = this.secretNodes.get(id);
        const v = own !== undefined && raw !== '' ? `secret:${own}` : this.secretRedactor.redact(raw);
        return { ok: matchValue(v, spec), observed: short(v) };
      }
      case 'request': return this.observeRequest(spec);
      default: throw badRequest(`assertion ${spec.kind} non relue`);
    }
  }

  /**
   * expect request : une requête terminée du journal, depuis `since` (défaut : le plus ancien du début du document
   * courant, sa propre requête comprise, et du début de la dernière action — un « Enregistrer » qui poste puis
   * change de page reste vu), de méthode et d'URL correspondantes, avec un statut attendu (2xx par défaut).
   * Constaté borné : les 5 dernières requêtes correspondantes (statut, en cours), sinon les 5 dernières xhr/fetch,
   * et la dernière correspondante d'avant la fenêtre s'il y en a une (avec le --since qui la reprend).
   */
  private observeRequest(spec: ExpectSpec): { ok: boolean; observed: string } {
    this.assertNetwork();
    const pat = parseRequestTarget(spec.target ?? '', spec.match ?? 'exact');
    const want = spec.status ?? DEFAULT_REQUEST_STATUS;
    const okStatus = parseStatus(want);
    let since = spec.since ?? Math.min(this.docNetSeq, this.actNetSeq ?? this.docNetSeq);
    let note = '';
    if (since > this.netLog.seq) { note = ` (journal recréé : seq ${since} > seq courant ${this.netLog.seq}, relu depuis le début)`; since = 0; }
    const r = this.netLog.query({ since });
    const same = r.entries.filter((e) => requestMatches(e, pat, spec.match ?? 'exact'));
    if (same.some((e) => e.pending !== true && e.status !== undefined && e.error === undefined && okStatus(e.status))) return { ok: true, observed: '' };
    const lost = r.dropped > 0 ? ` ; ${r.dropped} requête(s) perdue(s) par le journal (1000 au plus)` : '';
    const show = (es: NetEntry[]) => `${es.slice(-5).map(formatNet).join(' | ')}${es.length > 5 ? ` | … et ${es.length - 5} autre(s) plus ancienne(s)` : ''}`;
    if (same.length > 0) return { ok: false, observed: `${same.length} requête(s) correspondante(s) depuis #${since}, aucune terminée de statut ${want} : ${show(same)}${lost}${note}` };
    const api = r.entries.filter((e) => e.type === 'xhr' || e.type === 'fetch');
    const others = api.length > 0 ? `dernières xhr/fetch : ${show(api)}` : `aucune requête xhr/fetch (${r.entries.length} requête(s) d'autres types)`;
    // Requête correspondante juste avant la fenêtre (action antérieure, --since trop récent) : dite, avec la reprise.
    const prev = since > 0 ? this.netLog.query({}).entries.filter((e) => e.seq <= since && requestMatches(e, pat, spec.match ?? 'exact')).at(-1) : undefined;
    const hint = prev !== undefined ? ` ; requête correspondante plus ancienne, hors de la fenêtre : ${formatNet(prev)} — relancez avec --since ${prev.seq - 1}` : '';
    return { ok: false, observed: `aucune requête correspondante depuis #${since} ; ${others}${hint}${lost}${note}` };
  }

  /** Erreurs de formulaire de la page : lignes des champs invalides du snapshot, puis alertes hors arbre. */
  async formErrorLines(): Promise<string[]> {
    const snap = await this.snapshot({ maxBytes: 1 });
    const fe = await this.formErrors();
    // Relevé DOM impossible (navigation en cours) : les champs invalides de l'arbre restent rapportés.
    const alerts = fe !== undefined ? fe.alerts : [];
    return [...snap.invalid.map((i) => i.line), ...alerts.map((a) => `alerte "${a.length > 200 ? `${a.slice(0, 200)}…` : a}"`)];
  }

  // ---------- Audit d'accessibilité (grasp a11y, expect a11y) : lecture seule, code fixe ----------

  /**
   * Défauts d'accessibilité vérifiables de la page (ou de la zone `scope`) : arbre d'accessibilité (contrôles sans
   * nom, images sans alternative, titres sautés), relevé des erreurs de formulaire (message visible non relié,
   * message masqué par aria-hidden) et DOM (libellés orphelins, références ARIA cassées, rôles invalides), dans le
   * monde isolé de lecture : autorisé avec allowEval=false. Les refs données sont mémorisées comme celles d'un snap.
   * `max` : problèmes listés (30 par défaut, 500 au plus) ; les comptes portent sur tous.
   */
  async a11y(opts: { scope?: string | undefined; max?: number | undefined } = {}): Promise<A11yReport> {
    const max = opts.max ?? A11Y_DEFAULT_MAX;
    if (!Number.isInteger(max) || max < 1 || max > A11Y_MAX) throw badRequest(`max : entier de 1 à ${A11Y_MAX} attendu (problèmes listés)`);
    const scope = opts.scope !== undefined && opts.scope.trim() !== '' ? opts.scope.trim() : undefined;
    if (scope !== undefined && parseFrameTarget(scope) !== null) throw badRequest("a11y --scope : zone frame=… non prise en charge (l'audit porte sur le cadre principal)");
    const scopeId = scope !== undefined ? await this.resolve(scope) : undefined;
    const [{ nodes }, loc] = await Promise.all([
      this.s<{ nodes: AXNode[] }>('Accessibility.getFullAXTree'),
      this.location(),
      this.isolatedContext().catch(() => undefined),
    ]);
    const inZone = scopeId !== undefined ? scopeNodes(nodes, scopeId) : undefined;
    if (scopeId !== undefined && inZone === undefined) throw notFound(`la zone ${scope ?? ''} n'a pas de nœud dans l'arbre d'accessibilité (élément masqué ou retiré ?)`);
    const [fe, dom] = await Promise.all([this.formErrors(scopeId), this.a11yDom(scopeId)]);
    // Relevé des erreurs de formulaire impossible : erreur, jamais un audit faussement propre.
    if (fe === undefined) throw new GraspError(503, 'audit : relevé des erreurs de formulaire impossible (page en transition ?) — réessayez après grasp wait');
    // Refs : celles du snapshot complet (mêmes hash), mémorisées pour être utilisables telles quelles.
    const snap = buildSnapshot(nodes, { url: loc.url, title: loc.title, maxBytes: 1, formErrors: fe });
    this.remember(snap);
    const refOf = new Map<number, string>();
    for (const [ref, id] of snap.refs) if (!refOf.has(id)) refOf.set(id, ref);
    const raw: RawIssue[] = axIssues(nodes, (n) => inZone === undefined || inZone.has(n.nodeId));
    {
      // Images sans nom : l'élément DOM décide (icône <svg> sans role → non signalée ; correction selon l'élément).
      // DOM.describeNode : lecture CDP, aucun code exécuté dans la page.
      const drop = new Set<RawIssue>();
      await Promise.all(raw.filter((r) => r.kind === 'image-sans-alt' && r.backendId !== undefined).map(async (r) => {
        const d = await this.s<{ node: { localName?: string; nodeName: string; attributes?: string[] } }>('DOM.describeNode', { backendNodeId: r.backendId }).catch(() => undefined);
        if (d === undefined) return;
        const at = d.node.attributes !== undefined ? d.node.attributes : [];
        let role: string | undefined;
        for (let i = 0; i + 1 < at.length; i += 2) if (at[i] === 'role') role = at[i + 1];
        const fix = imageFix(d.node.localName ?? d.node.nodeName, role);
        if (fix === undefined) drop.add(r); else r.fix = fix;
      }));
      if (drop.size > 0) raw.splice(0, raw.length, ...raw.filter((r) => !drop.has(r)));
    }
    {
      // Relevé déjà limité à la zone (formErrors sous scopeId).
      for (const [id, msg] of fe.fields) {
        if (fe.unlinked?.has(id) !== true && fe.uninvalid?.has(id) !== true) continue;
        if (fe.uninvalid?.has(id) === true) {
          raw.push({ kind: 'erreur-sans-invalide', backendId: id, detail: `message « ${msg.length > 60 ? `${msg.slice(0, 59)}…` : msg} » relié (aria-describedby) mais champ non marqué invalide`, fix: 'aria-invalid="true" tant que l\'erreur est affichée' });
          continue;
        }
        raw.push({ kind: 'erreur-non-reliee', backendId: id, detail: `message « ${msg.length > 60 ? `${msg.slice(0, 59)}…` : msg} » affiché mais non relié (ni aria-errormessage ni aria-describedby)`, fix: "aria-describedby=<id du message> (ou aria-errormessage + aria-invalid)" });
      }
      for (const a of fe.alerts) raw.push({ kind: 'erreur-masquee', who: `"${a.length > 80 ? `${a.slice(0, 79)}…` : a}"`, detail: "erreur affichée mais aria-hidden (inaudible), liée à aucun champ", fix: 'retirer aria-hidden ; role=alert pour l\'annoncer, aria-describedby pour la relier au champ' });
    }
    raw.push(...dom);
    const order = (k: A11yKind) => A11Y_KINDS.indexOf(k);
    raw.sort((a, b) => order(a.kind) - order(b.kind)); // tri stable : l'ordre du document est conservé par type
    const counts: Partial<Record<A11yKind, number>> = {};
    for (const r of raw) counts[r.kind] = (counts[r.kind] ?? 0) + 1;
    const issues: A11yIssue[] = [];
    for (const r of raw.slice(0, max)) {
      const ref = r.backendId !== undefined ? refOf.get(r.backendId) : undefined;
      let who = r.who;
      if (ref !== undefined) {
        // Ligne du snapshot (rôle, nom, contexte d'un bouton sans nom, [invalide: …]) ; sinon ref:rôle + description DOM.
        const line = snap.entries.get(ref);
        if (line !== undefined) {
          who = line;
          // Contrôle sans nom : sa ligne ne dit pas quel élément c'est ; la description DOM le relie au code (id, type).
          if (r.kind === 'sans-nom' && r.backendId !== undefined) {
            const d = await this.callIsolated<string>(r.backendId, A11Y_DESC_FN).catch(() => '');
            if (d !== '') who = `${who} ${d}`;
          }
        } else {
          const d = who ?? (r.backendId !== undefined ? await this.callIsolated<string>(r.backendId, A11Y_DESC_FN).catch(() => '') : '');
          who = `${ref}:${snap.meta.get(ref)?.role ?? r.role ?? '?'}${d !== '' ? ` ${d}` : ''}`;
        }
      } else if (who === undefined && r.backendId !== undefined) {
        who = await this.callIsolated<string>(r.backendId, A11Y_DESC_FN).catch(() => '');
      }
      issues.push({ kind: r.kind, ...(ref !== undefined ? { ref } : {}), who: who !== undefined && who !== '' ? who : `(${r.role ?? 'élément'} sans description)`, detail: r.detail, fix: r.fix });
    }
    const report = { url: loc.url, title: loc.title, total: raw.length, counts, issues, omitted: Math.max(0, raw.length - issues.length) };
    return { ...report, text: renderA11y(report, scope), note: A11Y_NOTE };
  }

  /** Problèmes DOM de l'audit (A11Y_DOM_FN) sous `root`, avec le backendNodeId de chaque élément. Page en transition → aucun. */
  private async a11yDom(root?: number): Promise<RawIssue[]> {
    const group = 'grasp-a11y';
    try {
      const ctx = await this.isolatedContext();
      type Res = { result: { objectId?: string }; exceptionDetails?: { text: string; exception?: { description?: string } } };
      let res: Res;
      if (root === undefined) res = await this.s<Res>('Runtime.evaluate', { contextId: ctx, expression: `(${A11Y_DOM_FN})(document)`, objectGroup: group });
      else {
        const { object } = await this.s<{ object: { objectId: string } }>('DOM.resolveNode', { backendNodeId: root, executionContextId: ctx, objectGroup: group });
        res = await this.s<Res>('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: `function () { return (${A11Y_DOM_FN})(this); }`, objectGroup: group });
      }
      // Bug du code fixe de Grasp : erreur visible, jamais un audit « propre » par défaut.
      if (res.exceptionDetails !== undefined) throw new GraspError(500, `script interne de Grasp en échec : ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`);
      if (res.result.objectId === undefined) return [];
      type Props = { result: Array<{ name: string; value?: { value?: unknown; objectId?: string } }> };
      const props = await this.s<Props>('Runtime.getProperties', { objectId: res.result.objectId, ownProperties: true });
      const meta = JSON.parse(String(props.result.find((p) => p.name === 'meta')?.value?.value ?? '{}')) as { items?: DomItem[] };
      const items = meta.items !== undefined ? meta.items : [];
      const elsId = props.result.find((p) => p.name === 'els')?.value?.objectId;
      const byIndex = new Map<number, string | undefined>();
      if (elsId !== undefined && items.length > 0) {
        const els = await this.s<Props>('Runtime.getProperties', { objectId: elsId, ownProperties: true });
        for (const p of els.result) if (/^[0-9]+$/.test(p.name)) byIndex.set(Number(p.name), p.value?.objectId);
      }
      const out: RawIssue[] = [];
      for (const it of items) {
        const objectId = byIndex.get(it.i);
        const id = objectId !== undefined ? (await this.s<{ node: { backendNodeId: number } }>('DOM.describeNode', { objectId }).catch(() => undefined))?.node.backendNodeId : undefined;
        out.push(domIssue(it, id));
      }
      return out;
    } catch (e) {
      if (e instanceof GraspError && e.status === 500) throw e;
      this.isoCtx = undefined;
      throw new GraspError(503, `audit DOM impossible (page en transition ?) : ${(e as Error).message} — réessayez après grasp wait`);
    } finally { void this.s('Runtime.releaseObjectGroup', { objectGroup: group }).catch(() => undefined); }
  }

  // ---------- Sélecteurs : ref e5, CSS #id, texte text:Valider ----------

  /**
   * Résolution d'un sélecteur. Pendant une action dont le control plane veut l'historique (`describeTarget`),
   * la cible est aussi décrite (sélecteur durable, champ secret) sur le MÊME snapshot, une seule fois : pas de
   * second snapshot pour l'historique.
   */
  private async resolve(sel: string, snap?: Snapshot): Promise<number> {
    const ctx = this.describeCtx.getStore();
    const s = sel.trim();
    if (ctx === undefined || ctx.want === undefined || s !== ctx.want) return this.resolveSel(sel, snap);
    ctx.want = undefined;
    const sn = snap ?? (REF_RE.test(s) || s.startsWith('text:') ? await this.snapshot() : undefined);
    const id = await this.resolveSel(s, sn);
    ctx.described = await this.describeResolved(s, id, sn).catch(() => undefined);
    return id;
  }

  private async resolveSel(sel: string, snap?: Snapshot): Promise<number> {
    const s = sel.trim();
    if (s === '') throw badRequest('sélecteur vide');
    if (REF_RE.test(s)) {
      // Refs propres à chaque onglet : une ref remise par un autre onglet n'est jamais cherchée ici (même hash).
      if (!this.knownRefs.has(s)) {
        const other = this.hub.refElsewhere?.(s, this);
        if (other !== undefined) throw notFound(`ref ${s} vient de l'onglet ${other.tab}, pas de l'onglet actif ${other.here} : les refs sont propres à chaque onglet — \`grasp tab ${other.tab}\` pour y agir, ou \`snap\` ici`);
      }
      const sn = snap ?? await this.snapshot();
      const id = sn.refs.get(s);
      if (id !== undefined) return id;
      await this.maskedRef(s, sn);
      return this.relocate(s, sn);
    }
    if (s.startsWith('text:')) return this.resolveText(s.slice(5).trim(), snap ?? await this.snapshot());
    return this.resolveCss(s.startsWith('css:') ? s.slice(4) : s);
  }

  /** Candidats résolubles du snapshot (ref, rôle, nom, nœud). */
  private static candidates(snap: Snapshot): Array<Candidate & { id: number; key: string }> {
    const all: Array<Candidate & { id: number; key: string }> = [];
    for (const [ref, m] of snap.meta) {
      const id = snap.refs.get(ref);
      if (id !== undefined) all.push({ ref, role: m.role, name: m.name, id, key: m.alt ?? m.name });
    }
    return all;
  }

  /**
   * Ref absente du snapshot courant dont l'élément est toujours dans la page mais masqué : hors de la
   * fenêtre modale ouverte (showModal, fond aria-hidden/inerte) ou sous aria-hidden/inert. 409 explicite au
   * lieu de « n'est plus dans la page » (et jamais de clic sur un homonyme de la modale). Sinon : rien.
   */
  private async maskedRef(ref: string, snap: Snapshot): Promise<void> {
    const prev = this.knownRefs.get(ref);
    if (prev === undefined || prev.doc !== this.docGen || prev.id === undefined) return;
    for (const id of snap.refs.values()) if (id === prev.id) return; // encore dans l'arbre : relocate
    let where = '';
    // Monde isolé : la page ne peut ni voir ce diagnostic ni le fausser (prototypes redéfinis).
    try {
      const r = await this.callIsolated<unknown>(prev.id, MASKED_FN);
      where = typeof r === 'string' ? r : '';
    } catch { return; }
    const what = `${prev.role}${prev.name !== '' ? ` "${prev.name}"` : ''}`;
    if (where === 'modal') {
      const m = snap.modal !== undefined && snap.modal !== '' ? ` (« ${snap.modal} »)` : '';
      throw new GraspError(409, `ref ${ref} (${what}) est toujours dans la page mais masquée par une fenêtre modale ouverte${m} : agissez dans la modale ou fermez-la d'abord`);
    }
    if (where === 'hidden') throw new GraspError(409, `ref ${ref} (${what}) est toujours dans la page mais masquée (aria-hidden ou inert) : elle n'est pas actionnable — refaites \`snap\``);
  }

  /**
   * Ref absente du snapshot courant. Elle n'est relocalisée que si c'est **le même élément** : son nœud DOM
   * (mémorisé quand la ref a été remise) est toujours dans la page, avec le même rôle et le même nom — seul
   * son rang parmi les homonymes a changé. Sinon l'élément a été retiré ou remplacé, et Grasp ne peut pas
   * distinguer « re-rendu » de « supprimé, un homonyme subsiste » : jamais de clic sur un homonyme.
   * Homonymes présents → 409 avec les candidats ; aucun → 404 avec les 3 plus proches. Une ref remise sur un
   * document précédent (navigation depuis) → 404 « refaites `snap` ».
   */
  private relocate(ref: string, snap: Snapshot): number {
    const prev = this.knownRefs.get(ref);
    if (prev === undefined) throw notFound(`ref ${ref} inconnue : elle ne vient d'aucun snapshot de cette session — refaites \`snap\``);
    const what = `${prev.role}${prev.name !== '' ? ` "${prev.name}"` : ''}`;
    if (prev.doc !== this.docGen) throw notFound(`ref ${ref} (${what}) vient d'une page précédente : la page a changé depuis le snapshot qui l'a remise — refaites \`snap\``);
    const all = PageController.candidates(snap);
    const strip = (c: Candidate): Candidate => ({ ref: c.ref, role: c.role, name: c.name });
    const self = prev.id !== undefined ? all.find((c) => c.id === prev.id) : undefined;
    // Identité comparée sur le nom brut de l'arbre (le nom rendu dépend du relevé du texte source).
    if (self !== undefined && self.role === prev.role && self.key === prev.key) {
      this.notes?.push(`ref ${ref} retrouvée → ${self.ref} (${what}) : même élément, rang décalé parmi les homonymes`);
      return self.id;
    }
    // Élément remplacé par un nouveau nœud (champ de recherche re-rendu en combobox) : l'élément focalisé de
    // même nom, de même rôle ou champ de saisie lui aussi, est son remplaçant — jamais un homonyme non focalisé.
    if (self === undefined && snap.focused !== undefined) {
      const f = all.find((c) => c.id === snap.focused);
      if (f !== undefined && PageController.sameKind(f.role, prev.role) && f.key === prev.key) {
        this.notes?.push(`ref ${ref} (${what}) : l'élément a été remplacé par ${f.ref} ${f.role}${f.name !== '' ? ` "${f.name}"` : ''}, focalisé et de même nom — action sur le remplaçant`);
        return f.id;
      }
    }
    const same = all.filter((c) => c.role === prev.role && c.key === prev.key);
    if (same.length > 0) {
      const c = same.slice(0, 3).map(strip);
      const who = same.length === 1 ? 'un autre élément a' : `${same.length} autres éléments ont`;
      throw new GraspError(409, `ref ${ref} (${what}) n'est plus dans la page : son élément a été retiré ou remplacé, et ${who} ce rôle et ce nom : ${c.map(fmtCandidate).join(', ')}${same.length > 3 ? ', …' : ''} — Grasp ne clique pas un homonyme à votre place : refaites \`snap\` et choisissez une ref`, { candidates: c });
    }
    const near = nearest(prev, all, 3).map(strip);
    throw new GraspError(404, `ref ${ref} (${what}) n'est plus dans la page ; ${near.length > 0 ? `candidats les plus proches : ${near.map(fmtCandidate).join(', ')}` : 'aucun candidat — refaites `snap`'}`, { candidates: near });
  }

  private resolveText(t: string, snap: Snapshot): number {
    if (!t) throw badRequest('text: attend un texte');
    const lower = t.toLowerCase();
    const all = [...snap.meta].map(([ref, m]) => ({ ref, ...m, id: snap.refs.get(ref) }));
    // Nom rendu (texte source) ou nom brut de l'arbre (texte transformé par CSS, libellé répété).
    const is = (c: { name: string; alt?: string | undefined }, f: (n: string) => boolean) => f(c.name) || (c.alt !== undefined && f(c.alt));
    const tiers = [
      all.filter((c) => is(c, (n) => n === t) && INTERACTIVE.has(c.role)),
      all.filter((c) => is(c, (n) => n === t)),
      all.filter((c) => is(c, (n) => n.toLowerCase() === lower)),
      all.filter((c) => INTERACTIVE.has(c.role) && is(c, (n) => n.toLowerCase().includes(lower))),
      // Case à cocher sans nom suivie de son texte (« [ ] checkbox 2 ») : ce texte est son libellé naturel.
      all.filter((c) => c.near !== undefined && c.near.toLowerCase() === lower),
    ];
    for (const tier of tiers) {
      const hits = tier.filter((c) => c.id !== undefined);
      if (hits.length === 1) return hits[0]!.id!;
      if (hits.length > 1) throw conflict(`text:${t} est ambigu (${hits.length} correspondances : ${hits.slice(0, 8).map((h) => `${h.ref} ${h.role} "${h.name}"`).join(', ')}) — utilisez une ref`);
    }
    const textHits = snap.textNodes.filter((n) => n.text === t || n.text.toLowerCase().includes(lower));
    if (textHits.length === 1) return textHits[0]!.backendNodeId;
    if (textHits.length > 1) throw conflict(`text:${t} est ambigu (${textHits.length} textes correspondent) — utilisez une ref`);
    const near = nearest({ name: t }, PageController.candidates(snap).filter((c) => c.name !== ''), 3).map((c): Candidate => ({ ref: c.ref, role: c.role, name: c.name }));
    const masked = snap.modal !== undefined ? ' (une fenêtre modale ouverte masque le reste de la page)' : '';
    throw new GraspError(404, `aucun élément nommé « ${t} »${masked}${near.length > 0 ? ` — noms proches : ${near.map(fmtCandidate).join(', ')}` : ' — vérifiez avec `snap`'}`, { candidates: near });
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

  /**
   * `grasp history` : sélecteur durable de la cible d'une commande, relevé AVANT l'action (l'élément peut
   * disparaître ensuite), et nature secrète du champ. Règle, pour une ref : `text:<nom accessible>` si ce nom,
   * résolu par les mêmes règles que `text:`, désigne CET élément (et lui seul) ; sinon le premier sélecteur CSS
   * d'une liste d'attributs stables (data-testid…, id non généré, name, aria-label, href, ancêtre identifié) qui
   * ne désigne que lui dans le document ; sinon chemin positionnel depuis l'ancêtre identifié le plus proche ;
   * sinon rien (la ref reste, avec la raison). Un sélecteur CSS ou text: reçu est déjà durable : gardé tel quel.
   * Lecture seule : snapshot, puis requêtes DOM ; aucun événement envoyé à la page (code en monde isolé).
   * Route interne (expect, wait, upload) ; les actions le font pendant leur propre résolution (`describeTarget`).
   */
  async durableTarget(sel: string): Promise<DurableTarget> {
    const s = sel.trim();
    // Cadre (moteur Playwright) : type du champ non vérifiable depuis le document principal.
    if (s.startsWith('frame=')) return { given: sel, durable: sel, how: 'given', secret: null };
    const snap = REF_RE.test(s) || s.startsWith('text:') ? await this.snapshot() : undefined;
    return this.describeResolved(s, await this.resolveSel(s, snap), snap);
  }

  /** Description durable d'une cible déjà résolue (`snap` : celui de la résolution, pour une ref). */
  private async describeResolved(s: string, id: number, snap: Snapshot | undefined): Promise<DurableTarget> {
    const secret = await this.callIsolated<boolean>(id, SECRET_FIELD_FN).catch(() => null);
    if (!REF_RE.test(s) || snap === undefined) return { given: s, durable: s, how: 'given', secret };
    const meta = snap.meta.get(s) ?? this.knownRefs.get(s);
    const role = meta?.role;
    const name = (meta?.name ?? '').trim();
    const base = { given: s, ...(role !== undefined ? { role } : {}), name, secret };
    let note: string;
    if (name === '') note = 'sans nom accessible';
    else {
      try {
        if (this.resolveText(name, snap) === id) return { ...base, durable: `text:${name}`, how: 'text' };
        note = `text:${name} désigne un autre élément`;
      } catch (e) { note = e instanceof GraspError && e.status === 409 ? 'nom ambigu' : `text:${name} introuvable`; }
    }
    const cands = await this.callIsolated<string[]>(id, STABLE_CSS_FN).catch(() => [] as string[]);
    for (const c of Array.isArray(cands) ? cands : []) {
      try { if (await this.resolveCss(c) === id) return { ...base, durable: c, how: 'css', note }; } catch { /* non unique ou invalide : suivant */ }
    }
    return { ...base, note: `${note}, aucun sélecteur CSS unique` };
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

  /**
   * Onglet en arrière-plan (document.visibilityState = hidden : autre onglet actif, fenêtre réduite) : les
   * entrées de CDP y sont bien livrées (la sonde les voit, la livraison vérifiée répond OK), mais la page ne
   * rend plus (requestAnimationFrame suspendu, minuteries bridées) : sa réaction n'arriverait pas. On ramène
   * l'onglet au premier plan AVANT l'action, et c'est dit.
   */
  private async ensureVisible(why = 'avant l\'action'): Promise<boolean> {
    if (await this.evalIsolated<string>('document.visibilityState').catch(() => 'visible') !== 'hidden') return true;
    // Mode attach : Chrome de l'utilisateur, on ne lui vole jamais le premier plan.
    if (this.foreign) {
      this.notes?.push("onglet en arrière-plan (document caché), laissé tel quel : mode attach, jamais de Page.bringToFront dans le Chrome de l'utilisateur — la page peut ne pas réagir (rendu suspendu)");
      return false;
    }
    // Déjà tenté sur ce document sans effet (fenêtre réduite, écran verrouillé) : ni nouvel essai, ni attente.
    if (this.frontTriedDoc === this.docGen) {
      this.notes?.push('onglet toujours caché (Page.bringToFront déjà tenté sans effet sur ce document : fenêtre réduite, écran verrouillé ?) — la page peut ne pas réagir');
      return false;
    }
    this.frontTriedDoc = this.docGen;
    await this.s('Page.bringToFront').catch(() => undefined);
    const shown = await this.evalIsolated<boolean>(`new Promise((r) => { if (document.visibilityState !== 'hidden') return r(true); const t = setTimeout(() => r(false), 1000); document.addEventListener('visibilitychange', () => { clearTimeout(t); r(true); }, { once: true }); })`, true).catch(() => false);
    if (shown) {
      this.notes?.push(`onglet en arrière-plan (document caché) : ramené au premier plan ${why}`);
      return true;
    }
    this.notes?.push('onglet en arrière-plan : Page.bringToFront sans effet, document toujours caché (fenêtre réduite, écran verrouillé ?) — la page peut ne pas réagir ; pas de nouvel essai sur ce document');
    return false;
  }

  /**
   * `post` : après le diff, sur le DOM de fin d'action — peut annoter `res.diff` et renvoyer une note.
   * Un échec de `post` (navigation, élément parti) ne fait jamais échouer l'action, qui a eu lieu.
   */
  private async act(opts: ActionOptions, fn: (snap: Snapshot | undefined) => Promise<string | void>, post?: (res: ActionResult) => Promise<string | undefined>): Promise<ActionResult> {
    if (opts.console === true) this.assertConsole();
    const policy = parseDialogOption(opts.dialog);
    if (opts.network === true) this.assertNetwork();
    const seq = this.consoleBuf.seq;
    const netSeq = this.netLog.seq;
    this.actNetSeq = netSeq;
    const t0 = Date.now();
    const nav0 = this.navCount;
    const loads0 = this.loadStarts;
    const trk0 = this.trackersBlocked;
    const actionNotes: string[] = [];
    this.notes = actionNotes;
    this.undelivered = false;
    this.actTarget = undefined;
    this.beginDialogs(policy);
    // Contexte de description lié à CET appel (fn et post s'y exécutent) ; vide si rien n'est demandé, pour
    // qu'une action imbriquée n'hérite pas de celui de l'action qui l'appelle.
    const dctx: { want: string | undefined; described?: DurableTarget | undefined } = { want: opts.describeTarget?.trim() || undefined };
    try {
      await this.ensureVisible();
      const before = opts.snapDiff ? await this.snapshot({ scope: opts.scope }) : undefined;
      const doc0 = this.docGen;
      let detail: string | void;
      try { detail = await this.describeCtx.run(dctx, () => fn(before)); } finally { void this.s('Runtime.releaseObjectGroup', { objectGroup: 'grasp' }).catch(() => undefined); }
      const tEnd = Date.now();
      await this.settle();
      // Fenêtre d'attribution : requêtes parties pendant l'action ou juste après (un polling de fond n'en est pas).
      const win: StableOptions = { since: t0, until: tEnd + ACTION_WINDOW_MS };
      // Réaction de la page à l'action : navigation (document ou route SPA), requête (non périodique) partie depuis t0.
      const reacted = () => this.navCount !== nav0 || this.loadStarts !== loads0 || this.navigating() || this.counted(win).some((r) => !r.periodic);
      while (opts.snapDiff !== true && !reacted() && Date.now() - tEnd < ACTION_GRACE_MS) await sleep(Math.min(20, ACTION_GRACE_MS - (Date.now() - tEnd)));
      // Le diff est calculé sur une page stable (sinon : état intermédiaire, refs aussitôt invalides) ; une action
      // qui a navigué ou lancé des requêtes attend aussi leur fin et le rendu, comme `nav`. Nouveau document :
      // toutes ses requêtes comptent (comme `nav`), pas seulement celles de la fenêtre de l'action.
      const stab = opts.snapDiff === true || reacted() ? await this.waitStable(this.limits.stableTimeoutMs, this.docGen !== doc0 ? { since: t0 } : win) : undefined;
      const res: ActionResult = { ok: true };
      if (this.trackersBlocked > trk0) res.trackersBlocked = this.trackersBlocked - trk0;
      // Élément remplacé par la page juste après l'action (champ de recherche re-rendu en combobox…) : dit.
      const replaced = this.actTarget !== undefined && this.docGen === doc0 ? await this.replacementNote(this.actTarget).catch(() => undefined) : undefined;
      const notes = [detail, ...actionNotes, replaced, this.blocked !== null && this.blocked.at >= t0 ? `navigation bloquée : ${this.blocked.reason}` : undefined, stab !== undefined && !stab.stable ? PageController.unstableNote(stab) : undefined, stab?.ongoing === true ? ONGOING_NOTE : undefined, stab?.background === true ? BACKGROUND_NOTE : undefined].filter((x): x is string => typeof x === 'string' && x !== '');
      if (notes.length) res.detail = notes.join(' ; ');
      if (before) {
        res.diff = await this.diffAfter(before, opts, doc0);
        // « Aucun changement » après une entrée qui n'a pas atteint la page : ce n'est pas un OK ordinaire.
        if (this.undelivered && res.diff === NO_CHANGE) res.diff = "(aucun changement — l'entrée native n'a pas atteint la page : action rejouée en synthétique, sans effet sur l'arbre d'accessibilité)";
      }
      if (post !== undefined) {
        const extra = await this.describeCtx.run(dctx, () => post(res)).catch(() => undefined);
        if (extra !== undefined && extra !== '') res.detail = res.detail !== undefined ? `${res.detail} ; ${extra}` : extra;
      }
      // Dialogues relevés en DERNIER (après le diff et `post`, pendant lesquels la politique valait encore), et la
      // politique close au même moment : un dialogue plus tardif reçoit le défaut et va, marqué, à l'action suivante.
      this.endDialogs();
      const dlg = this.takeDialogs(res);
      if (dlg.length > 0) {
        res.detail = [...dlg, ...(res.detail !== undefined ? [res.detail] : [])].join(' ; ');
        if (res.diff !== undefined) res.diff = `${dlg.map((l) => `! ${l}`).join('\n')}\n${res.diff}`;
      }
      if (opts.console === true) res.console = this.consoleSince(seq);
      if (opts.network === true) res.network = this.networkSince(netSeq);
      // Défense : une description n'est rendue que pour la cible demandée par cet appel.
      if (dctx.described !== undefined && dctx.described.given.trim() === opts.describeTarget?.trim()) res.target = dctx.described;
      return res;
    } catch (e) { throw this.dialogError(await this.decorate(e, opts, seq, netSeq)); } finally { this.notes = undefined; this.undelivered = false; this.actTarget = undefined; this.endDialogs(); }
  }

  /** Début d'action : la politique --dialog s'applique jusqu'à endDialogs (fin de l'action, stabilité comprise). */
  private beginDialogs(policy: DialogPolicy | undefined): void {
    this.dialogPolicy = policy;
    this.inAction = true;
  }

  private endDialogs(): void {
    this.dialogPolicy = undefined;
    this.inAction = false;
  }

  /** Action en échec : les dialogues vus sont ajoutés au message (jamais tus, jamais reportés à l'action suivante). */
  private dialogError(e: unknown): unknown {
    const res: ActionResult = { ok: true };
    const lines = this.takeDialogs(res);
    if (lines.length === 0) return e;
    const base = e instanceof GraspError ? e : new GraspError(500, e instanceof Error ? e.message : String(e));
    return new GraspError(base.status, `${base.message} ; ${lines.join(' ; ')}`, { ...(base.extra ?? {}), dialogs: res.dialogs });
  }

  /** Dialogues vus depuis le dernier rapport → `res.dialogs` et lignes de note (vidés : chacun n'est rapporté qu'une fois). */
  private takeDialogs(res: ActionResult): string[] {
    if (this.dialogs.length === 0 && this.dialogsOmitted === 0) return [];
    const lines = dialogLines(this.dialogs, this.dialogsOmitted);
    res.dialogs = this.dialogs;
    if (this.dialogsOmitted > 0) res.dialogsOmitted = this.dialogsOmitted;
    this.dialogs = [];
    this.dialogsOmitted = 0;
    return lines;
  }

  /** Rôles de champ de saisie interchangeables pour un remplacement (searchbox re-rendu en combobox). */
  private static sameKind(a: string, b: string): boolean {
    return a === b || (TEXT_FIELD_ROLES.has(a) && TEXT_FIELD_ROLES.has(b));
  }

  /**
   * L'élément visé par l'action a-t-il été détaché ? Si oui, son remplaçant : l'élément focalisé de même nom
   * et de même rôle (ou champ de saisie ↔ champ de saisie), sinon l'unique élément de même rôle et même nom.
   * Rien si l'élément est toujours dans la page, ou retiré sans remplaçant identifiable.
   */
  private async replacementNote(id: number): Promise<string | undefined> {
    const alive = await this.callIsolated<boolean>(id, 'function () { return this.isConnected; }').catch(() => false);
    if (alive) return undefined;
    let prev: { role: string; key: string } | undefined;
    for (const k of this.knownRefs.values()) if (k.id === id && k.doc === this.docGen) prev = k;
    if (prev === undefined) return undefined;
    const p = prev;
    const snap = await this.snapshot();
    const all = PageController.candidates(snap);
    const c = all.find((x) => x.id === snap.focused && PageController.sameKind(x.role, p.role) && x.key === p.key)
      ?? ((same) => (same.length === 1 ? same[0] : undefined))(all.filter((x) => x.role === p.role && x.key === p.key));
    if (c === undefined) return undefined;
    return `l'élément a été remplacé par ${c.ref} ${c.role}${c.name !== '' ? ` "${c.name}"` : ''}${c.id === snap.focused ? ' (focalisé)' : ''} — utilisez cette ref`;
  }

  /** Point du clic : centre du premier quad, après défilement. 409 si l'élément n'a pas de zone cliquable. */
  private async clickPoint(id: number): Promise<{ x: number; y: number }> {
    await this.s('DOM.scrollIntoViewIfNeeded', { backendNodeId: id }).catch(() => undefined);
    let quads: number[][] = [];
    try { ({ quads } = await this.s<{ quads: number[][] }>('DOM.getContentQuads', { backendNodeId: id })); } catch { /* invisible */ }
    const q = quads[0];
    if (!q || q.length < 8) throw conflict("l'élément n'a pas de zone cliquable (invisible ou hors rendu)");
    return { x: (q[0]! + q[2]! + q[4]! + q[6]!) / 4, y: (q[1]! + q[3]! + q[5]! + q[7]!) / 4 };
  }

  /**
   * Clic natif vérifié (voir `deliver`). `effect` : effet attendu du repli synthétique (ex. case cochée).
   * fallbackEngine=playwright : rejeu Playwright entre l'étage (a) et le repli synthétique.
   */
  private async clickNode(id: number, effect?: () => Promise<boolean>): Promise<void> {
    const info = await this.describe(id);
    if (info.disabled) throw conflict('élément désactivé');
    await this.deliver({
      kind: 'clic', types: CLICK_EVENTS,
      point: () => this.clickPoint(id),
      native: async (at) => {
        const { x, y } = at!;
        await this.s('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
        await this.s('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
        await this.s('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
      },
      synthetic: async (at) => { await this.callIsolated(id, SYNTH_CLICK_FN, at?.x ?? 0, at?.y ?? 0); },
      ...(effect !== undefined ? { effect } : {}),
      ...(this.fallback === 'playwright' ? { replay: () => this.pwClickNode(id, PW_FALLBACK_TIMEOUT_MS, false) } : {}),
    });
  }

  // ---------- Livraison vérifiée des entrées ----------

  /** Navigation (ou chargement) du cadre principal depuis l'instant t0 : la page a réagi à l'entrée. */
  private navigatedSince(m: { nav: number; loads: number; t0: number }): boolean {
    return this.navCount !== m.nav || this.loadStarts !== m.loads || this.pendingNavAt >= m.t0;
  }

  private mark(): { nav: number; loads: number; t0: number } { return { nav: this.navCount, loads: this.loadStarts, t0: Date.now() }; }

  /** Arme la sonde ; renvoie son jeton et la balise touchée (point du clic, ou élément focalisé). */
  private async armProbe(types: string[], at: { x: number; y: number } | undefined): Promise<{ token: string; hit: string | null }> {
    const token = `p${process.pid}-${++this.probeSeq}`;
    const hit = await this.evalIsolated<string | null>(`(${PROBE_ARM_FN})(${JSON.stringify(types)}, ${JSON.stringify(token)}, ${JSON.stringify(at ?? null)})`);
    return { token, hit };
  }

  private stopProbe(token: string): void {
    void this.evalIsolated(`(${PROBE_STOP_FN})(${JSON.stringify(token)})`).catch(() => undefined);
  }

  /**
   * Attend, au plus `inputDeliveryMs`, que `ok(sonde)` soit vrai ou que la page navigue (la sonde disparaît
   * avec le document : la page a réagi). 'nav' | 'yes' | 'no'.
   */
  private async awaitProbe(token: string, m: { nav: number; loads: number; t0: number }, ok: (p: Probe) => boolean | Promise<boolean>): Promise<'nav' | 'yes' | 'no'> {
    const end = Date.now() + this.limits.inputDeliveryMs;
    for (;;) {
      let p: Probe | null;
      try { p = await this.evalIsolated<Probe | null>(`(${PROBE_READ_FN})(${JSON.stringify(token)})`); } catch (e) {
        if (this.navigatedSince(m)) return 'nav';
        throw e;
      }
      if (p === null || this.navigatedSince(m)) return 'nav';
      if (await ok(p)) return 'yes';
      const left = end - Date.now();
      if (left <= 0) return 'no';
      await sleep(Math.min(25, left));
    }
  }

  /**
   * Entrée native VÉRIFIÉE. Avant l'envoi, une sonde (monde isolé) écoute en capture les événements de
   * confiance ; si rien n'arrive dans `inputDeliveryMs` (écran Windows verrouillé, fenêtre sans rendu : le
   * routage par hit-test abandonne les événements de CDP alors qu'Input.dispatch* répond OK) :
   * (a) Page.bringToFront + focus émulé, second essai natif ; (b) repli DOM synthétique dans le monde isolé,
   * annoncé par une note ; (c) si même le repli ne produit rien d'observable : ERREUR, jamais de faux OK.
   * Une entrée qui part vers un cadre (iframe) n'est pas vérifiable depuis cette fenêtre : c'est dit.
   */
  private async deliver(o: DeliverOptions): Promise<'native' | 'retry' | 'playwright' | 'synthetic' | 'unverified'> {
    const k = KIND[o.kind];
    let at = o.point !== undefined ? await o.point() : undefined;
    let probe: { token: string; hit: string | null };
    try { probe = await this.armProbe(o.types, at); } catch (e) {
      await o.native(at);
      this.notes?.push(`livraison de l'entrée non vérifiée (sonde impossible : ${(e as Error).message})`);
      return 'unverified';
    }
    try {
      if (probe.hit !== null && FRAME_TAGS.has(probe.hit)) {
        await o.native(at);
        this.notes?.push(`entrée envoyée dans un cadre (<${probe.hit.toLowerCase()}>) : livraison non vérifiable depuis la page`);
        return 'unverified';
      }
      let m = this.mark();
      await o.native(at);
      if (await this.awaitProbe(probe.token, m, (p) => p.trusted > 0) !== 'no') return 'native';

      // (a) Onglet au premier plan, focus émulé, second essai.
      await this.testHooks?.recovering?.('front');
      await this.s('Page.bringToFront').catch(() => undefined);
      await this.s('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => undefined);
      if (o.prepare !== undefined) await o.prepare();
      if (o.point !== undefined) at = await o.point();
      this.stopProbe(probe.token);
      probe = await this.armProbe(o.types, at);
      m = this.mark();
      await o.native(at);
      if (await this.awaitProbe(probe.token, m, (p) => p.trusted > 0) !== 'no') {
        this.notes?.push('entrée native livrée au 2e essai, après Page.bringToFront et focus émulé');
        return 'retry';
      }

      // (a') fallbackEngine=playwright : rejeu par Playwright (événements de confiance, actionnabilité vérifiée).
      // Il passe par le même canal Input de CDP : il n'aide que si la perte tenait à l'envoi natif de Grasp.
      if (o.replay !== undefined) {
        await this.testHooks?.recovering?.('playwright');
        this.stopProbe(probe.token);
        probe = await this.armProbe(o.types, at);
        m = this.mark();
        let failed: GraspError | undefined;
        try { await o.replay(); } catch (e) { failed = e instanceof GraspError ? e : new GraspError(502, (e as Error).message); }
        if (failed === undefined && await this.awaitProbe(probe.token, m, (p) => p.trusted > 0) !== 'no') {
          this.notes?.push(`rejoué via Playwright : l'entrée native n'a pas atteint la page (ni au 1er essai, ni après Page.bringToFront et focus émulé)`);
          return 'playwright';
        }
        this.notes?.push(failed !== undefined && failed.status === 501 ? `repli Playwright impossible : ${failed.message}` : `repli Playwright sans effet (${failed !== undefined ? failed.message : 'aucun événement de confiance reçu par la page'})`);
      }

      // (b) Repli DOM synthétique (isTrusted=false), depuis le monde isolé.
      await this.testHooks?.recovering?.('synthetic');
      this.stopProbe(probe.token);
      probe = await this.armProbe(o.types, at);
      m = this.mark();
      await o.synthetic(at);
      const effect = o.effect;
      const seen = await this.awaitProbe(probe.token, m, effect !== undefined ? () => effect() : (p) => p.mutations > 0);
      if (seen !== 'no') {
        this.undelivered = true;
        this.notes?.push(`${k.note} : l'entrée native n'a pas atteint la page (ni au 1er essai, ni après Page.bringToFront et focus émulé)`);
        return 'synthetic';
      }
      // (c) Rien d'observable : jamais de faux OK.
      throw new GraspError(502, `${k.failed} : l'entrée native n'a pas atteint la page (ni au 1er essai, ni après Page.bringToFront et focus émulé), et ${k.synth} n'a produit aucun effet observable (${effect !== undefined ? 'ni l\'état attendu, ni navigation' : 'ni mutation du DOM, ni navigation'}) en ${this.limits.inputDeliveryMs} ms — écran Windows verrouillé ou éteint, fenêtre de Chrome sans rendu ?`);
    } finally { this.stopProbe(probe.token); }
  }

  click(sel: string, opts: ActionOptions = {}): Promise<ActionResult> {
    let engine: 'native' | 'playwright';
    try { engine = this.engineFor(opts, sel); } catch (e) { return Promise.reject(e); }
    if (engine === 'playwright') return this.pwAct(opts, sel, 'clic', (l) => l.click({ timeout: PW_ACTION_TIMEOUT_MS }), { pointer: true }, (res, id) => this.invalidFormNote(id, res));
    let clicked: number | undefined;
    return this.act(opts, async (snap) => {
      const id = await this.resolve(sel, snap);
      clicked = id;
      this.actTarget = id;
      try { await this.clickNode(id); } catch (e) {
        // Erreur d'actionnabilité (pas de zone cliquable, désactivé) : Playwright attend que l'élément le devienne.
        if (this.fallback !== 'playwright' || !(e instanceof GraspError) || e.status !== 409) throw e;
        try { await this.pwClickNode(id, PW_FALLBACK_TIMEOUT_MS, true); } catch (e2) {
          throw new GraspError(409, `${e.message} ; rejeu via Playwright sans succès : ${(e2 as Error).message}`);
        }
        this.notes?.push(`rejoué via Playwright : ${e.message}`);
      }
    }, (res) => this.invalidFormNote(clicked, res));
  }

  /**
   * Après un clic : bouton sans effet visible alors que son formulaire a des champs invalides — c'est la cause
   * probable. Annote le diff « aucun changement », sinon renvoie une note.
   */
  private async invalidFormNote(id: number | undefined, res: ActionResult): Promise<string | undefined> {
    if (id === undefined) return undefined;
    const bad = await this.invalidAround(id);
    if (bad.length === 0) return undefined;
    const list = bad.slice(0, 5).join(' ; ') + (bad.length > 5 ? ` ; … ${bad.length - 5} autre(s)` : '');
    if (res.diff === NO_CHANGE) { res.diff = `(aucun changement — formulaire invalide : ${list})`; return undefined; }
    return `formulaire invalide : ${list}`;
  }

  /** Après un fill : le champ est-il invalide (message de la page) ? */
  private async invalidFieldNote(id: number | undefined): Promise<string | undefined> {
    if (id === undefined) return undefined;
    const msg = (await this.formErrors())?.fields.get(id);
    return msg === undefined ? undefined : `champ invalide après la saisie${msg ? ` : ${msg}` : ''}`;
  }

  /** Survol : pointeur déplacé sur l'élément (menus au survol, infobulles), livraison vérifiée. */
  hover(sel: string, opts: ActionOptions = {}): Promise<ActionResult> {
    let engine: 'native' | 'playwright';
    try { engine = this.engineFor(opts, sel); } catch (e) { return Promise.reject(e); }
    if (engine === 'playwright') return this.pwAct(opts, sel, 'survol', (l) => l.hover({ timeout: PW_ACTION_TIMEOUT_MS }), { pointer: true, hover: true, soft: true });
    return this.act(opts, async (snap) => {
      const id = await this.resolve(sel, snap);
      await this.deliver({
        kind: 'survol', types: HOVER_EVENTS,
        point: () => this.clickPoint(id),
        native: async (at) => { await this.s('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at!.x, y: at!.y }); },
        synthetic: async (at) => { await this.callIsolated(id, SYNTH_HOVER_FN, at?.x ?? 0, at?.y ?? 0); },
      });
    });
  }

  /**
   * Frappe touche par touche (autocomplétions, champs qui réagissent à chaque touche), `delay` ms entre deux
   * touches (0 à 1000). Contrairement à fill, le texte s'AJOUTE à la position du curseur.
   */
  type(sel: string, text: string, opts: ActionOptions & { delay?: number | undefined } = {}): Promise<ActionResult> {
    const delay = opts.delay ?? 0;
    if (!Number.isInteger(delay) || delay < 0 || delay > 1000) return Promise.reject(badRequest('delay : entier de 0 à 1000 ms attendu'));
    if (text === '') return Promise.reject(badRequest('type attend un texte non vide'));
    let engine: 'native' | 'playwright';
    try { engine = this.engineFor(opts, sel); } catch (e) { return Promise.reject(e); }
    if (engine === 'playwright') return this.pwAct(opts, sel, 'saisie', (l) => l.pressSequentially(text, { delay, timeout: PW_ACTION_TIMEOUT_MS }), {});
    return this.act(opts, async (snap) => {
      const id = await this.resolve(sel, snap);
      this.actTarget = id;
      const info = await this.describe(id);
      if (info.disabled || info.readOnly) throw conflict('champ désactivé ou en lecture seule');
      const focus = async () => { await this.s('DOM.focus', { backendNodeId: id }); };
      await focus();
      const read = `function () { return this.isContentEditable ? this.innerText : (this.value ?? ''); }`;
      const before = await this.callOn<string>(id, read);
      const keys = [...text].map((ch) => (ch === '\n' ? parseKey('Enter') : parseKey(ch === '+' ? '+' : ch)));
      await this.deliver({
        kind: 'saisie', types: KEY_EVENTS, prepare: focus,
        native: async () => {
          for (const [i, { def }] of keys.entries()) {
            if (i > 0 && delay > 0) await sleep(delay);
            const base = { key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode };
            await this.s('Input.dispatchKeyEvent', def.text !== undefined ? { ...base, type: 'keyDown', text: def.text, unmodifiedText: def.text } : { ...base, type: 'rawKeyDown' });
            await this.s('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
          }
        },
        synthetic: async () => {
          for (const { def } of keys) await this.evalIsolated(`(${SYNTH_KEY_FN})(${JSON.stringify(def.key)}, ${JSON.stringify(def.code)}, ${Number(def.keyCode)}, ${JSON.stringify(def.text ?? '')}, 0)`);
        },
        effect: async () => (await this.callOn<string>(id, read)) !== before,
      });
    });
  }

  /**
   * `secret` : valeur substituée par le control plane (`fill … secret:NOM`). Domaine vérifié avant la saisie ;
   * aucun message ne recopie la valeur (ni la valeur effective, qui peut en être un préfixe).
   */
  fill(sel: string, value: string, opts: ActionOptions = {}, secret?: SecretUse): Promise<ActionResult> {
    if (secret === undefined) return this.fillValue(sel, value, opts);
    return this.assertSecretDomain(secret, sel).then(() => {
      this.secretRedactor.add(secret.name, value);
      return this.fillValue(sel, value, opts, secret);
    });
  }

  private fillValue(sel: string, value: string, opts: ActionOptions, secret?: SecretUse): Promise<ActionResult> {
    // Valeur effective différente (maxlength, masque) : souvent un préfixe du secret, masqué désormais lui aussi.
    const mismatch = (actual: string) => { if (secret !== undefined) this.secretRedactor.add(secret.name, actual); return mismatchText(actual); };
    const mismatchText = (actual: string) => (secret !== undefined
      ? `la valeur effective (${actual.length} caractère(s)) n'est pas celle de secret:${secret.name} (${value.length}) (maxlength, masque de saisie ?)`
      : `la valeur effective est « ${actual} » et non « ${value} » (maxlength, masque de saisie ?)`);
    let engine: 'native' | 'playwright';
    try { engine = this.engineFor(opts, sel); } catch (e) { return Promise.reject(e); }
    if (engine === 'playwright') {
      return this.pwAct(opts, sel, 'fill', async (l) => {
        await l.fill(value, { timeout: PW_ACTION_TIMEOUT_MS });
        // On vérifie l'effet, pas l'émission (maxlength, masque de saisie) ; contenteditable : texte affiché.
        let actual: string;
        try { actual = await l.inputValue({ timeout: 2000 }); } catch { actual = (await l.innerText({ timeout: 2000 })).trim(); value = value.trim(); }
        // Playwright respecte maxlength (valeur tronquée → 409 ici) : pas de note « au-delà de maxlength » à faire.
        if (actual !== value) throw conflict(mismatch(actual));
      }, undefined, (_res, id) => this.invalidFieldNote(id));
    }
    let fieldId: number | undefined;
    return this.act(opts, async (snap) => {
      const id = await this.resolve(sel, snap);
      this.actTarget = id;
      const info = await this.describe(id);
      const isField = (info.tag === 'INPUT' && !NON_TEXT_INPUTS.has(info.type)) || info.tag === 'TEXTAREA' || info.editable;
      if (!isField) throw badRequest(`fill attend un champ de saisie, reçu <${info.tag.toLowerCase()}${info.type ? ` type=${info.type}` : ''}> — utilisez click, check ou select`);
      if (info.disabled || info.readOnly) throw conflict('champ désactivé ou en lecture seule');
      if (secret !== undefined) {
        // Revérifié au plus près de la frappe (la page a pu naviguer depuis), puis le champ est marqué : sa valeur
        // sera rendue secret:NOM dans les snapshots, même si la page la tronque.
        await this.assertSecretDomain(secret, sel);
        this.secretNodes.set(id, secret.name);
      }
      if (info.editable && info.tag !== 'INPUT' && info.tag !== 'TEXTAREA') { fieldId = id; await this.fillEditable(id, value, secret?.name); return undefined; }
      const prepare = async () => {
        await this.s('DOM.focus', { backendNodeId: id });
        await this.callOn(id, `function () { if (typeof this.select === 'function') this.select(); else { const r = document.createRange(); r.selectNodeContents(this); const s = getSelection(); s.removeAllRanges(); s.addRange(r); } }`);
      };
      const type = async () => {
        if (value === '') {
          await this.s('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
          await this.s('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
        } else {
          await this.s('Input.insertText', { text: value });
        }
      };
      const read = `function () { return this.isContentEditable ? this.innerText.trim() : this.value; }`;
      await prepare();
      // Saisie au clavier vérifiée (Suppr, insertText) ; date, heure… : setter natif ci-dessous, comme avant.
      if (info.tag === 'INPUT' && SETTER_ONLY_INPUTS.has(info.type)) await type();
      else {
        await this.deliver({
          kind: 'saisie', types: KEY_EVENTS, prepare, native: type,
          synthetic: async () => { await this.callIsolated(id, SYNTH_FILL_FN, value); },
          effect: async () => (await this.callIsolated<string>(id, read)) === value,
        });
      }
      let actual = await this.callOn<string>(id, read);
      if (actual !== value) {
        // Champs que la frappe ne remplit pas (date, time…) : setter natif + événements.
        await this.callOn(id, `function (v) { const p = this instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(p, 'value').set.call(this, v); this.dispatchEvent(new Event('input', { bubbles: true })); }`, value);
        actual = await this.callOn<string>(id, read);
      }
      // On vérifie l'effet, pas l'émission : une valeur tronquée (maxlength, masque) est une erreur.
      if (actual !== value) throw conflict(mismatch(actual));
      await this.callOn(id, `function () { this.dispatchEvent(new Event('change', { bubbles: true })); }`);
      fieldId = id;
      // La saisie programmatique passe outre maxlength (mesuré sur Malt : 56 caractères pour maxlength=50).
      const max = await this.callOn<number>(id, `function () { return typeof this.maxLength === 'number' ? this.maxLength : -1; }`);
      if (max > 0 && value.length > max) return `valeur de ${value.length} caractères pour maxlength=${max} : un humain ne pourrait pas la saisir, la page la refusera probablement`;
      return undefined;
    }, () => this.invalidFieldNote(fieldId));
  }

  /**
   * fill sur un éditeur riche (contenteditable : Quill, ProseMirror, TipTap, TinyMCE…) : tout le contenu de
   * l'hôte d'édition est sélectionné puis supprimé (Suppr), le format de bloc ou de caractère resté sous le
   * curseur (titre, liste, citation, gras…) est retiré, puis le texte est inséré BRUT (Input.insertText), une
   * ligne à la fois, les retours ligne devenant de vrais paragraphes (Entrée). Livraison vérifiée comme une
   * frappe ; texte final vérifié (lignes non vides comparées). Jamais de setter de <input> sur un élément
   * qui n'en est pas un (« TypeError: Illegal invocation »).
   */
  private async fillEditable(id: number, value: string, secretName?: string): Promise<void> {
    const lines = value.replace(/\r\n?/g, '\n').split('\n');
    // Comparaison au rendu : espaces consécutifs repliés (le contenteditable les affiche en un, ou en insécables), lignes vides ignorées.
    const norm = (t: string) => t.split('\n').map((l) => l.replace(/[ \t\u00a0]+/g, ' ').trim()).filter((l) => l !== '').join('\n');
    const want = norm(value);
    const read = `function () { let h = this.nodeType === 1 ? this : this.parentElement; while (h.parentElement && h.parentElement.isContentEditable) h = h.parentElement; return h.innerText; }`;
    const key = async (k: { key: string; code: string; keyCode: number; text?: string }) => {
      const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode };
      await this.s('Input.dispatchKeyEvent', k.text !== undefined ? { ...base, type: 'keyDown', text: k.text, unmodifiedText: k.text } : { ...base, type: 'rawKeyDown' });
      await this.s('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
    };
    const prepare = async () => {
      await this.s('DOM.focus', { backendNodeId: id }).catch(() => undefined);
      await this.callIsolated(id, SELECT_EDITABLE_FN);
    };
    const native = async () => {
      await key({ key: 'Delete', code: 'Delete', keyCode: 46 });
      await this.callIsolated(id, PLAIN_FORMAT_FN).catch(() => undefined);
      for (const [i, line] of lines.entries()) {
        if (i > 0) await key({ key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' });
        if (line !== '') await this.s('Input.insertText', { text: line });
      }
    };
    await prepare();
    await this.deliver({
      kind: 'saisie', types: KEY_EVENTS, prepare, native,
      synthetic: async () => { await this.callIsolated(id, SYNTH_FILL_FN, value); },
      effect: async () => norm(await this.callIsolated<string>(id, read)) === want,
    });
    // L'éditeur peut retoucher le texte après coup (normalisation asynchrone) : on laisse une frame passer.
    await this.evalIsolated(FRAMES_FN, true).catch(() => undefined);
    const actual = norm(await this.callIsolated<string>(id, read));
    if (actual !== want && secretName !== undefined) this.secretRedactor.add(secretName, actual);
    if (actual !== want) throw conflict(secretName !== undefined ? `le texte effectif de l'éditeur (${actual.length} caractère(s)) n'est pas celui de secret:${secretName} (${want.length}) (l'éditeur a-t-il refusé ou transformé la saisie ?)` : `le texte effectif de l'éditeur est « ${actual.replace(/\n/g, '⏎')} » et non « ${want.replace(/\n/g, '⏎')} » (l'éditeur a-t-il refusé ou transformé la saisie ?)`);
  }

  select(sel: string, value: string, opts: ActionOptions = {}): Promise<ActionResult> {
    let engine: 'native' | 'playwright';
    try { engine = this.engineFor(opts, sel); } catch (e) { return Promise.reject(e); }
    if (engine === 'playwright') {
      return this.pwAct(opts, sel, 'select', async (l) => `sélectionné : ${(await l.selectOption(value, { timeout: PW_ACTION_TIMEOUT_MS })).join(', ')}`);
    }
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
    let engine: 'native' | 'playwright';
    try { engine = this.engineFor(opts, sel); } catch (e) { return Promise.reject(e); }
    if (engine === 'playwright') {
      // Playwright vérifie lui-même que l'état a changé (« did not change its state » → 409).
      return this.pwAct(opts, sel, desired ? 'check' : 'uncheck', (l) => (desired ? l.check({ timeout: PW_ACTION_TIMEOUT_MS }) : l.uncheck({ timeout: PW_ACTION_TIMEOUT_MS })), { pointer: true });
    }
    return this.act(opts, async (snap) => {
      const id = await this.resolve(sel, snap);
      const info = await this.describe(id);
      if (!info.checkable) throw badRequest(`check attend une case à cocher ou un bouton radio, reçu <${info.tag.toLowerCase()}>`);
      if (info.type === 'radio' && !desired) throw badRequest('un bouton radio ne se décoche pas : cochez une autre option du groupe');
      if (info.checked === desired) return 'déjà dans cet état';
      try { await this.clickNode(id, async () => (await this.describe(id)).checked === desired); } catch (e) {
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
    let engine: 'native' | 'playwright';
    try { engine = this.engineFor(opts, sel); } catch (e) { return Promise.reject(e); }
    if (engine === 'playwright') {
      const k = playwrightKey(parsed);
      if (sel === undefined || sel === '') {
        return this.act(opts, () => this.pwUse(async (page) => {
          try { await this.pwVerified({ focused: true }, 'touche', () => page.keyboard.press(k)); } catch (e) { throw pwError(e, 'press'); }
        }));
      }
      return this.pwAct(opts, sel, 'touche', (l) => l.press(k, { timeout: PW_ACTION_TIMEOUT_MS }), {});
    }
    return this.act(opts, async (snap) => {
      const target = sel !== undefined && sel !== '' ? await this.resolve(sel, snap) : undefined;
      const focus = async () => { if (target !== undefined) await this.s('DOM.focus', { backendNodeId: target }); };
      await focus();
      const { def, modifiers } = parsed;
      const base = { key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode, modifiers };
      await this.deliver({
        kind: 'touche', types: KEY_EVENTS, prepare: focus,
        native: async () => {
          await this.s('Input.dispatchKeyEvent', def.text !== undefined
            ? { ...base, type: 'keyDown', text: def.text, unmodifiedText: def.text }
            : { ...base, type: 'rawKeyDown' });
          await this.s('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
        },
        synthetic: async () => { await this.evalIsolated(`(${SYNTH_KEY_FN})(${JSON.stringify(def.key)}, ${JSON.stringify(def.code)}, ${Number(def.keyCode)}, ${JSON.stringify(def.text ?? '')}, ${Number(modifiers)})`); },
      });
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

  // ---------- Viewport émulé (grasp viewport) ----------

  /** Paramètres de setDeviceMetricsOverride d'un viewport ; `size` : taille temporaire (capture agrandie). */
  private static metricsOf(v: ViewportSpec, size?: { width: number; height: number }): Record<string, unknown> {
    const width = size !== undefined ? size.width : v.width, height = size !== undefined ? size.height : v.height;
    return {
      width, height, deviceScaleFactor: v.dpr, mobile: v.mobile, screenWidth: v.width, screenHeight: v.height,
      ...(v.mobile ? { screenOrientation: v.width <= v.height ? { type: 'portraitPrimary', angle: 0 } : { type: 'landscapePrimary', angle: 90 } } : {}),
    };
  }

  /** Viewport émulé courant (undefined : celui du navigateur). */
  get viewport(): ViewportSpec | undefined { return this.vp === undefined ? undefined : { ...this.vp }; }

  /**
   * Pose (ou retire, `null`) le viewport émulé de l'onglet : taille CSS, densité, mode mobile, tactile, user agent
   * mobile sur demande. Limité à NOTRE onglet (session CDP de la cible) : en mode attach, les autres onglets de
   * l'utilisateur ne sont pas touchés. Les overrides d'Emulation survivent aux navigations de l'onglet. Attend que
   * la page voie la nouvelle taille, puis sa stabilité (une page peut re-rendre au redimensionnement), et renvoie
   * ce que la page mesure elle-même.
   */
  async setViewport(spec: ViewportSpec | null): Promise<ViewportResult> {
    const prev = this.vp;
    const readScreen = () => this.evalIsolated<number[]>('[screen.width, screen.height]').catch(() => undefined);
    if (spec !== null && prev === undefined) this.nativeScreen = await readScreen();
    if (spec === null) {
      await this.s('Emulation.clearDeviceMetricsOverride');
      await this.s('Emulation.setTouchEmulationEnabled', { enabled: false });
      if (this.uaOverridden) { await this.s('Emulation.setUserAgentOverride', { userAgent: '' }); this.uaOverridden = false; }
      this.vp = undefined;
    } else {
      await this.s('Emulation.setDeviceMetricsOverride', PageController.metricsOf(spec));
      await this.s('Emulation.setTouchEmulationEnabled', spec.touch ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
      if (spec.mobileUa) {
        const { product } = await this.cdp.send<{ product: string }>('Browser.getVersion');
        const { userAgent, major } = mobileUserAgent(product);
        await this.s('Emulation.setUserAgentOverride', {
          userAgent,
          userAgentMetadata: { brands: [{ brand: 'Chromium', version: major }, { brand: 'Not.A/Brand', version: '99' }], platform: 'Android', platformVersion: '10', architecture: '', model: 'K', mobile: true },
        });
        this.uaOverridden = true;
      } else if (this.uaOverridden) { await this.s('Emulation.setUserAgentOverride', { userAgent: '' }); this.uaOverridden = false; }
      this.vp = { ...spec };
    }
    // L'override est appliqué par le moteur de rendu après la réponse de CDP : on attend que la page le voie
    // (taille d'écran émulée, ou retour à l'écran réel), 2 s au plus. Au reset, on attend l'ÉGALITÉ avec
    // l'écran réel lu avant le premier override, pas une différence avec l'ancien viewport : un viewport de la
    // taille de l'écran (800x600 en headless, 1920x1080 sur un écran 1920×1080) n'en diffère jamais.
    // Écran réel inconnu (lecture échouée) : pas d'attente, la stabilité suit.
    const target = spec !== null ? [spec.width, spec.height] : prev !== undefined ? this.nativeScreen : undefined;
    if (spec === null) this.nativeScreen = undefined;
    if (target !== undefined) {
      for (let i = 0; i < 80; i++) {
        const sc = await readScreen();
        if (sc === undefined || (sc[0] === target[0] && sc[1] === target[1])) break;
        await sleep(25);
      }
    }
    const stab = await this.waitStable();
    const out = await this.viewportInfo();
    const notes = [
      ...(!stab.stable ? [PageController.unstableNote(stab)] : []),
      ...(spec !== null && spec.mobileUa ? ['user agent mobile : effectif pour les requêtes suivantes ; la page déjà chargée a été servie avec l\'ancien (rechargez-la avec nav)'] : []),
      ...(spec === null && prev !== undefined && prev.mobileUa ? ['user agent d\'origine rétabli pour les requêtes suivantes'] : []),
    ];
    return notes.length > 0 ? { ...out, detail: notes.join(' ; ') } : out;
  }

  /** Viewport courant : réglage de Grasp et ce que la page mesure (monde isolé : la page ne peut pas le fausser). */
  async viewportInfo(): Promise<ViewportResult> {
    const m = await this.evalIsolated<{ width: number; height: number; dpr: number; touchPoints: number; pointer: string; ua: string } | undefined>(
      `({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, touchPoints: navigator.maxTouchPoints, pointer: matchMedia('(pointer: coarse)').matches ? 'coarse' : matchMedia('(pointer: fine)').matches ? 'fine' : 'none', ua: navigator.userAgent })`,
    ).catch(() => undefined);
    return {
      ok: true, viewport: this.vp === undefined ? null : { ...this.vp },
      ...(this.vp !== undefined ? { description: describeViewport(this.vp) } : {}),
      ...(m !== undefined ? { measured: { width: m.width, height: m.height, dpr: m.dpr, touchPoints: m.touchPoints, pointer: m.pointer, mobileUa: /\bMobile\b/.test(m.ua) } } : {}),
    };
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
    // de la capture à la TAILLE DE LA ZONE (largeur et hauteur), puis on fait défiler jusqu'à son coin
    // (setDeviceMetricsOverride, scrollTo, puis clear). Pas de captureBeyondViewport : Chrome y fait
    // disparaître la barre de défilement jusqu'au rechargement (reflow de la page), ce qui l'altère.
    let region: Box | undefined;
    let expand = false;
    let truncated = false;
    if (elId !== undefined) {
      const b = await this.boxOf(elId);
      if (b === null) throw conflict("l'élément n'a pas de boîte visible (invisible ou hors rendu)");
      region = PageController.pixelBox(b, vv);
      expand = !inViewport(region);
    } else if (o.full === true) {
      region = { x: 0, y: 0, width: Math.ceil(m.cssContentSize.width), height: Math.ceil(m.cssContentSize.height) };
      expand = true;
    } else if (o.maxWidth !== undefined) {
      region = { x: vv.pageX, y: vv.pageY, width: surface.width, height: surface.height };
    }
    if (region !== undefined && expand) ({ region, truncated } = PageController.clampTexture(region, dpr));
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
        const grown = { width: Math.max(Math.ceil(m.cssLayoutViewport.clientWidth), Math.ceil(region.width)), height: Math.max(Math.ceil(viewport.height), Math.ceil(region.height)) };
        // Viewport émulé (grasp viewport) : même densité et même mode mobile pendant l'agrandissement.
        await this.s('Emulation.setDeviceMetricsOverride', this.vp !== undefined ? PageController.metricsOf(this.vp, grown) : { ...grown, deviceScaleFactor: 0, mobile: false });
        if (elId !== undefined) {
          // Le viewport agrandi change la mise en page (barre de défilement, largeur) : un élément flottant
          // se décale. La boîte est relue APRÈS l'agrandissement (sinon : bord gauche rogné).
          const b = await this.boxOf(elId);
          const now = await this.s<{ cssVisualViewport: { pageX: number; pageY: number } }>('Page.getLayoutMetrics');
          if (b !== null) {
            region = PageController.clampTexture(PageController.pixelBox(b, now.cssVisualViewport), dpr).region;
            params.clip = { ...region, scale };
          }
        }
        // Coin de la zone en haut à gauche du viewport agrandi (défilement borné par le navigateur : la zone,
        // au plus aussi grande que le viewport, reste dedans). `instant` : ignore un scroll-behavior: smooth.
        await this.inIsolatedWorld(`scrollTo({ left: ${Number(region.x)}, top: ${Number(region.y)}, behavior: 'instant' })`);
      }
      data = await new Promise<string>((resolve, reject) => {
        const t = setTimeout(() => reject(new GraspError(504, 'capture : délai dépassé (onglet en arrière-plan ou fenêtre minimisée ?)')), 30_000);
        this.s<{ data: string }>('Page.captureScreenshot', params).then((r) => { clearTimeout(t); resolve(r.data); }, (e: Error) => { clearTimeout(t); reject(new GraspError(502, `capture impossible : ${e.message}`)); });
      });
    } finally {
      if (expand) {
        // Retour au viewport émulé de la session s'il y en a un, sinon à celui du navigateur.
        if (this.vp !== undefined) await this.s('Emulation.setDeviceMetricsOverride', PageController.metricsOf(this.vp)).catch(() => undefined);
        else await this.s('Emulation.clearDeviceMetricsOverride').catch(() => undefined);
        // Le retour à la taille d'origine est asynchrone : on l'attend avant de rendre la main
        // (sinon la mesure suivante, ou le défilement restauré, porteraient sur le viewport agrandi).
        for (let i = 0; i < 80; i++) {
          const cur = await this.s<{ cssVisualViewport: { clientWidth: number; clientHeight: number } }>('Page.getLayoutMetrics').catch(() => undefined);
          if (cur === undefined || (Math.abs(cur.cssVisualViewport.clientHeight - vv.clientHeight) < 1 && Math.abs(cur.cssVisualViewport.clientWidth - vv.clientWidth) < 1)) break;
          await sleep(25);
        }
        await this.inIsolatedWorld(`scrollTo({ left: ${Number(vv.pageX)}, top: ${Number(vv.pageY)}, behavior: 'instant' })`).catch(() => undefined);
      }
      if (removeOverlay !== undefined) await removeOverlay();
    }
    const buf = Buffer.from(data, 'base64');
    const size = imageSize(buf);
    return { data: buf, width: size.width, height: size.height, format, ...(truncated ? { truncated: true } : {}) };
  }

  /**
   * Boîte d'un élément en pixels entiers du document : x/y arrondis vers le bas, bords droit et bas vers le
   * haut — jamais un pixel de l'élément perdu sur une position fractionnaire.
   */
  private static pixelBox(b: Box, vv: { pageX: number; pageY: number }): Box {
    const x = Math.floor(b.x + vv.pageX), y = Math.floor(b.y + vv.pageY);
    return { x, y, width: Math.ceil(b.x + vv.pageX + b.width) - x, height: Math.ceil(b.y + vv.pageY + b.height) - y };
  }

  /** Limite de texture mesurée sur la ZONE capturée (le viewport agrandi), pas depuis le haut du document. */
  private static clampTexture(region: Box, dpr: number): { region: Box; truncated: boolean } {
    const maxPx = Math.floor(MAX_CAPTURE_PX / dpr);
    let truncated = false;
    if (region.width > maxPx) { region = { ...region, width: maxPx }; truncated = true; }
    if (region.height > maxPx) { region = { ...region, height: maxPx }; truncated = true; }
    return { region, truncated };
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
    return (await this.evaluateTyped(expression)).value;
  }

  /** eval avec le type du résultat : `undefined` (el.click(), form.submit()) n'a pas de valeur JSON. */
  async evaluateTyped(expression: string): Promise<{ value?: unknown; type: string }> {
    if (!this.policy.allowEval) throw forbidden('eval est désactivé (grasp config set allowEval true pour l\'autoriser)');
    this.actNetSeq = this.netLog.seq;
    const r = await this.s<{ result: { value?: unknown; type: string; subtype?: string }; exceptionDetails?: { text: string; exception?: { description?: string } } }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) throw badRequest(`exception : ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    const type = r.result.subtype === 'null' ? 'null' : r.result.type;
    return 'value' in r.result ? { value: r.result.value, type } : { type };
  }

  // ---------- État exportable : cookies + stockage Web (soumis à allowCookies et à l'allowlist) ----------

  private noteOrigin(url: string, main: boolean): void {
    const o = normalizeOrigin(url);
    if (o === null) return;
    this.seenOrigins.add(o);
    // sessionStorage importé : appliqué par le script au premier document de son origine, puis retiré.
    const p = this.pendingSession;
    if (main && p !== undefined && p.origin === o) {
      this.pendingSession = undefined;
      void this.s('Page.removeScriptToEvaluateOnNewDocument', { identifier: p.identifier }).catch(() => undefined);
    }
  }

  private stateAllowed(): void {
    if (!this.policy.allowCookies) throw forbidden('l\'export et l\'import de l\'état (cookies, stockage local) sont désactivés : activez la clé allowCookies (grasp config set allowCookies true, puis redémarrez le serveur)');
  }

  /** Document d'un onglet d'état : servi VIDE par Grasp (aucune requête ne part), seulement pour l'origine visée. */
  private async onScratchPaused(e: CdpEvent): Promise<void> {
    const sid = e.sessionId!;
    const url = String(e.params.request.url);
    const expected = this.scratch.get(sid);
    if (e.params.resourceType === 'Document' && expected !== undefined && normalizeOrigin(url) === expected && checkUrl(this.policy.allowedDomains, url).allowed) {
      const body = Buffer.from('<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><title>grasp-etat</title>').toString('base64');
      await this.cdp.send('Fetch.fulfillRequest', { requestId: e.params.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }, { name: 'Cache-Control', value: 'no-store' }], body }, sid);
    } else {
      await this.cdp.send('Fetch.failRequest', { requestId: e.params.requestId, errorReason: 'BlockedByClient' }, sid);
    }
  }

  /**
   * Onglet d'état, en arrière-plan : chaque origine y est ouverte par une navigation CONTRÔLÉE — Fetch intercepte
   * toutes les requêtes de l'onglet et sert un document vide pour l'origine visée (hors allowlist : refusé), donc
   * aucune requête n'atteint le site et aucun script du site ne s'exécute pendant la lecture ou l'écriture.
   */
  private async withScratch<T>(fn: (sid: string) => Promise<T>): Promise<T> {
    let targetId: string | undefined;
    let sid: string | undefined;
    try {
      // Création sérialisée avec celle des onglets (tab new) : l'onglet d'état n'est jamais adopté comme onglet.
      ({ targetId } = await this.hub.creation('scratch', () => this.cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank', background: true })));
      if (!this.foreign) {
        // Auto-attach du navigateur : la session existe déjà (l'événement précède la réponse) ; on l'attend.
        const end = Date.now() + 2000;
        while (!this.hub.attaching.has(targetId) && Date.now() < end) await sleep(10);
        const ready = this.hub.attaching.get(targetId);
        if (ready !== undefined) sid = await ready;
      }
      if (sid === undefined) {
        // Mode attach : attachement explicite, réclamé pour que le meneur ne le prenne pas pour un onglet de l'utilisateur.
        this.hub.claimed.add(targetId);
        sid = (await this.cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true })).sessionId;
      }
      this.scratch.set(sid, '');
      await this.cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, sid);
      // Un service worker du site ne doit pas répondre à la place du document vide.
      await this.cdp.send('Network.enable', {}, sid).then(() => this.cdp.send('Network.setBypassServiceWorker', { bypass: true }, sid)).catch(() => undefined);
      return await fn(sid);
    } finally {
      if (targetId !== undefined) { this.hub.attaching.delete(targetId); this.hub.claimed.delete(targetId); }
      if (sid !== undefined) this.scratch.delete(sid);
      if (targetId !== undefined) await this.cdp.send('Target.closeTarget', { targetId }).catch(() => undefined);
    }
  }

  /** Ouvre `origin` dans l'onglet d'état (document vide servi par Grasp) et y évalue du code FIXE. */
  private async inOrigin<T>(sid: string, origin: string, expression: string): Promise<T> {
    this.scratch.set(sid, origin);
    const nav = await this.cdp.send<{ errorText?: string }>('Page.navigate', { url: `${origin}/.grasp-etat` }, sid);
    if (nav.errorText) throw new Error(`ouverture de ${origin} impossible : ${nav.errorText}`);
    const end = Date.now() + 5000;
    for (;;) {
      const r = await this.cdp.send<{ result: { value?: unknown } }>('Runtime.evaluate', { expression: 'location.origin', returnByValue: true }, sid).catch(() => undefined);
      if (r?.result.value === origin) break;
      if (Date.now() > end) throw new Error(`ouverture de ${origin} : délai dépassé`);
      await sleep(20);
    }
    const r = await this.cdp.send<{ result: { value?: unknown }; exceptionDetails?: { text: string; exception?: { description?: string } } }>('Runtime.evaluate', { expression, returnByValue: true }, sid);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value as T;
  }

  /**
   * Exporte les cookies (allowlist) + le localStorage des origines connues (documents vus par la session,
   * origines des cookies, onglet courant, `extraOrigins`) + le sessionStorage de l'onglet. Rien hors allowlist.
   */
  async exportState(extraOrigins: string[] = []): Promise<{ state: GraspState; report: StateExportReport }> {
    this.stateAllowed();
    const allowed = this.policy.allowedDomains;
    const extra: string[] = [];
    for (const raw of extraOrigins) {
      const o = normalizeOrigin(raw);
      if (o === null) throw badRequest(`origine http(s) attendue : ${raw}`);
      if (!checkUrl(allowed, o).allowed) throw forbidden(`origine hors allowlist : ${o} (allowedDomains)`);
      extra.push(o);
    }
    const { cookies: all } = await this.cdp.send<{ cookies: CdpCookie[] }>('Storage.getCookies', {});
    const cookies = all.filter((c) => cookieAllowed(allowed, c.domain)).map(fromCdpCookie)
      .sort((a, b) => a.domain.localeCompare(b.domain) || a.path.localeCompare(b.path) || a.name.localeCompare(b.name));
    const here = normalizeOrigin((await this.location()).url);
    const candidates = new Set<string>([...this.seenOrigins, ...(here !== null ? [here] : []), ...extra]);
    for (const c of cookies) { const o = cookieOrigin(c); if (o !== null) candidates.add(o); }
    const origins: string[] = [];
    const originsExcluded: string[] = [];
    for (const o of [...candidates].sort()) (checkUrl(allowed, o).allowed ? origins : originsExcluded).push(o);
    const errors: string[] = [];
    const stored: GraspState['origins'] = [];
    if (origins.length > 0) {
      await this.withScratch(async (sid) => {
        for (const o of origins) {
          try {
            const items = JSON.parse(await this.inOrigin<string>(sid, o, READ_STORAGE_FN('localStorage'))) as StateItem[];
            if (items.length > 0) stored.push({ origin: o, localStorage: items });
          } catch (e) { errors.push(`localStorage de ${o} : ${(e as Error).message}`); }
        }
      });
    }
    const state: GraspState = { format: STATE_FORMAT, version: STATE_VERSION, exportedAt: new Date().toISOString(), cookies, origins: stored };
    if (here !== null && checkUrl(allowed, here).allowed) {
      try {
        const items = JSON.parse(await this.evalIsolated<string>(READ_STORAGE_FN('sessionStorage'))) as StateItem[];
        if (items.length > 0) state.sessionStorage = { origin: here, items };
      } catch (e) { errors.push(`sessionStorage de ${here} : ${(e as Error).message}`); }
    }
    return {
      state,
      report: {
        cookies: cookies.length, cookiesExcluded: all.length - cookies.length, origins: stored.map((o) => o.origin), originsExcluded,
        localStorageKeys: stored.reduce((n, o) => n + o.localStorage.length, 0), sessionStorage: state.sessionStorage?.origin ?? null, errors,
      },
    };
  }

  /**
   * Importe un état (format Grasp ou storageState de Playwright) : cookies posés dans le navigateur, localStorage
   * fusionné origine par origine (clés écrasées, autres clés gardées), sessionStorage appliqué à l'onglet (tout de
   * suite si son origine est affichée, sinon au premier document de cette origine). Hors allowlist : écarté, signalé.
   */
  async importState(raw: unknown): Promise<StateImportResult> {
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
      try { await this.cdp.send('Storage.setCookies', { cookies: [toCdpCookieParam(c)] }); cookies++; } catch (e) { skipped.push(`${what} : refusé par le navigateur (${(e as Error).message})`); }
    }
    const targets = st.origins.filter((o) => {
      if (checkUrl(allowed, o.origin).allowed) return o.localStorage.length > 0;
      skipped.push(`localStorage de ${o.origin} : origine hors allowlist`);
      return false;
    });
    let origins = 0;
    let keys = 0;
    if (targets.length > 0) {
      await this.withScratch(async (sid) => {
        for (const o of targets) {
          try {
            await this.inOrigin<number>(sid, o.origin, WRITE_STORAGE_FN('localStorage', o.localStorage));
            origins++; keys += o.localStorage.length;
          } catch (e) { skipped.push(`localStorage de ${o.origin} : ${(e as Error).message}`); }
        }
      });
    }
    let session: StateImportResult['sessionStorage'] = null;
    const ss = st.sessionStorage;
    if (ss !== undefined && ss.items.length > 0) {
      if (!checkUrl(allowed, ss.origin).allowed) skipped.push(`sessionStorage de ${ss.origin} : origine hors allowlist`);
      else if (normalizeOrigin((await this.location()).url) === ss.origin) {
        await this.evalIsolated(WRITE_STORAGE_FN('sessionStorage', ss.items));
        session = 'applied';
      } else {
        // Script du monde isolé (même stockage que la page, invisible pour ses scripts), retiré après usage.
        if (this.pendingSession !== undefined) await this.s('Page.removeScriptToEvaluateOnNewDocument', { identifier: this.pendingSession.identifier }).catch(() => undefined);
        const source = `if (location.origin === ${JSON.stringify(ss.origin)}) ${WRITE_STORAGE_FN('sessionStorage', ss.items)};`;
        const { identifier } = await this.s<{ identifier: string }>('Page.addScriptToEvaluateOnNewDocument', { source, worldName: 'grasp-etat' });
        this.pendingSession = { origin: ss.origin, identifier };
        session = 'pending';
      }
    }
    return { ok: true, cookies, origins, localStorageKeys: keys, sessionStorage: session, skipped };
  }

  /**
   * `grasp storage get|set|rm local|session <clé> [valeur]` : stockage Web de l'ORIGINE AFFICHÉE seulement (http(s),
   * dans l'allowlist), soumis à allowCookies comme l'export/import d'état (mêmes données : jetons de session).
   * Code FIXE dans le monde isolé (même stockage que la page, invisible pour ses scripts) : la clé et la valeur n'y
   * entrent que sérialisées en JSON — aucune évaluation arbitraire, d'où l'indépendance vis-à-vis d'allowEval.
   * get : valeur bornée à STORAGE_GET_MAX caractères, troncature annoncée.
   */
  async storage(op: string, area: string, key: string, value?: string): Promise<{ ok: true; op: 'get' | 'set' | 'rm'; origin: string; area: 'local' | 'session'; key: string; value?: string | null; truncated?: number; existed?: boolean }> {
    this.stateAllowed();
    if (op !== 'get' && op !== 'set' && op !== 'rm') throw badRequest(`opération inconnue « ${op} » (get, set, rm)`);
    if (area !== 'local' && area !== 'session') throw badRequest(`stockage inconnu « ${area} » (local ou session)`);
    if (key === '' || key.length > 1000) throw badRequest('clé attendue (1 à 1000 caractères)');
    if (op === 'set' && value === undefined) throw badRequest('storage set : valeur attendue');
    const origin = normalizeOrigin((await this.location()).url);
    if (origin === null) throw conflict('la page affichée n\'a pas d\'origine http(s) (about:blank ?) : naviguez d\'abord vers le site, puis posez la valeur (le stockage est celui de l\'origine affichée)');
    if (!checkUrl(this.policy.allowedDomains, origin).allowed) throw forbidden(`origine hors allowlist : ${origin}`);
    const s = area === 'local' ? 'localStorage' : 'sessionStorage';
    const args = JSON.stringify({ op, key, value: value ?? null });
    const r = await this.evalIsolated<{ value: string | null; existed: boolean }>(`((a) => { const s = ${s}; const old = s.getItem(a.key); if (a.op === 'set') s.setItem(a.key, a.value); else if (a.op === 'rm') s.removeItem(a.key); return { value: old, existed: old !== null }; })(${args})`);
    const base = { ok: true as const, op: op as 'get' | 'set' | 'rm', origin, area: area as 'local' | 'session', key };
    if (op !== 'get') return { ...base, existed: r.existed };
    if (r.value !== null && r.value.length > STORAGE_GET_MAX) return { ...base, value: r.value.slice(0, STORAGE_GET_MAX), truncated: r.value.length };
    return { ...base, value: r.value };
  }

  async cookies(): Promise<unknown[]> {
    if (!this.policy.allowCookies) throw forbidden('l\'accès aux cookies est désactivé (grasp config set allowCookies true)');
    const { cookies } = await this.s<{ cookies: unknown[] }>('Network.getCookies');
    return cookies;
  }

  /**
   * Recyclage (control plane seulement, jamais routé vers l'agent) : cookies de SESSION du navigateur (sans
   * expiration), que la relance perdrait — les cookies persistants, eux, sont sur disque dans le profil.
   */
  async sessionCookies(): Promise<SessionCookie[]> {
    const { cookies } = await this.cdp.send<{ cookies: Array<SessionCookie & { session?: boolean }> }>('Storage.getCookies');
    return cookies.filter((c) => c.session === true).map((c) => {
      const out: SessionCookie = { name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly };
      for (const k of ['sameSite', 'priority', 'sourceScheme', 'sourcePort', 'partitionKey'] as const) if (c[k] !== undefined) (out as unknown as Record<string, unknown>)[k] = c[k];
      return out;
    });
  }

  async restoreCookies(cookies: SessionCookie[]): Promise<number> {
    if (cookies.length > 0) await this.cdp.send('Storage.setCookies', { cookies });
    return cookies.length;
  }

  async upload(sel: string, files: string[], opts: { engine?: string | undefined } = {}): Promise<ActionResult> {
    // La politique d'abord, quel que soit le moteur : aucune connexion Playwright pour une action interdite.
    if (!this.policy.allowUpload) throw forbidden('l\'upload est désactivé (grasp config set allowUpload true)');
    for (const f of files) {
      if (!f.startsWith('/')) throw badRequest(`chemin absolu attendu : ${f}`);
      try { if (!statSync(f).isFile()) throw new Error(); } catch { throw badRequest(`fichier introuvable : ${f}`); }
    }
    if (this.engineFor(opts, sel) === 'playwright') return this.pwAct({}, sel, 'upload', (l) => l.setInputFiles(files, { timeout: PW_ACTION_TIMEOUT_MS }));
    return this.act({}, async (snap) => {
      const id = await this.resolve(sel, snap);
      const info = await this.describe(id);
      if (info.tag !== 'INPUT' || info.type !== 'file') throw badRequest('upload attend un <input type=file>');
      await this.s('DOM.setFileInputFiles', { files, backendNodeId: id });
    });
  }

  // ---------- Recette multi-pages (grasp audit / diff) : relevé de la page et liens internes ----------

  /** Statut HTTP du document, liens internes, entrées d'un sitemap XML (code fixe, monde isolé). */
  async inventory(): Promise<Inventory> {
    return await this.evalIsolated<Inventory>(INVENTORY_FN);
  }

  /**
   * Vérifie des liens de la même origine que la page courante, depuis la page (cookies, proxy et résolution
   * d'hôtes de la session) : HEAD, redirections non suivies. Autre origine ou hors allowlist : écarté sans requête.
   */
  async checkLinks(urls: string[]): Promise<{ results: LinkCheck[] }> {
    if (urls.length > CHECK_LINKS_MAX) throw badRequest(`${urls.length} liens : ${CHECK_LINKS_MAX} au plus par appel`);
    const { url } = await this.location();
    const { check, skipped } = splitLinks(this.policy.allowedDomains, url, urls);
    const checked = check.length > 0 ? await this.evalIsolated<LinkCheck[]>(checkLinksFn(check), true) : [];
    return { results: [...checked, ...skipped] };
  }
}

/**
 * `grasp history` (monde isolé) : le champ est-il secret ? password, ou autocomplete de mot de passe, de code à
 * usage unique ou de carte bancaire — sa valeur n'est jamais conservée dans l'historique.
 */
const SECRET_FIELD_FN = `function () {
  const el = this.nodeType === 1 ? this : this.parentElement;
  if (!el || el.localName !== 'input') return false;
  if (String(el.type).toLowerCase() === 'password') return true;
  const ac = String(el.getAttribute('autocomplete') || '').toLowerCase();
  return /(^|\\s)(current-password|new-password|one-time-code|cc-number|cc-csc)(\\s|$)/.test(ac);
}`;

/**
 * `grasp history` (monde isolé) : sélecteurs CSS candidats d'un élément, du plus durable au plus fragile. Le
 * bridge garde le premier qui ne désigne que cet élément dans le document. Un id « généré » (chiffres en
 * série, hexadécimal, :r1: de React…) n'est pas durable ; le chemin positionnel (nth-of-type) part de l'ancêtre
 * identifié le plus proche, en dernier recours.
 */
const STABLE_CSS_FN = `function () {
  const el = this.nodeType === 1 ? this : this.parentElement;
  if (!el) return [];
  const q = (v) => '"' + String(v).replace(/[\\\\"]/g, '\\\\$&').replace(/\\n/g, '\\\\a ') + '"';
  const generated = (v) => !v || v.length > 64 || /^[:_]|:$|\\d{3,}|(?=[a-f]*\\d)[0-9a-f]{6,}|^(ember|react|radix|mui|headlessui|ext-gen|yui|gwt)/i.test(v);
  const TEST = ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy'];
  const ident = (n) => {
    for (const a of TEST) { const v = n.getAttribute(a); if (v) return '[' + a + '=' + q(v) + ']'; }
    if (n.id && !generated(n.id)) return '#' + CSS.escape(n.id);
    for (const a of n.getAttributeNames()) if (/^data-(.*-)?(id|key)$/.test(a)) { const v = n.getAttribute(a); if (v && v.length <= 64) return n.localName + '[' + a + '=' + q(v) + ']'; }
    return undefined;
  };
  const tag = el.localName;
  const out = [];
  const own = ident(el);
  if (own) out.push(own);
  const nm = el.getAttribute('name');
  if (nm && /^(input|select|textarea|button)$/.test(tag)) {
    const t = el.getAttribute('type');
    const base = tag + '[name=' + q(nm) + ']';
    if (t === 'radio' || t === 'checkbox') { const v = el.getAttribute('value'); if (v !== null) out.push(base + '[value=' + q(v) + ']'); }
    out.push(base);
  }
  const al = el.getAttribute('aria-label');
  if (al) out.push(tag + '[aria-label=' + q(al) + ']');
  const href = tag === 'a' ? el.getAttribute('href') : null;
  if (href && !/^javascript:/i.test(href) && href.length <= 200) out.push('a[href=' + q(href) + ']');
  if (tag === 'input' && /^(submit|button|reset)$/.test(el.type) && el.value) out.push('input[type=' + q(el.type) + '][value=' + q(el.value) + ']');
  // Ancêtre identifié : « li[data-id="2"] button », puis chemin positionnel depuis lui (ou depuis body).
  const step = (n) => { let i = 1; for (let s = n.previousElementSibling; s; s = s.previousElementSibling) if (s.localName === n.localName) i++; return n.localName + ':nth-of-type(' + i + ')'; };
  let anchor = null, anchorSel = 'body';
  for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
    const id = ident(p);
    if (id) { anchor = p; anchorSel = id; break; }
  }
  if (anchor) {
    out.push(anchorSel + ' ' + tag);
    if (al) out.push(anchorSel + ' ' + tag + '[aria-label=' + q(al) + ']');
    if (nm) out.push(anchorSel + ' ' + tag + '[name=' + q(nm) + ']');
  }
  const path = [];
  for (let n = el; n && n !== anchor && n !== document.body && n !== document.documentElement; n = n.parentElement) path.unshift(step(n));
  if (path.length > 0 && path.length <= 12) out.push(anchorSel + ' > ' + path.join(' > '));
  return out;
}`;
