import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { GraspPaths } from '../core/paths.js';
import { request, type Endpoint, type HttpResult } from '../core/http.js';
import { formatEntry, type ConsoleEntry, type ConsoleResult } from '../core/console.js';
import { buildRequest, ScriptError, type Args, type StepRequest } from '../core/script.js';
import { formatReport, type RunResult } from '../control/run.js';

/**
 * `grasp mcp` : serveur MCP (Model Context Protocol) sur stdio, JSON-RPC 2.0, un message JSON par ligne.
 * Client mince de l'API HTTP du control plane, comme la CLI : chaque outil devient une ligne de commande
 * Grasp (`Args`), traduite en requête par `buildRequest` (src/core/script.ts), exactement comme la CLI et
 * `grasp run` la construisent. Aucune logique métier ici.
 * stdout est réservé au protocole ; tout journal part sur stderr.
 */

/** Versions du protocole MCP dont ce serveur respecte le contrat (initialize, tools/list, tools/call, ping). */
export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;

export interface McpOptions {
  paths: GraspPaths;
  env: NodeJS.ProcessEnv;
  /** Session existante à réutiliser (--session, GRASP_SESSION) : jamais fermée par `grasp mcp`. */
  session?: string | undefined;
  /** Profil de la session créée par `grasp mcp` (--profile). */
  profile?: string | undefined;
  /** Démarre `grasp serve` (processus enfant) si le control plane est injoignable ; défaut : oui. */
  autoServe: boolean;
}

class GraspCallError extends Error {
  constructor(message: string, readonly status: number, readonly extra?: Record<string, unknown>) { super(message); }
}

const log = (m: string): void => { process.stderr.write(`grasp mcp: ${m}\n`); };

function endpointOf(paths: GraspPaths): Endpoint {
  if (existsSync(paths.endpointFile)) return JSON.parse(readFileSync(paths.endpointFile, 'utf8')) as Endpoint;
  return { transport: 'unix', socketPath: paths.socketPath };
}

function unreachable(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ECONNREFUSED';
}

// ---------- Client du control plane ----------

class Client {
  /** Session utilisée par les outils ; créée au premier appel si aucune n'est imposée. */
  private session: string | undefined;
  private ownSession = false;
  private creating: Promise<string> | undefined;
  private server: ChildProcess | undefined;
  private starting: Promise<void> | undefined;

  constructor(private readonly o: McpOptions) { this.session = o.session; }

  async call(method: string, path: string, body?: unknown, timeoutMs?: number, withSession = true): Promise<HttpResult> {
    await this.ensureServer();
    const headers: Record<string, string> = { authorization: `Bearer ${this.token()}` };
    const session = withSession ? await this.ensureSession() : undefined;
    if (session !== undefined) headers['x-grasp-session'] = session;
    let r: HttpResult;
    try { r = await request(endpointOf(this.o.paths), method, path, body, headers, timeoutMs); } catch (e) {
      if (unreachable(e)) throw new GraspCallError('serveur Grasp injoignable — lancez `grasp serve` (ou relancez `grasp mcp`)', 502);
      throw e;
    }
    if (r.status >= 400) {
      let msg = r.text();
      let extra: Record<string, unknown> | undefined;
      try { extra = r.json() as Record<string, unknown>; msg = String(extra.error ?? msg); } catch { /* texte brut */ }
      // Session créée par nous et disparue (navigateur arrêté, bridge mort) : la suivante sera neuve, et on le dit.
      if (r.status === 404 && this.ownSession && session !== undefined && msg.startsWith(`session ${session} inconnue`)) {
        this.session = undefined;
        this.ownSession = false;
        msg += ' — `grasp mcp` en ouvrira une nouvelle au prochain appel (page vierge : renaviguez)';
      }
      throw new GraspCallError(msg, r.status, extra);
    }
    return r;
  }

  private token(): string {
    try { return readFileSync(this.o.paths.tokenFile, 'utf8').trim(); } catch {
      throw new GraspCallError(`token introuvable (${this.o.paths.tokenFile}) : le serveur n'a jamais démarré — \`grasp serve\``, 502);
    }
  }

