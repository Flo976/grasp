import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { makeTestEnv } from '../helpers/env.js';
import { startServer, runCli, waitExit } from '../helpers/server.js';
import { startTestSite } from '../helpers/testsite.js';
import { imageSize } from '../../src/core/image.js';
import { resolvePaths } from '../../src/core/paths.js';

/**
 * Moteur WebKit (mode minimal). Ces tests lancent le WebKit de Playwright : s'il n'est pas installé sur le poste
 * (build absent, bibliothèques système manquantes), ils sont SAUTÉS avec la raison — jamais verts à tort.
 */
async function probe(): Promise<string | undefined> {
  try {
    const pw = await import('playwright-core') as unknown as { webkit: { launch(o: object): Promise<{ close(): Promise<void> }> } };
    const b = await pw.webkit.launch({ headless: true });
    await b.close();
    return undefined;
  } catch (e) { return `WebKit indisponible : ${String((e as Error).message).split('\n')[0]}`; }
}
const skip = await probe();
// Les tests isolent HOME : le cache des navigateurs de Playwright (sous le vrai HOME) est désigné explicitement.
const BROWSERS = { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), '.cache', 'ms-playwright') };

function writeConfig(env: NodeJS.ProcessEnv, cfg: object): void {
  const paths = resolvePaths(env, env.HOME);
  mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
  writeFileSync(paths.configFile, JSON.stringify(cfg), { mode: 0o600 });
}

