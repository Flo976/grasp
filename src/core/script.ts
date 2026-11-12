/**
 * Syntaxe des commandes de la CLI, partagée par la CLI et par `grasp run` (exécuté côté serveur) :
 * découpage d'une ligne à la shell, analyse des options, et traduction d'une commande en requête du bridge.
 * Une même ligne produit la même requête, qu'elle soit tapée dans le terminal ou lue dans un script.
 */

import { EXPECT_DEFAULT_MS, EXPECT_KINDS, expectSpecOf, isExpectKind, type ExpectKind } from './expect.js';

export class ScriptError extends Error {}

export interface Args { cmd: string; pos: string[]; flags: Map<string, string | true> }

export const VALUE_FLAGS = new Set(['session', 'max', 'output', 'profile', 'port', 'use-when', 'profile-directory', 'el', 'format', 'quality', 'max-width', 'level', 'since', 'limit', 'scope', 'text', 'sel', 'timeout', 'engine', 'delay', 'name-max', 'proxy', 'http-auth', 'origin', 'ignore', 'listen']);
const ALIASES: Record<string, string> = { o: 'output', s: 'session' };

export function parseArgs(argv: string[]): Args {
  const pos: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    const m = /^--?([a-z][a-z-]*)(?:=(.*))?$/.exec(a);
    if (m && !(a.startsWith('-') && !a.startsWith('--') && m[1]!.length > 1)) {
      const name = ALIASES[m[1]!] ?? m[1]!;
      if (m[2] !== undefined) flags.set(name, m[2]);
      else if (VALUE_FLAGS.has(name)) {
        const v = argv[++i];
        if (v === undefined) throw new ScriptError(`--${name} attend une valeur`);
        flags.set(name, v);
      } else flags.set(name, true);
    } else pos.push(a);
  }
  return { cmd: pos.shift() ?? 'help', pos, flags };
}

/**
 * Découpe une ligne comme une shell POSIX (sans expansion) : blancs séparateurs, '…' littéral, "…" avec
 * échappements \" \\ \$ \`, \x hors guillemets. Commentaire jusqu'à la fin de la ligne : # en début de ligne, ou
 * # isolé (suivi d'un blanc) ; un #id collé reste un mot, pour écrire `click #valider` sans guillemets.
 */
export function splitLine(line: string): string[] {
  return scan(line).argv;
}

/** Découpage et position de fin utile (début du commentaire éventuel). */
function scan(line: string): { argv: string[]; end: number } {
  const out: string[] = [];
  let cur = '';
  let inWord = false;
  let end = line.length;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      if (inWord) { out.push(cur); cur = ''; inWord = false; }
      continue;
    }
    // Commentaire : # en début de ligne, ou en début de mot suivi d'un blanc (« click #id » reste un sélecteur CSS).
    if (c === '#' && !inWord && (out.length === 0 || i + 1 >= line.length || /\s/.test(line[i + 1]!))) { end = i; break; }
    inWord = true;
    if (c === "'") {
      const close = line.indexOf("'", i + 1);
      if (close < 0) throw new ScriptError("guillemet non fermé (')");
      cur += line.slice(i + 1, close);
      i = close;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < line.length && line[j] !== '"'; j++) {
        if (line[j] === '\\' && j + 1 < line.length && '"\\$`'.includes(line[j + 1]!)) { cur += line[j + 1]; j++; } else cur += line[j];
      }
      if (j >= line.length) throw new ScriptError('guillemet non fermé (")');
      i = j;
    } else if (c === '\\' && i + 1 < line.length) {
      cur += line[++i];
    } else cur += c;
  }
  if (inWord) out.push(cur);
  return { argv: out, end };
}

export interface ScriptLine { line: number; text: string; argv: string[] }

/** Lignes d'un script : vides et commentaires ignorés, numéro de ligne conservé (messages d'erreur). */
export function parseScript(src: string): ScriptLine[] {
  const out: ScriptLine[] = [];
  src.split('\n').forEach((raw, i) => {
    let r: { argv: string[]; end: number };
    try { r = scan(raw); } catch (e) { throw new ScriptError(`ligne ${i + 1} : ${(e as Error).message}`); }
    // Texte rapporté : la ligne sans son commentaire final.
    if (r.argv.length > 0) out.push({ line: i + 1, text: raw.slice(0, r.end).trim(), argv: r.argv });
  });
  return out;
}

