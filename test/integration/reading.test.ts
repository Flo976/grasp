import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openPage, type PageFixture } from '../helpers/chrome.js';
import { startTestSite, type TestSite } from '../helpers/testsite.js';
import { GraspError } from '../../src/core/errors.js';
import { TRUNC_RE } from '../../src/core/limits.js';

/**
 * Priorités P0 du banc comparatif : limites de taille et --scope, attente de stabilité (nav, --snap-diff,
 * wait), refs résilientes, élagage annoncé. Contre un vrai Chrome et le site de test local.
 */

let site: TestSite;
let fx: PageFixture;
before(async () => { site = await startTestSite(); fx = await openPage(); });
after(async () => { await fx.close(); await site.close(); });

const refOf = (snap: string, re: RegExp, nth = 0): string => {
  const lines = snap.split('\n').filter((l) => re.test(l));
  assert.ok(lines[nth], `aucune ligne n°${nth} ${re} dans :\n${snap}`);
  return lines[nth]!.trim().split(':')[0]!;
};
const lastLine = (s: string) => s.split('\n').pop()!;

// ---------- 1. Limites de taille et --scope ----------

test('text : 4000 caractères par défaut, dernière ligne « … tronqué : N caractères restants », --max pour tout lire', async () => {
  await fx.page.navigate(`${site.url}/long`);
  const t = await fx.page.text();
  assert.match(lastLine(t), TRUNC_RE);
  const kept = t.split('\n').slice(0, -1).join('\n');
  assert.ok(kept.length <= 4000, `${kept.length} caractères gardés`);
  const all = await fx.page.text(100_000);
  assert.doesNotMatch(all, /tronqué/);
  assert.match(all, /Paragraphe n° 199/);
  assert.equal(Number(/(\d+) caractères restants/.exec(lastLine(t))![1]), all.length - kept.length, 'reste annoncé exact');
});

test('text --scope : seulement la zone (CSS, puis ref)', async () => {
  await fx.page.navigate(`${site.url}/long`);
  const z = await fx.page.text(undefined, '#zone');
  assert.match(z, /Zone ciblée/);
  assert.match(z, /Texte de la zone/);
  assert.doesNotMatch(z, /Paragraphe/);
  const snap = await fx.page.snapshot({ scope: '#zone' });
  const region = refOf(snap.text, /region "Zone"/);
  assert.equal(await fx.page.text(undefined, region), z);
  await assert.rejects(fx.page.text(undefined, '#absent'), (e: GraspError) => e.status === 404);
});

test('snap : budget par défaut ramené à 12000 octets, troncature explicite ; --scope lit une zone hors budget', async () => {
  await fx.page.navigate(`${site.url}/big`);
  const s = await fx.page.snapshot();
  assert.ok(Buffer.byteLength(s.text) <= 12_000, `${Buffer.byteLength(s.text)} octets`);
  assert.match(lastLine(s.text), /^… tronqué : \d+ caractères restants \(\d+ nœuds omis\) — affinez avec --max N \/ --scope <ref\|css>$/);
  await fx.page.navigate(`${site.url}/long`);
  const full = await fx.page.snapshot();
  assert.doesNotMatch(full.text, /Dans la zone/, 'la zone est au-delà du budget');
  const z = await fx.page.snapshot({ scope: '#zone' });
  assert.match(z.text, /^page "Long" /);
  assert.match(z.text, /button "Dans la zone"/);
  assert.doesNotMatch(z.text, /Paragraphe|Ajouter 300/);
  // La ref vue dans la zone est utilisable telle quelle (même ref que dans le snapshot complet).
  const btn = refOf(z.text, /button "Dans la zone"/);
  assert.ok(full.refs.has(btn));
  await fx.page.click(btn);
  await assert.rejects(fx.page.snapshot({ scope: '#absent' }), (e: GraspError) => e.status === 404);
});

