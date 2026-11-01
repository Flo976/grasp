/**
 * Snapshot d'accessibilité compact : une ligne par nœud utile, `ref:rôle "nom"=valeur [états]`.
 *
 * Refs : hash de l'identité (rôle + nom accessible + rang parmi les homonymes), pas un index
 * positionnel. Insérer un nœud ailleurs dans la page ne décale aucune ref ; une ref ne change
 * que si le rôle ou le nom du nœud change. C'est ce qui rend --snap-diff exploitable.
 */

import { truncationLine } from '../core/limits.js';

export interface AXValue { value?: unknown }
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
}

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
  /** ref → {rôle, nom}, pour la résolution `text:`. */
  meta: Map<string, { role: string; name: string }>;
  /** Nœuds texte émis, pour la résolution `text:` de dernier recours. */
  textNodes: Array<{ text: string; backendNodeId: number }>;
  /** Avec `scopeBackendId` : la zone a-t-elle été trouvée dans l'arbre d'accessibilité ? */
  scopeFound?: boolean;
  /** Champs invalides de toute la page (même hors zone), dans l'ordre du document ; message '' s'il n'y en a pas. */
  invalid: Array<{ ref: string; backendId: number | undefined; line: string; message: string }>;
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
  formErrors?: FormErrors;
}

/** Budget par défaut (octets) ; le bridge applique `snapMax` de la config (12 000 par défaut). */
export const DEFAULT_MAX_BYTES = 12_000;

/** Conteneurs traversés sans être émis. */
const PASS_THROUGH = new Set(['generic', 'none', 'presentation', 'InlineTextBox', 'LineBreak', 'LabelText', 'paragraph', 'RootWebArea', 'Section', 'div', 'MenuListPopup', 'ListMarker', 'Abbr', 'emphasis', 'strong', 'superscript', 'subscript', 'time', 'mark', 'code']);
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

const listOf = <T>(xs: T[] | undefined): T[] => (xs === undefined ? [] : xs);
const str = (v: AXValue | undefined): string => (v?.value === undefined || v.value === null ? '' : String(v.value));
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

