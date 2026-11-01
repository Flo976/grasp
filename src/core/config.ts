import { readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync, existsSync, openSync, fsyncSync, closeSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { DEFAULT_LIMITS, type Limits } from './limits.js';

/**
 * Configuration. Règle n°1 : « absent » ≠ « désactivé ».
 * Le fichier ne contient que des valeurs `T | undefined` ; la fusion avec DEFAULTS est explicite,
 * clé par clé (`!== undefined`). Jamais `?? false` : un config.json partiel (ex. juste chromePath)
 * ne doit RIEN désactiver d'autre.
 */
export interface ResolvedConfig {
  chromePath: string | null;
  headless: boolean;
  /** Défaut non vide (local uniquement). [] explicite = tout bloquer. ["*"] = tout autoriser. */
  allowedDomains: string[];
  allowEval: boolean;
  allowDownload: boolean;
  allowUpload: boolean;
  allowCookies: boolean;
  /**
   * Lecture de la console du navigateur (journal, exceptions, requêtes en échec). Autorisée par défaut :
   * elle n'exécute rien. false : rien n'est capturé et Runtime.enable n'est jamais appelé (non détectable par la page).
   */
  allowConsole: boolean;
  transport: 'unix' | 'tcp';
  port: number;
  /** Mode attach : URL DevTools d'un navigateur déjà ouvert (ex. Chrome Windows depuis WSL2). Grasp ne le lance ni ne le tue. */
  cdpUrl: string | null;
  /** Chrome Windows (chromePath = …/chrome.exe sous /mnt/) : répertoire des profils côté Windows. Défaut : %LOCALAPPDATA%\\grasp\\profiles. */
  windowsProfilesDir: string | null;
  /** Budget par défaut de `snap`, en octets (`--max` le surcharge à chaque appel). */
  snapMax: number;
  /** Limite par défaut de `text`, en caractères. */
  textMax: number;
  /** Limite par défaut de la sortie `--snap-diff`, en caractères. */
  diffMax: number;
  /** Plafond de l'attente de stabilité du DOM (après nav, avant --snap-diff), en ms ; 0 = pas d'attente. */
  stableTimeoutMs: number;
  /** Délai de livraison d'une entrée native avant reprise (premier plan, puis repli synthétique), en ms. */
  inputDeliveryMs: number;
}

export type ConfigKey = keyof ResolvedConfig;
export type ConfigFile = { [K in ConfigKey]?: ResolvedConfig[K] | undefined };

export const DEFAULTS: Readonly<ResolvedConfig> = Object.freeze({
  chromePath: null,
  headless: true,
  allowedDomains: Object.freeze(['127.0.0.1', 'localhost', '[::1]']) as unknown as string[],
  allowEval: false,
  allowDownload: false,
  allowUpload: false,
  allowCookies: false,
  allowConsole: true,
  transport: 'unix',
  port: 7319,
  cdpUrl: null,
  windowsProfilesDir: null,
  snapMax: DEFAULT_LIMITS.snapMax,
  textMax: DEFAULT_LIMITS.textMax,
  diffMax: DEFAULT_LIMITS.diffMax,
  stableTimeoutMs: DEFAULT_LIMITS.stableTimeoutMs,
  inputDeliveryMs: DEFAULT_LIMITS.inputDeliveryMs,
});

/** Limites de lecture transmises au bridge (elles ne relèvent pas de la politique de sécurité). */
export function limitsOf(cfg: ResolvedConfig): Limits {
  return { snapMax: cfg.snapMax, textMax: cfg.textMax, diffMax: cfg.diffMax, stableTimeoutMs: cfg.stableTimeoutMs, inputDeliveryMs: cfg.inputDeliveryMs };
}

export const PUBLIC_KEYS: readonly ConfigKey[] = Object.freeze(Object.keys(DEFAULTS) as ConfigKey[]);

const WIN_DIR_RE = /^(\/mnt\/[A-Za-z]\/|[A-Za-z]:\\)/;

interface KeySpec<T> { check(v: unknown): v is T; parse(raw: string): T; help: string }

const bool: KeySpec<boolean> = {
  check: (v): v is boolean => typeof v === 'boolean',
  parse(raw) {
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    throw new Error(`valeur booléenne attendue (true|false), reçu ${JSON.stringify(raw)}`);
  },
  help: 'true|false',
};

function int(min: number, max: number, help: string): KeySpec<number> {
  const check = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
  return {
    check,
    parse(raw) {
      const n = Number(raw);
      if (!/^\d+$/.test(raw) || !check(n)) throw new Error(`entier entre ${min} et ${max} attendu, reçu ${JSON.stringify(raw)}`);
      return n;
    },
    help,
  };
}

const SPECS: { [K in ConfigKey]: KeySpec<ResolvedConfig[K]> } = {
  chromePath: {
    check: (v): v is string | null => v === null || (typeof v === 'string' && v.startsWith('/')),
    parse(raw) { if (!raw.startsWith('/')) throw new Error('chemin absolu attendu'); return raw; },
    help: '/chemin/absolu/vers/chrome',
  },
  headless: bool,
  allowedDomains: {
    check: (v): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim() !== ''),
    parse(raw) {
      const t = raw.trim();
      if (t === '' || t === '[]') return [];
      if (t.startsWith('[')) {
        const v: unknown = JSON.parse(t);
        if (!SPECS.allowedDomains.check(v)) throw new Error('tableau JSON de chaînes attendu');
        return v;
      }
      return t.split(',').map((s) => s.trim()).filter((s) => s !== '');
    },
    help: 'liste séparée par des virgules ou tableau JSON ; vide = tout bloquer ; * = tout',
  },
  allowEval: bool,
  allowDownload: bool,
  allowUpload: bool,
  allowCookies: bool,
  allowConsole: bool,
  transport: {
    check: (v): v is 'unix' | 'tcp' => v === 'unix' || v === 'tcp',
    parse(raw) { if (raw !== 'unix' && raw !== 'tcp') throw new Error('unix|tcp attendu'); return raw; },
    help: 'unix|tcp',
  },
  port: {
    check: (v): v is number => Number.isInteger(v) && (v as number) > 0 && (v as number) < 65536,
    parse(raw) {
      const n = Number(raw);
      if (!/^\d+$/.test(raw) || !SPECS.port.check(n)) throw new Error('entier entre 1 et 65535 attendu');
      return n;
    },
    help: '1-65535',
  },
  cdpUrl: {
    check: (v): v is string | null => v === null || (typeof v === 'string' && /^(https?|wss?):\/\/[^\s/]+/.test(v)),
    parse(raw) { if (!/^(https?|wss?):\/\/[^\s/]+/.test(raw)) throw new Error('URL http(s):// ou ws(s):// attendue, ex. http://127.0.0.1:9222'); return raw; },
    help: 'http://hôte:port du navigateur à piloter (mode attach)',
  },
  windowsProfilesDir: {
    check: (v): v is string | null => v === null || (typeof v === 'string' && WIN_DIR_RE.test(v)),
    parse(raw) { if (!WIN_DIR_RE.test(raw)) throw new Error('chemin sur un disque Windows attendu : /mnt/c/… ou C:\\…'); return raw; },
    help: 'répertoire des profils de chrome.exe (WSL2) : /mnt/c/… ou C:\\… ; défaut %LOCALAPPDATA%\\grasp\\profiles',
  },
  snapMax: int(512, 10_000_000, `octets, budget par défaut de snap (${DEFAULT_LIMITS.snapMax}) ; --max le surcharge`),
  textMax: int(100, 10_000_000, `caractères, limite par défaut de text (${DEFAULT_LIMITS.textMax}) ; --max la surcharge`),
  diffMax: int(100, 10_000_000, `caractères, limite par défaut de --snap-diff (${DEFAULT_LIMITS.diffMax}) ; --max la surcharge`),
  stableTimeoutMs: int(0, 60_000, `ms, plafond de l'attente de stabilité du DOM après nav et avant --snap-diff (${DEFAULT_LIMITS.stableTimeoutMs}) ; 0 = pas d'attente`),
  inputDeliveryMs: int(50, 10_000, `ms, délai de livraison d'une entrée (click, check, press, fill) avant reprise : premier plan, puis repli synthétique annoncé (${DEFAULT_LIMITS.inputDeliveryMs})`),
};

