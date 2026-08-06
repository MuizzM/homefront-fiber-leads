// ── The rep-facing override card must know when to stay silent ───────────────
//
// Overrides are an upline's money. A plain rep — no downline, no ledger rows —
// must see NOTHING: no empty card, no explainer for a program that doesn't
// apply to them. And when the card does render, payable and held are SEPARATE
// figures (certain and uncertain money never share a number), with the
// statement-reconciliation footer appearing only when a statement actually
// froze an override component.
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: 1, name: "Lena Lead", role: "team_lead", teamMemberId: 5 } }),
}));
const apiRequest = vi.fn();
vi.mock("@/lib/queryClient", () => ({
  apiRequest: (...a: any[]) => apiRequest(...a),
  queryClient: undefined,
}));

import MyCommission from "../../client/src/pages/MyCommission";

const WEEK_PAYLOAD = {
  statement: null,
  computation: {
    qualifiedSaleCount: 3, rateCents: 15000, grossCommissionCents: 45000,
    adjustmentCents: 0, finalCommissionCents: 45000, tierLabel: "1-6",
    retro: { salesUntilNextTier: 4, nextTierMinimumSales: 7, nextTierRateCents: 20000, nextTierProjectedCommissionCents: 140000 },
  },
  bounds: { localWeekLabel: "Aug 3 – Aug 9, 2026" },
  structure: { structure: "TIERED", flatRateCents: null, tiers: [
    { minimumSales: 1, maximumSales: 6, rateCents: 15000, label: "1-6" },
    { minimumSales: 7, maximumSales: null, rateCents: 20000, label: "7+" },
  ], planName: "Weekly Tiers", acceptedAt: "2026-08-01T00:00:00Z" },
  sales: [], adjustments: [], holdback: null,
};

function overridePayload(over: Record<string, unknown> = {}) {
  return {
    hasDownline: true,
    bounds: { weekStartUtc: "2026-08-03T04:00:00.000Z", nextWeekStartUtc: "2026-08-10T04:00:00.000Z" },
    totals: { rowCount: 2, payableCents: 2500, heldCents: 1000, settledCents: 0 },
    rows: [
      {
        id: 1, saleId: 11, soldAt: "2026-08-03T15:00:00.000Z", saleStatus: "QUALIFIED",
        downlineRepId: 7, downlineRepName: "Rex Rep", downlineRoleAtEarn: "rep", level: 1,
        basis: "FLAT_PER_SALE", entryType: "EARN", amountCents: 2500, status: "PAYABLE", holdPayableAfter: null,
      },
      {
        id: 2, saleId: 12, soldAt: "2026-08-04T15:00:00.000Z", saleStatus: "PENDING",
        downlineRepId: 7, downlineRepName: "Rex Rep", downlineRoleAtEarn: "rep", level: 1,
        basis: "FLAT_PER_SALE", entryType: "EARN", amountCents: 1000, status: "HELD", holdPayableAfter: "2026-08-20T00:00:00.000Z",
      },
    ],
    statementOverrideCents: null,
    ...over,
  };
}

function renderPage(overrides: any) {
  apiRequest.mockImplementation((...args: any[]) => {
    const url = args.find(a => typeof a === "string" && a.startsWith("/")) ?? "";
    if (url.includes("/api/commission/overrides/me")) return Promise.resolve({ json: () => Promise.resolve(overrides) });
    if (url.includes("me/current")) return Promise.resolve({ json: () => Promise.resolve(WEEK_PAYLOAD) });
    return Promise.resolve({ json: () => Promise.resolve([]) });
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MyCommission /></QueryClientProvider>);
}

beforeEach(() => apiRequest.mockReset());

describe("the rep's override earnings card", () => {
  it("renders NOTHING for a plain rep — no downline, no rows", async () => {
    renderPage(overridePayload({
      hasDownline: false,
      totals: { rowCount: 0, payableCents: 0, heldCents: 0, settledCents: 0 },
      rows: [],
    }));
    // The page itself is up…
    await waitFor(() => expect(screen.getByTestId("text-week-commission")).toBeTruthy());
    // …the override endpoint has been asked…
    await waitFor(() => expect(apiRequest.mock.calls.some(
      c => c.some((a: any) => typeof a === "string" && a.includes("/api/commission/overrides/me")),
    )).toBe(true));
    // …and the card still isn't there.
    expect(screen.queryByTestId("override-earnings-card")).toBeNull();
  });

  it("shows payable and held as SEPARATE figures, never one blended number", async () => {
    renderPage(overridePayload());
    const card = await screen.findByTestId("override-earnings-card");
    expect(screen.getByTestId("override-payable").textContent).toBe("$25");
    expect(screen.getByTestId("override-held").textContent).toBe("$10");
    // Nothing on the card adds the two into a $35.
    expect(card.textContent).not.toContain("$35");
  });

  it("lists each override row with its downline rep, sale status, and ledger status", async () => {
    renderPage(overridePayload());
    const row1 = await screen.findByTestId("override-row-1");
    expect(row1.textContent).toContain("Rex Rep");
    expect(row1.textContent).toContain("Rep");
    expect(row1.textContent).toContain("counts");     // SaleChip for QUALIFIED
    expect(row1.textContent).toContain("$25");
    expect(row1.textContent).toContain("Payable");    // overrideStatusLabel
    const row2 = screen.getByTestId("override-row-2");
    expect(row2.textContent).toContain("pending");
    expect(row2.textContent).toContain("On hold");
  });

  it("shows the reconciliation footer ONLY when a statement froze an override amount", async () => {
    renderPage(overridePayload({ statementOverrideCents: 3500 }));
    const footer = await screen.findByTestId("override-statement-footer");
    expect(footer.textContent).toContain("Included in your statement");
    expect(footer.textContent).toContain("$35");
  });

  it("omits the footer when no statement exists (statementOverrideCents null)", async () => {
    renderPage(overridePayload({ statementOverrideCents: null }));
    await screen.findByTestId("override-earnings-card");
    expect(screen.queryByTestId("override-statement-footer")).toBeNull();
  });

  it("still renders the card for an upline with a downline but no rows yet — at $0", async () => {
    renderPage(overridePayload({
      hasDownline: true,
      totals: { rowCount: 0, payableCents: 0, heldCents: 0, settledCents: 0 },
      rows: [],
    }));
    await screen.findByTestId("override-earnings-card");
    expect(screen.getByTestId("override-payable").textContent).toBe("$0");
    expect(screen.getByTestId("override-no-rows").textContent).toMatch(/No override earnings this week/i);
  });
});
