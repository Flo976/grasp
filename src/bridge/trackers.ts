import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Blocage des traqueurs : liste de Peter Lowe (https://pgl.yoyo.org/adservers/), embarquée dans
 * `data/pgl-domains.txt` (source, date et conditions d'utilisation en tête du fichier ; idée reprise
 * d'Obscura, h4ckf0r0day/obscura, Apache-2.0, qui embarque la même liste — aucun code repris).
 *
 * Un domaine de la liste bloque aussi ses sous-domaines (`doubleclick.net` → `ad.doubleclick.net`).
 */

/** dist/src/bridge/trackers.js et src/bridge/trackers.ts : la racine du dépôt est trois niveaux plus haut. */
export const TRACKER_LIST_PATH = fileURLToPath(new URL('../../../data/pgl-domains.txt', import.meta.url));

export function parseTrackerList(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.split('\n')) {
    const l = raw.trim().toLowerCase();
    if (l === '' || l.startsWith('#')) continue;
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(l)) throw new Error(`liste de traqueurs : ligne invalide « ${raw} »`);
    out.add(l);
  }
  return out;
}

let cached: TrackerList | undefined;

export class TrackerList {
  private constructor(readonly domains: ReadonlySet<string>) {}

  static from(domains: Iterable<string>): TrackerList { return new TrackerList(new Set(domains)); }

  /** Liste embarquée, lue une fois par processus. Illisible ou vide : erreur (jamais un blocage silencieusement inactif). */
  static embedded(): TrackerList {
    if (cached === undefined) {
      const domains = parseTrackerList(readFileSync(TRACKER_LIST_PATH, 'utf8'));
      if (domains.size === 0) throw new Error(`liste de traqueurs vide : ${TRACKER_LIST_PATH}`);
      cached = new TrackerList(domains);
    }
    return cached;
  }

  /** Domaine de la liste qui couvre `host` (lui-même ou un de ses parents), sinon undefined. */
  match(host: string): string | undefined {
    let h = host.toLowerCase();
    if (h.endsWith('.')) h = h.slice(0, -1);
    for (;;) {
      if (this.domains.has(h)) return h;
      const i = h.indexOf('.');
      if (i < 0) return undefined;
      h = h.slice(i + 1);
    }
  }

  /** Domaine de la liste visé par une URL http(s), sinon undefined. */
  matchUrl(url: string): string | undefined {
    if (!url.startsWith('http:') && !url.startsWith('https:') && !url.startsWith('ws:') && !url.startsWith('wss:')) return undefined;
    let host: string;
    try { host = new URL(url).hostname; } catch { return undefined; }
    return this.match(host);
  }

  /**
   * Motifs `Fetch.enable` (jokers * et ?) : préfiltre côté navigateur, pour que seules les requêtes
   * susceptibles d'aller vers un traqueur soient suspendues. `*://*d?*` couvre `d`, ses sous-domaines et un
   * port (`?` = `/` ou `:`) ; il prend aussi des faux positifs (`notd`, `d` dans le chemin), que `matchUrl`
   * écarte — la requête est alors simplement relâchée.
   */
  fetchPatterns(): Array<{ urlPattern: string; requestStage: 'Request' }> {
    return [...this.domains].map((d) => ({ urlPattern: `*://*${d}?*`, requestStage: 'Request' as const }));
  }
}
