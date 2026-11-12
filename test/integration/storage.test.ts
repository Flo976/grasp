import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { makeTestEnv } from '../helpers/env.js';
import { RUN_MAX_BYTES } from '../../src/core/state.js';
import { startServer, runCli, waitExit } from '../helpers/server.js';
import { startTestSite } from '../helpers/testsite.js';
import { resolvePaths } from '../../src/core/paths.js';

function writeConfig(env: NodeJS.ProcessEnv, cfg: object): void {
  const paths = resolvePaths(env, env.HOME);
  mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
  writeFileSync(paths.configFile, JSON.stringify(cfg), { mode: 0o600 });
}

test('storage set|get|rm local|session : origine affichée, sans allowEval, vérifié par le contenu de la page ; utilisable dans run', async () => {
  const t = makeTestEnv();
  const site = await startTestSite();
  // allowEval reste à false : storage n'évalue que du code fixe.
  writeConfig(t.env, { allowCookies: true, allowedDomains: ['127.0.0.1'] });
  const srv = await startServer(t.env);
  try {
    const id = (await runCli(t.env, ['session', 'create'])).stdout.trim();
    const env = { ...t.env, GRASP_SESSION: id };
    const ok = async (args: string[], input?: string) => { const r = await runCli(env, args, input); assert.equal(r.code, 0, `${args.join(' ')} : ${r.stderr}`); return r; };

    // Avant toute navigation : about:blank n'a pas d'origine → refus explicite.
    const blank = await runCli(env, ['storage', 'set', 'local', 'theme', 'clair']);
    assert.equal(blank.code, 1);
    assert.match(blank.stderr, /^ERROR: storage: .*about:blank.*naviguez d'abord/m);
    const ev = await runCli(env, ['eval', '1']);
    assert.equal(ev.code, 1, 'eval reste désactivé');
    // Le refus oriente vers les alternatives sans eval, et ne dicte jamais la commande qui relâche la politique.
    assert.match(ev.stderr, /^ERROR: eval: eval est désactivé .*storage get\|set.*expect text\|value\|sel\|a11y.*find et snap.*network.*décision de l'utilisateur humain, pas de l'agent/m);
    assert.doesNotMatch(ev.stderr, /config set/);

    await ok(['nav', `${site.url}/compte`]);
    assert.match((await ok(['text'])).stdout, /Thème : aucun[\s\S]*Brouillon : aucun/);
    const set = await ok(['storage', 'set', 'local', 'theme', 'clair']);
    assert.equal(set.stdout, 'OK\n');
    assert.match(set.stderr, new RegExp(`localStorage de ${site.url.replace(/[.]/g, '\\.')}`));
    await ok(['storage', 'set', 'session', 'brouillon', 'salut']);
    await ok(['nav', `${site.url}/compte`]);
    assert.match((await ok(['text'])).stdout, /Thème : clair[\s\S]*Brouillon : salut/, 'valeurs lues par la page elle-même');
    assert.equal((await ok(['storage', 'get', 'local', 'theme'])).stdout, 'clair\n');
    assert.deepEqual(JSON.parse((await ok(['storage', 'get', 'session', 'brouillon', '--json'])).stdout), { ok: true, op: 'get', origin: site.url, area: 'session', key: 'brouillon', value: 'salut' });

    // Clé absente : code 1, message qui le dit ; rm idempotent, signalé.
    const none = await runCli(env, ['storage', 'get', 'local', 'absente']);
    assert.equal(none.code, 1);
    assert.match(none.stderr, /clé « absente » absente du localStorage/);
    await ok(['storage', 'rm', 'local', 'theme']);
    assert.equal((await runCli(env, ['storage', 'get', 'local', 'theme'])).code, 1);
    assert.match((await ok(['storage', 'rm', 'local', 'theme'])).stderr, /déjà absente/);

    // Valeur sur stdin (hors de ps) ; get borné à 4000 caractères, troncature annoncée.
    await ok(['storage', 'set', 'local', 'gros', '-'], `${'x'.repeat(5000)}\n`);
    const big = await ok(['storage', 'get', 'local', 'gros']);
    assert.equal(big.stdout, `${'x'.repeat(4000)}\n`);
    assert.match(big.stderr, /tronquée à 4000 caractères sur 5000/);

    // Usage invalide : refus avant tout appel.
    assert.match((await runCli(env, ['storage', 'set', 'local', 'k'])).stderr, /usage : grasp storage/);
    assert.match((await runCli(env, ['storage', 'get', 'cookie', 'k'])).stderr, /stockage inconnu « cookie »/);

    // Dans un run : poser une session factice, recharger, vérifier par le contenu.
    const r = await runCli(env, ['run'], `storage set local theme sombre
nav ${site.url}/compte
expect text "Thème : sombre"
storage get local theme
`);
    assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /\[4\] storage get local theme → OK\nsombre\n/);
  } finally { srv.proc.kill('SIGTERM'); await waitExit(srv.proc); await site.close(); t.cleanup(); }
});