  private async healthy(): Promise<boolean> {
    try { return (await request(endpointOf(this.o.paths), 'GET', '/health', undefined, {}, 5000)).status === 200; } catch { return false; }
  }

  /** Control plane joignable, ou démarré ici (enfant `grasp serve`, stdout redirigé vers stderr). */
  private ensureServer(): Promise<void> {
    if (this.server !== undefined && this.server.exitCode === null) return this.starting ?? Promise.resolve();
    this.starting ??= (async () => {
      try {
        if (await this.healthy()) return;
        if (!this.o.autoServe) throw new GraspCallError('serveur Grasp injoignable — lancez `grasp serve` (ou `grasp mcp` sans --no-serve)', 502);
        const main = fileURLToPath(new URL('./main.js', import.meta.url));
        log('control plane injoignable : démarrage de `grasp serve` (arrêté avec `grasp mcp`)');
        // stdout du serveur et de ses bridges → stderr : stdout appartient au protocole.
        const child = spawn(process.execPath, [main, 'serve'], { env: this.o.env, stdio: ['ignore', process.stderr, process.stderr] });
        this.server = child;
        const end = Date.now() + 30_000;
        while (Date.now() < end) {
          if (child.exitCode !== null) throw new GraspCallError(`\`grasp serve\` s'est arrêté au démarrage (code ${child.exitCode}) — voir le journal de grasp mcp (stderr)`, 502);
          if (await this.healthy()) return;
          await new Promise((r) => setTimeout(r, 100));
        }
        throw new GraspCallError('`grasp serve` ne répond pas après 30 s', 504);
      } finally { this.starting = undefined; }
    })();
    return this.starting;
  }

  private ensureSession(): Promise<string> {
    if (this.session !== undefined) return Promise.resolve(this.session);
    this.creating ??= (async () => {
      try {
        const r = await this.call('POST', '/sessions', this.o.profile !== undefined ? { profile: this.o.profile } : {}, 180_000, false);
        const id = (r.json() as { id: string }).id;
        this.session = id;
        this.ownSession = true;
        log(`session ${id} créée${this.o.profile !== undefined ? ` (profil ${this.o.profile})` : ''}`);
        return id;
      } finally { this.creating = undefined; }
    })();
    return this.creating;
  }

  currentSession(): Promise<string> { return this.ensureSession(); }

  /** Fin de `grasp mcp` : ferme la session qu'il a créée et le serveur qu'il a lancé, rien d'autre. */
  async close(): Promise<void> {
    if (this.ownSession && this.session !== undefined) {
      const id = this.session;
      this.session = undefined;
      try {
        await request(endpointOf(this.o.paths), 'DELETE', `/sessions/${encodeURIComponent(id)}`, undefined, { authorization: `Bearer ${this.token()}` }, 30_000);
        log(`session ${id} fermée`);
      } catch (e) { log(`fermeture de la session ${id} impossible : ${(e as Error).message}`); }
    }
    const child = this.server;
    if (child !== undefined && child.exitCode === null) {
      child.kill('SIGTERM');
      const exited = await new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(false), 20_000);
        child.once('exit', () => { clearTimeout(t); resolve(true); });
      });
      if (!exited) { log('`grasp serve` ne répond pas à SIGTERM : SIGKILL'); child.kill('SIGKILL'); }
      else log('`grasp serve` arrêté');
    }
  }
}

// ---------- Outils ----------

type Json = Record<string, unknown>;
interface Content { type: 'text'; text: string }
interface ImageContent { type: 'image'; data: string; mimeType: string }
export interface ToolResult { content: Array<Content | ImageContent>; isError?: boolean }

interface Prop { type: 'string' | 'integer' | 'boolean'; description: string; enum?: string[]; minimum?: number }
interface Tool {
  name: string;
  description: string;
  props: Record<string, Prop>;
  required?: string[];
  readOnly?: boolean;
  /** Arguments déjà validés → résultat. */
  run(c: Client, a: Json): Promise<ToolResult>;
}

