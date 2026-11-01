import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverChrome, profileRootsFor, type FsProbe } from '../../src/browser/discover.js';

const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
function probe(files: Record<string, Buffer | string>, which: Record<string, string> = {}): FsProbe {
  return {
    which: (n) => which[n] ?? null,
    isExecutable: (p) => p in files,
    readHead: (p) => { const f = files[p]; return f === undefined ? null : Buffer.from(f); },
  };
}

test('ordre : $GRASP_CHROME passe avant tout', () => {
  const r = discoverChrome({ GRASP_CHROME: '/custom/chrome' }, probe({ '/custom/chrome': ELF, '/usr/bin/google-chrome-stable': ELF }, { 'google-chrome-stable': '/usr/bin/google-chrome-stable' }), '/home/u');
  assert.equal(r.path, '/custom/chrome');
  assert.equal(r.source, 'env');
});

test('$GRASP_CHROME invalide : erreur explicite, pas de repli silencieux', () => {
  assert.throws(() => discoverChrome({ GRASP_CHROME: '/nope' }, probe({ '/usr/bin/chromium': ELF }, { chromium: '/usr/bin/chromium' }), '/home/u'), /GRASP_CHROME/);
});

test('ordre which : google-chrome-stable, google-chrome, chromium, chromium-browser', () => {
  const files = { '/a/chromium': ELF, '/a/google-chrome': ELF };
  const r = discoverChrome({}, probe(files, { chromium: '/a/chromium', 'google-chrome': '/a/google-chrome' }), '/home/u');
  assert.equal(r.path, '/a/google-chrome');
});

test('chromePath de la config passe après $GRASP_CHROME mais avant which', () => {
  const r = discoverChrome({}, probe({ '/cfg/chrome': ELF, '/a/chromium': ELF }, { chromium: '/a/chromium' }), '/home/u', '/cfg/chrome');
  assert.equal(r.path, '/cfg/chrome');
  assert.equal(r.source, 'config');
});

test('chemins fixes puis snap puis flatpak', () => {
  assert.equal(discoverChrome({}, probe({ '/opt/google/chrome/chrome': ELF, '/snap/bin/chromium': '#!/bin/sh' }), '/home/u').path, '/opt/google/chrome/chrome');
  const snap = discoverChrome({}, probe({ '/snap/bin/chromium': '#!/bin/sh\nexec /usr/bin/snap run chromium' }), '/home/u');
  assert.equal(snap.kind, 'snap');
  const fp = discoverChrome({}, probe({ '/var/lib/flatpak/exports/bin/org.chromium.Chromium': '#!/bin/sh\nexec flatpak run org.chromium.Chromium "$@"' }), '/home/u');
  assert.equal(fp.kind, 'flatpak');
});

test('un wrapper shell n\'est pas un ELF : on le détecte', () => {
  const r = discoverChrome({}, probe({ '/usr/bin/chromium-browser': '#!/bin/sh\n/snap/bin/chromium "$@"' }, { 'chromium-browser': '/usr/bin/chromium-browser' }), '/home/u');
  assert.equal(r.kind, 'snap', 'le wrapper Ubuntu chromium-browser délègue à snap');
  const s = discoverChrome({}, probe({ '/x/chrome-wrapper': '#!/bin/bash\nexec /opt/chrome "$@"' }, { 'google-chrome': '/x/chrome-wrapper' }), '/home/u');
  assert.equal(s.kind, 'script');
  const e = discoverChrome({}, probe({ '/x/chrome': ELF }, { 'google-chrome': '/x/chrome' }), '/home/u');
  assert.equal(e.kind, 'elf');
});

test('rien trouvé : message qui indique quoi faire', () => {
  assert.throws(() => discoverChrome({}, probe({}), '/home/u'), /GRASP_CHROME/);
});

const P = { profilesDir: '/home/u/.local/share/grasp/profiles', tmpProfilesDir: '/home/u/.local/share/grasp/tmp-profiles' };

test('snap : profils dans ~/snap/chromium/common (le confinement interdit les dotdirs et le hors-$HOME)', () => {
  const r = profileRootsFor({ kind: 'snap', path: '/snap/bin/chromium', source: 'fixed' }, P, '/home/u', {});
  assert.deepEqual(r, { profiles: '/home/u/snap/chromium/common/grasp-profiles', tmp: '/home/u/snap/chromium/common/grasp-tmp-profiles', posix: true });
});

test('flatpak : profils sous ~/.var/app/<id>', () => {
  const r = profileRootsFor({ kind: 'flatpak', path: '/var/lib/flatpak/exports/bin/org.chromium.Chromium', source: 'fixed' }, P, '/home/u', {});
  assert.equal(r.profiles, '/home/u/.var/app/org.chromium.Chromium/grasp-profiles');
  assert.equal(r.tmp, '/home/u/.var/app/org.chromium.Chromium/grasp-tmp-profiles');
});

test('elf : profils sous le répertoire de données XDG', () => {
  const r = profileRootsFor({ kind: 'elf', path: '/usr/bin/google-chrome', source: 'which' }, P, '/home/u', {});
  assert.deepEqual(r, { profiles: P.profilesDir, tmp: P.tmpProfilesDir, posix: true });
});
