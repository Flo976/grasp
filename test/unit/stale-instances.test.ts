import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reapStaleInstances } from '../../src/control/stale.js';

function tmp() {
  const root = mkdtempSync(join(tmpdir(), 'gr-stale-'));
  return { root, file: join(root, 'instances.json'), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('démarrage : instances laissées par un serveur tué → chrome.exe visés par leur --user-data-dir, profils éphémères supprimés', async () => {
  const { root, file, cleanup } = tmp();
  try {
    writeFileSync(file, JSON.stringify([
      { id: 's1', bridgePid: 999_999_991, chromePgid: 999_999_992, windowsUserDataDir: 'C:\\Users\\u\\grasp\\profiles\\.tmp\\s1', userDataDir: '/mnt/c/Users/u/grasp/profiles/.tmp/s1', ephemeral: true },
      { id: 's2', bridgePid: 999_999_993, chromePgid: 999_999_994, windowsUserDataDir: 'C:\\Users\\u\\grasp\\profiles\\prof_1', userDataDir: '/mnt/c/Users/u/grasp/profiles/prof_1', ephemeral: false },
      // ancien format (sans userDataDir) : toujours compris
      { id: 's3', bridgePid: 999_999_995, chromePgid: 0, windowsUserDataDir: 'C:\\Users\\u\\grasp\\profiles\\prof_2' },
    ]));
    const reaped: string[] = [];
    const removed: string[] = [];
    const logs: string[] = [];
    const n = await reapStaleInstances(file, { log: (m) => logs.push(m), reapWindows: async (d) => { reaped.push(d); }, removeDir: (d) => removed.push(d) });
    assert.equal(n, 3);
    assert.deepEqual(reaped, ['C:\\Users\\u\\grasp\\profiles\\.tmp\\s1', 'C:\\Users\\u\\grasp\\profiles\\prof_1', 'C:\\Users\\u\\grasp\\profiles\\prof_2']);
    assert.deepEqual(removed, ['/mnt/c/Users/u/grasp/profiles/.tmp/s1'], 'seul le profil éphémère est supprimé');
    assert.ok(logs.some((l) => /3 instance\(s\)/.test(l)), logs.join('\n'));
    void root;
  } finally { cleanup(); }
});

test('démarrage : pas de fichier, fichier vide ou illisible → rien à faire, aucune erreur', async () => {
  const { file, cleanup } = tmp();
  const deps = { log: () => undefined, reapWindows: async () => { throw new Error('ne doit pas être appelé'); }, removeDir: () => { throw new Error('ne doit pas être appelé'); } };
  try {
    assert.equal(await reapStaleInstances(file, deps), 0);
    writeFileSync(file, '[]');
    assert.equal(await reapStaleInstances(file, deps), 0);
    writeFileSync(file, '{pas du json');
    assert.equal(await reapStaleInstances(file, deps), 0);
  } finally { cleanup(); }
});
