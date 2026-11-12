import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkSocketFallbackDir, fallbackSocketBase, type GraspPaths } from '../core/paths.js';
import { request, type Endpoint, type HttpResult } from '../core/http.js';
import { formatEntries, type ConsoleEntry, type ConsoleResult } from '../core/console.js';
import { BOUNDARY_RULE, wrapTagged, type BoundaryTag } from '../core/boundaries.js';
import { formatNetEntries, networkLosses, type NetEntry } from '../core/network.js';
import { formatTab, formatTabs, type TabInfo } from '../core/tabs.js';
import { renderViewport } from '../core/viewport.js';
import { buildRequest, RUN_COMMANDS, ScriptError, type Args, type StepRequest } from '../core/script.js';
import { formatReport, stateImportNotes, type RunResult } from '../control/run.js';
import { STATE_MAX_BYTES } from '../core/state.js';

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
  const ep: Endpoint = existsSync(paths.endpointFile) ? JSON.parse(readFileSync(paths.endpointFile, 'utf8')) as Endpoint : { transport: 'unix', socketPath: paths.socketPath };
  // Socket de repli sous /tmp (partagé) : le token n'y part que si le répertoire est bien le nôtre.
  const fb = paths.socketFallback;
  if (ep.transport === 'unix' && fb !== undefined && ep.socketPath.startsWith(`${fb.dir}/`)) checkSocketFallbackDir(fb.dir, fallbackSocketBase(), false);
  return ep;
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
  /** Notes reçues (en-tête X-Grasp-Notice : navigateur recyclé, onglet fermé par la page…) pas encore montrées. */
  private notices: string[] = [];

  constructor(private readonly o: McpOptions) { this.session = o.session; }

  /** Notes à joindre au résultat de l'outil en cours (une seule fois : la CLI les dit de même sur stderr). */
  takeNotices(): string[] { return this.notices.splice(0); }

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
    // Note du serveur sur cette commande, succès comme échec : consommée côté serveur, perdue si on ne la montre pas.
    const notice = r.headers['x-grasp-notice'];
    if (typeof notice === 'string' && notice !== '') {
      try { this.notices.push(decodeURIComponent(notice)); } catch { this.notices.push(notice); }
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
  network: B('Joint les requêtes réseau parties pendant l\'action (méthode, URL masquée, statut, durée ; 100 au plus ; exige allowConsole).'),
  shotOnError: B('En cas d\'échec, capture du viewport ; son chemin est ajouté au message d\'erreur.'),
  engine: S('Moteur de l\'action (défaut native ; playwright = moteur de repli, playwright-core requis).', { enum: ['native', 'playwright'] }),
  dialog: S('Réponse aux dialogues JS ouverts pendant l\'action : accept, dismiss, ou le texte d\'un prompt (accepté avec ce texte ; un texte ne confirme jamais un confirm, seul accept le fait). Sans : alert fermé, beforeunload accepté, confirm/prompt REFUSÉS. Le dialogue vu est toujours rapporté.'),
  follow: B('Si l\'action ouvre un popup ou un onglet (target=_blank), en faire l\'onglet actif (grasp … --follow).'),
};
const NAV_PROPS: Record<string, Prop> = { snapDiff: ACTION_PROPS.snapDiff!, max: ACTION_PROPS.max!, scope: ACTION_PROPS.scope!, console: ACTION_PROPS.console!, network: ACTION_PROPS.network!, shotOnError: ACTION_PROPS.shotOnError!, dialog: ACTION_PROPS.dialog! };

/** Nom d'argument MCP (camelCase) → option de la CLI. */
const FLAG: Record<string, string> = {
  snapDiff: 'snap-diff', shotOnError: 'shot-on-error', nameMax: 'name-max', maxWidth: 'max-width',
};
FLAG.untilStable = 'until-stable';
FLAG.maxSteps = 'max-steps';
FLAG.mobileUa = 'mobile-ua';

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

