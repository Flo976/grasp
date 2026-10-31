import { join } from 'node:path';
import { homedir } from 'node:os';

export interface GraspPaths {
  configDir: string;
  configFile: string;
  tokenFile: string;
  stateDir: string;
  logDir: string;
  pidFile: string;
  endpointFile: string;
  instancesFile: string;
  dataDir: string;
  profilesDir: string;
  tmpProfilesDir: string;
  runDir: string;
  socketPath: string;
  bridgesDir: string;
  systemdUserDir: string;
}

function xdg(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const v = env[name];
  // La spec XDG impose un chemin absolu ; une valeur relative est ignorée.
  return v !== undefined && v.startsWith('/') ? v : fallback;
}

/** Chemins XDG. Jamais ~/.grasp. */
export function resolvePaths(env: NodeJS.ProcessEnv = process.env, home: string = env.HOME ?? homedir()): GraspPaths {
  const configHome = xdg(env, 'XDG_CONFIG_HOME', join(home, '.config'));
  const stateHome = xdg(env, 'XDG_STATE_HOME', join(home, '.local', 'state'));
  const dataHome = xdg(env, 'XDG_DATA_HOME', join(home, '.local', 'share'));
  const configDir = join(configHome, 'grasp');
  const stateDir = join(stateHome, 'grasp');
  const dataDir = join(dataHome, 'grasp');
  const runtime = env.XDG_RUNTIME_DIR !== undefined && env.XDG_RUNTIME_DIR.startsWith('/') ? env.XDG_RUNTIME_DIR : undefined;
  const runDir = runtime !== undefined ? join(runtime, 'grasp') : join(stateDir, 'run');
  return {
    configDir,
    configFile: join(configDir, 'config.json'),
    tokenFile: join(configDir, 'token'),
    stateDir,
    logDir: join(stateDir, 'logs'),
    pidFile: join(stateDir, 'grasp.pid'),
    endpointFile: join(stateDir, 'endpoint.json'),
    instancesFile: join(stateDir, 'instances.json'),
    dataDir,
    profilesDir: join(dataDir, 'profiles'),
    tmpProfilesDir: join(dataDir, 'tmp-profiles'),
    runDir,
    socketPath: runtime !== undefined ? join(runtime, 'grasp.sock') : join(runDir, 'grasp.sock'),
    bridgesDir: join(runDir, 'bridges'),
    systemdUserDir: join(configHome, 'systemd', 'user'),
  };
}
