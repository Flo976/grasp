/**
 * Audit d'accessibilité (`grasp a11y`, `expect a11y`) : ce qu'un relevé automatique peut affirmer sans
 * interprétation, à partir de l'arbre d'accessibilité de Chrome et du DOM (code fixe, monde isolé).
 *
 * Ce n'est PAS un audit WCAG : ni contrastes, ni clavier, ni ordre de lecture, ni pertinence des textes.
 * Seulement des défauts vérifiables et corrigeables, chacun avec sa ref (quand le nœud en a une) et une
 * correction suggérée.
 */

import type { AXNode } from './snapshot.js';

export const A11Y_KINDS = ['sans-nom', 'image-sans-alt', 'erreur-non-reliee', 'erreur-masquee', 'libelle-orphelin', 'reference-cassee', 'role-invalide', 'titre-saute'] as const;
export type A11yKind = typeof A11Y_KINDS[number];

/** Libellé humain de chaque type (résumé en tête de sortie). */
export const A11Y_LABELS: Record<A11yKind, string> = {
  'sans-nom': 'contrôle sans nom',
  'image-sans-alt': 'image sans alternative',
  'erreur-non-reliee': 'erreur non reliée au champ',
  'erreur-masquee': 'erreur masquée (aria-hidden)',
  'libelle-orphelin': 'libellé orphelin',
  'reference-cassee': 'référence ARIA cassée',
  'role-invalide': 'rôle ARIA invalide',
  'titre-saute': 'niveau de titre sauté',
};

export interface A11yIssue {
  kind: A11yKind;
  /** Ref du snapshot, quand le nœud en a une (résoluble telle quelle par click, fill, snap --scope…). */
  ref?: string;
  /** Ce qui est en cause : ligne du snapshot (avec ref), sinon description DOM (`img[src="…"]`), sinon texte. */
  who: string;
  /** Ce qui ne va pas, en une ligne. */
  detail: string;
  /** Correction suggérée. */
  fix: string;
}

export interface A11yReport {
  url: string;
  title: string;
  /** Problèmes relevés (tous, même au-delà de `max`). */
  total: number;
  counts: Partial<Record<A11yKind, number>>;
  /** Les `max` premiers, dans l'ordre de A11Y_KINDS puis du document. */
  issues: A11yIssue[];
  /** Problèmes non listés (au-delà de `max`). */
  omitted: number;
  /** Rendu texte compact (stdout de `grasp a11y`). */
  text: string;
  /** Rappel de portée (stderr). */
  note: string;
}

/** Problèmes listés par défaut, et au plus. */
export const A11Y_DEFAULT_MAX = 30;
export const A11Y_MAX = 500;

export const A11Y_NOTE = "relevé automatique partiel, pas un audit WCAG : contrastes, clavier, focus, ordre de lecture et pertinence des textes ne sont pas vérifiés ; contenu masqué et iframes non audités";

