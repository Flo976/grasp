import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyIp, isLocalhostName } from '../../src/core/ssrf.js';
import { checkNavigation, effectivePolicy, isExplicitLocal } from '../../src/core/policy.js';
import { resolveConfig } from '../../src/core/config.js';

const priv = (ip: string) => classifyIp(ip) !== null && classifyIp(ip) !== undefined;

test('IPv4 privées et réservées : RFC 1918, boucle, lien local (métadonnées), CGNAT, 0/8, multicast, réservées', () => {
  for (const ip of ['10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.254', '192.168.1.1', '127.0.0.1', '127.8.9.10',
    '169.254.169.254', '169.254.0.1', '100.64.0.1', '100.127.255.255', '100.100.100.200', '0.0.0.0', '0.1.2.3',
    '198.18.0.1', '198.19.255.255', '192.88.99.1', '192.0.0.1', '192.0.2.1', '198.51.100.7', '203.0.113.9',
    '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255']) assert.ok(priv(ip), ip);
  assert.match(classifyIp('169.254.169.254')!, /métadonnées/);
});

test('IPv4 publiques, y compris aux bords des plages privées', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '169.253.0.1',
    '192.169.0.1', '11.0.0.1', '126.255.255.255', '128.0.0.1', '223.255.255.255', '192.0.0.9', '192.0.0.10', '198.20.0.1'])
    assert.equal(classifyIp(ip), null, ip);
});

test('IPv6 : boucle, non spécifiée, ULA, lien local, site local, multicast, documentation', () => {
  for (const ip of ['::1', '[::1]', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fe80::1%eth0', 'febf::1', 'fec0::1',
    'ff02::1', '2001:db8::1', '100::1', '64:ff9b:1::1', '3fff::1']) assert.ok(priv(ip), ip);
  for (const ip of ['2606:4700:4700::1111', '2a00:1450:4007:80b::200e', '[2001:4860:4860::8888]', 'fbff::1', 'fe00::1'])
    assert.equal(classifyIp(ip), null, ip);
});

test('IPv4 encapsulée dans IPv6 : mappée, compatible, NAT64, 6to4, Teredo — jugée sur l\'IPv4', () => {
  for (const ip of ['::ffff:127.0.0.1', '::ffff:7f00:1', '[::ffff:a9fe:a9fe]', '::ffff:10.0.0.1', '::127.0.0.1',
    '64:ff9b::a9fe:a9fe', '64:ff9b::10.1.2.3', '2002:c0a8:0101::1', '2002:7f00:1::',
    '2001:0:7f00:1::', '2001:0:808:808::f5ff:fffe' /* client Teredo inversé = 10.0.0.1 */])
    assert.ok(priv(ip), ip);
  assert.match(classifyIp('::ffff:169.254.169.254')!, /mappée.*métadonnées/);
  for (const ip of ['::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::1', '2001:0:808:808::f7f7:f7f7'])
    assert.equal(classifyIp(ip), null, ip);
});

test('ce qui n\'est pas une IP : undefined ; noms localhost', () => {
  for (const s of ['example.com', '', '1.2.3', '256.0.0.1', '::g', 'localhost']) assert.equal(classifyIp(s), undefined, s);
  assert.ok(isLocalhostName('localhost') && isLocalhostName('app.localhost'));
  assert.ok(!isLocalhostName('localhost.example.com') && !isLocalhostName('notlocalhost'));
});

const DNS: Record<string, string[]> = {
  'public.exemple.com': ['93.184.216.34', '2606:2800:220:1::1'],
  'interne.exemple.com': ['10.0.0.5'],
  'mixte.exemple.com': ['93.184.216.34', '169.254.169.254'],
  'mappe.exemple.com': ['::ffff:127.0.0.1'],
  'vide.exemple.com': [],
};
const fakeDns = async (h: string) => {
  const r = DNS[h];
  if (r === undefined) throw Object.assign(new Error('introuvable'), { code: 'ENOTFOUND' });
  return r;
};
const pol = (allowedDomains: string[], allowPrivateNetwork?: boolean) =>
  effectivePolicy(resolveConfig({ allowedDomains, ...(allowPrivateNetwork !== undefined ? { allowPrivateNetwork } : {}) }));