test('WebKit : nav, snap (refs), text, click et fill avec --snap-diff, expect, capture, iPhone 14', { ...(skip !== undefined ? { skip } : {}) }, async () => {
  const t = makeTestEnv(BROWSERS);
  const site = await startTestSite();
  writeConfig(t.env, { allowedDomains: ['127.0.0.1'] });
  const srv = await startServer(t.env);
  try {
    const created = await runCli(t.env, ['session', 'create', '--browser', 'webkit', '--viewport', 'iphone-14']);
    assert.equal(created.code, 0, created.stderr);
    const id = created.stdout.trim();
    assert.match(created.stderr, /moteur WebKit \d+\.\d+ \(mode minimal/);
    const env = { ...t.env, GRASP_SESSION: id };
    const ok = async (args: string[]) => { const r = await runCli(env, args); assert.equal(r.code, 0, `${args.join(' ')} : ${r.stderr}`); return r; };
    const ko = async (args: string[], re: RegExp) => { const r = await runCli(env, args); assert.equal(r.code, 1, `${args.join(' ')} devait échouer : ${r.stdout}`); assert.match(r.stderr, re, args.join(' ')); return r; };
    assert.match((await ok(['session', 'list'])).stdout, /moteur webkit.*viewport 390x844, dpr 3, mobile, tactile \(iphone-14\)/);

    // Rendu iPhone : user agent Safari mobile vu par le SERVEUR, mesures lues dans la page.
    await ok(['nav', `${site.url}/viewport`]);
    assert.match((await ok(['text'])).stdout, /Écran tactile[\s\S]*Largeur 390[\s\S]*UA serveur : mobile/);
    assert.match((await ok(['viewport'])).stdout, /390x844, dpr 3, mobile, tactile \(iphone-14\) — page : 390x\d+, dpr 3, \d+ point\(s\) tactile\(s\), pointeur coarse, UA mobile/);

    // Boucle de travail : snap → refs → action avec diff → vérification par le contenu.
    await ok(['nav', `${site.url}/boutique`]);
    const snap = (await ok(['snap'])).stdout;
    assert.match(snap, /^(?:f\d+)?e\d+:heading\[1\] "Boutique"$/m);
    const qte = /^\s*((?:f\d+)?e\d+):textbox "Quantité"/m.exec(snap)?.[1];
    const btn = /^\s*((?:f\d+)?e\d+):button "Commander"/m.exec(snap)?.[1];
    assert.ok(qte !== undefined && btn !== undefined, snap);
    assert.match((await ok(['snap', '--interactive'])).stdout, /button "Commander"/);
    assert.doesNotMatch((await ok(['snap', '--interactive'])).stdout, /heading/);
    assert.match((await ok(['find', 'Commander'])).stdout, new RegExp(`${btn}:button "Commander"`));
    const fill = await ok(['fill', qte, '2', '--snap-diff']);
    assert.match(fill.stdout, /^~ (?:f\d+)?e\d+:textbox "Quantité"="2"/m);
    await ok(['fill', '#courriel', 'camille@exemple.com']);
    await ok(['expect', 'value', '#qte', '2']);
    const click = await ok(['click', 'text:Commander', '--snap-diff']);
    assert.match(click.stdout, /^[+~] .*Commande/m);
    await ok(['expect', 'text', 'Commande enregistrée']);
    await ok(['expect', 'url', '~', '/boutique']);
    await ok(['expect', 'title', 'Merci']);
    await ko(['expect', 'text', 'Texte absent', '--timeout', '200'], /^ERROR: expect: attendu texte « Texte absent » dans la page ; constaté : texte absent/m);

    // Sélecteurs : ref périmée ou inconnue → 404 qui dit quoi faire ; CSS ambigu → 409 ; ref du moteur Chrome → dit.
    await ko(['click', 'e99999'], /ref e99999 n'est plus dans la page .*refaites `snap` \(`grasp snap --interactive` suffit pour agir\)/);
    await ko(['click', 'e5k2'], /ref e5k2 inconnue du moteur WebKit : ses refs sont de la forme e12 ou f1e3/);
    await ko(['click', 'input'], /input est ambigu : 2 éléments correspondent .*'input >> nth=0'/);
    await ok(['expect', 'sel', 'input >> nth=1']);
    await ko(['click', '#absent'], /aucun élément ne correspond à #absent/);
    await ok(['nav', `${site.url}/compte`]);
    await ko(['click', btn], /ref (?:f\d+)?e\d+ vient d'une page précédente .*refaites `snap`/);

    // Capture : chemin d'un fichier 0600 ; densité 3 de l'iPhone (--max-width : échelle CSS).
    const shot = (await ok(['screenshot'])).stdout.trim();
    assert.ok(existsSync(shot));
    assert.equal(imageSize(readFileSync(shot)).width, 390 * 3);
    const out = join(t.root, 'css.png');
    await ok(['screenshot', '-o', out, '--max-width', '800']);
    assert.equal(imageSize(readFileSync(out)).width, 390);

    // Mise en page mobile, sans eval : mêmes assertions et mêmes messages que le moteur Chrome.
    await ok(['viewport', '360x800']);
    await ok(['nav', `${site.url}/mise-en-page`]);
    await ko(['expect', 'no-horizontal-overflow', '--timeout', '0'], /attendu aucun débordement horizontal de la page ; constaté : largeur du document 520 px > viewport 360 px \(\+160 px\)/);
    await ko(['expect', 'not-clipped', '#photo', '--timeout', '0'], /rogné par div\.carte \(overflow hidden, zone x=20 y=\d+ 300x150\) : 100 px à droite, 50 px en bas/);
    await ko(['expect', 'in-viewport', '#photo', '--timeout', '0'], /viewport 360x800 : dépasse de 60 px à droite/);
    await ok(['expect', 'in-viewport', '#valider', '--timeout', '0']);
    await ok(['expect', 'not-clipped', 'text:Valider', '--timeout', '0']);
    await ok(['nav', `${site.url}/mise-en-page?propre=1`]);
    await ok(['expect', 'no-horizontal-overflow', '--timeout', '0']);
    // Densité, mode mobile et tactile : fixés à la création ; les changer est refusé, en disant comment faire.
    await ko(['viewport', 'laptop'], /moteur WebKit : densité \(dpr\), mode mobile et tactile sont fixés à la création .*grasp session create --browser webkit --viewport laptop/);

    // Une recette entière en un appel (grasp run), rapport compris (console indisponible : dit, pas d'échec).
    const run = await runCli(env, ['run'], `nav ${site.url}/boutique\nfill '#qte' 3\nclick text:Commander\nexpect text "Commande enregistrée"\n`);
    assert.equal(run.code, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /\[4\] expect text "Commande enregistrée" → OK/);

    // Hors du mode minimal : 501 qui nomme la commande et la sortie de secours, jamais « route inconnue ».
    await ko(['console'], /console : non pris en charge par le moteur WebKit \(mode minimal : .*\) — pour cette commande, ouvrez une session Chrome/);
    await ko(['tabs'], /onglets \(tabs, tab\) : non pris en charge par le moteur WebKit/);
    await ko(['click', '#x', '--engine', 'playwright'], /--engine playwright sans objet : cette session est pilotée par le moteur WebKit/);
    await ko(['eval', '1'], /eval est désactivé par la politique de Grasp/);
    await ok(['session', 'close']);
  } finally {
    srv.proc.kill('SIGTERM');
    await waitExit(srv.proc);
    await site.close();
    t.cleanup();
  }
});

test('WebKit : mêmes garde-fous — allowlist et SSRF sur chaque document, redirection comprise (jamais demandée), popup, dialogue, frontières de contenu', { ...(skip !== undefined ? { skip } : {}) }, async () => {
  const t = makeTestEnv(BROWSERS);
  const site = await startTestSite();
  const port = new URL(site.url).port;
  // « localhost » est une AUTRE origine, hors allowlist, servie par le même site de test : toute requête y laisserait une trace.
  writeConfig(t.env, { allowedDomains: ['127.0.0.1'], contentBoundaries: true });
  const srv = await startServer(t.env);
  try {
    const id = (await runCli(t.env, ['session', 'create', '--browser', 'webkit'])).stdout.trim();
    const env = { ...t.env, GRASP_SESSION: id };
    const ok = async (args: string[]) => { const r = await runCli(env, args); assert.equal(r.code, 0, `${args.join(' ')} : ${r.stderr}`); return r; };
    const ko = async (args: string[], re: RegExp) => { const r = await runCli(env, args); assert.equal(r.code, 1, `${args.join(' ')} devait échouer : ${r.stdout}`); assert.match(r.stderr, re, args.join(' ')); return r; };

    // Hors allowlist : 403 AVANT toute requête, avec la commande exacte à proposer à l'utilisateur et le redémarrage.
    site.hits.length = 0;
    await ko(['nav', `http://localhost:${port}/cible-ssrf`], /^navigation bloquée : domaine hors allowlist : localhost — à autoriser par l'utilisateur humain, pas par l'agent de lui-même ; commande à lui proposer : grasp config set allowedDomains '127\.0\.0\.1,localhost' puis redémarrage du serveur/m);
    await ko(['nav', 'file:///etc/passwd'], /navigation bloquée : schéma interdit/);
    assert.equal(site.hits.join(','), '');

    // Redirection HTTP vers un hôte hors allowlist : la cible n'est JAMAIS demandée (détecter ≠ bloquer).
    const redir = await ko(['nav', `${site.url}/redirect-to?u=${encodeURIComponent(`http://localhost:${port}/cible-ssrf`)}`], /navigation bloquée par le garde : domaine hors allowlist : localhost — à autoriser .* \(http:\/\/localhost:\d+\/cible-ssrf — cible d'une redirection de http/);
    assert.match(redir.stderr, /grasp config set allowedDomains '127\.0\.0\.1,localhost'/);
    assert.ok(!site.hits.includes('/cible-ssrf'), `cible demandée : ${site.hits.join(', ')}`);
    assert.doesNotMatch((await ok(['text'])).stdout, /service interne/);

    // Redirection permise : suivie, URL finale exacte, cookie du saut conservé (connexion puis compte).
    await ok(['nav', `${site.url}/redirect-to?u=${encodeURIComponent('/compte')}`]);
    await ok(['expect', 'url', `${site.url}/compte`]);
    await ok(['nav', `${site.url}/connexion`]);
    await ok(['fill', '#user', 'camille']);
    await ok(['click', 'text:Se connecter']);
    await ok(['expect', 'text', 'Bienvenue camille']);
    await ok(['nav', `${site.url}/compte`]);
    await ok(['expect', 'text', 'Connecté : camille']);
    // back / forward / reload.
    await ok(['back']);
    await ok(['expect', 'text', 'Bienvenue camille']);
    await ok(['forward']);
    await ok(['expect', 'url', `${site.url}/compte`]);
    await ok(['reload']);
    await ok(['expect', 'text', 'Connecté : camille']);

    // Lien cliqué vers un hôte hors allowlist : la page reste, la note le dit, rien n'est demandé.
    await ok(['nav', `${site.url}/onglets`]);
    site.hits.length = 0;
    const pop = await ok(['click', '#oauth']);
    assert.match(pop.stderr, /popup vers .*\/onglets\/autoriser fermé avant tout chargement : les onglets ne sont pas pris en charge par le moteur WebKit — grasp nav/);
    assert.ok(!site.hits.includes('/onglets/autoriser'));
    await ok(['expect', 'title', 'Application']);

    // Dialogue : confirm refusé par défaut et rapporté ; --dialog accept l'accepte.
    await ok(['nav', `${site.url}/dialogue`]);
    const d1 = await ok(['click', '#demander']);
    assert.match(d1.stderr, /dialogue confirm « Supprimer \? » → refusé/);
    await ok(['expect', 'text', 'Réponse : false']);
    await ok(['click', '#demander', '--dialog', 'accept']);
    await ok(['expect', 'text', 'Réponse : true']);

    // Frontières de contenu : le texte de la page est encadré, comme avec le moteur Chrome.
    const framed = (await ok(['text'])).stdout;
    assert.match(framed, /^<<<GRASP_PAGE_CONTENT nonce=[0-9a-f]+ .*>>>\n[\s\S]*Réponse : true[\s\S]*\n<<<END_GRASP_PAGE_CONTENT nonce=[0-9a-f]+>>>$/m);
    assert.match((await ok(['snap'])).stdout, /^<<<GRASP_PAGE_CONTENT nonce=/);
  } finally {
    srv.proc.kill('SIGTERM');
    await waitExit(srv.proc);
    await site.close();
    t.cleanup();
  }
});

test('WebKit : session connectée par recette (--state), valeurs masquées ; storage ; secret restreint à ses domaines ; options refusées à la création', { ...(skip !== undefined ? { skip } : {}) }, async () => {
  const t = makeTestEnv(BROWSERS);
  const site = await startTestSite();
  writeConfig(t.env, { allowCookies: true, allowedDomains: ['127.0.0.1'] });
  const paths = resolvePaths(t.env, t.env.HOME);
  writeFileSync(paths.secretsFile, JSON.stringify({ MDP: { value: 'motdepasse-ultra', domains: ['autre.exemple.com'] }, IDENT: { value: 'camille-secrete', domains: ['127.0.0.1'] } }), { mode: 0o600 });
  const srv = await startServer(t.env);
  try {
    const TOKEN = 'jeton-acces-0123456789abcdef';
    writeFileSync(join(t.root, 'jetons.json'), JSON.stringify({ lite: { accessToken: TOKEN } }));
    const recipe = join(t.root, 'session.json');
    writeFileSync(recipe, JSON.stringify({ origin: site.url, localStorage: { theme: '@file:jetons.json#lite.accessToken' }, sessionStorage: { brouillon: 'salut' } }));
    const created = await runCli(t.env, ['session', 'create', '--browser', 'webkit', '--viewport', 'iphone-se', '--state', recipe]);
    assert.equal(created.code, 0, created.stderr);
    assert.match(created.stderr, /état importé : 0 cookie\(s\), localStorage de 1 origine\(s\) \(1 clé\(s\)\), sessionStorage : appliqué au premier document de son origine/);
    const env = { ...t.env, GRASP_SESSION: created.stdout.trim() };
    const ok = async (args: string[]) => { const r = await runCli(env, args); assert.equal(r.code, 0, `${args.join(' ')} : ${r.stderr}`); assert.ok(!(r.stdout + r.stderr).includes(TOKEN), `fuite : ${args.join(' ')}`); return r; };
    const ko = async (args: string[], re: RegExp) => { const r = await runCli(env, args); assert.equal(r.code, 1, `${args.join(' ')} devait échouer : ${r.stdout}`); assert.match(r.stderr, re, args.join(' ')); return r; };

    // Aucune requête au site pendant l'import ; la page lit ensuite les valeurs posées, masquées en sortie.
    assert.equal(site.hits.join(','), '');
    await ok(['nav', `${site.url}/compte`]);
    const text = (await ok(['text'])).stdout;
    assert.match(text, /Thème : masqué:localStorage\.theme/);
    assert.match(text, /Brouillon : salut/);
    assert.match((await ok(['snap'])).stdout, /masqué:localStorage\.theme/);
    assert.equal((await ok(['storage', 'get', 'local', 'theme'])).stdout, 'masqué:localStorage.theme\n');
    // sessionStorage importé : posé une fois, pas réécrit au document suivant.
    await ok(['storage', 'set', 'session', 'brouillon', 'modifié']);
    await ok(['nav', `${site.url}/compte`]);
    await ok(['expect', 'text', 'Brouillon : modifié']);
    await ok(['storage', 'set', 'local', 'theme', 'clair']);
    await ok(['reload']);
    await ok(['expect', 'text', 'Thème : clair']);

    // Secret : saisi sur son domaine, masqué ; refusé ailleurs sans que la valeur parte.
    await ok(['nav', `${site.url}/connexion`]);
    await ko(['fill', '#user', 'secret:MDP'], /secret:MDP n'est pas autorisé sur cette page \(127\.0\.0\.1\) : ses domaines sont autre\.exemple\.com/);
    await ok(['expect', 'value', '#user', '']);
    const f = await ok(['fill', '#user', 'secret:IDENT', '--snap-diff']);
    assert.match(f.stdout, /="secret:IDENT"/);
    assert.ok(!f.stdout.includes('camille-secrete'));
    await ok(['expect', 'value', '#user', 'secret:IDENT']);

    // Ce que le mode minimal ne sait pas appliquer est refusé à la création, jamais ignoré.
    const noProfile = await runCli(t.env, ['session', 'create', '--browser', 'webkit', '--profile', 'p']);
    assert.match(noProfile.stderr, /moteur WebKit : pas de profil persistant \(--profile\)/);
    const noProxy = await runCli(t.env, ['session', 'create', '--browser', 'webkit', '--proxy', 'socks5://127.0.0.1:1080']);
    assert.match(noProxy.stderr, /moteur WebKit : --proxy n'est pas pris en charge/);
    const bad = await runCli(t.env, ['session', 'create', '--browser', 'firefox']);
    assert.match(bad.stderr, /--browser attend chrome ou webkit/);
    assert.ok(!srv.stderr().includes(TOKEN));
  } finally {
    srv.proc.kill('SIGTERM');
    await waitExit(srv.proc);
    await site.close();
    t.cleanup();
  }
});
