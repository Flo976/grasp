import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverChrome, realProbe } from '../../src/browser/discover.js';
import { launchChrome, freeLocalPort, type ChromeProcess } from '../../src/browser/launch.js';
import { CdpClient } from '../../src/browser/cdp.js';
import { procsOnUserDataDir, waitUntil } from '../helpers/procs.js';

/**
 * Port DevTools choisi par Grasp. Avec --remote-debugging-port=0, Chrome (Linux comme Windows) expose
 * navigator.webdriver === true sur toutes les pages, et des sites anti-bot (Malt) refusent alors la page.
 */

const browser = () => discoverChrome(process.env, realProbe, process.env.HOME ?? '/');

async function webdriver(chrome: ChromeProcess): Promise<unknown> {
  const cdp = await CdpClient.connect(chrome.wsUrl);
  try {
    const { targetInfos } = await cdp.send<{ targetInfos: Array<{ targetId: string; type: string }> }>('Target.getTargets');
    const page = targetInfos.find((t) => t.type === 'page')!;
    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    const r = await cdp.send<{ result: { value?: unknown } }>('Runtime.evaluate', { expression: 'navigator.webdriver', returnByValue: true }, sessionId);
    return r.result.value;
  } finally { cdp.close(); }
}

/** Faux « autre Chrome » sur 127.0.0.1 : répond à /json/version avec SON endpoint, compte les connexions WebSocket. */
async function foreignChrome(): Promise<{ port: number; upgrades: () => number; close(): Promise<void> }> {
  let upgrades = 0;
  const srv: Server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ Browser: 'Chrome/150.0.0.0', webSocketDebuggerUrl: `ws://127.0.0.1:${(srv.address() as { port: number }).port}/devtools/browser/pas-le-votre` }));
  });
  srv.on('upgrade', (_req, sock) => { upgrades++; sock.destroy(); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return { port: (srv.address() as { port: number }).port, upgrades: () => upgrades, close: () => new Promise((r) => srv.close(() => r())) };
}

const mainProcs = (dir: string) => procsOnUserDataDir(dir).length;

test('lancement : port DevTools fixe choisi par Grasp, navigator.webdriver === false (headless=new), pas de DevToolsActivePort', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gr-port-'));
  const chrome = await launchChrome({ browser: browser(), userDataDir: dir, headless: true });
  try {
    assert.ok(chrome.port > 0);
    assert.match(chrome.wsUrl, new RegExp(`^ws://127\\.0\\.0\\.1:${chrome.port}/devtools/browser/[0-9a-f-]+$`));
    assert.equal(existsSync(join(dir, 'DevToolsActivePort')), false, 'port fixe : Chrome n\'écrit pas DevToolsActivePort, Grasp ne s\'en sert plus');
    assert.equal(await webdriver(chrome), false, 'navigator.webdriver doit valoir false');
  } finally {
    await chrome.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lancement fenêtré (DISPLAY) : navigator.webdriver === false', { skip: process.env.DISPLAY ? false : 'pas de DISPLAY' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gr-port-'));
  const chrome = await launchChrome({ browser: browser(), userDataDir: dir, headless: false });
  try {
    assert.equal(await webdriver(chrome), false);
  } finally {
    await chrome.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('course : un autre navigateur répond sur le port choisi → jamais connecté, nouvel essai sur un autre port', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gr-port-'));
  const foreign = await foreignChrome();
  const free = await freeLocalPort();
  const picks = [foreign.port, free];
  let chrome: ChromeProcess | undefined;
  try {
    chrome = await launchChrome({ browser: browser(), userDataDir: dir, headless: true, pickPort: async () => picks.shift()! });
    assert.equal(chrome.port, free, 'second essai sur un autre port');
    assert.equal(foreign.upgrades(), 0, 'jamais de connexion CDP au navigateur d\'un autre');
    assert.equal(await webdriver(chrome), false);
    const v = await (await fetch(`http://127.0.0.1:${chrome.port}/json/version`)).json() as { webSocketDebuggerUrl: string };
    assert.equal(v.webSocketDebuggerUrl, chrome.wsUrl);
  } finally {
    await chrome?.kill();
    await foreign.close();
    assert.ok(await waitUntil(() => mainProcs(dir) === 0, 5000), 'aucun Chrome orphelin (ni celui du 1er essai)');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('course : port toujours indisponible → échec bruyant après un nombre borné d\'essais, aucun Chrome orphelin', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gr-port-'));
  const foreign = await foreignChrome();
  let picks = 0;
  try {
    await assert.rejects(
      launchChrome({ browser: browser(), userDataDir: dir, headless: true, pickPort: async () => { picks++; return foreign.port; } }),
      (e: Error) => { assert.match(e.message, new RegExp(`3 essais.*${foreign.port}`, 's')); return true; },
    );
    assert.equal(picks, 3);
    assert.equal(foreign.upgrades(), 0);
  } finally {
    await foreign.close();
    assert.ok(await waitUntil(() => mainProcs(dir) === 0, 5000), 'aucun Chrome orphelin');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Chrome qui s\'arrête au démarrage (profil verrouillé) : erreur immédiate, sans relance en boucle', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gr-port-'));
  symlinkSync('autremachine-4242', join(dir, 'SingletonLock'));
  let picks = 0;
  const t0 = Date.now();
  try {
    await assert.rejects(
      launchChrome({ browser: browser(), userDataDir: dir, headless: true, pickPort: async () => { picks++; return freeLocalPort(); } }),
      /s'est arrêté au démarrage.*déjà utilisé/s,
    );
    assert.equal(picks, 1, 'un port n\'y est pour rien : pas de nouvel essai');
    assert.ok(Date.now() - t0 < 10_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
