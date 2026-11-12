/**
 * Géométrie des éléments, sans eval utilisateur : code FIXE exécuté dans le monde isolé de lecture (mesures
 * brutes), puis jugement et messages ici, en TypeScript (testés à part). Sert `expect in-viewport`,
 * `expect not-clipped`, `expect no-horizontal-overflow` et l'option `--boxes` de snap et find.
 *
 * Repères : pixels CSS ; « viewport » = viewport de mise en page (clientWidth/clientHeight de l'élément qui
 * défile, barre de défilement exclue) ; boîtes rapportées dans le DOCUMENT (coin haut-gauche, défilement
 * compris), pour qu'elles ne dépendent pas de la position de défilement.
 */

/** Tolérance des comparaisons (arrondis sous-pixel). */
export const GEOM_TOLERANCE = 0.5;
/** Éléments examinés au plus par no-horizontal-overflow (le reste n'est pas parcouru, et c'est dit). */
export const OVERFLOW_SCAN_MAX = 5000;

/** Rectangle en coordonnées du viewport (getBoundingClientRect) : gauche, haut, droite, bas. */
export interface Rect { l: number; t: number; r: number; b: number }

/** Ancêtre qui rogne (overflow hidden ou clip sur un axe), dans la chaîne des blocs conteneurs. */
export interface ClipAncestor {
  /** Description courte : balise#id.classe (60 caractères au plus). */
  who: string;
  /** overflow-x et overflow-y calculés. */
  ox: string;
  oy: string;
  /** Boîte de remplissage (zone visible du contenu), coordonnées du viewport. */
  box: Rect;
}

/** Mesures brutes d'un élément (GEOM_FN). */
export interface ElementGeometry {
  vw: number; vh: number; sx: number; sy: number;
  /** Boîte rendue ; null : aucune (display:none, détaché, contents). */
  box: Rect | null;
  clips: ClipAncestor[];
  /**
   * Bornes horizontales (boîte de remplissage, coordonnées du viewport) du plus proche ancêtre de la chaîne en
   * overflow-x ≠ visible : seule la part de l'élément qu'il laisse voir peut dépasser le viewport (un tableau
   * large dans un conteneur qui défile ne fait pas déborder la page). null : aucun.
   */
  xin?: { l: number; r: number } | null;
}

/** Mesures brutes de la page (OVERFLOW_FN). */
export interface PageOverflow {
  vw: number; vh: number;
  /** Largeur défilable du document (scrollWidth de l'élément qui défile). */
  sw: number;
  /** overflow-x du viewport (propagé depuis html ou body). */
  rootOx: string;
  /** Éléments les plus externes dont le bord droit dépasse le viewport (coordonnées du document). */
  culprits: Array<{ who: string; l: number; r: number }>;
  /** Nombre total de tels éléments les plus externes (culprits en garde 20 au plus). */
  count: number;
  /** Parcours arrêté à OVERFLOW_SCAN_MAX éléments. */
  truncated: boolean;
}

/**
 * Code commun aux fonctions de page : description courte d'un élément, élément parent (à travers une racine
 * fantôme), clips de la chaîne des blocs conteneurs (un élément absolu échappe à l'overflow d'un ancêtre non
 * positionné ; un élément fixe, à tous sauf un ancêtre transformé). html et body sont exclus : leur overflow
 * se propage au viewport, traité à part.
 */
const HELPERS = `
  const who = (el) => {
    let s = el.localName || '?';
    if (el.id) s += '#' + el.id;
    const cl = typeof el.className === 'string' ? el.className.trim().split(/\\s+/).filter(Boolean).slice(0, 2) : [];
    for (const c of cl) s += '.' + c;
    return s.length > 60 ? s.slice(0, 59) + '…' : s;
  };
  const up = (n) => n.parentElement || (n.parentNode && n.parentNode.host) || null;
  const root = document.documentElement, body = document.body;
  const se = document.scrollingElement || root;
  const isClip = (v) => v === 'hidden' || v === 'clip';
  const contains = (cs) => cs.transform !== 'none' || cs.filter !== 'none' || cs.perspective !== 'none' || /paint|layout|strict|content/.test(cs.contain || '');
  /** Ancêtres de la chaîne des blocs conteneurs, avec leur style calculé (html et body exclus). */
  const chain = (el) => {
    const out = [];
    let pos = getComputedStyle(el).position;
    for (let a = up(el); a && a !== root && a !== body; a = up(a)) {
      const cs = getComputedStyle(a);
      const cb = pos === 'fixed' ? contains(cs) : pos === 'absolute' ? cs.position !== 'static' || contains(cs) : true;
      if (!cb) continue;
      out.push([a, cs]);
      pos = cs.position;
    }
    return { out, fixed: pos === 'fixed' };
  };
  const rectOf = (n) => {
    if (n.nodeType === 3) { const rg = document.createRange(); rg.selectNodeContents(n); return rg.getClientRects().length > 0 ? rg.getBoundingClientRect() : null; }
    if (n.getClientRects().length === 0) return null;
    if (n.checkVisibility && !n.checkVisibility()) return null;
    return n.getBoundingClientRect();
  };
  const R = (r) => ({ l: r.left, t: r.top, r: r.right, b: r.bottom });
`;

