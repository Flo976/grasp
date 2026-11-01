# Grasp

Serveur de contrôle de Chrome pour agents IA. L'agent ne regarde pas de captures d'écran par défaut : il lit
**l'arbre d'accessibilité aplati**, une ligne par nœud utile, et agit par références stables. Quand
l'image est vraiment nécessaire, `grasp screenshot` écrit un fichier et ne renvoie que son **chemin** ;
pour déboguer, `grasp console` lit le journal du navigateur (logs, exceptions, requêtes en échec).

```
page "Inscription" http://127.0.0.1:45457/
eaug9:navigation
 ee0rz:link "Accueil"
exo60:main
 eua9n:heading[1] "Inscription"
 et2s5:form
  euv3l:textbox "Nom" [required]
  ecgzh:combobox "Pays"="--" [-]
  e5ld4:checkbox "J'accepte les conditions" [ ]
  e9kfo:button "Valider"
 "En attente"
```

Sur la page de test : **388 octets** de snapshot, contre 18,7 Ko pour une capture PNG en base64
(×48). Après une action, `--snap-diff` ne renvoie que ce qui a changé (une ligne pour un `fill`).
Sur une vraie page, chaque lecture est **bornée par défaut** (`text` et `--snap-diff` : 4000
caractères, `snap` : 12 000 octets) et toute coupure le dit en dernière ligne ; `--scope` lit une zone.

