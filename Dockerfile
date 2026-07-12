# ── HomeFront portal — production image (Railway) ────────────────────────────
# Two stages: build the client+server bundle, then a slim runtime with prod deps
# and the Litestream binary for continuous SQLite backup to object storage.
#
# Runtime contract:
#   PORT       — injected by Railway (app listens on it; default 5000)
#   DATA_DIR   — persistent volume mount for data.db + uploads/ (set to /data)
#   LITESTREAM_BUCKET/ENDPOINT/ACCESS_KEY_ID/SECRET_ACCESS_KEY — enable backups;
#                without them the app still runs (start.sh warns loudly).

FROM node:20-bookworm-slim AS build
WORKDIR /app
# better-sqlite3 is a native addon — toolchain needed if no prebuilt binary matches.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Litestream — streams every SQLite change to B2/R2 (see deploy/litestream.yml).
COPY --from=litestream/litestream:0.3.13 /usr/local/bin/litestream /usr/local/bin/litestream

COPY package*.json ./
# Prod deps only; better-sqlite3 recompiles here against the runtime Node.
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY deploy ./deploy
RUN chmod +x deploy/start.sh && mkdir -p /data

# Run as the base image's non-root `node` user (uid 1000). start.sh needs no root
# (mkdir + exec only), and the /data volume is owned by 1000 — so a container
# breakout via an app RCE lands as an unprivileged user, not root.
RUN chown -R node:node /app /data
USER node

ENV NODE_ENV=production
ENV DATA_DIR=/data
EXPOSE 5000

# start.sh: restore-from-replica if the volume is empty, then run the app under
# Litestream replication (or plain node when backups aren't configured yet).
ENTRYPOINT ["./deploy/start.sh"]