class ArgError extends Error {}

const S = (description: string, extra: Partial<Prop> = {}): Prop => ({ type: 'string', description, ...extra });
const I = (description: string, minimum = 0): Prop => ({ type: 'integer', description, minimum });
const B = (description: string): Prop => ({ type: 'boolean', description });

const TARGET = S('Sélecteur : ref issue de snap (e5k2), CSS (#id, css:…), texte accessible (text:Valider), ou frame=<css de l\'iframe> >> <css|text:…>');
const ACTION_PROPS: Record<string, Prop> = {
  snapDiff: B('Renvoie le diff du snapshot (+ apparu, - disparu, ~ modifié) calculé après stabilité du DOM, dans le même appel. Recommandé : évite un snap de vérification.'),
  max: I('Limite du diff en caractères (défaut 4000).', 1),
  scope: S('Restreint le diff à une zone (ref ou CSS).'),
  console: B('Joint les entrées console produites pendant l\'action (200 au plus).'),
  shotOnError: B('En cas d\'échec, capture du viewport ; son chemin est ajouté au message d\'erreur.'),
  engine: S('Moteur de l\'action (défaut native ; playwright = moteur de repli, playwright-core requis).', { enum: ['native', 'playwright'] }),
};
const NAV_PROPS: Record<string, Prop> = { snapDiff: ACTION_PROPS.snapDiff!, max: ACTION_PROPS.max!, scope: ACTION_PROPS.scope!, console: ACTION_PROPS.console!, shotOnError: ACTION_PROPS.shotOnError! };

/** Nom d'argument MCP (camelCase) → option de la CLI. */
const FLAG: Record<string, string> = {
  snapDiff: 'snap-diff', shotOnError: 'shot-on-error', nameMax: 'name-max', maxWidth: 'max-width',
};

/** Arguments → ligne de commande Grasp (positionnels dans l'ordre donné, le reste en options). */
function toArgs(cmd: string, a: Json, positional: string[]): Args {
  const pos: string[] = [];
  for (const k of positional) if (a[k] !== undefined) pos.push(String(a[k]));
  const flags = new Map<string, string | true>();
  for (const [k, v] of Object.entries(a)) {
    if (positional.includes(k) || v === undefined || v === false) continue;
    flags.set(FLAG[k] ?? k, v === true ? true : String(v));
  }
  return { cmd, pos, flags };
}

const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] });

async function send(c: Client, rq: StepRequest): Promise<HttpResult> {
  return c.call(rq.method, rq.path, rq.body, rq.timeoutMs);
}

function consoleBlock(cons: { entries: ConsoleEntry[]; seq: number; since?: number; omitted?: number; dropped?: number }): string[] {
  const lines = cons.entries.map(formatEntry);
  if (typeof cons.dropped === 'number' && cons.dropped > 0) lines.push(`AVERTISSEMENT : ${cons.dropped} entrée(s) console perdue(s) avant lecture (tampon circulaire de 1000 entrées)`);
  if (typeof cons.omitted === 'number' && cons.omitted > 0) lines.push(`AVERTISSEMENT : ${cons.omitted} ligne(s) console plus ancienne(s) non jointe(s)${typeof cons.since === 'number' ? ` — outil console avec since=${cons.since}, limit=1000` : ''}`);
  lines.push(`console : ${cons.entries.length === 0 ? 'aucune nouvelle entrée, ' : ''}seq courant ${cons.seq}`);
  return lines;
}

/** Action mutante : notes, puis OK ou le diff, puis la console (même rendu que la CLI, notes comprises). */
function actionTool(name: string, positional: string[], description: string, props: Record<string, Prop>, required: string[], map?: (a: Json) => Json): Tool {
  return {
    name, description, required,
    props: { ...props },
    async run(c, a) {
      const args = map !== undefined ? map(a) : a;
      const j = (await send(c, buildRequest(toArgs(name, args, positional)))).json() as { diff?: string; detail?: string; console?: Parameters<typeof consoleBlock>[0] };
      const lines: string[] = [];
      if (j.detail) lines.push(`note: ${j.detail}`);
      lines.push(j.diff !== undefined ? j.diff : 'OK');
      if (j.console !== undefined) lines.push(...consoleBlock(j.console));
      return text(lines.join('\n'));
    },
  };
}

