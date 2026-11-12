# TODO

## Repris d'Obscura (h4ckf0r0day/obscura, Apache-2.0)

Ordre proposé. Toute reprise de code doit citer la source et la licence.

- [x] **Blocage des traqueurs** : liste de Peter Lowe (pgl.yoyo.org, ~3 500 domaines, celle qu'utilise
      Obscura), via `Network.setBlockedURLs` ou le garde `Fetch` existant. Optionnel, activé par défaut
      en lecture. Attendu : pages plus rapides, attente de stabilité plus courte, snapshots plus propres.
      → Fait : garde `Fetch` (un motif par domaine, hôte vérifié par le bridge ; marche sans `Network`), clé
      `blockTrackers` (défaut `true`), liste dans `data/pgl-domains.txt`, compteur `trackersBlocked` + console,
      requêtes bloquées hors de l'attente de stabilité. Tests : `trackers.test.ts` (unitaire et intégration).
- [x] **Serveur MCP** : `grasp mcp` (stdio) au-dessus de l'API HTTP (`snap`, `click`, `fill`, `wait`,
      `text`, `console`, `screenshot`, `run`…). Branchable dans Claude Desktop / Cursor en une ligne.
      Fait : sans dépendance, outils = lignes de commande via `buildRequest`, serveur lancé si absent,
      session créée puis fermée (ou imposée par `--session`). Reste : notifications de progression pour
      les `run` longs, annulation (`notifications/cancelled` ignorée : l'étape en cours va à son terme).
- [x] **Sortie Markdown** : `grasp text --markdown` (titres, listes, liens, tableaux, code), calculée
      dans le monde isolé `grasp-lecture`. Fait (branche `feat/texte-markdown`) : aussi `GET /text?markdown=1`
      et `grasp run` ; budget et `--scope` de `text` ; `frame=…` via Playwright (monde de la page du cadre).
      Implémentation propre à Grasp (pas de code repris d'Obscura).
- [x] **Export/import de l'état** : `grasp state export|import` (cookies + localStorage en JSON) pour
      transférer une session connectée vers une autre machine ou un conteneur.
      Fait (branche `feat/etat-export-import`) : format `grasp-state` v1 (sur-ensemble du storageState
      Playwright), cookies + localStorage par origine + sessionStorage de l'onglet, routes
      `GET /state/export` / `POST /state/import`, soumis à `allowCookies` et à l'allowlist, fichier 0600
      atomique ; localStorage par navigation contrôlée (document vide servi par Fetch, aucune requête au
      site). Reste : IndexedDB, origines d'anciennes sessions sans cookie (seulement via `--origin`).
- [x] **Protection SSRF** : refus par défaut des IP privées, vérifié à la résolution DNS, en plus de
      l'allowlist (utile quand l'agent reçoit des URL de l'extérieur). Attention à ne pas casser le
      défaut actuel `127.0.0.1` / `localhost` (tests locaux, tunnels).
      → fait (`src/core/ssrf.ts`, clé `allowPrivateNetwork`, README « Protection SSRF ») : littéraux inscrits
      permis, noms résolus en privé refusés (pré-contrôle + garde `Fetch`), rebinding rattrapé après coup par
      `remoteIPAddress`. Reste : sous-ressources (`fetch()`, images) non couvertes, comme pour l'allowlist.
- [x] **Workers et recyclage** : sessions en parallèle, navigateur relancé au-delà de N Mo / N minutes.
      Seulement si on vise du volume. *Fait (branche `feat/recyclage-navigateurs`)* : le parallélisme existait
      déjà (une session = un bridge = un Chrome, mesuré jusqu'à 20 sessions, ≈ 230 Mo chacune) et est désormais
      testé ; `browserMaxRssMb` (PSS du groupe Chrome ; octets privés de chrome.exe) et `browserMaxAgeMin`,
      désactivés par défaut, relancent le navigateur entre deux commandes (même session, même profil, cookies de
      session reportés, page rechargée, note `navigateur recyclé : …`) ; `maxSessions` → 503. Voir README
      « Sessions parallèles et recyclage ».
- [x] **Image Docker** : Chrome + Grasp, non-root (branche `feat/image-docker`). `Dockerfile` multi-étapes,
      Chromium Debian, sandbox conservée via `docker/seccomp-chrome.json` (ou `--cap-add=SYS_ADMIN`), XDG
      dans le volume `/data`, accès depuis l'hôte par `docker exec`, socket monté ou `serve --tcp --listen`
      (opt-in, `GRASP_URL` côté client). `doctor` et `examples/e2e.sh` validés dans le conteneur.
      Pas distroless : Chromium tire ses dépendances par `apt`, `examples/e2e.sh` veut bash, et `setpriv`
      vient d'util-linux. Image : 1,32 Go (dont 719 Mo pour Chromium et ses dépendances).
      Suites : voir « Suites », Image Docker.
- [x] **Évaluer Obscura comme moteur léger** derrière Grasp (il parle CDP et implémente
      `Accessibility.getFullAXTree`) : mesurer la couverture CDP réellement utilisée par le bridge.
      Fait (branche `eval/obscura`, `docs/eval-obscura.md`, Obscura 0.2.6) : **pas en l'état**. e2e.sh passe en
      mode attach sans modification, démarrage ×6 et mémoire ×7 sur 10 sessions légères ; mais garde contournée
      par une redirection 302 (saut non présenté à `Fetch`), `confirm()` accepté d'office, pas de Playwright de
      repli, arbre AX pauvre en formulaires, Wikipédia : nav ×2,8 et snapshot ×5,7 plus lents. 78/118 tests de
      page OK (Chrome attaché : 118). À réévaluer quand Obscura interceptera les redirections.
- [x] **Mode attach hors Chrome** : documenter que la garde runtime (redirections) n'est garantie qu'avec
      Chrome ; un navigateur qui se dit `Chrome/…` dans `/json/version` peut ne pas l'être (Obscura).
      Fait à l'intégration : README, « Limites connues ».

Non repris, volontairement : la falsification d'empreinte en JS (incohérences détectables dans un vrai
Chrome) et l'imitation TLS (Chrome a déjà la vraie empreinte).

## Sécurité face au contenu des pages

- [x] **Frontières de contenu** (injection de prompt indirecte) : clé `contentBoundaries` (`auto` par défaut :
      actives dès que l'allowlist sort de la boucle locale ; `true`/`false` forcent). Fait (branche
      `feat/frontieres-contenu`) : snap, text, markdown, diff, notes, console, erreurs (400 compris), étapes et rapport
      de `run` encadrés par `<<<GRASP_PAGE_CONTENT nonce=…>>>` (nonce de 64 bits par réponse, dans le bridge) ;
      imitations du marqueur neutralisées (casse, pleine chasse, NFKC, invisibles, homoglyphes) et comptées ; règle
      `BOUNDARY_RULE` dans `grasp help` et les instructions MCP. Coût : 147 à 151 octets par bloc. Inspiré
      d'agent-browser (`--content-boundaries`) et de l'IDPI de PinchTab. Tests : page piégée `/piege`.
      Défaut `auto` : compromis documenté (le contenu affiché par une page locale peut venir de tiers ; à forcer
      dans ce cas et derrière un `ssh -L`). Règle reprise dans `grasp skill` à l'intégration. Reste : test MCP de
      bout en bout ; mesurer l'effet sur un modèle ; réévaluer le défaut `true` (41 tests à adapter, mesuré).

## Recette sur serveur distant (Claude vérifie une tâche à travers un tunnel)

- [x] **Résolution d'hôte** : clé `hostResolverRules` → `--host-resolver-rules="MAP site.exemple.com
      127.0.0.1:8443"`. Avec un `ssh -L`, le vhost Apache attend son vrai nom (`Host:`), pas `localhost`.
      Fait : syntaxe validée au démarrage, motif avec port (`site.exemple.com:443`), allowlist sur le nom ;
      mêmes drapeaux pour chrome.exe (test réel `GRASP_TEST_WINDOWS=1`).
      Protection SSRF réconciliée : un nom couvert par une règle MAP est jugé sur la cible de la règle
      (adresse ou `localhost` = littéral inscrit, admis sans DNS ; nom = résolu et jugé) ; jamais résolu par
      le DNS système ; contrôle anti-rebinding sauté pour lui (testé : nom mappé sur 127.0.0.1 servi, même
      nom sans règle mais résolu en privé refusé).
- [x] **Proxy** : clé `proxyServer` → `--proxy-server=socks5://127.0.0.1:1080` (tunnel `ssh -D`), pour
      voir le site exactement comme depuis le serveur de rebond. Fait : `proxyBypassList`, `--proxy` par
      session (rapporté par `grasp security`), refus en mode attach ; testé avec proxys SOCKS5 et HTTP locaux.
      Protection SSRF réconciliée : un nom qui passe par le proxy (http, https, socks5, hors
      `proxyBypassList`) n'est pas résolu localement et le contrôle anti-rebinding est sauté (l'adresse vue
      est celle du proxy) ; l'allowlist sur le nom reste appliquée. Limite documentée : ce que le proxy
      résout de son côté n'est pas couvert par la protection SSRF.
- [x] **Certificats** : option explicite (jamais par défaut) pour accepter un certificat qui ne correspond
      pas au nom via tunnel, signalée par `grasp security`. Fait : `ignoreCertErrorsFor`, limitée aux hôtes
      listés (`Security.certificateError` par onglet, jamais `*`), avertissement à chaque démarrage.
- [x] **Authentification HTTP basic** (préprod protégée) : identifiants fournis à la session, jamais
      écrits dans les journaux. Fait : `grasp session create --http-auth u:mdp@hôte | -` (stdin), via
      `Fetch.authRequired`, hôte de l'allowlist seulement, un seul essai ; masqués partout (testé sur disque).
- [x] **Recette scriptée** : `grasp run --assert` (ou `expect`) qui échoue avec un code ≠ 0 et un
      rapport lisible quand un texte attendu manque, pour enchaîner « déployer → vérifier » sans
      interprétation. — Fait : commande `expect` (run et commande directe) : `text`, `no-text`, `url`,
      `title`, `sel`, `no-sel`, `value` (égalité, `~` contient, `--regex`), `no-console-errors`,
      `no-form-errors` ; relue jusqu'à `--timeout` (5 s) ; échec = code 1, « attendu … ; constaté : … »
      avec extrait borné (`test/integration/recette.test.ts`, `examples/recette.sh`).
- [x] **Journal réseau par action** : `--network` sur les actions, `grasp network [--since] [--failed] [--max]
      [--type]` (méthode, URL masquée, statut, durée, type ; bornés, perte annoncée) et `expect request
      "POST /api/…" [2xx|201|4xx,5xx]` pour vérifier qu'un « Enregistrer » a vraiment appelé l'API. Fait (branche
      `feat/journal-reseau`, `src/core/network.ts`) : nourri par les événements Network déjà écoutés (console,
      stabilité), sans corps ni en-têtes et sans option pour les voir ; `allowConsole=false` → 403 explicite.
      Tests : `test/unit/network.test.ts`, `test/integration/network.test.ts`. Après relecture : fenêtre de
      `expect request` étendue au début de la dernière action (fetch puis navigation, formulaire POST en PRG),
      requête d'avant la fenêtre citée avec son `--since`, méthode insensible à la casse et motif strict
      impossible refusé en 400, cas positif « réponse arrivée pendant --timeout » testé. Outil MCP `network`
      ajouté à l'intégration.
- [x] **Rapport de recette** : console en erreur, requêtes 4xx/5xx et erreurs de formulaire résumées en
      fin de `run`, avec capture en cas d'échec. — Fait : `run --report` (d'office avec `expect`), texte
      compact et `--json` (`report`) ; capture prise juste après chaque échec (chemin seulement).
