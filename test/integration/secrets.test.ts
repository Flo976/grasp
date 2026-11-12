import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { makeTestEnv, type TestEnv } from '../helpers/env.js';
import { runCli, startServer, waitExit, type Server } from '../helpers/server.js';
import { startTestSite, type TestSite } from '../helpers/testsite.js';

/**
 * Secrets de bout en bout (CLI → control plane → bridge → Chrome) : la valeur est saisie dans la page, mais
 * n'apparaît dans AUCUNE sortie (snap, text, markdown, diff, console, erreurs, run et rapport de recette,
 * journal du serveur) ni dans aucun fichier écrit par Grasp. Toutes les formes sont cherchées : brute, encodée
 * pour une URL ou un formulaire, et les préfixes (une sortie coupée ne doit pas laisser fuir un début).
 */

// Espaces, &, accents, ! : la valeur ressort encodée dans l'URL d'un formulaire GET et d'une requête.
const JETON = 'Jx7-Sésame&Clé 42!';
const COURT = 'Abcdef123';
const LONG = `L0ng-${'9f3a71c2'.repeat(15)}`;
const NOTE = 'NoteSecrete-777';
const AILLEURS = 'Ailleurs-Seulement-555';

let site: TestSite;
let t: TestEnv;
let srv: Server;
let env: NodeJS.ProcessEnv;

/** Formes recherchées : brute, encodeURIComponent, formulaire (application/x-www-form-urlencoded), et début. */
function forms(v: string): string[] {
  return [...new Set([v, encodeURIComponent(v), new URLSearchParams({ x: v }).toString().slice(2), v.slice(0, 8)])];
}
// COURT.slice(0, 6) : ce que garde le masque de saisie ; COURT.toUpperCase() : la valeur reformatée par la page.
const ALL = [...[JETON, COURT, LONG, NOTE, AILLEURS].flatMap(forms), COURT.slice(0, 6), COURT.toUpperCase()];

function assertNoLeak(what: string, s: string): void {
  for (const f of ALL) assert.ok(!s.includes(f), `${what} : fuite de « ${f} » dans :\n${s.slice(0, 3000)}`);
}

/** Fichiers sous `dir` contenant `needle`. */
function filesContaining(dir: string, needle: string): string[] {
  const found: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p);
      else if (st.isFile() && st.size < 64 * 1024 * 1024) { try { if (readFileSync(p).includes(needle)) found.push(p); } catch { /* socket */ } }
    }
  };
  walk(dir);
  return found;
}

before(async () => {
  site = await startTestSite();
  t = makeTestEnv();
  // Le magasin est écrit par la CLI, valeur sur stdin (jamais en argument).
  const set = async (name: string, value: string, domains: string) => {
    const r = await runCli(t.env, ['secrets', 'set', name, '--domains', domains], `${value}\n`);
    assert.equal(r.code, 0, r.stderr);
    assertNoLeak(`secrets set ${name}`, r.stdout + r.stderr);
  };
  await set('JETON', JETON, '127.0.0.1');
  await set('COURT', COURT, '127.0.0.1');
  await set('LONG', LONG, '127.0.0.1,*.exemple.test');
  await set('NOTE', NOTE, '127.0.0.1');
  await set('AILLEURS', AILLEURS, 'preprod.exemple.test');
  srv = await startServer(t.env);
  const c = await runCli(t.env, ['session', 'create']);
  assert.equal(c.code, 0, c.stderr);
  env = { ...t.env, GRASP_SESSION: c.stdout.trim() };
});

after(async () => {
  if (srv !== undefined) { srv.proc.kill('SIGTERM'); await waitExit(srv.proc); }
  t?.cleanup();
  await site?.close();
});

test('secrets list : noms et domaines, jamais les valeurs ; fichier 0600', async () => {
  const r = await runCli(env, ['secrets', 'list']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^AILLEURS\tpreprod\.exemple\.test$/m);
  assert.match(r.stdout, /^LONG\t127\.0\.0\.1,\*\.exemple\.test$/m);
  const j = await runCli(env, ['secrets', 'list', '--json']);
  assert.deepEqual(JSON.parse(j.stdout).secrets.map((s: { name: string }) => s.name), ['AILLEURS', 'COURT', 'JETON', 'LONG', 'NOTE']);
  assertNoLeak('secrets list', r.stdout + r.stderr + j.stdout + j.stderr);
  assert.equal(statSync(srv.paths.secretsFile).mode & 0o777, 0o600);
});

