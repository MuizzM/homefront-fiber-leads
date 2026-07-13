# Weekly Commission System

The retroactive weekly rep-commission module. It answers one question precisely:
**for a given rep and a given commission week, how much did they earn?** — and it
makes that answer reproducible, auditable, and immutable once finalized.

> This is deliberately **isolated** from the legacy `commissions` / `commission_rates`
> tables and from any MLM / override / payout-tree system. Nothing here reads or
> writes those. Money is **integer cents** end-to-end — never floats.

## Layers

| Layer | File | Responsibility |
|---|---|---|
| Pure workweek | [`shared/workweek.ts`](../shared/workweek.ts) | DST-correct week boundaries in the org timezone (half-open `[start, next)`) |
| Pure tiering | [`shared/commissionTiers.ts`](../shared/commissionTiers.ts) | Retroactive tier math + validation, integer cents |
| Persistence + orchestration | [`server/commissionService.ts`](../server/commissionService.ts) | Config, plans, assignments, sales ledger, statement calc |
| Internal API | [`server/commissionRoutes.ts`](../server/commissionRoutes.ts) | RBAC-gated, tenant-scoped HTTP surface |
| Schema | [`shared/schema.ts`](../shared/schema.ts) | Drizzle tables + tenant config columns |

## The calculation, in one sentence

A rep's **total qualified sales in the week** select **one** tier, and that tier's
rate applies **retroactively to every sale**:

```
grossCommissionCents = qualifiedSaleCount × selectedTier.rateCents
```

Not progressive. 8 sales on the default plan is `8 × $200 = $1,600` — **not**
`7 × $150 + 1 × $200`. Crossing a tier boundary re-prices the whole week.

**Default plan** (cents): 1–7 → `$150`, 8–12 → `$200`, 13–16 → `$250`, 17+ → `$300`.

## Data model

- **`commission_plans`** — a plan's stable identity (name/type/status). No rates live here.
- **`commission_plan_versions`** — *immutable* financial rules. A rate/tier change is a
  **new version**, never an in-place edit. Carries `rules_snapshot` (JSON) for replay.
- **`commission_tiers`** — validated retroactive tiers for a version (`shared/commissionTiers`).
- **`rep_commission_assignments`** — effective-dated assignment of a plan *version* to a rep.
  **No overlapping active periods** for a rep (enforced in the service — SQLite has no
  range-exclusion constraint).
- **`commission_sales`** — the commissionable-sale **ledger**. A dedicated table (not
  `knock_log`, which is an append-only knock-event log with no qualification lifecycle).
  Reversals **flip status + stamp a timestamp**; rows are never physically deleted.
  Idempotent on `(tenant_id, external_id)`.
- **`commission_statements`** — *immutable* weekly result. Snapshots timezone, basis, plan,
  and tiers so a later config change never rewrites a past week.
- **`commission_adjustments`** — append-only. Only **APPROVED** adjustments affect a statement.

### Org configuration (on `tenants`)

`commission_timezone`, `commission_week_starts_on`, `commission_week_start_local_time`,
`commission_qualification_basis` (`SOLD_AT` | `QUALIFIED_AT` | `INSTALLED_AT` | `ACTIVATED_AT`),
`commission_finalization_delay_hours`, `commission_correction_window_days`,
`commission_auto_finalize_enabled`. Defaults: America/New_York, Monday, 00:00, `QUALIFIED_AT`.

## The statement invariant

Every statement satisfies, at all times:

```
finalCommissionCents = grossCommissionCents + adjustmentCents
adjustmentCents       = Σ(APPROVED adjustments for the statement)
```

`calculateOrRecalculateStatement({ tenantId, repId, weekReference, actorId, requestId })`
is the **single** recompute path. It:

1. Loads org config, computes the week's DST-correct bounds.
2. Refuses to touch a `FINALIZED` / `PAID` statement (`STATEMENT_LOCKED`).
3. Resolves the plan version effective for the week (`NO_EFFECTIVE_PLAN_ASSIGNMENT` if none).
4. Aggregates qualified sales via one indexed `COUNT(*)` over `[weekStart, nextWeekStart)`.
5. Sums approved adjustments, runs the pure `computeStatement`, and **upserts** the row
   inside a transaction. The unique `(tenant, rep, week)` index + synchronous
   better-sqlite3 make duplicate rows impossible under concurrency; recalculation bumps
   `calculation_version`.

## Authorization (RBAC)

Capability-gated (`shared/capabilities.ts`), enforced identically to the rest of the app:

| Role | Reads | Writes |
|---|---|---|
| **REP** | own statements only (`commission.read.self`) | — |
| **TEAM_LEAD** | self + direct reports (`commission.read.team`) | plans, versions, assignments, sales, adjustments (`commission.structure.manage`) |
| **HIRING_MANAGER** → `manager` | whole tenant (`commission.read.all`) | + **approve** adjustments, statement finalize/pay |
| **ADMIN** | whole tenant | + org config (`settings.manage.org`) |

