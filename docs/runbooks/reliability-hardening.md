# Reliability and recovery rollout

Status: implementation passes local verification (8,055 tests/656 files, both type checkers, index guard and production build); GitHub CI and operational verification remain pending; production rollout is **not authorized by a passing unit suite alone**. The requested seven-day staging soak and 48-hour canary have not elapsed. The staging host is pending selection. PR #231 remains the production baseline until these gates pass.

## What changed

SQLite remains the database. The specification's PostgreSQL snippets were adapted to existing transaction/queue boundaries. Correctness fixes (normalized date comparisons, versioned undo, guarded atomic updates, tenant boundaries and bounded scanner admission) are unconditional. New durable work and diagnostics are progressively enabled.

| Switch | Controlled behavior |
|---|---|
| SCANNER_HEARTBEAT | Per-run phase/progress heartbeats and overdue-progress diagnostics |
| COUNT_ATOMIC_UPDATES | Completion-time comparison of atomic verified/failed counters with the target ledger |
| IDEMPOTENT_EMAIL + OUTBOX_PATTERN | Atomic protected OTP and encrypted delivery outbox issuance |
| IDEMPOTENT_ASSIGNMENT | Durable original selection, 500-door chunks, replay receipt and resumable inverse |
| DEAD_LETTER_UI | New recovery surface rollout; existing persisted work stays discoverable even after disabling it |

`RELIABILITY_ROLLOUT_PERCENT` defaults to zero. Values outside 0–100 or malformed values disable the rollout. Tenant IDs are hashed into stable cohorts across processes and restarts; `RELIABILITY_CANARY_TENANTS` can explicitly allow positive tenant IDs. Explicit feature values other than true/on/1 disable that feature. Unset feature switches follow the global cohort. Pre-authentication OTP uses a stable normalized-email hash, because known/unknown email addresses must take the same readiness path and organization-less accounts must work. A 10% tenant canary therefore does not imply exactly 10% of OTP requests.

### Login delivery