const TOOLS: Tool[] = [
  actionTool('nav', ['url'], 'Navigue vers une URL (soumise à l\'allowlist de Grasp) et attend la stabilité de la page.', { url: S('URL absolue (http/https).'), ...NAV_PROPS }, ['url']),
  {
    name: 'snap', readOnly: true,
    description: 'Snapshot de l\'arbre d\'accessibilité : une ligne par nœud « ref:rôle "nom" [états] ». Les refs (e5k2) sont stables et servent de sélecteur aux actions. Budget 12 000 octets par défaut, troncature annoncée en dernière ligne.',
    props: { max: I('Budget en octets.', 1), scope: S('Zone : ref, CSS ou text: (refs identiques à celles du snapshot complet) ; frame=<css> pour l\'arbre ARIA d\'une iframe (sans refs).'), nameMax: I('Longueur maximale des noms (défaut 80) ; 0 = noms entiers.') },
    async run(c, a) { return text((await send(c, buildRequest(toArgs('snap', a, [])))).text()); },
  },
  {
    name: 'text', readOnly: true,
    description: 'Texte visible (innerText) de la page ou d\'une zone ; 4000 caractères par défaut, coupure annoncée. La preuve qu\'une action a réussi, c\'est le contenu de la page. markdown=true : même texte visible structuré en Markdown (titres, listes, liens, tableaux, code).',
    props: { max: I('Limite en caractères.', 1), scope: S('Zone : ref, CSS, text: ou frame=<css de l\'iframe> [>> sél].'), markdown: B('Sortie Markdown (grasp text --markdown).') },
    async run(c, a) {
      const t = (await send(c, buildRequest(toArgs('text', a, [])))).text();
      return text(t !== '' ? t : `note: aucun texte visible ${typeof a.scope === 'string' ? `dans la zone ${a.scope}` : 'dans la page'}`);
    },
  },
  actionTool('click', ['target'], 'Clic souris réel au centre de l\'élément, livraison vérifiée. Sélecteur ambigu ou ref disparue → erreur avec les refs candidates, jamais de choix arbitraire.', { target: TARGET, ...ACTION_PROPS }, ['target']),
  actionTool('fill', ['target', 'value'], 'Remplace le contenu d\'un champ (ou d\'un éditeur riche) et vérifie la valeur effective. Mot de passe ou jeton : value="secret:NOM" (outil secrets) — la valeur est prise côté serveur, refusée hors des domaines du secret, et rendue secret:NOM dans toutes les sorties.', { target: TARGET, value: S('Valeur, ou secret:NOM pour un secret du serveur.'), ...ACTION_PROPS }, ['target', 'value']),
  {
    name: 'secrets', readOnly: true,
    description: 'Secrets utilisables avec fill value="secret:NOM" : noms et domaines autorisés, jamais les valeurs.',
    props: {},
    async run(c) {
      const r = (await c.call('GET', '/secrets')).json() as { secrets: Array<{ name: string; domains: string[] }>; error?: string };
      if (r.error !== undefined) return { content: [{ type: 'text', text: `magasin de secrets illisible : ${r.error}` }], isError: true };
      return text(r.secrets.length === 0 ? 'aucun secret (l\'utilisateur les déclare : grasp secrets set NOM --domains hôte)' : r.secrets.map((s) => `secret:${s.name} — ${s.domains.join(', ')}`).join('\n'));
    },
  },
  actionTool('type', ['target', 'text'], 'Frappe touche par touche, ajoutée à la position du curseur (autocomplétions). Pour remplacer une valeur, préférez fill.', { target: TARGET, text: S('Texte à taper.'), delay: I('Délai entre deux touches, 0 à 1000 ms.'), ...ACTION_PROPS }, ['target', 'text']),
  actionTool('select', ['target', 'value'], 'Choisit une option d\'un <select> natif, par valeur ou libellé (options listées si absente).', { target: TARGET, value: S('Valeur ou libellé de l\'option.'), ...ACTION_PROPS }, ['target', 'value']),
  actionTool('check', ['target'], 'Coche (ou décoche avec checked=false) une case ou un bouton radio, puis vérifie l\'état.', { target: TARGET, checked: B('true (défaut) pour cocher, false pour décocher.'), ...ACTION_PROPS }, ['target'],
    (a) => { const { checked, ...rest } = a; return checked === false ? { ...rest, uncheck: true } : rest; }),
  actionTool('press', ['key', 'target'], 'Appuie sur une touche (Enter, Tab, Escape, ArrowDown, a, Control+a…), sur l\'élément donné ou l\'élément focalisé.', { key: S('Touche ou combinaison.'), target: { ...TARGET, description: `Facultatif. ${TARGET.description}` }, ...ACTION_PROPS }, ['key']),
  actionTool('hover', ['target'], 'Survol : pointeur déplacé au centre de l\'élément (menus au survol, infobulles).', { target: TARGET, ...ACTION_PROPS }, ['target']),
  {
    name: 'wait', readOnly: true,
    description: 'Attend un texte visible, un élément, ou une page stable (DOM et réseau calmes, défaut). Délai dépassé → erreur. nav et snapDiff attendent déjà la stabilité.',
    props: { text: S('Texte attendu dans la page.'), sel: S('Élément attendu (CSS visible, ref ou text: présent).'), idle: B('Attendre seulement la stabilité.'), timeout: I('Délai en ms (défaut 10000).', 1) },
    async run(c, a) {
      const j = (await send(c, buildRequest(toArgs('wait', a, [])))).json() as { waited: number; condition: string };
      return text(`OK (attendu ${j.waited} ms : ${j.condition})`);
    },
  },
  {
    name: 'console', readOnly: true,
    description: 'Journal du navigateur (console.*, exceptions, requêtes en échec, blocages du garde), une ligne par entrée « #seq niveau source texte ». 50 dernières lignes par défaut ; repartez du seq courant avec since.',
    props: { level: S('Niveau minimal.', { enum: ['error', 'warn', 'info', 'debug'] }), since: I('Entrées postérieures à ce seq.'), limit: I('Les N dernières lignes (défaut 50).', 1), clear: B('Vide le tampon après lecture.') },
    async run(c, a) {
      const r = (await send(c, buildRequest(toArgs('console', a, [])))).json() as ConsoleResult;
      const lines = r.entries.map(formatEntry);
      if (r.dropped > 0) lines.push(`AVERTISSEMENT : ${r.dropped} entrée(s) perdue(s) avant lecture (tampon circulaire de 1000 entrées)`);
      if (r.omitted > 0) lines.push(`${r.omitted} ligne(s) plus ancienne(s) non affichée(s) — limit ou since`);
      lines.push(`seq courant : ${r.seq} — suite : since=${r.seq}${a.clear === true ? ' (tampon vidé)' : ''}`);
      return text(lines.join('\n'));
    },
  },
  {
    name: 'screenshot', readOnly: true,
    description: 'Capture d\'écran enregistrée (fichier 0600 dans l\'état de Grasp) : renvoie son CHEMIN et ses dimensions, pas l\'image (lisez le fichier si besoin). image=true joint aussi l\'image au résultat (coûteux en tokens : réduisez avec maxWidth).',
    props: {
      full: B('Page entière.'), el: S('Découpe sur un élément (ref, CSS, text:).'), format: S('Format.', { enum: ['png', 'jpeg', 'webp'] }),
      quality: I('Qualité jpeg/webp, 1 à 100.', 1), maxWidth: I('Largeur maximale en px (réduction d\'échelle).', 1), refs: B('Dessine les refs du snapshot sur les éléments interactifs.'),
      image: B('Joint aussi l\'image (base64) au résultat.'),
    },
    async run(c, a) {
      const { image, ...rest } = a;
      const j = (await send(c, buildRequest(toArgs('screenshot', rest, [])))).json() as { path: string; width: number; height: number; bytes: number; format: string; truncated?: boolean };
      const lines = [j.path, `${j.width}×${j.height} ${j.format}, ${j.bytes} octets`];
      if (j.truncated === true) lines.push('AVERTISSEMENT : capture tronquée (limite de 16384 px de Chrome)');
      const res = text(lines.join('\n'));
      if (image === true) res.content.push({ type: 'image', data: readFileSync(j.path).toString('base64'), mimeType: `image/${j.format}` });
      return res;
    },
  },
  {
    name: 'run',
    description: 'Exécute un script grasp run : plusieurs commandes en UN appel, une par ligne, même syntaxe que la CLI (nav, snap, text, click, fill, select, check, press, hover, type, wait, expect, eval, console, screenshot, cookies, upload, profile), commentaires #, guillemets à la shell. Analysé en entier avant exécution ; arrêt au premier échec sauf continue=true. Recette : lignes `expect text|no-text|url|title|sel|no-sel|value|no-console-errors|no-form-errors …` ; avec un expect, rapport de recette joint d\'office (report=false pour l\'omettre).',
    props: { script: S('Le script, une commande par ligne.'), continue: B('Poursuivre après une étape en échec.'), report: B('Rapport de recette (étapes, erreurs console, requêtes en échec, formulaire, page finale) : d\'office avec un expect.') },
    required: ['script'],
    async run(c, a) {
      const r = (await c.call('POST', '/run', { script: a.script, ...(a.continue === true ? { continue: true } : {}), ...(typeof a.report === 'boolean' ? { report: a.report } : {}) }, 60 * 60_000)).json() as RunResult;
      const lines: string[] = [];
      for (const st of r.steps) {
        lines.push(`[${st.n}] ${st.text} → ${st.ok ? 'OK' : `ERROR: ${st.error ?? 'échec'}`}`);
        if (st.detail !== undefined) lines.push(`[${st.n}] note: ${st.detail}`);
        if (st.output !== undefined) lines.push(st.output);
      }
      const failed = r.steps.filter((st) => !st.ok).length;
      const notRun = r.total - r.executed;
      lines.push(`${r.total} commande(s), ${r.steps.length - failed} OK${failed > 0 ? `, ${failed} en échec` : ''}${notRun > 0 ? `, ${notRun} non exécutée(s)` : ''}`);
      if (r.report !== undefined) lines.push(formatReport(r.report));
      return { content: [{ type: 'text', text: lines.join('\n') }], ...(r.ok ? {} : { isError: true }) };
    },
  },
  {
    name: 'profile',
    description: 'Sans name : liste les profils (* = celui de la session). Avec name : bascule la session sur ce profil (Chrome relancé avec ses cookies et connexions, la page repart de about:blank).',
    props: { name: S('Profil vers lequel basculer.') },
    async run(c, a) {
      if (typeof a.name !== 'string') {
        const r = (await c.call('GET', '/profiles')).json() as { current: string | null; profiles: Array<{ name: string; accountEmail: string | null; useWhen?: string; running: boolean }>; root: string };
        if (r.profiles.length === 0) return text(`aucun profil (${r.root})`);
        return text(r.profiles.map((p) => `${p.name === r.current ? '*' : ' '} ${p.name}${p.accountEmail ? ` (${p.accountEmail})` : ''}${p.running ? ' [ouvert]' : ''}${p.useWhen ? ` — ${p.useWhen}` : ''}`).join('\n'));
      }
      const id = await c.currentSession();
      const j = (await c.call('POST', `/sessions/${encodeURIComponent(id)}/profile`, { name: a.name }, 180_000)).json() as { unchanged: boolean; profile: string; previous: string | null };
      return text(j.unchanged ? `OK (la session est déjà sur le profil « ${a.name} »)` : `OK — profil ${j.previous ?? '(éphémère)'} → ${j.profile} ; navigateur relancé, la page repart de about:blank`);
    },
  },
];

