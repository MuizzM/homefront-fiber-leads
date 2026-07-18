# Backing up a continuously-written SQLite WAL db: snapshot with VACUUM INTO through the live app — not readonly opens, not checkpoint+retry, not the backup API from a second connection.
Three approaches failed in production before the durable one:
1. Read-only open of the live db from another container ("attempt to write a
   readonly database") — WAL recovery needs write access, and under constant
   scanner writes the WAL is always dirty.
2. Checkpoint (TRUNCATE) through the app + retry ×4 — the WAL re-dirties within
   seconds; lost the race 4/4 on a real deploy.
3. SQLite Online Backup API (`db.backup()`) from a separate connection — the
   backup RESTARTS whenever any OTHER connection writes to the source, so under
   continuous writes it livelocks (observed: 5-minute hang, deploy killed).
Durable fix in scripts/backup.sh: `docker exec` into the live app and run
`VACUUM INTO '/data/backup-snapshot.db'` on a readonly connection. VACUUM INTO
reads one consistent MVCC snapshot under WAL — writers keep running, nothing
restarts, single pass, bounded with `timeout 240`. The self-contained snapshot
(no WAL) is then handed to the locked-down backup container via DB_PATH on the
:ro volume mount, and removed by a `trap … EXIT`.
