import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { makeTestEnv } from '../helpers/env.js';
import { startServer, runCli, waitExit, type Server } from '../helpers/server.js';
import { startTestSite } from '../helpers/testsite.js';
import { resolvePaths } from '../../src/core/paths.js';
import { aliveInGroup, isAlive } from '../helpers/procs.js';
import { linuxGroupMemory } from '../../src/browser/memory.js';

function writeConfig(env: NodeJS.ProcessEnv, cfg: object): void {
  const paths = resolvePaths(env, env.HOME);
  mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
  writeFileSync(paths.configFile, JSON.stringify(cfg), { mode: 0o600 });
}

interface SessionRow { id: string; profile: string | null; chromePid: number; bridgePid: number; userDataDir: string; recycles: number; browserStartedAt: string; memoryMb?: number; memoryMetric?: string }
const sessions = async (srv: Server): Promise<SessionRow[]> => (await srv.api('GET', '/sessions')).json() as SessionRow[];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('parallélisme (existant) : N sessions = N bridges = N Chrome, créées et pilotées en même temps sans se mélanger', async () => {
  const N = 4;
  const t = makeTestEnv();
  const site = await startTestSite();
  const srv = await startServer(t.env);
  try {
    const created = await Promise.all(Array.from({ length: N }, () => srv.api('POST', '/sessions', {})));
    assert.deepEqual(created.map((r) => r.status), Array(N).fill(201));
    const ids = created.map((r) => (r.json() as { id: string }).id);
    const rows = await sessions(srv);
    assert.equal(new Set(rows.map((s) => s.chromePid)).size, N, 'un Chrome par session');
    assert.equal(new Set(rows.map((s) => s.bridgePid)).size, N, 'un bridge par session');
    assert.equal(new Set(rows.map((s) => s.userDataDir)).size, N, 'un --user-data-dir par session');
    for (const s of rows) assert.ok(aliveInGroup(s.chromePid).length > 1, 'chaque Chrome est son propre groupe de processus');

    // Navigation et lecture simultanées : chaque session voit SA page.
    const navs = await Promise.all(ids.map((id, i) => srv.api('POST', '/navigate', { url: `${site.url}/submit?nom=S${i}` }, { 'x-grasp-session': id })));
    assert.deepEqual(navs.map((r) => r.status), Array(N).fill(200));
    const texts = await Promise.all(ids.map((id) => srv.api('GET', '/text', undefined, { 'x-grasp-session': id })));
    texts.forEach((r, i) => assert.match(r.text(), new RegExp(`Nom : S${i}\\n`), `session ${i}`));

    // Scripts `grasp run` simultanés par la CLI, un par session.
    const runs = await Promise.all(ids.map((id, i) => runCli({ ...t.env, GRASP_SESSION: id }, ['run', '-'], `nav ${site.url}/submit?nom=R${i}\ntext\n`)));
    runs.forEach((r, i) => {
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, new RegExp(`Nom : R${i}\\n`));
      for (let j = 0; j < N; j++) if (j !== i) assert.doesNotMatch(r.stdout, new RegExp(`Nom : R${j}\\n`));
    });
    // Sans seuil configuré, rien n'est recyclé ni mesuré.
    assert.ok((await sessions(srv)).every((s) => s.recycles === 0 && s.memoryMb === undefined));
  } finally { srv.proc.kill('SIGTERM'); await waitExit(srv.proc); await site.close(); t.cleanup(); }
});

