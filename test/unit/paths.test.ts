import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, statSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolvePaths, checkSocketPath, checkSocketPaths, bridgeSocketPath, checkSocketFallbackDir } from '../../src/core/paths.js';

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

test('socket Unix : chemin > 107 octets → repli court et haché sous /tmp/grasp-<uid>, même calcul côté client et serveur', () => {
  const uid = process.getuid!();
  const long = `/tmp/${'x'.repeat(110)}`;
  const p = resolvePaths({ XDG_RUNTIME_DIR: long }, '/home/u');
  assert.ok(p.socketFallback !== undefined, 'repli attendu');
  assert.match(p.socketPath, new RegExp(`^/tmp/grasp-${uid}/[0-9a-f]{12}/grasp\\.sock$`));
  assert.equal(p.socketFallback.original, `${long}/grasp.sock`);
  assert.equal(p.bridgesDir, `${p.socketFallback.dir}/bridges`);
  assert.doesNotThrow(() => checkSocketPaths(p, 'unix'));
  // Déterministe (le client retrouve le serveur) et propre au chemin d'origine (deux installations, deux sockets).
  assert.equal(resolvePaths({ XDG_RUNTIME_DIR: long }, '/home/u').socketPath, p.socketPath);
  assert.notEqual(resolvePaths({ XDG_RUNTIME_DIR: `${long}z` }, '/home/u').socketPath, p.socketPath);
  // Socket du control plane assez court, mais pas ceux des bridges : repli aussi (les deux restent ensemble).
  const mid = `/tmp/${'y'.repeat(80)}`;
  assert.doesNotThrow(() => checkSocketPath(`${mid}/grasp.sock`, 'control plane'));
  const pm = resolvePaths({ XDG_RUNTIME_DIR: mid }, '/home/u');
  assert.ok(pm.socketFallback !== undefined);
  assert.doesNotThrow(() => checkSocketPaths(pm, 'tcp'));
  // Sans XDG_RUNTIME_DIR, un XDG_STATE_HOME profond déclenche aussi le repli.
  assert.ok(resolvePaths({ XDG_STATE_HOME: `/tmp/${'s'.repeat(100)}` }, '/home/u').socketFallback !== undefined);
  // Chemin normal court : aucun repli.
  const ok = resolvePaths({ XDG_RUNTIME_DIR: '/run/user/1000' }, '/home/u');
  assert.equal(ok.socketFallback, undefined);
  assert.equal(ok.socketPath, '/run/user/1000/grasp.sock');
  assert.throws(() => checkSocketPath(`/tmp/${'z'.repeat(110)}`, 'du bridge'), /107 octets/);
  assert.equal(Buffer.byteLength(bridgeSocketPath(resolvePaths({ XDG_RUNTIME_DIR: '/r' }, '/h'), 's0123456789ab')), '/r/grasp/bridges/s0123456789ab.sock'.length);
});

test('repli des sockets : répertoire vérifié (vrai répertoire, propriétaire, 0700), jamais corrigé en silence', () => {
  const root = mkdtempSync(join(tmpdir(), 'grasp-fb-'));
  try {
    const base = join(root, 'base');
    const dir = join(base, 'abc');
    // Client : rien n'est créé, absence → erreur.
    assert.throws(() => checkSocketFallbackDir(dir, base, false), /absent/);
    // Serveur : création en 0700 des deux niveaux.
    checkSocketFallbackDir(dir, base, true);
    assert.equal(statSync(base).mode & 0o777, 0o700);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.doesNotThrow(() => checkSocketFallbackDir(dir, base, false));
    // Base trop ouverte (un autre utilisateur pourrait y poser un leurre) : refus, sans chmod.
    chmodSync(base, 0o777);
    assert.throws(() => checkSocketFallbackDir(dir, base, true), /0777.*attendu 0700/);
    assert.equal(statSync(base).mode & 0o777, 0o777, 'pas de correction silencieuse');
    chmodSync(base, 0o700);
    // Lien symbolique à la place du sous-répertoire : refus.
    const other = join(root, 'ailleurs');
    mkdirSync(other, { mode: 0o700 });
    const link = join(base, 'lien');
    symlinkSync(other, link);
    assert.throws(() => checkSocketFallbackDir(link, base, true), /pas un répertoire/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
