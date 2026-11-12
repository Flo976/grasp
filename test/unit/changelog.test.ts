import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// dist/test/unit → racine du dépôt
const ROOT = join(import.meta.dirname, '..', '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'check-changelog.mjs');

interface Checker {
  validateChangelog(text: string, opts?: { packageVersion?: string }): { errors: string[]; versions: { version: string; date: string }[] };
  missingEntry(files: string[]): string[];
  wantsSkip(message: string): boolean;
  CATEGORIES: string[];
}
const load = async (): Promise<Checker> => (await import(SCRIPT)) as Checker;

const LINKS = '\n[Non publié]: https://x.test/a\n[1.1.0]: https://x.test/b\n[1.0.0]: https://x.test/c\n';
const OK = `# Journal des changements

## [Non publié]

## [1.1.0] — 2026-11-12 · Thème

### ✨ Ajouté

- une commande

### 🐛 Corrigé

- un défaut

## [1.0.0] — 2026-11-01

### ✨ Ajouté

- le reste
${LINKS}`;

test('journal : le CHANGELOG.md du dépôt est en règle et suit package.json', async () => {
  const { validateChangelog } = await load();
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };
  const { errors, versions } = validateChangelog(readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8'), { packageVersion: pkg.version });
  assert.deepEqual(errors, []);
  assert.equal(versions[0]?.version, pkg.version);
});

test('journal : un journal bien formé passe', async () => {
  const { validateChangelog } = await load();
  assert.deepEqual(validateChangelog(OK, { packageVersion: '1.1.0' }).errors, []);
});

test('journal : chaque écart de format est nommé', async () => {
  const { validateChangelog } = await load();
  const cases: [string, string, RegExp][] = [
    ['sans titre', OK.replace('# Journal des changements\n', ''), /titre « # Journal des changements » absent/],
    ['sans [Non publié]', OK.replace('## [Non publié]\n', ''), /\[Non publié\]/],
    ['catégorie inconnue', OK.replace('### 🐛 Corrigé', '### Divers'), /catégorie inconnue « Divers »/],
    ['catégories dans le désordre', OK.replace('### ✨ Ajouté\n\n- une commande\n\n### 🐛 Corrigé\n\n- un défaut',
      '### 🐛 Corrigé\n\n- un défaut\n\n### ✨ Ajouté\n\n- une commande'), /doit venir avant/],
    ['catégorie vide', OK.replace('- un défaut\n', ''), /sans entrée/],
    ['versions dans le désordre', OK.replace('[1.1.0] — 2026-11-12', '[0.9.0] — 2026-11-12').replace('[1.1.0]: ', '[0.9.0]: '), /versions dans le désordre/],
    ['date invalide', OK.replace('2026-11-12', '2026-13-40'), /date invalide/],
    ['titre de version mal formé', OK.replace('## [1.0.0] — 2026-11-01', '## 1.0.0 (2026-11-01)'), /titre de version attendu/],
    ['lien absent', OK.replace('[1.0.0]: https://x.test/c\n', ''), /lien de référence « \[1\.0\.0\]/],
    ['version sans catégorie', OK.replace('### ✨ Ajouté\n\n- le reste\n', ''), /sans aucune catégorie/],
  ];
  for (const [nom, texte, attendu] of cases) {
    const { errors } = validateChangelog(texte);
    assert.ok(errors.some((e) => attendu.test(e)), `${nom} : ${JSON.stringify(errors)}`);
  }
});

test('journal : package.json doit annoncer la dernière version publiée', async () => {
  const { validateChangelog } = await load();
  const { errors } = validateChangelog(OK, { packageVersion: '1.2.0' });
  assert.ok(errors.some((e) => /package\.json annonce 1\.2\.0 mais la dernière version du journal est \[1\.1\.0\]/.test(e)), JSON.stringify(errors));
});

test('journal : le code touché exige une entrée, pas les tests ni la doc', async () => {
  const { missingEntry, wantsSkip } = await load();
  assert.deepEqual(missingEntry(['src/cli/main.ts', 'test/unit/x.test.ts']), ['src/cli/main.ts']);
  assert.deepEqual(missingEntry(['src/cli/main.ts', 'CHANGELOG.md']), []);
  assert.deepEqual(missingEntry(['README.md', 'TODO.md', 'test/unit/x.test.ts', 'docs/a.md']), []);
  assert.deepEqual(missingEntry(['Dockerfile', 'package.json', 'skills/grasp/SKILL.md']), ['Dockerfile', 'package.json', 'skills/grasp/SKILL.md']);
  assert.equal(wantsSkip('Renommage interne [sans changelog]'), true);
  assert.equal(wantsSkip('Nouvelle commande'), false);
});
