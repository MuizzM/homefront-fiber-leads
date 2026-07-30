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

describe("review-confirmed guards", () => {
  it("a reversal that never QUALIFIED does not invent a clawback", async () => {
    // A sale reversed straight from PENDING never counted toward the week, so
    // no band was lost — showing the panel would claim a clawback from a band
    // the rep never held.
    const p = weekPayload();
    p.sales[6].qualified_at = null;
    renderPage(p);
    await screen.findByTestId("week-sales");
    expect(screen.queryByTestId("band-drop-notice")).toBeNull();
  });

  it("a locked week shows the frozen statement, never a re-ranked ladder", async () => {
    // Statements freeze rates but NOT the tier list — ranking history against
    // today's ladder could re-rank a past week after a plan change.
    const p = weekPayload({ locked: true, computation: null,
      statement: { status: "FINALIZED", qualified_sale_count: 6, rate_cents: 17500,
        gross_commission_cents: 105000, final_commission_cents: 105000 } });
    renderPage(p);
    await screen.findByTestId("week-sales");
    expect(screen.queryByTestId("rank-card")).toBeNull();
  });
});

describe("the rank card — Bronze/Silver/Gold/Platinum on the rep's own ladder", () => {
  it("names the current week's rank and prices the climb retroactively", async () => {
    // 6 qualified on the 1-6/$175 · 7+/$225 ladder: a Bronze week, 1 sale from
    // Silver. The gain shown must be the WHOLE-week jump: 7 x $225 - 6 x $175
    // = $525 — not one sale's $225.
    renderPage(weekPayload());
    const card = await screen.findByTestId("rank-card");
    expect(card).toHaveTextContent("Bronze");
    // Hero leads with the financial upside, framed as the retroactive jump.
    expect(card).toHaveTextContent("Next target");
    expect(card).toHaveTextContent("Silver");
    expect(screen.getByTestId("rank-hero-gain")).toHaveTextContent("+$525");
    expect(screen.getByTestId("rank-next")).toHaveTextContent(/1 more sale unlocks/i);
    // current → next earnings: 6 x $175 = $1,050  →  7 x $225 = $1,575
    const jump = screen.getByTestId("rank-earnings-jump");
    expect(jump).toHaveTextContent("$1,050");
    expect(jump).toHaveTextContent("$1,575");
    expect(card).toHaveTextContent(/close by sunday night/i);
  });

  it("shows every rung of the rail with its range and rate", async () => {
    renderPage(weekPayload());
    await screen.findByTestId("rank-rail");
    expect(screen.getByTestId("rank-rung-bronze")).toHaveTextContent("1–6 sales");
    expect(screen.getByTestId("rank-rung-bronze")).toHaveTextContent("$175");
    expect(screen.getByTestId("rank-rung-silver")).toHaveTextContent("7+ sales");
    expect(screen.getByTestId("rank-rung-silver")).toHaveTextContent("$225");
  });

  it("celebrates the top of the ladder instead of dangling a next rank", async () => {
    const p = weekPayload();
    p.computation!.qualifiedSaleCount = 8;
    p.computation!.rateCents = 22500;
    p.computation!.grossCommissionCents = 8 * 22500;
    p.computation!.finalCommissionCents = 8 * 22500;
    p.computation!.tierLabel = "7+";
    p.computation!.retro = null;
    p.sales = p.sales.slice(0, 6);
    renderPage(p);
    const card = await screen.findByTestId("rank-card");
    expect(card).toHaveTextContent("Silver");
    expect(card).toHaveTextContent(/top rank reached/i);
    expect(screen.queryByTestId("rank-next")).toBeNull();
  });

  it("invites the first sale as the start of Bronze", async () => {
    const p = weekPayload();
    p.computation!.qualifiedSaleCount = 0;
    p.computation!.grossCommissionCents = 0;
    p.computation!.finalCommissionCents = 0;
    p.sales = [];
    renderPage(p);
    const card = await screen.findByTestId("rank-card");
    // First sale is now framed as the upside to the first rank.
    expect(card).toHaveTextContent("Next target");
    expect(card).toHaveTextContent("Bronze");
    expect(screen.getByTestId("rank-next")).toHaveTextContent(/1 more sale unlocks/i);
  });

  it("leads with the upside for the spec example (3 sales → +$750, $450 → $1,200)", async () => {
    // Bronze 1-5 @ $150, Silver 6+ @ $200; 3 qualified sales.
    const p = weekPayload({
      structure: { structure: "TIERED", flatRateCents: null, planName: "Custom", acceptedAt: "2026-08-01T00:00:00Z",
        tiers: [
          { minimumSales: 1, maximumSales: 5, rateCents: 15000, label: "1-5" },
          { minimumSales: 6, maximumSales: null, rateCents: 20000, label: "6+" },
        ] },
    });
    p.computation.qualifiedSaleCount = 3;
    p.computation.rateCents = 15000;
    p.computation.grossCommissionCents = 45000;
    p.computation.finalCommissionCents = 45000;
    p.computation.retro = null;
    p.sales = p.sales.slice(0, 3);
    renderPage(p);
    await screen.findByTestId("rank-card");
    expect(screen.getByTestId("rank-hero-gain")).toHaveTextContent("+$750");
    expect(screen.getByTestId("rank-next")).toHaveTextContent(/3 more sales unlock/i);
    const jump = screen.getByTestId("rank-earnings-jump");
    expect(jump).toHaveTextContent("$450");
    expect(jump).toHaveTextContent("$1,200");
    // 3 of 6 progress + a checkpoint per sale to the Silver unlock.
    const bar = screen.getByRole("progressbar", { name: /toward silver/i });
    expect(bar).toHaveAttribute("aria-valuenow", "3");
    expect(bar).toHaveAttribute("aria-valuemax", "6");
    expect(screen.getByTestId("rank-checkpoints")).toBeInTheDocument();
  });

  it("exposes the climb as a real progressbar for assistive tech", async () => {
    renderPage(weekPayload());
    await screen.findByTestId("rank-card");
    const bar = screen.getByRole("progressbar", { name: /toward silver/i });
    expect(bar).toHaveAttribute("aria-valuenow");
  });
});