/** Requête d'une commande : route du bridge (ou `profile`, traitée par le control plane). */
export interface StepRequest { cmd: string; method: 'GET' | 'POST'; path: string; body?: Record<string, unknown>; timeoutMs?: number }

function need(a: Args, n: number, usage: string): string[] {
  if (a.pos.length < n) throw new ScriptError(`usage : grasp ${usage}`);
  return a.pos;
}

function value(a: Args, k: string): string | undefined {
  const v = a.flags.get(k);
  if (v === true) throw new ScriptError(`--${k} attend une valeur`);
  return v;
}

/** Options communes des actions : --snap-diff, --max, --scope, --console, --shot-on-error. */
function actionBody(a: Args, extra: Record<string, unknown>): Record<string, unknown> {
  const max = value(a, 'max');
  const scope = value(a, 'scope');
  return {
    ...extra, ...(a.flags.has('snap-diff') ? { snapDiff: true } : {}),
    // Transmis tel quel : le bridge valide (« --max abc » est une erreur 400, pas une limite ignorée).
    ...(max !== undefined ? { max } : {}), ...(scope !== undefined ? { scope } : {}),
    ...(a.flags.has('console') ? { console: true } : {}), ...(a.flags.has('shot-on-error') ? { shotOnError: true } : {}),
    ...engineOf(a),
  };
}

/** --engine native|playwright : transmis tel quel, le bridge valide. */
function engineOf(a: Args): { engine?: string } {
  const e = value(a, 'engine');
  return e !== undefined ? { engine: e } : {};
}

/** --max et --scope de snap / text → paramètres de requête. */
export function readQuery(a: Args): string {
  const q = new URLSearchParams();
  for (const k of ['max', 'scope'] as const) {
    const v = value(a, k);
    if (v !== undefined) q.set(k, v);
  }
  // --name-max : longueur des noms rendus par snap (0 = entiers). text rend le texte entier : refusé, jamais ignoré.
  const nm = value(a, 'name-max');
  if (nm !== undefined) {
    if (a.cmd !== 'snap') throw new ScriptError(`--name-max ne s'applique qu'à snap (${a.cmd} ne tronque aucun nom ; --max borne la sortie)`);
    if (!/^\d+$/.test(nm)) throw new ScriptError('--name-max attend un entier positif ou nul (0 = noms entiers)');
    q.set('nameMax', nm);
  }
  // --markdown : sortie Markdown de text ; ailleurs refusé, jamais ignoré.
  const md = a.flags.get('markdown');
  if (md !== undefined) {
    if (a.cmd !== 'text') throw new ScriptError(`--markdown ne s'applique qu'à text (${a.cmd} a son propre format)`);
    if (md !== true) throw new ScriptError("--markdown ne prend pas de valeur (grasp text --markdown)");
    q.set('markdown', '1');
  }
  return q.size > 0 ? `?${q}` : '';
}

const SHOT_FORMATS: Record<string, string> = { '.png': 'png', '.jpg': 'jpeg', '.jpeg': 'jpeg', '.webp': 'webp' };

/** Options de capture → paramètres de GET /screenshot. Format déduit de l'extension de -o à défaut de --format. */
export function shotQuery(a: Args, file: string | undefined): URLSearchParams {
  const q = new URLSearchParams();
  if (a.flags.has('full')) q.set('full', '1');
  if (a.flags.has('refs')) q.set('refs', '1');
  for (const [flag, key] of [['el', 'el'], ['quality', 'quality'], ['max-width', 'maxWidth'], ['format', 'format']] as const) {
    const v = value(a, flag);
    if (v !== undefined) q.set(key, v);
  }
  if (!q.has('format') && file !== undefined && file !== '-') {
    const ext = /\.[A-Za-z]+$/.exec(file)?.[0]?.toLowerCase();
    const f = ext !== undefined ? SHOT_FORMATS[ext] : undefined;
    if (f !== undefined) q.set('format', f);
  }
  return q;
}

