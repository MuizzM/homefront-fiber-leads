# Buyer score for the rep workflow

Design source: the "Homefront Buyer Score" canvas
(https://claude.ai/code/artifact/e9cb79e2-26ae-44db-bf8f-609bd3fb5033), drafted 2026-08-22
as SalesRabbit DataGrid AI parity. Branch `claude/buyer-score`, targeting `rep-knocking-workflow`.

## Outcome

Every open door carries a Buyer score, 1.0 to 10.0 with one decimal, that answers "will this
household buy when we knock". Tiers: Likely 8.0 and up, Possible 5.0 to 7.9, Unlikely under 5.
A rep sees it as the leading tile on My leads (with a "Best buyers first" sort), as a section
with the full breakdown on the property page, and on the Today hero and Up next rows. A manager
sees a Buyer score column in the Leads command center and can trigger a rescore. Nothing about
routing, assignment, commissions or calling changes in this slice.

## Context

- The existing 0-100 `lead_score` (`server/lead-scoring.ts`) answers "is fresh fiber here";
  Today's Opportunity ranker (`server/leadRanking.ts`, `shared/doorPriority.ts`) answers "how
  fresh". The Buyer score is a third, household-level number; both older scores stay and feed it.
- Inputs are columns the app already has on `leads`: `household_segment_type`,
  `billing_status`, `fiber_status`, `fresh_confirmed_at`, `competitor_name`, `competitor_tech`,
  `is_homeowner`, `years_at_address`, `do_not_knock`, `lead_status`, `last_outcome`, plus
  `knock_log` outcomes and sold neighbours within 150 m in the same tenant.
- Enrichment today (`GET /api/leads/:id/enrichment`) fills `owner_name` from a static Rockwell
  parcel file and `income_range` / `home_value` from ZIP-level Census medians; `is_homeowner`
  and `years_at_address` are never written. The home-value signal is therefore deferred until
  per-parcel data lands (NC OneMap parcels, phase 2).
- Wire: Today reads the packed map pins (`shared/mapPinsWire.ts`, version 8). Adding
  `buyerScore` bumps it to 9; server and client ship together (unpack hard-fails on skew).
- Copy rules: no dashes, arrows or decorative icons; tiers are gold (Likely), navy (Possible),
  muted (Unlikely) so nothing collides with the status pin palette.

## Safety invariants

- Tenant scope: the score job, the neighbour-sales lookup and the rescore endpoint read and
  write only the caller's tenant. A sale in tenant B never raises a score in tenant A.
- Reps see scores only on leads they can already see; no new visibility.
- Scoring never bumps `leads.updated_at` (that drives "Last activity" and staleness).
- The nightly job is bounded (batches of 200, yields between batches, at most 20,000 leads per
  tenant per run) so it can never stall the HTTP loop. Failures are logged and skipped.
- `do_not_knock` doors and closed doors (sold, not interested, already a customer, no
  soliciting) get no score and are never promoted by it.
- No raw income or home value on any rep surface; bands only, and only on the detail page later.
- Migration is additive ALTER TABLE ADD COLUMN in `runMigrations()` (idempotent, forward-only).

## Milestones

1. `shared/buyerScore.ts`: pure `scoreBuyer(input)` returning `{ score, tier, reasons }`, caps
   as named constants; `buyerTier`, labels. Test: `tests/unit/buyer-score.test.ts`.
2. Schema: `buyer_score REAL`, `buyer_score_reasons TEXT`, `buyer_scored_at TEXT` on `leads`
   (`shared/schema.ts` + `runMigrations()`), list projection + wire v9 + `MapPinRow`.
3. `server/buyerScoreJob.ts`: `rescoreTenant(tenantId, opts)`, `rescoreLead(leadId)`; nightly
   timer in `server/index.ts` behind `BUYER_SCORE_JOB` (default on, `off` disables); routes
   `POST /api/buyer-score/run` (manager, tenant-scoped) and `GET /api/buyer-score/status`.
   Knock route calls `rescoreLead` best-effort after logging. Test:
   `tests/integration/buyer-score.test.ts`.
4. Client: `client/src/components/BuyerScorePill.tsx`; Leads list (tile, column, sort
   `buyer_desc`), PropertyDetail section, Today hero block and row pill.
   Test: `tests/rtl/BuyerScorePill.test.tsx`.
5. Verify: `npm run check`, `npx vitest run tests/unit/buyer-score.test.ts
   tests/unit/map-pins-wire.test.ts tests/integration/buyer-score.test.ts tests/rtl/...`,
   then the full suite with `DATA_DIR=$(mktemp -d) npm test`; preview in the browser.
6. Draft PR into `rep-knocking-workflow` with validation evidence. No merge, no deploy.

Phase 2 (separate PRs): NC OneMap parcels ingestion (homeowner, tenure, value band), map layer
pins, manager Buyer score page (caps, threshold, histogram, calibration), routing discount.

## Progress

- 2026-08-22: worktree created from `rep-knocking-workflow` @ 825ee07; plan written.
- 2026-08-22: milestones 1 to 4 implemented. `shared/buyerScore.ts` (13 unit tests),
  schema + `runMigrations()` columns, list projection and `buyer_desc` sort (list and search
  paths), pin wire v9, `server/buyerScoreJob.ts` with nightly timer, `/api/buyer-score/*`,
  knock-path rescore (11 integration tests), `BuyerScorePill` / `BuyerScoreTile` /
  `BuyerScoreSection`, Leads row tile + table column + sort option, PropertyDetail section,
  Today hero block + row pills (6 RTL tests). Previewed on a seeded pristine DATA_DIR at
  430 and 1440 px: rep list, Today hero and rows, detail breakdown, manager table.
- 2026-08-22: full verification gate running (`scripts/agent-verify.sh full`).

## Decisions

- Score is stored, not computed per request: the list sort and the map wire need it in SQL.
- Routing (`shared/doorPriority.ts`) is untouched in this slice: blending a buyer score into
  the walking discount is a business rule the owner has to set (canvas proposes a threshold).
- The Opportunity bar on Today stays when a door has no buyer score; when it has one the
  Buyer score block shows instead (the canvas decision), so the hero never carries two rails.
- HIGH marker (lead_score 80+) is hidden on rows that carry a buyer score: the fresh-fiber
  signal is inside the number.
- Home-value signal deferred (see Context): a ZIP median would add the same constant to every
  door in a ZIP, which is noise dressed as a signal.

## Discoveries

- `runMigrations()` in `server/storage.ts` is the migration mechanism (idempotent ALTERs,
  duplicate-column errors swallowed); there is no SQL file runner for lead columns.
- `buildMapPins` copies any truthy row field onto the pin, so a new wire field is: SQL
  projection + `MapPinRow` + `MAP_PIN_WIRE_FIELDS` + version bump + wire test.
- A DB trigger (`fresh_fiber_requires_cross_verification`) refuses `fiber_status =
  'new_fiber'` without provenance, so fixtures and the model read the segment + billing
  columns for the fiber signal, not the status string.
- With every negative signal at its floor an open door bottoms out at 1.4, above
  BUYER_MIN: the scale has room for a fitted model without a contract change.
- Closed doors in lists must not wear the "not scored yet" tile; the row needs the stage
  to tell "removed" from "pending" (`isClosedForScoring`).
- The route order on Today is unchanged in this slice: with location off it still sorts by
  Opportunity then lead_score, so a 7.9 can sit above a 9.1. Phase 2 decides the blend.

## Validation

See Milestone 5. Expected: all listed suites green; `npm run check` clean.

## Recovery

The migration is additive; re-running the job only rewrites the three score columns. To
disable: `BUYER_SCORE_JOB=off` (no timer) and the endpoints still work on demand. Rolling
back the client without the server (or vice versa) breaks packed pins (wire v9): ship together.

## Result

Pending.
