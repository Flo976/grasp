import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeTestEnv } from '../helpers/env.js';
import { startServer, runCli, waitExit, CLI } from '../helpers/server.js';
import { startTestSite } from '../helpers/testsite.js';
import { unitContent } from '../../src/cli/daemon.js';
import { resolvePaths } from '../../src/core/paths.js';

test('hygiène : `export S=$(grasp session create)` capture uniquement l\'identifiant', async () => {
  const t = makeTestEnv();
  const srv = await startServer(t.env);
  try {
    const out = execFileSync('bash', ['-c', `export S=$(${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} session create 2>/dev/null) && printf '%s' "$S"`], { env: t.env, encoding: 'utf8' });
    assert.match(out, /^s[0-9a-f]{12}$/, `stdout pollué : ${JSON.stringify(out)}`);
    const r = await runCli(t.env, ['session', 'create']);
    assert.match(r.stdout, /^s[0-9a-f]{12}\n$/);
    assert.match(r.stderr, /export GRASP_SESSION=/, 'le conseil part sur stderr');
  } finally { srv.proc.kill('SIGTERM'); await waitExit(srv.proc); t.cleanup(); }
});

test('hygiène : OK sur stdout, ERROR: <cmd>: <raison> sur stderr, code non nul, --json', async () => {
  const t = makeTestEnv();
  const site = await startTestSite();
  const srv = await startServer(t.env);
  try {
    const id = (await runCli(t.env, ['session', 'create'])).stdout.trim();
    const env = { ...t.env, GRASP_SESSION: id };
    const nav = await runCli(env, ['nav', `${site.url}/`]);
    assert.deepEqual([nav.code, nav.stdout, nav.stderr], [0, 'OK\n', '']);
    const fill = await runCli(env, ['fill', '#nom', 'Ada']);
    assert.equal(fill.stdout, 'OK\n');
    const bad = await runCli(env, ['click', '#absent']);
    assert.equal(bad.code, 1);
    assert.equal(bad.stdout, '');
    assert.match(bad.stderr, /^ERROR: click: aucun élément ne correspond à #absent\n$/);
    const js = await runCli(env, ['check', '#cgu', '--json', '--snap-diff']);
    assert.match(JSON.parse(js.stdout).diff, /checkbox "J'accepte les conditions" \[x\]/);
    const unknown = await runCli(env, ['frobnicate']);
    assert.match(unknown.stderr, /^ERROR: frobnicate: commande inconnue/);
    const png = join(t.root, 'p.png');
    assert.equal((await runCli(env, ['screenshot', '-o', png])).stdout, 'OK\n');
    assert.equal(readFileSync(png).subarray(1, 4).toString(), 'PNG');
    const pdf = join(t.root, 'p.pdf');
    await runCli(env, ['pdf', '-o', pdf]);
    assert.equal(readFileSync(pdf).subarray(0, 4).toString(), '%PDF');
  } finally { srv.proc.kill('SIGTERM'); await waitExit(srv.proc); await site.close(); t.cleanup(); }
});

test('session : plusieurs sessions → --session obligatoire ; close libère la session', async () => {
  const t = makeTestEnv();
  const srv = await startServer(t.env);
  try {
    const a = (await runCli(t.env, ['session', 'create'])).stdout.trim();
    const b = (await runCli(t.env, ['session', 'create'])).stdout.trim();
    const amb = await runCli(t.env, ['snap']);
    assert.match(amb.stderr, /précisez --session/);
    assert.equal((await runCli(t.env, ['snap', '--session', a])).code, 0);
    assert.equal((await runCli(t.env, ['session', 'close', b])).stdout, 'OK\n');
    assert.equal((await runCli(t.env, ['snap'])).code, 0, 'une seule session : implicite');
    const list = JSON.parse((await runCli(t.env, ['session', 'list', '--json'])).stdout);
    assert.deepEqual(list.map((s: { id: string }) => s.id), [a]);
  } finally { srv.proc.kill('SIGTERM'); await waitExit(srv.proc); t.cleanup(); }
});

test('daemon : unité systemd user (Type=simple, Restart=on-failure, KillMode=control-group)', () => {
  const u = unitContent('/usr/bin/node', '/opt/grasp/dist/src/cli/main.js', { PATH: '/usr/bin' });
  assert.match(u, /^Type=simple$/m);
  assert.match(u, /^Restart=on-failure$/m);
  assert.match(u, /^KillMode=control-group$/m);
  assert.match(u, /^ExecStart="\/usr\/bin\/node" "\/opt\/grasp\/dist\/src\/cli\/main\.js" serve$/m);
  assert.match(u, /^WantedBy=default\.target$/m);
});

test('daemon install : écrit ~/.config/systemd/user/grasp.service et appelle systemctl --user', async () => {
  const t = makeTestEnv();
  try {
    const log = join(t.root, 'systemctl.log');
    const fake = join(t.root, 'systemctl');
    writeFileSync(fake, `#!/bin/sh\necho "$@" >> ${log}\nexit 0\n`);
    chmodSync(fake, 0o755);
    const r = await runCli({ ...t.env, GRASP_SYSTEMCTL: fake }, ['daemon', 'install']);
    assert.equal(r.code, 0, r.stderr);
    const unit = join(resolvePaths(t.env, t.env.HOME).systemdUserDir, 'grasp.service');
    assert.equal(unit, join(t.env.XDG_CONFIG_HOME!, 'systemd/user/grasp.service'));
    assert.match(readFileSync(unit, 'utf8'), /serve$/m);
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), ['--user show-environment', '--user daemon-reload', '--user enable --now grasp.service']);
  } finally { t.cleanup(); }
});

