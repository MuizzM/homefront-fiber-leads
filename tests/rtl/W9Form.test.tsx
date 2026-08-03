// ── Tax & direct deposit: the rep-facing W-9 and bank surface ────────────────
// This is the screen a newly-hired contractor uses to certify their taxpayer
// identity under penalties of perjury and to tell the company where their money
// goes. The properties pinned here are the ones that, if they broke, would let
// a rep file a false certification or send their pay to the wrong account:
//
//   * nothing submits until the REQUIRED answers exist — including the Line 3a
//     classification and the Part II backup-withholding question, neither of
//     which the server will infer,
//   * "LLC" is not an answer on its own (C/S/P), and neither is "Other" (a
//     description),
//   * the account number must be typed twice and agree,
//   * the full SSN and the full account number never survive submission in the
//     DOM — only the server's masked view,
//   * a server 400 (e.g. W9_NAME_NOT_PRINTABLE) reaches the rep's eyes.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiRequest = vi.fn();
vi.mock("@/lib/queryClient", () => ({
  apiRequest: (...args: any[]) => apiRequest(...args),
  queryClient: undefined,
}));

import TaxAndPay from "../../client/src/pages/TaxAndPay";

const SSN = "123456789";
const ACCOUNT = "000123456789";
// A real ABA number: 3(0+2+0)+7(1+0+0)+(1+0+2) = 6+7+3 = 16 … use a known-good
// Fed routing number instead of hand-rolling one.
const ROUTING = "021000021"; // JPMorgan Chase, passes the 3-7-1 checksum

const W9_STATUS = {
  submitted: true as const,
  w9Id: 7,
  legalName: "Dana Fieldrep",
  businessName: null,
  tinType: "ssn",
  tinMasked: "***-**-6789",
  taxClassification: "individual" as const,
  llcTaxClass: null,
  otherClassification: null,
  foreignPartners: false,
  exemptPayeeCode: null,
  fatcaExemptionCode: null,
  subjectToBackupWithholding: false,
  signatureName: "Dana Fieldrep",
  signatureDate: "2026-08-03T12:00:00.000Z",
  createdAt: "2026-08-03T12:00:00.000Z",
};

const BANK_STATUS = { last4: "6789", accountType: "checking", status: "active", updatedAt: "2026-08-03T12:00:00.000Z" };

const notFound = (what: string) => Object.assign(new Error(`404: No ${what} on file`), { status: 404 });
const ok = (body: unknown) => Promise.resolve({ json: () => Promise.resolve(body), blob: () => Promise.resolve(new Blob()) });

interface Wiring {
  w9?: any;
  bank?: any;
  onPostW9?: (body: any) => Promise<any>;
  onPutBank?: (body: any) => Promise<any>;
}

/** Stateful fake of the pay plane: a GET reflects whatever the last accepted
 *  write stored, exactly like the real server. */
function wire({ w9 = null, bank = null, onPostW9, onPutBank }: Wiring = {}) {
  let w9State = w9;
  let bankState = bank;
  const postW9 = vi.fn(async (body: any) => {
    if (onPostW9) return onPostW9(body);
    w9State = W9_STATUS;
    return W9_STATUS;
  });
  const putBank = vi.fn(async (body: any) => {
    if (onPutBank) return onPutBank(body);
    bankState = BANK_STATUS;
    return BANK_STATUS;
  });

  apiRequest.mockImplementation(async (method: string, url: string, body?: any) => {
    if (method === "GET" && url === "/api/me/w9") {
      if (!w9State) throw notFound("W-9");
      return ok(w9State);
    }
    if (method === "GET" && url === "/api/me/bank") {
      if (!bankState) throw notFound("bank details");
      return ok(bankState);
    }
    if (method === "POST" && url === "/api/me/w9") return ok(await postW9(body));
    if (method === "PUT" && url === "/api/me/bank") return ok(await putBank(body));
    throw Object.assign(new Error(`404: unexpected ${method} ${url}`), { status: 404 });
  });

  return { postW9, putBank };
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><TaxAndPay /></QueryClientProvider>);
}

async function w9FormReady() {
  return await screen.findByTestId("w9-form");
}

const type = async (testId: string, value: string) => {
  await userEvent.clear(screen.getByTestId(testId));
  await userEvent.type(screen.getByTestId(testId), value);
};

