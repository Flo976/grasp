import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { GraspPaths } from '../core/paths.js';
import { checkPermissions } from '../core/perms.js';
import { discoverChrome, realProbe, type DiscoveredBrowser, type ProfileRoots } from '../browser/discover.js';
import { MIN_SHM_BYTES, assertSupportedVersion, browserVersion, launchChrome, shmSize } from '../browser/launch.js';
import { CdpClient } from '../browser/cdp.js';
import { loadEffective, permissionTargets, resolveProfileRoots } from '../control/server.js';
import type { ResolvedConfig } from '../core/config.js';
import { systemdStatus } from './daemon.js';
import { PLAYWRIGHT_HINT, playwrightVersion } from '../bridge/playwright.js';

export type Level = 'ok' | 'warn' | 'fail';
export interface Check { name: string; level: Level; detail: string }

/** Diagnostic réel, y compris un démarrage effectif de Chrome : c'est le seul test qui compte. */
export async function runDoctor(paths: GraspPaths, env: NodeJS.ProcessEnv, home: string): Promise<Check[]> {
  const out: Check[] = [];
  const add = (name: string, level: Level, detail: string) => out.push({ name, level, detail });

  const major = Number(process.versions.node.split('.')[0]);
  add('node', major >= 22 ? 'ok' : 'fail', `v${process.versions.node}${major >= 22 ? '' : ' (Node 22+ requis)'}`);
  add('plateforme', process.platform === 'linux' ? 'ok' : process.platform === 'darwin' ? 'warn' : 'fail',
    process.platform === 'linux' ? 'linux' : `${process.platform} (Linux cible ; macOS best-effort)`);

  let chromePath: string | undefined;
  let cfg: ResolvedConfig | undefined;
  try {
    const { config, policy } = loadEffective(paths);
    cfg = config;
    chromePath = config.chromePath === null ? undefined : config.chromePath;
    add('config', 'ok', `${paths.configFile} — allowlist [${policy.allowedDomains.join(', ')}], eval ${policy.allowEval ? 'ON' : 'off'}, transport ${config.transport}`);
  } catch (e) { add('config', 'fail', (e as Error).message); }

  try { checkPermissions(permissionTargets(paths)); add('permissions', 'ok', 'fichiers 0600, répertoires 0700'); } catch (e) { add('permissions', 'fail', (e as Error).message); }

  let browser: DiscoveredBrowser | undefined;
  try {
    browser = discoverChrome(env, realProbe, home, chromePath);
    add('navigateur', 'ok', `${browser.path} (${browser.kind}, via ${browser.source})`);
  } catch (e) { add('navigateur', 'fail', (e as Error).message); }

  if (browser) {
    try { add('version', 'ok', `Chrome ${assertSupportedVersion(await browserVersion(browser))}`); } catch (e) { add('version', 'fail', (e as Error).message); }
    if (browser.kind === 'snap') add('confinement', 'warn', `Chromium snap : les profils iront sous ${join(home, 'snap/chromium/common/grasp-profiles')} (le snap ne lit ni hors $HOME ni les dossiers cachés).`);
    if (browser.kind === 'flatpak') add('confinement', 'warn', 'Chromium Flatpak : profils sous ~/.var/app/<id>/grasp-profiles.');
  }

  let roots: ProfileRoots | undefined;
  if (cfg !== undefined) {
    try {
      roots = await resolveProfileRoots(cfg.cdpUrl === null ? browser : undefined, cfg, paths, home);
      add('profils', 'ok', `${roots.profiles}${roots.posix ? '' : ' (côté Windows)'}`);
    } catch (e) { add('profils', 'fail', (e as Error).message); }
  }
  if (browser?.kind === 'windows') {
    add('mode windows', 'ok', 'chrome.exe piloté depuis WSL2 : profils côté Windows (DPAPI), port DevTools joint sur 127.0.0.1 (WSL en networkingMode=mirrored requis), arrêt par CDP puis PowerShell ciblé sur le --user-data-dir');
    add('droits profils', 'warn', `droits Unix non applicables sur NTFS (${roots?.profiles ?? '?'}) : les profils sont protégés par le compte Windows, pas par 0700/0600`);
  }

  const shm = shmSize();
  if (shm === null) add('/dev/shm', 'warn', 'taille illisible');
  else add('/dev/shm', shm >= MIN_SHM_BYTES ? 'ok' : 'warn', `${Math.round(shm / 1024 / 1024)} Mo${shm >= MIN_SHM_BYTES ? '' : ' — --disable-dev-shm-usage sera ajouté ; en Docker : --shm-size=1g'}`);

  const uid = process.getuid?.();
  if (uid === 0) add('sandbox', env.GRASP_ALLOW_NO_SANDBOX === '1' ? 'warn' : 'fail', env.GRASP_ALLOW_NO_SANDBOX === '1' ? 'root + GRASP_ALLOW_NO_SANDBOX=1 : Chrome sans sandbox' : 'root : le sandbox Chrome échouera. Utilisez un utilisateur non-root ou --cap-add=SYS_ADMIN (ou GRASP_ALLOW_NO_SANDBOX=1).');
  else add('sandbox', 'ok', `uid ${uid}`);

  if (browser?.kind === 'windows') add('setpriv', 'warn', 'non applicable à chrome.exe (pas de PDEATHSIG ni de groupe au-delà de WSL) : arrêt par CDP Browser.close, puis PowerShell ciblé sur le --user-data-dir ; si le control plane ET le bridge sont tués par SIGKILL, chrome.exe survit');
  else add('setpriv', realProbe.which('setpriv') ? 'ok' : 'warn', realProbe.which('setpriv') ? 'PR_SET_PDEATHSIG actif : Chrome meurt avec son bridge' : 'absent (util-linux) : Chrome ne mourra avec le bridge que via le control plane');
  add('XDG_RUNTIME_DIR', env.XDG_RUNTIME_DIR ? 'ok' : 'warn', env.XDG_RUNTIME_DIR ? paths.socketPath : `non défini : socket dans ${paths.socketPath}`);
  // Moteur Playwright de repli : optionnel, jamais requis.
  const pwv = playwrightVersion(env.GRASP_PLAYWRIGHT_MODULE || 'playwright-core');
  const fb = cfg?.fallbackEngine ?? 'none';
  if (pwv !== null) add('playwright', 'ok', `playwright-core ${pwv} : --engine playwright et frame= disponibles ; repli automatique des clics : ${fb}`);
  else add('playwright', fb === 'playwright' ? 'warn' : 'ok', `playwright-core absent (optionnel)${fb === 'playwright' ? ' alors que fallbackEngine=playwright : le repli est sauté' : ''} — pour --engine playwright et frame= : ${PLAYWRIGHT_HINT}`);
  const sd = systemdStatus(env);
  add('systemd', sd.ok ? 'ok' : 'warn', sd.ok ? '`grasp daemon install` disponible' : `${sd.reason} — utilisez \`grasp serve\` au premier plan`);

  if (browser) {
    // Démarrage réel : un wrapper snap/flatpak « exécutable » peut très bien ne pas démarrer.
    const base = mkdtempSync(join(tmpdir(), 'grasp-doctor-'));
    // snap, flatpak, chrome.exe : le profil doit être là où le navigateur peut le lire.
    const dir = browser.kind === 'elf' || browser.kind === 'script' || roots === undefined ? join(base, 'profile') : join(roots.tmp, `doctor-${process.pid}`);
    const t0 = Date.now();
    try {
      const chrome = await launchChrome({ browser, userDataDir: dir, headless: true, startTimeoutMs: 30_000 });
      try {
        const cdp = await CdpClient.connect(chrome.wsUrl);
        const v = await cdp.send<{ product: string }>('Browser.getVersion');
        cdp.close();
        await chrome.kill();
        add('démarrage', 'ok', `${v.product} démarré, piloté via CDP et arrêté proprement en ${Date.now() - t0} ms`);
      } finally { await chrome.kill().catch(() => undefined); }
    } catch (e) { add('démarrage', 'fail', (e as Error).message); }
    finally { rmSync(base, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }); }
  }
  return out;
}
