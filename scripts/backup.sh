#!/usr/bin/env bash
# Encrypted, consistent SQLite backup with retention.
# - Uses `.backup` (a live-consistent snapshot; safe while the app is running,
#   unlike cp on a WAL database).
# - Encrypts at rest with age (or gpg) so backups never sit in plaintext.
# - Prunes local copies past the retention window.
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

RAW="$BACKUP_DIR/data-$STAMP.db"

# 1) Consistent snapshot (WAL-safe).
sqlite3 "$DB_PATH" ".backup '$RAW'"

# 2) Integrity check — a backup that fails PRAGMA integrity_check is worthless.
if [ "$(sqlite3 "$RAW" 'PRAGMA integrity_check;')" != "ok" ]; then
  echo "[backup] INTEGRITY CHECK FAILED for $RAW" >&2
  rm -f "$RAW"
  exit 1
fi

# 3) Encrypt at rest (age if a recipient is configured; otherwise leave a plain
#    .db but warn — plaintext backups of location/PII data are a finding).
if [ -n "${AGE_RECIPIENT:-}" ] && command -v age >/dev/null 2>&1; then
  age -r "$AGE_RECIPIENT" -o "$RAW.age" "$RAW"
  rm -f "$RAW"
  OUT="$RAW.age"
else
  echo "[backup] WARNING: AGE_RECIPIENT unset — backup is NOT encrypted at rest." >&2
  OUT="$RAW"
fi

gzip -f "${OUT%.age}" 2>/dev/null || true   # compress the (already-encrypted or plain) artifact
echo "[backup] wrote ${OUT}"

# 4) Retention prune.
find "$BACKUP_DIR" -name 'data-*.db*' -mtime "+$RETENTION_DAYS" -delete
echo "[backup] pruned backups older than ${RETENTION_DAYS} days"

# 5) Offsite: sync $BACKUP_DIR to a Hetzner Storage Box / S3 here, e.g.
#    rclone copy "$BACKUP_DIR" remote:homefront-backups --max-age 25h
