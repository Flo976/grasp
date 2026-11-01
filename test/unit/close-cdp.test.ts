import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';
import { closeViaCdp } from '../../src/browser/launch.js';

test('arrêt : Browser.close sans réponse (navigateur gelé) → closeViaCdp rend la main dans son délai', { timeout: 10_000 }, async () => {
  // Navigateur gelé : accepte la connexion CDP mais ne répond jamais.
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  const received: string[] = [];
  wss.on('connection', (ws) => ws.on('message', (m) => received.push(JSON.parse(m.toString()).method)));
  try {
    const t0 = Date.now();
    const gone = await closeViaCdp(`ws://127.0.0.1:${(wss.address() as AddressInfo).port}/devtools/browser/x`, () => false, 300);
    assert.equal(gone, false);
    assert.deepEqual(received, ['Browser.close']);
    assert.ok(Date.now() - t0 < 3000, `closeViaCdp a attendu ${Date.now() - t0} ms`);
  } finally {
    for (const c of wss.clients) c.terminate();
    await new Promise((r) => wss.close(r));
  }
});
