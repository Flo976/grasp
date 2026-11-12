/**
 * `grasp scroll` : validation des options, code FIXE exécuté dans le monde isolé de lecture, et rendu du compte
 * rendu. Les méthodes qui pilotent la page (pas de défilement, attente de stabilité) sont dans page.ts.
 */

import { badRequest } from '../core/errors.js';

/** Pas par défaut de --until-stable, et plafond (chaque pas peut coûter jusqu'à stableTimeoutMs). */
export const SCROLL_STEPS_DEFAULT = 10;
export const SCROLL_STEPS_MAX = 50;
/**
 * Durée totale au plus d'un `scroll --until-stable` : au-delà, arrêt annoncé. Sous le délai d'inactivité du
 * control plane vers le bridge (120 s), avec la marge de l'attente de fin d'action.
 */
export const SCROLL_BUDGET_MS = 60_000;
/** Amplitude d'un --by, en px (au-delà, --to top|bottom dit mieux ce qu'on veut). */
const SCROLL_BY_MAX = 1_000_000;

export interface ScrollSpec {
  /** Décalage vertical en px (négatif : vers le haut). */
  by?: number | undefined;
  to?: 'top' | 'bottom' | undefined;
  untilStable?: boolean | undefined;
  maxSteps?: number | undefined;
}

/** Corps de POST /scroll → options validées (400 explicite, jamais une option ignorée). */
export function scrollSpecOf(body: Record<string, unknown>): ScrollSpec {
  const spec: ScrollSpec = {};
  if (body.by !== undefined && body.by !== null && body.by !== '') {
    const n = Number(body.by);
    if (!Number.isInteger(n) || n === 0 || Math.abs(n) > SCROLL_BY_MAX) throw badRequest(`« by » : entier non nul attendu, en px (négatif = vers le haut), ${SCROLL_BY_MAX} au plus`);
    spec.by = n;
  }
  if (body.to !== undefined && body.to !== null && body.to !== '') {
    if (body.to !== 'top' && body.to !== 'bottom') throw badRequest(`« to » : top ou bottom attendu (reçu « ${String(body.to)} »)`);
    spec.to = body.to;
  }
  if (spec.by !== undefined && spec.to !== undefined) throw badRequest('--by et --to s\'excluent');
  if (body.untilStable !== undefined && body.untilStable !== null) {
    if (typeof body.untilStable !== 'boolean') throw badRequest('champ « untilStable » : booléen attendu');
    spec.untilStable = body.untilStable;
  }
  if (body.maxSteps !== undefined && body.maxSteps !== null && body.maxSteps !== '') {
    const n = Number(body.maxSteps);
    if (!Number.isInteger(n) || n < 1 || n > SCROLL_STEPS_MAX) throw badRequest(`« max-steps » : entier de 1 à ${SCROLL_STEPS_MAX} attendu`);
    if (spec.untilStable !== true) throw badRequest('--max-steps n\'a de sens qu\'avec --until-stable');
    spec.maxSteps = n;
  }
  if (spec.untilStable === true && spec.to === 'top') throw badRequest('--until-stable défile jusqu\'à ce que plus rien n\'apparaisse : vers le bas (défaut, ou --by N), pas --to top');
  return spec;
}

/** Position d'un conteneur de défilement, et nœuds apparus depuis le début de la commande. */
export interface ScrollMeasure {
  /** page | element (le sélecteur défile lui-même) | ancestor (son plus proche ancêtre défilant) | into (amené dans la vue). */
  how: 'page' | 'element' | 'ancestor' | 'into';
  top: number;
  /** Position maximale (hauteur défilable − hauteur visible). */
  max: number;
  height: number;
  /** Éléments apparus (absents au départ) et toujours présents, dans la zone comptée. */
  added: number;
  /** La zone comptée (le sélecteur) a été retirée de la page : compte fait sur tout le document. */
  rootLost?: boolean;
  /** État perdu (monde isolé recréé par une navigation) : compte impossible. */
  lost?: boolean;
  moved?: boolean;
}

export interface ScrollReport {
  how: ScrollMeasure['how'];
  from: number;
  to: number;
  max: number;
  height: number;
  /** Éléments DOM apparus pendant la commande (et toujours présents). null : non mesuré (page remplacée). */
  added: number | null;
  steps: number;
  /** --until-stable : plus rien n'apparaît (true), ou arrêt sur plafond (false). */
  settled?: boolean;
  /** Raison de l'arrêt sans stabilité : pas ou durée. */
  stoppedBy?: 'steps' | 'budget';
}

