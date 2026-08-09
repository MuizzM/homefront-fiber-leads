// ── The comp terms a rep is actually offered, and signs ──────────────────────
//
// THE GAP THIS CLOSES: the Commission Agreement said the rep is paid under
// "the commission structure assigned to the Contractor in the Home Front
// portal", incorporating "the portal's effective-dated rate, tier ladder,
// qualification rule" by reference. The template function that produced it took
// a context argument and ignored it — `commissionSections(_ctx)` — so whatever
// a manager configured, every rep signed the same numberless paragraph. The
// paperwork could not disagree with the portal because it never stated
// anything to disagree with.
//
// A rep signing a commission agreement should be able to read what they will be
// paid. So the terms travel with the document: chosen by the manager when the
// paperwork is sent, rendered into the agreement, and frozen in the signed
// snapshot. The snapshot is already immutable and audited — that is exactly
// where an agreed number belongs.
//
// PURE. No DB, no server imports, so the same normalisation and the same
// rendering run in the editor a manager types into and in the document the rep
// signs. Two encodings of "what does this rep earn" that can drift is how a
// contractor ends up signing one thing and being paid another.

import {
  DEFAULT_RETRO_TIERS, formatUsdCents, validateTiers, type CommissionTier,
} from "./commissionTiers";

/** FLAT pays one rate per qualified sale. TIERED re-prices the whole week at
 *  the tier the week's total lands in (see calculateRetroactiveCommission). */
export type CommissionStructure = "FLAT" | "TIERED";

export interface CommissionTerms {
  structure: CommissionStructure;
  /** FLAT only. Integer cents per qualified sale. */
  flatRateCents: number | null;
  /** TIERED only. Retroactive ladder, validated by validateTiers. */
  tiers: CommissionTier[];
  /** Whole percent of otherwise-payable commission held against chargebacks. */
  reservePercent: number;
  /** Ceiling on the running reserve balance, integer cents. 0 = uncapped. */
  reserveCapCents: number;
}

/** House default, used when nobody has chosen anything for this rep yet. */
export const DEFAULT_COMMISSION_TERMS: CommissionTerms = {
  structure: "TIERED",
  flatRateCents: null,
  tiers: DEFAULT_RETRO_TIERS,
  reservePercent: 10,
  reserveCapCents: 250_000,
};

export interface TermsValidation { ok: boolean; errors: string[]; normalized: CommissionTerms }

/**
 * Accept anything, return something a document can be built from — or the
 * reasons it cannot be. Never throws: the editor needs to show errors while the
 * manager is still typing, and the server needs the same verdict before it
 * writes a contract.
 */
export function normalizeCommissionTerms(input: unknown): TermsValidation {
  const errors: string[] = [];
  const raw = (input ?? {}) as Partial<CommissionTerms>;

  const structure: CommissionStructure = raw.structure === "FLAT" ? "FLAT" : "TIERED";

  const pct = Math.trunc(Number(raw.reservePercent));
  const reservePercent = Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) : DEFAULT_COMMISSION_TERMS.reservePercent;
  if (Number.isFinite(pct) && (pct < 0 || pct > 100)) errors.push("Reserve percent must be between 0 and 100.");

  const cap = Math.trunc(Number(raw.reserveCapCents));
  const reserveCapCents = Number.isFinite(cap) && cap >= 0 ? cap : DEFAULT_COMMISSION_TERMS.reserveCapCents;
  if (Number.isFinite(cap) && cap < 0) errors.push("Reserve cap cannot be negative.");

  let flatRateCents: number | null = null;
  let tiers: CommissionTier[] = [];

  if (structure === "FLAT") {
    const rate = Math.trunc(Number(raw.flatRateCents));
    if (!Number.isFinite(rate) || rate <= 0) {
      errors.push("A flat plan needs a rate per qualified sale.");
      flatRateCents = null;
    } else {
      flatRateCents = rate;
    }
  } else {
    const candidate = Array.isArray(raw.tiers) && raw.tiers.length ? raw.tiers : DEFAULT_RETRO_TIERS;
    const check = validateTiers(candidate as CommissionTier[]);
    // validateTiers owns ladder correctness (gaps, overlaps, ordering) — this
    // module does not re-implement it, so the agreement can never state a
    // ladder the commission engine would refuse to pay against.
    if (!check.ok) errors.push(...check.errors);
    tiers = check.normalized;
  }

  return {
    ok: errors.length === 0,
    errors,
    normalized: { structure, flatRateCents, tiers, reservePercent, reserveCapCents },
  };
}

/** One line per tier, for a table in the agreement or a preview in the editor. */
export function tierRows(terms: CommissionTerms): Array<{ band: string; rate: string }> {
  return terms.tiers.map((t) => ({
    band: t.maximumSales == null
      ? `${t.minimumSales}+ qualified sales`
      : `${t.minimumSales}-${t.maximumSales} qualified sales`,
    rate: `${formatUsdCents(t.rateCents)} per sale`,
  }));
}

/**
 * The comp terms as plain sentences, for the signed agreement.
 *
 * Deliberately spells out the retroactive rule in words as well as numbers:
 * "8 sales pays 8 × $200, not 7 × $150 + 1 × $200" is the single most
 * misunderstood thing about this plan, and a contractor should not have to
 * infer it from a table.
 */
export function describeCommissionTerms(terms: CommissionTerms): string[] {
  const out: string[] = [];

  if (terms.structure === "FLAT" && terms.flatRateCents != null) {
    out.push(
      `Contractor is paid ${formatUsdCents(terms.flatRateCents)} for each qualified sale, with no volume tiers. ` +
      `A sale counts once it satisfies the qualification rule shown in the portal and clears validation.`,
    );
  } else {
    const rows = tierRows(terms);
    out.push(
      "Contractor is paid on a RETROACTIVE tier ladder. The total number of qualified sales in a commission week " +
      "selects one tier, and that tier's rate then applies to EVERY qualified sale in that week - not only to the " +
      "sales above the tier's threshold.",
    );
    out.push(`The ladder for this engagement is: ${rows.map((r) => `${r.band} - ${r.rate}`).join("; ")}.`);
    const example = terms.tiers.find((t) => t.minimumSales > 1) ?? terms.tiers[0];
    if (example) {
      out.push(
        `For example, ${example.minimumSales} qualified sales in one week pays ` +
        `${example.minimumSales} × ${formatUsdCents(example.rateCents)} = ` +
        `${formatUsdCents(example.minimumSales * example.rateCents)} for that week.`,
      );
    }
  }

  if (terms.reservePercent > 0) {
    out.push(
      `${terms.reservePercent}% of otherwise payable commissions is withheld as a chargeback reserve; the remaining ` +
      `${100 - terms.reservePercent}% is paid on the normal payout schedule.` +
      (terms.reserveCapCents > 0
        ? ` The reserve balance is capped at ${formatUsdCents(terms.reserveCapCents)}; once the balance reaches the cap, no further amounts are withheld.`
        : " The reserve is not capped."),
    );
  } else {
    out.push("No chargeback reserve is withheld from Contractor's commissions under this engagement.");
  }

  return out;
}

/** Short one-liner for a list row or a confirmation toast. */
export function summarizeCommissionTerms(terms: CommissionTerms): string {
  const base = terms.structure === "FLAT" && terms.flatRateCents != null
    ? `Flat ${formatUsdCents(terms.flatRateCents)}/sale`
    : `Tiered ${terms.tiers.length}-band`;
  return terms.reservePercent > 0 ? `${base} · ${terms.reservePercent}% reserve` : `${base} · no reserve`;
}
