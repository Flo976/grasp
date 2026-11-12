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
/**
 * DOM qui ne se stabilise jamais, et pas seulement par une animation de faible ampleur (celle-ci est ignorée,
 * voir /carrousel) : toutes les 80 ms, un compteur change ET 5 nouveaux éléments sont ajoutés.
 */
export const AGITE_PAGE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Agitée</title></head><body><h1>Agitée</h1><p id="n">0</p><div id="flux"></div>
<script>let i = 0; setInterval(() => {
  document.getElementById('n').textContent = String(++i);
  const f = document.getElementById('flux');
  for (let k = 0; k < 5; k++) { const s = document.createElement('span'); s.textContent = 'x'; f.append(s); }
  while (f.childElementCount > 200) f.firstElementChild.remove();
}, 80);</script></body></html>`;

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

/**
 * Livraison des entrées : chaque événement reçu par la page (en capture, monde principal) est noté dans
 * window.__ev (« type:isTrusted »). « Compter » change le texte, « Inerte » ne fait rien, « Muet » ne
 * modifie qu'un nœud masqué (mutation du DOM sans changement de l'arbre d'accessibilité).
 */
export const SONDE_PAGE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Sonde</title></head><body>
<h1>Sonde</h1>
<button id="compter" onclick="document.getElementById('compte').textContent = 'Compte : ' + (++n)">Compter</button>
<button id="inerte">Inerte</button>
<button id="muet" onclick="document.getElementById('cache').textContent = String(++m)">Muet</button>
<div id="cache" hidden>0</div>
<p id="compte">Compte : 0</p>
<label><input type="checkbox" id="case"> Case sonde</label>
<form action="/submit" method="get"><label for="q">Recherche</label> <input id="q" name="q" value="lemurien"></form>
<label for="vider">À vider</label> <input id="vider" value="ancien">
<script>let n = 0, m = 0; window.__ev = [];
for (const t of ['pointerdown', 'mousedown', 'mouseup', 'click', 'keydown', 'keyup', 'input']) addEventListener(t, (e) => __ev.push(t + ':' + e.isTrusted), true);</script>
</body></html>`;

/**
 * Élément flottant à droite, plus haut que le viewport, bord gauche noir de 6 px (comme l'infobox de Wikipédia) :
 * la découpe --el ne doit pas rogner son bord gauche quand la capture agrandit le viewport.
 */
