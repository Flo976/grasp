#!/usr/bin/env node
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePaths, type GraspPaths } from '../core/paths.js';
import { request, type Endpoint, type HttpResult } from '../core/http.js';
import { loadConfigFile, resolveConfig, setConfigKey, unsetConfigKey, isConfigKey, PUBLIC_KEYS, keyHelp } from '../core/config.js';
import { startControlPlane } from '../control/server.js';
import { isGraspServer, isProcessAlive } from '../control/procutil.js';
import { installDaemon, uninstallDaemon, systemdStatus } from './daemon.js';
import { runDoctor } from './doctor.js';
import { runMcp } from './mcp.js';
import { killWindowsChrome } from '../browser/windows.js';
import { ensurePrivateDir, writePrivateFile } from '../core/perms.js';
import { formatEntry, type ConsoleEntry, type ConsoleResult } from '../core/console.js';
import { formatReport, type RunResult } from '../control/run.js';
import { parseArgs, buildRequest, consoleBody, readQuery, renderEval, shotQuery, waitRequest, type Args } from '../core/script.js';

/**
 * CLI : client mince du control plane. Aucune logique métier ici.
 * stdout = résultat (OK, snapshot, id…) ; stderr = conseils, avertissements, erreurs.
 */

class CliError extends Error {
  /** Champs supplémentaires du corps d'erreur (ex. entrées console produites pendant l'action). */
  constructor(message: string, readonly extra?: Record<string, unknown>) { super(message); }
}

const out = (s: string) => process.stdout.write(s.endsWith('\n') ? s : `${s}\n`);
const hint = (s: string) => process.stderr.write(`${s}\n`);

/** GRASP_URL=http://hôte:port : serveur TCP désigné explicitement (ex. conteneur publié sur l'hôte). */
function endpointFromUrl(raw: string): Endpoint {
  let u: URL;
  try { u = new URL(raw); } catch { throw new CliError(`GRASP_URL=${raw} : URL invalide (http://hôte:port attendu)`); }
  if (u.protocol !== 'http:' || u.port === '' || (u.pathname !== '/' && u.pathname !== '')) throw new CliError(`GRASP_URL=${raw} : http://hôte:port attendu (port explicite, sans chemin)`);
  return { transport: 'tcp', host: u.hostname.replace(/^\[|\]$/g, ''), port: Number(u.port) };
}

function endpointOf(paths: GraspPaths): Endpoint {
  const url = process.env.GRASP_URL;
  if (url) return endpointFromUrl(url);
  if (existsSync(paths.endpointFile)) return JSON.parse(readFileSync(paths.endpointFile, 'utf8')) as Endpoint;
  return { transport: 'unix', socketPath: paths.socketPath };
}

class Client {
  constructor(private readonly paths: GraspPaths, private readonly session: string | undefined) {}

  async call(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<HttpResult> {
    let token: string;
    try { token = readFileSync(this.paths.tokenFile, 'utf8').trim(); } catch {
      throw new CliError(`token introuvable (${this.paths.tokenFile}) : le serveur n'a jamais démarré — \`grasp serve\``);
    }
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (this.session) headers['x-grasp-session'] = this.session;
    let r: HttpResult;
    try { r = await request(endpointOf(this.paths), method, path, body, headers, timeoutMs); } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ECONNREFUSED') throw new CliError('serveur injoignable — lancez `grasp serve` (ou `grasp daemon install`)');
      throw e;
    }
    // Note du control plane sur cette commande (navigateur recyclé juste avant), succès comme échec.
    const notice = r.headers['x-grasp-notice'];
    if (typeof notice === 'string') hint(`note: ${decodeURIComponent(notice)}`);
    if (r.status >= 400) {
      let msg = r.text();
      let extra: Record<string, unknown> | undefined;
      try { extra = r.json() as Record<string, unknown>; msg = String(extra.error ?? msg); } catch { /* texte brut */ }
      throw new CliError(msg, extra);
    }
    return r;
  }
}

/** Rend le résultat d'une action mutante : OK (ou le diff si --snap-diff), puis la console si --console. */
function renderAction(r: HttpResult, a: Args): void {
  const j = r.json() as { diff?: string; detail?: string; console?: ActionConsole; trackersBlocked?: number };
  if (a.flags.has('json')) { out(JSON.stringify(j)); return; }
  if (j.detail) hint(`note: ${j.detail}`);
  if (typeof j.trackersBlocked === 'number' && j.trackersBlocked > 0) hint(`traqueurs bloqués : ${j.trackersBlocked} requête(s) (grasp console pour le détail)`);
  out(j.diff !== undefined ? j.diff : 'OK');
  if (j.console !== undefined) {
    if (j.console.entries.length > 0) out(j.console.entries.map(formatEntry).join('\n'));
    consoleLosses(j.console);
    hint(`console : ${j.console.entries.length === 0 ? 'aucune nouvelle entrée, ' : ''}seq courant ${j.console.seq}`);
  }
}

interface ActionConsole { entries: ConsoleEntry[]; seq: number; since?: number; omitted?: number; dropped?: number }

/** --console : lignes écartées (au-delà de 200) et entrées perdues par le tampon, jamais tues. */
function consoleLosses(c: { since?: unknown; omitted?: unknown; dropped?: unknown }): void {
  const since = typeof c.since === 'number' ? c.since : undefined;
  if (typeof c.dropped === 'number' && c.dropped > 0) hint(`AVERTISSEMENT : ${c.dropped} entrée(s) console perdue(s) avant lecture (tampon circulaire de 1000 entrées)`);
  if (typeof c.omitted === 'number' && c.omitted > 0) hint(`AVERTISSEMENT : ${c.omitted} ligne(s) console plus ancienne(s) non jointe(s) (200 au plus par action)${since !== undefined ? ` — grasp console --since ${since} --limit 1000` : ''}`);
}

const TRUNCATED_HINT = 'AVERTISSEMENT : capture tronquée (limite de 16384 px de Chrome, en hauteur comme en largeur)';

/** -o fichier : toujours 0600 (fichier existant compris), un lien symbolique est remplacé, jamais suivi. */
function writeOutput(file: string, data: Buffer): void {
  try { writePrivateFile(file, data); } catch (e) { throw new CliError(`impossible d'écrire ${file} : ${(e as Error).message}`); }
}

