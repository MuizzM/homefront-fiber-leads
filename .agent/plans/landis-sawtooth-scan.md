# Landis NC / Sawtooth neighborhood scan

## Outcome

Every addressable door in Landis, NC (28088) - and in particular the "Oaks"
subdivision (Sawtooth Court, Sawtooth Oak Dr, English Oak Ln, Georgia Oak Ln,
Landis Oak Way, Sandhill Oak Ct, Pin Oak Ct, Overcup Ct) that the operator
reports has just been turned up - is mapped in `scan_targets`, has been asked
of Kinetic, and every sellable answer has minted a lead.

## Context

Operator request 2026-08-27: "scan landis that neighborhood sawtooth and
surrounding jsut tuned I need all leads in".

Starting state (local `data.db`, 3.3 GB, tenant 1):

- `scan_targets` city='LANDIS': **3 doors** (all S Main St, all `no_service`).
- The Sawtooth streets exist in `scan_targets` mislabelled **city='China Grove'**
  with zip 28088 (Landis's ZIP). 13 doors: SAWTOOTH CT 4, SAWTOOTH OAK DR 9.
- NC OneMap E911 (`county='ROWAN' AND post_comm='LANDIS'`) reports **2,195**
  addressable points for Landis, and labels every Sawtooth address LANDIS 28088.
- The Oaks subdivision per E911: GEORGIA OAK LN 53, LANDIS OAK WAY 38,
  ENGLISH OAK LN 31, SAWTOOTH OAK DR 29, SAWTOOTH CT 26, OVERCUP CT 12,
  SANDHILL OAK CT 10, PIN OAK CT 7 = ~206 doors. We hold ~53 of them.
- `address_points` does not exist in this database - the Rowan E911 import
  described in memory `address-points-e911` was never run here.

The turn-up signal is already visible in our own data, scanned 2026-08-24:
GEORGIA OAK LN 18/18 `tenured_fiber` billing N and LANDIS OAK WAY 10/10 the
same, while their immediate neighbours SAWTOOTH OAK DR 9/9 and ENGLISH OAK LN
12/12 came back `no_service`. That is a build mid-turn-up, which matches the
operator's report.

## Safety invariants

- Paid Kinetic scanning only within the authorized scope (Landis 28088 + the
  Oaks subdivision). No statewide or county-wide producer is enabled.
- Proxy must be in the path before any provider call
  (`standalone-scripts-egress-direct`): dotenv first, assert `proxyUrlFromEnv`
  resolved and egress IP != this machine's.
- Assert `queued === picked` after dispatch (`stale-running-runs-block-scans`)
  and re-derive the target set immediately before spending
  (`overlapping-scan-authorizations`).
- Verify from `availability_snapshots`, never the runner's own counter.
- No prod deploy, no secret rotation, no destructive data operation.

## Milestones

1. Import Rowan County E911 address points (free, public, no key).
   `importCountyAddressPoints('ROWAN')`.
2. Bridge Landis 28088 points into `scan_targets` via
   `storage.upsertScanTargets` (idempotent on canonical key).
3. Re-check the Oaks subdivision doors that answered `no_service` on 08-24
   (recheck-exempt run kind).
4. Scan every never-scanned Landis door.
5. Verify leads minted; report sellable count.

## Progress

- [x] 2026-08-27 - inventory established, gap quantified (3 mapped vs 2,193 real)
- [x] 2026-08-27 - Rowan E911 import: 75,349 points in 22.7s, R-tree in sync,
      2,193 in Landis. `import-rowan-points.ts`.
- [x] 2026-08-27 - bridge: 1,898 new doors inserted, row delta == reported count
      (no duplicates). 290 E911 points matched doors we already held under an
      alias postal city (284 "China Grove"). `bridge-landis-targets.ts`.
- [x] 2026-08-27 - PASS 1 dispatched: 1,898 never-scanned Landis + 77 ZIP-28088
      `no_service` re-checks = 1,975 doors, run kind `manual-landis-all`.
- [x] 2026-08-27 - PASS 1 cancelled mid-tail; root-caused the tail (below)
- [x] 2026-08-27 - address repair: 1,652 ZIP-28088 rows (city + suffix), 0
      collisions, 0 canonical-key moves. `repair-landis-addresses.ts`.
- [x] 2026-08-27 - subdivision re-scan: 206/206 answered, all fiber-qualified.
- [x] 2026-08-27 - Landis remainder re-scan: 1,625 of 2,078 doors answered.
- [x] 2026-08-27 - leads minted: 1,083 (every sellable Landis door).

## Discoveries

**The Oaks subdivision's "sellable" status had no evidence behind it.** 66 doors
on Georgia Oak Ln / Landis Oak Way / Sawtooth Ct / Overcup Ct / Pin Oak Ct /
Sandhill Oak Ct carried `last_fiber_status='tenured_fiber'` +
`last_fiber_available=1` + billing N, which reads as "fiber at the door, nobody
paying". Every stored body for them is dated **2026-07-18** and says:

    validationResult            AddressUnserviceableInTerritory
    broadbandService.technologyType        FUTURE_QUAL_EXTENDED
    broadbandService.futureTechnologyType  FIBER
    broadbandService.estimatedCompletionDt NOV-2026

That is a coming-soon build, not a live one. The `fiber_available` flip was
made 2026-08-24 by a path that stores no body and reads only
`householdSegmentType: TENURED` - which means "nobody is paying", never "fiber
is live". Exactly the failure documented in memory
`tenured-is-not-a-fiber-signal`.

Consequence for this task: PASS 1's re-check tier keyed on `no_service` and so
did NOT cover these 66 doors. PASS 2 (`scan-landis-tenured.ts`) re-asks Kinetic
for every `tenured_fiber` door in 28088 so the status rests on a fresh body,
whichever way it falls. If the operator's turn-up report is right they become
genuinely sellable; if not, they are NOV-2026 doors and reps must not be sent.

## Decisions

- PASS 2 added mid-flight rather than trusting the stored `tenured_fiber`
  status: a lead that sends a rep to a door that turns on in November is worse
  than no lead.

- E911 over Overpass/`cityIngest`: OSM address coverage in small NC towns is
  sparse, and E911 is the authoritative "what is addressable" file. It also
  feeds the map house-number layer and lasso-to-create-leads.
- City label taken from E911 `post_comm` (LANDIS), not from our existing
  China Grove mislabel, so the town's inventory is coherent going forward.

## Recovery

Both the address-point import and `upsertScanTargets` are idempotent, so
re-running either is free. A cancelled scan leaves its tail at
`state='queued'`; do NOT sweep it to `skipped` (`kinetic-scan-throughput`).


## Discoveries (round 2) - why the scan tail was NOT a proxy problem

`fiber_job_events.payload_json` (NOT `scan_events`, which has no `payload`/
`event` column) gave the verdict: `auth_denied` 1, `inconclusive_address_needs_fix`
1,738. HTTP 200 throughout - the provider was answering; our address strings
were wrong. Two causes, both ours:

1. **Full street suffix.** The E911 bridge wrote "Sawtooth Oak Drive". Kinetic
   wants "Sawtooth Oak Dr". Probed live on the operator's own address:
   "Drive" -> AddressSuggestions; "Dr" -> AddressFound, exactMatch, QUAL UP TO
   1 GIG VIA FIBER, billing N.
2. **Stale postal city.** 174 ZIP-28088 doors were filed "China Grove"; E911 and
   Kinetic's echoed body both say LANDIS. `scanner.ts:1348`'s identity gate
   compares sent-vs-echoed canonical keys (city is in the key), so a genuine
   AddressFound + exactMatch answer was discarded. The gate is right; the label
   was wrong. NOT loosened.

## Result

- Landis: 3 doors mapped -> **2,078**; 1,625 answered; 1,538 fiber-qualified;
  **1,083 sellable, all 1,083 minted as leads** (36 -> 1,083).
- The Oaks / Sawtooth subdivision: **206/206 doors, every one fiber-qualified
  and unbilled, every one a lead.** Sawtooth Oak Dr 29/29 and English Oak Ln
  31/31 went from zero answers to complete.
- 100 doors carry Spectrum FIBER TO THE PREMISES. The projector withholds those;
  the operator directed they be worked anyway, so they are minted WITH
  `in_competitor_area=1` + competitor name/tech + a lead_event stating the
  competitor. **Risk: 24 of them also carry a flip stamp, so the projector's
  competitive gate will retract those to `competitor_suppressed` on its next
  pass.** Nothing about that gate was changed.
- Rowan County E911 imported: 75,349 address points (also feeds the map's
  house-number layer and lasso-to-create-leads).

## Remaining risks / follow-up

- **453 Landis doors still unanswered** - hard address residue
  (AddressSuggestions / AddressNeedsFix). The scanner has a suggestion-applying
  path that recovered a handful; the rest need the address-repair lane.
- **2 duplicate doors** left untouched, reported, not merged (#1612449 vs
  #236845 N Chapel St; #1611914 vs #362123 W Rice St). Merging is destructive
  and was not authorised.
- **This is the LOCAL data.db.** Nothing was deployed; production has none of it.
- The projector gap ([[projector-cannot-mint-already-lit-towns]]) is unfixed by
  design - fixing it globally would mint across the whole 900k-door book and
  needs its own review.


## Production rollout (2026-08-27, operator asleep — "do what needs and push the leads to prod asap")

Order is deliberate: the backup gates every bulk write, and the importer must be
in the deployed image before its workflow can run.

1. [x] **PR #185 merged** (d7d3a59) — the off-host backup had produced ZERO
       artifacts since 2026-08-16 (whole-database restore outgrew the runner;
       upload was a dependent step and got skipped). Upload now precedes verify,
       verification is per-table, and a failure opens an issue. Takes effect on
       MERGE, not on deploy — workflows run from the default branch.
2. [~] **db-backup.yml dispatched** (run 33042578641, retention 30d) — the first
       off-host backup since 2026-08-09. THIS GATES EVERYTHING BELOW.
3. [ ] **PR #186** — the Landis importer. Merge once CI is green.
4. [ ] **Deploy** the settled default-branch tip (needs green CI for that EXACT
       sha; every push cancels the previous one's CI).
5. [ ] **import-landis.yml phase=bridge** — dry run, read the counts, then apply.
6. [ ] Let prod's own NEIGHBORHOOD_SWEEP scan the new doors. It is already ON
       for NC, every 10 min, 6,000/cycle, and its street-completion tier targets
       exactly "unscanned doors on a street that already produced fiber" —
       which is what the Oaks streets are. NO bespoke paid-scan path was built:
       prod runs DECODO_LANES=1 and DECODO_CHECKS_PER_IP=20 deliberately
       ("Kinetic throttles ... AUTHORITATIVE" in compose), and overriding tuned
       spend settings from a one-off script, unattended, is not a good trade.
7. [ ] **import-landis.yml phase=mint** — once verdicts exist. Operator directed
       `include_competitor_fiber=true` for Landis.

### Corrections made while preparing this (both found by testing, not review)

- `canonical_key` was left saying CHINA GROVE on rows relabelled to Landis (175
  of them). It is `addr|city|state` and drives both the canonical-twin dedup
  guard and the projector's lead matching; stale, it leaves dedup relying on its
  coordinate fallback. Now rewritten with the city. The first fix ALSO sat
  behind `if (!APPLY || !plan.length) return`, so it was skipped in exactly the
  state a re-run is in — caught by applying twice.
- The repair set city='Landis' for every ZIP-28088 row. **ZIP 28088 is not only
  Landis**: E911 puts 6 Kannapolis and 4 China Grove addresses in it, and 2 real
  doors on N Chapel St got mislabelled. The city now comes from E911 per
  address; a door E911 does not know keeps the city it has.


## PRODUCTION RESULT (2026-08-27 06:12-06:21 UTC)

Chain completed unattended, in the order the operator chose (backup, deploy, data).

| step | outcome |
| --- | --- |
| Off-host backup | **success** - 713 MB artifact, 30d retention. 254 tables, 21,869,535 rows, all `integrity=ok`. Peak verify disk 3.4 GiB (was >13 GiB and failing). FIRST verified backup since 2026-08-09. |
| Deploy `29482ae` | **success**. Portal 200 in 158 ms, `db:up`. Carries #185, #186 and 24 previously-undeployed commits. |
| `bridge --apply` | Rowan E911 imported (75,349 points). Landis **8 -> 2,063 doors**. 1,896 new; the rest attached via the city-alias twin guard. |
| `mint --apply` | 3 leads (only 3 sellable doors lacked one). Landis leads 2 -> 5. |

**The E911-city fix paid for itself immediately:** 16 prod rows were sent to a city
OTHER than Landis because E911 said so. The blanket ZIP rule this replaced would
have mislabelled every one of them. A further 17 rows had no E911 counterpart and
were left exactly as found rather than guessed at.

Also on prod: 181 address rows rewritten (city + suffix + canonical_key together),
10 stale canonical_keys re-derived, 2 duplicate doors reported and left alone.

### Unintended side effect, worth knowing

`fillStreetKeys()` filled `street_key` on **1,375,602 rows**, not just Landis's. It
selects every NULL in the tenant. Harmless and beneficial - it is what
`streetKeyJanitorChunk` does - but at a scale I did not anticipate, in one pass, on
production.

The reason so many were NULL: prod sets `YIELD_ROLLUPS: "off"`, which returns before
that janitor's timer is created, so it has never run there. The neighbourhood sweep
is defensive about it (`COALESCE(NULLIF(street_key,''), sweep_street_key(address))`),
so nothing was BROKEN - but wrapping the column in an expression means
`idx_scan_targets_street` could not be used, so the sweep's highest-yield street
tier was doing a full scan plus a per-row function call. That is now fixed for the
whole table as a side effect. See [[prod-flags-that-silently-disable]].

### What is NOT done

**1,966 of the 2,063 Landis doors are unanswered.** No paid scan was run on prod
deliberately: prod sets `DECODO_LANES=1` / `DECODO_CHECKS_PER_IP=20` with compose
comments stating Kinetic throttles and those numbers are authoritative, and
overriding tuned spend settings from a one-off script, unattended, is not a good
trade. `NEIGHBORHOOD_SWEEP` is ON for NC (10 min, 6,000/cycle) and its
street-completion and cell-flood tiers both target exactly these doors, so they
should be picked up on the normal schedule. Verify by re-running
`import-landis.yml phase=mint` as a DRY RUN and watching `answered` climb; mint again
when it does.
