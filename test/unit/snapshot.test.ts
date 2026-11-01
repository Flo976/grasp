import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot, diffSnapshots, type AXNode } from '../../src/bridge/snapshot.js';

let seq = 0;
/** Petit constructeur d'arbre AX au format CDP Accessibility.getFullAXTree. */
function ax(role: string, name = '', children: AXNode[] = [], extra: Partial<AXNode> = {}): AXNode {
  const n: AXNode = { nodeId: String(++seq), role: { value: role }, name: { value: name }, childIds: [], backendDOMNodeId: seq, ...extra };
  (n as any).__children = children;
  return n;
}
function flatten(root: AXNode): AXNode[] {
  const out: AXNode[] = [];
  const walk = (n: AXNode, parent?: string) => {
    const kids: AXNode[] = (n as any).__children;
    n.childIds = kids.map((k) => k.nodeId);
    if (parent !== undefined) n.parentId = parent;
    out.push(n);
    kids.forEach((k) => walk(k, n.nodeId));
  };
  walk(root);
  return out;
}
const prop = (name: string, value: unknown) => ({ name, value: { value } });

function formTree(prefix: AXNode[] = []): AXNode[] {
  return flatten(ax('RootWebArea', 'Inscription', [
    ...prefix,
    ax('generic', '', [
      ax('heading', 'Inscription', [ax('StaticText', 'Inscription')], { properties: [prop('level', 1)] }),
      ax('LabelText', '', [ax('StaticText', 'Nom')]),
      ax('textbox', 'Nom', [ax('generic', '', [ax('StaticText', 'Ada')])], { value: { value: 'Ada' }, properties: [prop('required', true), prop('focused', true)] }),
      ax('checkbox', "J'accepte", [], { properties: [prop('checked', 'false')] }),
      ax('button', 'Valider', [ax('StaticText', 'Valider')], { properties: [prop('expanded', true)] }),
      ax('button', 'Annuler', [ax('StaticText', 'Annuler')], { properties: [prop('disabled', true)] }),
      ax('paragraph', '', [ax('StaticText', 'En attente')]),
      ax('generic', '', [], { ignored: true }),
    ]),
  ]));
}

test('format compact : ref:rôle "nom" + états, une ligne par nœud', () => {
  const s = buildSnapshot(formTree(), { url: 'http://h/', title: 'Inscription' });
  const lines = s.text.split('\n');
  assert.equal(lines[0], 'page "Inscription" http://h/');
  assert.ok(lines.some((l) => /^ ?e[0-9a-z]+:heading\[1\] "Inscription"$/.test(l.trim())), s.text);
  assert.ok(lines.some((l) => /^e[0-9a-z]+:textbox "Nom"="Ada" \[required\] \[focus\]$/.test(l.trim())), s.text);
  assert.ok(lines.some((l) => /^e[0-9a-z]+:checkbox "J'accepte" \[ \]$/.test(l.trim())), s.text);
  assert.ok(lines.some((l) => /^e[0-9a-z]+:button "Valider" \[\+\]$/.test(l.trim())), s.text);
  assert.ok(lines.some((l) => /^e[0-9a-z]+:button "Annuler" \[disabled\]$/.test(l.trim())), s.text);
  assert.ok(lines.some((l) => l.trim() === '"En attente"'), s.text);
});

test('élague le bruit : generic, ignorés, texte redondant avec un nom', () => {
  const s = buildSnapshot(formTree(), { url: 'http://h/', title: 'Inscription' });
  assert.ok(!s.text.split('\n').some((l) => l.trim() === '"Ada"'), 'la valeur du champ ne doit pas réapparaître en texte');
  assert.ok(!/generic|LabelText|StaticText|paragraph|RootWebArea/.test(s.text), s.text);
  // « Valider », « Nom », « Inscription » ne sont pas répétés en texte brut
  assert.ok(!s.text.split('\n').some((l) => ['"Valider"', '"Nom"', '"Inscription"'].includes(l.trim())), s.text);
});

test('refs stables : insérer un élément en haut ne décale aucune ref existante', () => {
  const a = buildSnapshot(formTree(), { url: 'http://h/', title: 'T' });
  const b = buildSnapshot(formTree([ax('button', 'Nouveau')]), { url: 'http://h/', title: 'T' });
  for (const [ref, line] of a.entries) assert.equal(b.entries.get(ref), line, `ref ${ref} a changé`);
  assert.equal(b.entries.size, a.entries.size + 1);
});

test('une ref ne change que si le rôle ou le nom accessible change', () => {
  const a = buildSnapshot(formTree(), { url: 'http://h/', title: 'T' });
  const tree = formTree();
  const btn = tree.find((n) => n.name?.value === 'Valider')!;
  btn.name = { value: 'Valider loyer' };
  const b = buildSnapshot(tree, { url: 'http://h/', title: 'T' });
  const refA = [...a.entries].find(([, l]) => l.includes('"Valider"'))![0];
  const refB = [...b.entries].find(([, l]) => l.includes('"Valider loyer"'))![0];
  assert.notEqual(refA, refB);
  // les autres refs ne bougent pas
  const others = [...a.entries].filter(([r]) => r !== refA);
  for (const [ref, line] of others) assert.equal(b.entries.get(ref), line);
});