export function toolList(): Json[] {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: { type: 'object', properties: t.props, ...(t.required ? { required: t.required } : {}), additionalProperties: false },
    ...(t.readOnly ? { annotations: { readOnlyHint: true } } : {}),
  }));
}

/** Arguments refusés plutôt qu'ignorés : un argument inconnu ou mal typé ne change jamais le sens d'un appel en silence. */
function validate(t: Tool, args: unknown): Json {
  if (args === undefined || args === null) args = {};
  if (typeof args !== 'object' || Array.isArray(args)) throw new ArgError('arguments : objet attendu');
  const a = args as Json;
  for (const [k, v] of Object.entries(a)) {
    const p = t.props[k];
    if (p === undefined) throw new ArgError(`argument inconnu « ${k} » pour ${t.name} (arguments : ${Object.keys(t.props).join(', ') || 'aucun'})`);
    if (v === null) { delete a[k]; continue; }
    if (p.type === 'string' && typeof v !== 'string') throw new ArgError(`« ${k} » : chaîne attendue`);
    if (p.type === 'boolean' && typeof v !== 'boolean') throw new ArgError(`« ${k} » : booléen attendu`);
    if (p.type === 'integer' && (typeof v !== 'number' || !Number.isInteger(v) || (p.minimum !== undefined && v < p.minimum))) throw new ArgError(`« ${k} » : entier${p.minimum !== undefined ? ` ≥ ${p.minimum}` : ''} attendu`);
    if (p.enum !== undefined && !p.enum.includes(v as string)) throw new ArgError(`« ${k} » : ${p.enum.join(' | ')} attendu`);
  }
  if (t.required !== undefined) for (const k of t.required) if (a[k] === undefined) throw new ArgError(`argument « ${k} » requis pour ${t.name}`);
  return a;
}

