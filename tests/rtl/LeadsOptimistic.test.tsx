// Leads list — mutations feel instant.
//
// Deleting a lead used to await the DELETE round-trip before the row moved and
// the confirm dialog closed ("deleting leads is so slow"). These tests pin the
// optimistic contract: the row leaves the cached list and the dialog closes
// BEFORE the server answers, and a failed delete restores the row loudly.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: 1, name: "Ada Admin", role: "admin" } }),
}));

const apiRequest = vi.fn();
vi.mock("@/lib/queryClient", () => ({
  apiRequest: (...a: any[]) => apiRequest(...a),
  queryClient: undefined,
}));

const toast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: (...a: any[]) => toast(...a) }),
}));

// Identity debounce — the list query fires on first render, no timer games.
vi.mock("@/hooks/use-debounce", () => ({ useDebounce: (v: any) => v }));

vi.mock("@/lib/capabilities", () => ({ useCan: () => false }));

const navigate = vi.fn();
vi.mock("wouter", () => ({
  useLocation: () => ["/", navigate],
  Link: ({ href, children, ...rest }: any) => <a href={href} {...rest}>{children}</a>,
}));

import Leads from "../../client/src/pages/Leads";

function lead(id: number, over: Record<string, any> = {}) {
  return {
    id, address: `${id} Oak St`, city: "Testburg", state: "TX", zip: "70001",
    leadStatus: "prospect", lastOutcome: null, leadScore: 50,
    contactName: null, contactPhone: null, contactEmail: null,
    assignedRepId: 9, assignedAt: null, assignmentSource: null, dfAddressId: null,
    fiberStatus: "fiber_ready", isNewFiber: false, maxDownloadMbps: null,
    lat: null, lng: null,
    createdAt: "2026-07-30T00:00:00Z", updatedAt: "2026-07-30T00:00:00Z",
    ...over,
  };
}

// The DELETE/POST round-trips are deferred so tests can assert the optimistic
// state while the server has not answered yet, then settle either way.
let settleDelete: { resolve: () => void; reject: (e: Error) => void };
let settleAdd: { resolve: () => void; reject: (e: Error) => void };
// Arm with deferNextListGet() to hold the NEXT list GET open; its body is
// snapshotted at request time (like a real server would), so a fetch that
// starts pre-create carries a pre-create body no matter when it resolves.
let pendingListGet = false;
let settleListGet: { resolve: () => void } | null = null;
const deferNextListGet = () => { pendingListGet = true; };

function renderLeads(leadsDb: any[]) {
  apiRequest.mockImplementation((method: string, url: string, body?: any) => {
    if (method === "POST" && url === "/api/leads") {
      return new Promise<any>((resolve, reject) => {
        settleAdd = {
          resolve: () => {
            // Mirror the server's canonical-address dedupe: an existing
            // address answers 200 with the EXISTING row + existed:true.
            const dup = leadsDb.find(l => l.address === body?.address);
            if (dup) { resolve({ json: () => Promise.resolve({ ...dup, existed: true }) }); return; }
            const created = { ...lead(42), ...body, id: 42 };
            leadsDb.push(created);
            resolve({ json: () => Promise.resolve(created) });
          },
          reject,
        };
      });
    }
    if (method === "DELETE" && url.startsWith("/api/leads/")) {
      const id = Number(url.split("/").pop());
      return new Promise<any>((resolve, reject) => {
        settleDelete = {
          resolve: () => {
            const at = leadsDb.findIndex(l => l.id === id);
            if (at !== -1) leadsDb.splice(at, 1);
            resolve({ json: () => Promise.resolve({}) });
          },
          reject,
        };
      });
    }
    if (url.startsWith("/api/leads/facets")) return Promise.resolve({ json: () => Promise.resolve({ facets: [] }) });
    if (url.startsWith("/api/leads?")) {
      // Filter-aware, like the real endpoint — the filtered-view tests depend
      // on the server excluding non-matching rows.
      const params = new URLSearchParams(url.split("?")[1]);
      const status = params.get("status");
      const rows = leadsDb.filter(l => !status || l.leadStatus === status);
      const payload = { leads: [...rows], total: rows.length, limit: 100, offset: 0 };
      if (pendingListGet) {
        pendingListGet = false;
        return new Promise<any>(resolve => {
          settleListGet = { resolve: () => resolve({ json: () => Promise.resolve(payload) }) };
        });
      }
      return Promise.resolve({ json: () => Promise.resolve(payload) });
    }
    if (url.startsWith("/api/stats")) return Promise.resolve({ json: () => Promise.resolve({ total: leadsDb.length, assigned: 0, unassigned: 0, qualified: 0, stale: 0, byStatus: {}, byFiberStatus: {}, byRep: {}, byTerritory: {} }) });
    if (url.startsWith("/api/onboarding/pipeline")) return Promise.resolve({ json: () => Promise.resolve({ records: [] }) });
    return Promise.resolve({ json: () => Promise.resolve([]) });
  });
  const qc = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        // Keyless queries (["/api/team"]) ride the app's default fetcher; the
        // test client routes them through the same apiRequest mock.
        queryFn: async ({ queryKey }) => (await apiRequest("GET", String(queryKey[0]))).json(),
      },
    },
  });
  return { qc, ...render(<QueryClientProvider client={qc}><Leads /></QueryClientProvider>) };
}

