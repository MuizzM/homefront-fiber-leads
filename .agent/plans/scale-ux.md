# Scale UX: find a rep in one second at 300 reps

## Why

The app was built and verified against ~6-rep fixtures. A real tenant can run 300+
reps and 100k+ leads. An 8-way audit (4 agents delivered: MapView, Leads, Ops,
server; 3 areas re-covered by hand after API transport failures) found that the
data layer mostly scales (bounded map endpoints, one shared /api/team query) but
the SELECTION UI does not: eleven surfaces enumerate the whole roster inline.

Blockers (from the audit):
- Lasso Assign tab: LassoRepPicker renders every rep as a 52px radio row in a
  236px window - no search. 300 reps = 15,600px of blind scroll.
- Lasso Area tab: raw chip cloud (MapView.tsx:8857) - ~300 wrap chips push Save
  off-screen; whole-MapView re-render per Area-name keystroke reconciles them all.
- Legend "Assigned areas": ~1,500 territory rows at 300 reps x 5-area cap.

Degraded (same class): native <select> over the roster in panel-reassign-select,
StartNextPassDialog, door-card DetailsBody, Leads AssignRepModal + knock-rep
credit, Leads rep filter, Ops bulk-assign (order shuffles every 60s), MapFilterSheet
rep rows, legend rep list/select, Team.tsx reports-to, DownlineSheet.

The proven pattern already exists: components/territory/RepPicker.tsx (search past
8 reps, 60-row cap with honest "N more - keep typing" note, cap-aware ordering).
The two surfaces using it were the only ones graded FINE at 300.

## Invariants

- No backend behavior changes in this slice (roster payload at 300 reps is ~30KB
  and fine; the unbounded-endpoint inventory goes to the roadmap, not this diff).
- Existing testids stay stable where tests or muscle memory point at them
  (lasso-rep-N, rep-option-N, panel-reassign-select, assign-rep-select, ...).
- Small teams see no change: search appears past threshold 8, row cap at 60 -
  both invisible on a 6-rep fixture. Existing RTL contracts must pass unchanged.
- Recents are a per-device convenience (localStorage, try/catch, capped) - never
  the only path to a rep, never synced, never trusted as data.

## Plan

1. client/src/lib/rosterSearch.ts - ONE search semantic for people lists:
   matchPerson (word-start + substring fallback, extracted from RepPicker),
   capped-list helper, recents ordering. Unit tests.
2. client/src/hooks/use-recent-reps.ts - localStorage recents (scope key,
   cap 5, try/catch both directions).
3. RepPicker upgrades (additive): recentIds prop -> "Recent" group when the
   query is empty; keyboard roving (ArrowDown from search into the list);
   tone="glass" variant for dark-glass panels.
4. LassoRepPicker upgrades: search past 8, 60-row cap + honest note, recents
   group, roving over the FILTERED list. Row grammar untouched.
5. RepDialogSelect (components/people/): drop-in replacement for
   roster-wide <select>/<SelectItem> sites - trigger styled like the control it
   replaces, Dialog + RepPicker inside. Keeps the site's existing testid on the
   trigger.
6. Adopt: MapView Area chip wall -> RepPicker(multiple, glass);
   panel-reassign-select, StartNextPassDialog, DetailsBody card assign,
   Leads AssignRepModal/knock credit/rep filter, Ops bulk-assign (stable
   name order within availability + search), MapFilterSheet + legend search,
   Team.tsx reports-to, DownlineSheet.
7. Fixture: seed 300 reps into a copy of .dev-verify; browser-verify lasso
   assign, area save, door-card reassign, Leads assign, Ops assign.
8. Gate: agent-verify full. Report: scale-audit findings + what shipped vs
   roadmapped (unbounded endpoints, ops queue pagination, workload table).

## Status

- [x] Audit (workflow wf_544d6c90-c26 + hand-covered gaps)
- [x] rosterSearch + recents + tests (5 + 16 new tests)
- [x] Picker upgrades (RepPicker recents/keyboard/glass; LassoRepPicker search/cap/recents; RepDialogSelect new)
- [x] Call-site adoption (11 surfaces: lasso assign + area, panel-reassign, next-pass, door card,
      Leads assign modal + knock credit + rep filter, Ops bulk-assign, filter sheet, legend list+select,
      Team reports-to, DownlineSheet view-as)
- [x] 300-rep browser verification (seeded copy of .dev-verify, port 5078: lasso search/pick/preview,
      recents float, Area crew chips, Leads filter dialog, Ops dialog)
- [x] Gate + report (agent-verify full; roster-scale-report artifact)
