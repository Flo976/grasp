#!/usr/bin/env node
// Vérificateur du journal des changements (CHANGELOG.md), sans dépendance.
//
//   node scripts/check-changelog.mjs                    format du journal + version de package.json
//   node scripts/check-changelog.mjs --staged           + les fichiers indexés : code touché ⇒ journal touché
//   node scripts/check-changelog.mjs --commit-msg F     idem, sauf si le message F contient [sans changelog]
//   node scripts/check-changelog.mjs --range A..B       + chaque commit de A..B (CI)
//
// Utilisé par le hook .githooks/commit-msg, par test/unit/changelog.test.ts et par la CI GitHub.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CHANGELOG = 'CHANGELOG.md';
export const TITLE = '# Journal des changements';
export const UNRELEASED = 'Non publié';
export const SKIP_TAG = '[sans changelog]';

/** Catégories admises, dans l'ordre où elles doivent apparaître dans une version. */
export const CATEGORIES = [
  '💥 Rupture',
  '✨ Ajouté',
  '🔄 Modifié',
  '⚠️ Déprécié',
  '🗑️ Retiré',
  '🐛 Corrigé',
  '🔒 Sécurité',
  '⚡ Performances',
  '📝 Documentation',
];

/** Chemins dont la modification exige une entrée au journal. */
export const SIGNIFICANT = [/^src\//, /^skills\//, /^docker\//, /^data\//, /^Dockerfile$/, /^package\.json$/];

const VERSION_RE = /^## \[(\d+)\.(\d+)\.(\d+)\] — (\d{4}-\d{2}-\d{2})(?: · \S.*)?$/;
const UNRELEASED_RE = /^## \[Non publié\]$/;
const LINK_RE = /^\[([^\]]+)\]: (https:\/\/\S+)$/;