test('storage --origin : valeur posée sur about:blank, avant tout chargement de l\'origine, lue par la page ; mêmes contrôles', async () => {
  const t = makeTestEnv();
  const site = await startTestSite();
  // *.localhost dans l'allowlist : refusé par la protection SSRF (boucle locale par un joker), sans DNS.
  writeConfig(t.env, { allowCookies: true, allowedDomains: ['127.0.0.1', '*.localhost'] });
  const srv = await startServer(t.env);
  try {
    const id = (await runCli(t.env, ['session', 'create'])).stdout.trim();
    const env = { ...t.env, GRASP_SESSION: id };
    const ok = async (args: string[]) => { const r = await runCli(env, args); assert.equal(r.code, 0, `${args.join(' ')} : ${r.stderr}`); return r; };
    const hits0 = site.hits.length;

    // Sur about:blank : localStorage posé hors de la page (document vide servi par Grasp), aucune requête vers le site.
    const set = await ok(['storage', 'set', 'local', 'theme', 'avant', '--origin', `${site.url}/compte?x=1`]);
    assert.equal(set.stdout, 'OK\n');
    assert.match(set.stderr, new RegExp(`localStorage de ${site.url.replace(/[.]/g, '\\.')}`));
    assert.equal((await ok(['storage', 'get', 'local', 'theme', '--origin', site.url])).stdout, 'avant\n');
    // sessionStorage (propre à l'onglet) : set seulement, appliqué au premier document de l'origine ; clés fusionnées.
    assert.match((await ok(['storage', 'set', 'session', 'brouillon', 'v1', '--origin', site.url])).stderr, /appliqué au premier document de cette origine/);
    await ok(['storage', 'set', 'session', 'premier', 'gardé', '--origin', site.url]);
    await ok(['storage', 'set', 'session', 'brouillon', 'v2', '--origin', site.url]);
    const sget = await runCli(env, ['storage', 'get', 'session', 'brouillon', '--origin', site.url]);
    assert.equal(sget.code, 1);
    assert.match(sget.stderr, /propre à l'onglet/);
    assert.equal(site.hits.length, hits0, `aucune requête vers le site avant la navigation : ${site.hits.slice(hits0).join(', ')}`);

    await ok(['nav', `${site.url}/compte`]);
    assert.match((await ok(['text'])).stdout, /Thème : avant[\s\S]*Brouillon : v2/, 'valeurs lues par la page elle-même');
    assert.equal((await ok(['storage', 'get', 'session', 'premier'])).stdout, 'gardé\n', 'clés des set successifs fusionnées');

    // Mêmes contrôles qu'une navigation : origine invalide, hors allowlist, SSRF.
    const bad = await runCli(env, ['storage', 'set', 'local', 'k', 'v', '--origin', 'ftp://127.0.0.1']);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /origine http\(s\) attendue/);
    const out = await runCli(env, ['storage', 'set', 'local', 'k', 'v', '--origin', 'https://ailleurs.example']);
    assert.equal(out.code, 1);
    assert.match(out.stderr, /hors allowlist/);
    const port = new URL(site.url).port;
    const ssrf = await runCli(env, ['storage', 'set', 'local', 'k', 'v', '--origin', `http://app.localhost:${port}`]);
    assert.equal(ssrf.code, 1);
    assert.match(ssrf.stderr, /--origin http:\/\/app\.localhost:\d+ refusée : .*boucle locale/);
    assert.match((await runCli(env, ['storage', 'set', 'local', 'k', 'v', '--origin'])).stderr, /--origin attend/);

    // Dans run, sur une session neuve (about:blank) : poser avant la première navigation ; note d'origine une seule fois.
    const id2 = (await runCli(t.env, ['session', 'create'])).stdout.trim();
    const r = await runCli({ ...t.env, GRASP_SESSION: id2 }, ['run'], `storage set local theme run --origin ${site.url}
storage set local autre x --origin ${site.url}
storage set session brouillon b --origin ${site.url}
storage set session encore e --origin ${site.url}
nav ${site.url}/compte
storage set local theme apres
expect text "Thème : run"
expect text "Brouillon : b"
`);
    assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
    assert.equal((r.stderr.match(/note: localStorage de /g) ?? []).length, 1, `note localStorage une fois par origine :\n${r.stderr}`);
    assert.equal((r.stderr.match(/note: sessionStorage de /g) ?? []).length, 1, `note sessionStorage une fois par origine :\n${r.stderr}`);
    assert.match(r.stderr, /\[4\] note: appliqué au premier document/, 'la précision propre à l\'étape reste');
  } finally { srv.proc.kill('SIGTERM'); await waitExit(srv.proc); await site.close(); t.cleanup(); }
});

