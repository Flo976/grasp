import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openPage } from '../helpers/chrome.js';
import { startHttpProxy, startSocks5Proxy } from '../helpers/proxy.js';
import { GraspError } from '../../src/core/errors.js';
import { parseHttpAuth } from '../../src/core/remote.js';
import { formatEntry } from '../../src/core/console.js';
import { makeTestEnv } from '../helpers/env.js';
import { runCli, startServer, waitExit } from '../helpers/server.js';
import { resolvePaths } from '../../src/core/paths.js';
import { request } from '../../src/core/http.js';

/**
 * Recette sur serveur distant, reproduite en local : un vhost qui n'attend que son vrai nom (Host:), joint par
 * --host-resolver-rules comme à travers un `ssh -L` ; un proxy SOCKS5/HTTP qui résout lui-même les noms comme
 * le rebond d'un `ssh -D` ; un certificat auto-signé ; une préprod en HTTP basic. Jamais de site externe.
 */

interface Hit { host: string; path: string; auth: string | undefined }
const hits: Hit[] = [];
const PASS = 'S3cr3t-m0t:de@passe';
const BASIC = `Basic ${Buffer.from(`recette:${PASS}`).toString('base64')}`;

/** Vhost « site.exemple.test » : toute autre valeur de Host: reçoit la page par défaut d'Apache, en somme. */
function vhost(req: IncomingMessage, res: ServerResponse): void {
  const host = String(req.headers.host ?? '').replace(/:\d+$/, '');
  hits.push({ host, path: req.url ?? '/', auth: req.headers.authorization });
  if (host === 'preprod.exemple.test' || host === 'autre-preprod.exemple.test') {
    if (req.headers.authorization !== BASIC) { res.writeHead(401, { 'www-authenticate': 'Basic realm="preprod"', 'content-type': 'text/html' }); res.end('<title>401</title>Authentification requise'); return; }
    if (req.url === '/style.css') { res.writeHead(200, { 'content-type': 'text/css' }); res.end('body{}'); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>Préprod</title><link rel="stylesheet" href="/style.css"><h1>Préprod protégée</h1>');
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  if (host === 'site.exemple.test' || host === 'site.distant.test') res.end(`<!doctype html><title>Vhost ${host}</title><h1>Bienvenue sur ${host}</h1>`);
  else res.end('<!doctype html><title>Défaut</title><h1>It works!</h1>');
}

let http: Server;
let https: Server;
let httpPort = 0;
let httpsPort = 0;
const listen = (s: Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as { port: number }).port)));

before(async () => {
  http = createServer(vhost);
  const tls = join(process.cwd(), 'test', 'fixtures', 'tls');
  https = createHttpsServer({ key: readFileSync(join(tls, 'key.pem')), cert: readFileSync(join(tls, 'cert.pem')) }, vhost);
  httpPort = await listen(http);
  httpsPort = await listen(https);
});
after(async () => { http.closeAllConnections(); https.closeAllConnections?.(); await new Promise((r) => http.close(r)); await new Promise((r) => https.close(r)); });

test('hostResolverRules : le vhost est joint par son vrai nom (Host:), port réécrit comme un ssh -L', async () => {
  const rules = [`MAP site.exemple.test 127.0.0.1:${httpPort}`];
  const fx = await openPage({ allowedDomains: ['site.exemple.test'], hostResolverRules: rules });
  try {
    // Port 80 dans l'URL, servi par 127.0.0.1:<port> : la règle porte aussi le port.
    const r = await fx.page.navigate('http://site.exemple.test/');
    assert.equal(r.title, 'Vhost site.exemple.test');
    assert.equal(r.url, 'http://site.exemple.test/', 'l\'URL garde le nom, pas l\'adresse');
    assert.ok(hits.some((h) => h.host === 'site.exemple.test' && h.path === '/'), 'Host: site.exemple.test reçu par le vhost');
    // L'allowlist porte sur le nom : l'adresse cible n'est pas autorisée pour autant.
    await assert.rejects(fx.page.navigate(`http://127.0.0.1:${httpPort}/`), (e: GraspError) => e.status === 403);
  } finally { await fx.close(); }
});

