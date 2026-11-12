import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { makeTestEnv } from '../helpers/env.js';
import { startServer, runCli, waitExit } from '../helpers/server.js';
import { startTestSite } from '../helpers/testsite.js';
import { resolvePaths } from '../../src/core/paths.js';

/**
 * Retour 1 du troisième essai réel : un sélecteur CSS ambigu sur des images alt="" (sans ref) répondait
 * « utilisez une ref » sans candidat. Le 409 liste maintenant les candidats (balise, boîte, sélecteur prêt à
 * l'emploi) et ` >> nth=N` choisit la N-ième correspondance, en commande isolée comme dans run.
 */
test('sélecteur CSS ambigu : 409 avec candidats et boîtes ; >> nth=N choisit (expect, click, run)', async () => {
  const t = makeTestEnv();
  const site = await startTestSite();
  const paths = resolvePaths(t.env, t.env.HOME!);
  mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
  writeFileSync(paths.configFile, JSON.stringify({ allowedDomains: ['127.0.0.1'] }), { mode: 0o600 });
  const srv = await startServer(t.env);
  try {
    const id = (await runCli(t.env, ['session', 'create', '--viewport', '360x800'])).stdout.trim();
    const env = { ...t.env, GRASP_SESSION: id };
    assert.equal((await runCli(env, ['nav', `${site.url}/icones`])).code, 0);

    const amb = await runCli(env, ['expect', 'not-clipped', 'img.ico', '--timeout', '0']);
    assert.notEqual(amb.code, 0);
    // Trois candidats, chacun avec sa balise, sa boîte et un sélecteur unique (ancêtre identifié ou nth).
    assert.match(amb.stderr, /3 éléments correspondent à img\.ico : nth=0 img\.ico @\d+,\d+ 24x24 → \S.* ; nth=1 img\.ico @\d+,\d+ 24x24 → \S.* ; nth=2 img\.ico @\d+,\d+ 24x24 → /, amb.stderr);
    assert.match(amb.stderr, /ajoutez ` >> nth=N` \(à partir de 0\)/);
    assert.doesNotMatch(amb.stderr, /utilisez une ref/);

    // Les sélecteurs proposés sont réutilisables tels quels (uniques) : le premier désigne la première icône.
    const pick0 = /nth=0 img\.ico @\S+ \S+ → (.+?) ; nth=1/.exec(amb.stderr)![1]!;
    assert.equal((await runCli(env, ['expect', 'not-clipped', pick0, '--timeout', '0'])).code, 0, pick0);
    // Candidats dont les sélecteurs stables sont eux-mêmes ambigus (deux liens identiques : même aria-label,
    // même href) : 409 rendu vite, sans reboucler sur la construction des candidats (régression relevée en revue).
    const t0 = Date.now();
    const liens = await runCli(env, ['click', 'a[href="/p"]']);
    assert.equal(liens.code, 1);
    assert.match(liens.stderr, /2 éléments correspondent à a\[href="\/p"\] : nth=0 a @.* → a\[href="\/p"\] >> nth=0 ; nth=1 a @.* → .*nth=1|2 éléments correspondent à a\[href="\/p"\] : nth=0 a @/);
    assert.ok(Date.now() - t0 < 8000, `409 en ${Date.now() - t0} ms`);
    // Une action sur une ref de ces liens (sélecteur durable de l'historique) ne reboucle pas non plus.
    const snap = (await runCli(env, ['snap'])).stdout;
    const ref = /(e[0-9a-z]+):link "Aide"/.exec(snap)?.[1];
    assert.ok(ref !== undefined, snap);
    const t1 = Date.now();
    assert.equal((await runCli(env, ['hover', ref])).code, 0);
    assert.ok(Date.now() - t1 < 8000, `hover en ${Date.now() - t1} ms`);

    // nth choisit : la première icône tient dans sa carte, la deuxième est rognée.
    assert.equal((await runCli(env, ['expect', 'not-clipped', 'img.ico >> nth=0', '--timeout', '0'])).code, 0);
    const rogne = await runCli(env, ['expect', 'not-clipped', 'img.ico >> nth=1', '--timeout', '0']);
    assert.equal(rogne.code, 1);
    assert.match(rogne.stderr, /rogné par div#c2\.carte/);
    // Hors bornes : 404 qui dit combien il y en a ; expect sel / no-sel suivent la même syntaxe.
    const loin = await runCli(env, ['expect', 'not-clipped', 'img.ico >> nth=3', '--timeout', '0']);
    assert.match(loin.stderr, /img\.ico >> nth=3 : 3 élément\(s\) seulement \(nth=0 à 2\)/);
    assert.equal((await runCli(env, ['expect', 'sel', 'img.ico >> nth=2', '--timeout', '0'])).code, 0);
    assert.equal((await runCli(env, ['expect', 'no-sel', 'img.ico >> nth=3', '--timeout', '0'])).code, 0);
    // Une action aussi (clic sur la troisième), et dans run.
    assert.equal((await runCli(env, ['click', 'img.ico >> nth=2'])).code, 0);
    const r = await runCli(env, ['run'], `expect not-clipped 'img.ico >> nth=0'\nexpect not-clipped 'img.ico >> nth=1' --timeout 0\n`);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /^OK  \[1\]/m);
    assert.match(r.stdout, /^KO  \[2\]/m);
  } finally { srv.proc.kill('SIGTERM'); await waitExit(srv.proc); await site.close(); t.cleanup(); }
});
