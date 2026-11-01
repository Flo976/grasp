import { execFile } from 'node:child_process';
import { ANTI_BACKGROUND_ARGS, ALWAYS_DISABLED_FEATURES, mergeDisableFeatures } from './args.js';
import { existsSync, readdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Chrome Windows (chrome.exe) piloté depuis WSL2.
 *
 * - Les profils vivent côté Windows : les cookies sont chiffrés par DPAPI (et la clé « app-bound »),
 *   seul chrome.exe, lancé sous le compte Windows, peut les relire.
 * - Pas de groupe de processus ni de PR_SET_PDEATHSIG au-delà de la frontière WSL/Windows :
 *   on ferme par CDP (Browser.close), puis on retrouve le processus par SON --user-data-dir.
 *   Le Chrome habituel de l'utilisateur n'est jamais visé.
 */

export interface RunResult { code: number | null; stdout: string; stderr: string }
/** Exécuteur de commandes, injectable pour les tests. */
export type Runner = (cmd: string, args: string[], opts?: { timeoutMs?: number }) => Promise<RunResult>;

export const realRunner: Runner = (cmd, args, opts = {}) => new Promise((resolve) => {
  // cmd.exe/powershell.exe refusent un répertoire courant UNC (\\wsl.localhost\…) : on se place sur C:.
  const cwd = existsSync('/mnt/c') ? '/mnt/c' : undefined;
  execFile(cmd, args, { encoding: 'utf8', timeout: opts.timeoutMs ?? 30_000, maxBuffer: 16 * 1024 * 1024, ...(cwd !== undefined ? { cwd } : {}) }, (err, stdout, stderr) => {
    const code = err === null ? 0 : typeof (err as NodeJS.ErrnoException).code === 'number' ? (err as unknown as { code: number }).code : null;
    resolve({ code, stdout: String(stdout), stderr: err !== null && !stderr ? err.message : String(stderr) });
  });
});

/** Chemin WSL sur un disque Windows (/mnt/c/…) : seul emplacement sûr pour un profil de chrome.exe. */
export function isWindowsDrivePath(p: string): boolean {
  return /^\/mnt\/[A-Za-z]\//.test(p);
}

export async function toWindowsPath(p: string, run: Runner = realRunner): Promise<string> {
  if (!isWindowsDrivePath(p)) {
    throw new Error(`${p} n'est pas sur un disque Windows : chrome.exe a besoin d'un profil sous /mnt/<lecteur>/ (un profil côté Linux, lu via \\\\wsl.localhost, casse le verrouillage SQLite et le chiffrement DPAPI)`);
  }
  const r = await run('wslpath', ['-w', p]);
  const out = r.stdout.trim();
  if (r.code !== 0 || !out) throw new Error(`wslpath -w ${p} a échoué : ${r.stderr.trim() || `code ${r.code}`}`);
  return out;
}

export async function toWslPath(win: string, run: Runner = realRunner): Promise<string> {
  const r = await run('wslpath', ['-u', win]);
  const out = r.stdout.trim();
  if (r.code !== 0 || !out) throw new Error(`wslpath -u ${win} a échoué : ${r.stderr.trim() || `code ${r.code}`}`);
  return out;
}

/**
 * Chemin de téléchargement à remettre à Chrome (Browser.setDownloadBehavior) : chrome.exe ne comprend
 * qu'un chemin Windows, le dossier (sous /mnt/<lecteur>/) est donc traduit par wslpath -w.
 */
export async function chromeDownloadPath(dir: string, kind: string, run: Runner = realRunner): Promise<string> {
  return kind === 'windows' ? toWindowsPath(dir, run) : dir;
}

/** %LOCALAPPDATA% de l'utilisateur Windows, en chemin WSL (/mnt/c/Users/<nom>/AppData/Local). */
export async function windowsLocalAppData(run: Runner = realRunner): Promise<string> {
  const r = await run('cmd.exe', ['/c', 'echo', '%LOCALAPPDATA%'], { timeoutMs: 15_000 });
  if (r.code !== 0) throw new Error(`cmd.exe injoignable (interop WSL désactivée ?) : ${r.stderr.trim() || `code ${r.code}`}`);
  const win = r.stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '') ?? '';
  if (!/^[A-Za-z]:\\/.test(win)) throw new Error(`%LOCALAPPDATA% illisible via cmd.exe (reçu ${JSON.stringify(win)}) — définissez windowsProfilesDir (grasp config set windowsProfilesDir /mnt/c/…)`);
  return toWslPath(win, run);
}

/** Arguments de chrome.exe. Pas de guillemets : l'interop WSL cite elle-même les arguments contenant des espaces. */
export function buildWindowsChromeArgs(input: { userDataDirWin: string; headless: boolean; port: number }): string[] {
  if (!(Number.isInteger(input.port) && input.port > 0 && input.port < 65536)) throw new Error(`port DevTools invalide : ${input.port}`);
  return mergeDisableFeatures([
    `--user-data-dir=${input.userDataDirWin}`,
    // Jamais 0 : avec un port choisi par Chrome, navigator.webdriver vaut true (voir launch.ts).
    `--remote-debugging-port=${input.port}`,
    '--no-first-run',
    '--no-default-browser-check',
    ...ANTI_BACKGROUND_ARGS,
    ...(input.headless ? ['--headless=new'] : []),
    'about:blank',
  ], ALWAYS_DISABLED_FEATURES);
}

