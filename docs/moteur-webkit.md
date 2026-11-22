# Moteur WebKit : conception, périmètre et suite

> État : **mode minimal livré** (`grasp session create --browser webkit`). Ce document dit pourquoi il est fait
> ainsi, ce qu'il couvre, ce qu'il ne couvre pas, et dans quel ordre l'étendre.

## Le besoin

Grasp pilote Chrome. Une mise en page qui tient dans Chrome peut casser dans Safari — sur iPhone surtout
(`100vh`, `position: sticky`, polices, zones de défilement, champs de formulaire). Pour une recette mobile, il
faut un rendu **WebKit**, avec le même vocabulaire : `nav`, `snap`, `click`, `expect in-viewport`…

## La contrainte

Grasp parle à Chrome par **CDP direct**, sans bibliothèque. WebKit n'a pas de CDP : son protocole d'inspection
est différent, non stabilisé, et le WebKit de Linux (WPE/GTK) n'est pilotable de l'extérieur que par le build que
Playwright distribue (`pw_run.sh --inspector-pipe`). Réécrire un client de ce protocole reviendrait à réécrire
Playwright. D'où le choix :

| Option | Verdict |
|:--|:--|
| Client du protocole d'inspection de WebKit, écrit à la main | Écarté : protocole privé du build de Playwright, sans garantie de stabilité ; des mois de travail |
| Safari réel par `safaridriver` (WebDriver) | Écarté ici : macOS seulement, pas d'interception réseau (donc pas d'allowlist ni de garde SSRF) |
| **`playwright-core` lance WebKit ; Grasp garde son API, ses garde-fous et ses sorties** | **Retenu** |

`playwright-core` était déjà une dépendance **optionnelle** (moteur de repli branché sur le Chrome de Grasp). Elle
le reste : sans elle, Grasp compile, tourne et passe ses tests ; `--browser webkit` répond alors 501 en disant quoi
installer.

## Architecture

```
CLI / MCP / grasp run ──► control plane ──► bridge (un par session)
                                              ├─ moteur Chrome : CDP direct            (src/bridge/page.ts)
                                              └─ moteur WebKit : playwright-core       (src/bridge/webkit.ts)
                                                   webkit.launch → contexte → un onglet
```

- **Même processus bridge, même API HTTP, mêmes formes de réponse.** `src/bridge/main.ts` choisit le moteur
  (`init.engine`). La CLI, `grasp run`, le serveur MCP, l'historique, le masquage et les frontières de contenu
  n'ont **rien** de spécifique à WebKit : ils parlent au bridge.
- **Ce que le mode minimal ne fait pas répond 501** en nommant la commande et la sortie de secours (session
  Chrome) — jamais « route inconnue », jamais une option ignorée en silence.
- **Snapshot** (`src/bridge/webkit-snapshot.ts`, fonctions pures) : l'arbre ARIA de Playwright
  (`ariaSnapshot({ mode: 'ai' })`) est rendu au format de Grasp, `ref:rôle "nom"=valeur [états]`, conteneurs
  anonymes traversés, cadres compris. `--interactive`, `--outline`, `find`, `--boxes` et `--snap-diff` en dérivent.

## Garde-fous : les mêmes, appliqués autrement

| Garde-fou | Moteur Chrome | Moteur WebKit |
|:--|:--|:--|
| Allowlist + SSRF sur chaque document (page, iframes) | domaine `Fetch` de CDP | `context.route`, toute requête de navigation |
| Redirection HTTP vers un hôte interdit | interceptée saut par saut | **voir ci-dessous** |
| Téléchargements | politique `allowDownload` | toujours refusés |
| Popups, `target=_blank` | onglets pilotables | fermés avant tout chargement, URL rendue à l'agent |
| Service workers | contournés | bloqués (`serviceWorkers: 'block'`) |
| Traqueurs (`blockTrackers`) | annulés | annulés |
| Frontières de contenu | enveloppe du bridge | **la même enveloppe** (`withContentBoundaries`) |
| Secrets (`fill … secret:NOM`), valeurs de recette | masqués, domaine vérifié | masqués, domaine vérifié |
| `eval`, cookies, stockage | `allowEval`, `allowCookies` | idem |

### Redirections : le point délicat

Playwright n'appelle **pas** le gestionnaire de route pour les sauts d'une redirection HTTP, et refuse qu'on
réponde par un 3xx. Laisser faire le navigateur, c'est laisser un hôte autorisé rediriger vers `http://10.0.0.5/` :
on le *détecterait* après coup, on ne le *bloquerait* pas (régression n°2 du projet, « détecter ≠ bloquer »).

Le garde demande donc lui-même chaque **document** sans suivre la redirection (`route.fetch({ maxRedirects: 0 })`,
cookies du contexte compris) :

1. réponse finale → rendue telle quelle au navigateur (`route.fulfill`) ;
2. `3xx` + `Location` → la cible passe par `checkNavigation` (allowlist puis SSRF). Refusée : requête annulée,
   **la cible n'est jamais demandée**. Admise : le garde sert, sous l'URL d'origine, un document minimal qui fait
   `location.replace(cible)` ; la requête de la cible repasse par le garde (chaînes comprises, 20 sauts au plus).

