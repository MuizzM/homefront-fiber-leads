# SaaS upgrade roadmap

Updated 2026-09-08. Owner: root integrator, with independent architecture,
security, test and product reviewers. The user selected **phased execution,
starting with foundations**. This is the current program record; older audit
snapshots are historical evidence, not a current list of missing features.

## Starting point

Baseline `e64583d` includes released PRs #215–217: nonblocking login writes,
single maintenance ownership, bounded map/fresh reads, indexed scanner counts,
and migration/index compatibility fixes. The stack is React/Vite/Wouter,
Express and SQLite WAL, with specialized workers. Existing design tokens, role
workspaces, viewport maps, virtual lists, offline knock replay, assignment
preview/undo, deterministic guidance and optional calling-script AI are retained.

The prior login median (~138ms, three probes) and dashboard samples (<13ms,
five reads) are useful observations, not p95/p99 guarantees. They exclude real
email delivery and do not establish capacity for millions of users. Capacity
work must name concurrent active users, tenant sizes, stored rows, peak requests,
job throughput, device/network conditions and an affordable operating envelope.

## Phases and exit criteria

| Phase | Owners | Concrete milestone and exit criteria |
| --- | --- | --- |
| 1A — current foundation slice | Architecture, Data, Async, Testing | Tenant-owned queue recovery and diagnostics; atomic audit; nonblocking lock retry; per-tenant alert retention; required index-definition gate. Two-tenant, failure/restart, migration/query-plan and full regression checks pass. ADRs and linked backlog explain current guarantees and remaining gaps. |
| 1B — reliable execution foundations | Async, Architecture, Testing, DX | Existing job/operation receipts survive restart and a different worker; tenant routing is explicit; E2E runs only on disposable local data. Pick one operation at a time. No queue/service replacement without measured need. |
| 2 — performance and UI foundation | Performance, Frontend, Design | Reproducible fixtures and route/chunk budgets; safe E2E login/save checks; extract one typed vertical slice; apply existing tokens/scaffold with accessibility and visual evidence. Preserve cancellation, offline and first-login behavior. |
| 3 — field workflow and assistance | Map, AI, Product | Durable assignment receipts/progress/undo, explicit offline coverage, and source-backed assistance. Preview/apply scope parity, replay and account isolation pass. Critical business changes still require authorized human action. |
| 4 — capacity and operations | Platform, Observability, Data | Representative concurrent workload and recovery exercise; trace/SLO coverage and tested runbook. Decide database/hosting changes from measured limits, budget and recovery requirements; rehearse migration and rollback before cutover. |
| Every phase | Testing, Security, DX, Integrator | Exact-change review, tenant/privacy/provider invariants, meaningful before/after evidence, complete required checks and an accurate release record. |

Phase 1A is an independently reviewable increment. Completing it does **not**
complete 1B or the full modernization. Testing and observability accompany every
phase rather than waiting until the final weeks.

## Decisions and sequencing

- [ADR index](adr-index.md), [domain map](architecture/domain-map.md),
  [tenancy](architecture/tenancy-model.md), [service boundaries](architecture/service-boundaries.md).
- [Data principles](data/schema-principles.md), [index strategy](data/indexing-strategy.md),
  [job architecture](async/job-architecture.md), [outbox contract](async/outbox-pattern.md).
- [Owned backlog/board](upgrade-board.md) is the execution queue. Each item has
  prerequisites and acceptance tests. A status update records evidence, risks and
  next action; it must not describe local work as deployed.
- Direct lead assignment versus shared-territory visibility needs a product
  decision before changing precedence. See [open decisions](OPEN_DECISIONS-2026-08-30.md).
- There is no recruiter role today. A new recruiter permission model precedes a
  distinct recruiter dashboard; existing Applications remains the starting point.
- PostgreSQL/RLS/PostGIS, Next.js, service extraction, Storybook hosting and paid
  observability are evaluated separately. Existing SQLite code cannot become
  stateless or PostgreSQL-compatible by changing a connection string.

## No silent regressions

Use named fixtures, source revisions, exact query/result comparisons and bounded
work assertions. Record latency distributions and sample sizes; account for
index write/storage cost and host variance. Real-user and synthetic results stay
separate. New budgets must be calibrated before becoming hard CI failures.

[Foundation evidence](performance/foundation-baseline.md) and
[previous performance evidence](PERFORMANCE_FOLLOW_THROUGH.md) record what was
actually checked. `bash scripts/agent-verify.sh full` remains the release gate;
GitHub CI and deployment evidence are separate from local validation.
