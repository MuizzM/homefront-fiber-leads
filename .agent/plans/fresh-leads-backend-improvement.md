# Fresh-leads backend improvement

## Outcome

Deliver a production-grade, tenant-safe backend pipeline that finds more genuinely fresh fiber leads from authorized sources while reducing duplicates, wasted provider requests, ambiguous qualification, and unrecoverable scanner jobs. The completed system must prove why a lead is fresh, remain bounded under failure, and expose useful operator metrics without accessing production or running a paid scan during implementation.

## Context

Follow `AGENTS.md`, `.agent/PLANS.md`, `$homefront-backend-system-design`, `$homefront-scanner-safety`, and `$homefront-verify-change`. Trace the actual implementation before changing it; do not assume file names or rewrite working subsystems.

Fresh means an authorized address newly confirmed serviceable within a documented window or release event, supported by an observation timestamp and qualification evidence. It does not mean merely recently inserted into the leads table.

## Safety invariants

- Enforce tenant scope on jobs, observations, results, streams, caches, exports, and lead publication.
- Use only documented and authorized provider interfaces and approved source data.
- Stop on CAPTCHA, challenge pages, ambiguous authorization, or provider-policy responses.
- Bound every batch by geography, address count, concurrency, time, attempts, requests, and estimated spend.
- Never log or commit secrets, real customer data, production databases, or raw exports.
- Do not deploy, mutate production, or run live/paid scans without a separate explicit approval.

## Milestones

### 1. Map and measure the existing backend

- Trace scanner admission, scheduling, provider transport, normalization, qualification, persistence, publication, and UI/API visibility.
- Identify schemas, tenant checks, job state transitions, retry/concurrency/budget enforcement, and existing tests.
- Establish current metrics or add non-sensitive instrumentation for discovery yield, confirmation rate, duplicates, requests per confirmed lead, queue age, latency, failures, and cost.
- Add characterization tests for important current behavior.

Validation: targeted tests plus a documented architecture map and baseline.

### 2. Make address identity and work idempotent

- Establish one canonical address identity policy without destroying raw source evidence.
- Add deterministic keys for batches, address attempts, observations, and lead publication.
- Prevent duplicate work across retries, worker restarts, imports, and overlapping market scans.
- Verify tenant boundaries at every persistence and streaming path.

Validation: canonical-duplicate, restart, overlapping-batch, and cross-tenant tests.

### 3. Model qualification and freshness

- Separate provider observation, serviceability qualification, freshness transition, lead publication, and rep assignment.
- Preserve enough observation history to detect unknown/unavailable-to-serviceable transitions.
- Version qualification rules and store reason codes and relevant timestamps.
- Define stale, suppressed, exhausted, rejected, and operator-review behavior.

Validation: transition tables and regression tests for every state change.

### 4. Bound scheduling and provider interaction

- Create finite batches with explicit admission rules and stop conditions.
- Enforce concurrency, timeout, attempts, backoff, request, and spend limits server-side.
- Make retry behavior classification-aware and non-multiplicative.
- Prefer authorized incremental signals, new-build inputs, market changes, and stale/unknown rechecks over indiscriminate full rescans.

Validation: retry exhaustion, partial failure, cancellation, budget exhaustion, and load tests using fixtures or controlled adapters.

### 5. Publish actionable fresh leads

- Publish only qualified, unsuppressed, tenant-owned leads with evidence and freshness metadata.
- Keep assignment separate from scanner truth.
- Expose operator filters and explanations for freshness, qualification, source, age, and suppression without leaking sensitive data.
- Ensure exports and streams preserve tenant and authorization boundaries.

Validation: API, persistence, UI/contract, export, and tenant-separation tests.

### 6. Production readiness review

- Run full verification and review the final diff for privacy, provider policy, unbounded work, accounting drift, migration recovery, and accidental production effects.
- Document monitoring thresholds, feature flags, rollout stages, rollback, and recovery.
- Produce a dry-run report showing expected scope and cost.
- Stop before any live scan and request explicit approval with exact market, source, request/spend cap, concurrency, and stop conditions.

Validation: `bash scripts/agent-verify.sh full`, build, deployment guard, and final decision record.

## Progress

- [x] 2026-08-21: Added the architecture skill and strengthened fresh-lead scanner guidance.
- [ ] Map current implementation and establish baseline.
- [ ] Complete milestones 2–5 with regression coverage.
- [ ] Complete production-readiness review.
- [ ] Obtain separate approval for any live or paid scan.

## Decisions

- Improve the existing backend incrementally before considering new infrastructure.
- Treat freshness as an observed serviceability transition, not a row creation timestamp.
- Optimize confirmed fresh leads per authorized request, not raw addresses processed.
- Keep live scanning outside the autonomous coding run.

## Discoveries

Populate with repository evidence while tracing the implementation.

## Validation

Record exact commands, results, skipped checks, and environment limitations for every milestone.

## Recovery

All migrations must be forward-only and restart-safe. New behavior must remain behind feature gates until backfill/dry-run validation succeeds. Workers must safely resume without duplicating work. Document a rollback or disable path before enabling new publication behavior.

## Result

Complete after implementation with behavior delivered, measured improvements, remaining risks, and the exact approvals required for a bounded live run.
