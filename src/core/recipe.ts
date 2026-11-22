/**
 * Recette de session : un petit fichier JSON qui décrit une session « connectée » d'application (origine + paires
 * clé/valeur de localStorage et de sessionStorage + cookies), plus lisible à écrire qu'un état exporté, et dont les
 * valeurs sensibles ne sont PAS dans le fichier : elles y sont désignées par une référence, lue par le client au
 * moment de l'import.
 *
 *   { "origin": "https://dev.app.exemple.com",
 *     "localStorage":   { "token": "@file:jetons.json#lite.accessToken", "locale": "fr" },
 *     "sessionStorage": { "onglet": "accueil" },
 *     "cookies":        { "sid": "@env:.env#SESSION_ID" } }
 *
 * Références (chemin relatif au répertoire de la recette, `~/` développé) :
 *   @file:chemin#a.b.0   valeur à ce chemin d'un fichier JSON (objet ou tableau : sérialisé en JSON)
 *   @file:chemin         contenu du fichier (une fin de ligne finale retirée)
 *   @env:chemin#CLÉ      variable CLÉ d'un fichier .env (jamais l'environnement du processus : un shell l'affiche)
 *   @@…                  valeur littérale qui commence par @
 *
 * La recette est convertie par le CLIENT (CLI) en état grasp-state ; les valeurs venues d'une référence sont
 * transmises à part (`masked`) pour que le serveur les masque dans toutes ses sorties, comme les secrets. Aucun
 * message d'erreur ne cite une valeur. L'allowlist et allowCookies s'appliquent à l'import, comme pour tout état.
 */
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { SECRET_MIN_LENGTH } from './secrets.js';
import { STATE_FORMAT, STATE_VERSION, normalizeOrigin } from './state.js';

export const RECIPE_FORMAT = 'grasp-recipe';
/** Fichier référencé par une recette (jetons, .env) : au-delà, ce n'est pas un fichier de jetons. */
export const RECIPE_FILE_MAX_BYTES = 4 * 1024 * 1024;
/** Valeur masquable : au-delà, le masquage (préfixes compris) coûterait trop à chaque réponse. */
export const MASK_MAX_LENGTH = 4096;

/** Valeur à masquer dans les sorties du serveur : `label` dit d'où elle vient (`localStorage.token`), jamais ce qu'elle vaut. */
export interface MaskedValue { label: string; value: string }

export interface ResolvedState {
  /** État au format grasp-state (ou l'entrée telle quelle si ce n'était pas une recette). */
  state: unknown;
  masked: MaskedValue[];
  /** Avertissements à afficher (valeur référencée trop courte ou trop longue pour être masquée). */
  notes: string[];
  recipe: boolean;
}

export class RecipeError extends Error {}

