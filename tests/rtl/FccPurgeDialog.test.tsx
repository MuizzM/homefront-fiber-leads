// The FCC-purge dialog's safety contract, pinned.
//
// Same grammar as ReclaimAllDialog: (1) state the exact blast radius from the
// server preview (total / removable / protected), (2) keep the destructive
// button DISARMED until the operator types REMOVE, (3) POST once and
// invalidate every lead surface, (4) go inert when nothing is removable, and
// (5) lock every close path while the purge is committing.
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

import { FccPurgeDialog } from "../../client/src/components/map/FccPurgeDialog";

const PREVIEW = { total: 120, removable: 90, protected: 30 };

function mockApi(over: { preview?: any; purge?: any } = {}) {
  apiRequest.mockImplementation((method: string, url: string) => {
    if (method === "GET" && url === "/api/leads/fcc-purge/preview") {
      return Promise.resolve({ json: () => Promise.resolve(over.preview ?? PREVIEW) });
    }
    if (method === "POST" && url === "/api/leads/fcc-purge") {
      return Promise.resolve({ json: () => Promise.resolve(over.purge ?? { removed: 90 }) });
    }
    return Promise.reject(new Error(`unexpected ${method} ${url}`));
  });
}

function renderDialog(over: Partial<React.ComponentProps<typeof FccPurgeDialog>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = vi.fn();
  const utils = render(
    <QueryClientProvider client={qc}>
      <FccPurgeDialog open onClose={onClose} {...over} />
    </QueryClientProvider>,
  );
  return { ...utils, onClose, qc };
}

beforeEach(() => { apiRequest.mockReset(); toast.mockReset(); });

describe("fcc-purge safety contract", () => {
  it("states the exact blast radius from the server preview — total, removable, protected", async () => {
    mockApi();
    renderDialog();
    await waitFor(() => expect(screen.getByTestId("fcc-purge-total").textContent).toBe("120"));
    expect(screen.getByTestId("fcc-purge-removable").textContent).toBe("90");
    expect(screen.getByTestId("fcc-purge-protected").textContent).toBe("30");
    expect(apiRequest).toHaveBeenCalledWith("GET", "/api/leads/fcc-purge/preview");
  });

  it("keeps the destructive button disarmed until the operator types REMOVE", async () => {
    mockApi();
    renderDialog();
    await waitFor(() => expect(screen.getByTestId("fcc-purge-removable")).toBeInTheDocument());
    const submit = screen.getByTestId("fcc-purge-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("fcc-purge-confirm-input"), { target: { value: "remove" } });
    expect(submit.disabled).toBe(false); // case-insensitive, but must be the word
    fireEvent.change(screen.getByTestId("fcc-purge-confirm-input"), { target: { value: "yes" } });
    expect(submit.disabled).toBe(true);
  });

  it("POSTs once, toasts the removed count, invalidates every lead surface, and closes", async () => {
    mockApi();
    const { onClose, qc } = renderDialog();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    await waitFor(() => expect(screen.getByTestId("fcc-purge-confirm-input")).toBeInTheDocument());
    fireEvent.change(screen.getByTestId("fcc-purge-confirm-input"), { target: { value: "REMOVE" } });
    fireEvent.click(screen.getByTestId("fcc-purge-submit"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(apiRequest).toHaveBeenCalledWith("POST", "/api/leads/fcc-purge", {});
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Removed 90 FCC leads" }));
    for (const key of ["/api/leads/map", "/api/leads", "/api/stats", "/api/leads/map/count", "/api/leads/map/grid"]) {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: [key] });
    }
  });

  it("goes inert when nothing is removable — no typed confirm, button disabled", async () => {
    mockApi({ preview: { total: 5, removable: 0, protected: 5 } });
    renderDialog();
    await waitFor(() => expect(screen.getByTestId("fcc-purge-removable").textContent).toBe("0"));
    expect(screen.queryByTestId("fcc-purge-confirm-input")).toBeNull();
    expect((screen.getByTestId("fcc-purge-submit") as HTMLButtonElement).disabled).toBe(true);
  });

  it("a failed preview reads loudly and never arms", async () => {
    apiRequest.mockRejectedValue(new Error("boom"));
    renderDialog();
    await waitFor(() => expect(screen.getByTestId("fcc-purge-preview-error")).toBeInTheDocument());
    expect(screen.queryByTestId("fcc-purge-confirm-input")).toBeNull();
    expect((screen.getByTestId("fcc-purge-submit") as HTMLButtonElement).disabled).toBe(true);
  });

  it("renders nothing at all when closed", () => {
    mockApi();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <FccPurgeDialog open={false} onClose={vi.fn()} />
      </QueryClientProvider>,
    );
    expect(screen.queryByTestId("fcc-purge-dialog")).toBeNull();
    expect(apiRequest).not.toHaveBeenCalled(); // enabled: open — no eager preview
  });
});

describe("fcc-purge close hygiene", () => {
  it("Escape closes, like the scrim and Cancel — and no armed state survives a reopen", async () => {
    mockApi();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onClose = vi.fn();
    const ui = (open: boolean) => (
      <QueryClientProvider client={qc}>
        <FccPurgeDialog open={open} onClose={onClose} />
      </QueryClientProvider>
    );
    const { rerender } = render(ui(true));
    await waitFor(() => expect(screen.getByTestId("fcc-purge-confirm-input")).toBeInTheDocument());
    fireEvent.change(screen.getByTestId("fcc-purge-confirm-input"), { target: { value: "REMOVE" } });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();

    rerender(ui(false));
    rerender(ui(true));
    await waitFor(() => expect(screen.getByTestId("fcc-purge-confirm-input")).toBeInTheDocument());
    expect(screen.getByTestId("fcc-purge-confirm-input")).toHaveValue("");
    expect((screen.getByTestId("fcc-purge-submit") as HTMLButtonElement).disabled).toBe(true);
  });

  it("locks every close path while the purge is committing", async () => {
    apiRequest.mockImplementation((method: string) =>
      method === "GET"
        ? Promise.resolve({ json: () => Promise.resolve(PREVIEW) })
        : new Promise(() => {})); // purge never settles
    const { onClose } = renderDialog();
    await waitFor(() => expect(screen.getByTestId("fcc-purge-confirm-input")).toBeInTheDocument());
    fireEvent.change(screen.getByTestId("fcc-purge-confirm-input"), { target: { value: "REMOVE" } });
    fireEvent.click(screen.getByTestId("fcc-purge-submit"));
    await waitFor(() =>
      expect((screen.getByTestId("fcc-purge-cancel") as HTMLButtonElement).disabled).toBe(true));
    expect((screen.getByTestId("fcc-purge-scrim") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });
});
