# SaaS upgrade board

Updated 2026-09-08. This versioned Kanban board is the program source of truth, with GitHub issues for discussion and execution. GitHub Projects creation is unavailable because the current token lacks `read:project`; no account permissions were changed.

Columns: **Ready** → **In progress** → **In verification** → **Ready for release** → **Released**. **Needs design** records a real dependency, not abandoned work. Owner lanes correspond to the specialized agents in the supplied plan; root integrates changes and independent reviewers check them.

| ID | Priority | Owner lane | State | GitHub work item |
| --- | --- | --- | --- | --- |
| FND-01 | P0 | Architecture / Data / Async | In verification | [Verify and ship the first SaaS foundation safeguards](https://github.com/MuizzM/homefront-fiber-leads/issues/218) |
| ASYNC-01 | P1 | Async / Architecture | Ready | [Make assignment operation receipts durable across workers and restart](https://github.com/MuizzM/homefront-fiber-leads/issues/219) |
| ASYNC-02 | P1 | Async / Security | Needs design | [Define tenant-safe notification routing and periodic retry dispatch](https://github.com/MuizzM/homefront-fiber-leads/issues/220) |
| TEST-01 | P1 | Testing / DX | Ready | [Isolate browser tests before enabling critical-flow CI](https://github.com/MuizzM/homefront-fiber-leads/issues/221) |
| PERF-01 | P1 | Performance / Data | Ready | [Commit reproducible performance scenarios and calibrated regression budgets](https://github.com/MuizzM/homefront-fiber-leads/issues/222) |
| ARCH-01 | P1 | Architecture / Frontend / DX | Ready | [Extract one typed domain workflow without changing business behavior](https://github.com/MuizzM/homefront-fiber-leads/issues/223) |
| UX-01 | P2 | Design / Frontend | Ready | [Apply the existing design system consistently to role workspaces](https://github.com/MuizzM/homefront-fiber-leads/issues/224) |
| MAP-01 | P2 | Map / Product | Needs design | [Add explicit offline territory coverage and conflict-safe field recovery](https://github.com/MuizzM/homefront-fiber-leads/issues/225) |
| AI-01 | P2 | AI / Security / Product | Needs design | [Establish AI privacy, cost and evaluation contracts around existing assistance](https://github.com/MuizzM/homefront-fiber-leads/issues/226) |
| OBS-01 | P1 | Observability / Testing | Ready | [Define measured SLOs and safe request-to-job observations](https://github.com/MuizzM/homefront-fiber-leads/issues/227) |
| PLAT-01 | P2 | Platform / Data / Architecture | Needs design | [Rehearse capacity and recovery before deciding database or hosting migration](https://github.com/MuizzM/homefront-fiber-leads/issues/228) |
| DX-01 | P2 | Documentation / Integrator | Ready | [Keep onboarding, API contracts and upgrade evidence reproducible](https://github.com/MuizzM/homefront-fiber-leads/issues/229) |
| ASYNC-03 | P1 | Async / Testing | Ready | [Characterize import attempt fencing and worker recovery ownership](https://github.com/MuizzM/homefront-fiber-leads/issues/230) |

## Prerequisites and acceptance criteria

### FND-01 — Verify and ship the first SaaS foundation safeguards

Prerequisites: None.

- Validate organization-scoped financial queue reads/actions against immutable event ownership, including invalid context and foreign IDs.
- Commit queue recovery and tenant audit atomically; retry temporary writer contention asynchronously and return a retryable failure on exhaustion.
- Apply alert retention per tenant, protect live leases/new arrivals, bound writes and prove partial-failure/restart behavior.
- Run the index-definition collision check in CI/local verification; retain migration/query-plan and full-suite evidence.
- Publish ADRs, owned roadmap and the release/rollback record. Local completion is separate from CI, merge and deployment.

### ASYNC-01 — Make assignment operation receipts durable across workers and restart

Prerequisites: FND-01; characterize current precedence. A new product decision is required only if ownership/visibility semantics change.

- Characterize existing preview/geometry/lens/tenant/branch scope and net-change semantics before persistence edits.
- Persist operation receipt, progress and idempotency so retry on a different worker or after restart returns the same outcome.
- Preserve exact committed/remaining/error counts and CAS undo; preserve existing 10-minute undo, 5,000-door and eight-receipt-per-tenant limits unless separately decided.
- Fault-test chunk interruption, expired/cancelled work, foreign access and intervening assignment changes; keep provider/money rules unchanged.
- Measure writer hold, request latency and throughput against a named fixture; reuse existing preview/confirm UI.

### ASYNC-02 — Define tenant-safe notification routing and periodic retry dispatch

Prerequisites: FND-01; recipient ownership and approval rules.

- Document recipient/channel ownership before dispatching non-default tenant alerts; do not send tenant data to a shared global inbox by default.
- Add a bounded due-tenant dispatcher to the existing outbox independent of default-tenant market scanning.
- Preserve shared provider breaker, finite attempts/backoff, per-tenant budgets, claim fencing and feature/consent gates.
- Test two tenants, quiet-tenant progress, retry after restart, expired/live leases, exhausted delivery and ambiguous remote acknowledgement.
- Document at-least-once email and multi-channel replay; use channel receipts/provider idempotency where justified. No live sends during tests.

### TEST-01 — Isolate browser tests before enabling critical-flow CI

Prerequisites: FND-01.

- Create a disposable local DATA_DIR for each run and pass it consistently to server and fixture helpers.
- Use synthetic identities and local-only mutation guards; refuse repository/production data files and nonlocal test targets.
- Remove mandatory parent-directory marketing-server dependency from portal tests and handle cancellation cleanup.
- Run first-login/session restoration and durable field-save/replay smoke with email/providers disabled.
- Only then add browser CI; keep existing unit/integration/type/build gates and attach reproducible failure artifacts.

### PERF-01 — Commit reproducible performance scenarios and calibrated regression budgets

Prerequisites: FND-01; TEST-01 for browser gates.

- Commit rerunnable fresh-feed, sparse-backlog, dashboard, writer-contention and restart fixtures using only synthetic data.
- Pin source/fixture/runtime provenance and prove exact results/query plans/accounting alongside timing distributions.
- Measure critical API routes, database writer holds, job lag, initial/route/chunk bytes and browser LCP/INP under named tenant/device/network tiers.
- Record index build/storage/write cost; distinguish server acknowledgement from real email delivery.
- Gate deterministic bounds immediately; calibrate timing variance and representative targets before hard CI thresholds. Do not claim million-user readiness from tiny warm samples.

### ARCH-01 — Extract one typed domain workflow without changing business behavior

Prerequisites: FND-01; choose a characterized vertical slice.

- Use current domain map and public command/store ownership; keep current React/Vite/Express layout.
- Define input/output/error/cursor/idempotency contracts shared by API and typed browser client.
- Preserve session/tenant/scope keys, complete-response deadlines, cancellation and late-response rejection.
- Prove response/permission/side-effect parity before and after extraction and measure bundle/API impact.
- Add an enforceable dependency boundary for the extracted slice; avoid a wholesale directory/framework rewrite.

### UX-01 — Apply the existing design system consistently to role workspaces

Prerequisites: TEST-01; PERF-01 browser baseline; ARCH-01 chosen slice.

- Inventory existing tokens, Radix components, scaffold, mobile shell and current role workspaces before adding components.
- Document missing variants and create a local component catalogue/Storybook only where it supports review.
- Improve one high-value role flow with responsive loading/empty/error/offline/focus states and persisted filters.
- Run keyboard/accessibility and visual comparisons on desktop/mobile, plus route/chunk performance checks.
- Do not invent a recruiter role: agree server permissions first; preserve existing Applications access.

### MAP-01 — Add explicit offline territory coverage and conflict-safe field recovery

Prerequisites: TEST-01; ASYNC-01; offline map/resource budget and assignment precedence.

- Build on viewport feeds, density tiers, virtualized list/detail and existing durable knock queue.
- Define a bounded territory pack with coverage/revision/expiry indicators; distinguish cached pins from offline basemap availability.
- Test reload, duplicate replay, newer server outcomes, revoked access and account switch without exposing another tenant data.
- Keep queued versus confirmed field outcomes truthful; preserve credited-rep versus queue-owner semantics.
- Measure pack storage, viewport responsiveness and synchronization cost on named field devices.

### AI-01 — Establish AI privacy, cost and evaluation contracts around existing assistance

Prerequisites: FND-01; agreed first read-only use case and data/provider policy.

- Inventory existing deterministic ranking/coaching and optional calling script enhancement; retain deterministic/offline fallback.
- Define tenant/user scoping, data minimization, bounded requests/time/cost, provenance and output validation.
- Implement one source-backed explanation or reviewed summary with visible uncertainty and approve/reject feedback.
- Test unsupported claims, malformed outputs, timeouts, quota exhaustion, foreign context and adversarial source content.
- Keep assignment/contact/permission/commission changes behind existing authorized human actions; measure acceptance/errors/time saved before expansion.

### OBS-01 — Define measured SLOs and safe request-to-job observations

Prerequisites: PERF-01 fixture and workload definitions.

- Inventory existing structured request/loop/SQL/job signals before adding instrumentation.
- Propagate safe correlation identifiers through one browser/API/job slice without raw payloads, tokens or high-cardinality customer labels.
- Record latency distributions, aborts, writer waits, queue age/attempts/outcomes and frontend errors with sample counts.
- Define SLOs and actionable alerts from representative critical-flow baselines; choose destination/owner before paging.
- Publish an incident playbook and test alert/report privacy and failure paths; do not add paid monitoring infrastructure without a concrete decision.

### PLAT-01 — Rehearse capacity and recovery before deciding database or hosting migration

Prerequisites: ASYNC-01; PERF-01; OBS-01; workload/cost/recovery targets.

- Specify concurrent active users, tenant row tiers, jobs, geography, costs, RPO/RTO and availability needs.
- Load-test current topology with realistic synthetic data; identify measured writer/storage/process bottlenecks.
- Compare incremental current-host changes with managed PostgreSQL/RLS/PostGIS or other targets using explicit ADR and operational cost.
- Rehearse backup/restore and any schema/data migration with constraint/tenant/financial reconciliation, catch-up, rollback and exact-SHA deployment guards.
- Only after approved concrete design, introduce stateless processes/object storage/CDN/canary infrastructure as needed. Do not assume Docker already implies multi-host safety.

### DX-01 — Keep onboarding, API contracts and upgrade evidence reproducible

Prerequisites: FND-01; ARCH-01 selected contract.

- Maintain roadmap/ADRs/owned backlog with implemented, tested, CI-verified and deployed states distinguished.
- Generate API reference from the selected contract; document adding a domain, migration, fixture and safe rollout.
- Create a clean-checkout onboarding exercise that installs, tests and debugs a synthetic workflow without parent projects or production secrets.
- Publish weekly meaningful progress/risk summaries and link validation/PR evidence; keep historical audits labelled as snapshots.
- Update component, testing and incident references as each phase changes them; do not mark proposed capabilities as shipped.

### ASYNC-03 — Characterize import attempt fencing and worker recovery ownership

Prerequisites: FND-01.

- Inventory current claim/reclaim/attempt/progress semantics in both existing import workers and their stores.
- Add per-attempt fencing where stale workers can mutate reclaimed jobs; preserve idempotent row effects and bounded attempts.
- Exercise real primary/control/HTTP/standalone installers: one owner, no claims after stop, no duplicate timers on restart.
- Test partial row/file failure, missing encrypted source, reclaimed attempts and audit/accounting consistency with no real provider call.
- Measure lock holds and yield/throughput before changes; explicitly document intentionally volatile staging instead of promising crash durability.

## Original plan coverage

Architecture, tenancy, data/indexing and durable work begin in FND-01, with durable receipts/fencing and tenant-safe dispatch in the following foundation items. Performance, frontend, design, map, AI, observability, testing, platform and developer experience each have owned work above. This board records phased execution, not completion of the full original plan.

Within those items retain the original proposals as evaluated sub-deliverables: accessibility/visual/security CI and component variants (TEST-01/UX-01); visible natural-language filters, reviewed note summaries, assignment explanations and manager digest plus impact metrics (AI-01); generated API docs and onboarding/runbooks (ARCH-01/DX-01); managed database, PITR/read replicas, object storage/CDN, secrets, per-tenant limits, canary/blue-green, IaC and disaster recovery (PLAT-01). Choose and validate each against the actual stack, business rules and cost envelope before implementation.

An active reviewer is not a permanent service owner. Before launch, each SLO/alert, provider integration and operational runbook needs a named human owner. Weekly updates should report meaningful changes and risks, cite test/release evidence and remain quiet when nothing actionable changed.
