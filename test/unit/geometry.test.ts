import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boxLabel, judgeHorizontalOverflow, judgeInViewport, judgeNotClipped, type ElementGeometry, type PageOverflow } from '../../src/bridge/geometry.js';
import { describeExpected, expectSpecOf, POLLED } from '../../src/core/expect.js';
import { buildRequest, checkRunFlags, parseArgs, splitLine } from '../../src/core/script.js';
import { buildSnapshot, type AXNode } from '../../src/bridge/snapshot.js';

/** Viewport 360x800 non défilé ; boîte en coordonnées du viewport. */
const geo = (box: ElementGeometry['box'], extra: Partial<ElementGeometry> = {}): ElementGeometry => ({ vw: 360, vh: 800, sx: 0, sy: 0, box, clips: [], ...extra });

test('in-viewport : largeur seule par défaut (plus bas dans la page : accepté), --fully : les deux axes sans défiler', () => {
  // Bouton correct.
  assert.deepEqual(judgeInViewport(geo({ l: 20, t: 280, r: 220, b: 320 }), false), { ok: true, observed: 'boîte x=20 y=280 200x40 ; viewport 360x800' });
  // Image de 400 px à x=20 : 60 px de trop à droite.
  const img = judgeInViewport(geo({ l: 20, t: 120, r: 420, b: 320 }), false);
  assert.equal(img.ok, false);
  assert.equal(img.observed, 'boîte x=20 y=120 400x200 ; viewport 360x800 : dépasse de 60 px à droite');
  // Élément 2000 px plus bas : dans la largeur, donc accepté ; --fully le refuse (en bas).
  const loin = geo({ l: 0, t: 2354, r: 300, b: 2404 });
  assert.equal(judgeInViewport(loin, false).ok, true);
  assert.equal(judgeInViewport(loin, true).observed, 'boîte x=0 y=2354 300x50 ; viewport 360x800 : dépasse de 1604 px en bas');
  // Page défilée de 2000 px : la boîte du document ne change pas, --fully l'accepte et dit le défilement en cas d'échec.
  assert.equal(judgeInViewport(geo({ l: 0, t: 354, r: 300, b: 404 }, { sy: 2000 }), true).ok, true);
  assert.match(judgeInViewport(geo({ l: -10, t: 354, r: 300, b: 404 }, { sy: 2000 }), true).observed, /^boîte x=-10 y=2354 310x50 ; viewport 360x800 défilé à 0,2000 : dépasse de 10 px à gauche$/);
  // Défilement horizontal de la page : la largeur est jugée dans le document, pas dans la vue courante.
  assert.equal(judgeInViewport(geo({ l: -300, t: 0, r: -100, b: 10 }, { sx: 320 }), false).ok, true);
  // Sous-pixel toléré (0,5 px).
  assert.equal(judgeInViewport(geo({ l: -0.4, t: 0, r: 360.4, b: 10 }), false).ok, true);
  // Non rendu.
  assert.match(judgeInViewport(geo(null), false).observed, /^aucune boîte : élément non rendu/);
});

