import { readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync, existsSync, openSync, fsyncSync, closeSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { DEFAULT_LIMITS, type Limits } from './limits.js';
import { assertHostResolverRule, assertProxyServer, isBypassEntry, isCertHost, isHostResolverRule, isProxyServer } from './remote.js';

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
  /**
   * Protection SSRF levée : un nom de l'allowlist qui résout vers une adresse privée ou réservée (RFC 1918,
   * boucle locale, 169.254 et métadonnées cloud, CGNAT, ULA…) est admis. Défaut false : seuls les hôtes
   * littéraux inscrits tels quels (127.0.0.1, localhost, [::1]) peuvent viser le réseau local.
   */
  allowPrivateNetwork: boolean;
  /**
   * Blocage des requêtes vers les serveurs de publicité et de traçage (liste de Peter Lowe embarquée). Activé
   * par défaut : un agent lit la page, ces requêtes n'y ajoutent rien et allongent l'attente de stabilité.
   */
  blockTrackers: boolean;
  /**
   * Frontières de contenu : tout texte venu de la page (snap, text, diff, notes, console, erreurs) est encadré par
   * des marqueurs à nonce aléatoire par réponse, et toute imitation du marqueur par la page est neutralisée
   * (~150 octets par bloc encadré). « auto » (défaut) : actif dès que l'allowlist admet un hôte hors de la boucle
   * locale (contenu de tiers, donc injection de prompt indirecte possible) ; true/false : forcé.
   */
  contentBoundaries: boolean | 'auto';
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
  /**
   * Moteur de repli des clics : « playwright » rejoue via Playwright (playwright-core, optionnel) un clic natif
   * non livré ou en erreur d'actionnabilité ; « none » (défaut) : jamais.
   */
  fallbackEngine: 'none' | 'playwright';
  /** Proxy de Chrome (--proxy-server), ex. socks5://127.0.0.1:1080 derrière un `ssh -D`. null = direct. */
  proxyServer: string | null;
  /** Hôtes qui contournent le proxy (--proxy-bypass-list). */
  proxyBypassList: string[];
  /** Règles --host-resolver-rules, ex. « MAP site.exemple.com 127.0.0.1:8443 » derrière un `ssh -L`. */
  hostResolverRules: string[];
  /** Hôtes dont le certificat TLS n'est pas vérifié. Vide par défaut ; jamais `*`. */
  ignoreCertErrorsFor: string[];
  /**
   * Recyclage : mémoire du groupe de processus Chrome d'une session (PSS sous Linux, octets privés sous Windows),
   * en Mo, au-delà de laquelle le navigateur est relancé entre deux commandes. null (défaut) = jamais.
   */
  browserMaxRssMb: number | null;
  /** Recyclage : âge du navigateur d'une session, en minutes (décimales permises), au-delà duquel il est relancé. null = jamais. */
  browserMaxAgeMin: number | null;
  /** Plafond de sessions simultanées (créations en cours comprises) : au-delà, 503 explicite. null (défaut) = pas de plafond. */
  maxSessions: number | null;
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
  allowPrivateNetwork: false,
  blockTrackers: true,
  contentBoundaries: 'auto',
  transport: 'unix',
  port: 7319,
  cdpUrl: null,
  windowsProfilesDir: null,
  snapMax: DEFAULT_LIMITS.snapMax,
  textMax: DEFAULT_LIMITS.textMax,
  diffMax: DEFAULT_LIMITS.diffMax,
  stableTimeoutMs: DEFAULT_LIMITS.stableTimeoutMs,
  inputDeliveryMs: DEFAULT_LIMITS.inputDeliveryMs,
  fallbackEngine: 'none',
  proxyServer: null,
  proxyBypassList: Object.freeze([]) as unknown as string[],
  hostResolverRules: Object.freeze([]) as unknown as string[],
  ignoreCertErrorsFor: Object.freeze([]) as unknown as string[],
  browserMaxRssMb: null,
  browserMaxAgeMin: null,
  maxSessions: null,
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

/** Liste de chaînes : séparée par `sep` ou tableau JSON ; vide (ou []) = liste vide. */
function list(valid: (x: string) => boolean, normalize: (x: string) => string, sep: RegExp, help: string, error: (x: string) => string): KeySpec<string[]> {
  const check = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string' && valid(x));
  return {
    check,
    parse(raw) {
      const t = raw.trim();
      if (t === '' || t === '[]') return [];
      let items: unknown;
      if (t.startsWith('[')) items = JSON.parse(t);
      else items = t.split(sep).map((x) => x.trim()).filter((x) => x !== '');
      if (!Array.isArray(items) || !items.every((x) => typeof x === 'string')) throw new Error('tableau JSON de chaînes attendu');
      for (const x of items as string[]) if (!valid(x)) throw new Error(error(x));
      return (items as string[]).map(normalize);
    },
    help,
  };
}

/** Entier ou null (« none » = désactivé explicitement, comme l'absence de la clé). */
function optInt(min: number, max: number, help: string): KeySpec<number | null> {
  const base = int(min, max, help);
  return {
    check: (v): v is number | null => v === null || base.check(v),
    parse(raw) { return raw === 'none' ? null : base.parse(raw); },
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
  allowPrivateNetwork: { ...bool, help: 'true|false : un nom de l\'allowlist peut résoudre vers une IP privée/réservée (défaut false : protection SSRF ; les hôtes littéraux inscrits restent permis)' },
  blockTrackers: { ...bool, help: 'true|false : bloque les requêtes vers les ~3 500 domaines de publicité et de traçage de la liste de Peter Lowe (défaut true)' },
  contentBoundaries: {
    check: (v): v is boolean | 'auto' => typeof v === 'boolean' || v === 'auto',
    parse(raw) {
      if (raw === 'auto') return 'auto';
      return bool.parse(raw);
    },
    help: 'auto|true|false : encadre le contenu de la page entre des marqueurs à nonce aléatoire (données, jamais instructions) et neutralise leurs imitations ; auto (défaut) = actif dès que l\'allowlist admet un hôte hors boucle locale',
  },
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
  fallbackEngine: {
    check: (v): v is 'none' | 'playwright' => v === 'none' || v === 'playwright',
    parse(raw) { if (raw !== 'none' && raw !== 'playwright') throw new Error('none|playwright attendu'); return raw; },
    help: 'none|playwright : rejeu via Playwright (npm i playwright-core) d\'un clic natif non livré ou non actionnable (défaut none)',
  },
  proxyServer: {
    check: (v): v is string | null => v === null || (typeof v === 'string' && isProxyServer(v)),
    parse: (raw) => assertProxyServer(raw.trim()),
    help: 'schéma://hôte:port (http, https, socks4, socks5), ex. socks5://127.0.0.1:1080 derrière `ssh -D 1080` ; unset = connexion directe',
  },
  proxyBypassList: list(isBypassEntry, (x) => x, /[,;]/, 'hôtes hors proxy, séparés par des virgules (ex. *.local,10.0.0.0/8,<-loopback>) ; sans effet sans proxyServer',
    (x) => `entrée de contournement invalide ${JSON.stringify(x)} (ni blanc, ni virgule, ni point-virgule)`),
  hostResolverRules: list(isHostResolverRule, (x) => assertHostResolverRule(x), /,/, 'règles séparées par des virgules, ex. « MAP site.exemple.com 127.0.0.1:8443 » (vhost joint par son vrai nom via `ssh -L`)',
    (x) => { try { assertHostResolverRule(x); return ''; } catch (e) { return (e as Error).message; } }),
  ignoreCertErrorsFor: list(isCertHost, (x) => x.trim().toLowerCase(), /,/, 'hôtes dont le certificat TLS n\'est PAS vérifié (ex. site.exemple.com) ; jamais *, vide par défaut',
    (x) => `hôte invalide ${JSON.stringify(x)} : un nom ou *.domaine attendu (* seul refusé : la dérogation reste limitée à des hôtes listés)`),
  browserMaxRssMb: optInt(1, 1_000_000, 'Mo : mémoire du groupe Chrome d\'une session (PSS sous Linux, octets privés de chrome.exe) au-delà de laquelle le navigateur est relancé entre deux commandes ; none = jamais (défaut)'),
  browserMaxAgeMin: {
    check: (v): v is number | null => v === null || (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 525_600),
    parse(raw) {
      if (raw === 'none') return null;
      const n = Number(raw);
      if (!/^\d+(\.\d+)?$/.test(raw) || !(n > 0 && n <= 525_600)) throw new Error(`nombre de minutes > 0 attendu (décimales permises), reçu ${JSON.stringify(raw)}`);
      return n;
    },
    help: 'minutes (décimales permises) : âge au-delà duquel le navigateur d\'une session est relancé entre deux commandes ; none = jamais (défaut)',
  },
  maxSessions: optInt(1, 10_000, 'sessions simultanées au plus (créations en cours comprises), 503 au-delà ; none = pas de plafond (défaut)'),
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
    allowPrivateNetwork: pick('allowPrivateNetwork'),
    blockTrackers: pick('blockTrackers'),
    contentBoundaries: pick('contentBoundaries'),
    transport: pick('transport'),
    port: pick('port'),
    cdpUrl: pick('cdpUrl'),
    windowsProfilesDir: pick('windowsProfilesDir'),
    snapMax: pick('snapMax'),
    textMax: pick('textMax'),
    diffMax: pick('diffMax'),
    stableTimeoutMs: pick('stableTimeoutMs'),
    inputDeliveryMs: pick('inputDeliveryMs'),
    fallbackEngine: pick('fallbackEngine'),
    proxyServer: pick('proxyServer'),
    proxyBypassList: pick('proxyBypassList'),
    hostResolverRules: pick('hostResolverRules'),
    ignoreCertErrorsFor: pick('ignoreCertErrorsFor'),
    browserMaxRssMb: pick('browserMaxRssMb'),
    browserMaxAgeMin: pick('browserMaxAgeMin'),
    maxSessions: pick('maxSessions'),
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
