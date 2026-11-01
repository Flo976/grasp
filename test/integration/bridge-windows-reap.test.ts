import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnBridge } from '../../src/control/bridges.js';
import { effectivePolicy } from '../../src/core/policy.js';
import { resolveConfig } from '../../src/core/config.js';

/**
 * chrome.exe ne meurt pas avec le groupe Linux de son bridge : le control plane doit le viser par son
 * --user-data-dir dès que le bridge s'arrête mal. Bridge factice (pas de vrai chrome.exe ici) qui
 * annonce un windowsUserDataDir, puis se comporte selon son identifiant :
 *   term1 : SIGTERM → sortie code 1 (chien de garde du bridge, arrêt Windows lent ou bloqué)
 *   term0 : SIGTERM → sortie code 0 (arrêt propre)
 *   crash : meurt seul (code 3) peu après « ready »
 */
const FAKE = `
setInterval(() => undefined, 1000); // reste vivant comme un vrai bridge (sans écouteur, le canal IPC ne le retient pas)
process.once('message', (m) => {
  const id = m.init.id;
  process.on('SIGTERM', () => process.exit(id === 'term0' ? 0 : 1));
  process.send({ type: 'ready', pid: process.pid, chromePid: 0, chromePgid: 0, version: 'Chrome/150.0', warnings: [], windowsUserDataDir: 'C:\\\\Users\\\\u\\\\grasp\\\\prof_test' });
  if (id === 'crash') setTimeout(() => process.exit(3), 100);
});
`;
const WIN = 'C:\\Users\\u\\grasp\\prof_test';

function setup(id: string) {
  const root = mkdtempSync(join(tmpdir(), 'gr-bw-'));
  mkdirSync(join(root, 'run'), { mode: 0o700 });
  const main = join(root, 'fake-bridge.mjs');
  writeFileSync(main, FAKE);
  const init = {
    id, socketPath: join(root, 'run', 'b.sock'), userDataDir: join(root, 'p'), headless: true,
    policy: effectivePolicy(resolveConfig({ allowedDomains: ['127.0.0.1'] })),
  };
  return { root, main, init, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('bridge windows : arrêt demandé mais bridge sorti en erreur (chien de garde) → chrome.exe visé par son --user-data-dir', async () => {
  const { main, init, cleanup } = setup('term1');
  const reaped: string[] = [];
  try {
    const b = await spawnBridge(init, { bridgeMain: main, reap: async (d) => { reaped.push(d); } });
    assert.equal(b.windowsUserDataDir, WIN);
    const code = await b.stop(5000);
    assert.equal(code, 1);
    assert.deepEqual(reaped, [WIN], 'un arrêt non propre doit déclencher le ramassage de chrome.exe');
  } finally { cleanup(); }
});

test('bridge windows : arrêt propre (code 0) → pas de PowerShell inutile', async () => {
  const { main, init, cleanup } = setup('term0');
  const reaped: string[] = [];
  try {
    const b = await spawnBridge(init, { bridgeMain: main, reap: async (d) => { reaped.push(d); } });
    assert.equal(await b.stop(5000), 0);
    assert.deepEqual(reaped, []);
  } finally { cleanup(); }
});

test('bridge windows : mort inattendue → onExit seulement APRÈS le ramassage de chrome.exe (profil pas libéré trop tôt)', async () => {
  const { main, init, cleanup } = setup('crash');
  const events: string[] = [];
  try {
    let exited!: () => void;
    const onExitSeen = new Promise<void>((r) => { exited = r; });
    const b = await spawnBridge(init, {
      bridgeMain: main,
      reap: async (d) => { events.push(`reap-start ${d}`); await new Promise((r) => setTimeout(r, 400)); events.push('reap-end'); },
      onExit: (code) => { events.push(`onExit ${code}`); exited(); },
    });
    await onExitSeen;
    assert.deepEqual(events, [`reap-start ${WIN}`, 'reap-end', 'onExit 3']);
    // stop() après coup : ne relance pas un second ramassage.
    assert.equal(await b.stop(), 3);
    assert.equal(events.filter((e) => e.startsWith('reap-start')).length, 1);
  } finally { cleanup(); }
});
