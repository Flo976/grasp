import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openPage, type PageFixture } from '../helpers/chrome.js';
import { startTestSite, type TestSite } from '../helpers/testsite.js';
import { GraspError } from '../../src/core/errors.js';

/**
 * Protection SSRF avec un vrai Chrome. Le réseau est simulé de bout en bout, sans site externe :
 * Chrome envoie tout `*.test` sur 127.0.0.1 (--host-resolver-rules), et le résolveur du garde (injecté) dit
 * ce que « le DNS » répond. `interne.test` résout en privé pour les deux ; `rebond.test` résout en public pour
 * Grasp mais Chrome se connecte à 127.0.0.1 : c'est un DNS rebinding.
 */
const CHROME_ARGS = ['--host-resolver-rules=MAP *.test 127.0.0.1'];
const DNS: Record<string, string[]> = { 'interne.test': ['10.0.0.5'], 'rebond.test': ['93.184.216.34'] };
const resolve = async (h: string) => {
  const r = DNS[h];
  if (r === undefined) throw Object.assign(new Error('introuvable'), { code: 'ENOTFOUND' });
  return r;
};
const ALLOW = ['127.0.0.1', '*.test', '*.localhost'];

let site: TestSite;
let port: string;
let fx: PageFixture;
before(async () => {
  site = await startTestSite();
  port = new URL(site.url).port;
  fx = await openPage({ allowedDomains: ALLOW }, undefined, {}, { chromeArgs: CHROME_ARGS, resolve });
});
after(async () => { await fx.close(); await site.close(); });

const hits = () => site.hits.filter((h) => h === '/cible-ssrf').length;

test('pré-contrôle : un nom de l\'allowlist qui résout en privé → 403, aucune requête partie, page conservée', async () => {
  await fx.page.navigate(`${site.url}/`);
  const n = hits();
  await assert.rejects(fx.page.navigate(`http://interne.test:${port}/cible-ssrf`), (e: GraspError) => e.status === 403 && /10\.0\.0\.5/.test(e.message) && /SSRF/.test(e.message));
  assert.equal(hits(), n, 'le service interne ne doit pas avoir été contacté');
  const { url, title } = await fx.page.location();
  assert.equal(url, `${site.url}/`);
  assert.equal(title, 'Inscription');
});

test('garde runtime : une redirection vers un nom qui résout en privé est annulée dans le navigateur', async () => {
  await fx.page.navigate(`${site.url}/`);
  const n = hits();
  const target = encodeURIComponent(`http://interne.test:${port}/cible-ssrf`);
  await assert.rejects(fx.page.navigate(`${site.url}/redirect-to?u=${target}`), (e: GraspError) => e.status === 403);
  assert.equal(hits(), n, 'la redirection ne doit pas avoir atteint le service interne');
  assert.match(fx.page.lastBlocked()?.reason ?? '', /résout vers une adresse privée/);
});

test('garde runtime : `*.localhost` (résolu par Chrome lui-même) est refusé via un joker, sans DNS', async () => {
  await fx.page.navigate(`${site.url}/`);
  const n = hits();
  await assert.rejects(fx.page.navigate(`http://app.localhost:${port}/cible-ssrf`), (e: GraspError) => e.status === 403 && /boucle locale/.test(e.message));
  const target = encodeURIComponent(`http://app.localhost:${port}/cible-ssrf`);
  await assert.rejects(fx.page.navigate(`${site.url}/redirect-to?u=${target}`), (e: GraspError) => e.status === 403);
  assert.equal(hits(), n);
});

test('DNS rebinding : Grasp résout en public, Chrome se connecte en privé → page retirée et 403', async () => {
  await fx.page.navigate(`${site.url}/`);
  const n = hits();
  await assert.rejects(fx.page.navigate(`http://rebond.test:${port}/cible-ssrf`), (e: GraspError) => e.status === 403 && /rebinding/.test(e.message) && /127\.0\.0\.1/.test(e.message));
  // Limite documentée : la requête est partie (Chrome résout après le garde) ; c'est la lecture qui est protégée.
  assert.equal(hits(), n + 1);
  const { url } = await fx.page.location();
  assert.equal(url, 'about:blank', 'la réponse du service interne ne doit pas rester lisible');
  const c = await fx.page.consoleQuery({});
  assert.ok(c.entries.some((x) => x.blocked === true && /rebinding/.test(x.text)), 'le blocage est journalisé');
});

test('hôtes littéraux inscrits tels quels : toujours permis (usage local et tunnel inchangés)', async () => {
  const loc = await fx.page.navigate(`${site.url}/cible-ssrf`);
  assert.equal(loc.title, 'Cible SSRF');
});

test('allowPrivateNetwork=true : les mêmes noms atteignent le service local (la protection bloquait bien une cible réelle)', async () => {
  const open = await openPage({ allowedDomains: ALLOW, allowPrivateNetwork: true }, undefined, {}, { chromeArgs: CHROME_ARGS, resolve });
  try {
    for (const host of ['interne.test', 'rebond.test', 'app.localhost']) {
      const loc = await open.page.navigate(`http://${host}:${port}/cible-ssrf`);
      assert.equal(loc.title, 'Cible SSRF', host);
    }
    await assert.rejects(open.page.navigate('https://example.com/'), (e: GraspError) => e.status === 403, 'l\'allowlist reste appliquée');
  } finally { await open.close(); }
});