test('recyclage mémoire (seuil 1 Mo) : relance entre deux commandes, même id, même profil, cookies et page conservés, note visible', async () => {
  const t = makeTestEnv();
  const site = await startTestSite();
  writeConfig(t.env, { browserMaxRssMb: 1, allowEval: true, allowedDomains: ['127.0.0.1'] });
  const srv = await startServer(t.env);
  try {
    assert.match(srv.stderr(), /recyclage des navigateurs au-delà de 1 Mo \(PSS du groupe Chrome\), entre deux commandes/);
    const id = (await runCli(t.env, ['session', 'create', '--profile', 'recy'])).stdout.trim();
    const env = { ...t.env, GRASP_SESSION: id };
    const s0 = (await sessions(srv))[0]!;
    // La mesure elle-même : PSS de tout le groupe, bien au-delà de 1 Mo.
    const m = linuxGroupMemory(s0.chromePid);
    assert.ok(m !== null && m.procs > 1 && m.mb > 1, JSON.stringify(m));

    // 1re commande : le navigateur (au repos) est recyclé AVANT, la page était vide.
    const nav = await runCli(env, ['nav', `${site.url}/submit?nom=Ada`]);
    assert.equal(nav.code, 0, nav.stderr);
    assert.match(nav.stderr, /^note: navigateur recyclé : \d+ Mo > 1 Mo ; page vide, rien à recharger$/m);
    const s1 = (await sessions(srv))[0]!;
    assert.deepEqual([s1.id, s1.profile, s1.userDataDir, s1.recycles], [id, 'recy', s0.userDataDir, 1], 'même id, même profil');
    assert.notEqual(s1.chromePid, s0.chromePid);
    assert.ok(!isAlive(s0.chromePid), 'ancien Chrome arrêté');
    assert.equal(s1.memoryMetric, undefined, 'mesure remise à zéro après relance');

    // Cookie de session (sans expiration) et cookie persistant posés sur ce navigateur…
    const ev = await runCli(env, ['eval', "document.cookie = 'tmp=session'; document.cookie = 'dur=disque; max-age=3600'; document.cookie"]);
    assert.equal(ev.code, 0, ev.stderr);
    assert.match(ev.stderr, /note: navigateur recyclé : .*page rechargée sur http:\/\/127\.0\.0\.1:\d+\/submit\?nom=Ada/);
    // … la commande suivante passe par un recyclage : page rechargée, cookies reportés (session) ou relus du profil (persistant).
    const txt = await runCli(env, ['text']);
    assert.equal(txt.code, 0, txt.stderr);
    assert.match(txt.stderr, /^note: navigateur recyclé : \d+ Mo > 1 Mo ; 1 cookie\(s\) de session reporté\(s\) ; page rechargée sur http:\/\/127\.0\.0\.1:\d+\/submit\?nom=Ada$/m);
    assert.match(txt.stdout, /Nom : Ada\n/, 'la page courante est rechargée');
    const ck = await runCli(env, ['eval', 'document.cookie.split("; ").sort().join("; ")']);
    assert.equal(JSON.parse(ck.stdout), 'dur=disque; tmp=session');

    // grasp run : la note arrive dans les notes de l'étape concernée.
    const run = await runCli(env, ['run', '--json', '-'], 'text\nsnap\n');
    const r = JSON.parse(run.stdout) as { ok: boolean; steps: Array<{ detail?: string; ok: boolean }> };
    assert.equal(r.ok, true, run.stdout);
    for (const st of r.steps) assert.match(st.detail ?? '', /^navigateur recyclé : \d+ Mo > 1 Mo ; .*page rechargée/);
    const s2 = (await sessions(srv))[0]!;
    assert.equal(s2.id, id);
    assert.ok(s2.recycles >= 5, `recyclages : ${s2.recycles}`);
    assert.match(srv.stderr(), /AVERTISSEMENT : session .* juste après la relance, déjà au-delà de browserMaxRssMb=1/);
  } finally { srv.proc.kill('SIGTERM'); await waitExit(srv.proc); await site.close(); t.cleanup(); }
});

