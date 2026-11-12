import type { ResolvedConfig } from './config.js';
import { classifyIp, isLocalhostName, systemResolver, type Resolver } from './ssrf.js';

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
    navigation: 'enforce' as const,
    tokenRequired: true as const,
  });
}

export function normalizeHost(h: string): string {
  let x = h.trim().toLowerCase();
  if (x.endsWith('.')) x = x.slice(0, -1);
  if (x.includes(':') && !x.startsWith('[') && !x.startsWith('*')) x = `[${x}]`; // IPv6 nue
  return x;
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
  for (const raw of allowedDomains) {
    const entry = normalizeHost(raw);
    if (entry === '*') return { allowed: true, reason: 'allowlist *' };
    if (entry.startsWith('*.')) {
      if (host.endsWith(entry.slice(1))) return { allowed: true, reason: `allowlist ${entry}` };
    } else if (host === entry) return { allowed: true, reason: `allowlist ${entry}` };
  }
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

/** Allowlist, puis protection SSRF : ce que le pré-contrôle et le garde runtime appliquent à chaque document. */
export async function checkNavigation(policy: Pick<EffectivePolicy, 'allowedDomains' | 'allowPrivateNetwork'>, url: string, resolve: Resolver = systemResolver): Promise<UrlVerdict> {
  const v = checkUrl(policy.allowedDomains, url);
  if (!v.allowed || v.reason === 'about:blank') return v;
  const why = await privateTargetReason(policy, normalizeHost(new URL(url).hostname), resolve);
  return why === null ? v : { allowed: false, reason: why };
}
