import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openPage, type PageFixture } from '../helpers/chrome.js';
import { startTestSite, type TestSite } from '../helpers/testsite.js';
import { Tabs } from '../../src/bridge/tabs.js';
import type { PageController } from '../../src/bridge/page.js';
import { GraspError } from '../../src/core/errors.js';
import type { ConfigFile } from '../../src/core/config.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchChrome } from '../../src/browser/launch.js';
import { discoverChrome, realProbe } from '../../src/browser/discover.js';

/**
 * Onglets et popups, contre un vrai Chrome : target=_blank, simulateur OAuth (window.open + window.close),
 * popup hors allowlist, refs par onglet, plafond, tab new / tab close, onglet refermé hors de toute action.
 */
let site: TestSite;
before(async () => { site = await startTestSite(); });
after(async () => { await site.close(); });

interface Fx { fx: PageFixture; tabs: Tabs; page: PageController; close(): Promise<void> }

async function open(max = 10, config: ConfigFile = { allowedDomains: ['127.0.0.1'] }): Promise<Fx> {
  const fx = await openPage(config);
  const tabs = new Tabs(fx.cdp, fx.page, max);
  return { fx, tabs, page: tabs.facade(), close: () => fx.close() };
}

const pages = async (fx: PageFixture) => (await fx.cdp.send<{ targetInfos: Array<{ type: string; url: string }> }>('Target.getTargets')).targetInfos.filter((t) => t.type === 'page');

test('target=_blank : nouvel onglet annoncé, pilotable, gardé, avec sa propre console', async () => {
  const o = await open();
  try {
    await o.page.nav(`${site.url}/onglets`);
    const r = await o.page.click('text:Aide');
    assert.match(r.detail ?? '', /nouvel onglet t2 ouvert : http:\/\/127\.0\.0\.1:\d+\/onglets\/aide « Aide » — grasp tab t2 pour y basculer/);
    const list = await o.tabs.list();
    assert.deepEqual(list.map((t) => [t.id, t.active, t.opener]), [['t1', true, undefined], ['t2', false, 't1']]);
    assert.match(list[1]!.url, /\/onglets\/aide$/);
    // Sans bascule, l'onglet actif reste t1.
    assert.match(await o.page.text(), /Se connecter avec Fournisseur/);
    const sel = await o.tabs.select('t2');
    assert.equal(sel.active, true);
    assert.match(await o.page.snapText(), /heading\[1\] "Aide en ligne"/);
    // Garde de navigation de l'onglet t2 : pré-contrôle (403) ET page conservée.
    await assert.rejects(o.page.nav(`http://[::1]:${new URL(site.url).port}/`), (e: GraspError) => e.status === 403);
    assert.match((await o.page.location()).url, /\/onglets\/aide$/);
    // Console propre à l'onglet : celle de t2 n'a pas le message du fournisseur ni de t1.
    const c2 = await o.page.consoleQuery({});
    assert.ok(c2.entries.every((e) => !/fournisseur prêt/.test(e.text)), JSON.stringify(c2.entries));
    await o.tabs.select('t1');
    assert.match((await o.page.location()).url, /\/onglets$/);
  } finally { await o.close(); }
});