/** Fills every REQUIRED W-9 answer. Callers skip a step by passing `skip`. */
async function fillW9(skip: { classification?: boolean; backupWithholding?: boolean } = {}) {
  await type("input-legal-name", "Dana Fieldrep");
  if (!skip.classification) await userEvent.click(screen.getByTestId("classification-individual"));
  await type("input-address-line1", "742 Evergreen Ter");
  await type("input-city", "Charlotte");
  await type("input-state", "NC");
  await type("input-zip", "28202");
  await type("input-tin", SSN);
  if (!skip.backupWithholding) await userEvent.click(screen.getByTestId("backup-withholding-no"));
  await userEvent.click(screen.getByTestId("w9-consent"));
  await type("input-signature-name", "Dana Fieldrep");
}

async function fillBank(over: { account?: string; confirm?: string; routing?: string } = {}) {
  await type("input-routing", over.routing ?? ROUTING);
  await type("input-account", over.account ?? ACCOUNT);
  await type("input-account-confirm", over.confirm ?? ACCOUNT);
  await userEvent.click(screen.getByTestId("account-type-checking"));
}

// NOTE the braces: a beforeEach that RETURNS a value hands vitest a teardown
// callback, and mockReset() returns the mock — vitest would then invoke
// apiRequest() with no arguments after every test.
beforeEach(() => { apiRequest.mockReset(); });

describe("W-9: submit is blocked until the required answers exist", () => {
  it("refuses to submit an empty form and says so", async () => {
    const { postW9 } = wire();
    renderPage();
    await w9FormReady();

    await userEvent.click(screen.getByTestId("w9-submit"));

    expect(postW9).not.toHaveBeenCalled();
    expect(screen.getByTestId("w9-validation-summary")).toBeInTheDocument();
    expect(screen.getByTestId("error-taxClassification")).toBeInTheDocument();
    expect(screen.getByTestId("error-backupWithholding")).toBeInTheDocument();
  });

  it("blocks a form that is complete except for the tax classification", async () => {
    const { postW9 } = wire();
    renderPage();
    await w9FormReady();

    await fillW9({ classification: true });
    await userEvent.click(screen.getByTestId("w9-submit"));

    expect(postW9).not.toHaveBeenCalled();
    expect(screen.getByTestId("error-taxClassification").textContent).toMatch(/federal tax classification/i);
  });

  it("blocks a form that is complete except for the backup-withholding answer", async () => {
    const { postW9 } = wire();
    renderPage();
    await w9FormReady();

    await fillW9({ backupWithholding: true });
    await userEvent.click(screen.getByTestId("w9-submit"));

    expect(postW9).not.toHaveBeenCalled();
    expect(screen.getByTestId("error-backupWithholding").textContent).toMatch(/explicit yes or no/i);
  });

  it("asks the backup-withholding question in plain English, unanswered by default", async () => {
    wire();
    renderPage();
    await w9FormReady();

    expect(screen.getByText(/Has the IRS notified you that you are subject to backup withholding\?/i)).toBeInTheDocument();
    expect(screen.getByText(/24% of every payout is withheld/i)).toBeInTheDocument();
    expect((screen.getByTestId("backup-withholding-no") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByTestId("backup-withholding-yes") as HTMLInputElement).checked).toBe(false);
  });

  it("sends the whole certification, and the answers, once every field is valid", async () => {
    const { postW9 } = wire();
    renderPage();
    await w9FormReady();

    await fillW9();
    await userEvent.click(screen.getByTestId("w9-submit"));

    await waitFor(() => expect(postW9).toHaveBeenCalledTimes(1));
    expect(postW9.mock.calls[0][0]).toMatchObject({
      legalName: "Dana Fieldrep",
      taxClassification: "individual",
      subjectToBackupWithholding: false,
      consent: true,
      signatureName: "Dana Fieldrep",
      tin: SSN,
      tinType: "ssn",
      address: { line1: "742 Evergreen Ter", city: "Charlotte", state: "NC", zip: "28202" },
    });
  });
});

describe("W-9: the conditional Line 3a answers", () => {
  it("LLC is not an answer on its own — the C/S/P letter is required", async () => {
    const { postW9 } = wire();
    renderPage();
    await w9FormReady();

    await fillW9({ classification: true });
    await userEvent.click(screen.getByTestId("classification-llc"));
    expect(screen.getByTestId("llc-followup")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("w9-submit"));
    expect(postW9).not.toHaveBeenCalled();
    expect(screen.getByTestId("error-llcTaxClass").textContent).toMatch(/C, S or P/);

    await userEvent.click(screen.getByTestId("llc-class-S"));
    await userEvent.click(screen.getByTestId("w9-submit"));
    await waitFor(() => expect(postW9).toHaveBeenCalledTimes(1));
    expect(postW9.mock.calls[0][0]).toMatchObject({ taxClassification: "llc", llcTaxClass: "S" });
  });

  it("Other requires a description, and the LLC letter is never sent with it", async () => {
    const { postW9 } = wire();
    renderPage();
    await w9FormReady();

    await fillW9({ classification: true });
    await userEvent.click(screen.getByTestId("classification-other"));
    await userEvent.click(screen.getByTestId("w9-submit"));

    expect(postW9).not.toHaveBeenCalled();
    expect(screen.getByTestId("error-w9-other-classification")).toBeInTheDocument();

    await type("input-other-classification", "Nonprofit association");
    await userEvent.click(screen.getByTestId("w9-submit"));
    await waitFor(() => expect(postW9).toHaveBeenCalledTimes(1));
    const body = postW9.mock.calls[0][0];
    expect(body).toMatchObject({ taxClassification: "other", otherClassification: "Nonprofit association" });
    expect(body.llcTaxClass).toBeUndefined();
  });

  it("explains each classification in plain language rather than only naming it", async () => {
    wire();
    renderPage();
    await w9FormReady();

    expect(screen.getByText(/report this income on Schedule C/i)).toBeInTheDocument();
    expect(screen.getByText(/elected S-corporation status/i)).toBeInTheDocument();
  });
});

