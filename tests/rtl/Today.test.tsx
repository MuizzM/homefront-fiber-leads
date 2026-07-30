// Today — the rep's home screen, pinned.
//
// This screen decides what a rep sees the instant they open the app: their
// numbers, their next door, and whether they're on the clock. It had no test
// coverage. This suite locks the contract that matters in the field — the stat
// strip reads REAL leaderboard/pins numbers (never a fabricated 0 on a failed
// fetch), the progress bar's aria value tracks doors worked, the next-door hero
// picks the highest-priority OPEN door, and the loading/error/empty/all-done
// forks each render their own state.
import { render, screen, waitFor, within } from "@testing-library/react";
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

// No geolocation in jsdom — resolve "off" so routing falls back to leadScore
// order (deterministic), exactly as a rep who denied location would see it.
vi.mock("@/lib/geoFix", () => ({
  captureFieldFix: () => Promise.resolve({ repLat: null, repLng: null }),
}));

const knockLog = vi.fn();
vi.mock("@/lib/useKnockLogger", () => ({
  useKnockLogger: () => ({ log: knockLog, snap: { online: true, pendingCount: 0, deadCount: 0 } }),
}));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

vi.mock("@/components/OutcomeSheet", () => ({ OutcomeSheet: () => null }));

const navigate = vi.fn();
vi.mock("wouter", () => ({
  useLocation: () => ["/", navigate],
  Link: ({ href, children, ...rest }: any) => <a href={href} {...rest}>{children}</a>,
}));

import Today from "../../client/src/pages/Today";

interface PinOver { id: number; leadStatus?: string; lastOutcome?: string | null; leadScore?: number; address?: string; }
function pin(o: PinOver) {
  return {
    id: o.id, lat: null, lng: null,
    leadStatus: o.leadStatus ?? "prospect", lastOutcome: o.lastOutcome ?? null,
    leadScore: o.leadScore ?? 50,
    address: o.address ?? `${o.id} Elm St`, city: "Testburg", state: "TX", zip: "70001",
    visited: false,
  };
}

interface Endpoints {
  pins?: any[];
  board?: any[];
  clockedIn?: boolean;
  followups?: Array<{ callbackDate: string }>;
  failPins?: boolean;
  failBoard?: boolean;
}
function renderToday(e: Endpoints = {}) {
  const pins = e.pins ?? [];
  const board = e.board ?? [{ rep: { id: 9, name: "Rae Rep", role: "rep" }, knocks: 40, sales: 12, knocksToday: 6, salesToday: 2 }];
  apiRequest.mockImplementation((_method: string, url: string) => {
    if (url.startsWith("/api/leads/map")) {
      return e.failPins ? Promise.reject(new Error("boom")) : Promise.resolve({ json: () => Promise.resolve({ pins, total: pins.length }) });
    }
    if (url.startsWith("/api/leaderboard")) {
      return e.failBoard ? Promise.reject(new Error("boom")) : Promise.resolve({ json: () => Promise.resolve(board) });
    }
    if (url.startsWith("/api/clock/status")) return Promise.resolve({ json: () => Promise.resolve({ clockedIn: e.clockedIn ?? false, session: null }) });
    if (url.startsWith("/api/followups")) return Promise.resolve({ json: () => Promise.resolve(e.followups ?? []) });
    return Promise.resolve({ json: () => Promise.resolve([]) });
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><Today /></QueryClientProvider>);
}

beforeEach(() => { apiRequest.mockReset(); navigate.mockReset(); knockLog.mockReset(); });

describe("Today — the rep's home", () => {
  it("greets the rep by first name", async () => {
    renderToday();
    const h = await screen.findByTestId("today-greeting");
    expect(h.textContent).toContain("Rae");
    expect(h.textContent).toMatch(/Good (morning|afternoon|evening)/);
  });

  it("reads doors, sales, and doors-left from real data", async () => {
    renderToday({
      pins: [pin({ id: 1 }), pin({ id: 2 }), pin({ id: 3, leadStatus: "sold" })],
      board: [{ rep: { id: 9, name: "Rae Rep", role: "rep" }, knocks: 40, sales: 12, knocksToday: 6, salesToday: 2 }],
    });
    // 6 doors today, 2 sales today, 2 open doors (pins 1 & 2; pin 3 is sold).
    await waitFor(() => expect(screen.getByText("Doors today")).toBeTruthy());
    const cell = (label: string) => screen.getByText(label).closest("div")!.parentElement!;
    expect(within(cell("Doors today")).getByText("6")).toBeTruthy();
    expect(within(cell("Sales today")).getByText("2")).toBeTruthy();
    expect(within(cell("Doors left")).getByText("2")).toBeTruthy();
  });

  it("progress bar reports doors worked as an accessible value", async () => {
    // 6 done, 2 open -> 6/(6+2) = 75%.
    renderToday({ pins: [pin({ id: 1 }), pin({ id: 2 })] });
    const bar = await screen.findByRole("progressbar", { name: /doors worked today/i });
    expect(bar.getAttribute("aria-valuenow")).toBe("75");
  });

  it("a failed leaderboard shows an em-dash, never a fake 0", async () => {
    renderToday({ failBoard: true, pins: [pin({ id: 1 })] });
    // Doors today / Sales today come from the board; both must degrade honestly.
    await waitFor(() => {
      const doorsToday = screen.getByText("Doors today").closest("div")!.parentElement!;
      expect(within(doorsToday).getByLabelText(/Doors today unavailable/i)).toBeTruthy();
    });
  });

  it("surfaces the highest-priority open door as the hero", async () => {
    renderToday({
      pins: [pin({ id: 1, leadScore: 30, address: "10 Low St" }), pin({ id: 2, leadScore: 95, address: "20 High St" })],
    });
    const hero = await screen.findByTestId("today-hero");
    expect(hero.textContent).toContain("20 High St");
    expect(hero.textContent).not.toContain("10 Low St");
  });

  it("shows the follow-ups CTA when a callback is due", async () => {
    renderToday({ pins: [pin({ id: 1 })], followups: [{ callbackDate: "2020-01-01" }] });
    const cta = await screen.findByTestId("today-followups");
    expect(cta.textContent).toContain("1 follow-up due");
  });

  it("renders the error card when the route fails to load", async () => {
    renderToday({ failPins: true });
    expect(await screen.findByTestId("today-error")).toBeTruthy();
  });

  it("renders the empty card when no doors are assigned", async () => {
    renderToday({ pins: [] });
    expect(await screen.findByTestId("today-empty")).toBeTruthy();
  });

  it("renders the all-done card when every door is worked", async () => {
    renderToday({ pins: [pin({ id: 1, leadStatus: "sold" })] });
    expect(await screen.findByTestId("today-alldone")).toBeTruthy();
  });

  it("offers clock-in when off the clock and clock-out when on it", async () => {
    const { unmount } = renderToday({ clockedIn: false, pins: [pin({ id: 1 })] });
    expect(await screen.findByTestId("today-clock-in")).toBeTruthy();
    unmount();
    renderToday({ clockedIn: true, pins: [pin({ id: 1 })] });
    expect(await screen.findByTestId("today-clock-out")).toBeTruthy();
  });
});
