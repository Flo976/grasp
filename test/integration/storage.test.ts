import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTestEnv } from '../helpers/env.js';
import { startServer, runCli, waitExit } from '../helpers/server.js';
import { startTestSite } from '../helpers/testsite.js';
import { resolvePaths } from '../../src/core/paths.js';

function writeConfig(env: NodeJS.ProcessEnv, cfg: object): void {
  const paths = resolvePaths(env, env.HOME);
  mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
  writeFileSync(paths.configFile, JSON.stringify(cfg), { mode: 0o600 });
}

test('storage set|get|rm local|session : origine affichée, sans allowEval, vérifié par le contenu de la page ; utilisable dans run', async () => {
  const t = makeTestEnv();
  const site = await startTestSite();
  // allowEval reste à false : storage n'évalue que du code fixe.
  writeConfig(t.env, { allowCookies: true, allowedDomains: ['127.0.0.1'] });
  const srv = await startServer(t.env);
  try {
    const id = (await runCli(t.env, ['session', 'create'])).stdout.trim();
    const env = { ...t.env, GRASP_SESSION: id };
    const ok = async (args: string[], input?: string) => { const r = await runCli(env, args, input); assert.equal(r.code, 0, `${args.join(' ')} : ${r.stderr}`); return r; };

    // Avant toute navigation : about:blank n'a pas d'origine → refus explicite.
    const blank = await runCli(env, ['storage', 'set', 'local', 'theme', 'clair']);
    assert.equal(blank.code, 1);
    assert.match(blank.stderr, /^ERROR: storage: .*about:blank.*naviguez d'abord/m);
    assert.equal((await runCli(env, ['eval', '1'])).code, 1, 'eval reste désactivé');

    await ok(['nav', `${site.url}/compte`]);
    assert.match((await ok(['text'])).stdout, /Thème : aucun[\s\S]*Brouillon : aucun/);
    const set = await ok(['storage', 'set', 'local', 'theme', 'clair']);
    assert.equal(set.stdout, 'OK\n');
    assert.match(set.stderr, new RegExp(`localStorage de ${site.url.replace(/[.]/g, '\\.')}`));
    await ok(['storage', 'set', 'session', 'brouillon', 'salut']);
    await ok(['nav', `${site.url}/compte`]);
    assert.match((await ok(['text'])).stdout, /Thème : clair[\s\S]*Brouillon : salut/, 'valeurs lues par la page elle-même');
    assert.equal((await ok(['storage', 'get', 'local', 'theme'])).stdout, 'clair\n');
    assert.deepEqual(JSON.parse((await ok(['storage', 'get', 'session', 'brouillon', '--json'])).stdout), { ok: true, op: 'get', origin: site.url, area: 'session', key: 'brouillon', value: 'salut' });

    // Clé absente : code 1, message qui le dit ; rm idempotent, signalé.
    const none = await runCli(env, ['storage', 'get', 'local', 'absente']);
    assert.equal(none.code, 1);
    assert.match(none.stderr, /clé « absente » absente du localStorage/);
    await ok(['storage', 'rm', 'local', 'theme']);
    assert.equal((await runCli(env, ['storage', 'get', 'local', 'theme'])).code, 1);
    assert.match((await ok(['storage', 'rm', 'local', 'theme'])).stderr, /déjà absente/);

    // Valeur sur stdin (hors de ps) ; get borné à 4000 caractères, troncature annoncée.
    await ok(['storage', 'set', 'local', 'gros', '-'], `${'x'.repeat(5000)}\n`);
    const big = await ok(['storage', 'get', 'local', 'gros']);
    assert.equal(big.stdout, `${'x'.repeat(4000)}\n`);
    assert.match(big.stderr, /tronquée à 4000 caractères sur 5000/);

    // Usage invalide : refus avant tout appel.
    assert.match((await runCli(env, ['storage', 'set', 'local', 'k'])).stderr, /usage : grasp storage/);
    assert.match((await runCli(env, ['storage', 'get', 'cookie', 'k'])).stderr, /stockage inconnu « cookie »/);

    // Dans un run : poser une session factice, recharger, vérifier par le contenu.
    const r = await runCli(env, ['run'], `storage set local theme sombre
nav ${site.url}/compte
expect text "Thème : sombre"
storage get local theme
`);
    assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /\[4\] storage get local theme → OK\nsombre\n/);
  } finally { srv.proc.kill('SIGTERM'); await waitExit(srv.proc); await site.close(); t.cleanup(); }
});

test('storage : refusé tant que allowCookies est désactivé (défaut), message qui nomme la clé', async () => {
  const t = makeTestEnv();
  const site = await startTestSite();
  writeConfig(t.env, { allowedDomains: ['127.0.0.1'] });
  const srv = await startServer(t.env);
  try {
    const id = (await runCli(t.env, ['session', 'create'])).stdout.trim();
    const env = { ...t.env, GRASP_SESSION: id };
    assert.equal((await runCli(env, ['nav', `${site.url}/compte`])).code, 0);
    for (const args of [['storage', 'get', 'local', 'theme'], ['storage', 'set', 'local', 'theme', 'x']]) {
      const r = await runCli(env, args);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /allowCookies/);
    }
    assert.equal((await srv.api('POST', '/storage', { op: 'set', area: 'local', key: 'k', value: 'v' }, { 'x-grasp-session': id })).status, 403);
    assert.match((await runCli(env, ['text'])).stdout, /Thème : aucun/, 'rien écrit');
  } finally { srv.proc.kill('SIGTERM'); await waitExit(srv.proc); await site.close(); t.cleanup(); }
});

test('recette : session factice posée par state import sans allowEval (exemple du README)', async () => {
  const t = makeTestEnv();
  const site = await startTestSite();
  writeConfig(t.env, { allowCookies: true, allowedDomains: ['127.0.0.1'] });
  const srv = await startServer(t.env);
  try {
    const id = (await runCli(t.env, ['session', 'create'])).stdout.trim();
    const env = { ...t.env, GRASP_SESSION: id };
    const file = join(t.root, 'session-factice.json');
    writeFileSync(file, JSON.stringify({
      format: 'grasp-state', version: 1,
      origins: [{ origin: site.url, localStorage: [{ name: 'theme', value: 'factice' }] }],
      sessionStorage: { origin: site.url, items: [{ name: 'brouillon', value: 'factice' }] },
    }), { mode: 0o600 });
    const imp = await runCli(env, ['state', 'import', file]);
    assert.equal(imp.code, 0, imp.stderr);
    assert.equal((await runCli(env, ['nav', `${site.url}/compte`])).code, 0);
    assert.match((await runCli(env, ['text'])).stdout, /Thème : factice[\s\S]*Brouillon : factice/);
  } finally { srv.proc.kill('SIGTERM'); await waitExit(srv.proc); await site.close(); t.cleanup(); }
});