- [x] **Recette multi-pages** : `grasp diff <urlA> <urlB> [--paths f]` (préprod/prod page par page : statut,
      titre, structure du snapshot, texte de `main`, erreurs console, requêtes en échec) et `grasp audit
      <sitemap|liste>` (statut, console, requêtes 4xx/5xx, liens internes cassés, formulaire au chargement).
      Fait (branche `feat/recette-multipages`) : sessions éphémères (`--concurrency`), routes `/inventory` et
      `/check-links` (monde isolé, même origine, HEAD sans suivre les redirections, déconnexion jamais demandée),
      bornes annoncées, `--json`, code 1 ; tests sur deux instances du site de test (`multipage.test.ts`).
      Relecture : un lien au `%` isolé ou mal encodé (`/promo-100%`, `/a%zz`) levait « URI malformed » et
      faisait échouer tout l'audit ; décodage tolérant (UTF-8, à défaut latin-1) et tests `runAudit`/`discover`.
- [x] **Doc** : section README « Tester un serveur distant » (tunnel SSH, allowlist, exemples). Fait :
      `ssh -L` simple, vhost par `hostResolverRules`, `ssh -D` + `proxyServer`, certificats, basic auth,
      recette complète, avec `expect` et le rapport de recette (`examples/recette.sh`).

