import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { id: 1, name: "Ada Admin", role: "admin", teamMemberId: 100 } }) }));
vi.mock("@/lib/capabilities", () => ({ useCan: () => true }));
const { apiRequest, toast } = vi.hoisted(() => ({ apiRequest: vi.fn(), toast: vi.fn() }));
vi.mock("@/lib/queryClient", () => ({ apiRequest, queryClient: undefined }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }), toast }));
import CommissionConsole from "@/pages/CommissionConsole";

// Same overview shape as CommissionConsoleAuthority/Filters. Both people have
// open statements so switching the drawer exercises real adjustment entry.
const rows = [1, 2].map(id => ({
  repId: id, repName: id === 1 ? "Rex Rep" : "Dana Door", active: true,
  managerId: 100, managerName: "Ada Admin", teamLeadId: null, teamLeadName: null,
  statementId: id * 11, status: "OPEN", qualifiedSaleCount: 3, pendingSaleCount: 0,
  reversedSaleCount: 0, tierLabel: "1-6", rateCents: 15000,
  grossCommissionCents: 45000, adjustmentCents: 0, finalCommissionCents: 45000,
  structure: "TIERED", planAccepted: true, hours: 0, hourlyMinutes: 0,
  hourlyRateCents: null, hourlyPayCents: 0, openClockSessions: 0,
  salesUntilNextTier: null, nextTierRateCents: null,
  nextTierProjectedCommissionCents: null, marginalJumpCents: null,
  installHold: { saleCount: 0, earliestPayableAfter: null },
  overridePayCents: 0, overrideItemCount: 0,
}));
const overview = {
  bounds: { weekStartUtc: "2026-08-03T04:00:00.000Z", nextWeekStartUtc: "2026-08-10T04:00:00.000Z", localWeekLabel: "Aug 3 - Aug 9, 2026", timezone: "America/New_York" },
  weekEnded: false, rows,
  totals: { projectedPayrollCents: 90000, finalizedPayrollCents: 0, paidPayrollCents: 0, exposureCents: 0, qualifiedSales: 6, repsWithSales: 2, installHoldSales: 0 },
  exceptions: [],
};
const payoutWeek = {
  stripeEnabled: true, week: "2026-08-03", payableCount: 1, payableCents: 45000,
  rows: [{ repId: 1, repName: "Rex Rep", statementId: 11, status: "FINALIZED", finalCommissionCents: 45000, onboardingStatus: "enabled", payoutStatus: null, eligible: true, blockReason: null, blockLabel: null }],
};
const partialCloseout = { results: [
  { repId: 1, statementId: 11, result: "FINALIZED", outcome: "ok", retryable: false },
  { repId: 2, statementId: 22, result: "BLOCKED (OPEN_CLOCK_SESSION: close the open clock session before finalizing hourly pay)", outcome: "blocked", code: "OPEN_CLOCK_SESSION", retryable: true },
] };
function json(value: unknown) { return Promise.resolve({ json: () => Promise.resolve(value) }); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
let previewFails = false;
let configFails = false;
let patchResponse: ReturnType<typeof json> | undefined;
beforeEach(() => {
  apiRequest.mockReset(); toast.mockReset(); previewFails = false; configFails = false; patchResponse = undefined;
  apiRequest.mockImplementation((method: string, url: string) => {
    if (url.startsWith("/api/commission/week-overview")) return json(overview);
    if (url === "/api/commission/week/transition") return json(partialCloseout);
    if (url.endsWith("/week-sales") || url.includes("/week-sales?")) return json([]);
    if (url.startsWith("/api/commission/statements/")) return json({ statement: {}, adjustments: [] });
    if (url.includes("/reserve")) return json({ balanceCents: 0, entries: [] });
    if (url === "/api/commission/config" && method === "PATCH") return patchResponse ?? json({ houseAmountCents: 25000 });
    if (url === "/api/commission/config") return configFails ? Promise.reject(new Error("offline")) : json({ houseAmountCents: 15000 });
    if (url.startsWith("/api/payouts/week?")) return previewFails ? Promise.reject(new Error("offline")) : json(payoutWeek);
    if (url === "/api/payouts/balance") return json({ configured: true, availableCents: 1000000, pendingCents: 0, currency: "usd" });
    if (url === "/api/payouts") return json({ payouts: [] });
    return json({});
  });
});
function renderConsole() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={qc}><CommissionConsole /></QueryClientProvider>);
  return qc;
}
function writesTo(path: string) { return apiRequest.mock.calls.filter(([method, url]) => method !== "GET" && url === path); }
async function openPay() {
  fireEvent.click(await screen.findByTestId("commission-tab-pay"));
  await screen.findByTestId("pay-reps-panel");
}

