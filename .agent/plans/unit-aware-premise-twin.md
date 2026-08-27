# Unit-aware premise twin guard

## Outcome

Two records that name **different doors at one street address** stop being
treated as the same scan target. Concretely, when this is done:

- `upsertScanTargets` inserts `2715 Statesville Blvd Unit 101` and
  `... Unit 102` as two rows, at the same rooftop, with `street_key`
  populated. Today the second is silently absorbed and returns `0`.
- `mergeCityAliasTwins` no longer proposes (and therefore no longer DELETES)
  `77 Lake Vista Dr` vs `77 Lake Vista Dr Lot 16`, or
  `313-A Charlotte Ave` vs `313-B Charlotte Ave`.
- The genuine postal-city alias dedup the guard exists for is unchanged:
  `1315 Stonewyck Dr / Salisbury` and `1315 Stonewyck Drive / Lexington`
  still collapse to one scan identity, keeping the first verified ZIP.
- `script/import-rowan.ts` (branch `f-/compassionate-nightingale-b3a9a4`) can
  land Rowan County's 6,793 unit doors instead of holding them back.

## Context

### Files

- `shared/addressKey.ts` — `canonicalAddressPart`, `streetKeyOf`,
  `STREET_UNIT_TOKENS`. Dependency-free; loaded by `storage.ts` at migration
  time, so it must stay free of server imports.
- `server/storage.ts` — `upsertScanTargets`, the `cityAliasTwinStmt`
  postal-city alias guard (~line 5540).
- `server/scanTargetCanonicalMerge.ts` — `TWIN_PAIRS_SQL`,
  `dryRunManifest()`, `mergeCityAliasTwins()`, `promoteCanonicalUnique()`.
- `server/yieldRollups.ts` — step 5 of the maintenance tick calls
  `mergeCityAliasTwins({ apply: true, maxPairs: 500 })` every 30s until
  `pairsFound === 0`, then sets `alias_merge_done`.
- `tests/integration/anti-miss-controls.test.ts` — the writer-guard tests.
- `tests/integration/canonical-merge.test.ts` — the merge-module tests.

### Current behavior

`streetKeyOf` **cuts** the address at the first `STREET_UNIT_TOKENS` token and
drops an orphaned unit letter after the house number:

    "2715 Statesville Blvd Unit 101" -> "STATESVILLE BLVD"
    "2715 Statesville Blvd Unit 102" -> "STATESVILLE BLVD"
    "313-A Charlotte Avenue"         -> "CHARLOTTE AVE"
    "313-B Charlotte Avenue"         -> "CHARLOTTE AVE"

Both twin predicates were written as if it **retained** the unit token. Both
say so in a comment. Both are wrong:

- `server/storage.ts:5538` — "distinct units differ in street_key's retained
  unit token and never merge".
- `server/scanTargetCanonicalMerge.ts:18` — "Genuine neighbors (different
  house numbers) and distinct units (street_key retains the unit token) can
  never pair".

`upsertScanTargets` matches `street_key` + state + the leading house token
(`address = @houseNum OR address LIKE @houseNum || ' %'`) + coordinates within
~25m, so every unit at one premise collapses onto the first one filed.

`mergeCityAliasTwins` matches `street_key` + state +
`CAST(address AS INTEGER)` + the same ~25m box, then **deletes** the loser row
after repointing 18 foreign keys. `CAST(... AS INTEGER)` is looser still: it
reads `313-A`, `313-B` and `313` as the same house, and reads
`314 318 Malcolm Way` and `314 322 Malcolm Way` as the same house.

### Terminology

- **canonical address part** — `canonicalAddressPart(address)`: the whole
  address in folded token form, unit included (`"2715 STATESVILLE BLVD UNIT 101"`).
- **canonical key** — `address|city|state` in canonical form. City is in the
  key, which is exactly why an alias-city twin needs a second guard.
- **premise twin / alias twin** — the same door filed under two postal cities.
- **street key** — canonical address with the house number and unit removed.

### Evidence (live local dev DB, `/Applications/homefront-fiber-full/data.db`,
read-only, 2026-08-27, 982,844 scan targets)

`TWIN_PAIRS_SQL` currently returns **6,696 pairs**. Classified by recomputing
`canonicalAddressPart` on both addresses:

| bucket | pairs | example |
| --- | --- | --- |
| identical canonical address (real alias twins - correct to merge) | 5,753 | `1315 Stonewyck Dr / Salisbury` vs `1315 Stonewyck Drive / Lexington` |
| **different unit** | 579 | `77 Lake Vista Drive` vs `77 LAKE VISTA DR LOT 16` |
| **different house token** | 327 | `313-A Charlotte Avenue` vs `313-B Charlotte Avenue` |
| **other (range/secondary numbers)** | 37 | `314 318 MALCOLM WAY` vs `314 322 MALCOLM WAY` |

**655 distinct rows** sit in the three wrong buckets - every one of them a real
door queued for deletion the next time the janitor's step 5 runs.

`yield_rollup_state` in that DB has `streetkey_done=1` but **no
`alias_merge_done` row**, and the 6,696 pairs are still present, so the merge
has not consumed them locally. Production state is unknown from here and must
be read before anything is deployed (see Recovery).

## Safety invariants

- No destructive migration, no production access, no deploy in this change.
- The fix must never make the guards **more** eager. Every ambiguity resolves
  toward "these are two doors", because a duplicate row is recoverable and a
  merged-away door is not (`kineticLeadKeyOrNull` states the same principle).
- `mergeCityAliasTwins` must still terminate: `yieldRollups` only sets
  `alias_merge_done` when `pairsFound === 0`, so pairs the merge now refuses
  must disappear from the SQL, not be filtered in JS after the `LIMIT`.
- `shared/addressKey.ts` stays dependency-free (storage.ts loads it at
  migration time).
- `NORMALIZATION_VERSION` must not change: no stored key's value changes here,
  so no lead re-key/re-merge should be triggered.
- Tenant scoping in both predicates is unchanged.

## Milestones

### M1 - one identity function, no drift  (`shared/addressKey.ts`)

Add `addressIdentityOf(address) -> { house, street, unit }` splitting the
canonical token list at exactly the two boundaries `streetKeyOf` already
computes, and make `streetKeyOf` delegate to it so the two can never disagree.
`house ++ street ++ unit` reconstructs `canonicalAddressPart(address)` token
for token.

    npx vitest run tests/unit/fresh-harvest.test.ts

### M2 - writer guard confirms the whole premise-unit  (`server/storage.ts`)

Keep the indexed SQL prefilter, but return candidates instead of `LIMIT 1` and
confirm in JS that the candidate's `canonicalAddressPart(address)` equals the
incoming one. Correct the false comment.

    npx vitest run tests/integration/anti-miss-controls.test.ts

### M3 - merge predicate matches the whole premise-unit  (`server/scanTargetCanonicalMerge.ts`)

Register a deterministic `harvest_canonical_address(address)` SQL function
(same pattern as `registerHarvestSqlFunctions` in `server/freshHarvest.ts`)
and add `harvest_canonical_address(b.address) = harvest_canonical_address(a.address)`
to `TWIN_PAIRS_SQL`, so refused pairs leave the manifest and the janitor still
terminates. Correct the false comment.

    npx vitest run tests/integration/canonical-merge.test.ts

### M4 - regression coverage that fails without the fix

- `anti-miss-controls.test.ts`: make the units case populate `street_key`
  first (today it passes only because `street_key` is NULL and the guard can
  never match), and add the 3-unit / base-premise / LOT cases.
- `canonical-merge.test.ts`: units, letter-suffixed house numbers and range
  addresses must not pair; the real alias twin still merges.

      npx vitest run tests/unit/fresh-harvest.test.ts tests/integration/anti-miss-controls.test.ts tests/integration/canonical-merge.test.ts tests/integration/yield-rollups.test.ts

### M5 - verification

    npm run check
    DATA_DIR=$(mktemp -d) npx vitest run <the four files above>
    DATA_DIR=$(mktemp -d) npm test

## Progress

- [x] 2026-08-27 - traced both predicates; confirmed the reported repro by
      reading `streetKeyOf` and the SQL.
- [x] 2026-08-27 - read-only forensics on the live local DB: 6,696 pairs,
      579 unit / 327 house-token / 37 range, 655 distinct doors at risk.
- [x] 2026-08-27 - M1 `addressIdentityOf` added, `streetKeyOf` delegates.
- [x] 2026-08-27 - M2 writer guard confirms full canonical address.
- [x] 2026-08-27 - M3 merge predicate + `harvest_canonical_address` UDF.
- [x] 2026-08-27 - M4 regression coverage added and shown red-before/green-after.
- [x] 2026-08-27 - M5 `npm run check` + full `npm test` on a pristine DATA_DIR.

