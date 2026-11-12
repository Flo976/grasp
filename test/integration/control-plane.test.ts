import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync, chmodSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
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

test('control plane : --listen hors boucle locale = opt-in explicite, token exigé, signalé par grasp security', async () => {
  const t = makeTestEnv();
  // Refus : --listen sans --tcp, et nom d'hôte au lieu d'une IP littérale.
  const noTcp = await runCli(t.env, ['serve', '--listen', '0.0.0.0']);
  assert.notEqual(noTcp.code, 0);
  assert.match(noTcp.stderr, /--listen exige --tcp/);
  const name = await runCli(t.env, ['serve', '--tcp', '--port', '0', '--listen', 'localhost']);
  assert.notEqual(name.code, 0);
  assert.match(name.stderr, /IP littérale/);

  const srv = await startServer(t.env, ['--tcp', '--port', '0', '--listen', '0.0.0.0']);
  try {
    assert.match(srv.stderr(), /AVERTISSEMENT : control plane exposé hors boucle locale sur 0\.0\.0\.0:\d+/);
    const ep = JSON.parse(readFileSync(srv.paths.endpointFile, 'utf8'));
    assert.equal(ep.host, '127.0.0.1', 'endpoint.json : adresse où se connecter, pas le joker');
    assert.equal((await request(ep, 'GET', '/sessions')).status, 401, 'token exigé');
    const sec = await runCli(t.env, ['security', '--json']);
    assert.equal(sec.code, 0, sec.stderr);
    assert.deepEqual(JSON.parse(sec.stdout).listen, { host: '0.0.0.0', port: ep.port, exposed: true });
    const txt = await runCli(t.env, ['security']);
    assert.ok(txt.stdout.includes(`transport  : tcp 0.0.0.0:${ep.port} — EXPOSÉ hors boucle locale`), txt.stdout);
    // Client désigné par GRASP_URL, sans endpoint.json (cas de l'hôte face à un conteneur publié).
    const other = makeTestEnv();
    try {
      const cfg = join(other.env.XDG_CONFIG_HOME!, 'grasp');
      mkdirSync(cfg, { recursive: true, mode: 0o700 });
      writeFileSync(join(cfg, 'token'), srv.token(), { mode: 0o600 });
      const st = await runCli({ ...other.env, GRASP_URL: `http://127.0.0.1:${ep.port}` }, ['status']);
      assert.equal(st.code, 0, st.stderr);
      assert.match(st.stdout, /en cours/);
      const bad = await runCli({ ...other.env, GRASP_URL: `http://127.0.0.1:${ep.port}/x` }, ['status']);
      assert.notEqual(bad.code, 0);
      assert.match(bad.stderr, /GRASP_URL/);
    } finally { other.cleanup(); }
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

test('control plane : XDG_RUNTIME_DIR trop long → repli /tmp/grasp-<uid>/<hash> (0700), client et serveur d\'accord, bridges compris', async () => {
  const t = makeTestEnv();
  const site = await startTestSite();
  const long = join(t.root, 'r'.repeat(110));
  const env: NodeJS.ProcessEnv = { ...t.env, XDG_RUNTIME_DIR: long };
  const paths = resolvePaths(env, env.HOME);
  assert.ok(paths.socketFallback !== undefined);
  const srv = await startServer(env);
  try {
    assert.match(srv.stderr(), /chemin de socket trop long .*sockets dans \/tmp\/grasp-\d+\/[0-9a-f]{12}/);
    assert.doesNotMatch(srv.stderr(), /EADDRINUSE/);
    assert.equal(statSync(paths.socketFallback.dir).mode & 0o777, 0o700);
    assert.equal(statSync(paths.socketPath).mode & 0o777, 0o600);
    // Le client (même calcul) joint le serveur, et une session (socket de bridge sous le repli) fonctionne.
    const sess = await runCli(env, ['session', 'create']);
    assert.equal(sess.code, 0, sess.stderr);
    const nav = await runCli(env, ['nav', `${site.url}/`]);
    assert.equal(nav.code, 0, nav.stderr);
    // Répertoire de repli rendu trop ouvert : le client refuse d'y envoyer le token.
    chmodSync(paths.socketFallback.dir, 0o755);
    const st = await runCli(env, ['snap']);
    assert.notEqual(st.code, 0);
    assert.match(st.stderr, /repli des sockets refusé.*0755/);
    chmodSync(paths.socketFallback.dir, 0o700);
  } finally {
    await runCli(env, ['stop']);
    await waitExit(srv.proc);
    await site.close();
    rmSync(paths.socketFallback.dir, { recursive: true, force: true });
    t.cleanup();
  }
});
