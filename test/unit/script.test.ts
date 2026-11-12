import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitLine, parseScript, parseArgs, buildRequest } from '../../src/core/script.js';

test('splitLine : citation à la shell (simples, doubles, échappements), commentaires #', () => {
  assert.deepEqual(splitLine(`fill text:Nom "Ada Lovelace"`), ['fill', 'text:Nom', 'Ada Lovelace']);
  assert.deepEqual(splitLine(`check "text:J'accepte les conditions"`), ['check', "text:J'accepte les conditions"]);
  assert.deepEqual(splitLine(`fill '#email' 'a "b" c'`), ['fill', '#email', 'a "b" c']);
  assert.deepEqual(splitLine(`fill x "dit \\"oui\\" \\\\ fin"`), ['fill', 'x', 'dit "oui" \\ fin']);
  assert.deepEqual(splitLine(`fill x a\\ b`), ['fill', 'x', 'a b']);
  assert.deepEqual(splitLine(`click '#a' # commentaire "non fermé`), ['click', '#a']);
  assert.deepEqual(splitLine(`fill x "#pas un commentaire" y#z`), ['fill', 'x', '#pas un commentaire', 'y#z']);
  assert.deepEqual(splitLine(`fill x ''`), ['fill', 'x', '']);
  assert.deepEqual(splitLine(`  # tout est commentaire`), []);
  assert.deepEqual(splitLine(`#titre`), []);
  assert.deepEqual(splitLine(`click #valider`), ['click', '#valider'], 'un #id collé est un sélecteur CSS, pas un commentaire');
  assert.deepEqual(splitLine(`press Enter #q # puis soumission`), ['press', 'Enter', '#q']);
  assert.deepEqual(splitLine(`nav  http://h/?a=1&b=2\t`), ['nav', 'http://h/?a=1&b=2']);
  assert.throws(() => splitLine(`fill x "Ada`), /guillemet non fermé/);
  assert.throws(() => splitLine(`fill x 'Ada`), /guillemet non fermé/);
});

test('parseScript : numéros de ligne conservés, lignes vides et commentaires ignorés', () => {
  const s = parseScript('# titre\n\nnav http://x/\r\n  snap --max 500\n');
  assert.deepEqual(s.map((x) => [x.line, x.argv]), [[3, ['nav', 'http://x/']], [4, ['snap', '--max', '500']]]);
  assert.equal(s[1]!.text, 'snap --max 500');
  assert.throws(() => parseScript('snap\nfill x "a\n'), /ligne 2 : guillemet non fermé/);
});

test('buildRequest : même syntaxe que la CLI → requête du bridge', () => {
  const r = (line: string) => buildRequest(parseArgs(splitLine(line)));
  assert.deepEqual(r('nav http://x/ --snap-diff'), { cmd: 'nav', method: 'POST', path: '/navigate', body: { url: 'http://x/', snapDiff: true } });
  assert.deepEqual(r('click e1a2 --console --shot-on-error'), { cmd: 'click', method: 'POST', path: '/click', body: { target: 'e1a2', console: true, shotOnError: true } });
  assert.deepEqual(r('check text:CGU --uncheck'), { cmd: 'check', method: 'POST', path: '/check', body: { target: 'text:CGU', checked: false } });
  assert.deepEqual(r('press Enter #q'), { cmd: 'press', method: 'POST', path: '/press', body: { key: 'Enter', target: '#q' } });
  assert.deepEqual(r('snap --scope form --max 900'), { cmd: 'snap', method: 'GET', path: '/snap?max=900&scope=form' });
  assert.deepEqual(r('text'), { cmd: 'text', method: 'GET', path: '/text' });
  assert.deepEqual(r('wait --text "Prêt" --timeout 2000'), { cmd: 'wait', method: 'POST', path: '/wait', body: { text: 'Prêt', timeout: '2000' }, timeoutMs: 17_000 });
  assert.deepEqual(r('console --level error'), { cmd: 'console', method: 'POST', path: '/console', body: { level: 'error', limit: 50 } });
  assert.deepEqual(r('screenshot --el h1 --max-width 300'), { cmd: 'screenshot', method: 'GET', path: '/screenshot?el=h1&maxWidth=300&save=1' });
  assert.deepEqual(r('eval 1+1'), { cmd: 'eval', method: 'POST', path: '/eval', body: { expression: '1+1' } });
  assert.deepEqual(r('profile travail'), { cmd: 'profile', method: 'POST', path: 'profile', body: { name: 'travail' } });
  assert.throws(() => r('fill x'), /usage : grasp fill/);
  assert.throws(() => r('snap --max'), /--max attend une valeur/);
});

test('compileScript : options globales et options inconnues sur une ligne refusées, jamais ignorées', async () => {
  const { compileScript } = await import('../../src/control/run.js');
  const bad = (src: string, re: RegExp) => assert.throws(() => compileScript(src), (e: Error & { status?: number }) => e.status === 400 && re.test(e.message), src);
  bad('nav http://h/\nclick e3 --session autre', /ligne 2 : --session .*grasp run --session/);
  bad('snap --json', /ligne 1 : --json .*grasp run --json/);
  bad('click e3 --profile perso', /ligne 1 : --profile .*profile <nom>/);
  bad('click e3 --port 9000', /ligne 1 : --port/);
  bad('click e3 --continue', /ligne 1 : --continue/);
  bad('click e3 --snapdiff', /ligne 1 : option --snapdiff inconnue pour click .*--snap-diff/);
  bad('text --delay 3', /ligne 1 : option --delay inconnue pour text/);
  bad('screenshot -o x.png', /screenshot -o n'est pas disponible dans run/);
  // Les options propres à chaque commande restent acceptées.
  const ok = compileScript(`nav http://h/ --snap-diff --console
snap --max 100 --scope main
click e3 --snap-diff --max 9 --scope main --console --shot-on-error --engine playwright
check e4 --uncheck
type e5 abc --delay 10
wait --text Fin --timeout 3000
wait --idle
console --level warn --since 3 --limit 5 --clear
screenshot --full --refs --el e2 --format jpeg --quality 50 --max-width 800
upload e6 /tmp/x --engine playwright
profile perso`);
  assert.equal(ok.length, 11);
});

test('text --markdown : ?markdown=1 (CLI et run) ; refusé ailleurs ou avec une valeur', async () => {
  const r = (line: string) => buildRequest(parseArgs(splitLine(line)));
  assert.deepEqual(r('text --markdown'), { cmd: 'text', method: 'GET', path: '/text?markdown=1' });
  assert.deepEqual(r('text --markdown --max 500 --scope main'), { cmd: 'text', method: 'GET', path: '/text?max=500&scope=main&markdown=1' });
  assert.throws(() => r('snap --markdown'), /--markdown ne s'applique qu'à text/);
  assert.throws(() => r('text --markdown=oui'), /--markdown ne prend pas de valeur/);
  const { compileScript } = await import('../../src/control/run.js');
  assert.equal(compileScript('text --markdown --scope main').length, 1);
  assert.throws(() => compileScript('snap --markdown'), /ligne 1 : option --markdown inconnue pour snap/);
});
