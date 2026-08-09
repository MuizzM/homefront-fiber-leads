// ── A failed fetch must never masquerade as a reassuring empty state ─────────
//
// The audit found the same defect on several money/ops surfaces: the page
// destructured only `data`, so `isError` fell through to the empty branch and
// an outage rendered as "No trips logged yet" (a tax record), "Nothing waiting
// for review" (an approval queue), "no failures — engines healthy"
// (diagnostics mid-outage), or "0 high-risk capabilities" (the permissions
// console). These tests pin the fixed behaviour on the three cheapest-to-mount
// pages; the pattern is identical everywhere else it was applied.
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";

const apiRequest = vi.fn();
vi.mock("@/lib/queryClient", () => ({
  apiRequest: (...a: any[]) => apiRequest(...a),
  queryClient: { invalidateQueries: vi.fn() },
}));
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: 1, name: "Ada Admin", role: "admin", teamMemberId: 1 } }),
}));
vi.mock("@/lib/capabilities", () => ({
  useCan: () => true,
}));

import Diagnostics from "../../client/src/pages/Diagnostics";
import Governance from "../../client/src/pages/Governance";
import TokenSetup from "../../client/src/pages/TokenSetup";

function renderWithClient(ui: React.ReactElement, impl: (url: string) => Promise<any>) {
  apiRequest.mockImplementation((...args: any[]) => {
    const url = args.find(a => typeof a === "string" && a.startsWith("/")) ?? "";
    return impl(url);
  });
  const qc = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        // Some pages (TokenSetup) declare queryKey-only queries and lean on the
        // app client's default queryFn — route those through the same impl.
        // Pre-attach a no-op catch: vitest's unhandled-rejection tracker fires
        // in the tick before React Query adopts the promise.
        queryFn: ({ queryKey }) => {
          const p = impl(String(queryKey[0])).then(r => (r && typeof r.json === "function" ? r.json() : r));
          p.catch(() => {});
          return p;
        },
      },
    },
  });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => apiRequest.mockReset());

describe("diagnostics feeds under fetch failure", () => {
  it("says the feeds are unknown - never 'engines healthy'", async () => {
    // Fail via a THROWING json(): the rejection is born inside the promise
    // chain React Query already owns, so no orphan tick trips vitest's
    // unhandled-rejection tracker (a bare Promise.reject here did).
    const failing = () => Promise.resolve({ json: () => { throw new Error("api down"); } });
    renderWithClient(<Diagnostics />, failing);
    await waitFor(() => expect(screen.getByTestId("diag-error")).toBeTruthy());
    const failures = screen.getByTestId("diag-failures");
    expect(failures.textContent).toMatch(/didn't load/i);
    expect(failures.textContent).not.toMatch(/engines healthy/i);
    const denials = screen.getByTestId("diag-denials");
    expect(denials.textContent).not.toMatch(/access looks correct/i);
    const sensitive = screen.getByTestId("diag-sensitive");
    expect(sensitive.textContent).not.toMatch(/No sensitive actions/i);
  });
});

describe("governance under fetch failure", () => {
  it("shows unknown metrics and an alert with retry - never '0 high-risk'", async () => {
    renderWithClient(<Governance />, url =>
      url.includes("governance") ? Promise.reject(new Error("api down")) : Promise.resolve({ json: () => Promise.resolve([]) }),
    );
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toMatch(/unknown, not zero/i);
    // The three metric tiles all show the em-dash placeholder, not zeros.
    expect(screen.getAllByText("-").length).toBeGreaterThanOrEqual(3);
  });
});

describe("token status before data arrives", () => {
  it("opens on a neutral 'Checking…' card, not a false 'Token Expired' alarm", async () => {
    // Resolve after a beat: the assertion runs inside the pre-data window users
    // see on every visit, then the promise settles so cleanup can drain.
    renderWithClient(<TokenSetup />, () => new Promise(res =>
      setTimeout(() => res({ json: () => Promise.resolve({ hasToken: true, expiresIn: 1500, source: "proxy" }) }), 40)));
    expect(screen.getByText("Checking…")).toBeTruthy();
    expect(screen.queryByText("Token Expired")).toBeNull();
    // The healthy state lands once data arrives - never the red alarm en route.
    await screen.findByText("Scanner Connected");
  });
});
