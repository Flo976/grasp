// Sonde CDP : exécute chaque méthode CDP appelée par Grasp (src/) contre un navigateur et note la réponse.
// Usage : node eval/lightpanda/sonde-cdp.mjs chrome|lightpanda [ws://…]   (après npm run build)
// lightpanda : LIGHTPANDA_DISABLE_TELEMETRY=true lightpanda serve --host 127.0.0.1 --port 9333
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CdpClient } from '../../dist/src/browser/cdp.js';
import { startTestSite } from '../../dist/test/helpers/testsite.js';

const which = process.argv[2] ?? 'lightpanda';
let chrome, dir, wsUrl = process.argv[3];
if (which === 'chrome') {
  const { discoverChrome, realProbe } = await import('../../dist/src/browser/discover.js');
  const { launchChrome } = await import('../../dist/src/browser/launch.js');
  dir = mkdtempSync(join(tmpdir(), 'sonde-'));
  chrome = await launchChrome({ browser: discoverChrome(process.env, realProbe, process.env.HOME), userDataDir: dir, headless: true });
  wsUrl = chrome.wsUrl;
} else if (!wsUrl) {
  wsUrl = (await (await fetch('http://127.0.0.1:9333/json/version')).json()).webSocketDebuggerUrl;
}
const site = await startTestSite();
const cdp = await CdpClient.connect(wsUrl);
const events = new Map();
cdp.on('event', (e) => events.set(e.method, (events.get(e.method) ?? 0) + 1));
const rows = [];
const short = (v) => { const s = JSON.stringify(v); return s.length > 160 ? s.slice(0, 157) + '…' : s; };
async function t(method, params = {}, session, label = method) {
  const t0 = performance.now();
  try {
    const r = await Promise.race([cdp.send(method, params, session), new Promise((_, j) => setTimeout(() => j(new Error('délai 8 s')), 8000))]);
    rows.push({ m: label, ok: true, ms: Math.round(performance.now() - t0), r: short(r) });
    return r;
  } catch (e) {
    rows.push({ m: label, ok: false, ms: Math.round(performance.now() - t0), r: e.message });
    return undefined;
  }
}
const ver = await t('Browser.getVersion');
const tg = await t('Target.getTargets');
const created = await t('Target.createTarget', { url: 'about:blank' });
const targetId = created?.targetId;
const att = await t('Target.attachToTarget', { targetId, flatten: true });
const s = att?.sessionId;
await t('Target.getTargetInfo', { targetId });
await t('Page.enable', {}, s);
await t('DOM.enable', {}, s);
await t('Accessibility.enable', {}, s);
await t('Runtime.enable', {}, s);
await t('Log.enable', {}, s);
await t('Network.enable', { maxTotalBufferSize: 0, maxResourceBufferSize: 0 }, s);
await t('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] }, s);
await t('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, s, 'Target.setAutoAttach (session)');
const ft = await t('Page.getFrameTree', {}, s);
await t('Browser.setDownloadBehavior', { behavior: 'deny' });
await t('Page.setDownloadBehavior', { behavior: 'deny' }, s);
await t('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, undefined, 'Target.setAutoAttach (navigateur)');
// Navigation gardée : Fetch.requestPaused → continueRequest
let paused = 0;
const onPause = (e) => { if (e.method === 'Fetch.requestPaused') { paused++; cdp.send('Fetch.continueRequest', { requestId: e.params.requestId }, e.sessionId).then(() => rows.push({ m: 'Fetch.continueRequest', ok: true, ms: 0, r: '{}' }), (er) => rows.push({ m: 'Fetch.continueRequest', ok: false, ms: 0, r: er.message })); } };
cdp.on('event', onPause);
const load = cdp.waitFor('Page.loadEventFired', () => true, 10000).then(() => true, () => false);
await t('Page.navigate', { url: site.url + '/' }, s);
const loaded = await load;
rows.push({ m: 'Page.loadEventFired (événement)', ok: loaded, ms: 0, r: loaded ? 'reçu' : 'non reçu en 10 s' });
rows.push({ m: 'Fetch.requestPaused (événement)', ok: paused > 0, ms: 0, r: `${paused} reçu(s)` });
cdp.off('event', onPause);
await t('Fetch.enable', { patterns: [] }, s, 'Fetch.enable (motifs vides, pour la suite)');
await t('Page.getNavigationHistory', {}, s);
await t('Page.getLayoutMetrics', {}, s);
const ev = await t('Runtime.evaluate', { expression: 'document.title + "|" + navigator.webdriver + "|" + navigator.userAgent', returnByValue: true }, s);
const iso = await t('Page.createIsolatedWorld', { frameId: ft?.frameTree?.frame?.id, worldName: 'grasp', grantUniveralAccess: false }, s);
if (iso) await t('Runtime.evaluate', { expression: '1+1', contextId: iso.executionContextId, returnByValue: true }, s, 'Runtime.evaluate (monde isolé)');
const ax = await t('Accessibility.getFullAXTree', {}, s);
if (ax?.nodes) rows.push({ m: '  ↳ getFullAXTree : nœuds', ok: true, ms: 0, r: `${ax.nodes.length} nœuds ; rôles : ${[...new Set(ax.nodes.map((n) => n.role?.value))].join(',')}` });
await t('Accessibility.queryAXTree', { accessibleName: 'Valider', role: 'button', backendNodeId: ax?.nodes?.find((n) => n.role?.value === 'RootWebArea')?.backendDOMNodeId }, s);
const doc = await t('DOM.getDocument', { depth: -1, pierce: true }, s);
const qsa = await t('DOM.querySelectorAll', { nodeId: doc?.root?.nodeId, selector: '#nom' }, s);
const nodeId = qsa?.nodeIds?.[0];
const desc = await t('DOM.describeNode', { nodeId }, s);
const backendNodeId = desc?.node?.backendNodeId;
await t('DOM.describeNode', { backendNodeId }, s, 'DOM.describeNode (backendNodeId)');
const res = await t('DOM.resolveNode', { backendNodeId, objectGroup: 'grasp' }, s);
const objectId = res?.object?.objectId;
await t('Runtime.callFunctionOn', { objectId, functionDeclaration: 'function(){ return this.tagName + "#" + this.id; }', returnByValue: true }, s);
if (iso) {
  const r2 = await t('DOM.resolveNode', { backendNodeId, executionContextId: iso.executionContextId }, s, 'DOM.resolveNode (monde isolé)');
  if (r2) await t('Runtime.callFunctionOn', { objectId: r2.object.objectId, functionDeclaration: 'function(){ return this.getBoundingClientRect().width; }', returnByValue: true }, s, 'Runtime.callFunctionOn (getBoundingClientRect)');
}
await t('Runtime.getProperties', { objectId, ownProperties: true }, s);
await t('DOM.scrollIntoViewIfNeeded', { backendNodeId }, s);
const quads = await t('DOM.getContentQuads', { backendNodeId }, s);
await t('DOM.focus', { backendNodeId }, s);
await t('Input.insertText', { text: 'Ada' }, s);
await t('Input.dispatchKeyEvent', { type: 'keyDown', key: 'b', code: 'KeyB', text: 'b', windowsVirtualKeyCode: 66 }, s);
await t('Input.dispatchKeyEvent', { type: 'keyUp', key: 'b', code: 'KeyB', windowsVirtualKeyCode: 66 }, s, 'Input.dispatchKeyEvent (keyUp)');
const v = await t('Runtime.evaluate', { expression: 'document.querySelector("#nom").value', returnByValue: true }, s, 'Runtime.evaluate (valeur saisie)');
rows.push({ m: '  ↳ saisie effective', ok: v?.result?.value === 'Adab', ms: 0, r: JSON.stringify(v?.result?.value) });
// Clic souris sur la case à cocher
const cb = await t('Runtime.evaluate', { expression: 'JSON.stringify(document.querySelector("#cgu").getBoundingClientRect())', returnByValue: true }, s, 'Runtime.evaluate (boîte #cgu)');
let x = 10, y = 10;
try { const b = JSON.parse(cb.result.value); x = b.x + b.width / 2; y = b.y + b.height / 2; } catch {}
await t('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, s, 'Input.dispatchMouseEvent (mouseMoved)');
await t('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, s, 'Input.dispatchMouseEvent (mousePressed)');
await t('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, s, 'Input.dispatchMouseEvent (mouseReleased)');
const chk = await t('Runtime.evaluate', { expression: 'document.querySelector("#cgu").checked', returnByValue: true }, s, 'Runtime.evaluate (case cochée ?)');
rows.push({ m: '  ↳ clic souris effectif (case cochée)', ok: chk?.result?.value === true, ms: 0, r: JSON.stringify(chk?.result?.value) + ` à (${Math.round(x)},${Math.round(y)})` });
await t('Runtime.releaseObject', { objectId }, s);
await t('Runtime.releaseObjectGroup', { objectGroup: 'grasp' }, s);
await t('Emulation.setFocusEmulationEnabled', { enabled: true }, s);
await t('Emulation.setDeviceMetricsOverride', { width: 800, height: 600, deviceScaleFactor: 1, mobile: false }, s);
await t('Emulation.clearDeviceMetricsOverride', {}, s);
await t('Network.getCookies', { urls: [site.url] }, s);
const shot = await t('Page.captureScreenshot', { format: 'png' }, s);
if (shot?.data) rows.push({ m: '  ↳ capture PNG', ok: true, ms: 0, r: `${Math.round(shot.data.length * 3 / 4 / 1024)} Ko` });
const pdf = await t('Page.printToPDF', {}, s);
if (pdf?.data) rows.push({ m: '  ↳ PDF', ok: true, ms: 0, r: `${Math.round(pdf.data.length * 3 / 4 / 1024)} Ko` });
await t('Page.bringToFront', {}, s);
// Dialogue JS
const dlg = cdp.waitFor('Page.javascriptDialogOpening', () => true, 4000).then(() => true, () => false);
void cdp.send('Runtime.evaluate', { expression: 'setTimeout(() => alert("coucou"), 10); 1' }, s).catch(() => {});
const gotDlg = await dlg;
rows.push({ m: 'Page.javascriptDialogOpening (événement)', ok: gotDlg, ms: 0, r: gotDlg ? 'reçu' : 'non reçu en 4 s' });
if (gotDlg) await t('Page.handleJavaScriptDialog', { accept: true }, s);
await t('Runtime.runIfWaitingForDebugger', {}, s);
// Console : événements
await t('Runtime.evaluate', { expression: 'console.log("bonjour", 42); console.error("aïe"); setTimeout(() => { throw new Error("boum"); }, 0); fetch("/absent.png").catch(()=>{}); 1' }, s, 'Runtime.evaluate (console/exception/fetch)');
await new Promise((r) => setTimeout(r, 1500));
await t('Target.detachFromTarget', { sessionId: s });
await t('Target.closeTarget', { targetId });
await new Promise((r) => setTimeout(r, 300));
const evs = ['Page.frameNavigated', 'Page.frameStartedLoading', 'Page.frameStoppedLoading', 'Page.frameRequestedNavigation', 'Page.navigatedWithinDocument', 'Page.frameDetached', 'Page.loadEventFired',
  'Runtime.executionContextCreated', 'Runtime.executionContextDestroyed', 'Runtime.executionContextsCleared', 'Runtime.consoleAPICalled', 'Runtime.exceptionThrown', 'Log.entryAdded',
  'Network.requestWillBeSent', 'Network.responseReceived', 'Network.loadingFinished', 'Network.loadingFailed', 'Target.attachedToTarget', 'Target.detachedFromTarget', 'Fetch.requestPaused', 'Page.javascriptDialogOpening'];
console.log(`# ${which} — ${ver?.product ?? '?'} (${wsUrl})\n`);
console.log('| Méthode | OK | ms | Réponse |\n|---|---|---|---|');
for (const r of rows) console.log(`| ${r.m} | ${r.ok ? 'oui' : 'NON'} | ${r.ms} | ${String(r.r).replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`);
console.log('\n| Événement | Reçus |\n|---|---|');
for (const e of evs) console.log(`| ${e} | ${events.get(e) ?? 0} |`);
console.log(`\nAutres événements : ${[...events.keys()].filter((k) => !evs.includes(k)).join(', ')}`);
cdp.close();
await site.close();
if (chrome) { await chrome.kill(); rmSync(dir, { recursive: true, force: true }); }
process.exit(0);
