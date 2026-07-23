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
# Sized to the ACTUAL artifact: the DB is ~5GB compacted, so each encrypted
# backup is ~5GB on a 38GB disk. The old defaults (keep 5-6) reserved up to 30GB
# and refilled the disk within a few deploys — which is what made backups fail and
# blocked deploys. Keep 3 generations (~15GB worst case) and let the space guard
# fall back to 1 when the disk is genuinely tight.
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-7}"
KEEP_MIN="${BACKUP_KEEP_MIN:-1}"

# Newest-first list of existing backups (epoch mtime + path, sorted).
# Matches both artifact generations: data-*.db.age (legacy online snapshot)
# and data-*.db.zst.age (quiescent compressed stream).
backups_newest_first() {
  find "$BACKUP_DIR" -maxdepth 1 -name 'data-*.db*.age' -printf '%T@ %p\n' 2>/dev/null \
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
KEEP_MAX="${BACKUP_KEEP_MAX:-3}"
if [ "$KEEP_MAX" -gt 0 ] 2>/dev/null; then
  idx=0
  while IFS= read -r f; do
    idx=$((idx + 1))
    [ "$idx" -le "$KEEP_MAX" ] && continue
    rm -f "$f" && echo "[backup] pruned (count>$KEEP_MAX): $f"
  done < <(backups_newest_first)
fi

# Space guard. Legacy online mode writes a raw snapshot + encrypted copy, so it
# needs ~3x the DB. Quiescent mode streams zstd|age (one artifact, SQLite
# compresses ~3x), so DB/2 + slack is already conservative.
DB_KB=$(du -k "$DB_PATH" | cut -f1)
if [ "${BACKUP_QUIESCENT:-}" = "1" ]; then
  NEED_KB=$((DB_KB / 2 + 65536))
else
  NEED_KB=$((DB_KB * 3 + 65536))
fi
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

# ── QUIESCENT MODE (deploy window) ──────────────────────────────────────────
# The app is stopped and data.db is WAL-checkpointed (self-contained), so we
# verify the REAL file and stream it out compressed+encrypted in one pass —
# no raw copy on disk. immutable=1 is required: data.db is in WAL journal mode
# and lives on a :ro mount, so a normal open would fail trying to create the
# -shm file; immutable tells SQLite nothing can change (true: zero writers).
if [ "${BACKUP_QUIESCENT:-}" = "1" ]; then
  command -v zstd >/dev/null 2>&1 || { echo "[backup] zstd is required for quiescent backups" >&2; exit 1; }
  # The stream is a plain file copy, only valid when the WAL was fully
  # checkpoint-TRUNCATEd. A non-empty -wal file means the DB is NOT quiescent
  # (checkpoint failed or something is still writing) — refuse rather than
  # emit an artifact missing committed transactions.
  if [ -s "$DB_PATH-wal" ]; then
    echo "[backup] refusing: $DB_PATH-wal is non-empty ($(du -h "$DB_PATH-wal" | cut -f1)) — database is not quiescent" >&2
    exit 1
  fi
  if [ "$(sqlite3 "file:$DB_PATH?immutable=1" 'PRAGMA quick_check;')" != "ok" ]; then
    echo "[backup] quick_check FAILED on quiescent database" >&2
    exit 1
  fi
  # Write-then-rename: a hard-killed stream must never leave a truncated file
  # matching the backup name pattern — retention would protect the corpse as
  # the "newest backup" and restore could pick it. Stale .part files from any
  # earlier kill are swept first (they match no retention/restore pattern).
  rm -f "$BACKUP_DIR"/data-*.part
  OUT="$BACKUP_DIR/data-$STAMP.db.zst.age"
  if ! zstd -3 -T0 -c "$DB_PATH" | age -r "$AGE_RECIPIENT" -o "$OUT.part"; then
    rm -f "$OUT.part"
    echo "[backup] quiescent stream failed" >&2
    exit 1
  fi
  [ -s "$OUT.part" ] || { echo "[backup] encrypted backup is missing or empty" >&2; rm -f "$OUT.part"; exit 1; }
  mv "$OUT.part" "$OUT"
  echo "[backup] wrote $OUT"
  exit 0
fi

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
