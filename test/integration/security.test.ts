import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { makeTestEnv } from '../helpers/env.js';
import { startServer, runCli, waitExit } from '../helpers/server.js';
import { startTestSite } from '../helpers/testsite.js';
import { resolvePaths } from '../../src/core/paths.js';
import { request } from '../../src/core/http.js';
import { DEFAULTS, PUBLIC_KEYS } from '../../src/core/config.js';

function writeConfig(env: NodeJS.ProcessEnv, cfg: object) {
  const paths = resolvePaths(env, env.HOME);
  mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
  writeFileSync(paths.configFile, JSON.stringify(cfg), { mode: 0o600 });
  return paths;
}

test('régression #1 (bout en bout) — un config.json partiel (chromePath seul) ne désactive pas la politique', async () => {
  const t = makeTestEnv();
  const chrome = (await runCli(t.env, ['doctor', '--json'])).stdout;
  const chromePath = (JSON.parse(chrome) as Array<{ name: string; detail: string }>).find((c) => c.name === 'navigateur')!.detail.split(' ')[0]!;
  writeConfig(t.env, { chromePath });
  const site = await startTestSite();
  const srv = await startServer(t.env);
  try {
    const rep = (await srv.api('GET', '/security/effective')).json();
    assert.deepEqual(rep.policy.allowedDomains, DEFAULTS.allowedDomains);
    assert.equal(rep.policy.navigation, 'enforce');
    assert.equal(rep.policy.allowEval, false);
    await srv.api('POST', '/sessions', {});
    assert.equal((await srv.api('POST', '/navigate', { url: 'https://example.com' })).status, 403);
    assert.equal((await srv.api('POST', '/navigate', { url: `${site.url}/` })).status, 200, 'le local reste autorisé par défaut');
    assert.equal((await srv.api('POST', '/eval', { expression: '1' })).status, 403);
  } finally { srv.proc.kill('SIGTERM'); await waitExit(srv.proc); await site.close(); t.cleanup(); }
});

test('régression #2 (bout en bout) — allowlist ["127.0.0.1"] : POST /navigate example.com → 403 ET page non chargée', async () => {
  const t = makeTestEnv();
  writeConfig(t.env, { allowedDomains: ['127.0.0.1'] });
  const site = await startTestSite();
  const srv = await startServer(t.env);
  try {
    await srv.api('POST', '/sessions', {});
    assert.equal((await srv.api('POST', '/navigate', { url: `${site.url}/` })).status, 200);
    const r = await srv.api('POST', '/navigate', { url: 'https://example.com' });
    assert.equal(r.status, 403, 'un avertissement avec 200 OK serait exactement le bug de référence');
    assert.equal(r.headers['x-warning'], undefined);
    const loc = (await srv.api('GET', '/location')).json();
    assert.equal(loc.url, `${site.url}/`, 'la page NE DOIT PAS avoir été chargée');
    assert.match((await srv.api('GET', '/snap')).text(), /^page "Inscription"/);
    // et via le CLI : code non nul, erreur explicite
    const cli = await runCli(t.env, ['nav', 'https://example.com']);
    assert.notEqual(cli.code, 0);
    assert.match(cli.stderr, /^ERROR: nav: navigation bloquée/m);
    assert.equal(cli.stdout, '');
  } finally { srv.proc.kill('SIGTERM'); await waitExit(srv.proc); await site.close(); t.cleanup(); }
});

test('régression #3 — le rapport lit ce que le garde applique : /security/effective = bridge = CLI', async () => {
  const t = makeTestEnv();
  writeConfig(t.env, { allowedDomains: ['127.0.0.1', '*.test.local'], allowCookies: true });
  const srv = await startServer(t.env);
  try {
    const { id } = (await srv.api('POST', '/sessions', {})).json();
    const rep = (await srv.api('GET', '/security/effective')).json();
    const list = (await srv.api('GET', '/sessions')).json();
    // Politique lue directement dans la mémoire du bridge (celle que le garde consulte)
    const bridgeSock = `${srv.paths.bridgesDir}/${id}.sock`;
    const guard = (await request({ transport: 'unix', socketPath: bridgeSock }, 'GET', '/policy')).json();
    assert.equal(list.length, 1);
    assert.deepEqual(rep.policy, guard);
    assert.deepEqual(rep.bridges[id], guard);
    assert.deepEqual(guard.allowedDomains, ['127.0.0.1', '*.test.local']);
    assert.equal(guard.allowCookies, true);

    const cliJson = await runCli(t.env, ['security', '--json']);
    assert.equal(cliJson.code, 0, cliJson.stderr);
    assert.deepEqual(JSON.parse(cliJson.stdout).policy, guard, 'le CLI doit afficher la politique du garde');
    const cli = await runCli(t.env, ['security']);
    assert.match(cli.stdout, /allowlist\s*: 127\.0\.0\.1, \*\.test\.local/);
    assert.match(cli.stdout, /cookies\s*: AUTORISÉ/);
    assert.match(cli.stdout, /eval\s*: désactivé/);

    // La config change sur disque : le rapport continue d'afficher ce qui est APPLIQUÉ, et le signale.
    const set = await runCli(t.env, ['config', 'set', 'allowEval', 'true']);
    assert.equal(set.code, 0, set.stderr);
    const after = await runCli(t.env, ['security', '--json']);
    assert.equal(JSON.parse(after.stdout).policy.allowEval, false, 'le garde en mémoire n\'a pas changé');
    assert.equal(JSON.parse(after.stdout).diskDiffers, true);
    const human = await runCli(t.env, ['security']);
    assert.match(human.stderr, /redémarrez/i);
    assert.equal((await srv.api('POST', '/eval', { expression: '1' })).status, 403, 'cohérent avec le rapport');
  } finally { srv.proc.kill('SIGTERM'); await waitExit(srv.proc); t.cleanup(); }
});

