The working tree is materially further along than the brief assumes. Verified line-by-line below.

---

# P0-A / P0-B — definitive patch specification

**Read this first — two premises in the brief are stale.**

| Brief says | Working tree actually |
|---|---|
| `transitionSale (:897-921)` does `const at = opts?.at \|\| nowIso()` with **no clamp** | **Already fixed.** `commissionService.ts:945-954` loads config, resolves the sale's own basis, and routes `opts.at` through the shared `resolveEffectiveDates` with a service-stamped `serverReceivedAt: now`, auditing at `:953`. |
| Hoist `upsertSale`'s `clampTs` closure (`:731-739`) to module level | **Already done, elsewhere.** No `clampTs` closure exists. `upsertSale:784-787` calls `shared/commissionEffectiveDate.ts:79 resolveEffectiveDates`. That module *is* the hoisted clamp. |
| Route `commissionRoutes.ts:363` must stamp a `serverReceivedAt` | **It must not — see §2.4.** `transitionSale` stamps its own at `:936`. Accepting a route-supplied one would let a caller widen its own correction window, the exact hole `commissionRoutes.ts:353-356` warns about on the sibling route. |

What actually survives on the P0-B path is the **locked-week guard**, not the clamp. Line numbers below are the working tree's.

---

## 1. P0-A — one resolved basis source

### 1.1 The finding, plainly

**The snapshot mechanism is already correct and is already honoured at every call site.** `basisTsExpr` (`:102-113`) and `basisForSale` (`:124-127`) both consult `commission_sales.qualification_basis` first; the write-once `COALESCE` at `:862` protects it. A **stamped** row cannot diverge anywhere.

**The defect is the FALLBACK for NULL-snapshot rows, which has two implementations:**

| Site | Fallback passed | Decides |
|---|---|---|
| `commissionService.ts:498` | `version.qualification_basis \|\| config.qualificationBasis` | which week **counts** (money) |
| `:907` `reconcileSaleSideEffects` | `config.qualificationBasis` | which week **recomputes**, and the override **earn week** |
| `:946` `transitionSale` | `config.qualificationBasis` | which field `at` clamps as |
| `:1655`, `:1687`, `:1744` week overview | `config.qualificationBasis` | console counts, install hold, `REVERSED_AFTER_FINALIZE` |
| `:1883` → `:1916` FINALIZE ensure | `config.qualificationBasis` | **which reps get a statement at closeout** |
| `:2072` `listWeekSalesForRep` | `config.qualificationBasis` | the door list, and the frozen `contributing_sales` (`:1136`) |

`basisTsExpr:108` renders `CASE COALESCE(qualification_basis, '<fallback>')`, so for a NULL snapshot **the fallback is the answer** — and the two sets disagree. The file's own documented precedence at `:86-91` says rule 2 is *"the plan version's basis as resolved by the statement — which is exactly what already counted it."* `:498` implements that; the other six jump to rule 3.

**Not already fixed, and not hypothetical.** `storage.ts:978` is a bare `ALTER TABLE commission_sales ADD COLUMN qualification_basis TEXT` with no backfill. Verified read-only: `PRAGMA table_info(commission_sales)` on `data.db` returns 15 columns ending at `house_amount_cents` — **the column does not exist yet, so every one of the 13 existing rows becomes NULL on first boot after deploy.** Divergence is one unguarded call away: `commissionRoutes.ts:135 → addPlanVersion:626` takes `qualificationBasis` straight from `req.body` with no cross-check against the tenant, and `getOrCreateFlatVersion` matches versions by *rate*, so a pre-flip version survives an org-config change.

**One site on the gap list needs no change:** `basisTsExprFor` (`:119-121`). Its only caller, `commissionReconciliation.ts:198-203`, filters `AND cs.qualification_basis IS NOT NULL` — the fallback branch is unreachable. Leave it.

### 1.2 The single resolution function

Three small functions, all in `server/commissionService.ts` beside the existing helpers (after `:133`). Together they are the one implementation of the documented precedence.

```ts
/** Precedence rule 3, in one place: a plan version's basis, with org config as
 *  the ONLY fallback. `commission_plan_versions.qualification_basis` is NOT NULL
 *  DEFAULT 'QUALIFIED_AT' (storage.ts:947), so the `??` is defensive — but it is
 *  the one place that decision is written down. */
function basisOfVersion(version: any, config: OrgCommissionConfig): QualificationBasis {
  const b = version?.qualification_basis as QualificationBasis | undefined;
  return b && BASIS_COLUMN[b] ? b : config.qualificationBasis;
}

/**
 * Precedence rule 2: the basis for a rep in a WEEK — the plan version the
 * STATEMENT resolves for that week, else org config.
 *
 * This is the fallback every NULL-snapshot row must resolve through, and it is
 * the fallback `calculateOrRecalculateStatement` has always used. Six other call
 * sites passed `config.qualificationBasis` instead, so a legacy row was COUNTED
 * by the plan version and RECOMPUTED by the tenant — the original divergence,
 * surviving for exactly the rows the snapshot does not cover.
 *
 * NEVER throws. An hourly-only or override-only rep has no assignment and still
 * needs a basis: calculateOrRecalculateStatement deliberately tolerates that
 * (:474-488) and commissionRoutes.ts:411/:430 render it as `noPlan`. A resolver
 * that threw NO_EFFECTIVE_PLAN_ASSIGNMENT would turn both endpoints into 500s.
 */
export function fallbackBasisForRepWeek(
  tenantId: number, repId: number, bounds: WeekBounds, config: OrgCommissionConfig,
): QualificationBasis {
  const assignments = rawDb.prepare(
    `SELECT id, commission_plan_version_id AS commissionPlanVersionId,
            effective_from AS effectiveFrom, effective_to AS effectiveTo
       FROM rep_commission_assignments WHERE tenant_id = ? AND rep_id = ? ORDER BY effective_from DESC`,
  ).all(tenantId, repId) as AssignmentRow[];
  const assignment = resolveAssignmentForWeek(assignments, bounds.weekStartUtc, bounds.nextWeekStartUtc);
  if (!assignment) return config.qualificationBasis;
  const version = rawDb.prepare(
    `SELECT qualification_basis FROM commission_plan_versions WHERE id = ? AND tenant_id = ?`,
  ).get(assignment.commissionPlanVersionId, tenantId) as any;
  return basisOfVersion(version, config);
}

/** A SALE's basis: rules 1 → 2 → 3. The JS twin of basisTsExpr's COALESCE, with
 *  the fallback finally resolved the way the statement resolves it. */
function saleBasisResolved(tenantId: number, sale: any, config: OrgCommissionConfig): QualificationBasis {
  const stamped = sale?.qualification_basis as QualificationBasis | undefined;
  if (stamped && BASIS_COLUMN[stamped]) return stamped;
  // Legacy row: anchor the week lookup on the sale's own most specific instant.
  return fallbackBasisForRepWeek(tenantId, sale.rep_id, weekBoundsFor(sale.qualified_at || sale.sold_at, config), config);
}
```

### 1.3 Breaking the circularity — `weeksCountingSale`

`reconcileSaleSideEffects` cannot call `fallbackBasisForRepWeek` directly: it needs the basis to compute the week, and the resolver needs the week. That circularity is real, and it is why the naive "just swap the fallback argument" fix does not work. It is resolved by **enumeration**, because a sale has at most four candidate instants.

