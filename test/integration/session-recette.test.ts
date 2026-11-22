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

const TOKEN = 'jeton-acces-0123456789abcdef';
const DRAFT = 'brouillon-confidentiel-42';

test('session create --state <recette> : session connectée d\'un coup, valeurs lues dans un fichier et masquées partout', async () => {
  const t = makeTestEnv();
  const site = await startTestSite();
  writeConfig(t.env, { allowCookies: true, allowedDomains: ['127.0.0.1'] });
  const srv = await startServer(t.env);
  try {
    const dir = join(t.root, 'recette');
    mkdirSync(dir);
    writeFileSync(join(dir, 'jetons.json'), JSON.stringify({ lite: { accessToken: TOKEN } }), { mode: 0o600 });
    writeFileSync(join(dir, '.env'), `BROUILLON=${DRAFT}\n`, { mode: 0o600 });
    const recipe = join(dir, 'session.json');
    writeFileSync(recipe, JSON.stringify({ origin: site.url, localStorage: { theme: '@file:jetons.json#lite.accessToken', locale: 'fr' }, sessionStorage: { brouillon: '@env:.env#BROUILLON' } }));

    const created = await runCli(t.env, ['session', 'create', '--state', recipe]);
    assert.equal(created.code, 0, created.stderr);
    const id = created.stdout.trim();
    assert.match(id, /^[\w-]+$/, 'stdout = id seul');
    assert.match(created.stderr, /état importé : 0 cookie\(s\), localStorage de 1 origine\(s\) \(2 clé\(s\)\), sessionStorage : appliqué au premier document de son origine/);
    assert.match(created.stderr, /2 valeur\(s\) lue\(s\) dans un fichier : masquée\(s\) dans toutes les sorties/);
    const leaks = (s: string) => s.includes(TOKEN) || s.includes(DRAFT);
    assert.ok(!leaks(created.stdout + created.stderr));

    const env = { ...t.env, GRASP_SESSION: id };
    const ok = async (args: string[], input?: string) => { const r = await runCli(env, args, input); assert.equal(r.code, 0, `${args.join(' ')} : ${r.stderr}`); assert.ok(!leaks(r.stdout + r.stderr), `fuite dans ${args.join(' ')} : ${r.stdout}${r.stderr}`); return r; };

    // La page lit elle-même les valeurs posées : la session est « connectée » dès le premier nav, et rien ne fuit.
    await ok(['nav', `${site.url}/compte`]);
    const text = (await ok(['text'])).stdout;
    assert.match(text, /Thème : masqué:localStorage\.theme/);
    assert.match(text, /Brouillon : masqué:sessionStorage\.brouillon/);
    assert.match((await ok(['snap'])).stdout, /masqué:localStorage\.theme/);
    assert.equal((await ok(['storage', 'get', 'local', 'theme'])).stdout, 'masqué:localStorage.theme\n');
    assert.equal((await ok(['storage', 'get', 'local', 'locale'])).stdout, 'fr\n', 'valeur littérale : non masquée');
    assert.match((await ok(['storage', 'get', 'session', 'brouillon', '--json'])).stdout, /"value":"masqué:sessionStorage\.brouillon"/);
    // La vérification par le contenu reste possible sans connaître la valeur.
    await ok(['expect', 'text', 'Thème : masqué:localStorage.theme']);
    // Historique rejouable : le chemin de la recette, jamais son contenu.
    const hist = (await ok(['history', '--as-run'])).stdout;
    assert.match(hist, new RegExp(`^state import ${recipe.replace(/[.]/g, '\\.')}$`, 'm'));
    // Journal du serveur et sortie --json : rien non plus.
    assert.ok(!leaks(srv.stderr()));

    // state import d'une recette sur une session existante, et sur une ligne de run (chemin relatif au script).
    const id2 = (await runCli(t.env, ['session', 'create'])).stdout.trim();
    const env2 = { ...t.env, GRASP_SESSION: id2 };
    const imp = await runCli(env2, ['state', 'import', recipe, '--json']);
    assert.equal(imp.code, 0, imp.stderr);
    assert.ok(!leaks(imp.stdout + imp.stderr));
    const script = join(dir, 'recette.grasp');
    writeFileSync(script, `state import session.json\nnav ${site.url}/compte\nexpect text "Thème : masqué:localStorage.theme"\ntext\n`);
    const id3 = (await runCli(t.env, ['session', 'create'])).stdout.trim();
    const run = await runCli({ ...t.env, GRASP_SESSION: id3 }, ['run', script]);
    assert.equal(run.code, 0, run.stdout + run.stderr);
    assert.ok(!leaks(run.stdout + run.stderr), run.stdout);
    assert.match(run.stdout, /Thème : masqué:localStorage\.theme/);

    // --json : id + bilan de l'import.
    const cj = await runCli(t.env, ['session', 'create', '--state', recipe, '--json']);
    const j = JSON.parse(cj.stdout) as { id: string; state: { localStorageKeys: number; masked: number } };
    assert.equal(j.state.localStorageKeys, 2);
    assert.equal(j.state.masked, 2);
    assert.ok(!leaks(cj.stdout + cj.stderr));
  } finally {
    srv.proc.kill('SIGTERM');
    await waitExit(srv.proc);
    await site.close();
    t.cleanup();
  }
});

