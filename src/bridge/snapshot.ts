/**
 * Snapshot d'accessibilité compact : une ligne par nœud utile, `ref:rôle "nom"=valeur [états]`.
 *
 * Refs : hash de l'identité (rôle + nom accessible + rang parmi les homonymes), pas un index
 * positionnel. Insérer un nœud ailleurs dans la page ne décale aucune ref ; une ref ne change
 * que si le rôle ou le nom du nœud change. C'est ce qui rend --snap-diff exploitable.
 */

import { truncationLine } from '../core/limits.js';

/** Source d'un nom calculé (getFullAXTree) : libellés liés (label for, aria-labelledby) et leur texte. */
export interface AXValueSource {
  superseded?: boolean;
  attributeValue?: { relatedNodes?: Array<{ text?: string }> };
  nativeSourceValue?: { relatedNodes?: Array<{ text?: string }> };
}
export interface AXValue { value?: unknown; sources?: AXValueSource[] }
export interface AXNode {
  nodeId: string;
  ignored?: boolean;
  role?: AXValue;
  name?: AXValue;
  value?: AXValue;
  description?: AXValue;
  properties?: Array<{ name: string; value: AXValue }>;
  childIds?: string[];
  parentId?: string;
  backendDOMNodeId?: number;
  ignoredReasons?: Array<{ name: string }>;
}

/**
 * Rôle et nom rendu d'une ref ; `alt` : nom brut de l'arbre quand il diffère (voir Snapshot.meta). `near` :
 * case à cocher, radio ou switch sans nom suivie d'un texte (« <input type=checkbox> checkbox 2 ») — ce texte
 * est son libellé naturel : `text:` le retrouve (après les noms accessibles), mais il n'entre pas dans `name`.
 */
export interface RefMeta { role: string; name: string; alt?: string; near?: string }

export interface Snapshot {
  url: string;
  title: string;
  /** Texte rendu (respecte maxBytes ; limité à la zone si `scopeBackendId`). */
  text: string;
  /** ref → backendDOMNodeId, pour tous les nœuds de la page, y compris hors budget et hors zone. */
  refs: Map<string, number>;
  /** ref → ligne sans indentation (base du diff), dans la zone s'il y en a une. */
  entries: Map<string, string>;
  /** Lignes de texte brut, sans ref (dans la zone s'il y en a une). */
  texts: string[];
  /**
   * ref → {rôle, nom rendu}, pour la résolution `text:`. `alt` : nom brut de l'arbre d'accessibilité quand il
   * diffère du nom rendu (texte transformé par CSS, libellé répété) — `text:` accepte les deux formes.
   */
  meta: Map<string, RefMeta>;
  /** Nœuds texte émis, pour la résolution `text:` de dernier recours. */
  textNodes: Array<{ text: string; backendNodeId: number }>;
  /** Avec `scopeBackendId` : la zone a-t-elle été trouvée dans l'arbre d'accessibilité ? */
  scopeFound?: boolean;
  /** Champs invalides de toute la page (même hors zone), dans l'ordre du document ; message '' s'il n'y en a pas. */
  invalid: Array<{ ref: string; backendId: number | undefined; line: string; message: string }>;
  /** Fenêtre modale ouverte qui masque le reste de la page : son nom accessible ('' sans nom). */
  modal?: string;
}

/**
 * Erreurs de formulaire relevées dans le DOM (bridge) : ce que l'arbre d'accessibilité ne dit pas.
 * `fields` : backendDOMNodeId du champ → message (aria-errormessage, aria-describedby, validationMessage,
 * ou message visible non relié à côté du champ ; '' si invalide sans message). `alerts` : messages
 * d'erreur visibles absents de l'arbre (aria-hidden) et rattachés à aucun champ.
 */
export interface FormErrors { fields: Map<number, string>; alerts: string[] }

