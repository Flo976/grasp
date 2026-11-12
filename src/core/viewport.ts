/**
 * Viewport émulé d'une session (grasp viewport, session create --viewport) : taille CSS, densité de pixels,
 * mode mobile, écran tactile, user agent mobile (opt-in). Appliqué par le bridge à SON onglet seulement
 * (Emulation.setDeviceMetricsOverride, setTouchEmulationEnabled, setUserAgentOverride) ; conservé par le
 * control plane pour être réappliqué après une bascule de profil ou un recyclage du navigateur.
 */

import { GraspError } from './errors.js';

export interface ViewportSpec {
  /** Largeur et hauteur CSS du viewport (px). */
  width: number;
  height: number;
  /** devicePixelRatio ; 0 = celui du navigateur (inchangé). */
  dpr: number;
  /** Mode mobile de Chrome : balise <meta name=viewport> prise en compte, barres de défilement superposées. */
  mobile: boolean;
  /** Écran tactile émulé (navigator.maxTouchPoints, événements tactiles). */
  touch: boolean;
  /** User agent mobile (Android, Chrome de même version majeure) : opt-in, jamais implicite. */
  mobileUa: boolean;
  /** Préréglage d'origine, pour l'affichage (les valeurs ci-dessus font foi). */
  device?: string;
}

interface Device { width: number; height: number; dpr: number; mobile: boolean; touch: boolean; label: string }

/**
 * Préréglages : dimensions CSS et densité de la liste d'appareils de l'émulation de Chrome DevTools. Le user
 * agent n'en fait PAS partie : `--mobile-ua` le demande explicitement.
 */
export const DEVICES: Readonly<Record<string, Device>> = Object.freeze({
  'iphone-se': { width: 375, height: 667, dpr: 2, mobile: true, touch: true, label: 'iPhone SE' },
  'iphone-14': { width: 390, height: 844, dpr: 3, mobile: true, touch: true, label: 'iPhone 14' },
  'pixel-7': { width: 412, height: 915, dpr: 2.625, mobile: true, touch: true, label: 'Pixel 7' },
  'galaxy-s8': { width: 360, height: 740, dpr: 4, mobile: true, touch: true, label: 'Galaxy S8+' },
  'ipad-mini': { width: 768, height: 1024, dpr: 2, mobile: true, touch: true, label: 'iPad Mini' },
  'laptop': { width: 1366, height: 768, dpr: 1, mobile: false, touch: false, label: 'portable 1366×768' },
  'desktop': { width: 1920, height: 1080, dpr: 1, mobile: false, touch: false, label: 'bureau 1920×1080' },
});

export const VIEWPORT_MIN = 50;
export const VIEWPORT_MAX = 10_000;
export const DPR_MIN = 0.5;
export const DPR_MAX = 5;

/** « 360x800 » (x, X ou ×) → largeur et hauteur ; undefined si la chaîne n'a pas cette forme. */
export function parseSize(s: string): { width: number; height: number } | undefined {
  const m = /^\s*(\d+)\s*[xX×]\s*(\d+)\s*$/.exec(s);
  return m ? { width: Number(m[1]), height: Number(m[2]) } : undefined;
}

function dim(v: number, what: string): number {
  if (!Number.isInteger(v) || v < VIEWPORT_MIN || v > VIEWPORT_MAX) throw new GraspError(400, `viewport : ${what} entière de ${VIEWPORT_MIN} à ${VIEWPORT_MAX} px attendue (reçu ${String(v)})`);
  return v;
}

function bool(body: Record<string, unknown>, k: string): boolean | undefined {
  const v = body[k];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw new GraspError(400, `viewport : ${k} booléen attendu`);
  return v;
}

const KEYS = new Set(['size', 'device', 'width', 'height', 'dpr', 'mobile', 'touch', 'mobileUa']);

/**
 * Corps JSON → spécification validée. `size` (« 360x800 ») ou `width` + `height`, ou `device` (préréglage) dont
 * les champs explicites surchargent les valeurs. Une clé inconnue est refusée (jamais ignorée).
 * Hors préréglage, `mobile` et `touch` valent false et `dpr` 0 (densité du navigateur) s'ils sont absents.
 */
