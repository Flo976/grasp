import type { ResolvedConfig } from './config.js';

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
    navigation: 'enforce' as const,
    tokenRequired: true as const,
  });
}

function normalizeHost(h: string): string {
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