function validDate(s) {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function cmpVersion(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/**
 * Valide le texte du journal. Renvoie { errors, versions } ; versions = publiées, de la plus récente à la plus ancienne.
 * @param {string} text
 * @param {{ packageVersion?: string }} [opts]
 */
export function validateChangelog(text, opts = {}) {
  const errors = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const err = (n, msg) => errors.push(`ligne ${n + 1} : ${msg}`);

  let seenTitle = false;
  let seenUnreleased = false;
  /** @type {{name: string, line: number, nums?: number[], date?: string, cats: {name: string, bullets: number}[]}[]} */
  const sections = [];
  let cur = null;
  let cat = null;
  const links = new Map();
  let inFence = false;

  lines.forEach((line, n) => {
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (inFence) return;
    const link = LINK_RE.exec(line);
    if (link) { links.set(link[1], n); return; }

    if (line.startsWith('# ')) {
      if (line === TITLE) seenTitle = true;
      else err(n, `titre attendu : « ${TITLE} »`);
      return;
    }
    if (line.startsWith('## ')) {
      if (!seenUnreleased && !line.startsWith('## [')) return; // sections libres avant [Non publié]
      if (UNRELEASED_RE.test(line)) {
        if (seenUnreleased) err(n, `section [${UNRELEASED}] en double`);
        else if (sections.length) err(n, `[${UNRELEASED}] doit précéder toutes les versions`);
        seenUnreleased = true;
        cur = { name: UNRELEASED, line: n, cats: [] };
        sections.push(cur); cat = null;
        return;
      }
      const m = VERSION_RE.exec(line);
      if (!m) { err(n, 'titre de version attendu : « ## [X.Y.Z] — AAAA-MM-JJ » (suivi au besoin de « · Thème »)'); return; }
      if (!seenUnreleased) err(n, `la section « ## [${UNRELEASED}] » doit venir avant les versions`);
      seenUnreleased = true;
      const nums = [Number(m[1]), Number(m[2]), Number(m[3])];
      if (!validDate(m[4])) err(n, `date invalide : ${m[4]}`);
      cur = { name: nums.join('.'), line: n, nums, date: m[4], cats: [] };
      sections.push(cur); cat = null;
      return;
    }
    if (line.startsWith('### ')) {
      if (!cur) return; // sous-titres libres de l'en-tête
      const name = line.slice(4).trim();
      const idx = CATEGORIES.indexOf(name);
      if (idx < 0) { err(n, `catégorie inconnue « ${name} » ; admises : ${CATEGORIES.join(', ')}`); return; }
      if (cur.cats.some((c) => c.name === name)) err(n, `catégorie « ${name} » en double dans [${cur.name}]`);
      const prev = cur.cats.at(-1);
      if (prev && CATEGORIES.indexOf(prev.name) > idx) err(n, `« ${name} » doit venir avant « ${prev.name} » (ordre : ${CATEGORIES.join(' → ')})`);
      cat = { name, bullets: 0 };
      cur.cats.push(cat);
      return;
    }
    if (cat && /^- \S/.test(line)) cat.bullets++;
    else if (cat && /^-\s*$/.test(line)) err(n, 'entrée vide');
  });

  if (!seenTitle) errors.push(`titre « ${TITLE} » absent`);
  if (!seenUnreleased) errors.push(`section « ## [${UNRELEASED}] » absente`);

  const versions = sections.filter((s) => s.nums);
  for (const s of sections) {
    for (const c of s.cats) if (!c.bullets) err(s.line, `catégorie « ${c.name} » de [${s.name}] sans entrée`);
    if (s.nums && !s.cats.length) err(s.line, `version [${s.name}] sans aucune catégorie`);
    if (!links.has(s.name)) err(s.line, `lien de référence « [${s.name}]: https://… » absent en bas du journal`);
  }
  for (let i = 1; i < versions.length; i++) {
    const a = versions[i - 1], b = versions[i];
    if (cmpVersion(a.nums, b.nums) <= 0) err(b.line, `versions dans le désordre : [${b.name}] après [${a.name}] (plus récente en haut)`);
    if (a.date < b.date) err(b.line, `dates dans le désordre : [${b.name}] (${b.date}) plus récente que [${a.name}] (${a.date})`);
  }
  if (opts.packageVersion !== undefined) {
    const latest = versions[0];
    if (!latest) errors.push(`aucune version publiée alors que package.json annonce ${opts.packageVersion}`);
    else if (latest.name !== opts.packageVersion) {
      errors.push(`package.json annonce ${opts.packageVersion} mais la dernière version du journal est [${latest.name}]`);
    }
  }
  return { errors, versions: versions.map((v) => ({ version: v.name, date: v.date })) };
}

/** Le changement exige-t-il une entrée ? Renvoie les fichiers significatifs (vide si le journal est touché). */
export function missingEntry(files) {
  if (files.includes(CHANGELOG)) return [];
  return files.filter((f) => SIGNIFICANT.some((re) => re.test(f)));
}

export function wantsSkip(message) {
  return message.toLowerCase().includes(SKIP_TAG);
}

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

function explainMissing(files, where) {
  return [
    `${where} modifie du code sans toucher ${CHANGELOG} :`,
    ...files.slice(0, 8).map((f) => `    ${f}`),
    ...(files.length > 8 ? [`    … et ${files.length - 8} autre(s)`] : []),
    '',
    `  → ajoutez une ligne sous « ## [${UNRELEASED}] » dans ${CHANGELOG} (catégories : ${CATEGORIES.join(', ')})`,
    `  → ou, pour un changement sans effet visible, mettez « ${SKIP_TAG} » dans le message de commit`,
  ].join('\n');
}

function main(argv) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const problems = [];

  const path = join(root, CHANGELOG);
  if (!existsSync(path)) {
    problems.push(`${CHANGELOG} absent`);
  } else {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const { errors } = validateChangelog(readFileSync(path, 'utf8'), { packageVersion: pkg.version });
    problems.push(...errors.map((e) => `${CHANGELOG}, ${e}`));
  }

  const flag = argv[0];
  if (flag === '--staged' || flag === '--commit-msg') {
    const msg = flag === '--commit-msg' && argv[1] ? readFileSync(argv[1], 'utf8') : '';
    const merging = existsSync(join(git(root, 'rev-parse', '--absolute-git-dir').trim(), 'MERGE_HEAD'));
    if (!merging && !wantsSkip(msg)) {
      const files = git(root, 'diff', '--cached', '--name-only').split('\n').filter(Boolean);
      const miss = missingEntry(files);
      if (miss.length) problems.push(explainMissing(miss, 'ce commit'));
    }
  } else if (flag === '--range') {
    const range = argv[1];
    if (!range) throw new Error('--range A..B attendu');
    const commits = git(root, 'rev-list', '--no-merges', range).split('\n').filter(Boolean);
    for (const c of commits) {
      const msg = git(root, 'log', '-1', '--format=%B', c);
      if (wantsSkip(msg)) continue;
      const files = git(root, 'diff-tree', '--no-commit-id', '--name-only', '-r', c).split('\n').filter(Boolean);
      const miss = missingEntry(files);
      if (miss.length) problems.push(explainMissing(miss, `le commit ${c.slice(0, 7)} « ${msg.split('\n')[0]} »`));
    }
  } else if (flag) {
    throw new Error(`option inconnue : ${flag}`);
  }

  if (problems.length) {
    console.error('✖ Journal des changements : à corriger\n');
    for (const p of problems) console.error(`  • ${p}\n`);
    process.exit(1);
  }
  console.log('✔ Journal des changements en règle');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(`✖ ${e.message}`); process.exit(2); }
}
