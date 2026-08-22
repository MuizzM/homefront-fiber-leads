# Worker stalls: take scan-plane work and boot scans off the request loops

## Outcome

A rep's request no longer waits behind scan-plane writes or admin polls. Measured
from outside, `/api/health` server time sits in the tens of milliseconds instead of
swinging to 2.6 s; the perf report's STALL TIMELINE shows the HTTP workers' loop-lag
maxima in the hundreds of milliseconds, not tens of seconds. Deploys stop paying five
minutes of boot-time table scans.

## Context

- Diagnosis tooling shipped in PR #169 (`server/slowStatements.ts`, `db.slow_statement`,
  `pid` on `http.request`, the STALL TIMELINE in `scripts/perf-report.mjs`). The first
  post-deploy report (window 16:49 to 17:04 UTC, 2026-08-22) is the evidence for this plan:
  - Boot: `PRAGMA foreign_key_check` 263 s (calling migration, unscoped, inside
    `BEGIN IMMEDIATE`); `UPDATE fiber_checks SET tenant_id=? WHERE tenant_id IS NULL` 64 s
    (default-tenant adoption sweep over a 2.66 GB table with no indexes).
  - Serving: `BEGIN IMMEDIATE` 430 runs, 571 s total, max 15.4 s, on every HTTP worker
    (pids 745/752/759): the provider-admission cleanup transactions and
    `UPDATE scan_run_targets SET state=...` queueing on the one write lock, plus
    `scan.reaper.slow_tick` of 10 to 30 s per tick per worker. better-sqlite3 busy-waits
    synchronously, so each wait is a stalled request loop.
  - Admin polls measured on the 3.3 GB production-shaped copy with `SLOW_SQL_MS=100`:
    `/api/scan/first-seen-live` 5.5 to 10.3 s (Fiber Intelligence polls it every 8 s),
    `/api/sweeps/state` 1.7 s (every 15 s), `/api/scan/markets` 1.2 s (every 30 s),
    `/api/scan/pool-stats` 0.26 s (every 8 s while scanning).
- Production runs the cluster (`SCAN_WORKERS: "auto"`): worker 0 is the control worker and
  serves no HTTP; workers 1..N-1 serve HTTP AND, until this plan, consumed scan runs.
  `SCAN_GLOBAL_CONCURRENCY` is 1, so the extra consumers bought no throughput.
- Earlier findings this builds on: [[wal-guard-blocks-http-loop]] (the checkpoint moved
  to the primary), [[audit-findings-2026-08-13]] (measure at the production distribution;
  the reaper's `getStrandedDoneRuns` rewrite), docs/architecture/BULK_ASSIGNMENT.md.

## Safety invariants

- No data is deleted or rewritten: indexes, memos, a query predicate that adds the
  tenant the rows already belong to, a boot check scoped to the tables it verified
  anyway, and a watermark that only narrows a sweep to rows written since.
- Scan consumption keeps every guarantee (atomic claims, CAS finalize); it just runs in
  one process. `SCAN_CONSUME_ROLE=all` restores the old placement without a code change.
- Memos carry TTLs of at most 120 s and expose bust functions; nothing authoritative is
  cached (counters on admin dashboards only).
- Every change is measured on the production-shaped copy before it ships, and the
  post-deploy STALL TIMELINE is the acceptance test.

## Milestones

1. `idx_scan_targets_live_fresh` partial index for `freshPoints()` (measured 10.3 s to
   46 ms). Test pins the plan and both declaration sites.
2. Tenant-scoped failure count in `mapStateSweep` (1.6 s to 3 ms); memos for
   `getMarketAggregates` (120 s) and `getScanTargetStats` (20 s); calling migration's
   foreign-key check scoped to its tables.
3. `server/scanConsumeRole.ts`: under the cluster only the control worker consumes scan
   runs; `SCAN_CONSUME_ROLE: "control"` in the production compose.
4. Adoption-sweep watermark in `bootstrapDefaultTenant`.
5. `bash scripts/agent-verify.sh full`, PR, merge on green CI, deploy, then a perf report
   over the first hour to confirm the timeline.
6. Kinetic recheck (the other consumer): resume, nightly cron and job start gated to the
   consuming process; queued jobs picked up by the control worker's poller.

## Progress

- 2026-08-22 17:00 milestone 1 measured inside a rolled-back transaction on the copy and
  committed (eb347d8).
- 2026-08-22 17:10 milestone 2 measured end to end on the copy with the worktree dev server
  (`console-ui-proddb`, port 5084): first-seen-live 4.6 ms, sweeps/state 3.1 ms, markets
  3 ms on memo hits (767 ms cold), pool-stats 1 ms on hits (137 ms cold). Committed (d0d7bea).
- 2026-08-22 17:20 milestones 3 and 4 implemented with tests; full verify green (7,080).
- 2026-08-22 17:35 PR #170 merged (3ff9e4c) and deployed 17:50. External probe at 5 min
  uptime still p50 1.5 s, max 7.2 s; the 17:49 to 17:57 timeline shows the reaper now on
  the control worker only (scan.reaper.slow_tick on pid 165 alone) but the provider-lock
  convoy still on all three HTTP workers: `transaction starting SELECT * FROM
  kinetic_addresses ...` named the Kinetic RECHECK job. registerKineticScannerRoutes()
  called resumeKineticWorkersAfterRestart() in every worker, so N workers re-drove the
  same interrupted recheck, each 50 addresses wide, and startNightlyCron() was scheduled
  in every worker too. Milestone 6: both gated on thisProcessConsumesScanRuns();
  startKineticRecheck() only enqueues on a non-consuming process and a control-worker
  poller (startKineticJobPoller, 20 s) starts queued jobs.

## Decisions

- Control-worker-only consumption is the default under the cluster rather than a
  compose-only switch: with one global concurrency slot the old placement had no upside,
  and a default that stalls request loops is the wrong default. The compose still names it.
- Memos over query rewrites for the pool rollups: the GROUP BY over 919k rows has no
  index-only plan, and the numbers only move while a scan runs.
- The adoption sweep keeps its full-scan semantics for a WITHOUT ROWID table and for the
  first boot after this change (no watermark yet); later boots scan the new rows only.

## Discoveries

- The slow-statement log cannot tell lock-wait from work: a 15 s `BEGIN IMMEDIATE` is pure
  waiting. That is exactly what made the convoy visible.
- `GREEN_REVERIFY` in the production compose is referenced by no server code.
- `ADAPTIVE_PACE` is `off` in production with a "night blitz" comment, so the scanner never
  backs off when HTTP is starved. Left as is: it is the owner's explicit setting, and with
  consumption moved off the HTTP workers it no longer decides portal latency. Worth
  revisiting if scanning is re-enabled at scale.
- `/api/monitor/summary` is still 1.0 to 1.2 s on the copy; no client polls it.

## Validation

- Unit and integration tests named per milestone; `bash scripts/agent-verify.sh full`.
- Post-deploy: `gh workflow run perf-report.yml -f window=60m`, compare LAG BY PROCESS and
  the STALL TIMELINE against the 16:49 to 17:04 report.

## Recovery

- Each change is independent. `SCAN_CONSUME_ROLE=all` reverts milestone 3 without a
  deploy of code; the index can be dropped; the memos are process-local; the watermark
  keys can be deleted from app_settings (`tenant_adopt_watermark:*`) to force a full sweep.
