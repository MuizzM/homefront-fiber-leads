// ── Canonical billing-status semantics ───────────────────────────────────────
// ONE source of truth for "does this address have an active Kinetic account?"
//
// The provider returns billing_status as one of: null (unknown), "N" (no
// account — a Fresh Lead when the segment is NEW FIBER), or "A" (active
// account). Across 5,778 recorded provider responses and 7,600 snapshots,
// billing_status "Y" has NEVER once been returned — yet a dozen call sites gated
// "coming soon" / "existing customer" / lead-score on `=== "Y"` alone, so those
// branches were all dead and 118+ real NEW FIBER + "A" targets fell through to
// "unknown". Every site now shares this predicate, which treats BOTH "A" and
// "Y" as active (keeping "Y" for forward-compat).

/** True when the address has an active billing account ("A" today; "Y" kept for
 * forward-compat). A blank/null/"N" is NOT active. */
export function isActiveBilling(billing: unknown): boolean {
  const b = String(billing ?? "").trim().toUpperCase();
  return b === "A" || b === "Y";
}

/** True for the Fresh-Lead billing signal: explicitly no active account. */
export function isNoActiveBilling(billing: unknown): boolean {
  return String(billing ?? "").trim().toUpperCase() === "N";
}
