import { readFileSync } from 'node:fs';
import { isProcessAlive } from './procutil.js';

/** Entrée de instances.json (les champs userDataDir/ephemeral manquent dans l'ancien format). */
export interface InstanceRecord {
  id: string;
  bridgePid: number;
  chromePgid: number;
  userDataDir?: string;
  ephemeral?: boolean;
  windowsUserDataDir?: string;
}

export interface StaleDeps {
  log: (m: string) => void;
  /** chrome.exe : arrêt ciblé sur ce --user-data-dir (PowerShell). */
  reapWindows: (winDir: string) => Promise<void>;
  removeDir: (dir: string) => void;
  /** Ligne de commande brute d'un pid (null s'il n'existe pas) : injectable pour les tests. */
  cmdline?: (pid: number) => string | null;
}

const procCmdline = (pid: number): string | null => {
  try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch { return null; }
};

function groupAlive(pgid: number): boolean {
  try { process.kill(-pgid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

export function readInstances(file: string): InstanceRecord[] {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch { return []; }
  if (!Array.isArray(raw)) return [];
  return raw.filter((r): r is InstanceRecord => r !== null && typeof r === 'object' && typeof (r as InstanceRecord).id === 'string');
}

/**
 * Au démarrage : instances laissées par un serveur tué (SIGKILL, OOM, redémarrage systemd). Le fichier
 * serait sinon écrasé par la liste vide et plus aucun outil ne retrouverait ces navigateurs.
 * - chrome.exe : visé par son --user-data-dir Windows (il survit à son groupe Linux) ;
 * - Chrome Linux (snap/flatpak sans PDEATHSIG) : groupe tué seulement si son leader porte encore CE
 *   --user-data-dir (un pid recyclé n'est jamais touché) ;
 * - bridge : tué seulement si c'est encore un bridge Grasp ;
 * - profils éphémères supprimés.
 */
export async function reapStaleInstances(file: string, deps: StaleDeps): Promise<number> {
  const list = readInstances(file);
  if (list.length === 0) return 0;
  const cmd = deps.cmdline ?? procCmdline;
  deps.log(`${list.length} instance(s) laissée(s) par un serveur précédent : arrêt des navigateurs orphelins`);
  for (const i of list) {
    if (typeof i.bridgePid === 'number' && i.bridgePid > 1 && isProcessAlive(i.bridgePid) && /bridge[\\/]main\.js/.test(cmd(i.bridgePid) ?? '')) {
      try { process.kill(i.bridgePid, 'SIGKILL'); } catch { /* parti entre-temps */ }
    }
    const pgid = i.chromePgid;
    if (typeof pgid === 'number' && pgid > 1 && typeof i.userDataDir === 'string' && (cmd(pgid) ?? '').includes(`--user-data-dir=${i.userDataDir}`)) {
      try { process.kill(-pgid, 'SIGKILL'); } catch { /* groupe déjà vide */ }
      const end = Date.now() + 3000;
      while (groupAlive(pgid) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
      deps.log(`instance ${i.id} : groupe Chrome ${pgid} orphelin tué`);
    }
    if (typeof i.windowsUserDataDir === 'string') await deps.reapWindows(i.windowsUserDataDir);
    if (i.ephemeral === true && typeof i.userDataDir === 'string') deps.removeDir(i.userDataDir);
  }
  return list.length;
}
