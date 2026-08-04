// ── The delete-an-area dialog's contract ─────────────────────────────────────
//
// The reported bug was invisible in the UI as much as in the DB: deleting an
// area kept its doors on the rep, and the dialog told the manager that was the
// safe outcome. Now the rep assignment goes with the area by DEFAULT, keeping it
// is a visible choice, and the toast names who lost what.
//
// So this pins four things:
//   1. the default sent to the server is repAssignments=clear;
//   2. "keep" is reachable and actually changes the request;
//   3. the consequence copy tracks the choice — it can never describe an
//      outcome the request will not produce;
//   4. success is reported only after the server confirms the cleanup, naming
//      the rep whose doors were freed.
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

import { AreaDeleteDialog, type AreaDeleteTarget } from "../../client/src/components/AreaDeleteDialog";

const TARGET: AreaDeleteTarget = { id: 42, name: "Maple Ridge", total: 84, sold: 6, repName: "Talal" };

function mockDelete(over: Record<string, unknown> = {}) {
  apiRequest.mockImplementation((method: string, url: string) => {
    if (method === "DELETE" && url.startsWith("/api/territories/42")) {
      return Promise.resolve({
        json: () => Promise.resolve({
          success: true, detached: 84, repAssignments: "clear",
          repCleared: 84, clearedRepNames: ["Talal"], ...over,
        }),
      });
    }
    return Promise.reject(new Error(`unexpected ${method} ${url}`));
  });
}

function renderDialog(target: AreaDeleteTarget | null = TARGET) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onOpenChange = vi.fn();
  const onDeleted = vi.fn();
  const utils = render(
    <QueryClientProvider client={qc}>
      <AreaDeleteDialog target={target} open onOpenChange={onOpenChange} onDeleted={onDeleted} />
    </QueryClientProvider>,
  );
  return { ...utils, onOpenChange, onDeleted, qc };
}

beforeEach(() => { apiRequest.mockReset(); toast.mockReset(); });

