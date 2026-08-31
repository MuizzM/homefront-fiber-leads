# Operational data audit - what is trustworthy today

Produced by the six-area audit for the operational-intelligence phase
(2026-08-31). Every signal below is graded before any feature reads it.
File:line references are as of branch claude/ops-intelligence.

## Signals graded TRUSTWORTHY (used by the command center)

| Signal | Source | Notes |
| --- | --- | --- |
| Assignment moment | leads.assigned_at (+ assigned_by, unassigned_at) | Written by every assignment path |
| Last door work | leads.last_outcome_at / last_outcome | CAS-stamped by knocks and status writers; NULL = never worked (legacy backfilled). leads.updated_at is NOT a work signal - it moves on any edit |
| Phone work | leads.last_call_at / last_call_outcome | Written only by recordCallOutcome |
| Follow-up schedule | knock_log.callback_date/time on the LATEST knock | The metrics aggregator's proven pattern (repMetricsAggregator.ts:306); org-local day via orgTimezoneFor. Bulk/central "follow_up" rows have NO real schedule - their date is derived (storage.ts:4794) |
| Status | leads.lead_status | Canonical six-value vocabulary (shared/knock.ts:15) |
| Priority inputs | leads.assign_mark ('priority'/'hold'), lead_score 0-100, buyer_score 1-10 (buyerScoreJob only, NULL = unscored) | Real columns with documented writers - named per-row when used |
| Rep roster + hierarchy | team_members (active, reports_to_id), users.team_member_id | Offboarding sets active=0 and NEVER moves leads (routes.ts:6222 comment) |
| Area load | territories assignee_ids (authoritative; rep_id is legacy fallback) filtered active/shared | Cap is the constant MAX_ACTIVE_AREAS_PER_REP=5; no tenant/per-rep override exists |
| On shift | clock_sessions.clocked_out IS NULL | idx_clock_sessions_open |
| Partial bulk writes | activity_log details '"incomplete":true' on lead.assign_selection / lead.bulk_assign / .undo | Caveat: a first-chunk bulk_assign failure (updated=0) logs nothing - HTTP 500 only |
| Duplicate protection | leads(tenant_id, canonical_key) UNIQUE partial index | NULL-key rows escape it (count with canonical_key IS NULL) |

## Signals graded PARTIAL or GAP (not used, or used read-only)

- leads.assignment_source: written by territory-sync/import/guarded-executor,
  NEVER by direct or lasso assignment - stale on most rows. Do not read.
- assigned_territory_id integrity: archiving a territory leaves the link;
  no detection existed. The command center now reads missing/archived links
  (SQL-only); the outside-polygon check is JS ray-cast and deferred with the
  reconciliation decision (docs/OPEN_DECISIONS-2026-08-30.md §3).
- Undo/op-idempotency state: process memory, lost on restart, single-process.
  Failed/expired undo attempts are not persisted anywhere.
- OP_REUSED / OP_FAILED / REP_INACTIVE / OUT_OF_SCOPE refusals: HTTP-only.
  http.request structured events are the only meter.
- Offline knock queue deaths: client-side only (useKnockLogger); the server
  never sees a dropped knock. knock_log.superseded=1 marks CAS-lost history.
- Near-duplicates: server/leadDedupAudit.ts findNearDuplicateLeads EXISTS,
  tested, and is wired to no route - ready for the data-quality workstream.
- Lead import failures: per-row problems live only in the import HTTP
  response; aggregate in activity "lead.import". (Vendor-order imports, by
  contrast, persist full per-row failure tables - but those flags are dark.)
- lead_events.at is MIXED format (ISO vs space-separated) - compare with
  replace(at,'T',' ') or avoid; no tenant_id column on lead_events.
- tenants.max_reps exists but is enforced nowhere.
- Conversion/outcome history: knock_log supports time-from-assignment-to-
  first-activity per lead, but no aggregate exists yet (analytics workstream).

## Scope model (deliberate divergence - pick per surface)

Three resolvers disagree by design (liveOpsScope.ts:1-27 documents this):
leadVisibilityScope (manager=tenant, team_lead=direct reports) governs lead
surfaces AND assignment writes; commission readScope is capability-driven;
liveOpsScope is branch-based. The ops center uses leadVisibilityScope so
every row shown is a row the caller can act on.
