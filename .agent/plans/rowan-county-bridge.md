# Rowan County E911 bridge

## Outcome

`script/import-rowan.ts` puts Rowan County's E911 door inventory into
`scan_targets` for every postal community in the county, spelled the way Kinetic
answers, labelled with the city E911 says, and deduplicated by the guards that
already exist in `storage.upsertScanTargets`. Dry run is the default; nothing is
written without `--apply`; no provider call is made without a second, explicit
authorization flag.

Operator-visible result: the towns below stop being unscannable because their
doors are simply absent from the database.

## Context

Measured on the local `data.db` (tenant 1) on 2026-08-27:

| city | E911 points | scan_targets rows | of which canonical_key NULL |
|---|---|---|---|
| SALISBURY | 39,789 | 526 | 287 |
| KANNAPOLIS | 8,349 | 5,463 | 1,326 |
| CHINA GROVE | 7,541 | 3,910 | 2,958 |
| ROCKWELL | 4,601 | 5,265 | 47 |
| CLEVELAND | 2,243 | 932 | 909 |
| LANDIS | 2,193 | 2,076 | 2 |
| SPENCER | 1,775 | 0 | 0 |
| GRANITE QUARRY | 1,657 | 1 | 1 |
| MOORESVILLE | 1,487 | 12,431 | 8,745 |
| WOODLEAF | 1,322 | 5 | 2 |
| MOUNT ULLA | 1,239 | 194 | 194 |
| GOLD HILL | 1,136 | 21 | 3 |
| EAST SPENCER | 990 | 0 | 0 |
| RICHFIELD | 515 | 20 | 0 |
| FAITH | 439 | 0 | 0 |
| DAVIDSON | 64 | 216 | 12 |
| NEW LONDON | 9 | 37 | 5 |

75,349 E911 points in total. `fcc_block_footprint` (tenant 1, vintage D25,
county_fips 37159) records 17,673 Kinetic FTTP locations in the county.

Relevant files:

- `server/addressPointStore.ts`, `server/addressPointImport.ts` — the E911 table
  and its NC OneMap importer. `address_points.city` **is** `post_comm`;
  `address_points.street` carries the house number and any unit clause.
- `server/storage.ts:5481` `upsertScanTargets` — owns both dedup guards.
- `shared/addressKey.ts` — `canonicalAddressPart`, `streetKeyOf`,
  `normalizeKineticAddressKey`. One normalization, shared.
- `rockwell-bridge.ts` (main checkout, untracked) — the verified one-town bridge
  this is modelled on. Rockwell 3,073 -> 5,265 doors on 2026-08-27.
- `script/import-landis.ts` — the phase/flag shape, the E911-city rule (6f58b5e),
  and the reason raw SQL is not used.
- `rockwell-probe-spellings.ts` (main checkout, untracked) — the provider-call
  guards a probe must carry: dotenv first, proxy resolved, egress IP != this
  machine's.

## Safety invariants

1. Tenant-scoped. Every read and write carries `tenant_id`; default 1.
2. Free by default. The bridge makes **no** provider call. The probe phase
   prints its plan and its exact call count and dials only when
   `--authorize-provider-calls` is passed *and* `KFS_AUTOMATION_AUTHORIZED=true`
   *and* the proxy egress IP differs from this machine's.
3. Dry run by default. `--apply` is the only thing that writes.
4. Local database only. `--apply` refuses when `NODE_ENV=production` or when the
   resolved `dbPath` is under `/data`.
5. Never raw SQL for door inserts. Every door goes through
   `storage.upsertScanTargets` so both dedup guards apply.
6. Non-destructive. The only writes are inserts of new doors, `canonical_key`
   NULL -> non-NULL, and `street_key` NULL -> non-NULL. Nothing is merged,
   deleted, relabelled, or rewritten.
7. WAL-friendly. Short `BEGIN IMMEDIATE` batches with a pause between them, so a
   concurrent scan run is not starved of the write lock.

## Milestones

1. **Plan phase (free).** Per-town inventory, normalization diff, unproven-fold
   count, unit exclusions, held-row/E911 city disagreements.
   `npx tsx script/import-rowan.ts --phase plan`
