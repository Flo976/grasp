/**
 * Relevé d'une page pour la recette multi-pages (`grasp audit`, `grasp diff`) : statut HTTP du document, liens
 * internes, entrées d'un sitemap XML ; et vérification des liens internes. Code FIXE de Grasp, évalué dans le
 * monde isolé `grasp-lecture` (autorisé avec allowEval=false, invisible pour la page) ; les données de l'appelant
 * n'y entrent que sérialisées en JSON.
 */

import { checkUrl } from '../core/policy.js';
import type { Inventory, LinkCheck } from '../core/multipage.js';

export type { Inventory, LinkCheck };

/** Liens internes rendus au plus (au-delà : comptés, pas listés). */
export const INVENTORY_MAX_LINKS = 1000;
/** Entrées d'un sitemap rendues au plus (le protocole en permet 50 000 par fichier). */
export const INVENTORY_MAX_LOCS = 5000;
/** Liens vérifiés par appel, et délai par lien. */
export const CHECK_LINKS_MAX = 50;
export const CHECK_LINK_TIMEOUT_MS = 10_000;

/** Relevé du document courant (XML : `<loc>` ; HTML : `a[href]`, `area[href]`). */
export const INVENTORY_FN = `(() => {
  const MAXL = ${INVENTORY_MAX_LINKS}, MAXS = ${INVENTORY_MAX_LOCS};
  const nav = performance.getEntriesByType('navigation')[0];
  const st = nav && typeof nav.responseStatus === 'number' && nav.responseStatus > 0 ? nav.responseStatus : null;
  const ct = String(document.contentType || '');
  const xml = /[/+]xml$/.test(ct);
  const byName = (n) => document.getElementsByTagNameNS('*', n);
  let kind = 'page';
  const locs = [];
  let locsOmitted = 0;
  if (xml && (byName('urlset').length > 0 || byName('sitemapindex').length > 0)) {
    kind = byName('sitemapindex').length > 0 ? 'sitemapindex' : 'sitemap';
    for (const l of byName('loc')) {
      const v = String(l.textContent || '').trim();
      if (v === '') continue;
      if (locs.length < MAXS) locs.push(v); else locsOmitted++;
    }
  }
  const links = [];
  const seen = new Set();
  let linksOmitted = 0;
  if (kind === 'page') {
    for (const a of document.querySelectorAll('a[href], area[href]')) {
      let u;
      try { u = new URL(a.getAttribute('href'), document.baseURI); } catch { continue; }
      if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.origin !== location.origin) continue;
      u.hash = '';
      const h = u.href;
      if (seen.has(h)) continue;
      seen.add(h);
      if (links.length < MAXL) links.push(h); else linksOmitted++;
    }
  }
  return { url: location.href, status: st, contentType: ct, kind, links, linksOmitted, locs, locsOmitted };
})()`;

/**
 * Vérifie des URL de MÊME ORIGINE que la page : `fetch` HEAD (GET si 405/501, corps abandonné), redirections non
 * suivies, cookies de l'origine, délai par lien, 6 requêtes en parallèle au plus. Rien n'est lu des réponses.
 */
export function checkLinksFn(urls: string[]): string {
  return `(async (urls) => {
  const one = async (u) => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), ${CHECK_LINK_TIMEOUT_MS});
    const o = { redirect: 'manual', credentials: 'same-origin', cache: 'no-store', signal: ac.signal };
    try {
      let r = await fetch(u, { ...o, method: 'HEAD' });
      if (r.status === 405 || r.status === 501) {
        r = await fetch(u, { ...o, method: 'GET' });
        try { await r.body?.cancel(); } catch {}
      }
      return r.type === 'opaqueredirect' ? { url: u, redirect: true } : { url: u, status: r.status };
    } catch (e) {
      return { url: u, error: ac.signal.aborted ? 'délai dépassé (${CHECK_LINK_TIMEOUT_MS / 1000} s)' : String((e && e.message) || e) };
    } finally { clearTimeout(t); }
  };
  const out = new Array(urls.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(6, urls.length) }, async () => {
    while (i < urls.length) { const k = i++; out[k] = await one(urls[k]); }
  }));
  return out;
})(${JSON.stringify(urls)})`;
}

/**
 * Tri avant vérification : seules les URL http(s) de la MÊME ORIGINE que la page courante et permises par
 * l'allowlist partent ; les autres sont rendues `skipped`, sans requête.
 */
export function splitLinks(allowed: readonly string[], pageUrl: string, urls: readonly string[]): { check: string[]; skipped: LinkCheck[] } {
  let origin: string | undefined;
  try { origin = new URL(pageUrl).origin; } catch { origin = undefined; }
  const check: string[] = [];
  const skipped: LinkCheck[] = [];
  for (const raw of urls) {
    let u: URL;
    try { u = new URL(raw); } catch { skipped.push({ url: raw, skipped: 'URL invalide' }); continue; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') skipped.push({ url: raw, skipped: 'protocole non vérifié' });
    else if (origin === undefined || origin === 'null' || u.origin !== origin) skipped.push({ url: raw, skipped: `autre origine que la page (${origin ?? 'aucune'})` });
    else if (!checkUrl(allowed, u.href).allowed) skipped.push({ url: raw, skipped: 'hors allowlist' });
    else { u.hash = ''; check.push(u.href); }
  }
  return { check, skipped };
}