```ts
/**
 * Every week that COUNTS this sale, and the timestamp that puts it there.
 *
 * For a STAMPED sale this is trivially one week: the row's frozen basis names
 * one column, that column names one week — no extra reads, no behaviour change.
 * The enumeration exists for LEGACY rows, where "which basis?" and "which week?"
 * define each other. With at most four candidate instants the fixpoint is just:
 * for each candidate week ask the STATEMENT's own resolver what basis governs
 * it, and keep the week only if the sale genuinely lands there under that basis.
 * That is countQualifiedSales' predicate (:348-349) evaluated in JS — the two
 * agree by CONSTRUCTION, not because two call sites happen to pass the same
 * argument. Status-agnostic on purpose: a REVERSE must still recompute the week
 * that WAS counting the sale.
 */
function weeksCountingSale(
  tenantId: number, sale: any, config: OrgCommissionConfig,
): Array<{ weekStartUtc: string; basisTs: string }> {
  const stamped = sale?.qualification_basis as QualificationBasis | undefined;
  if (stamped && BASIS_COLUMN[stamped]) {
    const ts = basisTsForSale(sale, stamped);
    return [{ weekStartUtc: weekBoundsFor(ts, config).weekStartUtc, basisTs: ts }];
  }
  const out = new Map<string, { weekStartUtc: string; basisTs: string }>();
  for (const candidate of [sale.qualified_at, sale.installed_at, sale.activated_at, sale.sold_at]) {
    if (!candidate) continue;
    const bounds = weekBoundsFor(candidate, config);
    if (out.has(bounds.weekStartUtc)) continue;                       // week already resolved
    const basisTs = sale[BASIS_COLUMN[fallbackBasisForRepWeek(tenantId, sale.rep_id, bounds, config)]] as string | null;
    // An unstamped basis column counts in NO week — countQualifiedSales requires
    // `(col) IS NOT NULL` (:348) with no sold_at fallback, and the override earn
    // must not precede the rep's own credit.
    if (!basisTs) continue;
    if (weekBoundsFor(basisTs, config).weekStartUtc !== bounds.weekStartUtc) continue;
    out.set(bounds.weekStartUtc, { weekStartUtc: bounds.weekStartUtc, basisTs });
  }
  return [...out.values()].sort((a, b) => (a.weekStartUtc < b.weekStartUtc ? -1 : 1));
}
```

**Why this is provably a no-op for every stamped row and every non-divergent tenant:** stamped → short-circuit, identical to today. Legacy + version basis == tenant basis + basis column populated → the resolver returns the same value today's `config.qualificationBasis` returns, the sale's own basis column can only be in one week, so exactly one week survives — identical to today.

Only two cases change, and both are the correction:
- Legacy row, version basis ≠ tenant basis → the week that **counts** it is recomputed (today the week that does **not** count it is recomputed, and the counting week never is).
- Legacy row, basis column NULL → recomputes nothing and books no override earn, instead of recomputing the `sold_at` week and paying the upline for a door the rep is paid $0 for.

### 1.4 Call sites — before / after

**(A) `commissionService.ts:142-154` — collapse `resolveSaleBasis` into the one resolver**

```ts
// BEFORE (:142-154)
export function resolveSaleBasis(tenantId: number, repId: number, atIso: string, config: OrgCommissionConfig): QualificationBasis {
  const row = rawDb.prepare(
    `SELECT v.qualification_basis AS basis
       FROM rep_commission_assignments a
       JOIN commission_plan_versions v ON v.id = a.commission_plan_version_id
      WHERE a.tenant_id = ? AND a.rep_id = ?
        AND a.effective_from <= ?
        AND (a.effective_to IS NULL OR a.effective_to > ?)
      ORDER BY a.effective_from DESC LIMIT 1`,
  ).get(tenantId, repId, atIso, atIso) as any;
  const basis = row?.basis as QualificationBasis | undefined;
  return basis && BASIS_COLUMN[basis] ? basis : config.qualificationBasis;
}
```
```ts
// AFTER
export function resolveSaleBasis(tenantId: number, repId: number, atIso: string, config: OrgCommissionConfig): QualificationBasis {
  // Was a SECOND assignment resolver: instant-scoped, and comparing a DATE
  // `effective_to` against a full ISO instant, so `'2026-08-01' > '2026-08-01T10:00Z'`
  // read false and it disagreed with resolveAssignmentForWeek at every mid-week
  // boundary — including the new-hire exception (:220-227), which it had no
  // equivalent of. The stamp must name the version the STATEMENT will use for
  // this sale's own week, or the frozen snapshot can name a basis no version
  // governing that week ever chose.
  return fallbackBasisForRepWeek(tenantId, repId, weekBoundsFor(atIso, config), config);
}
```
`resolveSaleBasis` has exactly one caller (`:779`), verified by grep, so the contract change is contained.

**(B) `commissionService.ts:498` — make the statement call the shared normalizer**

```ts
// BEFORE
    basis = (version.qualification_basis || config.qualificationBasis) as QualificationBasis;
```
```ts
// AFTER
    // The definition every other basis site now defers to, rather than each
    // re-deriving it and drifting.
    basis = basisOfVersion(version, config);
```
`version` is already loaded at `:490-492`; no extra query.

**(C) `commissionService.ts:770-788` — resolve the snapshot from CLAMPED input, not raw**

The snapshot is write-once (`:862`), so it must never be chosen from a caller-supplied clock. Today `:779` resolves it from `input.qualifiedAt ?? input.soldAt` **before** the clamp at `:784`, so a 400-day-back `qualifiedAt` picks a plan version that governs no week the sale can land in — permanently.

```ts
// BEFORE (:777-788)
  const basis: QualificationBasis = existing?.qualification_basis && BASIS_COLUMN[existing.qualification_basis as QualificationBasis]
    ? (existing.qualification_basis as QualificationBasis)
    : resolveSaleBasis(tenantId, input.repId, input.qualifiedAt ?? input.soldAt, config);
  const basisColumn = BASIS_COLUMN[basis];
  const dates = resolveEffectiveDates(
    { soldAt: input.soldAt, qualifiedAt: input.qualifiedAt, installedAt: input.installedAt, activatedAt: input.activatedAt },
    { basis, correctionWindowDays: config.correctionWindowDays, serverReceivedAt: input.serverReceivedAt },
  );
  auditEffectiveDateClamps(actorId, tenantId, input.externalId, dates, "upsertSale");
```
```ts
// AFTER
  const rawDates = { soldAt: input.soldAt, qualifiedAt: input.qualifiedAt, installedAt: input.installedAt, activatedAt: input.activatedAt };
  const clampPolicy = { correctionWindowDays: config.correctionWindowDays, serverReceivedAt: input.serverReceivedAt };
  // The snapshot is WRITE-ONCE, so it must never be chosen from a caller's clock.
  // It was: this resolved from the RAW request fields and the clamp ran after,
  // freezing a basis from a plan version that may govern no week the sale can
  // reach. Probe with the ORG basis purely to obtain a CLAMPED instant —
  // resolveEffectiveDates' clamping never reads `policy.basis` (it consults only
  // trusted/floorMs/receivedMs, shared/commissionEffectiveDate.ts:86-118), so
  // `applied` here is byte-identical to the final pass and only the labels differ.
  // An existing row keeps its frozen basis and skips the probe entirely.
  const basis: QualificationBasis = existing?.qualification_basis && BASIS_COLUMN[existing.qualification_basis as QualificationBasis]
    ? (existing.qualification_basis as QualificationBasis)
    : resolveSaleBasis(
        tenantId, input.repId,
        resolveEffectiveDates(rawDates, { ...clampPolicy, basis: config.qualificationBasis }).basisTs ?? input.soldAt,
        config,
      );
  const basisColumn = BASIS_COLUMN[basis];
  // ONE resolver for every commission-relevant timestamp on every write path.
  // Only THIS pass may be written or audited — auditing the probe would
  // double-log every clamp and mislabel isBasisField.
  const dates = resolveEffectiveDates(rawDates, { ...clampPolicy, basis });
  auditEffectiveDateClamps(actorId, tenantId, input.externalId, dates, "upsertSale");
```

**(D) `commissionService.ts:857-863` — stop stamping the snapshot on UPDATE**

`COALESCE(commission_sales.qualification_basis, excluded.qualification_basis)` fires on `DO UPDATE` too. A legacy row that has **already been counted and paid** under the statement's resolver gets frozen with a possibly-different basis on the next metadata PATCH — which is precisely what `:93-97` promises cannot happen.

