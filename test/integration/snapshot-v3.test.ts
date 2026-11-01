import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openPage, type PageFixture } from '../helpers/chrome.js';
import { startTestSite, type TestSite } from '../helpers/testsite.js';

/**
 * Rendu du snapshot, défauts relevés sur le banc multi-sites et l'édition d'un profil Malt : nœuds
 * texte vides, libellés répétés, validité affichée trop tôt, text-transform, boutons sans nom (croix de
 * tags), options des listes déroulantes, option « Créer … », refs masquées par une fenêtre modale.
 */

let site: TestSite;
let fx: PageFixture;
before(async () => { site = await startTestSite(); fx = await openPage(); });
after(async () => { await fx.close(); await site.close(); });

const lines = (text: string) => text.split('\n').map((l) => l.trim());
const line = (text: string, re: RegExp) => lines(text).find((l) => re.test(l)) ?? '';
const refOf = (text: string, re: RegExp): string => {
  const l = line(text, re);
  assert.ok(l, `aucune ligne ${re} dans :\n${text}`);
  return l.split(':')[0]!;
};
const etat = async () => (await fx.page.text(undefined, '#etat')).trim();

test('nœuds texte vides (espaces de largeur nulle) et puces de liste : aucune ligne ""', async () => {
  await fx.page.navigate(`${site.url}/snap-v3`);
  const s = (await fx.page.snapshot()).text;
  const vides = lines(s).filter((l) => /^"[\s\u200b-\u200d\u2060\ufeff\u00ad]*"$/.test(l));
  assert.deepEqual(vides, [], s);
  assert.doesNotMatch(s, /^\s*"•"$/m, 'puces de liste');
  assert.match(s, /"Avant le vide"\n"Après le vide"/, s);
});

test('libellé répété (deux labels, aria-labelledby doublé) : nom dédupliqué, texte du label non répété', async () => {
  await fx.page.navigate(`${site.url}/snap-v3`);
  const s = (await fx.page.snapshot()).text;
  assert.match(s, /^e[0-9a-z]+:spinbutton "Heures"="35"$/m, s);
  assert.match(s, /^e[0-9a-z]+:textbox "Disponibilité"$/m, s);
  assert.equal(lines(s).filter((l) => l.includes('Heures')).length, 1, s);
  assert.equal(lines(s).filter((l) => l.includes('Disponibilité')).length, 1, s);
});

test('radio, case à cocher et champ required d\'un formulaire vierge : pas de [invalide] ; après soumission : oui', async () => {
  await fx.page.navigate(`${site.url}/radios`);
  const s = (await fx.page.snapshot()).text;
  assert.doesNotMatch(s, /invalide/, s);
  await fx.page.click('#envoyer');
  const apres = (await fx.page.snapshot()).text;
  assert.match(line(apres, /textbox "Ville"/), /\[invalide: .+\]$/, apres);
  assert.match(line(apres, /radio "Jour"/), /\[invalide: .+\]$/, apres);
  assert.match(line(apres, /checkbox "J'accepte"/), /\[invalide: .+\]$/, apres);
});

test('text-transform : le snapshot montre le texte source du DOM, pas le texte transformé', async () => {
  await fx.page.navigate(`${site.url}/snap-v3`);
  const s = (await fx.page.snapshot()).text;
  assert.match(s, /^e[0-9a-z]+:heading\[2\] "Mes compétences"$/m, s);
  assert.match(s, /^e[0-9a-z]+:button "Enregistrer le profil"$/m, s);
  assert.match(s, /^"texte libre en minuscules"$/m, s);
  assert.doesNotMatch(s, /MES COMPÉTENCES|ENREGISTRER|Texte Libre/, s);
  // text: retrouve l'élément par son texte source.
  await fx.page.click('text:Enregistrer le profil');
});

test('boutons sans nom (croix de tags) : nommés par leur contexte ; refs stables après suppression d\'un tag', async () => {
  await fx.page.navigate(`${site.url}/snap-v3`);
  const s = (await fx.page.snapshot()).text;
  const php = refOf(s, /button \(sans nom, près de "PHP"\)$/);
  const symfony = refOf(s, /button \(sans nom, près de "Symfony"\)$/);
  const laravel = refOf(s, /button \(sans nom, près de "Laravel"\)$/);
  assert.equal(new Set([php, symfony, laravel]).size, 3);
  await fx.page.click(php);
  const apres = (await fx.page.snapshot()).text;
  assert.doesNotMatch(apres, /"PHP"/, apres);
  assert.equal(refOf(apres, /button \(sans nom, près de "Symfony"\)$/), symfony, 'la ref de la croix Symfony ne glisse pas');
  assert.equal(refOf(apres, /button \(sans nom, près de "Laravel"\)$/), laravel);
  // L'ancienne ref de la croix PHP ne désigne pas la croix voisine.
  await assert.rejects(fx.page.click(php));
  const tags = (await fx.page.text(undefined, '#tags')).split(/\s+/).filter(Boolean).join(',');
  assert.equal(tags, 'Symfony,Laravel');
});

