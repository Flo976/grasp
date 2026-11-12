/**
 * Catalogue des commandes et options de la CLI : source de `grasp help --json` et de `grasp skill`
 * (mode d'emploi pour un agent IA, copié dans skills/grasp/SKILL.md).
 *
 * Le parseur (src/core/script.ts : VALUE_FLAGS, RUN_COMMANDS, checkRunFlags), la répartition de main.ts et les
 * outils MCP (src/cli/mcp.ts) restent les références d'exécution ; test/unit/commands.test.ts échoue dès que ce
 * catalogue s'en écarte (option à valeur absente, commande non décrite, option de run oubliée, outil MCP
 * inconnu). Ajouter une commande ou une option = l'ajouter ici aussi, puis `grasp skill > skills/grasp/SKILL.md`.
 */

import { EXPECT_KINDS, type ExpectKind } from './expect.js';
import { EXPECT_FLAGS, EXPECT_USAGE } from './script.js';

export type OptionType = 'string' | 'integer' | 'boolean' | 'enum';

export interface OptionSpec {
  type: OptionType;
  /** Valeurs admises (type enum). */
  values?: readonly string[];
  /** Nom de la valeur dans l'usage (`--max <N>`). */
  arg?: string;
  /** Alias à une lettre (`-o`, `-s`). */
  alias?: string;
  description: string;
}