test('hostResolverRules : l\'allowlist s\'applique au nom demandé, jamais à l\'IP mappée', async () => {
  const fx = await openPage({ allowedDomains: ['127.0.0.1'], hostResolverRules: [`MAP site.exemple.test 127.0.0.1:${httpPort}`] });
  try {
    const before = hits.length;
    await assert.rejects(fx.page.navigate('http://site.exemple.test/'), (e: GraspError) => e.status === 403);
    assert.equal(hits.length, before, 'aucune requête n\'est partie');
  } finally { await fx.close(); }
});

test('proxyServer SOCKS5 (ssh -D) : le nom est résolu par le rebond ; un nom hors allowlist ne lui parvient jamais', async () => {
  const proxy = await startSocks5Proxy(() => ({ host: '127.0.0.1', port: httpPort }));
  const fx = await openPage({ allowedDomains: ['site.distant.test'], proxyServer: proxy.url });
  try {
    const r = await fx.page.navigate('http://site.distant.test/');
    assert.equal(r.title, 'Vhost site.distant.test');
    assert.ok(proxy.seen.includes('site.distant.test:80'), `le proxy a reçu le NOM (DNS côté rebond) : ${proxy.seen.join(', ')}`);
    // Garde runtime : un lien vers un hôte hors allowlist est annulé avant de partir vers le proxy.
    await assert.rejects(fx.page.navigate('http://hors-liste.distant.test/'), (e: GraspError) => e.status === 403);
    assert.ok(!proxy.seen.some((h) => h.startsWith('hors-liste')), `requête partie : ${proxy.seen.join(', ')}`);
  } finally { await fx.close(); await proxy.close(); }
});

test('proxyServer HTTP : même chose par un proxy http://', async () => {
  const proxy = await startHttpProxy(() => ({ host: '127.0.0.1', port: httpPort }));
  const fx = await openPage({ allowedDomains: ['site.distant.test'], proxyServer: proxy.url });
  try {
    assert.equal((await fx.page.navigate('http://site.distant.test/')).title, 'Vhost site.distant.test');
    assert.ok(proxy.seen.includes('site.distant.test:80'), proxy.seen.join(', '));
  } finally { await fx.close(); await proxy.close(); }
});

test('certificats : vérifiés par défaut ; ignoreCertErrorsFor ne vaut que pour les hôtes listés', async () => {
  const rules = [`MAP site.exemple.test 127.0.0.1:${httpsPort}`, `MAP autre.exemple.test 127.0.0.1:${httpsPort}`];
  const strict = await openPage({ allowedDomains: ['site.exemple.test'], hostResolverRules: rules });
  try {
    await assert.rejects(strict.page.navigate('https://site.exemple.test/'), (e: GraspError) => /CERT/.test(e.message), 'certificat auto-signé refusé par défaut');
  } finally { await strict.close(); }
  const fx = await openPage({ allowedDomains: ['site.exemple.test', 'autre.exemple.test'], hostResolverRules: rules, ignoreCertErrorsFor: ['site.exemple.test'] });
  try {
    assert.equal((await fx.page.navigate('https://site.exemple.test/')).title, 'Vhost site.exemple.test');
    const n = hits.length;
    // Même certificat, même serveur, mais hôte non listé : refusé.
    await assert.rejects(fx.page.navigate('https://autre.exemple.test/'), (e: GraspError) => e.status === 502);
    assert.equal(hits.length, n, 'aucune requête HTTP n\'a atteint le serveur pour l\'hôte non listé');
    const log = (await fx.page.consoleQuery({ limit: 100 })).entries.map(formatEntry).join('\n');
    assert.match(log, /certificat TLS NON vérifié accepté pour site\.exemple\.test/);
    assert.match(log, /certificat TLS refusé .*autre\.exemple\.test/);
  } finally { await fx.close(); }
});

