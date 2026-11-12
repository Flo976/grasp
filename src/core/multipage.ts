/**
 * Recette multi-pages : `grasp diff <urlA> <urlB>` (deux environnements comparés page par page) et `grasp audit`
 * (chaque page d'un sitemap ou d'une liste visitée et contrôlée). Orchestration au-dessus de l'API HTTP, comme
 * `grasp mcp` : chaque page passe par les routes ordinaires d'une session (`/navigate`, `/snap`, `/text`, `/console`,
 * `/expect`, `/inventory`, `/check-links`), donc par le garde, l'allowlist et la politique du bridge. Rien ici ne
 * parle CDP ni ne contourne la politique.
 */

import { formatEntry, type ConsoleEntry } from './console.js';
import { stripBoundaries } from './boundaries.js';

// ---------- Relevé fourni par le bridge (src/bridge/inventory.ts) ----------

export interface Inventory {
  url: string;
  /** Statut HTTP de la réponse du document (Navigation Timing `responseStatus`) ; null si inconnu (about:blank, cache). */
  status: number | null;
  contentType: string;
  /** `sitemap` (urlset), `sitemapindex`, ou `page`. */
  kind: 'sitemap' | 'sitemapindex' | 'page';
  /** Liens internes (même origine, http/https, sans fragment, dédoublonnés), dans l'ordre du document. */
  links: string[];
  linksOmitted: number;
  /** Entrées `<loc>` d'un sitemap ou d'un index de sitemaps. */
  locs: string[];
  locsOmitted: number;
}

export interface LinkCheck {
  url: string;
  /** Statut HTTP (HEAD, puis GET si la méthode est refusée) ; absent si la requête a échoué ou a été écartée. */
  status?: number;
  /** Redirection (non suivie : sa cible n'est pas vérifiée, et rien ne part hors de l'origine). */
  redirect?: boolean;
  error?: string;
  /** Écarté par le bridge avant toute requête (autre origine, hors allowlist). */
  skipped?: string;
}

// ---------- Transport ----------

export interface Reply { json(): unknown; text(): string }
/** Appel d'une route de la session ; une erreur porte `status` et le corps JSON (`extra`) quand il y en a un. */
export type Call = (method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs?: number) => Promise<Reply>;
interface CallError { message: string; status?: number; extra?: Record<string, unknown> }
const errOf = (e: unknown): CallError => (e ?? { message: 'erreur inconnue' }) as CallError;

export const DEFAULT_MAX_PAGES = 50;
export const MAX_PAGES = 1000;
export const DEFAULT_CONCURRENCY = 2;
export const MAX_CONCURRENCY = 8;
export const DEFAULT_MAX_LINKS = 200;
export const MAX_LINKS = 5000;
/** Texte lu par page pour la comparaison (au-delà : coupé, annoncé). */
export const DIFF_TEXT_MAX = 50_000;
/** Lignes de différence gardées par rubrique (JSON) ; le texte en montre moins. */
const KEEP_LINES = 50;
const SHOW_LINES = 6;
const LINE_CUT = 160;
const NAV_TIMEOUT_MS = 60_000;
/** Taille au-delà de laquelle le diff ligne à ligne (LCS, quadratique) cède la place à une différence d'ensembles. */
const LCS_MAX_CELLS = 4_000_000;

// ---------- Relevé d'une page ----------

export type ConsoleFacts = { errors: string[]; requests: string[]; omitted: number } | { unavailable: string };
export type FormFacts = { items: string[] } | { unavailable: string };

export interface PageFacts {
  /** URL demandée. */
  url: string;
  finalUrl?: string;
  title?: string;
  /** Statut HTTP du document (null : inconnu). */
  status?: number | null;
  /** Navigation impossible : refusée par le garde (`blocked`) ou échouée. */
  error?: string;
  blocked?: boolean;
  /** Note de la navigation (page encore instable…). */
  note?: string;
  console: ConsoleFacts;
  /** Plan de la page : titres et repères (régions) du snapshot, sans refs. */
  outline?: string[];
  text?: { scope: 'main' | 'page'; lines: string[]; truncated: boolean };
  forms?: FormFacts;
  inventory?: Inventory;
  ms: number;
  /** Frontières de contenu actives (contentBoundaries) : marqueurs du bridge retirés, rapport à encadrer. */
  framed?: boolean;
}

export interface VisitWants { outline?: boolean; text?: boolean; forms?: boolean }

