import { createRequire } from 'node:module';
import { GraspError, badRequest, conflict } from '../core/errors.js';
import type { ParsedKey } from './keys.js';

/**
 * Moteur Playwright de REPLI, optionnel. Le cœur de Grasp reste en CDP direct : playwright-core n'est chargé
 * (import() dynamique) qu'au premier usage, et Grasp compile, tourne et passe ses tests sans lui. On ne lance
 * jamais de navigateur Playwright : on se branche (connectOverCDP) sur le Chrome que le bridge détient déjà,
 * et on y retrouve l'onglet de la session par son targetId. Usage borné : quelques actions (click, fill…) et
 * lectures dans un cadre, jamais de code arbitraire venu de l'agent.
 *
 * Types locaux (sous-ensemble de l'API publique) : aucune dépendance de compilation à playwright-core.
 */
export interface PwTimeout { timeout?: number }
export interface PwLocator {
  click(o?: PwTimeout): Promise<void>;
  hover(o?: PwTimeout): Promise<void>;
  fill(value: string, o?: PwTimeout): Promise<void>;
  selectOption(value: string, o?: PwTimeout): Promise<string[]>;
  check(o?: PwTimeout): Promise<void>;
  uncheck(o?: PwTimeout): Promise<void>;
  press(key: string, o?: PwTimeout): Promise<void>;
  pressSequentially(text: string, o?: PwTimeout & { delay?: number }): Promise<void>;
  setInputFiles(files: string[], o?: PwTimeout): Promise<void>;
  innerText(o?: PwTimeout): Promise<string>;
  inputValue(o?: PwTimeout): Promise<string>;
  ariaSnapshot(o?: PwTimeout): Promise<string>;
  waitFor(o?: PwTimeout & { state?: 'attached' | 'detached' | 'visible' | 'hidden' }): Promise<void>;
  count(): Promise<number>;
}
export interface PwFrameLocator {
  locator(selector: string): PwLocator;
  frameLocator(selector: string): PwFrameLocator;
  getByText(text: string, o?: { exact?: boolean }): PwLocator;
}
export interface PwCdpSession { send(method: string, params?: object): Promise<any>; detach(): Promise<void> }
export interface PwPage {
  locator(selector: string): PwLocator;
  frameLocator(selector: string): PwFrameLocator;
  keyboard: { press(key: string): Promise<void> };
  isClosed(): boolean;
}
export interface PwContext { pages(): PwPage[]; newCDPSession(page: PwPage): Promise<PwCdpSession> }
export interface PwBrowser {
  contexts(): PwContext[];
  /** Sur une connexion connectOverCDP : ferme le WebSocket de Playwright, JAMAIS le navigateur (vérifié par les tests). */
  close(): Promise<void>;
  isConnected(): boolean;
  on(event: 'disconnected', f: () => void): void;
}
export interface PwModule {
  chromium: { connectOverCDP(endpoint: string, o: { noDefaults?: boolean; isLocal?: boolean; timeout?: number }): Promise<PwBrowser> };
}

export const PLAYWRIGHT_HINT = 'npm i playwright-core dans le dossier de Grasp (aucun navigateur à télécharger : Grasp se branche sur son propre Chrome)';
/** Module chargé : playwright-core, ou GRASP_PLAYWRIGHT_MODULE (ex. « playwright », un chemin absolu). */
export const defaultModule = (): string => process.env.GRASP_PLAYWRIGHT_MODULE || 'playwright-core';

/** Délai d'une action explicite (--engine playwright, frame=) : Playwright attend l'actionnabilité jusque-là. */
export const PW_ACTION_TIMEOUT_MS = 10_000;
/** Délai d'un rejeu automatique (fallbackEngine) : court, l'étage suivant (synthétique) doit rester proche. */
export const PW_FALLBACK_TIMEOUT_MS = 5000;
/** Connexion fermée après cette inactivité : Runtime/Network de Playwright ne restent pas actifs sur l'onglet. */
export const PW_IDLE_MS = 60_000;

