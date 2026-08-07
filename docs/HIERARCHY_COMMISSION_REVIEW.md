# Post-Change Review — hierarchy & commission

> **Generated:** 2026-08-06. An adversarial review of the WP-1…WP-22 changes
> (six dimensions, every finding independently attacked before it was allowed to
> stand; 16 of ~60 candidate findings survived). Companion to
> [`HIERARCHY_COMMISSION_AUDIT.md`](./HIERARCHY_COMMISSION_AUDIT.md).
>
> **Status: §1.1 – §1.5 are FIXED, plus §2.1 and §2.4.** Each carries a
> regression test that reproduces the original defect. Still open: **§2.2**
> (`upsertSale` books a QUALIFIED sale that syncs no overrides and refreshes no
> statement) and **§2.3** (`batchTransitionWeek` has no per-rep isolation).
> Section 3 is unactioned by design.

---

# FIX LIST — hierarchy/commission session (WP-1 … WP-22)

Deduped from 16 verified findings → 13 distinct defects. The two backfill findings (`commissionService.ts:1330`) were the same defect; the two logo findings (`sanitizeLogoDataUri` never parses IHDR) collapse into one fix.

---

## 1. MUST FIX

Ranked by blast radius. Each is a defect **in code this session wrote** — either a straight regression, or a new guard that is incomplete while its own comment claims the hole is closed.

### 1.1 — GUARD 1 clamps `soldAt`, but the column that actually places the pay-week is unclamped
`server/commissionService.ts:642-651` (new) vs `:711` (bind site)

**Defect.** The clamp rewrites only the local `soldAt`; `input.qualifiedAt / installedAt / activatedAt` are bound raw into the INSERT at `:711`. The pay-week is `BASIS_COLUMN[config.qualificationBasis]` (`:66-68`) and the shipped default is `QUALIFIED_AT` (`server/storage.ts:925`, fallback `commissionService.ts:94`), so the guard whose comment says the pay-week is placed "never by a caller-supplied clock" leaves the real pay-week column fully caller-controlled. `correctionWindowDays` appears in exactly two places repo-wide (`:646`, `:1255`) — there is no second clamp anywhere.

**Concrete failure (reproduced).** Manager POSTs `/api/commission/sales` `{repId, externalId:"x1", status:"QUALIFIED", soldAt:<now>, qualifiedAt:"2025-11-10"}`. `sold_at` is clamped to now; `qualified_at` is stored 270 days back — 9× outside the 30-day window. GUARD 2 is skipped (fresh externalId, no existing row), GUARD 3 passes (that historical week has no statement row, so it is not FINALIZED/PAID). A measured run: an honest week of 4 sales at $150 became 19 sales at $300 under RETROACTIVE_WEEKLY — the whole week re-priced at the top tier, $600 → $5,700. This is verbatim the exploit the comment at `:637-641` says it stops.

**Fix.** In `upsertSale`, hoist the clamp into a helper and apply it to every basis column when `serverReceivedAt` is present:
```ts
const clampTs = (ts?: string | null) => { /* the :644-650 body */ };
let soldAt = clampTs(input.soldAt) ?? input.soldAt;
const qualifiedAt = clampTs(input.qualifiedAt), installedAt = ..., activatedAt = ...;
```
Use the clamped values in GUARD 2's `incomingBasis` (`:665-668`), GUARD 3's `basisTs` (`:685-688`), **and** the INSERT bind at `:711`. Separately add a zod schema on `server/commissionRoutes.ts:347` (today it spreads `req.body` wholesale) restricting `status` to the known enum — a lowercase `"qualified"` does not fabricate money (`countQualifiedSales` filters `status='QUALIFIED'`, `:257`) but does create an inert row that silently counts nowhere.

*Provenance: the underlying hole predates WP-1 (`transitionSale:725` has the same unclamped `qualified_at=COALESCE(qualified_at, ?)` from a caller-supplied `at`). WP-1 shipped the clamp and the claim, so finish it here.*

