# Production read latency follow-up

## Outcome

Remove verified unnecessary write-lock contention discovered while measuring the
authorized deployment, retaining all invitation and scanner policy behavior.

## Context

Release 266c7bb deployed successfully in Actions run 33982231000. Live browser
warm route readiness is 118–182 ms including automation overhead, but some Leads
reloads wait over 20 seconds and eventually show a recoverable read error. The
read-only production report (run 33982893049, 17:53–18:04 UTC) records GET
/api/leads p50 10.96 ms and p95 19692.95 ms (18 requests). HTTP worker loops stall
up to 46.9 seconds on synchronous SQLite writes. Production busy_timeout is
120000 ms. Capacity shows no active RAM/disk pressure.

## Safety invariants

- No customer messages, scans, payments, production data repair or configuration
  changes for testing. Preserve tenant access, token validity/renewal and provider
  eligibility, budgets, ordering and compare-and-set claim semantics.
- Root is the only writer. Independent agents investigate and review read-only.
- No migration or dependency change. Preserve the existing exact-SHA CI and
  deployment/health gates; the user's ship/deploy authorization remains valid.

## Milestones

1. Trace the slow SQL to actual callers and reproduce unnecessary work locally.
2. Remove no-op invitation token persistence on pipeline reads, with read-only
   database and renewal regression tests.
3. Independently assess scanner claim transaction contention; change only when
   a measured, behavior-preserving correction is demonstrated.
4. Run focused regressions and `bash scripts/agent-verify.sh full`, independently
   review, release through successful exact-SHA CI, and remeasure live reads.

## Progress

- [x] Deployment and desktop/mobile live measurement completed; slow reloads found.
- [x] Production telemetry collected with existing read-only perf-report workflow.
- [x] Unconditional invitation token UPDATE traced to the Leads page's parallel
  onboarding pipeline read. Equal deterministic tokens need no persistence.
- [x] Regression reproduction and fixes: query-only invitation read fails before
  guard; natural stale queue statistics choose SCAN before the three index hints.
  Focused invite/override suites passed 70 tests; final combined scanner/invite
  suites passed 52 tests, including signing-secret rotation.
- [x] Independent code/security review found no blockers. Scanner predicates,
  ordering, transaction, budgets and provider behavior are unchanged.
- [x] Full local gate passed: 631 files, 7,843 tests, tsc, tsgo, production build,
  harness and deployment safety. Local Docker Compose config validation is
  unavailable on this host; exact-SHA CI retains that gate.
- [x] Exact-SHA CI 33983496070 passed 631 files / 7,843 tests and build for
  8e828435a958dbf4b149d2f48af1c8243b8f1bf5. PR #214 merged as 88c3b44;
  its tree exactly matches the release. Deploy run 33984552292 reported that
  exact SHA healthy at 18:38:26 UTC, retaining 266c7bb for rollback.
- [x] Live desktop/mobile checks complete; all six Leads reloads succeeded in
  411–723 ms. Server report 33984789707 (18:38:15–18:40:34 UTC) has 10 loop-lag
  samples with worst maximum 175.4 ms, versus up to 51,137 ms before the fix.
  Four recorded Leads requests completed in at most 30.72 ms. No recurring slow
  scanner-claim/governor/bandwidth statements appeared in this short window.
- [x] Measurement report updated and browser viewport restored; session retained.

## Decisions

Do not reduce global busy_timeout or remove provider governors to hide lock waits.
An UPDATE with an equality guard still acquires the write lock: avoid issuing
the UPDATE when stored token hash and expiry already match. Keep hashes private.

## Discoveries

The list SQL is bounded and normally fast. Parallel onboarding reads and
background writes block a synchronous HTTP worker even when the list itself is
read-only. Natural stale statistics after draining a large run can make scanner
skip UPDATEs scan the entire history while holding the writer. Pinning the old
idx_srt_run_state index fixes that reproduced access path without moving any
transaction boundary or changing a policy predicate. Live EXPLAIN was not taken.

## Validation

Use synthetic SQLite fixtures only. Prove unchanged invite reads work with
query_only enabled, and actual renewal/legacy-token repair still persists and
invalidates old tokens. Preserve existing tenant and one-use token tests.
Browser timings are observed readiness, not Web Vitals. Report slow samples as
well as medians; production HTTP statistics have a short, explicitly stated window.

## Recovery

Keep code changes independently revertible. Release 266c7bb remains the current
release while local fixes are developed. Normal deployment health rollback stays
enabled. No production data rewrite is part of this follow-up.

## Result

Both corrections are deployed and independently reviewed. Full CI passed and the
live browser/server recheck shows the demonstrated long stalls did not recur
during the measured window. The report distinguishes cache-warm DOM readiness
from paint/Web Vitals, records secondary-panel loading, and retains the short
sample limitation. No production credentials, customer messages, paid scans,
financial actions, migrations or configuration changes were used for testing.
The optional-backup trap issue remains a separate operations follow-up.
