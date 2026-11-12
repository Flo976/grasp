import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openPage, type PageFixture } from '../helpers/chrome.js';
import { startTestSite, type TestSite } from '../helpers/testsite.js';
import { decodePng, countColor } from '../helpers/png.js';
import { viewportSpecOf } from '../../src/core/viewport.js';
import { needPlaywright } from '../helpers/playwright.js';

let site: TestSite;
let fx: PageFixture;
before(async () => { site = await startTestSite(); fx = await openPage(); });
after(async () => { await fx.close(); await site.close(); });

const BLUE: [number, number, number] = [0, 0, 255];
const near = (c: [number, number, number], rgb: [number, number, number], tol = 30) => c.every((v, i) => Math.abs(v - rgb[i]!) <= tol);
const text = () => fx.page.text(100_000);
const vp = (body: Record<string, unknown>) => fx.page.setViewport(viewportSpecOf(body));

test('viewport 360x800 : la media query bascule la page en mise en page mobile, vu par text, snap et la capture ; reset la rétablit', async () => {
  await fx.page.navigate(`${site.url}/viewport`);
  const t0 = await text();
  assert.match(t0, /Mise en page bureau/);
  assert.doesNotMatch(t0, /Mise en page mobile/);
  const natif = decodePng((await fx.page.capture({})).data);
  assert.ok(natif.width > 480, `viewport natif attendu plus large que 480 px (${natif.width})`);

  const r = await vp({ size: '360x800' });
  assert.deepEqual(r.viewport, { width: 360, height: 800, dpr: 0, mobile: false, touch: false, mobileUa: false });
  assert.equal(r.measured?.width, 360, 'innerWidth mesuré dans la page');
  assert.equal(r.measured?.height, 800);
  const t1 = await text();
  assert.match(t1, /Mise en page mobile/);
  assert.doesNotMatch(t1, /Mise en page bureau/);
  assert.match(t1, /Largeur 360/, 'événement resize reçu par la page');
  assert.doesNotMatch(t1, /Écran tactile/, 'sans --touch, pas de pointer: coarse');
  const snap = await fx.page.snapText({});
  assert.match(snap, /button "Ouvrir le menu"/);
  assert.doesNotMatch(snap, /Menu bureau/);
  const shot = decodePng((await fx.page.capture({})).data);
  assert.deepEqual([shot.width, shot.height], [360, 800 * shot.width / 360]);

  // Les overrides d'Emulation survivent aux navigations de l'onglet.
  await fx.page.navigate(`${site.url}/capture`);
  await fx.page.navigate(`${site.url}/viewport`);
  assert.match(await text(), /Mise en page mobile/);

  const back = await fx.page.setViewport(null);
  assert.equal(back.viewport, null);
  assert.equal(back.measured?.width, natif.width);
  const t2 = await text();
  assert.match(t2, /Mise en page bureau/);
  assert.match(t2, new RegExp(`Largeur ${natif.width}`));
  assert.equal(decodePng((await fx.page.capture({})).data).width, natif.width);
});

test('appareil (galaxy-s8 : 360x740, mobile, tactile ; dpr surchargé à 2) : densité, tactile et pointer: coarse mesurés ; clic livré ; captures --full et --el au viewport émulé', async () => {
  await fx.page.navigate(`${site.url}/viewport`);
  const r = await vp({ device: 'galaxy-s8', dpr: 2 });
  assert.equal(r.viewport?.device, 'galaxy-s8');
  assert.deepEqual(r.measured && { w: r.measured.width, h: r.measured.height, dpr: r.measured.dpr, tp: r.measured.touchPoints, p: r.measured.pointer }, { w: 360, h: 740, dpr: 2, tp: 5, p: 'coarse' });
  const t = await text();
  assert.match(t, /Mise en page mobile/);
  assert.match(t, /Écran tactile/);
  assert.match(t, /UA serveur : bureau/, 'le user agent ne change pas sans --mobile-ua');

  // Livraison vérifiée inchangée sous émulation tactile : le clic natif atteint la page.
  const c = await fx.page.click('text:Ouvrir le menu');
  assert.equal(c.detail, undefined, `aucun repli attendu : ${c.detail}`);
  assert.match(await text(), /Menu ouvert/);

  // Viewport : 360x740 CSS → 720x1480 pixels à dpr 2.
  const shot = decodePng((await fx.page.capture({})).data);
  assert.deepEqual([shot.width, shot.height], [720, 1480]);
  // --full : agrandit temporairement le viewport, à la même densité et en mode mobile, puis REVIENT au viewport émulé.
  const full = await fx.page.capture({ full: true });
  const fp = decodePng(full.data);
  assert.equal(fp.width, 720, `pleine page à la largeur émulée (${fp.width})`);
  assert.ok(fp.height > 4000, `pleine page : bloc de 2000 px CSS × 2 (${fp.height})`);
  assert.ok(near(fp.at(10, fp.height - 20), BLUE), `bas de page bleu, reçu ${fp.at(10, fp.height - 20)}`);
  const after = await fx.page.viewportInfo();
  assert.deepEqual([after.measured?.width, after.measured?.height, after.measured?.dpr, after.measured?.touchPoints], [360, 740, 2, 5], 'viewport émulé rétabli après la capture pleine page');
  assert.match(await text(), /Mise en page mobile/);
  const el = decodePng((await fx.page.capture({ el: '#bloc' })).data);
  assert.deepEqual([el.width, el.height], [720, 4000]);
  assert.ok(countColor(el, BLUE) > 0.95 * el.width * el.height, 'découpe du bloc bleu');
  assert.equal((await fx.page.viewportInfo()).measured?.width, 360);
  await fx.page.setViewport(null);
});