function quote(s: string, max: number): string {
  const t = norm(s);
  const cut = t.length > max ? `${t.slice(0, max - 1)}…` : t;
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
function liveText(node: AXNode, byId: Map<string, AXNode>): string {
  const parts: string[] = [];
  const walk = (n: AXNode) => {
    if (n.ignored) return;
    if (str(n.role) === 'StaticText') { parts.push(str(n.name)); return; }
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
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const root = nodes.find((n) => n.parentId === undefined || !byId.has(n.parentId)) ?? nodes[0];

  // Passe 1 : noms des nœuds émis, pour ne pas répéter leur texte en texte brut.
  const namedTexts = new Set<string>();
  for (const n of nodes) {
    const role = str(n.role);
    if (n.ignored || PASS_THROUGH.has(role) || role === 'StaticText') continue;
    const name = norm(str(n.name));
    if (name) namedTexts.add(name);
  }

  // Message d'erreur d'un champ : rendu sur la ligne du champ, pas répété en texte brut.
  const fieldErrors = opts.formErrors?.fields ?? new Map<number, string>();
  const invalidMsg = (n: AXNode): string | undefined => {
    const dom = n.backendDOMNodeId !== undefined ? fieldErrors.get(n.backendDOMNodeId) : undefined;
    if (dom !== undefined) return dom || (axInvalid(n) ? norm(str(n.description)) : '');
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
  const meta = new Map<string, { role: string; name: string }>();
  const texts: string[] = [];
  const textNodes: Array<{ text: string; backendNodeId: number }> = [];
  const out: Array<{ depth: number; line: string }> = [];
  const occurrences = new Map<string, number>();
  const scoped = opts.scopeBackendId !== undefined;
  let scopeFound = false;
  // Élagage annoncé : ce que Grasp masque est compté, et dit en dernière ligne.
  let namelessLinks = 0;
  let iframes = 0;

  const makeRef = (role: string, name: string): string => {
    const key = `${role}\u0000${name}`;
    const k = occurrences.get(key) ?? 0;
    occurrences.set(key, k + 1);
    for (let salt = 0; ; salt++) {
      const ref = `e${(fnv1a(`${key}\u0000${k}\u0000${salt}`) % REF_SPACE).toString(36)}`;
      if (!refs.has(ref)) return ref;
    }
  };

  const walk = (node: AXNode, depth: number, ancestorNames: string[], inScopeAbove: boolean) => {
    const role = str(node.role);
    const name = norm(str(node.name));
    let emitted = false;
    // Région annoncée sans nom : son texte sur sa ligne (la ref reste celle du rôle seul).
    let live = '';
    // Racine de la zone : les profondeurs repartent de 0 sous elle.
    const isScopeRoot = scoped && !inScopeAbove && node.backendDOMNodeId === opts.scopeBackendId;
    if (isScopeRoot) { scopeFound = true; depth = 0; }
    const inScope = !scoped || inScopeAbove || isScopeRoot;
    if (!node.ignored) {
      if (role === 'StaticText') {
        const text = norm(name);
        if (text && !namedTexts.has(text) && !ancestorNames.some((a) => a.includes(text))) {
          if (node.backendDOMNodeId !== undefined) textNodes.push({ text, backendNodeId: node.backendDOMNodeId });
          if (inScope) {
            texts.push(text);
            out.push({ depth, line: quote(text, 100) });
          }
        }
        return; // InlineTextBox enfants : inutiles
      }
      if (role === 'Iframe' && inScope) iframes++; // le contenu d'un cadre n'est jamais parcouru
      // Lien sans nom : du bruit pour l'agent (rien ne dit où il mène). Masqué mais compté, et sa ref
      // reste résoluble (screenshot --refs la dessine).
      const nameless = role === 'link' && !name;
      const skip = PASS_THROUGH.has(role) || (NAMED_ONLY.has(role) && !name) || nameless;
      if (nameless) {
        const ref = makeRef(role, name);
        if (node.backendDOMNodeId !== undefined) refs.set(ref, node.backendDOMNodeId);
        meta.set(ref, { role, name });
        if (inScope) namelessLinks++;
      }
      if (!skip && role) {
        const ref = makeRef(role, name);
        const val = VALUE_ROLES.has(role) ? norm(str(node.value)) : '';
        const err = FIELD_ROLES.has(role) ? invalidMsg(node) : undefined;
        if (LIVE_ROLES.has(role) && !name) live = liveText(node, byId);
        const shown = name || live;
        const line = `${ref}:${role}${level(node)}${shown ? ` ${quote(shown, live ? 100 : 80)}` : ''}${val ? `=${quote(val, 60)}` : ''}${flags(node, role, err)}`;
        if (err !== undefined) invalid.push({ ref, backendId: node.backendDOMNodeId, line, message: err });
        if (node.backendDOMNodeId !== undefined) refs.set(ref, node.backendDOMNodeId);
        meta.set(ref, { role, name });
        if (inScope) {
          entries.set(ref, line);
          out.push({ depth, line });
        }
        emitted = true;
      }
    }
    // Les options d'un <select> fermé ne sont pas utiles dans le snapshot : `select` les résout côté DOM.
    if (role === 'combobox' && !node.properties?.some((p) => p.name === 'expanded' && p.value.value === true)) {
      // on enregistre quand même les options comme refs résolubles
      registerHidden(node);
      return;
    }
    // Le texte interne d'un champ (sa valeur) est déjà rendu par `=valeur` : on ne descend pas.
    if (emitted && VALUE_ROLES.has(role)) return;
    const ownName = name || live;
    const nextNames = emitted && ownName ? [...ancestorNames, ownName] : ancestorNames;
    // Hors zone, la profondeur n'a pas d'importance : rien n'est émis.
    const nextDepth = emitted && inScope ? depth + 1 : depth;
    for (const id of listOf(node.childIds)) {
      const c = byId.get(id);
      if (c) walk(c, nextDepth, nextNames, inScope);
    }
  };

  const registerHidden = (node: AXNode) => {
    for (const id of listOf(node.childIds)) {
      const c = byId.get(id);
      if (!c) continue;
      const role = str(c.role);
      if (role === 'option' && !c.ignored) {
        const name = norm(str(c.name));
        const ref = makeRef(role, name);
        if (c.backendDOMNodeId !== undefined) refs.set(ref, c.backendDOMNodeId);
        meta.set(ref, { role, name });
      }
      registerHidden(c);
    }
  };

  if (root) walk(root, 0, [], false);
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
  return { url: opts.url, title: opts.title, text: lines.join('\n'), refs, entries, texts, meta, textNodes, invalid, ...(scoped ? { scopeFound } : {}) };
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
