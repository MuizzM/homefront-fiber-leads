// Follow-ups — the callbacks a rep owes, pinned.
//
// Grouping is the contract: a callback dated before today is OVERDUE, today is
// TODAY, later is UPCOMING — and the header states the totals so a rep reads
// their debt in one glance. These tests also pin the error and empty forks.
import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { todayISO } from "../../shared/knock";

const apiRequest = vi.fn();
vi.mock("@/lib/queryClient", () => ({
  apiRequest: (...a: any[]) => apiRequest(...a),
  queryClient: undefined,
}));
vi.mock("@/lib/useKnockLogger", () => ({
  useKnockLogger: () => ({ log: vi.fn(), snap: { online: true, pendingCount: 0, deadCount: 0 } }),
}));
vi.mock("@/components/OutcomeSheet", () => ({ OutcomeSheet: () => null }));
vi.mock("wouter", () => ({ useLocation: () => ["/", vi.fn()] }));

import FollowUps from "../../client/src/pages/FollowUps";

function fu(leadId: number, callbackDate: string, over: Record<string, any> = {}) {
  return {
    leadId, address: `${leadId} Oak St`, city: "Testburg",
    leadStatus: "follow_up", repId: 9, callbackDate,
    setAt: "2026-07-01T00:00:00Z", ...over,
  };
}

function renderPage(payload: any[] | "error") {
  apiRequest.mockImplementation((...args: any[]) => {
    const url = String(args.find(a => typeof a === "string" && a.startsWith("/")) ?? "");
    if (url.includes("/followups") && payload === "error") return Promise.reject(new Error("boom"));
    return Promise.resolve({ json: () => Promise.resolve(payload === "error" ? [] : payload) });
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><FollowUps /></QueryClientProvider>);
}

beforeEach(() => apiRequest.mockReset());

describe("Follow-ups grouping", () => {
  it("splits Overdue / Today / Upcoming and states the totals in the header", async () => {
    const today = todayISO();
    renderPage([fu(1, "2020-01-01"), fu(2, today), fu(3, "2999-12-31")]);
    // Header summary: 3 scheduled, 1 overdue.
    const summary = await screen.findByTestId("followups-summary");
    expect(summary.textContent).toContain("3");
    expect(summary.textContent).toContain("scheduled");
    expect(summary.textContent).toContain("1 overdue");
    // Each row lands in its section (h2 headings — row text also says "Today").
    const section = (name: string) => screen.getByRole("heading", { name }).closest("div")!.parentElement!;
    expect(section("Overdue").textContent).toContain("1 Oak St");
    expect(section("Today").textContent).toContain("2 Oak St");
    expect(section("Upcoming").textContent).toContain("3 Oak St");
  });

  it("hides empty sections", async () => {
    renderPage([fu(1, "2999-12-31")]);
    await screen.findByTestId("followup-1");
    expect(screen.queryByRole("heading", { name: "Overdue" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Upcoming" })).toBeTruthy();
  });

  it("renders the error fork with a retry", async () => {
    renderPage("error");
    const card = await screen.findByTestId("followups-error");
    expect(within(card).getByText(/retry/i)).toBeTruthy();
  });

  it("renders the caught-up empty state when nothing is owed", async () => {
    renderPage([]);
    expect(await screen.findByTestId("followups-empty")).toBeTruthy();
  });
});
