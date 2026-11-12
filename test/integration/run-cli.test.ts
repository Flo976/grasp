import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { makeTestEnv, type TestEnv } from '../helpers/env.js';
import { startServer, runCli, waitExit, type Server } from '../helpers/server.js';
import { startTestSite, type TestSite } from '../helpers/testsite.js';
import { resolvePaths } from '../../src/core/paths.js';

/** grasp run : plusieurs commandes en UN aller-retour HTTP, exécutées côté serveur. */
let t: TestEnv;
let site: TestSite;
let srv: Server;
let env: NodeJS.ProcessEnv;
before(async () => {
  t = makeTestEnv();
  site = await startTestSite();
  // allowEval reste à false : run applique la même politique qu'une commande isolée.
  const paths = resolvePaths(t.env, t.env.HOME);
  mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
  writeFileSync(paths.configFile, JSON.stringify({ allowedDomains: ['127.0.0.1'] }), { mode: 0o600 });
  srv = await startServer(t.env);
  const id = (await runCli(t.env, ['session', 'create'])).stdout.trim();
  env = { ...t.env, GRASP_SESSION: id };
});
after(async () => { srv.proc.kill('SIGTERM'); await waitExit(srv.proc); await site.close(); t.cleanup(); });

test('run : formulaire rempli et soumis en un seul run (stdin), sortie compacte, refs du snap utilisables ensuite', async () => {
  // ref du champ Nom : déterministe (rôle + nom), elle sert dans le script après le snap du script.
  assert.equal((await runCli(env, ['nav', `${site.url}/`])).code, 0);
  const nom = (await runCli(env, ['snap'])).stdout.split('\n').find((l) => /textbox "Nom"/.test(l))!.trim().split(':')[0]!;
  assert.equal((await runCli(env, ['nav', `${site.url}/aide`])).code, 0);
  const script = `# inscription complète
nav ${site.url}/
snap
fill ${nom} "Ada Lovelace"   # ref issue du snap
fill '#email' ada@example.org
fill text:Ville 'Antananarivo'
select text:Pays Madagascar
check "text:J'accepte les conditions"

click text:Valider --snap-diff
text --scope 'ul'
`;
  const t0 = Date.now();
  const r = await runCli(env, ['run'], script);
  const ms = Date.now() - t0;
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
  const lines = r.stdout.split('\n');
  const heads = lines.filter((l) => /^\[\d+\] /.test(l));
  assert.deepEqual(heads.map((l) => l.replace(/ → .*/, '')), [
    `[1] nav ${site.url}/`, '[2] snap', `[3] fill ${nom} "Ada Lovelace"`, "[4] fill '#email' ada@example.org", "[5] fill text:Ville 'Antananarivo'",
    '[6] select text:Pays Madagascar', '[7] check "text:J\'accepte les conditions"', '[8] click text:Valider --snap-diff', "[9] text --scope 'ul'",
  ]);
  assert.ok(heads.every((l) => l.endsWith(' → OK')), heads.join('\n'));
  // Sortie utile seulement : le snap, le diff, le texte ; rien pour nav/fill/select/check.
  assert.match(r.stdout, /\[2\] snap → OK\npage "Inscription" /);
  assert.match(r.stdout, /\[3\] fill .* → OK\n\[4\]/);
  assert.match(r.stdout, /\[8\] click text:Valider --snap-diff → OK\nnavigation → http:\/\/127\.0\.0\.1:\d+\/submit\?/);
  assert.match(r.stdout, /\[9\] text --scope 'ul' → OK\nNom : Ada Lovelace\nEmail : ada@example\.org\nVille : Antananarivo\nPays : mg\nCGU : oui/);
  assert.match(r.stderr, /9 commandes, 9 OK/);
  // sélectionné : Madagascar (note de select) sur stderr, numérotée
  assert.match(r.stderr, /\[6\] note: sélectionné : Madagascar/);
  console.error(`# run de 9 commandes : ${ms} ms`);
});

