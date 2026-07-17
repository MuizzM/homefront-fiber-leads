#!/usr/bin/env bash
# ── Production deploy (Hetzner + Docker Compose) ─────────────────────────────
# - Immutable image tag = commit SHA (never :latest).
# - Pre-deploy DB backup (so a bad migration is recoverable).
# - Health-gated cutover; auto-rollback to the previous SHA if health fails.
# - Records the previous SHA for rollback.sh.
#
# Migrations: the app runs its migrations on boot. They are ADDITIVE ONLY
# (ALTER TABLE ADD COLUMN / CREATE ... IF NOT EXISTS) and idempotent, so boot-
# time application is safe. A DESTRUCTIVE change (drop/rename) is NOT automated —
# it requires the manual, approval-gated procedure in docs/INCIDENT_RUNBOOK.md.
#
# Usage:  scripts/deploy.sh [full-commit-sha] (defaults to current HEAD)
set -euo pipefail
cd "$(dirname "$0")/.."

COMPOSE=(docker compose -f docker-compose.production.yml)
NEW_TAG="${1:-$(git rev-parse HEAD)}"
RECORDED_TAG="$(cat .deployed-tag 2>/dev/null || true)"

if [[ ! "$NEW_TAG" =~ ^[0-9a-f]{40}$ ]]; then
  echo "[deploy] refusing: target must be a full, lowercase 40-character commit SHA" >&2
  exit 1
fi
if [ "$(git rev-parse HEAD)" != "$NEW_TAG" ]; then
  echo "[deploy] refusing: checked-out HEAD does not match target $NEW_TAG" >&2
  exit 1
fi
if [ -n "$(git status --porcelain --untracked-files=all)" ]; then
  echo "[deploy] refusing: production checkout is not clean" >&2
  git status --short >&2
  exit 1
fi

# Resolve the app belonging to THIS Compose project, then inspect its actual
# /data mount. A hard-coded Docker volume name can silently point at a stale or
# different project and produce a useless backup.
APP_CONTAINER="$(APP_IMAGE_TAG="${RECORDED_TAG:-$NEW_TAG}" "${COMPOSE[@]}" ps -q app)"
if [ -z "$APP_CONTAINER" ] || [ "$(docker inspect --format '{{.State.Running}}' "$APP_CONTAINER" 2>/dev/null || true)" != "true" ]; then
  echo "[deploy] refusing: the current Compose app is not running; no production database can be backed up" >&2
  exit 1
fi

RUNNING_IMAGE="$(docker inspect --format '{{.Config.Image}}' "$APP_CONTAINER")"
PREV_TAG="${RUNNING_IMAGE##*:}"
if [[ ! "$PREV_TAG" =~ ^[0-9a-f]{7,40}$ ]]; then
  echo "[deploy] refusing: could not determine the running immutable image tag" >&2
  exit 1
fi
if [ -n "$RECORDED_TAG" ] && [ "$RECORDED_TAG" != "$PREV_TAG" ]; then
  echo "[deploy] refusing: .deployed-tag ($RECORDED_TAG) differs from running image ($PREV_TAG)" >&2
  exit 1
fi

# docker inspect --format appends its own newline. Do not emit a second one in
# the template or mapfile will see a phantom empty mount record.
mapfile -t DATA_MOUNTS < <(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{printf "%s|%s" .Type .Name}}{{end}}{{end}}' "$APP_CONTAINER")
if [ "${#DATA_MOUNTS[@]}" -ne 1 ]; then
  echo "[deploy] refusing: running app does not have exactly one /data mount" >&2
  exit 1
fi
IFS='|' read -r DATA_MOUNT_TYPE DATA_MOUNT_NAME <<< "${DATA_MOUNTS[0]}"
if [ "$DATA_MOUNT_TYPE" != "volume" ] || [ -z "$DATA_MOUNT_NAME" ]; then
  echo "[deploy] refusing: /data must be backed by one named Docker volume" >&2
  exit 1
fi
docker volume inspect "$DATA_MOUNT_NAME" >/dev/null

# The deployment path handles resident/rep PII, so its mandatory pre-cutover
# snapshot must be encrypted. AGE_RECIPIENT can be provided by the operator or
# as one public-key line in the protected, git-ignored host file below.
if [ -z "${AGE_RECIPIENT:-}" ] && [ -r .backup-age-recipient ]; then
  IFS= read -r AGE_RECIPIENT < .backup-age-recipient
  export AGE_RECIPIENT
