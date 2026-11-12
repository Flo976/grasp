/**
 * Secrets jamais vus par l'agent : `fill <sél> secret:NOM` remplit un champ avec une valeur gardée côté serveur,
 * restreinte à des domaines, et masquée (`secret:NOM`) dans toutes les sorties texte de Grasp.
 *
 * Inspiré du serveur MCP de Playwright (microsoft/playwright, Apache-2.0, v1.56.0) :
 * `Context.lookupSecret()` (packages/playwright/src/mcp/browser/context.ts) substitue la valeur d'un secret
 * nommé au moment de `fill`/`type`, et `Response._redactSecrets()` (packages/playwright/src/mcp/browser/response.ts)
 * remplace chaque valeur par `<secret>NOM</secret>` dans les réponses texte. Aucun code n'est repris. Différences
 * voulues : un nom inconnu est une erreur (Playwright tape alors le nom tel quel), chaque secret est restreint à
 * des domaines, et le masquage couvre aussi les formes encodées (URL, formulaire, JSON) et les valeurs coupées
 * par un budget de sortie (`…`).
 *
 * Magasin : un fichier JSON 0600 (`~/.config/grasp/secrets.json`), distinct de config.json, plutôt que des
 * variables d'environnement : un secret porte ses domaines, l'environnement du serveur est hérité par Chrome
 * et par le serveur lancé à la volée depuis le shell de l'agent (qui pourrait l'afficher), et `grasp secrets
 * list` relit ce que le serveur applique.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { GraspError } from './errors.js';
import { writePrivateFile } from './perms.js';
import { hostMatches, normalizeHost } from './remote.js';

export const SECRET_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
/** En deçà, masquer la valeur partout abîmerait les sorties (et désignerait la valeur à qui la cherche). */
export const SECRET_MIN_LENGTH = 4;
const SECRET_MAX_LENGTH = 4096;
/** Préfixe le plus court masqué quand une sortie coupe une valeur (`…`, ligne « … tronqué »). */
const PREFIX_MIN = 4;

export interface SecretEntry { name: string; value: string; domains: string[] }
export interface SecretInfo { name: string; domains: string[] }
/** Ce que le control plane transmet au bridge avec la valeur, pour le contrôle de domaine. */
export interface SecretUse { name: string; domains: string[] }

/** `secret:NOM` → NOM ; toute autre valeur → undefined (tapée telle quelle). */
export function secretRef(v: string): string | undefined {
  const m = /^secret:(.+)$/.exec(v);
  return m !== null && SECRET_NAME_RE.test(m[1]!) ? m[1] : undefined;
}

/** Domaine d'un secret : nom d'hôte ou `*.domaine` (syntaxe de l'allowlist), jamais `*` seul. */
function checkDomain(d: unknown, where: string): string {
  if (typeof d !== 'string' || d.trim() === '') throw new Error(`${where} : domaine vide ou non textuel`);
  if (d.includes(':') && !d.trim().startsWith('[')) throw new Error(`${where} : « ${d} » n'est pas un nom d'hôte (ni schéma, ni port : le secret vaut pour l'hôte, tous ports confondus)`);
  const t = normalizeHost(d.trim());
  if (t === '*') throw new Error(`${where} : « * » refusé — un secret est restreint à des domaines nommés`);
  if (!/^(\*\.)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(t) && !/^\[[0-9a-f:.]+\]$/.test(t)) throw new Error(`${where} : « ${d} » n'est pas un nom d'hôte (ni schéma, ni port, ni chemin ; *.domaine pour les sous-domaines)`);
  return t;
}

function checkValue(v: unknown, where: string): string {
  // Jamais la valeur dans un message : seulement sa nature ou sa longueur.
  if (typeof v !== 'string') throw new Error(`${where} : « value » doit être une chaîne`);
  if (v.length < SECRET_MIN_LENGTH) throw new Error(`${where} : valeur trop courte (${v.length} caractère(s), ${SECRET_MIN_LENGTH} au moins)`);
  if (v.length > SECRET_MAX_LENGTH) throw new Error(`${where} : valeur trop longue (${SECRET_MAX_LENGTH} caractères au plus)`);
  return v;
}

