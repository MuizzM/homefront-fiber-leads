import { describe, expect, it } from "vitest";
import { downlineOf, type DownlineMemberRef } from "@shared/teamHierarchy";
import {
  computeFlatOverrides,
  resolveOverrideChain,
  resolveSellerRates,
  validateOverridePatch,
  type OverrideRates,
  type UplineChainMemberInput,
} from "@shared/commissionOverrides";
import { buildStatementDocument, type StatementDocInput } from "@shared/commissionStatement";

const RATES: OverrideRates = { basis: "FLAT_PER_SALE", teamLeadCents: 2500, managerCents: 7500 };

/** mgr(1) ← tl(2) ← rep(3); rep(4) straight under mgr; mgr2(5) idle. */
const roster = (over: Partial<Record<number, Partial<UplineChainMemberInput>>> = {}): Map<number, UplineChainMemberInput> => {
  const base: UplineChainMemberInput[] = [
    { id: 1, role: "manager", reportsToId: null, active: true },
    { id: 2, role: "team_lead", reportsToId: 1, active: true },
    { id: 3, role: "rep", reportsToId: 2, active: true },
    { id: 4, role: "rep", reportsToId: 1, active: true },
    { id: 5, role: "manager", reportsToId: null, active: true },
  ];
  return new Map(base.map(m => [m.id, { ...m, ...(over[m.id] ?? {}) }]));
};

describe("downlineOf — BFS below a root, cycle-safe", () => {
  const members: DownlineMemberRef[] = [
    { id: 1, reportsToId: null },
    { id: 2, reportsToId: 1 },
    { id: 3, reportsToId: 2 },
    { id: 4, reportsToId: 1 },
  ];

  it("returns every member strictly below the root, root excluded", () => {
    expect(downlineOf(1, members).sort()).toEqual([2, 3, 4]);
    expect(downlineOf(2, members)).toEqual([3]);
    expect(downlineOf(3, members)).toEqual([]);
  });

  it("a corrupt cycle terminates instead of looping", () => {
    const cyclic: DownlineMemberRef[] = [
      { id: 1, reportsToId: 2 }, // 1 ↔ 2 cycle
      { id: 2, reportsToId: 1 },
      { id: 3, reportsToId: 1 },
    ];
    // BFS from 1 visits each node once: 2 (cycle edge) and 3, never looping.
    expect(downlineOf(1, cyclic)).toEqual([2, 3]);
  });

  it("the node budget caps a runaway walk to a partial result", () => {
    const deep: DownlineMemberRef[] = Array.from({ length: 50 }, (_, i) => ({ id: i + 2, reportsToId: i + 1 }));
    expect(downlineOf(1, deep, 10)).toHaveLength(10);
  });
});

describe("resolveOverrideChain — hop-budgeted upward walk", () => {
  it("walks rep → team_lead → manager with levels", () => {
    const { chain, corrupt } = resolveOverrideChain(3, roster());
    expect(corrupt).toBe(false);
    expect(chain).toEqual([
      { repId: 2, role: "team_lead", level: 1, active: true },
      { repId: 1, role: "manager", level: 2, active: true },
    ]);
  });

  it("a cycle fails closed with an EMPTY chain — corrupt data earns zero", () => {
    const m = roster();
    m.set(1, { id: 1, role: "manager", reportsToId: 3, active: true }); // mgr reports to the rep
    const { chain, corrupt } = resolveOverrideChain(3, m);
    expect(corrupt).toBe(true);
    expect(chain).toEqual([]);
  });

  it("a dangling reports_to edge terminates as top-level, not corrupt", () => {
    const m = roster();
    m.set(2, { id: 2, role: "team_lead", reportsToId: 999, active: true });
    const { chain, corrupt } = resolveOverrideChain(3, m);
    expect(corrupt).toBe(false);
    expect(chain.map(n => n.repId)).toEqual([2]);
  });
});

describe("computeFlatOverrides — one award per slot, house keeps unfilled slots", () => {
  it("pays TL $25 and manager $75 on a full chain", () => {
    const { chain } = resolveOverrideChain(3, roster());
    const { awards } = computeFlatOverrides(chain, RATES);
    expect(awards).toEqual([
      { repId: 2, role: "team_lead", level: 1, amountCents: 2500 },
      { repId: 1, role: "manager", level: 2, amountCents: 7500 },
    ]);
  });

  it("missing TL slot (rep straight under a manager): only the manager is paid", () => {
    const { chain } = resolveOverrideChain(4, roster());
    const { awards } = computeFlatOverrides(chain, RATES);
    expect(awards).toEqual([{ repId: 1, role: "manager", level: 1, amountCents: 7500 }]);
  });

  it("a seller is never in their own chain (a TL's sale pays only the manager)", () => {
    const { chain } = resolveOverrideChain(2, roster());
    const { awards } = computeFlatOverrides(chain, RATES);
    expect(awards.map(a => a.repId)).toEqual([1]);
  });

  // A newly APPROVED hire sits at active = 0 until their agreements are signed.
  // Their downline was assigned at hire and is already selling, so skipping
  // them handed the money to the house over signature timing. A truly departed
  // leader never reaches this function at all: offboard and delete both re-home
  // their reports, which takes them out of every chain.
  it("a not-yet-activated upline still earns — signature timing is not a pay decision", () => {
    const { chain } = resolveOverrideChain(3, roster({ 2: { active: false } }));
    const { awards, chainSnapshot } = computeFlatOverrides(chain, RATES);
    expect(awards).toEqual([
      { repId: 2, role: "team_lead", level: 1, amountCents: 2500 },
      { repId: 1, role: "manager", level: 2, amountCents: 7500 },
    ]);
    // The snapshot still RECORDS what was true at earn time; it just no longer
    // decides the money.
    expect(chainSnapshot.find(n => n.repId === 2)).toMatchObject({ active: false, awardedCents: 2500, skipReason: null });
  });

  it("a zero rate pays nothing and says why", () => {
    const { chain } = resolveOverrideChain(3, roster());
    const { awards, chainSnapshot } = computeFlatOverrides(chain, { ...RATES, teamLeadCents: 0 });
    expect(awards.map(a => a.repId)).toEqual([1]);
    expect(chainSnapshot.find(n => n.repId === 2)?.skipReason).toBe("zero_rate");
  });

  it("only the FIRST node of a role earns — a second manager above earns nothing", () => {
    const m = roster();
    m.set(1, { id: 1, role: "manager", reportsToId: 5, active: true }); // mgr chain: 1 → 5
    const { chain } = resolveOverrideChain(3, m);
    const { awards, chainSnapshot } = computeFlatOverrides(chain, RATES);
    expect(awards.filter(a => a.role === "manager")).toHaveLength(1);
    expect(chainSnapshot.find(n => n.repId === 5)?.skipReason).toBe("slot_filled");
  });
});