Conséquences assumées : les documents sont demandés par la pile réseau de Node (les sous-ressources, elles, par
WebKit) ; un `307/308` sur un POST est rejoué en GET ; le référent du saut est perdu. Le rendu, lui, est bien celui
de WebKit — c'est l'objet du moteur.

## Périmètre livré (mode minimal)

`nav` `back` `forward` `reload` · `snap` (`--interactive`, `--outline`, `--scope`, `--boxes`) `find` `text` ·
`click` `fill` `type` `select` `check` `press` `hover` (avec `--snap-diff`, `--dialog`, `--shot-on-error`) · `wait` ·
`expect text|no-text|url|title|sel|no-sel|value|in-viewport|not-clipped|no-horizontal-overflow` · `screenshot`
(`--full`, `--el`, `--format png|jpeg`) · `viewport` et appareils (`iphone-se`, `iphone-14`…, user agent Safari
d'iPhone en mode mobile) · `eval` · `cookies` · `storage` · `state import` et `session create --state` (recette de
session) · `grasp run` et les outils MCP correspondants.

Les trois assertions de mise en page réutilisent **le même code de mesure et de jugement** que le moteur Chrome
(`src/bridge/geometry.ts`) : mêmes messages, mêmes seuils.

## Limites connues

- **Refs** : `e12` ou `f1e3` (préfixe du cadre tel que Playwright le numérote : une iframe, ou la page elle-même
  après une navigation). Ce sont celles de Playwright, valables jusqu'au rendu suivant : un élément
  renommé ou re-rendu change de ref (`--snap-diff` montre alors `-` puis `+`). Elles ne sont pas les refs à hash du
  moteur Chrome et ne se transportent pas d'un moteur à l'autre.
- **Un seul onglet** ; pas de profil persistant, de proxy, de `--http-auth`, de `hostResolverRules`,
  d'`ignoreCertErrorsFor` (refusés à la création ou signalés au démarrage).
- **Pas de contrôle de l'adresse distante effective** : le moteur Chrome revérifie l'adresse jointe à la réponse
  (rebinding DNS) ; ici la résolution est jugée avant la requête seulement.
- **Viewport** : densité, mode mobile et tactile sont des réglages du contexte WebKit, fixés à la création
  (`session create --browser webkit --viewport iphone-14`) ; `grasp viewport LxH` ne change ensuite que la taille.
- **Pas de** `console`, `network`, `expect no-console-errors|no-form-errors|request|a11y`, `a11y`, `scroll`, `pdf`,
  `upload`, `tabs`, `state export`, `audit`, `diff`, `history --as-run` (les refs n'ont pas de sélecteur durable),
  `text --markdown`, `screenshot --refs|--format webp`, recyclage du navigateur.
- **sessionStorage importé avant navigation** : posé par un script d'initialisation qui laisse un témoin
  `__grasp_etat_<n>` dans le sessionStorage (seule trace visible de la page).
- **Ce n'est pas Safari** : c'est le moteur WebKit (WPE sous Linux) au build de Playwright. La mise en page et le
  JavaScript sont ceux de WebKit ; les comportements propres à iOS (barres du navigateur, clavier virtuel, zones de
  sécurité matérielles, lecteur vidéo natif) ne sont pas reproduits.

## Installation, et pourquoi un premier essai avait planté

```bash
npm i playwright-core                      # dans le dossier de Grasp (dépendance optionnelle)
npx playwright-core install webkit         # le build WebKit de CETTE version de playwright-core
sudo npx playwright-core install-deps webkit
```

Diagnostic du plantage au lancement, sur Ubuntu 26.04 (deux causes cumulées) :

1. **Mauvaise révision du build** : le cache contenait `webkit-2311` (installé par un autre Playwright), alors que
   playwright-core 1.64.1 attend `webkit-2370` — « Executable doesn't exist at …/webkit-2370/pw_run.sh ».
2. **Bibliothèques système absentes** : `libevent-2.1-7t64`, `libmanette-0.2-0`, puis `libhidapi-hidraw0` (Playwright
   n'annonce que les deux premières ; la troisième n'apparaît qu'une fois celles-ci installées).
   `sudo apt-get install libevent-2.1-7t64 libmanette-0.2-0 libhidapi-hidraw0`.

Grasp traduit ces deux échecs en message actionnable (`explainLaunchError`), au lieu du journal brut de Playwright.

## Suite proposée (par valeur décroissante)

1. **Console et erreurs de page** (`page.on('console' | 'pageerror' | 'requestfailed')`) : débloque
   `expect no-console-errors` et le rapport de recette complet — le manque le plus sensible en recette.
2. **`scroll`** et `expect no-form-errors` (relevé DOM fixe, déjà écrit pour Chrome).
3. **Journal réseau** (`network`, `expect request`).
4. **Onglets** (popups OAuth) : `context.on('page')` au lieu de la fermeture.
5. **Contrôle de l'adresse distante** des documents (résolution épinglée côté Node) pour fermer le rebinding DNS.
6. **Firefox** par le même chemin (`--browser firefox`) : le bridge n'a presque rien de propre à WebKit.
