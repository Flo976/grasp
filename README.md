# Grasp

Serveur de contrôle de Chrome pour agents IA. L'agent ne regarde pas de captures d'écran : il lit
**l'arbre d'accessibilité aplati**, une ligne par nœud utile, et agit par références stables.

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
  Sessions éphémères dans `<racine>\.tmp\<id>`. Les droits Unix ne s'appliquent pas sur NTFS :
  Grasp démarre quand même et `doctor` le signale.
- **Lancement** : `chrome.exe --user-data-dir=<chemin Windows via wslpath -w> --remote-debugging-port=0
  --no-first-run --no-default-browser-check [--headless=new]`, lecture de `DevToolsActivePort` via
  `/mnt/c`, connexion à `127.0.0.1:<port>`. **WSL doit être en `networkingMode=mirrored`** ; sinon
  erreur explicite qui le dit.
- **Cycle de vie** : pas de groupe de processus ni de `PDEATHSIG` au-delà de la frontière WSL. Arrêt
  par CDP `Browser.close` ; à défaut, PowerShell (`Get-CimInstance Win32_Process`) retrouve les
  `chrome.exe` dont la ligne de commande porte **exactement ce `--user-data-dir`** et les tue. Le
  Chrome habituel de l'utilisateur n'est jamais visé (son `User Data` est explicitement refusé). Le
  control plane ferme ses navigateurs à l'arrêt ; un bridge qui meurt (même par `SIGKILL`) voit son
  chrome.exe tué par le control plane ; un control plane tué par `SIGKILL` laisse ses bridges fermer
  leurs navigateurs ; `grasp stop` forcé vise aussi les `chrome.exe` connus (`instances.json`).

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
- **Budget** : `maxBytes` (48 Ko par défaut, `?max=`). Au-delà : `… N nœuds omis`. Les refs
  hors budget restent résolubles.
- **Refs stables** : `e` + hash base36 de (rôle, nom accessible, rang parmi les homonymes). Ce
  n'est pas un index positionnel : insérer un élément en haut de page ne décale aucune ref, et une
  ref change seulement si le rôle ou le nom du nœud change. C'est ce qui rend `--snap-diff`
  lisible au lieu d'un bruit total.

`--snap-diff` sur une action mutante renvoie `+` (apparu), `-` (disparu), `~` (modifié). Si
l'action a déclenché une navigation : `navigation → <url>` puis le snapshot complet de la
nouvelle page.

## Commandes

