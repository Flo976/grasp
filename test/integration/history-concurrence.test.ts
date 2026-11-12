import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openPage, type PageFixture } from '../helpers/chrome.js';
import { startTestSite, type TestSite } from '../helpers/testsite.js';

/**
 * grasp history : deux actions concurrentes d'une même session (le control plane ne les sérialise pas) décrivent
 * chacune SA cible — jamais celle de l'autre (sinon un mot de passe serait conservé sur la foi de la description
 * d'un bouton, et la ligne rejouée viserait le mauvais élément).
 */
let site: TestSite;
let fx: PageFixture;
before(async () => { site = await startTestSite(); fx = await openPage({ allowedDomains: ['127.0.0.1'] }); });
after(async () => { await fx.close(); await site.close(); });

test('history : actions concurrentes, chacune décrit sa propre cible', async () => {
  await fx.page.navigate(`${site.url}/historique`);
  // Les actions concurrentes partagent aussi le groupe d'objets CDP « grasp » (libéré à la fin de chacune) :
  // l'autre peut alors échouer (« Could not find object with given id ») — limite connue, hors sujet ici.
  // Ce qui est vérifié : une action qui aboutit ne rend JAMAIS la description d'une autre cible.
  let both = 0;
  for (let i = 0; i < 12 && both < 4; i++) {
    const snap = (await fx.page.snapshot()).text;
    const line = snap.split('\n').find((l) => /checkbox "Urgent"/.test(l));
    assert.ok(line !== undefined, snap);
    const ref = line.trim().split(':')[0]!;
    // Lancées ensemble : la seconde commence pendant que la première attend encore.
    const [a, b] = await Promise.allSettled([
      fx.page.fill('#code', `S3cret-${i}`, { describeTarget: '#code' }),
      fx.page.click(ref, { describeTarget: ref }),
    ]);
    for (const r of [a, b]) if (r.status === 'rejected') assert.match(String((r.reason as Error).message), /Could not find object/);
    if (a.status === 'fulfilled') {
      assert.equal(a.value.target?.given, '#code', JSON.stringify(a.value.target));
      assert.equal(a.value.target?.secret, true);
    }
    if (b.status === 'fulfilled') {
      assert.equal(b.value.target?.given, ref, JSON.stringify(b.value.target));
      assert.equal(b.value.target?.secret, false);
      assert.equal(b.value.target?.durable, 'text:Urgent');
    }
    if (a.status === 'fulfilled' && b.status === 'fulfilled') both++;
  }
  assert.ok(both >= 4, `${both} paire(s) aboutie(s) sur 12 essais`);
});
