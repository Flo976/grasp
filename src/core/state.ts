import { checkUrl } from './policy.js';
import { badRequest } from './errors.js';

/**
 * État exportable d'une session : cookies + stockage local par origine (+ sessionStorage de l'onglet).
 * Format versionné, sur-ensemble du `storageState` de Playwright (`cookies`, `origins[].localStorage`) :
 * un fichier exporté par Playwright s'importe tel quel, et l'inverse.
 */
export const STATE_FORMAT = 'grasp-state';
export const STATE_VERSION = 1;
/** Corps d'un import (et de la route qui le relaie) : le localStorage peut peser plusieurs Mo par origine. */
export const STATE_MAX_BYTES = 64 * 1024 * 1024;

export type SameSite = 'Strict' | 'Lax' | 'None';

export interface StateCookie {
  name: string;
  value: string;
  /** Domaine du cookie : `.exemple.com` (cookie de domaine, sous-domaines compris) ou `exemple.com` (hôte seul). */
  domain: string;
  path: string;
  /** Secondes depuis l'epoch ; -1 = cookie de session. */
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: SameSite | undefined;
  priority?: 'Low' | 'Medium' | 'High' | undefined;
  /** Schéma et port d'origine (Chrome lie un cookie à son schéma et à son port). */
  sourceScheme?: 'Unset' | 'NonSecure' | 'Secure' | undefined;
  sourcePort?: number | undefined;
  /** Cookie partitionné (CHIPS) : site de premier niveau qui le possède. */
  partitionKey?: { topLevelSite: string; hasCrossSiteAncestor: boolean } | undefined;
}

export interface StateItem { name: string; value: string }
export interface StateOrigin { origin: string; localStorage: StateItem[] }
export interface StateSession { origin: string; items: StateItem[] }

export interface GraspState {
  format: typeof STATE_FORMAT;
  version: typeof STATE_VERSION;
  exportedAt: string;
  cookies: StateCookie[];
  origins: StateOrigin[];
  /** sessionStorage de l'onglet courant (une origine, celle du document affiché à l'export). */
  sessionStorage?: StateSession | undefined;
}

/** Cookie tel que le renvoie CDP (Storage.getCookies / Network.Cookie). */
export interface CdpCookie {
  name: string; value: string; domain: string; path: string; expires: number; session?: boolean;
  httpOnly: boolean; secure: boolean; sameSite?: string; priority?: string;
  sourceScheme?: string; sourcePort?: number; partitionKey?: unknown;
}

const SAME_SITE = new Set(['Strict', 'Lax', 'None']);
const PRIORITY = new Set(['Low', 'Medium', 'High']);
const SCHEME = new Set(['Unset', 'NonSecure', 'Secure']);

/** Cookie CDP → cookie de l'état (attributs utiles seulement : pas de `size`, ni de champs dérivés). */
export function fromCdpCookie(c: CdpCookie): StateCookie {
  const out: StateCookie = {
    name: c.name, value: c.value, domain: c.domain, path: c.path,
    expires: c.session === true || !(c.expires > 0) ? -1 : c.expires,
    httpOnly: c.httpOnly, secure: c.secure,
  };
  if (c.sameSite !== undefined && SAME_SITE.has(c.sameSite)) out.sameSite = c.sameSite as SameSite;
  if (c.priority !== undefined && PRIORITY.has(c.priority)) out.priority = c.priority as StateCookie['priority'];
  if (c.sourceScheme !== undefined && SCHEME.has(c.sourceScheme)) out.sourceScheme = c.sourceScheme as StateCookie['sourceScheme'];
  if (typeof c.sourcePort === 'number' && c.sourcePort > 0) out.sourcePort = c.sourcePort;
  const pk = c.partitionKey as { topLevelSite?: unknown; hasCrossSiteAncestor?: unknown } | undefined;
  if (pk !== undefined && pk !== null && typeof pk === 'object' && typeof pk.topLevelSite === 'string') {
    out.partitionKey = { topLevelSite: pk.topLevelSite, hasCrossSiteAncestor: pk.hasCrossSiteAncestor === true };
  }
  return out;
}

