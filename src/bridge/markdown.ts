/**
 * `text --markdown` : conversion DOM → Markdown du contenu visible, en code FIXE de Grasp exécuté dans le
 * monde isolé `grasp-lecture` (autorisé avec allowEval=false : aucune expression de l'agent n'y entre).
 *
 * - Visibilité : même critère que `text` (innerText) — sous-arbre omis si `display: none` ; enfants omis sous
 *   `content-visibility: hidden` et dans un `<details>` fermé (sauf le `<summary>`) ; texte omis si
 *   `visibility` ≠ `visible` ; racine d'une zone non rendue (`checkVisibility()`, ancêtres compris) : vide.
 *   Pas de `checkVisibility()` par élément : il remonte tous les ancêtres (quadratique sur un DOM profond). `script`, `style`, `noscript`, `template`, contrôles de saisie, SVG, canvas et
 *   iframes ne produisent rien. Les racines fantômes ouvertes sont parcourues (arbre aplati, comme le rendu).
 * - Blocs : par la balise (titres, listes, citations, `pre`, tableaux) et sinon par le `display` calculé
 *   (un élément non `inline*` est un bloc, comme pour innerText).
 * - Parcours ITÉRATIF (pile explicite) : un DOM de plusieurs milliers de niveaux ne fait pas déborder la pile.
 * - Le texte n'est pas échappé (sortie destinée à un agent, pas à un moteur de rendu), sauf `|` dans une
 *   cellule de tableau.
 *
 * Écrit sans gabarit `${}` ni accent grave littéral (String.raw) : `\x60` est l'accent grave.
 */
