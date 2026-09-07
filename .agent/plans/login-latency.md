# Fast, atomic portal sign-in

## Outcome

Email submission and code verification stay responsive during brief SQLite writer contention. A valid code is consumed only when its session is committed; a failed transaction leaves the same code usable. Fresh login includes the same tenant and owner identity as session hydration.

## Context

Base: `88c3b44`, the current portal default branch, isolated in `codex/login-latency`. `client/src/pages/Login.tsx` already avoids anonymous status requests and duplicate submits. `server/routes.ts` currently performs independent synchronous rate-counter, OTP, audit, reset and session writes. `server/storage.ts` has no OTP lookup index, and consumption precedes session insertion. Existing busy tests use a 1 ms timeout and lock before consumption, missing both latency and partial failures. The public homepage returned 200 in 187 ms; that does not measure authenticated login. Read-only production performance workflow: 34139458947.

## Safety invariants

- Preserve account activation, organization restrictions, immutable owner identity, tenant boundaries, OTP expiry, single use and persistent cross-worker guess/send caps.
- Use synthetic accounts/databases; no live sign-in codes, email sends, session tokens or customer data for tests.
- No deployment, merge or live configuration changes without the explicit decision required by AGENTS.md. Read-only diagnostics are authorized.
- No external side effects inside a retryable transaction. Restore connection settings before yielding. Retry only SQLite contention with bounded work; preserve committed denial counters.
- Index additions are forward-only and restart-safe, do not rewrite records, and remain compatible with rollback to the prior application.

## Milestones

1. Reproduce code loss after session failure and long-lock responsiveness; inspect aggregate production measurements.
2. Add bounded asynchronous lock acquisition around synchronous immediate auth transactions, indexed OTP access, and complete login identity.
3. Verify denial/replay/rollback/brief and sustained contention with synthetic SQLite and HTTP fixtures.
4. Run `bash scripts/agent-verify.sh full`, independent read-only review and prepare a concrete reviewable change.

## Progress

- [x] 2026-09-07: Located current portal source, isolated branch, traced auth and existing tests; read required skills and delegated independent code/coverage review.
- [x] Regressions reproduced and changes implemented. Both new rollback tests failed with 401 on the old code, then passed after atomic auth transactions.
- [x] 2026-09-07: Fresh production aggregate found HTTP-worker loop stalls up to 54.9 seconds, a session renewal taking 13.85 seconds, and governor/ledger/maintenance writer waits. Automatic token warming in every process was traced to scanner module imports; background maintenance now follows actual scan consumers, including manual-token installation.
- [x] Scoped background fixes: ledger flushes yield and retain exact counters, idle maintenance reads avoid writer acquisition, one calling-maintenance scheduler runs in the primary/single-process owner, and session renewal remains best-effort without a native busy wait.
- [x] Focused auth/frontend/session/scanner/governor/retention checks passed; independent auth/security review found no material regression. Maintenance review caught an unnecessary outer transaction; retrying the existing atomic operations now preserves their read-only empty path and the prior 120-second background retry budget without blocking HTTP.
- [x] Focused tests and full verification passed: 634 files / 7,860 tests, both type checkers, production build, harness/deployment guards. Docker Compose is unavailable locally; CI retains that validation.
- [x] All four independent reviews completed. Product review found the empty-pool early return in scanner; preserved the original non-test mint permission for on-demand leases and added real scanner-entry mock cases for unset/false legacy flags. All 24 scanner transport/pool/policy tests passed afterwards. No live provider request was made.
- [ ] Exact final commit CI and reviewable delivery; deployment remains a separate explicit decision.

## Decisions

Use a scoped zero native busy timeout and asynchronous bounded retries, not a global database setting change. Take the writer once per authentication decision. A persistent store that cannot record rate limits returns retryable 503 rather than permitting guesses under separate process budgets. The HTTP outer limiter remains in force during contention. This intentionally replaces the older wrong-code-under-lock 401 and per-worker degraded-cap behavior; no code is checked or consumed before persistent admission succeeds.

## Discoveries

`verifyOtp` marks used before `createSession`; a later failure burns the first valid code. `createOtp` invalidates earlier codes before a separate insertion. Email/used OTP predicates currently scan the OTP table. The login response omits `tenantId` and `isSuperAdmin` despite sending both on status hydration.

The user clarified that the symptom is the persistent "Sending code"/loading state, not a particular error string. Production report 34139458947 covers 2026-09-07 13:40–15:40 UTC: HTTP-serving loop maximum 54,928.6 ms; governor UPSERT maximum 54,904.5 ms; session expiry update 13,850.2 ms. No OTP requests were sampled in that window, so these are shared-server starvation evidence, not measured OTP percentiles.

Scanner `shouldAutoWarmAuthorizedTokenPool()` previously excluded tests only. Every portal HTTP worker and the cluster primary imported scanner through routes and started recurring provider token refresh. Gate this automatic reserve to the existing scan-consumer role, keep on-demand acquisition and installed tokens functional, and preserve all provider admission/cost/denial rules. No live scans or provider requests were made for validation. Rare interactive provider writes can still contend; no universal response-time guarantee is claimed.

## Validation

Run named auth/OTP/session suites before full verification. Test migration on existing data and repeat execution; inspect EXPLAIN plans with synthetic historical OTPs. Exercise first-attempt success after a briefly held write lock while another HTTP request stays responsive, and preserve codes/rate counts on a failed session insertion. Actual production latency after release requires deployment and a later measurement; local timing is not a production promise.

## Recovery

Rollback the application changes using the normal exact-SHA deployment path if released. The additive index may remain. No production data conversion or configuration mutation is required.

## Result

Implementation and independent review complete. The final commit receives CI before deployment approval. In synthetic HTTP tests a brief writer conflict recovers on the same submission; sustained contention returns 503 + Retry-After after about one second without consuming a code or allowing unrecorded guesses. A final product regression test verifies cold HTTP workers still mint on demand under the exact pre-existing production permission. No production release, data rewrite, or configuration change has been performed. Live performance must be remeasured after an approved deployment; other interactive/provider transactions can still contend, so this is not a claim of universal instantaneous responses.
