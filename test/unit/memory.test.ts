import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTestEnv } from '../helpers/env.js';
import { groupPids, linuxGroupMemory, windowsChromeMemory, windowsMemoryScript } from '../../src/browser/memory.js';
import { encodePowerShell } from '../../src/browser/windows.js';

/** Faux /proc : pid → (comm, état, pgrp, PSS kB | undefined, RSS kB). */
function fakeProc(root: string, procs: Array<[number, string, string, number, number | undefined, number]>): void {
  for (const [pid, comm, state, pgrp, pss, rss] of procs) {
    const d = join(root, String(pid));
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'stat'), `${pid} (${comm}) ${state} 1 ${pgrp} ${pgrp} 0 -1 4194560 0 0`);
    if (pss !== undefined) writeFileSync(join(d, 'smaps_rollup'), `00400000-7fff [rollup]\nRss:  ${rss} kB\nPss:  ${pss} kB\nPss_Anon: 1 kB\n`);
    writeFileSync(join(d, 'status'), `Name:\t${comm}\nVmRSS:\t   ${rss} kB\n`);
  }
  mkdirSync(join(root, 'self'), { recursive: true });
}

test('mémoire Linux : somme de la PSS de tout le groupe (zombies et autres groupes exclus, comm à parenthèses)', () => {
  const t = makeTestEnv();
  try {
    const root = join(t.root, 'proc');
    fakeProc(root, [
      [100, 'chrome', 'S', 100, 102_400, 300_000],
      [101, 'chrome (zygote) x', 'S', 100, 51_200, 300_000],
      [102, 'chrome', 'Z', 100, 999_999, 999_999],
      [200, 'autre', 'S', 200, 10_000, 10_000],
    ]);
    assert.deepEqual(groupPids(100, root).sort(), [100, 101]);
    assert.deepEqual(linuxGroupMemory(100, root), { mb: 150, procs: 2, metric: 'pss' });
    assert.equal(linuxGroupMemory(300, root), null, 'groupe vide');
    assert.equal(linuxGroupMemory(0, root), null, 'pgid 0 (mode attach) : pas de groupe à nous');
  } finally { t.cleanup(); }
});

test('mémoire Linux : repli sur VmRSS sans smaps_rollup (noyau < 4.14), annoncé par metric', () => {
  const t = makeTestEnv();
  try {
    const root = join(t.root, 'proc');
    fakeProc(root, [[100, 'chrome', 'S', 100, undefined, 204_800], [101, 'chrome', 'S', 100, undefined, 102_400]]);
    assert.deepEqual(linuxGroupMemory(100, root), { mb: 300, procs: 2, metric: 'rss' });
  } finally { t.cleanup(); }
});

test('mémoire Linux : le vrai /proc de ce processus de test est lisible', () => {
  const stat = readFileSync('/proc/self/stat', 'utf8');
  const pgrp = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]);
  const m = linuxGroupMemory(pgrp);
  assert.ok(m !== null && m.mb > 0 && m.procs >= 1, JSON.stringify(m));
});

test('mémoire chrome.exe : script PowerShell filtré sur CE --user-data-dir, octets privés sommés', async () => {
  const s = windowsMemoryScript("C:\\Users\\l'u\\grasp\\profiles\\prof_1\\");
  assert.match(s, /\$d = 'C:\\Users\\l''u\\grasp\\profiles\\prof_1'/, 'quote PowerShell, barre finale retirée');
  assert.match(s, /PrivatePageCount -Sum/);
  const calls: string[][] = [];
  const run = async (cmd: string, args: string[]) => { calls.push([cmd, ...args]); return { code: 0, stdout: '7 524288000\r\n', stderr: '' }; };
  assert.deepEqual(await windowsChromeMemory('C:\\p', run), { mb: 500, procs: 7, metric: 'private' });
  assert.equal(calls[0]![0], 'powershell.exe');
  assert.equal(calls[0]!.at(-1), encodePowerShell(windowsMemoryScript('C:\\p')));
  assert.equal(await windowsChromeMemory('C:\\p', async () => ({ code: 0, stdout: '0 0\r\n', stderr: '' })), null, 'aucun chrome.exe');
  await assert.rejects(windowsChromeMemory('C:\\p', async () => ({ code: 0, stdout: 'bruit', stderr: '' })), /illisible/);
  await assert.rejects(windowsChromeMemory('C:\\p', async () => ({ code: 1, stdout: '', stderr: 'refusé' })), /powershell\.exe a échoué : refusé/);
});