/** Mesures d'un élément (ou d'un nœud texte, mesuré par un Range) : fonction appelée sur le nœud. */
export const GEOM_FN = `function () {
  ${HELPERS}
  const el = this.nodeType === 3 ? this.parentElement : this;
  const box = el ? rectOf(this) : null;
  const clips = [];
  let xin = null;
  if (el && box) {
    for (const [a, cs] of chain(el).out) {
      const clipped = isClip(cs.overflowX) || isClip(cs.overflowY);
      if (!clipped && (xin || cs.overflowX === 'visible')) continue;
      const r = a.getBoundingClientRect();
      const l = r.left + a.clientLeft, t = r.top + a.clientTop;
      if (!xin && cs.overflowX !== 'visible') xin = { l, r: l + a.clientWidth };
      if (clipped) clips.push({ who: who(a), ox: cs.overflowX, oy: cs.overflowY, box: { l, t, r: l + a.clientWidth, b: t + a.clientHeight } });
    }
  }
  return { vw: se.clientWidth, vh: se.clientHeight, sx: scrollX, sy: scrollY, box: box ? R(box) : null, clips, xin };
}`;

/**
 * Débordement horizontal de la page : largeur défilable, et éléments les plus externes dont le bord droit
 * dépasse le viewport, hors de ceux contenus par un ancêtre qui ne déborde pas (overflow-x ≠ visible : rogné ou
 * défilant dans son conteneur) et des éléments fixes (ils ne font pas défiler la page).
 */
export const OVERFLOW_FN = `(() => {
  ${HELPERS}
  const vw = se.clientWidth, sx = scrollX;
  const rootOx = getComputedStyle(root).overflowX !== 'visible' ? getComputedStyle(root).overflowX : body ? getComputedStyle(body).overflowX : 'visible';
  const culprits = [], kept = [];
  let count = 0, n = 0, truncated = false;
  for (const el of body ? body.querySelectorAll('*') : []) {
    if (++n > ${OVERFLOW_SCAN_MAX}) { truncated = true; break; }
    if (kept.some((k) => k.contains(el))) continue;
    const r = el.getClientRects().length > 0 ? el.getBoundingClientRect() : null;
    if (!r || r.width === 0 || r.right + sx <= vw + ${GEOM_TOLERANCE}) continue;
    const c = chain(el);
    if (c.fixed || getComputedStyle(el).position === 'fixed') continue;
    if (c.out.some(([, cs]) => cs.overflowX !== 'visible')) continue;
    kept.push(el);
    count++;
    if (culprits.length < 20) culprits.push({ who: who(el), l: r.left + sx, r: r.right + sx });
  }
  return { vw, vh: se.clientHeight, sw: se.scrollWidth, rootOx, culprits, count, truncated };
})()`;

/** Boîtes de plusieurs nœuds (arguments), coordonnées du document : [x, y, largeur, hauteur] ou null. */
export const BOXES_FN = `function (...nodes) {
  ${HELPERS}
  return nodes.map((n) => { const r = n ? rectOf(n) : null; return r ? [r.left + scrollX, r.top + scrollY, r.width, r.height] : null; });
}`;

const px = (n: number) => Math.round(n);

/** Suffixe de ligne de `--boxes` : « @x,y LxH », ou « @aucune-boîte » (élément non rendu). */
export function boxLabel(b: readonly number[] | null | undefined): string {
  if (b === null || b === undefined || b.length !== 4) return '@aucune-boîte';
  return `@${px(b[0]!)},${px(b[1]!)} ${px(b[2]!)}x${px(b[3]!)}`;
}

/** Boîte dans le document, pour les messages : « x=12 y=340 336x48 ». */
function docBox(g: ElementGeometry, r: Rect): string {
  return `x=${px(r.l + g.sx)} y=${px(r.t + g.sy)} ${px(r.r - r.l)}x${px(r.b - r.t)}`;
}

const NO_BOX = 'aucune boîte : élément non rendu (display:none, visibility:hidden, détaché ou sans boîte)';

/** Dépassements d'un rectangle hors d'une zone, par côté (0 si dedans, à la tolérance près). */
function overflows(r: Rect, z: Rect, axes: { x: boolean; y: boolean }): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  const add = (side: string, d: number) => { if (d > GEOM_TOLERANCE) out.push([side, d]); };
  if (axes.x) { add('à gauche', z.l - r.l); add('à droite', r.r - z.r); }
  if (axes.y) { add('en haut', z.t - r.t); add('en bas', r.b - z.b); }
  return out;
}
const sides = (o: Array<[string, number]>) => o.map(([s, d]) => `${px(d)} px ${s}`).join(', ');

/**
 * expect in-viewport : la boîte tient dans la LARGEUR du viewport (coordonnées du document : un élément plus
 * bas dans la page, atteignable en défilant verticalement, est accepté) ; `fully` : entièrement visible, sans
 * défiler, à la position de défilement courante (les deux axes).
 */