## Decisions

1. **Compare the whole canonical address, not just a unit token.**
   `house + street + unit` is exactly `canonicalAddressPart(address)`, so the
   premise-twin test becomes "same canonical address, different city" - which
   is the definition of a postal-city alias twin. This closes the unit case,
   the `313-A/313-B` case and the `314 318 / 314 322` range case with one
   term instead of three, and makes both modules' comments true.

2. **Do not compare the stored `canonical_key` prefix.** It would be free in
   SQL, but stored keys go stale: `1850 Cannon Street Ext` and
   `1850 CANNON ST EXT` canonicalize identically yet have *different* stored
   keys in the live DB (they appear as a pair only because
   `b.canonical_key <> a.canonical_key`). Comparing stored keys would drop
   real alias twins. Recompute from `address` instead.

3. **JS filter in `storage.ts`, SQL function in the merge module.** The writer
   already has the incoming canonical part in a local variable and needs no
   new machinery; the merge module needs the term inside SQL or
   `pairsFound` never reaches 0 and `yieldRollups` step 5 loops forever on a
   ~1M-row self-join. Both call the same `addressIdentityOf`, so they cannot
   drift.

4. **Bounded candidate fetch in the writer.** `ALIAS_TWIN_CANDIDATE_CAP = 512`.
   The prefilter is one street + one house number + one ~25m box, so real
   candidate sets are one premise's units. If a premise ever exceeded the cap
   the guard degrades to INSERT - a duplicate row, recoverable - never to a
   wrong merge.

5. **No repair migration for already-merged rows.** See Recovery.

6. **`NORMALIZATION_VERSION` stays at 4.** No stored key's value changes;
   only the twin *predicates* change. Bumping it would trigger the leads
   re-key/re-merge for nothing.

7. **Accepted narrowing: `313A` and `313-A` no longer merge.** They canonicalize
   to `313A CHARLOTTE AVE` and `313 A CHARLOTTE AVE` - one token versus two -
   so the exact test refuses them. The old predicate merged them (both
   `CAST(...) = 313`). This is the safe direction and it is already the rest of
   the system's answer: they have different `canonical_key`s, so the leads
   UNIQUE index treats them as two doors too. Folding them would mean changing
   `canonicalAddressPart` and bumping `NORMALIZATION_VERSION`, which re-keys
   every lead - far more risk than a duplicate scan-target row.

8. **Out of scope, deliberately:** `promoteCanonicalUnique()` still runs when
   the manifest empties, and the `canonical_key IS NULL` backlog is still not
   backfilled. That is a separate known issue and is not made worse here (the
   fix strictly *reduces* the set of pairs the manifest reports).

## Discoveries

- **The merge module is the dangerous half.** `upsertScanTargets` drops a row
  that was never inserted; `mergeCityAliasTwins` DELETEs a row that exists,
  after repointing 18 foreign-key tables to the survivor. The reported bug
  and this one share a root cause but not a blast radius.

- **The merge predicate is looser than the writer's in a second, independent
  way.** The writer compares the leading house token as a *string*
  (`address = @houseNum OR address LIKE @houseNum || ' %'`), so `511a` never
  matches `511`. The merge compares `CAST(address AS INTEGER)`, so `313-A`,
  `313-B`, `313A` and `313` are all "313". That is 327 more pairs of real
  doors, unrelated to units.

- **"postal-city alias" is a misnomer in the merge.** `TWIN_PAIRS_SQL` never
  requires the two cities to differ, only `canonical_key <> canonical_key`.
  1,616 of the 6,696 live pairs are same-city. Most are legitimate spelling
  twins with a stale stored key, but the unit and letter-suffix pairs are
  same-city too - the guard was never only about postal cities.

- **Two existing tests pass for the wrong reason** and are the reason this
  survived review:
  - `anti-miss-controls.test.ts` "distinct UNITS never merge across city
    aliases" - the first row still has `street_key IS NULL`, so the guard
    cannot match at all.
  - `canonical-merge.test.ts` "neighbors and units never pair" - it inserts
    two *neighbors* and no units.

