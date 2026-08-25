# Mint transport failures must advance the sticky IP

## Outcome

A scan run that lands on a residential IP which cannot reach the Kinetic auth
endpoint recovers by itself. After N consecutive mint attempts that never carry
a provider answer, the process hands over to the next sticky port - the same
mechanism a spent IP already uses - instead of retrying the same dead IP every
few seconds until an operator kills the worker.

A CAPTCHA or other non-JSON challenge still fails CLOSED without any identity
change. That distinction is the point of the fix, not a casualty of it.

## Context

- `server/scanner.ts` `mintAuthorizedToken` walks a mint ladder:
  impersonate-direct, impersonate-proxy, direct, then a Decodo retry loop.
- The Decodo loop gated its retry on `isAuthDenialMessage()` = `/\b(401|403)\b/`.
  Anything else broke out of the loop, so a transport-level failure
  ("fetch failed" from undici) never called `rotateProxySession()`.
- `server/proxy-fetch.ts` owns the sticky egress. Two existing handover paths:
  - `rotateProxySession()` - the DENIAL response. Deliberately reluctant: needs
    `DECODO_ROTATE_AFTER_DENIALS` consecutive denials and is throttled by
    `ROTATE_MIN_INTERVAL_MS`.
  - `retireStickyIp()` - the SPENT-BUDGET handover. Planned, unthrottled,
    resets the denial streak, calls `advanceStickyPort()` + rebuilds the
    dispatcher.
- Observed live 2026-08-24 on `run_1_mt7hy05z`: verified stuck at 610 through 26
  consecutive mint failures, zero snapshots written. Killing the worker recovers
  because `_stickyPortOffset` is randomised per process.
- Prior context: `.agent/plans/coming-soon-flip-algorithm.md`, "Discoveries
  (operational, from the live scan 2026-08-24)", defect 1. The interim
  workaround was a scratchpad supervisor that restarted the worker after three
  minutes of no progress; this change replaces it.

## Safety invariants

- A challenge / non-JSON interstitial / any answer the provider actually sent
  must keep failing closed WITHOUT rotating identity (`server/scanner.ts:283`).
- Rotation stays bounded: at most one handover per mint call, gated on a
  consecutive-failure count, and disabled by an operator knob.
- A Decodo 407 (account-level auth or limit denial) must NOT advance the port -
  that belongs to the bandwidth governor's circuit breaker.
- No new egress path, no new endpoint, no evasion behaviour.

## Milestones

1. `server/proxy-fetch.ts`: expose the spent-IP handover as
   `advanceProxyEgress(reason)`; carry a reason into its log line.
2. `server/scanner.ts`: classify a mint failure as auth / transport / answered;
   count consecutive transport failures; at the threshold advance the egress and
   retry within the existing attempt bound.
3. Regression tests: transport failures advance the port, a challenge does not.
4. Document the knob in `docker-compose.production.yml`.

Commands:

```
DATA_DIR=$(mktemp -d) npx vitest run tests/unit/kinetic-scanner-transport.test.ts tests/unit/decodo-sticky-port.test.ts tests/unit/proxy-fetch.test.ts tests/unit/live-test-auth.test.ts
bash scripts/agent-verify.sh full
```

## Progress

- 2026-08-24: implemented and verified in one session.
  - `server/proxy-fetch.ts`: `advanceProxyEgress(reason)` exported; the spent-IP
    retirement now names its reason in the log line.
  - `server/scanner.ts`: `errorChainText` + `isMintTransportFailure`, a
    consecutive-transport-failure count, and a three-way branch on the Decodo
    rung (auth / transport / answered). `scan.token.mint_failed` now carries
    `kind` and the `cause` chain.
  - Tests: 3 cases in `tests/unit/kinetic-scanner-transport.test.ts`, 3 in
    `tests/unit/decodo-sticky-port.test.ts`; `advanceProxyEgress` added to the
    four `server/proxy-fetch` mocks.
  - Docs: `docs/SCAN_OPERATIONS.md` failure/recovery, and the knob in
    `docker-compose.production.yml` beside its siblings.
