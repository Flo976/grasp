import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnBridge } from '../../src/control/bridges.js';
import { discoverChrome, realProbe } from '../../src/browser/discover.js';
import { effectivePolicy } from '../../src/core/policy.js';
import { resolveConfig } from '../../src/core/config.js';
import { request } from '../../src/core/http.js';
import { aliveInGroup, descendants, isAlive, waitUntil } from '../helpers/procs.js';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'gr-br-'));
  mkdirSync(join(root, 'run'), { mode: 0o700 });
  return {
    root,
    init: {
      id: 's1',
      socketPath: join(root, 'run', 'b.sock'),
      browser: discoverChrome(process.env, realProbe, process.env.HOME ?? '/'),
      userDataDir: join(root, 'profile'),
      headless: true,
      policy: effectivePolicy(resolveConfig({ allowedDomains: ['127.0.0.1'] })),
      downloadDir: join(root, 'dl'),
    },
  };
}

test('bridge : SIGKILL du bridge → aucun processus Chrome ne survit', async () => {
  const { root, init } = setup();
  const b = await spawnBridge(init, { reapOnExit: false });
  try {
    const tree = [b.chromePid, ...descendants(b.chromePid)];
    assert.ok(tree.length >= 3, 'Chrome doit avoir des sous-processus');
    process.kill(b.pid, 'SIGKILL');
    // aucune aide du parent (reapOnExit: false) : seul PR_SET_PDEATHSIG + l'arrêt du navigateur jouent
    const gone = await waitUntil(() => tree.every((p) => !isAlive(p)), 10_000);
    assert.ok(gone, `processus Chrome survivants : ${tree.filter(isAlive).join(', ')}`);
    assert.deepEqual(aliveInGroup(b.chromePgid), []);
  } finally {
    try { process.kill(-b.chromePgid, 'SIGKILL'); } catch { /* déjà mort */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test('bridge : SIGTERM → fermeture CDP, groupe Chrome arrêté, socket retiré, sortie 0', async () => {
  const { root, init } = setup();
  const b = await spawnBridge(init);
  try {
    assert.ok(existsSync(init.socketPath));
    const h = await request({ transport: 'unix', socketPath: init.socketPath }, 'GET', '/health');
    assert.equal(h.status, 200);
    const tree = [b.chromePid, ...descendants(b.chromePid)];
    const code = await b.stop();
    assert.equal(code, 0);
    assert.equal(existsSync(init.socketPath), false, 'socket non retiré');
    assert.ok(tree.every((p) => !isAlive(p)), 'Chrome a survécu');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('bridge : la politique exposée est celle du garde (objet reçu, inchangé)', async () => {
  const { root, init } = setup();
  const b = await spawnBridge(init);
  try {
    const r = await request({ transport: 'unix', socketPath: init.socketPath }, 'GET', '/policy');
    assert.deepEqual(r.json(), JSON.parse(JSON.stringify(init.policy)));
  } finally { await b.stop(); rmSync(root, { recursive: true, force: true }); }
});

test('bridge : échec de lancement remonté, pas de bridge zombie', async () => {
  const { root, init } = setup();
  try {
    await assert.rejects(spawnBridge({ ...init, browser: { path: '/bin/false', kind: 'elf', source: 'env' } }), /version|Chrome/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