2. **Probe phase (paid, separately authorized).** A bounded set of spellings per
   town, dialled only with `--authorize-provider-calls`.
   `npx tsx script/import-rowan.ts --phase probe --city "Granite Quarry"`
3. **Bridge phase.** canonical_key backfill in scope, then upsert, then
   street_key fill.
   `npx tsx script/import-rowan.ts --phase bridge --city Spencer`
   `npx tsx script/import-rowan.ts --phase bridge --city Spencer --apply`
4. **Regression tests.** `tests/rowanBridge.test.ts` pins the normalization and
   the two dedup outcomes that matter.

## Decisions

- **Unit/comma addresses are excluded by default.** 6,793 of the 75,349 E911
  points carry a `, UNIT x` / `, BUILDING y` clause and they sit on only 1,342
  premises (one Salisbury complex has 240 units at 2715 Statesville Boulevard).
  `streetKeyOf` cuts the address at the first unit token, so every unit at a
  premise shares a street_key *and* a house number; the postal-city alias-twin
  guard then matches on coordinates within ~25 m and absorbs unit 102 into unit
  101's row. Proven, not inferred — see Discoveries. Importing them would
  produce a partial, coordinate-ordered, non-deterministic inventory that reads
  as complete. `--include-units` opts in once the guard is fixed.
  **UPDATE 2026-08-27: the guard is fixed** (PR #191,
  `.agent/plans/unit-aware-premise-twin.md`) - it now confirms the full
  canonical address, so units no longer absorb. `--include-units` stays opt-in,
  but the reason is now scope and spend (6,793 more doors on the nightly
  re-probe), not correctness.
- **The canonical_key backfill is scoped to the cities being written**, not the
  whole tenant. The canonical-twin guard keys on `addr|city|state`, so only rows
  in a target city can collide with a door we are about to write. A tenant-wide
  backfill exists as separate work (`script/backfill-scan-target-canonical-keys.ts`
  on `f-/cranky-ptolemy-05d0da`); running it first makes this step a no-op,
  because the predicate is `canonical_key IS NULL` either way.
- **Held rows whose city disagrees with E911 are reported, not relabelled.**
  Relabelling moves `canonical_key` on existing rows, some of which carry leads;
  `script/import-landis.ts` did it for one ZIP under direct instruction. County
  scale is a separate, authorized decision.
- **Route folds carry an evidence tag.** Rockwell measured two spellings. Rowan
  has eleven route street-names. Folds that Rockwell's measurement does not
  cover are applied by analogy and reported as UNPROVEN with a door count, so
  the operator knows exactly what rides on an untested spelling.

## Discoveries

**The alias-twin guard merges distinct units at one premise.** Reproduced on a
pristine `DATA_DIR` on 2026-08-27:

```
upsertScanTargets  "2715 Statesville Blvd Unit 101" (35.6700,-80.5200) -> 1 new row
upsertScanTargets  "2715 Statesville Blvd Unit 102" (35.6700,-80.5200) -> 0 new rows
upsertScanTargets  "2715 Statesville Blvd Unit 240" (35.67015,-80.52015) -> 0 new rows
upsertScanTargets  "2717 Statesville Blvd"          (35.6700,-80.5200) -> 1 new row
final table: #1 "2715 Statesville Blvd Unit 101", #2 "2717 Statesville Blvd"
```

`server/storage.ts` says of that guard: "distinct units differ in street_key's
retained unit token and never merge." `streetKeyOf` does not retain the unit
token — it cuts at it (`shared/addressKey.ts`, `STREET_UNIT_TOKENS`). The
comment describes behavior the code does not have. Fixing it changes dedup for
every caller of `upsertScanTargets` and is out of this task's scope; it is
recorded here and reported to the operator.

