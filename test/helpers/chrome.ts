import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverChrome, realProbe } from '../../src/browser/discover.js';
import { launchChrome, type ChromeProcess } from '../../src/browser/launch.js';
import { CdpClient } from '../../src/browser/cdp.js';
import { PageController } from '../../src/bridge/page.js';
import { effectivePolicy } from '../../src/core/policy.js';
import { resolveConfig, type ConfigFile } from '../../src/core/config.js';

export interface PageFixture { page: PageController; chrome: ChromeProcess; cdp: CdpClient; close(): Promise<void> }

export async function openPage(config: ConfigFile = { allowedDomains: ['127.0.0.1'] }): Promise<PageFixture> {
  const dir = mkdtempSync(join(tmpdir(), 'gr-page-'));
  const browser = discoverChrome(process.env, realProbe, process.env.HOME ?? '/');
  const chrome = await launchChrome({ browser, userDataDir: dir, headless: true });
  const cdp = await CdpClient.connect(chrome.wsUrl);
  const page = await PageController.attach(cdp, effectivePolicy(resolveConfig(config)), { downloadDir: join(dir, 'dl') });
  return {
    page, chrome, cdp,
    close: async () => { cdp.close(); await chrome.kill(); rmSync(dir, { recursive: true, force: true }); },
  };
}