/** `{ "NOM": { "value": "…", "domains": ["preprod.exemple.com"] } }`. Clé inconnue ou mal typée : refus. */
export function parseSecrets(text: string, origin: string): Map<string, SecretEntry> {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error(`${origin} : JSON invalide`); }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${origin} : objet { "NOM": { "value", "domains" } } attendu`);
  const out = new Map<string, SecretEntry>();
  for (const [name, e] of Object.entries(raw as Record<string, unknown>)) {
    const where = `${origin} : secret « ${name} »`;
    if (!SECRET_NAME_RE.test(name)) throw new Error(`${origin} : nom de secret invalide « ${name.slice(0, 64)} » (lettre puis lettres, chiffres, _ ; 64 au plus)`);
    if (e === null || typeof e !== 'object' || Array.isArray(e)) throw new Error(`${where} : objet { "value", "domains" } attendu`);
    const o = e as Record<string, unknown>;
    for (const k of Object.keys(o)) if (k !== 'value' && k !== 'domains') throw new Error(`${where} : clé inconnue « ${k} »`);
    const value = checkValue(o.value, where);
    if (!Array.isArray(o.domains) || o.domains.length === 0) throw new Error(`${where} : « domains » doit être une liste non vide`);
    out.set(name, { name, value, domains: o.domains.map((d, i) => checkDomain(d, `${where}, domains[${i}]`)) });
  }
  return out;
}

export function parseDomains(raw: string): string[] {
  const list = raw.split(',').map((d) => d.trim()).filter((d) => d !== '');
  if (list.length === 0) throw new Error('--domains : au moins un domaine (ex. preprod.exemple.com,*.exemple.com)');
  return list.map((d, i) => checkDomain(d, `--domains[${i}]`));
}

/** Le domaine de `url` est-il couvert par le secret ? http(s) seulement. */
export function secretAllowedOn(domains: readonly string[], url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  return hostMatches(domains, normalizeHost(u.hostname)) !== null;
}

// ---------- Masquage ----------

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Formes sous lesquelles une valeur peut ressortir : brute, URL, formulaire, JSON, HTML. */
function variants(v: string): string[] {
  const form = new URLSearchParams({ x: v }).toString().slice(2);
  const html = v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return [...new Set([v, encodeURIComponent(v), form, JSON.stringify(v).slice(1, -1), html])].filter((x) => x.length >= SECRET_MIN_LENGTH);
}

/**
 * Remplace chaque valeur connue par `secret:NOM`. Un préfixe d'au moins 4 caractères d'une valeur est masqué
 * aussi quand il est suivi de `…` (nom, URL ou ligne de console coupés) ou de la ligne finale « … tronqué » :
 * une sortie bornée ne doit pas laisser fuir le début d'un secret.
 */
export class Redactor {
  private readonly byName = new Map<string, Set<string>>();
  private full: RegExp | undefined;
  private cut: RegExp | undefined;
  private readonly owner = new Map<string, string>();

  get size(): number { return this.byName.size; }

  /** Ajoute une valeur (jamais retirée : un secret supprimé du fichier reste masqué jusqu'à l'arrêt). */
  add(name: string, value: string): void {
    if (value.length < SECRET_MIN_LENGTH) return;
    const set = this.byName.get(name) ?? new Set<string>();
    if (set.has(value)) return;
    set.add(value);
    this.byName.set(name, set);
    this.compile();
  }

  private compile(): void {
    const full = new Set<string>();
    const prefixes = new Set<string>();
    this.owner.clear();
    for (const [name, vals] of this.byName) {
      for (const v of vals) {
        for (const x of variants(v)) {
          full.add(x);
          if (!this.owner.has(x)) this.owner.set(x, name);
          for (let k = x.length - 1; k >= PREFIX_MIN; k--) {
            const p = x.slice(0, k);
            prefixes.add(p);
            if (!this.owner.has(p)) this.owner.set(p, name);
          }
        }
      }
    }
    // Les plus longues d'abord : une valeur qui en contient une autre est masquée sous son propre nom.
    const alt = (set: Set<string>) => [...set].sort((a, b) => b.length - a.length).map(escapeRe).join('|');
    this.full = full.size > 0 ? new RegExp(alt(full), 'g') : undefined;
    this.cut = prefixes.size > 0 ? new RegExp(`(?:${alt(prefixes)})(?=…|\\n… tronqué)`, 'g') : undefined;
  }

  redact(s: string): string {
    if (this.full === undefined || s.length < PREFIX_MIN) return s;
    const to = (m: string) => `secret:${this.owner.get(m) ?? '?'}`;
    let out = s.replace(this.full, to);
    if (this.cut !== undefined) out = out.replace(this.cut, to);
    return out;
  }

  /** Objet JSON : chaque chaîne (pas les clés) masquée. */
  redactDeep<T>(v: T): T {
    if (this.full === undefined) return v;
    const walk = (x: unknown): unknown => {
      if (typeof x === 'string') return this.redact(x);
      if (Array.isArray(x)) return x.map(walk);
      if (x !== null && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, walk(y)]));
      return x;
    };
    return walk(v) as T;
  }

  /** Corps HTTP : JSON (chaînes masquées) ou texte ; binaire (capture, PDF) inchangé. */
  redactBody(contentType: string, body: Buffer): Buffer {
    if (this.full === undefined || body.length === 0) return body;
    if (contentType.startsWith('application/json')) {
      try { return Buffer.from(JSON.stringify(this.redactDeep(JSON.parse(body.toString('utf8'))))); } catch { /* texte */ }
    }
    if (contentType.startsWith('application/json') || contentType.startsWith('text/')) return Buffer.from(this.redact(body.toString('utf8')));
    return body;
  }
}

// ---------- Magasin (fichier 0600) ----------

/**
 * Fichier des secrets, relu quand il change (mtime, taille, inode) : `grasp secrets set` s'applique sans
 * redémarrage. Un fichier trop ouvert ou invalide n'est jamais lu en silence : erreur à la consultation (et
 * refus de démarrer). Toute valeur lue une fois reste masquée jusqu'à l'arrêt du serveur.
 */
export class SecretStore {
  readonly redactor = new Redactor();
  private entries = new Map<string, SecretEntry>();
  private stamp = '';
  private error: string | undefined;

  constructor(readonly file: string) {}

  /** Relit le fichier s'il a changé. Lève si le fichier est trop ouvert ou invalide. */
  refresh(): void {
    let st;
    try { st = statSync(this.file); } catch {
      this.entries = new Map(); this.stamp = 'absent'; this.error = undefined; return;
    }
    const stamp = `${st.ino}:${st.size}:${st.mtimeMs}:${st.mode}`;
    if (stamp === this.stamp) { if (this.error !== undefined) throw new Error(this.error); return; }
    this.stamp = stamp;
    try {
      if ((st.mode & 0o077) !== 0) throw new Error(`${this.file} est en ${(st.mode & 0o777).toString(8).padStart(4, '0')} (attendu 0600) → chmod 600 ${this.file}`);
      const uid = process.getuid?.();
      if (uid !== undefined && st.uid !== uid) throw new Error(`${this.file} appartient à l'uid ${st.uid}, pas à ${uid}`);
      this.entries = parseSecrets(readFileSync(this.file, 'utf8'), this.file);
      this.error = undefined;
    } catch (e) {
      this.entries = new Map();
      this.error = (e as Error).message;
      throw e;
    }
    for (const e of this.entries.values()) this.redactor.add(e.name, e.value);
  }

  /** Relecture tolérante (masquage des réponses) : une erreur sera dite à la consultation. */
  refreshQuietly(): void { try { this.refresh(); } catch { /* signalé par lookup/list */ } }

  lookup(name: string): SecretEntry {
    try { this.refresh(); } catch (e) { throw new GraspError(500, `magasin de secrets illisible : ${(e as Error).message}`); }
    const e = this.entries.get(name);
    if (e === undefined) {
      const names = [...this.entries.keys()];
      throw new GraspError(404, `secret « ${name} » inconnu (${names.length > 0 ? `secrets : ${names.join(', ')}` : 'aucun secret'}) — \`grasp secrets set ${name} --domains <hôte>\` (valeur sur stdin)`);
    }
    return e;
  }

  list(): { file: string; exists: boolean; secrets: SecretInfo[]; error?: string } {
    try { this.refresh(); } catch { /* rapporté ci-dessous */ }
    return {
      file: this.file, exists: existsSync(this.file),
      secrets: [...this.entries.values()].map((e) => ({ name: e.name, domains: [...e.domains] })).sort((a, b) => a.name.localeCompare(b.name)),
      ...(this.error !== undefined ? { error: this.error } : {}),
    };
  }
}

