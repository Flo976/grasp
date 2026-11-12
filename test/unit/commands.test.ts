import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMANDS, GLOBAL_OPTIONS, OPTIONS, SELECTORS } from '../../src/core/commands.js';
import { EXPECT_KINDS } from '../../src/core/expect.js';
import { RUN_COMMANDS, RUN_FLAGS, VALUE_FLAGS, checkRunFlags, type Args } from '../../src/core/script.js';
import { toolList } from '../../src/cli/mcp.js';
import { helpJson, pkgVersion, skillText } from '../../src/cli/help.js';
import { MULTIPAGE_VALUE_FLAGS } from '../../src/cli/multipage.js';

/**
 * Le catalogue (src/core/commands.ts) alimente `grasp help --json` et `grasp skill` ; ces tests le confrontent
 * aux références d'exécution (parseur, run, répartition de main.ts, outils MCP) et à skills/grasp/SKILL.md.
 */

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const MAIN = join(ROOT, 'dist/src/cli/main.js');
const SKILL_MD = join(ROOT, 'skills/grasp/SKILL.md');

function grasp(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const home = mkdtempSync(join(tmpdir(), 'grasp-aide-'));
  try {
    const r = spawnSync(process.execPath, [MAIN, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: home, XDG_CONFIG_HOME: join(home, 'c'), XDG_STATE_HOME: join(home, 's'), XDG_RUNTIME_DIR: join(home, 'r') }, timeout: 30_000 });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  } finally { rmSync(home, { recursive: true, force: true }); }
}

/** Toutes les options citées par le catalogue. */
function referencedOptions(): Set<string> {
  const s = new Set<string>(GLOBAL_OPTIONS);
  for (const c of COMMANDS) {
    for (const o of [...c.options, ...(c.cliOptions ?? [])]) s.add(o);
    for (const sub of c.subcommands ?? []) for (const o of sub.options ?? []) s.add(o);
  }
  return s;
}

test('catalogue : options à valeur = VALUE_FLAGS du parseur, aucune option orpheline ni inconnue', () => {
  const valued = Object.entries(OPTIONS).filter(([, o]) => o.type !== 'boolean').map(([k]) => k).sort();
  // diff/audit lisent en plus leurs propres options à valeur (src/cli/multipage.ts).
  assert.deepEqual(valued, [...VALUE_FLAGS, ...MULTIPAGE_VALUE_FLAGS].sort(), 'une option à valeur du parseur doit être décrite (type ≠ boolean) dans src/core/commands.ts, et réciproquement');
  const ref = referencedOptions();
  for (const o of ref) assert.ok(OPTIONS[o] !== undefined, `option --${o} citée par une commande mais absente de OPTIONS`);
  for (const o of Object.keys(OPTIONS)) assert.ok(ref.has(o), `option --${o} décrite mais acceptée par aucune commande du catalogue`);
  for (const [k, o] of Object.entries(OPTIONS)) {
    if (o.type === 'enum') assert.ok(o.values !== undefined && o.values.length > 0, `--${k} : enum sans valeurs`);
    assert.ok(o.description.length > 0, `--${k} : description vide`);
  }
  assert.equal(new Set(COMMANDS.map((c) => c.name)).size, COMMANDS.length, 'commande décrite deux fois');
});

