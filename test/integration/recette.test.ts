import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { makeTestEnv, type TestEnv } from '../helpers/env.js';
import { startServer, runCli, waitExit, type Server } from '../helpers/server.js';
import { startTestSite, type TestSite } from '../helpers/testsite.js';
import { resolvePaths } from '../../src/core/paths.js';
import type { RunResult } from '../../src/control/run.js';

/** Recette : assertions `expect` (run et commande directe) et rapport de fin de run. Site local /boutique. */
let t: TestEnv;
let site: TestSite;
let srv: Server;
let env: NodeJS.ProcessEnv;
before(async () => {
  t = makeTestEnv();
  site = await startTestSite();
  const paths = resolvePaths(t.env, t.env.HOME);
  mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
  writeFileSync(paths.configFile, JSON.stringify({ allowedDomains: ['127.0.0.1'] }), { mode: 0o600 });
  srv = await startServer(t.env);
  const id = (await runCli(t.env, ['session', 'create'])).stdout.trim();
  env = { ...t.env, GRASP_SESSION: id };
});
after(async () => { srv.proc.kill('SIGTERM'); await waitExit(srv.proc); await site.close(); t.cleanup(); });

const run = (script: string, args: string[] = []) => runCli(env, ['run', ...args], script);

/** Chemin de capture du rapport : fichier réel, privé. */
function shotOf(stdout: string, n: number): string {
  const m = new RegExp(`^KO  \\[${n}\\] .*\\n {6}.*\\n {6}capture : (\\S+)$`, 'm').exec(stdout);
  assert.ok(m, `capture de l'étape ${n} absente du rapport :\n${stdout}`);
  const p = m[1]!;
  assert.ok(existsSync(p), p);
  assert.equal(statSync(p).mode & 0o777, 0o600);
  return p;
}

test('recette qui passe : toutes les assertions tenues, code 0, rapport d\'office (le script contient expect)', async () => {
  const r = await run(`nav ${site.url}/boutique
expect title Boutique
expect no-text "Commande enregistrée" --timeout 0
expect no-sel '#recu' --timeout 0
fill '#qte' 2
fill text:Courriel ada@example.org
expect value '#qte' 2
expect value text:Courriel ~ @example
click text:Commander
expect text "Commande enregistrée"
expect text --regex "n°\\d+"
expect text "Reçu" --scope '#recu'
expect no-text "Erreur"
expect url ~ /merci
expect url --regex '/boutique/merci$'
expect title Merci
expect sel '#recu'
expect sel text:Commander
expect no-console-errors
expect no-form-errors
`);
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
  assert.ok(r.stdout.split('\n').filter((l) => /^\[\d+\] /.test(l)).every((l) => l.endsWith(' → OK')), r.stdout);
  assert.match(r.stdout, /^== recette : OK — 20 étapes : 20 OK, 0 KO \(\d+ ms\)$/m);
  assert.match(r.stdout, /^OK {2}\[10\] expect text "Commande enregistrée" \(\d+ ms\)$/m);
  assert.match(r.stdout, /^console : aucune erreur pendant le run$/m);
  assert.match(r.stdout, /^requêtes en échec : aucune$/m);
  assert.match(r.stdout, /^formulaire : aucune erreur$/m);
  assert.match(r.stdout, new RegExp(`^page finale : ${site.url}/boutique/merci « Merci »$`, 'm'));
  assert.doesNotMatch(r.stdout, /capture :/);
  assert.match(r.stderr, /20 commandes, 20 OK/);
});

