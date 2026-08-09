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

function renderDrawer(onClose = vi.fn()) {
  apiRequest.mockImplementation((method: string) => {
    if (method === "GET") return Promise.resolve({ json: () => Promise.resolve(RESPONSE) });
    return Promise.resolve({ json: () => Promise.resolve({ ok: true }) });
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={qc}>
      <TerritoryActivityDrawer territoryId={5} onClose={onClose} />
    </QueryClientProvider>,
  );
  return { ...utils, onClose };
}

async function openOverrideRow() {
  const row = await screen.findByTestId("activity-row");
  fireEvent.click(within(row).getByText("148 Maple St")); // expand the audit record
  fireEvent.click(screen.getByTestId("override-btn"));
  return screen.getByTestId("override-confirm-row");
}

beforeEach(() => { apiRequest.mockReset(); toast.mockReset(); });

describe("territory activity - admin override inline confirm", () => {
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

// ── Drawer chrome: every control wired, none sub-44px ────────────────────────
describe("territory activity - drawer chrome", () => {
  it("the close button is wired to onClose", async () => {
    const { onClose } = renderDrawer();
    await screen.findByTestId("activity-row");
    fireEvent.click(screen.getByTestId("close-activity"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("export builds a CSV from the visible rows", async () => {
    // jsdom has no object-URL support; provide it just for this test.
    const createObjectURL = vi.fn(() => "blob:activity");
    const revokeObjectURL = vi.fn();
    (URL as any).createObjectURL = createObjectURL;
    (URL as any).revokeObjectURL = revokeObjectURL;
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    try {
      renderDrawer();
      await screen.findByTestId("activity-row");
      fireEvent.click(screen.getByTestId("export-activity"));
      expect(createObjectURL).toHaveBeenCalledOnce();
      const blob = createObjectURL.mock.calls[0][0] as Blob;
      expect(blob.type).toBe("text/csv");
      expect(blob.size).toBeGreaterThan(0); // header row + the visible activity
      expect(anchorClick).toHaveBeenCalledOnce();
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:activity");
    } finally {
      anchorClick.mockRestore();
      delete (URL as any).createObjectURL;
      delete (URL as any).revokeObjectURL;
    }
  });

  it("status filters narrow the list and All restores it", async () => {
    renderDrawer();
    await screen.findByTestId("activity-row");
    fireEvent.click(screen.getByTestId("filter-verified"));
    expect(screen.queryByTestId("activity-row")).toBeNull();
    expect(screen.getByText(/no activity matching/i)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("filter-needs_review"));
    expect(screen.getByTestId("activity-row")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("filter-all"));
    expect(screen.getByTestId("activity-row")).toBeInTheDocument();
  });

  it("the active filter is announced, not colour-coded alone", async () => {
    renderDrawer();
    await screen.findByTestId("activity-row");
    expect(screen.getByTestId("filter-all")).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByTestId("filter-invalid"));
    expect(screen.getByTestId("filter-invalid")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("filter-all")).toHaveAttribute("aria-pressed", "false");
  });

  it("header, filter and sort controls meet the 44px bar (audit: h-7/h-8 flagged)", async () => {
    renderDrawer();
    await screen.findByTestId("activity-row");
    expect(screen.getByTestId("export-activity").className).toMatch(/\bh-11\b/);
    expect(screen.getByTestId("export-activity")).toHaveAccessibleName(/export/i);
    expect(screen.getByTestId("close-activity").className).toMatch(/\bh-11\b/);
    expect(screen.getByTestId("filter-all").className).toMatch(/min-h-11/);
    expect(screen.getByRole("combobox", { name: "Sort activities" }).className).toMatch(/\bh-11\b/);
  });

  // ── Territory-UI audit: every exit works ──────────────────────────────────
  it("Escape closes the drawer, matching the scrim tap and the X", async () => {
    const { onClose } = renderDrawer();
    await screen.findByTestId("activity-row");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