test('HTTP basic : identifiants fournis au seul hôte prévu, sous-ressources comprises, jamais dans la console', async () => {
  const rules = [`MAP preprod.exemple.test 127.0.0.1:${httpPort}`, `MAP autre-preprod.exemple.test 127.0.0.1:${httpPort}`];
  const fx = await openPage({ allowedDomains: ['preprod.exemple.test', 'autre-preprod.exemple.test'], hostResolverRules: rules }, undefined, {}, [parseHttpAuth(`recette:${PASS}@preprod.exemple.test`)]);
  try {
    assert.equal((await fx.page.navigate('http://preprod.exemple.test/')).title, 'Préprod');
    assert.match(await fx.page.text(), /Préprod protégée/);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(hits.filter((h) => h.host === 'preprod.exemple.test' && h.path === '/style.css').at(-1)?.auth, BASIC, 'feuille de style servie avec les identifiants');
    // Autre hôte (même serveur, dans l'allowlist) : aucun identifiant ne lui est envoyé.
    assert.equal((await fx.page.navigate('http://autre-preprod.exemple.test/')).title, '401');
    assert.ok(hits.filter((h) => h.host === 'autre-preprod.exemple.test').every((h) => h.auth === undefined), 'identifiants envoyés à un autre hôte');
    assert.deepEqual(fx.page.httpAuthReport(), [{ host: 'preprod.exemple.test', credentials: '***' }]);
    const log = JSON.stringify(await fx.page.consoleQuery({ limit: 1000 }));
    assert.ok(!log.includes(PASS) && !log.includes(BASIC.slice(6)), 'identifiants dans la console');
  } finally { await fx.close(); }
});

test('HTTP basic : identifiants refusés → un seul essai, page 401 et erreur explicite (pas de boucle)', async () => {
  const fx = await openPage({ allowedDomains: ['preprod.exemple.test'], hostResolverRules: [`MAP preprod.exemple.test 127.0.0.1:${httpPort}`] }, undefined, {}, [parseHttpAuth('recette:mauvais-mot@preprod.exemple.test')]);
  try {
    const n = hits.length;
    assert.equal((await fx.page.navigate('http://preprod.exemple.test/')).title, '401');
    const tries = hits.slice(n).filter((h) => h.host === 'preprod.exemple.test' && h.path === '/');
    assert.ok(tries.length <= 2, `${tries.length} requêtes : une sans, une avec identifiants, pas plus`);
    const log = (await fx.page.consoleQuery({ limit: 100 })).entries.map(formatEntry).join('\n');
    assert.match(log, /authentification HTTP refusée par preprod\.exemple\.test/);
    assert.ok(!log.includes('mauvais-mot'));
  } finally { await fx.close(); }
});

/** Tous les fichiers sous `dir` qui contiennent `needle` (journaux, config, état, profils). */
function filesContaining(dir: string, needle: string): string[] {
  const found: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p);
      else if (st.isFile() && st.size < 64 * 1024 * 1024) { try { if (readFileSync(p).includes(needle)) found.push(p); } catch { /* socket, fichier verrouillé */ } }
    }
  };
  walk(dir);
  return found;
}

