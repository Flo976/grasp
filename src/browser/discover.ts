import { accessSync, constants, openSync, readSync, closeSync, statSync } from 'node:fs';
import { delimiter, join, resolve, sep } from 'node:path';

export type BrowserKind = 'elf' | 'script' | 'snap' | 'flatpak' | 'windows';
export type DiscoverySource = 'env' | 'config' | 'which' | 'fixed';

export interface DiscoveredBrowser {
  path: string;
  kind: BrowserKind;
  source: DiscoverySource;
}

/** Accès au système de fichiers, injectable pour les tests. */
export interface FsProbe {
  which(name: string): string | null;
  isExecutable(path: string): boolean;
  readHead(path: string, bytes: number): Buffer | null;
}

export const WHICH_ORDER = ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser'] as const;

export function fixedCandidates(home: string): string[] {
  return [
    '/opt/google/chrome/chrome',
    '/snap/bin/chromium',
    '/var/lib/flatpak/exports/bin/org.chromium.Chromium',
    '/var/lib/flatpak/exports/bin/com.google.Chrome',
    join(home, '.local/share/flatpak/exports/bin/org.chromium.Chromium'),
    join(home, '.local/share/flatpak/exports/bin/com.google.Chrome'),
  ];
}

export const realProbe: FsProbe = {
  which(name) {
    for (const dir of (process.env.PATH ?? '').split(delimiter)) {
      if (!dir) continue;
      const p = join(dir, name);
      if (realProbe.isExecutable(p)) return p;
    }
    return null;
  },
  isExecutable(path) {
    try {
      if (!statSync(path).isFile()) return false;
      accessSync(path, constants.X_OK);
      return true;
    } catch { return false; }
  },
  readHead(path, bytes) {
    let fd: number | undefined;
    try {
      fd = openSync(path, 'r');
      const buf = Buffer.alloc(bytes);
      const n = readSync(fd, buf, 0, bytes, 0);
      return buf.subarray(0, n);
    } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
  },
};

/**
 * Classe un exécutable. Piège traité : /snap/bin/chromium, /usr/bin/chromium-browser (Ubuntu)
 * et les exports Flatpak sont des scripts shell, pas des ELF. access(X_OK) réussit, mais le
 * confinement change les règles (profil, signaux), donc on le détecte explicitement.
 */
export function classify(path: string, probe: FsProbe): BrowserKind {
  // WSL2 : chrome.exe sur un disque Windows monté. Profils côté Windows, cycle de vie sans groupe de processus.
  if (/^\/mnt\/[A-Za-z]\//.test(path) && /\.exe$/i.test(path)) return 'windows';
  if (path.startsWith('/snap/')) return 'snap';
  if (path.includes(`${sep}flatpak${sep}exports${sep}bin${sep}`)) return 'flatpak';
  const head = probe.readHead(path, 1024);
  if (head && head.length >= 4 && head[0] === 0x7f && head.subarray(1, 4).toString('latin1') === 'ELF') return 'elf';
  const text = head?.toString('utf8') ?? '';
  if (/\/snap\/bin\/|snap run/.test(text)) return 'snap';
  if (/flatpak run/.test(text)) return 'flatpak';
  return 'script';
}

const HELP = 'Installez Google Chrome ou Chromium, ou indiquez le binaire via GRASP_CHROME=/chemin/vers/chrome (ou `grasp config set chromePath /chemin`). `grasp doctor` détaille la découverte.';

/**
 * Ordre : $GRASP_CHROME, chromePath (config), which(google-chrome-stable, google-chrome, chromium,
 * chromium-browser), puis /opt/google/chrome/chrome, /snap/bin/chromium, wrappers Flatpak.
 */
export function discoverChrome(env: NodeJS.ProcessEnv, probe: FsProbe, home: string, configPath?: string): DiscoveredBrowser {
  const explicit = env.GRASP_CHROME;
  if (explicit !== undefined && explicit !== '') {
    const p = resolve(explicit);
    // Un choix explicite qui ne marche pas est une erreur, jamais un repli silencieux.
    if (!probe.isExecutable(p)) throw new Error(`GRASP_CHROME=${explicit} n'est pas un fichier exécutable.`);
    return { path: p, kind: classify(p, probe), source: 'env' };
  }
  if (configPath !== undefined) {
    if (!probe.isExecutable(configPath)) throw new Error(`chromePath (config) = ${configPath} n'est pas un fichier exécutable. Corrigez avec \`grasp config set chromePath …\` ou \`grasp config unset chromePath\`.`);
    return { path: configPath, kind: classify(configPath, probe), source: 'config' };
  }
  for (const name of WHICH_ORDER) {
    const p = probe.which(name);
    if (p !== null) return { path: p, kind: classify(p, probe), source: 'which' };
  }
  for (const p of fixedCandidates(home)) {
    if (probe.isExecutable(p)) return { path: p, kind: classify(p, probe), source: 'fixed' };
  }
  throw new Error(`Aucun navigateur Chrome/Chromium trouvé. ${HELP}`);
}

export interface ProfileRoots {
  /** Magasin des profils nommés (un sous-dossier <id> par profil). */
  profiles: string;
  /** Profils éphémères des sessions sans --profile. */
  tmp: string;
  /** Droits POSIX applicables (faux sur NTFS via /mnt/c). */
  posix: boolean;
}

/**
 * Où vivent les profils, selon le mode d'installation du navigateur.
 * - snap : l'interface `home` n'autorise ni le hors-$HOME ni les dotdirs de premier niveau
 *   (~/.local/share est illisible) → ~/snap/chromium/common.
 * - flatpak : ~/.var/app/<id>.
 * - windows (chrome.exe depuis WSL2) : côté Windows, %LOCALAPPDATA%\grasp\profiles (ou windowsProfilesDir) ;
 *   DPAPI exige que chrome.exe lise lui-même ses profils.
 * - sinon, et en mode attach : le répertoire de données XDG.
 */
export function profileRootsFor(
  browser: DiscoveredBrowser | undefined,
  paths: { profilesDir: string; tmpProfilesDir: string },
  home: string,
  win: { localAppData?: string | undefined; windowsProfilesDir?: string | undefined },
): ProfileRoots {
  if (browser?.kind === 'snap') {
    const root = join(home, 'snap', 'chromium', 'common');
    return { profiles: join(root, 'grasp-profiles'), tmp: join(root, 'grasp-tmp-profiles'), posix: true };
  }
  if (browser?.kind === 'flatpak') {
    const appId = browser.path.split('/').pop() ?? 'org.chromium.Chromium';
    const root = join(home, '.var', 'app', appId);
    return { profiles: join(root, 'grasp-profiles'), tmp: join(root, 'grasp-tmp-profiles'), posix: true };
  }
  if (browser?.kind === 'windows') {
    let profiles = win.windowsProfilesDir;
    if (profiles === undefined) {
      if (win.localAppData === undefined) throw new Error('chrome.exe : %LOCALAPPDATA% inconnu, impossible de placer les profils côté Windows — définissez windowsProfilesDir');
      profiles = join(win.localAppData, 'grasp', 'profiles');
    }
    return { profiles, tmp: join(profiles, '.tmp'), posix: false };
  }
  return { profiles: paths.profilesDir, tmp: paths.tmpProfilesDir, posix: true };
}
