import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { makeTestEnv } from '../helpers/env.js';
import { CLI, startServer, runCli, waitExit } from '../helpers/server.js';
import { startTestSite } from '../helpers/testsite.js';
import { resolvePaths } from '../../src/core/paths.js';

/**
 * Recette mobile sans eval (retour 4 du deuxième essai réel) : en 360x800 --mobile, une page dont un bandeau de
 * 520 px fait déborder la largeur, dont une image décorative (alt="", hors arbre d'accessibilité) est rognée par
 * sa carte overflow:hidden, avec un bouton correct, un bloc correct 2000 px plus bas et un tableau large dans un
 * conteneur qui défile. expect in-viewport / not-clipped / no-horizontal-overflow, --boxes de find et snap, en
 * CLI, dans run, dans history --as-run et par MCP.
 */
test('mise en page mobile : expect in-viewport, not-clipped, no-horizontal-overflow et --boxes (CLI, run, history, MCP)', async () => {
  const t = makeTestEnv();
  const site = await startTestSite();
  const paths = resolvePaths(t.env, t.env.HOME!);
  mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
  writeFileSync(paths.configFile, JSON.stringify({ allowedDomains: ['127.0.0.1'] }), { mode: 0o600 });
  const srv = await startServer(t.env);
  try {
    const id = (await runCli(t.env, ['session', 'create', '--viewport', '360x800', '--mobile'])).stdout.trim();
    const env = { ...t.env, GRASP_SESSION: id };
    const ok = async (args: string[], input?: string) => { const r = await runCli(env, args, input); assert.equal(r.code, 0, `${args.join(' ')} : ${r.stdout}${r.stderr}`); return r; };
    const ko = async (args: string[], re: RegExp) => {
      const r = await runCli(env, args);
      assert.equal(r.code, 1, `${args.join(' ')} devait échouer : ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, re, args.join(' '));
      return r;
    };
    await ok(['nav', `${site.url}/mise-en-page`]);

    // Débordement horizontal de la page : le bandeau est cité ; le tableau de 700 px dans son conteneur qui
    // défile ne l'est pas (il ne fait pas défiler la page).
    const over = await ko(['expect', 'no-horizontal-overflow', '--timeout', '0'], /^ERROR: expect: attendu aucun débordement horizontal de la page ; constaté : largeur du document 520 px > viewport 360 px \(\+160 px\) ; 1 élément\(s\) dépassent : div#bandeau\.bandeau\.promo x=0 largeur 520 \(\+160 px\)$/m);
    assert.doesNotMatch(over.stderr, /table/);

    // Image alt="" (hors arbre a11y), désignée en CSS : rognée par sa carte (la part visible tient dans le
    // viewport) ; sa boîte, elle, dépasse la largeur du viewport.
    await ko(['expect', 'not-clipped', '#photo', '--timeout', '0'], /^ERROR: expect: attendu élément #photo non rogné \(ni par un ancêtre overflow hidden\/clip, ni par le bord du viewport\) ; constaté : boîte x=20 y=\d+ 400x200 ; rogné par div\.carte \(overflow hidden, zone x=20 y=\d+ 300x150\) : 100 px à droite, 50 px en bas$/m);
    await ko(['expect', 'in-viewport', '#photo', '--timeout', '0'], /^ERROR: expect: attendu élément #photo dans la largeur du viewport ; constaté : boîte x=20 y=\d+ 400x200 ; viewport 360x800 : dépasse de 60 px à droite$/m);
    await ko(['expect', 'not-clipped', '#bandeau', '--timeout', '0'], /constaté : boîte x=0 y=0 520x40 ; dépasse la largeur du viewport \(360 px\) de 160 px à droite$/m);

    // Éléments corrects : CSS, text:, et un bloc plus bas (dans la largeur ; --fully exige qu'il soit visible sans défiler).
    await ok(['expect', 'in-viewport', '#valider', '--timeout', '0']);
    await ok(['expect', 'not-clipped', 'text:Valider', '--timeout', '0']);
    await ok(['expect', 'in-viewport', '#loin', '--timeout', '0']);
    await ko(['expect', 'in-viewport', '#loin', '--fully', '--timeout', '0'], /attendu élément #loin entièrement dans le viewport \(sans défiler\) ; constaté : boîte x=0 y=\d+ 300x50 ; viewport 360x800 : dépasse de \d+ px en bas$/m);
    await ok(['expect', 'in-viewport', '#valider', '--fully', '--timeout', '0']);
    // Tableau large dans un conteneur overflow-x:auto : pas rogné (on y défile), mais pas dans la largeur du viewport.
    await ok(['expect', 'not-clipped', 'table', '--timeout', '0']);
    await ko(['expect', 'in-viewport', 'table', '--timeout', '0'], /constaté : boîte x=\d+ y=\d+ 700x\d+ ; viewport 360x800 : dépasse de \d+ px à droite$/m);
    // Élément non rendu, absent, ambigu.
    await ko(['expect', 'not-clipped', '#cache', '--timeout', '0'], /constaté : aucune boîte : élément non rendu/);
    await ko(['expect', 'in-viewport', '#absent', '--timeout', '0'], /constaté : aucun élément ne correspond à #absent$/m);
    await ko(['expect', 'in-viewport', 'td', '--timeout', '0'], /2 éléments correspondent à td : nth=0 td @\d+,\d+ \d+x\d+ → .* ; nth=1 td .* — choisissez un de ces sélecteurs, ou ajoutez ` >> nth=N`/);
    // Syntaxe refusée avant tout appel.
    await ko(['expect', 'not-clipped', '#photo', '--fully'], /--fully ne s'applique pas à expect not-clipped/);
    await ko(['text', '--boxes'], /--boxes ne s'applique qu'à snap et find/);

    // --boxes : position et taille par ligne à ref ; la ref sert ensuite d'expect (même résolution que les actions).
    const find = (await ok(['find', 'Valider', '--boxes'])).stdout;
    assert.match(find, /^boîtes : @x,y LxH en px CSS, coin haut-gauche dans le document \(défilement compris\) ; layout 360x800$/m);
    const line = /^(e[0-9a-z]+):button "Valider" @20,\d+ 200x40$/m.exec(find);
    assert.ok(line !== null, find);
    const snap = (await ok(['snap', '--interactive', '--boxes'])).stdout;
    assert.match(snap, new RegExp(`^${line[1]}:button "Valider" @20,\\d+ 200x40$`, 'm'));
    assert.match(snap, /:heading\[1\] "Fiche produit" @0,\d+ 360x\d+$/m);
    assert.doesNotMatch((await ok(['snap', '--interactive'])).stdout, /@\d/, 'sans --boxes : aucune boîte');
    await ok(['expect', 'in-viewport', line[1]!, '--fully', '--timeout', '0']);
    await ok(['expect', 'not-clipped', line[1]!]);

    // history --as-run : les assertions tenues sont gardées, la ref traduite en sélecteur durable ; échecs omis.
    const asRun = (await ok(['history', '--as-run'])).stdout;
    assert.match(asRun, /^expect in-viewport text:Valider --timeout 0 --fully$/m);
    assert.match(asRun, /^expect not-clipped text:Valider$/m);
    assert.match(asRun, /^expect in-viewport #loin --timeout 0$/m);
    assert.match(asRun, /^expect not-clipped table --timeout 0$/m);
    assert.doesNotMatch(asRun, /^(expect .*(#photo|#bandeau)|expect no-horizontal-overflow|find|snap)\b/m);
    assert.match(asRun, /^# Omis : 9 commande\(s\) en échec/m);

    // Assertion relue : la mise en page se corrige après 600 ms, l'assertion (délai par défaut 5000 ms) passe.
    await ok(['nav', `${site.url}/mise-en-page?tardif=1`]);
    await ok(['expect', 'no-horizontal-overflow']);
    // body { overflow-x: hidden } : la page ne défile pas, mais le bandeau est rogné — échec qui le dit.
    await ok(['nav', `${site.url}/mise-en-page?masque=1`]);
    await ko(['expect', 'no-horizontal-overflow', '--timeout', '0'], /div#bandeau\.bandeau\.promo x=0 largeur 520 \(\+160 px\) ; viewport en overflow-x hidden : la page ne défile pas mais ce contenu est rogné$/m);
    await ok(['nav', `${site.url}/mise-en-page?propre=1`]);
    await ok(['expect', 'no-horizontal-overflow', '--timeout', '0']);

    // Dans un run : même syntaxe, arrêt sur l'échec avec le message complet.
    const run = await runCli(env, ['run'], `nav ${site.url}/mise-en-page\nexpect in-viewport '#valider'\nexpect not-clipped '#photo' --timeout 0\nexpect no-horizontal-overflow\n`);
    assert.equal(run.code, 1, run.stdout + run.stderr);
    assert.match(run.stdout, /\[2\] expect in-viewport '#valider' → OK/);
    assert.match(run.stdout, /\[3\] expect not-clipped '#photo' --timeout 0 → ERROR: attendu élément #photo non rogné .* rogné par div\.carte \(overflow hidden, zone x=20 y=\d+ 300x150\) : 100 px à droite, 50 px en bas/);

    // MCP : find boxes=true, et une recette run avec l'assertion de débordement.
    const mcp = spawn(process.execPath, [CLI, 'mcp', '--session', id, '--no-serve'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const replies = new Map<number, (m: any) => void>();
    let buf = '';
    mcp.stdout.setEncoding('utf8');
    mcp.stdout.on('data', (d: string) => {
      buf += d;
      for (let i; (i = buf.indexOf('\n')) >= 0;) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); replies.get(m.id)?.(m); }
    });
    let n = 0;
    const rpc = (method: string, params: unknown) => new Promise<any>((resolve) => { const k = ++n; replies.set(k, resolve); mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: k, method, params })}\n`); });
    try {
      await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
      const tools = (await rpc('tools/list', {})).result.tools as Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }>;
      for (const name of ['snap', 'find']) assert.ok(tools.find((x) => x.name === name)!.inputSchema.properties.boxes, `${name} : boxes`);
      const f = await rpc('tools/call', { name: 'find', arguments: { pattern: 'Valider', boxes: true } });
      assert.match(f.result.content[0].text, /:button "Valider" @20,\d+ 200x40$/m);
      const r = await rpc('tools/call', { name: 'run', arguments: { script: 'expect no-horizontal-overflow --timeout 0', report: false } });
      assert.equal(r.result.isError, true);
      assert.match(r.result.content[0].text, /attendu aucun débordement horizontal de la page ; constaté : largeur du document 520 px > viewport 360 px/);
      // Outil expect : la syntaxe CLI telle quelle, sans run d'une ligne.
      const e1 = await rpc('tools/call', { name: 'expect', arguments: { assertion: "in-viewport '#valider'" } });
      assert.equal(e1.result.isError, undefined, JSON.stringify(e1));
      assert.match(e1.result.content[0].text, /^OK/);
      const e2 = await rpc('tools/call', { name: 'expect', arguments: { assertion: "not-clipped '#photo' --timeout 0" } });
      assert.equal(e2.result.isError, true);
      assert.match(e2.result.content[0].text, /rogné par div\.carte .*100 px à droite/);
      const e3 = await rpc('tools/call', { name: 'expect', arguments: { assertion: "text a\ntext b" } });
      assert.equal(e3.result.isError, true);
      assert.match(e3.result.content[0].text, /une seule ligne/);
      const e4 = await rpc('tools/call', { name: 'expect', arguments: { assertion: 'text x --frobnicate' } });
      assert.equal(e4.result.isError, true);
      // CSS ambigu par MCP : les candidats du message, sans ligne « candidats : undefined … ».
      const e5 = await rpc('tools/call', { name: 'expect', arguments: { assertion: 'in-viewport td --timeout 0' } });
      assert.equal(e5.result.isError, true);
      assert.match(e5.result.content[0].text, /2 éléments correspondent à td : nth=0 td @/);
      assert.doesNotMatch(e5.result.content[0].text, /undefined/);
    } finally { mcp.stdin.end(); await waitExit(mcp); }
  } finally { srv.proc.kill('SIGTERM'); await waitExit(srv.proc); await site.close(); t.cleanup(); }
});

