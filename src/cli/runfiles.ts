import { accessSync, constants, existsSync, lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { writePrivateFile } from '../core/perms.js';
import { compileScript, type RunResult } from '../control/run.js';

/**
 * `screenshot -o <fichier>` dans `grasp run` : le serveur renvoie l'image (base64) dans le résultat de l'étape,
 * la CLI l'écrit ici, SOUS le répertoire de sortie du run et nulle part ailleurs.
 */

const inside = (root: string, p: string): boolean => {
  const r = relative(root, p);
  return r === '' || (r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r));
};

/**
 * Contrôles communs (sans rien créer) : `rel` relatif, sous `base` ; l'ancêtre existant le plus proche est un
 * répertoire inscriptible, sous `base` une fois les liens résolus ; la cible n'est pas un répertoire.
 * Renvoie la racine résolue et la cible.
 */
function checkUnder(base: string, rel: string): { root: string; target: string } {
  if (isAbsolute(rel)) throw new Error(`${rel} : chemin relatif attendu`);
  const root = realpathSync(base);
  const target = resolve(root, rel);
  if (!inside(root, target) || target === root) throw new Error(`${rel} sort du répertoire de sortie ${root}`);
  let anc = dirname(target);
  while (!existsSync(anc)) anc = dirname(anc);
  const real = realpathSync(anc);
  if (!inside(root, real)) throw new Error(`${rel} sort du répertoire de sortie ${root} (lien symbolique)`);
  if (!statSync(real).isDirectory()) throw new Error(`${relative(root, anc)} n'est pas un répertoire`);
  accessSync(real, constants.W_OK | constants.X_OK);
  let isDir = false;
  try { isDir = lstatSync(target).isDirectory(); } catch { /* absent : normal */ }
  if (isDir) throw new Error(`${rel} est un répertoire`);
  return { root, target };
}

/**
 * Écrit `data` dans `rel` sous `base` (0600, atomique). Refus : chemin qui sort de `base`, y compris par un lien
 * symbolique d'un répertoire intermédiaire ; un lien à la place du fichier est remplacé, sa cible jamais écrite.
 * Les sous-répertoires manquants sont créés seulement après vérification de l'ancêtre existant le plus proche.
 */
export function writeUnder(base: string, rel: string, data: Buffer): string {
  const { root, target } = checkUnder(base, rel);
  mkdirSync(dirname(target), { recursive: true });
  const parent = realpathSync(dirname(target));
  if (!inside(root, parent)) throw new Error(`${rel} sort du répertoire de sortie ${root} (lien symbolique)`);
  const file = join(parent, basename(target));
  writePrivateFile(file, data);
  return file;
}

/**
 * AVANT d'envoyer le script : crée le répertoire de sortie et vérifie, sans rien écrire d'autre, chaque chemin de
 * `screenshot -o` (mêmes contrôles que writeUnder). Un --out-dir ou un chemin inutilisable est refusé avant que la
 * moindre étape (clic, soumission) ne parte — sinon le run s'exécuterait pour rien, voire au-delà d'une étape KO.
 * Script invalide : rien à vérifier ici, le serveur rend l'erreur d'analyse (même compilateur).
 */
export function checkRunOut(script: string, outDir: string): void {
  let steps: ReturnType<typeof compileScript>;
  try { steps = compileScript(script, { files: true }); } catch { steps = []; }
  try {
    mkdirSync(outDir, { recursive: true });
    if (!statSync(outDir).isDirectory()) throw new Error('n\'est pas un répertoire');
  } catch (e) { throw new Error(`--out-dir ${outDir} : ${(e as Error).message}`); }
  for (const s of steps) {
    if (s.rq.saveAs === undefined) continue;
    try { checkUnder(outDir, s.rq.saveAs); } catch (e) { throw new Error(`ligne ${s.src.line} : screenshot -o ${s.rq.saveAs} : ${(e as Error).message}`); }
  }
}

interface ShotResult { saveAs: string; data?: string; path?: string }

/**
 * Écrit les captures nommées d'un run et remplace, dans le résultat, l'image par le chemin écrit (la sortie
 * --json ne transporte jamais le base64). Un échec d'écriture fait échouer l'étape (et le run), jamais en silence,
 * et ne lève jamais : les étapes déjà exécutées restent rendues.
 */
export function writeRunShots(r: RunResult, outDir: string): void {
  // Vérifié avant le run (checkRunOut) ; s'il a disparu depuis, chaque capture échoue ci-dessous, sans lever.
  try { mkdirSync(outDir, { recursive: true }); } catch { /* writeUnder le dira, étape par étape */ }
  const written = new Set<string>();
  for (const st of r.steps) {
    const res = st.result as ShotResult | undefined;
    if (!st.ok || res === undefined || typeof res !== 'object' || typeof res.saveAs !== 'string' || typeof res.data !== 'string') continue;
    const data = Buffer.from(res.data, 'base64');
    delete res.data;
    try {
      const file = writeUnder(outDir, res.saveAs, data);
      written.add(file);
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
  writeFailShots(r, outDir, written);
}

/**
 * Captures d'échec (--shot-on-error, rapport) d'un run --out-dir : écrites sous --out-dir avec les mêmes contrôles
 * que screenshot -o, sans écraser une capture nommée du même run ; le rapport et le message d'erreur citent le
 * chemin final. Un échec d'écriture est signalé dans les notes de l'étape (déjà en échec), jamais en silence.
 */
function writeFailShots(r: RunResult, outDir: string, written: Set<string>): void {
  for (const st of r.steps) {
    const fs = st.failShot;
    if (fs === undefined) continue;
    delete st.failShot;
    const rs = r.report?.steps.find((x) => x.n === st.n);
    let rel = fs.saveAs;
    for (let i = 2; written.has(resolve(realpathOr(outDir), rel)); i++) rel = fs.saveAs.replace(/\.png$/, `-${i}.png`);
    try {
      const file = writeUnder(outDir, rel, Buffer.from(fs.data, 'base64'));
      written.add(file);
      st.screenshot = file;
      const err = fs.inError ? `${st.error ?? 'échec'} (capture : ${file})` : undefined;
      if (err !== undefined) st.error = err;
      if (rs !== undefined) { rs.screenshot = file; if (err !== undefined) rs.error = err; }
    } catch (e) {
      delete st.screenshot;
      if (rs !== undefined) delete rs.screenshot;
      const note = `capture d'échec non écrite : ${(e as Error).message}`;
      st.detail = st.detail !== undefined ? `${st.detail} ; ${note}` : note;
    }
  }
}

const realpathOr = (p: string): string => { try { return realpathSync(p); } catch { return p; } };