/** Erreur Grasp → résultat isError avec le message du serveur (candidats de refs, chemin de capture, console). */
function errorResult(e: unknown): ToolResult {
  const lines = [`ERROR: ${(e as Error).message}`];
  if (e instanceof GraspCallError && e.extra !== undefined) {
    const x = e.extra;
    const cands = Array.isArray(x.candidates) ? x.candidates as Array<{ ref: string; role: string; name: string }> : [];
    // Les candidats sont déjà dans le message ; on ne les répète que s'ils n'y figurent pas.
    const missing = cands.filter((cd) => !lines[0]!.includes(cd.ref));
    if (missing.length > 0) lines.push(`candidats : ${missing.map((cd) => `${cd.ref} ${cd.role} "${cd.name}"`).join(', ')}`);
    if (Array.isArray(x.console)) {
      lines.push(...consoleBlock({ entries: x.console as ConsoleEntry[], seq: Number(x.consoleSeq ?? 0), ...(typeof x.consoleSince === 'number' ? { since: x.consoleSince } : {}), ...(typeof x.consoleOmitted === 'number' ? { omitted: x.consoleOmitted } : {}), ...(typeof x.consoleDropped === 'number' ? { dropped: x.consoleDropped } : {}) }));
    }
  }
  return { content: [{ type: 'text', text: lines.join('\n') }], isError: true };
}

