import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { makeTestEnv, type TestEnv } from '../helpers/env.js';
import { spawn } from 'node:child_process';
import { startServer, runCli, waitExit, CLI, type Server } from '../helpers/server.js';
import { startTestSite, type TestSite } from '../helpers/testsite.js';
import { resolvePaths } from '../../src/core/paths.js';

/** Onglets de bout en bout : CLI → control plane → bridge, et dans `grasp run`. */
let t: TestEnv;
let site: TestSite;
let srv: Server;
let env: NodeJS.ProcessEnv;
before(async () => {
  t = makeTestEnv();
  site = await startTestSite();
  const paths = resolvePaths(t.env, t.env.HOME);
  mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
  writeFileSync(paths.configFile, JSON.stringify({ allowedDomains: ['127.0.0.1'], maxTabs: 3 }), { mode: 0o600 });
  srv = await startServer(t.env);
  const id = (await runCli(t.env, ['session', 'create'])).stdout.trim();
  env = { ...t.env, GRASP_SESSION: id };
});
after(async () => { srv.proc.kill('SIGTERM'); await waitExit(srv.proc); await site.close(); t.cleanup(); });

test('CLI : popup annoncé, tabs, tab <id>, flux OAuth avec --follow, tab close, erreurs explicites', async () => {
  assert.equal((await runCli(env, ['nav', `${site.url}/onglets`])).code, 0);
  const aide = await runCli(env, ['click', 'text:Aide']);
  assert.equal(aide.code, 0, aide.stderr);
  assert.equal(aide.stdout, 'OK\n');
  assert.match(aide.stderr, /^note: nouvel onglet t2 ouvert : http:\/\/127\.0\.0\.1:\d+\/onglets\/aide « Aide » — grasp tab t2 pour y basculer$/m);
  const list = await runCli(env, ['tabs']);
  assert.equal(list.code, 0, list.stderr);
  assert.match(list.stdout, /^\* t1 "Application" http:\/\/127\.0\.0\.1:\d+\/onglets\n {2}t2 "Aide" http:\/\/127\.0\.0\.1:\d+\/onglets\/aide \(ouvert par t1\)\n$/);
  const sw = await runCli(env, ['tab', 't2']);
  assert.match(sw.stdout, /^\* t2 "Aide" /);
  assert.match((await runCli(env, ['text'])).stdout, /Aide en ligne/);
  assert.equal((await runCli(env, ['tab', 'close'])).code, 0);
  // OAuth : bascule sur le popup, autorisation, retour automatique sur t1 annoncé, résultat lu dans la page.
  const oauth = await runCli(env, ['click', '#oauth', '--follow']);
  assert.match(oauth.stderr, /nouvel onglet t3 ouvert : .*\/onglets\/autoriser « Fournisseur » ; onglet actif : t3 \(--follow\)/);
  const ok = await runCli(env, ['click', 'text:Autoriser']);
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stderr, /l'onglet t3 s'est fermé pendant l'action .* — onglet actif : t1 « Application »/);
  assert.match((await runCli(env, ['text'])).stdout, /Connecté : Ada/);
  // Erreurs : identifiant invalide (400 côté CLI), onglet inconnu, dernier onglet.
  const bad = await runCli(env, ['tab', 'nouveau']);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /identifiant d'onglet t1, t2…/);
  assert.match((await runCli(env, ['tab', 't9'])).stderr, /onglet t9 inconnu ou fermé \(onglets : t1\)/);
  assert.match((await runCli(env, ['tab', 'close'])).stderr, /t1 est le dernier onglet de la session/);
  // Popup hors allowlist : bloqué, fermé, dit.
  assert.match((await runCli(env, ['click', '#dehors'])).stderr, /popup bloqué par Grasp : .* ; onglet t\d fermé/);
  assert.match((await runCli(env, ['tabs'])).stdout, /^\* t1 "Application" [^\n]*\n$/);
});

