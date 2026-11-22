/**
 * Snapshot du moteur WebKit : l'arbre ARIA de Playwright (`page.ariaSnapshot({ mode: 'ai' })`, YAML à refs
 * `[ref=e12]` ; `f1e3` : élément d'un cadre, ou de la page elle-même après une navigation — le préfixe est celui
 * du cadre tel que Playwright le numérote) rendu dans le format de Grasp — une ligne par nœud
 * `<ref>:<rôle>[niveau] "<nom>"=<valeur> [états]`, conteneurs anonymes traversés. Fonctions pures, testées à part.
 *
 * Les refs sont celles de Playwright : valables jusqu'au snapshot suivant du même document (un élément renommé ou
 * re-rendu change de ref). Elles ne sont PAS les refs à hash du moteur Chrome (`e5k2`) et ne se transportent pas
 * d'un moteur à l'autre.
 */

export interface WkNode {
  role: string;
  name: string;
  ref?: string;
  /** Texte en ligne après « : » (valeur d'un champ, texte d'un paragraphe). */
  text?: string;
  attrs: Map<string, string | true>;
  children: WkNode[];
}

/** Ref du moteur WebKit : `e12`, ou `f1e3` (élément du cadre f1). */
export const WK_REF_RE = /^(?:f\d+)?e\d+$/;

export const WK_INTERACTIVE: ReadonlySet<string> = new Set(['button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'switch', 'slider', 'spinbutton', 'treeitem']);
const LANDMARKS: ReadonlySet<string> = new Set(['banner', 'navigation', 'main', 'contentinfo', 'complementary', 'region', 'form', 'search', 'dialog', 'alertdialog', 'table', 'heading', 'iframe']);
/** Conteneurs traversés sans être émis (leurs enfants remontent d'un cran), comme l'élagage du moteur Chrome. */
const PASS_THROUGH: ReadonlySet<string> = new Set(['generic', 'none', 'presentation', 'paragraph', 'group', 'list', 'rowgroup', 'emphasis', 'strong']);

/** Clé YAML entre apostrophes (`'button "a: b" [ref=e3]'`, apostrophe doublée) → contenu et reste de la ligne. */
function unquoteKey(s: string): { key: string; rest: string } | undefined {
  if (!s.startsWith('\'')) return undefined;
  let out = '';
  for (let i = 1; i < s.length; i++) {
    if (s[i] === '\'') {
      if (s[i + 1] === '\'') { out += '\''; i++; continue; }
      return { key: out, rest: s.slice(i + 1) };
    }
    out += s[i];
  }
  return undefined;
}

function unquoteValue(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) { try { return JSON.parse(t) as string; } catch { return t.slice(1, -1); } }
  if (t.length >= 2 && t.startsWith('\'') && t.endsWith('\'')) return t.slice(1, -1).replace(/''/g, '\'');
  return t;
}

/** `button "Nom" [ref=e3] [disabled]` → rôle, nom, attributs. */
function parseKey(key: string): { role: string; name: string; attrs: Map<string, string | true> } {
  const attrs = new Map<string, string | true>();
  let rest = key.trim();
  const rm = /^[^\s"[]+/.exec(rest);
  const role = rm !== null ? rm[0] : '';
  rest = rest.slice(role.length).trimStart();
  let name = '';
  if (rest.startsWith('"')) {
    // Nom entre guillemets, échappements JSON (\" \\) : fin au premier guillemet non échappé.
    let i = 1;
    while (i < rest.length && rest[i] !== '"') i += rest[i] === '\\' ? 2 : 1;
    const raw = rest.slice(0, i + 1);
    try { name = JSON.parse(raw) as string; } catch { name = raw.slice(1, -1); }
    rest = rest.slice(i + 1).trimStart();
  }
  for (const m of rest.matchAll(/\[([^\]=]+)(?:=([^\]]*))?\]/g)) attrs.set(m[1]!, m[2] !== undefined ? m[2] : true);
  return { role, name, attrs };
}

