# Workforce Incentives Platform — Existing-Code Audit & Migration Plan

Audit date: 2026-08-06 · Branch: `rep-knocking-workflow` · Auditor pass over
`shared/`, `server/`, `client/src/`, `tests/`, `migrations/`, `docs/`.

**Verdict up front: roughly 60% of the requested platform already exists in this
repository, and most of it is better than a greenfield rebuild would be.** Three
of the nine requested subsystems are genuinely absent (mileage, referrals, a
unified earnings ledger). The rest exist in production-grade form and must be
*extended*, not duplicated. This document is the pre-change gate: nothing in it
alters production behavior.

---

## 0. The single most important finding

The spec asks for `organization_id` on every record. **This codebase already is
multi-tenant, and the organization entity is `tenants`.**

- `tenants` table (`shared/schema.ts:6`) — slug, company name, branding, plan,
  and per-org commission policy (timezone, week start, qualification basis,
  reserve percent/cap, override rates).
- `tenant_id` is carried on 32+ tables and enforced by
  `server/tenantGuard.ts` — three deliberately distinct rules:
  `sameTenant` (read idiom), `sameTenantRead` (id-fetch reads, NULL-tenant rows
  resolve to the default org), `sameTenantWrite` (strictly stricter — writes to
  legacy NULL-tenant rows require default-org admin).
- Legacy NULL-tenant rows are adopted by `bootstrapDefaultTenant`.

**Do not create an `organizations` table.** A parallel org entity in a live
1.2 GB database would fork tenancy, silently bypass `tenantGuard`, and break
every existing isolation test (`tests/integration/tenant-isolation-audit.test.ts`,
`fresh-lead-tenant-isolation.test.ts`, `tenant-identity-payout-isolation.test.ts`,
`legacy-commission-tenant-isolation.test.ts`). Throughout this plan,
`organization_id` **is** `tenant_id`.

Similarly, the spec's role names already exist under this repo's naming:

| Spec role | This codebase | Where |
|---|---|---|
| `SUPER_ADMIN` | `super_admin` (+ immutable `users.is_super_admin`) | `shared/capabilities.ts:11` |
| `ORG_ADMIN` | `admin` | same |
| `MANAGER` | `manager` | same |
| `TEAM_LEAD` | `team_lead` | same |
| `REP` | `rep` | same |

Plus four the spec did not ask for and which must keep failing closed on new
surfaces: `calling_rep`, `calling_manager`, `compliance_admin`, `auditor`.

---

## 1. What already exists (reuse — do not rebuild)

### 1.1 Authorization — complete, and better than the spec asks for

`shared/capabilities.ts` is a real capability model, not role string checks:
40+ dotted capabilities, role→set mapping, `can()`, `capabilitiesFor()` shipped
to the client so `useCan` and the server's `requireCapability` authorize from
one source. It additionally carries governance metadata the spec did not ask
for: `CAPABILITY_DOMAIN`, `HIGH_RISK_CAPABILITIES`, `groupedCapabilities()`,
`rolesWithCapability()` — which is deliverable #12 (RBAC permission matrix)
already built and rendered at `client/src/pages/Governance.tsx`.

**Branch-level visibility already exists** in `shared/teamHierarchy.ts`:
`hierarchyRank`, `canActOnMember` (strictly-above), `HIRABLE_ROLES`,
`wouldCreateReportsCycle`, `downlineOf` (BFS, cycle-safe, node-budgeted),
`branchOwnerOf` (the "whose people are these" walk that stops cross-branch
poaching and fails open for unowned members). Paired with
`shared/leadVisibility.ts` for row scoping.

Coverage: `tests/unit/capabilities.test.ts`, `team-hierarchy.test.ts`,
`permissions.test.ts`, `tenant-guard.test.ts`;
`tests/integration/rbac-audit.test.ts`, `manager-branch-authority.test.ts`,
`field-app-rbac.test.ts`, `lane-a-authz.test.ts`, `sec-a-authz-hardening.test.ts`.

