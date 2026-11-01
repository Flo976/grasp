#!/usr/bin/env node
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePaths, type GraspPaths } from '../core/paths.js';
import { request, type Endpoint, type HttpResult } from '../core/http.js';
import { loadConfigFile, resolveConfig, setConfigKey, unsetConfigKey, isConfigKey, PUBLIC_KEYS, keyHelp } from '../core/config.js';
import { startControlPlane } from '../control/server.js';
import { isGraspServer, isProcessAlive } from '../control/procutil.js';
import { installDaemon, uninstallDaemon, systemdStatus } from './daemon.js';
import { runDoctor } from './doctor.js';
import { killWindowsChrome } from '../browser/windows.js';
import { formatEntry, type ConsoleEntry, type ConsoleResult } from '../core/console.js';

/**
 * CLI : client mince du control plane. Aucune logique métier ici.
 * stdout = résultat (OK, snapshot, id…) ; stderr = conseils, avertissements, erreurs.
 */

class CliError extends Error {
  /** Champs supplémentaires du corps d'erreur (ex. entrées console produites pendant l'action). */
  constructor(message: string, readonly extra?: Record<string, unknown>) { super(message); }
}

interface Args { cmd: string; pos: string[]; flags: Map<string, string | true> }

const VALUE_FLAGS = new Set(['session', 'max', 'output', 'profile', 'port', 'use-when', 'profile-directory', 'el', 'format', 'quality', 'max-width', 'level', 'since', 'limit', 'scope', 'text', 'sel', 'timeout']);
const ALIASES: Record<string, string> = { o: 'output', s: 'session' };

function parseArgs(argv: string[]): Args {
  const pos: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    const m = /^--?([a-z][a-z-]*)(?:=(.*))?$/.exec(a);
    if (m && !(a.startsWith('-') && !a.startsWith('--') && m[1]!.length > 1)) {
      const name = ALIASES[m[1]!] ?? m[1]!;
      if (m[2] !== undefined) flags.set(name, m[2]);
      else if (VALUE_FLAGS.has(name)) {
        const v = argv[++i];
        if (v === undefined) throw new CliError(`--${name} attend une valeur`);
        flags.set(name, v);
      } else flags.set(name, true);
    } else pos.push(a);
  }
  return { cmd: pos.shift() ?? 'help', pos, flags };
}

const out = (s: string) => process.stdout.write(s.endsWith('\n') ? s : `${s}\n`);
const hint = (s: string) => process.stderr.write(`${s}\n`);

function endpointOf(paths: GraspPaths): Endpoint {
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
  const j = r.json() as { diff?: string; detail?: string; console?: { entries: ConsoleEntry[]; seq: number } };
  if (a.flags.has('json')) { out(JSON.stringify(j)); return; }
  if (j.detail) hint(`note: ${j.detail}`);
  out(j.diff !== undefined ? j.diff : 'OK');
  if (j.console !== undefined) {
    if (j.console.entries.length > 0) out(j.console.entries.map(formatEntry).join('\n'));
    hint(`console : ${j.console.entries.length === 0 ? 'aucune nouvelle entrée, ' : ''}seq courant ${j.console.seq}`);
  }
}

const SHOT_FORMATS: Record<string, string> = { '.png': 'png', '.jpg': 'jpeg', '.jpeg': 'jpeg', '.webp': 'webp' };

