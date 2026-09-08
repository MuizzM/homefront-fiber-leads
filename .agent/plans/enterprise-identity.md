# Enterprise identity on SQLite

## Outcome

Tenant administrators can configure enterprise sign-in, review newly provisioned identities, manage directory lifecycle, enforce MFA, and revoke sessions. Existing email-code users keep their field-compatible session defaults. No unapproved, deprovisioned, MFA-incomplete, expired, or revoked identity can obtain application access through another login, restoration, stream, or delayed action path.

This is phase 1 of the user's twelve-part enterprise feature specification. Subsequent security/compliance, analytics, offline, notifications, search, reports, integrations, localization, accessibility, performance, and disaster-recovery work follows verified identity milestones. Passing tests does not establish SOC2 certification, production scale, or completed deployment gates.

## Context

- Branch `codex/enterprise-identity`, isolated worktree `homefront-enterprise-identity`, starts at reliability PR #232 head `497cc3d960e6602a4c04a96f94127f64d1da56df`.
- Source request: user attachment `ceb13ce5-e76b-440d-ad39-ae832dda2e6f/pasted-text.txt`, read in full before implementation.
- `server/routes.ts` owns OTP login, auth/status, authentication middleware, user administration, and streams. `server/storage.ts` owns users and opaque sessions. `server/recoveryAuthority.ts` checks sessions again after obtaining the SQLite writer.
- `users.email` is globally unique; ordinary users belong to one tenant. The immutable `is_super_admin` marker is separate from role. Team edits can overwrite `users.active`; identity approval and directory lifecycle must use independent persistent state.
- `client/src/lib/auth.tsx` restores offline state when status is inconclusive. Confirmed revocation clears sensitive caches and pending work. Do not shorten default sessions or preserve device-global queues across accounts.
- Current server lifetime is 7 days sliding, 30 days absolute, with hourly write coalescing. Current runtime is Node 20, now outside its supported lifecycle. Evaluate a separately reviewable supported-runtime foundation before new protocol dependencies.

## Safety invariants

- SQLite first; the user explicitly confirmed this on 2026-09-08.
- New SSO/SCIM identities require tenant-admin approval; directory `active` is never approval.
- Do not link accounts by an untrusted email claim, adopt foreign/null-tenant accounts, map platform privileges, or let SCIM roles grant admin authority.
- Preserve org/training gates, owner authority, tenant boundaries, field queues, and existing default session lifetimes.
- One root writer; independent read-only protocol, code-path, product, and security reviews.
- Secrets encrypted with purpose/tenant binding; bearer tokens hashed; no token/PII logging; finite request sizes, transactions, retries, and provider timeouts.
- Provider network I/O stays outside SQLite transactions. Consume login state, assertion receipts, and recovery codes atomically. Revalidate authority after writer waits.
- No live identity-provider configuration, customer messages, production migration, secrets changes, or deployment during local implementation.
- PR #232 remains independently verifiable. Its required seven-day staging soak and subsequent 48-hour 10% canary cannot be simulated or skipped; the staging host remains unspecified.

## Milestones

1. Map all identity admission and persistence seams; record product decisions and current CI outcome.
2. Verify supported Node/native SQLite compatibility in an isolated foundation commit; run `bash scripts/agent-verify.sh full` and built-artifact smoke. Record unavailable Linux image validation explicitly.
3. Add restart-safe identity schema and common authority/session APIs, with tests for fresh/legacy databases, approval, lifecycle, tenant isolation, contention, session expiry and revocation.
4. Implement OIDC code/PKCE and SAML adapters with browser-bound one-use transactions, safe configuration, admin approval, and protocol-negative fixtures.
5. Implement SCIM Users/Groups and authenticated tenant-scoped administration, preserving separate app approval and least privileges.
6. Implement MFA enrollment/challenges/recovery, tenant policies and device/session administration; wire email and SSO through the same final admission checks.
7. Implement accessible tenant-admin and login/security flows; exercise pending approval, expiry, recovery and existing offline behavior.
8. Add API/operator documentation and deployment checks. Run focused regressions followed by full gate, independent review and draft PR. Document external-provider and rollout validation still required.