- 2026-08-24, follow-up (user asked for the branch to be green): fixed the
  unrelated pre-existing failure this work surfaced -
  `server/tenuredLeadProjector.ts` invoked its read-before-write transaction
  deferred, so `tests/unit/deferred-read-write-transactions.test.ts` was red on
  the branch. Now `run.immediate(...)`, with the reason recorded at the call
  site. It arrived in commit 4ad92b1 (PR #176) and was latent, not live:
  `projectTenuredOpenLeads` still has no production caller - only its own tests
  reference it.

## Decisions

- Reuse the SPENT-IP path (`retireStickyIp`), not `rotateProxySession`. A dead
  IP has produced no denials, so the denial streak would never be satisfied and
  the min-interval throttle could swallow the handover entirely - the caller has
  already established the IP is unusable.
- Classify transport failures from an ALLOW-LIST over the error `cause` chain.
  undici reports every dispatch failure as a bare "fetch failed", so the real
  cause is only visible underneath. Anything unrecognised is treated as an
  answer from the provider and fails closed: an unfamiliar response can never
  earn an identity change.
- The counter is consecutive-only. Any mint that reaches the provider at all -
  success on any rung, a denial, a challenge - resets it.
- Threshold default 2, in its own knob (`KFS_MINT_ROTATE_AFTER_TRANSPORT_FAILURES`).
  `KFS_MINT_MAX_ROTATIONS=0` is documented as the mint-path IP-switching kill
  switch, so it suppresses the transport handover too: a fix that ignored an
  existing kill switch would be a surprise to whoever set it.
- A Kinetic-wide outage looks identical from here, so the churn bound matters:
  at most one handover per mint call, and the pool already backs a run of failed
  mints off exponentially (5 s doubling to 120 s), which caps the cost at about
  one port every two minutes rather than a storm through the range.

## Discoveries

- `rotateProxySession()` alone would not have fixed this even if the gate were
  loosened: with `DECODO_ROTATE_AFTER_DENIALS=8` in production, eight transport
  failures would have to accumulate against a counter that a single search 2xx
  resets, and the 4s min-interval throttle can drop the rebuild entirely.

## Validation

- `DATA_DIR=<fresh> npx vitest run` over the six scanner/proxy files: 55 passed.
- Regression proof: with the old `!isAuthDenialMessage(message) || attempt >=
  maxMintRotations` gate restored, "a STREAK hands the residential IP over"
  fails ("promise rejected TypeError: fetch failed instead of resolving") while
  every other case still passes - including the challenge case, which asserts a
  preserved invariant rather than the new behaviour.
- `bash scripts/agent-verify.sh full`, run twice (the second time on the frozen
  tree): harness validator, `tests/deployment-safety.sh`, `npm run check` (tsc)
  and `npm run check:fast` (tsgo) all pass. `npm test`: 7347 of 7348 pass, in
  579 files. The one failure is PRE-EXISTING and unrelated -
  `tests/unit/deferred-read-write-transactions.test.ts` flags
  `server/tenuredLeadProjector.ts:111 (invoked deferred)`, a read-before-write
  transaction that arrived in commit 4ad92b1 (PR #176). It reproduces in
  isolation and neither file is touched by this change. Because that failure
  stops the script, `npm run build` was run separately: exit 0.
- After the follow-up fix: `tests/unit/deferred-read-write-transactions.test.ts`
  2/2 and `tests/integration/tenured-leads.test.ts` 15/15, then
  `bash scripts/agent-verify.sh full` GREEN END TO END, exit 0: harness
  validator, `tests/deployment-safety.sh`, `npm run check`, `npm run check:fast`,
  `npm test` 7348/7348 in 579 files, and `npm run build`.
- Note: running two proxy-touching test files against a COLD `DATA_DIR` can fail
  with `SqliteError: database is locked` - two workers race to set
  `journal_mode = WAL` on a database neither has created yet. Pre-existing, and
  unrelated to this change; run one file first, or the whole suite.

## Recovery

Pure in-process transport behaviour, no schema or data effects. Roll back by
setting `KFS_MINT_ROTATE_AFTER_TRANSPORT_FAILURES=0` (no redeploy needed), or by
reverting the two source files.

## Result

Code complete and locally verified; see Validation. Behaviour: after 2
consecutive Decodo mint attempts that never reach the provider, the process
steps to the next sticky residential IP and retries within the existing attempt
bound. A challenge, a denial, or any other real provider answer resets the count
and takes its own (unchanged) path.

Remaining risks and follow-ups:

- Live behaviour is unproven. The fix is exercised by unit tests only; no live
  or paid scan was run for it. The first real confirmation is a run that hits an
  unreachable IP and recovers without a restart - watch for
  `scan.token.mint_failed` with `kind":"transport"` followed by
  `[proxy-fetch] sticky IP retired (mint transport: ...)`.
- The scratchpad supervisor (kill + relaunch the worker after 3 minutes of no
  progress) can be retired once that is seen, and is harmless until then.
- The dry-run pass now also takes the write lock for its 250-row batches, since
  the transaction is shared. It reads only, so the cost is a few milliseconds of
  write lock per batch on an operator-initiated preview; splitting the dry run
  out of the transaction was not worth the extra surface.
- The transport classifier is an allow-list. A failure mode whose text matches
  none of its signatures behaves exactly as before this change (fails closed,
  no handover) - add a signature rather than inverting the list.