/** YAML de Playwright → arbre. Lignes de propriété (`- /url: …`) ignorées ; ligne illisible : gardée comme texte. */
export function parseAria(yaml: string): WkNode[] {
  const root: WkNode = { role: '', name: '', attrs: new Map(), children: [] };
  const stack: Array<{ depth: number; node: WkNode }> = [{ depth: -1, node: root }];
  for (const line of yaml.split('\n')) {
    const m = /^(\s*)- (.*)$/.exec(line);
    if (m === null) continue;
    const depth = m[1]!.length;
    let content = m[2]!;
    let key: string;
    let tail: string | undefined;
    const q = unquoteKey(content);
    if (q !== undefined) {
      key = q.key;
      content = q.rest;
      tail = content.startsWith(':') ? content.slice(1) : undefined;
    } else {
      // Fin de la clé : premier « : » suivi d'une espace ou de la fin, hors guillemets.
      let inQ = false;
      let cut = -1;
      for (let i = 0; i < content.length; i++) {
        const c = content[i];
        if (c === '\\' && inQ) { i++; continue; }
        if (c === '"') inQ = !inQ;
        else if (c === ':' && !inQ && (i === content.length - 1 || content[i + 1] === ' ')) { cut = i; break; }
      }
      key = cut === -1 ? content : content.slice(0, cut);
      tail = cut === -1 ? undefined : content.slice(cut + 1);
    }
    if (key.startsWith('/')) continue;
    const { role, name, attrs } = parseKey(key);
    const node: WkNode = { role: role === '' ? 'text' : role, name, attrs, children: [] };
    const ref = attrs.get('ref');
    if (typeof ref === 'string') node.ref = ref;
    if (tail !== undefined && tail.trim() !== '') node.text = unquoteValue(tail);
    while (stack.length > 1 && stack[stack.length - 1]!.depth >= depth) stack.pop();
    stack[stack.length - 1]!.node.children.push(node);
    stack.push({ depth, node });
  }
  return root.children;
}

const cut = (s: string, max: number) => (max > 0 && s.length > max ? `${s.slice(0, max - 1)}…` : s);
const quote = (s: string) => `"${s.replace(/\s+/g, ' ').trim().replace(/"/g, '\\"')}"`;

const STATES: ReadonlyArray<[string, (v: string | true) => string | undefined]> = [
  ['checked', (v) => (v === 'mixed' ? '[~]' : v === 'false' ? '[ ]' : '[x]')],
  ['pressed', (v) => (v === 'false' ? undefined : '[pressed]')],
  ['expanded', (v) => (v === 'false' ? '[-]' : '[+]')],
  ['disabled', () => '[disabled]'],
  ['selected', () => '[selected]'],
  ['active', () => '[focus]'],
];

export interface WkRenderOptions {
  nameMax?: number;
  /**
   * Boîtes `@x,y LxH` (px CSS) ; `scroll` : défilement de la page, ajouté pour des coordonnées de document
   * (approximatif pour un élément d'iframe : sa boîte est relative au viewport de son cadre).
   */
  boxes?: boolean;
  scroll?: { x: number; y: number };
  mode?: 'outline' | 'interactive';
  /** find : seules les lignes dont le nom, le texte ou la valeur correspondent (avec leurs conteneurs). */
  find?: { test: (s: string) => boolean; roles?: readonly string[]; limit?: number };
}

export interface WkLine { ref?: string; role: string; name: string; text: string; depth: number }

function lineOf(n: WkNode, o: WkRenderOptions): string {
  const nameMax = o.nameMax ?? 80;
  const level = n.attrs.get('level');
  const isField = n.role === 'textbox' || n.role === 'searchbox' || n.role === 'combobox' || n.role === 'spinbutton' || n.role === 'slider';
  let s = `${n.ref !== undefined ? `${n.ref}:` : ''}${n.role}${typeof level === 'string' ? `[${level}]` : ''}`;
  const name = n.name !== '' ? n.name : !isField && n.text !== undefined ? n.text : '';
  if (name !== '') s += ` ${quote(cut(name, n.role === 'text' ? Math.max(nameMax, 100) : nameMax))}`;
  if (isField && n.text !== undefined) s += `=${quote(cut(n.text, nameMax))}`;
  else if (n.name !== '' && n.text !== undefined && n.text !== n.name) s += ` : ${quote(cut(n.text, nameMax))}`;
  for (const [k, f] of STATES) { const v = n.attrs.get(k); if (v !== undefined) { const t = f(v); if (t !== undefined) s += ` ${t}`; } }
  if (o.boxes === true) {
    const b = n.attrs.get('box');
    if (typeof b === 'string') {
      const [x, y, w, h] = b.split(',').map(Number) as [number, number, number, number];
      s += ` @${Math.round(x + (o.scroll?.x ?? 0))},${Math.round(y + (o.scroll?.y ?? 0))} ${Math.round(w)}x${Math.round(h)}`;
    }
  }
  return s;
}

/** Lignes rendues, avec leur profondeur (après élagage). */
export function flatten(nodes: readonly WkNode[], o: WkRenderOptions = {}): WkLine[] {
  const out: WkLine[] = [];
  const walk = (list: readonly WkNode[], depth: number): void => {
    for (const n of list) {
      const anonymous = PASS_THROUGH.has(n.role) && n.name === '' && n.text === undefined;
      if (anonymous) { walk(n.children, depth); continue; }
      out.push({ ...(n.ref !== undefined ? { ref: n.ref } : {}), role: n.role, name: n.name !== '' ? n.name : n.text ?? '', text: lineOf(n, o), depth });
      walk(n.children, depth + 1);
    }
  };
  walk(nodes, 0);
  return out;
}

