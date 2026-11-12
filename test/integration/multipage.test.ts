import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTestEnv, type TestEnv } from '../helpers/env.js';
import { startServer, runCli, waitExit, type Server } from '../helpers/server.js';
import { startMultiSite, type MultiSite } from '../helpers/multisite.js';
import { resolvePaths } from '../../src/core/paths.js';
import type { AuditResult, DiffResult } from '../../src/core/multipage.js';

/**
 * Recette multi-pages contre deux instances du site de test : `a` (référence) et `b` (préprod avec régressions),
 * deux origines distinctes. Vrai Chrome, sessions éphémères créées et fermées par la commande.
 */
let t: TestEnv;
let A: MultiSite;
let B: MultiSite;
let srv: Server;
before(async () => {
  t = makeTestEnv();
  A = await startMultiSite('a');
  B = await startMultiSite('b');
  const paths = resolvePaths(t.env, t.env.HOME);
  mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
  writeFileSync(paths.configFile, JSON.stringify({ allowedDomains: ['127.0.0.1'] }), { mode: 0o600 });
  srv = await startServer(t.env);
});
after(async () => { srv.proc.kill('SIGTERM'); await waitExit(srv.proc); await A.close(); await B.close(); t.cleanup(); });

const cli = (args: string[], input?: string) => runCli(t.env, args, input);
const sessions = async () => JSON.parse((await cli(['session', 'list', '--json'])).stdout) as unknown[];
const file = (name: string, content: string) => { const p = join(t.root, name); writeFileSync(p, content); return p; };

test('diff : même page, mêmes contenus à l\'origine près → IDENTIQUES, code 0 ; sessions fermées', async () => {
  const r = await cli(['diff', `${A.url}/contact`, `${B.url}/contact`, '--ignore', 'mis à jour']);
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /^== diff : IDENTIQUES — 1 page : 1 identique, 0 différente \(\d+ ms, 1 session\)$/m);
  assert.match(r.stdout, /^= {2}\/contact$/m);
  assert.deepEqual(await sessions(), []);
});

test('diff --paths : statut, structure, texte, console et requêtes en échec, propres à chaque côté ; code 1', async () => {
  const paths = file('chemins.txt', '# pages comparées\n/\n/produits\n/contact\n/statut\n');
  const r = await cli(['diff', A.url, B.url, '--paths', paths, '--concurrency', '2']);
  assert.equal(r.code, 1, `${r.stdout}\n${r.stderr}`);
  const out = r.stdout;
  assert.match(out, /^== diff : DIFFÉRENCES — 4 pages : 1 identique, 3 différentes \(\d+ ms, 2 sessions\)$/m);
  assert.match(out, new RegExp(`^A = ${A.url}/\\nB = ${B.url}/$`, 'm'));
  // /produits : chaque rubrique, du bon côté.
  const produits = /^≠ {2}\/produits\n((?: {5}.*\n?)*)/m.exec(out)?.[1] ?? '';
  assert.match(produits, /^ {5}structure : 1 seulement dans A, 1 seulement dans B\n {7}- {5}heading\[2\] "Promotions"\n {7}\+ {5}heading\[2\] "Soldes"$/m, out);
  assert.match(produits, /^ {5}texte \(main\) : 2 seulement dans A, 2 seulement dans B$/m);
  assert.match(produits, /^ {7}- Prix : 12 €$/m);
  assert.match(produits, /^ {7}\+ Prix : 14 €$/m);
  assert.match(produits, /^ {5}console : 1 seulement dans B\n {7}\+ console panier introuvable \(produits:\d+\)$/m);
  assert.match(produits, /^ {5}requêtes en échec : 1 seulement dans B\n {7}\+ network GET \{origine\}\/absent\.png → 404 Not Found$/m);
  assert.doesNotMatch(produits, /titre|favicon/);
  // /contact : l'origine affichée dans la page est neutralisée ; seule la date diffère.
  assert.match(out, /^≠ {2}\/contact\n {5}texte \(main\) : 1 seulement dans A, 1 seulement dans B\n {7}- Mis à jour le 3 mars\n {7}\+ Mis à jour le 9 avril$/m);
  assert.match(out, /^≠ {2}\/statut\n {5}statut HTTP : A 200 ; B 500$/m);
  assert.match(out, /^= {2}\/$/m);
  assert.deepEqual(await sessions(), []);

  // --json : mêmes constats, structurés ; --ignore écarte la ligne de date.
  const j = await cli(['diff', A.url, B.url, '--paths', paths, '--ignore', 'mis à jour', '--json']);
  assert.equal(j.code, 1);
  const res = JSON.parse(j.stdout) as DiffResult;
  assert.deepEqual(res.pages.map((p) => [p.path, p.same]), [['/', true], ['/produits', false], ['/contact', true], ['/statut', false]]);
  assert.deepEqual(res.pages[3]!.differences, [{ what: 'statut', a: '200', b: '500' }]);
});

