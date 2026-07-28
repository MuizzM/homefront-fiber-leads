import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Route, Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import CallingQueue from "@/pages/CallingQueue";
import CallingLead from "@/pages/CallingLead";
import * as callingApi from "@/lib/callingApi";

vi.mock("@/lib/callingApi", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/callingApi")>();
  return {
    ...actual,
    getCallingStatus: vi.fn(),
    getCallingQueue: vi.fn(),
    getCallingCallbacks: vi.fn(),
    getCallingLead: vi.fn(),
    getLeadScript: vi.fn(),
    saveDisposition: vi.fn(),
    authorizeManualCall: vi.fn(),
  };
});

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: 1, name: "Calling Rep", email: "rep@example.test", role: "calling_rep", tenantId: 1 } }),
}));

const script = {
  id: "script-1", version: "2026-07-a", title: "Fresh fiber introduction",
  body: "Hello. New fiber is available near your service address.",
  disclosureSha256: "a".repeat(64), sellerName: "Home Front Solutions",
  companyName: "Home Front Solutions", purpose: "Fiber internet availability",
};

function candidate(over: Partial<callingApi.CallingCandidate>): callingApi.CallingCandidate {
  return {
    queueId: `queue-${over.leadId ?? 0}`, leadId: 0, address: "148 Maple St", city: "Lexington", state: "NC", zip: "27292",
    freshConfirmedAt: new Date().toISOString(), freshConfidence: "cross_verified", queueStage: "AWAITING_DNC_CHECK",
    priority: 90, assignedUserId: 1, contactId: 10, contactStatus: "VERIFIED_MATCH", contactName: "Possible resident",
    residentStatus: "POSSIBLE_RESIDENT", phoneId: 20, maskedPhone: "(•••) •••-0142", phoneValidationStatus: "VALID",
    phoneLastVerifiedAt: new Date().toISOString(), phoneVerificationExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    lineType: "wireless", reassignedRisk: false, identityConfidence: 0.93, wrongParty: false,
    providerConfigId: "provider-1", providerName: "Licensed provider", lastDecisionId: null,
    lastDecisionStatus: null, lastDecisionExpiresAt: null,
    ...over,
  };
}

const allQueue = [
  candidate({ queueId: "q1", leadId: 11, queueStage: "ELIGIBLE_MANUAL_CALL", address: "11 Oak Ave" }),
  candidate({ queueId: "q2", leadId: 12, queueStage: "ELIGIBLE_MANUAL_CALL", address: "12 Oak Ave" }),
  candidate({ queueId: "q3", leadId: 13, queueStage: "CALLBACK_SCHEDULED", address: "13 Pine Rd" }),
  candidate({ queueId: "q4", leadId: 14, queueStage: "COMPLIANCE_BLOCKED", address: "14 Elm St" }),
  candidate({ queueId: "q5", leadId: 15, queueStage: "COMPLIANCE_REVIEW", address: "15 Birch Ln" }),
];

function queueResponse(options?: { stage?: string }) {
  return options?.stage ? allQueue.filter(item => item.queueStage === options.stage) : allQueue;
}

function leadDetail(over: Partial<callingApi.CallingLeadDetail> = {}): callingApi.CallingLeadDetail {
  return {
    candidate: candidate({ queueId: "queue-7", leadId: 7 }),
    decision: null, decisionError: null, consent: { id: null, verified: false, revoked: false },
    timeline: [], attempts: [], callbacks: [], openAttempt: null,
    ...over,
  };
}

function renderApp(initialHash: string, path: string, page: React.ReactElement) {
  window.location.hash = initialHash;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <Router hook={useHashLocation}>
        <Route path={path}>{page}</Route>
      </Router>
    </QueryClientProvider>,
  );
}

const statusFixture: Awaited<ReturnType<typeof callingApi.getCallingStatus>> = {
  enabled: true, callable: true, blockers: [],
  environment: { moduleEnabled: true, enrichmentEnabled: true, nationalDncEnabled: true, stateDncEnabled: true, manualClickRequired: true, pilotAllowed: true, secretsReady: true, emergencyDisabled: false },
  organization: { callingEnabled: true, emergencyDisabled: false, policyVersion: 1 },
  activeScript: { version: "2026-07-a", title: "Fresh fiber introduction" },
  activeRuleVersion: "rules-1", representativeHold: null,
};