fi
if [ -z "${AGE_RECIPIENT:-}" ]; then
  echo "[deploy] refusing: configure AGE_RECIPIENT or .backup-age-recipient for encrypted backups" >&2
  exit 1
fi

echo "[deploy] target=$NEW_TAG  previous=${PREV_TAG:-none}"

# 1) Build a dedicated backup helper. This does not touch the running app.
BACKUP_TOOL_IMAGE="homefront-backup:$NEW_TAG"
echo "[deploy] build backup helper $BACKUP_TOOL_IMAGE…"
docker build --file Dockerfile.backup --tag "$BACKUP_TOOL_IMAGE" .

# 2) Pre-deploy backup (fails the deploy if the DB can't be snapshotted,
# integrity-checked, and encrypted).
echo "[deploy] pre-deploy backup…"
if ! BACKUP_VOLUME="$DATA_MOUNT_NAME" BACKUP_TOOL_IMAGE="$BACKUP_TOOL_IMAGE" scripts/backup.sh; then
  echo "[deploy] backup failed; production was not changed" >&2
  exit 1
fi

# 3) Build the immutable application image.
echo "[deploy] build $NEW_TAG…"
APP_IMAGE_TAG="$NEW_TAG" "${COMPOSE[@]}" build app

# 4) Roll out (Caddy waits for app healthy via depends_on).
echo "[deploy] up…"
if ! APP_IMAGE_TAG="$NEW_TAG" "${COMPOSE[@]}" up -d; then
  echo "[deploy] Compose cutover failed — restoring the previous image" >&2
  if scripts/rollback.sh "$PREV_TAG"; then
    echo "[deploy] rollback to $PREV_TAG is healthy" >&2
  else
    echo "[deploy] CRITICAL: rollback to $PREV_TAG also failed its health check" >&2
  fi
  exit 1
fi

# 5) Health gate.
echo "[deploy] health check…"
ok=0
# ~180s of grace (60 × 3s). The app starts listening before its heavy background
# startup, so health is normally ready in seconds; this is a wide margin for a large DB.
attempts_left=60
while [ "$attempts_left" -gt 0 ]; do
  if APP_IMAGE_TAG="$NEW_TAG" "${COMPOSE[@]}" exec -T app node -e "fetch('http://127.0.0.1:5000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    ok=1; break
  fi
  attempts_left=$((attempts_left - 1))
  sleep 3
done

if [ "$ok" = "1" ]; then
  echo "${PREV_TAG:-}" > .previous-tag
  echo "$NEW_TAG" > .deployed-tag
  echo "[deploy] HEALTHY — $NEW_TAG is live. (previous kept: ${PREV_TAG:-none})"
  # Disk hygiene: every deploy builds a new homefront-app:<sha> image; without pruning
  # they accumulate until the disk fills (seen live: 79 images/17GB → 100% full →
  # "database or disk is full", blocking deploys AND threatening the SQLite volume).
  # Keep ONLY the live image and the rollback image; delete older release tags,
  # dangling layers, and trim the build cache. Best-effort — never fail the deploy.
  docker images 'homefront-app' --format '{{.Tag}}' 2>/dev/null | while read -r tag; do
    [ -z "$tag" ] || [ "$tag" = "$NEW_TAG" ] || [ "$tag" = "${PREV_TAG:-}" ] || [ "$tag" = "<none>" ] || \
      docker image rm "homefront-app:$tag" >/dev/null 2>&1 || true
  done
  docker image prune -f >/dev/null 2>&1 || true
  docker builder prune -f --keep-storage 2GB >/dev/null 2>&1 || true
  echo "[deploy] pruned old release images + build cache (kept $NEW_TAG + ${PREV_TAG:-none})"
else
  echo "[deploy] UNHEALTHY after cutover — rolling back" >&2
  if [ -n "${PREV_TAG:-}" ]; then
    if scripts/rollback.sh "$PREV_TAG"; then
      echo "[deploy] rollback to $PREV_TAG is healthy" >&2
    else
      echo "[deploy] CRITICAL: rollback to $PREV_TAG also failed its health check" >&2
    fi
  else
    echo "[deploy] no previous tag to roll back to — investigate with docs/INCIDENT_RUNBOOK.md" >&2
  fi
  exit 1
fi