async function screenshot(c: Client, a: Args): Promise<void> {
  const file = a.flags.get('output');
  if (file === true) throw new CliError('-o attend un fichier (ou - pour stdout)');
  const q = shotQuery(a, file);
  const json = a.flags.has('json');
  if (file === undefined) {
    // Sans -o : fichier 0600 dans l'état de Grasp, et seulement son CHEMIN sur stdout.
    q.set('save', '1');
    const j = (await c.call('GET', `/screenshot?${q}`)).json() as { path: string; width: number; height: number; bytes: number; format: string; truncated?: boolean };
    out(json ? JSON.stringify({ path: j.path, width: j.width, height: j.height, bytes: j.bytes, format: j.format, ...(j.truncated === true ? { truncated: true } : {}) }) : j.path);
    if (j.truncated === true) hint(TRUNCATED_HINT);
    return;
  }
  const r = await c.call('GET', `/screenshot?${q}`);
  if (file === '-') {
    if (process.stdout.isTTY) throw new CliError('sortie binaire : redirigez stdout (ou omettez -o pour obtenir un chemin)');
    process.stdout.write(r.body);
    return;
  }
  writeOutput(file, r.body);
  const truncated = r.headers['x-grasp-truncated'] === '1';
  out(json ? JSON.stringify({ path: resolvePath(file), width: Number(r.headers['x-grasp-width']), height: Number(r.headers['x-grasp-height']), bytes: r.body.length, format: String(r.headers['x-grasp-format']), ...(truncated ? { truncated: true } : {}) }) : 'OK');
  if (truncated) hint(TRUNCATED_HINT);
}

async function consoleCmd(c: Client, a: Args): Promise<void> {
  // Transmis tel quel : le bridge valide (« --since abc » est une erreur 400, jamais un filtre ignoré).
  const body = consoleBody(a);
  const r = (await c.call('POST', '/console', body)).json() as ConsoleResult;
  if (a.flags.has('json')) { out(JSON.stringify(r)); return; }
  if (r.dropped > 0) hint(`AVERTISSEMENT : ${r.dropped} entrée(s) perdue(s) avant lecture (tampon circulaire de 1000 entrées)`);
  if (r.omitted > 0) hint(`${r.omitted} ligne(s) plus ancienne(s) non affichée(s) — --limit N ou --since <seq>`);
  if (r.entries.length > 0) out(r.entries.map(formatEntry).join('\n'));
  hint(`seq courant : ${r.seq} — suite : grasp console --since ${r.seq}${body.clear === true ? ' (tampon vidé)' : ''}`);
}

/** Session visée : --session / GRASP_SESSION, sinon l'unique session ouverte (comme le fait le serveur). */
async function targetSession(c: Client, session: string | undefined): Promise<string> {
  if (session) return session;
  const list = (await c.call('GET', '/sessions')).json() as Array<{ id: string }>;
  if (list.length === 1) return list[0]!.id;
  if (list.length === 0) throw new CliError('aucune session — `grasp session create`');
  throw new CliError(`${list.length} sessions ouvertes : précisez l'id, --session ou GRASP_SESSION`);
}

interface ProfileRow { id: string; name: string; accountEmail: string | null; useWhen?: string; running: boolean; session: string | null; source: string }

function renderProfiles(r: { current: string | null; profiles: ProfileRow[]; root: string }): string {
  if (r.profiles.length === 0) return '';
  const w = Math.max(...r.profiles.map((p) => p.name.length));
  return r.profiles.map((p) => [
    `${p.name === r.current ? '*' : ' '} ${p.name.padEnd(w)}`,
    p.id,
    p.accountEmail ?? '-',
    p.running ? `session ${p.session}` : '',
    p.source === 'imported' ? 'importé' : '',
    p.useWhen !== undefined ? `(${p.useWhen})` : '',
  ].filter((x) => x !== '').join('  ')).join('\n');
}

function need(a: Args, n: number, usage: string): string[] {
  if (a.pos.length < n) throw new CliError(`usage : grasp ${usage}`);
  return a.pos;
}

