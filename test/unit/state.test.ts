import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cookieAllowed, cookieOrigin, fromCdpCookie, normalizeOrigin, parseState, toCdpCookieParam } from '../../src/core/state.js';

test('state : cookie CDP → état → CookieParam (session sans expires, partitionKey gardée, champs dérivés retirés)', () => {
  const c = fromCdpCookie({
    name: 'sid', value: 'v', domain: '.exemple.com', path: '/', expires: 1900000000, session: false, httpOnly: true, secure: true,
    sameSite: 'None', priority: 'High', sourceScheme: 'Secure', sourcePort: 443, partitionKey: { topLevelSite: 'https://exemple.com', hasCrossSiteAncestor: false },
    ...{ size: 4 },
  } as Parameters<typeof fromCdpCookie>[0]);
  assert.deepEqual(c, {
    name: 'sid', value: 'v', domain: '.exemple.com', path: '/', expires: 1900000000, httpOnly: true, secure: true,
    sameSite: 'None', priority: 'High', sourceScheme: 'Secure', sourcePort: 443, partitionKey: { topLevelSite: 'https://exemple.com', hasCrossSiteAncestor: false },
  });
  assert.equal('size' in c, false);
  const s = fromCdpCookie({ name: 'p', value: '1', domain: 'h', path: '/', expires: -1, session: true, httpOnly: false, secure: false });
  assert.equal(s.expires, -1);
  assert.equal('expires' in toCdpCookieParam(s), false, 'cookie de session : pas d\'expires');
  assert.equal(toCdpCookieParam(c).expires, 1900000000);
});

test('state : allowlist des cookies et origine probable', () => {
  const local = ['127.0.0.1', 'localhost', '[::1]'];
  assert.equal(cookieAllowed(local, '127.0.0.1'), true);
  assert.equal(cookieAllowed(local, '::1'), true, 'IPv6 nue');
  assert.equal(cookieAllowed(local, '.example.com'), false);
  assert.equal(cookieAllowed(['*.exemple.com'], '.exemple.com'), true, 'cookie de domaine : un sous-domaine autorisé suffit');
  assert.equal(cookieAllowed(['*.exemple.com'], 'exemple.com'), false, 'hôte seul : *.exemple.com ne couvre pas exemple.com');
  assert.equal(cookieAllowed([], '127.0.0.1'), false, 'allowlist vide : rien');
  assert.equal(cookieOrigin({ name: 'a', value: '', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sourceScheme: 'NonSecure', sourcePort: 8080 }), 'http://127.0.0.1:8080');
  assert.equal(cookieOrigin({ name: 'a', value: '', domain: '.exemple.com', path: '/', expires: -1, httpOnly: false, secure: true, sourcePort: 443 }), 'https://exemple.com');
  assert.equal(normalizeOrigin('http://127.0.0.1:8080/x?y'), 'http://127.0.0.1:8080');
  assert.equal(normalizeOrigin('file:///etc/passwd'), null);
});

test('state : parseState — format Grasp, storageState Playwright, refus explicites', () => {
  const pw = parseState({
    cookies: [{ name: 'a', value: '1', domain: 'localhost', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }],
    origins: [{ origin: 'http://localhost:3000', localStorage: [{ name: 'k', value: 'v' }] }],
  });
  assert.equal(pw.cookies[0]!.sameSite, 'Lax');
  assert.deepEqual(pw.origins, [{ origin: 'http://localhost:3000', localStorage: [{ name: 'k', value: 'v' }] }]);
  const g = parseState({ format: 'grasp-state', version: 1, cookies: [{ name: 'b', value: '2', domain: '127.0.0.1' }], origins: [], sessionStorage: { origin: 'http://127.0.0.1:1/', items: [{ name: 'x', value: 'y' }] } });
  assert.deepEqual(g.cookies[0], { name: 'b', value: '2', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false });
  assert.deepEqual(g.sessionStorage, { origin: 'http://127.0.0.1:1', items: [{ name: 'x', value: 'y' }] });

  const refus: Array<[unknown, RegExp]> = [
    [[], /objet JSON attendu/],
    [{ hello: 1 }, /ce n'est pas un fichier d'état/],
    [{ format: 'autre', version: 1 }, /format inconnu/],
    [{ format: 'grasp-state', version: 2 }, /version 2 non prise en charge/],
    [{ cookies: [{ name: 'a', value: '1' }] }, /cookies\[0\] : champ « domain » requis/],
    [{ cookies: [{ name: 'a', value: 1, domain: 'h' }] }, /cookies\[0\] : champ « value » : string attendu/],
    [{ cookies: [{ name: 'a', value: '1', domain: 'h', sameSite: 'lax' }] }, /« sameSite » = "lax"/],
    [{ origins: [{ origin: 'file:///x', localStorage: [] }] }, /origine http\(s\) attendue/],
    [{ origins: [{ origin: 'http://h', localStorage: [{ name: 'k' }] }] }, /localStorage\[0\] : champ « value » requis/],
  ];
  for (const [v, re] of refus) assert.throws(() => parseState(v), (e: Error & { status?: number }) => re.test(e.message) && e.status === 400, JSON.stringify(v));
});