/**
 * Code fixe du monde isolé. `this` : l'élément visé, ou `document` pour la page. État conservé dans le global du
 * monde isolé (invisible de la page) sous `key`. op : init (conteneur, éléments déjà là), step (un défilement),
 * into (amener l'élément dans la vue), measure. Défilement `instant` (un `scroll-behavior: smooth` de la page
 * rendrait sinon la position lue juste après fausse) ; scroll et IntersectionObserver de la page se déclenchent
 * comme pour un défilement de l'utilisateur.
 */
export const SCROLL_FN = `function (key, op, by, to) {
  const doc = document.scrollingElement || document.documentElement;
  const target = this === document ? null : (this.nodeType === 1 ? this : this.parentElement);
  const scrollable = (el) => {
    if (el === doc) return true;
    const s = getComputedStyle(el);
    return /(auto|scroll|overlay)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 1;
  };
  let st = globalThis[key];
  if (op === 'init') {
    st = globalThis[key] = { c: null, how: 'page', root: target || document.documentElement };
    if (target !== null && target !== doc && target !== document.body) {
      if (scrollable(target)) { st.c = target; st.how = 'element'; }
      else for (let p = target.parentElement; p !== null; p = p.parentElement) {
        if (p === doc || p === document.body) break;
        if (scrollable(p)) { st.c = p; st.how = 'ancestor'; break; }
      }
    }
    st.seen = new WeakSet(st.root.getElementsByTagName('*'));
  }
  if (st === undefined) return { lost: true };
  const c = st.c || doc;
  const measure = (extra) => {
    let root = st.root, rootLost = false;
    if (!root.isConnected) { root = document.documentElement; rootLost = true; }
    let added = 0;
    for (const el of root.getElementsByTagName('*')) if (!st.seen.has(el)) added++;
    const r = { how: st.how, top: Math.round(c.scrollTop), max: Math.max(0, Math.round(c.scrollHeight - c.clientHeight)), height: Math.round(c.scrollHeight), added, ...extra };
    if (rootLost) r.rootLost = true;
    return r;
  };
  if (op === 'into') {
    target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    st.how = 'into';
    return measure({});
  }
  if (op === 'step') {
    const before = c.scrollTop;
    if (to === 'top') c.scrollTo({ top: 0, behavior: 'instant' });
    else if (to === 'bottom') c.scrollTo({ top: c.scrollHeight, behavior: 'instant' });
    else c.scrollBy({ top: by === null ? Math.max(1, Math.round(c.clientHeight * 0.9)) : by, behavior: 'instant' });
    return measure({ moved: Math.abs(c.scrollTop - before) >= 1 });
  }
  if (op === 'done') { const r = measure({}); delete globalThis[key]; return r; }
  return measure({});
}`;

const fmt = (n: number) => n.toLocaleString('fr-FR').replace(/ | /g, ' ');

/** Note de fin de commande : une ligne, bornée. */
export function scrollNote(r: ScrollReport, maxSteps: number): string {
  const where = r.how === 'page' ? 'page' : r.how === 'element' ? 'zone' : r.how === 'ancestor' ? 'conteneur défilant de l\'élément' : 'élément amené dans la vue ; page';
  const end = r.max <= 0 ? ' (rien à faire défiler)' : r.to <= 0 ? ' (haut)' : r.to >= r.max - 1 ? ' (bas atteint)' : '';
  const parts = [`défilement (${where}) : ${fmt(r.from)} → ${fmt(r.to)} px sur ${fmt(r.max)}${end}`];
  if (r.steps > 1 || r.settled !== undefined) parts.push(`${r.steps} pas`);
  parts.push(r.added === null ? 'nœuds apparus : non mesuré (page remplacée pendant le défilement)' : `${fmt(r.added)} nœud(s) apparu(s)`);
  if (r.settled === true) parts.push('plus rien n\'apparaît');
  else if (r.stoppedBy === 'steps') parts.push(`plafond de ${maxSteps} pas atteint : du contenu peut encore apparaître (--max-steps N)`);
  else if (r.stoppedBy === 'budget') parts.push(`arrêt après ${SCROLL_BUDGET_MS / 1000} s : du contenu peut encore apparaître`);
  return parts.join(', ');
}
