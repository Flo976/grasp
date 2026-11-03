// Banc Chrome headless vs Lightpanda, à travers le PageController de Grasp (mêmes nav et snapshot qu'en vrai).
// Usage (après npm run build) :
//   GRASP_LIGHTPANDA=/chemin/lightpanda node eval/lightpanda/banc.mjs [essais=5] [dossierSortie] [--local-seulement]
//   node eval/lightpanda/banc.mjs parallele <K> [essais=3]
// Mesures : démarrage à froid (lancement → onglet prêt), mémoire (RSS et PSS du groupe de processus),
// navigation (nav Grasp : load + stabilité) et snapshot, par page. Médianes sur les essais.
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverChrome, realProbe } from '../../dist/src/browser/discover.js';
import { launchChrome } from '../../dist/src/browser/launch.js';
import { launchLightpanda } from '../../dist/src/browser/lightpanda.js';
import { CdpClient } from '../../dist/src/browser/cdp.js';
import { PageController } from '../../dist/src/bridge/page.js';
import { effectivePolicy } from '../../dist/src/core/policy.js';
import { resolveConfig } from '../../dist/src/core/config.js';
import { startTestSite } from '../../dist/test/helpers/testsite.js';

const LP = process.env.GRASP_LIGHTPANDA;
if (!LP) { console.error('GRASP_LIGHTPANDA manquant'); process.exit(2); }
// LP_ARGS : options Lightpanda en plus (ex. "--load-resources stylesheet") ; BANC_STABLE_MS : plafond de stabilité Grasp (0 = aucune attente).
const LP_ARGS = (process.env.LP_ARGS ?? '').split(' ').filter(Boolean);
const STABLE = process.env.BANC_STABLE_MS !== undefined ? Number(process.env.BANC_STABLE_MS) : undefined;
const EXTERNES = [
  'https://example.com/',
  'https://info.cern.ch/hypertext/WWW/TheProject.html',
  'https://news.ycombinator.com/',
  'https://fr.wikipedia.org/wiki/Antananarivo',
];
const cfg = resolveConfig({ allowedDomains: ['127.0.0.1', 'example.com', 'info.cern.ch', 'news.ycombinator.com', '*.wikipedia.org', 'fr.wikipedia.org'] });
const policy = effectivePolicy(cfg);

/** Mémoire du groupe de processus : somme RSS et PSS (smaps_rollup) de tous les processus de pgid. */
function groupMem(pgid) {
  let rss = 0, pss = 0, n = 0;
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = readFileSync(`/proc/${d}/stat`, 'utf8');
      const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (Number(f[2]) !== pgid) continue;
      const roll = readFileSync(`/proc/${d}/smaps_rollup`, 'utf8');
      rss += Number(/^Rss:\s+(\d+)/m.exec(roll)?.[1] ?? 0);
      pss += Number(/^Pss:\s+(\d+)/m.exec(roll)?.[1] ?? 0);
      n++;
    } catch { /* processus parti */ }
  }
  return { rssMo: rss / 1024, pssMo: pss / 1024, procs: n };
}

async function start(engine) {
  const t0 = performance.now();
  const dir = mkdtempSync(join(tmpdir(), 'banc-'));
  const proc = engine === 'chrome'
    ? await launchChrome({ browser: discoverChrome(process.env, realProbe, process.env.HOME), userDataDir: dir, headless: true })
    : await launchLightpanda({ bin: LP, extraArgs: LP_ARGS });
  const tLaunch = performance.now() - t0;
  const cdp = await CdpClient.connect(proc.wsUrl);
  const page = await PageController.attach(cdp, policy, { ...(STABLE !== undefined ? { limits: { stableTimeoutMs: STABLE } } : {}), downloadDir: join(dir, 'dl'), capturesDir: join(dir, 'cap'), engine: { devtoolsUrl: proc.wsUrl, isLocal: true } });
  const tReady = performance.now() - t0;
  return { proc, cdp, page, dir, tLaunch, tReady, close: async () => { await page.closeEngine(); cdp.close(); await proc.kill(); rmSync(dir, { recursive: true, force: true }); } };
}

