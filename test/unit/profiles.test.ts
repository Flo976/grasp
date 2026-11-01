import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProfileStore, profileId, validateProfileName, readIdentity, windowsEncryptedSource } from '../../src/core/profiles.js';
import { GraspError } from '../../src/core/errors.js';

function tmp(): { root: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), 'gr-pstore-'));
  return { root, cleanup: () => { try { chmodRecursive(root); } catch { /* */ } rmSync(root, { recursive: true, force: true }); } };
}
function chmodRecursive(p: string): void {
  chmodSync(p, 0o700);
  for (const e of readdirSync(p, { withFileTypes: true })) {
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) chmodRecursive(join(p, e.name)); else chmodSync(join(p, e.name), 0o600);
  }
}
function put(path: string, content: string | object = ''): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
}
const status = (e: unknown) => (e instanceof GraspError ? e.status : -1);

/** Répertoire de données Chrome factice : Local State (os_crypt, info_cache) + deux profils. */
function fakeUserData(dir: string): void {
  put(join(dir, 'Local State'), {
    os_crypt: { encrypted_key: 'RFBBUEk=', app_bound_encrypted_key: 'QVBQQg==' },
    profile: {
      info_cache: {
        Default: { name: 'Votre Chrome', user_name: 'perso@example.org', gaia_name: 'Perso' },
        'Profile 9': { name: 'sooatek.com', user_name: 'florent@sooatek.example', gaia_name: 'Florent S' },
      },
      last_used: 'Profile 9',
    },
    browser: { enabled_labs_experiments: [] },
  });
  for (const p of ['Default', 'Profile 9']) {
    put(join(dir, p, 'Preferences'), p === 'Profile 9' ? { account_info: [{ email: 'florent@sooatek.example', full_name: 'Florent Sooatek', gaia: '123' }] } : {});
    put(join(dir, p, 'Network', 'Cookies'), `cookies-${p}`);
    put(join(dir, p, 'Cache', 'Cache_Data', 'data_0'), 'x');
    put(join(dir, p, 'Code Cache', 'js', 'a'), 'x');
    put(join(dir, p, 'GPUCache', 'b'), 'x');
    put(join(dir, p, 'DawnCache', 'b'), 'x');
    put(join(dir, p, 'Service Worker', 'CacheStorage', 'c'), 'x');
    put(join(dir, p, 'Service Worker', 'Database', 'keep'), 'sw-db');
    put(join(dir, p, 'Local Storage', 'leveldb', '000003.log'), 'ls');
    put(join(dir, p, 'held.lock'), 'x');
  }
  put(join(dir, 'ShaderCache', 'x'), 'x');
  put(join(dir, 'GrShaderCache', 'x'), 'x');
  put(join(dir, 'Crashpad', 'settings.dat'), 'x');
  put(join(dir, 'SingletonLock'), 'x');
  put(join(dir, 'SingletonCookie'), 'x');
  put(join(dir, 'lockfile'), 'x');
}

test('profils : identifiant prof_ + 8 premiers hex du SHA-256 du nom', () => {
  assert.equal(profileId('florent'), `prof_${createHash('sha256').update('florent').digest('hex').slice(0, 8)}`);
  assert.match(profileId('sooatek'), /^prof_[0-9a-f]{8}$/);
});

test('profils : noms validés [A-Za-z0-9_.-]{1,64}', () => {
  for (const ok of ['florent', 'a.b-c_1', 'A'.repeat(64), 'v1.2']) assert.doesNotThrow(() => validateProfileName(ok), ok);
  for (const bad of ['', 'a b', 'é', 'A'.repeat(65), '.', '..', 'a/b', 'a\\b', 'x;rm']) {
    assert.throws(() => validateProfileName(bad), (e) => status(e) === 400, JSON.stringify(bad));
  }
});

