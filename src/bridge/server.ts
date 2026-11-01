import type { IncomingMessage, ServerResponse } from 'node:http';
import { GraspError } from '../core/errors.js';
import { readJson, sendBuffer, sendError, sendJson, str, optStr, optBool, optInt, optCount, optFlag } from '../core/http.js';
import { isLevel, type ConsoleLevel } from '../core/console.js';
import type { PageController, ShotOptions } from './page.js';

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

/**
 * API HTTP du bridge, servie sur un socket Unix privé (0600 dans un répertoire 0700).
 * Seul le control plane s'y connecte ; les permissions du système de fichiers font office d'authentification.
 */
export function bridgeHandler(page: PageController, info: () => Record<string, unknown>) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const url = new URL(req.url ?? '/', 'http://bridge');
      const q = url.searchParams;
      const route = `${req.method} ${url.pathname}`;
      const body = req.method === 'POST' ? await readJson(req) : {};
      const opts = { snapDiff: optBool(body, 'snapDiff'), max: optInt(body.max, 'max'), scope: optStr(body, 'scope'), console: optBool(body, 'console'), shotOnError: optBool(body, 'shotOnError') };
      const scope = q.get('scope') ?? undefined;
      switch (route) {
        case 'GET /health': return sendJson(res, 200, { ok: true, ...info() });
        // L'objet exact que le garde consulte (règle n°3).
        case 'GET /policy': return sendJson(res, 200, page.policy);
        case 'GET /location': return sendJson(res, 200, { ...(await page.location()), lastBlocked: page.lastBlocked() });
        case 'POST /navigate': return sendJson(res, 200, await page.nav(str(body, 'url'), opts));
        case 'GET /snap': return sendBuffer(res, 200, 'text/plain; charset=utf-8', (await page.snapshot({ maxBytes: optInt(q.get('max'), 'max'), scope })).text);
        case 'GET /text': return sendBuffer(res, 200, 'text/plain; charset=utf-8', await page.text(optInt(q.get('max'), 'max'), scope));
        case 'POST /wait': return sendJson(res, 200, await page.wait({ text: optStr(body, 'text'), sel: optStr(body, 'sel'), idle: optBool(body, 'idle'), timeout: optInt(body.timeout, 'timeout') }));
        case 'POST /click': return sendJson(res, 200, await page.click(str(body, 'target'), opts));
        case 'POST /fill': return sendJson(res, 200, await page.fill(str(body, 'target'), str(body, 'value'), opts));
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
        case 'GET /pdf': return sendBuffer(res, 200, 'application/pdf', await page.pdf());
        case 'POST /eval': return sendJson(res, 200, { ok: true, value: await page.evaluate(str(body, 'expression')) });
        case 'GET /cookies': return sendJson(res, 200, await page.cookies());
        case 'POST /upload': {
          const files = body.files;
          if (!Array.isArray(files) || !files.every((f) => typeof f === 'string')) throw new GraspError(400, 'champ « files » (tableau de chemins) requis');
          return sendJson(res, 200, await page.upload(str(body, 'target'), files as string[]));
        }
        default: throw new GraspError(404, `route inconnue : ${route}`);
      }
    } catch (e) { sendError(res, e); }
  };
}
