---
name: homefront-scanner-safety
description: Design, change, debug, or review Homefront Kinetic/Decodo scanning, fresh-fiber discovery, market monitoring, new-build radar, provider transport, retries, queues, budgets, or geographic scope. Use whenever scanner behavior, provider calls, bot-wall responses, concurrency, scan spend, or discovered leads are involved.
---

# Change scanner behavior safely

1. Read the relevant scanner and operations documentation under `docs/`, then trace the real path from admission through provider transport, normalization, qualification, persistence, publication, and lead visibility.
2. Record the authorization source, tenant boundary, geographic scope, queue owner, retry bound, concurrency bound, spend bound, freshness definition, and stop condition.
3. Treat CAPTCHA, non-JSON challenges, ambiguous authorization, and provider-policy responses as stop conditions. Never add challenge evasion or an unbounded identity-rotation loop.
4. Keep paid or external work behind server-side authorization, operational feature gates, and an explicit finite scan batch. UI controls are not sufficient.
5. Preserve immutable super-admin semantics and ordinary-user tenant isolation for jobs, observations, progress, results, streams, exports, and caches.
6. Define a fresh lead as an authorized address newly confirmed serviceable within a stated time window, with recorded evidence and rule version. Lead creation time alone does not prove freshness.
7. Canonicalize address identity before provider calls and deduplication. Retain observation history so a transition from unavailable or unknown to serviceable can be proven.
8. Use deterministic idempotency keys for scan batches, address attempts, provider observations, and lead publication. Worker restarts and retries must not create duplicate work or leads.
9. Version qualification rules and record reason codes, observed-at, first-qualified-at, last-confirmed-at, source, technology, and maximum qualified tier when the existing schema supports them.
10. Prefer incremental discovery: prioritize authorized market changes, new-build inputs, stale/unknown observations, and bounded rechecks instead of repeatedly scanning every known address.
11. Measure discovery yield, confirmation rate, duplicate rate, provider requests per confirmed lead, queue age, retry exhaustion, latency, and scan cost. Never improve apparent yield by weakening qualification.
12. Add focused tests for success, denial, canonical duplicates, qualification transitions, stale observations, retry exhaustion, restart idempotency, tenant separation, publication suppression, and accounting accuracy.
13. Use an ExecPlan for cross-cutting scanner work, use `$homefront-backend-system-design` for architectural decisions, and finish with `$homefront-verify-change` at `full` level.

A live or paid scan is a separate operational action. Code completion or green tests do not authorize it. The final report must state the exact approved source, market scope, request and spend limits, stop conditions, and operator approval still required.
