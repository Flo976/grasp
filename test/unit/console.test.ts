import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConsoleBuffer, formatArgs, formatEntry, mergeRuns, redactUrl, redactUrlsIn, levelOfConsoleType, levelOfLog, type ConsoleEntry } from '../../src/core/console.js';

const push = (b: ConsoleBuffer, level: ConsoleEntry['level'], text: string, extra: Partial<ConsoleEntry> = {}) => b.push({ level, source: 'console', text, ...extra });

test('tampon circulaire : seq croissant, capacité bornée, les plus anciennes tombent', () => {
  const b = new ConsoleBuffer(5);
  for (let i = 1; i <= 8; i++) push(b, 'info', `m${i}`);
  assert.equal(b.seq, 8);
  const r = b.query({});
  assert.deepEqual(r.entries.map((e) => [e.seq, e.text]), [[4, 'm4'], [5, 'm5'], [6, 'm6'], [7, 'm7'], [8, 'm8']]);
  assert.equal(r.seq, 8);
  // --since : seulement ce qui suit ; entrées perdues signalées
  assert.deepEqual(b.query({ since: 6 }).entries.map((e) => e.seq), [7, 8]);
  assert.equal(b.query({ since: 1 }).dropped, 2, 'm2 et m3 sont tombées du tampon');
  assert.equal(b.query({ since: 6 }).dropped, 0);
});

test('filtre --level : le niveau demandé et les plus graves ; les repères de navigation restent', () => {
  const b = new ConsoleBuffer();
  push(b, 'debug', 'd');
  push(b, 'info', 'i');
  b.push({ level: 'info', source: 'navigation', text: 'http://x/' });
  push(b, 'warn', 'w');
  push(b, 'error', 'e');
  assert.deepEqual(b.query({ level: 'warn' }).entries.map((e) => e.text), ['http://x/', 'w', 'e']);
  assert.deepEqual(b.query({ level: 'error' }).entries.map((e) => e.text), ['http://x/', 'e']);
  assert.equal(b.query({ level: 'debug' }).entries.length, 5);
  assert.throws(() => b.query({ level: 'fatal' as never }), /niveau/);
});

test('doublons consécutifs fusionnés (×N), --limit garde les plus récentes', () => {
  const b = new ConsoleBuffer();
  push(b, 'info', 'a');
  for (let i = 0; i < 5; i++) push(b, 'warn', 'répété', { url: 'http://h/p', line: 3 });
  push(b, 'info', 'b');
  push(b, 'info', 'a');
  const r = b.query({});
  assert.deepEqual(r.entries.map((e) => [e.seq, e.text, e.count]), [[1, 'a', 1], [2, 'répété', 5], [7, 'b', 1], [8, 'a', 1]]);
  assert.deepEqual(b.query({ limit: 2 }).entries.map((e) => e.text), ['b', 'a']);
  assert.equal(mergeRuns([]).length, 0);
});

test('--limit et omitted : seules les lignes du niveau demandé comptent, jamais les repères ni ce qui précède clear', () => {
  const b = new ConsoleBuffer();
  for (let i = 0; i < 30; i++) push(b, 'error', `ancienne ${i}`);
  b.clear();
  b.push({ level: 'info', source: 'navigation', text: 'http://x/' });
  for (let i = 0; i < 60; i++) b.push({ level: 'info', source: 'navigation', text: `http://x/?etape=${i} (même document)` });
  push(b, 'error', 'A');
  push(b, 'info', 'i');
  b.push({ level: 'info', source: 'navigation', text: 'http://y/' });
  push(b, 'error', 'B');
  const r = b.query({ level: 'error', limit: 50 });
  assert.equal(r.omitted, 0);
  assert.equal(r.entries.length, 64, 'rien d\'écarté : tous les repères restent');
  assert.deepEqual(r.entries.filter((e) => e.source !== 'navigation').map((e) => e.text), ['A', 'B']);
  const r1 = b.query({ level: 'error', limit: 1 });
  assert.equal(r1.omitted, 1);
  assert.deepEqual(r1.entries.map((e) => e.text), ['B'], 'au plus --limit lignes, repères antérieurs écartés');
  assert.equal(b.query({ level: 'debug', limit: 1 }).omitted, 2, 'info et A écartées');
  assert.equal(b.query({ level: 'error' }).omitted, 0);
});