/** grasp wait [--text T | --sel S | --idle] [--timeout ms] : OK sur stdout, durée sur stderr. */
async function waitCmd(c: Client, a: Args): Promise<void> {
  const w = waitRequest(a);
  const j = (await c.call('POST', '/wait', w.body, w.timeoutMs)).json() as { waited: number; condition: string };
  if (a.flags.has('json')) { out(JSON.stringify(j)); return; }
  out('OK');
  hint(`attendu ${j.waited} ms (${j.condition})`);
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * grasp run [fichier|-] [--continue] : plusieurs commandes en UN aller-retour HTTP, exécutées côté serveur.
 * stdout : « [n] commande → OK|ERROR: raison » puis la sortie utile ; stderr : notes numérotées et bilan.
 */
async function runCmd(c: Client, a: Args): Promise<number> {
  if (a.pos.length > 1) throw new CliError('usage : grasp run [fichier|-] [--continue] [--report|--no-report] [--json]');
  if (a.flags.has('report') && a.flags.has('no-report')) throw new CliError('--report et --no-report s\'excluent');
  const file = a.pos[0];
  let script: string;
  if (file === undefined || file === '-') {
    if (file === undefined && process.stdin.isTTY) throw new CliError('usage : grasp run <fichier> (ou le script sur stdin : grasp run < script.grasp)');
    script = readFileSync(0, 'utf8');
  } else {
    try { script = readFileSync(file, 'utf8'); } catch (e) { throw new CliError(`impossible de lire ${file} : ${(e as Error).message}`); }
  }
  const t0 = Date.now();
  // Rapport : --report, --no-report, sinon décidé par le serveur (oui dès qu'une ligne est un expect).
  const report = a.flags.has('report') ? { report: true } : a.flags.has('no-report') ? { report: false } : {};
  const r = (await c.call('POST', '/run', { script, ...(a.flags.has('continue') ? { continue: true } : {}), ...report }, 60 * 60_000)).json() as RunResult;
  if (a.flags.has('json')) { out(JSON.stringify(r)); return r.ok ? 0 : 1; }
  for (const st of r.steps) {
    out(`[${st.n}] ${st.text} → ${st.ok ? 'OK' : `ERROR: ${st.error ?? 'échec'}`}`);
    if (st.output !== undefined) out(st.output);
    if (st.detail !== undefined) hint(`[${st.n}] note: ${st.detail}`);
  }
  if (r.report !== undefined) out(formatReport(r.report));
  const failed = r.steps.filter((st) => !st.ok);
  const notRun = r.total - r.executed;
  hint(`${plural(r.total, 'commande', 'commandes')}, ${r.steps.length - failed.length} OK${failed.length > 0 ? `, ${failed.length} en échec` : ''}${notRun > 0 ? `, ${notRun} non exécutée${notRun > 1 ? 's' : ''}` : ''} (${Date.now() - t0} ms, un aller-retour)`);
  if (failed.length === 0) return 0;
  if (notRun > 0 || !a.flags.has('continue')) {
    const f = failed[0]!;
    hint(`ERROR: run: étape ${f.n} (${f.text}) : ${f.error ?? 'échec'}`);
    if (notRun > 0) hint(`${plural(notRun, 'commande non exécutée', 'commandes non exécutées')} — --continue pour poursuivre`);
  } else hint(`ERROR: run: ${plural(failed.length, 'étape', 'étapes')} en échec : ${failed.map((f) => f.n).join(', ')}`);
  return 1;
}

/**
 * grasp state export [fichier|-] [--origin a,b] / import <fichier|->. Le fichier contient des secrets (cookies de
 * connexion) : écrit en 0600, atomiquement ; sans fichier, dans l'état de Grasp et seulement son CHEMIN sur stdout.
 */
async function stateCmd(c: Client, a: Args, paths: GraspPaths): Promise<void> {
  const sub = a.pos[0];
  const json = a.flags.has('json');
  if (sub === 'export') {
    const origin = a.flags.get('origin');
    if (origin === true) throw new CliError('--origin attend une ou plusieurs origines (http://hôte:port, séparées par des virgules)');
    const r = await c.call('GET', `/state/export${origin !== undefined ? `?${new URLSearchParams({ origin })}` : ''}`);
    const { state, report } = r.json() as { state: unknown; report: { cookies: number; cookiesExcluded: number; origins: string[]; originsExcluded: string[]; localStorageKeys: number; sessionStorage: string | null; errors: string[] } };
    const data = Buffer.from(`${JSON.stringify(state, null, 2)}\n`);
    let file = a.pos[1];
    if (file === '-') {
      process.stdout.write(data);
    } else {
      if (file === undefined) {
        const dir = join(paths.stateDir, 'etats');
        ensurePrivateDir(dir);
        file = join(dir, `etat-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      }
      writeOutput(file, data);
      out(json ? JSON.stringify({ path: resolvePath(file), ...report }) : resolvePath(file));
    }
    hint(`état exporté : ${report.cookies} cookie(s), localStorage de ${report.origins.length} origine(s) (${report.localStorageKeys} clé(s))${report.origins.length ? ` : ${report.origins.join(', ')}` : ''}, sessionStorage : ${report.sessionStorage ?? 'aucun'} — fichier sensible (sessions de connexion), 0600`);
    if (report.cookiesExcluded > 0) hint(`note: ${report.cookiesExcluded} cookie(s) hors allowlist non exporté(s)`);
    if (report.originsExcluded.length > 0) hint(`note: origine(s) hors allowlist non lue(s) : ${report.originsExcluded.join(', ')}`);
    for (const e of report.errors) hint(`AVERTISSEMENT : ${e}`);
    return;
  }
  if (sub === 'import') {
    const file = a.pos[1];
    if (file === undefined) throw new CliError('usage : grasp state import <fichier|->');
    let state: unknown;
    try { state = JSON.parse(file === '-' ? readFileSync(0, 'utf8') : readFileSync(file, 'utf8')); } catch (e) {
      throw new CliError(`lecture de ${file === '-' ? 'stdin' : file} : ${(e as Error).message}`);
    }
    const r = await c.call('POST', '/state/import', { state });
    const j = r.json() as { cookies: number; origins: number; localStorageKeys: number; sessionStorage: 'applied' | 'pending' | null; skipped: string[] };
    out(json ? r.text() : 'OK');
    if (json) return;
    const ss = j.sessionStorage === 'applied' ? 'appliqué à l\'onglet' : j.sessionStorage === 'pending' ? 'appliqué au premier document de son origine' : 'aucun';
    hint(`état importé : ${j.cookies} cookie(s), localStorage de ${j.origins} origine(s) (${j.localStorageKeys} clé(s)), sessionStorage : ${ss}`);
    for (const s of j.skipped) hint(`AVERTISSEMENT : non importé : ${s}`);
    return;
  }
  throw new CliError('usage : grasp state export [fichier|-] [--origin http://hôte:port,…] | import <fichier|->');
}

/** grasp expect <assertion> … : OK sur stdout (code 0), sinon ERROR: expect: attendu … ; constaté : … (code 1). */
async function expectCmd(c: Client, a: Args): Promise<void> {
  const rq = buildRequest(a);
  const j = (await c.call(rq.method, rq.path, rq.body, rq.timeoutMs)).json() as { waited: number; detail?: string };
  if (a.flags.has('json')) { out(JSON.stringify(j)); return; }
  out('OK');
  if (j.detail !== undefined) hint(`note: ${j.detail}`);
}

async function binary(c: Client, a: Args, path: string, ext: string): Promise<void> {
  const r = await c.call('GET', path);
  const file = a.flags.get('output');
  if (typeof file === 'string') { writeOutput(file, r.body); out(a.flags.has('json') ? JSON.stringify({ ok: true, file, bytes: r.body.length }) : 'OK'); return; }
  if (process.stdout.isTTY) throw new CliError(`sortie binaire : utilisez -o fichier.${ext} ou redirigez stdout`);
  process.stdout.write(r.body);
}

function socketClosed(ep: Endpoint): Promise<boolean> {
  return new Promise((resolve) => {
    if (ep.transport === 'unix' && !existsSync(ep.socketPath)) { resolve(true); return; }
    const s = ep.transport === 'unix' ? connect(ep.socketPath) : connect(ep.port, ep.host);
    s.once('connect', () => { s.destroy(); resolve(false); });
    s.once('error', () => resolve(true));
  });
}

async function stop(paths: GraspPaths, env: NodeJS.ProcessEnv): Promise<void> {
  const ep = endpointOf(paths);
  const pid = existsSync(paths.pidFile) ? Number(readFileSync(paths.pidFile, 'utf8').trim()) : NaN;
  if (!pid || !isProcessAlive(pid)) {
    const stale = ep.transport === 'unix' && existsSync(ep.socketPath) && await socketClosed(ep);
    for (const f of [paths.pidFile, paths.endpointFile]) rmSync(f, { force: true });
    if (stale && ep.transport === 'unix') { rmSync(ep.socketPath, { force: true }); throw new CliError('aucun serveur en cours (socket résiduel supprimé)'); }
    throw new CliError('aucun serveur en cours');
  }
  if (!isGraspServer(pid)) throw new CliError(`le pid ${pid} (${paths.pidFile}) n'est pas un serveur grasp : refus de le tuer`);
  const timeout = Number(env.GRASP_STOP_TIMEOUT_MS ?? 15_000);
  process.kill(pid, 'SIGTERM');
  const end = Date.now() + timeout;
  // On ne rend la main que lorsque le socket est réellement fermé ET le processus parti.
  while (Date.now() < end) {
    if (!isProcessAlive(pid) && await socketClosed(ep)) { out('OK'); return; }
    await new Promise((r) => setTimeout(r, 50));
  }
  // SIGTERM ignoré : on tue, on nettoie, et on le signale bruyamment.
  try { process.kill(pid, 'SIGKILL'); } catch { /* parti entre-temps */ }
  const killEnd = Date.now() + 5000;
  while (isProcessAlive(pid) && Date.now() < killEnd) await new Promise((r) => setTimeout(r, 50));
  let groups = 0;
  try {
    const inst = JSON.parse(readFileSync(paths.instancesFile, 'utf8')) as Array<{ bridgePid: number; chromePgid: number; windowsUserDataDir?: string }>;
    for (const i of inst) {
      try { process.kill(i.bridgePid, 'SIGKILL'); } catch { /* déjà mort */ }
      if (i.chromePgid > 1) { try { process.kill(-i.chromePgid, 'SIGKILL'); groups++; } catch { /* déjà mort */ } }
      // chrome.exe ne meurt pas avec son groupe Linux : on le vise par son --user-data-dir.
      if (i.windowsUserDataDir !== undefined) await killWindowsChrome(i.windowsUserDataDir).catch((e: Error) => hint(`ERREUR : chrome.exe ${i.windowsUserDataDir} : ${e.message}`));
    }
  } catch { /* pas d'instances */ }
  if (ep.transport === 'unix') rmSync(ep.socketPath, { force: true });
  for (const f of [paths.pidFile, paths.endpointFile, paths.instancesFile]) rmSync(f, { force: true });
  if (isProcessAlive(pid)) throw new CliError(`le serveur (pid ${pid}) survit à SIGKILL`);
  throw new CliError(`le serveur (pid ${pid}) n'a pas répondu à SIGTERM en ${timeout} ms : SIGKILL envoyé, ${groups} groupe(s) Chrome tué(s), socket nettoyé`);
}

const SESSION_CREATE_USAGE = 'grasp session create [--profile <nom>] [--proxy socks5://hôte:port] [--http-auth utilisateur:motdepasse@hôte[:port] | --http-auth -]';

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) { reject(new CliError('--http-auth - : identifiants attendus sur stdin (ex. printf \'%s\\n\' "$PREPROD_AUTH" | grasp session create --http-auth -)')); return; }
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d: string) => { buf += d; });
    process.stdin.once('end', () => resolve(buf));
    process.stdin.once('error', reject);
  });
}

