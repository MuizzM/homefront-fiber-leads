// The org-wide sweep's safety contract, pinned.
//
// The dialog must (1) state the exact blast radius from the areas it's shown,
// (2) keep the destructive button DISARMED until the operator types RECLAIM,
// (3) send the chosen mode to POST /api/territories/reclaim-all, and (4) go
// inert when there is nothing to reclaim. This is the difference between a
// bulk action an admin trusts and one they fear.
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

import { ReclaimAllDialog } from "../../client/src/components/territory/ReclaimAllDialog";

const AREAS = [
  { id: 1, repIds: [11], status: "active" },
  { id: 2, repIds: [11, 12], status: "shared" },
  { id: 3, repIds: [], status: "unassigned" },      // pool — not counted
  { id: 4, repIds: [13], status: "archived" },      // archived — not counted
];
const NAMES = { 11: "Rep Ann", 12: "Rep Bo", 13: "Rep Cy" };

function renderDialog(over: Partial<React.ComponentProps<typeof ReclaimAllDialog>> = {}) {
  apiRequest.mockResolvedValue({ json: () => Promise.resolve({ ok: true, reclaimed: 2, repsAffected: 2, leadsAffected: 5 }) });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = vi.fn();
  const utils = render(
    <QueryClientProvider client={qc}>
      <ReclaimAllDialog open onClose={onClose} areas={AREAS} teamNames={NAMES} {...over} />
    </QueryClientProvider>,
  );
  return { ...utils, onClose };
}

beforeEach(() => { apiRequest.mockReset(); toast.mockReset(); });

describe("reclaim-all safety contract", () => {
  it("states the exact blast radius - held areas only, pool and archived excluded", () => {
    renderDialog();
    expect(screen.getByTestId("reclaim-all-area-count").textContent).toBe("2");
    expect(screen.getByTestId("reclaim-all-rep-count").textContent).toBe("2");
    expect(screen.getByTestId("reclaim-all-impact").textContent).toContain("Rep Ann");
  });

  it("keeps the destructive button disarmed until the operator types RECLAIM", () => {
    renderDialog();
    const submit = screen.getByTestId("reclaim-all-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("reclaim-all-confirm-input"), { target: { value: "reclaim" } });
    expect(submit.disabled).toBe(false); // case-insensitive, but must be the word
    fireEvent.change(screen.getByTestId("reclaim-all-confirm-input"), { target: { value: "yes" } });
    expect(submit.disabled).toBe(true);
  });

  it("sends the chosen mode and closes on success", async () => {
    const { onClose } = renderDialog();
    fireEvent.click(screen.getByTestId("reclaim-all-mode-keep_leads"));
    fireEvent.change(screen.getByTestId("reclaim-all-confirm-input"), { target: { value: "RECLAIM" } });
    fireEvent.click(screen.getByTestId("reclaim-all-submit"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(apiRequest).toHaveBeenCalledWith("POST", "/api/territories/reclaim-all", { mode: "keep_leads" });
    expect(toast).toHaveBeenCalled();
  });

  it("goes inert when nothing is held - no typed confirm, button disabled", () => {
    renderDialog({ areas: [{ id: 3, repIds: [], status: "unassigned" }] });
    expect(screen.getByTestId("reclaim-all-impact").textContent).toContain("nothing to reclaim");
    expect(screen.queryByTestId("reclaim-all-confirm-input")).toBeNull();
    expect((screen.getByTestId("reclaim-all-submit") as HTMLButtonElement).disabled).toBe(true);
  });

  it("renders nothing at all when closed", () => {
    renderDialog({ open: false });
    expect(screen.queryByTestId("reclaim-all-dialog")).toBeNull();
  });
});

// ── Territory-UI audit: close paths and stale armed state ────────────────────
// The component stays MOUNTED with open=false, so its state used to survive a
// cancel: type RECLAIM, close, reopen — and the destructive button was already
// live. And Escape, honoured by every sibling modal, did nothing here.
describe("reclaim-all close hygiene", () => {
  it("Escape closes the dialog, like the scrim and Cancel", () => {
    const { onClose } = renderDialog();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("no armed confirmation survives a cancel - reopening starts disarmed", () => {
    apiRequest.mockResolvedValue({ json: () => Promise.resolve({ ok: true, reclaimed: 2, repsAffected: 2, leadsAffected: 5 }) });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onClose = vi.fn();
    const ui = (open: boolean) => (
      <QueryClientProvider client={qc}>
        <ReclaimAllDialog open={open} onClose={onClose} areas={AREAS} teamNames={NAMES} />
      </QueryClientProvider>
    );
    const { rerender } = render(ui(true));

    fireEvent.change(screen.getByTestId("reclaim-all-confirm-input"), { target: { value: "RECLAIM" } });
    expect((screen.getByTestId("reclaim-all-submit") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId("reclaim-all-cancel"));
    expect(onClose).toHaveBeenCalledOnce();

    rerender(ui(false));
    rerender(ui(true));
    expect(screen.getByTestId("reclaim-all-confirm-input")).toHaveValue("");
    expect((screen.getByTestId("reclaim-all-submit") as HTMLButtonElement).disabled).toBe(true);
  });

  it("locks every close path while the sweep is committing", async () => {
    apiRequest.mockReturnValue(new Promise(() => {})); // sweep never settles
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onClose = vi.fn();
    render(
      <QueryClientProvider client={qc}>
        <ReclaimAllDialog open onClose={onClose} areas={AREAS} teamNames={NAMES} />
      </QueryClientProvider>,
    );
    fireEvent.change(screen.getByTestId("reclaim-all-confirm-input"), { target: { value: "RECLAIM" } });
    fireEvent.click(screen.getByTestId("reclaim-all-submit"));
    await waitFor(() =>
      expect((screen.getByTestId("reclaim-all-cancel") as HTMLButtonElement).disabled).toBe(true));
    expect((screen.getByTestId("reclaim-all-scrim") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });
});
