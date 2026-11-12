import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chmodSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Redactor, SecretStore, parseDomains, parseSecrets, removeSecret, secretAllowedOn, secretRef, setSecret } from '../../src/core/secrets.js';
import { redactResponse, withSecret } from '../../src/control/redact.js';
import { buildRequest, parseArgs, splitLine } from '../../src/core/script.js';
import { truncateText } from '../../src/core/limits.js';
import { redactUrl } from '../../src/core/console.js';
import { sendJson, request } from '../../src/core/http.js';
import { GraspError } from '../../src/core/errors.js';
import { makeTestEnv } from '../helpers/env.js';

test('secretRef : secret:NOM seulement si NOM est un nom valide', () => {
  assert.equal(secretRef('secret:MDP_PREPROD'), 'MDP_PREPROD');
  assert.equal(secretRef('secret:'), undefined);
  assert.equal(secretRef('secret:1abc'), undefined);
  assert.equal(secretRef('secret:a b'), undefined);
  assert.equal(secretRef('Secret:X'), undefined);
  assert.equal(secretRef('mon secret:X'), undefined);
});

test('buildRequest : fill secret:NOM envoie le nom, jamais une valeur ; run et CLI identiques', () => {
  const rq = buildRequest(parseArgs(['fill', '#mdp', 'secret:MDP', '--snap-diff']));
  assert.deepEqual(rq.body, { target: '#mdp', secret: 'MDP', snapDiff: true });
  const line = buildRequest(parseArgs(splitLine('fill #mdp secret:MDP --snap-diff')));
  assert.deepEqual(line.body, rq.body);
  assert.deepEqual(buildRequest(parseArgs(['fill', '#x', 'texte'])).body, { target: '#x', value: 'texte' });
  // type ne tape jamais « secret:NOM » tel quel (l'agent croirait avoir saisi le secret).
  assert.throws(() => buildRequest(parseArgs(['type', '#x', 'secret:MDP'])), /type ne prend pas de secret .*fill <sélecteur> secret:MDP/);
});

test('parseSecrets : format strict, messages sans la valeur', () => {
  const m = parseSecrets(JSON.stringify({ MDP: { value: 'motdepasse-1', domains: ['Preprod.Exemple.com', '*.exemple.org'] } }), 'f');
  assert.deepEqual(m.get('MDP'), { name: 'MDP', value: 'motdepasse-1', domains: ['preprod.exemple.com', '*.exemple.org'] });
  const bad: Array<[unknown, RegExp]> = [
    [{ MDP: { value: 'abc', domains: ['a.b'] } }, /trop courte/],
    [{ MDP: { value: 'valeur-ok', domains: [] } }, /liste non vide/],
    [{ MDP: { value: 'valeur-ok', domains: ['*'] } }, /« \* » refusé/],
    [{ MDP: { value: 'valeur-ok', domains: ['https://a.b'] } }, /n'est pas un nom d'hôte/],
    [{ MDP: { value: 'valeur-ok', domains: ['a.b:8443'] } }, /ni port/],
    [{ MDP: { value: 'valeur-ok', domains: ['a.b'], extra: 1 } }, /clé inconnue « extra »/],
    [{ 'MDP-1': { value: 'valeur-ok', domains: ['a.b'] } }, /nom de secret invalide/],
    [{ MDP: { value: 42, domains: ['a.b'] } }, /doit être une chaîne/],
    [[], /objet/],
  ];
  for (const [obj, re] of bad) {
    assert.throws(() => parseSecrets(JSON.stringify(obj), 'f'), (e: Error) => re.test(e.message) && !e.message.includes('valeur-ok'), JSON.stringify(obj));
  }
  assert.deepEqual(parseDomains(' a.b , *.c.d '), ['a.b', '*.c.d']);
  assert.throws(() => parseDomains(' , '), /au moins un domaine/);
});

test('secretAllowedOn : hôte de la page, jokers de sous-domaines, http(s) seulement', () => {
  assert.equal(secretAllowedOn(['preprod.exemple.com'], 'https://preprod.exemple.com:8443/login'), true);
  assert.equal(secretAllowedOn(['preprod.exemple.com'], 'https://evil.com/?preprod.exemple.com'), false);
  assert.equal(secretAllowedOn(['preprod.exemple.com'], 'https://preprod.exemple.com.evil.com/'), false);
  assert.equal(secretAllowedOn(['*.exemple.com'], 'https://a.exemple.com/'), true);
  assert.equal(secretAllowedOn(['*.exemple.com'], 'https://exemple.com/'), false);
  assert.equal(secretAllowedOn(['127.0.0.1'], 'http://localhost/'), false);
  assert.equal(secretAllowedOn(['127.0.0.1'], 'about:blank'), false);
  assert.equal(secretAllowedOn(['127.0.0.1'], 'file:///etc/passwd'), false);
});

test('Redactor : valeur brute, encodages URL/formulaire/JSON/HTML, la plus longue d\'abord', () => {
  const r = new Redactor();
  r.add('MDP', 'Sésame & co!');
  r.add('LONG', 'Sésame & co!-et-plus');
  const v = 'Sésame & co!';
  const s = [v, encodeURIComponent(v), new URLSearchParams({ x: v }).toString().slice(2), JSON.stringify(v).slice(1, -1), 'Sésame &amp; co!', 'Sésame & co!-et-plus'].join(' | ');
  assert.equal(r.redact(s), 'secret:MDP | secret:MDP | secret:MDP | secret:MDP | secret:MDP | secret:LONG');
  // Objets JSON : chaînes masquées à toute profondeur, clés intactes.
  assert.deepEqual(r.redactDeep({ a: [{ b: `x ${v} y` }], n: 3 }), { a: [{ b: 'x secret:MDP y' }], n: 3 });
  // Valeur trop courte : ignorée (le masquage abîmerait toute sortie).
  r.add('PIN', '12');
  assert.equal(r.redact('12 34'), '12 34');
});

