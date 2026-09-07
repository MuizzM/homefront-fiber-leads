# Performance audit follow-through

## Outcome

Close the measurable performance gaps left by the earlier audits: interactive
requests remain responsive during background database contention; idle/hidden UI
does not keep unnecessary work running; large fixtures use bounded queries and
memory. Preserve every active feature and integration. Completion requires a
coverage inventory, before/after evidence, failure-path tests and a sustained
validation run, not only green unit tests or a quiet post-restart sample.

## Context

Base `d5bde1f2522a8f8adb23e8d658ce8ac9e2fa61aa` includes the deployed login fix
`01cd63a`. Isolated worktree `homefront-performance-follow-through`, branch
`codex/performance-follow-through`; other worktrees remain untouched. Prior
reports: `docs/CLEANUP_PERFORMANCE.md`, `docs/UX_PERFORMANCE_AUDIT.md`,
`docs/PRODUCTION_BROWSER_MEASUREMENTS.md`, `.agent/plans/worker-stalls.md`.
The previous audits collected only short post-deploy windows. September 7
production showed HTTP stalls >40 seconds; the login release removed automatic
token warming on HTTP workers and bounded OTP lock waits. Its initial 74-second
observation still recorded a 1.29-second first-seen-live scan read.

## Safety invariants

- One writer (root); independent code, test, security and product reviews.
- Preserve tenant boundaries, fresh authorization, financial/accounting facts,
  calling consent, provider admission, budgets and bounded retries.
- Use synthetic accounts/data and mocked providers for stress/reproduction;
  production collection is read-only aggregate telemetry.
- Preserve data and active APIs/integrations. Add indexes only after query-plan
  evidence; no production data rewrite, secret change or paid scan.
- The user authorized deployment during this performance/login task. Preserve
  exact-SHA CI, default-branch provenance and verified recovery requirements for
  this follow-through; do not repeat the approval question for the same scope.

## Milestones

1. Inventory runtime ownership, UI resource lifecycles, and hot query paths;
   collect production report 34143348391 over a longer post-login-release window.
2. Reproduce each material finding against base with synthetic data, contention,
   elapsed-clock timer cycles and cold/warm paths. Record scope/limits.
3. Implement coherent fixes with regression tests, retaining only measured gains.
4. Run focused suites and a sustained contention workload, inspect final diff,
   obtain all independent reviews, run `bash scripts/agent-verify.sh full`.
5. Prepare a draft PR with exact-commit CI and explicit coverage/remaining limits.
   For any authorized deployment, compare sustained production windows under
   comparable traffic; do not call a startup-only sample comprehensive.

## Progress

- [x] 2026-09-07: Isolated worktree created at current default branch; relevant
  skills/instructions read; read-only production report dispatched.
- [x] 2026-09-07: Independent backend lifecycle, query/test, and frontend audits
  started while root traces production query shapes and validation tooling.
- [x] Findings inventory and base reproductions; see `docs/PERFORMANCE_FOLLOW_THROUGH.md`.
- [x] Fixes and measured regressions implemented; 900.8-second contention soak passed all nine reconciliation checks.
- [x] Full verification: 643 files / 7,906 tests, both type checkers, harness, deployment guard and build. All independent reviews completed.
- [ ] Release PR, exact-commit CI and authorized deployment; use GitHub workflow records for final release status.

## Decisions

Avoid blanket timeout reductions, cache-based hiding of authoritative reads,
wholesale rewrites, new infrastructure, and cosmetic dead-code churn. Fix the
specific owners/work that cause measured stalls. Do not infer complete coverage
from test count; record paths actually exercised and workloads absent.

## Discoveries

- The 30-minute requested first report (34143348391) actually covered only
  6m28s since restart, with mostly health requests; it is not sustained coverage.
- Independent actual-SQL benchmark: 180,003 targets/18,000 evidence rows;
  feed median 20.85→1.92ms, full result 24.22→7.78ms; six tenant/window comparisons
  equivalent. Added stable descending-ID tie order after a 350-row tie fixture
  exposed selection drift.
- Review caught and corrected an outer reporting transaction that would have
  held the writer during computation, a cleared-incentive cursor progress bug,
  a late-old-session401 side effect and missing Live Ops foreground refresh.
- First full gate used a changing source tree and failed two obsolete source
  wiring assertions plus a stale-transform version of the new401 test. Updated
  assertions retain the expanded behavior contract; focused 46 tests pass.
  Second full gate found one further source-test extraction boundary invalidated
  by the cached-grid cancellation fix; it passed7,902/7,903 tests. The extracted
  branch now ends at its return, preserving its assertions; focused26 tests pass.
  Third full gate includes the final query fixes and financial atomicity test.
- Read-only final security review has no outstanding material findings. Product
  review passed 41 tests plus four real-observer Live Ops resume cases. A 15-minute
  three-process synthetic contention/restart soak is running under `/tmp`.


## Validation

Use `EXPLAIN QUERY PLAN`, representative synthetic cardinalities, query counts,
event-loop/HTTP timings with a competing SQLite writer, bounded scheduler cycles,
UI visibility/offline/unmount tests and desktop/mobile fixture checks where
affected. Report p50/p95/max and failed requests, sample count, duration, cold/warm
conditions. Full repository gate and CI remain mandatory.

## Recovery

Changes are isolated and revertible by coherent commit. Additive indexes must
remain compatible with the previous app. Preserve exact-SHA deployment and its
health/rollback path. No production data alteration is part of this audit.

## Result

Implementation and local validation complete. Thirteen traced areas are covered
in `docs/PERFORMANCE_FOLLOW_THROUGH.md`, with synthetic benchmark/soak evidence
under `docs/performance/`. The whole codebase is not certified free of bottlenecks.
Next action: commit this verified tree, prepare the release PR, await exact-commit
CI, merge and deploy under the existing authorization, then collect deployment
health and post-release timing evidence. Latest off-host backup/restore check:
run 34031032636, successful September 6 at 11:42 UTC. Changes add compatible
indexes only; no destructive migration or data rewrite is required.

## Additional measured findings

Report 34145144785 provides a 29m57s pre-release window. It exposed repeated
~500ms claimable-count and~565ms stranded-run probes. The actual queries used
`state='queued'`, which SQLite did not infer implied the existing partial
index's `state IN ('queued','inflight')`. Repeating that redundant predicate
makes both use `idx_srt_pending`; no new index or provider eligibility change.
The 200,160-run/400,207-target fixture preserves counts and every returned field
and order at four limits, with and without ANALYZE. Medians 10.40→0.035ms and
10.43→0.134ms. The real-schema regression uses TEXT run IDs; initialization
runs the existing startup lazy migration for `reopen_count`.

### Final local checkpoint

The final frozen-tree gate passed. The financial publication test also proves
that a failed incentive cursor write rolls back the award and lease, then retry
pays exactly once. The real-schema sparse-queue regressions and all UI lifecycle
checks are included in the 7,906-test total. Source versions of all four modules
exercised during the soak were unchanged; all nine consistency checks passed.
Expected SIGKILL losses and bounded contention denials are documented explicitly.
