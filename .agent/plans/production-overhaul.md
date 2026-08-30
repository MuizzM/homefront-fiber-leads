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
- 2026-08-30: A1-A4 DONE + committed ("Make the lasso assign exactly what the
  panel shows"): shared lens module, resolver + preview endpoint, opId
  idempotency, undo CAS on (rep, assigned_at), partial-failure honesty,
  repId-0/inactive-rep guards, client panel preview-driven, Add-doors assignee
  row. 16 new integration tests + updated source-slice suites; 104 existing
  assignment tests green.
- 2026-08-30: A5 DONE + committed ("Territory assignment routes meet the
  bar"): set-based stampTerritoryDoors, ring validation + candidate caps on
  assign-area and :id/assign, archived guards on :id/assign + /share,
  one-transaction share/unassign/reclaim, adopted-area row-tenant writes,
  inactive-rep refusals. 8 new tests; all 135 territory tests green.
- 2026-08-30: A6/A7 + C-cluster DONE + committed ("Fix the verified client
  defect cluster"): AreaDetail capacity + dialog, AssignRepModal honesty,
  CommissionDialog keyed body, override-rate strict parser, org-local clock
  day, Dashboard/FollowUps day fixes, MapView race/notice/gesture fixes,
  foundation fixes (boundary, SW guard, auth clears, theme chrome).
  Full suite green (7,598).
- 2026-08-30: B in progress: leads_version trigger table (O(1) data version,
  new test file), stats memo split (15s cross-process floor), saas stats memo
  + org-local today + fresh-confirmed partial index, territory progress
  bounded to merged territory bboxes + json_each knock scoping, scan/deploy
  narrow id-list branch + bounded visit summary, map search debounce.
  Full suite running.

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

## Adversarial review dispositions (18-agent workflow, 3 lenses + verification)

15 raw findings; 12 confirmed real by independent adversarial verification
(3 refuted). Every confirmed finding: FIXED with a regression test where a
test can reach it. Deduplicated:

1. Preview paid up to 400k-row hydration before AREA_TOO_LARGE - FIXED:
   index-only count probe first (reuses the sampler's window-count seam).
2. Progress-context memo missed the territory set its bounded fetch depends
   on (new area read 0 doors for 10s) - FIXED: territoryVersionStamp in key.
3. Lasso chips lit states the map's status filter excluded - FIXED: chips
   render only the refinement domain.
4. Headline used assign semantics while Status/Mark act on client ids -
   FIXED: count follows the active action.
5. Panel flashed to the Area flow while the preview counted - FIXED: pending
   keeps Assign viable.
6. Server clip was team_lead-only; the client clips ANY non-admin/non-rep
   with a linked member row (managers included) - FIXED to mirror literally,
   pinned by a linked-manager test.
7. opId cache missed IN-FLIGHT duplicates (the exact retry it was built for)
   - FIXED: a same-op retry joins the running attempt's promise; a recycled
   opId with a different body hash is refused (OP_REUSED). Both tested,
   including a nine-chunk concurrent join.
8. Adopted-area transactions flipped the row but skipped NULL-tenant doors
   (caller-tenant filter) - FIXED: door writes follow the row's tenant;
   also closed the same latent no-op on /complete, /archive and next-pass.
9. scan/deploy id branch lost the duplicate-id dedupe - FIXED.

Directive extensions in the same batch: in-transaction cap enforcement
extended to scan/deploy, the raw territory create, and next-pass reassign
(all six grant paths now re-check under the write lock); auth-freshness
tests pin that deactivation/demotion/promotion land on the next request;
docs/OPEN_DECISIONS-2026-08-30.md holds the three deferred decisions
(audit retention, FTS5, assigned_territory_id) as concrete proposals.

## Result

All milestones complete. Final state: 10 commits on
claude/production-overhaul; agent-verify full green; browser-verified lasso
preview flow on the .dev-verify fixture (assign 34 -> undo -> byte-exact
restoration). Remaining risks live in docs/OPEN_DECISIONS-2026-08-30.md plus:
cross-process cap enforcement is serialized by BEGIN IMMEDIATE and verified
by reasoning + in-process tests, not by a true two-process integration test
(single-file SQLite makes that harness heavy); production load numbers for
the new preview endpoint under 20-manager concurrency remain to be observed
via the existing slow-statement log.
