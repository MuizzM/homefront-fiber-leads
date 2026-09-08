// The command center's client contract: the server's rule text renders
// verbatim (what the manager reads is what ran), every row carries its
// reason, bulk assign posts the selected ids to the EXISTING bulk-assign
// seam and surfaces the undo, and dismissing demands a reason through the
// shared dialog.
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";

const authFixture = vi.hoisted(() => ({ role: "manager" }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { id: 1, name: "Mara", role: authFixture.role } }) }));
const toast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));

const apiRequest = vi.fn();
vi.mock("@/lib/queryClient", () => ({ apiRequest: (...a: any[]) => apiRequest(...a), apiRequestIdempotent: (...a: any[]) => apiRequest(...a) }));

// Radix Select needs pointer-capture APIs jsdom lacks (house shim, same as
// AddLeadSheet.test.tsx).
{
  const proto = window.HTMLElement.prototype as any;
  if (!proto.hasPointerCapture) proto.hasPointerCapture = () => false;
  if (!proto.setPointerCapture) proto.setPointerCapture = () => {};
  if (!proto.releasePointerCapture) proto.releasePointerCapture = () => {};
  if (!proto.scrollIntoView) proto.scrollIntoView = () => {};
}

import Ops from "../../client/src/pages/Ops";

const OVERVIEW = {
  queues: [
    { key: "assigned_unworked", label: "Assigned but not worked", rule: "Assigned more than 48 hours ago with no recorded door activity since the assignment, and still in an active status.", count: 2, managerOnly: false, dismissible: true },
    { key: "followups_overdue", label: "Overdue follow-ups", rule: "The lead's most recent door visit scheduled a return date that has passed (org-local calendar), and the lead is still in an active status.", count: 0, managerOnly: false, dismissible: true },
  ],
};
const WORKLOAD = {
  rule: "Active leads, unworked assignments, and overdue follow-ups per rep in your scope - a distribution to balance by eye, not a capacity score (no per-rep lead capacity is configured anywhere).",
  rows: [
    { repId: 6, name: "Dana Doors", onShift: true, activeLeads: 12, unworked: 3, overdueFollowUps: 1, areasHeld: 2, areaCap: 5, lastActivityAt: new Date().toISOString() },
  ],
};
const QUEUE = {
  key: "assigned_unworked", label: "Assigned but not worked",
  rule: OVERVIEW.queues[0].rule, total: 2, limit: 200, entityKind: "lead", dismissible: true,
  rows: [
    { id: 11, address: "11 Ops Court", city: "Rockwell", state: "NC", leadStatus: "prospect", assignedRepId: 6, repName: "Dana Doors", assignedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(), lastOutcomeAt: null, leadScore: 0, buyerScore: null, reason: "No door activity has ever been recorded on this lead." },
    { id: 12, address: "12 Ops Court", city: "Rockwell", state: "NC", leadStatus: "contacted", assignedRepId: 6, repName: "Dana Doors", assignedAt: new Date(Date.now() - 4 * 86_400_000).toISOString(), lastOutcomeAt: null, leadScore: 0, buyerScore: null, reason: "No door activity has ever been recorded on this lead." },
  ],
};

function json(body: unknown) { return Promise.resolve({ json: () => Promise.resolve(body) }); }

beforeEach(() => {
  authFixture.role = "manager";
  apiRequest.mockReset();
  toast.mockReset();
  apiRequest.mockImplementation((method: string, url: string) => {
    if (url.startsWith("/api/ops/overview")) return json(OVERVIEW);
    if (url.startsWith("/api/ops/workload")) return json(WORKLOAD);
    if (url.startsWith("/api/ops/queue/")) return json(QUEUE);
    if (url === "/api/leads/assignment-operations") return json({ operations: [] });
    if (url === "/api/leads/bulk-assign") return json({ updated: 2, skipped: 0, undoToken: "tok-1", undoExpiresAt: new Date(Date.now() + 600_000).toISOString() });
    if (url === "/api/ops/dismiss") return json({ ok: true });
    return json({});
  });
});

function renderOps() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><Ops /></QueryClientProvider>);
}

describe("<Ops />", () => {
  it("does not request assignment history for an allowed Ops role without lead.assign", async () => {
    authFixture.role = "calling_manager"; renderOps();
    await screen.findByTestId("ops-rule");
    expect(apiRequest.mock.calls.some(([, url]) => url === "/api/leads/assignment-operations")).toBe(false);
  });
  it("renders the server's rule verbatim with the count and each row's reason", async () => {
    renderOps();
    expect(await screen.findByTestId("ops-rule")).toHaveTextContent("Assigned more than 48 hours ago with no recorded door activity");
    expect(screen.getByTestId("ops-count-assigned_unworked")).toHaveTextContent("2");
    expect((await screen.findAllByText("No door activity has ever been recorded on this lead."))).toHaveLength(2);
  });

  it("select-all then Assign posts the ids to bulk-assign and offers the undo", async () => {
    renderOps();
    await screen.findByTestId("ops-row-11");
    fireEvent.click(screen.getByTestId("ops-select-all"));
    // Rep picker is the searchable dialog picker - open it, click Dana's row
    // (name and load render as separate lines now).
    fireEvent.click(screen.getByTestId("ops-assign-rep"));
    fireEvent.click(await screen.findByTestId("rep-option-6"));
    fireEvent.click(screen.getByTestId("ops-assign"));
    await waitFor(() => {
      expect(apiRequest).toHaveBeenCalledWith("POST", "/api/leads/bulk-assign", { leadIds: [11, 12], repId: 6, opId: expect.any(String) });
    });
    expect(await screen.findByTestId("ops-result")).toHaveTextContent("2 assigned to Dana Doors");
    expect(screen.getByTestId("ops-undo")).toBeInTheDocument();
  });

  it("dismiss demands a reason through the shared dialog before posting", async () => {
    renderOps();
    await screen.findByTestId("ops-row-11");
    fireEvent.click(screen.getByTestId("ops-dismiss-11"));
    const confirm = await screen.findByRole("button", { name: "Dismiss for 30 days" });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "Vacant lot" } });
    fireEvent.click(confirm);
    await waitFor(() => {
      expect(apiRequest).toHaveBeenCalledWith("POST", "/api/ops/dismiss",
        { queue: "assigned_unworked", entityId: 11, reason: "Vacant lot" });
    });
  });

  it("the workload tab shows the distribution and its no-fake-capacity rule", async () => {
    renderOps();
    fireEvent.click(await screen.findByTestId("ops-tab-workload"));
    expect(await screen.findByTestId("ops-workload-table")).toBeInTheDocument();
    expect(screen.getByText(/not a capacity score/)).toBeInTheDocument();
    expect(screen.getByText("Dana Doors")).toBeInTheDocument();
    expect(screen.getByText("On shift")).toBeInTheDocument();
  });
});
