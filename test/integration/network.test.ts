import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { makeTestEnv, type TestEnv } from '../helpers/env.js';
import { startServer, runCli, waitExit, type Server } from '../helpers/server.js';
import { startTestSite, type TestSite } from '../helpers/testsite.js';
import { resolvePaths } from '../../src/core/paths.js';
import type { NetResult } from '../../src/core/network.js';
import type { RunResult } from '../../src/control/run.js';

/**
 * Journal réseau : `--network` sur une action, `grasp network`, `expect request`, contre un vrai Chrome et le site
 * local (/boutique : POST /api/commande, 500 pour qte=13 ; /console : requête avec Authorization, corps et ?token=).
 */
let t: TestEnv;
let site: TestSite;
let srv: Server;
let env: NodeJS.ProcessEnv;

async function serverWith(config: Record<string, unknown>): Promise<{ t: TestEnv; srv: Server; env: NodeJS.ProcessEnv }> {
  const te = makeTestEnv();
  const paths = resolvePaths(te.env, te.env.HOME);
  mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
  writeFileSync(paths.configFile, JSON.stringify(config), { mode: 0o600 });
  const s = await startServer(te.env);
  const id = (await runCli(te.env, ['session', 'create'])).stdout.trim();
  return { t: te, srv: s, env: { ...te.env, GRASP_SESSION: id } };
}

before(async () => {
  site = await startTestSite();
  ({ t, srv, env } = await serverWith({ allowedDomains: ['127.0.0.1'] }));
});
after(async () => { srv.proc.kill('SIGTERM'); await waitExit(srv.proc); await site.close(); t.cleanup(); });

const cli = (args: string[], input?: string) => runCli(env, args, input);
/** Durée variable : « · 12 ms · » → « · N ms · ». */
const norm = (s: string) => s.replace(/ · \d+ ms · /g, ' · N ms · ');