test('bout en bout (CLI) : vhost par hostResolverRules + préprod en basic auth par --http-auth -, identifiants jamais écrits ni affichés', async () => {
  const t = makeTestEnv();
  const paths = resolvePaths(t.env, t.env.HOME);
  mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
  const cfg = {
    allowedDomains: ['preprod.exemple.test', 'site.exemple.test'],
    hostResolverRules: [`MAP preprod.exemple.test 127.0.0.1:${httpPort}`, `MAP site.exemple.test 127.0.0.1:${httpsPort}`],
    ignoreCertErrorsFor: ['site.exemple.test'],
  };
  writeFileSync(paths.configFile, JSON.stringify(cfg), { mode: 0o600 });
  const srv = await startServer(t.env);
  try {
    assert.match(srv.stderr(), /AVERTISSEMENT : certificats TLS NON vérifiés pour site\.exemple\.test/, 'avertissement au démarrage');
    // Identifiants sur stdin : ni dans la ligne de commande, ni dans l'historique.
    const created = await runCli(t.env, ['session', 'create', '--http-auth', '-'], `recette:${PASS}@preprod.exemple.test\n`);
    assert.equal(created.code, 0, created.stderr);
    const id = created.stdout.trim();
    const env = { ...t.env, GRASP_SESSION: id };
    assert.equal((await runCli(env, ['nav', 'http://preprod.exemple.test/'])).code, 0);
    assert.match((await runCli(env, ['text'])).stdout, /Préprod protégée/);
    const tls = await runCli(env, ['nav', 'https://site.exemple.test/']);
    assert.equal(tls.code, 0, tls.stderr);
    assert.match((await runCli(env, ['text'])).stdout, /Bienvenue sur site\.exemple\.test/);

    const human = await runCli(env, ['security']);
    assert.equal(human.code, 0, human.stderr);
    assert.match(human.stdout, /résolution : MAP preprod\.exemple\.test 127\.0\.0\.1:\d+ ; MAP site\.exemple\.test/);
    assert.match(human.stdout, /certificats: NON VÉRIFIÉS pour site\.exemple\.test/);
    assert.match(human.stdout, new RegExp(`session ${id} : auth HTTP preprod\\.exemple\\.test \\(identifiants masqués\\)`));
    const json = await runCli(env, ['security', '--json']);
    const rep = JSON.parse(json.stdout);
    assert.deepEqual(rep.sessionOptions[id], { proxyServer: null, httpAuth: [{ host: 'preprod.exemple.test', credentials: '***' }] });
    // Le rapport lit le bridge : même objet que sa route /session-options.
    const bridge = (await request({ transport: 'unix', socketPath: `${paths.bridgesDir}/${id}.sock` }, 'GET', '/session-options')).json();
    assert.deepEqual(rep.sessionOptions[id], bridge);
    const list = await runCli(env, ['session', 'list', '--json']);
    const console = await runCli(env, ['console', '--json']);
    for (const r of [human, json, list, console, created]) {
      assert.ok(!r.stdout.includes(PASS) && !r.stderr.includes(PASS), `identifiants affichés : ${r.stdout}${r.stderr}`);
      assert.ok(!r.stdout.includes('recette:') && !r.stdout.includes(BASIC.slice(6)), 'identifiants affichés');
    }
    assert.ok(!srv.stderr().includes(PASS), 'identifiants dans le journal du serveur');
    assert.match(srv.stderr(), /authentification HTTP pour preprod\.exemple\.test/);
    // Rien sur disque : config, état, journaux de Chrome, profils.
    assert.deepEqual(filesContaining(t.root, PASS), []);
    assert.deepEqual(filesContaining(t.root, BASIC.slice(6)), []);
  } finally { srv.proc.kill('SIGTERM'); await waitExit(srv.proc); t.cleanup(); }
});

test('bout en bout (CLI) : identifiants pour un hôte hors allowlist refusés, sans les recopier ; proxy par session rapporté', async () => {
  const t = makeTestEnv();
  const srv = await startServer(t.env);
  try {
    const r = await runCli(t.env, ['session', 'create', '--http-auth', `recette:${PASS}@preprod.exemple.test`]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /hors allowlist : preprod\.exemple\.test/);
    assert.ok(!r.stderr.includes(PASS));
    const proxy = await startSocks5Proxy(() => ({ host: '127.0.0.1', port: httpPort }));
    try {
      const c = await runCli(t.env, ['session', 'create', '--proxy', proxy.url]);
      assert.equal(c.code, 0, c.stderr);
      const sec = await runCli(t.env, ['security']);
      assert.match(sec.stdout, new RegExp(`session ${c.stdout.trim()} : proxy socks5://127\\.0\\.0\\.1:\\d+ \\(propre à la session\\)`));
      assert.match(sec.stdout, /proxy {6}: aucun \(connexion directe\)/);
    } finally { await proxy.close(); }
    assert.ok(!srv.stderr().includes(PASS));
  } finally { srv.proc.kill('SIGTERM'); await waitExit(srv.proc); t.cleanup(); }
});
