import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Pages du site de test pour l'historique (back, forward, reload) et le défilement (scroll), branchées par
 * `historiqueRoute` dans testsite.ts. Aucun site externe.
 */

const simple = (title: string, body: string) => `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

/**
 * Application monopage : chaque lien fait un pushState puis charge sa vue en fetch (150 ms côté serveur) ;
 * popstate (back/forward) recharge la vue de l'URL courante de la même façon. Le rendu arrive donc APRÈS la
 * route : une lecture sans attente verrait l'ancienne vue.
 */
const HIST_SPA_PAGE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Vue accueil</title></head><body>
<nav><a href="/hist-spa" data-v="accueil">Accueil</a> <a href="/hist-spa/produits" data-v="produits">Produits</a> <a href="/hist-spa/contact" data-v="contact">Contact</a></nav>
<main id="vue"><h1>Vue accueil</h1></main>
<script>
const vueDe = (p) => p.split('/')[2] || 'accueil';
async function rendre(v) {
  const r = await fetch('/api/vue?v=' + v);
  const t = await r.text();
  document.getElementById('vue').innerHTML = '<h1>Vue ' + t + '</h1>';
  document.title = 'Vue ' + t;
}
document.querySelector('nav').addEventListener('click', (e) => {
  const a = e.target.closest('a'); if (!a) return;
  e.preventDefault();
  history.pushState({}, '', a.getAttribute('href'));
  rendre(a.dataset.v);
});
addEventListener('popstate', () => rendre(vueDe(location.pathname)));
const v0 = vueDe(location.pathname); if (v0 !== 'accueil') rendre(v0);
</script></body></html>`;

/**
 * Liste à défilement infini : 20 articles par page, une sentinelle observée (IntersectionObserver) ; quand elle
 * entre dans la vue, la page suivante arrive en fetch (100 ms côté serveur). Après `pages` pages : « Fin de la
 * liste ». `?conteneur=1` : la liste défile dans une zone de 300 px (overflow: auto) au lieu de la page.
 */
const INFINI_PAGE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Défilement infini</title>
<style>li{height:40px} #zone.c{height:300px;overflow:auto;border:1px solid #888} #sentinelle{height:10px}</style></head><body>
<h1>Articles</h1>
<div id="zone"><ul id="liste" aria-label="Articles"></ul><div id="sentinelle"></div><p id="etat">chargement…</p></div>
<script>
const q = new URLSearchParams(location.search);
const total = Number(q.get('pages') || 3);
const zone = document.getElementById('zone');
if (q.get('conteneur') === '1') zone.className = 'c';
let page = 0, enCours = false;
async function suite() {
  if (enCours || page >= total) return;
  enCours = true;
  const r = await fetch('/api/articles?page=' + page);
  const noms = await r.json();
  const ul = document.getElementById('liste');
  for (const n of noms) { const li = document.createElement('li'); li.textContent = n; ul.append(li); }
  page++;
  enCours = false;
  document.getElementById('etat').textContent = page >= total ? 'Fin de la liste' : 'page ' + page;
  // Sentinelle encore visible (écran haut) : la suite, comme le ferait une vraie liste.
  const s = document.getElementById('sentinelle').getBoundingClientRect();
  const root = zone.className === 'c' ? zone.getBoundingClientRect() : { bottom: innerHeight };
  if (s.top < root.bottom) suite();
}
new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) suite(); }, { root: zone.className === 'c' ? zone : null }).observe(document.getElementById('sentinelle'));
</script></body></html>`;

let reloads = 0;

/** Routes de l'historique et du défilement ; false si l'URL n'en est pas une. */
export function historiqueRoute(u: URL, req: IncomingMessage, res: ServerResponse): boolean {
  const p = u.pathname;
  if (p === '/hist-a') { res.end(simple('Page A', '<h1>Page A</h1><a href="/hist-b">Vers B</a>')); return true; }
  if (p === '/hist-b') { res.end(simple('Page B', '<h1>Page B</h1><a href="/hist-c">Vers C</a>')); return true; }
  if (p === '/hist-c') { res.end(simple('Page C', '<h1>Page C</h1>')); return true; }
  if (p === '/hist-spa' || p.startsWith('/hist-spa/')) { res.end(HIST_SPA_PAGE); return true; }
  if (p === '/api/vue') {
    const v = u.searchParams.get('v') ?? '';
    setTimeout(() => { res.setHeader('content-type', 'text/plain; charset=utf-8'); res.end(v); }, 150);
    return true;
  }
  if (p === '/recharge') {
    // Compteur côté serveur : un rechargement se voit dans le contenu. Cache autorisé : seul --hard l'évite.
    reloads++;
    const cc = String(req.headers['cache-control'] ?? '');
    res.setHeader('cache-control', 'max-age=3600');
    res.end(simple('Rechargement', `<h1>Chargement n° ${reloads}</h1><p id="cache">cache : ${/no-cache/.test(cc) ? 'ignoré' : 'normal'}</p>`));
    return true;
  }
  if (p === '/defilement-infini') { res.end(INFINI_PAGE); return true; }
  if (p === '/api/articles') {
    const n = Number(u.searchParams.get('page') ?? '0');
    setTimeout(() => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(Array.from({ length: 20 }, (_, i) => `Article ${n * 20 + i + 1}`)));
    }, 100);
    return true;
  }
  return false;
}
