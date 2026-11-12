import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { statfsSync, createWriteStream, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { realProbe, type DiscoveredBrowser } from './discover.js';
import { CdpClient } from './cdp.js';
import { ANTI_BACKGROUND_ARGS, ALWAYS_DISABLED_FEATURES, mergeDisableFeatures, mergeHostResolverRules, networkArgs, type NetworkOptions } from './args.js';
import { buildWindowsChromeArgs, killWindowsChrome, toWindowsPath, windowsChromeAlive, windowsChromeVersion, windowsExcludedPorts } from './windows.js';

export { ANTI_BACKGROUND_ARGS, ALWAYS_DISABLED_FEATURES, mergeDisableFeatures, mergeHostResolverRules, networkArgs, type NetworkOptions };

export const MIN_CHROME_MAJOR = 112;
export const MIN_SHM_BYTES = 256 * 1024 * 1024;
/** Lancements tentés (port pris entre son choix et l'écoute de Chrome, plage réservée) avant d'abandonner. */
export const MAX_PORT_ATTEMPTS = 3;

export interface ChromeArgsInput {
  userDataDir: string;
  headless: boolean;
  env: NodeJS.ProcessEnv;
  uid: number;
  shmBytes: number | null;
  /** Port DevTools choisi par Grasp (freeLocalPort). */
  port: number;
  /** Proxy et règles de résolution (recette à travers un tunnel SSH). */
  network?: NetworkOptions | undefined;
  /** Arguments ajoutés avant l'URL de départ (voir LaunchOptions.extraArgs). */
  extraArgs?: readonly string[] | undefined;
}

function assertPort(port: number): void {
  if (!(Number.isInteger(port) && port > 0 && port < 65536)) throw new Error(`port DevTools invalide : ${port}`);
}

export function buildChromeArgs(input: ChromeArgsInput): { args: string[]; warnings: string[] } {
  assertPort(input.port);
  const warnings: string[] = [];
  const args = [
    `--user-data-dir=${input.userDataDir}`,
    // Jamais --remote-debugging-port=0 : avec un port choisi par Chrome, navigator.webdriver vaut true
    // sur toutes les pages (mesuré, Chrome 150 Linux et Windows, fenêtré comme headless=new) et les
    // détections anti-bot refusent la page. Avec un port fixe : false.
    `--remote-debugging-port=${input.port}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-breakpad',
    '--disable-crash-reporter',
    '--disable-features=Translate,MediaRouter,OptimizationHints',
    ...ANTI_BACKGROUND_ARGS,
    '--metrics-recording-only',
    '--password-store=basic',
    '--use-mock-keychain',
    ...networkArgs(input.network),
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
  if (input.extraArgs !== undefined) args.push(...input.extraArgs);
  args.push('about:blank');
  // Un seul --disable-features et un seul --host-resolver-rules : Chrome ne retient que le dernier de chaque.
  return { args: mergeHostResolverRules(mergeDisableFeatures(args, ALWAYS_DISABLED_FEATURES)), warnings };
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
  /** Choix du port DevTools (défaut : freeLocalPort). Injectable pour les tests de course. */
  pickPort?: () => Promise<number>;
  /** Proxy et règles de résolution (mêmes drapeaux pour chrome.exe). */
  network?: NetworkOptions | undefined;
  /**
   * Arguments Chrome supplémentaires (Chrome Linux seulement), ajoutés avant l'URL de départ. Sert aux tests
   * pour simuler un réseau (--host-resolver-rules que la politique ignore) ; fusionnés avec ceux de `network`.
   */
  extraArgs?: readonly string[] | undefined;
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
// ---------- Port DevTools choisi par Grasp ----------

/** Port éphémère libre sur 127.0.0.1 (WSL2 mirrored : boucle locale partagée avec Windows). */
function ephemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Port libre pour --remote-debugging-port, hors des plages `excluded` (ports réservés par Windows).
 * Libre à l'instant du choix seulement : la course (port pris avant que Chrome n'écoute) est gérée au lancement.
 */
export async function freeLocalPort(excluded: ReadonlyArray<readonly [number, number]> = [], listen: () => Promise<number> = ephemeralPort): Promise<number> {
  for (let i = 0; i < 50; i++) {
    const port = await listen();
    if (!excluded.some(([a, b]) => port >= a && port <= b)) return port;
  }
  throw new Error(`aucun port libre sur 127.0.0.1 hors des plages réservées (${fmtRanges(excluded)})`);
}

const fmtRanges = (rs: ReadonlyArray<readonly [number, number]>) => rs.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(', ');

/** Plage éphémère de Linux (/proc/sys/net/ipv4/ip_local_port_range), défaut du noyau si illisible. */
export function linuxEphemeralRange(content?: string): [number, number] {
  let text = content;
  if (text === undefined) {
    try { text = readFileSync('/proc/sys/net/ipv4/ip_local_port_range', 'utf8'); } catch { text = ''; }
  }
  const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(text);
  return m ? [Number(m[1]), Number(m[2])] : [32768, 60999];
}

/** Ports tirés pour chrome.exe : sous la plage dynamique de Windows (49152+, ses ports éphémères). */
const WIN_PORT_LO = 20000;
const WIN_PORT_HI = 49151;

/**
 * Port pour chrome.exe lancé depuis WSL2 (mode mirrored), tiré au hasard. Mesuré :
 * - un port éphémère Linux (listen sur 0) ne convient pas : WSL réserve côté Windows la plage éphémère
 *   de Linux, chrome.exe ne peut pas y écouter (« Cannot start http server for devtools ») ;
 * - AUCUN test de bind côté Linux : un bind puis close sur 127.0.0.1:<port> laisse ce port réservé côté
 *   Windows pendant des dizaines de secondes, et chrome.exe ne peut plus y écouter ;
 * - un connect de test sur un port libre n'est pas refusé mais reste sans réponse (pas de RST) : inutile.
 * Tirage hors de la plage éphémère de Linux et des exclusions de Windows (netsh) ; un port déjà pris côté
 * Windows est signalé par chrome.exe lui-même et relancé sur un autre port (startOnOwnPort).
 */
export async function windowsFreePort(
  excluded: ReadonlyArray<readonly [number, number]>,
  linuxEphemeral: readonly [number, number] = linuxEphemeralRange(),
  isFree: (port: number) => Promise<boolean> = async () => true,
  random: () => number = Math.random,
): Promise<number> {
  const avoid = [...excluded, linuxEphemeral];
  for (let i = 0; i < 100; i++) {
    const port = WIN_PORT_LO + Math.floor(random() * (WIN_PORT_HI - WIN_PORT_LO + 1));
    if (avoid.some(([a, b]) => port >= a && port <= b)) continue;
    if (await isFree(port)) return port;
  }
  throw new Error(`aucun port libre pour chrome.exe entre ${WIN_PORT_LO} et ${WIN_PORT_HI} hors des plages réservées (${fmtRanges(avoid)})`);
}

export interface DevtoolsStderr {
  /** « DevTools listening on ws://127.0.0.1:<port>/devtools/browser/<uuid> » : l'annonce de NOTRE Chrome. */
  listening?: { host: string; port: number; path: string };
  /** Le port demandé est inutilisable (pris, réservé) : relancer sur un autre port. */
  portFailure?: string;
}

const LISTENING_RE = /DevTools listening on ws:\/\/(\[[^\]\s]+\]|[^:/\s]+):(\d+)(\/devtools\/browser\/\S+)\r?\n/;

/**
 * Lecture du stderr de Chrome au démarrage. Mesuré (Chrome 150) : port déjà pris → Linux se replie sur
 * [::1]:<port>, Windows écrit « Cannot start http server for devtools. » ; dans les deux cas Chrome
 * CONTINUE de tourner, sans DevTools joignable sur 127.0.0.1.
 */
export function parseDevtoolsStderr(text: string): DevtoolsStderr {
  if (/Cannot start http server for devtools/i.test(text)) return { portFailure: "Chrome n'a pas pu ouvrir son serveur DevTools (port déjà pris ou réservé)" };
  const m = LISTENING_RE.exec(text);
  if (!m) return {};
  const host = m[1]!;
  const port = Number(m[2]);
  if (host !== '127.0.0.1') return { portFailure: `Chrome écoute sur ${host}:${port} et non sur 127.0.0.1:${port} (port déjà pris)` };
  return { listening: { host, port, path: m[3]! } };
}

export interface Spawned {
  child: ChildProcess;
  pid: number;
  exited(): string | null;
  /** stderr accumulé depuis le lancement (borné). */
  stderr(): string;
  /** Arrête ce lancement (essai raté). */
  abort(): Promise<void>;
}

/**
 * Lance un navigateur détaché ; son stderr est lu par Grasp (annonce « DevTools listening », échecs de
 * port) et recopié dans `stderrLog` s'il y en a un.
 */
function spawnBrowser(cmd: string, argv: string[], env: NodeJS.ProcessEnv, stderrLog: string | undefined, abort: (pid: number) => Promise<void>): Spawned {
  const child = spawn(cmd, argv, { detached: true, stdio: ['ignore', 'ignore', 'pipe'], env });
  const pid = child.pid;
  if (pid === undefined) throw new Error(`Impossible de lancer ${cmd}.`);
  let exited: string | null = null;
  child.once('exit', (code, sig) => { exited = `code=${code} signal=${sig}`; });
  const log = stderrLog !== undefined ? createWriteStream(stderrLog, { flags: 'a', mode: 0o600 }) : undefined;
  log?.on('error', () => undefined);
  let buf = '';
  child.stderr?.on('data', (d: Buffer) => {
    log?.write(d);
    if (buf.length < 256 * 1024) buf += d.toString('utf8');
  });
  child.stderr?.once('close', () => log?.end());
  return { child, pid, exited: () => exited, stderr: () => buf, abort: () => abort(pid) };
}

type Probe = { ws: string } | { none: string };

async function probeVersion(port: number, timeoutMs: number): Promise<Probe> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(Math.max(100, Math.min(500, timeoutMs))) });
    if (!r.ok) return { none: `HTTP ${r.status}` };
    const j = await r.json() as { webSocketDebuggerUrl?: unknown };
    return typeof j.webSocketDebuggerUrl === 'string' ? { ws: j.webSocketDebuggerUrl } : { none: 'réponse sans webSocketDebuggerUrl' };
  } catch (e) {
    const cause = (e as Error & { cause?: { code?: string; message?: string } }).cause;
    return { none: cause?.code ?? cause?.message ?? (e as Error).message };
  }
}

type Outcome = { ok: true; wsUrl: string } | { ok: false; reason: string; exit?: string; fatal?: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Après l'annonce de Chrome, délai pour que 127.0.0.1:<port> réponde (sinon : boucle locale non partagée). */
const UNREACHABLE_MS = 5000;
/** Réponse HTTP sans annonce sur stderr : délai avant de conclure. */
const ANNOUNCE_GRACE_MS = 1500;

/**
 * Attend que CE navigateur serve DevTools sur 127.0.0.1:<port>. Preuve d'identité : l'endpoint
 * (/devtools/browser/<uuid>) annoncé sur le stderr de NOTRE processus doit être celui que sert
 * /json/version. Un autre navigateur sur ce port a un autre UUID : on ne s'y connecte jamais.
 */
async function waitEndpoint(s: Spawned, port: number, deadline: number, label: string, unreachable: (port: number, why: string) => string): Promise<Outcome> {
  let answeredAt = 0;
  let announcedAt = 0;
  let last = 'aucune réponse';
  while (Date.now() < deadline) {
    const e = parseDevtoolsStderr(s.stderr());
    if (e.portFailure !== undefined) return { ok: false, reason: e.portFailure };
    const why = s.exited();
    if (why !== null) return { ok: false, reason: why, exit: why };
    if (e.listening !== undefined && e.listening.port !== port) return { ok: false, reason: `${label} écoute sur le port ${e.listening.port} au lieu de ${port}` };
    if (e.listening !== undefined && announcedAt === 0) announcedAt = Date.now();
    const v = await probeVersion(port, deadline - Date.now());
    if ('ws' in v) {
      let path = '';
      try { path = new URL(v.ws).pathname; } catch { /* URL illisible : pas la nôtre */ }
      if (e.listening !== undefined) {
        if (path === e.listening.path) return { ok: true, wsUrl: `ws://127.0.0.1:${port}${path}` };
        return { ok: false, reason: `un autre navigateur répond sur 127.0.0.1:${port} (endpoint ${path || v.ws}, pas celui de notre ${label})` };
      }
      // Chrome s'annonce sur stderr AVANT de servir : une réponse sans annonce vient d'un autre navigateur,
      // sauf si notre stderr reste vide (enveloppe qui le détourne) — le port était libre au lancement et
      // notre processus vit : on l'accepte alors.
      if (answeredAt === 0) answeredAt = Date.now();
      else if (Date.now() - answeredAt > ANNOUNCE_GRACE_MS) {
        if (s.stderr() === '' && s.exited() === null && path.startsWith('/devtools/browser/')) return { ok: true, wsUrl: `ws://127.0.0.1:${port}${path}` };
        return { ok: false, reason: `un autre navigateur répond sur 127.0.0.1:${port} (notre ${label} ne s'y est pas annoncé)` };
      }
    } else {
      last = v.none;
      if (announcedAt !== 0 && Date.now() - announcedAt > UNREACHABLE_MS) {
        const msg = unreachable(port, v.none);
        return { ok: false, reason: msg, fatal: msg };
      }
    }
    await sleep(100);
  }
  return { ok: false, reason: `pas de réponse sur 127.0.0.1:${port} (${last})` };
}

