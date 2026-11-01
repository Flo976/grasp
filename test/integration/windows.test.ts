import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { makeTestEnv } from '../helpers/env.js';
import { startServer, runCli, waitExit } from '../helpers/server.js';
import { startTestSite } from '../helpers/testsite.js';
import { resolvePaths } from '../../src/core/paths.js';
import { profileId } from '../../src/core/profiles.js';
import { windowsLocalAppData, windowsChromeProcesses, toWindowsPath } from '../../src/browser/windows.js';

/**
 * Chrome Windows piloté depuis WSL2, pour de vrai. Ignoré sauf GRASP_TEST_WINDOWS=1 :
 * il faut WSL2 en networkingMode=mirrored et chrome.exe installé.
 */
const EXE = process.env.GRASP_TEST_WINDOWS_CHROME ?? '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe';
const skip = process.env.GRASP_TEST_WINDOWS !== '1' ? 'GRASP_TEST_WINDOWS=1 pour lancer le test Windows réel' : false;

async function ours(winDir: string): Promise<number> {
  return (await windowsChromeProcesses()).filter((p) => p.commandLine.replaceAll('"', '').toLowerCase().includes(winDir.toLowerCase())).length;
}
/** Processus principaux (sans --type=) des Chrome qui ne sont pas à Grasp : le Chrome habituel de l'utilisateur. */
async function usual(): Promise<number[]> {
  return (await windowsChromeProcesses()).filter((p) => !/grasp/i.test(p.commandLine) && !/--type=/.test(p.commandLine)).map((p) => p.pid).sort();
}

test('windows (réel) : profils côté Windows, bascule, cookies isolés, aucun chrome.exe orphelin, Chrome habituel intact', { skip, timeout: 240_000 }, async () => {
  const local = await windowsLocalAppData();
  const root = join(local, `grasp-test-${randomBytes(3).toString('hex')}`);
  const winRoot = await toWindowsPath(root);
  const usualBefore = await usual();
  const t = makeTestEnv();
  const site = await startTestSite();
  const paths = resolvePaths(t.env, t.env.HOME);
  mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
  writeFileSync(paths.configFile, JSON.stringify({ chromePath: EXE, headless: true, allowEval: true, allowedDomains: ['127.0.0.1'], windowsProfilesDir: root }), { mode: 0o600 });
  const srv = await startServer(t.env);
  try {
    assert.match(srv.stderr(), /windows/);
    assert.equal((await runCli(t.env, ['profiles', 'create', 'florent'])).code, 0);
    assert.equal((await runCli(t.env, ['profiles', 'create', 'sooatek'])).code, 0);
    assert.ok(existsSync(join(root, profileId('florent'), 'profile.json')), 'profil écrit côté Windows');

    const id = (await runCli(t.env, ['session', 'create', '--profile', 'florent'])).stdout.trim();
    assert.match(id, /^s[0-9a-f]{12}$/);
    const env = { ...t.env, GRASP_SESSION: id };
    const nav = await runCli(env, ['nav', `${site.url}/`]);
    assert.equal(nav.stdout, 'OK\n', nav.stderr);
    assert.match((await runCli(env, ['snap'])).stdout, /textbox "Nom"/);
    await runCli(env, ['eval', "document.cookie = 'qui=florent; max-age=3600'"]);
    assert.equal(JSON.parse((await runCli(env, ['eval', 'document.cookie'])).stdout), 'qui=florent');
    const winFlorent = `${winRoot}\\${profileId('florent')}`;
    const winSooatek = `${winRoot}\\${profileId('sooatek')}`;
    assert.ok(await ours(winFlorent) > 0, 'chrome.exe tourne sur le profil florent');

    const sw = await runCli(env, ['profile', 'sooatek']);
    assert.equal(sw.code, 0, sw.stderr);
    assert.equal(await ours(winFlorent), 0, 'le Chrome du profil florent est arrêté');
    assert.ok(await ours(winSooatek) > 0, 'chrome.exe tourne sur le profil sooatek');
    await runCli(env, ['nav', `${site.url}/`]);
    assert.equal(JSON.parse((await runCli(env, ['eval', 'document.cookie'])).stdout), '', 'cookie de florent absent de sooatek');

    // Bridge tué par SIGKILL : le control plane retrouve et tue le chrome.exe orphelin.
    const s = (await srv.api('GET', '/sessions')).json()[0];
    process.kill(s.bridgePid, 'SIGKILL');
    let gone = false;
    for (let i = 0; i < 30 && !gone; i++) { await new Promise((r) => setTimeout(r, 1000)); gone = (await ours(winSooatek)) === 0; }
    assert.ok(gone, 'chrome.exe survit à la mort de son bridge');

    // Nouvelle session puis arrêt du control plane : il ferme ses navigateurs.
    const id2 = (await runCli(t.env, ['session', 'create', '--profile', 'florent'])).stdout.trim();
    assert.match(id2, /^s[0-9a-f]{12}$/);
    assert.ok(await ours(winFlorent) > 0);
    srv.proc.kill('SIGTERM');
    assert.equal(await waitExit(srv.proc, 60_000), 0, srv.stderr());
    assert.equal(await ours(winRoot), 0, 'aucun chrome.exe lancé par Grasp ne survit');
    const usualAfter = await usual();
    assert.ok(usualBefore.every((pid) => usualAfter.includes(pid)), `Chrome habituel touché : avant ${usualBefore}, après ${usualAfter}`);
  } finally {
    srv.proc.kill('SIGKILL');
    await site.close();
    t.cleanup();
    for (let i = 0; i < 10 && existsSync(root); i++) {
      try { rmSync(root, { recursive: true, force: true }); } catch { await new Promise((r) => setTimeout(r, 1000)); }
    }
  }
});