**Action: extend the capability enum and the role sets. Write no new RBAC.**

### 1.2 Commission — two planes, both real

**Legacy plane** (`commissions`, `commission_rates`): flat/percentage/tiered,
structure lock (`structure_id` + `structure_version` frozen at sale), install-gated
hold (`install_confirmed_at`, `payable_after`), row-revision CAS lifecycle
(`shared/legacyCommissionLifecycle.ts`).

**Weekly plane** (documented in `docs/COMMISSIONS.md`) — this is the one to build on:

| Table | Role |
|---|---|
| `commission_plans` | stable plan identity (no rates) |
| `commission_plan_versions` | **immutable** financial rules + `rules_snapshot` JSON for replay |
| `commission_tiers` | validated retroactive tiers per version |
| `rep_commission_assignments` | effective-dated plan-version→rep, no overlaps, acceptance snapshot |
| `commission_sales` | commissionable-sale ledger, idempotent on `(tenant_id, external_id)`, reversal = status flip never delete |
| `commission_statements` | **immutable** weekly result; snapshots timezone, basis, plan, tier |
| `commission_adjustments` | append-only; only APPROVED adjustments move the number |

`server/commissionService.ts` (1,717 lines) owns the single recompute path
`calculateOrRecalculateStatement`, which refuses to touch FINALIZED/PAID
(`STATEMENT_LOCKED`), bumps `calculation_version`, and upserts inside a
transaction under a unique `(tenant, rep, week)` index.

**The spec's rules "promotions affect future sales only", "historical
calculations never change silently", and "approved records cannot be edited
directly" are already invariants here, with tests.**

### 1.3 Overrides — `TEAM_LEAD_OVERRIDE` / `MANAGER_OVERRIDE` already shipped

`commission_overrides` (`server/overrideStore.ts:50`) is append-only with
`entry_type` EARN/CLAWBACK, `pair_seq` under
`UNIQUE(tenant_id, source_ref, beneficiary_rep_id, pair_seq)` — that unique index
*is* the spec's idempotency requirement. Each row freezes `rate_snapshot` and
`chain_snapshot` (the upline tree at earn time), stamps `beneficiary_role` and
`level`, and folds into `commission_statements.final_commission_cents`. Ships
dark behind `tenants.commission_override_enabled`.

### 1.4 Spiffs / incentives — a real engine already exists

- `spiffs` ledger — `UNIQUE(tenant_id, sale_ref)`. **`sale_ref` is already the
  spec's `idempotency_key`.** Statuses earned → approved → paid, with
  `approved_by`/`approved_at`/`paid_at`. `campaign_id` added by the campaign layer.
- `spiff_campaigns` (`server/spiffCampaignStore.ts:29`) — windows
  (`starts_at_ms`/`ends_at_ms`), `trigger_json`, `reward_cents`,
  `eligible_rep_ids`, `per_rep_cap_cents`, `campaign_cap_cents`, status.
- Pure rule layers: `shared/spiffEngine.ts` (random/streak/improvement/milestone,
  deterministic given a caller-supplied roll — reproducible in tests),
  `shared/spiffCampaign.ts` (6 trigger kinds; `triggerMet` shared by
  `evaluateCampaign` and `campaignProgress` so the rep-facing progress bar can
  never promise what the award logic refuses).
- Adjacent incentive surfaces already live: `shared/rampBonus.ts` +
  `server/rampBonusStore.ts` (**a training incentive, already paying**),
  `momentumSpiff`, `knockMilestones`, `genuineDoors`, `doorDrop`,
  `salesAchievements`.
- UI: `client/src/pages/Incentives.tsx`, RTL coverage in `Incentives.test.tsx`,
  `IncentiveCards.test.tsx`, `CampaignBoard.test.tsx`, `MilestoneCard.test.tsx`.

### 1.5 Training — substantial, but not data-driven

