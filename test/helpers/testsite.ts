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

/** Texte long (≈ 15 000 caractères), une zone ciblable (#zone), et un bouton qui ajoute 300 nœuds (diff volumineux). */
export const LONG_PAGE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Long</title></head><body>
<h1>Page longue</h1>
<button id="ajout300" onclick="const m = document.getElementById('ajouts'); for (let i = 0; i < 300; i++) { const b = document.createElement('button'); b.textContent = 'Article ajouté ' + i; m.append(b); }">Ajouter 300</button>
<div id="ajouts"></div>
${Array.from({ length: 200 }, (_, i) => `<p>Paragraphe n° ${i} : du texte de remplissage pour dépasser la limite.</p>`).join('\n')}
<section id="zone" aria-label="Zone"><h2>Zone ciblée</h2><p>Texte de la zone</p><button>Dans la zone</button></section>
</body></html>`;

/** Application rendue APRÈS le load, par étapes de 150 ms : titre vide et page vide au load. */
export const SPA_PAGE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title></title></head><body><div id="app"></div>
<script>
addEventListener('load', () => {
  const app = document.getElementById('app');
  const steps = [
    () => { app.innerHTML = '<p>Chargement…</p>'; },
    () => { document.title = 'Application'; },
    () => { app.innerHTML = '<nav><a href="/">Accueil</a></nav>'; },
    () => { app.insertAdjacentHTML('beforeend', '<main><h1>Contenu chargé</h1><button>Commander</button></main>'); },
  ];
  steps.forEach((f, i) => setTimeout(f, 150 * (i + 1)));
});
</script></body></html>`;

/** DOM qui ne se stabilise jamais (compteur toutes les 80 ms). */
export const AGITE_PAGE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Agitée</title></head><body><h1>Agitée</h1><p id="n">0</p>
<script>let i = 0; setInterval(() => { document.getElementById('n').textContent = String(++i); }, 80);</script></body></html>`;

/** Contenu tardif (wait) et transition en plusieurs étapes (--snap-diff après stabilité). */
export const TARDIF_PAGE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Tardif</title></head><body><h1>Tardif</h1>
<button id="charger" onclick="setTimeout(() => { const p = document.createElement('p'); p.id = 'resultat'; p.textContent = 'Résultat prêt'; document.body.append(p); }, 700)">Charger</button>
<button id="transition" onclick="transition()">Transition</button>
<button id="route" onclick="history.pushState({}, '', '/tardif?vue=1'); setTimeout(() => { document.getElementById('zone').innerHTML = '<h2>Vue routée</h2>'; }, 200)">Route</button>
<div id="zone"><ul><li>Ancien A</li><li>Ancien B</li></ul></div>
<p id="cache" hidden>Caché</p>
<script>
function transition() {
  const z = document.getElementById('zone');
  z.innerHTML = '<p>Chargement…</p>';
  setTimeout(() => { z.innerHTML = '<h2>Étape 1</h2>'; }, 150);
  setTimeout(() => { z.insertAdjacentHTML('beforeend', '<button onclick="document.title = \\'Confirmé\\'">Confirmer la réservation</button>'); }, 300);
  setTimeout(() => { z.querySelector('h2').textContent = 'Résultat final'; }, 450);
}
</script></body></html>`;