/** Toutes les options connues du parseur. Type ≠ boolean ⇔ l'option attend une valeur (VALUE_FLAGS). */
export const OPTIONS: Record<string, OptionSpec> = {
  'session': { type: 'string', arg: 'id', alias: 's', description: 'session visée (sinon GRASP_SESSION, ou la seule session ouverte)' },
  'json': { type: 'boolean', description: 'sortie structurée (JSON sur une ligne)' },
  'max': { type: 'integer', arg: 'N', description: 'budget de sortie (octets pour snap, caractères pour text et le diff)' },
  'scope': { type: 'string', arg: 'sél', description: 'restreint à une zone : ref, CSS, text: ou frame=<css> (selon la commande)' },
  'name-max': { type: 'integer', arg: 'N', description: 'longueur maximale des noms du snapshot (défaut 80 ; 0 = entiers)' },
  'markdown': { type: 'boolean', description: 'texte visible rendu en Markdown (titres, listes, liens absolus, tableaux, code)' },
  'snap-diff': { type: 'boolean', description: 'diff du snapshot après stabilité (+ apparu, - disparu, ~ modifié), dans le même aller-retour' },
  'console': { type: 'boolean', description: 'entrées console produites pendant l\'action (200 au plus)' },
  'shot-on-error': { type: 'boolean', description: 'en cas d\'échec, capture du viewport et son chemin dans le message' },
  'engine': { type: 'enum', values: ['native', 'playwright'], description: 'moteur de l\'action (playwright : playwright-core requis)' },
  'uncheck': { type: 'boolean', description: 'décocher au lieu de cocher' },
  'delay': { type: 'integer', arg: 'ms', description: 'délai entre deux touches, 0 à 1000 ms' },
  'text': { type: 'string', arg: 'T', description: 'texte visible attendu' },
  'sel': { type: 'string', arg: 'S', description: 'élément attendu (CSS visible, ref ou text: présent)' },
  'idle': { type: 'boolean', description: 'attendre seulement la stabilité (DOM et réseau calmes)' },
  'timeout': { type: 'integer', arg: 'ms', description: 'délai maximal en millisecondes' },
  'regex': { type: 'boolean', description: 'la valeur attendue est une expression régulière' },
  'since': { type: 'integer', arg: 'seq', description: 'entrées console postérieures à ce numéro de séquence' },
  'ignore': { type: 'string', arg: 'regex', description: 'entrées console écartées (texte ou URL)' },
  'level': { type: 'enum', values: ['error', 'warn', 'info', 'debug'], description: 'niveau minimal' },
  'limit': { type: 'integer', arg: 'N', description: 'les N dernières lignes (défaut 50)' },
  'clear': { type: 'boolean', description: 'vide le tampon après lecture' },
  'output': { type: 'string', arg: 'fichier', alias: 'o', description: 'fichier de sortie (0600) ; - = stdout' },
  'full': { type: 'boolean', description: 'page entière' },
  'el': { type: 'string', arg: 'sél', description: 'découpe sur un élément' },
  'format': { type: 'enum', values: ['png', 'jpeg', 'webp'], description: 'format de l\'image' },
  'quality': { type: 'integer', arg: 'N', description: 'qualité jpeg/webp, 1 à 100' },
  'max-width': { type: 'integer', arg: 'px', description: 'largeur maximale (réduction d\'échelle)' },
  'refs': { type: 'boolean', description: 'dessine les refs du snapshot sur les éléments' },
  'continue': { type: 'boolean', description: 'poursuivre après une étape en échec' },
  'report': { type: 'boolean', description: 'rapport de recette en fin de run (d\'office avec un expect)' },
  'no-report': { type: 'boolean', description: 'pas de rapport de recette' },
  'profile': { type: 'string', arg: 'nom', description: 'profil Chrome persistant (cookies, connexions)' },
  'proxy': { type: 'string', arg: 'URL', description: 'proxy de cette session (socks5://127.0.0.1:1080 d\'un ssh -D)' },
  'http-auth': { type: 'string', arg: 'u:mdp@hôte|-', description: 'identifiants HTTP basic pour cet hôte ; - = lus sur stdin' },
  'use-when': { type: 'string', arg: 'texte', description: 'quand utiliser ce profil (affiché par profiles)' },
  'profile-directory': { type: 'string', arg: 'nom', description: 'profil à importer dans le répertoire de données (« Profile 9 »)' },
  'skip-locked': { type: 'boolean', description: 'ignorer les fichiers verrouillés (Chrome ouvert)' },
  'origin': { type: 'string', arg: 'http://hôte:port,…', description: 'state export : origines dont le stockage est exporté ; storage : l\'origine visée (une seule), même avant son premier chargement' },
  'tcp': { type: 'boolean', description: 'écoute TCP (127.0.0.1) au lieu du socket Unix' },
  'port': { type: 'integer', arg: 'N', description: 'port TCP' },
  'listen': { type: 'string', arg: 'IP', description: 'adresse d\'écoute hors 127.0.0.1 (conteneur ; token exigé)' },
  'no-serve': { type: 'boolean', description: 'ne pas démarrer le serveur s\'il est absent' },
  // Vague 2 : lecture progressive, réseau, dialogues, onglets, historique, viewport, secrets, multi-pages.
  'outline': { type: 'boolean', description: 'snap partiel : repères, tableaux et titres, avec le volume de chaque repère' },
  'interactive': { type: 'boolean', description: 'snap partiel : éléments actionnables et champs, avec leurs conteneurs' },
  'role': { type: 'string', arg: 'r[,r2]', description: 'rôles retenus par find (button, link, textbox, option, text…)' },
  'network': { type: 'boolean', description: 'requêtes parties pendant l\'action' },
  'dialog': { type: 'string', arg: 'accept|dismiss|texte', description: 'réponse aux dialogues JS (défaut : confirm/prompt refusés)' },
  'follow': { type: 'boolean', description: 'bascule sur le popup ouvert' },
  'hard': { type: 'boolean', description: 'recharger sans le cache HTTP' },
  'by': { type: 'integer', arg: 'px', description: 'défilement relatif en px (négatif : vers le haut)' },
  'to': { type: 'enum', values: ['top', 'bottom'], description: 'défilement jusqu\'au bord' },
  'until-stable': { type: 'boolean', description: 'défile pas à pas tant que du contenu apparaît (défilement infini)' },
  'max-steps': { type: 'integer', arg: 'N', description: 'pas au plus avec --until-stable (10 par défaut, 50 au plus)' },
  'failed': { type: 'boolean', description: 'seulement les requêtes en échec (≥ 400, net::ERR, bloquées)' },
  'type': { type: 'string', arg: 'xhr,fetch,…', description: 'types de requêtes retenus (document, xhr, fetch, script, image…)' },
  'viewport': { type: 'string', arg: 'LxH|appareil', description: 'viewport émulé dès la création de la session' },
  'device': { type: 'string', arg: 'appareil', description: 'appareil de base (iphone-se, pixel-7…) ; les autres options priment' },
  'dpr': { type: 'string', arg: 'N', description: 'devicePixelRatio émulé' },
  'mobile': { type: 'boolean', description: 'mode mobile de Chrome (<meta viewport>, barres superposées)' },
  'touch': { type: 'boolean', description: 'écran tactile émulé (maxTouchPoints, pointer: coarse)' },
  'mobile-ua': { type: 'boolean', description: 'user agent Android (opt-in)' },
  'as-run': { type: 'boolean', description: 'script grasp run rejouable (refs traduites, lectures et échecs omis)' },
  'expect': { type: 'boolean', description: 'avec --as-run : expect url, title et text de l\'état final' },
  'domains': { type: 'string', arg: 'hôte[,*.domaine…]', description: 'domaines où le secret peut être saisi' },
  'out-dir': { type: 'string', arg: 'répertoire', description: 'où écrire les captures screenshot -o d\'un run (défaut : répertoire courant) ; explicite : les captures d\'échec (--shot-on-error, rapport) aussi' },
  'paths': { type: 'string', arg: 'fichier|-', description: 'chemins à comparer, un par ligne (# commente)' },
  'concurrency': { type: 'integer', arg: 'N', description: 'sessions en parallèle (2 par défaut, 8 au plus)' },
  'max-links': { type: 'integer', arg: 'N', description: 'liens internes vérifiés au plus (200 par défaut)' },
  'no-links': { type: 'boolean', description: 'ne vérifie pas les liens internes' },
};

