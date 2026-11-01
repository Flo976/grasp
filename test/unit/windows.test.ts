import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { classify, discoverChrome, profileRootsFor, type FsProbe } from '../../src/browser/discover.js';
import {
  buildWindowsChromeArgs, toWindowsPath, toWslPath, windowsLocalAppData, windowsChromeVersion,
  windowsKillScript, encodePowerShell, isWindowsDrivePath, type Runner,
} from '../../src/browser/windows.js';

const EXE = '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe';
const LOCAL = '/mnt/c/Users/Florent Didelot/AppData/Local';
const WIN_LOCAL = 'C:\\Users\\Florent Didelot\\AppData\\Local';

const probe = (files: string[]): FsProbe => ({ which: () => null, isExecutable: (p) => files.includes(p), readHead: () => Buffer.from('MZ') });

/** Faux exécuteur : enregistre les appels, répond selon la commande. */
function fakeRunner(answers: Record<string, { code?: number; stdout?: string; stderr?: string }>) {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const run: Runner = async (cmd, args) => {
    calls.push({ cmd, args });
    const key = Object.keys(answers).find((k) => cmd.endsWith(k));
    const a = key !== undefined ? answers[key]! : { code: 127, stderr: 'introuvable' };
    return { code: a.code ?? 0, stdout: a.stdout ?? '', stderr: a.stderr ?? '' };
  };
  return { run, calls };
}

test('windows : un *.exe sous /mnt/ est classé « windows »', () => {
  assert.equal(classify(EXE, probe([EXE])), 'windows');
  assert.equal(classify('/mnt/d/Apps/Chromium/chrome.EXE', probe([])), 'windows');
  assert.notEqual(classify('/usr/local/bin/chrome.exe', probe([])), 'windows', 'hors /mnt : pas Windows');
  assert.notEqual(classify('/mnt/c/tools/chrome', probe([])), 'windows', 'pas de .exe : pas Windows');
  const b = discoverChrome({}, probe([EXE]), '/home/u', EXE);
  assert.deepEqual(b, { path: EXE, kind: 'windows', source: 'config' });
});

