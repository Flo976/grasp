import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { makeTestEnv } from '../helpers/env.js';
import { startServer, runCli, waitExit } from '../helpers/server.js';
import { startTestSite } from '../helpers/testsite.js';
import { DOWNLOAD_JS } from '../helpers/download.js';
import { decodePng } from '../helpers/png.js';
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
  writeFileSync(paths.configFile, JSON.stringify({ chromePath: EXE, headless: true, allowEval: true, allowDownload: true, allowUpload: true, allowedDomains: ['127.0.0.1', 'localhost'], windowsProfilesDir: root }), { mode: 0o600 });
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
    // Port DevTools choisi par Grasp (jamais 0) : chrome.exe ne se déclare pas automatisé.
    assert.equal(JSON.parse((await runCli(env, ['eval', 'navigator.webdriver'])).stdout), false, 'navigator.webdriver doit valoir false');
    await runCli(env, ['eval', "document.cookie = 'qui=florent; max-age=3600'"]);
    assert.equal(JSON.parse((await runCli(env, ['eval', 'document.cookie'])).stdout), 'qui=florent');
    // Téléchargement : chrome.exe reçoit un chemin Windows, le fichier arrive côté Windows sous la racine des profils.
    assert.equal((await runCli(env, ['eval', DOWNLOAD_JS])).code, 0);
    const dl = join(root, '.downloads', id, 'grasp-dl.txt');
    let got = false;
    for (let i = 0; i < 20 && !got; i++) { await new Promise((r) => setTimeout(r, 500)); got = existsSync(dl); }
    assert.ok(got, `${dl} absent : le dossier de téléchargement transmis à chrome.exe est faux`);
    assert.equal(readFileSync(dl, 'utf8'), 'contenu grasp');
    // Captures et console : la capture passe par CDP, le fichier est écrit côté Linux (état de Grasp).
    await runCli(env, ['nav', `${site.url}/capture`]);
    const shot = JSON.parse((await runCli(env, ['screenshot', '--full', '--json'])).stdout);
    assert.ok(shot.path.startsWith(`${paths.stateDir}/captures/`), shot.path);
    assert.equal(shot.height, 3100, 'page entière');
    const el = JSON.parse((await runCli(env, ['screenshot', '--el', '#cible', '--refs', '--max-width', '100', '--json'])).stdout);
    assert.ok(el.width <= 100 && el.width > 0, JSON.stringify(el));
    await runCli(env, ['nav', `${site.url}/console`]);
    await new Promise((r) => setTimeout(r, 1000));
    const cons = await runCli(env, ['console']);
    assert.match(cons.stdout, /erreur objet/, cons.stderr);
    assert.match(cons.stdout, /absent\.png → 404/);
    assert.match((await runCli(env, ['click', '#absent', '--shot-on-error'])).stderr, /\(capture : \/\S+\.png\)$/m);
    // Livraison vérifiée des entrées, run, eval undefined et découpe --el sur chrome.exe.
    const ran = await runCli(env, ['run'], `nav ${site.url}/sonde
click text:Compter
press a #vider
click #muet --snap-diff
eval "document.getElementById('compter').click()"
text --scope #compte
screenshot --el #compter
`);
    assert.equal(ran.code, 0, `${ran.stdout}\n${ran.stderr}`);
    assert.doesNotMatch(ran.stderr, /synthétique|non vérifi/, 'entrée native livrée à chrome.exe');
    assert.match(ran.stdout, /\[5\] eval .* → OK\nundefined\n/);
    assert.match(ran.stdout, /\[6\] text --scope #compte → OK\nCompte : 2\n/);
    assert.match(ran.stdout, /\[7\] screenshot --el #compter → OK\n\/\S+\.png\n/);
    assert.match(ran.stderr, /7 commandes, 7 OK/);
    // Moteur Playwright branché sur chrome.exe (127.0.0.1:<port>) : clic vérifié, iframe d'une autre origine
    // (localhost), upload par CONTENU (chrome.exe ne voit pas les chemins Linux).
    await runCli(env, ['nav', `${site.url}/pw-cadres`]);
    const pc = await runCli(env, ['click', '#bas', '--engine', 'playwright']);
    assert.equal(pc.code, 0, pc.stderr);
    assert.match(pc.stderr, /moteur Playwright connecté en \d+ ms/);
    assert.equal((await runCli(env, ['text', '--scope', '#compte'])).stdout, 'Compte : 1\n');
    assert.match((await runCli(env, ['text', '--scope', 'frame=#editeur'])).stdout, /Texte initial/);
    const piece = join(t.root, 'piece.txt');
    writeFileSync(piece, 'pièce jointe');
    const pr = await runCli(env, ['run'], `fill 'frame=#editeur >> #titre' Fosa
click 'frame=#editeur >> text:Appliquer'
text --scope 'frame=#editeur >> #etat'
upload 'frame=#editeur >> #piece' ${piece}
text --scope 'frame=#editeur >> #fichier'
`);
    assert.equal(pr.code, 0, `${pr.stdout}\n${pr.stderr}`);
    assert.match(pr.stdout, /\[3\] .* → OK\nAppliqué : Fosa\n/);
    assert.match(pr.stdout, /\[5\] .* → OK\nFichier : piece\.txt\n/);
    await runCli(env, ['nav', `${site.url}/flottant`]);
    const info = decodePng(readFileSync((await runCli(env, ['screenshot', '--el', '#info'])).stdout.trim()));
    assert.ok([0, 1].some((x) => info.at(x, Math.floor(info.height / 2)).every((v) => v < 60)), `bord gauche de #info rogné : ${info.at(0, Math.floor(info.height / 2))}`);
    const main = (await windowsChromeProcesses()).find((p) => p.commandLine.replaceAll('"', '').toLowerCase().includes(winRoot.toLowerCase()) && !/--type=/.test(p.commandLine));
    assert.ok(main, 'processus principal de chrome.exe introuvable');
    for (const a of ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-features=CalculateNativeWinOcclusion']) assert.ok(main.commandLine.includes(a), `${a} absent de ${main.commandLine}`);
    await runCli(env, ['nav', `${site.url}/`]);
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
