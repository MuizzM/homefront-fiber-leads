// The clawback, said out loud.
//
// When a canceled deal pulls the week below a band boundary, EVERY surviving
// sale reprices down — losing the 7th on a 1-6 $175 / 7+ $225 ladder is not
// -$225, it is -$525. The engine already does this arithmetic (integration:
// "claws back the whole week's difference"); this suite pins the panel that
// explains it, because an unexplained $525 hole in yesterday's number is an
// angry call to a manager.
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

/** The week AFTER the 7th deal canceled: 6 qualified at the 1-6 band. */
function weekPayload(over: Record<string, any> = {}) {
  return {
    statement: null,
    computation: {
      qualifiedSaleCount: 6, rateCents: 17500, grossCommissionCents: 105000,
      adjustmentCents: 0, finalCommissionCents: 105000, tierLabel: "1-6",
      retro: { salesUntilNextTier: 1, nextTierMinimumSales: 7, nextTierRateCents: 22500, nextTierProjectedCommissionCents: 157500 },
    },
    bounds: { localWeekLabel: "Aug 3 – Aug 9, 2026" },
    structure: { structure: "TIERED", flatRateCents: null, tiers: TIERS, planName: "Custom Weekly Tiers", acceptedAt: "2026-08-01T00:00:00Z" },
    sales: [
      ...Array.from({ length: 6 }, (_, i) => ({
        id: i + 1, external_id: `lead:${i + 1}`, status: "QUALIFIED",
        sold_at: "2026-08-04T15:00:00Z", qualified_at: "2026-08-04T15:00:00Z",
        reversed_at: null, lead_id: i + 1, address: `${i + 1} Maple St`, city: "Testburg",
      })),
      { id: 7, external_id: "lead:7", status: "REVERSED", sold_at: "2026-08-05T15:00:00Z",
        qualified_at: "2026-08-05T15:00:00Z", reversed_at: "2026-08-06T09:00:00Z",
        lead_id: 7, address: "7 Maple St", city: "Testburg" },
    ],
    adjustments: [],
    ...over,
  };
}

function renderPage(payload: any) {
  apiRequest.mockImplementation((...args: any[]) => {
    // Different call sites pass (method, url) or (url); find the path arg.
    const url = args.find(a => typeof a === "string" && a.startsWith("/")) ?? "";
    if (url.includes("me/current")) return Promise.resolve({ json: () => Promise.resolve(payload) });
    return Promise.resolve({ json: () => Promise.resolve([]) });
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MyCommission /></QueryClientProvider>);
}

beforeEach(() => apiRequest.mockReset());

describe("the band-drop notice", () => {
  it("explains the FULL clawback, not just the lost sale", async () => {
    renderPage(weekPayload());
    const notice = await screen.findByTestId("band-drop-notice");
    // 7 would pay 7 x $225 = $1,575; 6 pay 6 x $175 = $1,050. Drop = $525.
    expect(notice).toHaveTextContent("dropped more than one sale");
    expect(notice).toHaveTextContent("7+");                 // the band that was lost
    expect(notice).toHaveTextContent("$225");               // would-be rate
    expect(notice).toHaveTextContent("$175");               // repriced rate
    expect(notice).toHaveTextContent("$525");               // the whole difference
  });

  it("offers the way back while the week is open", async () => {
    renderPage(weekPayload());
    const notice = await screen.findByTestId("band-drop-notice");
    expect(notice).toHaveTextContent(/1 more sale puts every door back/i);
  });

  it("stays silent when the cancellation did NOT cross a band", async () => {
    // 3 qualified + 1 reversed: 4 would still be the 1-6 band — same rate,
    // nothing retroactive happened, no scary panel.
    const p = weekPayload();
    p.computation!.qualifiedSaleCount = 3;
    p.computation!.grossCommissionCents = 52500;
    p.computation!.finalCommissionCents = 52500;
    p.sales = p.sales.slice(0, 3).concat(p.sales[6]);
    renderPage(p);
    await screen.findByTestId("week-sales");
    expect(screen.queryByTestId("band-drop-notice")).toBeNull();
  });

  it("stays silent with no reversed sales at all", async () => {
    const p = weekPayload();
    p.sales = p.sales.slice(0, 6);
    renderPage(p);
    await screen.findByTestId("week-sales");
    expect(screen.queryByTestId("band-drop-notice")).toBeNull();
  });

  it("keeps the reversed door visible and struck through in the sales list", async () => {
    renderPage(weekPayload());
    const row = await screen.findByTestId("sale-row-7");
    expect(row.querySelector(".line-through")).not.toBeNull();
    expect(row).toHaveTextContent("7 Maple St");
  });
});
