#!/usr/bin/env bash
# Recette scriptée : « déployer → vérifier » sans interprétation. Le script de recette passe une commande,
# puis vérifie le résultat par des assertions `expect` ; le code de sortie de `grasp run` dit tout
# (0 = recette OK, 1 = au moins une assertion ou une action en échec), et le rapport de fin dit pourquoi.
# Deux passes sur le site de test local : une commande qui aboutit (code 0), une qui échoue côté serveur
# (500 sur l'API : code 1, rapport avec l'erreur console, la requête en échec et la capture).
set -euo pipefail
cd "$(dirname "$0")/.."
grasp() { node dist/src/cli/main.js "$@"; }

# Environnement isolé : ne touche ni à votre config ni à un serveur déjà lancé.
DEMO=$(mktemp -d /tmp/grasp-recette.XXXXXX)
export XDG_CONFIG_HOME=$DEMO/config XDG_STATE_HOME=$DEMO/state XDG_DATA_HOME=$DEMO/data XDG_RUNTIME_DIR=$DEMO/run
mkdir -m 700 -p "$XDG_RUNTIME_DIR"
cleanup() { grasp stop >/dev/null 2>&1 || true; [[ -n "${SITE_PID:-}" ]] && kill "$SITE_PID" 2>/dev/null || true; rm -rf "$DEMO"; }
trap cleanup EXIT

coproc SITE { exec node examples/testsite.mjs; }
SITE_PID=$SITE_PID
read -r URL <&"${SITE[0]}"
grasp serve >"$DEMO/serve.log" 2>&1 &
for _ in $(seq 100); do grasp status >/dev/null 2>&1 && break; sleep 0.1; done
export GRASP_SESSION=$(grasp session create 2>/dev/null)

# Le scénario de recette : une quantité en paramètre, le reste est fixe.
recette() {
  grasp run <<FIN
nav $URL/boutique
fill '#qte' $1
fill text:Courriel ada@example.org
click text:Commander
expect text "Commande enregistrée"       # relu jusqu'à 5 s : la réponse arrive en XHR
expect no-text "Erreur"
expect url ~ /merci
expect title Merci
expect sel '#recu'
expect no-console-errors
expect no-form-errors
FIN
}

echo "# 1. commande de 2 articles (doit passer)"
recette 2
echo "→ code 0 : recette OK"

echo
echo "# 2. commande de 13 articles (le serveur répond 500 : doit échouer)"
if recette 13; then echo "ÉCHEC DE LA DÉMO : la recette aurait dû échouer" >&2; exit 1; fi
echo "→ code ≠ 0 : recette en échec, comme attendu"
