# Coming-soon flip algorithm: sellable-only leads, weekly collection, cluster flip

## Outcome

1. A door is published as a lead ONLY when it is sellable as fiber today. A
   TENURED door whose body says `maxQual: "NO QUAL"` /
   `AddressUnserviceableInTerritory` / `FUTURE_QUAL_EXTENDED` with
   `estimatedCompletionDt: "JAN-2027"` is never published as a prospect.
2. Every door carrying a provider promise is on the coming ledger with the
   carrier's own date, and is re-read at least WEEKLY - not parked until two
   weeks before its stated date.
3. When one watched door turns on, every other watched door in its cluster is
   made due immediately at the hot band, so the whole build is re-read within
   one sweep cycle instead of each door waiting for its own slot.

## Context

Terminology: "the list" is `coming_soon_watchlist`, extended by the coming
ledger (`server/comingLedger.ts`) with `promised_date`, `date_source`,
`date_path`, `provider_quote`, `signals`, `band`, `due_at`, `overdue_checks`.

- `shared/futureService.ts` - `readFutureService` (verdict + date discovery) and
  `nextRecheckAt` (band + due_at). Already correct on the JAN-2027 body:
  `isFuture:true, promisedDate:2027-01-01,
  datePath:broadbandService.estimatedCompletionDt`.
- `server/comingLedger.ts` - `recordFutureService` opens/refreshes/closes a
  promise; `dueComingTargets`/`markComingChecked` are its scheduler interface.
- `server/neighborhoodSweep.ts` - the live consumer of that interface
  (`NEIGHBORHOOD_SWEEP: "on"`, `NEIGHBORHOOD_SWEEP_COMING_PER_CYCLE: "300"`).
- `server/comingSoonWatchlist.ts` - a SECOND scheduler over the same table,
  keyed on `last_checked_at` + `urgencyOf` (`COMING_SOON_WATCHLIST`).
- `server/scanEngine.ts:717` - calls `recordFutureService` with the raw body in
  hand; `:949` writes the availability snapshot.
- `server/tenuredLeadProjector.ts` - new 2026-08-23, gates on
  `last_fiber_status='tenured_fiber' AND last_billing_status='N'`. No caller in
  `server/` - only tests. Has never published a lead.

Current behavior measured, not assumed (2026-08-24):

- Probe: the JAN-2027 body reaches `projectTenuredOpenLeads` and is published as
  `tenured_open`, score 60, `lead_status='prospect'`, note "Kinetic fiber at the
  address with no active service on it". Also published when the same door sits
  on `coming_soon_watchlist` with `estimated_completion=2027-01-01`.
- Root cause is upstream: `server/scanner.ts:1287` takes the
  `segment === "TENURED"` branch BEFORE `else if (isFiber)`, so
  `fiberStatus='tenured_fiber'` and `confidence='HIGH'` are set without ever
  consulting `parsed.fiberQualified`. Four lines earlier
  `base.fiberAvailable = isFiber` records the truth, so the row is stored
  self-contradictory.
- `classifyKineticResult` returns `NO_SERVICE` for that body. Two classifiers in
  the repo disagree and the projector trusts the wrong one.
- Local `data.db` under the projector's exact gate: 6,701 candidates; 1,749 with
  `last_fiber_available=1`; 0 with `=0`; **4,952 (74%) NULL** - no recorded
  qualification at all. Only 1,517 have a stored body; of those 49 are provably
  the unserviceable + future-dated class.
- `nextRecheckAt` for a far-future promise returns
  `dueAtMs = eta - hotWindowDays*DAY` and its comment says a far promise
  "should not be polled at all until its window opens". A JAN-2027 door is
  therefore first read in Dec 2026. This is the mechanism by which Georgia Oak
  Ln sat lit and unnoticed for five weeks.
- Nothing propagates a flip across watched siblings. The sweep's cell FLOOD buys
  UNSCANNED doors in a hot ~1 km cell; it does not pull WATCHED promises forward.

## Safety invariants

- Tenant scope every read and write (`tenant_id` on watchlist and scan_targets).
- No new provider calls from this work. Flip propagation only marks rows due; the
  existing sweep lane dispatches under its own per-cycle budget, admission class,
  bandwidth governor, and circuit breaker.
- Bounded fan-out per flip with an explicit cap, and log what the cap dropped.
  No silent truncation.
- Propagation must never throw into the snapshot/money path.
- `is_new_fiber=1` / `fiber_status='new_fiber'` evidence trigger stays untouched.
  A tenured lead remains `is_new_fiber=0`.
- Forward-only additive schema. No destructive migration.
- Do not deploy, and do not run a live or paid scan. Code completion is not
  authorization to collect on these promises in production.

## Milestones

1. **Sellable-only gate.** `tenuredLeadProjector` requires a positive
   qualification and excludes anything with an open promise.
   `npx vitest run tests/integration/tenured-leads.test.ts tests/integration/tenured-coming-soon.test.ts`
2. **Weekly collection.** Cap the far-future wait in `nextRecheckAt` at one week.
   `npx vitest run tests/unit/future-service.test.ts tests/unit/coming-ledger-cadence.test.ts`
3. **Cluster flip.** `propagateFlip` in `comingLedger`, called when a watched
   door's promise closes live.
   `npx vitest run tests/integration/coming-ledger.test.ts tests/integration/coming-flip-propagation.test.ts`
4. **Verification.** `npm run check` + the scanner/lead suites, then
   `$homefront-verify-change`.

## Decisions

