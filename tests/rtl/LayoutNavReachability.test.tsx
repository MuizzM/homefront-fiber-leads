// ── Every earning surface a rep owns is reachable from the nav ───────────────
//
// Mileage (a tax-deduction log with an export) and Referrals (a paid program
// with a personal link) shipped as live routes with server APIs — and no nav
// entry anywhere: not the sidebar, not the More sheet. Reachable only by typed
// URL. These tests pin their presence for a rep, and pin the flip side: roles
// whose capabilities exclude a surface never see a dead link to it.
import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

let mockRole = "rep";
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: { id: 1, name: "Rae Rep", role: mockRole, teamMemberId: 9, isSuperAdmin: false },
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
