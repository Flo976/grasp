import type { ResolvedConfig } from './config.js';
import { hostMatches, mappedTarget, normalizeHost, proxyResolves } from './remote.js';
import { classifyIp, isLocalhostName, systemResolver, type Resolver } from './ssrf.js';

export { normalizeHost };

/**
 * Politique effective. Construite UNE fois par `effectivePolicy`, gelée, puis passée telle quelle
 * au garde runtime ET au rapport (/security/effective). Règle n°3 : ce qui rapporte lit ce qui applique.
 */
export interface EffectivePolicy {
  allowedDomains: readonly string[];
  allowEval: boolean;
  allowDownload: boolean;
  allowUpload: boolean;
  allowCookies: boolean;
  /** Lecture console (tampon du bridge). false : aucune capture, Runtime/Log/Network jamais activés pour elle. */
  allowConsole: boolean;
  /**
   * Protection SSRF levée : un nom admis par l'allowlist peut résoudre vers une adresse privée ou réservée.
   * false (défaut) : seuls les hôtes LITTÉRAUX inscrits tels quels dans l'allowlist (127.0.0.1, localhost,
   * [::1]…) peuvent viser une telle adresse.
   */
  allowPrivateNetwork: boolean;
  /** Proxy de Chrome (--proxy-server), null = connexion directe. Une session peut le surcharger (rapportée à part). */
  proxyServer: string | null;
  /** --proxy-bypass-list (sans effet sans proxy). */
  proxyBypassList: readonly string[];
  /** --host-resolver-rules : l'allowlist porte sur le NOM demandé, jamais sur l'adresse cible. */
  hostResolverRules: readonly string[];
  /** Hôtes dont le certificat TLS n'est PAS vérifié (vide par défaut ; dérogation limitée à ces hôtes). */
  ignoreCertErrorsFor: readonly string[];
  /** Requêtes vers les domaines de la liste de traqueurs embarquée : annulées dans le navigateur (garde Fetch). */
  blockTrackers: boolean;
  /** Le blocage n'est pas configurable : détecter ≠ bloquer, on bloque toujours. */
  navigation: 'enforce';
  tokenRequired: true;
}

export function effectivePolicy(cfg: ResolvedConfig): Readonly<EffectivePolicy> {
  return Object.freeze({
    allowedDomains: Object.freeze(cfg.allowedDomains.map(normalizeHost)),
    allowEval: cfg.allowEval,
    allowDownload: cfg.allowDownload,
    allowUpload: cfg.allowUpload,
    allowCookies: cfg.allowCookies,
    allowConsole: cfg.allowConsole,
    allowPrivateNetwork: cfg.allowPrivateNetwork,
    proxyServer: cfg.proxyServer,
    proxyBypassList: Object.freeze([...cfg.proxyBypassList]),
    hostResolverRules: Object.freeze([...cfg.hostResolverRules]),
    ignoreCertErrorsFor: Object.freeze(cfg.ignoreCertErrorsFor.map(normalizeHost)),
    blockTrackers: cfg.blockTrackers,
    navigation: 'enforce' as const,
    tokenRequired: true as const,
  });
}

export interface UrlVerdict { allowed: boolean; reason: string }

