import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import { newNonce, neutralizeDeep, neutralize, wrapContent, type BoundaryTag } from '../core/boundaries.js';

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

/**
 * Routes dont la réponse n'est pas du contenu de page lu pour l'agent : état interne, politique, binaires, et
 * données qu'il ne faut pas réécrire (cookies et état exportés, valeur d'un eval demandé explicitement). Leurs
 * ERREURS sont encadrées quand même (une exception de la page peut y être citée). Toute autre route — y compris
 * une route ajoutée plus tard — est traitée comme du contenu de page : l'oubli protège au lieu d'exposer.
 */
const PASS = new Set(['/health', '/policy', '/session-options', '/screenshot', '/pdf', '/cookies', '/state/export', '/state/import', '/eval']);
const isInternal = (path: string) => path.startsWith('/internal/') || path === '/health' || path === '/policy' || path === '/session-options';

/** Réponse capturée : le bridge n'emploie que writeHead/end (sendJson, sendBuffer, sendError), set/getHeader, headersSent et destroy. */
class Captured {
  status = 200;
  headers: OutgoingHttpHeaders = {};
  body: Buffer = Buffer.alloc(0);
  headersSent = false;
  destroyed = false;
  // Comme ServerResponse : les en-têtes de writeHead s'ajoutent à ceux posés par setHeader (note des onglets).
  writeHead(status: number, headers?: OutgoingHttpHeaders): this {
    this.status = status;
    for (const [k, v] of Object.entries(headers ?? {})) this.headers[k.toLowerCase()] = v;
    this.headersSent = true;
    return this;
  }
  setHeader(k: string, v: string | number | string[]): this { this.headers[k.toLowerCase()] = v; return this; }
  // Lu par le masquage des secrets (redactResponse : type du corps, note x-grasp-notice) et par les onglets.
  getHeader(k: string): string | number | string[] | undefined { return this.headers[k.toLowerCase()]; }
  end(b?: Buffer | string): this { if (b !== undefined) this.body = typeof b === 'string' ? Buffer.from(b) : b; return this; }
  destroy(): this { this.destroyed = true; return this; }
}

const SOURCE: Record<string, string> = { '/snap': 'snap', '/text': 'text' };

/** Transforme une réponse capturée ; `nonce` est tiré après la lecture de la page, une fois par réponse. */
export function protectResponse(path: string, query: URLSearchParams, status: number, type: string, body: Buffer, nonce: string): Buffer {
  const isJson = type.startsWith('application/json');
  if (status >= 400) {
    if (!isJson || isInternal(path)) return body;
    // 400 compris : certains citent la page (options d'un <select>, journal d'appel de Playwright, exception d'un
    // eval) ; le bridge ne distingue pas ce qu'un message cite, ~150 octets sur une erreur.
    return Buffer.from(JSON.stringify(protectJson(JSON.parse(body.toString('utf8')) as Record<string, unknown>, nonce, { error: 'erreur' })));
  }
  if (PASS.has(path) || isInternal(path)) return body;
  if (type.startsWith('text/plain')) {
    const src = path === '/text' && /^(1|true)$/.test(query.get('markdown') ?? '') ? 'markdown' : SOURCE[path] ?? path.slice(1);
    return Buffer.from(wrapContent(body.toString('utf8'), nonce, src));
  }
  if (!isJson) return body;
  // a11y : `text` est le rapport rendu (lignes du snapshot, noms et messages de la page).
  const wrap: Record<string, string> = path === '/a11y' ? { diff: 'diff', detail: 'note', text: 'a11y' } : { diff: 'diff', detail: 'note' };
  return Buffer.from(JSON.stringify(protectJson(JSON.parse(body.toString('utf8')) as Record<string, unknown>, nonce, wrap)));
}

/**
 * Toutes les chaînes neutralisées ; les champs de `wrap` encadrés (ligne de fin : leurs propres imitations).
 * `boundary` (nonce de la réponse) sert aux formateurs qui encadrent plus tard ce qu'ils assemblent : lignes de
 * console et du journal réseau (`console.boundary`, `network.boundary` pour celles d'une action), éléments cités par une erreur (`items` d'un expect), titre.
 */
function protectJson(raw: Record<string, unknown>, nonce: string, wrap: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const counter = { count: 0 };
  for (const [k, v] of Object.entries(raw)) {
    const src = wrap[k];
    if (src !== undefined && typeof v === 'string') {
      const n = neutralize(v);
      out[k] = wrapContent(n.text, nonce, src, n.count);
    } else if ((k === 'console' || k === 'network') && v !== null && typeof v === 'object' && !Array.isArray(v)) {
      // Tranche console ou réseau d'une action : son étiquette, pour les formateurs qui l'encadrent ensuite.
      const c = { count: 0 };
      out[k] = { ...(neutralizeDeep(v, c) as Record<string, unknown>), boundary: { nonce, imitations: c.count } satisfies BoundaryTag };
    } else out[k] = neutralizeDeep(v, counter);
  }
  out.boundary = { nonce, imitations: counter.count } satisfies BoundaryTag;
  return out;
}

/**
 * Enveloppe l'API du bridge quand `contentBoundaries` est actif dans la politique gelée (celle que rapporte
 * /security/effective). Sans elle, le gestionnaire est rendu tel quel.
 */
export function withContentBoundaries(policy: { contentBoundaries?: boolean }, inner: Handler): Handler {
  if (policy.contentBoundaries !== true) return inner;
  return async (req, res) => {
    const cap = new Captured();
    await inner(req, cap as unknown as ServerResponse);
    if (cap.destroyed) { res.destroy(); return; }
    const url = new URL(req.url ?? '/', 'http://bridge');
    let out = cap.body;
    try {
      out = protectResponse(url.pathname, url.searchParams, cap.status, String(cap.headers['content-type'] ?? ''), cap.body, newNonce());
    } catch (e) {
      // Corps illisible (ne devrait pas arriver) : jamais transmis sans protection.
      const msg = Buffer.from(JSON.stringify({ error: `frontières de contenu : réponse non encadrable (${neutralize((e as Error).message).text})` }));
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'content-length': msg.length });
      res.end(msg);
      return;
    }
    res.writeHead(cap.status, { ...cap.headers, 'content-length': out.length });
    res.end(out);
  };
}