/**
 * Lance le navigateur sur un port choisi par Grasp et le retrouve par /json/version. Port pris entre-temps,
 * plage réservée, autre navigateur sur le port, navigateur muet : nouvel essai sur un autre port, au plus
 * MAX_PORT_ATTEMPTS. Un navigateur qui s'arrête au démarrage n'est pas relancé (mesuré : un port
 * indisponible ne l'arrête jamais, c'est alors le profil). Navigateur muet : la moitié du temps restant
 * par essai, le dernier a le reste.
 */
export async function startOnOwnPort(o: {
  label: string;
  hint: string;
  budgetMs: number;
  pickPort: () => Promise<number>;
  spawnAt: (port: number) => Spawned;
  unreachable: (port: number, why: string) => string;
}): Promise<{ s: Spawned; port: number; wsUrl: string }> {
  const end = Date.now() + o.budgetMs;
  const failures: string[] = [];
  for (let attempt = 1; attempt <= MAX_PORT_ATTEMPTS; attempt++) {
    const left = end - Date.now();
    if (left <= 0) break;
    const port = await o.pickPort();
    const s = o.spawnAt(port);
    const attemptEnd = attempt < MAX_PORT_ATTEMPTS ? Date.now() + Math.ceil(left / 2) : end;
    let r: Outcome;
    try { r = await waitEndpoint(s, port, attemptEnd, o.label, o.unreachable); } catch (e) { await s.abort().catch(() => undefined); throw e; }
    if (r.ok) return { s, port, wsUrl: r.wsUrl };
    await s.abort().catch(() => undefined);
    if (r.exit !== undefined) throw new Error(`${o.label} s'est arrêté au démarrage (${r.exit}). Le profil ${o.hint} est peut-être déjà utilisé par un autre Chrome. \`grasp doctor\` pour diagnostiquer.`);
    if (r.fatal !== undefined) throw new Error(r.fatal);
    failures.push(`port ${port} : ${r.reason}`);
  }
  const n = failures.length;
  throw new Error(`${o.label} n'a pas exposé de port DevTools utilisable en ${n} essai${n > 1 ? 's' : ''} (${failures.join(' ; ') || 'délai épuisé'}) — profil ${o.hint}.`);
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
  const common = { userDataDir: opts.userDataDir, headless: opts.headless, env, uid: process.getuid?.() ?? 1000, shmBytes: shmSize(), network: opts.network, extraArgs: opts.extraArgs };
  // Avertissements (sandbox, /dev/shm) : une seule fois, pas à chaque essai de port.
  for (const w of buildChromeArgs({ ...common, port: 1 }).warnings) opts.onWarning?.(w);

  // PDEATHSIG survit à exec (pas à fork ni à un exec setuid) : valable pour un ELF et pour un wrapper
  // shell qui fait `exec chrome` (cas de /usr/bin/google-chrome). Snap/Flatpak passent par un binaire
  // setuid qui l'efface : là, c'est le parent qui tue le groupe (reapOnExit).
  const sp = opts.browser.kind === 'elf' || opts.browser.kind === 'script' ? setpriv() : null;
  const path = opts.browser.path;
  const { s, port, wsUrl } = await startOnOwnPort({
    label: 'Chrome',
    hint: opts.userDataDir,
    budgetMs: opts.startTimeoutMs ?? 20_000,
    pickPort: opts.pickPort ?? (() => freeLocalPort()),
    spawnAt: (p) => {
      const { args } = buildChromeArgs({ ...common, port: p });
      const [cmd, argv] = sp !== null ? [sp, ['--pdeathsig', 'KILL', '--', path, ...args]] : [path, args];
      return spawnBrowser(cmd, argv, env, opts.stderrLog, async (pid) => { await killGroup(pid); });
    },
    unreachable: (p, why) => `Chrome s'est annoncé sur 127.0.0.1:${p} mais n'y répond pas (${why}).`,
  });
  const pid = s.pid;
  return {
    pid,
    pgid: pid,
    port,
    wsUrl,
    version,
    child: s.child,
    // Browser.close d'abord : un SIGTERM simultané à tout le groupe tue le service réseau avant qu'il
    // n'écrive les cookies sur disque (un profil perdrait ses connexions). Puis le groupe, s'il reste.
    kill: async (timeoutMs = 5000) => {
      if (s.exited() === null) await closeViaCdp(wsUrl, () => s.exited() !== null, timeoutMs);
      await killGroup(pid, timeoutMs);
    },
  };
}

