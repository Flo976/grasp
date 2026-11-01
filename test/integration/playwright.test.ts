import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openPage, type PageFixture } from '../helpers/chrome.js';
import { needPlaywright } from '../helpers/playwright.js';
import { startTestSite, type TestSite } from '../helpers/testsite.js';
import { isAlive } from '../helpers/procs.js';
import { GraspError } from '../../src/core/errors.js';
import { CdpClient } from '../../src/browser/cdp.js';

/**
 * Moteur Playwright de repli, contre le vrai Chrome de Grasp et le site de test. Ignoré si playwright-core
 * n'est pas installé (devDependency) — sauf les tests du chemin « absent », qui n'en ont pas besoin.
 */
const needPw = needPlaywright;
const POLICY = { allowedDomains: ['127.0.0.1', 'localhost'] };

let site: TestSite;
let fx: PageFixture;
let spyCdp: CdpClient;
let spy: string;
/** Session « espion » sur une connexion CDP à part (voir delivery.test.ts) : simule la perte des entrées natives. */
async function spyOn(f: PageFixture): Promise<{ cdp: CdpClient; sid: string }> {
  const cdp = await CdpClient.connect(f.chrome.wsUrl);
  const { targetInfos } = await cdp.send<{ targetInfos: Array<{ targetId: string; type: string }> }>('Target.getTargets');
  const targetId = targetInfos.find((t) => t.type === 'page')!.targetId;
  return { cdp, sid: (await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true })).sessionId };
}
before(async () => {
  site = await startTestSite();
  fx = await openPage(POLICY);
  ({ cdp: spyCdp, sid: spy } = await spyOn(fx));
});
after(async () => { spyCdp.close(); await fx.close(); await site.close(); });
beforeEach(async () => { fx.page.testHooks = undefined; });

const inPage = async <T>(c: { cdp: CdpClient; sid: string }, expression: string): Promise<T> =>
  (await c.cdp.send<{ result: { value: T } }>('Runtime.evaluate', { expression, returnByValue: true }, c.sid)).result.value;
const me = () => ({ cdp: spyCdp, sid: spy });
const pw = { engine: 'playwright' } as const;

test('click --engine playwright : clic de confiance livré par Playwright, aucune note de repli', { skip: needPw }, async () => {
  await fx.page.navigate(`${site.url}/sonde`);
  await inPage(me(), 'window.__ev.splice(0)');
  const r = await fx.page.click('text:Compter', pw);
  assert.doesNotMatch(r.detail ?? '', /synthétique|rejoué/);
  assert.equal(await inPage(me(), 'document.getElementById("compte").textContent'), 'Compte : 1');
  const ev = await inPage<string[]>(me(), 'window.__ev.splice(0)');
  assert.ok(ev.includes('click:true') && !ev.some((e) => e.endsWith(':false')), ev.join(' '));
  // Ref issue d'un snap : traduite en élément par Grasp (backendNodeId), puis cliquée par Playwright.
  const ref = (await fx.page.snapshot()).text.split('\n').find((l) => /button "Compter"/.test(l))!.trim().split(':')[0]!;
  await fx.page.click(ref, pw);
  assert.equal(await inPage(me(), 'document.getElementById("compte").textContent'), 'Compte : 2');
  assert.equal(await inPage(me(), 'document.querySelectorAll("[data-grasp-pw]").length'), 0, 'marqueur temporaire retiré');
});

test('fill, select, check, press, type --delay, hover via Playwright dans le document principal', { skip: needPw }, async () => {
  await fx.page.navigate(`${site.url}/`);
  await fx.page.fill('#nom', 'Ada', pw);
  const sel = await fx.page.select('text:Pays', 'Madagascar', pw);
  assert.match(sel.detail ?? '', /sélectionné : mg/);
  await fx.page.check("text:J'accepte les conditions", true, pw);
  assert.equal(await inPage(me(), 'document.getElementById("cgu").checked'), true);
  await fx.page.check('#cgu', false, pw);
  assert.equal(await inPage(me(), 'document.getElementById("cgu").checked'), false);
  await fx.page.navigate(`${site.url}/pw-cadres`);
  const t0 = Date.now();
  await fx.page.type('#ville', 'Tana', { ...pw, delay: 60 });
  assert.ok(Date.now() - t0 >= 180, 'délai entre les touches respecté');
  assert.equal(await inPage(me(), 'document.getElementById("ville").value'), 'Tana');
  await fx.page.press('Backspace', '#ville', pw);
  assert.equal(await inPage(me(), 'document.getElementById("ville").value'), 'Tan');
  await fx.page.hover('#survol', pw);
  assert.equal(await inPage(me(), 'document.getElementById("survol").textContent'), 'Survolé');
  await assert.rejects(fx.page.fill('#nom-absent', 'x', { ...pw, engine: 'puppeteer' as 'playwright' }), (e: GraspError) => e.status === 400 && /moteur inconnu/.test(e.message));
});

