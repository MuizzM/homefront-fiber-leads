# ── HomeFront Fiber — production image ────────────────────────────────────────
# better-sqlite3 is a native addon, so build tools are needed to compile it.

FROM node:20-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
# Prod deps only; better-sqlite3 recompiles here against the runtime Node.
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

ENV NODE_ENV=production
ENV PORT=5000
EXPOSE 5000

# NOTE: the SQLite database (data.db*) and uploaded files (uploads/) are written
# to the working dir at runtime. Mount a PERSISTENT VOLUME at /app/data and set
# the app to use it, OR mount the volume over /app so data survives redeploys.
CMD ["node", "dist/index.cjs"]