test('diff --paths - (stdin) et --max : chemins au-delà annoncés, jamais comparés en silence', async () => {
  const r = await cli(['diff', A.url, B.url, '--paths', '-', '--max', '1'], '/\n/statut\n');
  // Comme pour audit : --max borne la recette, annoncé, sans la faire échouer.
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /^== diff : IDENTIQUES — 1 page : 1 identique, 0 différente/m);
  assert.match(r.stdout, /AVERTISSEMENT : 1 chemin au-delà de --max non comparé : \/statut/);
});

test('audit d\'un sitemap : statut, console, requêtes 4xx, formulaire au chargement, liens cassés ; déconnexion jamais visitée', async () => {
  const before = B.hits.length;
  const r = await cli(['audit', `${B.url}/sitemap.xml`, '--concurrency', '2']);
  assert.equal(r.code, 1, `${r.stdout}\n${r.stderr}`);
  const out = r.stdout;
  assert.match(out, /^== audit : ÉCHEC — 5 pages : 2 OK, 3 avec problèmes ; liens internes : 7 vérifiés, 1 cassé \(\d+ ms, 2 sessions\)$/m);
  assert.match(out, new RegExp(`^OK {2}200 ${B.url}/ « Accueil » \\(\\d+ ms\\)$`, 'm'));
  assert.match(out, new RegExp(`^KO {2}200 ${B.url}/produits « Produits » \\(\\d+ ms\\)\\n {6}console : 1\\n {8}console panier introuvable \\(produits:\\d+\\)\\n {6}requêtes en échec : 1\\n {8}network GET ${B.url}/absent\\.png → 404 Not Found$`, 'm'));
  assert.match(out, new RegExp(`^KO {2}200 ${B.url}/inscription « Inscription » \\(\\d+ ms\\)\\n {6}formulaire au chargement : 1\\n {8}textbox "Courriel"="ada@" \\[invalide: Adresse incomplète\\]$`, 'm'));
  assert.match(out, new RegExp(`^KO {2}404 ${B.url}/absente « Introuvable » \\(\\d+ ms\\)\\n {6}statut HTTP 404$`, 'm'));
  // Le document 404 n'est pas compté une seconde fois comme requête en échec.
  assert.doesNotMatch(out, /GET \S+\/absente → 404/);
  assert.match(out, new RegExp(`^liens cassés : 1\\n {2}404 ${B.url}/mort — sur ${B.url}/$`, 'm'));
  assert.match(out, new RegExp(`liens écartés sans requête : 1 — ${B.url}/logout \\(déconnexion probable\\)`));
  const hits = B.hits.slice(before);
  assert.ok(!hits.some((h) => h.path === '/logout'), 'lien de déconnexion jamais demandé');
  assert.ok(!hits.some((h) => h.path === '/mort' && h.method !== 'HEAD'), 'liens vérifiés par HEAD, pas visités');
  // HEAD refusé (405) → GET ; redirection non suivie : ni l'un ni l'autre n'est cassé.
  assert.ok(hits.some((h) => h.path === '/api/methode' && h.method === 'GET'), JSON.stringify(hits));
  assert.doesNotMatch(out, /\/redirige|\/api\/methode|favicon/);
  assert.deepEqual(await sessions(), []);
});