test('--snap-diff : 4000 caractères par défaut avec dernière ligne explicite ; --max l\'élargit ; --scope le restreint', async () => {
  await fx.page.navigate(`${site.url}/long`);
  const r = await fx.page.click('#ajout300', { snapDiff: true });
  assert.match(lastLine(r.diff!), TRUNC_RE);
  assert.ok(r.diff!.split('\n').slice(0, -1).join('\n').length <= 4000);
  await fx.page.navigate(`${site.url}/long`);
  const big = await fx.page.click('#ajout300', { snapDiff: true, max: 100_000 });
  assert.doesNotMatch(big.diff!, /tronqué/);
  assert.match(big.diff!, /button "Article ajouté 299"/);
  await fx.page.navigate(`${site.url}/long`);
  const scoped = await fx.page.click('#ajout300', { snapDiff: true, scope: '#zone' });
  assert.equal(scoped.diff, '(aucun changement)');
});

// ---------- 2. Attente de stabilité ----------

test('nav attend le rendu : titre et contenu posés après le load sont là (pas de snapshot vide)', async () => {
  const t0 = Date.now();
  const r = await fx.page.nav(`${site.url}/spa`);
  const ms = Date.now() - t0;
  assert.equal(r.title, 'Application');
  assert.equal(r.detail, undefined, 'page stable : aucune note');
  assert.ok(ms >= 600 && ms < 3000, `rendu final à load + 600 ms, puis 400 ms de calme : ${ms} ms`);
  const s = await fx.page.snapshot();
  assert.match(s.text, /heading\[1\] "Contenu chargé"/);
  assert.doesNotMatch(s.text, /Chargement/);
});

test('--snap-diff attend la fin de la transition : pas d\'état intermédiaire, refs aussitôt utilisables', async () => {
  await fx.page.navigate(`${site.url}/tardif`);
  const r = await fx.page.click('#transition', { snapDiff: true });
  assert.match(r.diff!, /^\+ e[0-9a-z]+:heading\[2\] "Résultat final"$/m);
  assert.doesNotMatch(r.diff!, /Chargement|Étape 1/);
  const confirm = refOf(r.diff!, /button "Confirmer la réservation"/).replace(/^\+ /, '');
  await fx.page.click(confirm);
  assert.equal((await fx.page.location()).title, 'Confirmé');
});

test('action qui change de route (pushState, même document) : le rendu de la nouvelle vue est attendu', async () => {
  await fx.page.navigate(`${site.url}/tardif`);
  await fx.page.click('#route');
  assert.match((await fx.page.snapshot()).text, /heading\[2\] "Vue routée"/);
});

test('DOM qui ne se stabilise jamais : nav rend la main au plafond, avec une note', async () => {
  const quick = await openPage(undefined, { stableTimeoutMs: 1200 });
  try {
    const t0 = Date.now();
    const r = await quick.page.nav(`${site.url}/agite`);
    const ms = Date.now() - t0;
    assert.ok(ms >= 1100 && ms < 5000, `${ms} ms`);
    assert.match(r.detail ?? '', /DOM encore instable après \d+ ms/);
    assert.equal(r.title, 'Agitée');
  } finally { await quick.close(); }
});

test('wait : --text, --sel (visible), --idle ; délai dépassé = 504 explicite ; une seule condition', async () => {
  await fx.page.navigate(`${site.url}/tardif`);
  await fx.page.click('#charger');
  const w = await fx.page.wait({ text: 'Résultat prêt', timeout: 5000 });
  assert.ok(w.waited >= 300, `attendu ${w.waited} ms`);
  assert.match(await fx.page.text(), /Résultat prêt/);
  await fx.page.navigate(`${site.url}/tardif`);
  await fx.page.click('#charger');
  await fx.page.wait({ sel: '#resultat', timeout: 5000 });
  await fx.page.wait({ sel: 'text:Résultat prêt', timeout: 1000 });
  const idle = await fx.page.wait({ idle: true });
  assert.ok(idle.waited >= 350 && idle.waited < 3000, `idle ${idle.waited} ms`);
  await assert.rejects(fx.page.wait({ text: 'Jamais affiché', timeout: 400 }), (e: GraspError) => e.status === 504 && /Jamais affiché/.test(e.message));
  await assert.rejects(fx.page.wait({ sel: '#cache', timeout: 300 }), (e: GraspError) => e.status === 504 && /invisible/.test(e.message));
  await assert.rejects(fx.page.wait({ text: 'a', sel: '#b' }), (e: GraspError) => e.status === 400);
  await assert.rejects(fx.page.wait({ sel: '#x >>> ??' }), (e: GraspError) => e.status === 400);
  await fx.page.navigate(`${site.url}/agite`);
  await assert.rejects(fx.page.wait({ idle: true, timeout: 600 }), (e: GraspError) => e.status === 504 && /instable/.test(e.message));
});

