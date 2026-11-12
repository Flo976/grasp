#!/usr/bin/env node
import { createServer, type Server } from 'node:http';
import { chmodSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { launchChrome, assertSupportedVersion, type ChromeProcess } from '../browser/launch.js';
import { CdpClient } from '../browser/cdp.js';
import { chromeDownloadPath } from '../browser/windows.js';
import { PageController } from './page.js';
import { bridgeHandler } from './server.js';
import type { BridgeInit } from '../control/bridges.js';

/**
 * Processus bridge : un par instance Chrome. Détient la connexion CDP.
 * Meurt avec le control plane (canal IPC fermé) et emporte Chrome avec lui.
 */
let chrome: ChromeProcess | undefined;
let cdp: CdpClient | undefined;
let server: Server | undefined;
let socketPath: string | undefined;
let page: PageController | undefined;
let attached = false;
let stopping = false;

const log = (m: string) => process.stderr.write(`[bridge ${process.pid}] ${m}\n`);

async function shutdown(code: number, why: string): Promise<never> {
  if (stopping) return new Promise<never>(() => undefined);
  stopping = true;
  log(`arrêt (${why})`);
  setTimeout(() => process.exit(code === 0 ? 1 : code), 15_000).unref();
  server?.close();
  server?.closeAllConnections();
  // Connexion Playwright d'abord : simple déconnexion de son WebSocket, jamais une fermeture du navigateur.
  await page?.closeEngine().catch((e: Error) => log(`moteur Playwright : ${e.message}`));
  if (attached) await page?.closeTab();
  cdp?.close();
  let exit = code;
  if (chrome) {
    try {
      const how = await chrome.kill(5000).then(() => 'ok');
      void how;
    } catch (e) { log(`ERREUR : ${(e as Error).message}`); exit = 1; }
  }
  if (socketPath) rmSync(socketPath, { force: true });
  process.exit(exit);
}

/** http://hôte:port → URL WebSocket du navigateur (via /json/version) ; ws:// accepté tel quel. */
async function resolveDevtools(url: string): Promise<{ wsUrl: string; version: string }> {
  if (/^wss?:/.test(url)) return { wsUrl: url, version: 'Chrome/999.0' };
  let r: Response;
  try { r = await fetch(new URL('/json/version', url), { signal: AbortSignal.timeout(5000) }); } catch (e) {
    throw new Error(`navigateur injoignable sur ${url} (${(e as Error).cause instanceof Error ? ((e as Error).cause as Error).message : (e as Error).message}) — Chrome est-il lancé avec --remote-debugging-port ?`);
  }
  if (!r.ok) throw new Error(`${url}/json/version a répondu ${r.status}`);
  const j = await r.json() as { webSocketDebuggerUrl?: string; Browser?: string };
  if (!j.webSocketDebuggerUrl) throw new Error(`${url} n'expose pas de webSocketDebuggerUrl`);
  return { wsUrl: j.webSocketDebuggerUrl, version: j.Browser ?? '' };
}

function getInit(): Promise<BridgeInit> {
  if (process.send === undefined) {
    const raw = process.env.GRASP_BRIDGE_INIT;
    if (!raw) throw new Error('bridge : ni canal IPC ni GRASP_BRIDGE_INIT');
    return Promise.resolve(JSON.parse(raw) as BridgeInit);
  }
  return new Promise((resolve) => {
    process.once('message', (m: { type: string; init: BridgeInit }) => { if (m.type === 'init') resolve(m.init); });
  });
}

async function main(): Promise<void> {
  process.on('SIGTERM', () => void shutdown(0, 'SIGTERM'));
  process.on('SIGINT', () => void shutdown(0, 'SIGINT'));
  // Parent (control plane) mort, même par SIGKILL : le canal IPC se ferme.
  process.on('disconnect', () => void shutdown(0, 'control plane disparu'));

  const init = await getInit();
  const policy = Object.freeze({
    ...init.policy,
    allowedDomains: Object.freeze([...init.policy.allowedDomains]),
    proxyBypassList: Object.freeze([...init.policy.proxyBypassList]),
    hostResolverRules: Object.freeze([...init.policy.hostResolverRules]),
    ignoreCertErrorsFor: Object.freeze([...init.policy.ignoreCertErrorsFor]),
  });
  // Proxy de la session (surcharge de proxyServer) : appliqué au lancement, rapporté par /session-options.
  const proxyServer = init.proxyServer ?? policy.proxyServer;
  socketPath = init.socketPath;
  const warnings: string[] = [];
  let info: { pid: number; pgid: number; version: string; windowsUserDataDir?: string };
  let devtoolsUrl: string;
  if (init.attach !== undefined) {
    // Mode attach : navigateur existant. On ne le lance pas, on ne le tuera pas.
    attached = true;
    if (proxyServer !== null || policy.hostResolverRules.length > 0) throw new Error('mode attach : proxy et règles de résolution sont des drapeaux de lancement de Chrome, inapplicables à un navigateur existant');
    const { wsUrl, version } = await resolveDevtools(init.attach);
    assertSupportedVersion(version);
    devtoolsUrl = wsUrl;
    cdp = await CdpClient.connect(wsUrl);
    info = { pid: 0, pgid: 0, version };
  } else {
    if (init.browser === undefined) throw new Error('bridge : ni navigateur ni URL attach');
    mkdirSync(init.userDataDir, { recursive: true, mode: 0o700 });
    // chrome.exe : profil sur NTFS (/mnt/c), droits POSIX non applicables.
    if (init.browser.kind !== 'windows') chmodSync(init.userDataDir, 0o700);
    const launchOpts = {
      browser: init.browser, userDataDir: init.userDataDir, headless: init.headless,
      network: { proxyServer, proxyBypassList: policy.proxyBypassList, hostResolverRules: policy.hostResolverRules },
      onWarning: (w: string) => { warnings.push(w); log(w); } };
    chrome = await launchChrome(init.stderrLog !== undefined ? { ...launchOpts, stderrLog: init.stderrLog } : launchOpts);
    chrome.child.once('exit', (c, s) => { if (!stopping) void shutdown(1, `Chrome s'est arrêté (code=${c} signal=${s})`); });
    devtoolsUrl = chrome.wsUrl;
    cdp = await CdpClient.connect(chrome.wsUrl);
    info = { pid: chrome.pid, pgid: chrome.pgid, version: chrome.version, ...(chrome.windowsUserDataDir !== undefined ? { windowsUserDataDir: chrome.windowsUserDataDir } : {}) };
  }
  cdp.once('close', () => { if (!stopping) void shutdown(1, 'connexion CDP perdue'); });
  const downloadDir = init.downloadDir ?? join(init.userDataDir, 'downloads');
  if (init.browser?.kind === 'windows') mkdirSync(downloadDir, { recursive: true });
  page = await PageController.attach(cdp, policy, {
    downloadDir: await chromeDownloadPath(downloadDir, init.browser?.kind ?? 'attach'), newTab: attached, capturesDir: init.capturesDir,
    ...(init.limits !== undefined ? { limits: init.limits } : {}),
    // Moteur Playwright (optionnel) : il se branche sur CE navigateur (chrome.exe : 127.0.0.1:<port>). Upload par
    // chemin seulement si le navigateur voit nos fichiers (Chrome Linux) ; sinon par contenu (≤ 50 Mo).
    engine: { devtoolsUrl, fallback: init.fallbackEngine ?? 'none', isLocal: !attached && init.browser?.kind !== 'windows' },
    httpAuth: init.httpAuth,
  });
  // Les identifiants vivent désormais dans le PageController seul : on n'en garde aucune autre copie.
  delete init.httpAuth;

  const c = info;
  const pc = page;
  server = createServer(bridgeHandler(page, () => ({ id: init.id, chromePid: c.pid, version: c.version, attached }),
    () => ({ proxyServer: init.proxyServer ?? null, httpAuth: pc.httpAuthReport() })));
  if (existsSync(socketPath)) rmSync(socketPath);
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  const prev = process.umask(0o077);
  await new Promise<void>((r, j) => { server!.once('error', j); server!.listen(socketPath, r); });
  process.umask(prev);
  chmodSync(socketPath, 0o600);

  const ready = { type: 'ready', pid: process.pid, chromePid: c.pid, chromePgid: c.pgid, version: c.version, warnings, ...(c.windowsUserDataDir !== undefined ? { windowsUserDataDir: c.windowsUserDataDir } : {}) };
  if (process.send) process.send(ready); else process.stdout.write(`${JSON.stringify(ready)}\n`);
}

main().catch((e: Error) => {
  log(`échec : ${e.message}`);
  const msg = { type: 'error', message: e.message };
  if (process.send) process.send(msg, () => void shutdown(1, 'échec du démarrage'));
  else void shutdown(1, 'échec du démarrage');
});
