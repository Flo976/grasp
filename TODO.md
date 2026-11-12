# TODO

## Repris d'Obscura (h4ckf0r0day/obscura, Apache-2.0)

Ordre proposé. Toute reprise de code doit citer la source et la licence.

- [ ] **Blocage des traqueurs** : liste de Peter Lowe (pgl.yoyo.org, ~3 500 domaines, celle qu'utilise
      Obscura), via `Network.setBlockedURLs` ou le garde `Fetch` existant. Optionnel, activé par défaut
      en lecture. Attendu : pages plus rapides, attente de stabilité plus courte, snapshots plus propres.
- [ ] **Serveur MCP** : `grasp mcp` (stdio) au-dessus de l'API HTTP (`snap`, `click`, `fill`, `wait`,
      `text`, `console`, `screenshot`, `run`…). Branchable dans Claude Desktop / Cursor en une ligne.
- [ ] **Sortie Markdown** : `grasp text --markdown` (titres, listes, liens, tableaux, code), calculée
      dans le monde isolé `grasp-lecture`.
- [ ] **Export/import de l'état** : `grasp state export|import` (cookies + localStorage en JSON) pour
      transférer une session connectée vers une autre machine ou un conteneur.
- [ ] **Protection SSRF** : refus par défaut des IP privées, vérifié à la résolution DNS, en plus de
      l'allowlist (utile quand l'agent reçoit des URL de l'extérieur). Attention à ne pas casser le
      défaut actuel `127.0.0.1` / `localhost` (tests locaux, tunnels).
- [ ] **Workers et recyclage** : sessions en parallèle, navigateur relancé au-delà de N Mo / N minutes.
      Seulement si on vise du volume.
- [x] **Image Docker** : Chrome + Grasp, non-root (branche `feat/image-docker`). `Dockerfile` multi-étapes,
      Chromium Debian, sandbox conservée via `docker/seccomp-chrome.json` (ou `--cap-add=SYS_ADMIN`), XDG
      dans le volume `/data`, accès depuis l'hôte par `docker exec`, socket monté ou `serve --tcp --listen`
      (opt-in, `GRASP_URL` côté client). `doctor` et `examples/e2e.sh` validés dans le conteneur.
      Pas distroless : Chromium tire ses dépendances par `apt`, `examples/e2e.sh` veut bash, et `setpriv`
      vient d'util-linux. Image : 1,32 Go (dont 719 Mo pour Chromium et ses dépendances).
  - [ ] Réduire l'image (distroless ou `chrome-headless-shell`) : gain à mesurer, et `headless=false` y renoncerait.
  - [ ] Recette de l'image en CI (build + `doctor` + `e2e.sh`), aujourd'hui faite à la main.
- [ ] **Évaluer Obscura comme moteur léger** derrière Grasp (il parle CDP et implémente
      `Accessibility.getFullAXTree`) : mesurer la couverture CDP réellement utilisée par le bridge.

Non repris, volontairement : la falsification d'empreinte en JS (incohérences détectables dans un vrai
Chrome) et l'imitation TLS (Chrome a déjà la vraie empreinte).

## Recette sur serveur distant (Claude vérifie une tâche à travers un tunnel)

- [ ] **Résolution d'hôte** : clé `hostResolverRules` → `--host-resolver-rules="MAP site.exemple.com
      127.0.0.1:8443"`. Avec un `ssh -L`, le vhost Apache attend son vrai nom (`Host:`), pas `localhost`.
- [ ] **Proxy** : clé `proxyServer` → `--proxy-server=socks5://127.0.0.1:1080` (tunnel `ssh -D`), pour
      voir le site exactement comme depuis le serveur de rebond.
- [ ] **Certificats** : option explicite (jamais par défaut) pour accepter un certificat qui ne correspond
      pas au nom via tunnel, signalée par `grasp security`.
- [ ] **Authentification HTTP basic** (préprod protégée) : identifiants fournis à la session, jamais
      écrits dans les journaux.
- [ ] **Recette scriptée** : `grasp run --assert` (ou `expect`) qui échoue avec un code ≠ 0 et un
      rapport lisible quand un texte attendu manque, pour enchaîner « déployer → vérifier » sans
      interprétation.
- [ ] **Rapport de recette** : console en erreur, requêtes 4xx/5xx et erreurs de formulaire résumées en
      fin de `run`, avec capture en cas d'échec.
- [ ] **Doc** : section README « Tester un serveur distant » (tunnel SSH, allowlist, exemples).