```ts
// BEFORE (:857-863)
     ON CONFLICT(tenant_id, external_id) DO UPDATE SET
       rep_id = excluded.rep_id, status = excluded.status, sold_at = excluded.sold_at,
       qualified_at = excluded.qualified_at, installed_at = excluded.installed_at,
       activated_at = excluded.activated_at, lead_id = excluded.lead_id,
       -- COALESCE, never excluded: the basis snapshot is write-once.
       qualification_basis = COALESCE(commission_sales.qualification_basis, excluded.qualification_basis),
       updated_at = excluded.updated_at
```
```ts
// AFTER
     ON CONFLICT(tenant_id, external_id) DO UPDATE SET
       rep_id = excluded.rep_id, status = excluded.status, sold_at = excluded.sold_at,
       qualified_at = excluded.qualified_at, installed_at = excluded.installed_at,
       activated_at = excluded.activated_at, lead_id = excluded.lead_id,
       -- qualification_basis is DELIBERATELY ABSENT. The snapshot is stamped on
       -- INSERT and never again. COALESCE(existing, excluded) protected a row
       -- that already HAD one, but it still stamped a LEGACY row on its first
       -- re-upsert — freezing a basis onto a sale the statement had already
       -- counted under a different one, from a metadata edit that touched
       -- nothing about the money. A NULL snapshot stays NULL and keeps resolving
       -- through fallbackBasisForRepWeek, which is what already counted it.
       updated_at = excluded.updated_at
```

**(E) `commissionService.ts:903-917` — the enumeration replaces the single tenant-fallback week**

```ts
// BEFORE (:903-917)
  // THE SALE'S OWN frozen basis — not the tenant's current setting. This line
  // read `config.qualificationBasis` while the statement counted by the plan
  // version's basis, which is exactly how a sale got recomputed into a week that
  // did not count it.
  const basisTs = basisTsForSale(sale, config.qualificationBasis);
  const weekStartUtc = weekBoundsFor(basisTs, config).weekStartUtc;

  overrides.syncOverridesForSale(tenantId, sale.id, actorId, weekStartUtc);

  let statement: any = null;
  try {
    statement = calculateOrRecalculateStatement({
      tenantId, repId: sale.rep_id, weekReference: basisTs, actorId, requestId,
    }).statement;
  } catch (e) { if (!expected(e)) throw e; }
```
```ts
// AFTER
  // THE SALE'S OWN frozen basis — and, for a legacy row, the basis the STATEMENT
  // resolves for the candidate week, not the tenant's current setting. The old
  // line still read `config.qualificationBasis` while the statement counted by
  // the plan version's, which is exactly how a sale got recomputed into a week
  // that did not count it. weeksCountingSale asks the counting question
  // directly, so the two can no longer be given different answers.
  const weeks = weeksCountingSale(tenantId, sale, config);
  // The upline earns in the week the rep is PAID in. `null` means no week counts
  // this sale (an INSTALLED_AT sale whose install is not confirmed yet), and
  // syncOverridesForSale then closes pairs without opening one — the earn week
  // is frozen by trg_cov_frozen and STICKY (overrideStore.ts:217), so booking it
  // into the wrong week is uncorrectable.
  const earnWeek = weeks[0]?.weekStartUtc ?? null;
  if (weeks.length > 1) {
    // A legacy row whose rep crossed a plan-version basis change: two statements
    // each legitimately count it under their own week's basis. Pre-existing —
    // BOTH already count it today — so surface it and recompute both rather than
    // silently refreshing one.
    structuredLog("commission_sale.basis_week_ambiguous",
      { tenantId, saleId: sale.id, repId: sale.rep_id, weeks: weeks.map(w => w.weekStartUtc) }, "warn");
  }

  overrides.syncOverridesForSale(tenantId, sale.id, actorId, earnWeek);

  let statement: any = null;
  for (const w of weeks) {
    try {
      const out = calculateOrRecalculateStatement({
        tenantId, repId: sale.rep_id, weekReference: w.weekStartUtc, actorId, requestId,
      }).statement;
      statement ??= out;
    } catch (e) { if (!expected(e)) throw e; }
  }
```

**(F) `server/overrideStore.ts:171-193` — nullable earn week + the earn gate**

```ts
// BEFORE (:171-179)
 * `weekStartUtc` is the sale's pay week (computed by the caller from the org
 * config — the same week the downline's statement uses).
 */
export function syncOverridesForSale(
  tenantId: number,
  saleId: number,
  actorId: number | null,
  weekStartUtc: string,
): void {
```
```ts
// AFTER
 * `weekStartUtc` is the week the downline's statement COUNTS this sale in,
 * resolved by the caller through the sale's own basis (never the org config —
 * that docstring was false, and it is how the earn week drifted from the week
 * the rep was actually paid in). NULL means no week counts the sale at all.
 */
export function syncOverridesForSale(
  tenantId: number,
  saleId: number,
  actorId: number | null,
  weekStartUtc: string | null,
): void {
```
```ts
// BEFORE (:191-194)
  if (sale.status === "QUALIFIED") {
    const { enabled, rates: orgRates } = loadOverrideRates(tenantId);
    if (!enabled) return; // org kill-switch — earns only accrue while on
```
```ts
// AFTER
  if (sale.status === "QUALIFIED") {
    const { enabled, rates: orgRates } = loadOverrideRates(tenantId);
    if (!enabled) return; // org kill-switch — earns only accrue while on
    // The rep must be credited SOMEWHERE before an upline can be paid for it.
    // A null week means the sale counts in no week (basis column unstamped), and
    // earning here would pay the upline for a door the rep is paid $0 for — into
    // a week nothing reconciles, permanently: earned_week_start_utc is frozen by
    // trg_cov_frozen and a later sync is a no-op once the pair is open (:217).
    // The pair opens on the next reconcile, once the basis column is stamped.
    if (weekStartUtc == null) return;
```
The claw path (`:245-282`) is deliberately left unconditional — it binds `earn.earned_week_start_utc` (`:276`), not the passed week, and must keep working for a sale whose basis column is later cleared.

**(G) `commissionService.ts:946` — transitionSale's basis**

```ts
// BEFORE
  const saleBasis = basisForSale(sale, cfgForDates.qualificationBasis);
```
```ts
// AFTER
  const saleBasis = saleBasisResolved(tenantId, sale, cfgForDates);
```

**(H) `commissionService.ts:1652-1687` — week overview, per rep**

```ts
// BEFORE (:1652-1655, :1687)
  for (const rep of reps as any[]) {
    // Per-status sale counts for the week (basis column from org config).
    // Per-sale basis snapshot, with the org default as the legacy fallback.
  const basisCol = basisTsExpr("", config.qualificationBasis);
    ...
      installHold: installHeldSalesForWeek(tenantId, rep.id, config.qualificationBasis, bounds),
```
```ts
// AFTER
  for (const rep of reps as any[]) {
    // Per-status sale counts for the week. Per-sale basis snapshot, with THIS
    // REP'S plan version for this week as the legacy fallback — the console must
    // count a sale in the same week the statement pays it in.
    const repBasis = fallbackBasisForRepWeek(tenantId, rep.id, bounds, config);
    const basisCol = basisTsExpr("", repBasis);
    ...
      installHold: installHeldSalesForWeek(tenantId, rep.id, repBasis, bounds),
```
(Also fixes the stray 2-space indent on the existing `const basisCol` line.)

**(I) `commissionService.ts:1741-1746` — the late-reversal probe reads the LOCKED statement's own basis**

This branch already holds `existing`, whose `qualification_basis` is `NOT NULL` and is the exact basis that produced the frozen number (`:572`). No fallback needed — exact by construction.

```ts
// BEFORE
        const lateReversals = rawDb.prepare(
          `SELECT COUNT(*) AS c FROM commission_sales
           WHERE tenant_id = ? AND rep_id = ? AND status = 'REVERSED'
             AND COALESCE(${basisCol}, sold_at) >= ? AND COALESCE(${basisCol}, sold_at) < ?
             AND reversed_at > ?`
```
```ts
// AFTER
        // Placed by the basis THIS LOCKED STATEMENT was computed with, not by a
        // fallback: commission_statements.qualification_basis is NOT NULL and is
        // stamped with the resolved basis at :572, so this cannot drift. Using
        // the live fallback meant a reversed legacy sale was never found in the
        // week that locked it, and the clawback prompt never fired.
        const lockedBasisCol = basisTsExpr("", basisOfVersion({ qualification_basis: existing.qualification_basis }, config));
        const lateReversals = rawDb.prepare(
          `SELECT COUNT(*) AS c FROM commission_sales
           WHERE tenant_id = ? AND rep_id = ? AND status = 'REVERSED'
             AND COALESCE(${lockedBasisCol}, sold_at) >= ? AND COALESCE(${lockedBasisCol}, sold_at) < ?
             AND reversed_at > ?`
```

