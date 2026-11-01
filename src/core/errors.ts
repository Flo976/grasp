/** Erreur métier avec code HTTP. Le message est destiné à l'agent : il dit quoi faire. */
export class GraspError extends Error {
  /** `extra` : champs ajoutés au corps JSON de l'erreur (ex. chemin d'une capture, entrées console). */
  constructor(public readonly status: number, message: string, public readonly extra?: Record<string, unknown>) { super(message); }
}
export const badRequest = (m: string) => new GraspError(400, m);
export const forbidden = (m: string) => new GraspError(403, m);
export const notFound = (m: string) => new GraspError(404, m);
export const conflict = (m: string) => new GraspError(409, m);