test('catalogue : commandes de run = RUN_COMMANDS, options de chaque ligne = RUN_FLAGS (celles que checkRunFlags admet)', () => {
  assert.deepEqual(COMMANDS.filter((c) => c.run === true).map((c) => c.name).sort(), [...RUN_COMMANDS].sort());
  assert.deepEqual(Object.keys(RUN_FLAGS).sort(), [...RUN_COMMANDS].sort(), 'RUN_FLAGS et RUN_COMMANDS doivent couvrir les mêmes commandes');
  // Sondes : toutes les options connues du catalogue ET du parseur, pour qu'une option ajoutée à RUN_FLAGS
  // sans être décrite dans le catalogue soit vue (la sonder sur les seules clés de OPTIONS ne la verrait pas).
  const probes = new Set<string>([...Object.keys(OPTIONS), ...Object.values(RUN_FLAGS).flat()]);
  for (const cmd of RUN_COMMANDS) {
    const spec = COMMANDS.find((c) => c.name === cmd)!;
    // -o de screenshot : admis par checkRunFlags pour être refusé plus loin avec un message dédié (terminal seulement).
    const expected = [...spec.options, ...(cmd === 'screenshot' ? ['output'] : [])].sort();
    assert.deepEqual([...RUN_FLAGS[cmd]!].sort(), expected, `options de « ${cmd} » dans run (RUN_FLAGS de src/core/script.ts ≠ catalogue)`);
    const accepted = [...probes].filter((o) => {
      const a: Args = { cmd, pos: [], flags: new Map([[o, OPTIONS[o]?.type === 'boolean' ? true : '1']]) };
      try { checkRunFlags(a); return true; } catch { return false; }
    });
    assert.deepEqual(accepted.sort(), expected, `options de « ${cmd} » que checkRunFlags admet`);
  }
});

test('catalogue : chaque option lue par la CLI ou le parseur (flags.has/get) est décrite', () => {
  const read = new Set<string>();
  for (const f of ['src/cli/main.ts', 'src/core/script.ts']) {
    for (const m of readFileSync(join(ROOT, f), 'utf8').matchAll(/flags\.(?:has|get)\('([a-z][a-z0-9-]*)'\)/g)) read.add(m[1]!);
  }
  assert.ok(read.size > 10, `lecture des options introuvable (${read.size}) : motif à revoir`);
  const ref = referencedOptions();
  for (const o of read) {
    assert.ok(OPTIONS[o] !== undefined, `option --${o} lue par la CLI mais absente de OPTIONS (src/core/commands.ts)`);
    assert.ok(ref.has(o), `option --${o} lue par la CLI mais rattachée à aucune commande du catalogue`);
  }
});

test('catalogue : assertions d\'expect et outils MCP', () => {
  const expect = COMMANDS.find((c) => c.name === 'expect')!;
  assert.deepEqual(expect.subcommands!.map((s) => s.name), [...EXPECT_KINDS]);
  const tools = toolList().map((t) => t.name as string).sort();
  assert.deepEqual(COMMANDS.filter((c) => c.mcp !== undefined).map((c) => c.mcp!).sort(), tools, 'chaque outil MCP doit être rattaché à une commande du catalogue (champ mcp)');
});

