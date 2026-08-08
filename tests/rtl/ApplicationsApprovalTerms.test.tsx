// ── Approving must pay the ladder the candidate was invited on ──────────────
//
// The invite form got a tier ladder. The APPROVAL panel did not: it was still
// a TIERED/FLAT toggle and a flat-rate dollar string, with nowhere to state
// bands — the same hole, one screen later, and this one is worse.
//
// The console always sends a `commission` object when it approves, and the
// server only falls back to the invite's stored ladder when that object is
// ABSENT (routes.ts: `if (status === "approved" && !commission && ...)`). So
// `{ structure: "TIERED" }` from this panel was not "no opinion" — it OUTRANKED
// the invited bands, assignStructureToRep saw no tiers and fell through to
// getOrCreateStandardTieredVersion, and the rep who signed 1-6 at $175 was paid
// $150. The invite-side integration test never caught it because it approves
// with `{ status: "approved" }` and no commission at all — a path the console
// does not use.
//
// So the first test asserts MOUNTING (a ladder editor, inside the review
// panel), and the rest assert that what the reviewer sees is what gets sent.
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

// The bands the manager chose at invite time: 1-6 at $175, 7+ at $225. Neither
// row matches the house ladder, so a payload carrying the house one is visible
// rather than coincidentally equal.
const INVITED_TIERS = [
  { position: 0, minimumSales: 1, maximumSales: 6, rateCents: 17_500, label: "" },
  { position: 1, minimumSales: 7, maximumSales: null, rateCents: 22_500, label: "" },
];

function record(invite: Record<string, unknown> | null) {
  return {
    key: "invite:1",
    inviteId: 1,
    applicationId: 42,
    candidateName: "Jordan Deal",
    candidateEmail: "jordan@example.com",
    source: "invited",
    desiredRole: "Field rep",
    stage: "under_review",
    progress: { completed: 2, total: 7 },
    milestones: {
      invited: true, applied: true, approved: false, loginCodeSent: false,
      agreementsIssued: false, signedCount: 0, fullySigned: false, active: false,
    },
    invite: invite && {
      status: "applied", sentAt: "2026-08-01T12:00:00.000Z", expiresAt: "2026-08-15T12:00:00.000Z",
      deliveryAttempts: 1, failureReason: null, secureUrl: "https://example.test/apply/token",
      ...invite,
    },
    application: {
      status: "pending", phone: "555-0100", city: "Lexington", state: "KY", zip: "40502",
      preferredCarriers: "Kinetic", hasSalesExperience: true, salesExperienceDetails: null,
      referralSource: null, headshotPath: null, licensePath: null, reviewNotes: null,
      createdAt: "2026-08-02T12:00:00.000Z",
    },
    account: null,
    documents: [],
    hr: { cleared: 0, total: 4, allClear: false, anyFailed: false, checkpoints: [] },
    timeline: Array.from({ length: 7 }, (_, i) => ({ label: `Step ${i + 1}`, at: "", done: i < 2 })),
  };
}

