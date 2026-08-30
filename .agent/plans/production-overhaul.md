# Production overhaul: assignment integrity, scale hot paths, defect sweep

Branch: `claude/production-overhaul` (cut from `claude/academy-and-phone-taps` @ 309eb6d).
Baseline: `npm run check` clean; `DATA_DIR=$(mktemp -d) npm test` green (7,571 tests / 599 files, ~115s).

## Outcome

1. Bulk assignment (map lasso) is honest end to end: the count and scope a manager
   confirms is exactly the set the server assigns, under every filter lens, in both
   full-feed and sampled viewports, with a server-computed preview (total, by state,
   by current owner) before commit and a correct undo after it.
2. Territory assignment routes (`assign-area`, `:id/assign`, `/share`, `/unassign`,
   `/reclaim`) are set-based, single-transaction, bounded, and validated like their
   lead-assign siblings; SSE fires after commit.
3. The four verified O(total-leads) hot paths no longer walk the table per poll:
   trigger-maintained data version, TTL-decoupled stats memos, indexed counts/sorts.
4. Verified client defects fixed at root cause (CommissionDialog leak, UTC-today
   drift, FollowUps midnight, stale side-sheet, layer-race fourth writer, SW shell
   poisoning, missing top-level error boundary, scanner contrast/error states).
5. Regression tests for every behavior change; the pre-existing assignment test gaps
   (cross-tenant assign-selection, refusal codes, undo TTL/ABA) closed.

## Context

Full audit evidence: 8 mapper reports in the session scratchpad (`map-0.json` ..
`map-7.json`); the findings below reference exact file:line verified against code.
Key seams: `server/routes.ts` (assign-selection ~6296, applyAssignment ~6105,
territories ~8300-9200), `server/storage.ts` (set-based primitives 5142-5296,
getLeadsDataVersion 3756), `client/src/pages/MapView.tsx` (lasso 5158-5258, panel
7938-8435, bulkAssignMutation 1630), `client/src/components/map/LassoRepPicker.tsx`,
`client/src/pages/AreaDetail.tsx`, `client/src/pages/Team.tsx` (CommissionDialog
1173-1227), `client/src/index.css` + `docs/DESIGN_SYSTEM.md` (tokens).

## Safety invariants

- Tenant walls and capability gates on every touched route stay intact and gain
  tests where they had none (assign-selection cross-tenant).
- No schema rewrites: migrations are forward-only, additive (version table, partial
  indexes), restart-safe, covered by migration tests.
- No production actions: no deploy, no paid scans, no data rewrites. data.db is
  never opened by tests (pristine DATA_DIR convention).
- Business-rule changes I will NOT make without the user (flagged, not fixed):
  reconciling direct lead assignment vs `assigned_territory_id` (documented
  divergence, ambiguous intent); any commission calculation change.
- Copy rules: hyphens only, no emojis, icons only in nav; light default.

## Milestones

A. **Assignment integrity (flagship)**
   A1. Server: extract one ring-resolution seam; add POST
       `/api/leads/assign-selection/preview` returning `{total, byState, byOwner,
       sampledClientCount?}`; extend lens fidelity (map `fcc_fresh`, `fcc_fiber`,
       `field_verified` views; add `repFilter` param honored at resolution; client
       always sends the states the panel shows).
   A2. Client: panel preview is server-resolved (debounced, cancelled, loading and
       error states); Assign no longer gated on sampled client pins; honest counts
       on the button and the "will have N doors" projection; sampled-loop lockout
       gone.
   A3. "Add doors" never silently inherits the Assign tab's rep: explicit
       assignee row on the Create tab, default pool.
   A4. Undo integrity: stamp `assignedAt` into undo entries + CAS on it; report
       partial-restore counts; exclude rows already owned by the target from the
       undo snapshot and updated count (fixes idempotent-retry poisoned undo).
   A5. Territory routes: set-based single-transaction rewrites of `assign-area` and
       `:id/assign` with scope predicates inlined, ring validation shared with
       assign-selection, SSE post-commit; archived-area guard on `:id/assign` and
       `/share`; wrap `/share`, `/unassign`, `/reclaim` pairs in one transaction;
       positive-int repId guard; refuse inactive target reps; `unassigned_at` stamp
       on single unassign; `/unassign` reaches adopted areas like its siblings.
   A6. AreaDetail: capacity data into RepPicker; shared-area reassign shows crew
       impact; dialog gets Escape/focus handling.
   A7. Leads AssignRepModal: disable Assign until selection differs; honest toast.
   A8. Tests: cross-tenant assign-selection; RING_TOO_COMPLEX / AREA_TOO_LARGE /
       SELECTION_TOO_LARGE; preview contract; undo TTL + ABA; RTL for panel and
       AreaDetail capacity.
   Verify: `bash scripts/agent-verify.sh full` (assignment is cross-cutting).

