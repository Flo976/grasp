import { INTERACTIVE } from './snapshot.js';

/**
 * Candidats les plus proches d'un élément introuvable (ref disparue, `text:` absent) : proposés à
 * l'agent dans le message d'erreur, au lieu d'un « refaites snap » qui lui coûte un aller-retour.
 */
export interface Candidate { ref: string; role: string; name: string }

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) { const b = s.slice(i, i + 2); m.set(b, (m.get(b) ?? 0) + 1); }
  return m;
}

/** Similarité de Dice sur les bigrammes (0..1), insensible à la casse et aux accents. */
export function similarity(a: string, b: string): number {
  const x = fold(a), y = fold(b);
  if (x === y) return 1;
  if (x === '' || y === '') return 0;
  if (x.length < 2 || y.length < 2) return x.includes(y) || y.includes(x) ? 0.5 : 0;
  const bx = bigrams(x), by = bigrams(y);
  let inter = 0;
  for (const [g, n] of bx) inter += Math.min(n, by.get(g) ?? 0);
  const dice = (2 * inter) / (x.length - 1 + y.length - 1);
  // Un nom contenu dans l'autre (« Panier » / « Panier (2) ») est un bon candidat.
  return x.includes(y) || y.includes(x) ? Math.max(dice, 0.75) : dice;
}

/** Les `n` candidats les plus proches de `target` (même rôle favorisé, puis éléments interactifs). */
export function nearest(target: { role?: string; name: string }, candidates: Candidate[], n = 3): Candidate[] {
  return candidates
    .map((c, i) => ({ c, i, score: similarity(target.name, c.name) + (target.role !== undefined && c.role === target.role ? 0.3 : 0) + (INTERACTIVE.has(c.role) ? 0.05 : 0) }))
    .filter((x) => x.score > 0.05 || target.name === '')
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, n)
    .map((x) => x.c);
}

export const fmtCandidate = (c: Candidate) => `${c.ref} ${c.role}${c.name !== '' ? ` "${c.name.length > 60 ? `${c.name.slice(0, 59)}…` : c.name}"` : ''}`;
