# Address repair lane: reach the work it was built for

## Outcome

An operator can point the existing address repair lane at an explicit cohort of
stuck scan targets (for example the 228 Rockwell doors left `queued` by
`run_1_mt9lrv7v_bumx`) and get the same repair decisions, writes, and audit
trail the scheduled lane produces - without waiting for those rows to cross a
park threshold they never actually cross.

## Context

- `server/addressRepairLane.ts` repairs terminally-parked addresses from our own
  verified neighbours. No Mapbox calls by construction.
- `server/index.ts:716` starts it on its own timer, guarded by
  `ADDRESS_REPAIR_LANE !== "off"`.
- `shared/scanPolicy.ts`: `INCONCLUSIVE_GIVEUP=3`, `ANF_PARK_MAX_GENERATIONS=3`,
  so `terminalParkedBatch` requires `inconclusive_attempts >= 7`.
- `server/scanEngine.ts:186`: `ANF_TERMINAL_ATTEMPTS=6` finalizes an address as
  conclusive `address_not_found` first.

## Safety invariants

- No provider calls and no Mapbox spend from the repair path.
- One repair per row ever: `repair_code IS NULL` stays in the candidate query.
- Never touch a row that already has an answer (`last_scanned_at IS NOT NULL`).
- Repairs are tenant-agnostic reads of our own data; writes are per-row and
  bounded, inside the existing single-writer transaction shape.
- A re-scan of repaired rows is a PAID action and needs explicit operator
  approval; it is not part of this change.

## Milestones

1. Diagnose whether the lane is scheduled/enabled and whether it can reach the
   Rockwell cohort. (done - see Discoveries)
2. Add `runAddressRepairForTargets(ids)` sharing the scheduled pass's per-row
   logic; cover it with tests.
   `npx vitest run tests/integration/address-repair-lane.test.ts`
3. Run it against the 228 Rockwell targets; report per-code outcomes.
4. STOP. Report, and ask before any re-scan.

## Discoveries (2026-08-26)

The lane is not reachable by the work it describes, for four independent
reasons:

1. `server/index.ts:680` wraps the whole primary bootstrap in
   `if (SCAN_WORKERS > 0 && cluster.isPrimary)`. Single-process mode falls
   straight through, so the lane never starts there at all.
2. Every `.claude/launch.json` dev config sets BOTH `SCAN_WORKERS=0` AND
   `ADDRESS_REPAIR_LANE=off`. Locally the lane is disabled twice over.
3. Proof it has never run against `/Applications/homefront-fiber-full/data.db`:
   `PRAGMA table_xinfo(scan_targets)` has no `repair_code` / `repaired_at`
   columns, so `ensureRepairSchema()` has never executed on this database.
4. Even where it does run (production sets `SCAN_WORKERS: "auto"` and does not
   set `ADDRESS_REPAIR_LANE`, so the guard passes), its candidate window is
   empty. `terminalParkedBatch` wants `inconclusive_attempts >= 7 AND
   last_scanned_at IS NULL`. Across 919k rows the unscanned attempt
   distribution is: 3 -> 1896, 4 -> 1025, 5 -> 7, 6 -> 0, 7+ -> 0, plus 2
   legacy strays at 16. The ANF terminalizer concludes at 6, so nothing
   survives unscanned to 7. The lane can see exactly 2 rows in the entire
   database.

This is the `YIELD_ROLLUPS=off` failure mode one layer deeper: the scheduler
bug was fixed, and the lane still cannot reach its work because the
unreachability moved into the WHERE clause.

## Decisions

- Add a cohort entry point rather than lowering the `>= 7` threshold. Lowering
  it changes background scanner behavior across every market at once and is a
  provider-policy call for the operator, not a side effect of this task. The
  threshold finding is reported instead.
- The cohort path reuses the scheduled pass's per-row function verbatim, so the
  two can never drift.

## Recovery