/** Fail-closed : liste vide = tout bloqué ; schéma non http(s) bloqué (sauf about:blank). */
export function checkUrl(allowedDomains: readonly string[], url: string): UrlVerdict {
  let u: URL;
  try { u = new URL(url); } catch { return { allowed: false, reason: `URL invalide : ${url}` }; }
  if (u.protocol === 'about:') {
    return u.href === 'about:blank' ? { allowed: true, reason: 'about:blank' } : { allowed: false, reason: `schéma interdit : ${u.href}` };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { allowed: false, reason: `schéma interdit : ${u.protocol}` };
  const host = normalizeHost(u.hostname);
  if (allowedDomains.length === 0) return { allowed: false, reason: `domaine hors allowlist : ${host} (allowlist vide = tout bloqué)` };
  const hit = hostMatches(allowedDomains, host);
  if (hit !== null) return { allowed: true, reason: hit === '*' ? 'allowlist *' : `allowlist ${hit}` };
  return { allowed: false, reason: `domaine hors allowlist : ${host}` };
}

/**
 * Hôte « explicitement autorisé comme local » : une entrée EXACTE de l'allowlist (pas un joker) qui est une
 * adresse IP littérale ou un nom `localhost`. Sa cible est connue sans DNS : l'inscrire, c'est y consentir.
 */
export function isExplicitLocal(allowedDomains: readonly string[], host: string): boolean {
  if (classifyIp(host) === undefined && !isLocalhostName(host)) return false;
  return allowedDomains.some((e) => normalizeHost(e) === host);
}

/**
 * Verdict sur l'adresse effectivement visée (après l'allowlist) : `null` si elle est admise, sinon la raison.
 * Adresse IP littérale et `*.localhost` : jugées sans DNS. Nom : toutes les adresses résolues sont jugées,
 * une seule privée suffit à refuser (le navigateur peut choisir n'importe laquelle). Résolution impossible :
 * refus (fail-closed).
 */
export async function privateTargetReason(policy: Pick<EffectivePolicy, 'allowedDomains' | 'allowPrivateNetwork'>, host: string, resolve: Resolver = systemResolver): Promise<string | null> {
  if (policy.allowPrivateNetwork) return null;
  if (isExplicitLocal(policy.allowedDomains, host)) return null;
  const literal = classifyIp(host);
  if (literal !== undefined) return literal === null ? null : `adresse ${literal} : ${host} (inscrivez-la telle quelle dans l'allowlist, ou allowPrivateNetwork=true)`;
  if (isLocalhostName(host)) return `boucle locale : ${host} (inscrivez-le tel quel dans l'allowlist, ou allowPrivateNetwork=true)`;
  let addrs: string[];
  try { addrs = await resolve(host); } catch (e) {
    return `résolution DNS impossible pour ${host} (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}) : refus par prudence`;
  }
  if (addrs.length === 0) return `résolution DNS vide pour ${host} : refus par prudence`;
  for (const a of addrs) {
    const c = classifyIp(a);
    if (c === undefined) return `résolution DNS inattendue pour ${host} (${a}) : refus par prudence`;
    if (c !== null) return `${host} résout vers une adresse ${c} (${a}) — protection SSRF ; allowPrivateNetwork=true pour l'autoriser`;
  }
  return null;
}

/**
 * Contexte réseau de la protection SSRF. Les champs d'accès distant sont facultatifs (absents = connexion
 * directe, aucune règle) ; `proxyServer` est le proxy EFFECTIF (celui de la session s'il la surcharge).
 */
export type SsrfContext = Pick<EffectivePolicy, 'allowedDomains' | 'allowPrivateNetwork'>
  & Partial<Pick<EffectivePolicy, 'hostResolverRules' | 'proxyServer' | 'proxyBypassList'>>;

/** Comment Chrome joindra cet hôte : règle MAP de l'utilisateur, proxy qui résout le nom, ou résolution locale. */
export type Route =
  | { kind: 'mapped'; rule: string; target: string }
  | { kind: 'proxy'; proxyServer: string }
  | { kind: 'direct' };

export function routeOf(ctx: SsrfContext, host: string, port: number): Route {
  // Champ absent = aucune règle, aucun proxy, aucun contournement (contexte réduit des tests unitaires SSRF).
  const m = ctx.hostResolverRules !== undefined ? mappedTarget(ctx.hostResolverRules, host, port) : null;
  if (m !== null) return { kind: 'mapped', ...m };
  const proxy = ctx.proxyServer;
  if (proxy !== undefined && proxy !== null && proxyResolves(proxy, ctx.proxyBypassList !== undefined ? ctx.proxyBypassList : [], host)) return { kind: 'proxy', proxyServer: proxy };
  return { kind: 'direct' };
}

/** Port effectif d'une URL http(s). */
export function urlPort(u: URL): number { return u.port !== '' ? Number(u.port) : u.protocol === 'https:' ? 443 : 80; }

/**
 * Cible jugée par la protection SSRF, selon la route :
 * - règle MAP de hostResolverRules (choix explicite de l'utilisateur, ex. tunnel `ssh -L`) : la cible de la
 *   règle est traitée comme un littéral inscrit — adresse IP, `localhost` ou ~NOTFOUND : admise sans DNS ;
 *   nom : jugé comme tout nom (résolu par le DNS, puisque l'utilisateur n'a pas écrit l'adresse). Le nom
 *   demandé, lui, n'est jamais résolu par le DNS système ;
 * - proxy qui résout les noms (http, https, socks5, hors proxyBypassList) : AUCUNE résolution locale (elle ne
 *   dirait rien de ce que le proxy joindra) ; seuls les littéraux et `*.localhost` restent jugés. Limite
 *   assumée : la protection SSRF ne couvre pas ce que le proxy résout de son côté ;
 * - sinon : contrôle complet (`privateTargetReason`).
 */
export async function routedTargetReason(ctx: SsrfContext, u: URL, resolve: Resolver = systemResolver): Promise<string | null> {
  if (ctx.allowPrivateNetwork) return null;
  const host = normalizeHost(u.hostname);
  const r = routeOf(ctx, host, urlPort(u));
  if (r.kind === 'mapped') {
    if (r.target === '~NOTFOUND' || classifyIp(r.target) !== undefined || isLocalhostName(r.target)) return null;
    const why = await privateTargetReason({ allowedDomains: [], allowPrivateNetwork: false }, r.target, resolve);
    return why === null ? null : `${host} → ${r.target} (règle « ${r.rule} ») : ${why}`;
  }
  if (r.kind === 'proxy' && classifyIp(host) === undefined && !isLocalhostName(host)) return null;
  return privateTargetReason(ctx, host, resolve);
}

/** Allowlist, puis protection SSRF : ce que le pré-contrôle et le garde runtime appliquent à chaque document. */
export async function checkNavigation(ctx: SsrfContext, url: string, resolve: Resolver = systemResolver): Promise<UrlVerdict> {
  const v = checkUrl(ctx.allowedDomains, url);
  if (!v.allowed || v.reason === 'about:blank') return v;
  const why = await routedTargetReason(ctx, new URL(url), resolve);
  return why === null ? v : { allowed: false, reason: why };
}
