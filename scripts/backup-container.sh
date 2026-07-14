#!/usr/bin/env bash
set -euo pipefail

DB_PATH="${DB_PATH:-/data/data.db}"
BACKUP_DIR="${BACKUP_DIR:-/backups}"
STAMP="${BACKUP_STAMP:?BACKUP_STAMP is required}"
AGE_RECIPIENT="${AGE_RECIPIENT:?AGE_RECIPIENT is required}"

[[ "$STAMP" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || {
  echo "[backup] invalid backup timestamp" >&2
  exit 1
}
[ -f "$DB_PATH" ] || { echo "[backup] database does not exist: $DB_PATH" >&2; exit 1; }
[ -r "$DB_PATH" ] || { echo "[backup] database is not readable: $DB_PATH" >&2; exit 1; }
[ -d "$BACKUP_DIR" ] || { echo "[backup] backup directory does not exist: $BACKUP_DIR" >&2; exit 1; }
[ -w "$BACKUP_DIR" ] || { echo "[backup] backup directory is not writable: $BACKUP_DIR" >&2; exit 1; }

RAW="$BACKUP_DIR/data-$STAMP.db"
OUT="$RAW.age"
cleanup() {
  local status="$1"
  trap - EXIT
  rm -f "$RAW"
  if [ "$status" -ne 0 ]; then
    rm -f "$OUT"
  fi
  exit "$status"
}
trap 'cleanup "$?"' EXIT

# SQLite's online backup API is WAL-safe while the application remains live.
sqlite3 "$DB_PATH" ".backup '$RAW'"
if [ "$(sqlite3 "$RAW" 'PRAGMA integrity_check;')" != "ok" ]; then
  echo "[backup] integrity check failed" >&2
  exit 1
fi

age -r "$AGE_RECIPIENT" -o "$OUT" "$RAW"
[ -s "$OUT" ] || { echo "[backup] encrypted backup is missing or empty" >&2; exit 1; }
echo "[backup] wrote $OUT"
trap - EXIT
rm -f "$RAW"
