// Reject is irreversible, so it must be a two-step arm (audit fix): the first
// tap turns the button into a rose "Confirm reject" that auto-disarms after
// 3 seconds; only a second tap while armed fires the mutation.
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { id: 1, name: "Admin", role: "admin" } }) }));
const apiRequest = vi.fn();
vi.mock("@/lib/queryClient", () => ({
  apiRequest: (...a: any[]) => apiRequest(...a),
  queryClient: { invalidateQueries: vi.fn() },
}));
const toast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));

import Applications from "../../client/src/pages/Applications";

const RECORD = {
  key: "app-42",
  inviteId: null,
  applicationId: 42,
  candidateName: "Jordan Deal",
  candidateEmail: "jordan@example.com",
  source: "careers",
  desiredRole: "Field rep",
  stage: "under_review",
  progress: { completed: 2, total: 7 },
  milestones: {
    invited: false, applied: true, approved: false, loginCodeSent: false,
    agreementsIssued: false, signedCount: 0, fullySigned: false, active: false,
  },
  invite: null,
  application: {
    status: "under_review", phone: "704-555-0100", city: "Rockwell", state: "NC", zip: "28138",
    preferredCarriers: "Brightspeed", hasSalesExperience: true, salesExperienceDetails: null,
    referralSource: null, headshotPath: null, licensePath: null,
    reviewNotes: null, createdAt: "2026-07-28T12:00:00.000Z",
  },
  account: null,
  documents: [],
  timeline: [],
};

const PIPELINE = {
  configured: true,
  summary: { total: 1, needsAction: 1, inProgress: 0, active: 0 },
  records: [RECORD],
};

function renderPage() {
  apiRequest.mockImplementation((method: string) => {
    if (method === "GET") return Promise.resolve({ json: () => Promise.resolve(PIPELINE) });
    return Promise.resolve({ json: () => Promise.resolve({ ok: true }) });
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><Applications /></QueryClientProvider>);
}

beforeEach(() => { apiRequest.mockReset(); toast.mockReset(); });
afterEach(() => vi.useRealTimers());

describe("Applications — two-step reject", () => {
  it("first tap only arms: rose 'Confirm reject', no mutation fires", async () => {
    renderPage();
    const btn = await screen.findByTestId("reject-application");
    expect(btn).toHaveTextContent("Reject");
    fireEvent.click(btn);
    expect(btn).toHaveTextContent("Confirm reject");
    expect(btn.className).toMatch(/rose/);
    expect(apiRequest).not.toHaveBeenCalledWith("PATCH", expect.anything(), expect.anything());
  });

  it("second tap while armed fires the reject PATCH exactly once", async () => {
    renderPage();
    const btn = await screen.findByTestId("reject-application");
    fireEvent.click(btn); // arm
    fireEvent.click(btn); // confirm
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith(
        "PATCH",
        "/api/onboarding/applications/42",
        expect.objectContaining({ status: "rejected" }),
      ),
    );
    const patches = apiRequest.mock.calls.filter(c => c[0] === "PATCH");
    expect(patches).toHaveLength(1);
    // Fired and disarmed — the button is back to its resting label.
    expect(btn).toHaveTextContent("Reject");
    expect(btn).not.toHaveTextContent("Confirm reject");
  });

  it("auto-disarms after 3 seconds without a confirming tap", async () => {
    renderPage();
    const btn = await screen.findByTestId("reject-application"); // real timers for the fetch
    vi.useFakeTimers(); // then a deterministic clock for the 3s disarm window
    fireEvent.click(btn);
    expect(btn).toHaveTextContent("Confirm reject");
    act(() => { vi.advanceTimersByTime(3100); });
    expect(btn).toHaveTextContent("Reject");
    expect(btn).not.toHaveTextContent("Confirm reject");
    // A tap after the window has closed must only re-arm, never fire.
    fireEvent.click(btn);
    expect(apiRequest).not.toHaveBeenCalledWith("PATCH", expect.anything(), expect.anything());
  });
});