/** Charge le module Playwright (import() dynamique) ; absent → 501 qui dit quoi installer. */
export async function loadPlaywright(spec: string = defaultModule()): Promise<PwModule> {
  let m: unknown;
  try { m = await import(spec); } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') throw new GraspError(501, `moteur Playwright indisponible : le module « ${spec} » n'est pas installé — ${PLAYWRIGHT_HINT}`);
    throw new GraspError(500, `moteur Playwright : chargement de « ${spec} » impossible : ${(e as Error).message}`);
  }
  const mod = m as Partial<PwModule> & { default?: Partial<PwModule> };
  const pw = typeof mod.chromium?.connectOverCDP === 'function' ? mod : mod.default;
  if (typeof pw?.chromium?.connectOverCDP !== 'function') throw new GraspError(500, `moteur Playwright : « ${spec} » n'expose pas chromium.connectOverCDP (ce n'est pas playwright-core ?)`);
  return pw as PwModule;
}

/** Version de playwright-core installée, ou null (doctor, journal du serveur). */
export function playwrightVersion(spec: string = defaultModule()): string | null {
  try {
    const req = createRequire(import.meta.url);
    return String((req(`${spec}/package.json`) as { version?: unknown }).version ?? '?');
  } catch { return null; }
}

/**
 * Version minimale : l'option noDefaults de connectOverCDP (qui laisse en place le comportement de
 * téléchargement de Grasp) est indispensable ; seule la 1.64 a été vérifiée.
 */
export const MIN_PLAYWRIGHT = '1.64.0';
export function assertPlaywrightVersion(v: string | null): void {
  if (v === null) return; // module désigné par un chemin : version illisible, on fait confiance
  const n = (x: string) => x.split('.').slice(0, 3).map((p) => Number.parseInt(p, 10) || 0);
  const [a, b] = [n(v), n(MIN_PLAYWRIGHT)];
  for (let i = 0; i < 3; i++) {
    if (a[i]! > b[i]!) return;
    if (a[i]! < b[i]!) throw new GraspError(501, `moteur Playwright : playwright-core ${v} est trop ancien (${MIN_PLAYWRIGHT} ou plus requis : option noDefaults) — npm i playwright-core@latest`);
  }
}

/** `frame=<css de l'iframe> >> [frame=… >>] <sélecteur>` : null si le sélecteur ne vise pas un cadre. */
export interface FrameTarget { frames: string[]; target: string }
export function parseFrameTarget(sel: string): FrameTarget | null {
  const s = sel.trim();
  if (!s.startsWith('frame=')) return null;
  const parts = s.split(/\s*>>\s*/);
  const frames: string[] = [];
  while (parts.length > 0 && parts[0]!.startsWith('frame=')) {
    const f = parts.shift()!.slice('frame='.length).trim();
    if (f === '') throw badRequest("frame= attend le sélecteur CSS de l'iframe (ex. frame=#editeur >> button)");
    frames.push(f);
  }
  return { frames, target: parts.join(' >> ').trim() };
}

const MOD_NAMES: Array<[number, string]> = [[1, 'Alt'], [2, 'Control'], [4, 'Meta'], [8, 'Shift']];
/** Touche analysée par Grasp (parseKey) → syntaxe de Playwright (« Control+a », « Shift+Tab »). */
export function playwrightKey(k: ParsedKey): string {
  const mods = MOD_NAMES.filter(([bit]) => (k.modifiers & bit) !== 0).map(([, n]) => n);
  return [...mods, k.def.key === ' ' ? 'Space' : k.def.key].join('+');
}

/** Erreur de Playwright → GraspError (statut HTTP, message court : première ligne et fin du journal d'appel). */
export function pwError(e: unknown, what: string): GraspError {
  if (e instanceof GraspError) return e;
  const err = e instanceof Error ? e : new Error(String(e));
  const lines = err.message.split('\n').map((l) => l.trim()).filter((l) => l !== '' && l !== 'Call log:');
  const head = (lines[0] ?? 'échec').replace(/^[\w.]+:\s*/, '').replace(/^Error:\s*/, '');
  const log = lines.slice(1).filter((l) => l.startsWith('-') || /^\d+ ×/.test(l)).slice(-3).map((l) => l.replace(/^- /, '')).join(' ; ');
  const cut = (s: string) => (s.length > 300 ? `${s.slice(0, 299)}…` : s);
  const msg = `moteur Playwright : ${what} : ${cut(head)}${log !== '' ? ` (${cut(log)})` : ''}`;
  if (err.name === 'TimeoutError' || /Timeout \d+ms exceeded/.test(err.message)) return new GraspError(504, msg);
  const strict = /strict mode violation: .* resolved to (\d+) elements/.exec(err.message);
  if (strict !== null) return conflict(`moteur Playwright : ${what} : ${strict[1]} éléments correspondent — précisez le sélecteur`);
  if (/has been closed|Browser closed|Target closed|disconnected/i.test(err.message)) return new GraspError(502, msg);
  if (/is not an? <|Not a checkbox|not a checkbox or radio|Cannot type|not an <input>|Element is not a/i.test(err.message)) return badRequest(msg);
  if (/did not change its state|Cannot uncheck radio/i.test(err.message)) return conflict(msg);
  return new GraspError(502, msg);
}

