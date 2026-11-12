import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChromeArgs } from '../../src/browser/launch.js';
import { buildWindowsChromeArgs } from '../../src/browser/windows.js';
import { networkArgs } from '../../src/browser/args.js';
import { parseConfigFile, resolveConfig, setConfigKey } from '../../src/core/config.js';
import { effectivePolicy, checkUrl } from '../../src/core/policy.js';
import { assertHostResolverRule, credentialFor, hostMatches, isCertHost, maskCredentials, parseHttpAuth } from '../../src/core/remote.js';
import { sessionOptionsOf } from '../../src/control/server.js';
import { makeTestEnv } from '../helpers/env.js';
import { join } from 'node:path';
import { mkdirSync, readFileSync } from 'node:fs';
import { GraspError } from '../../src/core/errors.js';

const net = { proxyServer: 'socks5://127.0.0.1:1080', proxyBypassList: ['*.local', '<-loopback>'], hostResolverRules: ['MAP site.exemple.com 127.0.0.1:8443', 'EXCLUDE localhost'] };

test('drapeaux réseau : --proxy-server, --proxy-bypass-list, --host-resolver-rules (un argument chacun, sans guillemets)', () => {
  assert.deepEqual(networkArgs(net), [
    '--proxy-server=socks5://127.0.0.1:1080',
    '--proxy-bypass-list=*.local;<-loopback>',
    '--host-resolver-rules=MAP site.exemple.com 127.0.0.1:8443, EXCLUDE localhost',
  ]);
  assert.deepEqual(networkArgs(undefined), []);
  assert.deepEqual(networkArgs({ proxyServer: null, proxyBypassList: ['*.local'], hostResolverRules: [] }), [], 'contournement sans proxy : rien');
});

test('Chrome Linux et chrome.exe reçoivent les mêmes drapeaux réseau, avant l\'URL de départ', () => {
  const lin = buildChromeArgs({ userDataDir: '/p', headless: true, env: {}, uid: 1000, shmBytes: null, port: 45678, network: net }).args;
  const win = buildWindowsChromeArgs({ userDataDirWin: 'C:\\p', headless: true, port: 45679, network: net });
  for (const args of [lin, win]) {
    for (const f of networkArgs(net)) assert.ok(args.includes(f), `${f} absent de ${args.join(' ')}`);
    assert.equal(args.at(-1), 'about:blank');
  }
  const none = buildChromeArgs({ userDataDir: '/p', headless: true, env: {}, uid: 1000, shmBytes: null, port: 45678 }).args;
  assert.ok(!none.some((a) => /proxy|host-resolver/.test(a)), 'aucun drapeau réseau par défaut');
  assert.ok(!buildWindowsChromeArgs({ userDataDirWin: 'C:\\p', headless: true, port: 1 }).some((a) => /proxy|host-resolver/.test(a)));
});

test('hostResolverRules : syntaxe validée (Chrome ignorerait une règle mal formée en silence)', () => {
  assert.equal(assertHostResolverRule('MAP  site.exemple.com   127.0.0.1:8443'), 'MAP site.exemple.com 127.0.0.1:8443');
  for (const ok of ['MAP *.exemple.com 127.0.0.1', 'MAP site.exemple.com:443 127.0.0.1:8443', 'EXCLUDE localhost', 'MAP * ~NOTFOUND', 'MAP a.test [::1]:8080']) assert.doesNotThrow(() => assertHostResolverRule(ok), ok);
  for (const bad of ['site.exemple.com 127.0.0.1', 'MAP site.exemple.com', 'MAP a b c', 'MAP a.test 127.0.0.1:99999', 'REMAP a b', 'MAP a,b c']) assert.throws(() => assertHostResolverRule(bad), /règle de résolution invalide/, bad);
  assert.throws(() => parseConfigFile('{"hostResolverRules": ["MAP site.exemple.com"]}', 'c.json'), /hostResolverRules/);
  assert.throws(() => parseConfigFile('{"hostResolverRules": "MAP a b"}', 'c.json'), /hostResolverRules/, 'un tableau est attendu');
});

test('proxyServer : schéma://hôte:port, jamais d\'identifiants ; config set refuse le reste', () => {
  const t = makeTestEnv();
  try {
    const dir = join(t.root, 'cfg');
    mkdirSync(dir, { mode: 0o700 });
    const file = join(dir, 'config.json');
    for (const bad of ['127.0.0.1:1080', 'socks5://127.0.0.1', 'ftp://h:1', 'socks5://u:p@127.0.0.1:1080', 'socks5://h:0']) {
      assert.throws(() => setConfigKey(file, 'proxyServer', bad), /proxyServer/, bad);
    }
    assert.equal(setConfigKey(file, 'proxyServer', 'http://127.0.0.1:3128'), 'http://127.0.0.1:3128');
    assert.throws(() => setConfigKey(file, 'ignoreCertErrorsFor', '*'), /\* seul refusé/);
    assert.throws(() => setConfigKey(file, 'hostResolverRules', 'MAP a'), /règle de résolution invalide/);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { proxyServer: 'http://127.0.0.1:3128' }, 'rien d\'invalide écrit');
  } finally { t.cleanup(); }
});