test('simulateur OAuth : window.open --follow, autorisation, window.close() → retour sur l\'ouvreur, résultat lu dans la page', async () => {
  const o = await open();
  try {
    await o.page.nav(`${site.url}/onglets`);
    const r = await o.page.click('#oauth', { follow: true });
    assert.match(r.detail ?? '', /nouvel onglet t2 ouvert : http:\/\/127\.0\.0\.1:\d+\/onglets\/autoriser « Fournisseur »/);
    assert.match(r.detail ?? '', /onglet actif : t2 \(--follow\)/);
    assert.match(await o.page.text(), /Autoriser l'application \?/);
    // La console du popup est la sienne (attachée AVANT son premier document).
    assert.ok((await o.page.consoleQuery({})).entries.some((e) => /fournisseur prêt/.test(e.text)));
    const a = await o.page.click('text:Autoriser');
    assert.equal(a.ok, true);
    assert.match(a.detail ?? '', /l'onglet t2 s'est fermé pendant l'action \(fermé par la page[^)]*\) — onglet actif : t1 « Application » http:\/\/127\.0\.0\.1:\d+\/onglets/);
    assert.equal(o.tabs.size, 1);
    // La preuve, c'est la page de l'ouvreur.
    assert.match(await o.page.text(), /Connecté : Ada/);
    // Rien de différé : la fermeture a été dite par l'action elle-même.
    assert.equal(await o.tabs.takeNotices(), undefined);
  } finally { await o.close(); }
});

test('popup hors allowlist : bloqué par le garde avant tout chargement, onglet fermé, raison dite', async () => {
  const o = await open();
  try {
    await o.page.nav(`${site.url}/onglets`);
    const hits = site.hits.length;
    const r = await o.page.click('#dehors');
    assert.match(r.detail ?? '', /popup bloqué par Grasp : .*\[::1\].* ; onglet t2 fermé/);
    assert.equal(o.tabs.size, 1);
    assert.deepEqual((await o.tabs.list()).map((t) => t.id), ['t1']);
    assert.ok((await pages(o.fx)).every((t) => !t.url.includes('[::1]')), 'aucun onglet ne doit avoir chargé [::1]');
    assert.deepEqual(site.hits.slice(hits), [], 'aucune requête ne doit avoir atteint le site');
    // L'onglet de départ est intact.
    assert.match((await o.page.location()).url, /\/onglets$/);
  } finally { await o.close(); }
});

test('refs par onglet : une ref d\'un autre onglet est refusée clairement, jamais cherchée par son hash', async () => {
  const o = await open();
  try {
    await o.page.nav(`${site.url}/onglets`);
    const ref = (await o.page.snapText()).split('\n').find((l) => /button "Se connecter avec Fournisseur"/.test(l))!.trim().split(':')[0]!;
    await o.page.click('text:Aide', { follow: true });
    await assert.rejects(o.page.click(ref), (e: GraspError) => e.status === 404 && new RegExp(`ref ${ref} vient de l'onglet t1, pas de l'onglet actif t2`).test(e.message));
    // Même page ouverte dans deux onglets : chaque onglet résout SES refs.
    await o.page.nav(`${site.url}/onglets`);
    const ref2 = (await o.page.snapText()).split('\n').find((l) => /button "Se connecter avec Fournisseur"/.test(l))!.trim().split(':')[0]!;
    assert.equal(ref2, ref, 'même rôle, même nom, même rang : même hash');
    const r = await o.page.click(ref, { follow: true });
    assert.match(r.detail ?? '', /nouvel onglet t3 ouvert/);
    assert.deepEqual((await o.tabs.list()).map((t) => [t.id, t.opener]), [['t1', undefined], ['t2', 't1'], ['t3', 't2']]);
  } finally { await o.close(); }
});

test('plafond maxTabs : popup au-delà fermé avant exécution, tab new refusé (409)', async () => {
  const o = await open(2);
  try {
    await o.page.nav(`${site.url}/onglets`);
    assert.match((await o.page.click('text:Aide')).detail ?? '', /nouvel onglet t2 ouvert/);
    const hits = site.hits.length;
    const r = await o.page.click('#oauth');
    assert.match(r.detail ?? '', /popup fermé sans rien charger : plafond de 2 onglets atteint \(maxTabs\)/);
    assert.equal(o.tabs.size, 2);
    assert.ok(!site.hits.slice(hits).includes('/onglets/autoriser'), 'le popup refusé n\'a rien chargé');
    await assert.rejects(o.tabs.open(), (e: GraspError) => e.status === 409 && /plafond de 2 onglets/.test(e.message));
  } finally { await o.close(); }
});

test('tab new / tab close : URL pré-contrôlée (rien de créé si refusée), dernier onglet jamais fermé, retour sur l\'ouvreur', async () => {
  const o = await open();
  try {
    await o.page.nav(`${site.url}/onglets`);
    const before = (await pages(o.fx)).length;
    await assert.rejects(o.tabs.open('https://example.com/'), (e: GraspError) => e.status === 403);
    assert.equal((await pages(o.fx)).length, before, 'URL refusée : aucun onglet créé');
    assert.equal(o.tabs.size, 1);
    const n = await o.tabs.open(`${site.url}/onglets/aide`);
    assert.deepEqual([n.id, n.active, n.title], ['t2', true, 'Aide']);
    assert.match(await o.page.text(), /Aide en ligne/);
    // Onglet vierge, puis navigation gardée comme ailleurs.
    const v = await o.tabs.open();
    assert.deepEqual([v.id, v.url], ['t3', 'about:blank']);
    await assert.rejects(o.page.nav('https://example.com/'), (e: GraspError) => e.status === 403);
    const c = await o.tabs.close();
    assert.equal(c.closed, 't3');
    assert.equal(c.active.id, 't2', 'retour sur le dernier onglet actif');
    await o.tabs.close('t2');
    await assert.rejects(o.tabs.close(), (e: GraspError) => e.status === 409 && /dernier onglet/.test(e.message));
    await assert.rejects(o.tabs.select('t2'), (e: GraspError) => e.status === 404 && /onglet t2 inconnu ou fermé/.test(e.message));
    await assert.rejects(o.tabs.select('x'), (e: GraspError) => e.status === 400);
    assert.match(await o.page.text(), /Se connecter avec Fournisseur/);
  } finally { await o.close(); }
});

test('popup refermé par la page hors de toute action : annoncé par la réponse suivante, onglet actif rendu à l\'ouvreur', async () => {
  const o = await open();
  try {
    await o.page.nav(`${site.url}/onglets`);
    const r = await o.page.click('#ephemere');
    assert.match(r.detail ?? '', /nouvel onglet t2 ouvert/);
    await o.tabs.select('t2');
    for (let i = 0; i < 200 && o.tabs.size > 1; i++) await new Promise((res) => setTimeout(res, 20));
    assert.equal(o.tabs.size, 1);
    assert.match(await o.tabs.takeNotices() ?? '', /^onglet t2 fermé par la page — onglet actif : t1 « Application » http:\/\/127\.0\.0\.1:\d+\/onglets$/);
    assert.equal(await o.tabs.takeNotices(), undefined, 'dite une seule fois');
    assert.match((await o.page.location()).url, /\/onglets$/);
  } finally { await o.close(); }
});

test('notes d\'onglet bornées et masquées : URL de 8 000 caractères avec « code », titre de 800 caractères', async () => {
  const o = await open();
  try {
    // Ouvreur à URL démesurée elle aussi : la note de retour (« onglet actif : t1 … ») la reprend.
    await o.page.nav(`${site.url}/onglets?code=SECRET123&q=${'y'.repeat(8000)}`);
    const r = await o.page.click('#long');
    const d = r.detail ?? '';
    assert.match(d, /nouvel onglet t2 ouvert : http:\/\/127\.0\.0\.1:\d+\/onglets\/long\?code=\*\*\*&q=z+… « (Titre )+/);
    assert.ok(!d.includes('SECRET123'), d.slice(0, 400));
    assert.ok(d.length < 600, `note de ${d.length} caractères`);
    const a = await o.page.click('#oauth', { follow: true });
    assert.ok((a.detail ?? '').length < 600);
    const b = await o.page.click('text:Autoriser');
    const back = b.detail ?? '';
    assert.match(back, /onglet actif : t1 « Application » http:\/\/127\.0\.0\.1:\d+\/onglets\?code=\*\*\*&q=y+…$/);
    assert.ok(!back.includes('SECRET123') && back.length < 600, back.slice(0, 400));
  } finally { await o.close(); }
});

test('mode attach (cdpUrl) : tab new ouvre un onglet pilotable, l\'onglet d\'état fonctionne, les onglets de l\'utilisateur restent ouverts', async () => {
  // Navigateur « de l'utilisateur » lancé à part, Grasp s'y branche comme en mode attach (GRASP_TEST_CDP_URL).
  const dir = mkdtempSync(join(tmpdir(), 'gr-tabs-att-'));
  const chrome = await launchChrome({ browser: discoverChrome(process.env, realProbe, process.env.HOME ?? '/'), userDataDir: dir, headless: true, network: { proxyServer: null, proxyBypassList: [], hostResolverRules: [] } });
  const prev = process.env.GRASP_TEST_CDP_URL;
  let o: Fx | undefined;
  try {
    process.env.GRASP_TEST_CDP_URL = chrome.wsUrl;
    try { o = await open(10, { allowedDomains: ['127.0.0.1'], allowCookies: true }); } finally {
      if (prev === undefined) delete process.env.GRASP_TEST_CDP_URL; else process.env.GRASP_TEST_CDP_URL = prev;
    }
    assert.equal(o.fx.page.attachedMode, true);
    await o.page.nav(`${site.url}/onglets`);
    const n = await o.tabs.open(`${site.url}/onglets/aide`);
    assert.deepEqual([n.id, n.active, n.title], ['t2', true, 'Aide']);
    assert.match(await o.page.text(), /Aide en ligne/);
    const v = await o.tabs.open();
    assert.deepEqual([v.id, v.url], ['t3', 'about:blank']);
    await assert.rejects(o.page.nav('https://example.com/'), (e: GraspError) => e.status === 403);
    assert.equal(o.tabs.size, 3);
    // Onglet d'état (export) : même mécanisme d'attachement explicite.
    const st = await o.page.exportState([]);
    assert.equal(st.state.format, 'grasp-state');
    await o.tabs.close('t3');
    await o.tabs.select('t1');
    assert.match(await o.page.text(), /Se connecter avec Fournisseur/);
  } finally {
    if (o !== undefined) await o.tabs.closeAll().catch(() => undefined);
    o?.fx.cdp.close();
    await chrome.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});
