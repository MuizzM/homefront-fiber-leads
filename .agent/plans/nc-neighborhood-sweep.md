# NC neighborhood sweep: whole-neighborhood fresh-fiber discovery

## Outcome

A single control-worker producer, `NEIGHBORHOOD_SWEEP`, keeps the Kinetic/Decodo
scanner busy across North Carolina in a way a crew can use: it finishes whole
neighborhoods instead of spraying one or two checks per street, follows fiber
where it finds it, skips towns that have proven to be sinks, confirms the known
NEW FIBER doors that never became leads, and ranks the resulting fresh clusters
for managers by how many doors nobody has knocked. Managers see the ranked list
on Fiber Intelligence (Neighborhoods tab) and hand a cluster to a crew with the
existing map lasso.

## Context

Evidence gathered 2026-08-22 from the 3.3 GB production-shaped `data.db` copy
(scan evidence ends 2026-08-12; all Kinetic NC scans happened 2026-07-10 to
07-22):

- NC Kinetic inventory: 334,488 `scan_targets`, 22,555 ever scanned (6.7%),
  311,933 never scanned. Nothing has been checked since every automatic producer
  was switched off on 2026-08-09 (portal-first stop, `docker-compose.production.yml`).
- Fiber clusters spatially. Organic scans in a 0.01 degree cell that already had
  one hit yield 22.5% NEW FIBER; organic scans in cold cells yield 0.9% (25x).
  264 of 403 hit streets are 100% NEW FIBER.
- "Hit and left": 562 hit cells still hold 12,486 unscanned doors; the 101 cells
  with >= 3 hits and >= 20 unscanned hold 8,283. Tryon, Lilesville, Pinebluff,
  Morven, Indian Trail cells carry 100+ hits each and zero leads or knocks.
- 4,405 targets are known NEW FIBER + billing N but have no conclusive
  `availability_snapshots` row (legacy scan path), so `projectConfirmedFreshLeads`
  rejects them and they never became leads. A re-check through the engine
  publishes them.
- Sinks: Charlotte (400 scanned, 0 live, 53,796 unscanned), Statesville (1,045
  scanned, 0 live, 34,700 unscanned), Asheboro. A naive statewide sweep spends
  most of its budget there.
- The existing queue is the scatter: 776k queued rows across 729 stale
  `running` runs (daily-diff, hot_market) drain one random address at a time at
  SCAN_GLOBAL_CONCURRENCY=1, and `enqueueRunTargets` cross-run dedup silently
  drops any target already queued in one of them.
- Cluster expansion (`server/clusterExpansion.ts`) samples 60 nearest addresses
  per 800 m ring (cluster cap 600) and never advanced past ring 0 in prod.
- Producers must live inside `if (IS_CONTROL_ROLE && startPrimaryElection())` in
  `server/index.ts`, start through `deferBoot`, and create runs with a
  deterministic id + `getRun` guard + `dispatchRun` (the addressDiscovery
  pattern), never `startTargetRun` (random id, in-process worker, cap bypass).
- The live "fresh" rule is Kinetic NEW FIBER + billing N on a conclusive snapshot
  (`server/freshFiberProjector.ts` authoritativeFresh, DB trigger second branch).
  Reps only see assigned or territoried doors (`open_field_enabled=0`).

Key files: `server/neighborhoodSweep.ts` (new producer), `shared/neighborhoodSweep.ts`
(pure scoring + probe selection), `server/neighborhoodSweepRoutes.ts` (manager API),
`client/src/pages/FiberIntelligence.tsx` (Neighborhoods tab), `server/index.ts`
(wiring), `docker-compose.production.yml` (switch + knobs), `docs/SCAN_OPERATIONS.md`.

## Safety invariants

- Tenant scope: every cell, run, and API read is keyed by `tenant_id`.
- Provider: all checks go through the existing engine (`dispatchRun` ->
  `runScanWorker` -> `scanAddress`) and therefore the coordinator's concurrency,
  rate, critical reserve, breaker, and stop conditions. The sweep adds no
  transport, no rotation, no challenge handling.
- Bounded work per cycle: budget derived from measured drain rate, capped by
  `NEIGHBORHOOD_SWEEP_MAX_PER_CYCLE`; own pending backlog capped; cells per cycle
  capped; probe size per cold cell capped; stale-run supersede chunked.