test('audit --json d\'un index de sitemaps ; --no-links : aucune vérification', async () => {
  const r = await cli(['audit', `${A.url}/sitemap-index.xml`, '--concurrency', '1', '--no-links', '--json']);
  assert.equal(r.code, 1, r.stderr);
  const j = JSON.parse(r.stdout) as AuditResult;
  assert.deepEqual(j.pages.map((p) => [new URL(p.url).pathname, p.status, p.problems]), [['/', 200, 0], ['/produits', 200, 0], ['/contact', 200, 0], ['/inscription', 200, 1], ['/absente', 404, 1]]);
  assert.equal(j.links.disabled, true);
  assert.equal(j.links.checked, 0);
  assert.match(j.notes.join('\n'), /index de sitemaps .* : 1\/1 sitemap\(s\) lu\(s\), 5 entrées/);
});

test('audit d\'une liste : page hors allowlist refusée par le garde (jamais demandée au site), code 1', async () => {
  const before = A.hits.length;
  const port = new URL(A.url).port;
  const list = file('liste.txt', `# recette\n${A.url}/contact\nhttp://localhost:${port}/hors-allowlist\n`);
  const r = await cli(['audit', list, '--concurrency', '1']);
  assert.equal(r.code, 1, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, new RegExp(`^OK {2}200 ${A.url}/contact « Contact »`, 'm'));
  assert.match(r.stdout, new RegExp(`^KO {2}--- http://localhost:${port}/hors-allowlist \\(\\d+ ms\\)\\n {6}refusée : navigation bloquée : .*allowlist`, 'm'));
  assert.ok(!A.hits.slice(before).some((h) => h.path === '/hors-allowlist'));
});

test('audit d\'une page HTML : la page et ses liens internes (un niveau), annoncé', async () => {
  const r = await cli(['audit', `${A.url}/`, '--no-links', '--max', '3']);
  // Les 3 premières pages sont saines : --max borne l'audit, annoncé, sans le faire échouer.
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /^== audit : OK — 3 pages : 3 OK/m);
  assert.match(r.stdout, /AVERTISSEMENT : 4 pages au-delà de --max non visitées/);
  assert.match(r.stdout, new RegExp(`note: ${A.url}/ n'est pas un sitemap : la page et ses 8 liens internes \\(un niveau\\)`));
});

test('arguments refusés avant tout lancement de Chrome : option inconnue, borne, usage, --profile avec --concurrency', async () => {
  for (const [args, msg] of [
    [['audit', `${A.url}/`, '--snap-diff'], /option inconnue --snap-diff/],
    [['audit', `${A.url}/`, '--max', '0'], /--max 0 : entier de 1 à 1000/],
    [['audit', `${A.url}/`, '--concurrency', '9'], /--concurrency 9 : entier de 1 à 8/],
    [['audit', `${A.url}/`, '--no-links', '--max-links', '3'], /s'excluent/],
    [['diff', A.url], /usage : grasp diff/],
    [['diff', A.url, 'ftp://x/'], /URL http\(s\) attendue/],
    [['diff', A.url, B.url, '--paths', join(t.root, 'absent.txt')], /impossible de lire/],
    [['diff', A.url, B.url, '--profile', 'p', '--concurrency', '2'], /--profile impose --concurrency 1/],
    [['audit', `${A.url}/`, '--ignore', '('], /--ignore : expression régulière invalide/],
  ] as Array<[string[], RegExp]>) {
    const r = await cli(args);
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.stderr, msg, args.join(' '));
  }
  assert.deepEqual(await sessions(), []);
});

test('audit --session : la session donnée sert seule, n\'est pas fermée', async () => {
  const id = (await cli(['session', 'create'])).stdout.trim();
  try {
    const r = await cli(['audit', `${A.url}/contact`, `${A.url}/produits`, '--session', id]);
    assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /^== audit : OK — 2 pages : 2 OK, 0 avec problèmes ; liens internes : \d+ vérifiés, 0 cassé \(\d+ ms, 1 session\)$/m);
    assert.deepEqual((await sessions()).length, 1);
  } finally { await cli(['session', 'close', id]); }
});