export const MARKDOWN_FN = String.raw`function (root) {
  var BT = '\x60';
  var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, HEAD: 1, TITLE: 1, META: 1, LINK: 1, INPUT: 1, SELECT: 1, TEXTAREA: 1, SVG: 1, svg: 1, CANVAS: 1, IFRAME: 1, FRAME: 1, OBJECT: 1, EMBED: 1, VIDEO: 1, AUDIO: 1, MAP: 1 };
  var INLINE_DISPLAY = { 'inline': 1, 'inline-block': 1, 'inline-flex': 1, 'inline-grid': 1, 'inline-table': 1, 'contents': 1, 'ruby': 1, 'ruby-text': 1, 'ruby-base': 1, 'ruby-text-container': 1, 'ruby-base-container': 1 };
  var out = [];          // lignes émises
  var cur = '';          // texte en ligne du bloc en cours
  var serial = 0;        // incrémenté à chaque bloc émis (une balise en ligne qui chevauche un bloc n'est pas balisée)
  var containers = [];   // { kind: 'quote' | 'list' | 'li', ordered, n, marker, pending }
  var tables = [];       // { rows: [[cellule]], caption }
  var inlineOnly = 0;    // > 0 : dans un titre, un lien, une cellule, un pre — les blocs y deviennent des espaces
  var preDepth = 0;
  var lastTight = false;
  var lastContainers = [];
  var styleOf = function (el) { var v = el.ownerDocument && el.ownerDocument.defaultView; return v ? v.getComputedStyle(el) : null; };
  var lastParent = null, lastParentVisible = true;
  var textVisible = function (t) {
    var p = t.parentElement;
    if (!p) return true;
    if (p !== lastParent) { lastParent = p; var s = styleOf(p); lastParentVisible = !s || s.visibility === 'visible'; }
    return lastParentVisible;
  };
  var prefix = function (markers) {
    var s = '';
    for (var i = 0; i < containers.length; i++) {
      var c = containers[i];
      if (c.kind === 'quote') s += '> ';
      else if (c.kind === 'li') s += markers && c.pending ? c.marker : ' '.repeat(c.marker.length);
    }
    return s;
  };
  var emit = function (lines) {
    var tight = false;
    for (var i = containers.length - 1; i >= 0; i--) { if (containers[i].kind === 'li') { tight = true; break; } if (containers[i].kind === 'quote') break; }
    if (out.length > 0 && !(tight && lastTight)) {
      // Ligne vide : seulement les citations ouvertes avant ET après elle (« > » d'une citation qui commence n'y va pas).
      var bl = '';
      for (var q = 0; q < containers.length && q < lastContainers.length && containers[q] === lastContainers[q]; q++) if (containers[q].kind === 'quote') bl += '>';
      out.push(bl.replace(/>(?=>)/g, '> '));
    }
    for (var j = 0; j < lines.length; j++) {
      out.push((prefix(true) + lines[j]).replace(/\s+$/, ''));
      for (var k = 0; k < containers.length; k++) if (containers[k].kind === 'li') containers[k].pending = false;
    }
    lastTight = tight;
    lastContainers = containers.slice();
    serial++;
  };
  var flush = function () {
    var t = cur; cur = '';
    if (t === '') return;
    var lines = t.split('\n').map(function (l) { return l.replace(/[ \t]+/g, ' ').trim(); }).filter(function (l) { return l !== ''; });
    if (lines.length > 0) emit(lines);
  };
  var sep = function () {
    if (preDepth > 0) { if (cur !== '' && cur[cur.length - 1] !== '\n') cur += '\n'; return; }
    if (cur !== '' && !/\s$/.test(cur)) cur += ' ';
  };
  var addText = function (s) {
    if (preDepth > 0) { cur += s; return; }
    s = s.replace(/[ \t\n\r\f]+/g, ' ');
    if (s[0] === ' ' && (cur === '' || /\s$/.test(cur))) s = s.slice(1);
    cur += s;
  };
  // Balise en ligne autour du texte ajouté depuis start ; les espaces de bord restent à l'extérieur.
  var wrap = function (start, ser, open, close) {
    if (ser !== serial || preDepth > 0) return false;
    var inner = cur.slice(start);
    var m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner);
    if (!m || m[2] === '') return false;
    cur = cur.slice(0, start) + m[1] + open + m[2] + close + m[3];
    return true;
  };
  var oneLine = function (s) { return s.replace(/\s+/g, ' ').trim(); };
  var children = function (n) {
    if (n.nodeType === 1) {
      if (n.shadowRoot) return n.shadowRoot.childNodes;
      if (n.nodeName === 'SLOT' && typeof n.assignedNodes === 'function') { var a = n.assignedNodes({ flatten: true }); if (a.length > 0) return a; }
    }
    return n.childNodes;
  };
  var langOf = function (el) {
    var cands = [el];
    var c = el.querySelector && el.querySelector('code');
    if (c) cands.push(c);
    for (var i = 0; i < cands.length; i++) {
      var m = /(?:^|\s)(?:language|lang)-([\w+#.-]+)/.exec(cands[i].className || '');
      if (m) return m[1];
    }
    return '';
  };
  var absUrl = function (u) {
    if (!u) return '';
    // Image en ligne : seul le type est gardé (une data: URL de 50 Ko n'apprend rien à l'agent).
    if (/^data:/i.test(u) && u.length > 80) { var c = u.indexOf(','); return u.slice(0, c > 0 && c < 60 ? c + 1 : 30) + '…'; }
    return u;
  };

  var enter = function (el, e) {
    var tag = el.nodeName;
    var st = e.style;
    var display = st ? st.display : 'block';
    if (tag === 'BR') { if (preDepth > 0) cur += '\n'; else if (inlineOnly > 0) sep(); else cur += '\n'; return false; }
    if (tag === 'HR') { if (inlineOnly > 0) { sep(); return false; } flush(); emit(['---']); return false; }
    if (tag === 'IMG') {
      if (preDepth > 0) return false;
      var src = absUrl(el.currentSrc || el.src || '');
      if (src === '') return false;
      if (cur !== '' && !/\s$/.test(cur) && cur[cur.length - 1] !== '[') cur += ' ';
      cur += '![' + oneLine(el.alt || '') + '](' + src + ')';
      return false;
    }
    if (inlineOnly === 0) {
      if (/^H[1-6]$/.test(tag)) { flush(); e.heading = Number(tag[1]); inlineOnly++; return true; }
      if (tag === 'PRE') { flush(); e.pre = langOf(el); preDepth++; inlineOnly++; return true; }
      if (tag === 'UL' || tag === 'OL' || tag === 'MENU') {
        flush();
        var start = tag === 'OL' && el.hasAttribute('start') ? parseInt(el.getAttribute('start'), 10) : 1;
        // Liste qui n'est pas dans un élément de liste : séparée de la précédente par une ligne vide.
        if (!containers.some(function (c) { return c.kind === 'li'; })) lastTight = false;
        containers.push({ kind: 'list', ordered: tag === 'OL', n: isNaN(start) ? 1 : start });
        e.container = true; return true;
      }
      if (tag === 'LI') {
        flush();
        var top = containers[containers.length - 1];
        var marker = '- ';
        if (top && top.kind === 'list' && top.ordered) { marker = top.n + '. '; top.n++; }
        containers.push({ kind: 'li', marker: marker, pending: true });
        e.container = true; return true;
      }
      if (tag === 'BLOCKQUOTE') { flush(); containers.push({ kind: 'quote' }); e.container = true; return true; }
      if (tag === 'TABLE') { flush(); tables.push({ rows: [], caption: '' }); e.table = true; return true; }
      if (tables.length > 0) {
        var tb = tables[tables.length - 1];
        if (tag === 'TR') { tb.rows.push([]); cur = ''; return true; }
        if (tag === 'TD' || tag === 'TH') { if (tb.rows.length === 0) tb.rows.push([]); cur = ''; e.cell = true; inlineOnly++; return true; }
        if (tag === 'CAPTION') { cur = ''; e.caption = true; inlineOnly++; return true; }
        if (tag === 'THEAD' || tag === 'TBODY' || tag === 'TFOOT' || tag === 'COLGROUP') return true;
      }
    }
    if (tag === 'A' && el.hasAttribute('href')) {
      var href = el.href || '';
      if (typeof href !== 'string') href = el.getAttribute('href') || '';
      if (!/^javascript:/i.test(href) && href !== '') {
        e.link = { start: cur.length, ser: serial, href: href, label: el.getAttribute('aria-label') || el.getAttribute('title') || '' };
        inlineOnly++;
        return true;
      }
    }
    if (tag === 'STRONG' || tag === 'B') { e.wrap = ['**', '**']; e.start = cur.length; e.ser = serial; return true; }
    if (tag === 'EM' || tag === 'I' || tag === 'CITE' || tag === 'DFN') { e.wrap = ['*', '*']; e.start = cur.length; e.ser = serial; return true; }
    if (tag === 'DEL' || tag === 'S' || tag === 'STRIKE') { e.wrap = ['~~', '~~']; e.start = cur.length; e.ser = serial; return true; }
    if (tag === 'CODE' || tag === 'KBD' || tag === 'SAMP' || tag === 'TT') { if (preDepth === 0) { e.code = true; e.start = cur.length; e.ser = serial; } return true; }
    if (!INLINE_DISPLAY[display]) { if (inlineOnly > 0) sep(); else flush(); e.block = true; }
    return true;
  };

  var exit = function (el, e) {
    if (e.heading) {
      inlineOnly--;
      var h = oneLine(cur); cur = '';
      if (h !== '') emit(['#'.repeat(e.heading) + ' ' + h]);
      return;
    }
    if (e.pre !== undefined) {
      preDepth--; inlineOnly--;
      var code = cur.replace(/^\n/, '').replace(/\s+$/, ''); cur = '';
      if (code === '') return;
      var fence = BT + BT + BT;
      while (code.indexOf(fence) >= 0) fence += BT;
      emit([fence + e.pre].concat(code.split('\n'), [fence]));
      return;
    }
    if (e.container) { flush(); containers.pop(); return; }
    if (e.cell || e.caption) {
      inlineOnly--;
      var tb = tables[tables.length - 1];
      var v = oneLine(cur).replace(/\|/g, '\\|'); cur = '';
      if (e.caption) tb.caption = v;
      else tb.rows[tb.rows.length - 1].push(v);
      return;
    }
    if (e.table) {
      var t = tables.pop(); cur = '';
      var rows = t.rows.filter(function (r) { return r.length > 0; });
      if (t.caption !== '') emit([t.caption]);
      if (rows.length === 0) return;
      var w = 0;
      rows.forEach(function (r) { if (r.length > w) w = r.length; });
      var line = function (r) { var c = []; for (var i = 0; i < w; i++) c.push(r[i] !== undefined ? r[i] : ''); return '| ' + c.join(' | ') + ' |'; };
      var sepRow = []; for (var i = 0; i < w; i++) sepRow.push('---');
      var lines = [line(rows[0]), '| ' + sepRow.join(' | ') + ' |'];
      for (var j = 1; j < rows.length; j++) lines.push(line(rows[j]));
      emit(lines);
      return;
    }
    if (e.link) {
      inlineOnly--;
      var L = e.link;
      if (L.ser !== serial) return;
      if (!wrap(L.start, L.ser, '[', '](' + L.href + ')') && L.label !== '') addText('[' + oneLine(L.label) + '](' + L.href + ')');
      return;
    }
    if (e.wrap) { wrap(e.start, e.ser, e.wrap[0], e.wrap[1]); return; }
    if (e.code) {
      var inner = cur.slice(e.start);
      var tick = inner.indexOf(BT) >= 0 ? BT + BT : BT;
      var pad = inner.indexOf(BT) >= 0 ? ' ' : '';
      wrap(e.start, e.ser, tick + pad, pad + tick);
      return;
    }
    if (e.block) { if (inlineOnly > 0) sep(); else flush(); }
  };

  if (!root) return '';
  // Ancêtres de la racine (zone) : vérifiés une fois ; ensuite le parcours descendant élague lui-même ce qui
  // n'est pas rendu (un checkVisibility par élément remonterait tous les ancêtres : quadratique sur un DOM profond).
  if (root.nodeType === 1 && typeof root.checkVisibility === 'function' && !root.checkVisibility() && styleOf(root) && styleOf(root).display !== 'contents') return '';
  // Pile explicite : { n: nœud, e: état d'entrée (présent = sortie à faire) }.
  var stack = [{ n: root }];
  while (stack.length > 0) {
    var it = stack.pop();
    var n = it.n;
    if (it.e) { exit(n, it.e); continue; }
    if (n.nodeType === 3) { if (textVisible(n)) addText(n.data); continue; }
    if (n.nodeType === 11) { var fc = n.childNodes; for (var a = fc.length - 1; a >= 0; a--) stack.push({ n: fc[a] }); continue; }
    if (n.nodeType !== 1) continue;
    if (SKIP[n.nodeName] || n.namespaceURI === 'http://www.w3.org/2000/svg' || n.namespaceURI === 'http://www.w3.org/1998/Math/MathML') continue;
    var st = styleOf(n);
    if (st && st.display === 'none') continue;
    var e = { style: st };
    if (!enter(n, e)) continue;
    e.style = null;
    stack.push({ n: n, e: e });
    // Contenu non rendu : content-visibility: hidden (l'élément reste, pas ses enfants) ; <details> fermé : le <summary> seul.
    if (st && st.contentVisibility === 'hidden') continue;
    var ch = children(n);
    if (n.nodeName === 'DETAILS' && !n.open) ch = Array.prototype.filter.call(ch, function (c) { return c.nodeName === 'SUMMARY'; }).slice(0, 1);
    for (var b = ch.length - 1; b >= 0; b--) stack.push({ n: ch[b] });
  }
  flush();
  return out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\s+$/g, '');
}`;

/**
 * Zone (text --markdown --scope) : Markdown de l'élément ; iframe : de son document s'il est accessible
 * (même origine), sinon { frame, src } — même contrat que le texte brut d'une zone.
 */
export const SCOPE_MARKDOWN_FN = `function () {
  const md = ${MARKDOWN_FN};
  const el = this.nodeType === 1 ? this : this.parentElement;
  if (!el) return { text: (this.textContent || '').trim() };
  if (el.nodeName === 'IFRAME' || el.nodeName === 'FRAME') {
    let doc = null;
    try { doc = el.contentDocument; } catch (e) { doc = null; }
    if (doc) return { text: doc.body ? md(doc.body) : '', frame: true };
    return { frame: true, src: el.src || el.getAttribute('src') || '' };
  }
  return { text: md(el) };
}`;

/**
 * La même fonction, comme valeur, pour `locator.evaluate` de Playwright (text --markdown --scope 'frame=…') :
 * Playwright la renvoie au cadre par sa source.
 */
export function markdownInPage(): (root: unknown) => string {
  return new Function(`return (${MARKDOWN_FN});`)() as (root: unknown) => string;
}
