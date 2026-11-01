import { closeSync, fsyncSync, openSync, readdirSync, rmSync, writeSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { ensurePrivateDir } from './perms.js';
import type { ImageFormat } from './image.js';

/** Nombre de captures gardées dans le répertoire d'état : au-delà, les plus anciennes sont supprimées. */
export const CAPTURES_KEEP = 50;
const OURS = /^grasp-\d{8}T\d{12}Z-[0-9a-f]{6}\.(png|jpg|webp)$/;
let lastMs = 0;
let sub = 0;

export const extOf = (f: ImageFormat): string => (f === 'jpeg' ? 'jpg' : f);

/**
 * Écrit une capture dans `dir` (0700), fichier 0600 au nom horodaté triable, puis rotation.
 * Un échec d'écriture lève : jamais de chemin renvoyé pour un fichier qui n'existe pas.
 */
export function saveCapture(dir: string, data: Buffer, format: ImageFormat, opts: { keep?: number } = {}): string {
  const keep = opts.keep !== undefined ? opts.keep : CAPTURES_KEEP;
  // Horodatage triable, strictement croissant dans ce processus (sous-compteur dans la même milliseconde).
  const now = Date.now();
  sub = now === lastMs ? sub + 1 : 0;
  lastMs = now;
  const stamp = new Date(now).toISOString().replace(/[-:.]/g, '').replace('Z', `${String(sub % 1000).padStart(3, '0')}Z`);
  const file = join(dir, `grasp-${stamp}-${randomBytes(3).toString('hex')}.${extOf(format)}`);
  try {
    ensurePrivateDir(dir);
    const fd = openSync(file, 'wx', 0o600);
    try { writeSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
    chmodSync(file, 0o600);
  } catch (e) {
    rmSync(file, { force: true });
    throw new Error(`capture non enregistrée dans ${dir} : ${(e as Error).message}`);
  }
  const ours = readdirSync(dir).filter((f) => OURS.test(f)).sort();
  for (const old of ours.slice(0, Math.max(0, ours.length - keep))) rmSync(join(dir, old), { force: true });
  return file;
}
