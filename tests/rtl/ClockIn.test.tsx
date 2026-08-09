// Field Hours — the tile a rep checks to see their hours counted.
//
// The server stamps each session's `date` with a UTC label, which rolls to
// "tomorrow" at 5–7pm local across the US. Bucketing by that label zeroed the
// Today tile mid-shift every evening. The screen now derives day/week grouping
// from the clockedIn TIMESTAMP in the rep's own timezone — these tests pin that
// by handing the screen a session whose label disagrees with its timestamp.
import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: 1, name: "Rae Rep", role: "rep", teamMemberId: 9 } }),
}));
const apiRequest = vi.fn();
vi.mock("@/lib/queryClient", () => ({
  apiRequest: (...a: any[]) => apiRequest(...a),
  queryClient: { invalidateQueries: () => {} },
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

import ClockIn, { localDayKey } from "../../client/src/pages/ClockIn";

// A CLOSED session (no live timer → no intervals in the test).
function session(over: Record<string, any> = {}) {
  const clockedIn = over.clockedIn ?? new Date(Date.now() - 3 * 3600_000).toISOString();
  return {
    id: over.id ?? 1, repId: 9, userId: 1,
    clockedIn,
    clockedOut: over.clockedOut ?? new Date(Date.now() - 3600_000).toISOString(),
    durationMinutes: over.durationMinutes ?? 120,
    notes: null,
    // Deliberately DEFAULT to a wrong (UTC-rolled) label — the UI must ignore it.
    date: over.date ?? localDayKey(new Date(Date.now() + 86_400_000).toISOString()),
  };
}

function renderClockIn(sessions: any[], opts: { clockedIn?: boolean } = {}) {
  apiRequest.mockImplementation((...args: any[]) => {
    const url = String(args.find(a => typeof a === "string" && a.startsWith("/")) ?? "");
    if (url.includes("/clock/status")) return Promise.resolve({ json: () => Promise.resolve({ clockedIn: opts.clockedIn ?? false, session: null }) });
    if (url.includes("/clock/sessions")) return Promise.resolve({ json: () => Promise.resolve(sessions) });
    return Promise.resolve({ json: () => Promise.resolve([]) });
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><ClockIn /></QueryClientProvider>);
}

beforeEach(() => {
  apiRequest.mockReset();
  // Pin the clock mid-afternoon on a mid-week day. The fixtures build
  // "3 hours ago" / "two days ago" relative to now — under the real clock a
  // run between midnight and 3am rolls the default session onto yesterday
  // (Today shows 0m) and a Monday run pushes "two days ago" out of This
  // Week. shouldAdvanceTime keeps RTL's async findBy* working.
  vi.useFakeTimers({ now: new Date(2026, 2, 5, 15, 0, 0), shouldAdvanceTime: true });
});
afterEach(() => vi.useRealTimers());

describe("Field Hours day bucketing", () => {
  it("localDayKey uses the local calendar, zero-padded", () => {
    // A timestamp's key must match how a rep reads their own calendar.
    const d = new Date(2026, 2, 5, 9, 30); // March 5, local
    expect(localDayKey(d.toISOString())).toBe("2026-03-05");
  });

  it("Today's hours trust the clock-in timestamp, never the server's UTC date label", async () => {
    // Session worked TODAY (timestamp) but labeled TOMORROW (UTC roll).
    // The old label-based filter counted this as 0m today.
    renderClockIn([session({ durationMinutes: 120 })]);
    const todayTile = (await screen.findByText("Today")).closest("div")!.parentElement!;
    expect(await within(todayTile).findByText("2h 0m")).toBeTruthy();
  });

  it("an earlier-day session stays out of Today but inside This Week", async () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString();
    renderClockIn([
      session({ id: 1, durationMinutes: 120 }),
      session({ id: 2, clockedIn: twoDaysAgo, clockedOut: twoDaysAgo, durationMinutes: 60 }),
    ]);
    const todayTile = (await screen.findByText("Today")).closest("div")!.parentElement!;
    expect(await within(todayTile).findByText("2h 0m")).toBeTruthy();   // only session 1
    const weekTile = screen.getByText("This week").closest("div")!.parentElement!;
    expect(within(weekTile).getByText("3h 0m")).toBeTruthy();    // both
  });

  it("failed sessions fetch shows dash placeholders and a retry, never 0m", async () => {
    apiRequest.mockImplementation((...args: any[]) => {
      const url = String(args.find(a => typeof a === "string" && a.startsWith("/")) ?? "");
      if (url.includes("/clock/status")) return Promise.resolve({ json: () => Promise.resolve({ clockedIn: false, session: null }) });
      // Fail at the json() step, inside the .then chain React Query owns —
      // the rejection is created pre-handled, so no reporter noise.
      return Promise.resolve({ json: () => { throw new Error("boom"); } });
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><ClockIn /></QueryClientProvider>);
    expect(await screen.findByTestId("sessions-error")).toBeTruthy();
    const todayTile = screen.getByText("Today").closest("div")!.parentElement!;
    expect(within(todayTile).getByText("-")).toBeTruthy();
    expect(within(todayTile).queryByText("0m")).toBeNull();
  });

  it("offers Clock In when off the clock", async () => {
    renderClockIn([]);
    expect(await screen.findByTestId("button-clock-in")).toBeTruthy();
  });
});
