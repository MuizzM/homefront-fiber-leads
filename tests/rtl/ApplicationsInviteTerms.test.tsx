// ── The tier ladder is chosen when the invite is SENT ───────────────────────
//
// The invite form used to offer a "Tiered" button and no tiers. A manager could
// say TIERED and there was nowhere on the screen to say WHICH bands, so the
// invite carried the word and nothing else — and the contract and the pay
// engine each quietly filled the hole with the house ladder.
//
// The editor that solves this already existed; it was rendered only in the
// AGREEMENTS panel, behind approval, after the offer had been made. So the
// first test here asserts MOUNTING, not behaviour: a component that is shipped
// wired to nothing has happened repeatedly in this codebase, and every other
// assertion in this file would still pass if the editor rendered somewhere the
// invite form does not.
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { id: 1, name: "Admin", role: "admin" } }) }));
const apiRequest = vi.fn();
vi.mock("@/lib/queryClient", () => ({
  apiRequest: (...a: any[]) => apiRequest(...a),
  queryClient: { invalidateQueries: vi.fn() },
}));
const toast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));

import Applications from "../../client/src/pages/Applications";

const PIPELINE = {
  configured: true,
  summary: { total: 0, needsAction: 0, inProgress: 0, active: 0 },
  records: [],
};

function renderPage() {
  apiRequest.mockImplementation((method: string) => {
    if (method === "GET") return Promise.resolve({ json: () => Promise.resolve(PIPELINE) });
    return Promise.resolve({ json: () => Promise.resolve({ invitation: { candidateName: "Jordan Deal" } }) });
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><Applications /></QueryClientProvider>);
}

/** Everything asserted here must be INSIDE the invite form, not merely on the page. */
const inviteForm = () => within(screen.getByLabelText("Invite a candidate"));

function fillCandidate() {
  fireEvent.change(screen.getByTestId("input-candidate-name"), { target: { value: "Jordan Deal" } });
  fireEvent.change(screen.getByTestId("input-candidate-email"), { target: { value: "jordan@example.com" } });
}

const sendButton = () => screen.getByTestId("send-candidate-invite");
const invitePost = () => apiRequest.mock.calls.find(call => call[1] === "/api/onboarding/invitations");

beforeEach(() => { apiRequest.mockReset(); toast.mockReset(); });

describe("the invite form's comp terms", () => {
  it("MOUNTS the comp terms editor inside the invite form", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId("input-candidate-name")).toBeInTheDocument());

    // The editor itself, scoped to the invite section — not somewhere else on
    // the page, and not the agreements panel (which is gated behind approval
    // and has no selected record here).
    expect(inviteForm().getByTestId("comp-terms-editor")).toBeInTheDocument();
    // And its ladder controls, which are the whole point: a structure toggle
    // alone is what the form already had.
    expect(inviteForm().getByTestId("comp-tier-rows")).toBeInTheDocument();
    expect(inviteForm().getByTestId("comp-tier-0-rate")).toBeInTheDocument();
    expect(inviteForm().getByTestId("comp-tier-add")).toBeInTheDocument();
    // Exactly one editor on the page — a second copy would mean the send button
    // could be reading a different one than the manager is typing into.
    expect(screen.getAllByTestId("comp-terms-editor")).toHaveLength(1);
  });

  it("shows what the candidate's agreement will say, before it is sent", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId("input-candidate-name")).toBeInTheDocument());
    expect(inviteForm().getByTestId("comp-contract-preview").textContent).toMatch(/RETROACTIVE tier ladder/i);
  });

  it("THE REQUIREMENT: the edited ladder is what gets POSTed", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId("input-candidate-name")).toBeInTheDocument());
    fillCandidate();
    // Re-price the first band. Integer cents, from a dollars field.
    fireEvent.change(inviteForm().getByTestId("comp-tier-0-rate"), { target: { value: "175" } });
    fireEvent.click(sendButton());

    await waitFor(() => expect(invitePost()).toBeTruthy());
    const body = invitePost()![2] as any;
    expect(body.commissionStructure).toBe("TIERED");
    expect(body.tiers).toBeTruthy();
    expect(body.tiers[0].rateCents).toBe(17_500);
    // The whole ladder travels, not just the edited row.
    expect(body.tiers.length).toBeGreaterThan(1);
    expect(body.tiers[body.tiers.length - 1].maximumSales).toBeNull();
    // Cents, never dollars — every rate is a whole number of cents.
    for (const tier of body.tiers) expect(Number.isInteger(tier.rateCents)).toBe(true);
    // `id` is stripped: the invite schema is .strict() and would 400 on it.
    for (const tier of body.tiers) expect(tier).not.toHaveProperty("id");
  });

  it("a FLAT invite sends a rate and no ladder", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId("input-candidate-name")).toBeInTheDocument());
    fillCandidate();
    fireEvent.click(inviteForm().getByTestId("comp-structure-flat"));
    fireEvent.change(inviteForm().getByTestId("comp-flat-rate"), { target: { value: "225" } });
    fireEvent.click(sendButton());

    await waitFor(() => expect(invitePost()).toBeTruthy());
    const body = invitePost()![2] as any;
    expect(body.commissionStructure).toBe("FLAT");
    expect(body.flatRateCents).toBe(22_500);
    expect(body.tiers).toBeUndefined();
  });

  it("REFUSES to send an invalid ladder - the invite cannot be the half-configured thing again", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId("input-candidate-name")).toBeInTheDocument());
    fillCandidate();
    expect(sendButton()).not.toBeDisabled();

    // A ladder that does not start at 1 sale: validateTiers rejects it, so the
    // commission engine would refuse to pay against it and no contract may
    // state it.
    fireEvent.change(inviteForm().getByTestId("comp-tier-0-min"), { target: { value: "3" } });
    expect(inviteForm().getByTestId("comp-terms-errors")).toBeInTheDocument();
    expect(sendButton()).toBeDisabled();

    // Submitting the form directly (an Enter keypress does this, bypassing the
    // disabled button) must not send it either.
    fireEvent.submit(screen.getByTestId("input-candidate-name").closest("form")!);
    expect(invitePost()).toBeFalsy();

    // Fixed, and it sends again.
    fireEvent.change(inviteForm().getByTestId("comp-tier-0-min"), { target: { value: "1" } });
    expect(sendButton()).not.toBeDisabled();
    fireEvent.click(sendButton());
    await waitFor(() => expect(invitePost()).toBeTruthy());
  });
});
