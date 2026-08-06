// ── Downline override compensation — pure rules + wire types ─────────────────
// The shared brain of the override layer: how an upline chain is resolved from
// the reports-to tree, how flat per-sale override amounts are computed from it,
// and the wire shapes the override routes and UI exchange. No DB, no clock, no
// framework — the server store and the client both import from here so the UI
// can never promise money the ledger would refuse.
//
// Money invariants (mirroring docs/COMMISSIONS.md):
// - Overrides are a SEPARATE additive layer on top of the rep's own commission
//   engine. The rep's pay is untouched; uplines earn on top.
// - The upline chain and the rate config are both mutable, so every earned row
//   freezes a chain snapshot + rate snapshot at earn time (plan_snapshot house
//   style). A promotion or re-home affects only future sales.
// - Missing slot = house keeps it. A rep reporting straight to a manager pays
//   no team-lead override to anyone; skipped (inactive) uplines pay nobody.
// - A seller never earns an override on their own sale.

import { hierarchyRank, type MemberRole } from "./teamHierarchy";

// PERCENT_OF_COMMISSION is reserved (config columns exist) but its execution
// path is deferred — validateOverridePatch refuses to enable it, the same way
// the tier engine carries PROGRESSIVE but throws UNSUPPORTED_TIER_MODE.
export type OverrideBasis = "FLAT_PER_SALE" | "PERCENT_OF_COMMISSION";

export type OverrideEntryType = "EARN" | "CLAWBACK";

// Ledger row lifecycle. PAYABLE folds into the upline's open statement; HELD
// waits out the sale's install hold; SETTLED is frozen into a finalized
// statement; EXCEPTION needs a human (reversal against a finalized week, or an
// earn landing in one); RESOLVED is an exception closed by a manager adjustment.
export type OverrideLedgerStatus = "PAYABLE" | "HELD" | "SETTLED" | "EXCEPTION" | "RESOLVED";

/** The two payable slots in a chain. Exactly one of each may earn per sale. */
export type OverrideSlotRole = Extract<MemberRole, "team_lead" | "manager">;

// ── Rates ─────────────────────────────────────────────────────────────────────

/** Org override config as the engine consumes it; also the frozen rate_snapshot
 *  shape on every ledger row. Integer cents, whole numbers only. */
export interface OverrideRates {
  basis: OverrideBasis;
  teamLeadCents: number;
  managerCents: number;
}

export const OVERRIDE_SLOT_ROLES: readonly OverrideSlotRole[] = ["team_lead", "manager"];

export function slotRateCents(rates: OverrideRates, role: OverrideSlotRole): number {
  return role === "team_lead" ? rates.teamLeadCents : rates.managerCents;
}

/** Per-seller rate overrides carried on the seller's roster row (chosen at
 *  invite time). NULL/absent = inherit the org default. */
export interface SellerOverrideRates {
  overrideTeamLeadCents?: number | null;
  overrideManagerCents?: number | null;
}

/**
 * The rates governing ONE seller's sales: their own per-hire rates where set,
 * the org config where not. Resolved at earn time and frozen into the row's
 * rate_snapshot — a later edit to either layer never re-prices earned money.
 */
export function resolveSellerRates(org: OverrideRates, seller: SellerOverrideRates | undefined): OverrideRates {
  return {
    basis: org.basis,
    teamLeadCents: seller?.overrideTeamLeadCents ?? org.teamLeadCents,
    managerCents: seller?.overrideManagerCents ?? org.managerCents,
  };
}

// ── Chain resolution (pure) ───────────────────────────────────────────────────

/** Minimal roster shape the walk needs — plain data in, ids out. */
export interface UplineChainMemberInput {
  id: number;
  role: string;
  reportsToId: number | null;
  active: boolean;
}

export interface UplineChainNode {
  repId: number;
  role: string;
  /** Hops above the seller; 1 = direct supervisor. */
  level: number;
  active: boolean;
}

/**
 * Walk UP the reports-to chain from the seller (seller excluded), recording
 * every node passed. Mirrors wouldCreateReportsCycle's hop-budgeted upward
 * walk: a cycle or budget exhaustion marks the chain corrupt and returns an
 * EMPTY chain — corrupt data earns zero, never loops, never guesses.
 */
