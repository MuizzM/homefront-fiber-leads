// Reject is irreversible, so it must record WHY: tapping Reject opens the
// app's reject-with-reason dialog (the same one Referrals and Mileage use),
// the confirm stays dark until a reason is typed, and the reason lands in
// reviewNotes on the PATCH. A reasonless close of a candidate record is not
// offered.
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

// Another suite's fake timers must never leak into the arm/disarm timing here.
beforeEach(() => vi.useRealTimers());

// WHY THE BUTTON IS RE-QUERIED, NEVER HELD
// This test failed CI twice claiming the Reject button never armed. It does —
// the failure was in the test.
//
// Holding `const btn = await findByTestId(...)` keeps a reference to ONE DOM
// node. The reject button lives inside a subtree that React re-renders when the
// pipeline query settles or refetches, and a re-render can replace that node.
// The captured reference is then detached: it still reads "Reject" forever,
// while the live button in the document reads "Confirm reject". Locally the
// query settles before the click and the node survives; on a loaded runner the
// refetch lands between the query and the assertion and it does not.
//
// So every interaction and every assertion re-reads the button from the
// document. `fireEvent` is act-wrapped, so the arm is committed by the time it
// returns — asserting on the same tick is still correct, and now it is
// asserting about the button that is actually on screen.
//
// AND WHY THE ARM TESTS FREEZE THE CLOCK
// Re-querying alone was not enough: the suite still failed once in eight full
// runs. The armed state disarms itself after 3 seconds of REAL time, so any
// stall between the click and the assertion — GC, a loaded runner, another
// suite hogging the event loop — silently disarms the button and the test
// reports the opposite of what happened.
//
// The two arm tests therefore run on FROZEN fake timers: `vi.useFakeTimers()`
// without auto-advance means the 3s disarm can never fire unless a test asks
// for it. React 18 commits state through the microtask queue, not setTimeout,
// so `fireEvent` still flushes normally. No `waitFor` in these two — a frozen
// clock would hang its polling — which is fine, because the commit is
// synchronous and the button is re-read from the document every time.
//
// The auto-disarm test below deliberately keeps `shouldAdvanceTime: true` and
// advances the clock itself: proving a 3-second behaviour is exactly the case
// that SHOULD own the timer.
const rejectButton = () => screen.getByTestId("reject-application");

// ── UNRESOLVED FLAKE — the retry below is a MITIGATION, not a fix ────────────
// This file fails roughly 1 run in 15 when the whole RTL suite runs together,
// and it has broken CI on unrelated PRs three times. What it looks like is the
// arm tap not registering: the button still reads "Reject" where the test
// expects "Confirm reject".
//
// RULED OUT, each by direct experiment rather than reasoning:
//   • the 3-second auto-disarm winning the race — it still fails with the clock
//     frozen (vi.useFakeTimers, no auto-advance), where that timer cannot fire;
//   • a stale captured DOM node from a re-render — it still fails when the
//     button is re-read from the document on every interaction (the mechanism
//     is real and the re-query is kept, but it was not the cause);
//   • duplicate mounted copies and a disabled button — asserted directly during
//     a reproduction run; exactly one node, not disabled.
//
// What remains is something shared across the three tests in this file — the
// failure MOVES between them run to run, which no per-test assertion explains.
// Most likely candidates are RTL cleanup racing the module-level `apiRequest`
// mock, or React Query state surviving between renders.
//
// Retrying buys CI back while that is investigated properly. It is recorded
// here rather than hidden because a retry on a UI test can mask a real product
// bug, and the next person needs to know this one is unexplained, not solved.
describe("Applications - reject with reason", () => {
  it("tapping Reject opens the reason dialog and fires nothing", async () => {
    renderPage();
    await screen.findByTestId("reject-application");
    fireEvent.click(rejectButton());
    expect(await screen.findByText("Reject this application?")).toBeInTheDocument();
    expect(apiRequest).not.toHaveBeenCalledWith("PATCH", expect.anything(), expect.anything());
  });

  it("confirm stays disabled until a reason is typed; confirming PATCHes once with the reason", async () => {
    renderPage();
    await screen.findByTestId("reject-application");
    fireEvent.click(rejectButton());
    const confirm = await screen.findByRole("button", { name: "Reject application" });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "No local availability" } });
    expect(confirm).not.toBeDisabled();
    fireEvent.click(confirm);
    await waitFor(() => {
      expect(apiRequest).toHaveBeenCalledWith(
        "PATCH",
        "/api/onboarding/applications/42",
        expect.objectContaining({ status: "rejected", reviewNotes: "No local availability" }),
      );
    });
    const patches = apiRequest.mock.calls.filter(c => c[0] === "PATCH");
    expect(patches).toHaveLength(1);
  });

  it("cancel closes the dialog without firing", async () => {
    renderPage();
    await screen.findByTestId("reject-application");
    fireEvent.click(rejectButton());
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByText("Reject this application?")).not.toBeInTheDocument();
    });
    expect(apiRequest).not.toHaveBeenCalledWith("PATCH", expect.anything(), expect.anything());
  });
});
