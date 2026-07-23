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
grep -q 'ServerAliveInterval' "$WORKFLOW" || fail "deploy SSH lacks keepalives (quiet build/backup minutes drop the pipe)"

if grep -q 'homefront-fiber-full_app-data' scripts/deploy.sh; then
  fail "deploy still contains the stale hard-coded volume name"
fi
grep -q 'Destination "/data"' scripts/deploy.sh || fail "deploy does not inspect the running /data mount"
if grep -Fq '{{printf "%s|%s\n" .Type .Name}}' scripts/deploy.sh; then
  fail "Docker mount template emits a duplicate record separator"
fi
grep -q 'BACKUP_VOLUME="$DATA_MOUNT_NAME"' scripts/deploy.sh || fail "deploy does not back up the named production volume"
# The offline quiescent window is the fix for the online-vacuum snapshot that
# needed multiples of the DB size in transient disk and wedged deploys on the
# 38GB box. Deploys must build FIRST, then stop the app, checkpoint, and
# stream the backup. Greps anchor on CODE (pragma/flag strings), not on log
# messages a refactor could keep while deleting the behavior.
grep -q 'BACKUP_QUIESCENT=1 BACKUP_VOLUME' scripts/deploy.sh || fail "deploy does not use the offline quiescent backup window"
grep -q 'pragma("wal_checkpoint(TRUNCATE)")' scripts/deploy.sh || fail "offline window lacks a real WAL-checkpoint pragma"
if grep -q 'VACUUM INTO' scripts/deploy.sh; then
  fail "deploy must not take an online vacuum snapshot (disk-hungry; wedged production deploys)"
fi
BUILD_LINE="$(grep -n '"${COMPOSE\[@\]}" build app' scripts/deploy.sh | head -n 1 | cut -d: -f1 || true)"
STOP_LINE="$(grep -n '"${COMPOSE\[@\]}" stop app' scripts/deploy.sh | head -n 1 | cut -d: -f1 || true)"
{ [ -n "$BUILD_LINE" ] && [ -n "$STOP_LINE" ] && [ "$BUILD_LINE" -lt "$STOP_LINE" ]; } \
  || fail "deploy must build the app image BEFORE stopping the app (zero-downtime build, minimal window)"
grep -q 'BACKUP_QUIESCENT' scripts/backup.sh || fail "backup helper lacks the quiescent deploy-window mode"
grep -q 'State.Running' scripts/backup.sh || fail "quiescent backup does not verify the app container is stopped"
grep -q 'file:\$DB_PATH?immutable=1' scripts/backup-container.sh || fail "quiescent backup cannot read a WAL-mode DB from a :ro mount without immutable=1"
grep -q 'PRAGMA quick_check' scripts/backup-container.sh || fail "quiescent backup lacks a pre-stream verification"
grep -q -- '-s "\$DB_PATH-wal"' scripts/backup-container.sh || fail "quiescent backup does not refuse a non-empty WAL (torn-copy guard)"
grep -q "data-\*.db\*.age" scripts/backup-container.sh || fail "retention/space guard does not match both artifact generations (.db.age + .db.zst.age)"
grep -q 'zstd' Dockerfile.backup || fail "backup image lacks zstd for streamed compressed backups"
grep -q 'zstd -dc' scripts/restore.sh || fail "restore cannot decompress .zst backups"
grep -q 'flock' scripts/deploy.sh || fail "deploy has no host-level mutual exclusion (racing deploys interleave stop/up)"
grep -q 'setsid' "$WORKFLOW" || fail "workflow must run the deploy detached — a dropped SSH pipe once killed the offline window mid-flight"
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
