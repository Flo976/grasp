import { GraspError } from '../core/errors.js';
import { formatEntries, formatEntry, type ConsoleEntry } from '../core/console.js';
import { wrapTagged, type BoundaryTag } from '../core/boundaries.js';
import { buildRequest, checkRunFlags, parseArgs, parseScript, renderEval, ScriptError, type ScriptLine, type StepRequest } from '../core/script.js';

/** Au-delà, un script est refusé : un agent qui en écrit plus se trompe probablement d'outil. */
export const MAX_RUN_STEPS = 500;

export interface RunStep {
  /** Rang de la commande dans le script (1, 2, …). */
  n: number;
  /** Numéro de ligne dans le script source. */
  line: number;
  /** Ligne telle qu'écrite, sans son commentaire. */
  text: string;
  cmd: string;
  ok: boolean;
  /** Sortie utile, déjà mise en forme (snap, text, diff, console, chemin de capture, valeur d'eval). */
  output?: string;
  /** Notes et avertissements (stderr de la commande isolée). */
  detail?: string;
  status?: number;
  error?: string;
  /** Réponse brute du bridge (--json). */
  result?: unknown;
  /** Rapport de recette : capture prise juste après l'échec de l'étape. */
  screenshot?: string;
  ms: number;
}
export interface RunResult { ok: boolean; total: number; executed: number; steps: RunStep[]; aborted?: boolean; report?: RunReport }

/**
 * Rapport de recette (`--report`, ou dès qu'un script contient `expect`) : étapes et durées, erreurs console et
 * requêtes en échec survenues PENDANT le run, erreurs de formulaire de la page finale, capture à chaque échec.
 */
export interface RunReport {
  ok: boolean;
  ms: number;
  total: number;
  steps: Array<{ n: number; line: number; text: string; ok: boolean; ms: number; error?: string; screenshot?: string }>;
  notRun: Array<{ n: number; line: number; text: string }>;
  /** Entrées de niveau error depuis le début du run : console/exceptions/CSP d'un côté, requêtes de l'autre. */
  console: { since: number; errors: ConsoleEntry[]; requests: ConsoleEntry[]; omitted: number; note?: string; boundary?: BoundaryTag } | { unavailable: string };
  /** Champs invalides et alertes de la page finale (lignes de snapshot). */
  forms: { items: string[]; boundary?: BoundaryTag } | { unavailable: string };
  page?: { url: string; title: string; boundary?: BoundaryTag };
}

/** Captures prises par un même run (au-delà, l'échec est rapporté sans capture). */
const MAX_REPORT_SHOTS = 5;

/** Exécute une étape : réponse du bridge (JSON ou texte), ou erreur GraspError avec le statut HTTP. */
export type StepExecutor = (rq: StepRequest) => Promise<unknown>;

/** Analyse complète AVANT toute exécution : une faute de frappe en ligne 12 n'exécute pas les 11 premières. */
export function compileScript(script: string): Array<{ src: ScriptLine; rq: StepRequest }> {
  let lines: ScriptLine[];
  try { lines = parseScript(script); } catch (e) { throw new GraspError(400, (e as Error).message); }
  if (lines.length === 0) throw new GraspError(400, 'aucune commande dans le script (lignes vides et commentaires # seulement)');
  if (lines.length > MAX_RUN_STEPS) throw new GraspError(400, `script trop long : ${lines.length} commandes (${MAX_RUN_STEPS} au plus)`);
  return lines.map((src) => {
    try {
      const a = parseArgs(src.argv);
      checkRunFlags(a);
      return { src, rq: buildRequest(a) };
    } catch (e) {
      throw new GraspError(400, `ligne ${src.line} : ${e instanceof ScriptError ? e.message : (e as Error).message}`);
    }
  });
}

/**
 * Séquentiel ; arrêt au premier échec sauf `cont`. Chaque étape passe par la même route qu'en commande isolée.
 * `signal` (client déconnecté : Ctrl-C, délai de l'outil de l'agent) : aucune étape de plus ne démarre — un
 * appelant qui ne verra jamais la réponse ne doit pas laisser des clics partir à l'aveugle. L'étape en cours
 * va à son terme (une action CDP ne s'interrompt pas proprement) ; `aborted` le signale.
 */
/**
 * `opts.report` : rapport de recette (d'office avec `expect`) ; `opts.takeNotice` : note du control plane à joindre à
 * l'étape qui vient de s'exécuter (navigateur recyclé juste avant).
 */
