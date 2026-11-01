import { test } from 'node:test';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { discoverChrome, realProbe } from '../../src/browser/discover.js';
import { launchChrome } from '../../src/browser/launch.js';
import { resolvePaths } from '../../src/core/paths.js';
import { makeTestEnv } from '../helpers/env.js';
import { startServer, waitExit } from '../helpers/server.js';
import { aliveInGroup, isAlive, waitUntil } from '../helpers/procs.js';

test('démarrage : un navigateur laissé par un serveur tué (instances.json) est arrêté, son profil éphémère supprimé', async () => {
  const t = makeTestEnv();
  const paths = resolvePaths(t.env, t.env.HOME);
  for (const d of [paths.stateDir, paths.dataDir, paths.tmpProfilesDir]) mkdirSync(d, { recursive: true, mode: 0o700 });
  // Navigateur « survivant » d'une session éphémère s0 (comme après un SIGKILL du control plane et du bridge).
  const dir = join(paths.tmpProfilesDir, 's0');
  const chrome = await launchChrome({ browser: discoverChrome(process.env, realProbe, process.env.HOME ?? '/'), userDataDir: dir, headless: true });
  writeFileSync(paths.instancesFile, JSON.stringify([{ id: 's0', bridgePid: 999_999_999, chromePgid: chrome.pgid, userDataDir: dir, ephemeral: true }]), { mode: 0o600 });
  let srv;
  try {
    srv = await startServer(t.env);
    assert.ok(await waitUntil(() => aliveInGroup(chrome.pgid).length === 0, 5000), 'le navigateur orphelin doit être arrêté au démarrage');
    assert.equal(existsSync(dir), false, 'profil éphémère orphelin supprimé');
    assert.deepEqual(JSON.parse(readFileSync(paths.instancesFile, 'utf8')), []);
    assert.match(srv.stderr(), /instance\(s\) laissée\(s\) par un serveur précédent/);
  } finally {
    if (srv) { srv.proc.kill('SIGTERM'); await waitExit(srv.proc); }
    await chrome.kill().catch(() => undefined);
    t.cleanup();
  }
});

test('démarrage : pgid recyclé par un processus étranger → jamais tué', async () => {
  const t = makeTestEnv();
  const paths = resolvePaths(t.env, t.env.HOME);
  for (const d of [paths.stateDir, paths.dataDir]) mkdirSync(d, { recursive: true, mode: 0o700 });
  // Les pid/pgid notés appartiennent désormais à des processus étrangers (pid recyclés).
  const stranger = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
  const pid = stranger.pid!;
  writeFileSync(paths.instancesFile, JSON.stringify([{ id: 's0', bridgePid: pid, chromePgid: pid, userDataDir: join(t.root, 'x'), ephemeral: false }]), { mode: 0o600 });
  const srv = await startServer(t.env);
  try {
    assert.equal((await srv.api('GET', '/sessions')).status, 200);
    assert.ok(isAlive(pid), 'un processus étranger a été tué');
  } finally { srv.proc.kill('SIGTERM'); await waitExit(srv.proc); stranger.kill('SIGKILL'); t.cleanup(); }
});
