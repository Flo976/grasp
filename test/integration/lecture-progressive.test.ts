import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openPage, type PageFixture } from '../helpers/chrome.js';
import { startTestSite, type TestSite } from '../helpers/testsite.js';
import { makeTestEnv } from '../helpers/env.js';
import { startServer, runCli, waitExit } from '../helpers/server.js';
import { compileFind } from '../../src/bridge/snapshot.js';
import { GraspError } from '../../src/core/errors.js';

/**
 * Lecture progressive contre un vrai Chrome : `snap --outline`, `snap --interactive`, `find`, sur la grosse page
 * /portail du site de test. Refs identiques au snapshot complet, actions par ces refs vérifiées par le contenu de
 * la page, et octets mesurés (diagnostics du test : repris dans le README).
 */

let site: TestSite;
let fx: PageFixture;
before(async () => { site = await startTestSite(); fx = await openPage(); });
after(async () => { await fx.close(); await site.close(); });

const bytes = (s: string) => Buffer.byteLength(s);
const refLine = (s: string, re: RegExp): string => {
  const l = s.split('\n').find((x) => re.test(x));
  assert.ok(l, `aucune ligne ${re} dans :\n${s}`);
  return l.trim().split(':')[0]!;
};
/** ref → ligne (sans indentation ni suffixe), pour comparer aux lignes du snapshot complet. */
const lineByRef = (s: string) => new Map(s.split('\n').map((l) => /^\s*(e[0-9a-z]+):(.*)$/.exec(l)).filter((m) => m !== null).map((m) => [m![1]!, m![2]!]));

test('portail : outline, interactive et find gardent les refs du snapshot complet ; octets mesurés', async (t) => {
  await fx.page.navigate(`${site.url}/portail`);
  const full = (await fx.page.snapshot({ maxBytes: 10_000_000 })).text;
  const def = (await fx.page.snapshot()).text;
  const outline = (await fx.page.snapshot({ mode: 'outline' })).text;
  const inter = (await fx.page.snapshot({ mode: 'interactive' })).text;
  const interAll = (await fx.page.snapshot({ mode: 'interactive', maxBytes: 10_000_000 })).text;
  const findPays = (await fx.page.snapshot({ find: { pattern: compileFind('madagascar') } })).text;
  const findAnnuler = (await fx.page.snapshot({ find: { pattern: compileFind('/Commande 101\\d/'), roles: ['row'] } })).text;

  const fullRefs = lineByRef(full);
  for (const [name, s] of [['outline', outline], ['interactive', interAll], ['find', findPays], ['find row', findAnnuler]] as const) {
    for (const [ref, line] of lineByRef(s)) {
      // Une ligne de repère porte en plus le volume de son contenu ; une ligne trouvée, son conteneur.
      const base = line.replace(/ — \d+ lignes?, \d+ actionnables?$/, '').replace(/ \(dans e[0-9a-z]+:.*\)$/, '');
      if (name === 'find' && /:option /.test(`${ref}:${line}`)) continue; // option d'un select fermé : pas de ligne dans le complet
      assert.equal(fullRefs.get(ref), base, `${name} : ${ref}`);
    }
  }
  // Repères et titres seulement, avec leur volume.
  assert.match(outline, /:navigation "Menu principal" — 60 lignes, 60 actionnables/);
  assert.match(outline, /:main — \d+ lignes, \d+ actionnables/);
  assert.match(outline, /:heading\[2\] "Mes commandes"/);
  assert.match(outline, /:table "Commandes" — \d+ lignes, 40 actionnables/);
  assert.match(outline, /\n {1}… \+40 titres de niveau 3 \(find --role heading pour les lister\)\n/, 'fiches au-delà de 8 comptées');
  assert.doesNotMatch(outline, /:link |:button |Description du produit/);
  // Interactive : le texte brut a disparu, les boutons sont situés par leur fiche ou leur ligne.
  assert.doesNotMatch(interAll, /Description du produit/);
  // Le titre qui répète le nom de sa fiche n'est pas répété.
  assert.match(interAll, /:article "Casques modèle 1"\n\s+e[0-9a-z]+:button "Ajouter au panier"\n\s+e[0-9a-z]+:link "Voir la fiche"/);
  assert.match(interAll, /:row "Commande 1012"\n\s+e[0-9a-z]+:button "Annuler"/);
  // find : l'option d'un select fermé de 120 pays (hors budget du snapshot par défaut) est trouvée, avec sa liste.
  assert.match(findPays, /^page "Portail vélo" .*\nfind « madagascar » : 1 correspondance\ne[0-9a-z]+:option "Madagascar" \(dans e[0-9a-z]+:combobox "Pays"\)$/);
  assert.doesNotMatch(def, /Madagascar/, 'le snapshot par défaut (12 000 octets) ne va pas jusqu\'au formulaire');
  assert.match(findAnnuler, /: 10 correspondances/);

  const m = { complet: bytes(full), defaut: bytes(def), outline: bytes(outline), interactive: bytes(interAll), interactiveDefaut: bytes(inter), find: bytes(findPays), findRow: bytes(findAnnuler) };
  t.diagnostic(`octets ${JSON.stringify(m)}`);
  t.diagnostic(`lignes complet=${full.split('\n').length} outline=${outline.split('\n').length} interactive=${interAll.split('\n').length}`);
  assert.ok(m.outline * 10 < m.complet, `outline ${m.outline} vs complet ${m.complet}`);
  assert.ok(m.interactive < m.complet && m.find < 300);
});