test('recyclage par âge : jamais pendant une commande (une autre en vol bloque la relance), puis à la suivante', async () => {
  const t = makeTestEnv();
  const site = await startTestSite();
  writeConfig(t.env, { browserMaxAgeMin: 0.02, allowedDomains: ['127.0.0.1'] }); // 1,2 s
  const srv = await startServer(t.env);
  try {
    const id = (await runCli(t.env, ['session', 'create'])).stdout.trim();
    const env = { ...t.env, GRASP_SESSION: id };
    assert.equal((await runCli(env, ['nav', `${site.url}/submit?nom=Lin`])).code, 0);
    const before = (await sessions(srv))[0]!;
    // Une commande longue en vol (wait qui échouera en 504 après 3 s)…
    const long = runCli(env, ['wait', '--text', 'jamais présent', '--timeout', '3000']);
    await sleep(1800); // l'âge dépasse 1,2 s pendant le wait
    // … une autre commande arrive : la session n'est pas au repos, pas de relance.
    const during = await runCli(env, ['text']);
    assert.equal(during.code, 0, during.stderr);
    assert.doesNotMatch(during.stderr, /recyclé/);
    assert.equal((await sessions(srv))[0]!.chromePid, before.chromePid, 'pas de relance pendant le wait');
    const w = await long;
    assert.notEqual(w.code, 0);
    assert.match(w.stderr, /^ERROR: wait: /m, 'le wait va à son terme sur le même navigateur');
    assert.doesNotMatch(w.stderr, /recyclé/);
    assert.equal((await sessions(srv))[0]!.chromePid, before.chromePid);

    // Commande suivante, session au repos : relance, même id, profil éphémère conservé, page rechargée.
    const after = await runCli(env, ['text']);
    assert.equal(after.code, 0, after.stderr);
    assert.match(after.stderr, /^note: navigateur recyclé : âge \d+ s > 1 s ; page rechargée sur http:\/\/127\.0\.0\.1:\d+\/submit\?nom=Lin$/m);
    assert.match(after.stdout, /Nom : Lin\n/);
    const s = (await sessions(srv))[0]!;
    assert.deepEqual([s.id, s.userDataDir, s.recycles], [id, before.userDataDir, 1]);
    assert.notEqual(s.chromePid, before.chromePid);
    // Juste après : âge < seuil, pas de nouvelle relance.
    const again = await runCli(env, ['text']);
    assert.doesNotMatch(again.stderr, /recyclé/);
  } finally { srv.proc.kill('SIGTERM'); await waitExit(srv.proc); await site.close(); t.cleanup(); }
});

test('recyclage : des commandes simultanées attendent la relance (pas de 409) et une seule relance a lieu', async () => {
  const t = makeTestEnv();
  const site = await startTestSite();
  writeConfig(t.env, { browserMaxAgeMin: 0.01, allowedDomains: ['127.0.0.1'] }); // 0,6 s
  const srv = await startServer(t.env);
  try {
    const id = (await runCli(t.env, ['session', 'create'])).stdout.trim();
    const h = { 'x-grasp-session': id };
    await srv.api('POST', '/navigate', { url: `${site.url}/submit?nom=Duo` }, h);
    await sleep(900);
    const rs = await Promise.all([srv.api('GET', '/text', undefined, h), srv.api('GET', '/location', undefined, h), srv.api('GET', '/snap', undefined, h)]);
    assert.deepEqual(rs.map((r) => r.status), [200, 200, 200], rs.map((r) => r.text()).join('\n'));
    const notes = rs.map((r) => r.headers['x-grasp-notice']).filter((n) => n !== undefined);
    assert.equal(notes.length, 1, 'la note est donnée une fois');
    assert.match(decodeURIComponent(String(notes[0])), /^navigateur recyclé : âge/);
    assert.match(rs[0]!.text(), /Nom : Duo/);
    assert.equal((await sessions(srv))[0]!.recycles, 1, 'une seule relance');
  } finally { srv.proc.kill('SIGTERM'); await waitExit(srv.proc); await site.close(); t.cleanup(); }
});

test('maxSessions : 503 explicite au-delà du plafond, créations simultanées comprises', async () => {
  const t = makeTestEnv();
  writeConfig(t.env, { maxSessions: 2 });
  const srv = await startServer(t.env);
  try {
    const rs = await Promise.all([1, 2, 3].map(() => srv.api('POST', '/sessions', {})));
    assert.deepEqual(rs.map((r) => r.status).sort(), [201, 201, 503]);
    const refused = rs.find((r) => r.status === 503)!;
    assert.match(String(refused.json().error), /plafond de 2 session\(s\) atteint .*maxSessions.*grasp session close/);
    const cli = await runCli(t.env, ['session', 'create']);
    assert.notEqual(cli.code, 0);
    assert.match(cli.stderr, /^ERROR: session: plafond de 2 session\(s\) atteint \(2 ouverte\(s\), maxSessions\)/m);
    const first = (rs.find((r) => r.status === 201)!.json() as { id: string }).id;
    assert.equal((await runCli(t.env, ['session', 'close', first])).code, 0);
    assert.equal((await runCli(t.env, ['session', 'create'])).code, 0, 'une place libérée');
  } finally { srv.proc.kill('SIGTERM'); await waitExit(srv.proc); t.cleanup(); }
});
