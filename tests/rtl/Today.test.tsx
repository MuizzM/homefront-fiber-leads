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

// The install/push card reads real browser capability. jsdom is neither iOS nor
// standalone, so unmocked it renders null and would let the "is it mounted?"
// tests below pass vacuously — the exact bug they exist to catch.
const readiness = vi.fn();
vi.mock("@/lib/pushNotifications", () => ({
  pushReadiness: () => readiness(),
  enablePush: vi.fn(),
}));

const navigate = vi.fn();
vi.mock("wouter", () => ({
  useLocation: () => ["/", navigate],
  Link: ({ href, children, ...rest }: any) => <a href={href} {...rest}>{children}</a>,
}));

import Today from "../../client/src/pages/Today";
import { packMapPins } from "@shared/mapPinsWire";

interface PinOver {
  id: number; leadStatus?: string; lastOutcome?: string | null; leadScore?: number; address?: string;
  carrier?: string | null; freshConfirmedAt?: string | null; knockCount?: number;
}
function pin(o: PinOver) {
  return {
    id: o.id, lat: null, lng: null,
    leadStatus: o.leadStatus ?? "prospect", lastOutcome: o.lastOutcome ?? null,
    leadScore: o.leadScore ?? 50,
    address: o.address ?? `${o.id} Elm St`, city: "Testburg", state: "TX", zip: "70001",
    visited: false,
    // Both ride the packed pin wire (shared/mapPinsWire MAP_PIN_WIRE_FIELDS) and
    // are what the door opener is built from.
    carrier: o.carrier ?? null, freshConfirmedAt: o.freshConfirmedAt ?? null,
    knockCount: o.knockCount ?? 0,
  };
}

/** One row of GET /api/leads/ranked (server/leadRanking.ts). */
function ranked(id: number, score: number, reasons: string[] = []) {
  return { id, score, reasons };
}

interface Endpoints {
  pins?: any[];
  board?: any[];
  clockedIn?: boolean;
  followups?: Array<{ callbackDate: string }>;
  failPins?: boolean;
  failBoard?: boolean;
  ranked?: Array<{ id: number; score: number; reasons: string[] }>;
  failRanked?: boolean;
  announcements?: { items: any[]; unread: number; latestId: number };
}
function renderToday(e: Endpoints = {}) {
  const pins = e.pins ?? [];
  const board = e.board ?? [{ rep: { id: 9, name: "Rae Rep", role: "rep" }, knocks: 40, sales: 12, knocksToday: 6, salesToday: 2 }];
  apiRequest.mockImplementation((_method: string, url: string) => {
    // Checked BEFORE the map branch: both start "/api/leads/".
    if (url.startsWith("/api/leads/ranked")) {
      return e.failRanked
        ? Promise.reject(Object.assign(new Error("no ranking here"), { status: 403 }))
        : Promise.resolve({ json: () => Promise.resolve({ count: (e.ranked ?? []).length, limit: 200, generatedAt: "2026-08-11T15:00:00.000Z", leads: e.ranked ?? [] }) });
    }
    if (url.startsWith("/api/leads/map")) {
      // Today requests ?format=packed and unpacks — serve the real wire shape so
      // the test exercises the same path production does.
      return e.failPins ? Promise.reject(new Error("boom")) : Promise.resolve({ json: () => Promise.resolve(packMapPins(pins as never, { total: pins.length })) });
    }
    if (url.startsWith("/api/leaderboard")) {
      return e.failBoard ? Promise.reject(new Error("boom")) : Promise.resolve({ json: () => Promise.resolve(board) });
    }
    if (url.startsWith("/api/clock/status")) return Promise.resolve({ json: () => Promise.resolve({ clockedIn: e.clockedIn ?? false, session: null }) });
    if (url.startsWith("/api/followups")) return Promise.resolve({ json: () => Promise.resolve(e.followups ?? []) });
    if (url.startsWith("/api/announcements")) {
      return Promise.resolve({ json: () => Promise.resolve(e.announcements ?? { items: [], unread: 0, latestId: 0 }) });
    }
    return Promise.resolve({ json: () => Promise.resolve([]) });
  });
  const qc = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        // Mirrors the app's default queryFn (client/src/lib/queryClient.ts).
        // Without it, any query declared without an explicit queryFn — such as
        // useTeamFeed — hangs forever here while working fine in production.
        queryFn: ({ queryKey }: any) => apiRequest("GET", String(queryKey[0])).then((r: any) => r.json()),
      },
    },
  });
  return render(<QueryClientProvider client={qc}><Today /></QueryClientProvider>);
}

beforeEach(() => {
  apiRequest.mockReset(); navigate.mockReset(); knockLog.mockReset();
  // Default: nothing to offer, so the card is absent unless a test says otherwise.
  readiness.mockReset().mockReturnValue({ state: "granted", isIOS: false, isStandalone: true });
});

