# HomeFront Autonomous Build Board

Updated: 2026-07-28  
Branch under integration: `codex/reconcile-latest`  
GitHub baseline: `1e3aedb` on `origin/rep-knocking-workflow`

This board uses the release-status language from the HomeFront build directive.
It does not claim that local work is released or production verified.

## Executive Status

| Area | Status | Evidence |
|---|---|---|
| GitHub baseline | TESTED | Latest remote commit `1e3aedb` is integrated; the combined source passed the complete local gate |
| TypeScript | TESTED | `npm run check` and `npm run check:fast` passed |
| Automated suite | TESTED | 191 test files and 1,703 tests passed |
| Production build | TESTED | Vite client and bundled server build passed |
| Deployment controls | TESTED | Manual deploy now requires successful CI for the exact requested SHA; `tests/deployment-safety.sh` passed |
| Exact Fresh evidence | IMPLEMENTED and TESTED | Same-rooftop identity, explicit availability, same-epoch evidence, and conclusive no-service regressions pass |
| Tenant lead dedupe | IMPLEMENTED and TESTED | Exact and normalized duplicate fallbacks are tenant-scoped; two-tenant regression passes |
| Field save honesty | IMPLEMENTED and TESTED | One queue owner, synchronous durable staging before GPS, superseded reconciliation, rejected/async central-action UI, and money-query invalidation pass |
| Legacy commission lifecycle | IMPLEMENTED and TESTED | Tenant-required lookup/update, row-revision CAS, legal transitions, paid immutability, no unrestricted writer, and atomic audit pass |
| Independent review | REVIEWED | Scanner, field, and money/deploy exact-diff reviewers accepted the integrated source |
| GitHub push | READY | Exact-diff reviews and the full local validation gate passed; fast-forward only, never force-push |
| Production release | BLOCKED | Pre-existing upstream money migration and deployment recovery risks require a separate release decision |

## Integrated Change Set

The rejected local money bundle `eebe8bc` is deliberately excluded. Its useful
parts were either superseded upstream or incomplete.

| Slice | Status | Invariant |
|---|---|---|
| Exact-SHA deploy gate | TESTED | Ancestry alone cannot release a red commit |
| Fresh lead tenant wall | TESTED | One tenant cannot suppress or receive another tenant's address lead |
| Kinetic identity/evidence gate | TESTED | Only the requested exact rooftop with explicit positive current evidence can publish |
| Explicit no-service preservation | TESTED | Provider `NO_SERVICE` stays conclusive and creates no lead |
| Scanner import isolation | TESTED | Test imports do not start transport; production still warms without the legacy auth flag |
| Field knock reconciliation | TESTED | Taps are durably staged before GPS, stay pending until confirmation, and stale knocks never claim a sale |
| Legacy commission lifecycle | TESTED | Tenant-scoped row-revision compare-and-set transition and audit are one transaction |

## P0/P1 Defect Board

| ID | Severity | Domain | Finding | Status |
|---|---|---|---|---|
| HF-001 | BLOCKER | money migration | Upstream boot migration chooses the newest pending commission as survivor without authoritative financial evidence | REPRODUCED; not introduced by this diff |
| HF-002 | HIGH | commissions | A new pending legacy commission can be created after an earlier one is approved/paid | REPRODUCED |
| HF-003 | HIGH | commissions | Manual commission creation lacks a complete idempotency/reference/atomic-audit command | REPRODUCED |
| HF-004 | HIGH | commissions | Non-sold reversal can delete unrelated manual pending commissions | REPRODUCED |
| HF-005 | HIGH | commission rates | Updates lack strict validation, expected-version CAS, and immutable history | REPRODUCED |
| HF-006 | HIGH | platform money | Tenantless apex can still reach some global aggregate paths | REPRODUCED |
| HF-007 | HIGH | knocking | Pending optimistic map state can still be overwritten by a stale poll; permanent failure lacks per-lead rollback | REPRODUCED |
| HF-008 | HIGH | knocking | GPS collection preceded durable enqueue, so a page close during capture could lose a tap | TESTED; fixed by synchronous staging in `f95365b` |
| HF-009 | HIGH | leads/calling | `kinetic_new_fiber` delivery meaning is not yet canonical across map, Fresh feed, and calling | REPRODUCED |
| HF-010 | HIGH | scanning/inventory | Concord and priority-market source coverage needs a durable completeness ledger | REPRODUCED |
| HF-011 | HIGH | database startup | Migration alias imports log and continue in tests; readiness does not prove every critical backfill | REPRODUCED |
| HF-012 | HIGH | release operations | Production commit/schema/backup provenance and restore evidence are incomplete | BLOCKED on production evidence |