/**
 * Fermeture propre par CDP (Browser.close), attend la sortie du processus navigateur.
 * Chaque étape est bornée par timeoutMs : un navigateur gelé ne répond jamais à Browser.close,
 * et l'arrêt doit pouvoir passer au repli (groupe, Stop-Process) avant le chien de garde du bridge.
 */
export async function closeViaCdp(wsUrl: string, gone: () => boolean, timeoutMs: number): Promise<boolean> {
  try {
    const c = await CdpClient.connect(wsUrl, timeoutMs);
    let t: NodeJS.Timeout | undefined;
    await Promise.race([
      c.send('Browser.close').catch(() => undefined),
      new Promise<void>((r) => { t = setTimeout(r, timeoutMs); }),
    ]);
    clearTimeout(t);
    c.close();
  } catch { return gone(); }
  const end = Date.now() + timeoutMs;
  while (!gone() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  return gone();
}

/** Plages de ports réservées par Windows, lues une fois par processus. */
let excludedCache: Promise<Array<[number, number]>> | undefined;

/**
 * chrome.exe lancé depuis WSL2. Le processus Linux est le relais d'interop WSL : il vit tant que
 * chrome.exe vit, mais le tuer ne tue PAS chrome.exe. Arrêt : Browser.close par CDP, puis repli
 * PowerShell ciblé sur ce --user-data-dir (jamais le Chrome habituel de l'utilisateur).
 */
async function launchWindowsChrome(opts: LaunchOptions): Promise<ChromeProcess> {
  const version = windowsChromeVersion(opts.browser.path);
  assertSupportedVersion(version);
  const win = await toWindowsPath(opts.userDataDir);
  const env = opts.env ?? process.env;
  // Repli : tuer côté Windows les processus de CE --user-data-dir, puis le relais.
  const hardKill = async (pid: number): Promise<void> => {
    await killWindowsChrome(win);
    try { process.kill(-pid, 'SIGKILL'); } catch { /* déjà parti */ }
  };
  const { s, port, wsUrl } = await startOnOwnPort({
    label: 'chrome.exe',
    hint: win,
    budgetMs: opts.startTimeoutMs ?? 30_000,
    pickPort: opts.pickPort ?? (async () => windowsFreePort(await (excludedCache ??= windowsExcludedPorts()))),
    spawnAt: (p) => spawnBrowser(opts.browser.path, buildWindowsChromeArgs({ userDataDirWin: win, headless: opts.headless, port: p, network: opts.network }), env, opts.stderrLog, hardKill),
    // Réseau WSL : chrome.exe écoute sur le 127.0.0.1 de Windows, joignable depuis WSL seulement en mode mirrored.
    unreachable: (p, why) => `chrome.exe a démarré (port DevTools ${p}) mais 127.0.0.1:${p} est injoignable depuis WSL (${why}) : activez networkingMode=mirrored dans %USERPROFILE%\\.wslconfig puis \`wsl --shutdown\`.`,
  });
  const pid = s.pid;
  const relayAlive = () => s.exited() === null;
  const kill = async (timeoutMs = 5000): Promise<void> => {
    // 1. Fermeture propre par CDP : chrome.exe écrit ses cookies et s'arrête, le relais WSL sort.
    if (relayAlive()) await closeViaCdp(wsUrl, () => !relayAlive(), timeoutMs);
    if (!relayAlive()) return;
    // 2. Repli : Stop-Process ciblé, puis le relais.
    await hardKill(pid);
    if (await windowsChromeAlive(win) > 0) throw new Error(`chrome.exe (${win}) survit à Stop-Process`);
  };
  return { pid, pgid: pid, port, version, child: s.child, windowsUserDataDir: win, wsUrl, kill };
}