export function viewportSpecOf(raw: unknown): ViewportSpec {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new GraspError(400, 'viewport : objet attendu ({ size: "360x800" } ou { device: "iphone-se" })');
  const body = raw as Record<string, unknown>;
  for (const k of Object.keys(body)) if (!KEYS.has(k)) throw new GraspError(400, `viewport : clé inconnue « ${k} » (clés : ${[...KEYS].join(', ')})`);
  let base: Device | undefined;
  let device: string | undefined;
  if (body.device !== undefined && body.device !== null) {
    if (typeof body.device !== 'string') throw new GraspError(400, 'viewport : device, chaîne attendue');
    device = body.device.trim().toLowerCase();
    base = DEVICES[device];
    if (base === undefined) throw new GraspError(400, `viewport : appareil inconnu « ${body.device} » (appareils : ${Object.keys(DEVICES).join(', ')})`);
  }
  let size: { width: number; height: number } | undefined;
  if (body.size !== undefined && body.size !== null) {
    if (typeof body.size !== 'string') throw new GraspError(400, 'viewport : size, chaîne « LARGEURxHAUTEUR » attendue');
    size = parseSize(body.size);
    if (size === undefined) throw new GraspError(400, `viewport : taille « ${body.size} » illisible (attendu LARGEURxHAUTEUR, ex. 360x800)`);
  }
  const num = (k: 'width' | 'height' | 'dpr'): number | undefined => {
    const v = body[k];
    if (v === undefined || v === null) return undefined;
    const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    if (typeof n !== 'number' || !Number.isFinite(n)) throw new GraspError(400, `viewport : ${k} numérique attendu (reçu ${JSON.stringify(v)})`);
    return n;
  };
  const w = num('width'), h = num('height');
  if (size !== undefined && (w !== undefined || h !== undefined)) throw new GraspError(400, 'viewport : size et width/height s\'excluent');
  if ((w === undefined) !== (h === undefined)) throw new GraspError(400, 'viewport : width et height vont ensemble');
  if (w !== undefined && h !== undefined) size = { width: w, height: h };
  if (size === undefined && base === undefined) throw new GraspError(400, `viewport : taille (ex. 360x800) ou appareil attendu (appareils : ${Object.keys(DEVICES).join(', ')})`);
  const dpr = num('dpr');
  if (dpr !== undefined && (dpr < DPR_MIN || dpr > DPR_MAX)) throw new GraspError(400, `viewport : dpr de ${DPR_MIN} à ${DPR_MAX} attendu (reçu ${dpr})`);
  const mobile = bool(body, 'mobile'), touch = bool(body, 'touch'), mobileUa = bool(body, 'mobileUa');
  const spec: ViewportSpec = {
    width: dim(size !== undefined ? size.width : base!.width, 'largeur'),
    height: dim(size !== undefined ? size.height : base!.height, 'hauteur'),
    dpr: dpr !== undefined ? dpr : base !== undefined ? base.dpr : 0,
    mobile: mobile !== undefined ? mobile : base !== undefined && base.mobile,
    touch: touch !== undefined ? touch : base !== undefined && base.touch,
    mobileUa: mobileUa === true,
  };
  if (device !== undefined) spec.device = device;
  return spec;
}

/** Ligne lisible : « 360x800 dpr 3, mobile, tactile, UA mobile (galaxy-s8) ». */
export function describeViewport(v: ViewportSpec): string {
  const parts = [`${v.width}x${v.height}`, ...(v.dpr > 0 ? [`dpr ${v.dpr}`] : []), ...(v.mobile ? ['mobile'] : []), ...(v.touch ? ['tactile'] : []), ...(v.mobileUa ? ['UA mobile'] : [])];
  return `${parts.join(', ')}${v.device !== undefined ? ` (${v.device})` : ''}`;
}

/**
 * User agent mobile au format réduit de Chrome (Android, version majeure seule), pour la version majeure du
 * navigateur piloté. `Browser.getVersion().product` : « Chrome/150.0.… » ou « HeadlessChrome/150.0.… ».
 */
export function mobileUserAgent(product: string): { userAgent: string; major: string } {
  const major = /Chrome\/(\d+)/.exec(product)?.[1] ?? '120';
  return { userAgent: `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`, major };
}

/**
 * Ligne de sortie de `grasp viewport` (CLI et run) : réglage de Grasp, puis ce que la page mesure elle-même.
 * « 360x800, mobile, tactile — page : 360x800, dpr 1, 5 point(s) tactile(s), pointeur coarse ».
 */
export function renderViewport(j: { viewport?: unknown; measured?: unknown }): string {
  const v = j.viewport as ViewportSpec | null | undefined;
  const set = v !== undefined && v !== null ? describeViewport(v) : 'viewport du navigateur (aucune émulation)';
  const m = j.measured as { width: number; height: number; dpr: number; touchPoints: number; pointer: string; mobileUa: boolean } | undefined;
  if (m === undefined) return `${set} — page : mesure impossible`;
  return `${set} — page : ${m.width}x${m.height}, dpr ${m.dpr}, ${m.touchPoints} point(s) tactile(s), pointeur ${m.pointer}${m.mobileUa ? ', UA mobile' : ''}`;
}
