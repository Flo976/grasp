/**
 * Historique des commandes d'une session (`grasp history`), tenu par le control plane, en mémoire seulement.
 * Une commande est mémorisée sous la forme d'une ligne de `grasp run` reconstruite depuis la requête reçue
 * (même syntaxe, relue par `parseScript` / `buildRequest`) ; `--as-run` en tire un script rejouable :
 * refs traduites en sélecteurs durables, lectures pures omises, valeurs secrètes masquées.
 */

import { EXPECT_KINDS } from './expect.js';

/** Entrées retenues par session (les plus anciennes sont oubliées, et c'est annoncé) : un script de run en accepte autant. */
export const HISTORY_MAX = 500;
/** Au-delà, la valeur d'un argument n'est pas conservée et la ligne n'est pas rejouable (annoncé). */
export const HISTORY_ARG_MAX = 4096;
/** `grasp history` sans --as-run : entrées affichées par défaut (les plus récentes). */
export const HISTORY_DEFAULT_LIMIT = 50;
/** Valeur affichée à la place d'un secret : jamais la valeur, ni sa longueur. */
export const MASK = '<masqué>';

/** Même motif que les refs du bridge (`e` + hash base36). */
export const HISTORY_REF_RE = /^e[0-9a-z]{1,4}$/;

/**
 * action : rejouée ; wait / expect : rejouées (synchronisation, vérification) ; read : lecture pure, omise du
 * script ; offline : pas de ligne de run (state import) : laissée en commentaire.
 */
export type HistoryKind = 'action' | 'wait' | 'expect' | 'read' | 'offline';

/** Ligne de commande reconstruite : commande, options (dans l'ordre), arguments positionnels. */
export interface CommandLine { cmd: string; flags: Array<[string, string | true]>; pos: string[] }

/** Cible d'une commande, telle que le bridge l'a décrite AVANT l'action (l'élément peut disparaître ensuite). */
export interface TargetInfo {
  /** Sélecteur reçu (ref, CSS, text:, frame=…). */
  given: string;
  /** Sélecteur durable retenu pour le script ; absent = non traduit (la ref reste, commentée). */
  durable?: string;
  /** text : nom accessible unique ; css : sélecteur vérifié unique ; given : sélecteur déjà durable. */
  how?: 'text' | 'css' | 'given';
  role?: string;
  name?: string;
  /** Pourquoi le nom accessible n'a pas suffi, ou pourquoi la ref n'est pas traduite. */
  note?: string;
  /** Champ secret (password…) : true ; null = inconnu (la valeur est alors masquée, par prudence). */
  secret?: boolean | null;
}

export interface HistoryEntry {
  seq: number;
  at: string;
  ms: number;
  ok: boolean;
  status?: number;
  error?: string;
  /** `run` : étape d'un `grasp run` ; `api` : commande isolée (CLI, MCP, HTTP). */
  via: 'run' | 'api';
  kind: HistoryKind;
  line: CommandLine;
  target?: TargetInfo;
  /** Raison du masquage d'une valeur (la valeur elle-même n'a jamais été conservée). */
  masked?: string;
  /** Raison pour laquelle la ligne n'est pas rejouable telle quelle (valeur trop longue…). */
  unreplayable?: string;
}

const READS = new Set(['snap', 'text', 'console', 'screenshot', 'cookies', 'pdf', 'state export', 'location']);

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined);

/** Options communes des actions, dans l'ordre de la CLI. */
function actionFlags(b: Record<string, unknown>): Array<[string, string | true]> {
  const f: Array<[string, string | true]> = [];
  if (b.snapDiff === true) f.push(['snap-diff', true]);
  if (str(b.max) !== undefined) f.push(['max', str(b.max)!]);
  if (str(b.scope) !== undefined) f.push(['scope', str(b.scope)!]);
  if (b.console === true) f.push(['console', true]);
  if (b.shotOnError === true) f.push(['shot-on-error', true]);
  if (str(b.engine) !== undefined) f.push(['engine', str(b.engine)!]);
  return f;
}

/**
 * Requête reçue par le control plane → ligne de commande équivalente (l'inverse de `buildRequest`).
 * undefined : route sans commande (interne) — rien n'est mémorisé.
 */