/** Options de capture → paramètres de GET /screenshot. Format déduit de l'extension de -o à défaut de --format. */
function shotQuery(a: Args, file: string | undefined): URLSearchParams {
  const q = new URLSearchParams();
  if (a.flags.has('full')) q.set('full', '1');
  if (a.flags.has('refs')) q.set('refs', '1');
  for (const [flag, key] of [['el', 'el'], ['quality', 'quality'], ['max-width', 'maxWidth'], ['format', 'format']] as const) {
    const v = a.flags.get(flag);
    if (v === true) throw new CliError(`--${flag} attend une valeur`);
    if (v !== undefined) q.set(key, v);
  }
  if (!q.has('format') && file !== undefined && file !== '-') {
    const ext = /\.[A-Za-z]+$/.exec(file)?.[0]?.toLowerCase();
    const f = ext !== undefined ? SHOT_FORMATS[ext] : undefined;
    if (f !== undefined) q.set('format', f);
  }
  return q;
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
    if (j.truncated === true) hint('AVERTISSEMENT : page tronquée en hauteur (limite de 16384 px de Chrome)');
    return;
  }
  const r = await c.call('GET', `/screenshot?${q}`);
  if (file === '-') {
    if (process.stdout.isTTY) throw new CliError('sortie binaire : redirigez stdout (ou omettez -o pour obtenir un chemin)');
    process.stdout.write(r.body);
    return;
  }
  writeFileSync(file, r.body, { mode: 0o600 });
  const truncated = r.headers['x-grasp-truncated'] === '1';
  out(json ? JSON.stringify({ path: resolvePath(file), width: Number(r.headers['x-grasp-width']), height: Number(r.headers['x-grasp-height']), bytes: r.body.length, format: String(r.headers['x-grasp-format']), ...(truncated ? { truncated: true } : {}) }) : 'OK');
  if (truncated) hint('AVERTISSEMENT : page tronquée en hauteur (limite de 16384 px de Chrome)');
}