test('clear vide le tampon sans remettre seq à zéro (les --since restent valides)', () => {
  const b = new ConsoleBuffer();
  push(b, 'info', 'a');
  push(b, 'info', 'b');
  b.clear();
  assert.equal(b.query({}).entries.length, 0);
  assert.equal(b.query({ since: 0 }).dropped, 0, 'un vidage volontaire n\'est pas une perte');
  push(b, 'info', 'c');
  assert.equal(b.query({}).entries[0]!.seq, 3);
});

test('texte stocké tronqué (mémoire bornée)', () => {
  const b = new ConsoleBuffer(10, 100);
  push(b, 'info', 'x'.repeat(5000));
  const t = b.query({}).entries[0]!.text;
  assert.ok(t.length <= 120, `longueur ${t.length}`);
  assert.match(t, /… \(\+4900 car\.\)$/);
});

test('formatArgs : chaînes de format, primitives, aperçus compacts d\'objets, tableaux, erreurs', () => {
  assert.equal(formatArgs([{ type: 'string', value: 'niveau %s n°%d' }, { type: 'string', value: 'formaté' }, { type: 'number', value: 7, description: '7' }]), 'niveau formaté n°7');
  assert.equal(formatArgs([{ type: 'string', value: '%cstylé' }, { type: 'string', value: 'color: red' }]), 'stylé');
  assert.equal(formatArgs([{ type: 'string', value: 'clic' }, { type: 'number', value: 42, description: '42' }, { type: 'undefined' }, { type: 'object', subtype: 'null', value: null }, { type: 'number', unserializableValue: 'NaN', description: 'NaN' }]), 'clic 42 undefined null NaN');
  const obj = {
    type: 'object', className: 'Object', description: 'Object',
    preview: { type: 'object', description: 'Object', overflow: false, properties: [
      { name: 'code', type: 'number', value: '42' },
      { name: 'detail', type: 'string', value: 'champ manquant' },
      { name: 'nested', type: 'object', value: 'Object' },
      { name: 'list', type: 'object', subtype: 'array', value: 'Array(3)' },
    ] },
  };
  assert.equal(formatArgs([{ type: 'string', value: 'erreur objet' }, obj]), 'erreur objet {code: 42, detail: "champ manquant", nested: {…}, list: Array(3)}');
  const arr = { type: 'object', subtype: 'array', description: 'Array(4)', preview: { type: 'object', subtype: 'array', description: 'Array(4)', overflow: true, properties: [{ name: '0', type: 'number', value: '1' }, { name: '1', type: 'number', value: '2' }] } };
  assert.equal(formatArgs([arr]), '[1, 2, …]');
  assert.equal(formatArgs([{ type: 'object', subtype: 'error', description: 'Error: boum\n    at f (http://h/a.js:1:2)' }]), 'Error: boum');
  assert.equal(formatArgs([{ type: 'function', description: 'function secret() { return 1; }' }]), 'ƒ secret()');
});

test('redactUrl : identifiants, valeurs de paramètres sensibles masquées, URL tronquée', () => {
  assert.equal(redactUrl('http://user:motdepasse@h.test/p?token=abc123&page=2&api_key=K&Session=S'), 'http://h.test/p?token=***&page=2&api_key=***&Session=***');
  const long = redactUrl(`http://h.test/${'a'.repeat(400)}`);
  assert.ok(long.length <= 160, `longueur ${long.length}`);
  assert.match(long, /…$/);
  assert.match(redactUrl(`data:image/png;base64,${'A'.repeat(500)}`), /^data:image\/png;base64,A{0,40}…$/);
  assert.equal(redactUrl('pas une url'), 'pas une url');
});

