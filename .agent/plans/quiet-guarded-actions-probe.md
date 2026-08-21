# Quiet the guarded-actions probe in flag-off environments

## Outcome

Signed-in users in an environment with `GUARDED_ACTIONS_ENABLED` unset see zero
recurring `404` console errors from `GET /api/actions/pending-count` on
`#/today`, `#/leads`, and the admin dashboard. Flag-on environments keep the
exact current behavior: the probe runs, the Action Approvals nav entry appears
for `action.queue.read` holders, and the badge counts pending requests.

## Context

- `client/src/pages/Layout.tsx:369` polls `GET /api/actions/pending-count`
  every 60s for any non-gated user holding `action.queue.read` (team_lead,
  manager, admin, compliance_admin, auditor). A 200 is the proof the feature is
  live ("the probe") and doubles as the nav badge.
- `server/guardedActionRoutes.ts:52` (`requireFlag`) answers 404 on every
  `/api/actions/*` route when the flag is off — deliberately ("THE FLAG IS THE
  OUTER WALL", disabled ≡ never deployed). So in flag-off environments the
  probe 404s once per minute and the browser prints an unsuppressable
  "Failed to load resource: 404" console error each time.
- The session payload is the codebase's established carrier for "state the UI
  must know before it fetches": `isSuperAdmin` rides `currentUser` on
  `/api/auth/status` (server/routes.ts:7571) precisely so nav gating never
  depends on a separately-fetched resource.
- The calling module (nearest flag-gated analog) exposes `moduleEnabled` to
  capability holders via an authenticated status payload answering 200; its
  client renders from that rather than probing for 404s.
- `GET /api/me/w9` / `GET /api/me/bank` 404s are intentional not-on-file
  semantics: `server/payRoutes.ts:175,219` answer a descriptive 404; both
  client consumers (`MyDocuments.tsx:409`, `TaxAndPay.tsx` `getOrNull`) map
  non-OK to `null` with no retry loop. They fire only on /my-documents and
  /tax-and-pay, never on today/leads/dashboard. No change.

## Safety invariants

- The 404 outer wall on `/api/actions/*` stays byte-identical — no route in
  `server/guardedActionRoutes.ts` changes. `200 {pending: 0}` when off was
  rejected: it would contradict the documented "disabled ≡ never deployed"
  design in three places (route file header, storage.ts, GUARDED_ACTIONS.md).
- Disclosure equivalence: the new `guardedActionsEnabled` bit on the
  authenticated session payload reveals nothing a caller could not already
  learn — flag on is detectable today by any authenticated user (403 vs 404 on
  the routes), flag off reads as absent either way. Unauthenticated callers of
  `/api/auth/status` get `currentUser: null` and never see the bit.
- No tenant data, no new endpoint, no auth semantics change.

## Milestones

1. Server: `guardedActionsEnabled()` rides the session payload — both
   `/api/auth/status` `currentUser` and the `/api/auth/otp/verify` user object
   (the SPA runs on the login response until a reload; auth/status alone would
   leave a freshly-signed-in admin without the nav until refresh).
2. Client: `AuthUser` gains `guardedActionsEnabled?: boolean`; the Layout probe
   adds `user?.guardedActionsEnabled === true` to `enabled`. Nav filter still
   keys off `gateProbe.isSuccess` (unchanged in flag-on envs).
3. Docs: update the probe paragraph in `docs/GUARDED_ACTIONS.md`.
4. Regression tests:
   - `tests/integration/guarded-actions.test.ts`: `/api/auth/status` reports
     the bit false with the flag off, true with it on.
   - `tests/rtl/LayoutNavReachability.test.tsx`: with the bit absent/false the
     pending-count query never fires and the nav entry is absent; with it true
     the query fires and the entry renders.
5. Validate: `npm run check`, targeted vitest (dev server stopped,
   `DATA_DIR=$(mktemp -d)`), then browser pass on `homefront-fieldmap` (5077,
   flag off): no console 404s on `#/today`, `#/leads`, admin dashboard.

## Progress

- 2026-08-21: Plan written; investigation complete (probe mechanics, flag wall
  rationale, session-payload precedent, w9/bank verdict).
- 2026-08-21: Milestones 1-4 implemented. `npm run check` clean. Targeted
  vitest 63/63 (guarded-actions integration incl. 2 new payload tests;
  LayoutNavReachability incl. 3 new probe tests; action-approvals). Proved the
  new flag-off RTL test fails against the unfixed Layout (reverted the enabled
  line, 1 failed / 21 passed, restored).
- 2026-08-21: Browser verification done, both flag states (details under
  Validation). Full-level verification green end to end. Done; left
  uncommitted for review.

## Decisions

- Client-side gating over `200 {pending:0}`: preserves the documented outer
  wall; matches the codebase's session-payload precedent (`isSuperAdmin`) for
  exactly this "nav must not depend on a probe" problem.
- Bit rides `currentUser` (not a response sibling): flows through existing
  hydration, 401-confirm refresh, and the offline snapshot with zero changes
  to `auth.tsx` plumbing.
- Bit is unconditional for authenticated users (not capability-filtered):
  disclosure-equivalent to the status quo in both flag states; simpler.
- w9/bank endpoints untouched (intentional not-on-file 404s, quiet client).

## Discoveries

- Login response user object already omits `tenantId`/`isSuperAdmin`; the SPA
  never re-runs `checkStatus` after `login()`, so any payload-gated UI must
  also be fed by the login response (hence milestone 1 covers both).
- `homefront-gate` launch config (port 5074) exists with the flag ON, but its
  DATA_DIR points into another session's scratchpad; the flag-on browser check
  ran instead as the fieldmap command + GUARDED_ACTIONS_ENABLED=true on 5078.
- Worktree environment, not this change: this worktree had only a stub
  node_modules (just `typescript`), so imports resolved upward into the main
  checkout's node_modules — and Vite (`server.fs.strict: true`) KILLS the dev
  process (exit 1) the moment the page requests
  `@fontsource-variable/geist/files/*.woff2` from that out-of-allow-list path.
  Symptom: dev server "starts successfully" then dies ~15s later when a tab
  loads; the preview harness purges its logs on exit so it looks spontaneous.
  Fixed for this worktree with a full `npm ci` (fonts then resolve locally).
- The fieldmap config's relative `DATA_DIR=.dev-verify` does not exist in a
  worktree; symlinked to the main checkout's fixture and excluded via
  `.git/info/exclude` (the `.gitignore` pattern `.dev-verify/` matches only
  real directories, not symlinks).

## Validation

- `npm run check` — clean.
- `DATA_DIR=$(mktemp -d) npx vitest run tests/integration/guarded-actions.test.ts tests/rtl/LayoutNavReachability.test.tsx tests/rtl/action-approvals.test.tsx` — 63/63.
- Regression proof: with the Layout `enabled` gate reverted, the new flag-off
  RTL test fails (1 failed / 21 passed); restored and green.
- Browser, flag OFF (`homefront-fieldmap` fixture, port 5077): rep
  (rex.rep@, mobile 375x812) `#/today` + `#/leads`, then fresh OTP login as
  ada.admin@ (desktop) on the admin dashboard, `#/leads`, `#/today` — zero
  console 404s across the whole session; network log shows every /api call
  200/204 and NO request to /api/actions/*; Governance group renders its six
  other entries with no Action Approvals; persisted user snapshot carries
  `guardedActionsEnabled: false` from both auth/status and the login response.
- Browser, flag ON (same fixture, same command + GUARDED_ACTIONS_ENABLED=true
  on port 5078): fresh OTP login as ada.admin@ — login payload bit `true`,
  `GET /api/actions/pending-count → 200 OK` fired once on mount,
  `nav-action-approvals` renders, zero console errors.
- Full `$homefront-verify-change` at level `full`:
  `validate-agent-harness.py` ✓ (4 agents, 8 skills), `deployment-safety.sh` ✓
  (compose config validation skipped - docker unavailable locally),
  `npm run check` ✓, `npm run check:fast` ✓,
  `DATA_DIR=$(mktemp -d) npm test` ✓ (539 files, 6913 tests, 0 failures),
  `npm run build` ✓.

## Recovery

Every edit is additive and revertible file-by-file; no migration, no data
change. If the payload bit must come out, reverting the Layout `enabled` line
restores today's probe-only behavior without touching the server.

## Result

Flag-off environments never issue the pending-count request: the console stays
clean on rep and admin surfaces, verified live on the fieldmap fixture. The
404 outer wall on `/api/actions/*` is untouched. Flag-on behavior is pinned by
integration + RTL tests and verified live: bit true in both auth payloads,
probe fires once and answers 200, nav + badge render. `GET /api/me/w9` and
`GET /api/me/bank` were assessed and left alone: intentional not-on-file 404s
that both client consumers map to null with no retry; they fire only on
/my-documents and /tax-and-pay, never on today/leads/dashboard.

Accepted residual risks: a mid-session flag flip ON is noticed at the next
sign-in / app relaunch rather than within 60s (flips accompany a server
restart and were already reload-shaped); direct navigation to
`#/action-approvals` in a flag-off environment still 404s its page queries
(one-shot, deliberate URL) - unchanged, out of scope. Changes left
uncommitted on branch f-/jolly-neumann-c7c3ab for review.
