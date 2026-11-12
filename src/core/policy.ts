import type { ResolvedConfig } from './config.js';
import { hostMatches, normalizeHost } from './remote.js';

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
  /** Proxy de Chrome (--proxy-server), null = connexion directe. Une session peut le surcharger (rapportée à part). */
  proxyServer: string | null;
  /** --proxy-bypass-list (sans effet sans proxy). */
  proxyBypassList: readonly string[];
  /** --host-resolver-rules : l'allowlist porte sur le NOM demandé, jamais sur l'adresse cible. */
  hostResolverRules: readonly string[];
  /** Hôtes dont le certificat TLS n'est PAS vérifié (vide par défaut ; dérogation limitée à ces hôtes). */
  ignoreCertErrorsFor: readonly string[];
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
    proxyServer: cfg.proxyServer,
    proxyBypassList: Object.freeze([...cfg.proxyBypassList]),
    hostResolverRules: Object.freeze([...cfg.hostResolverRules]),
    ignoreCertErrorsFor: Object.freeze(cfg.ignoreCertErrorsFor.map(normalizeHost)),
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
