// Spiffs surface — a rep sees their own feed + heat and NOT the team data; a
// manager/admin also sees the team heat leaderboard (the algorithm data), and
// an admin gets the approve/mark-paid queue.
//
// This screen renders MONEY, so the money assertions are first-class: variable
// amounts must render exactly, totals must add up, and no cents may be rounded
// away on the way to the screen.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";

const { mockAuth, apiRequest, toast } = vi.hoisted(() => ({
  mockAuth: { user: { id: 1, name: "Rae Rep", role: "rep", teamMemberId: 9 } as any },
  apiRequest: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ useAuth: () => mockAuth }));
vi.mock("@/lib/queryClient", () => ({
  apiRequest: (...a: any[]) => apiRequest(...a),
  queryClient: { invalidateQueries: vi.fn() },
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));

import Spiffs from "../../client/src/pages/Spiffs";

const snapshot = {
  totalSales: 12, recentSalesCount: 5, windowDays: 7, salesVelocityPerDay: 1.2,
  trailingAvgPerDay: 0.3, currentStreakDays: 3, recentTrend: 2,
  spiffsGrantedToday: 1, spiffCentsGrantedToday: 3500,
};
const band = {
  minCents: 2500, maxCents: 5000, incrementCents: 500,
  ladderCents: [2500, 3000, 3500, 4000, 4500, 5000],
  triggers: [
    { reason: "milestone", title: "Milestone sale", how: "Every 10 career sales." },
    { reason: "streak", title: "Hot streak", how: "Sell on 3 days in a row." },
    { reason: "improvement", title: "On the rise", how: "Run 50% above your own trailing average." },
    { reason: "random", title: "Lucky spiff", how: "Roughly 1 in 8 sales drops one at random." },
  ],
};
// Deliberately DIFFERENT amounts — the old flat-$50 UI could not have told them
// apart, and the old formatter rounded fractional dollars away.
const minePayload = {
  spiffs: [
    { id: 7, repId: 9, saleRef: "knock:1", amountCents: 4500, reason: "streak", status: "earned", createdAt: new Date().toISOString(), approvedBy: null, approvedAt: null, paidAt: null },
    { id: 2, repId: 9, saleRef: "knock:2", amountCents: 2500, reason: "random", status: "paid", createdAt: "2026-07-30T10:00:00Z", approvedBy: 3, approvedAt: null, paidAt: "2026-07-31T10:00:00Z" },
  ],
  heat: 62, snapshot, band,
  totals: { earnedCents: 4500, approvedCents: 0, paidCents: 2500, count: 2 },
};
const teamPayload = {
  reps: [{ repId: 9, name: "Rae Rep", role: "rep", heat: 62, snapshot, earnedCents: 4500, approvedCents: 0, paidCents: 2500, spiffCount: 2 }],
  pending: [
    { id: 7, repId: 9, repName: "Rae Rep", saleRef: "knock:1", amountCents: 4500, reason: "streak", status: "earned", createdAt: "2026-08-01T10:00:00Z", approvedBy: null, approvedAt: null, paidAt: null },
    { id: 8, repId: 9, repName: "Rae Rep", saleRef: "knock:3", amountCents: 3000, reason: "milestone", status: "approved", createdAt: "2026-08-01T11:00:00Z", approvedBy: 3, approvedAt: "2026-08-02T10:00:00Z", paidAt: null },
  ],
};

type Overrides = { mine?: any; team?: any; failMine?: boolean; failTeam?: boolean; hang?: boolean };

function renderPage(o: Overrides = {}) {
  const qc = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        queryFn: ({ queryKey }) => {
          const url = String(queryKey[0]);
          if (o.hang) return new Promise(() => {});
          if (url.includes("/api/spiffs/mine")) {
            return o.failMine ? Promise.reject(new Error("boom")) : Promise.resolve(o.mine ?? minePayload);
          }
          if (url.includes("/api/spiffs/team")) {
            return o.failTeam ? Promise.reject(new Error("boom")) : Promise.resolve(o.team ?? teamPayload);
          }
          return Promise.resolve(null);
        },
      },
    },
  });
  return render(<QueryClientProvider client={qc}><Spiffs /></QueryClientProvider>);
}

beforeEach(() => {
  apiRequest.mockReset();
  toast.mockReset();
  window.localStorage.clear();
});