export function judgeInViewport(g: ElementGeometry, fully: boolean): { ok: boolean; observed: string } {
  if (g.box === null) return { ok: false, observed: NO_BOX };
  const b = g.box;
  // Largeur seule : comparée dans le document (indépendante du défilement horizontal courant).
  const o = fully
    ? overflows(b, { l: 0, t: 0, r: g.vw, b: g.vh }, { x: true, y: true })
    : overflows({ l: b.l + g.sx, t: 0, r: b.r + g.sx, b: 0 }, { l: 0, t: 0, r: g.vw, b: 0 }, { x: true, y: false });
  const scrolled = fully && (px(g.sx) !== 0 || px(g.sy) !== 0) ? ` défilé à ${px(g.sx)},${px(g.sy)}` : '';
  return { ok: o.length === 0, observed: `boîte ${docBox(g, b)} ; viewport ${px(g.vw)}x${px(g.vh)}${scrolled}${o.length > 0 ? ` : dépasse de ${sides(o)}` : ''}` };
}

/**
 * expect not-clipped : aucun ancêtre overflow hidden/clip (chaîne des blocs conteneurs, html et body exclus)
 * ne coupe la boîte sur l'axe qu'il rogne, et la boîte ne dépasse pas la largeur du viewport (débordement
 * horizontal : rogné par la page, ou qui la fait défiler) — pour la part que laisse voir le plus proche
 * conteneur en overflow-x ≠ visible. Un conteneur overflow auto/scroll ne rogne pas (son contenu s'atteint en
 * y défilant) ; la hauteur du document non plus.
 */
export function judgeNotClipped(g: ElementGeometry): { ok: boolean; observed: string } {
  if (g.box === null) return { ok: false, observed: NO_BOX };
  const b = g.box;
  const cuts: string[] = [];
  for (const c of g.clips) {
    const o = overflows(b, c.box, { x: c.ox === 'hidden' || c.ox === 'clip', y: c.oy === 'hidden' || c.oy === 'clip' });
    if (o.length === 0) continue;
    const ov = c.ox === c.oy ? c.ox : `${c.ox}/${c.oy}`;
    cuts.push(`rogné par ${c.who} (overflow ${ov}, zone ${docBox(g, c.box)}) : ${sides(o)}`);
  }
  // Part horizontale laissée visible par le plus proche conteneur qui rogne ou défile : seule elle peut dépasser.
  const xin = g.xin !== undefined && g.xin !== null ? g.xin : undefined;
  const xl = xin !== undefined ? Math.max(b.l, xin.l) : b.l;
  const xr = xin !== undefined ? Math.min(b.r, xin.r) : b.r;
  const page = xr > xl ? overflows({ l: xl + g.sx, t: 0, r: xr + g.sx, b: 0 }, { l: 0, t: 0, r: g.vw, b: 0 }, { x: true, y: false }) : [];
  if (page.length > 0) cuts.push(`dépasse la largeur du viewport (${px(g.vw)} px) de ${sides(page)}`);
  const shown = cuts.slice(0, 3).join(' ; ') + (cuts.length > 3 ? ` ; … et ${cuts.length - 3} autre(s)` : '');
  return { ok: cuts.length === 0, observed: `boîte ${docBox(g, b)}${cuts.length > 0 ? ` ; ${shown}` : ''}` };
}

/**
 * expect no-horizontal-overflow : la largeur défilable du document ne dépasse pas celle du viewport. Échec :
 * les éléments les plus externes qui dépassent (5 cités, `items` jusqu'à 20). Viewport en overflow-x
 * hidden/clip : la page ne défile pas, mais le contenu qui dépasse est rogné — c'est dit, et l'assertion échoue
 * aussi (le défaut de mise en page est le même).
 */
export function judgeHorizontalOverflow(p: PageOverflow): { ok: boolean; observed: string; items: string[] } {
  const items = p.culprits.map((c) => `${c.who} x=${px(c.l)} largeur ${px(c.r - c.l)} (+${px(c.r - p.vw)} px)`);
  const extra = p.sw - p.vw;
  if (extra <= GEOM_TOLERANCE && p.count === 0) return { ok: true, observed: '', items: [] };
  const masked = p.rootOx === 'hidden' || p.rootOx === 'clip' ? ` ; viewport en overflow-x ${p.rootOx} : la page ne défile pas mais ce contenu est rogné` : '';
  const head = extra > GEOM_TOLERANCE ? `largeur du document ${px(p.sw)} px > viewport ${px(p.vw)} px (+${px(extra)} px)` : `largeur du document ${px(p.sw)} px = viewport`;
  const list = items.length > 0
    ? `${p.count} élément(s) dépassent : ${items.slice(0, 5).join(' | ')}${p.count > 5 ? ` | … et ${p.count - 5} autre(s)` : ''}`
    : 'aucun élément identifié (pseudo-élément, ombre ou marge ?)';
  return { ok: false, observed: `${head} ; ${list}${p.truncated ? ` (${OVERFLOW_SCAN_MAX} premiers éléments examinés)` : ''}${masked}`, items };
}