describe("resolveSellerRates — per-hire rates win, NULL inherits", () => {
  it("a seller's own rates replace the org defaults column by column", () => {
    expect(resolveSellerRates(RATES, { overrideTeamLeadCents: 1000, overrideManagerCents: 9900 }))
      .toEqual({ basis: "FLAT_PER_SALE", teamLeadCents: 1000, managerCents: 9900 });
    // One column set, the other inherits.
    expect(resolveSellerRates(RATES, { overrideTeamLeadCents: 1000, overrideManagerCents: null }))
      .toEqual({ basis: "FLAT_PER_SALE", teamLeadCents: 1000, managerCents: 7500 });
  });

  it("no seller row (or all-NULL rates) = the org config, byte for byte", () => {
    expect(resolveSellerRates(RATES, undefined)).toEqual(RATES);
    expect(resolveSellerRates(RATES, {})).toEqual(RATES);
    expect(resolveSellerRates(RATES, { overrideTeamLeadCents: null, overrideManagerCents: null })).toEqual(RATES);
  });

  it("an explicit $0 per-hire rate is a real choice, not an inherit", () => {
    expect(resolveSellerRates(RATES, { overrideTeamLeadCents: 0 }).teamLeadCents).toBe(0);
  });
});

describe("validateOverridePatch — tri-state config boundary", () => {
  it("absent keys touch nothing", () => {
    expect(validateOverridePatch({})).toEqual({ patch: {} });
  });

  it("null resets: enabled → false, cents → 0", () => {
    const { patch, error } = validateOverridePatch({ overridesEnabled: null, overrideTeamLeadCents: null });
    expect(error).toBeUndefined();
    expect(patch).toEqual({ overridesEnabled: false, overrideTeamLeadCents: 0 });
  });

  it("whole integer cents only — a float is a client bug, not money", () => {
    expect(validateOverridePatch({ overrideManagerCents: 75.5 }).error).toMatch(/whole number/);
    expect(validateOverridePatch({ overrideManagerCents: -1 }).error).toMatch(/whole number/);
    expect(validateOverridePatch({ overrideManagerCents: 7500 }).patch.overrideManagerCents).toBe(7500);
  });

  it("PERCENT_OF_COMMISSION is reserved, not enableable", () => {
    expect(validateOverridePatch({ overrideBasis: "PERCENT_OF_COMMISSION" }).error).toMatch(/not yet supported/);
    expect(validateOverridePatch({ overrideBasis: "FLAT_PER_SALE" }).patch.overrideBasis).toBe("FLAT_PER_SALE");
  });
});

describe("statement document — override line", () => {
  const docInput = (overrideCents: number | undefined): StatementDocInput => ({
    company: { name: "Test Org" },
    rep: { id: 1, name: "Doc Rep" },
    period: { label: "Jul 6–12", startUtc: "2026-07-06T04:00:00.000Z", nextStartUtc: "2026-07-13T04:00:00.000Z", timezone: "America/New_York" },
    statement: { id: 1, status: "OPEN", calculationVersion: 1, tierLabel: null, rateCents: 0, structure: null },
    sales: [],
    money: {
      grossCommissionCents: 0, adjustmentCents: 0, spiffCents: 0,
      overrideCents, overrideItemCount: overrideCents ? 2 : 0,
      hourlyPayCents: 0, hourlyMinutes: 0, hourlyRateCents: null,
      finalCommissionCents: overrideCents ?? 0,
    },
    holdback: { reservePercent: 0, reserveCents: 0, netPayableCents: overrideCents ?? 0, earnedCents: overrideCents ?? 0 },
    reserve: { balanceCents: 0, capCents: null },
    adjustments: [],
    issuedAtIso: "2026-07-13T12:00:00.000Z",
  });

  it("override cents flow into totals and earned (the CSV-total mirror)", () => {
    const doc = buildStatementDocument(docInput(10000));
    expect(doc.totals.overrideCents).toBe(10000);
    expect(doc.totals.overrideItemCount).toBe(2);
    expect(doc.totals.earnedCents).toBe(10000);
    expect(doc.payout.netPayCents).toBe(10000);
  });

  it("absent override input reads as zero — pre-override callers unchanged", () => {
    const doc = buildStatementDocument(docInput(undefined));
    expect(doc.totals.overrideCents).toBe(0);
    expect(doc.totals.earnedCents).toBe(0);
  });
});
