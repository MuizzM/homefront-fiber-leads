// ── Every earning surface a rep owns is reachable from the nav ───────────────
//
// Mileage (a tax-deduction log with an export) and Referrals (a paid program
// with a personal link) shipped as live routes with server APIs — and no nav
// entry anywhere: not the sidebar, not the More sheet. Reachable only by typed
// URL. These tests pin their presence for a rep, and pin the flip side: roles
// whose capabilities exclude a surface never see a dead link to it.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

let mockRole = "rep";
// The server-side GUARDED_ACTIONS_ENABLED bit as the session payload delivers
// it. Defaults off, which is how the feature ships.
let mockGuardedActionsEnabled = false;
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: {
      id: 1, name: "Rae Rep", role: mockRole, teamMemberId: 9, isSuperAdmin: false,
      guardedActionsEnabled: mockGuardedActionsEnabled,
    },
    logout: vi.fn(),
  }),
}));
vi.mock("@/lib/queryClient", () => ({
  apiRequest: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
  queryClient: { invalidateQueries: vi.fn() },
}));

import Layout, { isTrainingGateOpenClientPath } from "../../client/src/pages/Layout";

function renderLayout(role: string) {
  mockRole = role;
  mockGuardedActionsEnabled = false;
  const qc = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        // Layout's own queries key on URLs; array-shaped endpoints must resolve
        // to arrays or the component's .filter() throws mid-test.
        queryFn: ({ queryKey }) => Promise.resolve(String(queryKey[0]).includes("territory") ? [] : {}),
      },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <Layout><div /></Layout>
    </QueryClientProvider>,
  );
}

describe("field nav reachability", () => {
  it("removes the closed phone drawer from focus and the accessibility tree", async () => {
    const previousWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    try {
      renderLayout("rep");
      const sidebar = document.querySelector("aside");
      await waitFor(() => {
        expect(sidebar).toHaveAttribute("aria-hidden", "true");
        expect(sidebar).toHaveAttribute("inert");
      });

      fireEvent.click(screen.getByRole("button", { name: "Open navigation menu" }));
      expect(sidebar).not.toHaveAttribute("aria-hidden");
      expect(sidebar).not.toHaveAttribute("inert");
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: previousWidth });
    }
  });

  it("offers a hash-router-safe keyboard shortcut to the main workspace", () => {
    renderLayout("rep");
    const skip = screen.getByRole("link", { name: "Skip to main content" });
    const main = document.getElementById("main-content");

    expect(main).toHaveAttribute("tabindex", "-1");
    fireEvent.click(skip);
    expect(main).toHaveFocus();
  });

  it("a rep can reach Mileage and Referrals from the nav", () => {
    renderLayout("rep");
    expect(screen.getByTestId("nav-mileage")).toBeTruthy();
    expect(screen.getByTestId("nav-referrals")).toBeTruthy();
  });

  it("calling-only roles see neither (their capabilities exclude both routes)", () => {
    renderLayout("calling_rep");
    expect(screen.queryByTestId("nav-mileage")).toBeNull();
    expect(screen.queryByTestId("nav-referrals")).toBeNull();
  });

  it("collapses long sections but lets keyboard and pointer users reopen them", () => {
    window.history.replaceState(null, "", "#/today");
    renderLayout("rep");
    const fieldToggle = screen.getByTestId("nav-group-field");
    const fieldGroup = document.getElementById(fieldToggle.getAttribute("aria-controls")!);

    expect(fieldToggle).toHaveAttribute("aria-expanded", "false");
    expect(fieldGroup).toHaveAttribute("hidden");

    fireEvent.click(fieldToggle);
    expect(fieldToggle).toHaveAttribute("aria-expanded", "true");
    expect(fieldGroup).not.toHaveAttribute("hidden");
  });

  it("groups the mobile More destinations and marks the current page", () => {
    window.history.replaceState(null, "", "#/leaderboard");
    renderLayout("rep");

    fireEvent.click(screen.getByRole("button", { name: /open navigation and account/i }));
    const dialog = screen.getByRole("dialog", { name: "More navigation" });
    expect(within(dialog).getByRole("heading", { name: "Field" })).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: "Leaderboard" })).toHaveAttribute("aria-current", "page");
    expect(within(dialog).getByRole("link", { name: "Profile and account" })).toBeInTheDocument();
  });
});

describe("the action-approvals gate probe", () => {
  // The probe (GET /api/actions/pending-count) must only ever run where the
  // session payload says the guarded-actions flag is on. With the flag off the
  // server answers 404 by design, and a browser logs every 404 to the console
  // unsuppressably - so an approver-role user in a flag-off environment used
  // to collect one console error per minute from this poll alone.
  function renderRecordingRequests(role: string, guardedOn: boolean) {
    mockRole = role;
    mockGuardedActionsEnabled = guardedOn;
    const requested: string[] = [];
    const qc = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          queryFn: ({ queryKey }) => {
            const url = String(queryKey[0]);
            requested.push(url);
            return Promise.resolve(
              url.includes("territory") ? []
              : url === "/api/actions/pending-count" ? { pending: 3 }
              : {});
          },
        },
      },
    });
    render(
      <QueryClientProvider client={qc}>
        <Layout><div /></Layout>
      </QueryClientProvider>,
    );
    return requested;
  }

  it("an admin in a flag-off environment never issues the request and sees no nav entry", async () => {
    const requested = renderRecordingRequests("admin", false);
    // Let the layout's other queries fire so "never" means settled, not early.
    await waitFor(() => expect(requested.length).toBeGreaterThan(0));
    expect(requested).not.toContain("/api/actions/pending-count");
    expect(screen.queryByTestId("nav-action-approvals")).toBeNull();
  });

  it("an admin in a flag-on environment probes, and the entry appears once the probe answers", async () => {
    const requested = renderRecordingRequests("admin", true);
    await waitFor(() => expect(screen.getByTestId("nav-action-approvals")).toBeTruthy());
    expect(requested).toContain("/api/actions/pending-count");
  });

  it("a rep never probes even where the flag is on (no action.queue.read)", async () => {
    const requested = renderRecordingRequests("rep", true);
    await waitFor(() => expect(requested.length).toBeGreaterThan(0));
    expect(requested).not.toContain("/api/actions/pending-count");
    expect(screen.queryByTestId("nav-action-approvals")).toBeNull();
  });
});

describe("training gate client routes", () => {
  it.each([
    "/training",
    "/training/",
    "#/training",
    "#/training/lesson-one",
    "/training?from=email",
    "/profile",
    "/my-documents",
    "/tax-and-pay",
  ])("keeps %s reachable while a rep is gated", path => {
    expect(isTrainingGateOpenClientPath(path)).toBe(true);
  });

  it.each(["/leads", "/fiber", "/scanner-tools", "/users", "#/leaderboard"])(
    "keeps %s locked until training is complete",
    path => expect(isTrainingGateOpenClientPath(path)).toBe(false),
  );
});
