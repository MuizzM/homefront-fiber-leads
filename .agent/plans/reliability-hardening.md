# Reliability and recovery hardening

## Outcome

Daily refresh counts agree for equivalent SQLite and ISO timestamps without repeated inventory scans. Scanner initialization and provider admission cannot leave immortal local workers. Login delivery and bulk assignment have durable, tenant-safe recovery identities. Operators can inspect bounded recovery queues and safely resolve eligible failures. Production rollout is gated on actual elapsed soak and canary evidence.

## Context

Branch `feature/reliability-hardening` starts at deployed PR #231, `02874d194773c2c0f127e9411b1edd7890d83326`. SQLite is the persistence engine. The user's September 8 reliability specification provides goals and illustrative PostgreSQL code; implement the goals against the existing queues and transactions instead of adding an incompatible second database.

Relevant paths: `server/dailyMarketRefresh.ts`, `server/storage.ts`, `server/scanEngine.ts`, `server/distributedProviderCoordinator.ts`, `server/routes.ts`, `server/calling/crypto.ts`, `client/src/pages/Login.tsx`, assignment callers under `client/src/`, and current scanner/notification diagnostics. Durable-work and tenancy contracts are in `docs/adr/0003-durable-work-contract.md` and `docs/architecture/tenancy-model.md`.

## Safety invariants

- One writer integrates changes; independent agents map and review read-only.
- Positive authenticated tenant scope on ordinary recovery queries/actions; global authentication jobs retain immutable user ownership without inventing a tenant.
- No provider policy, concurrency, spend, lead truth, assignment eligibility, financial ordering, or ten-minute undo-policy changes.
- No customer mail, paid scans, production writes, secret rotation, or production data fixtures during local validation.
- Additive, repeatable SQLite schema changes. Short immediate transactions with asynchronous bounded busy retries; no external await within a write transaction.
- Stable operation IDs survive retries. Effects, receipts, and recovery state commit together. External mail requires provider idempotency; ambiguous SMTP delivery cannot honestly promise exactly once.
- Leases are fenced; timeout does not imply a running promise was cancelled. Idle or intentional backoff is not a scanner stall.
- Never return encrypted OTP payloads, addresses, or raw provider errors in diagnostics.
- Seven full days of production-like soak, then 10% canary for 48 hours, precede the requested 50%/100% rollout. Tests do not satisfy elapsed-time gates.

## Milestones

1. Count correctness and scanner recovery: normalize indexed timestamp predicates, consistent snapshots, bounded inventory paging; clean worker initialization and bounded cancellable lock wait. Targeted regression tests and synthetic query-plan/latency/write-cost benchmark.
2. Durable operations: feature configuration, atomic assignment receipts/progress/inverses, encrypted auth-delivery outbox with bounded fenced claims, stable provider key and supersession/expiry checks. Real SQLite reopen/concurrent-worker/crash tests.
3. Tenant-safe recovery and observability: bounded summaries/list/replay/discard with actor audit, client interaction states and metrics; dashboard SQL and operational runbook. Tenant/auth/rollback tests and UI checks.
4. Independent code/security/test/product review. `bash scripts/agent-verify.sh full`, resolve defects and rerun relevant gates.
5. Reviewable PR and release checklist; isolated sustained soak with durable evidence; canary only after its prerequisite gates. Record pending real-world gates honestly.

## Progress

- [x] 2026-09-08: Read user specification, repository instructions, architecture and scanner runbooks. Created requested branch/worktree. Launched read-only scanner, email and assignment mapping.
- [x] 2026-09-08: Traced mixed-format timestamp predicates, global daily-refresh status, unbounded provider lock wait, worker initialization outside cleanup, process-local assignment receipts, and fire-and-forget OTP delivery.
- [x] 2026-09-08: Implemented indexed normalized daily counts, tenant-separated refresh status, 500-target enqueue/claim pages, bounded admission and scanner initialization cleanup.
- [x] 2026-09-08: Added encrypted atomic OTP/outbox issuance, fenced delivery claims, durable assignment chunks/inverse/receipts, actor/session checks inside write transactions, and recovery UI/API.
- [x] 2026-09-08: Added real SIGKILL and competing-process fixtures, HTTP permission-revocation tests, financial cursor/reason/audit tests, scanner diagnostic faults, and UI regression tests.
- [x] 2026-09-08: Synthetic WAL benchmark measured daily counts 163.48→2.71 ms; future-heavy recovery 59.07→0.62 ms, all-due recovery 135.46→75.02 ms. Recorded index/write costs in docs/performance. Not production evidence.
- [x] 2026-09-08: First full gate ran 8,040 tests: 8,038 passed, two older fixture assumptions failed. Corrected real-session financial fixture and maintenance mocks; targeted reruns pass.
- [x] Final review fixes verified: assignment version CAS, current undo eligibility, actionable financial rows first, bounded provider/token waits and cancellation polling.
- [x] Independent scanner, assignment, email/security and product reviews completed; concrete findings fixed. Full local gate passed: 8,055 tests across 656 files, tsc/tsgo, harness, index guard and production build. Deployment shell controls pass; Docker Compose configuration validation unavailable locally.
- [ ] Complete actual seven-day soak, canary and rollout gates.