export async function runScript(steps: Array<{ src: ScriptLine; rq: StepRequest }>, exec: StepExecutor, cont: boolean, signal?: AbortSignal, opts: { report?: boolean | undefined; takeNotice?: (() => string | undefined) | undefined } = {}): Promise<RunResult> {
  const out: RunStep[] = [];
  let failed = false;
  const wantReport = opts.report ?? steps.some((s) => s.rq.cmd === 'expect');
  const tRun = Date.now();
  // Début du run dans la console de l'onglet : seules les erreurs postérieures entrent au rapport.
  let startSeq: number | undefined;
  let consoleOff: string | undefined;
  if (wantReport) {
    try { startSeq = Number((await exec({ cmd: 'console', method: 'POST', path: '/console', body: { limit: 1 } }) as { seq: number }).seq); } catch (e) { consoleOff = (e as Error).message; }
  }
  let shots = 0;
  for (const [i, { src, rq }] of steps.entries()) {
    if (failed && !cont) break;
    if (signal?.aborted === true) return { ok: false, total: steps.length, executed: out.length, steps: out, aborted: true };
    const t0 = Date.now();
    const step: RunStep = { n: i + 1, line: src.line, text: src.text, cmd: rq.cmd, ok: false, ms: 0 };
    try {
      const result = await exec(rq);
      step.ok = true;
      step.result = result;
      const r = render(rq.cmd, result);
      if (r.output !== undefined && r.output !== '') step.output = r.output;
      if (r.detail !== undefined && r.detail !== '') step.detail = r.detail;
    } catch (e) {
      failed = true;
      step.status = e instanceof GraspError ? e.status : 500;
      step.error = (e as Error).message;
      // --console sur une action en échec : les entrées produites pendant l'action suivent l'erreur.
      const extra = e instanceof GraspError ? e.extra : undefined;
      if (extra !== undefined) {
        step.result = extra;
        if (Array.isArray(extra.console) && extra.console.length > 0) step.output = formatEntries(extra.console as ConsoleEntry[], extra.boundary as BoundaryTag | undefined);
        if (typeof extra.screenshot === 'string') step.screenshot = extra.screenshot;
      }
      // Rapport : capture de l'état au moment de l'échec (chemin seulement), pas à la fin du run.
      if (wantReport && step.screenshot === undefined && shots < MAX_REPORT_SHOTS) {
        shots++;
        try { step.screenshot = String((await exec({ cmd: 'screenshot', method: 'GET', path: '/screenshot?save=1' }) as { path: string }).path); } catch (se) { step.detail = `capture impossible : ${(se as Error).message}`; }
      }
    }
    // Note du control plane (navigateur recyclé avant l'étape) : en tête des notes de l'étape.
    const notice = opts.takeNotice?.();
    if (notice !== undefined) step.detail = step.detail !== undefined ? `${notice} ; ${step.detail}` : notice;
    step.ms = Date.now() - t0;
    out.push(step);
  }
  const r: RunResult = { ok: !failed, total: steps.length, executed: out.length, steps: out };
  if (wantReport) r.report = await buildReport(r, steps, exec, tRun, startSeq, consoleOff);
  return r;
}

const errMsg = (e: unknown) => (e as Error).message;

