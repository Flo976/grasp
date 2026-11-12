/**
 * Pages de l'audit d'accessibilité (grasp a11y, expect a11y). Servies par testsite.ts (/a11y, /a11y-propre).
 *
 * Page piégée : chaque défaut relevé y figure une fois au moins, à côté de sa version correcte (qui ne doit
 * PAS être signalée) — image décorative alt="", bouton icône avec aria-label, erreur reliée par
 * aria-describedby, role à jeton de repli valide, contenu masqué (display:none) porteur de défauts, icônes
 * `<svg>` inline sans aria-hidden dans un lien ou un bouton nommés par leur texte (jamais des images à signaler).
 */

const PIXEL = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2240%22 height=%2240%22%3E%3Crect width=%2240%22 height=%2240%22 fill=%22%23c00%22/%3E%3C/svg%3E';

export const A11Y_PAGE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Accessibilité piégée</title>
<style>.error{color:#c00} .cache{display:none}</style></head>
<body>
<h1>Boutique</h1>
<div class="toast-error" role="alert" aria-hidden="true">Paiement refusé</div>
<nav id="menu">
  <a href="/panier"><svg width="16" height="16" aria-hidden="true"><rect width="16" height="16"/></svg></a>
  <a href="/aide">Aide</a>
  <a href="/aide-en-ligne"><svg width="16" height="16"><rect width="16" height="16"/></svg> Aide en ligne</a>
  <a href="/compte" aria-label="Mon compte"><svg width="16" height="16" aria-hidden="true"><rect width="16" height="16"/></svg></a>
</nav>
<h3>Promotions</h3>
<section id="promos">
  <img src="${PIXEL}" width="40" height="40" class="promo-visuel">
  <img src="${PIXEL}" alt="" width="40" height="40">
  <img src="${PIXEL}" alt="Vélo de ville rouge" width="40" height="40">
  <div role="img" style="width:20px;height:20px;background:#0a0"></div>
  <button id="fermer-promo" type="button"><span class="icone-x"></span></button>
  <button type="button" aria-label="Fermer la bannière">×</button>
  <div role="switch" aria-checked="false" tabindex="0" style="width:30px;height:16px;background:#ccc"></div>
  <div role="bouton" tabindex="0">Commander</div>
  <div role="landmark">Zone abstraite</div>
  <div role="toggle button" tabindex="0">Repli valide</div>
  <svg role="img" class="logo-svg" width="20" height="20"><rect width="20" height="20"/></svg>
  <svg role="img" aria-label="Logo Vélo" width="20" height="20"><rect width="20" height="20"/></svg>
  <button type="button"><svg width="16" height="16"><rect width="16" height="16"/></svg> Valider le code</button>
  <p>Livraison offerte <svg width="16" height="16"><rect width="16" height="16"/></svg></p>
</section>
<h2>Inscription</h2>
<form id="inscription" onsubmit="return false">
  <label for="courriel-x">Courriel</label><input id="courriel" type="email" name="courriel">
  <div><label for="nom">Nom</label><input id="nom" aria-invalid="true"><span class="error">Le nom est obligatoire</span></div>
  <div><label for="tel">Téléphone</label><input id="tel" aria-invalid="true" aria-describedby="tel-err"><span id="tel-err" class="error">Numéro à 10 chiffres</span></div>
  <div><label for="ville">Ville</label><input id="ville" aria-describedby="ville-aide inexistant"><span id="ville-aide">Commune de livraison</span></div>
  <select id="pays"><option>France</option><option>Madagascar</option></select>
  <input type="checkbox" id="cgu"> J'accepte les conditions
  <label for="titre-form">Titre</label><span id="titre-form">pas un champ</span>
  <button type="submit">Envoyer</button>
</form>
<div class="cache"><button type="button"></button><img src="${PIXEL}"><div role="bouton">Masqué</div></div>
<h4>Pied de page</h4>
<button type="button" id="compter">Compter les mutations</button><p id="compte"></p>
<script>
// Piège : la page fausse ses propres prototypes et compte ses mutations. L'audit (monde isolé) ne doit ni être
// trompé ni modifier le DOM.
const compte = document.getElementById('compte');
document.getElementById('compter').addEventListener('click', () => { compte.textContent = 'mutations : ' + window.mutations; });
Document.prototype.querySelectorAll = function () { return []; };
Element.prototype.querySelectorAll = function () { return []; };
Element.prototype.getAttribute = function () { return null; };
Document.prototype.getElementById = function () { return document.body; };
window.mutations = 0;
new MutationObserver((l) => { window.mutations += l.length; }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
</script>
</body></html>`;

/** Même contenu, corrigé : aucun problème attendu. */
export const A11Y_PROPRE_PAGE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Accessibilité propre</title></head>
<body>
<h1>Boutique</h1>
<nav><a href="/panier" aria-label="Panier"><svg width="16" height="16" aria-hidden="true"><rect width="16" height="16"/></svg></a> <a href="/aide">Aide</a></nav>
<h2>Promotions</h2>
<img src="${PIXEL}" alt="Vélo de ville rouge" width="40" height="40">
<img src="${PIXEL}" alt="" width="40" height="40">
<button type="button" aria-label="Fermer la bannière">×</button>
<button type="button"><svg width="16" height="16"><rect width="16" height="16"/></svg> Valider le code</button>
<div role="switch" aria-checked="false" tabindex="0" aria-label="Notifications">Notifications</div>
<h2>Inscription</h2>
<form onsubmit="return false">
  <label for="courriel">Courriel</label><input id="courriel" type="email">
  <div><label for="nom">Nom</label><input id="nom" aria-invalid="true" aria-describedby="nom-err"><span id="nom-err" class="error">Le nom est obligatoire</span></div>
  <label for="pays">Pays</label><select id="pays"><option>France</option></select>
  <label><input type="checkbox"> J'accepte les conditions</label>
  <button type="submit">Envoyer</button>
</form>
<h3>Pied de page</h3>
</body></html>`;