test('wait --text survit à une navigation pendant l\'attente', async () => {
  await fx.page.navigate(`${site.url}/tardif`);
  const w = fx.page.wait({ text: 'Contenu chargé', timeout: 8000 });
  await new Promise((r) => setTimeout(r, 150));
  await fx.page.navigate(`${site.url}/spa`);
  await w;
});

// ---------- 3. Refs résilientes ----------

test('ref disparue après un re-rendu : retrouvée par (rôle, nom) quand c\'est sans ambiguïté', async () => {
  await fx.page.navigate(`${site.url}/refs?n=2`);
  const s = await fx.page.snapshot();
  const alpha = refOf(s.text, /button "Supprimer"/, 0);
  const beta = refOf(s.text, /button "Supprimer"/, 1);
  await fx.page.click(alpha);
  const r = await fx.page.click(beta); // le rang de Beta parmi les homonymes a changé : la ref n'existe plus
  assert.match(r.detail ?? '', new RegExp(`ref ${beta} retrouvée → e[0-9a-z]+ \\(button "Supprimer"\\)`));
  assert.match(await fx.page.text(), /supprimé : Beta/);
});

test('ref disparue et ambiguë : 409 avec les candidats (ref, rôle, nom), pas de clic arbitraire', async () => {
  await fx.page.navigate(`${site.url}/refs?n=3`);
  const s = await fx.page.snapshot();
  const gamma = refOf(s.text, /button "Supprimer"/, 2);
  await fx.page.click(refOf(s.text, /button "Supprimer"/, 0));
  await assert.rejects(fx.page.click(gamma), (e: GraspError) => {
    assert.equal(e.status, 409, e.message);
    assert.match(e.message, /e[0-9a-z]+ button "Supprimer".*e[0-9a-z]+ button "Supprimer"/);
    assert.equal((e.extra?.candidates as unknown[]).length, 2);
    return true;
  });
  assert.match(await fx.page.text(), /supprimé : Alpha/, 'aucun autre clic n\'a eu lieu');
});

test('ref introuvable (nom changé) : 404 avec les 3 candidats les plus proches, au lieu de « refaites snap »', async () => {
  await fx.page.navigate(`${site.url}/refs?n=1`);
  const panier = refOf((await fx.page.snapshot()).text, /button "Panier \(1\)"/);
  await fx.page.click(panier);
  await assert.rejects(fx.page.click(panier), (e: GraspError) => {
    assert.equal(e.status, 404, e.message);
    assert.match(e.message, /candidats les plus proches : e[0-9a-z]+ button "Panier \(2\)"/);
    const c = e.extra?.candidates as Array<{ ref: string; role: string; name: string }>;
    assert.ok(c.length >= 1 && c.length <= 3);
    assert.deepEqual([c[0]!.role, c[0]!.name], ['button', 'Panier (2)']);
    return true;
  });
});

test('re-rendu complet (nouveaux nœuds DOM, mêmes rôles et noms) : la ref reste valide', async () => {
  await fx.page.navigate(`${site.url}/refs?n=3`);
  const beta = refOf((await fx.page.snapshot()).text, /button "Supprimer"/, 1);
  await fx.page.click('#rerendre');
  await fx.page.click(beta);
  assert.match(await fx.page.text(), /supprimé : Beta/);
});

test('text: introuvable : les noms proches sont proposés', async () => {
  await fx.page.navigate(`${site.url}/`);
  await assert.rejects(fx.page.click('text:Valdier'), (e: GraspError) => e.status === 404 && /noms proches : .*button "Valider"/.test(e.message));
});

// ---------- 4. Élagage annoncé ----------

test('snap : dernière ligne de résumé des nœuds masqués (liens sans nom, iframes non parcourues)', async () => {
  await fx.page.navigate(`${site.url}/elague`);
  const s = await fx.page.snapshot();
  assert.match(lastLine(s.text), /^… élagué : 3 liens sans nom .*, 2 iframes non parcourues$/);
  assert.doesNotMatch(s.text, /contenu interne/);
  assert.equal(s.text.split('\n').filter((l) => /:link\b/.test(l)).length, 1, s.text);
});
