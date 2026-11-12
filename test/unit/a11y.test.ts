import { test } from 'node:test';
import assert from 'node:assert/strict';
import { axIssues, domIssue, imageFix, renderA11y, roleValid, scopeNodes, suggestRole, type A11yIssue } from '../../src/bridge/a11y.js';
import type { AXNode } from '../../src/bridge/snapshot.js';
import { buildRequest, checkRunFlags, parseArgs, splitLine } from '../../src/core/script.js';
import { describeExpected, expectSpecOf } from '../../src/core/expect.js';

/** Nœud d'arbre minimal : [id, rôle, nom, enfants, options]. */
function ax(spec: Array<[string, string, string, string[], { level?: number; ignored?: boolean; dom?: number }?]>): AXNode[] {
  const parent = new Map<string, string>();
  for (const [id, , , kids] of spec) for (const k of kids) parent.set(k, id);
  return spec.map(([id, role, name, kids, o]) => ({
    nodeId: id, role: { value: role }, name: { value: name }, childIds: kids,
    ...(parent.has(id) ? { parentId: parent.get(id)! } : {}),
    ...(o?.ignored === true ? { ignored: true } : {}),
    ...(o?.dom !== undefined ? { backendDOMNodeId: o.dom } : {}),
    ...(o?.level !== undefined ? { properties: [{ name: 'level', value: { value: o.level } }] } : {}),
  }));
}

test('axIssues : contrôles sans nom, images sans nom, titres sautés ; nœuds ignorés et nommés écartés', () => {
  const nodes = ax([
    ['r', 'RootWebArea', 'Page', ['h1', 'b1', 'b2', 'l1', 'i1', 'i2', 's1', 'h3', 'g', 'h2', 'h4', 'o1', 'x']],
    ['h1', 'heading', 'Titre', [], { level: 1, dom: 1 }],
    ['b1', 'button', '', [], { dom: 2 }],
    ['b2', 'button', 'OK', [], { dom: 3 }],
    ['l1', 'link', '  ​ ', [], { dom: 4 }],
    ['i1', 'image', '', [], { dom: 5 }],
    ['i2', 'image', '', [], { dom: 6, ignored: true }],
    ['s1', 'switch', '', [], { dom: 7 }],
    ['h3', 'heading', 'Sous', [], { level: 3, dom: 8 }],
    ['g', 'generic', '', ['tb'], {}],
    ['tb', 'textbox', '', [], { dom: 9 }],
    ['h2', 'heading', 'Deux', [], { level: 2, dom: 10 }],
    ['h4', 'heading', 'Quatre', [], { level: 4, dom: 11, ignored: true }],
    ['o1', 'option', '', [], { dom: 12 }],
    ['x', 'heading', 'Trois', [], { level: 3, dom: 13 }],
  ]);
  const all = axIssues(nodes, () => true);
  assert.deepEqual(all.map((i) => [i.kind, i.backendId]), [
    ['sans-nom', 2], ['sans-nom', 4], ['image-sans-alt', 5], ['sans-nom', 7], ['titre-saute', 8], ['sans-nom', 9],
  ]);
  assert.match(all.find((i) => i.kind === 'titre-saute')!.detail, /^h3 après h1 « Titre »$/);
  assert.match(all.find((i) => i.kind === 'titre-saute')!.fix, /^h2,/);
  // h2 → h4 ignoré (masqué) → h3 : pas de saut ; zone : les titres d'avant la zone comptent pour l'ordre.
  const inZone = new Set(['h3']);
  assert.deepEqual(axIssues(nodes, (n) => inZone.has(n.nodeId)).map((i) => i.kind), ['titre-saute']);
  assert.deepEqual(axIssues([], () => true), []);
});

test('imageFix : <img>/input image et role=img explicite signalés (correction selon l\'élément) ; svg sans role jamais', () => {
  assert.match(imageFix('img', undefined)!, /^alt=/);
  assert.match(imageFix('INPUT', undefined)!, /^alt=/);
  assert.equal(imageFix('svg', undefined), undefined, 'icône svg inline : pas une image à décrire');
  assert.equal(imageFix('svg', 'presentation'), undefined);
  assert.equal(imageFix('svg', 'imagee graphics-symbol'), undefined, 'premier jeton valide : graphics-symbol');
  assert.match(imageFix('svg', 'img')!, /^<title> en premier enfant, ou aria-label/);
  assert.doesNotMatch(imageFix('svg', 'IMG')!, /alt=/);
  assert.match(imageFix('div', 'foo img')!, /^aria-label/);
  assert.equal(imageFix('canvas', undefined), undefined);
});

test('scopeNodes : sous-arbre de la racine (par backendDOMNodeId), undefined si absente', () => {
  const nodes = ax([['r', 'RootWebArea', '', ['a', 'b']], ['a', 'form', '', ['c'], { dom: 1 }], ['b', 'button', 'x', [], { dom: 2 }], ['c', 'textbox', '', [], { dom: 3 }]]);
  assert.deepEqual([...scopeNodes(nodes, 1)!].sort(), ['a', 'c']);
  assert.equal(scopeNodes(nodes, 99), undefined);
});