/** Une entrée console sans son numéro ni son niveau (toutes sont des erreurs) : « network GET … → 404 Not Found ». */
export function entryLine(e: ConsoleEntry): string {
  return formatEntry(e).replace(/^#\d+ error\s+/, '');
}

const isRequest = (e: ConsoleEntry) => e.source === 'network' || e.source === 'grasp';
/**
 * Icône demandée d'office par Chrome à la racine de l'origine (`/favicon.ico`), une fois par session et par
 * origine : attribuée à la première page visitée, au hasard du partage entre sessions. Écartée des relevés.
 */
const AUTO_FAVICON = /^network GET https?:\/\/[^/\s]+\/favicon\.ico → /;
/** Ligne de snapshot sans sa ref (inutile une fois la session fermée). */
const unref = (l: string) => l.replace(/^(\s*)[a-z0-9]+:/, '$1');

/**
 * Visite une page dans la session de `call` : navigation (garde et allowlist du bridge), erreurs console et
 * requêtes en échec depuis le début de la navigation, statut HTTP et liens (`/inventory`), et selon `want` le plan
 * (snapshot), le texte principal (`main`, sinon la page) et les erreurs de formulaire.
 */
export async function visitPage(call: Call, url: string, want: VisitWants = {}): Promise<PageFacts> {
  const t0 = Date.now();
  const f: PageFacts = { url, console: { unavailable: 'non lue' }, ms: 0 };
  let since: number | undefined;
  let off = 'console indisponible';
  try { since = Number(((await call('POST', '/console', { limit: 1 })).json() as { seq: number }).seq); } catch (e) { off = errOf(e).message; }
  // Frontières de contenu : les marqueurs du bridge (un nonce par réponse) sont retirés de ce qui est comparé et
  // rapporté — sinon chaque page « différerait » par ses nonces ; le rapport entier est encadré par la CLI.
  const unwrap = (t: string) => { const u = stripBoundaries(t); if (u.framed) f.framed = true; return u.text; };
  try {
    const n = (await call('POST', '/navigate', { url }, NAV_TIMEOUT_MS)).json() as { url: string; title: string; detail?: string; boundary?: unknown };
    if (n.boundary !== undefined) f.framed = true;
    f.finalUrl = n.url;
    f.title = n.title;
    if (typeof n.detail === 'string' && n.detail !== '') f.note = unwrap(n.detail);
  } catch (e) {
    const ce = errOf(e);
    f.error = unwrap(ce.message);
    if (ce.status === 403) f.blocked = true;
  }
  if (since === undefined) f.console = { unavailable: off };
  else {
    try {
      const c = (await call('POST', '/console', { since, level: 'error', limit: 200 })).json() as { entries: ConsoleEntry[]; omitted: number };
      const errs = c.entries.filter((x) => x.source !== 'navigation' && x.level === 'error');
      f.console = { errors: errs.filter((x) => !isRequest(x)).map(entryLine), requests: errs.filter(isRequest).map(entryLine).filter((l) => !AUTO_FAVICON.test(l)), omitted: c.omitted };
    } catch (e) { f.console = { unavailable: errOf(e).message }; }
  }
  if (f.error !== undefined) { f.ms = Date.now() - t0; return f; }
  try {
    f.inventory = (await call('GET', '/inventory')).json() as Inventory;
    f.status = f.inventory.status;
  } catch (e) { f.note = [f.note, `relevé de la page impossible : ${errOf(e).message}`].filter(Boolean).join(' ; '); }
  // La réponse du document lui-même (404, 500) est rapportée par son statut, pas une deuxième fois en requête.
  if ('requests' in f.console && typeof f.status === 'number' && f.status >= 400 && f.finalUrl !== undefined) {
    const own = `network GET ${f.finalUrl} → ${f.status}`;
    const i = f.console.requests.findIndex((l) => l.startsWith(own));
    if (i >= 0) f.console.requests.splice(i, 1);
  }
  if (want.outline === true) {
    try { f.outline = outlineOf(unwrap((await call('GET', '/snap?max=1000000')).text())); } catch (e) { f.note = [f.note, `snapshot impossible : ${unwrap(errOf(e).message)}`].filter(Boolean).join(' ; '); }
  }
  if (want.text === true) {
    let scope: 'main' | 'page' = 'main';
    let raw: string | undefined;
    try { raw = (await call('GET', `/text?scope=main&max=${DIFF_TEXT_MAX}`)).text(); } catch { scope = 'page'; }
    if (raw === undefined) {
      try { raw = (await call('GET', `/text?max=${DIFF_TEXT_MAX}`)).text(); } catch (e) { f.note = [f.note, `texte illisible : ${unwrap(errOf(e).message)}`].filter(Boolean).join(' ; '); }
    }
    if (raw !== undefined) f.text = { scope, ...textLines(unwrap(raw)) };
  }
  if (want.forms === true) {
    try {
      await call('POST', '/expect', { kind: 'no-form-errors' });
      f.forms = { items: [] };
    } catch (e) {
      const items = (errOf(e).extra?.expect as { items?: unknown } | undefined)?.items;
      f.forms = Array.isArray(items) ? { items: items.map((i) => unref(String(i))) } : { unavailable: unwrap(errOf(e).message) };
    }
  }
  f.ms = Date.now() - t0;
  return f;
}

/** Lignes non vides, espaces normalisés ; la ligne de troncature de `text` retirée et signalée. */
export function textLines(raw: string): { lines: string[]; truncated: boolean } {
  let truncated = false;
  const lines: string[] = [];
  for (const l of raw.split('\n')) {
    if (/^… tronqué : \d+ caractères restants/.test(l)) { truncated = true; continue; }
    const t = l.replace(/\s+/g, ' ').trim();
    if (t !== '') lines.push(t);
  }
  return { lines, truncated };
}

/** Rôles retenus pour le plan d'une page : titres et repères. */
const OUTLINE_ROLES = new Set(['heading', 'banner', 'navigation', 'main', 'contentinfo', 'complementary', 'region', 'search', 'form', 'dialog', 'alertdialog']);

/**
 * Plan d'une page depuis le snapshot : une ligne par titre ou repère, `rôle[niveau] "nom"`, sans ref ni état,
 * indentée selon l'imbrication des seules lignes retenues (un conteneur de plus ou de moins n'y change rien).
 */
export function outlineOf(snap: string): string[] {
  const out: string[] = [];
  const stack: number[] = [];
  for (const line of snap.split('\n')) {
    const m = /^( *)(?:[a-z0-9]+:)?([A-Za-z]+)(\[\d+\])?(?: "((?:[^"\\]|\\.)*)")?/.exec(line);
    if (m === null || !OUTLINE_ROLES.has(m[2]!)) continue;
    const indent = m[1]!.length;
    while (stack.length > 0 && stack[stack.length - 1]! >= indent) stack.pop();
    out.push(`${'  '.repeat(stack.length)}${m[2]}${m[3] ?? ''}${m[4] !== undefined ? ` "${m[4]}"` : ''}`);
    stack.push(indent);
  }
  return out;
}

