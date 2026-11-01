import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTestEnv } from '../helpers/env.js';
import { startServer, runCli, waitExit } from '../helpers/server.js';
import { startTestSite } from '../helpers/testsite.js';
import { resolvePaths } from '../../src/core/paths.js';
import { profileId } from '../../src/core/profiles.js';
import { isAlive } from '../helpers/procs.js';

function writeConfig(env: NodeJS.ProcessEnv, cfg: object): void {
  const paths = resolvePaths(env, env.HOME);
  mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
  writeFileSync(paths.configFile, JSON.stringify(cfg), { mode: 0o600 });
}

/** Ligne de commande du processus Chrome (argv réécrit en une chaîne : on garde le brut). */
const cmdline = (pid: number) => readFileSync(`/proc/${pid}/cmdline`, 'utf8');

test('profils : CRUD (CLI + --json), profil courant marqué *, suppression refusée tant qu\'il est utilisé', async () => {
  const t = makeTestEnv();
  const srv = await startServer(t.env);
  try {
    const c = await runCli(t.env, ['profiles', 'create', 'florent', '--use-when', 'comptes perso']);
    assert.deepEqual([c.code, c.stdout], [0, 'OK\n'], c.stderr);
    assert.equal((await runCli(t.env, ['profiles', 'create', 'florent'])).code, 1, 'doublon refusé');
    const bad = await runCli(t.env, ['profiles', 'create', 'pas bon']);
    assert.match(bad.stderr, /^ERROR: profiles: .*nom de profil invalide/m);
    await runCli(t.env, ['profiles', 'create', 'sooatek']);

    const list = JSON.parse((await runCli(t.env, ['profiles', '--json'])).stdout) as { profiles: Array<Record<string, unknown>>; current: string | null };
    assert.deepEqual(list.profiles.map((p) => [p.name, p.id, p.running, p.useWhen ?? null]), [
      ['florent', profileId('florent'), false, 'comptes perso'],
      ['sooatek', profileId('sooatek'), false, null],
    ]);
    assert.equal(list.current, null);

    const id = (await runCli(t.env, ['session', 'create', '--profile', 'florent'])).stdout.trim();
    assert.match(id, /^s[0-9a-f]{12}$/);
    const txt = (await runCli(t.env, ['profiles'])).stdout;
    assert.match(txt, /^\* florent\b.*session/m, txt);
    assert.match(txt, /^ {2}sooatek\b/m);
    const used = JSON.parse((await runCli(t.env, ['profiles', '--json'])).stdout).profiles.find((p: { name: string }) => p.name === 'florent');
    assert.equal(used.running, true);
    assert.equal(used.session, id);
    assert.ok(used.lastUsedAt !== null, 'lastUsedAt mis à jour au démarrage');

    const rm = await runCli(t.env, ['profiles', 'rm', 'florent']);
    assert.notEqual(rm.code, 0);
    assert.match(rm.stderr, /^ERROR: profiles: .*utilisé par la session/m);
    assert.equal((await srv.api('DELETE', '/profiles/florent')).status, 409);
    const twice = await runCli(t.env, ['session', 'create', '--profile', 'florent']);
    assert.match(twice.stderr, /déjà utilisé/);

    assert.equal((await runCli(t.env, ['profiles', 'rm', 'sooatek'])).stdout, 'OK\n');
    assert.equal((await runCli(t.env, ['profiles', 'rm', 'sooatek'])).code, 1, 'profil inconnu : 404');
    assert.equal((await srv.api('GET', '/profiles', undefined, { authorization: 'Bearer faux' })).status, 401, 'protégé par le token');
  } finally { srv.proc.kill('SIGTERM'); await waitExit(srv.proc); t.cleanup(); }
});

test('profils : session create --profile <inconnu> crée le profil à la volée (conseil sur stderr)', async () => {
  const t = makeTestEnv();
  const srv = await startServer(t.env);
  try {
    const r = await runCli(t.env, ['session', 'create', '--profile', 'nouveau']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^s[0-9a-f]{12}\n$/, 'stdout = identifiant seul');
    assert.match(r.stderr, /profil « nouveau » créé/);
    const s = (await srv.api('GET', '/sessions')).json()[0];
    assert.ok(cmdline(s.chromePid).includes(join(srv.paths.profilesDir, profileId('nouveau'))), 'Chrome tourne sur le --user-data-dir du profil');
    assert.ok(existsSync(join(srv.paths.profilesDir, profileId('nouveau'), 'profile.json')));
  } finally { srv.proc.kill('SIGTERM'); await waitExit(srv.proc); t.cleanup(); }
});

