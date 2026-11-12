import { GraspError, badRequest } from './errors.js';
import type { ExpectMatch } from './expect.js';
import { redactUrl } from './console.js';

/**
 * Journal réseau d'un onglet (dans le bridge) : une entrée par requête vue par le domaine CDP Network — celui
 * que la console et l'attente de stabilité écoutent déjà (aucun autre abonnement). Méthode, URL masquée
 * (redactUrl), type, statut, durée. JAMAIS d'en-têtes ni de corps : Grasp ne les demande pas au navigateur
 * (`maxTotalBufferSize: 0`). Mise en forme et filtres partagés avec la CLI et `expect request`.
 */

export interface NetEntry {
  /** Numéro croissant, attribué au départ de la requête (chaque saut d'une redirection a le sien). */
  seq: number;
  /** Départ (ms epoch). */
  at: number;
  method: string;
  /** URL masquée : identifiants retirés, paramètres sensibles en ***, 300 caractères au plus. */
  url: string;
  /** Type CDP en minuscules : document, xhr, fetch, script, stylesheet, image, font… */
  type: string;
  status?: number;
  statusText?: string;
  /** Échec réseau (`net::ERR_…`), ou « annulée » (navigation qui part, AbortController). */
  error?: string;
  /** Durée (requête terminée) ou temps écoulé (en cours). */
  ms?: number;
  /** Pas encore terminée au moment de la lecture. */
  pending?: true;
  /** Requête d'une iframe (cadre autre que le principal). */
  frame?: true;
  /** Annulée par Grasp (garde de navigation, traqueur). */
  blocked?: true;
  /** Servie par le cache du navigateur. */
  cached?: true;
}

export interface NetQuery {
  since?: number | undefined;
  /** Seulement les échecs : statut ≥ 400, erreur réseau, blocage (pas les annulations). */
  failed?: boolean | undefined;
  /** N dernières lignes (après filtres). */
  limit?: number | undefined;
  /** Types gardés (minuscules). */
  types?: readonly string[] | undefined;
}
export interface NetResult {
  entries: NetEntry[];
  /** Dernier seq attribué : à passer en --since à l'appel suivant. */
  seq: number;
  /** Entrées postérieures à `since` tombées du tampon circulaire avant d'avoir été lues. */
  dropped: number;
  /** Lignes (après filtres) écartées par `limit` : les plus anciennes. */
  omitted: number;
}

/** Types CDP (Network.ResourceType), en minuscules. */
export const NET_TYPES = ['document', 'stylesheet', 'image', 'media', 'font', 'script', 'texttrack', 'xhr', 'fetch', 'prefetch', 'eventsource', 'websocket', 'manifest', 'signedexchange', 'ping', 'cspviolationreport', 'preflight', 'other'] as const;

export const CANCELED = 'annulée';

interface Live { entry: NetEntry | undefined; method: string; url: string; t0: number }

/** Horodatage CDP (secondes, horloge monotone) → ms ; absent : horloge locale. */
const tsMs = (ts: unknown): number => (typeof ts === 'number' && Number.isFinite(ts) ? ts * 1000 : performance.now());

export function isFailed(e: NetEntry): boolean {
  return (e.status !== undefined && e.status >= 400) || e.blocked === true || (e.error !== undefined && e.error !== CANCELED);
}

export function parseTypes(v: string | readonly string[] | undefined): string[] | undefined {
  if (v === undefined) return undefined;
  const list = (typeof v === 'string' ? v.split(',') : [...v]).map((x) => x.trim().toLowerCase()).filter((x) => x !== '');
  if (list.length === 0) throw badRequest('--type : au moins un type attendu (ex. xhr,fetch)');
  for (const t of list) if (!(NET_TYPES as readonly string[]).includes(t)) throw badRequest(`type de requête inconnu « ${t} » (types : ${NET_TYPES.join(', ')})`);
  return list;
}

export class NetworkLog {
  private readonly items: NetEntry[] = [];
  /** Requêtes en vol : méthode et URL brutes (messages de la console, allowlist), entrée du journal. */
  private readonly live = new Map<string, Live>();
  private last = 0;

  constructor(private readonly capacity = 1000, private readonly maxLive = 2000) {}

  get seq(): number { return this.last; }

  /** Méthode et URL brutes d'une requête en vol (jamais exposées telles quelles : redactUrl à l'affichage). */
  request(id: string): { method: string; url: string } | undefined {
    const l = this.live.get(id);
    return l === undefined ? undefined : { method: l.method, url: l.url };
  }

