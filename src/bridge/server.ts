import type { IncomingMessage, ServerResponse } from 'node:http';
import { GraspError } from '../core/errors.js';
import { readJson, sendBuffer, sendError, sendJson, str, optStr, optBool, optInt, optCount, optFlag } from '../core/http.js';
import { isLevel, type ConsoleLevel } from '../core/console.js';
import { STATE_MAX_BYTES } from '../core/state.js';
import { expectSpecOf } from '../core/expect.js';
import type { PageController, SessionCookie, ShotOptions } from './page.js';
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
    try {
      const url = new URL(req.url ?? '/', 'http://bridge');
      const q = url.searchParams;
      const route = `${req.method} ${url.pathname}`;
      const body = req.method === 'POST' ? await readJson(req, url.pathname === '/state/import' ? STATE_MAX_BYTES : undefined) : {};
      const opts = { snapDiff: optBool(body, 'snapDiff'), max: optInt(body.max, 'max'), scope: optStr(body, 'scope'), console: optBool(body, 'console'), shotOnError: optBool(body, 'shotOnError'), engine: optStr(body, 'engine'), follow: optBool(body, 'follow') };
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
        case 'GET /snap': return sendBuffer(res, 200, 'text/plain; charset=utf-8', await page.snapText({ maxBytes: optInt(q.get('max'), 'max'), scope, nameMax: optCount(q.get('nameMax'), 'name-max') }));
        case 'GET /text': return sendBuffer(res, 200, 'text/plain; charset=utf-8', await page.text(optInt(q.get('max'), 'max'), scope, { markdown: optFlag(q.get('markdown'), 'markdown') === true }));
        case 'POST /wait': return sendJson(res, 200, await page.wait({ text: optStr(body, 'text'), sel: optStr(body, 'sel'), idle: optBool(body, 'idle'), timeout: optInt(body.timeout, 'timeout') }));
        case 'POST /expect': return sendJson(res, 200, await page.expect(expectSpecOf(body), { shotOnError: opts.shotOnError }));
        case 'POST /click': return sendJson(res, 200, await page.click(str(body, 'target'), opts));
        case 'POST /fill': return sendJson(res, 200, await page.fill(str(body, 'target'), str(body, 'value'), opts));
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
        case 'GET /console':
          return sendJson(res, 200, await page.consoleQuery({ level: level(q.get('level')), since: optCount(q.get('since'), 'since'), limit: optInt(q.get('limit'), 'limit'), clear: optFlag(q.get('clear'), 'clear') }));
        case 'POST /console':
          return sendJson(res, 200, await page.consoleQuery({ level: level(body.level), since: optCount(body.since, 'since'), limit: optInt(body.limit, 'limit'), clear: optBool(body, 'clear') }));
        // Recyclage : routes internes du control plane (absentes de SESSION_ROUTES, jamais atteignables par l'agent).
        case 'GET /internal/session-cookies': return sendJson(res, 200, { cookies: await page.sessionCookies() });
        case 'POST /internal/session-cookies': {
          if (!Array.isArray(body.cookies)) throw new GraspError(400, 'champ « cookies » (tableau) requis');
          return sendJson(res, 200, { restored: await page.restoreCookies(body.cookies as SessionCookie[]) });
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
