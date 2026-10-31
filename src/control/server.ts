import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync, openSync, closeSync, writeSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { AddressInfo } from 'node:net';
import { type GraspPaths } from '../core/paths.js';
import { checkPermissions, ensurePrivateDir } from '../core/perms.js';
import { loadConfigFile, resolveConfig, type ResolvedConfig } from '../core/config.js';
import { effectivePolicy, type EffectivePolicy } from '../core/policy.js';
import { GraspError } from '../core/errors.js';
import { readBody, request, sendError, sendJson, type Endpoint, optStr, readJson } from '../core/http.js';
import { discoverChrome, profileDirFor, realProbe, type DiscoveredBrowser } from '../browser/discover.js';
import { assertSupportedVersion, chromeVersion } from '../browser/launch.js';
import { spawnBridge, type BridgeHandle } from './bridges.js';
import { isGraspServer, isProcessAlive } from './procutil.js';

export interface Session { id: string; profile: string | null; userDataDir: string; ephemeral: boolean; createdAt: string; bridge: BridgeHandle }

export interface ControlPlaneOptions {
  paths: GraspPaths;
  env: NodeJS.ProcessEnv;
  home: string;
  transport?: 'unix' | 'tcp' | undefined;
  port?: number | undefined;
  log?: (m: string) => void;
}

export interface ControlPlane { endpoint: Endpoint; close(): Promise<void> }

const SESSION_ROUTES = new Set(['/navigate', '/snap', '/text', '/click', '/fill', '/select', '/check', '/press', '/screenshot', '/pdf', '/eval', '/cookies', '/upload', '/location']);
const sha = (s: string) => createHash('sha256').update(s).digest();

/** Lecture unique de la config : c'est ce chemin que lisent le garde, le rapport et `doctor`. */
export function loadEffective(paths: GraspPaths): { config: ResolvedConfig; policy: Readonly<EffectivePolicy> } {
  const config = resolveConfig(loadConfigFile(paths.configFile));
  return { config, policy: effectivePolicy(config) };
}

export function permissionTargets(paths: GraspPaths): Array<{ path: string; kind: 'file' | 'dir' }> {
  return [
    { path: paths.configDir, kind: 'dir' },
    { path: paths.configFile, kind: 'file' },
    { path: paths.tokenFile, kind: 'file' },
    { path: paths.stateDir, kind: 'dir' },
    { path: paths.dataDir, kind: 'dir' },
    { path: paths.profilesDir, kind: 'dir' },
    { path: paths.tmpProfilesDir, kind: 'dir' },
    { path: paths.runDir, kind: 'dir' },
  ];
}

function readOrCreateToken(file: string): string {
  if (existsSync(file)) {
    const t = readFileSync(file, 'utf8').trim();
    if (t.length < 32) throw new Error(`${file} : token trop court, supprimez le fichier pour en générer un nouveau`);
    return t;
  }
  const t = randomBytes(32).toString('hex');
  const fd = openSync(file, 'wx', 0o600);
  try { writeSync(fd, `${t}\n`); } finally { closeSync(fd); }
  return t;
}

function writePrivate(file: string, content: string): void {
  writeFileSync(file, content, { mode: 0o600 });
  chmodSync(file, 0o600);
}

function socketInUse(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect(path);
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}

