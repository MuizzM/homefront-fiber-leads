# User-experience performance and resilience audit

## Outcome

Reduce verified loading, navigation, rendering and API bottlenecks; make slow,
offline, empty and failed states understandable and recoverable while preserving
all active business workflows and integrations.

## Context

Base a01db653a6849d76e7ce9e97da4ca8a9ddc29f1a on
`codex/ux-performance-audit`. The production cleanup already reduced scanner
downloads, commission/payout queries and hidden map/lead work. This pass audits
remaining startup, data loading, large-list rendering and error UX. Main modules:
`client/src/lib/queryClient.ts`, `auth.tsx`, `App.tsx`, route pages, server routes
and stores. Prior findings are recorded in `docs/CLEANUP_PERFORMANCE.md`.

## Safety invariants

- Preserve tenant boundaries, authorization, financial/assignment rules, OTP
  privacy/rate limits, calling consent and scanner/provider budgets.
- Never confuse failed data with empty data, a failed save with success, or an
  unconfirmed mutation with a safe automatic retry.
- No production writes, test codes, paid scans or credential changes for audit.
  Use synthetic local fixtures for errors, timing and authenticated interactions.
- No new dependencies unless evidence requires them. Root is the only writer;
  independent audits and reviews are read-only.
- Preserve unrelated work and existing quality gates. Any publication/deployment
  uses the authorized normal workflow with successful exact-SHA CI.

## Milestones

1. Inventory startup, pages, integrations and existing guards; establish bundle,
   request/query-count and local interaction baselines.
2. Audit frontend rendering/loading, backend APIs and user-facing states in
   parallel; verify findings against real call paths and controlled fixtures.
3. Implement shared fixes followed by focused page/server corrections, with
   regression coverage for behavior, performance bounds and tenant isolation.
4. Run `bash scripts/agent-verify.sh full`, relevant browser scenarios at desktop
   and mobile, then independent review. One batched visual inspection and one
   confirmation pass; additional checks only for concrete failures.
5. Document measured changes, coverage and unresolved workload/access limits in
   `docs/UX_PERFORMANCE_AUDIT.md`; provide the commit-ready release diff.

## Progress

- [x] 2026-09-05: Isolated worktree created; existing cleanup and instructions read.
- [x] Parallel read-only audits assigned for client performance, backend hot paths
  and error/recovery UX. Root traces shared networking and auth bootstrap.
- [x] Baselines and reproducible findings recorded; see docs/UX_PERFORMANCE_AUDIT.md.
- [x] Fixes and targeted regression tests complete, including independent-review corrections.
- [x] Independent code, security, test/backend and product reviews complete; all findings addressed.
- [x] Desktop/mobile fixture checks complete, including rebuilt override confirmation.
- [x] Final full verification including browser-discovered fixes: 630 files, 7,837 tests, both TypeScript checks and production build passed.
- [x] Audit report and commit-ready diff complete.

## Decisions

Treat this as a behavior-preserving audit and correction, not a redesign. Keep
the existing navy/gold design system and accessible shared primitives. Prefer
query-count, payload and timer evidence over speculative micro-optimizations.
No blanket claim that all device or production workloads have been measured.

## Discoveries

Shared GET and auth fetch paths lack deadlines. Auth bootstrap parses unsuccessful
responses without checking status, risking session loss on transient server errors.
These findings need regression reproductions before changes.

## Validation

Use existing Vitest/RTL/integration strategy, fake timers and local SQLite fixtures.
Measure baseline and result using identical conditions. Browser inspection uses
local synthetic data for authenticated and failure scenarios; live checks remain
read-only. Full gate covers harness, deployment guards, both TypeScript compilers,
complete tests and production build. Record environment limitations honestly.

## Recovery

Keep changes grouped by shared networking/auth, pages and backend modules for
independent reversion. No destructive migration or data rewrite is planned.
The currently healthy production release is unaffected during local work.

## Result

Code fixes, independent reviews and local desktop/mobile checks are complete.
The final full gate passed with the two browser-discovered corrections below.
The report records measured gains, validation and remaining device/production
limits. No production actions were performed.

## Authorized deployment and live measurement — 2026-09-05

The user subsequently requested: "deploy it then measure in browser". This
authorizes the normal PR merge and production deployment of audited commit
`266c7bb8d7d1ca214d721713f9cd6d9fc25b495a`, followed by read-only browser checks.
Customer communications, financial mutations and scans are not test actions.

- [x] Push audited branch and open PR #213 against `rep-knocking-workflow`.
- [x] Exact-SHA CI run 33981308074 succeeded. PR #213 was already merged as e8aa072; its tree matches 266c7bb and preserves release ancestry.
- [x] Deploy run 33982231000 succeeded for 266c7bb; public health and build fingerprint 77538232daf0 verified. Previous release c7fbd4d is the rollback reference.
- [x] Live desktop/mobile measurements recorded in docs/PRODUCTION_BROWSER_MEASUREMENTS.md. Slow full reloads exposed production SQLite contention; the separate production-stall-fix ExecPlan tracks the correction.

The normal code-only cutover uses `with_backup=false`; there are no schema or
migration changes. Independent release review confirmed the usual health and
rollback controls. It also found a pre-existing optional-backup failure-trap
ordering defect, so the optional offline snapshot path is not used in this
release. This needs a separate regression-tested operations fix.

The production browser initially showed Sign in. User sign-in was requested and
the live tab subsequently reached an authenticated map session, enabling private
page measurements without reading or copying credentials.
The browser interface does not expose Performance/Navigation Timing APIs, so
report observed UI readiness timings as such, not as Core Web Vitals.


## 2026-09-05 implementation checkpoint

Shared startup/status/read operations now have deadlines and clear recovery.
Old status responses, scoped reads, internal write retries and mutation callbacks
cannot cross an identity change. Stage observers revalidate only the returning
screen and shell. Photos wait for visibility; FollowUps groups linearly and pages
50 rows/section. Financial and lead error/draft cases have targeted RTL coverage.
Backend fixes cover date-bounded leaderboard SQL and preset TTL reuse, count-first
dense map windows/lens validators, request-local import scopes and exact symmetric
ranking counts. CSV normalization avoids copying rows beyond its retained cap.

Read-only code, security, product and backend reviews completed. First full run:
628 files passed; one push wire fixture failed because it was an incomplete
Response. Replaced that fixture with native Response.json without changing
contract assertions. Focused rerun passes. The internal retry account-switch
finding was separately reproduced, fixed with a cancellable scope-bound backoff,
and re-reviewed successfully. The second full gate passed all 630 test files
and 7,834 tests, both TypeScript compilers and the production build.

Browser access subsequently recovered. Tested the production build with a
loopback synthetic API at 390 × 844 and 1280 × 900. Location access is disabled
in this fixture: its permission prompt initially blocked schedule interactions.
No real GPS or provider flows were exercised.

Browser checks found two additional corrections: focus/scroll should move to
the first appointment after paging, and downline override settings must not
be editable after their config read fails. Root implemented both, independent
reviews found no behavioral issues, and focused regression tests pass. The new
full gate passed on the final source (630 files, 7,837 tests). One local TypeScript error in the
new ErrorState prop was corrected from message to description; no gate was
weakened. No changes made to live services.

Final browser confirmation: the rebuilt override card shows its failed-read
message, Retry and a disabled switch/Save. Mobile schedule paging focuses the
first new appointment. Automated deployment checks pass; only the existing
Docker Compose configuration subcheck is unavailable on this host. Production
release/CI and field-device measurements remain outside this local audit.
