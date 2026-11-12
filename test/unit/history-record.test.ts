import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HistoryLog, MASK } from '../../src/core/history.js';
import { beginRecord, type BridgeCall } from '../../src/control/history.js';

const noBridge: BridgeCall = async () => { throw new Error('bridge non appelé ici'); };

/**
 * Une action renvoie la description de la cible d'une AUTRE action (requêtes concurrentes d'une session) : elle
 * est refusée — la valeur est masquée par prudence et la cible n'est pas remplacée par un autre élément.
 */
test('history : description de cible étrangère à la commande refusée (valeur masquée, cible gardée)', async () => {
  const log = new HistoryLog();
  const rec = (await beginRecord(log, 'POST', '/fill', { target: '#code', value: 'S3cret' }, 'api', noBridge))!;
  assert.equal(rec.inline, true);
  assert.equal(rec.body?.describeTarget, '#code');
  rec.finish(true, 200, undefined, { ok: true, target: { given: 'e5', durable: 'text:Supprimer', how: 'text', secret: false } });
  const e = log.since(0)[0]!;
  assert.deepEqual(e.line.pos, ['#code', MASK]);
  assert.ok(!JSON.stringify(e).includes('S3cret'));
  assert.equal(e.target?.given, '#code');
  assert.equal(e.target?.durable, undefined);
  assert.equal(e.target?.secret, null);

  // Description de la bonne cible (blancs autour près) : retenue.
  const rec2 = (await beginRecord(log, 'POST', '/fill', { target: ' e7 ', value: 'Ada' }, 'api', noBridge))!;
  rec2.finish(true, 200, undefined, { ok: true, target: { given: 'e7', durable: 'text:Nom', how: 'text', secret: false } });
  const e2 = log.since(1)[0]!;
  assert.deepEqual(e2.line.pos, [' e7 ', 'Ada']);
  assert.equal(e2.target?.durable, 'text:Nom');

  // Même contrôle pour la route interne (expect, wait).
  const other: BridgeCall = async () => ({ status: 200, json: () => ({ given: '#autre', durable: '#autre', how: 'given', secret: false }), text: () => '' });
  const rec3 = (await beginRecord(log, 'POST', '/expect', { kind: 'value', target: 'e9', expected: 'x' }, 'api', other))!;
  rec3.finish(true, 200);
  const e3 = log.since(2)[0]!;
  assert.equal(e3.target?.durable, undefined);
  assert.equal(e3.line.pos[1], 'e9');
});
