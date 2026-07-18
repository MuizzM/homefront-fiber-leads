#!/usr/bin/env bash
# Weekly host maintenance for the production box (cron: deploy user).
# Keeps the disk bounded so deploys and the live app never die of disk-full
# again (observed incidents: 79 stale images/17GB; 28 backups/21GB at 87%).
#
# Scope: prune REDUNDANT artifacts only. Never touches docker volumes, running
# containers, Caddy, or the live checkout. Everything it deletes is either
# regenerable (images/cache) or a superseded backup generation.
#
# Env knobs:
#   KEEP_IMAGE_TAGS   newest tags kept per homefront repo (default 2 = live+rollback)
#   BUILDER_KEEP      builder cache to retain (default 1GB)
#   BACKUP_KEEP_MAX   newest backups kept (default 6 — matches backup-container.sh)
#   JOURNAL_MAX       journald cap (default 100M)
set -uo pipefail

LOG="${MAINT_LOG:-/srv/homefront/maintenance.log}"
say() { echo "[maint $(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" | tee -a "$LOG"; }

say "── run start ── disk before: $(df -h / | awk 'NR==2{print $3" used / "$2", "$5}')"

# 1) Docker images: keep the newest KEEP_IMAGE_TAGS tags per homefront repo
#    (live + rollback) plus anything a running container uses; remove the rest.
KEEP_IMAGE_TAGS="${KEEP_IMAGE_TAGS:-2}"
RUNNING=$(docker ps --format '{{.Image}}')
for repo in homefront-app homefront-backup; do
  docker images "$repo" --format '{{.CreatedAt}}\t{{.Repository}}:{{.Tag}}' \
    | sort -r | awk -F'\t' '{print $2}' | tail -n "+$((KEEP_IMAGE_TAGS + 1))" \
    | while IFS= read -r img; do
        case "$RUNNING" in *"$img"*) say "skip (running): $img"; continue;; esac
        docker rmi "$img" >/dev/null 2>&1 && say "removed image: $img"
      done
done
docker image prune -f >/dev/null 2>&1 && say "pruned dangling images"

# 2) Build cache: bounded, not eliminated — the next deploy still benefits.
docker builder prune -f --keep-storage "${BUILDER_KEEP:-1GB}" >/dev/null 2>&1 && say "builder cache pruned to ${BUILDER_KEEP:-1GB}"

# 3) Backups: count-cap safety net (backup-container.sh also enforces this at
#    write time; this catches the window where deploys pause for days).
BACKUP_DIR="/srv/homefront/backups"
KEEP="${BACKUP_KEEP_MAX:-6}"
if [ -d "$BACKUP_DIR" ]; then
  find "$BACKUP_DIR" -maxdepth 1 -name 'data-*.db.age' -printf '%T@ %p\n' 2>/dev/null \
    | sort -rn | cut -d' ' -f2- | tail -n "+$((KEEP + 1))" \
    | while IFS= read -r f; do rm -f "$f" && say "pruned backup: $(basename "$f")"; done
fi

# 4) OS caches: apt archives + journald cap (both regenerable).
sudo -n apt-get clean >/dev/null 2>&1 && say "apt cache cleaned"
sudo -n apt-get autoremove -y >/dev/null 2>&1 && say "apt autoremove done"
sudo -n journalctl --vacuum-size="${JOURNAL_MAX:-100M}" >/dev/null 2>&1 && say "journal capped at ${JOURNAL_MAX:-100M}"

# 5) Keep this log itself bounded.
if [ -f "$LOG" ] && [ "$(wc -l < "$LOG")" -gt 1000 ]; then
  tail -n 500 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

say "── run end ── disk after: $(df -h / | awk 'NR==2{print $3" used / "$2", "$5}')"
