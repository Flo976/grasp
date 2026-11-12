import { badRequest } from './errors.js';

/**
 * Assertions de recette (`expect`) : forme d'une assertion, comparaison et messages. Partagé par la syntaxe
 * des scripts (core/script.ts), le bridge qui observe la page, et le rapport de `grasp run`.
 */

export const EXPECT_KINDS = ['text', 'no-text', 'url', 'title', 'sel', 'no-sel', 'value', 'no-console-errors', 'no-form-errors'] as const;
export type ExpectKind = typeof EXPECT_KINDS[number];
/** exact : égalité ; contains : contient (`~`) ; regex : expression régulière JavaScript (`--regex`). */
export type ExpectMatch = 'exact' | 'contains' | 'regex';

export interface ExpectSpec {
  kind: ExpectKind;
  /** Sélecteur (sel, no-sel, value). */
  target?: string;
  /** Valeur attendue (text, no-text, url, title, value) ou motif (--regex). */
  expected?: string;
  match?: ExpectMatch;
  /** Délai de réessai en ms (0 = une seule lecture). */
  timeout?: number;
  /** Zone de text / no-text (ref, CSS, text:). */
  scope?: string;
  /** no-console-errors : seq à partir duquel compter (défaut : début du document courant ; run : début du run). */
  since?: number;
  /** no-console-errors : expression régulière des entrées à ignorer (texte ou URL). */
  ignore?: string;
}

/** Réessai par défaut : la page vient souvent de réagir à l'action précédente (XHR, route, rendu). */
export const EXPECT_DEFAULT_MS = 5000;
export const EXPECT_MAX_MS = 60_000;

/** Assertions relues jusqu'au délai ; console et formulaire : constat immédiat. */
export const POLLED: ReadonlySet<ExpectKind> = new Set(['text', 'no-text', 'url', 'title', 'sel', 'no-sel', 'value']);

export function isExpectKind(k: string): k is ExpectKind { return (EXPECT_KINDS as readonly string[]).includes(k); }

/** Motif --regex compilé ; invalide → 400 (le script est refusé avant toute exécution). */
export function compileRegex(p: string): RegExp {
  try { return new RegExp(p); } catch (e) { throw badRequest(`expression régulière invalide /${p}/ : ${(e as Error).message}`); }
}

export const normSpace = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Comparaison d'une valeur observée (url, titre, valeur d'un champ). */
export function matchValue(observed: string, spec: ExpectSpec): boolean {
  const want = spec.expected ?? '';
  switch (spec.match ?? 'exact') {
    case 'exact': return observed === want;
    case 'contains': return observed.includes(want);
    case 'regex': return compileRegex(want).test(observed);
  }
}

/** Position de la première occurrence dans un texte (espaces normalisés des deux côtés), -1 si absent. */
export function findText(text: string, spec: ExpectSpec): { index: number; length: number } {
  const want = spec.expected ?? '';
  if (spec.match === 'regex') {
    const m = compileRegex(want).exec(text);
    return m === null ? { index: -1, length: 0 } : { index: m.index, length: m[0].length };
  }
  const w = normSpace(want);
  return { index: text.indexOf(w), length: w.length };
}

/** Extrait borné d'un texte (une ligne), marqué « … » s'il est coupé. */
export function excerpt(text: string, max = 300): string {
  const t = normSpace(text);
  return t.length <= max ? `« ${t} »` : `« ${t.slice(0, max)}… » (${t.length} car.)`;
}

/** Contexte autour d'une occurrence : 60 caractères de part et d'autre. */
export function around(text: string, index: number, length: number, ctx = 60): string {
  const a = Math.max(0, index - ctx);
  const b = Math.min(text.length, index + length + ctx);
  return `« ${a > 0 ? '…' : ''}${text.slice(a, b)}${b < text.length ? '…' : ''} »`;
}

const q = (s: string | undefined) => `« ${s ?? ''} »`;

function wanted(spec: ExpectSpec): string {
  if (spec.match === 'regex') return `correspondant à /${spec.expected ?? ''}/`;
  return spec.match === 'contains' ? `contenant ${q(spec.expected)}` : `= ${q(spec.expected)}`;
}

/** Ce qui était attendu, en une phrase (début du message d'échec). */
export function describeExpected(spec: ExpectSpec): string {
  const where = spec.scope !== undefined ? `dans ${spec.scope}` : 'dans la page';
  const txt = spec.match === 'regex' ? `texte correspondant à /${spec.expected ?? ''}/` : `texte ${q(spec.expected)}`;
  switch (spec.kind) {
    case 'text': return `${txt} ${where}`;
    case 'no-text': return `aucun ${txt} ${where}`;
    case 'url': return `url ${wanted(spec)}`;
    case 'title': return `titre ${wanted(spec)}`;
    case 'sel': return `élément visible ${spec.target ?? ''}`;
    case 'no-sel': return `aucun élément visible ${spec.target ?? ''}`;
    case 'value': return `valeur de ${spec.target ?? ''} ${wanted(spec)}`;
    case 'no-console-errors': return `aucune erreur console${spec.ignore !== undefined ? ` (hors /${spec.ignore}/)` : ''}`;
    case 'no-form-errors': return 'aucune erreur de formulaire';
  }
}

/** Corps de POST /expect → assertion validée (le bridge ne fait confiance à rien). */
export function expectSpecOf(body: Record<string, unknown>): ExpectSpec {
  const kind = body.kind;
  if (typeof kind !== 'string' || !isExpectKind(kind)) throw badRequest(`assertion inconnue « ${String(kind)} » (assertions : ${EXPECT_KINDS.join(', ')})`);
  const s = (k: string): string | undefined => {
    const v = body[k];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'string') throw badRequest(`« ${k} » : chaîne attendue`);
    return v;
  };
  const spec: ExpectSpec = { kind };
  const target = s('target');
  const expected = s('expected');
  const match = s('match');
  const scope = s('scope');
  const ignore = s('ignore');
  if (target !== undefined) { if (target.trim() === '') throw badRequest('expect : sélecteur vide'); spec.target = target.trim(); }
  if (expected !== undefined) spec.expected = expected;
  if (match !== undefined) {
    if (match !== 'exact' && match !== 'contains' && match !== 'regex') throw badRequest(`« match » : exact, contains ou regex attendu`);
    spec.match = match;
  }
  if (scope !== undefined && scope.trim() !== '') spec.scope = scope.trim();
  if (ignore !== undefined) { compileRegex(ignore); spec.ignore = ignore; }
  for (const k of ['timeout', 'since'] as const) {
    const v = body[k];
    if (v === undefined || v === null || v === '') continue;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) throw badRequest(`« ${k} » : entier positif ou nul attendu`);
    if (k === 'timeout' && n > EXPECT_MAX_MS) throw badRequest(`timeout : ${EXPECT_MAX_MS} ms au plus`);
    spec[k] = n;
  }
  const needs = { target: ['sel', 'no-sel', 'value'], expected: ['text', 'no-text', 'url', 'title', 'value'] } as const;
  if ((needs.target as readonly string[]).includes(kind) && spec.target === undefined) throw badRequest(`expect ${kind} : sélecteur requis`);
  if ((needs.expected as readonly string[]).includes(kind) && spec.expected === undefined) throw badRequest(`expect ${kind} : valeur attendue requise`);
  if ((kind === 'text' || kind === 'no-text') && spec.match !== 'regex' && normSpace(spec.expected ?? '') === '') throw badRequest(`expect ${kind} : texte non vide attendu`);
  if (spec.match === 'regex') compileRegex(spec.expected ?? '');
  return spec;
}
