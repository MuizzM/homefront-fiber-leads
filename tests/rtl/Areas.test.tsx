// The Areas index — the way into the Area Console.
//
// It renders one card per row of GET /api/territories/progress (the server
// already scopes that list), so the tests hold it to three things: the card
// says who holds the ground and what it has produced, the filters actually
// narrow, and "nothing here" reads as a state rather than a broken page.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: 2, name: "Mona Manager", role: "manager", teamMemberId: 4 } }),
}));

import Areas from "../../client/src/pages/Areas";

function row(over: Record<string, unknown> = {}) {
  return {
    id: 1, name: "Maple Grove", color: "#16A34A", repId: 5, status: "active", repName: "Bo Rivera",
    total: 200, knocked: 40, sold: 12,
    availableBase: 160, untouched: 120, attempts: 55, contacted: 18, notHome: 22,
    followUp: 6, unavailable: 25, disqualified: 15,
    penetrationRate: 7.5, knockCompletionRate: 25, contactRate: 45,
    lastActivityAt: "2026-07-28T15:00:00.000Z", pct: 20,
    verifiedWorkedLeads: 34, areaWorkedPct: 17, verified: 30, needsReview: 4, invalid: 1,
    avgDistanceM: 12, maxObservedDistanceM: 140, maxAllowedDistanceM: 75, maxAllowedAccuracyM: 50,
    ...over,
  };
}

const rows = [
  row(),
  row({ id: 2, name: "Cedar Park", repId: null, repName: "Unassigned", status: "unassigned", knocked: 0, sold: 0, knockCompletionRate: 0, lastActivityAt: null }),
  row({ id: 3, name: "Birch Hollow", repId: 6, repName: "Cam Diaz", status: "completed", knocked: 190, sold: 31, knockCompletionRate: 98 }),
];

function renderPage(payload: unknown = rows) {
  const qc = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        queryFn: ({ queryKey }) =>
          String(queryKey[0]) === "/api/territories/progress" ? Promise.resolve(payload) : Promise.resolve(null),
      },
    },
  });
  const { hook } = memoryLocation({ path: "/areas" });
  return render(
    <Router hook={hook}>
      <QueryClientProvider client={qc}><Areas /></QueryClientProvider>
    </Router>,
  );
}

describe("Areas index", () => {
  it("renders a card per area, linked to its console", async () => {
    renderPage();
    const grid = await screen.findByTestId("areas-grid");
    expect(within(grid).getAllByRole("link")).toHaveLength(3);
    const card = screen.getByTestId("area-card-1");
    expect(card).toHaveAttribute("href", "/areas/1");
    expect(card).toHaveTextContent("Maple Grove");
    expect(card).toHaveTextContent("Assigned");
    expect(card).toHaveTextContent("Bo Rivera");
  });

  it("shows the three headline counts and the coverage the server computed", async () => {
    renderPage();
    const card = await screen.findByTestId("area-card-1");
    expect(card).toHaveTextContent("200");
    expect(card).toHaveTextContent("40");
    expect(card).toHaveTextContent("12");
    // 40 of 160 available doors — never 40/200.
    expect(card).toHaveTextContent("25% of available doors knocked");
    expect(within(card).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "25");
  });

  it("shows the pool call-to-action instead of naming a rep who no longer holds the area", async () => {
    renderPage();
    const card = await screen.findByTestId("area-card-2");
    // The point under test: the STALE holder name must not appear. The pool
    // line is a call to action ("open to assign") because the chip above it
    // already says UNASSIGNED — printing it twice wasted the line.
    expect(within(card).getByTestId("area-card-2-rep")).toHaveTextContent("In the pool · open to assign");
  });

  it("filters by name as you type", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId("area-card-1");
    await user.type(screen.getByTestId("areas-search"), "cedar");
    expect(screen.getByTestId("area-card-2")).toBeInTheDocument();
    expect(screen.queryByTestId("area-card-1")).toBeNull();
    expect(screen.queryByTestId("area-card-3")).toBeNull();
    expect(screen.getByTestId("areas-count")).toHaveTextContent("1 of 3 areas");
  });

  it("filters by status", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId("area-card-1");
    await user.selectOptions(screen.getByTestId("areas-status-filter"), "completed");
    expect(screen.getByTestId("area-card-3")).toBeInTheDocument();
    expect(screen.queryByTestId("area-card-1")).toBeNull();
  });

  it("explains an empty search rather than showing a blank grid", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId("area-card-1");
    await user.type(screen.getByTestId("areas-search"), "nowhere");
    expect(screen.getByTestId("areas-no-match")).toBeInTheDocument();
    expect(screen.queryByTestId("areas-grid")).toBeNull();
  });

  it("shows a real empty state when there are no areas at all", async () => {
    renderPage([]);
    expect(await screen.findByTestId("areas-empty")).toHaveTextContent("No areas yet");
    expect(screen.queryByTestId("areas-grid")).toBeNull();
  });
});

// ── The crew, on the card ───────────────────────────────────────────────────
// The card printed one name for ground that can be walked by several reps, so a
// shared area read as one rep's.
describe("Areas index — who works each area", () => {
  it("names every holder on a shared area, not just the primary", async () => {
    renderPage([row({ id: 4, name: "Shared patch", status: "shared", repId: 5, repName: "Bo Rivera",
      repIds: [5, 6], repNames: ["Bo Rivera", "Talal Rep"] })]);
    expect(await screen.findByTestId("area-card-4-rep")).toHaveTextContent("Bo Rivera · Talal Rep");
  });

  it("counts past two rather than overflowing the card", async () => {
    renderPage([row({ id: 4, status: "shared", repIds: [5, 6, 7], repNames: ["Bo", "Talal", "Cam"] })]);
    const cell = await screen.findByTestId("area-card-4-rep");
    expect(cell).toHaveTextContent("Bo +2");
    // The full list stays reachable rather than being lost to the truncation.
    expect(cell).toHaveAttribute("title", "Bo, Talal, Cam");
  });

  it("shows the pool call-to-action for a pool area, even one with a stale holder list", async () => {
    // repId keeps naming the LAST rep after a reclaim — reading it as a holder
    // is how a reclaimed area gets handed back to whoever it was taken from.
    renderPage([row({ id: 4, status: "unassigned", repId: null, repIds: [5], repNames: ["Bo Rivera"] })]);
    const cell = await screen.findByTestId("area-card-4-rep");
    expect(cell).toHaveTextContent("In the pool · open to assign");
    // The stale holder must never surface — that is the point under test.
    expect(cell).not.toHaveTextContent("Bo Rivera");
  });

  it("falls back to the single name for a row served before repIds existed", async () => {
    renderPage([row({ id: 4, repName: "Bo Rivera" })]);
    expect(await screen.findByTestId("area-card-4-rep")).toHaveTextContent("Bo Rivera");
  });
});