/**
 * Cas limites de la mesure (page `/geometrie`, 360x800 SANS --mobile puis avec) : élément fixe après un
 * défilement horizontal (jugé dans le viewport, boîte « fixe »), absolu qui échappe à un ancêtre overflow:hidden
 * non positionné, fixe qui échappe à tout ancêtre non transformé, débordement cité une fois par élément le plus
 * externe (descendant plus large : « contenu jusqu'à »), éléments fixes hors du débordement de la page,
 * visibility:hidden sans boîte, débordement venu d'une racine fantôme ouverte, et indice du viewport de mise en
 * page élargi en --mobile.
 */
test('géométrie : fixe défilé, absolu et fixe hors des ancêtres, dédoublonnage, ombre, visibility:hidden', async () => {
  const t = makeTestEnv();
  const site = await startTestSite();
  const paths = resolvePaths(t.env, t.env.HOME!);
  mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
  writeFileSync(paths.configFile, JSON.stringify({ allowedDomains: ['127.0.0.1'] }), { mode: 0o600 });
  const srv = await startServer(t.env);
  try {
    const id = (await runCli(t.env, ['session', 'create', '--viewport', '360x800'])).stdout.trim();
    const env = { ...t.env, GRASP_SESSION: id };
    const ok = async (args: string[], e: NodeJS.ProcessEnv = env) => { const r = await runCli(e, args); assert.equal(r.code, 0, `${args.join(' ')} : ${r.stdout}${r.stderr}`); return r; };
    const ko = async (args: string[], re: RegExp, e: NodeJS.ProcessEnv = env) => {
      const r = await runCli(e, args);
      assert.equal(r.code, 1, `${args.join(' ')} devait échouer : ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, re, args.join(' '));
      return r;
    };
    await ok(['nav', `${site.url}/geometrie`]);

    // Un seul élément cité : #large (ses descendants qui dépassent allongent « contenu jusqu'à »), ni la bande
    // fixe de 500 px ni l'en-tête fixe.
    await ko(['expect', 'no-horizontal-overflow', '--timeout', '0'], /constaté : largeur du document 700 px > viewport 360 px \(\+340 px\) ; 1 élément\(s\) dépassent : div#large x=0 largeur 600, contenu jusqu'à x=700 \(\+340 px\)$/m);
    // Absolu dans un ancêtre overflow:hidden non positionné : il en échappe ; positionné : rogné.
    await ok(['expect', 'not-clipped', '#abs', '--timeout', '0']);
    await ko(['expect', 'not-clipped', '#abs2', '--timeout', '0'], /rogné par div\.coupe-pos \(overflow hidden, zone x=0 y=\d+ 100x50\) : 100 px à droite$/m);
    // Fixe dans un ancêtre overflow:hidden : il en échappe ; dans un ancêtre transformé : rogné.
    await ok(['expect', 'not-clipped', '#fix', '--timeout', '0']);
    await ko(['expect', 'not-clipped', '#fix2', '--timeout', '0'], /rogné par div\.coupe-tr \(overflow hidden, zone x=0 y=\d+ 100x50\) : 50 px à droite$/m);
    // visibility:hidden : pas de boîte.
    await ko(['expect', 'in-viewport', '#invisible', '--timeout', '0'], /constaté : aucune boîte : élément non rendu \(display:none, visibility:hidden/);

    // Défilement horizontal (le clic amène le bouton à x=500 dans la vue) : l'en-tête fixe et son bouton restent
    // dans le viewport, jugés tels quels, boîte « fixe » en coordonnées du viewport.
    await ok(['click', '#loin-droite']);
    await ok(['expect', 'in-viewport', '#loin-droite', '--fully', '--timeout', '0']);
    await ok(['expect', 'in-viewport', '#m', '--timeout', '0']);
    await ok(['expect', 'in-viewport', '#m', '--fully', '--timeout', '0']);
    await ok(['expect', 'not-clipped', '#hdr', '--timeout', '0']);
    assert.match((await ok(['find', 'Menu', '--boxes'])).stdout, /^e[0-9a-z]+:button "Menu" @310,0 50x20 fixe$/m);
    assert.match((await ok(['find', 'Droite', '--boxes'])).stdout, /^e[0-9a-z]+:button "Droite" (\[focus\] )?@500,50 60x20$/m);
    await ko(['expect', 'in-viewport', '#bande', '--timeout', '0'], /constaté : boîte fixe x=0 y=100 500x10 ; viewport 360x\d+ : dépasse de 140 px à droite$/m);

    // Débordement venu d'une racine fantôme ouverte : l'élément est cité avec son hôte.
    await ok(['nav', `${site.url}/geometrie?ombre=1`]);
    await ko(['expect', 'no-horizontal-overflow', '--timeout', '0'], /1 élément\(s\) dépassent : div#hote » div\.dedans x=0 largeur 600 \(\+240 px\)$/m);

    // --mobile : la page qui déborde élargit le viewport de mise en page ; l'en-tête fixe à 100 % s'élargit avec,
    // et le message renvoie à la cause.
    const id2 = (await runCli(t.env, ['session', 'create', '--viewport', '360x800', '--mobile'])).stdout.trim();
    const env2 = { ...t.env, GRASP_SESSION: id2 };
    await ok(['nav', `${site.url}/geometrie?mobile=1`], env2);
    await ko(['expect', 'in-viewport', '#hdr', '--timeout', '0'], /constaté : boîte fixe x=0 y=0 520x40 ; viewport 360x800 : dépasse de 160 px à droite \(élément fixe : la page déborde et Chrome a élargi le viewport de mise en page à 520 px — cause à chercher avec expect no-horizontal-overflow\)$/m, env2);
    await ko(['expect', 'no-horizontal-overflow', '--timeout', '0'], /1 élément\(s\) dépassent : div#large520 x=0 largeur 520 \(\+160 px\)$/m, env2);
  } finally { srv.proc.kill('SIGTERM'); await waitExit(srv.proc); await site.close(); t.cleanup(); }
});
