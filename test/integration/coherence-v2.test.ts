import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openPage } from '../helpers/chrome.js';
import { startTestSite, type TestSite } from '../helpers/testsite.js';
import { Tabs } from '../../src/bridge/tabs.js';
import type { GraspError } from '../../src/core/errors.js';

/**
 * Cohérence entre les branches de la vague 2, contre un vrai Chrome : back/forward/reload acceptent --dialog et
 * --network comme nav ; un popup hérite du viewport émulé et des secrets saisis dans la session.
 */
let site: TestSite;
before(async () => { site = await startTestSite(); });
after(async () => { await site.close(); });

test('reload --dialog dismiss sur une page gardée par beforeunload : annulé aussitôt, raison dite ; défaut : accepté', async () => {
  const fx = await openPage();
  try {
    await fx.page.navigate(`${site.url}/dialogues`);
    await fx.page.click('#modifier'); // arme la garde (activation de l'utilisateur exigée par Chrome)
    const t0 = Date.now();
    const r = await fx.page.reload({ dialog: 'dismiss' }).then((x) => ({ ok: true as const, x }), (e: GraspError) => ({ ok: false as const, e }));
    assert.ok(Date.now() - t0 < 10_000, `${Date.now() - t0} ms : pas d'attente de 30 s`);
    assert.equal(r.ok, false, 'reload annulé = échec');
    if (!r.ok) {
      assert.equal(r.e.status, 409);
      assert.match(r.e.message, /navigation annulée .*beforeunload refusé.* ; dialogue beforeunload → refusé/, r.e.message);
    }
    assert.equal(await fx.page.text(undefined, '#garde'), 'Modifications non enregistrées', 'page restée telle quelle');
    // Sans option : défaut sûr (beforeunload accepté), la note le dit.
    const ok = await fx.page.reload({});
    assert.match(ok.detail ?? '', /dialogue beforeunload → accepté/, ok.detail);
  } finally { await fx.close(); }
});

test('reload --network : requête du document jointe ; back --network : tranche jointe (bfcache : parfois vide) ; forward au bout → 409', async () => {
  const fx = await openPage();
  try {
    await fx.page.nav(`${site.url}/hist-a`);
    await fx.page.nav(`${site.url}/hist-b`);
    const r = await fx.page.reload({ network: true });
    assert.ok(r.network !== undefined, 'journal réseau joint');
    assert.ok(r.network.entries.some((e) => /\/hist-b$/.test(e.url) && e.method === 'GET'), JSON.stringify(r.network.entries));
    // back : le document peut revenir du cache aller-retour, sans requête — la tranche est jointe quand même.
    const b = await fx.page.history(-1, { network: true });
    assert.match(b.url, /\/hist-a$/);
    assert.ok(b.network !== undefined && Array.isArray(b.network.entries));
    await fx.page.history(1, {});
    await assert.rejects(fx.page.history(1, { network: true }), (e: GraspError) => e.status === 409);
  } finally { await fx.close(); }
});

test('popup : viewport émulé de la session et secrets saisis hérités par le nouvel onglet', async () => {
  const fx = await openPage({ allowedDomains: ['127.0.0.1'] });
  const tabs = new Tabs(fx.cdp, fx.page, 10);
  const page = tabs.facade();
  try {
    await page.nav(`${site.url}/onglets`);
    await page.setViewport({ width: 360, height: 740, dpr: 2, mobile: false, touch: true, mobileUa: false });
    // Valeur « secrète » présente dans la page d'aide (popup) : elle doit y être masquée aussi.
    page.secretRedactor.add('FAQ', 'Questions fréquentes');
    const c = await page.click('text:Aide', { follow: true });
    assert.match(c.detail ?? '', /onglet actif : t2 \(--follow\)/);
    const v = await page.viewportInfo();
    assert.deepEqual(v.viewport, { width: 360, height: 740, dpr: 2, mobile: false, touch: true, mobileUa: false });
    assert.equal(v.measured?.width, 360, JSON.stringify(v));
    const t = await page.text();
    assert.match(t, /secret:FAQ/);
    assert.doesNotMatch(t, /Questions fréquentes/);
  } finally { await fx.close(); }
});