export function resolveOverrideChain(
  sellerRepId: number,
  membersById: ReadonlyMap<number, UplineChainMemberInput>,
  maxHops = 100,
): { chain: UplineChainNode[]; corrupt: boolean } {
  const chain: UplineChainNode[] = [];
  const visited = new Set<number>([sellerRepId]);
  let cursor = membersById.get(sellerRepId)?.reportsToId ?? null;
  for (let hop = 1; hop <= maxHops; hop++) {
    if (cursor == null) return { chain, corrupt: false }; // reached top-level
    if (visited.has(cursor)) return { chain: [], corrupt: true }; // cycle — fail closed
    const member = membersById.get(cursor);
    if (!member) return { chain, corrupt: false }; // dangling edge — treat as top
    visited.add(cursor);
    chain.push({ repId: member.id, role: member.role, level: hop, active: member.active });
    cursor = member.reportsToId ?? null;
  }
  return { chain: [], corrupt: true }; // budget exhausted — corrupt, fail closed
}

// ── Flat computation (pure) ───────────────────────────────────────────────────

export interface OverrideAward {
  repId: number;
  role: OverrideSlotRole;
  level: number;
  amountCents: number;
}

/** One chain node as frozen into chain_snapshot — the award/skip verdict rides
 *  with it so a locked week can always explain itself. */
export interface ChainSnapshotNode extends UplineChainNode {
  awardedCents: number;
  skipReason: "slot_filled" | "not_a_slot_role" | "zero_rate" | null;
}

/**
 * FLAT_PER_SALE: pay the first team_lead and the first manager in the chain
 * their configured cents. One award per slot; unfilled slots pay nobody, so
 * the house keeps a slot the tree doesn't have.
 *
 * Deliberately NOT gated on `active`. This function used to skip an inactive
 * upline, which sounded prudent and was wrong twice over:
 *   · a DEPARTED leader is already out of every chain — offboard and delete
 *     both re-home their reports (server/routes.ts), so they can never be
 *     walked into; the check never protected against the case it was written
 *     for; and
 *   · the members it DID catch were newly approved hires, who sit at
 *     active = 0 until their agreements are signed. Their downline was
 *     assigned at hire and is out selling, and the money for managing that
 *     team was quietly going to the house over signature timing.
 * No other pay path gates on `active` either — an inactive rep's own
 * commission still pays. `active` stays on the snapshot node as a record of
 * what was true at earn time; it just no longer decides the money.
 */
export function computeFlatOverrides(
  chain: readonly UplineChainNode[],
  rates: OverrideRates,
): { awards: OverrideAward[]; chainSnapshot: ChainSnapshotNode[] } {
  const filled = new Set<OverrideSlotRole>();
  const awards: OverrideAward[] = [];
  const chainSnapshot: ChainSnapshotNode[] = [];
  for (const node of chain) {
    const slot = (OVERRIDE_SLOT_ROLES as readonly string[]).includes(node.role)
      ? (node.role as OverrideSlotRole) : null;
    let awardedCents = 0;
    let skipReason: ChainSnapshotNode["skipReason"] = null;
    if (!slot) skipReason = "not_a_slot_role";
    else if (filled.has(slot)) skipReason = "slot_filled";
    else {
      const rate = slotRateCents(rates, slot);
      if (rate <= 0) skipReason = "zero_rate";
      else {
        filled.add(slot);
        awardedCents = rate;
        awards.push({ repId: node.repId, role: slot, level: node.level, amountCents: rate });
      }
    }
    chainSnapshot.push({ ...node, awardedCents, skipReason });
  }
  return { awards, chainSnapshot };
}

// ── Config patch validation (tri-state, parseReservePatch discipline) ─────────
// Absent = leave alone; explicit null = reset to the shipped default (disabled,
// $0); a value = set it. Whole integer cents only — a float is a client bug,
// not something to round into an upline's pay.

export interface OverridePatch {
  overridesEnabled?: boolean;
  overrideBasis?: OverrideBasis;
  overrideTeamLeadCents?: number;
  overrideManagerCents?: number;
}