- **Gate on `last_fiber_available=1`, not on absence of evidence.** 74% of
  candidates carry NULL. "We never recorded whether fiber is live" is not
  "fiber is live". This drops the publishable set from 6,701 to 1,749 and every
  survivor carries a positive qualification. The NULLs are not lost - they are
  exactly what the weekly lane re-reads.
- **Do not change `scanner.ts`'s `tenured_fiber` in this slice.** Rewriting that
  branch changes `last_fiber_status` semantics for at least six consumers
  (`scannedDoors`, `streetOpportunity`, `scanIntelStore`, `neighborhoodSweep`,
  `scanPolicy`, `yieldEngine`). Kept as its own follow-up so this slice stays
  reversible. Rejected: widening the projector's gate instead - that would leave
  the contradictory column in place for every other reader.
- **Flip propagation marks rows due; it does not dispatch.** Calling the provider
  from inside the snapshot write path would put spend on the money path and
  bypass the governor. Marking `due_at=now, band='hot'` lets the existing lane
  pick them up next cycle (<= one interval).
- **Cluster = radius, not street.** The Georgia Oak Ln build spanned four
  streets (Georgia Oak Ln, Landis Oak Way, Sawtooth Ct, Sandhill Oak Ct). A
  `street_key` cluster would have flooded one of them. Radius default 800 m
  matches `EXPANSION_RING_M`.
- **Weekly cap rather than a new band.** `nextRecheckAt` already returns a band;
  capping `dueAtMs` keeps one cadence vocabulary and leaves the hot/soon/watch
  semantics unchanged.

## Discoveries

- The enrollment path the user asked for mostly EXISTS and is live: the coming
  ledger reads the promise and is wired at `scanEngine.ts:717`, and prod runs the
  sweep's coming lane. The reason zero of the 6,701 candidates are on the list is
  that the ledger shipped 2026-08-22 and those rows were scanned before it;
  `backfillFromStoredEvidence` is the intended remedy and prod sets
  `NEIGHBORHOOD_SWEEP_BACKFILL_LIMIT: "50000"`.
- `tests/integration/tenured-leads.test.ts` hardcodes `last_fiber_available = 1`
  on every fixture, which is why 15 green tests missed the defect.

## Progress

- [x] 2026-08-24 - Traced the chain; proved the defect with a probe (created:1
      where 0 is required, including with an active watch row present).
- [x] 2026-08-24 - Quantified on local `data.db`; wrote this plan.
- [x] 2026-08-24 - Milestone 1: sellable-only gate + 11 tests.
- [x] 2026-08-24 - Milestone 2: weekly floor in nextRecheckAt; 4 cadence tests
      added, 3 existing expectations updated to the new intent.
- [x] 2026-08-24 - Milestone 3: propagateFlip + 9 tests.
- [x] 2026-08-24 - Milestone 4: full verification, 7,359 pass. Fixed the one
      failure (a PRE-EXISTING deferred read-write transaction at
      tenuredLeadProjector.ts:139, present at 4ad92b1 and unrelated to this work).
- [ ] FOLLOW-UP - the qualification column is contaminated; see Discoveries.

## Validation

Each milestone adds a test that fails without its change. The probe at
`scratchpad/coming-soon-probe.test.ts` becomes
`tests/integration/tenured-coming-soon.test.ts` with the assertions kept as
written (`created` must be 0), so the committed suite carries the original
failing case.

## Recovery

Every milestone is an independent commit on `claude/planner-upkeep-first`.
Schema changes are additive `ALTER TABLE`s guarded by existing-column checks, so
a revert of code alone is safe and leaves no unreadable rows. Flip propagation is
a pure UPDATE of `due_at`/`band`; reverting it only restores the slower cadence.
Kill switch: `COMING_FLIP_PROPAGATION=off`.

## Discoveries (cont.)

**The Sawtooth "flip" is not corroborated by any provider body.** Milestone 1's
gate keys on `last_fiber_available=1`, and that column turns out to be reachable
without any qualification evidence. For 1716 Sawtooth Court:

| when | conclusive | fiber_available | status | api_source |
|---|---|---|---|---|
| 2026-07-18 | 1 | 0 | no_service | legacy_scan_target |
| 2026-08-24 03:59 | 1 | **1** | tenured_fiber | `kinetic_legacy:sawtooth-cluster` |

The ONLY stored body for that address is the July one, and it reads
`maxQual: "NO QUAL"`, `techType: ""`, `validationResult:
"AddressUnserviceableInTerritory"`, `broadbandService.qualDesc: "FUTURE QUAL UP
TO 1G"`, `estimatedCompletionDt: "NOV-2026"`. The August row that asserts
`fiber_available=1` stored no body at all, and arrived through
`recordKineticObservation` (`server/kineticObservation.ts:195`) from an ad-hoc
"sawtooth-cluster" ingest - the scan script whose author states it read only
`householdSegmentType`. 49 doors are in this state, and they are exactly the
Georgia Oak Ln / Landis Oak Way / Sawtooth Ct / Sandhill Oak Ct addresses.

So `last_fiber_available` is a necessary gate, not a sufficient one: an ingest
path can set it from a segment label. The remaining work is to stop that at the
source rather than filter it downstream.

## Result

Milestones 1-3 shipped and verified. A door is published only when it carries a
positive qualification and no open promise; every open promise is re-read at
least weekly; a watched door turning on pulls its whole cluster forward.

REMAINING RISK, and it is the important one: `last_fiber_available` can be
written from a segment label by the observation-ingest path, so the 49 doors
above still pass the new gate. The projector has no caller in `server/`, so
nothing is published today - but this must be closed before it is wired, and
before any large scan (e.g. Concord: 70,470 inventory doors, 67,730 never
scanned) runs through the same ingest.