test('Redactor : une valeur coupée par un budget (…, ligne « … tronqué ») ne laisse pas fuir son début', () => {
  const r = new Redactor();
  const v = 'TOKEN-a1b2c3d4e5f6g7h8i9';
  r.add('TOK', v);
  // Nom coupé à 80 caractères par le snapshot, ou ligne de console coupée.
  assert.equal(r.redact(`textbox "Clé"="${v.slice(0, 10)}…"`), 'textbox "Clé"="secret:TOK…"');
  // URL coupée par redactUrl.
  const url = redactUrl(`http://h/${'x'.repeat(130)}?q=${v}`);
  assert.ok(!r.redact(url).includes(v.slice(0, 6)), r.redact(url));
  // Sortie de text coupée au caractère près.
  const cut = truncateText(`aaa ${v} bbb`, 12);
  assert.ok(cut.includes(v.slice(0, 8)), 'prérequis : la coupure tombe dans la valeur');
  assert.ok(!r.redact(cut).includes(v.slice(0, 8)), r.redact(cut));
  // Un préfixe qui n'est pas en fin de coupure reste (texte ordinaire).
  assert.equal(r.redact('TOKEN-a1 ailleurs'), 'TOKEN-a1 ailleurs');
});

test('SecretStore : 0600 exigé, relu quand le fichier change, valeurs retirées toujours masquées', () => {
  const t = makeTestEnv();
  try {
    const dir = join(t.root, 'c');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, 'secrets.json');
    const store = new SecretStore(file);
    assert.deepEqual(store.list().secrets, []);
    setSecret(file, 'A', 'valeur-aaaa', ['a.test']);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(store.lookup('A').value, 'valeur-aaaa');
    setSecret(file, 'B', 'valeur-bbbb', ['b.test']);
    assert.deepEqual(store.list().secrets, [{ name: 'A', domains: ['a.test'] }, { name: 'B', domains: ['b.test'] }]);
    assert.equal(removeSecret(file, 'A'), true);
    assert.equal(removeSecret(file, 'A'), false);
    assert.throws(() => store.lookup('A'), (e: GraspError) => e.status === 404 && /secret « A » inconnu \(secrets : B\)/.test(e.message));
    assert.equal(store.redactor.redact('valeur-aaaa'), 'secret:A', 'une valeur retirée reste masquée jusqu\'à l\'arrêt');
    chmodSync(file, 0o640);
    assert.throws(() => store.lookup('B'), (e: GraspError) => e.status === 500 && /0640/.test(e.message));
    assert.match(store.list().error ?? '', /chmod 600/);
    chmodSync(file, 0o600);
    writeFileSync(file, '{ pas du json');
    assert.throws(() => store.lookup('B'), /JSON invalide/);
    assert.ok(!readFileSync(file, 'utf8').includes('valeur-bbbb'));
  } finally { t.cleanup(); }
});

test('withSecret : substitution pour fill seulement ; secretUse jamais accepté du client', () => {
  const t = makeTestEnv();
  try {
    const dir = join(t.root, 'c');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, 'secrets.json');
    setSecret(file, 'MDP', 'motdepasse-9', ['preprod.test']);
    const store = new SecretStore(file);
    assert.deepEqual(withSecret(store, '/fill', { target: '#m', secret: 'MDP', snapDiff: true }), { target: '#m', snapDiff: true, value: 'motdepasse-9', secretUse: { name: 'MDP', domains: ['preprod.test'] } });
    assert.deepEqual(withSecret(store, '/fill', { target: '#m', value: 'x' }), { target: '#m', value: 'x' });
    assert.throws(() => withSecret(store, '/fill', { target: '#m', value: 'x', secretUse: { name: 'MDP', domains: ['*'] } }), /champ interne/);
    assert.throws(() => withSecret(store, '/type', { target: '#m', secret: 'MDP' }), /n'est accepté que par fill/);
    assert.throws(() => withSecret(store, '/fill', { target: '#m', secret: 'MDP', value: 'x' }), /s'excluent/);
    assert.throws(() => withSecret(store, '/fill', { target: '#m', secret: 'AUTRE' }), (e: GraspError) => e.status === 404);
  } finally { t.cleanup(); }
});

test('redactResponse : JSON, texte et en-tête de note masqués, longueur recalculée ; binaire intact', async () => {
  const r = new Redactor();
  r.add('MDP', 'motdepasse-9');
  const png = Buffer.from('motdepasse-9');
  const srv = createServer((req, res) => {
    redactResponse(res, r);
    if (req.url === '/json') return sendJson(res, 200, { out: 'a motdepasse-9 b', error: 'x motdepasse-9' });
    if (req.url === '/bin') { res.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length }); res.end(png); return; }
    res.setHeader('x-grasp-notice', encodeURIComponent('note motdepasse-9'));
    const b = Buffer.from('ligne motdepasse-9\n');
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-length': b.length });
    res.end(b);
  });
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
  try {
    const ep = { transport: 'tcp' as const, host: '127.0.0.1', port: (srv.address() as { port: number }).port };
    assert.deepEqual((await request(ep, 'GET', '/json')).json(), { out: 'a secret:MDP b', error: 'x secret:MDP' });
    const tx = await request(ep, 'GET', '/text');
    assert.equal(tx.text(), 'ligne secret:MDP\n');
    assert.equal(decodeURIComponent(String(tx.headers['x-grasp-notice'])), 'note secret:MDP');
    assert.deepEqual((await request(ep, 'GET', '/bin')).body, png);
  } finally { srv.close(); }
});
