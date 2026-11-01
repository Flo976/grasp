import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { makeTestEnv } from '../helpers/env.js';
import { startServer, runCli, waitExit } from '../helpers/server.js';
import { needPlaywright } from '../helpers/playwright.js';
import { startTestSite } from '../helpers/testsite.js';
import { procsOnUserDataDir, waitUntil } from '../helpers/procs.js';
import { resolvePaths } from '../../src/core/paths.js';

/** Moteur Playwright de repli, de bout en bout : CLI → control plane → bridge → Chrome. */
const needPw = needPlaywright;

function configure(env: NodeJS.ProcessEnv, cfg: Record<string, unknown>): void {
  const paths = resolvePaths(env, env.HOME);
  mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
  writeFileSync(paths.configFile, JSON.stringify(cfg), { mode: 0o600 });
}

test('CLI : --engine playwright, lecture et action dans une iframe d\'une autre origine, run, doctor', { skip: needPw, timeout: 120_000 }, async () => {
  const t = makeTestEnv();
  const site = await startTestSite();
  configure(t.env, { allowedDomains: ['127.0.0.1', 'localhost'], fallbackEngine: 'playwright' });
  const srv = await startServer(t.env);
  try {
    assert.match(srv.stderr(), /repli des clics par Playwright activé \(playwright-core \d+\.\d+\.\d+\)/);
    const id = (await runCli(t.env, ['session', 'create'])).stdout.trim();
    const env = { ...t.env, GRASP_SESSION: id };
    assert.equal((await runCli(env, ['nav', `${site.url}/pw-cadres`])).code, 0);
    const c = await runCli(env, ['click', '#bas', '--engine', 'playwright']);
    assert.equal(c.code, 0, c.stderr);
    assert.equal(c.stdout, 'OK\n');
    assert.match(c.stderr, /note: moteur Playwright connecté en \d+ ms/);
    assert.equal((await runCli(env, ['text', '--scope', '#compte'])).stdout, 'Compte : 1\n');
    const tx = await runCli(env, ['text', '--scope', 'frame=#editeur']);
    assert.equal(tx.code, 0, tx.stderr);
    assert.match(tx.stdout, /Texte initial/);
    const sn = await runCli(env, ['snap', '--scope', 'frame=#editeur']);
    assert.match(sn.stdout, /^cadre frame=#editeur .*\n[\s\S]*button "Appliquer"/);
    const ran = await runCli(env, ['run'], `fill 'frame=#editeur >> #titre' Fosa
click 'frame=#editeur >> text:Appliquer'
text --scope 'frame=#editeur >> #etat'
hover #survol --engine playwright
type #ville Tana --delay 20
text --scope '#survol'
`);
    assert.equal(ran.code, 0, `${ran.stdout}\n${ran.stderr}`);
    assert.match(ran.stdout, /\[3\] text --scope 'frame=#editeur >> #etat' → OK\nAppliqué : Fosa\n/);
    assert.match(ran.stdout, /\[6\] text --scope '#survol' → OK\nSurvolé\n/);
    const bad = await runCli(env, ['click', '#bas', '--engine', 'turbo']);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /^ERROR: click: moteur inconnu « turbo » \(native, playwright\)$/m);
    const doc = await runCli(t.env, ['doctor']);
    assert.match(doc.stdout, /^ok\s+playwright\s+playwright-core \d+\.\d+\.\d+ : --engine playwright et frame= disponibles ; repli automatique des clics : playwright$/m);
    const help = await runCli(t.env, ['help']);
    assert.match(help.stdout, /--engine playwright/);
    assert.match(help.stdout, /frame=<css de l'iframe> >> <css\|text:…>/);
  } finally { srv.proc.kill('SIGTERM'); await waitExit(srv.proc); await site.close(); t.cleanup(); }
});

test('cycle de vie : après usage de Playwright, bascule de profil puis fermeture → aucun Chrome laissé, Playwright reconnecté au nouveau navigateur', { skip: needPw, timeout: 120_000 }, async () => {
  const t = makeTestEnv();
  const site = await startTestSite();
  configure(t.env, { allowedDomains: ['127.0.0.1', 'localhost'] });
  const srv = await startServer(t.env);
  try {
    assert.equal((await runCli(t.env, ['profiles', 'create', 'a'])).code, 0);
    assert.equal((await runCli(t.env, ['profiles', 'create', 'b'])).code, 0);
    const id = (await runCli(t.env, ['session', 'create', '--profile', 'a'])).stdout.trim();
    const env = { ...t.env, GRASP_SESSION: id };
    const dirA = (await srv.api('GET', '/sessions')).json()[0].userDataDir as string;
    await runCli(env, ['nav', `${site.url}/pw-cadres`]);
    assert.equal((await runCli(env, ['hover', '#survol', '--engine', 'playwright'])).code, 0);
    assert.ok(procsOnUserDataDir(dirA).length > 0);
    const sw = await runCli(env, ['profile', 'b']);
    assert.equal(sw.code, 0, sw.stderr);
    assert.ok(await waitUntil(() => procsOnUserDataDir(dirA).length === 0, 10_000), 'le Chrome du profil a est arrêté malgré la connexion Playwright');
    const dirB = (await srv.api('GET', '/sessions')).json()[0].userDataDir as string;
    await runCli(env, ['nav', `${site.url}/pw-cadres`]);
    const again = await runCli(env, ['click', '#bas', '--engine', 'playwright']);
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stderr, /moteur Playwright connecté/, 'nouvelle connexion, au nouveau navigateur');
    assert.equal((await runCli(env, ['session', 'close'])).code, 0);
    assert.ok(await waitUntil(() => procsOnUserDataDir(dirB).length === 0, 10_000), 'aucun Chrome laissé après fermeture de session');
    assert.doesNotMatch(srv.stderr(), /moteur Playwright : déconnexion .* en échec/);
  } finally { srv.proc.kill('SIGTERM'); await waitExit(srv.proc); await site.close(); t.cleanup(); }
});

