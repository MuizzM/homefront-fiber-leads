# A continuously-written SQLite WAL breaks read-only backups — checkpoint at the backup, with retries.
The deploy backup mounts the volume :ro; opening a WAL DB read-only fails if WAL
recovery is needed ("attempt to write a readonly database"). Under constant scanner
writes the WAL re-dirties within seconds of any manual checkpoint, so pre-deploy
checkpoints raced and two deploys died. Fix in scripts/backup.sh: checkpoint THROUGH
the live app container (docker exec … wal_checkpoint(TRUNCATE)) immediately before
each backup attempt, retry x4. Emergency manual variant documented in memory.
