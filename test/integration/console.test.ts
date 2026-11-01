import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { openPage, type PageFixture } from '../helpers/chrome.js';
import { startTestSite, type TestSite } from '../helpers/testsite.js';
import { GraspError } from '../../src/core/errors.js';
import type { ConsoleEntry } from '../../src/core/console.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PageController } from '../../src/bridge/page.js';
import { CdpClient } from '../../src/browser/cdp.js';
import { launchChrome } from '../../src/browser/launch.js';
import { discoverChrome, realProbe } from '../../src/browser/discover.js';
import { effectivePolicy } from '../../src/core/policy.js';
import { resolveConfig } from '../../src/core/config.js';

let site: TestSite;
let fx: PageFixture;
before(async () => { site = await startTestSite(); fx = await openPage({ allowedDomains: ['127.0.0.1'] }); });
after(async () => { await fx.close(); await site.close(); });

async function waitFor(page: PageController, pred: (es: ConsoleEntry[]) => boolean, since = 0, ms = 5000): Promise<ConsoleEntry[]> {
  const end = Date.now() + ms;
  let es: ConsoleEntry[] = [];
  while (Date.now() < end) {
    es = (await page.consoleQuery({ since, limit: 1000 })).entries;
    if (pred(es)) return es;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`délai dépassé ; entrées :\n${es.map((e) => JSON.stringify(e)).join('\n')}`);
}
const find = (es: ConsoleEntry[], re: RegExp) => es.filter((e) => re.test(e.text));

test('console : niveaux, objet, exception, promesse rejetée, image 404, fetch hors allowlist, iframe', async () => {
  const since = (await fx.page.consoleQuery({})).seq;
  await fx.page.navigate(`${site.url}/console`);
  const es = await waitFor(fx.page, (x) => find(x, /api\/data/).length > 0 && find(x, /depuis le cadre/).length > 0 && find(x, /promesse rejetée/).length > 0, since);
  const one = (re: RegExp) => { const m = find(es, re); assert.equal(m.length, 1, `${re} : ${JSON.stringify(m)}\n${es.map((e) => JSON.stringify(e)).join('\n')}`); return m[0]!; };

  const nav = es.find((e) => e.source === 'navigation');
  assert.match(nav?.text ?? '', /\/console$/, 'repère « navigation → url »');
  assert.equal(one(/^niveau debug$/).level, 'debug');
  assert.equal(one(/^niveau info$/).level, 'info');
  assert.equal(one(/^niveau log formaté n°7$/).level, 'info');
  assert.equal(one(/^niveau warn$/).level, 'warn');
  const obj = one(/^erreur objet /);
  assert.equal(obj.level, 'error');
  assert.equal(obj.source, 'console');
  assert.match(obj.text, /\{code: 42, detail: "champ manquant", nested: \{…\}\}/);
  assert.match(obj.url ?? '', /\/console$/);
  assert.ok((obj.line ?? 0) > 1, 'ligne source');

  const exc = one(/exception non rattrapée/);
  assert.deepEqual([exc.level, exc.source], ['error', 'exception']);
  assert.match(exc.text, /lancer/, 'pile courte');
  const rej = one(/promesse rejetée/);
  assert.deepEqual([rej.level, rej.source], ['error', 'exception']);

  const img = one(/absent\.png/);
  assert.equal(img.source, 'network');
  assert.match(img.text, /^GET http:\/\/127\.0\.0\.1:\d+\/absent\.png → 404/);
  const f = one(/api\/data/);
  assert.equal(f.source, 'network');
  assert.match(f.text, /localhost:\d+\/api\/data/);
  assert.match(f.text, /hors allowlist/, 'la console dit que le garde (documents) ne bloque pas ce fetch');

  const fr = one(/^depuis le cadre$/);
  assert.match(fr.frame ?? '', /\/console-frame$/);
});