- Write lock: frontier refresh is a read plus one small upsert; enqueues are
  per-cell (hundreds of rows); supersede runs in 2,000-row chunks with
  `setImmediate` yields. Runs only on the control worker.
- No lead is created by the sweep directly; the projector owns publication.
- Off by default in code (`NEIGHBORHOOD_SWEEP !== "on"`); the compose switch is
  the single source of truth for prod. Deploying, merging, and raising
  `SCAN_GLOBAL_CONCURRENCY` remain operator actions.

## Milestones

1. Scoring + probe selection as pure functions in `shared/neighborhoodSweep.ts`
   with unit tests (`tests/unit/neighborhood-sweep-score.test.ts`).
2. Producer `server/neighborhoodSweep.ts`: schema, frontier refresh, supersede,
   budget, confirm-greens tier, flood tier, probe tier, E911 bridge, economy log.
   Integration test on a temp DB (`tests/integration/neighborhood-sweep.test.ts`).
3. Wiring in `server/index.ts` behind `NEIGHBORHOOD_SWEEP`, control worker only.
4. Manager API + Neighborhoods tab.
5. Compose switch and knobs, docs, verification (`bash scripts/agent-verify.sh full`).

## Progress

- [x] 2026-08-22: mapped transport, engine, producers, inventory, rep side, ops
  (six readers + analyst + critic); evidence recorded above.
- [x] 2026-08-22 Milestone 1: `shared/neighborhoodSweep.ts` + 19 unit tests.
- [x] 2026-08-22 Milestone 2: `server/neighborhoodSweep.ts` + 12 integration
  tests (cycle laws, park expiry, confirm bound, supersede protections, E911).
- [x] 2026-08-22 Milestone 3: wired in `server/index.ts` behind
  `NEIGHBORHOOD_SWEEP === "on"` inside the control-worker producer block.
- [x] 2026-08-22 Milestone 4: `server/neighborhoodSweepRoutes.ts` (+7 route
  tests) and the Neighborhoods tab on Fiber Intelligence; driven in the
  browser against the production-shaped copy.
- [x] 2026-08-22 Milestone 5: compose switch + knobs, docs, full verification.
- [x] 2026-08-22 adversarial review (3 lenses, 22 agents): 9 confirmed
  findings fixed (E911 re-bridge loop, park windows never lapsing, confirm
  tier re-buying unpublishable doors without a bound, live/negative derived
  from a NULL column, one run per 12-door probe cell, ISO-vs-SQLite timestamp
  in the 24 h lead count, three weak tests).

## Decisions

- Neighborhood unit = the existing 0.01 degree cell (`cell_lat`/`cell_lng`,
  indexed by `idx_scan_targets_cell`). It is the granularity the 25x lift was
  measured at, it needs no geometry service, and within a cell the run is
  ordered by street then house number so a street completes before the next.
  Adjacent cells inherit a spillover bonus so a subdivision straddling cells is
  finished by the next cycle.
- One run per cell per day (`nsweep_<tenant>_<lat>_<lng>_<yyyymmdd>`): the
  claim order of a uniform never-scanned run is enqueue order, the run's
  progress is the neighborhood's progress, and restart/resume is free.
- Probe, then flood: a cold cell is probed with at most one address per street
  (group testing; streets are 72%+ homogeneous). Any hit raises the cell above
  every cold cell next cycle, so the flood follows within one interval. This is
  the explicit fix for "one or two scans per neighborhood": a probe is never the
  end state.
- Confirm-greens tier first: re-checking the 4,405 snapshot-less NEW FIBER
  doors is the cheapest path to leads today.
- Stale bulk runs are superseded (cancelled, queued tail skipped) so the sweep
  owns the queue. Kinds: daily-diff, hot_market, city-sweep, copper_upgrade,
  state-monitor, market (older than 24 h). address_discovery runs are left to
  their reconciler.
- Run kind contains `fresh` so it lands in the DISCOVERY admission class
  (370, revenue: fast boot resume, FIFO jump) with the 18 h bulk dedup.
- Sinks are parked at cell level (>= 15 scans, 0 live) and city level
  (>= 200 scans, < 0.5% hits) for 45 days unless official evidence (announced
  build, FCC likely-2026 block) says otherwise.

