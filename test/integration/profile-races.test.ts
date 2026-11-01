import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTestEnv } from '../helpers/env.js';
import { startServer, runCli, waitExit, type Server } from '../helpers/server.js';
import { profileId } from '../../src/core/profiles.js';
import { procsOnUserDataDir, waitUntil } from '../helpers/procs.js';
import type { HttpResult } from '../../src/core/http.js';

/**
 * Courses autour d'une bascule de profil : rien ne doit tourner sur un profil sans qu'une session
 * le référence, et un profil en cours d'usage (même pendant un await) est réservé.
 */

const dirOf = (srv: Server, name: string) => join(srv.paths.profilesDir, profileId(name));

/** Lance la bascule et rend la main dès qu'elle est en cours (les requêtes proxy reçoivent alors 409). */
async function startSwitch(srv: Server, id: string, name: string): Promise<{ done: Promise<HttpResult>; settled: () => boolean }> {
  let settled = false;
  const done = srv.api('POST', `/sessions/${id}/profile`, { name }).finally(() => { settled = true; });
  let seen = false;
  const end = Date.now() + 10_000;
  while (!seen && !settled && Date.now() < end) {
    const r = await srv.api('GET', '/snap', undefined, { 'x-grasp-session': id });
    seen = r.status === 409 && /bascule de profil en cours/.test(r.text());
  }
  assert.ok(seen, 'la bascule doit être observable (409 sur les requêtes proxy pendant la bascule)');
  return { done, settled: () => settled };
}

async function setup(): Promise<{ t: ReturnType<typeof makeTestEnv>; srv: Server; id: string }> {
  const t = makeTestEnv();
  const srv = await startServer(t.env);
  await runCli(t.env, ['profiles', 'create', 'a']);
  await runCli(t.env, ['profiles', 'create', 'b']);
  const id = (await runCli(t.env, ['session', 'create', '--profile', 'a'])).stdout.trim();
  assert.match(id, /^s[0-9a-f]{12}$/);
  return { t, srv, id };
}

async function teardown(t: ReturnType<typeof makeTestEnv>, srv: Server): Promise<void> {
  srv.proc.kill('SIGTERM');
  await waitExit(srv.proc);
  t.cleanup();
}

test('bascule : les requêtes proxy et une seconde bascule reçoivent 409 pendant la bascule', async () => {
  const { t, srv, id } = await setup();
  try {
    const sw = await startSwitch(srv, id, 'b');
    const second = await srv.api('POST', `/sessions/${id}/profile`, { name: 'a' });
    assert.equal(second.status, 409, second.text());
    assert.match(second.text(), /bascule de profil déjà en cours/);
    const r = await sw.done;
    assert.equal(r.status, 200, r.text());
    assert.equal((await srv.api('GET', '/snap', undefined, { 'x-grasp-session': id })).status, 200, 'pilotable après la bascule');
  } finally { await teardown(t, srv); }
});

test('bascule : DELETE /sessions/<id> pendant l\'arrêt → la bascule échoue, aucun Chrome orphelin sur le profil cible', async () => {
  const { t, srv, id } = await setup();
  try {
    const sw = await startSwitch(srv, id, 'b');
    const del = await srv.api('DELETE', `/sessions/${id}`);
    assert.equal(del.status, 200, del.text());
    const r = await sw.done;
    assert.equal(r.status, 409, `la bascule ne doit pas réussir sur une session fermée : ${r.status} ${r.text()}`);
    assert.match(r.text(), /fermée pendant la bascule/);
    assert.deepEqual((await srv.api('GET', '/sessions')).json(), []);
    assert.ok(await waitUntil(() => procsOnUserDataDir(dirOf(srv, 'b')).length === 0, 5000), 'Chrome orphelin sur le profil b');
    assert.equal(procsOnUserDataDir(dirOf(srv, 'a')).length, 0, 'Chrome orphelin sur le profil a');
    assert.deepEqual(JSON.parse(readFileSync(srv.paths.instancesFile, 'utf8')), []);
    const again = await srv.api('POST', '/sessions', { profile: 'b' });
    assert.equal(again.status, 201, `le profil b doit être libre : ${again.text()}`);
  } finally { await teardown(t, srv); }
});

test('bascule : DELETE /sessions/<id> pendant le démarrage du nouveau navigateur → rien ne survit', async () => {
  const { t, srv, id } = await setup();
  try {
    const sw = await startSwitch(srv, id, 'b');
    // Fenêtre visée : ancien bridge arrêté, nouveau en démarrage (la session affiche déjà le profil b).
    let hit = false;
    const end = Date.now() + 10_000;
    while (!hit && !sw.settled() && Date.now() < end) {
      const s = (await srv.api('GET', '/sessions')).json() as Array<{ profile: string }>;
      hit = s[0]?.profile === 'b' && !sw.settled();
    }
    assert.ok(hit, 'fenêtre de démarrage du nouveau navigateur non observée');
    const del = await srv.api('DELETE', `/sessions/${id}`);
    assert.equal(del.status, 200, del.text());
    const r = await sw.done;
    assert.equal(r.status, 409, `${r.status} ${r.text()}`);
    assert.deepEqual((await srv.api('GET', '/sessions')).json(), []);
    assert.ok(await waitUntil(() => procsOnUserDataDir(dirOf(srv, 'b')).length === 0, 5000), 'Chrome orphelin sur le profil b');
    assert.equal((await srv.api('DELETE', '/profiles/b')).status, 200, 'profil libre une fois la session fermée');
  } finally { await teardown(t, srv); }
});