// ---------- Différences ----------

export interface LineDiff { removed: string[]; added: string[] }

/**
 * Différence ligne à ligne (plus longue sous-suite commune) : lignes propres à A (`removed`) et à B (`added`),
 * dans l'ordre. Au-delà de LCS_MAX_CELLS, différence de multi-ensembles (l'ordre n'est plus comparé).
 */
export function diffLines(a: readonly string[], b: readonly string[]): LineDiff {
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length;
  let eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const A = a.slice(s, ea);
  const B = b.slice(s, eb);
  if (A.length === 0 || B.length === 0) return { removed: A, added: B };
  if (A.length * B.length > LCS_MAX_CELLS) return multisetDiff(A, B);
  const n = A.length;
  const m = B.length;
  // L[i][j] = LCS de A[i..] et B[j..], à plat.
  const L = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i * (m + 1) + j] = A[i] === B[j] ? L[(i + 1) * (m + 1) + j + 1]! + 1 : Math.max(L[(i + 1) * (m + 1) + j]!, L[i * (m + 1) + j + 1]!);
    }
  }
  const removed: string[] = [];
  const added: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { i++; j++; } else if (L[(i + 1) * (m + 1) + j]! >= L[i * (m + 1) + j + 1]!) removed.push(A[i++]!); else added.push(B[j++]!);
  }
  while (i < n) removed.push(A[i++]!);
  while (j < m) added.push(B[j++]!);
  return { removed, added };
}

/** Lignes en trop de chaque côté, comptées (doublons compris), ordre de A puis de B. */
export function multisetDiff(a: readonly string[], b: readonly string[]): LineDiff {
  const count = new Map<string, number>();
  for (const x of b) count.set(x, (count.get(x) ?? 0) + 1);
  const removed: string[] = [];
  for (const x of a) {
    const c = count.get(x) ?? 0;
    if (c > 0) count.set(x, c - 1); else removed.push(x);
  }
  const left = new Map<string, number>();
  for (const x of a) left.set(x, (left.get(x) ?? 0) + 1);
  const added: string[] = [];
  for (const x of b) {
    const c = left.get(x) ?? 0;
    if (c > 0) left.set(x, c - 1); else added.push(x);
  }
  return { removed, added };
}

export type DiffKind = 'navigation' | 'statut' | 'titre' | 'structure' | 'texte' | 'console' | 'requêtes';

export interface PageDifference {
  what: DiffKind;
  /** Valeurs simples (statut, titre, navigation). */
  a?: string;
  b?: string;
  /** Lignes propres à A / à B (50 au plus) et leur nombre réel. */
  removed?: string[];
  added?: string[];
  removedCount?: number;
  addedCount?: number;
  /** Précision : zone du texte comparée, texte coupé, console non lue… */
  note?: string;
}

export interface PageComparison {
  /** Chemin tel qu'écrit dans --paths (ou chemin de urlA sans --paths). */
  path: string;
  urlA: string;
  urlB: string;
  same: boolean;
  differences: PageDifference[];
  /** Ce qui n'a pas pu être comparé (console non lue d'un côté…) : dit, jamais compté comme identique en silence. */
  notes: string[];
  msA: number;
  msB: number;
}

export interface CompareOptions { originA: string; originB: string; ignore?: RegExp | undefined }

/** Remplace l'origine propre à l'environnement par `{origine}`, pour que deux URL homologues soient égales. */
export function neutral(s: string, origin: string): string {
  if (origin === '') return s;
  // Origine entière seulement : http://h:80 ne touche ni http://h:8080 ni http://h:80.exemple.org.
  return s.replace(new RegExp(`${origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w.:-])`, 'g'), '{origine}');
}

