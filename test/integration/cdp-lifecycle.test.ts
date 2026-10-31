import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverChrome, realProbe } from '../../src/browser/discover.js';
import { launchChrome } from '../../src/browser/launch.js';
import { CdpClient } from '../../src/browser/cdp.js';
import { aliveInGroup, descendants, isAlive, waitUntil } from '../helpers/procs.js';

test('transport CDP : connexion, commande, événement, arrêt propre du groupe', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gr-cdp-'));
  const browser = discoverChrome(process.env, realProbe, process.env.HOME ?? '/');
  const chrome = await launchChrome({ browser, userDataDir: dir, headless: true });
  try {
    const cdp = await CdpClient.connect(chrome.wsUrl);
    const v = await cdp.send<{ product: string }>('Browser.getVersion');
    assert.match(v.product, /Chrome/);

    // erreur CDP remontée comme exception
    await assert.rejects(cdp.send('Domaine.inexistant'), /wasn't found|not found/i);

    // événements : on observe la création d'une cible
    const created = cdp.waitFor('Target.targetCreated', (p: any) => p.targetInfo.url === 'about:blank#x', 5000);
    await cdp.send('Target.setDiscoverTargets', { discover: true });
    await cdp.send('Target.createTarget', { url: 'about:blank#x' });
    await created;

    // Chrome a forké des enfants (renderer, GPU, utility) dans son groupe
    const kids = descendants(chrome.pid);
    assert.ok(kids.length >= 2, `attendu des sous-processus Chrome, trouvé ${kids.length}`);
    cdp.close();
    await chrome.kill();
    assert.deepEqual(aliveInGroup(chrome.pgid), []);
    assert.ok(await waitUntil(() => kids.every((k) => !isAlive(k)), 3000), 'des enfants Chrome ont survécu');
  } finally {
    await chrome.kill().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('les commandes en vol sont rejetées quand la connexion tombe', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gr-cdp-'));
  const browser = discoverChrome(process.env, realProbe, process.env.HOME ?? '/');
  const chrome = await launchChrome({ browser, userDataDir: dir, headless: true });
  try {
    const cdp = await CdpClient.connect(chrome.wsUrl);
    const { targetInfos } = await cdp.send<{ targetInfos: Array<{ targetId: string; type: string }> }>('Target.getTargets');
    const page = targetInfos.find((t) => t.type === 'page')!;
    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    const pending = cdp.send('Runtime.evaluate', { expression: 'new Promise(()=>{})', awaitPromise: true }, sessionId);
    const check = assert.rejects(pending, /fermée|closed/i);
    await chrome.kill();
    await check;
  } finally {
    await chrome.kill().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});
