// The rep must be able to SEE their chargeback reserve — that was the whole ask.
// This screen has to answer, without anyone explaining it: how much is held,
// what the maximum is, how close I am to it, what percentage comes out each
// week, what came out THIS week, and what's happened to the balance since.
// And when the reserve is full it must say so in plain words, because "why is
// money still being taken?" is the question that generates the support ticket.
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

function weekPayload(holdback: any) {
  return {
    statement: null,
    computation: {
      qualifiedSaleCount: 6, rateCents: 17500, grossCommissionCents: 105000,
      adjustmentCents: 0, finalCommissionCents: 105000, tierLabel: "1-6",
      retro: { salesUntilNextTier: 1, nextTierMinimumSales: 7, nextTierRateCents: 22500, nextTierProjectedCommissionCents: 157500 },
    },
    bounds: { localWeekLabel: "Aug 3 – Aug 9, 2026" },
    structure: { structure: "TIERED", flatRateCents: null, tiers: TIERS, planName: "Custom Weekly Tiers", acceptedAt: "2026-08-01T00:00:00Z" },
    sales: [], adjustments: [], holdback,
  };
}

// Mid-build: $600 held of a $2,500 maximum, 10% coming out each week.
const BUILDING = {
  current: { reservePercent: 10, reserveCents: 10500, netPayableCents: 94500, earnedCents: 105000 },
  ledger: { reservePercent: 10, reserveBalanceCents: 60000, netPaidCents: 200000, earnedToDateCents: 260000 },
};
const BUILDING_RESERVE = {
  repId: 9, reservePercent: 10, reserveCapCents: 250000, balanceCents: 60000,
  capRemainingCents: 190000, capProgressPercent: 24, atCap: false,
  heldToDateCents: 75000, drawnDownToDateCents: 15000, releasedToDateCents: 0,
  latestHold: { id: 3, kind: "hold", amountCents: 10500, weekLabel: "Jul 27 – Aug 2, 2026", reason: "Weekly chargeback reserve", createdAt: "2026-08-02T00:00:00Z" },
  entries: [
    { id: 3, kind: "hold", amountCents: 10500, weekLabel: "Jul 27 – Aug 2, 2026", reason: "Weekly chargeback reserve", createdAt: "2026-08-02T00:00:00Z" },
    { id: 2, kind: "drawdown", amountCents: -15000, weekLabel: null, reason: "Chargeback - 12 Oak St cancelled", createdAt: "2026-07-20T00:00:00Z" },
    { id: 1, kind: "hold", amountCents: 64500, weekLabel: "Jul 20 – Jul 26, 2026", reason: "Weekly chargeback reserve", createdAt: "2026-07-26T00:00:00Z" },
  ],
};

// At the cap: nothing more is held, the whole week is paid out.
const AT_CAP = {
  current: { reservePercent: 10, reserveCents: 0, netPayableCents: 105000, earnedCents: 105000 },
  ledger: { reservePercent: 10, reserveBalanceCents: 250000, netPaidCents: 900000, earnedToDateCents: 1150000 },
};
const AT_CAP_RESERVE = {
  ...BUILDING_RESERVE, balanceCents: 250000, capRemainingCents: 0, capProgressPercent: 100, atCap: true,
};

