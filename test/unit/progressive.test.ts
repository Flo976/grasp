import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot, compileFind, type AXNode } from '../../src/bridge/snapshot.js';
import { snapReadOptions } from '../../src/bridge/server.js';
import { buildRequest, checkRunFlags, parseArgs, ScriptError } from '../../src/core/script.js';
import { TRUNC_RE } from '../../src/core/limits.js';

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
const h = (name: string, level: number) => ax('heading', name, [ax('StaticText', name)], { properties: [{ name: 'level', value: { value: level } }] });
const row = (nom: string) => ax('row', nom, [ax('cell', '', [ax('StaticText', nom)]), ax('cell', '', [ax('button', 'Supprimer')])]);

/** Page type : bandeau de navigation, contenu (titres, texte, tableau, formulaire), pied de page. */
function page(): AXNode[] {
  return flatten(ax('RootWebArea', 'Boutique', [
    ax('navigation', 'Principal', [ax('link', 'Accueil'), ax('link', 'Vélos'), ax('link', 'Contact')]),
    ax('main', '', [
      h('Catalogue', 1),
      ax('StaticText', 'Un long paragraphe de présentation qui coûte des octets.'),
      h('Clients', 2),
      ax('table', 'Clients', [row('Ada Lovelace'), row('Alan Turing')]),
      h('Commander', 2),
      ax('group', 'Livraison', [
        ax('textbox', 'Adresse', [], { value: { value: '1 rue Ada' } }),
        ax('combobox', 'Pays', [ax('MenuListPopup', '', [ax('option', 'France', [], { properties: [{ name: 'selected', value: { value: true } }] }), ax('option', 'Madagascar')])], { value: { value: 'France' }, properties: [{ name: 'expanded', value: { value: false } }] }),
      ]),
      ax('button', 'Écrire un avis'),
      h('Mentions', 2),
      ax('StaticText', 'Rien d\'actionnable ici.'),
    ]),
    ax('contentinfo', 'Pied', [ax('link', 'Mentions légales')]),
  ]));
}

const refsOf = (text: string) => new Map(text.split('\n').map((l) => /^\s*(e[0-9a-z]+):(\S+?)(?:\[\d\])? (".*?")/.exec(l)).filter((m) => m !== null).map((m) => [`${m![2]} ${m![3]}`, m![1]!]));

test('snap --outline : repères et titres seulement, volume de chaque repère, refs identiques au snapshot complet', () => {
  const nodes = page();
  const full = buildSnapshot(nodes, { url: 'u', title: 'Boutique' });
  const o = buildSnapshot(nodes, { url: 'u', title: 'Boutique', mode: 'outline' });
  const lines = o.text.split('\n');
  assert.match(lines[0]!, /^page "Boutique" u$/);
  assert.ok(lines.some((l) => /^e[0-9a-z]+:navigation "Principal" — 3 lignes, 3 actionnables$/.test(l)), o.text);
  assert.ok(lines.some((l) => /^ e[0-9a-z]+:heading\[2\] "Clients"$/.test(l)), `titre indenté sous main : ${o.text}`);
  assert.ok(!lines.some((l) => /:link|:button|:textbox|paragraphe/.test(l)), o.text);
  assert.match(lines[lines.length - 1]!, /^… lecture partielle \(--outline\) : \d+ lignes sur \d+ — snap --scope <ref> pour une zone, snap pour tout$/);
  // Mêmes refs que le snapshot complet, et les refs hors rendu restent résolubles.
  const fr = refsOf(full.text);
  for (const [k, ref] of refsOf(o.text)) assert.equal(fr.get(k), ref, k);
  assert.deepEqual([...o.refs], [...full.refs]);
  assert.ok(Buffer.byteLength(o.text) < Buffer.byteLength(full.text));
});