function announcement(over: any = {}) {
  return {
    id: 7, kind: "promo", actorRepId: -1, actorName: "HQ",
    headline: "Double pay on Oak St until 6", body: "Every sale on Oak counts twice today",
    createdAtMs: Date.now() - 60_000, ...over,
  };
}

describe("Today - the rep's home", () => {
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

  // ── Why this door ──────────────────────────────────────────────────────────
  // The opportunity score and its sentences come from server/leadRanking.ts,
  // which scores signals nothing else in the product can compute. These pin the
  // bridge: the reasons must be the SERVER's words, the score must actually
  // change the order, and every one of it must degrade to the old distance
  // route when the fetch fails — Today is the screen a rep opens in a dead zone.

  it("explains the hero in the ranking engine's own words", async () => {
    renderToday({
      pins: [pin({ id: 1, address: "10 Low St" })],
      ranked: [ranked(1, 62, ["newly lit - was coming soon", "6 fresh leads within 800m"])],
    });
    const hero = await screen.findByTestId("today-hero");
    await waitFor(() => expect(hero.textContent).toContain("newly lit - was coming soon"));
    expect(hero.textContent).toContain("6 fresh leads within 800m");
  });

  it("lets the opportunity score outrank a door with a better lead score", async () => {
    // Lead score alone would put "20 High St" first, which is exactly the old
    // behaviour. The ranked door wins because the engine proved it flipped.
    renderToday({
      pins: [pin({ id: 1, leadScore: 10, address: "10 Fresh St" }), pin({ id: 2, leadScore: 95, address: "20 High St" })],
      ranked: [ranked(1, 58, ["lit 43m ago"])],
    });
    const hero = await screen.findByTestId("today-hero");
    await waitFor(() => expect(hero.textContent).toContain("10 Fresh St"));
    expect(hero.textContent).not.toContain("20 High St");
  });

  it("keeps the old route when the ranking endpoint refuses (403)", async () => {
    renderToday({
      failRanked: true,
      pins: [pin({ id: 1, leadScore: 30, address: "10 Low St" }), pin({ id: 2, leadScore: 95, address: "20 High St" })],
    });
    const hero = await screen.findByTestId("today-hero");
    expect(hero.textContent).toContain("20 High St");
    // No error surface: a missing overlay is not something a rep can act on.
    expect(screen.queryByTestId("today-error")).toBeNull();
  });

  it("keeps the old route when the ranking payload is empty", async () => {
    renderToday({
      ranked: [],
      pins: [pin({ id: 1, leadScore: 30, address: "10 Low St" }), pin({ id: 2, leadScore: 95, address: "20 High St" })],
    });
    const hero = await screen.findByTestId("today-hero");
    expect(hero.textContent).toContain("20 High St");
  });

  it("gives the rep an opening line built from the carrier and the lit date", async () => {
    renderToday({
      pins: [pin({ id: 1, carrier: "kinetic", freshConfirmedAt: new Date(Date.now() - 2 * 86_400_000).toISOString() })],
    });
    const opener = await screen.findByTestId("today-opener");
    expect(opener.textContent).toContain("Kinetic fiber went live at this address 2 days ago.");
    expect(opener.textContent).toContain("Do you know what you're paying for internet right now?");
  });

  it("says nothing at all when there is no verified fact about the door", async () => {
    renderToday({ pins: [pin({ id: 1, carrier: null, freshConfirmedAt: null })] });
    await screen.findByTestId("today-hero");
    expect(screen.queryByTestId("today-opener")).toBeNull();
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

  // Every glance number used to be inert: a rep who read "2 doors left" had to
  // find the map themselves. The number IS the way to the screen that owns it.
  it("routes each glance number to the screen that owns it", async () => {
    renderToday({ pins: [pin({ id: 1 })] });
    const href = async (label: string) =>
      (await screen.findByTestId(`glance-${label}`)).getAttribute("href");
    expect(await href("doors-today")).toBe("/leaderboard");
    expect(await href("sales-today")).toBe("/my-commission");
    expect(await href("doors-left")).toBe("/map");
    expect(await href("follow-ups")).toBe("/followups");
  });

  // Follow-ups owed is the one figure on this screen that is owed TODAY, so it
  // must be readable as a FACT at zero - not merely as the absence of a banner.
  it("shows follow-ups owed even when none are due", async () => {
    renderToday({ pins: [pin({ id: 1 })], followups: [] });
    const chip = await screen.findByTestId("glance-follow-ups");
    expect(within(chip).getByText("0")).toBeTruthy();
    expect(screen.queryByTestId("today-followups")).toBeNull();
  });
});

// ── Why THIS door is first ──────────────────────────────────────────────────
//
// The reason chips say what is true about the address. The opportunity rail says
// how hard the ranker argued for it, which is the question a rep asks when the
// hero is not the nearest door on the street. It is measured against
// SCORE_SATURATION - the same constant the route ordering uses - so the bar and
// the order can never tell different stories.
describe("Today - the opportunity rail", () => {
  it("reads a saturated score as Prime and fills the rail", async () => {
    renderToday({ pins: [pin({ id: 1 })], ranked: [ranked(1, 90, ["newly lit"])] });
    const rail = await screen.findByTestId("today-opportunity");
    expect(rail.textContent).toContain("Prime");
    expect(within(rail).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("100");
  });

  it("reads a weak score as Fair without ever going negative", async () => {
    renderToday({ pins: [pin({ id: 1 })], ranked: [ranked(1, 6, ["lit 40d ago"])] });
    const rail = await screen.findByTestId("today-opportunity");
    expect(rail.textContent).toContain("Fair");
    expect(within(rail).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("10");
  });

  // An unranked door is NEUTRAL, never weak - rankLeads pools confirmed-fresh
  // leads only, so most doors carry no score and an empty rail would read as a
  // bad door rather than an unscored one.
  it("says nothing for a door the ranker never scored", async () => {
    renderToday({ pins: [pin({ id: 1 })], ranked: [] });
    await screen.findByTestId("today-hero");
    expect(screen.queryByTestId("today-opportunity")).toBeNull();
  });
});

// ── Key metrics ─────────────────────────────────────────────────────────────
//
// The standing totals, kept apart from the glance band because "where do I
// stand" and "how is today going" are different questions. The block this
// replaced was one row reading "12 sales · 2 today", which repeated a figure the
// top of the screen already owned.
describe("Today - key metrics", () => {
  it("reads all-time doors and sales off the leaderboard row", async () => {
    renderToday({
      pins: [pin({ id: 1 })],
      board: [{ rep: { id: 9, name: "Rae Rep", role: "rep" }, knocks: 1240, sales: 12, knocksToday: 6, salesToday: 2 }],
    });
    const block = await screen.findByTestId("today-metrics");
    const tile = (label: string) => within(block).getByText(label).parentElement!;
    expect(within(tile("Doors all time")).getByText("1,240")).toBeTruthy();
    expect(within(tile("Sales all time")).getByText("12")).toBeTruthy();
  });
});

// ── Mounted at all ──────────────────────────────────────────────────────────
//
// These exist because the components did NOT: PushSetupCard and TeamFeed were
// both written, reviewed and shipped while referenced from nowhere. The install
// animation reached no one, and a manager could post an announcement that no rep
// had any surface to read. Rendering correctly is worthless if nothing renders
// you, so this block asserts placement, not appearance.
describe("Today - announcements and the install prompt reach the rep", () => {
  it("puts the install-and-notify card ABOVE the earnings header", async () => {
    readiness.mockReturnValue({ state: "needs_install", isIOS: true, isStandalone: false });
    renderToday();

    const card = await screen.findByTestId("push-setup-card");
    const header = await screen.findByTestId("today-greeting");
    // Node.compareDocumentPosition: FOLLOWING means header comes after the card.
    expect(card.compareDocumentPosition(header) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("on iPhone in a tab it teaches the install instead of asking for permission", async () => {
    // Asking here would burn the single prompt iOS ever shows, permanently.
    readiness.mockReturnValue({ state: "needs_install", isIOS: true, isStandalone: false });
    renderToday();
    await screen.findByTestId("push-setup-card");
    expect(screen.getByTestId("a2hs-guide")).toBeTruthy();
    expect(screen.queryByTestId("push-setup-enable")).toBeNull();
  });

  it("renders nothing once notifications are already granted", async () => {
    readiness.mockReturnValue({ state: "granted", isIOS: false, isStandalone: true });
    renderToday();
    await screen.findByTestId("today-greeting");
    expect(screen.queryByTestId("push-setup-card")).toBeNull();
  });

  it("shows the newest unread announcement at the top, above the header", async () => {
    renderToday({ announcements: { items: [announcement()], unread: 1, latestId: 7 } });

    const strip = await screen.findByTestId("team-feed-headline");
    expect(strip.textContent).toContain("Double pay on Oak St until 6");
    const header = screen.getByTestId("today-greeting");
    expect(strip.compareDocumentPosition(header) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("keeps the strip out of the way when there is nothing unread", async () => {
    renderToday({ announcements: { items: [announcement()], unread: 0, latestId: 7 } });
    await screen.findByTestId("today-greeting");
    expect(screen.queryByTestId("team-feed-headline")).toBeNull();
  });

  it("always offers the bell, so a read announcement is still reachable", async () => {
    renderToday({ announcements: { items: [announcement()], unread: 0, latestId: 7 } });
    expect(await screen.findByTestId("team-feed-bell")).toBeTruthy();
  });

  it("badges the bell with the unread count", async () => {
    renderToday({ announcements: { items: [announcement()], unread: 3, latestId: 7 } });
    const badge = await screen.findByTestId("team-feed-unread");
    expect(badge.textContent).toBe("3");
  });
});
