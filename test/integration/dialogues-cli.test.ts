import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { makeTestEnv, type TestEnv } from '../helpers/env.js';
import { CLI, startServer, runCli, waitExit, type Server } from '../helpers/server.js';
import { startTestSite, type TestSite } from '../helpers/testsite.js';
import { resolvePaths } from '../../src/core/paths.js';

/** --dialog de bout en bout : CLI, grasp run et outil MCP, contre le vrai serveur et un vrai Chrome. */
let t: TestEnv;
let site: TestSite;
let srv: Server;
let env: NodeJS.ProcessEnv;
before(async () => {
  t = makeTestEnv();
  site = await startTestSite();
  const paths = resolvePaths(t.env, t.env.HOME);
  mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
  writeFileSync(paths.configFile, JSON.stringify({ allowedDomains: ['127.0.0.1'] }), { mode: 0o600 });
  srv = await startServer(t.env);
  const id = (await runCli(t.env, ['session', 'create'])).stdout.trim();
  env = { ...t.env, GRASP_SESSION: id };
});
after(async () => { srv.proc.kill('SIGTERM'); await waitExit(srv.proc); await site.close(); t.cleanup(); });

test('CLI : défaut refusé (note sur stderr), --dialog accept --snap-diff supprime et le dit en tête du diff, --json rend dialogs', async () => {
  assert.equal((await runCli(env, ['nav', `${site.url}/dialogues`])).code, 0);
  const d = await runCli(env, ['click', '#sup-a']);
  assert.equal(d.code, 0, d.stderr);
  assert.match(d.stderr, /note: dialogue confirm « Supprimer « Article A » \? » → refusé \(défaut sûr — --dialog accept pour répondre\)/, d.stderr);
  assert.match((await runCli(env, ['text', '--scope', '#liste'])).stdout, /Article A/);
  const a = await runCli(env, ['click', '#sup-a', '--dialog', 'accept', '--snap-diff']);
  assert.equal(a.code, 0, a.stderr);
  assert.match(a.stdout, /^! dialogue confirm « Supprimer « Article A » \? » → accepté\n/, a.stdout);
  assert.doesNotMatch((await runCli(env, ['text', '--scope', '#liste'])).stdout, /Article A/, 'suppression effective');
  const j = await runCli(env, ['click', '#renommer', '--dialog', 'Ada', '--json']);
  assert.deepEqual(JSON.parse(j.stdout).dialogs, [{ type: 'prompt', message: 'Nouveau nom ?', accepted: true, promptText: 'Ada' }]);
  assert.equal((await runCli(env, ['text', '--scope', '#nom'])).stdout.trim(), 'Nom : Ada');
  // Valeur oubliée : `--dialog --snap-diff` avale l'option suivante ; refusé (400), aucun clic, rien supprimé.
  assert.equal((await runCli(env, ['nav', `${site.url}/dialogues`])).code, 0);
  const o = await runCli(env, ['click', '#sup-a', '--dialog', '--snap-diff']);
  assert.notEqual(o.code, 0, o.stdout);
  assert.match(o.stderr, /ressemble à une option/, o.stderr);
  assert.match((await runCli(env, ['text', '--scope', '#liste'])).stdout, /Article A/);
});

test('grasp run : --dialog sur une ligne, rapporté dans la sortie du pas', async () => {
  const script = `nav ${site.url}/dialogues
click '#renommer' --dialog "Facture 2026"
click '#sup-b' --dialog accept --snap-diff
text --scope '#nom'
`;
  const r = await runCli(env, ['run'], script);
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
  // Sans --snap-diff : la note du pas, sur stderr comme toute note de run.
  assert.match(r.stderr, /\[2\] note: dialogue prompt « Nouveau nom \? » → accepté avec « Facture 2026 »/, r.stderr);
  assert.match(r.stdout, /^! dialogue confirm « Supprimer « Article B » \? » → accepté$/m, r.stdout);
  assert.match(r.stdout, /Nom : Facture 2026/);
  assert.doesNotMatch((await runCli(env, ['text', '--scope', '#liste'])).stdout, /Article B/);
});

test('MCP : argument dialog de click, rapporté dans le texte de l\'outil', async () => {
  assert.equal((await runCli(env, ['nav', `${site.url}/dialogues`])).code, 0);
  const proc = spawn(process.execPath, [CLI, 'mcp'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  const replies = new Map<number, (m: any) => void>();
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (d: string) => {
    buf += d;
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); replies.get(m.id)?.(m); }
  });
  let id = 0;
  const rq = (method: string, params: unknown) => new Promise<any>((res) => { replies.set(++id, res); proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  try {
    await rq('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    const tools = (await rq('tools/list', {})).result.tools as Array<{ name: string; inputSchema: any }>;
    assert.ok(tools.find((x) => x.name === 'nav')!.inputSchema.properties.dialog, 'nav accepte dialog');
    const r = await rq('tools/call', { name: 'click', arguments: { target: '#sup-a', dialog: 'accept', snapDiff: true } });
    const txt = (r.result.content as Array<{ text: string }>).map((c) => c.text).join('\n');
    assert.match(txt, /! dialogue confirm « Supprimer « Article A » \? » → accepté/, txt);
    assert.doesNotMatch((await runCli(env, ['text', '--scope', '#liste'])).stdout, /Article A/);
  } finally { proc.stdin.end(); await waitExit(proc, 40_000); }
});
