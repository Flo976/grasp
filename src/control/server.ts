import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, openSync, closeSync, writeSync } from 'node:fs';
import { connect, isIP } from 'node:net';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { AddressInfo } from 'node:net';
import { bridgeSocketPath, checkSocketPaths, type GraspPaths } from '../core/paths.js';
import { checkPermissions, ensurePrivateDir } from '../core/perms.js';
import { loadConfigFile, resolveConfig, limitsOf, type ResolvedConfig } from '../core/config.js';
import { checkUrl, effectivePolicy, type EffectivePolicy } from '../core/policy.js';
import { assertProxyServer, credentialLabel, maskCredentials, parseHttpAuth, type HttpCredential } from '../core/remote.js';
import { GraspError } from '../core/errors.js';
import { readBody, request, sendError, sendJson, type Endpoint, optStr, optBool, readJson, str } from '../core/http.js';
import { discoverChrome, profileRootsFor, realProbe, type DiscoveredBrowser, type ProfileRoots } from '../browser/discover.js';
import { assertSupportedVersion, browserVersion } from '../browser/launch.js';
import { toWslPath, windowsLocalAppData } from '../browser/windows.js';
import { ProfileStore, validateProfileName, type ProfileInfo } from '../core/profiles.js';
import { reapWindows, spawnBridge, type BridgeHandle } from './bridges.js';
import { reapStaleInstances } from './stale.js';
import { compileScript, runScript, type RunResult } from './run.js';
import type { StepRequest } from '../core/script.js';
import { isGraspServer, isProcessAlive } from './procutil.js';
import { PLAYWRIGHT_HINT, playwrightVersion } from '../bridge/playwright.js';
import { linuxGroupMemory, windowsChromeMemory, type MemoryReading } from '../browser/memory.js';

/** chrome.exe : une mesure PowerShell (~1 s) au plus toutes les 30 s, en arrière-plan. */
const WINDOWS_MEMORY_EVERY_MS = 30_000;

/** Durée lisible d'un âge ou d'un seuil en minutes (secondes en dessous d'une minute). */
function minutes(m: number): string {
  return m >= 1 ? `${Number.isInteger(m) ? m : m.toFixed(1)} min` : `${Math.round(m * 60)} s`;
}
import { STATE_MAX_BYTES } from '../core/state.js';

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
  /** Démarrage du navigateur courant (ms epoch) : relancé par une bascule ou un recyclage. */
  browserStartedAt: number;
  /** Nombre de recyclages du navigateur de cette session. */
  recycles: number;
  /** Commandes en cours sur la session (le recyclage n'a lieu qu'à 0 : entre deux commandes, jamais pendant). */
  inflight: number;
  /** Recyclage en cours : les commandes arrivées entre-temps l'attendent (pas de 409). */
  recycling?: Promise<void> | undefined;
  /** Note à joindre à la prochaine réponse (« navigateur recyclé : … »). */
  notice?: string | undefined;
  /** Dernière mesure mémoire du navigateur courant. */
  memory?: (MemoryReading & { at: number }) | undefined;
  /** Mesure chrome.exe en cours (PowerShell, en arrière-plan). */
  memoryProbe?: Promise<void> | undefined;
  /** Options d'accès distant de la session, conservées en mémoire pour relancer le bridge (bascule de profil). */
  options: SessionOptions;
}

/** Options de session : proxy propre et identifiants HTTP basic (mémoire du control plane et du bridge, jamais sur disque). */
export interface SessionOptions {
  proxyServer?: string;
  httpAuth: HttpCredential[];
}

/**
 * Lit les options de POST /sessions. Identifiants : chaînes « utilisateur:motdepasse@hôte[:port] » ; l'hôte doit
 * être dans l'allowlist (les identifiants ne partent jamais ailleurs). Aucun message ne recopie un identifiant.
 */