## Decisions

- Keep SQLite and established subsystem queues; do not introduce PostgreSQL advisory locks or unsafe SKIP LOCKED pseudocode.
- Derive daily counts in a consistent query snapshot rather than inventing materialized counters that can drift. Existing SQL `count = count + 1` increments are already atomic.
- Use authenticated operation scope and request fingerprints; never retry using a new timestamp identity.
- Authentication supports organization-less users. An auth-specific delivery table may be necessary because the tenant notification outbox requires a positive tenant.
- Feature rollback must continue reading durable receipts and protected codes already issued.

## Discoveries

- Production diagnostic evidence from the prior phase attributed approximately 82 seconds/30 minutes to repeated daily aggregate queries. This is a baseline, not evidence for the changes here.
- `createOtp` currently stores plaintext and invalidates prior unused codes; reliable issuance must preserve its supersession and expiry behavior and rollback on enqueue failure.
- A diagnostic heartbeat before `runScanWorker`'s try/finally can fail while leaving its active marker and timer alive.
- Current bulk assignment chunks commit before process-local replay/undo receipt finalization. Re-resolving partially applied selection after restart changes the original operation.

## Validation

Use synthetic databases and fake transports. Cover date formats, offsets, fractional boundaries, null/malformed timestamps, cross-tenant reads, query plans, restart-safe migrations, rollback failures, competing SQLite connections, lease expiry/fencing, provider acknowledgement ambiguity, receipt replay/fingerprint mismatch, expired/superseded OTP, and compare-and-swap undo. Full required gate: `bash scripts/agent-verify.sh full`. Browser checks use local fixture state only for mutating flows. Publish measured workload and sample limits.

## Recovery

Worktree isolates the production baseline. Additive tables/columns remain readable when feature rollout is disabled; recovery of pre-existing durable jobs must not vanish with the flag. No destructive backfill. Keep exact-SHA rollback protections and backup/restore checks. Pause a rollout on drift, duplicate effects, stuck leases, tenant boundary failure, or increasing dead letters; do not erase evidence to resume.

## Result

Implementation and local verification complete. Draft PR preparation and GitHub CI follow. Staging host requested for the seven-day soak; no reliability-phase changes deployed. Soak/canary time requirements remain outstanding.

## Review discoveries resolved

- Recovery stays discoverable for already-persisted work after flags are disabled.
- Financial Set aside uses DEAD_LETTER, never falsely declares effects handled; passed-cursor replay and stale-state actions fail with 409. Action responses exclude raw errors.
- A revoked session/actor/tenant cannot mutate work after waiting for SQLite. Ordinary login-audit scope uses the immutable numeric platform marker.
- Same-millisecond assignment ownership was insufficient for undo. An additive database-maintained assignment version covers every ownership writer, including legacy code; both undo paths compare the captured version.
- Pending receipt history uses two bounded ordered reads; current undo eligibility is projected separately from immutable replay receipts.
- Ops bulk remains one-shot while legacy assignment exists. Automatic transport retry is not safe on the default-off legacy route.
- One mapper import outside test mode attempted token warming and received 403 before any checker ran. Subsequent standalone validation sets NODE_ENV=test and rejects all network before engine imports. No address check or outbound customer mail was performed.

## Final review corrections

- Bounded local admission shares the distributed deadline and retains active ownership until settlement. Shared token waits terminate callers without late leases. A fresh active distributed lease is no longer expired just for an old start timestamp, and ownership is checked again immediately before transport.
- Independent final review found and fixed cancellation allowance mutation, per-address polling amplification (one read per run per pending sweep now), and a cold initialization diagnostic deadline shorter than the allowed token wait. Regression tests cover each.
- Two visual passes completed on local mocked recovery components at 1280×1050 and 390×844. Final desktop/mobile screenshots show no horizontal overflow or JavaScript errors, and a failed recovery action retains its reason and visible error. The temporary preview was removed. No live mail or provider calls were made.
- Latest focused deadline tests passed all scanner/queue cases; the token mint timeout fixture needed explicit synchronization with mint start because module initialization could exceed its 30 ms test deadline. The fixture now separates these phases; production budgets were not widened to satisfy it.

## Final local evidence

`bash scripts/agent-verify.sh full` exited 0 on 2026-09-08 after the final source edits: harness valid, 481 literal index definitions/zero errors, both TypeScript compilers, 656 test files and 8,055 tests passed, production build passed. Docker Compose is unavailable in this environment, so the deployment script's Compose configuration check was skipped; shell deployment controls passed. Build emits a large-chunk advisory; it is not treated as proof of browser performance. GitHub CI remains a separate exact-revision gate. Raw local log: `/tmp/homefront-reliability-full-final.log`.

Code, benchmark results, dashboard queries and rollout/rollback requirements are recorded. New durable issuance defaults to zero rollout. No seven-day staging evidence, 48-hour canary evidence, post-rollout observation or 30-day flag retirement is claimed.
