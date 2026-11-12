// Capture du formulaire du site de test par un navigateur CDP déjà lancé (rendu réel ou non ?), formats acceptés,
// effet de Emulation.setDeviceMetricsOverride. Usage : node eval/obscura/capture.mjs <http://127.0.0.1:9445> <sortie.png>
import { writeFileSync } from 'node:fs';
import { CdpClient } from '../../dist/src/browser/cdp.js';
import { startTestSite } from '../../dist/test/helpers/testsite.js';

const site = await startTestSite();
const ws = (await (await fetch(`${process.argv[2]}/json/version`)).json()).webSocketDebuggerUrl;
const cdp = await CdpClient.connect(ws);
const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
const { sessionId: s } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
await cdp.send('Page.enable', {}, s);
const ld = cdp.waitFor('Page.loadEventFired');
await cdp.send('Page.navigate', { url: site.url + '/' }, s); await ld;
for (const fmt of ['png', 'jpeg', 'webp']) {
  const r = await cdp.send('Page.captureScreenshot', { format: fmt }, s).then((x) => `${Math.round(x.data.length * 3 / 4 / 1024)} Ko`, (e) => e.message);
  console.log(`- captureScreenshot ${fmt} : ${r}`);
}
const shot = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 800, height: 400, scale: 1 } }, s);
writeFileSync(process.argv[3], Buffer.from(shot.data, 'base64'));
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 400, height: 300, deviceScaleFactor: 1, mobile: false }, s);
const lm = await cdp.send('Page.getLayoutMetrics', {}, s);
console.log(`- après setDeviceMetricsOverride 400×300 : layoutViewport ${JSON.stringify(lm.cssLayoutViewport ?? lm.layoutViewport)}, innerWidth ${(await cdp.send('Runtime.evaluate', { expression: 'innerWidth + "×" + innerHeight', returnByValue: true }, s)).result.value}`);
await cdp.send('Target.closeTarget', { targetId }); cdp.close(); await site.close(); process.exit(0);
