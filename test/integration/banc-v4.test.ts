import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openPage, type PageFixture } from '../helpers/chrome.js';
import { startTestSite, LIVRES_TITRES, type TestSite } from '../helpers/testsite.js';
import { makeTestEnv } from '../helpers/env.js';
import { startServer, runCli, waitExit } from '../helpers/server.js';

/**
 * Banc v4 sur sites réels : cases à cocher sans libellé (texte qui suit), champ remplacé après la saisie
 * (Wikipédia), page jamais stable (Amazon), noms tronqués (titres de livres), compte « lignes plus
 * anciennes » de la console après --clear.
 */

let site: TestSite;
let fx: PageFixture;
before(async () => { site = await startTestSite(); fx = await openPage(); });
after(async () => { await fx.close(); await site.close(); });

const lines = (text: string) => text.split('\n').map((l) => l.trim());
const line = (text: string, re: RegExp) => lines(text).find((l) => re.test(l)) ?? '';
const refOf = (text: string, re: RegExp): string => {
  const l = line(text, re);
  assert.ok(l, `aucune ligne ${re} dans :\n${text}`);
  return l.split(':')[0]!;
};
/** État [x] / [ ] de la case nommée par son contexte « checkbox N ». */
const etatCase = async (n: number) => line((await fx.page.snapshot()).text, new RegExp(`checkbox .*"checkbox ${n}"`)).replace(/^.*\)/, '').replace(' [focus]', '').trim();

// ---------- 1. Case à cocher sans nom : le texte qui la suit est son libellé ----------

test('case à cocher / radio sans nom : nommée par le texte qui la SUIT ; croix de tag : texte qui précède', async () => {
  await fx.page.navigate(`${site.url}/cases`);
  const s = (await fx.page.snapshot()).text;
  const c1 = refOf(s, /checkbox \(sans nom, près de "checkbox 1"\)/);
  const c2 = refOf(s, /checkbox \(sans nom, près de "checkbox 2"\) \[x\]$/);
  assert.notEqual(c1, c2);
  assert.match(s, /radio \(sans nom, près de "Domicile"\)/, s);
  assert.match(s, /radio \(sans nom, près de "Relais"\)/, s);
  assert.match(s, /button \(sans nom, près de "Rust"\)/, s);
});

test('text:checkbox 2 désigne la 2e case (pas le nœud texte, pas la 1re case)', async () => {
  await fx.page.navigate(`${site.url}/cases`);
  await fx.page.click('text:checkbox 2');
  assert.equal(await etatCase(2), '[ ]', 'la 2e case est décochée');
  assert.equal(await etatCase(1), '[ ]', 'la 1re case est intacte');
  await fx.page.check('text:checkbox 1', true);
  assert.equal(await etatCase(1), '[x]');
});

// ---------- 2. Élément remplacé pendant l'observation post-action ----------

