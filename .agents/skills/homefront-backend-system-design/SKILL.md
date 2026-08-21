---
name: homefront-backend-system-design
description: Design, audit, refactor, or scale the Homefront Fiber Leads backend, APIs, workers, queues, scanner pipeline, tenant boundaries, persistence, caching, observability, resilience, or production readiness. Use for backend architecture, system design, deep SaaS improvement, performance, reliability, fresh-lead pipelines, or cross-cutting server changes.
---

# Design and improve the Homefront backend

## Establish the outcome

1. Translate the request into measurable operator behavior and system guarantees.
2. Define fresh leads precisely: authorized addresses newly confirmed serviceable within a stated freshness window, supported by source evidence, deduplicated, tenant-scoped, and not already exhausted or suppressed.
3. Record baseline measures before changing behavior: discovery yield, confirmation rate, duplicate rate, provider requests per confirmed lead, queue age, p50/p95 latency, retry exhaustion, error rate, and estimated scan cost.
4. Create and maintain an ExecPlan under `.agent/plans/` for cross-cutting work.

## Trace the real architecture

Map the actual path before proposing a redesign:

```text
authorized source -> admission -> scheduler -> bounded queue -> provider adapter
-> normalization -> qualification -> deduplication -> persistence
-> lead publication -> assignment/UI/export -> audit and metrics
```

For every boundary, identify the owning module, input/output schema, tenant key, authorization check, idempotency key, timeout, retry policy, concurrency limit, spend limit, and failure state. Cite repository paths and tests in the plan.

## Preserve SaaS invariants

- Enforce tenant scope in server queries, jobs, streams, caches, exports, and stored progress.
- Keep provider interaction behind explicit server-side authorization and feature gates.
- Treat CAPTCHA, bot challenges, ambiguous responses, and provider-policy errors as terminal or operator-review states. Never implement evasion.
- Make background work bounded by geographic scope, batch size, concurrency, time, attempts, and spend.
- Never let retries multiply work. Use deterministic job and observation idempotency keys.
- Keep secrets and customer data out of logs, model prompts, fixtures, and committed files.
- Make migrations forward-only, restart-safe, and recoverable.
- Do not deploy, run a paid scan, or mutate production data without explicit approval.

## Prefer an incremental architecture

Strengthen existing seams before introducing new infrastructure. Separate these responsibilities when currently coupled:

- Admission validates tenant, authorization, market scope, budget, and feature gates.
- Scheduling creates finite scan batches with explicit stop conditions.
- Provider adapters translate requests and responses without deciding business policy.
- Normalization creates stable canonical-address identities while retaining raw evidence securely.
- Qualification uses versioned rules and records reason codes.
- Freshness compares observations over time; it is not inferred solely from a lead creation timestamp.
- Deduplication prevents duplicate address/provider/tenant leads and preserves observation history.
- Publication exposes only qualified, unsuppressed leads through an auditable transition.
- Assignment is separate from discovery so rep workflows cannot corrupt scanner truth.
- Observability reports yield, cost, latency, failures, and backlog without exposing sensitive data.

Do not add a queue, cache, service, or database merely because it is fashionable. Document why the existing design cannot meet the measured requirement and the operational cost of the new component.

## Model fresh-lead state explicitly

Prefer explicit, testable concepts:

- canonical address identity;
- source and authorization scope;
- provider observation with observed-at time and evidence hash;
- serviceability status and maximum qualified tier;
- qualification-rule version and reason codes;
- first-qualified-at and last-confirmed-at;
- freshness window or market release marker;
- suppression/exhaustion state;
- publication and assignment state;
- scan job accounting, attempt count, and terminal outcome.

Preserve observation history when business value depends on identifying a transition from unavailable or unknown to serviceable. Never overwrite the only evidence of the previous state.

## Implement in verifiable slices

1. Add characterization tests around current behavior.
2. Strengthen schemas, invariants, and instrumentation.
3. Fix normalization and idempotency.
4. Make scheduling, retries, and budgets finite.
5. Implement versioned qualification and freshness transitions.
6. Harden persistence and tenant isolation.
7. Improve publication, assignment, and operator visibility.
8. Load-test only through authorized fixtures or controlled adapters.
9. Review the final diff for privacy, unbounded work, accounting drift, and production effects.
10. Run `$homefront-verify-change` at `full` level.

Each milestone must be independently deployable or safely reversible. Add regression coverage for success, denial, duplicate submissions, worker restart, retry exhaustion, partial failure, stale observations, tenant separation, and accounting accuracy.

## Produce a decision record

Finish with:

- current bottleneck and evidence;
- chosen design and rejected alternatives;
- data/API changes;
- operational limits and feature gates;
- monitoring and alert thresholds;
- migration and rollback approach;
- measured validation results;
- remaining risks and the exact approval required for any live scan.
