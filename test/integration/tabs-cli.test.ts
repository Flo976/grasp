import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { makeTestEnv, type TestEnv } from '../helpers/env.js';
import { startServer, runCli, waitExit, type Server } from '../helpers/server.js';
import { startTestSite, type TestSite } from '../helpers/testsite.js';
import { resolvePaths } from '../../src/core/paths.js';

/** Onglets de bout en bout : CLI → control plane → bridge, et dans `grasp run`. */
let t: TestEnv;
let site: TestSite;
let srv: Server;
let env: NodeJS.ProcessEnv;
before(async () => {
  t = makeTestEnv();
  site = await startTestSite();
  const paths = resolvePaths(t.env, t.env.HOME);
  mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
  writeFileSync(paths.configFile, JSON.stringify({ allowedDomains: ['127.0.0.1'], maxTabs: 3 }), { mode: 0o600 });
  srv = await startServer(t.env);
  const id = (await runCli(t.env, ['session', 'create'])).stdout.trim();
  env = { ...t.env, GRASP_SESSION: id };
});
after(async () => { srv.proc.kill('SIGTERM'); await waitExit(srv.proc); await site.close(); t.cleanup(); });

test('CLI : popup annoncé, tabs, tab <id>, flux OAuth avec --follow, tab close, erreurs explicites', async () => {
  assert.equal((await runCli(env, ['nav', `${site.url}/onglets`])).code, 0);
  const aide = await runCli(env, ['click', 'text:Aide']);
  assert.equal(aide.code, 0, aide.stderr);
  assert.equal(aide.stdout, 'OK\n');
  assert.match(aide.stderr, /^note: nouvel onglet t2 ouvert : http:\/\/127\.0\.0\.1:\d+\/onglets\/aide « Aide » — grasp tab t2 pour y basculer$/m);
  const list = await runCli(env, ['tabs']);
  assert.equal(list.code, 0, list.stderr);
  assert.match(list.stdout, /^\* t1 "Application" http:\/\/127\.0\.0\.1:\d+\/onglets\n {2}t2 "Aide" http:\/\/127\.0\.0\.1:\d+\/onglets\/aide \(ouvert par t1\)\n$/);
  const sw = await runCli(env, ['tab', 't2']);
  assert.match(sw.stdout, /^\* t2 "Aide" /);
  assert.match((await runCli(env, ['text'])).stdout, /Aide en ligne/);
  assert.equal((await runCli(env, ['tab', 'close'])).code, 0);
  // OAuth : bascule sur le popup, autorisation, retour automatique sur t1 annoncé, résultat lu dans la page.
  const oauth = await runCli(env, ['click', '#oauth', '--follow']);
  assert.match(oauth.stderr, /nouvel onglet t3 ouvert : .*\/onglets\/autoriser « Fournisseur » ; onglet actif : t3 \(--follow\)/);
  const ok = await runCli(env, ['click', 'text:Autoriser']);
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stderr, /l'onglet t3 s'est fermé pendant l'action .* — onglet actif : t1 « Application »/);
  assert.match((await runCli(env, ['text'])).stdout, /Connecté : Ada/);
  // Erreurs : identifiant invalide (400 côté CLI), onglet inconnu, dernier onglet.
  const bad = await runCli(env, ['tab', 'nouveau']);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /identifiant d'onglet t1, t2…/);
  assert.match((await runCli(env, ['tab', 't9'])).stderr, /onglet t9 inconnu ou fermé \(onglets : t1\)/);
  assert.match((await runCli(env, ['tab', 'close'])).stderr, /t1 est le dernier onglet de la session/);
  // Popup hors allowlist : bloqué, fermé, dit.
  assert.match((await runCli(env, ['click', '#dehors'])).stderr, /popup bloqué par Grasp : .* ; onglet t\d fermé/);
  assert.match((await runCli(env, ['tabs'])).stdout, /^\* t1 "Application" [^\n]*\n$/);
});

test('run : tab new, tabs, tab, tab close sur une ligne de script ; --follow accepté sur une action', async () => {
  const script = `nav ${site.url}/onglets
tab new ${site.url}/onglets/aide
tabs
tab t1
click text:Aide --follow
text
tab close
`;
  const r = await runCli(env, ['run'], script);
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /\[2\] tab new .* → OK\n {0,2}\* t\d+ "Aide" /);
  assert.match(r.stdout, /\[3\] tabs → OK\n {2}t1 "Application" .*\n\* t\d+ "Aide" .*\(?/);
  assert.match(r.stdout, /\[5\] click text:Aide --follow → OK/);
  assert.match(r.stderr, /\[5\] note: nouvel onglet t\d+ ouvert : .* ; onglet actif : t\d+ \(--follow\)/);
  assert.match(r.stdout, /\[6\] text → OK\nAide en ligne/);
  assert.match(r.stdout, /\[7\] tab close → OK/);
  // Option inconnue sur une ligne de run : refusée avant toute exécution.
  const bad = await runCli(env, ['run'], 'tabs --follow\n');
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr, /option --follow inconnue pour tabs/);
});