export interface RecipeOptions {
  /** Répertoire de la recette : base des chemins relatifs des références. */
  baseDir?: string;
  home?: string;
  /** false : références refusées (contenu reçu sans fichier : API, MCP — le client ne lit alors aucun fichier). */
  refs?: boolean;
  /** Tests : lecture d'un fichier référencé. */
  readFile?: (path: string) => string;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const RECIPE_KEYS = new Set(['format', 'origin', 'localStorage', 'sessionStorage', 'cookies']);
const COOKIE_KEYS = new Set(['name', 'value', 'domain', 'path', 'expires', 'httpOnly', 'secure', 'sameSite']);
const REF_RE = /^@(file|env):([\s\S]*)$/;

/**
 * Est-ce une recette ? Un objet avec « origin » (ou un tableau de tels objets), sans les marques d'un état
 * (`format: grasp-state`, `origins`). Un état exporté ou un storageState Playwright ne sont jamais pris pour une recette.
 */
export function isRecipe(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0 && v.every((x) => isRecipe(x));
  if (!isObj(v)) return false;
  if (v.format !== undefined) return v.format === RECIPE_FORMAT;
  return typeof v.origin === 'string' && v.origins === undefined;
}

function refPath(raw: string, o: RecipeOptions): string {
  const home = o.home ?? homedir();
  if (raw === '~' || raw.startsWith('~/')) return join(home, raw.slice(1));
  return resolve(o.baseDir ?? process.cwd(), raw);
}

function readRef(path: string, where: string, o: RecipeOptions): string {
  try {
    if (o.readFile !== undefined) return o.readFile(path);
    const st = statSync(path);
    if (!st.isFile()) throw new Error('n\'est pas un fichier');
    if (st.size > RECIPE_FILE_MAX_BYTES) throw new Error(`${st.size} octets (${RECIPE_FILE_MAX_BYTES} au plus)`);
    return readFileSync(path, 'utf8');
  } catch (e) { throw new RecipeError(`${where} : lecture de ${path} impossible : ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`); }
}

/** `KEY=valeur` d'un fichier .env : `export ` admis, guillemets simples ou doubles retirés, `#` de commentaire hors guillemets. */
export function parseDotenv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line);
    if (m === null) continue;
    let v = m[2]!.trim();
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).replace(/\\n/g, '\n').replace(/\\(["\\])/g, '$1');
    else if (v.length >= 2 && v.startsWith('\'') && v.endsWith('\'')) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out.set(m[1]!, v);
  }
  return out;
}

/** Valeur au chemin `a.b.0` d'un JSON ; undefined si un segment manque. */
function walk(root: unknown, path: string): unknown {
  let cur = root;
  for (const seg of path.split('.')) {
    if (Array.isArray(cur)) { if (!/^\d+$/.test(seg)) return undefined; cur = cur[Number(seg)]; }
    else if (isObj(cur)) { if (!Object.hasOwn(cur, seg)) return undefined; cur = cur[seg]; }
    else return undefined;
  }
  return cur;
}

function asText(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return undefined;
}

/** Résout `@file:…` / `@env:…`. Messages : le chemin et la clé, jamais la valeur ni un extrait du fichier. */
function resolveRef(kind: string, spec: string, where: string, o: RecipeOptions): string {
  if (o.refs === false) throw new RecipeError(`${where} : référence @${kind}: refusée ici (aucun fichier n'est lu pour un contenu reçu sans fichier) — utilisez la CLI : grasp state import <recette.json> ou grasp session create --state <recette.json>`);
  const hash = spec.lastIndexOf('#');
  const file = hash === -1 ? spec : spec.slice(0, hash);
  const key = hash === -1 ? undefined : spec.slice(hash + 1);
  if (file === '') throw new RecipeError(`${where} : @${kind}: sans chemin de fichier`);
  const path = refPath(file, o);
  const text = readRef(path, where, o);
  if (kind === 'env') {
    if (key === undefined || key === '') throw new RecipeError(`${where} : @env:${file} : nom de variable attendu (@env:${file}#NOM)`);
    const v = parseDotenv(text).get(key);
    if (v === undefined) throw new RecipeError(`${where} : variable ${key} absente de ${path}`);
    return v;
  }
  if (key === undefined) return text.replace(/\r?\n$/, '');
  let json: unknown;
  try { json = JSON.parse(text); } catch { throw new RecipeError(`${where} : ${path} n'est pas du JSON (le chemin « #${key} » s'applique à un fichier JSON ; sans « # » : contenu entier du fichier)`); }
  const v = asText(key === '' ? json : walk(json, key));
  if (v === undefined) throw new RecipeError(`${where} : chemin « ${key} » absent (ou nul) dans ${path}`);
  return v;
}

/** Libellé d'un masque : sûr à afficher et court (la clé peut contenir n'importe quoi). */
const labelOf = (area: string, key: string) => `${area}.${key.replace(/[^\p{L}\p{N}_.-]+/gu, '_').slice(0, 60)}`;

class Resolver {
  readonly masked: MaskedValue[] = [];
  readonly notes: string[] = [];
  constructor(private readonly o: RecipeOptions) {}

  value(raw: unknown, where: string, label: string): string {
    if (typeof raw === 'string') {
      if (raw.startsWith('@@')) return raw.slice(1);
      const m = REF_RE.exec(raw);
      if (m === null) return raw;
      const v = resolveRef(m[1]!, m[2]!, where, this.o);
      if (v.length < SECRET_MIN_LENGTH) this.notes.push(`${label} : valeur de ${v.length} caractère(s), trop courte pour être masquée dans les sorties`);
      else if (v.length > MASK_MAX_LENGTH) this.notes.push(`${label} : valeur de ${v.length} caractères, trop longue pour être masquée dans les sorties (${MASK_MAX_LENGTH} au plus)`);
      else this.masked.push({ label, value: v });
      return v;
    }
    const v = asText(raw);
    if (v === undefined) throw new RecipeError(`${where} : valeur attendue (chaîne, nombre, booléen, objet ou tableau JSON)`);
    return v;
  }

  items(raw: unknown, where: string, area: string): Array<{ name: string; value: string }> {
    if (raw === undefined) return [];
    if (!isObj(raw)) throw new RecipeError(`${where} : objet { "clé": "valeur" } attendu`);
    return Object.entries(raw).map(([name, v]) => {
      if (name === '') throw new RecipeError(`${where} : clé vide`);
      return { name, value: this.value(v, `${where}.${name}`, labelOf(area, name)) };
    });
  }

  cookies(raw: unknown, where: string, origin: URL): Array<Record<string, unknown>> {
    if (raw === undefined) return [];
    const base = { domain: origin.hostname, path: '/', secure: origin.protocol === 'https:' };
    if (isObj(raw)) return Object.entries(raw).map(([name, v]) => ({ name, value: this.value(v, `${where}.${name}`, labelOf('cookie', name)), ...base }));
    if (!Array.isArray(raw)) throw new RecipeError(`${where} : objet { "nom": "valeur" } ou tableau de cookies attendu`);
    return raw.map((c, i) => {
      const w = `${where}[${i}]`;
      if (!isObj(c)) throw new RecipeError(`${w} : objet { name, value, … } attendu`);
      for (const k of Object.keys(c)) if (!COOKIE_KEYS.has(k)) throw new RecipeError(`${w} : clé inconnue « ${k} » (${[...COOKIE_KEYS].join(', ')})`);
      if (typeof c.name !== 'string' || c.name === '') throw new RecipeError(`${w} : « name » requis`);
      const { value, ...rest } = c;
      return { ...base, ...rest, value: this.value(value, `${w}.value`, labelOf('cookie', c.name)) };
    });
  }
}

/**
 * Recette → état grasp-state, références résolues. `v` : une recette ou un tableau de recettes (une par origine).
 * Clé inconnue, origine non http(s), référence illisible : RecipeError, rien n'est importé.
 */
export function resolveRecipe(v: unknown, o: RecipeOptions = {}): ResolvedState {
  const list = Array.isArray(v) ? v : [v];
  const r = new Resolver(o);
  const cookies: Array<Record<string, unknown>> = [];
  const origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }> = [];
  let session: { origin: string; items: Array<{ name: string; value: string }> } | undefined;
  list.forEach((rec, i) => {
    const where = list.length > 1 ? `recette[${i}]` : 'recette';
    if (!isObj(rec)) throw new RecipeError(`${where} : objet { origin, localStorage, sessionStorage, cookies } attendu`);
    for (const k of Object.keys(rec)) if (!RECIPE_KEYS.has(k)) throw new RecipeError(`${where} : clé inconnue « ${k} » (${[...RECIPE_KEYS].join(', ')})`);
    if (rec.format !== undefined && rec.format !== RECIPE_FORMAT) throw new RecipeError(`${where} : format inconnu (attendu « ${RECIPE_FORMAT} »)`);
    const origin = typeof rec.origin === 'string' ? normalizeOrigin(rec.origin) : null;
    if (origin === null) throw new RecipeError(`${where} : « origin » : origine http(s) attendue (ex. https://app.exemple.com)`);
    const local = r.items(rec.localStorage, `${where}.localStorage`, 'localStorage');
    if (local.length > 0) origins.push({ origin, localStorage: local });
    const sess = r.items(rec.sessionStorage, `${where}.sessionStorage`, 'sessionStorage');
    if (sess.length > 0) {
      if (session !== undefined) throw new RecipeError(`${where}.sessionStorage : une seule origine peut porter un sessionStorage (il est propre à l'onglet) ; déjà donné pour ${session.origin}`);
      session = { origin, items: sess };
    }
    cookies.push(...r.cookies(rec.cookies, `${where}.cookies`, new URL(origin)));
  });
  const state = { format: STATE_FORMAT, version: STATE_VERSION, exportedAt: '', cookies, origins, ...(session !== undefined ? { sessionStorage: session } : {}) };
  return { state, masked: r.masked, notes: r.notes, recipe: true };
}

/** Contenu d'un fichier d'état OU d'une recette : la recette est résolue, tout autre contenu passe tel quel. */
export function resolveStateInput(v: unknown, o: RecipeOptions = {}): ResolvedState {
  return isRecipe(v) ? resolveRecipe(v, o) : { state: v, masked: [], notes: [], recipe: false };
}

/** Valide le champ `masked` reçu par le serveur : tableau de { label, value } ; tout le reste est refusé. */
export function maskedOf(v: unknown): MaskedValue[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new RecipeError('champ « masked » : tableau de { label, value } attendu');
  return v.map((m) => {
    if (!isObj(m) || typeof m.label !== 'string' || typeof m.value !== 'string' || m.label === '' || m.label.length > 80) throw new RecipeError('champ « masked » : { label, value } attendu');
    if (m.value.length > MASK_MAX_LENGTH) throw new RecipeError(`champ « masked » : valeur de ${m.value.length} caractères (${MASK_MAX_LENGTH} au plus)`);
    return { label: m.label.replace(/[^\p{L}\p{N}_.-]+/gu, '_'), value: m.value };
  });
}
