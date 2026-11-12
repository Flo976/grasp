# Évaluation d'Obscura comme moteur léger derrière Grasp

*Branche `eval/obscura`, partie de `master` @ 6efa686. Mesures du 12 novembre 2026 sur WSL2 (Linux 6.6, 20 cœurs,
40 Go), Node 22.23.4, Chrome 150.0.7871.114 headless. Obscura **0.2.6** (31 oct. 2026), archive officielle
`obscura-x86_64-linux.tar.gz` (variante **avec rendu**, sans `stealth`), SHA-256 `eed986e4…bd76` vérifié contre le
condensat publié par la release GitHub ; binaire gardé hors du dépôt, dans un répertoire temporaire. Obscura n'a
écouté que sur 127.0.0.1 (`obscura serve --port <p> --allow-private-network`). Méthode et scripts repris de
l'évaluation Lightpanda (branche `eval-lightpanda`).*

## En bref

| | Chrome headless | Obscura 0.2.6 |
|---|---|---|
| Démarrage à froid jusqu'à l'onglet Grasp prêt (médiane, 5 essais) | 169 ms | **26 ms** (×6,4) |
| Mémoire au repos, PSS du groupe de processus | 151 Mo (16 processus) | **16 Mo** (1 processus) |
| Mémoire après 7 pages (3 locales, 4 publiques), PSS | 385 Mo | 246 Mo (×1,6 seulement) |
| 10 sessions en parallèle, un navigateur chacune (PSS totale) | 1 898 Mo | **267 Mo** (×7,1) ; 237 Mo dans **un seul** processus Obscura |
| `nav` Grasp, pages locales et légères | référence | équivalent (−3 à −17 %) |
| `nav` Grasp, Wikipédia / Hacker News | 3,1 s / 1,9 s | **8,7 s / 3,3 s** (×2,8 / ×1,7 plus lent) |
| Snapshot Grasp de Wikipédia (≈ 3 100 lignes) | 266 ms | **1 524 ms** (×5,7 plus lent) |
| Méthodes CDP du bridge (51) / événements (21) | 51 / 21 | **49 répondent, 1 absente, 1 refusée sans option** ; **9 divergentes** ; **16/21** événements reçus (§2) |
| Tests d'intégration de page en mode attach (13 fichiers) | 118 OK (Chrome attaché, même banc) | **78 OK** : 40 échecs imputables à Obscura (§4) |
| Scénario du README (`examples/e2e.sh`) en mode attach | validé | **validé sans modification**, mêmes refs |
| Garde de navigation (allowlist) | tient | **contournée par une redirection 302** (§2, §4) |
| Captures d'écran | vraies | **vraies** (mise en page CSS, contrôles dessinés), quelques limites |
| Moteur Playwright de repli | oui | **non** (une 2e connexion CDP ne voit pas l'onglet) |

**Verdict : non utilisable tel quel derrière Grasp, et pas recommandé avec adaptations aujourd'hui.** Le scénario
nominal passe sans rien changer, mais la garde de navigation est contournée (bloquant de sécurité, non corrigible
côté Grasp), les dialogues sont acceptés d'office, et le gain promis n'est pas là sur les pages réelles : la mémoire
par page rejoint vite celle de Chrome et la navigation comme le snapshot sont plus lents sur une page lourde.
Détail et coût des adaptations au §6.

## 1. État du projet Obscura (relevé le 12 novembre 2026)

| Point | Constat | Source |
|---|---|---|
| Dépôt | `h4ckf0r0day/obscura`, **Rust**, créé le 13 avril 2026 ; ~33 000 étoiles, ~2 600 forks, 235 tickets ouverts, ~1 700 commits, 30 contributeurs ; dernier push le jour du relevé | API GitHub |
| Licence | **Apache-2.0** (permissive : intégration, redistribution et image Docker possibles en gardant la mention de licence et le `NOTICE`) | API GitHub |
| Versions | 19 versions en 7 mois : 0.1.0 (13 avr.) → 0.1.11 (26 juil.) → 0.2.0 (8 août) → **0.2.6 (31 oct.)**, environ toutes les 2 semaines ; toujours en 0.x | releases GitHub |
| Plateformes | Linux x86_64 et aarch64, macOS x86_64 et aarch64, Windows (manifeste), Docker ; quatre variantes : avec ou sans rendu, avec ou sans `stealth` | releases, README |
| Binaire | ELF x86_64 dynamique (glibc, libm, libgcc seulement) ; `obscura` 81 Mo + `obscura-worker` 76 Mo ; archive 72 Mo | mesuré |
| Moteur JS / rendu | **V8 14.5** embarqué ; moteur de rendu maison (bloc, inline, flex, grid, tables, positionnement, texte, images, SVG, canvas) : « long-tail CSS, some Web APIs… may differ from Chromium » | `/json/version`, README |
| Protocoles | CDP (WebSocket) ; serveur **MCP** natif (`obscura mcp`) ; commandes `fetch` / `scrape` | `--help` |
| Identité | se déclare `Chrome/145.0.0.0` (Linux) dans `/json/version` et `Browser.getVersion`, mais la page voit `navigator.userAgent` **Windows, Chrome/143** : incohérent, et Grasp ne peut pas savoir qu'il ne parle pas à Chrome | mesuré |
| Sécurité par défaut | réseau privé (loopback, RFC 1918) **refusé** sans `--allow-private-network` ; `file://` et `DOM.setFileInputFiles` refusés sans `--allow-file-access` ; écoute sur 127.0.0.1 par défaut | `serve --help`, mesuré |
| Télémétrie | aucune chaîne de télémétrie trouvée dans le binaire | `strings` |
| Parallélisme | une connexion CDP = un fil et ses propres isolats V8 ; `--max-connections` (128), `--workers N` avec recyclage (`--worker-max-rss`, `--worker-max-age`) | `serve --help` |

## 2. Couverture CDP : ce que Grasp appelle, ce qu'Obscura répond

Inventaire (`grep` des chaînes `'Domaine.méthode'` dans `src/`, donc `src/bridge` et `src/browser`) :
**51 méthodes** et **21 événements**. Chacun a été exécuté contre Obscura puis contre Chrome, avec des paramètres réels,
sur le site de test de Grasp : `eval/obscura/sonde-cdp.mjs`, `sonde-evenements.mjs` et `sonde-ecarts.mjs` (sorties
brutes dans `docs/eval-obscura/`). Contre Chrome, la sonde ne relève **aucun** échec. « Répond » ne suffit pas : la
colonne « Effet » dit si la page a vraiment changé.

### Méthodes

| Méthode | Obscura | Réponse / effet mesuré |
|---|---|---|
| `Browser.getVersion` | divergente | `Chrome/145.0.0.0`, UA Linux ; la page annonce Chrome/143 Windows |
| `Browser.setDownloadBehavior`, `Page.setDownloadBehavior` | répond | `{}` ; effet (fichier réellement écrit) non vérifié |
| `Browser.close` | non exercée | appelée seulement quand Grasp lance Chrome, jamais en mode attach |
| `Target.getTargets` | **divergente** | `[]` sur une connexion neuve alors que `/json/list` montre `page-1` : **chaque connexion CDP a ses propres onglets** |
| `Target.createTarget` | supportée | `page-1`, et un 2e onglet (`page-2`) est accepté (Lightpanda le refusait) |
| `Target.attachToTarget` | **divergente** | OK sur la connexion qui a créé l'onglet ; depuis une autre connexion : **`Target not found`** (casse Playwright `connectOverCDP` et les « espions » des tests de livraison) |
| `Target.getTargetInfo`, `detachFromTarget`, `closeTarget`, `setAutoAttach` (session et navigateur) | supportées | réponses conformes ; `getTargetInfo.title` à jour |
| `Page.enable`, `getFrameTree`, `navigate`, `getNavigationHistory`, `createIsolatedWorld` | supportées | monde isolé utilisable (`Runtime.evaluate` dedans → 2) |
| `Page.getLayoutMetrics` | supportée | viewport réel 1280 × 720 |
| `Page.bringToFront` | **absente** | `Page.bringToFront: Unknown Page method: bringToFront` (Grasp ignore déjà l'erreur) |
| `Page.handleJavaScriptDialog` | **divergente** | `No dialog is showing` : aucun `javascriptDialogOpening`, `alert()` rend la main tout de suite, **`confirm()` vaut toujours `true`**, `prompt()` vaut `null` |
| `Page.captureScreenshot` | supportée, limites | **vrai rendu** (voir `capture-obscura-formulaire.png` : champs, liste, case dessinés ; boutons sans relief) ; `png`, `jpeg`, `webp` ; `webp` avec `quality` : « WebP screenshot quality is not supported by the current lossless encoder » ; découpe très haute : « bitmap is too large » ; arrondi des boîtes fractionnaires différent (102 px au lieu de 104) |
| `Page.printToPDF` | supportée | PDF **raster** de 41 Ko |
| `Runtime.enable`, `evaluate`, `callFunctionOn`, `releaseObject(Group)`, `runIfWaitingForDebugger` | supportées | V8 ; écart cosmétique : `description` des nombres `"2.0"` au lieu de `"2"` |
| `Runtime.getProperties` | divergente | expose les propriétés internes du moteur (`_nid`, `_tagName`…) au lieu des propriétés propres de l'élément (Chrome : liste vide + `internalProperties`) |
| `DOM.enable`, `getDocument`, `querySelectorAll`, `describeNode`, `resolveNode` (y c. monde isolé), `focus`, `scrollIntoViewIfNeeded` | supportées | `backendNodeId` stables, cohérents avec l'arbre AX |
| `DOM.getContentQuads` | supportée | **géométrie réelle** (177 × 21 px pour un champ), clics par coordonnées justes |
| `DOM.setFileInputFiles` | **refusée par défaut** | « DOM.setFileInputFiles is disabled. Restart with `obscura serve --allow-file-access` » ; avec l'option : fichier réellement posé (`change` reçu) |
| `Accessibility.enable`, `getFullAXTree` | **divergente** | arbre complet et rôles justes sur les pages simples ; écarts au §4 (racine sans nom, pas de valeur ni d'options pour `<select>`, pas de valeur de champ, pas de `focused`, libellés dupliqués, éléments masqués exposés) |
| `Input.dispatchMouseEvent`, `dispatchKeyEvent`, `insertText` | supportées | clic au centre → case cochée ; saisie réelle (`"Adab"`) |
| `Network.enable`, `getCookies` | supportées | |
| `Log.enable` | répond | mais **aucun** `Log.entryAdded` (ni 404, ni CSP) |
| `Fetch.enable`, `continueRequest` | supportées | interception des documents principaux et des iframes |
| `Fetch.failRequest` | **divergente** | répond `{}`, mais : (1) clic sur un lien refusé → `location.pathname` devient `/aide` alors que le document affiché reste l'ancien ; (2) **redirection 302 vers un domaine refusé : le saut n'est jamais présenté à `Fetch.requestPaused`**, la page arrive sur `http://example.com/` ; (3) `Fetch.enable { patterns: [] }` n'arrête pas l'interception (non utilisé par Grasp) |
| `Emulation.setFocusEmulationEnabled`, `setDeviceMetricsOverride`, `clearDeviceMetricsOverride` | supportées | l'override 400 × 300 change vraiment `innerWidth`/`innerHeight` |

Bilan méthodes : 49 répondent sans erreur, 1 absente (`Page.bringToFront`), 1 refusée sans option
(`DOM.setFileInputFiles`) ; parmi celles qui répondent, 9 divergent de Chrome de façon visible pour Grasp
(`Browser.getVersion`, `Target.getTargets`, `Target.attachToTarget`, `Page.handleJavaScriptDialog`,
`Page.captureScreenshot`, `Runtime.getProperties`, `Accessibility.getFullAXTree`, `Log.enable`, `Fetch.failRequest`).

### Événements

Reçus comme avec Chrome (16) : `Page.frameNavigated` (y compris pour un clic, une soumission ou `location.href`),
`frameStoppedLoading`, `navigatedWithinDocument` (pushState), `frameAttached`/`frameDetached`, `loadEventFired` ;
`Runtime.executionContextCreated`, `executionContextsCleared`, `consoleAPICalled` ; `Network.requestWillBeSent`,
`responseReceived`, `loadingFinished`, `loadingFailed` ; `Target.attachedToTarget`, `detachedFromTarget` ;
`Fetch.requestPaused`. (`executionContextDestroyed` n'est émis ni par l'un ni par l'autre dans la sonde.)

**Jamais reçus** (5) : `Page.frameStartedLoading` et `Page.frameRequestedNavigation` (Grasp ne voit pas venir une
navigation déclenchée par la page), `Runtime.exceptionThrown` (ni `throw` dans un `setTimeout`, ni promesse rejetée),
`Log.entryAdded`, `Page.javascriptDialogOpening`.

Écart : `Runtime.consoleAPICalled` sans **`preview`** des objets (Grasp affiche `Object` au lieu de
`{code: 42, nested: {…}}`), comme Lightpanda.

## 3. Branchement dans Grasp

Aucune modification nécessaire pour le mode attach : Obscura annonce `Chrome/145` dans `/json/version`, donc
`assertSupportedVersion` l'accepte (≥ 112), et `PageController.attach` crée son propre onglet (`newTab`).

```bash
obscura serve --port 9444 --allow-private-network      # --allow-file-access pour les envois de fichiers
grasp config set cdpUrl http://127.0.0.1:9444
grasp serve
```

Adaptations proposées dans cette branche, en commits séparés, sans effet sur le chemin Chrome :

| Commit | Changement | Effet |
|---|---|---|
| `e2e.sh : mode attach facultatif par GRASP_CDP_URL` | 2 lignes dans `examples/e2e.sh` | `GRASP_CDP_URL=http://127.0.0.1:9444 bash examples/e2e.sh` rejoue le scénario du README sur un navigateur déjà lancé |
| `Tests : GRASP_TEST_CDP_URL…` | `test/helpers/chrome.ts` : `openPage()` se branche en attach (onglet propre, fermé à la fin) | les 13 fichiers d'intégration « de page » tournent sur n'importe quel navigateur CDP |
| `Snapshot : titre relu dans le document…` | `src/bridge/page.ts`, 3 lignes : racine AX sans nom → `location()` | Obscura ne nomme pas la racine `RootWebArea` : chaque snapshot affichait `page ""` ; corrige 3 tests et la sortie de `e2e.sh`. Chrome : un appel de plus seulement si la page n'a pas de titre |

Suite complète `npm test` sur Chrome après ces commits : 352/353 OK, 1 sauté, 0 KO (§7).

Non fait (hors périmètre « petit et sans risque ») : lancer Obscura depuis le bridge comme Chrome (la branche
Lightpanda montre le modèle : ~60 lignes, plus l'enveloppe `setpriv`/PDEATHSIG à ne pas oublier).

## 4. Scénario e2e et suites de tests en mode attach

### `examples/e2e.sh`

**Validé sans modification de Grasp** (avant même le correctif de titre), mêmes refs que Chrome
(`euv3l:textbox "Nom"`, `e5ld4:checkbox…`). Différences de sortie visibles par l'agent :

| | Chrome | Obscura |
|---|---|---|
| ligne de titre du snapshot | `page "Inscription"` | `page ""` (corrigé par le 3e commit) |
| liste déroulante | `combobox "Pays"="--" [-]` + `options : "--" [x] \| "France" \| "Madagascar"` | `combobox "Pays"` (ni valeur, ni options) |
| `check --snap-diff` | `~ textbox "Ville"="Antananarivo"` et `[x] [focus]` | seulement `[x]` (pas de valeur de champ, pas de focus) |
| `text` | une ligne par bloc | blocs séparés par 3 à 4 lignes vides (`innerText` sans mise en page) |

### Suites d'intégration

Treize fichiers utilisent `openPage()` (page, snapshot-v3, banc-v4, fixes, form-errors, navigation-guard,
navigation-saisie, reading, relecture-v3, console, delivery, screenshot, playwright). Ils ont été passés trois fois
avec `GRASP_TEST_CDP_URL` : sur un **Chrome 150 attaché** (référence, même banc), puis sur Obscura avant et après le
correctif de titre. Comparaison test par test : `docs/eval-obscura/tests-chrome-attach-vs-obscura.tsv`.

```bash
F=$(for t in banc-v4 navigation-saisie navigation-guard page screenshot snapshot-v3 playwright fixes form-errors \
  delivery console reading relecture-v3; do printf 'dist/test/integration/%s.test.js ' $t; done)
GRASP_TEST_CDP_URL=http://127.0.0.1:9444 node --test --test-concurrency=1 --test-timeout=60000 $F
```

| Exécution | Tests | OK | KO | Annulés |
|---|---|---|---|---|
| Chrome 150 attaché (référence) | 148 | **118** | 29 | 1 |
| Obscura 0.2.6 | 153 | 75 | 76 | 2 |
| Obscura 0.2.6 + correctif de titre | 153 | **78** | 73 | 2 |

Les 29 échecs de la référence viennent du banc en mode attach, pas du moteur (les tests de livraison et Playwright
supposent un Chrome lancé par le test : espion sur une 2e connexion, `Input.setIgnoreInputEvents`, onglet en
arrière-plan). Ils échouent aussi sur Obscura. Les autres suites (control plane, CLI, profils, lancement) lancent
Chrome elles-mêmes et ne disent rien d'Obscura. **Restent 40 échecs imputables à Obscura** (tests verts sur Chrome attaché) :

| Famille | Tests | Cause mesurée | Corrigible côté Grasp ? |
|---|---|---|---|
| **Garde de navigation** | 1 (redirection vers un domaine interdit) | le saut 302 n'est pas intercepté par `Fetch` : la page **arrive sur le domaine interdit** | **non** (il faut qu'Obscura présente chaque saut à `Fetch.requestPaused`) ; un contrôle a posteriori de l'URL ne serait que « détecter », contraire à la règle n°2 du README |
| **Arbre d'accessibilité** | 15 (snapshot-v3, relecture-v3, form-errors, reading, navigation-saisie) | `<select>` sans valeur ni options ; valeur des champs absente (diffs de `fill`/`type` muets) ; pas de `focused` ; libellés `LabelText` dupliqués (`"Heures Heures"`) ; `role="option"` à contenu balisé aplati en textes ; modale (`showModal`, `aria-modal`) non reflétée ; `[invalide]`/`required` différents ; `text-transform` non appliqué | en partie : valeur, options et focus relus dans le DOM (monde isolé) ; le reste côté Obscura |
| **Playwright de repli** | 8 (dont le garde sur clic Playwright, iframe `frame=`, upload) | une 2e connexion ne voit pas l'onglet (`Target not found`) | non |
| **Navigation vue tard** | 4 (`--snap-diff` après clic qui change de document ou de route, scénario 3 sélecteurs, champ remplacé) | ni `frameStartedLoading` ni `frameRequestedNavigation` : Grasp conclut avant que la navigation soit annoncée → « (aucun changement) » ou `~ url` au lieu de « navigation → … (nouvelle page) » | en partie (s'appuyer sur `frameNavigated`/`loaderId`, ~1 j), sans garantie |
| **Console** | 4 | pas de `exceptionThrown`, pas de `Log.entryAdded`, pas de `preview` | non |
| **`contenteditable`** | 3 | `fill` refuse le `<div contenteditable>` (« fill attend un champ de saisie, reçu <div> ») | contournable (lire l'attribut) |
| **Captures** | 3 | `webp` + `quality` refusé, bitmap trop haute refusée, arrondi des boîtes | `quality` ignorée en webp ; le reste non |
| **Sélecteur CSS invalide** | 2 (`fill`, `wait --sel`) | `#nom >>> ??` ne lève pas d'erreur dans `DOM.querySelectorAll` : Grasp répond « aucun élément » au lieu de « CSS invalide » | oui (valider le sélecteur dans la page), 0,25 j |

Ce qui marche : navigation et attente de stabilité (challenges réseau et minuterie, SPA, carrousels, requêtes de
fond, long-polling), refs stables et relocalisation, `fill`/`type`/`press`/`click`/`check`/`select` natifs,
`--snap-diff` dans le même document, `wait --text`/`--idle`, `text` et `text --scope` (iframes comprises),
captures du viewport, `--full`, `--el`, `--refs`, `--max-width`, garde sur Page.navigate, clic de lien, iframe.


### Qualité de l'arbre d'accessibilité

Snapshots Grasp complets, Chrome et Obscura, dans `docs/eval-obscura/snapshots/` (site de test, example.com,
info.cern.ch, Hacker News, Wikipédia).

- **Pages simples** (`/`, `/big`, example.com) : mêmes rôles, mêmes noms, **mêmes refs**, même taille (`/big` :
  68 890 octets des deux côtés). Les champs n'ont ni valeur ni état de focus.
- **Formulaires riches** (`/snap-v3`) : 60 lignes contre 47 et pourtant moins d'information (1 055 octets contre
  1 530) : libellés répétés en texte (`"Heures"` ×2), listes sans options ni sélection, options ARIA éclatées en
  fragments (`"Laravel"`, `"10"`…), listbox de 30 options rendue en 30 lignes de texte au lieu de 20 options + `… +10`.
- **Wikipédia** : taille comparable (97,9 Ko / 3 139 lignes contre 94,7 Ko / 3 112), mais 23 états `[+]/[-]/[x]` contre
  2 : Obscura **expose des contrôles masqués** (boutons de sections repliées, 8 radios de réglages d'apparence).
- **Hacker News** : 17,5 Ko / 367 lignes (référence Chrome du 3 nov. : 13,1 Ko / 310) ; les tables de mise en page
  deviennent des `table`/`row`/`cell` nommés par concaténation (`row "Hacker Newsnew | past | …"`) : plus de bruit.
  Chrome n'a pas pu être remesuré ce jour-là : Hacker News lui a répondu « Sorry, we're not able to serve your
  requests this quickly » (limitation de débit, banc lancé deux fois de suite).

## 5. Performances

`eval/obscura/banc.mjs` (repris de Lightpanda) : à chaque essai, lancement à froid du navigateur dans son propre
groupe de processus, `PageController.attach` (Obscura : nouvel onglet, comme en mode attach), puis pour chaque page
`navigate()` (load + stabilité Grasp, plafond 5 s) et `snapshot()` complet ; mémoire = somme RSS et PSS
(`/proc/<pid>/smaps_rollup`) de **tout le groupe**. Médianes.

```bash
export GRASP_OBSCURA=/chemin/obscura
node eval/obscura/banc.mjs 5 docs/eval-obscura/snapshots    # puis une 2e série de 3 essais
node eval/obscura/banc.mjs parallele 10 3                    # un navigateur par session
node eval/obscura/banc.mjs partage 10 3                      # un seul Obscura, 10 connexions
```

### Démarrage et mémoire

| Mesure | Chrome headless | Obscura | Rapport |
|---|---|---|---|
| Lancement (processus → CDP prêt) | 138 ms | 17 ms | ×8,4 |
| Démarrage à froid (→ onglet Grasp prêt) | 169 ms | 26 ms | ×6,4 |
| RSS au repos | 854 Mo | 32 Mo | ×27 |
| PSS au repos | 151 Mo | 16 Mo | ×9,4 |
| PSS après 7 pages (2e série, Wikipédia chargé des deux côtés) | 385 Mo | 246 Mo | ×1,6 |
| Processus | 16 | 1 | |

La mémoire d'Obscura croît vite avec le contenu : **16 → 246 Mo** sur un seul onglet après 7 pages (Chrome :
151 → 385 Mo). Les « 30 Mo » du README d'Obscura valent pour une page simple.

### Navigation + snapshot, par page (5 essais ; Wikipédia : 2e série de 3 essais)

| Page | nav Grasp Chrome | nav Grasp Obscura | snapshot Chrome | snapshot Obscura | octets C / O |
|---|---|---|---|---|---|
| local `/` | 564 ms | 469 ms | 4,0 ms | 5,5 ms | 436 / 379 |
| local `/big` (2 000 liens) | 505 ms | 474 ms | 199 ms | **64 ms** | 68 890 / 68 890 |
| local `/snap-v3` | 480 ms | 471 ms | 6,9 ms | 13,2 ms | 1 530 / 1 055 |
| example.com | 700 ms | 691 ms | 3,7 ms | 2,4 ms | 891 / 891 |
| info.cern.ch | 1 169 ms | 1 550 ms (2e série : 1 185) | 4,9 ms | 6,5 ms | 1 765 / 1 465 |
| news.ycombinator.com | (limité, voir §4) | 3 261 ms | — | 54 ms | — / 17 478 |
| fr.wikipedia.org (Antananarivo) | 3 108 ms | **8 672 ms** | 266 ms | **1 524 ms** | 94 657 / 97 910 |

Lecture : sur les pages simples, la navigation telle que Grasp la vit est dominée par l'attente de stabilité (≥ 400 ms
de calme, voulue) et le moteur n'y change presque rien. Sur une page lourde (Wikipédia), Obscura est **2,8 fois plus
lent** à naviguer et **5,7 fois plus lent** à produire l'arbre d'accessibilité. Seule `/big` (beaucoup de liens, pas
de CSS) est plus rapide en snapshot.

### Agents parallèles (10 sessions simultanées, `/big`, 3 essais)

| Mesure | Chrome headless (10 navigateurs) | Obscura (10 processus) | Obscura (1 processus, 10 connexions) |
|---|---|---|---|
| Temps mur : lancements + nav + snapshot | 2 309 ms | 893 ms (×2,6) | 830 ms |
| RSS totale | 10 559 Mo | 514 Mo | 270 Mo |
| PSS totale | 1 898 Mo | 267 Mo (×7,1) | 237 Mo |
| PSS par session | 190 Mo | 27 Mo | 24 Mo |

Le modèle « un processus, une connexion par session » d'Obscura convient bien à des agents nombreux sur des pages
légères (Lightpanda faisait 8 Mo par session sur la même page).

## 6. Recommandation

**Verdict : non, pas en l'état ; à réévaluer quand Obscura interceptera les redirections et émettra les dialogues.**

Bloquants (non corrigibles côté Grasp) :
1. **Garde de navigation contournée** : une redirection HTTP vers un domaine hors allowlist n'est jamais présentée à
   `Fetch.requestPaused` ; la page y arrive. Grasp promet « détecter ≠ bloquer » (règle n°2) ; avec Obscura, la
   promesse ne tient plus que pour le `/navigate` initial. Mode attach compris : **à documenter dès maintenant** (la
   garde runtime n'est garantie qu'avec Chrome).
2. **Dialogues acceptés d'office** : `confirm()` vaut toujours `true`, sans événement. Une suppression « confirmée »
   part sans que l'agent ait rien décidé ; `prompt()` vaut `null`.
3. **Une connexion = ses onglets** : le moteur Playwright de repli (iframes d'autre origine, actionnabilité) ne peut
   pas se brancher.

Coûteux mais possibles (estimation pour une intégration propre, en plus de cette branche) :

| Adaptation | Coût |
|---|---|
| Lanceur Obscura dans le bridge (comme Lightpanda : groupe de processus, PDEATHSIG, `--allow-private-network` si l'allowlist contient du local, `--allow-file-access` si `allowUpload`) | 0,5 j |
| Valeur des champs, valeur et options des `<select>`, focus relus dans le DOM (monde isolé) quand l'arbre AX ne les donne pas | 1 à 1,5 j |
| Détection de navigation sans `frameStartedLoading`/`frameRequestedNavigation` (`frameNavigated`, `loaderId`, URL) | 1 j, sans garantie |
| `contenteditable` (attribut lu au lieu de `isContentEditable`), `quality` ignorée en webp, `501` propre pour Playwright | 0,5 j |
| Suite de tests à double moteur (CI) et documentation des écarts | 1 j |
| **Total** | **≈ 4 à 5 j**, sans lever les 3 bloquants |

Pourquoi ce n'est pas rentable aujourd'hui : le gain réel tient au démarrage (×6) et à la mémoire **au repos ou sur
pages légères** (×7 en parallèle) ; sur les pages que visent les agents (applications, Wikipédia), la mémoire par page
rejoint celle de Chrome et nav + snapshot sont 3 à 6 fois plus lents. La fidélité des formulaires — là où Grasp a mis
le plus de soin — recule nettement.

Comparé à Lightpanda (branche `eval-lightpanda`) : Obscura a un **vrai rendu** (captures exploitables, géométrie
réelle, émulation d'écran effective), accepte plusieurs onglets et est sous **Apache-2.0** (contre AGPL) ; mais il
gagne moins en mémoire (27 Mo par session contre 8), il est plus lent sur page lourde, et il ajoute le contournement de
la garde par redirection et les dialogues acceptés d'office, absents chez Lightpanda.

Ce qu'il faudrait côté Obscura pour aller plus loin : interception `Fetch` de chaque saut de redirection et effet réel
de `failRequest` ; dialogues JS bloquants avec `javascriptDialogOpening` ; `frameStartedLoading` /
`frameRequestedNavigation` ; `exceptionThrown`, `Log.entryAdded`, `preview` ; arbre AX avec nom de racine, valeurs,
options, `focused`, modales et éléments masqués ignorés ; onglets visibles depuis toutes les connexions.

## 7. Vérification du chemin Chrome

`npm test` complet (Chrome lancé par les tests, sans `GRASP_TEST_CDP_URL`) après les trois commits :
**353 tests, 352 OK, 0 KO, 1 sauté** (Windows réel), 334 s — identique à la référence de `master`.

## Annexes (`docs/eval-obscura/`)

- `sonde-cdp-chrome.md`, `sonde-cdp-obscura.md`, `sonde-cdp-obscura-allow-file-access.md` : chaque méthode, réponse brute.
- `sonde-evenements-*.md`, `sonde-ecarts-*.md` : navigation intra-document, iframes, garde, dialogues, console, AX.
- `capture-obscura-formulaire.png` : capture du formulaire du site de test par Obscura.
- `snapshots/` : snapshots et `text` Grasp, Chrome et Obscura, 7 pages.
- `tests-chrome-attach-vs-obscura.tsv` : résultat de chaque test d'intégration, Chrome attaché puis Obscura.
- Scripts : `eval/obscura/sonde-cdp.mjs`, `sonde-evenements.mjs`, `sonde-ecarts.mjs`, `capture.mjs`, `banc.mjs`.
