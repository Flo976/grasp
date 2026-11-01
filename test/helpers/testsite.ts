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

/** Page haute (3100 px) à zones colorées : capture du viewport, page entière, découpe d'élément. */
export const CAPTURE_PAGE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Capture</title>
<style>html,body{margin:0;background:#fff} #haut{height:300px;background:rgb(0,0,255)} #espace{height:1200px}
#cible{width:200px;height:100px;background:rgb(255,0,0);margin-left:50px} #bas{height:1400px} #pied{height:100px;background:rgb(0,160,0)}
button,a{font-size:20px;margin:40px}</style></head>
<body><div id="haut"><button id="b1">Premier</button> <a href="/" style="color:#fff">Lien</a></div><div id="espace"></div>
<div id="cible" role="img" aria-label="Cible"></div><div id="bas"></div><div id="pied"></div></body></html>`;

/**
 * Console : tous les niveaux, objet, exception non rattrapée, promesse rejetée, image 404,
 * fetch vers un hôte hors allowlist (localhost quand seul 127.0.0.1 est autorisé), iframe qui logue.
 */
export const CONSOLE_PAGE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Console</title></head><body>
<h1>Console</h1>
<img src="/absent.png" alt="image absente">
<iframe src="/console-frame" title="cadre"></iframe>
<button id="log" onclick="console.log('clic', 42)">Loguer</button>
<button id="spam" onclick="for (let i = 0; i < 5; i++) console.warn('répété')">Répéter</button>
<button id="boom" onclick="setTimeout(() => { throw new Error('boum au clic'); })">Exception</button>
<button id="secret" onclick="fetch('/api/secret?token=abc123&amp;page=2', { method: 'POST', headers: { Authorization: 'Bearer SECRET-AUTH' }, body: 'corps-secret' })">Secret</button>
<button id="cadre-navigant" onclick="const f = document.createElement('iframe'); f.src = 'http://localhost:' + location.port + '/frame-nav'; document.body.append(f)">Cadre navigant</button>
<button id="cadre-bloque" onclick="const f = document.createElement('iframe'); f.src = 'http://localhost:' + location.port + '/console-frame'; document.body.append(f)">Cadre bloqué</button>
<script>
console.debug('niveau debug');
console.info('niveau info');
console.log('niveau log %s n°%d', 'formaté', 7);
console.warn('niveau warn');
console.error('erreur objet', { code: 42, detail: 'champ manquant', nested: { a: [1, 2, 3] } });
fetch('http://localhost:' + location.port + '/api/data').catch(() => {});
Promise.reject(new Error('promesse rejetée'));
</script>
<script>function lancer() { throw new Error('exception non rattrapée'); } lancer();</script>
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
    if (u.pathname === '/capture') { res.end(CAPTURE_PAGE); return; }
    if (u.pathname === '/console') { res.end(CONSOLE_PAGE); return; }
    if (u.pathname === '/console-frame') { res.end('<!doctype html><title>Cadre</title><p>cadre</p><script>console.log("depuis le cadre")</script>'); return; }
    // Cadre qui navigue lui-même vers [::1] (hors allowlist) : la garde doit s'appliquer DANS l'iframe.
    if (u.pathname === '/frame-nav') { res.end('<!doctype html><title>Navigant</title><script>setTimeout(() => { location.href = "http://[::1]:" + location.port + "/"; }, 50)</script>'); return; }
    if (u.pathname === '/absent.png') { res.statusCode = 404; res.end('introuvable'); return; }
    if (u.pathname === '/api/data') { res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); return; }
    if (u.pathname === '/api/secret') { res.statusCode = 401; res.setHeader('content-type', 'application/json'); res.end('{"error":"corps-réponse-secret"}'); return; }
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
