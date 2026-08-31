# UI refinement release - 2026-08-31

Branch `claude/ui-refinement` (on top of `claude/production-overhaul`). All
changes are client/UI plus three additive server seams (client-error beacon,
diagnostics assignment-card honesty, a training-gate allowlist entry). No
schema changes, no migrations, no flag changes. Rollback is a redeploy of the
previous SHA; nothing here writes state a rollback would strand.

## Customer-facing update (post via Messages > "update" - feed only, no buzz)

> The app got a large round of polish. The big one for managers: after a bulk
> assignment on the map, a result bar now stays on screen with exactly what
> happened - how many doors moved, how many changed hands from other reps -
> and Undo now works for a full 10 minutes, not 30 seconds. Before you
> confirm, the panel also tells you how many doors would be taken from other
> reps. Across the app, screens that lost their connection now say so and
> offer a Retry instead of looking empty, error messages stay up long enough
> to read, and dozens of small controls got easier to hit on a phone.

## What is noticeably better

### For managers
- After a bulk assignment, a persistent result bar shows the outcome
  breakdown (assigned, skipped, changed hands) and holds the Undo for the
  full 10-minute server window. It survives other notifications.
- The assign panel says, before you confirm, how many doors will change
  hands from other reps - reassignment reads differently from first
  assignment.
- Saving a new area refuses an at-cap rep up front (with their load shown)
  instead of failing after the draw-name-color ritual.
- Team Metrics and the Leaderboard keep the previous period's numbers on
  screen (dimmed) while a new period loads - no more flashing to skeletons.
- Payroll week paging keeps last week's totals visible while the next loads;
  payroll exports fail loudly instead of silently doing nothing.
- The tenant console, billing, approvals audit, live presence, coaching
  board, and recovery overview all say "couldn't load - retry" instead of
  rendering their empty states during an outage.

### For reps and field users
- A rejected outcome log no longer removes the door from Today's route.
- The map search commits the best match on Enter/Go instead of requiring a
  thumb-lift tap.
- The login form no longer triggers iOS zoom; a stale "Invalid code" clears
  when a new code arrives.
- "Not now" on the mileage location ask now actually declines, quietly, and
  stays declined on that device.
- Sub-44px touch targets across the lead table, chat, incentives, tier
  editor, and calling screens now meet the one-handed floor.
- The tab bar keeps your section lit on detail pages, and the bottom-sheet
  confirms are real bottom sheets on phones.

### Reliability and error recovery
- Every crash screen's "Support code" is now transmitted to the server
  (bounded and rate-limited), so support can find the crash behind a code a
  rep reads out. Unhandled errors report the same way.
- A durable "Recent errors on this device" list lives on Profile - the
  errors behind dismissed toasts are recoverable.
- Scanner consoles tell the truth: a stopped scan says "stopped early", a
  dead live-stream reconnects and says the rows may be stale, an
  indeterminate progress bar no longer draws as 100%.

### Intentionally unchanged
- No assignment/authorization/commission BEHAVIOR changed. Every server
  protection from the production-overhaul branch (idempotent bulk assign,
  in-transaction caps, tenant walls, undo CAS) is untouched.
- Bulk Status still has no undo (the server holds undo state only for
  assignment; adding a status-restore seam is a product decision - see
  "Open items").
- The keep-alive re-show refetch still refreshes hidden tabs' stale queries
  alongside the visible one; the comment in KeepAliveStages.tsx documents
  why this is a deliberate freshness trade.

## Rollout classification
- **Safe immediately (everything in this release):** all changes are
  client-rendered honesty/ergonomics fixes or additive telemetry. No data
  writes changed shape; the one API addition (POST /api/client-errors) is
  new and unused by anything else.
- **Progressive rollout:** not required; no flag was added. If the result
  bar needs a kill switch later, the STATUS_MARKER_GLYPHS pattern
  (routes.ts) is the house convention to copy.
- **Needs an announcement:** the undo window change (30s toast -> 10min
  bar) and the reassignment "changes hands" line - covered by the
  customer-facing update above. No walkthrough is needed; the new surfaces
  carry their own copy.

## Monitoring after deploy
All of it reads from existing seams; nothing new to stand up.
- `client.error` structured events (NEW): route-level frontend errors with
  incidentId; alert if a single route exceeds ~20/hour or one incidentId
  shape repeats across users.