async function submitNewLead(address: string) {
  fireEvent.click(await screen.findByTestId("btn-add-lead-manual"));
  fireEvent.change(await screen.findByTestId("form-address"), { target: { value: address } });
  fireEvent.change(screen.getByTestId("form-city"), { target: { value: "Testburg" } });
  fireEvent.change(screen.getByTestId("form-zip"), { target: { value: "70001" } });
  fireEvent.click(screen.getByTestId("btn-save-lead-form"));
}

async function confirmDeleteOf(id: number) {
  await screen.findByTestId(`card-lead-${id}`);
  const row = screen.getByTestId(`card-lead-${id}`);
  fireEvent.click(row.querySelector('button[aria-label^="Delete "]')!);
  fireEvent.click(await screen.findByTestId("btn-confirm-delete"));
}

beforeEach(() => { apiRequest.mockReset(); toast.mockReset(); navigate.mockReset(); pendingListGet = false; settleListGet = null; });

describe("Leads delete is optimistic", () => {
  it("removes the row and closes the dialog BEFORE the server responds", async () => {
    renderLeads([lead(1), lead(2)]);
    await confirmDeleteOf(1);

    // Server has NOT answered (settleDelete is still pending) — yet the row is
    // gone, the confirm dialog is closed, and the success toast already fired.
    // (waitFor only flushes React's own microtask work, never the DELETE.)
    await waitFor(() => expect(screen.queryByTestId("card-lead-1")).toBeNull());
    expect(screen.queryByTestId("mobile-lead-1")).toBeNull();
    expect(screen.getByTestId("card-lead-2")).toBeTruthy();
    expect(screen.queryByTestId("btn-confirm-delete")).toBeNull();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Lead deleted" }));

    // Settle: the server confirms, the reconciling refetch keeps the row gone.
    settleDelete.resolve();
    await waitFor(() => expect(screen.queryByTestId("card-lead-1")).toBeNull());
    expect(screen.getByTestId("card-lead-2")).toBeTruthy();
  });

  it("restores the row and fires a destructive toast when the server fails", async () => {
    renderLeads([lead(1), lead(2)]);
    await confirmDeleteOf(1);
    await waitFor(() => expect(screen.queryByTestId("card-lead-1")).toBeNull());

    // Reject only now — the mutation already awaits this promise, so the
    // rejection lands inside React Query's handled chain (no unhandled reject).
    settleDelete.reject(new Error("boom"));
    await waitFor(() => expect(screen.getByTestId("card-lead-1")).toBeTruthy());
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Couldn't delete lead - restored", variant: "destructive" }),
    );
    // Both rows intact after rollback + reconciling refetch.
    expect(screen.getByTestId("card-lead-2")).toBeTruthy();
  });
});

