---
name: homefront-database-change
description: Plan, implement, debug, or review Homefront SQLite schema, Drizzle models, migrations, tenant-scoped queries, backups, restores, data repair, or retention behavior. Use for any database, migration, backup, restore, or persistent-data change.
---

# Change persistent data safely

1. Trace the schema, migration runner, storage method, callers, and existing migration/restore tests.
2. Create an ExecPlan and state the tenant boundary, compatibility requirement, restart behavior, expected row counts, and recovery path.
3. Make migrations forward-only, transactional where supported, idempotent or restart-safe, and compatible with existing databases.
4. Preserve data by default. Never drop, rewrite, deduplicate, or backfill production rows without explicit authorization, measured scope, and a verified backup/restore path.
5. Bind dynamic values and enforce tenant predicates in storage, not only at route level.
6. Test a fresh database, an existing pre-change database, failure/retry behavior, tenant separation, and backup restoration when relevant.
7. Run `$homefront-verify-change` at `full` level and report any validation that requires production-like data separately.
