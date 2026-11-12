import { test } from 'node:test';
import assert from 'node:assert/strict';
import { around, describeExpected, excerpt, expectSpecOf, findText, matchValue } from '../../src/core/expect.js';
import { buildRequest, parseArgs, splitLine } from '../../src/core/script.js';
import { formatReport, type RunReport } from '../../src/control/run.js';

test('buildRequest : expect → POST /expect, comparaison (égalité, ~ contient, --regex), options par assertion', () => {
  const r = (line: string) => buildRequest(parseArgs(splitLine(line)));
  assert.deepEqual(r('expect text "Commande enregistrée"'), { cmd: 'expect', method: 'POST', path: '/expect', body: { kind: 'text', expected: 'Commande enregistrée' }, timeoutMs: 20_000 });
  assert.deepEqual(r("expect no-text Erreur --scope '#recu' --timeout 0").body, { kind: 'no-text', expected: 'Erreur', scope: '#recu', timeout: '0' });
  assert.equal(r('expect no-text Erreur --timeout 0').timeoutMs, 15_000);
  assert.deepEqual(r('expect text --regex "n°\\\\d+"').body, { kind: 'text', expected: 'n°\\d+', match: 'regex' });
  assert.deepEqual(r('expect url ~ /merci').body, { kind: 'url', expected: '/merci', match: 'contains' });
  assert.deepEqual(r('expect url http://h/merci').body, { kind: 'url', expected: 'http://h/merci', match: 'exact' });
  assert.deepEqual(r("expect title --regex '^Merci'").body, { kind: 'title', expected: '^Merci', match: 'regex' });
  assert.deepEqual(r("expect value '#qte' ~ 2").body, { kind: 'value', target: '#qte', expected: '2', match: 'contains' });
  assert.deepEqual(r("expect value '#qte' ''").body, { kind: 'value', target: '#qte', expected: '', match: 'exact' }, 'valeur vide attendue : champ vide');
  assert.deepEqual(r('expect sel text:Valider').body, { kind: 'sel', target: 'text:Valider' });
  assert.deepEqual(r('expect no-sel #spinner --shot-on-error').body, { kind: 'no-sel', target: '#spinner', shotOnError: true });
  assert.deepEqual(r("expect no-console-errors --ignore 'favicon|analytics' --since 12").body, { kind: 'no-console-errors', since: '12', ignore: 'favicon|analytics' });
  assert.deepEqual(r('expect no-form-errors').body, { kind: 'no-form-errors' });
  assert.throws(() => r('expect'), /usage : grasp expect <assertion>/);
  assert.throws(() => r('expect texte x'), /assertion inconnue « texte »/);
  assert.throws(() => r('expect text'), /usage : grasp expect text <texte>/);
  assert.throws(() => r('expect text "  "'), /texte non vide attendu/);
  assert.throws(() => r('expect url a b'), /usage : grasp expect url \[~\] <url>/);
  assert.throws(() => r('expect url ~ a --regex'), /« ~ » \(contient\) et --regex s'excluent/);
  assert.throws(() => r('expect sel #a --regex'), /--regex ne s'applique pas à expect sel/);
  assert.throws(() => r('expect no-form-errors --timeout 10'), /--timeout ne s'applique pas à expect no-form-errors/);
  assert.throws(() => r("expect text '(' --regex"), /expression régulière invalide/);
  assert.throws(() => r("expect no-console-errors --ignore '['"), /expression régulière invalide/);
  assert.throws(() => r('expect text x --timeout -1'), /entier positif ou nul/);
  assert.throws(() => r('expect text x --timeout 60001'), /60000 ms au plus/);
});

test('expect : comparaisons et extraits bornés', () => {
  assert.equal(matchValue('http://h/merci', { kind: 'url', expected: 'http://h/merci', match: 'exact' }), true);
  assert.equal(matchValue('http://h/merci?x', { kind: 'url', expected: 'http://h/merci' }), false, 'égalité par défaut');
  assert.equal(matchValue('http://h/merci?x', { kind: 'url', expected: '/merci', match: 'contains' }), true);
  assert.equal(matchValue('Merci !', { kind: 'title', expected: '^Merci', match: 'regex' }), true);
  // text : espaces normalisés côté attendu (la page l'est déjà).
  assert.deepEqual(findText('Commande enregistrée n°42', { kind: 'text', expected: ' Commande\n enregistrée ' }), { index: 0, length: 20 });
  assert.deepEqual(findText('Commande n°42', { kind: 'text', expected: 'n°\\d+', match: 'regex' }), { index: 9, length: 4 });
  assert.equal(findText('abc', { kind: 'text', expected: 'x' }).index, -1);
  assert.equal(excerpt('a  b\nc'), '« a b c »');
  assert.equal(excerpt('x'.repeat(310)), `« ${'x'.repeat(300)}… » (310 car.)`);
  const long = `${'a'.repeat(100)}CIBLE${'b'.repeat(100)}`;
  assert.equal(around(long, 100, 5), `« …${'a'.repeat(60)}CIBLE${'b'.repeat(60)}… »`);
  assert.equal(describeExpected({ kind: 'value', target: '#q', expected: '2', match: 'contains' }), 'valeur de #q contenant « 2 »');
  assert.equal(describeExpected({ kind: 'no-text', expected: 'Erreur', scope: 'main' }), 'aucun texte « Erreur » dans main');
  assert.equal(describeExpected({ kind: 'no-console-errors', ignore: 'favicon' }), 'aucune erreur console (hors /favicon/)');
});

test('expect : le bridge revalide le corps (rien n\'est supposé du client)', () => {
  assert.throws(() => expectSpecOf({ kind: 'nope' }), /assertion inconnue/);
  assert.throws(() => expectSpecOf({ kind: 'sel' }), /sélecteur requis/);
  assert.throws(() => expectSpecOf({ kind: 'value', target: '#a' }), /valeur attendue requise/);
  assert.throws(() => expectSpecOf({ kind: 'url', expected: 'x', match: 'glob' }), /exact, contains ou regex/);
  assert.throws(() => expectSpecOf({ kind: 'text', expected: '(', match: 'regex' }), /expression régulière invalide/);
  assert.throws(() => expectSpecOf({ kind: 'text', expected: 'x', timeout: 1.5 }), /entier positif ou nul/);
  assert.deepEqual(expectSpecOf({ kind: 'text', expected: 'x', timeout: '0', scope: ' main ' }), { kind: 'text', expected: 'x', scope: 'main', timeout: 0 });
});

test('formatReport : verdict, étapes et durées, échec avec capture, non exécutées, console, requêtes, formulaire', () => {
  const rep: RunReport = {
    ok: false, ms: 1234, total: 4,
    steps: [
      { n: 1, line: 1, text: 'nav http://h/', ok: true, ms: 300 },
      { n: 2, line: 3, text: 'expect text OK', ok: false, ms: 5003, error: 'attendu texte « OK » dans la page ; constaté : absent', screenshot: '/c/1.png' },
    ],
    notRun: [{ n: 3, line: 4, text: 'expect title T' }, { n: 4, line: 5, text: 'expect no-form-errors' }],
    console: { since: 3, omitted: 0, errors: [{ seq: 5, at: 0, level: 'error', source: 'exception', text: 'Uncaught boum' }], requests: [{ seq: 4, at: 0, level: 'error', source: 'network', text: 'GET http://h/api → 500 Internal Server Error' }] },
    forms: { items: ['e1:textbox "Q" [invalide: trop grand]'] },
    page: { url: 'http://h/', title: 'Accueil' },
  };
  assert.equal(formatReport(rep), [
    '== recette : ÉCHEC — 4 étapes : 1 OK, 1 KO, 2 non exécutées (1234 ms)',
    'OK  [1] nav http://h/ (300 ms)',
    'KO  [2] expect text OK (5003 ms)',
    '      attendu texte « OK » dans la page ; constaté : absent',
    '      capture : /c/1.png',
    '--  [3] expect title T (non exécutée)',
    '--  [4] expect no-form-errors (non exécutée)',
    'console : 1 erreur pendant le run',
    '  #5 error exception Uncaught boum',
    'requêtes en échec : 1',
    '  #4 error network GET http://h/api → 500 Internal Server Error',
    'formulaire : 1 erreur',
    '  e1:textbox "Q" [invalide: trop grand]',
    'page finale : http://h/ « Accueil »',
  ].join('\n'));
  assert.match(formatReport({ ...rep, console: { unavailable: 'la console est désactivée' }, forms: { items: [] } }), /^console : non lue \(la console est désactivée\)\nformulaire : aucune erreur$/m);
});