test('changer une valeur ou un état ne change pas la ref', () => {
  const tree = formTree();
  const a = buildSnapshot(tree, { url: 'http://h/', title: 'T' });
  tree.find((n) => n.role?.value === 'checkbox')!.properties = [prop('checked', 'true')];
  const b = buildSnapshot(tree, { url: 'http://h/', title: 'T' });
  assert.deepEqual([...a.refs.keys()].sort(), [...b.refs.keys()].sort());
});

test('doublons rôle+nom : refs distinctes et stables', () => {
  const t = flatten(ax('RootWebArea', 'T', [ax('link', 'Voir'), ax('link', 'Voir'), ax('link', 'Voir')]));
  const s = buildSnapshot(t, { url: 'u', title: 'T' });
  assert.equal(new Set(s.refs.keys()).size, 3);
});

test('les refs pointent vers le backendDOMNodeId', () => {
  const tree = formTree();
  const s = buildSnapshot(tree, { url: 'u', title: 'T' });
  const tb = tree.find((n) => n.role?.value === 'textbox')!;
  const ref = [...s.entries].find(([, l]) => l.includes('textbox'))![0];
  assert.equal(s.refs.get(ref), tb.backendDOMNodeId);
});

test('budget en octets : le snapshot respecte maxBytes et signale la coupure', () => {
  const many = Array.from({ length: 500 }, (_, i) => ax('link', `Produit numéro ${i}`));
  const s = buildSnapshot(flatten(ax('RootWebArea', 'T', many)), { url: 'u', title: 'T', maxBytes: 2000 });
  assert.ok(Buffer.byteLength(s.text) <= 2000, `taille ${Buffer.byteLength(s.text)}`);
  assert.match(s.text, /omis/);
  assert.equal(s.refs.size, 500, 'les refs restent toutes résolubles même hors budget');
});

test('diff : seuls les nœuds ajoutés, retirés ou modifiés', () => {
  const tree = formTree();
  const a = buildSnapshot(tree, { url: 'http://h/', title: 'T' });
  tree.find((n) => n.role?.value === 'checkbox')!.properties = [prop('checked', 'true')];
  const b = buildSnapshot(tree, { url: 'http://h/', title: 'T' });
  const d = diffSnapshots(a, b);
  assert.match(d, /^~ e[0-9a-z]+:checkbox "J'accepte" \[x\]$/m);
  assert.equal(d.split('\n').length, 1, d);

  const c = buildSnapshot(formTree([ax('button', 'Nouveau')]), { url: 'http://h/', title: 'T' });
  assert.match(diffSnapshots(a, c), /^\+ e[0-9a-z]+:button "Nouveau"$/m);
  assert.equal(diffSnapshots(a, a), '(aucun changement)');
});

test('diff : une navigation renvoie le nouveau snapshot complet', () => {
  const a = buildSnapshot(formTree(), { url: 'http://h/', title: 'T' });
  const b = buildSnapshot(flatten(ax('RootWebArea', 'Merci', [ax('heading', 'Reçu')])), { url: 'http://h/ok', title: 'Merci' });
  const d = diffSnapshots(a, b);
  assert.match(d, /^navigation → http:\/\/h\/ok/);
  assert.match(d, /heading "Reçu"/);
});

// ---------- Erreurs de formulaire ----------

/** Tiroir : champ invalide (aria-invalid + description), champ valide décrit, bandeau role=alert. */
function errorTree(opts: { alertText?: string; invalid?: boolean } = {}): AXNode[] {
  return flatten(ax('RootWebArea', 'Erreurs', [
    ax('dialog', 'Modifier', [
      ax('textbox', 'Code postal', [], { value: { value: '75' }, description: { value: 'Code postal à 5 chiffres' }, properties: opts.invalid === false ? [] : [prop('invalid', 'true')] }),
      ...(opts.invalid === false ? [] : [ax('StaticText', 'Code postal à 5 chiffres')]),
      ax('textbox', 'Ville', [], { description: { value: 'Votre ville de résidence' }, properties: [prop('invalid', 'false')] }),
      ax('textbox', 'Nom', [], { properties: opts.invalid === false ? [] : [prop('invalid', 'true')] }),
      ax('textbox', 'Intitulé du poste', [], { value: { value: 'x'.repeat(56) }, properties: [prop('invalid', 'false')] }),
      ax('alert', '', opts.alertText !== undefined ? [ax('StaticText', opts.alertText)] : []),
      ax('button', 'Enregistrer'),
    ]),
  ]));
}
const lineOf = (text: string, re: RegExp) => text.split('\n').map((l) => l.trim()).find((l) => re.test(l));
const refFor = (s: { meta: Map<string, { role: string; name: string }> }, name: string) => [...s.meta].find(([, m]) => m.name === name)![0];