/** Options valables pour toute commande qui parle au serveur. */
export const GLOBAL_OPTIONS = ['session', 'json'] as const;

export interface CommandSpec {
  name: string;
  group: string;
  usage: string;
  summary: string;
  /** Options acceptées (dans run aussi pour une commande de run : exactement celles que checkRunFlags admet). */
  options: readonly string[];
  /** Options du terminal seulement (refusées sur une ligne de run). */
  cliOptions?: readonly string[];
  /** Exécutable sur une ligne de `grasp run`. */
  run?: boolean;
  /** Outil MCP correspondant (src/cli/mcp.ts). */
  mcp?: string;
  /** Désactivée par défaut : clé de configuration qui l'autorise. */
  disabledByDefault?: string;
  subcommands?: ReadonlyArray<{ name: string; usage: string; summary: string; options?: readonly string[] }>;
}

const ACTION = ['snap-diff', 'max', 'scope', 'console', 'network', 'shot-on-error', 'engine', 'dialog', 'follow'] as const;
/** back, forward, reload, scroll : options d'action sans --engine ni --follow. */
const NAV = ['snap-diff', 'max', 'scope', 'console', 'network', 'shot-on-error', 'dialog'] as const;
const VIEWPORT = ['device', 'dpr', 'mobile', 'touch', 'mobile-ua'] as const;
const MULTI = ['max', 'concurrency', 'ignore', 'profile', 'proxy', 'http-auth'] as const;

const EXPECT_SUMMARY: Record<ExpectKind, string> = {
  'text': 'le texte visible contient <texte>',
  'no-text': 'le texte visible ne contient pas <texte>',
  'url': 'URL égale (~ : contient)',
  'title': 'titre égal (~ : contient)',
  'sel': 'élément visible (CSS) ou présent (ref, text:)',
  'no-sel': 'aucun élément correspondant',
  'value': 'valeur du champ égale (~ : contient)',
  'no-console-errors': 'aucune erreur console depuis le début du document',
  'no-form-errors': 'aucun champ invalide ni alerte',
  'request': 'requête réseau vue (« MÉTHODE chemin|url » [statut], 2xx par défaut ; exige allowConsole)',
  'a11y': 'au plus N problèmes relevés par l\'audit d\'accessibilité (grasp a11y), 0 par défaut',
};