test('playwright-core absent : ERROR qui dit « npm i playwright-core », avertissement au démarrage, le reste fonctionne', { timeout: 120_000 }, async () => {
  const t = makeTestEnv({ GRASP_PLAYWRIGHT_MODULE: 'grasp-module-qui-nexiste-pas' });
  const site = await startTestSite();
  configure(t.env, { allowedDomains: ['127.0.0.1', 'localhost'], fallbackEngine: 'playwright' });
  const srv = await startServer(t.env);
  try {
    assert.match(srv.stderr(), /AVERTISSEMENT : fallbackEngine=playwright mais playwright-core est absent — npm i playwright-core/);
    const id = (await runCli(t.env, ['session', 'create'])).stdout.trim();
    const env = { ...t.env, GRASP_SESSION: id };
    await runCli(env, ['nav', `${site.url}/pw-cadres`]);
    const r = await runCli(env, ['click', '#bas', '--engine', 'playwright']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^ERROR: click: moteur Playwright indisponible : le module « grasp-module-qui-nexiste-pas » n'est pas installé — npm i playwright-core/m);
    const fr = await runCli(env, ['text', '--scope', 'frame=#editeur']);
    assert.equal(fr.code, 1);
    assert.match(fr.stderr, /npm i playwright-core/);
    const ok = await runCli(env, ['click', '#bas']);
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal((await runCli(env, ['text', '--scope', '#compte'])).stdout, 'Compte : 1\n');
    const doc = await runCli(t.env, ['doctor']);
    assert.match(doc.stdout, /^warn\s+playwright\s+playwright-core absent \(optionnel\) alors que fallbackEngine=playwright/m);
  } finally { srv.proc.kill('SIGTERM'); await waitExit(srv.proc); await site.close(); t.cleanup(); }
});
