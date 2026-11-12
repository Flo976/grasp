import type { IncomingMessage, ServerResponse } from 'node:http';
import { GraspError } from '../core/errors.js';
import { readJson, sendBuffer, sendError, sendJson, str, optStr, optBool, optInt, optCount, optFlag } from '../core/http.js';
import { isLevel, type ConsoleLevel } from '../core/console.js';
import { STATE_MAX_BYTES } from '../core/state.js';
import { expectSpecOf } from '../core/expect.js';
import { scrollSpecOf } from './scroll.js';
import { viewportSpecOf } from '../core/viewport.js';
import { parseTypes } from '../core/network.js';
import type { PageController, SessionCookie, ShotOptions } from './page.js';
import { compileFind, FIND_LIMIT_MAX, SNAP_MODES, type FindPattern, type FindSpec, type SnapMode } from './snapshot.js';
import type { SecretUse } from '../core/secrets.js';
import { redactResponse } from '../control/redact.js';
import type { Tabs } from './tabs.js';

const MIME: Record<string, string> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };

function shotOptions(q: URLSearchParams): ShotOptions {
  const el = q.get('el');
  const format = q.get('format');
  return {
    full: optFlag(q.get('full'), 'full'), refs: optFlag(q.get('refs'), 'refs'),
    el: el !== null && el !== '' ? el : undefined, format: format !== null && format !== '' ? format : undefined,
    quality: optInt(q.get('quality'), 'quality'), maxWidth: optInt(q.get('maxWidth'), 'maxWidth'),
  };
}

/**
 * Lecture partielle de GET /snap : `mode=outline|interactive`, ou `find=<texte|/regex/>` avec `role=r[,r2]` et
 * `limit=N`. Toute combinaison sans effet (role sans find, find avec mode) est refusée, jamais ignorée.
 */
export function snapReadOptions(q: URLSearchParams): { mode?: SnapMode; find?: FindSpec } {
  const mode = q.get('mode');
  const find = q.get('find');
  const role = q.get('role');
  const limit = q.get('limit');
  if (mode !== null && !(SNAP_MODES as readonly string[]).includes(mode)) throw new GraspError(400, `mode de snap inconnu « ${mode} » (${SNAP_MODES.join(', ')})`);
  if (find === null) {
    if (role !== null || limit !== null) throw new GraspError(400, `« ${role !== null ? 'role' : 'limit'} » ne s'applique qu'avec find`);
    return mode !== null ? { mode: mode as SnapMode } : {};
  }
  if (mode !== null) throw new GraspError(400, `find et --${mode} sont exclusifs (find rend déjà seulement les lignes trouvées)`);
  let pattern: FindPattern;
  try { pattern = compileFind(find); } catch (e) { throw new GraspError(400, (e as Error).message); }
  const roles = role !== null ? role.split(',').map((r) => r.trim()).filter((r) => r !== '') : undefined;
  if (roles !== undefined && roles.length === 0) throw new GraspError(400, '« role » : au moins un rôle attendu (button, link, textbox, heading, text…)');
  const n = optInt(limit, 'max');
  if (n !== undefined && n > FIND_LIMIT_MAX) throw new GraspError(400, `find --max : ${FIND_LIMIT_MAX} au plus`);
  return { find: { pattern, ...(roles !== undefined ? { roles } : {}), ...(n !== undefined ? { limit: n } : {}) } };
}

/** `boxes=1` (snap --boxes, find --boxes) ; toute autre valeur refusée, jamais ignorée. */
export function boxesOf(q: URLSearchParams): boolean {
  const v = q.get('boxes');
  if (v === null) return false;
  if (v !== '1' && v !== 'true') throw new GraspError(400, '« boxes » : 1 attendu');
  return true;
}

