#!/usr/bin/env bash
# ── Manual rollback to the previous release ──────────────────────────────────
# Re-runs the previously-deployed immutable image (recorded by deploy.sh in
# .previous-tag) and health-checks it. Use when a deploy passed health but a
# problem surfaced later.
#
# NOTE: rollback swaps the CODE, not the DATA. Migrations are additive/forward-
# only, so an older image runs fine against the newer schema (extra columns are
# ignored). If a deploy corrupted DATA, restore from backup instead:
#   scripts/restore.sh <backup-file> --apply     (see docs/INCIDENT_RUNBOOK.md)
#
# Usage:  scripts/rollback.sh [commit-sha]     (defaults to .previous-tag)
set -euo pipefail
cd "$(dirname "$0")/.."

COMPOSE=(docker compose -f docker-compose.production.yml)
TAG="${1:-$(cat .previous-tag 2>/dev/null || true)}"
[ -n "$TAG" ] || { echo "[rollback] no previous tag recorded and none given" >&2; exit 1; }
[[ "$TAG" =~ ^[0-9a-f]{7,40}$ ]] || { echo "[rollback] refusing non-immutable image tag: $TAG" >&2; exit 1; }

echo "[rollback] rolling to $TAG…"
# One retry on the up: rollback is the LAST line of defense (the deploy's
# failure paths all end here) and a transient dockerd hiccup must not be what
# leaves production down.
if ! APP_IMAGE_TAG="$TAG" "${COMPOSE[@]}" up -d app; then
  echo "[rollback] up failed once — retrying in 10s…" >&2
  sleep 10
  APP_IMAGE_TAG="$TAG" "${COMPOSE[@]}" up -d app
fi

echo "[rollback] health check…"
# Use dockerd's already-computed health verdict, exactly as deploy.sh does.
# Starting this application can legitimately exceed one minute under load;
# the former 20 x 3s exec-based probe falsely declared a healthy recovery dead.
attempts_left=100
while [ "$attempts_left" -gt 0 ]; do
  APP_CONTAINER="$(APP_IMAGE_TAG="$TAG" "${COMPOSE[@]}" ps -q app || true)"
  if [ -n "$APP_CONTAINER" ] && [ "$(docker inspect --format '{{.State.Health.Status}}' "$APP_CONTAINER" 2>/dev/null)" = "healthy" ]; then
    echo "$TAG" > .deployed-tag
    echo "[rollback] HEALTHY — $TAG is live"; exit 0
  fi
  attempts_left=$((attempts_left - 1))
  sleep 3
done
echo "[rollback] $TAG did not become healthy — escalate (docs/INCIDENT_RUNBOOK.md)" >&2
exit 1
