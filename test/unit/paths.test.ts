import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePaths } from '../../src/core/paths.js';

test('chemins XDG : respecte les variables définies', () => {
  const p = resolvePaths({ XDG_CONFIG_HOME: '/x/c', XDG_STATE_HOME: '/x/s', XDG_DATA_HOME: '/x/d', XDG_RUNTIME_DIR: '/x/r' }, '/home/u');
  assert.equal(p.configDir, '/x/c/grasp');
  assert.equal(p.configFile, '/x/c/grasp/config.json');
  assert.equal(p.tokenFile, '/x/c/grasp/token');
  assert.equal(p.stateDir, '/x/s/grasp');
  assert.equal(p.dataDir, '/x/d/grasp');
  assert.equal(p.socketPath, '/x/r/grasp.sock');
});

test('chemins XDG : défauts sous $HOME, jamais ~/.grasp', () => {
  const p = resolvePaths({}, '/home/u');
  assert.equal(p.configDir, '/home/u/.config/grasp');
  assert.equal(p.stateDir, '/home/u/.local/state/grasp');
  assert.equal(p.dataDir, '/home/u/.local/share/grasp');
  for (const v of Object.values(p)) assert.ok(!String(v).includes('.grasp'), `chemin interdit: ${v}`);
});

test('sans XDG_RUNTIME_DIR, le socket va dans le répertoire d\'état (0700)', () => {
  const p = resolvePaths({}, '/home/u');
  assert.equal(p.socketPath, '/home/u/.local/state/grasp/run/grasp.sock');
});
