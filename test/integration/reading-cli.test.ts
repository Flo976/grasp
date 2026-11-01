import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestEnv } from '../helpers/env.js';
import { startServer, runCli, waitExit } from '../helpers/server.js';
import { startTestSite } from '../helpers/testsite.js';
import { TRUNC_RE } from '../../src/core/limits.js';

const lastLine = (s: string) => s.replace(/\n$/, '').split('\n').pop()!;
const refIn = (s: string, re: RegExp): string => {
  const l = s.split('\n').find((x) => re.test(x));
  assert.ok(l, `aucune ligne ${re} dans :\n${s}`);
  return l.replace(/^[+~-] /, '').trim().split(':')[0]!;
};

test('CLI : text/snap/--snap-diff bornés par défaut, --max, --scope, wait, refs résilientes, élagage — de bout en bout', async () => {
  const t = makeTestEnv();
  const site = await startTestSite();
  const srv = await startServer(t.env);
  try {
    const id = (await runCli(t.env, ['session', 'create'])).stdout.trim();
    const env = { ...t.env, GRASP_SESSION: id };
    const ok = async (args: string[]) => { const r = await runCli(env, args); assert.equal(r.code, 0, `${args.join(' ')} : ${r.stderr}`); return r; };

    // 1. Limites et zone
    await ok(['nav', `${site.url}/long`]);
    const text = await ok(['text']);
    assert.match(lastLine(text.stdout), TRUNC_RE);
    assert.ok(text.stdout.length < 4200, `${text.stdout.length} caractères`);
    assert.match((await ok(['text', '--max', '100000'])).stdout, /Paragraphe n° 199/);
    const zone = await ok(['text', '--scope', '#zone']);
    assert.match(zone.stdout, /Texte de la zone/);
    assert.doesNotMatch(zone.stdout, /Paragraphe/);
    const zsnap = await ok(['snap', '--scope', '#zone']);
    assert.match(zsnap.stdout, /button "Dans la zone"/);
    const region = refIn(zsnap.stdout, /region "Zone"/);
    assert.equal((await ok(['snap', '--scope', region])).stdout, zsnap.stdout, '--scope accepte une ref');
    const diff = await ok(['click', '#ajout300', '--snap-diff']);
    assert.match(lastLine(diff.stdout), TRUNC_RE);
    const badMax = await runCli(env, ['click', '#ajout300', '--snap-diff', '--max', 'abc']);
    assert.equal(badMax.code, 1);
    assert.match(badMax.stderr, /^ERROR: click: .*max/m);
    await ok(['nav', `${site.url}/big`]);
    const snap = await ok(['snap']);
    assert.ok(Buffer.byteLength(snap.stdout) <= 12_001, `${Buffer.byteLength(snap.stdout)} octets`);
    assert.match(lastLine(snap.stdout), /tronqué : \d+ caractères restants/);
    const scopeKo = await runCli(env, ['snap', '--scope', '#absent']);
    assert.equal(scopeKo.code, 1);
    assert.match(scopeKo.stderr, /^ERROR: snap: .*#absent/m);

    // 2. Stabilité et wait
    await ok(['nav', `${site.url}/spa`]);
    assert.match((await ok(['snap'])).stdout, /^page "Application" .*\n[\s\S]*heading\[1\] "Contenu chargé"/);
    await ok(['nav', `${site.url}/tardif`]);
    await ok(['click', '#charger']);
    const w = await ok(['wait', '--text', 'Résultat prêt']);
    assert.equal(w.stdout, 'OK\n');
    assert.match(w.stderr, /attendu \d+ ms/);
    const wj = JSON.parse((await ok(['wait', '--idle', '--json'])).stdout);
    assert.equal(wj.ok, true);
    assert.equal(typeof wj.waited, 'number');
    const late = await runCli(env, ['wait', '--text', 'Jamais affiché', '--timeout', '300']);
    assert.equal(late.code, 1);
    assert.equal(late.stdout, '');
    assert.match(late.stderr, /^ERROR: wait: .*Jamais affiché.*300 ms/m);
    const both = await runCli(env, ['wait', '--text', 'a', '--sel', '#b']);
    assert.match(both.stderr, /^ERROR: wait: /m);
    const badTimeout = await runCli(env, ['wait', '--idle', '--timeout', 'abc']);
    assert.equal(badTimeout.code, 1);
    assert.match(badTimeout.stderr, /^ERROR: wait: .*timeout/m);
    const td = await ok(['click', '#transition', '--snap-diff']);
    assert.match(td.stdout, /heading\[2\] "Résultat final"/);
    await ok(['click', refIn(td.stdout, /button "Confirmer la réservation"/)]);

    // 3. Refs résilientes
    await ok(['nav', `${site.url}/refs?n=1`]);
    const panier = refIn((await ok(['snap'])).stdout, /button "Panier \(1\)"/);
    await ok(['click', panier]);
    const stale = await runCli(env, ['click', panier]);
    assert.equal(stale.code, 1);
    assert.match(stale.stderr, /^ERROR: click: ref e[0-9a-z]+ \(button "Panier \(1\)"\) n'est plus dans la page ; candidats les plus proches : e[0-9a-z]+ button "Panier \(2\)"/m);
    const sj = await runCli(env, ['click', 'text:Panir']);
    assert.match(sj.stderr, /noms proches : e[0-9a-z]+ button "Panier \(2\)"/);

    // 4. Élagage annoncé
    await ok(['nav', `${site.url}/elague`]);
    assert.match(lastLine((await ok(['snap'])).stdout), /^… élagué : 3 liens sans nom .*, 2 iframes non parcourues$/);

    const help = await ok(['help']);
    for (const re of [/wait \[--text T \| --sel S \| --idle\] \[--timeout ms\]/, /text \[--max N\] \[--scope <ref\|css\|frame=…>\]/, /snap \[--max octets\] \[--scope <ref\|css\|frame=…>\]/]) assert.match(help.stdout, re);
  } finally { srv.proc.kill('SIGTERM'); await waitExit(srv.proc); await site.close(); t.cleanup(); }
});

test('CLI : limites configurables (textMax, diffMax, snapMax, stableTimeoutMs), transmises au bridge au démarrage', async () => {
  const t = makeTestEnv();
  const site = await startTestSite();
  for (const [k, v] of [['textMax', '200'], ['diffMax', '150'], ['snapMax', '600'], ['stableTimeoutMs', '800']]) {
    const r = await runCli(t.env, ['config', 'set', k!, v!]);
    assert.equal(r.code, 0, r.stderr);
  }
  const srv = await startServer(t.env);
  try {
    await runCli(t.env, ['session', 'create']);
    await runCli(t.env, ['nav', `${site.url}/long`]);
    const text = (await runCli(t.env, ['text'])).stdout;
    assert.ok(text.split('\n').slice(0, -2).join('\n').length <= 200, text);
    assert.match(lastLine(text), TRUNC_RE);
    const snap = (await runCli(t.env, ['snap'])).stdout;
    assert.ok(Buffer.byteLength(snap) <= 601, `${Buffer.byteLength(snap)} octets`);
    const diff = (await runCli(t.env, ['click', '#ajout300', '--snap-diff'])).stdout;
    assert.ok(diff.split('\n').slice(0, -2).join('\n').length <= 150, diff);
    const t0 = Date.now();
    const nav = await runCli(t.env, ['nav', `${site.url}/agite`]);
    assert.equal(nav.code, 0, nav.stderr);
    assert.ok(Date.now() - t0 < 4000, `plafond de stabilité non appliqué : ${Date.now() - t0} ms`);
    assert.match(nav.stderr, /note: .*DOM encore instable après \d+ ms/);
    const bad = await runCli(t.env, ['config', 'set', 'stableTimeoutMs', '-1']);
    assert.notEqual(bad.code, 0);
  } finally { srv.proc.kill('SIGTERM'); await waitExit(srv.proc); await site.close(); t.cleanup(); }
});
