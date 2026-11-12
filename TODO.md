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
- [x] **Rapport de recette** : console en erreur, requêtes 4xx/5xx et erreurs de formulaire résumées en
      fin de `run`, avec capture en cas d'échec. — Fait : `run --report` (d'office avec `expect`), texte
      compact et `--json` (`report`) ; capture prise juste après chaque échec (chemin seulement).
- [x] **Doc** : section README « Tester un serveur distant » (tunnel SSH, allowlist, exemples). Fait :
      `ssh -L` simple, vhost par `hostResolverRules`, `ssh -D` + `proxyServer`, certificats, basic auth,
      recette complète, avec `expect` et le rapport de recette (`examples/recette.sh`).

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
- [ ] Remplacer le masque des mots de passe par `secret:NOM` quand les variables de secrets existeront.
- [ ] Outil MCP `history` ; traduction des refs de `--scope` ; description sans snapshot séparé pour
      `expect`/`wait --sel`/`upload` par ref.

## Suites (limites notées par chaque branche, regroupées à l'intégration)

Sécurité du garde
- [ ] **Sous-ressources** (`fetch()`, images, scripts) : ni l'allowlist ni la protection SSRF ne les bloquent
      (le garde ne couvre que les documents) ; seuls les traqueurs le sont. Étendre le garde `Fetch` à tous
      les types coûterait une pause par requête : à mesurer.
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

Lecture et recette
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

- [ ] **Viewport** : `grasp viewport 360x800 [--mobile] [--dpr N]` ou option de session
      (`Emulation.setDeviceMetricsOverride`) ; la fenêtre est fixée à 780 px, impossible de tester un défaut mobile.
- [ ] **Socket trop long** : repli automatique (`/run/user/$UID` ou nom court haché) quand le chemin du socket
      Unix dépasse la limite (GRASP_HOME dans un tmp profond), au lieu d'échouer.
- [ ] **`screenshot -o <fichier>` dans `grasp run`** : aujourd'hui refusé ; utile pour des captures nommées
      dans un rapport de recette.
- [ ] **`console --level error`** remonte aussi les événements de navigation : ne garder que les erreurs.
- [ ] **URL « nullblank »** après une navigation vers about:blank (origin `null` concaténé).
- [ ] **Poser une session factice sans `allowEval`** : `grasp state import` le permet déjà (documenter ce cas
      d'usage dans la section Recette) ; envisager `grasp storage set local <clé> <valeur>`.
- [ ] **`grasp a11y`** : lister les contrôles sans nom accessible, les messages d'erreur non reliés à leur champ
      (`aria-describedby` absent), etc. Utile en recette.
