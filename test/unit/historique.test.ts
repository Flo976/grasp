import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitLine, parseArgs, buildRequest } from '../../src/core/script.js';
import { scrollNote, scrollSpecOf } from '../../src/bridge/scroll.js';
import { GraspError } from '../../src/core/errors.js';

const r = (line: string) => buildRequest(parseArgs(splitLine(line)));

test('back / forward / reload : requêtes du bridge, options d\'action, arguments refusés', () => {
  assert.deepEqual(r('back'), { cmd: 'back', method: 'POST', path: '/back', body: {} });
  assert.deepEqual(r('forward --snap-diff --max 900 --scope main --console --shot-on-error'), {
    cmd: 'forward', method: 'POST', path: '/forward', body: { snapDiff: true, max: '900', scope: 'main', console: true, shotOnError: true },
  });
  assert.deepEqual(r('reload'), { cmd: 'reload', method: 'POST', path: '/reload', body: {} });
  assert.deepEqual(r('reload --hard --snap-diff'), { cmd: 'reload', method: 'POST', path: '/reload', body: { snapDiff: true, hard: true } });
  assert.throws(() => r('back http://x/'), /usage : grasp back .*en trop/);
  assert.throws(() => r('reload --hard=oui'), /--hard ne prend pas de valeur/);
  assert.throws(() => r('back --engine playwright'), /--engine ne s'applique pas à back/);
});

test('scroll : sélecteur facultatif, --by (négatif compris), --to, --until-stable, --max-steps', () => {
  assert.deepEqual(r('scroll'), { cmd: 'scroll', method: 'POST', path: '/scroll', body: {} });
  assert.deepEqual(r('scroll --by -500'), { cmd: 'scroll', method: 'POST', path: '/scroll', body: { by: '-500' } });
  assert.deepEqual(r('scroll #liste --to bottom'), { cmd: 'scroll', method: 'POST', path: '/scroll', body: { target: '#liste', to: 'bottom' } });
  assert.deepEqual(r('scroll --until-stable --max-steps 5 --snap-diff'), { cmd: 'scroll', method: 'POST', path: '/scroll', body: { snapDiff: true, untilStable: true, maxSteps: '5' }, timeoutMs: 120_000 });
  assert.throws(() => r('scroll a b'), /usage : grasp scroll/);
  assert.throws(() => r('scroll --by'), /--by attend une valeur/);
  assert.throws(() => r('scroll --until-stable=1'), /--until-stable ne prend pas de valeur/);
});

test('grasp run : back forward reload scroll acceptés avec leurs options, --engine et options étrangères refusés', async () => {
  const { compileScript } = await import('../../src/control/run.js');
  const ok = compileScript(`back --snap-diff
forward --console
reload --hard --shot-on-error
scroll '#zone' --until-stable --max-steps 3 --snap-diff --max 2000
scroll --to top`);
  assert.equal(ok.length, 5);
  const bad = (src: string, re: RegExp) => assert.throws(() => compileScript(src), (e: Error & { status?: number }) => e.status === 400 && re.test(e.message), src);
  bad('back --engine playwright', /ligne 1 : option --engine inconnue pour back/);
  bad('reload --delay 3', /option --delay inconnue pour reload/);
  bad('back --hard', /option --hard inconnue pour back/);
  bad('scroll --session x', /--session n'a pas de sens sur une ligne de run/);
});

test('scrollSpecOf : validation stricte (jamais une option ignorée)', () => {
  const bad = (b: Record<string, unknown>, re: RegExp) => assert.throws(() => scrollSpecOf(b), (e: GraspError) => e.status === 400 && re.test(e.message), JSON.stringify(b));
  assert.deepEqual(scrollSpecOf({}), {});
  assert.deepEqual(scrollSpecOf({ by: '-300' }), { by: -300 });
  assert.deepEqual(scrollSpecOf({ to: 'bottom', untilStable: true, maxSteps: '4' }), { to: 'bottom', untilStable: true, maxSteps: 4 });
  bad({ by: 'abc' }, /« by » : entier non nul/);
  bad({ by: '0' }, /« by » : entier non nul/);
  bad({ by: '1.5' }, /« by »/);
  bad({ to: 'milieu' }, /« to » : top ou bottom/);
  bad({ by: '10', to: 'top' }, /--by et --to s'excluent/);
  bad({ maxSteps: '3' }, /--max-steps n'a de sens qu'avec --until-stable/);
  bad({ untilStable: true, maxSteps: '0' }, /1 à 50/);
  bad({ untilStable: true, maxSteps: '51' }, /1 à 50/);
  bad({ untilStable: true, to: 'top' }, /pas --to top/);
  bad({ untilStable: 'oui' }, /booléen/);
});

test('scrollNote : une ligne qui dit la position, les pas, les nœuds apparus et pourquoi on s\'arrête', () => {
  assert.equal(scrollNote({ how: 'page', from: 0, to: 4820, max: 4820, height: 5600, added: 80, steps: 5, settled: true }, 10),
    'défilement (page) : 0 → 4 820 px sur 4 820 (bas atteint), 5 pas, 80 nœud(s) apparu(s), plus rien n\'apparaît');
  assert.match(scrollNote({ how: 'element', from: 0, to: 300, max: 900, height: 1200, added: 40, steps: 2, settled: false, stoppedBy: 'steps' }, 2),
    /zone.*2 pas, 40 nœud\(s\) apparu\(s\), plafond de 2 pas atteint : du contenu peut encore apparaître/);
  assert.equal(scrollNote({ how: 'page', from: 0, to: 540, max: 2400, height: 3000, added: 0, steps: 1 }, 10), 'défilement (page) : 0 → 540 px sur 2 400, 0 nœud(s) apparu(s)');
  assert.match(scrollNote({ how: 'page', from: 0, to: 0, max: 0, height: 0, added: null, steps: 1 }, 10), /non mesuré/);
});
