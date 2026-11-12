import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TrackerList, TRACKER_LIST_PATH, parseTrackerList } from '../../src/bridge/trackers.js';
import { DEFAULTS, resolveConfig } from '../../src/core/config.js';
import { effectivePolicy } from '../../src/core/policy.js';

test('liste embarquée : liste de Peter Lowe, source et conditions citées en tête, ~3 500 domaines valides', () => {
  const text = readFileSync(TRACKER_LIST_PATH, 'utf8');
  assert.match(text, /pgl\.yoyo\.org/);
  assert.match(text, /Peter Lowe/);
  assert.match(text, /Conditions/);
  const l = TrackerList.embedded();
  assert.ok(l.domains.size > 3000, `${l.domains.size} domaines`);
  assert.ok(l.domains.has('doubleclick.net'));
  assert.ok(l.domains.has('google-analytics.com'));
  assert.equal(TrackerList.embedded(), l, 'lue une seule fois par processus');
});

test('correspondance : domaine, sous-domaines, port ; jamais un quasi-homonyme ni un domaine parent', () => {
  const l = TrackerList.from(['doubleclick.net', 'ads.exemple.org']);
  assert.equal(l.match('doubleclick.net'), 'doubleclick.net');
  assert.equal(l.match('ad.se.DoubleClick.net.'), 'doubleclick.net');
  assert.equal(l.match('xdoubleclick.net'), undefined);
  assert.equal(l.match('doubleclick.net.exemple.fr'), undefined);
  assert.equal(l.match('exemple.org'), undefined, 'le parent d\'une entrée n\'est pas bloqué');
  assert.equal(l.match('x.ads.exemple.org'), 'ads.exemple.org');
  assert.equal(l.matchUrl('https://ad.doubleclick.net:8443/pixel.gif?u=1'), 'doubleclick.net');
  assert.equal(l.matchUrl('https://site.fr/redir?to=https://doubleclick.net/'), undefined, 'seul l\'hôte compte, pas le chemin');
  assert.equal(l.matchUrl('data:text/plain,doubleclick.net'), undefined);
  assert.equal(l.matchUrl('pas une url'), undefined);
});

test('motifs Fetch : un par domaine, port et sous-domaines couverts par le préfiltre', () => {
  const p = TrackerList.from(['doubleclick.net']).fetchPatterns();
  assert.deepEqual(p, [{ urlPattern: '*://*doubleclick.net?*', requestStage: 'Request' }]);
});

test('lignes invalides refusées, commentaires et lignes vides ignorés', () => {
  assert.deepEqual([...parseTrackerList('# titre\n\nA.com\nb.c.org\n')], ['a.com', 'b.c.org']);
  assert.throws(() => parseTrackerList('a.com\n127.0.0.1 b.com\n'), /ligne invalide/);
  assert.throws(() => parseTrackerList('localhost\n'), /ligne invalide/);
});

test('blockTrackers : activé par défaut, absent ≠ désactivé, transmis à la politique gelée', () => {
  assert.equal(DEFAULTS.blockTrackers, true);
  assert.equal(resolveConfig({ allowConsole: false }).blockTrackers, true);
  assert.equal(resolveConfig({ blockTrackers: false }).blockTrackers, false);
  assert.equal(effectivePolicy(resolveConfig({})).blockTrackers, true);
  assert.equal(effectivePolicy(resolveConfig({ blockTrackers: false })).blockTrackers, false);
});