test('profils : create écrit profile.json (0600) dans <racine>/<id>/ (0700), doublon → 409', () => {
  const t = tmp();
  try {
    const store = new ProfileStore(join(t.root, 'profiles'), true);
    const p = store.create('florent', { useWhen: 'comptes perso' });
    assert.equal(p.path, join(t.root, 'profiles', profileId('florent')));
    assert.equal(statSync(join(t.root, 'profiles')).mode & 0o777, 0o700);
    assert.equal(statSync(p.path).mode & 0o777, 0o700);
    assert.equal(statSync(join(p.path, 'profile.json')).mode & 0o777, 0o600);
    const meta = JSON.parse(readFileSync(join(p.path, 'profile.json'), 'utf8'));
    assert.equal(meta.id, profileId('florent'));
    assert.equal(meta.name, 'florent');
    assert.equal(meta.source, 'created');
    assert.equal(meta.useWhen, 'comptes perso');
    assert.equal(meta.lastUsedAt, null);
    assert.ok(!Number.isNaN(Date.parse(meta.createdAt)));
    assert.throws(() => store.create('florent', {}), (e) => status(e) === 409);
    assert.throws(() => store.create('mauvais nom', {}), (e) => status(e) === 400);
  } finally { t.cleanup(); }
});

test('profils : list (triée, identité lue en lecture seule), ignore les dossiers cachés et étrangers', () => {
  const t = tmp();
  try {
    const store = new ProfileStore(t.root, true);
    store.create('zoe', {});
    const f = store.create('florent', {});
    mkdirSync(join(t.root, '.tmp', 'sabc'), { recursive: true });
    mkdirSync(join(t.root, 'pas-un-profil'));
    // identité : Local State (info_cache) et Default/Preferences (account_info, prioritaire)
    put(join(f.path, 'Local State'), { profile: { info_cache: { Default: { user_name: 'ls@example.org', gaia_name: 'Nom LS' } } } });
    const before = readFileSync(join(f.path, 'Local State'), 'utf8');
    assert.deepEqual(store.list().map((p) => [p.name, p.accountEmail, p.accountName]), [['florent', 'ls@example.org', 'Nom LS'], ['zoe', null, null]]);
    put(join(f.path, 'Default', 'Preferences'), { account_info: [{ email: 'pref@example.org', full_name: 'Nom Pref' }] });
    assert.deepEqual(readIdentity(f.path), { accountEmail: 'pref@example.org', accountName: 'Nom Pref' });
    assert.equal(readFileSync(join(f.path, 'Local State'), 'utf8'), before, 'lecture seule');
    assert.equal(new ProfileStore(join(t.root, 'absent'), true).list().length, 0);
  } finally { t.cleanup(); }
});

test('profils : get, touch (lastUsedAt), remove (404 si inconnu)', () => {
  const t = tmp();
  try {
    const store = new ProfileStore(t.root, true);
    store.create('florent', {});
    assert.equal(store.get('inconnu'), undefined);
    store.touch('florent');
    assert.ok(store.get('florent')!.lastUsedAt !== null);
    store.remove('florent');
    assert.equal(existsSync(join(t.root, profileId('florent'))), false);
    assert.throws(() => store.remove('florent'), (e) => status(e) === 404);
  } finally { t.cleanup(); }
});

test('import : répertoire de données complet copié, caches et verrous exclus', async () => {
  const t = tmp();
  try {
    const src = join(t.root, 'User Data');
    fakeUserData(src);
    const store = new ProfileStore(join(t.root, 'profiles'), true);
    const r = await store.importProfile('complet', src, {});
    assert.deepEqual(r.skipped, []);
    const d = r.profile.path;
    assert.equal(r.profile.source, 'imported');
    assert.equal(r.profile.importedFrom, src);
    assert.equal(readFileSync(join(d, 'Profile 9', 'Network', 'Cookies'), 'utf8'), 'cookies-Profile 9');
    assert.equal(readFileSync(join(d, 'Default', 'Service Worker', 'Database', 'keep'), 'utf8'), 'sw-db');
    assert.ok(existsSync(join(d, 'Local State')));
    for (const gone of ['Default/Cache', 'Default/Code Cache', 'Default/GPUCache', 'Default/DawnCache', 'Default/Service Worker/CacheStorage', 'Default/held.lock', 'ShaderCache', 'GrShaderCache', 'Crashpad', 'SingletonLock', 'SingletonCookie', 'lockfile']) {
      assert.equal(existsSync(join(d, gone)), false, `${gone} aurait dû être exclu`);
    }
    assert.equal(statSync(join(d, 'Default', 'Network', 'Cookies')).mode & 0o777, 0o600);
    assert.equal(statSync(join(d, 'Default', 'Network')).mode & 0o777, 0o700);
    assert.equal(r.profile.accountEmail, 'perso@example.org', 'identité du profil Default');
    assert.ok(existsSync(join(src, 'SingletonLock')), 'la source n\'est jamais modifiée');
  } finally { t.cleanup(); }
});