function renderPage(payload: any, reserve: any | null) {
  apiRequest.mockImplementation((...args: any[]) => {
    const url = args.find(a => typeof a === "string" && a.startsWith("/")) ?? "";
    if (url.includes("me/current")) return Promise.resolve({ json: () => Promise.resolve(payload) });
    if (url.includes("/api/me/reserve")) return Promise.resolve({ json: () => Promise.resolve(reserve ?? {}) });
    return Promise.resolve({ json: () => Promise.resolve([]) });
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MyCommission /></QueryClientProvider>);
}

beforeEach(() => apiRequest.mockReset());

describe("the rep's chargeback reserve", () => {
  it("shows the balance, the maximum, progress toward it, and this week's hold", async () => {
    renderPage(weekPayload(BUILDING), BUILDING_RESERVE);

    // Balance comes from the LEDGER endpoint (the only thing that knows about
    // drawdowns), not from the week's rolled-up split.
    const balance = await screen.findByTestId("holdback-balance");
    expect(balance.textContent).toBe("$600");

    // The maximum and the progress toward it.
    const capLabel = await screen.findByTestId("reserve-cap-label");
    expect(capLabel.textContent).toContain("$600");
    expect(capLabel.textContent).toContain("$2,500");
    const bar = screen.getByRole("progressbar", { name: /reserve maximum/i });
    expect(bar.getAttribute("aria-valuenow")).toBe("24");

    // The percentage coming out each week, and THIS week's actual hold.
    expect(screen.getByTestId("holdback-card").textContent).toContain("10% held");
    expect(screen.getByTestId("holdback-reserve").textContent).toBe("−$105");
    expect(screen.getByTestId("holdback-net").textContent).toBe("$945");

    // How much further it has to go before it stops.
    expect(screen.getByTestId("reserve-remaining").textContent).toContain("$1,900");
  });

  it("explains in plain language what the reserve is FOR and that it stops", async () => {
    renderPage(weekPayload(BUILDING), BUILDING_RESERVE);
    const explainer = await screen.findByTestId("reserve-explainer");
    expect(explainer.textContent).toMatch(/cancel/i);
    expect(explainer.textContent).toMatch(/charge back|chargeback/i);
    expect(explainer.textContent).toMatch(/stops/i);
  });

  it("lists the history - holds, chargebacks, and releases with dates and reasons", async () => {
    renderPage(weekPayload(BUILDING), BUILDING_RESERVE);
    const history = await screen.findByTestId("reserve-history");
    expect(history.textContent).toContain("Held from your pay");
    expect(history.textContent).toContain("Used for a cancellation");
    expect(history.textContent).toContain("Chargeback - 12 Oak St cancelled");
    expect(history.textContent).toContain("Jul 27 – Aug 2, 2026");
    // Signs are shown from the rep's point of view: a drawdown leaves the pot.
    expect(screen.getByTestId("reserve-entry-2").textContent).toContain("−$150");
    expect(screen.getByTestId("reserve-entry-3").textContent).toContain("+$105");
  });

  it("says 'fully covered, nothing more is being held' at the cap", async () => {
    renderPage(weekPayload(AT_CAP), AT_CAP_RESERVE);
    const atCap = await screen.findByTestId("reserve-at-cap");
    expect(atCap.textContent).toMatch(/fully covered/i);
    expect(atCap.textContent).toMatch(/nothing more is being held/i);
    expect(screen.queryByTestId("reserve-remaining")).toBeNull();

    expect(screen.getByTestId("holdback-card").textContent).toContain("Fully covered");
    expect(screen.getByTestId("holdback-reserve").textContent).toBe("−$0");
    expect(screen.getByTestId("holdback-net").textContent).toBe("$1,050");
    expect(screen.getByRole("progressbar", { name: /reserve maximum/i }).getAttribute("aria-valuenow")).toBe("100");
  });

  it("renders the week split even before the ledger read lands (no hole in the card)", async () => {
    renderPage(weekPayload(BUILDING), null);
    await waitFor(() => expect(screen.getByTestId("holdback-card")).toBeTruthy());
    // Falls back to the week payload's rolled balance rather than showing nothing.
    expect(screen.getByTestId("holdback-balance").textContent).toBe("$600");
    expect(screen.getByTestId("holdback-reserve").textContent).toBe("−$105");
  });

  it("shows no reserve card at all when the tenant runs no reserve", async () => {
    renderPage(weekPayload({
      current: { reservePercent: 0, reserveCents: 0, netPayableCents: 105000, earnedCents: 105000 },
      ledger: { reservePercent: 0, reserveBalanceCents: 0, netPaidCents: 0, earnedToDateCents: 0 },
    }), null);
    await waitFor(() => expect(screen.getByTestId("text-week-commission")).toBeTruthy());
    expect(screen.queryByTestId("holdback-card")).toBeNull();
  });
});