test('run : tab new, tabs, tab, tab close sur une ligne de script ; --follow accepté sur une action', async () => {
  const script = `nav ${site.url}/onglets
tab new ${site.url}/onglets/aide
tabs
tab t1
click text:Aide --follow
text
tab close
`;
  const r = await runCli(env, ['run'], script);
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /\[2\] tab new .* → OK\n {0,2}\* t\d+ "Aide" /);
  assert.match(r.stdout, /\[3\] tabs → OK\n {2}t1 "Application" .*\n\* t\d+ "Aide" .*\(?/);
  assert.match(r.stdout, /\[5\] click text:Aide --follow → OK/);
  assert.match(r.stderr, /\[5\] note: nouvel onglet t\d+ ouvert : .* ; onglet actif : t\d+ \(--follow\)/);
  assert.match(r.stdout, /\[6\] text → OK\nAide en ligne/);
  assert.match(r.stdout, /\[7\] tab close → OK/);
  // Option inconnue sur une ligne de run : refusée avant toute exécution.
  const bad = await runCli(env, ['run'], 'tabs --follow\n');
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr, /option --follow inconnue pour tabs/);
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `grasp mcp --session <id>` minimal : un appel d'outil, une réponse (JSON-RPC ligne à ligne). */
async function mcpSession(e: NodeJS.ProcessEnv, session: string) {
  const proc = spawn(process.execPath, [CLI, 'mcp', '--session', session, '--no-serve'], { env: e, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map<number, (m: any) => void>();
  let buf = '';
  let err = '';
  proc.stderr.on('data', (d) => { err += d.toString(); });
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (d: string) => {
    buf += d;
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      waiting.get(m.id)?.(m);
    }
  });
  let id = 0;
  const req = (method: string, params: unknown): Promise<any> => new Promise((resolve, reject) => {
    const n = ++id;
    const t = setTimeout(() => reject(new Error(`pas de réponse (${method})\n${err}`)), 60_000);
    waiting.set(n, (m) => { clearTimeout(t); resolve(m); });
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`);
  });
  await req('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  return {
    tool: async (name: string, args: Record<string, unknown>): Promise<string> => {
      const r = await req('tools/call', { name, arguments: args });
      return String(r.result.content[0].text);
    },
    close: async () => { proc.stdin.end(); await waitExit(proc); },
  };
}

test('MCP : follow sur une action, et la note d\'un popup refermé hors action arrive sur l\'outil suivant (snap)', async () => {
  const id = (await runCli(t.env, ['session', 'create'])).stdout.trim();
  const m = await mcpSession(t.env, id);
  try {
    await m.tool('nav', { url: `${site.url}/onglets` });
    const c = await m.tool('click', { target: '#ephemere', follow: true });
    assert.match(c, /^note: nouvel onglet t2 ouvert : .* ; onglet actif : t2 \(--follow\)$/m);
    await sleep(2500); // le popup se referme seul après 1,5 s, hors de toute action
    const s = await m.tool('snap', {});
    assert.match(s, /^note: onglet t2 fermé par la page — onglet actif : t1 « Application » http:\/\/127\.0\.0\.1:\d+\/onglets\n/);
    assert.match(s, /button "Se connecter avec Fournisseur"/);
    // Dite une seule fois.
    assert.doesNotMatch(await m.tool('text', {}), /note:/);
  } finally { await m.close(); await runCli(t.env, ['session', 'close', id]); }
});

test('recyclage : la note d\'un popup refermé hors action n\'est pas perdue avec l\'ancien bridge', async () => {
  const t2 = makeTestEnv();
  const paths = resolvePaths(t2.env, t2.env.HOME);
  mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
  writeFileSync(paths.configFile, JSON.stringify({ allowedDomains: ['127.0.0.1'], browserMaxAgeMin: 0.1 }), { mode: 0o600 }); // 6 s
  const srv2 = await startServer(t2.env);
  try {
    const id = (await runCli(t2.env, ['session', 'create'])).stdout.trim();
    const e2 = { ...t2.env, GRASP_SESSION: id };
    const t0 = Date.now();
    assert.equal((await runCli(e2, ['nav', `${site.url}/onglets`])).code, 0);
    const c = await runCli(e2, ['click', '#ephemere', '--follow']);
    assert.doesNotMatch(c.stderr, /recyclé/, 'trop lent : le recyclage a eu lieu avant le popup');
    await sleep(Math.max(2500, 6500 - (Date.now() - t0)));
    // Commande suivante : recyclage (âge), et la note de fermeture du popup est reportée dans la sienne.
    const r = await runCli(e2, ['text']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /^note: onglet t2 fermé par la page — onglet actif : t1 « Application » http:\/\/127\.0\.0\.1:\d+\/onglets ; navigateur recyclé : âge \d+ s > \d+ s ; page rechargée sur http:\/\/127\.0\.0\.1:\d+\/onglets$/m);
  } finally { srv2.proc.kill('SIGTERM'); await waitExit(srv2.proc); t2.cleanup(); }
});
