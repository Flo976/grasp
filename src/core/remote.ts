/**
 * Accès à un serveur distant (recette à travers un tunnel SSH) : proxy, règles de résolution d'hôte,
 * certificats non vérifiés limités à des hôtes listés, identifiants HTTP basic par session.
 *
 * Les identifiants ne sont jamais recopiés dans un message d'erreur, un journal ou un rapport : seul
 * l'hôte en sort (`maskCredentials`).
 */

// ---------- Proxy ----------

const PROXY_RE = /^(http|https|socks4|socks5):\/\/(\[[0-9a-f:.]+\]|[a-z0-9]([a-z0-9.-]*[a-z0-9])?):(\d{1,5})$/i;

/** `scheme://hôte:port`, schémas http, https, socks4, socks5 ; jamais d'identifiants dans l'URL (Chrome les ignore). */
export function isProxyServer(v: string): boolean {
  const m = PROXY_RE.exec(v);
  return m !== null && Number(m[4]) > 0 && Number(m[4]) < 65536;
}

export function assertProxyServer(v: string): string {
  if (/@/.test(v)) throw new Error('proxy : identifiants dans l\'URL non pris en charge par Chrome (proxy sans authentification attendu)');
  if (!isProxyServer(v)) throw new Error('proxy attendu sous la forme schéma://hôte:port, schéma http, https, socks4 ou socks5 (ex. socks5://127.0.0.1:1080)');
  return v;
}

/** Entrée de --proxy-bypass-list : `*.local`, `10.0.0.0/8`, `<local>`, `<-loopback>`… sans blanc, virgule ni point-virgule. */
export function isBypassEntry(v: string): boolean {
  return /^[^\s,;]+$/.test(v);
}

// ---------- Règles de résolution d'hôte (--host-resolver-rules) ----------

const HOST_PAT = String.raw`(?:[a-z0-9*?_-][a-z0-9*?._-]*|\[[0-9a-f:.]+\])(?::\d{1,5})?`;
const TARGET = String.raw`(?:~NOTFOUND|\^NOTFOUND|(?:[a-z0-9_-][a-z0-9._-]*|\[[0-9a-f:.]+\])(?::\d{1,5})?)`;
const MAP_RE = new RegExp(`^MAP\\s+(${HOST_PAT})\\s+(${TARGET})$`, 'i');
const EXCLUDE_RE = new RegExp(`^EXCLUDE\\s+(${HOST_PAT})$`, 'i');

/**
 * Valide une règle de Chrome (`MAP <motif>[:port] <cible>[:port]` ou `EXCLUDE <motif>`). Chrome ignore en
 * silence une règle mal formée : on la refuse au démarrage plutôt que de la laisser sans effet.
 */
export function assertHostResolverRule(rule: string): string {
  const r = rule.trim().replace(/\s+/g, ' ');
  if (!MAP_RE.test(r) && !EXCLUDE_RE.test(r)) {
    throw new Error(`règle de résolution invalide ${JSON.stringify(rule)} : « MAP site.exemple.com 127.0.0.1:8443 » ou « EXCLUDE motif » attendu`);
  }
  const ports = [...r.matchAll(/:(\d{1,5})(?=\s|$)/g)].map((m) => Number(m[1]));
  if (ports.some((p) => !(p > 0 && p < 65536))) throw new Error(`règle de résolution invalide ${JSON.stringify(rule)} : port hors de 1-65535`);
  return r;
}

export function isHostResolverRule(rule: string): boolean {
  try { assertHostResolverRule(rule); return true; } catch { return false; }
}

// ---------- Hôtes ----------

/** Nom d'hôte normalisé (minuscules, sans point final, IPv6 entre crochets). */
export function normalizeHost(h: string): string {
  let x = h.trim().toLowerCase();
  if (x.endsWith('.')) x = x.slice(0, -1);
  if (x.includes(':') && !x.startsWith('[') && !x.startsWith('*')) x = `[${x}]`; // IPv6 nue
  return x;
}

/** Même sémantique que l'allowlist : nom exact, ou `*.exemple.com` = sous-domaines seulement, `*` = tout. */
export function hostMatches(entries: readonly string[], host: string): string | null {
  const h = normalizeHost(host);
  for (const raw of entries) {
    const e = normalizeHost(raw);
    if (e === '*') return e;
    if (e.startsWith('*.')) { if (h.endsWith(e.slice(1))) return e; } else if (h === e) return e;
  }
  return null;
}

/** Entrée de ignoreCertErrorsFor : un nom ou `*.domaine`, jamais `*` seul (la dérogation reste limitée à des hôtes listés). */
export function isCertHost(v: string): boolean {
  const t = v.trim();
  return t !== '*' && /^(\*\.)?([a-z0-9_-]+\.)*[a-z0-9_-]+$|^\[[0-9a-f:.]+\]$/i.test(t);
}

// ---------- Identifiants HTTP basic (par session, jamais sur disque) ----------

export interface HttpCredential {
  /** Nom d'hôte normalisé. */
  host: string;
  /** Port exigé, si précisé (sinon tout port de cet hôte). */
  port?: number;
  username: string;
  password: string;
}

/** Ce qui peut sortir d'une session : l'hôte, jamais les identifiants. */
export interface MaskedCredential { host: string; credentials: '***' }

const AUTH_USAGE = 'identifiants HTTP attendus sous la forme utilisateur:motdepasse@hôte[:port]';