  /**
   * Network.requestWillBeSent. Même requestId avec `redirect` : le saut précédent est clos avec le statut de la
   * redirection, et le nouveau saut a sa propre entrée. data: et blob: : suivis (console) mais pas journalisés.
   */
  start(id: string, r: { method: string; url: string; type: string; ts?: unknown; wallTime?: unknown; frame?: boolean; redirect?: { status: number; statusText?: string } | undefined }): void {
    const t0 = tsMs(r.ts);
    const prev = this.live.get(id);
    if (prev !== undefined && prev.entry !== undefined) {
      const e = prev.entry;
      if (r.redirect !== undefined) { e.status = r.redirect.status; if (r.redirect.statusText) e.statusText = r.redirect.statusText; }
      e.ms = Math.max(0, Math.round(t0 - prev.t0));
      delete e.pending;
    }
    this.live.delete(id);
    if (this.live.size >= this.maxLive) this.live.delete(this.live.keys().next().value as string);
    let entry: NetEntry | undefined;
    if (!/^(data|blob):/.test(r.url)) {
      const wall = typeof r.wallTime === 'number' && Number.isFinite(r.wallTime) ? Math.round(r.wallTime * 1000) : Date.now();
      entry = { seq: ++this.last, at: wall, method: r.method, url: redactUrl(r.url, 300), type: r.type.toLowerCase(), pending: true, ...(r.frame === true ? { frame: true as const } : {}) };
      this.items.push(entry);
      if (this.items.length > this.capacity) this.items.shift();
    }
    this.live.set(id, { entry, method: r.method, url: r.url, t0 });
  }

  /** Network.responseReceived. */
  response(id: string, status: number, statusText: string | undefined, cached: boolean): void {
    const e = this.live.get(id)?.entry;
    if (e === undefined || !Number.isFinite(status)) return;
    e.status = status;
    if (statusText) e.statusText = statusText;
    if (cached) e.cached = true;
  }

  /** Network.requestServedFromCache. */
  cached(id: string): void {
    const e = this.live.get(id)?.entry;
    if (e !== undefined) e.cached = true;
  }

  /** Network.loadingFinished. */
  finish(id: string, ts: unknown): void {
    const l = this.live.get(id);
    this.live.delete(id);
    if (l?.entry === undefined) return;
    l.entry.ms = Math.max(0, Math.round(tsMs(ts) - l.t0));
    delete l.entry.pending;
  }

  /** Network.loadingFailed. `blocked` : annulée par Grasp (garde, traqueur). */
  fail(id: string, ts: unknown, errorText: string | undefined, o: { canceled?: boolean; blocked?: boolean } = {}): void {
    const l = this.live.get(id);
    this.live.delete(id);
    if (l?.entry === undefined) return;
    const e = l.entry;
    e.ms = Math.max(0, Math.round(tsMs(ts) - l.t0));
    delete e.pending;
    if (o.blocked === true) { e.blocked = true; e.error = errorText !== undefined && errorText !== '' ? errorText : 'bloquée'; }
    else e.error = o.canceled === true ? CANCELED : (errorText !== undefined && errorText !== '' ? errorText : 'échec');
  }

  /**
   * Nouveau document du cadre principal : les requêtes de l'ancien (seq ≤ upTo, départ du nouveau document) qui
   * n'ont jamais rapporté leur fin sont closes (« annulée »), sinon elles resteraient « en cours » pour toujours.
   */
  abandonPending(upTo: number, now = Date.now()): void {
    for (const e of this.items) {
      if (e.pending !== true || e.seq > upTo) continue;
      delete e.pending;
      if (e.status === undefined && e.error === undefined) e.error = CANCELED;
      e.ms = Math.max(0, now - e.at);
    }
  }

  query(q: NetQuery = {}): NetResult {
    const since = q.since !== undefined ? q.since : 0;
    if (since > this.last) throw new GraspError(409, `since ${since} dépasse le seq réseau courant ${this.last} : le journal a été recréé (bascule de profil, bridge relancé) — reprenez avec --since 0`, { seq: this.last });
    const oldest = this.items.length > 0 ? this.items[0]!.seq : this.last + 1;
    const dropped = Math.max(0, Math.min(oldest, this.last + 1) - (since + 1));
    const now = Date.now();
    let list = this.items.filter((e) => e.seq > since);
    if (q.types !== undefined) { const t = new Set(q.types); list = list.filter((e) => t.has(e.type)); }
    if (q.failed === true) list = list.filter(isFailed);
    const kept = q.limit !== undefined ? (q.limit > 0 ? list.slice(-q.limit) : []) : list;
    // Copies : une requête en cours porte le temps écoulé à la lecture, sans toucher au journal.
    const entries = kept.map((e) => (e.pending === true ? { ...e, ms: Math.max(0, now - e.at) } : { ...e }));
    return { entries, seq: this.last, dropped, omitted: list.length - kept.length };
  }
}