## Retours d'essais réels

- [x] **Viewport et émulation** (branche `feat/viewport`) : impossible de tester un défaut mobile à 360 px (headless
      rendu à 780 × 493). Fait : `grasp viewport 360x800 [--mobile] [--dpr N] [--touch] [--mobile-ua]`, `viewport
      reset`, lecture des mesures de la page, appareils (`iphone-se`, `pixel-7`…), `session create --viewport`,
      ligne de `run` ; onglet de la session seulement (attach compris) ; retenu par le control plane et réappliqué
      à la bascule de profil et au recyclage ; captures `--full`/`--el` qui reviennent au viewport émulé. Tests :
      `viewport.test.ts` (media query vérifiée par `text`), `viewport-cli.test.ts`, `unit/viewport.test.ts`. Relecture : reset d'un
      viewport à la taille de l'écran réel sans attente de 2 s ; `viewport` annoncé dans l'outil MCP `run`.
      Intégration : outil MCP `viewport`, viewport hérité par les popups. Reste : test réel sur chrome.exe ; UA
      Safari pour les appareils iOS.

## Pilotage

- [x] **Dialogues pilotables** : `--dialog accept|dismiss|"texte"` par action (CLI, API, `grasp run`, MCP) ;
      défaut sûr inchangé (`confirm`/`prompt` refusés, `alert` fermé, `beforeunload` accepté). Fait (branche
      `feat/dialogues`, `src/core/dialog.ts`) : tout dialogue vu est rapporté (note, `dialogs`, en tête du
      `--snap-diff`), y compris hors action (à l'action suivante) et en cas d'échec. Pas d'option de session
      (choix : une réponse positive se décide par action). Relecture : un texte ne confirme plus un `confirm`
      (seul `accept` le fait ; `cancel`, `Dismiss`… → refus), valeur en `--…` refusée (400).
      Dialogue ouvert pendant le `--snap-diff` d'après ou `post` : rapporté par l'action (relevé en dernier).
      Reste : dialogues d'une iframe hors processus non testés.

## Historique et rejeu

- [x] **`grasp history [--as-run] [--since]`** (branche `feat/historique-run`) : commandes de la session mémorisées
      par le control plane (500, en mémoire), `--as-run` → script `grasp run` rejouable : refs → `text:<nom>`
      (unique) ou CSS stable vérifié unique (attributs, ancêtre identifié, chemin positionnel en dernier recours),
      lectures et échecs omis, mots de passe jamais conservés (ligne commentée), `--expect` sur l'état final.
      Description de cible faite sur le snapshot de l'action (+0,2 ms / +16 ms mesurés). Test : exploration,
      export, rejeu dans une nouvelle session, même `text` final.
- [x] Relecture : sauts de ligne — un argument sur plusieurs lignes n'est jamais écrit dans le script (ligne
      commentée), tout commentaire ramené à une ligne (une commande en échec ne peut plus y injecter une ligne).
