// Override-rate drafts: dollars in a text field → integer cents on the wire.
//
// One converter, shared by the Team page and Applications. Each used to carry
// its own copy, and both mapped ANY unparseable draft ("1o0", "12,50", "-5")
// to null — and null on the wire means "clear the per-rep override back to the
// org default". A manager who typo'd a rate and hit Save got a success toast
// while the rep's existing override was silently deleted. Invalid is now a
// refusal the caller must surface, never a coercion.
export type OverrideDollarsResult =
  | { ok: true; cents: number | null }
  | { ok: false; reason: string };

/** "" = inherit (null on the wire). A value must be a non-negative dollar
 *  amount; anything else is refused with a human reason. */
export function parseOverrideDollars(draft: string, label = "Override rate"): OverrideDollarsResult {
  const trimmed = draft.trim();
  if (!trimmed) return { ok: true, cents: null };
  const dollars = Number(trimmed);
  if (!Number.isFinite(dollars) || dollars < 0) {
    return { ok: false, reason: `${label} "${trimmed}" is not a dollar amount - use numbers like 25 or 12.50, or leave it blank to inherit` };
  }
  return { ok: true, cents: Math.round(dollars * 100) };
}

/** Cents → the draft string an input renders ("" for inherited/null). */
export function centsToDollarsDraft(cents: number | null | undefined): string {
  return cents == null ? "" : String(cents % 100 === 0 ? cents / 100 : (cents / 100).toFixed(2));
}
