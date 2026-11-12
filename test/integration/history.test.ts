import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTestEnv, type TestEnv } from '../helpers/env.js';
import { startServer, runCli, waitExit, type Server } from '../helpers/server.js';
import { startTestSite, type TestSite } from '../helpers/testsite.js';
import { resolvePaths } from '../../src/core/paths.js';

/**
 * grasp history : une session explorée à la main (refs d'un snap, lectures, une erreur, un mot de passe) est
 * exportée en script `grasp run`, rejoué dans une NOUVELLE session : même page finale, vérifiée par le contenu.
 */
let t: TestEnv;
let site: TestSite;
let srv: Server;
let env: NodeJS.ProcessEnv;
const SECRET = 'S3cret-ne-jamais-garder';

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

const ok = async (e: NodeJS.ProcessEnv, args: string[], input?: string) => {
  const r = await runCli(e, args, input);
  assert.equal(r.code, 0, `grasp ${args.join(' ')}\n${r.stdout}\n${r.stderr}`);
  return r;
};
const refOf = (snap: string, re: RegExp, nth = 0) => {
  const l = snap.split('\n').filter((x) => re.test(x))[nth];
  assert.ok(l !== undefined, `${re} absent du snap :\n${snap}`);
  return l.trim().split(':')[0]!;
};

