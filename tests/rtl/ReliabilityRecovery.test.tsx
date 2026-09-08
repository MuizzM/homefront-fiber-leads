import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => vi.fn());
vi.mock("@/lib/queryClient", () => ({ apiRequest: (...args: unknown[]) => api(...args) }));
import { ReliabilityRecovery } from "../../client/src/components/ReliabilityRecovery";
import { AssignmentRecovery } from "../../client/src/components/AssignmentRecovery";

const financial = { id: "87", category: "financial", status: "blocked", attempts: 5, at: "2026-09-08T12:00:00Z", eventType: "SALE_APPROVED", guidance: "Review effects before retrying.", replayable: true };
let recovery: any, operations: any[];
function mount(component: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>{component}</QueryClientProvider>);
}
beforeEach(() => {
  recovery = { enabled: true, canManage: true, scannerMonitoringEnabled: false, assignments: { operations: 1, replays: 2 }, queue: [], items: [financial], scanners: [], pendingAssignments: [] };
  operations = [];
  api.mockReset(); api.mockImplementation(async (method, url) => ({ json: async () => url === "/api/reliability/recovery" ? recovery : url === "/api/leads/assignment-operations" ? { operations } : { ok: true } }));
});
it("sets financial work aside without claiming it was handled, focuses the reason and retains the review row", async () => {
  mount(<ReliabilityRecovery />);
  const trigger = await screen.findByRole("button", { name: "Set aside" }); fireEvent.click(trigger);
  expect(screen.getByRole("textbox", { name: "Reason (required)" })).toHaveFocus();
  const form = screen.getByRole("button", { name: "Confirm set aside" }).closest("form")!;
  expect(within(form).getByText("Financial event #87")).toBeInTheDocument();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Reviewed event history" } });
  recovery = { ...recovery, items: [{ ...financial, status: "dead_lettered" }] };
  fireEvent.click(screen.getByRole("button", { name: "Confirm set aside" }));
  await waitFor(() => expect(api).toHaveBeenCalledWith("POST", "/api/commission/queue/events/87/action", { reason: "Reviewed event history", action: "DEAD_LETTER" }));
  expect(await screen.findByText("dead_lettered")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Replay" })).toBeInTheDocument();
});
it("keeps the reason and recovery row when a mutation fails", async () => {
  api.mockImplementation(async (method) => {
    if (method === "POST") throw new Error("Queue is busy");
    return { json: async () => recovery };
  });
  mount(<ReliabilityRecovery />); fireEvent.click(await screen.findByRole("button", { name: "Replay" }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Confirmed recovery cause" } });
  fireEvent.click(screen.getByRole("button", { name: "Confirm replay" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Queue is busy");
  expect(screen.getByRole("textbox")).toHaveValue("Confirmed recovery cause");
  expect(screen.getByRole("rowheader")).toHaveTextContent("Financial event #87");
});
it("identifies otherwise identical interrupted assignments before stopping one", async () => {
  recovery.items = [];
  recovery.pendingAssignments = ["operation-one", "operation-two"].map((id, index) => ({ id, actorUserId: index + 2, repId: 9, createdAt: Date.now(), state: "running", updated: 500, total: 1000 }));
  mount(<ReliabilityRecovery />);
  const buttons = await screen.findAllByRole("button", { name: "Stop remaining work" }); fireEvent.click(buttons[1]);
  const form = screen.getByRole("button", { name: "Confirm stop" }).closest("form")!;
  expect(within(form).getByText("Assignment operation-two · actor #3")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(buttons[1]).toHaveFocus();
});
it("shows no action controls to read-only reviewers or replay for a passed cursor", async () => {
  recovery.canManage = false; recovery.items = [{ ...financial, replayable: false }];
  mount(<ReliabilityRecovery />); await screen.findByRole("rowheader");
  expect(screen.queryByRole("button", { name: "Replay" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Set aside" })).not.toBeInTheDocument();
});
it("reports a stopped assignment receipt as stopped rather than as an undo", async () => {
  operations = [{ id: "resume-one", state: "running", total: 1000, updated: 500, createdAt: new Date().toISOString(), restored: 0, skipped: 0, repId: 9, result: null }];
  api.mockImplementation(async method => ({ json: async () => method === "GET" ? { operations } : { state: "cancelled", updated: 500, restored: 0, skipped: 500 } }));
  mount(<AssignmentRecovery />); fireEvent.click(await screen.findByRole("button", { name: "Continue assignment" }));
  expect(await screen.findByText("Remaining work was stopped. 500 doors were updated before it stopped.")).toBeInTheDocument();
  expect(screen.queryByText(/Put back 0 doors/)).not.toBeInTheDocument();
});
it("shows an unknown state with a retry when history could not load", async () => {
  api.mockRejectedValue(new Error("Offline")); mount(<AssignmentRecovery />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Its status is unknown");
  expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
});
