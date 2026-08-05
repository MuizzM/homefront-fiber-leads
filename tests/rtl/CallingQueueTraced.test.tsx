// The traced-numbers section on the Cold Calling queue.
//
// What matters here is that a BLOCKED door stays on screen. The operator chose
// "show every traced door, blocked ones inert" over "hide what cannot be
// dialled", because a rep who sees a short list cannot tell "we traced nothing"
// from "we traced it and it was suppressed" — and the second is the one that
// should send them to knock the door instead.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Route, Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import CallingQueue from "@/pages/CallingQueue";
import * as callingApi from "@/lib/callingApi";

vi.mock("@/lib/callingApi", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/callingApi")>();
  return {
    ...actual,
    getCallingStatus: vi.fn(),
    getCallingQueue: vi.fn(),
    getCallingCallbacks: vi.fn(),
  };
});

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: 1, name: "Calling Rep", email: "rep@example.test", role: "calling_rep", tenantId: 1 } }),
}));

function candidate(over: Partial<callingApi.CallingCandidate>): callingApi.CallingCandidate {
  return {
    queueId: `queue-${over.leadId ?? 0}`, leadId: 0, address: "148 Maple St", city: "Lexington", state: "NC", zip: "27292",
    freshConfirmedAt: null, freshConfidence: null, traced: false, tracedBadge: null,
    queueStage: "AWAITING_DNC_CHECK", priority: 90, assignedUserId: 1, contactId: 10,
    contactStatus: "REVIEW_REQUIRED", contactName: "Traced owner", residentStatus: "OWNER_NOT_CONFIRMED_RESIDENT",
    phoneId: 20, maskedPhone: "(•••) •••-0142", phoneValidationStatus: "VALID",
    phoneLastVerifiedAt: new Date().toISOString(), phoneVerificationExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    lineType: "wireless", reassignedRisk: false, identityConfidence: 0.9, wrongParty: false,
    providerConfigId: "provider-tracerfy", providerName: "Tracerfy", lastDecisionId: null,
    lastDecisionStatus: null, lastDecisionExpiresAt: null,
    ...over,
  };
}

const tracedRows = [
  candidate({ queueId: "t1", leadId: 21, traced: true, address: "21 Ready Ln",
    tracedBadge: { ready: true, label: "OK to call", reasons: [] } }),
  candidate({ queueId: "t2", leadId: 22, traced: true, address: "22 Federal Way",
    tracedBadge: { ready: false, label: "On the federal Do Not Call registry", reasons: ["federal_dnc"] } }),
  candidate({ queueId: "t3", leadId: 23, traced: true, address: "23 Stale Ct",
    tracedBadge: { ready: false, label: "DNC check expired — re-scrubbing", reasons: ["scrub_expired"] } }),
];

const fiberRows = [
  candidate({ queueId: "f1", leadId: 31, address: "31 Fiber Rd", queueStage: "ELIGIBLE_MANUAL_CALL",
    freshConfidence: "cross_verified", freshConfirmedAt: new Date().toISOString() }),
];

function statusFixture(tracedImport: { available: boolean; contractStatus: string }) {
  return {
    enabled: true, callable: true, blockers: [],
    environment: { moduleEnabled: true, enrichmentEnabled: true, nationalDncEnabled: true, stateDncEnabled: true,
      manualClickRequired: true, pilotAllowed: true, secretsReady: true, emergencyDisabled: false },
    organization: { callingEnabled: true, emergencyDisabled: false, policyVersion: 1 },
    tracedImport,
    activeScript: { version: "2026-07-a", title: "Fresh fiber introduction" },
    activeRuleVersion: "rules-1", representativeHold: null,
  } as Awaited<ReturnType<typeof callingApi.getCallingStatus>>;
}

function renderQueue() {
  window.location.hash = "#/calling";
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <Router hook={useHashLocation}>
        <Route path="/calling"><CallingQueue /></Route>
      </Router>
    </QueryClientProvider>,
  );
}

