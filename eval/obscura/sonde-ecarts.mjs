// Écarts Obscura ↔ Chrome qui comptent pour Grasp : garde de navigation (Fetch.failRequest), Fetch.enable sans
// motif, dialogues, exceptions, Log, aperçu console, titre, innerText, arbre AX (focus, valeur de liste).
// Usage : node eval/obscura/sonde-ecarts.mjs chrome|obscura [http://127.0.0.1:9445]   (après npm run build)
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CdpClient } from '../../dist/src/browser/cdp.js';
import { startTestSite } from '../../dist/test/helpers/testsite.js';

const which = process.argv[2] ?? 'obscura';
let proc, dir, wsUrl;
if (which === 'chrome') {
  const { discoverChrome, realProbe } = await import('../../dist/src/browser/discover.js');
  const { launchChrome } = await import('../../dist/src/browser/launch.js');
  dir = mkdtempSync(join(tmpdir(), 'sonde-'));
  proc = await launchChrome({ browser: discoverChrome(process.env, realProbe, process.env.HOME), userDataDir: dir, headless: true });
  wsUrl = proc.wsUrl;
} else {
  wsUrl = (await (await fetch(`${process.argv[3] ?? 'http://127.0.0.1:9445'}/json/version`)).json()).webSocketDebuggerUrl;
}
const site = await startTestSite();
const cdp = await CdpClient.connect(wsUrl);
const ev = new Map();
const evList = [];
cdp.on('event', (e) => { ev.set(e.method, (ev.get(e.method) ?? 0) + 1); evList.push(e); });
const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
const { sessionId: s } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
for (const m of ['Page.enable', 'Runtime.enable', 'DOM.enable', 'Accessibility.enable', 'Log.enable', 'Network.enable']) await cdp.send(m, {}, s);
const out = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev1 = async (x) => (await cdp.send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }, s)).result.value;
const nav = async (path) => {
  const ld = cdp.waitFor('Page.loadEventFired', () => true, 8000).then(() => true, () => false);
  const t0 = Date.now();
  const r = await cdp.send('Page.navigate', { url: site.url + path }, s).then(() => null, (e) => e.message);
  return r === null ? await ld : `Page.navigate en erreur après ${Date.now() - t0} ms : ${r}`;
};

// 1. Garde : Fetch.failRequest sur un document (clic de lien, redirection 302, Page.navigate)
await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] }, s);
const blocked = [];
const onPause = (e) => {
  if (e.method !== 'Fetch.requestPaused') return;
  const u = e.params.request.url;
  const bad = u.includes('/aide') || u.includes('example.com');
  if (bad) blocked.push(u.replace(site.url, ''));
  cdp.send(bad ? 'Fetch.failRequest' : 'Fetch.continueRequest', bad ? { requestId: e.params.requestId, errorReason: 'BlockedByClient' } : { requestId: e.params.requestId }, e.sessionId).catch((er) => out.push(`Fetch ERREUR ${er.message}`));
};
cdp.on('event', onPause);
await nav('/'); await sleep(300);
await ev1('document.querySelector("a[href=\\"/aide\\"]").click(); 1'); await sleep(1000);
out.push(`garde, clic vers /aide refusé (failRequest) : location=${await ev1('location.pathname')} titre=${JSON.stringify(await ev1('document.title'))} h1=${JSON.stringify(await ev1('document.querySelector("h1")?.textContent ?? null'))}`);
await nav('/'); await sleep(300);
const r = await cdp.send('Page.navigate', { url: site.url + '/redirect-out' }, s).catch((e) => ({ errorText: 'EXC ' + e.message }));
await sleep(1500);
out.push(`garde, redirection 302 vers example.com refusée : Page.navigate=${JSON.stringify(r)} → location=${await ev1('location.href')}`);
await nav('/'); await sleep(300);
await ev1('window.open("http://example.com/", "_self"); 1').catch(() => undefined); await sleep(1500);
out.push(`garde, window.open(_self) vers example.com refusé : location=${await ev1('location.href')}`);
out.push(`requêtes refusées par la sonde : ${JSON.stringify(blocked)}`);
cdp.off('event', onPause);

// 2. Fetch.enable sans motif (Grasp : fin d'interception) — la navigation suivante passe-t-elle ?
await cdp.send('Fetch.enable', { patterns: [] }, s);
const before = ev.get('Fetch.requestPaused') ?? 0;
const ok2 = await nav('/aide');
out.push(`Fetch.enable { patterns: [] } puis navigation : load=${ok2}, requestPaused en plus=${(ev.get('Fetch.requestPaused') ?? 0) - before}`);
await cdp.send('Fetch.disable', {}, s).then(() => out.push('Fetch.disable : ok'), (e) => out.push(`Fetch.disable : ${e.message}`));
const ok3 = await nav('/');
out.push(`après Fetch.disable, navigation : load=${ok3}`);

// 3. Dialogues
for (const kind of ['alert("a")', 'confirm("c")', 'prompt("p", "x")']) {
  const dlg = cdp.waitFor('Page.javascriptDialogOpening', () => true, 2000).then((p) => p.type, () => null);
  const t0 = Date.now();
  const v = cdp.send('Runtime.evaluate', { expression: `String(${kind})`, returnByValue: true }, s).then((x) => x.result.value, (e) => 'EXC ' + e.message);
  const got = await dlg;
  if (got) await cdp.send('Page.handleJavaScriptDialog', { accept: true, promptText: 'rép' }, s).catch(() => undefined);
  out.push(`${kind} : événement=${got ?? 'aucun'}, valeur=${JSON.stringify(await v)} en ${Date.now() - t0} ms`);
}

