import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChromeArgs, parseChromeVersion, assertSupportedVersion, MIN_CHROME_MAJOR, ANTI_BACKGROUND_ARGS, mergeDisableFeatures, parseDevtoolsStderr, freeLocalPort, windowsFreePort, linuxEphemeralRange } from '../../src/browser/launch.js';

const base = { userDataDir: '/p', headless: true, env: {}, uid: 1000, shmBytes: 2 * 1024 ** 3, port: 45678 };

test('headless = --headless=new, jamais l\'ancien mode', () => {
  const { args } = buildChromeArgs(base);
  assert.ok(args.includes('--headless=new'));
  assert.ok(!args.includes('--headless'));
  assert.ok(args.includes('--user-data-dir=/p'));
});

test('port DevTools : choisi par Grasp, jamais 0 (avec 0, Chrome expose navigator.webdriver === true)', () => {
  const { args } = buildChromeArgs(base);
  assert.ok(args.includes('--remote-debugging-port=45678'));
  assert.ok(!args.includes('--remote-debugging-port=0'));
  assert.throws(() => buildChromeArgs({ ...base, port: 0 }), /port/);
});

test('stderr de Chrome : ligne « DevTools listening », échecs de port détectés', () => {
  const ok = parseDevtoolsStderr('[1:2:ERROR:x] bruit\nDevTools listening on ws://127.0.0.1:45678/devtools/browser/4a45d5d4-fc5b\n');
  assert.deepEqual(ok, { listening: { host: '127.0.0.1', port: 45678, path: '/devtools/browser/4a45d5d4-fc5b' } });
  assert.deepEqual(parseDevtoolsStderr(''), {});
  assert.deepEqual(parseDevtoolsStderr('DevTools listening on ws://127.0.0.1:45'), {}, 'ligne incomplète : pas encore');
  // Linux : 127.0.0.1:port déjà pris → Chrome se replie sur [::1] (mesuré) : ce n'est pas notre port.
  const v6 = parseDevtoolsStderr('bind() failed: Address already in use (98)\nDevTools listening on ws://[::1]:45678/devtools/browser/x\n');
  assert.match(v6.portFailure ?? '', /\[::1\]/);
  // Windows : port pris → Chrome continue sans DevTools (mesuré).
  const win = parseDevtoolsStderr('[3:4:ERROR:devtools_http_handler.cc:322] Cannot start http server for devtools.\n');
  assert.match(win.portFailure ?? '', /DevTools/);
});

test('port libre : jamais dans une plage exclue (Windows : netsh excludedportrange)', async () => {
  const seq = [50010, 5357, 50059, 41234];
  const port = await freeLocalPort([[5357, 5357], [50000, 50059]], async () => seq.shift()!);
  assert.equal(port, 41234);
  const real = await freeLocalPort();
  assert.ok(real > 0 && real < 65536);
  await assert.rejects(freeLocalPort([[1, 65535]], async () => 50010), /port/);
});

test('port pour chrome.exe : hors plage éphémère Linux (réservée côté Windows en mirrored), hors exclusions, libre', async () => {
  assert.deepEqual(linuxEphemeralRange('44620\t48715\n'), [44620, 48715]);
  assert.deepEqual(linuxEphemeralRange('n importe quoi'), [32768, 60999], 'valeur par défaut du noyau');
  // Tirages successifs : 0 → 20000 (exclu), 0.9 → dans la plage Linux, 0.5 → pris, 0.1 → libre.
  const draws = [0, 0.9, 0.5, 0.1];
  const tried: number[] = [];
  const port = await windowsFreePort([[20000, 20000]], [44620, 48715], async (p: number) => { tried.push(p); return tried.length > 1; }, () => draws.shift()!);
  assert.ok(port >= 20000 && port < 44620, `${port}`);
  assert.equal(tried.length, 2, 'seuls les ports hors plages sont essayés au bind');
  await assert.rejects(windowsFreePort([], [44620, 48715], async () => false, () => 0.3), /port/);
});

