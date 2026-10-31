/**
 * Snapshot d'accessibilité compact : une ligne par nœud utile, `ref:rôle "nom"=valeur [états]`.
 *
 * Refs : hash de l'identité (rôle + nom accessible + rang parmi les homonymes), pas un index
 * positionnel. Insérer un nœud ailleurs dans la page ne décale aucune ref ; une ref ne change
 * que si le rôle ou le nom du nœud change. C'est ce qui rend --snap-diff exploitable.
 */

export interface AXValue { value?: unknown }
export interface AXNode {
  nodeId: string;
  ignored?: boolean;
  role?: AXValue;
  name?: AXValue;
  value?: AXValue;
  properties?: Array<{ name: string; value: AXValue }>;
  childIds?: string[];
  parentId?: string;
  backendDOMNodeId?: number;
}

export interface Snapshot {
  url: string;
  title: string;
  /** Texte rendu (respecte maxBytes). */
  text: string;
  /** ref → backendDOMNodeId, pour tous les nœuds, y compris hors budget. */
  refs: Map<string, number>;
  /** ref → ligne sans indentation (base du diff). */
  entries: Map<string, string>;
  /** Lignes de texte brut, sans ref. */
  texts: string[];
  /** ref → {rôle, nom}, pour la résolution `text:`. */
  meta: Map<string, { role: string; name: string }>;
  /** Nœuds texte émis, pour la résolution `text:` de dernier recours. */
  textNodes: Array<{ text: string; backendNodeId: number }>;
}

export interface SnapshotOptions { url: string; title: string; maxBytes?: number }

export const DEFAULT_MAX_BYTES = 48 * 1024;

/** Conteneurs traversés sans être émis. */
const PASS_THROUGH = new Set(['generic', 'none', 'presentation', 'InlineTextBox', 'LineBreak', 'LabelText', 'paragraph', 'RootWebArea', 'Section', 'div', 'MenuListPopup', 'ListMarker', 'Abbr', 'emphasis', 'strong', 'superscript', 'subscript', 'time', 'mark', 'code']);
/** Conteneurs émis seulement s'ils ont un nom. */
const NAMED_ONLY = new Set(['group', 'region', 'listitem', 'article', 'figure', 'cell', 'row', 'rowgroup', 'blockquote', 'contentinfo', 'banner', 'term', 'definition', 'Iframe', 'image']);
export const INTERACTIVE = new Set(['button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'switch', 'slider', 'spinbutton', 'treeitem']);
const VALUE_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider']);

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

function flags(node: AXNode, role: string): string {
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
  const invalid = p.get('invalid');
  if (invalid !== undefined && invalid !== 'false' && invalid !== false) out.push('[invalid]');
  if (p.get('focused') === true) out.push('[focus]');
  return out.length ? ` ${out.join(' ')}` : '';
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

  const refs = new Map<string, number>();
  const entries = new Map<string, string>();
  const meta = new Map<string, { role: string; name: string }>();
  const texts: string[] = [];
  const textNodes: Array<{ text: string; backendNodeId: number }> = [];
  const out: Array<{ depth: number; line: string }> = [];
  const occurrences = new Map<string, number>();

  const makeRef = (role: string, name: string): string => {
    const key = `${role}\u0000${name}`;
    const k = occurrences.get(key) ?? 0;
    occurrences.set(key, k + 1);
    for (let salt = 0; ; salt++) {
      const ref = `e${(fnv1a(`${key}\u0000${k}\u0000${salt}`) % REF_SPACE).toString(36)}`;
      if (!refs.has(ref)) return ref;
    }
  };

  const walk = (node: AXNode, depth: number, ancestorNames: string[]) => {
    const role = str(node.role);
    const name = norm(str(node.name));
    let emitted = false;
    if (!node.ignored) {
      if (role === 'StaticText') {
        const text = norm(name);
        if (text && !namedTexts.has(text) && !ancestorNames.some((a) => a.includes(text))) {
          texts.push(text);
          if (node.backendDOMNodeId !== undefined) textNodes.push({ text, backendNodeId: node.backendDOMNodeId });
          out.push({ depth, line: quote(text, 100) });
        }
        return; // InlineTextBox enfants : inutiles
      }
      const skip = PASS_THROUGH.has(role) || (NAMED_ONLY.has(role) && !name);
      if (!skip && role) {
        const ref = makeRef(role, name);
        const val = VALUE_ROLES.has(role) ? norm(str(node.value)) : '';
        const line = `${ref}:${role}${level(node)}${name ? ` ${quote(name, 80)}` : ''}${val ? `=${quote(val, 60)}` : ''}${flags(node, role)}`;
        if (node.backendDOMNodeId !== undefined) refs.set(ref, node.backendDOMNodeId);
        entries.set(ref, line);
        meta.set(ref, { role, name });
        out.push({ depth, line });
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
    const nextNames = emitted && name ? [...ancestorNames, name] : ancestorNames;
    for (const id of listOf(node.childIds)) {
      const c = byId.get(id);
      if (c) walk(c, emitted ? depth + 1 : depth, nextNames);
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

  if (root) walk(root, 0, []);

  const header = `page ${quote(opts.title, 80)} ${opts.url}`;
  const lines = [header];
  let bytes = Buffer.byteLength(header);
  const reserve = 64;
  let omitted = 0;
  for (const { depth, line } of out) {
    const l = ' '.repeat(depth) + line;
    const b = Buffer.byteLength(l) + 1;
    if (omitted > 0 || bytes + b > maxBytes - reserve) { omitted++; continue; }
    lines.push(l);
    bytes += b;
  }
  if (omitted > 0) lines.push(`… ${omitted} nœuds omis (budget ${maxBytes} o, ?max= pour augmenter)`);
  return { url: opts.url, title: opts.title, text: lines.join('\n'), refs, entries, texts, meta, textNodes };
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
