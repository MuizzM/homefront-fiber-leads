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
- 2026-08-22 07:25 M1 Schedule page (9a67c12). M2 quick slots + reminder job (047c90a).
- 2026-08-22 07:40 M3 in-card Undo (1761f8e). Pushed the branch.
- 2026-08-22 08:05 M4 Nearest doors strip (c948b5b). M5 county-first tap-to-add (fa50a14).
- 2026-08-22 08:30 M6 where-they-stood + dark signal tokens on the ink sheet (2a0bdef).
- 2026-08-22 09:00 M7 lasso rep picker, docked panel, assignment undo (f87ab1e).
- 2026-08-22 09:40 M8 spreadsheet import, routes + page + nav (2c88cd2). Pushed.
- 2026-08-22 09:45 Full verification running (`bash scripts/agent-verify.sh full`).

## Decisions

- Build in value order (Schedule, slots, undo, strip, add-lead, history,
  lasso, import) so each push is usable on its own.
- Pin badges on map pins are deferred: they require the packed
  `/api/leads/map` format to carry a verdict (wire version bump, server and
  client shipped together) and touch the racing lead layers.
- Undo after a mark is an in-card chip, not a toast: the owner deliberately
  made ordinary saves silent (`savedKnockReconciliation.ts`), so the chip
  lives on the status line for eight seconds and re-logs the previous
  disposition through the normal knock path (a wrong Sold reverses its money
  the normal way; history keeps both rows).
- Appointment reminders are always on for timed callbacks (no per-booking
  toggle): persisting a preference needs a knock_log column and a migration,
  and a reminder for a promise to a homeowner is the right default. Restart
  safety comes from the push `tag` collapsing a repeat on the device.
- Tap-to-add keeps its instant one-tap shape; the county address file is
  consulted server-side inside `/api/geocode/reverse` (45 m), so every caller
  benefits and Mapbox is paid only when the county file has nothing there.
- Lasso undo is a server-side in-memory token (10 min, 5,000 doors, one use,
  same user and tenant) rather than bridging into the guarded-action engine:
  that engine takes explicit lead ids behind a feature flag, while the lasso
  resolves a ring server-side.
- Import geocodes from the county file only. Rows it cannot match import
  without a pin (they show in Leads). A paid Mapbox backfill under the
  existing budget is follow-up work.

## Discoveries

- The dark glass door card read the LIGHT signal tokens under the light
  default (`text-success`, `bg-primary` on a near-black sheet): the At door
  chip measured about 3:1 and primary buttons 1.9:1 against the ink.
  `.glass-ink-scope` only re-asserted the neutrals. Fixed by carrying the
  dark signal set in the scope and opting the card in (test pins every value
  to `:root.dark`).
- `address_points.street` already holds the house number (`st_address`), so
  the reverse-geocode snap must not prepend `house_number` again.
- `getOpenCallbacks` without a tenant id is cross-tenant by construction; the
  reminder job iterates active tenants and reads per tenant instead.

## Validation

Per milestone (all green, `DATA_DIR=$(mktemp -d)` per the pristine-data rule):
- `npx vitest run tests/unit/schedule-calendar.test.ts tests/rtl/FollowUps.test.tsx` (17)
- `npx vitest run tests/unit/callback-reminders.test.ts tests/integration/callback-reminders-tick.test.ts tests/rtl/LeadKnockSheet.test.tsx tests/rtl/OutcomeSheet.test.tsx`
- `npx vitest run tests/unit/nearest-doors.test.ts tests/unit/map-nearest-doors.test.ts tests/rtl/NearestDoorsStrip.test.tsx tests/unit/map-*.test.ts`
- `npx vitest run tests/integration/reverse-geocode-county-first.test.ts tests/integration/address-point-authority.test.ts`
- `npx vitest run tests/unit/glass-ink-scope-signals.test.ts tests/unit/light-theme-token-coverage.test.ts tests/unit/design-tokens.test.ts`
- `npx vitest run tests/integration/assign-selection-undo.test.ts tests/integration/assign-selection.test.ts tests/rtl/LassoRepPicker.test.tsx tests/unit/lasso-*.test.ts`
- `npx vitest run tests/unit/lead-import-mapping.test.ts tests/integration/lead-import.test.ts tests/rtl/ImportLeads.test.tsx`
- `npx tsc --noEmit -p tsconfig.json` clean after every milestone.
- Full: `bash scripts/agent-verify.sh full` (result recorded in Result).

## Recovery

Each milestone is its own commit; revert the commit to back out one feature.
No migrations are planned; if the import needs an `import_batch` column it will
be a forward-only migration covered by the migration tests.

## Result

(pending)
