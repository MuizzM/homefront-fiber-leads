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

# ── Retention + space guard ─────────────────────────────────────────────────
# The volume that holds backups is finite; without a prune this script filled
# it and every deploy died at the pre-deploy backup (and a shared volume takes
# the live DB down with it). Two guards, both BEFORE we write anything:
#  1) age-based retention (default 14 days, KEEP_MIN newest always survive)
#  2) space guard — if free space < 3x the DB size, delete oldest backups
#     until there is room (or only KEEP_MIN remain).
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
KEEP_MIN="${BACKUP_KEEP_MIN:-5}"

# Newest-first list of existing backups (epoch mtime + path, sorted).
backups_newest_first() {
  find "$BACKUP_DIR" -maxdepth 1 -name 'data-*.db.age' -printf '%T@ %p\n' 2>/dev/null \
    | sort -rn | cut -d' ' -f2-
}

# Age prune (the newest KEEP_MIN are immune even if older than the window).
if [ "$RETENTION_DAYS" -gt 0 ] 2>/dev/null; then
  idx=0
  while IFS= read -r f; do
    idx=$((idx + 1))
    [ "$idx" -le "$KEEP_MIN" ] && continue
    if [ -n "$(find "$f" -mtime "+$((RETENTION_DAYS - 1))" 2>/dev/null)" ]; then
      rm -f "$f" && echo "[backup] pruned (age): $f"
    fi
  done < <(backups_newest_first)
fi

# Count cap — deploys back up several times a day at ~GB scale, so an age
# window alone still accumulates days × deploys × size (observed: 28 backups,
# 21GB, 87% disk). Keep the newest KEEP_MAX regardless of age.
KEEP_MAX="${BACKUP_KEEP_MAX:-6}"
if [ "$KEEP_MAX" -gt 0 ] 2>/dev/null; then
  idx=0
  while IFS= read -r f; do
    idx=$((idx + 1))
    [ "$idx" -le "$KEEP_MAX" ] && continue
    rm -f "$f" && echo "[backup] pruned (count>$KEEP_MAX): $f"
  done < <(backups_newest_first)
fi

# Space guard — need ~3x DB size free (raw snapshot + encrypted copy + slack).
DB_KB=$(du -k "$DB_PATH" | cut -f1)
NEED_KB=$((DB_KB * 3 + 65536))
while :; do
  FREE_KB=$(df -k --output=avail "$BACKUP_DIR" | tail -1 | tr -d ' ')
  [ "$FREE_KB" -ge "$NEED_KB" ] && break
  OLDEST=$(backups_newest_first | tail -1 || true)
  COUNT=$(backups_newest_first | wc -l || echo 0)
  if [ -z "$OLDEST" ] || [ "$COUNT" -le "$KEEP_MIN" ]; then
    echo "[backup] WARNING: low disk (${FREE_KB}KB free, want ${NEED_KB}KB) but only $COUNT backups left — continuing" >&2
    break
  fi
  rm -f "$OLDEST" && echo "[backup] pruned (space): $OLDEST"
done

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