function listenLine(rep: any): string {
  const l = rep.listen;
  if (l === undefined || 'socket' in l) return `${rep.transport}${l ? ` (${l.socket})` : ''}`;
  return l.exposed
    ? `tcp ${l.host}:${l.port} — EXPOSÉ hors boucle locale (--listen) : token seul, sans TLS`
    : `tcp ${l.host}:${l.port}`;
}

function renderSecurity(rep: any): string {
  const p = rep.policy;
  const onoff = (b: boolean) => (b ? 'AUTORISÉ' : 'désactivé');
  const certs = p.ignoreCertErrorsFor as string[];
  const rules = p.hostResolverRules as string[];
  const bypass = p.proxyBypassList as string[];
  const sessionLines = Object.entries((rep.sessionOptions ?? {}) as Record<string, { proxyServer?: string | null; httpAuth?: Array<{ host: string }>; error?: string }>).flatMap(([id, o]) => {
    if (o.error !== undefined) return [`session ${id} : ${o.error}`];
    const parts = [
      ...(o.proxyServer ? [`proxy ${o.proxyServer} (propre à la session)`] : []),
      ...(o.httpAuth?.length ? [`auth HTTP ${o.httpAuth.map((h) => h.host).join(', ')} (identifiants masqués)`] : []),
    ];
    return parts.length > 0 ? [`session ${id} : ${parts.join(' ; ')}`] : [];
  });
  const lines = [
    `navigation : ${p.navigation} (garde runtime dans le navigateur)`,
    `allowlist  : ${p.allowedDomains.length === 0 ? '(vide) — tout est bloqué' : p.allowedDomains.join(', ')}`,
    `ssrf       : ${p.allowPrivateNetwork ? 'AUTORISÉ (protection SSRF levée : un nom peut résoudre vers une IP privée)' : 'bloqué (protection SSRF ; seuls les hôtes littéraux inscrits dans l\'allowlist)'}`,
    `eval       : ${onoff(p.allowEval)}`,
    `download   : ${onoff(p.allowDownload)}`,
    `upload     : ${onoff(p.allowUpload)}`,
    `cookies    : ${onoff(p.allowCookies)}`,
    `console    : ${p.allowConsole ? 'AUTORISÉ (lecture seule ; Runtime.enable actif)' : 'désactivé'}`,
    `proxy      : ${p.proxyServer ? `${p.proxyServer}${bypass.length > 0 ? ` (contournement : ${bypass.join(', ')})` : ''}` : 'aucun (connexion directe)'}`,
    `résolution : ${rules.length > 0 ? `${rules.join(' ; ')} (allowlist appliquée au nom demandé)` : 'système'}`,
    `certificats: ${certs.length > 0 ? `NON VÉRIFIÉS pour ${certs.join(', ')} (ignoreCertErrorsFor) ; vérifiés ailleurs` : 'vérifiés'}`,
    `traqueurs  : ${p.blockTrackers === true ? 'bloqués (liste de Peter Lowe)' : p.blockTrackers === false ? 'non bloqués' : 'inconnu (serveur antérieur)'}`,
    `token      : ${p.tokenRequired ? 'exigé' : 'NON exigé'}`,
    `transport  : ${listenLine(rep)}`,
    `sessions   : ${Object.keys(rep.bridges).length}`,
    ...sessionLines.map((l) => `  ${l}`),
  ];
  return lines.join('\n');
}

