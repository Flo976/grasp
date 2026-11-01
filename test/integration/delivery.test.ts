import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openPage, type PageFixture } from '../helpers/chrome.js';
import { startTestSite, type TestSite } from '../helpers/testsite.js';
import { GraspError } from '../../src/core/errors.js';
import { CdpClient } from '../../src/browser/cdp.js';

/**
 * Livraison vérifiée des entrées. La non-livraison (écran Windows verrouillé : Chrome ne produit plus de
 * frames et le routage par hit-test abandonne les événements de CDP) est simulée pour de vrai par
 * Input.setIgnoreInputEvents depuis une AUTRE session CDP : Input.dispatch* répond OK et la page ne reçoit rien.
 */
let site: TestSite;
let fx: PageFixture;
let spyCdp: CdpClient;
let spy: string;
/** Session « espion » sur une connexion CDP à part : Grasp ne la voit pas (il détache celles de sa connexion). */
async function spyOn(f: PageFixture): Promise<{ cdp: CdpClient; sid: string }> {
  const cdp = await CdpClient.connect(f.chrome.wsUrl);
  const { targetInfos } = await cdp.send<{ targetInfos: Array<{ targetId: string; type: string }> }>('Target.getTargets');
  const targetId = targetInfos.find((t) => t.type === 'page')!.targetId;
  return { cdp, sid: (await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true })).sessionId };
}
before(async () => {
  site = await startTestSite();
  fx = await openPage();
  ({ cdp: spyCdp, sid: spy } = await spyOn(fx));
});
after(async () => { spyCdp.close(); await fx.close(); await site.close(); });
beforeEach(async () => { await ignoreInput(false); fx.page.testHooks = undefined; });

const ignoreInput = (ignore: boolean) => spyCdp.send('Input.setIgnoreInputEvents', { ignore }, spy);
const inPage = async <T>(expression: string): Promise<T> =>
  (await spyCdp.send<{ result: { value: T } }>('Runtime.evaluate', { expression, returnByValue: true }, spy)).result.value;
const events = () => inPage<string[]>('window.__ev.splice(0)');

test('simulation fidèle : avec setIgnoreInputEvents, Input.dispatchMouseEvent répond OK mais la page ne reçoit rien', async () => {
  await fx.page.navigate(`${site.url}/sonde`);
  await events();
  await ignoreInput(true);
  const r = await inPage<{ x: number; y: number }>('(() => { const b = document.getElementById("compter").getBoundingClientRect(); return { x: b.x + 5, y: b.y + 5 }; })()');
  await spyCdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 }, spy);
  await spyCdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 }, spy);
  assert.equal(await inPage('document.getElementById("compte").textContent'), 'Compte : 0');
  assert.deepEqual(await events(), []);
});

test('clic livré : OK sans note, événements de confiance, un seul clic', async () => {
  await fx.page.navigate(`${site.url}/sonde`);
  await events();
  const r = await fx.page.click('text:Compter');
  assert.equal(r.detail, undefined, `aucune note attendue : ${r.detail}`);
  assert.equal(await inPage('document.getElementById("compte").textContent'), 'Compte : 1');
  const ev = await events();
  assert.ok(ev.includes('click:true') && ev.includes('pointerdown:true'), ev.join(' '));
  assert.ok(!ev.some((e) => e.endsWith(':false')), `aucun événement synthétique : ${ev.join(' ')}`);
});

test('étage (a) : entrée perdue puis livrée après Page.bringToFront + focus émulé — un seul clic, annoncé', async () => {
  await fx.page.navigate(`${site.url}/sonde`);
  await events();
  await ignoreInput(true);
  const stages: string[] = [];
  fx.page.testHooks = { recovering: async (stage) => { stages.push(stage); if (stage === 'front') await ignoreInput(false); } };
  const r = await fx.page.click('text:Compter');
  assert.deepEqual(stages, ['front']);
  assert.match(r.detail ?? '', /2e essai.*bringToFront/);
  assert.doesNotMatch(r.detail ?? '', /synthétique/);
  assert.equal(await inPage('document.getElementById("compte").textContent'), 'Compte : 1', 'jamais de double clic');
  assert.ok((await events()).includes('click:true'));
});

test('étage (b) : entrée native jamais livrée → clic synthétique dans le monde isolé, annoncé explicitement', async () => {
  await fx.page.navigate(`${site.url}/sonde`);
  await events();
  await ignoreInput(true);
  const stages: string[] = [];
  fx.page.testHooks = { recovering: (stage) => { stages.push(stage); } };
  const r = await fx.page.click('text:Compter');
  assert.deepEqual(stages, ['front', 'synthetic']);
  assert.match(r.detail ?? '', /clic synthétique : l'entrée native n'a pas atteint la page/);
  assert.equal(await inPage('document.getElementById("compte").textContent'), 'Compte : 1');
  const ev = await events();
  assert.ok(ev.includes('click:false'), `clic synthétique (isTrusted=false) attendu : ${ev.join(' ')}`);
  assert.ok(!ev.some((e) => e.endsWith(':true')), ev.join(' '));
});