/** Plages « Port de début / Port de fin » de `netsh int ipv4 show excludedportrange tcp` (toute langue). */
export function parseExcludedPortRanges(out: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*(\d{1,5})\s+(\d{1,5})\s*\*?\s*$/.exec(line);
    if (m) ranges.push([Number(m[1]), Number(m[2])]);
  }
  return ranges;
}

/**
 * Ports TCP réservés par Windows (Hyper-V, WSL, administrateur) : chrome.exe ne pourrait pas y écouter
 * alors que le même port paraît libre côté WSL. Échec de netsh : liste vide (Chrome signalera le port).
 */
export async function windowsExcludedPorts(run: Runner = realRunner): Promise<Array<[number, number]>> {
  const r = await run('netsh.exe', ['int', 'ipv4', 'show', 'excludedportrange', 'tcp'], { timeoutMs: 15_000 });
  return r.code === 0 ? parseExcludedPortRanges(r.stdout) : [];
}

/**
 * Version de chrome.exe, lue dans le nom du sous-dossier de version (…\Application\156.0.8078.76\).
 * Jamais `chrome.exe --version` : sous Windows, cette commande ouvre une fenêtre dans le Chrome de l'utilisateur.
 */
export function windowsChromeVersion(exePath: string, list: (dir: string) => string[] = (d) => readdirSync(d)): string {
  const versions = list(dirname(exePath)).filter((n) => /^\d+\.\d+\.\d+\.\d+$/.test(n));
  if (versions.length === 0) throw new Error(`version de ${exePath} introuvable (aucun dossier de version à côté de chrome.exe)`);
  const key = (v: string) => v.split('.').map(Number);
  versions.sort((a, b) => { const x = key(a), y = key(b); for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i]! - y[i]!; return 0; });
  return `Google Chrome ${versions.at(-1)!}`;
}

const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Garde-fous : jamais le profil habituel de Chrome, jamais une racine de disque. */
function assertKillable(winDir: string): void {
  const d = winDir.replace(/[\\/]+$/, '');
  if (!/^[A-Za-z]:\\.+\\.+/.test(d)) throw new Error(`refus de viser les processus Chrome de ${JSON.stringify(winDir)} : chemin trop court ou invalide`);
  if (/\\Google\\Chrome( Beta| Dev| SxS)?\\User Data$/i.test(d) || /\\Chromium\\User Data$/i.test(d)) {
    throw new Error(`refus : ${winDir} est le profil habituel de Chrome, Grasp ne touche jamais au Chrome de l'utilisateur`);
  }
}

const PROCS = "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\"";

/** Script PowerShell : tue les chrome.exe dont la ligne de commande porte exactement ce --user-data-dir. */
export function windowsKillScript(winDir: string): string {
  assertKillable(winDir);
  return [
    `$d = ${psQuote(winDir.replace(/[\\/]+$/, ''))}`,
    "$re = '--user-data-dir=' + [regex]::Escape($d) + '(\\s|$)'",
    `$p = @(${PROCS} | Where-Object { $_.CommandLine -and (($_.CommandLine -replace '\"','') -match $re) })`,
    '$p | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }',
    'Write-Output $p.Count',
  ].join('\n');
}

export function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

const POWERSHELL = 'powershell.exe';

async function powershell(script: string, run: Runner): Promise<string> {
  const r = await run(POWERSHELL, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(script)], { timeoutMs: 60_000 });
  if (r.code !== 0) throw new Error(`powershell.exe a échoué : ${r.stderr.trim() || `code ${r.code}`}`);
  return r.stdout;
}

/** Tue les chrome.exe lancés sur ce --user-data-dir (chemin Windows). Retourne le nombre de processus visés. */
export async function killWindowsChrome(winDir: string, run: Runner = realRunner): Promise<number> {
  const out = await powershell(windowsKillScript(winDir), run);
  return Number(out.trim().split(/\r?\n/).at(-1)) || 0;
}

export interface WindowsProcess { pid: number; commandLine: string }

/** Tous les chrome.exe Windows (diagnostic, tests, validation). */
export async function windowsChromeProcesses(run: Runner = realRunner): Promise<WindowsProcess[]> {
  const out = await powershell(`@(${PROCS} | Select-Object ProcessId,CommandLine) | ConvertTo-Json -Compress`, run);
  const t = out.trim();
  if (!t) return [];
  const raw = JSON.parse(t) as Array<{ ProcessId: number; CommandLine: string | null }> | { ProcessId: number; CommandLine: string | null };
  return (Array.isArray(raw) ? raw : [raw]).map((p) => ({ pid: p.ProcessId, commandLine: p.CommandLine ?? '' }));
}

/** Processus encore vivants sur ce --user-data-dir. */
export async function windowsChromeAlive(winDir: string, run: Runner = realRunner): Promise<number> {
  const d = winDir.replace(/[\\/]+$/, '').toLowerCase();
  const re = new RegExp(`--user-data-dir=${d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`);
  return (await windowsChromeProcesses(run)).filter((p) => re.test(p.commandLine.replaceAll('"', '').toLowerCase())).length;
}
