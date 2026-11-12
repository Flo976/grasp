import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NetworkLog, formatNet, isFailed, networkLosses, parseRequestTarget, parseStatus, parseTypes, requestMatches, urlMatches, type NetEntry } from '../../src/core/network.js';
import { describeExpected, expectSpecOf } from '../../src/core/expect.js';
import { buildRequest, parseArgs, splitLine } from '../../src/core/script.js';
import { compileScript } from '../../src/control/run.js';
import { GraspError } from '../../src/core/errors.js';

const T = 1000; // horodatage CDP de départ (secondes)

test('NetworkLog : départ, réponse, fin (durée par horodatages CDP), échec, annulation, blocage, cache', () => {
  const n = new NetworkLog();
  n.start('1', { method: 'POST', url: 'http://h/api/commande?qte=2', type: 'Fetch', ts: T });
  n.response('1', 201, 'Created', false);
  n.finish('1', T + 0.034);
  n.start('2', { method: 'GET', url: 'http://h/absent.png', type: 'Image', ts: T });
  n.response('2', 404, 'Not Found', false);
  n.finish('2', T + 0.01);
  n.start('3', { method: 'GET', url: 'http://localhost/api/data', type: 'XHR', ts: T });
  n.fail('3', T + 0.002, 'net::ERR_FAILED');
  n.start('4', { method: 'GET', url: 'http://h/annule', type: 'Fetch', ts: T });
  n.fail('4', T + 0.005, 'net::ERR_ABORTED', { canceled: true });
  n.start('5', { method: 'GET', url: 'http://pub.example/t.js', type: 'Script', ts: T });
  n.fail('5', T + 0.001, 'net::ERR_BLOCKED_BY_CLIENT', { blocked: true });
  n.start('6', { method: 'GET', url: 'http://h/app.css', type: 'Stylesheet', ts: T, frame: true });
  n.cached('6');
  n.response('6', 200, '', true);
  n.finish('6', T);
  n.start('7', { method: 'GET', url: 'http://h/api/lent', type: 'Fetch', ts: T });
  const r = n.query();
  assert.equal(r.seq, 7);
  assert.deepEqual(r.entries.map(formatNet).map((l) => l.replace(/· \d+ ms/, '· N ms')), [
    '#1 POST http://h/api/commande?qte=2 → 201 Created · N ms · fetch',
    '#2 GET http://h/absent.png → 404 Not Found · N ms · image',
    '#3 GET http://localhost/api/data → net::ERR_FAILED · N ms · xhr',
    '#4 GET http://h/annule → annulée · N ms · fetch',
    '#5 GET http://pub.example/t.js → net::ERR_BLOCKED_BY_CLIENT [bloquée par Grasp] · N ms · script',
    '#6 GET http://h/app.css → 200 · N ms · stylesheet · cache · iframe',
    '#7 GET http://h/api/lent → en cours · N ms · fetch',
  ]);
  assert.equal(r.entries[0]!.ms, 34, 'durée = fin − départ, horloge CDP');
  assert.equal(r.entries[6]!.pending, true);
  assert.deepEqual(r.entries.filter(isFailed).map((e) => e.seq), [2, 3, 5], 'échecs : ≥ 400, net::ERR, bloquées ; pas les annulations');
  assert.deepEqual(n.query({ failed: true }).entries.map((e) => e.seq), [2, 3, 5]);
  assert.deepEqual(n.query({ types: ['xhr', 'fetch'] }).entries.map((e) => e.seq), [1, 3, 4, 7]);
  assert.deepEqual(n.query({ since: 5 }).entries.map((e) => e.seq), [6, 7]);
  // Le journal n'est pas modifié par la lecture d'une requête en cours.
  n.response('7', 200, 'OK', false);
  n.finish('7', T + 0.7);
  assert.equal(n.query({ since: 6 }).entries[0]!.ms, 700);
});

test('NetworkLog : URL masquée (identifiants, paramètres sensibles), data:/blob: non journalisées mais suivies', () => {
  const n = new NetworkLog();
  n.start('a', { method: 'POST', url: 'http://u:mdp@h/api/secret?token=abc123&page=2', type: 'Fetch', ts: T });
  n.start('b', { method: 'GET', url: 'data:image/png;base64,AAAA', type: 'Image', ts: T });
  const [e] = n.query().entries;
  assert.equal(e!.url, 'http://h/api/secret?token=***&page=2');
  assert.equal(n.query().entries.length, 1, 'data: absente du journal');
  assert.deepEqual(n.request('b'), { method: 'GET', url: 'data:image/png;base64,AAAA' }, 'mais méthode/URL brutes gardées pour la console');
  assert.deepEqual(n.request('a'), { method: 'POST', url: 'http://u:mdp@h/api/secret?token=abc123&page=2' });
  n.finish('a', T + 1);
  assert.equal(n.request('a'), undefined, 'plus suivie une fois terminée');
  assert.doesNotMatch(JSON.stringify(n.query()), /abc123|mdp/);
});