test('run : arrêt au premier échec par défaut, étapes suivantes non exécutées, code 1', async () => {
  const file = join(t.root, 'echec.grasp');
  writeFileSync(file, `nav ${site.url}/
click text:Inexistant
fill text:Nom "jamais"
`);
  const r = await runCli(env, ['run', file]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /^\[1\] nav .* → OK$/m);
  assert.match(r.stdout, /^\[2\] click text:Inexistant → ERROR: aucun élément nommé « Inexistant »/m);
  assert.doesNotMatch(r.stdout, /\[3\]/);
  assert.match(r.stderr, /^ERROR: run: étape 2 \(click text:Inexistant\) : aucun élément nommé « Inexistant »/m);
  assert.match(r.stderr, /1 commande non exécutée — --continue pour poursuivre/);
  const v = await runCli(env, ['eval', 'x']);
  assert.equal(v.code, 1, 'eval reste interdit');
  // fill n'a pas eu lieu
  assert.match((await runCli(env, ['snap'])).stdout, /textbox "Nom"(?!=)/);
});

test('run --continue : poursuit après un échec, chaque étape rapportée ; --json donne le détail par étape', async () => {
  const script = `nav ${site.url}/
click text:Inexistant
fill text:Nom Grace
eval 1+1
snap --scope form
`;
  const r = await runCli(env, ['run', '--continue'], script);
  assert.equal(r.code, 1, 'au moins une étape en échec : code 1');
  assert.match(r.stdout, /^\[2\] click text:Inexistant → ERROR: /m);
  assert.match(r.stdout, /^\[3\] fill text:Nom Grace → OK$/m);
  assert.match(r.stdout, /^\[4\] eval 1\+1 → ERROR: eval est désactivé/m, 'même politique qu\'en commande isolée');
  assert.match(r.stdout, /^\[5\] snap --scope form → OK\n[\s\S]*textbox "Nom"="Grace"/m);
  assert.match(r.stderr, /5 commandes, 3 OK, 2 en échec/);

  const j = await runCli(env, ['run', '--continue', '--json'], script);
  assert.equal(j.code, 1);
  const res = JSON.parse(j.stdout) as { ok: boolean; steps: Array<{ n: number; line: number; cmd: string; ok: boolean; status?: number; error?: string; output?: string; result?: unknown }> };
  assert.equal(res.ok, false);
  assert.equal(res.steps.length, 5);
  assert.deepEqual(res.steps.map((s) => s.ok), [true, false, true, false, true]);
  assert.deepEqual(res.steps.map((s) => s.line), [1, 2, 3, 4, 5]);
  assert.equal(res.steps[1]!.status, 404);
  assert.equal(res.steps[3]!.status, 403);
  assert.equal(res.steps[2]!.cmd, 'fill');
  assert.match(res.steps[4]!.output ?? '', /textbox "Nom"="Grace"/);
});

