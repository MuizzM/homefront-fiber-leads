// ── Fiber launch detection — PURE transition classifier ───────────────────────
// The core business event: detecting the moment a competitor address FLIPS from
// unavailable to live ("newly_live") — first-to-market — versus an address that
// merely tests live the first time we ever scan it (can't prove it's new). The
// nightly pool re-scan feeds a stored snapshot + a fresh result in here; the
// result decides the availability status, whether it's a genuine new launch,
// and whether to auto-create a lead. Pure, so the whole decision is unit-tested
// without the Kinetic client or a DB.

export type AvailabilityStatus =
  | "unknown"              // never scanned
  | "check_failed"         // timeout / error / no-token — NOT a negative; recheck
  | "checked_unavailable"  // scanned, no serviceable fiber
  | "checked_available"    // scanned live, but first observation (not provably new)
  | "newly_live"           // FLIPPED unavailable/unknown → live: the money event
  | "still_available"      // was live, still live (already known)
  | "went_stale";          // was live, now reads unavailable (worth a look)

// The stored snapshot from the previous scan of this address.
export interface ScanSnapshot {
  everScanned: boolean;            // false = first time we've ever hit this address
  wasLive: boolean;                // previous scan judged it a live fiber opportunity
}

// The fresh scan result, already reduced to the "is this a hot fiber lead?" signal.
export interface ScanResult {
  isNewFiber: boolean;
  fiberAvailable: boolean;
  billingStatus: string | null;    // "N" = new/unbilled serviceable (the target)
  // A failed check (timeout/error/no-token) carries NO availability information.
  // It must NEVER be treated as a negative — that would erase a live opportunity
  // and, on a rescan, falsely report "went stale". This is a hard product law:
  // a non-answer is not a "no".
  checkFailed?: boolean;
}

export interface TransitionOutcome {
  status: AvailabilityStatus;
  isNewlyLive: boolean;            // true ONLY for a provable unavailable→live flip
  shouldCreateLead: boolean;      // newly_live OR a first-seen live address
  recordSnapshot: boolean;        // false for failed checks — don't overwrite memory
  reason: string;                  // short audit line
}

// The reduced "hot lead" signal — a serviceable, new-billing, available address.
// Mirrors the existing scanner heuristic so behavior stays consistent.
export function isHotFiber(r: ScanResult): boolean {
  return !r.checkFailed && r.isNewFiber && r.billingStatus === "N" && r.fiberAvailable;
}

// ── Is Kinetic's answer REAL fiber? ───────────────────────────────────────────
// Fiber is a TECHNOLOGY, never a speed. Kinetic sells VDSL2 / FTTN / G.fast bonded
// COPPER plans that reach 300–500 Mbps — so a "maxDownloadMbps >= 300 ⇒ fiber"
// heuristic mislabels copper as fiber and manufactures bogus "fiber leads". Real
// fiber is signalled explicitly: an FTTP chipset, or a FIBER technology tag. Speed
// is deliberately NOT a fiber signal here. Pure → unit-tested without the client.
export function isKineticFiber(sig: {
  techType?: string | null;
  maxQualTechnologyType?: string | null;
  chipSetType?: string | null;
}): boolean {
  const is = (v: string | null | undefined, t: string) => (v ?? "").trim().toUpperCase() === t;
  return is(sig.techType, "FIBER") || is(sig.maxQualTechnologyType, "FIBER") || is(sig.chipSetType, "FTTP");
}

// Classify prev-snapshot × fresh-result → availability transition. This is the
// heart of detecting new fiber as early as HomeFront can observe it.
export function classifyAvailabilityTransition(prev: ScanSnapshot, result: ScanResult): TransitionOutcome {
  // FAILED CHECK GUARD (product law): a timeout/error tells us nothing. Do not
  // record it, do not count it as unavailable, do not fire "went stale". The
  // previous snapshot stands and the address stays in the recheck queue.
  if (result.checkFailed) {
    return { status: "check_failed", isNewlyLive: false, shouldCreateLead: false, recordSnapshot: false, reason: "check failed — no signal, will recheck" };
  }

  const hot = isHotFiber(result);

  if (!prev.everScanned) {
    // First observation: we can't prove it's NEW, but a live address is still a
    // lead. Distinct status so first-to-market metrics don't overcount.
    return hot
      ? { status: "checked_available", isNewlyLive: false, shouldCreateLead: true, recordSnapshot: true, reason: "first scan — already live" }
      : { status: "checked_unavailable", isNewlyLive: false, shouldCreateLead: false, recordSnapshot: true, reason: "first scan — not serviceable" };
  }

  if (hot && !prev.wasLive) {
    return { status: "newly_live", isNewlyLive: true, shouldCreateLead: true, recordSnapshot: true, reason: "flipped unavailable → live" };
  }
  if (hot && prev.wasLive) {
    return { status: "still_available", isNewlyLive: false, shouldCreateLead: false, recordSnapshot: true, reason: "already known live" };
  }
  if (!hot && prev.wasLive) {
    return { status: "went_stale", isNewlyLive: false, shouldCreateLead: false, recordSnapshot: true, reason: "was live, now unavailable — review" };
  }
  return { status: "checked_unavailable", isNewlyLive: false, shouldCreateLead: false, recordSnapshot: true, reason: "still not serviceable" };
}

// Build the previous-snapshot from a stored scan_targets row. Accepts BOTH the
// raw snake_case row (what the pool query `SELECT *` returns) and the drizzle
// camelCase shape — the cron reads raw rows, so this must not silently miss.
export function snapshotFromTarget(t: Record<string, unknown>): ScanSnapshot {
  const lastScannedAt = (t.lastScannedAt ?? t.last_scanned_at) as string | null | undefined;
  const lastIsNewFiber = (t.lastIsNewFiber ?? t.last_is_new_fiber) as boolean | number | undefined;
  const lastBillingStatus = (t.lastBillingStatus ?? t.last_billing_status) as string | null | undefined;
  const everScanned = !!lastScannedAt;
  // Reconstruct the prior "was live" judgment from the stored fields.
  const wasLive = !!lastIsNewFiber && lastBillingStatus === "N";
  return { everScanned, wasLive };
}