async function main(argv: string[]): Promise<number> {
  const env = process.env;
  const home = env.HOME ?? homedir();
  const paths = resolvePaths(env, home);
  const a = parseArgs(argv);
  const session = typeof a.flags.get('session') === 'string' ? a.flags.get('session') as string : (env.GRASP_SESSION || undefined);
  const c = new Client(paths, session);
  const json = a.flags.has('json');
  /** Action isolée : même construction de requête que `grasp run`. */
  const action = async () => { const rq = buildRequest(a); renderAction(await c.call(rq.method, rq.path, rq.body, rq.timeoutMs), a); };
  switch (a.cmd) {
    case 'serve': {
      const port = a.flags.get('port');
      const cp = await startControlPlane({
        paths, env, home,
        transport: a.flags.has('tcp') ? 'tcp' : undefined,
        port: typeof port === 'string' ? Number(port) : undefined,
        listen: typeof a.flags.get('listen') === 'string' ? a.flags.get('listen') as string : undefined,
      });
      if (cp.endpoint.transport === 'tcp') hint(`TCP ${cp.endpoint.host}:${cp.endpoint.port} — token exigé (${paths.tokenFile})`);
      await new Promise<void>((resolve) => {
        const onSignal = (sig: string) => {
          if (env.GRASP_TEST_IGNORE_SIGTERM === '1' && sig === 'SIGTERM') return; // crochet de test : serveur sourd
          void cp.close().then(resolve);
        };
        process.on('SIGTERM', () => onSignal('SIGTERM'));
        process.on('SIGINT', () => onSignal('SIGINT'));
      });
      return 0;
    }
    case 'stop': await stop(paths, env); return 0;
    case 'mcp': {
      // Serveur MCP sur stdio : stdout appartient au protocole (voir src/cli/mcp.ts).
      const prof = a.flags.get('profile');
      if (prof === true || a.pos.length > 0) throw new CliError('usage : grasp mcp [--session <id>] [--profile <nom>] [--no-serve]');
      await runMcp({ paths, env, session, profile: typeof prof === 'string' ? prof : undefined, autoServe: !a.flags.has('no-serve') });
      return 0;
    }
    case 'status': {
      const r = await c.call('GET', '/health');
      const j = r.json();
      out(json ? JSON.stringify(j) : `en cours (pid ${j.pid}, ${j.sessions} session(s), Chrome ${j.chrome})`);
      return 0;
    }
    case 'session': {
      const sub = a.pos[0];
      if (sub === 'create') {
        const prof = a.flags.get('profile');
        if (prof === true) throw new CliError(`usage : ${SESSION_CREATE_USAGE}`);
        const proxy = a.flags.get('proxy');
        const auth = a.flags.get('http-auth');
        // --http-auth - : identifiants lus sur stdin (un par ligne), absents de la ligne de commande (ps, historique).
        const httpAuth = auth === '-' ? (await readStdin()).split(/\r?\n/).filter((l) => l.trim() !== '') : typeof auth === 'string' ? [auth] : undefined;
        if (auth === '-' && httpAuth?.length === 0) throw new CliError('--http-auth - : aucun identifiant reçu sur stdin (utilisateur:motdepasse@hôte, un par ligne)');
        const body = {
          ...(typeof prof === 'string' ? { profile: prof } : {}),
          ...(typeof proxy === 'string' ? { proxyServer: proxy } : {}),
          ...(httpAuth !== undefined ? { httpAuth } : {}),
        };
        const r = await c.call('POST', '/sessions', body);
        const j = r.json() as { id: string; profileCreated?: boolean };
        out(json ? r.text() : j.id);
        if (j.profileCreated === true) hint(`profil « ${prof as string} » créé (vide) : connectez-vous une fois dans ce profil (headless=false) pour que l'agent réutilise la session — \`grasp profiles\` pour la liste`);
        hint(`astuce : export GRASP_SESSION=${j.id}`); // stderr : `export S=$(grasp session create)` reste propre
        return 0;
      }
      if (sub === 'list') {
        const list = (await c.call('GET', '/sessions')).json() as Array<{ id: string; profile: string | null; createdAt: string; proxyServer?: string | null; httpAuth?: Array<{ host: string }> }>;
        if (json) out(JSON.stringify(list));
        else if (list.length) {
          out(list.map((s) => [s.id, s.profile ?? '(éphémère)', s.createdAt,
            ...(s.proxyServer ? [`proxy ${s.proxyServer}`] : []),
            ...(s.httpAuth?.length ? [`auth HTTP ${s.httpAuth.map((h) => h.host).join(',')} (identifiants masqués)`] : []),
          ].join('\t')).join('\n'));
        }
        return 0;
      }
      if (sub === 'close') {
        const explicit = a.pos[1] ?? session;
        const id = await targetSession(c, explicit);
        await c.call('DELETE', `/sessions/${encodeURIComponent(id)}`);
        out('OK');
        if (explicit === undefined) hint(`session ${id} fermée`);
        return 0;
      }
      throw new CliError(`usage : ${SESSION_CREATE_USAGE} | list | close [id]`);
    }
    case 'nav': case 'click': case 'fill': case 'select': case 'check': case 'press': case 'hover': case 'type': await action(); return 0;
    case 'snap': out((await c.call('GET', `/snap${readQuery(a)}`)).text()); return 0;
    case 'text': {
      const t = (await c.call('GET', `/text${readQuery(a)}`)).text();
      if (t !== '') out(t);
      else { const sc = a.flags.get('scope'); hint(`note: aucun texte visible ${typeof sc === 'string' ? `dans la zone ${sc}` : 'dans la page'}`); }
      return 0;
    }
    case 'wait': await waitCmd(c, a); return 0;
    case 'expect': await expectCmd(c, a); return 0;
    case 'run': return runCmd(c, a);
    case 'profiles': {
      const sub = a.pos[0];
      if (sub === undefined || sub === 'list') {
        const r = (await c.call('GET', '/profiles')).json() as { current: string | null; profiles: ProfileRow[]; root: string };
        if (json) out(JSON.stringify(r));
        else { const t = renderProfiles(r); if (t) out(t); else hint(`aucun profil (${r.root}) — \`grasp profiles create <nom>\``); }
        return 0;
      }
      if (sub === 'create') {
        const name = a.pos[1];
        if (name === undefined) throw new CliError('usage : grasp profiles create <nom> [--use-when "quand l\'utiliser"]');
        const useWhen = a.flags.get('use-when');
        const r = await c.call('POST', '/profiles', { name, ...(typeof useWhen === 'string' ? { useWhen } : {}) });
        out(json ? r.text() : 'OK');
        if (!json) hint(`profil « ${name} » : ${r.json().path}`);
        return 0;
      }
      if (sub === 'import') {
        const [, name, src] = a.pos;
        if (name === undefined || src === undefined) throw new CliError('usage : grasp profiles import <nom> <répertoire de données Chrome> [--profile-directory "Profile 9"] [--skip-locked]');
        const pd = a.flags.get('profile-directory');
        const body = { name, sourcePath: resolvePath(src), ...(typeof pd === 'string' ? { profileDirectory: pd } : {}), ...(a.flags.has('skip-locked') ? { skipLocked: true } : {}) };
        const r = await c.call('POST', '/profiles/import', body, 30 * 60_000);
        const j = r.json() as { profile: { name: string; path: string; accountEmail: string | null }; skipped: string[]; warnings: string[] };
        out(json ? r.text() : 'OK');
        for (const w of j.warnings) hint(`AVERTISSEMENT : ${w}`);
        if (j.skipped.length) hint(`AVERTISSEMENT : ${j.skipped.length} fichier(s) verrouillé(s) non importé(s) : ${j.skipped.join(', ')}`);
        if (!json) hint(`profil « ${j.profile.name} » importé dans ${j.profile.path}${j.profile.accountEmail ? ` (compte ${j.profile.accountEmail})` : ''}`);
        return 0;
      }
      if (sub === 'rm') {
        const name = a.pos[1];
        if (name === undefined) throw new CliError('usage : grasp profiles rm <nom>');
        await c.call('DELETE', `/profiles/${encodeURIComponent(name)}`);
        out('OK');
        return 0;
      }
      throw new CliError('usage : grasp profiles [list] | create <nom> [--use-when …] | import <nom> <chemin> [--profile-directory "Profile 9"] [--skip-locked] | rm <nom>');
    }
    case 'profile': {
      const [name] = need(a, 1, 'profile <nom>   (bascule la session courante sur ce profil)');
      const id = await targetSession(c, session);
      const r = await c.call('POST', `/sessions/${encodeURIComponent(id)}/profile`, { name }, 180_000);
      const j = r.json() as { unchanged: boolean; profile: string; previous: string | null };
      if (json) { out(r.text()); return 0; }
      out('OK');
      if (j.unchanged) hint(`la session ${id} est déjà sur le profil « ${name} »`);
      else hint(`session ${id} : profil ${j.previous ?? '(éphémère)'} → ${j.profile} ; navigateur relancé, la page repart de about:blank`);
      return 0;
    }
    case 'screenshot': await screenshot(c, a); return 0;
    case 'console': await consoleCmd(c, a); return 0;
    case 'pdf': await binary(c, a, '/pdf', 'pdf'); return 0;
    case 'eval': {
      const [expression] = need(a, 1, 'eval <expression>');
      const j = (await c.call('POST', '/eval', { expression })).json() as { value?: unknown; type?: string };
      // undefined (el.click(), form.submit()) : « undefined », l'expression a bien été exécutée.
      out(json ? JSON.stringify(j) : renderEval(j));
      return 0;
    }
    case 'cookies': out((await c.call('GET', '/cookies')).text()); return 0;
    case 'state': await stateCmd(c, a, paths); return 0;
    case 'upload': await action(); return 0;
    case 'security': {
      // Lit la politique telle que le garde la voit (/security/effective), jamais le fichier.
      const rep = (await c.call('GET', '/security/effective')).json();
      out(json ? JSON.stringify(rep) : renderSecurity(rep));
      for (const [id, p] of Object.entries(rep.bridges as Record<string, unknown>)) {
        if (JSON.stringify(p) !== JSON.stringify(rep.policy)) hint(`AVERTISSEMENT : la session ${id} applique une politique différente : ${JSON.stringify(p)}`);
      }
      if (rep.diskDiffers) hint(`AVERTISSEMENT : ${rep.configFile} a changé depuis le démarrage ; la politique ci-dessus est celle appliquée. Redémarrez (grasp stop && grasp serve) pour appliquer le fichier.`);
      return 0;
    }
    case 'config': {
      const sub = a.pos[0];
      if (sub === 'path') { out(paths.configFile); return 0; }
      if (sub === 'get') {
        const file = loadConfigFile(paths.configFile);
        const cfg = resolveConfig(file);
        const key = a.pos[1];
        if (key !== undefined) {
          if (!isConfigKey(key)) throw new CliError(`clé inconnue « ${key} » (clés : ${PUBLIC_KEYS.join(', ')})`);
          out(json ? JSON.stringify(cfg[key]) : `${JSON.stringify(cfg[key])}${file[key] === undefined ? '  (défaut)' : ''}`);
          return 0;
        }
        if (json) { out(JSON.stringify(cfg)); return 0; }
        out(PUBLIC_KEYS.map((k) => `${k} = ${JSON.stringify(cfg[k])}${file[k] === undefined ? '  (défaut)' : ''}`).join('\n'));
        return 0;
      }
      if (sub === 'set') {
        if (a.pos.length < 3) throw new CliError('usage : grasp config set <clé> <valeur>');
        const key = a.pos[1]!;
        const v = setConfigKey(paths.configFile, key, a.pos[2]!);
        out('OK');
        hint(`${key} = ${JSON.stringify(v)} écrit dans ${paths.configFile}${existsSync(paths.pidFile) ? ' — redémarrez le serveur pour l\'appliquer' : ''}`);
        return 0;
      }
      if (sub === 'unset') {
        if (a.pos.length < 2) throw new CliError('usage : grasp config unset <clé>');
        unsetConfigKey(paths.configFile, a.pos[1]!);
        out('OK');
        return 0;
      }
      if (sub === 'keys') { out(PUBLIC_KEYS.map((k) => `${k}\t${keyHelp(k)}`).join('\n')); return 0; }
      throw new CliError('usage : grasp config path | get [clé] | set <clé> <valeur> | unset <clé> | keys');
    }
    case 'doctor': {
      const checks = await runDoctor(paths, env, home);
      if (json) out(JSON.stringify(checks));
      else out(checks.map((ch) => `${ch.level === 'ok' ? 'ok  ' : ch.level === 'warn' ? 'warn' : 'FAIL'}  ${ch.name.padEnd(15)} ${ch.detail}`).join('\n'));
      return checks.some((ch) => ch.level === 'fail') ? 1 : 0;
    }
    case 'daemon': {
      const sub = a.pos[0];
      if (sub === 'install') {
        const unit = installDaemon(paths, env, process.execPath, fileURLToPath(import.meta.url));
        out('OK');
        hint(`unité écrite : ${unit} — journal : journalctl --user -u grasp -f`);
        return 0;
      }
      if (sub === 'uninstall') { uninstallDaemon(paths, env); out('OK'); return 0; }
      if (sub === 'status') { const s = systemdStatus(env); out(s.ok ? 'systemd --user disponible' : `indisponible : ${s.reason}`); return s.ok ? 0 : 1; }
      throw new CliError('usage : grasp daemon install | uninstall | status');
    }
    case 'help': case '--help': case '-h':
      out(HELP);
      return 0;
    default:
      throw new CliError(`commande inconnue « ${a.cmd} » — grasp help`);
  }
}

