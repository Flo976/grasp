import { readdirSync, readFileSync } from 'node:fs';
import { psQuote, powershellOut, realRunner, type Runner } from './windows.js';

/**
 * Mémoire d'un navigateur piloté, pour le recyclage (browserMaxRssMb).
 *
 * Linux : somme sur TOUT le groupe de processus Chrome (navigateur, zygotes, GPU, réseau, renderers). On somme la
 * PSS (`/proc/<pid>/smaps_rollup`), pas la RSS : mesuré sur un Chrome headless neuf (13 processus), la somme des
 * RSS donne ~980 Mo parce que chaque page partagée (bibliothèques, zygote) est comptée dans chaque processus, contre
 * ~160 Mo de PSS. Un seuil « 800 Mo » en somme de RSS recyclerait donc un navigateur à vide. Repli sur VmRSS si
 * smaps_rollup est illisible (noyau < 4.14) : `metric` le dit.
 */
export interface MemoryReading { mb: number; procs: number; metric: 'pss' | 'rss' | 'private' }

const kb = (text: string, re: RegExp): number | undefined => {
  const m = re.exec(text);
  return m ? Number(m[1]) : undefined;
};

/** Processus vivants (hors zombies) du groupe `pgid`, lus dans /proc. */
export function groupPids(pgid: number, procRoot = '/proc'): number[] {
  const out: number[] = [];
  for (const name of readdirSync(procRoot)) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`${procRoot}/${name}/stat`, 'utf8');
      // comm peut contenir des espaces et des parenthèses : on coupe après la DERNIÈRE parenthèse.
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (rest[0] !== 'Z' && Number(rest[2]) === pgid) out.push(Number(name));
    } catch { /* processus disparu entre-temps */ }
  }
  return out;
}

/** Mémoire du groupe de processus Chrome (Linux). null si le groupe est vide (navigateur déjà parti). */
export function linuxGroupMemory(pgid: number, procRoot = '/proc'): MemoryReading | null {
  if (!(pgid > 1)) return null;
  let total = 0;
  let procs = 0;
  let metric: 'pss' | 'rss' = 'pss';
  for (const pid of groupPids(pgid, procRoot)) {
    let v: number | undefined;
    if (metric === 'pss') {
      try { v = kb(readFileSync(`${procRoot}/${pid}/smaps_rollup`, 'utf8'), /^Pss:\s+(\d+) kB/m); } catch { v = undefined; }
      if (v === undefined && procs === 0) metric = 'rss';
    }
    if (metric === 'rss') {
      try { v = kb(readFileSync(`${procRoot}/${pid}/status`, 'utf8'), /^VmRSS:\s+(\d+) kB/m); } catch { v = undefined; }
    }
    if (v === undefined) continue;
    total += v;
    procs++;
  }
  return procs === 0 ? null : { mb: Math.round(total / 1024), procs, metric };
}

/**
 * chrome.exe (WSL2) : pas de groupe Linux. Somme de `PrivatePageCount` (octets privés engagés, l'équivalent le plus
 * proche de la PSS sans compteurs de performance, trop lents) des chrome.exe dont la ligne de commande porte
 * EXACTEMENT ce --user-data-dir (même filtre que l'arrêt forcé). Un appel PowerShell coûte ~1 s : l'appelant
 * le fait en arrière-plan.
 */
export function windowsMemoryScript(winDir: string): string {
  return [
    `$d = ${psQuote(winDir.replace(/[\\/]+$/, ''))}`,
    "$re = '--user-data-dir=' + [regex]::Escape($d) + '(\\s|$)'",
    "$p = @(Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.CommandLine -and (($_.CommandLine -replace '\"','') -match $re) })",
    "Write-Output (\"{0} {1}\" -f $p.Count, (($p | Measure-Object -Property PrivatePageCount -Sum).Sum + 0))",
  ].join('\n');
}

export async function windowsChromeMemory(winDir: string, run: Runner = realRunner): Promise<MemoryReading | null> {
  const out = (await powershellOut(windowsMemoryScript(winDir), run)).trim().split(/\r?\n/).at(-1) ?? '';
  const m = /^(\d+) (\d+)$/.exec(out.trim());
  if (!m) throw new Error(`mesure mémoire de chrome.exe illisible : ${JSON.stringify(out)}`);
  const procs = Number(m[1]);
  return procs === 0 ? null : { mb: Math.round(Number(m[2]) / 1024 / 1024), procs, metric: 'private' };
}
