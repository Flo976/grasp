import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export const FORM_PAGE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Inscription</title></head>
<body>
<header><nav><a href="/">Accueil</a> <a href="/aide">Aide</a></nav></header>
<main>
<h1>Inscription</h1>
<form action="/submit" method="get">
  <div><label for="nom">Nom</label> <input id="nom" name="nom" required></div>
  <div><label for="email">Email</label> <input id="email" name="email" type="email"></div>
  <div><label for="ville">Ville</label> <input id="ville" name="ville"></div>
  <div><label for="pays">Pays</label>
    <select id="pays" name="pays"><option value="">--</option><option value="fr">France</option><option value="mg">Madagascar</option></select></div>
  <div><label><input type="checkbox" id="cgu" name="cgu" value="oui"> J'accepte les conditions</label></div>
  <button type="submit">Valider</button>
</form>
<p id="status">En attente</p>
<button type="button" id="ajout" onclick="const b=document.createElement('button');b.textContent='Nouveau';document.querySelector('main').prepend(b)">Ajouter en haut</button>
</main>
</body></html>`;

function resultPage(q: URLSearchParams): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Merci</title></head><body>
<h1>Inscription reçue</h1>
<ul>
<li id="r-nom">Nom : ${esc(q.get('nom') ?? '')}</li>
<li id="r-email">Email : ${esc(q.get('email') ?? '')}</li>
<li id="r-ville">Ville : ${esc(q.get('ville') ?? '')}</li>
<li id="r-pays">Pays : ${esc(q.get('pays') ?? '')}</li>
<li id="r-cgu">CGU : ${esc(q.get('cgu') ?? 'non')}</li>
</ul></body></html>`;
}

export interface TestSite { url: string; server: Server; hits: string[]; close(): Promise<void> }

/** Petit site local servant la page de test. Aucun site externe dans la suite. */
export async function startTestSite(): Promise<TestSite> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    hits.push(u.pathname);
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (u.pathname === '/submit') { res.end(resultPage(u.searchParams)); return; }
    if (u.pathname === '/redirect-out') { res.statusCode = 302; res.setHeader('location', 'http://example.com/'); res.end(); return; }
    if (u.pathname === '/link-out') { res.end('<!doctype html><title>Liens</title><a href="http://example.com/">Externe</a>'); return; }
    if (u.pathname === '/big') {
      const items = Array.from({ length: 2000 }, (_, i) => `<li><a href="/p${i}">Produit numéro ${i}</a></li>`).join('');
      res.end(`<!doctype html><title>Gros</title><ul>${items}</ul>`); return;
    }
    res.end(FORM_PAGE);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    server,
    hits,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}