async function callTool(c: Client, name: unknown, args: unknown): Promise<ToolResult> {
  const t = TOOLS.find((x) => x.name === name);
  if (t === undefined) throw new RpcError(-32602, `outil inconnu « ${String(name)} » (outils : ${TOOLS.map((x) => x.name).join(', ')})`);
  try { return await t.run(c, validate(t, args)); } catch (e) {
    if (e instanceof ArgError || e instanceof ScriptError) return errorResult(new Error(`${t.name} : ${e.message}`));
    return errorResult(e);
  }
}

// ---------- JSON-RPC 2.0 ----------

class RpcError extends Error {
  constructor(readonly code: number, message: string) { super(message); }
}

const INSTRUCTIONS = `Grasp pilote un vrai Chrome par l'arbre d'accessibilité.
Boucle type : nav → snap (refs e5k2) → click/fill/select/check avec snapDiff=true (le diff montre l'effet) → text pour vérifier le résultat dans la page.
Sélecteurs : ref de snap, CSS (#id) ou text:Libellé. Sélecteur ambigu ou ref disparue : erreur avec les refs candidates, refaites snap.
Plusieurs étapes connues d'avance : outil run (un seul appel). screenshot renvoie un chemin de fichier.`;

function pkgVersion(): string {
  try { return (JSON.parse(readFileSync(fileURLToPath(new URL('../../../package.json', import.meta.url)), 'utf8')) as { version: string }).version; } catch { return '0.0.0'; }
}

