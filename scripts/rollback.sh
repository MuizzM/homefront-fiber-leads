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
APP_IMAGE_TAG="$TAG" "${COMPOSE[@]}" up -d app

echo "[rollback] health check…"
attempts_left=20
while [ "$attempts_left" -gt 0 ]; do
  if APP_IMAGE_TAG="$TAG" "${COMPOSE[@]}" exec -T app node -e "fetch('http://127.0.0.1:5000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    echo "$TAG" > .deployed-tag
    echo "[rollback] HEALTHY — $TAG is live"; exit 0
  fi
  attempts_left=$((attempts_left - 1))
  sleep 3
done
echo "[rollback] $TAG did not become healthy — escalate (docs/INCIDENT_RUNBOOK.md)" >&2
exit 1
