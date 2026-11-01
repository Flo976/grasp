import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkPermissions, writePrivateFile } from '../../src/core/perms.js';
import { makeTestEnv } from '../helpers/env.js';

test('permissions : 0600/0700 acceptées, plus permissif refusé avec la commande de remédiation', () => {
  const t = makeTestEnv();
  try {
    const dir = join(t.root, 'conf');
    mkdirSync(dir, { mode: 0o700 });
    const file = join(dir, 'token');
    writeFileSync(file, 'x', { mode: 0o600 });
    assert.doesNotThrow(() => checkPermissions([{ path: dir, kind: 'dir' }, { path: file, kind: 'file' }]));
    chmodSync(file, 0o644);
    assert.throws(() => checkPermissions([{ path: dir, kind: 'dir' }, { path: file, kind: 'file' }]), /chmod 600 .*token/);
    chmodSync(file, 0o600);
    chmodSync(dir, 0o755);
    assert.throws(() => checkPermissions([{ path: dir, kind: 'dir' }]), /chmod 700 .*conf/);
  } finally { t.cleanup(); }
});

test('permissions : un chemin absent n\'est pas une erreur (il sera créé en 0600/0700)', () => {
  assert.doesNotThrow(() => checkPermissions([{ path: '/nonexistent/grasp/x', kind: 'file' }]));
});

test('writePrivateFile : 0600 même si le fichier existait en 0644, lien symbolique remplacé (jamais suivi)', () => {
  const t = makeTestEnv();
  try {
    const file = join(t.root, 'shot.png');
    writeFileSync(file, 'ancien', { mode: 0o644 });
    chmodSync(file, 0o644);
    writePrivateFile(file, Buffer.from('nouveau'));
    assert.equal(readFileSync(file, 'utf8'), 'nouveau');
    assert.equal(statSync(file).mode & 0o777, 0o600, 'le mode est imposé, pas seulement à la création');

    const victim = join(t.root, 'victime');
    writeFileSync(victim, 'intact', { mode: 0o644 });
    const link = join(t.root, 'lien.png');
    symlinkSync(victim, link);
    writePrivateFile(link, Buffer.from('capture'));
    assert.equal(readFileSync(victim, 'utf8'), 'intact', 'la cible du lien n\'est pas écrasée');
    assert.ok(!lstatSync(link).isSymbolicLink(), 'le lien est remplacé par un fichier');
    assert.equal(statSync(link).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(t.root).filter((f) => f.endsWith('.tmp')), [], 'aucun fichier temporaire laissé');

    assert.throws(() => writePrivateFile(join(t.root, 'absent', 'x.png'), Buffer.from('x')), /ENOENT/);
    assert.throws(() => writePrivateFile(t.root, Buffer.from('x')));
  } finally { t.cleanup(); }
});