describe("W-9: the signer can read what they are certifying", () => {
  it("renders the Part II certification text, not a blind checkbox", async () => {
    wire();
    renderPage();
    await w9FormReady();

    const certification = screen.getByTestId("w9-certification-text");
    expect(within(certification).getByText(/Under penalties of perjury, I certify that:/i)).toBeInTheDocument();
    expect(certification.textContent).toContain("correct taxpayer identification number");
    expect(certification.textContent).toContain("I am a U.S. citizen or other U.S. person");
    expect(certification.textContent).toMatch(/cross out item 2/i);
  });

  it("strikes item 2 the moment the rep says they ARE subject to backup withholding", async () => {
    wire();
    renderPage();
    await w9FormReady();

    const item2 = () => screen.getByTestId("certification-item-2").querySelector("span")!;
    expect(item2.call(null).className).not.toMatch(/line-through/);

    await userEvent.click(screen.getByTestId("backup-withholding-yes"));
    expect(item2.call(null).className).toMatch(/line-through/);
  });
});

describe("W-9: the full TIN never survives submission", () => {
  it("shows only the server's masked value once the form is filed", async () => {
    wire();
    const { container } = renderPage();
    await w9FormReady();

    await fillW9();
    await userEvent.click(screen.getByTestId("w9-submit"));

    await screen.findByTestId("w9-filed");
    expect(screen.getByTestId("w9-tin-masked").textContent).toBe("***-**-6789");
    expect(container.innerHTML).not.toContain(SSN);
    expect(document.body.innerHTML).not.toContain(SSN);
    expect(screen.queryByTestId("input-tin")).toBeNull();
  });

  it("masks the TIN while it is being typed", async () => {
    wire();
    renderPage();
    await w9FormReady();

    const tin = screen.getByTestId("input-tin") as HTMLInputElement;
    expect(tin.type).toBe("password");
    await userEvent.type(tin, SSN);
    expect(tin.type).toBe("password");

    await userEvent.click(screen.getByTestId("toggle-tin-visibility"));
    expect((screen.getByTestId("input-tin") as HTMLInputElement).type).toBe("text");
  });

  it("renders the filed summary: classification, masked TIN, and a download link", async () => {
    wire({ w9: W9_STATUS });
    renderPage();

    await screen.findByTestId("w9-filed");
    expect(screen.getByTestId("w9-tin-masked").textContent).toBe("***-**-6789");
    expect(screen.getByTestId("w9-download")).toBeInTheDocument();
    expect(screen.getByText(/Individual \/ sole proprietor/i)).toBeInTheDocument();
  });
});

describe("W-9: the server stays authoritative", () => {
  it("surfaces a server 400 to the rep, verbatim", async () => {
    wire({
      onPostW9: async () => {
        throw Object.assign(
          new Error('400: legalName contains character(s) the IRS Form W-9 cannot print ("张" (U+5F20)). The official form is filled with a Latin-alphabet font. Please enter the Latin (romanized) spelling of the name exactly as it appears on your Social Security card or IRS notice.'),
          { status: 400 },
        );
      },
    });
    renderPage();
    await w9FormReady();

    await fillW9();
    await userEvent.click(screen.getByTestId("w9-submit"));

    const alert = await screen.findByTestId("w9-server-error");
    expect(alert.textContent).toMatch(/romanized/);
    // The HTTP status prefix is stripped — the rep reads the sentence, not a code.
    expect(alert.textContent).not.toMatch(/^400:/);
    // and the form is still on screen with their answers intact
    expect(screen.getByTestId("w9-form")).toBeInTheDocument();
  });
});

