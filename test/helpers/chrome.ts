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
import type { HttpCredential } from '../../src/core/remote.js';
import type { Resolver } from '../../src/core/ssrf.js';

export interface PageFixture { page: PageController; chrome: ChromeProcess; cdp: CdpClient; capturesDir: string; downloadDir: string; close(): Promise<void> }

/** Moteur Playwright du bridge : module chargé (défaut playwright-core) et délai d'inactivité. */
export interface EngineFixture { module?: string; idleMs?: number }

/**
 * Réseau de la fixture. `chromeArgs` : arguments Chrome supplémentaires, ignorés de la politique (ex.
 * --host-resolver-rules qui SIMULE le DNS, fusionné avec les hostResolverRules de la config) ; `resolve` :
 * résolveur DNS du garde SSRF ; `httpAuth` : identifiants HTTP basic de la session.
 */
export interface NetFixture { chromeArgs?: readonly string[]; resolve?: Resolver; httpAuth?: HttpCredential[] }

export async function openPage(config: ConfigFile = { allowedDomains: ['127.0.0.1'] }, limits?: Partial<Limits>, engine: EngineFixture = {}, net: NetFixture = {}): Promise<PageFixture> {
  const dir = mkdtempSync(join(tmpdir(), 'gr-page-'));
  const browser = discoverChrome(process.env, realProbe, process.env.HOME ?? '/');
  const cfg = resolveConfig(config);
  // Proxy et règles de résolution : drapeaux de lancement, comme dans le bridge.
  const network = { proxyServer: cfg.proxyServer, proxyBypassList: cfg.proxyBypassList, hostResolverRules: cfg.hostResolverRules };
  const chrome = await launchChrome({ browser, userDataDir: dir, headless: true, network, ...(net.chromeArgs !== undefined ? { extraArgs: net.chromeArgs } : {}) });
  const cdp = await CdpClient.connect(chrome.wsUrl);
  const capturesDir = join(dir, 'captures');
  const downloadDir = join(dir, 'dl');
  const page = await PageController.attach(cdp, effectivePolicy(cfg), {
    ...(net.httpAuth !== undefined ? { httpAuth: net.httpAuth } : {}),
    downloadDir, capturesDir, ...(limits !== undefined ? { limits } : {}), ...(net.resolve !== undefined ? { resolve: net.resolve } : {}),
    engine: { devtoolsUrl: chrome.wsUrl, fallback: cfg.fallbackEngine, isLocal: true, ...engine },
  });
  return {
    page, chrome, cdp, capturesDir, downloadDir,
    close: async () => { await page.closeEngine(); cdp.close(); await chrome.kill(); rmSync(dir, { recursive: true, force: true }); },
  };
}