const HELP = `grasp — contrôle de navigateur pour agents IA (arbre d'accessibilité, CDP direct)

Serveur      serve [--tcp [--port N] [--listen IP]] | stop | status | doctor | daemon install|uninstall|status
MCP          mcp [--session <id>] [--profile <nom>] [--no-serve]   serveur MCP sur stdio (claude mcp add grasp -- grasp mcp)
               outils nav snap text click fill type select check press hover wait console screenshot run profile ;
               session créée au premier appel et fermée à la sortie (sauf --session) ; serveur démarré si absent
Sessions     session create [--profile <nom>] [--proxy URL] [--http-auth u:mdp@hôte | -] | session list | session close [id]
               --proxy : proxy de cette session (socks5://127.0.0.1:1080 d'un ssh -D), surcharge proxyServer
               --http-auth : identifiants HTTP basic confiés à cet hôte seulement (allowlist exigée), jamais écrits ;
               « - » les lit sur stdin, un par ligne (hors de ps et de l'historique)
Profils      profiles [--json]                       liste (* = profil de la session courante)
             profiles create <nom> [--use-when "…"]  profil vide (un --user-data-dir possédé par Grasp)
             profiles import <nom> <répertoire de données Chrome> [--profile-directory "Profile 9"] [--skip-locked]
             profiles rm <nom>                       refusé si une session l'utilise
             profile <nom>                           bascule la session courante (Chrome relancé, même id)
Lecture      snap [--max octets] [--scope <ref|css|frame=…>] [--name-max N]   budget 12000 octets par défaut (config snapMax)
               --name-max N : noms coupés à N caractères (défaut 80, textes 100), coupure toujours marquée « … » ;
               0 = noms entiers (titres longs) ; les refs n'en dépendent pas ; aussi sur une ligne de run
             text [--max N] [--scope <ref|css|frame=…>] [--markdown]   4000 caractères par défaut (config textMax)
               --markdown : contenu visible en Markdown (titres, listes, liens absolus, images, tableaux, code),
               même budget, même zone, même ligne de troncature ; aussi sur une ligne de run
               --scope <iframe> : texte du cadre s'il est de même origine, sinon erreur explicite ; zone vide :
               rien sur stdout, « note: aucun texte visible » sur stderr
               --scope 'frame=#editeur [>> sél]' : DANS une iframe, même d'une autre origine (moteur Playwright) ;
               snap y donne l'arbre ARIA de Playwright, sans refs
               sortie coupée : dernière ligne « … tronqué : N caractères restants — affinez avec --max N / --scope <ref|css> »
               snap : dernière ligne « … élagué : … » si des nœuds sont masqués (liens sans nom, iframes non parcourues)
               champ invalide : « [invalide: message] » (aria-invalid, aria-errormessage/describedby, validité native,
               message d'erreur visible sous le champ même aria-hidden) ; message hors arbre sans champ : « alerte "…" »
             pdf [-o f.pdf]
Attente      wait [--text T | --sel S | --idle] [--timeout ms]   texte visible, élément visible (CSS) ou présent
               (ref, text:), page stable : DOM ET réseau calmes (défaut) ; délai : 10000 ms (--idle : stableTimeoutMs) ; dépassé → erreur
               nav et --snap-diff attendent déjà le load puis 400 ms sans mutation du DOM ni activité réseau, en suivant
               une redirection JS (challenge anti-bot) ; une action qui navigue ou lance des requêtes aussi (plafond stableTimeoutMs, 5000)
               réseau : requêtes du document principal seulement ; > 1,2 s en vol (2,5 s si lancée par l'action) =
               long-polling, ignorée ; polling régulier ignoré ; allowConsole=false : AUCUNE attente réseau (Network
               n'est pas activé), seulement le DOM et les navigations
               traqueurs (blockTrackers, défaut true) : requêtes annulées avant de partir, jamais attendues ;
               « traqueurs bloqués : N requête(s) » sur stderr, détail dans console (source grasp)
Recette      expect text <texte> | no-text <texte> [--regex] [--scope <sél>]     texte visible (contient)
             expect url [~] <url> | title [~] <titre> [--regex]       égalité ; ~ = contient (citez-le : '~')
             expect sel <sél> | no-sel <sél>                          élément visible (CSS) ou présent (ref, text:)
             expect value <sél> [~] <valeur> [--regex]                valeur du champ
             expect no-console-errors [--ignore <regex>] [--since <seq>]   depuis le début du document courant
             expect no-form-errors                                    champs invalides, alertes
               relu jusqu'à --timeout (5000 ms ; 0 = une lecture ; console et formulaire : immédiat) ;
               échec → ERROR: expect: attendu … ; constaté : … (extrait borné), code 1 ; --shot-on-error : capture
Captures     screenshot [-o f|-] [--full] [--el <sél>] [--format png|jpeg|webp] [--quality N] [--max-width N] [--refs]
               sans -o : fichier 0600 dans l'état de Grasp, CHEMIN sur stdout (--json : path, width, height, bytes, format)
               -o f : toujours 0600 (fichier existant remplacé, lien symbolique jamais suivi) ; au-delà de 16384 px : tronquée, signalée
               --full page entière · --el découpe sur un élément · --max-width réduit l'échelle · --refs dessine les refs
Console      console [--level error|warn|info|debug] [--since <seq>] [--limit N (50)] [--clear] [--json]
               « #seq niveau source texte (fichier:ligne) ×N » ; seq courant sur stderr pour le --since suivant
               --since > seq courant (tampon recréé) → erreur : reprenez avec --since 0 ; valeurs non entières → erreur
Actions      nav <url> | click <sél> | fill <sél> <valeur> | select <sél> <valeur>
             check <sél> [--uncheck] | press <touche> [sél] | hover <sél> | type <sél> <texte> [--delay ms]
               type : touche par touche, AJOUTÉ au curseur (autocomplétions) ; --delay 0 à 1000 ms entre deux touches
             livraison vérifiée : click, check, press et fill au clavier attendent que la page reçoive l'entrée
               (événement de confiance, délai inputDeliveryMs = 300) ; sinon onglet au premier plan + focus émulé
               et 2e essai, puis repli synthétique ANNONCÉ (« note: clic synthétique : l'entrée native n'a pas
               atteint la page ») ; sans effet observable → ERROR (jamais de faux OK)
             --snap-diff  diff du snapshot en un aller-retour, après stabilité (DOM, réseau) ; 4000 caractères par défaut ;
                          route SPA : « ~ url … » puis le diff ; nouveau document : « navigation → url (nouvelle page :
                          snapshot complet) »
                          (config diffMax ; --max N l'élargit, --scope <ref|css> le restreint à une zone)
                          erreurs de formulaire : « ~ champ … [invalide: …] », « + alerte "…" » ; clic sans effet sur un
                          formulaire invalide : « (aucun changement — formulaire invalide : <champs>) »
             notes        fill : « champ invalide après la saisie : … », valeur > maxlength ; click sur un bouton dont
                          le formulaire a des champs invalides : « formulaire invalide : … »
             --console    entrées console produites pendant l'action (combinable avec --snap-diff) ; 200 au plus,
                          lignes écartées signalées sur stderr avec la commande pour les relire
             --shot-on-error  en cas d'échec, capture et chemin ajouté au message d'erreur
             --engine playwright  (click fill select check press hover type upload) action par Playwright branché sur
                          le Chrome de Grasp : attente d'actionnabilité (visible, stable, activé), widgets riches ;
                          optionnel : npm i playwright-core ; absent → ERROR qui le dit. Le garde de navigation et la
                          politique (upload) s'appliquent pareil ; clics, survols, frappes et touches vérifiés par
                          la sonde : rien reçu → ERROR, jamais rejoué (le clic a pu partir dans une iframe) ;
                          onglet en arrière-plan → ramené au premier plan (note)
             config fallbackEngine playwright : un clic natif non livré ou non actionnable (invisible, désactivé)
                          est rejoué via Playwright, annoncé (« note: rejoué via Playwright : … ») ; défaut none
Scripts      run [fichier|-] [--continue] [--report|--no-report] [--json]   plusieurs commandes en UN aller-retour
               une commande par ligne, même syntaxe que la CLI (nav snap text click fill select check press
               hover type wait expect eval console screenshot cookies upload profile), commentaires #, guillemets à la shell ;
               rapport de recette (--report, d'office si le script contient expect) : étapes OK/KO et durées,
               erreurs console et requêtes 4xx/5xx du run, erreurs de formulaire, capture à chaque échec (chemin) ;
               analysé en entier avant d'exécuter ; option inconnue ou globale sur une ligne (--session, --json…)
               → ERROR, jamais ignorée ; arrêt au premier échec (--continue pour poursuivre) ; client coupé
               (Ctrl-C, délai de l'agent) → aucune étape de plus ne démarre (journal du serveur) ;
               stdout « [n] commande → OK|ERROR: raison » + sortie utile (snap, text, diff, console, chemin)
Sensibles    eval <expr> | cookies | upload <sél> <fichier>…   (désactivés par défaut)
               eval : valeur en JSON, « undefined » si l'expression ne renvoie rien (--json : value et type)
             console : lecture autorisée par défaut, jamais de corps ni d'en-têtes (config set allowConsole false)
             state export [fichier|-] [--origin http://hôte:port,…]   cookies + localStorage par origine + sessionStorage
               de l'onglet, JSON versionné (grasp-state v1, lu aussi : storageState Playwright) ; fichier 0600 écrit
               atomiquement ; sans fichier : dans l'état de Grasp, CHEMIN sur stdout ; exige allowCookies ;
               rien hors allowlist
             state import <fichier|->   avant ou après navigation ; localStorage fusionné par origine
Sécurité     security            politique telle que le garde l'applique (proxy, résolution, certificats compris)
Config       config path | get [clé] | set <clé> <valeur> | unset <clé> | keys

Sélecteurs   ref e5k2 (issue de snap) · CSS #id · texte text:Valider
             frame=<css de l'iframe> >> <css|text:…>   élément DANS une iframe (même d'une autre origine : TinyMCE,
               CAPTCHA) ; imbriqué : frame=#a >> frame=#b >> … ; implique le moteur Playwright ; pas de ref dans un cadre
               ref disparue : retrouvée seulement si c'est le même élément (même nœud DOM, rang décalé) ; élément
               retiré ou remplacé → 409 avec les homonymes (jamais de clic sur l'un d'eux), sinon 404 avec les
               3 candidats les plus proches ; ref d'une page précédente → 404 ; text: introuvable : noms proches
Session      --session <id> ou GRASP_SESSION ; facultatif s'il n'y a qu'une session
             sessions parallèles : une session = un bridge = un Chrome ; maxSessions (défaut : pas de plafond) → 503
             recyclage : config browserMaxRssMb / browserMaxAgeMin (désactivés par défaut) ; navigateur relancé
               entre deux commandes, même session et profil, page rechargée (« note: navigateur recyclé : … »)
Serveur TCP  --listen IP : adresse d'écoute hors 127.0.0.1 (conteneur), opt-in, token exigé, signalé par security ;
             GRASP_URL=http://hôte:port : client vers ce serveur (au lieu de endpoint.json)
Sortie       OK sur stdout, conseils et erreurs (ERROR: <cmd>: <raison>) sur stderr ; --json`;

const argv = process.argv.slice(2);
const cmdName = argv.find((x) => !x.startsWith('-')) ?? 'help';
main(argv).then((code) => { process.exitCode = code; if (cmdName !== 'serve' && cmdName !== 'mcp') return; process.exit(code); }, (e: Error) => {
  process.stderr.write(`ERROR: ${cmdName}: ${e.message}\n`);
  // --console sur une action en échec : les entrées produites pendant l'action suivent l'erreur.
  const entries = e instanceof CliError ? e.extra?.console : undefined;
  if (Array.isArray(entries) && entries.length > 0) process.stderr.write(`${(entries as ConsoleEntry[]).map(formatEntry).join('\n')}\n`);
  if (e instanceof CliError && e.extra !== undefined) consoleLosses({ since: e.extra.consoleSince, omitted: e.extra.consoleOmitted, dropped: e.extra.consoleDropped });
  process.exit(1);
});
