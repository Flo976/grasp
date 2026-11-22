import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RecipeError, isRecipe, maskedOf, parseDotenv, resolveRecipe, resolveStateInput } from '../../src/core/recipe.js';
import { parseState } from '../../src/core/state.js';
import { Redactor } from '../../src/core/secrets.js';
import { readRunImports, readStateInput } from '../../src/cli/runfiles.js';
import { makeTestEnv } from '../helpers/env.js';

const TOKEN = 'jeton-acces-0123456789abcdef';
const FILES: Record<string, string> = {
  '/r/jetons.json': JSON.stringify({ lite: { accessToken: TOKEN, user: { id: 7, nom: 'Camille' }, n: 42, vide: null }, liste: ['zero', 'un-deux-trois'] }),
  '/r/.env': `# commentaire\nexport SESSION_ID="sid-valeur-secrete"\nCOURT=ab\nNU=valeur-nue # fin\nSIMPLE='avec # dièse'\n`,
  '/r/brut.txt': 'contenu-entier-du-fichier\n',
};
const readFile = (p: string): string => { const v = FILES[p]; if (v === undefined) throw Object.assign(new Error('absent'), { code: 'ENOENT' }); return v; };
const opts = { baseDir: '/r', home: '/home/x', readFile };

test('isRecipe : une recette a une origine ; un état exporté ou un storageState n\'en est jamais une', () => {
  assert.equal(isRecipe({ origin: 'https://app.exemple.com', localStorage: {} }), true);
  assert.equal(isRecipe([{ origin: 'https://a.exemple.com' }, { origin: 'https://b.exemple.com' }]), true);
  assert.equal(isRecipe({ format: 'grasp-recipe', origin: 'https://a.exemple.com' }), true);
  assert.equal(isRecipe({ format: 'grasp-state', version: 1, cookies: [], origins: [] }), false);
  assert.equal(isRecipe({ cookies: [], origins: [{ origin: 'https://a.exemple.com', localStorage: [] }] }), false);
  assert.equal(isRecipe([]), false);
  assert.equal(isRecipe('texte'), false);
});

test('resolveRecipe : littéraux, @file:, @env:, @@ ; état grasp-state valide ; seules les références sont masquées', () => {
  const r = resolveRecipe({
    origin: 'https://dev.app.exemple.com/chemin/ignoré',
    localStorage: { token: '@file:jetons.json#lite.accessToken', user: '@file:jetons.json#lite.user', n: '@file:jetons.json#lite.n', item: '@file:jetons.json#liste.1', locale: 'fr', flag: true, obj: { a: 1 }, arobase: '@@file:pas-une-reference', brut: '@file:brut.txt' },
    sessionStorage: { onglet: 'accueil' },
    cookies: { sid: '@env:.env#SESSION_ID', nu: '@env:.env#NU', simple: '@env:.env#SIMPLE' },
  }, opts);
  assert.equal(r.recipe, true);
  const st = parseState(r.state);
  assert.deepEqual(st.origins, [{ origin: 'https://dev.app.exemple.com', localStorage: [
    { name: 'token', value: TOKEN }, { name: 'user', value: '{"id":7,"nom":"Camille"}' }, { name: 'n', value: '42' }, { name: 'item', value: 'un-deux-trois' },
    { name: 'locale', value: 'fr' }, { name: 'flag', value: 'true' }, { name: 'obj', value: '{"a":1}' }, { name: 'arobase', value: '@file:pas-une-reference' }, { name: 'brut', value: 'contenu-entier-du-fichier' },
  ] }]);
  assert.deepEqual(st.sessionStorage, { origin: 'https://dev.app.exemple.com', items: [{ name: 'onglet', value: 'accueil' }] });
  assert.deepEqual(st.cookies.map((c) => [c.name, c.value, c.domain, c.path, c.secure]), [
    ['sid', 'sid-valeur-secrete', 'dev.app.exemple.com', '/', true], ['nu', 'valeur-nue', 'dev.app.exemple.com', '/', true], ['simple', 'avec # dièse', 'dev.app.exemple.com', '/', true],
  ]);
  // Masquées : les valeurs venues d'un fichier (≥ 4 caractères) ; « 42 » est trop court (note), les littéraux ne le sont pas.
  assert.deepEqual(r.masked.map((m) => m.label), ['localStorage.token', 'localStorage.user', 'localStorage.item', 'localStorage.brut', 'cookie.sid', 'cookie.nu', 'cookie.simple']);
  assert.equal(r.masked[0]!.value, TOKEN);
  assert.equal(r.notes.length, 1);
  assert.match(r.notes[0]!, /localStorage\.n : valeur de 2 caractère\(s\), trop courte pour être masquée/);
});