export function isConfigKey(k: string): k is ConfigKey { return Object.hasOwn(SPECS, k); }
export function keyHelp(k: ConfigKey): string { return SPECS[k].help; }

/** Fusion explicite clé par clé : seule une valeur `!== undefined` remplace le défaut. */
export function resolveConfig(file: ConfigFile): ResolvedConfig {
  const pick = <K extends ConfigKey>(k: K): ResolvedConfig[K] => {
    const v = file[k];
    return v !== undefined ? (v as ResolvedConfig[K]) : structuredClone(DEFAULTS[k]) as ResolvedConfig[K];
  };
  return {
    chromePath: pick('chromePath'),
    headless: pick('headless'),
    allowedDomains: pick('allowedDomains'),
    allowEval: pick('allowEval'),
    allowDownload: pick('allowDownload'),
    allowUpload: pick('allowUpload'),
    allowCookies: pick('allowCookies'),
    allowConsole: pick('allowConsole'),
    transport: pick('transport'),
    port: pick('port'),
    cdpUrl: pick('cdpUrl'),
    windowsProfilesDir: pick('windowsProfilesDir'),
    snapMax: pick('snapMax'),
    textMax: pick('textMax'),
    diffMax: pick('diffMax'),
    stableTimeoutMs: pick('stableTimeoutMs'),
    inputDeliveryMs: pick('inputDeliveryMs'),
  };
}