/** Corps de POST /wait et délai du client (le bridge valide les valeurs : une valeur invalide est une erreur). */
export function waitRequest(a: Args): { body: Record<string, unknown>; timeoutMs: number } {
  const body: Record<string, unknown> = {};
  for (const k of ['text', 'sel', 'timeout'] as const) {
    const v = value(a, k);
    if (v !== undefined) body[k] = v;
  }
  if (a.flags.has('idle')) body.idle = true;
  const t = Number(body.timeout);
  return { body, timeoutMs: (Number.isFinite(t) && t > 0 ? t : 60_000) + 15_000 };
}

/** Corps de POST /console ; 50 dernières lignes par défaut (une console bavarde coûte cher en tokens). */
export function consoleBody(a: Args): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const k of ['level', 'since', 'limit'] as const) {
    const v = value(a, k);
    if (v === '') throw new ScriptError(`--${k} attend une valeur`);
    if (v !== undefined) body[k] = v;
  }
  if (body.limit === undefined) body.limit = 50;
  if (a.flags.has('clear')) body.clear = true;
  return body;
}

/** Commandes exécutables dans `grasp run`. */
export const RUN_COMMANDS = ['nav', 'snap', 'text', 'click', 'fill', 'select', 'check', 'press', 'hover', 'type', 'wait', 'expect', 'eval', 'console', 'screenshot', 'cookies', 'upload', 'profile'] as const;
const KNOWN_ELSEWHERE = new Set(['serve', 'stop', 'status', 'session', 'profiles', 'pdf', 'security', 'config', 'doctor', 'daemon', 'help', 'run', 'history']);

const ACTION_FLAGS = ['snap-diff', 'max', 'scope', 'console', 'shot-on-error', 'engine'];
/** Options acceptées sur une ligne de `grasp run`, par commande (celles que buildRequest transmet). */
const RUN_FLAGS: Record<string, readonly string[]> = {
  nav: ACTION_FLAGS, click: ACTION_FLAGS, fill: ACTION_FLAGS, select: ACTION_FLAGS, press: ACTION_FLAGS, hover: ACTION_FLAGS,
  check: [...ACTION_FLAGS, 'uncheck'], type: [...ACTION_FLAGS, 'delay'],
  snap: ['max', 'scope', 'name-max'], text: ['max', 'scope', 'markdown'],
  wait: ['text', 'sel', 'timeout', 'idle'],
  console: ['level', 'since', 'limit', 'clear'],
  // -o : refusé plus loin avec un message dédié (le fichier serait écrit par le serveur).
  screenshot: ['full', 'refs', 'el', 'quality', 'max-width', 'format', 'output'],
  upload: ['engine'], eval: [], cookies: [], profile: [],
  expect: ['regex', 'timeout', 'scope', 'since', 'ignore', 'shot-on-error'],
};
/** Options du run lui-même (ou du terminal) : sur une ligne, elles changeraient le sens de la ligne sans effet réel. */
const RUN_GLOBAL: Record<string, string> = {
  session: "une ligne ne change pas de session : grasp run --session <id> (un run par session)",
  json: 'la sortie est celle du run : grasp run --json',
  continue: 'option du run : grasp run --continue',
  port: 'option de grasp serve', tcp: 'option de grasp serve', listen: 'option de grasp serve',
  profile: 'pour basculer de profil au milieu du script : une ligne « profile <nom> »',
};

/**
 * `grasp run` : une option qu'une ligne ne transmettrait pas est REFUSÉE, jamais ignorée en silence
 * (« click e3 --session autre » agirait sinon sur la session du run). Options globales : message dédié.
 */
export function checkRunFlags(a: Args): void {
  const allowed = RUN_FLAGS[a.cmd];
  if (allowed === undefined) return; // commande inconnue ou hors run : buildRequest le dit
  for (const k of a.flags.keys()) {
    if (allowed.includes(k)) continue;
    const g = RUN_GLOBAL[k];
    if (g !== undefined) throw new ScriptError(`--${k} n'a pas de sens sur une ligne de run : ${g}`);
    throw new ScriptError(`option --${k} inconnue pour ${a.cmd} dans run${allowed.length > 0 ? ` (options : ${allowed.filter((x) => x !== 'output').map((x) => `--${x}`).join(' ')})` : ' (aucune option)'}`);
  }
}