export function sessionOptionsOf(body: Record<string, unknown>, policy: Readonly<EffectivePolicy>, attach: boolean): SessionOptions {
  const out: SessionOptions = { httpAuth: [] };
  const proxy = body.proxyServer;
  if (proxy !== undefined && proxy !== null) {
    if (typeof proxy !== 'string') throw new GraspError(400, 'proxyServer : chaîne attendue');
    if (attach) throw new GraspError(400, 'mode attach : le proxy est un drapeau de lancement de Chrome, inapplicable à un navigateur existant');
    try { out.proxyServer = assertProxyServer(proxy.trim()); } catch (e) { throw new GraspError(400, (e as Error).message); }
  }
  const raw = body.httpAuth;
  if (raw !== undefined && raw !== null) {
    const list = typeof raw === 'string' ? [raw] : raw;
    if (!Array.isArray(list) || !list.every((x) => typeof x === 'string')) throw new GraspError(400, 'httpAuth : chaîne ou tableau de chaînes « utilisateur:motdepasse@hôte[:port] » attendu');
    for (const [i, x] of (list as string[]).entries()) {
      let c: HttpCredential;
      try { c = parseHttpAuth(x); } catch (e) { throw new GraspError(400, `httpAuth[${i}] : ${(e as Error).message}`); }
      const v = checkUrl(policy.allowedDomains, `http://${credentialLabel(c)}/`);
      if (!v.allowed) throw new GraspError(403, `httpAuth : ${v.reason} — des identifiants ne sont confiés qu'à un hôte de l'allowlist`);
      if (out.httpAuth.some((o) => o.host === c.host && o.port === c.port)) throw new GraspError(400, `httpAuth : ${credentialLabel(c)} donné deux fois`);
      out.httpAuth.push(c);
    }
  }
  return out;
}

export interface ControlPlaneOptions {
  paths: GraspPaths;
  env: NodeJS.ProcessEnv;
  home: string;
  transport?: 'unix' | 'tcp' | undefined;
  port?: number | undefined;
  /**
   * Adresse d'écoute TCP (IP littérale). Défaut 127.0.0.1. Hors boucle locale (ex. 0.0.0.0 dans un conteneur,
   * publié par `-p 127.0.0.1:…`) : opt-in explicite par `serve --tcp --listen`, jamais par la config.
   */
  listen?: string | undefined;
  log?: (m: string) => void;
}

/** 127.0.0.0/8, ::1 et ::ffff:127.x : boucle locale. */
export function isLoopback(host: string): boolean {
  return /^127\./.test(host) || host === '::1' || /^::ffff:127\./i.test(host);
}

/** Valide --listen : IP littérale, avec --tcp. Un nom d'hôte est refusé (sa résolution pourrait changer). */
export function checkListen(listen: string | undefined, transport: 'unix' | 'tcp'): string {
  if (listen === undefined) return '127.0.0.1';
  if (transport !== 'tcp') throw new Error('--listen exige --tcp (le socket Unix n\'a pas d\'adresse)');
  if (isIP(listen) === 0) throw new Error(`--listen ${listen} : adresse IP littérale attendue (ex. 0.0.0.0, 127.0.0.1, ::)`);
  return listen;
}

export interface ControlPlane { endpoint: Endpoint; close(): Promise<void> }

