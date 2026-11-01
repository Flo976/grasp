import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, openSync, closeSync, writeSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { AddressInfo } from 'node:net';
import { bridgeSocketPath, checkSocketPaths, type GraspPaths } from '../core/paths.js';
import { checkPermissions, ensurePrivateDir } from '../core/perms.js';
import { loadConfigFile, resolveConfig, type ResolvedConfig } from '../core/config.js';
import { effectivePolicy, type EffectivePolicy } from '../core/policy.js';
import { GraspError } from '../core/errors.js';
import { readBody, request, sendError, sendJson, type Endpoint, optStr, optBool, readJson, str } from '../core/http.js';
import { discoverChrome, profileRootsFor, realProbe, type DiscoveredBrowser, type ProfileRoots } from '../browser/discover.js';
import { assertSupportedVersion, browserVersion } from '../browser/launch.js';
import { toWslPath, windowsLocalAppData } from '../browser/windows.js';
import { ProfileStore, validateProfileName, type ProfileInfo } from '../core/profiles.js';
import { reapWindows, spawnBridge, type BridgeHandle } from './bridges.js';
import { reapStaleInstances } from './stale.js';
import { isGraspServer, isProcessAlive } from './procutil.js';

export interface Session {
  id: string;
  profile: string | null;
  userDataDir: string;
  ephemeral: boolean;
  createdAt: string;
  bridge: BridgeHandle;
  /** Bascule de profil en cours : le bridge est relancé, les requêtes reçoivent un 409 explicite. */
  switching: boolean;
  /** Fin de la bascule en cours (une fermeture l'attend avant d'arrêter le bridge). */
  switchDone?: Promise<void> | undefined;
  /** Session fermée (retirée de la table) : une bascule en vol doit abandonner. */
  closed?: Promise<void> | undefined;
}

export interface ControlPlaneOptions {
  paths: GraspPaths;
  env: NodeJS.ProcessEnv;
  home: string;
  transport?: 'unix' | 'tcp' | undefined;
  port?: number | undefined;
  log?: (m: string) => void;
}

export interface ControlPlane { endpoint: Endpoint; close(): Promise<void> }

const SESSION_ROUTES = new Set(['/navigate', '/snap', '/text', '/click', '/fill', '/select', '/check', '/press', '/screenshot', '/pdf', '/eval', '/cookies', '/upload', '/location', '/console']);
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
    { path: paths.capturesDir, kind: 'dir' },
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

/** Dossier de téléchargement d'une session. chrome.exe : côté Windows (caché sous la racine des profils). */
export function downloadDirFor(browser: DiscoveredBrowser | undefined, roots: ProfileRoots, paths: Pick<GraspPaths, 'dataDir'>, id: string): string {
  return browser?.kind === 'windows' ? join(roots.profiles, '.downloads', id) : join(paths.dataDir, 'downloads', id);
}

/** Racines des profils ; chrome.exe : %LOCALAPPDATA%\\grasp\\profiles côté Windows, ou windowsProfilesDir. */
export async function resolveProfileRoots(browser: DiscoveredBrowser | undefined, config: ResolvedConfig, paths: GraspPaths, home: string): Promise<ProfileRoots> {
  if (browser?.kind !== 'windows') return profileRootsFor(browser, paths, home, {});
  const w = config.windowsProfilesDir;
  if (w !== null) return profileRootsFor(browser, paths, home, { windowsProfilesDir: /^[A-Za-z]:\\/.test(w) ? await toWslPath(w) : w });
  return profileRootsFor(browser, paths, home, { localAppData: await windowsLocalAppData() });
}

