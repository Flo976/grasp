#!/usr/bin/env bash
# Scénario de bout en bout : nav → snap → 3 champs → select → check → submit,
# puis vérification PAR LE CONTENU DE LA PAGE (pas par le code de retour des actions).
set -euo pipefail
cd "$(dirname "$0")/.."
grasp() { node dist/src/cli/main.js "$@"; }

# Environnement isolé : ne touche ni à votre config ni à un serveur déjà lancé.
DEMO=$(mktemp -d /tmp/grasp-demo.XXXXXX)
export XDG_CONFIG_HOME=$DEMO/config XDG_STATE_HOME=$DEMO/state XDG_DATA_HOME=$DEMO/data XDG_RUNTIME_DIR=$DEMO/run
mkdir -m 700 -p "$XDG_RUNTIME_DIR"
cleanup() { grasp stop >/dev/null 2>&1 || true; [[ -n "${SITE_PID:-}" ]] && kill "$SITE_PID" 2>/dev/null || true; rm -rf "$DEMO"; }
trap cleanup EXIT

# 1. Site de test local
coproc SITE { node examples/testsite.mjs; }
SITE_PID=$SITE_PID
read -r URL <&"${SITE[0]}"
echo "# site de test : $URL"

# 2. Serveur (premier plan, en tâche de fond pour la démo) et session
grasp serve 2>"$DEMO/serve.log" &
for _ in $(seq 100); do grasp status >/dev/null 2>&1 && break; sleep 0.1; done
export GRASP_SESSION=$(grasp session create)
echo "# session : $GRASP_SESSION"

# 3. Navigation + snapshot
grasp nav "$URL/"
grasp snap | tee "$DEMO/snap.txt"

# 4. Trois champs, avec les trois formes de sélecteur
NOM=$(grep 'textbox "Nom"' "$DEMO/snap.txt" | sed -E 's/^ *(e[0-9a-z]+):.*/\1/')
grasp fill "$NOM" "Ada Lovelace"              # ref issue du snapshot
grasp fill '#email' 'ada@example.org'          # CSS
grasp fill 'text:Ville' 'Antananarivo'         # texte accessible

# 5. Liste déroulante + case à cocher, avec diff
grasp select 'text:Pays' 'Madagascar'
grasp check "text:J'accepte les conditions" --snap-diff

# 6. Soumission
grasp click 'text:Valider' --snap-diff

# 7. Vérification par le contenu de la page
PAGE=$(grasp text)
echo "$PAGE"
for attendu in 'Nom : Ada Lovelace' 'Email : ada@example.org' 'Ville : Antananarivo' 'Pays : mg' 'CGU : oui'; do
  grep -qF "$attendu" <<<"$PAGE" || { echo "ÉCHEC : « $attendu » absent de la page" >&2; exit 1; }
done
echo "SCÉNARIO VALIDÉ"
