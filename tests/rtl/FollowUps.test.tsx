// Follow-ups — the callbacks a rep owes, pinned.
//
// Grouping is the contract: a callback dated before today is OVERDUE, today is
// TODAY, later is UPCOMING — and the header states the totals so a rep reads
// their debt in one glance. These tests also pin the error and empty forks.
import { fireEvent, render, screen, within } from "@testing-library/react";
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
// One GPS fix per page open feeds the per-row distance hint. Default: no fix
// (jsdom has no geolocation) — the distance column simply does not render.
const captureFieldFix = vi.fn();
vi.mock("@/lib/geoFix", () => ({ captureFieldFix: (...a: any[]) => captureFieldFix(...a) }));

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

beforeEach(() => {
  apiRequest.mockReset();
  captureFieldFix.mockReset();
  captureFieldFix.mockResolvedValue({ repLat: null, repLng: null, gpsAccuracy: null });
});

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

describe("Schedule week strip and time-first rows", () => {
  it("renders the seven days of this week with today selected, one dot per booking", async () => {
    const today = todayISO();
    renderPage([fu(1, today, { callbackTime: "09:30" }), fu(2, today)]);
    await screen.findByTestId("followup-1");
    const strip = screen.getByTestId("schedule-week");
    const days = within(strip).getAllByRole("button");
    expect(days).toHaveLength(7);
    const todayTab = screen.getByTestId(`schedule-day-${today}`);
    expect(todayTab.getAttribute("aria-pressed")).toBe("true");
    // Two bookings today -> two dots on today's day cell.
    expect(todayTab.querySelectorAll("span[style*='background']").length).toBe(2);
    // The week label names the Monday.
    expect(screen.getByTestId("schedule-week-label").textContent).toMatch(/^Week of /);
  });

  it("leads each row with its time, and says so when a callback has none", async () => {
    const today = todayISO();
    renderPage([fu(1, today, { callbackTime: "09:30" }), fu(2, today)]);
    expect((await screen.findByTestId("followup-time-1")).textContent).toBe("9:30 AM");
    expect(screen.getByTestId("followup-time-2").textContent).toBe("Any time");
  });

  it("tapping another day shows only that day's bookings, and the way back", async () => {
    const today = todayISO();
    const tomorrow = (() => { const d = new Date(today + "T00:00:00"); d.setDate(d.getDate() + 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
    renderPage([fu(1, today), fu(2, tomorrow, { callbackTime: "14:00" })]);
    await screen.findByTestId("followup-1");
    const strip = screen.getByTestId("schedule-week");
    // Tomorrow may fall in next week's strip (Sunday). Only assert when it is on the strip.
    const tomorrowTab = within(strip).queryByTestId(`schedule-day-${tomorrow}`);
    if (!tomorrowTab) return;
    fireEvent.click(tomorrowTab);
    const view = screen.getByTestId("schedule-day-view");
    expect(within(view).getByTestId("followup-2")).toBeTruthy();
    expect(within(view).queryByTestId("followup-1")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Today" })).toBeNull();
    // A day with nothing booked says so and offers the way back to today.
    const empty = within(strip).getAllByRole("button").find(t => t.getAttribute("aria-pressed") !== "true" && t !== tomorrowTab && t.getAttribute("data-testid") !== `schedule-day-${today}`)!;
    fireEvent.click(empty);
    expect(screen.getByTestId("schedule-day-empty").textContent).toContain("Nothing booked for");
    fireEvent.click(screen.getByText("Back to today"));
    expect(screen.getByRole("heading", { name: "Today" })).toBeTruthy();
  });

  it("shows how far each door is once a tight GPS fix arrives", async () => {
    captureFieldFix.mockResolvedValue({ repLat: 35.67, repLng: -80.47, gpsAccuracy: 12 });
    const today = todayISO();
    renderPage([fu(1, today, { lat: 35.671, lng: -80.47 }), fu(2, today)]);
    expect((await screen.findByTestId("followup-distance-1")).textContent).toMatch(/^\d+m$/);
    expect(screen.queryByTestId("followup-distance-2")).toBeNull();
  });

  it("hides distances when the fix is too loose to mean anything", async () => {
    captureFieldFix.mockResolvedValue({ repLat: 35.67, repLng: -80.47, gpsAccuracy: 800 });
    renderPage([fu(1, todayISO(), { lat: 35.671, lng: -80.47 })]);
    await screen.findByTestId("followup-1");
    expect(screen.queryByTestId("followup-distance-1")).toBeNull();
  });
});


it("bounds a large agenda and lets every appointment be reached by paging", async () => {
  renderPage(Array.from({ length: 123 }, (_, index) => fu(index + 1, todayISO(), { callbackTime: "09:00" })));
  await screen.findByTestId("followup-1");
  expect(screen.getByTestId("followups-summary")).toHaveTextContent("123 scheduled");
  expect(document.querySelectorAll('[data-testid^="followup-time-"]')).toHaveLength(50);
  const pages = within(screen.getByRole("navigation", { name: "Today appointments" }));
  fireEvent.click(pages.getByText("Next"));
  expect(screen.getByTestId("followup-51")).toBeTruthy();
  expect(screen.getByTestId("followup-51")).toHaveFocus();
  expect(screen.queryByTestId("followup-1")).toBeNull();
  fireEvent.click(pages.getByText("Next"));
  expect(screen.getByTestId("followup-123")).toBeTruthy();
  expect(screen.getByTestId("followup-101")).toHaveFocus();
  expect(document.querySelectorAll('[data-testid^="followup-time-"]')).toHaveLength(23);
  expect(pages.getByText("Next")).toBeDisabled();
  fireEvent.click(pages.getByText("Previous"));
  expect(screen.getByTestId("followup-51")).toBeTruthy();
  expect(screen.getByTestId("followup-51")).toHaveFocus();
});