// The create contract (flicker fix, 2026-08): the dialog stays open on
// "Saving lead…" until the server confirms; the list keeps every existing row
// PLUS exactly one provisional saving row; success reconciles the temp row to
// the server row IN PLACE with NO list refetch (the refetch is what used to
// race a stale in-flight GET and make new leads vanish, then reappear).
describe("Leads add - saving state, continuity, reconcile", () => {
  const listGets = () =>
    apiRequest.mock.calls.filter(([m, u]) => m === "GET" && String(u).startsWith("/api/leads?"));

  it("shows Saving lead…, keeps the list + one temp row, then reconciles in place without a refetch", async () => {
    renderLeads([lead(1)]);
    await screen.findByTestId("card-lead-1");
    await submitNewLead("99 Pine St");

    // Server has NOT answered: the dialog is still open saying so, the list
    // still shows the old row, and exactly ONE provisional row exists.
    await waitFor(() => expect(screen.getAllByText("99 Pine St")).toHaveLength(1));
    expect(screen.getByTestId("btn-save-lead-form").textContent).toContain("Saving lead…");
    expect(screen.getByText("Saving…")).toBeTruthy();
    expect(screen.getByTestId("card-lead-1")).toBeTruthy();
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: "Lead added" }));

    // Settle: the server row (real id 42) replaces the temp row in place —
    // still exactly one instance, never a moment with zero.
    settleAdd.resolve();
    await waitFor(() => expect(screen.getByTestId("card-lead-42")).toBeTruthy());
    expect(screen.getAllByText("99 Pine St")).toHaveLength(1);
    expect(screen.queryByText("Saving…")).toBeNull();
    expect(screen.getByTestId("card-lead-1")).toBeTruthy();
    expect(screen.queryByTestId("btn-save-lead-form")).toBeNull();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Lead added" }));

    // The whole flow re-used the ONE mount-time list fetch — a create is a
    // cache write, not a 100-row reload.
    expect(listGets()).toHaveLength(1);
  });

  it("keeps the new lead through a background list refetch", async () => {
    const { qc } = renderLeads([lead(1)]);
    await screen.findByTestId("card-lead-1");
    await submitNewLead("99 Pine St");
    // Wait for the temp row: onMutate is async, so the POST (and the settle
    // handle) only exists once the optimistic write has landed.
    await waitFor(() => expect(screen.getAllByText("99 Pine St")).toHaveLength(1));
    settleAdd.resolve();
    await screen.findByTestId("card-lead-42");

    // A later background refetch (staleTime expiry, another tab's knock…)
    // returns the server list — the row must not blink out.
    await qc.invalidateQueries();
    await waitFor(() => expect(screen.getByTestId("card-lead-42")).toBeTruthy());
    expect(screen.getAllByText("99 Pine St")).toHaveLength(1);
  });

  it("a stale list fetch that was in flight when the save started cannot wipe the new lead", async () => {
    // THE headline race: a list GET leaves the server pre-create (here: a
    // background refetch armed to hang), the create completes and reconciles,
    // and only then does the stale body arrive. The mutation's cancelQueries
    // must have discarded that fetch — if either cancel is removed, the
    // pre-create body lands as fresh data and card-lead-42 vanishes.
    const { qc } = renderLeads([lead(1)]);
    await screen.findByTestId("card-lead-1");

    deferNextListGet();
    void qc.invalidateQueries(); // starts the doomed pre-create refetch
    await waitFor(() => expect(settleListGet).not.toBeNull());

    await submitNewLead("99 Pine St");
    await waitFor(() => expect(screen.getAllByText("99 Pine St")).toHaveLength(1));
    settleAdd.resolve();
    await screen.findByTestId("card-lead-42");

    // The stale pre-create body arrives LAST — and must change nothing.
    settleListGet!.resolve();
    await waitFor(() => expect(screen.getByTestId("card-lead-42")).toBeTruthy());
    expect(screen.getAllByText("99 Pine St")).toHaveLength(1);
    expect(screen.getByTestId("card-lead-1")).toBeTruthy();
  });

  it("a double-click fires exactly one POST", async () => {
    renderLeads([lead(1)]);
    await screen.findByTestId("card-lead-1");
    const posts = () => apiRequest.mock.calls.filter(([m, u]) => m === "POST" && u === "/api/leads");
    await submitNewLead("99 Pine St");
    // Second click lands in the same frame, before isPending re-renders — the
    // synchronous ref guard is what blocks it, not the disabled button.
    fireEvent.click(screen.getByTestId("btn-save-lead-form"));
    await waitFor(() => expect(posts()).toHaveLength(1));
    settleAdd.resolve();
    await screen.findByTestId("card-lead-42");
    expect(posts()).toHaveLength(1);
    expect(screen.getAllByText("99 Pine St")).toHaveLength(1);
  });

  it("failed save: loud error, temp row withdrawn, form data intact for retry", async () => {
    renderLeads([lead(1)]);
    await screen.findByTestId("card-lead-1");
    await submitNewLead("99 Pine St");
    await waitFor(() => expect(screen.getAllByText("99 Pine St")).toHaveLength(1));

    settleAdd.reject(new Error("boom"));
    await waitFor(() => expect(screen.queryByText("99 Pine St")).toBeNull());
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Couldn't add lead - boom", variant: "destructive" }),
    );
    // The dialog is still open with everything typed — retry is one click.
    expect((screen.getByTestId("form-address") as HTMLInputElement).value).toBe("99 Pine St");
    expect(screen.getByTestId("btn-save-lead-form")).toBeTruthy();
    // The pre-existing row survives the rollback.
    expect(screen.getByTestId("card-lead-1")).toBeTruthy();
  });

  it("duplicate address: temp row withdrawn, no second row, honest toast", async () => {
    renderLeads([lead(1)]); // lead 1 lives at "1 Oak St"
    await screen.findByTestId("card-lead-1");
    await submitNewLead("1 Oak St");
    await waitFor(() => expect(screen.getAllByText("1 Oak St").length).toBeGreaterThan(1));

    settleAdd.resolve(); // server answers existed:true with the surviving row
    await waitFor(() => expect(screen.getAllByText("1 Oak St")).toHaveLength(1));
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Already a lead" }));
    expect(screen.queryByTestId("btn-save-lead-form")).toBeNull();
  });

  it("lead hidden by the active filter: no phantom row, explanatory toast", async () => {
    renderLeads([lead(1, { leadStatus: "sold" })]);
    await screen.findByTestId("card-lead-1");
    // Narrow the view to Sold — the soon-to-be-created prospect doesn't match.
    fireEvent.click(screen.getByRole("button", { name: /^Sold/ }));
    await screen.findByTestId("card-lead-1");

    await submitNewLead("99 Pine St");
    // Wait for the POST to be issued (async onMutate), THEN assert the temp
    // row was NOT painted into a view its status doesn't match — painting it
    // everywhere was the old appear-then-vanish.
    await waitFor(() => expect(
      apiRequest.mock.calls.filter(([m, u]) => m === "POST" && u === "/api/leads"),
    ).toHaveLength(1));
    expect(screen.queryByText("99 Pine St")).toBeNull();
    expect(screen.getByTestId("card-lead-1")).toBeTruthy();

    settleAdd.resolve();
    await waitFor(() => expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Lead saved - hidden by current filters" }),
    ));
    // Saved, honestly absent — and never flashed in and out.
    expect(screen.queryByText("99 Pine St")).toBeNull();
    expect(screen.getByTestId("card-lead-1")).toBeTruthy();
  });
});
