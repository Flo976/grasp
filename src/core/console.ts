import { GraspError, badRequest } from './errors.js';

/**
 * Console du navigateur : tampon circulaire par onglet (dans le bridge) et mise en forme compacte
 * (partagée avec le CLI). Ne contient jamais de corps de requête/réponse ni d'en-têtes.
 */

export type ConsoleLevel = 'error' | 'warn' | 'info' | 'debug';
export const LEVELS: readonly ConsoleLevel[] = ['error', 'warn', 'info', 'debug'];

export interface ConsoleEntry {
  seq: number;
  /** Horodatage (ms epoch) côté bridge. */
  at: number;
  level: ConsoleLevel;
  /** console | exception | network | grasp | navigation | sources du domaine Log (security, deprecation, intervention, violation…). */
  source: string;
  text: string;
  url?: string;
  line?: number;
  col?: number;
  /** URL du cadre, si l'entrée vient d'une iframe. */
  frame?: string;
  /** Requête bloquée par le garde de navigation de Grasp. */
  blocked?: true;
  /** Doublons consécutifs fusionnés (requêtes uniquement). */
  count?: number;
}

export type NewEntry = Omit<ConsoleEntry, 'seq' | 'at' | 'count'>;

export interface ConsoleQuery { level?: ConsoleLevel | undefined; since?: number | undefined; limit?: number | undefined }
export interface ConsoleResult {
  entries: ConsoleEntry[];
  /** Dernier seq attribué : à passer en --since à l'appel suivant. */
  seq: number;
  /** Entrées postérieures à `since` tombées du tampon circulaire avant d'avoir été lues. */
  dropped: number;
  /** Lignes (après fusion) écartées par `limit` : les plus anciennes. */
  omitted: number;
}

const RANK: Record<ConsoleLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

