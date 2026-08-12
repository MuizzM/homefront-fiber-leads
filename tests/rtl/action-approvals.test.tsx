// Action approvals - the screen's one job it must not get wrong.
//
// The whole layer's credibility rests on the undo button being honest. People
// approve differently when they believe a mistake is recoverable, so a button
// that appears where no reversal exists is worse than no button at all.
//
// Four ways this screen could quietly lie, all covered below:
//
//   1. Offering Undo on an action the server marked irreversible.
//   2. Offering Undo after the window closed, or when no inverse was captured.
//   3. Hiding the REASON there is no undo, leaving a silent gap where an
//      explanation belongs.
//   4. Failing to warn, before approval, that a pending action is one-way.
//
// Plus the policy editor's floor: an admin must be able to see that a kind
// cannot be set to run automatically, rather than finding out on save.

import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";
import ActionApprovals from "@/pages/ActionApprovals";

let role = "manager";
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: 1, name: "Mara Manager", role } }),
}));

const apiRequest = vi.fn();
vi.mock("@/lib/queryClient", () => ({
  apiRequest: (...a: any[]) => apiRequest(...a),
  queryClient: { invalidateQueries: vi.fn() },
}));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const baseAction = {
  id: 1,
  kind: "lead.bulk_assign",
  kindLabel: "Bulk assign doors",
  describes: "Move a selection of doors to one rep in a single action",
  reversibility: "reversible" as const,
  state: "executed" as const,
  magnitude: 420,
  magnitudeUnit: "doors",
  targetLabel: "420 doors to Alex Chen",
  requestedBy: "Lena Lead",
  requestedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  requestReason: null,
  gateReason: "420 doors is over the 200 doors limit for automatic approval.",
  expiresAt: null,
  decidedBy: "Mara Manager",
  decidedAt: new Date().toISOString(),
  decisionNote: null,
  executedAt: new Date().toISOString(),
  resultSummary: "Moved 420 doors.",
  failureReason: null,
  undoneAt: null,
  undoneBy: null,
  undo: { available: true, deadline: new Date(Date.now() + 30 * 60_000).toISOString() },
};

/** Route each query key to a canned payload. Anything unrouted resolves empty,
 *  so a test only states the part it is about. */
function serve(routes: Record<string, unknown>) {
  apiRequest.mockImplementation((_method: string, url: string) => {
    const hit = Object.keys(routes).find((key) => url.startsWith(key.split("?")[0]) && url === key)
      ?? Object.keys(routes).find((key) => url.startsWith(key));
    return Promise.resolve({ json: () => Promise.resolve(hit ? routes[hit] : {}) });
  });
}

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        queryFn: ({ queryKey }: any) => apiRequest("GET", String(queryKey[0])).then((r: any) => r.json()),
      },
    },
  });
  return render(<QueryClientProvider client={qc}><ActionApprovals /></QueryClientProvider>);
}

beforeEach(() => {
  apiRequest.mockReset();
  role = "manager";
});

describe("the undo button tells the truth", () => {
  it("offers it when the server says the action is reversible and open", async () => {
    serve({
      "/api/actions/pending": { actions: [], total: 0 },
      "/api/actions?limit=25": { actions: [baseAction], total: 1 },
      "/api/actions/catalogue": { kinds: [] },
    });
    renderPage();
    expect(await screen.findByTestId("undo-1")).toBeInTheDocument();
  });

  it("never offers it on an irreversible action, and says why", async () => {
    // The load-bearing case. Re-adding a suppression restores the block but
    // cannot recall a message sent while it was down, so there is no button.
    serve({
      "/api/actions/pending": { actions: [], total: 0 },
      "/api/actions?limit=25": {
        actions: [{
          ...baseAction,
          id: 2,
          kind: "contact.suppression.lift",
          kindLabel: "Lift a contact suppression",
          reversibility: "irreversible",
          undo: {
            available: false,
            because: "irreversible",
            reason: "This action cannot be undone. It was gated before it ran for exactly that reason.",
          },
        }],
        total: 1,
      },
      "/api/actions/catalogue": { kinds: [] },
    });
    renderPage();

    expect(await screen.findByTestId("no-undo-2")).toHaveTextContent(/cannot be undone/i);
    expect(screen.queryByTestId("undo-2")).not.toBeInTheDocument();
  });

  it("drops the button once the window has closed, and explains", async () => {
    serve({
      "/api/actions/pending": { actions: [], total: 0 },
      "/api/actions?limit=25": {
        actions: [{
          ...baseAction,
          id: 3,
          undo: { available: false, because: "expired", reason: "The undo window for this action has closed." },
        }],
        total: 1,
      },
      "/api/actions/catalogue": { kinds: [] },
    });
    renderPage();

    expect(await screen.findByTestId("no-undo-3")).toHaveTextContent(/window .* has closed/i);
    expect(screen.queryByTestId("undo-3")).not.toBeInTheDocument();
  });

  it("says so rather than going quiet when no reversal was captured", async () => {
    // The silent-gap case: an executed row with no button and no sentence reads
    // as a rendering bug, and leaves somebody assuming undo is still coming.
    serve({
      "/api/actions/pending": { actions: [], total: 0 },
      "/api/actions?limit=25": {
        actions: [{
          ...baseAction,
          id: 4,
          undo: {
            available: false,
            because: "no_inverse",
            reason: "No reversal was recorded for this action, so it cannot be undone safely.",
          },
        }],
        total: 1,
      },
      "/api/actions/catalogue": { kinds: [] },
    });
    renderPage();
    expect(await screen.findByTestId("no-undo-4")).toHaveTextContent(/cannot be undone safely/i);
  });

  it("offers nothing to undo on an action that never ran", async () => {
    serve({
      "/api/actions/pending": { actions: [], total: 0 },
      "/api/actions?limit=25": {
        actions: [{
          ...baseAction, id: 5, state: "rejected", executedAt: null, resultSummary: null,
          undo: { available: false, because: "expired", reason: "The undo window for this action has closed." },
        }],
        total: 1,
      },
      "/api/actions/catalogue": { kinds: [] },
    });
    renderPage();

    await screen.findByTestId("action-5");
    expect(screen.queryByTestId("undo-5")).not.toBeInTheDocument();
    // No stale "window has closed" line either: nothing happened, so there is
    // nothing to explain away.
    expect(screen.queryByTestId("no-undo-5")).not.toBeInTheDocument();
  });
});

