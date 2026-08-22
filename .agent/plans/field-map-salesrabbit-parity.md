# Field map: SalesRabbit-parity improvements

Branch: `claude/field-map-parity` (off `rep-knocking-workflow`). Design spec: the
"Homefront Field Map" design canvas (https://claude.ai/code/artifact/0730ffcc-6708-4b6c-a672-795d22aeafdd),
ten artboards drawn in the app's own design language.

## Outcome

A rep on the phone sees the doors nearest to them ordered by live distance, opens
one, marks it with one tap (undo for a few seconds), books a return visit from
quick slots, and sees every booking on a time-first Schedule page. Adding a door
by tapping the map snaps to the county address file. Verification verdicts from
past knocks are visible on the card's History with a "where they stood" view. A
manager lassos a block and assigns it from a real rep picker that shows each
rep's load, and can bring a spreadsheet of leads onto the map through a
column-matching import that never imports phone numbers.

## Context

- `client/src/pages/MapView.tsx` (9.5k lines): pins, selection, lasso, overlays.
  Three writers race over lead-layer visibility (see memory
  `map-layer-visibility-owners`); nothing here touches layer visibility.
- `client/src/components/LeadKnockSheet.tsx` + `lead-sheet/*`: the door card.
  Appointment composer at `appt-*` testids; notes; History in `DetailsBody.tsx`.
- `client/src/components/OutcomeSheet.tsx`: the themed twin (Today, Follow-ups,
  Leads, PropertyDetail).
- `client/src/pages/FollowUps.tsx`: list grouped Overdue/Today/Upcoming from
  `GET /api/followups`.
- `client/src/components/AddLeadSheet.tsx`: manual add, prefilled from a tap.
  `GET /api/address-points?bbox=` serves the county E911 points (R-tree).
- `shared/knock.ts`: outcomes, `pinDisplayState`, `haversineMeters`,
  `distanceHint`. `shared/geoVerify.ts`: knock verification.
- `server/routes.ts`: `/api/leads/map`, `/api/leads/assign-selection`,
  `/api/leads/create-from-selection`, `/api/followups`.
- Copy rules: ASCII hyphens only, no decorative icons in content (memory
  `no-em-dashes-no-emojis`). 44px tap floor, 11px type floor (tests enforce).

## Safety invariants

- Every new read/write stays tenant-scoped through the existing `storage`
  helpers; no raw cross-tenant SQL.
- Capability gates on the server for every new route (`lead.assign` for bulk
  assignment and import; the knock route's existing gate for undo).
- Phone numbers are never imported from a spreadsheet (calling compliance).
- Import work is bounded: row caps, chunked transactions, no unbounded
  geocoding loops; failures never partially corrupt (chunk transactions).
- No change to lead-layer visibility writers; no change to commissions.
- Nothing is deployed; the branch is pushed and a draft PR opened.

## Milestones

1. Schedule page: week strip + time-first agenda with distance, replacing the
   Follow-ups list body (same route, same data).
   Verify: `npx vitest run tests/unit/follow-ups*.test.ts tests/unit/schedule*.test.ts`.
2. Appointment quick slots (card + OutcomeSheet) via a shared pure helper
   `shared/appointmentSlots.ts`.
   Verify: `npx vitest run tests/unit/appointment-slots.test.ts`.
3. Undo after a status tap (toast action re-logs the previous outcome).
   Verify: `npx vitest run tests/unit/knock-undo*.test.ts`.
4. Nearest doors strip on the map (phone), proximity ordered, hidden while a
   card is open. Pure ranking helper in `shared/nearestDoors.ts`.
   Verify: `npx vitest run tests/unit/nearest-doors*.test.ts tests/unit/map-*.test.ts`.
5. Add lead: snap a tap to the nearest county address point; "not on the map
   yet" check against the pins cache.
6. History: "Where they stood" distance diagram on verified rows.
7. Lasso: docked panel on desktop, rep picker with per-rep door counts.
8. CSV lead import: `POST /api/leads/import/preview` + `POST /api/leads/import`
   (multipart, column mapping, dedupe by canonical key, rep assignment, phone
   column refused), page `client/src/pages/ImportLeads.tsx`.
9. `bash scripts/agent-verify.sh full`; push; draft PR.

## Progress

- 2026-08-22 03:20 Branch created, plan written, code mapping in flight.

## Decisions

- Build in value order (Schedule, slots, undo, strip, add-lead, history,
  lasso, import) so each push is usable on its own.
- Pin badges on map pins are deferred: they require the packed
  `/api/leads/map` format to carry a verdict and touch the racing lead layers.

## Discoveries

(updated as work proceeds)

## Validation

(per milestone, exact commands and results recorded below)

## Recovery

Each milestone is its own commit; revert the commit to back out one feature.
No migrations are planned; if the import needs an `import_batch` column it will
be a forward-only migration covered by the migration tests.

## Result

(pending)