export const COMMANDS: readonly CommandSpec[] = [
  // Serveur
  { name: 'serve', group: 'Serveur', usage: 'serve [--tcp [--port N] [--listen IP]]', summary: 'démarre le control plane (premier plan)', options: ['tcp', 'port', 'listen'] },
  { name: 'stop', group: 'Serveur', usage: 'stop', summary: 'arrête le serveur et ses navigateurs', options: [] },
  { name: 'status', group: 'Serveur', usage: 'status', summary: 'état du serveur', options: [] },
  { name: 'doctor', group: 'Serveur', usage: 'doctor', summary: 'diagnostic de l\'installation (Chrome, droits, socket)', options: [] },
  { name: 'daemon', group: 'Serveur', usage: 'daemon install|uninstall|status', summary: 'service systemd --user', options: [],
    subcommands: [
      { name: 'install', usage: 'daemon install', summary: 'installe et démarre l\'unité systemd --user' },
      { name: 'uninstall', usage: 'daemon uninstall', summary: 'retire l\'unité' },
      { name: 'status', usage: 'daemon status', summary: 'systemd --user disponible ?' },
    ] },
  { name: 'mcp', group: 'Serveur', usage: 'mcp [--session <id>] [--profile <nom>] [--no-serve]', summary: 'serveur MCP sur stdio (claude mcp add grasp -- grasp mcp)', options: ['profile', 'no-serve'] },
  // Sessions et profils
  { name: 'session', group: 'Sessions', usage: 'session create|list|close', summary: 'sessions (une session = un Chrome)', options: [],
    subcommands: [
      { name: 'create', usage: 'session create [--profile <nom>] [--proxy URL] [--http-auth u:mdp@hôte | -] [--viewport LxH|appareil [--mobile] [--dpr N] [--touch] [--mobile-ua]]', summary: 'ouvre une session, id sur stdout', options: ['profile', 'proxy', 'http-auth', 'viewport', ...VIEWPORT] },
      { name: 'list', usage: 'session list', summary: 'sessions ouvertes' },
      { name: 'close', usage: 'session close [id]', summary: 'ferme la session (et son Chrome)' },
    ] },
  { name: 'profiles', group: 'Sessions', usage: 'profiles [list|create|import|rm]', summary: 'profils Chrome persistants', options: [],
    subcommands: [
      { name: 'list', usage: 'profiles [list]', summary: 'liste (* = profil de la session courante)' },
      { name: 'create', usage: 'profiles create <nom> [--use-when "…"]', summary: 'profil vide possédé par Grasp', options: ['use-when'] },
      { name: 'import', usage: 'profiles import <nom> <répertoire de données Chrome> [--profile-directory "Profile 9"] [--skip-locked]', summary: 'copie un profil Chrome existant', options: ['profile-directory', 'skip-locked'] },
      { name: 'rm', usage: 'profiles rm <nom>', summary: 'supprime (refusé si une session l\'utilise)' },
    ] },
  { name: 'profile', group: 'Sessions', usage: 'profile <nom>', summary: 'bascule la session courante sur ce profil (Chrome relancé)', options: [], run: true, mcp: 'profile' },
  { name: 'viewport', group: 'Sessions', usage: 'viewport [LxH|appareil|reset] [--device <appareil>] [--mobile] [--dpr N] [--touch] [--mobile-ua]', summary: 'viewport émulé (hérité par les popups) ; sans argument : mesures', options: [...VIEWPORT], run: true, mcp: 'viewport' },
  { name: 'tabs', group: 'Sessions', usage: 'tabs', summary: 'onglets de la session (* = actif, « (ouvert par t1) » pour un popup)', options: [], run: true, mcp: 'tabs' },
  { name: 'tab', group: 'Sessions', usage: 'tab <id> | tab new [url] | tab close [id]', summary: 'bascule, ouvre (URL vérifiée avant création) ou ferme un onglet', options: [], run: true, mcp: 'tab',
    subcommands: [
      { name: '<id>', usage: 'tab t2', summary: 'fait de t2 l\'onglet actif' },
      { name: 'new', usage: 'tab new [url]', summary: 'nouvel onglet (refusé hors allowlist, rien n\'est créé)' },
      { name: 'close', usage: 'tab close [id]', summary: 'ferme l\'onglet (défaut : l\'actif ; jamais le dernier)' },
    ] },
  // Lecture
  { name: 'snap', group: 'Lecture', usage: 'snap [--max octets] [--scope <sél>] [--name-max N] [--outline|--interactive]', summary: 'arbre d\'accessibilité, une ligne par nœud « ref:rôle "nom" [états] » (12000 octets par défaut)', options: ['max', 'scope', 'name-max', 'outline', 'interactive'], run: true, mcp: 'snap' },
  { name: 'find', group: 'Lecture', usage: 'find <texte|/regex/> [--role r[,r2]] [--max N] [--scope <sél>]', summary: 'lignes du snapshot qui correspondent, avec leur ref et leur conteneur (30 par défaut)', options: ['role', 'max', 'scope', 'name-max'], run: true, mcp: 'find' },
  { name: 'text', group: 'Lecture', usage: 'text [--max N] [--scope <sél>] [--markdown]', summary: 'texte visible de la page ou d\'une zone (4000 caractères par défaut)', options: ['max', 'scope', 'markdown'], run: true, mcp: 'text' },
  { name: 'wait', group: 'Lecture', usage: 'wait [--text T | --sel S | --idle] [--timeout ms]', summary: 'attend un texte, un élément ou une page stable (10000 ms)', options: ['text', 'sel', 'idle', 'timeout'], run: true, mcp: 'wait' },
  { name: 'network', group: 'Lecture', usage: 'network [--since <seq>] [--failed] [--max N] [--type xhr,fetch,…]', summary: 'journal réseau « #seq MÉTHODE url → statut · durée · type » (50 dernières)', options: ['since', 'failed', 'max', 'type'], run: true, mcp: 'network' },
  { name: 'a11y', group: 'Lecture', usage: 'a11y [--scope <ref|css>] [--max N]', summary: 'audit d\'accessibilité (pas WCAG) : une ligne par problème, ref et correction', options: ['scope', 'max'], run: true, mcp: 'a11y' },
  { name: 'console', group: 'Lecture', usage: 'console [--level error|warn|info|debug] [--since <seq>] [--limit N] [--clear]', summary: 'journal du navigateur, une ligne par entrée (50 dernières)', options: ['level', 'since', 'limit', 'clear'], run: true, mcp: 'console' },
  { name: 'screenshot', group: 'Lecture', usage: 'screenshot [-o f|-] [--full] [--el <sél>] [--format png|jpeg|webp] [--quality N] [--max-width N] [--refs]', summary: 'capture ; sans -o : CHEMIN d\'un fichier 0600 sur stdout', options: ['full', 'refs', 'el', 'quality', 'max-width', 'format'], cliOptions: ['output'], run: true, mcp: 'screenshot' },
  { name: 'pdf', group: 'Lecture', usage: 'pdf [-o f.pdf]', summary: 'PDF de la page', options: [], cliOptions: ['output'] },
  // Actions
  { name: 'nav', group: 'Actions', usage: 'nav <url>', summary: 'navigue (allowlist) et attend la stabilité', options: ACTION, run: true, mcp: 'nav' },
  { name: 'back', group: 'Actions', usage: 'back', summary: 'page précédente de l\'onglet (route pushState comprise), garde appliqué', options: NAV, run: true, mcp: 'back' },
  { name: 'forward', group: 'Actions', usage: 'forward', summary: 'page suivante de l\'onglet', options: NAV, run: true, mcp: 'forward' },
  { name: 'reload', group: 'Actions', usage: 'reload [--hard]', summary: 'recharge la page (--hard : sans le cache HTTP)', options: [...NAV, 'hard'], run: true, mcp: 'reload' },
  { name: 'scroll', group: 'Actions', usage: 'scroll [<sél>] [--by px | --to top|bottom] [--until-stable [--max-steps N]]', summary: 'défilement (page ou conteneur) ; --until-stable : jusqu\'à ce que plus rien n\'apparaisse', options: [...NAV, 'by', 'to', 'until-stable', 'max-steps'], run: true, mcp: 'scroll' },
  { name: 'click', group: 'Actions', usage: 'click <sél>', summary: 'clic souris réel, livraison vérifiée', options: ACTION, run: true, mcp: 'click' },
  { name: 'fill', group: 'Actions', usage: 'fill <sél> <valeur|secret:NOM>', summary: 'remplace la valeur du champ et la vérifie ; secret:NOM : valeur prise côté serveur, masquée partout', options: ACTION, run: true, mcp: 'fill' },
  { name: 'type', group: 'Actions', usage: 'type <sél> <texte> [--delay ms]', summary: 'frappe touche par touche, ajoutée au curseur (autocomplétions)', options: [...ACTION, 'delay'], run: true, mcp: 'type' },
  { name: 'select', group: 'Actions', usage: 'select <sél> <valeur|libellé>', summary: 'option d\'un <select> natif', options: ACTION, run: true, mcp: 'select' },
  { name: 'check', group: 'Actions', usage: 'check <sél> [--uncheck]', summary: 'coche ou décoche, puis vérifie l\'état', options: [...ACTION, 'uncheck'], run: true, mcp: 'check' },
  { name: 'press', group: 'Actions', usage: 'press <touche> [sél]', summary: 'touche (Enter, Tab, Escape, ArrowDown, Control+a…)', options: ACTION, run: true, mcp: 'press' },
  { name: 'hover', group: 'Actions', usage: 'hover <sél>', summary: 'survol (menus, infobulles)', options: ACTION, run: true, mcp: 'hover' },
  // Recette et scripts
  { name: 'expect', group: 'Recette', usage: 'expect <assertion> …', summary: 'vérifie la page ; échec = code 1, « attendu … ; constaté : … »', options: ['regex', 'timeout', 'scope', 'since', 'ignore', 'max', 'shot-on-error'], run: true,
    subcommands: EXPECT_KINDS.map((k) => ({ name: k, usage: EXPECT_USAGE[k], summary: EXPECT_SUMMARY[k], options: [...EXPECT_FLAGS[k], 'shot-on-error'] })) },
  { name: 'run', group: 'Recette', usage: 'run [fichier|-] [--continue] [--report|--no-report] [--out-dir rép]', summary: 'plusieurs commandes en UN aller-retour, une par ligne', options: ['continue', 'report', 'no-report', 'out-dir'], mcp: 'run' },
  { name: 'history', group: 'Recette', usage: 'history [--since <seq>] [--limit N] [--clear] | history --as-run [--expect] [--since <seq>] [-o fichier]', summary: 'commandes de la session ; --as-run : script grasp run rejouable', options: ['since', 'limit', 'clear', 'as-run', 'expect'], cliOptions: ['output'], mcp: 'history' },
  { name: 'diff', group: 'Recette', usage: 'diff <urlA> <urlB> [--paths fichier|-] [--max N] [--concurrency N] [--ignore <regex>]', summary: 'deux environnements comparés page par page', options: [...MULTI, 'paths'] },
  { name: 'audit', group: 'Recette', usage: 'audit <url-sitemap|url…|fichier|-> [--max N] [--concurrency N] [--max-links N | --no-links] [--ignore <regex>]', summary: 'pages d\'un sitemap ou d\'une liste : statut, console, requêtes, formulaire, liens cassés', options: [...MULTI, 'max-links', 'no-links'] },
  // Sensibles (désactivées par défaut)
  { name: 'eval', group: 'Sensibles', usage: 'eval <expression>', summary: 'évalue du JavaScript dans la page', options: [], run: true, disabledByDefault: 'allowEval' },
  { name: 'cookies', group: 'Sensibles', usage: 'cookies', summary: 'cookies de la session', options: [], run: true, disabledByDefault: 'allowCookies' },
  { name: 'storage', group: 'Sensibles', usage: 'storage get|rm local|session <clé> [--origin <url>] | storage set local|session <clé> <valeur|-> [--origin <url>]', summary: 'stockage Web de l\'origine affichée (ou de --origin, avant le premier chargement), sans eval', options: ['origin'], run: true, disabledByDefault: 'allowCookies',
    subcommands: [
      { name: 'get', usage: 'storage get local|session <clé> [--origin <url>]', summary: 'valeur sur stdout (clé absente : code 1)', options: ['origin'] },
      { name: 'set', usage: 'storage set local|session <clé> <valeur|-> [--origin <url>]', summary: 'écrit (- : valeur lue sur stdin) ; --origin : avant tout chargement de cette origine', options: ['origin'] },
      { name: 'rm', usage: 'storage rm local|session <clé> [--origin <url>]', summary: 'supprime la clé', options: ['origin'] },
    ] },
  { name: 'upload', group: 'Sensibles', usage: 'upload <sél> <fichier>…', summary: 'envoie des fichiers dans un <input type=file>', options: ['engine'], run: true, disabledByDefault: 'allowUpload' },
  { name: 'state', group: 'Sensibles', usage: 'state export [fichier|-] [--origin …] | import <fichier|->', summary: 'cookies + stockage Web en JSON', options: [], disabledByDefault: 'allowCookies',
    subcommands: [
      { name: 'export', usage: 'state export [fichier|-] [--origin http://hôte:port,…]', summary: 'exporte (fichier 0600 ; sans fichier : chemin sur stdout)', options: ['origin'] },
      { name: 'import', usage: 'state import <fichier|->', summary: 'importe (localStorage fusionné par origine)' },
    ] },
  // Configuration
  { name: 'security', group: 'Configuration', usage: 'security', summary: 'politique telle que le garde l\'applique', options: [] },
  { name: 'secrets', group: 'Configuration', usage: 'secrets list | set <NOM> --domains <hôtes> | rm <NOM>', summary: 'secrets saisis par fill … secret:NOM (valeurs jamais affichées)', options: [], mcp: 'secrets',
    subcommands: [
      { name: 'list', usage: 'secrets list', summary: 'noms et domaines, jamais les valeurs' },
      { name: 'set', usage: 'secrets set <NOM> --domains hôte[,*.domaine]', summary: 'valeur lue sur stdin, jamais en argument', options: ['domains'] },
      { name: 'rm', usage: 'secrets rm <NOM>', summary: 'supprime le secret' },
    ] },
  { name: 'config', group: 'Configuration', usage: 'config path | get [clé] | set <clé> <valeur> | unset <clé> | keys', summary: 'configuration (fichier 0600, relu après écriture)', options: [],
    subcommands: [
      { name: 'path', usage: 'config path', summary: 'chemin du fichier' },
      { name: 'get', usage: 'config get [clé]', summary: 'valeurs résolues (défaut signalé)' },
      { name: 'set', usage: 'config set <clé> <valeur>', summary: 'écrit une clé (redémarrer le serveur)' },
      { name: 'unset', usage: 'config unset <clé>', summary: 'revient au défaut' },
      { name: 'keys', usage: 'config keys', summary: 'clés et leur rôle' },
    ] },
  // Aide
  { name: 'help', group: 'Aide', usage: 'help [--json] [commande]', summary: 'aide ; --json : commandes, options et types, outils MCP', options: [] },
  { name: 'skill', group: 'Aide', usage: 'skill', summary: 'mode d\'emploi pour un agent IA (skills/grasp/SKILL.md)', options: [] },
];

