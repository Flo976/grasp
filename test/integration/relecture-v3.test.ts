import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openPage, type PageFixture } from '../helpers/chrome.js';
import { startTestSite, type TestSite } from '../helpers/testsite.js';
import { discoverChrome, realProbe } from '../../src/browser/discover.js';
import { launchChrome } from '../../src/browser/launch.js';
import { CdpClient } from '../../src/browser/cdp.js';
import { PageController } from '../../src/bridge/page.js';
import { effectivePolicy } from '../../src/core/policy.js';
import { resolveConfig } from '../../src/core/config.js';

/**
 * Relecture du lot « attente réseau+DOM, challenge, diff SPA, snapshot v3 » : iframes hors processus,
 * faux challenges, long-polling, polling de fond, onglet caché en mode attach, refs sous text-transform,
 * boutons sans nom à compteur, noms répétés légitimes, select à option choisie lointaine.
 */

let site: TestSite;
let fx: PageFixture;
before(async () => {
  site = await startTestSite();
  // localhost : autre site que 127.0.0.1 → iframe hors processus (OOPIF).
  fx = await openPage({ allowedDomains: ['127.0.0.1', 'localhost'], allowEval: true });
});
after(async () => { await fx.close(); await site.close(); });

/** Accès aux membres privés du contrôleur (simulation d'échecs, espions). */
type Priv = Record<string, any>;
const priv = (p: PageController) => p as unknown as Priv;
const timed = async <T>(fn: () => Promise<T>): Promise<{ r: T; ms: number }> => { const t0 = Date.now(); const r = await fn(); return { r, ms: Date.now() - t0 }; };
const lines = (text: string) => text.split('\n').map((l) => l.trim());
const refOf = (text: string, re: RegExp): string => {
  const l = lines(text).find((x) => re.test(x));
  assert.ok(l, `aucune ligne ${re} dans :\n${text}`);
  return l.split(':')[0]!;
};

// ---------- CRITIQUE 1 : requête orpheline d'une iframe hors processus ----------

test('nav vers une page à iframe d\'une autre origine (OOPIF) : pas d\'attente fantôme de la requête du cadre', async () => {
  await fx.page.navigate(`${site.url}/challenge-ok`);
  const { r, ms } = await timed(() => fx.page.nav(`${site.url}/pw-cadres`));
  assert.equal(r.title, 'Cadres Playwright');
  assert.ok(ms < 1500, `nav /pw-cadres en ${ms} ms`);
  assert.equal(r.detail, undefined, r.detail);
});

// ---------- ÉLEVÉ 2 : faux positifs du détecteur de challenge ----------

test('page de connexion courte avec reCAPTCHA et « Veuillez patienter » : nav rapide, aucune note challenge', async () => {
  const { r, ms } = await timed(() => fx.page.nav(`${site.url}/connexion-captcha`));
  assert.equal(r.title, 'Connexion');
  assert.ok(ms < 1500, `nav en ${ms} ms`);
  assert.doesNotMatch(r.detail ?? '', /challenge/, r.detail);
});

// ---------- ÉLEVÉ 3 : long-polling ouvert au chargement ----------

test('long-polling (10 s) ouvert au chargement : nav < 2 s', async () => {
  const { r, ms } = await timed(() => fx.page.nav(`${site.url}/long-poll`));
  assert.equal(r.title, 'Long-polling');
  assert.ok(ms < 2000, `nav en ${ms} ms`);
});

// ---------- ÉLEVÉ 4 : polling de fond ----------

test('polling de fond (fetch toutes les 300 ms) : click < 1,5 s et wait --idle réussit', async () => {
  await fx.page.nav(`${site.url}/polling`);
  await new Promise((res) => setTimeout(res, 700));
  const { r, ms } = await timed(() => fx.page.click('#b'));
  assert.ok(ms < 1500, `click en ${ms} ms (${r.detail ?? ''})`);
  assert.doesNotMatch(r.detail ?? '', /réseau encore actif/, r.detail);
  const w = await fx.page.wait({ idle: true });
  assert.equal(w.condition, 'idle');
  const d = await timed(() => fx.page.click('#b', { snapDiff: true }));
  assert.ok(d.ms < 1500, `click --snap-diff en ${d.ms} ms`);
});

