# ── HomeFront portal — production image (Railway) ────────────────────────────
# Two stages: build the client+server bundle, then a slim runtime with prod deps
# and the Litestream binary for continuous SQLite backup to object storage.
#
# Runtime contract:
#   PORT       — injected by Railway (app listens on it; default 5000)
#   DATA_DIR   — persistent volume mount for data.db + uploads/ (set to /data)
#   LITESTREAM_BUCKET/ENDPOINT/ACCESS_KEY_ID/SECRET_ACCESS_KEY — enable backups;
#                without them the app still runs (start.sh warns loudly).

FROM node:24.20.0-bookworm-slim AS build
WORKDIR /app
# Keep the build toolchain for dependencies that compile native addons.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24.20.0-bookworm-slim AS runtime
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Litestream — streams every SQLite change to B2/R2 (see deploy/litestream.yml).
COPY --from=litestream/litestream:0.3.13 /usr/local/bin/litestream /usr/local/bin/litestream

# curl-impersonate-chrome — Chrome's exact TLS fingerprint for the token mint
# (Cloudflare JA3 crack; see server/curlMint.ts). Static-patched libcurl,
# needs only glibc + ca-certificates which the runtime already has.
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
  && curl -fsSL -o /tmp/curl-imp.tar.gz \
     "https://github.com/lwthiker/curl-impersonate/releases/download/v0.6.1/curl-impersonate-v0.6.1.x86_64-linux-gnu.tar.gz" \
  && tar -xzf /tmp/curl-imp.tar.gz -C /usr/local/bin curl-impersonate-chrome \
  && chmod +x /usr/local/bin/curl-impersonate-chrome \
  && rm -f /tmp/curl-imp.tar.gz \
  && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
# Prod deps only. better-sqlite3 13 ships Node-API binaries; npm ci alone does
# not load them. CI runs the native/backup smoke inside this exact runtime image.
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY script/runtime-smoke.cjs ./script/runtime-smoke.cjs
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
