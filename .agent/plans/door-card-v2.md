# Door card v2: the all-circle field map lead card

Branch `claude/field-map-parity` (draft PR #165). Spec: the Claude Design canvas
"Door Card v2" (https://claude.ai/code/artifact/131d22f8-16ca-4687-9288-2f6c6a145c89),
drawn 2026-08-22 after the owner reported the card's X and copy buttons dead
and asked for "the cleanest UI, works on every screen, all buttons work", then
"remove all the rectangles, keep only circles" for the dispositions.

## Outcome

- On the field map (phone bottom sheet, tablet sheet beside the sidebar, and
  the desktop docked panel) the lead card reads as one vocabulary: a status
  pin chip in the header, Copy and Close as 36px glass discs with 44px hit
  areas, an action row of Directions / Call (only with a number) / distance,
  and ONE disposition surface: every field disposition as the same 44px disc
  in a fixed 6 x 2 grid. No rectangular outcome cells, no scrolling strip.
- Every control on the card responds to mouse, trackpad and touch at every
  width (the pointer-capture defect is fixed and regression-tested).
- Copy gives feedback in place: the disc turns success green with a check and
  the locality line reads "Address copied" for 1.2 s; it also works on plain
  http (LAN dev) through the execCommand fallback.
- After a mark the card offers the next step in the peek lip: "Set a time" for
  Interested / Follow-up / Go Back, otherwise "Next door" (nearest open door
  from the rep's fix, same rule as the Nearest doors strip).
- Competitor and occupancy facts the scanner already holds show under the
  status line before the rep knocks, not only in Details.
- The Today/PropertyDetail OutcomeSheet and the manager quick-log in Leads use
  the same disc grid, so the vocabulary is app-wide.

## Context

- `client/src/components/LeadKnockSheet.tsx`: the shell (drag/snap, header,
  composers, undo, proximity, details wiring). Snap levels peek / quick /
  details; docked at `(min-width: 1024px)`.
- `client/src/components/lead-sheet/`: `QuickBody` (action row + disposition
  surface + follow-through), `OutcomeButton` (`OutcomeDisc`, `ICON_MAP`,
  `outcomeFillTextColor`), `PeekBar`, `DetailsBody`, `ContactSection`,
  `QuickLinks`, `SheetPhotos`, `QuickSlots`, `utils`.
- `shared/knock.ts`: `FIELD_OUTCOMES` is the 12-disposition fixed order the
  grid renders verbatim (callback / needs_verification are history-only).
- `shared/nearestDoors.ts` + `client/src/pages/MapView.tsx`: `rankNearestDoors`,
  `repFix`, `recentIdsRef`, `flyToLead` feed the Nearest doors strip; the
  card's Next door row reuses them.
- `client/src/components/OutcomeSheet.tsx`, `client/src/pages/Leads.tsx`: the
  two other disposition surfaces (themed `surface="card"`).
- Tests: `tests/rtl/LeadKnockSheet.test.tsx` (contracts: `knock-status-grid`
  holds every `knock-outcome-*` in `FIELD_OUTCOMES` order, marks collapse to
  peek, appointment composer, notes, proximity, details),
  `tests/rtl/OutcomeSheet.test.tsx`, `tests/rtl/A11yQuickWins.test.tsx`.
- Copy rule (owner): no dash glyphs or decorative icons in copy; icons only as
  functional glyphs (status pins, close, check, icon-only controls).

## Safety invariants

- No server, schema, tenant, commission or knock-semantics change: every mark
  still goes through `onKnock` / `handleStatusTap`; the appointment still logs
  one follow_up / go_back knock with the date attached.
- The Next door row only reads data MapView already holds (rep fix, pins);
  it never transmits location. A loose fix (> 200 m) ranks nothing.
- Phone numbers stay gated exactly as before (`validPhone` + opt-in `phone`).
- No deploy; push the branch only.

## Milestones

1. Disposition grid component (`DispositionGrid` in `OutcomeButton.tsx`),
   map card restyle (header chip + discs, action row, follow-through pair,
   peek bar, details insets), copy fallback.
   `DATA_DIR=$(mktemp -d) npx vitest run tests/rtl/LeadKnockSheet.test.tsx tests/rtl/A11yQuickWins.test.tsx`
2. Next door + Set a time follow-through, facts row; MapView wiring.
   Same tests plus `tests/unit/nearest-doors.test.ts`.
3. OutcomeSheet + Leads quick-log on the disc grid.
   `npx vitest run tests/rtl/OutcomeSheet.test.tsx tests/rtl/Leads*.test.tsx`
4. `DATA_DIR=$(mktemp -d) bash scripts/agent-verify.sh focused <all of the above>`;
   live Playwright pass on `homefront-fieldmap` at 375, 820 and 1280 px:
   every card control clicked with mouse AND touch.

## Progress

- [x] 2026-08-22 pointer-capture fix + regression tests (earlier this session).
- [x] 2026-08-22 M1 restyle: `DispositionGrid` (6 x 2 discs), `StatusPinChip`,
      copy/close discs + "Address copied" feedback + execCommand fallback,
      44px action row, follow-through pair, inset Details (facts, contact,
      text-only quick links).
- [x] 2026-08-22 M2: post-mark row (`knock-post-mark` kind `time` / `next`),
      `nextDoor` + `onOpenLead` props wired from MapView (`cardNextDoor`,
      `openLeadFromCard`), facts chips (`knock-facts`).
- [x] 2026-08-22 M3: OutcomeSheet (`outcome-grid`, `outcome-*` ids) and the
      Leads quick-log on the same grid; `OutcomeButton` cell deleted.
- [x] 2026-08-22 M4: live pass green on four viewport/input combinations
      (below); full verification run recorded under Validation.
- [x] 2026-08-22 M5 (owner: "make it the best fluid smooth UI"): four-lens
      motion analysis judged into a ten-item plan, implemented (cd31d89):
      base-layer cascade fix, disc/pill press physics, velocity-matched
      snaps, live-transform grabs, accelerating exits, the sequenced mark
      moment. Motion contracts tested in RTL + a CSS unit test.
- [x] 2026-08-22 M6: adversarial review of the branch diff (5 lenses, 30
      findings, 2 skeptics each); confirmed findings fixed (19b319e):
      phantom mouse drag after an off-region release, touch-drag click
      swallow, inert peek bar + focus parking, honest copy feedback + live
      region, DNK exclusion, fresh fix while the card is open, timer cleanup.
- [x] 2026-08-22 merged origin/rep-knocking-workflow (PRs #168, #169) into
      the branch; the base had fixed the buyer-score race test identically.

## Decisions

- Marks still collapse the sheet to peek (existing contract + tests); the
  adaptive follow-through therefore lives IN the peek lip as one row, not as
  an auto-opened composer that would fight the collapse.
- 6 x 2 disc grid (12 field dispositions), not 7 x 2: callback and
  needs_verification are never offered for new marks (`FIELD_OUTCOMES`).
- One copy control (header). The action-row copy circle is removed.
- `OutcomeButton` (the rectangular cell) is deleted; `OutcomeDisc` gains a
  `testIdPrefix` so OutcomeSheet keeps its `outcome-*` ids.

## Discoveries

- Tailwind's opacity scale stops at multiples of 5: `text-white/88` and
  `text-white/72` generate NO class, so the text inherits the page colour
  (navy ink on the dark sheet) and the pair buttons rendered dim. Use a scale
  step or the bracket form.
- In docked mode the peek bar is laid out at `h-0 overflow-hidden`, so a slot
  rendered into it duplicates (and is reachable by keyboard) while the same
  row renders under the grid: the peek bar gets the post-mark row only when
  not docked.
- `navigator.clipboard` is undefined on plain http (the LAN dev box), which
  is why "copy does nothing" also reproduces without the pointer bug; the
  execCommand fallback covers it.
- Tailwind v3 flattens `@layer`, so `button:not(:disabled):active {
  transform: translateY(0.5px) }` in the base layer (0,2,1) beat every
  `active:scale-*` utility (0,2,0): no button in the app ever rendered its
  press scale. `translate:` composes; `transform:` shadows.
- Deferring pointer capture to the first real move re-opened a mouse hole:
  a press released OFF the region never reaches endDrag, and a later hover
  move (buttons 0) would start a drag. Guard on `e.buttons === 0`,
  pointerleave and lostpointercapture; primary button only.
- A touch drag produces no click, so a "swallow the drag's click" flag must
  be disarmed on a timer, or the next tap on any region button is eaten.
- The repo's `pin-glyphs-and-contrast` test enforces "onDark only when the
  pin colour is under 4.5:1 on the card": INT (4.54) and NI (5.1) may not
  carry overrides even though a bright tile under the 0.86 sheet lowers them.
- Playwright's `locator.click()` fails actionability on the sheet
  ("intercepts pointer events" flaps between the dialog and its button);
  drive the card with `page.mouse.click` / `page.touchscreen.tap` at the
  bounding-box centre after `scrollIntoViewIfNeeded`.

## Validation

- `DATA_DIR=$(mktemp -d) npx vitest run tests/rtl` after M3: 92 files, 1,091
  tests passed (LeadKnockSheet 98 incl. 11 new v2 tests and the 3 capture
  tests; OutcomeSheet 9; A11yQuickWins 3).
- `npx tsc --noEmit -p tsconfig.json` clean after every milestone.
- Live, `homefront-fieldmap` (port 5077, `.dev-verify`, producers off),
  repo Playwright with mocked GPS at 35.60005,-80.5976 as `rex.rep@`, the
  clipboard stubbed: phone 375x812 touch, phone 375x812 mouse, tablet
  820x1180 touch, desktop 1280x800 mouse (docked). On every run: quick level
  opens with the pin chip (glyph inside), 12 discs, no strip, no action-row
  copy, Directions href on google.com/maps/dir; header copy writes
  "106 Verify St, Lexington, NC 27292", shows "Address copied" and reverts;
  "At door" chip renders and re-taps; X closes; Not Home on a fresh door
  -> POST /api/leads/:id/knock 201 -> peek with "Next door 157 Verify St ·
  At door" -> Open swaps the card (address changes, snap quick); Interested
  -> "Set a time" -> composer at quick (docked stays docked) -> slot 1 fills
  2026-08-23, button reads "Set for tomorrow 10 AM" -> save -> 201 -> peek;
  Add note -> type -> Add -> "Saved to history" + latest-note quote; the
  pair row returns after blur; details: Add contact -> editor -> Cancel
  closes it, 4 quick links, history rows with "Where they stood" opening the
  diagram; phone/tablet: handle cycles to details and peek, peek X closes.
  Zero console or page errors on all four runs. Desktop confirmed the
  post-mark row renders once (no hidden duplicate).
- Full, pre-rebase tree (claude/field-map-parity + the two commits):
  `DATA_DIR=$(mktemp -d) bash scripts/agent-verify.sh full` -> harness valid,
  typecheck clean, 554 files / 7,024 tests passed, build green, exit 0.
- Full, merged tip eb28946 (base 7d045cb = #169): harness valid, typecheck
  clean, build green, **562 files / 7,101 tests passed**, no unhandled errors.
- Live on the merged build (port 5082 from this worktree): the four-way
  control pass again all green (tablet re-run after one mid-transition tap
  miss by the script), plus motion probes: disc press `matrix(0.9,...)` under
  a held mouse, snaps writing 280ms (mark collapse) / 196ms (handle tap),
  `160ms cubic-bezier(0.4,0,1,1)` on a programmatic close, `status-pop` on
  the peek chip, `post-mark-in 0.28s` on the next-step row, and every
  duration collapsing to 1e-05s under `prefers-reduced-motion`.
- Full, this branch (rebased onto d8c0cae, the merge of #166): 557 files,
  7,055 / 7,056 passed. The one failure,
  `tests/integration/buyer-score.test.ts > refuses to race itself on the
  same tenant`, fails identically (3/3) on untouched rep-knocking-workflow in
  a local run and passes in CI for d8c0cae; this diff has no server/ or
  shared/ changes, so it is a pre-existing local date/fixture dependency of
  the buyer-score job test, not a regression.

## Recovery

One commit per milestone; revert a commit to back out one slice. No data or
migration involved. The canvas stays the spec if code is reverted.

## Result

Branch `claude/door-card-v2` (cut from rep-knocking-workflow after PRs #165
and #166 merged), two commits, PR #167
(https://github.com/MuizzM/homefront-fiber-leads/pull/167) against
rep-knocking-workflow. Not merged, not deployed.

Shipped: the pointer-capture fix; the all-circle 6 x 2 disposition grid on
all three surfaces; the header pin chip and copy/close discs with in-place
copy feedback and the plain-http fallback; the 44px action row; the
appointment/note pair and latest-note quote; inset Details; the post-mark
Set a time / Next door row; competitor and occupancy facts before the knock.

Remaining risks: `cardNextDoor` reads `recentIdsRef` inside a memo keyed on
the fix and the pin set, so a door marked while the pins array identity does
not change is excluded only because the selected id is excluded explicitly
(fine today; revisit if the card ever stays on a door after a swap). The
hidden peek bar's own Directions / Close remain in the DOM at other levels
(pre-existing). The buyer-score race test needs a date-independent setup.

Follow-ups from the owner's list, not built: dictation and one-tap note
chips, offline strip on the card, buyer-score tier chip in the header,
today's route on the map, desktop keyboard layer.
