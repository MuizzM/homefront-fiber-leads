// The Area Console detail screen.
//
// What these tests protect is honesty and authority: the numbers on screen are
// the numbers the server sent (a rate re-derived client-side against `total`
// instead of `availableBase` is the exact bug shared/territoryMetrics exists to
// prevent), the unassigned case says so plainly instead of showing a stale
// holder, and a rep never sees a lifecycle control the API would refuse.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockAuth } = vi.hoisted(() => ({
  mockAuth: { user: { id: 1, name: "Rae Rep", role: "rep", teamMemberId: 9 } as any },
}));
vi.mock("@/lib/auth", () => ({ useAuth: () => mockAuth }));
const toast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));

// The next-pass dialog loads its own dry run through apiRequest (it takes the
// fetcher as a prop precisely so it stays testable). Stub the transport, keep
// the real queryClient the page invalidates against.
const passPreview = {
  currentPass: 3, nextPass: 4, territoryName: "Maple Grove",
  totals: { total: 200, reset: 130, frozen: 12 },
  frozenByReason: { sold: 12 }, callbacksAtRisk: 0,
};
const { apiRequest } = vi.hoisted(() => ({ apiRequest: vi.fn() }));
vi.mock("@/lib/queryClient", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/queryClient")>();
  return { ...actual, apiRequest };
});

import AreaDetail from "../../client/src/pages/AreaDetail";

// One area's row from GET /api/territories/:id/progress. The rates here are
// deliberately NOT knocked/total: availableBase is 160, so 40 knocked is 25%
// covered and 12 sold is 7.5% penetration. Re-deriving either against total
// (200) would print 20% and 6% — the assertions below catch exactly that.
const progress = {
  id: 7, name: "Maple Grove", color: "#16A34A", repId: 5, status: "active", repName: "Bo Rivera",
  total: 200, knocked: 40, sold: 12,
  availableBase: 160, untouched: 120, attempts: 55, contacted: 18, notHome: 22,
  followUp: 6, unavailable: 25, disqualified: 15,
  penetrationRate: 7.5, knockCompletionRate: 25, contactRate: 45,
  lastActivityAt: "2026-07-28T15:00:00.000Z", pct: 20,
  verifiedWorkedLeads: 34, areaWorkedPct: 17, verified: 30, needsReview: 4, invalid: 1,
  avgDistanceM: 12, maxObservedDistanceM: 140, maxAllowedDistanceM: 75, maxAllowedAccuracyM: 50,
};

const passes = {
  currentPass: 3,
  passes: [{
    id: 11, passNumber: 2, closedAt: "2026-06-04T12:00:00.000Z", closedByName: "Mona Manager",
    territoryAction: "keep", leadsTotal: 200, leadsReset: 130, leadsFrozen: 12, note: null,
    stats: { knocks: 180, doorsAnswered: 90, sold: 9, interested: 14, notInterested: 20, notHome: 60, callbacks: 3 },
  }],
};

function renderPage(over: Partial<typeof progress> = {}, opts: { progressError?: unknown } = {}) {
  const row = { ...progress, ...over };
  const qc = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        queryFn: ({ queryKey }) => {
          const url = String(queryKey[0]);
          if (url.endsWith("/progress")) {
            return opts.progressError ? Promise.reject(opts.progressError) : Promise.resolve(row);
          }
          if (url.endsWith("/passes")) return Promise.resolve(passes);
          if (url.endsWith("/history")) return Promise.resolve([]);
          if (url === "/api/team") return Promise.resolve([
            { id: 5, name: "Bo Rivera", active: true },
            { id: 6, name: "Talal Rep", active: true },
            { id: 9, name: "Rae Rep", active: true },
          ]);
          return Promise.resolve(null);
        },
      },
    },
  });
  const { hook } = memoryLocation({ path: "/areas/7" });
  return render(
    <Router hook={hook}>
      <QueryClientProvider client={qc}><AreaDetail /></QueryClientProvider>
    </Router>,
  );
}

beforeEach(() => {
  toast.mockReset();
  // Default transport: the next-pass dialog's dry run. Tests that exercise a
  // lifecycle write override it.
  apiRequest.mockReset();
  apiRequest.mockImplementation(async () => ({ json: async () => passPreview } as unknown as Response));
});

