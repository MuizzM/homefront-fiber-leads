# Portal all-tabs UI audit and refinement

## Outcome

Every tab reachable by the currently signed-in Sales Rep presents a coherent,
mobile-safe operational interface: the primary task and current state are
obvious, shared navigation and page grammar remain consistent, controls have
usable touch and focus states, long/empty/error/loading content is truthful,
and no tab introduces horizontal overflow or obscures content behind fixed
chrome. The result preserves Home Front's existing visual identity and changes
presentation only; scanner, tenant, authentication, lead, commission, and
persistence behavior remain unchanged.

## Context

- The React/Tailwind portal lives in `client/src/` and routes through
  `client/src/App.tsx` and `client/src/pages/Layout.tsx`.
- The current branch is `codex/portal-ui-professionalization` at `18d71c1`, one
  presentation-only commit ahead of `rep-knocking-workflow` (`99ab204`).
- The visual authority is `docs/DESIGN_SYSTEM.md`, the implementation tokens in
  `client/src/index.css`, and shared primitives in
  `client/src/components/ui/`.
- The live browser is authenticated as a Sales Rep. Runtime coverage is scoped
  to every tab visible and reachable for that role; manager/admin-only routes
  are source-reviewed only unless an authorized session becomes available.
- Impeccable polish, UI Skills baseline cleanup, and evidence-based interface
  review guide this refinement. Existing product behavior and copy remain the
  authority.

## Safety invariants

- Do not change server authorization, tenant boundaries, scanner/provider
  behavior, lead outcomes, commission calculations, authentication, or stored
  data.
- Do not fabricate data, provider relationships, earnings, or operational
  state to make an empty screen look complete.
- Preserve existing capability-gated navigation and route behavior.
- Keep semantic colors, 44px touch targets, 11px type floor, one page `h1`,
  safe-area clearance, and light/dark theme support.
- Do not deploy or mutate production infrastructure without a separate explicit
  authorization after verification.

## Milestones

1. Inventory the signed-in navigation and inspect each reachable route at a
   representative desktop viewport. Record only evidence-backed problems.
2. Repeat the route pass at a phone viewport, including overflow, fixed chrome,
   keyboard/focus, long content, and empty/error state behavior.
3. Fix shared root causes first (`Layout`, page scaffolds, list/stat/form
   primitives), then make the smallest route-specific corrections required.
4. Add regression coverage for every behavior change and run focused tests,
   `npm run check:fast`, `npm test`, and `npm run build`.
5. Perform one final bounded desktop/mobile browser pass, review the diff for
   unrelated churn, and report any role-gated surface that could not be
   runtime-verified.

## Progress

- [x] 2026-08-20: Read repository guidance, design-system authority, UI Skills
  baseline context, and Impeccable polish/craft requirements.
- [x] 2026-08-20: Confirmed clean worktree on
  `codex/portal-ui-professionalization` and identified the existing UI-only
  commit ahead of the production branch.
- [x] 2026-08-20: Inventoried all 15 Sales Rep tabs and captured the desktop
  baseline; every loaded route retained one visible page heading and avoided
  document-level horizontal overflow.
- [x] 2026-08-20: Completed the 390px phone-width pass and consolidated the
  verified issues into shared responsive-control fixes plus two truthful-state
  corrections.
- [x] 2026-08-20: Replaced four clipped phone rails with bounded responsive
  grids, corrected active-shift totals and empty history, and clarified the
  Messages subset empty state. Added focused regression coverage.
- [x] 2026-08-20: Completed TypeScript, focused tests, full tests, production
  build, diff hygiene, and Impeccable detection. Restored the live browser to
  its normal viewport on Field Hours.
- [ ] 2026-08-20: Publish the verified batch through a feature branch and PR,
  merge it into `rep-knocking-workflow`, wait for exact-SHA CI, deploy through
  the approval-gated production workflow, and verify the live release.

## Decisions

- Treat this as a refinement, not a redesign: preserve the calm navy/gold Home
  Front operational identity.
- Fix shared causes before leaf screens so every route benefits and drift does
  not return.
- Use the signed-in Sales Rep role as the runtime boundary. Do not claim live
  coverage for manager/admin routes without a valid authorized session.
- Avoid decorative animation, gradients, nested-card proliferation, and new
  one-off tokens; simplify before adding.

## Discoveries

- The repository already contains extensive design-system documentation and
  guard tests; this pass must extend that system rather than replace it.
- `codex/portal-ui-professionalization` already includes a presentation-only
  cleanup commit that has not been merged into `rep-knocking-workflow`.
- Four phone-width control groups hide actionable choices without a clear cue:
  the Today glance band, Metrics periods, Leaderboard date presets, and Academy
  section tabs. Converting these small bounded sets to mobile grids removes the
  clipping while preserving their desktop presentation and semantics.
- An active Field Hours session is excluded from the Today and This Week totals
  because the server does not set `durationMinutes` until clock-out. A session
  list containing only that active session also leaves the history card blank.
  The UI must include elapsed active time in the live summaries and explicitly
  describe the absence of completed sessions.
- Messages always pins the shared `The floor` room, so the empty copy “No
  conversations yet” contradicts the conversation visible immediately above.
  The empty state should name the actually empty direct-and-crew subset.
- The brief outgoing-page display during a first route transition is the
  documented `useDeferredValue` keepalive behavior in `App.tsx`, not a broken
  route. It remains unchanged in this refinement.

## Validation

- Route-by-route live browser inspection at desktop and phone widths.
- Keyboard/focus and fixed-navigation reachability on representative flows.
- Focused RTL/unit tests for changed shared primitives and pages.
- `npm run check:fast`
- `npm test`
- `npm run build`
- `git diff --check`
- Impeccable detector on changed UI targets if no project hook already runs it.

## Recovery

- Keep changes presentation-only and organized by shared-system versus
  route-specific milestones so individual fixes can be reverted independently.
- If a runtime page is blocked by role or missing data, record it as not
  verified rather than changing permissions or inventing fixtures in
  production.
- No database or production-state rollback is required because this task does
  not authorize backend or deployment mutations.

## Result

All 15 Sales Rep tabs were inspected live at 1440px and 390px. The focused
implementation removes the verified phone-width clipping from Today, Metrics,
Leaderboard, and Training; counts active Field Hours sessions in live Today and
Week summaries; prevents a blank history panel; and makes the Messages empty
copy consistent with the pinned floor room. Manager/admin-only routes remain
source-reviewed rather than runtime-claimed because the authenticated browser
session is a Sales Rep.

Validation passed before publication: 77 focused tests, `npm run check:fast`,
all 6,864 repository tests, `npm run build`, `git diff --check`, and the
Impeccable detector with zero findings in changed UI files. Publication and
production deployment were explicitly authorized afterward and are now in
progress through the repository's protected workflow.

PR #157 merged those UI changes into `rep-knocking-workflow` at
`d6eb2c43e88940837e5e0651bef4addd341a0df1`. The first production cutover
safely auto-rolled back: the new container's former health window expired at
about 4m37s, while the restored known-good release needed about 4m48s to become
healthy against the 18.8 GB production database. This is a deployment health
race rather than evidence of a UI regression. Production remains healthy on
`b448017e1e9f3d5a33acb97dedb459df0be68ccf`; publication is not complete until
the measured health-window fix passes CI and the protected deploy succeeds.
