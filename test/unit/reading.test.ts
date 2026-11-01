import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot, type AXNode } from '../../src/bridge/snapshot.js';
import { truncateText, TRUNC_RE, DEFAULT_LIMITS } from '../../src/core/limits.js';
import { nearest } from '../../src/bridge/match.js';

let seq = 0;
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

// ---------- Limites de taille ----------

test('limites par défaut : text et diff 4000 caractères, snap ramené à 12000 octets, attente plafonnée à 5 s', () => {
  assert.deepEqual(DEFAULT_LIMITS, { snapMax: 12_000, textMax: 4000, diffMax: 4000, stableTimeoutMs: 5000, inputDeliveryMs: 300 });
});

test('truncateText : intact sous la limite, sinon coupe + dernière ligne explicite avec le reste exact', () => {
  assert.equal(truncateText('court', 10), 'court');
  const lines = Array.from({ length: 300 }, (_, i) => `ligne ${i} ${'x'.repeat(20)}`);
  const text = lines.join('\n');
  const t = truncateText(text, 1000);
  const all = t.split('\n');
  const last = all.pop()!;
  assert.match(last, /^… tronqué : \d+ caractères restants — affinez avec --max N \/ --scope <ref\|css>$/);
  assert.match(last, TRUNC_RE);
  const kept = all.join('\n');
  assert.ok(kept.length <= 1000, `gardé ${kept.length}`);
  assert.ok(text.startsWith(kept));
  assert.equal(Number(/(\d+) caractères/.exec(last)![1]), text.length - kept.length, 'le reste annoncé est exact');
  // coupe en fin de ligne quand c'est possible
  assert.ok(lines.includes(all[all.length - 1]!), `ligne coupée : ${all[all.length - 1]}`);
});

test('truncateText : une seule ligne géante est coupée au caractère près, sans casser une paire de substitution', () => {
  const t = truncateText(`${'a'.repeat(9)}😀${'b'.repeat(50)}`, 10);
  const kept = t.split('\n')[0]!;
  assert.equal(kept, 'a'.repeat(9));
  assert.match(t, /tronqué : 52 caractères restants/);
});

// ---------- Snapshot : élagage annoncé, zone, troncature ----------

test('élagage annoncé : liens sans nom masqués (refs résolubles) et iframes non parcourues comptés en dernière ligne', () => {
  const tree = flatten(ax('RootWebArea', 'T', [
    ax('link', 'Accueil', [ax('StaticText', 'Accueil')]),
    ax('link', '', [ax('image', '')]),
    ax('link', '', []),
    ax('link', '', []),
    ax('Iframe', 'cadre'),
    ax('Iframe', ''),
    ax('button', 'OK'),
  ]));
  const s = buildSnapshot(tree, { url: 'u', title: 'T' });
  const lines = s.text.split('\n');
  assert.equal(lines.filter((l) => /:link\b/.test(l)).length, 1, s.text);
  assert.match(lines[lines.length - 1]!, /^… élagué : 3 liens sans nom .*, 2 iframes non parcourues$/);
  const nameless = [...s.meta].filter(([, m]) => m.role === 'link' && m.name === '');
  assert.equal(nameless.length, 3, 'les liens sans nom gardent une ref résoluble');
  for (const [ref] of nameless) assert.ok(s.refs.has(ref));
});

test('pas de ligne d\'élagage quand rien n\'est masqué', () => {
  const s = buildSnapshot(flatten(ax('RootWebArea', 'T', [ax('button', 'OK')])), { url: 'u', title: 'T' });
  assert.doesNotMatch(s.text, /élagué/);
});

test('troncature du snapshot : dernière ligne « … tronqué : N caractères restants », budget en octets respecté', () => {
  const many = Array.from({ length: 500 }, (_, i) => ax('link', `Produit numéro ${i}`));
  const nodes = flatten(ax('RootWebArea', 'T', many));
  const s = buildSnapshot(nodes, { url: 'u', title: 'T', maxBytes: 2000 });
  assert.ok(Buffer.byteLength(s.text) <= 2000, `taille ${Buffer.byteLength(s.text)}`);
  const last = s.text.split('\n').pop()!;
  assert.match(last, /^… tronqué : \d+ caractères restants \(\d+ nœuds omis\) — affinez avec --max N \/ --scope <ref\|css>$/);
  const full = buildSnapshot(nodes, { url: 'u', title: 'T', maxBytes: 1e9 });
  const kept = s.text.split('\n').slice(0, -1).join('\n');
  assert.equal(Number(/(\d+) caractères/.exec(last)![1]), full.text.length - kept.length, 'reste exact (sauts de ligne compris)');
});

test('zone (scope) : seules les lignes du sous-arbre, mêmes refs que le snapshot complet', () => {
  const build = () => flatten(ax('RootWebArea', 'T', [
    ax('navigation', '', [ax('link', 'Valider'), ax('link', 'Aide')]),
    ax('main', '', [
      ax('heading', 'Zone', [ax('StaticText', 'Zone')], { properties: [{ name: 'level', value: { value: 2 } }] }),
      ax('link', 'Valider'),
      ax('paragraph', '', [ax('StaticText', 'dans la zone')]),
    ]),
    ax('StaticText', 'hors zone'),
  ]));
  const nodes = build();
  const main = nodes.find((n) => n.role?.value === 'main')!;
  const full = buildSnapshot(nodes, { url: 'u', title: 'T' });
  const z = buildSnapshot(nodes, { url: 'u', title: 'T', scopeBackendId: main.backendDOMNodeId! });
  assert.equal(z.scopeFound, true);
  assert.doesNotMatch(z.text, /Aide|hors zone/);
  assert.match(z.text, /dans la zone/);
  const zoneLink = z.text.split('\n').find((l) => l.includes('link "Valider"'))!.trim().split(':')[0]!;
  const fullLinks = full.text.split('\n').filter((l) => l.includes('link "Valider"')).map((l) => l.trim().split(':')[0]!);
  assert.equal(fullLinks.length, 2);
  assert.equal(zoneLink, fullLinks[1], 'la ref dans la zone est celle du snapshot complet (rang parmi les homonymes de la page)');
  assert.equal(z.refs.size, full.refs.size, 'toutes les refs de la page restent résolubles');
  assert.ok([...z.entries.values()].every((l) => !l.includes('Aide')), 'le diff ne porte que sur la zone');
  const absent = buildSnapshot(nodes, { url: 'u', title: 'T', scopeBackendId: 99_999 });
  assert.equal(absent.scopeFound, false);
});

// ---------- Candidats les plus proches ----------

test('nearest : même rôle et nom proche d\'abord, 3 au plus', () => {
  const cands = [
    { ref: 'e1', role: 'button', name: 'Panier (2)' },
    { ref: 'e2', role: 'link', name: 'Panier' },
    { ref: 'e3', role: 'button', name: 'Payer' },
    { ref: 'e4', role: 'heading', name: 'Votre compte' },
    { ref: 'e5', role: 'button', name: 'Aide' },
  ];
  const r = nearest({ role: 'button', name: 'Panier (1)' }, cands, 3);
  assert.equal(r.length, 3);
  assert.deepEqual(r.map((c) => c.ref).slice(0, 2), ['e1', 'e2']);
  const t = nearest({ name: 'valder' }, [{ ref: 'a', role: 'button', name: 'Valider' }, { ref: 'b', role: 'link', name: 'Aide' }], 3);
  assert.equal(t[0]!.ref, 'a');
});