function prep(lines: readonly string[], origin: string, ignore: RegExp | undefined): string[] {
  const out: string[] = [];
  for (const l of lines) {
    const n = neutral(l, origin);
    if (ignore !== undefined) { ignore.lastIndex = 0; if (ignore.test(n)) continue; }
    out.push(n);
  }
  return out;
}

function lineDifference(what: DiffKind, d: LineDiff, note?: string): PageDifference | undefined {
  if (d.removed.length === 0 && d.added.length === 0) return undefined;
  return { what, removed: d.removed.slice(0, KEEP_LINES), added: d.added.slice(0, KEEP_LINES), removedCount: d.removed.length, addedCount: d.added.length, ...(note !== undefined ? { note } : {}) };
}

/** Compare les relevés d'une même page dans deux environnements. */
export function comparePages(path: string, a: PageFacts, b: PageFacts, o: CompareOptions): PageComparison {
  const diffs: PageDifference[] = [];
  const notes: string[] = [];
  const nA = (s: string) => neutral(s, o.originA);
  const nB = (s: string) => neutral(s, o.originB);
  const r: PageComparison = { path, urlA: a.url, urlB: b.url, same: true, differences: diffs, notes, msA: a.ms, msB: b.ms };
  if (a.error !== undefined || b.error !== undefined) {
    diffs.push({ what: 'navigation', a: a.error ?? 'OK', b: b.error ?? 'OK' });
    r.same = false;
    return r;
  }
  if ((a.status ?? null) !== (b.status ?? null)) diffs.push({ what: 'statut', a: String(a.status ?? 'inconnu'), b: String(b.status ?? 'inconnu') });
  const ign = (s: string) => { if (o.ignore === undefined) return false; o.ignore.lastIndex = 0; return o.ignore.test(s); };
  const tA = nA(a.title ?? '');
  const tB = nB(b.title ?? '');
  if (tA !== tB && !(ign(tA) && ign(tB))) diffs.push({ what: 'titre', a: a.title ?? '', b: b.title ?? '' });
  if (a.outline !== undefined && b.outline !== undefined) {
    const d = lineDifference('structure', diffLines(prep(a.outline, o.originA, o.ignore), prep(b.outline, o.originB, o.ignore)));
    if (d !== undefined) diffs.push(d);
  } else if (a.outline !== undefined || b.outline !== undefined) notes.push(`structure non comparée : snapshot illisible côté ${a.outline === undefined ? 'A' : 'B'}`);
  if (a.text !== undefined && b.text !== undefined) {
    const zone = a.text.scope === b.text.scope ? (a.text.scope === 'main' ? 'main' : 'page') : `A ${a.text.scope}, B ${b.text.scope}`;
    const cut = a.text.truncated || b.text.truncated ? `, coupé à ${DIFF_TEXT_MAX} caractères` : '';
    const d = lineDifference('texte', diffLines(prep(a.text.lines, o.originA, o.ignore), prep(b.text.lines, o.originB, o.ignore)), `${zone}${cut}`);
    if (d !== undefined) diffs.push(d);
    else if (a.text.scope !== b.text.scope) notes.push(`texte comparé sur des zones différentes (${zone})`);
  } else if (a.text !== undefined || b.text !== undefined) notes.push(`texte non comparé : illisible côté ${a.text === undefined ? 'A' : 'B'}`);
  const ca = a.console;
  const cb = b.console;
  if ('errors' in ca && 'errors' in cb) {
    const dc = lineDifference('console', multisetDiff(prep(ca.errors, o.originA, o.ignore), prep(cb.errors, o.originB, o.ignore)));
    if (dc !== undefined) diffs.push(dc);
    const dr = lineDifference('requêtes', multisetDiff(prep(ca.requests, o.originA, o.ignore), prep(cb.requests, o.originB, o.ignore)));
    if (dr !== undefined) diffs.push(dr);
    if (ca.omitted > 0 || cb.omitted > 0) notes.push('console : plus de 200 erreurs d\'un côté, comparaison partielle');
  } else notes.push(`console non comparée (${'unavailable' in ca ? `A : ${ca.unavailable}` : `B : ${(cb as { unavailable: string }).unavailable}`})`);
  for (const [k, f] of [['A', a], ['B', b]] as const) if (f.note !== undefined) notes.push(`${k} : ${f.note}`);
  r.same = diffs.length === 0;
  return r;
}

// ---------- Rapports ----------

const cut = (s: string, n = LINE_CUT) => (s.length <= n ? s : `${s.slice(0, n)}…`);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export interface DiffResult {
  ok: boolean;
  a: string;
  b: string;
  ms: number;
  pages: PageComparison[];
  /** Chemins au-delà de --max, non comparés. */
  notCompared: string[];
  concurrency: number;
  /** Frontières de contenu actives : le rapport texte est encadré (contenu des pages). */
  contentBoundaries?: true;
}

/** Pages détaillées dans le rapport texte ; au-delà, une ligne par page. */
const DETAILED_PAGES = 40;