test('fill sur un champ remplacé par un nouveau nœud (autre rôle) : signalé, et l\'ancienne ref vise le remplaçant focalisé', async () => {
  await fx.page.navigate(`${site.url}/remplace?role=combobox`);
  const s = (await fx.page.snapshot()).text;
  const q = refOf(s, /searchbox "Rechercher"/);
  const r = await fx.page.fill(q, 'chat');
  assert.match(r.detail ?? '', /l'élément a été remplacé par e[0-9a-z]+ combobox "Rechercher"/, r.detail);
  const p = await fx.page.press('Enter', q);
  assert.match(p.detail ?? '', new RegExp(`ref ${q} .*remplac.*e[0-9a-z]+`), p.detail);
  assert.equal((await fx.page.text(undefined, '#etat')).trim(), 'Recherche : chat');
});

test('fill sur un champ remplacé à l\'identique : signalé (même ref), la ref reste utilisable', async () => {
  await fx.page.navigate(`${site.url}/remplace`);
  const s = (await fx.page.snapshot()).text;
  const q = refOf(s, /searchbox "Rechercher"/);
  const r = await fx.page.fill(q, 'chien');
  assert.match(r.detail ?? '', new RegExp(`l'élément a été remplacé par ${q} searchbox "Rechercher"`), r.detail);
  await fx.page.press('Enter', q);
  assert.equal((await fx.page.text(undefined, '#etat')).trim(), 'Recherche : chien');
});

test('fill ordinaire : aucune note de remplacement', async () => {
  await fx.page.navigate(`${site.url}/`);
  const r = await fx.page.fill('#nom', 'Ada');
  assert.doesNotMatch(r.detail ?? '', /remplacé/);
});

// ---------- 3. Stabilité « suffisante » : animations continues de faible ampleur ----------

test('nav sur une page à carrousel perpétuel : main rendue en < 1,5 s, sans note « DOM instable »', async () => {
  const t0 = Date.now();
  const r = await fx.page.nav(`${site.url}/carrousel`);
  const ms = Date.now() - t0;
  assert.ok(ms < 1500, `nav en ${ms} ms`);
  assert.doesNotMatch(r.detail ?? '', /instable/, r.detail);
});

test('nav : un gros contenu ajouté à 800 ms est attendu, même avec un carrousel qui tourne', async () => {
  await fx.page.nav(`${site.url}/carrousel?gros=1`);
  const s = await fx.page.snapshot({ maxBytes: 100_000 });
  assert.match(s.text, /"Article n°299"/);
});

// ---------- 4. Troncature des noms : --name-max ----------

test('snapshot : noms longs tronqués par « … » par défaut ; nameMax 0 = entier ; nameMax N', async () => {
  await fx.page.navigate(`${site.url}/livres`);
  const def = (await fx.page.snapshot()).text;
  const l0 = line(def, /link "Le Seigneur/);
  assert.match(l0, /…"$/, l0);
  assert.ok(!def.includes(LIVRES_TITRES[0]!), def);
  assert.match(def, /link "Court"$/m);
  const full = (await fx.page.snapshot({ nameMax: 0 })).text;
  for (const t of LIVRES_TITRES) assert.ok(full.includes(`link "${t}"`), `${t} absent de :\n${full}`);
  const court = (await fx.page.snapshot({ nameMax: 30 })).text;
  const l1 = line(court, /link "Le Seigneur/);
  assert.equal(l1.replace(/^e[0-9a-z]+:link /, ''), `"${LIVRES_TITRES[0]!.slice(0, 29)}…"`);
  // Les refs ne dépendent pas de la troncature.
  assert.equal(refOf(court, /link "Le Seigneur/), refOf(full, /link "Le Seigneur/));
  await assert.rejects(fx.page.snapshot({ nameMax: -1 }), /name-max/);
});

test('CLI et run : snap --name-max N', async () => {
  const t = makeTestEnv();
  const srv = await startServer(t.env);
  try {
    const id = (await runCli(t.env, ['session', 'create'])).stdout.trim();
    const env = { ...t.env, GRASP_SESSION: id };
    assert.equal((await runCli(env, ['nav', `${site.url}/livres`])).code, 0);
    const full = await runCli(env, ['snap', '--name-max', '0']);
    assert.equal(full.code, 0, full.stderr);
    assert.ok(full.stdout.includes(LIVRES_TITRES[0]!), full.stdout);
    const bad = await runCli(env, ['snap', '--name-max', 'abc']);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /name-max/);
    const run = await runCli(env, ['run', '-'], `snap --name-max 0\n`);
    assert.equal(run.code, 0, run.stderr);
    assert.ok(run.stdout.includes(LIVRES_TITRES[1]!), run.stdout);
    const help = await runCli(env, ['help']);
    assert.match(help.stdout + help.stderr, /--name-max/);
  } finally { srv.proc.kill('SIGTERM'); await waitExit(srv.proc); t.cleanup(); }
});

// ---------- 5. Console : rien d'antérieur à --clear, --level ne compte que son niveau ----------

test('console --clear puis nav puis --level error : aucune ligne « plus ancienne » fantôme', async () => {
  await fx.page.navigate(`${site.url}/console-bruit`);
  await fx.page.consoleQuery({ clear: true });
  await fx.page.navigate(`${site.url}/console-spa`);
  await new Promise((r) => setTimeout(r, 200));
  const r = await fx.page.consoleQuery({ level: 'error', limit: 50 });
  assert.equal(r.omitted, 0, `omitted=${r.omitted}`);
  assert.deepEqual(r.entries.filter((e) => e.source !== 'navigation').map((e) => e.text), ['erreur A', 'erreur B', 'erreur C']);
  assert.ok(!r.entries.some((e) => /ancienne/.test(e.text)));
  // --limit ne compte que les lignes du niveau demandé : 1 erreur écartée sur 3.
  const l2 = await fx.page.consoleQuery({ level: 'error', limit: 2 });
  assert.equal(l2.omitted, 1);
  assert.deepEqual(l2.entries.filter((e) => e.source !== 'navigation').map((e) => e.text), ['erreur B', 'erreur C']);
});
