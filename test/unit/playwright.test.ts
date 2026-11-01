import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrameTarget, assertPlaywrightVersion, loadPlaywright, playwrightKey, pwError, PLAYWRIGHT_HINT, PlaywrightEngine } from '../../src/bridge/playwright.js';
import { parseKey } from '../../src/bridge/keys.js';
import { GraspError } from '../../src/core/errors.js';
import { DEFAULTS, parseConfigFile, resolveConfig } from '../../src/core/config.js';
import { splitLine, parseArgs, buildRequest } from '../../src/core/script.js';

/** Moteur Playwright de repli : tout ce qui se vérifie SANS playwright-core (chemin « absent » compris). */

test('frame= : chaîne de cadres puis sélecteur dans le cadre', () => {
  assert.equal(parseFrameTarget('#valider'), null, 'sélecteur ordinaire');
  assert.equal(parseFrameTarget('text:frame=x'), null);
  assert.deepEqual(parseFrameTarget('frame=#editeur >> button'), { frames: ['#editeur'], target: 'button' });
  assert.deepEqual(parseFrameTarget('frame=iframe[title="Éditeur"]>>text:Valider'), { frames: ['iframe[title="Éditeur"]'], target: 'text:Valider' });
  assert.deepEqual(parseFrameTarget('frame=#a >> frame=#b >> #c'), { frames: ['#a', '#b'], target: '#c' });
  assert.deepEqual(parseFrameTarget('  frame=#editeur  '), { frames: ['#editeur'], target: '' }, 'cadre entier (lectures)');
  assert.deepEqual(parseFrameTarget('frame=#a >> text:x >> y'), { frames: ['#a'], target: 'text:x >> y' }, 'seuls les segments de tête sont des cadres');
  assert.throws(() => parseFrameTarget('frame= >> button'), (e: GraspError) => e.status === 400 && /sélecteur CSS de l'iframe/.test(e.message));
});

test('playwright-core absent : erreur 501 claire qui dit quoi installer', async () => {
  await assert.rejects(loadPlaywright('grasp-module-qui-nexiste-pas'), (e: GraspError) => {
    assert.equal(e.status, 501);
    assert.match(e.message, /moteur Playwright indisponible/);
    assert.match(e.message, /npm i playwright-core/);
    return true;
  });
  assert.match(PLAYWRIGHT_HINT, /aucun navigateur à télécharger/);
});

test('module chargé mais qui n\'est pas Playwright : erreur explicite, pas de plantage plus loin', async () => {
  await assert.rejects(loadPlaywright('node:path'), (e: GraspError) => e.status === 500 && /chromium\.connectOverCDP/.test(e.message));
});

test('moteur sans playwright-core : la connexion échoue avec le même 501, rien n\'est laissé ouvert', async () => {
  const eng = new PlaywrightEngine({ endpoint: 'ws://127.0.0.1:1/devtools/browser/x', targetId: 'T', module: 'grasp-module-qui-nexiste-pas', idleMs: 1000, isLocal: true });
  await assert.rejects(eng.page(), (e: GraspError) => e.status === 501 && /npm i playwright-core/.test(e.message));
  assert.equal(eng.connected, false);
  await eng.disconnect();
});

test('moteur sans URL DevTools : 501 explicite', async () => {
  const eng = new PlaywrightEngine({ endpoint: undefined, targetId: 'T', idleMs: 1000, isLocal: true });
  await assert.rejects(eng.page(), (e: GraspError) => e.status === 501 && /URL DevTools/.test(e.message));
});

test('touches Grasp → syntaxe de Playwright', () => {
  const k = (s: string) => playwrightKey(parseKey(s));
  assert.equal(k('Enter'), 'Enter');
  assert.equal(k('a'), 'a');
  assert.equal(k('Control+a'), 'Control+a');
  assert.equal(k('Shift+Tab'), 'Shift+Tab');
  assert.equal(k('Space'), 'Space');
  assert.equal(k('Ctrl+Alt+Delete'), 'Alt+Control+Delete');
  assert.equal(k('Cmd+Shift+ArrowDown'), 'Meta+Shift+ArrowDown');
  assert.equal(k('+'), '+');
});

test('erreurs de Playwright → statut HTTP et message court pour l\'agent', () => {
  const timeout = Object.assign(new Error('locator.click: Timeout 5000ms exceeded.\nCall log:\n  - waiting for locator(\'#x\')\n    - locator resolved to <button id="x">\n  - attempting click action\n    2 × waiting for element to be visible, enabled and stable\n      - element is not visible'), { name: 'TimeoutError' });
  const t = pwError(timeout, 'click');
  assert.equal(t.status, 504);
  assert.match(t.message, /^moteur Playwright : click : Timeout 5000ms exceeded\./);
  assert.match(t.message, /element is not visible/);
  assert.ok(t.message.length < 400, t.message);
  const strict = pwError(new Error("locator.click: Error: strict mode violation: locator('button') resolved to 3 elements:\n    1) <button>A</button>"), 'click');
  assert.equal(strict.status, 409);
  assert.match(strict.message, /3 éléments correspondent/);
  const closed = pwError(new Error('locator.click: Target page, context or browser has been closed'), 'click');
  assert.equal(closed.status, 502);
  const notInput = pwError(new Error('locator.fill: Error: Element is not an <input>, <textarea> or [contenteditable] element'), 'fill');
  assert.equal(notInput.status, 400);
  const same = new GraspError(403, 'interdit');
  assert.equal(pwError(same, 'x'), same, 'une GraspError passe telle quelle');
});

test('config fallbackEngine : « none » par défaut, « playwright » accepté, autre valeur refusée', () => {
  assert.equal(DEFAULTS.fallbackEngine, 'none');
  assert.equal(resolveConfig({}).fallbackEngine, 'none');
  assert.equal(resolveConfig(parseConfigFile('{"fallbackEngine":"playwright"}', 'x')).fallbackEngine, 'playwright');
  assert.throws(() => parseConfigFile('{"fallbackEngine":"puppeteer"}', 'x'), /fallbackEngine/);
});

test('CLI et run : --engine, hover, type --delay, upload --engine', () => {
  const r = (line: string) => buildRequest(parseArgs(splitLine(line)));
  assert.deepEqual(r('click text:Valider --engine playwright'), { cmd: 'click', method: 'POST', path: '/click', body: { target: 'text:Valider', engine: 'playwright' } });
  assert.deepEqual(r("fill 'frame=#editeur >> body' Bonjour"), { cmd: 'fill', method: 'POST', path: '/fill', body: { target: 'frame=#editeur >> body', value: 'Bonjour' } });
  assert.deepEqual(r('hover #menu --engine playwright --snap-diff'), { cmd: 'hover', method: 'POST', path: '/hover', body: { target: '#menu', engine: 'playwright', snapDiff: true } });
  assert.deepEqual(r('type #q lemurien --delay 50'), { cmd: 'type', method: 'POST', path: '/type', body: { target: '#q', text: 'lemurien', delay: '50' } });
  assert.deepEqual(r('upload #f /tmp/a.txt --engine playwright'), { cmd: 'upload', method: 'POST', path: '/upload', body: { target: '#f', files: ['/tmp/a.txt'], engine: 'playwright' } });
  assert.deepEqual(r("text --scope 'frame=#editeur'"), { cmd: 'text', method: 'GET', path: '/text?scope=frame%3D%23editeur' });
  assert.throws(() => r('type #q'), /usage : grasp type <sélecteur> <texte>/);
  assert.throws(() => r('hover'), /usage : grasp hover <sélecteur>/);
});

test('version minimale de playwright-core (noDefaults indispensable)', () => {
  assert.doesNotThrow(() => assertPlaywrightVersion('1.64.1'));
  assert.doesNotThrow(() => assertPlaywrightVersion('2.0.0'));
  assert.doesNotThrow(() => assertPlaywrightVersion(null));
  assert.throws(() => assertPlaywrightVersion('1.49.0'), (e: GraspError) => e.status === 501 && /trop ancien/.test(e.message));
});