- [x] Relecture : actions concurrentes — description de cible liée à l'appel (AsyncLocalStorage), refusée par
      le control plane si `given` diffère de la cible (saisie alors masquée).
- [ ] Actions concurrentes d'une session : le groupe d'objets CDP `grasp` est libéré à la fin de chaque action,
      l'autre peut échouer (« Could not find object with given id », vu 1 fois sur ~10 paires `fill`+`click`) ;
      `notes`/`actTarget` sont aussi partagés. Sérialiser les actions par session, ou un groupe par action.
- [x] `secret:NOM` (intégration) : `fill <sél> secret:NOM` est enregistré par son nom et rejoué tel quel ; le masque
      reste pour une valeur littérale saisie dans un champ secret. Outil MCP `history` ajouté.
- [ ] Traduction des refs de `--scope` ; description sans snapshot séparé pour `expect`/`wait --sel`/`upload`
      (et `scroll`) par ref.

## Suites (limites notées par chaque branche, regroupées à l'intégration)

Sécurité du garde
- [ ] **Sous-ressources** (`fetch()`, images, scripts) : ni l'allowlist ni la protection SSRF ne les bloquent
      (le garde ne couvre que les documents) ; seuls les traqueurs le sont. Étendre le garde `Fetch` à tous
      les types coûterait une pause par requête : à mesurer.
