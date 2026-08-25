# Requeue diagnostics: every requeue states its reason

## Outcome

An operator watching a live scan can answer "why is this run churning?" from the
database alone, in one query, without restarting the worker:

```sql
SELECT json_extract(payload_json,'$.reason') AS reason, COUNT(*)
FROM fiber_job_events
WHERE run_id=? AND event_type='address.requeued'
GROUP BY 1 ORDER BY 2 DESC;
```

Every `address.requeued` row carries a machine-readable `reason` from a closed
vocabulary, plus the underlying HTTP status and error detail where one exists.
Bulk requeues (crash-orphan reclaim, operator reset) and tail terminalization
emit their own run-level events with the same reason vocabulary.

## Context

Measured 2026-08-24 on the live Concord/China Grove scan (see
`.agent/plans/coming-soon-flip-algorithm.md`, "Discoveries (operational…)",
defect 2):

- `run_1_mt7hy05z`: 31,777 `address.requeued` events against 755 completions
  (42:1). Payload carried `{category, attempt}` only - `category` is one of two
  coarse buckets (`provider_blocked` / `inconclusive`), which cannot separate a
  spent residential IP from a dead egress from a token-mint failure.
- `run_1_mt7n0iyz`: 657 requeues, 0 verified, 0 availability snapshots.
  Undiagnosable; the last ~250 China Grove doors are still unscanned.

Relevant files:

- `server/scanner.ts` - `scanAddressDirect` produces every Kinetic non-answer.
  The diagnosis exists there (HTTP status, transport error, validationResult)
  but is flattened into the free-text `notes` string. `ScanResult.blocked`'s own
  contract comment forbids consumers from regexing `notes`; `scanEngine.ts:417`
  does it anyway.
- `server/frontierScanner.ts` - seven more non-answer sites, same shape.
- `server/scanEngine.ts:402-500` - the two requeue call sites (transient
  non-answer, worker exception).
- `server/scanIntelStore.ts:523` - `requeueRunTarget`, the single-target
  primitive; `:453` `resetInflightTargets`, the bulk one; `:461`
  `terminalizeQueuedTail`, which closes a tail as `superseded`.
- `server/fiberOperationsStore.ts` - `appendFiberEvent` / `recordFiberFailure`.

## Safety invariants

- No change to what counts as a conclusive answer, a no-service verdict, a
  fiber qualification, or a published lead. This is diagnostics only.
- The `addressNotReady` gate (needs-fix backoff → `address_not_found` terminal
  after `ANF_TERMINAL_ATTEMPTS`) must keep matching exactly the same responses.
  The shared regex `NEEDS_FIX_NOTE` is the single definition used by both the
  producer (scanner stamp) and the consumer (engine fallback).
- No new provider requests, no new spend, no change to concurrency, backoff, or
  budget.
- Event payloads stay tenant-scoped and bounded; error detail is truncated and
  carries nothing the same tenant's `fiber_job_failures.message` does not
  already hold.
- Forward-only, no migration: `fiber_job_events.event_type` is free-text TEXT
  and `payload_json` is JSON, so new reasons and event types need no schema
  change.

## Milestones

1. `shared/scanRequeueReason.ts` - closed vocabulary, type guard, and
   `requeueReasonFor()` which prefers a stamped typed reason and falls back to
   the legacy note heuristics so a checker that predates the field still yields
   a reason (never `undefined`).
   Verify: `npx vitest run tests/unit/scan-requeue-reason.test.ts`
2. Producers stamp `retryReason` + `httpStatus` on every non-answer in
   `server/scanner.ts` and `server/frontierScanner.ts`.
3. `requeueRunTarget` takes a REQUIRED diagnostic and owns the
   `address.requeued` event, so the type checker rejects a reasonless requeue.
   `resetInflightTargets` / `terminalizeQueuedTail` take a reason and emit one
   run-level event each.
4. `server/scanEngine.ts` passes diagnostics at all call sites; the duplicate
   `appendFiberEvent` blocks are removed; the false comment at the snapshot
   writer is replaced with the measured truth.
   Verify: `npx vitest run tests/integration/requeue-reason.test.ts tests/integration/scan-engine.test.ts`
5. Docs + full verification.
   Verify: `bash scripts/agent-verify.sh full`
6. Defect 1 (mint transport failure never rotates the sticky IP). Diagnosability
   made the livelock readable; this makes it self-clear.
   Verify: `npx vitest run tests/unit/mint-transport-rotation.test.ts tests/unit/live-test-auth.test.ts`

