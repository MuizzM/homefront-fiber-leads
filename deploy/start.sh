#!/bin/sh
# ── Production entrypoint ─────────────────────────────────────────────────────
# With Litestream configured (LITESTREAM_BUCKET set): restore data.db from the
# replica if the disk is empty (fresh volume / disaster recovery), then run the
# app UNDER litestream so every SQLite change streams to object storage.
# Without it: run the app directly — backups off is loud in the logs, never silent.
set -e

: "${DATA_DIR:=/data}"
mkdir -p "$DATA_DIR"

if [ -n "$LITESTREAM_BUCKET" ]; then
  echo "[start] Litestream enabled → bucket: $LITESTREAM_BUCKET"
  litestream restore -if-db-not-exists -if-replica-exists \
    -config /app/deploy/litestream.yml "$DATA_DIR/data.db"
  exec litestream replicate -config /app/deploy/litestream.yml
else
  echo "[start] WARNING: LITESTREAM_BUCKET not set — running WITHOUT continuous DB backup"
  exec node dist/index.cjs
fi