**(J) `commissionService.ts:1913-1918` — FINALIZE ensure sweep, additive union**

The primary query stays byte-identical (dropping its `COALESCE(..., sold_at)` would *shrink* closeout scope and strand reps who get a statement today). A second, restricted pass adds only the reps the tenant fallback misses, **verified per rep** so nothing is over-enumerated — over-enumeration is not free here: the lock loop at `:1977` FINALIZES whatever it finds, and `GUARD 3` then 409s later field writes into that now-locked $0 week.

```ts
// BEFORE (:1913-1919)
    const salesByRep = rawDb.prepare(
      `SELECT rep_id AS repId, COUNT(*) AS c FROM commission_sales
       WHERE tenant_id = ? AND status = 'QUALIFIED'
         AND COALESCE(${basisCol}, sold_at) >= ? AND COALESCE(${basisCol}, sold_at) < ?
       GROUP BY rep_id`
    ).all(tenantId, bounds.weekStartUtc, bounds.nextWeekStartUtc) as any[];
    for (const s of salesByRep) {
```
```ts
// AFTER
    const salesByRep = rawDb.prepare(
      `SELECT rep_id AS repId, COUNT(*) AS c FROM commission_sales
       WHERE tenant_id = ? AND status = 'QUALIFIED'
         AND COALESCE(${basisCol}, sold_at) >= ? AND COALESCE(${basisCol}, sold_at) < ?
       GROUP BY rep_id`
    ).all(tenantId, bounds.weekStartUtc, bounds.nextWeekStartUtc) as any[];
    // This is the ONLY thing guaranteeing a statement EXISTS before the lock
    // loop, and it interpolates ONE basis into a tenant-wide scan — so it
    // resolves legacy rows by the TENANT fallback while the statement that would
    // be created resolves them by the PLAN VERSION's. A rep whose only qualified
    // sales this week are legacy rows the tenant basis places OUTSIDE the week is
    // never enumerated, gets no statement row, is not seen by the lock loop at
    // :1973, and is absent from `results` and `summary` entirely — the week
    // closes clean and NACHA has no line for them.
    //
    // ADDITIVE ONLY: no rep loses a statement they get today. Each candidate is
    // verified against the statement's own resolver before being added, because
    // over-enumerating FINALIZES a $0 week that GUARD 3 then 409s field writes
    // into. A no-op for any tenant whose plan versions all share the org basis.
    const seen = new Set<number>(salesByRep.map(s => Number(s.repId)));
    const divergentBases = (rawDb.prepare(
      `SELECT DISTINCT qualification_basis AS b FROM commission_plan_versions WHERE tenant_id = ?`,
    ).all(tenantId) as any[])
      .map(r => r.b as QualificationBasis)
      .filter(b => BASIS_COLUMN[b] && b !== config.qualificationBasis);
    for (const b of divergentBases) {
      const col = BASIS_COLUMN[b];   // from BASIS_COLUMN, never caller input
      for (const r of rawDb.prepare(
        `SELECT DISTINCT rep_id AS repId FROM commission_sales
          WHERE tenant_id = ? AND status = 'QUALIFIED' AND qualification_basis IS NULL
            AND ${col} IS NOT NULL AND ${col} >= ? AND ${col} < ?`,
      ).all(tenantId, bounds.weekStartUtc, bounds.nextWeekStartUtc) as any[]) {
        if (seen.has(Number(r.repId))) continue;
        if (fallbackBasisForRepWeek(tenantId, Number(r.repId), bounds, config) !== b) continue;
        seen.add(Number(r.repId));
        salesByRep.push({ repId: Number(r.repId), c: 0 });
      }
    }
    for (const s of salesByRep) {
```

**(K) `commissionService.ts:2068-2072` — `listWeekSalesForRep`**

This output is frozen into `contributing_sales` at `:1136` — the permanent evidence of which doors composed a locked number, and `shared/commissionStatement.ts:206` divides the statement's gross across exactly these rows.

```ts
// BEFORE (:2069-2072)
  const config = loadOrgConfig(tenantId);
  const bounds = weekBoundsFor(weekReference, config);
  // Per-sale basis snapshot, with the org default as the legacy fallback.
  const csBasis = basisTsExpr("cs", config.qualificationBasis);
```
```ts
// AFTER
  const config = loadOrgConfig(tenantId);
  const bounds = weekBoundsFor(weekReference, config);
  // Per-sale basis snapshot, with THIS REP'S plan version for this week as the
  // legacy fallback — the same fallback countQualifiedSales uses. This list is
  // frozen into contributing_sales on FINALIZE (:1136) and the statement's gross
  // is ALLOCATED across it (shared/commissionStatement.ts:206), so a list built
  // on a different fallback than the count prints a per-door rate that appears
  // on no plan version, permanently.
  const csBasis = basisTsExpr("cs", fallbackBasisForRepWeek(tenantId, repId, bounds, config));
```

### 1.5 What happens to LEGACY NULL-snapshot rows

**They keep counting exactly as they do today. Nothing re-weeks them, and no backfill runs.**

The count comes from `countQualifiedSales` via `:498`, which has *always* used the plan version's basis. This patch does not touch `:498`'s value — it only makes the other six sites agree with it. So `qualified_sale_count`, `gross_commission_cents` and `final_commission_cents` are unchanged for every existing row on every existing week.

What moves is which week gets **recomputed**, which reps get **enumerated**, and which doors get **listed** — all of them moving *toward* the week that already counts the money. Change (D) additionally guarantees a legacy row can never be stamped after the fact, so it stays on the fallback path forever, which is the safe state.

---

## 2. P0-B — the transitionSale path

### 2.1 The clamp is already shared. The GUARD is not.

`upsertSale` refuses a QUALIFIED write into a settled week (`GUARD 3`, `:839-851`). `transitionSale`'s QUALIFY (`:955-956`) writes `status='QUALIFIED', qualified_at=COALESCE(qualified_at, ?)` with no equivalent, and `reconcileSaleSideEffects` then **swallows** the resulting `STATEMENT_LOCKED` (`:901-902`, `:917`) — the caller gets a 200 and the row lands QUALIFIED inside a locked week with no error anywhere. `recordFieldSaleFromKnock:1488-1499` and `backfillFieldSales:1538-1553` both implement the guard (they book PENDING instead); transitionSale is the only QUALIFY path without it. Its own comment at `:736-737` claims the guards *"live HERE now, at the single write site, so no present or future caller can bypass them"* — transitionSale is the caller that bypasses them, because it never goes through `upsertSale`.

### 2.2 Hoist GUARD 3 to a module-level shared function

Insert after `auditEffectiveDateClamps` (`:727`):

```ts
/**
 * The single locked-week gate for every path that can make a sale COUNTABLE.
 *
 * Injecting QUALIFIED money into a FINALIZED/PAID week either fails the
 * recalculation outright or — worse — sits latent inside the settled week and
 * surfaces on the next recompute, re-pricing a whole retroactive week that
 * nobody asked to change and that no adjustment row explains. This lived inline
 * in upsertSale, so `POST /api/commission/sales/:externalId/transition` — the
 * OTHER door onto the same column — accepted exactly the payload the sales route
 * refused, then swallowed the STATEMENT_LOCKED that followed. Hoisted for the
 * same reason resolveEffectiveDates was: two implementations of one money rule
 * is one implementation too many.
 */
function assertWeekOpenForQualify(
  tenantId: number, repId: number, basisTs: string, config: OrgCommissionConfig,
  actorId: number | null, externalId: string, saleId: number | null,
): void {
  const target = weekBoundsFor(basisTs, config).weekStartUtc;
  const lockedStmt = rawDb.prepare(
    `SELECT status FROM commission_statements WHERE tenant_id = ? AND rep_id = ? AND week_start_utc = ?`,
  ).get(tenantId, repId, target) as any;
  if (lockedStmt && (lockedStmt.status === "FINALIZED" || lockedStmt.status === "PAID")) {
    storage.logActivity(actorId, "commission_sale.locked_week_blocked", "commission_sale", saleId ?? undefined,
      { externalId, repId, weekStartUtc: target, status: lockedStmt.status }, undefined);
    throw new CommissionError("STATEMENT_LOCKED",
      `Week ${target} is ${lockedStmt.status} for rep ${repId} — book the sale PENDING and qualify it in an open correction period.`, 409);
  }
}
```