- `training_progress` (tenant, user, lesson, `completed_at`, `quiz_score`),
  `training_card_state`, `training_review_log` (`server/storage.ts:2340+`).
- `shared/trainingContent.ts` — **525 KB of authored curriculum**: modules,
  lessons, summaries, quizzes with explanations.
- `shared/trainingGate.ts` + `server/trainingGateStore.ts` — `users.training_required`,
  a per-org required-lesson threshold, and allowlisted route prefixes. **This is
  the spec's "REP ACTIVATED FOR SALES" gate, already built**, including a
  one-time grandfather backfill guarded by its own marker row.
- `server/trainingEngine.ts` — spaced-repetition drill deck, idempotent review
  batches, server-computed ladder, client clock trusted only for bucketing.
- `payRampBonus` already fires a training incentive into the `spiffs` ledger on
  curriculum completion, keyed `ramp-complete:rep:<id>`.
- UI: `Training.tsx`, `Coach.tsx`; tests `training-*.test.ts` (9 files).

### 1.6 Statements & PDF — already unified

`shared/commissionStatement.ts` is a pure document builder and already computes
exactly the spec's unified earnings shape:

```
earned = hourly + grossCommission + adjustments + overrides + spiffs
net    = earned − reserve
```

with `allocateCents` guaranteeing per-sale allocation re-sums to gross to the
cent (necessary because retroactive tiers re-price the whole week). Rendered by
`server/commissionStatementPdf.ts` (pdfkit) and the on-screen statement from the
same document — a rep printing the page and saving the PDF cannot see two
numbers. Endpoints exist: `GET /api/commission/statements`, `/:id`,
`/:id/document`, `/:id/statement.pdf`.

### 1.7 Payouts — Stripe Connect, already idempotent

- `rep_payout_accounts`, `rep_payouts` with **`UNIQUE(statement_id)`** — the
  spec's "one payout per recipient per pay period" is already a DB invariant.
- `shared/payouts.ts` — pure state machine (`pending|processing|paid|failed|reversed`),
  transition table, onboarding-status derivation, eligibility with typed block
  reasons, Connect webhook classifier. No Stripe, no DB, no I/O.