describe("AreaDetail — the area's own numbers", () => {
  beforeEach(() => { mockAuth.user = { id: 2, name: "Mona Manager", role: "manager", teamMemberId: 4 }; });

  it("names the area, states its status, and shows the four headline figures", async () => {
    renderPage();
    expect(await screen.findByTestId("area-name")).toHaveTextContent("Maple Grove");
    expect(screen.getByTestId("area-status-chip")).toHaveTextContent("Assigned");

    expect(screen.getByTestId("area-stat-total-value")).toHaveTextContent("200");
    expect(screen.getByTestId("area-stat-knocked-value")).toHaveTextContent("40");
    expect(screen.getByTestId("area-stat-sold-value")).toHaveTextContent("12");
    expect(screen.getByTestId("area-stat-followup-value")).toHaveTextContent("6");
  });

  it("prints the server's rates, never a percentage re-derived against the raw total", async () => {
    renderPage();
    // 40 of 160 AVAILABLE doors = 25%. Against total (200) it would read 20%.
    expect(await screen.findByTestId("area-stat-knocked-sub")).toHaveTextContent("25% of the area covered");
    expect(screen.getByTestId("area-stat-knocked-sub")).not.toHaveTextContent("20%");
    // 12 of 160 = 7.5% penetration; against total it would read 6%.
    expect(screen.getByTestId("area-stat-sold-sub")).toHaveTextContent("7.5% penetration");
    expect(screen.getByTestId("area-stat-sold-sub")).not.toHaveTextContent("6%");
  });

  it("shows the door count, last activity, and the pass it is on", async () => {
    renderPage();
    expect(await screen.findByTestId("area-meta")).toHaveTextContent("200 doors");
    expect(screen.getByTestId("area-meta")).toHaveTextContent(/last activity Jul 28/);
    expect(await screen.findByTestId("area-pass-chip")).toHaveTextContent("Pass 3");
  });

  it("names the holder in the owner card", async () => {
    renderPage();
    expect(await screen.findByTestId("area-owner-name")).toHaveTextContent("Bo Rivera");
    expect(screen.queryByTestId("area-owner-empty")).toBeNull();
  });

  it("says plainly that nobody holds an unassigned area", async () => {
    renderPage({ status: "unassigned", repId: null, repName: "Unassigned" });
    expect(await screen.findByTestId("area-owner-empty")).toHaveTextContent("Unassigned");
    expect(screen.getByTestId("area-owner-empty")).toHaveTextContent(/Nobody holds this area/i);
    expect(screen.queryByTestId("area-owner-name")).toBeNull();
    expect(screen.getByTestId("area-status-chip")).toHaveTextContent("Unassigned");
  });

  it("breaks the doors down against the stated base, not the raw total", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId("area-tab-stats"));
    expect(screen.getByTestId("area-stat-contacted")).toHaveTextContent("18");
    expect(screen.getByTestId("area-stat-untouched")).toHaveTextContent("120");
    expect(screen.getByTestId("area-base-note")).toHaveTextContent(/160 available doors/);
    // The verification block is knock verdicts, labelled as such.
    expect(screen.getByTestId("area-verified")).toHaveTextContent("30");
    expect(screen.getByTestId("area-needs-review")).toHaveTextContent("4");
    expect(screen.getByTestId("area-invalid")).toHaveTextContent("1");
  });

  it("mounts the existing pass history from the passes endpoint", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId("area-tab-passes"));
    expect(await screen.findByText("Pass 2")).toBeInTheDocument();
    expect(screen.getByText(/now on pass 3/)).toBeInTheDocument();
    expect(screen.getByText(/closed .* by Mona Manager/)).toBeInTheDocument();
  });

  it("links the Doors and Map tabs to the screens that already own them", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId("area-tab-doors"));
    expect(screen.getByTestId("area-doors-leads-link")).toHaveAttribute("href", "/leads");
    await user.click(screen.getByTestId("area-tab-map"));
    expect(screen.getByTestId("area-map-link")).toHaveAttribute("href", "/map");
  });

  it("renders one calm state for an area that is missing or not yours", async () => {
    renderPage({}, { progressError: Object.assign(new Error("404: Not found"), { status: 404 }) });
    expect(await screen.findByTestId("area-not-found-state")).toHaveTextContent(/Area not found/i);
    // It must never confirm the area exists elsewhere.
    expect(screen.queryByTestId("area-name")).toBeNull();
    expect(screen.queryByText(/forbidden|not allowed|permission denied/i)).toBeNull();
  });
});

