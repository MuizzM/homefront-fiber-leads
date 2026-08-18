// ── "Past weeks" is the caller's own history, never the org's ────────────────
//
// GET /api/commission/statements widens to the caller's whole read scope when
// no repId is given — a team lead's downline, a manager's entire tenant. On a
// page titled "My commission" every row renders the same bare week label, so
// that scope-widening surfaced as inexplicable duplicate weeks with different
// dollar amounts (and the viewer's own week often pushed out of the visible
// slice). The page must therefore always narrow the request to itself, count
// honestly when it truncates, and say so when the fetch fails.
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

const WEEK = {
  statement: null,
  computation: null,
  bounds: { localWeekLabel: "Aug 3 - Aug 9, 2026" },
  structure: null,
  sales: [],
  adjustments: [],
  noPlan: true,
};

function stmt(id: number, label: string) {
  return {
    id, rep_id: 9, status: "PAID", local_week_label: label,
    qualified_sale_count: 2, rate_cents: 15000, final_commission_cents: 30000,
  };
}

function renderPage(history: any[] | Error, current: any = WEEK) {
  apiRequest.mockImplementation((...args: any[]) => {
    const url = args.find(a => typeof a === "string" && a.startsWith("/")) ?? "";
    if (url.includes("me/current")) return Promise.resolve({ json: () => Promise.resolve(current) });
    if (url.includes("/api/commission/statements")) {
      if (history instanceof Error) return Promise.reject(history);
      return Promise.resolve({ json: () => Promise.resolve(history) });
    }
    return Promise.resolve({ json: () => Promise.resolve([]) });
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MyCommission /></QueryClientProvider>);
}

beforeEach(() => apiRequest.mockReset());

describe("past weeks scope + honesty", () => {
  it("requests statements narrowed to the caller's own repId", async () => {
    renderPage([stmt(1, "Jul 27 - Aug 2")]);
    await waitFor(() => {
      const urls = apiRequest.mock.calls.flat().filter(a => typeof a === "string");
      expect(urls.some(u => u.includes("/api/commission/statements?repId=9"))).toBe(true);
    });
  });

  it("caps the list at 8 and says so instead of showing a bigger number than the rows", async () => {
    const many = Array.from({ length: 12 }, (_, i) => stmt(i + 1, `Week ${i + 1}`));
    renderPage(many);
    await waitFor(() => expect(screen.getByText("last 8 of 12")).toBeTruthy());
    // Exactly 8 rows render.
    const rows = screen.getAllByTestId(/^row-week-/);
    expect(rows.length).toBe(8);
  });

  it("shows the plain count when nothing is truncated", async () => {
    renderPage([stmt(1, "Jul 27 - Aug 2"), stmt(2, "Jul 20 - Jul 26")]);
    await waitFor(() => expect(screen.getAllByTestId(/^row-week-/).length).toBe(2));
  });

  it("does not repeat the current statement under Past weeks", async () => {
    const current = {
      ...WEEK,
      noPlan: false,
      statement: { id: 44, status: "OPEN", week_start_utc: "2026-08-17T04:00:00.000Z", qualified_sale_count: 0, rate_cents: 15000, final_commission_cents: 0, gross_commission_cents: 0 },
      structure: { structure: "FLAT", flatRateCents: 15000, tiers: [], planName: "Flat", acceptedAt: "2026-08-01T00:00:00Z" },
      bounds: { localWeekLabel: "Aug 17 - Aug 23, 2026", weekStartUtc: "2026-08-17T04:00:00.000Z" },
    };
    renderPage([
      { ...stmt(44, "Aug 17 - Aug 23, 2026"), week_start_utc: "2026-08-17T04:00:00.000Z" },
      { ...stmt(43, "Aug 10 - Aug 16, 2026"), week_start_utc: "2026-08-10T04:00:00.000Z" },
    ], current);
    await waitFor(() => expect(screen.getAllByTestId(/^row-week-/).length).toBe(1));
    expect(screen.queryByTestId("row-week-44")).toBeNull();
    expect(screen.getByTestId("row-week-43")).toBeInTheDocument();
  });

  it("a failed history fetch says so with a retry - the section must not silently vanish", async () => {
    renderPage(new Error("network down"));
    await waitFor(() => expect(screen.getByTestId("history-error")).toBeTruthy());
    expect(screen.getByTestId("history-error").textContent).toMatch(/couldn't load/i);
  });
});