const SESSION_ROUTES = new Set(['/navigate', '/snap', '/text', '/click', '/fill', '/select', '/check', '/press', '/hover', '/type', '/screenshot', '/pdf', '/eval', '/cookies', '/upload', '/location', '/console', '/wait', '/state/export', '/state/import', '/expect', '/tabs', '/tabs/select', '/tabs/new', '/tabs/close']);
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
  const listenHost = checkListen(o.listen, transport);
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
  // Moteur Playwright de repli : optionnel ; son absence n'empêche rien, mais elle est dite au démarrage.
  const pwVersion = playwrightVersion(o.env.GRASP_PLAYWRIGHT_MODULE || 'playwright-core');
  if (config.fallbackEngine === 'playwright') {
    log(pwVersion !== null ? `repli des clics par Playwright activé (playwright-core ${pwVersion})` : `AVERTISSEMENT : fallbackEngine=playwright mais playwright-core est absent — ${PLAYWRIGHT_HINT} ; en attendant, le repli est sauté (et signalé à chaque clic non livré)`);
  }
  if (process.getuid?.() === 0 && o.env.GRASP_ALLOW_NO_SANDBOX !== '1') {
    throw new Error("Grasp tourne en root : le sandbox Chrome ne peut pas fonctionner. Utilisez un utilisateur non-root ou --cap-add=SYS_ADMIN ; sinon GRASP_ALLOW_NO_SANDBOX=1 en connaissance de cause.");
  }
  if (process.getuid?.() === 0) log('AVERTISSEMENT : GRASP_ALLOW_NO_SANDBOX=1 — Chrome sans sandbox.');

  // Accès distant : proxy et règles de résolution sont des drapeaux de lancement ; jamais ignorés en silence.
  if (config.cdpUrl !== null && (config.proxyServer !== null || config.hostResolverRules.length > 0)) {
    throw new Error('mode attach (cdpUrl) : proxyServer et hostResolverRules sont des drapeaux de lancement de Chrome, inapplicables à un navigateur existant — retirez-les ou lancez ce navigateur avec --proxy-server / --host-resolver-rules');
  }
  if (config.proxyServer !== null) log(`proxy : ${config.proxyServer}${config.proxyBypassList.length > 0 ? ` (contournement : ${config.proxyBypassList.join(', ')})` : ''}`);
  else if (config.proxyBypassList.length > 0) log('AVERTISSEMENT : proxyBypassList sans proxyServer : sans effet');
  if (config.hostResolverRules.length > 0) log(`résolution d'hôte : ${config.hostResolverRules.join(' ; ')} (l'allowlist porte sur le nom demandé)`);
  if (policy.ignoreCertErrorsFor.length > 0) {
    log(`AVERTISSEMENT : certificats TLS NON vérifiés pour ${policy.ignoreCertErrorsFor.join(', ')} (ignoreCertErrorsFor) — à réserver à une recette à travers un tunnel ; \`grasp config unset ignoreCertErrorsFor\` pour revenir à la vérification`);
  }

  const sessions = new Map<string, Session>();
  let closing: Promise<void> | undefined;
  /** Créations en cours (comptées dans maxSessions : N créations simultanées ne dépassent pas le plafond). */
  let creating = 0;
  // Recyclage : seulement pour un navigateur lancé par Grasp (en mode attach, il n'est pas à nous).
  const recycleOn = config.cdpUrl === null && (config.browserMaxRssMb !== null || config.browserMaxAgeMin !== null);
  if (config.cdpUrl !== null && (config.browserMaxRssMb !== null || config.browserMaxAgeMin !== null)) {
    log('AVERTISSEMENT : mode attach : browserMaxRssMb / browserMaxAgeMin sans effet (Grasp ne relance pas un navigateur qu\'il n\'a pas lancé)');
  }
  if (recycleOn) {
    const lim = [config.browserMaxRssMb !== null ? `${config.browserMaxRssMb} Mo (${browser?.kind === 'windows' ? 'octets privés de chrome.exe, mesurés toutes les 30 s' : 'PSS du groupe Chrome'})` : '', config.browserMaxAgeMin !== null ? minutes(config.browserMaxAgeMin) : ''].filter((x) => x !== '');
    log(`recyclage des navigateurs au-delà de ${lim.join(' ou ')}, entre deux commandes`);
  }
  if (config.maxSessions !== null) log(`plafond : ${config.maxSessions} session(s) simultanée(s)`);
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
      limits: limitsOf(config),
      fallbackEngine: config.fallbackEngine,
      ...(s.options.proxyServer !== undefined ? { proxyServer: s.options.proxyServer } : {}),
      ...(s.options.httpAuth.length > 0 ? { httpAuth: s.options.httpAuth } : {}),
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

  async function createSession(profile: string | undefined, options: SessionOptions = { httpAuth: [] }): Promise<{ session: Session; profileCreated: boolean }> {
    const id = `s${randomBytes(6).toString('hex')}`;
    if (config.maxSessions !== null && sessions.size + creating >= config.maxSessions) {
      throw new GraspError(503, `plafond de ${config.maxSessions} session(s) atteint (${sessions.size} ouverte(s)${creating > 0 ? `, ${creating} en création` : ''}, maxSessions) : fermez-en une (\`grasp session close <id>\`) ou relevez maxSessions`);
    }
    const p = profile !== undefined ? profileFor(profile, '--profile', `la session ${id} (en cours de création)`) : undefined;
    creating++;
    try {
      const base = { id, profile: profile ?? null, userDataDir: p?.profile.path ?? join(roots.tmp, id), ephemeral: p === undefined, createdAt: new Date().toISOString(), switching: false, options, browserStartedAt: Date.now(), recycles: 0, inflight: 0 };
      const bridge = await startBridge(base);
      if (closing !== undefined) {
        // Arrêt du serveur pendant le démarrage : la liste des sessions à fermer est déjà prise.
        await bridge.stop();
        if (base.ephemeral) removeDir(base.userDataDir);
        throw new GraspError(503, 'serveur en cours d\'arrêt');
      }
      const s: Session = { ...base, browserStartedAt: Date.now(), bridge };
      sessions.set(id, s);
      persistInstances();
      if (profile !== undefined) store.touch(profile);
      // Jamais d'identifiants dans le journal : l'hôte seulement.
      const extra = [
        ...(profile !== undefined ? [`profil ${profile}`] : []),
        ...(options.proxyServer !== undefined ? [`proxy ${options.proxyServer}`] : []),
        ...(options.httpAuth.length > 0 ? [`authentification HTTP pour ${options.httpAuth.map(credentialLabel).join(', ')}`] : []),
      ];
      log(`session ${id} créée (bridge ${bridge.pid}, Chrome ${bridge.chromePid}${extra.map((x) => `, ${x}`).join('')})`);
      return { session: s, profileCreated: p?.created === true };
    } finally { creating--; p?.release(); }
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
      s.browserStartedAt = Date.now();
      s.memory = undefined;
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

  /**
   * Mémoire du navigateur courant. Linux : mesurée à chaque appel (/proc, quelques ms). chrome.exe : dernière mesure
   * connue, rafraîchie en arrière-plan au plus toutes les 30 s (PowerShell coûte ~1 s) — le dépassement est donc
   * vu à la commande qui suit la mesure.
   */
  function memoryOf(s: Session): MemoryReading | undefined {
    const winDir = s.bridge.windowsUserDataDir;
    if (winDir === undefined) {
      const r = linuxGroupMemory(s.bridge.chromePgid);
      s.memory = r !== null ? { ...r, at: Date.now() } : undefined;
      return s.memory;
    }
    if (s.memoryProbe === undefined && (s.memory === undefined || Date.now() - s.memory.at >= WINDOWS_MEMORY_EVERY_MS)) {
      const bridge = s.bridge;
      s.memoryProbe = windowsChromeMemory(winDir)
        .then((r) => { if (s.bridge === bridge) s.memory = r !== null ? { ...r, at: Date.now() } : undefined; })
        .catch((e: Error) => log(`AVERTISSEMENT : session ${s.id} : mesure mémoire de chrome.exe impossible : ${e.message}`))
        .finally(() => { s.memoryProbe = undefined; });
    }
    return s.memory;
  }

  /** Raison de recycler le navigateur de la session, ou undefined. Synchrone : rien ne s'intercale entre la décision et le verrou. */
  function recycleReason(s: Session): string | undefined {
    if (config.browserMaxAgeMin !== null) {
      const age = (Date.now() - s.browserStartedAt) / 60_000;
      if (age > config.browserMaxAgeMin) return `âge ${minutes(age)} > ${minutes(config.browserMaxAgeMin)}`;
    }
    if (config.browserMaxRssMb !== null) {
      const m = memoryOf(s);
      if (m !== undefined && m.mb > config.browserMaxRssMb) return `${m.mb} Mo > ${config.browserMaxRssMb} Mo`;
    }
    return undefined;
  }

  /**
   * Recyclage : même mécanique que la bascule de profil (arrêt propre par Browser.close, cookies écrits, relance du
   * bridge sur le MÊME --user-data-dir, même identifiant de session), puis report des cookies de session (perdus
   * sinon) et rechargement de l'URL courante. Échec de la relance : session fermée, 502 explicite.
   */
  async function recycle(s: Session, why: string): Promise<void> {
    const old = s.bridge;
    const sock = { transport: 'unix' as const, socketPath: old.socketPath };
    let done!: () => void;
    s.switchDone = new Promise<void>((r) => { done = r; });
    s.switching = true;
    try {
      let url: string | undefined;
      let cookies: unknown[] = [];
      // Note différée du bridge (onglet fermé par la page) consommée par cette lecture : reportée dans la note du
      // recyclage, sinon perdue avec l'ancien bridge.
      let pending: string | undefined;
      try {
        const r = await request(sock, 'GET', '/location', undefined, {}, 10_000);
        if (r.status === 200) url = String(r.json().url);
        const n = r.headers['x-grasp-notice'];
        if (typeof n === 'string' && n !== '') { try { pending = decodeURIComponent(n); } catch { pending = n; } }
      } catch { /* bridge muet : rien à recharger */ }
      try { const r = await request(sock, 'GET', '/internal/session-cookies', undefined, {}, 10_000); if (r.status === 200) cookies = r.json().cookies as unknown[]; } catch { /* idem */ }
      const code = await old.stop();
      if (code === null) log(`ERREUR : session ${s.id} : le bridge n'a pas répondu à SIGTERM, tué par SIGKILL avec son navigateur`);
      const aborted = () => new GraspError(409, `session ${s.id} fermée pendant le recyclage de son navigateur`);
      if (s.closed !== undefined) throw aborted();
      try {
        s.bridge = await startBridge(s);
      } catch (e) {
        if (s.closed !== undefined) throw aborted();
        sessions.delete(s.id);
        s.closed = Promise.resolve();
        persistInstances();
        if (s.ephemeral) removeDir(s.userDataDir);
        log(`ERREUR : session ${s.id} : recyclage (${why}) : relance impossible, session fermée : ${(e as Error).message}`);
        throw new GraspError(502, `navigateur à recycler (${why}) mais relance impossible : ${(e as Error).message} — session ${s.id} fermée`);
      }
      if (s.closed !== undefined) { await s.bridge.stop(); throw aborted(); }
      s.browserStartedAt = Date.now();
      s.recycles++;
      s.memory = undefined;
      persistInstances();
      const nsock = { transport: 'unix' as const, socketPath: s.bridge.socketPath };
      const parts = [...(pending !== undefined ? [pending] : []), `navigateur recyclé : ${why}`];
      if (cookies.length > 0) {
        try {
          const r = await request(nsock, 'POST', '/internal/session-cookies', { cookies }, {}, 10_000);
          if (r.status !== 200) throw new Error(String(r.json().error ?? r.status));
          parts.push(`${cookies.length} cookie(s) de session reporté(s)`);
        } catch (e) { parts.push(`cookies de session perdus (${(e as Error).message})`); }
      }
      if (url === undefined || url === 'about:blank' || url === '') parts.push('page vide, rien à recharger');
      else {
        try {
          const r = await request(nsock, 'POST', '/navigate', { url }, {}, 60_000);
          if (r.status !== 200) throw new Error(String(r.json().error ?? r.status));
          parts.push(`page rechargée sur ${url}`);
        } catch (e) { parts.push(`rechargement de ${url} impossible (${(e as Error).message}) : la page repart de about:blank`); }
      }
      s.notice = parts.join(' ; ');
      const after = config.browserMaxRssMb !== null && s.bridge.windowsUserDataDir === undefined ? linuxGroupMemory(s.bridge.chromePgid) : null;
      log(`session ${s.id} : ${s.notice} (bridge ${s.bridge.pid}, Chrome ${s.bridge.chromePid}${after !== null ? `, ${after.mb} Mo après relance` : ''})`);
      if (after !== null && config.browserMaxRssMb !== null && after.mb > config.browserMaxRssMb) {
        log(`AVERTISSEMENT : session ${s.id} : ${after.mb} Mo juste après la relance, déjà au-delà de browserMaxRssMb=${config.browserMaxRssMb} : le navigateur sera recyclé à chaque commande — relevez le seuil`);
      }
    } finally {
      s.switching = false;
      done();
    }
  }

  /**
   * Entrée d'une commande sur la session : attend un recyclage en cours, ou le déclenche si la session est au repos
   * (aucune autre commande en vol) et qu'un seuil est dépassé. Rend la note à joindre à la réponse. `leave` obligatoire.
   */
  async function enter(s: Session): Promise<string | undefined> {
    s.inflight++;
    try {
      if (s.recycling !== undefined) {
        await s.recycling.catch(() => undefined);
        if (s.closed !== undefined) throw new GraspError(502, `session ${s.id} fermée : le recyclage de son navigateur a échoué (journal du serveur)`);
      } else if (recycleOn && s.inflight === 1 && !s.switching && s.closed === undefined) {
        const why = recycleReason(s);
        if (why !== undefined) {
          s.recycling = recycle(s, why).finally(() => { s.recycling = undefined; });
          await s.recycling;
        }
      }
    } catch (e) { s.inflight--; throw e; }
    const n = s.notice;
    s.notice = undefined;
    return n;
  }
  const leave = (s: Session) => { s.inflight--; };

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
    const sessionOptions: Record<string, unknown> = {};
    for (const s of sessions.values()) {
      const sock = { transport: 'unix' as const, socketPath: s.bridge.socketPath };
      const r = await request(sock, 'GET', '/policy').catch(() => null);
      bridges[s.id] = r && r.status === 200 ? r.json() : { error: 'bridge injoignable' };
      // Ce que le bridge détient en mémoire (proxy de session, hôtes munis d'identifiants, masqués).
      const o = await request(sock, 'GET', '/session-options').catch(() => null);
      sessionOptions[s.id] = o && o.status === 200 ? o.json() : { error: 'bridge injoignable' };
    }
    let disk: unknown;
    try { disk = loadEffective(paths).policy; } catch (e) { disk = { error: (e as Error).message }; }
    return {
      // L'objet exact transmis aux bridges et consulté par le garde.
      policy,
      bridges,
      sessionOptions,
      transport: endpoint.transport,
      // Adresse réellement liée (≠ endpoint.json, qui donne l'adresse où se connecter) ; exposed = hors boucle locale.
      listen: listening,
      configFile: paths.configFile,
      configFileExists: existsSync(paths.configFile),
      diskDiffers: !isDeepStrictEqual(JSON.parse(JSON.stringify(disk)), JSON.parse(JSON.stringify(policy))),
    };
  }

  /**
   * Une étape de `grasp run` : la même route du bridge qu'une commande isolée (mêmes contrôles de politique,
   * mêmes limites), ou la bascule de profil du control plane. Le bridge est relu à chaque étape (bascule).
   */
  async function execStep(s: Session, rq: StepRequest, onNotice: (n: string) => void): Promise<unknown> {
    if (s.closed !== undefined) throw new GraspError(409, `session ${s.id} fermée pendant le script`);
    if (rq.path === 'profile') return switchProfile(s, String(rq.body?.name ?? ''));
    if (!SESSION_ROUTES.has(rq.path.split('?')[0]!)) throw new GraspError(400, `route ${rq.path} indisponible dans run`);
    // Entre deux étapes : un recyclage peut avoir lieu ici, jamais pendant une étape.
    const notice = await enter(s);
    let r;
    try {
      if (notice !== undefined) onNotice(notice);
      if (s.switching) throw new GraspError(409, `session ${s.id} : bascule de profil en cours, réessayez`);
      r = await request({ transport: 'unix', socketPath: s.bridge.socketPath }, rq.method, rq.path, rq.body, {}, rq.timeoutMs);
    } catch (e) {
      if (e instanceof GraspError) throw e;
      throw new GraspError(502, `bridge de la session ${s.id} injoignable : ${(e as Error).message}`);
    } finally { leave(s); }
    // Note du bridge (onglet fermé par la page depuis la commande précédente) : jointe à l'étape, comme le recyclage.
    const bn = r.headers['x-grasp-notice'];
    if (typeof bn === 'string') onNotice(decodeURIComponent(bn));
    const isJson = String(r.headers['content-type'] ?? '').startsWith('application/json');
    if (r.status >= 400) {
      let msg = r.text();
      let extra: Record<string, unknown> | undefined;
      try {
        const { error, ...rest } = r.json() as Record<string, unknown>;
        msg = String(error ?? msg);
        if (Object.keys(rest).length > 0) extra = rest;
      } catch { /* texte brut */ }
      throw new GraspError(r.status, msg, extra);
    }
    return isJson ? r.json() : r.text();
  }

  async function proxy(s: Session, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const body = req.method === 'POST' ? await readBody(req, url.pathname === '/state/import' ? STATE_MAX_BYTES : undefined) : undefined;
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
    // Notes du control plane (recyclage) et du bridge (onglets) : les deux, jamais l'une à la place de l'autre.
    const own = res.getHeader('x-grasp-notice');
    if (typeof own === 'string' && extra['x-grasp-notice'] !== undefined) extra['x-grasp-notice'] = `${own}${encodeURIComponent(' ; ')}${extra['x-grasp-notice']}`;
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
        return sendJson(res, 200, [...sessions.values()].map((s) => ({
          id: s.id, profile: s.profile, createdAt: s.createdAt, bridgePid: s.bridge.pid, chromePid: s.bridge.chromePid, userDataDir: s.userDataDir,
          proxyServer: s.options.proxyServer ?? null, httpAuth: maskCredentials(s.options.httpAuth),
          browserStartedAt: new Date(s.browserStartedAt).toISOString(), recycles: s.recycles,
          ...(s.memory !== undefined ? { memoryMb: s.memory.mb, memoryMetric: s.memory.metric } : {}),
        })));
      }
      if (route === 'POST /sessions') {
        const body = await readJson(req);
        const { session: s, profileCreated } = await createSession(optStr(body, 'profile'), sessionOptionsOf(body, policy, config.cdpUrl !== null));
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
      if (route === 'POST /run') {
        // Analyse complète avant toute exécution, puis étapes séquentielles : un seul aller-retour HTTP.
        const body = await readJson(req);
        const steps = compileScript(str(body, 'script'));
        const s = pickSession(req, url);
        // Client parti avant la fin (Ctrl-C, délai de l'agent) : plus aucune étape ne démarre, et le journal dit
        // lesquelles ont été exécutées — l'appelant, lui, ne verra jamais la réponse.
        const ac = new AbortController();
        const onClose = () => { if (!res.writableFinished) ac.abort(); };
        res.on('close', onClose);
        let r: RunResult;
        let notice: string | undefined;
        try {
          r = await runScript(steps, (rq) => execStep(s, rq, (n) => { notice = notice !== undefined ? `${notice} ; ${n}` : n; }), optBool(body, 'continue') === true, ac.signal, {
            report: optBool(body, 'report'),
            takeNotice: () => { const n = notice; notice = undefined; return n; },
          });
        } finally { res.off('close', onClose); }
        if (r.aborted === true) {
          const last = r.steps.at(-1);
          log(`AVERTISSEMENT : session ${s.id} : run interrompu : client déconnecté après ${r.executed} étape(s) exécutée(s)${last !== undefined ? ` (dernière : [${last.n}] ${last.text} → ${last.ok ? 'OK' : `ERROR: ${last.error ?? ''}`})` : ''} ; ${r.total - r.executed} étape(s) non exécutée(s)`);
          return;
        }
        return sendJson(res, 200, r);
      }
      if (SESSION_ROUTES.has(url.pathname)) {
        const s = pickSession(req, url);
        const notice = await enter(s);
        try {
          // Note de recyclage : en-tête sur toute réponse (JSON, texte, binaire, erreur), affichée par la CLI sur stderr.
          if (notice !== undefined) res.setHeader('x-grasp-notice', encodeURIComponent(notice));
          if (s.switching) throw new GraspError(409, `session ${s.id} : bascule de profil en cours, réessayez`);
          return await proxy(s, req, res, url);
        } finally { leave(s); }
      }
      throw new GraspError(404, `route inconnue : ${route}`);
    } catch (e) { sendError(res, e); }
  }

  // 5. Écoute. Socket Unix 0600 par défaut ; TCP sur 127.0.0.1, ou sur l'adresse de --listen (opt-in explicite).
  const server: Server = createServer((req, res) => { void handle(req, res); });
  let endpoint: Endpoint;
  let listening: { socket: string } | { host: string; port: number; exposed: boolean };
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
    listening = { socket: paths.socketPath };
  } else {
    const port = o.port ?? config.port;
    await new Promise<void>((r, j) => { server.once('error', j); server.listen(port, listenHost, r); });
    const bound = (server.address() as AddressInfo).port;
    // Adresse joker : les clients locaux (CLI dans le conteneur) se connectent par la boucle locale.
    const connectHost = listenHost === '0.0.0.0' || listenHost === '::' ? '127.0.0.1' : listenHost;
    endpoint = { transport: 'tcp', host: connectHost, port: bound };
    listening = { host: listenHost, port: bound, exposed: !isLoopback(listenHost) };
    if (listening.exposed) log(`AVERTISSEMENT : control plane exposé hors boucle locale sur ${listenHost}:${bound} (--listen) : le token est la seule barrière, et le trafic n'est pas chiffré. Publiez le port sur 127.0.0.1 de l'hôte (docker run -p 127.0.0.1:${bound}:${bound}).`);
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
  log(`à l'écoute sur ${'socket' in listening ? listening.socket : `${listening.host}:${listening.port}`} (pid ${process.pid})`);

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
