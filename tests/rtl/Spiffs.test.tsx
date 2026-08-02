// Spiffs surface — a rep sees their own feed + heat and NOT the team data; a
// manager/admin also sees the team heat leaderboard (the algorithm data), and
// an admin gets the approve/mark-paid queue.
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";

const { mockAuth } = vi.hoisted(() => ({
  mockAuth: { user: { id: 1, name: "Rae Rep", role: "rep", teamMemberId: 9 } as any },
}));
vi.mock("@/lib/auth", () => ({ useAuth: () => mockAuth }));

import Spiffs from "../../client/src/pages/Spiffs";

const snapshot = {
  totalSales: 12, recentSalesCount: 5, windowDays: 7, salesVelocityPerDay: 1.2,
  trailingAvgPerDay: 0.3, currentStreakDays: 3, recentTrend: 2, spiffsGrantedToday: 1,
};
const minePayload = {
  spiffs: [
    { id: 1, repId: 9, saleRef: "knock:1", amountCents: 5000, reason: "streak", status: "earned", createdAt: "2026-08-01T10:00:00Z", approvedBy: null, approvedAt: null, paidAt: null },
    { id: 2, repId: 9, saleRef: "knock:2", amountCents: 5000, reason: "random", status: "paid", createdAt: "2026-07-30T10:00:00Z", approvedBy: 3, approvedAt: null, paidAt: "2026-07-31T10:00:00Z" },
  ],
  heat: 62, snapshot, totals: { earnedCents: 5000, approvedCents: 0, paidCents: 5000, count: 2 },
};
const teamPayload = {
  reps: [{ repId: 9, name: "Rae Rep", role: "rep", heat: 62, snapshot, earnedCents: 5000, approvedCents: 0, paidCents: 5000, spiffCount: 2 }],
  pending: [{ id: 1, repId: 9, repName: "Rae Rep", saleRef: "knock:1", amountCents: 5000, reason: "streak", status: "earned", createdAt: "2026-08-01T10:00:00Z", approvedBy: null, approvedAt: null, paidAt: null }],
};

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        queryFn: ({ queryKey }) => {
          const url = String(queryKey[0]);
          if (url.includes("/api/spiffs/mine")) return Promise.resolve(minePayload);
          if (url.includes("/api/spiffs/team")) return Promise.resolve(teamPayload);
          return Promise.resolve(null);
        },
      },
    },
  });
  return render(<QueryClientProvider client={qc}><Spiffs /></QueryClientProvider>);
}

describe("Spiffs — rep view", () => {
  beforeEach(() => { mockAuth.user = { id: 1, name: "Rae Rep", role: "rep", teamMemberId: 9 }; });

  it("shows the rep's own spiff feed and heat, but not the team surface", async () => {
    renderPage();
    expect(await screen.findByTestId("my-spiff-list")).toBeTruthy();
    expect(screen.getByTestId("spiff-1")).toBeTruthy();
    expect(screen.getByTestId("my-heat")).toBeTruthy();
    // A rep never sees the team heat / algorithm surface.
    expect(screen.queryByTestId("team-heat")).toBeNull();
  });

  it("labels a spiff with its reason and status", async () => {
    renderPage();
    const row = await screen.findByTestId("spiff-1");
    expect(row.textContent).toContain("Hot streak");
    expect(screen.getByTestId("spiff-status-1").textContent?.toLowerCase()).toContain("earned");
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
    expect(await screen.findByTestId("approve-1")).toBeTruthy();
  });
});
