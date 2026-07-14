#!/usr/bin/env bash
# Restore-and-VERIFY a backup for the Docker Compose production stack. The
# candidate is verified before the app is stopped. --apply swaps the database
# only while the app is down, then requires a healthy container; a failed
# restore automatically puts the pre-restore database back and health-checks it.
#
# Usage:
#   scripts/restore.sh backups/data-20260709T050000Z.db.age
#   scripts/restore.sh backups/data-20260709T050000Z.db.age --apply
set -euo pipefail

SRC="${1:?usage: restore.sh <backup-file> [--apply]}"
APPLY="${2:-}"
if [ -n "${3:-}" ] || { [ -n "$APPLY" ] && [ "$APPLY" != "--apply" ]; }; then
  echo "usage: restore.sh <backup-file> [--apply]" >&2
  exit 2
fi
[ -f "$SRC" ] || { echo "[restore] backup not found: $SRC" >&2; exit 1; }

case "$SRC" in
  /*) ;;
  *) SRC="$(cd "$(dirname "$SRC")" && pwd -P)/$(basename "$SRC")" ;;
esac

cd "$(dirname "$0")/.."
COMPOSE=(docker compose -f docker-compose.production.yml)
WORK="$(mktemp -d)"
CAND="$WORK/candidate.db"
APP_CONTAINER=""
RUNNING_TAG=""
PRODUCTION_DB=""
PRE_RESTORE=""
APP_STOPPED=0
DB_REPLACED=0
RESTORE_COMMITTED=0

health_check() {
  local attempt
  for attempt in $(seq 1 20); do
    if APP_IMAGE_TAG="$RUNNING_TAG" "${COMPOSE[@]}" exec -T app \
      node -e "fetch('http://127.0.0.1:5000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
      2>/dev/null; then
      return 0
    fi
    sleep 3
  done
  return 1
}

cleanup() {
  local status="$1"
  trap - EXIT
  if [ "$RESTORE_COMMITTED" != "1" ] && [ "$DB_REPLACED" = "1" ] && [ -f "$PRE_RESTORE" ]; then
    echo "[restore] restore did not complete; recovering the pre-restore database" >&2
    APP_STOPPED=1
    if APP_IMAGE_TAG="$RUNNING_TAG" "${COMPOSE[@]}" stop app >/dev/null 2>&1; then
      if cp "$PRE_RESTORE" "$PRODUCTION_DB"; then
        rm -f "$PRODUCTION_DB-wal" "$PRODUCTION_DB-shm"
        DB_REPLACED=0
      else
        echo "[restore] CRITICAL: could not recover $PRODUCTION_DB from $PRE_RESTORE" >&2
      fi
    else
      APP_STOPPED=0
      echo "[restore] CRITICAL: app could not be stopped; database was not overwritten during recovery" >&2
    fi
  fi
  if [ "$APP_STOPPED" = "1" ] && [ -n "$RUNNING_TAG" ]; then
    if APP_IMAGE_TAG="$RUNNING_TAG" "${COMPOSE[@]}" up -d app >/dev/null 2>&1; then
      APP_STOPPED=0
      if ! health_check; then
        echo "[restore] CRITICAL: recovered app did not become healthy" >&2
      fi
    else
      echo "[restore] CRITICAL: could not restart the Compose app" >&2
    fi
  fi
  rm -rf "$WORK"
  exit "$status"
}
trap 'cleanup "$?"' EXIT

command -v sqlite3 >/dev/null 2>&1 || { echo "[restore] sqlite3 is required" >&2; exit 1; }

# 1) Decrypt and/or decompress into the scratch candidate. Both .db.age and
# .db.gz are emitted by backup.sh; .db.gz.age is accepted for older tooling.
PAYLOAD="$SRC"
LOGICAL_NAME="$SRC"
if [[ "$SRC" == *.age ]]; then
  command -v age >/dev/null 2>&1 || { echo "[restore] age is required for encrypted backups" >&2; exit 1; }
  PAYLOAD="$WORK/decrypted"
  age -d -o "$PAYLOAD" "$SRC"
  LOGICAL_NAME="${SRC%.age}"
fi
if [[ "$LOGICAL_NAME" == *.gz ]]; then
  gzip -dc "$PAYLOAD" > "$CAND"
else
  cp "$PAYLOAD" "$CAND"
fi

# 2) Verify BEFORE touching production.
[ -s "$CAND" ] || { echo "[restore] candidate is empty" >&2; exit 1; }
[ "$(sqlite3 "$CAND" 'PRAGMA integrity_check;')" = "ok" ] || { echo "[restore] integrity FAILED" >&2; exit 1; }
USERS="$(sqlite3 "$CAND" 'SELECT COUNT(*) FROM users;')"
LEADS="$(sqlite3 "$CAND" 'SELECT COUNT(*) FROM leads;')"
KNOCKS="$(sqlite3 "$CAND" 'SELECT COUNT(*) FROM knock_log;')"
echo "[restore] candidate OK — users=$USERS leads=$LEADS knocks=$KNOCKS"
[ "$USERS" -ge 1 ] || { echo "[restore] refusing: zero users (likely wrong/empty backup)" >&2; exit 1; }

if [ "$APPLY" != "--apply" ]; then
  echo "[restore] verify-only. Re-run with --apply to restore the Compose app."
  RESTORE_COMMITTED=1
  exit 0
fi

# 3) Identify the currently running service and its actual /data mount. The
# compose project, not a guessed Docker volume name, is authoritative.
RECORDED_TAG="$(cat .deployed-tag 2>/dev/null || true)"
APP_CONTAINER="$(APP_IMAGE_TAG="${RECORDED_TAG:-restore-inspect}" "${COMPOSE[@]}" ps -q app)"
if [ -z "$APP_CONTAINER" ] || [ "$(docker inspect --format '{{.State.Running}}' "$APP_CONTAINER" 2>/dev/null || true)" != "true" ]; then
  echo "[restore] refusing: production Compose app is not running" >&2
  exit 1
fi
RUNNING_IMAGE="$(docker inspect --format '{{.Config.Image}}' "$APP_CONTAINER")"
RUNNING_TAG="${RUNNING_IMAGE##*:}"
if [[ ! "$RUNNING_TAG" =~ ^[0-9a-f]{7,40}$ ]]; then
  echo "[restore] refusing: running app has no immutable image tag" >&2
  exit 1
fi
if [ -n "$RECORDED_TAG" ] && [ "$RECORDED_TAG" != "$RUNNING_TAG" ]; then
  echo "[restore] refusing: .deployed-tag differs from the running image" >&2
  exit 1
fi

DATA_MOUNT_SOURCE="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{println .Source}}{{end}}{{end}}' "$APP_CONTAINER")"
if [ -z "$DATA_MOUNT_SOURCE" ] || [[ "$DATA_MOUNT_SOURCE" == *$'\n'* ]] || [ ! -d "$DATA_MOUNT_SOURCE" ]; then
  echo "[restore] refusing: running app does not have exactly one inspectable /data mount" >&2
  exit 1
fi
PRODUCTION_DB="$DATA_MOUNT_SOURCE/data.db"
[ -f "$PRODUCTION_DB" ] || { echo "[restore] production database is missing" >&2; exit 1; }
[ -r "$PRODUCTION_DB" ] && [ -w "$PRODUCTION_DB" ] || { echo "[restore] production database is not readable/writable" >&2; exit 1; }

# 4) Stop Compose, preserve the exact current DB, swap, and health-gate.
APP_STOPPED=1
APP_IMAGE_TAG="$RUNNING_TAG" "${COMPOSE[@]}" stop app
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
PRE_RESTORE="$PRODUCTION_DB.pre-restore-$STAMP"
sqlite3 "$PRODUCTION_DB" ".backup '$PRE_RESTORE'"
[ "$(sqlite3 "$PRE_RESTORE" 'PRAGMA integrity_check;')" = "ok" ] || { echo "[restore] current production snapshot failed integrity check" >&2; exit 1; }

cp "$CAND" "$PRODUCTION_DB"
rm -f "$PRODUCTION_DB-wal" "$PRODUCTION_DB-shm"
DB_REPLACED=1
sync
APP_IMAGE_TAG="$RUNNING_TAG" "${COMPOSE[@]}" up -d app
APP_STOPPED=0

if health_check; then
  RESTORE_COMMITTED=1
  echo "[restore] LIVE and healthy; pre-restore copy retained at $PRE_RESTORE"
  exit 0
fi

echo "[restore] restored candidate failed health check; rolling data back" >&2
APP_STOPPED=1
APP_IMAGE_TAG="$RUNNING_TAG" "${COMPOSE[@]}" stop app
cp "$PRE_RESTORE" "$PRODUCTION_DB"
rm -f "$PRODUCTION_DB-wal" "$PRODUCTION_DB-shm"
DB_REPLACED=0
APP_IMAGE_TAG="$RUNNING_TAG" "${COMPOSE[@]}" up -d app
APP_STOPPED=0
if health_check; then
  echo "[restore] pre-restore database is healthy again; requested restore was not applied" >&2
else
  echo "[restore] CRITICAL: pre-restore database also failed its health check" >&2
fi
exit 1
