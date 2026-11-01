import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { makeTestEnv } from '../helpers/env.js';
import { startServer, runCli, waitExit } from '../helpers/server.js';
import { startTestSite } from '../helpers/testsite.js';
import { resolvePaths } from '../../src/core/paths.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('CLI screenshot : chemin sur stdout (fichier 0600 sous l\'état de Grasp, dossier 0700), --json, -o, -o -, --full/--el/--max-width/--refs', async () => {
  const t = makeTestEnv();
  const site = await startTestSite();
  const srv = await startServer(t.env);
  try {
    const id = (await runCli(t.env, ['session', 'create'])).stdout.trim();
    const env = { ...t.env, GRASP_SESSION: id };
    assert.equal((await runCli(env, ['nav', `${site.url}/capture`])).code, 0);
    const captures = join(resolvePaths(t.env, t.env.HOME).stateDir, 'captures');

    const r = await runCli(env, ['screenshot']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^\/\S+\.png\n$/, 'le chemin, pas le binaire');
    const path = r.stdout.trim();
    assert.equal(dirname(path), captures);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(captures).mode & 0o777, 0o700);
    assert.equal(readFileSync(path).subarray(1, 4).toString(), 'PNG');

    const j = JSON.parse((await runCli(env, ['screenshot', '--full', '--max-width', '200', '--format', 'jpeg', '--quality', '60', '--json'])).stdout);
    assert.deepEqual(Object.keys(j).sort(), ['bytes', 'format', 'height', 'path', 'width']);
    assert.equal(j.format, 'jpeg');
    assert.ok(j.width <= 200 && j.height > j.width * 3, JSON.stringify(j));
    assert.equal(statSync(j.path).size, j.bytes);
    assert.match(j.path, /\.jpg$/);

    const el = JSON.parse((await runCli(env, ['screenshot', '--el', '#cible', '--json'])).stdout);
    assert.deepEqual([el.width, el.height], [200, 100]);
    const refs = await runCli(env, ['screenshot', '--refs']);
    assert.equal(refs.code, 0, `--refs autorisé alors que allowEval=false : ${refs.stderr}`);

    const out = join(t.root, 'vue.webp');
    const o = await runCli(env, ['screenshot', '-o', out]);
    assert.deepEqual([o.code, o.stdout], [0, 'OK\n'], o.stderr);
    assert.equal(readFileSync(out).subarray(8, 12).toString(), 'WEBP', 'format déduit de l\'extension');
    const oj = JSON.parse((await runCli(env, ['screenshot', '-o', out, '--format', 'png', '--json'])).stdout);
    assert.deepEqual([oj.path, oj.format, oj.bytes], [out, 'png', statSync(out).size]);
    const raw = await runCli(env, ['screenshot', '-o', '-']);
    assert.equal(raw.raw.subarray(1, 4).toString(), 'PNG', 'binaire sur stdout avec -o -');

    const bad = await runCli(env, ['screenshot', '--format', 'gif']);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /^ERROR: screenshot: .*format/m);
  } finally { srv.proc.kill('SIGTERM'); await waitExit(srv.proc); await site.close(); t.cleanup(); }
});

test('CLI --shot-on-error : l\'échec d\'une action (ou de nav) joint le chemin d\'une capture au message d\'erreur', async () => {
  const t = makeTestEnv();
  const site = await startTestSite();
  const srv = await startServer(t.env);
  try {
    await runCli(t.env, ['session', 'create']);
    await runCli(t.env, ['nav', `${site.url}/`]);
    const r = await runCli(t.env, ['click', '#absent', '--shot-on-error']);
    assert.equal(r.code, 1);
    assert.equal(r.stdout, '');
    const m = /^ERROR: click: aucun élément ne correspond à #absent \(capture : (\/\S+\.png)\)\n$/.exec(r.stderr);
    assert.ok(m, r.stderr);
    assert.equal(statSync(m[1]!).mode & 0o777, 0o600);
    const n = await runCli(t.env, ['nav', 'https://example.com/', '--shot-on-error']);
    assert.match(n.stderr, /^ERROR: nav: navigation bloquée.*\(capture : \/\S+\.png\)$/m);
    for (const cmd of [['fill', '#absent', 'x'], ['select', '#absent', 'x'], ['check', '#absent'], ['press', 'Enter', '#absent']]) {
      const x = await runCli(t.env, [...cmd, '--shot-on-error']);
      assert.match(x.stderr, /\(capture : \/\S+\.png\)$/m, `${cmd[0]} : ${x.stderr}`);
    }
    const plain = await runCli(t.env, ['click', '#absent']);
    assert.doesNotMatch(plain.stderr, /capture/, 'pas de capture sans --shot-on-error');
  } finally { srv.proc.kill('SIGTERM'); await waitExit(srv.proc); await site.close(); t.cleanup(); }
});