test('import --profile-directory : sous-dossier → Default/, Local State minimal (os_crypt conservé, info_cache renommée)', async () => {
  const t = tmp();
  try {
    const src = join(t.root, 'User Data');
    fakeUserData(src);
    const store = new ProfileStore(join(t.root, 'profiles'), true);
    const r = await store.importProfile('sooatek-import', src, { profileDirectory: 'Profile 9' });
    const d = r.profile.path;
    assert.equal(readFileSync(join(d, 'Default', 'Network', 'Cookies'), 'utf8'), 'cookies-Profile 9');
    assert.equal(existsSync(join(d, 'Profile 9')), false);
    assert.equal(existsSync(join(d, 'Default', 'Cache')), false);
    const ls = JSON.parse(readFileSync(join(d, 'Local State'), 'utf8'));
    assert.deepEqual(ls.os_crypt, { encrypted_key: 'RFBBUEk=', app_bound_encrypted_key: 'QVBQQg==' });
    assert.deepEqual(Object.keys(ls.profile.info_cache), ['Default']);
    assert.equal(ls.profile.info_cache.Default.user_name, 'florent@sooatek.example');
    assert.equal(ls.browser, undefined, 'Local State minimal : rien d\'autre que os_crypt et le profil');
    assert.equal(r.profile.accountEmail, 'florent@sooatek.example');
    assert.equal(r.profile.accountName, 'Florent Sooatek');
    assert.equal(r.profile.importedFrom, join(src, 'Profile 9'));
  } finally { t.cleanup(); }
});

test('import : refuse les liens symboliques, les sources non-Chrome, un profil absent, un nom pris', async () => {
  const t = tmp();
  try {
    const store = new ProfileStore(join(t.root, 'profiles'), true);
    const src = join(t.root, 'User Data');
    fakeUserData(src);
    symlinkSync('/etc/passwd', join(src, 'Default', 'piege'));
    await assert.rejects(store.importProfile('lien', src, {}), (e) => status(e) === 400 && /lien symbolique/.test((e as Error).message));
    assert.deepEqual(store.list(), [], 'import avorté : rien ne reste');
    assert.deepEqual(readdirSync(join(t.root, 'profiles')), [], 'pas de répertoire temporaire résiduel');
    rmSync(join(src, 'Default', 'piege'));

    const empty = join(t.root, 'vide');
    mkdirSync(empty);
    await assert.rejects(store.importProfile('vide', empty, {}), (e) => status(e) === 400 && /profil Chrome/.test((e as Error).message));
    await assert.rejects(store.importProfile('absent', join(t.root, 'nexiste-pas'), {}), (e) => status(e) === 400);
    await assert.rejects(store.importProfile('p3', src, { profileDirectory: 'Profile 3' }), (e) => status(e) === 400 && /Profile 9/.test((e as Error).message));
    await assert.rejects(store.importProfile('evasion', src, { profileDirectory: '../User Data' }), (e) => status(e) === 400);
    store.create('pris', {});
    await assert.rejects(store.importProfile('pris', src, {}), (e) => status(e) === 409);
  } finally { t.cleanup(); }
});

test('import : fichier verrouillé → échec bruyant (liste + conseil), sauf --skip-locked qui avertit', async () => {
  if (process.getuid?.() === 0) return; // root lit tout : verrou non simulable
  const t = tmp();
  try {
    const store = new ProfileStore(join(t.root, 'profiles'), true);
    const src = join(t.root, 'User Data');
    fakeUserData(src);
    // Chrome ouvert sous Windows : Cookies illisible (EACCES via /mnt/c). Simulé par chmod 000.
    chmodSync(join(src, 'Profile 9', 'Network', 'Cookies'), 0o000);
    await assert.rejects(store.importProfile('verrou', src, { profileDirectory: 'Profile 9' }), (e) => {
      const m = (e as Error).message;
      return status(e) === 409 && /Network\/Cookies/.test(m) && /fermez Chrome/.test(m) && /--skip-locked/.test(m);
    });
    assert.deepEqual(store.list(), []);
    assert.deepEqual(readdirSync(join(t.root, 'profiles')), []);
    const r = await store.importProfile('verrou', src, { profileDirectory: 'Profile 9', skipLocked: true });
    assert.deepEqual(r.skipped, ['Default/Network/Cookies']);
    assert.equal(existsSync(join(r.profile.path, 'Default', 'Network', 'Cookies')), false);
    assert.ok(existsSync(join(r.profile.path, 'Default', 'Preferences')));
  } finally { t.cleanup(); }
});