function consoleBlock(cons: { entries: ConsoleEntry[]; boundary?: BoundaryTag | undefined; seq: number; since?: number; omitted?: number; dropped?: number }): string[] {
  const lines = cons.entries.length > 0 ? [formatEntries(cons.entries, cons.boundary)] : [];
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
      const j = (await send(c, buildRequest(toArgs(name, args, positional)))).json() as { diff?: string; detail?: string; console?: Parameters<typeof consoleBlock>[0]; network?: { entries: NetEntry[]; boundary?: BoundaryTag; seq: number; since?: number; omitted?: number; dropped?: number } };
      const lines: string[] = [];
      if (j.detail) lines.push(`note: ${j.detail}`);
      lines.push(j.diff !== undefined ? j.diff : 'OK');
      if (j.console !== undefined) lines.push(...consoleBlock(j.console));
      if (j.network !== undefined) {
        if (j.network.entries.length > 0) lines.push(formatNetEntries(j.network.entries, j.network.boundary));
        lines.push(...networkLosses(j.network, true), `réseau : ${j.network.entries.length === 0 ? 'aucune requête, ' : ''}seq réseau courant ${j.network.seq}`);
      }
      return text(lines.join('\n'));
    },
  };
}

const TOOLS: Tool[] = [
  actionTool('nav', ['url'], 'Navigue vers une URL (soumise à l\'allowlist de Grasp) et attend la stabilité de la page.', { url: S('URL absolue (http/https).'), ...NAV_PROPS }, ['url']),
  actionTool('back', [], 'Page précédente de l\'historique de l\'onglet (route pushState d\'une application monopage comprise), garde de navigation appliqué, puis attente de stabilité comme nav. La note dit où l\'on arrive. Aucune page précédente → erreur.', { ...NAV_PROPS }, []),
  actionTool('forward', [], 'Page suivante de l\'historique de l\'onglet, comme back.', { ...NAV_PROPS }, []),
  actionTool('reload', [], 'Recharge la page courante (hard=true : sans le cache HTTP), garde appliqué, puis attente de stabilité comme nav.', { hard: B('Recharger sans le cache HTTP.'), ...NAV_PROPS }, []),
  actionTool('scroll', ['target'], 'Fait défiler la page, ou le conteneur target (un élément qui ne défile pas est amené dans la vue). Défaut : un écran vers le bas. untilStable=true : défile jusqu\'à ce qu\'aucun nouveau contenu n\'apparaisse (listes à défilement infini), en attendant la stabilité à chaque pas. La note donne la position et le nombre de nœuds apparus ; snapDiff montre les nouveaux éléments.', {
    target: { ...TARGET, description: `Facultatif : conteneur à faire défiler. ${TARGET.description}` },
    by: { type: 'integer', description: 'Décalage vertical en px (négatif : vers le haut).' },
    to: S('Bord à atteindre.', { enum: ['top', 'bottom'] }),
    untilStable: B('Défiler pas à pas tant que du contenu apparaît (10 pas par défaut).'),
    maxSteps: I('Nombre de pas au plus avec untilStable (1 à 50).', 1),
    ...NAV_PROPS,
  }, []),
  {
    name: 'snap', readOnly: true,
    description: 'Snapshot de l\'arbre d\'accessibilité : une ligne par nœud « ref:rôle "nom" [états] ». Les refs (e5k2) sont stables et servent de sélecteur aux actions. Budget 12 000 octets par défaut, troncature annoncée en dernière ligne.',
    props: {
      max: I('Budget en octets.', 1), scope: S('Zone : ref, CSS ou text: (refs identiques à celles du snapshot complet) ; frame=<css> pour l\'arbre ARIA d\'une iframe (sans refs).'), nameMax: I('Longueur maximale des noms (défaut 80) ; 0 = noms entiers.'),
      mode: S('Lecture partielle, mêmes refs : outline = repères et titres seulement (avec le volume de chaque repère), pour s\'orienter avant un snap ciblé (scope) ; interactive = éléments actionnables et champs avec leurs conteneurs et titres.', { enum: ['outline', 'interactive'] }),
    },
    async run(c, a) {
      const { mode, ...rest } = a;
      return text((await send(c, buildRequest(toArgs('snap', typeof mode === 'string' ? { ...rest, [mode]: true } : rest, [])))).text());
    },
  },
  {
    name: 'find', readOnly: true,
    description: 'Cherche dans le snapshot : renvoie seulement les lignes qui correspondent (nom entier, valeur, texte ; sans casse ni accents, ou /regex/), avec leur ref (identique au snapshot complet) et leur conteneur. Moins coûteux qu\'un snap complet pour retrouver un bouton, un champ ou une option.',
    props: {
      pattern: S('Texte cherché, ou /expression régulière/drapeaux (i, m, s, u).'), role: S('Rôle(s) retenu(s), séparés par des virgules (button, link, textbox, option, heading, text = texte brut…).'),
      max: I('Nombre maximal de lignes (défaut 30, 500 au plus).', 1), scope: S('Zone : ref, CSS ou text:.'), nameMax: I('Longueur maximale des noms (défaut 80) ; 0 = noms entiers.'),
    },
    required: ['pattern'],
    async run(c, a) { return text((await send(c, buildRequest(toArgs('find', a, ['pattern'])))).text()); },
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
      const lines = r.entries.length > 0 ? [formatEntries(r.entries, r.boundary)] : [];
      if (r.dropped > 0) lines.push(`AVERTISSEMENT : ${r.dropped} entrée(s) perdue(s) avant lecture (tampon circulaire de 1000 entrées)`);
      if (r.omitted > 0) lines.push(`${r.omitted} ligne(s) plus ancienne(s) non affichée(s) — limit ou since`);
      lines.push(`seq courant : ${r.seq} — suite : since=${r.seq}${a.clear === true ? ' (tampon vidé)' : ''}`);
      return text(lines.join('\n'));
    },
  },
  {
    name: 'network', readOnly: true,
    description: 'Journal réseau de l\'onglet, une ligne par requête « #seq MÉTHODE url → statut · durée · type » (URL masquée ; jamais d\'en-têtes ni de corps). 50 dernières par défaut ; repartez du seq réseau courant avec since. Exige allowConsole. Pour vérifier qu\'une action a appelé l\'API : run avec `expect request "POST /api/x" 201`.',
    props: { since: I('Requêtes postérieures à ce seq réseau.'), failed: B('Seulement les échecs (≥ 400, net::ERR, bloquées).'), max: I('Les N dernières (défaut 50).', 1), type: S('Types retenus, séparés par des virgules (document, xhr, fetch, script, image…).') },
    async run(c, a) {
      const r = (await send(c, buildRequest(toArgs('network', a, [])))).json() as { entries: NetEntry[]; seq: number; omitted?: number; dropped?: number; boundary?: BoundaryTag };
      const lines = r.entries.length > 0 ? [formatNetEntries(r.entries, r.boundary)] : [];
      lines.push(...networkLosses({ omitted: r.omitted, dropped: r.dropped }, false), `seq réseau courant : ${r.seq} — suite : since=${r.seq}`);
      return text(lines.join('\n'));
    },
  },
  {
    name: 'a11y', readOnly: true,
    description: 'Audit d\'accessibilité vérifiable sans interprétation (pas un audit WCAG) : contrôles sans nom, images sans alternative, erreurs non reliées à leur champ, libellés orphelins, références ARIA cassées, rôles invalides, titres sautés ; une ligne par problème avec sa ref et une correction. Pour faire échouer une recette : run avec `expect a11y [--max N]`.',
    props: { scope: S('Zone : ref ou CSS.'), max: I('Problèmes listés au plus (défaut 30, 500 au plus).', 1) },
    async run(c, a) {
      const j = (await send(c, buildRequest(toArgs('a11y', a, [])))).json() as { text: string; note: string };
      return text(`${j.text}\nnote: ${j.note}`);
    },
  },
  {
    name: 'tabs', readOnly: true,
    description: 'Onglets de la session, une ligne par onglet (* = actif ; « (ouvert par t1) » pour un popup). Les commandes visent l\'onglet actif ; un popup ouvert par une action est annoncé dans sa note.',
    props: {},
    async run(c) {
      const j = (await send(c, buildRequest(toArgs('tabs', {}, [])))).json() as { tabs: TabInfo[]; boundary?: BoundaryTag };
      return text(wrapTagged(formatTabs(j.tabs), j.boundary, 'onglets'));
    },
  },
  {
    name: 'tab',
    description: 'Onglet : id (t2) pour en faire l\'onglet actif ; new=true pour en ouvrir un (url facultative, vérifiée avant création) ; close=true pour fermer l\'onglet id (défaut : l\'actif ; jamais le dernier).',
    props: { id: S('Identifiant d\'onglet (t1, t2…).'), new: B('Ouvrir un nouvel onglet (url facultative).'), url: S('URL du nouvel onglet (avec new).'), close: B('Fermer l\'onglet id (défaut : l\'onglet actif).') },
    async run(c, a) {
      if (a.new === true && a.close === true) throw new ArgError('new et close s\'excluent');
      if (a.url !== undefined && a.new !== true) throw new ArgError('url ne s\'applique qu\'avec new=true');
      const pos = a.new === true ? ['new', ...(typeof a.url === 'string' ? [a.url] : [])] : a.close === true ? ['close', ...(typeof a.id === 'string' ? [a.id] : [])] : [String(a.id ?? '')];
      if (a.new === true && a.id !== undefined) throw new ArgError('id ne s\'applique pas avec new=true');
      const j = (await send(c, buildRequest({ cmd: 'tab', pos, flags: new Map() }))).json() as { closed?: string; active?: TabInfo; detail?: string; boundary?: BoundaryTag } & Partial<TabInfo>;
      const lines = j.detail ? [`note: ${j.detail}`] : [];
      lines.push(typeof j.closed === 'string' ? `OK — onglet ${j.closed} fermé ; onglet actif : ${wrapTagged(formatTab(j.active!).trim(), j.boundary, 'onglets')}` : wrapTagged(formatTab(j as TabInfo).trim(), j.boundary, 'onglets'));
      return text(lines.join('\n'));
    },
  },
  {
    name: 'viewport',
    description: 'Viewport émulé de l\'onglet (media queries, snap, text et captures le reflètent ; hérité par les popups). Sans size : réglage et mesures lues dans la page. size : « 360x800 », un appareil (iphone-se, iphone-14, pixel-7, galaxy-s8, ipad-mini, laptop, desktop) ou « reset ».',
    props: { size: S('LARGEURxHAUTEUR, nom d\'appareil, ou reset.'), device: S('Appareil de base (les autres options priment).'), mobile: B('Mode mobile de Chrome (<meta viewport>).'), dpr: S('devicePixelRatio (ex. 2, 3).'), touch: B('Écran tactile émulé.'), mobileUa: B('User agent Android (opt-in ; pour les requêtes suivantes).') },
    async run(c, a) {
      const j = (await send(c, buildRequest(toArgs('viewport', a, ['size'])))).json() as Parameters<typeof renderViewport>[0] & { detail?: string };
      return text([...(j.detail ? [`note: ${j.detail}`] : []), renderViewport(j)].join('\n'));
    },
  },
  {
    name: 'history', readOnly: true,
    description: 'Commandes déjà passées sur la session (500 au plus, en mémoire). asRun=true : script grasp run rejouable (refs traduites en sélecteurs durables, lectures et échecs omis, mots de passe jamais conservés) ; expect=true y ajoute les expect de l\'état final.',
    props: { since: I('Entrées postérieures à ce seq.'), limit: I('Les N dernières (défaut 50 ; sans asRun).', 1), asRun: B('Script grasp run rejouable.'), expect: B('Avec asRun : expect url, title et text de l\'état final.') },
    async run(c, a) {
      if (a.expect === true && a.asRun !== true) throw new ArgError('expect s\'applique avec asRun=true');
      if (a.limit !== undefined && a.asRun === true) throw new ArgError('limit ne s\'applique pas avec asRun=true (since restreint la fenêtre)');
      const q = new URLSearchParams();
      if (a.since !== undefined) q.set('since', String(a.since));
      if (a.limit !== undefined) q.set('limit', String(a.limit));
      if (a.asRun === true) q.set('asRun', '1');
      if (a.expect === true) q.set('expect', '1');
      const r = (await c.call('GET', `/history${q.size > 0 ? `?${q}` : ''}`)).json() as { script?: string; text?: string; seq: number; lost: number };
      const lines = r.lost > 0 ? [`AVERTISSEMENT : ${r.lost} entrée(s) plus ancienne(s) oubliée(s)`] : [];
      lines.push(a.asRun === true ? r.script ?? '' : r.text || '(historique vide)', `seq courant : ${r.seq}`);
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
    // Liste tirée de RUN_COMMANDS : une commande ajoutée à run est annoncée à l'agent MCP sans retouche ici.
    description: `Exécute un script grasp run : plusieurs commandes en UN appel, une par ligne, même syntaxe que la CLI (${RUN_COMMANDS.join(', ')}), commentaires #, guillemets à la shell. Viewport émulé : \`viewport 360x800 [--mobile] [--touch] [--dpr N]\`, \`viewport iphone-se\`, \`viewport reset\`.` + ' Analysé en entier avant exécution ; arrêt au premier échec sauf continue=true. Recette : lignes `expect text|no-text|url|title|sel|no-sel|value|no-console-errors|no-form-errors …` ; avec un expect, rapport de recette joint d\'office (report=false pour l\'omettre).',
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
    name: 'storage',
    // Mêmes contrôles que grasp storage : allowCookies, origine affichée dans l'allowlist, code fixe sans eval.
    description: 'Stockage Web (localStorage ou sessionStorage) de l\'origine AFFICHÉE, sans eval : get (valeur, 4000 caractères au plus), set, rm. Pour poser une session factice (jeton, profil) puis recharger la page : storage set, puis nav. Exige allowCookies (désactivé par défaut : 403 sinon) ; origine http(s) dans l\'allowlist ; sur about:blank, naviguez d\'abord (ou outil state_import, avant toute navigation).',
    props: { op: S('Opération.', { enum: ['get', 'set', 'rm'] }), area: S('Stockage visé.', { enum: ['local', 'session'] }), key: S('Clé (1 à 1000 caractères).'), value: S('Valeur (avec op=set seulement).') },
    required: ['op', 'area', 'key'],
    async run(c, a) {
      if ((a.op === 'set') !== (a.value !== undefined)) throw new ArgError(a.op === 'set' ? 'value requis avec op=set' : 'value ne s\'applique qu\'avec op=set');
      const pos = [String(a.op), String(a.area), String(a.key), ...(a.value !== undefined ? [String(a.value)] : [])];
      const j = (await send(c, buildRequest({ cmd: 'storage', pos, flags: new Map() }))).json() as { op: string; origin: string; area: string; key: string; value?: string | null; truncated?: number; existed?: boolean; boundary?: BoundaryTag };
      const where = `${j.area}Storage de ${j.origin}`;
      if (j.op === 'get') {
        // Clé absente : erreur, comme le code 1 de la CLI (jamais une valeur vide prise pour la bonne).
        if (j.value === null || j.value === undefined) return { content: [{ type: 'text', text: `ERROR: clé « ${j.key} » absente du ${where}` }], isError: true };
        // Valeur écrite par la page : encadrée si les frontières de contenu sont actives.
        return text([wrapTagged(j.value, j.boundary, 'stockage'), ...(j.truncated !== undefined ? [`AVERTISSEMENT : valeur tronquée à ${j.value.length} caractères sur ${j.truncated}`] : [])].join('\n'));
      }
      return text(`OK — ${j.op === 'rm' && j.existed === false ? `${where} : clé « ${j.key} » déjà absente` : where}`);
    },
  },
  {
    name: 'state_import',
    // Contenu donné en JSON (pas un chemin) : un agent MCP n'obtient pas de lecture de fichiers par cet outil.
    description: 'Importe un état (grasp state import) : cookies, localStorage par origine, sessionStorage — pour poser une session factice SANS eval, de préférence avant toute navigation (localStorage écrit sans requête au site ; sessionStorage appliqué au premier document de son origine). state : le JSON lui-même (format grasp-state v1 ou storageState Playwright), par ex. {"format":"grasp-state","version":1,"origins":[{"origin":"http://127.0.0.1:8080","localStorage":[{"name":"auth","value":"…"}]}]}. Exige allowCookies ; ce que l\'allowlist ne couvre pas est écarté et listé.',
    props: { state: S('État au format JSON (texte).') },
    required: ['state'],
    async run(c, a) {
      const state = parseStateArg(String(a.state));
      const j = (await c.call('POST', '/state/import', { state })).json() as Record<string, unknown>;
      return text(['OK', ...stateImportNotes(j)].join('\n'));
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

/**
 * Argument `state` de l'outil state_import : borné à `max` octets (STATE_MAX_BYTES, comme la route), puis analysé.
 * Message sans extrait : le texte peut contenir des jetons de session. `max` : paramètre pour les tests.
 */
export function parseStateArg(raw: string, max = STATE_MAX_BYTES): unknown {
  const n = Buffer.byteLength(raw);
  if (n > max) throw new ArgError(`state : ${n} octets (${max} au plus)`);
  try { return JSON.parse(raw); } catch { throw new ArgError('state : JSON invalide (format grasp-state v1 ou storageState Playwright attendu)'); }
}

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
      lines.push(...consoleBlock({ entries: x.console as ConsoleEntry[], boundary: x.boundary as BoundaryTag | undefined, seq: Number(x.consoleSeq ?? 0), ...(typeof x.consoleSince === 'number' ? { since: x.consoleSince } : {}), ...(typeof x.consoleOmitted === 'number' ? { omitted: x.consoleOmitted } : {}), ...(typeof x.consoleDropped === 'number' ? { dropped: x.consoleDropped } : {}) }));
    }
  }
  return { content: [{ type: 'text', text: lines.join('\n') }], isError: true };
}