const LABEL: Record<DiffKind, string> = { navigation: 'navigation', statut: 'statut HTTP', titre: 'titre', structure: 'structure', texte: 'texte', console: 'console', 'requêtes': 'requêtes en échec' };

function sideLines(L: string[], d: PageDifference): void {
  const r = d.removedCount ?? 0;
  const a = d.addedCount ?? 0;
  const head = [r > 0 ? `${r} seulement dans A` : '', a > 0 ? `${a} seulement dans B` : ''].filter(Boolean).join(', ');
  L.push(`     ${LABEL[d.what]}${d.note !== undefined && d.what === 'texte' ? ` (${d.note})` : ''} : ${head}`);
  const show = (lines: string[] | undefined, total: number, sign: string) => {
    for (const l of lines === undefined ? [] : lines.slice(0, SHOW_LINES)) L.push(`       ${sign} ${cut(l)}`);
    if (total > SHOW_LINES) L.push(`       ${sign} … et ${total - SHOW_LINES} autre(s)`);
  };
  show(d.removed, r, '-');
  show(d.added, a, '+');
}

/** Rapport de `grasp diff` : une ligne par page identique (regroupées), le détail borné des différences. */
export function formatDiff(r: DiffResult): string {
  const diff = r.pages.filter((p) => !p.same);
  const same = r.pages.filter((p) => p.same);
  const L: string[] = [];
  L.push(`== diff : ${r.ok ? 'IDENTIQUES' : 'DIFFÉRENCES'} — ${plural(r.pages.length, 'page', 'pages')} : ${same.length} identique${same.length > 1 ? 's' : ''}, ${diff.length} différente${diff.length > 1 ? 's' : ''} (${r.ms} ms, ${plural(r.concurrency, 'session', 'sessions')})`);
  L.push(`A = ${r.a}`);
  L.push(`B = ${r.b}`);
  if (diff.length > 0) L.push('(- : seulement dans A ; + : seulement dans B ; origines remplacées par {origine})');
  for (const [i, p] of diff.entries()) {
    if (i >= DETAILED_PAGES) { L.push(`≠  ${p.path} : ${p.differences.map((d) => LABEL[d.what]).join(', ')}`); continue; }
    L.push(`≠  ${p.path}`);
    for (const d of p.differences) {
      if (d.removed !== undefined || d.added !== undefined) sideLines(L, d);
      else L.push(`     ${LABEL[d.what]} : A ${d.what === 'titre' ? `« ${cut(d.a ?? '', 100)} »` : cut(d.a ?? '')} ; B ${d.what === 'titre' ? `« ${cut(d.b ?? '', 100)} »` : cut(d.b ?? '')}`);
    }
    for (const n of p.notes) L.push(`     note: ${cut(n)}`);
  }
  if (same.length > 0) {
    L.push(`=  ${cut(same.map((p) => p.path).join(', '), 400)}`);
    for (const p of same) for (const n of p.notes) L.push(`     note (${p.path}) : ${cut(n)}`);
  }
  if (r.notCompared.length > 0) L.push(`AVERTISSEMENT : ${plural(r.notCompared.length, 'chemin', 'chemins')} au-delà de --max non comparé${r.notCompared.length > 1 ? 's' : ''} : ${cut(r.notCompared.join(', '), 200)}`);
  return L.join('\n');
}

export interface AuditPage {
  url: string;
  finalUrl?: string;
  title?: string;
  status?: number | null;
  error?: string;
  blocked?: boolean;
  note?: string;
  console: ConsoleFacts;
  forms?: FormFacts;
  /** Nombre de problèmes de la page (statut ≥ 400, navigation impossible, erreurs console, requêtes, formulaire). */
  problems: number;
  ms: number;
}

export interface BrokenLink { url: string; status?: number; error?: string; from: string[] }

export interface AuditResult {
  ok: boolean;
  source: string;
  ms: number;
  concurrency: number;
  pages: AuditPage[];
  /** URL au-delà de --max, non visitées. */
  notVisited: number;
  links: {
    checked: number;
    broken: BrokenLink[];
    /** Liens non vérifiés : budget --max-links épuisé. */
    unchecked: number;
    /** Liens écartés sans requête (déconnexion probable, --ignore, autre origine, hors allowlist). */
    skipped: Array<{ url: string; reason: string }>;
    disabled?: boolean;
  };
  notes: string[];
  /** Frontières de contenu actives : le rapport texte est encadré (contenu des pages). */
  contentBoundaries?: true;
}

export function auditPageOf(f: PageFacts, ignore?: RegExp): AuditPage {
  const keep = (l: string) => { if (ignore === undefined) return true; ignore.lastIndex = 0; return !ignore.test(l); };
  const con: ConsoleFacts = 'errors' in f.console ? { errors: f.console.errors.filter(keep), requests: f.console.requests.filter(keep), omitted: f.console.omitted } : f.console;
  const p: AuditPage = { url: f.url, console: con, problems: 0, ms: f.ms };
  if (f.finalUrl !== undefined) p.finalUrl = f.finalUrl;
  if (f.title !== undefined) p.title = f.title;
  if (f.status !== undefined) p.status = f.status;
  if (f.error !== undefined) p.error = f.error;
  if (f.blocked === true) p.blocked = true;
  if (f.note !== undefined) p.note = f.note;
  if (f.forms !== undefined) p.forms = f.forms;
  let n = 0;
  if (p.error !== undefined) n++;
  if (typeof p.status === 'number' && p.status >= 400) n++;
  if ('errors' in con) n += con.errors.length + con.requests.length;
  if (p.forms !== undefined && 'items' in p.forms) n += p.forms.items.length;
  p.problems = n;
  return p;
}