## Discoveries

Recorded in Context. Additional: `SCAN_PROVIDER_REQUESTS_PER_MINUTE` defaults
to 30,000 in code (docs say 100); `SCAN_GLOBAL_CONCURRENCY=1` in prod is the
2026-07-30 bot-gate posture ("revert when the gate relaxes"), so concurrency is
the only throttle the sweep drains through.

## Validation

All on 2026-08-22, branch `claude/nc-neighborhood-sweep` (off
`origin/rep-knocking-workflow` at 82d3041):

- `python3 scripts/validate-agent-harness.py`: valid, 4 agents, 8 skills.
- `bash tests/deployment-safety.sh`: passed (docker compose unavailable
  locally, config validation skipped; duplicate-key scan of the compose
  environment block run separately: none).
- `npm run check` and `npm run check:fast`: clean (after `npm install` to
  pick up `cmdk` from PR #168).
- `DATA_DIR=$(mktemp -d) npm test`: 567 files, 7,149 tests passed. The first
  run failed one repo gate (`deferred-read-write-transactions`): the frontier
  upsert ran deferred; fixed with `tx.immediate`.
- `npm run build`: passed.
- Dry run of `buildFrontier` + one cycle on a throwaway copy of the 3.3 GB
  production-shaped DB (dispatch stubbed, proxy black-holed): frontier of
  6,876 cells in 2.8 s (549 flood / 4,395 probe / 1,804 parked / 128
  complete; parked = Charlotte 54k + Statesville 35k + outside footprint);
  286 stale runs / 726,722 queued rows superseded in 6.3 s; first cycle at the
  600 floor: 240 confirm, 2 whole-cell floods (Tryon 149 doors, Lilesville
  121), one probe run of 84 doors across 8 Rockwell/Salisbury cells.
- Browser: Fiber Intelligence > Neighborhoods on that copy shows 74
  neighborhoods / 456 unknocked fresh doors / 12,486 doors left in hot cells;
  Map opens the field map on a lead in the cell. No console errors.

## Recovery

`NEIGHBORHOOD_SWEEP=off` stops the producer; in-flight runs finish or are
cancelled with the existing run controls. Superseded runs are marked
`cancelled` with a reason; re-enabling their producer recreates them. The
`sweep_cells` table is derived and can be dropped; the next cycle rebuilds it.

## Round 2 (2026-08-22): once-only + the coming ledger

Operator directive: read whether a door will ever turn on and save it with the
date the provider states; scan nearby clusters in every city starting with
Broadway, Wingate and Rockwell; and never scan the same address twice.

### What the evidence said

- **Re-scanning is the waste.** 55,503 of 78,058 NC Kinetic checks (71%) were
  repeats of already-answered addresses (one bought 65 times), and produced
  ZERO Kinetic fiber: all 25 negative-to-fiber flips in recorded history were
  Frontier doors in Durham. 311,933 NC doors have never been checked once.
- **Both carriers state future service and we read none of it.** Kinetic sends
  `broadbandService.{futureQual, technologyType:"FUTURE_QUAL_EXTENDED",
  futureTechnologyType, estimatedCompletionDt}`; the date is a month
  ("NOV-2026") or the sentinel "Future Fiber Build Planned". 476 NC doors carry
  a real month, 488 more the sentinel. Frontier sends `isFutureFiberEligible`,
  `fiberBuildOutStatus:"PENDING"`, `futureServiceDate`: 168 / 164. Every writer
  hardcoded `estimatedCompletionDate: null`, so `coming_soon_watchlist
  .estimated_completion` was NULL on all 330 rows.
- **The existing "coming soon" list was wrong.** `lifecycleSignalOf` admitted
  NEW FIBER + active billing, which the canonical classifier calls NOW_ACTIVE -
  a door somebody already bought. 294 of 330 watches were that, which is why
  none ever flipped, and they sat in the one dedup-exempt recheck lane.
- **The dated doors are all filed as terminal negatives** (675 copper, 256
  no_service), so a naive once-only law would have blacklisted every promise.
  Monroe (93.9% of sampled payloads FUTURE_QUAL) and Broadway (28.3%) are
  pre-build markets misfiled as dead.

### What shipped

- `shared/futureService.ts` - reads both carriers' future vocabularies, finds a
  provider date by key intent (never `addressCatalogDt`, never an override's
  `dateActive`), parses MON-YYYY, and schedules the one sanctioned re-check.
- `server/comingLedger.ts` - the ledger on `coming_soon_watchlist` with
  `promised_date` / `date_source` / `date_path` / `provider_quote` / `signals`
  / `band` / `due_at`; closes settled, live and now-active rows; expires cold
  ones; and backfills promises out of bodies already paid for.
- `@shared/scanPolicy` once-only law, enforced in `claimRunTargets` so no
  producer can bypass it; rep actions and the coming lane exempt by run kind.
- Sweep ladder: coming due, confirm, street completion, cell flood, probe -
  with seed cities sorted first inside every tier, and no tier buying a door
  another run holds (that guard was missing from `cellTargets`).

### Measured on the production-shaped copy

One cycle: 1,327 promises backfilled (525 dated) for zero provider spend; 157
mislabelled watches closed; 240 confirms; **360 doors on 21 proven-fiber
streets in Broadway, Wingate and Rockwell**; 286 stale runs / 726,722 queued
rows superseded. Ledger: 1,124 active promises, 410 dated - Nov 2026 (105),
Dec 2026 (39), Jan 2027 (10), Feb 2027 (131), Mar 2027 (125).

## Round 3 (2026-08-22): two dates, the account pin, and the planner

- **Two dates, never conflated.** `first_seen_at` = when a scan found the
  promise; `promised_date` = when the provider says it turns on. The backfill
  stamps the original `fiber_checks.checked_at` so a July find is not reported
  as today's, and the flip-window maths is not fooled. `comingSummary` returns
  `foundOn` beside `nextDates`; the tab shows both rows.
- **The account pin.** A door already on the provider's books returns
  `address.localAccountNumber` + `accountTier` + `billingSystem` (1,084 checks,
  959 distinct accounts, Tier 2 on 706 doors) - never read before.
  `server/customerAccount.ts` stores them on scan_targets and the lead sheet
  shows tier + a masked tail. The number is never logged and never leaves the
  server whole.
- **Planner statistics were frozen.** `ANALYZE` ran once behind the
  `analyze_done` latch, so `sqlite_stat1` held stats for ONE scan_targets index
  with the value `0 0 0 0`. The planner walked 919k rows for a 24-hour count the
  range index answers in 9 ms. `PRAGMA optimize` could not help: it only
  reconsiders tables the current connection has queried.
  `reanalyseStaleTable` re-analyses one big table per tick, once a day each, on
  the primary. A sampled ANALYZE was tried and rejected - it still picked the
  wrong index.

Measured, cold, on the production-shaped copy:

| step | before | after |
| --- | ---: | ---: |
| reconcileNowActiveWatches (every cycle) | 2,476 ms | 4 ms |
| sweepSummary (every manager poll, 20 s) | 1,221 ms | 117 ms |
| pending-rows counter | 937 ms | 82 ms |
| 24-hour scan counter | 2,966 ms | 9 ms |

Skills installed at the operator's request: `oracle-*` (five domains from
github.com/oracle/skills - Oracle-specific, so its tuning advice does not
transfer to SQLite) and `sqlite` (from
github.com/martinholovsky/claude-skills-generator). The wins above came from
that skill's method - EXPLAIN QUERY PLAN plus measurement - not from its Rust
examples.

## Result

Built, reviewed, verified; not merged, not deployed. The compose switch is
"on" and `SCAN_GLOBAL_CONCURRENCY` is 6 (rung 1 of the ramp) in the same
change, so the next deploy of the default branch starts paid Decodo/Kinetic
scanning for NC under the bounds in this plan. Remaining risks: the Kinetic
bot-gate that forced concurrency 1 on 2026-07-30 may still be up (the local
suite's incidental mint attempts were 403 via Decodo); if the first cycle's
blocked share is high, set `SCAN_GLOBAL_CONCURRENCY` back to 1 or
`NEIGHBORHOOD_SWEEP` to off, no code change. Prod's `address_points` county
coverage is unknown locally; the E911 bridge is a no-op until counties are
imported. Follow-ups: a one-tap "deploy cluster to crew" on the tab
(`POST /api/scan/deploy` exists), FCC block geometry as a cold-cell signal
outside the seven imported counties, SC after NC.