### 1.2 — WP-4's branch guard checks the destination rep only; a manager can re-point another branch's sale to their own rep
`server/commissionRoutes.ts:341`

**Defect.** The route guards `Number(req.body?.repId)` — the **incoming** owner — and never the sale's **current** owner, while the upsert's `ON CONFLICT` rewrites `rep_id` (`commissionService.ts:703-711`). GUARD 2 only fires when the existing row is already `QUALIFIED` (`:663`), so PENDING/INSTALLED/ACTIVATED/**REVERSED** rows are freely re-attributable. The sibling route eleven lines down proves the intended pattern: `commissionRoutes.ts:352-354` looks the sale up and calls `denyOutOfScope(req, res, sale.rep_id)`.

**Concrete failure (reproduced).** Manager A holds `commission.read.all`, so `GET /api/commission/reps/:repId/week-sales` returns manager B's rep's `external_id`s (`commissionService.ts:1737`); field-sale ids are guessable anyway (`lead:${leadId}`, `:1215`). A POSTs the same externalId with their own repId and `status:"QUALIFIED"` → **201**, `rep_id` flips from B's rep to A's, and the sale plus every downstream override moves branches. A second variant resurrected a REVERSED sale of B's rep as QUALIFIED under A's rep (201, `reversed_at` still set). The only audit row is a routine `commission_sale.upserted` — nothing records a transfer.

**Fix.** In the route, before the guards, mirror `:352-354`:
```ts
const prior = svc.getSaleByExternalId(tid(req), String(req.body?.externalId ?? ""));
if (prior && denyOutOfScope(req, res, prior.rep_id)) return;
```
Then extend GUARD 2 at `commissionService.ts:663` to refuse a `rep_id` change on **any** existing row, not only a QUALIFIED one, and to refuse resurrecting a `REVERSED` row to `QUALIFIED` in place.

### 1.3 — GUARD 3 permanently truncates the startup field-sale backfill
`server/commissionService.ts:1330` (loop `:1325-1335`), call site `server/index.ts:787-790`

**Defect.** `backfillFieldSales` calls `upsertSale(..., status:"QUALIFIED")` with no per-lead try/catch. GUARD 1 exempts trusted in-process callers by keying off `serverReceivedAt` (`:641`); **GUARD 3 has no such exemption** and throws `STATEMENT_LOCKED` (`:698`). The only catch wraps the whole call, so one throwing lead aborts the sweep — and because rows already created are `continue`d at `:1329` on the next boot, the same lead blocks the same position **every** boot.

**Concrete failure.** The duplicate-lead merge (`server/storage.ts:3144-3196`) repoints `commission_sales.lead_id` to the survivor but never rewrites `external_id`, while promoting the survivor to `lead_status='sold'` and moving its knock — producing a sold lead with a historical sold knock and no `lead:<survivorId>` sale row, exactly what the probe at `:1328` misses. That merge runs at boot *before* the backfill. Once the week is FINALIZED/PAID: `[commission] field-sale backfill skipped: Week … is PAID for rep 31`, and every sold door after it, across all tenants, is never adopted. Restarting does not help.

**Fix.** Wrap the body of the `for (const l of soldLeads)` loop in try/catch, increment a `blocked` counter, log the external id, and continue — this also covers the pre-existing `CROSS_TENANT_ACCESS` throw at `:631`. Better: mirror `recordFieldSaleFromKnock:1260-1281` and book the lead `PENDING` for a locked week instead of skipping it, so a manager can qualify it in an open correction period.

### 1.4 — GUARD 2 409s the routine lifecycle re-stamp under `INSTALLED_AT` / `ACTIVATED_AT` bases
`server/commissionService.ts:654-655`, `:669-670`

**Defect.** `basisOf` falls back to `row.sold_at` when the basis column is null, so an existing QUALIFIED row with `installed_at IS NULL` reports the *sold* week; the incoming install date is then a different week and `:673` throws `SALE_CREDIT_LOCKED`. Meanwhile the money query (`:260-263`) has **no** fallback — the sale counts in no week until `installed_at` is stamped. The guard blocks precisely the write that makes the sale payable.

**Concrete failure (reproduced).** Tenant on INSTALLED_AT. Day 0: book `s-9` QUALIFIED, no install → stored, sold-week gross `$0`. Day 21: re-post with `installedAt:+21d` → `SALE_CREDIT_LOCKED / 409 / "Sale s-9 is QUALIFIED in an earlier pay week"`, row still `installed_at: null`. The rep is never paid without a reverse-and-rebook dance.

**Fix.** At `:669`, compute the existing basis **without** the sold_at fallback and skip `movesWeek` when it is null — first-time stamping is not re-dating:
```ts
const existingBasisRaw = existing[BASIS_COLUMN[config.qualificationBasis]] ?? null;
const movesWeek = !!incomingBasis && !!existingBasisRaw && weekBoundsFor(incomingBasis, config).weekStartUtc !== weekBoundsFor(existingBasisRaw, config).weekStartUtc;
```
(Severity is bounded today only because no client UI exposes a non-default basis; `updateOrgConfig` does, via `commissionRoutes.ts:121`.)

### 1.5 — `orgStatusGate` reuses the **training** allowlist, so a blocked org keeps the whole recruiting/onboarding plane
`server/routes.ts:438`; list at `shared/trainingGate.ts:36-44`

**Defect.** The gate calls `pathAllowedWhileGated`, whose list answers a different question ("what does an untrained rep need to become employable"): `/api/auth, /api/training, /api/me, /api/onboarding, /api/notifications, /api/diagnostics, /api/health`. The gate's own comment at `:436-437` says the exemption exists only so someone can "read who they are, see the notice, or sign out" — intent and list have diverged.

**Concrete failure.** The reachable path is `status:"suspended"`, not `cancelled`: `PATCH /api/sa/tenants/:id` allowlists `status` (`routes.ts:10968`) and performs **no** session sweep, while `DELETE` does (`routes.ts:11013-11020`). Every live session survives, and `storage.touchSession` runs at `:398` *before* the gate at `:410`, so polling an allowlisted path keeps them alive indefinitely. A suspended org retains `POST /api/onboarding/invitations` (`server/onboardingDocumentRoutes.ts:423` — creates records **and** sends outbound mail on the platform's Resend domain), `/resend-login`, `/resend-documents`, `PATCH /api/onboarding/applications/:id` (`routes.ts:9408` — mints a user account + welcome email for a dead org), counter-sign/void, `/api/training/gate/roster`, `GET /api/diagnostics`.

**Fix.** Add an `ORG_GATE_ALLOWED_PREFIXES` constant next to `ORG_BLOCKING_STATUSES` (`routes.ts:428`) instead of importing `pathAllowedWhileGated` — realistically `/api/auth`, `/api/health`, and whatever `/api/me` / `/api/notifications` the lock screen actually renders. Separately, add the same session sweep to the PATCH handler when `safeTenant.status` lands in `ORG_BLOCKING_STATUSES`. Keep fail-open; that part is correct.

---

## 2. SHOULD FIX (pre-existing, worth doing while this area is warm)

### 2.1 — A re-printed FINALIZED/PAID statement recomputes its holdback and NET PAY from the **live** reserve ledger  *(highest-value item in this list)*
`server/commissionStatementDoc.ts:97-99`

WP-22 pinned the issue **date** of a locked statement but not the money under it. `buildStatementDocumentFor` calls `holdbackForStatement` and `getReserveBalanceCents` unconditionally, both of which read the **current** rep/org percent and the **current** balance (`commissionService.ts:1783-1795`, `reserveService.ts:88-126`). `commission_statements` has no reserve column (`storage.ts:964`); `reserve_entries` is the only frozen record. Because `payout.netPayCents = earnedCents - reserveCents` (`shared/commissionStatement.ts:264-271`), the hero NET PAY figure moves.

Reproduced: two settled $1,600 weeks with a 10%/$200-cap reserve — ledger holds 16000c and 4000c, yet **both** FINALIZED statements re-print `reserveCents: 0 / netPayCents: 160000`. Week 1's pay document reads $0 withheld where its own append-only ledger row says $160, with no admin action at all. Flipping the org percent 10→25 changed a locked statement's printed net from $1,600 to $1,200. Two people downloading the same statement id on different days disagree.

**Fix.** For `locked` statements, read the frozen `reserve_entries` row (`kind='hold'`, unique on `(tenant_id, rep_id, week_start_utc)`, `storage.ts:2473-2474`) and build `holdback`/`payout` from the **recorded** amount plus the percent stored on that entry — `reserveService.ts:184-186` already states the rule verbatim ("Report the RECORDED amount — never recompute it"). Fall back to the live computation only for OPEN/REVIEW weeks, where `isDraft` is already true (`commissionStatementDoc.ts:156`). Pin with a test that finalizes, mutates percent + balance, and asserts the rebuilt payout is byte-identical.

### 2.2 — `POST /api/commission/sales` books a QUALIFIED sale that pays no upline and refreshes no statement
`server/commissionService.ts:702-716`

`upsertSale` writes, logs, returns. `syncOverridesForSale` has exactly two callers — `transitionSale:742` and `recordFieldSaleFromKnock:1287` — so the one door WP-1 just hardened and documented as *the* safe write site is the only sale path that produces no override ledger entry. Nothing repairs it later: `overrideBlockForWeek` only SUMs existing rows (`overrideStore.ts:340-351`), and the exceptions rail iterates `listExceptions` (`commissionService.ts:1588`), so there is no row to be in exception. Reproduced with TL $25 / mgr $75: a knock-booked sale produced 2 PAYABLE rows; an identical `upsertSale(status:"QUALIFIED")` produced 0, while the week overview still showed the rep's sale count and pay.

**Fix.** Inside `upsertSale` after the INSERT (single write site, matching WP-1's own rationale), when the stored status is QUALIFIED: `overrides.syncOverridesForSale(tenantId, sale.id, actorId, weekBoundsFor(basisTs, config).weekStartUtc)`, then best-effort `calculateOrRecalculateStatement` for the seller and each `beneficiariesForSale` week, swallowing only `NO_EFFECTIVE_PLAN_ASSIGNMENT` / `STATEMENT_LOCKED` — copy the shape at `:743-757`. Latent today only because both override rate columns default to 0.

### 2.3 — `batchTransitionWeek` has no per-rep isolation: one rep aborts the whole Sunday closeout and discards the results report
`server/commissionService.ts:1673-1696`

`calculateOrRecalculateStatement` (`:1687`) and `transitionStatement` (`:1688`) run with no try/catch and no transaction; a throw propagates to `commissionRoutes.ts:451`, so the caller gets a bare 4xx and the `results` array — the only record of who was already locked — is thrown away. Reps before the throw stay FINALIZED, everyone after stays OPEN. The immediately preceding override-ensure loop (`:1661-1665`) *does* catch per iteration, and the `blocked` Set at `:1625/:1645` is written but never read — the isolation was intended and never landed.

Reproduced: hourly-only rep with an existing OPEN statement, then a backdated rate removal via `PATCH /api/team-members/:id/hourly-rate` (`effectiveFrom` is caller-supplied and unbounded, `hourlyPayRoutes.ts:44-49`). Batch FINALIZE: rep 7001 FINALIZED, 7002 threw `NO_EFFECTIVE_PLAN_ASSIGNMENT`, rep 7003 (plan + qualified sale) left OPEN and unreported.

**Fix.** Wrap the `for (const s of stmts)` body in try/catch pushing `{repId, statementId, result: "BLOCKED (<code>: <message>)"}` — the exact shape already used for `OPEN_CLOCK_SESSION` at `:1683` — and return a `failures` count so the console can render partial success.

### 2.4 — Missing `idx_sales_lead`: the FCC purge preview blocks the event loop for ~26 s
`server/storage.ts:957-958` (index list), predicate at `:4028`

`fccPurgeWhere` runs `NOT EXISTS (SELECT 1 FROM commission_sales cs WHERE cs.lead_id = l.id)` per candidate row. `commission_sales` has only `(tenant_id, external_id)` and `(tenant_id, rep_id, status, qualified_at)`. `EXPLAIN QUERY PLAN` on the real `countFccPurge` shape: the three sibling predicates resolve as `SEARCH … USING COVERING INDEX` (knock_log, commissions, lead_photos) while commission_sales is `SCAN cs`. Measured on 120k fcc leads + 10k sales: **26.4 s → 0.07 s** with the index (~375×). better-sqlite3 is synchronous, so that is 26 s of blocked Node for the whole floor, fired automatically when an admin opens the dialog (`client/src/components/map/FccPurgeDialog.tsx:28-35`, `enabled: open`), and `purgeFccLeads` (`storage.ts:4046-4057`) holds a write transaction for the same duration. The codebase already states this rule for the sibling table at `storage.ts:2907-2911`.

**Fix.** One line beside `idx_sales_agg`: `CREATE INDEX IF NOT EXISTS idx_sales_lead ON commission_sales(lead_id)`, pinned with an `EXPLAIN QUERY PLAN` assertion (template: `tests/integration/map-cold-open-window.test.ts:198-214`).

---

## 3. WORTH KNOWING (no action required)

- **WP-20 half-shipped: `/statements/:id` has no producer.** The route works (`client/src/App.tsx:296-303`; wouter's render-prop child is supported), but nothing in the client links to it — `CommissionConsole.tsx:817` and `MyCommission.tsx:138` still open the modal in place, and `CommissionStatement.tsx:152-181` has only Download/Print, no copy-link. The stated goal ("send me that statement" now has an answer) is not met; the URL is hand-constructable since ids are displayed. One link control in the drawer finishes it.
- **`sanitizeLogoDataUri` bounds bytes, not pixels** (`server/commissionStatementDoc.ts:172-190`). It reads 3-4 magic bytes and never parses IHDR. Two consequences, one fix: (a) a 47 KB 3200×3200 RGBA PNG fits the 64 KB body limit and costs **548 ms / 261 MB RSS** per PDF — and pdfkit defers inflation to `doc.end()` (`server/pdfCommon.ts:33-41`), so it is *outside* `drawLogo`'s try/catch at `commissionStatementPdf.ts:108-111`; (b) a 65-byte 0×0 PNG makes `doc.image` throw *after* pdfkit emitted its `q` and registered the XObject, leaving an unbalanced content stream (q=31/Q=30) and an orphan `/Width 0` image in Resources — strict validators reject it, lenient viewers do not care. Fix both by rejecting on `width*height` (and zero dimensions) in `sanitizeLogoDataUri`. Write path is super-admin-only (`routes.ts:10968`), which is why this is low.
- **On-screen logo failure hides the mark instead of falling back** (`client/src/components/CommissionStatement.tsx:183-190`). The comment promises "the same three-level fallback the PDF uses, so the screen and the download never show different branding"; the code is two-level and terminates at `display:none`, while the PDF falls through to the bundled HFS mark (`commissionStatementPdf.ts:113-116`). Verified: a truncated PNG throws synchronously in pdfkit and the fallback draws. Same statement id, two letterheads. Make `onError` swap `src` to `/hfs-logo.png` once (guard against a loop), hide only on the second failure.
- **Two glyph regressions from the WP-5 shared-row refactor.** (a) A negative Adjustments row now takes the `negative` branch at `CommissionStatement.tsx:145` and renders U+2212 `−$12.34` where it previously rendered ASCII `-$12.34`; the comment at `:142-144` claiming the holdback is "the one row" using a true minus is contradicted by `shared/commissionStatement.ts:330-331`. (b) `amountCents: -Math.abs(reserveCents)` (`shared/commissionStatement.ts:334`) is `-0` for a zero reserve, and `formatCents`'s `Number(n) || 0` collapses it, so both surfaces now print `$0.00` where they printed `−$0.00` / `-$0.00`. No money changed; tests assert `label`/`amountCents` only, never the rendered string.
- **CommissionConsole empty-state layering.** The filter bar (`:335`) is a sibling *before* the `ov.rows.length === 0` ternary (`:389`), so a live "Find a rep…" box renders on top of "No reps producing this week yet"; and the desktop table (`:445-506`) has no `visibleRows.length > 0` guard, so the "No reps match these filters" panel (`:405`) is followed by a bare column-header strip — which the block's own comment at `:401-403` says it exists to avoid.
- **Dead code re-verified, none of it a defect.** `DUPLICATE_SALE` (`commissionService.ts:33`) has exactly one occurrence repo-wide, its own declaration in a type union — lint-level. The seven unwired capabilities (`lead.read.*`, `lead.reassign`, `audit.read.team`, `dashboard.read.*`) fail **closed**: the only audit route is `requireCapability("audit.read.org")` (`routes.ts:10644`), which team_lead does not hold, so an unwired grant confers nothing. Unreachable `role === 'super_admin'` branches are defense-in-depth. Governance hygiene, not risk.

---

## 4. VERDICT ON THE CHANGES

**Directionally sound; two items should not ship as written.**

The architecture of this session is right. Moving the three guards to the single write site (`upsertSale`) instead of leaving them in `recordFieldSaleFromKnock` is the correct instinct and closes a real bypass. WP-2's locked-week probe (`overrideStore.ts:307-333`) is clean and correct — it converts a silent unpaid upline into a visible `EXCEPTION`. WP-5's `statementSummaryRows` genuinely de-duplicates the money summary and its "rows above Earned sum to earnedCents" invariant is pinned on both surfaces. WP-22's frozen `issuedAtIso` and the DRAFT badge are right. Fail-open on `orgStatusGate` is the correct call and is implemented correctly. The knock invariant is intact everywhere I checked: `recordFieldSaleFromKnock` (`:1227-1281`) still pre-empts all three guards with its own softer handling, and no new throw reaches the knock path.

**Unsafe as shipped:**

1. **§1.1** — WP-1 ships a comment asserting that the pay-week can never be placed by a caller-supplied clock, and that assertion is false for the default org basis. I reproduced a 4-sale week becoming a 19-sale top-tier week from HTTP input alone. Shipping a guard that documents a protection it does not provide is worse than shipping no guard: the next reviewer will read the comment and stop looking.
2. **§1.3** — the backfill regression is a silent, permanent, self-repeating data-adoption failure with a single `console.warn` as its only signal. It is the kind of thing that is discovered months later by a rep who was never paid.

**§1.2** is a P1 authz gap but sits behind a manager who can already fabricate in-branch sales, and WP-4 made the overall picture strictly better — it closed the direct-write direction and left the re-point direction open. **§1.4** is a real 409 on a routine path, bounded only by the fact that no UI currently selects a non-default basis. **§1.5** is an incomplete new control, not a regression — before WP-3 nothing read `tenants.status` at request time at all.

Nothing in the diff corrupts settled weeks, breaks tenant isolation, or violates the append-only override ledger. The clean tsc and 5,079 green tests are real but not reassuring here: every defect above lives in a shape the suite does not exercise (every `upsertSale` test passes `soldAt === qualifiedAt`; no test uses a non-`QUALIFIED_AT` basis; no test backfills into a locked week; no test asserts a rendered money string). Fix §1.1 and §1.3 before this goes to prod; the rest can land in a follow-up.