/** Lien qu'un simple GET pourrait faire agir (déconnexion) : jamais vérifié, signalé. */
export function riskyLink(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  return /log-?out|log-?off|sign-?out|d[ée]connexion|disconnect/i.test(lenientDecode(`${u.pathname}${u.search}`));
}

/**
 * Décodage qui ne lève jamais : Chrome garde tels quels dans a.href un « % » isolé
 * (/promo-100%), une séquence invalide (/a%zz) ou un ancien encodage latin-1 (%E9).
 * Chaque suite de %XX est décodée en UTF-8, à défaut octet par octet (latin-1) ;
 * le reste est laissé brut.
 */
function lenientDecode(s: string): string {
  try { return decodeURIComponent(s); } catch { /* décodage tolérant ci-dessous */ }
  return s.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
    try { return decodeURIComponent(run); } catch { return run.replace(/%([0-9a-f]{2})/gi, (_m, h: string) => String.fromCharCode(parseInt(h, 16))); }
  });
}

/** Rapport de `grasp audit` : une ligne par page, le détail borné des problèmes, puis les liens cassés. */
export function formatAudit(r: AuditResult): string {
  const ko = r.pages.filter((p) => p.problems > 0);
  const L: string[] = [];
  const lk = r.links;
  const linksHead = lk.disabled === true ? 'liens non vérifiés (--no-links)' : `liens internes : ${lk.checked} vérifié${lk.checked > 1 ? 's' : ''}, ${lk.broken.length} cassé${lk.broken.length > 1 ? 's' : ''}`;
  L.push(`== audit : ${r.ok ? 'OK' : 'ÉCHEC'} — ${plural(r.pages.length, 'page', 'pages')} : ${r.pages.length - ko.length} OK, ${ko.length} avec problèmes ; ${linksHead} (${r.ms} ms, ${plural(r.concurrency, 'session', 'sessions')})`);
  for (const p of r.pages) {
    const st = p.error !== undefined ? '---' : String(p.status ?? '?');
    L.push(`${p.problems > 0 ? 'KO' : 'OK'}  ${st} ${cut(p.url, 120)}${p.title !== undefined && p.title !== '' ? ` « ${cut(p.title, 60)} »` : ''} (${p.ms} ms)`);
    if (p.finalUrl !== undefined && p.finalUrl !== p.url) L.push(`      → ${cut(p.finalUrl, 120)}`);
    if (p.error !== undefined) L.push(`      ${p.blocked === true ? 'refusée' : 'navigation impossible'} : ${cut(p.error)}`);
    if (typeof p.status === 'number' && p.status >= 400) L.push(`      statut HTTP ${p.status}`);
    const c = p.console;
    if ('unavailable' in c) L.push(`      console : non lue (${cut(c.unavailable, 100)})`);
    else {
      for (const [label, list] of [['console', c.errors], ['requêtes en échec', c.requests]] as const) {
        if (list.length === 0) continue;
        L.push(`      ${label} : ${list.length}`);
        for (const l of list.slice(0, 5)) L.push(`        ${cut(l)}`);
        if (list.length > 5) L.push(`        … et ${list.length - 5} autre(s)`);
      }
      if (c.omitted > 0) L.push(`      AVERTISSEMENT : ${c.omitted} erreur(s) console plus ancienne(s) non lue(s) (200 au plus)`);
    }
    if (p.forms !== undefined) {
      if ('unavailable' in p.forms) L.push(`      formulaire : non lu (${cut(p.forms.unavailable, 100)})`);
      else if (p.forms.items.length > 0) {
        L.push(`      formulaire au chargement : ${p.forms.items.length}`);
        for (const i of p.forms.items.slice(0, 5)) L.push(`        ${cut(i)}`);
      }
    }
    if (p.note !== undefined) L.push(`      note: ${cut(p.note)}`);
  }
  if (lk.broken.length > 0) {
    L.push(`liens cassés : ${lk.broken.length}`);
    for (const b of lk.broken.slice(0, 30)) L.push(`  ${b.status !== undefined ? b.status : 'ERR'} ${cut(b.url, 120)}${b.error !== undefined ? ` (${cut(b.error, 80)})` : ''} — sur ${cut(b.from[0] ?? '?', 100)}${b.from.length > 1 ? ` et ${b.from.length - 1} autre(s) page(s)` : ''}`);
    if (lk.broken.length > 30) L.push(`  … et ${lk.broken.length - 30} autre(s)`);
  }
  if (lk.unchecked > 0) L.push(`AVERTISSEMENT : ${plural(lk.unchecked, 'lien interne non vérifié', 'liens internes non vérifiés')} (budget --max-links atteint)`);
  if (lk.skipped.length > 0) L.push(`liens écartés sans requête : ${lk.skipped.length} — ${cut(lk.skipped.slice(0, 5).map((s) => `${s.url} (${s.reason})`).join(', '), 300)}`);
  if (r.notVisited > 0) L.push(`AVERTISSEMENT : ${plural(r.notVisited, 'page', 'pages')} au-delà de --max non visitée${r.notVisited > 1 ? 's' : ''}`);
  for (const n of r.notes) L.push(`note: ${cut(n, 300)}`);
  return L.join('\n');
}