/**
 * `utilisateur:motdepasse@hôte[:port]`. Le mot de passe peut contenir « : » et « @ » (on coupe au DERNIER
 * « @ » et au PREMIER « : »). Le message d'erreur ne cite jamais la valeur reçue.
 */
export function parseHttpAuth(raw: string): HttpCredential {
  const at = raw.lastIndexOf('@');
  if (at <= 0) throw new Error(AUTH_USAGE);
  const userinfo = raw.slice(0, at);
  const hostPart = raw.slice(at + 1).trim();
  const colon = userinfo.indexOf(':');
  if (colon <= 0) throw new Error(`${AUTH_USAGE} (utilisateur ou « : » manquant)`);
  const username = userinfo.slice(0, colon);
  const password = userinfo.slice(colon + 1);
  if (/[\r\n]/.test(userinfo)) throw new Error(`${AUTH_USAGE} (retour à la ligne interdit)`);
  const hm = /^(\[[0-9a-f:.]+\]|[a-z0-9]([a-z0-9.-]*[a-z0-9])?)(?::(\d{1,5}))?$/i.exec(hostPart);
  if (hm === null) throw new Error(`${AUTH_USAGE} (hôte invalide)`);
  const port = hm[3] !== undefined ? Number(hm[3]) : undefined;
  if (port !== undefined && !(port > 0 && port < 65536)) throw new Error(`${AUTH_USAGE} (port hors de 1-65535)`);
  return { host: normalizeHost(hm[1]!), ...(port !== undefined ? { port } : {}), username, password };
}

export function credentialLabel(c: Pick<HttpCredential, 'host' | 'port'>): string {
  return c.port !== undefined ? `${c.host}:${c.port}` : c.host;
}

export function maskCredentials(list: readonly HttpCredential[]): MaskedCredential[] {
  return list.map((c) => ({ host: credentialLabel(c), credentials: '***' as const }));
}

/** Identifiants de cette URL : même hôte et, si le port est précisé, même port (ports par défaut compris). */
export function credentialFor(list: readonly HttpCredential[], url: string): HttpCredential | undefined {
  let u: URL;
  try { u = new URL(url); } catch { return undefined; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
  const host = normalizeHost(u.hostname);
  const port = u.port !== '' ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
  return list.find((c) => c.host === host && (c.port === undefined || c.port === port));
}

// ---------- Réconciliation avec la protection SSRF ----------

/** Motif glob de Chrome (`*` et `?`, MatchPattern), sur la chaîne entière. */
function globMatch(pattern: string, s: string): boolean {
  const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
  return re.test(s);
}

/** Cible d'une règle MAP qui s'applique : hôte de remplacement (sans port), ou `~NOTFOUND`. */
export interface MappedTarget { rule: string; target: string }

/**
 * Règle MAP de --host-resolver-rules qui s'applique à `host:port`, comme Chrome (HostMappingRules::RewriteHost) :
 * une règle EXCLUDE dont le motif couvre le nom l'emporte ; sinon la PREMIÈRE règle MAP dont le motif couvre
 * `hôte:port` ou `hôte` seul. `null` : le nom est résolu normalement.
 */
export function mappedTarget(rules: readonly string[], host: string, port: number): MappedTarget | null {
  const h = normalizeHost(host);
  const parsed = rules.map((r) => r.trim().replace(/\s+/g, ' ').split(' '));
  for (const p of parsed) if (p[0]?.toUpperCase() === 'EXCLUDE' && p[1] !== undefined && globMatch(p[1].toLowerCase(), h)) return null;
  for (const p of parsed) {
    if (p[0]?.toUpperCase() !== 'MAP' || p[1] === undefined || p[2] === undefined) continue;
    const pat = p[1].toLowerCase();
    if (!globMatch(pat, `${h}:${port}`) && !globMatch(pat, h)) continue;
    const t = p[2];
    const target = /^[~^]NOTFOUND$/i.test(t) ? '~NOTFOUND' : normalizeHost(t.startsWith('[') ? t.slice(0, t.indexOf(']') + 1) : t.replace(/:\d+$/, ''));
    return { rule: `MAP ${p[1]} ${p[2]}`, target };
  }
  return null;
}

/**
 * Le proxy résout-il ce nom à la place de Chrome ? Oui pour http(s) et socks5 (le nom est transmis au proxy),
 * non pour socks4 (Chrome résout lui-même) ni pour un hôte de proxyBypassList (connexion directe). Chrome
 * contourne aussi d'office la boucle locale (localhost, 127/8, [::1]) : ces hôtes sont jugés sans DNS de toute façon.
 * Contournement reconnu : nom exact, joker (`*.x`, `.x`), `<local>` (nom sans point) ; schéma et port ignorés.
 */
export function proxyResolves(proxyServer: string | null, bypass: readonly string[], host: string): boolean {
  if (proxyServer === null || /^socks4:/i.test(proxyServer)) return false;
  const h = normalizeHost(host);
  for (const raw of bypass) {
    let e = raw.trim().toLowerCase().replace(/^[a-z0-9+.-]+:\/\//, '');
    if (e === '<local>') { if (!h.includes('.') && !h.startsWith('[')) return false; continue; }
    if (e.startsWith('<') || e.includes('/')) continue; // <-loopback>, plages CIDR : pour des adresses, pas des noms
    e = e.replace(/:\d+$/, '');
    if (e.startsWith('.')) e = `*${e}`;
    if (globMatch(e, h)) return false;
  }
  return true;
}
