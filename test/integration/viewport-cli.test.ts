import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { makeTestEnv } from '../helpers/env.js';
import { startServer, runCli, waitExit } from '../helpers/server.js';
import { startTestSite } from '../helpers/testsite.js';
import { resolvePaths } from '../../src/core/paths.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('CLI : session create --viewport, viewport (lecture, réglage, reset), ligne de run, session list ; conservé à la bascule de profil et au recyclage', async () => {
  const t = makeTestEnv();
  const site = await startTestSite();
  // Recyclage par âge (1,2 s) : le viewport doit survivre à la relance du navigateur.
  const paths = resolvePaths(t.env, t.env.HOME!);
  mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
  writeFileSync(paths.configFile, JSON.stringify({ browserMaxAgeMin: 0.02, allowedDomains: ['127.0.0.1'] }), { mode: 0o600 });
  const srv = await startServer(t.env);
  try {
    // Option invalide : refusée avant tout lancement de navigateur.
    const bad = await runCli(t.env, ['session', 'create', '--viewport', '360x10']);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /^ERROR: session: viewport : hauteur entière de 50 à 10000 px/m);
    const id = (await runCli(t.env, ['session', 'create', '--viewport', '360x800', '--touch'])).stdout.trim();
    assert.match(id, /^s[0-9a-f]+$/);
    const env = { ...t.env, GRASP_SESSION: id };
    const ok = async (args: string[], input?: string) => { const r = await runCli(env, args, input); assert.equal(r.code, 0, `${args.join(' ')} : ${r.stderr}`); return r; };

    // La première page est déjà rendue à 360 px.
    await ok(['nav', `${site.url}/viewport`]);
    const t1 = (await ok(['text'])).stdout;
    assert.match(t1, /Mise en page mobile/);
    assert.match(t1, /Écran tactile/);
    const show = await ok(['viewport']);
    assert.equal(show.stdout, '360x800, tactile — page : 360x800, dpr 1, 5 point(s) tactile(s), pointeur coarse\n');
    assert.match((await ok(['session', 'list'])).stdout, /\tviewport 360x800, tactile$/m);

    // Recyclage (âge > 1,2 s) : nouveau navigateur, page rechargée, viewport réappliqué avant le rechargement.
    await sleep(1500);
    const rec = await ok(['text']);
    assert.match(rec.stderr, /navigateur recyclé/);
    assert.match(rec.stdout, /Mise en page mobile/);

    // Réglage en ligne de commande, avec appareil ; puis reset.
    const set = await ok(['viewport', 'iphone-se']);
    assert.equal(set.stdout, '375x667, dpr 2, mobile, tactile (iphone-se) — page : 375x667, dpr 2, 5 point(s) tactile(s), pointeur coarse\n');
    const j = JSON.parse((await ok(['viewport', '--json'])).stdout);
    assert.deepEqual(j.viewport, { width: 375, height: 667, dpr: 2, mobile: true, touch: true, mobileUa: false, device: 'iphone-se' });
    await sleep(1300);
    assert.match((await ok(['text'])).stdout, /Largeur 375/, 'dernier viewport réappliqué après un nouveau recyclage');
    const reset = await ok(['viewport', 'reset']);
    assert.match(reset.stdout, /^viewport du navigateur \(aucune émulation\) — page : \d+x\d+/);
    assert.match((await ok(['text'])).stdout, /Mise en page bureau/);
    assert.doesNotMatch((await ok(['session', 'list'])).stdout, /viewport/);

    // Erreurs de syntaxe : jamais ignorées.
    for (const [args, re] of [
      [['viewport', 'reset', '--mobile'], /reset ne prend aucune option/],
      [['viewport', '360x800', '--dpr', '9'], /dpr de 0\.5 à 5/],
      [['viewport', 'nokia'], /appareil inconnu « nokia »/],
      [['viewport', '--mobile'], /usage : grasp viewport/],
    ] as const) {
      const r = await runCli(env, [...args]);
      assert.equal(r.code, 1, args.join(' '));
      assert.match(r.stderr, re);
    }

    // Ligne de run : même syntaxe, sortie compacte, retenu par le control plane.
    const run = await ok(['run'], `viewport 360x800 --mobile\nnav ${site.url}/viewport\ntext\nviewport\n`);
    assert.match(run.stdout, /\[1\] viewport 360x800 --mobile → OK\n360x800, mobile — page : 360x800/);
    assert.match(run.stdout, /Mise en page mobile/);
    assert.match((await ok(['session', 'list'])).stdout, /viewport 360x800, mobile/);
    const badRun = await runCli(env, ['run'], 'viewport 360x800 --zoom 2\n');
    assert.equal(badRun.code, 1);
    assert.match(badRun.stderr, /option --zoom inconnue pour viewport/);

    // Bascule de profil : navigateur relancé sur un autre profil, viewport conservé.
    await ok(['profiles', 'create', 'mobile']);
    await ok(['profile', 'mobile']);
    await ok(['nav', `${site.url}/viewport`]);
    assert.match((await ok(['text'])).stdout, /Largeur 360/);
  } finally { srv.proc.kill('SIGTERM'); await waitExit(srv.proc); await site.close(); t.cleanup(); }
});

test('viewport --mobile : note explicite quand la page n\'a pas de <meta name=viewport> (mise en page sur 980 px), aucune sinon', async () => {
  const t = makeTestEnv();
  const site = await startTestSite();
  const paths = resolvePaths(t.env, t.env.HOME!);
  mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
  writeFileSync(paths.configFile, JSON.stringify({ allowedDomains: ['127.0.0.1'] }), { mode: 0o600 });
  const srv = await startServer(t.env);
  try {
    const id = (await runCli(t.env, ['session', 'create', '--viewport', '360x800', '--mobile'])).stdout.trim();
    const env = { ...t.env, GRASP_SESSION: id };
    const ok = async (args: string[], input?: string) => { const r = await runCli(env, args, input); assert.equal(r.code, 0, `${args.join(' ')} : ${r.stderr}`); return r; };

    // Page avec <meta name=viewport> : largeur mesurée = viewport, aucune note.
    await ok(['nav', `${site.url}/viewport`]);
    const avec = await ok(['viewport']);
    assert.match(avec.stdout, /— page : 360x800/);
    assert.doesNotMatch(avec.stderr, /meta name=viewport/);
    assert.equal(JSON.parse((await ok(['viewport', '--json'])).stdout).detail, undefined);

    // Page sans meta (« / ») : Chrome la met en page sur 980 px ; la note le dit, la mesure reste affichée.
    await ok(['nav', `${site.url}/`]);
    const sans = await ok(['viewport']);
    assert.match(sans.stdout, /— page : 98\dx\d+/);
    assert.match(sans.stderr, /note: pas de <meta name=viewport> dans la page : Chrome la met en page sur 980 px .*comportement normal en --mobile/);
    // Même note dans run (lecture et réglage) ; aucune quand le mode mobile est retiré.
    const run = await ok(['run'], 'viewport\nviewport 360x800 --mobile\nviewport 360x800\n');
    assert.match(run.stderr, /\[1\] note: pas de <meta name=viewport>/);
    assert.match(run.stderr, /\[2\] note: pas de <meta name=viewport>/);
    assert.doesNotMatch(run.stderr, /\[3\] note: pas de <meta/);
  } finally { srv.proc.kill('SIGTERM'); await waitExit(srv.proc); await site.close(); t.cleanup(); }
});