test('profils sans droits POSIX (NTFS via /mnt/c) : aucune vérification ni chmod imposé', () => {
  const t = tmp();
  try {
    const store = new ProfileStore(t.root, false);
    chmodSync(t.root, 0o755);
    const p = store.create('win', {});
    assert.ok(existsSync(join(p.path, 'profile.json')));
    assert.equal(store.posix, false);
  } finally { t.cleanup(); }
});

test('import : source chiffrée par Windows (DPAPI / app-bound) dans un magasin Linux → avertissement explicite (cookies illisibles)', async () => {
  const t = tmp();
  try {
    const src = join(t.root, 'User Data');
    fakeUserData(src); // os_crypt.encrypted_key « DPAPI… » + app_bound_encrypted_key : profil de chrome.exe
    const store = new ProfileStore(join(t.root, 'profiles'), true);
    const r = await store.importProfile('win', src, { profileDirectory: 'Profile 9' });
    assert.equal(r.warnings.length, 1, JSON.stringify(r.warnings));
    assert.match(r.warnings[0]!, /DPAPI/);
    assert.match(r.warnings[0]!, /déconnecté/);
    assert.match(r.warnings[0]!, /florent@sooatek\.example/, 'le compte affiché ne prouve pas une connexion');
    const full = await store.importProfile('win-complet', src, {});
    assert.equal(full.warnings.length, 1);
    // Magasin Windows (chrome.exe) : la même source est lisible, aucun avertissement.
    const wstore = new ProfileStore(join(t.root, 'wprofiles'), false);
    assert.deepEqual((await wstore.importProfile('win', src, { profileDirectory: 'Profile 9' })).warnings, []);
  } finally { t.cleanup(); }
});

test('import --profile-directory sans « Local State » : magasin Windows → avertissement (clé os_crypt absente), Linux → rien', async () => {
  const t = tmp();
  try {
    const src = join(t.root, 'User Data');
    fakeUserData(src);
    rmSync(join(src, 'Local State'));
    const wstore = new ProfileStore(join(t.root, 'wprofiles'), false);
    const r = await wstore.importProfile('sans-ls', src, { profileDirectory: 'Profile 9' });
    assert.equal(r.warnings.length, 1, JSON.stringify(r.warnings));
    assert.match(r.warnings[0]!, /Local State/);
    assert.match(r.warnings[0]!, /os_crypt/);
    assert.equal(existsSync(join(r.profile.path, 'Local State')), false);
    // Chrome Linux (--password-store=basic) : la clé ne vit pas dans Local State.
    const lstore = new ProfileStore(join(t.root, 'profiles'), true);
    assert.deepEqual((await lstore.importProfile('sans-ls', src, { profileDirectory: 'Profile 9' })).warnings, []);
  } finally { t.cleanup(); }
});

test('import : détection d\'une source chiffrée par Windows (disque Windows ou clé DPAPI/app-bound)', () => {
  assert.equal(windowsEncryptedSource('/mnt/c/Users/x/AppData/Local/Google/Chrome/User Data', undefined), true);
  assert.equal(windowsEncryptedSource('/home/u/copie', { os_crypt: { encrypted_key: 'RFBBUEkBAAAA0Iyd' } }), true);
  assert.equal(windowsEncryptedSource('/home/u/copie', { os_crypt: { app_bound_encrypted_key: 'QVBQQg==' } }), true);
  assert.equal(windowsEncryptedSource('/home/u/.config/google-chrome', { os_crypt: { portal: {} } }), false);
  assert.equal(windowsEncryptedSource('/home/u/.config/google-chrome', undefined), false);
});
