#!/usr/bin/env bash
# Encrypted, consistent SQLite backup with retention.
# Production uses a locked-down helper container so the deploy user never needs
# direct access to Docker's private volume directory. Local/cron use can still
# provide DB_PATH and use host sqlite3 + age.
# Run from cron (see INFRASTRUCTURE.md). Offsite sync is a separate step.
#
# Env:
#   DB_PATH           default ./data.db
#   BACKUP_DIR        default ./backups
#   BACKUP_RETENTION_DAYS  default 14
#   AGE_RECIPIENT     if set, encrypt to this age public key (recommended)
set -euo pipefail

DB_PATH="${DB_PATH:-./data.db}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"

if [ -n "${BACKUP_VOLUME:-}" ]; then
  : "${BACKUP_TOOL_IMAGE:?BACKUP_TOOL_IMAGE is required with BACKUP_VOLUME}"
  : "${AGE_RECIPIENT:?AGE_RECIPIENT is required for production volume backups}"
  [[ "$BACKUP_VOLUME" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || {
    echo "[backup] invalid Docker volume name" >&2
    exit 1
  }
  docker volume inspect "$BACKUP_VOLUME" >/dev/null
  docker image inspect "$BACKUP_TOOL_IMAGE" >/dev/null

  BACKUP_DIR_ABS="$(cd "$BACKUP_DIR" && pwd -P)"
  # The scanner writes continuously, so a read-only open of the LIVE db races its
  # dirty WAL ("attempt to write a readonly database") — checkpoint+retry lost that
  # race 4/4 times under real load. Instead: take an ONLINE snapshot THROUGH the
  # live app (SQLite backup API — correct under concurrent writers), then point the
  # locked-down tool container at the quiescent snapshot (it honors DB_PATH). The
  # snapshot is self-contained with an empty WAL, so the :ro mount is always safe.
  APP_CONTAINER_NAME="${APP_CONTAINER_NAME:-homefront-app-1}"
  SNAP="/data/backup-snapshot.db"
  cleanup_snapshot() { docker exec "$APP_CONTAINER_NAME" rm -f "$SNAP" "$SNAP-wal" "$SNAP-shm" >/dev/null 2>&1 || true; }
  trap cleanup_snapshot EXIT
  echo "[backup] online snapshot via live app…"
  docker exec "$APP_CONTAINER_NAME" node -e '
    const Database = require("better-sqlite3");
    const d = new Database("/data/data.db", { readonly: true });
    d.backup("'"$SNAP"'").then(() => { d.close(); process.exit(0); })
      .catch((e) => { console.error("snapshot failed:", e.message); process.exit(1); });
  ' || { echo "[backup] online snapshot failed" >&2; exit 1; }
  docker run --rm \
    --read-only \
    --network none \
    --cap-drop ALL \
    --security-opt no-new-privileges \
    --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
    --user "$(id -u):$(id -g)" \
    -e AGE_RECIPIENT \
    -e BACKUP_STAMP="$STAMP" \
    -e DB_PATH="$SNAP" \
    -v "$BACKUP_VOLUME:/data:ro" \
    -v "$BACKUP_DIR_ABS:/backups" \
    "$BACKUP_TOOL_IMAGE"
  cleanup_snapshot
  trap - EXIT

  OUT="$BACKUP_DIR/data-$STAMP.db.age"
  [ -s "$OUT" ] || { echo "[backup] output artifact is missing or empty" >&2; exit 1; }
  find "$BACKUP_DIR" -name 'data-*.db.age' -mtime "+$RETENTION_DAYS" -delete
  echo "[backup] pruned backups older than ${RETENTION_DAYS} days"
  exit 0
fi

command -v sqlite3 >/dev/null 2>&1 || { echo "[backup] sqlite3 is required" >&2; exit 1; }
[ -f "$DB_PATH" ] || { echo "[backup] database does not exist: $DB_PATH" >&2; exit 1; }
[ -r "$DB_PATH" ] || { echo "[backup] database is not readable: $DB_PATH" >&2; exit 1; }

RAW="$BACKUP_DIR/data-$STAMP.db"
cleanup_partial_backup() {
  local status="$1"
  trap - EXIT
  if [ "$status" -ne 0 ]; then
    rm -f "$RAW" "$RAW.age" "$RAW.gz"
  fi
  exit "$status"
}
trap 'cleanup_partial_backup "$?"' EXIT

# 1) Consistent snapshot (WAL-safe).
sqlite3 "$DB_PATH" ".backup '$RAW'"

# 2) Integrity check — a backup that fails PRAGMA integrity_check is worthless.
if [ "$(sqlite3 "$RAW" 'PRAGMA integrity_check;')" != "ok" ]; then
  echo "[backup] INTEGRITY CHECK FAILED for $RAW" >&2
  rm -f "$RAW"
  exit 1
fi

# 3) Encrypt at rest (age if a recipient is configured; otherwise leave a plain
#    .db but warn for non-production/manual use).
if [ -n "${AGE_RECIPIENT:-}" ]; then
  command -v age >/dev/null 2>&1 || { echo "[backup] AGE_RECIPIENT is set but age is unavailable" >&2; rm -f "$RAW"; exit 1; }
  age -r "$AGE_RECIPIENT" -o "$RAW.age" "$RAW"
  rm -f "$RAW"
  OUT="$RAW.age"
else
  echo "[backup] WARNING: AGE_RECIPIENT unset — backup is NOT encrypted at rest." >&2
  gzip -f "$RAW"
  OUT="$RAW.gz"
fi

[ -s "$OUT" ] || { echo "[backup] output artifact is missing or empty" >&2; exit 1; }
echo "[backup] wrote ${OUT}"

# 4) Retention prune.
find "$BACKUP_DIR" -name 'data-*.db*' -mtime "+$RETENTION_DAYS" -delete
echo "[backup] pruned backups older than ${RETENTION_DAYS} days"
trap - EXIT

# 5) Offsite: sync $BACKUP_DIR to a Hetzner Storage Box / S3 here, e.g.
#    rclone copy "$BACKUP_DIR" remote:homefront-backups --max-age 25h
