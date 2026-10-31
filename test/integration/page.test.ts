import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openPage, type PageFixture } from '../helpers/chrome.js';
import { startTestSite, type TestSite } from '../helpers/testsite.js';
import { GraspError } from '../../src/core/errors.js';

let site: TestSite;
let fx: PageFixture;
before(async () => { site = await startTestSite(); fx = await openPage(); });
after(async () => { await fx.close(); await site.close(); });

const refOf = (snap: string, re: RegExp): string => {
  const line = snap.split('\n').find((l) => re.test(l));
  assert.ok(line, `aucune ligne ${re} dans :\n${snap}`);
  return line.trim().split(':')[0]!;
};

// ---------- Phase 2 : snapshot ----------

test('snap : arbre compact de la page de test', async () => {
  await fx.page.navigate(`${site.url}/`);
  const s = await fx.page.snapshot();
  assert.match(s.text, /^page "Inscription" http:\/\/127\.0\.0\.1:\d+\//);
  for (const re of [/textbox "Nom"/, /textbox "Email"/, /textbox "Ville"/, /combobox "Pays"/, /checkbox "J'accepte les conditions" \[ \]/, /button "Valider"/, /heading\[1\] "Inscription"/, /link "Accueil"/, /"En attente"/]) {
    assert.match(s.text, re);
  }
  assert.doesNotMatch(s.text, /generic|StaticText|LabelText|InlineTextBox/);
});

test('snap : budget en octets — la page de test tient sous 1 Ko', async (t) => {
  await fx.page.navigate(`${site.url}/`);
  const s = await fx.page.snapshot();
  const bytes = Buffer.byteLength(s.text);
  const png = await fx.page.screenshot();
  const pngB64 = png.toString('base64').length;
  assert.ok(bytes <= 1024, `snapshot de ${bytes} octets (budget 1024) :\n${s.text}`);
  t.diagnostic(`snapshot ${bytes} o ; capture PNG base64 ${pngB64} o ; ratio ${(pngB64 / bytes).toFixed(0)}×`);
});

test('snap : budget maxBytes respecté sur une grosse page', async () => {
  await fx.page.navigate(`${site.url}/big`);
  const s = await fx.page.snapshot({ maxBytes: 4096 });
  assert.ok(Buffer.byteLength(s.text) <= 4096);
  assert.match(s.text, /nœuds omis/);
  const full = await fx.page.snapshot({ maxBytes: 1024 * 1024 });
  assert.match(full.text, /link "Produit numéro 1999"/);
});

test('refs stables : un élément inséré en haut ne décale pas les refs existantes', async () => {
  await fx.page.navigate(`${site.url}/`);
  const a = await fx.page.snapshot();
  const addRef = refOf(a.text, /button "Ajouter en haut"/);
  await fx.page.click(addRef);
  const b = await fx.page.snapshot();
  assert.match(b.text, /button "Nouveau"/);
  for (const [ref, line] of a.entries) {
    if (ref === addRef) continue; // il a pris le focus
    assert.equal(b.entries.get(ref), line, `la ref ${ref} a changé`);
  }
});

// ---------- Phase 3 : actions + diff ----------

test('fill/select/check/click via les 3 formes de sélecteur, vérifié par le contenu de la page', async () => {
  await fx.page.navigate(`${site.url}/`);
  const s = await fx.page.snapshot();
  const nom = refOf(s.text, /textbox "Nom"/);

  const r1 = await fx.page.fill(nom, 'Ada Lovelace', { snapDiff: true });
  assert.match(r1.diff ?? '', /^~ e[0-9a-z]+:textbox "Nom"="Ada Lovelace"/);
  assert.equal(r1.diff?.split('\n').length, 1, `diff attendu sur une seule ligne :\n${r1.diff}`);
  await fx.page.fill('#email', 'ada@example.org');
  await fx.page.fill('text:Ville', 'Antananarivo');
  await fx.page.select('text:Pays', 'Madagascar');
  const r2 = await fx.page.check('text:J\'accepte les conditions', true, { snapDiff: true });
  assert.match(r2.diff ?? '', /checkbox "J'accepte les conditions" \[x\]/);

  const r3 = await fx.page.click('text:Valider', { snapDiff: true });
  assert.match(r3.diff ?? '', /^navigation → http:\/\/127\.0\.0\.1:\d+\/submit\?/);

  // Une action qui réussit ne prouve que l'émission de l'événement : on lit la page.
  const text = await fx.page.text();
  assert.match(text, /Nom : Ada Lovelace/);
  assert.match(text, /Email : ada@example\.org/);
  assert.match(text, /Ville : Antananarivo/);
  assert.match(text, /Pays : mg/);
  assert.match(text, /CGU : oui/);
});

test('press : Entrée dans un champ soumet le formulaire', async () => {
  await fx.page.navigate(`${site.url}/`);
  await fx.page.fill('#nom', 'Grace');
  await fx.page.press('Enter', '#nom');
  assert.match(await fx.page.text(), /Nom : Grace/);
});

test('fill remplace la valeur existante ; fill "" vide le champ', async () => {
  await fx.page.navigate(`${site.url}/`);
  await fx.page.fill('#ville', 'Paris');
  await fx.page.fill('#ville', 'Lyon');
  assert.match((await fx.page.snapshot()).text, /textbox "Ville"="Lyon"/);
  await fx.page.fill('#ville', '');
  assert.match((await fx.page.snapshot()).text, /textbox "Ville"(?!=)/);
});

test('erreurs explicites : ref inconnue, texte absent, CSS absent, option absente, mauvais type', async () => {
  await fx.page.navigate(`${site.url}/`);
  await assert.rejects(fx.page.click('ezzzz'), (e: GraspError) => e.status === 404 && /snap/.test(e.message));
  await assert.rejects(fx.page.click('text:Introuvable'), (e: GraspError) => e.status === 404);
  await assert.rejects(fx.page.click('#absent'), (e: GraspError) => e.status === 404);
  await assert.rejects(fx.page.select('#pays', 'Japon'), (e: GraspError) => e.status === 400 && /Madagascar/.test(e.message));
  await assert.rejects(fx.page.fill('text:Valider', 'x'), (e: GraspError) => e.status === 400);
  await assert.rejects(fx.page.click('#nom >>> ??'), (e: GraspError) => e.status === 400);
});

test('text: ambigu → 409 avec les refs candidates', async () => {
  await fx.page.navigate(`${site.url}/`);
  await fx.page.click('text:Ajouter en haut');
  await fx.page.click('text:Ajouter en haut');
  await assert.rejects(fx.page.click('text:Nouveau'), (e: GraspError) => e.status === 409 && /e[0-9a-z]+.*e[0-9a-z]+/.test(e.message));
});
