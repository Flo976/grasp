import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, accessSync, constants } from 'node:fs';
import { freeLocalPort, killGroup, type ChromeProcess } from './launch.js';

/**
 * Moteur expérimental Lightpanda (évaluation, branche eval-lightpanda) : navigateur sans interface en Zig,
 * piloté en CDP. Activé par GRASP_ENGINE=lightpanda ; binaire : GRASP_LIGHTPANDA (chemin absolu).
 * Lancé comme Chrome : dans son propre groupe de processus, sur 127.0.0.1 seulement, télémétrie coupée.
 * Pas de profil (--user-data-dir sans équivalent) : chaque connexion CDP est un contexte vierge.
 */
export function lightpandaEngine(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.GRASP_ENGINE !== 'lightpanda') return null;
  const bin = env.GRASP_LIGHTPANDA;
  if (bin === undefined || bin === '') throw new Error('GRASP_ENGINE=lightpanda : indiquez le binaire dans GRASP_LIGHTPANDA (chemin absolu)');
  if (!existsSync(bin)) throw new Error(`GRASP_LIGHTPANDA : ${bin} introuvable`);
  accessSync(bin, constants.X_OK);
  return bin;
}

/** Version annoncée par /json/version (« Lightpanda-Version »). */
export async function lightpandaVersion(port: number): Promise<{ wsUrl: string; version: string } | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
    if (!r.ok) return null;
    const j = await r.json() as { webSocketDebuggerUrl?: string; 'Lightpanda-Version'?: string; Browser?: string };
    if (j.webSocketDebuggerUrl === undefined) return null;
    return { wsUrl: j.webSocketDebuggerUrl, version: `Lightpanda/${j['Lightpanda-Version'] ?? j.Browser ?? '?'}` };
  } catch { return null; }
}

/** Options Lightpanda supplémentaires (GRASP_LIGHTPANDA_ARGS, séparées par des espaces), ex. « --load-resources stylesheet ». */
function envArgs(): string[] {
  const raw = process.env.GRASP_LIGHTPANDA_ARGS;
  return raw === undefined ? [] : raw.split(' ').filter((a) => a !== '');
}

export async function launchLightpanda(opts: { bin: string; stderrLog?: string; timeoutMs?: number; extraArgs?: string[] }): Promise<ChromeProcess> {
  const port = await freeLocalPort();
  const args = ['serve', '--host', '127.0.0.1', '--port', String(port), '--log-level', 'warn', ...(opts.extraArgs !== undefined ? opts.extraArgs : envArgs())];
  const child = spawn(opts.bin, args, {
    detached: true, stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, LIGHTPANDA_DISABLE_TELEMETRY: 'true' },
  });
  if (opts.stderrLog !== undefined) child.stderr!.pipe(createWriteStream(opts.stderrLog, { flags: 'a', mode: 0o600 }));
  else child.stderr!.resume();
  const pid = child.pid;
  if (pid === undefined) throw new Error(`Lightpanda : lancement impossible (${opts.bin})`);
  const end = Date.now() + (opts.timeoutMs ?? 10_000);
  let found: { wsUrl: string; version: string } | null = null;
  while (Date.now() < end && child.exitCode === null) {
    found = await lightpandaVersion(port);
    if (found !== null) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  if (found === null) {
    await killGroup(pid, 2000).catch(() => undefined);
    throw new Error(`Lightpanda ne répond pas sur 127.0.0.1:${port} (code ${child.exitCode})`);
  }
  return {
    pid, pgid: pid, wsUrl: found.wsUrl, port, version: found.version, child,
    kill: async (timeoutMs = 5000) => { await killGroup(pid, timeoutMs); },
  };
}