/** Rôles qui exigent un nom accessible (WAI-ARIA 1.2, « name required ») — hors option, rarement vide à tort. */
const NAME_REQUIRED = new Set(['button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'treeitem']);
const FIELD = new Set(['textbox', 'searchbox', 'combobox', 'listbox', 'slider', 'spinbutton']);
const TOGGLE = new Set(['checkbox', 'radio', 'switch']);

/** Rôles ARIA valides pour un auteur : WAI-ARIA 1.2 (+ 1.3 reconnus par Chrome), DPUB-ARIA, Graphics-ARIA. Les rôles abstraits n'y sont pas. */
export const ARIA_ROLES: readonly string[] = [
  'alert', 'alertdialog', 'application', 'article', 'banner', 'blockquote', 'button', 'caption', 'cell', 'checkbox', 'code',
  'columnheader', 'combobox', 'comment', 'complementary', 'contentinfo', 'definition', 'deletion', 'dialog', 'directory', 'document',
  'emphasis', 'feed', 'figure', 'form', 'generic', 'grid', 'gridcell', 'group', 'heading', 'image', 'img', 'insertion', 'link', 'list',
  'listbox', 'listitem', 'log', 'main', 'mark', 'marquee', 'math', 'menu', 'menubar', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'meter', 'navigation', 'none', 'note', 'option', 'paragraph', 'presentation', 'progressbar', 'radio', 'radiogroup', 'region', 'row',
  'rowgroup', 'rowheader', 'scrollbar', 'search', 'searchbox', 'sectionfooter', 'sectionheader', 'separator', 'slider', 'spinbutton',
  'status', 'strong', 'subscript', 'suggestion', 'superscript', 'switch', 'tab', 'table', 'tablist', 'tabpanel', 'term', 'textbox',
  'time', 'timer', 'toolbar', 'tooltip', 'tree', 'treegrid', 'treeitem',
  'doc-abstract', 'doc-acknowledgments', 'doc-afterword', 'doc-appendix', 'doc-backlink', 'doc-biblioentry', 'doc-bibliography',
  'doc-biblioref', 'doc-chapter', 'doc-colophon', 'doc-conclusion', 'doc-cover', 'doc-credit', 'doc-credits', 'doc-dedication',
  'doc-endnote', 'doc-endnotes', 'doc-epigraph', 'doc-epilogue', 'doc-errata', 'doc-example', 'doc-footnote', 'doc-foreword',
  'doc-glossary', 'doc-glossref', 'doc-index', 'doc-introduction', 'doc-noteref', 'doc-notice', 'doc-pagebreak', 'doc-pagefooter',
  'doc-pageheader', 'doc-pagelist', 'doc-part', 'doc-preface', 'doc-prologue', 'doc-pullquote', 'doc-qna', 'doc-subtitle', 'doc-tip',
  'doc-toc', 'graphics-document', 'graphics-object', 'graphics-symbol',
];
const ROLE_SET = new Set(ARIA_ROLES);
const ABSTRACT = new Set(['command', 'composite', 'input', 'landmark', 'range', 'roletype', 'section', 'sectionhead', 'select', 'structure', 'widget', 'window']);
/** Rôles écrits en français (vus en recette) → rôle ARIA. */
const FR_ROLES: Record<string, string> = {
  bouton: 'button', lien: 'link', titre: 'heading', case: 'checkbox', 'case-a-cocher': 'checkbox', onglet: 'tab', onglets: 'tablist',
  liste: 'list', dialogue: 'dialog', alerte: 'alert', interrupteur: 'switch', image: 'img', navigation: 'navigation', menu: 'menu',
  champ: 'textbox', recherche: 'search', tableau: 'table', ligne: 'row', cellule: 'cell', curseur: 'slider', etat: 'status',
};

function distance(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]!;
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = d[j]!;
      d[j] = Math.min(d[j]! + 1, d[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return d[b.length]!;
}

/** Rôle valide le plus probable pour un rôle invalide (traduction, faute de frappe), sinon undefined. */
export function suggestRole(role: string): string | undefined {
  const r = role.toLowerCase();
  if (FR_ROLES[r] !== undefined) return FR_ROLES[r];
  if (r.length < 4) return undefined;
  let best: string | undefined;
  let bd = 3;
  for (const v of ARIA_ROLES) {
    if (v.startsWith('doc-') || v.startsWith('graphics-')) continue;
    const dd = distance(r, v);
    if (dd < bd) { bd = dd; best = v; }
  }
  return bd <= 2 ? best : undefined;
}

/** Un attribut role est-il valide ? (liste de jetons : le premier valide est retenu, comme le fait le navigateur) */
export function roleValid(value: string): boolean {
  const tokens = value.toLowerCase().split(/\s+/).filter(Boolean);
  return tokens.some((t) => ROLE_SET.has(t));
}

const listOf = <T>(xs: T[] | undefined): T[] => (xs === undefined ? [] : xs);
const str = (v: { value?: unknown } | undefined): string => (v?.value === undefined || v.value === null ? '' : String(v.value));
const norm = (s: string) => s.replace(/[​-‍⁠﻿­]/g, '').replace(/\s+/g, ' ').trim();

/** Problème tiré de l'arbre, avant résolution de sa ref (backendId) ou de sa description DOM. */
export interface RawIssue { kind: A11yKind; backendId?: number; role?: string; who?: string; detail: string; fix: string }

function namelessFix(role: string): string {
  if (role === 'link') return 'texte du lien, ou aria-label (icône seule)';
  if (role === 'button') return 'texte visible, ou aria-label (bouton icône)';
  if (FIELD.has(role)) return '<label for=id>, ou aria-labelledby vers le libellé visible';
  if (TOGGLE.has(role)) return '<label> englobant, <label for=id> ou aria-labelledby vers le texte voisin';
  return 'aria-label, ou aria-labelledby vers le texte visible';
}

/**
 * Problèmes lisibles dans l'arbre d'accessibilité : contrôles sans nom accessible, images sans alternative,
 * niveaux de titre sautés. `inScope(n)` : le nœud est-il dans la zone auditée (tout l'arbre est parcouru pour
 * l'ordre des titres). Parcours itératif en ordre du document (pile explicite).
 */
export function axIssues(nodes: AXNode[], inScope: (n: AXNode) => boolean): RawIssue[] {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const root = nodes.find((n) => n.parentId === undefined || !byId.has(n.parentId)) ?? nodes[0];
  const out: RawIssue[] = [];
  if (root === undefined) return out;
  let prevLevel = 0;
  let prevName = '';
  const stack: AXNode[] = [root];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (seen.has(n.nodeId)) continue;
    seen.add(n.nodeId);
    const kids = listOf(n.childIds).map((id) => byId.get(id)).filter((c): c is AXNode => c !== undefined);
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
    if (n.ignored === true) continue;
    const role = str(n.role);
    const name = norm(str(n.name));
    const here = inScope(n);
    if (NAME_REQUIRED.has(role) && name === '' && here) {
      out.push({ kind: 'sans-nom', ...(n.backendDOMNodeId !== undefined ? { backendId: n.backendDOMNodeId } : {}), role, detail: 'aucun nom accessible', fix: namelessFix(role) });
    } else if ((role === 'image' || role === 'img') && name === '' && here) {
      out.push({ kind: 'image-sans-alt', ...(n.backendDOMNodeId !== undefined ? { backendId: n.backendDOMNodeId } : {}), role, detail: 'aucune alternative textuelle', fix: 'alt="ce que montre l\'image" (alt="" si décorative ; role=img : aria-label)' });
    } else if (role === 'heading') {
      const l = n.properties?.find((p) => p.name === 'level')?.value.value;
      if (typeof l === 'number') {
        if (prevLevel > 0 && l > prevLevel + 1 && here) {
          out.push({ kind: 'titre-saute', ...(n.backendDOMNodeId !== undefined ? { backendId: n.backendDOMNodeId } : {}), role, detail: `h${l} après h${prevLevel}${prevName ? ` « ${prevName.length > 40 ? `${prevName.slice(0, 39)}…` : prevName} »` : ''}`, fix: `h${prevLevel + 1}, ou titre intermédiaire manquant (la taille se règle en CSS)` });
        }
        prevLevel = l;
        prevName = name;
      }
    }
  }
  return out;
}

/** Sous-arbre de la zone (backendDOMNodeId de sa racine) : ensemble des nodeId ; undefined si la racine n'est pas dans l'arbre. */
export function scopeNodes(nodes: AXNode[], scopeBackendId: number): Set<string> | undefined {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const start = nodes.find((n) => n.backendDOMNodeId === scopeBackendId);
  if (start === undefined) return undefined;
  const out = new Set<string>();
  const stack = [start];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (out.has(n.nodeId)) continue;
    out.add(n.nodeId);
    for (const id of listOf(n.childIds)) { const c = byId.get(id); if (c !== undefined) stack.push(c); }
  }
  return out;
}

/** Problème DOM tel que le renvoie A11Y_DOM_FN (meta.items). */
export interface DomItem { k: 'libelle-orphelin' | 'reference-cassee' | 'role-invalide'; i: number; d: string; a?: string; v?: string; m?: string[] }

/** Problème DOM → problème à rapporter (détail, correction). */
export function domIssue(it: DomItem, backendId: number | undefined): RawIssue {
  const base = { ...(backendId !== undefined ? { backendId } : {}), who: it.d };
  switch (it.k) {
    case 'libelle-orphelin':
      return it.a === 'non-champ'
        ? { kind: it.k, ...base, detail: `for vise ${it.m?.[0] ?? '?'}, qui n'est pas un champ`, fix: 'for = id d\'un champ (input, select, textarea) ; contrôle ARIA : aria-labelledby' }
        : { kind: it.k, ...base, detail: `aucun élément d'id « ${it.v ?? ''} » : ne nomme aucun champ`, fix: `for = id réel du champ (ou id="${it.v ?? ''}" sur le champ)` };
    case 'reference-cassee':
      return { kind: it.k, ...base, detail: `${it.a ?? 'aria-*'} → ${(it.m?.length ?? 0) > 1 ? 'ids absents' : 'id absent'} : ${listOf(it.m).map((x) => `« ${x} »`).join(', ')}`, fix: 'id existant, ou retirer la référence' };
    case 'role-invalide': {
      const v = it.v ?? '';
      const tokens = v.toLowerCase().split(/\s+/).filter(Boolean);
      const abstract = tokens.find((t) => ABSTRACT.has(t));
      const sug = tokens.map(suggestRole).find((x) => x !== undefined);
      return { kind: it.k, ...base, detail: abstract !== undefined ? `« ${abstract} » : rôle abstrait, interdit aux auteurs, ignoré` : `role="${v}" inconnu, ignoré par le navigateur`, fix: sug !== undefined ? `role="${sug}" (ou l'élément natif)` : 'rôle ARIA valide, élément natif, ou retirer role' };
    }
  }
}

/** Description DOM courte d'un élément (code de page, réutilisé par A11Y_DOM_FN et A11Y_DESC_FN). */
const DESC_JS = `const desc = (el) => {
    const short = (v, n) => { v = String(v || '').replace(/\\s+/g, ' ').trim(); if (/^data:/i.test(v)) return v.slice(0, v.indexOf(',') > 0 ? Math.min(v.indexOf(','), 40) : 40) + ',…'; return v.length > n ? v.slice(0, n - 1) + '…' : v; };
    const t = el.localName;
    let s = t;
    if (el.id) s += '#' + short(el.id, 40);
    const key = t === 'img' ? 'src' : t === 'a' ? 'href' : t === 'label' ? 'for' : t === 'input' ? 'type' : null;
    if (key && el.hasAttribute(key)) s += '[' + key + '="' + short(el.getAttribute(key), 60) + '"]';
    if (el.hasAttribute('role')) s += '[role="' + short(el.getAttribute('role'), 40) + '"]';
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\\s+/)[0] : '';
    if (!el.id && !key && cls) s += '.' + short(cls, 30);
    const txt = short(el.innerText || el.textContent || el.getAttribute('aria-label') || '', 40);
    return txt ? s + ' "' + txt.replace(/"/g, '\\\\"') + '"' : s;
  };`;

/** Description DOM d'un nœud (this) : pour les problèmes de l'arbre sans ref (image sans alt…). */
export const A11Y_DESC_FN = `function () {
  ${DESC_JS}
  const el = this.nodeType === 1 ? this : this.parentElement;
  return el ? desc(el) : '';
}`;

/**
 * Problèmes lisibles seulement dans le DOM, sous `root` (document ou élément), éléments affichés seulement :
 * libellés `<label for>` qui ne désignent aucun champ, références ARIA (aria-labelledby, aria-describedby,
 * aria-errormessage) vers des id absents, attributs role sans aucun jeton valide. Code fixe, monde isolé,
 * aucune modification de la page. Retour : { meta (JSON : items), els (éléments, indexés par items[].i) }.
 */
export const A11Y_DOM_FN = `function (root) {
  const scope = root.nodeType === 9 ? root.documentElement : (root.nodeType === 1 ? root : root.parentElement);
  ${DESC_JS}
  const ROLES = new Set(${JSON.stringify(ARIA_ROLES)});
  const shown = (el) => {
    if (!el || !el.isConnected) return false;
    if (typeof el.checkVisibility === 'function') return el.checkVisibility({ visibilityProperty: true });
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  };
  const byId = (el, id) => { const r = el.getRootNode(); return (r && typeof r.getElementById === 'function' ? r.getElementById(id) : null) || el.ownerDocument.getElementById(id); };
  const LABELABLE = new Set(['input', 'select', 'textarea', 'button', 'meter', 'output', 'progress']);
  const labelable = (el) => (LABELABLE.has(el.localName) && !(el.localName === 'input' && el.type === 'hidden')) || (el.constructor && el.constructor.formAssociated === true);
  const items = [];
  const els = [];
  const push = (el, it) => { if (els.length >= 300) return; it.i = els.length; it.d = desc(el); els.push(el); items.push(it); };
  const all = (sel) => [...(scope.matches && scope.matches(sel) ? [scope] : []), ...scope.querySelectorAll(sel)];
  for (const l of all('label[for]').slice(0, 2000)) {
    if (!shown(l)) continue;
    const id = l.getAttribute('for');
    if (!id) continue;
    const t = byId(l, id);
    if (!t) push(l, { k: 'libelle-orphelin', v: id });
    else if (!labelable(t)) push(l, { k: 'libelle-orphelin', a: 'non-champ', v: id, m: [desc(t)] });
  }
  for (const el of all('[aria-labelledby],[aria-describedby],[aria-errormessage]').slice(0, 3000)) {
    if (!shown(el)) continue;
    for (const a of ['aria-labelledby', 'aria-describedby', 'aria-errormessage']) {
      const v = el.getAttribute(a);
      if (v === null) continue;
      const missing = v.split(/\\s+/).filter(Boolean).filter((id) => !byId(el, id));
      if (missing.length) push(el, { k: 'reference-cassee', a, m: missing.slice(0, 5) });
    }
  }
  for (const el of all('[role]').slice(0, 5000)) {
    const v = (el.getAttribute('role') || '').trim();
    if (!v) continue;
    if (v.toLowerCase().split(/\\s+/).some((t) => ROLES.has(t))) continue;
    if (!shown(el)) continue;
    push(el, { k: 'role-invalide', v: v.slice(0, 60) });
  }
  return { meta: JSON.stringify({ items }), els };
}`;

/** Rendu compact : une ligne de titre, une ligne de comptes, une ligne par problème, ligne de coupure. */
export function renderA11y(r: { url: string; title: string; total: number; counts: Partial<Record<A11yKind, number>>; issues: A11yIssue[]; omitted: number }, scope?: string): string {
  const where = scope !== undefined ? ` dans ${scope}` : '';
  const head = `a11y : ${r.total === 0 ? `aucun problème relevé${where}` : `${r.total} problème${r.total > 1 ? 's' : ''}${where}`} — page "${r.title.length > 80 ? `${r.title.slice(0, 79)}…` : r.title}" ${r.url}`;
  if (r.total === 0) return head;
  const L = [head, `  ${A11Y_KINDS.filter((k) => (r.counts[k] ?? 0) > 0).map((k) => `${A11Y_LABELS[k]} : ${r.counts[k]}`).join(' · ')}`];
  for (const i of r.issues) L.push(`${i.kind} ${i.who} — ${i.detail} → ${i.fix}`);
  if (r.omitted > 0) L.push(`… ${r.omitted} problème${r.omitted > 1 ? 's' : ''} non listé${r.omitted > 1 ? 's' : ''} — affinez avec --max N / --scope <ref|css>`);
  return L.join('\n');
}
