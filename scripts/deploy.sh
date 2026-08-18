#!/usr/bin/env bash
# ── Production deploy (Hetzner + Docker Compose) ─────────────────────────────
# - Immutable image tag = commit SHA (never :latest).
# - Build-first: both images build while the OLD release keeps serving.
# - FAST CUTOVER: the release swaps the container and nothing else. The
#   offline DB backup moved OUT of the downtime window to a scheduled job
#   (scripts/backup-offline.sh) after a measured multi-minute outage per
#   release — stopping a healthy container to compress 7GB is not a blip.
#   DEPLOY_WITH_BACKUP=1 restores the in-deploy backup for a risky release.
# - Health-gated cutover; auto-rollback to the previous SHA if health fails,
#   and auto-restore of the previous release if the offline window itself fails.
# - Records the previous SHA for rollback.sh.
#
# Migrations: the app runs its migrations on boot. They are ADDITIVE ONLY
# (ALTER TABLE ADD COLUMN / CREATE ... IF NOT EXISTS) and idempotent, so boot-
# time application is safe. A DESTRUCTIVE change (drop/rename) is NOT automated —
# it requires the manual, approval-gated procedure in docs/INCIDENT_RUNBOOK.md.
#
# Env:
#   DEPLOY_WITH_BACKUP=1   take the offline snapshot inside this deploy
#                          (adds the stop-the-world window back — use only
#                          for a release you consider especially risky).
#
# Usage:  scripts/deploy.sh [full-commit-sha] (defaults to current HEAD)
set -euo pipefail
cd "$(dirname "$0")/.."

# Exactly ONE deploy at a time on this box. The workflow's concurrency group
# serializes Actions runs, but a manual SSH deploy racing a workflow run (or an
# operator double-launch) would interleave stop/up/backup steps catastrophically.
exec 9>.deploy.lock
if ! flock -n 9; then
  echo "[deploy] refusing: another deploy is already running on this host (.deploy.lock held)" >&2
  exit 1
fi

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

# Validate the exact checked-out edge configuration before building or touching
# production. The live Caddy container cannot be trusted for this check: older
# releases mounted one file and could retain a stale inode across git checkout.
echo "[deploy] validate Caddy configuration…"
docker run --rm \
  --volume "$PWD/deploy/caddy:/etc/caddy:ro" \
  caddy:2 caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

# Remove every release tag of our two image repos EXCEPT the ones passed as
# arguments, then dangling layers. Best-effort — never fails the deploy.
prune_release_images() {
  local repo tag k keep
  for repo in homefront-app homefront-backup; do
    while IFS= read -r tag; do
      [ -n "$tag" ] || continue
      [ "$tag" = "<none>" ] && continue
      keep=0
      for k in "$@"; do
        if [ "$tag" = "$k" ]; then keep=1; break; fi
      done
      [ "$keep" -eq 1 ] || docker image rm "$repo:$tag" >/dev/null 2>&1 || true
    done < <(docker images "$repo" --format '{{.Tag}}' 2>/dev/null)
  done
  docker image prune -f >/dev/null 2>&1 || true
}

# 1) Disk hygiene BEFORE the space-hungry steps. Old release images and stale
# build cache are the recurring disk eaters on this 38GB box (seen live: 79
# images/17GB → 100% full). Keep the running release, the target, and whatever
# .previous-tag still points at (an argless rollback.sh must stay possible
# even if THIS deploy fails before recording new tags).
RECORDED_PREV="$(cat .previous-tag 2>/dev/null || true)"
echo "[deploy] pre-build prune (keeping ${PREV_TAG:-none} + $NEW_TAG + ${RECORDED_PREV:-none})…"
prune_release_images "$PREV_TAG" "$NEW_TAG" "$RECORDED_PREV"
docker builder prune -f --keep-storage 4GB >/dev/null 2>&1 || true

# 2) Build BOTH images while the old release keeps serving (zero downtime;
# a build failure leaves production untouched).
BACKUP_TOOL_IMAGE="homefront-backup:$NEW_TAG"
echo "[deploy] build backup helper $BACKUP_TOOL_IMAGE…"
docker build --file Dockerfile.backup --tag "$BACKUP_TOOL_IMAGE" .
echo "[deploy] build app $NEW_TAG…"
APP_IMAGE_TAG="$NEW_TAG" "${COMPOSE[@]}" build app

