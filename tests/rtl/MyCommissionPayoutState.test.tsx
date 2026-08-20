import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: 1, name: "Rae Rep", role: "rep", teamMemberId: 9 } }),
}));
const apiRequest = vi.fn();
vi.mock("@/lib/queryClient", () => ({
  apiRequest: (...args: any[]) => apiRequest(...args),
  queryClient: undefined,
}));

import MyCommission from "@/pages/MyCommission";

const EMPTY_WEEK = {
  statement: null,
  bounds: { localWeekLabel: "Aug 17 - Aug 23, 2026" },
  noPlan: true,
  sales: [],
};

function response(payload: unknown) {
  return Promise.resolve({ json: () => Promise.resolve(payload) });
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(<QueryClientProvider client={qc}><MyCommission /></QueryClientProvider>);
}

beforeEach(() => apiRequest.mockReset());

describe("My Commission payout account truthfulness", () => {
  it("shows an actionable error and retries instead of hiding a failed payout-account read", async () => {
    let accountFails = true;
    let accountCalls = 0;
    apiRequest.mockImplementation((_method: string, url: string) => {
      if (url === "/api/commission/statements/me/current") return response(EMPTY_WEEK);
      if (url === "/api/commission/statements?repId=9") return response([]);
      if (url === "/api/payouts/account") {
        accountCalls += 1;
        if (accountFails) return Promise.reject(new Error("network down"));
        return response({
          hasRepProfile: true,
          enabled: true,
          onboardingStatus: "pending",
          payoutsEnabled: false,
          detailsSubmitted: false,
          history: [],
        });
      }
      return response({});
    });

    renderPage();
    const alert = await screen.findByTestId("payout-account-error");
    expect(alert).toHaveAttribute("role", "alert");
    expect(alert).toHaveTextContent(/no payout action is available/i);

    accountFails = false;
    fireEvent.click(screen.getByTestId("payout-account-retry"));
    await waitFor(() => expect(accountCalls).toBeGreaterThan(1));
    expect(await screen.findByTestId("get-paid-connect")).toBeInTheDocument();
  });

  it("fails closed when the status label says enabled but Stripe readiness signals disagree", async () => {
    apiRequest.mockImplementation((_method: string, url: string) => {
      if (url === "/api/commission/statements/me/current") return response(EMPTY_WEEK);
      if (url === "/api/commission/statements?repId=9") return response([]);
      if (url === "/api/payouts/account") return response({
        hasRepProfile: true,
        enabled: true,
        onboardingStatus: "enabled",
        payoutsEnabled: false,
        detailsSubmitted: true,
        history: [],
      });
      return response({});
    });

    renderPage();
    expect(await screen.findByTestId("get-paid-connect")).toBeInTheDocument();
    expect(screen.queryByTestId("payouts-ready")).not.toBeInTheDocument();
    expect(screen.getByTestId("connect-payout")).toHaveTextContent(/finish payout setup/i);
  });
});
