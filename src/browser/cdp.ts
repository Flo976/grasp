import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

export interface CdpEvent {
  method: string;
  params: any;
  sessionId?: string;
}

export class CdpError extends Error {
  constructor(public readonly method: string, public readonly code: number, message: string) {
    super(`${method}: ${message}`);
  }
}

interface Pending { method: string; sessionId: string | undefined; resolve(v: unknown): void; reject(e: Error): void }

/** Client CDP minimal sur WebSocket, avec sessions « flatten » (un seul socket pour toutes les cibles). */
export class CdpClient extends EventEmitter {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closedReason: string | null = null;

  private constructor(private readonly ws: WebSocket) {
    super();
    ws.on('message', (data) => this.onMessage(data.toString()));
    ws.on('close', () => this.failAll('connexion CDP fermée'));
    ws.on('error', (e) => this.failAll(`connexion CDP fermée (${e.message})`));
  }

  static connect(url: string, timeoutMs = 10_000): Promise<CdpClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
      const t = setTimeout(() => { ws.terminate(); reject(new Error(`CDP : délai de connexion dépassé (${url})`)); }, timeoutMs);
      ws.once('open', () => { clearTimeout(t); resolve(new CdpClient(ws)); });
      ws.once('error', (e) => { clearTimeout(t); reject(new Error(`CDP : connexion impossible (${e.message})`)); });
    });
  }

  get closed(): boolean { return this.closedReason !== null; }

  send<T = any>(method: string, params: object = {}, sessionId?: string): Promise<T> {
    if (this.closedReason !== null) return Promise.reject(new Error(`${method}: ${this.closedReason}`));
    const id = this.nextId++;
    const msg: Record<string, unknown> = { id, method, params };
    if (sessionId !== undefined) msg.sessionId = sessionId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { method, sessionId, resolve: resolve as (v: unknown) => void, reject });
      this.ws.send(JSON.stringify(msg), (err) => {
        if (err) { this.pending.delete(id); reject(new Error(`${method}: ${err.message}`)); }
      });
    });
  }

  /** Attend un événement (optionnellement filtré). Rejette au délai ou à la fermeture. */
  waitFor<P = any>(method: string, pred: (p: P, e: CdpEvent) => boolean = () => true, timeoutMs = 10_000): Promise<P> {
    return new Promise((resolve, reject) => {
      const onEvent = (e: CdpEvent) => {
        if (e.method === method && pred(e.params as P, e)) { cleanup(); resolve(e.params as P); }
      };
      const onClose = () => { cleanup(); reject(new Error(`${method}: connexion CDP fermée`)); };
      const t = setTimeout(() => { cleanup(); reject(new Error(`délai dépassé en attendant ${method}`)); }, timeoutMs);
      const cleanup = () => { clearTimeout(t); this.off('event', onEvent); this.off('close', onClose); };
      this.on('event', onEvent);
      this.once('close', onClose);
    });
  }

  close(): void {
    this.failAll('connexion CDP fermée par le client');
    this.ws.close();
  }

  private onMessage(raw: string): void {
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }
    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new CdpError(p.method, msg.error.code, msg.error.message));
      else p.resolve(msg.result);
      return;
    }
    if (typeof msg.method === 'string') {
      // Cible fermée (onglet, popup, cadre) : Chrome ne répond plus jamais aux commandes en vol sur sa session
      // (mesuré, Chrome 150) — elles sont rejetées ici plutôt que d'attendre indéfiniment.
      if (msg.method === 'Target.detachedFromTarget' && typeof msg.params?.sessionId === 'string') this.failSession(msg.params.sessionId);
      const ev: CdpEvent = { method: msg.method, params: msg.params ?? {} };
      if (typeof msg.sessionId === 'string') ev.sessionId = msg.sessionId;
      this.emit('event', ev);
    }
  }

  private failSession(sessionId: string): void {
    for (const [id, p] of this.pending) {
      if (p.sessionId !== sessionId) continue;
      this.pending.delete(id);
      p.reject(new CdpError(p.method, -32001, 'cible fermée (session CDP détachée)'));
    }
  }

  private failAll(reason: string): void {
    if (this.closedReason !== null) return;
    this.closedReason = reason;
    for (const p of this.pending.values()) p.reject(new Error(`${p.method}: ${reason}`));
    this.pending.clear();
    this.emit('close');
  }
}