describe("CallingQueue stage chips", () => {
  beforeEach(() => {
    vi.mocked(callingApi.getCallingStatus).mockResolvedValue(statusFixture);
    vi.mocked(callingApi.getCallingQueue).mockImplementation((options?: { stage?: string }) => Promise.resolve(queueResponse(options)));
    vi.mocked(callingApi.getCallingCallbacks).mockResolvedValue([]);
  });

  it("shows All / Eligible / Callbacks / Blocked / Review chips with counts matching the queue data", async () => {
    renderApp("#/calling", "/calling", <CallingQueue />);
    await waitFor(() => expect(screen.getByTestId("stage-chip-all")).toHaveTextContent("5"));
    expect(screen.getByTestId("stage-chip-all")).toHaveTextContent("All");
    expect(screen.getByTestId("stage-chip-ELIGIBLE_MANUAL_CALL")).toHaveTextContent("Eligible2");
    expect(screen.getByTestId("stage-chip-CALLBACK_SCHEDULED")).toHaveTextContent("Callbacks1");
    expect(screen.getByTestId("stage-chip-COMPLIANCE_BLOCKED")).toHaveTextContent("Blocked1");
    expect(screen.getByTestId("stage-chip-COMPLIANCE_REVIEW")).toHaveTextContent("Review1");
  });

  it("filters the list to the selected chip's stage", async () => {
    const user = userEvent.setup();
    renderApp("#/calling", "/calling", <CallingQueue />);
    await waitFor(() => expect(screen.getByTestId("stage-chip-all")).toHaveTextContent("5"));
    await user.click(screen.getByTestId("stage-chip-ELIGIBLE_MANUAL_CALL"));
    expect(await screen.findByTestId("calling-lead-11")).toBeInTheDocument();
    expect(screen.getByTestId("calling-lead-12")).toBeInTheDocument();
    expect(screen.queryByTestId("calling-lead-13")).not.toBeInTheDocument();
  });
});

describe("CallingLead next-lead flow and phone gate", () => {
  beforeEach(() => {
    vi.mocked(callingApi.getCallingStatus).mockResolvedValue(statusFixture);
    vi.mocked(callingApi.getLeadScript).mockRejectedValue(new Error("not built yet"));
    vi.mocked(callingApi.getCallingQueue).mockImplementation((options?: { stage?: string }) => Promise.resolve(queueResponse(options)));
    vi.mocked(callingApi.saveDisposition).mockResolvedValue({ dispositionId: "disp-1", stage: "ATTEMPTED", replayed: false });
  });

  it("navigates the completion CTA to the first eligible lead, skipping the lead just dispositioned", async () => {
    const user = userEvent.setup();
    vi.mocked(callingApi.getCallingLead).mockResolvedValue(leadDetail({
      openAttempt: { attemptId: "attempt-1", startedAt: new Date().toISOString(), maskedPhone: "(•••) •••-0142", script },
    }));
    // Eligible fetch returns the just-dispositioned lead first (stale snapshot)
    // — the CTA must skip it and take lead 42.
    vi.mocked(callingApi.getCallingQueue).mockImplementation((options?: { stage?: string }) => Promise.resolve(
      options?.stage === "ELIGIBLE_MANUAL_CALL"
        ? [candidate({ queueId: "q7", leadId: 7 }), candidate({ queueId: "q42", leadId: 42, address: "42 Cedar Ct" })]
        : allQueue,
    ));

    renderApp("#/calling/lead/7", "/calling/lead/:id", <CallingLead />);
    const quickBar = await screen.findByTestId("calling-quick-dispositions");
    await user.click(within(quickBar).getByRole("button", { name: "No answer" }));
    expect(await screen.findByText("Outcome saved")).toBeInTheDocument();

    await user.click(screen.getByTestId("next-eligible-lead"));
    expect(callingApi.getCallingQueue).toHaveBeenCalledWith({ stage: "ELIGIBLE_MANUAL_CALL", limit: 25 });
    await waitFor(() => expect(window.location.hash).toBe("#/calling/lead/42"));
  });

  it("falls back to the queue when no eligible lead remains", async () => {
    const user = userEvent.setup();
    vi.mocked(callingApi.getCallingLead).mockResolvedValue(leadDetail({
      openAttempt: { attemptId: "attempt-1", startedAt: new Date().toISOString(), maskedPhone: "(•••) •••-0142", script },
    }));
    vi.mocked(callingApi.getCallingQueue).mockResolvedValue([]);

    renderApp("#/calling/lead/7", "/calling/lead/:id", <CallingLead />);
    const quickBar = await screen.findByTestId("calling-quick-dispositions");
    await user.click(within(quickBar).getByRole("button", { name: "No answer" }));
    await user.click(await screen.findByTestId("next-eligible-lead"));
    await waitFor(() => expect(window.location.hash).toBe("#/calling"));
  });

  it("keeps the call authorization button disabled for a lead with no phone, even when eligible", async () => {
    const user = userEvent.setup();
    vi.mocked(callingApi.getCallingLead).mockResolvedValue(leadDetail({
      candidate: candidate({ queueId: "queue-7", leadId: 7, phoneId: null, maskedPhone: null }),
      decision: {
        id: "decision-1", finalStatus: "ELIGIBLE_MANUAL_CALL", eligible: true, reasonCodes: [], rules: [],
        evaluatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 120_000).toISOString(),
        localTime: null, timeZone: "America/New_York", ruleVersion: "rules-1",
      },
    }));

    renderApp("#/calling/lead/7", "/calling/lead/:id", <CallingLead />);
    await user.click(await screen.findByRole("checkbox", { name: /physically ready/i }));
    const authorize = screen.getByRole("button", { name: "Authorize one manual call" });
    expect(authorize).toBeDisabled();
    expect(callingApi.authorizeManualCall).not.toHaveBeenCalled();
  });
});
