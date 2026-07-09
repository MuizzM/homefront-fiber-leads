// ── Net-new qualification — PURE and auditable ────────────────────────────────
// The scanner's core governance rule: a detection becomes a lead ONLY when it
// is a net-new fiber opportunity. Everything else is excluded WITH A REASON —
// never a silent boolean — so the pipeline can report why each detection was
// or wasn't converted (spec: duplicateCheckResult / exclusionCheckResult).
//
// Used by the nightly re-scan; pure so the whole decision table is unit-tested
// without a DB.

export type ExclusionReason =
  | "net_new"            // qualified — no owned record at this address
  | "already_sold"       // we sold this door; never re-lead it
  | "disqualified"       // worked to a terminal no (not_interested)
  | "already_assigned"   // an active lead a rep currently owns
  | "duplicate";         // exists in inventory in any other state

export interface QualificationResult {
  qualified: boolean;
  reason: ExclusionReason;
}

// The minimal inventory snapshot for one owned address.
export interface OwnedRecord {
  leadStatus: string;            // prospect | contacted | interested | follow_up | sold | not_interested
  assignedRepId: number | null;
}

// Normalization shared with the scanner's dedupe: case/whitespace-insensitive.
export function normalizeAddressKey(address: string): string {
  return (address || "").trim().toLowerCase().replace(/\s+/g, " ");
}

// Build the O(1) inventory index once per scan batch: Map<normalizedAddress,
// OwnedRecord>. One O(n) pass over leads; every qualification after is O(1).
export function buildInventoryIndex(
  leads: Array<{ address: string; leadStatus: string; assignedRepId: number | null }>,
): Map<string, OwnedRecord> {
  const index = new Map<string, OwnedRecord>();
  for (const l of leads) {
    index.set(normalizeAddressKey(l.address), { leadStatus: l.leadStatus, assignedRepId: l.assignedRepId ?? null });
  }
  return index;
}

// The decision table. Order matters: the most protective exclusions first
// (sold/disqualified are permanent; assignment is a live working claim).
export function qualifyDetection(address: string, inventory: Map<string, OwnedRecord>): QualificationResult {
  const owned = inventory.get(normalizeAddressKey(address));
  if (!owned) return { qualified: true, reason: "net_new" };
  if (owned.leadStatus === "sold") return { qualified: false, reason: "already_sold" };
  if (owned.leadStatus === "not_interested") return { qualified: false, reason: "disqualified" };
  if (owned.assignedRepId != null) return { qualified: false, reason: "already_assigned" };
  return { qualified: false, reason: "duplicate" };
}

// Batch summary shape for the scan audit line ("why didn't these convert?").
export function summarizeExclusions(results: Iterable<ExclusionReason>): Record<ExclusionReason, number> {
  const out: Record<ExclusionReason, number> = {
    net_new: 0, already_sold: 0, disqualified: 0, already_assigned: 0, duplicate: 0,
  };
  for (const r of results) out[r]++;
  return out;
}