test('fill secret:NOM : saisi dans la page, masqué dans snap, text, markdown, diff, console, run et rapport', async () => {
  const outs: Array<[string, string]> = [];
  const cli = async (...args: string[]) => {
    const r = await runCli(env, args);
    outs.push([args.join(' '), r.stdout + r.stderr]);
    return r;
  };
  assert.equal((await cli('nav', `${site.url}/coffre`)).code, 0);
  const f = await cli('fill', '#jeton', 'secret:JETON', '--snap-diff', '--console');
  assert.equal(f.code, 0, f.stderr);
  assert.match(f.stdout, /textbox "Jeton"="secret:JETON"/, 'le diff montre le champ rempli, sous le nom du secret');
  assert.match(f.stdout, /saisie secret:JETON/, 'console de l\'action masquée');
  // #court (maxlength=6) : la page peut garder un préfixe de la valeur ; le champ, marqué, reste rendu secret:COURT.
  for (const [sel, name] of [['#mdp', 'JETON'], ['#court', 'COURT'], ['#long', 'LONG']] as const) {
    const r = await cli('fill', sel, `secret:${name}`);
    assert.ok(r.code === 0 || /secret:COURT/.test(r.stderr), r.stderr);
  }
  // Masque de saisie qui tronque à 6 caractères : 409 sans recopier ni la valeur ni la valeur effective (un
  // préfixe), et le champ reste rendu secret:COURT dans les snapshots.
  const masque = await cli('fill', '#masque', 'secret:COURT');
  assert.notEqual(masque.code, 0);
  assert.match(masque.stderr, /la valeur effective \(6 caractère\(s\)\) n'est pas celle de secret:COURT \(9\)/);
  // Valeur reformatée par la page APRÈS la vérification (change → majuscules) : seul le marquage du champ la couvre.
  assert.equal((await cli('fill', '#maj', 'secret:COURT')).code, 0);
  assert.equal((await cli('fill', '#editeur', 'secret:NOTE')).code, 0);
  const snap = await cli('snap');
  assert.match(snap.stdout, /textbox "Jeton"="secret:JETON"/);
  assert.match(snap.stdout, /textbox "Clé longue"="secret:LONG"/, 'valeur longue (coupée à 80) rendue sous son nom');
  assert.match(snap.stdout, /textbox "Code court"="secret:COURT"/);
  assert.match(snap.stdout, /textbox "Code masqué"="secret:COURT"/, 'préfixe gardé par la page, rendu sous le nom du secret');
  assert.match(snap.stdout, /textbox "Code reformaté"="secret:COURT"/, "valeur reformatée par la page, rendue sous le nom du secret");
  assert.match(snap.stdout, /textbox "Note"="secret:NOTE"/, 'éditeur riche');
  assert.match(snap.stdout, /"Note : secret:NOTE"/, 'texte recopié par la page');
  const text = await cli('text');
  assert.match(text.stdout, /Note : secret:NOTE/);
  // Budget de sortie coupant au milieu de ce qui était la valeur : le masquage précède la coupure.
  assert.equal((await cli('text', '--max', String(text.stdout.indexOf('secret:NOTE') + 9))).code, 0);
  await cli('text', '--markdown');
  const cons = await cli('console', '--limit', '200');
  assert.match(cons.stdout, /erreur avec secret:/);
  await cli('console', '--json', '--limit', '200');
  await cli('snap', '--name-max', '0');
  // Formulaire GET : la valeur part dans l'URL et revient dans la page reçue.
  const sub = await cli('click', 'text:Envoyer', '--snap-diff');
  assert.equal(sub.code, 0, sub.stderr);
  assert.match(sub.stdout, /navigation → .*jeton=secret:JETON/);
  const recu = await cli('text');
  assert.match(recu.stdout, /Jeton reçu : secret:JETON/);
  // Secret jamais saisi dans la session, affiché par la page (clé d'API sur une page de réglages) : seul le filet
  // du control plane le connaît.
  const autre = await cli('nav', `${site.url}/coffre-recu?jeton=${encodeURIComponent(AILLEURS)}`);
  assert.equal(autre.code, 0, autre.stderr);
  assert.match((await cli('text')).stdout, /Jeton reçu : secret:AILLEURS/);
  await cli('snap');
  // run : étapes, sorties, rapport de recette (console en erreur, requêtes 4xx) ; texte et JSON.
  const script = `nav ${site.url}/coffre\nfill #jeton secret:JETON --console\nsnap\nexpect value #jeton ~ Jx7\nexpect text "Saisi : Jx7"\nexpect no-console-errors\n`;
  for (const extra of [[], ['--json']]) {
    const r = await runCli(env, ['run', '--continue', ...extra], script);
    outs.push([`run ${extra.join(' ')}`, r.stdout + r.stderr]);
    assert.match(r.stdout + r.stderr, /secret:JETON/);
  }
  for (const [what, s] of outs) assertNoLeak(what, s);
  assertNoLeak('journal du serveur', srv.stderr());
});

test('secret hors de ses domaines : refusé avant toute saisie, sans recopier la valeur', async () => {
  assert.equal((await runCli(env, ['nav', `${site.url}/coffre`])).code, 0);
  const r = await runCli(env, ['fill', '#jeton', 'secret:AILLEURS']);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /secret:AILLEURS réservé à preprod\.exemple\.test : la page courante est sur 127\.0\.0\.1:\d+ — rien n'a été saisi/);
  // Même hôte, autre nom : localhost n'est pas 127.0.0.1.
  const port = new URL(site.url).port;
  assert.equal((await runCli(env, ['nav', `http://localhost:${port}/coffre`])).code, 0);
  const r2 = await runCli(env, ['fill', '#jeton', 'secret:JETON']);
  assert.notEqual(r2.code, 0);
  assert.match(r2.stderr, /secret:JETON réservé à 127\.0\.0\.1/);
  // Le champ est resté vide : vérifié dans la page.
  const v = await runCli(env, ['expect', 'value', '#jeton', '']);
  assert.equal(v.code, 0, v.stderr);
  const unknown = await runCli(env, ['fill', '#jeton', 'secret:INCONNU']);
  assert.notEqual(unknown.code, 0);
  assert.match(unknown.stderr, /secret « INCONNU » inconnu/);
  // Dans run aussi (même route) ; frame=… refusé (le domaine contrôlé est celui de la page).
  const run = await runCli(env, ['run'], 'fill #jeton secret:AILLEURS\n');
  assert.notEqual(run.code, 0);
  assert.match(run.stdout + run.stderr, /réservé à preprod\.exemple\.test/);
  const fr = await runCli(env, ['fill', 'frame=#x >> #y', 'secret:JETON']);
  assert.match(fr.stderr, /iframe \(frame=…\) non prise en charge/);
  for (const s of [r, r2, unknown, run, fr]) assertNoLeak('refus', s.stdout + s.stderr);
});

test('API : secretUse est interne au serveur ; « secret » n\'est accepté que par fill', async () => {
  const a = await srv.api('POST', '/fill', { target: '#jeton', value: 'x', secretUse: { name: 'JETON', domains: ['*'] } }, { 'x-grasp-session': env.GRASP_SESSION! });
  assert.equal(a.status, 400);
  const b = await srv.api('POST', '/type', { target: '#jeton', secret: 'JETON' }, { 'x-grasp-session': env.GRASP_SESSION! });
  assert.equal(b.status, 400);
  assert.match(String(b.json().error), /n'est accepté que par fill/);
});

test('sur disque : rien hors du magasin et du profil Chrome de la session ; profil éphémère effacé à la fermeture', async () => {
  const hits = [...new Set(ALL.flatMap((f) => filesContaining(t.root, f)).filter((p) => p !== srv.paths.secretsFile))];
  // Journaux du serveur et de Chrome, état, captures, config : rien. Le profil Chrome, lui, garde ce que Chrome garde de
  // tout formulaire envoyé (cache HTTP de la page qui recopie la valeur, saisie semi-automatique « Web Data », Sessions).
  const outsideProfile = hits.filter((p) => !/\/tmp-profiles\/[^/]+\//.test(p));
  assert.deepEqual(outsideProfile, []);
  const closed = await runCli(env, ['session', 'close', env.GRASP_SESSION!]);
  assert.equal(closed.code, 0, closed.stderr);
  const after = [...new Set(ALL.flatMap((f) => filesContaining(t.root, f)).filter((p) => p !== srv.paths.secretsFile))];
  assert.deepEqual(after, [], 'profil éphémère supprimé à la fermeture');
  assertNoLeak('journal du serveur', srv.stderr());
});

test('magasin trop ouvert : refus de démarrer (comme la config), sans valeur dans le message', async () => {
  const t2 = makeTestEnv();
  try {
    const r = await runCli(t2.env, ['secrets', 'set', 'X', '--domains', '127.0.0.1'], 'valeur-xyz\n');
    assert.equal(r.code, 0, r.stderr);
    chmodSync(join(t2.env.XDG_CONFIG_HOME!, 'grasp', 'secrets.json'), 0o644);
    await assert.rejects(startServer(t2.env), (e: Error) => /secrets\.json est en 0644/.test(e.message) && !e.message.includes('valeur-xyz'));
  } finally { t2.cleanup(); }
});