- TypeScript strict, Node 22+, ESM, `node:http`, CDP en direct via `ws`. Pas de Playwright/Puppeteer.
- Linux (desktop et conteneur), et Chrome Windows piloté depuis WSL2 (voir [Mode Windows](#mode-windows-chromeexe-depuis-wsl2)). macOS en best-effort.
- Tests : `node:test` uniquement, contre un vrai Chrome et un site local. Aucun site externe.

## Démarrage rapide

```bash
npm install && npm run build
node dist/src/cli/main.js doctor          # diagnostic réel, Chrome démarré pour de vrai
npm link                                   # optionnel : commande `grasp`

grasp serve &                              # ou : grasp daemon install (systemd user)
export GRASP_SESSION=$(grasp session create)
grasp nav http://127.0.0.1:8080/
grasp snap
grasp fill e5k2 "Ada"                      # ref issue du snap
grasp click text:Valider --snap-diff
grasp wait --text "Inscription reçue"      # contenu tardif (nav et --snap-diff attendent déjà la stabilité)
grasp text                                 # vérifier le résultat dans la page
grasp stop
```

## Scénario de bout en bout (reproductible)

[`examples/e2e.sh`](examples/e2e.sh) démarre le site de test local, un serveur Grasp isolé
(XDG temporaires, rien n'est écrit chez vous), puis navigue, prend un snapshot, remplit trois
champs avec les trois formes de sélecteur, choisit dans une liste, coche une case, soumet, et
**vérifie le résultat par le contenu de la page**, car une action qui réussit prouve seulement
que l'événement a été émis.

```bash
npm run build && bash examples/e2e.sh
```

```
grasp nav "$URL/"
grasp snap
grasp fill "$NOM" "Ada Lovelace"              # ref
grasp fill '#email' 'ada@example.org'          # CSS
grasp fill 'text:Ville' 'Antananarivo'         # texte accessible
grasp select 'text:Pays' 'Madagascar'
grasp check "text:J'accepte les conditions" --snap-diff
  ~ e5ld4:checkbox "J'accepte les conditions" [x] [focus]
grasp click 'text:Valider' --snap-diff
  navigation → http://127.0.0.1:45457/submit?nom=Ada+Lovelace&…
  page "Merci" …
  euy6r:heading[1] "Inscription reçue"
   "Nom : Ada Lovelace"
   …
grasp text | grep 'Nom : Ada Lovelace'         # la preuve, c'est la page
SCÉNARIO VALIDÉ
```

Ce script est exécuté par la suite de tests (`test/integration/readme-e2e.test.ts`) : si le
README dérive du code, `npm test` échoue.

## Architecture

```
 grasp (CLI) ──HTTP──▶ control plane ──HTTP/socket Unix──▶ bridge ──CDP/WebSocket──▶ Chrome
 client mince          profils, sessions,      (1 par instance)    garde de navigation,      (groupe de
                       token, politique                            snapshot, actions          processus)
```

| Processus | Rôle | Source |
|---|---|---|
| **CLI** | Client mince : parse, appelle l'API, formate. Aucune logique métier. | `src/cli/main.ts` |
| **Control plane** | Serveur HTTP local (socket Unix ou TCP loopback), token, sessions, politique. | `src/control/server.ts` |
| **Bridge** | Un processus par Chrome. Détient la connexion CDP, le garde, le snapshot, les actions. | `src/bridge/` |

Le control plane ne parle jamais CDP, et le bridge n'a ni token ni config : il reçoit la
politique gelée à son lancement, par le canal IPC.

## Profils

Modèle pinchtab : **un profil = un `--user-data-dir` complet possédé par Grasp**, choisi AVANT de
lancer le navigateur. Les cookies, le stockage local et les connexions persistent d'une session à
l'autre ; deux profils ne partagent rien.

```bash
grasp profiles create florent --use-when "comptes perso"
grasp profiles create sooatek
grasp profiles                                   # * = profil de la session courante
* florent  prof_231b0997  -  session s13fadfae77fd  (comptes perso)
  sooatek  prof_18cdceb1  -
grasp session create --profile florent           # profil créé à la volée s'il n'existe pas (conseil sur stderr)
grasp profile sooatek                            # l'agent change lui-même de profil
grasp profiles rm sooatek                        # refusé (409) tant qu'une session l'utilise
```

- **Stockage** : `<racine>/<id>/`, avec `profile.json` (`id`, `name`, `createdAt`, `lastUsedAt`,
  `source` = `created`|`imported`, `importedFrom`, `useWhen`). `id` = `prof_` + 8 premiers hex du
  SHA-256 du nom ; noms `[A-Za-z0-9_.-]{1,64}`. Répertoires `0700`, fichiers `0600` (sauf NTFS).
- **Identité** : `accountEmail` et `accountName` sont lus, en lecture seule, dans
  `Default/Preferences` (`account_info`) puis `Local State` (`profile.info_cache`).
- **Bascule** (`grasp profile <nom>`, `POST /sessions/<id>/profile`) : le control plane arrête le
  bridge et son navigateur (fermeture propre par `Browser.close`, pour que les cookies soient écrits),
  puis relance sur le `--user-data-dir` du profil **en gardant l'identifiant de session**. La page
  repart de `about:blank`. Si le nouveau profil ne démarre pas, la session est rouverte sur l'ancien
  (502 explicite). Le profil cible doit exister (404 sinon, avec la liste) : une faute de frappe ne
  crée pas de profil en silence. Une session sans `--profile` (éphémère) peut basculer ; son répertoire
  temporaire est alors supprimé.
- **Mode attach** (`cdpUrl`) : le profil est celui du navigateur existant ; `--profile` et la bascule
  répondent 400.

### Import d'un profil Chrome existant

```bash
# répertoire de données complet (copie)
grasp profiles import perso ~/.config/google-chrome
# un seul profil d'un répertoire de données : copié vers Default/
grasp profiles import sooatek "/mnt/c/Users/<vous>/AppData/Local/Google/Chrome/User Data" --profile-directory "Profile 9"
```

- La source n'est **jamais modifiée**. Copie dans un dossier caché puis renommage : un import
  avorté ne laisse rien.
- Avec `--profile-directory`, un `Local State` minimal est écrit : `os_crypt` conservé (clé de
  déchiffrement des cookies) et l'entrée `info_cache` du profil renommée `Default`.
- Exclus : `Cache`, `Code Cache`, `GPUCache`, `DawnCache` (et variantes Dawn/Graphite),
  `ShaderCache`, `GrShaderCache`, `GPUPersistentCache`, `Service Worker/CacheStorage` et
  `ScriptCache`, `Crashpad`, `Singleton*`, `lockfile`, `*.lock`, `DevToolsActivePort`.
- Refusés : liens symboliques, source qui ne ressemble pas à un profil Chrome (pas de `Local State`
  ni de dossier avec `Preferences`), `--profile-directory` absent (la liste des profils est donnée).
- **Fichier verrouillé** (Chrome source ouvert : sous Windows, `Network/Cookies` d'un profil ouvert
  est illisible) : échec 409 qui liste les fichiers et conseille de fermer Chrome ; `--skip-locked`
  importe sans eux et les liste en avertissement.
- **Avertissements** (sur stderr, et `warnings` dans la réponse JSON) : source chiffrée par Chrome
  Windows (disque `/mnt/<lecteur>/`, clé `os_crypt` DPAPI ou app-bound) importée dans un Grasp en
  mode Linux — cookies et identifiants illisibles, le profil s'ouvrira déconnecté même si le compte
  est affiché ; `--profile-directory` sans `Local State` en mode Windows — clé `os_crypt` absente.
- Un profil importé n'emporte pas forcément ses connexions : voir les limites ci-dessous.

## Mode Windows (chrome.exe depuis WSL2)

Le Chrome Linux headless se fait bloquer par Cloudflare sur certains sites ; le vrai Chrome Windows
passe. Grasp le pilote directement depuis WSL2 :

```bash
grasp config set chromePath "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe"
grasp config set headless false        # facultatif : fenêtre visible côté Windows
grasp doctor                           # signale le mode windows, démarre chrome.exe pour de vrai
```

- **Détection** : un chemin `*.exe` sous `/mnt/<lecteur>/` est classé `windows`. La version est lue
  dans le dossier de version voisin (`…\Application\156.0.8078.76\`) : `chrome.exe --version`
  ouvrirait une fenêtre dans le Chrome de l'utilisateur.
- **Profils côté Windows** : le chiffrement DPAPI des cookies exige que chrome.exe lise lui-même ses
  profils. Racine par défaut `%LOCALAPPDATA%\grasp\profiles` (résolu par `cmd.exe /c echo
  %LOCALAPPDATA%` + `wslpath`), surchargeable par `windowsProfilesDir` (`/mnt/c/…` ou `C:\…`).
  Sessions éphémères dans `<racine>\.tmp\<id>`, téléchargements dans `<racine>\.downloads\<id>`
  (chemin Windows remis à chrome.exe). Les droits Unix ne s'appliquent pas sur NTFS :
  Grasp démarre quand même et `doctor` le signale.
- **Lancement** : `chrome.exe --user-data-dir=<chemin Windows via wslpath -w> --remote-debugging-port=0
  --no-first-run --no-default-browser-check [--headless=new]`, lecture de `DevToolsActivePort` via
  `/mnt/c`, connexion à `127.0.0.1:<port>`. **WSL doit être en `networkingMode=mirrored`** ; sinon
  erreur explicite qui le dit.
- **Cycle de vie** : pas de groupe de processus ni de `PDEATHSIG` au-delà de la frontière WSL. Arrêt
  par CDP `Browser.close` ; à défaut, PowerShell (`Get-CimInstance Win32_Process`) retrouve les
  `chrome.exe` dont la ligne de commande porte **exactement ce `--user-data-dir`** et les tue. Le
  Chrome habituel de l'utilisateur n'est jamais visé (son `User Data` est explicitement refusé). Le
  control plane ferme ses navigateurs à l'arrêt ; un bridge qui meurt (même par `SIGKILL`) ou qui
  s'arrête en erreur (chien de garde, Stop-Process en échec) voit son chrome.exe tué par le control
  plane, et le profil n'est libéré qu'après ; un control plane tué par `SIGKILL` laisse ses bridges
  fermer leurs navigateurs ; `grasp stop` forcé vise aussi les `chrome.exe` connus (`instances.json`),
  et un nouveau `grasp serve` (redémarrage systemd compris) relit `instances.json` avant de
  l'écraser : navigateurs orphelins tués, profils éphémères supprimés.

## Snapshot

`GET /snap` (CLI : `grasp snap [--max octets]`), une ligne par nœud :

```
<indentation><ref>:<rôle>[niveau] "<nom accessible>"=<valeur> [états]
```

- **États** : `[x]` `[ ]` `[~]` coché, non coché, mixte · `[+]` `[-]` déplié, replié · `[disabled]`
  `[readonly]` `[required]` `[invalid]` `[selected]` `[focus]`.
- **Élagage** : conteneurs `generic`, `none`, `paragraph`, `LabelText`… traversés sans être émis ;
  groupes et cellules sans nom omis ; texte brut répété dans un nom accessible supprimé ; valeur
  interne d'un champ jamais répétée en texte.
- **Budget** : 12 000 octets par défaut (clé `snapMax` ; `--max octets` par appel, `?max=`). Il était de
  48 Ko : sur une vraie page (GitHub, Booking), c'est 12 000 tokens pour une seule lecture. Au-delà, la
  dernière ligne le dit : `… tronqué : 52341 caractères restants (1890 nœuds omis) — affinez avec --max N /
  --scope <ref|css>`. Les refs hors budget restent résolubles.
- **Zone** (`--scope <ref|css>`, `?scope=` ; `text:` accepté aussi) : seules les lignes du sous-arbre de
  l'élément. Tout l'arbre est quand même parcouru, si bien que les refs sont **celles du snapshot complet**
  (le rang parmi les homonymes se compte sur la page entière) : une ref lue dans une zone s'utilise telle
  quelle. Une zone absente de l'arbre d'accessibilité (élément masqué) → 404.
- **Élagage annoncé** : ce que Grasp masque est compté sur une ligne finale (avant la ligne de troncature
  s'il y en a une) : `… élagué : 3 liens sans nom (refs visibles avec screenshot --refs), 2 iframes non
  parcourues`. Un lien sans nom accessible est du bruit pour l'agent (rien ne dit où il mène) : il n'est
  plus émis, mais sa ref reste résoluble et `screenshot --refs` la dessine. Le contenu des iframes n'est
  jamais parcouru (voir les limites).
- **Refs stables** : `e` + hash base36 de (rôle, nom accessible, rang parmi les homonymes). Ce
  n'est pas un index positionnel : insérer un élément en haut de page ne décale aucune ref, et une
  ref change seulement si le rôle ou le nom du nœud change. C'est ce qui rend `--snap-diff`
  lisible au lieu d'un bruit total.
- **Refs résilientes** : le bridge mémorise (rôle, nom) de chaque ref remise à l'agent (50 000 au plus).
  Une ref absente du snapshot courant (re-rendu qui décale le rang d'un homonyme, nom qui change) est
  recherchée par **(rôle, nom exacts)** dans un snapshot recalculé :
  - un seul élément correspond → il est utilisé, et c'est signalé (`note: ref e1erc retrouvée → eu02h
    (button "Supprimer") après re-rendu`) ;
  - plusieurs → 409, aucun clic : `ref e1erc (button "Supprimer") n'est plus dans la page et 2 éléments ont
    ce rôle et ce nom : evu3y button "Supprimer", eu02h button "Supprimer" — choisissez une ref` ;
  - aucun → 404 avec les **3 candidats les plus proches** (même rôle favorisé, similarité des noms
    insensible à la casse et aux accents) : `ref e9yo0 (button "Panier (1)") n'est plus dans la page ;
    candidats les plus proches : e2k1m button "Panier (2)", …`.

  Le corps d'erreur JSON porte aussi `candidates: [{ref, role, name}]`. Un `text:` introuvable propose de
  même les noms proches (`aucun élément nommé « Supprmer » — noms proches : evu3y button "Supprimer", …`).
  Une ref jamais vue dans cette session → 404 « refaites `snap` ».

`--snap-diff` sur une action mutante renvoie `+` (apparu), `-` (disparu), `~` (modifié), **calculé sur un
DOM stable** (voir ci-dessous). Si l'action a déclenché une navigation : `navigation → <url>` puis le
snapshot de la nouvelle page. La sortie est bornée à **4000 caractères** (clé `diffMax` ; `--max N` par
appel), coupée en fin de ligne avec la même dernière ligne `… tronqué : N caractères restants — affinez
avec --max N / --scope <ref|css>` ; `--scope <ref|css>` restreint le diff à une zone (si la zone a disparu
après l'action, le diff le dit au lieu d'échouer : l'action, elle, a eu lieu).

## Attente de stabilité

Une page moderne se rend **après** son `load` (React, Booking, Amazon) : sans attente, le snapshot suivant
est vide, le titre aussi, et un `--snap-diff` saisit le DOM en pleine transition (refs aussitôt invalides).

- **`nav`** attend le `load`, puis que le DOM ne bouge plus pendant **400 ms**, au plus **5 s** (clé
  `stableTimeoutMs` ; `0` = pas d'attente). Titre et URL sont lus après. Une page qui bouge encore au
  plafond rend la main quand même, avec une note sur stderr : `note: DOM encore instable après 5021 ms
  (63 mutations) : la page peut encore changer`.
- **`--snap-diff`** : même attente avant le snapshot « après ». Une action **qui navigue** (lien, envoi de
  formulaire, route `pushState` d'une application monopage) l'attend aussi, même sans `--snap-diff`. Une action sans navigation ni diff n'attend pas.
- **Mécanisme** : un `MutationObserver` injecté par Grasp dans un **monde isolé** (`grasp-lecture`) : la page
  ne voit ni la fonction ni ses variables, et ne peut pas fausser la mesure (ses propres `setTimeout` ou
  prototypes sont ceux de son monde). C'est du code fixe de Grasp, pas une expression de l'agent : autorisé
  même avec `allowEval=false`. Ne comptent que les mutations qui changent l'arbre d'accessibilité : structure,
  texte, et les attributs `hidden`, `aria-hidden`, `aria-expanded`, `aria-label`, `aria-busy`,
  `aria-checked`, `aria-selected`, `role`, `disabled`, `open`. Les changements de `style`/`class` (animations,
  carrousels) sont ignorés, sinon chaque page animée coûterait 5 s. Une navigation pendant l'attente détruit
  le monde isolé : Grasp attend la fin du chargement et recommence avec le temps restant.

```
grasp wait [--text T | --sel S | --idle] [--timeout ms] [--json]
```

- `--text T` : T apparaît dans le texte visible de la page (`innerText`, espaces normalisés).
- `--sel S` : un élément CSS **visible** correspond (`checkVisibility`) ; une ref ou un `text:` : présent dans
  le snapshot (une ambiguïté compte comme « présent »).
- `--idle` (défaut sans option) : DOM stable, comme après `nav`.
- Délai : 10 000 ms par défaut (`--idle` : `stableTimeoutMs`), 60 000 au plus. Dépassé → **504** qui dit ce
  qui manque (`« Jamais affiché » absent de la page après 300 ms`, `#cache présent mais invisible après
  300 ms`, `DOM encore instable après 600 ms (8 mutations)`). Une seule condition à la fois (400 sinon).
- Sortie : `OK` sur stdout, `attendu 712 ms (text)` sur stderr ; `--json` : `{"ok", "waited", "condition"}`.

## Commandes

| Commande | Effet |
|---|---|
| `nav <url>` | Navigue (soumis à l'allowlist). |
| `snap [--max octets] [--scope <ref\|css>]` | Snapshot d'accessibilité (12 000 octets par défaut). |
| `text [--max N] [--scope <ref\|css>]` | `innerText` de la page ou de la zone (4000 caractères par défaut, coupure annoncée). |
| `wait [--text T \| --sel S \| --idle] [--timeout ms]` | Attend un texte, un élément ou un DOM stable. Voir [Attente](#attente-de-stabilité). |
| `click <sél>` | Clic souris réel (CDP `Input`) au centre de l'élément. |
| `fill <sél> <valeur>` | Remplace le contenu du champ ; **vérifie la valeur effective** (maxlength, masque → erreur 409). |
| `select <sél> <valeur\|libellé>` | `<select>` natif ; liste les options si absente. |
| `check <sél> [--uncheck]` | Coche ou décoche, puis **vérifie l'état**. |
| `press <touche> [sél]` | `Enter`, `Tab`, `Escape`, `ArrowDown`, `a`, `Control+a`… |
| `screenshot [options]` | Capture ; sans `-o`, **chemin** d'un fichier 0600 sur stdout. Voir [Captures](#captures-décran). |
| `console [options]` | Journal du navigateur, une ligne par entrée. Voir [Console](#console-du-navigateur). |
| `pdf [-o f.pdf]` | Binaire sur stdout (si redirigé) ou dans un fichier. |
| `eval`, `cookies`, `upload` | **Désactivés par défaut** (403). |

**Sélecteurs**, acceptés partout : ref `e5k2`, CSS `#id` (ou `css:…`), texte `text:Valider`.
Un sélecteur ambigu répond 409 avec les refs candidates, sans choix arbitraire. Toute action
(`nav`, `click`, `fill`, `select`, `check`, `press`) accepte :

- `--snap-diff` : diff du snapshot dans le même aller-retour, après stabilité du DOM, borné à 4000
  caractères (`--max N`), restreint à une zone avec `--scope <ref|css>` ;
- `--console` : entrées console produites **pendant** l'action, après `OK` (ou le diff) ;
- `--shot-on-error` : en cas d'échec, capture du viewport, chemin ajouté au message d'erreur.

```
grasp click '#envoyer' --console --snap-diff
  ~ e9kfo:button "Envoyer" [focus]
  #42 error network POST http://127.0.0.1:8080/api/commande → 500 Internal Server Error
  #43 error exception Uncaught TypeError: r.items is undefined ← afficher:88 ← charger:40 (app.js:88)
grasp click '#absent' --shot-on-error
  ERROR: click: aucun élément ne correspond à #absent (capture : ~/.local/state/grasp/captures/grasp-….png)
```

**Sorties** : `OK` sur stdout ; conseils et notes sur stderr ; erreurs
`ERROR: <cmd>: <raison>` sur stderr avec un code non nul ; `--json` pour la sortie structurée.
`export S=$(grasp session create)` capture uniquement l'identifiant.

## Captures d'écran

```
grasp screenshot [-o f|-] [--full] [--el <sélecteur>] [--format png|jpeg|webp] [--quality N] [--max-width N] [--refs] [--json]
```

- **Sans `-o`** : fichier `0600` dans `${XDG_STATE_HOME}/grasp/captures/` (dossier `0700`, vérifié au
  démarrage ; les 50 plus récentes sont gardées, les plus anciennes supprimées), et **seulement le chemin**
  sur stdout : l'agent n'ouvre l'image que s'il en a besoin. `--json` :
  `{"path", "width", "height", "bytes", "format"}` (dimensions lues dans l'image produite).
  `-o fichier` écrit là (format déduit de l'extension à défaut de `--format`) ; `-o -` envoie le binaire
  sur stdout redirigé.
- **`--full`** : page entière. **`--el`** : découpe sur la boîte de l'élément (ref, CSS ou `text:`), après
  `scrollIntoView`. **`--max-width`** : réduit l'échelle (jamais agrandie) pour économiser les tokens
  image. **`--format`/`--quality`** : jpeg et webp (1-100) ; `--quality` sur du png → 400.
- **`--refs`** : dessine en magenta les refs du snapshot (stables, donc celles de `snap`) sur les éléments
  interactifs visibles dans la zone capturée. L'overlay est un hôte `<grasp-overlay>` (shadow root fermé,
  `aria-hidden`) injecté depuis un **monde isolé** et retiré juste après : le snapshot et le texte de la
  page sont inchangés. Autorisé même avec `allowEval=false` : c'est du code fixe de Grasp, pas une
  expression de l'agent.
- **Pas d'effet de bord** : `captureBeyondViewport` de Chrome fait disparaître la barre de défilement
  jusqu'au rechargement (la page se remet en page sur une autre largeur). Grasp ne l'utilise pas : une
  zone qui déborde du viewport est capturée en agrandissant temporairement le viewport
  (`Emulation.setDeviceMetricsOverride`, puis retour attendu et défilement restauré). Testé.
- **Mode Windows et attach** : tout passe par CDP, le fichier est écrit côté Linux par le bridge.
- `GET /screenshot` sans `save=1` renvoie toujours le binaire (en-têtes `x-grasp-width`, `x-grasp-height`,
  `x-grasp-format`).

## Console du navigateur

Le bridge tient, **par onglet piloté**, un tampon circulaire de 1000 entrées numérotées (`seq`
croissant, jamais remis à zéro), qui survit aux navigations (repère `navigation → url`) :

| Source | Contenu |
|---|---|
| `console` | `console.*` : niveau, arguments en aperçu compact (`{code: 42, detail: "…", nested: {…}}`, `%s %d %o %c`), `fichier:ligne` depuis la pile |
| `exception` | exceptions non rattrapées et promesses rejetées : message et pile courte (3 appels) |
| `network` | requêtes en échec (`Network.loadingFailed` : `net::ERR_…`, CORS, blocage) et réponses HTTP ≥ 400 : méthode, URL tronquée, code |
| `grasp` | requêtes **bloquées par le garde de navigation** de Grasp (`blocked: true`) |
| `security`, `deprecation`, `intervention`, `violation`, `javascript`… | domaine `Log` : CSP, contenu mixte, dépréciations, interventions |

Les iframes, y compris hors processus (OOPIF), sont écoutées (`[iframe]`). Les messages réseau
redondants du domaine `Log` (« Failed to load resource », CORS) sont fusionnés dans l'entrée `network`.

```
grasp console [--level error|warn|info|debug] [--since <seq>] [--limit N] [--clear] [--json]
#9 error network GET http://127.0.0.1:8080/absent.png → 404 Not Found
#10 error network GET http://localhost:8080/api/data → net::ERR_FAILED (CORS : MissingAllowOriginHeader) [hors allowlist : non bloqué par Grasp, le garde ne couvre que les documents]
#11 info  console [iframe] depuis le cadre (console-frame:1)
#12 warn  console répété (app.js:31) ×5
seq courant : 12 — suite : grasp console --since 12        (stderr)
```

- Une ligne par entrée : `#seq niveau source texte (fichier:ligne)`, doublons consécutifs fusionnés
  `×N`, texte affiché tronqué à 300 caractères (2000 stockés). `--level warn` = warn et error (les repères
  de navigation restent). `--limit` : les N dernières lignes, **50 par défaut** au CLI ; les lignes
  écartées et les entrées perdues par le tampon sont signalées sur stderr. `--clear` vide le tampon
  après lecture (le `seq` continue).
- **Sensibilité — décision** : la lecture console est **autorisée par défaut** (`allowConsole=true`). Elle
  n'exécute rien et ne donne rien de plus que ce que la page affiche ou envoie déjà à l'agent par `text` et
  `snap`. Mais les arguments de `console.*` peuvent contenir des données de la page (jetons loggués par
  négligence…), d'où un interrupteur explicite, affiché par `grasp security`. Garanties : **jamais** de
  corps de requête ou de réponse, **jamais** d'en-têtes (`Cookie`, `Authorization` ni aucun autre) — Grasp
  n'active même pas le tampon des corps réseau (`maxTotalBufferSize: 0`) ; identifiants d'URL retirés et
  valeurs des paramètres sensibles masquées (`token`, `key`, `secret`, `pass`, `auth`, `session`, `sig`,
  `jwt`, `code`…). Testé avec un `Authorization: Bearer …`, un corps et un `?token=` sur une réponse 401.
- **`allowConsole=false`** : `console` et `--console` → 403, et Grasp n'appelle **jamais** `Runtime.enable`,
  `Log.enable` ni `Network.enable` (vérifié par espion CDP). `Runtime.enable` est un vecteur connu de
  détection de l'automatisation par les protections anti-bot ; à couper sur les sites qui y sont sensibles.

## API HTTP (control plane)

`Authorization: Bearer <token>` obligatoire (sauf `GET /health`). Session :
`X-Grasp-Session: <id>` ou `?session=`, facultatif s'il n'y en a qu'une. Les routes `/profiles`
ne sont pas liées à une session (`GET /profiles` utilise la session, si elle est connue, pour
renvoyer `current`).

```
GET  /health                  GET  /security/effective
POST /sessions {profile?}     GET  /sessions            DELETE /sessions/:id
POST /sessions/:id/profile {name}                      bascule de profil, même id
GET  /profiles                POST /profiles {name, useWhen?}
POST /profiles/import {name, sourcePath, profileDirectory?, skipLocked?}
DELETE /profiles/:name        (409 si une session l'utilise)
POST /navigate {url, snapDiff?, console?, shotOnError?}
GET  /snap?max=&scope=   GET /text?max=&scope=   GET /location   GET /pdf
POST /wait {text? | sel? | idle?, timeout?}
GET  /screenshot?full=1&el=&format=&quality=&maxWidth=&refs=1&save=1
GET  /console?level=&since=&limit=&clear=1    POST /console {level?, since?, limit?, clear?}
POST /click  {target, snapDiff?, max?, scope?, console?, shotOnError?}   POST /fill   {target, value, …}
POST /select {target, value, …}               POST /check  {target, checked?, …}
POST /press  {key, target?, …}
POST /eval {expression}   GET /cookies   POST /upload {target, files[]}
```

Codes : 400 entrée invalide · 401 token · 403 politique · 404 introuvable · 409 ambigu, état
incohérent ou pas de session · 502 navigateur · 504 délai. Le corps d'erreur `{"error": …}` porte aussi
`screenshot` (chemin, avec `shotOnError`), `console`/`consoleSeq` (avec `console`) et `candidates`
(ref disparue ou `text:` introuvable). Pour les actions, `max` est la limite du diff en caractères.

## Sécurité

### Les quatre défauts de référence, et leur test de régression

| # | Règle | Implémentation | Tests |
|---|---|---|---|
| 1 | **Absent ≠ désactivé.** | Le fichier est typé `T \| undefined` ; `resolveConfig` fusionne clé par clé (`!== undefined`). Clé inconnue ou mal typée : refus de démarrer. Un lint interdit `?? false`, `\|\| false` et `?? []` dans `src/`. | `config.test.ts`, `security.test.ts` (#1 de bout en bout avec `{"chromePath": …}` seul) |
| 2 | **Détecter ≠ bloquer.** | Pré-contrôle de `/navigate` → 403 avant tout appel CDP, **et** garde runtime dans le navigateur (`Fetch.requestPaused` sur tous les documents : redirections, liens, popups, iframes, y compris les navigations **internes** à une iframe hors processus, attachée par l'onglet) → requête annulée, page courante conservée. Le blocage n'est pas configurable. | `navigation-guard.test.ts`, `security.test.ts` #2 : `allowedDomains=["127.0.0.1"]`, `POST /navigate example.com` → 403 **et** URL/titre inchangés |
| 3 | **Ce qui rapporte lit ce qui applique.** | `effectivePolicy()` produit un objet gelé, transmis tel quel aux bridges. `/security/effective` renvoie cet objet et celui que chaque bridge détient en mémoire ; `grasp security` n'affiche que ça et échoue si le serveur est arrêté. Une config modifiée sur disque est signalée (`diskDiffers`), jamais présentée comme appliquée. | `security.test.ts` #3 : endpoint = mémoire du bridge = `grasp security --json` |
| 4 | **Un écrivain qui ne peut pas écrire échoue.** | `config set` : validation, écriture atomique (tmp, fsync, rename, 0600), **relecture** du fichier par le chemin de démarrage, sinon exception. | `config.test.ts`, `security.test.ts` #4 : chaque clé publique, plus un répertoire en lecture seule → code ≠ 0, pas de `OK`, fichier intact |

Chacun de ces tests a été validé par **mutation** : on réinjecte le bug de référence (garde qui
détecte sans bloquer, rapport qui relit le disque, `config set` qui n'écrit pas, défauts écrasés
par un fichier partiel…) et on vérifie que le test passe au rouge.

### Défauts sûrs

- Token API exigé (32 octets aléatoires, `0600`, comparaison à temps constant).
- `eval`, téléchargements, upload, cookies : **désactivés**. Console : lecture **autorisée** (voir
  [Console](#console-du-navigateur) pour la décision et ses garanties).
- Allowlist par défaut : `127.0.0.1`, `localhost`, `[::1]`. `[]` explicite = **tout bloqué**
  (fail-closed). `*.exemple.com` = sous-domaines seulement ; `*` = tout, en opt-in explicite.
- `file:`, `data:`, `javascript:`, `chrome:`, `view-source:` toujours bloqués.

### Surface d'exposition Linux

- **Socket Unix par défaut** : `$XDG_RUNTIME_DIR/grasp.sock`, mode `0600`. Les permissions du
  système de fichiers sont la frontière ; le token s'y ajoute. TCP seulement avec
  `serve --tcp` ou `transport=tcp`, toujours sur `127.0.0.1`.
- **Permissions vérifiées au démarrage** : fichiers `0600`, répertoires `0700`, propriétaire =
  utilisateur courant. Sinon **refus de démarrer**, avec la commande `chmod` à lancer.
- **`--no-sandbox`** : jamais en repli silencieux. En root, refus sauf `GRASP_ALLOW_NO_SANDBOX=1`
  (avertissement à chaque démarrage). Préférez un utilisateur non-root ou `--cap-add=SYS_ADMIN`.

## Cycle de vie des processus

- **Chrome dans son propre groupe** (`detached: true`), arrêté par `kill(-pgid, SIGTERM)`, puis
  `SIGKILL` après délai ; un groupe qui survit lève une erreur.
- **`PR_SET_PDEATHSIG=SIGKILL`** via `setpriv` (util-linux) : Chrome meurt avec son bridge,
  même si celui-ci est tué par `SIGKILL`. Valable aussi pour `/usr/bin/google-chrome`, qui est un
  wrapper bash faisant `exec` sur le vrai binaire (le flag survit à `exec`). Le test existe
  parce que la première version ne l'appliquait qu'aux ELF, et il a échoué.
- **Le bridge meurt avec le control plane** : fermeture du canal IPC → arrêt propre. Le control
  plane tue aussi le groupe Chrome de tout bridge qui disparaît.
- **Signaux** : `SIGTERM`/`SIGINT` → fermeture CDP, arrêt des groupes Chrome, retrait du socket,
  du PID et de `endpoint.json`, puis sortie 0.
- **`grasp stop`** rend la main seulement quand le processus est parti **et** que le socket est
  fermé. Si `SIGTERM` est ignoré : `SIGKILL`, nettoyage des groupes Chrome connus
  (`instances.json`), du socket, et **code non nul** avec un message explicite.
- **Daemon = systemd user** : `grasp daemon install` écrit
  `~/.config/systemd/user/grasp.service` (`Type=simple`, `Restart=on-failure`,
  `KillMode=control-group`) puis lance `systemctl --user enable --now`. Sans systemd
  (conteneur, WSL sans systemd), refus explicite qui propose `grasp serve` au premier plan.

## Chemins (XDG)

| Quoi | Chemin |
|---|---|
| Config, token | `${XDG_CONFIG_HOME:-~/.config}/grasp/{config.json,token}` |
| État, logs, PID, endpoint | `${XDG_STATE_HOME:-~/.local/state}/grasp/` |
| Captures (sans `-o`) | `${XDG_STATE_HOME:-~/.local/state}/grasp/captures/` (0700, fichiers 0600, 50 gardées) |
| Profils navigateur | `${XDG_DATA_HOME:-~/.local/share}/grasp/profiles/<id>/` ; snap : `~/snap/chromium/common/grasp-profiles/` ; chrome.exe : `%LOCALAPPDATA%\grasp\profiles\` (sessions sans `--profile` : profil éphémère supprimé à la fermeture) |
| Socket | `$XDG_RUNTIME_DIR/grasp.sock` (à défaut : `$XDG_STATE_HOME/grasp/run/`) ; bridges : `run/grasp/bridges/<id>.sock` |

Un socket Unix est limité à 107 octets. Si `XDG_RUNTIME_DIR` est trop long pour le socket du control
plane **ou** pour ceux des bridges, `grasp serve` refuse de démarrer en le disant (au lieu d'un
`listen EADDRINUSE` trompeur à la première session) : prenez un `XDG_RUNTIME_DIR` plus court.

## Découverte du navigateur

Ordre : `$GRASP_CHROME` → `chromePath` (config) → `which` sur `google-chrome-stable`,
`google-chrome`, `chromium`, `chromium-browser` → `/opt/google/chrome/chrome` →
`/snap/bin/chromium` → wrappers Flatpak. Un choix explicite invalide est une erreur, jamais un
repli.

- **Wrappers ≠ ELF** : snap, Flatpak et le `chromium-browser` d'Ubuntu sont des scripts shell.
  Ils sont détectés et classés (`elf`, `script`, `snap`, `flatpak`, et `windows` pour un `*.exe`
  sous `/mnt/`).
- **Confinement snap** : un Chromium snap ne lit ni hors de `$HOME` ni dans les dossiers cachés
  (donc pas `~/.local/share`). Les profils vont sous `~/snap/chromium/common/grasp-profiles/`.
- **Version** : refus en dessous de Chrome 112 (`--headless=new`).
- **`grasp doctor`** fait un vrai démarrage de Chrome, le pilote via CDP et l'arrête. Un wrapper
  « exécutable » qui ne démarre pas est donc détecté.

## Conteneurs

- `/dev/shm` < 256 Mo (64 Mo par défaut sous Docker) → `--disable-dev-shm-usage` ajouté, et la
  remédiation `--shm-size=1g` est loguée.
- Lancez en utilisateur non-root (ou `--cap-add=SYS_ADMIN`) ; `grasp serve` au premier plan,
  sous `docker run --init`.

## Configuration

```bash
grasp config keys                         # clés et format
grasp config get                          # valeurs effectives, (défaut) si absentes du fichier
grasp config set allowedDomains '127.0.0.1,*.exemple.com'
grasp config unset allowedDomains         # retour au défaut (≠ liste vide)
grasp security                            # politique telle que le garde l'applique
```

Clés : `chromePath`, `headless`, `allowedDomains`, `allowEval`, `allowDownload`, `allowUpload`,
`allowCookies`, `allowConsole` (lecture console, `true` par défaut), `transport` (`unix`|`tcp`), `port`, `cdpUrl` (mode attach : piloter un navigateur
déjà lancé, jamais tué par Grasp), `windowsProfilesDir` (racine des profils de chrome.exe). Une modification prend effet au redémarrage du
serveur ; d'ici là, `grasp security` la signale sans la présenter comme appliquée.

Limites de lecture (transmises au bridge à son lancement, à côté de la politique gelée, dont elles ne font
pas partie) : `snapMax` (octets, 12000), `textMax` (caractères, 4000), `diffMax` (caractères, 4000),
`stableTimeoutMs` (ms, 5000 ; 0 = pas d'attente de stabilité). `--max` les surcharge à chaque appel.

## Tests

```bash
npm test             # build + tests unitaires et d'intégration avec un vrai Chrome
npm run test:unit    # unitaires seuls, sans navigateur
GRASP_TEST_WINDOWS=1 npm test   # ajoute le test réel chrome.exe (WSL2 mirrored + Chrome Windows)
```

L'intégration démarre un `node:http` local qui sert la page de test (`test/helpers/testsite.ts`).

## Limites connues

- Le snapshot couvre le cadre principal ; le contenu des iframes (même origine ou non) n'y figure
  pas, même si la garde de navigation s'y applique. C'est désormais annoncé (`… élagué : N iframes non
  parcourues`). L'attente de stabilité et `wait` n'observent aussi que le cadre principal.
- Attente de stabilité : une page qui mute sans arrêt sa structure ou son texte (compteur, flux en direct
  toutes les < 400 ms) coûte `stableTimeoutMs` à chaque `nav` (note sur stderr) ; une animation qui ne
  touche que `style`/`class` n'est pas vue, de même qu'un contenu qui n'apparaît qu'après plus de 400 ms de
  calme (`grasp wait --text` est fait pour ça). Chaque `nav` coûte au moins 400 ms de plus qu'avant.
- Refs résilientes : la mémoire (rôle, nom) vit dans le bridge, elle est perdue à la bascule de profil ; la
  relocalisation exige le même rôle et le même nom exact (un nom qui change n'est jamais deviné : il est
  proposé en candidat). Le défaut d'origine du hash par rang demeure : si le 1er de deux homonymes disparaît,
  la ref du 1er désigne désormais le 2e (elle existe toujours, aucune relocalisation n'a lieu).
- `text` coupe au caractère près (en fin de ligne quand elle est proche) ; `snap --max` reste en **octets**
  (API existante), mais sa ligne de troncature compte le reste en caractères, comme les autres.
- `select` gère les `<select>` natifs ; pour une liste ARIA, utilisez `click` sur l'option.
- Une session = un onglet. Les popups sont gardés par l'allowlist mais ne sont pas pilotables.
- **Profil importé ≠ session Google importée** : validé sous Windows, l'import de « Profile 9 »
  s'est fait sans fichier verrouillé et l'identité (`accountEmail`) est lue, mais
  `myaccount.google.com` ouvert sur la copie a montré une page **non connectée**. Les connexions
  Google ne survivent pas forcément à une copie de profil (protections de Chrome et de Google liées
  à l'appareil et au profil d'origine). Le chemin fiable : créer un profil Grasp, l'ouvrir avec
  `headless=false` et s'y connecter une fois à la main ; la connexion persiste ensuite.
- **chrome.exe orphelin** si le control plane **et** le bridge sont tués par `SIGKILL` en même temps
  (rien ne reste pour appeler `Browser.close` ou PowerShell) : il tourne jusqu'au prochain
  `grasp serve` (ou redémarrage systemd), qui le retrouve via `instances.json` et le tue.
- La bascule de profil relance le navigateur : la page courante n'est pas conservée. Pendant la
  bascule, les deux profils sont réservés (création de session ou suppression → 409) ; une session
  fermée pendant la bascule l'interrompt (409) sans laisser de navigateur.
- macOS : non testé (pas de `/proc`, pas de `setpriv` ; le control plane tue alors les groupes Chrome).
- **Le garde ne couvre que les documents** (navigations, iframes, popups). Un `fetch()`, une image ou un
  script vers un hôte hors allowlist part quand même ; la console le signale (`[hors allowlist : non bloqué
  par Grasp…]`) lorsqu'il échoue, sans le bloquer.
- Console : les messages des workers (service workers, workers dédiés) ne sont pas capturés ; une requête
  annulée (navigation qui part, `AbortController`) n'est pas signalée ; les URL sont tronquées à 150
  caractères. Le tampon est perdu à la bascule de profil (le navigateur est relancé).
- Captures : page entière tronquée à 16 384 px de haut (limite de texture de Chrome, signalée) ;
  l'overlay `--refs` est un élément du DOM le temps de la capture (un `MutationObserver` de la page peut
  le voir passer) et ne couvre que le cadre principal ; en mode attach avec une fenêtre visible, un onglet
  en arrière-plan ou une fenêtre minimisée peut empêcher la capture (erreur 504 explicite après 30 s, non
  reproduit en headless).
