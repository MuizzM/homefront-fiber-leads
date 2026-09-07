# Performance follow-through — September 7, 2026

## Why the previous audit missed the login incident

The earlier audit combined source review, green tests, warm browser samples and a
2 minute 19 second post-restart production window. That evidence did not exercise
sustained background contention or the six-hour maintenance cycles. Production
later showed HTTP event-loop stalls over 40 seconds, longer than the login
client's 20-second request deadline. PR #215 removed token warming from HTTP
workers and made OTP writes retry without blocking the event loop; verification
also preserves the code if the session cannot be saved. Its first post-deploy
sample was only 74 seconds and still showed a 1.29-second fresh-feed read.
Neither short sample established the absence of other bottlenecks.

## Changes and coverage

| Path | Finding and fix | Regression evidence |
| --- | --- | --- |
| Fresh feed | Actual joined query scanned a tenant and hydrated evidence before the route discarded most rows. Added the effective-time partial index, materialized candidates and the exact-hour/200-row limit before evidence hydration. | Actual SQL query plan, tenant/source equivalence, exact cutoff, migration repetition, 350 equal-time rows; 180k-row benchmark below. |
| Scanner bookkeeping | The queue count and stranded-run probe each scanned the historical target ledger (~500ms per production tick). Explicitly repeating the existing partial-index predicate makes both use the pending index, with no extra index or eligibility change. | Actual query plans before/after ANALYZE; complete result equivalence across run/target states, due times and tenants. Synthetic 400,207-target benchmark: count 10.40→0.035ms; stranded probe 10.43→0.134ms. |
| Scanner status | Snapshot GET/SSE calls ran cleanup writes. Snapshot now applies expiry predicates with read-only queries; admission retains durable cleanup. | SQLite query-only mode and a separate held writer; expired/own-queued jobs preserve prior visibility rules. |
| Discovery ownership | HTTP create/retry wakeups bypassed boot-only control-worker ownership. Wake, schedule, resume and startup now enforce the shared role policy. | Actual engine under HTTP/control/single-worker/all-worker settings; HTTP mode uses a query-only connection and claims nothing. |
| Global maintenance | Incentive interval, calling audit and auth cleanup were duplicated across cluster workers. One primary/standalone installer owns and stops them. | Actual installer over two six-hour fake-clock windows; cluster workers install no work. |
| Incentive drain | Up to 10,000 events ran without yielding. Each event now commits separately and yields before the next; idle preflight takes no writer. | Cleared-event progress, failure/deferred ordering, lifecycle tests and existing incentive/financial suites. |
| Auth expiry | Unbounded repeated deletes and missing expiry indexes. Cleanup now uses indexed 500-row batches and yields until its fixed-cutoff backlog is drained. | Expired/unexpired fixture, repeated migration and no-writer idle tick. |
| Reporting | SQLITE_BUSY was treated as a permanently bad historical day and its dirty marker cleared. Contention now defers the day. | Held writer and injected transient failure preserve prior summaries/queue; retry succeeds. Another writer can acquire the database during computation; publication remains the existing short transaction. |
| Import shutdown | Untracked one-second boot callbacks could claim work after stop. Both import workers track/cancel that callback and check running state. | Stop before boot, repeated start, restart and elapsed-clock tests. |
| Scan diagnostics | A flush could wait synchronously on the shared writer and trigger repeated eager retries. Scoped zero native wait retains the bounded buffer through temporary contention and applies a cooldown. | Immediate live relay under lock, exact persistence after release, overflow/restart soak. |
| Mapbox ledger | An eager flush could block the process, retry on every new request and lose the responsive budget view. Scoped zero native wait retains pending spend and uses a cooldown. | Exact pending/durable totals, one attempt per cooldown, native timeout restoration, restart soak. |
| Map requests | Raw viewport/grid/served-door reads had no complete-response deadline or session lifetime. Shared reads now bound headers/body, cancel by identity/lifetime and guard cache/snapshot writes. | Actual callbacks with stalled/late transport, session change, unmount, superseding pan, cached-grid handoff and late old-session 401. |
| Display lifetimes | Route-active maps, Live Ops and inspector streams could continue while hidden/offline. Display-only work now pauses and reconciles on return. Empty map streams back off instead of reconnecting every second. | Visibility/offline/route hook, actual Map callbacks/SSE, real Live Ops query observers with still-fresh cached data. GPS and durable field queues are unchanged. |

## Query benchmark

Pinned base: `d5bde1f`; actual old and new `freshPoints` implementations, including
object hydration and route filtering. Two separate in-memory SQLite databases
contain identical synthetic data: 180,003 targets, 18,000 corroboration rows,
three tenants, sparse recent rows, mixed timestamps, invalid/out-of-window
corroboration and excluded locations. Three warmups and nine alternating samples:

| Workload | Before median | After median |
| --- | ---: | ---: |
| Full 30-day result | 24.22 ms | 7.78 ms |
| One-hour, 200-row feed | 20.85 ms | 1.92 ms |

All six tenant/window comparisons match, including sources and row order. The
actual plan now uses `(tenant_id=? AND <expr>>?)`, instead of a tenant-only scan.
Equal live timestamps now use an explicit descending ID tie-breaker in both
candidate and final ordering. A separate 350-row tie fixture matches the old
feed's selected rows and the new full-result slice. These are local synthetic
measurements, not a production speed guarantee.

## Production baseline