test('click --network : la requête de l\'action (méthode, URL, statut, durée, type), après OK ; seq réseau sur stderr', async () => {
  assert.equal((await cli(['nav', `${site.url}/boutique`])).code, 0);
  assert.equal((await cli(['fill', '#qte', '2'])).code, 0);
  const r = await cli(['click', 'text:Commander', '--network']);
  assert.equal(r.code, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines[0], 'OK');
  // Chrome peut aussi demander /favicon.ico après la route pushState : une vraie requête, journalisée comme les autres.
  const net = lines.slice(1).map(norm).map((l) => l.replace(/^#\d+/, '#N')).filter((l) => !l.includes('/favicon.ico'));
  assert.deepEqual(net, [`#N POST ${site.url}/api/commande?qte=2 → 200 OK · N ms · fetch`]);
  assert.match(r.stderr, /^réseau : seq réseau courant \d+$/m);

  // --json : champ network, entrées structurées.
  const j = JSON.parse((await cli(['press', 'Escape', '--network', '--json'])).stdout) as { network: { entries: unknown[]; seq: number; since: number; omitted: number; dropped: number } };
  assert.deepEqual(j.network.entries, [], 'aucune requête pendant la touche');
  assert.equal(j.network.omitted, 0);
  assert.equal(j.network.since, j.network.seq);
});

test('grasp network : --failed (500), --type, --max (omises annoncées), --since ; --json', async () => {
  assert.equal((await cli(['nav', `${site.url}/boutique`])).code, 0);
  const s0 = JSON.parse((await cli(['network', '--max', '1', '--json'])).stdout) as NetResult;
  assert.equal((await cli(['fill', '#qte', '13'])).code, 0);
  assert.equal((await cli(['click', 'text:Commander'])).code, 0);

  const f = await cli(['network', '--failed', '--since', String(s0.seq)]);
  assert.equal(f.code, 0, f.stderr);
  assert.equal(norm(f.stdout.trim()).replace(/^#\d+/, '#N'), `#N POST ${site.url}/api/commande?qte=13 → 500 Internal Server Error · N ms · fetch`);
  assert.match(f.stderr, new RegExp(`^seq réseau courant : \\d+ — suite : grasp network --since \\d+$`, 'm'));

  const all = JSON.parse((await cli(['network', '--json'])).stdout) as NetResult;
  assert.ok(all.entries.some((e) => e.type === 'document' && e.url === `${site.url}/boutique` && e.status === 200), JSON.stringify(all.entries));
  const typed = JSON.parse((await cli(['network', '--type', 'fetch', '--json'])).stdout) as NetResult;
  assert.ok(typed.entries.length > 0 && typed.entries.every((e) => e.type === 'fetch'));

  const m = await cli(['network', '--max', '1']);
  assert.equal(m.stdout.trim().split('\n').length, 1);
  assert.match(m.stderr, /AVERTISSEMENT : \d+ requête\(s\) plus ancienne\(s\) non affichée\(s\) — --max N ou --since <seq>/);

  const bad = await cli(['network', '--type', 'ajax']);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /type de requête inconnu « ajax »/);
  const far = await cli(['network', '--since', '999999']);
  assert.equal(far.code, 1);
  assert.match(far.stderr, /reprenez avec --since 0/);
});

test('redirection : une ligne par saut (302 puis 200), document', async () => {
  const r = await cli(['nav', `${site.url}/redirect-to?u=/boutique`, '--network']);
  assert.equal(r.code, 0, r.stderr);
  const docs = norm(r.stdout).split('\n').filter((l) => l.endsWith(' · document')).map((l) => l.replace(/^#\d+/, '#N'));
  assert.deepEqual(docs, [`#N GET ${site.url}/redirect-to?u=%2Fboutique → 302 Found · N ms · document`, `#N GET ${site.url}/boutique → 200 OK · N ms · document`]);
});

test('requête en vol : « en cours » avec le temps écoulé', async () => {
  assert.equal((await cli(['nav', `${site.url}/long-poll`])).code, 0);
  const r = await cli(['click', '#b', '--network']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`^#\\d+ GET ${site.url}/api/lent\\?ms=10000 → en cours · \\d+ ms · fetch$`, 'm'));
});

test('expect request : tenue (2xx par défaut, code, classe), échec avec le constaté (statut, aucune requête), dans un run', async () => {
  const ok = await cli(['run'], `nav ${site.url}/boutique
fill '#qte' 2
click text:Commander
expect request "POST /api/commande"
expect request "POST /api/commande" 200
expect request "POST /api/commande?qte=2" 2xx,304
expect request ~ /api/commande
expect request --regex 'POST /api/commande\\?qte=\\d+$'
expect request "GET /boutique"
`);
  assert.equal(ok.code, 0, `${ok.stdout}\n${ok.stderr}`);
  assert.match(ok.stdout, /^== recette : OK — 9 étapes : 9 OK, 0 KO/m);

  const ko = await cli(['run', '--continue', '--json'], `nav ${site.url}/boutique
fill '#qte' 13
click text:Commander
expect request "POST /api/commande" --timeout 300
expect request "POST /api/commande" 5xx --timeout 0
expect request "POST /api/commande" 201 --timeout 0
expect request "DELETE /api/commande" --timeout 0
expect request /api/absente --timeout 0
`);
  assert.equal(ko.code, 1);
  const res = JSON.parse(ko.stdout) as RunResult;
  const err = (n: number) => res.steps[n - 1]!.error ?? '';
  assert.equal(res.steps[4]!.ok, true, '5xx tenue');
  assert.match(norm(err(4)), new RegExp(`^attendu requête POST « /api/commande » de statut 2xx ; constaté : 1 requête\\(s\\) correspondante\\(s\\) depuis #\\d+, aucune terminée de statut 2xx : #\\d+ POST ${site.url.replace(/\./g, '\\.')}/api/commande\\?qte=13 → 500 Internal Server Error · N ms · fetch \\(après 300 ms\\)$`));
  assert.match(err(6), /attendu requête POST « \/api\/commande » de statut 201 ; constaté : .*→ 500 Internal Server Error/);
  assert.match(err(7), /attendu requête DELETE « \/api\/commande » de statut 2xx ; constaté : aucune requête correspondante depuis #\d+ ; dernières xhr\/fetch : #\d+ POST .*\/api\/commande\?qte=13 → 500/);
  assert.match(err(8), /constaté : aucune requête correspondante depuis #\d+ ;/);
  assert.equal(res.steps[3]!.status, 417);

  // Nouveau document : les requêtes de l'ancien ne comptent plus (défaut : début du document courant)…
  const doc = await cli(['run'], `nav ${site.url}/boutique
expect request "POST /api/commande" 5xx --timeout 0
`);
  assert.equal(doc.code, 1, doc.stdout);
  assert.match(doc.stdout, /aucune requête correspondante depuis #\d+/);
  // … sauf avec --since 0.
  assert.equal((await cli(['expect', 'request', 'POST /api/commande', '5xx', '--since', '0', '--timeout', '0'])).code, 0);
});

test('expect request relue jusqu\'au délai : la réponse arrive après l\'action', async () => {
  assert.equal((await cli(['nav', `${site.url}/long-poll`])).code, 0);
  // /api/lent?ms=10000 en vol : pas encore de statut → échec annoncé « en cours », jamais tenu à tort.
  const r = await cli(['expect', 'request', 'GET /api/lent', '--timeout', '300']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /aucune terminée de statut 2xx : #\d+ GET .*\/api\/lent\?ms=10000 → en cours/);
});

test('expect request relue jusqu\'au délai : une réponse arrivée pendant --timeout fait tenir l\'assertion', async () => {
  assert.equal((await cli(['nav', `${site.url}/enregistrer-nav`])).code, 0);
  // POST lent (1,5 s) lancé 800 ms après le clic : l'action rend la main avant, la réponse arrive pendant le délai.
  assert.equal((await cli(['click', '#differe'])).code, 0);
  const now = await cli(['expect', 'request', 'POST /api/lent', '--timeout', '0']);
  assert.equal(now.code, 1, 'pas encore de réponse à la première lecture');
  const r = await cli(['expect', 'request', 'POST /api/lent', '--timeout', '5000']);
  assert.equal(r.code, 0, r.stderr);
});

test('expect request : un « Enregistrer » qui change de page (fetch puis navigation, formulaire POST en PRG) reste vu', async () => {
  // fetch POST puis location.href : la requête précède le nouveau document, mais fait partie de la dernière action.
  assert.equal((await cli(['nav', `${site.url}/enregistrer-nav`])).code, 0);
  assert.equal((await cli(['click', '#fetch-nav'])).code, 0);
  await cli(['wait', 'text:Commander', '--timeout', '5000']);
  const f = await cli(['expect', 'request', 'POST /api/commande', '--timeout', '500']);
  assert.equal(f.code, 0, f.stderr);

  // Formulaire POST classique : POST → 302 → GET /boutique. Le saut de redirection ne fait pas sortir le POST.
  assert.equal((await cli(['nav', `${site.url}/enregistrer-nav`])).code, 0);
  assert.equal((await cli(['click', '#prg'])).code, 0);
  await cli(['wait', 'text:Commander', '--timeout', '5000']);
  const p = await cli(['expect', 'request', 'POST /redirect-to', '3xx', '--timeout', '500']);
  assert.equal(p.code, 0, p.stderr);

  // Méthode en minuscules : reconnue (normalisée en capitales), jamais un faux « aucune requête ».
  assert.equal((await cli(['expect', 'request', 'get /boutique', '--timeout', '500'])).code, 0);

  // Requête hors de la fenêtre par défaut (action suivante sans requête, nouveau document) : le constaté la cite et
  // propose --since.
  assert.equal((await cli(['nav', `${site.url}/boutique`])).code, 0);
  const old = await cli(['expect', 'request', 'POST /redirect-to', '3xx', '--timeout', '0']);
  assert.equal(old.code, 1);
  assert.match(old.stderr, /requête correspondante plus ancienne, hors de la fenêtre : #(\d+) POST .*\/redirect-to.* → 302 Found .* — relancez avec --since \d+/);
});

test('sécurité : ni en-têtes, ni corps, ni jeton dans le journal ; URL masquée', async () => {
  assert.equal((await cli(['nav', `${site.url}/console`])).code, 0);
  const r = await cli(['click', '#secret', '--network']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`POST ${site.url.replace(/\./g, '\\.')}/api/secret\\?token=\\*\\*\\*&page=2 → 401 Unauthorized`));
  const j = (await cli(['network', '--json', '--max', '1000'])).stdout;
  for (const s of [r.stdout, r.stderr, j]) {
    for (const secret of ['abc123', 'SECRET-AUTH', 'Bearer', 'corps-secret', 'corps-réponse-secret']) assert.ok(!s.includes(secret), `${secret} divulgué :\n${s}`);
  }
});

test('allowConsole=false : network, --network et expect request → 403 explicite ; grasp security le dit', async () => {
  const off = await serverWith({ allowedDomains: ['127.0.0.1'], allowConsole: false });
  try {
    const c = (args: string[]) => runCli(off.env, args);
    assert.equal((await c(['nav', `${site.url}/boutique`])).code, 0);
    const n = await c(['network']);
    assert.equal(n.code, 1);
    assert.match(n.stderr, /^ERROR: network: journal réseau indisponible : allowConsole=false, le domaine CDP Network n'est pas activé/m);
    assert.match(n.stderr, /\(clé allowConsole\)\. .*décision de l'utilisateur humain/);
    assert.doesNotMatch(n.stderr, /config set/);
    const a = await c(['click', 'text:Commander', '--network']);
    assert.equal(a.code, 1);
    assert.match(a.stderr, /journal réseau indisponible/);
    assert.equal((await c(['nav', `${site.url}/boutique`, '--network'])).code, 1);
    const e = await c(['expect', 'request', 'POST /api/commande', '--timeout', '2000']);
    assert.equal(e.code, 1);
    assert.match(e.stderr, /journal réseau indisponible/, 'refus immédiat, jamais un échec « aucune requête »');
    const s = await c(['security']);
    assert.match(s.stdout, /^réseau {5}: désactivé \(domaine Network inactif, suit allowConsole\)$/m);
  } finally { off.srv.proc.kill('SIGTERM'); await waitExit(off.srv.proc); off.t.cleanup(); }
  assert.match((await cli(['security'])).stdout, /^réseau {5}: journal lisible \(méthode, URL masquée, statut, durée ; jamais d'en-têtes ni de corps\)$/m);
});