Read scope is fail-closed: a rep with no linked team member sees **nothing**, never the
whole table. Every query is tenant-scoped; referenced rows are verified to share the tenant
(`CROSS_TENANT_ACCESS` otherwise). Adjustment **create** and **approve** are separated
(structure.manage vs read.all) for segregation of duties.

## Internal API

All under `/api/commission`, all tenant-scoped from the session (never the body):

```
GET   /config                         read org config           (read.team)
PATCH /config                         update org config         (settings.manage.org)
GET   /plans                          list plans + versions     (structure.manage)
POST  /plans                          create plan               (structure.manage)
POST  /plans/:id/versions             add immutable version     (structure.manage)
POST  /plans/:id/activate             activate plan             (structure.manage)
POST  /assignments                    assign version to rep     (structure.manage)
GET   /reps/:repId/assignments        list rep assignments      (read.team, scoped)
POST  /sales                          idempotent sale upsert    (structure.manage)
POST  /sales/:externalId/transition   QUALIFY/REVERSE/etc.      (structure.manage)
POST  /statements/recalculate         recompute a week          (read.team, scoped)
GET   /statements[?repId&weekStartUtc] scoped list              (read.self)
GET   /statements/:id                 statement + adjustments   (read.self, scoped)
POST  /statements/:id/transition      FINALIZE/REOPEN/MARK_PAID  (read.all)
POST  /adjustments                    create PENDING adjustment (structure.manage)
POST  /adjustments/:id/decide         APPROVE/REJECT            (read.all)
```

Errors are typed (`CommissionError.code` + `httpStatus`): `STATEMENT_LOCKED` (409),
`OVERLAPPING_PLAN_ASSIGNMENT` (409), `NO_EFFECTIVE_PLAN_ASSIGNMENT`, `INVALID_TIER_CONFIGURATION`,
`CROSS_TENANT_ACCESS` (404), `UNSUPPORTED_TIER_MODE`, `INVALID_TIMEZONE`, `INVALID_ADJUSTMENT`.

## Migrations

Additive and idempotent. Base tables come from `drizzle-kit push` (schema.ts); the
`runMigrations()` array in `server/storage.ts` `ALTER`s the seven `commission_*` columns onto
`tenants` and `CREATE TABLE IF NOT EXISTS` the six new tables + indexes. Duplicate-column /
already-exists errors are swallowed, so it is safe to re-run against an existing DB. **No
existing data is modified.**

## Tests

- `tests/unit/commission-statement.test.ts` — pure `computeStatement` dollar matrix, the
  `final = gross + adjustment` invariant, flat plans, tier-mode/validation guards, and
  effective-dated assignment resolution / overlap detection.
- `tests/integration/commission-service.test.ts` — end-to-end against a throwaway SQLite
  (`DATA_DIR` → temp): sale aggregation, the half-open week boundary, idempotent recompute,
  the adjustment approval flow, immutability locking, tenant isolation, and capability scope.

Run: `npx vitest run tests/unit/commission-statement.test.ts tests/integration/commission-service.test.ts`

## Stripe Connect rep payouts

The admin workspace at `/#/commission-console` combines weekly commission review,
finalization, payout readiness, and payout history. Reps connect their own bank
account from `/#/my-commission`; bank details stay on Stripe's hosted Express
onboarding and are never stored by HomeFront.

Required environment variables:

```dotenv
STRIPE_SECRET_KEY=sk_test_...
STRIPE_CONNECT_WEBHOOK_SECRET=whsec_...
```

Configure a Stripe Connect webhook for:

```text
https://portal.homefrontsolutionsllc.com/api/payouts/webhook/stripe
```

Subscribe it to `account.updated`, `transfer.reversed`, `payout.paid`, and
`payout.failed`. Test mode and live mode use different keys, connected accounts,
balances, and webhook signing secrets.

Payment sequence:

1. The rep opens **My Commission → Set up payouts** and completes Stripe-hosted KYC and bank setup.
2. An authorized manager reviews the week and resolves every exception.
3. An admin finalizes the week, funds the available Stripe platform balance, and opens **Pay reps**.
4. The app shows per-rep eligibility, exact payout total, estimated fees, and the available Stripe balance.
5. The admin confirms once. Each statement gets one idempotent Stripe Transfer; a unique DB constraint and transfer-group reconciliation prevent duplicates across retries or crashes.
6. Connected accounts use an automatic daily bank-payout schedule. The app enforces that schedule before moving new money, including for accounts created by older releases.

The transfer step uses the Stripe platform balance; it does not pull the money
from the business bank account at button-click time. Top up/fund Stripe early
enough for the balance to become available. A transfer that Stripe rejects is
recorded as failed and the statement remains unpaid.

Only the `payouts.pay` capability (admin/owner) can call the money-moving route.
Managers and team leads can review the same batch and payment readiness but never
receive a functional Pay button. `rep_payouts.statement_id` is unique and all
payout actions are tenant-scoped and written to the activity/audit log.
