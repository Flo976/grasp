import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTestEnv } from '../helpers/env.js';
import { startServer, runCli, waitExit } from '../helpers/server.js';
import { startTestSite } from '../helpers/testsite.js';
import { resolvePaths } from '../../src/core/paths.js';
import type { GraspState } from '../../src/core/state.js';

function writeConfig(env: NodeJS.ProcessEnv, cfg: object): void {
  const paths = resolvePaths(env, env.HOME);
  mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
  writeFileSync(paths.configFile, JSON.stringify(cfg), { mode: 0o600 });
}

test('state : export d\'une session connectée, import dans un AUTRE profil avant navigation → connecté (cookies HttpOnly, localStorage, sessionStorage)', async () => {
  const t = makeTestEnv();
  const site = await startTestSite();
  writeConfig(t.env, { allowCookies: true, allowedDomains: ['127.0.0.1'] });
  const srv = await startServer(t.env);
  try {
    const src = (await runCli(t.env, ['session', 'create', '--profile', 'source'])).stdout.trim();
    const a = { ...t.env, GRASP_SESSION: src };
    const ok = async (env: NodeJS.ProcessEnv, args: string[]) => { const r = await runCli(env, args); assert.equal(r.code, 0, `${args.join(' ')} : ${r.stderr}`); return r; };

    // 1. Connexion réelle au site de test (formulaire, cookie HttpOnly posé par le serveur).
    await ok(a, ['nav', `${site.url}/connexion`]);
    await ok(a, ['fill', '#user', 'florent']);
    await ok(a, ['click', 'text:Se connecter']);
    await ok(a, ['nav', `${site.url}/compte`]);
    const before = (await ok(a, ['text'])).stdout;
    assert.match(before, /Connecté : florent/);
    assert.match(before, /Thème : sombre/);
    assert.match(before, /Brouillon : bonjour/);

    // 2. Export : fichier 0600 (un fichier 0644 existant est remplacé), chemin sur stdout, bilan sur stderr.
    const file = join(t.root, 'etat.json');
    writeFileSync(file, 'ancien', { mode: 0o644 });
    const hitsBefore = site.hits.length;
    const ex = await ok(a, ['state', 'export', file]);
    assert.equal(ex.stdout.trim(), file);
    assert.match(ex.stderr, /état exporté : 2 cookie\(s\), localStorage de 1 origine\(s\) \(1 clé\(s\)\)/);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(site.hits.slice(hitsBefore), [], 'l\'export ne fait aucune requête au site (document vide servi par Grasp)');
    const st = JSON.parse(readFileSync(file, 'utf8')) as GraspState;
    assert.equal(st.format, 'grasp-state');
    assert.equal(st.version, 1);
    const sid = st.cookies.find((c) => c.name === 'sid');
    assert.ok(sid, JSON.stringify(st.cookies));
    assert.equal(sid.domain, '127.0.0.1');
    assert.equal(sid.httpOnly, true);
    assert.equal(sid.sameSite, 'Lax');
    assert.ok(sid.expires > Date.now() / 1000, 'cookie persistant : date d\'expiration');
    assert.equal(st.cookies.find((c) => c.name === 'pref')?.expires, -1, 'cookie de session : expires = -1');
    assert.deepEqual(st.origins, [{ origin: site.url, localStorage: [{ name: 'theme', value: 'sombre' }] }]);
    assert.deepEqual(st.sessionStorage, { origin: site.url, items: [{ name: 'brouillon', value: 'bonjour' }] });

    // Sans fichier : dans l'état de Grasp (0700/0600), seulement le chemin sur stdout.
    const auto = await ok(a, ['state', 'export']);
    const autoPath = auto.stdout.trim();
    assert.ok(autoPath.startsWith(join(srv.paths.stateDir, 'etats')), autoPath);
    assert.equal(statSync(autoPath).mode & 0o777, 0o600);
    assert.equal(statSync(join(srv.paths.stateDir, 'etats')).mode & 0o777, 0o700);

    // 3. Nouvelle session sur un NOUVEAU profil : déconnectée, puis import AVANT toute navigation.
    const dst = (await runCli(t.env, ['session', 'create', '--profile', 'cible'])).stdout.trim();
    const b = { ...t.env, GRASP_SESSION: dst };
    const imp = await ok(b, ['state', 'import', file]);
    assert.equal(imp.stdout, 'OK\n');
    assert.match(imp.stderr, /état importé : 2 cookie\(s\), localStorage de 1 origine\(s\) \(1 clé\(s\)\), sessionStorage : appliqué au premier document/);
    assert.doesNotMatch(imp.stderr, /AVERTISSEMENT/);
    assert.ok(!site.hits.slice(hitsBefore).includes('/.grasp-etat'), 'l\'import ne fait aucune requête au site');
    await ok(b, ['nav', `${site.url}/compte`]);
    const after = (await ok(b, ['text'])).stdout;
    assert.match(after, /Connecté : florent/, 'connecté par le cookie importé (vérifié côté serveur)');
    assert.match(after, /Thème : sombre/, 'localStorage restauré');
    assert.match(after, /Brouillon : bonjour/, 'sessionStorage appliqué au premier document de l\'origine');

    // Témoin : le profil cible n'était pas connecté par hasard (une 3e session vierge ne l'est pas).
    const blank = (await runCli(t.env, ['session', 'create'])).stdout.trim();
    const c = { ...t.env, GRASP_SESSION: blank };
    await ok(c, ['nav', `${site.url}/compte`]);
    assert.match((await ok(c, ['text'])).stdout, /Non connecté[\s\S]*Thème : aucun[\s\S]*Brouillon : aucun/);

    // 4. Import par l'API HTTP, onglet déjà sur l'origine : sessionStorage appliqué tout de suite.
    const r = await srv.api('POST', '/state/import', { state: { ...st, cookies: [] } }, { 'x-grasp-session': blank });
    assert.equal(r.status, 200, r.text());
    assert.equal(r.json().sessionStorage, 'applied');
    await ok(c, ['nav', `${site.url}/compte`]);
    assert.match((await ok(c, ['text'])).stdout, /Non connecté[\s\S]*Thème : sombre[\s\S]*Brouillon : bonjour/);
    const exp = await srv.api('GET', '/state/export', undefined, { 'x-grasp-session': blank });
    assert.equal(exp.status, 200);
    assert.equal(exp.json().state.format, 'grasp-state');
  } finally { srv.proc.kill('SIGTERM'); await waitExit(srv.proc); await site.close(); t.cleanup(); }
});