async function handle(c: Client, msg: unknown): Promise<Json | undefined> {
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'requête invalide' } };
  const m = msg as Json;
  const id = m.id;
  const isRequest = 'id' in m && (typeof id === 'string' || typeof id === 'number');
  if (m.jsonrpc !== '2.0' || typeof m.method !== 'string') {
    // Réponse d'un client à une requête que nous n'envoyons pas : ignorée.
    if (!('method' in m) && ('result' in m || 'error' in m)) return undefined;
    return { jsonrpc: '2.0', id: isRequest ? id : null, error: { code: -32600, message: 'requête invalide (jsonrpc "2.0" et method attendus)' } };
  }
  if (!isRequest) return undefined; // notification (initialized, cancelled…) : jamais de réponse
  const params = (m.params ?? {}) as Json;
  try {
    let result: unknown;
    switch (m.method) {
      case 'initialize': {
        const asked = params.protocolVersion;
        const version = typeof asked === 'string' && (PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : PROTOCOL_VERSIONS[0];
        result = { protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'grasp', version: pkgVersion() }, instructions: INSTRUCTIONS };
        break;
      }
      case 'ping': result = {}; break;
      case 'tools/list': result = { tools: toolList() }; break;
      case 'tools/call': result = await callTool(c, params.name, params.arguments); break;
      default: throw new RpcError(-32601, `méthode inconnue « ${m.method} »`);
    }
    return { jsonrpc: '2.0', id, result };
  } catch (e) {
    if (e instanceof RpcError) return { jsonrpc: '2.0', id, error: { code: e.code, message: e.message } };
    log(`erreur interne (${m.method}) : ${(e as Error).stack ?? String(e)}`);
    return { jsonrpc: '2.0', id, error: { code: -32603, message: (e as Error).message } };
  }
}

/** Boucle stdio : une ligne = un message (ou un lot) ; rend la main quand stdin est fermé et le travail terminé. */
export async function runMcp(o: McpOptions): Promise<void> {
  const c = new Client(o);
  const pending = new Set<Promise<void>>();
  const write = (obj: unknown) => { process.stdout.write(`${JSON.stringify(obj)}\n`); };
  const onLine = (line: string) => {
    if (line.trim() === '') return;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON invalide' } }); return; }
    const p = (async () => {
      if (Array.isArray(parsed)) {
        if (parsed.length === 0) { write({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'lot vide' } }); return; }
        const out = (await Promise.all(parsed.map((x) => handle(c, x)))).filter((x) => x !== undefined);
        if (out.length > 0) write(out);
        return;
      }
      const r = await handle(c, parsed);
      if (r !== undefined) write(r);
    })().catch((e: Error) => log(`erreur : ${e.message}`));
    pending.add(p);
    void p.finally(() => pending.delete(p));
  };
  log(`prêt (stdio, protocole ${PROTOCOL_VERSIONS[0]})${o.session !== undefined ? ` — session ${o.session}` : ''}`);
  await new Promise<void>((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d: string) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    process.stdin.on('end', () => { if (buf !== '') onLine(buf); resolve(); });
    const stop = () => resolve();
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  });
  await Promise.allSettled([...pending]);
  await c.close();
}