# 3) Disk preflight for the offline backup. The streamed artifact is zstd-
# compressed (SQLite compresses ~3x) → ~DB/2 is conservative; the checkpoint
# also folds the CURRENT WAL into data.db, so count it too. Old backups beyond
# the newest are reclaimable (the backup tool's space guard prunes them before
# writing). Fail HERE, before any downtime. The whole block is skipped in
# emergency mode: its docker exec would die on a broken app container, and
# the emergency hatch must work exactly then.
if [ "${DEPLOY_WITH_BACKUP:-0}" = "1" ]; then
  BACKUP_DIR_HOST="${BACKUP_DIR:-./backups}"
  mkdir -p "$BACKUP_DIR_HOST"
  DB_KB="$(docker exec "$APP_CONTAINER" du -k /data/data.db | cut -f1)"
  WAL_KB="$(docker exec "$APP_CONTAINER" sh -c 'du -k /data/data.db-wal 2>/dev/null | cut -f1' || echo 0)"
  WAL_KB="${WAL_KB:-0}"
  FREE_KB="$(df -k --output=avail "$BACKUP_DIR_HOST" | tail -1 | tr -d ' ')"
  RECLAIMABLE_KB="$(find "$BACKUP_DIR_HOST" -maxdepth 1 -name 'data-*.db*.age' -printf '%T@ %k\n' 2>/dev/null | sort -rn | tail -n +2 | awk '{s+=$2} END {print s+0}')"
  NEED_KB=$((DB_KB / 2 + WAL_KB + 2 * 1024 * 1024))
  if [ $((FREE_KB + RECLAIMABLE_KB)) -lt "$NEED_KB" ]; then
    echo "[deploy] refusing: not enough disk for the pre-cutover backup" >&2
    echo "[deploy]   db=${DB_KB}KB wal=${WAL_KB}KB free=${FREE_KB}KB reclaimable-old-backups=${RECLAIMABLE_KB}KB needed=${NEED_KB}KB" >&2
    echo "[deploy]   free space (or set DEPLOY_SKIP_BACKUP=1 for an emergency no-backup deploy)" >&2
    exit 1
  fi
fi

# 4) SHORT OFFLINE WINDOW — stop, checkpoint, verified encrypted backup, cutover.
# If anything in the window fails, the trap restores the previous release.
restore_previous_release() {
  echo "[deploy] offline window failed — restoring the last healthy release" >&2
  if recover_to_previous; then
    echo "[deploy] production data unchanged" >&2
  else
    echo "[deploy] see docs/INCIDENT_RUNBOOK.md" >&2
  fi
}

# ── DOWNTIME BUDGET ─────────────────────────────────────────────────────────
# The pre-cutover backup used to run INSIDE the stopped window: stop the
# healthy container, checkpoint, compress ~7GB, then start the replacement.
# Measured cost: a multi-minute hard outage on every release (reps saw
# connection failures, not a blip). Releases no longer pay that price —
# the offline backup is now a SCHEDULED job (scripts/backup-offline.sh, run
# from cron at a quiet hour) and the deploy window contains only the
# container swap (seconds). Set DEPLOY_WITH_BACKUP=1 to restore the old
# in-deploy backup for a release you consider especially risky.
WINDOW_OPEN=0
if [ "${DEPLOY_WITH_BACKUP:-0}" != "1" ]; then
  echo "[deploy] fast cutover — backup deferred to the scheduled offline job (DEPLOY_WITH_BACKUP=1 to force one here)"