/** Lecture stricte du fichier (CLI, démarrage) : absent = vide ; trop ouvert ou invalide : exception. */
export function loadSecretsFile(file: string): Map<string, SecretEntry> {
  const s = new SecretStore(file);
  s.refresh();
  return new Map(s.list().secrets.map((i) => [i.name, s.lookup(i.name)]));
}

/** Écriture atomique 0600, puis relecture par le chemin du serveur (règle n°4) : sinon exception. */
function writeSecrets(file: string, m: Map<string, SecretEntry>): void {
  const obj = Object.fromEntries([...m.values()].map((e) => [e.name, { value: e.value, domains: e.domains }]));
  writePrivateFile(file, Buffer.from(`${JSON.stringify(obj, null, 2)}\n`));
  const back = loadSecretsFile(file);
  for (const [k, e] of m) {
    const b = back.get(k);
    if (b === undefined || b.value !== e.value || b.domains.join(',') !== e.domains.join(',')) throw new Error(`${file} : relecture différente de ce qui a été écrit (secret « ${k} »)`);
  }
  if (back.size !== m.size) throw new Error(`${file} : relecture différente de ce qui a été écrit`);
}

export function setSecret(file: string, name: string, value: string, domains: string[]): void {
  if (!SECRET_NAME_RE.test(name)) throw new Error(`nom de secret invalide « ${name.slice(0, 64)} » (lettre puis lettres, chiffres, _ ; 64 au plus)`);
  checkValue(value, `secret « ${name} »`);
  const m = loadSecretsFile(file);
  m.set(name, { name, value, domains: domains.map((d, i) => checkDomain(d, `domains[${i}]`)) });
  writeSecrets(file, m);
}

export function removeSecret(file: string, name: string): boolean {
  const m = loadSecretsFile(file);
  if (!m.delete(name)) return false;
  writeSecrets(file, m);
  return true;
}
