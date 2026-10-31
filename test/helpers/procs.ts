import { readdirSync, readFileSync } from 'node:fs';

interface ProcInfo { pid: number; ppid: number; pgrp: number; state: string }

export function listProcs(): ProcInfo[] {
  const out: ProcInfo[] = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      // le champ comm peut contenir des espaces : on coupe après la dernière parenthèse
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      out.push({ pid: Number(name), state: rest[0] ?? '?', ppid: Number(rest[1]), pgrp: Number(rest[2]) });
    } catch { /* processus disparu entre-temps */ }
  }
  return out;
}

/** Processus vivants (hors zombies) appartenant au groupe donné. */
export function aliveInGroup(pgid: number): number[] {
  return listProcs().filter((p) => p.pgrp === pgid && p.state !== 'Z').map((p) => p.pid);
}

/** Descendants vivants d'un pid (instantané). */
export function descendants(pid: number): number[] {
  const procs = listProcs();
  const result: number[] = [];
  const queue = [pid];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const p of procs) if (p.ppid === cur) { result.push(p.pid); queue.push(p.pid); }
  }
  return result;
}

export function isAlive(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2)[0] !== 'Z';
  } catch { return false; }
}

export async function waitUntil(cond: () => boolean, timeoutMs: number, stepMs = 50): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return cond();
}
