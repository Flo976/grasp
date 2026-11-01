import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTestEnv } from '../helpers/env.js';
import { startServer, runCli, waitExit } from '../helpers/server.js';
import { startTestSite } from '../helpers/testsite.js';
import { resolvePaths } from '../../src/core/paths.js';
import { waitUntil } from '../helpers/procs.js';
import { DOWNLOAD_JS } from '../helpers/download.js';


test('téléchargements (allowDownload) : le fichier arrive dans downloads/<session>', async () => {
  const t = makeTestEnv();
  const site = await startTestSite();
  const paths = resolvePaths(t.env, t.env.HOME);
  mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
  writeFileSync(paths.configFile, JSON.stringify({ allowEval: true, allowDownload: true, allowedDomains: ['127.0.0.1'] }), { mode: 0o600 });
  const srv = await startServer(t.env);
  try {
    const id = (await runCli(t.env, ['session', 'create'])).stdout.trim();
    const env = { ...t.env, GRASP_SESSION: id };
    assert.equal((await runCli(env, ['nav', `${site.url}/`])).stdout, 'OK\n');
    const r = await runCli(env, ['eval', DOWNLOAD_JS]);
    assert.equal(r.code, 0, r.stderr);
    const file = join(paths.dataDir, 'downloads', id, 'grasp-dl.txt');
    assert.ok(await waitUntil(() => existsSync(file), 10_000), `${file} absent`);
    assert.equal(readFileSync(file, 'utf8'), 'contenu grasp');
  } finally { srv.proc.kill('SIGTERM'); await waitExit(srv.proc); await site.close(); t.cleanup(); }
});