export interface SnapshotOptions {
  url: string;
  title: string;
  maxBytes?: number;
  /**
   * Zone : backendDOMNodeId de l'élément racine. Tout l'arbre est parcouru (les refs dépendent du rang
   * parmi les homonymes de TOUTE la page, elles restent donc identiques à celles du snapshot complet),
   * mais seules les lignes du sous-arbre sont émises.
   */
  scopeBackendId?: number;
  /**
   * Relevé DOM des erreurs de formulaire. Fourni, il fait foi : un champ que l'arbre d'accessibilité dit
   * invalide (validité native d'un radio required jamais touché…) sans erreur exposée dans le DOM
   * (aria-invalid, :user-invalid, message visible relié) n'est pas marqué [invalide].
   */
  formErrors?: FormErrors;
  /**
   * Texte source des nœuds texte mis en forme par CSS (text-transform) : backendDOMNodeId du nœud texte →
   * texte du DOM. L'arbre d'accessibilité donne le texte transformé (« ENREGISTRER ») ; l'agent doit voir
   * et taper le texte d'origine.
   */
  sourceTexts?: Map<number, string>;
  /**
   * Longueur maximale d'un nom ou d'un texte rendu (`--name-max`), coupure marquée « … » ; 0 = illimité.
   * Défaut : NAME_MAX pour les noms, TEXT_MAX pour les textes et régions annoncées. Les refs n'en dépendent pas.
   */
  nameMax?: number;
}

/** Longueur par défaut d'un nom rendu (lien, bouton…) et d'une ligne de texte brut. */
export const NAME_MAX = 80;
export const TEXT_MAX = 100;

/** Budget par défaut (octets) ; le bridge applique `snapMax` de la config (12 000 par défaut). */
export const DEFAULT_MAX_BYTES = 12_000;

