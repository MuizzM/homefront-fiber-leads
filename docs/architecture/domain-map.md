# HomeFront Domain and Workflow Map

This is the current ownership map for incremental extraction. It describes the
existing system; it does not authorize a repository-wide move.

## Domain Boundaries

| Domain | Current entry points | Canonical responsibility | Known boundary issue |
|---|---|---|---|
| auth | `server/auth*`, `client/src/lib/auth.tsx` | authenticated actor and identity lifecycle | session ID and some identity bridges reach `window` |
| tenants | organization storage, membership and capability code | tenant ownership and membership | legacy routes still contain global/null-tenant fallbacks |
| leads | lead storage/routes, packed map wire format | lead identity, lifecycle, detail and map delivery | Fresh confidence meanings differ by consumer |
| knocking | `LeadKnockSheet`, `useKnockLogger`, offline queue, knock routes | disposition command, durable local staging and idempotent replay | pending overlays and permanent-failure rollback are not yet isolated from map query refreshes |
| calling | `server/calling/*`, `callingApi.ts` | eligible queue, session, outcome and callback handoff | eligibility re-derives Fresh confidence |
| callbacks | calling routes/store and dashboard queries | due/rescheduled/completed callback lifecycle | state ownership is split and requires an explicit contract |
| territories | map/territory routes and geometry storage | assignment, reclaim, visibility and history | map UI and policy are coupled in MapView/routes |
| scanning | scan engine, scheduler, discovery and workers | resumable job execution and capacity | several parallel pipelines and implicit state machines |
| fiber intelligence | parser, snapshot, classifier, projector | authoritative evidence, transitions and lead projection | strict classifier is not the production owner |
| commissions | legacy lifecycle contract/routes plus weekly payout subsystem | tenant-owned booking, revision-safe legal transition, atomic audit and payment state | legacy and weekly ledgers still require a future transactional convergence boundary |
| audit | login and entity audit storage/routes | append-oriented safe change history | platform and tenant audit visibility is not fully separated |
| platform operations | health, deployment workflow, worker status | readiness, release provenance, recovery | commit/schema/backup readiness is not exposed |

## Critical Workflow Catalog

### Field Knock

- Entry: lead sheet disposition.
- Current command: synchronous durable staging, optional GPS enrichment, queued
  persistence and offline replay.
- Server authority: knock route and storage transaction.
- Required invariant: optimistic pin state is pending presentation, not confirmed
  commission state.
- Retry: durable local queue with idempotency and dead-letter state.
- Logs/tests: queue replay, slow-GPS durability, rejected command UI,
  superseded reconciliation and stale-sale protections have focused coverage.

### Fresh Fiber Qualification

- Entry: discovered normalized address admitted to a scan run.
- Current path: provider queue -> token/session adapter -> response parser ->
  scan result -> snapshot/lifecycle -> projector -> lead/map/calling.
- Required authority: one versioned pure verdict requiring a successful exact
  address match, explicit fiber qualification, NEW FIBER, no active billing, and
  competitive eligibility.
- Retry: inconclusive provider outcomes remain retryable and cannot create or
  delete a lead.
- Current defect: downstream stages re-derive weaker rules.

### Field Scan

- Entry: completed map draw box/lasso.
- Current path: discovery POST -> resumable job -> SSE progress -> rAF-batched
  GeoJSON -> durable lead reconciliation.
- Required state: idle, submitting, scanning, completed, failed/cancelled.
- Required presentation: reps see checked/new-lead progress; provider diagnostics
  remain manager/admin-only.
- Current defect: submitting can be visually blank on slow networks.

### Calling

- Entry: server-authoritative next-eligible query.
- Current path: queue sync -> eligibility -> session/outcome -> callback/sale.
- Required invariant: no stale or non-deliverable Fresh confidence is callable.
- Current defect: `kinetic_new_fiber` is excluded despite authoritative
  projection, while confidence rules are duplicated.

### Commission

- Entry: confirmed sale/knock command.
- Current path: legacy commission system and newer tenant-scoped weekly payout
  system.
- Required invariant: tenant-scoped, server-calculated, idempotent booking and
  truthful client confirmation.
- Current state: legacy mutations now use a tenant-required, row-revision
  compare-and-set lifecycle command and atomic audit; unrestricted storage
  mutation was removed. Rate plans are tenant-owned, and MapView waits for
  durable knock reconciliation.

## Dependency Direction

Preferred direction for the first extraction:

```text
address discovery
  -> normalized address contract
  -> scan scheduling/admission
  -> authorized provider adapter
  -> normalized provider observation
  -> versioned Fresh eligibility verdict
  -> evidence snapshot and transition
  -> lead projection
  -> map / Fresh feed / calling consumers
```

Consumers may read the public verdict but must not re-derive it. UI modules may
present server-owned decisions but cannot upgrade eligibility, tenant ownership,
money state, or workflow completion.

## Largest Current Files

Frontend:

1. `client/src/pages/MapView.tsx` — 6,705 lines
2. `client/src/pages/KineticScanner.tsx` — 1,164
3. `client/src/pages/Team.tsx` — 1,114
4. `client/src/pages/Leads.tsx` — 1,112
5. `client/src/pages/CommissionConsole.tsx` — 1,047
6. `client/src/components/LeadKnockSheet.tsx` — 894
7. `client/src/components/ui/sidebar.tsx` — 727
8. `client/src/pages/MyCommission.tsx` — 725
9. `client/src/components/scan/LiveScanFeed.tsx` — 690
10. `client/src/pages/CityScanner.tsx` — 669

Backend:

1. `server/routes.ts` — 7,229 lines
2. `server/storage.ts` — 3,957
3. `server/addressDiscovery/store.ts` — 1,714
4. `server/calling/routes.ts` — 1,499
5. `server/index.ts` — 1,444
6. `server/scanner.ts` — 1,320
7. `server/calling/store.ts` — 1,179
8. `server/commissionService.ts` — 1,104
9. `server/scanEngine.ts` — 1,098
10. `server/calling/migrations.ts` — 928

These sizes are review triggers. Extraction must follow characterized behavior
and one coherent workflow at a time.