describe("the chargeback reserve (holdback) card", () => {
  const withHoldback = (over: Record<string, any> = {}) => weekPayload({
    holdback: {
      current: { reservePercent: 10, reserveCents: 10500, netPayableCents: 94500, earnedCents: 105000 },
      ledger: { reservePercent: 10, reserveBalanceCents: 31500, netPaidCents: 283500, earnedToDateCents: 315000 },
    },
    ...over,
  });

  it("shows the earned → reserve → net split and the running balance, all from server numbers", async () => {
    renderPage(withHoldback());
    const card = await screen.findByTestId("holdback-card");
    expect(card).toHaveTextContent("10% held");
    expect(screen.getByTestId("holdback-reserve")).toHaveTextContent("−$105");   // 10% of $1,050
    expect(screen.getByTestId("holdback-net")).toHaveTextContent("$945");        // paid this week
    expect(screen.getByTestId("holdback-balance")).toHaveTextContent("$315");    // running reserve
    // reserve + net reconcile with the earned line (no invented cent on screen)
    expect(card).toHaveTextContent("$1,050");
  });

  it("explains release at termination without overpromising", async () => {
    renderPage(withHoldback());
    const card = await screen.findByTestId("holdback-card");
    expect(card).toHaveTextContent(/released within 90 days/i);
    expect(card).toHaveTextContent(/less any valid chargebacks/i);
  });

  it("renders nothing when the tenant runs no reserve (percent 0) — never a fake $0 card", async () => {
    renderPage(withHoldback({ holdback: {
      current: { reservePercent: 0, reserveCents: 0, netPayableCents: 105000, earnedCents: 105000 },
      ledger: { reservePercent: 0, reserveBalanceCents: 0, netPaidCents: 105000, earnedToDateCents: 105000 },
    } }));
    await screen.findByTestId("week-sales");
    expect(screen.queryByTestId("holdback-card")).toBeNull();
  });

  it("is absent entirely when the server sends no holdback (legacy payload)", async () => {
    renderPage(weekPayload());
    await screen.findByTestId("week-sales");
    expect(screen.queryByTestId("holdback-card")).toBeNull();
  });
});