// ---------- Entrées ----------

/** Liste d'URL ou de chemins : une par ligne, lignes vides et commentaires `#` ignorés. */
export function parseList(src: string): string[] {
  return src.split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'));
}

/** URL absolue http(s), sans fragment ; sinon erreur qui cite l'entrée. */
export function absoluteUrl(raw: string, base?: string): string {
  let u: URL;
  try { u = base === undefined ? new URL(raw) : new URL(raw, base); } catch { throw new Error(`URL invalide : ${raw}${base === undefined ? ' (URL absolue http(s):// attendue)' : ''}`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`URL http(s) attendue : ${raw}`);
  u.hash = '';
  return u.href;
}

export function dedupe(urls: readonly string[]): string[] {
  return [...new Set(urls)];
}

/** Entier borné d'une option (« --max 0 » ou « --max abc » refusés, jamais ignorés). */
export function boundedInt(v: string | true | undefined, name: string, def: number, max: number): number {
  if (v === undefined) return def;
  if (v === true) throw new Error(`--${name} attend une valeur`);
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`--${name} ${v} : entier de 1 à ${max} attendu`);
  return n;
}

// ---------- Exécution ----------

/** Exécute `fn` sur chaque élément avec `workers` (une session chacun), dans l'ordre d'arrivée des tâches. */
export async function pool<T, R>(items: readonly T[], workers: readonly Call[], fn: (call: Call, item: T, index: number) => Promise<R>, signal?: AbortSignal): Promise<Array<R | undefined>> {
  const out: Array<R | undefined> = new Array(items.length);
  let next = 0;
  await Promise.all(workers.map(async (call) => {
    while (next < items.length && signal?.aborted !== true) {
      const k = next++;
      out[k] = await fn(call, items[k]!, k);
    }
  }));
  return out;
}

/** Origine d'une URL de base (``{origine}`` dans les rapports). */
export function originOf(u: string): string {
  try { return new URL(u).origin; } catch { return ''; }
}

export interface DiffOptions { urlA: string; urlB: string; paths?: string[] | undefined; max: number; ignore?: RegExp | undefined }

/** `grasp diff` : chaque chemin visité dans A puis dans B par la même session, puis comparé. */
export async function runDiff(o: DiffOptions, workers: readonly Call[], signal?: AbortSignal): Promise<DiffResult> {
  const t0 = Date.now();
  const all = o.paths ?? [new URL(o.urlA).pathname + new URL(o.urlA).search];
  const targets = (o.paths === undefined ? [{ path: all[0]!, a: absoluteUrl(o.urlA), b: absoluteUrl(o.urlB) }] : all.map((p) => ({ path: p, a: absoluteUrl(p, o.urlA), b: absoluteUrl(p, o.urlB) })));
  const kept = targets.slice(0, o.max);
  const want: VisitWants = { outline: true, text: true };
  const opts: CompareOptions = { originA: originOf(o.urlA), originB: originOf(o.urlB), ignore: o.ignore };
  let framed = false;
  const res = await pool(kept, workers, async (call, t) => {
    const a = await visitPage(call, t.a, want);
    const b = await visitPage(call, t.b, want);
    if (a.framed === true || b.framed === true) framed = true;
    return comparePages(t.path, a, b, opts);
  }, signal);
  const pages = res.filter((p): p is PageComparison => p !== undefined);
  return { ok: pages.length === kept.length && pages.every((p) => p.same), a: o.urlA, b: o.urlB, ms: Date.now() - t0, pages, notCompared: targets.slice(o.max).map((t) => t.path), concurrency: workers.length, ...(framed ? { contentBoundaries: true as const } : {}) };
}

export interface AuditOptions { urls: string[]; source: string; max: number; maxLinks: number; checkLinks: boolean; ignore?: RegExp | undefined; notes?: string[] }

/**
 * `grasp audit` : chaque page visitée (statut, console, requêtes, formulaire au chargement) ; ses liens internes
 * vérifiés depuis la page, chacun une seule fois pour tout l'audit, dans la limite de `maxLinks`.
 */
