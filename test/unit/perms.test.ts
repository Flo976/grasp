import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkPermissions } from '../../src/core/perms.js';
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