**`upsertSale:836-851` — behaviour-identical refactor.** Same query, same message string, same activity event and payload keys, same `existing?.id`.

```ts
// BEFORE (:836-851)
  // ── GUARD 3: never inject QUALIFIED money into a locked week. It would either
  // fail the recalculation outright or sit latent inside a PAID week and surface
  // on the next recompute. A manager qualifies it into an open correction period.
  if (status === "QUALIFIED") {
    const basisTs = basisOf(incomingRow) || soldAt;
    const target = weekBoundsFor(basisTs, config).weekStartUtc;
    const lockedStmt = rawDb.prepare(
      `SELECT status FROM commission_statements WHERE tenant_id = ? AND rep_id = ? AND week_start_utc = ?`,
    ).get(tenantId, input.repId, target) as any;
    if (lockedStmt && (lockedStmt.status === "FINALIZED" || lockedStmt.status === "PAID")) {
      storage.logActivity(actorId, "commission_sale.locked_week_blocked", "commission_sale", existing?.id,
        { externalId: input.externalId, repId: input.repId, weekStartUtc: target, status: lockedStmt.status }, undefined);
      throw new CommissionError("STATEMENT_LOCKED",
        `Week ${target} is ${lockedStmt.status} for rep ${input.repId} — book the sale PENDING and qualify it in an open correction period.`, 409);
    }
  }
```
```ts
// AFTER
  // ── GUARD 3: never inject QUALIFIED money into a locked week. It would either
  // fail the recalculation outright or sit latent inside a PAID week and surface
  // on the next recompute. A manager qualifies it into an open correction period.
  // Shared with transitionSale's QUALIFY, which is the other door onto this same
  // column and enforced nothing.
  if (status === "QUALIFIED") {
    assertWeekOpenForQualify(
      tenantId, input.repId, basisOf(incomingRow) || soldAt, config,
      actorId, input.externalId, existing?.id ?? null,
    );
  }
```

### 2.3 `transitionSale` — which timestamps actually need clamping

**Only `qualified_at`, and only when the sale's frozen basis is `QUALIFIED_AT`.**

- `qualified_at` **places a pay week**: `BASIS_COLUMN.QUALIFIED_AT = "qualified_at"` (`:69`), so `basisTsExpr`/`countQualifiedSales` select it directly. That is the shipped default and tenant 1's setting. It must be clamped, and it must be audited as a basis-field clamp.
- `reversed_at` **places no pay week under any basis** — `BASIS_COLUMN` has no entry for it, `loadOrgConfig:181` rejects any basis outside those four, so no config can select it. Its only value comparison is `reversed_at > finalized_at` at `:1745`. Clamping it forward is protective (it makes `REVERSED_AFTER_FINALIZE` *more* likely to fire), so keep the clamp — but it must **never** be labelled a basis field.

The current code keys the resolver input on `BASIS_FIELD_INPUT[saleBasis]` (`:949`) — the *basis* field, not the field being *written*. Consequences today: a REVERSE under `QUALIFIED_AT` logs `field: "qualifiedAt", isBasisField: true, payWeekMoved: true` at **warn** for a write to `reversed_at`; and DISQUALIFY/CANCEL, which bind `at` to nothing at all, emit the same warn-level record.

**Enabling change — `shared/commissionEffectiveDate.ts`.** Five lines, additive, in a pure module. `BASIS_FIELD` deliberately never maps to `reversedAt`, so `isBasisField` is structurally always false for it.

```ts
// :22-27 — add the field
export interface EffectiveDateInput {
  soldAt?: string | null;
  qualifiedAt?: string | null;
  installedAt?: string | null;
  activatedAt?: string | null;
  /** Audit-only. NEVER a basis field — BASIS_FIELD has no entry for it, and
   *  server BASIS_COLUMN has no `reversed_at`, so no configuration can make
   *  this timestamp place a pay week. Clamped so an audit trail cannot be
   *  backdated past the correction window; labelled honestly as non-basis. */
  reversedAt?: string | null;
}

// :48 — widen the record
  field: "soldAt" | "qualifiedAt" | "installedAt" | "activatedAt" | "reversedAt";

// :121-126 — resolve it alongside the rest
  const applied = {
    soldAt: resolve("soldAt", input.soldAt),
    qualifiedAt: resolve("qualifiedAt", input.qualifiedAt),
    installedAt: resolve("installedAt", input.installedAt),
    activatedAt: resolve("activatedAt", input.activatedAt),
    reversedAt: resolve("reversedAt", input.reversedAt),
  } as Required<EffectiveDateInput>;
```

**`transitionSale:947-963`:**

```ts
// BEFORE (:947-963)
  const resolvedAt = opts?.at
    ? resolveEffectiveDates(
        { [BASIS_FIELD_INPUT[saleBasis]]: opts.at } as any,
        { basis: saleBasis, correctionWindowDays: cfgForDates.correctionWindowDays, serverReceivedAt: now },
      )
    : null;
  if (resolvedAt) auditEffectiveDateClamps(actorId, tenantId, externalId, resolvedAt, `transitionSale:${action}`);
  const at = resolvedAt ? (resolvedAt.basisTs ?? now) : now;
  if (action === "QUALIFY") {
    rawDb.prepare(`UPDATE commission_sales SET status='QUALIFIED', qualified_at=COALESCE(qualified_at, ?), updated_at=? WHERE id=?`).run(at, now, sale.id);
  } else if (action === "REVERSE") {
    rawDb.prepare(`UPDATE commission_sales SET status='REVERSED', reversed_at=?, updated_at=? WHERE id=?`).run(at, now, sale.id);
  } else if (action === "DISQUALIFY") {
    rawDb.prepare(`UPDATE commission_sales SET status='DISQUALIFIED', disqualification_reason=?, updated_at=? WHERE id=?`).run(opts?.reason ?? null, now, sale.id);
  } else {
    rawDb.prepare(`UPDATE commission_sales SET status='CANCELLED', updated_at=? WHERE id=?`).run(now, sale.id);
  }
```
```ts
// AFTER
  // `at` resolves as the column it is WRITTEN to, not as BASIS_FIELD[saleBasis].
  // Keying on the basis field labelled a REVERSE's reversed_at as a qualifiedAt
  // BASIS-field clamp — warn level, payWeekMoved: true — for a write that
  // touches no basis column at all, and audited a clamp for DISQUALIFY/CANCEL,
  // which bind `at` nowhere.
  const atField: "qualifiedAt" | "reversedAt" | null =
    action === "QUALIFY" ? "qualifiedAt" : action === "REVERSE" ? "reversedAt" : null;
  const resolvedAt = (opts?.at && atField)
    ? resolveEffectiveDates(
        { [atField]: opts.at } as any,
        { basis: saleBasis, correctionWindowDays: cfgForDates.correctionWindowDays, serverReceivedAt: now },
      )
    : null;
  if (resolvedAt) auditEffectiveDateClamps(actorId, tenantId, externalId, resolvedAt, `transitionSale:${action}`);
  const at = (resolvedAt && atField ? ((resolvedAt.applied as any)[atField] as string | null) : null) ?? now;
  if (action === "QUALIFY") {
    // Probe the value that will actually be WRITTEN. The UPDATE is
    // COALESCE(qualified_at, ?), so a sale that already carries a qualified_at
    // (QUALIFIED → REVERSED → re-QUALIFY, the routine correction flow) returns
    // to its ORIGINAL week and `at` is discarded entirely. Probing `at` would
    // test an open week and wave the write through — and that path needs no
    // backdating at all, which makes it the reachable one.
    const projected = { ...sale, qualified_at: sale.qualified_at ?? at };
    assertWeekOpenForQualify(
      tenantId, sale.rep_id, basisTsForSale(projected, saleBasis), cfgForDates,
      actorId, externalId, sale.id,
    );
    rawDb.prepare(`UPDATE commission_sales SET status='QUALIFIED', qualified_at=COALESCE(qualified_at, ?), updated_at=? WHERE id=?`).run(at, now, sale.id);
  } else if (action === "REVERSE") {
    // Deliberately NOT guarded: reversing a sale in a settled week is the
    // sanctioned path, and it is what raises OVERRIDE_REVERSED_AFTER_FINALIZE
    // (overrideStore.ts:251-253) and the REVERSED_AFTER_FINALIZE console
    // exception (:1748) that a manager acts on. Same for DISQUALIFY/CANCEL.
    rawDb.prepare(`UPDATE commission_sales SET status='REVERSED', reversed_at=?, updated_at=? WHERE id=?`).run(at, now, sale.id);
  } else if (action === "DISQUALIFY") {
    rawDb.prepare(`UPDATE commission_sales SET status='DISQUALIFIED', disqualification_reason=?, updated_at=? WHERE id=?`).run(opts?.reason ?? null, now, sale.id);
  } else if (action === "CANCEL") {
    rawDb.prepare(`UPDATE commission_sales SET status='CANCELLED', updated_at=? WHERE id=?`).run(now, sale.id);
  } else {
    // Was a bare `else`, so EVERY non-matching action — undefined, "", lowercase
    // "qualify", a typo — fell through to CANCELLED, dropping the sale out of
    // countQualifiedSales and re-pricing the whole retroactive week. Nothing in
    // this repo ever passes "CANCEL"; the branch existed only as that trapdoor.
    throw new CommissionError("INVALID_ADJUSTMENT", `Unknown sale transition: ${String(action)}`);
  }
```