## Progress

- 2026-08-24: plan written; call sites mapped.
- 2026-08-24: milestones 1-6 complete. `shared/scanRequeueReason.ts` added;
  13 non-answer sites stamped in `server/scanner.ts` and 9 in
  `server/frontierScanner.ts`; `requeueRunTarget` / `resetInflightTargets` /
  `terminalizeQueuedTail` now own their audit events; every engine call site
  updated; `run.breaker_wait` added so a breaker stall is legible; docs updated.
  `bash scripts/agent-verify.sh full` exits 0 (581 files, 7359 tests).
- 2026-08-24: milestone 6. `MintTransportError` + a consecutive-failure streak in
  `server/scanner.ts`; a dead mint egress is now abandoned after 3 in a row.
- 2026-08-25: `vitest hookTimeout` 10s -> 60s. Integration `beforeAll` hooks
  build a real SQLite database (fresh DATA_DIR + full migration chain + seed) and
  legitimately take 5-19s, so the default failed 7 files whenever the runner was
  loaded, all of which pass in isolation. Proven under deliberate 8-core load:
  `lead-stream-authz` takes 19.7s and passes. `testTimeout` and the wall-clock
  perf budgets (e.g. `kinetic-build-map-perf` holding `buildGrid` under 400ms)
  are deliberately untouched - widening those to suit a busy laptop would be
  weakening a gate rather than calibrating a runner.
- 2026-08-25: merged `origin/rep-knocking-workflow` (PRs #177, #178 landed mid-
  flight; two production deploys already shipped them). Only
  `server/tenuredLeadProjector.ts` conflicted, and only in a comment - both sides
  had made the same `run.immediate(...)` fix. Resolved by taking the base
  wholesale. `server/scanner.ts` auto-merged: #178 rewrote the CONCLUSIVE
  classification block (`classifyServiceability`) while this branch changed the
  mint ladder and the NON-answer paths, so the two do not overlap. Re-verified:
  `bash scripts/agent-verify.sh full` exits 0 (589 files, 7440 tests).

## Decisions

- **Reason lives in the event payload, not in `fiber_job_failures.category`.**
  `category` is asserted by `tests/integration/scan-engine.test.ts:354` and is
  the coarse bucket operators already query. Repurposing it would silently
  change an existing contract. The finer reason is additive.
- **`requeueRunTarget`'s diagnostic is a required parameter, not optional.**
  An optional field would let the next requeue path ship reasonless - which is
  the exact defect being fixed. Required makes `npm run check` the enforcement.
- **Failed attempts still write no `availability_snapshots` row.** See
  Discoveries.
- **`breaker_open` is wired, not just declared.** A vocabulary entry with no
  producer is its own kind of lie. The one place it is true is the worker's
  COOLDOWN yield, which claims nothing and requeues nothing - and therefore
  looked exactly like a wedged worker in the event stream. It rides the existing
  30s `logBreakerWait` throttle, so it is bounded at ~2 events/minute/process.
- **A pre-existing gate failure was fixed to reach green**
  (`server/tenuredLeadProjector.ts:139`). Not part of this task; see Discoveries.
  SUPERSEDED 2026-08-25: PR #178 landed the identical `run.immediate(...)` fix
  on the default branch while this branch was in flight, so the merge takes the
  base's version and this branch no longer carries that change. Two independent
  diagnoses reaching the same remedy is corroboration, not duplication - but the
  credit belongs to #178.

## Discoveries

- `persistSnapshot`'s `checkFailed` parameter is dead: its only caller
  (`applyCheck`, `scanEngine.ts:678`) hardcodes `false`, and `applyCheck` is
  only reached for a valid provider response. So the comment at
  `scanEngine.ts:944` ("a failed attempt is retained here … but conclusive=0")
  describes a path no code takes. That is why `run_1_mt7n0iyz` produced 0
  snapshot rows for 702 completed provider calls.
- Routing failures into `availability_snapshots` is not merely unimplemented,
  it is blocked by design: `idx_availability_snapshots_attempt` is UNIQUE on
  `(tenant_id, run_id, scan_target_id)` (`server/storage.ts:1772`). A requeued
  target retries inside the SAME run, so a first-attempt failure row would take
  the slot and the eventual conclusive answer would be silently dropped by the
  `orIgnore` insert. Two existing tests assert exactly this shape
  (`scan-engine.test.ts:326`, `scan-engine-324.test.ts:126`).
  Resolution: keep failures out of `availability_snapshots`, delete the dead
  parameter, and replace the comment with the truth plus a pointer to where
  retry history actually lives.

