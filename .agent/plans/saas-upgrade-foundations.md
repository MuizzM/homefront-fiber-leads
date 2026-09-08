# SaaS upgrade: foundation milestone

## Outcome

Execute the user's upgrade plan in independently verifiable phases. This first
milestone establishes a repository-specific architecture, data and job contract,
an owned backlog, and executable safeguards against confirmed foundation defects.
Prevent a repeat of the silent SQLite index-name collision fixed in PR #217.
Preserve the deployed login and performance improvements from PRs #215–217.

## Context

Baseline: `e64583d64c332547b1a7eb160e801ceb2256d3be` on
`rep-knocking-workflow`. Implementation branch: `codex/saas-upgrade-foundations`.
The system is React/Vite, Express and better-sqlite3, with cluster role ownership,
durable domain events, specialized queues, and existing offline field workflows.
It is not PostgreSQL/Next.js; the supplied plan's RLS, pool and PostGIS sections
are future decisions, not current capabilities. `server/storage.ts` and separate
domain schema initializers own migrations; there is currently no `migrations/`
directory despite the older guide's repository map.

Sources: `docs/PERFORMANCE_FOLLOW_THROUGH.md`,
`docs/architecture/domain-map.md`, `server/domainEventStore.ts`,
`server/eventQueueOps.ts`, `.github/workflows/ci.yml`,
`.agents/skills/homefront-backend-system-design/SKILL.md` and
`.agents/skills/homefront-database-change/SKILL.md`.

## Safety invariants

- Ordinary reads, writes, events and retries remain tenant-scoped; document
  privileged maintenance separately. Do not widen null-tenant compatibility.
- Money ordering/idempotency, consent, provider budgets and field-save durability
  remain unchanged. No external provider calls or outbound customer messages.
- Root is the only writer; independent agents inspect and review.
- No production data, credentials or customer fixtures in artifacts.
- New database infrastructure, destructive migrations and live deployment are
  separate decisions with concrete recovery evidence. This milestone is locally
  tested and prepared as a draft PR before any release decision.
- Synthetic samples are not production SLOs or evidence of million-user capacity.

## Milestones

1. Inventory existing domains, tenancy, persistence, jobs and product features.
   Publish `docs/roadmap.md`, an ADR index, architecture/data/async references,
   and a prioritized board with acceptance tests and ownership.
2. Add a deterministic index-definition check to CI and the local verification
   workflow. Reproduce #217's conflicting `CREATE INDEX IF NOT EXISTS` declarations
   in fixtures. Permit only the explicitly documented canonical-index promotion.
   Report the coverage boundary rather than claiming dynamic SQL is checked.
3. Correct confirmed queue organization boundaries and outbox retention. Require
   immutable event ownership and atomic tenant audit for recovery; preserve global
   financial cursor/order. Retry writer contention asynchronously. Apply existing
   alert retention per tenant in 500-row batches with fixed watermarks, live-lease
   protection and a 15-second background contention budget.
4. Run focused regression tests, then `bash scripts/agent-verify.sh full`.
   Complete independent exact-diff reviews. Publish a draft PR and repository
   backlog with validation and the next milestone clearly distinguished.

## Progress

- [x] 2026-09-08: User selected phased execution, starting with foundations.
- [x] 2026-09-08: Created isolated worktree from current remote default branch.
- [x] 2026-09-08: Read the full supplied plan and repository workflows; delegated
  read-only architecture/security, testing/operations and product inventories.
- [x] 2026-09-08: Confirmed GitHub has no open repository issues. Projects access
  fails because the token lacks `read:project`; use a versioned board and linked
  issues without requesting additional account permissions during implementation.
- [x] 2026-09-08: Inventory, ADRs, architecture/data/async references and phased roadmap complete.
- [x] 2026-09-08: Index guard implemented and wired into CI/local verification; historical collision and parser failure cases covered.
- [x] 2026-09-08: Selected and implemented tenant-scoped queue recovery/diagnostics, atomic audited asynchronous retry, and per-tenant outbox retention. 83 focused tests pass.
- [x] 2026-09-08: Full gate passed: 648 files / 7,973 tests, both compilers, index guard, harness, deployment controls and production build. All independent review findings resolved.
- [x] 2026-09-08: Backlog #218–230 and versioned board published; first-phase PR prepared. Publication/CI/release state is maintained on issue #218 and its linked PR so the tested source stays immutable.
- [ ] Merge/deployment decision for this new foundation phase; no live changes made.