- **The merge predicate had no tenant boundary at all.** `TWIN_PAIRS_SQL`
  joined `scan_targets a` to `scan_targets b` on street/state/house/coords with
  no `tenant_id` term, while its sibling guard in `upsertScanTargets` scopes
  every lookup with `tenant_id IS @tenantId`. Two tenants holding the same
  premise under different postal cities would pair, and the merge DELETES the
  loser and repoints its leads and snapshots at the survivor - across the
  boundary. Measured on the live database: **0 cross-tenant pairs** (one
  tenant), so it was latent, not exercised. Fixed in the same predicate with
  `AND b.tenant_id IS a.tenant_id` (`IS`, not `=`, so legacy NULL-tenant rows
  pair only with each other - the operator `upsertScanTargets` already uses).
  This is beyond the reported bug; it is in the SQL the fix rewrites, and
  AGENTS.md makes the tenant boundary non-negotiable.

- A third test, `tests/integration/rowanBridge.test.ts` on branch
  `f-/compassionate-nightingale-b3a9a4` (uncommitted, another worktree),
  deliberately pins the current wrong behavior and says in its own comment
  that it must flip when the guard is fixed. It is not touched from here.

## Validation

`bash scripts/agent-verify.sh full` was run as its component steps (2026-08-27):

| command | result |
| --- | --- |
| `python3 scripts/validate-agent-harness.py` | PASS - 4 custom agents, 8 skills |
| `bash tests/deployment-safety.sh` | PASS (docker compose unavailable locally, so compose config validation was skipped - noted, not worked around) |
| `npm run check` (tsc) | PASS |
| `npm run check:fast` (tsgo) | PASS |
| `DATA_DIR=$(mktemp -d) npm test` | PASS - **598 files, 7,568 tests, 0 failures**, 114.1s |
| `npm run build` | PASS |

**Red-before proof.** With the three source files reverted (`git checkout --`)
and the tests left in place, **14 tests failed**:

- `anti-miss-controls`: "distinct UNITS never merge across city aliases"
  (`expected 1 to be 2`), "every unit at one address gets its own row"
  (`expected +0 to be 1`), "a LOT is a unit too" (`expected +0 to be 1`).
- `canonical-merge`: units (`expected 6 to be +0` - six pairs among four rows
  of one building), LOT (`7`), letter-suffixed house numbers (`9`), secondary
  numbers (`10`), and the same-door alias merge (`expected 11 to be 1`).
- `address-identity-v4`: all six `addressIdentityOf` cases (function absent).

Separately, removing only `AND b.tenant_id IS a.tenant_id` turns
"two TENANTS holding one premise never pair" red (`expected 1 to be +0`).

Two tests passed both before and after by design - "the SAME premise under two
postal cities attaches to one scan identity" and "the SAME unit under two
postal cities and two spellings still attaches to one row". They exist to prove
the narrowing did not cost the guard its actual job.

**Proof on real data.** The fixed predicate run read-only against the live local
dev database (982,844 scan targets):

    pairs BEFORE fix : 6696
    pairs AFTER  fix : 5753
    pairs refused    : 943
    distinct rows no longer facing deletion: 655

Every surviving pair was already in the pre-fix set - the new term is a strict
narrowing, so no pair the old predicate refused can now merge.

**Query plan.** The writer guard still rides its index after the change:
`SEARCH scan_targets USING INDEX idx_scan_targets_street (tenant_id=? AND street_key=?)`.

## Recovery

**How to retry safely.** Every change here is code-only. There is no
migration, no data write, no schema change. Reverting the three source files
restores the previous behavior exactly.

**Rows already lost to the writer guard.** They were never inserted, so there
is nothing to repair: the next harvest or import of that source re-supplies
them and the fixed guard now lets them in. Re-running
`script/import-rowan.ts` is what brings Rowan's 6,793 unit doors back.

**Rows already deleted by the merge.** These are gone from `scan_targets`;
their address text is not recoverable from the FK tables, which store only the
target id. The recovery path is the same: re-harvest the source. After the
fix, a re-harvested `77 Lake Vista Dr Lot 16` is no longer a canonical twin of
the surviving `77 Lake Vista Dr` (different canonical key) and no longer a
premise twin (different unit), so it inserts as its own door.

**Before touching production, read - do not write - these three things:**

