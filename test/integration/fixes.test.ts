import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { openPage, type PageFixture } from '../helpers/chrome.js';
import { startTestSite, type TestSite } from '../helpers/testsite.js';
import { decodePng } from '../helpers/png.js';
import { makeTestEnv, type TestEnv } from '../helpers/env.js';
import { startServer, runCli, waitExit, type Server } from '../helpers/server.js';
import { resolvePaths } from '../../src/core/paths.js';
import { GraspError } from '../../src/core/errors.js';

/** Correctifs issus du banc sur de vrais sites (Wikipédia, Booking…), reproduits sur le site de test local. */
let site: TestSite;
let fx: PageFixture;
before(async () => { site = await startTestSite(); fx = await openPage({ allowedDomains: ['127.0.0.1', 'localhost'] }); });
after(async () => { await fx.close(); await site.close(); });

const near = (c: [number, number, number], rgb: [number, number, number], tol = 40) => c.every((v, i) => Math.abs(v - rgb[i]!) <= tol);

test('screenshot --el : le bord gauche d\'un élément flottant plus haut que le viewport n\'est pas rogné', async () => {
  await fx.page.navigate(`${site.url}/flottant`);
  const s = await fx.page.capture({ el: '#info' });
  const px = decodePng(s.data);
  // 306 px de large (6 de bordure + 300) ; positions fractionnaires : 1 px de tolérance de chaque côté.
  assert.ok(px.width >= 306 && px.width <= 308, `largeur ${px.width}`);
  for (const y of [5, Math.floor(px.height / 2), px.height - 5]) {
    const first = [0, 1].map((x) => px.at(x, y));
    assert.ok(first.some((c) => near(c, [0, 0, 0])), `bord gauche noir attendu en y=${y}, reçu ${first.map((c) => c.join(',')).join(' | ')}`);
    assert.ok(near(px.at(10, y), [255, 0, 0]), `rouge attendu en (10,${y}), reçu ${px.at(10, y)}`);
    assert.ok(near(px.at(px.width - 3, y), [255, 0, 0]), `bord droit rouge attendu, reçu ${px.at(px.width - 3, y)}`);
  }
});

test('screenshot --el : élément dans le viewport à position fractionnaire — boîte entière (floor de x, ceil du bord droit)', async () => {
  await fx.page.navigate(`${site.url}/flottant`);
  const px = decodePng((await fx.page.capture({ el: '#petit' })).data);
  // left 20.6 → x = 20 ; bord droit 20.6 + 2 + 100.5 = 123.1 → 124 : 104 px, bordure noire en tête.
  assert.equal(px.width, 104, `largeur ${px.width}`);
  assert.ok(near(px.at(1, 20), [0, 0, 0]) || near(px.at(0, 20), [0, 0, 0]), `bordure gauche attendue : ${px.at(0, 20)} ${px.at(1, 20)}`);
  assert.ok(near(px.at(px.width - 2, 20), [255, 0, 0], 80), `bord droit : ${px.at(px.width - 2, 20)}`);
});

test('text --scope sur une iframe : même origine → son texte ; autre origine → message explicite ; zone vide → chaîne vide', async () => {
  await fx.page.navigate(`${site.url}/cadres`);
  await fx.page.wait({ sel: '#autre' });
  assert.match(await fx.page.text(undefined, '#meme'), /Contenu du cadre/);
  await assert.rejects(fx.page.text(undefined, '#autre'), (e: GraspError) => {
    assert.equal(e.status, 409);
    assert.match(e.message, /iframe/);
    assert.match(e.message, /autre origine/);
    assert.match(e.message, /localhost/, 'l\'URL du cadre est indiquée pour y naviguer');
    return true;
  });
  assert.equal(await fx.page.text(undefined, '#vide'), '');
});

describeCli();

function describeCli(): void {
  let t: TestEnv;
  let srv: Server;
  let env: NodeJS.ProcessEnv;
  before(async () => {
    t = makeTestEnv();
    const paths = resolvePaths(t.env, t.env.HOME);
    mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
    writeFileSync(paths.configFile, JSON.stringify({ allowEval: true, allowedDomains: ['127.0.0.1', 'localhost'] }), { mode: 0o600 });
    srv = await startServer(t.env);
    const id = (await runCli(t.env, ['session', 'create'])).stdout.trim();
    env = { ...t.env, GRASP_SESSION: id };
  });
  after(async () => { srv.proc.kill('SIGTERM'); await waitExit(srv.proc); t.cleanup(); });

  test('CLI eval : une expression qui renvoie undefined (el.click(), form.submit()) → « undefined », exécutée, code 0', async () => {
    assert.equal((await runCli(env, ['nav', `${site.url}/sonde`])).code, 0);
    const r = await runCli(env, ['eval', "document.getElementById('compter').click()"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, 'undefined\n');
    assert.equal(r.stderr, '');
    assert.equal(JSON.parse((await runCli(env, ['eval', "document.getElementById('compte').textContent"])).stdout), 'Compte : 1', 'l\'expression a bien été exécutée');
    const j = await runCli(env, ['eval', 'void 0', '--json']);
    assert.deepEqual(JSON.parse(j.stdout), { ok: true, type: 'undefined' });
    // Les autres valeurs ne changent pas : JSON.
    assert.equal((await runCli(env, ['eval', '1+1'])).stdout, '2\n');
    assert.equal((await runCli(env, ['eval', 'null'])).stdout, 'null\n');
    assert.equal((await runCli(env, ['eval', '({a: [1]})'])).stdout, '{"a":[1]}\n');
  });

  test('CLI text --scope <iframe> : jamais de sortie vide muette', async () => {
    assert.equal((await runCli(env, ['nav', `${site.url}/cadres`])).code, 0);
    assert.equal((await runCli(env, ['wait', '--sel', '#autre'])).code, 0);
    const autre = await runCli(env, ['text', '--scope', '#autre']);
    assert.equal(autre.code, 1);
    assert.match(autre.stderr, /^ERROR: text: .*iframe.*autre origine/m);
    const vide = await runCli(env, ['text', '--scope', '#vide']);
    assert.equal(vide.code, 0, vide.stderr);
    assert.equal(vide.stdout, '');
    assert.match(vide.stderr, /aucun texte visible dans la zone #vide/);
  });
}
