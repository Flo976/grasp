# Évaluation de Lightpanda comme moteur alternatif à Chrome pour Grasp

*Branche `eval-lightpanda` (arbre de travail `/home/florent/grasp-lightpanda`), partie de `master` @ 6d01353.
Mesures du 3 novembre 2026 sur WSL2 (Linux 6.6, 20 cœurs, 40 Go), Node 22.23.4, Chrome 150.0.7871.114 headless,
Lightpanda **1.0.2** (binaire officiel `lightpanda-x86_64-linux`, SHA-256 `ae7d01d2…37e19e` vérifié contre le
condensat publié par la release GitHub). Lightpanda n'a tourné que sur 127.0.0.1, télémétrie coupée.*

## En bref

| | Chrome headless | Lightpanda 1.0.2 |
|---|---|---|
| Démarrage à froid jusqu'à l'onglet Grasp prêt (médiane) | 135 ms | **36 ms** (×3,8) |
| Mémoire au repos, PSS du groupe de processus | 318 Mo (17 processus) | **9 Mo** (1 processus) |
| Mémoire après 7 pages (3 locales, 4 publiques), PSS | 591 Mo | **53 Mo** (×11) |
| 10 sessions en parallèle (PSS totale) | 1 966 Mo | **81 Mo** (×24) |
| Snapshot Grasp de Wikipédia (3 000 lignes) | 245 ms | **56 ms** (×4,4) |
| Navigation + stabilité Grasp, pages publiques | référence | équivalente (le réseau domine) |
| Méthodes CDP de Grasp (49) / événements (21) | 49 / 21 | **47 sans erreur, 1 absente, 1 en erreur (dialogues) / 21 reçus** ; une dizaine répondent sans l'effet attendu (§2) |
| Suite de tests Grasp, intégration (224 tests) | 223 OK, 1 sauté | **142 OK**, 79 KO, 2 annulés, 1 sauté (options recommandées) |
| Scénario de bout en bout du README (`examples/e2e.sh`) | validé | **validé sans modification** |
| Captures d'écran | vraies | rendu **texte** (pas de mise en page ni de CSS) |
| Moteur Playwright de repli, onglets multiples, profils | oui | **non** (une connexion CDP = un contexte = un onglet) |

**Recommandation : moteur optionnel « lecture rapide », pas moteur principal.** Détail au §6.

## 1. État du projet Lightpanda (relevé le 3 novembre 2026)

| Point | Constat | Source |
|---|---|---|
| Dépôt | `lightpanda-io/browser`, Zig, créé en février 2023 ; ~41 000 étoiles, ~2 000 forks, 99 tickets ouverts, ~11 600 commits, 87 contributeurs ; dernier push le jour du relevé | API GitHub |
| Éditeur | Lightpanda (Selecy SAS, France) ; contributions sous **CLA** (cession de licence à l'éditeur, comme Apache) | `CLA.md` |
| Licence | **AGPL-3.0** | `LICENSE`, API GitHub |
| Versions | 24 versions publiées en 10 mois : v0.1.0 (7 janv. 2026) → 0.2.x (janv.–avr.) → 0.3.x (mai–août) → 0.4.x (sept.) → **1.0.0 (2 oct. 2026)**, 1.0.1 (15 oct.), **1.0.2 (23 oct.)** ; plus une version `nightly` continue. Rythme : une version toutes les 1 à 3 semaines | releases GitHub |
| Plateformes | Linux x86_64 et aarch64 (glibc ≥ 2.35 / 2.38, pas de musl/Alpine), macOS x86_64 et aarch64, paquets .deb, image Docker officielle. **Pas de Windows natif** (WSL2 seulement) | releases, README |
| Moteur JS | **V8** (avec instantané embarqué), options `--v8-max-heap-mb`, `--v8-flags-unsafe` | README, `help serve` |
| Analyse HTML / réseau | html5ever (Servo), libcurl (HTTP/2, proxy, cookies, cache disque optionnel) | README |
| Protocoles | **CDP** (WebSocket) et **WebDriver BiDi** + WebDriver classique ; aussi un serveur **MCP** natif et un mode `agent` | `help` |
| Rendu | « No graphical rendering engine » : mise en page **factice** (mesuré : tout élément fait 5 × 5 px, viewport fixe 1920 × 1080), CSS calculé seulement pour la visibilité (`display`, `visibility`, `opacity`, `pointer-events`) et seulement si `--load-resources stylesheet`. Images non décodées (16 premiers Ko lus pour les dimensions, sur option). Iframes et workers **non chargés par défaut** | `help serve`, mesures §2 |
| Captures | `Page.captureScreenshot` et `Page.printToPDF` répondent, mais c'est un **rendu texte** (texte noir en colonne, polices DejaVu, liens soulignés) : aucun contrôle de formulaire dessiné, aucune couleur ni mise en page CSS (voir §2) | mesuré |
| Télémétrie | **Active par défaut**, envoyée à `telemetry.lightpanda.io` ; à couper avec `LIGHTPANDA_DISABLE_TELEMETRY=true` (fait par le lanceur Grasp de cette branche) | README, `strings` du binaire |
| User-Agent | `Lightpanda/1.0` ; l'option `--user-agent` **refuse toute valeur contenant « Mozilla »** (pas d'usurpation de Chrome possible) — mais `Browser.getVersion` répond, lui, `Chrome/124` avec un UA macOS « Mozilla/5.0 … » (incohérence) | `help serve`, sonde |
| Couverture Web | Publiée sur perf.lightpanda.io/wpt (page dynamique, non relevée ici). Fonctionnalités annoncées : DOM, XHR/fetch, CORS, cookies, clic, saisie, interception réseau, robots.txt, bloqueur de publicités | README |