export async function startControlPlane(o: ControlPlaneOptions): Promise<ControlPlane> {
  const { paths } = o;
  const log = o.log ?? ((m: string) => process.stderr.write(`${new Date().toISOString()} grasp: ${m}\n`));

  // 1. Permissions AVANT toute création : on refuse, on ne corrige pas en silence.
  checkPermissions(permissionTargets(paths));
  for (const d of [paths.configDir, paths.stateDir, paths.logDir, paths.dataDir, paths.profilesDir, paths.tmpProfilesDir, paths.runDir, paths.bridgesDir]) ensurePrivateDir(d);

  // 2. Instance unique.
  if (existsSync(paths.pidFile)) {
    const pid = Number(readFileSync(paths.pidFile, 'utf8').trim());
    if (pid && pid !== process.pid && isProcessAlive(pid) && isGraspServer(pid)) throw new Error(`grasp tourne déjà (pid ${pid}) — \`grasp stop\` d'abord`);
  }

  // 3. Config et politique : un seul objet, gelé, partagé par le garde et le rapport.
  const { config, policy } = loadEffective(paths);
  const token = readOrCreateToken(paths.tokenFile);
  const tokenHash = sha(token);

  // 4. Navigateur : découverte et version vérifiées au démarrage, pas à la première requête.
  //    Mode attach (cdpUrl) : rien à lancer, la version est vérifiée à la connexion.
  let browser: DiscoveredBrowser | undefined;
  let version: number | string = 'attach';
  if (config.cdpUrl !== null) {
    log(`mode attach : sessions ouvertes dans le navigateur existant ${config.cdpUrl} (jamais lancé ni tué par Grasp)`);
  } else {
    browser = discoverChrome(o.env, realProbe, o.home, config.chromePath === null ? undefined : config.chromePath);
    version = assertSupportedVersion(await chromeVersion(browser.path));
    log(`navigateur : ${browser.path} (${browser.kind}, Chrome ${version})`);
  }
  if (process.getuid?.() === 0 && o.env.GRASP_ALLOW_NO_SANDBOX !== '1') {
    throw new Error("Grasp tourne en root : le sandbox Chrome ne peut pas fonctionner. Utilisez un utilisateur non-root ou --cap-add=SYS_ADMIN ; sinon GRASP_ALLOW_NO_SANDBOX=1 en connaissance de cause.");
  }
  if (process.getuid?.() === 0) log('AVERTISSEMENT : GRASP_ALLOW_NO_SANDBOX=1 — Chrome sans sandbox.');

  const sessions = new Map<string, Session>();
  const persistInstances = () => writePrivate(paths.instancesFile, JSON.stringify([...sessions.values()].map((s) => ({ id: s.id, bridgePid: s.bridge.pid, chromePgid: s.bridge.chromePgid })), null, 2));

  async function createSession(profile: string | undefined): Promise<Session> {
    if (profile !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(profile)) throw new GraspError(400, 'nom de profil invalide ([A-Za-z0-9_-], 64 max)');
    if (profile !== undefined && [...sessions.values()].some((s) => s.profile === profile)) throw new GraspError(409, `le profil « ${profile} » est déjà utilisé par une session`);
    const id = `s${randomBytes(6).toString('hex')}`;
    const ephemeral = profile === undefined;
    if (config.cdpUrl !== null && profile !== undefined) throw new GraspError(400, 'mode attach : le profil est celui du navigateur existant, --profile est sans effet');
    const userDataDir = ephemeral || browser === undefined ? join(paths.tmpProfilesDir, id) : profileDirFor(browser, profile, paths.profilesDir, o.home);
    const bridge = await spawnBridge({
      id, userDataDir, policy, headless: config.headless,
      ...(browser !== undefined ? { browser } : {}),
      ...(config.cdpUrl !== null ? { attach: config.cdpUrl } : {}),
      socketPath: join(paths.bridgesDir, `${id}.sock`),
      downloadDir: join(paths.dataDir, 'downloads', id),
      stderrLog: join(paths.logDir, `chrome-${id}.log`),
    }, {
      onExit: (code) => {
        if (!sessions.has(id)) return;
        log(`session ${id} : bridge arrêté (code ${code}) — groupe Chrome ${bridge.chromePgid} tué`);
        sessions.delete(id);
        persistInstances();
        if (ephemeral) rmSync(userDataDir, { recursive: true, force: true });
      },
    }).catch((e: Error) => { throw new GraspError(502, `démarrage du navigateur impossible : ${e.message}`); });
    for (const w of bridge.warnings) log(w);
    const s: Session = { id, profile: profile ?? null, userDataDir, ephemeral, createdAt: new Date().toISOString(), bridge };
    sessions.set(id, s);
    persistInstances();
    log(`session ${id} créée (bridge ${bridge.pid}, Chrome ${bridge.chromePid})`);
    return s;
  }

  async function closeSession(s: Session): Promise<void> {
    sessions.delete(s.id);
    persistInstances();
    const code = await s.bridge.stop();
    if (code === null) log(`ERREUR : session ${s.id} : le bridge n'a pas répondu à SIGTERM, tué par SIGKILL avec son groupe Chrome`);
    if (s.ephemeral) rmSync(s.userDataDir, { recursive: true, force: true });
  }

  function pickSession(req: IncomingMessage, url: URL): Session {
    const wanted = (req.headers['x-grasp-session'] as string | undefined) ?? url.searchParams.get('session') ?? undefined;
    if (wanted) {
      const s = sessions.get(wanted);
      if (!s) throw new GraspError(404, `session ${wanted} inconnue — \`grasp session list\``);
      return s;
    }
    if (sessions.size === 1) return [...sessions.values()][0]!;
    if (sessions.size === 0) throw new GraspError(409, 'aucune session — `grasp session create`');
    throw new GraspError(400, `${sessions.size} sessions ouvertes : précisez --session (ou GRASP_SESSION)`);
  }

  async function securityReport(): Promise<Record<string, unknown>> {
    const bridges: Record<string, unknown> = {};
    for (const s of sessions.values()) {
      const r = await request({ transport: 'unix', socketPath: s.bridge.socketPath }, 'GET', '/policy').catch(() => null);
      bridges[s.id] = r && r.status === 200 ? r.json() : { error: 'bridge injoignable' };
    }
    let disk: unknown;
    try { disk = loadEffective(paths).policy; } catch (e) { disk = { error: (e as Error).message }; }
    return {
      // L'objet exact transmis aux bridges et consulté par le garde.
      policy,
      bridges,
      transport: endpoint.transport,
      configFile: paths.configFile,
      configFileExists: existsSync(paths.configFile),
      diskDiffers: !isDeepStrictEqual(JSON.parse(JSON.stringify(disk)), JSON.parse(JSON.stringify(policy))),
    };
  }

  async function proxy(s: Session, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const body = req.method === 'POST' ? await readBody(req) : undefined;
    const qs = new URLSearchParams(url.searchParams);
    qs.delete('session');
    const path = `${url.pathname}${qs.size ? `?${qs}` : ''}`;
    let r;
    try {
      r = await request({ transport: 'unix', socketPath: s.bridge.socketPath }, req.method ?? 'GET', path, body && body.length ? JSON.parse(body.toString('utf8')) : undefined);
    } catch (e) { throw new GraspError(502, `bridge de la session ${s.id} injoignable : ${(e as Error).message}`); }
    res.writeHead(r.status, { 'content-type': String(r.headers['content-type'] ?? 'application/octet-stream'), 'content-length': r.body.length });
    res.end(r.body);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://grasp');
      if (url.pathname === '/health' && req.method === 'GET') return sendJson(res, 200, { ok: true, pid: process.pid, sessions: sessions.size, chrome: version });
      const auth = req.headers.authorization ?? '';
      const given = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
      if (!given || !timingSafeEqual(sha(given), tokenHash)) throw new GraspError(401, 'token manquant ou invalide (Authorization: Bearer <token>)');

      const route = `${req.method} ${url.pathname}`;
      if (route === 'GET /security/effective') return sendJson(res, 200, await securityReport());
      if (route === 'GET /sessions') {
        return sendJson(res, 200, [...sessions.values()].map((s) => ({ id: s.id, profile: s.profile, createdAt: s.createdAt, bridgePid: s.bridge.pid, chromePid: s.bridge.chromePid })));
      }
      if (route === 'POST /sessions') {
        const body = await readJson(req);
        const s = await createSession(optStr(body, 'profile'));
        return sendJson(res, 201, { id: s.id, profile: s.profile });
      }
      const m = /^\/sessions\/([^/]+)$/.exec(url.pathname);
      if (m && req.method === 'DELETE') {
        const s = sessions.get(m[1]!);
        if (!s) throw new GraspError(404, `session ${m[1]} inconnue`);
        await closeSession(s);
        return sendJson(res, 200, { ok: true });
      }
      if (SESSION_ROUTES.has(url.pathname)) return await proxy(pickSession(req, url), req, res, url);
      throw new GraspError(404, `route inconnue : ${route}`);
    } catch (e) { sendError(res, e); }
  }

  // 5. Écoute. Socket Unix 0600 par défaut ; TCP seulement sur 127.0.0.1.
  const server: Server = createServer((req, res) => { void handle(req, res); });
  const transport = o.transport ?? config.transport;
  let endpoint: Endpoint;
  rmSync(paths.endpointFile, { force: true });
  if (transport === 'unix') {
    if (existsSync(paths.socketPath)) {
      if (await socketInUse(paths.socketPath)) throw new Error(`le socket ${paths.socketPath} est déjà utilisé par un autre serveur`);
      rmSync(paths.socketPath);
    }
    const prev = process.umask(0o077);
    try { await new Promise<void>((r, j) => { server.once('error', j); server.listen(paths.socketPath, r); }); } finally { process.umask(prev); }
    chmodSync(paths.socketPath, 0o600);
    endpoint = { transport: 'unix', socketPath: paths.socketPath };
  } else {
    const port = o.port ?? config.port;
    await new Promise<void>((r, j) => { server.once('error', j); server.listen(port, '127.0.0.1', r); });
    endpoint = { transport: 'tcp', host: '127.0.0.1', port: (server.address() as AddressInfo).port };
  }
  writePrivate(paths.pidFile, `${process.pid}\n`);
  persistInstances();
  writePrivate(paths.endpointFile, JSON.stringify(endpoint));
  log(`à l'écoute sur ${endpoint.transport === 'unix' ? endpoint.socketPath : `${endpoint.host}:${endpoint.port}`} (pid ${process.pid})`);

  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= (async () => {
      server.close();
      server.closeAllConnections();
      await Promise.all([...sessions.values()].map((s) => closeSession(s)));
      if (endpoint.transport === 'unix') rmSync(endpoint.socketPath, { force: true });
      for (const f of [paths.pidFile, paths.endpointFile, paths.instancesFile]) rmSync(f, { force: true });
      log('arrêté');
    })();
    return closing;
  };
  return { endpoint, close };
}
