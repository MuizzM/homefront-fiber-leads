#!/usr/bin/env bash
# Weekly host maintenance for the production box (cron: deploy user).
# Keeps the disk bounded so deploys and the live app never die of disk-full
# again (observed incidents: 79 stale images/17GB; 28 backups/21GB at 91%).
#
# Scope: prune REDUNDANT artifacts only. Never touches docker volumes, running
# containers, Caddy, or the live checkout. Everything it deletes is either
# regenerable (images/cache) or a superseded backup generation. The images
# recorded in .deployed-tag/.previous-tag (live + rollback) are PINNED — a
# failed deploy can leave a never-live image as the newest by build time, so
# "newest N" alone would evict the real rollback target.
#
# Env knobs (invalid/≤0 values fall back to the default — never widen a prune):
#   KEEP_IMAGE_TAGS   newest UNPINNED tags kept per homefront repo (default 2)
#   BUILDER_KEEP      builder cache to retain (default 1GB)
#   BACKUP_KEEP_MAX   newest backups kept (default 6 — matches backup-container.sh)
#   JOURNAL_MAX       journald cap (default 100M)
set -uo pipefail

LOG="${MAINT_LOG:-/srv/homefront/maintenance.log}"
say() { echo "[maint $(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" | tee -a "$LOG" 2>/dev/null || true; }

# Keep-count validation: "0" means "this prune is DISABLED" (matching
# backup-container.sh's guard semantics); anything non-numeric falls back to
# the default. A bad value can only ever shrink or skip a prune — it must
# never widen one (unguarded, BACKUP_KEEP_MAX=0 → tail -n +1 would have
# deleted every backup on the box).
posint() { case "${1:-}" in ''|*[!0-9]*) echo "$2";; *) echo "$1";; esac; }
KEEP_IMAGE_TAGS="$(posint "${KEEP_IMAGE_TAGS:-2}" 2)"
BACKUP_KEEP="$(posint "${BACKUP_KEEP_MAX:-6}" 6)"

say "── run start ── disk before: $(df -h / | awk 'NR==2{print $3" used / "$2", "$5}')"

# 1) Docker images. Pin set = running containers + live + rollback tags; then
#    keep the newest KEEP_IMAGE_TAGS unpinned tags per repo, remove the rest.
#    Ordering via `docker inspect {{.Created}}` (RFC3339 UTC) — image ls's
#    CreatedAt is host-local time and mis-sorts across DST transitions.
PIN="$(docker ps --format '{{.Image}}' | tr '\n' ' ')"
for f in /srv/homefront/.deployed-tag /srv/homefront/.previous-tag; do
  t="$(cat "$f" 2>/dev/null || true)"
  [ -n "$t" ] && PIN="$PIN homefront-app:$t homefront-backup:$t"
done
if [ "$KEEP_IMAGE_TAGS" = "0" ]; then
  say "image prune disabled (KEEP_IMAGE_TAGS=0)"
else
for repo in homefront-app homefront-backup; do
  kept=0
  while IFS=$'\t' read -r _created img; do
    case " $PIN " in *" $img "*) say "skip (pinned): $img"; continue;; esac
    kept=$((kept + 1))
    [ "$kept" -le "$KEEP_IMAGE_TAGS" ] && continue
    docker rmi "$img" >/dev/null 2>&1 && say "removed image: $img"
  done < <(docker images "$repo" --format '{{.ID}}\t{{.Repository}}:{{.Tag}}' \
             | while IFS=$'\t' read -r id ref; do
                 printf '%s\t%s\n' "$(docker inspect --format '{{.Created}}' "$id" 2>/dev/null)" "$ref"
               done | sort -r)
done
fi
docker image prune -f >/dev/null 2>&1 && say "pruned dangling images"

# 2) Build cache: bounded, not eliminated — the next deploy still benefits.
docker builder prune -f --keep-storage "${BUILDER_KEEP:-1GB}" >/dev/null 2>&1 && say "builder cache pruned to ${BUILDER_KEEP:-1GB}"

# 3) Backups: count-cap safety net (backup-container.sh also enforces this at
#    write time; this catches the window where deploys pause for days).
BACKUP_DIR="/srv/homefront/backups"
if [ "$BACKUP_KEEP" = "0" ]; then
  say "backup count-cap disabled (BACKUP_KEEP_MAX=0)"
elif [ -d "$BACKUP_DIR" ]; then
  find "$BACKUP_DIR" -maxdepth 1 -name 'data-*.db.age' -printf '%T@ %p\n' 2>/dev/null \
    | sort -rn | cut -d' ' -f2- | tail -n "+$((BACKUP_KEEP + 1))" \
    | while IFS= read -r f; do rm -f "$f" && say "pruned backup: $(basename "$f")"; done
fi

# 4) OS caches: apt archives + journald cap (both regenerable). Failures must
#    be VISIBLE — a silently-failing sudo would leave journald unbounded while
#    the log claims otherwise.
sudo -n apt-get clean >/dev/null 2>&1 && say "apt cache cleaned" || say "WARN: sudo apt-get clean failed (NOPASSWD sudoers missing?)"
sudo -n apt-get autoremove -y >/dev/null 2>&1 && say "apt autoremove done" || say "WARN: sudo apt-get autoremove failed"
sudo -n journalctl --vacuum-size="${JOURNAL_MAX:-100M}" >/dev/null 2>&1 && say "journal capped at ${JOURNAL_MAX:-100M}" || say "WARN: sudo journalctl vacuum failed"

# 5) Keep this log itself bounded.
if [ -f "$LOG" ] && [ "$(wc -l < "$LOG")" -gt 1000 ]; then
  tail -n 500 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

say "── run end ── disk after: $(df -h / | awk 'NR==2{print $3" used / "$2", "$5}')"