test('erreurs : champ invalide avec son message (description AX), compact ; champ valide : rien', () => {
  const s = buildSnapshot(errorTree(), { url: 'http://h/', title: 'Erreurs' });
  assert.match(lineOf(s.text, /textbox "Code postal"/) ?? '', /^e[0-9a-z]+:textbox "Code postal"="75" \[invalide: Code postal à 5 chiffres\]$/, s.text);
  assert.ok(!s.text.split('\n').some((l) => l.trim() === '"Code postal à 5 chiffres"'), 'message non répété en texte brut');
  assert.match(lineOf(s.text, /textbox "Nom"/) ?? '', /"Nom" \[invalide\]$/);
  assert.doesNotMatch(lineOf(s.text, /textbox "Ville"/) ?? '', /invalide|résidence/, 'la description d\'un champ valide n\'est pas affichée');
  assert.deepEqual(s.invalid.map((i) => [i.ref, i.message]), [[refFor(s, 'Code postal'), 'Code postal à 5 chiffres'], [refFor(s, 'Nom'), '']]);
});

test('erreurs du DOM (message hors arbre d\'accessibilité, balisage Malt) : rattachées au champ, ou en ligne « alerte »', () => {
  const nodes = errorTree();
  const poste = nodes.find((n) => n.name?.value === 'Intitulé du poste')!;
  const s = buildSnapshot(nodes, { url: 'http://h/', title: 'Erreurs', formErrors: { fields: new Map([[poste.backendDOMNodeId!, 'Doit compter au maximum 50 caractères']]), alerts: ['Session expirée'] } });
  assert.match(lineOf(s.text, /Intitulé du poste/) ?? '', /\[invalide: Doit compter au maximum 50 caractères\]$/, s.text);
  assert.ok(s.text.split('\n').some((l) => l.trim() === 'alerte "Session expirée"'), s.text);
  // Message très long : coupé.
  const long = buildSnapshot(nodes, { url: 'http://h/', title: 'Erreurs', formErrors: { fields: new Map([[poste.backendDOMNodeId!, 'm'.repeat(300)]]), alerts: [] } });
  assert.ok((lineOf(long.text, /Intitulé du poste/) ?? '').length < 260);
});

test('erreurs : avec le relevé DOM, l\'invalidité de l\'arbre seule (radio required jamais touché) n\'est pas affichée', () => {
  const nodes = flatten(ax('RootWebArea', 'R', [ax('radio', 'Jour', [], { properties: [prop('invalid', 'true')] })]));
  assert.match(buildSnapshot(nodes, { url: 'http://h/', title: 'R' }).text, /\[invalide\]/, 'sans relevé : l\'arbre fait foi');
  const s = buildSnapshot(nodes, { url: 'http://h/', title: 'R', formErrors: { fields: new Map(), alerts: [] } });
  assert.doesNotMatch(s.text, /invalide/, s.text);
  assert.deepEqual(s.invalid, []);
});

test('diff : apparition et disparition des erreurs (champ, alerte hors arbre, bandeau role=alert)', () => {
  const before = buildSnapshot(errorTree({ invalid: false }), { url: 'http://h/', title: 'T' });
  const bad = errorTree({ alertText: '2 erreur(s) dans le formulaire' });
  const poste = bad.find((n) => n.name?.value === 'Intitulé du poste')!;
  // Le relevé DOM voit Code postal (aria-invalid, message pris dans la description AX).
  const cp = bad.find((n) => n.name?.value === 'Code postal')!;
  const after = buildSnapshot(bad, { url: 'http://h/', title: 'T', formErrors: { fields: new Map([[poste.backendDOMNodeId!, 'Doit compter au maximum 50 caractères'], [cp.backendDOMNodeId!, '']]), alerts: ['Session expirée'] } });
  const d = diffSnapshots(before, after);
  assert.match(d, /^~ e[0-9a-z]+:textbox "Code postal"="75" \[invalide: Code postal à 5 chiffres\]$/m, d);
  assert.match(d, /^~ e[0-9a-z]+:textbox "Intitulé du poste"=.* \[invalide: Doit compter au maximum 50 caractères\]$/m, d);
  assert.match(d, /^~ e[0-9a-z]+:alert "2 erreur\(s\) dans le formulaire"$/m, d);
  assert.match(d, /^\+ alerte "Session expirée"$/m, d);
  assert.doesNotMatch(d, /^\+ "2 erreur/m, 'texte du bandeau non répété');
  const back = diffSnapshots(after, before);
  assert.match(back, /^- alerte "Session expirée"$/m, back);
  assert.match(back, /^~ e[0-9a-z]+:textbox "Code postal"="75"$/m, back);
});