The throw precedes `logActivity` (`:964`) and `reconcileSaleSideEffects` (`:970`), so a rejected action mutates nothing, logs nothing, and recomputes nothing. `CommissionError` defaults to 400 (`:41`) and `fail()` maps it at `commissionRoutes.ts:54`.

Also reuse the already-loaded config at `:971` (`loadOrgConfig(tenantId)` → `cfgForDates`) — one redundant read on every transition.

### 2.4 The route — `commissionRoutes.ts:361-367`

```ts
// BEFORE
  app.post("/api/commission/sales/:externalId/transition", requireCapability("commission.sales.write"), (req, res) => {
    const { action, at, reason } = req.body || {};
    const sale = svc.getSaleByExternalId(tid(req), String(req.params.externalId));
    if (!sale) return res.status(404).json({ error: "Sale not found" });
    if (denyOutOfScope(req, res, sale.rep_id)) return;
    try { res.json(svc.transitionSale(tid(req), uid(req), String(req.params.externalId), action, { at, reason })); } catch (e) { fail(res, e); }
  });
```
```ts
// AFTER
  app.post("/api/commission/sales/:externalId/transition", requireCapability("commission.sales.write"), (req, res) => {
    const { action, at, reason } = req.body || {};
    // Validate the action ENUM FIRST — before the lookup, so a malformed request
    // costs no DB read and cannot probe which externalIds exist. `req.body` is
    // `any`, so the TS union is not enforced at runtime and an unknown or ABSENT
    // action used to fall through transitionSale's bare `else` to CANCELLED,
    // silently deleting a door and re-pricing the retroactive week. The sibling
    // statement route (:597-601) has always guarded exactly this class.
    if (!["QUALIFY", "REVERSE", "DISQUALIFY", "CANCEL"].includes(action)) {
      return res.status(400).json({ error: "action must be QUALIFY, REVERSE, DISQUALIFY, or CANCEL" });
    }
    const sale = svc.getSaleByExternalId(tid(req), String(req.params.externalId));
    if (!sale) return res.status(404).json({ error: "Sale not found" });
    if (denyOutOfScope(req, res, sale.rep_id)) return;
    // NOTE: no serverReceivedAt, deliberately. transitionSale stamps its own from
    // nowIso() (:936) and passes it as the receipt time, which is a STRICTLY
    // STRONGER contract than upsertSale's — where an absent serverReceivedAt
    // means "trusted in-process caller, no clamp". Accepting one here would give
    // an HTTP caller a switch to widen (or disable) its own correction window,
    // which is precisely what the comment on the sales route (:353-356) warns
    // against. Pass `at` and `reason` only.
    try { res.json(svc.transitionSale(tid(req), uid(req), String(req.params.externalId), action, { at, reason })); } catch (e) { fail(res, e); }
  });
```

Bare `includes(action)` — not `String(action)` — so `null`, `undefined`, numbers and objects all fail closed, matching `:599`.

---

## 3. Ordering

**Ship P0-B first, as its own PR. They are independent** — P0-B touches the locked-week guard, the action enum, and the clamp field label; it reads no basis fallback. The one line they both touch is `transitionSale`'s `saleBasis` (`:946`), and P0-B leaves it alone.

| # | Change | Blocks |
|---|---|---|
| **PR 1 — P0-B** | | |
| B1 | `shared/commissionEffectiveDate.ts` — add `reversedAt` | B3 |
| B2 | Hoist `assertWeekOpenForQualify`; `upsertSale` calls it (no-op refactor) | B4 |
| B3 | `transitionSale` — `atField`, honest audit labels | — |
| B4 | `transitionSale` QUALIFY — the guard; terminal throw for unknown action | — |
| B5 | Route — validate `action`; do **not** stamp `serverReceivedAt` | — |
| **PR 2 — P0-A** | | |
| A1 | `basisOfVersion` + `fallbackBasisForRepWeek` + `saleBasisResolved` + `weeksCountingSale`; `:498` and `resolveSaleBasis` call them | everything |
| A2 | `:862` — drop the snapshot from `DO UPDATE SET` | A3 |
| A3 | `:777-788` — resolve the snapshot from the clamped instant | — |
| A4 | `:903-917` + `overrideStore.ts:174/191` — enumeration + nullable earn week | — |
| A5 | `:946`, `:1655`/`:1687`, `:1741`, `:2072` — per-rep fallback | — |
| A6 | `:1913-1918` — additive union in the FINALIZE sweep | — |

Within PR 2, **A2 and A4 must land together.** A2 alone leaves legacy rows exposed to the `:907`-vs-`:498` split; A4 alone leaves `:862` free to freeze a divergent basis on the next re-post. A6 is the only piece that changes closeout *scope* — if it needs to be split out, split it after A1–A5, never before.

---

## 4. Tests

### 4.1 The pinning test — `tests/integration/commission-side-effects.test.ts`

**`describe("qualification basis has one source of truth")` (`:561-664`) must not change, and it will not.** Every sale in it is written through `svc.upsertSale`, so `qualification_basis` is always stamped (`:613` asserts exactly that). The stamped short-circuit in `weeksCountingSale` makes A4 byte-identical for it, and A2 only affects rows whose snapshot is NULL. `:616-632` re-upserts `div-1`, which is already stamped, so the frozen-basis branch at `:777-778` still short-circuits and A3's probe never runs.

**That is also its blind spot**: the block has *zero* coverage of the NULL-snapshot fallback — the only part of the divergence still live. Add:

