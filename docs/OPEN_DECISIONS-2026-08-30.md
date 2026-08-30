# Open decisions from the 2026-08-30 production overhaul

Three items surfaced by the overhaul audit that need a product rule or
infrastructure work before code should change. Each has a concrete proposal;
none has been implemented. Do not treat any of these as "future work" filler -
they are the specific risks the branch deliberately did not touch.

## 1. Audit-log retention at million-row scale

**The exposure.** `lead_events`, `activity_log`, `territory_events`,
`territory_assignments` and `admin_audit` are append-only and unbounded. Every
bulk assignment writes one `lead_events` row per moved door (deliberately -
audit integrity is the point), so a tenant lassoing 50k doors weekly writes
~2.6M rows/year into a table read per-lead through `idx_lead_events_lead`.
Reads stay fast (indexed by lead), but the table inflates the database file,
backup time (already the off-host backup pain point - see
`offhost-backups-outgrew-the-runner`), VACUUM cost, and the WAL churn that has
caused two production incidents.

**Proposal.**
- Hot/cold split by AGE, not count: rows younger than 12 months stay in the
  live tables (every product surface reads recent history only - the lead
  timeline renders 12 entries, the assignments ledger a page).
- A monthly job moves rows older than the window into per-year archive tables
  (`lead_events_2025`, ...) in a SEPARATE SQLite file per year
  (`DATA_DIR/archive/events-2025.db`), attached read-only on demand by an
  export endpoint. Separate files keep the main DB and its backups small and
  make cold storage a plain file copy.
- Tenant isolation: archives carry tenant_id like the live rows; the export
  endpoint applies the same wall. Deleting a tenant must delete its archive
  rows too (add to the tenant-deletion checklist).
- Compliance: `lead_events` can carry addresses in detail JSON; archives are as
  sensitive as the live table and live inside DATA_DIR, never in object
  storage without the same encryption posture as backups.
- Never delete without the archive write being verified (count + spot-check),
  and keep the job forward-only and restart-safe like the migrations.

**Blocked on:** the operator confirming the 12-month window (contract/1099
disputes may need longer for commission-adjacent events - `commissions` and
`commission_statements` are explicitly OUT of scope for archival) and the
off-host backup situation being fixed first, so the archive files are backed
up from day one.

## 2. Lead search architecture (FTS5 or not)

**Today.** `searchLeadsPage` matches `%q%` with LIKE across
address/city/zip/contact_name - two full scans per request (rows + count).
The overhaul bounded the CALLERS (300ms debounce on both search surfaces) but
not the query itself.

**Measurement, not vibes:** at the current 30k-lead dev tenant a search is
~10-25ms - fine. The cost is linear; at 1M leads expect 0.5-1s+ per keystroke
burst, on the synchronous event loop (the documented stall class).

**Decision proposal.**
- Adopt FTS5 when a tenant crosses ~150k leads OR `db.slow_statement` shows
  search above 250ms in production - whichever comes first. Both signals
  already exist (the slow-statement log ships).
- Shape when adopted: a contentless FTS5 table (`leads_fts(address, city,
  contact_name, content='')`) keyed by lead id, tenant filter applied by
  joining back to `leads` (FTS5 cannot carry the tenant wall itself - the
  join IS the wall, same pattern as the knock aggregates). Triggers on
  leads INSERT/UPDATE/DELETE maintain it - the same pattern `leads_version`
  now uses, so the failure mode (rebuilt table drops triggers) is already
  handled by recreate-at-boot.
- Prefix search (`q*`) covers the field use case (streets, names); ranking by
  bm25 is unnecessary - order by the existing sort keys.
- Fallback: the LIKE path stays as the code path when the FTS table is absent,
  so the migration is additive and reversible.
- NOT proposed: external search infrastructure. One box, one file is the
  deployment model; FTS5 is the strongest tool inside it.

## 3. `assigned_territory_id` reconciliation

**The divergence.** Two assignment systems share `leads.assigned_rep_id`:
direct assignment (lasso/single/bulk - does NOT touch
`assigned_territory_id`) and territory assignment (stamps it). Consequences,
verified in code:
- A door lasso'd to Bob while sitting in Ann's team's area stays visible to
  Ann's crew (visibility rule 2 keys on the territory).
- A later `/share`, `/reclaim reassign` or `/next-pass` on that area re-stamps
  Bob's door to the area's new holder with no conflict signal - the direct
  assignment silently evaporates.

**Why the branch did not change it:** the intended precedence is a business
rule nobody has stated. Either "the area always wins" (today's emergent
behavior, arguably right for crew-based knocking) or "a direct assignment
pins the door until explicitly released" (arguably right for manager intent).
Both are implementable; guessing is how two screens end up disagreeing about
who owns a door.

**Proposed invariants (pending the rule):**
- A door's `assigned_territory_id` must always reference an existing,
  non-archived territory whose polygon contains it, or be NULL. (Detection
  query: leads joined to territories on id where the territory is missing,
  archived, or the door falls outside its ring - run read-only first.)
- Every write that changes `assigned_rep_id` states which system it came from
  (`assignment_source` already exists and is partially maintained - make it
  total).

**Proposed workflow once the rule is stated:** a read-only `--dry-run` report
endpoint/script that lists disagreements per tenant (counts + samples), then a
manual, audited reconciliation action (admin-gated, per-territory, with
`recordAdminAudit` before/after and the undo-token pattern the lasso already
has). No automatic background job until the dry-run has run clean in
production for a while. Nothing destructive without the operator's explicit
approval, per AGENTS.md.
