# Schema and query principles

The current engine is SQLite WAL. Schema lives in `shared/schema.ts`,
`server/db.ts`, `server/storage.ts:runMigrations` and domain `ensure*Schema` /
`*Migrations.ts` modules. There is no current `migrations/` directory. Some
initializers run on import; migration order and swallowed noncritical failures
are real compatibility concerns. Do not assume every initializer is one atomic,
versioned migration merely because its name says migration.

- New tenant data requires tenant ownership, stable identity and explicit
  constraints. Composite business keys include tenant where identity is local.
  Existing global IDs/keys need compatibility design before alteration.
- Bind values. Prefer explicit selected columns for new hot/API queries. Existing
  `SELECT *` statements need projection-by-projection changes, not a blind replace.
- Keep write transactions short and synchronous inside their database boundary.
  No network, provider call or long computation while holding the writer.
  Use `interactiveDb` for bounded, asynchronous contention retries.
- Page ordered feeds with a stable tie-breaker, usually `(timestamp,id)` or `id`.
  Cursors include the effective tenant/filter/order contract. Preserve existing
  clients when replacing offset APIs; never silently change sort semantics.
- Aggregate/filter/limit candidates before hydrating evidence. Use exact indexed
  predicates; null, timestamp formats and partial-index implications matter.
- One domain owns canonical facts. Derived counts, ranks and queue metadata
  cannot override authoritative ownership, financial state or provider evidence.

## Change and recovery process

Record expected rows, startup/index-build cost, tenant scope, compatibility and
rollback before persistence edits. Test fresh, historical and repeated startup
orders with real SQLite, plus fault/retry behavior. Additive indexes must have
unique names and query-plan proof. Backfills use fixed watermarks, bounded writes
and progress; skip rows whose values would not change. A new engine/partitioning
strategy requires a separate ADR, snapshot/catch-up consistency plan, validation
of constraints/financial totals, verified restore and staged cutover.

The current foundation adds two indexes and no data backfill. Retention changes
only existing pending `fresh_fiber` housekeeping, preserving newest per-tenant
rows and live leases. It does not recover rows superseded by older releases.

PostgreSQL/RLS/PostGIS and partitioning are possible future tools. Do not run
PostgreSQL `EXPLAIN ANALYZE`, pool tuning or SQLFluff assumptions against SQLite.
For current query evidence use SQLite `EXPLAIN QUERY PLAN`, actual row/result
comparisons and measured reader/writer behavior.