test('roleValid / suggestRole : jetons de repli, rôles abstraits, français et fautes de frappe', () => {
  assert.equal(roleValid('button'), true);
  assert.equal(roleValid('BUTTON'), true);
  assert.equal(roleValid('toggle button'), true, 'premier jeton valide retenu');
  assert.equal(roleValid('doc-chapter'), true);
  assert.equal(roleValid('bouton'), false);
  assert.equal(roleValid('landmark'), false, 'abstrait');
  assert.equal(suggestRole('bouton'), 'button');
  assert.equal(suggestRole('Lien'), 'link');
  assert.equal(suggestRole('buton'), 'button');
  assert.equal(suggestRole('chekbox'), 'checkbox');
  assert.equal(suggestRole('xyz'), undefined);
  assert.equal(suggestRole('zzzzzzzz'), undefined);
});

test('domIssue : détail et correction de chaque problème DOM', () => {
  assert.match(domIssue({ k: 'libelle-orphelin', i: 0, d: 'label[for="x"] "Nom"', v: 'x' }, undefined).detail, /aucun élément d'id « x »/);
  assert.match(domIssue({ k: 'libelle-orphelin', i: 0, d: 'label', a: 'non-champ', v: 'x', m: ['span#x'] }, undefined).detail, /for vise span#x, qui n'est pas un champ/);
  const ref = domIssue({ k: 'reference-cassee', i: 0, d: 'input#v', a: 'aria-labelledby', m: ['a', 'b'] }, 7);
  assert.equal(ref.backendId, 7);
  assert.equal(ref.detail, 'aria-labelledby → ids absents : « a », « b »');
  assert.match(domIssue({ k: 'role-invalide', i: 0, d: 'div', v: 'bouton' }, undefined).fix, /^role="button"/);
  assert.match(domIssue({ k: 'role-invalide', i: 0, d: 'div', v: 'widget' }, undefined).detail, /« widget » : rôle abstrait/);
});

test('renderA11y : en-tête, comptes dans l\'ordre des types, une ligne par problème, coupure annoncée', () => {
  const issues: A11yIssue[] = [{ kind: 'sans-nom', ref: 'e1', who: 'e1:button', detail: 'aucun nom accessible', fix: 'aria-label' }];
  const t = renderA11y({ url: 'http://h/', title: 'T', total: 3, counts: { 'titre-saute': 1, 'sans-nom': 2 }, issues, omitted: 2 });
  assert.deepEqual(t.split('\n'), [
    'a11y : 3 problèmes — page "T" http://h/',
    '  contrôle sans nom : 2 · niveau de titre sauté : 1',
    'sans-nom e1:button — aucun nom accessible → aria-label',
    '… 2 problèmes non listés — affinez avec --max N / --scope <ref|css>',
  ]);
  assert.equal(renderA11y({ url: 'u', title: 'T', total: 0, counts: {}, issues: [], omitted: 0 }, '#f'), 'a11y : aucun problème relevé dans #f — page "T" u');
});

test('syntaxe : a11y → GET /a11y (max, scope transmis ; options d\'autres commandes refusées) ; expect a11y [--max N] [--scope]', () => {
  const r = (line: string) => buildRequest(parseArgs(splitLine(line)));
  assert.deepEqual(r('a11y'), { cmd: 'a11y', method: 'GET', path: '/a11y' });
  assert.deepEqual(r("a11y --max 5 --scope '#form'"), { cmd: 'a11y', method: 'GET', path: '/a11y?max=5&scope=%23form' });
  assert.throws(() => r('a11y --markdown'), /--markdown ne s'applique qu'à text/);
  assert.throws(() => r('a11y --name-max 3'), /--name-max ne s'applique qu'à snap/);
  assert.throws(() => r('a11y page'), /usage : grasp a11y/);
  assert.throws(() => checkRunFlags(parseArgs(splitLine('a11y --json'))), /--json n'a pas de sens sur une ligne de run/);
  assert.throws(() => checkRunFlags(parseArgs(splitLine('a11y --timeout 3'))), /option --timeout inconnue pour a11y dans run \(options : --max --scope\)/);
  checkRunFlags(parseArgs(splitLine("a11y --max 3 --scope '#f'")));
  assert.deepEqual(r('expect a11y').body, { kind: 'a11y' });
  assert.deepEqual(r("expect a11y --max 3 --scope '#f' --shot-on-error").body, { kind: 'a11y', max: '3', scope: '#f', shotOnError: true });
  checkRunFlags(parseArgs(splitLine('expect a11y --max 3')));
  assert.throws(() => r('expect a11y x'), /usage : grasp expect a11y \[--max N\]/);
  assert.throws(() => r('expect a11y --timeout 10'), /--timeout ne s'applique pas à expect a11y/);
  assert.throws(() => r('expect text x --max 3'), /--max ne s'applique pas à expect text/);
  assert.throws(() => r('expect a11y --max -1'), /« max » : entier positif ou nul attendu/);
  assert.equal(expectSpecOf({ kind: 'a11y', max: '2' }).max, 2);
  assert.equal(describeExpected({ kind: 'a11y' }), "au plus 0 problème(s) d'accessibilité dans la page");
  assert.equal(describeExpected({ kind: 'a11y', max: 3, scope: '#f' }), "au plus 3 problème(s) d'accessibilité dans #f");
});
