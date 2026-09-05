import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiRequest, toast } = vi.hoisted(() => ({ apiRequest: vi.fn(), toast: vi.fn() }));
vi.mock("@/lib/queryClient", () => ({ apiRequest }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { id: 1, name: "Ada Admin", role: "admin", teamMemberId: 100 } }) }));
vi.mock("@/lib/capabilities", () => ({ useCan: () => true }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }), toast }));
import Team from "@/pages/Team";

const rep = { id: 1, name: "Rex Rep", role: "rep", active: true, email: null, phone: null, reportsToId: 100, commissionFlatRateCents: null, commissionStructure: "FLAT", createdAt: "2026-08-01T00:00:00Z" };
const flatPlan = (rateCents: number) => ({ structure: "FLAT", flatRateCents: rateCents, reserve: { repReservePercent: null, repReserveCapCents: null, effectivePercent: 10, effectiveCapCents: 100000 } });
function json(value: unknown) { return Promise.resolve({ json: () => Promise.resolve(value) }); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
let planResponse: ReturnType<typeof json> | undefined;
let planFails = false;
beforeEach(() => {
  apiRequest.mockReset(); toast.mockReset(); planFails = false; planResponse = undefined;
  apiRequest.mockImplementation((_method: string, url: string) => {
    if (url === "/api/commission/reps/1/structure") return planFails ? Promise.reject(new Error("offline")) : planResponse ?? json(flatPlan(15050));
    return json({});
  });
});
function renderTeam(cachedPlan?: ReturnType<typeof flatPlan>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, queryFn: async ({ queryKey }) => queryKey[0] === "/api/team" ? [rep] : [] } } });
  if (cachedPlan) qc.setQueryData(["/api/commission/reps", 1, "structure"], cachedPlan, { updatedAt: 1 });
  render(<QueryClientProvider client={qc}><Team /></QueryClientProvider>);
  return qc;
}
async function openCommission() {
  fireEvent.click(await screen.findByTestId("btn-commission-rep-1"));
  return screen.findByRole("dialog");
}

describe("team commission plan recovery", () => {
  it("cannot replace a plan from defaults after its read fails, then retries with exact cents", async () => {
    planFails = true;
    renderTeam(); const dialog = await openCommission();
    await screen.findByText("Couldn't load the current plan");
    expect(screen.queryByText("No plan assigned yet")).not.toBeInTheDocument();
    expect(screen.getByTestId("btn-save-commission")).toBeDisabled();
    expect(screen.getByTestId("btn-team-structure-flat")).toBeDisabled();
    fireEvent.click(screen.getByTestId("btn-save-commission"));
    expect(apiRequest.mock.calls.some(([method]) => method === "POST")).toBe(false);
    planFails = false;
    fireEvent.click(within(dialog).getByRole("button", { name: /retry/i }));
    const rate = await screen.findByTestId("input-team-flat-rate");
    await waitFor(() => expect(rate).toHaveValue(150.5));
    expect(screen.getByTestId("btn-save-commission")).toBeEnabled();
    fireEvent.click(screen.getByTestId("btn-save-commission"));
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith("POST", "/api/commission/assign-structure", expect.objectContaining({ repId: 1, flatRateCents: 15050, reservePercent: null, reserveCapCents: null, closeExisting: true })));
  });

  it("does not overwrite a dirty flat-rate draft during a background refresh", async () => {
    const qc = renderTeam(); await openCommission();
    const rate = await screen.findByTestId("input-team-flat-rate");
    fireEvent.change(rate, { target: { value: "177.75" } });
    await act(async () => { qc.setQueryData(["/api/commission/reps", 1, "structure"], flatPlan(20000)); });
    expect(rate).toHaveValue(177.75);
    fireEvent.click(screen.getByTestId("btn-save-commission"));
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith("POST", "/api/commission/assign-structure", expect.objectContaining({ flatRateCents: 17775 })));
  });

  it("updates an untouched draft when a fresh read replaces a stale cached plan", async () => {
    const pending = deferred<Awaited<ReturnType<typeof json>>>();
    planResponse = pending.promise;
    renderTeam(flatPlan(15000)); await openCommission();
    const rate = await screen.findByTestId("input-team-flat-rate");
    await act(async () => { pending.resolve({ json: () => Promise.resolve(flatPlan(20000)) }); });
    await waitFor(() => expect(rate).toHaveValue(200));
    fireEvent.click(screen.getByTestId("btn-save-commission"));
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith("POST", "/api/commission/assign-structure", expect.objectContaining({ flatRateCents: 20000 })));
  });
});