/** Ligne de commande → requête du bridge, exactement comme la CLI la construit pour une commande isolée. */
export function buildRequest(a: Args): StepRequest {
  const cmd = a.cmd;
  switch (cmd) {
    case 'nav': { const [url] = need(a, 1, 'nav <url>'); return { cmd, method: 'POST', path: '/navigate', body: actionBody(a, { url }) }; }
    case 'snap': return { cmd, method: 'GET', path: `/snap${readQuery(a)}` };
    case 'text': return { cmd, method: 'GET', path: `/text${readQuery(a)}` };
    case 'click': { const [target] = need(a, 1, 'click <sélecteur>'); return { cmd, method: 'POST', path: '/click', body: actionBody(a, { target }) }; }
    case 'fill': { const [target, v] = need(a, 2, 'fill <sélecteur> <valeur>'); return { cmd, method: 'POST', path: '/fill', body: actionBody(a, { target, value: v }) }; }
    case 'select': { const [target, v] = need(a, 2, 'select <sélecteur> <valeur|libellé>'); return { cmd, method: 'POST', path: '/select', body: actionBody(a, { target, value: v }) }; }
    case 'check': { const [target] = need(a, 1, 'check <sélecteur> [--uncheck]'); return { cmd, method: 'POST', path: '/check', body: actionBody(a, { target, checked: !a.flags.has('uncheck') }) }; }
    case 'press': {
      const [key, target] = need(a, 1, 'press <touche> [sélecteur]');
      return { cmd, method: 'POST', path: '/press', body: actionBody(a, target !== undefined ? { key, target } : { key }) };
    }
    case 'hover': { const [target] = need(a, 1, 'hover <sélecteur>'); return { cmd, method: 'POST', path: '/hover', body: actionBody(a, { target }) }; }
    case 'type': {
      const [target, text] = need(a, 2, 'type <sélecteur> <texte> [--delay ms]');
      const delay = value(a, 'delay');
      return { cmd, method: 'POST', path: '/type', body: actionBody(a, { target, text, ...(delay !== undefined ? { delay } : {}) }) };
    }
    case 'wait': { const w = waitRequest(a); return { cmd, method: 'POST', path: '/wait', body: w.body, timeoutMs: w.timeoutMs }; }
    case 'eval': { const [expression] = need(a, 1, 'eval <expression>'); return { cmd, method: 'POST', path: '/eval', body: { expression } }; }
    case 'console': return { cmd, method: 'POST', path: '/console', body: consoleBody(a) };
    case 'screenshot': {
      if (a.flags.has('output')) throw new ScriptError("screenshot -o n'est pas disponible dans run (le fichier serait écrit par le serveur) : sans -o, le chemin de la capture (0600) est renvoyé");
      const q = shotQuery(a, undefined);
      q.set('save', '1');
      return { cmd, method: 'GET', path: `/screenshot?${q}` };
    }
    case 'cookies': return { cmd, method: 'GET', path: '/cookies' };
    case 'upload': { const [target, ...files] = need(a, 2, 'upload <sélecteur> <fichier>…'); return { cmd, method: 'POST', path: '/upload', body: { target, files, ...engineOf(a) } }; }
    case 'profile': { const [name] = need(a, 1, 'profile <nom>'); return { cmd, method: 'POST', path: 'profile', body: { name } }; }
    case 'expect': return expectRequest(a);
    default:
      if (KNOWN_ELSEWHERE.has(cmd)) throw new ScriptError(`« ${cmd} » n'est pas disponible dans run (commandes : ${RUN_COMMANDS.join(', ')})`);
      throw new ScriptError(`commande inconnue « ${cmd} » (commandes de run : ${RUN_COMMANDS.join(', ')})`);
  }
}

/** Options de chaque assertion (toutes acceptent --shot-on-error). */
const EXPECT_FLAGS: Record<ExpectKind, readonly string[]> = {
  'text': ['regex', 'scope', 'timeout'], 'no-text': ['regex', 'scope', 'timeout'],
  'url': ['regex', 'timeout'], 'title': ['regex', 'timeout'], 'value': ['regex', 'timeout'],
  'sel': ['timeout'], 'no-sel': ['timeout'],
  'no-console-errors': ['since', 'ignore'], 'no-form-errors': [],
};
const EXPECT_ALL_FLAGS = ['regex', 'timeout', 'scope', 'since', 'ignore', 'shot-on-error'];

