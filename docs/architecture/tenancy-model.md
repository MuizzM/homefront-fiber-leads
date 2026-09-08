# Tenant ownership model

Current as of the 2026-09-08 foundation branch; see [ADR 0001](../adr/0001-tenant-and-data-foundation.md).

## Actual model

`tenants` is the organization entity. Users carry `tenantId`; sessions resolve
the authenticated user. Email uniqueness is global today. Roles/capabilities
come from `shared/capabilities.ts`. The immutable `isSuperAdmin` marker is distinct
from a mutable role string. SQLite provides constraints and transactions, but
no installed RLS policy enforces request tenancy.

`server/tenantGuard.ts` contains legacy/null-row compatibility; the older
`sameTenant` helper is permissive. `bootstrapDefaultTenant` adopts legacy rows
for the default organization. These are historical boundaries to audit, not
permission to introduce global/null fallbacks in new APIs.

## Required boundary for new work

| Boundary | Contract |
| --- | --- |
| Request | Derive tenant and actor from verified session; capability check on server. Ignore ordinary request-body tenant overrides. |
| Store | Require positive tenant context, bind values, and constrain read/update/delete predicates. Validate referenced entities in the same tenant. |
| Projection/queue | Canonical record establishes ownership; cached/nullable queue metadata cannot grant access. |
| Cache/stream/offline | Key and purge by identity/tenant/scope. A late response from an old session cannot populate the new user's state. |
| Platform maintenance | Explicit internal entry point and tested ownership policy. A background global cursor does not grant an HTTP caller global access. |
| Audit | Stamp target tenant and actor; commit with the authorized mutation where audit is required. Avoid raw customer/provider payloads. |

Queue health/recovery now project the global worker checkpoint onto the caller's
own event IDs and backlog. Event/recovery arrays return at most 200 entries and disclose
`truncated`. Missing organization context returns 400, including platform users
without an organization; foreign and missing action IDs both return 404. No
new cross-tenant HTTP override is introduced. Internal financial ordering stays
global. Reconciliation's queue entries also join immutable event ownership.

Tests: `tests/integration/event-queue-tenant-boundary.test.ts`, existing
`tenant-isolation-audit`, `tenant-identity-payout-isolation` and legacy/fresh-lead
isolation suites. These prove their named paths, not a universal tenant audit.
