import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitLine, parseArgs, buildRequest, parseScript, checkRunFlags } from '../../src/core/script.js';
import { asRunScript, commandOf, finalExpects, HistoryLog, MASK, quoteArg, renderLine, sanitize, wantsTarget, type HistoryEntry } from '../../src/core/history.js';

const rqOf = (line: string) => { const a = parseArgs(splitLine(line)); checkRunFlags(a); return buildRequest(a); };

/** Une ligne → requête → ligne reconstruite → même requête : l'historique ne change jamais le sens d'une commande. */
test('history : la ligne reconstruite depuis la requête redonne exactement la même requête', () => {
  const lines = [
    'nav http://127.0.0.1:8080/ --snap-diff --max 900',
    `click "text:J'accepte les conditions" --console --shot-on-error`,
    "fill '#email' 'ada@example.org'",
    "fill e5k2 'a \"b\" \\\\ c' --engine playwright",
    'fill #qte -5',
    "fill '#x' -- --pas-une-option",
    "fill '#x' ''",
    "fill '#x' '#'",
    'select text:Pays Madagascar',
    'check e3 --uncheck',
    'press Enter',
    'press Tab #champ',
    'hover e9 --scope main',
    "type '#q' 'vél' --delay 20",
    'wait --text Bienvenue --timeout 3000',
    'wait --idle',
    'wait --sel e7',
    'expect text "Commande enregistrée"',
    "expect url '~' /merci",
    'expect title Merci --regex',
    'expect value #qte 2',
    "expect value #qte '~' -2",
    'expect no-console-errors --ignore favicon',
    'expect no-form-errors',
    'expect sel #recu --timeout 0',
    "eval \"document.querySelector('h1').textContent\"",
    'snap --max 500 --scope main --name-max 0',
    'text --markdown --max 300',
    'console --level error --since 4 --limit 10',
    'screenshot --full --format jpeg --quality 50',
    'cookies',
    'upload #f /tmp/a.txt /tmp/b.txt',
    'profile travail',
  ];
  for (const l of lines) {
    const rq = rqOf(l);
    const c = commandOf(rq.method, rq.path === 'profile' ? '/profile' : rq.path, rq.body);
    assert.ok(c !== undefined, l);
    const again = renderLine(c.line);
    assert.deepEqual(rqOf(again), rq, `${l} → ${again}`);
    // Le script généré se relit sans erreur.
    assert.equal(parseScript(again).length, 1, again);
  }
});

test('history : citation des arguments pour splitLine', () => {
  for (const s of ['simple', '#id', 'text:Valider', "J'accepte", 'a b', '', '#', 'a"b', 'x\\y', 'é à', '-o', '$HOME', 'tab\tici']) {
    assert.deepEqual(splitLine(`fill x ${quoteArg(s)}`), ['fill', 'x', s], s);
  }
  assert.equal(quoteArg('#valider'), '#valider');
  assert.equal(quoteArg('text:Ajouter'), 'text:Ajouter');
  assert.equal(quoteArg("text:J'accepte"), `'text:J'\\''accepte'`);
});

test('history : routes sans commande ignorées, lectures classées', () => {
  assert.equal(commandOf('GET', '/location', undefined), undefined);
  assert.equal(commandOf('POST', '/internal/durable', { target: 'e1' }), undefined);
  assert.equal(commandOf('GET', '/snap', undefined)?.kind, 'read');
  assert.equal(commandOf('POST', '/state/import', { state: { cookies: ['secret'] } })?.kind, 'offline');
  // Le contenu de l'état n'entre jamais dans la ligne.
  assert.doesNotMatch(renderLine(commandOf('POST', '/state/import', { state: { cookies: ['secret'] } })!.line), /secret/);
  assert.equal(commandOf('POST', '/click', { target: 'e1' })?.kind, 'action');
  assert.equal(wantsTarget(commandOf('POST', '/click', { target: 'e1' })!.line), true);
  assert.equal(wantsTarget(commandOf('POST', '/click', { target: '#ok' })!.line), false);
  // Une saisie demande toujours la cible (champ secret ?).
  assert.equal(wantsTarget(commandOf('POST', '/fill', { target: '#ok', value: 'x' })!.line), true);
});

const entry = (seq: number, line: string, extra: Partial<HistoryEntry> = {}): HistoryEntry => {
  const rq = rqOf(line);
  const c = commandOf(rq.method, rq.path, rq.body)!;
  return { seq, at: '2026-11-12T10:00:00.000Z', ms: 10, ok: true, via: 'api', kind: c.kind, line: c.line, ...extra };
};