test('--mobile-ua : user agent Android pour les requêtes suivantes (vu par le serveur), annoncé ; reset le retire', async () => {
  await fx.page.navigate(`${site.url}/viewport`);
  const r = await vp({ size: '390x844', mobile: true, touch: true, mobileUa: true });
  assert.match(String(r.detail), /user agent mobile/);
  assert.equal(r.measured?.mobileUa, true);
  await fx.page.navigate(`${site.url}/viewport`);
  assert.match(await text(), /UA serveur : mobile/);
  const back = await fx.page.setViewport(null);
  assert.equal(back.measured?.mobileUa, false);
  await fx.page.navigate(`${site.url}/viewport`);
  const t = await text();
  assert.match(t, /UA serveur : bureau/);
  assert.match(t, /Mise en page bureau/);
});

test('limité à l\'onglet de la session : un autre onglet du même navigateur garde sa taille (mode attach : onglets de l\'utilisateur)', async () => {
  const { targetId } = await fx.cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await fx.cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
  const width = async () => (await fx.cdp.send<{ result: { value: number } }>('Runtime.evaluate', { expression: 'innerWidth', returnByValue: true }, sessionId)).result.value;
  try {
    const w0 = await width();
    await vp({ size: '360x800' });
    assert.equal((await fx.page.viewportInfo()).measured?.width, 360);
    assert.equal(await width(), w0, 'l\'autre onglet n\'est pas émulé');
  } finally {
    await fx.page.setViewport(null);
    await fx.cdp.send('Target.closeTarget', { targetId });
  }
});

test('moteur Playwright : un clic --engine playwright ne défait pas le viewport émulé', { skip: needPlaywright }, async () => {
  await fx.page.navigate(`${site.url}/viewport`);
  await vp({ size: '360x800', touch: true });
  try {
    await fx.page.click('text:Ouvrir le menu', { engine: 'playwright' });
    assert.match(await text(), /Menu ouvert/);
    const m = (await fx.page.viewportInfo()).measured;
    assert.deepEqual([m?.width, m?.height, m?.touchPoints], [360, 800, 5]);
    assert.match(await text(), /Mise en page mobile/);
  } finally { await fx.page.setViewport(null); }
});

test('viewport invalide : 400 sans rien changer', async () => {
  await fx.page.navigate(`${site.url}/viewport`);
  for (const bad of [{ size: '10x10' }, { size: 'abc' }, { device: 'nokia-3310' }, { size: '360x800', dpr: 9 }, { size: '360x800', zoom: 2 }, {}]) {
    assert.throws(() => viewportSpecOf(bad), (e: Error & { status?: number }) => e.status === 400, JSON.stringify(bad));
  }
  assert.equal((await fx.page.viewportInfo()).viewport, null);
  assert.match(await text(), /Mise en page bureau/);
});

test('reset d\'un viewport de la taille de l\'écran réel : pas d\'attente de 2 s (retour attendu sur l\'écran natif)', async () => {
  await fx.page.navigate(`${site.url}/viewport`);
  const ecran = await (fx.page as unknown as { evalIsolated<T>(e: string): Promise<T> }).evalIsolated<number[]>('[screen.width, screen.height]');
  const [w, h] = ecran as [number, number];
  await vp({ size: `${w}x${h}` });
  const t0 = Date.now();
  const back = await fx.page.setViewport(null);
  const dt = Date.now() - t0;
  assert.equal(back.viewport, null);
  assert.ok(dt < 1500, `reset en ${dt} ms (écran ${w}x${h}) : la boucle d'attente ne doit pas courir jusqu'à son plafond de 2 s`);
  assert.match(await text(), /Mise en page bureau/);
});
