# Hierarchy & Commission — Implementation Audit

> **Generated:** 2026-08-06 · Audited against the multi-tenant D2D hierarchy /
> downline / override / promotion / statement specification.
>
> Method: seven parallel dimension audits (hierarchy ops, RBAC + tenant isolation,
> rep commission engine, override ledger, statements + PDF, client UI, tests +
> migrations + perf) over the live tree, each followed by an adversarial pass that
> re-searched every "missing" or "incomplete" claim under alternative names before
> letting it stand. Claims that were refuted were moved into "exists" and are
> marked `[resolved]`. Every finding below carries a `file:line` citation.
>
> Companion to [`COMMISSIONS.md`](./COMMISSIONS.md), which documents the shipped
> design this report measures the spec against.

## Status — what has since landed

The compensation-model question in §5 was decided: **Option A — retroactive
weekly tiering is kept.** Per-sale immutability for the rep leg is to be achieved
by materializing rows at FINALIZE (WP-12), and the commission pool is validated at
**config** time, not sale time (WP-13). §4.1 and §4.2 should be read with that
decision already made.

Landed:

| WP | Work | Where |
|---|---|---|
| **WP-1** | `upsertSale` write guards (re-attribution, re-dating, locked weeks) | `server/commissionService.ts`, `server/commissionRoutes.ts` |
| **WP-2** | Locked-week probe in `promoteReleasedHolds` → `LOCKED_WEEK_RELEASE` | `server/overrideStore.ts` |
| **WP-3** | `tenants.status` enforced at request time, at login, + session sweep | `server/routes.ts` |
| **WP-4** | Branch-scoped commission money writes (`denyOutOfBranch`) | `server/commissionRoutes.ts` |
| **WP-5** | Overrides row on the statement; summary rows consolidated into one shared builder | `shared/commissionStatement.ts`, PDF + client |
| **WP-20** | Statement at its own route `/statements/:id`; week filters on the console | `client/src/pages/StatementPage.tsx`, `CommissionConsole.tsx` |
| **WP-21** | Tenant wordmark on the statement (validated data URI, three-level fallback) | `server/commissionStatementDoc.ts`, PDF + client |
| **WP-22** | Statement provenance — locked weeks stamped with `finalized_at`; open weeks marked drafts | `server/commissionStatementDoc.ts`, PDF + client |
| *(part of WP-14)* | `uplineSlotsOf` — derived manager/team-lead pair as a read model | `shared/teamHierarchy.ts`, week overview |
| **WP-6** | One door for role changes — `PATCH /api/users/:id` refuses `role` for anyone in the org chart | `server/routes.ts` |
| **WP-7** | Audit trail completed: `supervisor_changed` (explicit **and** implicit), member `created`, and moved-report **ids** instead of counts on offboard/delete | `server/routes.ts` |
| *(part of WP-8)* | Branch guard on **hiring** — the last side door around anti-poaching | `server/routes.ts` |

WP-22 did **not** add a `statement_issued_at` column as originally sketched:
`finalized_at` already records exactly that moment, and a second column could
only disagree with it.

Still open: the rest of **WP-8** (consolidating the guard stack into a single
`authorizeHierarchyChange`, plus cycle checks at the three re-home sites),
**WP-9** (`user_hierarchy_history` — now unblocked, since WP-6 and WP-7 were its
preconditions), **WP-10/10c** (indexes, roster caching, reconciling the two scope
resolvers), **WP-11 – WP-14** (legacy-plane demotion, finalize-time rep ledger,
pool validator), and **WP-15 – WP-19** (profile screen, promotion wizard,
hierarchy tree, bulk reassign).

### Verifying locally

`.claude/launch.json` carries a second config, **`homefront-verify`**, which runs
the app against a throwaway `DATA_DIR` (`.dev-verify/`, gitignored). Use it
instead of the main `homefront` config when you need to drive the UI: the primary
config opens the 1 GB `data.db`, and two dev servers contending for that file
wedge each other on the SQLite write lock.

---

# DEFINITIVE ENGINEERING GAP REPORT
## HomeFront Fiber — hierarchy, RBAC, and commission spec vs. shipped code

Scope note: seven dimension audits were reconciled; contradictions between them were resolved by reading source. Four cross-dimension disputes were settled and are marked **[resolved]** where they appear.

---

# 1. WHAT ALREADY EXISTS AND IS SOUND

**Do not rebuild any of this.** It is tested, transactional, and in several places stronger than the spec asks for.

## 1.1 Hierarchy authority and lifecycle — complete and incident-hardened

