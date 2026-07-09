#!/usr/bin/env bash
# Restore-and-VERIFY a backup. Never assume a backup works — this restores into a
# scratch copy, runs an integrity check + a couple of sanity queries, and only
# then (with --apply) swaps it into place after stopping the service.
#
# Usage:
#   scripts/restore.sh backups/data-20260709T050000Z.db.age            # verify only
#   scripts/restore.sh backups/data-20260709T050000Z.db.age --apply    # verify + go live
set -euo pipefail

SRC="${1:?usage: restore.sh <backup-file> [--apply]}"
APPLY="${2:-}"
DB_PATH="${DB_PATH:-./data.db}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

CAND="$WORK/candidate.db"

# 1) Decrypt / decompress into the scratch candidate.
tmp="$SRC"
case "$SRC" in
  *.gz)  gunzip -c "$SRC" > "$WORK/stage"; tmp="$WORK/stage" ;;
esac
case "$tmp" in
  *.age) age -d -o "$CAND" "$tmp" ;;   # needs AGE key in the agent/identity file
  *)     cp "$tmp" "$CAND" ;;
esac

# 2) Verify BEFORE touching production.
[ "$(sqlite3 "$CAND" 'PRAGMA integrity_check;')" = "ok" ] || { echo "[restore] integrity FAILED" >&2; exit 1; }
USERS="$(sqlite3 "$CAND" 'SELECT COUNT(*) FROM users;')"
LEADS="$(sqlite3 "$CAND" 'SELECT COUNT(*) FROM leads;')"
KNOCKS="$(sqlite3 "$CAND" 'SELECT COUNT(*) FROM knock_log;')"
echo "[restore] candidate OK — users=$USERS leads=$LEADS knocks=$KNOCKS"
[ "$USERS" -ge 1 ] || { echo "[restore] refusing: zero users (likely wrong/empty backup)" >&2; exit 1; }

if [ "$APPLY" != "--apply" ]; then
  echo "[restore] verify-only. Re-run with --apply to go live."
  exit 0
fi

# 3) Apply: stop app, back up the current file, swap, restart, health-check.
sudo systemctl stop homefront || true
cp "$DB_PATH" "$DB_PATH.pre-restore-$(date -u +%Y%m%dT%H%M%SZ)" 2>/dev/null || true
cp "$CAND" "$DB_PATH"
sudo systemctl start homefront || true
sleep 2
curl -fsS "http://127.0.0.1:${PORT:-5000}/api/health" | grep -q '"ok":true' \
  && echo "[restore] LIVE and healthy" \
  || { echo "[restore] health check FAILED after restore" >&2; exit 1; }