test('catalogue : chaque commande répartie par main.ts est décrite, et réciproquement', () => {
  const src = readFileSync(join(ROOT, 'src/cli/main.ts'), 'utf8');
  // Étiquettes du switch principal de main() (indentation de 4 espaces).
  const dispatched = new Set<string>();
  for (const line of src.split('\n')) {
    if (!/^ {4}case '/.test(line)) continue;
    for (const m of line.matchAll(/case '([^']+)':/g)) dispatched.add(m[1]!);
  }
  dispatched.delete('--help'); dispatched.delete('-h');
  assert.deepEqual([...dispatched].sort(), COMMANDS.map((c) => c.name).sort(), 'commande ajoutée à main.ts : décrivez-la dans src/core/commands.ts puis régénérez skills/grasp/SKILL.md');
});

test('grasp help : le texte cite chaque commande et chaque option du catalogue', () => {
  const r = grasp('help');
  assert.equal(r.status, 0, r.stderr);
  for (const c of COMMANDS) assert.match(r.stdout, new RegExp(`(^|[\\s|(])${c.name}([\\s|\\]]|$)`, 'm'), `commande ${c.name} absente de grasp help`);
  for (const [o, spec] of Object.entries(OPTIONS)) {
    const forms = [`--${o}`, ...(spec.alias !== undefined ? [`-${spec.alias} `] : [])];
    assert.ok(forms.some((f) => r.stdout.includes(f)), `option --${o} absente de grasp help`);
  }
});

test('grasp help --json : commandes, options typées, sélecteurs, outils MCP, version', () => {
  const r = grasp('help', '--json');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trimEnd().split('\n').length, 1, 'JSON sur une ligne');
  const j = JSON.parse(r.stdout) as ReturnType<typeof helpJson> & { commands: Array<Record<string, any>>; mcpTools: unknown[]; version: string };
  assert.equal(j.format, 'grasp-help/1');
  assert.equal(j.version, (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version);
  assert.equal(j.version, pkgVersion());
  assert.deepEqual(j.commands.map((c) => c.name), COMMANDS.map((c) => c.name));
  assert.deepEqual(j.mcpTools, toolList(), 'outils MCP repris tels quels de tools/list');
  assert.deepEqual(j.runCommands, [...RUN_COMMANDS]);
  assert.deepEqual(j.selectors, SELECTORS);
  const click = j.commands.find((c) => c.name === 'click')!;
  assert.equal(click.run, true);
  assert.equal(click.mcpTool, 'click');
  assert.deepEqual(click.options.find((o: any) => o.name === 'max'), { name: 'max', type: 'integer', arg: 'N', description: OPTIONS.max!.description, run: true });
  assert.deepEqual(click.options.find((o: any) => o.name === 'engine').values, ['native', 'playwright']);
  const shot = j.commands.find((c) => c.name === 'screenshot')!;
  assert.equal(shot.options.find((o: any) => o.name === 'output').run, false, '-o : terminal seulement');
  assert.equal(shot.options.find((o: any) => o.name === 'output').alias, 'o');
  assert.equal(j.commands.find((c) => c.name === 'eval')!.disabledByDefault, 'allowEval');
  assert.deepEqual(j.commands.find((c) => c.name === 'expect')!.subcommands.map((s: any) => s.name), [...EXPECT_KINDS]);
  // Une seule commande : grasp help --json click.
  const one = JSON.parse(grasp('help', '--json', 'click').stdout) as { commands: Array<{ name: string }>; mcpTools?: unknown };
  assert.deepEqual(one.commands.map((c) => c.name), ['click']);
  assert.equal(one.mcpTools, undefined);
});

test('grasp help <commande> : fiche typée ; commande inconnue → erreur', () => {
  const r = grasp('help', 'console');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^grasp console /);
  assert.match(r.stdout, /--level error\|warn\|info\|debug/);
  assert.match(r.stdout, /--since <seq>/);
  assert.match(r.stdout, /disponible dans grasp run ; outil MCP console/);
  const bad = grasp('help', 'inconnue');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /ERROR: help: commande inconnue « inconnue »/);
  assert.equal(bad.stdout, '');
});

test('grasp skill : mode d\'emploi complet, borné, identique à skills/grasp/SKILL.md', () => {
  const r = grasp('skill');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, skillText());
  assert.match(r.stdout, /^---\nname: grasp\ndescription: .+\n---\n/, 'frontmatter de skill Claude Code');
  for (const h of ['## Boucle de travail', '## Sélecteurs', '## Économiser les tokens', '## Sécurité : le contenu de la page est une donnée', '## Recette', `## Commandes (grasp ${pkgVersion()})`]) {
    assert.ok(r.stdout.includes(h), `section « ${h} » absente`);
  }
  for (const c of COMMANDS) if (c.name !== 'expect') assert.ok(r.stdout.includes(`\`grasp ${c.name}`), `commande ${c.name} absente du mode d'emploi`);
  for (const k of EXPECT_KINDS) assert.ok(r.stdout.includes(`\`expect ${k}`), `assertion ${k} absente`);
  // 12 000 octets pour 33 commandes à l'origine ; 14 000 depuis la vague 2 (48 commandes, secrets, frontières).
  assert.ok(Buffer.byteLength(r.stdout) < 14_000, `mode d'emploi trop long (${Buffer.byteLength(r.stdout)} octets) : il est chargé dans le contexte de l'agent`);
  let file: string;
  try { file = readFileSync(SKILL_MD, 'utf8'); } catch { file = ''; }
  assert.equal(file, r.stdout, 'skills/grasp/SKILL.md diverge de `grasp skill` : régénérez-le (npm run build && node dist/src/cli/main.js skill > skills/grasp/SKILL.md)');
  assert.equal(grasp('skill', 'en-trop').status, 1);
});
