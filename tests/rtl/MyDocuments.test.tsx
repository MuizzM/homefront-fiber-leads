// My Documents — the electronic-signature ceremony, pinned.
//
// This screen is where a rep's legally binding signature is created, and it had
// no fast test. The contract locked here is the one an ESIGN/UETA challenge
// would attack: the Sign button stays inert until the rep has reached the end
// of the agreement, ticked all three separate consents, AND typed a name; the
// screen never TELLS them which name to type (a field pre-filled with the
// answer proves nothing about who is at the keyboard); a mismatched name is
// refused by the server and surfaced, not swallowed; and declining requires a
// stated reason. The reading progress and the accessible skip-to-end path are
// covered too, because a gate keyboard and screen-reader users cannot pass is
// not a gate — it is a lockout.
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach, beforeAll } from "vitest";

const apiRequest = vi.fn();
vi.mock("@/lib/queryClient", () => ({
  apiRequest: (...a: any[]) => apiRequest(...a),
  queryClient: undefined,
}));
const toast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("@/lib/onboardingDocuments", () => ({ downloadOnboardingDocument: vi.fn() }));

import MyDocuments from "../../client/src/pages/MyDocuments";

const SIGNER_NAME = "Jordan Rep";
const CONTENT_SHA = "a".repeat(64);
const PDF_SHA = "b".repeat(64);

const ENVELOPE = {
  id: 7,
  documentType: "independent_contractor",
  status: "sent",
  signerName: SIGNER_NAME,
  sentAt: "2026-07-13T10:00:00.000Z",
  completedAt: null,
  failureReason: null,
  contentSha256: CONTENT_SHA,
  completedPdfSha256: null,
};

const CONTENT = {
  id: 7,
  recordId: "record-7",
  status: "sent",
  contentSha256: CONTENT_SHA,
  snapshot: {
    schemaVersion: 1,
    documentType: "independent_contractor",
    documentVersion: "v3",
    title: "Independent Contractor Agreement",
    companyName: "Home Front Solutions LLC",
    signerName: SIGNER_NAME,
    signerEmail: "jordan@example.com",
    issuedAt: "2026-07-13T10:00:00.000Z",
    sections: [
      { heading: "Engagement", paragraphs: ["The contractor performs field sales."] },
      { heading: "Compensation", paragraphs: ["Commissions are paid per approved install."] },
      { heading: "Conduct", paragraphs: ["Identify yourself at every door."] },
    ],
  },
  disclosure: { title: "Consent to electronic records and signatures", paragraphs: ["You may request a paper copy at no charge."] },
  consentVersion: "esign-disclosure-2026-07-v1",
};

function documentsPayload(over: Partial<typeof ENVELOPE> | null = {}) {
  return {
    configured: true,
    provider: "homefront_sign",
    documents: [{
      type: "independent_contractor",
      label: "Independent Contractor Agreement",
      description: "Engagement terms and contractor relationship.",
      required: true,
      version: "v3",
      envelope: over === null ? null : { ...ENVELOPE, ...over },
    }],
    progress: { completed: 0, total: 1 },
  };
}

let signError: string | null = null;
let declineError: string | null = null;
/** Lets one test serve a different agreement body than the shared fixture. */
let contentOverride: any = null;

function mockApi(payload: any) {
  apiRequest.mockImplementation((method: string, url: string, body?: any) => {
    if (url === "/api/onboarding/documents/me") return Promise.resolve({ json: () => Promise.resolve(payload) });
    if (url.endsWith("/content")) return Promise.resolve({ json: () => Promise.resolve(contentOverride ?? CONTENT) });
    if (url.endsWith("/sign")) {
      if (signError) return Promise.reject(new Error(signError));
      return Promise.resolve({ json: () => Promise.resolve({ signed: true, receiptSent: true, completedPdfSha256: PDF_SHA, document: { id: 7, status: "completed" }, typed: body?.typedName }) });
    }
    if (url.endsWith("/decline")) {
      if (declineError) return Promise.reject(new Error(declineError));
      return Promise.resolve({ json: () => Promise.resolve({ declined: true }) });
    }
    return Promise.resolve({ json: () => Promise.resolve({}) });
  });
}

function renderPage(payload: any = documentsPayload()) {
  mockApi(payload);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MyDocuments /></QueryClientProvider>);
}

async function openSigningDialog() {
  fireEvent.click(await screen.findByTestId("sign-document-independent_contractor"));
  await screen.findByTestId("signing-document-scroll");
}

