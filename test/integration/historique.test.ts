import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openPage, type PageFixture } from '../helpers/chrome.js';
import { startTestSite, type TestSite } from '../helpers/testsite.js';
import { GraspError } from '../../src/core/errors.js';
import { spawn } from 'node:child_process';
import { makeTestEnv } from '../helpers/env.js';
import { CLI, startServer, runCli, waitExit } from '../helpers/server.js';

/**
 * back / forward / reload / scroll contre un vrai Chrome et le site local (test/helpers/testsite-historique.ts).
 * Vérification par le contenu de la page : texte et titre lus après la commande, sans attente supplémentaire.
 */

let site: TestSite;
let fx: PageFixture;
before(async () => { site = await startTestSite(); fx = await openPage({ allowedDomains: ['127.0.0.1'] }); });
after(async () => { await fx.close(); await site.close(); });

const text = () => fx.page.text(20_000);

test('back / forward : documents de l\'historique, note « retour : url », bords de l\'historique → 409', async () => {
  await fx.page.nav(`${site.url}/hist-a`);
  await fx.page.nav(`${site.url}/hist-b`);
  await fx.page.click('text:Vers C');
  assert.equal((await fx.page.location()).title, 'Page C');
  const b = await fx.page.history(-1);
  assert.equal(b.url, `${site.url}/hist-b`);
  assert.equal(b.title, 'Page B');
  assert.match(b.detail ?? '', /^retour : http:\/\/127\.0\.0\.1:\d+\/hist-b « Page B »/);
  assert.match(await text(), /Page B/);
  const b2 = await fx.page.history(-1, { snapDiff: true });
  assert.equal(b2.title, 'Page A');
  assert.match(b2.diff ?? '', /^navigation → http:\/\/127\.0\.0\.1:\d+\/hist-a \(nouvelle page : snapshot complet\)/);
  const f = await fx.page.history(1);
  assert.equal(f.title, 'Page B');
  assert.match(f.detail ?? '', /^avance : .*\/hist-b « Page B »/);
  await fx.page.history(1);
  await assert.rejects(fx.page.history(1), (e: GraspError) => e.status === 409 && /aucune page suivante dans l'historique de l'onglet/.test(e.message));
  assert.equal((await fx.page.location()).title, 'Page C', 'un forward refusé ne bouge pas la page');
  // Une nav efface les entrées suivantes, comme dans un navigateur.
  await fx.page.history(-1);
  await fx.page.nav(`${site.url}/hist-a`);
  await assert.rejects(fx.page.history(1), (e: GraspError) => e.status === 409);
});

test('back jusqu\'à la première entrée de l\'onglet → 409, rien ne bouge', async () => {
  const own = await openPage({ allowedDomains: ['127.0.0.1'] });
  try {
    await own.page.nav(`${site.url}/hist-a`);
    // Première entrée d'un onglet neuf : about:blank (permis par le garde).
    const b = await own.page.history(-1);
    assert.equal(b.url, 'about:blank');
    await assert.rejects(own.page.history(-1), (e: GraspError) => e.status === 409 && /aucune page précédente dans l'historique de l'onglet \(entrée 1 sur 2\)/.test(e.message));
    const f = await own.page.history(1);
    assert.equal(f.title, 'Page A');
  } finally { await own.close(); }
});

test('back / forward dans une application monopage (pushState) : vue rendue après la route, attendue', async () => {
  await fx.page.nav(`${site.url}/hist-spa`);
  await fx.page.click('text:Produits');
  await fx.page.wait({ text: 'Vue produits' });
  await fx.page.click('text:Contact');
  await fx.page.wait({ text: 'Vue contact' });
  const b = await fx.page.history(-1, { snapDiff: true });
  assert.equal(b.url, `${site.url}/hist-spa/produits`);
  // La vue arrive en fetch (150 ms) après le popstate : lue juste après back, elle doit déjà être là.
  assert.match(await text(), /Vue produits/);
  assert.equal(b.title, 'Vue produits');
  assert.match(b.detail ?? '', /retour : .*\/hist-spa\/produits « Vue produits » \(même document\)/);
  assert.match(b.diff ?? '', /^~ url http:\/\/127\.0\.0\.1:\d+\/hist-spa\/produits/);
  assert.match(b.diff ?? '', /Vue produits/);
  const b2 = await fx.page.history(-1);
  assert.equal(b2.url, `${site.url}/hist-spa`);
  assert.match(await text(), /Vue accueil/);
  const f = await fx.page.history(1);
  assert.equal(f.url, `${site.url}/hist-spa/produits`);
  assert.match(await text(), /Vue produits/);
});