test('history : mot de passe masqué avant conservation, prudence quand le type du champ est inconnu', () => {
  const pw = sanitize(entry(1, "fill '#mdp' 'hunter2'", { target: { given: '#mdp', durable: '#mdp', how: 'given', secret: true } }));
  assert.equal(pw.line.pos[1], MASK);
  assert.match(pw.masked!, /secret/);
  assert.doesNotMatch(JSON.stringify(pw), /hunter2/);
  const unknown = sanitize(entry(2, "type e4 'hunter2'", { target: { given: 'e4', secret: null, note: 'cible non décrite' } }));
  assert.equal(unknown.line.pos[1], MASK);
  assert.match(unknown.masked!, /prudence/);
  const plain = sanitize(entry(3, "fill '#nom' Ada", { target: { given: '#nom', durable: '#nom', how: 'given', secret: false } }));
  assert.equal(plain.line.pos[1], 'Ada');
  assert.equal(plain.masked, undefined);
  const long = sanitize(entry(4, `fill '#nom' ${'x'.repeat(5000)}`, { target: { given: '#nom', secret: false } }));
  assert.match(long.unreplayable!, /5000 caractères/);
  assert.ok(JSON.stringify(long).length < 2000);
});

test('history --as-run : refs traduites, lectures et échecs omis, masques commentés, options d\'affichage retirées', () => {
  const es = [
    entry(1, 'nav http://127.0.0.1:8080/historique'),
    entry(2, 'snap'),
    entry(3, "fill e5k2 'Ada Lovelace' --snap-diff", { target: { given: 'e5k2', durable: 'text:Nom', how: 'text', role: 'textbox', name: 'Nom', secret: false } }),
    sanitize(entry(4, "fill e7 'hunter2'", { target: { given: 'e7', durable: 'text:Mot de passe', how: 'text', role: 'textbox', name: 'Mot de passe', secret: true } })),
    entry(5, 'click e9 --console', { target: { given: 'e9', durable: 'li[data-id="2"] button', how: 'css', role: 'button', name: 'Supprimer', note: 'nom ambigu', secret: false } }),
    entry(6, 'click e1', { ok: false, status: 404, error: 'ref e1 inconnue' }),
    entry(7, 'click e2', { target: { given: 'e2', role: 'button', name: '', note: 'sans nom accessible, aucun sélecteur CSS unique', secret: false } }),
    entry(8, 'text --max 100'),
    entry(9, 'expect text Ada'),
  ];
  const s = asRunScript(es, { sessionId: 'abc', expects: finalExpects({ url: 'http://127.0.0.1:8080/historique', title: 'Liste' }, 'page "Liste"\ne1:heading[2] "Sous"\ne2:heading[1] "Liste de courses"\n'), now: new Date(0) });
  assert.match(s, /^nav http:\/\/127\.0\.0\.1:8080\/historique$/m);
  assert.match(s, /^fill text:Nom 'Ada Lovelace'$/m);
  assert.doesNotMatch(s, /hunter2/);
  assert.match(s, /^# fill 'text:Mot de passe' '<masqué>' .*valeur masquée/m);
  assert.match(s, /^click 'li\[data-id="2"\] button' +# e9 button "Supprimer" : nom ambigu$/m);
  assert.match(s, /^click e2 +# ref non traduite : sans nom accessible/m);
  assert.match(s, /Omis : 2 lecture\(s\) pure\(s\) \(snap ×1, text ×1\)/);
  assert.match(s, /Omis : 1 commande\(s\) en échec \(#6 click e1\)/);
  assert.match(s, /ATTENTION : 1 valeur\(s\) masquée\(s\)/);
  assert.doesNotMatch(s, /--snap-diff|--console/);
  assert.match(s, /^expect url http:\/\/127\.0\.0\.1:8080\/historique$/m);
  assert.match(s, /^expect title Liste$/m);
  assert.match(s, /^expect text 'Liste de courses'$/m);
  // Le script se relit en entier (lignes commentées ignorées), sans option refusée.
  const lines = parseScript(s);
  for (const l of lines) { const a = parseArgs(l.argv); checkRunFlags(a); buildRequest(a); }
  assert.deepEqual(lines.map((l) => l.argv[0]), ['nav', 'fill', 'click', 'click', 'expect', 'expect', 'expect', 'expect']);
});

test('HistoryLog : borné, oublis comptés et annoncés, --clear n\'est pas un oubli', () => {
  const h = new HistoryLog(3);
  for (let i = 0; i < 5; i++) { const seq = h.reserve(); h.push(entry(seq, 'press Enter')); }
  assert.equal(h.size, 3);
  assert.equal(h.forgotten, 2);
  assert.deepEqual(h.since(0).map((e) => e.seq), [3, 4, 5]);
  assert.equal(h.lostAfter(0), 2);
  assert.equal(h.lostAfter(2), 0);
  assert.deepEqual(h.since(4).map((e) => e.seq), [5]);
  h.clear();
  assert.equal(h.lostAfter(0), 0);
  const seq = h.reserve();
  h.push(entry(seq, 'press Tab'));
  assert.deepEqual(h.since(0).map((e) => e.seq), [6]);
  // Deux commandes concurrentes qui finissent dans le désordre : rangées par seq.
  const a = h.reserve(); const b = h.reserve();
  h.push(entry(b, 'press b')); h.push(entry(a, 'press a'));
  assert.deepEqual(h.since(0).map((e) => e.seq), [6, 7, 8]);
});