/** Cookie de l'état → `Network.CookieParam` (Storage.setCookies). Session : sans `expires`. */
export function toCdpCookieParam(c: StateCookie): Record<string, unknown> {
  const p: Record<string, unknown> = { name: c.name, value: c.value, domain: c.domain, path: c.path, httpOnly: c.httpOnly, secure: c.secure };
  if (c.expires > 0) p.expires = c.expires;
  if (c.sameSite !== undefined) p.sameSite = c.sameSite;
  if (c.priority !== undefined) p.priority = c.priority;
  if (c.sourceScheme !== undefined) p.sourceScheme = c.sourceScheme;
  if (c.sourcePort !== undefined) p.sourcePort = c.sourcePort;
  if (c.partitionKey !== undefined) p.partitionKey = c.partitionKey;
  return p;
}

const bracket = (h: string) => (h.includes(':') && !h.startsWith('[') ? `[${h}]` : h);

/**
 * Le cookie relève-t-il de l'allowlist ? Hôte du domaine autorisé ; pour un cookie de domaine
 * (`.exemple.com`), un sous-domaine autorisé suffit (`*.exemple.com`). Ni export ni import hors allowlist.
 */
export function cookieAllowed(allowed: readonly string[], domain: string): boolean {
  const host = bracket(domain.replace(/^\./, ''));
  if (host === '') return false;
  if (checkUrl(allowed, `http://${host}/`).allowed) return true;
  return domain.startsWith('.') && checkUrl(allowed, `http://grasp-sous-domaine.${host}/`).allowed;
}

/** Origine http(s) normalisée (`http://127.0.0.1:8080`), ou null. */
export function normalizeOrigin(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  return u.origin;
}

/** Origine probable d'un cookie (schéma et port d'origine retenus par Chrome) : où chercher un localStorage. */
export function cookieOrigin(c: StateCookie): string | null {
  const host = bracket(c.domain.replace(/^\./, ''));
  if (host === '') return null;
  const https = c.sourceScheme === 'Secure' || (c.sourceScheme === undefined && c.secure);
  const port = c.sourcePort;
  const def = https ? 443 : 80;
  return normalizeOrigin(`${https ? 'https' : 'http'}://${host}${port !== undefined && port !== def ? `:${port}` : ''}/`);
}

// ---------- Validation d'un fichier importé ----------

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function field<T>(o: Record<string, unknown>, k: string, type: 'string' | 'number' | 'boolean', where: string, required: true): T;
function field<T>(o: Record<string, unknown>, k: string, type: 'string' | 'number' | 'boolean', where: string, required: false): T | undefined;
function field<T>(o: Record<string, unknown>, k: string, type: 'string' | 'number' | 'boolean', where: string, required: boolean): T | undefined {
  const v = o[k];
  if (v === undefined || v === null) {
    if (required) throw badRequest(`${where} : champ « ${k} » requis`);
    return undefined;
  }
  if (typeof v !== type) throw badRequest(`${where} : champ « ${k} » : ${type} attendu`);
  return v as T;
}

function oneOf<T extends string>(v: string | undefined, set: Set<string>, k: string, where: string): T | undefined {
  if (v === undefined) return undefined;
  if (!set.has(v)) throw badRequest(`${where} : « ${k} » = ${JSON.stringify(v)} (attendu : ${[...set].join(', ')})`);
  return v as T;
}

