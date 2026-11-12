import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { writePrivateFile } from '../core/perms.js';
import type { RunResult } from '../control/run.js';

/**
 * `screenshot -o <fichier>` dans `grasp run` : le serveur renvoie l'image (base64) dans le résultat de l'étape,
 * la CLI l'écrit ici, SOUS le répertoire de sortie du run et nulle part ailleurs.
 */

const inside = (root: string, p: string): boolean => {
  const r = relative(root, p);
  return r === '' || (r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r));
};

/**
 * Écrit `data` dans `rel` sous `base` (0600, atomique). Refus : chemin qui sort de `base`, y compris par un lien
 * symbolique d'un répertoire intermédiaire ; un lien à la place du fichier est remplacé, sa cible jamais écrite.
 * Les sous-répertoires manquants sont créés seulement après vérification de l'ancêtre existant le plus proche.
 */
export function writeUnder(base: string, rel: string, data: Buffer): string {
  if (isAbsolute(rel)) throw new Error(`${rel} : chemin relatif attendu`);
  const root = realpathSync(base);
  const target = resolve(root, rel);
  if (!inside(root, target) || target === root) throw new Error(`${rel} sort du répertoire de sortie ${root}`);
  let anc = dirname(target);
  while (!existsSync(anc)) anc = dirname(anc);
  if (!inside(root, realpathSync(anc))) throw new Error(`${rel} sort du répertoire de sortie ${root} (lien symbolique)`);
  mkdirSync(dirname(target), { recursive: true });
  const parent = realpathSync(dirname(target));
  if (!inside(root, parent)) throw new Error(`${rel} sort du répertoire de sortie ${root} (lien symbolique)`);
  const file = join(parent, basename(target));
  writePrivateFile(file, data);
  return file;
}

interface ShotResult { saveAs: string; data?: string; path?: string }

/**
 * Écrit les captures nommées d'un run et remplace, dans le résultat, l'image par le chemin écrit (la sortie
 * --json ne transporte jamais le base64). Un échec d'écriture fait échouer l'étape (et le run), jamais en silence.
 */
export function writeRunShots(r: RunResult, outDir: string): void {
  mkdirSync(outDir, { recursive: true });
  for (const st of r.steps) {
    const res = st.result as ShotResult | undefined;
    if (!st.ok || res === undefined || typeof res !== 'object' || typeof res.saveAs !== 'string' || typeof res.data !== 'string') continue;
    const data = Buffer.from(res.data, 'base64');
    delete res.data;
    try {
      const file = writeUnder(outDir, res.saveAs, data);
      res.path = file;
      st.output = file;
    } catch (e) {
      st.ok = false;
      st.error = `capture non écrite : ${(e as Error).message}`;
      delete st.output;
      r.ok = false;
      const rs = r.report?.steps.find((x) => x.n === st.n);
      if (rs !== undefined) { rs.ok = false; rs.error = st.error; }
      if (r.report !== undefined) r.report.ok = false;
    }
  }
}
