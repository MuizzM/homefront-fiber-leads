// Bulk skip tracing from the Cold Calling queue.
//
// The generic multi-provider enrichment path is gone: a door with no number is
// no longer "Not enriched" with an Enrich button behind a provider framework,
// it is "Not traced" with one Tracerfy run. What matters here is that the bar
// only offers to spend money on doors that actually need it, that it is gated
// on the SPEND capability rather than the dial capability, and that a live run
// cannot be started twice.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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
    startQueueTrace: vi.fn(),
    getLatestQueueTraceRun: vi.fn(),
  };
});

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: 1, name: "Calling Rep", email: "rep@example.test", role: "admin", tenantId: 1 } }),
}));

const canSpend = vi.fn(() => true);
vi.mock("@/lib/capabilities", () => ({ useCan: (cap: string) => canSpend(cap) }));

function candidate(over: Partial<callingApi.CallingCandidate>): callingApi.CallingCandidate {
  return {
    queueId: `queue-${over.leadId ?? 0}`, leadId: 0, address: "148 Maple St", city: "Lexington", state: "NC", zip: "27292",
    freshConfirmedAt: null, freshConfidence: null, traced: false, tracedBadge: null,
    queueStage: "AWAITING_DNC_CHECK", priority: 90, assignedUserId: 1, contactId: 10,
    contactStatus: "REVIEW_REQUIRED", contactName: null, residentStatus: "OWNER_NOT_CONFIRMED_RESIDENT",
    phoneId: null, maskedPhone: null, phoneValidationStatus: null,
    phoneLastVerifiedAt: null, phoneVerificationExpiresAt: null,
    lineType: null, reassignedRisk: false, identityConfidence: null, wrongParty: false,
    providerConfigId: "provider-tracerfy", providerName: "Tracerfy", lastDecisionId: null,
    lastDecisionStatus: null, lastDecisionExpiresAt: null,
    ...over,
  };
}

const untracedRows = [
  candidate({ queueId: "u1", leadId: 41, address: "41 Untraced Rd" }),
  candidate({ queueId: "u2", leadId: 42, address: "42 Untraced Rd" }),
];
const tracedRow = candidate({
  queueId: "h1", leadId: 43, address: "43 Has Number Rd",
  phoneId: 20, maskedPhone: "(•••) •••-0142", contactName: "Traced owner",
});

const STATUS = {
  enabled: true, callable: true, blockers: [],
  environment: { moduleEnabled: true, enrichmentEnabled: true, nationalDncEnabled: true, stateDncEnabled: true,
    manualClickRequired: true, pilotAllowed: true, secretsReady: true, emergencyDisabled: false },
  organization: { callingEnabled: true, emergencyDisabled: false, policyVersion: 1 },
  tracedImport: { available: true, contractStatus: "approved" },
  activeScript: { version: "2026-07-a", title: "Fresh fiber introduction" },
  activeRuleVersion: "rules-1", representativeHold: null,
} as Awaited<ReturnType<typeof callingApi.getCallingStatus>>;

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

const run = (over: Partial<callingApi.QueueTraceRun> = {}): callingApi.QueueTraceRun => ({
  id: "run-1", status: "running", requestedLeads: 2, processedLeads: 1,
  failedLeads: 0, totalPhones: 3, dialablePhones: 2, errorCode: null,
  startedAt: new Date().toISOString(), finishedAt: null, ...over,
});

beforeEach(() => {
  canSpend.mockImplementation(() => true);
  vi.mocked(callingApi.getCallingCallbacks).mockResolvedValue([]);
  vi.mocked(callingApi.getCallingStatus).mockResolvedValue(STATUS);
  vi.mocked(callingApi.getCallingQueue).mockImplementation((options?: { source?: string }) =>
    Promise.resolve(options?.source === "traced" ? [] : [...untracedRows, tracedRow]));
  vi.mocked(callingApi.getLatestQueueTraceRun).mockResolvedValue({ run: null, limit: 100 });
  vi.mocked(callingApi.startQueueTrace).mockResolvedValue({ run: run({ status: "queued", processedLeads: 0 }), limit: 100 });
});

describe("bulk tracing from the queue", () => {
  it("offers to trace ONLY the doors with no number, and sends exactly those ids", async () => {
    renderQueue();
    const bar = await screen.findByTestId("bulk-trace");
    // Three rows on screen, one of which already has a number.
    expect(bar).toHaveTextContent("2 doors without a number");

    await userEvent.click(screen.getByTestId("bulk-trace-start"));
    await waitFor(() => expect(callingApi.startQueueTrace).toHaveBeenCalledWith([41, 42]));
  });

  it("says 'Not traced' on an untraced door - never the old enrichment wording", async () => {
    renderQueue();
    await screen.findByTestId("bulk-trace");
    expect(screen.getAllByText(/Not traced/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/enriched/i)).toBeNull();
  });

  it("hides the whole bar from someone who may dial but may not spend", async () => {
    // lead.skip_trace.request is the SPEND permission; a calling rep without it
    // must not be able to start a billed run.
    canSpend.mockImplementation((cap: string) => cap !== "lead.skip_trace.request");
    renderQueue();
    await screen.findByText("Fresh-fiber leads");
    expect(screen.queryByTestId("bulk-trace")).toBeNull();
  });

  it("shows live progress and refuses to start a second run while one is active", async () => {
    vi.mocked(callingApi.getLatestQueueTraceRun).mockResolvedValue({ run: run(), limit: 100 });
    renderQueue();
    const bar = await screen.findByTestId("bulk-trace");
    await waitFor(() => expect(bar).toHaveTextContent("1 of 2 done"));
    expect(bar).toHaveTextContent("2 dialable so far");
    expect(screen.getByTestId("bulk-trace-start")).toBeDisabled();
  });

  it("does not offer a run when every door already has a number", async () => {
    vi.mocked(callingApi.getCallingQueue).mockImplementation((options?: { source?: string }) =>
      Promise.resolve(options?.source === "traced" ? [] : [tracedRow]));
    renderQueue();
    await screen.findByText("Fresh-fiber leads");
    expect(screen.queryByTestId("bulk-trace")).toBeNull();
  });
});
