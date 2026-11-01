import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromeDownloadPath, isWindowsDrivePath, type Runner } from '../../src/browser/windows.js';
import { downloadDirFor } from '../../src/control/server.js';

const LOCAL = '/mnt/c/Users/Florent Didelot/AppData/Local';
const paths = { dataDir: '/home/u/.local/share/grasp' };

test('windows : dossier de téléchargement côté Windows (jamais un chemin Linux transmis à chrome.exe)', async () => {
  const roots = { profiles: `${LOCAL}/grasp/profiles`, tmp: `${LOCAL}/grasp/profiles/.tmp`, posix: false };
  const win = { path: '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe', kind: 'windows' as const, source: 'config' as const };
  const d = downloadDirFor(win, roots, paths, 's123');
  assert.ok(isWindowsDrivePath(d), `${d} doit être sur un disque Windows`);
  assert.equal(d, `${LOCAL}/grasp/profiles/.downloads/s123`, 'dossier caché : jamais listé comme profil');
  const linux = { path: '/usr/bin/google-chrome', kind: 'elf' as const, source: 'which' as const };
  assert.equal(downloadDirFor(linux, { profiles: '/p', tmp: '/p/.tmp', posix: true }, paths, 's123'), '/home/u/.local/share/grasp/downloads/s123');
  assert.equal(downloadDirFor(undefined, { profiles: '/p', tmp: '/p/.tmp', posix: true }, paths, 's1'), '/home/u/.local/share/grasp/downloads/s1', 'mode attach');
});

test('windows : chemin de téléchargement remis à Chrome traduit par wslpath -w pour chrome.exe, tel quel sinon', async () => {
  const calls: string[][] = [];
  const run: Runner = async (cmd, args) => { calls.push([cmd, ...args]); return { code: 0, stdout: 'C:\\Users\\Florent Didelot\\AppData\\Local\\grasp\\profiles\\.downloads\\s1\n', stderr: '' }; };
  const dir = `${LOCAL}/grasp/profiles/.downloads/s1`;
  assert.equal(await chromeDownloadPath(dir, 'windows', run), 'C:\\Users\\Florent Didelot\\AppData\\Local\\grasp\\profiles\\.downloads\\s1');
  assert.deepEqual(calls, [['wslpath', '-w', dir]]);
  assert.equal(await chromeDownloadPath('/home/u/dl', 'elf', run), '/home/u/dl');
  assert.equal(calls.length, 1);
});