- [ ] **Cache aller-retour (bfcache)** : un `history.back()` lancé par la page restaure un document sans requête,
      donc sans passer par le garde `Fetch` (constaté : entrée dont le nom résout désormais en privé, restaurée).
      `grasp back`/`forward` rejugent l'URL avant de partir ; pour la page elle-même : désactiver le bfcache
      (`--disable-features=BackForwardCache`, coût à mesurer) ou rejuger sur `Page.frameNavigated` de type
      `BackForwardCacheRestore`.
- [ ] **DNS rebinding** : détecté **après** la requête (lecture protégée, pas l'effet de bord), et seulement
      avec `allowConsole=true` (domaine `Network`).
- [ ] **SSRF derrière un proxy** : ce que le proxy résout de son côté n'est pas couvert (choix assumé à la
      réconciliation avec l'accès distant) ; contournement (`proxyBypassList`) reconnu pour les noms exacts,
      jokers et `<local>`, pas pour les plages CIDR appliquées à un nom.

Accès distant
- [ ] `Security.setOverrideCertificateErrors` (base de `ignoreCertErrorsFor`) est déprécié dans le protocole :
      surveiller sa disparition (le bridge refuse alors de démarrer, sans repli global).
- [ ] Pas d'authentification auprès d'un proxy ; identifiants fournis sur défi d'un document seulement (une
      sous-ressource d'un autre hôte protégé n'en reçoit pas) ; `--http-auth` en clair visible dans `ps`.
- [ ] `grasp mcp` ne sait pas encore créer une session avec `--proxy` ou `--http-auth` (utiliser `--session`
      sur une session créée par la CLI).

Onglets et popups
- [x] **Onglets pilotables** (branche `feat/onglets-popups`) : `tabs`, `tab <id>`, `tab new [url]`, `tab close [id]` ;
      popup / `target=_blank` adopté en pause (garde posé avant son premier document), annoncé par l'action
      (`nouvel onglet t2 ouvert : …`), `--follow` ; retour sur l'ouvreur quand le popup se ferme (OAuth) ; refs,
      console, garde, traqueurs, SSRF par onglet ; plafond `maxTabs` (10). Tests : `tabs.test.ts`, `tabs-cli.test.ts`.