const med = (a) => { const s = [...a].filter((x) => x !== null && !Number.isNaN(x)).sort((x, y) => x - y); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const r0 = (x) => x === null ? '—' : Math.round(x);
const r1 = (x) => x === null ? '—' : x.toFixed(1);

async function serie(essais, outDir, localOnly) {
  const site = await startTestSite();
  const pages = [`${site.url}/`, `${site.url}/big`, `${site.url}/snap-v3`, ...(localOnly ? [] : EXTERNES)];
  const res = {};
  for (const engine of ['chrome', 'lightpanda']) {
    const R = res[engine] = { launch: [], ready: [], memIdle: [], memEnd: [], pss: [], pages: Object.fromEntries(pages.map((p) => [p, { nav: [], snap: [], bytes: [], lines: [], err: [] }])) };
    for (let i = 0; i < essais; i++) {
      const s = await start(engine);
      R.launch.push(s.tLaunch); R.ready.push(s.tReady);
      R.memIdle.push(groupMem(s.proc.pgid));
      for (const url of pages) {
        const P = R.pages[url];
        try {
          const t0 = performance.now();
          await s.page.navigate(url);
          const t1 = performance.now();
          const snap = await s.page.snapshot({ maxBytes: 10_000_000 });
          const t2 = performance.now();
          P.nav.push(t1 - t0); P.snap.push(t2 - t1); P.bytes.push(Buffer.byteLength(snap.text)); P.lines.push(snap.text.split('\n').length);
          if (i === 0 && outDir) {
            const name = url.replace(/^https?:\/\//, '').replace(/127\.0\.0\.1:\d+/, 'local').replace(/[^\w.-]+/g, '_');
            writeFileSync(join(outDir, `${engine}--${name}.snap.txt`), snap.text);
            writeFileSync(join(outDir, `${engine}--${name}.text.txt`), await s.page.text(10_000_000));
          }
        } catch (e) { P.err.push(e.message.slice(0, 200)); }
      }
      R.memEnd.push(groupMem(s.proc.pgid));
      await s.close();
    }
  }
  await site.close();
  const rows = [];
  rows.push(`Essais : ${essais} par moteur (lancement à froid à chaque essai). Médianes. Options Lightpanda : ${LP_ARGS.join(' ') || '(aucune)'} ; stableTimeoutMs : ${STABLE ?? 'défaut (5000)'}.\n`);
  rows.push('| Mesure | Chrome headless | Lightpanda | Rapport |\n|---|---|---|---|');
  const line = (lbl, a, b, f = r0) => rows.push(`| ${lbl} | ${f(a)} | ${f(b)} | ${a && b ? `×${(a / b).toFixed(1)}` : '—'} |`);
  const C = res.chrome, L = res.lightpanda;
  line('Lancement (processus → CDP prêt), ms', med(C.launch), med(L.launch));
  line('Démarrage à froid (→ onglet Grasp prêt), ms', med(C.ready), med(L.ready));
  line('RSS groupe au repos, Mo', med(C.memIdle.map((m) => m.rssMo)), med(L.memIdle.map((m) => m.rssMo)));
  line('PSS groupe au repos, Mo', med(C.memIdle.map((m) => m.pssMo)), med(L.memIdle.map((m) => m.pssMo)));
  line(`RSS groupe après ${pages.length} pages, Mo`, med(C.memEnd.map((m) => m.rssMo)), med(L.memEnd.map((m) => m.rssMo)));
  line(`PSS groupe après ${pages.length} pages, Mo`, med(C.memEnd.map((m) => m.pssMo)), med(L.memEnd.map((m) => m.pssMo)));
  rows.push(`| Processus dans le groupe | ${C.memEnd[0]?.procs} | ${L.memEnd[0]?.procs} | |`);
  rows.push('\n| Page | nav Chrome ms | nav LP ms | snap Chrome ms | snap LP ms | octets snap Chrome | octets snap LP | lignes C / LP | erreurs |\n|---|---|---|---|---|---|---|---|---|');
  for (const url of pages) {
    const a = C.pages[url], b = L.pages[url];
    const u = url.replace(/127\.0\.0\.1:\d+/, 'local');
    rows.push(`| ${u} | ${r0(med(a.nav))} | ${r0(med(b.nav))} | ${r1(med(a.snap))} | ${r1(med(b.snap))} | ${r0(med(a.bytes))} | ${r0(med(b.bytes))} | ${r0(med(a.lines))} / ${r0(med(b.lines))} | ${[...new Set([...a.err.map((e) => 'C: ' + e), ...b.err.map((e) => 'LP: ' + e)])].join(' ; ').replace(/\|/g, '/') || ''} |`);
  }
  return rows.join('\n');
}

async function parallele(K, essais) {
  const site = await startTestSite();
  const rows = [`K = ${K} sessions simultanées (un navigateur par session, comme un bridge Grasp), chacune sur ${site.url.replace(/:\d+/, ':…')}/big ; ${essais} essais, médianes.\n`, '| Mesure | Chrome headless | Lightpanda | Rapport |\n|---|---|---|---|'];
  const out = {};
  for (const engine of ['chrome', 'lightpanda']) {
    const wall = [], rss = [], pss = [];
    for (let i = 0; i < essais; i++) {
      const t0 = performance.now();
      const ss = await Promise.all(Array.from({ length: K }, () => start(engine)));
      await Promise.all(ss.map(async (s) => { await s.page.navigate(`${site.url}/big`); await s.page.snapshot(); }));
      wall.push(performance.now() - t0);
      let r = 0, p = 0;
      for (const s of ss) { const m = groupMem(s.proc.pgid); r += m.rssMo; p += m.pssMo; }
      rss.push(r); pss.push(p);
      await Promise.all(ss.map((s) => s.close()));
    }
    out[engine] = { wall: med(wall), rss: med(rss), pss: med(pss) };
  }
  await site.close();
  const C = out.chrome, L = out.lightpanda;
  rows.push(`| Temps mur : ${K} lancements + nav + snapshot, ms | ${r0(C.wall)} | ${r0(L.wall)} | ×${(C.wall / L.wall).toFixed(1)} |`);
  rows.push(`| RSS totale, Mo | ${r0(C.rss)} | ${r0(L.rss)} | ×${(C.rss / L.rss).toFixed(1)} |`);
  rows.push(`| PSS totale, Mo | ${r0(C.pss)} | ${r0(L.pss)} | ×${(C.pss / L.pss).toFixed(1)} |`);
  rows.push(`| PSS par session, Mo | ${r0(C.pss / K)} | ${r0(L.pss / K)} | |`);
  return rows.join('\n');
}

if (process.argv[2] === 'parallele') {
  console.log(await parallele(Number(process.argv[3] ?? 5), Number(process.argv[4] ?? 3)));
} else {
  const essais = Number(process.argv[2] ?? 5);
  const outDir = process.argv[3];
  if (outDir) mkdirSync(outDir, { recursive: true });
  console.log(await serie(essais, outDir, process.argv.includes('--local-seulement')));
}
process.exit(0);