describe("commission recovery and financial draft safety", () => {
  it("does not carry a filed adjustment draft from one rep to another", async () => {
    renderConsole();
    fireEvent.click(await screen.findByTestId("open-rep-1"));
    fireEvent.click(await screen.findByTestId("btn-new-adjustment"));
    fireEvent.change(screen.getByTestId("input-adj-amount"), { target: { value: "75" } });
    fireEvent.change(screen.getByTestId("input-adj-reason"), { target: { value: "Rex installation correction" } });
    fireEvent.click(within(screen.getByRole("dialog")).getAllByRole("button", { name: "Close", exact: true })[0]);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    fireEvent.click(screen.getByTestId("open-rep-2"));
    expect(screen.queryByTestId("input-adj-reason")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("btn-new-adjustment"));
    expect(screen.getByTestId("input-adj-reason")).toHaveValue("");
    expect(screen.getByTestId("input-adj-amount")).toHaveDisplayValue("");
    expect(screen.getByTestId("btn-file-adjustment")).toBeDisabled();
    expect(writesTo("/api/commission/adjustments")).toHaveLength(0);
  });

  it("keeps partial closeout failures visible with the affected rep and a retry", async () => {
    renderConsole();
    fireEvent.click(await screen.findByTestId("btn-finalize-week"));
    fireEvent.click(screen.getByTestId("btn-confirm-closeout"));
    const issues = await screen.findByTestId("closeout-issues");
    expect(issues).toHaveTextContent("Dana Door");
    expect(issues).toHaveTextContent("OPEN_CLOCK_SESSION");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByTestId("btn-confirm-closeout")).toBeEnabled();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Closeout needs attention - 1 completed", variant: "destructive" }));
  });

  it("clears prior closeout issues after Escape before opening another closeout", async () => {
    renderConsole();
    fireEvent.click(await screen.findByTestId("btn-finalize-week"));
    fireEvent.click(screen.getByTestId("btn-confirm-closeout"));
    await screen.findByTestId("closeout-issues");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape", code: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    fireEvent.click(screen.getByTestId("btn-finalize-week"));
    expect(screen.queryByTestId("closeout-issues")).not.toBeInTheDocument();
  });

  it("offers retry for a failed payout preview without claiming payouts are disabled", async () => {
    previewFails = true;
    renderConsole(); await openPay();
    const error = await screen.findByTestId("pay-reps-error");
    expect(screen.queryByTestId("pay-reps-disabled")).not.toBeInTheDocument();
    expect(screen.queryByTestId("pay-reps-btn")).not.toBeInTheDocument();
    previewFails = false;
    fireEvent.click(within(error).getByRole("button", { name: /retry/i }));
    expect(await screen.findByTestId("pay-reps-btn")).toBeEnabled();
  });

  it("blocks an already-open payout confirmation when readiness refresh fails", async () => {
    const qc = renderConsole(); await openPay();
    fireEvent.click(await screen.findByTestId("pay-reps-btn"));
    expect(screen.getByTestId("pay-confirm")).toBeEnabled();
    previewFails = true;
    await act(async () => { await qc.refetchQueries({ queryKey: ["/api/payouts/week"] }); });
    await screen.findByTestId("pay-reps-error");
    const confirm = screen.queryByTestId("pay-confirm");
    if (confirm) {
      expect(confirm).toBeDisabled();
      fireEvent.click(confirm);
    }
    expect(writesTo("/api/payouts/week/pay")).toHaveLength(0);
  });

  it("does not save a default or unchanged house amount through Enter", async () => {
    configFails = true;
    renderConsole(); await openPay();
    const input = await screen.findByTestId("house-amount-input");
    await screen.findByText("Couldn't load the saved house amount");
    expect(input).toBeDisabled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(writesTo("/api/commission/config")).toHaveLength(0);
    configFails = false;
    fireEvent.click(within(screen.getByTestId("house-amount-card")).getByRole("button", { name: /retry/i }));
    await waitFor(() => expect(input).toHaveValue("150.00"));
    fireEvent.keyDown(input, { key: "Enter" });
    expect(writesTo("/api/commission/config")).toHaveLength(0);
  });

  it("keeps a house amount save from being submitted again while pending", async () => {
    const pending = deferred<Awaited<ReturnType<typeof json>>>();
    patchResponse = pending.promise;
    renderConsole(); await openPay();
    const input = await screen.findByTestId("house-amount-input");
    await waitFor(() => expect(input).toBeEnabled());
    fireEvent.change(input, { target: { value: "250.00" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(writesTo("/api/commission/config")).toHaveLength(1));
    await waitFor(() => expect(input).toBeDisabled());
    fireEvent.keyDown(input, { key: "Enter" });
    expect(writesTo("/api/commission/config")).toHaveLength(1);
    await act(async () => { pending.resolve({ json: () => Promise.resolve({ houseAmountCents: 25000 }) }); });
    await waitFor(() => expect(input).toBeEnabled());
    expect(input).toHaveValue("250.00");
  });
});
