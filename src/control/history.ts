/**
 * Enregistrement de l'historique côté control plane : chaque commande d'une session (commande isolée ou étape
 * de `grasp run`) devient une entrée bornée de `HistoryLog`. Une commande qui vise un élément par ref (ou une
 * saisie) a besoin d'une description de sa cible relevée AVANT l'action (après un clic, l'élément peut avoir
 * disparu) : les actions la produisent pendant leur propre résolution (`describeTarget`, même snapshot, champ
 * `target` du résultat, retiré avant la réponse au client) ; expect, wait et upload la demandent à part
 * (`POST /internal/durable`). Description impossible : rien n'est bloqué, l'entrée dit pourquoi la ref n'est
 * pas traduite, et une saisie au type de champ inconnu est masquée.
 */

import { commandOf, finalExpects, HistoryLog, sanitize, targetOf, wantsTarget, type HistoryEntry, type TargetInfo } from '../core/history.js';

export type BridgeCall = (method: 'GET' | 'POST', path: string, body?: Record<string, unknown>) => Promise<{ status: number; json: () => unknown; text: () => string }>;

export interface Recording {
  /** Corps à transmettre au bridge (avec `describeTarget` si l'action décrit sa cible elle-même). */
  body: Record<string, unknown> | undefined;
  /** L'action renverra `target` dans son résultat : à retirer avant de répondre au client. */
  inline: boolean;
  finish(ok: boolean, status?: number, error?: string, result?: unknown): void;
}

/**
 * Description reçue du bridge, acceptée seulement si elle porte sur la cible de CETTE commande (`given`, aux
 * blancs près). Sinon (description d'une autre action concurrente, réponse incohérente) : ignorée, cible non
 * traduite et type du champ inconnu — une saisie est alors masquée par prudence.
 */
export function ownTarget(given: string, t: unknown, why: string): TargetInfo {
  if (typeof t === 'object' && t !== null && typeof (t as { given?: unknown }).given === 'string') {
    if ((t as TargetInfo).given.trim() === given.trim()) return t as TargetInfo;
    return { given, secret: null, note: 'description du bridge pour une autre cible : ignorée' };
  }
  return { given, secret: null, note: why };
}

/** Actions dont la résolution de cible sait se décrire (option describeTarget du bridge). */
const INLINE = new Set(['click', 'hover', 'fill', 'select', 'check', 'press', 'type']);

/**
 * Début d'une commande : entrée réservée (l'ordre suit l'arrivée), cible décrite si besoin. undefined : route
 * sans commande (rien à mémoriser).
 */
export async function beginRecord(log: HistoryLog, method: string, path: string, body: Record<string, unknown> | undefined, via: 'run' | 'api', bridge: BridgeCall): Promise<Recording | undefined> {
  let c;
  try { c = commandOf(method, path, body); } catch { return undefined; }
  if (c === undefined) return undefined;
  const seq = log.reserve();
  const t0 = Date.now();
  const at = new Date(t0).toISOString();
  let target: TargetInfo | undefined;
  let fwd = body;
  let inline = false;
  if (wantsTarget(c.line)) {
    const given = targetOf(c.line)!;
    if (INLINE.has(c.line.cmd)) {
      inline = true;
      fwd = { ...body, describeTarget: given };
    } else {
      try {
        const r = await bridge('POST', '/internal/durable', { target: given });
        target = r.status === 200 ? ownTarget(given, r.json(), 'cible non décrite par le bridge') : { given, secret: null, note: `cible non décrite (${r.status} : ${errorOf(r.text()).slice(0, 120)})` };
      } catch (e) { target = { given, secret: null, note: `cible non décrite : ${(e as Error).message.slice(0, 120)}` }; }
    }
  }
  return {
    body: fwd,
    inline,
    finish(ok, status, error, result) {
      if (inline) {
        const t = typeof result === 'object' && result !== null ? (result as { target?: unknown }).target : undefined;
        target = ownTarget(targetOf(c.line)!, t, ok ? 'cible non décrite par le bridge' : 'action en échec');
      }
      const e: HistoryEntry = { seq, at, ms: Date.now() - t0, ok, via, kind: c.kind, line: c.line, ...(target !== undefined ? { target } : {}), ...(status !== undefined && !ok ? { status } : {}), ...(error !== undefined && !ok ? { error } : {}) };
      log.push(sanitize(e));
    },
  };
}

/** Retire la description de cible d'un résultat d'action (elle n'est destinée qu'à l'historique). */
export function stripTarget(result: unknown): unknown {
  if (typeof result === 'object' && result !== null && 'target' in result) {
    const { target: _t, ...rest } = result as Record<string, unknown>;
    return rest;
  }
  return result;
}

/** Message d'une réponse d'erreur du bridge (JSON `{error}` ou texte). */
export function errorOf(text: string): string {
  try { const j = JSON.parse(text) as { error?: unknown }; if (typeof j.error === 'string') return j.error; } catch { /* texte */ }
  return text;
}

/** `expect` de l'état final (--expect) : URL, titre, premier titre de la page. Lecture seule. */
export async function finalState(bridge: BridgeCall): Promise<string[]> {
  let loc: { url: string; title: string } | undefined;
  let snap: string | undefined;
  try { const r = await bridge('GET', '/location'); if (r.status === 200) loc = r.json() as { url: string; title: string }; } catch { /* page injoignable */ }
  try { const r = await bridge('GET', '/snap?nameMax=0'); if (r.status === 200) snap = r.text(); } catch { /* idem */ }
  return finalExpects(loc, snap);
}