describe("traced numbers section", () => {
  beforeEach(() => {
    vi.mocked(callingApi.getCallingCallbacks).mockResolvedValue([]);
    vi.mocked(callingApi.getCallingQueue).mockImplementation((options?: { source?: string; stage?: string }) =>
      Promise.resolve(options?.source === "traced" ? tracedRows : fiberRows));
  });

  it("lists every traced door and counts only the dialable ones as ready", async () => {
    vi.mocked(callingApi.getCallingStatus).mockResolvedValue(statusFixture({ available: true, contractStatus: "approved" }));
    renderQueue();

    const section = await screen.findByTestId("traced-leads");
    expect(within(section).getByTestId("traced-ready-count")).toHaveTextContent("1 ready · 3 total");
    expect(screen.getByTestId("traced-lead-21")).toBeInTheDocument();
    expect(screen.getByTestId("traced-lead-22")).toBeInTheDocument();
    expect(screen.getByTestId("traced-lead-23")).toBeInTheDocument();
  });

  it("keeps a suppressed door visible and says which registry blocked it", async () => {
    vi.mocked(callingApi.getCallingStatus).mockResolvedValue(statusFixture({ available: true, contractStatus: "approved" }));
    renderQueue();

    const blocked = await screen.findByTestId("traced-lead-22");
    expect(blocked).toHaveTextContent("Blocked");
    expect(blocked).toHaveTextContent("On the federal Do Not Call registry");
    // Inert, not absent — the door is still worth knocking.
    expect(blocked.className).toContain("opacity-60");
  });

  it("distinguishes an expired scrub from a registry hit", async () => {
    vi.mocked(callingApi.getCallingStatus).mockResolvedValue(statusFixture({ available: true, contractStatus: "approved" }));
    renderQueue();
    expect(await screen.findByTestId("traced-lead-23")).toHaveTextContent("DNC check expired");
  });

  it("sorts dialable doors above blocked ones", async () => {
    vi.mocked(callingApi.getCallingStatus).mockResolvedValue(statusFixture({ available: true, contractStatus: "approved" }));
    renderQueue();

    const section = await screen.findByTestId("traced-leads");
    const rendered = within(section).getAllByRole("link").map(node => node.getAttribute("data-testid"));
    expect(rendered[0]).toBe("traced-lead-21");
  });

  it("does not repeat a traced door in the fresh-fiber list", async () => {
    vi.mocked(callingApi.getCallingStatus).mockResolvedValue(statusFixture({ available: true, contractStatus: "approved" }));
    renderQueue();

    await screen.findByTestId("traced-leads");
    // The fiber list is fetched with source=fiber, so a traced lead can only
    // ever appear once on the page.
    expect(vi.mocked(callingApi.getCallingQueue).mock.calls.some(([options]) => options?.source === "fiber")).toBe(true);
    expect(screen.queryAllByTestId("calling-lead-21")).toHaveLength(0);
  });

  it("explains an unapproved provider instead of rendering an empty list", async () => {
    vi.mocked(callingApi.getCallingStatus).mockResolvedValue(statusFixture({ available: false, contractStatus: "unapproved" }));
    renderQueue();

    const notice = await screen.findByTestId("traced-import-unavailable");
    expect(notice).toHaveTextContent("Traced numbers are not in the queue yet");
    expect(notice).toHaveTextContent("unapproved");
    expect(screen.queryByTestId("traced-leads")).not.toBeInTheDocument();
  });

  it("narrows traced doors with the queue search box", async () => {
    vi.mocked(callingApi.getCallingStatus).mockResolvedValue(statusFixture({ available: true, contractStatus: "approved" }));
    const user = userEvent.setup();
    renderQueue();

    await screen.findByTestId("traced-lead-21");
    await user.type(screen.getByLabelText("Search calling queue"), "Federal Way");
    await waitFor(() => expect(screen.queryByTestId("traced-lead-21")).not.toBeInTheDocument());
    expect(screen.getByTestId("traced-lead-22")).toBeInTheDocument();
  });
});
