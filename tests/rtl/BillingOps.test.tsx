// Billing Ops staged-confirm contract (audit fix): the plan and billing-state
// selects must NEVER POST directly onChange. Selection stages the change
// locally and shows an inline confirm strip; the POST fires only on Confirm,
// and Cancel reverts the select to the server value. Destructive states
// (suspended / canceled) get a rose confirm.
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";

const apiRequest = vi.fn();
vi.mock("@/lib/queryClient", () => ({ apiRequest: (...a: any[]) => apiRequest(...a), queryClient: undefined }));
const toast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));

import { BillingOps } from "../../client/src/components/BillingOps";

const DATA = {
  plans: [
    { key: "starter", name: "Starter", monthlyCredits: 1000, monthlyPriceUsd: 49 },
    { key: "growth", name: "Growth", monthlyCredits: 5000, monthlyPriceUsd: 149 },
  ],
  tenants: [
    {
      tenantId: 1, companyName: "Acme Fiber", slug: "acme-fiber",
      enabled: true, planKey: "starter", planName: "Starter", state: "active",
      unlimited: false, creditsIncluded: 1000, creditsRemaining: 400, creditsUsed: 600,
      usagePct: 60, level: "ok", overageUsed: 0,
    },
  ],
};

function renderOps() {
  apiRequest.mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) });
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, queryFn: async () => DATA } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <BillingOps />
    </QueryClientProvider>,
  );
}

beforeEach(() => { apiRequest.mockReset(); toast.mockReset(); });

describe("BillingOps - staged plan/state changes", () => {
  it("selecting a plan stages it (no POST) and shows the confirm strip naming tenant and plan", async () => {
    renderOps();
    const sel = await screen.findByTestId("plan-sel-1");
    fireEvent.change(sel, { target: { value: "growth" } });
    expect(apiRequest).not.toHaveBeenCalled(); // selection alone never mutates
    const strip = screen.getByTestId("confirm-strip-1");
    expect(strip).toHaveTextContent("Change Acme Fiber to Growth?");
    expect((sel as HTMLSelectElement).value).toBe("growth"); // staged value shown
  });

  it("POST fires only on Confirm, with the staged plan", async () => {
    renderOps();
    fireEvent.change(await screen.findByTestId("plan-sel-1"), { target: { value: "growth" } });
    fireEvent.click(screen.getByTestId("confirm-apply-1"));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("POST", "/api/billing/plan", { tenantId: 1, planKey: "growth" }),
    );
    expect(apiRequest).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByTestId("confirm-strip-1")).toBeNull());
  });

  it("Cancel reverts the select to the server value and never POSTs", async () => {
    renderOps();
    const sel = (await screen.findByTestId("state-sel-1")) as HTMLSelectElement;
    fireEvent.change(sel, { target: { value: "suspended" } });
    expect(sel.value).toBe("suspended"); // staged
    fireEvent.click(screen.getByTestId("confirm-cancel-1"));
    expect(screen.queryByTestId("confirm-strip-1")).toBeNull();
    expect(sel.value).toBe("active"); // back to the server truth
    expect(apiRequest).not.toHaveBeenCalled();
  });

  it("suspend/cancel states get a rose Confirm; the state POST carries the staged state", async () => {
    renderOps();
    fireEvent.change(await screen.findByTestId("state-sel-1"), { target: { value: "canceled" } });
    const confirm = screen.getByTestId("confirm-apply-1");
    expect(confirm.className).toMatch(/rose/);
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("POST", "/api/billing/state", { tenantId: 1, state: "canceled" }),
    );
  });

  it("a routine state change (not suspend/cancel) keeps the non-destructive confirm", async () => {
    renderOps();
    fireEvent.change(await screen.findByTestId("state-sel-1"), { target: { value: "past_due" } });
    expect(screen.getByTestId("confirm-strip-1")).toHaveTextContent("Change Acme Fiber to past due?");
    expect(screen.getByTestId("confirm-apply-1").className).not.toMatch(/rose/);
  });

  it("the selects and the credits input carry tenant-named aria-labels (audit finding)", async () => {
    renderOps();
    expect(await screen.findByTestId("plan-sel-1")).toHaveAttribute("aria-label", "Change plan for Acme Fiber");
    expect(screen.getByTestId("state-sel-1")).toHaveAttribute("aria-label", "Change billing state for Acme Fiber");
    expect(screen.getByTestId("grant-input-1")).toHaveAttribute("aria-label", "Credits to grant to Acme Fiber");
  });
});