export function commandOf(method: string, pathWithQuery: string, body: Record<string, unknown> | undefined): { line: CommandLine; kind: HistoryKind } | undefined {
  const u = new URL(pathWithQuery, 'http://h');
  const q = u.searchParams;
  const b = body ?? {};
  const t = str(b.target);
  const L = (cmd: string, pos: string[], flags: Array<[string, string | true]> = [], kind?: HistoryKind) => ({ line: { cmd, flags, pos }, kind: kind ?? (READS.has(cmd) ? 'read' : 'action') });
  switch (`${method} ${u.pathname}`) {
    case 'POST /navigate': return L('nav', [str(b.url) ?? ''], actionFlags(b));
    case 'POST /click': return L('click', [t ?? ''], actionFlags(b));
    case 'POST /hover': return L('hover', [t ?? ''], actionFlags(b));
    case 'POST /fill': return L('fill', [t ?? '', str(b.value) ?? ''], actionFlags(b));
    case 'POST /select': return L('select', [t ?? '', str(b.value) ?? ''], actionFlags(b));
    case 'POST /check': return L('check', [t ?? ''], [...(b.checked === false ? [['uncheck', true] as [string, true]] : []), ...actionFlags(b)]);
    case 'POST /press': return L('press', [str(b.key) ?? '', ...(t !== undefined ? [t] : [])], actionFlags(b));
    case 'POST /type': return L('type', [t ?? '', str(b.text) ?? ''], [...(str(b.delay) !== undefined ? [['delay', str(b.delay)!] as [string, string]] : []), ...actionFlags(b)]);
    case 'POST /upload': {
      const files = Array.isArray(b.files) ? b.files.map(String) : [];
      return L('upload', [t ?? '', ...files], str(b.engine) !== undefined ? [['engine', str(b.engine)!]] : []);
    }
    case 'POST /eval': return L('eval', [str(b.expression) ?? '']);
    case 'POST /wait': {
      const f: Array<[string, string | true]> = [];
      for (const k of ['text', 'sel', 'timeout'] as const) if (str(b[k]) !== undefined) f.push([k, str(b[k])!]);
      if (b.idle === true) f.push(['idle', true]);
      return L('wait', [], f, 'wait');
    }
    case 'POST /expect': {
      const kind = str(b.kind) ?? '';
      if (!(EXPECT_KINDS as readonly string[]).includes(kind)) return undefined;
      const pos = [kind];
      const f: Array<[string, string | true]> = [];
      if (kind === 'value' || kind === 'sel' || kind === 'no-sel') pos.push(t ?? '');
      if (b.expected !== undefined) {
        if (b.match === 'contains') pos.push('~');
        pos.push(str(b.expected) ?? '');
        if (b.match === 'regex') f.push(['regex', true]);
      }
      for (const k of ['timeout', 'scope', 'since', 'ignore'] as const) if (str(b[k]) !== undefined) f.push([k, str(b[k])!]);
      if (b.shotOnError === true) f.push(['shot-on-error', true]);
      return L('expect', pos, f, 'expect');
    }
    case 'GET /snap': case 'GET /text': {
      const f: Array<[string, string | true]> = [];
      if (q.get('max') !== null) f.push(['max', q.get('max')!]);
      if (q.get('scope') !== null) f.push(['scope', q.get('scope')!]);
      if (q.get('nameMax') !== null) f.push(['name-max', q.get('nameMax')!]);
      if (q.get('markdown') !== null) f.push(['markdown', true]);
      return L(u.pathname.slice(1), [], f);
    }
    case 'GET /console': case 'POST /console': {
      const src = method === 'GET' ? Object.fromEntries(q) : b;
      const f: Array<[string, string | true]> = [];
      for (const k of ['level', 'since', 'limit'] as const) if (str(src[k]) !== undefined) f.push([k, str(src[k])!]);
      if (src.clear === true || src.clear === '1') f.push(['clear', true]);
      return L('console', [], f);
    }
    case 'GET /screenshot': {
      const f: Array<[string, string | true]> = [];
      if (q.get('full') !== null) f.push(['full', true]);
      if (q.get('refs') !== null) f.push(['refs', true]);
      for (const [k, flag] of [['el', 'el'], ['quality', 'quality'], ['maxWidth', 'max-width'], ['format', 'format']] as const) if (q.get(k) !== null) f.push([flag, q.get(k)!]);
      return L('screenshot', [], f);
    }
    case 'GET /cookies': return L('cookies', []);
    case 'GET /pdf': return L('pdf', []);
    // Le contenu de l'état n'est jamais conservé (cookies) : seulement le fait.
    case 'GET /state/export': return L('state export', []);
    case 'POST /state/import': return L('state import', [], [], 'offline');
    case 'POST /profile': return L('profile', [str(b.name) ?? '']);
    default: return undefined;
  }
}

