import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { readFileSync, rmSync, statfsSync, existsSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { realProbe, type DiscoveredBrowser } from './discover.js';

export const MIN_CHROME_MAJOR = 112;
export const MIN_SHM_BYTES = 256 * 1024 * 1024;

export interface ChromeArgsInput {
  userDataDir: string;
  headless: boolean;
  env: NodeJS.ProcessEnv;
  uid: number;
  shmBytes: number | null;
}

export function buildChromeArgs(input: ChromeArgsInput): { args: string[]; warnings: string[] } {
  const warnings: string[] = [];
  const args = [
    `--user-data-dir=${input.userDataDir}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-breakpad',
    '--disable-crash-reporter',
    '--disable-features=Translate,MediaRouter,OptimizationHints',
    '--metrics-recording-only',
    '--password-store=basic',
    '--use-mock-keychain',
  ];
  if (input.headless) args.push('--headless=new');
  if (input.uid === 0) {
    // Le sandbox Chrome échoue en root. Le désactiver en silence est interdit : opt-in explicite.
    if (input.env.GRASP_ALLOW_NO_SANDBOX !== '1') {
      throw new Error("Chrome ne peut pas utiliser son sandbox en root. Lancez Grasp avec un utilisateur non-root, ou en conteneur avec --cap-add=SYS_ADMIN. Pour désactiver le sandbox en connaissance de cause : GRASP_ALLOW_NO_SANDBOX=1.");
    }
    args.push('--no-sandbox');
    warnings.push('AVERTISSEMENT : sandbox Chrome désactivé (GRASP_ALLOW_NO_SANDBOX=1, root). Une page malveillante compromet alors le processus sans barrière. Préférez un utilisateur non-root ou --cap-add=SYS_ADMIN.');
  }
  if (input.shmBytes !== null && input.shmBytes < MIN_SHM_BYTES) {
    args.push('--disable-dev-shm-usage');
    warnings.push(`/dev/shm ne fait que ${Math.round(input.shmBytes / 1024 / 1024)} Mo (< 256 Mo) : Chrome crasherait en boucle. --disable-dev-shm-usage ajouté. Remédiation : docker run --shm-size=1g.`);
  }
  args.push('about:blank');
  return { args, warnings };
}

export function shmSize(path = '/dev/shm'): number | null {
  try {
    const s = statfsSync(path);
    return s.blocks * s.bsize;
  } catch { return null; }
}

export function parseChromeVersion(out: string): number | null {
  const m = /(?:Chrome|Chromium)[^\d]*(\d+)\.\d+/.exec(out);
  return m?.[1] !== undefined ? Number(m[1]) : null;
}

export function assertSupportedVersion(out: string): number {
  const major = parseChromeVersion(out);
  if (major === null) throw new Error(`Impossible de lire la version de Chrome (sortie : ${JSON.stringify(out.trim().slice(0, 120))}).`);
  if (major < MIN_CHROME_MAJOR) throw new Error(`Chrome ${major} n'est pas supporté : il faut Chrome ${MIN_CHROME_MAJOR}+ (--headless=new). Mettez le navigateur à jour.`);
  return major;
}

export function chromeVersion(path: string): Promise<string> {
  return new Promise((res, rej) => {
    execFile(path, ['--version'], { timeout: 15_000 }, (err, stdout) => {
      if (err) rej(new Error(`\`${path} --version\` a échoué : ${err.message}`));
      else res(stdout.trim());
    });
  });
}

export interface LaunchOptions {
  browser: DiscoveredBrowser;
  userDataDir: string;
  headless: boolean;
  env?: NodeJS.ProcessEnv;
  stderrLog?: string;
  onWarning?: (msg: string) => void;
  startTimeoutMs?: number;
}

export interface ChromeProcess {
  pid: number;
  /** Chrome est leader de son propre groupe : pgid === pid. */
  pgid: number;
  wsUrl: string;
  port: number;
  version: string;
  child: ChildProcess;
  kill(timeoutMs?: number): Promise<void>;
}

function groupAlive(pgid: number): boolean {
  try { process.kill(-pgid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

async function waitGroupGone(pgid: number, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (!groupAlive(pgid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !groupAlive(pgid);
}

/** SIGTERM au groupe, SIGKILL après délai. Lève si le groupe survit : on ne l'abandonne jamais en silence. */
export async function killGroup(pgid: number, timeoutMs = 5000): Promise<'none' | 'term' | 'kill'> {
  if (!(pgid > 1)) throw new Error(`pgid invalide : ${pgid}`);
  if (!groupAlive(pgid)) return 'none';
  try { process.kill(-pgid, 'SIGTERM'); } catch { /* déjà parti */ }
  if (await waitGroupGone(pgid, timeoutMs)) return 'term';
  try { process.kill(-pgid, 'SIGKILL'); } catch { /* déjà parti */ }
  if (await waitGroupGone(pgid, 3000)) return 'kill';
  throw new Error(`Le groupe de processus Chrome ${pgid} survit à SIGKILL.`);
}

let setprivPath: string | null | undefined;
function setpriv(): string | null {
  if (setprivPath === undefined) setprivPath = realProbe.which('setpriv');
  return setprivPath;
}

/**
 * Lance Chrome dans son propre groupe de processus (detached) pour pouvoir tuer tout l'arbre
 * (renderer, GPU, utility) par process.kill(-pgid). Si `setpriv` est disponible, Chrome reçoit
 * PR_SET_PDEATHSIG=SIGKILL : il meurt avec le bridge, même tué par SIGKILL.
 */
export async function launchChrome(opts: LaunchOptions): Promise<ChromeProcess> {
  const env = opts.env ?? process.env;
  const version = await chromeVersion(opts.browser.path);
  assertSupportedVersion(version);
  const { args, warnings } = buildChromeArgs({
    userDataDir: opts.userDataDir,
    headless: opts.headless,
    env,
    uid: process.getuid?.() ?? 1000,
    shmBytes: shmSize(),
  });
  for (const w of warnings) opts.onWarning?.(w);
  const portFile = join(opts.userDataDir, 'DevToolsActivePort');
  rmSync(portFile, { force: true });

  // PDEATHSIG survit à exec (pas à fork ni à un exec setuid) : valable pour un ELF et pour un wrapper
  // shell qui fait `exec chrome` (cas de /usr/bin/google-chrome). Snap/Flatpak passent par un binaire
  // setuid qui l'efface : là, c'est le parent qui tue le groupe (reapOnExit).
  const sp = opts.browser.kind === 'elf' || opts.browser.kind === 'script' ? setpriv() : null;
  const [cmd, argv] = sp !== null ? [sp, ['--pdeathsig', 'KILL', '--', opts.browser.path, ...args]] : [opts.browser.path, args];
  const errFd = opts.stderrLog !== undefined ? openSync(opts.stderrLog, 'a', 0o600) : 'ignore';
  const child = spawn(cmd, argv, { detached: true, stdio: ['ignore', 'ignore', errFd], env });
  if (typeof errFd === 'number') closeSync(errFd);
  const pid = child.pid;
  if (pid === undefined) throw new Error(`Impossible de lancer ${opts.browser.path}.`);

  let exited: string | null = null;
  child.once('exit', (code, sig) => { exited = `code=${code} signal=${sig}`; });

  const deadline = Date.now() + (opts.startTimeoutMs ?? 20_000);
  let content = '';
  while (Date.now() < deadline) {
    if (exited !== null) {
      throw new Error(`Chrome s'est arrêté au démarrage (${exited}). Le profil ${opts.userDataDir} est peut-être déjà utilisé par un autre Chrome. \`grasp doctor\` pour diagnostiquer.`);
    }
    if (existsSync(portFile)) {
      content = readFileSync(portFile, 'utf8');
      if (content.includes('\n')) break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  const [portLine, path] = content.split('\n');
  if (!portLine || !path) {
    await killGroup(pid).catch(() => undefined);
    throw new Error(`Chrome n'a pas exposé de port DevTools en temps voulu (profil ${opts.userDataDir}).`);
  }
  const port = Number(portLine);
  return {
    pid,
    pgid: pid,
    port,
    wsUrl: `ws://127.0.0.1:${port}${path.trim()}`,
    version,
    child,
    kill: (timeoutMs = 5000) => killGroup(pid, timeoutMs).then(() => undefined),
  };
}
