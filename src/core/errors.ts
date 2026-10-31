/** Erreur métier avec code HTTP. Le message est destiné à l'agent : il dit quoi faire. */
export class GraspError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}
export const badRequest = (m: string) => new GraspError(400, m);
export const forbidden = (m: string) => new GraspError(403, m);
export const notFound = (m: string) => new GraspError(404, m);
export const conflict = (m: string) => new GraspError(409, m);