test('not-clipped : ancêtre overflow hidden/clip sur l\'axe qu\'il rogne, bord du viewport, conteneur qui défile', () => {
  const carte = { who: 'div.carte', ox: 'hidden', oy: 'hidden', box: { l: 20, t: 120, r: 320, b: 270 } };
  // La carte est aussi le plus proche conteneur en overflow-x ≠ visible : seule la part qu'elle laisse voir
  // compte pour le viewport (elle tient) ; sans elle (xin absent), la boîte entière dépasserait aussi le viewport.
  const img = judgeNotClipped(geo({ l: 20, t: 120, r: 420, b: 320 }, { clips: [carte], xin: { l: 20, r: 320 } }));
  assert.equal(img.ok, false);
  assert.equal(img.observed, 'boîte x=20 y=120 400x200 ; rogné par div.carte (overflow hidden, zone x=20 y=120 300x150) : 100 px à droite, 50 px en bas');
  assert.equal(judgeNotClipped(geo({ l: 20, t: 120, r: 420, b: 320 }, { clips: [carte] })).observed, 'boîte x=20 y=120 400x200 ; rogné par div.carte (overflow hidden, zone x=20 y=120 300x150) : 100 px à droite, 50 px en bas ; dépasse la largeur du viewport (360 px) de 60 px à droite');
  // overflow-x seul : la hauteur qui dépasse n'est pas rognée.
  const xOnly = judgeNotClipped(geo({ l: 20, t: 120, r: 300, b: 320 }, { clips: [{ ...carte, oy: 'visible' }] }));
  assert.equal(xOnly.ok, true, xOnly.observed);
  const yOnly = judgeNotClipped(geo({ l: 20, t: 120, r: 300, b: 320 }, { clips: [{ ...carte, ox: 'visible', oy: 'clip' }] }));
  assert.match(yOnly.observed, /rogné par div\.carte \(overflow visible\/clip, zone x=20 y=120 300x150\) : 50 px en bas$/);
  // Bandeau trop large, sans ancêtre qui rogne.
  assert.equal(judgeNotClipped(geo({ l: 0, t: 0, r: 520, b: 40 })).observed, 'boîte x=0 y=0 520x40 ; dépasse la largeur du viewport (360 px) de 160 px à droite');
  // Tableau large dans un conteneur overflow-x:auto de 300 px : seule la part visible compte → rien ne dépasse.
  assert.equal(judgeNotClipped(geo({ l: 0, t: 330, r: 700, b: 354 }, { xin: { l: 0, r: 300 } })).ok, true);
  // Conteneur qui défile lui-même plus large que le viewport : la part visible dépasse encore.
  assert.match(judgeNotClipped(geo({ l: 0, t: 330, r: 700, b: 354 }, { xin: { l: 0, r: 400 } })).observed, /dépasse la largeur du viewport \(360 px\) de 40 px à droite$/);
  assert.equal(judgeNotClipped(geo({ l: 40, t: 130, r: 200, b: 200 }, { clips: [carte] })).ok, true, 'élément entièrement dans sa carte');
  assert.match(judgeNotClipped(geo(null)).observed, /^aucune boîte/);
});

