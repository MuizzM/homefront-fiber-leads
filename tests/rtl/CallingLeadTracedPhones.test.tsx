// Working every traced number on a door.
//
// The queue carries one number per household. A trace routinely returns three
// or four, so the rep needs a way to move the door onto the next one when the
// first is wrong-party — otherwise those numbers are stranded in the database.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
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
    getCallingQueue: vi.fn(),
    getCallingLead: vi.fn(),
    getLeadScript: vi.fn(),
    selectTracedPhone: vi.fn(),
  };
});

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: 1, name: "Calling Rep", email: "rep@example.test", role: "calling_rep", tenantId: 1 } }),
}));

vi.mock("@/lib/capabilities", () => ({ useCan: () => true }));

function option(over: Partial<callingApi.TracedPhoneOption>): callingApi.TracedPhoneOption {
  return {
    id: 1, masked: "(•••) •••-2001", lineType: "wireless", confidence: 0.95,
    ready: true, label: "OK to call", reasons: [], active: false, selectable: true,
    ...over,
  };
}

const tracedPhones = [
  option({ id: 1, masked: "(•••) •••-2001", active: true }),
  option({ id: 2, masked: "(•••) •••-2002", lineType: "landline", confidence: 0.8 }),
  option({ id: 3, masked: "(•••) •••-2003", ready: false, confidence: 0.7,
    label: "On the federal Do Not Call registry", reasons: ["federal_dnc"] }),
];

function candidate(over: Partial<callingApi.CallingCandidate> = {}): callingApi.CallingCandidate {
  return {
    queueId: "queue-7", leadId: 7, address: "1400 Multi St", city: "Lexington", state: "NC", zip: "27292",
    freshConfirmedAt: null, freshConfidence: null, traced: true, tracedBadge: null,
    queueStage: "AWAITING_DNC_CHECK", priority: 90, assignedUserId: 1, contactId: 10,
    contactStatus: "REVIEW_REQUIRED", contactName: "Traced owner", residentStatus: "OWNER_NOT_CONFIRMED_RESIDENT",
    phoneId: 20, maskedPhone: "(•••) •••-2001", phoneValidationStatus: "VALID",
    phoneLastVerifiedAt: new Date().toISOString(), phoneVerificationExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    lineType: "wireless", reassignedRisk: false, identityConfidence: 0.9, wrongParty: false,
    providerConfigId: "provider-tracerfy", providerName: "Tracerfy", lastDecisionId: null,
    lastDecisionStatus: null, lastDecisionExpiresAt: null,
    ...over,
  };
}

function leadDetail(over: Partial<callingApi.CallingLeadDetail> = {}): callingApi.CallingLeadDetail {
  return {
    candidate: candidate(), tracedPhones,
    decision: null, decisionError: null, consent: { id: null, verified: false, revoked: false },
    timeline: [], attempts: [], callbacks: [], openAttempt: null,
    ...over,
  };
}

const statusFixture = {
  enabled: true, callable: true, blockers: [],
  environment: { moduleEnabled: true, enrichmentEnabled: true, nationalDncEnabled: true, stateDncEnabled: true,
    manualClickRequired: true, pilotAllowed: true, secretsReady: true, emergencyDisabled: false },
  organization: { callingEnabled: true, emergencyDisabled: false, policyVersion: 1 },
  tracedImport: { available: true, contractStatus: "approved" },
  activeScript: { version: "2026-07-a", title: "Fresh fiber introduction" },
  activeRuleVersion: "rules-1", representativeHold: null,
} as Awaited<ReturnType<typeof callingApi.getCallingStatus>>;

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

describe("other numbers for this address", () => {
  beforeEach(() => {
    vi.mocked(callingApi.getCallingStatus).mockResolvedValue(statusFixture);
    vi.mocked(callingApi.getLeadScript).mockRejectedValue(new Error("no script"));
    vi.mocked(callingApi.getCallingQueue).mockResolvedValue([]);
    vi.mocked(callingApi.getCallingLead).mockResolvedValue(leadDetail());
    vi.mocked(callingApi.selectTracedPhone).mockResolvedValue({
      invalidatedAuthorizations: 1, alreadyActive: false, tracedPhones,
    });
  });

  it("lists every traced number with its verdict", async () => {
    renderLead();
    const panel = await screen.findByTestId("traced-phone-panel");
    expect(within(panel).getByTestId("traced-phone-1")).toBeInTheDocument();
    expect(within(panel).getByTestId("traced-phone-2")).toBeInTheDocument();
    expect(within(panel).getByTestId("traced-phone-3")).toHaveTextContent("On the federal Do Not Call registry");
    expect(panel).toHaveTextContent("3 numbers for this door, 2 of them clear");
  });

  it("marks the number the queue is carrying and offers no switch for it", async () => {
    renderLead();
    const active = await screen.findByTestId("traced-phone-1");
    expect(active).toHaveTextContent("Working");
    expect(within(active).queryByRole("button")).not.toBeInTheDocument();
  });

  it("switches the door onto another number", async () => {
    const user = userEvent.setup();
    renderLead();
    const row = await screen.findByTestId("traced-phone-2");
    await user.click(within(row).getByRole("button", { name: /use this/i }));
    await waitFor(() => expect(callingApi.selectTracedPhone).toHaveBeenCalledWith(7, 2));
  });

  it("keeps a suppressed number selectable so a rep can see it was tried", async () => {
    // Visible and switchable — the compliance gate blocks the dial, not the UI.
    // Hiding it would leave a rep unable to tell "no other numbers" from
    // "the other number is on the registry".
    renderLead();
    const blocked = await screen.findByTestId("traced-phone-3");
    expect(within(blocked).getByRole("button", { name: /use this/i })).toBeEnabled();
  });

  it("does not offer a number that cannot be normalized", async () => {
    vi.mocked(callingApi.getCallingLead).mockResolvedValue(leadDetail({
      tracedPhones: [
        option({ id: 1, active: true }),
        option({ id: 9, masked: "unusable number", selectable: false, ready: false, label: "Not DNC-checked yet" }),
      ],
    }));
    renderLead();
    const unusable = await screen.findByTestId("traced-phone-9");
    expect(within(unusable).getByRole("button", { name: /use this/i })).toBeDisabled();
  });

  it("stays out of the way when the door has only one number", async () => {
    vi.mocked(callingApi.getCallingLead).mockResolvedValue(leadDetail({
      tracedPhones: [option({ id: 1, active: true })],
    }));
    renderLead();
    await screen.findByText("1400 Multi St");
    expect(screen.queryByTestId("traced-phone-panel")).not.toBeInTheDocument();
  });
});