- `server/stripeConnect.ts` — SDK-free adapter, inert without keys.
- Webhook **signature verification** (`verifyStripeSignature`), **webhook
  idempotency** (`billing_events` replay guard), and an **out-of-order guard**
  (`last_event_at` monotonicity so a stale `account.updated` can't re-enable payouts).
- Secondary rails: `server/nachaService.ts` (ACH file export, flag-gated),
  `server/gustoAdapter.ts`.

### 1.8 Money & PII hygiene — already correct

- Integer cents end-to-end on the weekly plane; floats only in the legacy tables.
- `server/payCrypto.ts` — AES-256-GCM for routing/account/TIN/EIN. **No raw bank
  numbers are stored readable**; `last4` is the only plaintext derived value.
- `reserve_entries` is append-only enforced by **DB triggers that ABORT UPDATE
  and DELETE**.
- `team_members.recruited_by_member_id` — an immutable sponsor edge, set once at
  approval, **protected by a DB trigger that refuses any re-point**
  (`server/storage.ts:2442`).
- Rate limiting: `express-rate-limit` via `server/limiters.ts`,
  `rateLimitPolicy.ts`, `otpRateBuckets.ts`; helmet + CSP hashes in `index.ts`.
- Audit: `activity_log`, `admin_audit`, `territory_events`, `activity_overrides`,
  `onboarding_signature_events`.

---

## 2. Gaps — what is genuinely missing

### G1. Mileage tracking — **0% present**

A full-repo search for `mileage|odometer|reimburs` returns **no implementation**.
The only hits are contract text.

> **Blocking legal conflict.** `server/onboardingAgreementTemplates.ts:103` and
> `:252` state the contractor is entitled to no *"expense reimbursement"*, and
> `:252` says compensation is *"COMMISSION ONLY … not entitled to … expense
> reimbursement"*. Shipping mileage reimbursement against reps who signed those
> agreements creates a contradiction between the signed agreement and the
> payment. **The agreement templates need a new version, and existing signed
> reps need a re-issued addendum, before mileage money moves.** The spec's own
> instruction to have the org's CPA validate contractor mileage treatment
> applies here and is not something this codebase can decide.

Reusable adjacent code: `location_pings` (GPS ping shape, accuracy, rep+user dual
identity), `shared/geoVerify.ts` (spoof/accuracy classification — directly
applicable to GPS trip legitimacy), `shared/geo.ts` (haversine), `clock_sessions`
(the submit→approve→correction pattern), `punch_corrections` (**the exact
"approved records are never edited, corrections are append-only adjustments"
pattern the mileage spec asks for**).

### G2. Referral program — **0% present**

Only `rep_applications.referral_source` (free text, never validated or attributed).

Reusable: `team_members.recruited_by_member_id/_user_id/_at` — the immutable,
trigger-protected sponsor edge is precisely the attribution primitive, and its
"set once at approval from the invite's inviter, never re-pointed" semantics
already satisfy *"prevent changing the original referrer after hire"*.
`onboarding_recruiting_invites` + `server/onboardingInviteToken.ts` give tokenized
invite links; `rep_applications` gives the applicant lifecycle
(`pending|approved|rejected` → `user_id` → `activated_at`).

### G3. Unified `earnings_ledger` — **absent by design, and this is the riskiest change**

Today earnings are **computed at statement time** by summing five sources
(hourly, `commission_statements.gross`, `commission_adjustments`,
`commission_overrides`, `spiffs`). There is no normalized row-per-earning table.

Introducing `earnings_ledger` as a *second* source of truth would create two
places that can disagree about what a rep is owed. See §3 for the resolution.

### G4. Incentive campaign config — partial

`spiff_campaigns` lacks: `incentive_type` taxonomy, percentage-based amounts,
provider/product/market filters, `maximum_rewards_per_user` (it caps cents, not
count), `approval_required`, `clawback_policy`. Triggers are knock/sale-shaped
only.

### G5. No domain event stream — **the structural gap behind the whole spec**

Incentives are awarded by **inline calls at the write site** (`payRampBonus` from
the training route, `awardRampForRep`, spiff evaluation at the knock route). There
is no `SALE_APPROVED` / `TRAINING_PASSED` / `MILEAGE_APPROVED` event with a
durable `source_event_id`. The spec's `incentive_ledger.source_event_id` and its
"the same event must never create duplicate rewards" rule have nothing to point at.

### G6. Training is code-authored, not data

No `training_courses` / `lessons` / `quizzes` tables, no admin builder, no
certificates, no expiration dates, no required-by-role/provider/market
assignment, no per-course enrollment. The requested `/training/courses` API
surface does not exist. The 525 KB curriculum is a TypeScript constant.

### G7. Missing entities

- No `payout_batches` (payouts are per-statement; "pay week" batches implicitly).
- No `/statements` resource (statements are commission-week-shaped under
  `/api/commission/statements`).
- **No soft deletion anywhere** — `deleted_at` does not exist in the codebase.
  Deactivation is via `active` flags and status columns.

### G8. Payout provider abstraction is Stripe-shaped

`shared/payouts.ts` is pure and provider-agnostic in spirit, but
`server/payoutRoutes.ts` calls `stripeConnect` directly. Dwolla/Plaid Transfer
need a `PayoutProvider` interface seam.

### G9. Scale

`data.db` is **1.2 GB** SQLite (better-sqlite3, WAL). The 100k-lead performance
requirement is addressed in §5.

---

## 3. Migration plan

Ordering principle: **every phase ships dark or read-only first.** No phase
changes an existing rep's pay until an admin opts in, matching how
`commission_override_enabled`, `commission_reserve_percent = 0`, and the training
gate's grandfather backfill were each shipped.

### Phase 0 — Foundations (no behavior change)

1. **Event spine.** New `domain_events` table (append-only:
   `tenant_id`, `type`, `subject_type`, `subject_id`, `actor_user_id`,
   `payload`, `occurred_at`, `dedupe_key UNIQUE`). Emit from existing write
   sites; **no consumer yet**. This is what G5 needs and what every later phase
   subscribes to.
2. **Soft-delete convention.** Add `deleted_at` to *new* tables only. Do not
   retrofit 38 existing tables — that is a separate, independently-testable
   change with its own migration risk.
3. **Capability additions** (extend `shared/capabilities.ts`, no new RBAC):
   `training.manage`, `training.read.team`, `mileage.submit.self`,
   `mileage.read.team`, `mileage.approve`, `mileage.settings.manage`,
   `referral.read.self`, `referral.read.org`, `referral.approve`,
   `incentive.campaign.manage`, `earnings.read.self|team|org`.
   All new caps default OFF for `rep` except the `.self` ones.
4. **Migration mechanics.** This repo migrates via idempotent
   `CREATE TABLE IF NOT EXISTS` + guarded `ALTER` inside store modules called at
   boot (`server/storage.ts` runMigrations, plus per-store `ensure*Schema()`),
   with one `.sql` file in `migrations/`. **Follow the existing pattern** —
   introducing drizzle-kit push against a live 1.2 GB DB is a separate decision.

### Phase 1 — Mileage (fully additive; nothing existing reads it)

Lowest risk, zero coupling to money until Phase 5. New tables
`mileage_trips`, `mileage_adjustments`, `mileage_rates` (org + effective-date,
**no hard-coded government rate**), `vehicles`. Reuse `geoVerify` for GPS
plausibility and the `punch_corrections` pattern for post-approval corrections.
Gate on the agreement-template resolution (G1) before any reimbursement is
payable.

### Phase 2 — Training as data (additive, curriculum stays authoritative)

New `training_courses`, `training_lessons`, `training_quizzes`,
`training_questions`, `training_enrollments`, `training_assignments`,
`training_certificates`. The existing 525 KB curriculum is **imported as a seeded
system course** whose lesson ids match today's `training_progress.lesson_id`, so
existing progress carries over with zero rewrite and the gate keeps working.
New `/api/training/courses…` endpoints sit beside the existing engine routes.

### Phase 3 — Referrals (additive, dark)

`referral_links`, `referrals`, `referral_events` per spec. Attribution writes to
the existing immutable `recruited_by_*` edge at approval; the referral row is the
program state machine on top. Qualification counts `commission_sales` with
`status = 'QUALIFIED'` and no reversal. Reward creation is **suppressed until an
admin enables the program** and configures threshold/amount/window/clawback.

### Phase 4 — Incentive engine generalization

Extend `spiff_campaigns` in place (add `incentive_type`, `amount_basis`,
`percentage_bp`, `filters_json`, `max_rewards_per_user`, `approval_required`,
`clawback_policy_json`) rather than creating a second campaign table. Add a
subscriber that consumes `domain_events` and writes `spiffs` rows, using
`sale_ref` = a deterministic key derived from `(campaign_id, event_id, rep_id)`
so the existing UNIQUE index enforces "one event, one reward". The existing
inline award call sites migrate to emitting events; **both paths run in parallel
behind a flag until parity tests pass, then the inline path is deleted.**

### Phase 5 — `earnings_ledger` as a **projection**, not a second truth

This is the decision that determines whether the platform stays correct. See §4.

### Phase 6 — Statements, payout batches, provider abstraction

`/api/statements*` as a thin facade over the existing statement document (which
already carries every requested line item except mileage and referrals — added
in Phases 1 and 3). `payout_batches` groups the existing `rep_payouts` rows;
`UNIQUE(statement_id)` stays the idempotency anchor. Extract a `PayoutProvider`
interface with `stripeConnect` as the first implementation.

### Phase 7 — Dashboards, seed data, performance

---

## 4. The `earnings_ledger` decision (must be settled before Phase 5)

**Option A — Projection (recommended).** `earnings_ledger` is a materialized,
append-only *derivation* of the five existing sources. Statement math continues
to run off the source tables; the ledger is rebuilt deterministically and
reconciled by a test asserting `Σ(ledger.net) == statement.earned` for every
rep-week. Cost: one more thing to keep in sync. Benefit: **no risk of re-pricing
historical pay**, the existing 40+ money tests keep their meaning, and the spec's
reporting/liability requirements are all satisfied by a read model.

**Option B — Write-path (spec-literal).** Every earning writes `earnings_ledger`
first and the statement sums the ledger. Cleaner long-term. But it re-routes the
math for hourly, commission, overrides, spiffs, and reserve simultaneously, and a
backfill of historical rows that disagrees by one cent with a `FINALIZED`/`PAID`
statement means a rep's past pay stub changes. That is the exact failure mode
`commission_statements` immutability was built to prevent.

**Recommendation: Option A, with the ledger as the *sole* source for the three
new earning types (`MILEAGE_REIMBURSEMENT`, `REFERRAL_BONUS`, and new-style
`SPIFF`), and a projection for the four existing ones.** New money is
ledger-native; old money is never re-derived.

---

## 5. Performance plan (100k+ leads)

Current: better-sqlite3, WAL, 1.2 GB `data.db`, synchronous single-writer.
Existing infrastructure already relevant: `server/dbPrune.ts`,
`server/dbSafetyNet.ts`, WAL guard tests, `perf-query-equivalence.test.ts`,
`incentive-perf.test.ts`, `bulk-assign-large.test.ts`.

The new tables are **low-cardinality relative to leads** — mileage trips,
referrals, and incentive rows scale with *reps × days*, not with leads. The real
risks are (a) the incentive subscriber doing per-lead work, and (b) unbounded
statement aggregation. Plan: covering indexes on every
`(tenant_id, rep_id, <time>)` read path, aggregation via single indexed
`COUNT`/`SUM` (the pattern `commissionService` already uses), batch event
consumption with a cursor rather than per-row triggers, and a documented
Postgres migration seam if writer contention becomes the bound. Full detail lands
with Phase 7.

---

## 5a. What has shipped (implementation log)

Decisions taken (confirmed by the operator before any code was written):
**earnings ledger = projection + new-money native**, **mileage built in full with the
money gated**, **training DB layer alongside the authored curriculum**.

| Phase | Status | Files |
|---|---|---|
| 0 — Event spine | **Done** | [shared/domainEvents.ts](shared/domainEvents.ts), [server/domainEventStore.ts](server/domainEventStore.ts), capability additions in [shared/capabilities.ts](shared/capabilities.ts) |
| 1 — Mileage | **Done** | [shared/mileage.ts](shared/mileage.ts), [server/mileageStore.ts](server/mileageStore.ts), [server/mileageRoutes.ts](server/mileageRoutes.ts), [client/src/pages/Mileage.tsx](client/src/pages/Mileage.tsx) |
| 2 — Training as data | **Not started** | — |
| 3 — Referrals | **Done** | [shared/referral.ts](shared/referral.ts), [server/referralStore.ts](server/referralStore.ts), [server/referralRoutes.ts](server/referralRoutes.ts), [client/src/pages/Referrals.tsx](client/src/pages/Referrals.tsx) |
| 4 — Incentive engine | **Done** | [shared/incentiveEngine.ts](shared/incentiveEngine.ts), [server/incentiveSubscriber.ts](server/incentiveSubscriber.ts) |
| 5 — Earnings ledger | **Done** | [shared/earningsLedger.ts](shared/earningsLedger.ts), [server/earningsLedgerStore.ts](server/earningsLedgerStore.ts) |
| 6 — Statements | **Partial** — statement page routed; payout batches and the provider interface not built | [client/src/pages/StatementPage.tsx](client/src/pages/StatementPage.tsx) |
| 7 — Seed + dashboards | **Partial** — seed walkthrough done; dashboards and campaign-builder UI not built | [script/seed-workforce-demo.ts](script/seed-workforce-demo.ts) |

Tests added: 143 (5,057 total, all passing). New suites:
`domain-events`, `domain-event-store`, `mileage`, `mileage-store`, `referral`,
`referral-store`, `incentive-engine`, `earnings-ledger`.

### Three bugs the tests and the seed run caught

1. **`ON CONFLICT` against a partial index.** `spiffs` is unique on
   `(tenant_id, sale_ref) WHERE sale_ref IS NOT NULL`. SQLite only matches a
   conflict target to a partial index when the target repeats the predicate, so
   the engine's award insert threw at runtime — meaning the no-duplicate-rewards
   guarantee would not merely have been slow, it would not have existed.
2. **Ledger origin derived from the wrong thing.** `origin` was computed from the
   earning *type*, but a `CLAWBACK` arises both from an approved negative
   commission adjustment (projected) and from an engine reversal (native).
   Reconciliation sums only projected rows, so every week with a negative
   adjustment reported a false drift. Origin is now a property of the **source**.
3. **Two writers, one debt.** The seed walkthrough printed `$1,000.00` of referral
   bonus and `$16.16` of mileage. `mileageStore`/`referralStore` and the incentive
   subscriber were both writing earnings rows for the same money under *different*
   idempotency keys — which no uniqueness constraint can catch, because the
   database cannot tell they are the same money. Resolved by
   `ENGINE_OWNS_EARNINGS`: the ledger row belongs to whoever decided the amount.

### Still gated, deliberately

- **Mileage reimbursement money** is off for every org
  (`mileage.reimbursement_enabled`). §G1's agreement conflict is unresolved, and
  the settings endpoint refuses to enable it without an explicit
  `agreementAcknowledged`.
- **The referral programme** is off for every org (`referral.program.enabled`).
  Links mint and clicks count, but no attribution is accepted and no reward exists.

---

## 6. Deliverable status against the request

| # | Deliverable | Status after audit |
|---|---|---|
| 1 | Existing-code audit | **This document** |
| 2 | Database migrations | Phases 0–6, existing idempotent-DDL pattern |
| 3 | ORM schema | Extend `shared/schema.ts` (Drizzle, not Prisma) |
| 4 | TypeScript types | Per-domain pure modules in `shared/`, matching house style |
| 5 | Incentive rule engine | **Extend** `spiffEngine`/`spiffCampaign` + event subscriber |
| 6 | Training APIs + UI | Extend; curriculum imported, gate reused |
| 7 | Mileage APIs + mobile UI | **New** — blocked on agreement-template resolution |
| 8 | Referral system | **New** — attribution reuses `recruited_by_*` |
| 9 | Earnings ledger | **New**, as a projection (§4) |
| 10 | PDF statements | **Exists** — extend with mileage/referral sections |
| 11 | Payout provider abstraction | Extract interface; Stripe Connect exists |
| 12 | RBAC permission matrix | **Exists** (`capabilities.ts` + `Governance.tsx`) — extend |
| 13 | Role screens | Extend `Incentives`, `Training`, `MyCommission`, `CommissionConsole` |
| 14 | Automated tests | 300+ tests exist; add per-phase |
| 15 | Seed data | New script; the `$500 / 6-sale` walkthrough |
| 16 | Performance plan | §5 |

---

## 7. Open decisions (blocking Phase 5+)

1. `earnings_ledger` — projection (Option A) or write-path (Option B)?
2. Training — DB course layer *alongside* the authored curriculum, or migrate the
   curriculum fully into tables?
3. Mileage — proceed with the agreement-template revision, or build mileage
   read-only (log + export, no reimbursement) until legal/CPA sign-off?
4. Payout provider — Stripe Connect only behind the new interface, or implement
   Dwolla/Plaid now?