/** Garde les lignes retenues et leurs conteneurs (ancêtres), dans l'ordre du document. */
function keepWithAncestors(lines: readonly WkLine[], keep: (l: WkLine) => boolean, limit?: number): WkLine[] {
  const kept = new Set<number>();
  let hits = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!keep(lines[i]!)) continue;
    if (limit !== undefined && hits >= limit) break;
    hits++;
    kept.add(i);
    let d = lines[i]!.depth;
    for (let j = i - 1; j >= 0 && d > 0; j--) if (lines[j]!.depth < d) { kept.add(j); d = lines[j]!.depth; }
  }
  return lines.filter((_, i) => kept.has(i));
}

/** Arbre → texte de `grasp snap` (une ligne par nœud, indentation de deux espaces). */
export function renderAria(yaml: string, o: WkRenderOptions = {}): string {
  let lines = flatten(parseAria(yaml), o);
  if (o.find !== undefined) {
    const f = o.find;
    lines = keepWithAncestors(lines, (l) => (f.roles === undefined || f.roles.includes(l.role)) && f.test(l.text), f.limit ?? 30);
  } else if (o.mode === 'interactive') lines = keepWithAncestors(lines, (l) => WK_INTERACTIVE.has(l.role));
  else if (o.mode === 'outline') lines = lines.filter((l) => LANDMARKS.has(l.role));
  return lines.map((l) => `${'  '.repeat(l.depth)}${l.text}`).join('\n');
}

/**
 * Diff de deux snapshots rendus : `+` ligne apparue, `-` disparue, `~` modifiée (même ref, texte différent).
 * Les lignes sans ref (texte) sont comparées comme un multi-ensemble.
 */
export function diffAria(before: string, after: string): string {
  const parse = (t: string) => t.split('\n').map((l) => l.trim()).filter((l) => l !== '').map((l) => { const m = /^((?:f\d+)?e\d+):/.exec(l); return { ref: m?.[1], line: l }; });
  const a = parse(before);
  const b = parse(after);
  const aRef = new Map(a.filter((x) => x.ref !== undefined).map((x) => [x.ref!, x.line]));
  const bRef = new Map(b.filter((x) => x.ref !== undefined).map((x) => [x.ref!, x.line]));
  const count = (list: typeof a) => { const m = new Map<string, number>(); for (const x of list) if (x.ref === undefined) m.set(x.line, (m.get(x.line) ?? 0) + 1); return m; };
  const aTxt = count(a);
  const bTxt = count(b);
  const out: string[] = [];
  const gone = new Map<string, number>();
  for (const x of a) {
    if (x.ref !== undefined) { if (!bRef.has(x.ref)) out.push(`- ${x.line}`); continue; }
    const extra = (aTxt.get(x.line) ?? 0) - (bTxt.get(x.line) ?? 0) - (gone.get(x.line) ?? 0);
    if (extra > 0) { out.push(`- ${x.line}`); gone.set(x.line, (gone.get(x.line) ?? 0) + 1); }
  }
  const come = new Map<string, number>();
  for (const x of b) {
    if (x.ref !== undefined) {
      const prev = aRef.get(x.ref);
      if (prev === undefined) out.push(`+ ${x.line}`);
      else if (prev !== x.line) out.push(`~ ${x.line}`);
      continue;
    }
    const extra = (bTxt.get(x.line) ?? 0) - (aTxt.get(x.line) ?? 0) - (come.get(x.line) ?? 0);
    if (extra > 0) { out.push(`+ ${x.line}`); come.set(x.line, (come.get(x.line) ?? 0) + 1); }
  }
  return out.length === 0 ? '(aucun changement)' : out.join('\n');
}

export interface WkCandidate { ref: string; role: string; name: string }

/**
 * `text:Libellé` : mêmes paliers que le moteur Chrome — nom égal sur un contrôle, nom égal, égal sans casse,
 * contenu dans un contrôle. Un seul candidat au premier palier non vide : sa ref ; plusieurs : ambigu.
 */
export function matchText(yaml: string, t: string): { ref?: string; candidates: WkCandidate[] } {
  const all = flatten(parseAria(yaml), { nameMax: 0 }).filter((l): l is WkLine & { ref: string } => l.ref !== undefined && l.name !== '');
  const lower = t.toLowerCase();
  const tiers = [
    all.filter((l) => l.name === t && WK_INTERACTIVE.has(l.role)),
    all.filter((l) => l.name === t),
    all.filter((l) => l.name.toLowerCase() === lower),
    all.filter((l) => WK_INTERACTIVE.has(l.role) && l.name.toLowerCase().includes(lower)),
  ];
  for (const tier of tiers) {
    if (tier.length === 0) continue;
    const candidates = tier.map((l) => ({ ref: l.ref, role: l.role, name: l.name }));
    return tier.length === 1 ? { ref: tier[0]!.ref, candidates } : { candidates };
  }
  return { candidates: [] };
}