**RESOLVED 2026-08-27 (PR #191, `.agent/plans/unit-aware-premise-twin.md`).**
Both twin guards now compare the full canonical address (house + street + unit).
The same defect was found in `server/scanTargetCanonicalMerge.ts`, where it
DELETES rows rather than skipping an insert: 943 of 6,696 queued pairs were not
the same door, putting 655 real doors at risk. `rowanBridge.test.ts` has been
flipped to pin the corrected behavior.

**E911 distinguishes the two sides of a divided US highway by directional, and
we hold one row for both.** Rowan E911 carries both
`1965 NORTH UNITED STATES HIGHWAY 29 HIGHWAY` and
`1965 SOUTH UNITED STATES HIGHWAY 29 HIGHWAY`; the database holds a single
`1965 US Route 29`. Dropping the directional to match the spelling we already
have would merge two distinct premises; keeping it produces a spelling nothing
has measured. Probe, do not guess.

**Free evidence for route spellings already exists in the answered rows.**
Grouped over the Rowan-area cities, spellings and their conclusive-answer rate:
`E NC <n> HWY` 151/151, `US ROUTE <n>` 70/70, `US HWY <n>` 22/22,
`US <n> HWY` 18/18, `CHINA GROVE HWY` 51/51. The raw E911 forms
(`SOUTH UNITED STATES HIGHWAY <n> HWY`, `NORTH CAROLINA HIGHWAY <n>`) have 0
scanned rows between them, so they are unproven in both directions.

## Validation

- `npm run check` (typecheck).
- `DATA_DIR=$(mktemp -d) npx vitest run tests/rowanBridge.test.ts`.
- `--phase plan` and `--phase bridge` dry runs against the local `data.db`,
  read paths only.

## Recovery

The bridge is re-runnable. Inserts are guarded by the two dedup guards plus the
raw-string unique index; the backfill and the street_key fill are both
`IS NULL ->` writes. An interrupted `--apply` leaves a partial but consistent
inventory and the next run continues from it. There is nothing to undo, because
nothing is overwritten.

## Progress

- 2026-08-27 — measurement, design, and the alias-twin reproduction complete.
- 2026-08-27 — `script/import-rowan.ts` written; all three phases exercised as
  dry runs against the local `data.db`.
- 2026-08-27 — `tests/integration/rowanBridge.test.ts` added, 12 tests green.
- 2026-08-27 — `bash scripts/agent-verify.sh focused` green (harness validator,
  deployment-safety, `tsc`, `tsgo`, 16 tests).
- 2026-08-27 — `bash scripts/agent-verify.sh full` green (exit 0: whole Vitest
  suite plus `npm run build`).
- 2026-08-27 — `--apply` exercised twice end to end on a pristine `DATA_DIR`
  seeded with six Rowan E911 points and one legacy NULL-key row: first run
  stamped the key, held the unit door back, and inserted 4 doors with
  street_key and canonical_key set; second run inserted 0 and filled the legacy
  row's NULL street_key. Nothing was applied to the real local database.

## Result

### Applied 2026-08-27 (local `data.db`, tenant 1)

Town by town, empty towns first, then Salisbury, then the rest.

| city | before | after | new rows |
|---|---|---|---|
| Salisbury | 526 | 34,156 | 33,630 |
| Kannapolis | 5,463 | 13,220 | 7,757 |
| China Grove | 3,910 | 9,312 | 5,402 |
| Mooresville | 12,431 | 13,835 | 1,404 |
| Rockwell | 5,265 | 5,265 | 0 |
| Cleveland | 932 | 3,097 | 2,165 |
| Landis | 2,076 | 2,096 | 20 |
| Spencer | 0 | 1,547 | 1,547 |
| Granite Quarry | 1 | 1,425 | 1,424 |
| Mount Ulla | 194 | 1,411 | 1,217 |
| Woodleaf | 5 | 1,317 | 1,312 |
| Gold Hill | 21 | 1,135 | 1,114 |
| East Spencer | 0 | 773 | 773 |
| Richfield | 20 | 532 | 512 |
| Faith | 0 | 390 | 390 |
| Davidson | 216 | 280 | 64 |
| New London | 37 | 46 | 9 |

31,097 -> 89,837 rows under a Rowan postal-community label; 58,740 new doors.
Rockwell adding 0 is the idempotency check against work already done by
`rockwell-bridge.ts`.

**Coverage audit - nothing was lost.** For eleven towns every importable E911
door resolved to a row: most under its own canonical key, the rest attached by
the alias-twin guard to a premise we already held under another postal city
(Faith: Salisbury 24 + Rockwell 4; Salisbury 386; China Grove 242; Granite
Quarry 54). The only two neither lookup found - `220 Pine Ridge Rd` and
`1 Hitachi Metals Dr`, both China Grove - are present as uppercase
`address_discovery` rows carrying a pre-v3 four-part canonical key
(`220|PINE RIDGE RD||28023`); the raw-string unique index caught them and the
upsert enriched them instead of inserting. 57,863 tenant-1 rows carry that stale
key format, which is a canonical-twin blind spot worth its own pass.

### Probe round 1 (paid: 17 live calls, ~1 IP + token pair)

`--phase probe --routes-only --apply --authorize-provider-calls`. Full results
are in the script header. Two findings stand:

- **US 29 wants the directional DROPPED.** `2325 US Hwy 29` -> FIBER, billing N;
  `2325 S US Hwy 29` and E911's raw form -> FAILED. Same house, same minute, no
  cache hits (every call 1.2-2.6 s on the wire). Only 1 of 107 US-29 house
  numbers in the county appears on both sides within the same city, so dropping
  the directional costs almost nothing.
- **The bare `Nc <n> Hwy` fold is right on NC 153.** `880 Nc 153 Hwy` -> FIBER,
  billing N; the raw E911 form -> FAILED.

Every other candidate failed in pairs, which on one house cannot distinguish a
bad spelling from a house Kinetic does not serve. No fold was changed on that
evidence; the 765 doors stay flagged unproven until a second house is bought.

### Pre-apply dry-run numbers

- 68,556 doors to upsert (75,349 E911 points less 6,793 unit doors held back).
- 8,149 of them are already held under a matching canonical key; 60,407 are
  unmatched, which is an upper bound on new rows because the alias-twin guard
  only runs on a write.
- canonical_key backfill in scope: it found 14,491 NULL rows (12,375 keyable,
  2,116 already-duplicate) at 11:12, and 0 at 11:19 — the tenant-wide backfill
  on `f-/cranky-ptolemy-05d0da` was applied to the local database in between,
  taking tenant 1 from 292,999 NULL keys to 0. The bridge's own step correctly
  reported "0 NULL in scope" and did nothing, and the door match counts were
  identical before and after, which is the check that the two derivations agree.
- 765 doors ride on one of 7 route spellings no provider call has confirmed:
  `W Nc 152 Hwy` (271), `Nc 801 Hwy` (206), `Old US Hwy 70` (86),
  `Nc 153 Hwy` (70), `N US Hwy 29` (53), `S US Hwy 29` (53),
  `Old US Hwy 80` (26).
- 457 held rows sit under a city label E911 unambiguously disagrees with
  (China Grove 205, Rockwell 97, Salisbury 68, Kannapolis 42, and a tail).

### Remaining risks and follow-ups

1. **`storage.upsertScanTargets`'s alias-twin guard merges distinct units at one
   premise.** Reproduced twice (scratch run and
   `tests/integration/rowanBridge.test.ts`). 6,793 Rowan doors are held back
   because of it. Fixing it changes dedup for every caller and needs its own
   plan.
2. **`tests/integration/anti-miss-controls.test.ts` "distinct UNITS never merge
   across city aliases" passes for the wrong reason** — its first row still has
   `street_key IS NULL`, so the guard it means to exercise cannot match. Left
   as found; the new test documents the real behavior beside it.
3. **The 765 unproven-spelling doors** should be measured with `--phase probe`
   before or shortly after the bulk import. They import fine either way; the
   risk is that they answer as "no fiber" when the spelling, not the fiber, is
   the problem.
4. **The 457 mislabelled held rows** are the Landis postal-city defect at county
   scale. Relabelling them is a separate authorized operation.
5. Applying against the local `data.db` while another session runs a paid scan
   competes for the SQLite write lock. `--batch` / `--pause` exist for that;
   the defaults (500 / 25 ms) are deliberately small.