export function isLevel(v: string): v is ConsoleLevel { return Object.hasOwn(RANK, v); }

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}… (+${s.length - max} car.)`;
}

export class ConsoleBuffer {
  private readonly items: ConsoleEntry[] = [];
  private last = 0;
  /** Plus petit seq encore disponible si rien n'avait été vidé volontairement. */
  private clearedUpTo = 0;

  constructor(private readonly capacity = 1000, private readonly maxText = 2000) {}

  get seq(): number { return this.last; }

  push(e: NewEntry): ConsoleEntry {
    const entry: ConsoleEntry = { ...e, text: truncate(e.text, this.maxText), seq: ++this.last, at: Date.now() };
    this.items.push(entry);
    if (this.items.length > this.capacity) this.items.shift();
    return entry;
  }

  query(q: ConsoleQuery): ConsoleResult {
    if (q.level !== undefined && !isLevel(q.level)) throw badRequest(`niveau inconnu « ${String(q.level)} » (niveaux : ${LEVELS.join(', ')})`);
    const since = q.since !== undefined ? q.since : 0;
    // Curseur venu d'un autre tampon (bridge relancé, bascule de profil) : sans cette erreur, les entrées
    // suivantes seraient masquées en silence jusqu'à ce que le compteur rattrape l'ancien seq.
    if (since > this.last) throw new GraspError(409, `since ${since} dépasse le seq courant ${this.last} : le tampon a été recréé (bascule de profil, bridge relancé) — reprenez avec --since 0`, { seq: this.last });
    const oldest = this.items.length > 0 ? this.items[0]!.seq : this.last + 1;
    const firstWanted = Math.max(since, this.clearedUpTo) + 1;
    const dropped = Math.max(0, Math.min(oldest, this.last + 1) - firstWanted);
    const max = q.level !== undefined ? RANK[q.level] : RANK.debug;
    // Fusion AVANT le filtre de niveau : ×N ne regroupe que des entrées réellement consécutives dans le
    // tampon (rien de masqué par --level entre elles). Les repères de navigation restent quel que soit le niveau.
    const merged = mergeRuns(this.items.filter((e) => e.seq > since)).filter((e) => e.source === 'navigation' || RANK[e.level] <= max);
    const limited = q.limit !== undefined ? merged.slice(-q.limit) : merged;
    return { entries: limited, seq: this.last, dropped, omitted: merged.length - limited.length };
  }

  /** Vide le tampon (le compteur seq continue : les --since restent valides). */
  clear(): void {
    this.items.length = 0;
    this.clearedUpTo = this.last;
  }
}

/** Fusionne les entrées consécutives identiques (même niveau, source, texte, emplacement, cadre). */
export function mergeRuns(entries: readonly ConsoleEntry[]): ConsoleEntry[] {
  const out: ConsoleEntry[] = [];
  for (const e of entries) {
    const prev = out[out.length - 1];
    if (prev !== undefined && prev.level === e.level && prev.source === e.source && prev.text === e.text && prev.url === e.url && prev.line === e.line && prev.frame === e.frame && prev.blocked === e.blocked) {
      prev.count = (prev.count !== undefined ? prev.count : 1) + 1;
      continue;
    }
    out.push({ ...e, count: 1 });
  }
  return out;
}

// ---------- Mise en forme des arguments console (RemoteObject CDP) ----------

interface PropertyPreview { name: string; type: string; subtype?: string; value?: string }
interface ObjectPreview { type: string; subtype?: string; description?: string; overflow?: boolean; properties?: PropertyPreview[]; entries?: unknown[] }
export interface RemoteObjectLike { type: string; subtype?: string; className?: string; value?: unknown; unserializableValue?: string; description?: string; preview?: ObjectPreview }

function firstLine(s: string): string { const i = s.indexOf('\n'); return i < 0 ? s : s.slice(0, i); }

function previewValue(p: PropertyPreview): string {
  if (p.type === 'string') return JSON.stringify(p.value !== undefined ? p.value : '');
  if (p.type === 'object' && p.subtype === undefined && (p.value === 'Object' || p.value === undefined)) return '{…}';
  if (p.type === 'function') return 'ƒ';
  return p.value !== undefined ? p.value : p.type;
}

function formatPreview(o: RemoteObjectLike, p: ObjectPreview): string {
  const props = p.properties !== undefined ? p.properties : [];
  const more = p.overflow === true ? ', …' : '';
  if (p.subtype === 'array' || o.subtype === 'array') return `[${props.map(previewValue).join(', ')}${more}]`;
  const body = `{${props.map((x) => `${x.name}: ${previewValue(x)}`).join(', ')}${more}}`;
  const cls = o.className !== undefined && o.className !== 'Object' ? `${o.className} ` : '';
  return `${cls}${body}`;
}

export function formatArg(o: RemoteObjectLike): string {
  switch (o.type) {
    case 'string': return String(o.value);
    case 'undefined': return 'undefined';
    case 'number': case 'boolean': case 'bigint':
      return o.unserializableValue !== undefined ? o.unserializableValue : o.value !== undefined ? String(o.value) : (o.description !== undefined ? o.description : o.type);
    case 'symbol': return o.description !== undefined ? o.description : 'Symbol()';
    case 'function': {
      const m = /^(?:async\s+)?(?:function\s*\*?\s*([\w$]*)|class\s+([\w$]+))/.exec(o.description !== undefined ? o.description : '');
      const name = m !== null ? (m[1] !== undefined && m[1] !== '' ? m[1] : m[2] !== undefined ? m[2] : '') : '';
      return `ƒ ${name}()`;
    }
    case 'object': {
      if (o.subtype === 'null') return 'null';
      if (o.subtype === 'error') return firstLine(o.description !== undefined ? o.description : 'Error');
      if (o.subtype === 'node') return o.description !== undefined ? o.description : 'Node';
      if (o.preview !== undefined) return formatPreview(o, o.preview);
      return o.description !== undefined ? o.description : 'Object';
    }
    default: return o.description !== undefined ? o.description : o.type;
  }
}

/** Arguments de console.* : chaîne de format (%s %d %i %f %o %O %c) puis arguments restants séparés par des espaces. */
export function formatArgs(args: readonly RemoteObjectLike[]): string {
  const rest = [...args];
  let head = '';
  const first = rest[0];
  if (first !== undefined && first.type === 'string' && typeof first.value === 'string' && first.value.includes('%')) {
    rest.shift();
    head = first.value.replace(/%([sdifoOc%])/g, (m, k: string) => {
      if (k === '%') return '%';
      const a = rest.shift();
      if (a === undefined) return m;
      if (k === 'c') return '';
      if (k === 'd' || k === 'i') { const n = Number(a.value); return Number.isFinite(n) ? String(Math.trunc(n)) : 'NaN'; }
      if (k === 'f') return String(Number(a.value));
      return formatArg(a);
    });
  }
  return [head, ...rest.map(formatArg)].filter((s, i) => i > 0 || s !== '' || rest.length === 0).join(' ');
}

export function levelOfConsoleType(type: string): ConsoleLevel {
  switch (type) {
    case 'error': case 'assert': return 'error';
    case 'warning': return 'warn';
    case 'debug': case 'trace': return 'debug';
    default: return 'info';
  }
}

export function levelOfLog(level: string): ConsoleLevel {
  switch (level) {
    case 'error': return 'error';
    case 'warning': return 'warn';
    case 'verbose': return 'debug';
    default: return 'info';
  }
}

const SENSITIVE_PARAM = /token|key|secret|pass|auth|session|sig|jwt|credential|code/i;

/** URL affichable : identifiants retirés, valeurs de paramètres sensibles masquées, longueur bornée. */
export function redactUrl(raw: string, max = 150): string {
  if (raw.startsWith('data:')) {
    const comma = raw.indexOf(',');
    const head = raw.slice(0, comma >= 0 ? Math.min(comma + 1, 60) : 30);
    return `${head}${raw.slice(head.length, head.length + 20)}…`;
  }
  let u: URL;
  try { u = new URL(raw); } catch { return raw.length > max ? `${raw.slice(0, max)}…` : raw; }
  u.username = '';
  u.password = '';
  let s = `${u.origin}${u.pathname}`;
  if (u.search !== '') {
    const parts: string[] = [];
    for (const [k, v] of u.searchParams) parts.push(`${encodeURIComponent(k)}=${SENSITIVE_PARAM.test(k) ? '***' : encodeURIComponent(v)}`);
    s += `?${parts.join('&')}`;
  }
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

const URL_IN_TEXT = /\b(?:https?|wss?):\/\/[^\s'"`<>]+/g;

