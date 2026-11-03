// Complément de sonde-cdp.mjs : événements de navigation intra-document, iframes, Fetch.failRequest, dialogues.
// Usage : node eval/lightpanda/sonde-evenements.mjs chrome|lightpanda   (GRASP_LIGHTPANDA=… pour lightpanda)
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CdpClient } from '../../dist/src/browser/cdp.js';
import { launchLightpanda } from '../../dist/src/browser/lightpanda.js';
import { startTestSite } from '../../dist/test/helpers/testsite.js';
const which = process.argv[2] ?? 'lightpanda';
let proc, dir;
if (which === 'chrome') {
  const { discoverChrome, realProbe } = await import('../../dist/src/browser/discover.js');
  const { launchChrome } = await import('../../dist/src/browser/launch.js');
  dir = mkdtempSync(join(tmpdir(), 'sonde-'));
  proc = await launchChrome({ browser: discoverChrome(process.env, realProbe, process.env.HOME), userDataDir: dir, headless: true });
} else proc = await launchLightpanda({ bin: process.env.GRASP_LIGHTPANDA, extraArgs: ['--load-resources', 'iframe'] });
const site = await startTestSite();
const cdp = await CdpClient.connect(proc.wsUrl);
const ev = new Map();
cdp.on('event', (e) => ev.set(e.method, (ev.get(e.method) ?? 0) + 1));
const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
const { sessionId: s } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
await cdp.send('Page.enable', {}, s); await cdp.send('Runtime.enable', {}, s);
await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] }, s);
const out = [];
cdp.on('event', (e) => {
  if (e.method !== 'Fetch.requestPaused') return;
  const bad = e.params.request.url.includes('/aide');
  cdp.send(bad ? 'Fetch.failRequest' : 'Fetch.continueRequest', bad ? { requestId: e.params.requestId, errorReason: 'Aborted' } : { requestId: e.params.requestId }, e.sessionId)
    .then(() => out.push(`${bad ? 'Fetch.failRequest' : 'Fetch.continueRequest'} ok (${e.params.request.url.replace(site.url, '')})`), (er) => out.push(`${bad ? 'Fetch.failRequest' : 'continue'} ERREUR ${er.message}`));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev1 = async (x) => (await cdp.send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }, s)).result.value;
await cdp.send('Page.navigate', { url: `${site.url}/` }, s); await sleep(800);
await ev1('history.pushState({}, "", "/spa-2"); location.hash = "#x"; 1'); await sleep(300);
await ev1('document.querySelector("a[href=\\"/aide\\"]").click(); 1'); await sleep(800);
out.push(`après clic vers /aide bloqué : ${await ev1('location.pathname')}`);
await ev1('const f = document.createElement("iframe"); f.src = "/cadre-texte"; document.body.append(f); 1'); await sleep(800);
out.push(`iframe : frameTree enfants = ${JSON.stringify((await cdp.send('Page.getFrameTree', {}, s)).frameTree.childFrames?.length ?? 0)}`);
await ev1('document.querySelector("iframe").remove(); 1'); await sleep(300);
const dlg = cdp.waitFor('Page.javascriptDialogOpening', () => true, 3000).then(() => true, () => false);
void cdp.send('Runtime.evaluate', { expression: 'window.__r = confirm("ok ?"); 1' }, s).catch(() => {});
out.push(`dialogue reçu : ${await dlg}`);
out.push(`Page.handleJavaScriptDialog : ${await cdp.send('Page.handleJavaScriptDialog', { accept: true }, s).then(() => 'ok', (e) => e.message)}`);
await sleep(200);
out.push(`valeur de confirm() vue par la page : ${await ev1('String(window.__r)')}`);
for (const m of ['Page.navigatedWithinDocument', 'Page.frameRequestedNavigation', 'Page.frameNavigated', 'Page.frameAttached', 'Page.frameDetached', 'Fetch.requestPaused', 'Target.attachedToTarget']) out.push(`${m} : ${ev.get(m) ?? 0}`);
console.log(`# ${which}\n` + out.map((l) => `- ${l}`).join('\n'));
cdp.close(); await site.close(); await proc.kill(); if (dir) rmSync(dir, { recursive: true, force: true });
process.exit(0);