Pre-change state of the 228 rows is snapshotted to CSV in the session
scratchpad (`rockwell-228-before.csv`: id, address, city, state, zip,
street_key, lat, lng, inconclusive_attempts, last_inconclusive_at,
address_review_reason). Repairs are reversible from it; `repair_code IS NOT
NULL` identifies every row this pass touched.

## Discoveries, part 2 (2026-08-26) - the lane's repairs were wrong

The first cohort pass over the 228 wrote 46 repairs. Checked against a
pre-pass snapshot, ALL 46 were wrong, in two separate ways:

**POSTAL_CITY_ALIAS (21 rows) - cross-town contamination.** `scannedNeighbours`
defined a neighbour as any scanned row with the same `street_key` and `state`.
On this database `street_key='S MAIN ST'` in NC matches 414 scanned rows across
14 cities, none sharing the target's ZIP; `'N MAIN ST'` matches 304 across 11
cities, also zero same-ZIP. The `LIMIT 40` had no ORDER BY, so the modal city
came from an arbitrary sample. Result: 21 Rockwell doors relabelled Norwood /
Concord / High Point / Statesville / Kannapolis / Broadway / Pinebluff while
keeping ZIP 28138 - city+ZIP pairs that do not exist.

**SUFFIX_VARIANT (25 rows) - rewrote away from canonical.** The rule adopted the
FIRST neighbour's spelling whatever it was, so 25 doors went
`'1009 Quail Haven Dr'` -> `'1009 Quail Haven Drive'`. Kinetic canonicalizes
street types to abbreviations and `shared/addressKey` folds DRIVE->DR, so this
made a match strictly less likely.

**Unwritable repairs looped.** 3 rows tripped
`idx_scan_targets_addr_city_state`; the catch logged and moved on WITHOUT
setting `repair_code`, leaving them permanent candidates for the same doomed
UPDATE - the unbounded retry this lane exists to end.

All 46 were rolled back from the snapshot and verified byte-identical.

## Fixes applied

1. `scannedNeighbours` fences on place: same ZIP5, or - when the row's own ZIP
   is unusable - within ~1 mile. 533 rows in this table have the house number
   written into the ZIP field ('10540 US HWY 52' under ZIP 10540), which is why
   the proximity fallback exists rather than a ZIP-only fence. No ZIP and no
   coordinates = refuse to guess. `ORDER BY id` makes the LIMIT deterministic.
2. SUFFIX_VARIANT only fires when OUR spelling is the non-canonical one, and
   adopts the MODAL spelling among neighbours that are themselves canonical.
3. A repair that cannot be written is marked UNREPAIRABLE with the reason, so it
   is never re-planned.
4. Cohort quarantine is now OPT-IN. Permanent parking is only defensible once
   the park ladder is exhausted; a cohort named from a run's stuck tail says
   nothing about that. The first pass parked 214 real doors at 3-4 attempts,
   short-circuiting a re-probe the ladder still owed them. Released and verified.

## Result

Second pass over the same 228, with the fixed lane:

- 14 repaired (all SUFFIX_VARIANT, all abbreviating toward canonical:
  Trail->Trl x9, Street->St x2, Road->Rd x1, Highway->HWY x2), re-armed to 0.
- 0 POSTAL_CITY_ALIAS, 0 ZIP_MISSING, 0 GEOCODE_MISMATCH, 0 UNIT_AMBIGUOUS.
- 214 left untouched inside their park ladder; 2 of those are unwritable
  duplicates of an existing target.
- Final DB state verified: exactly 14 rows differ from the pre-pass snapshot,
  214 byte-identical, `PRAGMA quick_check` ok.

**The re-scan is not clearly worth buying.** On all four repaired streets
Kinetic already answered spelled-out addresses: BIRD DOG TRL 4 of 11 answered
doors are spelled "Trail"; CORNELIUS RD 13 of 30; SALISBURY ST 2 of 27; and on
CHINA GROVE HWY 7 doors that were ALREADY canonical are stuck anyway. City-wide
the stuck rate is 11.3% for spelled-out vs 7.1% for canonical (z~2.4) - real but
small. Expected yield from re-scanning the 14 is low. Its value is
informational: 14 checks is one (IP, token) pair, and it settles whether suffix
repair works at all before anyone points the lane at Kannapolis's 298 or the
wider backlog. Operator decision.