test('reload : document rechargé (compteur serveur), --hard sans cache HTTP, --snap-diff', async () => {
  await fx.page.nav(`${site.url}/recharge`);
  const n0 = Number(/Chargement n° (\d+)/.exec(await text())![1]);
  const r1 = await fx.page.reload();
  assert.equal(r1.url, `${site.url}/recharge`);
  assert.equal(r1.detail, undefined, 'pas de note pour un rechargement ordinaire');
  assert.match(await text(), new RegExp(`Chargement n° ${n0 + 1}\\b`));
  assert.match(await text(), /cache : normal/);
  const r2 = await fx.page.reload({ hard: true, snapDiff: true });
  assert.match(r2.diff ?? '', /^navigation → .*\/recharge \(nouvelle page : snapshot complet\)/);
  assert.match(r2.diff ?? '', new RegExp(`Chargement n° ${n0 + 2}\\b`));
  assert.match(await text(), /cache : ignoré/);
});

test('scroll --until-stable : liste à défilement infini chargée jusqu\'au bout, nœuds apparus comptés', async () => {
  await fx.page.nav(`${site.url}/defilement-infini?pages=5`);
  assert.doesNotMatch(await text(), /Article 21\b/, 'une seule page chargée avant le défilement');
  const r = await fx.page.scroll(undefined, { untilStable: true });
  assert.equal(r.scroll.how, 'page');
  assert.equal(r.scroll.added, 80, '4 pages de 20 articles (li) apparues');
  assert.equal(r.scroll.settled, true);
  assert.ok(r.scroll.steps >= 4 && r.scroll.steps <= 6, `pas : ${r.scroll.steps}`);
  assert.equal(r.scroll.to, r.scroll.max, 'bas atteint');
  assert.match(r.detail ?? '', /défilement \(page\) : 0 → .* \(bas atteint\), \d pas, 80 nœud\(s\) apparu\(s\), plus rien n'apparaît/);
  const t = await text();
  assert.match(t, /Article 100\b/);
  assert.match(t, /Fin de la liste/);
});

test('scroll --until-stable --max-steps : plafond annoncé, jamais présenté comme fini', async () => {
  await fx.page.nav(`${site.url}/defilement-infini?pages=10`);
  const r = await fx.page.scroll(undefined, { untilStable: true, maxSteps: 2 });
  assert.equal(r.scroll.steps, 2);
  assert.equal(r.scroll.settled, false);
  assert.equal(r.scroll.stoppedBy, 'steps');
  assert.equal(r.scroll.added, 40);
  assert.match(r.detail ?? '', /plafond de 2 pas atteint : du contenu peut encore apparaître/);
});

test('scroll <conteneur> --until-stable --snap-diff : zone défilante (overflow), nouveaux articles dans le diff', async () => {
  await fx.page.nav(`${site.url}/defilement-infini?pages=3&conteneur=1`);
  const r = await fx.page.scroll('#zone', { untilStable: true }, { snapDiff: true });
  assert.equal(r.scroll.how, 'element');
  assert.equal(r.scroll.added, 40);
  assert.equal(r.scroll.settled, true);
  assert.match(r.diff ?? '', /^\+ .*Article 21\b/m);
  assert.match(r.diff ?? '', /^\+ .*Article 60\b/m);
  // La page elle-même n'a pas défilé : seule la zone.
  const p = await fx.page.scroll(undefined, { to: 'top' });
  assert.equal(p.scroll.from, 0);
  // Un élément de la liste (qui ne défile pas lui-même) : son ancêtre défilant.
  const a = await fx.page.scroll('#liste', { to: 'top' });
  assert.equal(a.scroll.how, 'ancestor');
  assert.equal(a.scroll.to, 0);
  assert.ok(a.scroll.from > 0);
});

test('scroll simple : un écran, --by (négatif), --to top|bottom, élément amené dans la vue', async () => {
  await fx.page.nav(`${site.url}/capture`);
  const s1 = await fx.page.scroll(undefined, {});
  assert.equal(s1.scroll.from, 0);
  assert.ok(s1.scroll.to > 300 && s1.scroll.to < s1.scroll.max, `un écran : ${s1.scroll.to}`);
  assert.equal(s1.scroll.added, 0);
  assert.equal(s1.scroll.settled, undefined);
  const s2 = await fx.page.scroll(undefined, { by: -100 });
  assert.equal(s2.scroll.to, s1.scroll.to - 100);
  const s3 = await fx.page.scroll(undefined, { to: 'bottom' });
  assert.equal(s3.scroll.to, s3.scroll.max);
  assert.match(s3.detail ?? '', /\(bas atteint\)/);
  const s4 = await fx.page.scroll(undefined, { to: 'top' });
  assert.equal(s4.scroll.to, 0);
  const s5 = await fx.page.scroll('#cible', {});
  assert.equal(s5.scroll.how, 'into');
  assert.ok(s5.scroll.to > 1000, `cible amenée dans la vue : ${s5.scroll.to}`);
  assert.match(s5.detail ?? '', /élément amené dans la vue/);
  await assert.rejects(fx.page.scroll('frame=#x >> button', {}), (e: GraspError) => e.status === 400 && /frame=/.test(e.message));
  await assert.rejects(fx.page.scroll('#absent', {}), (e: GraspError) => e.status === 404);
});

/**
 * Page qui embarque une iframe hors allowlist (publicité, widget : cas courant avec une allowlist stricte). Le garde
 * annule le document du cadre, pas celui de la page : back (page non éligible au cache aller-retour, donc
 * redemandée au serveur) et reload aboutissent, le blocage du cadre n'est qu'une note.
 */
test('back et reload d\'une page dont une iframe est hors allowlist → OK, page affichée, cadre bloqué en note', async () => {
  const port = new URL(site.url).port;
  const page = `${site.url}/hist-cadre?cadre=${encodeURIComponent(`http://localhost:${port}/hist-c`)}`;
  const n = () => site.hits.filter((h) => h === '/hist-cadre').length;
  await fx.page.nav(page);
  await fx.page.nav(`${site.url}/hist-a`);
  const n0 = n();
  const b = await fx.page.history(-1);
  assert.equal(n(), n0 + 1, 'document redemandé au serveur (pas de cache aller-retour)');
  assert.match(b.title, /^Avec cadre \d+$/);
  assert.match(b.detail ?? '', /cadre bloqué : domaine hors allowlist : localhost/);
  const r = await fx.page.reload();
  assert.equal(n(), n0 + 2);
  assert.match(r.title, /^Avec cadre \d+$/);
  assert.equal((await fx.page.location()).title, r.title);
  const h = await fx.page.reload({ hard: true });
  assert.equal(n(), n0 + 3);
  assert.match(h.detail ?? '', /cadre bloqué/);
});

/**
 * Garde de navigation appliqué à l'historique. Réseau simulé comme dans ssrf.test.ts : Chrome envoie `*.test` sur
 * 127.0.0.1, et le résolveur du garde (injecté) répond ce que « le DNS » dit — ici, il change entre la visite et le
 * retour (public, puis privé). allowConsole=false : sans domaine Network, pas de contrôle anti-rebinding après
 * coup, seul le pré-contrôle et le garde Fetch jugent.
 */
test('garde : back et reload vers une entrée qui résout désormais en privé → 403, aucune requête, page conservée', async () => {
  const dns: Record<string, string[]> = { 'mobile.test': ['93.184.216.34'] };
  const resolve = async (h: string) => {
    const a = dns[h];
    if (a === undefined) throw Object.assign(new Error('introuvable'), { code: 'ENOTFOUND' });
    return a;
  };
  const own = await openPage({ allowedDomains: ['127.0.0.1', '*.test'], allowConsole: false }, undefined, {}, { chromeArgs: ['--host-resolver-rules=MAP *.test 127.0.0.1'], resolve });
  const port = new URL(site.url).port;
  const hitsA = () => site.hits.filter((h) => h === '/hist-a').length;
  try {
    await own.page.nav(`http://mobile.test:${port}/hist-a`);
    await own.page.nav(`${site.url}/hist-b`);
    dns['mobile.test'] = ['10.0.0.5'];
    const n = hitsA();
    await assert.rejects(own.page.history(-1), (e: GraspError) => e.status === 403 && /navigation bloquée/.test(e.message) && /10\.0\.0\.5/.test(e.message));
    assert.equal(hitsA(), n, 'aucune requête vers l\'entrée refusée');
    assert.equal((await own.page.location()).title, 'Page B', 'page conservée');
    // reload d'une page dont l'hôte résout désormais en privé : même refus.
    dns['mobile.test'] = ['93.184.216.34'];
    await own.page.nav(`http://mobile.test:${port}/hist-a`);
    dns['mobile.test'] = ['10.0.0.5'];
    const m = hitsA();
    await assert.rejects(own.page.reload(), (e: GraspError) => e.status === 403 && /10\.0\.0\.5/.test(e.message));
    assert.equal(hitsA(), m);
    assert.equal((await own.page.location()).title, 'Page A');
  } finally { await own.close(); }
});

/** grasp mcp --session : appels tools/call successifs, texte de chaque résultat (une ligne JSON par message). */
async function mcpCalls(env: NodeJS.ProcessEnv, session: string, calls: Array<[string, Record<string, unknown>]>): Promise<Array<{ text: string; isError: boolean }>> {
  const p = spawn(process.execPath, [CLI, 'mcp', '--session', session, '--no-serve'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const replies = new Map<number, (m: any) => void>();
  let buf = '';
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', (d: string) => {
    buf += d;
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      replies.get(m.id)?.(m);
    }
  });
  let id = 0;
  const req = (method: string, params: unknown) => new Promise<any>((resolve) => { replies.set(++id, resolve); p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  try {
    await req('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    const out: Array<{ text: string; isError: boolean }> = [];
    for (const [name, args] of calls) {
      const r = await req('tools/call', { name, arguments: args });
      out.push({ text: (r.result.content as Array<{ text: string }>).map((c) => c.text).join('\n'), isError: r.result.isError === true });
    }
    return out;
  } finally { p.stdin.end(); await waitExit(p); }
}

test('CLI, grasp run et MCP : back forward reload scroll de bout en bout (notes sur stderr, --json, erreurs)', async () => {
  const t = makeTestEnv();
  const srv = await startServer(t.env);
  try {
    const id = (await runCli(t.env, ['session', 'create'])).stdout.trim();
    const env = { ...t.env, GRASP_SESSION: id };
    const ok = async (args: string[], stdin?: string) => { const r = await runCli(env, args, stdin); assert.equal(r.code, 0, `${args.join(' ')} : ${r.stderr}`); return r; };
    await ok(['nav', `${site.url}/hist-a`]);
    await ok(['nav', `${site.url}/hist-b`]);
    const b = await ok(['back']);
    assert.equal(b.stdout, 'OK\n');
    assert.match(b.stderr, /^note: retour : http:\/\/127\.0\.0\.1:\d+\/hist-a « Page A »$/m);
    const f = JSON.parse((await ok(['forward', '--json'])).stdout) as { url: string; title: string };
    assert.equal(f.title, 'Page B');
    const edge = await runCli(env, ['forward']);
    assert.equal(edge.code, 1);
    assert.match(edge.stderr, /^ERROR: forward: aucune page suivante dans l'historique de l'onglet/m);
    assert.match((await ok(['reload', '--hard', '--snap-diff'])).stdout, /^navigation → .*\/hist-b \(nouvelle page : snapshot complet\)/);
    await ok(['nav', `${site.url}/defilement-infini?pages=4`]);
    const s = await ok(['scroll', '--until-stable', '--json']);
    const j = JSON.parse(s.stdout) as { scroll: { added: number; settled: boolean } };
    assert.equal(j.scroll.added, 60);
    assert.equal(j.scroll.settled, true);
    const bad = await runCli(env, ['scroll', '--by', '10', '--to', 'top']);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /--by et --to s'excluent/);

    // grasp run : mêmes commandes, notes numérotées.
    const ran = await ok(['run'], `nav ${site.url}/defilement-infini?pages=3\nscroll --until-stable --max-steps 5\nexpect text "Fin de la liste"\nback\nreload\n`);
    assert.match(ran.stdout, /\[2\] scroll --until-stable --max-steps 5 → OK/);
    assert.match(ran.stderr, /\[2\] note: défilement \(page\) : 0 → .*40 nœud\(s\) apparu\(s\), plus rien n'apparaît/);
    assert.match(ran.stdout, /\[4\] back → OK/);
    assert.match(ran.stderr, /\[4\] note: retour : .*\/defilement-infini\?pages=4/);
    assert.match(ran.stdout, /\[5\] reload → OK/);

    // MCP : outils back, forward, reload, scroll (arguments camelCase → options de la CLI).
    const [m1, m2, m3, m4, m5] = await mcpCalls(t.env, id, [
      ['nav', { url: `${site.url}/defilement-infini?pages=2&conteneur=1` }],
      ['scroll', { target: '#zone', untilStable: true, maxSteps: 4 }],
      ['back', {}],
      ['forward', { snapDiff: true }],
      ['reload', { hard: true }],
    ]);
    assert.equal(m1!.text, 'OK');
    assert.match(m2!.text, /^note: défilement \(zone\) : .*20 nœud\(s\) apparu\(s\), plus rien n'apparaît\nOK$/);
    assert.match(m3!.text, /^note: retour : .*\/defilement-infini\?pages=4 « Défilement infini »\nOK$/);
    assert.match(m4!.text, /navigation → .*conteneur=1 \(nouvelle page : snapshot complet\)/);
    assert.equal(m5!.isError, false, m5!.text);
  } finally { srv.proc.kill('SIGTERM'); await waitExit(srv.proc); t.cleanup(); }
});