describe("Spiffs — rep view", () => {
  beforeEach(() => { mockAuth.user = { id: 1, name: "Rae Rep", role: "rep", teamMemberId: 9 }; });

  it("shows the rep's own spiff feed and heat, but not the team surface", async () => {
    renderPage();
    expect(await screen.findByTestId("my-spiff-list")).toBeTruthy();
    expect(screen.getByTestId("spiff-7")).toBeTruthy();
    expect(screen.getByTestId("my-heat")).toBeTruthy();
    // A rep never sees the team heat / algorithm surface.
    expect(screen.queryByTestId("team-heat")).toBeNull();
  });

  it("labels a spiff with its reason and status", async () => {
    renderPage();
    const row = await screen.findByTestId("spiff-7");
    expect(row.textContent).toContain("Hot streak");
    expect(screen.getByTestId("spiff-status-7").textContent?.toLowerCase()).toContain("earned");
  });

  it("makes each award's own amount the hero, not a single flat number", async () => {
    renderPage();
    expect((await screen.findByTestId("spiff-amount-7")).textContent).toBe("$45");
    expect(screen.getByTestId("spiff-amount-2").textContent).toBe("$25");
  });

  it("explains in plain language why each spiff fired", async () => {
    renderPage();
    expect((await screen.findByTestId("spiff-7")).textContent).toContain("back-to-back days");
    expect(screen.getByTestId("spiff-2").textContent).toContain("Lucky drop");
  });

  it("dates each award in words", async () => {
    renderPage();
    expect((await screen.findByTestId("spiff-when-7")).textContent).toBe("Today");
    expect(screen.getByTestId("spiff-when-2").textContent).toBeTruthy();
  });

  it("shows a running total split across earned / awaiting / paid", async () => {
    renderPage();
    // 4500 earned + 0 approved + 2500 paid = $70 won, $45 awaiting, $25 paid.
    await waitFor(() => expect(screen.getByTestId("stat-total").textContent).toContain("$70"));
    expect(screen.getByTestId("stat-pending").textContent).toContain("$45");
    expect(screen.getByTestId("stat-paid").textContent).toContain("$25");
    expect(screen.getByTestId("stat-heat").textContent).toContain("62");
  });

  it("renders fractional-dollar money exactly, never rounded to whole dollars", async () => {
    // Guards the old formatter (maximumFractionDigits: 0), which displayed
    // $123.45 as "$123" — money silently vanishing on screen.
    renderPage({
      mine: {
        ...minePayload,
        spiffs: [{ ...minePayload.spiffs[0], id: 11, amountCents: 12345 }],
        totals: { earnedCents: 12345, approvedCents: 0, paidCents: 0, count: 1 },
      },
    });
    expect((await screen.findByTestId("spiff-amount-11")).textContent).toBe("$123.45");
    await waitFor(() => expect(screen.getByTestId("stat-total").textContent).toContain("$123.45"));
  });

  it("spells out the $25-$50 band and the ways to trigger a spiff", async () => {
    renderPage();
    expect((await screen.findByTestId("earn-band")).textContent).toBe("$25–$50");
    const ladder = screen.getByTestId("earn-ladder");
    expect(within(ladder).getAllByRole("listitem").map((li) => li.textContent))
      .toEqual(["$25", "$30", "$35", "$40", "$45", "$50"]);
    const triggers = screen.getByTestId("earn-triggers").textContent ?? "";
    for (const phrase of ["Milestone sale", "Hot streak", "On the rise", "Lucky spiff"]) {
      expect(triggers).toContain(phrase);
    }
  });

  it("reveals a NEW award once, then never again after it is acknowledged", async () => {
    const { unmount } = renderPage();
    const reveal = await screen.findByTestId("spiff-reveal");
    expect(within(reveal).getByTestId("spiff-reveal-amount").textContent).toBe("$45");
    expect(reveal.textContent).toContain("Hot streak");
    // Reduced motion is respected by class, not by JS: the animation is opt-out.
    expect(reveal.className).toContain("motion-reduce:animate-none");

    await userEvent.click(screen.getByTestId("spiff-reveal-dismiss"));
    expect(screen.queryByTestId("spiff-reveal")).toBeNull();

    unmount();
    renderPage();
    await screen.findByTestId("my-spiff-list");
    expect(screen.queryByTestId("spiff-reveal")).toBeNull();
  });

  it("does not re-reveal an award the rep has already seen", async () => {
    window.localStorage.setItem("hf.spiffs.lastSeenId.9", "7");
    renderPage();
    await screen.findByTestId("my-spiff-list");
    expect(screen.queryByTestId("spiff-reveal")).toBeNull();
  });

  it("renders a loading skeleton, then an empty state that says how to earn one", async () => {
    const { unmount } = renderPage({ hang: true });
    expect(screen.getByTestId("my-spiffs-loading")).toBeTruthy();
    unmount();

    renderPage({ mine: { ...minePayload, spiffs: [], totals: { earnedCents: 0, approvedCents: 0, paidCents: 0, count: 0 } } });
    const empty = await screen.findByTestId("my-spiffs-empty");
    expect(empty.textContent).toContain("No spiffs yet");
    expect(empty.textContent).toContain("$25–$50");
  });

  it("renders an error state instead of a fake $0 when the feed fails", async () => {
    renderPage({ failMine: true });
    expect(await screen.findByTestId("my-spiffs-error")).toBeTruthy();
    expect(screen.getByTestId("stat-total").textContent).toContain("—");
  });
});