// ---------- MOYEN 5 : onglet caché ----------

test('mode attach (Chrome de l\'utilisateur) : onglet caché jamais ramené au premier plan, et c\'est dit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gr-attach-'));
  const chrome = await launchChrome({ browser: discoverChrome(process.env, realProbe, process.env.HOME ?? '/'), userDataDir: dir, headless: true });
  const cdp = await CdpClient.connect(chrome.wsUrl);
  try {
    const page = await PageController.attach(cdp, effectivePolicy(resolveConfig({ allowedDomains: ['127.0.0.1'], allowEval: true })), { downloadDir: join(dir, 'dl'), newTab: true });
    await page.navigate(`${site.url}/arriere-plan`);
    await cdp.send('Target.createTarget', { url: 'about:blank' });
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(await page.evaluate('document.visibilityState'), 'hidden', 'précondition : onglet en arrière-plan');
    const r = await page.click('#raf');
    assert.doesNotMatch(r.detail ?? '', /ramené/, r.detail);
    assert.match(r.detail ?? '', /arrière-plan/, r.detail);
    assert.equal(await page.evaluate('document.visibilityState'), 'hidden', "l'onglet de l'utilisateur n'est pas ramené au premier plan");
    await page.closeEngine();
  } finally { cdp.close(); await chrome.kill(); rmSync(dir, { recursive: true, force: true }); }
});

test('onglet qui reste caché après Page.bringToFront : note distincte, une seule tentative (et une seule attente) par document', async () => {
  const f = await openPage({ allowedDomains: ['127.0.0.1'], allowEval: true });
  try {
    await f.page.navigate(`${site.url}/arriere-plan`);
    await f.cdp.send('Target.createTarget', { url: 'about:blank' });
    await new Promise((r) => setTimeout(r, 500));
    // Fenêtre réduite / écran verrouillé : bringToFront sans effet.
    const p = priv(f.page);
    const orig = p.s.bind(f.page);
    let fronts = 0;
    let waits = 0;
    p.s = (m: string, params?: { expression?: string }) => {
      if (m === 'Page.bringToFront') { fronts++; return Promise.resolve({}); }
      if (m === 'Runtime.evaluate' && String(params?.expression ?? '').includes('visibilitychange')) waits++;
      return orig(m, params);
    };
    const a = await f.page.click('#raf');
    assert.doesNotMatch(a.detail ?? '', /ramené/, a.detail);
    assert.match(a.detail ?? '', /toujours caché/, a.detail);
    const b = await f.page.click('#raf');
    assert.match(b.detail ?? '', /toujours caché/, b.detail);
    assert.equal(waits, 1, "une seule attente d'1 s (visibilitychange) par document");
    assert.equal(fronts, 1, 'une seule tentative par document');
  } finally { await f.close(); }
});

// ---------- MOYEN 6 : refs stables sous text-transform ----------

test('text-transform : refs identiques même si le relevé du texte source échoue ; text: accepte les deux formes', async () => {
  await fx.page.navigate(`${site.url}/snap-v3`);
  const s1 = (await fx.page.snapshot()).text;
  const h1 = refOf(s1, /heading\[2\] "Mes compétences"$/);
  const b1 = refOf(s1, /button "Enregistrer le profil"$/);
  const p = priv(fx.page);
  const orig = p.sourceTexts;
  p.sourceTexts = async () => new Map<number, string>();
  try {
    const s2 = (await fx.page.snapshot()).text;
    assert.equal(refOf(s2, /heading\[2\] "MES COMPÉTENCES"$/), h1, s2);
    assert.equal(refOf(s2, /button "ENREGISTRER LE PROFIL"$/), b1, s2);
  } finally { p.sourceTexts = orig; }
  await fx.page.click('text:ENREGISTRER LE PROFIL');
  await fx.page.click('text:Enregistrer le profil');
});

