import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openPage, type PageFixture } from '../helpers/chrome.js';
import { startTestSite, type TestSite } from '../helpers/testsite.js';
import { decodePng, countColor } from '../helpers/png.js';
import { GraspError } from '../../src/core/errors.js';

let site: TestSite;
let fx: PageFixture;
before(async () => { site = await startTestSite(); fx = await openPage(); });
after(async () => { await fx.close(); await site.close(); });

const BLUE: [number, number, number] = [0, 0, 255];
const RED: [number, number, number] = [255, 0, 0];
const GREEN: [number, number, number] = [0, 160, 0];
const near = (c: [number, number, number], rgb: [number, number, number], tol = 30) => c.every((v, i) => Math.abs(v - rgb[i]!) <= tol);

test('capture du viewport (défaut) : PNG aux dimensions du viewport, dimensions rapportées = dimensions réelles', async () => {
  await fx.page.navigate(`${site.url}/capture`);
  const s = await fx.page.capture({});
  assert.equal(s.format, 'png');
  const px = decodePng(s.data);
  assert.deepEqual([s.width, s.height], [px.width, px.height]);
  assert.ok(px.height < 3100, `viewport attendu, pas la page entière (${px.height})`);
  assert.ok(near(px.at(5, 5), BLUE), `haut de page bleu, reçu ${px.at(5, 5)}`);
});

test('--full : page entière (3100 px), haut bleu, cible rouge à sa place, pied vert', async () => {
  await fx.page.navigate(`${site.url}/capture`);
  const metrics = async () => (await fx.cdp.send<{ cssVisualViewport: { clientWidth: number; pageY: number } }>('Page.getLayoutMetrics', {}, (fx.page as unknown as { sessionId: string }).sessionId)).cssVisualViewport;
  const layoutWidth = (await metrics()).clientWidth;
  const vp = await fx.page.capture({});
  const s = await fx.page.capture({ full: true });
  const px = decodePng(s.data);
  assert.equal(px.height, 3100, `hauteur ${px.height}`);
  // largeur du contenu : celle du viewport moins la barre de défilement éventuelle
  assert.ok(px.width <= vp.width && px.width >= vp.width - 20, `largeur ${px.width} (viewport ${vp.width})`);
  assert.ok(near(px.at(5, 5), BLUE));
  assert.ok(near(px.at(150, 1550), RED), `cible attendue en (150,1550), reçu ${px.at(150, 1550)}`);
  assert.ok(near(px.at(5, 3050), GREEN), `pied attendu, reçu ${px.at(5, 3050)}`);
  // La capture ne doit pas avoir laissé la page défilée ou redimensionnée.
  const after = decodePng((await fx.page.capture({})).data);
  assert.deepEqual([after.width, after.height], [vp.width, vp.height]);
  // Ni changé sa mise en page : captureBeyondViewport supprime la barre de défilement jusqu'au
  // rechargement (reflow) ; Grasp ne doit pas laisser cet effet de bord. Défilement conservé.
  await fx.page.capture({ el: '#pied' });
  const m0 = await metrics();
  assert.ok(m0.pageY > 1000, `défilement attendu, pageY=${m0.pageY}`);
  await fx.page.capture({ full: true });
  const m1 = await metrics();
  assert.equal(m1.clientWidth, layoutWidth, 'largeur de mise en page modifiée par la capture (barre de défilement perdue ?)');
  assert.equal(m1.pageY, m0.pageY, 'position de défilement perdue');
});

test('--el : découpe exacte sur la boîte de l\'élément, même hors écran (scrollIntoView), par CSS, ref ou text:', async () => {
  await fx.page.navigate(`${site.url}/capture`);
  const s = await fx.page.capture({ el: '#cible' });
  const px = decodePng(s.data);
  assert.deepEqual([px.width, px.height], [200, 100]);
  for (const [x, y] of [[2, 2], [197, 2], [2, 97], [197, 97], [100, 50]] as const) assert.ok(near(px.at(x, y), RED), `(${x},${y}) = ${px.at(x, y)}`);
  const snap = await fx.page.snapshot();
  const ref = [...snap.meta].find(([, m]) => m.name === 'Cible')?.[0];
  assert.ok(ref, snap.text);
  assert.deepEqual([(await fx.page.capture({ el: ref })).width, (await fx.page.capture({ el: ref })).height], [200, 100]);
  const btn = await fx.page.capture({ el: 'text:Premier' });
  assert.ok(btn.width > 20 && btn.width < 300 && btn.height < 100, `bouton ${btn.width}×${btn.height}`);
  await assert.rejects(fx.page.capture({ el: '#absent' }), (e: GraspError) => e.status === 404);
});