export async function startControlPlane(o: ControlPlaneOptions): Promise<ControlPlane> {
  const { paths } = o;
  const log = o.log ?? ((m: string) => process.stderr.write(`${new Date().toISOString()} grasp: ${m}\n`));

  // 1. Permissions AVANT toute création : on refuse, on ne corrige pas en silence.
  checkPermissions(permissionTargets(paths));
  for (const d of [paths.configDir, paths.stateDir, paths.logDir, paths.capturesDir, paths.dataDir, paths.profilesDir, paths.tmpProfilesDir, paths.runDir, paths.bridgesDir]) ensurePrivateDir(d);

  // 2. Instance unique.
  if (existsSync(paths.pidFile)) {
    const pid = Number(readFileSync(paths.pidFile, 'utf8').trim());
    if (pid && pid !== process.pid && isProcessAlive(pid) && isGraspServer(pid)) throw new Error(`grasp tourne déjà (pid ${pid}) — \`grasp stop\` d'abord`);
  }

  // 3. Config et politique : un seul objet, gelé, partagé par le garde et le rapport.
  const { config, policy } = loadEffective(paths);
  const transport = o.transport ?? config.transport;
  // Sockets Unix limités à 107 octets : refus explicite ici plutôt qu'un « listen EADDRINUSE » plus tard.
  checkSocketPaths(paths, transport);
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
    version = assertSupportedVersion(await browserVersion(browser));
    log(`navigateur : ${browser.path} (${browser.kind}, Chrome ${version})`);
  }
  const roots = await resolveProfileRoots(browser, config, paths, o.home);
  const store = new ProfileStore(roots.profiles, roots.posix);
  if (browser?.kind === 'windows') {
    for (const d of [roots.profiles, roots.tmp]) mkdirSync(d, { recursive: true });
    log(`mode windows : chrome.exe piloté depuis WSL2, profils côté Windows dans ${roots.profiles} (droits POSIX non applicables sur NTFS)`);
  }
  if (process.getuid?.() === 0 && o.env.GRASP_ALLOW_NO_SANDBOX !== '1') {
    throw new Error("Grasp tourne en root : le sandbox Chrome ne peut pas fonctionner. Utilisez un utilisateur non-root ou --cap-add=SYS_ADMIN ; sinon GRASP_ALLOW_NO_SANDBOX=1 en connaissance de cause.");
  }
  if (process.getuid?.() === 0) log('AVERTISSEMENT : GRASP_ALLOW_NO_SANDBOX=1 — Chrome sans sandbox.');

  const sessions = new Map<string, Session>();
  let closing: Promise<void> | undefined;
  const persistInstances = () => writePrivate(paths.instancesFile, JSON.stringify([...sessions.values()].map((s) => ({
    id: s.id, bridgePid: s.bridge.pid, chromePgid: s.bridge.chromePgid, userDataDir: s.userDataDir, ephemeral: s.ephemeral,
    ...(s.bridge.windowsUserDataDir !== undefined ? { windowsUserDataDir: s.bridge.windowsUserDataDir } : {}),
  })), null, 2));

  /**
   * Réservations de profils pendant les await (création, bascule, fermeture) : un profil n'est libre
   * que si aucune session ne l'affiche ET qu'aucune opération en vol ne le tient.
   */
  interface Reservation { name: string; label: string }
  const reservations: Reservation[] = [];
  function reserve(name: string, label: string): () => void {
    const r = { name, label };
    reservations.push(r);
    return () => { const i = reservations.indexOf(r); if (i >= 0) reservations.splice(i, 1); };
  }
  function holderOf(name: string): string | undefined {
    const s = [...sessions.values()].find((x) => x.profile === name);
    if (s !== undefined) return `la session ${s.id}${s.switching ? ' (bascule en cours)' : ''}`;
    return reservations.find((r) => r.name === name)?.label;
  }

  /** Lance le bridge d'une session sur son --user-data-dir courant. */
  async function startBridge(s: Omit<Session, 'bridge'>): Promise<BridgeHandle> {
    let handle: BridgeHandle | undefined;
    handle = await spawnBridge({
      id: s.id, userDataDir: s.userDataDir, policy, headless: config.headless,
      ...(browser !== undefined ? { browser } : {}),
      ...(config.cdpUrl !== null ? { attach: config.cdpUrl } : {}),
      socketPath: bridgeSocketPath(paths, s.id),
      downloadDir: downloadDirFor(browser, roots, paths, s.id),
      stderrLog: join(paths.logDir, `chrome-${s.id}.log`),
      capturesDir: paths.capturesDir,
    }, {
      log,
      onExit: (code) => {
        // Seule la mort du bridge COURANT d'une session vivante compte (pas celui qu'une bascule remplace).
        const cur = sessions.get(s.id);
        if (cur === undefined || handle === undefined || cur.bridge !== handle || cur.switching) return;
        log(`session ${s.id} : bridge arrêté (code ${code}) — groupe Chrome ${handle.chromePgid} tué`);
        sessions.delete(s.id);
        cur.closed ??= Promise.resolve();
        persistInstances();
        if (cur.ephemeral) removeDir(cur.userDataDir);
      },
    }).catch((e: Error) => { throw new GraspError(502, `démarrage du navigateur impossible : ${e.message}`); });
    for (const w of handle.warnings) log(w);
    return handle;
  }

  function removeDir(dir: string): void {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (e) { log(`AVERTISSEMENT : ${dir} non supprimé : ${(e as Error).message}`); }
  }

  /**
   * Profil nommé : choisi AVANT le lancement, créé à la volée s'il n'existe pas, et réservé
   * jusqu'à l'appel de release() (la session, une fois dans la table, le tient d'elle-même).
   */
  function profileFor(name: string, why: string, label: string): { profile: ProfileInfo; created: boolean; release: () => void } {
    if (config.cdpUrl !== null) throw new GraspError(400, `mode attach : le profil est celui du navigateur existant, ${why} est sans effet`);
    validateProfileName(name);
    const holder = holderOf(name);
    if (holder !== undefined) throw new GraspError(409, `le profil « ${name} » est déjà utilisé par ${holder}`);
    const release = reserve(name, label);
    try { return { ...store.ensure(name), release }; } catch (e) { release(); throw e; }
  }

  async function createSession(profile: string | undefined): Promise<{ session: Session; profileCreated: boolean }> {
    const id = `s${randomBytes(6).toString('hex')}`;
    const p = profile !== undefined ? profileFor(profile, '--profile', `la session ${id} (en cours de création)`) : undefined;
    try {
      const base = { id, profile: profile ?? null, userDataDir: p?.profile.path ?? join(roots.tmp, id), ephemeral: p === undefined, createdAt: new Date().toISOString(), switching: false };
      const bridge = await startBridge(base);
      if (closing !== undefined) {
        // Arrêt du serveur pendant le démarrage : la liste des sessions à fermer est déjà prise.
        await bridge.stop();
        if (base.ephemeral) removeDir(base.userDataDir);
        throw new GraspError(503, 'serveur en cours d\'arrêt');
      }
      const s: Session = { ...base, bridge };
      sessions.set(id, s);
      persistInstances();
      if (profile !== undefined) store.touch(profile);
      log(`session ${id} créée (bridge ${bridge.pid}, Chrome ${bridge.chromePid}${profile !== undefined ? `, profil ${profile}` : ''})`);
      return { session: s, profileCreated: p?.created === true };
    } finally { p?.release(); }
  }

  /**
   * Bascule de profil : arrêt du bridge et de son navigateur, relance sur le --user-data-dir du
   * nouveau profil, MÊME identifiant de session. En cas d'échec, on rouvre l'ancien profil.
   * Les deux profils restent réservés pendant toute la bascule. Si la session est fermée entre-temps
   * (DELETE, arrêt du serveur), la bascule abandonne et n'abandonne aucun navigateur derrière elle.
   */
  async function switchProfile(s: Session, name: string): Promise<{ profile: string; previous: string | null; unchanged: boolean }> {
    validateProfileName(name);
    if (config.cdpUrl !== null) throw new GraspError(400, 'mode attach : le profil est celui du navigateur existant, la bascule est sans effet');
    if (s.switching) throw new GraspError(409, `bascule de profil déjà en cours pour la session ${s.id}`);
    if (s.profile === name) return { profile: name, previous: name, unchanged: true };
    if (store.get(name) === undefined) {
      const names = store.list().map((p) => p.name);
      throw new GraspError(404, `profil « ${name} » inconnu (profils : ${names.join(', ') || 'aucun'}) — \`grasp profiles create ${name}\` d'abord`);
    }
    const label = `la session ${s.id} (bascule en cours)`;
    const { profile: target, release } = profileFor(name, 'la bascule', label);
    const prev = { profile: s.profile, userDataDir: s.userDataDir, ephemeral: s.ephemeral };
    const releasePrev = prev.profile !== null ? reserve(prev.profile, label) : () => undefined;
    const aborted = () => new GraspError(409, `session ${s.id} fermée pendant la bascule de profil vers « ${name} »`);
    /** Fermée pendant un await : on arrête ce qu'on vient de lancer et on rend l'état d'avant (fichiers éphémères compris). */
    const abandon = async (): Promise<never> => {
      const code = await s.bridge.stop();
      if (code === null) log(`ERREUR : session ${s.id} : le bridge n'a pas répondu à SIGTERM, tué par SIGKILL avec son navigateur`);
      Object.assign(s, prev);
      log(`session ${s.id} fermée pendant la bascule vers ${name} : bascule abandonnée`);
      throw aborted();
    };
    let done!: () => void;
    s.switchDone = new Promise<void>((r) => { done = r; });
    s.switching = true;
    try {
      const code = await s.bridge.stop();
      if (code === null) log(`ERREUR : session ${s.id} : le bridge n'a pas répondu à SIGTERM, tué par SIGKILL avec son navigateur`);
      if (s.closed !== undefined) { Object.assign(s, prev); throw aborted(); }
      Object.assign(s, { profile: name, userDataDir: target.path, ephemeral: false });
      try {
        s.bridge = await startBridge(s);
      } catch (e) {
        Object.assign(s, prev);
        if (s.closed !== undefined) throw aborted();
        try {
          s.bridge = await startBridge(s);
        } catch (e2) {
          if (sessions.get(s.id) === s) sessions.delete(s.id);
          s.closed ??= Promise.resolve();
          persistInstances();
          throw new GraspError(502, `bascule vers « ${name} » impossible (${(e as Error).message}) et réouverture de l'ancien profil impossible (${(e2 as Error).message}) : session ${s.id} fermée`);
        }
        if (s.closed !== undefined) await abandon();
        persistInstances();
        throw new GraspError(502, `bascule vers « ${name} » impossible : ${(e as Error).message} — session ${s.id} restée sur ${prev.profile ?? 'un profil éphémère'}`);
      }
      if (s.closed !== undefined) await abandon();
      if (prev.ephemeral) removeDir(prev.userDataDir);
      store.touch(name);
      persistInstances();
      log(`session ${s.id} : profil ${prev.profile ?? '(éphémère)'} → ${name} (bridge ${s.bridge.pid}, Chrome ${s.bridge.chromePid})`);
      return { profile: name, previous: prev.profile, unchanged: false };
    } finally {
      s.switching = false;
      release();
      releasePrev();
      done();
    }
  }

  /** Idempotent. Attend une bascule en vol (elle abandonne), puis arrête le bridge ; le profil reste réservé jusque-là. */
  function closeSession(s: Session): Promise<void> {
    if (s.closed !== undefined) return s.closed;
    if (sessions.get(s.id) === s) sessions.delete(s.id);
    const release = s.profile !== null ? reserve(s.profile, `la session ${s.id} (fermeture en cours)`) : () => undefined;
    persistInstances();
    s.closed = (async () => {
      try {
        await s.switchDone;
        const code = await s.bridge.stop();
        if (code === null) log(`ERREUR : session ${s.id} : le bridge n'a pas répondu à SIGTERM, tué par SIGKILL avec son navigateur`);
        if (s.ephemeral) removeDir(s.userDataDir);
      } finally { release(); }
    })();
    return s.closed;
  }

  function profilesReport(current: Session | undefined): Record<string, unknown> {
    const profiles = store.list().map((p) => {
      const holder = [...sessions.values()].find((x) => x.profile === p.name);
      return { ...p, running: holder !== undefined, session: holder?.id ?? null };
    });
    return { root: store.root, posix: store.posix, current: current?.profile ?? null, profiles };
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
    // En-têtes x-grasp-* du bridge (dimensions d'une capture) transmis tels quels.
    const extra: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.headers)) if (k.startsWith('x-grasp-') && typeof v === 'string') extra[k] = v;
    res.writeHead(r.status, { ...extra, 'content-type': String(r.headers['content-type'] ?? 'application/octet-stream'), 'content-length': r.body.length });
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
        return sendJson(res, 200, [...sessions.values()].map((s) => ({ id: s.id, profile: s.profile, createdAt: s.createdAt, bridgePid: s.bridge.pid, chromePid: s.bridge.chromePid, userDataDir: s.userDataDir })));
      }
      if (route === 'POST /sessions') {
        const body = await readJson(req);
        const { session: s, profileCreated } = await createSession(optStr(body, 'profile'));
        return sendJson(res, 201, { id: s.id, profile: s.profile, profileCreated });
      }
      if (route === 'GET /profiles') {
        let current: Session | undefined;
        try { current = pickSession(req, url); } catch { current = undefined; }
        return sendJson(res, 200, profilesReport(current));
      }
      if (route === 'POST /profiles') {
        const body = await readJson(req);
        const p = store.create(str(body, 'name'), { useWhen: optStr(body, 'useWhen') });
        log(`profil « ${p.name} » créé (${p.path})`);
        return sendJson(res, 201, p);
      }
      if (route === 'POST /profiles/import') {
        const body = await readJson(req);
        const r = await store.importProfile(str(body, 'name'), str(body, 'sourcePath'), { profileDirectory: optStr(body, 'profileDirectory'), skipLocked: optBool(body, 'skipLocked') });
        for (const w of r.warnings) log(`AVERTISSEMENT : import « ${r.profile.name} » : ${w}`);
        if (r.skipped.length) log(`AVERTISSEMENT : import « ${r.profile.name} » : ${r.skipped.length} fichier(s) verrouillé(s) ignoré(s) : ${r.skipped.join(', ')}`);
        log(`profil « ${r.profile.name} » importé depuis ${r.profile.importedFrom}`);
        return sendJson(res, 201, r);
      }
      const pm = /^\/profiles\/([^/]+)$/.exec(url.pathname);
      if (pm && req.method === 'DELETE') {
        const name = decodeURIComponent(pm[1]!);
        validateProfileName(name);
        const holder = [...sessions.values()].find((x) => x.profile === name);
        if (holder !== undefined) throw new GraspError(409, `le profil « ${name} » est utilisé par la session ${holder.id} : \`grasp session close ${holder.id}\` d'abord`);
        const busy = holderOf(name);
        if (busy !== undefined) throw new GraspError(409, `le profil « ${name} » est utilisé par ${busy} : réessayez une fois l'opération terminée`);
        store.remove(name);
        log(`profil « ${name} » supprimé`);
        return sendJson(res, 200, { ok: true });
      }
      const sp = /^\/sessions\/([^/]+)\/profile$/.exec(url.pathname);
      if (sp && req.method === 'POST') {
        const s = sessions.get(sp[1]!);
        if (!s) throw new GraspError(404, `session ${sp[1]} inconnue — \`grasp session list\``);
        const body = await readJson(req);
        return sendJson(res, 200, { ok: true, id: s.id, ...await switchProfile(s, str(body, 'name')) });
      }
      const m = /^\/sessions\/([^/]+)$/.exec(url.pathname);
      if (m && req.method === 'DELETE') {
        const s = sessions.get(m[1]!);
        if (!s) throw new GraspError(404, `session ${m[1]} inconnue`);
        await closeSession(s);
        return sendJson(res, 200, { ok: true });
      }
      if (SESSION_ROUTES.has(url.pathname)) {
        const s = pickSession(req, url);
        if (s.switching) throw new GraspError(409, `session ${s.id} : bascule de profil en cours, réessayez`);
        return await proxy(s, req, res, url);
      }
      throw new GraspError(404, `route inconnue : ${route}`);
    } catch (e) { sendError(res, e); }
  }

  // 5. Écoute. Socket Unix 0600 par défaut ; TCP seulement sur 127.0.0.1.
  const server: Server = createServer((req, res) => { void handle(req, res); });
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
  // Navigateurs laissés par un serveur tué : retrouvés AVANT d'écraser instances.json.
  await reapStaleInstances(paths.instancesFile, {
    log,
    reapWindows: (d) => reapWindows(d, log),
    // Garde-fou : seuls les profils éphémères sous la racine temporaire sont supprimés.
    removeDir: (d) => { if (d.startsWith(`${roots.tmp}/`)) removeDir(d); },
  });
  persistInstances();
  writePrivate(paths.endpointFile, JSON.stringify(endpoint));
  log(`à l'écoute sur ${endpoint.transport === 'unix' ? endpoint.socketPath : `${endpoint.host}:${endpoint.port}`} (pid ${process.pid})`);

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
