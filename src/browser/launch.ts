import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { readFileSync, rmSync, statfsSync, existsSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { realProbe, type DiscoveredBrowser } from './discover.js';
import { CdpClient } from './cdp.js';
import { buildWindowsChromeArgs, killWindowsChrome, toWindowsPath, windowsChromeAlive, windowsChromeVersion } from './windows.js';

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

/** Version du navigateur. chrome.exe : lue dans son dossier (`chrome.exe --version` ouvrirait le Chrome de l'utilisateur). */
export async function browserVersion(browser: DiscoveredBrowser): Promise<string> {
  return browser.kind === 'windows' ? windowsChromeVersion(browser.path) : chromeVersion(browser.path);
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
  /** chrome.exe (WSL2) : --user-data-dir en chemin Windows, seule prise pour le retrouver côté Windows. */
  windowsUserDataDir?: string;
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
  if (opts.browser.kind === 'windows') return launchWindowsChrome(opts);
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
  const wsUrl = `ws://127.0.0.1:${port}${path.trim()}`;
  return {
    pid,
    pgid: pid,
    port,
    wsUrl,
    version,
    child,
    // Browser.close d'abord : un SIGTERM simultané à tout le groupe tue le service réseau avant qu'il
    // n'écrive les cookies sur disque (un profil perdrait ses connexions). Puis le groupe, s'il reste.
    kill: async (timeoutMs = 5000) => {
      if (exited === null) await closeViaCdp(wsUrl, () => exited !== null, timeoutMs);
      await killGroup(pid, timeoutMs);
    },
  };
}

/** Fermeture propre par CDP (Browser.close), attend la sortie du processus navigateur. */
async function closeViaCdp(wsUrl: string, gone: () => boolean, timeoutMs: number): Promise<boolean> {
  try {
    const c = await CdpClient.connect(wsUrl);
    await c.send('Browser.close').catch(() => undefined);
    c.close();
  } catch { return gone(); }
  const end = Date.now() + timeoutMs;
  while (!gone() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  return gone();
}

async function waitPortFile(portFile: string, deadline: number, exited: () => string | null, userDataDir: string): Promise<{ port: number; path: string } | null> {
  let content = '';
  while (Date.now() < deadline) {
    const why = exited();
    if (why !== null) throw new Error(`Chrome s'est arrêté au démarrage (${why}). Le profil ${userDataDir} est peut-être déjà utilisé par un autre Chrome. \`grasp doctor\` pour diagnostiquer.`);
    if (existsSync(portFile)) {
      content = readFileSync(portFile, 'utf8');
      if (content.includes('\n')) break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  const [portLine, path] = content.split('\n');
  if (!portLine || !path) return null;
  return { port: Number(portLine), path: path.trim() };
}

/**
 * chrome.exe lancé depuis WSL2. Le processus Linux est le relais d'interop WSL : il vit tant que
 * chrome.exe vit, mais le tuer ne tue PAS chrome.exe. Arrêt : Browser.close par CDP, puis repli
 * PowerShell ciblé sur ce --user-data-dir (jamais le Chrome habituel de l'utilisateur).
 */
async function launchWindowsChrome(opts: LaunchOptions): Promise<ChromeProcess> {
  const version = windowsChromeVersion(opts.browser.path);
  assertSupportedVersion(version);
  const win = await toWindowsPath(opts.userDataDir);
  const args = buildWindowsChromeArgs({ userDataDirWin: win, headless: opts.headless });
  const portFile = join(opts.userDataDir, 'DevToolsActivePort');
  rmSync(portFile, { force: true });
  const errFd = opts.stderrLog !== undefined ? openSync(opts.stderrLog, 'a', 0o600) : 'ignore';
  const child = spawn(opts.browser.path, args, { detached: true, stdio: ['ignore', 'ignore', errFd], env: opts.env ?? process.env });
  if (typeof errFd === 'number') closeSync(errFd);
  const pid = child.pid;
  if (pid === undefined) throw new Error(`Impossible de lancer ${opts.browser.path}.`);
  let exited: string | null = null;
  child.once('exit', (code, sig) => { exited = `code=${code} signal=${sig}`; });
  const relayAlive = () => exited === null;

  const kill = async (timeoutMs = 5000): Promise<void> => {
    // 1. Fermeture propre par CDP : chrome.exe écrit ses cookies et s'arrête, le relais WSL sort.
    if (relayAlive()) await closeViaCdp(`ws://127.0.0.1:${port}${devtoolsPath}`, () => !relayAlive(), timeoutMs);
    if (!relayAlive()) return;
    // 2. Repli : tuer côté Windows les processus de CE --user-data-dir, puis le relais.
    await killWindowsChrome(win);
    try { process.kill(-pid, 'SIGKILL'); } catch { /* déjà parti */ }
    if (await windowsChromeAlive(win) > 0) throw new Error(`chrome.exe (${win}) survit à Stop-Process`);
  };

  let port = 0;
  let devtoolsPath = '';
  const found = await waitPortFile(portFile, Date.now() + (opts.startTimeoutMs ?? 30_000), () => exited, opts.userDataDir);
  if (found === null) {
    await killWindowsChrome(win).catch(() => undefined);
    try { process.kill(-pid, 'SIGKILL'); } catch { /* déjà parti */ }
    throw new Error(`chrome.exe n'a pas exposé de port DevTools en temps voulu (profil ${win}).`);
  }
  port = found.port;
  devtoolsPath = found.path;
  // Réseau WSL : chrome.exe écoute sur le 127.0.0.1 de Windows, joignable depuis WSL seulement en mode mirrored.
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  } catch (e) {
    await kill(3000).catch(() => undefined);
    throw new Error(`chrome.exe a démarré (port DevTools ${port}) mais 127.0.0.1:${port} est injoignable depuis WSL (${(e as Error).message}) : activez networkingMode=mirrored dans %USERPROFILE%\\.wslconfig puis \`wsl --shutdown\`.`);
  }
  return {
    pid, pgid: pid, port, version, child, windowsUserDataDir: win,
    wsUrl: `ws://127.0.0.1:${port}${devtoolsPath}`,
    kill,
  };
}
