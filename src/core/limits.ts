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
  /**
   * Délai de livraison d'une entrée (click, check, press, fill au clavier), en ms : sans événement de
   * confiance reçu par la page dans ce délai, Grasp passe à l'étage de reprise suivant.
   */
  inputDeliveryMs: number;
}

export const DEFAULT_LIMITS: Readonly<Limits> = Object.freeze({ snapMax: 12_000, textMax: 4000, diffMax: 4000, stableTimeoutMs: 5000, inputDeliveryMs: 300 });

/** Fenêtre de calme exigée : aucune mutation du DOM ni activité réseau pendant ce délai = page stable. */
export const STABLE_QUIET_MS = 400;

/**
 * Requête en vol depuis plus longtemps que ce délai : présumée de longue durée (long-polling, flux,
 * EventSource déguisé) et ignorée par l'attente de stabilité, sinon chaque attente irait au plafond.
 * Une requête ouverte au chargement et jamais terminée coûte ainsi au plus ~1,6 s à `nav`.
 */
export const LONG_REQUEST_MS = 1200;

/**
 * Requête déclenchée par une action (partie dans sa fenêtre, voir ACTION_WINDOW_MS) : attendue plus longtemps
 * qu'une requête de fond — un « Enregistrer » qui poste 2 s doit voir sa confirmation dans le diff.
 */
export const ACTION_REQUEST_MS = 2500;

/**
 * Fenêtre d'attribution d'une action : seules les requêtes parties entre le début de l'action et ce délai
 * après sa fin (ou enchaînées à l'une d'elles) sont attendues. Un polling de fond n'est pas une réaction.
 */
export const ACTION_WINDOW_MS = 400;

/**
 * Après une action (click, press, fill…) : délai d'observation d'une réaction différée (navigation, pushState,
 * requête réseau) avant de rendre la main sans attente de stabilité. Sondé par pas de 20 ms.
 */
export const ACTION_GRACE_MS = 120;

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