test('régression #3 — sans serveur, `security` échoue au lieu d\'afficher le fichier comme s\'il était appliqué', async () => {
  const t = makeTestEnv();
  try {
    writeConfig(t.env, {});
    const r = await runCli(t.env, ['security']);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /^ERROR: security: /m);
    assert.equal(r.stdout, '');
  } finally { t.cleanup(); }
});

const CLI_VALUES: Record<string, { raw: string; value: unknown }> = {
  chromePath: { raw: '/usr/bin/true', value: '/usr/bin/true' },
  headless: { raw: 'false', value: false },
  allowedDomains: { raw: '127.0.0.1,example.org', value: ['127.0.0.1', 'example.org'] },
  allowEval: { raw: 'true', value: true },
  allowDownload: { raw: 'true', value: true },
  allowUpload: { raw: 'true', value: true },
  allowCookies: { raw: 'true', value: true },
  allowConsole: { raw: 'false', value: false },
  transport: { raw: 'tcp', value: 'tcp' },
  port: { raw: '7444', value: 7444 },
  cdpUrl: { raw: 'http://127.0.0.1:9222', value: 'http://127.0.0.1:9222' },
  windowsProfilesDir: { raw: 'C:\\grasp\\profiles', value: 'C:\\grasp\\profiles' },
  snapMax: { raw: '20000', value: 20000 },
  textMax: { raw: '8000', value: 8000 },
  diffMax: { raw: '6000', value: 6000 },
  stableTimeoutMs: { raw: '0', value: 0 },
};

test('régression #4 (CLI) — `config set` sur chaque clé publique : persiste (relecture du fichier) ou lève', async () => {
  assert.deepEqual(Object.keys(CLI_VALUES).sort(), [...PUBLIC_KEYS].sort());
  const t = makeTestEnv();
  try {
    const paths = resolvePaths(t.env, t.env.HOME);
    for (const k of PUBLIC_KEYS) {
      const r = await runCli(t.env, ['config', 'set', k, CLI_VALUES[k]!.raw]);
      assert.equal(r.code, 0, `${k}: ${r.stderr}`);
      assert.equal(r.stdout, 'OK\n');
      assert.deepEqual(JSON.parse(readFileSync(paths.configFile, 'utf8'))[k], CLI_VALUES[k]!.value, `${k} non persisté`);
      const g = await runCli(t.env, ['config', 'get', k, '--json']);
      assert.deepEqual(JSON.parse(g.stdout), CLI_VALUES[k]!.value);
    }
    // Répertoire en lecture seule : l'écriture échoue → code non nul, pas de « OK », fichier inchangé
    const before = readFileSync(paths.configFile, 'utf8');
    chmodSync(paths.configDir, 0o500);
    chmodSync(paths.configFile, 0o400);
    const r = await runCli(t.env, ['config', 'set', 'allowEval', 'false']);
    chmodSync(paths.configDir, 0o700);
    chmodSync(paths.configFile, 0o600);
    assert.notEqual(r.code, 0);
    assert.equal(r.stdout, '', 'jamais « OK » si rien n\'a été écrit');
    assert.match(r.stderr, /^ERROR: config: /m);
    assert.equal(readFileSync(paths.configFile, 'utf8'), before);
    // clé inconnue / valeur invalide
    assert.notEqual((await runCli(t.env, ['config', 'set', 'allowEvl', 'true'])).code, 0);
    assert.notEqual((await runCli(t.env, ['config', 'set', 'allowEval', 'oui'])).code, 0);
  } finally { t.cleanup(); }
});
