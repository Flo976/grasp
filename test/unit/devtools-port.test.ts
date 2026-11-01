import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { ChildProcess } from 'node:child_process';
import { startOnOwnPort, type Spawned } from '../../src/browser/launch.js';

/**
 * Identité du navigateur qui répond sur le port choisi : l'endpoint annoncé sur le stderr de NOTRE
 * processus doit être celui que sert /json/version. Faux processus, vrais serveurs HTTP locaux.
 */

async function devtoolsServer(path: string): Promise<{ port: number; close(): Promise<void> }> {
  const srv = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${(srv.address() as { port: number }).port}${path}` }));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return { port: (srv.address() as { port: number }).port, close: () => new Promise((r) => srv.close(() => r())) };
}

function fake(stderr: (port: number) => string, opts: { exitAfterMs?: number } = {}): { spawnAt: (port: number) => Spawned; aborted: number[] } {
  const aborted: number[] = [];
  return {
    aborted,
    spawnAt: (port) => {
      const t0 = Date.now();
      return {
        child: {} as ChildProcess,
        pid: port,
        exited: () => (opts.exitAfterMs !== undefined && Date.now() - t0 >= opts.exitAfterMs ? 'code=21 signal=null' : null),
        stderr: () => stderr(port),
        abort: async () => { aborted.push(port); },
      };
    },
  };
}

const base = { label: 'Chrome', hint: '/profil', unreachable: (p: number, why: string) => `injoignable ${p} (${why})` };

test('endpoint annoncé = endpoint servi : connexion', async () => {
  const s = await devtoolsServer('/devtools/browser/mien');
  try {
    const f = fake((p) => `DevTools listening on ws://127.0.0.1:${p}/devtools/browser/mien\n`);
    const r = await startOnOwnPort({ ...base, budgetMs: 5000, pickPort: async () => s.port, spawnAt: f.spawnAt });
    assert.equal(r.wsUrl, `ws://127.0.0.1:${s.port}/devtools/browser/mien`);
    assert.deepEqual(f.aborted, []);
  } finally { await s.close(); }
});

test('un autre navigateur sert un autre endpoint sur le port : jamais retenu, nouvel essai sur un autre port', async () => {
  const other = await devtoolsServer('/devtools/browser/autre');
  const mine = await devtoolsServer('/devtools/browser/mien');
  try {
    const picks = [other.port, mine.port];
    const f = fake((p) => `DevTools listening on ws://127.0.0.1:${p}/devtools/browser/mien\n`);
    const r = await startOnOwnPort({ ...base, budgetMs: 5000, pickPort: async () => picks.shift()!, spawnAt: f.spawnAt });
    assert.equal(r.port, mine.port);
    assert.deepEqual(f.aborted, [other.port], 'le lancement du 1er essai est arrêté');
  } finally { await other.close(); await mine.close(); }
});

test('réponse sans annonce alors que notre stderr parle : autre navigateur ; stderr muet (enveloppe) : accepté', async () => {
  const s = await devtoolsServer('/devtools/browser/x');
  try {
    const noisy = fake(() => '[1:2:ERROR:gpu] bruit\n');
    await assert.rejects(startOnOwnPort({ ...base, budgetMs: 6000, pickPort: async () => s.port, spawnAt: noisy.spawnAt }), /autre navigateur.*ne s'y est pas annoncé/s);
    assert.equal(noisy.aborted.length, 3, '3 essais au plus');
    const mute = fake(() => '');
    const r = await startOnOwnPort({ ...base, budgetMs: 6000, pickPort: async () => s.port, spawnAt: mute.spawnAt });
    assert.equal(r.wsUrl, `ws://127.0.0.1:${s.port}/devtools/browser/x`);
  } finally { await s.close(); }
});

test('processus arrêté au démarrage : erreur immédiate (profil), pas de nouvel essai', async () => {
  let picks = 0;
  const f = fake(() => '', { exitAfterMs: 0 });
  await assert.rejects(startOnOwnPort({ ...base, budgetMs: 5000, pickPort: async () => { picks++; return 1; }, spawnAt: f.spawnAt }), /s'est arrêté au démarrage \(code=21.*\/profil.*déjà utilisé/s);
  assert.equal(picks, 1);
});

test('annoncé mais injoignable (WSL sans mirrored) : erreur explicite, sans nouvel essai', { timeout: 15_000 }, async () => {
  let picks = 0;
  const f = fake((p) => `DevTools listening on ws://127.0.0.1:${p}/devtools/browser/mien\n`);
  // Port 1 : rien n'y écoute.
  await assert.rejects(startOnOwnPort({ ...base, budgetMs: 12_000, pickPort: async () => { picks++; return 1; }, spawnAt: f.spawnAt }), /injoignable 1/);
  assert.equal(picks, 1);
});

test('navigateur muet : la moitié du temps restant par essai, puis échec qui liste les ports', async () => {
  const ports = [1, 2, 3];
  const f = fake(() => '');
  const t0 = Date.now();
  await assert.rejects(startOnOwnPort({ ...base, budgetMs: 1200, pickPort: async () => ports.shift()!, spawnAt: f.spawnAt }), /3 essais.*port 1 : pas de réponse.*port 2.*port 3/s);
  assert.ok(Date.now() - t0 < 3000);
});