## Architecture Debt Board

| ID | Priority | Debt | Incremental boundary |
|---|---|---|---|
| AD-001 | P0 | Fresh eligibility is re-derived by several consumers | Introduce one versioned public verdict and migrate consumers serially |
| AD-002 | P0 | `MapView.tsx` still owns multiple workflows | Continue extraction after pending-overlay characterization tests |
| AD-003 | P0 | `server/routes.ts` and `server/storage.ts` remain blast-radius files | Extract domain commands after contract tests |
| AD-004 | P1 | Legacy and weekly commission systems remain dual writers | Make one canonical ledger and the other a durable projection |
| AD-005 | P1 | Query keys remain partly ad hoc | Add tenant-aware domain key factories |
| AD-006 | P1 | Scanner states are distributed across workers and stores | Publish typed state/events and legal transitions |
| AD-007 | P1 | Migration-time dynamic aliases are unreliable in the test runtime | Replace dynamic alias requires with direct, testable imports |
| AD-008 | P1 | Map and scanner observability lacks safe release provenance | Add commit/schema/worker metadata to readiness |

## File Ownership

| Lane | Writable files | Shared files | Integration result |
|---|---|---|---|
| Upstream GitHub work | Remote commits through `1e3aedb` | routes, storage, MapView, scanner | Preserved as the integration base |
| Scanner reconciliation | scanner, projector, focused tests | scanner/storage | Serialized and TESTED |
| Field reconciliation | knock hook/helper, MapView, LeadKnockSheet, tests | MapView | Manually ported over upstream performance/UI changes and TESTED |
| Money lifecycle | lifecycle contract, routes/storage, focused tests | routes/storage | Manually reconciled with upstream superseded logic, revision CAS added, unrestricted writer removed, and TESTED |
| Release gate | deploy workflow and safety test | workflow | TESTED |
| Director | architecture documents and final integration | all source read-only during documentation | IN PROGRESS |

## Validation

```text
npm run check
  PASS

npm run check:fast
  PASS

npm test
  PASS — 191 files, 1,703 tests

npm run build
  PASS — client and server

bash tests/deployment-safety.sh
  PASS — Docker Compose validation skipped because Compose is unavailable locally
```

Known non-failing output:

- Migration backfills cannot resolve several TypeScript path aliases through
  runtime `require(...)` in Vitest.
- Existing LeadKnockSheet tests emit React `act(...)` warnings.
- Several scanner mocks omit `proxyUrlFromEnv`, causing redacted fallback
  warnings without outbound success.

## Release Sequence

1. Independent exact-diff ACCEPT reviews received.
2. Update this board with the final immutable commit.
3. Fast-forward `rep-knocking-workflow`; never force-push.
4. Push and require GitHub CI success for the exact SHA.
5. Do not production-release until the money migration/recovery blocker has an
   authoritative reconciliation and rollback decision.

## Next Autonomous Slice

Build a durable per-lead pending knock overlay and permanent-failure rollback.
Synchronous enqueue-before-GPS is complete; the next field slice must keep stale
polls from erasing queued outcomes and roll back only the exact failed command.
