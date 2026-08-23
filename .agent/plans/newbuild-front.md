# New-build front: scan once, find the clusters first, sweep the footprint

Branch `claude/newbuild-front`, opened 2026-08-22 off `rep-knocking-workflow`
at 548a50b (the merge of PR #173, the neighborhood sweep + once-only + coming
ledger).

## Outcome

Three operator-visible changes:

1. **Scanned once, truly.** An address that has a conclusive provider answer is
   never bought again by any producer, with exactly two exceptions: it carries a
   coming-soon promise that is due, or it carries the qual-extended signal. No
   other tier, cron or fallback may re-buy a door.
2. **The build front, found first.** Clusters the carrier is actively building
   are detected from signals we already collect and worked immediately, ahead of
   the carrier's own team - not after a cluster has been live long enough to show
   up in a monthly sweep.
3. **Whole cities, in depth.** A city that has produced fiber gets its entire
   never-scanned inventory worked, ordered by proximity to known hits, rather
   than only the 0.01 degree cells that already had a hit.

## Context

- Producer: `server/neighborhoodSweep.ts`, pure decisions in
  `shared/neighborhoodSweep.ts`, routes in `server/neighborhoodSweepRoutes.ts`,
  UI in the Fiber Intelligence > Neighborhoods tab.
- The scanning law: `shared/scanPolicy.ts` (`onceOnlyEnabled`, `answeredSql`,
  `isRecheckExemptKind`), enforced in `claimRunTargets`
  (`server/scanIntelStore.ts`) - the one chokepoint every producer funnels
  through.
- The promise ledger: `server/comingLedger.ts` + `shared/futureService.ts` over
  `coming_soon_watchlist`.
- Provider bodies: `fiber_checks.result` (22,242 rows) and
  `kinetic_address_observations`.
- Prior plan: `.agent/plans/nc-neighborhood-sweep.md` (rounds 1-3). Read it
  first; this plan assumes its vocabulary.

### Measured before design (2026-08-22, on the 3.3 GB production-shaped copy)

**The qual-extended vocabulary is single and precise.** Three fields co-occur on
exactly the same **1,030** stored bodies:

| field | value | bodies |
| --- | --- | ---: |
| `broadbandService.technologyType` | `FUTURE_QUAL_EXTENDED` | 1,030 |
| `broadbandService.futureQual` | `FutureQual` | 1,030 |
| `broadbandService.qualDesc` | `FUTURE QUAL UP TO 1G` | 1,030 |

`scan_targets` persists NONE of it. The signal exists only inside
`fiber_checks.result` JSON, so the claim guard cannot currently ask "is this
door allowed a second look?" without parsing JSON per row.

**The footprint gap - CORRECTED 2026-08-23.** The table first published here
mixed carriers and was wrong in its largest row: Durham's 24,252 never-scanned
doors are **Frontier**, not Kinetic, and counting them as Kinetic opportunity
inflated the headline. Frontier is a different carrier and a different product;
it is excluded everywhere below.

NC, kinetic only:

| | doors |
| --- | ---: |
| kinetic doors held | 334,488 |
| scanned | 22,640 |
| never-scanned, in cities that produced kinetic fiber | **167,679** |
| (frontier, excluded) | 36,072 |

**And the hit rate that was applied to it was not sound either.** "14.69%" is a
blend across selection methods over doors the yield tiers deliberately CHOSE.
Split by how the door was picked:

| chosen by | scanned | fiber | rate |
| --- | ---: | ---: | ---: |
| mapbox-grid | 4,983 | 508 | 10.19% |
| live-china grove | 1,580 | 212 | 13.42% |
| live-broadway | 1,023 | 35 | 3.42% |
| harvest-overpass+mapbox | 1,999 | 23 | 1.15% |
| live-concord | 1,159 | 13 | 1.12% |
| live-albemarle | 1,628 | 10 | 0.61% |
| overpass | 1,080 | 0 | 0.00% |
| (leads-backfill, excluded: circular) | 2,226 | 2,225 | 99.96% |

Extrapolating the blend onto cold inventory was the error. The honest figure
comes from scanning cold doors directly: **7.5% sellable** measured on 40
never-scanned Kinetic doors in Rockwell, verified from response bodies.

So the earlier claim that ~$5.62 of proxy bandwidth buys ~24,600 fiber doors is
**withdrawn**. At 7.5% the same 167,679 doors imply on the order of 12,000
sellable - and even that assumes the whole footprint behaves like Rockwell,
which the same night's data contradicts: Rockwell's rural roads ran above 90%
sellable while its town core ran near 7%. A single city-level rate is the wrong
unit. See the street-level split in the Rockwell run.