test('défauts : aucun proxy, aucune règle, certificats vérifiés ; la politique gelée les porte', () => {
  const p = effectivePolicy(resolveConfig({}));
  assert.equal(p.proxyServer, null);
  assert.deepEqual(p.proxyBypassList, []);
  assert.deepEqual(p.hostResolverRules, []);
  assert.deepEqual(p.ignoreCertErrorsFor, []);
  const q = effectivePolicy(resolveConfig({ ignoreCertErrorsFor: ['Site.Exemple.com'], hostResolverRules: ['MAP site.exemple.com 127.0.0.1:8443'] }));
  assert.deepEqual(q.ignoreCertErrorsFor, ['site.exemple.com']);
  assert.ok(Object.isFrozen(q.hostResolverRules));
  assert.ok(isCertHost('*.exemple.com') && isCertHost('site.exemple.com') && !isCertHost('*') && !isCertHost('a b'));
});

test('allowlist : porte sur le nom demandé, jamais sur l\'adresse vers laquelle une règle le mappe', () => {
  // MAP site.exemple.com 127.0.0.1:8443 : l'URL garde son nom ; 127.0.0.1 dans l'allowlist ne l'autorise pas.
  assert.equal(checkUrl(['127.0.0.1'], 'https://site.exemple.com/').allowed, false);
  assert.equal(checkUrl(['site.exemple.com'], 'https://site.exemple.com/').allowed, true);
  assert.equal(hostMatches(['*.exemple.com'], 'a.exemple.com'), '*.exemple.com');
  assert.equal(hostMatches(['*.exemple.com'], 'exemple.com'), null);
});

test('identifiants HTTP : analyse (mot de passe avec « : » et « @ »), erreurs sans jamais citer la valeur', () => {
  assert.deepEqual(parseHttpAuth('recette:p@ss:w0rd@Preprod.Exemple.com'), { host: 'preprod.exemple.com', username: 'recette', password: 'p@ss:w0rd' });
  assert.deepEqual(parseHttpAuth('u:p@127.0.0.1:8080'), { host: '127.0.0.1', port: 8080, username: 'u', password: 'p' });
  for (const bad of ['secretpass@host', 'u:secretpass', 'u:secretpass@', 'u:secretpass@ho st', 'u:secretpass@h:70000', ':secretpass@h']) {
    assert.throws(() => parseHttpAuth(bad), (e: Error) => !e.message.includes('secretpass') && /utilisateur:motdepasse@hôte/.test(e.message), bad);
  }
});

test('identifiants HTTP : confiés au seul hôte (et port, s\'il est précisé), masqués dans tout rapport', () => {
  const creds = [parseHttpAuth('u:p@preprod.exemple.com'), parseHttpAuth('v:q@127.0.0.1:8080')];
  assert.equal(credentialFor(creds, 'https://preprod.exemple.com/x')?.username, 'u');
  assert.equal(credentialFor(creds, 'https://PREPROD.exemple.com:8443/')?.username, 'u', 'sans port précisé : tout port');
  assert.equal(credentialFor(creds, 'https://evil.exemple.com/'), undefined);
  assert.equal(credentialFor(creds, 'https://preprod.exemple.com.evil.org/'), undefined);
  assert.equal(credentialFor(creds, 'http://127.0.0.1:8080/'), creds[1]);
  assert.equal(credentialFor(creds, 'http://127.0.0.1:9090/'), undefined, 'port précisé : ce port seulement');
  const masked = JSON.stringify(maskCredentials(creds));
  assert.ok(!/"u"|"p"|"v"|"q"|password|username/.test(masked), masked);
  assert.deepEqual(maskCredentials(creds), [{ host: 'preprod.exemple.com', credentials: '***' }, { host: '127.0.0.1:8080', credentials: '***' }]);
});

test('session : identifiants refusés pour un hôte hors allowlist (403), proxy validé, attach refusé', () => {
  const policy = effectivePolicy(resolveConfig({ allowedDomains: ['127.0.0.1', 'preprod.exemple.com'] }));
  const o = sessionOptionsOf({ httpAuth: 'u:secretpass@preprod.exemple.com', proxyServer: 'socks5://127.0.0.1:1080' }, policy, false);
  assert.equal(o.proxyServer, 'socks5://127.0.0.1:1080');
  assert.equal(o.httpAuth[0]?.host, 'preprod.exemple.com');
  const err = (body: Record<string, unknown>, status: number, attach = false) => assert.throws(() => sessionOptionsOf(body, policy, attach),
    (e: GraspError) => e.status === status && !e.message.includes('secretpass'), JSON.stringify(body));
  err({ httpAuth: 'u:secretpass@ailleurs.exemple.com' }, 403);
  err({ httpAuth: ['u:secretpass'] }, 400);
  err({ httpAuth: 42 }, 400);
  err({ httpAuth: ['u:secretpass@127.0.0.1', 'v:secretpass@127.0.0.1'] }, 400);
  err({ proxyServer: 'socks5://u:secretpass@127.0.0.1:1080' }, 400);
  err({ proxyServer: 'socks5://127.0.0.1:1080' }, 400, true);
  assert.deepEqual(sessionOptionsOf({}, policy, false), { httpAuth: [] });
});
