import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openPage, type PageFixture } from '../helpers/chrome.js';
import { startTestSite, type TestSite } from '../helpers/testsite.js';
import type { ConfigFile } from '../../src/core/config.js';

/**
 * Blocage des traqueurs, sans réseau externe : les hôtes de la page /traqueurs (doubleclick.net,
 * google-analytics.com, leurs sous-domaines, et le quasi-homonyme xdoubleclick.net) sont résolus vers
 * 127.0.0.1 par Chrome, tout autre hôte ne se résout pas. Une requête qui part arrive donc au site de test
 * (chemin /trk/…, réponse en 1,5 s) : le journal du serveur dit ce qui est parti.
 */
const RULES = '--host-resolver-rules=MAP doubleclick.net 127.0.0.1, MAP *.doubleclick.net 127.0.0.1, MAP xdoubleclick.net 127.0.0.1, MAP *.google-analytics.com 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1';

let site: TestSite;
before(async () => { site = await startTestSite(); });
after(async () => { await site.close(); });

async function withPage(config: ConfigFile, fn: (fx: PageFixture) => Promise<void>): Promise<void> {
  const fx = await openPage({ allowedDomains: ['127.0.0.1'], ...config }, undefined, {}, { chromeArgs: [RULES] });
  try { await fn(fx); } finally { await fx.close(); }
}

const trk = () => site.hits.filter((h) => h.startsWith('/trk/'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('blockTrackers par défaut : pixel, script, fetch et iframe vers des traqueurs ne partent pas ; compteur et console', async () => {
  await withPage({}, async (fx) => {
    site.hits.length = 0;
    const t0 = Date.now();
    const r = await fx.page.nav(`${site.url}/traqueurs`);
    const ms = Date.now() - t0;
    assert.equal(r.title, 'Traqueurs');
    assert.equal(r.trackersBlocked, 4, `script, pixel, fetch, iframe : ${JSON.stringify(r)}`);
    assert.equal(r.detail, undefined, `attente de stabilité sans réserve : ${r.detail}`);
    // Le quasi-homonyme hors liste part bien (le mappage fonctionne), ce qui rend l'absence des autres probante.
    for (let i = 0; i < 40 && !site.hits.includes('/presque/pixel.gif'); i++) await sleep(50);
    assert.ok(site.hits.includes('/presque/pixel.gif'), `xdoubleclick.net n'est pas dans la liste : ${site.hits.join(', ')}`);
    assert.deepEqual(trk(), [], 'aucune requête vers un traqueur ne doit partir');
    assert.ok(ms < 1500, `nav attendue sans les traqueurs (réponses en 1,5 s) : ${ms} ms`);

    const es = (await fx.page.consoleQuery({ limit: 1000 })).entries;
    const blocked = es.filter((e) => e.source === 'grasp' && /^traqueur bloqué : /.test(e.text));
    assert.ok(blocked.some((e) => /ad\.doubleclick\.net \(liste doubleclick\.net\)/.test(e.text)), JSON.stringify(blocked));
    assert.ok(blocked.some((e) => /www\.google-analytics\.com/.test(e.text)), JSON.stringify(blocked));
    assert.ok(blocked.every((e) => e.level === 'info' && e.blocked === true));
    assert.deepEqual(es.filter((e) => e.source === 'network' && /doubleclick|google-analytics/.test(e.text)), [], 'pas de doublon « erreur réseau » pour une requête bloquée');

    // Requête de mesure lancée par un clic : bloquée, elle n'est pas une « réaction » à attendre.
    const t1 = Date.now();
    const c = await fx.page.click('#mesure');
    const cms = Date.now() - t1;
    assert.equal(c.trackersBlocked, 1, JSON.stringify(c));
    // Sans réaction : délai de grâce (120 ms) seulement ; comptée comme réaction, ≥ 400 ms de calme (≈ 500 ms
    // mesurés en retirant le filtre des traqueurs de l'attente réseau, contre ≈ 140 ms avec).
    assert.ok(cms < 350, `clic attendu sans la requête bloquée : ${cms} ms`);
    await sleep(300);
    assert.deepEqual(trk(), []);
    assert.equal(fx.page.trackersBlocked, 5);
  });
});

test('blockTrackers=false : les mêmes requêtes partent (témoin du mappage local) et sont attendues', async () => {
  await withPage({ blockTrackers: false }, async (fx) => {
    site.hits.length = 0;
    const r = await fx.page.nav(`${site.url}/traqueurs`);
    assert.equal(r.trackersBlocked, undefined);
    for (let i = 0; i < 40 && trk().length < 3; i++) await sleep(50);
    const hits = trk();
    for (const p of ['/trk/analytics.js', '/trk/pixel.gif', '/trk/collect']) assert.ok(hits.includes(p), `${p} attendu : ${hits.join(', ')}`);
    // L'iframe vers ad.doubleclick.net reste bloquée par le garde de navigation (hors allowlist).
    assert.ok(!hits.includes('/trk/cadre'));
    const t1 = Date.now();
    await fx.page.click('#mesure');
    assert.ok(Date.now() - t1 >= 1000, 'sans blocage, la requête du clic est une réaction attendue');
    assert.ok(trk().includes('/trk/clic'));
  });
});

test('blockTrackers avec allowConsole=false : bloqué quand même (garde Fetch, sans domaine Network)', async () => {
  await withPage({ allowConsole: false }, async (fx) => {
    site.hits.length = 0;
    const r = await fx.page.nav(`${site.url}/traqueurs`);
    assert.equal(r.trackersBlocked, 4);
    for (let i = 0; i < 40 && !site.hits.includes('/presque/pixel.gif'); i++) await sleep(50);
    assert.ok(site.hits.includes('/presque/pixel.gif'));
    assert.deepEqual(trk(), []);
  });
});

test('navigation explicite vers un domaine de la liste : seule l\'allowlist arbitre, le document n\'est pas bloqué', async () => {
  // Le réseau simulé mène ad.doubleclick.net à 127.0.0.1 : la protection SSRF le refuserait (à juste titre),
  // elle est levée ici pour n'éprouver que le blocage des traqueurs.
  await withPage({ allowedDomains: ['127.0.0.1', '*.doubleclick.net'], allowPrivateNetwork: true }, async (fx) => {
    site.hits.length = 0;
    const port = new URL(site.url).port;
    const r = await fx.page.nav(`http://ad.doubleclick.net:${port}/trk/page`);
    assert.equal(r.url, `http://ad.doubleclick.net:${port}/trk/page`);
    assert.deepEqual(trk(), ['/trk/page']);
    assert.equal(r.trackersBlocked, undefined, JSON.stringify((await fx.page.consoleQuery({ limit: 100 })).entries));
  });
});
