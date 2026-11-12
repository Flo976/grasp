import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { makeTestEnv, type TestEnv } from '../helpers/env.js';
import { startServer, runCli, waitExit, type Server } from '../helpers/server.js';
import { startTestSite, type TestSite } from '../helpers/testsite.js';
import { resolvePaths } from '../../src/core/paths.js';
import type { RunResult } from '../../src/control/run.js';

/** grasp a11y et expect a11y de bout en bout : CLI → control plane → bridge, config par défaut (eval désactivé). */
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

test('grasp a11y : rapport sur stdout, portée rappelée sur stderr, code 0 même avec des problèmes ; --json ; --max', async () => {
  assert.equal((await runCli(env, ['nav', `${site.url}/a11y`])).code, 0);
  const r = await runCli(env, ['a11y', '--max', '2']);
  assert.equal(r.code, 0, r.stderr);
  const lines = r.stdout.trimEnd().split('\n');
  assert.match(lines[0]!, /^a11y : 18 problèmes — page "Accessibilité piégée"/);
  assert.equal(lines.length, 5, r.stdout);
  assert.match(lines[2]!, /^sans-nom e[0-9a-z]+:link a\[href="\/panier"\]/);
  assert.equal(lines[4], '… 16 problèmes non listés — affinez avec --max N / --scope <ref|css>');
  assert.match(r.stderr, /^note: relevé automatique partiel, pas un audit WCAG/m);
  const j = await runCli(env, ['a11y', '--json', '--scope', '#inscription']);
  const o = JSON.parse(j.stdout) as { total: number; counts: Record<string, number>; issues: Array<{ kind: string; ref?: string }> };
  assert.equal(o.total, 7);
  assert.ok(o.issues.some((i) => i.kind === 'sans-nom' && /^e[0-9a-z]+$/.test(i.ref ?? '')));
  const bad = await runCli(env, ['a11y', '--max', 'abc']);
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr, /ERROR: a11y: .*max/);
});

test('expect a11y en commande directe et dans run : code 1, attendu/constaté, rapport de recette ; ligne a11y de run', async () => {
  const d = await runCli(env, ['expect', 'a11y']);
  assert.equal(d.code, 1);
  assert.match(d.stderr, /ERROR: expect: attendu au plus 0 problème\(s\) d'accessibilité dans la page ; constaté : 18 problème\(s\)/);
  const okMax = await runCli(env, ['expect', 'a11y', '--max', '18']);
  assert.equal(okMax.code, 0, okMax.stderr);
  assert.match(okMax.stderr, /note: 18 problème\(s\) d'accessibilité toléré\(s\)/);
  const r = await runCli(env, ['run', '--json'], `nav ${site.url}/a11y
a11y --scope '#promos' --max 1
expect a11y --scope '#promos' --max 7
expect a11y
`);
  assert.equal(r.code, 1, r.stdout);
  const j = JSON.parse(r.stdout) as RunResult & { report?: unknown };
  assert.match(j.steps[1]!.output ?? '', /^a11y : 7 problèmes dans #promos — page/);
  assert.match(j.steps[1]!.output ?? '', /… 6 problèmes non listés/);
  assert.equal(j.steps[2]!.ok, true);
  assert.equal(j.steps[3]!.ok, false);
  assert.match(j.steps[3]!.error ?? '', /constaté : 18 problème\(s\)/);
  assert.ok(j.report !== undefined, 'rapport de recette d\'office');
  const clean = await runCli(env, ['run'], `nav ${site.url}/a11y-propre\nexpect a11y\n`);
  assert.equal(clean.code, 0, `${clean.stdout}\n${clean.stderr}`);
  assert.match(clean.stdout, /^== recette : OK/m);
  const syntax = await runCli(env, ['run'], 'a11y --markdown\n');
  assert.notEqual(syntax.code, 0);
  assert.match(syntax.stderr, /ligne 1 : .*option --markdown inconnue pour a11y/);
});
