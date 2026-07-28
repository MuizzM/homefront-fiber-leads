import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Route, Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import CallingLead from "@/pages/CallingLead";
import * as callingApi from "@/lib/callingApi";

vi.mock("@/lib/callingApi", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/callingApi")>();
  return {
    ...actual,
    getCallingStatus: vi.fn(),
    getCallingLead: vi.fn(),
    getLeadScript: vi.fn().mockRejectedValue(new Error("script endpoint not under test")),
    evaluateCallingLead: vi.fn(),
    authorizeManualCall: vi.fn(),
    startManualCall: vi.fn(),
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

const evaluation = {
  decision: "BLOCKED_AUTOMATED_DIAL_ATTEMPT" as const,
  eligible: false,
  reasonCodes: ["WIRELESS_REQUIRES_MANUAL_ACTION"],
  rules: [{ rule: "manual_human_action", passed: false, reasonCode: "WIRELESS_REQUIRES_MANUAL_ACTION" }],
  evaluatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 120_000).toISOString(),
  localTime: "10:30 AM EDT", timeZone: "America/New_York", ruleVersion: "rules-1",
};

const detail: callingApi.CallingLeadDetail = {
  candidate: {
    queueId: "queue-1", leadId: 7, address: "148 Maple St", city: "Lexington", state: "NC", zip: "27292",
    freshConfirmedAt: new Date().toISOString(), freshConfidence: "cross_verified", queueStage: "AWAITING_DNC_CHECK",
    priority: 90, assignedUserId: 1, contactId: 10, contactStatus: "VERIFIED_MATCH", contactName: "Possible resident",
    residentStatus: "POSSIBLE_RESIDENT", phoneId: 20, maskedPhone: "(•••) •••-0142", phoneValidationStatus: "VALID",
    phoneLastVerifiedAt: new Date().toISOString(), phoneVerificationExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    lineType: "wireless", reassignedRisk: false, identityConfidence: 0.93, wrongParty: false,
    providerConfigId: "provider-1", providerName: "Licensed provider", lastDecisionId: null,
    lastDecisionStatus: null, lastDecisionExpiresAt: null,
  },
  decision: null, consent: { id: null, verified: false, revoked: false }, timeline: [],
};

function renderLead() {
  window.location.hash = "#/calling/lead/7";
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <Router hook={useHashLocation}>
        <Route path="/calling/lead/:id"><CallingLead /></Route>
      </Router>
    </QueryClientProvider>,
  );
}

describe("Calling UI safety sequence", () => {
  beforeEach(() => {
    vi.mocked(callingApi.getCallingStatus).mockResolvedValue({
      enabled: true, callable: true, blockers: [],
      environment: { moduleEnabled: true, enrichmentEnabled: true, nationalDncEnabled: true, stateDncEnabled: true, manualClickRequired: true, pilotAllowed: true, secretsReady: true, emergencyDisabled: false },
      profile: { tenantId: 1, callingEnabled: true, emergencyDisabled: false, counselApproved: true, sellerAuthorized: true, sellerName: "Home Front Solutions", sellerAuthorizationRef: "seller-ref", stateRulesApproved: true, defaultTimeZone: "America/New_York", allowedStartLocal: "08:00", allowedEndLocal: "21:00", minimumIdentityConfidence: 0.85, maxAttempts7Days: 3, maxAttempts30Days: 6, dncMaxAgeDays: 31, callerIdAuthorized: true, callerIdReference: "caller-ref", policyVersion: 1 },
      dnc: { national: { id: "n-1", versionLabel: "daily", importedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), fresh: true }, states: [], internalCount: 0 },
      activeScript: script, activeRuleVersion: { id: "rules-1", version: "rules-1", approvedAt: new Date().toISOString() },
    });
    vi.mocked(callingApi.getCallingLead).mockResolvedValue(detail);
    vi.mocked(callingApi.evaluateCallingLead).mockResolvedValue({ decisionId: "decision-1", evaluation });
    vi.mocked(callingApi.authorizeManualCall).mockResolvedValue({ token: "one-use-token", expiresAt: new Date(Date.now() + 60_000).toISOString(), decisionId: "decision-1", maskedPhone: detail.candidate.maskedPhone!, script });
    vi.mocked(callingApi.startManualCall).mockResolvedValue({ attemptId: "attempt-1", phoneNumber: "+13365550142", script, noAutomaticNextCall: true });
  });

  it("keeps the phone masked until check + human confirmation + one-use start, and never creates a tel link", async () => {
    const user = userEvent.setup();
    const { container } = renderLead();
    expect(await screen.findByText("(•••) •••-0142")).toBeInTheDocument();
    expect(container).not.toHaveTextContent("+13365550142");
    expect(container.querySelector('a[href^="tel:"]')).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Run check" }));
    expect(await screen.findByText("Blocked Automated Dial Attempt")).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: /physically ready/i }));
    await user.click(screen.getByRole("button", { name: "Authorize one manual call" }));
    expect(await screen.findByText("One-use authorization ready")).toBeInTheDocument();
    expect(container).not.toHaveTextContent("+13365550142");

    await user.click(screen.getByRole("button", { name: "Reveal number & start manual attempt" }));
    expect(await screen.findByText("+13365550142")).toBeInTheDocument();
    expect(callingApi.startManualCall).toHaveBeenCalledWith("one-use-token");
    expect(container.querySelector('a[href^="tel:"]')).not.toBeInTheDocument();
    expect(screen.getByText(/No auto-dial, phone link, auto-next/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Manual attempt active")).toBeInTheDocument());
  });
});