/** Usage de chaque assertion (messages d'erreur, aide). */
export const EXPECT_USAGE: Record<ExpectKind, string> = {
  'text': 'expect text <texte> [--regex] [--scope <sél>] [--timeout ms]',
  'no-text': 'expect no-text <texte> [--regex] [--scope <sél>] [--timeout ms]',
  'url': 'expect url [~] <url> [--regex] [--timeout ms]',
  'title': 'expect title [~] <titre> [--regex] [--timeout ms]',
  'sel': 'expect sel <sélecteur> [--timeout ms]',
  'no-sel': 'expect no-sel <sélecteur> [--timeout ms]',
  'value': 'expect value <sélecteur> [~] <valeur> [--regex] [--timeout ms]',
  'no-console-errors': 'expect no-console-errors [--ignore <regex>] [--since <seq>]',
  'no-form-errors': 'expect no-form-errors',
};

/**
 * `expect <assertion> …` → POST /expect. Comparaison : égalité par défaut (url, title, value), `~` = contient,
 * `--regex` = expression régulière ; text et no-text cherchent toujours dans le texte de la page. Validé ici
 * en entier (motif compris) : une assertion mal écrite refuse le script avant toute exécution.
 */
function expectRequest(a: Args): StepRequest {
  const [kind, ...args] = a.pos;
  if (kind === undefined) throw new ScriptError(`usage : grasp expect <assertion> … (assertions : ${EXPECT_KINDS.join(', ')})`);
  if (!isExpectKind(kind)) throw new ScriptError(`assertion inconnue « ${kind} » (assertions : ${EXPECT_KINDS.join(', ')})`);
  const allowed = EXPECT_FLAGS[kind];
  for (const k of EXPECT_ALL_FLAGS) {
    if (!a.flags.has(k) || k === 'shot-on-error' || allowed.includes(k)) continue;
    throw new ScriptError(`--${k} ne s'applique pas à expect ${kind} (usage : ${EXPECT_USAGE[kind]})`);
  }
  const usage = () => {
    // `~` non cité dans un terminal : la shell le remplace par le dossier personnel, d'où un argument de trop.
    const tilde = (kind === 'url' || kind === 'title' || kind === 'value') && args.some((x) => x.startsWith('/') && x === process.env.HOME) ? " — dans un terminal, citez le ~ ('~') : la shell le remplace par votre dossier personnel" : '';
    return new ScriptError(`usage : grasp ${EXPECT_USAGE[kind]}${tilde}`);
  };
  const regex = a.flags.has('regex');
  const body: Record<string, unknown> = { kind };
  /** [~] <valeur> : `~` = contient. */
  const compared = (rest: string[]) => {
    if (rest.length === 2 && rest[0] === '~') {
      if (regex) throw new ScriptError(`expect ${kind} : « ~ » (contient) et --regex s'excluent`);
      body.expected = rest[1]; body.match = 'contains';
    } else if (rest.length === 1) { body.expected = rest[0]; body.match = regex ? 'regex' : 'exact'; } else throw usage();
  };
  switch (kind) {
    case 'text': case 'no-text':
      if (args.length !== 1) throw usage();
      body.expected = args[0];
      if (regex) body.match = 'regex';
      break;
    case 'url': case 'title': compared(args); break;
    case 'value':
      if (args.length < 2) throw usage();
      body.target = args[0];
      compared(args.slice(1));
      break;
    case 'sel': case 'no-sel':
      if (args.length !== 1) throw usage();
      body.target = args[0];
      break;
    default: if (args.length !== 0) throw usage();
  }
  for (const k of ['timeout', 'scope', 'since', 'ignore'] as const) {
    const v = value(a, k);
    if (v !== undefined) body[k] = v;
  }
  if (a.flags.has('shot-on-error')) body.shotOnError = true;
  try { expectSpecOf(body); } catch (e) { throw new ScriptError((e as Error).message); }
  const t = Number(body.timeout ?? EXPECT_DEFAULT_MS);
  return { cmd: 'expect', method: 'POST', path: '/expect', body, timeoutMs: t + 15_000 };
}

/** Valeur d'un eval : JSON, ou le type quand il n'y a pas de valeur JSON (undefined, symbole…). */
export function renderEval(j: { value?: unknown; type?: unknown }): string {
  const s = 'value' in j ? JSON.stringify(j.value) : undefined;
  return s !== undefined ? s : typeof j.type === 'string' ? j.type : 'undefined';
}
