#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

fail() {
  echo "[deployment-safety] $*" >&2
  exit 1
}

for script in scripts/backup.sh scripts/backup-container.sh scripts/deploy.sh scripts/restore.sh scripts/rollback.sh; do
  bash -n "$script"
done

WORKFLOW=.github/workflows/deploy.yml
grep -q 'workflow_dispatch:' "$WORKFLOW" || fail "production deploy is not manual"
if grep -Eq '^[[:space:]]+push:' "$WORKFLOW"; then
  fail "production deploy must not run on push"
fi
grep -q 'commit_sha:' "$WORKFLOW" || fail "release SHA input is missing"
grep -q 'environment:' "$WORKFLOW" || fail "production environment gate is missing"
grep -q 'name: production' "$WORKFLOW" || fail "production environment is not selected"
grep -q 'DEPLOY_KNOWN_HOSTS' "$WORKFLOW" || fail "pinned known-host secret is missing"
if grep -q 'ssh-keyscan' "$WORKFLOW"; then
  fail "ssh-keyscan must not be used for production trust"
fi
grep -q 'scripts/deploy.sh "$RELEASE_SHA"' "$WORKFLOW" || fail "workflow does not call the guarded deploy script"

if grep -q 'homefront-fiber-full_app-data' scripts/deploy.sh; then
  fail "deploy still contains the stale hard-coded volume name"
fi
grep -q 'Destination "/data"' scripts/deploy.sh || fail "deploy does not inspect the running /data mount"
grep -q 'BACKUP_VOLUME="$DATA_MOUNT_NAME"' scripts/deploy.sh || fail "deploy does not back up the named production volume"
grep -q -- '--network none' scripts/backup.sh || fail "backup helper is not network-isolated"
grep -q -- '--read-only' scripts/backup.sh || fail "backup helper root filesystem is writable"
grep -q 'PRAGMA integrity_check' scripts/backup-container.sh || fail "container backup lacks an integrity check"
grep -q 'age -r' scripts/backup-container.sh || fail "container backup is not encrypted"
grep -q '.backup-age-recipient' scripts/deploy.sh || fail "deploy does not require encrypted pre-cutover backups"
grep -q 'scripts/rollback.sh "$PREV_TAG"' scripts/deploy.sh || fail "failed deploy does not use health-gated rollback"
grep -q '\^\[0-9a-f\].*7,40' scripts/rollback.sh || fail "rollback accepts mutable image tags"
if grep -q 'systemctl' scripts/restore.sh; then
  fail "restore still controls a systemd service instead of Compose"
fi
grep -q 'docker compose -f docker-compose.production.yml' scripts/restore.sh || fail "restore does not target production Compose"

if command -v shellcheck >/dev/null 2>&1; then
  shellcheck scripts/backup.sh scripts/backup-container.sh scripts/deploy.sh scripts/restore.sh scripts/rollback.sh
else
  echo "[deployment-safety] shellcheck unavailable; skipped"
fi

if docker compose version >/dev/null 2>&1; then
  # Compose resolves the service-level env_file even though this static check
  # never starts a container. Supply an empty ignored file on clean CI clones,
  # and never modify an operator's existing local/production .env.
  (
    created_env=0
    if [ ! -e .env ]; then
      : > .env
      created_env=1
    fi
    cleanup_env() {
      if [ "$created_env" = "1" ]; then rm -f .env; fi
    }
    trap cleanup_env EXIT
    APP_IMAGE_TAG=0000000000000000000000000000000000000000 \
      docker compose -f docker-compose.production.yml config --quiet
  )
else
  echo "[deployment-safety] docker compose unavailable; config validation skipped"
fi

echo "[deployment-safety] deployment controls passed"
