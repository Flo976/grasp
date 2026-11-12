import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRequest, checkRunFlags, parseArgs, parseScript, splitLine } from '../../src/core/script.js';
import { attachImports, compileScript, stateImportNotes } from '../../src/control/run.js';
import { checkRunBody, readRunImports, runFilePath } from '../../src/cli/runfiles.js';
import { asRunScript, commandOf, renderLine, type HistoryEntry } from '../../src/core/history.js';
import { EVAL_REFUSAL, policyRefusal } from '../../src/core/policy.js';
import { parseStateArg, toolList } from '../../src/cli/mcp.js';

/** Retours du deuxième essai réel : state import dans run, refus d'eval sans incitation, outils MCP storage et state_import. */

const rq = (line: string) => { const a = parseArgs(splitLine(line)); checkRunFlags(a); return buildRequest(a); };
const status400 = (re: RegExp) => (e: Error & { status?: number }) => e.status === 400 && re.test(e.message);

test('run : state import <fichier> → POST /state/import, fichier à lire par la CLI ; export, - et formes invalides refusés', () => {
  assert.deepEqual(rq('state import session.json'), { cmd: 'state', method: 'POST', path: '/state/import', body: {}, loadFrom: 'session.json' });
  assert.equal(rq("state import 'mes états/a.json'").loadFrom, 'mes états/a.json');
  assert.throws(() => rq('state export'), /state export n'est pas disponible dans run/);
  assert.throws(() => rq('state import -'), /stdin n'est pas disponible dans run/);
  assert.throws(() => rq('state import'), /usage : state import <fichier>/);
  assert.throws(() => rq('state import a.json b.json'), /usage : state import <fichier>/);
  assert.throws(() => rq('state'), /usage : state import <fichier>/);
  assert.throws(() => rq('state import a.json --origin x'), /option --origin inconnue pour state dans run/);
});

test('compileScript : state import exige le client CLI (files) ; API et MCP orientés vers leurs voies', () => {
  assert.throws(() => compileScript('state import a.json\nnav http://h/'), status400(/ligne 1 : state import <fichier> .*CLI `grasp run`.*POST \/state\/import.*state_import/));
  const steps = compileScript('nav http://h/\nstate import a.json', { files: true });
  assert.equal(steps[1]!.rq.loadFrom, 'a.json');
});

test('attachImports : contenu lu par la CLI posé dans le corps de l\'étape ; fichier manquant ou en trop → 400 avant exécution', () => {
  const mk = () => compileScript('state import a.json\nnav http://h/\nstate import a.json', { files: true });
  const steps = mk();
  attachImports(steps, { 'a.json': { path: '/tmp/a.json', state: { format: 'grasp-state', version: 1 } } });
  assert.deepEqual(steps[0]!.rq.body, { state: { format: 'grasp-state', version: 1 }, file: '/tmp/a.json' });
  assert.deepEqual(steps[2]!.rq.body, steps[0]!.rq.body);
  assert.deepEqual(steps[1]!.rq.body, { url: 'http://h/' }, 'les autres étapes ne changent pas');
  assert.throws(() => attachImports(mk(), undefined), status400(/ligne 1 : state import a\.json : contenu du fichier non transmis/));
  assert.throws(() => attachImports(mk(), { 'a.json': { path: '/a' } }), status400(/contenu du fichier non transmis/));
  assert.throws(() => attachImports(mk(), { 'a.json': { state: {} }, 'b.json': { state: {} } }), status400(/« b\.json » n'est cité par aucune ligne state import/));
  assert.throws(() => attachImports(mk(), []), status400(/champ « imports »/));
  // Sans state import : rien à faire, imports absent accepté.
  attachImports(compileScript('nav http://h/'), undefined);
  // Clé héritée d'Object.prototype : jamais prise pour un fichier transmis.
  assert.throws(() => attachImports(compileScript('state import constructor', { files: true }), {}), status400(/non transmis/));
});

test('readRunImports : fichiers lus (relatifs au répertoire courant), JSON analysé, erreurs sans extrait du fichier', () => {
  const root = mkdtempSync(join(tmpdir(), 'grasp-imports-'));
  try {
    mkdirSync(join(root, 'etats'));
    writeFileSync(join(root, 'etats', 'a.json'), JSON.stringify({ format: 'grasp-state', version: 1, origins: [] }));
    const got = readRunImports('state import etats/a.json\nnav http://h/\nstate import etats/a.json\n', root);
    assert.deepEqual(got, { 'etats/a.json': { path: join(root, 'etats', 'a.json'), state: { format: 'grasp-state', version: 1, origins: [] } } });
    assert.deepEqual(readRunImports('nav http://h/\n', root), {});
    assert.throws(() => readRunImports('nav http://h/\nstate import absent.json\n', root), /ligne 2 : state import absent\.json : lecture impossible/);
    assert.throws(() => readRunImports('state import etats\n', root), /n'est pas un fichier/);
    writeFileSync(join(root, 'jeton.json'), 'jeton=SECRET-123');
    assert.throws(() => readRunImports('state import jeton.json\n', root), (e: Error) => /JSON invalide/.test(e.message) && !e.message.includes('SECRET'));
    // Script invalide : rien lu ici, l'erreur d'analyse vient du serveur.
    assert.deepEqual(readRunImports('cliq e1\nstate import absent.json\n', root), {});
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('run : bilan d\'un state import (mêmes mots que la commande isolée)', () => {
  assert.deepEqual(stateImportNotes({ cookies: 1, origins: 2, localStorageKeys: 3, sessionStorage: 'pending', skipped: ['origine http://x hors allowlist'] }), [
    'état importé : 1 cookie(s), localStorage de 2 origine(s) (3 clé(s)), sessionStorage : appliqué au premier document de son origine',
    'AVERTISSEMENT : non importé : origine http://x hors allowlist',
  ]);
});

test('history : state import avec fichier connu → ligne rejouable par run ; sans fichier → commentée, raison dite', () => {
  const withFile = commandOf('POST', '/state/import', { state: { cookies: [{ value: 'secret' }] }, file: '/home/u/etat.json' })!;
  assert.equal(withFile.kind, 'action');
  assert.equal(renderLine(withFile.line), 'state import /home/u/etat.json');
  assert.doesNotMatch(renderLine(withFile.line), /secret/);
  const bare = commandOf('POST', '/state/import', { state: {} })!;
  const e = (seq: number, c: NonNullable<ReturnType<typeof commandOf>>): HistoryEntry => ({ seq, at: '2026-11-12T10:00:00.000Z', ms: 1, ok: true, via: 'api', kind: c.kind, line: c.line });
  const s = asRunScript([e(1, withFile), e(2, commandOf('POST', '/navigate', { url: 'http://h/' })!), e(3, bare)], { sessionId: 's', now: new Date(0) });
  assert.match(s, /^state import \/home\/u\/etat\.json$/m, 'ligne exécutable, pas un commentaire');
  assert.match(s, /^# state import <fichier> +# #3 : contenu reçu sans fichier/m);
  const lines = parseScript(s);
  assert.deepEqual(lines.map((l) => l.argv.slice(0, 2).join(' ')), ['state import', 'nav http://h/']);
  for (const l of lines) { const a = parseArgs(l.argv); checkRunFlags(a); buildRequest(a); }
});

test('refus d\'eval : alternatives sans eval, la clé de config présentée comme décision de l\'utilisateur, jamais comme commande à lancer', () => {
  assert.match(EVAL_REFUSAL, /^eval est désactivé/);
  // Vague 3 : --origin (session posée avant chargement) et assertions de mise en page, alternatives sans eval elles aussi.
  for (const alt of ['storage', '--origin', 'expect text', 'in-viewport', 'not-clipped', 'no-horizontal-overflow', '--boxes', 'find', 'snap', 'network']) assert.ok(EVAL_REFUSAL.includes(alt), `alternative ${alt} absente`);
  assert.match(EVAL_REFUSAL, /décision de l'utilisateur humain, pas de l'agent/);
  assert.doesNotMatch(EVAL_REFUSAL, /config set/);
  assert.doesNotMatch(EVAL_REFUSAL, /pour l'autoriser/);
});

test('MCP : outils storage (get|set|rm, local|session) et state_import (JSON en argument, pas de chemin)', () => {
  const tools = toolList() as Array<{ name: string; inputSchema: { properties: Record<string, { enum?: string[] }>; required?: string[] }; description: string }>;
  const st = tools.find((t) => t.name === 'storage')!;
  assert.ok(st, 'outil storage absent');
  assert.deepEqual(st.inputSchema.properties.op!.enum, ['get', 'set', 'rm']);
  assert.deepEqual(st.inputSchema.properties.area!.enum, ['local', 'session']);
  assert.deepEqual(st.inputSchema.required, ['op', 'area', 'key']);
  assert.match(st.description, /allowCookies/);
  const imp = tools.find((t) => t.name === 'state_import')!;
  assert.ok(imp, 'outil state_import absent');
  assert.deepEqual(Object.keys(imp.inputSchema.properties), ['state']);
  assert.match(imp.description, /sans eval/i);
});

test('runFilePath : ~ en tête développé (aucun shell sur une ligne de run), le reste relatif au répertoire courant', () => {
  assert.equal(runFilePath('~/etat.json', '/rep', '/home/u'), '/home/u/etat.json');
  assert.equal(runFilePath('~', '/rep', '/home/u'), '/home/u');
  assert.equal(runFilePath('etats/a.json', '/rep', '/home/u'), '/rep/etats/a.json');
  assert.equal(runFilePath('/abs/a.json', '/rep', '/home/u'), '/abs/a.json');
  // Ni ~utilisateur ni variables d'environnement : pris tels quels (documenté).
  assert.equal(runFilePath('~autre/a.json', '/rep', '/home/u'), '/rep/~autre/a.json');
  assert.equal(runFilePath('$HOME/a.json', '/rep', '/home/u'), '/rep/$HOME/a.json');
});

test('readRunImports : ~/fichier lu dans le répertoire personnel ; limites par fichier et au total', () => {
  const root = mkdtempSync(join(tmpdir(), 'grasp-imports-'));
  try {
    const home = join(root, 'maison');
    mkdirSync(home);
    const st = JSON.stringify({ format: 'grasp-state', version: 1, origins: [] });
    writeFileSync(join(home, 'etat.json'), st);
    assert.deepEqual(readRunImports('state import ~/etat.json\n', join(root, 'ailleurs'), undefined, home), { '~/etat.json': { path: join(home, 'etat.json'), state: JSON.parse(st) } });
    writeFileSync(join(root, 'a.json'), st);
    writeFileSync(join(root, 'b.json'), st);
    const n = Buffer.byteLength(st);
    // Chaque fichier passe seul, les deux ensemble dépassent : refus à la ligne du second.
    assert.equal(Object.keys(readRunImports('state import a.json\nstate import b.json\n', root, 2 * n)).length, 2);
    assert.throws(() => readRunImports('state import a.json\nstate import b.json\n', root, 2 * n - 1), /ligne 2 : state import b\.json : fichiers d'état trop gros pour un run \(\d+ octets au plus en tout\)/);
    assert.throws(() => readRunImports('state import a.json\n', root, n - 1), /ligne 1 : state import a\.json : lecture impossible : \d+ octets/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('checkRunBody : corps complet mesuré avant l\'envoi (script et imports compris), refus clair au-delà', () => {
  const body = { script: 'state import a.json', files: true, imports: { 'a.json': { path: '/a.json', state: { x: 'é' } } } };
  const n = Buffer.byteLength(JSON.stringify(body));
  checkRunBody(body, n);
  assert.throws(() => checkRunBody(body, n - 1), new RegExp(`run trop gros : ${n} octets à envoyer \\(${n - 1} au plus, script et fichiers de state import compris\\)`));
});

test('MCP state_import : argument borné en octets, JSON invalide sans extrait', () => {
  assert.deepEqual(parseStateArg('{"a":"é"}', 10), { a: 'é' });
  assert.throws(() => parseStateArg('{"a":"é"}', 9), /state : 10 octets \(9 au plus\)/);
  assert.throws(() => parseStateArg('{"jeton": SECRET', 1000), (e: Error) => /JSON invalide/.test(e.message) && !e.message.includes('SECRET'));
});

test('refus des autres clés de politique (allowCookies, allowUpload, allowConsole) : la clé nommée, jamais la commande qui la relâche', () => {
  for (const key of ['allowCookies', 'allowUpload', 'allowConsole'] as const) {
    const m = policyRefusal('x est désactivé', key);
    assert.match(m, new RegExp(`^x est désactivé par la politique de Grasp \\(clé ${key}\\)\\. .*décision de l'utilisateur humain, pas de l'agent`));
    assert.doesNotMatch(m, /config set|pour l'autoriser/);
  }
});
