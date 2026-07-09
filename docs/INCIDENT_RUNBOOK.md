# Production Incident Runbook — HomeFront Fiber

Fast paths for the on-call engineer. All commands run on the prod server as
`deploy`, from `/srv/homefront`. `C="docker compose -f docker-compose.production.yml"`.

## 0. Triage (first 2 minutes)

```bash
C ps                                  # which services are up / healthy
C logs --tail=200 app                 # recent app logs (structured, request IDs)
C logs --tail=100 caddy               # TLS / proxy errors
curl -fsS https://portal.homefrontsolutionsllc.com/api/health   # {"ok":..., "db":...}
df -h /                               # disk (full disk => SQLite write failures)
free -m; docker stats --no-stream     # memory / CPU
```
Grab the failing request's `x-request-id` (in the response header and every log
line) to trace it end-to-end.

## 1. Site down / unhealthy after a deploy → roll back CODE

```bash
scripts/rollback.sh                   # redeploys the previous SHA, health-checks
```
`deploy.sh` already auto-rolls-back on a failed cutover; use this for problems
that surface *after* a green deploy. Rollback swaps code only — safe against the
(forward-only, additive) schema.

## 2. Data corruption / bad write → restore DATA from backup

```bash
# Litestream path (if LITESTREAM_BUCKET set): a fresh volume auto-restores on
# boot, or restore a point in time:
C exec app litestream restore -o /data/data.db.restored -config /app/deploy/litestream.yml /data/data.db

# Snapshot path:
ls -lt backups/                       # pick the last-good snapshot
scripts/restore.sh backups/data-YYYYMMDDTHHMMSSZ.db.age            # verify only
scripts/restore.sh backups/data-YYYYMMDDTHHMMSSZ.db.age --apply    # stops app, swaps, health-checks
```
`restore.sh --apply` writes a `*.pre-restore-*` copy of the current DB first, so
a restore is itself reversible.

## 3. Disk full

```bash
df -h /; du -sh /srv/homefront/backups /var/lib/docker
docker system prune -f                # remove dangling images/layers
find /srv/homefront/backups -name 'data-*' -mtime +14 -delete   # trim old backups
C logs --tail=0 app                   # log rotation is capped (json-file 10m×5) but verify
```

## 4. TLS / certificate failure

- `C logs caddy` — look for ACME errors. Usual cause: the `portal` A record isn't
  resolving to this server, or ports 80/443 are firewalled. Fix DNS/firewall,
  then `C restart caddy` to retry issuance.

## 5. Email not sending (login codes)

- Check `C logs app | grep -i otp` — a successful send logs no code; a failure
  logs `[otp] SMTP send failed`.
- Mail goes through **Resend SMTP** (`smtp.resend.com:465`, user `resend`,
  `SMTP_PASS`=Resend API key, sender=`MAIL_FROM`). A `535 authentication
  credentials invalid` means the API key is wrong/revoked — rotate it in the
  Resend dashboard and update `.env`. A `from` rejection means `MAIL_FROM` isn't
  a Resend-verified sender on the domain. Use port **465** (implicit TLS);
  plain 587 is filtered on some networks.

## 6. Auth abuse / suspicious logins

- The app rate-limits auth and locks an account for 30 min after repeated failed
  OTP attempts. To force-revoke a user everywhere: they (or an admin) hit
  `POST /api/auth/logout-all`. Review `activity_log` for `auth.*` events.

## 7. Destructive migration (manual, approval-gated — NOT automated)

Boot-time migrations are additive only. For a drop/rename/backfill:
1. **Announce + get approval.** 2. **Take a fresh backup** (`scripts/backup.sh`).
3. Apply the change in a maintenance window against a **restored staging copy**
   first. 4. Have the restore command ready as the rollback. 5. Only then apply
   to prod. Never run a destructive change unattended in `deploy.sh`.

## Escalation & records

- Record every incident: `x-request-id`, timeline, actions, root cause.
- Alerts (once wired): service down, failed deploy, disk >85%, memory >90%,
  repeated 5xx, email-send failures, GPS-validation-failure spikes.
- Recovery objectives: **RTO ≈ 15 min** (rollback or restore), **RPO ≈ seconds**
  with Litestream / **≤ 24 h** with nightly snapshots.