test('storage : refusé tant que allowCookies est désactivé (défaut), message qui nomme la clé', async () => {
  const t = makeTestEnv();
  const site = await startTestSite();
  writeConfig(t.env, { allowedDomains: ['127.0.0.1'] });
  const srv = await startServer(t.env);
  try {
    const id = (await runCli(t.env, ['session', 'create'])).stdout.trim();
    const env = { ...t.env, GRASP_SESSION: id };
    assert.equal((await runCli(env, ['nav', `${site.url}/compte`])).code, 0);
    for (const args of [['storage', 'get', 'local', 'theme'], ['storage', 'set', 'local', 'theme', 'x']]) {
      const r = await runCli(env, args);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /allowCookies/);
    }
    // state import dans run : même garde-fou qu'en commande isolée (403 qui nomme la clé), étape KO, rien écrit.
    const file = join(t.root, 'etat.json');
    writeFileSync(file, JSON.stringify({ format: 'grasp-state', version: 1, origins: [{ origin: site.url, localStorage: [{ name: 'theme', value: 'interdit' }] }] }), { mode: 0o600 });
    const run = await runCli(env, ['run'], `state import ${file}\n`);
    assert.equal(run.code, 1);
    assert.match(run.stdout, /\[1\] state import .* → ERROR: .*allowCookies/);
    assert.equal((await srv.api('POST', '/storage', { op: 'set', area: 'local', key: 'k', value: 'v' }, { 'x-grasp-session': id })).status, 403);
    assert.equal((await srv.api('POST', '/storage', { op: 'set', area: 'local', key: 'k', value: 'v', origin: site.url }, { 'x-grasp-session': id })).status, 403, '--origin : même exigence allowCookies');
    assert.match((await runCli(env, ['text'])).stdout, /Thème : aucun/, 'rien écrit');
  } finally { srv.proc.kill('SIGTERM'); await waitExit(srv.proc); await site.close(); t.cleanup(); }
});

test('recette : session factice posée par state import sans allowEval (exemple du README)', async () => {
  const t = makeTestEnv();
  const site = await startTestSite();
  writeConfig(t.env, { allowCookies: true, allowedDomains: ['127.0.0.1'] });
  const srv = await startServer(t.env);
  try {
    const id = (await runCli(t.env, ['session', 'create'])).stdout.trim();
    const env = { ...t.env, GRASP_SESSION: id };
    const file = join(t.root, 'session-factice.json');
    writeFileSync(file, JSON.stringify({
      format: 'grasp-state', version: 1,
      origins: [{ origin: site.url, localStorage: [{ name: 'theme', value: 'factice' }] }],
      sessionStorage: { origin: site.url, items: [{ name: 'brouillon', value: 'factice' }] },
    }), { mode: 0o600 });
    const imp = await runCli(env, ['state', 'import', file]);
    assert.equal(imp.code, 0, imp.stderr);
    assert.equal((await runCli(env, ['nav', `${site.url}/compte`])).code, 0);
    assert.match((await runCli(env, ['text'])).stdout, /Thème : factice[\s\S]*Brouillon : factice/);
  } finally { srv.proc.kill('SIGTERM'); await waitExit(srv.proc); await site.close(); t.cleanup(); }
});