/** Positions des arguments qui désignent un élément (traduits en sélecteur durable). */
export function targetIndex(line: CommandLine): number | undefined {
  switch (line.cmd) {
    case 'click': case 'hover': case 'fill': case 'select': case 'check': case 'type': case 'upload': return 0;
    case 'press': return line.pos.length > 1 ? 1 : undefined;
    case 'expect': return ['value', 'sel', 'no-sel'].includes(line.pos[0] ?? '') ? 1 : undefined;
    default: return undefined;
  }
}

/** Sélecteur visé par la commande (wait --sel compris). */
export function targetOf(line: CommandLine): string | undefined {
  const i = targetIndex(line);
  if (i !== undefined) return line.pos[i];
  if (line.cmd === 'wait') { const s = line.flags.find(([k]) => k === 'sel')?.[1]; return typeof s === 'string' ? s : undefined; }
  return undefined;
}

/** Commandes dont l'argument saisi peut être secret : masqué si le champ l'est (ou si on ne sait pas). */
export function valueIndex(line: CommandLine): number | undefined {
  return line.cmd === 'fill' || line.cmd === 'type' ? 1 : undefined;
}

/** Faut-il demander au bridge de décrire la cible avant l'action ? (ref à traduire, ou saisie à vérifier) */
export function wantsTarget(line: CommandLine): boolean {
  const t = targetOf(line);
  if (t === undefined || t === '') return false;
  return HISTORY_REF_RE.test(t.trim()) || valueIndex(line) !== undefined;
}