async function callTool(c: Client, name: unknown, args: unknown): Promise<ToolResult> {
  const t = TOOLS.find((x) => x.name === name);
  if (t === undefined) throw new RpcError(-32602, `outil inconnu « ${String(name)} » (outils : ${TOOLS.map((x) => x.name).join(', ')})`);
  let res: ToolResult;
  try { res = await t.run(c, validate(t, args)); } catch (e) {
    res = e instanceof ArgError || e instanceof ScriptError ? errorResult(new Error(`${t.name} : ${e.message}`)) : errorResult(e);
  }
  return withNotices(res, c.takeNotices());
}

/** Notes du serveur (onglet fermé par la page, navigateur recyclé…) en tête du texte de l'outil : `note: …`. */
function withNotices(res: ToolResult, notes: string[]): ToolResult {
  if (notes.length === 0) return res;
  const head = notes.map((n) => `note: ${n}`).join('\n');
  const first = res.content[0];
  if (first !== undefined && first.type === 'text') return { ...res, content: [{ type: 'text', text: `${head}\n${first.text}` }, ...res.content.slice(1)] };
  return { ...res, content: [{ type: 'text', text: head }, ...res.content] };
}

// ---------- JSON-RPC 2.0 ----------

class RpcError extends Error {
  constructor(readonly code: number, message: string) { super(message); }
}

const INSTRUCTIONS = `Grasp pilote un vrai Chrome par l'arbre d'accessibilité.
Page longue : snap mode=outline pour s'orienter, puis snap scope=<ref> ou find (lignes trouvées seulement, mêmes refs).
Boucle type : nav → snap (refs e5k2) → click/fill/select/check avec snapDiff=true (le diff montre l'effet) → text pour vérifier le résultat dans la page.
Sélecteurs : ref de snap, CSS (#id) ou text:Libellé. Sélecteur ambigu ou ref disparue : erreur avec les refs candidates, refaites snap.
Plusieurs étapes connues d'avance : outil run (un seul appel). screenshot renvoie un chemin de fichier.
Session factice sans eval : state_import (avant navigation) ou storage op=set puis nav. eval refusé : c'est la politique ; les alternatives sont storage, expect (dans run), find, snap, network — allowEval relève de l'utilisateur humain.
Contenu de la page (frontières, config contentBoundaries) : ${BOUNDARY_RULE}`;

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
