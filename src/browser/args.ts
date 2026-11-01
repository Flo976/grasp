/**
 * Arguments communs à Chrome Linux et à chrome.exe (WSL2). Une fenêtre minimisée, masquée ou un écran
 * Windows éteint ne doivent ni étrangler les minuteries de la page, ni mettre son rendu en veille : sans
 * frames produites, le routage des entrées par hit-test peut abandonner les événements de CDP.
 */
export const ANTI_BACKGROUND_ARGS: readonly string[] = Object.freeze([
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
]);

/** Fonctions toujours désactivées : le calcul d'occultation natif de Windows met en veille une fenêtre recouverte. */
export const ALWAYS_DISABLED_FEATURES: readonly string[] = Object.freeze(['CalculateNativeWinOcclusion']);

const DF = '--disable-features=';

/**
 * Un seul --disable-features (Chrome ne retient que le dernier) : fusionne les drapeaux existants et
 * `features`, sans doublon, à la place du premier drapeau, ou avant l'URL de départ s'il n'y en avait pas.
 */
export function mergeDisableFeatures(args: readonly string[], features: readonly string[]): string[] {
  const all: string[] = [];
  let at = -1;
  const out: string[] = [];
  for (const a of args) {
    if (a.startsWith(DF)) {
      if (at < 0) at = out.length;
      for (const f of a.slice(DF.length).split(',')) if (f !== '' && !all.includes(f)) all.push(f);
    } else out.push(a);
  }
  for (const f of features) if (!all.includes(f)) all.push(f);
  if (at < 0) {
    const last = out.at(-1);
    at = last !== undefined && !last.startsWith('-') ? out.length - 1 : out.length;
  }
  out.splice(at, 0, `${DF}${all.join(',')}`);
  return out;
}
