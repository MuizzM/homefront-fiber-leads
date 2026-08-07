# P0-A handoff — qualification-basis fallback divergence

> **Written:** 2026-08-07, by a session that deliberately did **not** edit
> `server/commissionService.ts`. Another session was actively editing that file
> at the time (it landed the P0-B clamp at 00:12–00:19), and two agents writing
> money guards into the same functions with no coordination is how contradictory
> logic gets silently merged.
>
> Everything below was verified against the working tree, not inferred. Full
> generated analysis: [`COMMISSION_P0A_FULL_SPEC.md`](./COMMISSION_P0A_FULL_SPEC.md)
> (25 candidate gaps → 15 confirmed after adversarial review).

---

## Status — what is already done, what is not

| Item | State | Anchor |
|---|---|---|
| Immutable `commission_sales.qualification_basis` snapshot | **done** | write-once `COALESCE` at `commissionService.ts:862` |
| `countQualifiedSales` counts by the per-row snapshot | **done** | `basisTsExpr` at `:334` |
| `updateOrgConfig` refuses a basis flip once a week is locked | **done** | `WEEK_KEY_FROZEN` |
| P0-B: `transitionSale` correction-window clamp | **done** | `:945-954` → `shared/commissionEffectiveDate.ts` |
| **P0-A: fallback unification** | **NOT DONE** | see §1 |
| **P0-B: locked-week guard on `transitionSale`** | **NOT DONE** | see §2 |
| **Snapshot resolved from unclamped input** | **NOT DONE** | see §3 |

Three defects remain. They are independent and can land separately.

---

## §1 — P0-A: the fallback has two implementations

The snapshot mechanism is correct and honoured everywhere. A **stamped** row
cannot diverge. The defect is the fallback used when the snapshot is `NULL`:

| Site | Falls back to | Decides |
|---|---|---|
| `:498` | `version.qualification_basis \|\| config.qualificationBasis` | which week **counts** (money) |
| `:907` | `config.qualificationBasis` | which week **recomputes**, and the override earn week |
| `:946` | `config.qualificationBasis` | which field `at` clamps as |
| `:1655` | `config.qualificationBasis` | week-overview counts, install hold |
| `:1883` | `config.qualificationBasis` | **which reps get a statement at FINALIZE** |
| `:2072` | `config.qualificationBasis` | the door list, and frozen `contributing_sales` |

`basisTsExpr` renders `CASE COALESCE(qualification_basis, '<fallback>')`, so for
a NULL snapshot **the fallback is the whole answer** — and these two sets
disagree. The file's own documented precedence (`:86-91`) says rule 2 is the
plan version's basis "as resolved by the statement". `:498` implements that; the
other five jump to rule 3.

### This is not a legacy edge case

Verified read-only against `data.db`:

```
PRAGMA table_info(commission_sales)
→ 15 columns, ending at house_amount_cents. qualification_basis IS NOT PRESENT.
```

`storage.ts:978` adds it as a bare `ALTER TABLE … ADD COLUMN` with **no
backfill**. So on the first boot after deploy, all 13 existing sales get `NULL`
and every one of them resolves through the divergent fallback. The stamped path
covers only rows written after deploy.

### The fix

Add one resolver and make the five sites defer to it. Full code in
[`COMMISSION_P0A_FULL_SPEC.md` §1.2–1.4](./COMMISSION_P0A_FULL_SPEC.md); the
shape is:

```ts
/** Precedence rule 2: the basis for a rep in a WEEK — the plan version the
 *  STATEMENT resolves for that week, else org config. This is the fallback every
 *  NULL-snapshot row must resolve through, and the one `:498` has always used.
 *  NEVER throws: an hourly-only or override-only rep has no assignment and still
 *  needs a basis (`:474-488` tolerates that deliberately). */
export function fallbackBasisForRepWeek(
  tenantId: number, repId: number, bounds: WeekBounds, config: OrgCommissionConfig,
): QualificationBasis
```

**Watch the circularity.** `reconcileSaleSideEffects` needs the basis to compute
the week, and the resolver needs the week. Do not paper over this by passing an
approximate week — resolve it by enumerating the sale's at-most-four candidate
instants (`weeksCountingSale`, §1.3 of the full spec).

**Legacy rows must not move.** The count comes from `:498`, which already uses
the plan version. This patch changes the *other* five sites to agree with `:498`
— it does not change `:498`. So `qualified_sale_count`, `gross_commission_cents`
and `final_commission_cents` are unchanged for every existing row on every
existing week. What moves is which week gets recomputed and which reps get
enumerated — all moving *toward* the week that already counts the money.