test('portail : agir par les refs de find et --interactive, résultat vérifié dans la page', async () => {
  await fx.page.navigate(`${site.url}/portail`);
  const f = (await fx.page.snapshot({ find: { pattern: compileFind('ville'), roles: ['textbox'] } })).text;
  const ville = refLine(f, /:textbox "Ville"/);
  await fx.page.fill(ville, 'Antananarivo');
  assert.match((await fx.page.snapshot({ find: { pattern: compileFind('antananarivo') } })).text, new RegExp(`^${ville}:textbox "Ville"="Antananarivo"`, 'm'));
  // Option trouvée par find → select par la ref de la liste, valeur relue dans la page.
  const pays = (await fx.page.snapshot({ find: { pattern: compileFind('madagascar') } })).text;
  const liste = /\(dans (e[0-9a-z]+):combobox "Pays"\)/.exec(pays)![1]!;
  await fx.page.select(liste, 'Madagascar');
  assert.match((await fx.page.snapshot({ mode: 'interactive', scope: liste })).text, /:combobox "Pays"="Madagascar"/);
  // Zone + mode : seulement les actionnables du formulaire, refs identiques.
  const z = (await fx.page.snapshot({ mode: 'interactive', scope: 'form[aria-label="Livraison"]' })).text;
  assert.match(z, /:form "Livraison"/);
  assert.ok(z.includes(`${ville}:textbox "Ville"="Antananarivo"`), z);
  assert.doesNotMatch(z, /Ajouter au panier/);
  // Une zone frame=… n'a pas de refs : refusé, jamais ignoré.
  await assert.rejects(fx.page.snapText({ scope: 'frame=#x', mode: 'outline' }), (e: GraspError) => e.status === 400 && /frame=/.test(e.message));
});

test('CLI et run : snap --outline / --interactive, find (texte, /regex/, --role, --max), erreurs explicites', async () => {
  const env0 = makeTestEnv();
  const srv = await startServer(env0.env);
  try {
    const id = (await runCli(env0.env, ['session', 'create'])).stdout.trim();
    const env = { ...env0.env, GRASP_SESSION: id };
    const ok = async (args: string[], input?: string) => { const r = await runCli(env, args, input); assert.equal(r.code, 0, `${args.join(' ')} : ${r.stderr}`); return r.stdout; };
    await ok(['nav', `${site.url}/portail`]);
    const outline = await ok(['snap', '--outline']);
    assert.match(outline, /^page "Portail vélo" /);
    assert.match(outline, /… lecture partielle \(--outline\) : \d+ lignes sur \d+/);
    const inter = await ok(['snap', '--interactive', '--scope', 'aside']);
    assert.match(inter, /:complementary "Filtres"\n e[0-9a-z]+:checkbox "Vélos" \[ \]/);
    const f = await ok(['find', 'Annuler', '--role', 'button', '--max', '3']);
    assert.match(f, /find « Annuler » --role button : 40 correspondances\n(e[0-9a-z]+:button "Annuler" \(dans e[0-9a-z]+:row "Commande 100\d"\)\n){3}… 37 autres correspondances/);
    assert.match(await ok(['find', '/^Rubrique 5\\d$/']), /: 10 correspondances/);
    // run : même syntaxe ; la ref trouvée sert à l'étape suivante (ici par text:, la ref change à chaque page).
    const run = await ok(['run'], 'find "Valider la livraison"\nfill text:Adresse "1 rue Ada"\nfind "1 rue Ada" --role textbox\n');
    assert.match(run, /\[1\] find "Valider la livraison" → OK\n.*\nfind « Valider la livraison » : 1 correspondance\ne[0-9a-z]+:button "Valider la livraison" \(dans e[0-9a-z]+:form "Livraison"\)/);
    assert.match(run, /:textbox "Adresse"="1 rue Ada"/);
    // Erreurs : jamais ignorées.
    for (const [args, re] of [
      [['snap', '--outline', '--interactive'], /exclusifs/],
      [['find'], /usage : grasp find/],
      [['find', '/a/g'], /drapeau/],
      [['find', 'x', '--max', '0'], /entier positif/],
      [['text', '--interactive'], /ne s'applique qu'à snap/],
    ] as const) {
      const r = await runCli(env, [...args]);
      assert.equal(r.code, 1, args.join(' '));
      assert.match(r.stderr, re);
    }
    const bad = await runCli(env, ['run'], 'find x --markdown\n');
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /option --markdown inconnue pour find/);
  } finally { srv.proc.kill('SIGTERM'); await waitExit(srv.proc); env0.cleanup(); }
});