## Validation

- `bash scripts/agent-verify.sh full`: harness valid (4 agents, 8 skills),
  deployment controls passed, `npm run check` + `check:fast` clean,
  593 test files / 7492 tests passed, production build ok, exit 0.
- `tests/integration/address-repair-lane.test.ts`: 19 tests, 8 new, each
  failing against the pre-fix lane.
- Docker compose validation skipped (docker unavailable on this host).

## Result, part 2 - the re-scans (operator-authorized 2026-08-26)

**Rockwell, 14 doors: 12 answered, 8 new fiber, 9 sellable.** The 2 failures are
exactly the pair predicted to fail (7620 / 7730 CHINA GROVE HWY, the street
where 7 already-canonical doors were stuck anyway).

**Kannapolis + China Grove, 31 doors: 7 answered, 2 new fiber, 4 sellable.**

Total: 19 of 45 repaired doors answered, 13 sellable doors recovered, for 45
provider checks.

The earlier prediction of "0-2 of 14" for Rockwell was WRONG, and the reason is
worth keeping. The marginal city-wide rate (11.3% stuck for spelled-out vs 7.1%
for canonical) does not predict the conditional. Given a door was ALREADY stuck,
fixing the suffix unstuck it 12 times out of 14 in Rockwell. The discriminating
question is not "does Kinetic ever answer spelled-out addresses on this street"
but "are the already-canonical doors on this street ALSO stuck" - if they are,
the blocker is fabric absence and no repair helps.

Rockwell converted at 12/14 and Kannapolis at 7/31 because Rockwell's stuck
doors were concentrated in one subdivision (9 of 14 on BIRD DOG TRL) where
spelling was the whole story, while Kannapolis's are scattered. The W C ST
cluster is the clean counter-example: 730 W C ST answered, but 1415 / 1425 /
1437 / 1460 / 1473 / 3320 W C ST did not. The road IS in Kinetic's fabric under
that spelling; those house numbers are not in it.

## Follow-up found while verifying (not acted on)

Two `frontier_hot` Durham runs are stuck at `status='running'` with heartbeats
13.9 h old and 0 inflight: `run_1_mt8s16k2_u2j7` (3,452 queued) and
`run_1_mt8sqwcz_n2y9` (768 queued). No worker process is alive to advance them.
Their evidence is durable - availability_snapshots holds 1,548 and 389 rows,
exactly matching their verified counts - so cancelling costs no evidence.

`_pendingElsewhere` (scanIntelStore.ts:271) excludes a target only when the
holding run has `status='running'`, so these two DO block re-enqueue of their
4,220 targets. Narrower than it sounds: all 4,220 are `carrier='frontier'`, so
they block Frontier Durham work only and no Kinetic path, including this lane
(which filters `carrier='kinetic'`). Cancelled and done runs block nothing.

## Remaining risks / follow-ups

- The `>= 7` vs `ANF_TERMINAL_ATTEMPTS = 6` off-by-one is UNCHANGED. The
  scheduled lane still sees ~2 rows in the entire database. Reconciling the two
  thresholds changes background scanner behavior across every market and is an
  operator call, not a side effect of this task.
- 533 rows table-wide have the house number written into the ZIP field. The
  proximity fallback works around it; nothing fixes the underlying data.
- Kinetic's own suggested spellings are never persisted
  (`fiber_job_failures.message` holds only the category label, and
  `maskSuggestedAddress()` strips them from the event log). The scanner already
  applies one suggestion in-flight and deliberately refuses to attach a
  "materially different" one because there is no scan-target identity merge.
  Mining suggestions is a code change, not a query.
- 2 Rockwell doors are duplicate scan_targets of an existing row (7740 China
  Grove Hwy, 405 Link St). They are marked UNREPAIRABLE with the collision
  reason rather than merged.