**No backfill.** Leaving the column NULL keeps legacy rows on the fallback path,
which after this patch is single-valued and correct. Backfilling would stamp
them from today's config and re-week history.

---

## §2 — P0-B residual: `transitionSale` has no locked-week guard

The clamp is fixed. The **guard** is not.

`upsertSale` refuses a QUALIFIED write into a settled week (GUARD 3, `:836-851`).
`transitionSale`'s QUALIFY (`:955-956`) writes
`status='QUALIFIED', qualified_at=COALESCE(qualified_at, ?)` with no equivalent,
and `reconcileSaleSideEffects` then **swallows** the resulting `STATEMENT_LOCKED`
as an expected outcome. The caller gets a **200**, and the row lands QUALIFIED
inside a locked week with no error recorded anywhere — surfacing on the next
recompute as an unexplained re-price of a settled retroactive week.

`recordFieldSaleFromKnock` and `backfillFieldSales` both implement the guard
(they book PENDING instead). `transitionSale` is the only QUALIFY path without
it — while `upsertSale`'s own comment at `:736` claims the guards "live HERE now,
at the single write site, so no present or future caller can bypass them".
`transitionSale` never goes through `upsertSale`.

**Fix:** hoist GUARD 3's body to `assertWeekOpenForQualify(...)` beside
`auditEffectiveDateClamps` (`:713`), call it from `upsertSale` (behaviour-
identical: same query, message, activity event and payload keys) and from
`transitionSale`'s QUALIFY branch. Code in §2.2 of the full spec.

**Only `qualified_at` needs basis clamping.** `reversed_at` places no pay week
under any basis — `BASIS_COLUMN` has no entry for it and `loadOrgConfig` rejects
anything outside the four. Keep its clamp (it makes `REVERSED_AFTER_FINALIZE`
*more* likely to fire, which is protective) but never label it a basis field.

---

## §3 — The snapshot is resolved from UNCLAMPED input

Verified at `:770-788`. The write-once snapshot is chosen at `:779` from
**raw** caller input:

```ts
: resolveSaleBasis(tenantId, input.repId, input.qualifiedAt ?? input.soldAt, config);
```

…while the clamp does not run until `:784`. So a 400-day-backdated `qualifiedAt`
selects a plan version governing no week the sale can legally land in — and
because the snapshot is write-once (`:862`), that wrong choice is **permanent**.
The P0-B clamp did not close this: it corrects the stored timestamps but not the
basis already chosen from the uncorrected ones.

**Fix:** move the `resolveEffectiveDates` call above the basis resolution and
resolve the snapshot from `dates.applied.qualifiedAt ?? dates.applied.soldAt`.
Note the ordering constraint — `resolveEffectiveDates` currently takes `basis`
as an argument, so this needs the two-pass treatment in §1.4(C) of the full spec,
not a naive statement swap.

---

## Ordering

1. **§2** (locked-week guard) — fully independent, smallest, highest severity per
   line changed. Land first.
2. **§3** (clamp-before-snapshot) — independent of §1; touches only `upsertSale`.
3. **§1** (fallback unification) — largest blast radius; land last, with the
   test changes in §4 of the full spec.

Ship §1 **before** the first boot that runs the `ALTER TABLE`, or every existing
sale spends the intervening window on the divergent fallback.

---

## What NOT to do

- **Do not backfill `commission_sales.qualification_basis`.** It would stamp
  historical rows from today's config and re-week settled money.
- **Do not change `:498`.** It is the site that is already correct; the other
  five move to meet it. Changing it moves money.
- **Do not make `fallbackBasisForRepWeek` throw** `NO_EFFECTIVE_PLAN_ASSIGNMENT`
  on a missing assignment. Hourly-only and override-only reps legitimately have
  none, and two endpoints render that as `noPlan` — a throwing resolver turns
  both into 500s.
- **Do not accept a route-supplied `serverReceivedAt` on the transition route.**
  `transitionSale` stamps its own; accepting one would let a caller widen its own
  correction window.

---

## Tests

`tests/integration/commission-side-effects.test.ts:561` already asserts the
*fixed* basis behaviour rather than pinning the old bug — it does not need to be
weakened. Required additions, detailed in §4 of the full spec:

- A NULL-snapshot row under a tenant/plan-version basis **disagreement**, asserting
  the recompute week equals the count week.
- A `transitionSale` QUALIFY into a FINALIZED week asserting a **409**, not a 200.
- An `upsertSale` with a backdated `qualifiedAt` asserting the stamped snapshot
  matches the plan version governing the *clamped* week.

Run with a pristine data dir — the 1 GB dev `data.db` breaks timing assertions:

```bash
DATA_DIR=$(mktemp -d) npm test
```
