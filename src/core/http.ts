import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { GraspError } from './errors.js';

export type Endpoint = { transport: 'unix'; socketPath: string } | { transport: 'tcp'; host: string; port: number };

export interface HttpResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  text(): string;
  json(): any;
}

export function request(ep: Endpoint, method: string, path: string, body?: unknown, headers: Record<string, string> = {}, timeoutMs = 120_000): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const target = ep.transport === 'unix' ? { socketPath: ep.socketPath } : { host: ep.host, port: ep.port };
    const req = httpRequest({
      ...target, method, path, timeout: timeoutMs,
      headers: { ...headers, ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: buf, text: () => buf.toString('utf8'), json: () => JSON.parse(buf.toString('utf8')) });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`délai dépassé (${timeoutMs} ms)`)));
    req.on('error', reject);
    req.end(payload);
  });
}

export async function readBody(req: IncomingMessage, limit = 4 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new GraspError(413, `corps de requête trop gros (> ${limit} o)`);
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const b = await readBody(req);
  if (b.length === 0) return {};
  try {
    const v: unknown = JSON.parse(b.toString('utf8'));
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch { throw new GraspError(400, 'corps JSON invalide (objet attendu)'); }
}

export function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': b.length });
  res.end(b);
}

export function sendBuffer(res: ServerResponse, status: number, type: string, body: Buffer | string): void {
  const b = typeof body === 'string' ? Buffer.from(body) : body;
  res.writeHead(status, { 'content-type': type, 'content-length': b.length });
  res.end(b);
}

export function sendError(res: ServerResponse, err: unknown): void {
  const status = err instanceof GraspError ? err.status : 500;
  const message = err instanceof Error ? err.message : String(err);
  if (!res.headersSent) sendJson(res, status, { error: message });
  else res.destroy();
}

// ---------- Helpers de validation des corps ----------

export function str(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  if (typeof v !== 'string') throw new GraspError(400, `champ « ${key} » (chaîne) requis`);
  return v;
}
export function optStr(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new GraspError(400, `champ « ${key} » : chaîne attendue`);
  return v;
}
export function optBool(body: Record<string, unknown>, key: string): boolean | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw new GraspError(400, `champ « ${key} » : booléen attendu`);
  return v;
}
export function optInt(v: unknown, key: string): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new GraspError(400, `« ${key} » : entier positif attendu`);
  return n;
}
