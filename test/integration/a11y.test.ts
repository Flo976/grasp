import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openPage, type PageFixture } from '../helpers/chrome.js';
import { startTestSite, type TestSite } from '../helpers/testsite.js';
import { GraspError } from '../../src/core/errors.js';

/**
 * Audit d'accessibilité (grasp a11y, expect a11y) sur une page piégée (test/helpers/a11ysite.ts) : chaque défaut
 * est relevé une fois, sa version correcte jamais ; contenu masqué ignoré ; la page ne peut ni tromper l'audit
 * (prototypes faussés dans son monde) ni le voir (aucune mutation). Politique par défaut : eval désactivé.
 */

let site: TestSite;
let fx: PageFixture;
before(async () => { site = await startTestSite(); fx = await openPage(); });
after(async () => { await fx.close(); await site.close(); });

const lineOf = (text: string, re: RegExp) => text.split('\n').find((l) => re.test(l)) ?? '';

test('page piégée : chaque défaut relevé une fois, avec sa ref quand elle existe et une correction ; rien de plus', async () => {
  assert.equal(fx.page.policy.allowEval, false, 'audit autorisé sans eval');
  await fx.page.navigate(`${site.url}/a11y`);
  const r = await fx.page.a11y({ max: 100 });
  const t = r.text;
  assert.deepEqual(r.counts, { 'sans-nom': 6, 'image-sans-alt': 3, 'erreur-non-reliee': 1, 'erreur-sans-invalide': 1, 'erreur-masquee': 1, 'libelle-orphelin': 2, 'reference-cassee': 1, 'role-invalide': 2, 'titre-saute': 2 }, t);
  assert.equal(r.total, 19);
  assert.equal(r.omitted, 0);
  assert.match(t.split('\n')[0]!, /^a11y : 19 problèmes — page "Accessibilité piégée" http:\/\/127\.0\.0\.1:\d+\/a11y$/);
  // Contrôles sans nom : ref + description DOM qui relie la ligne au code.
  assert.match(lineOf(t, /a\[href="\/panier"\]/), /^sans-nom e[0-9a-z]+:link a\[href="\/panier"\] — aucun nom accessible → texte du lien, ou aria-label/);
  assert.match(lineOf(t, /fermer-promo/), /^sans-nom e[0-9a-z]+:button .*button#fermer-promo — .* → texte visible, ou aria-label/);
  assert.match(lineOf(t, /:switch/), /^sans-nom e[0-9a-z]+:switch .*div\[role="switch"\]/);
  assert.match(lineOf(t, /input#courriel/), /^sans-nom e[0-9a-z]+:textbox input#courriel\[type="email"\] — aucun nom accessible → <label for=id>/);
  assert.match(lineOf(t, /select#pays/), /^sans-nom e[0-9a-z]+:combobox="France" .*select#pays/);
  assert.match(lineOf(t, /input#cgu/), /^sans-nom e[0-9a-z]+:checkbox \(sans nom, près de "J'accepte les conditions"\)/);
  // Images : sans ref (une image sans nom n'est pas dans le snapshot), décrites par le DOM.
  assert.match(lineOf(t, /^image-sans-alt img/), /^image-sans-alt img\.promo-visuel|^image-sans-alt img\[src="data:image\/svg\+xml,…"\] — aucune alternative textuelle → alt=/);
  assert.match(t, /^image-sans-alt div\[role="img"\] — /m);
  // svg role=img sans nom : correction propre au svg (pas d'alt) ; icônes svg inline sans role (lien, bouton,
  // paragraphe) : jamais signalées.
  assert.match(lineOf(t, /^\S+ svg/), /^image-sans-alt svg\[role="img"\] — aucune alternative textuelle → <title> en premier enfant, ou aria-label ; aria-hidden="true" si décoratif$/);
  assert.equal(t.split('\n').filter((l) => /^\S+ svg/.test(l)).length, 1, t);
  // Erreurs : message visible non relié (réutilise la détection des erreurs de formulaire), message masqué.
  assert.match(lineOf(t, /^erreur-non-reliee/), /^erreur-non-reliee e[0-9a-z]+:textbox "Nom" \[invalide: Le nom est obligatoire\] — message « Le nom est obligatoire » affiché mais non relié .* → aria-describedby/);
  // Message relié par aria-describedby mais champ sans aria-invalid : le défaut est l'état, pas le lien.
  assert.match(lineOf(t, /"Prénom"/), /^erreur-sans-invalide e[0-9a-z]+:textbox "Prénom" .*— message « Le prénom est obligatoire » relié \(aria-describedby\) mais champ non marqué invalide → aria-invalid="true" tant que l'erreur est affichée$/);
  assert.equal(t.split('\n').filter((l) => /"Prénom"/.test(l)).length, 1, t);
  assert.match(lineOf(t, /^erreur-masquee/), /^erreur-masquee "Paiement refusé" — erreur affichée mais aria-hidden/);
  // Libellés, références, rôles, titres.
  assert.match(t, /^libelle-orphelin label\[for="courriel-x"\] "Courriel" — aucun élément d'id « courriel-x »/m);
  assert.match(t, /^libelle-orphelin label\[for="titre-form"\] "Titre" — for vise span#titre-form "pas un champ", qui n'est pas un champ/m);
  assert.match(t, /^reference-cassee e[0-9a-z]+:textbox "Ville" — aria-describedby → id absent : « inexistant »/m);
  assert.match(t, /^role-invalide div\[role="bouton"\] "Commander" — role="bouton" inconnu, ignoré par le navigateur → role="button"/m);
  assert.match(t, /^role-invalide div\[role="landmark"\] "Zone abstraite" — « landmark » : rôle abstrait/m);
  assert.match(t, /^titre-saute e[0-9a-z]+:heading\[3\] "Promotions" — h3 après h1 « Boutique » → h2/m);
  assert.match(t, /^titre-saute e[0-9a-z]+:heading\[4\] "Pied de page" — h4 après h2 « Inscription » → h3/m);
  // Versions correctes : jamais signalées. Contenu masqué (display:none) : non audité.
  assert.doesNotMatch(t, /Mon compte|Aide en ligne|Valider le code|Livraison offerte|Logo Vélo|Fermer la bannière|Vélo de ville|Téléphone|Repli valide|Masqué|tel-err/);
  assert.equal(r.note.includes('pas un audit WCAG'), true);
  // Ordre : A11Y_KINDS, puis document.
  const kinds = t.split('\n').slice(2).map((l) => l.split(' ')[0]);
  assert.deepEqual(kinds, ['sans-nom', 'sans-nom', 'sans-nom', 'sans-nom', 'sans-nom', 'sans-nom', 'image-sans-alt', 'image-sans-alt', 'image-sans-alt', 'erreur-non-reliee', 'erreur-sans-invalide', 'erreur-masquee', 'libelle-orphelin', 'libelle-orphelin', 'reference-cassee', 'role-invalide', 'role-invalide', 'titre-saute', 'titre-saute']);
});

test('les refs rendues sont utilisables telles quelles ; la page ne voit rien (aucune mutation) et ne trompe pas l\'audit', async () => {
  await fx.page.navigate(`${site.url}/a11y`);
  const r = await fx.page.a11y();
  const field = r.issues.find((i) => i.who.includes('input#courriel'));
  assert.ok(field?.ref !== undefined, JSON.stringify(r.issues));
  await fx.page.fill(field.ref, 'ada@example.org');
  const btn = r.issues.find((i) => i.who.includes('#fermer-promo'))?.ref;
  assert.ok(btn !== undefined);
  await fx.page.click(btn);
  // Les prototypes faussés par la page (querySelectorAll vide, getAttribute null) n'ont rien caché : 19 relevés
  // ci-dessus. Mutations vues par la page pendant les audits : aucune hors des deux actions (valeur, focus).
  // Témoin : un premier clic (sans audit) donne le compte de base ; son écriture ajoute 1 mutation (childList).
  await fx.page.navigate(`${site.url}/a11y`);
  await fx.page.click('#compter');
  const base = Number(/mutations : (\d+)/.exec(await fx.page.text(undefined, '#compte'))?.[1] ?? NaN);
  await fx.page.a11y();
  await fx.page.a11y({ scope: '#inscription' });
  await fx.page.expect({ kind: 'a11y', max: 100 });
  await fx.page.click('#compter');
  const n = Number(/mutations : (\d+)/.exec(await fx.page.text())?.[1] ?? NaN);
  assert.ok(Number.isInteger(base), String(base));
  assert.equal(n, base + 1, `mutations : ${base} avant les audits, ${n} après`);
});

test('--scope : seulement la zone (les titres sautés se jugent sur la page entière) ; zone introuvable ou frame= refusées', async () => {
  await fx.page.navigate(`${site.url}/a11y`);
  const f = await fx.page.a11y({ scope: '#inscription' });
  assert.deepEqual(f.counts, { 'sans-nom': 3, 'erreur-non-reliee': 1, 'erreur-sans-invalide': 1, 'libelle-orphelin': 2, 'reference-cassee': 1 }, f.text);
  assert.match(f.text.split('\n')[0]!, /^a11y : 8 problèmes dans #inscription — page/);
  const p = await fx.page.a11y({ scope: '#promos' });
  assert.deepEqual(p.counts, { 'sans-nom': 2, 'image-sans-alt': 3, 'role-invalide': 2 }, p.text);
  // Le titre « Promotions » (hors zone) n'est pas rapporté dans #promos ; « Pied de page » l'est dans body.
  const b = await fx.page.a11y({ scope: 'body' });
  assert.equal(b.counts['titre-saute'], 2);
  await assert.rejects(fx.page.a11y({ scope: '#absent' }), (e: unknown) => e instanceof GraspError && e.status === 404);
  await assert.rejects(fx.page.a11y({ scope: 'frame=#x' }), (e: unknown) => e instanceof GraspError && e.status === 400 && /frame=/.test(e.message));
  await assert.rejects(fx.page.a11y({ max: 0 }), (e: unknown) => e instanceof GraspError && e.status === 400);
});

test('--max : liste bornée, comptes complets, coupure annoncée', async () => {
  await fx.page.navigate(`${site.url}/a11y`);
  const r = await fx.page.a11y({ max: 3 });
  assert.equal(r.total, 19);
  assert.equal(r.issues.length, 3);
  assert.equal(r.omitted, 16);
  const lines = r.text.split('\n');
  assert.equal(lines.length, 2 + 3 + 1, r.text);
  assert.equal(lines.at(-1), '… 16 problèmes non listés — affinez avec --max N / --scope <ref|css>');
  assert.match(lines[1]!, /contrôle sans nom : 6 · .* · niveau de titre sauté : 2$/);
});

test('page corrigée : aucun problème ; expect a11y tenu', async () => {
  await fx.page.navigate(`${site.url}/a11y-propre`);
  const r = await fx.page.a11y();
  assert.equal(r.total, 0, r.text);
  assert.match(r.text, /^a11y : aucun problème relevé — page "Accessibilité propre"/);
  assert.deepEqual(await fx.page.expect({ kind: 'a11y' }).then((x) => ({ ok: x.ok, detail: x.detail })), { ok: true, detail: undefined });
});

test('expect a11y : 417 avec l\'attendu et le constaté (borné) ; --max N tolère N problèmes, annoncés en note', async () => {
  await fx.page.navigate(`${site.url}/a11y`);
  await assert.rejects(fx.page.expect({ kind: 'a11y' }), (e: unknown) => {
    assert.ok(e instanceof GraspError && e.status === 417, String(e));
    assert.match(e.message, /^attendu au plus 0 problème\(s\) d'accessibilité dans la page ; constaté : 19 problème\(s\) \(sans-nom 6, image-sans-alt 3, erreur-non-reliee 1, erreur-sans-invalide 1, erreur-masquee 1, libelle-orphelin 2, reference-cassee 1, role-invalide 2, titre-saute 2\) : sans-nom e[0-9a-z]+:link/);
    assert.match(e.message, /\| … et 14 autre\(s\)$/);
    const items = (e.extra?.expect as { items: string[] }).items;
    assert.equal(items.length, 19);
    return true;
  });
  const ok = await fx.page.expect({ kind: 'a11y', max: 19 });
  assert.match(ok.detail ?? '', /^19 problème\(s\) d'accessibilité toléré\(s\) \(--max 19\)/);
  await assert.rejects(fx.page.expect({ kind: 'a11y', max: 18 }), /constaté : 19 problème/);
  await assert.rejects(fx.page.expect({ kind: 'a11y', scope: '#inscription', max: 7 }), /attendu au plus 7 problème\(s\) d'accessibilité dans #inscription ; constaté : 8/);
});

test('formulaire Malt (message aria-hidden sous un champ sans aria-*) : erreur non reliée, ref du champ', async () => {
  await fx.page.navigate(`${site.url}/erreurs`);
  await fx.page.fill('#headline', 'Développeur PHP Symfony Migration Sécurité Web IA Expert');
  const r = await fx.page.a11y({ scope: '#tiroir' });
  assert.match(r.text, /^erreur-non-reliee e[0-9a-z]+:textbox "Intitulé du poste"=.* \[invalide: Doit compter au maximum 50 caractères\] — message « Doit compter au maximum 50 caractères » affiché mais non relié/m, r.text);
  // Les champs reliés par aria-describedby / aria-errormessage ne sont pas signalés.
  await fx.page.click('text:Enregistrer');
  const after = await fx.page.a11y({ scope: '#tiroir' });
  assert.doesNotMatch(after.text, /"Code postal"|"Téléphone"/, after.text);
  assert.match(after.text, /"Nom" \[invalide: Le nom est obligatoire\] — message « Le nom est obligatoire » affiché mais non relié/);
});