describe("a pending decision shows what it is about to do", () => {
  const pendingAction = {
    ...baseAction,
    id: 7,
    state: "pending" as const,
    executedAt: null,
    resultSummary: null,
    decidedBy: null,
    decidedAt: null,
    expiresAt: new Date(Date.now() + 3 * 60 * 60_000).toISOString(),
    undo: { available: false, because: "expired", reason: "" },
  };

  it("shows the gate's reason next to the buttons", async () => {
    serve({
      "/api/actions/pending": { actions: [pendingAction], total: 1 },
      "/api/actions?limit=25": { actions: [], total: 0 },
      "/api/actions/catalogue": { kinds: [] },
    });
    renderPage();

    expect(await screen.findByTestId("pending-7")).toHaveTextContent("over the 200 doors limit");
    expect(screen.getByTestId("approve-7")).toBeInTheDocument();
    expect(screen.getByTestId("reject-7")).toBeInTheDocument();
  });

  it("warns before approval when the action is one-way", async () => {
    serve({
      "/api/actions/pending": {
        actions: [{ ...pendingAction, id: 8, reversibility: "irreversible" }],
        total: 1,
      },
      "/api/actions?limit=25": { actions: [], total: 0 },
      "/api/actions/catalogue": { kinds: [] },
    });
    renderPage();
    expect(await screen.findByTestId("irreversible-8")).toHaveTextContent(/cannot be undone/i);
  });

  it("does not warn on a reversible one", async () => {
    serve({
      "/api/actions/pending": { actions: [pendingAction], total: 1 },
      "/api/actions?limit=25": { actions: [], total: 0 },
      "/api/actions/catalogue": { kinds: [] },
    });
    renderPage();
    await screen.findByTestId("pending-7");
    expect(screen.queryByTestId("irreversible-7")).not.toBeInTheDocument();
  });
});

describe("the policy editor shows the floor", () => {
  const kinds = [
    {
      kind: "contact.suppression.lift",
      label: "Lift a contact suppression",
      describes: "Allow contact with someone who previously asked us to stop",
      floor: "approval" as const,
      reversibility: "irreversible" as const,
      maxUndoWindowMinutes: 0,
      magnitudeUnit: "contact",
      canApprove: true,
      policy: {
        kind: "contact.suppression.lift", mode: "approval" as const, approvalAboveMagnitude: null,
        selfApproval: false, undoWindowMinutes: 0, pendingExpiryMinutes: 4320, configured: false,
      },
    },
  ];

  it("stays hidden from someone who cannot configure it", async () => {
    role = "manager"; // holds action.queue.read, not action.policy.manage
    serve({
      "/api/actions/pending": { actions: [], total: 0 },
      "/api/actions?limit=25": { actions: [], total: 0 },
      "/api/actions/catalogue": { kinds },
    });
    renderPage();
    await screen.findByTestId("approvals-waiting");
    expect(screen.queryByTestId("policy-contact.suppression.lift")).not.toBeInTheDocument();
  });

  it("disables the automatic option on a kind whose floor forbids it", async () => {
    role = "admin";
    serve({
      "/api/actions/pending": { actions: [], total: 0 },
      "/api/actions?limit=25": { actions: [], total: 0 },
      "/api/actions/catalogue": { kinds },
    });
    renderPage();

    const select = await screen.findByTestId("mode-contact.suppression.lift");
    const auto = Array.from(select.querySelectorAll("option")).find((o) => o.value === "auto")!;
    // Visible but unselectable: the constraint should read as a rule, not as a
    // missing option somebody assumes is a bug.
    expect(auto).toBeDisabled();
    expect(select).toHaveTextContent("Runs immediately");
  });

  it("locks the undo window on an irreversible kind", async () => {
    role = "admin";
    serve({
      "/api/actions/pending": { actions: [], total: 0 },
      "/api/actions?limit=25": { actions: [], total: 0 },
      "/api/actions/catalogue": { kinds },
    });
    renderPage();

    await waitFor(() => expect(screen.getByTestId("undo-window-contact.suppression.lift")).toBeDisabled());
  });
});