function renderPage(invite: Record<string, unknown> | null) {
  const pipeline = {
    configured: true,
    gustoConfigured: false,
    summary: { total: 1, needsAction: 1, inProgress: 0, active: 0 },
    records: [record(invite)],
  };
  apiRequest.mockImplementation((method: string) => {
    if (method === "GET") return Promise.resolve({ json: () => Promise.resolve(pipeline) });
    return Promise.resolve({ json: () => Promise.resolve({}) });
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><Applications /></QueryClientProvider>);
}

const TIERED_INVITE = {
  commissionStructure: "TIERED", flatRateCents: null,
  reservePercent: 15, reserveCapCents: 300_000, commissionTiers: INVITED_TIERS,
};

/** Scoped to the review panel — the invite form has its own editor on the same page. */
const reviewPanel = () => within(screen.getByTestId("review-comp-terms"));
const approve = () => screen.getByTestId("approve-start-onboarding");
/** Approve is arm-then-confirm now (it assigns pay + issues agreements), so a
 *  test that "approves" clicks twice: once to arm, once to fire. */
const approveTwice = () => { fireEvent.click(approve()); fireEvent.click(approve()); };
const approvalPatch = () => apiRequest.mock.calls.find(
  call => call[0] === "PATCH" && call[1] === "/api/onboarding/applications/42");

// The panel appearing is not the same as the panel being SEEDED: the invited
// terms arrive with the pipeline query and land through an effect, one commit
// later. Waiting only for the element let a click read the house default, so
// every test here waits for the first band's rate it expects to be looking at.
async function ready(firstBandRate = "175") {
  await waitFor(() => expect(screen.getByTestId("review-comp-terms")).toBeInTheDocument());
  await waitFor(() => expect(
    (reviewPanel().getByTestId("comp-tier-0-rate") as HTMLInputElement).value,
  ).toBe(firstBandRate));
}

beforeEach(() => { apiRequest.mockReset(); toast.mockReset(); });

describe("the approval panel's comp terms", () => {
  it("MOUNTS a ladder editor inside the review panel", async () => {
    renderPage(TIERED_INVITE);
    await ready();

    expect(reviewPanel().getByTestId("comp-terms-editor")).toBeInTheDocument();
    expect(reviewPanel().getByTestId("comp-tier-rows")).toBeInTheDocument();
    expect(reviewPanel().getByTestId("comp-tier-0-rate")).toBeInTheDocument();
    // Two editors on the page now (invite form + review panel) and no more: a
    // third would mean the approve button might be reading one the reviewer is
    // not typing into.
    expect(screen.getAllByTestId("comp-terms-editor")).toHaveLength(2);
  });

  it("opens on the INVITED ladder, not the house default", async () => {
    renderPage(TIERED_INVITE);
    await ready();

    expect((reviewPanel().getByTestId("comp-tier-0-rate") as HTMLInputElement).value).toBe("175");
    expect((reviewPanel().getByTestId("comp-tier-0-max") as HTMLInputElement).value).toBe("6");
    expect((reviewPanel().getByTestId("comp-tier-1-rate") as HTMLInputElement).value).toBe("225");
    // The reserve travelled too — it is part of the same offer.
    expect((reviewPanel().getByTestId("comp-reserve-percent") as HTMLInputElement).value).toBe("15");
    expect((reviewPanel().getByTestId("comp-reserve-cap") as HTMLInputElement).value).toBe("3000");
  });

  it("THE REQUIREMENT: approving sends the ladder, so the rep is PAID what they signed", async () => {
    renderPage(TIERED_INVITE);
    await ready();
    approveTwice();

    await waitFor(() => expect(approvalPatch()).toBeTruthy());
    const body = approvalPatch()![2] as any;
    expect(body.status).toBe("approved");
    expect(body.commission.structure).toBe("TIERED");
    // Without this the server assigns the house bands — the whole bug.
    expect(body.commission.tiers).toHaveLength(2);
    expect(body.commission.tiers[0].rateCents).toBe(17_500);
    expect(body.commission.tiers[1].rateCents).toBe(22_500);
    expect(body.commission.tiers[1].maximumSales).toBeNull();
    for (const tier of body.commission.tiers) expect(Number.isInteger(tier.rateCents)).toBe(true);
    // The reserve is set in the same action that sets the rate.
    expect(body.commission.reservePercent).toBe(15);
    expect(body.commission.reserveCapCents).toBe(300_000);
  });

  it("a reviewer's edit is what gets sent, not the invited ladder", async () => {
    renderPage(TIERED_INVITE);
    await ready();
    fireEvent.change(reviewPanel().getByTestId("comp-tier-0-rate"), { target: { value: "190" } });
    approveTwice();

    await waitFor(() => expect(approvalPatch()).toBeTruthy());
    expect((approvalPatch()![2] as any).commission.tiers[0].rateCents).toBe(19_000);
  });

  it("switching to FLAT sends a rate and no ladder", async () => {
    renderPage(TIERED_INVITE);
    await ready();
    fireEvent.click(reviewPanel().getByTestId("comp-structure-flat"));
    fireEvent.change(reviewPanel().getByTestId("comp-flat-rate"), { target: { value: "200" } });
    approveTwice();

    await waitFor(() => expect(approvalPatch()).toBeTruthy());
    const body = approvalPatch()![2] as any;
    expect(body.commission.structure).toBe("FLAT");
    expect(body.commission.flatRateCents).toBe(20_000);
    expect(body.commission.tiers).toBeUndefined();
  });

  it("REFUSES to approve on a ladder the commission engine would not pay against", async () => {
    renderPage(TIERED_INVITE);
    await ready();
    expect(approve()).not.toBeDisabled();

    // A ladder that does not start at 1 sale.
    fireEvent.change(reviewPanel().getByTestId("comp-tier-0-min"), { target: { value: "3" } });
    expect(reviewPanel().getByTestId("comp-terms-errors")).toBeInTheDocument();
    expect(approve()).toBeDisabled();
    approveTwice();
    expect(approvalPatch()).toBeFalsy();
  });

  it("an application with no invited terms opens on the house default", async () => {
    // A careers/public-join applicant, or a pre-ladder invite row. These have
    // always been given the house plan; the panel must say so rather than
    // inventing a ladder.
    renderPage({ commissionStructure: null, flatRateCents: null, reservePercent: null, reserveCapCents: null, commissionTiers: null });
    await ready("150");

    expect(screen.getByTestId("review-comp-terms").textContent).toMatch(/No terms travelled with this application/i);

    approveTwice();
    await waitFor(() => expect(approvalPatch()).toBeTruthy());
    // Still an explicit, complete instrument — the ladder is stated even when
    // it is the house one, because a bare `{ structure: "TIERED" }` is what let
    // the server's invite fallback be silently outranked.
    expect((approvalPatch()![2] as any).commission.tiers.length).toBeGreaterThan(0);
  });
});
