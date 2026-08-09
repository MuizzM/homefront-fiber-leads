// ── Settlement authority on the commission console ───────────────────────────
//
// The server refuses week finalize / mark-paid / adjustment decisions to
// anything below payouts.pay (server/commissionRoutes.ts). The console used to
// gate those buttons on commission.read.all, which every MANAGER holds — so a
// manager saw a live "Finalize week" button, read a confirm dialog quoting an
// exact dollar total, clicked it, and got a 403 toast. These tests pin the
// rule: read.all shows the closeout BAR (status + export), payouts.pay shows
// the settlement BUTTONS, and anything between gets an honest review-only note.
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: 1, name: "Mona Manager", role: "manager", teamMemberId: 1 } }),
}));

// Per-test capability set — the component asks useCan(cap) per capability.
const grants = new Set<string>();
vi.mock("@/lib/capabilities", () => ({
  useCan: (cap: string) => grants.has(cap),
}));

const apiRequest = vi.fn();
vi.mock("@/lib/queryClient", () => ({
  apiRequest: (...a: any[]) => apiRequest(...a),
  queryClient: undefined,
}));

import CommissionConsole from "../../client/src/pages/CommissionConsole";

const OVERVIEW = {
  bounds: {
    weekStartUtc: "2026-08-03T04:00:00.000Z",
    nextWeekStartUtc: "2026-08-10T04:00:00.000Z",
    localWeekLabel: "Aug 3 – Aug 9, 2026",
    timezone: "America/New_York",
  },
  weekEnded: false,
  rows: [{
    repId: 1, repName: "Rex Rep", active: true,
    managerId: 100, managerName: "Mona Manager",
    teamLeadId: 200, teamLeadName: "Lena Lead",
    statementId: 11, status: "OPEN",
    qualifiedSaleCount: 3, pendingSaleCount: 0, reversedSaleCount: 0,
    tierLabel: "1-6", rateCents: 15000,
    grossCommissionCents: 45000, adjustmentCents: 0, finalCommissionCents: 45000,
    structure: "TIERED", planAccepted: true,
    hours: 0, hourlyMinutes: 0, hourlyRateCents: null, hourlyPayCents: 0, openClockSessions: 0,
    salesUntilNextTier: null, nextTierRateCents: null,
    nextTierProjectedCommissionCents: null, marginalJumpCents: null,
    installHold: { saleCount: 0, earliestPayableAfter: null },
    overridePayCents: 0, overrideItemCount: 0,
  }],
  totals: {
    projectedPayrollCents: 45000, finalizedPayrollCents: 0, paidPayrollCents: 0,
    exposureCents: 0, qualifiedSales: 3, repsWithSales: 1, installHoldSales: 0,
  },
  exceptions: [],
};

function renderConsole() {
  apiRequest.mockImplementation((...args: any[]) => {
    const url = args.find(a => typeof a === "string" && a.startsWith("/api/")) ?? "";
    if (url.startsWith("/api/commission/week-overview")) {
      return Promise.resolve({ json: () => Promise.resolve(OVERVIEW) });
    }
    return Promise.resolve({ json: () => Promise.resolve({}) });
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CommissionConsole />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiRequest.mockReset();
  grants.clear();
});

describe("commission console settlement authority", () => {
  it("manager (read.all, no payouts.pay): closeout bar is review-only - no dead settle buttons", async () => {
    grants.add("commission.read.all");
    grants.add("commission.read.downline");
    renderConsole();
    await waitFor(() => expect(screen.getByTestId("closeout-bar")).toBeTruthy());
    // The bar itself (status line + CSV export) stays — that's the read surface.
    expect(screen.getByTestId("export-csv")).toBeTruthy();
    // The settle buttons the server would 403 are GONE, replaced by the note.
    expect(screen.queryByTestId("btn-finalize-week")).toBeNull();
    expect(screen.queryByTestId("btn-mark-paid")).toBeNull();
    expect(screen.getByTestId("closeout-review-only").textContent).toMatch(/admin/i);
  });

  it("admin (payouts.pay): settle buttons render armed", async () => {
    grants.add("commission.read.all");
    grants.add("commission.read.downline");
    grants.add("payouts.pay");
    grants.add("settings.manage.org");
    renderConsole();
    await waitFor(() => expect(screen.getByTestId("closeout-bar")).toBeTruthy());
    expect(screen.getByTestId("btn-finalize-week")).toBeTruthy();
    expect(screen.getByTestId("btn-mark-paid")).toBeTruthy();
    expect(screen.queryByTestId("closeout-review-only")).toBeNull();
  });

  it("week fetch error shows a retry, not a dead-end sentence", async () => {
    grants.add("commission.read.all");
    apiRequest.mockImplementation((...args: any[]) => {
      const url = args.find(a => typeof a === "string" && a.startsWith("/api/")) ?? "";
      if (url.startsWith("/api/commission/week-overview")) return Promise.reject(new Error("boom"));
      return Promise.resolve({ json: () => Promise.resolve({}) });
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><CommissionConsole /></QueryClientProvider>);
    await waitFor(() => expect(screen.getByTestId("week-retry")).toBeTruthy());
  });
});
