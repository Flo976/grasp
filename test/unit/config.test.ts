import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, chmodSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULTS, PUBLIC_KEYS, resolveConfig, loadConfigFile, setConfigKey, unsetConfigKey, parseConfigFile } from '../../src/core/config.js';
import { effectivePolicy } from '../../src/core/policy.js';
import { makeTestEnv } from '../helpers/env.js';

test('régression #1 — absent ≠ désactivé : un config.json partiel ne désactive rien', () => {
  const t = makeTestEnv();
  try {
    const file = join(t.root, 'config.json');
    // Le bug de référence : écrire juste le chemin de Chrome désactivait toute la politique.
    writeFileSync(file, JSON.stringify({ chromePath: '/usr/bin/chromium' }));
    const cfg = resolveConfig(loadConfigFile(file));
    assert.deepEqual(cfg.allowedDomains, DEFAULTS.allowedDomains);
    assert.ok(cfg.allowedDomains.length > 0, 'le défaut de l\'allowlist est une liste non vide');
    assert.equal(cfg.headless, true);
    assert.equal(cfg.allowEval, false);
    const pol = effectivePolicy(cfg);
    assert.deepEqual(pol.allowedDomains, DEFAULTS.allowedDomains);
  } finally { t.cleanup(); }
});

test('absent ≠ désactivé : chaque clé absente prend son défaut, chaque clé explicite est respectée', () => {
  const empty = resolveConfig({});
  for (const k of PUBLIC_KEYS) assert.deepEqual(empty[k], DEFAULTS[k], `défaut de ${k}`);
  assert.equal(resolveConfig({ headless: false }).headless, false, 'false explicite respecté');
  assert.deepEqual(resolveConfig({ allowedDomains: [] }).allowedDomains, [], '[] explicite = tout bloquer');
});

test('absent ≠ désactivé : aucun `?? false` / `|| false` / `?? []` dans le code source', () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts')) {
        readFileSync(p, 'utf8').split('\n').forEach((l, i) => {
          if (!/^\s*(\*|\/\/)/.test(l) && /(\?\?|\|\|)\s*(false|\[\])/.test(l)) offenders.push(`${p}:${i + 1}: ${l.trim()}`);
        });
      }
    }
  };
  walk(join(process.cwd(), 'src'));
  assert.deepEqual(offenders, []);
});

test('clé inconnue ou mal typée : refus explicite (une faute de frappe ne doit pas être ignorée)', () => {
  assert.throws(() => parseConfigFile('{"allowedDomain": ["a.com"]}', 'c.json'), /allowedDomain/);
  assert.throws(() => parseConfigFile('{"allowEval": "false"}', 'c.json'), /allowEval/);
  assert.throws(() => parseConfigFile('{"allowedDomains": "a.com"}', 'c.json'), /allowedDomains/);
  assert.throws(() => parseConfigFile('{nope', 'c.json'), /JSON/);
});

const SAMPLE: Record<string, { raw: string; value: unknown }> = {
  chromePath: { raw: '/opt/chrome/chrome', value: '/opt/chrome/chrome' },
  headless: { raw: 'false', value: false },
  allowedDomains: { raw: 'example.org,*.test.local', value: ['example.org', '*.test.local'] },
  allowEval: { raw: 'true', value: true },
  allowDownload: { raw: 'true', value: true },
  allowUpload: { raw: 'true', value: true },
  allowCookies: { raw: 'true', value: true },
  allowConsole: { raw: 'false', value: false },
  allowPrivateNetwork: { raw: 'true', value: true },
  blockTrackers: { raw: 'false', value: false },
  contentBoundaries: { raw: 'false', value: false },
  transport: { raw: 'tcp', value: 'tcp' },
  port: { raw: '7444', value: 7444 },
  cdpUrl: { raw: 'http://127.0.0.1:9222', value: 'http://127.0.0.1:9222' },
  windowsProfilesDir: { raw: '/mnt/c/Users/Florent Didelot/grasp-profiles', value: '/mnt/c/Users/Florent Didelot/grasp-profiles' },
  snapMax: { raw: '20000', value: 20000 },
  textMax: { raw: '8000', value: 8000 },
  diffMax: { raw: '6000', value: 6000 },
  stableTimeoutMs: { raw: '0', value: 0 },
  inputDeliveryMs: { raw: '500', value: 500 },
  maxTabs: { raw: '3', value: 3 },
  fallbackEngine: { raw: 'playwright', value: 'playwright' },
  proxyServer: { raw: 'socks5://127.0.0.1:1080', value: 'socks5://127.0.0.1:1080' },
  proxyBypassList: { raw: '*.local,<-loopback>', value: ['*.local', '<-loopback>'] },
  hostResolverRules: { raw: 'MAP site.exemple.com 127.0.0.1:8443, EXCLUDE localhost', value: ['MAP site.exemple.com 127.0.0.1:8443', 'EXCLUDE localhost'] },
  ignoreCertErrorsFor: { raw: 'site.exemple.com', value: ['site.exemple.com'] },
  browserMaxRssMb: { raw: '800', value: 800 },
  browserMaxAgeMin: { raw: '0.5', value: 0.5 },
  maxSessions: { raw: '4', value: 4 },
};