```ts
it("a LEGACY row is recomputed into the week that COUNTS it, not the tenant-basis week", () => {
  // Org SOLD_AT, plan version QUALIFIED_AT — the divergence the fallback hid.
  const rep = person("Legacy Divergent", "rep", null, T_DIV).memberId;
  svc.assignStructureToRep(T_DIV, 1, { repId: rep, structure: "FLAT", flatRateCents: 20000, effectiveFrom: "2026-01-01" });
  const plan = /* plan id for rep */;
  svc.addPlanVersion(T_DIV, 1, plan, { effectiveFrom: "2026-01-01", flatRateCents: 20000, qualificationBasis: "QUALIFIED_AT" });
  svc.updateOrgConfig(T_DIV, null, { commissionQualificationBasis: "SOLD_AT" } as any);

  const soldTs = "2026-11-01T23:00:00.000Z";      // Sunday — week W1 under SOLD_AT
  const qualTs = "2026-11-02T15:00:00.000Z";      // Monday  — week W2 under QUALIFIED_AT
  svc.upsertSale(T_DIV, 1, { repId: rep, externalId: "legacy-div", status: "QUALIFIED", soldAt: soldTs, qualifiedAt: qualTs });
  rawDb.prepare(`UPDATE commission_sales SET qualification_basis = NULL WHERE external_id = ?`).run("legacy-div");

  const cfg = svc.loadOrgConfig(T_DIV);
  const w1 = weekBoundsFor(soldTs, cfg).weekStartUtc;
  const w2 = weekBoundsFor(qualTs, cfg).weekStartUtc;
  expect(w1).not.toBe(w2);

  svc.transitionSale(T_DIV, 1, "legacy-div", "QUALIFY");   // drives reconcileSaleSideEffects

  // The week the PLAN VERSION counts it in is the week that got recomputed.
  const at = (w: string) => rawDb.prepare(
    `SELECT qualified_sale_count AS n, gross_commission_cents AS c FROM commission_statements
      WHERE tenant_id = ? AND rep_id = ? AND week_start_utc = ?`).get(T_DIV, rep, w) as any;
  expect(at(w2)?.n).toBe(1);
  expect(at(w2)?.c).toBe(20000);
  expect(at(w1)?.c ?? 0).toBe(0);
});

it("a legacy row is NOT stamped by a later re-upsert — the snapshot is INSERT-once", () => {
  svc.upsertSale(T_DIV, 1, { repId: /* same rep */, externalId: "legacy-div", status: "QUALIFIED", soldAt: soldTs, qualifiedAt: qualTs });
  expect(svc.getSaleByExternalId(T_DIV, "legacy-div").qualification_basis).toBeNull();
});

it("the upline earns in the week the rep is PAID in, not the sold_at week", () => {
  // Same legacy setup with overrides on: assert commission_overrides
  // .earned_week_start_utc === w2, the week the statement counted the sale.
});

it("a sale whose basis column is unstamped counts in NO week and pays NO upline", () => {
  // INSTALLED_AT tenant + version, QUALIFIED sale with installed_at NULL.
  // countQualifiedSales excludes it (:348); assert no EARN row exists for the
  // upline, where today one is booked into the sold_at week and is STICKY.
});
```

### 4.2 `describe("every write path resolves dates the same way")` (`:675-803`) — mostly unchanged

- `:695-722` (THE EXPLOIT), `:724-735` (auditable clamp), `:737-758` (upsert ≡ transition) all run tenant `T_DATE` on the default `QUALIFIED_AT`, where `atField === "qualifiedAt" === BASIS_FIELD[saleBasis]`. `applied.qualifiedAt === basisTs`, `isBasisField` stays `true`, `payWeekMoved` stays `true`. `:732`'s `toMatchObject({ reason: "BEFORE_CORRECTION_WINDOW", isBasisField: true })` holds. **No change.**
- `:787-802` (idempotency) QUALIFYs into `2027-02-10`; the only finalized week in that fixture is `2027-01-06`, so the new guard passes. **No change.**
- **`:760-785` must be extended.** It is titled *"a caller cannot move a date that would alter a LOCKED week"* and asserts only against `svc.upsertSale` (`:775`). Add the transitionSale twin it implies:

```ts
    // …and the OTHER door refuses it too. `date-lock-3` is booked PENDING into
    // the same locked week, exactly as recordFieldSaleFromKnock:1493 would.
    svc.upsertSale(T_DATE, 1, { repId: dRep.memberId, externalId: "date-lock-3", status: "PENDING", soldAt: lockTs });
    let tErr: any;
    try { svc.transitionSale(T_DATE, 1, "date-lock-3", "QUALIFY", { at: lockTs }); } catch (e) { tErr = e; }
    expect(tErr?.code).toBe("STATEMENT_LOCKED");

    // The no-`at` reverse-then-re-qualify variant, which needs no backdating:
    // COALESCE(qualified_at, ?) returns the sale to its ORIGINAL locked week.
    svc.upsertSale(T_DATE, 1, { repId: dRep.memberId, externalId: "date-lock-4", status: "QUALIFIED", soldAt: openTs, qualifiedAt: lockTs });
    // (booked before the lock in the fixture) → REVERSE → re-QUALIFY with no opts
    let rErr: any;
    try { svc.transitionSale(T_DATE, 1, "date-lock-4", "QUALIFY"); } catch (e) { rErr = e; }
    expect(rErr?.code).toBe("STATEMENT_LOCKED");

    expect(after).toEqual(frozen);   // locked totals still byte-identical
```

### 4.3 New route test — `tests/integration/commission-statement-doc.test.ts` (or a routes suite)

Nothing in the repo drives the transition route with a malformed body; the CANCEL branch has **never been executed by any test**.

```ts
it("rejects an unknown or absent action instead of silently CANCELling the sale", async () => {
  const before = /* statement gross for the sale's week */;
  await request(app).post("/api/commission/sales/lead-x/transition").send({}).expect(400);
  await request(app).post("/api/commission/sales/lead-x/transition").send({ action: "qualify" }).expect(400);
  expect(svc.getSaleByExternalId(T, "lead-x").status).toBe("QUALIFIED");   // untouched
  expect(/* gross now */).toBe(before);
});
it("CANCEL is honoured explicitly and re-prices the week", () => { /* the branch nobody has run */ });
```

### 4.4 `tests/integration/commission-basis-migration.test.ts` — **strengthen, do not weaken**

This suite currently *encodes the correct decision* and every assertion survives:
- `:64-70` "nullable — no backfill required to deploy" — still true; this patch adds no backfill.
- `:72-86` "a legacy NULL-snapshot sale counts EXACTLY as it did" — still true; `:498` is unchanged in value.
- `:88-112` "a LOCKED statement is byte-identical" — still true.
- `:114-123` "the migration adopts nothing retroactively" — **strengthened** by A2, which removes the one path (`:862` on `DO UPDATE`) that could have adopted a legacy row after the fact. Add an assertion that a re-upsert of `legacy-1` leaves the snapshot NULL.

### 4.5 Suites to run and watch

`commission-side-effects.test.ts`, `commission-service.test.ts` (`:421/:432/:440/:457/:573` assert on `listWeekSalesForRep`; `:560-566` asserts the second FINALIZE run yields `already*`; `:613-615` correction window), `commission-basis-migration.test.ts`, `override-pipeline.test.ts` (`:183/:320/:405/:453` all do reverse-then-re-QUALIFY — the FINALIZED statement there belongs to the *upline* while the guard keys on `sale.rep_id`, so they should pass, but run them first), `commission-statement-doc.test.ts`, `commission-reconciliation.test.ts`, `pay-a2.test.ts`, `reserve-ledger.test.ts`, `tests/unit/commission-effective-date.test.ts`.

Per the repo's own constraint: `DATA_DIR=$(mktemp -d) npm test` — the 1 GB dev `data.db` makes timing-sensitive tests fail and would mask a real regression.

**Silent-no-op warning:** on every tenant where the version basis equals the tenant basis — the default, and the *only* shape in `data.db` (tenant 1 and all three plan versions are `QUALIFIED_AT`) — the entire P0-A change is unobservable. Verification **must** construct a tenant with a deliberately mismatched plan-version basis **and** rows with NULL `qualification_basis`, or the change ships untested while appearing green.

---

## 5. Migration / live-data impact

**No backfill. None is needed and none is safe.**

Verified against `data.db`: `commission_sales` has 15 columns ending at `house_amount_cents` — `qualification_basis` does not exist yet. On first boot after deploy, `storage.ts:978` adds it and **every existing row is NULL**. That is the intended state, and the unified fallback is what makes it safe: a NULL-snapshot row resolves through `fallbackBasisForRepWeek`, which returns exactly the basis `:498` has always counted it with. Counting behaviour is unchanged for every existing row and every existing week.

