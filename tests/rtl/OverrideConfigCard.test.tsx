// ── Override config — the org's rate card for downline pay ───────────────────
//
// Two invariants. Hidden, not zeroed: when the switch is off the rate inputs
// disappear (house style — a disabled program prints nothing, and the saved
// rates survive for the next enable). And the PATCH is EXACT tri-state: enable
// sends the flag plus both rates as integer cents (dollars converted once, at
// the boundary); disable sends ONLY the flag, so absent keys mean "keep".
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";

const apiRequest = vi.fn();
vi.mock("@/lib/queryClient", () => ({
  apiRequest: (...a: any[]) => apiRequest(...a),
  queryClient: undefined,
}));
const toast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));

import { OverrideConfigCard } from "../../client/src/components/OverrideConfigCard";

function config(over: Record<string, unknown> = {}) {
  return {
    overridesEnabled: true,
    overrideBasis: "FLAT_PER_SALE",
    overrideTeamLeadCents: 2500,
    overrideManagerCents: 1000,
    ...over,
  };
}

function renderCard(cfg: any) {
  apiRequest.mockImplementation((method: string, _url: string, body?: any) => {
    if (method === "GET") return Promise.resolve({ json: () => Promise.resolve(cfg) });
    // PATCH echoes the config the server would persist — enough for setQueryData.
    return Promise.resolve({ json: () => Promise.resolve({ ...cfg, ...body }) });
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><OverrideConfigCard /></QueryClientProvider>);
}

const patchCall = () => apiRequest.mock.calls.find(call => call[0] === "PATCH");

beforeEach(() => { apiRequest.mockReset(); toast.mockReset(); });

describe("the override config card", () => {
  it("shows the saved rates in dollars while enabled, and names the fixed basis", async () => {
    renderCard(config());
    await waitFor(() => expect(screen.getByTestId("override-rate-inputs")).toBeInTheDocument());
    expect((screen.getByTestId("override-teamlead-input") as HTMLInputElement).value).toBe("25.00");
    expect((screen.getByTestId("override-manager-input") as HTMLInputElement).value).toBe("10.00");
    // PERCENT_OF_COMMISSION is refused server-side, so the UI states the basis
    // as a fact rather than offering a choice.
    expect(screen.getByTestId("override-config-card").textContent).toMatch(/Flat per sale/i);
  });

  it("flipping the switch off HIDES the rate inputs — hide, don't print zeros", async () => {
    renderCard(config());
    await waitFor(() => expect(screen.getByTestId("override-rate-inputs")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("override-enabled-switch"));
    expect(screen.queryByTestId("override-rate-inputs")).toBeNull();
    expect(screen.queryByTestId("override-teamlead-input")).toBeNull();
  });

  it("starts with no rate inputs at all when the org has overrides off", async () => {
    renderCard(config({ overridesEnabled: false }));
    await waitFor(() => expect(screen.getByTestId("override-config-card")).toBeInTheDocument());
    expect(screen.queryByTestId("override-rate-inputs")).toBeNull();
  });

  it("saving an enable PATCHes the exact tri-state body — flag plus both rates in integer cents", async () => {
    renderCard(config({ overridesEnabled: false, overrideTeamLeadCents: 0, overrideManagerCents: 0 }));
    await waitFor(() => expect(screen.getByTestId("override-config-card")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("override-enabled-switch"));
    fireEvent.change(screen.getByTestId("override-teamlead-input"), { target: { value: "25" } });
    fireEvent.change(screen.getByTestId("override-manager-input"), { target: { value: "10.50" } });
    fireEvent.click(screen.getByTestId("override-config-save"));

    await waitFor(() => expect(patchCall()).toBeTruthy());
    expect(patchCall()![1]).toBe("/api/commission/config");
    // toEqual, not toMatchObject: no extra keys may ride along — the config
    // schema treats every present key as an instruction.
    expect(patchCall()![2]).toEqual({
      overridesEnabled: true,
      overrideTeamLeadCents: 2500,
      overrideManagerCents: 1050,
    });
  });

  it("saving a disable sends ONLY the flag, so the saved rates survive", async () => {
    renderCard(config());
    await waitFor(() => expect(screen.getByTestId("override-rate-inputs")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("override-enabled-switch"));
    fireEvent.click(screen.getByTestId("override-config-save"));

    await waitFor(() => expect(patchCall()).toBeTruthy());
    expect(patchCall()![2]).toEqual({ overridesEnabled: false });
  });

  it("the save button stays disarmed until something is actually edited", async () => {
    renderCard(config());
    await waitFor(() => expect(screen.getByTestId("override-rate-inputs")).toBeInTheDocument());
    expect(screen.getByTestId("override-config-save")).toBeDisabled();
    fireEvent.change(screen.getByTestId("override-teamlead-input"), { target: { value: "30" } });
    expect(screen.getByTestId("override-config-save")).not.toBeDisabled();
  });
});
