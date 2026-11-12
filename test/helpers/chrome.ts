import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverChrome, realProbe } from '../../src/browser/discover.js';
import { launchChrome, type ChromeProcess } from '../../src/browser/launch.js';
import { CdpClient } from '../../src/browser/cdp.js';
import { PageController } from '../../src/bridge/page.js';
import { effectivePolicy } from '../../src/core/policy.js';
import { resolveConfig, type ConfigFile } from '../../src/core/config.js';
import type { Limits } from '../../src/core/limits.js';

export interface PageFixture { page: PageController; chrome: ChromeProcess; cdp: CdpClient; capturesDir: string; downloadDir: string; close(): Promise<void> }

/** Moteur Playwright du bridge : module chargé (défaut playwright-core) et délai d'inactivité. */
export interface EngineFixture { module?: string; idleMs?: number }

/**
 * GRASP_TEST_CDP_URL (http://hôte:port ou ws://…) : les tests de page se branchent en mode attach sur un navigateur
 * déjà lancé (évaluation d'un autre moteur CDP, ex. Obscura) au lieu de lancer Chrome. Onglet propre à chaque test.
 */
async function attachedChrome(url: string): Promise<ChromeProcess> {
  let wsUrl = url;
  if (!/^wss?:/.test(url)) wsUrl = ((await (await fetch(new URL('/json/version', url))).json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl;
  return { pid: 0, pgid: 0, wsUrl, port: Number(new URL(wsUrl).port), version: 'attach', child: undefined as never, kill: async () => undefined };
}

export async function openPage(config: ConfigFile = { allowedDomains: ['127.0.0.1'] }, limits?: Partial<Limits>, engine: EngineFixture = {}): Promise<PageFixture> {
  const dir = mkdtempSync(join(tmpdir(), 'gr-page-'));
  const attachUrl = process.env.GRASP_TEST_CDP_URL;
  if (attachUrl !== undefined && attachUrl !== '') {
    const chrome = await attachedChrome(attachUrl);
    const cdp = await CdpClient.connect(chrome.wsUrl);
    const capturesDir = join(dir, 'captures');
    const downloadDir = join(dir, 'dl');
    const cfg = resolveConfig(config);
    const page = await PageController.attach(cdp, effectivePolicy(cfg), {
      downloadDir, capturesDir, newTab: true, ...(limits !== undefined ? { limits } : {}),
      engine: { devtoolsUrl: chrome.wsUrl, fallback: cfg.fallbackEngine, isLocal: false, ...engine },
    });
    return {
      page, chrome, cdp, capturesDir, downloadDir,
      close: async () => {
        await page.closeEngine();
        await page.closeTab();
        cdp.close(); rmSync(dir, { recursive: true, force: true });
      },
    };
  }
  const browser = discoverChrome(process.env, realProbe, process.env.HOME ?? '/');
  const chrome = await launchChrome({ browser, userDataDir: dir, headless: true });
  const cdp = await CdpClient.connect(chrome.wsUrl);
  const capturesDir = join(dir, 'captures');
  const downloadDir = join(dir, 'dl');
  const cfg = resolveConfig(config);
  const page = await PageController.attach(cdp, effectivePolicy(cfg), {
    downloadDir, capturesDir, ...(limits !== undefined ? { limits } : {}),
    engine: { devtoolsUrl: chrome.wsUrl, fallback: cfg.fallbackEngine, isLocal: true, ...engine },
  });
  return {
    page, chrome, cdp, capturesDir, downloadDir,
    close: async () => { await page.closeEngine(); cdp.close(); await chrome.kill(); rmSync(dir, { recursive: true, force: true }); },
  };
}