```sql
-- 1. Did the merge ever run to completion here?
SELECT k, v, datetime(updated_at/1000,'unixepoch') FROM yield_rollup_state;
--    an `alias_merge_done` row means step 5 finished and rows were deleted.

-- 2. How many pairs are still queued (pre-fix predicate)?
SELECT COUNT(*) FROM (
  SELECT 1 FROM scan_targets a JOIN scan_targets b
      ON b.street_key = a.street_key AND b.id > a.id
     AND upper(b.state) = upper(a.state) AND b.canonical_key <> a.canonical_key
     AND CAST(a.address AS INTEGER) = CAST(b.address AS INTEGER)
     AND CAST(a.address AS INTEGER) > 0
     AND b.lat BETWEEN a.lat - 0.00023 AND a.lat + 0.00023
     AND b.lng BETWEEN a.lng - 0.00028 AND a.lng + 0.00028
   WHERE a.street_key IS NOT NULL AND a.street_key <> '');
```

3. Classify those pairs with `canonicalAddressPart` (the script used for the
   local numbers above is reproduced in Result) to size how many real doors
   are still at risk versus already gone.

**If the merge is mid-flight in production and this fix is not deployed yet,**
the kill-switch is `SCAN_TARGET_MERGE=off`, which skips step 5 entirely. That
is an operator decision and a production change - it is not taken from here.

## Result

**Behavior.** A record is only attached to (or merged into) an existing scan
target when it names the same door: same canonical address including the unit
clause and the full house token, differing only in the postal city/state that
the canonical key bakes in, at coordinates within ~25m.

- `upsertScanTargets` inserts every unit of a building as its own row.
- `mergeCityAliasTwins` refused 943 of 6,696 queued pairs on the live local
  data, sparing 655 distinct real doors from deletion, while keeping all 5,753
  genuine spelling/alias merges.
- The merge can no longer pair rows belonging to two different tenants.
- The postal-city alias dedup (Stonewyck, and the 290 Landis doors held as
  "China Grove" that `script/import-landis.ts` depends on) is unchanged: those
  are unit-less addresses whose canonical address parts are equal.

**Files changed**

| file | change |
| --- | --- |
| `shared/addressKey.ts` | new `addressIdentityOf()` -> `{house, street, unit}`; `streetKeyOf` now delegates to it |
| `server/storage.ts` | alias guard returns candidates and confirms the full canonical address in JS; `ALIAS_TWIN_CANDIDATE_CAP`; false comment corrected |
| `server/scanTargetCanonicalMerge.ts` | `harvest_canonical_address` SQL function + exact term in `TWIN_PAIRS_SQL`; `b.tenant_id IS a.tenant_id`; false header corrected |
| `tests/unit/address-identity-v4.test.ts` | 6 cases for `addressIdentityOf` incl. the reassembly property |
| `tests/integration/anti-miss-controls.test.ts` | units case now populates `street_key` so the guard actually runs; 3 new cases |
| `tests/integration/canonical-merge.test.ts` | 6 new cases (incl. cross-tenant); `target()` uses the real `streetKeyOf` |

**Remaining risks**

1. **Production state is unread.** Whether `mergeCityAliasTwins` has already
   deleted doors in production is unknown from this worktree - it depends on
   the `alias_merge_done` row and on `SCAN_TARGET_MERGE` / `YIELD_ROLLUPS`.
   The read-only queries to answer that are in Recovery above. Locally,
   `alias_merge_done` is absent and all 6,696 pairs are still present, so
   nothing has been deleted here.
2. **Deleted rows are not restorable from the database.** The FK tables keep
   only the target id, never the address text. Recovery is a re-harvest, which
   the fix now permits.
3. **`313A` vs `313-A` stay separate** (Decision 7) - a duplicate row, not a
   lost door.
4. **The guard is still latent for rows the janitor has not reached.** Nothing
   stamps `street_key` at INSERT; until the janitor fills it a new row cannot
   be seen by the alias guard at all. Unchanged by this work, and it fails
   toward a duplicate row.

**Follow-ups (not done here)**

- `tests/integration/rowanBridge.test.ts` on branch
  `f-/compassionate-nightingale-b3a9a4` pins the pre-fix behavior and, by its
  own comment, must flip once this lands. That branch's worktree owns it.
- Re-run `script/import-rowan.ts` to land Rowan County's 6,793 unit doors.
- The `canonical_key IS NULL` backlog and `promoteCanonicalUnique()` ordering
  remain open (see `.agent/plans/` history and the scan-targets backfill note);
  this change does not make either worse.