async function buildReport(r: RunResult, steps: Array<{ src: ScriptLine; rq: StepRequest }>, exec: StepExecutor, t0: number, startSeq: number | undefined, consoleOff: string | undefined): Promise<RunReport> {
  let con: RunReport['console'];
  if (startSeq === undefined) con = { unavailable: consoleOff ?? 'console indisponible' };
  else {
    const read = (since: number) => exec({ cmd: 'console', method: 'POST', path: '/console', body: { since, level: 'error', limit: 200 } }) as Promise<{ entries: ConsoleEntry[]; omitted: number; boundary?: BoundaryTag }>;
    try {
      let note: string | undefined;
      let since = startSeq;
      let c: { entries: ConsoleEntry[]; omitted: number; boundary?: BoundaryTag };
      try { c = await read(since); } catch (e) {
        // Tampon recréé pendant le run (bascule de profil) : tout ce qu'il contient date du run.
        if (!(e instanceof GraspError && e.status === 409)) throw e;
        since = 0;
        note = 'tampon console recréé pendant le run (bascule de profil) : relu depuis son début';
        c = await read(0);
      }
      const errs = c.entries.filter((x) => x.source !== 'navigation' && x.level === 'error');
      const isReq = (x: ConsoleEntry) => x.source === 'network' || x.source === 'grasp';
      con = { since, errors: errs.filter((x) => !isReq(x)), requests: errs.filter(isReq), omitted: c.omitted, ...(note !== undefined ? { note } : {}), ...(c.boundary !== undefined ? { boundary: c.boundary } : {}) };
    } catch (e) { con = { unavailable: errMsg(e) }; }
  }
  let forms: RunReport['forms'];
  try {
    await exec({ cmd: 'expect', method: 'POST', path: '/expect', body: { kind: 'no-form-errors' } });
    forms = { items: [] };
  } catch (e) {
    const items = e instanceof GraspError && e.status === 417 ? (e.extra?.expect as { items?: unknown } | undefined)?.items : undefined;
    const boundary = e instanceof GraspError ? e.extra?.boundary as BoundaryTag | undefined : undefined;
    forms = Array.isArray(items) ? { items: items.map(String), ...(boundary !== undefined ? { boundary } : {}) } : { unavailable: errMsg(e) };
  }
  let page: RunReport['page'];
  try { const l = await exec({ cmd: 'location', method: 'GET', path: '/location' }) as { url: string; title: string; boundary?: BoundaryTag }; page = { url: l.url, title: l.title, ...(l.boundary !== undefined ? { boundary: l.boundary } : {}) }; } catch { page = undefined; }
  return {
    ok: r.ok, ms: Date.now() - t0, total: r.total,
    steps: r.steps.map((s) => ({ n: s.n, line: s.line, text: s.text, ok: s.ok, ms: s.ms, ...(s.error !== undefined ? { error: s.error } : {}), ...(s.screenshot !== undefined ? { screenshot: s.screenshot } : {}) })),
    notRun: steps.slice(r.executed).map((s, i) => ({ n: r.executed + i + 1, line: s.src.line, text: s.src.text })),
    console: con, forms, ...(page !== undefined ? { page } : {}),
  };
}