test('history --as-run : exploration par refs → script rejoué dans une nouvelle session, même contenu final', async () => {
  const seq0 = Number(/seq courant : (\d+)/.exec((await ok(env, ['history'])).stderr)![1]);
  await ok(env, ['nav', `${site.url}/historique`]);
  const snap = (await ok(env, ['snap'])).stdout;
  const article = refOf(snap, /textbox "Article"/);
  const rayon = refOf(snap, /combobox "Rayon"/);
  const urgent = refOf(snap, /checkbox "Urgent"/);
  const code = refOf(snap, /textbox "Code d'accès"/);
  const ajouter = refOf(snap, /button "Ajouter"/);
  const supprimerPain = refOf(snap, /button "Supprimer"/, 0);

  await ok(env, ['fill', article, 'Pommes', '--snap-diff']);
  await ok(env, ['select', rayon, 'Fruits']);
  await ok(env, ['check', urgent]);
  await ok(env, ['fill', code, SECRET]);
  await ok(env, ['click', ajouter]);
  await ok(env, ['text', '--scope', '#etat']);
  // Deux boutons « Supprimer » : la ref de la ligne « Pain » ne peut pas devenir text:Supprimer.
  await ok(env, ['click', supprimerPain]);
  assert.equal((await runCli(env, ['click', 'text:Inexistant'])).code, 1);
  await ok(env, ['fill', 'text:Article', '-12 œufs "frais"']);
  await ok(env, ['press', 'Enter', article]);
  await ok(env, ['run'], 'snap --max 200\nwait --text frais\n');
  const finalText = (await ok(env, ['text'])).stdout;
  assert.match(finalText, /3 article\(s\) : Beurre, Pommes \(Fruits\) urgent, -12 œufs "frais"/);

  // Historique lisible : une ligne par commande, OK/KO, ref → sélecteur durable ; le mot de passe n'y est jamais.
  const h = await ok(env, ['history', '--since', String(seq0)]);
  assert.match(h.stdout, new RegExp(`^#\\d+ \\d\\d:\\d\\d:\\d\\d OK fill ${article} Pommes --snap-diff → text:Article `, 'm'));
  assert.match(h.stdout, new RegExp(`OK fill ${code} '<masqué>' → 'text:Code d'\\\\''accès' \\(\\d+ ms, valeur masquée\\)`));
  assert.match(h.stdout, new RegExp(`OK click ${supprimerPain} → 'li\\[data-id="1"\\] button'`));
  assert.match(h.stdout, /KO click text:Inexistant \(\d+ ms\) — 404 aucun élément nommé « Inexistant »/);
  assert.match(h.stdout, /OK wait --text frais \(\d+ ms, run\)/);
  const json = await ok(env, ['history', '--json']);
  assert.doesNotMatch(json.stdout + h.stdout, new RegExp(SECRET));

  // Export : fichier 0600, rejouable.
  const file = join(t.root, 'courses.grasp');
  const ex = await ok(env, ['history', '--as-run', '--expect', '--since', String(seq0), '-o', file]);
  assert.equal(ex.stdout.trim(), file);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const script = readFileSync(file, 'utf8');
  console.error(`# script exporté :\n${script.replace(/^/gm, '#   ')}`);
  assert.doesNotMatch(script, new RegExp(SECRET));
  assert.match(script, /^fill text:Article Pommes$/m);
  assert.match(script, /^select text:Rayon Fruits$/m);
  assert.match(script, /^check text:Urgent$/m);
  assert.match(script, /^# fill 'text:Code d'\\''accès' '<masqué>' +# #\d+ : valeur masquée/m);
  assert.match(script, /^click text:Ajouter$/m);
  assert.match(script, new RegExp(`^click 'li\\[data-id="1"\\] button' +# ${supprimerPain} button "Supprimer" : nom ambigu$`, 'm'));
  assert.match(script, /^fill -- text:Article '-12 œufs "frais"'$/m);
  assert.match(script, /^press Enter text:Article$/m);
  assert.match(script, /^wait --text frais$/m);
  assert.match(script, new RegExp(`^nav ${site.url}/historique$`, 'm'));
  assert.match(script, /^# Omis : 4 lecture\(s\) pure\(s\) \(snap ×2, text ×2\)\.$/m);
  assert.match(script, /Omis : 1 commande\(s\) en échec \(#\d+ click text:Inexistant\)/);
  assert.match(script, new RegExp(`^expect url ${site.url}/historique$`, 'm'));
  assert.match(script, /^expect title Courses$/m);
  assert.match(script, /^expect text 'Liste de courses'$/m);
  assert.doesNotMatch(script, /--snap-diff/);
  // Aucune ref restante hors commentaires.
  for (const l of script.split('\n').filter((x) => !x.startsWith('#'))) assert.doesNotMatch(l.replace(/ +#.*$/, ''), /(^| )e[0-9a-z]{1,4}( |$)/, l);

  // Rejeu dans une nouvelle session : la page de départ est fraîche (aucun état), même contenu à la fin.
  const id2 = (await ok(t.env, ['session', 'create'])).stdout.trim();
  const env2 = { ...t.env, GRASP_SESSION: id2 };
  const run = await ok(env2, ['run', file]);
  assert.match(run.stdout, /== recette : OK/);
  const replayed = (await ok(env2, ['text'])).stdout;
  assert.equal(replayed, finalText);
  // Le rejeu est lui-même dans l'historique de la nouvelle session (étapes de run), sans les lectures du rapport.
  const h2 = (await ok(env2, ['history'])).stdout;
  assert.match(h2, /OK click 'li\[data-id="1"\] button' \(\d+ ms, run\)/);
  assert.doesNotMatch(h2, /no-form-errors|OK console/);
  await ok(t.env, ['session', 'close', id2]);
});

test('history : --since, --limit, --clear ; history refusé dans run', async () => {
  const before = Number(/seq courant : (\d+)/.exec((await ok(env, ['history'])).stderr)![1]);
  await ok(env, ['nav', `${site.url}/historique`]);
  await ok(env, ['snap']);
  const r = await ok(env, ['history', '--since', String(before)]);
  assert.equal(r.stdout.trim().split('\n').length, 2);
  const lim = await ok(env, ['history', '--limit', '1']);
  assert.equal(lim.stdout.trim().split('\n').length, 1);
  assert.match(lim.stderr, /entrée\(s\) plus ancienne\(s\) non affichée\(s\)/);
  const asRun = (await ok(env, ['history', '--as-run', '--since', String(before)])).stdout;
  assert.match(asRun, /^nav http/m);
  assert.match(asRun, /Omis : 1 lecture\(s\) pure\(s\) \(snap ×1\)/);
  await ok(env, ['history', '--clear']);
  const empty = await ok(env, ['history']);
  assert.equal(empty.stdout, '');
  assert.match((await ok(env, ['history', '--as-run'])).stdout, /aucune commande rejouable/);
  const bad = await runCli(env, ['run'], 'history\n');
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /« history » n'est pas disponible dans run/);
  const usage = await runCli(env, ['history', '--expect']);
  assert.equal(usage.code, 1);
  assert.match(usage.stderr, /--expect et -o s'appliquent à --as-run/);
});

test('history --as-run : homonymes sans attribut stable → chemin positionnel depuis l\'ancêtre identifié, rejoué', async () => {
  const seq0 = Number(/seq courant : (\d+)/.exec((await ok(env, ['history'])).stderr)![1]);
  await ok(env, ['nav', `${site.url}/refs?n=3`]);
  const beta = refOf((await ok(env, ['snap'])).stdout, /button "Supprimer"/, 1);
  await ok(env, ['click', beta]);
  await ok(env, ['expect', 'text', 'supprimé : Beta']);
  const script = (await ok(env, ['history', '--as-run', '--since', String(seq0)])).stdout;
  assert.match(script, new RegExp(`^click '#liste > li:nth-of-type\\(2\\) > button:nth-of-type\\(1\\)' +# ${beta} button "Supprimer" : nom ambigu$`, 'm'));
  assert.match(script, /^expect text 'supprimé : Beta'$/m);
  const id2 = (await ok(t.env, ['session', 'create'])).stdout.trim();
  const r = await ok({ ...t.env, GRASP_SESSION: id2 }, ['run'], script);
  assert.match(r.stdout, /== recette : OK/);
  await ok(t.env, ['session', 'close', id2]);
});