describe("AreaDeleteDialog", () => {
  it("makes the blast radius concrete — the door count and the sales that survive", () => {
    mockDelete();
    renderDialog();
    expect(screen.getByTestId("area-delete-consequence")).toHaveTextContent("84");
    expect(screen.getByTestId("area-delete-dialog")).toHaveTextContent("6 sales recorded here stay on the books");
    expect(screen.getByTestId("area-delete-dialog")).toHaveTextContent("Delete Maple Ridge?");
  });

  it("DEFAULTS to clearing the rep — the fix for doors that stayed on Talal", async () => {
    mockDelete();
    renderDialog();
    expect(screen.getByTestId("area-delete-policy-clear")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("area-delete-policy-keep")).toHaveAttribute("aria-checked", "false");

    fireEvent.click(screen.getByTestId("area-delete-confirm"));
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith(
      "DELETE", "/api/territories/42?repAssignments=clear", undefined,
    ));
  });

  it("names the rep who loses the doors, in the option itself", () => {
    mockDelete();
    renderDialog();
    expect(screen.getByTestId("area-delete-policy-clear")).toHaveTextContent("Talal stops seeing them");
    expect(screen.getByTestId("area-delete-policy-keep")).toHaveTextContent("Keep them with Talal");
  });

  it("a CREW area still clears everyone — the count is doors, the names are reps", async () => {
    // The rule does not care how many reps are on the ground: deleting unassigns
    // every door in the area from whoever holds it.
    mockDelete({ detached: 90, repCleared: 90, clearedRepNames: ["Talal", "Bo"] });
    renderDialog({ ...TARGET, total: 90, repName: "Talal +1" });
    fireEvent.click(screen.getByTestId("area-delete-confirm"));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast.mock.calls[0][0].description)
      .toBe("90 doors left the area. 90 doors were unassigned from Talal and Bo.");
  });

  it("'keep' is reachable and really does change the request", async () => {
    mockDelete({ repAssignments: "keep", repCleared: 0, clearedRepNames: [] });
    renderDialog();
    fireEvent.click(screen.getByTestId("area-delete-policy-keep"));
    expect(screen.getByTestId("area-delete-policy-keep")).toHaveAttribute("aria-checked", "true");

    fireEvent.click(screen.getByTestId("area-delete-confirm"));
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith(
      "DELETE", "/api/territories/42?repAssignments=keep", undefined,
    ));
  });

  it("the consequence copy tracks the choice — it never describes the other outcome", () => {
    mockDelete();
    renderDialog();
    // Default: back to the pool, no mention of keeping a rep.
    expect(screen.getByTestId("area-delete-consequence")).toHaveTextContent("go back to the pool");
    expect(screen.queryByTestId("area-delete-holder-warning")).toBeNull();

    fireEvent.click(screen.getByTestId("area-delete-policy-keep"));
    expect(screen.getByTestId("area-delete-consequence")).toHaveTextContent("keep the rep working them");
    // The line that costs somebody their morning belongs to "keep" alone.
    expect(screen.getByTestId("area-delete-holder-warning"))
      .toHaveTextContent("Talal will still have these doors with no area to explain them");
  });

  it("reports success only AFTER the server confirms, and says who was freed", async () => {
    mockDelete();
    const { onOpenChange, onDeleted } = renderDialog();

    fireEvent.click(screen.getByTestId("area-delete-confirm"));
    // Nothing is announced on the click itself.
    expect(toast).not.toHaveBeenCalled();

    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    expect(toast.mock.calls[0][0]).toMatchObject({ title: "Deleted Maple Ridge" });
    expect(toast.mock.calls[0][0].description)
      .toBe("84 doors left the area. 84 doors were unassigned from Talal.");
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onDeleted).toHaveBeenCalledWith(TARGET);
  });

  it("lists several freed reps in plain language", async () => {
    mockDelete({ repCleared: 40, clearedRepNames: ["Talal", "Bo", "Cam"] });
    renderDialog();
    fireEvent.click(screen.getByTestId("area-delete-confirm"));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast.mock.calls[0][0].description).toContain("Talal, Bo and Cam");
  });

  it("an area whose doors were nobody's says so instead of implying a rep lost them", async () => {
    mockDelete({ repCleared: 0, clearedRepNames: [] });
    renderDialog();
    fireEvent.click(screen.getByTestId("area-delete-confirm"));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast.mock.calls[0][0].description)
      .toBe("84 doors went back to no area. None were assigned to a rep through it.");
  });

  it("an empty area says it had no doors", async () => {
    mockDelete({ detached: 0, repCleared: 0, clearedRepNames: [] });
    renderDialog();
    fireEvent.click(screen.getByTestId("area-delete-confirm"));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast.mock.calls[0][0].description).toBe("It had no doors in it.");
  });

  it("a failed delete reports the error and does NOT claim the area is gone", async () => {
    apiRequest.mockRejectedValue(new Error("403: not allowed"));
    const { onOpenChange, onDeleted } = renderDialog();
    fireEvent.click(screen.getByTestId("area-delete-confirm"));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast.mock.calls[0][0]).toMatchObject({ title: "Couldn't delete the area", variant: "destructive" });
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it("invalidates the surfaces that count areas AND the ones built from assigned doors", async () => {
    mockDelete();
    const { qc } = renderDialog();
    const spy = vi.spyOn(qc, "invalidateQueries");
    fireEvent.click(screen.getByTestId("area-delete-confirm"));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    const keys = spy.mock.calls.map(c => String((c[0] as any).queryKey[0]));
    for (const k of ["/api/territories", "/api/territories/progress", "/api/leads", "/api/leads/map", "/api/calling/queue"]) {
      expect(keys).toContain(k);
    }
  });

  it("an area in the pool still offers the choice, without inventing a rep name", () => {
    mockDelete();
    renderDialog({ ...TARGET, repName: null });
    expect(screen.getByTestId("area-delete-policy-clear")).toHaveTextContent("Clear the rep too");
    expect(screen.getByTestId("area-delete-policy-keep")).toHaveTextContent("Keep them with their rep");
    expect(screen.getByTestId("area-delete-dialog")).not.toHaveTextContent("Talal");
  });
});