test('régression #4 — config set persiste chaque clé publique (relecture du fichier)', () => {
  assert.deepEqual([...PUBLIC_KEYS].sort(), Object.keys(SAMPLE).sort(), 'chaque clé publique a un cas de test');
  const t = makeTestEnv();
  try {
    const dir = join(t.root, 'cfg');
    mkdirSync(dir, { mode: 0o700 });
    const file = join(dir, 'config.json');
    for (const k of PUBLIC_KEYS) {
      setConfigKey(file, k, SAMPLE[k]!.raw);
      const onDisk = JSON.parse(readFileSync(file, 'utf8'));
      assert.deepEqual(onDisk[k], SAMPLE[k]!.value, `${k} non persisté`);
      assert.deepEqual(resolveConfig(loadConfigFile(file))[k], SAMPLE[k]!.value);
    }
    assert.equal(statSync(file).mode & 0o777, 0o600);
    unsetConfigKey(file, 'allowEval');
    assert.equal('allowEval' in JSON.parse(readFileSync(file, 'utf8')), false);
  } finally { t.cleanup(); }
});

test('régression #4 — un écrivain qui ne peut pas écrire échoue bruyamment', () => {
  const t = makeTestEnv();
  try {
    const dir = join(t.root, 'ro');
    mkdirSync(dir, { mode: 0o700 });
    const file = join(dir, 'config.json');
    writeFileSync(file, '{}', { mode: 0o600 });
    chmodSync(dir, 0o500);
    chmodSync(file, 0o400);
    assert.throws(() => setConfigKey(file, 'allowEval', 'true'), /EACCES|permission|écri/i);
    assert.equal(readFileSync(file, 'utf8'), '{}');
    chmodSync(dir, 0o700);
  } finally { t.cleanup(); }
});

test('config set : valeur invalide ou clé inconnue → erreur, fichier inchangé', () => {
  const t = makeTestEnv();
  try {
    const file = join(t.root, 'config.json');
    writeFileSync(file, '{"headless":true}', { mode: 0o600 });
    assert.throws(() => setConfigKey(file, 'headless', 'oui'), /headless/);
    assert.throws(() => setConfigKey(file, 'nimporte', '1'), /nimporte/);
    assert.throws(() => setConfigKey(file, 'port', '99999'), /port/);
    assert.throws(() => setConfigKey(file, 'transport', 'udp'), /transport/);
    assert.throws(() => setConfigKey(file, 'cdpUrl', 'pas-une-url'), /cdpUrl/);
    assert.equal(readFileSync(file, 'utf8'), '{"headless":true}');
  } finally { t.cleanup(); }
});

test('windowsProfilesDir : chemin /mnt/<lecteur>/… ou C:\\…, sinon refus', () => {
  assert.throws(() => parseConfigFile('{"windowsProfilesDir": "/home/u/p"}', 'c.json'), /windowsProfilesDir/);
  assert.throws(() => parseConfigFile('{"windowsProfilesDir": "relatif"}', 'c.json'), /windowsProfilesDir/);
  assert.deepEqual(parseConfigFile(JSON.stringify({ windowsProfilesDir: 'D:\\grasp\\profiles' }), 'c.json'), { windowsProfilesDir: 'D:\\grasp\\profiles' });
});

test('recyclage et plafond : désactivés par défaut (absent ≠ désactivé), « none » = null explicite, valeurs bornées', () => {
  const d = resolveConfig({});
  assert.deepEqual([d.browserMaxRssMb, d.browserMaxAgeMin, d.maxSessions], [null, null, null]);
  // Un fichier partiel n'active ni ne désactive rien d'autre.
  const partial = resolveConfig(parseConfigFile('{"browserMaxRssMb": 800}', 'c.json'));
  assert.deepEqual([partial.browserMaxRssMb, partial.browserMaxAgeMin, partial.maxSessions, partial.allowConsole], [800, null, null, true]);
  assert.deepEqual(parseConfigFile('{"browserMaxAgeMin": null, "maxSessions": null}', 'c.json'), { browserMaxAgeMin: null, maxSessions: null });
  for (const bad of ['{"browserMaxRssMb": 0}', '{"browserMaxRssMb": 1.5}', '{"browserMaxRssMb": "800"}', '{"browserMaxAgeMin": 0}', '{"browserMaxAgeMin": -1}', '{"maxSessions": 0}']) {
    assert.throws(() => parseConfigFile(bad, 'c.json'), /browserMax|maxSessions/, bad);
  }
  const t = makeTestEnv();
  try {
    const file = join(t.root, 'config.json');
    assert.equal(setConfigKey(file, 'browserMaxRssMb', 'none'), null);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { browserMaxRssMb: null });
    assert.throws(() => setConfigKey(file, 'browserMaxAgeMin', '1e3'), /browserMaxAgeMin/);
    assert.throws(() => setConfigKey(file, 'browserMaxAgeMin', '0'), /browserMaxAgeMin/);
    assert.equal(setConfigKey(file, 'browserMaxAgeMin', '0.02'), 0.02);
  } finally { t.cleanup(); }
});