test('CLI console : une ligne par entrée, seq courant sur stderr, --since/--level/--limit/--json/--clear, --console sur les actions', async () => {
  const t = makeTestEnv();
  const site = await startTestSite();
  const paths = resolvePaths(t.env, t.env.HOME);
  mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
  writeFileSync(paths.configFile, JSON.stringify({ allowedDomains: ['127.0.0.1'] }), { mode: 0o600 });
  const srv = await startServer(t.env);
  try {
    await runCli(t.env, ['session', 'create']);
    const nav = await runCli(t.env, ['nav', `${site.url}/console`, '--console']);
    assert.equal(nav.code, 0, nav.stderr);
    assert.match(nav.stdout, /^OK\n#\d+ navigation → http:\/\/127\.0\.0\.1:\d+\/console\n/);
    await sleep(500);
    const c = await runCli(t.env, ['console']);
    assert.equal(c.code, 0, c.stderr);
    const lines = c.stdout.trim().split('\n');
    for (const l of lines) assert.match(l, /^#\d+ (navigation → |(error|warn |info |debug) \S+ )/, l);
    assert.ok(lines.some((l) => /^#\d+ error console erreur objet \{code: 42, detail: "champ manquant", nested: \{…\}\} \(console:\d+\)$/.test(l)), c.stdout);
    assert.ok(lines.some((l) => /^#\d+ error network GET http:\/\/127\.0\.0\.1:\d+\/absent\.png → 404/.test(l)), c.stdout);
    const seq = Number(/seq courant : (\d+)/.exec(c.stderr)?.[1]);
    assert.ok(seq > 0, c.stderr);
    assert.match(c.stderr, new RegExp(`grasp console --since ${seq}`));

    assert.equal((await runCli(t.env, ['console', '--since', String(seq)])).stdout, '');
    const click = await runCli(t.env, ['click', '#spam', '--console', '--snap-diff']);
    assert.match(click.stdout, /#\d+ warn  console répété \(console:\d+\) ×5$/m);
    const since = await runCli(t.env, ['console', '--since', String(seq)]);
    assert.match(since.stdout, /^#\d+ warn  console répété .*×5\n$/);
    const errs = (await runCli(t.env, ['console', '--level', 'error'])).stdout.trim().split('\n');
    assert.ok(errs.every((l) => / error |navigation →/.test(l)), errs.join('\n'));
    assert.equal((await runCli(t.env, ['console', '--limit', '2'])).stdout.trim().split('\n').length, 2);
    const js = JSON.parse((await runCli(t.env, ['console', '--json', '--limit', '1'])).stdout);
    assert.equal(js.entries.length, 1);
    assert.equal(typeof js.seq, 'number');
    const quiet = await runCli(t.env, ['click', '#log', '--console', '--json']);
    assert.deepEqual(JSON.parse(quiet.stdout).console.entries.map((e: { text: string }) => e.text), ['clic 42']);
    const cl = await runCli(t.env, ['console', '--clear']);
    assert.ok(cl.stdout.length > 0);
    assert.equal((await runCli(t.env, ['console'])).stdout, '');
    assert.match((await runCli(t.env, ['console', '--level', 'fatal'])).stderr, /^ERROR: console: .*niveau/m);
    // échec + --console : les entrées produites pendant l'action suivent l'erreur, sur stderr
    const fail = await runCli(t.env, ['click', '#absent', '--console']);
    assert.match(fail.stderr, /^ERROR: click: /);
  } finally { srv.proc.kill('SIGTERM'); await waitExit(srv.proc); await site.close(); t.cleanup(); }
});

test('CLI : allowConsole=false → console refusée (403) et signalée par `grasp security`', async () => {
  const t = makeTestEnv();
  const paths = resolvePaths(t.env, t.env.HOME);
  mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
  writeFileSync(paths.configFile, JSON.stringify({ allowConsole: false }), { mode: 0o600 });
  const srv = await startServer(t.env);
  try {
    await runCli(t.env, ['session', 'create']);
    const r = await runCli(t.env, ['console']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^ERROR: console: .*allowConsole/m);
    assert.match((await runCli(t.env, ['security'])).stdout, /console\s*: désactivé/);
    assert.equal((await srv.api('GET', '/console')).status, 403);
  } finally { srv.proc.kill('SIGTERM'); await waitExit(srv.proc); t.cleanup(); }
  const t2 = makeTestEnv();
  const srv2 = await startServer(t2.env);
  try {
    assert.match((await runCli(t2.env, ['security'])).stdout, /console\s*: AUTORISÉ/, 'défaut : lecture console autorisée');
  } finally { srv2.proc.kill('SIGTERM'); await waitExit(srv2.proc); t2.cleanup(); }
});

test('captures : rotation sous l\'état de Grasp (au-delà de 50, les plus anciennes partent)', async () => {
  const t = makeTestEnv();
  const site = await startTestSite();
  const srv = await startServer(t.env);
  try {
    await runCli(t.env, ['session', 'create']);
    await runCli(t.env, ['nav', `${site.url}/`]);
    const first = (await runCli(t.env, ['screenshot', '--max-width', '50'])).stdout.trim();
    for (let i = 0; i < 51; i++) assert.equal((await srv.api('GET', '/screenshot?save=1&maxWidth=50')).status, 200);
    assert.equal(existsSync(first), false, 'la plus ancienne a été supprimée');
    const { readdirSync } = await import('node:fs');
    assert.equal(readdirSync(dirname(first)).length, 50);
  } finally { srv.proc.kill('SIGTERM'); await waitExit(srv.proc); await site.close(); t.cleanup(); }
});

test('CLI : --since/--limit invalides → erreur (jamais tout le tampon) ; -o en 0600 même sur un fichier existant ou un lien ; --console signale les lignes écartées', async () => {
  const t = makeTestEnv();
  const site = await startTestSite();
  const srv = await startServer(t.env);
  try {
    await runCli(t.env, ['session', 'create']);
    assert.equal((await runCli(t.env, ['nav', `${site.url}/bavard`])).code, 0);
    for (const args of [['--since', 'abc'], ['--since', 'e12'], ['--limit', 'dix'], ['--limit', '-3'], ['--since', '']]) {
      const r = await runCli(t.env, ['console', ...args]);
      assert.equal(r.code, 1, `${args.join(' ')} accepté : ${r.stdout}`);
      assert.match(r.stderr, new RegExp(`^ERROR: console: .*${args[0]!.slice(2)}`, 'm'), r.stderr);
      assert.equal(r.stdout, '');
    }
    const ahead = await runCli(t.env, ['console', '--since', '999999']);
    assert.equal(ahead.code, 1);
    assert.match(ahead.stderr, /^ERROR: console: .*--since 0/m);

    const flot = await runCli(t.env, ['click', '#flot', '--console']);
    assert.equal(flot.code, 0, flot.stderr);
    assert.equal(flot.stdout.trim().split('\n').length, 201, 'OK + 200 lignes');
    const since = Number(/--since (\d+)/.exec(flot.stderr)?.[1]);
    assert.match(flot.stderr, /AVERTISSEMENT : 50 ligne\(s\) console plus ancienne\(s\) non jointe\(s\)/);
    assert.ok(Number.isInteger(since), flot.stderr);
    const rest = await runCli(t.env, ['console', '--since', String(since), '--limit', '1000']);
    assert.match(rest.stdout, /erreur n°0\b/, 'la commande proposée relit les lignes écartées');

    const file = join(t.root, 'shot.png');
    writeFileSync(file, 'ancien', { mode: 0o644 });
    chmodSync(file, 0o644);
    assert.equal((await runCli(t.env, ['screenshot', '-o', file])).code, 0);
    assert.equal(statSync(file).mode & 0o777, 0o600, 'fichier existant : mode 0600 imposé');
    assert.equal(readFileSync(file).subarray(1, 4).toString(), 'PNG');
    const victim = join(t.root, 'victime');
    writeFileSync(victim, 'intact', { mode: 0o644 });
    const link = join(t.root, 'lien.png');
    symlinkSync(victim, link);
    assert.equal((await runCli(t.env, ['screenshot', '-o', link])).code, 0);
    assert.equal(readFileSync(victim, 'utf8'), 'intact', 'le lien n\'est pas suivi');
    assert.equal(lstatSync(link).isSymbolicLink(), false);
    assert.equal(statSync(link).mode & 0o777, 0o600);
    const pdf = join(t.root, 'page.pdf');
    writeFileSync(pdf, 'ancien', { mode: 0o644 });
    assert.equal((await runCli(t.env, ['pdf', '-o', pdf])).code, 0);
    assert.equal(statSync(pdf).mode & 0o777, 0o600, 'pdf -o : 0600 aussi');
    const nowhere = await runCli(t.env, ['screenshot', '-o', join(t.root, 'absent', 'x.png')]);
    assert.equal(nowhere.code, 1);
    assert.match(nowhere.stderr, /^ERROR: screenshot: .*absent\/x\.png/m);
  } finally { srv.proc.kill('SIGTERM'); await waitExit(srv.proc); await site.close(); t.cleanup(); }
});