const cut = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n)}…`);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Rapport de recette en texte compact (stdout de `grasp run`). */
export function formatReport(rep: RunReport): string {
  const ko = rep.steps.filter((s) => !s.ok).length;
  const L: string[] = [];
  L.push(`== recette : ${rep.ok ? 'OK' : 'ÉCHEC'} — ${plural(rep.total, 'étape', 'étapes')} : ${rep.steps.length - ko} OK, ${ko} KO${rep.notRun.length > 0 ? `, ${rep.notRun.length} non exécutée${rep.notRun.length > 1 ? 's' : ''}` : ''} (${rep.ms} ms)`);
  for (const s of rep.steps) {
    L.push(`${s.ok ? 'OK' : 'KO'}  [${s.n}] ${cut(s.text, 100)} (${s.ms} ms)`);
    if (!s.ok) {
      L.push(`      ${s.error ?? 'échec'}`);
      if (s.screenshot !== undefined) L.push(`      capture : ${s.screenshot}`);
    }
  }
  for (const s of rep.notRun) L.push(`--  [${s.n}] ${cut(s.text, 100)} (non exécutée)`);
  const c = rep.console;
  if ('unavailable' in c) L.push(`console : non lue (${c.unavailable})`);
  else {
    L.push(c.errors.length === 0 ? 'console : aucune erreur pendant le run' : `console : ${plural(c.errors.length, 'erreur', 'erreurs')} pendant le run`);
    if (c.errors.length > 0) L.push(wrapTagged(c.errors.slice(0, 20).map((e) => `  ${formatEntry(e)}`).join('\n'), c.boundary, 'console'));
    if (c.errors.length > 20) L.push(`  … et ${c.errors.length - 20} autre(s)`);
    L.push(c.requests.length === 0 ? 'requêtes en échec : aucune' : `requêtes en échec : ${c.requests.length}`);
    if (c.requests.length > 0) L.push(wrapTagged(c.requests.slice(0, 20).map((e) => `  ${formatEntry(e)}`).join('\n'), c.boundary, 'console'));
    if (c.requests.length > 20) L.push(`  … et ${c.requests.length - 20} autre(s)`);
    if (c.omitted > 0) L.push(`  AVERTISSEMENT : ${c.omitted} entrée(s) plus ancienne(s) non lue(s) (200 au plus) — grasp console --since ${c.since} --level error --limit 1000`);
    if (c.note !== undefined) L.push(`  note: ${c.note}`);
  }
  const f = rep.forms;
  if ('unavailable' in f) L.push(`formulaire : non lu (${f.unavailable})`);
  else {
    L.push(f.items.length === 0 ? 'formulaire : aucune erreur' : `formulaire : ${plural(f.items.length, 'erreur', 'erreurs')}`);
    if (f.items.length > 0) L.push(wrapTagged(f.items.slice(0, 20).map((i) => `  ${i}`).join('\n'), f.boundary, 'formulaire'));
  }
  if (rep.page !== undefined) L.push(rep.page.boundary !== undefined ? `page finale :\n${wrapTagged(`${rep.page.url} « ${rep.page.title} »`, rep.page.boundary, 'page')}` : `page finale : ${rep.page.url} « ${rep.page.title} »`);
  return L.join('\n');
}

interface ActionJson { diff?: string; detail?: string; trackersBlocked?: number; console?: { entries: ConsoleEntry[]; boundary?: BoundaryTag; seq: number; since?: number; omitted?: number; dropped?: number } }

/** Pertes de console jamais tues (mêmes messages que la commande isolée). */
function losses(c: { since?: number | undefined; omitted?: number | undefined; dropped?: number | undefined }): string[] {
  const w: string[] = [];
  if (typeof c.dropped === 'number' && c.dropped > 0) w.push(`AVERTISSEMENT : ${c.dropped} entrée(s) console perdue(s) avant lecture (tampon circulaire de 1000 entrées)`);
  if (typeof c.omitted === 'number' && c.omitted > 0) w.push(`AVERTISSEMENT : ${c.omitted} ligne(s) console plus ancienne(s) non affichée(s)${typeof c.since === 'number' ? ` — grasp console --since ${c.since} --limit 1000` : ''}`);
  return w;
}

/** Sortie utile d'une étape réussie, comme la commande isolée l'écrirait (sans les « OK »). */
function render(cmd: string, result: unknown): { output?: string; detail?: string } {
  const j = (typeof result === 'object' && result !== null ? result : {}) as Record<string, unknown>;
  switch (cmd) {
    case 'snap': case 'text': {
      const t = typeof result === 'string' ? result.replace(/\n$/, '') : '';
      return t === '' && cmd === 'text' ? { detail: 'aucun texte visible' } : { output: t };
    }
    case 'eval': return { output: renderEval(j) };
    case 'cookies': return { output: JSON.stringify(result) };
    case 'screenshot': return { output: String(j.path ?? ''), ...(j.truncated === true ? { detail: 'AVERTISSEMENT : capture tronquée (limite de 16384 px de Chrome)' } : {}) };
    case 'console': {
      const c = j as { entries?: ConsoleEntry[]; boundary?: BoundaryTag; seq?: number; omitted?: number; dropped?: number };
      const w = losses({ omitted: c.omitted, dropped: c.dropped });
      return { output: Array.isArray(c.entries) ? formatEntries(c.entries, c.boundary) : '', detail: [...w, `seq courant : ${c.seq}`].join(' ; ') };
    }
    case 'wait': return {};
    case 'expect': return typeof j.detail === 'string' ? { detail: j.detail } : {};
    case 'profile': {
      const p = j as { unchanged?: boolean; profile?: string; previous?: string | null };
      return { detail: p.unchanged === true ? `déjà sur le profil « ${p.profile} »` : `profil ${p.previous ?? '(éphémère)'} → ${p.profile} ; navigateur relancé, la page repart de about:blank` };
    }
    default: {
      // Actions : diff (--snap-diff), console (--console), notes.
      const a = j as ActionJson;
      const parts: string[] = [];
      if (a.diff !== undefined) parts.push(a.diff);
      const notes: string[] = a.detail !== undefined ? [a.detail] : [];
      if (typeof a.trackersBlocked === 'number' && a.trackersBlocked > 0) notes.push(`traqueurs bloqués : ${a.trackersBlocked} requête(s)`);
      if (a.console !== undefined) {
        if (a.console.entries.length > 0) parts.push(formatEntries(a.console.entries, a.console.boundary));
        notes.push(...losses(a.console), `console : ${a.console.entries.length === 0 ? 'aucune nouvelle entrée, ' : ''}seq courant ${a.console.seq}`);
      }
      return { output: parts.join('\n'), detail: notes.join(' ; ') };
    }
  }
}