test('listes déroulantes : options du select natif (20 max, sélection marquée) et listbox ARIA tronquée', async () => {
  await fx.page.navigate(`${site.url}/snap-v3`);
  const snap = await fx.page.snapshot();
  const s = snap.text;
  const all = s.split('\n');
  const i = all.findIndex((l) => /combobox "Pays"="Pays 2"/.test(l));
  assert.ok(i >= 0, s);
  const opts = all[i + 1]!;
  assert.match(opts, /^ options : "Pays 0" \| "Pays 1" \| "Pays 2" \[x\] \| "Pays 3" .*"Pays 19" \| … \+5$/, s);
  assert.equal(opts.match(/"Pays \d+"/g)!.length, 20);
  assert.match(s, /combobox "Unité"="Heure" \[-\]\n options : "Jour" \| "Heure" \[x\]$/m, s);
  // Listbox ARIA : 20 options rendues, l'option sélectionnée marquée, le reste compté.
  assert.equal(lines(s).filter((l) => /:option "Ville \d+"/.test(l)).length, 20, s);
  assert.match(s, /:option "Ville 3" \[x\]$/m);
  assert.match(s, /^\s*… \+10 options$/m, s);
  // Les options masquées restent résolubles.
  await fx.page.click('text:Ville 27');
  assert.ok([...snap.meta.values()].some((m) => m.role === 'option' && m.name === 'Pays 24'));
});

test('autocomplétion : l\'option « Créer … » est rendue en entier, distincte des suggestions', async () => {
  await fx.page.navigate(`${site.url}/snap-v3`);
  const s = (await fx.page.snapshot()).text;
  assert.match(s, /^\s*e[0-9a-z]+:option "Laravel 10"$/m, s);
  assert.match(s, /^\s*e[0-9a-z]+:option "Laravel Livewire" \[x\]$/m, s);
  assert.match(s, /^\s*e[0-9a-z]+:option "\+ Créer « Laravel »"$/m, s);
});

test('fenêtre modale (showModal) : refs du fond « masquées par une fenêtre modale », jamais déplacées sur un homonyme', async () => {
  await fx.page.navigate(`${site.url}/modale`);
  const s = (await fx.page.snapshot()).text;
  const fermerFond = refOf(s, /button "Fermer"/);
  const supprimer = refOf(s, /button "Supprimer"/);
  await fx.page.click('#ouvrir');
  const m = (await fx.page.snapshot()).text;
  assert.match(m, /dialog "Confirmation"/, m);
  assert.doesNotMatch(m, /Supprimer/, 'le snapshot se concentre sur la modale');
  assert.match(m, /masqué par la fenêtre modale/, m);
  const fermerModale = refOf(m, /button "Fermer"/);
  assert.notEqual(fermerModale, fermerFond, 'la ref du « Fermer » du fond ne glisse pas sur celui de la modale');
  await assert.rejects(fx.page.click(supprimer), /masqué.* par une fenêtre modale/);
  await assert.rejects(fx.page.click(fermerFond), /masqué.* par une fenêtre modale/);
  await assert.rejects(fx.page.click('text:Supprimer'), /fenêtre modale ouverte masque le reste de la page/);
  assert.equal(await etat(), 'Rien');
  await fx.page.click(fermerModale);
  await fx.page.click(supprimer);
  assert.equal(await etat(), 'Supprimé');
});

test('fenêtre modale aria-modal avec fond aria-hidden : même comportement', async () => {
  await fx.page.navigate(`${site.url}/modale`);
  const s = (await fx.page.snapshot()).text;
  const fermerFond = refOf(s, /button "Fermer"/);
  const supprimer = refOf(s, /button "Supprimer"/);
  await fx.page.click('#ouvrir-aria');
  const m = (await fx.page.snapshot()).text;
  assert.match(m, /dialog "Confirmation ARIA"/, m);
  const fermerModale = refOf(m, /button "Fermer"/);
  assert.notEqual(fermerModale, fermerFond);
  await assert.rejects(fx.page.click(supprimer), /masqué.* par une fenêtre modale/);
  await assert.rejects(fx.page.click(fermerFond), /masqué.* par une fenêtre modale/);
  assert.equal(await etat(), 'Rien');
});
