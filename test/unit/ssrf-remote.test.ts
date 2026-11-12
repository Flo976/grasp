import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkNavigation, routeOf } from '../../src/core/policy.js';
import { mappedTarget, proxyResolves } from '../../src/core/remote.js';
import { mergeHostResolverRules } from '../../src/browser/args.js';

const privateDns = async () => ['10.0.0.5'];
const base = { allowedDomains: ['*.exemple.test', 'site.exemple.test'], allowPrivateNetwork: false };

test('mappedTarget : comme Chrome — EXCLUDE prioritaire, première règle MAP, motif avec ou sans port', () => {
  const rules = ['EXCLUDE secret.exemple.test', 'MAP *.exemple.test:443 127.0.0.1:8443', 'MAP *.exemple.test 127.0.0.1:8080', 'MAP [::2] [::1]:9'];
  assert.deepEqual(mappedTarget(rules, 'a.exemple.test', 443), { rule: 'MAP *.exemple.test:443 127.0.0.1:8443', target: '127.0.0.1' });
  assert.deepEqual(mappedTarget(rules, 'a.exemple.test', 80), { rule: 'MAP *.exemple.test 127.0.0.1:8080', target: '127.0.0.1' });
  assert.equal(mappedTarget(rules, 'secret.exemple.test', 80), null);
  assert.equal(mappedTarget(rules, 'exemple.test', 80), null);
  assert.equal(mappedTarget(rules, '[::2]', 80)?.target, '[::1]');
  assert.equal(mappedTarget(['MAP x.test ~NOTFOUND'], 'x.test', 80)?.target, '~NOTFOUND');
});

test('proxyResolves : http/https/socks5 oui, socks4 non, contournement (exact, joker, .domaine, <local>)', () => {
  assert.equal(proxyResolves(null, [], 'a.test'), false);
  assert.equal(proxyResolves('socks4://127.0.0.1:1080', [], 'a.test'), false);
  for (const p of ['socks5://127.0.0.1:1080', 'http://127.0.0.1:3128', 'https://p.test:443']) assert.equal(proxyResolves(p, [], 'a.test'), true, p);
  const p = 'socks5://127.0.0.1:1080';
  assert.equal(proxyResolves(p, ['a.test'], 'a.test'), false);
  assert.equal(proxyResolves(p, ['*.corp'], 'x.corp'), false);
  assert.equal(proxyResolves(p, ['.corp'], 'x.corp'), false);
  assert.equal(proxyResolves(p, ['http://x.corp:8080'], 'x.corp'), false);
  assert.equal(proxyResolves(p, ['<local>'], 'intranet'), false);
  assert.equal(proxyResolves(p, ['<local>', '10.0.0.0/8', '<-loopback>'], 'a.test'), true);
});

test('checkNavigation : règle MAP → cible littérale admise sans DNS ; cible nom → jugée ; sans règle → DNS', async () => {
  let asked = 0;
  const dns = async () => { asked++; return ['10.0.0.5']; };
  const mapped = { ...base, hostResolverRules: ['MAP site.exemple.test 127.0.0.1:8443'] };
  assert.equal((await checkNavigation(mapped, 'https://site.exemple.test/', dns)).allowed, true);
  assert.equal(asked, 0, 'aucune résolution du nom mappé');
  assert.equal((await checkNavigation({ ...base, hostResolverRules: ['MAP *.exemple.test localhost:8080'] }, 'http://a.exemple.test/', dns)).allowed, true);
  const viaName = await checkNavigation({ ...base, hostResolverRules: ['MAP site.exemple.test interne.test'] }, 'http://site.exemple.test/', dns);
  assert.equal(viaName.allowed, false);
  assert.match(viaName.reason, /interne\.test.*10\.0\.0\.5/);
  const unmapped = await checkNavigation(base, 'http://site.exemple.test/', privateDns);
  assert.equal(unmapped.allowed, false);
  assert.match(unmapped.reason, /SSRF/);
  // L'allowlist porte toujours sur le nom : une règle ne fait admettre aucun nom.
  assert.equal((await checkNavigation({ ...mapped, allowedDomains: ['127.0.0.1'] }, 'https://site.exemple.test/', dns)).allowed, false);
});

test('checkNavigation : derrière un proxy qui résout, pas de DNS local ; littéraux et *.localhost toujours jugés', async () => {
  let asked = 0;
  const dns = async () => { asked++; return ['10.0.0.5']; };
  const viaProxy = { ...base, allowedDomains: ['*'], proxyServer: 'socks5://127.0.0.1:1080', proxyBypassList: ['direct.exemple.test'] };
  assert.equal((await checkNavigation(viaProxy, 'http://site.exemple.test/', dns)).allowed, true);
  assert.equal(asked, 0);
  assert.equal((await checkNavigation(viaProxy, 'http://direct.exemple.test/', dns)).allowed, false, 'contournement : contrôle complet');
  assert.equal((await checkNavigation(viaProxy, 'http://169.254.169.254/', dns)).allowed, false);
  assert.equal((await checkNavigation(viaProxy, 'http://app.localhost/', dns)).allowed, false);
  assert.equal((await checkNavigation({ ...viaProxy, proxyServer: 'socks4://127.0.0.1:1080' }, 'http://site.exemple.test/', dns)).allowed, false, 'socks4 : Chrome résout lui-même');
  assert.equal(routeOf(viaProxy, 'site.exemple.test', 80).kind, 'proxy');
});

test('mergeHostResolverRules : un seul drapeau, règles concaténées dans l\'ordre, sans doublon', () => {
  const out = mergeHostResolverRules(['--a', '--host-resolver-rules=MAP a.test 127.0.0.1:1, MAP b.test 127.0.0.1:2', '--b', '--host-resolver-rules=MAP *.test 127.0.0.1, MAP a.test 127.0.0.1:1', 'about:blank']);
  assert.deepEqual(out, ['--a', '--host-resolver-rules=MAP a.test 127.0.0.1:1, MAP b.test 127.0.0.1:2, MAP *.test 127.0.0.1', '--b', 'about:blank']);
  assert.deepEqual(mergeHostResolverRules(['--a', 'about:blank']), ['--a', 'about:blank']);
});
