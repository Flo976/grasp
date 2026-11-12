# syntax=docker/dockerfile:1
#
# Image Grasp : Node 22 + Chromium (Debian) + Grasp compilé, utilisateur non-root, sandbox Chrome conservée.
#
#   docker build -t grasp .
#   docker run -d --name grasp --init --shm-size=1g --cap-add=SYS_ADMIN -v grasp-data:/data grasp
#   docker exec grasp grasp doctor
#
# Le control plane écoute sur un socket Unix (ou TCP 127.0.0.1) À L'INTÉRIEUR du conteneur : voir la
# section « Docker » du README pour l'utiliser depuis l'hôte (docker exec, socket monté, ou --host).

ARG NODE_VERSION=22

# --- Étape 1 : compilation (devDependencies, tsc), puis élagage aux seules dépendances de production.
FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
RUN npx tsc -p . && npm prune --omit=dev --ignore-scripts

# --- Étape 2 : exécution.
FROM node:${NODE_VERSION}-bookworm-slim
# UID/GID de l'utilisateur grasp : à aligner sur l'hôte pour partager le socket Unix par un volume
# (docker build --build-arg UID=$(id -u) --build-arg GID=$(id -g)).
ARG UID=1000
ARG GID=1000

# chromium : navigateur (Debian, toutes architectures) ; util-linux : setpriv (PR_SET_PDEATHSIG) ;
# fonts-liberation : métriques de polices usuelles pour les captures ; tini : PID 1 qui récolte les zombies.
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-liberation util-linux tini ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && userdel -r node \
 && groupadd -g "${GID}" grasp \
 && useradd -u "${UID}" -g grasp -m -d /home/grasp -s /bin/bash grasp \
 && install -d -m 0700 -o grasp -g grasp /data /data/config /data/state /data/share /run/grasp

WORKDIR /opt/grasp
COPY --from=build /src/package.json ./
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/dist/src ./dist/src
# Scénario de bout en bout et son site de test (≈ 30 ko) : `docker run … --entrypoint bash grasp examples/e2e.sh`.
COPY --from=build /src/dist/test/helpers/testsite.js ./dist/test/helpers/
COPY examples ./examples
RUN chmod 0755 dist/src/cli/main.js && ln -s /opt/grasp/dist/src/cli/main.js /usr/local/bin/grasp

# XDG : config + token, état (logs, captures), profils dans le volume /data ; socket dans /run/grasp
# (montable séparément pour l'exposer à l'hôte).
ENV XDG_CONFIG_HOME=/data/config \
    XDG_STATE_HOME=/data/state \
    XDG_DATA_HOME=/data/share \
    XDG_RUNTIME_DIR=/run/grasp \
    GRASP_CHROME=/usr/bin/chromium
VOLUME ["/data"]

USER grasp
ENTRYPOINT ["/usr/bin/tini", "-s", "--", "grasp"]
CMD ["serve"]
