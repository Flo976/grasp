import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openPage, type PageFixture } from '../helpers/chrome.js';
import { startTestSite, type TestSite } from '../helpers/testsite.js';
import { GraspError } from '../../src/core/errors.js';

let site: TestSite;
let fx: PageFixture;
before(async () => { site = await startTestSite(); fx = await openPage({ allowedDomains: ['127.0.0.1'] }); });
after(async () => { await fx.close(); await site.close(); });

test('régression #2 — détecter ≠ bloquer : navigation hors allowlist = 403 ET page non chargée', async () => {
  await fx.page.navigate(`${site.url}/`);
  await assert.rejects(fx.page.navigate('https://example.com'), (e: GraspError) => e.status === 403);
  const { url, title } = await fx.page.location();
  assert.equal(url, `${site.url}/`, 'la page courante ne doit pas avoir changé');
  assert.equal(title, 'Inscription');
});

test('garde runtime : une redirection vers un domaine interdit est bloquée', async () => {
  await fx.page.navigate(`${site.url}/`);
  await assert.rejects(fx.page.navigate(`${site.url}/redirect-out`), (e: GraspError) => e.status === 403);
  const { url } = await fx.page.location();
  assert.ok(!url.includes('example.com'), `chargé : ${url}`);
});

test('garde runtime : un clic sur un lien externe est bloqué par le navigateur lui-même', async () => {
  await fx.page.navigate(`${site.url}/link-out`);
  await fx.page.click('text:Externe');
  const { url } = await fx.page.location();
  assert.ok(!url.includes('example.com'), `chargé : ${url}`);
  assert.match(fx.page.lastBlocked()?.url ?? '', /example\.com/);
});

test('schémas interdits : file:// et javascript: refusés', async () => {
  await assert.rejects(fx.page.navigate('file:///etc/passwd'), (e: GraspError) => e.status === 403);
  await assert.rejects(fx.page.navigate('javascript:alert(1)'), (e: GraspError) => e.status === 403);
});

test('défauts sûrs : eval, cookies, upload désactivés (403)', async () => {
  await fx.page.navigate(`${site.url}/`);
  await assert.rejects(fx.page.evaluate('1+1'), (e: GraspError) => e.status === 403);
  await assert.rejects(fx.page.cookies(), (e: GraspError) => e.status === 403);
  await assert.rejects(fx.page.upload('#nom', ['/etc/hostname']), (e: GraspError) => e.status === 403);
});

test('allowlist vide = tout bloqué, même le local', async () => {
  const closed = await openPage({ allowedDomains: [] });
  try {
    await assert.rejects(closed.page.navigate(`${site.url}/`), (e: GraspError) => e.status === 403);
  } finally { await closed.close(); }
});

test('opt-in explicite : allowEval=true autorise eval', async () => {
  const open = await openPage({ allowedDomains: ['127.0.0.1'], allowEval: true });
  try {
    await open.page.navigate(`${site.url}/`);
    assert.equal(await open.page.evaluate('document.title'), 'Inscription');
  } finally { await open.close(); }
});

test('garde runtime : une iframe cross-origin (OOPIF) qui navigue elle-même hors allowlist est bloquée (console désactivée)', async () => {
  const fx2 = await openPage({ allowedDomains: ['127.0.0.1', 'localhost'], allowConsole: false });
  try {
    await fx2.page.navigate(`${site.url}/console`);
    await fx2.page.click('#cadre-navigant');
    let frames: string[] = [];
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 50));
      frames = (await fx2.cdp.send<{ targetInfos: Array<{ type: string; url: string }> }>('Target.getTargets')).targetInfos.filter((t) => t.type === 'iframe').map((t) => t.url);
      if (/\[::1\]/.test(fx2.page.lastBlocked()?.url ?? '')) break;
    }
    assert.match(fx2.page.lastBlocked()?.url ?? '', /\[::1\]/, 'la navigation interne à l\'iframe doit être interceptée');
    assert.ok(frames.every((u) => !u.includes('[::1]')), `iframe chargée hors allowlist : ${frames.join(', ')}`);
  } finally { await fx2.close(); }
});
