# Console UI shell: command palette, breadcrumb bar, Rulebook, nav integrity

## Outcome

From any screen, a manager or rep presses Cmd-K (Ctrl-K) or taps the sidebar search
field and gets a command palette listing every page their role can open plus the
five most common actions; Enter or a tap navigates, Escape closes. Desktop pages
carry a slim breadcrumb bar (group, page). A new Governance page, Rulebook, states
every computed rule in the app in one sentence with its thresholds, read from the
shared constants so it can never drift from code. A unit test fails the build if
a sidebar entry ever points at a path no route serves.

This is slice 1 of the "Homefront Console" design canvas
(https://claude.ai/code/artifact/1be75fe4-bc6f-414f-8d98-bc093bc6b2c9). The canvas
also proposes grammar adoption (PageHeader, StatStrip, ListGroup) across every
screen; that lands per screen in later slices.

## Context

- Shell: `client/src/pages/Layout.tsx` (NAV_ITEMS, sidebar, mobile header, More
  sheet). Routing: `client/src/App.tsx` (wouter, hash location). Capabilities:
  `shared/capabilities.ts`. Page grammar: `client/src/components/ui/page-scaffold.tsx`.
- Leads already uses a sessionStorage handoff (`client/src/lib/leadsFilterHandoff.ts`)
  because hash-query deep links 404 on reload.
- Rule constants: `shared/doorPriority.ts` (DISCOUNT_MAX_M, SCORE_SATURATION),
  `shared/buyerScore.ts` (BUYER_BASE, BUYER_CAPS, NEIGHBOR_*), `shared/commissionTiers.ts`
  (DEFAULT_RETRO_TIERS), `shared/commissionHold.ts`, `shared/commissionReserve.ts`,
  `shared/territoryHealth.ts` (DEFAULT_TERRITORY_THRESHOLDS), `shared/referral.ts`
  (DEFAULT_REFERRAL_CONFIG), `shared/orderRecovery.ts` (DEFAULT_RECOVERY_POLICY),
  `shared/geoVerify.ts` (DEFAULT_GEO_CONFIG, IMPOSSIBLE_SPEED_MPS), `shared/liveOps.ts`
  (FRESHNESS_*), `shared/kineticBuild2026.ts` (VERIFICATION_*), `shared/doorOpener.ts`
  (FRESH_AGE_MAX_DAYS), `shared/reminders.ts`, `shared/repMetrics.ts` (METRIC_DEFS),
  `client/src/lib/shiftDuration.ts`.
- Tests that pin the shell: `tests/rtl/LayoutNavReachability.test.tsx`,
  `tests/unit/page-header-consistency.test.ts`, `tests/unit/type-and-tap-floors.test.ts`.
- Another session works in the main checkout on `claude/field-map-parity`; this work
  lives in the worktree `.claude/worktrees/console-ui` on `claude/console-ui`, branched
  from `origin/rep-knocking-workflow` (d8c0cae).

## Safety invariants

- The palette lists only entries `NAV_ITEMS[].show(role, user)` already admits and the
  training gate allows; it never widens reach. Authorization stays on the server.
- No new network calls. No data search in the palette in this slice.
- The Rulebook reads shared constants only; it states no server-only number it cannot
  import (lead-scoring and ranking weights are cited by file, not restated).
- No global keydown handler swallows anything but Cmd/Ctrl-K; Escape is handled by the
  Dialog primitive.
- Full-bleed routes (`/map`, `/calling*`) keep their chrome: no breadcrumb bar there.

## Milestones

1. `cmdk` dependency + `client/src/components/ui/command.tsx` (shadcn Command).
   Verify: `npm run check:fast`.
2. `client/src/components/CommandPalette.tsx` + wiring in Layout (sidebar search
   trigger, Cmd-K, desktop breadcrumb bar). Verify: `npx vitest run tests/rtl/CommandPalette.test.tsx tests/rtl/LayoutNavReachability.test.tsx`.
3. `client/src/pages/Rulebook.tsx`, route `/rulebook` (admin, manager), nav entry under
   Governance. Verify: `npx vitest run tests/rtl/Rulebook.test.tsx tests/unit/page-header-consistency.test.ts`.
4. `tests/unit/nav-routes-resolve.test.ts`: every NAV_ITEMS href has a Route.
5. `bash scripts/agent-verify.sh full` (dependency change), then push the branch.

## Progress

- 2026-08-22 14:30 plan written; worktree created; `npm ci` done.
- 2026-08-22 14:50 milestones 1 to 4 implemented: `components/ui/command.tsx`,
  `components/CommandPalette.tsx`, Layout wiring (sidebar trigger, Cmd-K, breadcrumb bar,
  More-sheet row, Rulebook nav entry), `pages/Rulebook.tsx` + route, Leads add-intent,
  tests `tests/rtl/CommandPalette.test.tsx` (6), `tests/rtl/Rulebook.test.tsx` (6),
  `tests/unit/nav-routes-resolve.test.ts` (3). `npm run check:fast` clean.
- 2026-08-22 15:05 `bash scripts/agent-verify.sh full` green: harness validator, deployment
  guard, `tsc`, `tsgo`, 560 test files / 7,058 tests, production build (10.8 s).
- 2026-08-22 15:15 live check on the worktree dev server (config `console-ui`, port 5082,
  fixture DB): Cmd-K opens, "rule" + Enter lands on /rulebook, "team met" on /metrics/team,
  the More sheet's search row opens the palette as a bottom sheet on a 390 px phone.
  Found and fixed: cmdk's fuzzy scorer ranked Field Hours above Rulebook for "rule";
  replaced with a word-prefix ranker (`rankEntry`) and pinned it in the palette test.

## Decisions

- Palette on cmdk (the shadcn Command primitive) rather than a hand-rolled list: it
  carries the keyboard and filtering contract the app would otherwise re-derive.
- Layout passes the visible nav to the palette as a prop; the palette does not import
  Layout (no cycle) and can never show an entry the sidebar would not.
- "Add a lead" goes through a sessionStorage intent (`hfs.leads.intent`) read by Leads,
  mirroring the existing filter handoff; no hash query.
- Rulebook is a page, not a sheet, so it has a URL people can send each other.

## Discoveries

- cmdk needs `ResizeObserver` and `scrollIntoView`, neither of which jsdom provides; the
  palette test stubs both. Radix tabs activate on pointer down, not on a synthetic click.
- `origin/rep-knocking-workflow` already carries the buyer score (PR #166), so the Rulebook
  states it from `shared/buyerScore.ts` rather than citing a draft.

## Validation

- `bash scripts/agent-verify.sh full` (DATA_DIR pristine): exit 0, 7,058 tests passing, build ok.
- `npx vitest run tests/rtl/CommandPalette.test.tsx tests/rtl/Rulebook.test.tsx tests/unit/nav-routes-resolve.test.ts tests/rtl/LayoutNavReachability.test.tsx tests/unit/page-header-consistency.test.ts tests/unit/type-and-tap-floors.test.ts tests/unit/light-theme-token-coverage.test.ts`: all green.
- Manual: Playwright against the worktree dev server as ada.admin (desktop 1440 and phone 390).

## Recovery

- Everything is additive except Layout (new chrome) and Leads (intent read). Reverting the
  Layout hunk restores the previous shell; the palette and Rulebook files are inert
  without their imports.

## Result

- Shipped on `claude/console-ui`: Cmd-K / Ctrl-K command palette (every visible nav entry
  plus capability-gated actions, word-prefix ranking, hash-router navigation, Add-a-lead
  intent), sidebar search field, desktop breadcrumb bar, More-sheet search row, the
  Rulebook page under Governance (admin, manager) reading 17 rules from shared constants
  plus every METRIC_DEFS formula, and a nav-to-route integrity test.
- Remaining risks: the breadcrumb bar adds 44 px above every desktop page except map and
  calling; pages with their own sticky header (PropertyDetail) now show both. cmdk is a
  new client dependency (MIT, React-only).
- Follow-up slices from the canvas: per-screen grammar adoption (PageHeader, StatStrip with
  5 and 6 columns, ListGroup) on Dashboard, Team, Leads, Commissions; the three-branch
  data states program from docs/ui-audit-2026-08.md; data search (doors, reps) in the palette.