test('niveaux : types console et niveaux du domaine Log', () => {
  assert.equal(levelOfConsoleType('log'), 'info');
  assert.equal(levelOfConsoleType('warning'), 'warn');
  assert.equal(levelOfConsoleType('assert'), 'error');
  assert.equal(levelOfConsoleType('debug'), 'debug');
  assert.equal(levelOfConsoleType('trace'), 'debug');
  assert.equal(levelOfLog('verbose'), 'debug');
  assert.equal(levelOfLog('warning'), 'warn');
  assert.equal(levelOfLog('error'), 'error');
});

test('formatEntry : « #seq niveau source texte (fichier:ligne) ×N », repère de navigation, texte affiché tronqué', () => {
  assert.equal(formatEntry({ seq: 12, at: 0, level: 'warn', source: 'console', text: 'répété', url: 'http://127.0.0.1:4000/console', line: 31, count: 5 }), '#12 warn  console répété (console:31) ×5');
  assert.equal(formatEntry({ seq: 3, at: 0, level: 'error', source: 'exception', text: 'Error: boum', url: 'http://h/js/app.js?v=2', line: 7, col: 3 }), '#3 error exception Error: boum (app.js:7)');
  assert.equal(formatEntry({ seq: 1, at: 0, level: 'info', source: 'navigation', text: 'http://h/page' }), '#1 navigation → http://h/page');
  assert.equal(formatEntry({ seq: 2, at: 0, level: 'info', source: 'console', text: 'depuis le cadre', frame: 'http://h/cadre', url: 'http://h/cadre', line: 1 }), '#2 info  console [iframe] depuis le cadre (cadre:1)');
  const long = formatEntry({ seq: 4, at: 0, level: 'info', source: 'console', text: 'y'.repeat(1000) });
  assert.ok(long.length < 400, `ligne de ${long.length} car.`);
  assert.match(long, /… \(\+\d+ car\.\)$/);
  assert.doesNotMatch(formatEntry({ seq: 5, at: 0, level: 'info', source: 'console', text: 'a\nb' }), /\n/, 'une ligne par entrée');
});

test('--since au-delà du dernier seq (tampon recréé) : erreur 409 explicite, jamais un résultat vide silencieux', () => {
  const b = new ConsoleBuffer();
  for (let i = 0; i < 3; i++) push(b, 'info', `m${i}`);
  assert.throws(() => b.query({ since: 500 }), (e: Error & { status?: number }) => {
    assert.equal(e.status, 409);
    assert.match(e.message, /since 500.*seq courant 3/);
    assert.match(e.message, /--since 0/);
    return true;
  });
  assert.equal(b.query({ since: 3 }).entries.length, 0, 'since = dernier seq : rien de nouveau, pas une erreur');
});

test('fusion ×N sur les entrées consécutives DU TAMPON, avant le filtre --level', () => {
  const b = new ConsoleBuffer();
  push(b, 'error', 'X');
  push(b, 'info', 'Y');
  push(b, 'error', 'X');
  assert.deepEqual(b.query({ level: 'error' }).entries.map((e) => [e.seq, e.text, e.count]), [[1, 'X', 1], [3, 'X', 1]]);
  push(b, 'error', 'X');
  // #3 et #4 sont réellement consécutifs : fusionnés, même filtrés.
  assert.deepEqual(b.query({ level: 'error' }).entries.map((e) => [e.seq, e.count]), [[1, 1], [3, 2]]);
});

test('redactUrlsIn : URL contenues dans un texte du navigateur (CSP…) masquées comme les autres', () => {
  assert.equal(
    redactUrlsIn("Loading the image 'http://127.0.0.1:4000/pix.png?token=SECRET&w=2' violates the following directive: \"img-src 'none'\"."),
    "Loading the image 'http://127.0.0.1:4000/pix.png?token=***&w=2' violates the following directive: \"img-src 'none'\".",
  );
  assert.equal(redactUrlsIn('Mixed Content: https://a.test/x?session=S and wss://b.test/s?jwt=J'), 'Mixed Content: https://a.test/x?session=*** and wss://b.test/s?jwt=***');
  assert.equal(redactUrlsIn('aucune url ici'), 'aucune url ici');
});
