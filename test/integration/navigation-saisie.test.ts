import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { openPage, type PageFixture } from '../helpers/chrome.js';
import { startTestSite, type TestSite } from '../helpers/testsite.js';
import { makeTestEnv, type TestEnv } from '../helpers/env.js';
import { startServer, runCli, waitExit, type Server } from '../helpers/server.js';
import { resolvePaths } from '../../src/core/paths.js';

/**
 * Navigation, attente de stabilité, diff et saisie : défauts relevés sur Booking (challenge anti-bot),
 * Leboncoin (recherche SPA), formulaires à enregistrement XHR, autocomplétions, éditeurs riches.
 */
let site: TestSite;
let fx: PageFixture;
before(async () => { site = await startTestSite(); fx = await openPage({ allowedDomains: ['127.0.0.1'], allowEval: true }); });
after(async () => { await fx.close(); await site.close(); });

// ---------- 1. Challenge anti-bot qui se remplace lui-même ----------

test('nav : challenge qui vérifie par le réseau puis fait location.replace → la vraie page est attendue', async () => {
  const r = await fx.page.nav(`${site.url}/challenge-reseau`);
  assert.match(r.url, /\/challenge-ok$/, `URL finale : ${r.url}`);
  assert.equal(r.title, 'Hôtels à Paris');
  assert.match((await fx.page.snapshot()).text, /heading\[1\] "Résultats de recherche"/);
});

test('nav : challenge à minuterie (aucune requête, 1,5 s puis location.replace) → la vraie page est attendue, dans le plafond', async () => {
  const t0 = Date.now();
  const r = await fx.page.nav(`${site.url}/challenge-minuterie`);
  const ms = Date.now() - t0;
  assert.match(r.url, /\/challenge-ok$/, `URL finale : ${r.url}`);
  assert.match((await fx.page.snapshot()).text, /Résultats de recherche/);
  assert.ok(ms < 5500, `plafond respecté : ${ms} ms`);
});

test('nav : page ordinaire sans activité → pas d\'attente supplémentaire', async () => {
  const t0 = Date.now();
  await fx.page.nav(`${site.url}/challenge-ok`);
  const ms = Date.now() - t0;
  assert.ok(ms < 1500, `${ms} ms`);
});

// ---------- 2. Recherche SPA : pushState + chargement asynchrone ----------

test('press Enter dans une recherche SPA : pushState + requête → la main est rendue après les résultats', async () => {
  await fx.page.navigate(`${site.url}/spa-recherche`);
  await fx.page.fill('#q', 'rouge');
  await fx.page.press('Enter', '#q');
  const snap = await fx.page.snapshot();
  assert.match(snap.text, /Annonces trouvées/, snap.text);
  assert.match(snap.url, /\?q=rouge$/);
});

test('wait --idle : activité réseau lancée 150 ms après → attendue (réseau ET DOM), pas de conclusion prématurée', async () => {
  await fx.page.navigate(`${site.url}/spa-recherche`);
  await fx.page.evaluate("document.getElementById('differe').click()");
  const w = await fx.page.wait({ idle: true });
  assert.match(await fx.page.text(), /Différé chargé/);
  assert.ok(w.waited >= 700, `attendu ${w.waited} ms`);
});

// ---------- 3. --snap-diff après XHR / autocomplétion ----------

test('click --snap-diff sur « Enregistrer » (fetch 700 ms puis DOM) → le diff contient la confirmation', async () => {
  await fx.page.navigate(`${site.url}/enregistrer`);
  const r = await fx.page.click('#save', { snapDiff: true });
  assert.match(r.diff ?? '', /Profil enregistré/, r.diff);
});

test('type --snap-diff dans une autocomplétion (suggestions 250 ms + 500 ms après la frappe) → suggestions dans le diff', async () => {
  await fx.page.navigate(`${site.url}/enregistrer`);
  const r = await fx.page.type('#ville', 'Par', { snapDiff: true });
  assert.match(r.diff ?? '', /option "Paris"/, r.diff);
  assert.match(r.diff ?? '', /option "Parme"/, r.diff);
});

// ---------- 4. Titre relu au moment du snapshot ----------

test('snapshot : le titre est relu (navigation SPA, document.title modifié)', async () => {
  await fx.page.navigate(`${site.url}/spa-recherche`);
  await fx.page.fill('#q', 'bleu');
  await fx.page.press('Enter', '#q');
  assert.equal((await fx.page.snapshot()).title, 'Résultats : bleu');
  await fx.page.evaluate("document.title = 'Titre changé'");
  assert.equal((await fx.page.snapshot()).title, 'Titre changé');
  assert.equal((await fx.page.location()).title, 'Titre changé');
});

// ---------- 5. Diff d'une navigation same-document vs nouvelle page ----------

test('click --snap-diff sur un lien routé (pushState) → diff, pas un snapshot complet', async () => {
  await fx.page.navigate(`${site.url}/spa-recherche`);
  const r = await fx.page.click('#annonces', { snapDiff: true });
  const d = r.diff ?? '';
  assert.doesNotMatch(d, /snapshot complet/, d);
  assert.match(d, /^~ url http:\/\/127\.0\.0\.1:\d+\/spa-recherche\/annonces$/m, d);
  assert.match(d, /^\+ e[0-9a-z]+:heading\[2\] "Liste des annonces"$/m, d);
  assert.match(d, /^~ title "Annonces"$/m, d);
  assert.doesNotMatch(d, /textbox "Rechercher"/, 'les nœuds inchangés ne sont pas répétés');
});

