/**
 * Onglets d'une session : forme partagée par le bridge (GET /tabs), la CLI (`grasp tabs`) et `grasp run`.
 * Sortie bornée : le nombre d'onglets l'est par maxTabs, chaque ligne par TAB_TITLE_MAX et TAB_URL_MAX.
 */

export interface TabInfo {
  /** Identifiant court, stable pour la vie de l'onglet : t1, t2… (jamais réutilisé dans la session). */
  id: string;
  url: string;
  title: string;
  active: boolean;
  /** Onglet qui l'a ouvert (popup, target=_blank). */
  opener?: string;
}

export const TAB_TITLE_MAX = 80;
export const TAB_URL_MAX = 200;

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Une ligne : `* t1 "Titre" http://…` (`*` = actif), suivie de `(ouvert par t1)` pour un popup. */
export function formatTab(t: TabInfo): string {
  return `${t.active ? '*' : ' '} ${t.id} "${cut(t.title, TAB_TITLE_MAX)}" ${cut(t.url, TAB_URL_MAX)}${t.opener !== undefined ? ` (ouvert par ${t.opener})` : ''}`;
}

export function formatTabs(tabs: readonly TabInfo[]): string {
  return tabs.map(formatTab).join('\n');
}

/** Identifiant d'onglet valide (t1, t2…). */
export const TAB_ID_RE = /^t[1-9]\d{0,5}$/;
