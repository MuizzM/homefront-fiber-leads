// The mileage log as a bookkeeping record.
//
// Reimbursement is OFF by default here, which means for most orgs this log's
// whole value IS the record: a 1099 contractor deducts these miles themselves.
// So the things worth pinning are the ones a return depends on - that a total
// is scoped to a period you can name, that the months reconcile, that the
// arithmetic is visible before it is committed, and that the export carries
// the period you were looking at rather than everything you have ever driven.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { apiRequest, toast } = vi.hoisted(() => ({ apiRequest: vi.fn(), toast: vi.fn() }));
vi.mock("@/lib/queryClient", () => ({
  apiRequest: (...a: any[]) => apiRequest(...a),
  queryClient: { invalidateQueries: vi.fn() },
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { id: 1, name: "Rae Rep", role: "rep", teamMemberId: 9 } }) }));
vi.mock("@/lib/capabilities", () => ({ useCan: () => false }));

import Mileage from "@/pages/Mileage";

const RATE = { rateMilliCentsPerMile: 65_500, label: "$0.655/mi", effectiveFrom: "2026-01-01" };

function trip(over: Record<string, any> = {}) {
  return {
    id: 1, repId: 9, tripDate: "2026-08-04", startLocation: "Office", endLocation: "Oakwood",
    milesHundredths: 1_230, distanceMethod: "MANUAL", purpose: "Door knocking", notes: null,
    source: "MANUAL", status: "DRAFT", rateMilliCentsPerMile: null, reimbursementCents: null,
    startedAt: null, endedAt: null, submittedAt: null, rejectionReason: null,
    adjustmentCents: 0, adjustmentMilesHundredths: 0, ...over,
  };
}

// Two months, so the grouping and its subtotals have something to reconcile.
const TRIPS = [
  trip({ id: 1, tripDate: "2026-08-04", milesHundredths: 1_230 }),
  trip({ id: 2, tripDate: "2026-08-19", milesHundredths: 870 }),
  trip({ id: 3, tripDate: "2026-07-22", milesHundredths: 4_000 }),
];

const SUMMARY = {
  tripCount: 3, totalMilesHundredths: 6_100, totalMiles: "61.00 mi",
  approvedCents: 0, paidCents: 0, pendingMilesHundredths: 6_100, pendingEstimateCents: 0,
  reimbursementEnabled: false, currentRate: RATE,
};

let summaryUrls: string[] = [];

beforeEach(() => {
  apiRequest.mockReset(); toast.mockReset(); summaryUrls = [];
  apiRequest.mockImplementation((_method: string, url: string) => {
    if (url.startsWith("/api/mileage/consent")) {
      return Promise.resolve({ ok: true, json: async () => ({
        disclosureAcceptedAt: null, backgroundOptIn: false, currentVersion: "v1",
        mayStartGpsTrip: false, gpsPolicy: "LOCKED_OFF", mayChangeOwnConsent: false, adminLocked: true,
      }) });
    }
    if (url.startsWith("/api/mileage/summary")) {
      summaryUrls.push(url);
      return Promise.resolve({ ok: true, json: async () => SUMMARY });
    }
    if (url.startsWith("/api/mileage/trips")) {
      return Promise.resolve({ ok: true, json: async () => TRIPS });
    }
    return Promise.resolve({ ok: true, json: async () => ({}) });
  });
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}><Mileage /></QueryClientProvider>);
}

describe("the period a total belongs to", () => {
  it("opens on the month and asks the server for that range, not all history", async () => {
    renderPage();
    await screen.findByTestId("mileage-summary");
    expect(summaryUrls.some(u => /from=\d{4}-\d{2}-01/.test(u))).toBe(true);
  });

  it("re-scopes when a different period is chosen", async () => {
    renderPage();
    await screen.findByTestId("mileage-summary");
    await userEvent.click(screen.getByTestId("mileage-period-year"));
    // A year range starts on 1 January - a month range never does unless it IS January.
    await waitFor(() => expect(summaryUrls.some(u => /from=\d{4}-01-01/.test(u))).toBe(true));
  });

  it("exports the period on screen rather than everything ever driven", async () => {
    renderPage();
    await screen.findByTestId("mileage-summary");
    await userEvent.click(screen.getByTestId("mileage-period-year"));
    const link = screen.getByTestId("mileage-export").closest("a") ?? screen.getByTestId("mileage-export");
    await waitFor(() => expect(link.getAttribute("href")).toMatch(/from=\d{4}-01-01/));
  });

  it("leads with deductible miles when the org does not reimburse", async () => {
    renderPage();
    const total = await screen.findByTestId("mileage-period-total");
    expect(total).toHaveTextContent("61.00 mi");
    // …and exactly once - formatMiles already carries the unit.
    expect(total.textContent).not.toMatch(/mi\s*mi/);
  });
});

describe("months reconcile", () => {
  it("groups the log by calendar month and subtotals each one", async () => {
    renderPage();
    const august = await screen.findByTestId("mileage-month-2026-08");
    // 12.30 + 8.70 = 21.00
    expect(within(august).getByTestId("mileage-month-total-2026-08")).toHaveTextContent("21.00 mi");
    const july = screen.getByTestId("mileage-month-2026-07");
    expect(within(july).getByTestId("mileage-month-total-2026-07")).toHaveTextContent("40.00 mi");
  });

  it("puts the newest month first", async () => {
    renderPage();
    await screen.findByTestId("mileage-month-2026-08");
    const months = screen.getAllByTestId(/^mileage-month-\d{4}-\d{2}$/);
    expect(months[0]).toHaveAttribute("data-testid", "mileage-month-2026-08");
  });
});

describe("the arithmetic is visible before it is committed", () => {
  it("prices the trip at the live rate as it is typed", async () => {
    renderPage();
    await screen.findByTestId("mileage-manual-entry");
    await userEvent.type(screen.getByTestId("mileage-miles"), "10");
    // 10 mi at $0.655 = $6.55, shown with the rate that produced it.
    const preview = await screen.findByTestId("mileage-preview");
    expect(preview).toHaveTextContent("10.00 mi");
    expect(preview).toHaveTextContent("$0.655/mi");
    expect(preview).toHaveTextContent("$6.55");
  });

  it("round trip logs BOTH legs - the record is the real distance driven", async () => {
    renderPage();
    await screen.findByTestId("mileage-manual-entry");
    await userEvent.type(screen.getByTestId("mileage-miles"), "10");
    await userEvent.click(screen.getByTestId("mileage-round-trip"));

    const preview = await screen.findByTestId("mileage-preview");
    expect(preview).toHaveTextContent("20.00 mi (round trip)");
    expect(preview).toHaveTextContent("$13.10");

    await userEvent.click(screen.getByTestId("mileage-save-trip"));
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith(
      "POST", "/api/mileage/trips", expect.objectContaining({ miles: "20" }),
    ));
  });

  it("will not save a trip with no distance", async () => {
    renderPage();
    await screen.findByTestId("mileage-manual-entry");
    expect(screen.getByTestId("mileage-save-trip")).toBeDisabled();
  });
});