else
  # Arm the restore trap BEFORE stopping: if `stop` itself fails halfway (or
  # anything between stop and cutover dies), set -e exits through the trap and
  # the previous release is brought back. Every window operation is bounded by
  # `timeout` — a hung docker call would otherwise block the script forever
  # with the app down and the trap never firing.
  WINDOW_OPEN=1
  trap '[ "$WINDOW_OPEN" = "1" ] && restore_previous_release' EXIT
  echo "[deploy] stopping app for the offline backup window…"
  timeout 120 env APP_IMAGE_TAG="$PREV_TAG" "${COMPOSE[@]}" stop app

  # WAL checkpoint the quiescent DB so data.db is self-contained (WAL → 0 bytes).
  # One-shot container from the app image (it ships better-sqlite3); the app is
  # stopped, so this is the only writer.
  echo "[deploy] wal_checkpoint(TRUNCATE) on the quiescent database…"
  timeout 600 docker run --rm --entrypoint node -v "$DATA_MOUNT_NAME:/data" "homefront-app:$NEW_TAG" -e '
    const d = require("better-sqlite3")("/data/data.db");
    d.pragma("busy_timeout = 60000");
    const r = d.pragma("wal_checkpoint(TRUNCATE)");
    d.close();
    console.log("[deploy] checkpoint result:", JSON.stringify(r));
    if (Array.isArray(r) && r[0] && r[0].busy) process.exit(1);
  '

  # Quiescent streamed backup: quick_check the real DB, then zstd|age straight
  # into ./backups — one artifact, ~DB/3, no snapshot copy, no docker exec.
  echo "[deploy] pre-cutover backup (quiescent stream)…"
  if ! timeout 1800 env BACKUP_QUIESCENT=1 BACKUP_VOLUME="$DATA_MOUNT_NAME" BACKUP_TOOL_IMAGE="$BACKUP_TOOL_IMAGE" scripts/backup.sh; then
    echo "[deploy] backup failed; production was not changed" >&2
    exit 1
  fi
fi

# ── Choosing a rollback target ───────────────────────────────────────────────
# Rolling back to the SHA that just failed is not a rollback — it reinstalls the
# broken release and reports "CRITICAL: rollback also failed", which reads like a
# second, unrelated fault and buries the real one. Seen live on 2026-07-28:
# a release failed its health check and the recovery rolled to that same SHA.
#
# PREV_TAG is read from the running container before cutover and is normally
# correct, but it is NOT guaranteed to differ from the target: if a previous
# attempt already swapped the container onto this SHA, the "previous" image IS
# the new one. .previous-tag records the last release that actually passed
# health, so it is the trustworthy fallback. If neither yields something
# different, say so plainly instead of performing a recovery that cannot work.
pick_rollback_target() {
  if [ -n "${PREV_TAG:-}" ] && [ "$PREV_TAG" != "$NEW_TAG" ]; then
    printf '%s' "$PREV_TAG"; return 0
  fi
  local recorded; recorded="$(cat .previous-tag 2>/dev/null || true)"
  if [ -n "$recorded" ] && [ "$recorded" != "$NEW_TAG" ]; then
    echo "[deploy] running image already reports $NEW_TAG; using last healthy release $recorded" >&2
    printf '%s' "$recorded"; return 0
  fi
  return 1
}

# Roll back to the last release known to be good. Never to $NEW_TAG.
recover_to_previous() {
  local target
  if ! target="$(pick_rollback_target)"; then
    echo "[deploy] CRITICAL: no rollback target distinct from $NEW_TAG (running=$PREV_TAG, recorded=$(cat .previous-tag 2>/dev/null || echo none))." >&2
    echo "[deploy] production is on a release that failed health. See docs/INCIDENT_RUNBOOK.md — restore a known-good SHA by hand." >&2
    return 1
  fi
  if scripts/rollback.sh "$target"; then
    echo "[deploy] rollback to $target is healthy" >&2
    return 0
  fi
  echo "[deploy] CRITICAL: rollback to $target also failed its health check" >&2
  return 1
}

# 5) Roll out (Caddy waits for app healthy via depends_on).
echo "[deploy] up…"
if ! APP_IMAGE_TAG="$NEW_TAG" "${COMPOSE[@]}" up -d; then
  echo "[deploy] Compose cutover failed — restoring the previous image" >&2
  WINDOW_OPEN=0
  trap - EXIT
  # recover_to_previous logs its own outcome (healthy, or why it could not).
  recover_to_previous || true
  exit 1
fi
WINDOW_OPEN=0
trap - EXIT

