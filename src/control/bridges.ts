import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { DiscoveredBrowser } from '../browser/discover.js';
import type { EffectivePolicy } from '../core/policy.js';
import type { Limits } from '../core/limits.js';
import { checkSocketPath } from '../core/paths.js';
import { killWindowsChrome } from '../browser/windows.js';

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
  /** Captures sans -o (côté Linux, même en mode Windows ou attach). */
  capturesDir?: string;
  /** Limites de lecture (snap, text, --snap-diff) et plafond de stabilité, lus une fois au démarrage. */
  limits?: Limits;
}

export interface BridgeHandle {
  id: string;
  pid: number;
  chromePid: number;
  chromePgid: number;
  socketPath: string;
  version: string;
  warnings: string[];
  /** chrome.exe (WSL2) : --user-data-dir Windows, pour retrouver le navigateur si le bridge meurt. */
  windowsUserDataDir?: string;
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

/** chrome.exe survit à son bridge (pas de PDEATHSIG au-delà de WSL) : on le retrouve par son --user-data-dir. */
export async function reapWindows(winDir: string | undefined, log: (m: string) => void = () => undefined): Promise<void> {
  if (winDir === undefined) return;
  try {
    const n = await killWindowsChrome(winDir);
    if (n > 0) log(`chrome.exe orphelin (${winDir}) : ${n} processus Windows tué(s)`);
  } catch (e) { log(`ERREUR : impossible de tuer chrome.exe (${winDir}) : ${(e as Error).message}`); }
}

function killGroupNow(pgid: number): void {
  // pgid 0 = « pas de groupe à nous » (mode attach). kill(-0) viserait NOTRE groupe : interdit.
  if (!(pgid > 1)) return;
  try { process.kill(-pgid, 'SIGKILL'); } catch { /* groupe déjà vide */ }
}

export interface SpawnBridgeOptions {
  reapOnExit?: boolean;
  startTimeoutMs?: number;
  onExit?: (code: number | null) => void;
  log?: (m: string) => void;
  /** Tests : processus bridge à lancer, et ramassage de chrome.exe (par défaut PowerShell). */
  bridgeMain?: string;
  reap?: (winDir: string, log: (m: string) => void) => Promise<void>;
}

export function spawnBridge(init: BridgeInit, opts: SpawnBridgeOptions = {}): Promise<BridgeHandle> {
  try { checkSocketPath(init.socketPath, 'du bridge'); } catch (e) { return Promise.reject(e); }
  const child = spawn(process.execPath, [opts.bridgeMain ?? BRIDGE_MAIN], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], env: process.env });
  const log = opts.log ?? (() => undefined);
  const reap = opts.reap ?? ((d: string, l: (m: string) => void) => reapWindows(d, l));
  return new Promise((resolve, reject) => {
    let settled = false;
    let chromePgid: number | undefined;
    let windowsUserDataDir: string | undefined;
    let stopping: Promise<number | null> | undefined;
    let reaping: Promise<void> | undefined;
    /** Un seul ramassage de chrome.exe par bridge, partagé par stop() et le gestionnaire de sortie. */
    const reapOnce = (): Promise<void> => {
      if (windowsUserDataDir === undefined) return Promise.resolve();
      const dir = windowsUserDataDir;
      reaping ??= reap(dir, log).catch((e: Error) => log(`ERREUR : impossible de tuer chrome.exe (${dir}) : ${e.message}`));
      return reaping;
    };
    const timer = setTimeout(() => fail(new Error(`le bridge n'a pas démarré en ${opts.startTimeoutMs ?? 45_000} ms`)), opts.startTimeoutMs ?? 45_000);
    const fail = (e: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      reject(e);
    };
    child.on('message', (m: { type: string; message?: string; pid: number; chromePid: number; chromePgid: number; version: string; warnings: string[]; windowsUserDataDir?: string }) => {
      if (m.type === 'error') { fail(new Error(m.message ?? 'échec du bridge')); return; }
      if (m.type !== 'ready' || settled) return;
      settled = true;
      clearTimeout(timer);
      chromePgid = m.chromePgid;
      windowsUserDataDir = m.windowsUserDataDir;
      const win = m.windowsUserDataDir;
      const handle: BridgeHandle = {
        id: init.id, pid: m.pid, chromePid: m.chromePid, chromePgid: m.chromePgid, socketPath: init.socketPath,
        version: m.version, warnings: m.warnings, child,
        ...(win !== undefined ? { windowsUserDataDir: win } : {}),
        stop(timeoutMs = win !== undefined ? 30_000 : 10_000) {
          stopping ??= (async () => {
            let code: number | null;
            if (child.exitCode !== null || child.signalCode !== null) {
              killGroupNow(m.chromePgid);
              code = child.exitCode;
            } else {
              child.kill('SIGTERM');
              const r = await waitExit(child, timeoutMs);
              if (r === 'timeout') {
                child.kill('SIGKILL');
                killGroupNow(m.chromePgid);
                await waitExit(child, 3000);
                code = null;
              } else code = r;
            }
            // chrome.exe ne meurt pas avec le groupe Linux : tout arrêt non propre du bridge (SIGKILL,
            // chien de garde, échec de Stop-Process…) peut le laisser vivant → on le vise par son --user-data-dir.
            if (code !== 0) await reapOnce();
            return code;
          })();
          return stopping;
        },
      };
      resolve(handle);
    });
    child.once('exit', (code) => {
      // Ceinture et bretelles : si le bridge meurt, on tue le groupe Chrome qu'il détenait.
      if (opts.reapOnExit !== false && chromePgid !== undefined) killGroupNow(chromePgid);
      if (!settled) fail(new Error(`le bridge s'est arrêté au démarrage (code ${code})`));
      // Mort inattendue (pas un stop demandé) : chrome.exe serait orphelin côté Windows. Le profil n'est
      // libéré (onExit) qu'une fois chrome.exe tué, sinon une nouvelle session sur ce profil serait
      // tuée par le Stop-Process différé (il vise tout ce --user-data-dir).
      if (opts.reapOnExit !== false && stopping === undefined && code !== 0 && windowsUserDataDir !== undefined) {
        void reapOnce().finally(() => opts.onExit?.(code));
        return;
      }
      opts.onExit?.(code);
    });
    child.send({ type: 'init', init });
  });
}
