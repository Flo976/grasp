import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  absoluteUrl, auditPageOf, boundedInt, comparePages, diffLines, discover, formatAudit, formatDiff, multisetDiff, neutral, outlineOf,
  parseList, pool, riskyLink, runAudit, textLines, visitPage, type AuditResult, type Call, type PageFacts, type Reply,
} from '../../src/core/multipage.js';
import { splitLinks } from '../../src/bridge/inventory.js';

const SNAP = `page "Produits" http://127.0.0.1:8080/produits
e1abc:navigation "Principale"
 e2abc:link "Accueil"
e3abc:main
 e4abc:heading[1] "Produits"
 e5abc:region "Offres"
  e6abc:heading[2] "Promotions"
  "Prix : 12 €"
 e7abc:form
  e8abc:textbox "Nom" [required]
"Pied de page"
… élagué : 2 liens sans nom`;

test('outlineOf : titres et repères seulement, sans refs ni états, indentés par imbrication des lignes retenues', () => {
  assert.deepEqual(outlineOf(SNAP), [
    'navigation "Principale"',
    'main',
    '  heading[1] "Produits"',
    '  region "Offres"',
    '    heading[2] "Promotions"',
    '  form',
  ]);
  // Un conteneur de plus (indentation plus profonde) ne change pas le plan.
  const deeper = SNAP.replace(' e4abc:heading[1]', '   e4abc:heading[1]');
  assert.deepEqual(outlineOf(deeper), outlineOf(SNAP));
});

test('textLines : lignes non vides, espaces normalisés, ligne de troncature retirée et signalée', () => {
  assert.deepEqual(textLines('  a  b \n\n c\n… tronqué : 120 caractères restants — affinez avec --max N / --scope <ref|css>'), { lines: ['a b', 'c'], truncated: true });
  assert.deepEqual(textLines('x'), { lines: ['x'], truncated: false });
});