test('NetworkLog : redirection = un saut clos avec son statut, puis une nouvelle entrée ; documents abandonnés', () => {
  const n = new NetworkLog();
  n.start('r', { method: 'GET', url: 'http://h/redirect-to?u=/b', type: 'Document', ts: T });
  n.start('r', { method: 'GET', url: 'http://h/b', type: 'Document', ts: T + 0.02, redirect: { status: 302, statusText: 'Found' } });
  n.response('r', 200, 'OK', false);
  n.finish('r', T + 0.05);
  const es = n.query().entries;
  assert.deepEqual(es.map((e) => [e.seq, e.url, e.status, e.ms, e.pending]), [[1, 'http://h/redirect-to?u=%2Fb', 302, 20, undefined], [2, 'http://h/b', 200, 30, undefined]]);
  n.start('x', { method: 'GET', url: 'http://h/lent', type: 'Fetch', ts: T });
  const docSeq = n.seq;
  n.start('d', { method: 'GET', url: 'http://h/suivante', type: 'Document', ts: T });
  n.abandonPending(docSeq);
  const after = n.query({ since: 2 }).entries;
  assert.equal(after[0]!.error, 'annulée', 'requête de l\'ancien document close');
  assert.equal(after[1]!.pending, true, 'le nouveau document reste en cours');
});

test('NetworkLog : tampon circulaire (dropped), --max (omitted), since au-delà du seq → 409', () => {
  const n = new NetworkLog(5);
  for (let i = 1; i <= 8; i++) n.start(String(i), { method: 'GET', url: `http://h/${i}`, type: 'Fetch', ts: T });
  const r = n.query({ since: 1, limit: 2 });
  assert.deepEqual(r.entries.map((e) => e.seq), [7, 8]);
  assert.equal(r.dropped, 2, 'seq 2 et 3 tombés du tampon');
  assert.equal(r.omitted, 3);
  assert.throws(() => n.query({ since: 9 }), (e: GraspError) => e.status === 409 && /--since 0/.test(e.message));
  assert.deepEqual(networkLosses({ since: 4, omitted: 3, dropped: 2 }, true), [
    'AVERTISSEMENT : 2 requête(s) perdue(s) avant lecture (journal circulaire de 1000 requêtes)',
    'AVERTISSEMENT : 3 requête(s) plus ancienne(s) non affichée(s) (100 au plus par action) — grasp network --since 4 --max 1000',
  ]);
});