# 6) Health gate.
echo "[deploy] health check…"
ok=0
# Gate on dockerd's OWN healthcheck verdict (docker inspect), not on forked
# exec probes: on a fully-loaded 4-core box the exec fork itself starves and
# times out while the app is healthy — observed live as two consecutive false
# health-gate failures + rollbacks (2026-07-23). dockerd probes in-container
# on its own schedule (start_period 120s) and its status is already computed.
# ~300s of grace (100 × 3s) to cover start_period + first probes under load.
attempts_left=100
while [ "$attempts_left" -gt 0 ]; do
  APP_CONTAINER_NOW="$(APP_IMAGE_TAG="$NEW_TAG" "${COMPOSE[@]}" ps -q app || true)"
  if [ -n "$APP_CONTAINER_NOW" ] && [ "$(docker inspect --format '{{.State.Health.Status}}' "$APP_CONTAINER_NOW" 2>/dev/null)" = "healthy" ]; then
    ok=1; break
  fi
  attempts_left=$((attempts_left - 1))
  sleep 3
done

if [ "$ok" = "1" ]; then
  # Compose does not recreate a service merely because a bind-mounted file's
  # contents changed. Reload Caddy on EVERY release so repository hardening and
  # header changes become live with the app. Caddy reload is atomic: an invalid
  # config leaves the prior configuration serving, while the preflight above
  # makes that failure unlikely. Treat any reload error as a failed release.
  echo "[deploy] reload Caddy configuration…"
  if ! APP_IMAGE_TAG="$NEW_TAG" "${COMPOSE[@]}" exec -T caddy \
      caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile; then
    echo "[deploy] Caddy reload failed — rolling the app back; previous edge config remains active" >&2
    recover_to_previous || true
    exit 1
  fi

  echo "[deploy] HEALTHY — $NEW_TAG is live. (previous kept: ${PREV_TAG:-none})"
  # Container health ≠ the user path. Probe the public edge (Caddy → app) as a
  # WARNING only: a cert renewal or edge hiccup must not trigger a rollback of
  # a healthy app, but the operator should see it in the deploy log.
  PUBLIC_HEALTH_URL="${PUBLIC_HEALTH_URL:-https://portal.homefrontsolutionsllc.com/api/health}"
  if ! curl -fsS -m 10 -o /dev/null "$PUBLIC_HEALTH_URL"; then
    echo "[deploy] WARNING: public edge check failed ($PUBLIC_HEALTH_URL) — app is healthy internally; check Caddy" >&2
  else
    echo "[deploy] public edge OK ($PUBLIC_HEALTH_URL)"
  fi
  # Security release gate: these methods are unused by the portal and must be
  # rejected at the public edge. This catches a stale/unreloaded Caddy config,
  # which an ordinary GET health probe cannot detect.
  PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-https://portal.homefrontsolutionsllc.com/}"
  unsafe_method_gate_ok=1
  for unsafe_method in TRACE TRACK CONNECT; do
    method_status="$(curl -sS -m 10 -o /dev/null -w '%{http_code}' -X "$unsafe_method" "$PUBLIC_BASE_URL" || true)"
    if [ "$method_status" != "405" ]; then
      echo "[deploy] SECURITY GATE FAILED: $unsafe_method returned ${method_status:-no-status}, expected 405" >&2
      unsafe_method_gate_ok=0
    fi
  done
  if [ "$unsafe_method_gate_ok" != "1" ]; then
    recover_to_previous || true
    exit 1
  fi
  echo "[deploy] public unsafe-method gate OK (TRACE/TRACK/CONNECT → 405)"
  # Record the release only after BOTH the app health gate and the public edge
  # security gate pass. Otherwise the next deploy would trust a failed release
  # as the known-good rollback target.
  echo "${PREV_TAG:-}" > .previous-tag
  echo "$NEW_TAG" > .deployed-tag
  # Post-deploy disk hygiene: keep ONLY the live image and the rollback image;
  # delete older release tags, dangling layers, and trim the build cache.
  # Best-effort — never fail the deploy.
  prune_release_images "$NEW_TAG" "$PREV_TAG"
  docker builder prune -f --keep-storage 2GB >/dev/null 2>&1 || true
  echo "[deploy] pruned old release images + build cache (kept $NEW_TAG + ${PREV_TAG:-none})"
else
  # The health gate is the path most likely to fire on a genuinely bad release,
  # so it above all must not "recover" by reinstalling that same release.
  echo "[deploy] UNHEALTHY after cutover — rolling back" >&2
  recover_to_previous || true
  exit 1
fi
