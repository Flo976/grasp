import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WK_REF_RE, diffAria, matchText, parseAria, renderAria } from '../../src/bridge/webkit-snapshot.js';
import { contextOptionsOf, explainLaunchError } from '../../src/bridge/webkit.js';
import { viewportSpecOf } from '../../src/core/viewport.js';

const YAML = `- generic [active] [ref=e1]:
  - banner [ref=e2]:
    - heading "Boutique" [level=1] [ref=e3]
  - main [ref=e4]:
    - paragraph [ref=e5]: Bienvenue chez nous
    - textbox "Nom" [ref=e6]: Camille
    - checkbox "J'accepte" [checked] [ref=e7]
    - button "Valider" [disabled] [ref=e8]
    - 'link "Aide: FAQ" [ref=e9]':
      - /url: /aide
    - text: Total 12 €
    - iframe [ref=e10]:
      - generic [ref=f1e1]:
        - button "Payer" [ref=f1e2] [cursor=pointer]`;

test('parseAria / renderAria : YAML de Playwright → lignes « ref:rôle "nom"=valeur [états] », conteneurs anonymes traversés', () => {
  const tree = parseAria(YAML);
  assert.equal(tree.length, 1);
  assert.equal(tree[0]!.role, 'generic');
  assert.equal(renderAria(YAML), [
    'e2:banner',
    '  e3:heading[1] "Boutique"',
    'e4:main',
    '  e5:paragraph "Bienvenue chez nous"',
    '  e6:textbox "Nom"="Camille"',
    '  e7:checkbox "J\'accepte" [x]',
    '  e8:button "Valider" [disabled]',
    '  e9:link "Aide: FAQ"',
    '  text "Total 12 €"',
    '  e10:iframe',
    '    f1e2:button "Payer"',
  ].join('\n'));
  // Propriétés (/url) jamais émises ; nom coupé à --name-max.
  assert.doesNotMatch(renderAria(YAML), /\/aide|cursor/);
  assert.match(renderAria(YAML, { nameMax: 5 }), /e3:heading\[1\] "Bout…"/);
});

test('renderAria : --interactive (contrôles et leurs conteneurs), --outline (repères et titres), find, --boxes', () => {
  assert.equal(renderAria(YAML, { mode: 'interactive' }), ['e4:main', '  e6:textbox "Nom"="Camille"', '  e7:checkbox "J\'accepte" [x]', '  e8:button "Valider" [disabled]', '  e9:link "Aide: FAQ"', '  e10:iframe', '    f1e2:button "Payer"'].join('\n'));
  assert.equal(renderAria(YAML, { mode: 'outline' }), ['e2:banner', '  e3:heading[1] "Boutique"', 'e4:main', '  e10:iframe'].join('\n'));
  assert.equal(renderAria(YAML, { find: { test: (s) => /Payer|Valider/.test(s) } }), ['e4:main', '  e8:button "Valider" [disabled]', '  e10:iframe', '    f1e2:button "Payer"'].join('\n'));
  assert.equal(renderAria(YAML, { find: { test: () => true, roles: ['button'], limit: 1 } }), ['e4:main', '  e8:button "Valider" [disabled]'].join('\n'));
  const boxed = renderAria('- button "OK" [ref=e3] [box=8,86.4,68,31]\n- iframe [ref=e4]:\n  - button "X" [ref=f1e2] [box=1,2,3,4]', { boxes: true, scroll: { x: 0, y: 100 } });
  assert.equal(boxed, 'e3:button "OK" @8,186 68x31\ne4:iframe\n  f1e2:button "X" @1,102 3x4');
});

test('diffAria : + apparu, - disparu, ~ modifié (même ref), texte sans ref en multi-ensemble', () => {
  const a = 'e3:button "Valider"\ne4:textbox "Nom"=""\ntext "Total 12 €"\ne9:link "Aide"';
  const b = 'e7:button "Fait"\ne4:textbox "Nom"="Camille"\ntext "Total 15 €"\ne9:link "Aide"';
  assert.equal(diffAria(a, b), ['- e3:button "Valider"', '- text "Total 12 €"', '+ e7:button "Fait"', '~ e4:textbox "Nom"="Camille"', '+ text "Total 15 €"'].join('\n'));
  assert.equal(diffAria(a, a), '(aucun changement)');
});

