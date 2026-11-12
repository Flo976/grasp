import type { ServerResponse } from 'node:http';
import { GraspError } from '../core/errors.js';
import type { Redactor, SecretStore } from '../core/secrets.js';

/**
 * Filet du control plane : chaque réponse (JSON, texte, erreur) est masquée juste avant l'envoi, quelle que soit
 * la route qui l'a produite (snap, text, diff, console, run, rapport de recette, erreurs). Les corps binaires
 * (capture, PDF) passent tels quels. Suppose la forme d'envoi du serveur : writeHead(status, en-têtes) puis end(corps).
 */
export function redactResponse(res: ServerResponse, r: Redactor): void {
  const writeHead = res.writeHead.bind(res) as (status: number, headers?: Record<string, unknown>) => ServerResponse;
  const end = res.end.bind(res) as (body?: unknown) => ServerResponse;
  let pending: { status: number; headers: Record<string, unknown> } | undefined;
  (res as unknown as { writeHead: unknown }).writeHead = (status: number, headers?: Record<string, unknown>) => {
    pending = { status, headers: { ...(headers ?? {}) } };
    return res;
  };
  (res as unknown as { end: unknown }).end = (body?: unknown) => {
    let b = body;
    if (pending !== undefined) {
      const ct = String(pending.headers['content-type'] ?? res.getHeader('content-type') ?? '');
      if (Buffer.isBuffer(b) || typeof b === 'string') {
        const buf = Buffer.isBuffer(b) ? b : Buffer.from(b);
        b = r.redactBody(ct, buf);
        if ((b as Buffer).length !== buf.length) pending.headers['content-length'] = (b as Buffer).length;
      }
      const notice = res.getHeader('x-grasp-notice');
      if (typeof notice === 'string') res.setHeader('x-grasp-notice', encodeURIComponent(r.redact(decodeURIComponent(notice))));
      writeHead(pending.status, pending.headers);
    }
    return end(b);
  };
}

/**
 * `fill` avec `secret: NOM` : la valeur est lue dans le magasin et transmise au bridge avec ses domaines
 * (`secretUse`), qui vérifie la page avant de saisir. Le client ne fournit jamais `secretUse` lui-même.
 */
export function withSecret(store: SecretStore, path: string, body: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (body === undefined) return body;
  if (body.secretUse !== undefined) throw new GraspError(400, 'secretUse : champ interne du serveur (utilisez « secret »: "NOM")');
  if (body.secret === undefined) return body;
  if (path !== '/fill') throw new GraspError(400, `« secret » n'est accepté que par fill (pas par ${path})`);
  if (typeof body.secret !== 'string') throw new GraspError(400, 'secret : nom (chaîne) attendu');
  if (body.value !== undefined) throw new GraspError(400, 'fill : « value » et « secret » s\'excluent');
  const e = store.lookup(body.secret);
  const { secret: _s, ...rest } = body;
  void _s;
  return { ...rest, value: e.value, secretUse: { name: e.name, domains: [...e.domains] } };
}