**`addressCatalogDt` is a real but thin signal.** 4,292 of ~4,600 rows carrying
it say 2019 (the initial catalog load); only 40 are within 24 months. Those 40
have a **50% NEW FIBER rate against 26%** for older ones - strong enough to rank
with, too thin to drive a tier.

## Safety invariants

- Spend: no tier may buy a door that already has a conclusive answer unless the
  door carries a due coming-soon promise or the qual-extended signal. This is
  the operator's explicit instruction and outranks yield.
- Rep actions (`manual`, `target_ids`, lasso, area/bbox, field taps) always
  re-verify and must not be caught by any tightening.
- Tenant scope on every new query and every new index.
- The account number stays server-side and unlogged (see
  `server/customerAccount.ts`).
- Producer changes are control-worker only; HTTP workers must not gain new
  blocking statements (see `.agent/plans/` prod worker stalls work and PR #170).
- Every new query gets `EXPLAIN QUERY PLAN` and a measured time before it ships.
  Statistics and index design first; no `INDEXED BY` hints
  (`~/.claude/skills/sqlite-engineering/references/performance-security.md`).

## Milestones

To be filled from the mapping brief. Expected shape:

1. Persist the qual-extended signal per door and make it queryable.
2. Narrow the re-scan door to exactly the two sanctioned reasons, at the
   chokepoint, with a test per producer that could violate it.
3. The build-front detector: rank and work clusters showing active-build
   evidence.
4. The city footprint tier.
5. Indexes + measurements for all of the above.

## Progress

- 2026-08-22: branch opened; reconnaissance measured; five-lens read-only
  mapping workflow plus a completeness critic completed (35 agents, ~1.1M
  tokens). Findings folded into Discoveries below.
- 2026-08-22: two production defects found while validating and split into
  PR #174 (Decodo sticky egress by port + planner statistics with their own
  owner). Local end-to-end scanning of Rockwell attempted and abandoned as a
  measurement environment - see Discoveries.

## Decisions

- Deferred until the mapping brief lands: whether the CONFIRM tier can be
  deleted outright. It re-buys ~4,036 known NEW FIBER doors so the projector
  will publish them, which requirement 1 forbids. The question that decides it
  is whether those doors can be published from evidence already stored, with no
  new check.

## Design: why requirement 1 and requirement 2 are the same mechanism

Requirement 1 (never scan twice) and requirement 2 (find new-build clusters
first) look opposed, and the tension is worth stating plainly because it
determines the whole design:

**Under a strict once-only law we can never detect a flip on a door we have
already scanned.** A door that answered "no service" in July is never bought
again, so if the carrier lights it in September we will not learn that from
that door. The only doors we are permitted to re-read are the ones carrying a
coming-soon promise or the qual-extended signal.

That is not a limitation to work around - it is the answer. Those signals are
the carrier telling us, in its own API, where it is currently building. So:

- **The build front IS the qual-extended population.** 1,030 doors carry
  `FUTURE_QUAL_EXTENDED`. Group them into 0.01 degree cells: each such cell is a
  place the carrier has committed plant to and has not yet turned up.
- **Watch the front, not the field.** Re-read only the qual-extended and
  promised doors (rule 1 permits exactly these), at a cadence set by their band.
  That is a small, bounded, sanctioned spend.
- **When one flips, take the whole cluster the same cycle.** The instant any
  watched door in a cell answers live, every NEVER-SCANNED door in that cell and
  its neighbours is enqueued at top priority. Those are first scans, so the
  once-only law does not touch them, and there is no cheaper way to be early.

On "before the internal team": we cannot beat the carrier to the information -
it owns the build schedule. What we can beat it on is LATENCY, and that is the
metric this tier optimises: time from "the provider's API first answers live at
this address" to "a rep is standing at the door". A watch cadence measured in
hours on a bounded front, plus same-cycle cluster flooding, is the shortest
achievable path given rule 1.

This also means the CITY FOOTPRINT tier (requirement 3) carries no rule-1
tension at all: those ~180,000 doors have never been scanned once.

## Discoveries

### The confirm tier can be deleted outright: nothing needs a fresh check

Measured over the 5,451 known-NEW-FIBER doors with no lead (kinetic + billing N
= 4,481):

| | doors |
| --- | ---: |
| Publishable/linkable from stored evidence, ZERO provider spend | **586** |
| Need only a `converted_to_lead_id` reconciler, zero spend | 3,895 |
| **Require a fresh check to produce a new rep-visible lead** | **0** |

One confirm pass costs $0.135 and buys 7 new pins. The same 4,036 checks spent
on never-scanned inventory buy roughly 593 at the measured 14.69% NC kinetic
hit rate. The tier goes, which satisfies requirement 1 and yields more leads -
not a trade-off.