/** Secret substitué par le control plane : nom et domaines (la valeur est dans `value`). */
function secretUseOf(v: unknown): SecretUse | undefined {
  if (v === undefined) return undefined;
  const o = v as Record<string, unknown> | null;
  if (o === null || typeof o !== 'object' || typeof o.name !== 'string' || !Array.isArray(o.domains) || !o.domains.every((d) => typeof d === 'string')) throw new GraspError(400, 'secretUse : { name, domains } attendu');
  return { name: o.name, domains: o.domains as string[] };
}

function level(v: unknown): ConsoleLevel | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string' || !isLevel(v)) throw new GraspError(400, `niveau inconnu « ${String(v)} » (niveaux : error, warn, info, debug)`);
  return v;
}

/** Routes du control plane lui-même (santé, rapport de sécurité) : jamais visibles de l'agent. */
const INTERNAL = new Set(['GET /health', 'GET /policy', 'GET /session-options']);

/** Routes d'onglets : seulement si le bridge gère des onglets (tests qui branchent un seul PageController). */
function tabsOf(tabs: Tabs | undefined, route: string): Tabs {
  if (tabs === undefined) throw new GraspError(404, `route inconnue : ${route}`);
  return tabs;
}

/**
 * API HTTP du bridge, servie sur un socket Unix privé (0600 dans un répertoire 0700).
 * Seul le control plane s'y connecte ; les permissions du système de fichiers font office d'authentification.
 */
