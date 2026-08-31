# Operational intelligence phase - vertical slice: Operations Command Center

Branch: `claude/ops-intelligence` (cut from `claude/ui-refinement` @ a0b607b).
Directive: build workflow intelligence on verified data. Process mandated:
data audit -> plan -> ONE vertical slice (manager queue for "assigned but
not worked" with direct actions) -> validate -> expand. No fake scores, no
automated reassignment, no generic AI.

## Data audit result (docs/ops/DATA-AUDIT-2026-08-31.md holds the full map)

Trustworthy signals confirmed by the 6-area audit:
- "Last worked": leads.last_outcome_at (NULL = never; legacy backfilled) or
  MAX(knock_log.knocked_at) via idx_knock_log_lead_time_desc. updated_at is
  NOT a work signal. Phone work = last_call_at.
- "Assigned but unworked": assigned_at vs last_outcome_at, both on leads.
- Overdue follow-ups: knock_log.callback_date < today with
  latest-knock-per-(lead,rep) NOT EXISTS pattern (proven in
  repMetricsAggregator.countOverdueFollowUps); org-local day via
  orgTimezoneFor.
- Inactive-rep holdings: leads JOIN team_members WHERE active=0 (offboard
  never touches assigned_rep_id - "silently parked", routes.ts:6222 comment).
- Partial writes: activity_log action IN (lead.assign_selection,
  lead.bulk_assign, lead.assign_selection.undo) AND details LIKE
  '%"incomplete":true%'. Caveat: bulk_assign with updated=0 logs nothing.
- Territory-link conflicts (READ-ONLY per OPEN_DECISIONS §3): leads.
  assigned_territory_id -> missing or archived territory (SQL-only; the
  outside-polygon check is JS ray-cast - deferred to the data-quality
  workstream).
- Capacity: MAX_ACTIVE_AREAS_PER_REP=5 constant; no per-rep lead capacity
  config exists -> workload queue reports DISTRIBUTION (counts vs team
  median), never a fake "capacity %".
- Near-duplicate finder EXISTS unwired (server/leadDedupAudit.ts) - later
  workstream.
- Scoping: gate on dashboard.read.team (team_lead+; precedent /api/metrics/
  team) and resolve rows with leadVisibilityScope - the SAME scope the
  assignment actions enforce, so every row shown is actionable (preview/act
  parity at the permission level).
- Reuse for actions: bulk-assign (explicit leadIds; will now ALSO mint the
  undo token its applyAssignment already captures and discarded),
  RejectReasonDialog for dismiss-with-reason, rep_coaching_insights
  dismissed_at pattern for persistence.

## The slice

Server:
- ops_dismissals table (additive DDL, house pattern): tenant_id, queue_key,
  entity_kind ('lead'), entity_id, reason, dismissed_by_user_id,
  dismissed_at, expires_at; UNIQUE(tenant_id, queue_key, entity_kind,
  entity_id). Index for join.
- Two additive partial indexes: idx_leads_ops_assigned(tenant_id,
  assigned_at) WHERE assigned_rep_id IS NOT NULL; idx_knock_log_callback_due
  (tenant_id, callback_date) WHERE callback_date IS NOT NULL.
- GET /api/ops/overview?window=48&stale=14 -> [{key,label,rule,count}] per
  queue, capability dashboard.read.team, leadVisibilityScope, memo 30s.
- GET /api/ops/queue/:key (same params) -> {rule, total, rows(<=200)} with
  per-row reason facts.
- POST /api/ops/dismiss {queue, entityId, reason(required), days<=90} +
  POST /api/ops/undismiss; activity "ops.queue.dismissed"/"ops.queue.
  restored".
- bulk-assign response gains undoToken/undoExpiresAt (rememberAssignUndo on
  the already-captured prior; <=5000 rows, same store as assign-selection).
Queues v1 (each with its rule string rendered verbatim in the UI):
  1. assigned_unworked (THE slice) 2. unassigned_hot (priority mark, lead_
  score>=70, buyer_score>=8 - factors named per row) 3. followups_overdue
  4. stale_active (worked once, quiet >= stale days) 5. inactive_rep_
  holdings 6. territory_link_conflicts (read-only + export) 7. partial_
  writes (activity events, 7d) 8. workload (per-rep distribution table:
  active/unworked/overdue/areas/on-shift-now).
Client:
- /ops page (lazy, CapabilityGuard dashboard.read.team, NAV "Operations"
  group Manage, NOT keep-alive). Desktop: summary rail + queue table.
  Mobile: stacked cards. Row select -> bulk bar: Assign to rep (picker with
  live load counts from workload data), Dismiss with reason
  (RejectReasonDialog), open lead (/lead/:id), export CSV (client-side from
  loaded rows). Assign result inline with Undo (existing undo endpoint) +
  honest partial reporting. Window/stale settings persisted per device.
Instrumentation: http.request already meters /api/ops/* adoption + latency;
dismissals/actions land in activity_log; document baselines in the release
note. NO trends v1 (no historical snapshots exist - honest omission).

## Constraints
- Read paths never mutate; all mutations reuse existing gated endpoints.
- No assigned_territory_id reconciliation (OPEN_DECISIONS §3 stands).
- No automation, no predictive scoring (roadmap items with entry criteria).
- Tenant walls + capability + scope tests for every endpoint; large-dataset
  bounds (LIMIT + indexed predicates + count probes).

## Deliverables beyond the slice
docs/ops/DATA-AUDIT-2026-08-31.md (signal trust map), docs/ops/ROADMAP.md
(six workstreams prioritized w/ entry criteria + deferrals incl. guarded-
actions parallel-writer caveat), release/support note addendum.

## Progress
- 2026-08-31: audit complete (6 areas, 2 runs + manual gap-fill). Plan
  written. Building server slice.