test('run : erreurs de syntaxe détectées avant toute exécution (guillemet non fermé, commande inconnue ou hors run)', async () => {
  for (const [script, re] of [
    ['nav http://127.0.0.1/\nfill text:Nom "Ada\n', /ligne 2 : guillemet non fermé/],
    ['snap\nfrobnicate x\n', /ligne 2 : commande inconnue « frobnicate »/],
    ['serve\n', /ligne 1 : « serve » n'est pas disponible dans run/],
    ['screenshot -o /tmp/x.png\n', /ligne 1 : screenshot -o \/tmp\/x\.png : chemin relatif attendu/],
    ['fill text:Nom\n', /ligne 1 : usage : grasp fill/],
    ['# rien\n\n', /aucune commande/],
    ['snap\nclick e1 --session autre\n', /ligne 2 : --session n'a pas de sens sur une ligne de run/],
    ['click e1 --snapdiff\n', /ligne 1 : option --snapdiff inconnue pour click/],
  ] as const) {
    const r = await runCli(env, ['run'], script);
    assert.equal(r.code, 1, script);
    assert.match(r.stderr, new RegExp(`^ERROR: run: .*${re.source}`, 'm'), `${script} → ${r.stderr}`);
    assert.equal(r.stdout, '', 'rien exécuté');
  }
});

test('run : screenshot (chemin), console, wait et nav --snap-diff dans un même script', async () => {
  const r = await runCli(env, ['run'], `nav ${site.url}/console
wait --text Console
console --level error --limit 3
screenshot --el h1
`);
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /\[3\] console --level error --limit 3 → OK\n(#\d+ error .*\n){1,3}/);
  assert.match(r.stdout, /\[4\] screenshot --el h1 → OK\n\/.*\.png\n/);
});

test('run : screenshot -o <fichier relatif> écrit par la CLI sous --out-dir (0600), jamais le base64 en sortie ; refusé hors CLI', async () => {
  const outDir = join(t.root, 'rapport');
  const r = await runCli(env, ['run', '--out-dir', outDir], `nav ${site.url}/
screenshot -o captures/accueil.png
screenshot --el h1 -o titre.jpg
`);
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
  const png = join(outDir, 'captures', 'accueil.png');
  const jpg = join(outDir, 'titre.jpg');
  assert.match(r.stdout, new RegExp(`\\[2\\] screenshot -o captures/accueil\\.png → OK\\n${png.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n`));
  assert.deepEqual([...readFileSync(png).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'PNG');
  assert.deepEqual([...readFileSync(jpg).subarray(0, 2)], [0xff, 0xd8], 'JPEG déduit de l\'extension');
  assert.equal(statSync(png).mode & 0o777, 0o600);
  // --json : chemin écrit, jamais l'image en base64.
  const j = await runCli(env, ['run', '--json', '--out-dir', outDir], 'screenshot -o captures/accueil.png\n');
  assert.equal(j.code, 0, j.stderr);
  const res = JSON.parse(j.stdout) as { steps: Array<{ output?: string; result?: Record<string, unknown> }> };
  assert.equal(res.steps[0]!.result!.path, png);
  assert.equal(res.steps[0]!.result!.data, undefined);
  assert.ok(j.stdout.length < 2000, `sortie bornée : ${j.stdout.length} octets`);
  // API HTTP (ou MCP) sans « files » : refus explicite, le serveur n'écrit jamais où le script le demande.
  const api = await srv.api('POST', '/run', { script: 'screenshot -o x.png' }, { 'x-grasp-session': env.GRASP_SESSION! });
  assert.equal(api.status, 400);
  assert.match(api.json().error, /screenshot -o n'est disponible que depuis la CLI/);
});

test('run : client déconnecté (Ctrl-C, délai de l\'agent) → les étapes restantes ne sont PAS exécutées, et le journal dit où le run s\'est arrêté', async () => {
  assert.equal((await runCli(env, ['nav', `${site.url}/sonde`])).code, 0);
  // --continue : sans l'arrêt sur déconnexion, le clic partirait même après l'échec de l'attente.
  const script = `wait --text Jamais --timeout 1500\nclick '#compter'\nclick '#compter'\n`;
  const ep = JSON.parse(readFileSync(srv.paths.endpointFile, 'utf8')) as { socketPath: string };
  const payload = Buffer.from(JSON.stringify({ script, continue: true }));
  await new Promise<void>((resolve) => {
    const req = httpRequest({
      socketPath: ep.socketPath, method: 'POST', path: '/run',
      headers: { authorization: `Bearer ${srv.token()}`, 'x-grasp-session': env.GRASP_SESSION!, 'content-type': 'application/json', 'content-length': String(payload.length) },
    });
    req.on('error', () => resolve());
    req.end(payload);
    setTimeout(() => { req.destroy(); resolve(); }, 400);
  });
  await new Promise((r) => setTimeout(r, 2500));
  const t = await runCli(env, ['text', '--scope', '#compte']);
  assert.equal(t.stdout.trim(), 'Compte : 0', 'aucun clic après la déconnexion du client');
  assert.match(srv.stderr(), /run interrompu : client déconnecté.*2 étape\(s\) non exécutée\(s\)/);
});