B. **Server scale hot paths**
   B1. Trigger-maintained `leads_data_version` (migration + storage read O(1)).
   B2. `/api/stats` TTL-decoupled memo; `/api/stats/saas` memo + partial index for
       the newFiber count (migration).
   B3. Territory progress: SQL-side aggregation or bounded projection.
   B4. Partial index for buyer sort (migration). B5. hoist stats statements.
   B6. Map search debounce (client). B7. `/api/scan/deploy` narrow id-list query.
   Verify: focused vitest on stats/progress/migration tests + EXPLAIN spot checks.

C. **Client defect sweep**
   CommissionDialog reset+gate; Dashboard local-today; FollowUps midnight snap;
   IntelligencePanel staleness; override-rate validation shared + blocked state;
   Dashboard activity error state; sweep-cancel onError; top-level ErrorBoundary;
   SW navigate-cache guard; auth rejected-session clear; inflight-share bust on
   identity change; use-mobile initial value; ErrorBoundary CTA to `#/`;
   theme-color sync; CallingQueue poll gate; MapView: rep-colour tier sync,
   AreaAssigneeBar label, Escape covers add-mode, search-vs-sheet arbitration,
   ScannedDoorCard gating, failed-window-fetch chip, doorTagCounts identity.
   Verify: focused vitest + RTL.

D. **Design-system debt (audit step items still open)**
   Scanner verdict contrast; CallingLead armed sale label; success/warning
   foreground tokens + 6 sites; AlertDialogAction variant; scanner error states;
   MyCommission $150 fallback + rank tints; LiveMap dot honesty; Incentives meter;
   Dashboard quick-action label; verification.tsx hexes; status-vocabulary
   unification; Leads local color-map dedupe.
   Verify: token/contrast enforcement tests + focused RTL.

E. **Final**: full `bash scripts/agent-verify.sh full`, build, browser verification
   of the lasso flow (launch config `homefront-fieldmap`, producers off), read-only
   review workflow over the final diff, summary.

## Progress

- 2026-08-30: Audit complete (8 mappers, findings verified with file:line).
  Baseline green. Plan written. Starting A1.

## Decisions

- Preview endpoint over client-side parity: the server is the only honest resolver
  of a ring under lenses + sampling; one resolution seam serves preview and apply,
  so they cannot drift (the current bug class).
- Assignment stays capability-gated exactly as today; no authz model changes.
- FTS5 lead search deferred (bigger change; noted as follow-up).

## Discoveries

- Two mappers disagree whether Leads' KnockLogger is reachable; arbitrate in code
  before touching it.

## Validation

Baseline documented above. Each milestone lists its verify level; every behavior
change ships with a test that fails without the fix.

## Recovery

All work is on `claude/production-overhaul`; commits are per-milestone with
explicit paths staged (shared worktree - never `git add <dir>`). Migrations are
additive; reverting a commit reverts its behavior. No production state touched.

## Result

(pending)