test('--max-width : réduit l\'échelle (moins de tokens image), proportions conservées, aussi sur la zone défilée', async () => {
  await fx.page.navigate(`${site.url}/capture`);
  const vp = await fx.page.capture({});
  const native = await fx.page.capture({ full: true });
  const full = await fx.page.capture({ full: true, maxWidth: 200 });
  assert.ok(full.width <= 200 && full.width >= 195, `largeur ${full.width}`);
  const expectedH = Math.round(3100 * full.width / native.width);
  assert.ok(Math.abs(full.height - expectedH) <= 2, `hauteur ${full.height}, attendu ≈ ${expectedH}`);
  // viewport réduit après défilement jusqu'à la cible : la cible rouge doit y être
  await fx.page.capture({ el: '#cible' });
  const small = await fx.page.capture({ maxWidth: 300 });
  const px = decodePng(small.data);
  assert.ok(px.width <= 300, `largeur ${px.width}`);
  assert.ok(countColor(px, RED) > 100, 'la capture réduite doit montrer la zone défilée (la cible)');
  const bigger = await fx.page.capture({ maxWidth: 100_000 });
  assert.equal(bigger.width, vp.width, 'jamais agrandie');
});

test('--format jpeg|webp et --quality ; options invalides → 400', async () => {
  await fx.page.navigate(`${site.url}/capture`);
  const j = await fx.page.capture({ format: 'jpeg', quality: 50 });
  assert.equal(j.format, 'jpeg');
  assert.deepEqual([...j.data.subarray(0, 3)], [0xff, 0xd8, 0xff]);
  const w = await fx.page.capture({ format: 'webp', quality: 60 });
  assert.equal(w.data.subarray(8, 12).toString(), 'WEBP');
  assert.ok(w.width > 0 && w.height > 0);
  for (const bad of [{ format: 'gif' }, { format: 'png', quality: 50 }, { format: 'jpeg', quality: 0 }, { format: 'jpeg', quality: 101 }, { maxWidth: 0 }, { full: true, el: '#cible' }] as const) {
    await assert.rejects(fx.page.capture(bad as never), (e: GraspError) => e.status === 400, JSON.stringify(bad));
  }
});

test('--refs : refs dessinées sur les éléments interactifs visibles, retirées après, autorisé avec allowEval=false', async () => {
  assert.equal(fx.page.policy.allowEval, false, 'garde-fou : la politique de ce test interdit eval');
  await fx.page.navigate(`${site.url}/capture`);
  const snapBefore = (await fx.page.snapshot()).text;
  const textBefore = await fx.page.text();
  const plain = decodePng((await fx.page.capture({})).data);
  const withRefs = decodePng((await fx.page.capture({ refs: true })).data);
  const MAGENTA: [number, number, number] = [255, 0, 170];
  assert.equal(countColor(plain, MAGENTA), 0);
  assert.ok(countColor(withRefs, MAGENTA) > 50, 'aucune ref dessinée');
  // La page n'est pas altérée : même arbre, même texte, et la capture suivante est identique à l'originale.
  assert.equal((await fx.page.snapshot()).text, snapBefore);
  assert.equal(await fx.page.text(), textBefore);
  assert.equal(countColor(decodePng((await fx.page.capture({})).data), MAGENTA), 0, 'overlay non retiré');
  // page entière avec refs : fonctionne aussi
  assert.ok(countColor(decodePng((await fx.page.capture({ full: true, refs: true })).data), MAGENTA) > 50);
});

test('--full sur une page plus large que le viewport : toute la largeur est rendue (pas de moitié blanche)', async () => {
  await fx.page.navigate(`${site.url}/large`);
  const vp = await fx.page.capture({});
  const s = await fx.page.capture({ full: true });
  const px = decodePng(s.data);
  assert.equal(px.width, 3000, `largeur ${px.width}`);
  assert.equal(s.truncated, undefined);
  for (const x of [100, 1400]) assert.ok(near(px.at(x, 100), RED), `x=${x} : ${px.at(x, 100)}`);
  for (const x of [1600, 2000, 2900]) assert.ok(near(px.at(x, 100), GREEN), `x=${x} attendu vert, reçu ${px.at(x, 100)}`);
  const after = decodePng((await fx.page.capture({})).data);
  assert.deepEqual([after.width, after.height], [vp.width, vp.height], 'viewport restauré');
});

test('--el sur un élément plus haut que le viewport, loin dans le document : capturé en entier (pas 1 px)', async () => {
  await fx.page.navigate(`${site.url}/haute`);
  const vp = await fx.page.capture({});
  const s = await fx.page.capture({ el: '#grand' });
  const px = decodePng(s.data);
  assert.equal(px.height, 3000, `hauteur ${px.height}`);
  assert.equal(s.truncated, undefined, 'non tronqué : 3000 px tiennent dans la limite de texture');
  for (const y of [2, 1500, 2997]) assert.ok(near(px.at(5, y), RED), `y=${y} : ${px.at(5, y)}`);
  // Plus haut que la limite de texture : tronqué À PARTIR DU HAUT DE L'ÉLÉMENT, et signalé.
  const big = await fx.page.capture({ el: '#enorme' });
  const bp = decodePng(big.data);
  assert.equal(big.truncated, true);
  assert.equal(bp.height, 16_384, `hauteur ${bp.height}`);
  assert.ok(near(bp.at(5, 50), [255, 255, 0]), `haut de #enorme jaune, reçu ${bp.at(5, 50)}`);
  assert.ok(near(bp.at(5, 16_000), BLUE), `bas bleu, reçu ${bp.at(5, 16_000)}`);
  const after = decodePng((await fx.page.capture({})).data);
  assert.deepEqual([after.width, after.height], [vp.width, vp.height], 'viewport restauré');
});
