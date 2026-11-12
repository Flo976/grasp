import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileScript, runScript } from '../../src/control/run.js';
import { GraspError } from '../../src/core/errors.js';
import { MAX_RUN_SHOT_FILES } from '../../src/core/script.js';
import type { StepRequest } from '../../src/core/script.js';

/**
 * Exécuteur factice : `expect` du script échoue toujours (417), `click` aussi (404), les captures réussissent.
 * Le contrôle no-form-errors du rapport passe ; console et location répondent le minimum.
 */
function fakeExec(log: StepRequest[]) {
  return async (rq: StepRequest): Promise<unknown> => {
    log.push(rq);
    if (rq.cmd === 'console') return { seq: 0, entries: [], omitted: 0 };
    if (rq.cmd === 'location') return { url: 'about:blank', title: '' };
    if (rq.cmd === 'screenshot') return rq.saveAs !== undefined ? { data: 'iVBORw0KGgo=' } : { path: `/tmp/grasp-${log.length}.png` };
    if (rq.cmd === 'expect' && (rq.body as { kind?: string } | undefined)?.kind === 'no-form-errors') return {};
    if (rq.cmd === 'click') throw new GraspError(404, 'élément introuvable');
    throw new GraspError(417, 'attendu non vérifié');
  };
}

const sept = Array.from({ length: 7 }, () => 'expect text "zzz" --timeout 0').join('\n');

for (const clientShots of [false, true]) {
  test(`run --continue${clientShots ? ' --out-dir' : ''} : au-delà de 5 captures de rapport, note « capture omise » sur chaque étape sans capture`, async () => {
    const log: StepRequest[] = [];
    const r = await runScript(compileScript(sept, { files: true }), fakeExec(log), true, undefined, { clientShots });
    assert.equal(r.steps.length, 7);
    for (const s of r.steps.slice(0, 5)) {
      assert.ok(s.screenshot !== undefined, `étape ${s.n} capturée`);
      assert.equal(s.detail, undefined);
    }
    for (const s of r.steps.slice(5)) {
      assert.equal(s.screenshot, undefined, `étape ${s.n} sans capture`);
      assert.equal(s.detail, 'capture omise : 5 captures d\'échec au plus par run');
    }
    assert.equal(log.filter((x) => x.cmd === 'screenshot').length, 5, 'pas de capture au-delà du plafond');
    assert.equal(r.report?.steps[6]?.screenshot, undefined);
  });
}

test(`run --continue --out-dir : --shot-on-error plafonné à ${MAX_RUN_SHOT_FILES} captures renvoyées au client, puis note « capture omise »`, async () => {
  const n = MAX_RUN_SHOT_FILES + 2;
  const script = Array.from({ length: n }, () => 'click \'#x\' --shot-on-error').join('\n');
  const log: StepRequest[] = [];
  const r = await runScript(compileScript(script, { files: true }), fakeExec(log), true, undefined, { clientShots: true });
  assert.equal(r.steps.length, n);
  for (const s of r.steps.slice(0, MAX_RUN_SHOT_FILES)) {
    assert.equal(s.screenshot, `echec-etape-${s.n}.png`);
    assert.equal(s.failShot?.inError, true);
  }
  for (const s of r.steps.slice(MAX_RUN_SHOT_FILES)) {
    assert.equal(s.screenshot, undefined);
    assert.equal(s.failShot, undefined);
    assert.equal(s.detail, `capture omise : ${MAX_RUN_SHOT_FILES} captures d'échec au plus par run`);
  }
  assert.equal(log.filter((x) => x.cmd === 'screenshot').length, MAX_RUN_SHOT_FILES);
});