test('profils : `grasp profile <nom>` relance la session sur un autre --user-data-dir en gardant son id (cookies isolés)', async () => {
  const t = makeTestEnv();
  const site = await startTestSite();
  writeConfig(t.env, { allowEval: true, allowedDomains: ['127.0.0.1'] });
  const srv = await startServer(t.env);
  try {
    await runCli(t.env, ['profiles', 'create', 'florent']);
    await runCli(t.env, ['profiles', 'create', 'sooatek']);
    const id = (await runCli(t.env, ['session', 'create', '--profile', 'florent'])).stdout.trim();
    const env = { ...t.env, GRASP_SESSION: id };
    const before = (await srv.api('GET', '/sessions')).json()[0];
    await runCli(env, ['nav', `${site.url}/`]);
    await runCli(env, ['eval', "document.cookie = 'qui=florent; max-age=3600'"]);
    assert.equal(JSON.parse((await runCli(env, ['eval', 'document.cookie'])).stdout), 'qui=florent');

    const sw = await runCli(env, ['profile', 'sooatek']);
    assert.deepEqual([sw.code, sw.stdout], [0, 'OK\n'], sw.stderr);
    const after = (await srv.api('GET', '/sessions')).json();
    assert.deepEqual(after.map((s: { id: string; profile: string }) => [s.id, s.profile]), [[id, 'sooatek']], 'même id de session, nouveau profil');
    assert.notEqual(after[0].chromePid, before.chromePid, 'nouveau Chrome');
    assert.ok(!isAlive(before.chromePid), 'l\'ancien Chrome est arrêté');
    assert.ok(cmdline(after[0].chromePid).includes(join(srv.paths.profilesDir, profileId('sooatek'))));
    assert.match((await runCli(env, ['profiles'])).stdout, /^\* sooatek\b/m);

    await runCli(env, ['nav', `${site.url}/`]);
    assert.equal(JSON.parse((await runCli(env, ['eval', 'document.cookie'])).stdout), '', 'cookie de florent absent de sooatek');
    assert.match((await runCli(env, ['snap'])).stdout, /textbox "Nom"/, 'la session reste pilotable');

    // Retour sur florent : le cookie persistant est toujours là.
    assert.equal((await runCli(env, ['profile', 'florent', '--json'])).code, 0);
    await runCli(env, ['nav', `${site.url}/`]);
    assert.equal(JSON.parse((await runCli(env, ['eval', 'document.cookie'])).stdout), 'qui=florent');

    // Erreurs : profil inconnu (404, la session reste intacte), bascule vers le profil courant (sans effet).
    const unknown = await runCli(env, ['profile', 'inconnu']);
    assert.notEqual(unknown.code, 0);
    assert.match(unknown.stderr, /^ERROR: profile: .*inconnu.*profiles create/m);
    assert.equal((await runCli(env, ['nav', `${site.url}/`])).stdout, 'OK\n');
    const same = await runCli(env, ['profile', 'florent']);
    assert.equal(same.code, 0);
    assert.match(same.stderr, /déjà/);
  } finally { srv.proc.kill('SIGTERM'); await waitExit(srv.proc); await site.close(); t.cleanup(); }
});

test('profils : bascule d\'une session éphémère → répertoire temporaire supprimé', async () => {
  const t = makeTestEnv();
  const srv = await startServer(t.env);
  try {
    const id = (await runCli(t.env, ['session', 'create'])).stdout.trim();
    const tmpDir = join(srv.paths.tmpProfilesDir, id);
    assert.ok(existsSync(tmpDir));
    await runCli(t.env, ['profiles', 'create', 'p1']);
    const r = await runCli(t.env, ['profile', 'p1']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(existsSync(tmpDir), false);
    assert.deepEqual((await srv.api('GET', '/sessions')).json().map((s: { id: string; profile: string }) => [s.id, s.profile]), [[id, 'p1']]);
  } finally { srv.proc.kill('SIGTERM'); await waitExit(srv.proc); t.cleanup(); }
});

test('profils : import d\'un profil (--profile-directory) puis session dessus', async () => {
  const t = makeTestEnv();
  const srv = await startServer(t.env);
  try {
    const src = join(t.root, 'User Data');
    mkdirSync(join(src, 'Profile 9'), { recursive: true });
    writeFileSync(join(src, 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: 'eA==' }, profile: { info_cache: { 'Profile 9': { name: 'sooatek.com', user_name: 'florent@sooatek.example' } } } }));
    writeFileSync(join(src, 'Profile 9', 'Preferences'), JSON.stringify({ account_info: [{ email: 'florent@sooatek.example', full_name: 'Florent' }] }));
    writeFileSync(join(src, 'Profile 9', 'SingletonLock'), '');
    const r = await runCli(t.env, ['profiles', 'import', 'imp', src, '--profile-directory', 'Profile 9']);
    assert.deepEqual([r.code, r.stdout], [0, 'OK\n'], r.stderr);
    const list = JSON.parse((await runCli(t.env, ['profiles', '--json'])).stdout).profiles;
    assert.deepEqual(list.map((p: Record<string, unknown>) => [p.name, p.source, p.accountEmail]), [['imp', 'imported', 'florent@sooatek.example']]);
    const id = (await runCli(t.env, ['session', 'create', '--profile', 'imp'])).stdout.trim();
    assert.match(id, /^s[0-9a-f]{12}$/);
    // Source chiffrée par Chrome Windows (clé DPAPI) dans un serveur Linux : avertissement sur stderr.
    writeFileSync(join(src, 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: 'RFBBUEkBAAAA' }, profile: { info_cache: {} } }));
    const dpapi = await runCli(t.env, ['profiles', 'import', 'imp-win', src, '--profile-directory', 'Profile 9']);
    assert.equal(dpapi.code, 0, dpapi.stderr);
    assert.match(dpapi.stderr, /^AVERTISSEMENT : .*DPAPI.*déconnecté/m);
    const nonChrome = await runCli(t.env, ['profiles', 'import', 'x', t.root]);
    assert.match(nonChrome.stderr, /^ERROR: profiles: .*profil Chrome/m);
  } finally { srv.proc.kill('SIGTERM'); await waitExit(srv.proc); t.cleanup(); }
});