export function validateOverridePatch(body: any): { patch: OverridePatch; error?: string } {
  const patch: OverridePatch = {};
  if (body.overridesEnabled !== undefined) {
    if (body.overridesEnabled === null) patch.overridesEnabled = false;
    else if (typeof body.overridesEnabled !== "boolean") {
      return { patch, error: "overridesEnabled must be a boolean, or null to disable." };
    } else patch.overridesEnabled = body.overridesEnabled;
  }
  if (body.overrideBasis !== undefined && body.overrideBasis !== null) {
    if (body.overrideBasis === "PERCENT_OF_COMMISSION") {
      return { patch, error: "PERCENT_OF_COMMISSION overrides are not yet supported — only FLAT_PER_SALE is executable." };
    }
    if (body.overrideBasis !== "FLAT_PER_SALE") {
      return { patch, error: "overrideBasis must be FLAT_PER_SALE." };
    }
    patch.overrideBasis = body.overrideBasis;
  }
  for (const key of ["overrideTeamLeadCents", "overrideManagerCents"] as const) {
    if (body[key] === undefined) continue;
    if (body[key] === null) { patch[key] = 0; continue; }
    if (!Number.isInteger(body[key]) || body[key] < 0 || body[key] > 100_000_00) {
      return { patch, error: `${key} must be a whole number of cents from 0 to 10000000, or null to clear.` };
    }
    patch[key] = body[key];
  }
  return { patch };
}

// ── Wire types (routes ↔ UI) ──────────────────────────────────────────────────

/** Matches shared/workweek.ts WeekBounds so service bounds pass straight through. */
export interface OverrideWeekBoundsWire {
  weekStartUtc: string;
  nextWeekStartUtc: string;
}

export interface OverrideRowWire {
  id: number;
  saleId: number | null;
  soldAt: string | null;
  saleStatus: string | null;
  downlineRepId: number;
  downlineRepName: string;
  downlineRoleAtEarn: string;
  level: number;
  basis: OverrideBasis;
  entryType: OverrideEntryType;
  amountCents: number;
  status: OverrideLedgerStatus;
  holdPayableAfter: string | null;
}

/** Split by ledger status, NEVER blended into one figure (EarningsToday rule:
 *  certain and uncertain money don't share a number). */
export interface OverrideTotalsWire {
  rowCount: number;
  payableCents: number;
  heldCents: number;
  settledCents: number;
}

export interface MyOverrideWeekResponse {
  hasDownline: boolean;
  bounds: OverrideWeekBoundsWire | null;
  totals: OverrideTotalsWire;
  rows: OverrideRowWire[];
  /** The override component frozen/folded into this week's statement, for the
   *  "Included in your statement" reconciliation footer. Null = no statement. */
  statementOverrideCents: number | null;
}

export interface DownlineRollupRowWire {
  repId: number;
  repName: string;
  role: string;
  active: boolean;
  /** Depth below the sheet's root; 1 = direct report. */
  level: number;
  saleCount: number;
  payableCents: number;
  heldCents: number;
  settledCents: number;
}

export interface DownlineSheetResponse {
  bounds: OverrideWeekBoundsWire;
  viewer: { repId: number; repName: string };
  totals: OverrideTotalsWire;
  rows: OverrideRowWire[];
  rollup: DownlineRollupRowWire[];
  exceptions: Array<{ type: string; repId: number; repName: string; detail: string }>;
}

export interface DownlineTreeMemberWire {
  repId: number;
  repName: string;
  role: string;
  active: boolean;
  level: number;
  reportsToId: number | null;
}

export interface DownlineTreeResponse {
  rootRepId: number;
  members: DownlineTreeMemberWire[];
}

export interface OverrideConfigWire {
  overridesEnabled: boolean;
  overrideBasis: OverrideBasis;
  overrideTeamLeadCents: number;
  overrideManagerCents: number;
}

// ── Display helpers ───────────────────────────────────────────────────────────

export function describeOverrideBasis(basis: OverrideBasis): string {
  return basis === "FLAT_PER_SALE" ? "Flat amount per qualified sale" : "Percent of downline commission";
}

/** UI tone per ledger status — mirrors the StatusPill tint idiom. */
export const OVERRIDE_STATUS_TONE: Record<OverrideLedgerStatus, "positive" | "muted" | "warning" | "critical"> = {
  PAYABLE: "positive",
  HELD: "muted",
  SETTLED: "positive",
  EXCEPTION: "critical",
  RESOLVED: "muted",
};

export function overrideStatusLabel(status: OverrideLedgerStatus): string {
  switch (status) {
    case "PAYABLE": return "Payable";
    case "HELD": return "On hold";
    case "SETTLED": return "Settled";
    case "EXCEPTION": return "Needs review";
    case "RESOLVED": return "Resolved";
  }
}

// hierarchyRank is re-exported so override callers ordering statement
// settlement (reps before uplines) don't need a second import site.
export { hierarchyRank };
