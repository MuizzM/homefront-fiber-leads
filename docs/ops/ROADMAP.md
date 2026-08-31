# Operational intelligence roadmap

Sequenced by confidence in the underlying data (see DATA-AUDIT-2026-08-31.md)
and by how much manager/rep effort each removes. One vertical slice ships per
increment; nothing predictive ships before its entry criteria.

## Shipped in this phase

**Workstream 1 core - Operations Command Center** (`/ops`, dashboard.read.team):
eight deterministic queues with verbatim rules, dismiss-with-reason (audited,
auto-lapsing), bulk assignment through the existing engine with the 10-minute
undo (bulk-assign now returns the token it always captured), CSV export, and
the workload-by-rep distribution table. Adoption meters for free via
http.request on /api/ops/*; dismissals and actions land in activity_log.

## Next increments, in order

1. **Workstream 2 - workload balancing preview** (high confidence).
   The read half shipped (workload table). The write half: pick a source pool
   -> propose moves (rule: even out unworked counts, respect protected
   states: sold, follow_up with future date, hold mark, do_not_knock) ->
   preview each move with its reason -> apply via bulk-assign per target rep
   -> per-rep undo tokens. No new engine: a planning UI over existing seams.
   Entry criteria: none outstanding - buildable now.

2. **Workstream 3 - rep next-best-action** (high confidence).
   Today.tsx already ranks a route; extend with the deterministic ladder
   (appointment/callback due today > overdue follow-up > newly assigned
   unworked > high-priority stale > rest), each row carrying its plain-
   language reason, snooze via a rep-scoped variant of ops_dismissals.
   Requires: agreeing the ladder with the operator (it reorders a rep's day).

3. **Workstream 5 - data-quality center** (medium confidence).
   Wire the EXISTING findNearDuplicateLeads; NULL canonical_key count; NULL
   lat/lng count; outside-polygon territory check (JS ray-cast, computed
   async); import-failure surfacing. Blocked for its most valuable repair
   (assigned_territory_id) on OPEN_DECISIONS §3 - detection ships, repair
   waits for the rule.

4. **Workstream 4 - automation rules** (medium confidence, constrained set).
   Notify-only rules first (manager notice when assigned_unworked crosses N;
   rep reminder before a callback - callbackReminders.ts already exists as
   precedent). Cooldowns + dedupe via a sent-log table. NOTE: the dormant
   guarded-actions engine (GUARDED_ACTIONS_ENABLED=false) contains its own
   raw assignment executors - a SECOND writer parallel to applyAssignment.
   Before any rule may change assignments, either route its executors
   through applyAssignment or keep automation notify-only. Assignment-
   changing automation additionally requires the directive's separate
   approval mode.

5. **Workstream 6 - analytics foundation** (needs schema work).
   Time-from-assignment-to-first-activity and conversion-by-cohort need
   either per-lead first-activity materialization or bounded window queries;
   define metric contracts first (docs/ops/METRICS.md to be written with the
   operator). No ranking surfaces until the fairness caveats in the
   directive are addressed.

## Explicit deferrals (with what unlocks them)

- **Predictive scoring / ML prioritization**: blocked until outcome
  definitions are agreed, per-tenant history is sufficient, and a
  deterministic baseline (the ladder above) exists to beat. buyer_score
  stays the only model-shaped number, and it already names its reasons.
- **Automated reassignment**: blocked on the directive's approval-mode
  requirement + the guarded-actions parallel-writer fix above.
- **assigned_territory_id reconciliation**: blocked on the product rule
  (OPEN_DECISIONS §3). The command center reads conflicts; nothing repairs.
- **Trends on queue counts**: no historical snapshots exist; showing a trend
  would require a daily rollup table - add only when a queue's count proves
  operationally watched (adoption data will say).
- **tenants.max_reps enforcement**: config exists, unenforced - needs an
  owner decision on what hitting the cap should do.