test('diffLines : plus longue sous-suite commune, dans l\'ordre ; mutation (ordre ignoré) détectée', () => {
  assert.deepEqual(diffLines(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd', 'e']), { removed: ['b'], added: ['x', 'e'] });
  assert.deepEqual(diffLines(['a', 'b'], ['a', 'b']), { removed: [], added: [] });
  // Même lignes, ordre inversé : une différence (un multi-ensemble ne la verrait pas).
  const d = diffLines(['a', 'b'], ['b', 'a']);
  assert.equal(d.removed.length + d.added.length, 2);
  assert.deepEqual(multisetDiff(['a', 'b'], ['b', 'a']), { removed: [], added: [] });
  assert.deepEqual(multisetDiff(['a', 'a', 'b'], ['a', 'c']), { removed: ['a', 'b'], added: ['c'] });
});

const facts = (o: Partial<PageFacts> & { url: string }): PageFacts => ({
  title: 'T', status: 200, outline: ['main'], text: { scope: 'main', lines: ['bonjour'], truncated: false },
  console: { errors: [], requests: [], omitted: 0 }, ms: 10, ...o,
});
const OA = 'http://127.0.0.1:1111';
const OB = 'http://127.0.0.1:2222';

test('comparePages : identiques après neutralisation des origines ; chaque rubrique détectée', () => {
  const same = comparePages('/c', facts({ url: `${OA}/c`, text: { scope: 'main', lines: [`voir ${OA}/c`], truncated: false } }), facts({ url: `${OB}/c`, text: { scope: 'main', lines: [`voir ${OB}/c`], truncated: false } }), { originA: OA, originB: OB });
  assert.equal(same.same, true, JSON.stringify(same));
  const r = comparePages('/p', facts({
    url: `${OA}/p`, title: 'Produits', status: 200, outline: ['main', '  heading[2] "Promotions"'],
    console: { errors: [], requests: [], omitted: 0 },
  }), facts({
    url: `${OB}/p`, title: 'Produits (préprod)', status: 500, outline: ['main', '  heading[2] "Soldes"'],
    text: { scope: 'main', lines: ['bonsoir'], truncated: false },
    console: { errors: ['console panier introuvable (p:5)'], requests: [`network GET ${OB}/a.png → 404 Not Found`], omitted: 0 },
  }), { originA: OA, originB: OB });
  assert.equal(r.same, false);
  assert.deepEqual(r.differences.map((d) => d.what), ['statut', 'titre', 'structure', 'texte', 'console', 'requêtes']);
  assert.deepEqual(r.differences.find((d) => d.what === 'requêtes')?.added, ['network GET {origine}/a.png → 404 Not Found']);
  assert.deepEqual(r.differences.find((d) => d.what === 'structure')?.removed, ['  heading[2] "Promotions"']);
});

test('comparePages : --ignore écarte les lignes qui correspondent ; navigation en échec = différence', () => {
  const a = facts({ url: `${OA}/c`, text: { scope: 'main', lines: ['Contact', 'Mis à jour le 3 mars'], truncated: false } });
  const b = facts({ url: `${OB}/c`, text: { scope: 'main', lines: ['Contact', 'Mis à jour le 9 avril'], truncated: false } });
  assert.equal(comparePages('/c', a, b, { originA: OA, originB: OB }).same, false);
  assert.equal(comparePages('/c', a, b, { originA: OA, originB: OB, ignore: /mis à jour/i }).same, true);
  const nav = comparePages('/x', a, { ...b, error: 'navigation bloquée : domaine hors allowlist' }, { originA: OA, originB: OB });
  assert.deepEqual(nav.differences, [{ what: 'navigation', a: 'OK', b: 'navigation bloquée : domaine hors allowlist' }]);
});

test('comparePages : console non lue d\'un côté → dit, jamais « identique » sur ce point en silence', () => {
  const r = comparePages('/', facts({ url: `${OA}/` }), facts({ url: `${OB}/`, console: { unavailable: 'la console est désactivée' } }), { originA: OA, originB: OB });
  assert.equal(r.same, true);
  assert.match(r.notes.join('\n'), /console non comparée \(B : la console est désactivée\)/);
  assert.match(formatDiff({ ok: true, a: OA, b: OB, ms: 1, pages: [r], notCompared: [], concurrency: 1 }), /note \(\/\) : console non comparée/);
});

test('formatDiff : bornes (6 lignes par rubrique, « … et N autre(s) »), pages identiques regroupées', () => {
  const many = Array.from({ length: 9 }, (_, i) => `ligne ${i}`);
  const r = comparePages('/long', facts({ url: `${OA}/long`, text: { scope: 'page', lines: many, truncated: true } }), facts({ url: `${OB}/long`, text: { scope: 'page', lines: [], truncated: false } }), { originA: OA, originB: OB });
  const same = comparePages('/', facts({ url: `${OA}/` }), facts({ url: `${OB}/` }), { originA: OA, originB: OB });
  const out = formatDiff({ ok: false, a: OA, b: OB, ms: 5, pages: [same, r], notCompared: ['/x'], concurrency: 2 });
  assert.match(out, /^== diff : DIFFÉRENCES — 2 pages : 1 identique, 1 différente \(5 ms, 2 sessions\)$/m);
  assert.match(out, /^ {5}texte \(page, coupé à 50000 caractères\) : 9 seulement dans A$/m);
  assert.match(out, /^ {7}- ligne 5$/m);
  assert.doesNotMatch(out, /ligne 6/);
  assert.match(out, /^ {7}- … et 3 autre\(s\)$/m);
  assert.match(out, /^= {2}\/$/m);
  assert.match(out, /AVERTISSEMENT : 1 chemin au-delà de --max non comparé : \/x/);
});

test('auditPageOf : problèmes comptés (statut ≥ 400, navigation, console, requêtes, formulaire) ; --ignore', () => {
  const p = auditPageOf({ url: 'u', status: 404, console: { errors: ['console a'], requests: ['network GET x → 500', 'network GET /pub → 404'], omitted: 0 }, forms: { items: ['textbox "Nom" [invalide]'] }, ms: 1 }, /\/pub/);
  assert.equal(p.problems, 4);
  assert.equal(auditPageOf({ url: 'u', error: 'navigation bloquée', blocked: true, console: { unavailable: 'x' }, ms: 1 }).problems, 1);
  assert.equal(auditPageOf({ url: 'u', status: 200, console: { unavailable: 'désactivée' }, ms: 1 }).problems, 0);
});

test('riskyLink : déconnexion jamais vérifiée', () => {
  for (const u of ['http://h/logout', 'http://h/compte/log-out', 'http://h/signout?x=1', 'http://h/d%C3%A9connexion', 'http://h/?action=logoff']) assert.equal(riskyLink(u), true, u);
  for (const u of ['http://h/', 'http://h/login', 'http://h/catalogue']) assert.equal(riskyLink(u), false, u);
  // « % » isolé ou séquence invalide (Chrome les garde tels quels dans a.href) : jamais d'exception.
  for (const u of ['http://h/promo-100%', 'http://h/a%zz', 'http://h/%E9t%E9', 'http://h/x?p=50%']) assert.equal(riskyLink(u), false, u);
  // Ancien lien encodé en latin-1 : la déconnexion reste reconnue.
  assert.equal(riskyLink('http://h/d%E9connexion'), true);
  assert.equal(riskyLink('http://h/logout?r=100%'), true);
});

test('entrées : parseList, absoluteUrl, boundedInt', () => {
  assert.deepEqual(parseList('# chemins\n/\n\n  /produits  \n#/x\n'), ['/', '/produits']);
  assert.equal(absoluteUrl('/a#h', 'http://h:1/base/'), 'http://h:1/a');
  assert.equal(absoluteUrl('b', 'http://h:1/base/'), 'http://h:1/base/b');
  assert.throws(() => absoluteUrl('/a'), /URL absolue/);
  assert.throws(() => absoluteUrl('file:///etc/passwd'), /URL http\(s\) attendue/);
  assert.equal(boundedInt(undefined, 'max', 50, 1000), 50);
  assert.equal(boundedInt('3', 'max', 50, 1000), 3);
  for (const v of ['0', '-1', 'abc', '1.5', '1001']) assert.throws(() => boundedInt(v, 'max', 50, 1000), /--max .* : entier de 1 à 1000/);
  assert.throws(() => boundedInt(true, 'max', 50, 1000), /attend une valeur/);
});

test('splitLinks (bridge) : même origine et allowlist seulement, sans requête pour le reste', () => {
  const r = splitLinks(['127.0.0.1'], 'http://127.0.0.1:8080/page', ['http://127.0.0.1:8080/a#x', 'http://127.0.0.1:9090/b', 'http://localhost:8080/c', 'ftp://127.0.0.1/d', 'pas une url']);
  assert.deepEqual(r.check, ['http://127.0.0.1:8080/a']);
  assert.deepEqual(r.skipped.map((s) => s.skipped), ['autre origine que la page (http://127.0.0.1:8080)', 'autre origine que la page (http://127.0.0.1:8080)', 'protocole non vérifié', 'URL invalide']);
  // Page sur une origine hors allowlist (ne devrait pas arriver : le garde l'aurait refusée) : rien ne part.
  assert.deepEqual(splitLinks(['exemple.org'], 'http://127.0.0.1:8080/', ['http://127.0.0.1:8080/a']).check, []);
  assert.deepEqual(splitLinks(['127.0.0.1'], 'about:blank', ['http://127.0.0.1:8080/a']).check, []);
});

/** Faux bridge : routes de session simulées, pour l'orchestration sans Chrome. */
function fakeSession(pages: Record<string, { status: number; links: string[]; title?: string }>, log: string[]): Call {
  let seq = 0;
  let here = 'about:blank';
  const reply = (v: unknown): Reply => ({ json: () => v, text: () => String(v) });
  return async (method, path, body) => {
    const b = (body ?? {}) as Record<string, unknown>;
    log.push(`${method} ${path}`);
    if (path === '/console') return reply({ seq, entries: [], omitted: 0 });
    if (path === '/navigate') {
      const p = pages[String(b.url)];
      if (p === undefined) throw Object.assign(new Error('navigation bloquée : domaine hors allowlist'), { status: 403 });
      here = String(b.url);
      seq++;
      return reply({ url: here, title: p.title ?? '' });
    }
    if (path === '/inventory') return reply({ url: here, status: pages[here]!.status, contentType: 'text/html', kind: 'page', links: pages[here]!.links, linksOmitted: 0, locs: [], locsOmitted: 0 });
    if (path === '/expect') return reply({ ok: true });
    if (path === '/check-links') return reply({ results: (b.urls as string[]).map((u) => ({ url: u, status: pages[u]?.status ?? 404 })) });
    throw new Error(`route inattendue ${path}`);
  };
}

test('runAudit : chaque lien vérifié une seule fois pour tout l\'audit, budget --max-links annoncé, déconnexion écartée', async () => {
  const H = 'http://h';
  const pages = {
    [`${H}/`]: { status: 200, links: [`${H}/a`, `${H}/mort`, `${H}/logout`, `${H}/b`] },
    [`${H}/a`]: { status: 200, links: [`${H}/`, `${H}/mort`, `${H}/c`] },
    [`${H}/b`]: { status: 200, links: [] },
    [`${H}/c`]: { status: 200, links: [] },
  };
  const log: string[] = [];
  const r = await runAudit({ urls: [`${H}/`, `${H}/a`, `${H}/`], source: 'liste', max: 50, maxLinks: 4, checkLinks: true }, [fakeSession(pages, log)]);
  assert.equal(r.pages.length, 2, 'URL en double visitée une fois');
  assert.equal(r.links.checked, 4);
  assert.equal(r.links.unchecked, 1, '5 liens distincts vérifiables, budget 4');
  assert.deepEqual(r.links.broken.map((b) => [b.url, b.status, b.from]), [[`${H}/mort`, 404, [`${H}/`, `${H}/a`]]]);
  assert.deepEqual(r.links.skipped, [{ url: `${H}/logout`, reason: 'déconnexion probable' }]);
  assert.equal(r.ok, false);
  const out = formatAudit(r);
  assert.match(out, /^ {2}404 http:\/\/h\/mort — sur http:\/\/h\/ et 1 autre\(s\) page\(s\)$/m);
  assert.match(out, /AVERTISSEMENT : 1 lien interne non vérifié \(budget --max-links atteint\)/);
});

test('runAudit : page refusée (allowlist) = problème, jamais un faux OK ; --max annoncé', async () => {
  const H = 'http://h';
  const log: string[] = [];
  const r = await runAudit({ urls: [`${H}/`, 'http://ailleurs/', `${H}/z`], source: 'liste', max: 2, maxLinks: 10, checkLinks: false }, [fakeSession({ [`${H}/`]: { status: 200, links: [`${H}/x`] } }, log)]);
  assert.equal(r.ok, false);
  assert.equal(r.notVisited, 1);
  assert.deepEqual(r.pages.map((p) => [p.url, p.problems, p.blocked ?? false]), [[`${H}/`, 0, false], ['http://ailleurs/', 1, true]]);
  assert.ok(!log.includes('POST /check-links'), '--no-links : aucune vérification');
  const out = formatAudit(r as AuditResult);
  assert.match(out, /^KO {2}--- http:\/\/ailleurs\/ \(\d+ ms\)\n {6}refusée : navigation bloquée : domaine hors allowlist$/m);
  assert.match(out, /AVERTISSEMENT : 1 page au-delà de --max non visitée/);
});

test('runAudit et discover : un lien au « % » isolé ne fait pas échouer l\'audit', async () => {
  const H = 'http://h';
  const pages = {
    [`${H}/`]: { status: 200, links: [`${H}/promo-100%`, `${H}/a%zz`, `${H}/ok`] },
    [`${H}/ok`]: { status: 200, links: [] },
  };
  const r = await runAudit({ urls: [`${H}/`], source: 'liste', max: 50, maxLinks: 10, checkLinks: true }, [fakeSession(pages, [])]);
  assert.equal(r.pages.length, 1);
  assert.deepEqual(r.links.broken.map((b) => b.url).sort(), [`${H}/a%zz`, `${H}/promo-100%`]);
  const d = await discover(fakeSession(pages, []), `${H}/`, 50);
  assert.deepEqual(d.urls, [`${H}/`, `${H}/promo-100%`, `${H}/a%zz`, `${H}/ok`]);
});

test('visitPage : la réponse 404 du document est rapportée par son statut, pas en double comme requête', async () => {
  const reply = (v: unknown): Reply => ({ json: () => v, text: () => String(v) });
  const call: Call = async (_m, path) => {
    if (path === '/console') return reply({ seq: 3, omitted: 0, entries: [
      { seq: 4, at: 0, level: 'error', source: 'network', text: 'GET http://h/absente → 404 Not Found' },
      { seq: 5, at: 0, level: 'error', source: 'network', text: 'GET http://h/favicon.ico → 404 Not Found' },
      { seq: 6, at: 0, level: 'error', source: 'network', text: 'GET http://h/img.png → 404 Not Found' },
      { seq: 7, at: 0, level: 'info', source: 'navigation', text: 'http://h/absente' },
    ] });
    if (path === '/navigate') return reply({ url: 'http://h/absente', title: 'Introuvable' });
    if (path === '/inventory') return reply({ url: 'http://h/absente', status: 404, contentType: 'text/html', kind: 'page', links: [], linksOmitted: 0, locs: [], locsOmitted: 0 });
    throw new Error(path);
  };
  const f = await visitPage(call, 'http://h/absente');
  assert.equal(f.status, 404);
  assert.deepEqual(f.console, { errors: [], requests: ['network GET http://h/img.png → 404 Not Found'], omitted: 0 });
});

test('pool : N travailleurs, chaque élément une fois ; arrêt demandé = plus aucun départ', async () => {
  const seen: number[] = [];
  const w: Call = async () => ({ json: () => null, text: () => '' });
  const out = await pool([1, 2, 3, 4, 5], [w, w], async (_c, x) => { seen.push(x); await new Promise((r) => setTimeout(r, 5)); return x * 2; });
  assert.deepEqual(out, [2, 4, 6, 8, 10]);
  assert.deepEqual([...seen].sort(), [1, 2, 3, 4, 5]);
  const ac = new AbortController();
  const started: number[] = [];
  await pool([1, 2, 3], [w], async (_c, x) => { started.push(x); ac.abort(); return x; }, ac.signal);
  assert.deepEqual(started, [1]);
});

test('neutral : seule l\'origine entière est remplacée', () => {
  assert.equal(neutral('http://h.org, http://h.org.evil/, http://h.org:81', 'http://h.org'), '{origine}, http://h.org.evil/, http://h.org:81');
  assert.equal(neutral('http://127.0.0.1:1111/a et http://127.0.0.1:11112/b', 'http://127.0.0.1:1111'), '{origine}/a et http://127.0.0.1:11112/b');
});
