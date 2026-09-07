# Dashboard index compatibility follow-up

## Outcome

The dashboard fresh-confirmed count uses its tenant/rep-keyed partial index on
fresh and upgraded databases, regardless of which older index owned its name.
The outcome-recency startup backfill writes only rows with missing useful history.

## Context

PR #216 is merged and deployed at `669422bde5d6b4ba0e7174e202695aab4e9c8fe3`.
Its post-release report (Actions run 34147332892, 17:17:29–17:22:35 UTC) showed
no repeating queue-count/stranded-run scans and no SQLite-busy or OTP failures.
It also exposed a 452ms dashboard count. `server/storage.ts` and
`server/leadRanking.ts` declare different indexes named
`idx_leads_fresh_confirmed`; the older ranking definition makes the intended
dashboard migration silently skip creation. Fresh-database tests missed this.
The report also showed a 1.528s recency backfill rewriting untouched NULL rows.

## Safety invariants

Keep the exact count predicates and tenant/rep scopes. Add the count index with
a unique name; retain existing indexes and all rows. Preserve the original
recency MAX/future-clamp expression; skip only rows that would remain NULL.
No new provider requests, credentials or business rules. Root remains the only
writer; the existing backfill's resulting values and eligibility remain unchanged.

## Milestones

1. Reproduce the two historical index definitions and actual query plans.
2. Give the dashboard count index a distinct name and covering tenant/rep keys.
   Test fresh/legacy/repeated migrations, both startup orders, and scoped counts.
   Guard no-op recency writes and test future clamping, retry and late history.
3. Independent review; `bash scripts/agent-verify.sh full`; exact-commit CI.
4. Merge/deploy under the user's existing authorization. Repeat public health
   and authenticated dashboard checks, then collect read-only performance data.

## Progress

- [x] 2026-09-07: PR #216 deployed successfully; public probes and authenticated
  dashboard/map/Live Operations checks passed. Code-request median 129.8ms over
  three synthetic reserved-domain requests; email delivery was not exercised.
- [x] 2026-09-07: Identified conflicting index definitions from the live slow
  statement and source; independent reproduction/review delegated.
- [x] Focused regression: 31 tests passed. Independent test/security review has
  no material findings. Large synthetic benchmark confirms scoped covering seeks
  and identical counts; 200k-lead backfill fixture preserves timestamps while
  reducing writes from 199,990 to 191 and from 199,799 to zero on repetition.
- [ ] Local full gate.
- [ ] Follow-up PR, CI, deployment and live verification (record release evidence
  in the PR so status updates do not alter the tested release commit).

## Decisions

Use a new index name rather than dropping an ambiguously defined legacy index.
This is compatible with either historical creation order and the previous app.
An installation with the older count definition can temporarily retain that
equivalent small partial index; correctness does not depend on deleting it.
Use EXISTS for the no-op backfill guard: it uses the existing lead/time index
without materializing all historical knock IDs. Preserve exact history semantics.

## Discoveries

CREATE INDEX IF NOT EXISTS checks names, not definitions. Tests must simulate an
already-existing index with different columns/predicate, not only fresh install.
The initial release's one-time feed index build took 18.84s during cutover; the
new container subsequently passed all internal/public health checks. Its first
five-minute report is early production evidence, not a full production load test.

## Validation

Assert the actual migration creates the distinct index, repeated migrations
preserve row data and the legacy definition, and the query plan uses an eligible
partial index. Compare scoped results across tenants/reps, including confirmed
rows with NULL timestamps (count eligibility differs from ranking eligibility).
Run migration and ranking regressions, full gate and exact-SHA CI before deploy.

## Recovery

Additive index and equivalent backfill; prior release remains compatible. Use the existing guarded
deployment health/rollback path. Latest successful backup/restore is Actions
34031032636 (September 6). Retry interrupted migration normally; it is idempotent.

## Result

Implementation and verification in progress. The first release closed thirteen
traced areas; this follow-up addresses a compatibility defect exposed by its
post-deployment measurement.
