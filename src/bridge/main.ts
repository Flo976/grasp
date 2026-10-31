#!/usr/bin/env node
import { createServer, type Server } from 'node:http';
import { chmodSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { launchChrome, type ChromeProcess } from '../browser/launch.js';
import { CdpClient } from '../browser/cdp.js';
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
let stopping = false;

const log = (m: string) => process.stderr.write(`[bridge ${process.pid}] ${m}\n`);

async function shutdown(code: number, why: string): Promise<never> {
  if (stopping) return new Promise<never>(() => undefined);
  stopping = true;
  log(`arrêt (${why})`);
  setTimeout(() => process.exit(code === 0 ? 1 : code), 15_000).unref();
  server?.close();
  server?.closeAllConnections();
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
  const policy = Object.freeze({ ...init.policy, allowedDomains: Object.freeze([...init.policy.allowedDomains]) });
  socketPath = init.socketPath;
  const warnings: string[] = [];
  mkdirSync(init.userDataDir, { recursive: true, mode: 0o700 });
  chmodSync(init.userDataDir, 0o700);
  const launchOpts = { browser: init.browser, userDataDir: init.userDataDir, headless: init.headless, onWarning: (w: string) => { warnings.push(w); log(w); } };
  chrome = await launchChrome(init.stderrLog !== undefined ? { ...launchOpts, stderrLog: init.stderrLog } : launchOpts);
  chrome.child.once('exit', (c, s) => { if (!stopping) void shutdown(1, `Chrome s'est arrêté (code=${c} signal=${s})`); });
  cdp = await CdpClient.connect(chrome.wsUrl);
  cdp.once('close', () => { if (!stopping) void shutdown(1, 'connexion CDP perdue'); });
  const page = await PageController.attach(cdp, policy, { downloadDir: init.downloadDir ?? join(init.userDataDir, 'downloads') });

  const c = chrome;
  server = createServer(bridgeHandler(page, () => ({ id: init.id, chromePid: c.pid, version: c.version })));
  if (existsSync(socketPath)) rmSync(socketPath);
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  const prev = process.umask(0o077);
  await new Promise<void>((r, j) => { server!.once('error', j); server!.listen(socketPath, r); });
  process.umask(prev);
  chmodSync(socketPath, 0o600);

  const ready = { type: 'ready', pid: process.pid, chromePid: c.pid, chromePgid: c.pgid, version: c.version, warnings };
  if (process.send) process.send(ready); else process.stdout.write(`${JSON.stringify(ready)}\n`);
}

main().catch((e: Error) => {
  log(`échec : ${e.message}`);
  const msg = { type: 'error', message: e.message };
  if (process.send) process.send(msg, () => void shutdown(1, 'échec du démarrage'));
  else void shutdown(1, 'échec du démarrage');
});