test('windows : arguments de chrome.exe (chemin Windows avec espaces, un seul argv, sans guillemets)', () => {
  const dir = `${WIN_LOCAL}\\grasp\\profiles\\prof_1a2b3c4d`;
  assert.deepEqual(buildWindowsChromeArgs({ userDataDirWin: dir, headless: false }), [
    `--user-data-dir=${dir}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
    '--disable-features=CalculateNativeWinOcclusion', 'about:blank',
  ]);
  const h = buildWindowsChromeArgs({ userDataDirWin: dir, headless: true });
  assert.ok(h.includes('--headless=new'));
  assert.ok(!h.some((a) => a.includes('"')), 'pas de guillemets manuels : l\'interop WSL cite elle-même');
  assert.ok(!h.includes('--no-sandbox'));
  assert.equal(h.filter((a) => a.startsWith('--disable-features=')).length, 1);
  assert.equal(h.at(-1), 'about:blank', 'URL de départ en dernier');
});

test('windows : conversion de chemins via wslpath (espaces conservés, un seul argument)', async () => {
  const f = fakeRunner({ wslpath: { stdout: `${WIN_LOCAL}\\grasp\\profiles\\prof_x\n` } });
  assert.equal(await toWindowsPath(`${LOCAL}/grasp/profiles/prof_x`, f.run), `${WIN_LOCAL}\\grasp\\profiles\\prof_x`);
  assert.deepEqual(f.calls[0], { cmd: 'wslpath', args: ['-w', `${LOCAL}/grasp/profiles/prof_x`] });
  await assert.rejects(toWindowsPath('/home/u/profil', f.run), /\/mnt\//, 'un profil côté Linux n\'est pas lisible correctement par chrome.exe');
  const u = fakeRunner({ wslpath: { stdout: `${LOCAL}\n` } });
  assert.equal(await toWslPath(WIN_LOCAL, u.run), LOCAL);
  assert.deepEqual(u.calls[0]!.args, ['-u', WIN_LOCAL]);
  assert.equal(isWindowsDrivePath(`${LOCAL}/x`), true);
  assert.equal(isWindowsDrivePath('/home/u'), false);
});

test('windows : conversion réelle avec wslpath (si disponible)', { skip: existsSync('/usr/bin/wslpath') ? false : 'wslpath absent (pas sous WSL)' }, async () => {
  assert.equal(await toWindowsPath(`${LOCAL}/grasp/profiles/prof_x`), `${WIN_LOCAL}\\grasp\\profiles\\prof_x`);
  assert.equal(await toWslPath(`${WIN_LOCAL}\\grasp`), `${LOCAL}/grasp`);
});

test('windows : %LOCALAPPDATA% via cmd.exe puis wslpath -u (CRLF et avertissement UNC tolérés)', async () => {
  const f = fakeRunner({
    'cmd.exe': { stdout: `${WIN_LOCAL}\r\n`, stderr: 'CMD.EXE a été démarré avec le chemin d\'accès comme répertoire en cours. Les chemins d\'accès UNC ne sont pas pris en charge.' },
    wslpath: { stdout: `${LOCAL}\n` },
  });
  assert.equal(await windowsLocalAppData(f.run), LOCAL);
  assert.deepEqual(f.calls[0]!.args, ['/c', 'echo', '%LOCALAPPDATA%']);
  const bad = fakeRunner({ 'cmd.exe': { stdout: '%LOCALAPPDATA%\r\n' } });
  await assert.rejects(windowsLocalAppData(bad.run), /LOCALAPPDATA/);
  const none = fakeRunner({});
  await assert.rejects(windowsLocalAppData(none.run), /cmd\.exe/);
});

test('windows : version lue dans le dossier de chrome.exe (jamais `chrome.exe --version`, qui ouvrirait le Chrome de l\'utilisateur)', () => {
  const v = windowsChromeVersion(EXE, () => ['149.0.1.2', '156.0.8078.76', 'SetupMetrics', 'chrome.exe', '99.0.0.1']);
  assert.equal(v, 'Google Chrome 156.0.8078.76');
  assert.throws(() => windowsChromeVersion(EXE, () => ['chrome.exe']), /version/);
});

test('windows : script d\'arrêt ciblé sur CE --user-data-dir, jamais sur le Chrome habituel', () => {
  const dir = `${WIN_LOCAL}\\grasp\\profiles\\prof_1a2b3c4d`;
  const s = windowsKillScript(dir);
  assert.match(s, /Win32_Process/);
  assert.match(s, /\[regex\]::Escape/);
  assert.ok(s.includes(`'${dir}'`), 'chemin passé en littéral PowerShell');
  assert.match(s, /--user-data-dir=/);
  assert.ok(windowsKillScript("C:\\Users\\O'Brien\\grasp\\p").includes("'C:\\Users\\O''Brien\\grasp\\p'"), 'apostrophe doublée');
  // garde-fous : le profil habituel de Chrome, une racine de disque ou un chemin vide sont refusés
  assert.throws(() => windowsKillScript(`${WIN_LOCAL}\\Google\\Chrome\\User Data`), /habituel/);
  assert.throws(() => windowsKillScript('C:\\'), /refus/);
  assert.throws(() => windowsKillScript(''), /refus/);
  assert.equal(Buffer.from(encodePowerShell('Write-Output 1'), 'base64').toString('utf16le'), 'Write-Output 1');
});

test('windows : racines des profils côté Windows (%LOCALAPPDATA%\\grasp\\profiles, surchargeable), sans droits POSIX', () => {
  const paths = { profilesDir: '/home/u/.local/share/grasp/profiles', tmpProfilesDir: '/home/u/.local/share/grasp/tmp-profiles' };
  const win = { path: EXE, kind: 'windows' as const, source: 'config' as const };
  assert.deepEqual(profileRootsFor(win, paths, '/home/u', { localAppData: LOCAL }), {
    profiles: `${LOCAL}/grasp/profiles`, tmp: `${LOCAL}/grasp/profiles/.tmp`, posix: false,
  });
  assert.deepEqual(profileRootsFor(win, paths, '/home/u', { localAppData: LOCAL, windowsProfilesDir: '/mnt/d/grasp' }).profiles, '/mnt/d/grasp');
  assert.throws(() => profileRootsFor(win, paths, '/home/u', {}), /LOCALAPPDATA/);
  assert.deepEqual(profileRootsFor({ path: '/usr/bin/google-chrome', kind: 'elf', source: 'which' }, paths, '/home/u', {}), {
    profiles: paths.profilesDir, tmp: paths.tmpProfilesDir, posix: true,
  });
  assert.deepEqual(profileRootsFor(undefined, paths, '/home/u', {}).profiles, paths.profilesDir, 'mode attach');
});
