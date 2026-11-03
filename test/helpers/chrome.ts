import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverChrome, realProbe } from '../../src/browser/discover.js';
import { launchChrome, type ChromeProcess } from '../../src/browser/launch.js';
import { launchLightpanda, lightpandaEngine } from '../../src/browser/lightpanda.js';
import { CdpClient } from '../../src/browser/cdp.js';
import { PageController } from '../../src/bridge/page.js';
import { effectivePolicy } from '../../src/core/policy.js';
import { resolveConfig, type ConfigFile } from '../../src/core/config.js';
import type { Limits } from '../../src/core/limits.js';

export interface PageFixture { page: PageController; chrome: ChromeProcess; cdp: CdpClient; capturesDir: string; downloadDir: string; close(): Promise<void> }

/** Moteur Playwright du bridge : module chargé (défaut playwright-core) et délai d'inactivité. */
export interface EngineFixture { module?: string; idleMs?: number }

export async function openPage(config: ConfigFile = { allowedDomains: ['127.0.0.1'] }, limits?: Partial<Limits>, engine: EngineFixture = {}): Promise<PageFixture> {
  const dir = mkdtempSync(join(tmpdir(), 'gr-page-'));
  // GRASP_ENGINE=lightpanda (évaluation) : même fixture, navigateur Lightpanda.
  const lp = lightpandaEngine();
  const chrome = lp !== null ? await launchLightpanda({ bin: lp })
    : await launchChrome({ browser: discoverChrome(process.env, realProbe, process.env.HOME ?? '/'), userDataDir: dir, headless: true });
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
