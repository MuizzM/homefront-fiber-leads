// Admin override confirm flow (audit fix): the reason-gated override must be an
// inline in-drawer confirm — window.prompt() is banned. Tapping the override
// action expands a row with a required reason input; Confirm stays disabled
// until a reason is typed and fires the exact same POST the prompt used to.
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { id: 1, name: "Admin", role: "admin" } }) }));
const apiRequest = vi.fn();
vi.mock("@/lib/queryClient", () => ({ apiRequest: (...a: any[]) => apiRequest(...a), queryClient: undefined }));
const toast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));

import { TerritoryActivityDrawer } from "../../client/src/components/TerritoryActivityDrawer";

const RESPONSE = {
  territoryId: 5,
  name: "Rockwell East",
  maxAllowedDistanceM: 75,
  activities: [
    {
      knockId: 101, leadId: 7, leadName: "148 Maple St", address: "148 Maple St, Rockwell NC",
      rep: "Rep Ann", outcome: "not_home", knockedAt: "2026-07-30T18:00:00.000Z",
      deviceTs: null, serverTs: null,
      verification: "needs_review", distanceM: 120, gpsAccuracyM: 10,
      reviewReason: null, netState: null,
      repLat: null, repLng: null, leadLat: null, leadLng: null,
    },
  ],
};

function renderDrawer() {
  apiRequest.mockImplementation((method: string) => {
    if (method === "GET") return Promise.resolve({ json: () => Promise.resolve(RESPONSE) });
    return Promise.resolve({ json: () => Promise.resolve({ ok: true }) });
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TerritoryActivityDrawer territoryId={5} onClose={vi.fn()} />
    </QueryClientProvider>,
  );
}

async function openOverrideRow() {
  const row = await screen.findByTestId("activity-row");
  fireEvent.click(within(row).getByText("148 Maple St")); // expand the audit record
  fireEvent.click(screen.getByTestId("override-btn"));
  return screen.getByTestId("override-confirm-row");
}

beforeEach(() => { apiRequest.mockReset(); toast.mockReset(); });

describe("territory activity — admin override inline confirm", () => {
  it("never calls window.prompt anywhere in the flow", async () => {
    const promptSpy = vi.spyOn(window, "prompt");
    renderDrawer();
    await openOverrideRow();
    fireEvent.change(screen.getByTestId("override-reason-input"), { target: { value: "verified on camera" } });
    fireEvent.click(screen.getByTestId("override-confirm"));
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith("POST", expect.anything(), expect.anything()));
    expect(promptSpy).not.toHaveBeenCalled();
    promptSpy.mockRestore();
  });

  it("expands an inline confirm row with a required reason input (h-11, placeholder)", async () => {
    renderDrawer();
    const confirmRow = await openOverrideRow();
    // The trigger button is replaced by the confirm row.
    expect(screen.queryByTestId("override-btn")).toBeNull();
    expect(confirmRow).toHaveTextContent(/override this activity to/i);
    const input = screen.getByTestId("override-reason-input");
    expect(input).toHaveAttribute("placeholder", "Reason for override");
    expect(input.className).toMatch(/\bh-11\b/);
    expect(input).toHaveAccessibleName(); // aria-label present
  });

  it("keeps Confirm disabled until a non-empty reason is typed", async () => {
    renderDrawer();
    await openOverrideRow();
    const confirm = screen.getByTestId("override-confirm") as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("override-reason-input"), { target: { value: "   " } });
    expect(confirm.disabled).toBe(true); // whitespace is not a reason
    fireEvent.change(screen.getByTestId("override-reason-input"), { target: { value: "GPS drift, verified on camera" } });
    expect(confirm.disabled).toBe(false);
    // No POST until Confirm is actually tapped.
    expect(apiRequest).not.toHaveBeenCalledWith("POST", expect.anything(), expect.anything());
  });

  it("Confirm fires the exact override POST (knock id, target status, trimmed reason)", async () => {
    renderDrawer();
    await openOverrideRow();
    fireEvent.change(screen.getByTestId("override-reason-input"), { target: { value: "  GPS drift, verified on camera  " } });
    fireEvent.click(screen.getByTestId("override-confirm"));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("POST", "/api/knocks/101/override", {
        status: "verified", // needs_review flips toward verified
        reason: "GPS drift, verified on camera",
      }),
    );
    // Success collapses the confirm row back to the trigger button.
    await waitFor(() => expect(screen.queryByTestId("override-confirm-row")).toBeNull());
    expect(toast).toHaveBeenCalled();
  });

  it("Cancel collapses the row without any POST", async () => {
    renderDrawer();
    await openOverrideRow();
    fireEvent.change(screen.getByTestId("override-reason-input"), { target: { value: "typed then thought better" } });
    fireEvent.click(screen.getByTestId("override-cancel"));
    expect(screen.queryByTestId("override-confirm-row")).toBeNull();
    expect(screen.getByTestId("override-btn")).toBeInTheDocument();
    expect(apiRequest).not.toHaveBeenCalledWith("POST", expect.anything(), expect.anything());
  });
});