function parseCookie(v: unknown, i: number): StateCookie {
  const where = `cookies[${i}]`;
  if (!isObj(v)) throw badRequest(`${where} : objet attendu`);
  const domain = field<string>(v, 'domain', 'string', where, true);
  if (domain === '' || domain === '.') throw badRequest(`${where} : « domain » vide`);
  const expires = field<number>(v, 'expires', 'number', where, false);
  if (expires !== undefined && !Number.isFinite(expires)) throw badRequest(`${where} : « expires » invalide`);
  const port = field<number>(v, 'sourcePort', 'number', where, false);
  if (port !== undefined && (!Number.isInteger(port) || port < -1 || port > 65535)) throw badRequest(`${where} : « sourcePort » invalide`);
  const c: StateCookie = {
    name: field<string>(v, 'name', 'string', where, true),
    value: field<string>(v, 'value', 'string', where, true),
    domain,
    path: field<string>(v, 'path', 'string', where, false) ?? '/',
    expires: expires === undefined || expires <= 0 ? -1 : expires,
    httpOnly: field<boolean>(v, 'httpOnly', 'boolean', where, false) === true, // attribut absent = cookie sans HttpOnly (sémantique HTTP)
    secure: field<boolean>(v, 'secure', 'boolean', where, false) === true,
  };
  const ss = oneOf<SameSite>(field<string>(v, 'sameSite', 'string', where, false), SAME_SITE, 'sameSite', where);
  if (ss !== undefined) c.sameSite = ss;
  const pr = oneOf<NonNullable<StateCookie['priority']>>(field<string>(v, 'priority', 'string', where, false), PRIORITY, 'priority', where);
  if (pr !== undefined) c.priority = pr;
  const sc = oneOf<NonNullable<StateCookie['sourceScheme']>>(field<string>(v, 'sourceScheme', 'string', where, false), SCHEME, 'sourceScheme', where);
  if (sc !== undefined) c.sourceScheme = sc;
  if (port !== undefined && port > 0) c.sourcePort = port;
  const pk = v.partitionKey;
  if (pk !== undefined && pk !== null) {
    if (!isObj(pk) || typeof pk.topLevelSite !== 'string') throw badRequest(`${where} : « partitionKey » : {topLevelSite, hasCrossSiteAncestor} attendu`);
    c.partitionKey = { topLevelSite: pk.topLevelSite, hasCrossSiteAncestor: pk.hasCrossSiteAncestor === true };
  }
  return c;
}

function parseOrigin(v: unknown, where: string, key: 'localStorage' | 'items'): { origin: string; items: StateItem[] } {
  if (!isObj(v)) throw badRequest(`${where} : objet attendu`);
  const raw = field<string>(v, 'origin', 'string', where, true);
  const origin = normalizeOrigin(raw);
  if (origin === null) throw badRequest(`${where} : origine http(s) attendue, reçu ${JSON.stringify(raw)}`);
  const items = v[key];
  if (!Array.isArray(items)) throw badRequest(`${where} : « ${key} » (tableau de {name, value}) requis`);
  return {
    origin,
    items: items.map((it, j) => {
      const w = `${where}.${key}[${j}]`;
      if (!isObj(it)) throw badRequest(`${w} : objet {name, value} attendu`);
      return { name: field<string>(it, 'name', 'string', w, true), value: field<string>(it, 'value', 'string', w, true) };
    }),
  };
}

/**
 * Valide un état à importer. Accepte le format Grasp (format = grasp-state, version 1) et le `storageState`
 * de Playwright (sans `format`). Version inconnue : refus explicite (jamais d'import partiel deviné).
 */
export function parseState(v: unknown): GraspState {
  if (!isObj(v)) throw badRequest('état : objet JSON attendu');
  if (v.format !== undefined) {
    if (v.format !== STATE_FORMAT) throw badRequest(`état : format inconnu ${JSON.stringify(v.format)} (attendu « ${STATE_FORMAT} »)`);
    if (v.version !== STATE_VERSION) throw badRequest(`état : version ${JSON.stringify(v.version)} non prise en charge (cette version de Grasp lit la version ${STATE_VERSION})`);
  } else if (!Array.isArray(v.cookies) && !Array.isArray(v.origins)) {
    throw badRequest(`état : ni « format »: "${STATE_FORMAT}", ni « cookies »/« origins » (storageState Playwright) — ce n'est pas un fichier d'état`);
  }
  const cookies = v.cookies === undefined ? [] : v.cookies;
  const origins = v.origins === undefined ? [] : v.origins;
  if (!Array.isArray(cookies)) throw badRequest('état : « cookies » : tableau attendu');
  if (!Array.isArray(origins)) throw badRequest('état : « origins » : tableau attendu');
  const st: GraspState = {
    format: STATE_FORMAT, version: STATE_VERSION,
    exportedAt: typeof v.exportedAt === 'string' ? v.exportedAt : '',
    cookies: cookies.map(parseCookie),
    origins: origins.map((o, i) => { const p = parseOrigin(o, `origins[${i}]`, 'localStorage'); return { origin: p.origin, localStorage: p.items }; }),
  };
  if (v.sessionStorage !== undefined && v.sessionStorage !== null) st.sessionStorage = parseOrigin(v.sessionStorage, 'sessionStorage', 'items');
  return st;
}
