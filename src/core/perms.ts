import { statSync, mkdirSync, chmodSync, existsSync } from 'node:fs';

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