const nav = (p: ReturnType<typeof pol>, url: string) => checkNavigation(p, url, fakeDns);

test('défaut : l\'usage local (allowlist par défaut, littéraux) reste permis, sans DNS', async () => {
  const p = effectivePolicy(resolveConfig({}));
  assert.equal(p.allowPrivateNetwork, false);
  const noDns = async () => { throw new Error('DNS interdit ici'); };
  for (const u of ['http://127.0.0.1:8080/', 'http://localhost:3000/x', 'http://[::1]:5173/', 'about:blank']) {
    assert.equal((await checkNavigation(p, u, noDns)).allowed, true, u);
  }
});

test('un nom de l\'allowlist qui résout en privé est refusé ; public admis', async () => {
  const p = pol(['*.exemple.com']);
  assert.equal((await nav(p, 'https://public.exemple.com/')).allowed, true);
  const r = await nav(p, 'https://interne.exemple.com/');
  assert.equal(r.allowed, false);
  assert.match(r.reason, /interne\.exemple\.com résout vers une adresse privée \(10\.0\.0\.0\/8\) \(10\.0\.0\.5\)/);
  assert.match((await nav(p, 'https://mixte.exemple.com/')).reason, /métadonnées/, 'une seule adresse privée suffit');
  assert.match((await nav(p, 'https://mappe.exemple.com/')).reason, /mappée/);
  assert.match((await nav(p, 'https://absent.exemple.com/')).reason, /résolution DNS impossible.*ENOTFOUND/, 'fail-closed');
  assert.match((await nav(p, 'https://vide.exemple.com/')).reason, /vide/);
  // Un nom exact (pas un littéral) n'est pas un consentement au réseau privé
  assert.equal((await nav(pol(['interne.exemple.com']), 'https://interne.exemple.com/')).allowed, false);
});

test('allowlist d\'abord : un hôte hors liste est refusé sans résolution DNS', async () => {
  const noDns = async () => { throw new Error('DNS interdit ici'); };
  const r = await checkNavigation(pol(['127.0.0.1']), 'https://interne.exemple.com/', noDns);
  assert.match(r.reason, /hors allowlist/);
});

test('littéraux privés non inscrits tels quels : refusés même avec « * » ; inscrits : permis', async () => {
  const star = pol(['*']);
  for (const u of ['http://169.254.169.254/latest/meta-data/', 'http://10.0.0.1/', 'http://127.0.0.1/', 'http://0.0.0.0/',
    'http://[::ffff:127.0.0.1]/', 'http://[fd00::1]/', 'http://localhost/', 'http://app.localhost/', 'http://2130706433/', 'http://0x7f.1/']) {
    assert.equal((await nav(star, u)).allowed, false, u);
  }
  assert.equal((await nav(star, 'http://8.8.8.8/')).allowed, true);
  assert.equal((await nav(pol(['*', '10.0.0.1']), 'http://10.0.0.1/')).allowed, true);
  assert.equal((await nav(pol(['app.localhost']), 'http://app.localhost:8080/')).allowed, true);
  assert.equal((await nav(pol(['*.localhost']), 'http://app.localhost/')).allowed, false, 'un joker n\'est pas une inscription explicite');
  assert.ok(isExplicitLocal(['[::1]'], '[::1]') && !isExplicitLocal(['*'], '127.0.0.1') && !isExplicitLocal(['exemple.com'], 'exemple.com'));
});

test('allowPrivateNetwork=true : opt-out explicite, l\'allowlist reste appliquée', async () => {
  const p = pol(['*.exemple.com', '*.localhost'], true);
  assert.equal((await nav(p, 'https://interne.exemple.com/')).allowed, true);
  assert.equal((await nav(p, 'http://app.localhost/')).allowed, true);
  assert.equal((await nav(p, 'https://autre.org/')).allowed, false);
});