describe("Spiffs — admin view", () => {
  beforeEach(() => { mockAuth.user = { id: 3, name: "Ada Admin", role: "admin", teamMemberId: undefined }; });

  it("shows the team heat leaderboard and the approve queue", async () => {
    renderPage();
    // Wait for the team query to resolve (the row appears once data lands).
    expect(await screen.findByTestId("heat-row-9")).toBeTruthy();
    expect(screen.getByTestId("team-heat")).toBeTruthy();
    expect(screen.getByTestId("heat-meter-9")).toBeTruthy();
    // Admin gets an approve control for the earned spiff.
    expect(await screen.findByTestId("approve-7")).toBeTruthy();
  });

  it("makes pending money impossible to miss, split by status", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId("queue-total-earned").textContent).toContain("$45"));
    expect(screen.getByTestId("queue-total-approved").textContent).toContain("$30");
    expect(screen.getByTestId("queue-total-open").textContent).toContain("$75");
  });

  it("shows each queued row's amount, rep, reason and status", async () => {
    renderPage();
    const row = await screen.findByTestId("queue-spiff-7");
    expect(within(row).getByTestId("queue-amount-7").textContent).toBe("$45");
    expect(row.textContent).toContain("Rae Rep");
    expect(row.textContent).toContain("Hot streak");
    expect(within(row).getByTestId("queue-status-7").textContent).toBe("Earned");
    // The approved row offers the terminal settlement instead.
    expect(screen.getByTestId("paid-8")).toBeTruthy();
  });

  it("approves a single spiff through the per-row action", async () => {
    apiRequest.mockResolvedValue({ json: async () => ({ id: 7, status: "approved" }) });
    renderPage();
    await userEvent.click(await screen.findByTestId("approve-7"));
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith("POST", "/api/spiffs/7/approve"));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Spiff approved" })));
  });

  it("bulk-approves only the EARNED rows in the selection", async () => {
    apiRequest.mockResolvedValue({ json: async () => ({ changed: [{ id: 7 }], skipped: [], totalCents: 4500 }) });
    renderPage();
    await screen.findByTestId("queue-select-all");

    // Select everything, then approve: the approved row must not be re-approved.
    await userEvent.click(screen.getByTestId("queue-select-all"));
    await waitFor(() => expect(screen.getByTestId("queue-selection-count").textContent).toBe("2 selected"));

    const approveAll = screen.getByTestId("bulk-approve");
    expect(approveAll.textContent).toContain("$45");
    await userEvent.click(approveAll);
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith("POST", "/api/spiffs/bulk/approve", { ids: [7] }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringContaining("$45") })));
  });

  it("bulk mark-paid sends only the approved rows", async () => {
    apiRequest.mockResolvedValue({ json: async () => ({ changed: [{ id: 8 }], skipped: [], totalCents: 3000 }) });
    renderPage();
    await userEvent.click(await screen.findByTestId("queue-select-8"));
    const payButton = screen.getByTestId("bulk-paid");
    await waitFor(() => expect(payButton.textContent).toContain("$30"));
    await userEvent.click(payButton);
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith("POST", "/api/spiffs/bulk/paid", { ids: [8] }));
  });

  it("is drivable from the keyboard alone", async () => {
    renderPage();
    const selectAll = await screen.findByTestId("queue-select-all");
    selectAll.focus();
    expect(document.activeElement).toBe(selectAll);
    await userEvent.keyboard(" ");
    await waitFor(() => expect(screen.getByTestId("queue-selection-count").textContent).toBe("2 selected"));
    // Tab reaches the bulk actions without a pointer.
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByTestId("bulk-approve"));
  });

  it("disables the bulk actions when nothing applicable is selected", async () => {
    renderPage();
    expect((await screen.findByTestId("bulk-approve")).hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("bulk-paid").hasAttribute("disabled")).toBe(true);
  });

  it("renders an all-clear empty state when the queue is drained", async () => {
    renderPage({ team: { ...teamPayload, pending: [] } });
    const empty = await screen.findByTestId("spiff-queue-empty");
    expect(empty.textContent).toContain("Nothing to approve");
    expect(screen.getByTestId("queue-total-open").textContent).toContain("$0");
  });

  it("renders loading and error states for the team surface", async () => {
    const { unmount } = renderPage({ hang: true });
    expect(screen.getByTestId("team-heat-loading")).toBeTruthy();
    unmount();

    renderPage({ failTeam: true });
    expect(await screen.findByTestId("team-heat-error")).toBeTruthy();
  });
});
