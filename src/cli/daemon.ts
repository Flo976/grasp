import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GraspPaths } from '../core/paths.js';

export const UNIT_NAME = 'grasp.service';

function systemctl(env: NodeJS.ProcessEnv): string { return env.GRASP_SYSTEMCTL ?? 'systemctl'; }

/** systemd user joignable ? (absent en conteneur ou sous WSL sans systemd) */
export function systemdStatus(env: NodeJS.ProcessEnv): { ok: boolean; reason: string } {
  const r = spawnSync(systemctl(env), ['--user', 'show-environment'], { env, encoding: 'utf8', timeout: 10_000 });
  if (r.error) return { ok: false, reason: `${systemctl(env)} introuvable (${(r.error as NodeJS.ErrnoException).code ?? r.error.message})` };
  if (r.status !== 0) return { ok: false, reason: (r.stderr || r.stdout || `code ${r.status}`).trim() };
  return { ok: true, reason: 'systemd --user disponible' };
}

const q = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;

export function unitContent(nodePath: string, cliPath: string, env: NodeJS.ProcessEnv): string {
  const envLines = ['PATH', 'GRASP_CHROME'].filter((k) => env[k]).map((k) => `Environment=${q(`${k}=${env[k]}`)}`);
  return `[Unit]
Description=Grasp — contrôle de navigateur pour agents IA
Documentation=https://github.com/ (voir README)

[Service]
Type=simple
ExecStart=${q(nodePath)} ${q(cliPath)} serve
Restart=on-failure
RestartSec=2
# L'arrêt tue tout le cgroup : control plane, bridges et groupes Chrome.
KillMode=control-group
KillSignal=SIGTERM
TimeoutStopSec=20
UMask=0077
${envLines.join('\n')}

[Install]
WantedBy=default.target
`;
}

function run(env: NodeJS.ProcessEnv, args: string[]): void {
  const r = spawnSync(systemctl(env), ['--user', ...args], { env, encoding: 'utf8', timeout: 30_000 });
  if (r.error || r.status !== 0) throw new Error(`systemctl --user ${args.join(' ')} a échoué : ${(r.stderr || r.error?.message || `code ${r.status}`).trim()}`);
}

const FOREGROUND_HINT = 'Pas de systemd utilisateur ici (conteneur ?). Lancez le serveur au premier plan avec `grasp serve` (sous un superviseur : tini, s6, docker --init…).';

/** N'implémente pas de supervision : délègue à systemd, ou refuse en proposant le premier plan. */
export function installDaemon(paths: GraspPaths, env: NodeJS.ProcessEnv, nodePath: string, cliPath: string): string {
  const st = systemdStatus(env);
  if (!st.ok) throw new Error(`${st.reason}. ${FOREGROUND_HINT}`);
  mkdirSync(paths.systemdUserDir, { recursive: true });
  const unit = join(paths.systemdUserDir, UNIT_NAME);
  writeFileSync(unit, unitContent(nodePath, cliPath, env), { mode: 0o644 });
  run(env, ['daemon-reload']);
  run(env, ['enable', '--now', UNIT_NAME]);
  return unit;
}

export function uninstallDaemon(paths: GraspPaths, env: NodeJS.ProcessEnv): void {
  const st = systemdStatus(env);
  if (!st.ok) throw new Error(`${st.reason}. ${FOREGROUND_HINT}`);
  const unit = join(paths.systemdUserDir, UNIT_NAME);
  if (!existsSync(unit)) throw new Error(`${unit} absent : rien à désinstaller`);
  run(env, ['disable', '--now', UNIT_NAME]);
  rmSync(unit);
  run(env, ['daemon-reload']);
}