test('console : --console sur une action = seulement les entrées produites pendant l\'action ; doublons ×N ; combinable avec --snap-diff', async () => {
  await fx.page.navigate(`${site.url}/console`);
  await waitFor(fx.page, (x) => find(x, /api\/data/).length > 0);
  const r1 = await fx.page.click('#log', { console: true });
  assert.deepEqual(r1.console?.entries.map((e) => [e.level, e.source, e.text]), [['info', 'console', 'clic 42']]);
  assert.equal(r1.console?.seq, (await fx.page.consoleQuery({})).seq);
  const r2 = await fx.page.click('#spam', { console: true, snapDiff: true });
  assert.deepEqual(r2.console?.entries.map((e) => [e.text, e.count]), [['répété', 5]]);
  assert.equal(typeof r2.diff, 'string');
  const r3 = await fx.page.click('#boom', { console: true });
  assert.match(r3.console?.entries.map((e) => e.text).join('\n') ?? '', /boum au clic/);
  const frameHits = site.hits.filter((h) => h === '/console-frame').length;
  const r4 = await fx.page.click('#cadre-bloque', { console: true });
  const blocked = r4.console?.entries.find((e) => e.blocked === true);
  assert.ok(blocked, `requête bloquée attendue : ${JSON.stringify(r4.console)}`);
  assert.equal(blocked.source, 'grasp');
  assert.match(blocked.text, /bloqué par Grasp.*localhost/);
  assert.equal(site.hits.filter((h) => h === '/console-frame').length, frameHits, 'le cadre localhost n\'a jamais été chargé');
  const nav = await fx.page.nav(`${site.url}/console`, { console: true });
  assert.match(nav.console?.entries.map((e) => `${e.source} ${e.text}`).join('\n') ?? '', /navigation .*\/console\n[\s\S]*niveau debug/);
});

test('console : une iframe cross-origin (processus séparé, OOPIF) est aussi écoutée, et gardée', async () => {
  const both = await openPage({ allowedDomains: ['127.0.0.1', 'localhost'] });
  try {
    await both.page.navigate(`${site.url}/console`);
    await both.page.click('#cadre-bloque');
    const es = await waitFor(both.page, (x) => x.some((e) => e.text === 'depuis le cadre' && /localhost/.test(e.frame ?? '')));
    const fr = es.find((e) => e.text === 'depuis le cadre' && /localhost/.test(e.frame ?? ''))!;
    assert.match(fr.frame!, /^http:\/\/localhost:\d+\/console-frame$/);
    assert.equal(fr.level, 'info');
    // Navigation lancée DANS l'iframe cross-origin vers un hôte hors allowlist : bloquée et signalée.
    await both.page.click('#cadre-navigant');
    await waitFor(both.page, (x) => x.some((e) => e.blocked === true && /\[::1\]/.test(e.text)));
  } finally { await both.close(); }
});

test('console : le tampon survit aux navigations, --since, --limit, --level, clear', async () => {
  const s0 = (await fx.page.consoleQuery({})).seq;
  await fx.page.navigate(`${site.url}/`);
  await fx.page.navigate(`${site.url}/console`);
  const es = await waitFor(fx.page, (x) => find(x, /api\/data/).length > 0, s0);
  const navs = es.filter((e) => e.source === 'navigation').map((e) => e.text);
  assert.deepEqual(navs.map((u) => new URL(u).pathname), ['/', '/console']);
  const seq = (await fx.page.consoleQuery({})).seq;
  assert.equal((await fx.page.consoleQuery({ since: seq })).entries.length, 0);
  assert.equal((await fx.page.consoleQuery({ since: s0, limit: 3 })).entries.length, 3);
  assert.ok((await fx.page.consoleQuery({ since: s0, level: 'error' })).entries.every((e) => e.level === 'error' || e.source === 'navigation'));
  const cleared = await fx.page.consoleQuery({ clear: true });
  assert.ok(cleared.entries.length > 0, 'clear renvoie ce qu\'il vide');
  assert.equal((await fx.page.consoleQuery({})).entries.length, 0);
  assert.equal((await fx.page.consoleQuery({})).seq, cleared.seq, 'seq conservé');
});

