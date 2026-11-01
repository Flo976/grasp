import { statSync, mkdirSync, chmodSync, existsSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

export interface PermTarget { path: string; kind: 'file' | 'dir' }

/**
 * Refuse de démarrer si un fichier sensible est plus permissif que 0600 (répertoire : 0700)
 * ou n'appartient pas à l'utilisateur. On n'avertit pas : on refuse.
 */
export function checkPermissions(targets: PermTarget[]): void {
  const problems: string[] = [];
  const uid = process.getuid?.();
  for (const t of targets) {
    let st;
    try { st = statSync(t.path); } catch { continue; }
    const mode = st.mode & 0o777;
    const want = t.kind === 'dir' ? 0o700 : 0o600;
    if (mode & 0o077) problems.push(`${t.path} est en ${mode.toString(8).padStart(4, '0')} (attendu ${want.toString(8).padStart(4, '0')}) → chmod ${want.toString(8)} ${t.path}`);
    if (uid !== undefined && st.uid !== uid) problems.push(`${t.path} appartient à l'uid ${st.uid}, pas à ${uid} → chown`);
  }
  if (problems.length) throw new Error(`permissions trop ouvertes, démarrage refusé :\n  ${problems.join('\n  ')}`);
}

/** Crée un répertoire privé (0700, indépendamment de l'umask). */
export function ensurePrivateDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

/**
 * Écrit `data` dans `path` en 0600, quel que soit l'état antérieur : fichier temporaire créé en exclusif
 * (O_EXCL, qui ne suit jamais un lien) dans le même répertoire, puis renommé par-dessus la cible. Un fichier
 * existant (même en 0644) est remplacé par un fichier 0600 ; un lien symbolique est remplacé, sa cible
 * n'est jamais écrite. Un échec lève et ne laisse pas de fichier temporaire.
 */
export function writePrivateFile(path: string, data: Buffer): void {
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}
