import type { IncomingMessage, ServerResponse } from 'node:http';
import { GraspError } from '../core/errors.js';
import { readJson, sendBuffer, sendError, sendJson, str, optStr, optBool, optInt } from '../core/http.js';
import { diffSnapshots } from './snapshot.js';
import type { PageController } from './page.js';

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
      const opts = { snapDiff: optBool(body, 'snapDiff'), maxBytes: optInt(body.max, 'max') };
      switch (route) {
        case 'GET /health': return sendJson(res, 200, { ok: true, ...info() });
        // L'objet exact que le garde consulte (règle n°3).
        case 'GET /policy': return sendJson(res, 200, page.policy);
        case 'GET /location': return sendJson(res, 200, { ...(await page.location()), lastBlocked: page.lastBlocked() });
        case 'POST /navigate': {
          const before = opts.snapDiff ? await page.snapshot({ maxBytes: opts.maxBytes }) : undefined;
          const loc = await page.navigate(str(body, 'url'));
          const out: Record<string, unknown> = { ok: true, ...loc };
          if (before) out.diff = diffSnapshots(before, await page.snapshot({ maxBytes: opts.maxBytes }));
          return sendJson(res, 200, out);
        }
        case 'GET /snap': return sendBuffer(res, 200, 'text/plain; charset=utf-8', (await page.snapshot({ maxBytes: optInt(q.get('max'), 'max') })).text);
        case 'GET /text': return sendBuffer(res, 200, 'text/plain; charset=utf-8', await page.text(optInt(q.get('max'), 'max')));
        case 'POST /click': return sendJson(res, 200, await page.click(str(body, 'target'), opts));
        case 'POST /fill': return sendJson(res, 200, await page.fill(str(body, 'target'), str(body, 'value'), opts));
        case 'POST /select': return sendJson(res, 200, await page.select(str(body, 'target'), str(body, 'value'), opts));
        case 'POST /check': {
          const checked = optBool(body, 'checked');
          return sendJson(res, 200, await page.check(str(body, 'target'), checked === undefined ? true : checked, opts));
        }
        case 'POST /press': return sendJson(res, 200, await page.press(str(body, 'key'), optStr(body, 'target'), opts));
        case 'GET /screenshot': return sendBuffer(res, 200, 'image/png', await page.screenshot());
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