function signButton() {
  return screen.getByTestId("complete-signature") as HTMLButtonElement;
}

function tickAllConsents() {
  fireEvent.click(screen.getByTestId("esign-consent"));
  fireEvent.click(screen.getByTestId("esign-read"));
  fireEvent.click(screen.getByTestId("esign-intent"));
}

beforeAll(() => {
  // jsdom reports every element as 0x0, which would make the agreement look
  // fully read the moment it renders. Give the scroll container real geometry
  // so the gate under test is the REAL gate.
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, value: 1200 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, value: 400 });
  Object.defineProperty(HTMLElement.prototype, "scrollTop", { configurable: true, writable: true, value: 0 });
  const proto = Element.prototype as any;
  if (!proto.setPointerCapture) proto.setPointerCapture = () => {};
  if (!proto.releasePointerCapture) proto.releasePointerCapture = () => {};
  if (!proto.hasPointerCapture) proto.hasPointerCapture = () => false;
  if (!window.matchMedia) {
    (window as any).matchMedia = () => ({
      matches: false, addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {},
    });
  }
});

beforeEach(() => {
  apiRequest.mockReset();
  toast.mockReset();
  signError = null;
  declineError = null;
  contentOverride = null;
});

describe("My Documents — the signing ceremony", () => {
  it("keeps signing disabled until the agreement is read, every consent is ticked, and a name is typed", async () => {
    renderPage();
    await openSigningDialog();
    expect(signButton().disabled).toBe(true);

    // Consents + name alone are not enough while the agreement is unread.
    tickAllConsents();
    fireEvent.change(screen.getByTestId("typed-signature"), { target: { value: SIGNER_NAME } });
    expect(signButton().disabled).toBe(true);
    expect(screen.getByTestId("signature-panel").textContent).toContain("Scroll through the complete agreement");

    // Reaching the end of the document is what releases it.
    const scroller = screen.getByTestId("signing-document-scroll");
    scroller.scrollTop = 900;
    fireEvent.scroll(scroller);
    await waitFor(() => expect(signButton().disabled).toBe(false));
  });

  it("re-locks the button if any single consent or the name is withdrawn", async () => {
    renderPage();
    await openSigningDialog();
    fireEvent.click(screen.getByTestId("skip-to-agreement-end"));
    tickAllConsents();
    fireEvent.change(screen.getByTestId("typed-signature"), { target: { value: SIGNER_NAME } });
    await waitFor(() => expect(signButton().disabled).toBe(false));

    for (const consent of ["esign-consent", "esign-read", "esign-intent"]) {
      fireEvent.click(screen.getByTestId(consent));
      expect(signButton().disabled).toBe(true);
      fireEvent.click(screen.getByTestId(consent));
      expect(signButton().disabled).toBe(false);
    }
    fireEvent.change(screen.getByTestId("typed-signature"), { target: { value: "" } });
    expect(signButton().disabled).toBe(true);
  });

  it("never hands the signer the name they are supposed to know", async () => {
    renderPage();
    await openSigningDialog();
    const input = screen.getByTestId("typed-signature") as HTMLInputElement;
    // Not pre-filled, and the placeholder is an instruction — not the answer.
    expect(input.value).toBe("");
    expect(input.placeholder).not.toContain(SIGNER_NAME);
    expect(input.placeholder).toMatch(/full legal name/i);
    // Nothing in the signature panel prints the expected name either, while the
    // label still tells them exactly what to type.
    const panel = screen.getByTestId("signature-panel");
    expect(panel.textContent).not.toContain(SIGNER_NAME);
    expect(within(panel).getByLabelText(/full legal name/i)).toBe(input);
  });

  it("surfaces the server's refusal when the typed name does not match", async () => {
    renderPage();
    signError = "Type your full name exactly as Jordan Rep";
    await openSigningDialog();
    fireEvent.click(screen.getByTestId("skip-to-agreement-end"));
    tickAllConsents();
    fireEvent.change(screen.getByTestId("typed-signature"), { target: { value: "J. Rep" } });
    await waitFor(() => expect(signButton().disabled).toBe(false));
    fireEvent.click(signButton());

    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: "Signature not completed",
      variant: "destructive",
    })));
    // The client does NOT decide the match — it sent the keystrokes verbatim.
    const signCall = apiRequest.mock.calls.find(call => String(call[1]).endsWith("/sign"));
    expect(signCall?.[2]).toMatchObject({ typedName: "J. Rep", documentSha256: CONTENT_SHA, intentToSign: true });
  });

  it("sends the typed name and the exact document hash it displayed", async () => {
    renderPage();
    await openSigningDialog();
    fireEvent.click(screen.getByTestId("skip-to-agreement-end"));
    tickAllConsents();
    fireEvent.change(screen.getByTestId("typed-signature"), { target: { value: "  jordan   REP " } });
    await waitFor(() => expect(signButton().disabled).toBe(false));
    fireEvent.click(signButton());

    await waitFor(() => expect(apiRequest.mock.calls.some(call => String(call[1]).endsWith("/sign"))).toBe(true));
    const signCall = apiRequest.mock.calls.find(call => String(call[1]).endsWith("/sign"))!;
    expect(signCall[2]).toEqual({
      typedName: "  jordan   REP ",
      documentSha256: CONTENT_SHA,
      consentToElectronicRecords: true,
      acknowledgeRead: true,
      intentToSign: true,
    });
  });

  it("requires a reason before a decline can be confirmed", async () => {
    renderPage();
    await openSigningDialog();
    fireEvent.click(screen.getByText("Decline"));
    const confirm = screen.getByText("Confirm decline").closest("button") as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("decline-reason"), { target: { value: "x" } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("decline-reason"), { target: { value: "I need to review this with counsel." } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith("POST", "/api/onboarding/documents/7/decline", { reason: "I need to review this with counsel." }));
  });

  it("reports reading progress and offers a keyboard path to the end", async () => {
    renderPage();
    await openSigningDialog();
    const bar = screen.getByRole("progressbar", { name: /reading progress/i });
    expect(bar.getAttribute("aria-valuenow")).toBe("0");
    expect(screen.getByTestId("reading-progress").textContent).toMatch(/Section 1 of 4/);

    const scroller = screen.getByTestId("signing-document-scroll");
    scroller.scrollTop = 400;
    fireEvent.scroll(scroller);
    await waitFor(() => expect(Number(bar.getAttribute("aria-valuenow"))).toBeGreaterThan(0));
    expect(Number(bar.getAttribute("aria-valuenow"))).toBeLessThan(100);

    // The skip control is a real button — reachable without a pointer — and it
    // both completes the gate and moves focus to the end of the document.
    fireEvent.click(screen.getByTestId("skip-to-agreement-end"));
    await waitFor(() => expect(bar.getAttribute("aria-valuenow")).toBe("100"));
    expect(screen.getByTestId("agreement-end-marker")).toHaveFocus();
    expect(screen.getByTestId("signature-panel").textContent).not.toContain("Scroll through the complete agreement");
  });

  it("prints the rate table the PDF prints, so the rep reads the document they sign", async () => {
    // Three renderers consume AgreementSection — the PDF body, the packet
    // cover, and this ceremony. A table that exists only in the PDF would break
    // the stated invariant that the reviewed document and the signed document
    // are the same instrument.
    contentOverride = {
      ...CONTENT,
      snapshot: {
        ...CONTENT.snapshot,
        sections: [
          {
            heading: "1. Parties and commission plan",
            paragraphs: ["Contractor is paid on a RETROACTIVE tier ladder."],
            rows: [
              { band: "1–6 qualified sales", rate: "$175 per sale" },
              { band: "7+ qualified sales", rate: "$260 per sale" },
            ],
          },
          ...CONTENT.snapshot.sections,
        ],
      },
    };
    renderPage();
    await openSigningDialog();
    const table = screen.getByTestId("agreement-rate-table");
    expect(within(table).getByText("1–6 qualified sales")).toBeInTheDocument();
    expect(within(table).getByText("$175 per sale")).toBeInTheDocument();
    expect(within(table).getByText("7+ qualified sales")).toBeInTheDocument();
    expect(within(table).getByText("$260 per sale")).toBeInTheDocument();
  });

  it("renders an agreement that has no rate table at all", async () => {
    // Every non-commission agreement, and every agreement issued before the
    // table existed.
    renderPage();
    await openSigningDialog();
    expect(screen.queryByTestId("agreement-rate-table")).toBeNull();
  });

  it("shows the completed PDF hash so the rep can verify their own copy", async () => {
    renderPage(documentsPayload({ status: "completed", completedAt: "2026-07-13T12:00:00.000Z", completedPdfSha256: PDF_SHA }));
    const line = await screen.findByTestId("completed-pdf-sha-independent_contractor");
    expect(line.textContent).toContain(PDF_SHA);
    expect(line.textContent).toContain("SHA-256");
  });
});