test('no-horizontal-overflow : largeur défilable, éléments les plus externes cités, overflow-x hidden du viewport dit', () => {
  const base: PageOverflow = { vw: 360, vh: 800, sw: 360, rootOx: 'visible', culprits: [], count: 0, truncated: false };
  assert.deepEqual(judgeHorizontalOverflow(base), { ok: true, observed: '', items: [] });
  const r = judgeHorizontalOverflow({ ...base, sw: 520, culprits: [{ who: 'div#bandeau.bandeau.promo', l: 0, r: 520 }], count: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.observed, 'largeur du document 520 px > viewport 360 px (+160 px) ; 1 élément(s) dépassent : div#bandeau.bandeau.promo x=0 largeur 520 (+160 px)');
  assert.deepEqual(r.items, ['div#bandeau.bandeau.promo x=0 largeur 520 (+160 px)']);
  // body { overflow-x: hidden } : la page ne défile pas, mais le contenu est rogné — l'assertion échoue et le dit.
  const masked = judgeHorizontalOverflow({ ...base, rootOx: 'hidden', culprits: [{ who: 'div#bandeau', l: 0, r: 520 }], count: 1 });
  assert.equal(masked.ok, false);
  assert.match(masked.observed, /^largeur du document 360 px = viewport ; 1 élément\(s\) dépassent : div#bandeau .* ; viewport en overflow-x hidden : la page ne défile pas mais ce contenu est rogné$/);
  // Débordement sans élément identifiable ; liste bornée à 5 dans le message.
  assert.match(judgeHorizontalOverflow({ ...base, sw: 400 }).observed, /aucun élément identifié/);
  const many = Array.from({ length: 7 }, (_, i) => ({ who: `p.l${i}`, l: 0, r: 400 }));
  const m = judgeHorizontalOverflow({ ...base, sw: 400, culprits: many, count: 7, truncated: true });
  assert.match(m.observed, /p\.l4 x=0 largeur 400 \(\+40 px\) \| … et 2 autre\(s\) \(5000 premiers éléments examinés\)$/);
  assert.equal(m.items.length, 7);
});

test('expect in-viewport / not-clipped / no-horizontal-overflow : syntaxe, options, revalidation du bridge', () => {
  const r = (line: string) => { const a = parseArgs(splitLine(line)); checkRunFlags(a); return buildRequest(a); };
  assert.deepEqual(r("expect in-viewport '#photo'").body, { kind: 'in-viewport', target: '#photo' });
  assert.deepEqual(r('expect in-viewport text:Valider --fully --timeout 0').body, { kind: 'in-viewport', target: 'text:Valider', timeout: '0', fully: true });
  assert.deepEqual(r('expect not-clipped e5k2 --shot-on-error').body, { kind: 'not-clipped', target: 'e5k2', shotOnError: true });
  assert.deepEqual(r('expect no-horizontal-overflow --timeout 2000').body, { kind: 'no-horizontal-overflow', timeout: '2000' });
  assert.throws(() => r('expect in-viewport'), /usage : grasp expect in-viewport <sélecteur> \[--fully\]/);
  assert.throws(() => r('expect not-clipped a b'), /usage : grasp expect not-clipped <sélecteur>/);
  assert.throws(() => r('expect no-horizontal-overflow #x'), /usage : grasp expect no-horizontal-overflow/);
  assert.throws(() => r('expect not-clipped #x --fully'), /--fully ne s'applique pas à expect not-clipped/);
  assert.throws(() => r('expect in-viewport #x --scope main'), /--scope ne s'applique pas à expect in-viewport/);
  assert.throws(() => r('expect in-viewport #x --fully=oui'), /--fully ne prend pas de valeur/);
  // Le bridge ne fait confiance à rien.
  assert.throws(() => expectSpecOf({ kind: 'in-viewport' }), /sélecteur requis/);
  assert.throws(() => expectSpecOf({ kind: 'not-clipped', target: '#x', fully: true }), /« fully » ne s'applique qu'à expect in-viewport/);
  assert.throws(() => expectSpecOf({ kind: 'in-viewport', target: '#x', fully: 'oui' }), /booléen attendu/);
  assert.deepEqual(expectSpecOf({ kind: 'in-viewport', target: ' #x ', fully: true }), { kind: 'in-viewport', target: '#x', fully: true });
  // Relues jusqu'au délai (la mise en page bouge : images, polices).
  for (const k of ['in-viewport', 'not-clipped', 'no-horizontal-overflow'] as const) assert.ok(POLLED.has(k), k);
  assert.equal(describeExpected({ kind: 'in-viewport', target: '#x' }), 'élément #x dans la largeur du viewport');
  assert.equal(describeExpected({ kind: 'in-viewport', target: '#x', fully: true }), 'élément #x entièrement dans le viewport (sans défiler)');
  assert.equal(describeExpected({ kind: 'no-horizontal-overflow' }), 'aucun débordement horizontal de la page');
});

test('--boxes : snap et find seulement, sans valeur ; requête boxes=1', () => {
  const r = (line: string) => { const a = parseArgs(splitLine(line)); checkRunFlags(a); return buildRequest(a); };
  assert.equal(r('snap --interactive --boxes').path, '/snap?mode=interactive&boxes=1');
  assert.equal(r('find Valider --boxes').path, '/snap?find=Valider&boxes=1');
  assert.throws(() => r('text --boxes'), /option --boxes inconnue pour text/);
  assert.throws(() => buildRequest(parseArgs(splitLine('text --boxes'))), /--boxes ne s'applique qu'à snap et find/);
  assert.throws(() => buildRequest(parseArgs(splitLine('snap --boxes=1'))), /--boxes ne prend pas de valeur/);
  assert.equal(boxLabel([19.6, 280.2, 200, 40.4]), '@20,280 200x40');
  assert.equal(boxLabel(null), '@aucune-boîte');
  // Élément fixe : coordonnées du viewport, signalées.
  assert.equal(boxLabel([310, 0, 50, 20, 1]), '@310,0 50x20 fixe');
});

test('snapshot --boxes : suffixe par ligne à ref, ligne d\'explication, budget respecté, refs et diff inchangés', () => {
  let seq = 0;
  const node = (role: string, name: string, parentId?: string): AXNode => ({ nodeId: String(++seq), role: { value: role }, name: { value: name }, childIds: [], backendDOMNodeId: 100 + seq, ...(parentId !== undefined ? { parentId } : {}) });
  const root = node('RootWebArea', 'T');
  const kids = [node('heading', 'Fiche', '1'), node('button', 'Valider', '1'), node('link', 'Aide', '1')];
  root.childIds = kids.map((k) => k.nodeId);
  const tree = [root, ...kids];
  const plain = buildSnapshot(tree, { url: 'u', title: 'T' });
  // Lignes rendues : leurs nœuds sont ceux à mesurer.
  assert.deepEqual(plain.shownIds, kids.map((k) => k.backendDOMNodeId));
  const of = new Map([[kids[1]!.backendDOMNodeId!, '@20,280 200x40']]);
  const s = buildSnapshot(tree, { url: 'u', title: 'T', boxes: { of, note: 'boîtes : note' } });
  const lines = s.text.split('\n');
  assert.equal(lines[1], 'boîtes : note');
  assert.match(s.text, /^e[0-9a-z]+:button "Valider" @20,280 200x40$/m);
  assert.match(s.text, /^e[0-9a-z]+:link "Aide" @aucune-boîte$/m);
  assert.deepEqual([...s.refs], [...plain.refs]);
  assert.deepEqual([...s.entries], [...plain.entries], 'le diff ne voit pas les boîtes');
  // find : la boîte suit la ligne trouvée.
  const f = buildSnapshot(tree, { url: 'u', title: 'T', find: { pattern: { label: '« Valider »', test: (x) => x.includes('Valider') } }, boxes: { of, note: 'n' } });
  assert.match(f.text, /^e[0-9a-z]+:button "Valider" @20,280 200x40$/m);
  // Budget : lignes allongées, toujours dans maxBytes.
  const many = Array.from({ length: 300 }, (_, i) => node('link', `Produit ${i}`, '1'));
  const r2 = { ...root, childIds: many.map((k) => k.nodeId) };
  const big = buildSnapshot([r2, ...many], { url: 'u', title: 'T', maxBytes: 2000, boxes: { of: new Map(many.map((k) => [k.backendDOMNodeId!, '@0,0 360x20'])), note: 'n' } });
  assert.ok(Buffer.byteLength(big.text) <= 2000, `taille ${Buffer.byteLength(big.text)}`);
  assert.match(big.text, /omis/);
});

test('élément fixe : jugé dans le viewport quel que soit le défilement horizontal ; viewport de mise en page élargi dit', () => {
  // En-tête fixe à 100 % (345 px, barre de défilement exclue), page défilée de 340 px : il ne dépasse pas.
  const hdr = geo({ l: 0, t: 0, r: 345, b: 40 }, { vw: 345, sx: 340, fixed: true, iw: 360 });
  assert.deepEqual(judgeInViewport(hdr, false), { ok: true, observed: 'boîte fixe x=0 y=0 345x40 ; viewport 345x800' });
  assert.deepEqual(judgeNotClipped(hdr), { ok: true, observed: 'boîte fixe x=0 y=0 345x40' });
  // Le même, non fixe, serait décalé de 340 px dans le document : il dépasse.
  assert.equal(judgeInViewport({ ...hdr, fixed: false }, false).ok, false);
  // Un élément fixe trop large dépasse toujours, sans l'indice (innerWidth ≈ largeur visible : simple barre de défilement).
  assert.equal(judgeNotClipped(geo({ l: 0, t: 0, r: 500, b: 10 }, { vw: 345, fixed: true, iw: 360 })).observed, 'boîte fixe x=0 y=0 500x10 ; dépasse la largeur du viewport (345 px) de 155 px à droite');
  // --mobile, page qui déborde : viewport de mise en page élargi à 520 px, l'en-tête à 100 % s'élargit avec.
  const large = geo({ l: 0, t: 0, r: 520, b: 40 }, { fixed: true, iw: 520 });
  const hint = ' (élément fixe : la page déborde et Chrome a élargi le viewport de mise en page à 520 px — cause à chercher avec expect no-horizontal-overflow)';
  assert.equal(judgeInViewport(large, false).observed, `boîte fixe x=0 y=0 520x40 ; viewport 360x800 : dépasse de 160 px à droite${hint}`);
  assert.equal(judgeNotClipped(large).observed, `boîte fixe x=0 y=0 520x40 ; dépasse la largeur du viewport (360 px) de 160 px à droite${hint}`);
  // Non fixe : pas d'indice.
  assert.doesNotMatch(judgeInViewport({ ...large, fixed: false }, false).observed, /élargi/);
});

test('no-horizontal-overflow : descendant plus large que l\'élément cité', () => {
  const r = judgeHorizontalOverflow({ vw: 360, vh: 800, sw: 700, rootOx: 'visible', culprits: [{ who: 'div#large', l: 0, r: 600, rr: 700 }], count: 1, truncated: false });
  assert.equal(r.observed, 'largeur du document 700 px > viewport 360 px (+340 px) ; 1 élément(s) dépassent : div#large x=0 largeur 600, contenu jusqu\'à x=700 (+340 px)');
  // rr pas plus loin que l'élément : rien de plus.
  assert.equal(judgeHorizontalOverflow({ vw: 360, vh: 800, sw: 600, rootOx: 'visible', culprits: [{ who: 'div#large', l: 0, r: 600, rr: 560 }], count: 1, truncated: false }).items[0], 'div#large x=0 largeur 600 (+240 px)');
});
