// "What will I actually be paid?" — answered in the hero, not the fine print.
//
// When the tenant runs a chargeback reserve, the week hero states the net
// payout ("You'll be paid $X · after N% reserve") right under the earned
// number. When no reserve is configured, that line must NOT appear — a rep
// with no holdback should never be told their pay is being held.
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: 1, name: "Rae Rep", role: "rep", teamMemberId: 9 } }),
}));
const apiRequest = vi.fn();
vi.mock("@/lib/queryClient", () => ({
  apiRequest: (...a: any[]) => apiRequest(...a),
  queryClient: undefined,
}));

import MyCommission from "../../client/src/pages/MyCommission";

const TIERS = [
  { minimumSales: 1, maximumSales: 6, rateCents: 17500, label: "1-6" },
  { minimumSales: 7, maximumSales: null, rateCents: 22500, label: "7+" },
];

function weekPayload(over: Record<string, any> = {}) {
  return {
    statement: null,
    computation: {
      qualifiedSaleCount: 6, rateCents: 17500, grossCommissionCents: 105000,
      adjustmentCents: 0, finalCommissionCents: 105000, tierLabel: "1-6",
      retro: { salesUntilNextTier: 1, nextTierMinimumSales: 7, nextTierRateCents: 22500, nextTierProjectedCommissionCents: 157500 },
    },
    bounds: { localWeekLabel: "Aug 3 - Aug 9, 2026" },
    structure: { structure: "TIERED", flatRateCents: null, tiers: TIERS, planName: "Custom Weekly Tiers", acceptedAt: "2026-08-01T00:00:00Z" },
    sales: [],
    adjustments: [],
    ...over,
  };
}

const HOLDBACK = {
  current: { reservePercent: 10, reserveCents: 10500, netPayableCents: 94500, earnedCents: 105000 },
  ledger: { reservePercent: 10, reserveBalanceCents: 30000, netPaidCents: 200000, earnedToDateCents: 230000 },
};

function renderPage(payload: any) {
  apiRequest.mockImplementation((...args: any[]) => {
    const url = args.find(a => typeof a === "string" && a.startsWith("/")) ?? "";
    if (url.includes("me/current")) return Promise.resolve({ json: () => Promise.resolve(payload) });
    return Promise.resolve({ json: () => Promise.resolve([]) });
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MyCommission /></QueryClientProvider>);
}

beforeEach(() => apiRequest.mockReset());

describe("net pay after holdback, in the hero", () => {
  it("states the exact net payout and the reserve that produced it", async () => {
    renderPage(weekPayload({ holdback: HOLDBACK }));
    const amount = await screen.findByTestId("hero-net-pay-amount");
    expect(amount.textContent).toBe("$945");
    const line = screen.getByTestId("hero-net-pay");
    expect(line.textContent).toContain("You'll be paid");
    expect(line.textContent).toContain("10% reserve");
    expect(line.textContent).toContain("$105 held");
  });

  it("never shows a holdback line when no reserve is configured", async () => {
    renderPage(weekPayload());
    await waitFor(() => expect(screen.getByTestId("text-week-commission")).toBeTruthy());
    expect(screen.queryByTestId("hero-net-pay")).toBeNull();
  });

  it("never shows a holdback line at reserve 0%", async () => {
    renderPage(weekPayload({
      holdback: {
        current: { reservePercent: 0, reserveCents: 0, netPayableCents: 105000, earnedCents: 105000 },
        ledger: { reservePercent: 0, reserveBalanceCents: 0, netPaidCents: 0, earnedToDateCents: 0 },
      },
    }));
    await waitFor(() => expect(screen.getByTestId("text-week-commission")).toBeTruthy());
    expect(screen.queryByTestId("hero-net-pay")).toBeNull();
  });

  it("labels an early-locked current week honestly and calls sales pay commission", async () => {
    renderPage(weekPayload({
      statement: {
        id: 9, status: "FINALIZED", qualified_sale_count: 6, rate_cents: 17500,
        gross_commission_cents: 105000, final_commission_cents: 105000,
        week_start_utc: "2026-08-17T04:00:00.000Z",
      },
      computation: null,
      locked: true,
      bounds: {
        localWeekLabel: "Aug 17 - Aug 23, 2026",
        weekStartUtc: "2026-08-17T04:00:00.000Z",
        nextWeekStartUtc: "2999-08-24T04:00:00.000Z",
      },
    }));
    expect(await screen.findByTestId("week-state")).toHaveTextContent("Finalized early");
    expect(screen.getByTestId("finalized-early-warning")).toHaveTextContent(/locked before the scheduled week close/i);
    expect(screen.getByText("Gross commission")).toBeInTheDocument();
    expect(screen.queryByText("Base pay")).toBeNull();
  });
});