test('--no-sandbox : jamais ajouté pour un utilisateur normal', () => {
  const { args } = buildChromeArgs({ ...base, env: { GRASP_ALLOW_NO_SANDBOX: '1' } });
  assert.ok(!args.includes('--no-sandbox'));
});

test('--no-sandbox : root sans opt-in → refus (pas de repli silencieux)', () => {
  assert.throws(() => buildChromeArgs({ ...base, uid: 0 }), /GRASP_ALLOW_NO_SANDBOX=1.*SYS_ADMIN|SYS_ADMIN.*GRASP_ALLOW_NO_SANDBOX=1/s);
});

test('--no-sandbox : root avec GRASP_ALLOW_NO_SANDBOX=1 → ajouté + avertissement', () => {
  const { args, warnings } = buildChromeArgs({ ...base, uid: 0, env: { GRASP_ALLOW_NO_SANDBOX: '1' } });
  assert.ok(args.includes('--no-sandbox'));
  assert.ok(warnings.some((w) => /sandbox/i.test(w)));
});

test('/dev/shm < 256 Mo → --disable-dev-shm-usage + remédiation --shm-size=1g', () => {
  const { args, warnings } = buildChromeArgs({ ...base, shmBytes: 64 * 1024 ** 2 });
  assert.ok(args.includes('--disable-dev-shm-usage'));
  assert.ok(warnings.some((w) => w.includes('--shm-size=1g')));
  const ok = buildChromeArgs(base);
  assert.ok(!ok.args.includes('--disable-dev-shm-usage'));
});

test('version : parse les formats Chrome/Chromium', () => {
  assert.equal(parseChromeVersion('Google Chrome 150.0.7871.114'), 150);
  assert.equal(parseChromeVersion('Chromium 111.0.5563.64 snap'), 111);
  assert.equal(parseChromeVersion('Chromium 120.0.6099.71 built on Debian'), 120);
  assert.equal(parseChromeVersion('nimporte quoi'), null);
});

test(`version : refus en dessous de ${MIN_CHROME_MAJOR}`, () => {
  assert.equal(MIN_CHROME_MAJOR, 112);
  assert.throws(() => assertSupportedVersion('Chromium 111.0.5563.64'), /112/);
  assert.throws(() => assertSupportedVersion('???'), /version/i);
  assert.doesNotThrow(() => assertSupportedVersion('Google Chrome 112.0.1.1'));
});

test('arrière-plan : ni étranglement des minuteries, ni mise en veille du rendu, ni fenêtre occultée ignorée', () => {
  const { args } = buildChromeArgs(base);
  for (const a of ANTI_BACKGROUND_ARGS) assert.ok(args.includes(a), `${a} absent`);
  assert.deepEqual([...ANTI_BACKGROUND_ARGS].sort(), ['--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding']);
});

test('--disable-features : un seul drapeau, fusionné (CalculateNativeWinOcclusion ajouté aux fonctions déjà désactivées)', () => {
  const { args } = buildChromeArgs(base);
  const df = args.filter((a) => a.startsWith('--disable-features='));
  assert.equal(df.length, 1, `un seul --disable-features attendu : ${df.join(' ')}`);
  const feats = df[0]!.slice('--disable-features='.length).split(',');
  for (const f of ['Translate', 'MediaRouter', 'OptimizationHints', 'CalculateNativeWinOcclusion']) assert.ok(feats.includes(f), `${f} absent de ${df[0]}`);
  assert.equal(new Set(feats).size, feats.length, 'pas de doublon');
});

test('mergeDisableFeatures : fusionne plusieurs drapeaux en un seul, sans doublon, ordre conservé', () => {
  assert.deepEqual(mergeDisableFeatures(['--a', '--disable-features=X,Y', '--b', '--disable-features=Y,Z'], ['Z', 'W']), ['--a', '--disable-features=X,Y,Z,W', '--b']);
  assert.deepEqual(mergeDisableFeatures(['--a'], ['W']), ['--a', '--disable-features=W']);
  assert.deepEqual(mergeDisableFeatures(['--a', 'about:blank'], ['W']), ['--a', '--disable-features=W', 'about:blank'], 'avant l\'URL de départ');
});