test('console : jamais de corps de requête/réponse ni d\'en-tête Authorization ; jetons masqués dans les URL', async () => {
  await fx.page.navigate(`${site.url}/console`);
  await waitFor(fx.page, (x) => find(x, /api\/data/).length > 0);
  const r = await fx.page.click('#secret', { console: true });
  await new Promise((res) => setTimeout(res, 300));
  const all = JSON.stringify([r.console, await fx.page.consoleQuery({ limit: 1000 })]);
  assert.match(all, /POST http:\/\/127\.0\.0\.1:\d+\/api\/secret\?token=\*\*\*&page=2 → 401/);
  for (const secret of ['SECRET-AUTH', 'corps-secret', 'abc123', 'corps-réponse-secret']) assert.ok(!all.includes(secret), `${secret} divulgué`);
});

test('erreurs d\'action : --shot-on-error joint le chemin d\'une capture 0600 ; --console joint les entrées', async () => {
  await fx.page.navigate(`${site.url}/console`);
  await assert.rejects(fx.page.click('#absent', { shotOnError: true, console: true }), (e: GraspError) => {
    assert.equal(e.status, 404);
    const m = /\(capture : (\/\S+\.png)\)$/.exec(e.message);
    assert.ok(m, e.message);
    assert.ok(m[1]!.startsWith(`${fx.capturesDir}/`));
    assert.ok(existsSync(m[1]!));
    assert.equal(statSync(m[1]!).mode & 0o777, 0o600);
    assert.equal(e.extra?.screenshot, m[1]);
    assert.ok(Array.isArray(e.extra?.console));
    return true;
  });
  await assert.rejects(fx.page.nav('https://example.com/', { shotOnError: true }), (e: GraspError) => e.status === 403 && /capture : \//.test(e.message));
});

test('allowConsole=false : lecture refusée (403), --console refusé, et Runtime.enable jamais appelé', async () => {
  const spy = async (allowConsole: boolean): Promise<{ methods: string[]; page: PageController; close(): Promise<void> }> => {
    const dir = mkdtempSync(join(tmpdir(), 'gr-spy-'));
    const chrome = await launchChrome({ browser: discoverChrome(process.env, realProbe, process.env.HOME ?? '/'), userDataDir: dir, headless: true });
    const cdp = await CdpClient.connect(chrome.wsUrl);
    const methods: string[] = [];
    const send = cdp.send.bind(cdp);
    cdp.send = ((m: string, p?: object, sid?: string) => { methods.push(m); return send(m, p, sid); }) as typeof cdp.send;
    const page = await PageController.attach(cdp, effectivePolicy(resolveConfig({ allowedDomains: ['127.0.0.1'], allowConsole })), { downloadDir: join(dir, 'dl') });
    return { methods, page, close: async () => { cdp.close(); await chrome.kill(); rmSync(dir, { recursive: true, force: true }); } };
  };
  const off = await spy(false);
  try {
    await off.page.navigate(`${site.url}/console`);
    await off.page.click('#log');
    await assert.rejects(off.page.consoleQuery({}), (e: GraspError) => e.status === 403 && /allowConsole/.test(e.message));
    await assert.rejects(off.page.click('#log', { console: true }), (e: GraspError) => e.status === 403);
    await assert.rejects(off.page.nav(`${site.url}/console`, { console: true }), (e: GraspError) => e.status === 403);
    // Runtime.enable est un vecteur de détection connu de l'automatisation : jamais appelé sans console.
    for (const m of ['Runtime.enable', 'Log.enable', 'Network.enable']) assert.ok(!off.methods.includes(m), `${m} appelé alors que allowConsole=false`);
  } finally { await off.close(); }
  const on = await spy(true);
  try {
    for (const m of ['Runtime.enable', 'Log.enable', 'Network.enable']) assert.ok(on.methods.includes(m), `${m} attendu avec la console`);
  } finally { await on.close(); }
});
