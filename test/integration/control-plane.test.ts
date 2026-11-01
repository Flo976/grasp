import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync, chmodSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTestEnv } from '../helpers/env.js';
import { startServer, runCli, waitExit } from '../helpers/server.js';
import { startTestSite } from '../helpers/testsite.js';
import { listProcs, waitUntil, isAlive, descendants } from '../helpers/procs.js';
import { resolvePaths } from '../../src/core/paths.js';
import { request } from '../../src/core/http.js';

test('control plane : socket Unix 0600, token exigé, session de bout en bout, SIGTERM propre', async () => {
  const t = makeTestEnv();
  const site = await startTestSite();
  const srv = await startServer(t.env);
  try {
    const { paths } = srv;
    assert.ok(existsSync(paths.socketPath));
    assert.equal(statSync(paths.socketPath).mode & 0o777, 0o600, 'socket en 0600');
    assert.equal(statSync(paths.tokenFile).mode & 0o777, 0o600, 'token en 0600');
    assert.equal(statSync(paths.configDir).mode & 0o777, 0o700, 'config en 0700');
    assert.equal(statSync(paths.dataDir).mode & 0o777, 0o700, 'données en 0700');

    const anon = await request({ transport: 'unix', socketPath: paths.socketPath }, 'GET', '/sessions');
    assert.equal(anon.status, 401, 'sans token : 401');
    const bad = await srv.api('GET', '/sessions', undefined, { authorization: 'Bearer faux' });
    assert.equal(bad.status, 401);

    const none = await srv.api('GET', '/snap');
    assert.equal(none.status, 409, 'aucune session : 409 explicite');

    const created = await srv.api('POST', '/sessions', {});
    assert.equal(created.status, 201);
    const id = created.json().id as string;
    const nav = await srv.api('POST', '/navigate', { url: `${site.url}/` }, { 'x-grasp-session': id });
    assert.equal(nav.status, 200, nav.text());
    const snap = await srv.api('GET', '/snap');
    assert.match(snap.text(), /textbox "Nom"/);

    const list = (await srv.api('GET', '/sessions')).json();
    assert.equal(list.length, 1);
    const chromePid = list[0].chromePid as number;
    const tree = [chromePid, ...descendants(chromePid)];

    srv.proc.kill('SIGTERM');
    assert.equal(await waitExit(srv.proc), 0, `sortie non nulle :\n${srv.stderr()}`);
    assert.equal(existsSync(paths.socketPath), false, 'socket non retiré');
    assert.equal(existsSync(paths.pidFile), false, 'fichier PID non retiré');
    assert.ok(tree.every((p) => !isAlive(p)), 'processus Chrome survivants');
  } finally {
    srv.proc.kill('SIGKILL');
    await site.close();
    t.cleanup();
  }
});

test('control plane : refuse de démarrer si le token est en 0644 (on refuse, on n\'avertit pas)', async () => {
  const t = makeTestEnv();
  try {
    const paths = resolvePaths(t.env, t.env.HOME);
    mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
    writeFileSync(paths.tokenFile, 'a'.repeat(64), { mode: 0o600 });
    chmodSync(paths.tokenFile, 0o644);
    const r = await runCli(t.env, ['serve']);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /^ERROR: serve: permissions trop ouvertes/m);
    assert.match(r.stderr, /chmod 600 .*token/);
    assert.equal(existsSync(paths.socketPath), false);
  } finally { t.cleanup(); }
});

test('control plane : refuse de démarrer si le répertoire de config est en 0755', async () => {
  const t = makeTestEnv();
  try {
    const paths = resolvePaths(t.env, t.env.HOME);
    mkdirSync(paths.configDir, { recursive: true, mode: 0o755 });
    chmodSync(paths.configDir, 0o755);
    const r = await runCli(t.env, ['serve']);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /chmod 700 .*grasp/);
  } finally { t.cleanup(); }
});

test('control plane : refuse de démarrer sur une config invalide (pas de repli sur les défauts)', async () => {
  const t = makeTestEnv();
  try {
    const paths = resolvePaths(t.env, t.env.HOME);
    mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
    writeFileSync(paths.configFile, '{"allowedDomain": ["x"]}', { mode: 0o600 });
    const r = await runCli(t.env, ['serve']);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /clé inconnue « allowedDomain »/);
  } finally { t.cleanup(); }
});