/** Conteneurs traversés sans être émis. */
const PASS_THROUGH = new Set(['generic', 'none', 'presentation', 'InlineTextBox', 'LineBreak', 'LabelText', 'Legend', 'paragraph', 'RootWebArea', 'Section', 'div', 'MenuListPopup', 'ListMarker', 'Abbr', 'emphasis', 'strong', 'superscript', 'subscript', 'time', 'mark', 'code']);
/** Conteneurs émis seulement s'ils ont un nom. */
const NAMED_ONLY = new Set(['group', 'region', 'listitem', 'article', 'figure', 'cell', 'row', 'rowgroup', 'blockquote', 'contentinfo', 'banner', 'term', 'definition', 'Iframe', 'image']);
export const INTERACTIVE = new Set(['button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'switch', 'slider', 'spinbutton', 'treeitem']);
const VALUE_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider']);
/** Champs dont la validité est rendue (`[invalide: message]`). */
const FIELD_ROLES = new Set([...VALUE_ROLES, 'checkbox', 'radio', 'switch', 'listbox', 'radiogroup']);
/** Régions annoncées : leur texte est rendu sur leur ligne, pour qu'un --snap-diff le montre changer. */
const LIVE_ROLES = new Set(['alert', 'status', 'log', 'alertdialog']);
/** Longueur maximale d'un message d'erreur rendu. */
const ERROR_MAX = 120;
/** Options rendues par liste (select natif, listbox) ; les suivantes sont comptées, leurs refs restent résolubles. */
const OPTIONS_MAX = 20;
/** Rôles sans nom auxquels on donne un nom de contexte (texte voisin) : croix de suppression d'un tag, etc. */
const CONTEXT_ROLES = new Set(['button', 'checkbox', 'radio', 'switch', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'treeitem']);
/**
 * Rôles dont le libellé naturel, sans <label>, est le texte qui les SUIT (« [ ] checkbox 2 ») : nœuds frères
 * suivants, jusqu'au prochain contrôle ou <br>. Le texte qui précède (libellé de la case précédente) ne sert
 * qu'en repli.
 */
const NEXT_LABEL_ROLES = new Set(['checkbox', 'radio', 'switch']);
/** Enfants d'une combobox ouverte qui portent ses options (le reste est son texte interne, déjà rendu en =valeur). */
const POPUP_ROLES = new Set(['MenuListPopup', 'listbox', 'tree', 'grid', 'dialog', 'group', 'option']);
/** Raisons Chrome d'un nœud masqué par une modale, un fond aria-hidden ou inerte. */
const MASKED_REASONS = new Set(['activeModalDialog', 'ariaHiddenElement', 'ariaHiddenSubtree', 'inertElement', 'inertSubtree']);

const listOf = <T>(xs: T[] | undefined): T[] => (xs === undefined ? [] : xs);
const str = (v: AXValue | undefined): string => (v?.value === undefined || v.value === null ? '' : String(v.value));
/** Caractères invisibles (espaces de largeur nulle, BOM, césure conditionnelle) : jamais rendus. */
const INVISIBLE = /[\u200b-\u200d\u2060\ufeff\u00ad]/g;
const norm = (s: string) => s.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();

/**
 * Nom répété (« Heures Heures ») : champ à deux <label>, ou aria-labelledby qui cite deux fois le même
 * texte. Si le nom est exactement k fois la même suite de mots, on n'en garde qu'une — à condition que la
 * répétition vienne de plusieurs libellés (sources du nom : au moins deux libellés liés, tous de ce texte),
 * ou, sans sources, que la suite répétée compte au moins deux mots. Un nom propre « Bora Bora » reste entier.
 */
function dedupeName(s: string, name: AXValue | undefined): string {
  const w = s.split(' ');
  for (let k = 1; k <= w.length / 2; k++) {
    if (w.length % k !== 0) continue;
    const head = w.slice(0, k).join(' ');
    let same = true;
    for (let i = k; i < w.length && same; i += k) same = w.slice(i, i + k).join(' ') === head;
    if (!same) continue;
    const related = listOf(name?.sources).filter((x) => x.superseded !== true)
      .map((x) => listOf(x.attributeValue?.relatedNodes ?? x.nativeSourceValue?.relatedNodes))
      .find((r) => r.length > 0);
    if (related !== undefined) return related.length >= 2 && related.every((r) => norm(r.text ?? '') === head) ? head : s;
    return k >= 2 ? head : s;
  }
  return s;
}

/**
 * Restaure le texte source dans un nom calculé à partir de textes transformés : même suite de caractères
 * hors blancs, remplacée caractère pour caractère (les blancs du nom sont gardés). undefined si ça ne
 * colle pas (nom venu d'aria-label, transformation qui change la longueur : ß → SS).
 */
function restoreSource(name: string, transformed: string, source: string): string | undefined {
  const t = Array.from(transformed.replace(/\s+/g, ''));
  const o = Array.from(source.replace(/\s+/g, ''));
  const n = Array.from(name);
  if (t.length !== o.length || n.filter((c) => !/\s/.test(c)).join('') !== t.join('')) return undefined;
  let k = 0;
  return n.map((c) => (/\s/.test(c) ? c : o[k++]!)).join('');
}

const hasProp = (n: AXNode, name: string, value: unknown) => listOf(n.properties).some((p) => p.name === name && p.value.value === value);

function quote(s: string, max: number): string {
  const t = norm(s);
  const cut = t.length > max ? `${t.slice(0, Math.max(1, max - 1))}…` : t;
  return `"${cut.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const REF_SPACE = 36 ** 4;

function flags(node: AXNode, role: string, invalidMsg: string | undefined): string {
  const p = new Map<string, unknown>();
  for (const pr of listOf(node.properties)) p.set(pr.name, pr.value.value);
  const out: string[] = [];
  const checked = p.get('checked') ?? p.get('pressed');
  if (checked === 'true' || checked === true) out.push('[x]');
  else if (checked === 'false' || checked === false) out.push('[ ]');
  else if (checked === 'mixed') out.push('[~]');
  const expanded = p.get('expanded');
  if (expanded === true) out.push('[+]');
  else if (expanded === false) out.push('[-]');
  if (p.get('selected') === true && role !== 'option') out.push('[selected]');
  if (p.get('selected') === true && role === 'option') out.push('[x]');
  if (p.get('disabled') === true) out.push('[disabled]');
  if (p.get('readonly') === true) out.push('[readonly]');
  if (p.get('required') === true) out.push('[required]');
  if (p.get('focused') === true) out.push('[focus]');
  if (invalidMsg !== undefined) out.push(invalidMsg ? `[invalide: ${norm(invalidMsg).length > ERROR_MAX ? `${norm(invalidMsg).slice(0, ERROR_MAX - 1)}…` : norm(invalidMsg)}]` : '[invalide]');
  return out.length ? ` ${out.join(' ')}` : '';
}

/** Le champ est-il invalide pour l'arbre d'accessibilité (aria-invalid, validité native) ? */
function axInvalid(node: AXNode): boolean {
  const v = node.properties?.find((p) => p.name === 'invalid')?.value.value;
  return v !== undefined && v !== null && v !== 'false' && v !== false;
}

/** Texte des descendants StaticText (régions annoncées sans nom). */
function liveText(node: AXNode, byId: Map<string, AXNode>, nameOf: (n: AXNode) => string): string {
  const parts: string[] = [];
  const walk = (n: AXNode) => {
    if (n.ignored) return;
    if (str(n.role) === 'StaticText') { parts.push(nameOf(n)); return; }
    for (const id of listOf(n.childIds)) { const c = byId.get(id); if (c) walk(c); }
  };
  walk(node);
  return norm(parts.join(' '));
}

function level(node: AXNode): string {
  const l = node.properties?.find((p) => p.name === 'level')?.value.value;
  return typeof l === 'number' ? `[${l}]` : '';
}

export function buildSnapshot(nodes: AXNode[], opts: SnapshotOptions): Snapshot {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const nameMax = opts.nameMax === undefined ? NAME_MAX : opts.nameMax === 0 ? Infinity : opts.nameMax;
  const textMax = opts.nameMax === undefined ? TEXT_MAX : nameMax;
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const root = nodes.find((n) => n.parentId === undefined || !byId.has(n.parentId)) ?? nodes[0];

  // Texte source sous text-transform : nœuds texte transformés (par backendDOMNodeId), ancêtres dont le nom
  // en dérive (restauré caractère pour caractère), et table exacte transformé → source pour les noms venus
  // d'un <label> (null : plusieurs sources possibles, on ne choisit pas).
  const sources = opts.sourceTexts ?? new Map<number, string>();
  const sourceOf = (n: AXNode) => (n.backendDOMNodeId !== undefined ? sources.get(n.backendDOMNodeId) : undefined);
  const transformedAbove = new Set<string>();
  const exactSource = new Map<string, string | null>();
  if (sources.size > 0) {
    for (const n of nodes) {
      const src = str(n.role) === 'StaticText' ? sourceOf(n) : undefined;
      if (src === undefined) continue;
      const t = norm(str(n.name));
      const o = norm(src);
      if (t === o || t === '') continue;
      const prev = exactSource.get(t);
      exactSource.set(t, prev === undefined || prev === o ? o : null);
      for (let p = n.parentId; p !== undefined && !transformedAbove.has(p); p = byId.get(p)?.parentId) transformedAbove.add(p);
    }
  }
  const collectTexts = (n: AXNode, t: string[], o: string[]) => {
    for (const id of listOf(n.childIds)) {
      const c = byId.get(id);
      if (!c) continue;
      if (str(c.role) === 'StaticText') {
        if (!c.ignored) { t.push(norm(str(c.name))); o.push(norm(sourceOf(c) ?? str(c.name))); }
      } else collectTexts(c, t, o);
    }
  };
  /** Nom rendu d'un nœud : sans caractères invisibles, texte source restauré, libellé répété dédupliqué. */
  const names = new Map<string, string>();
  const nameOf = (n: AXNode): string => {
    const cached = names.get(n.nodeId);
    if (cached !== undefined) return cached;
    const role = str(n.role);
    let name = norm(str(n.name));
    if (FIELD_ROLES.has(role)) name = dedupeName(name, n.name);
    if (name !== '' && sources.size > 0) {
      const src = role === 'StaticText' ? sourceOf(n) : undefined;
      if (src !== undefined) name = norm(src);
      else if (role !== 'StaticText') {
        let fixed: string | undefined;
        if (transformedAbove.has(n.nodeId)) {
          const t: string[] = [];
          const o: string[] = [];
          collectTexts(n, t, o);
          fixed = restoreSource(name, t.join(' '), o.join(' '));
        }
        fixed ??= exactSource.get(name) ?? undefined;
        if (fixed !== undefined) name = fixed;
      }
    }
    names.set(n.nodeId, name);
    return name;
  };

  // Passe 1 : noms des nœuds émis, pour ne pas répéter leur texte en texte brut.
  const namedTexts = new Set<string>();
  for (const n of nodes) {
    const role = str(n.role);
    if (n.ignored || PASS_THROUGH.has(role) || role === 'StaticText') continue;
    const name = nameOf(n);
    if (name) namedTexts.add(name);
  }

  // Message d'erreur d'un champ : rendu sur la ligne du champ, pas répété en texte brut. Avec le relevé
  // DOM, l'invalidité native seule (radio required d'un groupe jamais touché) ne suffit pas : il faut une
  // erreur exposée (aria-invalid, :user-invalid, message relié ou visible).
  const fieldErrors = opts.formErrors?.fields ?? new Map<number, string>();
  const invalidMsg = (n: AXNode): string | undefined => {
    const dom = n.backendDOMNodeId !== undefined ? fieldErrors.get(n.backendDOMNodeId) : undefined;
    if (dom !== undefined) return dom || (axInvalid(n) ? norm(str(n.description)) : '');
    if (opts.formErrors !== undefined) return undefined;
    return axInvalid(n) ? norm(str(n.description)) : undefined;
  };
  for (const n of nodes) {
    const role = str(n.role);
    if (n.ignored || !FIELD_ROLES.has(role)) continue;
    const m = invalidMsg(n);
    if (m) namedTexts.add(m);
  }
  const invalid: Snapshot['invalid'] = [];

  const refs = new Map<string, number>();
  const entries = new Map<string, string>();
  const meta = new Map<string, RefMeta>();
  const texts: string[] = [];
  const textNodes: Array<{ text: string; backendNodeId: number }> = [];
  const out: Array<{ depth: number; line: string }> = [];
  const occurrences = new Map<string, number>();
  const scoped = opts.scopeBackendId !== undefined;
  let scopeFound = false;
  // Élagage annoncé : ce que Grasp masque est compté, et dit en dernière ligne.
  let namelessLinks = 0;
  let iframes = 0;

  // Fenêtres modales ouvertes. Leur sous-arbre a ses propres refs : quand la modale masque le fond (showModal,
  // fond aria-hidden), les homonymes du fond disparaissent de l'arbre, et sans cette séparation la ref du
  // « Fermer » du fond glisserait sur le « Fermer » de la modale.
  const isModal = (n: AXNode) => !n.ignored && (str(n.role) === 'dialog' || str(n.role) === 'alertdialog') && hasProp(n, 'modal', true);
  const modals = nodes.filter(isModal);
  let modal: string | undefined;
  if (modals.length > 0) {
    const inModal = new Set<string>();
    const mark = (n: AXNode) => { inModal.add(n.nodeId); for (const id of listOf(n.childIds)) { const c = byId.get(id); if (c && !inModal.has(c.nodeId)) mark(c); } };
    for (const m of modals) mark(m);
    const reasons = (n: AXNode) => listOf(n.ignoredReasons).map((r) => r.name);
    // Fond masqué : Chrome l'a retiré (showModal), ou il est aria-hidden/inerte et plus rien d'actionnable
    // ne reste hors de la modale.
    const pruned = nodes.some((n) => n.ignored && reasons(n).includes('activeModalDialog'));
    const hiddenBg = nodes.some((n) => n.ignored && !inModal.has(n.nodeId) && reasons(n).some((r) => MASKED_REASONS.has(r)))
      && !nodes.some((n) => !n.ignored && !inModal.has(n.nodeId) && (INTERACTIVE.has(str(n.role)) || str(n.role) === 'heading'));
    if (pruned || hiddenBg) modal = nameOf(modals[modals.length - 1]!);
  }

  /**
   * Nom BRUT de l'arbre d'accessibilité (sans texte source restauré ni déduplication) : base du hash des refs.
   * Le relevé du texte source (text-transform) peut être partiel ou échouer : il ne change que l'affichage.
   */
  const rawOf = (n: AXNode): string => norm(str(n.name));
  const makeRef = (role: string, name: string, zone = ''): string => {
    const key = `${role}\u0000${name}${zone}`;
    const k = occurrences.get(key) ?? 0;
    occurrences.set(key, k + 1);
    for (let salt = 0; ; salt++) {
      const ref = `e${(fnv1a(`${key}\u0000${k}\u0000${salt}`) % REF_SPACE).toString(36)}`;
      if (!refs.has(ref)) return ref;
    }
  };
  /** Ref résoluble mais non rendue (option au-delà du budget, select fermé). */
  const register = (n: AXNode, role: string, name: string, zone: string) => {
    const raw = rawOf(n);
    const ref = makeRef(role, raw, zone);
    if (n.backendDOMNodeId !== undefined) refs.set(ref, n.backendDOMNodeId);
    meta.set(ref, raw !== name ? { role, name, alt: raw } : { role, name });
  };

  /**
   * Texte visible d'un sous-arbre (StaticText non ignorés, à travers les nœuds ignorés) : rendu et brut,
   * borné en longueur et en nœuds parcourus (`budget.n`, partagé par tout un contexte).
   */
  const textOf = (n: AXNode, budget: { n: number }, acc: { shown: string[]; raw: string[]; len: number } = { shown: [], raw: [], len: 0 }) => {
    if (--budget.n < 0) return acc;
    if (str(n.role) === 'StaticText') {
      const t = n.ignored ? '' : nameOf(n);
      if (t) { acc.shown.push(t); acc.raw.push(rawOf(n)); acc.len += t.length + 1; }
      return acc;
    }
    for (const id of listOf(n.childIds)) {
      if (acc.len > 60 || budget.n <= 0) break;
      const c = byId.get(id);
      if (c) textOf(c, budget, acc);
    }
    return acc;
  };
  /**
   * Contexte d'un élément sans nom : texte du frère le plus proche (avant, puis après), sinon de ceux du
   * parent, jusqu'à 3 niveaux (300 nœuds parcourus au plus). Croix d'un tag « PHP » → « PHP ». Case à cocher,
   * radio, switch : d'abord le texte qui la SUIT (frères suivants jusqu'au prochain contrôle ou saut de ligne),
   * son libellé naturel (`follows`). `key` entre dans la ref : texte brut de l'arbre, SANS chiffres (compteur,
   * horodatage voisins), pour qu'elle ne change pas quand un compteur bouge ; `label` est le texte rendu.
   */
  const contextOf = (node: AXNode): { label: string; key: string; text: string; follows: boolean } => {
    const budget = { n: 300 };
    const found = (acc: { shown: string[]; raw: string[] }, follows: boolean) => {
      const t = norm(acc.shown.join(' '));
      if (!t) return undefined;
      const key = norm(acc.raw.join(' ').replace(/\p{N}+/gu, ' ')).slice(0, 40);
      return { label: t.length > 40 ? `${t.slice(0, 39)}…` : t, key: key !== '' ? key : '#', text: t, follows };
    };
    if (NEXT_LABEL_ROLES.has(str(node.role)) && node.parentId !== undefined) {
      const sibs = listOf(byId.get(node.parentId)?.childIds);
      for (const id of sibs.slice(sibs.indexOf(node.nodeId) + 1)) {
        const c = byId.get(id);
        if (!c) continue;
        const r = str(c.role);
        if (r === 'LineBreak' || INTERACTIVE.has(r) || budget.n <= 0) break;
        const hit = found(textOf(c, budget), true);
        if (hit) return hit;
      }
    }
    let cur = node;
    for (let up = 0; up < 3 && cur.parentId !== undefined && budget.n > 0; up++) {
      const parent = byId.get(cur.parentId);
      if (!parent) break;
      const sibs = listOf(parent.childIds);
      const i = sibs.indexOf(cur.nodeId);
      for (const id of [...sibs.slice(0, i).reverse(), ...sibs.slice(i + 1)]) {
        if (budget.n <= 0) break;
        const c = byId.get(id);
        if (!c) continue;
        const hit = found(textOf(c, budget), false);
        if (hit) return hit;
      }
      cur = parent;
    }
    return { label: '', key: '', text: '', follows: false };
  };

  /** Options d'une liste : rendues jusqu'à OPTIONS_MAX (les sélectionnées toujours), les autres comptées. */
  interface OptionBudget { shown: number; hidden: number }

  const walk = (node: AXNode, depth: number, ancestorNames: string[], inScopeAbove: boolean, zoneAbove: string, budget?: OptionBudget) => {
    const role = str(node.role);
    const name = nameOf(node);
    const zone = isModal(node) ? '\u0002modale' : zoneAbove;
    let emitted = false;
    // Région annoncée sans nom : son texte sur sa ligne (la ref reste celle du rôle seul).
    let live = '';
    // Racine de la zone : les profondeurs repartent de 0 sous elle.
    const isScopeRoot = scoped && !inScopeAbove && node.backendDOMNodeId === opts.scopeBackendId;
    if (isScopeRoot) { scopeFound = true; depth = 0; }
    const inScope = !scoped || inScopeAbove || isScopeRoot;
    if (!node.ignored) {
      if (role === 'StaticText') {
        const text = name;
        // Puce de liste (« • ») ou ponctuation de pseudo-élément (sans nœud DOM) : du bruit.
        const marker = !/[\p{L}\p{N}]/u.test(text) && (node.backendDOMNodeId === undefined || (node.parentId !== undefined && str(byId.get(node.parentId)?.role) === 'ListMarker'));
        if (text && !marker && !namedTexts.has(text) && !ancestorNames.some((a) => a.includes(text))) {
          if (node.backendDOMNodeId !== undefined) textNodes.push({ text, backendNodeId: node.backendDOMNodeId });
          if (inScope) {
            texts.push(text);
            out.push({ depth, line: quote(text, textMax) });
          }
        }
        return; // InlineTextBox enfants : inutiles
      }
      // Option au-delà du budget de sa liste : résoluble, pas rendue.
      if (role === 'option' && budget !== undefined) {
        if (budget.shown >= OPTIONS_MAX && !hasProp(node, 'selected', true)) {
          register(node, role, name, zone);
          budget.hidden++;
          return;
        }
        budget.shown++;
      }
      if (role === 'Iframe' && inScope) iframes++; // le contenu d'un cadre n'est jamais parcouru
      // Lien sans nom : du bruit pour l'agent (rien ne dit où il mène). Masqué mais compté, et sa ref
      // reste résoluble (screenshot --refs la dessine).
      const nameless = role === 'link' && !name;
      const skip = PASS_THROUGH.has(role) || (NAMED_ONLY.has(role) && !name) || nameless;
      if (nameless) {
        register(node, role, name, zone);
        if (inScope) namelessLinks++;
      }
      if (!skip && role) {
        // Bouton sans nom (croix d'un tag…) : nommé par son contexte, qui entre dans sa ref pour qu'elle
        // ne glisse pas vers la croix voisine quand un tag est supprimé. Son nom (meta) reste vide : text:PHP
        // ne doit jamais désigner la croix du tag PHP.
        const raw = rawOf(node);
        const cx = !name && CONTEXT_ROLES.has(role) ? contextOf(node) : { label: '', key: '', text: '', follows: false };
        const ctx = cx.label;
        const ref = makeRef(role, cx.key ? `\u0001${cx.key}` : raw, zone);
        const val = VALUE_ROLES.has(role) ? norm(str(node.value)) : '';
        const err = FIELD_ROLES.has(role) ? invalidMsg(node) : undefined;
        if (LIVE_ROLES.has(role) && !name) live = liveText(node, byId, nameOf);
        const shown = name || live;
        const label = shown ? ` ${quote(shown, live ? textMax : nameMax)}` : ctx ? ` (sans nom, près de ${quote(ctx, 40)})` : '';
        const line = `${ref}:${role}${level(node)}${label}${val ? `=${quote(val, 60)}` : ''}${flags(node, role, err)}`;
        if (err !== undefined) invalid.push({ ref, backendId: node.backendDOMNodeId, line, message: err });
        if (node.backendDOMNodeId !== undefined) refs.set(ref, node.backendDOMNodeId);
        meta.set(ref, { role, name, ...(raw !== name && raw !== '' ? { alt: raw } : {}), ...(cx.follows ? { near: cx.text } : {}) });
        if (inScope) {
          entries.set(ref, line);
          out.push({ depth, line });
        }
        emitted = true;
      }
    }
    const ownName = name || live;
    const nextNames = emitted && ownName ? [...ancestorNames, ownName] : ancestorNames;
    // Hors zone, la profondeur n'a pas d'importance : rien n'est émis.
    const nextDepth = emitted && inScope ? depth + 1 : depth;
    if (role === 'combobox') {
      // <select> fermé : ses options sur une ligne compacte (sélection marquée), refs résolubles.
      if (!hasProp(node, 'expanded', true)) {
        const opts: Array<{ text: string; selected: boolean }> = [];
        collectOptions(node, zone, opts);
        if (emitted && inScope && opts.length > 0) {
          // Les OPTIONS_MAX premières, plus toute option choisie au-delà (marquée [x]) ; le reste compté.
          const shownOpts = opts.filter((o, i) => i < OPTIONS_MAX || o.selected);
          const more = opts.length - shownOpts.length;
          out.push({ depth: nextDepth, line: `options : ${shownOpts.map((o) => o.text).join(' | ')}${more > 0 ? ` | … +${more}` : ''}` });
        }
        return;
      }
      // Ouverte : seulement ses listes d'options (aria-owns, popup du <select>) ; son texte interne est sa valeur.
      const b: OptionBudget = { shown: 0, hidden: 0 };
      for (const id of listOf(node.childIds)) {
        const c = byId.get(id);
        if (c && POPUP_ROLES.has(str(c.role))) walk(c, nextDepth, nextNames, inScope, zone, str(c.role) === 'listbox' ? undefined : b);
      }
      if (b.hidden > 0 && emitted && inScope) out.push({ depth: nextDepth, line: `… +${b.hidden} options` });
      return;
    }
    // Le texte interne d'un champ (sa valeur) est déjà rendu par `=valeur` : on ne descend pas.
    if (emitted && VALUE_ROLES.has(role)) return;
    const own = role === 'listbox' ? { shown: 0, hidden: 0 } : undefined;
    for (const id of listOf(node.childIds)) {
      const c = byId.get(id);
      if (c) walk(c, nextDepth, nextNames, inScope, zone, own ?? budget);
    }
    if (own !== undefined && own.hidden > 0 && inScope) out.push({ depth: nextDepth, line: `… +${own.hidden} options` });
  };

  const collectOptions = (node: AXNode, zone: string, acc: Array<{ text: string; selected: boolean }>) => {
    for (const id of listOf(node.childIds)) {
      const c = byId.get(id);
      if (!c) continue;
      const role = str(c.role);
      if (role === 'option' && !c.ignored) {
        const name = nameOf(c);
        register(c, role, name, zone);
        const selected = hasProp(c, 'selected', true);
        acc.push({ text: `${quote(name, 40)}${selected ? ' [x]' : ''}`, selected });
      }
      collectOptions(c, zone, acc);
    }
  };


  if (root) walk(root, 0, [], false, '');
  // Messages d'erreur hors de l'arbre d'accessibilité (aria-hidden), rattachés à aucun champ.
  const alertSeen = new Map<string, number>();
  for (const a of listOf(opts.formErrors?.alerts)) {
    const line = `alerte ${quote(a, ERROR_MAX)}`;
    const k = alertSeen.get(line) ?? 0;
    alertSeen.set(line, k + 1);
    entries.set(`\u0000${line}\u0000${k}`, line);
    out.push({ depth: 0, line });
  }

  const header = `page ${quote(opts.title, 80)} ${opts.url}`;
  const pruned = [
    namelessLinks > 0 ? `${namelessLinks} lien${namelessLinks > 1 ? 's' : ''} sans nom (refs visibles avec screenshot --refs)` : '',
    iframes > 0 ? `${iframes} iframe${iframes > 1 ? 's' : ''} non parcourue${iframes > 1 ? 's' : ''}` : '',
    modal !== undefined ? `reste de la page masqué par la fenêtre modale${modal ? ` ${quote(modal, 60)}` : ''}` : '',
  ].filter((x) => x !== '');
  const summary = pruned.length > 0 ? `… élagué : ${pruned.join(', ')}` : undefined;
  const lines = [header];
  let bytes = Buffer.byteLength(header);
  // Place réservée aux lignes finales (élagage, troncature) : le budget est respecté avec elles.
  const reserve = (summary !== undefined ? Buffer.byteLength(summary) + 1 : 0) + 160;
  let omitted = 0;
  let rest = 0;
  for (const { depth, line } of out) {
    const l = ' '.repeat(depth) + line;
    const b = Buffer.byteLength(l) + 1;
    if (omitted > 0 || bytes + b > maxBytes - reserve) { omitted++; rest += l.length + 1; continue; }
    lines.push(l);
    bytes += b;
  }
  if (summary !== undefined) lines.push(summary);
  if (omitted > 0) lines.push(truncationLine(rest, ` (${omitted} nœuds omis)`));
  return { url: opts.url, title: opts.title, text: lines.join('\n'), refs, entries, texts, meta, textNodes, invalid, ...(scoped ? { scopeFound } : {}), ...(modal !== undefined ? { modal } : {}) };
}

/** Diff ref par ref. Navigation : renvoie le nouveau snapshot complet. */
export function diffSnapshots(before: Snapshot, after: Snapshot): string {
  if (before.url !== after.url) return `navigation → ${after.url}\n${after.text}`;
  const out: string[] = [];
  if (before.title !== after.title) out.push(`~ title ${quote(after.title, 80)}`);
  for (const [ref, line] of after.entries) {
    const prev = before.entries.get(ref);
    if (prev === undefined) out.push(`+ ${line}`);
    else if (prev !== line) out.push(`~ ${line}`);
  }
  for (const [ref, line] of before.entries) if (!after.entries.has(ref)) out.push(`- ${line}`);
  const count = (xs: string[]) => xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>());
  const bc = count(before.texts);
  const ac = count(after.texts);
  for (const [t, n] of ac) for (let i = bc.get(t) ?? 0; i < n; i++) out.push(`+ ${quote(t, 100)}`);
  for (const [t, n] of bc) for (let i = ac.get(t) ?? 0; i < n; i++) out.push(`- ${quote(t, 100)}`);
  return out.length ? out.join('\n') : '(aucun changement)';
}