## Progress

- [x] 2026-09-08: Read specification, repository instructions, backend/database skills, and existing architecture.
- [x] 2026-09-08: User confirmed SQLite and tenant-admin approval.
- [x] 2026-09-08: Created isolated identity branch; dispatched read-only code, protocol and product reviews.
- [x] 2026-09-08: Reliability PR #232 CI run 34277430203 passed all checks on head 497cc3d; updated PR validation evidence. Staging/canary remain pending.
- [x] 2026-09-08: Installed checksum-verified Node 24.20.0 in an isolated temporary runtime, upgraded native SQLite/types and patched compatible qs/browserslist advisories. Native backup/WAL/worker/child-process smoke passed locally; CI image smoke added, Linux execution pending.
- [x] 2026-09-08: First runtime gate: 8,024 passed, 31 failed due to native-fetch/jsdom AbortSignal mismatch and SQLite query-plan wording. HTTP-only suites now use Node; physical-plan checks strengthened. All 51 targeted regressions passed. Second full run: 8,048 passed, seven timeouts in one existing mocked scanner transport suite; later traced to shared database backoff in the test harness and isolated without increasing timeouts or changing provider behavior.
- [x] Supported-runtime local foundation and native compatibility evidence. Linux image validation remains a CI/release requirement.
- [ ] Shared admission/session/schema implementation.
- [ ] SSO, directory lifecycle, MFA, admin/client integration.
- [ ] Full validation, review, API/runbook documentation and draft PR.

## Decisions

- Keep SQLite and existing opaque application sessions. Do not introduce PostgreSQL, Passport, a second session store, or per-request provider token introspection merely because the illustrative spec uses them.
- Identity-only OIDC requests `openid email profile`; provider API authorization and background token refresh require a concrete delegated-API use case. Never retain unnecessary provider tokens. Record any unmet literal refresh/introspection requirement explicitly.
- Existing applications approval provisions employment/pay/onboarding state; enterprise identity approval must be separate and account-only.
- User confirmed: require Homefront MFA (IdP claims do not substitute); block new logins at the concurrent-session limit; SCIM reactivation requires renewed tenant-admin approval.
- Default session durations remain unchanged. Shorter tenant policies must expose their field-work consequences and cannot silently erase unsent work as part of a global rollout.

## Discoveries

- `auth/status` bypasses `requireAuth`; central middleware alone cannot enforce new identity states.
- Lead and scanner SSE streams authenticate only at connection; revocation must also apply before frames and on heartbeat.
- Inspector snapshot/timeline/global health are not tenant-filtered; null-tenant legacy scan jobs use truthiness scope checks. These need concrete isolation fixes in the shared-authority milestone.
- Delayed recovery/assignment actions query sessions directly; they must use the same effective authority rules.
- Node-SAML validates cryptography but its current login path does not independently compare every issuer/destination/recipient property. The adapter must validate verified assertion fields and atomically consume browser-bound state.
- Existing cached client status treats timeout/5xx as inconclusive. Explicit access denial must remain distinguishable from transient network failure.

## Validation

Use disposable synthetic SQLite databases and local protocol fixtures only. Test successful flows plus state/nonce/issuer/audience/signature/recipient failures, replay, tenant/account linking, stale admin authority, directory reactivation without approval, MFA bypass, existing-session policy changes, token secrecy, and revoked streams. Preserve existing session-lifetime and offline recovery coverage.

Required final command: `bash scripts/agent-verify.sh full` (harness, deployment safety, index guard, both TypeScript checks, all tests, production build). Runtime changes additionally require native backup/restore/contention and production artifact import/start smoke. Real IdP interoperability, staging soak, canary timing and production capacity remain separately measured checks.

## Recovery