| Spec requirement | Where it lives |
|---|---|
| Permission validation (actor outranks target) | `shared/teamHierarchy.ts:38-43` `canActOnMember`, called at `server/routes.ts:5142`, `:5400`, `:5467`, `:5504`, `:9415`. Authority uses the **effective** role — `max(team_members.role, users.role)` — via `effectiveMemberRole` (`server/routes.ts:5359-5364`), so a low field role cannot shield a high login |
| Role-change capped by hire authority | `HIRABLE_ROLES` `shared/teamHierarchy.ts:47-56`; enforced `server/routes.ts:5080`, `:5170`, `:5343` |
| No self-assign | `server/routes.ts:5128` (reportsToId==id), `:5184-5192` `SELF_LIFECYCLE_FORBIDDEN`, `:5397`, `:5501`, `:9400`, `:9579` |
| No cycles | `wouldCreateReportsCycle` `shared/teamHierarchy.ts:65-80` (hop-budgeted, fails closed) at `routes.ts:5214`, `:9500`, `:9583` |
| Same-org validation | Tenant-scoped roster lookups `routes.ts:5095`, `:5205`; every write is `WHERE id=? AND tenant_id=?` (`server/storage.ts:4188-4196`); tenant never client-settable (`routes.ts:5103-5104`, allowlist `:5181-5183`) |
| DB transaction | `rawDb.transaction(...).immediate()` at `routes.ts:5106`, `:5247-5293`, `:5416-5436`, `:5474`, `:5516-5530` |
| Confirmation screen | Offboard dialog `client/src/pages/Team.tsx:921-981` previews the blast radius (*"N direct reports re-homed → will report to X"*, `:944-961`) before mutating |
| Anti-poaching between manager branches | `branchOwnerOf` `shared/teamHierarchy.ts:154-170` → `actorMayReachBranch` `routes.ts:5346-5352`, enforced on target **and** destination (`:5150-5158`), offboard (`:5406`), delete (`:5510`) |
| Immutable sponsor edge (spec's `sponsor_id`) | `recruited_by_member_id` `shared/schema.ts:325-330` + **DB trigger** `trg_team_members_recruiter_immutable` `server/storage.ts:2440-2444`; deliberately excluded from the insert schema so `POST /api/team` cannot forge it (`shared/schema.ts:339-341`) |

**Self-healing on both edges of a role change** is better than the spec describes: demotion re-homes now-invalid reports (`routes.ts:5256-5264`); promotion clears a supervisor the member outgrew (`:5277-5290`) — with the rationale recorded inline that the stale inverted edge let a team lead *below* a promoted manager collect overrides.

**[resolved]** `created_at` **does exist** on `team_members` (`shared/schema.ts:337`, DDL `server/storage.ts:536`). Only `updated_at` is absent. **[resolved]** `bulkAssignUsers` **exists** — `hierarchy.downlineIds[]` on `PATCH /api/onboarding/applications/:id`, validated per member (`routes.ts:9226-9229`, `:9382-9422`), applied with a fresh per-iteration cycle check (`:9569-9601`), audited with exact moved ids (`:9594-9596`), with a real checkbox multi-select at `client/src/pages/Applications.tsx:884-905`. It is reachable **only at hire-approval time**.

## 1.2 RBAC — a named-capability model, not role strings

- 42-capability union `shared/capabilities.ts:14-60`; role sets built as **unions of the tier below** (`:64-128`); `can()` fails closed on unknown role (`:178-181`).
- One implementation shared by server and client: `requireCapability` `server/routes.ts:480-495` (logs `permission.denied`, 403s with `{need}`) and `useCan()` `client/src/lib/capabilities.ts:12-15` import the **same** `can`.
- Governance metadata already exists: 12 domains + 21 high-risk capabilities (`shared/capabilities.ts:198-257`) with a matrix UI at `routes.ts:10460-10495`.
- Tenant predicate `server/tenantGuard.ts:9-52` (`sameTenant` / `sameTenantWrite` / `sameTenantRead`), 25 call sites.
- Cross-tenant grant is the **immutable** `users.is_super_admin` column (`server/storage.ts:556`), stamped at boot, never derived from the editable email — closing a real self-promotion P0 (`routes.ts:10622-10624`).
- Regression suites: `tests/integration/tenant-isolation-audit.test.ts` (adjacent org ids), `rbac-audit.test.ts`, `manager-branch-authority.test.ts`, `sec-a-authz-hardening.test.ts`; unit `tests/unit/capabilities.test.ts`, `tenant-guard.test.ts`.

## 1.3 Rep commission engine — versioned, effective-dated, idempotent, lockable

- **Versioned plans with immutable snapshots**: `commission_plan_versions.rules_snapshot` written by the single writer `addPlanVersion` (`server/commissionService.ts:526-574`) inside one transaction; `UNIQUE(plan, version_number)` `storage.ts:948`. A rate change **mints a new version** (`getOrCreateFlatVersion` `:982`, `getOrCreateCustomTieredVersion` `:999`).
- **Effective-dated assignment with no overlaps**: `rep_commission_assignments` + `assignmentsOverlap` → `OVERLAPPING_PLAN_ASSIGNMENT` 409 (`commissionService.ts:145-159`, `:587-608`).
- **Idempotent ingestion**: `UNIQUE(tenant_id, external_id)` `storage.ts:957`; field sales key on `lead:<leadId>` (`commissionService.ts:1131`) so one door = one row.
- **Statement lock**: recalculation of FINALIZED/PAID throws `STATEMENT_LOCKED` (`:353-358`); FINALIZE freezes `contributing_sales` + `contributing_overrides` (`:816-869`); the only post-lock movement is an append-only, reason-mandatory adjustment against the frozen gross (`:684-762`).
- **Historical preservation is proven, not asserted**: `tests/integration/commission-pipeline.test.ts:303` (plan edit does not rewrite a booked commission), `commission-service.test.ts:362/384/569` (retroactive clawback, restore, post-finalize reversal → exception).

## 1.4 Override ledger — this is already the spec's per-recipient immutable ledger

`commission_overrides` (`server/overrideStore.ts:50-74`) satisfies most of the spec's ledger requirement **for uplines**, with DB-enforced immutability that exceeds it:

- `trg_cov_no_delete` (`:87-88`) aborts every DELETE; `trg_cov_frozen` (`:90-98`) aborts any UPDATE touching sale/beneficiary/role/level/entry_type/pair_seq/basis/amount_cents/rate_snapshot/chain_snapshot.
- Spec field mapping already satisfied: `sale_id` (`:53-54`), `recipient_role` → `beneficiary_role` (`:57`), `commission_basis` → `basis` (`:61`), `calculated_amount` → `amount_cents` (`:62`, signed), `hierarchy_path_at_sale` → `chain_snapshot` (`:64`, full walked chain with per-node `awardedCents` + typed `skipReason`, `shared/commissionOverrides.ts:126-130`), `status` (`:66`).
- **Idempotent per recipient**: `UNIQUE(tenant_id, source_ref, beneficiary_rep_id, pair_seq)` `:75-76` with strict EARN/CLAWBACK pair alternation.
- **Clawbacks preserve history**: a claw copies the earn's `rate_snapshot`/`chain_snapshot` by subselect (`:270-271`); a claw against a SETTLED earn books `EXCEPTION`/`OVERRIDE_REVERSED_AFTER_FINALIZE` and never mutates the finalized statement (`:251-253`).
- **Single payment rail**: overrides fold into `commission_statements.final_commission_cents` (`commissionService.ts:427-431`) so they ride the existing statement → NACHA → 1099 → reserve rails.

**[resolved — important]** The claim that "only reps get statements" is **false**. `commission_statements` is keyed per **team member of any role**; `managerHasPayableSurface` (`commissionService.ts:1310-1323`) admits a manager to the week if they have override ledger rows, and `tests/integration/override-pipeline.test.ts:107-113` asserts a team-lead statement at `override_pay_cents === 2500` and a manager statement at `final_commission_cents === 7500`. **A team lead and a manager already get their own statement and can already download their own PDF.**

**[resolved]** The missing-upline policy **is explicit**, not implicit: *"Missing slot = house keeps it"* (`shared/commissionOverrides.ts:14-16`, restated `:133-135`), implemented as a typed per-node `skipReason` frozen into `chain_snapshot`, tested at `tests/integration/override-pipeline.test.ts:115`.

## 1.5 Statements + PDF — server-side, scope-enforced, screen/paper parity

- One assembled document, two renderers: pure builder `shared/commissionStatement.ts:188-277` → `server/commissionStatementDoc.ts:61-143` → JSON route `commissionRoutes.ts:526` (consumed by `client/src/components/CommissionStatement.tsx:71`) and PDF `:533`.
- PDF sections present: statement id + status (`commissionStatementPdf.ts:104`), period (`:102`), issued stamp + calculation version footer (`:292-295`), net-pay hero (`:109-126`), paginating sale-level table with date/address/reference/house/commission (`:128-198`), "not counted" section (`:200-207`), money summary (`:209-237`), holdback panel (`:239-264`), adjustments (`:267-279`).
- **Authorization is single-gated**: `loadDocument` (`commissionRoutes.ts:514-524`) serves both JSON and PDF — 404 cross-tenant, 403 out-of-scope — proven at `tests/integration/commission-statement-doc.test.ts:117-128`. Download is audited (`:541-542`) and rate-limited (`server/index.ts:507`).
- A finalized statement re-prints from the **frozen** `contributing_sales` (`commissionStatementDoc.ts:73-80`).
- **[resolved]** A rep-facing re-downloadable archive **exists**: `listStatements` (`commissionService.ts:766-775`) → `GET /api/commission/statements` → `client/src/pages/MyCommission.tsx:107` → per-row PDF.

## 1.6 Test and migration idiom

- All 142 `tests/integration/*` files use `mkdtempSync` DATA_DIR or `:memory:` — zero exceptions.
- The house **forbids wall-clock perf assertions** and asserts mechanism instead: `EXPLAIN QUERY PLAN` names the index (`tests/integration/map-cold-open-window.test.ts:198-214`, 61k leads seeded) and query counts are bounded (`incentive-perf.test.ts:135`). Rationale at `incentive-perf.test.ts:10-14`. Measured numbers live in the index's source comment (`storage.ts:880-888`).
- Migrations: one idempotent `runMigrations()` array (`storage.ts:524`, executor `:2721-2727`), plus the stricter transactional precedent at `server/calling/migrations.ts:10-11` which **aborts boot** on failure.

---

# 2. WHAT IS INCOMPLETE

## 2A. LIVE DEFECTS IN SHIPPED CODE — fix regardless of any spec decision

These are not spec gaps. I verified each by reading source. Ranked by money/security exposure.

### P0-1 — `upsertSale` lets an API caller re-attribute a QUALIFIED sale
`server/commissionService.ts:620-627`:
```
ON CONFLICT(tenant_id, external_id) DO UPDATE SET
  rep_id = excluded.rep_id, status = excluded.status, sold_at = excluded.sold_at, ...
```
The three anti-gaming guards (credit-conflict block, correction-window clamp, locked-week PENDING guard) live in `recordFieldSaleFromKnock` (`:1143-1195`) — **not** in `upsertSale`. `POST /api/commission/sales` (`commissionRoutes.ts:314-317`) calls `upsertSale` directly. A `commission.sales.write` holder can re-POST the same `externalId` with a different `repId` or an earlier `soldAt` and silently move credit and pay-week, re-pricing **both** reps' retroactive tiers. Only trace is a `commission_sale.upserted` log line.
**Delta:** move the three guards into `upsertSale`, or have the route call a guarded wrapper. Test in the style of `commission-service.test.ts:417`.

### P0-2 — `promoteReleasedHolds` can silently strand money in a locked week
`server/overrideStore.ts:307-317` flips HELD→PAYABLE into `weekStartOf(hold_payable_after)` **with no statement-status probe** — contrast the EARN path 12 lines up (`:218-235`) which probes and books `LOCKED_WEEK_EARN`/EXCEPTION. If the release week is FINALIZED/PAID: `calculateOrRecalculateStatement` throws `STATEMENT_LOCKED` (swallowed best-effort at `commissionService.ts:663-673`), `markWeekSettled` has already run, no EXCEPTION is booked, and **the upline is never paid** with nothing in the exceptions console.
**Delta:** copy the `uplineStmt` status probe from `:220-224` into `promoteReleasedHolds`; book EXCEPTION with a `LOCKED_WEEK_RELEASE` reason. Test: hold released into a finalized week.

### P0-3 — Cancelling an organization revokes nothing
`tenants.status` exists (`shared/schema.ts:23`) and `DELETE /api/sa/tenants/:id` sets `"cancelled"` (`routes.ts:10811`), but **nothing reads it at request time**. I grepped every server file: the only reads are the audit payloads at `routes.ts:10692` and `:10817`, plus a revenue rollup filter. `otp/verify` checks only `user.active` (`:7118`); `requireAuth` checks only `user.active` (`:393`). Every user of a cancelled org keeps logging in indefinitely.
**Delta:** enforce in `requireAuth` (`:393`) so existing sessions die too, for `cancelled`/`suspended` **only** — do not touch billing state (the owner directive at `routes.ts:471-475` forbids billing gating, but `tenant_billing.state` is a different column). Mirror the training gate's fail-**open**-on-internal-error posture (`:415-418`) so a bug cannot lock out a whole floor mid-shift. Pair with a session sweep on the status flip.

### P0-4 — Manager money writes are effectively unscoped
`readScope` returns `{repIds: null}` for anyone with `commission.read.all` (`commissionRoutes.ts:27`) — which managers hold. `canReadRep` therefore returns `true` for **every rep in the tenant** (`:46-49`), making `denyOutOfScope` (`:141`) a no-op for exactly the role holding `sales.write` / `adjustments.write` / `statements.write`. Manager A can book a sale, file an adjustment, and recalculate a statement for manager B's rep (`:315`, `:322`, `:333`, `:567`). The only mitigation is the self-deal guard (`:152-157`), which blocks writing your *own* commission, not a peer's rep.
Exactly one route closes this correctly and its comment names the hole: `PATCH /commission/reps/:repId/override-rates` re-derives `branchOwnerOf` explicitly (`commissionOverrideRoutes.ts:258-274`).
**Delta:** apply that same branch re-derivation to the other five money-write routes.

### P1-5 — The statement PDF does not add up for any upline
`earnedCents = hourly + gross + adjustments + **overrides** + spiffs` (`shared/commissionStatement.ts:232`), and the doc exposes `totals.overrideCents` (`:245-246`) — but `server/commissionStatementPdf.ts:215-221` has **no Overrides row** (grep for "override" in that file: zero hits). A manager whose week is all override money sees *"Commission on sales $0.00"* and *"Earned this period $300.00"* with an unexplained delta on a pay document. The payroll CSV already carries the column (`commissionRoutes.ts:450`).
**Delta:** one row in the `rows` array, mirrored in `client/src/components/CommissionStatement.tsx:137-142`. Latent only while override rates are $0 — it goes live the moment any tenant sets a rate.

### P1-6 — A pure supervisor reassignment writes no audit row
`routes.ts:5296-5311` logs only when `emailRetargeted` **or** `safeUpdate.role !== existing.role`. A `PATCH /api/team/:id {reportsToId: X}` moves a person between branches and writes **nothing**. Compounding: member CREATE (`:5075-5115`) writes no audit row at all; offboard/delete record only a **count** (`:5440`, `:5534`), never which members moved or from where; and every audit write sits **outside** the transaction (`:5299/5306` after `.immediate()` at `:5293`).
**Delta:** log `team.member.supervisor_changed {from,to}` on every `reportsToId` write; replace counts with moved-id arrays; move `logActivity` inside the transaction.

### P1-7 — `PATCH /api/users/:id` is an unguarded second role door
`routes.ts:7240-7315`: admin-only, allowlists `role`, validates against `LOGIN_ROLES` only (`:7294-7296`) — **no** hierarchy check, **no** branch check, **no** cycle/supervisor revalidation, **no** transaction, **no** audit row for the role change, and **no mirror back to `team_members.role`**. It can desync exactly the pair `effectiveMemberRole` (`:5359`) exists to reconcile.
**Delta:** refuse `role` on this route when `teamMemberId != null` and redirect to `PATCH /api/team/:id`. One door for role changes — this is also the precondition for a trustworthy hierarchy-history table.

### P2-8 — Branch guard missing at two write sites
`POST /api/team` (`routes.ts:5075-5115` — verified: validates supervisor tenant/active/rank at `:5094-5102`, never calls `actorMayReachBranch`) lets a manager create a member reporting **into a peer manager's branch**. `POST /api/team/:id/reactivate` (`:5456-5488`) checks scope and rank but not branch, unlike its offboard twin.

### P2-9 — Cycle guard absent at four of seven `reports_to_id` write sites
Called at `routes.ts:5214`, `:9500`, `:9583`. **Not** called at the demotion re-home loop (`:5261`), the offboard bulk re-home (`:5427-5429`), the delete bulk re-home (`:5517-5519`), or `POST /api/team` (`:5094` — genuinely safe, a new row has no subordinates). The re-homes only move children *up* to an existing ancestor, so a new cycle requires a pre-existing corrupt chain — but nothing detects or refuses that chain, and there is **no DB-level constraint** on `reports_to_id` (only the recruiter trigger exists, `storage.ts:2440`). No integration test asserts `REPORTS_TO_CYCLE` over HTTP — grep across `tests/` returns zero hits.

## 2B. SPEC DELTAS ON EXISTING SURFACES

| # | Requirement | What exists | Precise delta |
|---|---|---|---|
| 10 | `promoteUser(userId, newRole, assignmentOptions)` | Generic `PATCH /api/team/:id` accepting `role` alongside name/phone/email (`routes.ts:5116-5316`); guarded, audited, transactional, self-healing both directions | No named op, no `assignmentOptions`, **no confirmation step** — the client sends role in one blob with name/phone/email (`Team.tsx:1027-1031`). Caller cannot say where the promoted member or their orphaned reports land; server picks unilaterally. Promotion to manager **always** lands top-level by construction (`:5275-5276`) |
| 11 | `removeUserFromHierarchy(userId, reassignmentPlan)` | `POST /:id/offboard` and `DELETE /:id`; both re-home, disable login, revoke sessions, refuse last-admin orphan | **Neither route reads `req.body` at all.** Re-homing is a hard-coded `UPDATE ... SET reports_to_id = <departing member's own supervisor>` (`:5427-5429`, `:5517-5519`). Offboarding a **top-level** manager silently scatters their whole team to top-level/unowned, where `actorMayReachBranch` then treats them as adoptable by any manager (`:5346-5352`) |
| 12 | Audit rows immutable/append-only | A purpose-built append-only `admin_audit` with UPDATE/DELETE `RAISE(ABORT)`, before/after JSON, actor, request id, IP (`server/adminAudit.ts:30-76`) **exists** | **No hierarchy operation uses it.** All 15 `recordAdminAudit` sites are territory/billing/tenant/ops. Team ops go to `activity_log`, which I verified has **no triggers** (`storage.ts:576`, `:692`, `:908-909` — DDL and indexes only) and a free-form JSON `details` blob |
| 13 | One downline-scope rule | Two resolvers | They **disagree**: `leadVisibilityScope` gives a team_lead **one level** (`routes.ts:508-515`); `readScope` gives the same team_lead the **full subtree** (`commissionRoutes.ts:31-41`). A team lead can read a grandchild's statements and override sheet but not their leads. No test pins them against each other |
| 14 | Manager sees their **branch** | Manager reads are **tenant-wide** on every plane (`routes.ts:506` → `undefined`; `commissionRoutes.ts:27` → `null`) | `branchOwnerOf` is applied to **writes only**. Manager A reads manager B's entire branch — leads, statements, payroll CSV, and (once rates are live) B's personal override earnings |
| 15 | Effective-dating on plan rules | `commission_plan_versions.effective_from/to` exist and are populated (`schema.ts:729-730`, written `commissionService.ts:559-561`) | **Never read for resolution.** The version is fetched purely by id off the assignment (`:400-402`); only `rep_commission_assignments` dates are filtered. A version dated 2027 will price a 2026 week |
| 16 | Sale lifecycle state machine | Statuses exist; `transitionSale` flips in place, never deletes (`commissionService.ts:635-674`) | **No state machine, no optimistic concurrency.** Any action is legal from any status: REVERSED→QUALIFY resurrects; a second REVERSE re-stamps `reversed_at` (which the exception detector keys off, `:1416-1425`). The legacy plane has a full pure machine with `expectedStatus`/`STALE_VERSION` (`shared/legacyCommissionLifecycle.ts:51-56`) — the new engine got none of it |
| 17 | Hierarchy ops gated by a named capability | All roster mutations sit behind **role-string** middleware `requireTeamLead` (`routes.ts:447-454`) | No `hierarchy.manage` / `user.promote` capability, so the Governance matrix cannot answer *"who may reorganize the org?"* — the exact surface the promotion wizard must gate on |
| 18 | Every declared capability enforces something | 42 declared | **7 enforce nothing**: `lead.read.assigned`, `lead.read.all`, `lead.reassign`, `audit.read.team`, `dashboard.read.self/team/org`. They render in the Governance UI as real grants, overstating what is enforced |
| 19 | Org hierarchy tree + table UI | `client/src/pages/Team.tsx` — three **flat** role-grouped card lists (`:544-720`) | No tree, no nesting, no expand/collapse, no search input, no role/status filter, no total-downline count (only direct, `:493-501`), no earnings column, no checkbox/bulk action, no pagination — it fetches all of `/api/team` and renders every row behind CSS `content-visibility` alone (`:590`) |
| 20 | Statement as an addressable page | Full-bleed **modal** opened from local state (`CommissionStatement.tsx:38-55`) | No `/statements/:id` route in `App.tsx:219-381` — cannot be linked, bookmarked, or deep-linked from a notification |
| 21 | Audit history on a user profile | Complete feed component `client/src/components/AdminHistory.tsx:125-200` with before→after diffs | Mounted in **exactly one place** — `SuperAdmin.tsx:410`, gated to `isSuperAdmin`. A tenant admin has **no audit UI at all**. No `targetType`/`targetId` filter, so per-person history cannot be rendered even if mounted |
| 22 | Plan version on the statement | Columns `commission_plan_version_id`, `plan_version_number`, `plan_snapshot` are **written** (`storage.ts:964`) | Never read into the document — `StatementDocInput.statement` (`shared/commissionStatement.ts:64-71`) omits them and the assembler (`commissionStatementDoc.ts:103-110`) never selects them. Purely additive to fix |
| 23 | Org logo on the PDF | `brandLogo()` embeds `hfs-logo.png` from the client bundle (`commissionStatementPdf.ts:29-44`) | It is the **HomeFront product wordmark**, not the tenant's. `tenants.brand_logo` exists (`schema.ts:15`), is admin-editable (`routes.ts:10765`), and is read by neither renderer. Every tenant's statement prints their own company name beside HomeFront's mark |
| 24 | `GET /users/:id/commission-summary` and `/downline-earnings` | Overlapping surfaces exist: `/api/commission/statements?repId=`, `/statements/me/current`, `/week-overview`, `/overrides/sheet?repId=`, `/overrides/sheet-export.csv` | Different path shape, keyed to `team_members.id` not `users.id`, gated on `commission.read.downline` rather than statement caps, and week-scoped only — no period range, no YTD. The only route literally named `/api/commissions/summary` (`routes.ts:10306`) belongs to the **legacy** plane and has no user path param |
| 25 | Percentage payouts | **[resolved]** Percentage **is** implemented in the legacy engine — `CalcType` includes `'percentage'` (`shared/commission.ts:11`), computed at `:52-53`, persisted (`storage.ts:659`), validated (`routes.ts:10380`), versioned on edit (`:10432`) | It is **starved of a basis**: `routes.ts:6169` hardcodes `const saleAmount = 0` (a deliberate P0 hardening so a client cannot supply its own payout basis), so a percentage plan books **$0.00** on knock-sales. `EarningsToday` refuses to estimate them (`server/earningsTodayStore.ts:196-208`). The weekly engine is flat/tier-only by design |
| 26 | Perf at scale | One 61k-lead EXPLAIN suite + one bounded-query-count suite | **Every perf test is on the lead/map path.** Nothing at scale touches commissions, overrides, statements, or hierarchy. Largest commission fixture is **8 sales** (`commission-service.test.ts:74`). No EXPLAIN assertion on any `commission_*` or `team_members` query |
| 27 | Indexes for the hot paths | | I verified against source: `team_members` has **exactly one** index — `(tenant_id, name)` (`storage.ts:1012`). Nothing on `reports_to_id`, `(tenant_id, active)`, `(tenant_id, role)`, `recruited_by_member_id`. `commission_sales` has **no `lead_id` index**, yet the FCC-purge predicate runs `NOT EXISTS (SELECT 1 FROM commission_sales cs WHERE cs.lead_id = l.id)` once per candidate over a 100k+ lead table (`storage.ts:4028`) — the sibling `commissions.lead_id` predicate on the line above **is** covered |
| 28 | Coherent migrations story | Three mechanisms coexist: `drizzle.config.ts` (`out: ./migrations`), the `runMigrations()` array, and 18 per-module `ensure*Schema()` | I verified: `migrations/` contains **one orphaned 43KB file**, `20260714_calling_compliance.sql`, and **nothing reads it** (that schema was re-implemented at `server/calling/migrations.ts`). `drizzle-kit push` is never run in CI (`.github/workflows/ci.yml:41-45` runs only `npm test` and `npm run build`). There is **no versioned migration history** |
| 29 | Percent/tiered override rates | Type union and `*_bp` config columns exist (`shared/commissionOverrides.ts:23`, `storage.ts:2706-2707`) | Flat-only in execution; `validateOverridePatch` hard-refuses PERCENT (`:200-202`). The two `_bp` columns are **dead** — they appear only in their own CREATE statements. No tiering, no level-3+, no compression |
| 30 | Hierarchy perf | Every downline loads the **entire tenant roster** into JS per request (`commissionRoutes.ts:33`, `overrideStore.ts:194-202` — reloaded **on every sale**), rebuilding the child index from scratch each call | Only territory scope is memoised. `downlineOf`'s `maxNodes=5000` **silently truncates** rather than erroring (pinned as intended at `tests/unit/commission-overrides.test.ts:51`) |

---

# 3. WHAT IS GENUINELY MISSING (build from scratch)

### 3.1 `user_hierarchy_history` — the single biggest structural gap
Zero hits for `hierarchy_history` / `effective_from` on any hierarchy table across `server/`, `shared/`, `client/`, `tests/`. Effective-dating exists **only for money** (`storage.ts:661`, `:947`, `:953`, `schema.ts:685-686`, `:729-730`, `:757-758`).

Today hierarchy history exists in two degraded forms: frozen per-sale onto `commission_overrides.chain_snapshot` (only where a qualified sale happened), and *in principle* reconstructable from `activity_log` — except that reconstruction is **impossible** because supervisor-only changes are never logged (§P1-6) and offboard/delete log only a count. **There is no way to answer "who did rep #7 report to on 2026-03-14" for any week without a sale.**

Build as append-only beside `admin_audit` (`server/adminAudit.ts:30-76` is the template, `RAISE(ABORT)` triggers included), written inside the same `rawDb.transaction` as every `reports_to_id`/`role` write. Indexes: `(tenant_id, user_id, effective_from DESC)`, partial `(tenant_id, user_id) WHERE effective_to IS NULL`, `(tenant_id, manager_id, effective_from)`. **Prerequisite: §P1-7** (one door for role changes) or the table will be incomplete by construction.

### 3.2 A reassignment **plan** parameter on demote/remove
Add `{ reassignTo, perMember?, reason }` to the offboard/delete bodies, validated through the same tenant+rank+branch+cycle gauntlet as `routes.ts:5200-5217`. The UI already computes and displays the affected count and names (`Team.tsx:947-960`) — the dialog is one dropdown away from being a plan.

### 3.3 Promotion wizard UI
Grep for `promot|wizard|step|effectiveDate` across `client/src/` → zero hits outside CSS/comments. The only role-change UI is the inline `RolePicker` (`Team.tsx:106-149`) saved with the name/phone/email blob. No confirm, no diff, no downline handling, no effective date, no pay preview — **even though changing a role silently changes who earns overrides on that person's sales.** Pattern to copy: the offboard dialog (`:921-981`) plus the console's `blockedReason` grammar (`:1401-1405`).

### 3.4 User Profile screen (spec Screen 2)
`client/src/pages/Profile.tsx` is **self-only settings** (166 lines, no `:id` param). No `/users/:id`, `/member/:id` or `/team/:id` route exists — `/users` is a hard redirect to `/team` (`App.tsx:360-362`). Reuse rather than rebuild: `CommissionStatement.tsx`, `DownlineSheet.tsx`'s rollup, `AdminHistory.tsx` (needs a target filter prop), and the `ROLES` badge map exported at `Team.tsx:32-66`.

### 3.5 Org hierarchy tree rendering
No virtualization library is installed; the only `aria-expanded` uses are one-level accordions. No client file imports `downlineOf`. Build as a second view mode in `Team.tsx` (data is already loaded) and reuse `shared/teamHierarchy.downlineOf` so client and server agree on totals.

### 3.6 Bulk select + bulk reassign on the roster
`components/ui/checkbox.tsx` exists but `Team.tsx` has no selection state. Server-side, the bulk primitive exists at hire-approval (`routes.ts:9569-9601`) — it needs a roster-level door. Precedent for batch + review + confirm: the payout batch (`CommissionConsole.tsx:1037-1198`).

### 3.7 Missing indexes
`CREATE INDEX idx_sales_lead ON commission_sales(lead_id)` — two real callers scan on it today (`storage.ts:4028` FCC purge, `:3147` canonical-merge repoint). Pin with an EXPLAIN assertion in the `map-cold-open-window.test.ts:198-204` style. `team_members(reports_to_id)` is worth adding **only together with** a SQL-side traversal — see §4.5.

### 3.8 Filters on the commission dashboard
Week stepper only (`CommissionConsole.tsx:81`, `:133-152`). No date range (the leaderboard has one at `Leaderboard.tsx:115` that these screens don't reuse), no manager/team-lead/rep filter, no provider or product dimension anywhere in the client, no status filter (statuses are display-only chips). No `disputed` state in any UI.

### 3.9 Generated-statement provenance
Nothing about the generated PDF is persisted — bytes are streamed and discarded (`commissionRoutes.ts:537-546`). Two downloads of the same FINALIZED statement carry **different** "Issued" footers (`commissionStatementPdf.ts:293`), so a rep's saved PDF cannot be matched to a server record. The pattern exists and was simply not applied here: onboarding stores `completed_pdf BLOB` + `completed_pdf_sha256` with an immutability trigger (`storage.ts:1382-1383`, `:2665-2681`).

### 3.10 Statement email delivery
`server/mail.ts` exports only the shell helpers (`:29-159`); no statement template. `renderCommissionStatementPdf` has exactly one caller.

---

# 4. ARCHITECTURAL CONFLICTS
*Ranked by blast radius on live money.*

## 4.1 ⛔ HIGHEST — Per-sale rep ledger vs. retroactive weekly tiering

**Spec wants:** an immutable per-sale row for the **rep**, created **at sale time**, storing `rate`, `calculated_amount`, `hierarchy_path_at_sale`, `status`, `paid_at`.

**Code does:** a rep's per-sale amount **does not exist and is not knowable at sale time**. The week's total qualified count selects ONE tier whose rate applies to **every** sale that week: `gross = count × tier.rateCents` (`shared/commissionTiers.ts:127`, `commissionService.ts:194-206`). The count is a live `COUNT(*)` recomputed on every knock, transition and adjustment (`:247-292`). The per-door figure on a statement is an **allocation** of the week's gross computed at render time — `allocateCents` floors an even share and spreads the remainder over the leading doors (`shared/commissionStatement.ts:161-169`).

**Documented rationale:** `shared/commissionTiers.ts:1-6` (*"NOT progressive"*) and `shared/commissionStatement.ts:12-16`, which states outright that the column is an allocation of gross, not a re-derivation, and that *gross ÷ sales is the only honest per-door number*. The 8th sale of a week re-prices sales 1–7. Writing an immutable per-sale amount at sale time means writing a number **guaranteed wrong for most of the week**. The immutability unit was therefore deliberately chosen as the WEEK.

**Recommendation: materialize per-sale rep rows AT FINALIZE**, from the same `allocateCents` split already used for rendering, alongside the existing `contributing_sales` snapshot. This yields `sale_id`/`recipient`/`rate`/`calculated_amount`/`paid_at` with an accurate rate, costs nothing at knock time, changes no money, needs no migration of existing statements, and the allocation function is already unit-tested (`tests/unit/commission-statement-document.test.ts`). **Reject** writing mutable per-sale rows at sale time — "immutable ledger" would become "immutable after Sunday", and re-issuing EARN/CLAWBACK pairs on every tier change is enormous write amplification that the pair-alternation invariant would have to survive N times per week.

## 4.2 ⛔ HIGH — Total commission pool vs. two independent additive engines

**Spec wants:** a configurable pool per sale (`$300 = rep $200 + TL $25 + mgr $75`), validated so allocations never exceed it.

**Code does:** rep pay and upline pay are two ledgers that **never see each other's numbers and share no budget**. Rep pay = weekly tier rate × count. Upline pay = flat per-sale cents per slot (`commissionService.ts:107-110`), appended to `commission_overrides`. Nothing sums them; nothing bounds either. The import direction is one-way — `commissionService` imports `overrideStore`, never the reverse (`overrideStore.ts:12-15`) — which **structurally prevents** the override layer from consulting the rep's tier rate.

**Documented rationale:** `shared/commissionOverrides.ts:9-11` (*"a SEPARATE additive layer on top of the rep's own commission engine. The rep's pay is untouched; uplines earn on top"*) and `shared/schema.ts:696-702` (*"DELIBERATELY ISOLATED"*). The UI says the same to operators: `OverrideConfigCard.tsx:91-95` promises overrides pay the upline *"on top of the seller's own commission, never out of it."* Structurally, a per-sale pool **cannot** be validated at sale time here: the rep's slice is unknown until the week closes, so `rep + TL + mgr ≤ pool` has no evaluable left-hand side on the day of the sale.

**Recommendation: validate the pool at CONFIG time, not sale time.** A pure validator in `shared/` beside `validateOverridePatch`, called from `updateOrgConfig` (`commissionService.ts:882-884`) where both plan versions and override rates are reachable: reject a rate patch when `max_tier_rate + TL_cents + mgr_cents > pool_cents`, refused the way PERCENT already is (`tests/integration/override-pipeline.test.ts:255`). This delivers the spec's actual safety property — *payroll can never exceed what the sale is worth* — at the only moment all numbers are knowable, without touching a settled week. Optionally add a weekly assertion surfaced on the existing exception rail (`:1416-1498`). **Two hard constraints:** (a) do **not** repurpose `commission_house_amount_cents` as the pool — it is display-only revenue and several statement surfaces treat a missing value as "not configured", not "$0 of budget" (`commissionService.ts:885-889`, `shared/commissionStatement.ts:100-104`); (b) do **not** ship a pool-allocation builder while `OverrideConfigCard` promises overrides never come out of the rep's commission — the same admin would see two contradictory statements.

## 4.3 🔶 MEDIUM-HIGH — Three concurrent money planes on one sold door

**Spec wants:** ONE commission ledger.

**Code does:** three. (1) Legacy `commissions` — **dollar-denominated REAL** amounts, one row per lead, written at knock time (`routes.ts:6148-6186`), with its own `pending→approved→paid` machine and CAS concurrency. (2) The weekly engine — `commission_sales` + `commission_statements` in integer cents. (3) `commission_overrides`. They are **not merely parallel**: the weekly engine reads the legacy table to decide payability — `countQualifiedSales`'s install-hold overlay subqueries `commissions.status` and `commissions.payable_after` (`commissionService.ts:266-290`), as do `installHeldSalesForWeek` (`:304-320`) and `listWeekSalesForRep` (`:1636-1654`).

**Documented rationale:** the weekly engine was framed as a Phase-2 replacement *"DELIBERATELY ISOLATED"* from legacy (`schema.ts:696-702`), and legacy was left running rather than cut over. The install-hold coupling was added later because install confirmation is tracked on the legacy row (`schema.ts:625-632`) — which quietly made the "isolated" legacy table **load-bearing for new-engine money**.

**[resolved]** Note the legacy row **is** a real per-sale money row with `status` and `paid_date` (`schema.ts:606-634`) — it is not merely vestigial.

**Recommendation:** declare the weekly engine authoritative and demote legacy to install tracking — migrate `install_confirmed_at`/`payable_after` onto `commission_sales`, stop calling `storage.createCommission` at `routes.ts:6171`, keep legacy rows read-only for history. **Do this before building any new ledger**, or the new table inherits the ambiguity. Hard dependency: `countQualifiedSales`'s `forPay` path breaks if legacy rows stop being written, so the install columns must move **in the same change**.

## 4.4 🔶 MEDIUM — Separate `manager_id` / `team_lead_id` vs. single-parent tree

**Spec wants:** explicit `manager_id` and `team_lead_id` columns per user.

**Code does:** ONE parent edge `team_members.reports_to_id` (`schema.ts:301-303`). Manager and team lead are **derived** by walking upward — `shared/commissionOverrides.ts:103-111` finds the first active team_lead and first manager; `branchOwnerOf` walks to the owning manager.

**Documented rationale:** `shared/teamHierarchy.ts:1-9` and `:136-153`. A single parent makes cycle detection one upward walk, makes "whose people are these" answerable, and makes it **structurally impossible for `manager_id` and `team_lead_id` to disagree**. `branchOwnerOf` is deliberately not a subtree test because that *"strands every top-level member in nobody's territory"*; unowned fails **open** by design so orphans and new hires stay manageable. The client mirrors the same module so the UI *"never renders an action the API would refuse"* (`Team.tsx:101-103`).

**Recommendation: derive, don't denormalize.** Expose `manager_id`/`team_lead_id` as computed read-model fields (the walk already exists in two places; make it one shared helper), and **freeze the derived pair onto each ledger row at sale time** as `manager_id_at_sale`/`team_lead_id_at_sale` — which `chain_snapshot` already does and is the only correct place to denormalize. **Reject two writable columns**: they reintroduce exactly the bug `tests/integration/promotion-hierarchy.test.ts:158-184` was written to prevent (an inverted edge paying a team lead sitting *below* the promoted manager), because two independent columns can disagree and nothing walks a chain to catch it. Two independent pickers would also let the UI express states the tree cannot represent.

## 4.5 🔶 MEDIUM — Mandatory reassignment plan vs. auto-re-home invariant

**Spec wants:** a plan is MANDATORY on demote/remove; the operation refuses without it.

**Code does:** re-homing is automatic and unparameterized (`routes.ts:5256-5264`, `:5427-5429`, `:5517-5519`); the routes accept no body. The UI deliberately excludes lifecycle from the edit form (`Team.tsx:268-276`) and the offboard dialog *narrates* the server-decided outcome.

**Documented rationale:** `routes.ts:5252-5255` and `:5424-5426` — *"so the org chart never holds an invalid edge."* No write may leave the tree invalid: a demotion must not strand reps under a rep; an offboard must not strand reps under a deactivated member. Auto-re-home guarantees that with zero operator input; a mandatory plan makes correctness depend on an operator filling in a form, in a hurry, during a termination.

**Recommendation: keep auto-re-home as the DEFAULT; accept an OPTIONAL plan that overrides it**, validated through the same gauntlet as PATCH, sent in the same request so atomicity holds. This preserves the invariant (an omitted plan still cannot produce an invalid tree) while giving the spec's control, and it fixes the real complaint underneath: today, offboarding a **top-level** manager silently scatters their team to unowned, where any manager may then adopt them. **Making the plan mandatory is a regression.** Whichever way, log **which** members moved and where — the count-only payload is why this is currently unreviewable after the fact.

## 4.6 🔵 LOW-MEDIUM — `user_hierarchy_history` vs. freeze-onto-the-money-row

**Spec wants:** an effective-dated history table as the source of truth for historical hierarchy.

**Code does:** freezes the answer onto the money row — `chain_snapshot` + `rate_snapshot` (`overrideStore.ts:63-64`, `:210-228`), protected by trigger (`:90-98`); `plan_snapshot` + `contributing_sales` + `contributing_overrides` on statements.

**Documented rationale:** `shared/teamHierarchy.ts:94-98` — *"overrides are computed from this chain as it stands at sale time and frozen onto the ledger row; a promotion or re-home affects only future sales"*; `storage.ts:2714-2716` — *"so a locked week's drill-down stays truthful forever."* A locked week explains itself with **zero joins against mutable tables** — which a history join cannot guarantee, since a bug or backfill would retroactively change what a settled week says it paid. Pinned by `tests/integration/promotion-hierarchy.test.ts:183-201`.

**Recommendation: do BOTH — they are complementary.** Keep `chain_snapshot` authoritative for what a sale **paid**; add `user_hierarchy_history` as the authority for what the org **looked like**, which nothing can answer today for any period without a sale. Write the invariant into the table's DDL comment (house style, `storage.ts:2714`) that the history table is **never** consulted by `commissionService` or `overrideStore`, state it in `docs/COMMISSIONS.md`, and add a test asserting a hierarchy edit does not change any settled statement.

## 4.7 🔵 LOW — Two role fields; and `super_admin` is not an assignable role

`users.role` (login) and `team_members.role` (field) are reconciled by taking the **higher** (`routes.ts:5359-5364`) and synced by `syncLoginAccount` inside the `/api/team` transaction. Rationale at `:5318-5323`: a member row can read "rep" while its login is an admin, so authority must use the login's real power. **The model is defensible; the hole is §P1-7.**

Separately: the string `super_admin` is **never assignable** and never appears in a live row — the apex identity is `role:"admin"` + immutable `is_super_admin` (`routes.ts:10620-10628`), a deliberate P0 fix against email-based self-promotion. Consequently **every `role === "super_admin"` branch is dead code** (`routes.ts:506`, `:748`, `:441`, `:450`, `:460`, `:7136`; `tenantGuard.ts:33`). Two live consequences: a super_admin **403s on the tenant guard** before any role check on every `/api/team` write (`:5084`, `:5118`, `:5387`, `:5459`, `:5497`), and `HIRABLE_ROLES` has no `super_admin` row — while the approval route explicitly maps super_admin→admin for exactly this reason (`:9342`, `:9415`). `GET /api/auth/login-attempts:7136` silently scopes the platform owner to the default tenant. All fail **closed** (over-restrictive), so these are functionality bugs, not breaches.
**Recommendation:** replace the seven dead branches with one `isPlatformOwner(user)` helper (`routes.ts:10714` and `:10745` already do this correctly), and add the super_admin→admin normalization to `/api/team` so the two hire paths agree. **Reject** reintroducing `super_admin` as an assignable role — `role` is PATCHable and `is_super_admin` is not.

## 4.8 🔵 LOW — Inactive uplines still earn (spec would re-introduce a fixed bug)

`computeFlatOverrides` deliberately does **not** gate on `active`. Rationale at `shared/commissionOverrides.ts:138-149`: a genuinely departed leader is already out of every chain because offboard and delete re-home their reports, so the check never protected the case it was written for; the members it actually caught were **newly-approved hires sitting at `active=0` pending signatures whose downline was already selling** — *"the money for managing that team was quietly going to the house over signature timing."* Regression-tested at `tests/integration/override-pipeline.test.ts:353-359`.
**Recommendation:** amend the spec, not the code. Eligibility follows the reports-to chain; departure is handled by re-homing, not by the `active` flag.

**Also correct the spec's premise:** overrides do **not** ship dark behind `commission_override_enabled` — that flag `DEFAULT 1` (`storage.ts:2702`). What is dark is the **money**: both rate columns default to 0 and a $0 slot pays nobody, so no payroll changes until someone sets a rate (`:2696-2701`). The flag is a kill-switch, and it is consulted **only on the earn path** (`overrideStore.ts:192-193`), never on clawback — *"money already earned must still reverse correctly after the feature is switched off."*

---

# 5. THE SINGLE BIGGEST DECISION

> ## Does the rep's per-sale commission amount have to be knowable and immutable **at the moment of sale**?

Everything else in this report is downstream of this. The spec's ledger, its pool split, its `basis_amount`/`rate` columns, and its sale-time validation all presuppose "yes." The engine presupposes "no."

### Option A — **NO. Keep retroactive weekly tiering.** (recommended)
The week's count picks one rate that re-prices every sale in that week. Per-sale immutability is achieved **at FINALIZE**, not at sale time.

- ✅ Zero money-behaviour change. No migration of existing statements. No re-pricing of settled weeks.
- ✅ Preserves the retroactive clawback semantics tested at `commission-service.test.ts:362`, the `allocateCents` re-summing invariant, and the tier-progress nudge the field UI is built around (`shared/commissionTiers.ts:157-167`).
- ✅ Spec's per-recipient ledger is still delivered — as a FINALIZE-time materialization (§4.1) plus the already-existing `commission_overrides` for uplines.
- ❌ The pool can only be validated at **config** time, not per sale (§4.2). You must tell the spec's owner that "allocations never exceed the pool" becomes a plan-edit-time guarantee, not a sale-time one.
- ❌ `basis_amount`/`rate` per rep row remain derived, and percentage-of-deal-value stays unavailable in the weekly engine.

### Option B — **YES. Move rep pay to per-sale rates.**
Progressive or flat per-sale rates, knowable at booking.

- ✅ The spec becomes literally implementable: true sale-time pool split, per-sale `rate`/`basis_amount`, one uniform ledger for rep and uplines.
- ❌ **This is a compensation-policy change, not an engineering one.** Every rep's pay curve changes; the retroactive promise ("hit 8 sales and *all eight* pay at the higher rate") is the product's core pay promise, documented in `docs/COMMISSIONS.md`.
- ❌ Invalidates `tests/unit/commission-tiers.test.ts`, the clawback semantics at `commission-service.test.ts:362-384`, and the field UI's tier-progress nudge.
- ❌ Requires migrating or dual-running against every historical statement, and a decision on what happens to reps mid-week at cutover.

**Recommendation: Option A**, with the pool validated at config time and the spec amended to say so. Option B should only be chosen by whoever owns the compensation plan, not by engineering — and if chosen, the sequencing below changes materially from WP-6 onward.

---

# 6. SEQUENCED BUILD PLAN

**Everything in Phase 0 and Phase 1 is INDEPENDENT of the §5 decision and can start today.** Only WP-11 through WP-14 depend on it.

## Phase 0 — Live defects (start immediately, in parallel)

| WP | Work | Files | Risk | Deps |
|---|---|---|---|---|
| **WP-1** | Guard `upsertSale`: move the credit-conflict, correction-window and locked-week guards out of `recordFieldSaleFromKnock` into `upsertSale` (or a wrapper the route calls) | `server/commissionService.ts:611-631`, `:1143-1195`; `server/commissionRoutes.ts:314-317`; new test beside `commission-service.test.ts:417` | 🔴 **money-affecting** (closes a re-attribution hole) | none |
| **WP-2** | Locked-week probe in `promoteReleasedHolds`; book EXCEPTION `LOCKED_WEEK_RELEASE` | `server/overrideStore.ts:307-317` (copy the probe from `:220-224`); test in `override-pipeline.test.ts` | 🔴 **money-affecting** (stops silent non-payment) | none |
| **WP-3** | Enforce `tenants.status` in `requireAuth` for `cancelled`/`suspended` only; fail **open** on internal error; sweep sessions on status flip | `server/routes.ts:393`, `:10808-10817` | 🟠 **access-affecting** — confirm with the owner first; a bug locks out a whole org mid-shift. Do **not** touch `tenant_billing.state` | none |
| **WP-4** | Scope manager money writes: apply `branchOwnerOf` re-derivation to the five write routes that lack it, copying `commissionOverrideRoutes.ts:258-274` | `server/commissionRoutes.ts:141-158`, `:315`, `:322`, `:333`, `:567` | 🟠 **restricts existing behaviour** — audit current usage before shipping | none |
| **WP-5** | Add the Overrides row to the PDF and the on-screen statement | `server/commissionStatementPdf.ts:215-221`; `client/src/components/CommissionStatement.tsx:137-142`; test asserting rows sum to `earnedCents` | 🟢 additive (display) | none |

## Phase 1 — Audit and integrity foundation (independent of §5)

| WP | Work | Files | Risk | Deps |
|---|---|---|---|---|
| **WP-6** | **One door for role changes.** Refuse `role` on `PATCH /api/users/:id` when `teamMemberId != null`; redirect to `PATCH /api/team/:id` | `server/routes.ts:7294-7296` | 🟢 additive-safe (refusal) | none |
| **WP-7** | **Complete the audit trail.** Log `team.member.supervisor_changed {from,to}`; log member CREATE; replace count-only payloads with moved-id arrays; move every `logActivity` **inside** the transaction; route hierarchy events to `admin_audit` (append-only, before/after) instead of `activity_log` | `server/routes.ts:5075-5115`, `:5293-5312`, `:5436-5441`, `:5531-5534`; `server/adminAudit.ts` | 🟢 additive-safe | WP-6 |
| **WP-8** | **Consolidate the guard stack** into `authorizeHierarchyChange(actor, targetId, {newRole, newSupervisorId})` in `shared/`, returning a typed refusal. Add the missing `actorMayReachBranch` on `POST /api/team` and `/reactivate`; add cycle checks to the three re-home sites; add `hierarchy.manage` capability and gate on it | `shared/teamHierarchy.ts`; `server/routes.ts:5075-5115`, `:5115-5162`, `:5378-5399`, `:5456-5488`, `:5494-5536`; `shared/capabilities.ts:14-60` | 🟠 behaviour-preserving refactor + two new refusals | WP-7 |
| **WP-9** | **`user_hierarchy_history`** — append-only, `RAISE(ABORT)` triggers, written from the single choke point in WP-8 inside the existing transactions. Never read by `commissionService`/`overrideStore`; state that in the DDL comment and `docs/COMMISSIONS.md`. Use the **transactional** migration precedent (`server/calling/migrations.ts:10-11`), not the warn-only array | new store module; `server/storage.ts`; `docs/COMMISSIONS.md` | 🟢 additive-safe | **WP-6, WP-7, WP-8** |
| **WP-10** | **Indexes + perf pins.** `idx_sales_lead ON commission_sales(lead_id)`; cache `membersById` per (tenant, request) so `overrideStore.ts:194` stops reloading the roster on every sale; EXPLAIN assertions in the `map-cold-open-window.test.ts:198-204` style; record measured before/after in the index's own comment | `server/storage.ts:958`, `:4028`; `server/overrideStore.ts:194-202`; new perf test | 🟢 additive-safe (WP-10b is a pure win, no design change) | none |
| **WP-10c** | **Reconcile the two scope resolvers** (§2B-13) — pick one team_lead semantic (recommend full subtree, matching `readScope`) and pin it with a test asserting both planes agree | `server/routes.ts:508-515`; `server/commissionRoutes.ts:31-41` | 🟠 widens or narrows lead visibility — decide deliberately | none |

## Phase 2 — Ledger and pool (**gated on the §5 decision**)

*Assuming Option A:*

| WP | Work | Files | Risk | Deps |
|---|---|---|---|---|
| **WP-11** | **Demote the legacy plane** (§4.3). Migrate `install_confirmed_at`/`payable_after` onto `commission_sales`; stop `storage.createCommission` at `routes.ts:6171`; keep legacy rows read-only. **Must be one change** — `countQualifiedSales`'s `forPay` path breaks otherwise | `server/routes.ts:6148-6186`; `server/commissionService.ts:266-320`, `:1636-1654`; `shared/schema.ts:625-632` | 🔴 **money-affecting** | WP-1 |
| **WP-12** | **Per-recipient rep ledger, materialized at FINALIZE** from `allocateCents`, alongside `contributing_sales`. Freeze the derived `manager_id_at_sale` / `team_lead_id_at_sale` / `hierarchy_path_at_sale` onto each row. Indexes and immutability triggers copied from `overrideStore.ts:75-98` | new table in `server/storage.ts`; `server/commissionService.ts:816-869`; `shared/commissionStatement.ts:161-169` | 🟠 additive but on the freeze path — needs an idempotency review | **§5 = Option A**, WP-11 |
| **WP-13** | **Config-time pool validator** (§4.2): pure function in `shared/` beside `validateOverridePatch`; refuse over-allocating plan/rate saves at `updateOrgConfig`. Do **not** repurpose `house_amount_cents` | `shared/commissionOverrides.ts`; `shared/commissionTiers.ts`; `server/commissionService.ts:882-889`; unit test mirroring `commission-overrides.test.ts:160-182` | 🟢 additive-safe (refusal at edit time only) | **§5 decision** |
| **WP-14** | Derived `manager_id`/`team_lead_id` as computed API read-model fields (one shared walk helper); plan version id/number onto the statement document and both footers | `shared/teamHierarchy.ts`; `server/commissionStatementDoc.ts:103-110`; `server/commissionStatementPdf.ts:293`; `client/src/components/CommissionStatement.tsx:337` | 🟢 additive-safe | WP-12 |

## Phase 3 — UI (mostly independent; WP-16 depends on WP-8)

| WP | Work | Files | Risk | Deps |
|---|---|---|---|---|
| **WP-15** | **User Profile screen** `/users/:id` — reuse `CommissionStatement.tsx`, `DownlineSheet.tsx` rollup, `AdminHistory.tsx` (add a `targetType`/`targetId` filter prop), `ROLES` from `Team.tsx:32-66`. Mount `AdminHistory` for tenant admins, not just super admins | new page; `client/src/App.tsx:219-381`; `client/src/components/AdminHistory.tsx:126-151` | 🟢 additive | WP-7 (for content), WP-9 (for the timeline section) |
| **WP-16** | **Promotion wizard** — multi-step Dialog; final step restates exact counts/dollars with a `blockedReason` line; legality from `@shared/teamHierarchy` so it never offers a move the API refuses | `client/src/pages/Team.tsx:106-149`, `:1006-1040` | 🟢 additive | **WP-8** |
| **WP-17** | **Optional reassignment plan** on offboard/delete — destination picker defaulted to the current automatic target, validated client-side with `wouldCreateReportsCycle`/`isValidSupervisorRole`, sent in the **same** request | `server/routes.ts:5384-5452`, `:5494-5536`; `client/src/pages/Team.tsx:923-981` | 🟠 changes a destructive path — keep auto-re-home as the default | WP-8 |
| **WP-18** | **Hierarchy tree view + search/filters + total-downline** as a second view mode in `Team.tsx`, using `shared/teamHierarchy.downlineOf` so client and server agree | `client/src/pages/Team.tsx:544-720` | 🟢 additive | none |
| **WP-19** | **Roster bulk select + bulk reassign** — server door reusing the WP-8 authorizer and the existing loop at `routes.ts:9569-9601`; client follows the payout-batch confirm grammar (`CommissionConsole.tsx:1037-1198`) | `server/routes.ts`; `client/src/pages/Team.tsx` | 🟠 new bulk write path | **WP-8** |
| **WP-20** | Statement as a route `/statements/:id`; dashboard filters (date range, manager/TL/rep, status) reusing `Leaderboard.tsx:115`'s range control | `client/src/App.tsx`; `client/src/pages/CommissionConsole.tsx:80-152` | 🟢 additive | none |
| **WP-21** | Tenant logo on the statement — select `brand_logo`, prefer it, fall back to `hfs-logo.png` then text (preserve the three-level fallback: *"a missing image must never cost a rep their statement"*). Decide `brand_logo`'s storage form and add a size/type guard before `doc.image()`. Client must move in lockstep | `server/commissionStatementDoc.ts:69`; `server/commissionStatementPdf.ts:35-38`, `:89-94`; `client/src/components/CommissionStatement.tsx:181` | 🟢 additive | none |
| **WP-22** | Statement provenance — stamp `statement_issued_at` at FINALIZE and prefer it over the request clock for FINALIZED/PAID; mark OPEN PDFs as drafts. If bytes are needed, mirror `completed_pdf` + `sha256` + trigger (`storage.ts:1382-1383`, `:2665-2681`) — store once at finalize, never per download | `server/commissionStatementDoc.ts:54-80`; `server/commissionService.ts:816-869` | 🟢 additive | none |
| **WP-23** | Housekeeping: delete the orphaned `migrations/20260714_calling_compliance.sql` and drop `out` from `drizzle.config.ts` (or document the dir as historical); remove or enforce the 7 dead capabilities; add `updated_at` to `team_members` | `migrations/`; `drizzle.config.ts`; `shared/capabilities.ts`; `server/storage.ts` | 🟢 additive-safe | none |

---

## Two standing rules for every package above

1. **Write perf tests in the house dialect or they will be deleted as flaky.** Seed at scale in one `rawDb` transaction with a `beforeAll(..., 120_000)`, then assert `EXPLAIN QUERY PLAN` names the intended index and seek shape. Never assert elapsed ms. Record measured before/after in the index's own source comment. Rationale: `tests/integration/incentive-perf.test.ts:10-14`.
2. **Do not put a money ledger or an audit table in the warn-only `runMigrations()` array.** Its executor swallows every error and only `console.warn`s (`server/storage.ts:2721-2727`), so a failed CREATE surfaces later as a runtime error on the pay path. Use the transactional precedent at `server/calling/migrations.ts:10-11` — *"a compliance schema failure aborts startup so a half-created system can never report healthy"* — or add a boot-time existence assertion. Keep the DDL idempotent so the `mkdtempSync` test idiom keeps working.