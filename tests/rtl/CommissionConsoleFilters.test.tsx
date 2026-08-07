// ── Week filters on the commission console ───────────────────────────────────
//
// A manager closing out a floor needs to FIND a rep inside a week. The filters
// that do that sit directly above the payroll figures and the finalize button,
// which makes one property far more important than the filtering itself:
//
//   A FILTER NARROWS WHAT IS LISTED. IT NEVER NARROWS WHAT IS OWED.
//
// If filtering to one branch also shrank the projected-payroll figure, an admin
// could finalize a week believing it costs a fraction of what it does. So the
// totals, the exception rail, and the closeout actions all keep reading the
// UNFILTERED week, and these tests pin that alongside the ordinary behaviour.
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: 1, name: "Ada Admin", role: "admin", teamMemberId: 1 } }),
}));
vi.mock("@/lib/capabilities", () => ({
  useCan: () => true,
}));
const apiRequest = vi.fn();
vi.mock("@/lib/queryClient", () => ({
  apiRequest: (...a: any[]) => apiRequest(...a),
  queryClient: undefined,
}));

import CommissionConsole from "../../client/src/pages/CommissionConsole";

function row(over: Record<string, unknown> = {}) {
  return {
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
    ...over,
  };
}

const ROWS = [
  row({ repId: 1, repName: "Rex Rep", managerId: 100, managerName: "Mona Manager", teamLeadId: 200, teamLeadName: "Lena Lead", status: "OPEN" }),
  row({ repId: 2, repName: "Dana Door", managerId: 100, managerName: "Mona Manager", teamLeadId: 200, teamLeadName: "Lena Lead", status: "FINALIZED" }),
  row({ repId: 3, repName: "Sam Sold", managerId: 101, managerName: "Nate Manager", teamLeadId: null, teamLeadName: null, status: "PAID" }),
];

const OVERVIEW = {
  bounds: {
    weekStartUtc: "2026-08-03T04:00:00.000Z",
    nextWeekStartUtc: "2026-08-10T04:00:00.000Z",
    localWeekLabel: "Aug 3 – Aug 9, 2026",
    timezone: "America/New_York",
  },
  weekEnded: false,
  rows: ROWS,
  totals: {
    projectedPayrollCents: 135000, finalizedPayrollCents: 0, paidPayrollCents: 0,
    exposureCents: 0, qualifiedSales: 9, repsWithSales: 3, installHoldSales: 0,
  },
  exceptions: [],
};

function renderConsole() {
  // Child cards on this page call apiRequest with their own argument shapes, so
  // match on whichever argument looks like a URL rather than assuming position.
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

const table = () => screen.getByTestId("week-filters").parentElement as HTMLElement;
const repVisible = (name: string) => within(table()).queryAllByText(name).length > 0;

beforeEach(() => apiRequest.mockReset());

describe("commission console week filters", () => {
  it("lists every rep in the week before any filter is applied", async () => {
    renderConsole();
    await waitFor(() => expect(screen.getByTestId("week-filters")).toBeTruthy());
    expect(repVisible("Rex Rep")).toBe(true);
    expect(repVisible("Dana Door")).toBe(true);
    expect(repVisible("Sam Sold")).toBe(true);
    // No filter chrome until a filter is actually set.
    expect(screen.queryByTestId("filter-count")).toBeNull();
  });

  it("narrows by rep name", async () => {
    renderConsole();
    await waitFor(() => expect(screen.getByTestId("filter-rep")).toBeTruthy());
    fireEvent.change(screen.getByTestId("filter-rep"), { target: { value: "dana" } });
    await waitFor(() => expect(repVisible("Rex Rep")).toBe(false));
    expect(repVisible("Dana Door")).toBe(true);
    expect(screen.getByTestId("filter-count").textContent).toContain("1 of 3");
  });

  it("narrows by statement status", async () => {
    renderConsole();
    await waitFor(() => expect(screen.getByTestId("filter-status")).toBeTruthy());
    fireEvent.change(screen.getByTestId("filter-status"), { target: { value: "PAID" } });
    await waitFor(() => expect(repVisible("Sam Sold")).toBe(true));
    expect(repVisible("Rex Rep")).toBe(false);
    expect(repVisible("Dana Door")).toBe(false);
  });

  it("narrows by manager branch, using the server-derived upline", async () => {
    renderConsole();
    await waitFor(() => expect(screen.getByTestId("filter-upline")).toBeTruthy());
    fireEvent.change(screen.getByTestId("filter-upline"), { target: { value: "mgr:101" } });
    await waitFor(() => expect(repVisible("Sam Sold")).toBe(true));
    expect(repVisible("Rex Rep")).toBe(false);
    expect(repVisible("Dana Door")).toBe(false);
  });

  it("narrows by team lead", async () => {
    renderConsole();
    await waitFor(() => expect(screen.getByTestId("filter-upline")).toBeTruthy());
    fireEvent.change(screen.getByTestId("filter-upline"), { target: { value: "tl:200" } });
    await waitFor(() => expect(repVisible("Sam Sold")).toBe(false));
    expect(repVisible("Rex Rep")).toBe(true);
    expect(repVisible("Dana Door")).toBe(true);
  });

  it("says so when a filter matches nobody, instead of showing an empty week", async () => {
    renderConsole();
    await waitFor(() => expect(screen.getByTestId("filter-rep")).toBeTruthy());
    fireEvent.change(screen.getByTestId("filter-rep"), { target: { value: "nobody-by-this-name" } });
    await waitFor(() => expect(screen.getByTestId("filter-no-matches")).toBeTruthy());
    // The distinction that matters: the week HAS reps, the filter is too narrow.
    expect(screen.getByTestId("filter-no-matches").textContent).toContain("3 reps are producing");
  });

  it("clears back to the full week", async () => {
    renderConsole();
    await waitFor(() => expect(screen.getByTestId("filter-rep")).toBeTruthy());
    fireEvent.change(screen.getByTestId("filter-rep"), { target: { value: "dana" } });
    await waitFor(() => expect(repVisible("Rex Rep")).toBe(false));
    fireEvent.click(screen.getByTestId("filter-clear"));
    await waitFor(() => expect(repVisible("Rex Rep")).toBe(true));
    expect(screen.queryByTestId("filter-count")).toBeNull();
  });

  it("THE INVARIANT: filtering never changes the week's payroll figure", async () => {
    renderConsole();
    await waitFor(() => expect(screen.getByTestId("filter-rep")).toBeTruthy());
    // $1,350.00 across all three reps, before filtering.
    const before = screen.getAllByText(/\$1,350/).length;
    expect(before).toBeGreaterThan(0);

    fireEvent.change(screen.getByTestId("filter-rep"), { target: { value: "dana" } });
    await waitFor(() => expect(repVisible("Rex Rep")).toBe(false));

    // Still $1,350 — the week owes what it owes regardless of who is on screen.
    expect(screen.getAllByText(/\$1,350/).length).toBe(before);
  });
});