- `http.request` (existing): p50/p95/p99 + statuses per route via
  scripts/perf-report.mjs. Watch `/api/leads/assign-selection/preview`
  (expect <100ms p95 at today's volumes) and the 409-vs-500 split on
  `/api/leads/assign-selection` - 409s are expected user conflicts
  (OP_REUSED, caps), 500s are not.
- `/api/diagnostics` assignment card (FIXED): now counts BOTH assignment
  planes and flips critical on any `incomplete: true` partial write. It was
  hardcoded "ok" before - a critical here is real.
- `db.slow_statement` (existing): unchanged thresholds; the release adds no
  new query shapes.
- Undo health: activity log `lead.assign_selection.undo` rows carry
  restored/skipped; UNDO_EXPIRED/UNDO_NOT_OWNER are 4xx on the undo route in
  http.request.

## Support notes and escalation signals
- "The Undo button disappeared" - the bar hides Undo when the 10-minute
  window ends or after a successful undo; the bar says which. A failed undo
  says the token is spent (single redemption) - re-assigning is the recovery.
- "Assign is off / grayed" - the panel now states the reason under the
  tiles (state chips refined everything away vs an empty loop).
- "The map says filtered but I have no filters" - fixed this release; if
  seen again, capture the org size (was a big-org viewport-mode bug).
- "Support code ABC12345" - grep prod logs for
  `"event":"client.error"` + the code; the report carries route, message,
  and stack head.
- Escalate to engineering: any Diagnostics assignment-card CRITICAL
  (partial write), repeated `client.error` storms from one route, or 5xx on
  assign/undo routes.

## Rollback plan
Redeploy the previous green SHA (309eb6d lineage). No migrations, flags, or
data formats to unwind. The client-error endpoint disappearing is harmless
to old clients (the beacon swallows failures by design). Communicate via the
same "update" feed channel if a rollback removes the result bar mid-day.

## Open items (deliberate, need product decisions)
- Bulk Status undo (server seam does not exist; panel currently commits
  with no take-back).
- Single-lead assign modal is still a plain Select (search/typeahead at
  40+ reps is real debt; per-rep load now shows in the lasso and area
  flows but not here).
- KeepAliveStages hidden-tab refetch ride-along (documented trade).
- The docs/OPEN_DECISIONS-2026-08-30.md trio (audit retention, FTS5,
  assigned_territory_id) is unchanged by this release.

---

# Addendum - Operations command center (claude/ops-intelligence, 2026-08-31)

## What ships
A new Operations page (Manage group, team leads and up): eight queues that
each print the exact rule they run - assigned-but-not-worked, unassigned
priority leads, overdue follow-ups, gone-quiet, doors held by deactivated
reps, broken territory links (read-only), partial bulk writes, and a
workload-by-rep table. Managers select rows and assign them in bulk with the
same 10-minute undo the map has (the id-based assign path now returns its
undo token); rows can be dismissed for 30 days with a required, audited
reason; every list exports to CSV. Team leads see their own team's work;
pool and audit queues stay manager-level.

## For support
- "Why is this lead in the queue?" - the reason line under each row and the
  rule under the queue title are the complete answer; nothing is scored.
- "I dismissed something by mistake" - dismissals lapse on their own in 30
  days; POST /api/ops/undismiss restores immediately (a UI affordance for
  this lists under future increments; the audit trail names who dismissed
  what and why).
- "The counts look stale" - overview counts are cached for 30 seconds.

## Monitoring
- /api/ops/* rides http.request (adoption + latency; watch p95 on
  /api/ops/overview - eight COUNT queries behind a 30s memo).
- Dismissals and restores land in activity_log as ops.queue.dismissed /
  ops.queue.restored with the reason.
- Baselines to record in week one (per success-metrics directive):
  assigned_unworked count, followups_overdue count, and weekly dismiss +
  assign volumes from activity_log - improvement claims wait for a
  before/after on these.

## Rollback
Additive only (new table ops_dismissals, two partial indexes, new routes,
new page). Previous SHA redeploy fully disables it; the table is inert.

---

# Addendum 2 - Lasso intelligence (claude/lasso-intelligence, 2026-08-31)

## What changes for managers
- A second lasso is a choice, not an error: "Add a loop" grows the selection
  (the panel reports "N added · M already selected" - the overlap is deduped,
  never refused), "Carve out" removes an area ("N removed"), plain drawing
  still starts over and the panel says so.
- The Assign button now states the NET number that will change. Doors already
  assigned to the chosen rep are shown ("N already assigned - left
  unchanged") and are genuinely untouched: no timestamps rewritten, no
  history noise, not part of the undo. If everything selected is already
  theirs, the panel says "No changes needed" instead of offering a button
  that would do nothing.
- Every exclusion is named: reassignments from other reps, doors held by
  other teams, doors filtered out by the state chips.

## For support
- "It says no changes needed" - correct: every selected door already belongs
  to that rep. Pick a different rep or adjust the loops.
- "My second circle didn't error about overlap" - by design now; the delta
  line reports what was new vs already selected.
- Undo puts back only what actually moved; "already theirs" doors were never
  touched.

## Monitoring
- Same http.request meters on /api/leads/assign-selection[/preview].
- activity lead.assign_selection details now carry rings, alreadyTarget -
  the preview/apply mismatch and dedupe volumes the directive asks to watch.

## Rollback
No schema changes. The API is backward-compatible (single-polygon bodies
still work); previous-SHA redeploy restores the old panel.
