import { GraspError } from '../core/errors.js';
import { formatEntry, type ConsoleEntry } from '../core/console.js';
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
  ms: number;
}
export interface RunResult { ok: boolean; total: number; executed: number; steps: RunStep[]; aborted?: boolean }

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
export async function runScript(steps: Array<{ src: ScriptLine; rq: StepRequest }>, exec: StepExecutor, cont: boolean, signal?: AbortSignal, takeNotice?: () => string | undefined): Promise<RunResult> {
  const out: RunStep[] = [];
  let failed = false;
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
        if (Array.isArray(extra.console) && extra.console.length > 0) step.output = (extra.console as ConsoleEntry[]).map(formatEntry).join('\n');
      }
    }
    // Note du control plane (navigateur recyclé avant l'étape) : en tête des notes de l'étape.
    const notice = takeNotice?.();
    if (notice !== undefined) step.detail = step.detail !== undefined ? `${notice} ; ${step.detail}` : notice;
    step.ms = Date.now() - t0;
    out.push(step);
  }
  return { ok: !failed, total: steps.length, executed: out.length, steps: out };
}

interface ActionJson { diff?: string; detail?: string; console?: { entries: ConsoleEntry[]; seq: number; since?: number; omitted?: number; dropped?: number } }

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
      const c = j as { entries?: ConsoleEntry[]; seq?: number; omitted?: number; dropped?: number };
      const w = losses({ omitted: c.omitted, dropped: c.dropped });
      return { output: Array.isArray(c.entries) ? c.entries.map(formatEntry).join('\n') : '', detail: [...w, `seq courant : ${c.seq}`].join(' ; ') };
    }
    case 'wait': return {};
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
      if (a.console !== undefined) {
        if (a.console.entries.length > 0) parts.push(a.console.entries.map(formatEntry).join('\n'));
        notes.push(...losses(a.console), `console : ${a.console.entries.length === 0 ? 'aucune nouvelle entrée, ' : ''}seq courant ${a.console.seq}`);
      }
      return { output: parts.join('\n'), detail: notes.join(' ; ') };
    }
  }
}
