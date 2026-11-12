import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync } from 'node:fs';

export interface GraspPaths {
  configDir: string;
  configFile: string;
  tokenFile: string;
  /** Secrets (fill … secret:NOM) : 0600, hors config.json. */
  secretsFile: string;
  stateDir: string;
  logDir: string;
  pidFile: string;
  endpointFile: string;
  instancesFile: string;
  /** Captures d'écran sans -o (0700, fichiers 0600, rotation). */
  capturesDir: string;
  dataDir: string;
  profilesDir: string;
  tmpProfilesDir: string;
  runDir: string;
  socketPath: string;
  /**
   * Répertoire de repli des sockets (`/tmp/grasp-<uid>/<hash>`) quand le chemin normal dépasse la limite des
   * sockets Unix ; absent sinon. Vérifié (propriétaire, 0700, pas de lien) par le serveur ET par le client.
   */
  socketFallback?: { dir: string; original: string };
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
  let runDir = runtime !== undefined ? join(runtime, 'grasp') : join(stateDir, 'run');
  let socketPath = runtime !== undefined ? join(runtime, 'grasp.sock') : join(runDir, 'grasp.sock');
  let socketFallback: GraspPaths['socketFallback'];
  // Chemin trop long pour un socket Unix (GRASP dans un tmp profond) : repli sur un nom court et haché, propre à
  // ce chemin (deux installations distinctes ne partagent pas de socket). Client et serveur font le même calcul.
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH || Buffer.byteLength(join(runDir, 'bridges', BRIDGE_PROBE)) > MAX_SOCKET_PATH) {
    const dir = join(fallbackSocketBase(), createHash('sha256').update(socketPath).digest('hex').slice(0, 12));
    socketFallback = { dir, original: socketPath };
    runDir = dir;
    socketPath = join(dir, 'grasp.sock');
  }
  return {
    configDir,
    configFile: join(configDir, 'config.json'),
    tokenFile: join(configDir, 'token'),
    secretsFile: join(configDir, 'secrets.json'),
    stateDir,
    logDir: join(stateDir, 'logs'),
    pidFile: join(stateDir, 'grasp.pid'),
    endpointFile: join(stateDir, 'endpoint.json'),
    instancesFile: join(stateDir, 'instances.json'),
    capturesDir: join(stateDir, 'captures'),
    dataDir,
    profilesDir: join(dataDir, 'profiles'),
    tmpProfilesDir: join(dataDir, 'tmp-profiles'),
    runDir,
    socketPath,
    bridgesDir: join(runDir, 'bridges'),
    systemdUserDir: join(configHome, 'systemd', 'user'),
    ...(socketFallback !== undefined ? { socketFallback } : {}),
  };
}

/** Identifiant de session le plus long (longueur fixe) : sert à mesurer le chemin des sockets de bridge. */
const BRIDGE_PROBE = 's000000000000.sock';

/** Base du repli : `/tmp/grasp-<uid>` (jamais $TMPDIR, qui peut être lui-même profond). */
export function fallbackSocketBase(): string {
  return `/tmp/grasp-${process.getuid?.() ?? 'u'}`;
}

/**
 * Répertoire de repli des sockets : `/tmp` est partagé, donc chaque niveau (`/tmp/grasp-<uid>`, puis le
 * sous-répertoire haché) doit être un vrai répertoire (pas un lien), appartenir à l'utilisateur et être en 0700.
 * `create` : le serveur crée ce qui manque (0700) ; le client ne crée rien et vérifie seulement. Sinon : refus,
 * jamais de correction silencieuse (un répertoire d'un autre utilisateur pourrait servir de leurre au token).
 */
export function checkSocketFallbackDir(dir: string, base: string, create: boolean): void {
  const uid = process.getuid?.();
  for (const d of [base, dir]) {
    if (create) {
      try { mkdirSync(d, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    }
    let st;
    try { st = lstatSync(d); } catch { throw new Error(`répertoire de repli des sockets absent : ${d} (le serveur tourne-t-il ? \`grasp serve\`)`); }
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`répertoire de repli des sockets refusé : ${d} n'est pas un répertoire (lien ou fichier) — supprimez-le`);
    if (uid !== undefined && st.uid !== uid) throw new Error(`répertoire de repli des sockets refusé : ${d} appartient à l'uid ${st.uid}, pas à ${uid} — quelqu'un d'autre l'a créé ; supprimez-le ou raccourcissez XDG_RUNTIME_DIR`);
    if ((st.mode & 0o077) !== 0) throw new Error(`répertoire de repli des sockets refusé : ${d} est en ${(st.mode & 0o777).toString(8).padStart(4, '0')} (attendu 0700) → chmod 700 ${d}`);
  }
}

/** sun_path fait 108 octets, NUL compris : au-delà, listen() échoue avec une erreur trompeuse (EADDRINUSE…). */
export const MAX_SOCKET_PATH = 107;

/** Socket d'un bridge : un par session, sous run/bridges/. */
export function bridgeSocketPath(paths: GraspPaths, sessionId: string): string {
  return join(paths.bridgesDir, `${sessionId}.sock`);
}

const REMEDIATION = 'Remédiation : un XDG_RUNTIME_DIR plus court (ex. export XDG_RUNTIME_DIR=/run/user/$(id -u), ou /tmp/gr), ou `grasp serve --tcp` pour le socket du control plane.';

export function checkSocketPath(path: string, what: string): void {
  const n = Buffer.byteLength(path);
  if (n > MAX_SOCKET_PATH) throw new Error(`chemin du socket ${what} trop long : ${n} octets > ${MAX_SOCKET_PATH} octets (limite des sockets Unix) — ${path}. ${REMEDIATION}`);
}

/** Vérifié au démarrage du control plane : socket principal (si transport unix) ET sockets des bridges. */
export function checkSocketPaths(paths: GraspPaths, transport: 'unix' | 'tcp'): void {
  if (transport === 'unix') checkSocketPath(paths.socketPath, 'du control plane');
  // Les bridges écoutent toujours sur un socket Unix ; l'identifiant de session a une longueur fixe.
  checkSocketPath(join(paths.bridgesDir, BRIDGE_PROBE), 'des bridges');
}
