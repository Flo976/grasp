import { createServer, connect, type Server, type Socket } from 'node:net';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';

/**
 * Proxys de test, en local uniquement : ils jouent le serveur de rebond d'un `ssh -D` (SOCKS5) ou un proxy
 * HTTP d'entreprise. Ils résolvent eux-mêmes les noms (`resolve`), comme le ferait le rebond : le navigateur
 * ne voit jamais l'adresse. Chaque nom demandé est noté dans `seen`.
 */
export interface TestProxy { url: string; seen: string[]; close(): Promise<void> }

type Resolve = (host: string, port: number) => { host: string; port: number };

function closeServer(srv: Server, sockets: Set<Socket>): Promise<void> {
  for (const s of sockets) s.destroy();
  return new Promise((r) => srv.close(() => r()));
}

/** SOCKS5 sans authentification, commande CONNECT seulement (ce qu'utilise Chrome). */
export async function startSocks5Proxy(resolve: Resolve): Promise<TestProxy> {
  const seen: string[] = [];
  const sockets = new Set<Socket>();
  const srv = createServer((c) => {
    sockets.add(c);
    c.on('close', () => sockets.delete(c));
    c.on('error', () => undefined);
    let buf = Buffer.alloc(0);
    let stage: 'greet' | 'request' | 'pipe' = 'greet';
    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (stage === 'greet') {
        if (buf.length < 2 || buf.length < 2 + buf[1]!) return;
        buf = buf.subarray(2 + buf[1]!);
        c.write(Buffer.from([5, 0]));
        stage = 'request';
      }
      if (stage === 'request') {
        if (buf.length < 5) return;
        const atyp = buf[3]!;
        let host: string;
        let off: number;
        if (atyp === 3) { const n = buf[4]!; if (buf.length < 5 + n + 2) return; host = buf.subarray(5, 5 + n).toString(); off = 5 + n; }
        else if (atyp === 1) { if (buf.length < 10) return; host = [...buf.subarray(4, 8)].join('.'); off = 8; }
        else { c.end(Buffer.from([5, 8, 0, 1, 0, 0, 0, 0, 0, 0])); return; }
        const port = buf.readUInt16BE(off);
        const rest = buf.subarray(off + 2);
        seen.push(`${host}:${port}`);
        stage = 'pipe';
        c.off('data', onData);
        const t = resolve(host, port);
        const up = connect(t.port, t.host, () => {
          c.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          if (rest.length > 0) up.write(rest);
          c.pipe(up); up.pipe(c);
        });
        sockets.add(up);
        up.on('close', () => { sockets.delete(up); c.destroy(); });
        up.on('error', () => c.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0])));
      }
    };
    c.on('data', onData);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as { port: number }).port;
  return { url: `socks5://127.0.0.1:${port}`, seen, close: () => closeServer(srv, sockets) };
}

/** Proxy HTTP « avant » (requêtes en URL absolue), sans CONNECT : suffisant pour des pages en http://. */
export async function startHttpProxy(resolve: Resolve): Promise<TestProxy> {
  const seen: string[] = [];
  const sockets = new Set<Socket>();
  const srv = createHttpServer((req, res) => {
    let u: URL;
    try { u = new URL(req.url ?? ''); } catch { res.writeHead(400); res.end(); return; }
    const port = Number(u.port || 80);
    seen.push(`${u.hostname}:${port}`);
    const t = resolve(u.hostname, port);
    const up = httpRequest({ host: t.host, port: t.port, method: req.method, path: `${u.pathname}${u.search}`, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(up);
  });
  srv.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, seen, close: () => closeServer(srv as unknown as Server, sockets) };
}