/** Un scénario d'échec par assertion : arrêt, code 1, attendu + constaté, capture, étapes suivantes non exécutées. */
const failures: Array<{ name: string; setup: string; line: string; msg: RegExp }> = [
  { name: 'text', setup: '', line: 'expect text "Commande refusée" --timeout 300', msg: /attendu texte « Commande refusée » dans la page ; constaté : absent ; texte de la page : « Boutique Quantité Courriel Commander Panier en attente » \(après 300 ms\)/ },
  { name: 'text --scope', setup: '', line: "expect text Panier --scope 'form' --timeout 0", msg: /attendu texte « Panier » dans form ; constaté : absent ; texte de la zone : « Quantité Courriel Commander »$/ },
  { name: 'no-text', setup: '', line: 'expect no-text "en attente" --timeout 300', msg: /attendu aucun texte « en attente » dans la page ; constaté : présent : « Boutique Quantité Courriel Commander Panier en attente » \(après 300 ms\)/ },
  { name: 'url', setup: '', line: 'expect url ~ /merci --timeout 300', msg: /attendu url contenant « \/merci » ; constaté : « http:\/\/127\.0\.0\.1:\d+\/boutique » \(après 300 ms\)/ },
  { name: 'url --regex', setup: '', line: "expect url --regex 'merci$' --timeout 0", msg: /attendu url correspondant à \/merci\$\/ ; constaté : « http:\/\/127\.0\.0\.1:\d+\/boutique »$/ },
  { name: 'title', setup: '', line: 'expect title Merci --timeout 300', msg: /attendu titre = « Merci » ; constaté : « Boutique » \(après 300 ms\)/ },
  { name: 'sel (invisible)', setup: '', line: "expect sel '#cache' --timeout 300", msg: /attendu élément visible #cache ; constaté : présent mais invisible \(après 300 ms\)/ },
  { name: 'sel (absent)', setup: '', line: 'expect sel text:Payer --timeout 0', msg: /attendu élément visible text:Payer ; constaté : aucun élément ne correspond$/ },
  { name: 'no-sel', setup: '', line: 'expect no-sel h1 --timeout 300', msg: /attendu aucun élément visible h1 ; constaté : visible \(après 300 ms\)/ },
  { name: 'value', setup: "fill '#qte' 3", line: "expect value '#qte' 4 --timeout 300", msg: /attendu valeur de #qte = « 4 » ; constaté : « 3 » \(après 300 ms\)/ },
  { name: 'value (absent)', setup: '', line: "expect value '#prix' 4 --timeout 0", msg: /attendu valeur de #prix = « 4 » ; constaté : aucun élément ne correspond à #prix/ },
  {
    name: 'no-console-errors', setup: "fill '#qte' 13\nclick text:Commander\nexpect text \"Erreur serveur\"", line: 'expect no-console-errors',
    msg: /attendu aucune erreur console ; constaté : 2 erreur\(s\) depuis #\d+ : #\d+ error network POST http:\/\/127\.0\.0\.1:\d+\/api\/commande\?qte=13 → 500 Internal Server Error \| #\d+ error console échec de la commande 500/,
  },
  {
    name: 'no-form-errors', setup: "fill '#qte' 0\nclick text:Commander", line: 'expect no-form-errors',
    msg: /attendu aucune erreur de formulaire ; constaté : 1 erreur\(s\) : e[0-9a-z]+:textbox "Quantité"="0" \[invalide: La quantité doit être un entier positif\]$/,
  },
];

for (const f of failures) {
  test(`recette en échec : expect ${f.name} → code 1, attendu/constaté, capture, suite non exécutée`, async () => {
    const lines = [`nav ${site.url}/boutique`, ...f.setup.split('\n').filter((x) => x !== ''), f.line, 'expect title Boutique'];
    const n = lines.length - 1;
    const r = await run(lines.join('\n'));
    assert.equal(r.code, 1, `${r.stdout}\n${r.stderr}`);
    const head = r.stdout.split('\n').find((l) => l.startsWith(`[${n}] `));
    assert.ok(head !== undefined, r.stdout);
    assert.ok(head.startsWith(`[${n}] ${f.line} → ERROR: `), head);
    assert.match(head, f.msg);
    assert.doesNotMatch(r.stdout, new RegExp(`^\\[${n + 1}\\] `, 'm'));
    assert.match(r.stdout, new RegExp(`^== recette : ÉCHEC — ${n + 1} étapes : ${n - 1} OK, 1 KO, 1 non exécutée \\(\\d+ ms\\)$`, 'm'));
    assert.match(r.stdout, new RegExp(`^--  \\[${n + 1}\\] expect title Boutique \\(non exécutée\\)$`, 'm'));
    shotOf(r.stdout, n);
    assert.match(r.stderr, new RegExp(`^ERROR: run: étape ${n} \\(`, 'm'));
    if (f.name === 'no-console-errors') {
      // Le rapport sépare la console des requêtes en échec.
      assert.match(r.stdout, /^console : 1 erreur pendant le run\n {2}#\d+ error console échec de la commande 500/m);
      assert.match(r.stdout, /^requêtes en échec : 1\n {2}#\d+ error network POST http:\/\/127\.0\.0\.1:\d+\/api\/commande\?qte=13 → 500/m);
    }
    if (f.name === 'no-form-errors') assert.match(r.stdout, /^formulaire : 1 erreur\n {2}e[0-9a-z]+:textbox "Quantité"="0" .*\[invalide: La quantité doit être un entier positif\]$/m);
  });
}

test('rapport : erreurs console et requêtes du run même sans assertion qui les vise ; --continue : une capture par échec', async () => {
  const r = await run(`nav ${site.url}/boutique
fill '#qte' 13
click text:Commander
expect text "Commande enregistrée" --timeout 300
expect title Merci --timeout 0
`, ['--continue']);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /^== recette : ÉCHEC — 5 étapes : 3 OK, 2 KO \(\d+ ms\)$/m);
  const a = shotOf(r.stdout, 4);
  const b = shotOf(r.stdout, 5);
  assert.notEqual(a, b);
  assert.match(r.stdout, /^console : 1 erreur pendant le run$/m);
  assert.match(r.stdout, /^requêtes en échec : 1$/m);
  assert.match(r.stderr, /ERROR: run: 2 étapes en échec : 4, 5/);
});

test('rapport : --report sans expect, --no-report avec, --json structuré', async () => {
  const sans = await run(`nav ${site.url}/boutique\nexpect title Boutique\n`, ['--no-report']);
  assert.equal(sans.code, 0);
  assert.doesNotMatch(sans.stdout, /== recette/);
  const avec = await run(`nav ${site.url}/boutique\n`, ['--report']);
  assert.equal(avec.code, 0);
  assert.match(avec.stdout, /^== recette : OK — 1 étape : 1 OK, 0 KO/m);
  const plain = await run(`nav ${site.url}/boutique\n`);
  assert.doesNotMatch(plain.stdout, /== recette/, 'sans expect ni --report : sortie inchangée');

  const j = await run(`nav ${site.url}/boutique\nfill '#qte' 13\nclick text:Commander\nexpect text "Commande enregistrée" --timeout 200\nexpect title Boutique\n`, ['--json']);
  assert.equal(j.code, 1);
  const res = JSON.parse(j.stdout) as RunResult;
  const rep = res.report!;
  assert.equal(rep.ok, false);
  assert.deepEqual(rep.steps.map((s) => [s.n, s.ok]), [[1, true], [2, true], [3, true], [4, false]]);
  assert.match(rep.steps[3]!.error!, /^attendu texte « Commande enregistrée » dans la page ; constaté : absent/);
  assert.ok(existsSync(rep.steps[3]!.screenshot!));
  assert.ok(rep.steps.every((s) => typeof s.ms === 'number'));
  assert.deepEqual(rep.notRun.map((s) => s.text), ['expect title Boutique']);
  assert.ok(!('unavailable' in rep.console));
  if (!('unavailable' in rep.console)) {
    assert.deepEqual(rep.console.errors.map((e) => e.source), ['console']);
    assert.deepEqual(rep.console.requests.map((e) => e.text.replace(/:\d+\//, ':P/')), ['POST http://127.0.0.1:P/api/commande?qte=13 → 500 Internal Server Error']);
  }
  assert.deepEqual(rep.forms, { items: [] });
  assert.equal(rep.page?.title, 'Boutique');
  // Détail structuré de l'assertion dans le résultat de l'étape.
  const st = res.steps[3]!;
  assert.equal(st.status, 417);
  assert.deepEqual(Object.keys((st.result as { expect: Record<string, unknown> }).expect).sort(), ['expected', 'kind', 'observed']);
});

test('commande directe : grasp expect … → OK (code 0) ou ERROR: expect: attendu … ; constaté : … (code 1)', async () => {
  assert.equal((await runCli(env, ['nav', `${site.url}/boutique`])).code, 0);
  const ok = await runCli(env, ['expect', 'text', 'Panier en attente']);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(ok.stdout, 'OK\n');
  const ko = await runCli(env, ['expect', 'title', 'Merci', '--timeout', '0']);
  assert.equal(ko.code, 1);
  assert.equal(ko.stdout, '');
  assert.equal(ko.stderr, 'ERROR: expect: attendu titre = « Merci » ; constaté : « Boutique »\n');
  const shot = await runCli(env, ['expect', 'sel', '#recu', '--timeout', '0', '--shot-on-error']);
  assert.equal(shot.code, 1);
  const m = /\(capture : (\S+\.png)\)$/m.exec(shot.stderr);
  assert.ok(m && existsSync(m[1]!), shot.stderr);
  const j = await runCli(env, ['expect', 'url', '~', '/boutique', '--json']);
  assert.equal(j.code, 0);
  assert.equal(JSON.parse(j.stdout).kind, 'url');
  // ~ non cité dans un terminal : la shell le remplace par $HOME, l'argument de trop est refusé avec la cause.
  const tilde = await runCli(env, ['expect', 'url', t.env.HOME!, '/merci']);
  assert.equal(tilde.code, 1);
  assert.match(tilde.stderr, /usage : grasp expect url \[~\] <url> .*citez le ~ \('~'\)/);
  // Console : depuis le début du document courant (la 500 d'une commande précédente ne compte plus après nav).
  assert.equal((await runCli(env, ['fill', '#qte', '13'])).code, 0);
  assert.equal((await runCli(env, ['click', 'text:Commander'])).code, 0);
  assert.equal((await runCli(env, ['expect', 'text', 'Erreur serveur'])).code, 0);
  const err = await runCli(env, ['expect', 'no-console-errors']);
  assert.equal(err.code, 1);
  assert.match(err.stderr, /constaté : 2 erreur\(s\)/);
  assert.equal((await runCli(env, ['expect', 'no-console-errors', '--ignore', 'commande'])).code, 0, 'les deux entrées citent /api/commande ou « commande »');
  assert.equal((await runCli(env, ['nav', `${site.url}/boutique`])).code, 0);
  assert.equal((await runCli(env, ['expect', 'no-console-errors'])).code, 0);
});

test('assertion mal écrite : script refusé avant toute exécution, ligne citée', async () => {
  const cases: Array<[string, RegExp]> = [
    ['expect bidule', /ligne 2 : assertion inconnue « bidule » \(assertions : text, no-text, url, title, sel, no-sel, value, no-console-errors, no-form-errors\)/],
    ['expect url a b', /ligne 2 : usage : grasp expect url \[~\] <url>/],
    ['expect text x --ignore y', /ligne 2 : --ignore ne s'applique pas à expect text/],
    ["expect text --regex '('", /ligne 2 : expression régulière invalide \/\(\//],
    ['expect url ~ /a --regex', /ligne 2 : expect url : « ~ » \(contient\) et --regex s'excluent/],
    ['expect sel', /ligne 2 : usage : grasp expect sel <sélecteur>/],
    ['expect text x --timeout 99999', /ligne 2 : timeout : 60000 ms au plus/],
    ['expect no-form-errors --session x', /ligne 2 : --session n'a pas de sens sur une ligne de run/],
  ];
  for (const [line, re] of cases) {
    const before = site.hits.length;
    const r = await run(`nav ${site.url}/boutique\n${line}\n`);
    assert.equal(r.code, 1, line);
    assert.match(r.stderr, re, line);
    assert.equal(r.stdout, '', line);
    assert.equal(site.hits.length, before, `${line} : rien d'exécuté`);
  }
});