test('session create --state : refus propres — fichier invalide (aucune session), allowCookies=false (session refermée), origine hors allowlist (signalée)', async () => {
  const t = makeTestEnv();
  const site = await startTestSite();
  writeConfig(t.env, { allowedDomains: ['127.0.0.1'] });
  const srv = await startServer(t.env);
  try {
    const recipe = join(t.root, 'session.json');
    const count = async () => (JSON.parse((await runCli(t.env, ['session', 'list', '--json'])).stdout || '[]') as unknown[]).length;

    // Référence illisible : rien n'est créé, le message ne cite que le chemin.
    writeFileSync(recipe, JSON.stringify({ origin: site.url, localStorage: { token: '@file:absent.json#a' } }));
    const ko = await runCli(t.env, ['session', 'create', '--state', recipe]);
    assert.equal(ko.code, 1);
    assert.match(ko.stderr, /--state : recette\.localStorage\.token : lecture de .*absent\.json impossible : ENOENT — aucune session créée/);
    assert.equal(ko.stdout, '');
    assert.equal(await count(), 0);

    // allowCookies=false : le refus du garde est rendu tel quel (clé nommée, décision de l'utilisateur), session refermée.
    writeFileSync(join(t.root, 'jetons.json'), JSON.stringify({ a: TOKEN }));
    writeFileSync(recipe, JSON.stringify({ origin: site.url, localStorage: { token: '@file:jetons.json#a' } }));
    const refused = await runCli(t.env, ['session', 'create', '--state', recipe]);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /--state : .*allowCookies.*décision de l'utilisateur humain.* — session \S+ refermée/);
    assert.doesNotMatch(refused.stderr, /config set/);
    assert.equal(refused.stdout, '');
    assert.equal(await count(), 0);
    assert.ok(!(refused.stderr + srv.stderr()).includes(TOKEN));
  } finally {
    srv.proc.kill('SIGTERM');
    await waitExit(srv.proc);
    await site.close();
    t.cleanup();
  }

  // Origine hors allowlist : rien n'est posé pour elle, l'avertissement le dit (l'allowlist prime sur la recette).
  const t2 = makeTestEnv();
  writeConfig(t2.env, { allowCookies: true, allowedDomains: ['127.0.0.1'] });
  const srv2 = await startServer(t2.env);
  try {
    const recipe = join(t2.root, 'session.json');
    writeFileSync(join(t2.root, 'jetons.json'), JSON.stringify({ a: TOKEN }));
    writeFileSync(recipe, JSON.stringify({ origin: 'https://ailleurs.exemple.com', localStorage: { token: '@file:jetons.json#a' }, cookies: { sid: '@file:jetons.json#a' } }));
    const r = await runCli(t2.env, ['session', 'create', '--state', recipe]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /AVERTISSEMENT : non importé : cookie sid \(ailleurs\.exemple\.com\/\) : domaine hors allowlist/);
    assert.match(r.stderr, /AVERTISSEMENT : non importé : localStorage de https:\/\/ailleurs\.exemple\.com : origine hors allowlist/);
    assert.ok(!r.stderr.includes(TOKEN));
  } finally {
    srv2.proc.kill('SIGTERM');
    await waitExit(srv2.proc);
    t2.cleanup();
  }
});