- [x] Mode attach : `tab new` et l'onglet d'état (`state export|import`) étaient détachés aussitôt attachés (le
      meneur prenait leur `Target.attachedToTarget` pour un onglet de l'utilisateur) ; cibles réclamées
      (`hub.claimed`), test en mode attach dans `tabs.test.ts`.
- [x] Notes d'onglet bornées et masquées (URL par `redactUrl` à 300, titre à 80) : un popup OAuth ne recopie plus
      `code=…` en clair ni 20 000 caractères d'URL dans la note.
- [x] Notes différées (onglet fermé par la page hors action) visibles partout : en tête du résultat de tout outil
      MCP (le client MCP ignorait `X-Grasp-Notice`, recyclage compris), reportées dans la note du recyclage ;
      option MCP `follow`.
- [ ] Mode attach : popups ni gardés ni adoptés (pas d'auto-attach du navigateur dans le Chrome de l'utilisateur ;
      l'auto-attach d'onglet n'attache pas les popups). Piste : `Target.setDiscoverTargets` + `openerId`, mais sans
      pause : le premier document échapperait au garde.
- [x] Outils MCP `tabs` / `tab` (intégration).
- [ ] Recyclage et bascule de profil : seul l'onglet actif est rouvert.

Lecture et recette
- [x] **Lecture progressive** (branche `feat/lecture-progressive`) : `snap --outline` (repères, tableaux et titres
      avec le volume de chaque repère), `snap --interactive` (actionnables, conteneurs et titres de contexte),
      `find <texte|/regex/> [--role] [--max]` (lignes trouvées, options de listes fermées comprises, conteneur
      joint) ; refs identiques au snapshot complet ; CLI, `GET /snap?mode=|find=`, run, MCP (`snap mode`, `find`).
      Mesuré sur `/portail` : complet 24 153 octets, outline 1 050, interactive 11 362, find 147.
      Relecture : `find` garde la ligne `… élagué` (modale, iframes) ; la CLI refuse `find --outline|--interactive|
      --markdown` et `snap|text --role|--limit` comme l'API et `grasp run`.
- [ ] Lecture progressive : mesurer les gains sur des pages réelles ; volume des `banner`/`contentinfo` sans nom
      (non émis par le snapshot) ; `--role` par familles (`textbox` + `searchbox`) ?
- [x] **Audit d'accessibilité** : `grasp a11y [--scope] [--max] [--json]` et `expect a11y [--max N]`
      (branche `feat/audit-a11y`). Arbre d'accessibilité + relevé des erreurs de formulaire + DOM (monde isolé,
      autorisé sans eval) : contrôles sans nom, images sans alt, erreur visible non reliée ou masquée, `<label for>`
      orphelin, référence ARIA cassée, rôle invalide, titre sauté ; ref et correction par problème. Testé sur une
      page piégée (`test/integration/a11y.test.ts`, `a11y-cli.test.ts`). Pas un audit WCAG.
- [x] Audit d'accessibilité, relecture : icône `<svg>` inline sans `role` (dans un lien ou un bouton nommé)
      plus signalée `image-sans-alt` ; correction propre au `<svg role=img>` (`<title>`/`aria-label`, pas `alt`).
- [x] Audit d'accessibilité, relecture : message d'erreur relié par `aria-describedby` à un champ sans
      `aria-invalid` plus rapporté « non relié » : nouveau type `erreur-sans-invalide` (correction `aria-invalid`).
- [ ] Audit d'accessibilité : contrastes (calcul sur les styles calculés), nom réduit au `placeholder`, noms
      inutiles (« cliquez ici »), iframes (outil MCP `a11y` ajouté à l'intégration).
- [ ] Recette multi-pages : pas d'outil MCP ni de ligne `grasp run` pour `diff`/`audit` ; pas de crawl récursif
      (un niveau depuis une page HTML) ; sitemaps `.xml.gz` non lus ; tolérance aux contenus variables seulement
      par `--ignore` ; pas de comparaison visuelle (captures).
- [ ] `expect` ne prend pas en charge `frame=…` (`wait --sel` le sait).
- [ ] MCP : notifications de progression pour les `run` longs ; annulation (`notifications/cancelled`
      ignorée : l'étape en cours va à son terme) ; pas d'outils dédiés `expect` ni `state` (accessibles par `run`).
- [ ] Traqueurs : blocage par domaine seulement (pas de règles d'URL à la EasyList) ; requêtes des workers
      non couvertes ; liste embarquée à mettre à jour à la main.

État et sessions
- [ ] `state export|import` : ni IndexedDB, ni Cache Storage ; origines d'anciennes sessions sans cookie
      seulement via `--origin`.
- [ ] Recyclage : page rouverte par un nouveau GET (état JS, `sessionStorage`, refs perdus) ; vérifié à
      l'arrivée d'une commande seulement (une session inactive ou toujours occupée n'est jamais recyclée) ;
      mesure chrome.exe vieille de 30 s au plus.

Image Docker
- [ ] Réduire l'image (distroless ou `chrome-headless-shell`) : gain à mesurer, et `headless=false` y renoncerait.
- [ ] Recette de l'image en CI (build + `doctor` + `e2e.sh`), aujourd'hui faite à la main.

Évaluation d'Obscura
- [ ] Réévaluer quand Obscura interceptera les redirections (garde contournée par un 302 aujourd'hui).
- [ ] Licence des instantanés Wikipédia (CC BY-SA) versionnés sous `docs/eval-obscura/snapshots/` : à
      confirmer ou à retirer.

## Retours du premier essai réel (recette Dexyu en local, 12/11/2026)

29 étapes, 27 OK, 2 KO (vrais défauts de l'app). Manques constatés côté Grasp :

- [x] **Viewport** : `grasp viewport 360x800 [--mobile] [--dpr N]` ou option de session
      (`Emulation.setDeviceMetricsOverride`) ; la fenêtre est fixée à 780 px, impossible de tester un défaut mobile.
      → fait (branche `feat/viewport`, voir « Retours d'essais réels »).
- [x] **Socket trop long** : repli automatique sur `/tmp/grasp-<uid>/<hash>/` (0700, propriétaire et absence de lien
      vérifiés par le serveur et par le client) quand le chemin du socket Unix dépasse la limite, au lieu d'échouer.
- [x] **`screenshot -o <fichier>` dans `grasp run`** : chemin relatif sans `..`, image renvoyée au client et
      écrite par la CLI sous `--out-dir` (0600, liens qui sortent refusés) ; 20 par run ; refusé via HTTP/MCP.
- [x] **`grasp run --out-dir` vérifié avant le run** : répertoire et chemins de `screenshot -o` contrôlés par la
      CLI avant l'envoi (aucune étape exécutée sinon) ; un échec d'écriture tardif marque l'étape KO sans jeter
      le résultat du run.
- [x] **`console --level error`** remonte aussi les événements de navigation : les repères (niveau info) suivent
      désormais le filtre ; `--level error|warn` ne les rend plus.
- [x] **URL « nullblank »** après une navigation vers about:blank (origin `null` concaténé) : `urlBase` (schéma,
      hôte, chemin) remplace `origin + pathname` dans `redactUrl` et la clé de fusion réseau.
- [x] **Poser une session factice sans `allowEval`** : cas d'usage `grasp state import` documenté dans la section
      Recette (fichier minimal, testé) ; `grasp storage get|set|rm local|session <clé> [valeur|-]` sur l'origine
      affichée, code fixe dans le monde isolé, soumis à `allowCookies` (mêmes données que l'export d'état), aussi
      dans `grasp run`.
- [x] **`grasp a11y`** : lister les contrôles sans nom accessible, les messages d'erreur non reliés à leur champ
      (`aria-describedby` absent), etc. Utile en recette. → fait (branche `feat/audit-a11y`, voir « Lecture et
      recette »).

## Aide pour agents

- [x] **`grasp skill` et `grasp help --json`** : mode d'emploi pour un agent IA (format SKILL.md de Claude Code,
      copie versionnée `skills/grasp/SKILL.md`) et description machine des commandes, options typées et outils
      MCP, depuis un catalogue unique (`src/core/commands.ts`) ; `test/unit/commands.test.ts` le confronte au
      parseur, à `main.ts`, à `run`, aux outils MCP et à SKILL.md. Reste : le catalogue double encore les données
      du parseur (`VALUE_FLAGS`, `RUN_FLAGS`) au lieu de les produire — les dériver quand les branches en cours sur
      `script.ts` seront intégrées ; `grasp help` (texte) reste rédigé à la main ; les instructions MCP
      (`initialize`) ne sont pas encore tirées du même texte.
- [x] **Test du catalogue durci** (relecture) : `RUN_FLAGS` exporté et comparé directement au catalogue, sondes
      `checkRunFlags` sur l'union catalogue + parseur, et toute option lue par `flags.has/get('…')` dans `main.ts`
      ou `script.ts` doit être décrite. Vérifié par mutation (option ajoutée à `RUN_FLAGS` ou lue par `main.ts`
      sans être décrite : rouge ; l'ancien test restait vert).
- [x] **Catalogue à jour de la vague 2** (intégration) : 48 commandes, outils MCP, options de diff/audit ;
      `skills/grasp/SKILL.md` régénéré (12 962 octets, borne du test portée à 14 000).

## Navigation et défilement

- [x] **`back`, `forward`, `reload [--hard]`, `scroll`** (branche `feat/navigation-historique`) : historique de
      l'onglet (route `pushState` comprise), garde appliqué (URL de l'entrée rejugée avant de partir : nécessaire,
      un `back` est servi par le bfcache sans requête), même attente que `nav`, `--snap-diff`, note « retour : url » ;
      `scroll [<sél>] [--by px|--to top|bottom] [--until-stable [--max-steps N]]` en code fixe du monde isolé,
      jusqu'à ce que plus rien n'apparaisse (défilement infini), nœuds DOM apparus comptés, plafonds annoncés.
      CLI, API HTTP, `grasp run`, MCP. Tests : `test/integration/historique.test.ts`, `test/unit/historique.test.ts`.
      Relecture : seul le refus du document principal fait échouer back/forward/reload (une iframe hors
      allowlist n'est qu'une note `cadre bloqué`) ; serveur injoignable → 502 `navigation échouée`, comme nav.
      Reste : défilement horizontal, molette réelle (`Input.dispatchMouseEvent` `mouseWheel`) pour les pages qui
      n'écoutent que `wheel`, `scroll` dans une iframe (`frame=…`).

## Secrets jamais vus par l'agent

- [x] **`fill <sél> secret:NOM`** (CLI, `grasp run`, MCP) : valeur prise dans `~/.config/grasp/secrets.json`
      (0600, hors config ; préféré à `GRASP_SECRET_NOM` : domaines portés par le secret, environnement hérité
      par Chrome et par le shell de l'agent), restreinte à des domaines (403 avant toute frappe sinon), masquée
      `secret:NOM` dans toutes les sorties texte (bridge à la source + filet du control plane, journal compris ;
      encodages URL/formulaire/JSON/HTML, débuts coupés par un budget, champ marqué, valeur effective tronquée).
      `grasp secrets list|set|rm`, outil MCP `secrets`. Inspiré de Playwright MCP (`lookupSecret`,
      `_redactSecrets`, Apache-2.0), sans code repris. Tests : `test/unit/secrets.test.ts`,
      `test/integration/secrets.test.ts`, 8 mutations détectées (README « Secrets »).
- [x] **Pas d'oracle** : `expect value|text|url|title` et `wait --text` comparent la forme masquée (un champ
      marqué vaut `secret:NOM`) ; sinon `expect value --regex '^préfixe'` reconstituait la valeur sans eval.
      4 mutations détectées. Restent : secret affiché mais jamais saisi dans la session, sélecteur CSS
      d'attribut sur une page qui recopie la saisie (README, Limites connues).
- [ ] Captures et PDF non masqués (un champ texte rempli s'y voit) : flouter les champs marqués avant capture ?
- [ ] Profil Chrome : cache HTTP, `Web Data` (saisie semi-automatique), `Sessions/` gardent une valeur envoyée
      par formulaire ; persistant pour un profil nommé. Désactiver la saisie semi-automatique pour les sessions
      qui utilisent un secret ?
- [ ] `frame=…` (secret dans une iframe de connexion) : contrôler le domaine du cadre, pas de la page.
- [ ] Masquage du journal du serveur non couvert par un test de mutation.

## Intégration de la vague 2 (branche `integration/vague-2`)

Treize branches fusionnées (`fix/retours-essai-dexyu`, `feat/skill-aide`, `feat/navigation-historique`,
`feat/viewport`, `feat/dialogues`, `feat/lecture-progressive`, `feat/frontieres-contenu`, `feat/secrets`,
`feat/journal-reseau`, `feat/audit-a11y`, `feat/historique-run`, `feat/recette-multipages`, `feat/onglets-popups`).
Corrections transverses :

- [x] **Bridge × frontières × secrets** : la réponse capturée par `withContentBoundaries` n'avait pas `getHeader`,
      lu par le masquage des secrets : le bridge tombait dès que les frontières étaient actives. Corrigé ;
      `writeHead` fusionne ses en-têtes avec ceux de `setHeader` (note des onglets conservée).
- [x] **Frontières sur les nouvelles sorties** : journal réseau (`reseau`), a11y, onglets, `storage get`
      (`stockage`), `grasp history` (`historique`), rapports de `diff` (`pages`) et `audit` ; `diff`/`audit`
      retirent les marqueurs du bridge avant de comparer (`test/integration/boundaries-v2.test.ts`).
- [x] **Onglets × viewport × secrets** : un popup hérite du viewport émulé et du masque des secrets ;
      `back`/`forward`/`reload` acceptent `--dialog` et `--network` (beforeunload refusé : 409 aussitôt), et
      passent comme `scroll` par l'annonce des popups (`test/integration/coherence-v2.test.ts`).
- [x] **history** connaît toutes les nouvelles commandes et options (aller-retour testé) ; `secret:NOM` rejoué.
- [x] **MCP** : outils `network`, `a11y`, `tabs`, `tab`, `viewport`, `history` ; propriété `network` des actions.

Suites de l'intégration :
- [ ] Dialogues d'un popup : non couverts par le `--dialog` de l'action qui l'ouvre (politique par onglet).
- [ ] `expect request` et `grasp network` ne lisent que l'onglet actif : une requête partie d'un popup n'est vue
      qu'après `tab <id>` ; un journal de session (tous onglets) serait plus simple pour la recette.
- [ ] `history --as-run` sous frontières actives : script seulement neutralisé (un nom accessible qui imite le
      marqueur devient `[marqueur imité]` et ne se rejoue plus) ; acceptable, à documenter si cela gêne.
- [ ] `grasp skill` : 12 962 octets (borne 14 000) ; au-delà, passer les commandes rares dans `grasp help`.
