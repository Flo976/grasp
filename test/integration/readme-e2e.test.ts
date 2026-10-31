import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

test('README : le scénario de bout en bout (examples/e2e.sh) tourne vraiment', () => {
  const r = spawnSync('bash', [join(process.cwd(), 'examples', 'e2e.sh')], { encoding: 'utf8', timeout: 120_000 });
  assert.equal(r.status, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /SCÉNARIO VALIDÉ$/m);
  assert.match(r.stdout, /^navigation → http:\/\/127\.0\.0\.1:\d+\/submit\?/m, 'click --snap-diff renvoie la page résultante');
  assert.match(r.stdout, /^~ e[0-9a-z]+:checkbox "J'accepte les conditions" \[x\]/m);
});