/** Mot sûr sans guillemets pour `splitLine` (pas de blanc, de guillemet, d'antislash ni de # en tête). */
const BARE = /^(?!#$)[A-Za-z0-9_@%+=:,./~^\[\]()*!?#-]+$/;

/** Cite un argument pour `splitLine` : nu si possible, sinon '…' (une ' interne devient '\''). */
export function quoteArg(s: string): string {
  if (BARE.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Ligne de run : commande, arguments, options (ordre de la CLI). Un argument qui commence par « - » serait pris
 * pour une option : les options passent alors devant, puis `--`, puis les arguments.
 */
export function renderLine(line: CommandLine): string {
  const flags: string[] = [];
  for (const [k, v] of line.flags) { flags.push(`--${k}`); if (v !== true) flags.push(quoteArg(v)); }
  const pos = line.pos.map(quoteArg);
  const dash = line.pos.some((p) => p.startsWith('-'));
  return [...line.cmd.split(' '), ...(dash ? [...flags, '--', ...pos] : [...pos, ...flags])].join(' ');
}

/**
 * Journal borné d'une session : HISTORY_MAX entrées, les plus anciennes oubliées (compteur `forgotten`).
 * `seq` croît sans fin : `--since <seq>` reprend après une entrée donnée, comme `console --since`.
 */
export class HistoryLog {
  private entries: HistoryEntry[] = [];
  private next = 1;
  /** Entrées oubliées faute de place (pas celles effacées par --clear). */
  forgotten = 0;
  /** Dernier seq effacé volontairement (--clear) : ce qui précède n'est pas « oublié ». */
  private floor = 0;
  constructor(private readonly max = HISTORY_MAX) {}

  /** Réserve un numéro (au début de la commande : l'ordre suit l'arrivée, pas la fin). */
  reserve(): number { return this.next++; }

  push(e: HistoryEntry): void {
    // Insertion à sa place (deux commandes concurrentes peuvent finir dans le désordre).
    let i = this.entries.length;
    while (i > 0 && this.entries[i - 1]!.seq > e.seq) i--;
    this.entries.splice(i, 0, e);
    while (this.entries.length > this.max) { this.entries.shift(); this.forgotten++; }
  }

  get seq(): number { return this.next - 1; }

  since(seq: number): HistoryEntry[] { return this.entries.filter((e) => e.seq > seq); }

  /** Entrées oubliées postérieures à `seq` (un script --since antérieur à la fenêtre serait incomplet). */
  lostAfter(seq: number): number {
    const first = this.entries[0]?.seq ?? this.next;
    return Math.max(0, first - 1 - Math.max(seq, this.floor));
  }

  get size(): number { return this.entries.length; }

  clear(): void { this.entries = []; this.floor = this.next - 1; }
}

/**
 * Masque la valeur d'une saisie secrète et borne les arguments. Appelé AVANT de conserver l'entrée : un mot de
 * passe n'est jamais retenu, même en mémoire.
 */
export function sanitize(e: HistoryEntry): HistoryEntry {
  const vi = valueIndex(e.line);
  if (vi !== undefined && e.line.pos[vi] !== undefined) {
    const s = e.target?.secret;
    const why = s === true ? 'champ secret : password, ou autocomplete de mot de passe, de code ou de carte' : s === undefined || s === null ? 'type du champ non vérifiable : masqué par prudence' : undefined;
    if (why !== undefined) { e.line.pos[vi] = MASK; e.masked = why; }
  }
  if (e.line.pos.some((p) => p.length > HISTORY_ARG_MAX) || e.line.flags.some(([, v]) => typeof v === 'string' && v.length > HISTORY_ARG_MAX)) {
    const long = e.line.pos.findIndex((p) => p.length > HISTORY_ARG_MAX);
    if (long >= 0) { e.unreplayable = `argument de ${e.line.pos[long]!.length} caractères non conservé (${HISTORY_ARG_MAX} au plus)`; e.line.pos[long] = `<${e.line.pos[long]!.length} caractères>`; }
    for (const f of e.line.flags) if (typeof f[1] === 'string' && f[1].length > HISTORY_ARG_MAX) { e.unreplayable = `option --${f[0]} de ${f[1].length} caractères non conservée`; f[1] = `<${f[1].length} caractères>`; }
  }
  if (e.error !== undefined && e.error.length > 300) e.error = `${e.error.slice(0, 300)}…`;
  return e;
}

const cut = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

/** `grasp history` : une ligne par entrée, bornée (arguments coupés à 80 caractères pour la lecture). */
export function formatHistory(entries: HistoryEntry[]): string {
  return entries.map((e) => {
    const shown: CommandLine = { cmd: e.line.cmd, flags: e.line.flags.map(([k, v]) => [k, typeof v === 'string' ? cut(v, 80) : v]), pos: e.line.pos.map((p) => cut(p, 80)) };
    const time = e.at.slice(11, 19);
    const tr = e.target?.durable !== undefined && e.target.durable !== e.target.given ? ` → ${quoteArg(cut(e.target.durable, 80))}` : '';
    const extra = [e.masked !== undefined ? 'valeur masquée' : undefined, e.via === 'run' ? 'run' : undefined].filter(Boolean).join(', ');
    return `#${e.seq} ${time} ${e.ok ? 'OK' : 'KO'} ${renderLine(shown)}${tr} (${e.ms} ms${extra !== '' ? `, ${extra}` : ''})${e.ok ? '' : ` — ${e.status ?? ''} ${cut(e.error ?? '', 160)}`}`;
  }).join('\n');
}

/** Options d'affichage propres à l'appel (sortie, budget) : retirées du script rejoué. */
const OUTPUT_FLAGS = new Set(['snap-diff', 'max', 'scope', 'console', 'shot-on-error']);

export interface AsRunOptions {
  sessionId: string;
  /** Lignes `expect` à ajouter en fin de script (état final). */
  expects?: string[];
  /** Entrées oubliées dans la fenêtre demandée. */
  lost?: number;
  now?: Date;
}

/**
 * Script `grasp run` rejouable. Règles :
 * - lectures pures (snap, text, console, screenshot, cookies, pdf, state export) omises (comptées en tête) ;
 * - commandes en échec omises (citées en tête) : elles n'ont pas eu l'effet voulu ;
 * - options d'affichage retirées (--snap-diff, --max, --scope, --console, --shot-on-error) ;
 * - ref → sélecteur durable relevé avant l'action ; ref non traduite : gardée, avec la raison en commentaire ;
 * - valeur masquée ou ligne non rejouable : ligne commentée, à compléter (jamais une fausse valeur saisie).
 */
export function asRunScript(entries: HistoryEntry[], o: AsRunOptions): string {
  const body: string[] = [];
  const reads = new Map<string, number>();
  const failed: HistoryEntry[] = [];
  let masked = 0;
  let untranslated = 0;
  for (const e of entries) {
    if (e.kind === 'read') { reads.set(e.line.cmd, (reads.get(e.line.cmd) ?? 0) + 1); continue; }
    if (!e.ok) { failed.push(e); continue; }
    if (e.kind === 'offline') { body.push(`# ${renderLine(e.line)}   # #${e.seq} : hors run, à refaire à part (grasp ${e.line.cmd} <fichier>)`); continue; }
    const line: CommandLine = { cmd: e.line.cmd, flags: e.line.flags.filter(([k]) => e.kind !== 'action' || !OUTPUT_FLAGS.has(k)), pos: [...e.line.pos] };
    const notes: string[] = [];
    const t = e.target;
    const ti = targetIndex(line);
    const given = targetOf(line);
    if (t !== undefined && t.durable !== undefined && given !== undefined) {
      if (ti !== undefined) line.pos[ti] = t.durable;
      else line.flags = line.flags.map(([k, v]) => (k === 'sel' ? [k, t.durable!] : [k, v]));
      if (t.how === 'css' && HISTORY_REF_RE.test(given.trim())) notes.push(`${given}${t.role !== undefined ? ` ${t.role}${t.name ? ` "${cut(t.name, 40)}"` : ''}` : ''}${t.note !== undefined ? ` : ${t.note}` : ''}`);
    } else if (given !== undefined && HISTORY_REF_RE.test(given.trim())) {
      untranslated++;
      notes.push(`ref non traduite${t?.note !== undefined ? ` : ${t.note}` : ''} — se rejoue seulement si la page est identique`);
    }
    const text = renderLine(line);
    if (e.masked !== undefined) { masked++; body.push(`# ${text}   # #${e.seq} : valeur masquée, ${e.masked} — décommentez et complétez avant de rejouer`); continue; }
    if (e.unreplayable !== undefined) { body.push(`# ${text}   # #${e.seq} : ${e.unreplayable}`); continue; }
    body.push(notes.length > 0 ? `${text}   # ${notes.join(' ; ')}` : text);
  }
  const head: string[] = [];
  const first = entries[0]?.seq;
  const last = entries.at(-1)?.seq;
  head.push(`# grasp history --as-run — session ${o.sessionId}${first !== undefined ? `, entrées #${first} à #${last}` : ''} (${(o.now ?? new Date()).toISOString()})`);
  head.push('# Rejouer : grasp run <fichier> (nouvelle session de préférence). Refs → text:<nom accessible> s\'il désigne cet');
  head.push('# élément seul, sinon CSS stable vérifié unique (README « Historique et rejeu »).');
  const r = [...reads].map(([k, n]) => `${k} ×${n}`).join(', ');
  if (reads.size > 0) head.push(`# Omis : ${[...reads.values()].reduce((a, b) => a + b, 0)} lecture(s) pure(s) (${r}).`);
  if (failed.length > 0) head.push(`# Omis : ${failed.length} commande(s) en échec (${failed.slice(0, 5).map((e) => `#${e.seq} ${cut(renderLine(e.line), 50)}`).join(' ; ')}${failed.length > 5 ? ' ; …' : ''}).`);
  if (masked > 0) head.push(`# ATTENTION : ${masked} valeur(s) masquée(s), lignes commentées : le script ne se rejoue pas à l'identique sans elles.`);
  if (untranslated > 0) head.push(`# ATTENTION : ${untranslated} ref(s) non traduite(s) (commentaire en fin de ligne).`);
  if ((o.lost ?? 0) > 0) head.push(`# ATTENTION : ${o.lost} entrée(s) plus ancienne(s) oubliée(s) (${HISTORY_MAX} au plus par session) : le début du parcours manque.`);
  if (body.length === 0) head.push('# (aucune commande rejouable)');
  const tail = o.expects !== undefined && o.expects.length > 0 ? ['# État final constaté à l\'export :', ...o.expects] : [];
  return [...head, ...body, ...tail].join('\n') + '\n';
}

/** Lignes `expect` de l'état final : URL et titre exacts, premier titre de niveau 1 (ou premier titre) du snapshot. */
export function finalExpects(loc: { url: string; title: string } | undefined, snap: string | undefined): string[] {
  const out: string[] = [];
  if (loc !== undefined) {
    if (loc.url !== '' && loc.url !== 'about:blank') out.push(renderLine({ cmd: 'expect', flags: [], pos: ['url', loc.url] }));
    if (loc.title !== '') out.push(renderLine({ cmd: 'expect', flags: [], pos: ['title', loc.title] }));
  }
  if (snap !== undefined) {
    const heads = [...snap.matchAll(/^\s*e[0-9a-z]+:heading(?:\[(\d)\])? "((?:[^"\\]|\\.)*)"/gm)].map((m) => ({ level: Number(m[1] ?? '0'), name: m[2]! }));
    const h = heads.find((x) => x.level === 1) ?? heads[0];
    if (h !== undefined && h.name !== '' && !h.name.endsWith('…')) out.push(renderLine({ cmd: 'expect', flags: [], pos: ['text', h.name] }));
  }
  return out;
}