/** Formes de sélecteurs acceptées partout où une commande attend <sél>. */
export const SELECTORS: ReadonlyArray<{ form: string; example: string; description: string }> = [
  { form: 'ref', example: 'e5k2', description: 'issue de snap ; stable (hash du rôle, du nom et du rang), à préférer' },
  { form: 'css', example: '#email', description: 'sélecteur CSS (préfixe css: facultatif)' },
  { form: 'text', example: 'text:Valider', description: 'nom accessible : égal d\'abord, puis sans casse, puis contenu dans un contrôle' },
  { form: 'frame', example: "frame=#editeur >> text:Gras", description: 'élément dans une iframe, même d\'une autre origine (moteur Playwright, pas de ref)' },
];

export function commandSpec(name: string): CommandSpec | undefined {
  return COMMANDS.find((c) => c.name === name);
}

/** Usage complet d'une option : `--max <N>`, `-o, --output <fichier>`, `--level error|warn|info|debug`. */
export function optionUsage(name: string): string {
  const o = OPTIONS[name];
  if (o === undefined) throw new Error(`option inconnue du catalogue : ${name}`);
  const v = o.type === 'boolean' ? '' : o.type === 'enum' ? ` ${o.values!.join('|')}` : ` <${o.arg ?? 'valeur'}>`;
  return `${o.alias !== undefined ? `-${o.alias}, ` : ''}--${name}${v}`;
}
