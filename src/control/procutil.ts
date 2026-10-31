import { readFileSync } from 'node:fs';

/** Vivant et pas zombie (Linux : /proc ; ailleurs : kill 0). */
export function isProcessAlive(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2)[0] !== 'Z';
  } catch {
    if (process.platform === 'linux') return false;
    try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
  }
}

/** Le pid est-il bien un `grasp serve` (évite de tuer un processus qui aurait recyclé le pid) ? */
export function isGraspServer(pid: number): boolean {
  try {
    const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
    return argv.includes('serve') && argv.some((a) => /grasp|main\.js$/.test(a));
  } catch { return process.platform !== 'linux'; }
}