export function bridgeHandler(page: PageController, info: () => Record<string, unknown>, sessionOptions: () => Record<string, unknown> = () => ({}), tabs?: Tabs) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // Toute réponse du bridge est masquée avec les secrets saisis dans la session (et leurs valeurs effectives).
    redactResponse(res, page.secretRedactor);
    try {
      const url = new URL(req.url ?? '/', 'http://bridge');
      const q = url.searchParams;
      const route = `${req.method} ${url.pathname}`;
      const body = req.method === 'POST' ? await readJson(req, url.pathname === '/state/import' ? STATE_MAX_BYTES : undefined) : {};
      const opts = { snapDiff: optBool(body, 'snapDiff'), max: optInt(body.max, 'max'), scope: optStr(body, 'scope'), console: optBool(body, 'console'), shotOnError: optBool(body, 'shotOnError'), engine: optStr(body, 'engine'), dialog: optStr(body, 'dialog'), network: optBool(body, 'network'), describeTarget: optStr(body, 'describeTarget'), follow: optBool(body, 'follow') };
      // Onglet fermé hors de toute commande (popup refermé par la page) : dit par la réponse suivante à l'agent,
      // quelle qu'elle soit (jamais par une route interne du control plane, qui ne la transmettrait pas).
      const notice = INTERNAL.has(route) || url.pathname.startsWith('/internal/') ? undefined : await tabs?.takeNotices();
      if (notice !== undefined) res.setHeader('x-grasp-notice', encodeURIComponent(notice));
      const scope = q.get('scope') ?? undefined;
      switch (route) {
        case 'GET /health': return sendJson(res, 200, { ok: true, ...info() });
        // L'objet exact que le garde consulte (règle n°3).
        case 'GET /policy': return sendJson(res, 200, page.policy);
        // Options propres à la session (proxy surchargé, hôtes munis d'identifiants HTTP, jamais les identifiants).
        case 'GET /session-options': return sendJson(res, 200, sessionOptions());
        case 'GET /location': return sendJson(res, 200, { ...(await page.location()), lastBlocked: page.lastBlocked() });
        case 'POST /navigate': return sendJson(res, 200, await page.nav(str(body, 'url'), opts));
        // Historique de l'onglet et défilement : même attente et mêmes options que nav.
        case 'POST /back': return sendJson(res, 200, await page.history(-1, opts));
        case 'POST /forward': return sendJson(res, 200, await page.history(1, opts));
        case 'POST /reload': return sendJson(res, 200, await page.reload({ ...opts, hard: optBool(body, 'hard') }));
        case 'POST /scroll': return sendJson(res, 200, await page.scroll(optStr(body, 'target'), scrollSpecOf(body), opts));
        case 'GET /snap': return sendBuffer(res, 200, 'text/plain; charset=utf-8', await page.snapText({ maxBytes: optInt(q.get('max'), 'max'), scope, nameMax: optCount(q.get('nameMax'), 'name-max'), ...snapReadOptions(q), ...(boxesOf(q) ? { boxes: true } : {}) }));
        case 'GET /text': return sendBuffer(res, 200, 'text/plain; charset=utf-8', await page.text(optInt(q.get('max'), 'max'), scope, { markdown: optFlag(q.get('markdown'), 'markdown') === true }));
        case 'GET /a11y': return sendJson(res, 200, await page.a11y({ scope, max: optInt(q.get('max'), 'max') }));
        case 'POST /wait': return sendJson(res, 200, await page.wait({ text: optStr(body, 'text'), sel: optStr(body, 'sel'), idle: optBool(body, 'idle'), timeout: optInt(body.timeout, 'timeout') }));
        case 'POST /expect': return sendJson(res, 200, await page.expect(expectSpecOf(body), { shotOnError: opts.shotOnError }));
        case 'POST /click': return sendJson(res, 200, await page.click(str(body, 'target'), opts));
        case 'POST /fill': return sendJson(res, 200, await page.fill(str(body, 'target'), str(body, 'value'), opts, secretUseOf(body.secretUse)));
        case 'POST /hover': return sendJson(res, 200, await page.hover(str(body, 'target'), opts));
        case 'POST /type': return sendJson(res, 200, await page.type(str(body, 'target'), str(body, 'text'), { ...opts, delay: optInt(body.delay, 'delay') }));
        case 'POST /select': return sendJson(res, 200, await page.select(str(body, 'target'), str(body, 'value'), opts));
        case 'POST /check': {
          const checked = optBool(body, 'checked');
          return sendJson(res, 200, await page.check(str(body, 'target'), checked === undefined ? true : checked, opts));
        }
        case 'POST /press': return sendJson(res, 200, await page.press(str(body, 'key'), optStr(body, 'target'), opts));
        case 'GET /screenshot': {
          // ?save=1 : fichier 0600 dans le répertoire d'état, réponse = chemin et dimensions (pas le binaire).
          if (optFlag(q.get('save'), 'save')) return sendJson(res, 200, await page.saveShot(shotOptions(q)));
          const s = await page.capture(shotOptions(q));
          return sendBuffer(res, 200, MIME[s.format]!, s.data, { 'x-grasp-width': String(s.width), 'x-grasp-height': String(s.height), 'x-grasp-format': s.format, ...(s.truncated === true ? { 'x-grasp-truncated': '1' } : {}) });
        }
        // Viewport émulé de l'onglet : { reset: true } le retire ; sinon spécification validée (core/viewport.ts).
        case 'GET /viewport': return sendJson(res, 200, await page.viewportInfo());
        case 'POST /viewport': {
          if (body.reset === true) {
            if (Object.keys(body).length > 1) throw new GraspError(400, 'viewport : reset ne se combine avec aucune autre option');
            return sendJson(res, 200, await page.setViewport(null));
          }
          return sendJson(res, 200, await page.setViewport(viewportSpecOf(body)));
        }
        case 'GET /console':
          return sendJson(res, 200, await page.consoleQuery({ level: level(q.get('level')), since: optCount(q.get('since'), 'since'), limit: optInt(q.get('limit'), 'limit'), clear: optFlag(q.get('clear'), 'clear') }));
        case 'POST /console':
          return sendJson(res, 200, await page.consoleQuery({ level: level(body.level), since: optCount(body.since, 'since'), limit: optInt(body.limit, 'limit'), clear: optBool(body, 'clear') }));
        // Journal réseau : méthode, URL masquée, statut, durée, type — jamais d'en-têtes ni de corps.
        case 'GET /network':
          return sendJson(res, 200, page.networkQuery({ since: optCount(q.get('since'), 'since'), limit: optCount(q.get('limit'), 'limit'), failed: optFlag(q.get('failed'), 'failed'), types: parseTypes(q.get('type') ?? undefined) }));
        case 'POST /network':
          return sendJson(res, 200, page.networkQuery({ since: optCount(body.since, 'since'), limit: optCount(body.limit, 'limit'), failed: optBool(body, 'failed'), types: parseTypes(optStr(body, 'type')) }));
        // Recyclage : routes internes du control plane (absentes de SESSION_ROUTES, jamais atteignables par l'agent).
        case 'GET /internal/session-cookies': return sendJson(res, 200, { cookies: await page.sessionCookies() });
        case 'POST /internal/session-cookies': {
          if (!Array.isArray(body.cookies)) throw new GraspError(400, 'champ « cookies » (tableau) requis');
          return sendJson(res, 200, { restored: await page.restoreCookies(body.cookies as SessionCookie[]) });
        }
        // Historique : sélecteur durable de la cible, relevé avant l'action (route interne du control plane).
        case 'POST /internal/durable': return sendJson(res, 200, await page.durableTarget(str(body, 'target')));
        // Recette multi-pages (grasp audit / diff) : relevé de la page, vérification des liens internes.
        case 'GET /inventory': return sendJson(res, 200, await page.inventory());
        case 'POST /check-links': {
          const urls = body.urls;
          if (!Array.isArray(urls) || !urls.every((u) => typeof u === 'string')) throw new GraspError(400, 'champ « urls » (tableau d\'URL) requis');
          return sendJson(res, 200, await page.checkLinks(urls as string[]));
        }
        // Onglets (popups, target=_blank, tab new) : voir tabs.ts.
        case 'GET /tabs': return sendJson(res, 200, { tabs: await tabsOf(tabs, route).list() });
        case 'POST /tabs/select': return sendJson(res, 200, await tabsOf(tabs, route).select(str(body, 'id')));
        case 'POST /tabs/new': return sendJson(res, 200, await tabsOf(tabs, route).open(optStr(body, 'url')));
        case 'POST /tabs/close': return sendJson(res, 200, await tabsOf(tabs, route).close(optStr(body, 'id')));
        case 'GET /pdf': return sendBuffer(res, 200, 'application/pdf', await page.pdf());
        case 'POST /eval': return sendJson(res, 200, { ok: true, ...await page.evaluateTyped(str(body, 'expression')) });
        case 'GET /cookies': return sendJson(res, 200, await page.cookies());
        // État exportable (allowCookies) : ?origin=a,b ajoute des origines dont lire le localStorage.
        case 'GET /state/export': return sendJson(res, 200, await page.exportState(q.getAll('origin').flatMap((o) => o.split(',')).map((o) => o.trim()).filter((o) => o !== '')));
        case 'POST /state/import': {
          if (body.state === undefined) throw new GraspError(400, 'champ « state » (objet d\'état exporté) requis');
          return sendJson(res, 200, await page.importState(body.state));
        }
        // Stockage Web de l'origine affichée (allowCookies), code fixe : voir PageController.storage.
        case 'POST /storage': return sendJson(res, 200, await page.storage(str(body, 'op'), str(body, 'area'), str(body, 'key'), optStr(body, 'value')));
        case 'POST /upload': {
          const files = body.files;
          if (!Array.isArray(files) || !files.every((f) => typeof f === 'string')) throw new GraspError(400, 'champ « files » (tableau de chemins) requis');
          return sendJson(res, 200, await page.upload(str(body, 'target'), files as string[], { engine: opts.engine }));
        }
        default: throw new GraspError(404, `route inconnue : ${route}`);
      }
    } catch (e) { sendError(res, e); }
  };
}