**Sales written between now and deploy** get their snapshot on INSERT and are immune to every fallback path. With change (A2), sales written *before* deploy stay NULL permanently and never get retro-stamped.

**Any window where money could be double-counted or lost?** Three, all named:

1. **A legacy row counted in two weeks.** If a rep's plan versions changed basis between two candidate weeks, two statements each count the sale under their own week's basis. This is **pre-existing** — both statements already count it today — and the enumeration surfaces it (`commission_sale.basis_week_ambiguous`, warn) and recomputes both, where today it recomputes at most one. It does not create the double count. Sweep before deploy:
   ```sql
   SELECT tenant_id, COUNT(DISTINCT qualification_basis) FROM commission_plan_versions GROUP BY tenant_id HAVING COUNT(DISTINCT qualification_basis) > 1;
   ```
   On `data.db` this returns zero rows.

2. **Override earns already booked into a wrong week.** `earned_week_start_utc` is frozen by `trg_cov_frozen` (`overrideStore.ts:87-98`) and the ledger is append-only, so change (F) prevents new ones but cannot repair old ones. Sweep read-only:
   ```sql
   SELECT o.id, o.beneficiary_rep_id, o.earned_week_start_utc, cs.external_id, cs.sold_at, cs.qualified_at, cs.installed_at
     FROM commission_overrides o JOIN commission_sales cs ON cs.id = o.sale_id
    WHERE o.entry_type = 'EARN' AND cs.qualification_basis IS NULL;
   ```
   Currently zero exposure: tenant 1 has `commission_override_enabled = 1` with both rate columns at $0.

3. **Accidental CANCELs already in production.** No legitimate caller ever emits `CANCEL` (grep: only `"REVERSE"` from `reverseFieldSale:1509` and `"QUALIFY"` from tests). Before deploy, treat every row returned by
   ```sql
   SELECT tenant_id, rep_id, external_id, qualified_at, updated_at FROM commission_sales WHERE status='CANCELLED';
   ```
   as a candidate fat-finger, cross-checked against `commission_sale.transitioned` in the activity log. Currently zero: all 13 rows are `REVERSED`.

**Sequencing constraint:** all of this must land **before** any tenant is switched to `INSTALLED_AT`/`ACTIVATED_AT` or given a plan version whose basis differs from the org's. After that point, misplaced override earns are uncorrectable in place — only offsettable through the manager-adjustment rail.

---

## 6. What NOT to do

1. **Do not backfill `commission_sales.qualification_basis`.** It is the one change in this whole area that can move historical money: it rewrites which week every legacy row belongs to, and `:1753`/`:2008` will re-price OPEN weeks with the new placement. It is also unresolvable for a rep whose applicable plan versions disagree on basis (the statement resolves by *week start*, `resolveSaleBasis` by *instant* — there is no non-circular answer). The tree already encodes the no-backfill decision in three places: `commissionService.ts:93-97`, `storage.ts:971-977`, and `commission-basis-migration.test.ts:64-70` / `:114-123`. Unifying the fallback makes the backfill unnecessary.

2. **Do not add `COALESCE(..., sold_at)` to `countQualifiedSales:348`.** Under an `INSTALLED_AT`/`ACTIVATED_AT` org it would make every not-yet-installed QUALIFIED sale immediately payable in its `sold_at` week — defeating the entire purpose of an install-based basis, directly contradicting GUARD 2's own rationale at `:809-814`, and silently re-pricing historical weeks on the next recompute. It would also need mirroring into the hold-overlay branch (`:367`/`:380`).

3. **Do not adopt `config.qualificationBasis` as the unified fallback** (i.e. do not "fix" `:498` to match the other six). That is the direction that re-weeks live history: it lets mutable tenant configuration reinterpret sales that already exist, which is exactly the property `:93-97` exists to guarantee against. The plan version wins because it is what already determined the money.

4. **Do not widen the FINALIZE ensure query to a four-column `COALESCE` bracket**, and do not delete its existing `COALESCE(${basisCol}, sold_at)`. "Over-enumerating is harmless" is false: the lock loop FINALIZES every statement the sweep creates, and `GUARD 3` then 409s any later field write into that now-locked $0 week — a knock-path regression traded for a rare underpay. Additive-and-verified only.

5. **Do not thread `serverReceivedAt` through `transitionSale`'s `opts`.** `resolveEffectiveDates:86` treats a null receipt time as **trusted — no clamp**. If the service half lands without the route half, or the route edit is later reverted, or any future caller passes `at` without a receipt, the original P0-B backdating exploit reopens through a public HTTP route. `transitionSale`'s self-stamped `now` is the stronger contract; keep it.

6. **Do not gate `syncOverridesForSale` wholesale on a null week.** That call is also the CLAWBACK path (`overrideStore.ts:245-282`), and `upsertSale:859` rewrites `installed_at = excluded.installed_at` including with NULL — a sale that already earned an override and later had its basis column cleared would never be clawed back, converting a week-split into an unrecoverable overpayment. Gate the EARN branch only.

7. **Do not guard `REVERSE`/`DISQUALIFY`/`CANCEL` against locked weeks**, and do not hoist the guard above the action chain. `reverseFieldSale:1509` depends on reversing settled sales, and the claw is deliberately routed to an EXCEPTION row rather than mutating the frozen statement.

8. **Do not re-derive `contributing_sales` for statements already FINALIZED/PAID.** Those are locked evidence; a repair pass rewrites history. Fix forward only; existing bad snapshots are a data question, not a code one.

9. **Do not "fix" `basisTsForSale`'s `|| sale.sold_at` fallback (`:132`) or GUARD 3's `|| soldAt` (`:840`)** while doing this work. They are conservative in the same direction, and changing them silently alters which sales the already-live `upsertSale` guard blocks.

10. **Do not add a ceiling to `correctionWindowDays` in `loadOrgConfig:190`.** That is a *read-path* clamp, so it applies retroactively to every recompute: a tenant already above the ceiling silently narrows, and a sale legitimately synced late is clamped forward into a recent week, changing the retroactive tier of both weeks. If a bound is wanted, it belongs on the write path (`updateOrgConfig`, after `:1195`) and needs a product decision on the number — `90` is invented, nothing in the tree implies it. (The genuine defect there is that a *malformed* value — `{"commissionCorrectionWindowDays": "none"}` — stores as TEXT, yields `NaN`, and silently removes the floor entirely with no clamp audit rows. That is a separate, smaller PR: `Number.isInteger && >= 0` on the write path, `Number.isFinite` on the read path.)

---

## Adjacent findings — out of scope, worth filing

- `shared/commissionEffectiveDate.ts:108-112` is a **verbatim duplicate** of `:98-102` and is dead code. Harmless, but delete it while you are in the file — the second copy makes the module read as if it has two different backdating branches.
- `addPlanVersion:626` (route `commissionRoutes.ts:135`) accepts an arbitrary `qualificationBasis` from `req.body` with no equivalent of `updateOrgConfig`'s `WEEK_KEY_FROZEN` guard (`:1210-1219`). That is the API call that *manufactures* the divergence this patch defends against.
- `listWeekSalesForRep`'s SELECT (`:2074-2075`) projects no `installed_at`/`activated_at`, so `commissionStatementDoc.ts:29 toSaleInput` silently prints `sold_at` as `countedAtIso` under those bases — and the frozen JSON cannot carry the per-sale snapshot into a re-print.
- `listWeekSalesForRep` applies no hold overlay, so install-HELD doors reach `contributing_sales` as counted and absorb a share of gross (`shared/commissionStatement.ts:206`) while `countQualifiedSales(forPay)` excluded them. `require_install_confirm` defaults to `1` (`shared/commissionHold.ts:29`), so this fires on stock config with **no basis divergence at all**. Do not let this patch's "the list now matches the count" framing hide it.
- `commissionRoutes.ts:489` computes the payroll CSV's reserve with the **org** percent and **no cap**, while `reserveService.ts:199-204` withholds a per-rep, cap-aware amount. `team_members` 18 and 19 already carry 12%/15% overrides against `tenants.commission_reserve_percent = 0`, so the CSV's Reserve and Total columns disagree with the ledger today.