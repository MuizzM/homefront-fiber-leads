# ADR 0001: tenant and data foundation

Status: accepted, 2026-09-08. Scope: current foundation phase.

## Context

`server/db.ts` opens `DATA_DIR/data.db` with better-sqlite3 and WAL. Each process
has a connection; writes serialize through SQLite's writer. `shared/schema.ts`
and domain initializers define shared tables with tenant columns. Existing
legacy/null ownership and global email identity are compatibility constraints.
PostgreSQL and database-enforced row-level security are not installed.

## Decision

Retain shared tables and SQLite for this increment. New organization-facing
storage functions require a positive, safe integer tenant from the authenticated
context, enforce it in queries and writes, and never treat a missing context as
platform authority. For mutable projections, verify ownership against the
canonical record. Queue recovery uses immutable `domain_events` ownership and
commits its authorized state transition and tenant audit in one transaction.

Use additive, distinct indexes for demonstrated access paths. Check literal
index definitions in CI, and exercise actual migration order/query plans. No
production backfill, data deletion or database cutover belongs in this slice.

## Alternatives and consequences

Schema-per-tenant would add migration/connection overhead without a measured
requirement. PostgreSQL shared tables plus RLS remains a candidate for higher
write concurrency, recovery and operational needs; it requires explicit policy,
query/transaction compatibility and migration design. RLS would supplement,
not replace, server authorization. Neither option is a shortcut to million-user
capacity. Existing legacy helpers remain audit targets, not an endorsed pattern.

## Validation and recovery

Two-tenant fixtures include missing and corrupt cached ownership, invalid
context, foreign IDs, read-only diagnostics, atomic audit rollback and contention.
Additive-index tests cover fresh/pre-index databases and repeated initialization.
Reverting code can leave unused additive indexes safely present; removal would be
a separate forward migration. No production data is rewritten by this ADR.
