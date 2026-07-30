// Fetch failure must never masquerade as an empty candidate queue.
//
// The audit-confirmed defect: when GET /api/onboarding/pipeline fails, the
// screen fell through to "No candidates in this view — Send a private invite",
// so a manager on a network blip could re-invite people already in flight (a
// duplicate onboarding invite). Error+retry must win over the empty state.
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { id: 1, name: "Mgr", role: "manager", teamMemberId: 5 } }) }));
const apiRequest = vi.fn();
vi.mock("@/lib/queryClient", () => ({ apiRequest: (...a: any[]) => apiRequest(...a), queryClient: undefined }));

import Applications from "../../client/src/pages/Applications";

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><Applications /></QueryClientProvider>);
}
beforeEach(() => apiRequest.mockReset());

describe("Applications pipeline — error state honesty", () => {
  const rejectPipeline = () => apiRequest.mockImplementation((_m: string, url: string) => {
    if (String(url).includes("/onboarding/pipeline")) return Promise.reject(new Error("network down"));
    return Promise.resolve({ json: () => Promise.resolve({ configured: true, records: [] }) });
  });

  it("shows an error + retry (never the empty 'send an invite' state) when the pipeline fetch fails", async () => {
    rejectPipeline();
    renderPage();
    const err = await screen.findByTestId("pipeline-error");
    expect(err).toHaveTextContent(/couldn.t load the candidate pipeline/i);
    expect(err).toHaveTextContent(/don.t re-invite anyone/i);            // the duplicate-invite guardrail, in words
    expect(screen.queryByText(/No candidates in this view/i)).toBeNull(); // empty state suppressed
    expect(screen.getByTestId("pipeline-retry")).toBeInTheDocument();
  });

  it("retry re-issues the pipeline request", async () => {
    rejectPipeline();
    renderPage();
    await screen.findByTestId("pipeline-retry");
    const callsBefore = apiRequest.mock.calls.length;
    fireEvent.click(screen.getByTestId("pipeline-retry"));
    await waitFor(() => expect(apiRequest.mock.calls.length).toBeGreaterThan(callsBefore));
  });

  it("shows the empty state (not the error) when the fetch succeeds with no candidates", async () => {
    apiRequest.mockImplementation(() => Promise.resolve({ json: () => Promise.resolve({ configured: true, records: [] }) }));
    renderPage();
    await waitFor(() => expect(screen.getByText(/No candidates in this view/i)).toBeInTheDocument());
    expect(screen.queryByTestId("pipeline-error")).toBeNull();
  });
});