/** Texte rédigé par le navigateur (domaine Log : CSP, contenu mixte…) : chaque URL qu'il recopie est masquée par redactUrl. */
export function redactUrlsIn(text: string): string {
  return text.replace(URL_IN_TEXT, (u) => redactUrl(u, 300));
}

/** Fichier d'une URL pour l'affichage « (fichier:ligne) » : dernier segment du chemin, sinon l'hôte. */
function fileOf(url: string): string {
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter((x) => x !== '');
    return seg.length > 0 ? seg[seg.length - 1]! : u.host;
  } catch { return url.length > 40 ? `${url.slice(0, 40)}…` : url; }
}

const LINE_MAX = 300;

/** « #seq niveau source texte (fichier:ligne) ×N » ; repère : « #seq navigation → url ». */
export function formatEntry(e: ConsoleEntry): string {
  if (e.source === 'navigation') return `#${e.seq} navigation → ${e.text}`;
  const text = truncate(e.text.replace(/\s*\n\s*/g, ' ⏎ '), LINE_MAX);
  const where = e.url !== undefined && e.line !== undefined ? ` (${fileOf(e.url)}:${e.line})` : '';
  const frame = e.frame !== undefined ? ' [iframe]' : '';
  const n = e.count !== undefined && e.count > 1 ? ` ×${e.count}` : '';
  return `#${e.seq} ${e.level.padEnd(5)} ${e.source}${frame} ${text}${where}${n}`;
}