The HTTP request commits the protected verification code, rate budget and encrypted outbox intent together. It returns acceptance without waiting for email. No SMTP fallback is attempted after an ambiguous durable HTTP send. The worker freezes from/to/content/attachments and uses `otp-v1/<operation UUID>` for every HTTP retry; [Resend’s documented idempotency window](https://resend.com/docs/dashboard/emails/idempotency-keys) is 24 hours and an OTP delivery expires after ten minutes. Maximum five attempts, exponential delay capped at two minutes, 60-second fenced claim, at most eight deliveries per drain. Provider transport timeout is an actual AbortSignal at twelve seconds. Empty queues acquire no write lock.

`OTP_ENCRYPTION_KEY` is preferred; existing `CALLING_DATA_ENCRYPTION_KEY` is a supported fallback. Provision through the secret store, never source files. The versioned envelope identifies the key slot. Retain the issuing key while protected codes or unfinished delivery payloads remain. Startup/readiness tests must cover missing keys and unknown accounts. Terminal payloads are cleared; compact receipts retain 30 days. Superseded, used, expired, inactive-user, changed-email and moved-tenant messages cannot be newly dispatched. An email already accepted externally cannot be recalled.

Exactly-once external delivery is bounded by the provider's idempotency contract, not promised by SQLite alone. Legacy notifications can have partially delivered SMTP/channel effects; they are inspect/discard-only here. Onboarding's existing HTTP idempotency remains in place. No new unsolicited assignment email policy is introduced: assignment effects, lead history and progress receipts commit in the same transaction, while cache invalidation/SSE remains best effort and clients recover through persisted reads.

### Assignment recovery

Identity is `(tenant, actor, command kind, client operation ID)` plus a normalized request fingerprint. Freeze the original selection before processing; never resolve a changed polygon on resume. Each chunk and its inverse/progress commit together. Replays do not repeat lead events or replace the original inverse. A database trigger increments `leads.assignment_version` for every ownership-field UPDATE, including legacy/manual/import writers; undo compares that version and the ownership fields so a later same-millisecond assignment wins.

The existing ten-minute undo admission window, 5,000-door inverse limit, eight live undo receipts per tenant and 64 globally remain. An undo admitted before its deadline can finish after a crash. There are at most eight running/undoing assignments per tenant, with original selections capped at 250,000 IDs and chunks of 500. Actor/session/tenant/capability and team scope are reloaded after acquiring each writer. Owners resume in Operations; organization admins can stop remaining work with a reason. Committed assignments/restorations stay committed. Receipt history reads pending eight and recent twenty through ordered indexes. Current undo eligibility is separate from the immutable original result.

Ops sends bulk assignment once while the legacy rollout path exists. A lost durable reply is recovered through Operations. Do not add automatic retries to the legacy bulk endpoint: it has no durable replay contract.

### Scanner ownership

Local admission and distributed admission share one deadline, default two minutes and capped at ten minutes for malformed/extreme configuration protection. Local pending work is capped at 20,000 and expired/cancelled requests are removed before execution; active capacity remains owned until task settlement. Token readiness waits are bounded, and abandoning shared pool maintenance never acquires a late caller lease. Before an address request starts, the coordinator's live admission/address ownership is checked again. Each provider HTTP search retains its existing five-second cancellation and shares the overall deadline across an allowed address-correction retry. Existing provider limits, priority classes, costs, retry eligibility, and access-denial handling remain unchanged.

Per-run heartbeats distinguish progress from liveness. Intentional cooldown has no progress deadline. Initialization uses the configured token wait budget; a checking phase accounts for admission plus configured task time. Pending cancellation sweeps share one authority read per run, while dispatch rechecks current authority. Never reclaim an uncancelled provider promise merely because a timer won. Diagnostic writes cannot strand worker cleanup. Terminal/orphaned progress cleanup is limited to 500 rows per tick; snapshots include only matching active tenant runs.

Claim cycles inspect/modify at most 500 candidates, retain once-only/parked-address/priority policy, and explicitly continue after a skipped-only page. Ordering may still inspect a larger due set; this is not a claim that all reads are constant time. Recovery of future retries uses disjoint indexed due ranges without changing timestamp/due semantics. Daily refresh status is tenant-specific but remains process-local; discovery is serialized by the existing producer architecture, not a new multi-host distributed scheduler.

## Recovery actions

Diagnostics shows metadata only: operation/event IDs, safe event type, attempts, state, age and guidance. No payload, email address, verification code or raw provider error is returned. Pending and failed work stays visible with rollout flags disabled.

- Sign-in failure: request a fresh code. Old codes are never replayed.
- Legacy alert failure: review delivery history before separately authorizing another alert; discard only records the operator decision.
- Financial replay: permitted only before the ordered subscriber cursor has passed the event. Never rewind that cursor. Existing idempotent financial handlers remain authoritative.
- Financial **Set aside** means DEAD_LETTER and allows ordered progress without claiming effects were handled. It remains inspectable. RESOLVE is a distinct existing action for explicitly handled effects and is not used by this UI.
- Every mutation verifies current session, active actor, organization, capability, immutable event ownership and state after waiting for SQLite. A required reason and audit must commit together. Stale/cursor-passed actions return 409; errors keep the reason and row visible.

## Validation evidence

Run `bash scripts/agent-verify.sh full` (harness, deployment safety, index guards, both type checkers, full Vitest suite, production build). Focused tests cover separate-process SIGKILL after an assignment batch and provider acceptance, concurrent finalization, competing claims, stale fencing, rollback, supersession, missing keys, held-writer permission/session revocation, financial cursor behavior and responsive recovery states. Live transport is replaced with local fakes; no provider scans or customer communications are needed for these tests.

Reproduce the synthetic benchmark with:

```sh
NODE_ENV=test node scripts/benchmark-reliability.mjs "$PWD" /tmp/hf-reliability-benchmark
```

Recorded evidence: [September 8 benchmark](../performance/reliability-benchmark-2026-09-08.json). On local WAL/NORMAL with 500,000 synthetic targets and 50,000 runs, seven warm samples: daily counts 163.48→2.71 ms; future-heavy recovery 59.07→0.62 ms; all-due recovery 135.46→75.02 ms. Recovery index 14–18 MB, 500 state updates 2.72→5.23 ms; daily indexes 20.2 MB, 500 timestamp updates 2.28→3.43 ms. These exclude production network, cold disk and broader application contention. Re-measure the new assignment-version trigger under the staging workload. No claim of instantaneous mail delivery or elimination of every bottleneck is made.

## Release gates

1. **Review and prepare.** Pass all checks on the exact revision. Verify an encrypted backup and restore rehearsal. Install additive schema on a production-sized synthetic copy; measure index creation time, WAL growth and lock duration. Confirm a compatibility rollback image and original encryption keys are available.
2. **Seven complete days of staging soak.** Use the identified always-on staging host with production-shaped SQLite size, worker counts and disk/CPU constraints. Use controlled test identities and provider fakes; block external mail/scanning at the network boundary. Keep an immutable run record with revision, flags, host/resources, start/end timestamps, per-minute samples, restart/crash events and errors. Sample real staging HTTP latency, SQLite busy events/write duration, loop delay, memory/WAL growth and the queries below. Mix assignments, conflicting writes/undo, scanner claims/finalization, delayed/failing mail acceptance, worker deaths, expired leases and restarts. Run crash fixtures daily. A laptop benchmark or repeated unit tests alone does not qualify as this soak. Any observation gap or revision change requires a new contiguous evidence window.
3. **10% canary, at least 48 hours.** Only after stage 2 passes. Deploy the same compatible binary with explicit cohort configuration. Provision/verify encryption and HTTP sender readiness before enabling durable OTP. Watch both tenant and separate pre-auth email cohorts. Hold or disable new issuance immediately on drift, duplicate effects, persistent stale ownership, tenant breach, growing dead letters, or latency/resource regression.
4. **50%, then 100%.** Promote only after reviewing the prior stage's evidence and unresolved recovery work. Keep monitoring for seven complete days after full rollout.
5. **After 30 stable days.** Retire switches through a separate reviewed change. Keep readers, receipts, ownership guards and retention. Never delete operational history to make a rollout appear healthy.

Suggested pause thresholds (compare with staged baseline): any counter drift/duplicate committed effect/tenant leak; any repeatedly stalled run; OTP age approaching its ten-minute expiry; increasing failed-delivery count; pending assignments without progress; HTTP p95 above baseline by >20% for three consecutive five-minute windows; repeated one-second interactive writer exhaustion; monotonic memory or WAL growth. A pause threshold triggers investigation, not automatic provider-policy changes.

SQL dashboards: [reliability-dashboard.sql](../../scripts/reliability-dashboard.sql). Run under a read-only operator connection with an explicit authorized positive `:tenantId`. These queries are not an unauthenticated cross-tenant API. Use existing structured logs for `scanner.stall_detected`, `counters.drift_detected`, `auth.delivery_*`, `auth.otp_unavailable`, and `assignment.recovery_required` alongside existing HTTP/loop/database instrumentation. Missing samples are unknown, not zero.

## Compatibility rollback

Disable new issuance using the switches or global percentage **on this compatible binary**. Existing protected OTPs, outbox drains, assignment receipt lookup, pending recovery, version guards and undo must keep working. Stop new scanner producers using existing controls if needed; do not delete active claims to force progress.

Do **not** simply deploy the PR #231 binary backward after durable work has been issued. It cannot read protected OTPs or durable assignment receipts/undo tokens. Use a compatibility build retaining these readers/workers and schema guards. If that is unavailable, an explicitly disruptive write freeze and reconciliation is required before rollback; preserve encryption keys and all receipts. Never restore an old database snapshot over already-accepted external effects as a deduplication shortcut.

The elapsed staging, canary and monitoring gates remain pending. No live infrastructure, secrets or customer communication are changed by this implementation/runbook.
