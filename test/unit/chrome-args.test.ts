import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChromeArgs, parseChromeVersion, assertSupportedVersion, MIN_CHROME_MAJOR } from '../../src/browser/launch.js';

const base = { userDataDir: '/p', headless: true, env: {}, uid: 1000, shmBytes: 2 * 1024 ** 3 };

test('headless = --headless=new, jamais l\'ancien mode', () => {
  const { args } = buildChromeArgs(base);
  assert.ok(args.includes('--headless=new'));
  assert.ok(!args.includes('--headless'));
  assert.ok(args.includes('--user-data-dir=/p'));
  assert.ok(args.includes('--remote-debugging-port=0'));
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