test('matchText : paliers du moteur Chrome (contrôle au nom égal, nom égal, sans casse, contenu) ; ambigu = candidats, jamais un choix', () => {
  assert.equal(matchText(YAML, 'Valider').ref, 'e8');
  assert.equal(matchText(YAML, 'boutique').ref, 'e3');
  assert.equal(matchText(YAML, 'aide').ref, 'e9');
  const amb = matchText('- button "Supprimer" [ref=e1]\n- button "Supprimer" [ref=e2]', 'Supprimer');
  assert.equal(amb.ref, undefined);
  assert.deepEqual(amb.candidates.map((c) => c.ref), ['e1', 'e2']);
  assert.deepEqual(matchText(YAML, 'inexistant'), { candidates: [] });
});

test('WK_REF_RE : e12, f1e3 ; pas les refs à hash du moteur Chrome', () => {
  for (const ok of ['e1', 'e12345', 'f1e3', 'f12e7']) assert.ok(WK_REF_RE.test(ok), ok);
  for (const ko of ['e5k2', 'f1', 'x3', '#e1', 'e']) assert.ok(!WK_REF_RE.test(ko), ko);
});

test('explainLaunchError : les deux causes diagnostiquées (build d\'une autre révision, bibliothèques système) deviennent une commande', () => {
  assert.match(explainLaunchError('browserType.launch: Executable doesn\'t exist at /home/x/.cache/ms-playwright/webkit-2370/pw_run.sh', '1.64.1'), /WebKit n'est pas installé pour playwright-core 1\.64\.1 .*npx playwright-core install webkit/);
  const libs = explainLaunchError('Host system is missing dependencies to run browsers.\n║ Missing libraries:\n║     libevent-2.1.so.7\n║     libmanette-0.2.so.0', '1.64.1');
  assert.match(libs, /bibliothèques système manquantes \(libevent-2\.1\.so\.7, libmanette-0\.2\.so\.0\) — sudo npx playwright-core install-deps webkit ; Ubuntu récent : sudo apt-get install libevent-2\.1-7t64 libmanette-0\.2-0 libhidapi-hidraw0/);
  assert.match(explainLaunchError('MiniBrowser: error while loading shared libraries: libhidapi-hidraw.so.0: cannot open shared object file', null), /manquantes \(libhidapi-hidraw\.so\.0\)/);
  assert.match(explainLaunchError('autre chose', null), /^WebKit ne démarre pas : autre chose/);
});

test('contextOptionsOf : iphone-14 → viewport, densité, tactile et user agent Safari d\'iPhone ; téléchargements et service workers toujours coupés', () => {
  const devices = { 'iPhone 14': { userAgent: 'UA-iPhone-14', defaultBrowserType: 'webkit' }, 'iPhone SE': { userAgent: 'UA-iPhone-SE', defaultBrowserType: 'webkit' }, 'Pixel 7': { userAgent: 'UA-Android', defaultBrowserType: 'chromium' } };
  assert.deepEqual(contextOptionsOf(undefined, devices), { acceptDownloads: false, serviceWorkers: 'block' });
  assert.deepEqual(contextOptionsOf(viewportSpecOf({ device: 'iphone-14' }), devices), { acceptDownloads: false, serviceWorkers: 'block', viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: 'UA-iPhone-14' });
  assert.equal(contextOptionsOf(viewportSpecOf({ device: 'iphone-se' }), devices).userAgent, 'UA-iPhone-SE');
  // Appareil Android : WebKit reste Safari — user agent d'iPhone, jamais celui d'un Chrome.
  assert.equal(contextOptionsOf(viewportSpecOf({ device: 'pixel-7' }), devices).userAgent, 'UA-iPhone-14');
  const desk = contextOptionsOf(viewportSpecOf({ size: '1280x800' }), devices);
  assert.equal(desk.userAgent, undefined);
  assert.equal(desk.deviceScaleFactor, 1);
});
