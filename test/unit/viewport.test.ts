import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICES, describeViewport, mobileUserAgent, parseSize, renderViewport, viewportSpecOf } from '../../src/core/viewport.js';
import { buildRequest, checkRunFlags, parseArgs, ScriptError } from '../../src/core/script.js';
import { sessionOptionsOf } from '../../src/control/server.js';
import { effectivePolicy } from '../../src/core/policy.js';
import { resolveConfig } from '../../src/core/config.js';

const status400 = (e: Error & { status?: number }) => e.status === 400;

test('parseSize : LARGEURxHAUTEUR (x, X, ×), sinon undefined', () => {
  assert.deepEqual(parseSize('360x800'), { width: 360, height: 800 });
  assert.deepEqual(parseSize(' 1024X768 '), { width: 1024, height: 768 });
  assert.deepEqual(parseSize('390×844'), { width: 390, height: 844 });
  for (const s of ['360', '360x', 'x800', '360x800x2', '-360x800', '36.5x800', 'iphone-se']) assert.equal(parseSize(s), undefined, s);
});

test('viewportSpecOf : taille seule = ni mobile ni tactile, densité du navigateur (0) ; appareil = ses valeurs, surchargeables', () => {
  assert.deepEqual(viewportSpecOf({ size: '360x800' }), { width: 360, height: 800, dpr: 0, mobile: false, touch: false, mobileUa: false });
  assert.deepEqual(viewportSpecOf({ width: 360, height: 800, mobile: true, dpr: '3', touch: true }), { width: 360, height: 800, dpr: 3, mobile: true, touch: true, mobileUa: false });
  assert.deepEqual(viewportSpecOf({ device: 'iPhone-SE' }), { width: 375, height: 667, dpr: 2, mobile: true, touch: true, mobileUa: false, device: 'iphone-se' });
  // Champs explicites prioritaires sur l'appareil ; le user agent n'est jamais implicite.
  assert.deepEqual(viewportSpecOf({ device: 'pixel-7', size: '412x800', dpr: 1, mobileUa: true }), { width: 412, height: 800, dpr: 1, mobile: true, touch: true, mobileUa: true, device: 'pixel-7' });
  for (const d of Object.values(DEVICES)) assert.equal(viewportSpecOf({ size: `${d.width}x${d.height}` }).width, d.width);
});

test('viewportSpecOf : tout ce qui est invalide est refusé (400), jamais ignoré', () => {
  for (const bad of [
    null, 'x', [], {}, { size: 360 }, { size: '360x' }, { size: '49x800' }, { size: '360x10001' },
    { width: 360 }, { size: '360x800', width: 360, height: 800 }, { width: '3a', height: 800 },
    { device: 'nokia' }, { device: 3 }, { size: '360x800', dpr: 0 }, { size: '360x800', dpr: 0.4 }, { size: '360x800', dpr: 5.5 },
    { size: '360x800', dpr: 'abc' }, { size: '360x800', mobile: 'oui' }, { size: '360x800', zoom: 2 }, { size: '360x800', reset: true },
  ]) assert.throws(() => viewportSpecOf(bad), status400, JSON.stringify(bad));
});

test('describeViewport, renderViewport, mobileUserAgent', () => {
  assert.equal(describeViewport(viewportSpecOf({ device: 'galaxy-s8', mobileUa: true })), '360x740, dpr 4, mobile, tactile, UA mobile (galaxy-s8)');
  assert.equal(renderViewport({ viewport: null, measured: { width: 780, height: 600, dpr: 1, touchPoints: 0, pointer: 'fine', mobileUa: false } }), 'viewport du navigateur (aucune émulation) — page : 780x600, dpr 1, 0 point(s) tactile(s), pointeur fine');
  assert.equal(renderViewport({ viewport: viewportSpecOf({ size: '360x800' }) }), '360x800 — page : mesure impossible');
  const ua = mobileUserAgent('HeadlessChrome/150.0.7800.10');
  assert.equal(ua.major, '150');
  assert.match(ua.userAgent, /^Mozilla\/5\.0 \(Linux; Android 10; K\) .* Chrome\/150\.0\.0\.0 Mobile Safari\/537\.36$/);
  assert.doesNotMatch(ua.userAgent, /Headless/);
});

test('syntaxe : viewport (lecture), reset, taille ou appareil et options ; run refuse une option inconnue', () => {
  const rq = (line: string[]) => buildRequest(parseArgs(['viewport', ...line]));
  assert.deepEqual(rq([]), { cmd: 'viewport', method: 'GET', path: '/viewport' });
  assert.deepEqual(rq(['reset']).body, { reset: true });
  assert.deepEqual(rq(['360x800', '--mobile', '--dpr', '3', '--touch', '--mobile-ua']).body, { size: '360x800', dpr: '3', mobile: true, touch: true, mobileUa: true });
  assert.deepEqual(rq(['iphone-se']).body, { device: 'iphone-se' });
  assert.deepEqual(rq(['--device', 'pixel-7', '--dpr', '1']).body, { device: 'pixel-7', dpr: '1' });
  assert.deepEqual(rq(['390x844', '--device', 'iphone-14']).body, { size: '390x844', device: 'iphone-14' });
  for (const bad of [['reset', '--touch'], ['--mobile'], ['360x800', '400x800'], ['ipad', '--device', 'iphone-se'], ['360,800'], ['360x800', '--mobile=oui']]) {
    assert.throws(() => rq(bad), ScriptError, bad.join(' '));
  }
  const a = parseArgs(['viewport', '360x800', '--zoom']);
  assert.throws(() => checkRunFlags(a), /option --zoom inconnue pour viewport/);
  assert.doesNotThrow(() => checkRunFlags(parseArgs(['viewport', '360x800', '--mobile', '--touch', '--dpr', '2', '--mobile-ua', '--device', 'pixel-7'])));
});

test('session create : viewport validé par le control plane avant tout lancement (mode attach compris : onglet de Grasp seulement)', () => {
  const policy = effectivePolicy(resolveConfig({}));
  assert.deepEqual(sessionOptionsOf({ viewport: { size: '360x800', touch: true } }, policy, false).viewport, { width: 360, height: 800, dpr: 0, mobile: false, touch: true, mobileUa: false });
  assert.equal(sessionOptionsOf({ viewport: { device: 'ipad-mini' } }, policy, true).viewport?.width, 768);
  assert.equal(sessionOptionsOf({}, policy, false).viewport, undefined);
  assert.throws(() => sessionOptionsOf({ viewport: { size: '1x1' } }, policy, false), status400);
});