test('bascule : arrêt du control plane pendant la bascule → aucun Chrome orphelin', async () => {
  const { t, srv, id } = await setup();
  const b = dirOf(srv, 'b');
  try {
    const sw = await startSwitch(srv, id, 'b');
    const outcome = sw.done.then((r) => r.status, () => 'connexion coupée');
    srv.proc.kill('SIGTERM');
    assert.equal(await waitExit(srv.proc), 0, srv.stderr());
    assert.notEqual(await outcome, 200, 'la bascule ne doit pas réussir pendant l\'arrêt');
    assert.ok(await waitUntil(() => procsOnUserDataDir(b).length === 0 && procsOnUserDataDir(dirOf(srv, 'a')).length === 0, 5000), 'Chrome orphelin après l\'arrêt');
  } finally { await teardown(t, srv); }
});

test('bascule : le profil cible est réservé (DELETE /profiles et POST /sessions → 409 immédiat)', async () => {
  const { t, srv, id } = await setup();
  try {
    const sw = await startSwitch(srv, id, 'b');
    const rm = await srv.api('DELETE', '/profiles/b');
    assert.equal(rm.status, 409, `suppression d'un profil en cours de bascule : ${rm.text()}`);
    const cr = await srv.api('POST', '/sessions', { profile: 'b' });
    assert.equal(cr.status, 409, `création sur un profil en cours de bascule : ${cr.text()}`);
    // L'ancien profil reste réservé lui aussi : un repli doit pouvoir le rouvrir.
    const crA = await srv.api('POST', '/sessions', { profile: 'a' });
    assert.equal(crA.status, 409, `création sur le profil quitté pendant la bascule : ${crA.text()}`);
    const r = await sw.done;
    assert.equal(r.status, 200, r.text());
    assert.deepEqual((await srv.api('GET', '/sessions')).json().map((s: { id: string; profile: string }) => [s.id, s.profile]), [[id, 'b']]);
    assert.ok(existsSync(join(dirOf(srv, 'b'), 'profile.json')), 'profil b intact');
    const names = (await srv.api('GET', '/profiles')).json().profiles.map((p: { name: string }) => p.name);
    assert.deepEqual(names, ['a', 'b']);
  } finally { await teardown(t, srv); }
});

test('sessions : deux POST /sessions simultanés sur le même profil → un seul Chrome, l\'autre reçoit 409', async () => {
  const t = makeTestEnv();
  const srv = await startServer(t.env);
  try {
    const rs = await Promise.all([srv.api('POST', '/sessions', { profile: 'x' }), srv.api('POST', '/sessions', { profile: 'x' })]);
    assert.deepEqual(rs.map((r) => r.status).sort(), [201, 409], rs.map((r) => r.text()).join(' | '));
    const sessions = (await srv.api('GET', '/sessions')).json();
    assert.equal(sessions.length, 1);
    const pids = new Set(procsOnUserDataDir(dirOf(srv, 'x')).filter((p) => !readFileSync(`/proc/${p}/cmdline`, 'utf8').includes('--type=')));
    assert.equal(pids.size, 1, 'un seul navigateur sur le profil x');
  } finally { srv.proc.kill('SIGTERM'); await waitExit(srv.proc); t.cleanup(); }
});

test('bascule : le nouveau profil ne démarre pas → repli sur l\'ancien, session toujours pilotable', async () => {
  const { t, srv, id } = await setup();
  try {
    // DevToolsActivePort transformé en dossier : le lancement sur b échoue à coup sûr.
    mkdirSync(join(dirOf(srv, 'b'), 'DevToolsActivePort', 'x'), { recursive: true });
    const before = (await srv.api('GET', '/sessions')).json()[0];
    const r = await srv.api('POST', `/sessions/${id}/profile`, { name: 'b' });
    assert.equal(r.status, 502, r.text());
    assert.match(r.text(), /restée sur a/);
    const after = (await srv.api('GET', '/sessions')).json();
    assert.deepEqual(after.map((s: { id: string; profile: string }) => [s.id, s.profile]), [[id, 'a']]);
    assert.notEqual(after[0].chromePid, before.chromePid, 'ancien profil rouvert dans un nouveau Chrome');
    assert.equal((await runCli({ ...t.env, GRASP_SESSION: id }, ['snap'])).code, 0);
    assert.equal(procsOnUserDataDir(dirOf(srv, 'b')).length, 0);
  } finally { await teardown(t, srv); }
});
