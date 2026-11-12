import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openPage, type PageFixture } from '../helpers/chrome.js';
import { startTestSite, type TestSite } from '../helpers/testsite.js';
import type { GraspError } from '../../src/core/errors.js';

/**
 * Dialogues pilotables (--dialog) : la réponse donnée est vérifiée par le CONTENU de la page (article supprimé,
 * nom saisi, page quittée ou non), et le dialogue vu est toujours rapporté (note, dialogs, --snap-diff).
 */

let site: TestSite;
let fx: PageFixture;
before(async () => { site = await startTestSite(); fx = await openPage(); });
after(async () => { await fx.close(); await site.close(); });

const liste = () => fx.page.text(undefined, '#liste');

test('défaut inchangé : confirm() REFUSÉ, rien n\'est supprimé, et le refus est rapporté avec le moyen de répondre', async () => {
  await fx.page.navigate(`${site.url}/dialogues`);
  const r = await fx.page.click('#sup-a');
  assert.match(await liste(), /Article A/, 'article toujours là');
  assert.match(r.detail ?? '', /dialogue confirm « Supprimer « Article A » \? » → refusé \(défaut sûr — --dialog accept pour répondre\)/, r.detail);
  assert.deepEqual(r.dialogs, [{ type: 'confirm', message: 'Supprimer « Article A » ?', accepted: false, byDefault: true }]);
});

test('--dialog accept : suppression effective (vérifiée par le contenu), dialogue rapporté dans la note et en tête du --snap-diff', async () => {
  await fx.page.navigate(`${site.url}/dialogues`);
  const r = await fx.page.click('#sup-a', { dialog: 'accept', snapDiff: true });
  const l = await liste();
  assert.doesNotMatch(l, /Article A/, l);
  assert.match(l, /Article B/, 'un seul article supprimé');
  assert.match(r.diff ?? '', /^! dialogue confirm « Supprimer « Article A » \? » → accepté\n/, r.diff);
  assert.match(r.diff ?? '', /^- .*Supprimer A/m, 'le diff montre la disparition');
  assert.match(r.detail ?? '', /dialogue confirm .* → accepté/);
  assert.deepEqual(r.dialogs, [{ type: 'confirm', message: 'Supprimer « Article A » ?', accepted: true }]);
  // L'option ne vaut que pour SON action : le clic suivant, sans option, retrouve le défaut sûr.
  const r2 = await fx.page.click('#sup-b');
  assert.match(await liste(), /Article B/, 'défaut sûr rétabli après l\'action');
  assert.match(r2.detail ?? '', /→ refusé/);
});