- **Pre-existing red gate, fixed rather than worked around.**
  `tests/unit/deferred-read-write-transactions.test.ts` was already failing at
  the branch base d5ead93: `projectTenuredOpenLeads` invokes a read-then-write
  `rawDb.transaction` deferred, introduced by 4ad92b1. Verified pristine by
  running the test's own static analysis over `git archive HEAD server`, which
  reports the identical single offender with none of this branch's changes
  applied. Fixed with `run.immediate(...)` - exactly the remedy the test's
  failure message prescribes - because `agent-verify.sh full` is a required step
  of this task and no gate may be weakened to pass it.

- **The mint rotation gate is a TYPE, not a regex.** The old gate asked "does
  this message contain 401/403?" and treated everything else - challenge and
  dead egress alike - as fail-closed. Adding "…or does it look like a transport
  error?" would have put a string match in charge of a safety boundary: widen it
  by accident and the scanner starts rotating around bot walls. Instead
  `MintTransportError` is raised at the ONE place `proxyFetch` itself throws, so
  "no response was received" is structurally impossible to confuse with "the
  provider answered with a challenge" - a challenge cannot exist without a
  response. The rule that the scanner never rotates to evade a challenge is
  therefore enforced by control flow, and the test suite asserts it holds under
  unbounded repetition.
- **N-in-a-row, not on-failure.** `decodo-sticky-is-a-port` measured that the
  rotation reflex is its own bug (205 denials became ~205 rotations, recreating
  the per-request rotation stickiness exists to prevent). So the streak needs 3
  consecutive transport failures and ANY successful mint clears it - a working
  egress can never accumulate its way into a move. The streak also resets when
  it fires, so the port advances once per 3 failures rather than on every
  failure after the third.
- **No time window on the streak.** Considered and rejected as unnecessary
  state: the 15-minute sticky window already retires the IP under normal
  traffic, so a stale streak can at worst cost one extra rotation.

## Validation

- `bash scripts/agent-verify.sh full` (harness validator, deployment safety,
  `npm run check`, `npm run check:fast`, `npm test`, `npm run build`).
- New: `tests/unit/scan-requeue-reason.test.ts`,
  `tests/integration/requeue-reason.test.ts`.
- The integration test asserts the invariant directly: every `address.requeued`
  row emitted during the run carries a reason in the closed vocabulary.

## Recovery

Every change is additive and diagnostic. To revert, restore the four touched
server files; `fiber_job_events` rows written in the meantime remain readable
(extra JSON keys are ignored by existing readers). No migration to undo, no
data to repair.

## Result

Every requeue path now names itself. `address.requeued` carries
`{reason, category, attempt, httpStatus, detail, delaySeconds, applied}`;
`run.targets_requeued`, `run.tail_terminalized`, and `run.breaker_wait` carry
`reason` plus a count. `requeueRunTarget`'s diagnostic is a required parameter,
so a future requeue path cannot ship reasonless without failing `npm run check`.

Both 2026-08-24 livelocks would now be readable from the database in one query:
the 42:1 churn resolves to a `reason` histogram (spent IP vs dead egress vs
failed mint), and the 657-requeue/0-verified run would show its reason column
even though it wrote no snapshots.

Remaining risks and follow-ups:

- `unknown` should be zero in production. A non-zero count means a requeue path
  shipped without naming itself; it is the canary for this whole mechanism.
- `applied: false` on `address.requeued` is newly visible. It has always been
  possible (the UPDATE matches only `state='inflight'`) but was never recorded.
  A run with many `applied: false` requeues is worth investigating separately.
- Defect 1 from `coming-soon-flip-algorithm.md` is now FIXED (milestone 6): a
  mint egress that cannot reach the token endpoint is abandoned after 3
  consecutive transport failures instead of being retried forever.
  `scratchpad/supervise.sh` (the restart-after-3-minutes-of-no-progress
  workaround) should no longer be needed for this failure mode, but it is
  harmless to keep until a live run confirms it.
- The streak is per-PROCESS, not fleet-shared. Each worker discovers a dead
  egress independently, costing up to 3 failed mints each. That is acceptable
  (mints are cheap and the pool is paced) but it is not the same guarantee the
  DB-backed circuit breaker gives; a fleet-shared streak would be the next
  refinement if this proves noisy.
- Nothing here has been run against production. Applying it changes only what is
  recorded, not what is scanned, but it is still a deploy.
