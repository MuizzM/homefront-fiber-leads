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

  # ── QUIESCENT MODE (deploy window) ─────────────────────────────────────────
  # The caller has STOPPED the app and WAL-checkpointed data.db, so the file is
  # self-contained and nothing writes. Stream it straight from the :ro volume
  # (quick_check → zstd|age inside the tool). No online-vacuum snapshot, no
  # docker exec into a live app, and only ~DB/3 of transient disk — this is
  # what fits on the 38GB production box. The online path below stays for
  # cron/ad-hoc use while the app is live.
  if [ "${BACKUP_QUIESCENT:-}" = "1" ]; then
    # Quiescent means QUIESCENT: a live app would make the plain-file stream a
    # torn copy. Refuse unless the compose app container is verifiably stopped.
    APP_CONTAINER_NAME="${APP_CONTAINER_NAME:-homefront-app-1}"
    if [ "$(docker inspect --format '{{.State.Running}}' "$APP_CONTAINER_NAME" 2>/dev/null || echo false)" = "true" ]; then
      echo "[backup] refusing: BACKUP_QUIESCENT=1 but $APP_CONTAINER_NAME is RUNNING — stop the app first (deploy.sh does this)" >&2
      exit 1
    fi
    docker run --rm \
      --read-only \
      --network none \
      --cap-drop ALL \
      --security-opt no-new-privileges \
      --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
      --user "$(id -u):$(id -g)" \
      -e AGE_RECIPIENT \
      -e BACKUP_STAMP="$STAMP" \
      -e BACKUP_QUIESCENT=1 \
      -e DB_PATH=/data/data.db \
      -v "$BACKUP_VOLUME:/data:ro" \
      -v "$BACKUP_DIR_ABS:/backups" \
      "$BACKUP_TOOL_IMAGE"
    OUT="$BACKUP_DIR/data-$STAMP.db.zst.age"
    [ -s "$OUT" ] || { echo "[backup] output artifact is missing or empty" >&2; exit 1; }
    echo "[backup] wrote $OUT"
    exit 0
  fi

  # The scanner writes continuously, so a read-only open of the LIVE db races its
  # dirty WAL ("attempt to write a readonly database") — checkpoint+retry lost that
  # race 4/4 times under real load. Instead: take an ONLINE snapshot THROUGH the
  # live app, then point the locked-down tool container at the quiescent snapshot
  # (it honors DB_PATH). The snapshot is self-contained with no WAL, so the :ro
  # mount is always safe.
  APP_CONTAINER_NAME="${APP_CONTAINER_NAME:-homefront-app-1}"
  SNAP="/data/backup-snapshot.db"
  cleanup_snapshot() { docker exec "$APP_CONTAINER_NAME" rm -f "$SNAP" "$SNAP-wal" "$SNAP-shm" >/dev/null 2>&1 || true; }
  trap cleanup_snapshot EXIT
  echo "[backup] online snapshot via live app (VACUUM INTO)…"
  # VACUUM INTO reads ONE consistent MVCC snapshot under WAL: it never blocks the
  # writers and — unlike the backup API from a separate connection, which RESTARTS
  # on every external write and livelocks under our constant scan writes (observed:
  # 5-minute hang) — it completes in a single pass. But under heavy continuous scan
  # writes it can still fail transiently (observed live: "database does not exist:
  # backup-snapshot.db" — the VACUUM aborted and left no file), which blocked deploys.
  # So: RETRY on transient failure (busy_timeout rides out write contention), and
  # VERIFY the snapshot exists + is non-empty + passes a quick integrity check before
  # we encrypt it. Only a verified snapshot proceeds.
  BACKUP_SNAP_TRIES="${BACKUP_SNAP_TRIES:-4}"
  SNAP_OK=0
  for attempt in $(seq 1 "$BACKUP_SNAP_TRIES"); do
    cleanup_snapshot
    if docker exec -e SNAP="$SNAP" "$APP_CONTAINER_NAME" timeout 300 node -e '
      const Database = require("better-sqlite3");
      const d = new Database("/data/data.db", { readonly: true });
      try { d.pragma("busy_timeout = 30000"); d.exec("VACUUM INTO \x27" + process.env.SNAP + "\x27"); }
      finally { d.close(); }
    '; then
      if docker exec -e SNAP="$SNAP" "$APP_CONTAINER_NAME" node -e '
        const fs = require("fs");
        const p = process.env.SNAP;
        if (!fs.existsSync(p) || fs.statSync(p).size < 65536) process.exit(3);
        const Database = require("better-sqlite3");
        const d = new Database(p, { readonly: true });
        const ok = d.pragma("quick_check", { simple: true });
        d.close();
        process.exit(ok === "ok" ? 0 : 4);
      '; then SNAP_OK=1; break; fi
    fi
    echo "[backup] snapshot attempt $attempt/$BACKUP_SNAP_TRIES failed; retrying in 5s…" >&2
    sleep 5
  done
  [ "$SNAP_OK" -eq 1 ] || { echo "[backup] online snapshot failed after $BACKUP_SNAP_TRIES attempts" >&2; exit 1; }
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
  # Retention is owned by backup-container.sh (age prune with a KEEP_MIN floor,
  # KEEP_MAX count cap, space guard). The host-side find-delete that used to
  # run here had NO floor: after a >14-day deploy pause it would have wiped
  # every preserved generation down to a single file.
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