test('--dialog dismiss : confirm refusé, explicitement (sans conseil)', async () => {
  await fx.page.navigate(`${site.url}/dialogues`);
  const r = await fx.page.click('#sup-a', { dialog: 'dismiss' });
  assert.match(await liste(), /Article A/);
  assert.match(r.detail ?? '', /dialogue confirm « .* » → refusé(?! \(défaut)/, r.detail);
});

test('prompt : défaut refusé, texte donné, accept = valeur par défaut, text:accept = le mot « accept »', async () => {
  await fx.page.navigate(`${site.url}/dialogues`);
  const nom = () => fx.page.text(undefined, '#nom');
  const d = await fx.page.click('#renommer');
  assert.equal(await nom(), 'Nom : (annulé)');
  assert.match(d.detail ?? '', /dialogue prompt « Nouveau nom \? » → refusé \(défaut sûr — --dialog accept ou --dialog "texte" pour répondre\)/, d.detail);
  const t = await fx.page.click('#renommer', { dialog: 'Facture 2026', snapDiff: true });
  assert.equal(await nom(), 'Nom : Facture 2026');
  assert.match(t.diff ?? '', /^! dialogue prompt « Nouveau nom \? » → accepté avec « Facture 2026 »$/m, t.diff);
  assert.deepEqual(t.dialogs, [{ type: 'prompt', message: 'Nouveau nom ?', accepted: true, promptText: 'Facture 2026' }]);
  await fx.page.click('#renommer', { dialog: 'accept' });
  assert.equal(await nom(), 'Nom : Sans titre', 'accept : valeur proposée par la page');
  await fx.page.click('#renommer', { dialog: 'text:accept' });
  assert.equal(await nom(), 'Nom : accept');
  await fx.page.click('#renommer', { dialog: '' });
  assert.equal(await nom(), 'Nom :', 'texte vide : prompt accepté vide (text() rogne l\'espace final)');
});

test('alert : fermé (un seul bouton), quelle que soit l\'option, et rapporté', async () => {
  await fx.page.navigate(`${site.url}/dialogues`);
  const r = await fx.page.click('#info', { dialog: 'dismiss' });
  assert.equal(await fx.page.text(undefined, '#etat'), 'Alerte vue');
  assert.match(r.detail ?? '', /dialogue alert « Enregistré » → fermé/);
});

test('beforeunload : défaut accepté (nav quitte la page) ; --dialog dismiss : la page reste, la note le dit', async () => {
  await fx.page.navigate(`${site.url}/dialogues`);
  await fx.page.click('#modifier'); // arme la garde (activation de l'utilisateur exigée par Chrome)
  const n = await fx.page.nav(`${site.url}/dialogues-fin`);
  assert.equal(n.title, 'Fin');
  assert.match(n.detail ?? '', /dialogue beforeunload → accepté \(la page est quittée\)/, n.detail);

  await fx.page.navigate(`${site.url}/dialogues`);
  await fx.page.click('#modifier');
  const t0 = Date.now();
  const c = await fx.page.click('text:Quitter', { dialog: 'dismiss' });
  assert.ok(Date.now() - t0 < 15_000, `${Date.now() - t0} ms`);
  assert.equal((await fx.page.location()).title, 'Dialogues', 'page restée affichée');
  assert.equal(await fx.page.text(undefined, '#garde'), 'Modifications non enregistrées');
  assert.match(c.detail ?? '', /dialogue beforeunload → refusé \(la page reste affichée, navigation annulée\)/, c.detail);
  // Même garde, via nav --dialog dismiss : pas d'attente de 30 s d'un load qui ne viendra pas.
  const t1 = Date.now();
  const nd = await fx.page.nav(`${site.url}/dialogues-fin`, { dialog: 'dismiss' }).then((x) => ({ ok: true as const, x }), (e: GraspError) => ({ ok: false as const, e }));
  assert.ok(Date.now() - t1 < 15_000, `${Date.now() - t1} ms`);
  assert.equal((await fx.page.location()).title, 'Dialogues', 'nav annulée');
  // Page.navigate rend net::ERR_ABORTED : l'erreur de nav porte la raison (le dialogue refusé).
  assert.equal(nd.ok, false, 'nav annulée = échec de nav');
  if (!nd.ok) assert.match(nd.e.message, /navigation échouée : net::ERR_ABORTED ; dialogue beforeunload → refusé \(la page reste affichée, navigation annulée\)/, nd.e.message);
  // Puis on quitte vraiment (défaut : accepté), pour ne pas laisser la garde aux tests suivants.
  await fx.page.nav(`${site.url}/dialogues-fin`);
});

test('dialogue ouvert hors action (minuterie) : défaut sûr, rapporté à l\'action suivante et marqué comme tel', async () => {
  await fx.page.navigate(`${site.url}/dialogues`);
  const r = await fx.page.click('#plus-tard', { dialog: 'accept' });
  assert.equal(r.dialogs, undefined, 'rien encore');
  await new Promise((res) => setTimeout(res, 2500));
  assert.equal(await fx.page.text(undefined, '#tard'), 'Réponse tardive : false', 'hors action : --dialog ne s\'applique plus');
  const n = await fx.page.click('#info');
  assert.match(n.detail ?? '', /dialogue confirm « Plus tard \? » → refusé .*\[ouvert hors action, avant celle-ci\]/, n.detail);
  assert.match(n.detail ?? '', /dialogue alert « Enregistré » → fermé/);
  assert.equal(n.dialogs?.[0]?.outside, true);
});

test('--dialog "texte" sur un confirm (faute de frappe, intention de refus mal dite) : REFUSÉ, l\'article reste, la note dit pourquoi', async () => {
  for (const v of ['cancel', 'Dismiss', 'no']) {
    await fx.page.navigate(`${site.url}/dialogues`);
    const r = await fx.page.click('#sup-a', { dialog: v, snapDiff: true });
    assert.match(await liste(), /Article A/, `--dialog ${v} : article conservé`);
    assert.match(r.detail ?? '', /dialogue confirm « Supprimer « Article A » \? » → refusé \(--dialog "texte" ne vaut que pour un prompt — --dialog accept pour accepter\)/, r.detail);
    assert.match(r.diff ?? '', /^! dialogue confirm .* → refusé \(--dialog "texte"/, r.diff);
    assert.deepEqual(r.dialogs, [{ type: 'confirm', message: 'Supprimer « Article A » ?', accepted: false, textIgnored: true }]);
  }
  // Une option avalée comme valeur (--dialog --snap-diff) : 400, rien n'est fait.
  await assert.rejects(fx.page.click('#sup-a', { dialog: '--snap-diff' }), (e: GraspError) => e.status === 400 && /ressemble à une option/.test(e.message));
  assert.match(await liste(), /Article A/);
});

test('dialogue ouvert pendant le --snap-diff d\'après (fin d\'action) : rapporté par CETTE action, avec la réponse qu\'elle a donnée', async () => {
  await fx.page.navigate(`${site.url}/dialogues`);
  // Fenêtre déterministe : le snapshot d'après est précédé d'un clic dans la page qui ouvre un confirm.
  type Priv = { diffAfter: (...a: unknown[]) => Promise<string>; s: (m: string, p: object) => Promise<unknown> };
  const priv = fx.page as unknown as Priv;
  const orig = priv.diffAfter;
  priv.diffAfter = async function (this: Priv, ...a: unknown[]) {
    await this.s('Runtime.evaluate', { expression: "document.getElementById('sup-a').click()" });
    return orig.apply(this, a);
  };
  let r;
  try { r = await fx.page.click('#info', { dialog: 'accept', snapDiff: true }); } finally { delete (priv as Partial<Priv>).diffAfter; }
  assert.doesNotMatch(await liste(), /Article A/, 'confirm accepté (politique de l\'action)');
  assert.deepEqual(r.dialogs?.map((d) => `${d.type}:${d.accepted}`), ['alert:true', 'confirm:true'], JSON.stringify(r.dialogs));
  assert.match(r.diff ?? '', /^! dialogue confirm « Supprimer « Article A » \? » → accepté$/m, r.diff);
  const n = await fx.page.click('#info');
  assert.deepEqual(n.dialogs?.map((d) => d.type), ['alert'], 'rien de reporté à l\'action suivante');
});

test('--dialog invalide : 400, l\'action n\'a pas lieu', async () => {
  await fx.page.navigate(`${site.url}/dialogues`);
  await assert.rejects(fx.page.click('#sup-a', { dialog: 'x'.repeat(5000) }), (e: GraspError) => e.status === 400 && /4096 au plus/.test(e.message));
  await assert.rejects(fx.page.click('#sup-a', { dialog: 'a\u0001b' }), (e: GraspError) => e.status === 400);
  assert.match(await liste(), /Article A/);
});