test('hover et type natifs (sans Playwright) : mêmes commandes, livraison vérifiée', async () => {
  await fx.page.navigate(`${site.url}/pw-cadres`);
  const r = await fx.page.type('#ville', 'Fianarantsoa');
  assert.equal(r.detail, undefined, r.detail);
  assert.equal(await inPage(me(), 'document.getElementById("ville").value'), 'Fianarantsoa');
  await fx.page.hover('#survol');
  assert.equal(await inPage(me(), 'document.getElementById("survol").textContent'), 'Survolé');
  await assert.rejects(fx.page.type('#ville', 'x', { delay: 5000 }), (e: GraspError) => e.status === 400 && /delay/.test(e.message));
});

test('iframe d\'une autre origine (hors processus) : lire et agir dans le cadre avec frame=…', { skip: needPw }, async () => {
  await fx.page.navigate(`${site.url}/pw-cadres`);
  // Sans Playwright, le contenu du cadre n'est pas lisible : l'erreur indique maintenant frame=.
  await assert.rejects(fx.page.text(undefined, '#editeur'), (e: GraspError) => e.status === 409 && /frame=#editeur/.test(e.message));
  assert.match(await fx.page.text(undefined, 'frame=#editeur'), /Texte initial[\s\S]*Rien/);
  const snap = await fx.page.snapText({ scope: 'frame=#editeur' });
  assert.match(snap, /^cadre frame=#editeur /);
  assert.match(snap, /button "Appliquer"/);
  assert.match(snap, /checkbox "Gras"/);
  await fx.page.fill('frame=#editeur >> #titre', 'Lémurien');
  await fx.page.click('frame=#editeur >> text:Appliquer');
  assert.equal(await fx.page.text(undefined, 'frame=#editeur >> #etat'), 'Appliqué : Lémurien');
  const s = await fx.page.select('frame=#editeur >> #taille', 'Grand');
  assert.match(s.detail ?? '', /sélectionné : g/);
  await fx.page.check('frame=#editeur >> text:Gras', true);
  assert.match(await fx.page.snapText({ scope: 'frame=#editeur >> #gras' }), /checkbox "Gras" \[checked\]/);
  // Éditeur riche (contenteditable, comme le corps de TinyMCE).
  await fx.page.fill('frame=#editeur >> #zone', 'Nouveau texte');
  assert.equal(await fx.page.text(undefined, 'frame=#editeur >> #zone'), 'Nouveau texte');
  await fx.page.press('End', 'frame=#editeur >> #zone');
  await fx.page.type('frame=#editeur >> #zone', ' ajouté');
  assert.equal((await fx.page.text(undefined, 'frame=#editeur >> #zone')).replace(/\u00a0/g, ' '), 'Nouveau texte ajouté');
  const w = await fx.page.wait({ sel: 'frame=#editeur >> #etat' });
  assert.equal(w.condition, 'sel');
  // Une ref ne désigne que le document principal ; frame= exige le moteur Playwright.
  await assert.rejects(fx.page.click('frame=#editeur >> e1a2'), (e: GraspError) => e.status === 400 && /refs ne désignent/.test(e.message));
  await assert.rejects(fx.page.click('frame=#editeur >> #appliquer', { engine: 'native' }), (e: GraspError) => e.status === 400 && /frame= exige le moteur Playwright/.test(e.message));
  await assert.rejects(fx.page.click('frame=#editeur'), (e: GraspError) => e.status === 400 && /précisez l'élément/.test(e.message));
  await assert.rejects(fx.page.text(undefined, 'frame=#editeur >> #absent'), (e: GraspError) => e.status === 504 && /moteur Playwright : text/.test(e.message));
});

test('garde de navigation : un clic Playwright qui sort de l\'allowlist est bloqué par le garde Fetch de Grasp', { skip: needPw }, async () => {
  await fx.page.navigate(`${site.url}/pw-cadres`);
  const r = await fx.page.click('#sortir', pw);
  assert.match(r.detail ?? '', /navigation bloquée : domaine hors allowlist : \[::1\]/);
  assert.match((await fx.page.location()).url, /\/pw-cadres$/);
  assert.match(fx.page.lastBlocked()?.url ?? '', /^http:\/\/\[::1\]:/);
});

test('clic Playwright vérifié par la sonde : le 1er clic après défilement (page à iframe hors processus) est perdu par Chrome → rejoué, un seul clic', { skip: needPw }, async () => {
  const f = await openPage(POLICY);
  try {
    await f.page.navigate(`${site.url}/pw-cadres`);
    // Bouton sous la ligne de flottaison : Playwright défile puis clique aussitôt.
    const r = await f.page.click('#bas', pw);
    assert.equal(await f.page.text(undefined, '#compte'), 'Compte : 1', `exactement un clic (note : ${r.detail})`);
    // Constaté sur Chrome 150 headless : ce 1er clic n'atteint pas la page ; Playwright répond pourtant OK.
    if (!/livré au 2e essai/.test(r.detail ?? '')) process.stderr.write(`# (perte du 1er clic Playwright non reproduite cette fois : ${r.detail})\n`);
  } finally { await f.close(); }
});

test('upload via Playwright : 403 sans allowUpload (avant toute connexion), fichier posé dans le cadre avec', { skip: needPw }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gr-up-'));
  const file = join(dir, 'piece.txt');
  writeFileSync(file, 'pièce jointe');
  try {
    await fx.page.navigate(`${site.url}/pw-cadres`);
    await assert.rejects(fx.page.upload('frame=#editeur >> #piece', [file], pw), (e: GraspError) => e.status === 403 && /upload est désactivé/.test(e.message));
    const up = await openPage({ ...POLICY, allowUpload: true });
    try {
      await up.page.navigate(`${site.url}/pw-cadres`);
      await up.page.upload('frame=#editeur >> #piece', [file]);
      assert.equal(await up.page.text(undefined, 'frame=#editeur >> #fichier'), 'Fichier : piece.txt');
    } finally { await up.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('repli automatique (fallbackEngine=playwright) : clic natif non livré → rejoué via Playwright, annoncé, un seul clic', { skip: needPw }, async () => {
  const f = await openPage({ ...POLICY, fallbackEngine: 'playwright' });
  const sp = await spyOn(f);
  try {
    await f.page.navigate(`${site.url}/sonde`);
    await inPage(sp, 'window.__ev.splice(0)');
    await sp.cdp.send('Input.setIgnoreInputEvents', { ignore: true }, sp.sid);
    const stages: string[] = [];
    // L'entrée native reste perdue (1er essai et étage a) ; elle redevient livrable au moment du rejeu Playwright.
    f.page.testHooks = { recovering: async (stage) => { stages.push(stage); if (stage === 'playwright') await sp.cdp.send('Input.setIgnoreInputEvents', { ignore: false }, sp.sid); } };
    const r = await f.page.click('text:Compter');
    assert.deepEqual(stages, ['front', 'playwright']);
    assert.match(r.detail ?? '', /rejoué via Playwright : l'entrée native n'a pas atteint la page/);
    assert.doesNotMatch(r.detail ?? '', /synthétique/);
    assert.equal(await inPage(sp, 'document.getElementById("compte").textContent'), 'Compte : 1', 'jamais de double clic');
    const ev = await inPage<string[]>(sp, 'window.__ev.splice(0)');
    assert.ok(ev.includes('click:true') && !ev.some((e) => e.endsWith(':false')), ev.join(' '));
  } finally { sp.cdp.close(); await f.close(); }
});

test('repli automatique : Playwright n\'aide pas (entrée toujours perdue) → étage synthétique, les deux annoncés', { skip: needPw }, async () => {
  const f = await openPage({ ...POLICY, fallbackEngine: 'playwright' });
  const sp = await spyOn(f);
  try {
    await f.page.navigate(`${site.url}/sonde`);
    await sp.cdp.send('Input.setIgnoreInputEvents', { ignore: true }, sp.sid);
    const stages: string[] = [];
    f.page.testHooks = { recovering: (stage) => { stages.push(stage); } };
    const r = await f.page.click('text:Compter');
    assert.deepEqual(stages, ['front', 'playwright', 'synthetic']);
    assert.match(r.detail ?? '', /repli Playwright sans effet/);
    assert.match(r.detail ?? '', /clic synthétique/);
    assert.equal(await inPage(sp, 'document.getElementById("compte").textContent'), 'Compte : 1');
  } finally { sp.cdp.close(); await f.close(); }
});

test('repli automatique : élément pas encore visible (409 natif) → Playwright attend son actionnabilité et clique', { skip: needPw }, async () => {
  await fx.page.navigate(`${site.url}/pw-cadres`);
  await fx.page.click('#reveler');
  await assert.rejects(fx.page.click('#tardif'), (e: GraspError) => e.status === 409 && /zone cliquable/.test(e.message), 'sans repli : 409 immédiat');
  const f = await openPage({ ...POLICY, fallbackEngine: 'playwright' });
  try {
    await f.page.navigate(`${site.url}/pw-cadres`);
    await f.page.click('#reveler');
    const r = await f.page.click('#tardif');
    assert.match(r.detail ?? '', /rejoué via Playwright : l'élément n'a pas de zone cliquable/);
    assert.equal(await f.page.text(undefined, '#compte'), 'Compte : 1');
  } finally { await f.close(); }
});

test('playwright-core absent : --engine playwright → 501 « npm i playwright-core » ; repli configuré → note, puis synthétique', async () => {
  const f = await openPage({ ...POLICY, fallbackEngine: 'playwright' }, undefined, { module: 'grasp-module-qui-nexiste-pas' });
  const sp = await spyOn(f);
  try {
    await f.page.navigate(`${site.url}/sonde`);
    await assert.rejects(f.page.click('text:Compter', pw), (e: GraspError) => e.status === 501 && /npm i playwright-core/.test(e.message));
    await assert.rejects(f.page.text(undefined, 'frame=#x'), (e: GraspError) => e.status === 501);
    const ok = await f.page.click('text:Compter');
    assert.equal(ok.detail, undefined, 'clic livré : le moteur natif ne dépend pas de Playwright');
    await sp.cdp.send('Input.setIgnoreInputEvents', { ignore: true }, sp.sid);
    const r = await f.page.click('text:Compter');
    assert.match(r.detail ?? '', /repli Playwright impossible : moteur Playwright indisponible.*npm i playwright-core/);
    assert.match(r.detail ?? '', /clic synthétique/);
  } finally { sp.cdp.close(); await f.close(); }
});

test('cycle de vie : la déconnexion de Playwright ne ferme ni le navigateur ni l\'onglet ; reconnexion à la demande', { skip: needPw }, async () => {
  await fx.page.navigate(`${site.url}/sonde`);
  await fx.page.click('#compter', pw);
  assert.equal(fx.page.playwrightConnected, true);
  await fx.page.closeEngine();
  assert.equal(fx.page.playwrightConnected, false);
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(isAlive(fx.chrome.pid), 'Chrome vivant');
  const { targetInfos } = await fx.cdp.send<{ targetInfos: Array<{ type: string }> }>('Target.getTargets');
  assert.equal(targetInfos.filter((t) => t.type === 'page').length, 1, 'onglet de la session toujours ouvert');
  assert.match((await fx.page.location()).url, /\/sonde$/, 'connexion CDP de Grasp intacte');
  const r = await fx.page.click('#compter', pw);
  assert.match(r.detail ?? '', /moteur Playwright connecté en \d+ ms/);
  assert.equal(await inPage(me(), 'document.getElementById("compte").textContent'), 'Compte : 2');
});

test('cycle de vie : connexion fermée après inactivité', { skip: needPw }, async () => {
  const f = await openPage(POLICY, undefined, { idleMs: 300 });
  try {
    await f.page.navigate(`${site.url}/sonde`);
    await f.page.click('#compter', pw);
    assert.equal(f.page.playwrightConnected, true);
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(f.page.playwrightConnected, false);
    assert.ok(isAlive(f.chrome.pid));
  } finally { await f.close(); }
});

test('téléchargements : brancher Playwright ne détourne pas le dossier de Grasp (noDefaults)', { skip: needPw }, async () => {
  const f = await openPage({ ...POLICY, allowDownload: true });
  try {
    await f.page.navigate(`${site.url}/pw-cadres`);
    await f.page.hover('#survol', pw); // connexion Playwright établie
    assert.equal(f.page.playwrightConnected, true);
    await f.page.click('#dl', pw);
    const file = join(f.downloadDir, 'grasp-dl.txt');
    let got = false;
    for (let i = 0; i < 40 && !got; i++) { await new Promise((r) => setTimeout(r, 250)); got = existsSync(file); }
    assert.ok(got, `${file} absent : Playwright a redirigé les téléchargements`);
    assert.equal(readFileSync(file, 'utf8'), 'contenu grasp');
  } finally { await f.close(); }
});