export function parseConfigFile(text: string, origin: string): ConfigFile {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) { throw new Error(`${origin} : JSON invalide (${(e as Error).message})`); }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${origin} : un objet JSON est attendu`);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!isConfigKey(k)) throw new Error(`${origin} : clé inconnue « ${k} » (clés valides : ${PUBLIC_KEYS.join(', ')})`);
    if (v === undefined) continue;
    if (!SPECS[k].check(v)) throw new Error(`${origin} : valeur invalide pour « ${k} » (${SPECS[k].help}) : ${JSON.stringify(v)}`);
    out[k] = v;
  }
  return out as ConfigFile;
}

/** Fichier absent = config vide (tous les défauts). Fichier illisible ou invalide = erreur. */
export function loadConfigFile(path: string): ConfigFile {
  if (!existsSync(path)) return {};
  return parseConfigFile(readFileSync(path, 'utf8'), path);
}

function writeAtomic(path: string, data: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) { mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700); }
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    const fd = openSync(tmp, 'wx', 0o600);
    try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw new Error(`impossible d'écrire ${path} : ${(e as Error).message}`);
  }
}

function persist(path: string, next: ConfigFile, key: ConfigKey, expected: unknown): void {
  writeAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
  // Vérification : on relit le fichier par le même chemin que le démarrage. Écrire sans persister = erreur.
  const reread = loadConfigFile(path);
  if (!isDeepStrictEqual(reread[key], expected)) {
    throw new Error(`${key} : la valeur relue dans ${path} (${JSON.stringify(reread[key])}) ne correspond pas à celle écrite (${JSON.stringify(expected)})`);
  }
}

/** Persiste une clé ou lève. Retourne la valeur réellement relue sur disque. */
export function setConfigKey(path: string, key: string, raw: string): unknown {
  if (!isConfigKey(key)) throw new Error(`clé inconnue « ${key} » (clés valides : ${PUBLIC_KEYS.join(', ')})`);
  let value: unknown;
  try { value = SPECS[key].parse(raw); } catch (e) { throw new Error(`${key} : ${(e as Error).message}`); }
  const current = loadConfigFile(path);
  persist(path, { ...current, [key]: value }, key, value);
  return value;
}

export function unsetConfigKey(path: string, key: string): void {
  if (!isConfigKey(key)) throw new Error(`clé inconnue « ${key} »`);
  const current: Record<string, unknown> = { ...loadConfigFile(path) };
  delete current[key];
  persist(path, current as ConfigFile, key, undefined);
}