## Decisions

- Queue HTTP APIs require a positive session tenant for every role. No platform
  tenant override was added; internal global event ordering remains unchanged.
- Preserve notification delivery/recipient policy. Non-default periodic dispatch,
  import fencing and durable assignment receipts are owned follow-on work.
- Published 13 GitHub issues (#218–230) with priorities, dependencies, ownership
  and concrete acceptance criteria; versioned Kanban is `docs/upgrade-board.md`.

- Strengthen the existing modular monolith and durable job implementations. No
  directory-wide move, speculative queue replacement or database switch.
- Make the one-off index-name sweep from #217 a required deterministic check;
  wall-clock budgets need representative measurements and calibrated runners.
- Phase numbers describe exit criteria, not promises that a calendar date or
  infrastructure purchase proves scalability.

## Discoveries

- Baseline queue tests reproduced 21 failures (one existing capability denial
  passed). `operatorAction` ignored the supplied tenant, and diagnostics exposed
  global details; mutable queue ownership is not authoritative. Action/audit were
  not atomic. Missing organization context also reached global reconciliation.
- Baseline outbox retention tests reproduced cross-tenant supersession and writes
  against tenants individually below their cap. The existing enqueue policy is
  per tenant; startup cleanup incorrectly used one global cutoff.
- Independent review caught dynamic/quoted SQL parser false negatives, comment-only
  promotion validation, too-short background retries and synchronous operator
  contention. All were corrected with regression coverage before final review.
- 200k-row-per-table fixture: exact tenant query results unchanged; new indexed
  reads avoid unrelated history. Actual cleanup reconciles 197,900 writes over
  396 yielding batches, with 500 maximum updates and zero changes on repeat.

- The pasted plan proposes several capabilities already implemented. Inventories
  must distinguish implemented behavior, test gaps, and proposed replacement.
- Existing architecture/build-board documents contain dated defect claims and
  file sizes. The foundation references must label historical evidence and link
  to current code instead of treating those claims as a fresh audit.

## Validation

Final `bash scripts/agent-verify.sh full` passed (7,973 tests / 648 files;
144.19-second test phase). Both compilers, build, harness and deployment controls
passed. The index gate checked 462 literal declarations / 392 files, zero errors.
Local Docker Compose config validation was unavailable; the existing safety
script explicitly reported that skip. All other required local checks ran.
The first full run found one old reconciliation fixture with no underlying event;
it now emits a real immutable event and retains the original assertions. A new
orphan-state denial test covers the opposite case. Final full run passed.

Independent architecture/security/test/product reviews found no unresolved
blocking issue. Their parser, lock-budget, transaction and documentation findings
were fixed and tested. A final benchmark assertion now requires nonempty yield
observations and reconciles their sum with committed updates.

Focused: new index-check tests and relevant real-SQLite regressions. The check
must reject the historical collision, preserve string literal semantics and
partial predicates, accept equivalent repeated DDL, and fail on unreviewed
dynamic index declarations. Final: `bash scripts/agent-verify.sh full` (harness,
deployment guards, both compilers, complete tests, production build). Record
results, actual sample sizes, and any skipped environment-dependent checks.

## Recovery

No live changes in this milestone. Revert the feature commit to remove the new
CI guard and runtime slice; never revert PRs #215–217. Any exception to the index
guard must be narrowly documented and tested, not a blanket skip. Draft PR and
backlog may be revised without merging. Resume from this plan and the roadmap.

## Result

Foundation 1A is implemented and locally verified: tenant-owned financial queue
operations, atomic audit with nonblocking retries, scoped diagnostics, per-tenant
alert retention and a required index-collision gate. Roadmap, three ADRs,
architecture/data/async references, reproducible benchmark and thirteen issues
are published/prepared for review. Weekly read-only progress review is scheduled
in the current Codex task (Mondays 10:00 America/New_York; automation
`homefront-upgrade-progress`).

No merge, deployment, infrastructure change, customer message or provider call
was performed for this milestone. Issue #218 / the linked PR records remote CI
and the concrete release decision. Remaining foundations are the owned 1B
backlog (durable receipts, tenant-safe dispatch, import fencing, isolated E2E).
The full modernization and any higher-capacity platform remain future phases;
this increment does not certify every path free of inefficiencies.