test('click --snap-diff qui change de document → snapshot complet, annoncé', async () => {
  await fx.page.navigate(`${site.url}/spa-recherche`);
  await fx.page.evaluate("document.getElementById('annonces').replaceWith(Object.assign(document.createElement('a'), { id: 'vrai', href: '/challenge-ok', textContent: 'Vrai lien' }))");
  const r = await fx.page.click('#vrai', { snapDiff: true });
  assert.match(r.diff ?? '', /^navigation → http:\/\/127\.0\.0\.1:\d+\/challenge-ok \(nouvelle page : snapshot complet\)\n/, r.diff);
  assert.match(r.diff ?? '', /Résultats de recherche/);
});

// ---------- 6. fill sur un éditeur riche contenteditable ----------

test('fill sur un contenteditable riche : texte brut, paragraphes, aucun format de bloc hérité, pas d\'exception', async () => {
  await fx.page.navigate(`${site.url}/editeur-riche`);
  const r = await fx.page.fill('#ed', 'Première ligne\nDeuxième ligne');
  assert.ok(r.ok);
  const html = await fx.page.evaluate("document.getElementById('ed').innerHTML") as string;
  assert.doesNotMatch(html, /<h1|<li|<ul/i, `format hérité : ${html}`);
  assert.doesNotMatch(html, /Ancien/, html);
  const lines = (await fx.page.evaluate("document.getElementById('ed').innerText") as string).split('\n').filter((l) => l.trim() !== '');
  assert.deepEqual(lines, ['Première ligne', 'Deuxième ligne']);
  const blocks = await fx.page.evaluate("[...document.getElementById('ed').children].filter((c) => c.textContent.trim() !== '').length") as number;
  assert.equal(blocks, 2, `deux paragraphes attendus : ${html}`);
});

test('fill sur un contenteditable : une seule ligne, puis vidage', async () => {
  await fx.page.navigate(`${site.url}/editeur-riche`);
  await fx.page.fill('#ed', 'Texte simple');
  assert.equal((await fx.page.evaluate("document.getElementById('ed').innerText") as string).trim(), 'Texte simple');
  await fx.page.fill('#ed', '');
  assert.equal((await fx.page.evaluate("document.getElementById('ed').innerText") as string).trim(), '');
});

test('fill sur un contenteditable : espaces doubles (rendus en insécables) → pas de « TypeError: Illegal invocation »', async () => {
  await fx.page.navigate(`${site.url}/editeur-riche`);
  const r = await fx.page.fill('#ed', 'Deux  espaces\nfin');
  assert.ok(r.ok);
  // Texte rendu : espaces repliés ou insécables selon le navigateur ; on compare au rendu.
  const lines = (await fx.page.evaluate("document.getElementById('ed').innerText") as string).split('\n').map((l) => l.replace(/[  ]+/g, ' ').trim()).filter((l) => l !== '');
  assert.deepEqual(lines, ['Deux espaces', 'fin']);
});

// ---------- 7. Onglet en arrière-plan (document.visibilityState = hidden) ----------

test('onglet en arrière-plan : action native → onglet ramené au premier plan, annoncé, rendu (rAF) observé dans le diff', async () => {
  const f = await openPage({ allowedDomains: ['127.0.0.1'], allowEval: true });
  try {
    await f.page.navigate(`${site.url}/arriere-plan`);
    await f.cdp.send('Target.createTarget', { url: 'about:blank' });
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(await f.page.evaluate('document.visibilityState'), 'hidden', 'précondition : onglet en arrière-plan');
    const r = await f.page.click('#raf', { snapDiff: true });
    assert.match(r.detail ?? '', /arrière-plan.*premier plan/, r.detail);
    assert.match(r.diff ?? '', /Rendu fait/, r.diff);
    assert.equal(await f.page.evaluate('document.visibilityState'), 'visible');
  } finally { await f.close(); }
});

// ---------- CLI ----------

describeCli();

function describeCli(): void {
  let t: TestEnv;
  let srv: Server;
  let env: NodeJS.ProcessEnv;
  before(async () => {
    t = makeTestEnv();
    const paths = resolvePaths(t.env, t.env.HOME);
    mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
    writeFileSync(paths.configFile, JSON.stringify({ allowedDomains: ['127.0.0.1'] }), { mode: 0o600 });
    srv = await startServer(t.env);
    const id = (await runCli(t.env, ['session', 'create'])).stdout.trim();
    env = { ...t.env, GRASP_SESSION: id };
  });
  after(async () => { srv.proc.kill('SIGTERM'); await waitExit(srv.proc); t.cleanup(); });

  test('CLI press Enter --snap-diff dans une recherche SPA → diff des résultats (pas de snapshot complet)', async () => {
    assert.equal((await runCli(env, ['nav', `${site.url}/spa-recherche`])).code, 0);
    assert.equal((await runCli(env, ['fill', '#q', 'vert'])).code, 0);
    const r = await runCli(env, ['press', 'Enter', '#q', '--snap-diff']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^~ url .*\?q=vert$/m, r.stdout);
    assert.match(r.stdout, /Annonces trouvées/, r.stdout);
    assert.match(r.stdout, /^~ title "Résultats : vert"$/m, r.stdout);
  });
}