const URL_SHOWN = 150;

/** « #seq MÉTHODE url → statut · durée · type » ; en cours : « → en cours · 812 ms · fetch ». */
export function formatNet(e: NetEntry): string {
  const url = e.url.length > URL_SHOWN ? `${e.url.slice(0, URL_SHOWN)}…` : e.url;
  const outcome = e.pending === true ? 'en cours'
    : e.error !== undefined ? `${e.error}${e.blocked === true ? ' [bloquée par Grasp]' : ''}${e.status !== undefined ? ` (après ${e.status})` : ''}`
      : e.status !== undefined ? `${e.status}${e.statusText !== undefined ? ` ${e.statusText}` : ''}` : 'terminée';
  const tail = [e.ms !== undefined ? `${e.ms} ms` : undefined, e.type, e.cached === true ? 'cache' : undefined, e.frame === true ? 'iframe' : undefined].filter((x) => x !== undefined);
  return `#${e.seq} ${e.method} ${url} → ${outcome} · ${tail.join(' · ')}`;
}

/** Pertes du journal réseau jamais tues (mêmes messages que la commande isolée). */
export function networkLosses(c: { since?: number | undefined; omitted?: number | undefined; dropped?: number | undefined }, perAction: boolean): string[] {
  const w: string[] = [];
  if (typeof c.dropped === 'number' && c.dropped > 0) w.push(`AVERTISSEMENT : ${c.dropped} requête(s) perdue(s) avant lecture (journal circulaire de 1000 requêtes)`);
  if (typeof c.omitted === 'number' && c.omitted > 0) w.push(`AVERTISSEMENT : ${c.omitted} requête(s) plus ancienne(s) non affichée(s)${perAction ? ' (100 au plus par action)' : ''}${typeof c.since === 'number' ? ` — grasp network --since ${c.since} --max 1000` : ' — --max N ou --since <seq>'}`);
  return w;
}

// ---------- expect request ----------

export interface RequestPattern { method?: string; url: string }

/** « POST /api/commande » → méthode (en capitales) et motif d'URL ; sans méthode : toute méthode. */
export function parseRequestTarget(t: string): RequestPattern {
  const s = t.trim();
  const m = /^([A-Z]+)\s+(\S.*)$/.exec(s);
  const p: RequestPattern = m !== null ? { method: m[1]!, url: m[2]!.trim() } : { url: s };
  if (p.url === '') throw badRequest('expect request : motif d\'URL vide (ex. "POST /api/commande")');
  return p;
}

const STATUS_RE = /^[1-5](?:xx|\d\d)$/i;

/** « 2xx », « 201 », « 2xx,304 » → prédicat ; invalide → 400. */
export function parseStatus(spec: string): (n: number) => boolean {
  const parts = spec.split(',').map((x) => x.trim().toLowerCase());
  if (parts.length === 0 || parts.some((x) => !STATUS_RE.test(x))) throw badRequest(`statut attendu « ${spec} » : code (201), classe (2xx) ou liste (2xx,304)`);
  return (n: number) => parts.some((x) => (x.endsWith('xx') ? Math.floor(n / 100) === Number(x[0]) : n === Number(x)));
}

export const DEFAULT_REQUEST_STATUS = '2xx';

/**
 * L'URL d'une entrée correspond-elle au motif ? exact : un motif `/chemin` est comparé au chemin de l'URL (la
 * requête en est ignorée, sauf si le motif contient `?`), une URL absolue à origine + chemin ; contains (`~`) et
 * regex : sur l'URL affichée (masquée). Jamais sur l'URL brute : un motif ne peut pas sonder un jeton masqué.
 */
export function urlMatches(entryUrl: string, pattern: string, match: ExpectMatch): boolean {
  if (match === 'contains') return entryUrl.includes(pattern);
  if (match === 'regex') return regexOf(pattern).test(entryUrl);
  let u: URL;
  try { u = new URL(entryUrl); } catch { return entryUrl === pattern; }
  const withQuery = pattern.includes('?');
  const path = withQuery ? `${u.pathname}${u.search}` : u.pathname;
  if (pattern.startsWith('/')) return path === pattern;
  return `${u.origin}${path}` === pattern;
}

/** Expression régulière d'un motif ; invalide → 400. */
export function regexOf(p: string): RegExp {
  try { return new RegExp(p); } catch (e) { throw badRequest(`expression régulière invalide /${p}/ : ${(e as Error).message}`); }
}

export function requestMatches(e: NetEntry, p: RequestPattern, match: ExpectMatch): boolean {
  return (p.method === undefined || e.method === p.method) && urlMatches(e.url, p.url, match);
}
