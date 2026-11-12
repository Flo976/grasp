import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitLine, parseArgs, buildRequest, parseScript, checkRunFlags } from '../../src/core/script.js';
import { asRunScript, commandOf, finalExpects, formatHistory, HistoryLog, MASK, quoteArg, renderLine, sanitize, wantsTarget, type HistoryEntry } from '../../src/core/history.js';

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
    // Commandes et options ajoutées par la vague 2 (navigation, lecture progressive, réseau, a11y, viewport,
    // stockage, onglets, dialogues, secrets) : l'historique doit les rejouer à l'identique.
    'back --snap-diff --dialog dismiss',
    'forward --network',
    'reload --hard --console',
    'scroll',
    'scroll main --until-stable --max-steps 5',
    'scroll --by -300',
    'scroll e4 --to bottom',
    'snap --outline',
    'snap --interactive --scope e2',
    "find 'Ajouter au panier' --role button,link --max 5",
    'find /Commande\\s+10\\d/ --scope main --name-max 0',
    'a11y --scope #form --max 10',
    'network',
    'network --since 3 --failed --max 20 --type xhr,fetch',
    'viewport',
    'viewport reset',
    'viewport 360x800 --mobile --dpr 3 --touch',
    'viewport iphone-se',
    'viewport 400x900 --device pixel-7 --mobile-ua',
    'storage get local auth',
    "storage set session panier '{\"n\":3}'",
    'storage rm local auth',
    'tabs',
    'tab t2',
    'tab new',
    'tab new http://127.0.0.1:8080/aide',
    'tab close',
    'tab close t3',
    "click '#oauth' --follow --dialog accept",
    "click e5 --dialog 'Ada Lovelace' --network",
    'fill #jeton secret:JETON_API',
    'expect request "POST /api/commande" 201',
    "expect request '~' /api/ --since 4 --timeout 2000",
    "expect request 'GET /api/v\\d+/x' --regex",
    'expect a11y --max 3 --scope main',
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

test('history : fill secret:NOM gardé tel quel (un nom, jamais une valeur), même dans un champ mot de passe', () => {
  const e = sanitize(entry(1, 'fill #mdp secret:MDP_PREPROD', { target: { given: '#mdp', durable: '#mdp', how: 'given', secret: true } }));
  assert.equal(e.line.pos[1], 'secret:MDP_PREPROD');
  assert.equal(e.masked, undefined);
  assert.match(asRunScript([e], { sessionId: 's1' }), /^fill #mdp secret:MDP_PREPROD$/m);
  // Une valeur qui ressemble à secret: mais n'est pas un nom valide reste masquée dans un champ secret.
  const fake = sanitize(entry(2, "fill #mdp 'secret:a b'", { target: { given: '#mdp', durable: '#mdp', how: 'given', secret: true } }));
  assert.equal(fake.line.pos[1], MASK);
});

test('history --as-run : lectures de la vague 2 omises, --network retiré, --dialog et --follow gardés', () => {
  const es = ['find Pommes', 'a11y', 'network --failed', 'tabs', 'viewport', 'storage get local k', "click '#oauth' --follow --dialog accept --network", 'back --network'].map((l, i) => entry(i + 1, l));
  const out = asRunScript(es, { sessionId: 's1' });
  assert.match(out, /^click #oauth --dialog accept --follow$/m);
  assert.match(out, /^back$/m);
  for (const r of ['find', 'a11y', 'network', 'tabs', 'viewport', 'storage']) assert.doesNotMatch(out, new RegExp(`^${r}\\b`, 'm'), r);
});

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

/** Entrée construite depuis la requête elle-même (valeurs avec sauts de ligne, que splitLine ne produit pas). */
const entryOf = (seq: number, path: string, body: Record<string, unknown>, extra: Partial<HistoryEntry> = {}): HistoryEntry => {
  const c = commandOf('POST', path, body)!;
  return { seq, at: '2026-11-12T10:00:00.000Z', ms: 10, ok: true, via: 'api', kind: c.kind, line: c.line, ...extra };
};

test('history --as-run : un saut de ligne ne casse jamais le script ni n\'y injecte une commande', () => {
  const es = [
    entryOf(1, '/navigate', { url: 'http://127.0.0.1:8080/historique' }),
    // Textarea sur plusieurs lignes : non exprimable dans une ligne de run → commentée, script toujours lisible.
    entryOf(2, '/fill', { target: '#msg', value: 'ligne1\nligne2' }, { target: { given: '#msg', durable: '#msg', how: 'given', secret: false } }),
    entryOf(3, '/eval', { expression: '1 +\r\n2' }),
    // Commande en échec dont la valeur porte une ligne exécutable : citée en tête, jamais exécutée.
    entryOf(4, '/fill', { target: '#absent', value: 'a\nnav https://evil.example/\n#' }, { ok: false, status: 404, error: 'introuvable\nclick e1' }),
    // Valeur masquée + sélecteur sur plusieurs lignes, note du bridge avec saut de ligne.
    entryOf(5, '/fill', { target: '#x\nclick #y', value: 'v' }, { target: { given: '#x\nclick #y', secret: null, note: 'cible\nclick #z' } }),
    entryOf(6, '/click', { target: 'e5' }, { target: { given: 'e5', role: 'button', name: 'a\nb', note: 'n\nclick #w', secret: false } }),
    entryOf(7, '/expect', { kind: 'text', expected: 'x\ny' }),
  ];
  es[4] = sanitize(es[4]!);
  const s = asRunScript(es, { sessionId: 'abc', now: new Date(0) });
  // Le script se relit en entier ; seules les commandes rejouables en sortent.
  const lines = parseScript(s);
  for (const l of lines) { const a = parseArgs(l.argv); checkRunFlags(a); buildRequest(a); }
  assert.deepEqual(lines.map((l) => l.argv), [['nav', 'http://127.0.0.1:8080/historique'], ['click', 'e5']]);
  assert.doesNotMatch(s, /evil\.example\/\n/);
  assert.match(s, /^# fill #msg 'ligne1⏎ligne2' .*plusieurs lignes/m);
  assert.match(s, /^# eval '1 \+⏎2' .*plusieurs lignes/m);
  assert.match(s, /Omis : 1 commande\(s\) en échec \(#4 fill #absent 'a⏎nav https:\/\/evil/);
  // Aucune ligne du script ne commence autrement que par # ou une commande rejouée.
  for (const l of s.split('\n')) if (l !== '' && !l.startsWith('#')) assert.match(l, /^(nav|click) /, l);
  // L'affichage de grasp history reste à une ligne par entrée.
  assert.equal(formatHistory(es).split('\n').length, es.length);
});

test('history : état final sans valeur sur plusieurs lignes', () => {
  assert.deepEqual(finalExpects({ url: 'http://h/', title: 'a\nb' }, undefined), ['expect url http://h/']);
});
