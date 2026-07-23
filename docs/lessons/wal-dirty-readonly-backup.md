# Backing up a continuously-written SQLite WAL db: DEPLOYS use an offline quiescent stream; only cron/ad-hoc (app live) uses VACUUM INTO through the app.

Three approaches failed in production before VACUUM INTO:
1. Read-only open of the live db from another container ("attempt to write a
   readonly database") — WAL recovery needs write access, and under constant
   scanner writes the WAL is always dirty.
2. Checkpoint (TRUNCATE) through the app + retry ×4 — the WAL re-dirties within
   seconds; lost the race 4/4 on a real deploy.
3. SQLite Online Backup API (`db.backup()`) from a separate connection — the
   backup RESTARTS whenever any OTHER connection writes to the source, so under
   continuous writes it livelocks (observed: 5-minute hang, deploy killed).

Then VACUUM INTO itself failed AT SCALE (2026-07-23): on a 6.5GB db it needs
multiples of the db size in transient disk (compacted snapshot inside /data +
encrypted artifact + the WAL regrowing for the 4+ minutes it runs) and
repeatedly filled the 38GB box, blocking every deploy.

Durable DEPLOY fix (scripts/deploy.sh + BACKUP_QUIESCENT=1): build images
first while the old release serves, then a SHORT OFFLINE WINDOW — stop the
app, `wal_checkpoint(TRUNCATE)` via a one-shot app-image container (no
contention: zero readers), quick_check the real file, and stream it
`zstd -3 | age` straight into ./backups (~⅓ of db size, ONE artifact, no raw
copy). Reading a WAL-mode db from the `:ro` volume requires the sqlite URI
`immutable=1` (a normal open must create `-shm` and fails); immutable is safe
precisely because the app is stopped. Restore path: age -d | zstd -dc
(scripts/restore.sh handles data-*.db.zst.age).

VACUUM INTO through the live app remains the right tool ONLY for online
backups (cron/ad-hoc while the app serves) — scripts/backup.sh keeps that path
when BACKUP_QUIESCENT is unset, and it still needs the disk headroom above.
