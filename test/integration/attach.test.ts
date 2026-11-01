import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverChrome, realProbe } from '../../src/browser/discover.js';
import { launchChrome } from '../../src/browser/launch.js';
import { makeTestEnv } from '../helpers/env.js';
import { startServer, runCli, waitExit } from '../helpers/server.js';
import { startTestSite } from '../helpers/testsite.js';
import { resolvePaths } from '../../src/core/paths.js';
import { isAlive } from '../helpers/procs.js';

test('mode attach : pilote un navigateur déjà ouvert (cdpUrl) sans jamais le tuer', async () => {
  // Navigateur « externe » : lancé hors de Grasp, comme le Chrome Windows de l'utilisateur.
  const dir = mkdtempSync(join(tmpdir(), 'gr-ext-'));
  const external = await launchChrome({ browser: discoverChrome(process.env, realProbe, process.env.HOME ?? '/'), userDataDir: dir, headless: true });
  const t = makeTestEnv();
  const site = await startTestSite();
  const paths = resolvePaths(t.env, t.env.HOME);
  mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
  writeFileSync(paths.configFile, JSON.stringify({ cdpUrl: `http://127.0.0.1:${external.port}`, allowedDomains: ['127.0.0.1'] }), { mode: 0o600 });
  const srv = await startServer(t.env);
  try {
    const id = (await runCli(t.env, ['session', 'create'])).stdout.trim();
    assert.match(id, /^s[0-9a-f]{12}$/);
    const env = { ...t.env, GRASP_SESSION: id };
    assert.equal((await runCli(env, ['nav', `${site.url}/`])).stdout, 'OK\n');
    await runCli(env, ['fill', '#nom', 'Ada']);
    await runCli(env, ['click', 'text:Valider']);
    assert.match((await runCli(env, ['text'])).stdout, /Nom : Ada/);
    // la garde s'applique aussi au navigateur externe
    assert.notEqual((await runCli(env, ['nav', 'https://example.com'])).code, 0);

    // Profils sans objet en mode attach : refus explicite (400), la session reste intacte.
    const withProfile = await runCli(t.env, ['session', 'create', '--profile', 'florent']);
    assert.notEqual(withProfile.code, 0);
    assert.match(withProfile.stderr, /^ERROR: session: .*mode attach.*--profile est sans effet/m);
    assert.equal((await srv.api('POST', '/sessions', { profile: 'florent' })).status, 400);
    const sw = await srv.api('POST', `/sessions/${id}/profile`, { name: 'florent' });
    assert.equal(sw.status, 400, sw.text());
    assert.match(sw.text(), /mode attach.*bascule est sans effet/);
    const sw2 = await runCli(env, ['profile', 'florent']);
    assert.notEqual(sw2.code, 0);
    assert.match(sw2.stderr, /bascule est sans effet/);
    assert.deepEqual((await srv.api('GET', '/sessions')).json().map((s: { id: string; profile: string | null }) => [s.id, s.profile]), [[id, null]]);
    assert.match((await runCli(env, ['text'])).stdout, /Nom : Ada/, 'session toujours pilotable');

    // Fermer la session puis arrêter le serveur ne doit PAS tuer le navigateur externe.
    assert.equal((await runCli(t.env, ['session', 'close', id])).stdout, 'OK\n');
    srv.proc.kill('SIGTERM');
    assert.equal(await waitExit(srv.proc), 0);
    assert.ok(isAlive(external.pid), 'Grasp a tué un navigateur qu\'il n\'a pas lancé');
    assert.ok(isAlive(process.pid), 'garde-fou : le processus de test est vivant');
  } finally {
    srv.proc.kill('SIGKILL');
    await external.kill();
    await site.close();
    rmSync(dir, { recursive: true, force: true });
    t.cleanup();
  }
});

test('mode attach : cdpUrl injoignable → erreur explicite à la création de session', async () => {
  const t = makeTestEnv();
  const paths = resolvePaths(t.env, t.env.HOME);
  mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
  writeFileSync(paths.configFile, JSON.stringify({ cdpUrl: 'http://127.0.0.1:9' }), { mode: 0o600 });
  const srv = await startServer(t.env);
  try {
    const r = await runCli(t.env, ['session', 'create']);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /^ERROR: session: .*127\.0\.0\.1:9/m);
  } finally { srv.proc.kill('SIGTERM'); await waitExit(srv.proc); t.cleanup(); }
});