| Commande | Effet |
|---|---|
| `nav <url>` | Navigue (soumis à l'allowlist). |
| `snap [--max N]` | Snapshot d'accessibilité. |
| `text [--max N]` | `innerText` de la page. |
| `click <sél>` | Clic souris réel (CDP `Input`) au centre de l'élément. |
| `fill <sél> <valeur>` | Remplace le contenu du champ ; **vérifie la valeur effective** (maxlength, masque → erreur 409). |
| `select <sél> <valeur\|libellé>` | `<select>` natif ; liste les options si absente. |
| `check <sél> [--uncheck]` | Coche ou décoche, puis **vérifie l'état**. |
| `press <touche> [sél]` | `Enter`, `Tab`, `Escape`, `ArrowDown`, `a`, `Control+a`… |
| `screenshot [-o f.png]`, `pdf [-o f.pdf]` | Binaire sur stdout (si redirigé) ou dans un fichier. |
| `eval`, `cookies`, `upload` | **Désactivés par défaut** (403). |

**Sélecteurs**, acceptés partout : ref `e5k2`, CSS `#id` (ou `css:…`), texte `text:Valider`.
Un sélecteur ambigu répond 409 avec les refs candidates, sans choix arbitraire. Toute action
mutante accepte `--snap-diff`.

**Sorties** : `OK` sur stdout ; conseils et notes sur stderr ; erreurs
`ERROR: <cmd>: <raison>` sur stderr avec un code non nul ; `--json` pour la sortie structurée.
`export S=$(grasp session create)` capture uniquement l'identifiant.

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
POST /navigate {url, snapDiff?}
GET  /snap?max=   GET /text?max=   GET /location   GET /screenshot   GET /pdf
POST /click  {target, snapDiff?, max?}        POST /fill   {target, value, …}
POST /select {target, value, …}               POST /check  {target, checked?, …}
POST /press  {key, target?, …}
POST /eval {expression}   GET /cookies   POST /upload {target, files[]}
```

Codes : 400 entrée invalide · 401 token · 403 politique · 404 introuvable · 409 ambigu, état
incohérent ou pas de session · 502 navigateur.

## Sécurité

### Les quatre défauts de référence, et leur test de régression

| # | Règle | Implémentation | Tests |
|---|---|---|---|
| 1 | **Absent ≠ désactivé.** | Le fichier est typé `T \| undefined` ; `resolveConfig` fusionne clé par clé (`!== undefined`). Clé inconnue ou mal typée : refus de démarrer. Un lint interdit `?? false`, `\|\| false` et `?? []` dans `src/`. | `config.test.ts`, `security.test.ts` (#1 de bout en bout avec `{"chromePath": …}` seul) |
| 2 | **Détecter ≠ bloquer.** | Pré-contrôle de `/navigate` → 403 avant tout appel CDP, **et** garde runtime dans le navigateur (`Fetch.requestPaused` sur tous les documents : redirections, liens, popups, iframes) → requête annulée, page courante conservée. Le blocage n'est pas configurable. | `navigation-guard.test.ts`, `security.test.ts` #2 : `allowedDomains=["127.0.0.1"]`, `POST /navigate example.com` → 403 **et** URL/titre inchangés |
| 3 | **Ce qui rapporte lit ce qui applique.** | `effectivePolicy()` produit un objet gelé, transmis tel quel aux bridges. `/security/effective` renvoie cet objet et celui que chaque bridge détient en mémoire ; `grasp security` n'affiche que ça et échoue si le serveur est arrêté. Une config modifiée sur disque est signalée (`diskDiffers`), jamais présentée comme appliquée. | `security.test.ts` #3 : endpoint = mémoire du bridge = `grasp security --json` |
| 4 | **Un écrivain qui ne peut pas écrire échoue.** | `config set` : validation, écriture atomique (tmp, fsync, rename, 0600), **relecture** du fichier par le chemin de démarrage, sinon exception. | `config.test.ts`, `security.test.ts` #4 : chaque clé publique, plus un répertoire en lecture seule → code ≠ 0, pas de `OK`, fichier intact |

Chacun de ces tests a été validé par **mutation** : on réinjecte le bug de référence (garde qui
détecte sans bloquer, rapport qui relit le disque, `config set` qui n'écrit pas, défauts écrasés
par un fichier partiel…) et on vérifie que le test passe au rouge.

### Défauts sûrs

- Token API exigé (32 octets aléatoires, `0600`, comparaison à temps constant).
- `eval`, téléchargements, upload, cookies : **désactivés**.
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
`allowCookies`, `transport` (`unix`|`tcp`), `port`, `cdpUrl` (mode attach : piloter un navigateur
déjà lancé, jamais tué par Grasp), `windowsProfilesDir` (racine des profils de chrome.exe). Une modification prend effet au redémarrage du
serveur ; d'ici là, `grasp security` la signale sans la présenter comme appliquée.

## Tests

```bash
npm test             # build + tests unitaires et d'intégration avec un vrai Chrome
npm run test:unit    # unitaires seuls, sans navigateur
GRASP_TEST_WINDOWS=1 npm test   # ajoute le test réel chrome.exe (WSL2 mirrored + Chrome Windows)
```

L'intégration démarre un `node:http` local qui sert la page de test (`test/helpers/testsite.ts`).

## Limites connues

- Le snapshot couvre le cadre principal ; le contenu des iframes cross-origin (OOPIF) n'y figure
  pas, même si la garde de navigation s'y applique.
- `select` gère les `<select>` natifs ; pour une liste ARIA, utilisez `click` sur l'option.
- Une session = un onglet. Les popups sont gardés par l'allowlist mais ne sont pas pilotables.
- **Profil importé ≠ session Google importée** : validé sous Windows, l'import de « Profile 9 »
  s'est fait sans fichier verrouillé et l'identité (`accountEmail`) est lue, mais
  `myaccount.google.com` ouvert sur la copie a montré une page **non connectée**. Les connexions
  Google ne survivent pas forcément à une copie de profil (protections de Chrome et de Google liées
  à l'appareil et au profil d'origine). Le chemin fiable : créer un profil Grasp, l'ouvrir avec
  `headless=false` et s'y connecter une fois à la main ; la connexion persiste ensuite.
- **chrome.exe orphelin** si le control plane **et** le bridge sont tués par `SIGKILL` en même temps
  (rien ne reste pour appeler `Browser.close` ou PowerShell). `grasp stop` forcé le rattrape via
  `instances.json` ; sinon, fermez la fenêtre ou tuez le processus dont la ligne de commande contient
  `\grasp\profiles\`.
- La bascule de profil relance le navigateur : la page courante n'est pas conservée.
- macOS : non testé (pas de `/proc`, pas de `setpriv` ; le control plane tue alors les groupes Chrome).