test('snapshot sans nom transformable : aucun relevé de texte source', async () => {
  await fx.page.navigate(`${site.url}/challenge-ok`);
  const p = priv(fx.page);
  const orig = p.s.bind(fx.page);
  const exprs: string[] = [];
  p.s = (m: string, params?: { expression?: string }) => { if (m === 'Runtime.evaluate') exprs.push(String(params?.expression ?? '')); return orig(m, params); };
  try { await fx.page.snapshot(); } finally { p.s = orig; }
  assert.equal(exprs.filter((e) => e.includes('textTransform')).length, 0, 'relevé text-transform lancé pour rien');
});

// ---------- MOYEN 8 : bouton sans nom près d'un compteur ----------

test('bouton sans nom près d\'un compteur : sa ref ne change pas quand le compteur change', async () => {
  await fx.page.navigate(`${site.url}/snap-v3`);
  await fx.page.evaluate(`document.getElementById('tags').insertAdjacentHTML('beforeend', '<li class="chip"><span id="cpt">Messages (3)</span><button type="button"><svg width="10" height="10" aria-hidden="true"><path d="M0 0L10 10"/></svg></button></li>')`);
  const s1 = (await fx.page.snapshot()).text;
  const r1 = refOf(s1, /button \(sans nom, près de "Messages \(3\)"\)$/);
  await fx.page.evaluate(`document.getElementById('cpt').textContent = 'Messages (4)'`);
  const s2 = (await fx.page.snapshot()).text;
  assert.equal(refOf(s2, /button \(sans nom, près de "Messages \(4\)"\)$/), r1, s2);
});

// ---------- FAIBLE ----------

test('ref masquée par une modale : diagnostic exécuté dans le monde isolé (la page ne peut pas le fausser)', async () => {
  await fx.page.navigate(`${site.url}/modale`);
  const s = (await fx.page.snapshot()).text;
  const supprimer = refOf(s, /button "Supprimer"/);
  await fx.page.click('#ouvrir-aria');
  await fx.page.evaluate('Node.prototype.contains = function () { return true; }');
  await assert.rejects(fx.page.click(supprimer), /masqué.* par une fenêtre modale/);
});

test('relevé DOM des erreurs en échec : repli sur l\'arbre d\'accessibilité, les [invalide] ne sont pas effacés', async () => {
  await fx.page.navigate(`${site.url}/radios`);
  await fx.page.click('#envoyer');
  const p = priv(fx.page);
  const orig = p.s.bind(fx.page);
  p.s = (m: string, params?: { expression?: string }) => {
    if (m === 'Runtime.evaluate' && String(params?.expression ?? '').includes('aria-errormessage')) return Promise.reject(new Error('contexte détruit'));
    return orig(m, params);
  };
  let s: string;
  try { s = (await fx.page.snapshot()).text; } finally { p.s = orig; }
  assert.match(s, /radio "Jour".*\[invalide/, s);
});

test('nom propre répété (« Bora Bora ») : pas dédupliqué, text: le résout ; « Heures Heures » (deux labels) l\'est toujours', async () => {
  await fx.page.navigate(`${site.url}/snap-v3`);
  await fx.page.evaluate(`document.body.insertAdjacentHTML('beforeend', '<label for="bb">Bora Bora</label> <input id="bb">')`);
  const s = (await fx.page.snapshot()).text;
  assert.match(s, /textbox "Bora Bora"$/m, s);
  assert.match(s, /spinbutton "Heures"="35"$/m, s);
  await fx.page.fill('text:Bora Bora', 'île');
  assert.equal(await fx.page.evaluate("document.getElementById('bb').value"), 'île');
});

test('select fermé : l\'option choisie au-delà de la 20e apparaît, marquée [x]', async () => {
  await fx.page.navigate(`${site.url}/snap-v3`);
  await fx.page.evaluate(`document.getElementById('pays').selectedIndex = 23`);
  const s = (await fx.page.snapshot()).text;
  const all = s.split('\n');
  const i = all.findIndex((l) => /combobox "Pays"="Pays 23"/.test(l));
  assert.ok(i >= 0, s);
  assert.match(all[i + 1]!, /"Pays 23" \[x\]/, all[i + 1]);
  assert.match(all[i + 1]!, /… \+4$/, all[i + 1]);
});
