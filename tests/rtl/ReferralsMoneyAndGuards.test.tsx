// ── Referral money renders truthfully; releasing it takes two taps ───────────
//
// Three pinned fixes:
//  1. money(): a clawback is NEGATIVE money. The old formatter ran Math.abs and
//     printed −$150 as "$150" — a sign error on a rep-visible ledger.
//  2. Raw DB enums (REWARD_PENDING, CLAWED_BACK) reached users verbatim,
//     underscores and all. Chips now carry human labels.
//  3. Approving releases a cash reward: first tap arms, second tap fires. A
//     single mis-tap must not move money.
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";

const apiRequest = vi.fn();
vi.mock("@/lib/queryClient", () => ({
  apiRequest: (...a: any[]) => apiRequest(...a),
  queryClient: { invalidateQueries: vi.fn() },
  ApiError: class ApiError extends Error {
    constructor(
      public status: number,
      message: string,
      public requestId: string | null,
      public retryAfterMs: number | null,
      public code: string | null = null,
    ) { super(message); }
  },
}));
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: 1, name: "Ada Admin", role: "admin", teamMemberId: 1 } }),
}));
vi.mock("@/lib/capabilities", () => ({
  useCan: () => true,
}));

import Referrals from "../../client/src/pages/Referrals";
import { ApiError } from "@/lib/queryClient";

function referral(over: Record<string, any> = {}) {
  return {
    id: 7, referrerName: "Rae Rep", referredName: "Nia New", referredEmail: "nia@example.com",
    status: "REWARD_PENDING", rewardAmountCents: 15000, qualifyingSalesCount: 3,
    ...over,
  };
}

const SETTINGS = {
  enabled: true, rewardCents: 15000, requiredApprovedSales: 3,
  qualificationWindowDays: 90, clawbackWindowDays: 60,
  liability: { pendingCents: 0, approvedCents: 0, inProgress: 0 },
};

function mockEndpoints(rows: any[] | Error) {
  apiRequest.mockImplementation((...args: any[]) => {
    const url = args.find(a => typeof a === "string" && a.startsWith("/")) ?? "";
    if (url.startsWith("/api/referrals/my-link")) {
      return Promise.resolve({ json: () => Promise.resolve({
        url: "http://localhost/join?ref=TESTCODE", code: "TESTCODE", clickCount: 0,
        programEnabled: true, rewardCents: 15000, requiredApprovedSales: 3,
        releasable: { releasable: false, daysRemaining: 14 },
      }) });
    }
    if (url.startsWith("/api/referrals/my-status")) return Promise.resolve({ json: () => Promise.resolve(null) });
    if (url.startsWith("/api/referrals/settings")) return Promise.resolve({ ok: true, json: () => Promise.resolve(SETTINGS) });
    if (url.startsWith("/api/referrals")) {
      if (rows instanceof Error) return Promise.reject(rows);
      return Promise.resolve({ ok: true, json: () => Promise.resolve(rows) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
}

function renderPage(rows: any[]) {
  mockEndpoints(rows);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><Referrals /></QueryClientProvider>);
}

beforeEach(() => apiRequest.mockReset());

describe("referral pipeline money + status labels", () => {
  it("explains an intentionally unlinked administrator instead of showing a broken-page error", async () => {
    mockEndpoints([]);
    apiRequest.mockImplementation((...args: any[]) => {
      const url = args.find(a => typeof a === "string" && a.startsWith("/")) ?? "";
      if (url === "/api/referrals/my-link") {
        return Promise.reject(new ApiError(
          400,
          "400: No team member is linked to this login",
          "req-referral",
          null,
          "NO_REP",
        ));
      }
      if (url.startsWith("/api/referrals/my-status")) return Promise.resolve({ json: () => Promise.resolve(null) });
      if (url.startsWith("/api/referrals/settings")) return Promise.resolve({ ok: true, json: () => Promise.resolve(SETTINGS) });
      if (url.startsWith("/api/referrals")) return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><Referrals /></QueryClientProvider>);
    expect(await screen.findByTestId("referral-link-unlinked")).toHaveTextContent(/not linked to a field-rep profile/i);
    expect(screen.queryByText(/couldn't load your referral link/i)).toBeNull();
    expect(screen.getByRole("link", { name: /open team management/i })).toHaveAttribute("href", "#/team");
  });

  it("renders human status labels, not raw enums", async () => {
    renderPage([referral()]);
    await waitFor(() => expect(screen.getAllByText("Pending approval").length).toBeGreaterThan(0));
    expect(screen.queryByText("REWARD_PENDING")).toBeNull();
  });

  it("keeps the sign on negative amounts", async () => {
    renderPage([referral({ id: 8, status: "CLAWED_BACK", rewardAmountCents: -15000 })]);
    await waitFor(() => expect(screen.getAllByText("Reversed").length).toBeGreaterThan(0));
    // The row amount for the clawback carries the minus sign.
    expect(screen.getAllByText("-$150").length).toBeGreaterThan(0);
  });

  it("approve is two-tap: the first tap arms and fires nothing", async () => {
    renderPage([referral()]);
    // The row renders in BOTH the "mine" and the org pipeline (this mock user
    // holds every capability) - take the first; two-tap behavior is per-button.
    const approve = (await screen.findAllByTestId("referral-approve-7"))[0];
    const callsBefore = apiRequest.mock.calls.filter(c =>
      c.some((a: any) => typeof a === "string" && a.includes("/approve"))).length;
    fireEvent.click(approve);
    // Armed, not fired.
    expect(approve.getAttribute("aria-pressed")).toBe("true");
    expect(approve.textContent).toMatch(/release/i);
    const callsAfterArm = apiRequest.mock.calls.filter(c =>
      c.some((a: any) => typeof a === "string" && a.includes("/approve"))).length;
    expect(callsAfterArm).toBe(callsBefore);
    // Second tap fires the release.
    fireEvent.click(approve);
    await waitFor(() => {
      const callsAfterConfirm = apiRequest.mock.calls.filter(c =>
        c.some((a: any) => typeof a === "string" && a.includes("/approve"))).length;
      expect(callsAfterConfirm).toBe(callsBefore + 1);
    });
  });

  it("a failed pipeline fetch shows a retry, not 'share your link to get started'", async () => {
    mockEndpoints(new Error("down"));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><Referrals /></QueryClientProvider>);
    await waitFor(() => expect(screen.getAllByText(/couldn't load referrals/i).length).toBeGreaterThan(0));
    expect(screen.queryByText(/share your link to get started/i)).toBeNull();
  });
});
