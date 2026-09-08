# Index strategy and regression guard

SQLite index names are schema-wide. `CREATE INDEX IF NOT EXISTS` does not verify
that an existing name has the requested definition. PR #217 fixed a real ranking
versus dashboard collision; fresh databases alone had not exposed historical
creation order. New indexes use domain/purpose names and retain old definitions
until a separately reviewed migration explicitly replaces them.

## Required check

Run `npm run check:indexes`. CI and `scripts/agent-verify.sh` run it alongside the
existing gates. `scripts/check-sqlite-indexes.ts` parses TypeScript string/template
expressions and SQL files in `server`, `shared`, `script` and optional `migrations`.
It checks every literal index statement, tolerates equivalent duplicates, and
rejects conflicting keys, uniqueness, table, order, collation or partial predicate.
String values and quoted identifier boundaries retain their meaning. Dynamic
index definitions require review rather than silently passing.

The sole exception is the exact nonunique-to-unique
`idx_scan_targets_canonical` promotion, owned by `server/storage.ts` and
`server/scanTargetCanonicalMerge.ts`. The promotion must include a parsed DROP
before CREATE in the same literal. Changed owners/signatures and stale exceptions
fail. Tests include a CLI fixture reproducing the historical collision, dynamic
quoted SQL and a misleading DROP inside a comment.

This is a **literal DDL check**, not a SQL type system, general query linter or
live-schema audit. Arbitrary computed SQL, imported SQL and historical deployed
schemas still need real migration/restore tests. It does not prove tenant
isolation, correct index use or safe online index builds.

## Foundation access paths

| Index | Workload | Cost/validation |
| --- | --- | --- |
| `idx_domain_events_tenant_cursor (tenant_id,id)` | Own-tenant checkpoint/backlog without walking the global event stream | Additive write/storage cost; repeated schema setup and actual query-plan tests. |
| `idx_outbox_fresh_pending_tenant (tenant_id,id DESC)` with pending fresh-fiber predicate | Tenant enumeration, retention cutoff and small cleanup batches | Only pending fresh alerts indexed; status changes maintain it. Repeated migration and no-op/lease tests. |

Measure candidate queries before/after with representative selectivity and
legacy indexes present. Prove identical result semantics and inspect plans after
`ANALYZE` where relevant. Include index-build/storage/write overhead in the
release decision. Reproduce this slice with
`npx tsx script/benchmark-saas-foundations.ts`; see
[recorded evidence](../performance/foundation-baseline.md).
