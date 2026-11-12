/**
 * Grosse page de test de la lecture progressive (`snap --outline`, `--interactive`, `find`) : un portail de
 * boutique à la manière d'une vraie page de catalogue — bandeau et menu (60 liens), recherche, filtres (cases),
 * 48 fiches produit (titre, description, prix, bouton), tableau de commandes (40 lignes, bouton par ligne),
 * formulaire de livraison (<select> de 120 pays), pied de page (80 liens). Contenu déterministe.
 */

const PAYS = Array.from({ length: 120 }, (_, i) => (i === 87 ? 'Madagascar' : `Pays ${String(i + 1).padStart(3, '0')}`));
const CATEGORIES = ['Vélos', 'Casques', 'Pneus', 'Freins', 'Éclairage', 'Bagagerie', 'Outils', 'Vêtements'];

function produit(i: number): string {
  const cat = CATEGORIES[i % CATEGORIES.length]!;
  return `<article aria-labelledby="p${i}"><h3 id="p${i}">${cat} modèle ${i}</h3>
<p>Description du produit ${i} : un article de la catégorie ${cat.toLowerCase()}, robuste et léger, garanti deux ans, livré monté et réglé par nos ateliers.</p>
<p>Prix : ${(49 + i * 7) % 900},90 €</p>
<button type="button">Ajouter au panier</button> <a href="/produit/${i}">Voir la fiche</a></article>`;
}

function commande(i: number): string {
  return `<tr aria-label="Commande ${1000 + i}"><td>Commande ${1000 + i}</td><td>${(i % 28) + 1}/10/2026</td><td>${i % 3 === 0 ? 'Livrée' : 'En préparation'}</td><td><button type="button">Annuler</button></td></tr>`;
}

export const PORTAIL_PAGE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Portail vélo</title></head>
<body>
<header>
  <h1>Portail vélo</h1>
  <nav aria-label="Menu principal">${Array.from({ length: 60 }, (_, i) => `<a href="/rubrique/${i}">Rubrique ${i}</a>`).join(' ')}</nav>
  <form role="search" aria-label="Recherche"><label for="q">Rechercher</label> <input id="q" type="search"> <button>Chercher</button></form>
</header>
<aside aria-label="Filtres">
  <h2>Filtres</h2>
  ${CATEGORIES.map((c) => `<label><input type="checkbox"> ${c}</label>`).join('\n  ')}
</aside>
<main>
  <h2>Catalogue</h2>
  <p>${'Notre catalogue rassemble les meilleures références du moment, sélectionnées par nos mécaniciens. '.repeat(4)}</p>
  ${Array.from({ length: 48 }, (_, i) => produit(i)).join('\n  ')}
  <h2>Mes commandes</h2>
  <table aria-label="Commandes"><thead><tr><th>N°</th><th>Date</th><th>État</th><th>Action</th></tr></thead>
  <tbody>${Array.from({ length: 40 }, (_, i) => commande(i)).join('')}</tbody></table>
  <h2>Livraison</h2>
  <form aria-label="Livraison">
    <label for="adresse">Adresse</label> <input id="adresse">
    <label for="ville">Ville</label> <input id="ville">
    <label for="pays">Pays</label> <select id="pays">${PAYS.map((p) => `<option>${p}</option>`).join('')}</select>
    <button type="submit">Valider la livraison</button>
  </form>
</main>
<footer><h2>Plan du site</h2>${Array.from({ length: 80 }, (_, i) => `<a href="/plan/${i}">Page ${i}</a>`).join(' ')}</footer>
</body></html>`;