describe("direct deposit", () => {
  it("requires the account number to match its confirmation", async () => {
    const { putBank } = wire();
    renderPage();
    await screen.findByTestId("bank-form");

    await fillBank({ confirm: "000123456780" });
    await userEvent.click(screen.getByTestId("bank-submit"));

    expect(putBank).not.toHaveBeenCalled();
    expect(screen.getByTestId("error-bank-account-confirm").textContent).toMatch(/do not match/i);

    await type("input-account-confirm", ACCOUNT);
    await userEvent.click(screen.getByTestId("bank-submit"));
    await waitFor(() => expect(putBank).toHaveBeenCalledTimes(1));
    expect(putBank.mock.calls[0][0]).toMatchObject({ routing: ROUTING, account: ACCOUNT, accountType: "checking" });
  });

  it("catches a routing number that fails the ABA checksum before the server sees it", async () => {
    const { putBank } = wire();
    renderPage();
    await screen.findByTestId("bank-form");

    await fillBank({ routing: "021000022" }); // one digit off — checksum fails
    await userEvent.click(screen.getByTestId("bank-submit"));

    expect(putBank).not.toHaveBeenCalled();
    expect(screen.getByTestId("error-bank-routing").textContent).toMatch(/checksum/i);
  });

  it("requires an account type", async () => {
    const { putBank } = wire();
    renderPage();
    await screen.findByTestId("bank-form");

    await type("input-routing", ROUTING);
    await type("input-account", ACCOUNT);
    await type("input-account-confirm", ACCOUNT);
    await userEvent.click(screen.getByTestId("bank-submit"));

    expect(putBank).not.toHaveBeenCalled();
    expect(screen.getByTestId("error-accountType")).toBeInTheDocument();
  });

  it("shows only last4 + type after saving — never the account number again", async () => {
    wire();
    const { container } = renderPage();
    await screen.findByTestId("bank-form");

    await fillBank();
    await userEvent.click(screen.getByTestId("bank-submit"));

    await screen.findByTestId("bank-saved");
    expect(screen.getByTestId("bank-last4").textContent).toContain("6789");
    expect(container.innerHTML).not.toContain(ACCOUNT);
    expect(document.body.innerHTML).not.toContain(ACCOUNT);
    expect(screen.queryByTestId("input-account")).toBeNull();
  });

  it("surfaces a server rejection of the bank details", async () => {
    wire({
      onPutBank: async () => {
        throw Object.assign(new Error("400: routing must be a valid 9-digit ABA transit number (checksum failed)"), { status: 400 });
      },
    });
    renderPage();
    await screen.findByTestId("bank-form");

    await fillBank();
    await userEvent.click(screen.getByTestId("bank-submit"));

    const alert = await screen.findByTestId("bank-server-error");
    expect(alert.textContent).toMatch(/ABA transit number/);
  });
});

describe("page states", () => {
  it("shows a skeleton while the pay profile is loading", async () => {
    apiRequest.mockImplementation(() => new Promise(() => {})); // never settles
    renderPage();
    expect(await screen.findAllByTestId("section-skeleton")).toHaveLength(2);
  });

  it("explains the dead end when no rep profile is linked to the login", async () => {
    apiRequest.mockImplementation(async () => {
      throw Object.assign(new Error("400: No rep profile linked to your login."), { status: 400 });
    });
    renderPage();
    expect(await screen.findByTestId("no-rep-profile")).toBeInTheDocument();
    expect(screen.queryByTestId("w9-form")).toBeNull();
  });

  it("offers a retry when the profile cannot be loaded at all", async () => {
    apiRequest.mockImplementation(async () => {
      throw Object.assign(new Error("500: database is locked"), { status: 500 });
    });
    renderPage();
    expect(await screen.findAllByText(/Try again/i)).not.toHaveLength(0);
  });
});

describe("house style", () => {
  it("renders no emoji anywhere on the screen", async () => {
    const PICTO = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{1F1E6}-\u{1F1FF}\u{FE0F}]/u;
    wire({ w9: W9_STATUS, bank: BANK_STATUS });
    renderPage();
    await screen.findByTestId("w9-filed");
    expect(document.body.textContent ?? "").not.toMatch(PICTO);
  });

  it("labels every input — a screen-reader user can complete the form", async () => {
    wire();
    renderPage();
    await w9FormReady();

    for (const testId of ["input-legal-name", "input-address-line1", "input-city", "input-state", "input-zip", "input-tin", "input-signature-name", "input-routing", "input-account", "input-account-confirm"]) {
      const input = screen.getByTestId(testId);
      expect(input.id, `${testId} needs an id to be labelled`).toBeTruthy();
      expect(document.querySelector(`label[for="${input.id}"]`), `${testId} has no <label for>`).toBeTruthy();
    }
  });
});
