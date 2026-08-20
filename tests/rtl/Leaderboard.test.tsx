// Leaderboard — today's race by default.
//
// The board defaults to TODAY (the shift a rep is actually running), fetches
// through ?range=today, and marks the Today segment pressed. Loading renders
// skeleton rows in the board's real shape — never a bare "Loading..." line.
import { render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: 1, name: "Rae Rep", role: "rep", teamMemberId: 9 } }),
}));

import Leaderboard from "../../client/src/pages/Leaderboard";

const fetched: string[] = [];
function renderBoard(payload: any[] | "pending" | "error") {
  fetched.length = 0;
  const qc = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        queryFn: ({ queryKey }) => {
          fetched.push(String(queryKey[0]));
          if (payload === "pending") return new Promise(() => {});
          if (payload === "error") return Promise.reject(new Error("boom"));
          return Promise.resolve(payload);
        },
      },
    },
  });
  return render(<QueryClientProvider client={qc}><Leaderboard /></QueryClientProvider>);
}

const entry = (id: number, name: string, sales: number) => ({
  rep: { id, name, role: "rep" }, knocks: 40, contacts: 10, callbacks: 2, sales,
});

beforeEach(() => { fetched.length = 0; });

describe("Leaderboard defaults", () => {
  it("defaults to today's race and fetches ?range=today", async () => {
    renderBoard([entry(9, "Rae Rep", 3), entry(2, "Sam Lee", 5)]);
    expect(await screen.findByTestId("row-rep-9")).toBeTruthy();
    // The Today segment is the pressed one.
    expect(screen.getByTestId("range-today").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("range-all").getAttribute("aria-pressed")).toBe("false");
    // And the data actually came from the today range.
    expect(fetched.some(u => u.includes("range=today"))).toBe(true);
  });

  it("shows every date preset in a bounded phone grid", async () => {
    renderBoard([]);
    const presets = await screen.findByLabelText("Date range presets");
    expect(presets).toHaveClass("grid", "grid-cols-3", "md:inline-flex");
    expect(presets).not.toHaveClass("overflow-x-auto");
    expect(within(presets).getAllByRole("button")).toHaveLength(6);
  });

  it("shows skeleton rows while loading, not a text placeholder", () => {
    renderBoard("pending");
    expect(screen.getByTestId("leaderboard-loading")).toBeTruthy();
    expect(screen.queryByText(/loading leaderboard/i)).toBeNull();
  });

  it("a failed fetch shows dash placeholder tiles, never a fake 0", async () => {
    renderBoard("error");
    const sales = await screen.findByTestId("stat-sales");
    await waitFor(() => expect(sales.textContent).toContain("-")); // dash placeholder
    expect(sales.textContent).not.toContain("0");
  });

  it("pins the signed-in rep's own rank summary", async () => {
    renderBoard([entry(2, "Sam Lee", 5), entry(9, "Rae Rep", 3)]);
    const me = await screen.findByTestId("leaderboard-me");
    expect(me.textContent).toContain("Your rank");
    expect(me.textContent).toContain("#2 of 2");
  });

  it("flags impossible conversion data instead of displaying a percentage over 100", async () => {
    renderBoard([{
      rep: { id: 9, name: "Rae Rep", role: "rep" },
      knocks: 14, contacts: 1, callbacks: 0, sales: 7,
    }]);
    const me = await screen.findByTestId("leaderboard-me");
    expect(me.textContent).toContain("Review");
    expect(me.textContent).not.toContain("700%");
    expect(screen.getByTestId("leaderboard-data-review").textContent).toMatch(/missing a matching logged contact/i);
  });
});