[Read-only report 34145144785](https://github.com/MuizzM/homefront-fiber-leads/actions/runs/34145144785)
covers September 7, 16:21:44–16:51:41 UTC (29m57s), with 1,299 requests,
1,052 of them health checks. Four OTP requests took 4.43ms p50 / 41.22ms maximum
server time; no OTP/database-busy failures were recorded. The worst HTTP-loop
sample was 1.30s in the startup minute. The scanner bookkeeping queries appeared
28/29 times at up to 500/565ms respectively, prompting the additional existing
index fix above. This baseline contains limited real application traffic; it
cannot stand in for a production load test.

## Validation

`bash scripts/agent-verify.sh full` passed: **643 files, 7,906 tests**, both type
checkers, deployment safety checks, harness validation and the production build.
Independent code, test, security and product reviews have no unresolved material
findings. Exact-commit CI and deployment status are recorded by the release PR
and production workflow; a passing local suite does not bypass those gates.

The 15-minute multiprocess synthetic soak ran the actual coordinator, transaction,
telemetry and Mapbox modules; their source hashes stayed unchanged. A separate
writer held the database for 343.9 of 900.8 seconds across 857 cycles, including
350ms bursts and deliberate 2.5-second holds. All nine reconciliation checks
passed:

- 7,161 IPC responses: 6,921 successful transactions exactly match committed rows;
  240 expected SQLITE_BUSY denials exhausted the one-second contention budget.
- Interactive processing p50 / p95 / max: 26.4 / 459.4 / 1,026ms. Active-worker
  event-loop p95 stayed at or below 2.52ms; maximum 64.9ms.
- Coordinator snapshot maximum: 7.09ms with 16,500 retained rows. Snapshot reads
  left expired/history rows unchanged and restored native connection timeouts.
- All 184,550 events reached the live relay. Under an intentional 7,000-event
  flood, the bounded buffer kept the newest 5,000; final retention kept 4,000.
- All surviving-process pending Mapbox counts recovered. Of 17,755 recorded
  counts, 17,656 were durable; the exact 99-count difference was volatile state
  deliberately lost on SIGKILL. That kill also lost 110 pending diagnostic rows
  and interrupted one request.
- Replacement startup under the held writer took 2.16 seconds; queued cold-start
  IPC requests reached 2.26 seconds. There were no unexpected worker errors.

Raw aggregate evidence: [fresh queries](performance/2026-09-07-fresh-points.json),
[sparse queue queries](performance/2026-09-07-sparse-queue.json), and
[contention soak](performance/2026-09-07-contention-soak.json). Fixtures are
synthetic. No real OTP, customer message, paid provider call or customer export
was used.

## Limits

This closes the traced findings above; it does not certify every application
path free of locks or wasted work. Synthetic IPC timings do not include browser,
proxy, SMTP delivery or production disk/network latency. The deployment still
uses SQLite's single shared writer; deliberate long holds can exhaust the
bounded login retry budget. In-memory batched diagnostics/accounting survive
transient contention but cannot promise preservation through SIGKILL; retention
and overflow behavior are reported explicitly in the soak results.

The existing optional knock-attribution contract is retained: its reporting
metadata cannot make a durable field save fail. Combining it with the save would
change that guarantee and can lengthen the writer transaction while historical
shift lookup runs. Large exports, full-history calling audits and management
mutations need workload-specific measurement before making broader claims.

## Post-release measurement and compatibility follow-up

[PR #216](https://github.com/MuizzM/homefront-fiber-leads/pull/216) passed exact-SHA
CI and [deployed successfully](https://github.com/MuizzM/homefront-fiber-leads/actions/runs/34146823542).
The [first production report](https://github.com/MuizzM/homefront-fiber-leads/actions/runs/34147332892)
covers 17:17:29–17:22:35 UTC (5m07s): 302 requests, 174 health checks, no
SQLite-busy/OTP-unavailable errors, and no recurring slow queue-count or
stranded-run scans. Map samples include nonempty results (maximum 8,322 rows),
but traffic remains limited. The worst sampled HTTP-loop delay was 489ms;
the report does not establish universal subsecond behavior under load.

Public synthetic code requests had a 129.8ms median / 141.88ms maximum over
three probes (including network time); actual email delivery was not exercised.
Authenticated dashboard, field map and Live Operations browser checks passed
with no console errors. A health probe timed out during container replacement;
the one-time feed-index creation took 18.84s, then internal/public health checks
passed. The existing single-container cutover is unchanged.

The report exposed two further migration inefficiencies, corrected in the
follow-up described by `.agent/plans/performance-index-followup.md`:

- **Conflicting index names:** older ranking code and the dashboard migration
  both declared `idx_leads_fresh_confirmed` with different definitions.
  `IF NOT EXISTS` silently preserved the older timestamp index. The dashboard
  now gets a uniquely named partial index on `(tenant_id, assigned_rep_id)`;
  both historical legacy definitions remain intact. The actual count predicates
  and every role/tenant scope are unchanged. On 300,512 synthetic rows, all nine
  scope variants matched; tenant count median 50.84→0.0017ms and rep count
  12.38→0.00046ms. These are local warm-index measurements, not production claims.
- **No-op startup backfill writes:** the existing recency backfill rewrote NULL
  to NULL on untouched leads, firing version triggers on every restart. An
  indexed EXISTS guard skips rows without non-NULL knock history while preserving
  the original latest-history/future-clamp expression. A 200k-lead fixture produced
  identical timestamps with 199,990→191 writes initially and 199,799→0 on repeat.
  Late history and rollback/retry remain covered.

Evidence: [dashboard plans/counts](performance/2026-09-07-dashboard-counts.json)
and [backfill writes](performance/2026-09-07-backfill-writes.json). The static
index-name sweep checked 451 declarations across 393 files; the other differing
name is an intentional canonical-index promotion with an explicit DROP/CREATE.
New regression coverage exercises the actual migration and ranking initializer,
legacy creation orders, covering scoped seeks, no-op writes and recency safety.
Focused migration/ranking tests and independent safety review passed; full local,
exact-commit CI and deployment results are recorded in the follow-up release PR.
