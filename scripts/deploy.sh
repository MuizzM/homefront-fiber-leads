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
# Usage:  scripts/deploy.sh [commit-sha]     (defaults to current HEAD)
set -euo pipefail
cd "$(dirname "$0")/.."

COMPOSE="docker compose -f docker-compose.production.yml"
NEW_TAG="${1:-$(git rev-parse --short HEAD)}"
PREV_TAG="$(cat .deployed-tag 2>/dev/null || true)"

echo "[deploy] target=$NEW_TAG  previous=${PREV_TAG:-none}"

# 1) Pre-deploy backup (fails the deploy if the DB can't be snapshotted).
echo "[deploy] pre-deploy backup…"
DB_PATH="${DB_PATH:-$(docker volume inspect homefront-fiber-full_app-data -f '{{.Mountpoint}}' 2>/dev/null || echo /var/lib/docker/volumes/homefront-fiber-full_app-data/_data)/data.db}" \
  scripts/backup.sh

# 2) Build the immutable image.
echo "[deploy] build $NEW_TAG…"
APP_IMAGE_TAG="$NEW_TAG" $COMPOSE build app

# 3) Roll out (Caddy waits for app healthy via depends_on).
echo "[deploy] up…"
APP_IMAGE_TAG="$NEW_TAG" $COMPOSE up -d

# 4) Health gate.
echo "[deploy] health check…"
ok=0
for i in $(seq 1 20); do
  if $COMPOSE exec -T app node -e "fetch('http://127.0.0.1:5000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    ok=1; break
  fi
  sleep 3
done

if [ "$ok" = "1" ]; then
  echo "${PREV_TAG:-}" > .previous-tag
  echo "$NEW_TAG" > .deployed-tag
  echo "[deploy] HEALTHY — $NEW_TAG is live. (previous kept: ${PREV_TAG:-none})"
else
  echo "[deploy] UNHEALTHY after cutover — rolling back" >&2
  if [ -n "${PREV_TAG:-}" ]; then
    APP_IMAGE_TAG="$PREV_TAG" $COMPOSE up -d
    echo "[deploy] rolled back to $PREV_TAG" >&2
  else
    echo "[deploy] no previous tag to roll back to — investigate with docs/INCIDENT_RUNBOOK.md" >&2
  fi
  exit 1
fi