export const FLOTTANT_PAGE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Flottant</title>
<style>html,body{margin:0;background:#fff} #info{float:right;width:300px;height:1500px;margin:10.5px 13.3px;background:rgb(255,0,0);border-left:6px solid rgb(0,0,0)}
p{margin:0 0 20px}</style></head>
<body><div id="petit" style="position:absolute;left:20.6px;top:30.4px;width:100.5px;height:40px;border-left:2px solid rgb(0,0,0);background:rgb(255,0,0)"></div><div id="info" role="img" aria-label="Infobox"></div>${Array.from({ length: 60 }, (_, i) => `<p>Paragraphe ${i} du texte qui coule autour de la boîte flottante.</p>`).join('')}</body></html>`;

/** Iframes : même origine (lisible), et autre origine (localhost) dont le contenu n'est pas lisible depuis la page. */
export const CADRES_PAGE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Cadres</title></head><body>
<h1>Cadres</h1>
<iframe id="meme" src="/cadre-texte" title="Cadre même origine"></iframe>
<iframe id="autre" title="Cadre autre origine"></iframe>
<div id="vide"></div>
<script>document.getElementById('autre').src = 'http://localhost:' + location.port + '/cadre-texte';</script>
</body></html>`;

/**
 * Moteur Playwright : iframe d'une AUTRE origine (localhost, hors processus) façon TinyMCE / CAPTCHA, lien
 * hors allowlist ([::1]), bouton qui n'apparaît qu'après 600 ms, survol, champ fichier, téléchargement.
 */
export const PW_CADRES_PAGE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Cadres Playwright</title></head><body>
<h1>Cadres Playwright</h1>
<iframe id="editeur" title="Éditeur riche" style="width:700px;height:420px"></iframe>
<p><a id="sortir">Sortir</a></p>
<button id="reveler" onclick="setTimeout(() => { document.getElementById('tardif').hidden = false; }, 600)">Révéler</button>
<button id="tardif" hidden onclick="document.getElementById('compte').textContent = 'Compte : ' + (++n)">Tardif</button>
<p id="compte">Compte : 0</p>
<button id="bas" onclick="document.getElementById('compte').textContent = 'Compte : ' + (++n)">Compter en bas</button>
<div id="survol" onmouseover="this.textContent = 'Survolé'" style="padding:10px">Zone à survoler</div>
<label for="ville">Ville</label> <input id="ville">
<button id="dl" onclick="const a = document.createElement('a'); a.href = window.URL.createObjectURL(new Blob(['contenu grasp'])); a.download = 'grasp-dl.txt'; document.body.append(a); a.click();">Télécharger</button>
<script>let n = 0;
// Espion : clics reçus par le document de l'iframe (autre origine), rapportés par postMessage.
window.__cadre = []; addEventListener('message', (e) => { if (typeof e.data === 'string' && e.data.startsWith('cadre:')) __cadre.push(e.data); });
document.getElementById('editeur').src = 'http://localhost:' + location.port + '/pw-editeur';
document.getElementById('sortir').href = 'http://[::1]:' + location.port + '/';</script>
</body></html>`;

export const PW_EDITEUR_PAGE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Éditeur</title></head><body>
<div id="zone" contenteditable="true" role="textbox" aria-label="Zone d'édition"><p>Texte initial</p></div>
<label for="titre">Titre</label> <input id="titre">
<label for="taille">Taille</label> <select id="taille"><option value="p">Petit</option><option value="g">Grand</option></select>
<label><input type="checkbox" id="gras"> Gras</label>
<button id="appliquer" onclick="document.getElementById('etat').textContent = 'Appliqué : ' + document.getElementById('titre').value">Appliquer</button>
<p id="etat">Rien</p>
<input type="file" id="piece" aria-label="Pièce jointe">
<p id="fichier">Aucun fichier</p>
<script>for (const t of ['mousedown', 'click']) addEventListener(t, (e) => parent.postMessage('cadre:' + t + ' ' + e.target.nodeName, '*'), true);
document.getElementById('piece').onchange = (e) => { document.getElementById('fichier').textContent = 'Fichier : ' + e.target.files[0].name; };</script>
</body></html>`;

/** Texte suivi d'un lien dans le même paragraphe : le centre du paragraphe tombe sur le lien, pas sur le texte. */
export const PW_TEXTE_PAGE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Texte et lien</title></head><body style="margin:0">
<p id="p" style="width:max-content;white-space:nowrap;font:16px monospace;margin:0">Voir : <a href="#" id="annuler" onclick="window.cible = 'LIEN'; return false">annuler la commande tout de suite</a></p>
<script>window.cible = 'aucune';
document.getElementById('p').addEventListener('click', (e) => { if (e.target.id !== 'annuler') window.cible = 'P:' + e.target.nodeName; });</script>
</body></html>`;

/** Boîte de dialogue à la demande (onglet de l'utilisateur, mode attach). */
export const DIALOGUE_PAGE = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Dialogue</title></head><body><p>Onglet de l'utilisateur</p>
<button id="demander" onclick="document.getElementById('rep').textContent = 'Réponse : ' + confirm('Supprimer ?')">Demander</button><p id="rep">Réponse : -</p></body></html>`;

/**
 * Erreurs de formulaire, toutes les variantes de balisage, dans un tiroir sans <form> ni bouton submit
 * (comme Malt). « Enregistrer » valide et n'enregistre rien tant qu'un champ est invalide.
 * - Code postal : message relié par aria-describedby (avec un texte d'aide) + aria-invalid ;
 * - Téléphone : message relié par aria-errormessage + aria-invalid ;
 * - Nom : aria-invalid, message NON relié, juste sous le champ ;
 * - Email : validité native (:user-invalid, validationMessage) ;
 * - Intitulé du poste : balisage Malt relevé tel quel (Vue « joy ») : champ sans aucun aria-*, seulement
 *   la classe joy-input--field-invalid ; message dans un div role="alert" mais aria-hidden="true" (donc
 *   absent de l'arbre d'accessibilité), affiché dès la saisie ;
 * - bandeau role="alert" global rempli à la validation.
 * - toast d'erreur aria-hidden hors du tiroir, rattaché à aucun champ.
 */
export const ERREURS_PAGE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Erreurs</title>
<style>[hidden]{display:none} .joy-form-error{display:none;color:#c00} .joy-form-error.joy-has-error{display:flex}</style></head>
<body>
<h1>Profil</h1>
<div id="toast" class="toast toast-error" aria-hidden="true" hidden></div>
<p>Bio publique</p>
<div role="dialog" aria-modal="true" aria-labelledby="titre" id="tiroir">
  <h2 id="titre">Modifier l'introduction</h2>
  <div><label for="cp">Code postal</label><input id="cp" aria-describedby="cp-aide cp-err"><div id="cp-aide">Format : 5 chiffres</div><div id="cp-err" hidden></div></div>
  <div><label for="tel">Téléphone</label><input id="tel" aria-errormessage="tel-err"><div id="tel-err" hidden></div></div>
  <div class="champ"><label for="nom">Nom</label><input id="nom"><div class="msg-erreur" id="nom-err" hidden></div></div>
  <div><label for="mail">Email</label><input id="mail" type="email"></div>
  <div data-testid="edit-header-headline"><div class="joy-input--medium"><div class="joy-input">
    <div class="joy-label__group" for="headline"><div class="joy-label__group___main"><label data-joy-form-label="" class="joy-label joy-label--medium" for="headline">Intitulé du poste<!----><!----></label></div></div>
    <div class="joy-input--wrapper"><input minlength="5" maxlength="50" data-testid="profile-edition-section-headline-input" id="headline" data-joy-form-field="" name="headline" class="" type="text" value="Développeur PHP"></div></div></div>
    <div data-joy-form-error="" aria-hidden="true" class="joy-form-error joy-mt-2" role="alert" data-testid="profile-edition-section-headline-error"><span class="joy-icon joy-icon--secondary joy-icon--xsmall joy-icon-error"><i class="icon icon-warning-triangle" aria-hidden="true"></i></span><div><ul><li id="headline-msg"></li></ul></div></div>
  </div>
  <div id="bandeau" role="alert"></div>
  <button type="button" id="annuler">Annuler</button>
  <button type="button" id="enregistrer">Enregistrer</button>
</div>
<script>
const $ = (id) => document.getElementById(id);
const headline = $('headline');
// Malt : maxlength posé, mais la valeur peut le dépasser (collage, saisie programmatique) ; message à chaque saisie.
headline.addEventListener('input', () => {
  const trop = headline.value.length > 50;
  headline.className = trop ? 'joy-input--field-invalid' : '';
  headline.closest('.joy-input').classList.toggle('joy-input--invalid', trop);
  document.querySelector('.joy-form-error').classList.toggle('joy-has-error', trop);
  $('headline-msg').textContent = trop ? 'Doit compter au maximum 50 caractères' : '';
});
function marquer(champ, msgEl, msg) {
  if (msg) { champ.setAttribute('aria-invalid', 'true'); msgEl.textContent = msg; msgEl.hidden = false; }
  else { champ.removeAttribute('aria-invalid'); msgEl.textContent = ''; msgEl.hidden = true; }
  return msg ? 1 : 0;
}
$('enregistrer').addEventListener('click', () => {
  let n = 0;
  n += marquer($('cp'), $('cp-err'), /^\\d{5}$/.test($('cp').value) ? '' : 'Code postal à 5 chiffres');
  n += marquer($('tel'), $('tel-err'), /^0\\d{9}$/.test($('tel').value) ? '' : 'Numéro à 10 chiffres');
  n += marquer($('nom'), $('nom-err'), $('nom').value.trim() ? '' : 'Le nom est obligatoire');
  if (headline.value.length > 50) n++;
  if (!$('mail').checkValidity()) n++;
  const txt = n ? n + ' erreur(s) dans le formulaire' : '';
  if ($('bandeau').textContent !== txt) $('bandeau').textContent = txt;
  $('toast').textContent = n ? 'Enregistrement impossible' : ''; $('toast').hidden = !n;
  if (n === 0) document.querySelector('p').textContent = 'Enregistré';
});
</script>
</body></html>`;

/**
 * Rendu du snapshot (défauts relevés sur le banc multi-sites et l'édition d'un profil Malt) :
 * nœuds texte invisibles (espaces de largeur nulle), libellés répétés, text-transform, croix de
 * suppression de tags sans nom, listes déroulantes (select natif, combobox ARIA à aria-owns),
 * option « Créer … » composée de plusieurs spans.
 */
export const SNAP_V3_PAGE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Snapshot v3</title>
<style>.maj{text-transform:uppercase} .cap{text-transform:capitalize} .chip{display:inline-flex;gap:4px;border:1px solid #888;margin:2px;padding:2px}
.chip button{width:16px;height:16px} .sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}</style></head>
<body>
<h1>Profil</h1>
<p>Avant le vide</p><span>\u200b</span><div>&#8203;</div><span>&#xFEFF;</span><div>\u200b \u200c</div>
<p>Après le vide</p>
<div><label for="heures">Heures</label><label for="heures" class="sr">Heures</label><input id="heures" type="number" value="35"></div>
<div><span id="dispo-l">Disponibilité</span><input id="dispo" aria-labelledby="dispo-l dispo-l"></div>
<h2 class="maj">Mes compétences</h2>
<button class="maj" id="enreg">Enregistrer le profil</button>
<p class="cap">texte libre en minuscules</p>
<ul id="tags" aria-label="Compétences">
  <li class="chip"><span>PHP</span><button type="button" onclick="this.closest('li').remove()"><svg width="10" height="10" aria-hidden="true"><path d="M0 0L10 10"/></svg></button></li>
  <li class="chip"><span>Symfony</span><button type="button" onclick="this.closest('li').remove()"><svg width="10" height="10" aria-hidden="true"><path d="M0 0L10 10"/></svg></button></li>
  <li class="chip"><span>Laravel</span><button type="button" onclick="this.closest('li').remove()"><svg width="10" height="10" aria-hidden="true"><path d="M0 0L10 10"/></svg></button></li>
</ul>
<label for="pays">Pays</label>
<select id="pays">${Array.from({ length: 25 }, (_, i) => `<option value="p${i}"${i === 2 ? ' selected' : ''}>Pays ${i}</option>`).join('')}</select>
<label for="unite">Unité</label>
<select id="unite"><option>Jour</option><option selected>Heure</option></select>
<div>
  <label for="saisie">Ajouter une compétence</label>
  <input id="saisie" role="combobox" aria-expanded="true" aria-autocomplete="list" aria-owns="sugg" aria-controls="sugg" value="Laravel">
  <ul id="sugg" role="listbox" aria-label="Suggestions">
    <li role="option" id="o1"><span>Laravel</span> <span class="hint">10</span></li>
    <li role="option" id="o2" aria-selected="true"><span>Laravel</span> <span>Livewire</span></li>
    <li role="option" id="o3"><span class="ico">+</span> <span>Créer</span> <strong>« Laravel »</strong></li>
  </ul>
</div>
<div role="listbox" aria-label="Villes" id="villes">${Array.from({ length: 30 }, (_, i) => `<div role="option"${i === 3 ? ' aria-selected="true"' : ''}>Ville ${i}</div>`).join('')}</div>
</body></html>`;

/**
 * Validité : radios required d'un groupe vierge, case à cocher required, champ texte required : aucune
 * erreur affichée tant que rien n'est touché ni soumis. Après soumission : :user-invalid.
 */
export const RADIOS_PAGE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Radios</title></head><body>
<form id="f" onsubmit="event.preventDefault(); document.getElementById('etat').textContent = 'Envoyé'">
  <fieldset><legend>Rythme</legend>
    <label><input type="radio" name="rythme" value="j" required> Jour</label>
    <label><input type="radio" name="rythme" value="h"> Heure</label>
  </fieldset>
  <label><input type="checkbox" id="cgu" required> J'accepte</label>
  <label for="ville">Ville</label><input id="ville" required>
  <button id="envoyer">Envoyer</button>
</form>
<p id="etat">Rien</p>
</body></html>`;

/**
 * Fenêtres modales ouvertes à la demande, sous leurs deux formes courantes : `<dialog>` ouvert par
 * showModal() (le reste de la page devient inerte), et div aria-modal dont la bibliothèque pose
 * aria-hidden="true" sur le fond (modales Vue/React). Un bouton « Fermer » existe hors de la modale ET
 * dans la modale (homonymes), plus un bouton « Supprimer » hors de la modale.
 */
export const MODALE_PAGE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Modale</title></head><body>
<div id="fond">
<h1>Liste</h1>
<button id="fermer-page">Fermer</button>
<button id="supprimer" onclick="document.getElementById('etat').textContent = 'Supprimé'">Supprimer</button>
<button id="ouvrir" onclick="document.getElementById('modale').showModal()">Ouvrir</button>
<button id="ouvrir-aria" onclick="document.getElementById('fond').setAttribute('aria-hidden', 'true'); document.getElementById('modale-aria').hidden = false; document.getElementById('fermer-aria').focus()">Ouvrir ARIA</button>
<p id="etat">Rien</p>
</div>
<dialog aria-label="Confirmation" id="modale">
  <p>Confirmer ?</p>
  <button id="fermer-modale" onclick="document.getElementById('modale').close()">Fermer</button>
  <button id="valider" onclick="document.getElementById('etat').textContent = 'Validé'">Valider</button>
</dialog>
<div role="dialog" aria-modal="true" aria-label="Confirmation ARIA" id="modale-aria" hidden>
  <button id="fermer-aria" onclick="document.getElementById('modale-aria').hidden = true; document.getElementById('fond').removeAttribute('aria-hidden')">Fermer</button>
</div>
</body></html>`;

/**
 * Page de challenge anti-bot (Booking, AWS WAF) : vérification par requête réseau, puis la page se remplace
 * elle-même (location.replace) par la vraie page. La vraie page n'existe qu'après la redirection.
 */
export const CHALLENGE_RESEAU_PAGE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Vérification</title></head><body><p>Vérification de votre navigateur…</p>
<script>addEventListener('load', () => { fetch('/api/lent?ms=700').then((r) => r.json()).then(() => location.replace('/challenge-ok')); });</script>
</body></html>`;

/** Challenge façon Cloudflare : rien sur le réseau, minuterie de 1500 ms puis location.replace. */
export const CHALLENGE_MINUTERIE_PAGE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Un instant…</title></head><body>
<div id="challenge-running"><p>Vérification que vous êtes humain</p></div>
<script>setTimeout(() => location.replace('/challenge-ok'), 1500);</script>
</body></html>`;

export const CHALLENGE_OK_PAGE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Hôtels à Paris</title></head><body>
<main><h1>Résultats de recherche</h1><a href="/hotel/1">Hôtel du Lac</a> <button>Réserver</button></main>
</body></html>`;

/**
 * Recherche d'une application monopage (Leboncoin) : Entrée → pushState puis chargement asynchrone (700 ms)
 * des résultats et du titre. #differe : requête lancée 150 ms après le clic (wait --idle). #annonces : lien
 * routé (pushState, même document).
 */
export const SPA_RECHERCHE_PAGE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Recherche</title></head><body>
<main><label for="q">Rechercher</label> <input id="q" type="search">
<button id="differe">Différé</button> <a id="annonces" href="/spa-recherche/annonces">Annonces</a>
<div id="res"></div></main>
<script>
const q = document.getElementById('q');
const res = document.getElementById('res');
q.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  setTimeout(() => {
    history.pushState({}, '', '/spa-recherche?q=' + encodeURIComponent(q.value));
    fetch('/api/lent?ms=700').then((r) => r.json()).then(() => {
      document.title = 'Résultats : ' + q.value;
      res.innerHTML = '<h2>Annonces trouvées</h2><ul><li><a href="/a1">Vélo ' + q.value + '</a></li></ul>';
    });
  }, 30);
});
document.getElementById('differe').addEventListener('click', () => {
  setTimeout(() => fetch('/api/lent?ms=600').then((r) => r.json()).then(() => { res.innerHTML = '<h2>Différé chargé</h2>'; }), 150);
});
document.getElementById('annonces').addEventListener('click', (e) => {
  e.preventDefault();
  history.pushState({}, '', '/spa-recherche/annonces');
  document.title = 'Annonces';
  res.innerHTML = '<h2>Liste des annonces</h2>';
});
</script>
</body></html>`;

/** « Enregistrer » qui poste (700 ms) puis met le DOM à jour ; autocomplétion à suggestions asynchrones. */
export const ENREGISTRER_PAGE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Profil</title></head><body>
<main><h1>Profil</h1>
<label for="nom">Nom</label> <input id="nom" value="Jean"> <button id="save">Enregistrer</button>
<p id="msg"></p>
<label for="ville">Ville</label> <input id="ville" role="combobox" aria-autocomplete="list" aria-controls="sugg">
<ul id="sugg" role="listbox" aria-label="Suggestions"></ul></main>
<script>
const $ = (id) => document.getElementById(id);
$('save').addEventListener('click', () => {
  fetch('/api/lent?ms=700', { method: 'POST', body: $('nom').value }).then((r) => r.json()).then(() => { $('msg').textContent = 'Profil enregistré'; });
});
let t;
$('ville').addEventListener('input', () => {
  clearTimeout(t);
  t = setTimeout(() => fetch('/api/lent?ms=500').then((r) => r.json()).then(() => {
    const v = $('ville').value.toLowerCase();
    $('sugg').innerHTML = ['Paris', 'Parme', 'Lyon'].filter((x) => x.toLowerCase().startsWith(v)).map((x) => '<li role="option">' + x + '</li>').join('');
  }), 250);
});
</script>
</body></html>`;

/** Éditeur riche (contenteditable) dont le contenu commence par un titre puis une liste : formats de bloc. */
export const EDITEUR_RICHE_PAGE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Éditeur riche</title></head><body>
<div id="ed" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Description"><h1>Ancien titre</h1><ul><li>Ancien point</li></ul></div>
</body></html>`;

/** Rendu par requestAnimationFrame (suspendu dans un onglet en arrière-plan). */
export const ARRIERE_PLAN_PAGE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Arrière-plan</title></head><body>
<button id="raf" onclick="requestAnimationFrame(() => { document.getElementById('out').textContent = 'Rendu fait'; })">Rendre</button>
<p id="out">Rien</p>
</body></html>`;

/**
 * Relecture v3. Connexion courte avec reCAPTCHA et « Veuillez patienter » : pas une page de challenge.
 * Long-polling ouvert au chargement. Polling de fond (fetch toutes les 300 ms, sans changement du DOM).
 */
export const CONNEXION_CAPTCHA_PAGE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Connexion</title></head><body>
<form><label for="em">Email</label> <input id="em" type="email"> <label for="mdp">Mot de passe</label> <input id="mdp" type="password">
<iframe src="/recaptcha/api2/anchor" title="reCAPTCHA" width="300" height="80"></iframe>
<button type="button">Se connecter</button></form>
<p class="challenge-hint">Veuillez patienter, vérification en cours…</p>
</body></html>`;

export const LONG_POLL_PAGE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Long-polling</title></head><body>
<h1>Messagerie</h1><button id="b" onclick="fetch('/api/lent?ms=10000'); document.getElementById('etat').textContent = 'Relancé'">Relancer</button><p id="etat">Prêt</p>
<script>addEventListener('load', () => { fetch('/api/lent?ms=10000').catch(() => {}); });</script>
</body></html>`;

export const POLLING_PAGE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Polling</title></head><body>
<h1>Tableau de bord</h1><button id="b" onclick="document.getElementById('etat').textContent = 'Cliqué'">Agir</button><p id="etat">Prêt</p>
<script>setInterval(() => { fetch('/api/data').catch(() => {}); }, 300);</script>
</body></html>`;

/**
 * Banc v4. Cases à cocher sans <label> (the-internet.herokuapp.com/checkboxes) : le texte qui SUIT la case
 * est son libellé naturel ; radios en ligne ; croix de tag sans nom (texte qui précède) pour comparaison.
 */
export const CASES_PAGE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Cases</title></head><body>
<h3>Checkboxes</h3>
<form id="checkboxes"><input type="checkbox"> checkbox 1<br><input type="checkbox" checked> checkbox 2</form>
<p>Livraison : <input type="radio" name="liv"> Domicile <input type="radio" name="liv"> Relais</p>
<span class="tag">Rust <button type="button" class="croix" onclick="this.parentNode.remove()"></button></span>
</body></html>`;

/**
 * Champ de recherche remplacé à la première saisie (Wikipédia : le searchbox devient un combobox Vue) :
 * nouveau nœud, même nom, valeur et focus conservés. `?role=combobox` : le remplaçant change de rôle.
 * Entrée soumet le formulaire (→ « Recherche : <valeur> »).
 */
export const REMPLACE_PAGE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Remplacement</title></head><body>
<form id="f" onsubmit="event.preventDefault(); document.getElementById('etat').textContent = 'Recherche : ' + document.getElementById('q').value">
<input id="q" type="search" aria-label="Rechercher" autocomplete="off"></form>
<p id="etat">Prêt</p>
<script>
const role = new URLSearchParams(location.search).get('role');
document.getElementById('q').addEventListener('input', function once() {
  const old = this;
  old.removeEventListener('input', once);
  setTimeout(() => {
    const n = document.createElement('input');
    n.id = 'q'; n.type = 'search'; n.setAttribute('aria-label', 'Rechercher'); n.autocomplete = 'off';
    if (role) { n.setAttribute('role', role); n.setAttribute('aria-expanded', 'false'); }
    n.value = old.value;
    old.replaceWith(n);
    n.focus();
    n.setSelectionRange(n.value.length, n.value.length);
  }, 30);
});
</script>
</body></html>`;

/** Carrousel : un petit nœud modifié toutes les 200 ms, sans fin (Amazon). `?gros=1` : 300 articles ajoutés à 800 ms. */
export const CARROUSEL_PAGE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Carrousel</title></head><body>
<h1>Boutique</h1>
<div id="car"><span id="slide">Diapo 0</span></div>
<ul id="liste"></ul>
<script>
let i = 0;
setInterval(() => { document.getElementById('slide').textContent = 'Diapo ' + (++i % 5); }, 200);
if (new URLSearchParams(location.search).get('gros')) setTimeout(() => {
  document.getElementById('liste').innerHTML = Array.from({ length: 300 }, (_, k) => '<li>Article n°' + k + '</li>').join('');
}, 800);
</script>
</body></html>`;

/** Titres de livres longs (liens) : troncature des noms dans le snapshot. */
export const LIVRES_TITRES = [
  "Le Seigneur des anneaux : La Communauté de l'anneau, édition illustrée intégrale avec cartes et annexes de l'auteur",
  "Histoire de la Grande Île : Madagascar des origines à nos jours, des royaumes merina à l'indépendance de 1960",
  'Court',
];
export const LIVRES_PAGE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Livres</title></head><body>
<h1>Catalogue</h1><ul>${LIVRES_TITRES.map((t, i) => `<li><a href="/livre/${i}">${t}</a></li>`).join('')}</ul>
</body></html>`;

/** Console : 60 history.replaceState (repères « même document ») et 3 erreurs. */
export const CONSOLE_SPA_PAGE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Console SPA</title></head><body>
<h1>SPA</h1>
<script>
for (let k = 0; k < 60; k++) history.replaceState(null, '', '?etape=' + k);
console.error('erreur A'); console.error('erreur B'); console.error('erreur C');
console.info('info 1');
</script>
</body></html>`;

/** Console : 30 erreurs au chargement (à vider avec --clear). */
export const CONSOLE_BRUIT_PAGE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Console bruit</title></head><body>
<script>for (let k = 0; k < 30; k++) console.error('ancienne ' + k);</script>
</body></html>`;

/**
 * Requêtes de fond perpétuelles et non périodiques (mesures d'audience, pubs d'Amazon) : toutes les 100 à 250 ms une
 * requête vers un chemin différent, DOM figé. Avec ?rendu=1, une vraie liste est ajoutée après 3 requêtes
 * enchaînées (rendu qui dépend du réseau : doit être attendu).
 */
export const FOND_RESEAU_PAGE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Fond réseau</title></head><body><h1>Produits</h1><ul id="l"></ul>
<script>
let i = 0;
const beacon = () => { fetch('/fond/b' + (i++) + '-' + Math.floor(Math.random() * 1e6)).catch(() => {}); setTimeout(beacon, 100 + Math.random() * 150); };
beacon();
if (location.search.includes('rendu=1')) {
  fetch('/api/lent?ms=300').then(() => fetch('/api/lent?ms=300')).then(() => fetch('/api/lent?ms=300')).then(() => {
    document.getElementById('l').innerHTML = Array.from({ length: 50 }, (_, k) => '<li>Produit ' + k + '</li>').join('');
  });
}
</script></body></html>`;

/**
 * Traqueurs : la page (servie sur 127.0.0.1) charge un pixel, un script, un fetch et une iframe vers des domaines
 * de la liste de Peter Lowe (doubleclick.net, google-analytics.com et leurs sous-domaines), et une image vers un
 * quasi-homonyme hors liste (xdoubleclick.net). Le test mappe ces hôtes sur 127.0.0.1 (--host-resolver-rules) :
 * une requête non bloquée arrive ici (/trk/…, réponse lente de 1,5 s), une requête bloquée jamais.
 */
export const TRAQUEURS_PAGE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Traqueurs</title>
<script src="http://www.google-analytics.com:PORT/trk/analytics.js" async></script></head><body>
<h1>Article</h1>
<p id="etat">Contenu</p>
<img src="http://ad.doubleclick.net:PORT/trk/pixel.gif" alt="">
<img src="http://xdoubleclick.net:PORT/presque/pixel.gif" alt="">
<iframe src="http://ad.doubleclick.net:PORT/trk/cadre" title="pub"></iframe>
<button id="mesure" onclick="fetch('http://stats.doubleclick.net:' + location.port + '/trk/clic', { mode: 'no-cors' }).catch(() => {})">Mesurer</button>
<script>
fetch('http://doubleclick.net:' + location.port + '/trk/collect', { mode: 'no-cors' }).catch(() => {});
fetch('/api/data').then(() => { document.getElementById('etat').textContent = 'Contenu chargé'; });
</script>
</body></html>`;

/** Connexion : formulaire GET vers /connecte (cookie de session HttpOnly côté serveur). */
export const CONNEXION_PAGE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Connexion</title></head><body>
<h1>Connexion</h1>
<form action="/connecte" method="get"><label for="user">Identifiant</label> <input id="user" name="user"> <button type="submit">Se connecter</button></form>
</body></html>`;

/** Compte : l'état de connexion vient du SERVEUR (cookie sid connu), les préférences du stockage Web. */
const comptePage = (user: string | undefined) => `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Compte</title></head><body>
<h1>${user !== undefined ? `Connecté : ${user}` : 'Non connecté'}</h1>
<p id="theme"></p><p id="brouillon"></p>
<script>
document.getElementById('theme').textContent = 'Thème : ' + (localStorage.getItem('theme') ?? 'aucun');
document.getElementById('brouillon').textContent = 'Brouillon : ' + (sessionStorage.getItem('brouillon') ?? 'aucun');
</script></body></html>`;

/**
 * Recette (expect, rapport de run) : commande validée côté page (quantité entière ≥ 1, sinon champ invalide
 * avec message relié), envoyée en XHR ; quantité 13 → 500 et console.error. Succès : route /boutique/merci
 * (pushState), titre « Merci », « Commande enregistrée n°42 » et un reçu.
 */
export const BOUTIQUE_PAGE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Boutique</title></head><body>
<h1>Boutique</h1>
<form id="f" novalidate>
  <div><label for="qte">Quantité</label> <input id="qte" name="qte" inputmode="numeric" aria-describedby="qte-err"><div id="qte-err" class="erreur" hidden></div></div>
  <div><label for="courriel">Courriel</label> <input id="courriel" name="courriel"></div>
  <button type="submit">Commander</button>
</form>
<p id="etat">Panier en attente</p>
<div id="recu" hidden></div>
<div id="cache" style="display:none">Contenu caché</div>
<script>
const $ = (id) => document.getElementById(id);
$('f').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const q = Number($('qte').value);
  if (!Number.isInteger(q) || q < 1) {
    $('qte').setAttribute('aria-invalid', 'true');
    $('qte-err').textContent = 'La quantité doit être un entier positif';
    $('qte-err').hidden = false;
    return;
  }
  $('qte').removeAttribute('aria-invalid');
  $('qte-err').hidden = true;
  const r = await fetch('/api/commande?qte=' + q, { method: 'POST' });
  if (!r.ok) { console.error('échec de la commande', r.status); $('etat').textContent = 'Erreur serveur, réessayez'; return; }
  const j = await r.json();
  history.pushState({}, '', '/boutique/merci');
  document.title = 'Merci';
  $('etat').textContent = 'Commande enregistrée n°' + j.numero;
  $('recu').textContent = 'Reçu : ' + q + ' article(s)';
  $('recu').hidden = false;
});
</script></body></html>`;

/** expect request : « Enregistrer » qui change de page — fetch POST puis navigation, formulaire POST en PRG (302 → GET). */
export const ENREGISTRER_NAV_PAGE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Enregistrer puis lister</title></head><body>
<button id="fetch-nav" onclick="fetch('/api/commande?qte=2', { method: 'POST' }).then(() => { location.href = '/boutique'; })">Enregistrer et lister</button>
<form method="post" action="/redirect-to?u=/boutique"><input name="nom" value="Jean"><button id="prg">Envoyer</button></form>
</body></html>`;

/** text --markdown : page riche (titres, emphase, code, liens, images, listes imbriquées, citation, tableau) et contenus cachés. */
export const MARKDOWN_PAGE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Markdown</title>
<style>.cache { display: none } .invisible { visibility: hidden } .flex { display: flex; gap: 8px }</style></head><body>
<h1>Guide   de <em>lecture</em></h1>
<p>Un paragraphe avec du <strong>gras</strong>, de l'<em>italique</em>, du <code>code_inline()</code>,
un <a href="/doc/intro?x=1#haut">lien relatif</a> et <b> espaces </b>autour.</p>
<p>Image : <img src="/logo.png" alt="Logo Grasp" width="20" height="20"> et pixel <img src="data:image/png;base64,${'A'.repeat(400)}" alt="Pixel" width="2" height="2"></p>
<h2>Listes</h2>
<ul>
  <li>Premier point</li>
  <li>Deuxième point
    <ul><li>Sous-point A</li><li>Sous-point <strong>B</strong>
      <ol><li>Étape un</li><li>Étape deux</li></ol>
    </li></ul>
  </li>
  <li>Troisième point</li>
</ul>
<ol start="3"><li>Trois</li><li>Quatre</li></ol>
<blockquote><p>Une citation <em>célèbre</em>.</p><p>Second paragraphe cité.</p></blockquote>
<pre><code class="language-js">function f(x) {
  return \`\`\`x\`\`\`;
}</code></pre>
<table>
  <caption>Tarifs</caption>
  <thead><tr><th>Produit</th><th>Prix</th></tr></thead>
  <tbody><tr><td>Vélo <a href="/velo">fiche</a></td><td>1 | 2 €</td></tr><tr><td>Casque</td><td>30 €</td></tr></tbody>
</table>
<a id="carte" href="/carte"><div><h3>Carte cliquable</h3><p>Description de la carte</p></div></a>
<p>Saut<br>de ligne et <a href="javascript:void 0">pseudo-lien</a>.</p>
<div class="flex"><span>Bloc flex un</span><span>Bloc flex deux</span></div>
<hr>
<div class="cache">Secret display none</div>
<p hidden>Secret attribut hidden</p>
<p><span class="invisible">Secret visibility hidden</span>Visible à côté</p>
<details><summary>Résumé visible</summary><p>Secret replié</p></details>
<script>var secretScript = 'Secret script';</script>
<noscript>Secret noscript</noscript>
<template><p>Secret template</p></template>
<form><input value="Secret champ"><select><option>Secret option</option></select><textarea>Secret zone</textarea><button type="button">Bouton visible</button></form>
<hote-fantome></hote-fantome>
<section id="zone-md"><h2>Zone</h2><p>Texte de la <strong>zone</strong>.</p></section>
<script>
customElements.define('hote-fantome', class extends HTMLElement {
  connectedCallback() { this.attachShadow({ mode: 'open' }).innerHTML = '<p>Texte <em>fantôme</em> : <slot></slot></p>'; }
});
document.querySelector('hote-fantome').textContent = 'contenu inséré';
</script>
</body></html>`;

/** DOM de 10 000 niveaux de <span> (créé en JS : l'analyseur HTML aplatit au-delà de 512 ; Chrome met des secondes à mettre en page plus profond). */
export const PROFOND_PAGE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Profond</title></head><body><p>Surface</p><div id="r"></div>
<script>
let n = document.getElementById('r');
const N = Number(new URLSearchParams(location.search).get('n') || 10000);
for (let i = 0; i < N; i++) { const d = document.createElement('span'); n.appendChild(d); n = d; }
n.innerHTML = '<strong>Fond atteint</strong>';
</script></body></html>`;

export interface TestSite { url: string; server: Server; hits: string[]; close(): Promise<void> }

/** Petit site local servant la page de test. Aucun site externe dans la suite. */
export async function startTestSite(): Promise<TestSite> {
  const hits: string[] = [];
  /** Sessions de connexion du site : sid → utilisateur. */
  const logins = new Map<string, string>();
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    hits.push(u.pathname);
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (u.pathname === '/connexion') { res.end(CONNEXION_PAGE); return; }
    if (u.pathname === '/connecte') {
      const user = u.searchParams.get('user') ?? 'anonyme';
      const sid = `sid-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
      logins.set(sid, user);
      // sid : HttpOnly, persistant ; pref : cookie de session (sans Max-Age).
      res.setHeader('set-cookie', [`sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600`, 'pref=fr; Path=/']);
      res.end(`<!doctype html><title>Connecté</title><h1>Bienvenue ${user}</h1><a href="/compte">Mon compte</a>
<script>localStorage.setItem('theme', 'sombre'); sessionStorage.setItem('brouillon', 'bonjour');</script>`);
      return;
    }
    if (u.pathname === '/compte') {
      const sid = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
      res.end(comptePage(sid !== undefined ? logins.get(sid) : undefined));
      return;
    }
    if (u.pathname === '/submit') { res.end(resultPage(u.searchParams)); return; }
    if (u.pathname === '/redirect-out') { res.statusCode = 302; res.setHeader('location', 'http://example.com/'); res.end(); return; }
    // Protection SSRF : redirection vers une cible arbitraire, et page cible repérable dans `hits`.
    if (u.pathname === '/redirect-to') { res.statusCode = 302; res.setHeader('location', u.searchParams.get('u') ?? '/'); res.end(); return; }
    if (u.pathname === '/cible-ssrf') { res.end('<!doctype html><title>Cible SSRF</title><p>service interne</p>'); return; }
    if (u.pathname === '/link-out') { res.end('<!doctype html><title>Liens</title><a href="http://example.com/">Externe</a>'); return; }
    if (u.pathname === '/capture') { res.end(CAPTURE_PAGE); return; }
    if (u.pathname === '/console') { res.end(CONSOLE_PAGE); return; }
    if (u.pathname === '/console-frame') { res.end('<!doctype html><title>Cadre</title><p>cadre</p><script>console.log("depuis le cadre")</script>'); return; }
    // Cadre qui navigue lui-même vers [::1] (hors allowlist) : la garde doit s'appliquer DANS l'iframe.
    if (u.pathname === '/frame-nav') { res.end('<!doctype html><title>Navigant</title><script>setTimeout(() => { location.href = "http://[::1]:" + location.port + "/"; }, 50)</script>'); return; }
    if (u.pathname === '/boutique' || u.pathname === '/boutique/merci') { res.end(BOUTIQUE_PAGE); return; }
    if (u.pathname === '/api/commande') {
      res.setHeader('content-type', 'application/json');
      if (u.searchParams.get('qte') === '13') { res.statusCode = 500; res.end('{"error":"stock"}'); return; }
      res.end('{"numero":42}'); return;
    }
    if (u.pathname === '/absent.png') { res.statusCode = 404; res.end('introuvable'); return; }
    if (u.pathname === '/api/data') { res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); return; }
    if (u.pathname === '/api/secret') { res.statusCode = 401; res.setHeader('content-type', 'application/json'); res.end('{"error":"corps-réponse-secret"}'); return; }
    if (u.pathname === '/api/lent') {
      const ms = Math.min(15000, Number(u.searchParams.get('ms') ?? '500'));
      res.setHeader('content-type', 'application/json');
      setTimeout(() => res.end('{"ok":true}'), ms).unref(); // long-polling : ne retient pas la fin des tests
      return;
    }
    if (u.pathname === '/connexion-captcha') { res.end(CONNEXION_CAPTCHA_PAGE); return; }
    if (u.pathname === '/recaptcha/api2/anchor') { res.end('<!doctype html><title>reCAPTCHA</title><p>Je ne suis pas un robot</p>'); return; }
    if (u.pathname === '/long-poll') { res.end(LONG_POLL_PAGE); return; }
    if (u.pathname === '/polling') { res.end(POLLING_PAGE); return; }
    if (u.pathname === '/challenge-reseau') { res.end(CHALLENGE_RESEAU_PAGE); return; }
    if (u.pathname === '/challenge-minuterie') { res.end(CHALLENGE_MINUTERIE_PAGE); return; }
    if (u.pathname === '/challenge-ok') { res.end(CHALLENGE_OK_PAGE); return; }
    if (u.pathname.startsWith('/spa-recherche')) { res.end(SPA_RECHERCHE_PAGE); return; }
    if (u.pathname === '/enregistrer') { res.end(ENREGISTRER_PAGE); return; }
    if (u.pathname === '/enregistrer-nav') { res.end(ENREGISTRER_NAV_PAGE); return; }
    if (u.pathname === '/editeur-riche') { res.end(EDITEUR_RICHE_PAGE); return; }
    if (u.pathname === '/arriere-plan') { res.end(ARRIERE_PLAN_PAGE); return; }
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
    if (u.pathname === '/sonde') { res.end(SONDE_PAGE); return; }
    if (u.pathname === '/flottant') { res.end(FLOTTANT_PAGE); return; }
    if (u.pathname === '/cadres') { res.end(CADRES_PAGE); return; }
    if (u.pathname === '/pw-cadres') { res.end(PW_CADRES_PAGE); return; }
    if (u.pathname === '/pw-editeur') { res.end(PW_EDITEUR_PAGE); return; }
    if (u.pathname === '/pw-texte') { res.end(PW_TEXTE_PAGE); return; }
    if (u.pathname === '/dialogue') { res.end(DIALOGUE_PAGE); return; }
    if (u.pathname === '/erreurs') { res.end(ERREURS_PAGE); return; }
    if (u.pathname === '/cases') { res.end(CASES_PAGE); return; }
    if (u.pathname === '/remplace') { res.end(REMPLACE_PAGE); return; }
    if (u.pathname === '/carrousel') { res.end(CARROUSEL_PAGE); return; }
    if (u.pathname === '/fond-reseau') { res.end(FOND_RESEAU_PAGE); return; }
    if (u.pathname === '/traqueurs') { res.end(TRAQUEURS_PAGE.replaceAll('PORT', String((server.address() as AddressInfo).port))); return; }
    if (u.pathname.startsWith('/trk/')) { res.setHeader('content-type', 'text/plain'); setTimeout(() => res.end(''), 1500); return; }
    if (u.pathname.startsWith('/presque/')) { res.setHeader('content-type', 'text/plain'); res.end(''); return; }
    if (u.pathname.startsWith('/fond/')) { setTimeout(() => res.end('{}'), 60); return; }
    if (u.pathname === '/livres') { res.end(LIVRES_PAGE); return; }
    if (u.pathname === '/markdown') { res.end(MARKDOWN_PAGE); return; }
    if (u.pathname === '/profond') { res.end(PROFOND_PAGE); return; }
    if (u.pathname === '/console-spa') { res.end(CONSOLE_SPA_PAGE); return; }
    if (u.pathname === '/console-bruit') { res.end(CONSOLE_BRUIT_PAGE); return; }
    if (u.pathname === '/snap-v3') { res.end(SNAP_V3_PAGE); return; }
    if (u.pathname === '/radios') { res.end(RADIOS_PAGE); return; }
    if (u.pathname === '/modale') { res.end(MODALE_PAGE); return; }
    if (u.pathname === '/cadre-texte') { res.end('<!doctype html><title>Cadre</title><p>Contenu du cadre</p>'); return; }
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
