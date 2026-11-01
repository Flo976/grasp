/**
 * Limites de taille des lectures (text, snap, --snap-diff) et plafond de l'attente de stabilité.
 * Une page réelle (GitHub, Booking…) produit vite 20 000 caractères : sans borne, une seule lecture
 * coûte plus de tokens qu'elle n'en vaut. Toute coupure est annoncée par une dernière ligne explicite.
 */
export interface Limits {
  /** Budget par défaut de `snap`, en octets (`--max` le surcharge). */
  snapMax: number;
  /** Limite par défaut de `text`, en caractères. */
  textMax: number;
  /** Limite par défaut de la sortie `--snap-diff`, en caractères. */
  diffMax: number;
  /** Plafond de l'attente de stabilité du DOM après nav / avant --snap-diff, en ms (0 = pas d'attente). */
  stableTimeoutMs: number;
}

export const DEFAULT_LIMITS: Readonly<Limits> = Object.freeze({ snapMax: 12_000, textMax: 4000, diffMax: 4000, stableTimeoutMs: 5000 });

/** Fenêtre de calme exigée : aucune mutation pendant ce délai = DOM stable. */
export const STABLE_QUIET_MS = 400;

/** Dernière ligne d'une sortie coupée. */
export function truncationLine(rest: number, extra = ''): string {
  return `… tronqué : ${rest} caractères restants${extra} — affinez avec --max N / --scope <ref|css>`;
}

/** Reconnaît la dernière ligne d'une sortie coupée (tests, agents). */
export const TRUNC_RE = /^… tronqué : \d+ caractères restants.* — affinez avec --max N \/ --scope <ref\|css>$/;

/**
 * Coupe `text` à `max` caractères au plus, de préférence en fin de ligne (`wholeLines` : toujours, si une
 * fin de ligne existe), et ajoute la ligne « … tronqué : N caractères restants ». N est exact : c'est la
 * longueur de ce qui n'est pas affiché.
 */
export function truncateText(text: string, max: number, opts: { wholeLines?: boolean } = {}): string {
  if (text.length <= max) return text;
  let cut = max;
  const nl = text.lastIndexOf('\n', max);
  if (nl > 0 && (opts.wholeLines === true || nl >= max * 0.8)) cut = nl;
  // Ne pas couper une paire de substitution (emoji…) en deux.
  const c = text.charCodeAt(cut - 1);
  if (c >= 0xd800 && c <= 0xdbff) cut--;
  // Pas de lignes vides avant la ligne finale ; le reste annoncé compte ce qui n'est pas affiché.
  const kept = text.slice(0, cut).replace(/\s+$/, '');
  return `${kept}\n${truncationLine(text.length - kept.length)}`;
}