test('state : refusé tant que allowCookies est désactivé (défaut) — message qui nomme la clé, aucun fichier écrit', async () => {
  const t = makeTestEnv();
  const srv = await startServer(t.env);
  try {
    await runCli(t.env, ['session', 'create']);
    const file = join(t.root, 'etat.json');
    const ex = await runCli(t.env, ['state', 'export', file]);
    assert.equal(ex.code, 1);
    // La clé est nommée, sa valeur présentée comme décision de l'utilisateur humain : jamais la commande qui la relâche.
    assert.match(ex.stderr, /^ERROR: state: .*sont désactivés par la politique de Grasp \(clé allowCookies\)\. .*décision de l'utilisateur humain, pas de l'agent/m);
    assert.doesNotMatch(ex.stderr, /config set/);
    assert.equal(existsSync(file), false);
    writeFileSync(file, JSON.stringify({ format: 'grasp-state', version: 1, cookies: [], origins: [] }));
    const im = await runCli(t.env, ['state', 'import', file]);
    assert.equal(im.code, 1);
    assert.match(im.stderr, /allowCookies/);
    assert.equal((await srv.api('GET', '/state/export')).status, 403);
    assert.equal((await srv.api('POST', '/state/import', { state: {} })).status, 403);
  } finally { srv.proc.kill('SIGTERM'); await waitExit(srv.proc); t.cleanup(); }
});

test('state : allowlist — rien d\'importé ni d\'exporté hors allowlist, fichier invalide refusé sans rien appliquer', async () => {
  const t = makeTestEnv();
  const site = await startTestSite();
  writeConfig(t.env, { allowCookies: true, allowedDomains: ['127.0.0.1'] });
  const srv = await startServer(t.env);
  try {
    await runCli(t.env, ['session', 'create']);
    const far = Math.floor(Date.now() / 1000) + 3600;
    const file = join(t.root, 'etat.json');
    writeFileSync(file, JSON.stringify({
      format: 'grasp-state', version: 1,
      cookies: [
        { name: 'ok', value: '1', domain: '127.0.0.1', path: '/', expires: far, httpOnly: false, secure: false, sameSite: 'Lax' },
        { name: 'dehors', value: '1', domain: '.example.com', path: '/', expires: far, httpOnly: true, secure: true, sameSite: 'None' },
        { name: 'perime', value: '1', domain: '127.0.0.1', path: '/', expires: 1000, httpOnly: false, secure: false },
      ],
      origins: [{ origin: 'http://example.com', localStorage: [{ name: 'k', value: 'v' }] }],
    }));
    const im = await runCli(t.env, ['state', 'import', file]);
    assert.equal(im.code, 0, im.stderr);
    assert.match(im.stderr, /état importé : 1 cookie\(s\), localStorage de 0 origine/);
    assert.match(im.stderr, /non importé : cookie dehors \(\.example\.com\/\) : domaine hors allowlist/);
    assert.match(im.stderr, /non importé : cookie perime .*expiré/);
    assert.match(im.stderr, /non importé : localStorage de http:\/\/example\.com : origine hors allowlist/);

    const ex = await runCli(t.env, ['state', 'export', '-']);
    assert.equal(ex.code, 0, ex.stderr);
    const st = JSON.parse(ex.stdout) as GraspState;
    assert.deepEqual(st.cookies.map((c) => c.name), ['ok']);
    const out = await runCli(t.env, ['state', 'export', '-', '--origin', 'http://example.com']);
    assert.equal(out.code, 1);
    assert.match(out.stderr, /origine hors allowlist : http:\/\/example\.com/);

    // Version inconnue : refus explicite, rien appliqué.
    writeFileSync(file, JSON.stringify({ format: 'grasp-state', version: 99, cookies: [{ name: 'x', value: '1', domain: '127.0.0.1' }], origins: [] }));
    const bad = await runCli(t.env, ['state', 'import', file]);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /version 99 non prise en charge/);
    assert.deepEqual((JSON.parse((await runCli(t.env, ['state', 'export', '-'])).stdout) as GraspState).cookies.map((c) => c.name), ['ok']);
    assert.ok(!site.hits.includes('/.grasp-etat'));
  } finally { srv.proc.kill('SIGTERM'); await waitExit(srv.proc); await site.close(); t.cleanup(); }
});