test('resolveRecipe : cookies en tableau (attributs), plusieurs origines, http : cookie non Secure', () => {
  const r = resolveRecipe([
    { origin: 'http://127.0.0.1:8080', cookies: [{ name: 'sid', value: '@env:.env#SESSION_ID', httpOnly: true, sameSite: 'Lax', path: '/app' }] },
    { origin: 'https://api.exemple.com', localStorage: { k: 'v' } },
  ], opts);
  const st = parseState(r.state);
  assert.deepEqual(st.cookies, [{ name: 'sid', value: 'sid-valeur-secrete', domain: '127.0.0.1', path: '/app', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }]);
  assert.deepEqual(st.origins, [{ origin: 'https://api.exemple.com', localStorage: [{ name: 'k', value: 'v' }] }]);
});

test('resolveRecipe : refus explicites, jamais une valeur ni un extrait de fichier dans le message', () => {
  const bad: Array<[unknown, RegExp]> = [
    [{ origin: 'ftp://x', localStorage: {} }, /origine http\(s\) attendue/],
    [{ origin: 'https://a.exemple.com', localstorage: {} }, /clé inconnue « localstorage »/],
    [{ origin: 'https://a.exemple.com', localStorage: [] }, /objet \{ "clé": "valeur" \} attendu/],
    [{ origin: 'https://a.exemple.com', localStorage: { t: '@file:absent.json#a' } }, /recette\.localStorage\.t : lecture de \/r\/absent\.json impossible : ENOENT/],
    [{ origin: 'https://a.exemple.com', localStorage: { t: '@file:jetons.json#lite.absent' } }, /chemin « lite\.absent » absent \(ou nul\) dans \/r\/jetons\.json/],
    [{ origin: 'https://a.exemple.com', localStorage: { t: '@file:jetons.json#lite.vide' } }, /absent \(ou nul\)/],
    [{ origin: 'https://a.exemple.com', localStorage: { t: '@file:brut.txt#a' } }, /n'est pas du JSON/],
    [{ origin: 'https://a.exemple.com', localStorage: { t: '@env:.env' } }, /nom de variable attendu/],
    [{ origin: 'https://a.exemple.com', localStorage: { t: '@env:.env#ABSENTE' } }, /variable ABSENTE absente de \/r\/\.env/],
    [{ origin: 'https://a.exemple.com', localStorage: { t: null } }, /valeur attendue/],
    [{ origin: 'https://a.exemple.com', cookies: [{ name: 'a', value: 'b', inconnu: 1 }] }, /clé inconnue « inconnu »/],
    [[{ origin: 'https://a.exemple.com', sessionStorage: { a: 'b' } }, { origin: 'https://b.exemple.com', sessionStorage: { a: 'b' } }], /une seule origine peut porter un sessionStorage/],
  ];
  for (const [v, re] of bad) {
    assert.throws(() => resolveRecipe(v, opts), (e: Error) => e instanceof RecipeError && re.test(e.message) && !e.message.includes(TOKEN) && !e.message.includes('sid-valeur') && !e.message.includes('contenu-entier'), JSON.stringify(v));
  }
  // Contenu reçu sans fichier (MCP, API) : aucune lecture de fichier.
  assert.throws(() => resolveRecipe({ origin: 'https://a.exemple.com', localStorage: { t: '@file:jetons.json#lite.accessToken' } }, { ...opts, refs: false }), /référence @file: refusée ici .*grasp session create --state/);
  assert.deepEqual(parseState(resolveStateInput({ origin: 'https://a.exemple.com', localStorage: { k: 'v' } }, { refs: false }).state).origins[0]!.localStorage, [{ name: 'k', value: 'v' }]);
});

test('resolveStateInput : un état exporté passe tel quel, sans masque', () => {
  const st = { format: 'grasp-state', version: 1, cookies: [], origins: [] };
  const r = resolveStateInput(st, opts);
  assert.equal(r.state, st);
  assert.deepEqual([r.masked, r.notes, r.recipe], [[], [], false]);
});

test('parseDotenv : export, guillemets, commentaires', () => {
  const m = parseDotenv('A=1\nexport B="x y"\nC=\'z # w\'\n# D=non\nE=val # commentaire\nF="a\\nb"\n pas une ligne\n');
  assert.deepEqual([...m], [['A', '1'], ['B', 'x y'], ['C', 'z # w'], ['E', 'val'], ['F', 'a\nb']]);
});

test('maskedOf : champ du serveur strictement validé', () => {
  assert.deepEqual(maskedOf(undefined), []);
  assert.deepEqual(maskedOf([{ label: 'localStorage.clé bizarre/…', value: 'abcdef' }]), [{ label: 'localStorage.clé_bizarre_', value: 'abcdef' }]);
  assert.throws(() => maskedOf('x'), /tableau/);
  assert.throws(() => maskedOf([{ label: 'a' }]), /\{ label, value \}/);
  assert.throws(() => maskedOf([{ label: 'a', value: 'x'.repeat(5000) }]), /4096 au plus/);
});

test('Redactor.mask : valeur rendue « masqué:<libellé> », formes encodées et valeur coupée comprises ; secrets inchangés', () => {
  const r = new Redactor();
  r.add('MDP', 'motdepasse-1');
  r.mask('localStorage.token', TOKEN);
  assert.equal(r.redact(`Bearer ${TOKEN} / motdepasse-1`), 'Bearer masqué:localStorage.token / secret:MDP');
  assert.equal(r.redact(`"${TOKEN.slice(0, 9)}…"`), '"masqué:localStorage.token…"');
  r.mask('localStorage.url', 'a b&c=d/é');
  assert.equal(r.redact(`?x=${encodeURIComponent('a b&c=d/é')}`), '?x=masqué:localStorage.url');
  // Un jeton long (JWT) reste rapide à masquer sur une sortie de la taille d'un snapshot.
  const jwt = `${'eyJhbGciOiJIUzI1NiJ9'}.${'A1b2C3d4'.repeat(160)}.${'z9Y8x7W6'.repeat(8)}`;
  r.mask('localStorage.jwt', jwt);
  const page = `${'ligne de snapshot ordinaire e5k2:button "Valider"\n'.repeat(250)}${jwt}\n`;
  const t0 = Date.now();
  const out = r.redact(page);
  assert.ok(Date.now() - t0 < 500, `masquage en ${Date.now() - t0} ms`);
  assert.ok(out.endsWith('masqué:localStorage.jwt\n'));
  assert.ok(!out.includes('A1b2C3d4'));
});

test('readStateInput / readRunImports : recette lue par la CLI, références relatives au répertoire de la recette', () => {
  const t = makeTestEnv();
  try {
    const dir = join(t.root, 'recettes');
    mkdirSync(dir);
    writeFileSync(join(dir, 'jetons.json'), JSON.stringify({ lite: { accessToken: TOKEN } }));
    writeFileSync(join(dir, 'session.json'), JSON.stringify({ origin: 'http://127.0.0.1:8080', localStorage: { token: '@file:jetons.json#lite.accessToken' } }));
    const r = readStateInput(join(dir, 'session.json'), t.root, t.root);
    assert.equal(r.path, join(dir, 'session.json'));
    assert.deepEqual(r.masked, [{ label: 'localStorage.token', value: TOKEN }]);
    const imports = readRunImports('state import recettes/session.json\nnav http://127.0.0.1:8080/', t.root, undefined, t.root);
    assert.deepEqual(imports['recettes/session.json']!.masked, [{ label: 'localStorage.token', value: TOKEN }]);
    assert.equal(parseState(imports['recettes/session.json']!.state).origins[0]!.localStorage[0]!.value, TOKEN);
    // Référence illisible : refus avant tout envoi, sans contenu.
    writeFileSync(join(dir, 'ko.json'), JSON.stringify({ origin: 'http://127.0.0.1:8080', localStorage: { token: '@file:absent.json#a' } }));
    assert.throws(() => readRunImports('state import recettes/ko.json', t.root, undefined, t.root), /ligne 1 : state import recettes\/ko\.json : recette\.localStorage\.token : lecture de .*absent\.json impossible : ENOENT/);
    assert.throws(() => readStateInput(join(dir, 'absent.json'), t.root, t.root), /lecture de .*absent\.json : ENOENT/);
  } finally { t.cleanup(); }
});