### Licence : impact pour Grasp et pour Sooatek

*(Lecture d'ingénieur, pas un avis juridique.)*

- **Grasp reste MIT.** Grasp ne lie pas Lightpanda : il lance un **processus séparé** et lui parle en CDP par
  WebSocket. Communiquer avec un programme AGPL par un protocole réseau ne fait pas de Grasp une œuvre dérivée.
  Le code ajouté dans cette branche (`src/browser/lightpanda.ts`) ne contient aucun code de Lightpanda.
- **Ne pas embarquer le binaire dans le paquet npm de Grasp** : le redistribuer obligerait à l'accompagner de
  l'AGPL et de l'offre de sources correspondante. Le plus simple est de le laisser installer par l'utilisateur
  (comme Chrome aujourd'hui) et de le désigner par `GRASP_LIGHTPANDA`.
- **Usage commercial Sooatek (service hébergé, agents en SaaS)** : l'AGPL §13 n'impose de publier les sources
  qu'aux utilisateurs qui **interagissent à distance avec une version modifiée** de Lightpanda. Binaire officiel
  non modifié, utilisé en interne derrière Grasp : aucune obligation de publier le code de Sooatek ni celui de
  Grasp. Si Sooatek **modifie** Lightpanda (correctif CDP, par exemple) et l'expose à des clients, il faut publier
  ces modifications — ou les proposer en amont (CLA), ce qui est de toute façon préférable.
- Le CLA permet à l'éditeur de proposer une **licence commerciale** (double licence) : piste à garder si un client
  refuse l'AGPL dans sa chaîne. Lightpanda vend aussi une offre cloud.
- Points de conformité pratiques : couper la télémétrie (données d'usage envoyées à un tiers par défaut) et
  garder la mention de licence si une image Docker Sooatek contient le binaire.

## 2. Couverture CDP : ce que Grasp appelle, ce que Lightpanda répond

Inventaire (`grep` des chaînes `Domaine.méthode` dans `src/`) : **49 méthodes** et **21 événements** CDP. Chacun a été
exécuté contre Lightpanda puis contre Chrome, avec des paramètres réels, sur le site de test de Grasp
(`eval/lightpanda/sonde-cdp.mjs` et `sonde-evenements.mjs` ; sorties brutes dans `docs/evaluation-lightpanda/`).
« Répond » ne suffit pas : la colonne « Effet » dit si la page a vraiment changé.

### Méthodes

| Méthode | Lightpanda | Réponse / effet mesuré |
|---|---|---|
| `Browser.getVersion` | supporté | répond `Chrome/124.0.6367.29` et un UA « Mozilla/5.0 (Macintosh…) » alors que la page voit `Lightpanda/1.0` (incohérent ; `/json/version` dit `Lightpanda/1.0`) |
| `Browser.setDownloadBehavior` | **partiel** | `{}` mais aucun fichier n'arrive (test `downloads` KO) |
| `Browser.close` | supporté | (arrêt du bridge testé) |
| `Target.getTargets` | supporté | `[]` sur une connexion neuve : **chaque connexion CDP a son propre contexte, vide** |
| `Target.createTarget` | **partiel** | 1er onglet : `FID-0000000001` ; 2e onglet : **`TargetAlreadyLoaded`** ; `createBrowserContext` : « Cannot have more than one browser context at a time » |
| `Target.attachToTarget` | **partiel** | OK sur la connexion qui a créé l'onglet ; depuis une **autre connexion : `BrowserContextNotLoaded`** (casse Playwright `connectOverCDP`) |
| `Target.getTargetInfo`, `detachFromTarget`, `closeTarget`, `setAutoAttach` (session et navigateur) | supporté | réponses conformes |
| `Page.enable`, `getFrameTree`, `navigate`, `getNavigationHistory`, `bringToFront`, `createIsolatedWorld` | supporté | monde isolé utilisable (`Runtime.evaluate` dedans → 2) |
| `Page.getLayoutMetrics` | **partiel** | viewport **fixe 1920 × 1080**, sans rapport avec la page |
| `Page.setDownloadBehavior` | **absent** | `'Page.setDownloadBehavior' wasn't found` (Grasp l'ignore déjà en mode attach) |
| `Page.handleJavaScriptDialog` | **partiel** | l'événement `javascriptDialogOpening` arrive, mais le dialogue est **déjà fermé** : « No dialog is showing » ; `confirm()` renvoie toujours `false` (Chrome : `true` après acceptation) |
| `Page.captureScreenshot` | **partiel** | PNG 1920 × 1080 en **rendu texte** (voir `capture-lightpanda-formulaire.png`) : ni champs, ni couleurs, ni mise en page ; `jpeg`/`webp` : « unsupported screenshot format » |
| `Page.printToPDF` | partiel | PDF de 13 Ko, même rendu texte |
| `Runtime.enable`, `evaluate`, `callFunctionOn`, `getProperties`, `releaseObject(Group)`, `runIfWaitingForDebugger` | supporté | V8 : résultats identiques à Chrome |
| `DOM.enable`, `getDocument`, `querySelectorAll`, `describeNode`, `resolveNode` (y c. monde isolé), `focus`, `scrollIntoViewIfNeeded`, `setFileInputFiles` | supporté | `backendNodeId` stables, cohérents avec l'arbre AX |
| `DOM.getContentQuads` | **partiel** | toujours une boîte de **5 × 5 px** (`getBoundingClientRect` idem) : la géométrie est factice mais cohérente, donc les clics par coordonnées tombent sur le bon élément |
| `Accessibility.enable`, `getFullAXTree`, `queryAXTree` | **partiel** | arbre complet et rôles ARIA justes ; écarts au §4 (pas de `focused`, valeur d'option brute, libellés dupliqués…) |
| `Input.dispatchMouseEvent` | supporté | clic au centre de la boîte → case réellement cochée |
| `Input.dispatchKeyEvent`, `Input.insertText` | supporté | saisie réelle (`"Adab"`) |
| `Input.setIgnoreInputEvents` (tests de Grasp seulement) | absent | `wasn't found` |
| `Network.enable`, `getCookies` | supporté | |
| `Log.enable` | supporté | mais aucun message CSP (CSP non appliquée) |
| `Fetch.enable`, `continueRequest`, `failRequest` | supporté | **le garde de navigation fonctionne** : document hors allowlist bloqué, page conservée ; iframe interceptée (si chargée) |
| `Emulation.setFocusEmulationEnabled`, `setDeviceMetricsOverride`, `clearDeviceMetricsOverride` | partiel | `{}` mais sans effet (viewport fixe) |

### Événements

Reçus comme avec Chrome : `Page.frameNavigated`, `frameStartedLoading`, `frameStoppedLoading`,
`frameRequestedNavigation`, `navigatedWithinDocument` (pushState, ancre), `frameAttached`, `frameDetached`,
`loadEventFired`, `javascriptDialogOpening` ; `Runtime.executionContextCreated`, `executionContextsCleared`,
`consoleAPICalled`, `exceptionThrown` ; `Log.entryAdded` ; `Network.requestWillBeSent`, `responseReceived`,
`loadingFinished`, `loadingFailed` ; `Target.attachedToTarget`, `detachedFromTarget` ; `Fetch.requestPaused`.
Écart : `Runtime.consoleAPICalled` sans **`preview`** des objets (Grasp affiche `Object` au lieu de
`{code: 42, detail: "champ manquant", nested: {…}}`).

**Bilan CDP :** 1 méthode absente (`Page.setDownloadBehavior`, sans conséquence), et des méthodes qui
répondent sans faire ce que Grasp attend : dialogues, téléchargements, captures, émulation, géométrie. Le
vrai mur n'est pas une méthode : c'est le **modèle « une connexion = un contexte = un onglet »**.

## 3. Branchement dans Grasp (branche `eval-lightpanda`)

Grasp lance Chrome dans le **bridge** (`src/bridge/main.ts` → `launchChrome`, `src/browser/launch.ts`), lit
l'URL WebSocket, puis `PageController.attach` ouvre l'onglet et active les domaines. Il existe déjà un mode
**attach** (`cdpUrl`) qui pilote un navigateur existant sans le lancer.

Ajouts (≈ 90 lignes, Chrome inchangé par défaut) :

| Fichier | Changement |
|---|---|
| `src/browser/lightpanda.ts` (nouveau) | `lightpandaEngine(env)` lit `GRASP_ENGINE=lightpanda` + `GRASP_LIGHTPANDA` (binaire) ; `launchLightpanda()` lance `lightpanda serve --host 127.0.0.1 --port <libre>` dans son propre groupe de processus, `LIGHTPANDA_DISABLE_TELEMETRY=true`, options en plus via `GRASP_LIGHTPANDA_ARGS`, attend `/json/version`, rend un `ChromeProcess` (même `kill()` par groupe) |
| `src/control/server.ts` | si `GRASP_ENGINE=lightpanda` : pas de découverte ni de contrôle de version de Chrome ; le binaire est passé au bridge |
| `src/control/bridges.ts` | champ `lightpanda?: string` dans `BridgeInit` |
| `src/bridge/main.ts` | branche `init.lightpanda` : lance Lightpanda au lieu de Chrome (arrêt du bridge = arrêt de Lightpanda) ; mode attach : un `cdpUrl` dont `/json/version` annonce `Lightpanda/` est accepté (sinon refusé faute de version Chrome) |
| `test/helpers/chrome.ts` | `openPage()` lance Lightpanda si `GRASP_ENGINE=lightpanda` (toute la suite peut tourner sur l'un ou l'autre) |
| `eval/lightpanda/*.mjs` | sondes CDP et banc de mesure |

Utilisation :

```bash
export GRASP_ENGINE=lightpanda GRASP_LIGHTPANDA=/home/florent/outils/lightpanda/lightpanda-x86_64-linux
export GRASP_LIGHTPANDA_ARGS="--load-resources stylesheet --load-resources iframe --load-resources image"
grasp serve &      # chaque session lance son propre Lightpanda sur 127.0.0.1
# ou, sans rien changer au code : mode attach sur un Lightpanda déjà lancé
LIGHTPANDA_DISABLE_TELEMETRY=true lightpanda serve --host 127.0.0.1 --port 9333 &
grasp config set cdpUrl http://127.0.0.1:9333
```

Pas d'équivalent de `--user-data-dir` : les **profils** Grasp n'ont pas de sens (cookies : `--cookie`/`--cookie-jar`
de Lightpanda, non branchés). Le mode Windows (chrome.exe) n'est pas concerné : Lightpanda n'existe pas sous Windows.

## 4. Suite de tests de Grasp contre Lightpanda

```bash
cd /home/florent/grasp-lightpanda && export PATH=$HOME/.nvm/versions/node/v22.23.4/bin:$PATH && npm run build
# référence Chrome
node --test --test-concurrency=1 --test-timeout=120000 'dist/test/**/*.test.js'
# Lightpanda, options par défaut puis options recommandées
GRASP_ENGINE=lightpanda GRASP_LIGHTPANDA=/home/florent/outils/lightpanda/lightpanda-x86_64-linux \
  node --test --test-concurrency=1 --test-timeout=120000 'dist/test/**/*.test.js'
GRASP_ENGINE=lightpanda GRASP_LIGHTPANDA=… \
  GRASP_LIGHTPANDA_ARGS="--load-resources iframe --load-resources stylesheet --load-resources image" \
  node --test --test-concurrency=1 --test-timeout=120000 'dist/test/**/*.test.js'
```

| Exécution | Tests | OK | KO | Annulés | Sautés | Durée |
|---|---|---|---|---|---|---|
| Chrome 150 (référence) | 353 | **352** | 0 | 0 | 1 (Windows réel) | 333 s |
| Lightpanda, options par défaut | 353 (+4 entrées de fichier) | 265 | 85 | 2 | 1 | 512 s |
| Lightpanda, `--load-resources iframe,stylesheet,image` | 353 (+4) | **271** | **79** | 2 | 1 | 500 s |

Les 129 tests unitaires ne lancent pas de navigateur (tous OK ; un KO de la première exécution venait de mon code,
une règle de style du dépôt, corrigé). **Intégration : 142/224 OK avec Lightpanda** (options recommandées).
Quelques fichiers d'intégration lancent Chrome eux-mêmes (`launch-port`, `cdp-lifecycle`, `attach`, `stale-instances`,
`bridge-lifecycle`, un test de `console` et de `relecture-v3`) et passent donc sans exercer Lightpanda. Le scénario du README (`examples/e2e.sh` : nav, snap,
fill par ref/CSS/texte, select, check, click, vérification du résultat) passe **à l'identique**, mêmes refs.
La durée plus longue vient des tests qui attendent un délai qui n'arrive jamais (2 fichiers coupés à 120 s).

Ce qui marche : navigation et attente de stabilité (DOM + réseau, challenges à minuterie et par réseau, SPA
pushState, carrousels, requêtes de fond), garde d'allowlist (redirections, clics, iframes), refs stables et
relocalisation, `--snap-diff`, `fill`/`type`/`press`/`click`/`check`/`select`/`hover` natifs, `wait`, `text`,
console (niveaux, exceptions, promesses rejetées, échecs réseau et CORS), sécurité du control plane, `grasp run`.

### Familles d'échecs (exécution avec options recommandées : 79 KO + 2 annulés)

| Famille | Tests | Cause mesurée | Corrigible côté Grasp ? |
|---|---|---|---|
| **Contexte unique par connexion** | 40 (Playwright 22+1+1, livraison vérifiée 14, onglet en arrière-plan 2 ; dont les 2 tests coupés au délai de 120 s) | une 2e connexion CDP ne voit pas l'onglet (`BrowserContextNotLoaded`) : le moteur Playwright de repli ne peut pas se brancher ; les tests de livraison ouvrent une session « espion » sur une autre connexion et utilisent `Input.setIgnoreInputEvents` (absent) ; un 2e onglet est refusé (`TargetAlreadyLoaded`) | non pour Playwright (il faudrait que Lightpanda partage le contexte entre connexions) ; la livraison vérifiée elle-même marche (tests `fill`/`click` natifs OK), seul son banc de test est inadapté |
| **Arbre d'accessibilité différent** | 16 (snapshot-v3 6, banc-v4 3, form-errors 3, relecture-v3 3, autocomplétion 1) | détaillé ci-dessous | partiellement (contournements dans `snapshot.ts`), le reste côté Lightpanda |
| **Rendu absent** | 11 (screenshot 8, `--el` 2, CLI screenshot 1) | rendu texte 1920 × 1080 fixe, boîtes 5 × 5 px, `jpeg`/`webp` refusés, `--full` toujours 1080 px | non : à désactiver (`501`) avec ce moteur |
| **Spécifique Chrome / profils** | 7 (profils 3, courses de profils 2, `--no-sandbox` 1, bascule Playwright 1) | pas de `--user-data-dir`, pas de sandbox, pas de sous-processus | sans objet : à déclarer non supporté |
| **`contenteditable`** | 3 | `HTMLElement.isContentEditable` vaut **`false`** pour `<div contenteditable>` → `fill` refuse le champ | contournable (lire l'attribut), mais l'édition riche reste incertaine |
| **Console : fidélité** | 3 | pas de `preview` des objets (2) ; CSP non appliquée, donc pas de message `Log` (1) | non (Lightpanda) |
| **Téléchargements** | 1 | `Browser.setDownloadBehavior` accepté mais aucun fichier écrit | non |

Avec les options par défaut, 6 échecs de plus : **iframes et images ne sont pas chargées** (`--load-resources`
vide en mode `serve`) — console des iframes, garde dans une iframe, `text --scope` sur iframe, 404 d'image.
Ils passent avec `--load-resources iframe --load-resources image`.

### Qualité de l'arbre d'accessibilité

Site de test (`/`, `/big`, `/snap-v3`) et 4 pages publiques (example.com, info.cern.ch, Hacker News, Wikipédia
« Antananarivo »), snapshot Grasp complet, mêmes options (`docs/evaluation-lightpanda/snapshots/`) :

| Page | Lignes Chrome / LP | Refs Chrome / LP / communes | Observation |
|---|---|---|---|
| Formulaire `/` | 16 / 16 | 13 / 13 / 13 | identique sauf la valeur du `<select>` vide (`="--"` absent) et `[focus]` jamais affiché |
| `/big` (2 000 liens) | 2002 / 2002 | 2001 / 2001 / 2001 | **identique à l'octet** |
| `/snap-v3` | 47 / 48 | 37 / 37 / 34 | `combobox "Pays"="p2"` (valeur brute de l'option) au lieu de `="Pays 2"` ; libellé dupliqué `"Disponibilité Disponibilité"` ; `text-transform` appliqué au nom (`MES COMPÉTENCES` → autre ref) ; options `aria-selected` sans `[x]`, niveau `option[1]` parasite |
| example.com | 8 / 8 | 1 / 1 / 1 | identique |
| info.cern.ch | 64 / 51 | 36 / 44 / 35 | `DescriptionList` aplatie mais **plus lisible** : `definition "Pointers to the world's online information, subjects , W3 servers , etc."` au lieu de 6 fragments de texte |
| Hacker News | 310 / 205 | 307 / 203 / 193 | tables de mise en page (`LayoutTable*` chez Chrome) réduites à `table` avec nom concaténé ; **197 liens des deux côtés, mêmes refs** ; rangs et scores ne sont plus des lignes séparées (dans le nom de la table, tronqué) |
| Wikipédia, sans CSS | 3112 / 4060 | — | menus repliés, liste des 148 langues et boutons « masquer » visibles : **sans feuilles de style, Lightpanda ne sait pas ce qui est caché** |
| Wikipédia, `--load-resources stylesheet` | 3112 / 2930 | 1533 / 1348 / 1113 | comparable : 1 035 / 1 053 liens, 45 / 45 titres, 47 / 47 images, mêmes régions (« Climat », « Démographie ») |

États : `checked`, `expanded`, `required`, `disabled`, `invalid` (natif) présents ; **`focused` absent** (aucun
`[focus]`) ; `[invalide]` des formulaires vierges mal calculé (radio/case/required) ; les modales (`showModal`,
`aria-modal`) ne masquent pas le fond ; un texte nu enfant direct de `<form>` disparaît de l'arbre (case
« checkbox 1 » sans nom voisin). Rôles et noms : justes sur les pages simples ; pas de `InlineTextBox`
(mieux pour Grasp). En lecture d'agent, la qualité est **bonne sur des pages de contenu**, **moins sûre sur des
formulaires riches** (valeur des listes, focus, modales, validation).

## 5. Performances

`eval/lightpanda/banc.mjs` : à chaque essai, lancement à froid, `PageController.attach` (comme un bridge),
puis pour chaque page `navigate()` (load + stabilité Grasp, plafond 5 s) et `snapshot()` complet ;
mémoire = somme RSS et PSS (`/proc/<pid>/smaps_rollup`) de **tout le groupe de processus**. La PSS est la mesure
honnête pour Chrome (17 processus qui partagent des pages). Médianes.

```bash
GRASP_LIGHTPANDA=/home/florent/outils/lightpanda/lightpanda-x86_64-linux node eval/lightpanda/banc.mjs 5 /tmp/snaps
LP_ARGS="--load-resources stylesheet" GRASP_LIGHTPANDA=… node eval/lightpanda/banc.mjs 3
BANC_STABLE_MS=0 LP_ARGS="--load-resources stylesheet" GRASP_LIGHTPANDA=… node eval/lightpanda/banc.mjs 5
LP_ARGS="--load-resources stylesheet" GRASP_LIGHTPANDA=… node eval/lightpanda/banc.mjs parallele 10 3
```

### Démarrage et mémoire (5 essais)

| Mesure | Chrome headless | Lightpanda | Rapport |
|---|---|---|---|
| Lancement (processus → CDP prêt) | 126 ms | 29 ms | ×4,3 |
| Démarrage à froid (→ onglet Grasp prêt) | 135 ms | 36 ms | ×3,8 |
| RSS au repos | 849 Mo | 20 Mo | ×43 |
| PSS au repos | 318 Mo | 9 Mo | ×36 |
| RSS après 7 pages | 1 714 Mo | 65 Mo | ×26 |
| PSS après 7 pages | 591 Mo | 53 Mo | ×11 |
| Processus | 17 | 1 | |

Charger les feuilles de style ne change rien de mesurable à la mémoire (PSS 54 Mo après 7 pages).

### Navigation + snapshot, par page (Lightpanda avec `--load-resources stylesheet`)

| Page | nav Grasp Chrome | nav Grasp LP | nav sans stabilité Chrome | nav sans stabilité LP | snapshot Chrome | snapshot LP |
|---|---|---|---|---|---|---|
| local `/` | 536 ms | 465 ms | 138 ms | 64 ms | 3,8 ms | 2,0 ms |
| local `/big` (2 000 liens) | 509 ms | 479 ms | 92 ms | 67 ms | 177 ms | 36 ms |
| local `/snap-v3` | 491 ms | 476 ms | 75 ms | 66 ms | 6,5 ms | 2,9 ms |
| example.com | 686 ms | 695 ms | 275 ms | 304 ms | 3,6 ms | 1,4 ms |
| info.cern.ch | 1 155 ms | 1 203 ms | 787 ms | 759 ms | 4,6 ms | 2,1 ms |
| news.ycombinator.com | 2 218 ms | 1 926 ms | 1 854 ms | 1 486 ms | 26 ms | 7,5 ms |
| fr.wikipedia.org (Antananarivo) | 2 980 ms | 3 510 ms | 2 564 ms | 2 283 ms | 245 ms | 56 ms |

Lecture : la navigation telle que Grasp la vit est dominée par le **réseau** et par l'**attente de stabilité**
(≥ 400 ms de calme, voulue) : le moteur n'y change presque rien (±15 %, dans le bruit du réseau). Sans cette
attente, Lightpanda gagne nettement en local (×1,1 à ×2) et peu sur Internet. Le **snapshot** est 2 à 5 fois
plus rapide (`getFullAXTree` produit moins de nœuds et sans `InlineTextBox`).

### Agents parallèles (10 sessions simultanées, `/big`, 3 essais)

| Mesure | Chrome headless | Lightpanda | Rapport |
|---|---|---|---|
| Temps mur : 10 lancements + nav + snapshot | 2 163 ms | 897 ms | ×2,4 |
| RSS totale | 10 519 Mo | 271 Mo | ×39 |
| PSS totale | 1 966 Mo | 81 Mo | ×24 |
| PSS par session | 197 Mo | 8 Mo | ×24 |

C'est là que Lightpanda change l'échelle : **une machine de 4 Go tient ~20 sessions Chrome, ou plusieurs
centaines de sessions Lightpanda** sur des pages simples (à confirmer sur des pages lourdes, où V8 domine).
Un seul processus Lightpanda accepte aussi 16 connexions CDP indépendantes (`--cdp-max-connections`),
non exploité ici (Grasp lance un navigateur par session).

## 6. Recommandation

**Verdict : moteur optionnel pour la lecture rapide et les agents parallèles nombreux ; à surveiller pour le
reste ; pas de moteur principal.**

Pourquoi pas principal :
1. **Le modèle « une connexion = un contexte = un onglet »** casse le moteur Playwright de repli (iframes
   d'autre origine, actionnabilité) et toute idée de popups ou d'onglets multiples. C'est un choix
   d'architecture de Lightpanda, pas une méthode manquante.
2. **Pas de rendu** : captures inutilisables (texte), géométrie factice, `scrollIntoView`/viewport sans effet.
   L'agent ne peut pas « regarder » quand l'arbre ne suffit pas.
3. **Fidélité des formulaires** : `focus` absent, valeur des listes brute, modales, validation `[invalide]`,
   `contenteditable` non reconnu, dialogues fermés d'office (`confirm()` = `false`, donc une suppression
   confirmée par l'agent n'aboutit jamais). Ce sont exactement les cas où Grasp a mis le plus de soin.
4. **Compatibilité Web** : UA `Lightpanda/1.0` imposé (toute valeur contenant « Mozilla » refusée), CSP non
   appliquée, pas d'images décodées, pas de Windows natif. Les sites avec détection anti-bot ou les applications
   lourdes sont un risque ; non mesuré ici à grande échelle.

Pourquoi l'offrir en option :
- Démarrage ×4, mémoire ×11 à ×36, snapshots ×2 à ×5, 10 sessions dans 81 Mo au lieu de 2 Go.
- Le cœur de Grasp (CDP direct, AX tree, refs, garde Fetch, stabilité, console, actions natives) **fonctionne
  tel quel** : le scénario de bout en bout passe sans changement, avec les mêmes refs qu'avec Chrome.
- Cas d'usage visés : lecture/extraction de pages de contenu (docs, articles, listes, annuaires), veille,
  crawl d'agents, tests de formulaires simples, et fermes de dizaines d'agents sur un petit serveur Sooatek.

### Effort d'intégration estimé (au-delà de cette branche)

| Travail | Estimation |
|---|---|
| Option propre `engine: "chrome" \| "lightpanda"` dans la config (au lieu de variables d'environnement), `grasp doctor`, découverte du binaire, `GRASP_LIGHTPANDA_ARGS` → clé `lightpandaArgs` avec `--load-resources stylesheet,iframe,image` par défaut | 1 j |
| Capacités par moteur : `screenshot`, `--engine playwright`, `fallbackEngine`, profils, téléchargements, `upload --engine` → **501 explicite** avec Lightpanda ; dialogues signalés comme « fermés d'office » | 1 j |
| Contournements snapshot : nom de `<select>` = libellé de l'option choisie, dédoublonnage du libellé répété, `[focus]` via `document.activeElement` (monde isolé), `contenteditable` par attribut | 1 à 2 j |
| Tests : marquer les tests Chrome-seulement (`skip` si moteur Lightpanda), faire tourner la suite sur les deux moteurs en CI, figer une version de Lightpanda | 1 à 2 j |
| Cookies/sessions persistantes via `--cookie` / `--cookie-jar` (remplaçant partiel des profils) | 0,5 à 1 j |
| **Total** | **≈ 5 à 7 jours** pour un moteur optionnel propre et documenté |

### Ce qu'il faudrait côté Lightpanda pour aller plus loin

1. Partager un contexte entre connexions CDP (ou au moins `Target.attachToTarget` depuis une autre connexion)
   et autoriser plusieurs onglets par contexte → Playwright de repli, popups.
2. `Page.handleJavaScriptDialog` réel (dialogue suspendu jusqu'à la réponse du client).
3. Arbre AX : propriété `focused`, valeur d'un `<select>` = texte de l'option, modales (`showModal`,
   `aria-modal`) qui rendent le fond inerte, `aria-selected` des options, nom calculé sans doublon, texte nu
   d'un `<form>` conservé, `invalid` aligné sur `:user-invalid`.
4. `isContentEditable`, `preview` des objets dans `consoleAPICalled`, application de la CSP.
5. User-Agent configurable librement (pour les sites qui filtrent).
6. Un rendu graphique minimal pour les captures serait un plus, mais ce n'est pas la cible du projet.

À **revoir à chaque version majeure** : le projet est très actif (24 versions en 10 mois, 1.0 depuis un mois),
et les points 1 à 4 sont précisément ceux qui décideraient d'un passage en moteur principal pour la lecture.

## Annexes

- `docs/evaluation-lightpanda/sonde-cdp-lightpanda.md`, `sonde-cdp-chrome.md` : sorties brutes de la sonde CDP.
- `docs/evaluation-lightpanda/banc.md` : sorties brutes du banc (4 séries).
- `docs/evaluation-lightpanda/echecs-options-*.tsv` : chaque test KO (fichier, nom, première ligne d'erreur).
- `docs/evaluation-lightpanda/snapshots/` : snapshots Chrome / Lightpanda (Wikipédia exclu pour la taille).
- `docs/evaluation-lightpanda/capture-lightpanda-formulaire.png` : capture Lightpanda de la page de test.
- Binaire : `/home/florent/outils/lightpanda/lightpanda-x86_64-linux`, release 1.0.2 (23 oct. 2026), téléchargé
  depuis `github.com/lightpanda-io/browser/releases/download/1.0.2/`, SHA-256
  `ae7d01d261efb9e480e18ce3424533332883863bcf70b12a4321b5733f37e19e`.
