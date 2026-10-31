import { accessSync, constants, openSync, readSync, closeSync, statSync } from 'node:fs';
import { delimiter, join, resolve, sep } from 'node:path';

export type BrowserKind = 'elf' | 'script' | 'snap' | 'flatpak';
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

function isInside(child: string, parent: string): boolean {
  const c = resolve(child);
  const p = resolve(parent);
  return c === p || c.startsWith(p + sep);
}

/**
 * Répertoire de profil adapté au mode d'installation.
 * Snap : l'interface `home` n'autorise ni le hors-$HOME ni les dotdirs de premier niveau
 * (~/.local/share est donc illisible). On utilise ~/snap/chromium/common, ou on refuse.
 */
export function profileDirFor(browser: DiscoveredBrowser, name: string, profilesDir: string, home: string, override?: string): string {
  if (browser.kind === 'snap') {
    const snapRoot = join(home, 'snap', 'chromium', 'common');
    if (override !== undefined) {
      const rel = resolve(override).slice(resolve(home).length + 1);
      const ok = isInside(override, snapRoot) || (isInside(override, home) && !rel.startsWith('.'));
      if (!ok) {
        throw new Error(`Chromium snap ne peut pas lire le profil ${override} : le confinement snap n'autorise que $HOME hors dossiers cachés. Utilisez un chemin sous ${snapRoot}, ou installez Chrome en .deb.`);
      }
      return resolve(override);
    }
    return join(snapRoot, 'grasp-profiles', name);
  }
  if (browser.kind === 'flatpak') {
    const appId = browser.path.split('/').pop() ?? 'org.chromium.Chromium';
    const root = join(home, '.var', 'app', appId);
    if (override !== undefined) {
      if (!isInside(override, root)) throw new Error(`Le Chromium Flatpak est confiné : placez le profil sous ${root} (reçu : ${override}).`);
      return resolve(override);
    }
    return join(root, 'grasp-profiles', name);
  }
  return override !== undefined ? resolve(override) : join(profilesDir, name);
}