describe("AreaDetail — who may act", () => {
  it("hides every lifecycle control from a plain rep", async () => {
    mockAuth.user = { id: 1, name: "Rae Rep", role: "rep", teamMemberId: 9 };
    renderPage();
    await screen.findByTestId("area-name");
    expect(screen.queryByTestId("area-action-reassign")).toBeNull();
    expect(screen.queryByTestId("area-action-unassign")).toBeNull();
    expect(screen.queryByTestId("area-action-next-pass")).toBeNull();
    // The pass surfaces are team_lead+ routes, so a rep is never offered them.
    expect(screen.queryByTestId("area-tab-passes")).toBeNull();
    expect(screen.queryByTestId("area-pass-chip")).toBeNull();
    // A rep still gets the read-only surface and the way back to the map.
    expect(screen.getByTestId("area-stat-knocked-value")).toHaveTextContent("40");
    expect(screen.getByTestId("area-action-open-map")).toHaveAttribute("href", "/map");
  });

  it("gives a team lead assignment controls but not a pass reset", async () => {
    mockAuth.user = { id: 3, name: "Tia Lead", role: "team_lead", teamMemberId: 3 };
    renderPage();
    expect(await screen.findByTestId("area-action-reassign")).toBeInTheDocument();
    expect(screen.getByTestId("area-action-unassign")).toBeInTheDocument();
    expect(screen.queryByTestId("area-action-next-pass")).toBeNull();
  });

  it("gives a manager the full set, including the pass reset", async () => {
    mockAuth.user = { id: 2, name: "Mona Manager", role: "manager", teamMemberId: 4 };
    renderPage();
    expect(await screen.findByTestId("area-action-reassign")).toBeInTheDocument();
    expect(screen.getByTestId("area-action-unassign")).toBeInTheDocument();
    expect(screen.getByTestId("area-action-next-pass")).toBeInTheDocument();
  });

  it("offers Assign (not Unassign) on an area nobody holds", async () => {
    mockAuth.user = { id: 2, name: "Mona Manager", role: "manager", teamMemberId: 4 };
    renderPage({ status: "unassigned", repId: null, repName: "Unassigned" });
    expect(await screen.findByTestId("area-action-reassign")).toHaveTextContent("Assign");
    expect(screen.queryByTestId("area-action-unassign")).toBeNull();
  });

  it("opens the existing rep picker rather than inventing an assignment UI", async () => {
    const user = userEvent.setup();
    mockAuth.user = { id: 2, name: "Mona Manager", role: "manager", teamMemberId: 4 };
    renderPage();
    await user.click(await screen.findByTestId("area-action-reassign"));
    expect(await screen.findByTestId("rep-option-5")).toBeInTheDocument();
    expect(screen.getByTestId("area-assign-confirm")).toBeInTheDocument();
  });

  it("opens the existing next-pass dialog rather than resetting on one tap", async () => {
    const user = userEvent.setup();
    mockAuth.user = { id: 2, name: "Mona Manager", role: "manager", teamMemberId: 4 };
    renderPage();
    await user.click(await screen.findByTestId("area-action-next-pass"));
    expect(await screen.findByTestId("next-pass-dialog")).toBeInTheDocument();
    // It opens the real dry run, so the reset is never a blind one-tap action.
    expect(await screen.findByRole("button", { name: "Start pass 4" })).toBeInTheDocument();
  });

  it("the header Unassign arms first; /unassign fires only on the confirm tap", async () => {
    const user = userEvent.setup();
    mockAuth.user = { id: 2, name: "Mona Manager", role: "manager", teamMemberId: 4 };
    apiRequest.mockImplementation(async () => ({
      json: async () => ({ ok: true, leadsReleased: 84, assigneeIds: [] }),
    } as unknown as Response));
    renderPage();

    await user.click(await screen.findByTestId("area-action-unassign"));
    // Armed, not fired: same stakes as the per-rep Remove — a mis-tap on a
    // phone would strip Bo of the whole area in one touch.
    expect(apiRequest).not.toHaveBeenCalled();
    expect(screen.getByTestId("area-action-unassign-confirm")).toHaveTextContent("Unassign Bo");

    await user.click(screen.getByTestId("area-action-unassign-confirm"));
    expect(apiRequest).toHaveBeenCalledWith("POST", "/api/territories/7/unassign", { repId: 5 });
  });

  it("Keep disarms the header Unassign and calls nothing", async () => {
    const user = userEvent.setup();
    mockAuth.user = { id: 2, name: "Mona Manager", role: "manager", teamMemberId: 4 };
    renderPage();
    await user.click(await screen.findByTestId("area-action-unassign"));
    await user.click(screen.getByTestId("area-action-unassign-cancel"));
    expect(screen.queryByTestId("area-action-unassign-confirm")).toBeNull();
    expect(screen.getByTestId("area-action-unassign")).toBeInTheDocument();
    expect(apiRequest).not.toHaveBeenCalled();
  });
});