export async function runAudit(o: AuditOptions, workers: readonly Call[], signal?: AbortSignal): Promise<AuditResult> {
  const t0 = Date.now();
  const urls = dedupe(o.urls);
  const kept = urls.slice(0, o.max);
  /** Lien → résultat de la vérification (ou en cours), et pages où il figure. */
  const seen = new Map<string, { from: string[]; result?: LinkCheck }>();
  const skipped: Array<{ url: string; reason: string }> = [];
  let unchecked = 0;
  let budget = o.maxLinks;
  let framed = false;
  const res = await pool(kept, workers, async (call, url) => {
    const f = await visitPage(call, url, { forms: true });
    if (f.framed === true) framed = true;
    const page = auditPageOf(f, o.ignore);
    if (!o.checkLinks || f.inventory === undefined || f.error !== undefined) return page;
    const here = f.finalUrl ?? url;
    const fresh: string[] = [];
    for (const l of f.inventory.links) {
      const s = seen.get(l);
      if (s !== undefined) { s.from.push(here); continue; }
      seen.set(l, { from: [here] });
      if (o.ignore !== undefined) { o.ignore.lastIndex = 0; if (o.ignore.test(l)) { skipped.push({ url: l, reason: '--ignore' }); continue; } }
      if (riskyLink(l)) { skipped.push({ url: l, reason: 'déconnexion probable' }); continue; }
      if (budget <= 0) { unchecked++; continue; }
      budget--;
      fresh.push(l);
    }
    unchecked += f.inventory.linksOmitted;
    for (let i = 0; i < fresh.length; i += 50) {
      const batch = fresh.slice(i, i + 50);
      try {
        const r = (await call('POST', '/check-links', { urls: batch }, 120_000)).json() as { results: LinkCheck[] };
        for (const x of r.results) {
          const s = seen.get(x.url);
          if (x.skipped !== undefined) skipped.push({ url: x.url, reason: x.skipped });
          else if (s !== undefined) s.result = x;
        }
      } catch (e) {
        for (const u of batch) { const s = seen.get(u); if (s !== undefined) s.result = { url: u, error: `vérification impossible : ${errOf(e).message}` }; }
      }
    }
    return page;
  }, signal);
  const pages = res.filter((p): p is AuditPage => p !== undefined);
  const broken: BrokenLink[] = [];
  let checked = 0;
  for (const [url, s] of seen) {
    if (s.result === undefined) continue;
    checked++;
    const x = s.result;
    if (x.error !== undefined || (x.status !== undefined && x.status >= 400)) broken.push({ url, ...(x.status !== undefined ? { status: x.status } : {}), ...(x.error !== undefined ? { error: x.error } : {}), from: [...new Set(s.from)] });
  }
  const ok = pages.length === kept.length && pages.every((p) => p.problems === 0) && broken.length === 0;
  return {
    ok, source: o.source, ms: Date.now() - t0, concurrency: workers.length, pages, notVisited: urls.length - kept.length,
    links: { checked, broken, unchecked, skipped, ...(o.checkLinks ? {} : { disabled: true }) },
    notes: o.notes === undefined ? [] : o.notes,
    ...(framed ? { contentBoundaries: true as const } : {}),
  };
}

/**
 * Pages à auditer depuis une URL : sitemap (`urlset`) → ses `<loc>` ; index de sitemaps → les `<loc>` de chacun
 * (50 sitemaps au plus) ; page HTML → la page et ses liens internes (un niveau).
 */
export async function discover(call: Call, url: string, max: number): Promise<{ urls: string[]; notes: string[] }> {
  const notes: string[] = [];
  const f = await visitPage(call, url);
  if (f.error !== undefined) return { urls: [url], notes };
  const inv = f.inventory;
  if (inv === undefined) return { urls: [url], notes: ['relevé impossible : page seule auditée'] };
  if (inv.kind === 'page') {
    notes.push(`${url} n'est pas un sitemap : la page et ses ${plural(inv.links.length + inv.linksOmitted, 'lien interne', 'liens internes')} (un niveau)`);
    return { urls: dedupe([absoluteUrl(url), ...inv.links.filter((l) => !riskyLink(l))]), notes };
  }
  const locs = (list: string[]) => list.flatMap((l) => { try { return [absoluteUrl(l)]; } catch { notes.push(`entrée de sitemap ignorée : ${cut(l, 100)}`); return []; } });
  if (inv.kind === 'sitemap') {
    if (inv.locsOmitted > 0) notes.push(`sitemap : ${inv.locsOmitted} entrée(s) au-delà de 5000 non lues`);
    notes.push(`sitemap ${url} : ${plural(inv.locs.length, 'entrée', 'entrées')}`);
    return { urls: locs(inv.locs), notes };
  }
  const children = locs(inv.locs);
  const urls: string[] = [];
  let read = 0;
  for (const c of children.slice(0, 50)) {
    if (urls.length >= max) break;
    const g = await visitPage(call, c);
    read++;
    if (g.error !== undefined || g.inventory === undefined) { notes.push(`sitemap ${c} illisible : ${g.error ?? 'relevé impossible'}`); continue; }
    urls.push(...locs(g.inventory.locs));
  }
  notes.push(`index de sitemaps ${url} : ${read}/${children.length} sitemap(s) lu(s), ${plural(urls.length, 'entrée', 'entrées')}`);
  return { urls, notes };
}