Keep additive schema changes compatible with current code; migrations are idempotent and transactional where possible. Never remove legacy session/user data to make tests pass. A failed local milestone can be corrected on this branch without affecting PR #232 or production. Retain exact source SHA and validation records for each checkpoint. Do not switch runtimes against a production database before backup/restore and image checks.

## Result

Implementation in progress. No identity feature or production deployment is claimed complete.

## Session authority checkpoint — 2026-09-08

- Committed supported runtime checkpoint `2fc26d0`. Diagnosed the seven scanner-transport timeouts: production-mode mocked tests inherited a real shared database fleet-backoff state from parallel suites. Isolated only that unrelated test dependency; provider assertions and timeout budgets remain unchanged. All 18 transport/governor regressions passed.
- Added fresh indexed session authority, absolute-lifetime read enforcement, renewal CAS and readonly auth status. Streams check session/account/org/training authority before payloads and release resources on server-side close. Delayed recovery retains its transaction-time check and now checks absolute lifetime.
- Review found and implementation addressed stale cross-worker roster/territory/open-field permissions (including nested config and map ETag/body caches), stale primary-owner SQL visibility, cross-tenant inspector diagnostics/global controls, per-address first-seen N+1 queries, unbounded diagnostic subscriptions and stream output queues. Persistent metadata triggers do not fire on scanner/lead event writes; transaction cache bypass avoids publishing rolled-back permissions.
- Added synthetic two-connection, migration/restart/restore, wire-level positive-control, rollback/cache, query-plan, resource-limit and RTL regression coverage. New-rep fixtures explicitly represent completed training; no production gate was loosened. SQLite 3.53 query-plan fixtures recognize its physical EXISTS join while retaining PK-probe requirements.
- Focused authority regression corrections passed (55 tests in three suites); component/source-invariant tests passed. Full gate running in `/tmp/homefront-identity-runtime/full-authority-foundation.log`. Final review still open. Do not mark final verification complete until that run and any required corrections pass.
- Confirmed business rules remain: SQLite first, tenant-admin approval for new identities and SCIM reactivation, Homefront MFA, block new login at the session limit. Protocol/policy/admin implementation is still subsequent work; these choices are not claimed as implemented by this checkpoint.

### Final local review

- Independent code, security, test and product reviews finished; concrete findings addressed. Scope publication now happens only after successful reads, and errors close the stream. The inspector live test removes the run filter so tenant isolation is tested directly; unreadable stream authority and case-insensitive UI diagnostics have explicit regressions.
- Full gate passed 8,112 tests across 660 files, both type checkers, index/harness/deployment guards and production build (`full-authority-verified.log`). Two prior failures were corrected without weakening policy: historical request-clock fixture now uses a valid lifetime; offboarding asserts readonly status and continued HTTP denial instead of status-triggered deletion.
- Final refinement reuses the joined organization status in the organization gate, removing its duplicate full-tenant read. All 28 targeted organization/recovery tests passed. Final full gate is running in `full-final.log`; no further source edits planned. Native smoke passed again: Node 24.20.0, driver 13.0.3, SQLite 3.53.4.

### Verified foundation result

Final source passed `bash scripts/agent-verify.sh full`: 8,113 tests in 660 files, tsc, tsgo, index guard, deployment safety, harness checks and production build (`/tmp/homefront-identity-runtime/full-final.log`). Native SQLite/backup/worker smoke passed. The obsolete organization-test description was then corrected and strengthened with an explicit zero-extra-lookups assertion, followed by its focused rerun. Independent review has no remaining blocker for this foundation. Linux production-image smoke and staging workload/restore evidence remain pending; local Docker is unavailable.

This checkpoint is ready for a dependent draft PR, not production promotion. It does not complete the enterprise identity milestone: next implement the separate approval/directory/policy schema and common admission transaction, then the SAML/OIDC adapters, SCIM and Homefront MFA. Preserve the five confirmed user decisions and the existing rollout gates.
