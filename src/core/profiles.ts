import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { GraspError } from './errors.js';
import { isWindowsDrivePath } from '../browser/windows.js';

/**
 * Magasin de profils (modèle pinchtab) : un profil = un --user-data-dir complet possédé par Grasp,
 * dans <racine>/<id>/, choisi AVANT de lancer le navigateur.
 *
 *   <racine>/prof_1a2b3c4d/profile.json   métadonnées Grasp (0600)
 *   <racine>/prof_1a2b3c4d/Local State     données Chrome (lues en lecture seule pour l'identité)
 *   <racine>/prof_1a2b3c4d/Default/…
 */

export type ProfileSource = 'created' | 'imported';

export interface ProfileMeta {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  source: ProfileSource;
  importedFrom?: string;
  useWhen?: string;
}

export interface ProfileInfo extends ProfileMeta {
  path: string;
  accountEmail: string | null;
  accountName: string | null;
}

export interface ImportOptions { profileDirectory?: string | undefined; skipLocked?: boolean | undefined }
export interface ImportResult { profile: ProfileInfo; skipped: string[]; warnings: string[] }

const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

export function validateProfileName(name: string): void {
  if (!NAME_RE.test(name) || /^\.+$/.test(name)) {
    throw new GraspError(400, `nom de profil invalide ${JSON.stringify(name)} : [A-Za-z0-9_.-], 1 à 64 caractères`);
  }
}

/** Identifiant stable : prof_ + 8 premiers hex du SHA-256 du nom (comme pinchtab). */
export function profileId(name: string): string {
  return `prof_${createHash('sha256').update(name).digest('hex').slice(0, 8)}`;
}

function readJsonFile(path: string): unknown {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; }
}
const obj = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

/**
 * Identité du compte Google, en lecture seule : Default/Preferences (account_info) est prioritaire,
 * puis Local State (profile.info_cache, entrée Default ou la première).
 */
export function readIdentity(dir: string): { accountEmail: string | null; accountName: string | null } {
  let email: string | null = null;
  let name: string | null = null;
  const prefs = obj(readJsonFile(join(dir, 'Default', 'Preferences')));
  const accounts = Array.isArray(prefs.account_info) ? prefs.account_info : [];
  for (const a of accounts.map(obj)) {
    const e = text(a.email);
    const n = text(a.full_name) ?? text(a.gaia_name);
    if (e !== null || n !== null) { email = e; name = n; break; }
  }
  const cache = obj(obj(obj(readJsonFile(join(dir, 'Local State'))).profile).info_cache);
  const entry = obj(cache.Default ?? Object.values(cache)[0]);
  return { accountEmail: email ?? text(entry.user_name), accountName: name ?? text(entry.gaia_name) };
}

/**
 * Source chiffrée par Chrome Windows : sur un disque Windows, ou Local State avec une clé os_crypt
 * DPAPI (« DPAPI… » en base64 : RFBBUEk…) ou app-bound. Seul chrome.exe, sous ce compte Windows, la relit.
 */
export function windowsEncryptedSource(src: string, localState: unknown): boolean {
  if (isWindowsDrivePath(src)) return true;
  const c = obj(obj(localState).os_crypt);
  return (typeof c.encrypted_key === 'string' && c.encrypted_key.startsWith('RFBBUEk')) || c.app_bound_encrypted_key !== undefined;
}

/** Caches et verrous : régénérés par Chrome, inutiles (ou nuisibles) dans une copie. */
const EXCLUDED = new Set(['Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'GraphiteDawnCache',
  'GPUPersistentCache', 'ShaderCache', 'GrShaderCache', 'Crashpad', 'lockfile', 'DevToolsActivePort']);
const EXCLUDED_PATHS = new Set(['Service Worker/CacheStorage', 'Service Worker/ScriptCache']);

function excluded(rel: string, name: string): boolean {
  if (EXCLUDED.has(name) || name.startsWith('Singleton') || name.endsWith('.lock')) return true;
  return [...EXCLUDED_PATHS].some((p) => rel === p || rel.endsWith(`/${p}`));
}

/** Codes d'un fichier tenu ouvert par Chrome (Windows : verrou exclusif → EACCES via /mnt/c). */
const LOCK_CODES = new Set(['EACCES', 'EBUSY', 'EPERM', 'ETXTBSY']);

function isProfileDir(dir: string): boolean {
  try { return statSync(join(dir, 'Preferences')).isFile(); } catch { return false; }
}

export class ProfileStore {
  constructor(readonly root: string, readonly posix: boolean) {}

  private ensureRoot(): void {
    if (!existsSync(this.root)) mkdirSync(this.root, { recursive: true, mode: 0o700 });
    if (this.posix) chmodSync(this.root, 0o700);
  }

  dirFor(name: string): string {
    validateProfileName(name);
    return join(this.root, profileId(name));
  }