// 4. Console, exceptions, Log
evList.length = 0;
await ev1('console.log("objet", {code: 42, nested: {a: 1}}); setTimeout(() => { throw new Error("boum"); }, 0); Promise.reject(new Error("rejet")); fetch("/absent.png").catch(() => {}); 1');
await sleep(1500);
const cons = evList.find((e) => e.method === 'Runtime.consoleAPICalled');
out.push(`consoleAPICalled args[1] : ${JSON.stringify(cons?.params?.args?.[1])?.slice(0, 220)}`);
const exc = evList.filter((e) => e.method === 'Runtime.exceptionThrown').map((e) => e.params.exceptionDetails?.exception?.description?.split('\n')[0] ?? e.params.exceptionDetails?.text);
out.push(`exceptionThrown : ${JSON.stringify(exc)}`);
out.push(`Log.entryAdded : ${JSON.stringify(evList.filter((e) => e.method === 'Log.entryAdded').map((e) => e.params.entry.level + ':' + e.params.entry.text.slice(0, 80)))}`);
out.push(`Network.loadingFailed / responseReceived 404 : ${evList.filter((e) => e.method === 'Network.loadingFailed').length} / ${evList.filter((e) => e.method === 'Network.responseReceived' && e.params.response.status === 404).length}`);

// 5. Titre, innerText, AX (focus, valeur de <select>, options)
await nav('/'); await sleep(300);
out.push(`document.title=${JSON.stringify(await ev1('document.title'))} ; getTargetInfo.title=${JSON.stringify((await cdp.send('Target.getTargetInfo', { targetId })).targetInfo.title)}`);
out.push(`body.innerText (120 premiers car.) : ${JSON.stringify((await ev1('document.body.innerText')).slice(0, 120))}`);
await ev1('document.querySelector("#email").focus(); 1');
const ax = (await cdp.send('Accessibility.getFullAXTree', {}, s)).nodes;
const nm = (n) => n.name?.value;
const cb = ax.find((n) => n.role?.value === 'combobox');
out.push(`AX combobox : name=${JSON.stringify(nm(cb))} value=${JSON.stringify(cb?.value)} props=${JSON.stringify(cb?.properties?.map((p) => p.name))} enfants=${cb?.childIds?.length}`);
const em = ax.find((n) => n.role?.value === 'textbox' && nm(n) === 'Email');
out.push(`AX textbox Email (focalisé) : props=${JSON.stringify(em?.properties?.map((p) => `${p.name}=${JSON.stringify(p.value?.value)}`))}`);
const opts = ax.filter((n) => n.role?.value === 'option' || n.role?.value === 'MenuListOption');
out.push(`AX options : ${JSON.stringify(opts.map((n) => `${n.role.value}:${nm(n)}`))}`);
out.push(`AX nœuds : ${ax.length}, ignorés : ${ax.filter((n) => n.ignored).length}, sans backendDOMNodeId : ${ax.filter((n) => n.backendDOMNodeId === undefined).length}`);
await ev1('document.querySelector("#nom").value = "Ada"; 1');
const ax2 = (await cdp.send('Accessibility.getFullAXTree', {}, s)).nodes;
out.push(`AX textbox Nom après saisie : value=${JSON.stringify(ax2.find((n) => nm(n) === 'Nom')?.value)}`);
out.push(`Runtime.evaluate 1+1 description : ${JSON.stringify((await cdp.send('Runtime.evaluate', { expression: '1+1' }, s)).result.description)}`);

// 6. Navigations déclenchées par la page (sans interception) : quels événements ?
await cdp.send('Fetch.disable', {}, s).catch(() => undefined);
for (const [lbl, js] of [['clic de lien', 'document.querySelector("a[href=\\"/aide\\"]").click()'], ['soumission de formulaire', 'document.querySelector("form").requestSubmit()'], ['location.href', 'location.href = "/aide"'], ['pushState', 'history.pushState({}, "", "/spa-x")']]) {
  await nav('/'); await sleep(300);
  evList.length = 0;
  await ev1(`${js}; 1`).catch(() => undefined); await sleep(1200);
  const seen = evList.filter((e) => e.method.startsWith('Page.') || e.method === 'Runtime.executionContextsCleared').map((e) => e.method.replace('Page.', '') + (e.method === 'Page.frameNavigated' ? `(parentId=${e.params.frame.parentId ?? '-'})` : ''));
  out.push(`navigation par ${lbl} : location=${(await ev1('location.pathname').catch((x) => x.message))} ; événements : ${[...new Set(seen)].join(', ') || 'aucun'}`);
}

for (const m of ['Page.frameStartedLoading', 'Page.frameRequestedNavigation', 'Page.navigatedWithinDocument', 'Runtime.executionContextDestroyed']) out.push(`${m} (cumul) : ${ev.get(m) ?? 0}`);
console.log(`# ${which}\n` + out.map((l) => `- ${l}`).join('\n'));
await cdp.send('Target.closeTarget', { targetId }).catch(() => undefined);
cdp.close(); await site.close(); if (proc) await proc.kill(); if (dir) rmSync(dir, { recursive: true, force: true });
process.exit(0);