test('formatNet : URL coupée à 150 caractères', () => {
  const e: NetEntry = { seq: 1, at: 0, method: 'GET', url: `http://h/${'a'.repeat(300)}`, type: 'fetch', status: 200, ms: 3 };
  const l = formatNet(e);
  assert.match(l, /^#1 GET http:\/\/h\/a+… → 200 · 3 ms · fetch$/);
  assert.equal(l.indexOf('…'), '#1 GET '.length + 150);
});

test('parseTypes, parseStatus, parseRequestTarget : validation', () => {
  assert.deepEqual(parseTypes('XHR, fetch'), ['xhr', 'fetch']);
  assert.throws(() => parseTypes('ajax'), /type de requête inconnu « ajax »/);
  assert.throws(() => parseTypes(','), /au moins un type/);
  const s = parseStatus('2xx,304');
  assert.deepEqual([200, 204, 299, 304, 301, 404].map(s), [true, true, true, true, false, false]);
  assert.equal(parseStatus('201')(201), true);
  assert.equal(parseStatus('4XX')(422), true);
  for (const bad of ['', '2x', '600', '20', 'ok', '2xx,']) assert.throws(() => parseStatus(bad), /statut attendu/, bad);
  assert.deepEqual(parseRequestTarget('POST /api/commande'), { method: 'POST', url: '/api/commande' });
  assert.deepEqual(parseRequestTarget('/api/commande'), { url: '/api/commande' });
  assert.deepEqual(parseRequestTarget('http://h/api'), { url: 'http://h/api' });
  assert.throws(() => parseRequestTarget('  '), /motif d'URL vide/);
});

test('urlMatches : chemin exact (requête ignorée sauf ? dans le motif), URL absolue, ~ contient, --regex ; jamais sur l\'URL brute', () => {
  const u = 'http://127.0.0.1:8080/api/commande?qte=2';
  assert.equal(urlMatches(u, '/api/commande', 'exact'), true);
  assert.equal(urlMatches(u, '/api/command', 'exact'), false, 'égalité, pas préfixe');
  assert.equal(urlMatches(u, '/api/commande?qte=2', 'exact'), true);
  assert.equal(urlMatches(u, '/api/commande?qte=3', 'exact'), false);
  assert.equal(urlMatches(u, 'http://127.0.0.1:8080/api/commande', 'exact'), true);
  assert.equal(urlMatches(u, 'http://localhost:8080/api/commande', 'exact'), false);
  assert.equal(urlMatches(u, '/api/', 'contains'), true);
  assert.equal(urlMatches(u, 'qte=\\d', 'regex'), true);
  // URL masquée dans le journal : un motif ne peut pas sonder la valeur d'un jeton.
  assert.equal(urlMatches('http://h/api/x?token=***', 'token=abc', 'contains'), false);
  const e: NetEntry = { seq: 1, at: 0, method: 'POST', url: u, type: 'fetch', status: 201 };
  assert.equal(requestMatches(e, { method: 'POST', url: '/api/commande' }, 'exact'), true);
  assert.equal(requestMatches(e, { method: 'GET', url: '/api/commande' }, 'exact'), false);
  assert.equal(requestMatches(e, { url: '/api/commande' }, 'exact'), true, 'sans méthode : toute méthode');
});

test('expect request : syntaxe (CLI et run), validation, description', () => {
  const r = (line: string) => buildRequest(parseArgs(splitLine(line)));
  assert.deepEqual(r('expect request "POST /api/commande"').body, { kind: 'request', target: 'POST /api/commande', match: 'exact' });
  assert.deepEqual(r('expect request "POST /api/commande" 201').body, { kind: 'request', target: 'POST /api/commande', match: 'exact', status: '201' });
  assert.deepEqual(r("expect request ~ '/api/' 4xx,5xx --since 3 --timeout 0").body, { kind: 'request', target: '/api/', match: 'contains', status: '4xx,5xx', since: '3', timeout: '0' });
  assert.deepEqual(r("expect request --regex 'POST /api/commande\\?qte=\\d+$'").body, { kind: 'request', target: 'POST /api/commande\\?qte=\\d+$', match: 'regex' });
  assert.throws(() => r('expect request'), /usage : grasp expect request \[~\] "<MÉTHODE> <chemin\|url>"/);
  assert.throws(() => r('expect request /a 2xx en-trop'), /usage : grasp expect request/);
  assert.throws(() => r('expect request /a 2x'), /statut attendu « 2x »/);
  assert.throws(() => r('expect request ~ /a --regex'), /s'excluent/);
  assert.throws(() => r("expect request --regex '('"), /expression régulière invalide/);
  assert.throws(() => r('expect request /a --scope main'), /--scope ne s'applique pas à expect request/);
  assert.throws(() => r('expect request /a --ignore x'), /--ignore ne s'applique pas à expect request/);
  assert.throws(() => expectSpecOf({ kind: 'url', expected: 'x', status: '200' }), /ne s'applique qu'à expect request/);
  assert.throws(() => expectSpecOf({ kind: 'request' }), /requête attendue/);
  assert.equal(describeExpected(expectSpecOf({ kind: 'request', target: 'POST /api/commande' })), 'requête POST « /api/commande » de statut 2xx');
  assert.equal(describeExpected(expectSpecOf({ kind: 'request', target: '/api', match: 'contains', status: '201' })), 'requête d\'URL contenant « /api » de statut 201');
  assert.equal(describeExpected(expectSpecOf({ kind: 'request', target: 'GET ^http', match: 'regex' })), 'requête GET d\'URL correspondant à /^http/ de statut 2xx');
});

test('grasp network : corps (CLI et run), options de run, --network sur les actions', () => {
  const r = (line: string) => buildRequest(parseArgs(splitLine(line)));
  assert.deepEqual(r('network'), { cmd: 'network', method: 'POST', path: '/network', body: { limit: 50 } });
  assert.deepEqual(r('network --since 12 --failed --max 5 --type xhr,fetch').body, { since: '12', limit: '5', type: 'xhr,fetch', failed: true });
  assert.throws(() => r('network --failed=oui'), /--failed ne prend pas de valeur/);
  assert.deepEqual(r('click text:Enregistrer --network').body, { target: 'text:Enregistrer', network: true });
  assert.deepEqual(r('nav http://h/ --network --console').body, { url: 'http://h/', console: true, network: true });
  assert.equal(compileScript('network --failed\nclick #b --network\nexpect request "POST /api/x" 201').length, 3);
  assert.throws(() => compileScript('network --level error'), /option --level inconnue pour network dans run/);
  assert.throws(() => compileScript('snap --network'), /option --network inconnue pour snap/);
});
