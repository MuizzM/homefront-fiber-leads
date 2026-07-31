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

function renderLeads(leadsDb: any[]) {
  apiRequest.mockImplementation((method: string, url: string, body?: any) => {
    if (method === "POST" && url === "/api/leads") {
      return new Promise<any>((resolve, reject) => {
        settleAdd = {
          resolve: () => {
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
    if (url.startsWith("/api/leads?")) return Promise.resolve({ json: () => Promise.resolve({ leads: [...leadsDb], total: leadsDb.length, limit: 100, offset: 0 }) });
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
  fireEvent.click(row.querySelector('button[title="Delete"]')!);
  fireEvent.click(await screen.findByTestId("btn-confirm-delete"));
}

beforeEach(() => { apiRequest.mockReset(); toast.mockReset(); navigate.mockReset(); });

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
      expect.objectContaining({ title: "Couldn't delete lead — restored", variant: "destructive" }),
    );
    // Both rows intact after rollback + reconciling refetch.
    expect(screen.getByTestId("card-lead-2")).toBeTruthy();
  });
});

describe("Leads add is optimistic", () => {
  it("closes the dialog and shows the new row BEFORE the POST resolves", async () => {
    renderLeads([lead(1)]);
    await screen.findByTestId("card-lead-1");
    await submitNewLead("99 Pine St");

    // Server has NOT answered (settleAdd is still pending) — yet the dialog is
    // closed, the optimistic row is visible, and the success toast fired.
    await waitFor(() => expect(screen.getAllByText("99 Pine St").length).toBeGreaterThan(0));
    expect(screen.queryByTestId("btn-save-lead-form")).toBeNull();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Lead added" }));

    // Settle: the server row (real id 42) replaces the temp row on refetch.
    settleAdd.resolve();
    await waitFor(() => expect(screen.getByTestId("card-lead-42")).toBeTruthy());
    expect(screen.getAllByText("99 Pine St").length).toBeGreaterThan(0);
    expect(screen.getByTestId("card-lead-1")).toBeTruthy();
  });

  it("removes the temp row and fires a destructive toast when the POST fails", async () => {
    renderLeads([lead(1)]);
    await screen.findByTestId("card-lead-1");
    await submitNewLead("99 Pine St");
    await waitFor(() => expect(screen.getAllByText("99 Pine St").length).toBeGreaterThan(0));

    // Reject only now — the mutation already awaits this promise, so the
    // rejection lands inside React Query's handled chain (no unhandled reject).
    settleAdd.reject(new Error("boom"));
    await waitFor(() => expect(screen.queryByText("99 Pine St")).toBeNull());
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Couldn't add lead — boom", variant: "destructive" }),
    );
    // The pre-existing row survives the rollback.
    expect(screen.getByTestId("card-lead-1")).toBeTruthy();
  });
});
