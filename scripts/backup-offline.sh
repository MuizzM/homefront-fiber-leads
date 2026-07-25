#!/usr/bin/env bash
# ── Scheduled offline DB backup (NOT part of a release) ──────────────────────
# Releases used to take this snapshot inside their cutover window: stop the
# healthy container, checkpoint, compress ~7GB, then start the replacement.
# Measured cost was a multi-minute hard outage on every deploy. The snapshot
# itself is still worth having, so it runs here on a schedule at a quiet hour
# instead of in the path of every release.
#
# Cron (as the deploy user), 03:20 daily:
#   20 3 * * * cd /srv/homefront && ./scripts/backup-offline.sh >> /srv/homefront/.backup-cron.log 2>&1
set -euo pipefail
cd "$(dirname "$0")/.."

COMPOSE=(docker compose -f docker-compose.production.yml)
TAG="$(cat .deployed-tag 2>/dev/null || true)"
[[ "$TAG" =~ ^[0-9a-f]{7,40}$ ]] || { echo "[backup-offline] no valid .deployed-tag" >&2; exit 1; }

# Never collide with a release: the deploy holds the same lock.
exec 9>.deploy.lock
if ! flock -n 9; then
  echo "[backup-offline] a deploy is running — skipping this window" >&2
  exit 0
fi

if [ -z "${AGE_RECIPIENT:-}" ] && [ -r .backup-age-recipient ]; then
  IFS= read -r AGE_RECIPIENT < .backup-age-recipient
  export AGE_RECIPIENT
fi
[ -n "${AGE_RECIPIENT:-}" ] || { echo "[backup-offline] AGE_RECIPIENT not configured" >&2; exit 1; }

APP_CONTAINER="$(APP_IMAGE_TAG="$TAG" "${COMPOSE[@]}" ps -q app)"
[ -n "$APP_CONTAINER" ] || { echo "[backup-offline] app not running" >&2; exit 1; }
mapfile -t DATA_MOUNTS < <(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{printf "%s|%s" .Type .Name}}{{end}}{{end}}' "$APP_CONTAINER")
IFS='|' read -r _TYPE VOLUME <<< "${DATA_MOUNTS[0]}"
[ -n "$VOLUME" ] || { echo "[backup-offline] could not resolve the /data volume" >&2; exit 1; }

BACKUP_TOOL_IMAGE="homefront-backup:$TAG"
docker image inspect "$BACKUP_TOOL_IMAGE" >/dev/null 2>&1 || docker build --file Dockerfile.backup --tag "$BACKUP_TOOL_IMAGE" .

restore_app() { APP_IMAGE_TAG="$TAG" "${COMPOSE[@]}" up -d app >/dev/null 2>&1 || true; }
trap restore_app EXIT

echo "[backup-offline] $(date -u +%FT%TZ) stopping app for a consistent snapshot…"
timeout 120 env APP_IMAGE_TAG="$TAG" "${COMPOSE[@]}" stop app
timeout 600 docker run --rm --entrypoint node -v "$VOLUME:/data" "homefront-app:$TAG" -e '
  const d = require("better-sqlite3")("/data/data.db");
  d.pragma("busy_timeout = 60000");
  console.log("[backup-offline] checkpoint:", JSON.stringify(d.pragma("wal_checkpoint(TRUNCATE)")));
  d.close();
'
BACKUP_QUIESCENT=1 BACKUP_VOLUME="$VOLUME" BACKUP_TOOL_IMAGE="$BACKUP_TOOL_IMAGE" timeout 1800 scripts/backup.sh
restore_app
trap - EXIT

# Prove the app came back — a backup that leaves the portal down is a failure.
for _ in $(seq 1 40); do
  if [ "$(docker inspect --format '{{.State.Health.Status}}' "$(APP_IMAGE_TAG="$TAG" "${COMPOSE[@]}" ps -q app)" 2>/dev/null)" = "healthy" ]; then
    echo "[backup-offline] done — app healthy again"; exit 0
  fi
  sleep 3
done
echo "[backup-offline] WARNING: app did not report healthy after the snapshot" >&2
exit 1