test('control plane : TCP sur 127.0.0.1 uniquement, token exigé', async () => {
  const t = makeTestEnv();
  const srv = await startServer(t.env, ['--tcp', '--port', '0']);
  try {
    const ep = JSON.parse(readFileSync(srv.paths.endpointFile, 'utf8'));
    assert.equal(ep.transport, 'tcp');
    assert.equal(ep.host, '127.0.0.1');
    const anon = await request(ep, 'GET', '/sessions');
    assert.equal(anon.status, 401);
    assert.equal((await srv.api('GET', '/sessions')).status, 200);
    assert.equal(existsSync(srv.paths.socketPath), false, 'pas de socket Unix en mode TCP');
  } finally {
    srv.proc.kill('SIGTERM');
    await waitExit(srv.proc);
    t.cleanup();
  }
});

test('control plane : un second serve refuse de démarrer tant que le premier tourne', async () => {
  const t = makeTestEnv();
  const srv = await startServer(t.env);
  try {
    const r = await runCli(t.env, ['serve']);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /déjà/);
    assert.equal((await srv.api('GET', '/health')).status, 200, 'le premier serveur doit rester intact');
  } finally {
    srv.proc.kill('SIGTERM');
    await waitExit(srv.proc);
    t.cleanup();
  }
});

test('stop : rend la main seulement quand le socket est fermé ; tue et signale si SIGTERM ne suffit pas', async () => {
  const t = makeTestEnv();
  const srv = await startServer(t.env);
  try {
    const r = await runCli(t.env, ['stop']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'OK');
    assert.equal(existsSync(srv.paths.socketPath), false, 'stop a rendu la main avant la fermeture du socket');
    assert.equal(await waitExit(srv.proc, 1000), 0);
  } finally { srv.proc.kill('SIGKILL'); t.cleanup(); }

  // Serveur qui ignore SIGTERM : stop doit le tuer et le signaler, jamais abandonner en silence.
  const t2 = makeTestEnv({ GRASP_TEST_IGNORE_SIGTERM: '1', GRASP_STOP_TIMEOUT_MS: '1500' });
  const srv2 = await startServer(t2.env);
  try {
    const r = await runCli(t2.env, ['stop']);
    assert.notEqual(r.code, 0, 'un arrêt forcé doit être signalé par un code non nul');
    assert.match(r.stderr, /SIGKILL/);
    assert.ok(await waitUntil(() => !isAlive(srv2.proc.pid!), 3000), 'le serveur doit être mort');
    assert.equal(existsSync(srv2.paths.socketPath), false, 'socket résiduel non nettoyé');
  } finally { srv2.proc.kill('SIGKILL'); t2.cleanup(); }
});

test('stop : sans serveur → erreur explicite', async () => {
  const t = makeTestEnv();
  try {
    const r = await runCli(t.env, ['stop']);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /^ERROR: stop: /m);
  } finally { t.cleanup(); }
});

test('control plane : SIGKILL du serveur → les bridges et Chrome meurent avec lui', async () => {
  const t = makeTestEnv();
  const srv = await startServer(t.env);
  try {
    await srv.api('POST', '/sessions', {});
    const list = (await srv.api('GET', '/sessions')).json();
    const chromePid = list[0].chromePid as number;
    const bridgePid = list[0].bridgePid as number;
    const tree = [bridgePid, chromePid, ...descendants(chromePid)];
    srv.proc.kill('SIGKILL');
    const gone = await waitUntil(() => tree.every((p) => !isAlive(p)), 10_000);
    assert.ok(gone, `survivants : ${tree.filter(isAlive).join(', ')} (${listProcs().length} procs)`);
  } finally { t.cleanup(); }
});

test('control plane : XDG_RUNTIME_DIR trop long → refus explicite au démarrage, pas « listen EADDRINUSE »', async () => {
  const t = makeTestEnv();
  try {
    const long = join(t.root, 'r'.repeat(110));
    const r = await runCli({ ...t.env, XDG_RUNTIME_DIR: long }, ['serve']);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /^ERROR: serve: .*107 octets/m);
    assert.match(r.stderr, /XDG_RUNTIME_DIR/);
    assert.doesNotMatch(r.stderr, /EADDRINUSE/);
    // Socket du control plane assez court, mais ceux des bridges non : refus aussi, avant toute session.
    const mid = join(t.root, 'm'.repeat(Math.max(1, 85 - t.root.length)));
    const r2 = await runCli({ ...t.env, XDG_RUNTIME_DIR: mid }, ['serve']);
    assert.notEqual(r2.code, 0, r2.stderr);
    assert.match(r2.stderr, /bridge.*107 octets|107 octets.*bridge/s);
  } finally { t.cleanup(); }
});