  private readMeta(dir: string): ProfileMeta | undefined {
    const file = join(dir, 'profile.json');
    if (!existsSync(file)) return undefined;
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw new GraspError(500, `${file} illisible : ${(e as Error).message}`); }
    const m = obj(raw);
    if (typeof m.id !== 'string' || typeof m.name !== 'string' || typeof m.createdAt !== 'string') throw new GraspError(500, `${file} : métadonnées incomplètes (id, name, createdAt)`);
    return {
      id: m.id, name: m.name, createdAt: m.createdAt,
      lastUsedAt: typeof m.lastUsedAt === 'string' ? m.lastUsedAt : null,
      source: m.source === 'imported' ? 'imported' : 'created',
      ...(typeof m.importedFrom === 'string' ? { importedFrom: m.importedFrom } : {}),
      ...(typeof m.useWhen === 'string' ? { useWhen: m.useWhen } : {}),
    };
  }

  private writeMeta(dir: string, meta: ProfileMeta): void {
    const file = join(dir, 'profile.json');
    const tmp = `${file}.tmp-${process.pid}`;
    const fd = openSync(tmp, 'w', 0o600);
    try { writeFileSync(fd, `${JSON.stringify(meta, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    if (this.posix) chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  }

  private info(dir: string, meta: ProfileMeta): ProfileInfo {
    return { ...meta, path: dir, ...readIdentity(dir) };
  }

  get(name: string): ProfileInfo | undefined {
    const dir = this.dirFor(name);
    const meta = this.readMeta(dir);
    if (meta === undefined) return undefined;
    if (meta.name !== name) throw new GraspError(409, `collision d'identifiant : ${dir} appartient au profil « ${meta.name} »`);
    return this.info(dir, meta);
  }

  /** Profils triés par nom. Les dossiers cachés (.tmp, imports en cours) et sans profile.json sont ignorés. */
  list(): ProfileInfo[] {
    if (!existsSync(this.root)) return [];
    const out: ProfileInfo[] = [];
    for (const e of readdirSync(this.root, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const dir = join(this.root, e.name);
      const meta = this.readMeta(dir);
      if (meta !== undefined) out.push(this.info(dir, meta));
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  create(name: string, opts: { useWhen?: string | undefined }): ProfileInfo {
    const dir = this.dirFor(name);
    if (existsSync(dir)) throw new GraspError(409, `le profil « ${name} » existe déjà`);
    this.ensureRoot();
    mkdirSync(dir, { mode: 0o700 });
    if (this.posix) chmodSync(dir, 0o700);
    const meta: ProfileMeta = {
      id: profileId(name), name, createdAt: new Date().toISOString(), lastUsedAt: null, source: 'created',
      ...(opts.useWhen !== undefined && opts.useWhen !== '' ? { useWhen: opts.useWhen } : {}),
    };
    this.writeMeta(dir, meta);
    return this.info(dir, meta);
  }

  /** Profil existant, ou créé à la volée. */
  ensure(name: string): { profile: ProfileInfo; created: boolean } {
    const p = this.get(name);
    return p !== undefined ? { profile: p, created: false } : { profile: this.create(name, {}), created: true };
  }

  touch(name: string): void {
    const dir = this.dirFor(name);
    const meta = this.readMeta(dir);
    if (meta === undefined) throw new GraspError(404, `profil « ${name} » inconnu`);
    this.writeMeta(dir, { ...meta, lastUsedAt: new Date().toISOString() });
  }

  remove(name: string): void {
    const p = this.get(name);
    if (p === undefined) throw new GraspError(404, `profil « ${name} » inconnu — \`grasp profiles\``);
    rmSync(p.path, { recursive: true, force: true });
  }

  /**
   * Import depuis un répertoire de données Chrome, la source n'étant JAMAIS modifiée :
   * - complet : copie de tout le répertoire (hors caches et verrous) ;
   * - un seul profil (profileDirectory, ex. « Profile 9 ») : le sous-dossier devient Default/, avec un
   *   Local State minimal qui garde os_crypt (clé des cookies) et l'entrée info_cache renommée Default.
   * Copie dans un dossier caché puis renommage : un import avorté ne laisse rien.
   */
  async importProfile(name: string, sourcePath: string, opts: ImportOptions): Promise<ImportResult> {
    const dir = this.dirFor(name);
    if (existsSync(dir)) throw new GraspError(409, `le profil « ${name} » existe déjà`);
    const src = resolve(sourcePath);
    const st = await lstat(src).catch(() => undefined);
    if (st === undefined) throw new GraspError(400, `source introuvable : ${src}`);
    if (st.isSymbolicLink()) throw new GraspError(400, `source refusée : ${src} est un lien symbolique`);
    if (!st.isDirectory()) throw new GraspError(400, `source refusée : ${src} n'est pas un répertoire`);

    const pd = opts.profileDirectory;
    let copyFrom = src;
    let localState: Record<string, unknown> | undefined;
    const warnings: string[] = [];
    const lsFile = join(src, 'Local State');
    const sourceLs = existsSync(lsFile) ? readJsonFile(lsFile) : undefined;
    if (pd !== undefined) {
      if (pd === '' || pd === '.' || pd === '..' || /[\\/]/.test(pd)) throw new GraspError(400, `--profile-directory invalide : ${JSON.stringify(pd)} (un nom de sous-dossier, ex. "Profile 9")`);
      copyFrom = join(src, pd);
      const pst = await lstat(copyFrom).catch(() => undefined);
      if (pst === undefined || !pst.isDirectory() || pst.isSymbolicLink() || !isProfileDir(copyFrom)) {
        const avail = readdirSync(src).filter((n) => isProfileDir(join(src, n)));
        throw new GraspError(400, `« ${pd} » n'est pas un profil Chrome de ${src} (pas de Preferences) ; profils disponibles : ${avail.join(', ') || '(aucun)'}`);
      }
      if (existsSync(lsFile)) {
        let ls: unknown;
        try { ls = JSON.parse(readFileSync(lsFile, 'utf8')); } catch (e) { throw new GraspError(400, `${lsFile} illisible : ${(e as Error).message}`); }
        const full = obj(ls);
        const entry = obj(obj(obj(full.profile).info_cache)[pd]);
        localState = {
          ...(full.os_crypt !== undefined ? { os_crypt: full.os_crypt } : {}),
          profile: { info_cache: { Default: entry }, last_used: 'Default', profiles_order: ['Default'] },
        };
      } else if (!this.posix) {
        warnings.push(`${src} n'a pas de « Local State » : la clé de chiffrement (os_crypt) n'est pas copiée, chrome.exe ne pourra pas déchiffrer les cookies ni les identifiants importés — le profil s'ouvrira déconnecté de tous les sites. Importez depuis le répertoire « User Data » complet d'origine.`);
      }
    } else {
      const profiles = readdirSync(src).filter((n) => isProfileDir(join(src, n)));
      if (!existsSync(join(src, 'Local State')) || profiles.length === 0) {
        throw new GraspError(400, `${src} ne ressemble pas à un répertoire de données de profil Chrome (attendu : « Local State » et un profil Default/ ou « Profile N »/ avec Preferences)`);
      }
    }

    this.ensureRoot();
    const tmp = join(this.root, `.import-${profileId(name)}-${randomBytes(4).toString('hex')}`);
    const locked: string[] = [];
    try {
      await mkdir(tmp, { mode: 0o700 });
      const dest = pd !== undefined ? join(tmp, 'Default') : tmp;
      const prefix = pd !== undefined ? 'Default' : '';
      await this.copyTree(copyFrom, dest, '', prefix, locked);
      if (locked.length > 0 && opts.skipLocked !== true) {
        throw new GraspError(409, `${locked.length} fichier(s) verrouillé(s) ou illisible(s) dans ${src} : ${locked.join(', ')} — Chrome utilise sans doute ce profil : fermez Chrome puis relancez l'import (ou --skip-locked pour importer sans ces fichiers)`);
      }
      if (localState !== undefined) await writeFile(join(tmp, 'Local State'), `${JSON.stringify(localState)}\n`, { mode: 0o600 });
      const meta: ProfileMeta = {
        id: profileId(name), name, createdAt: new Date().toISOString(), lastUsedAt: null, source: 'imported', importedFrom: copyFrom,
      };
      this.writeMeta(tmp, meta);
      await rename(tmp, dir);
      const profile = this.info(dir, meta);
      if (this.posix && windowsEncryptedSource(src, sourceLs)) {
        warnings.push(`${src} vient de Chrome Windows : cookies et identifiants sont chiffrés par DPAPI (clé app-bound), illisibles par le Chrome Linux — le profil s'ouvrira déconnecté de tous les sites${profile.accountEmail !== null ? `, même si le compte ${profile.accountEmail} est affiché` : ''}. Pour garder les connexions, utilisez le mode Windows (chromePath = chrome.exe sous WSL2).`);
      }
      return { profile, skipped: locked, warnings };
    } catch (e) {
      await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
      if (e instanceof GraspError) throw e;
      throw new GraspError(500, `import de ${src} impossible : ${(e as Error).message}`);
    }
  }

  private async copyTree(from: string, to: string, rel: string, prefix: string, locked: string[]): Promise<void> {
    await mkdir(to, { recursive: true, mode: 0o700 });
    if (this.posix) await chmod(to, 0o700);
    let entries;
    try { entries = await readdir(from, { withFileTypes: true }); } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? '';
      if (LOCK_CODES.has(code)) { locked.push(join(prefix, rel)); return; }
      throw e;
    }
    for (const e of entries) {
      const r = rel === '' ? e.name : `${rel}/${e.name}`;
      if (excluded(r, e.name)) continue;
      const s = join(from, e.name);
      if (e.isSymbolicLink()) throw new GraspError(400, `lien symbolique refusé dans le profil importé : ${s}`);
      if (e.isDirectory()) { await this.copyTree(s, join(to, e.name), r, prefix, locked); continue; }
      if (!e.isFile()) continue; // sockets, FIFO : rien à copier
      try {
        await copyFile(s, join(to, e.name));
        if (this.posix) await chmod(join(to, e.name), 0o600);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? '';
        if (!LOCK_CODES.has(code)) throw err;
        locked.push(prefix === '' ? r : `${prefix}/${r}`);
      }
    }
  }
}