test('run --out-dir : state import lu relatif au répertoire courant (pas à --out-dir), capture d\'échec écrite sous --out-dir, storage --origin dans le même run', async () => {
  const t = makeTestEnv();
  const site = await startTestSite();
  writeConfig(t.env, { allowCookies: true, allowedDomains: ['127.0.0.1'] });
  const srv = await startServer(t.env);
  try {
    const id = (await runCli(t.env, ['session', 'create'])).stdout.trim();
    const env = { ...t.env, GRASP_SESSION: id };
    const etat = (theme: string): string => JSON.stringify({ format: 'grasp-state', version: 1, origins: [{ origin: site.url, localStorage: [{ name: 'theme', value: theme }] }] });
    const file = join(t.root, 'etat-outdir.json');
    writeFileSync(file, etat('courant'), { mode: 0o600 });
    const outDir = join(t.root, 'sorties');
    mkdirSync(outDir);
    // Chemin relatif au répertoire courant de la CLI : --out-dir ne vaut que pour les écritures (captures).
    const rel = relative(process.cwd(), file);
    const r = await runCli(env, ['run', '--out-dir', outDir, '--continue'], `state import ${rel}
storage set session brouillon outdir --origin ${site.url}
nav ${site.url}/compte
expect text "Thème : courant"
expect text "Brouillon : outdir"
expect text "absent-zzz" --timeout 0
`);
    assert.equal(r.code, 1, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /^\[1\] state import .* → OK$/m);
    assert.match(r.stdout, /^\[4\] expect text .* → OK$/m);
    assert.match(r.stdout, /^\[5\] expect text .* → OK$/m);
    const shot = join(outDir, 'echec-etape-6.png');
    assert.ok(existsSync(shot), `${r.stdout}\n${r.stderr}`);
    assert.ok(r.stdout.includes(`capture : ${shot}`), r.stdout);
  } finally {
    srv.proc.kill('SIGTERM'); await waitExit(srv.proc); await site.close(); t.cleanup();
  }
});

test('run <fichier> : state import relatif au répertoire du SCRIPT (recette portable), pas au répertoire courant', async () => {
  const t = makeTestEnv();
  const site = await startTestSite();
  writeConfig(t.env, { allowCookies: true, allowedDomains: ['127.0.0.1'] });
  const srv = await startServer(t.env);
  try {
    const id = (await runCli(t.env, ['session', 'create'])).stdout.trim();
    const env = { ...t.env, GRASP_SESSION: id };
    const dir = join(t.root, 'recettes');
    mkdirSync(dir);
    writeFileSync(join(dir, 'session.json'), JSON.stringify({ format: 'grasp-state', version: 1, origins: [{ origin: site.url, localStorage: [{ name: 'theme', value: 'portable' }] }] }), { mode: 0o600 });
    const script = join(dir, 'recette.grasp');
    writeFileSync(script, `state import session.json\nnav ${site.url}/compte\nexpect text "Thème : portable"\n`);
    // La CLI tourne dans le répertoire des tests : session.json n'y est pas, seulement à côté du script.
    assert.ok(!existsSync(join(process.cwd(), 'session.json')));
    const r = await runCli(env, ['run', relative(process.cwd(), script)]);
    assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /^\[3\] expect text .* → OK$/m);
  } finally {
    srv.proc.kill('SIGTERM'); await waitExit(srv.proc); await site.close(); t.cleanup();
  }
});