test('daemon install sans systemd (conteneur) : refus explicite qui propose le premier plan, rien d\'écrit', async () => {
  const t = makeTestEnv();
  try {
    const r = await runCli({ ...t.env, GRASP_SYSTEMCTL: join(t.root, 'absent') }, ['daemon', 'install']);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /grasp serve/);
    assert.equal(existsSync(join(resolvePaths(t.env, t.env.HOME).systemdUserDir, 'grasp.service')), false);
  } finally { t.cleanup(); }
});

test('doctor : diagnostic réel, y compris un démarrage effectif de Chrome', async () => {
  const t = makeTestEnv();
  try {
    const r = await runCli(t.env, ['doctor', '--json']);
    const checks = JSON.parse(r.stdout) as Array<{ name: string; level: string; detail: string }>;
    const byName = new Map(checks.map((c) => [c.name, c]));
    assert.equal(byName.get('démarrage')?.level, 'ok', JSON.stringify(checks, null, 1));
    assert.equal(byName.get('version')?.level, 'ok');
    assert.ok(byName.has('/dev/shm') && byName.has('systemd') && byName.has('sandbox'));
    assert.doesNotMatch(r.stdout, /non implémenté/);
  } finally { t.cleanup(); }
});

test('doctor : GRASP_CHROME invalide → FAIL explicite, code non nul', async () => {
  const t = makeTestEnv({ GRASP_CHROME: '/nonexistent/chrome' });
  try {
    const r = await runCli(t.env, ['doctor']);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /FAIL\s+navigateur\s+GRASP_CHROME=\/nonexistent\/chrome/);
  } finally { t.cleanup(); }
});

test('--no-sandbox : jamais ajouté pour un utilisateur non-root, même avec GRASP_ALLOW_NO_SANDBOX=1', async () => {
  // On ne peut pas devenir root dans les tests : la logique est couverte en unitaire (chrome-args).
  // Ici on vérifie qu'aucun chemin de démarrage n'ajoute --no-sandbox pour un utilisateur normal.
  const t = makeTestEnv({ GRASP_ALLOW_NO_SANDBOX: '1' });
  const srv = await startServer(t.env);
  try {
    const list0 = await srv.api('POST', '/sessions', {});
    assert.equal(list0.status, 201);
    const s = (await srv.api('GET', '/sessions')).json()[0];
    // Chrome réécrit son argv en une seule chaîne : on découpe sur \0 et sur les espaces.
    const cmdline = readFileSync(`/proc/${s.chromePid}/cmdline`, 'utf8').split(/[\0 ]/);
    assert.ok(!cmdline.includes('--no-sandbox'), 'uid non-root : --no-sandbox ne doit jamais être ajouté');
    assert.ok(cmdline.includes('--headless=new'));
  } finally { srv.proc.kill('SIGTERM'); await waitExit(srv.proc); t.cleanup(); }
});

test('session close sans id : ferme l\'unique session ; refus explicite s\'il y en a plusieurs ou aucune', async () => {
  const t = makeTestEnv();
  const srv = await startServer(t.env);
  try {
    const none = await runCli(t.env, ['session', 'close']);
    assert.notEqual(none.code, 0);
    assert.match(none.stderr, /^ERROR: session: aucune session/m);
    const a = (await runCli(t.env, ['session', 'create'])).stdout.trim();
    const b = (await runCli(t.env, ['session', 'create'])).stdout.trim();
    const amb = await runCli(t.env, ['session', 'close']);
    assert.notEqual(amb.code, 0);
    assert.match(amb.stderr, /précisez/);
    assert.equal((await runCli(t.env, ['session', 'close', b])).stdout, 'OK\n');
    const r = await runCli(t.env, ['session', 'close']);
    assert.deepEqual([r.code, r.stdout], [0, 'OK\n'], r.stderr);
    assert.match(r.stderr, new RegExp(a), 'la session fermée est nommée sur stderr');
    assert.deepEqual((await srv.api('GET', '/sessions')).json(), []);
  } finally { srv.proc.kill('SIGTERM'); await waitExit(srv.proc); t.cleanup(); }
});