async function consoleCmd(c: Client, a: Args): Promise<void> {
  const body: Record<string, unknown> = {};
  for (const k of ['level', 'since', 'limit'] as const) {
    const v = a.flags.get(k);
    if (v === true) throw new CliError(`--${k} attend une valeur`);
    if (v !== undefined) body[k] = k === 'level' ? v : Number(v);
  }
  // Par défaut, les 50 dernières lignes : la console d'une page bavarde coûte cher en tokens.
  if (body.limit === undefined) body.limit = 50;
  if (a.flags.has('clear')) body.clear = true;
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

/** --max et --scope de snap / text → paramètres de requête. */
function readQuery(a: Args): string {
  const q = new URLSearchParams();
  for (const k of ['max', 'scope'] as const) {
    const v = a.flags.get(k);
    if (v === true) throw new CliError(`--${k} attend une valeur`);
    if (v !== undefined) q.set(k, v);
  }
  return q.size > 0 ? `?${q}` : '';
}

/** grasp wait [--text T | --sel S | --idle] [--timeout ms] : OK sur stdout, durée sur stderr. */
async function waitCmd(c: Client, a: Args): Promise<void> {
  const body: Record<string, unknown> = {};
  for (const k of ['text', 'sel', 'timeout'] as const) {
    const v = a.flags.get(k);
    if (v === true) throw new CliError(`--${k} attend une valeur`);
    // timeout transmis tel quel : le bridge le valide (une valeur invalide est une erreur, jamais ignorée).
    if (v !== undefined) body[k] = v;
  }
  if (a.flags.has('idle')) body.idle = true;
  const t = Number(body.timeout);
  const timeout = Number.isFinite(t) && t > 0 ? t : 60_000;
  const j = (await c.call('POST', '/wait', body, timeout + 15_000)).json() as { waited: number; condition: string };
  if (a.flags.has('json')) { out(JSON.stringify(j)); return; }
  out('OK');
  hint(`attendu ${j.waited} ms (${j.condition})`);
}

async function binary(c: Client, a: Args, path: string, ext: string): Promise<void> {
  const r = await c.call('GET', path);
  const file = a.flags.get('output');
  if (typeof file === 'string') { writeFileSync(file, r.body); out(a.flags.has('json') ? JSON.stringify({ ok: true, file, bytes: r.body.length }) : 'OK'); return; }
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

function renderSecurity(rep: any): string {
  const p = rep.policy;
  const onoff = (b: boolean) => (b ? 'AUTORISÉ' : 'désactivé');
  const lines = [
    `navigation : ${p.navigation} (garde runtime dans le navigateur)`,
    `allowlist  : ${p.allowedDomains.length === 0 ? '(vide) — tout est bloqué' : p.allowedDomains.join(', ')}`,
    `eval       : ${onoff(p.allowEval)}`,
    `download   : ${onoff(p.allowDownload)}`,
    `upload     : ${onoff(p.allowUpload)}`,
    `cookies    : ${onoff(p.allowCookies)}`,
    `console    : ${p.allowConsole ? 'AUTORISÉ (lecture seule ; Runtime.enable actif)' : 'désactivé'}`,
    `token      : ${p.tokenRequired ? 'exigé' : 'NON exigé'}`,
    `transport  : ${rep.transport}`,
    `sessions   : ${Object.keys(rep.bridges).length}`,
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
  const snapDiff = a.flags.has('snap-diff');
  // Transmis tel quel : le bridge valide (« --max abc » est une erreur 400, pas une limite ignorée).
  const max = typeof a.flags.get('max') === 'string' ? a.flags.get('max') as string : undefined;
  const scope = a.flags.get('scope');
  const actionBody = (extra: Record<string, unknown>) => ({
    ...extra, ...(snapDiff ? { snapDiff: true } : {}), ...(max !== undefined ? { max } : {}), ...(typeof scope === 'string' ? { scope } : {}),
    ...(a.flags.has('console') ? { console: true } : {}), ...(a.flags.has('shot-on-error') ? { shotOnError: true } : {}),
  });

  switch (a.cmd) {
    case 'serve': {
      const port = a.flags.get('port');
      const cp = await startControlPlane({
        paths, env, home,
        transport: a.flags.has('tcp') ? 'tcp' : undefined,
        port: typeof port === 'string' ? Number(port) : undefined,
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
        if (prof === true) throw new CliError('usage : grasp session create [--profile <nom>]');
        const r = await c.call('POST', '/sessions', typeof prof === 'string' ? { profile: prof } : {});
        const j = r.json() as { id: string; profileCreated?: boolean };
        out(json ? r.text() : j.id);
        if (j.profileCreated === true) hint(`profil « ${prof as string} » créé (vide) : connectez-vous une fois dans ce profil (headless=false) pour que l'agent réutilise la session — \`grasp profiles\` pour la liste`);
        hint(`astuce : export GRASP_SESSION=${j.id}`); // stderr : `export S=$(grasp session create)` reste propre
        return 0;
      }
      if (sub === 'list') {
        const list = (await c.call('GET', '/sessions')).json() as Array<{ id: string; profile: string | null; createdAt: string }>;
        if (json) out(JSON.stringify(list));
        else if (list.length) out(list.map((s) => `${s.id}\t${s.profile ?? '(éphémère)'}\t${s.createdAt}`).join('\n'));
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
      throw new CliError('usage : grasp session create [--profile P] | list | close [id]');
    }
    case 'nav': {
      const [url] = need(a, 1, 'nav <url>');
      renderAction(await c.call('POST', '/navigate', actionBody({ url })), a);
      return 0;
    }
    case 'snap': out((await c.call('GET', `/snap${readQuery(a)}`)).text()); return 0;
    case 'text': out((await c.call('GET', `/text${readQuery(a)}`)).text()); return 0;
    case 'wait': await waitCmd(c, a); return 0;
    case 'click': { const [target] = need(a, 1, 'click <sélecteur>'); renderAction(await c.call('POST', '/click', actionBody({ target })), a); return 0; }
    case 'fill': { const [target, value] = need(a, 2, 'fill <sélecteur> <valeur>'); renderAction(await c.call('POST', '/fill', actionBody({ target, value })), a); return 0; }
    case 'select': { const [target, value] = need(a, 2, 'select <sélecteur> <valeur|libellé>'); renderAction(await c.call('POST', '/select', actionBody({ target, value })), a); return 0; }
    case 'check': { const [target] = need(a, 1, 'check <sélecteur> [--uncheck]'); renderAction(await c.call('POST', '/check', actionBody({ target, checked: !a.flags.has('uncheck') })), a); return 0; }
    case 'press': {
      const [key, target] = need(a, 1, 'press <touche> [sélecteur]');
      renderAction(await c.call('POST', '/press', actionBody(target !== undefined ? { key, target } : { key })), a);
      return 0;
    }
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
    case 'eval': { const [expression] = need(a, 1, 'eval <expression>'); out(JSON.stringify((await c.call('POST', '/eval', { expression })).json().value)); return 0; }
    case 'cookies': out((await c.call('GET', '/cookies')).text()); return 0;
    case 'upload': { const [target, ...files] = need(a, 2, 'upload <sélecteur> <fichier>…'); renderAction(await c.call('POST', '/upload', { target, files }), a); return 0; }
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

Serveur      serve [--tcp [--port N]] | stop | status | doctor | daemon install|uninstall|status
Sessions     session create [--profile <nom>] | session list | session close [id]
Profils      profiles [--json]                       liste (* = profil de la session courante)
             profiles create <nom> [--use-when "…"]  profil vide (un --user-data-dir possédé par Grasp)
             profiles import <nom> <répertoire de données Chrome> [--profile-directory "Profile 9"] [--skip-locked]
             profiles rm <nom>                       refusé si une session l'utilise
             profile <nom>                           bascule la session courante (Chrome relancé, même id)
Lecture      snap [--max octets] [--scope <ref|css>]   budget 12000 octets par défaut (config snapMax)
             text [--max N] [--scope <ref|css>]        4000 caractères par défaut (config textMax)
               sortie coupée : dernière ligne « … tronqué : N caractères restants — affinez avec --max N / --scope <ref|css> »
               snap : dernière ligne « … élagué : … » si des nœuds sont masqués (liens sans nom, iframes non parcourues)
             pdf [-o f.pdf]
Attente      wait [--text T | --sel S | --idle] [--timeout ms]   texte visible, élément visible (CSS) ou présent
               (ref, text:), DOM stable (défaut) ; délai : 10000 ms (--idle : stableTimeoutMs) ; dépassé → erreur
               nav et --snap-diff attendent déjà le load puis 400 ms sans mutation du DOM (plafond stableTimeoutMs, 5000)
Captures     screenshot [-o f|-] [--full] [--el <sél>] [--format png|jpeg|webp] [--quality N] [--max-width N] [--refs]
               sans -o : fichier 0600 dans l'état de Grasp, CHEMIN sur stdout (--json : path, width, height, bytes, format)
               --full page entière · --el découpe sur un élément · --max-width réduit l'échelle · --refs dessine les refs
Console      console [--level error|warn|info|debug] [--since <seq>] [--limit N (50)] [--clear] [--json]
               « #seq niveau source texte (fichier:ligne) ×N » ; seq courant sur stderr pour le --since suivant
Actions      nav <url> | click <sél> | fill <sél> <valeur> | select <sél> <valeur>
             check <sél> [--uncheck] | press <touche> [sél]
             --snap-diff  diff du snapshot en un aller-retour, après stabilité du DOM ; 4000 caractères par défaut
                          (config diffMax ; --max N l'élargit, --scope <ref|css> le restreint à une zone)
             --console    entrées console produites pendant l'action (combinable avec --snap-diff)
             --shot-on-error  en cas d'échec, capture et chemin ajouté au message d'erreur
Sensibles    eval <expr> | cookies | upload <sél> <fichier>…   (désactivés par défaut)
             console : lecture autorisée par défaut, jamais de corps ni d'en-têtes (config set allowConsole false)
Sécurité     security            politique telle que le garde l'applique
Config       config path | get [clé] | set <clé> <valeur> | unset <clé> | keys

Sélecteurs   ref e5k2 (issue de snap) · CSS #id · texte text:Valider
               ref disparue (re-rendu) : retrouvée par (rôle, nom) si c'est sans ambiguïté, sinon erreur avec
               les 3 candidats les plus proches ; text: introuvable : noms proches proposés
Session      --session <id> ou GRASP_SESSION ; facultatif s'il n'y a qu'une session
Sortie       OK sur stdout, conseils et erreurs (ERROR: <cmd>: <raison>) sur stderr ; --json`;

const argv = process.argv.slice(2);
const cmdName = argv.find((x) => !x.startsWith('-')) ?? 'help';
main(argv).then((code) => { process.exitCode = code; if (cmdName !== 'serve') return; process.exit(code); }, (e: Error) => {
  process.stderr.write(`ERROR: ${cmdName}: ${e.message}\n`);
  // --console sur une action en échec : les entrées produites pendant l'action suivent l'erreur.
  const entries = e instanceof CliError ? e.extra?.console : undefined;
  if (Array.isArray(entries) && entries.length > 0) process.stderr.write(`${(entries as ConsoleEntry[]).map(formatEntry).join('\n')}\n`);
  process.exit(1);
});