test('snap --interactive : actionnables, options, conteneurs et titres de contexte ; texte brut omis', () => {
  const nodes = page();
  const full = buildSnapshot(nodes, { url: 'u', title: 'Boutique' });
  const i = buildSnapshot(nodes, { url: 'u', title: 'Boutique', mode: 'interactive' });
  const t = i.text;
  assert.doesNotMatch(t, /paragraphe|Rien d'actionnable/, 'texte brut omis');
  assert.match(t, /:row "Ada Lovelace"\n {3}e[0-9a-z]+:button "Supprimer"/, `ligne de tableau gardée comme contexte : ${t}`);
  assert.match(t, /:combobox "Pays"="France"[^\n]*\n\s+options : "France" \[x\] \| "Madagascar"/, t);
  assert.match(t, /:group "Livraison"/);
  assert.match(t, /:heading\[2\] "Commander"/);
  assert.doesNotMatch(t, /"Mentions"\n/, 'titre sans actionnable dessous : omis');
  assert.match(t, /heading\[1\] "Catalogue"/, 'titre de niveau 1 : section englobante des h2 qui ont des actionnables');
  assert.match(t, /:contentinfo "Pied"\n e[0-9a-z]+:link "Mentions légales"/);
  const fr = refsOf(full.text);
  for (const [k, ref] of refsOf(t)) assert.equal(fr.get(k), ref, k);
  assert.match(t.split('\n').pop()!, /^… lecture partielle \(--interactive\) : \d+ lignes sur \d+/);
});

test('modes : page sans repère ni titre / sans actionnable → ligne finale qui le dit, au lieu d\'un vide muet', () => {
  const nodes = flatten(ax('RootWebArea', 'T', [ax('StaticText', 'Bonjour')]));
  assert.match(buildSnapshot(nodes, { url: 'u', title: 'T', mode: 'outline' }).text, /aucune ligne retenue sur 1 \(ni repère ni titre : snap --interactive, ou snap\)$/);
  assert.match(buildSnapshot(nodes, { url: 'u', title: 'T', mode: 'interactive' }).text, /aucun élément actionnable/);
});

test('find : texte sans casse ni accents, contexte, options de liste fermée, --role, limite annoncée', () => {
  const nodes = page();
  const full = buildSnapshot(nodes, { url: 'u', title: 'Boutique' });
  const fr = refsOf(full.text);
  const f = (q: string, extra: { roles?: string[]; limit?: number } = {}) => buildSnapshot(nodes, { url: 'u', title: 'Boutique', find: { pattern: compileFind(q), ...extra } }).text;
  let t = f('supprimer');
  assert.match(t, /^page "Boutique" u\nfind « supprimer » : 2 correspondances\n/);
  assert.match(t, /(e[0-9a-z]+):button "Supprimer" \(dans e[0-9a-z]+:row "Ada Lovelace"\)/);
  assert.match(t, /:button "Supprimer" \(dans e[0-9a-z]+:row "Alan Turing"\)/);
  t = f('ecrire');
  const m = /(e[0-9a-z]+):button "Écrire un avis"/.exec(t);
  assert.ok(m, t);
  assert.equal(m![1], fr.get('button "Écrire un avis"'), 'ref identique au snapshot complet');
  // Option d'un <select> fermé : pas de ligne à elle dans le snapshot, mais trouvée, ref comprise.
  t = f('madagascar');
  assert.match(t, /\ne[0-9a-z]+:option "Madagascar" \(dans e[0-9a-z]+:combobox "Pays"\)/, t);
  const opt = /(e[0-9a-z]+):option/.exec(t)![1]!;
  assert.ok(full.refs.has(opt) && full.meta.get(opt)?.name === 'Madagascar');
  // Texte brut : situé par son conteneur ; --role text le sélectionne.
  t = f('Ada', { roles: ['text'] });
  assert.match(t, /: 0|aucune correspondance/, 'le texte « Ada Lovelace » est déjà le nom de la ligne : pas de ligne de texte');
  t = f('paragraphe', { roles: ['text'] });
  assert.match(t, /"Un long paragraphe[^"]*" \(dans e[0-9a-z]+:main\)?/);
  // Valeur d'un champ.
  assert.match(f('1 rue'), /:textbox "Adresse"="1 rue Ada"/);
  // Regex, rôle multiple, limite.
  t = f('/^(Accueil|Contact)$/', { roles: ['link'] });
  assert.match(t, /2 correspondances/);
  t = f('/./', { roles: ['link', 'button'], limit: 2 });
  assert.equal(t.split('\n').filter((l) => /^e[0-9a-z]+:/.test(l)).length, 2);
  assert.match(t.split('\n').pop()!, /^… \d+ autres correspondances — --max N pour en voir plus, --role \/ --scope pour affiner$/);
  assert.match(f('introuvable'), /find « introuvable » : aucune correspondance$/);
});

test('find : budget en octets respecté, troncature annoncée', () => {
  const many = flatten(ax('RootWebArea', 'T', Array.from({ length: 400 }, (_, k) => ax('button', `Bouton numéro ${k} ${'x'.repeat(40)}`))));
  const t = buildSnapshot(many, { url: 'u', title: 'T', maxBytes: 2000, find: { pattern: compileFind('bouton'), limit: 500 } }).text;
  assert.ok(Buffer.byteLength(t) <= 2000, `${Buffer.byteLength(t)}`);
  assert.match(t.split('\n').pop()!, TRUNC_RE);
});

test('compileFind : motif vide, drapeaux g/y, expression invalide → erreurs lisibles', () => {
  assert.throws(() => compileFind('  '), /motif vide/);
  assert.throws(() => compileFind('/a/g'), /drapeau .* non admis/);
  assert.throws(() => compileFind('/(/'), /expression régulière invalide/);
  assert.equal(compileFind('/A/i').test('xaz'), true);
  assert.equal(compileFind('/A/').test('xaz'), false);
  assert.equal(compileFind('élève').test('ELEVE inscrit'), true);
});

test('snapReadOptions : combinaisons sans effet refusées (400), jamais ignorées', () => {
  const q = (s: string) => snapReadOptions(new URLSearchParams(s));
  assert.deepEqual(q(''), {});
  assert.deepEqual(q('mode=outline'), { mode: 'outline' });
  assert.throws(() => q('mode=tout'), /mode de snap inconnu/);
  assert.throws(() => q('role=button'), /ne s'applique qu'avec find/);
  assert.throws(() => q('limit=3'), /ne s'applique qu'avec find/);
  assert.throws(() => q('find=a&mode=outline'), /exclusifs/);
  assert.throws(() => q('find=a&limit=0'), /entier positif/);
  assert.throws(() => q('find=a&limit=501'), /500 au plus/);
  assert.throws(() => q('find=/a/g'), (e: any) => e.status === 400);
  const r = q('find=a&role=button,%20link&limit=5');
  assert.deepEqual(r.find?.roles, ['button', 'link']);
  assert.equal(r.find?.limit, 5);
});

test('CLI / run : snap --outline|--interactive et find → mêmes requêtes ; options sans effet refusées', () => {
  const rq = (line: string) => { const a = parseArgs(line.split(' ')); checkRunFlags(a); return buildRequest(a); };
  assert.equal(rq('snap --outline').path, '/snap?mode=outline');
  assert.equal(rq('snap --interactive --scope main').path, '/snap?scope=main&mode=interactive');
  assert.throws(() => rq('snap --outline --interactive'), /exclusifs/);
  assert.throws(() => rq('text --outline'), ScriptError);
  const f = buildRequest(parseArgs(['find', 'Ajouter au panier', '--role', 'button', '--max', '5', '--scope', 'main']));
  assert.equal(f.path, '/snap?find=Ajouter+au+panier&role=button&limit=5&scope=main');
  assert.throws(() => rq('find'), /usage : grasp find/);
  assert.throws(() => buildRequest(parseArgs(['find', 'a', 'b'])), /un seul motif/);
  assert.throws(() => rq('find x --markdown'), /option --markdown inconnue pour find/);
});

test('find : la ligne « … élagué » reste (modale, iframes) — « aucune correspondance » n\'est pas « absent »', () => {
  // Iframe non parcourue : la cible est peut-être dedans.
  const withFrame = flatten(ax('RootWebArea', 'T', [ax('main', '', [ax('button', 'OK'), ax('Iframe', 'Paiement')])]));
  const t1 = buildSnapshot(withFrame, { url: 'u', title: 'T', find: { pattern: compileFind('Payer') } }).text;
  assert.match(t1, /find « Payer » : aucune correspondance/);
  assert.match(t1.split('\n').pop()!, /^… élagué : 1 iframe non parcourue$/, t1);
  // Fond retiré par une modale (showModal) : la cible est peut-être derrière.
  const ignoredBg = ax('main', '', [], { ignored: true, ignoredReasons: [{ name: 'activeModalDialog' }] } as Partial<AXNode>);
  const dlg = ax('dialog', 'Cookies', [ax('button', 'Accepter')], { properties: [{ name: 'modal', value: { value: true } }] });
  const withModal = flatten(ax('RootWebArea', 'T', [ignoredBg, dlg]));
  const t2 = buildSnapshot(withModal, { url: 'u', title: 'T', find: { pattern: compileFind('Valider') } }).text;
  assert.match(t2, /aucune correspondance/);
  assert.match(t2, /… élagué : reste de la page masqué par la fenêtre modale "Cookies"/, t2);
  // Avec des correspondances aussi, la ligne d'élagage est gardée et le budget reste respecté.
  const t3 = buildSnapshot(withModal, { url: 'u', title: 'T', find: { pattern: compileFind('accepter') } }).text;
  assert.match(t3, /:button "Accepter"/);
  assert.match(t3, /… élagué : reste de la page masqué par la fenêtre modale/);
});