### Why leads dry up: a 30-day retention clock under an infinite one

`availability_snapshots` is pruned at 30 days (`server/dbPrune.ts:68`, applied
at `:463`) while `fiber_checks` - the evidence it is derived from - is kept
forever by explicit design (`server/dbPrune.ts:40-46`). The lead projector
(`server/freshFiberProjector.ts:102-133`) reads ONLY the pruned table. So a
door scanned in July stops being publishable in August although we still hold
its body.

Proved rather than inferred: `applyConclusiveLifecycle` runs only on a
successful snapshot insert (`server/availabilitySnapshot.ts:113-115`), so a
target carrying `lifecycle_state` must once have had a snapshot. **3,214
kinetic targets carry one and have no snapshot.** A prune run on 2026-08-22
removed 796 more. Also: `availability_corroboration` has **0 rows**, so
`evidenceDecision.confirmed` is structurally dead and every publish in the
system goes through the `authoritativeFresh` branch alone.

**Fix retention (or let the projector fall back to the stored body) before or
with any backfill, or the work is a treadmill.**

### Requirement 2 has no training data

Across 1,847 canonical keys with a non-error negative followed by a later body,
genuine negative-to-fiber flips number **zero**. The 26 apparent flips all
share the prior body `Not Frontier-serviceable (ESB Env/Ctrl Error)`, all land
on 2026-08-06, and sit in two cells. 3,513 of 22,296 bodies (15.8%) are
transport errors persisted as answers; 1,264 doors are sealed as negatives by
one. A detector trained on flip history has a training set of size zero.

Three build markers are not read at all today: `address.newConstInd='Y'` (311
addresses), `plantType='GREENFIELD'` (201) and ADTN25/26 ONT serials (reachable
only by double-parsing `uqualProvisioningResult`, which is a nested JSON
*string*). With qual-extended the union is 1,396 addresses -> 172 cells, 415
streets, **17,213 doors, 8,871 never scanned**.

Ship an instrumented watch with a labelled holdout tied to the NOV-2026 cohort,
not a scoring model.

### Requirement 1 cannot be met by run kinds alone

Computing the projector's canonical key over all 919,688 rows: **27,232
duplicate groups** (same key, more than one `scan_targets` row), 27,235 excess
rows, and **2,534 doors already bought twice**. Qual-extended doors are heavily
over-represented: 315 of 938 sit in duplicate groups against a 3.0% baseline.
Separately, `isRecheckExemptKind` is 13 substring tests with no allowlist:
`state-monitor` matches `monitor` and carries 2,388 queued targets of which
2,213 are already answered. **2,245 queued doors would be re-bought today on a
substring collision.** Two planes never reach the chokepoint at all
(`server/kineticScannerWorkers.ts:64-71` nightly, and the `POST /api/scan/*`
routes).

### Addressable work, three numbers

- qual-extended build front: 9,646 doors (5,450 never scanned), 78 cells
- city footprint: 188,357 doors (167,710 never scanned) across 23 kinetic cities
- new-build marker union: 17,213 doors (8,871 never scanned)

### The local box is not a measurement environment for scanning

Attempting Rockwell locally produced confounded results and cost real Decodo
bandwidth. Causes, all of them local-only: no `curl-impersonate-chrome`, so
minting falls to the weakest rung; the fleet-shared 403-storm backoff
accumulates across runs (34 events x 15 s in one run, which reads as slowness,
not denial); and runs killed mid-flight leave their targets `queued` under a
still-`running` run, so later runs select **zero** doors and report a
meaningless "no denials". Always re-check `selected=N` before believing a rate.
See [[decodo-sticky-is-a-port]].

- The re-scan rule the operator asked for maps almost exactly onto the ledger
  that already exists: a qual-extended door produces a `coming_soon_watchlist`
  row today (`futureQual` -> `future_qual` signal -> `isFuture`), and so does a
  coming-soon door. So "never scan twice unless coming-soon or qual-extended"
  can be enforced as "the ledger is the only thing that may authorise a second
  check", rather than as a new parallel mechanism. To be confirmed against the
  1,030 measured bodies.

## Validation

To be filled. Baseline: `npm run check`, `DATA_DIR=$(mktemp -d) TZ=UTC npm test`
(571 files / 7,224 tests green at 548a50b), `npm run build`, plus a dry-run
cycle on the production-shaped copy per the recipe in
`.agent/plans/nc-neighborhood-sweep.md`.

## Recovery

Nothing here mutates production. Dry runs use a copy under the session
scratchpad. If a tier misbehaves after deploy, every knob is an env var in
`docker-compose.production.yml`; setting the tier's per-cycle cap to 0 disables
it with no code change.

## Result

Pending.