test('étage (b) autorisé même si allowEval=false (code fixe de Grasp, monde isolé)', async () => {
  assert.equal(fx.page.policy.allowEval, false, 'garde-fou : la politique de ce test interdit eval');
  await fx.page.navigate(`${site.url}/sonde`);
  await ignoreInput(true);
  const r = await fx.page.click('#compter');
  assert.match(r.detail ?? '', /clic synthétique/);
});

test('étage (c) : rien d\'observable, même en synthétique → ERREUR, jamais de faux OK', async () => {
  await fx.page.navigate(`${site.url}/sonde`);
  await ignoreInput(true);
  await assert.rejects(fx.page.click('text:Inerte'), (e: GraspError) => {
    assert.equal(e.status, 502);
    assert.match(e.message, /clic non livré/);
    assert.match(e.message, /aucun effet observable/);
    return true;
  });
});

test('--snap-diff « (aucun changement) » : tel quel après un clic livré, mais signalé après un clic non livré', async () => {
  await fx.page.navigate(`${site.url}/sonde`);
  await fx.page.click('text:Muet'); // le premier clic donne le focus (visible dans le diff)
  const ok = await fx.page.click('text:Muet', { snapDiff: true });
  assert.equal(ok.diff, '(aucun changement)');
  await ignoreInput(true);
  const ko = await fx.page.click('text:Muet', { snapDiff: true });
  assert.match(ko.diff ?? '', /^\(aucun changement — l'entrée native n'a pas atteint la page/);
  assert.equal(await inPage('document.getElementById("cache").textContent'), '3');
});

test('check : entrée perdue → coche synthétique annoncée, état vérifié', async () => {
  await fx.page.navigate(`${site.url}/sonde`);
  await ignoreInput(true);
  const r = await fx.page.check('text:Case sonde', true);
  assert.match(r.detail ?? '', /clic synthétique/);
  assert.equal(await inPage('document.getElementById("case").checked'), true);
});

test('press Enter : entrée perdue → touche synthétique, le formulaire est soumis (soumission implicite)', async () => {
  await fx.page.navigate(`${site.url}/sonde`);
  await ignoreInput(true);
  const r = await fx.page.press('Enter', '#q');
  assert.match(r.detail ?? '', /touche synthétique : l'entrée native n'a pas atteint la page/);
  assert.match((await fx.page.location()).url, /\/submit\?q=lemurien$/);
});

test('press livré : OK sans note', async () => {
  await fx.page.navigate(`${site.url}/sonde`);
  await events();
  const r = await fx.page.press('a', '#vider');
  assert.equal(r.detail, undefined, r.detail);
  assert.ok((await events()).includes('keydown:true'));
});

test('press : touche sans effet par défaut et sans gestionnaire, non livrée → ERREUR', async () => {
  await fx.page.navigate(`${site.url}/sonde`);
  await ignoreInput(true);
  await assert.rejects(fx.page.press('Escape', '#compter'), (e: GraspError) => e.status === 502 && /touche non livrée/.test(e.message));
});

test('fill "" (touche Suppr) : entrée perdue → saisie synthétique annoncée, valeur vérifiée', async () => {
  await fx.page.navigate(`${site.url}/sonde`);
  await ignoreInput(true);
  const r = await fx.page.fill('#vider', '');
  assert.match(r.detail ?? '', /saisie synthétique : l'entrée native n'a pas atteint la page/);
  assert.equal(await inPage('document.getElementById("vider").value'), '');
});

test('fill livré : aucune note', async () => {
  await fx.page.navigate(`${site.url}/sonde`);
  const r = await fx.page.fill('#vider', 'nouveau');
  assert.equal(r.detail, undefined, r.detail);
  assert.equal(await inPage('document.getElementById("vider").value'), 'nouveau');
});

test('délai de livraison configurable (limite inputDeliveryMs) : la non-livraison est détectée dans ce délai', async () => {
  const quick = await openPage(undefined, { inputDeliveryMs: 100 });
  try {
    const sp = await spyOn(quick);
    try {
      await quick.page.navigate(`${site.url}/sonde`);
      await sp.cdp.send('Input.setIgnoreInputEvents', { ignore: true }, sp.sid);
      const t0 = Date.now();
      await assert.rejects(quick.page.click('#inerte'), /clic non livré/);
      const ms = Date.now() - t0;
      assert.ok(ms < 1500, `3 délais de 100 ms + marges attendus, ${ms} ms`);
    } finally { sp.cdp.close(); }
  } finally { await quick.close(); }
});