// ── The crew, and taking somebody off it from the Area tab ──────────────────
//
// An area is many-to-many everywhere else in the product, but this screen could
// only ever print ONE name — so a two-rep area read as one rep's ground, and
// there was no way to remove the other from here at all.
describe("AreaDetail — who works this area", () => {
  const CREW = {
    repId: 5, repName: "Bo Rivera",
    repIds: [5, 6], repNames: ["Bo Rivera", "Talal Rep"],
    status: "shared",
  };

  beforeEach(() => { mockAuth.user = { id: 2, name: "Mona Manager", role: "manager", teamMemberId: 4 }; });

  it("lists EVERY holder, not just the primary", async () => {
    renderPage(CREW);
    expect(await screen.findByTestId("area-holder-5")).toHaveTextContent("Bo Rivera");
    expect(screen.getByTestId("area-holder-6")).toHaveTextContent("Talal Rep");
    expect(screen.getByTestId("area-owner")).toHaveTextContent("2 reps");
    // The first is marked as primary — it drives the colour and the doors' rep.
    expect(screen.getByTestId("area-holder-5")).toHaveTextContent("Primary");
  });

  it("the hero line names the crew instead of one rep", async () => {
    renderPage(CREW);
    expect(await screen.findByTestId("area-hero-value")).toHaveTextContent("Bo Rivera and Talal Rep");
  });

  it("falls back to the primary pair for a row served before repIds existed", async () => {
    renderPage();   // no repIds/repNames on the fixture
    expect(await screen.findByTestId("area-holder-5")).toHaveTextContent("Bo Rivera");
    expect(screen.getByTestId("area-owner-name")).toHaveTextContent("Bo Rivera");
  });

  it("THE REQUIREMENT: removing one rep calls /unassign for THAT rep, after a confirm", async () => {
    const user = userEvent.setup();
    apiRequest.mockImplementation(async () => ({
      json: async () => ({ ok: true, leadsReleased: 84, assigneeIds: [5] }),
    } as unknown as Response));
    renderPage(CREW);

    await user.click(await screen.findByTestId("area-holder-remove-6"));
    // Armed, not fired: dropping a rep hands their doors back, so a mis-tap
    // costs somebody their working queue.
    expect(apiRequest).not.toHaveBeenCalled();

    await user.click(screen.getByTestId("area-holder-remove-confirm-6"));
    expect(apiRequest).toHaveBeenCalledWith("POST", "/api/territories/7/unassign", { repId: 6 });
  });

  it("says how many doors went back, naming the rep who lost them", async () => {
    const user = userEvent.setup();
    apiRequest.mockImplementation(async () => ({
      json: async () => ({ ok: true, leadsReleased: 84, assigneeIds: [5] }),
    } as unknown as Response));
    renderPage(CREW);
    await user.click(await screen.findByTestId("area-holder-remove-6"));
    await user.click(screen.getByTestId("area-holder-remove-confirm-6"));

    await vi.waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast.mock.calls[0][0]).toMatchObject({ title: "Talal Rep removed from this area" });
    expect(toast.mock.calls[0][0].description).toBe("84 doors went back to the pool.");
  });

  it("Keep cancels the armed removal and calls nothing", async () => {
    const user = userEvent.setup();
    renderPage(CREW);
    await user.click(await screen.findByTestId("area-holder-remove-6"));
    await user.click(screen.getByTestId("area-holder-remove-cancel-6"));
    expect(screen.queryByTestId("area-holder-remove-confirm-6")).toBeNull();
    expect(apiRequest).not.toHaveBeenCalled();
  });

  it("adds a rep through /share with the COMPLETE new holder set", async () => {
    const user = userEvent.setup();
    renderPage(CREW);
    await user.click(await screen.findByTestId("area-add-rep"));
    // The picker offers only reps who are NOT already on it.
    await user.click(await screen.findByTestId("rep-option-9"));
    expect(apiRequest).toHaveBeenCalledWith("POST", "/api/territories/7/share", { repIds: [5, 6, 9] });
  });

  it("hides the ambiguous single 'Unassign Bo' button once there is a crew", async () => {
    // "Unassign Bo" on ground three people walk begs the question WHICH rep, so
    // removal moves to the per-rep control on the card.
    renderPage(CREW);
    await screen.findByTestId("area-holder-5");
    expect(screen.queryByTestId("area-action-unassign")).toBeNull();
    // A one-rep area keeps the fast path.
    renderPage();
    expect(await screen.findByTestId("area-action-unassign")).toBeInTheDocument();
  });

  it("a rep sees the crew but is offered no way to change it", async () => {
    mockAuth.user = { id: 1, name: "Rae Rep", role: "rep", teamMemberId: 9 };
    renderPage(CREW);
    expect(await screen.findByTestId("area-holder-5")).toBeInTheDocument();
    expect(screen.queryByTestId("area-holder-remove-5")).toBeNull();
    expect(screen.queryByTestId("area-add-rep")).toBeNull();
  });

  it("an unassigned area shows the pool state, not a stale crew", async () => {
    renderPage({ status: "unassigned", repId: null, repName: "Unassigned", repIds: [], repNames: [] });
    expect(await screen.findByTestId("area-owner-empty")).toHaveTextContent(/Nobody holds this area/i);
    expect(screen.queryByTestId("area-owner-list")).toBeNull();
    expect(screen.queryByTestId("area-add-rep")).toBeNull();
  });
});