export interface EngineOptions {
  /** URL WebSocket DevTools du navigateur du bridge (Linux, chrome.exe via 127.0.0.1:<port>, ou mode attach). */
  endpoint: string | undefined;
  /** Onglet de la session. */
  targetId: string;
  module?: string | undefined;
  idleMs: number;
  /** Navigateur sur le même système de fichiers (upload par chemin) ; sinon fichiers transmis par contenu (≤ 50 Mo). */
  isLocal: boolean;
  log?: ((m: string) => void) | undefined;
}

interface Link { browser: PwBrowser; page: PwPage }

/**
 * Connexion Playwright paresseuse à l'onglet de la session. Jamais de navigateur lancé ni fermé : la
 * déconnexion ne ferme que le WebSocket de Playwright. Fermée après `idleMs` d'inactivité et à l'arrêt
 * du bridge (fermeture de session, bascule de profil).
 */
export class PlaywrightEngine {
  private link: Promise<Link> | undefined;
  private idle: NodeJS.Timeout | undefined;
  private current: Link | undefined;

  constructor(private readonly o: EngineOptions) {}

  get connected(): boolean { return this.current !== undefined && this.current.browser.isConnected(); }

  /** Page Playwright de l'onglet ; `connectedMs` : présent si cet appel a ouvert la connexion. */
  async page(): Promise<{ page: PwPage; connectedMs?: number }> {
    this.touch();
    if (this.link !== undefined) {
      const l = await this.link;
      if (l.browser.isConnected() && !l.page.isClosed()) return { page: l.page };
      this.link = undefined;
      this.current = undefined;
    }
    const t0 = Date.now();
    const p = this.connect();
    this.link = p;
    try {
      const l = await p;
      this.current = l;
      this.touch();
      return { page: l.page, connectedMs: Date.now() - t0 };
    } catch (e) {
      if (this.link === p) this.link = undefined;
      throw e;
    }
  }

  private async connect(): Promise<Link> {
    if (this.o.endpoint === undefined) throw new GraspError(501, 'moteur Playwright : URL DevTools du navigateur inconnue pour ce bridge');
    const pw = await loadPlaywright(this.o.module);
    assertPlaywrightVersion(playwrightVersion(this.o.module));
    let browser: PwBrowser;
    try {
      // noDefaults : pas de Browser.setDownloadBehavior (le dossier et la politique de téléchargement de
      // Grasp restent en place), pas de focus émulé, pas d'émulation de média sur le contexte existant.
      browser = await pw.chromium.connectOverCDP(this.o.endpoint, { noDefaults: true, isLocal: this.o.isLocal, timeout: 15_000 });
    } catch (e) { throw pwError(e, 'connexion au navigateur'); }
    browser.on('disconnected', () => { this.link = undefined; this.current = undefined; });
    try {
      for (const ctx of browser.contexts()) {
        for (const page of ctx.pages()) {
          const s = await ctx.newCDPSession(page);
          let id: string | undefined;
          try { id = (await s.send('Target.getTargetInfo')).targetInfo?.targetId; } finally { await s.detach().catch(() => undefined); }
          if (id === this.o.targetId) return { browser, page };
        }
      }
    } catch (e) { await browser.close().catch(() => undefined); throw pwError(e, "recherche de l'onglet"); }
    await browser.close().catch(() => undefined);
    throw new GraspError(502, "moteur Playwright : l'onglet de la session est introuvable parmi les pages vues par Playwright");
  }

  private touch(): void {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => { void this.disconnect('inactivité'); }, this.o.idleMs);
    this.idle.unref();
  }

  /**
   * Déconnexion. Sur une connexion connectOverCDP, Browser.close() de Playwright ne fait que fermer son
   * WebSocket (aucun Browser.close CDP) : le navigateur, l'onglet et la connexion CDP de Grasp restent.
   */
  async disconnect(why = 'fermeture'): Promise<void> {
    clearTimeout(this.idle);
    const p = this.link;
    this.link = undefined;
    this.current = undefined;
    if (p === undefined) return;
    let l: Link;
    try { l = await p; } catch { return; }
    await l.browser.close().catch((e: Error) => this.o.log?.(`moteur Playwright : déconnexion (${why}) en échec : ${e.message}`));
  }
}