test('run : ligne state import <fichier> (lu par la CLI) — session factice posée avant navigation, history --as-run la rejoue', async () => {
  const t = makeTestEnv();
  const site = await startTestSite();
  writeConfig(t.env, { allowCookies: true, allowedDomains: ['127.0.0.1'] });
  const srv = await startServer(t.env);
  try {
    const id = (await runCli(t.env, ['session', 'create'])).stdout.trim();
    const env = { ...t.env, GRASP_SESSION: id };
    const file = join(t.root, 'etat-recette.json');
    writeFileSync(file, JSON.stringify({
      format: 'grasp-state', version: 1,
      origins: [{ origin: site.url, localStorage: [{ name: 'theme', value: 'factice' }] }, { origin: 'http://hors-liste.exemple', localStorage: [{ name: 'k', value: 'v' }] }],
      sessionStorage: { origin: site.url, items: [{ name: 'brouillon', value: 'factice' }] },
    }), { mode: 0o600 });
    // Chemin relatif au répertoire courant de la CLI (celui des tests), comme la commande isolée.
    const rel = relative(process.cwd(), file);
    const r = await runCli(env, ['run'], `state import ${rel}
nav ${site.url}/compte
expect text "Thème : factice"
expect text "Brouillon : factice"
`);
    assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /^\[1\] state import .* → OK$/m);
    assert.match(r.stderr, /\[1\] note: état importé : 0 cookie\(s\), localStorage de 1 origine\(s\) \(1 clé\(s\)\), sessionStorage : appliqué au premier document de son origine ; AVERTISSEMENT : non importé : .*hors-liste\.exemple/);
    assert.match(r.stdout, /== recette : OK/);
    // Rejouable : la ligne garde le fichier (chemin absolu), jamais son contenu.
    const h = await runCli(env, ['history', '--as-run']);
    assert.equal(h.code, 0, h.stderr);
    assert.ok(h.stdout.split('\n').includes(`state import ${file}`), h.stdout);
    assert.doesNotMatch(h.stdout, /hors-liste|localStorage|grasp-state/, 'contenu du fichier jamais recopié');
    // Commande isolée : même ligne rejouable ; reçu sur stdin : commenté, raison dite.
    await runCli(env, ['history', '--clear']);
    // Chemin relatif : résolu par la CLI, l'historique garde le chemin absolu (rejouable depuis un autre répertoire).
    assert.equal((await runCli(env, ['state', 'import', rel])).code, 0);
    assert.equal((await runCli(env, ['state', 'import', '-'], JSON.stringify({ format: 'grasp-state', version: 1 }))).code, 0);
    const h2 = (await runCli(env, ['history', '--as-run'])).stdout;
    assert.match(h2, new RegExp(`^state import ${file.replace(/[.]/g, '\\.')}$`, 'm'));
    assert.match(h2, /^# state import <fichier> +# #\d+ : contenu reçu sans fichier/m);
    assert.ok(!h2.split('\n').includes(`state import ${rel}`), h2);

    // ~/ en tête développé par la CLI (aucun shell ne passe sur une ligne de run) : HOME du test = t.root.
    await runCli(env, ['history', '--clear']);
    const tilde = await runCli(env, ['run', '--no-report'], 'state import ~/etat-recette.json\n');
    assert.equal(tilde.code, 0, `${tilde.stdout}\n${tilde.stderr}`);
    assert.ok((await runCli(env, ['history', '--as-run'])).stdout.split('\n').includes(`state import ${file}`));

    // Fichier d'état de plus de 4 Mo (limite par défaut d'un corps) : le corps du run le porte jusqu'au bout.
    const big = join(t.root, 'etat-gros.json');
    writeFileSync(big, JSON.stringify({
      format: 'grasp-state', version: 1,
      origins: [{ origin: site.url, localStorage: [{ name: 'theme', value: 'gros' }] }, { origin: 'http://hors-liste.exemple', localStorage: [{ name: 'k', value: 'x'.repeat(5 * 1024 * 1024) }] }],
    }), { mode: 0o600 });
    const g = await runCli(env, ['run'], `state import ${big}\nnav ${site.url}/compte\nexpect text "Thème : gros"\n`);
    assert.equal(g.code, 0, `${g.stdout}\n${g.stderr}`);
    assert.match(g.stdout, /== recette : OK/);

    // Fichier illisible ou JSON invalide : refus AVANT toute exécution (la navigation de la ligne 1 n'a pas lieu).
    await runCli(env, ['history', '--clear']);
    const absent = await runCli(env, ['run'], `nav ${site.url}/\nstate import ${join(t.root, 'absent.json')}\n`);
    assert.equal(absent.code, 1);
    assert.match(absent.stderr, /ligne 2 : state import .*absent\.json : lecture impossible.* — aucune commande exécutée/);
    writeFileSync(join(t.root, 'casse.json'), 'jeton=SECRET-42');
    const bad = await runCli(env, ['run'], `nav ${site.url}/\nstate import ${join(t.root, 'casse.json')}\n`);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /JSON invalide/);
    assert.doesNotMatch(bad.stderr, /SECRET/, 'aucun extrait du fichier');
    assert.doesNotMatch((await runCli(env, ['history'])).stdout, /nav /, 'rien exécuté');
    // Corps du run au-delà de la limite du serveur (ici un script énorme) : refus clair de la CLI avant l'envoi,
    // jamais le 413 « corps de requête trop gros » du serveur.
    const hugeScript = join(t.root, 'enorme.grasp');
    writeFileSync(hugeScript, `nav ${site.url}/\n# ${'x'.repeat(RUN_MAX_BYTES)}\n`);
    const huge = await runCli(env, ['run', hugeScript]);
    assert.equal(huge.code, 1);
    assert.match(huge.stderr, /^ERROR: run: run trop gros : \d+ octets à envoyer \(\d+ au plus, script et fichiers de state import compris\) — aucune commande exécutée$/m);
    assert.doesNotMatch((await runCli(env, ['history'])).stdout, /nav /, 'rien exécuté');
    // Formes refusées à l'analyse.
    assert.match((await runCli(env, ['run'], 'state import -\n')).stderr, /stdin n'est pas disponible dans run/);
    assert.match((await runCli(env, ['run'], 'state export\n')).stderr, /state export n'est pas disponible dans run/);
    // API sans client CLI : la ligne est refusée et oriente vers POST /state/import ou l'outil MCP.
    const api = await srv.api('POST', '/run', { script: `state import ${file}` }, { 'x-grasp-session': id });
    assert.equal(api.status, 400);
    assert.match(api.text(), /POST \/state\/import.*state_import/);
  } finally { srv.proc.kill('SIGTERM'); await waitExit(srv.proc); await site.close(); t.cleanup(); }
});
