import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { DiscoveredBrowser } from '../browser/discover.js';
import type { EffectivePolicy } from '../core/policy.js';

export interface BridgeInit {
  id: string;
  socketPath: string;
  /** Absent en mode attach. */
  browser?: DiscoveredBrowser;
  /** Mode attach : URL DevTools d'un navigateur existant, jamais tué par Grasp. */
  attach?: string;
  userDataDir: string;
  headless: boolean;
  policy: Readonly<EffectivePolicy>;
  downloadDir?: string;
  stderrLog?: string;
}

export interface BridgeHandle {
  id: string;
  pid: number;
  chromePid: number;
  chromePgid: number;
  socketPath: string;
  version: string;
  warnings: string[];
  child: ChildProcess;
  /** SIGTERM, puis SIGKILL du bridge et du groupe Chrome si nécessaire. Retourne le code de sortie, null si forcé. */
  stop(timeoutMs?: number): Promise<number | null>;
}

const BRIDGE_MAIN = fileURLToPath(new URL('../bridge/main.js', import.meta.url));

function waitExit(child: ChildProcess, timeoutMs: number): Promise<number | null | 'timeout'> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve('timeout'), timeoutMs);
    child.once('exit', (code) => { clearTimeout(t); resolve(code); });
  });
}

function killGroupNow(pgid: number): void {
  // pgid 0 = « pas de groupe à nous » (mode attach). kill(-0) viserait NOTRE groupe : interdit.
  if (!(pgid > 1)) return;
  try { process.kill(-pgid, 'SIGKILL'); } catch { /* groupe déjà vide */ }
}

export function spawnBridge(init: BridgeInit, opts: { reapOnExit?: boolean; startTimeoutMs?: number; onExit?: (code: number | null) => void } = {}): Promise<BridgeHandle> {
  const child = spawn(process.execPath, [BRIDGE_MAIN], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], env: process.env });
  return new Promise((resolve, reject) => {
    let settled = false;
    let chromePgid: number | undefined;
    const timer = setTimeout(() => fail(new Error(`le bridge n'a pas démarré en ${opts.startTimeoutMs ?? 45_000} ms`)), opts.startTimeoutMs ?? 45_000);
    const fail = (e: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      reject(e);
    };
    child.on('message', (m: { type: string; message?: string; pid: number; chromePid: number; chromePgid: number; version: string; warnings: string[] }) => {
      if (m.type === 'error') { fail(new Error(m.message ?? 'échec du bridge')); return; }
      if (m.type !== 'ready' || settled) return;
      settled = true;
      clearTimeout(timer);
      chromePgid = m.chromePgid;
      const handle: BridgeHandle = {
        id: init.id, pid: m.pid, chromePid: m.chromePid, chromePgid: m.chromePgid, socketPath: init.socketPath,
        version: m.version, warnings: m.warnings, child,
        async stop(timeoutMs = 10_000) {
          if (child.exitCode !== null || child.signalCode !== null) { killGroupNow(m.chromePgid); return child.exitCode; }
          child.kill('SIGTERM');
          const r = await waitExit(child, timeoutMs);
          if (r !== 'timeout') return r;
          child.kill('SIGKILL');
          killGroupNow(m.chromePgid);
          await waitExit(child, 3000);
          return null;
        },
      };
      resolve(handle);
    });
    child.once('exit', (code) => {
      // Ceinture et bretelles : si le bridge meurt, on tue le groupe Chrome qu'il détenait.
      if (opts.reapOnExit !== false && chromePgid !== undefined) killGroupNow(chromePgid);
      if (!settled) fail(new Error(`le bridge s'est arrêté au démarrage (code ${code})`));
      opts.onExit?.(code);
    });
    child.send({ type: 'init', init });
  });
}