/** Refs résilientes : homonymes supprimables, nom qui change, re-rendu complet de la liste. */
export function refsPage(n: number): string {
  const items = ['Alpha', 'Beta', 'Gamma'].slice(0, n).map((x) => `<li>${x} <button onclick="supprimer(this, '${x}')">Supprimer</button></li>`).join('');
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Refs</title></head><body><h1>Refs</h1>
<ul id="liste">${items}</ul>
<button id="panier" onclick="this.textContent = 'Panier (' + (++nb) + ')'">Panier (1)</button>
<button id="rerendre" onclick="const l = document.getElementById('liste'); l.innerHTML = l.innerHTML">Re-rendre</button>
<p id="log">aucun</p>
<script>let nb = 1; function supprimer(b, x) { b.closest('li').remove(); document.getElementById('log').textContent = 'supprimé : ' + x; }</script>
</body></html>`;
}

/** Page plus large que le viewport (3000 px) : rouge sur 0-1500 px, vert au-delà (capture --full en largeur). */
export const LARGE_PAGE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Large</title>
<style>html,body{margin:0;background:#fff} #bande{width:3000px;height:300px;background:linear-gradient(to right,rgb(255,0,0) 0,rgb(255,0,0) 1500px,rgb(0,160,0) 1500px)}</style></head>
<body><div id="bande"></div></body></html>`;

/**
 * Éléments plus hauts que le viewport, loin dans le document : #grand (3000 px, rouge) à y=20000,
 * #enorme (17000 px, haut jaune) à y=23500, au-delà de la limite de texture de Chrome.
 */
export const HAUTE_PAGE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Haute</title>
<style>html,body{margin:0;background:#fff} #avant{height:20000px;background:rgb(0,0,255)} #grand{height:3000px;background:rgb(255,0,0)}
#apres{height:500px;background:rgb(0,160,0)} #enorme{height:17000px;background:linear-gradient(rgb(255,255,0) 0,rgb(255,255,0) 100px,rgb(0,0,255) 100px)}</style></head>
<body><div id="avant"></div><div id="grand"></div><div id="apres"></div><div id="enorme"></div></body></html>`;

/** Iframes dont l'URL porte des secrets (même origine, et localhost hors processus) qui loguent. */
export const CADRES_SECRETS_PAGE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Cadres secrets</title></head><body>
<iframe src="/console-frame?token=SECRET_MEME&amp;code=CODE_OAUTH" title="même origine"></iframe>
<iframe id="xo" title="autre origine"></iframe>
<script>document.getElementById('xo').src = 'http://localhost:' + location.port + '/console-frame?session=SECRET_XO';</script>
</body></html>`;

/** CSP qui bloque une image dont l'URL porte un jeton : Chrome recopie l'URL dans le message du domaine Log. */
export const CSP_PAGE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="img-src 'none'"><title>CSP</title></head>
<body><img src="/pix.png?token=SECRET_CSP&amp;w=2" alt="pixel"></body></html>`;

/** Une action qui produit 250 erreurs distinctes (au-delà des 200 jointes à une action --console). */
export const BAVARD_PAGE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Bavard</title></head>
<body><button id="flot" onclick="for (let i = 0; i < 250; i++) console.error('erreur n°' + i)">Flot</button></body></html>`;

/** Élagage : trois liens sans nom, deux iframes (contenu jamais parcouru par le snapshot). */
export const ELAGUE_PAGE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Élagage</title>
<style>a.vide{display:inline-block;width:12px;height:12px;background:#ccc;margin:4px}</style></head><body>
<h1>Élagage</h1>
<a href="/">Accueil</a>
<a class="vide" href="/a"></a><a class="vide" href="/b"></a><a class="vide" href="/c"><span></span></a>
<iframe src="/console-frame" title="cadre"></iframe>
<iframe srcdoc="<p>contenu interne</p>"></iframe>
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
    if (u.pathname === '/long') { res.end(LONG_PAGE); return; }
    if (u.pathname === '/spa') { res.end(SPA_PAGE); return; }
    if (u.pathname === '/agite') { res.end(AGITE_PAGE); return; }
    if (u.pathname === '/tardif') { res.end(TARDIF_PAGE); return; }
    if (u.pathname === '/refs') { res.end(refsPage(Number(u.searchParams.get('n') ?? '3'))); return; }
    if (u.pathname === '/elague') { res.end(ELAGUE_PAGE); return; }
    if (u.pathname === '/large') { res.end(LARGE_PAGE); return; }
    if (u.pathname === '/haute') { res.end(HAUTE_PAGE); return; }
    if (u.pathname === '/cadres-secrets') { res.end(CADRES_SECRETS_PAGE); return; }
    if (u.pathname === '/csp') { res.end(CSP_PAGE); return; }
    if (u.pathname === '/bavard') { res.end(BAVARD_PAGE); return; }
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
