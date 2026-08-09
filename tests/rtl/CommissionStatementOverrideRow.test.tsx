// ── The on-screen statement must say the same thing the PDF says ─────────────
//
// `earnedCents` has always included override pay, but the summary row list was
// built TWICE — once in server/commissionStatementPdf.ts, once in this
// component — and the two drifted. The PDF's copy omitted overrides entirely, so
// a team lead or manager whose week was all override money got a pay document
// reading "Commission on sales $0.00" against "Earned this period $375.00", with
// the difference unexplained.
//
// Both surfaces now build from shared/commissionStatement.statementSummaryRows.
// These tests pin the SCREEN half of that contract; the PDF half is pinned by
// tests/unit/commission-statement-document.test.ts and exercised end-to-end in
// tests/integration/commission-statement-doc.test.ts.
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: 1, name: "Mona Manager", role: "manager", teamMemberId: 2 } }),
}));
const apiRequest = vi.fn();
vi.mock("@/lib/queryClient", () => ({
  apiRequest: (...a: any[]) => apiRequest(...a),
  queryClient: undefined,
}));

import { CommissionStatement } from "../../client/src/components/CommissionStatement";

/** An override-only week: sold nothing personally, earned $375 off the downline. */
function doc(over: Record<string, any> = {}) {
  const totals = {
    countedSaleCount: 0, otherSaleCount: 0,
    houseAmountCents: null, houseAmountComplete: false, houseMarginCents: null,
    grossCommissionCents: 0, adjustmentCents: 0, spiffCents: 0,
    overrideCents: 37500, overrideItemCount: 5,
    hourlyPayCents: 0, earnedCents: 37500,
    ...(over.totals ?? {}),
  };
  return {
    company: { name: "Northstar Fiber", supportEmail: "pay@northstar.test", logoDataUri: null },
    rep: { id: 2, name: "Mona Manager" },
    period: {
      label: "Aug 3 – Aug 9, 2026",
      startUtc: "2026-08-03T04:00:00.000Z", nextStartUtc: "2026-08-10T04:00:00.000Z",
      timezone: "America/New_York",
    },
    statement: {
      id: 5, status: "OPEN", calculationVersion: 5,
      tierLabel: null, rateCents: 0, structure: null,
      issuedAtIso: "2026-08-06T02:02:00.000Z",
    },
    planLabel: " - ",
    lines: [], totals,
    payout: {
      earnedCents: totals.earnedCents, reservePercent: 0, reserveCents: 0,
      netPayCents: totals.earnedCents, reserveBalanceCents: 0, reserveCapCents: 250000, reserveAtCap: false,
    },
    adjustments: [],
    showHouseColumn: false,
    isDraft: true,
    ...over,
  };
}

function renderStatement(d: any) {
  apiRequest.mockImplementation(() => Promise.resolve({ json: () => Promise.resolve(d) }));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CommissionStatement statementId={5} onClose={() => {}} />
    </QueryClientProvider>,
  );
}

beforeEach(() => apiRequest.mockReset());

describe("statement summary on screen", () => {
  it("THE REGRESSION: an override-only week shows a Team overrides row, so the summary adds up", async () => {
    renderStatement(doc());
    await waitFor(() => expect(screen.getByText("Team overrides")).toBeTruthy());
    // Commission on sales is genuinely $0 — the overrides row is what closes the
    // gap to the $375 total, instead of leaving it unexplained.
    expect(screen.getByText("Commission on sales")).toBeTruthy();
    expect(screen.getByText("Earned this period")).toBeTruthy();
    expect(screen.getAllByText("$375.00").length).toBeGreaterThan(0);
  });

  it("omits the row entirely for an ordinary commission-only rep", async () => {
    renderStatement(doc({
      totals: { grossCommissionCents: 60000, overrideCents: 0, overrideItemCount: 0, earnedCents: 60000 },
      payout: {
        earnedCents: 60000, reservePercent: 0, reserveCents: 0,
        netPayCents: 60000, reserveBalanceCents: 0, reserveCapCents: 250000, reserveAtCap: false,
      },
    }));
    await waitFor(() => expect(screen.getByText("Commission on sales")).toBeTruthy());
    expect(screen.queryByText("Team overrides")).toBeNull();
  });

  it("a net-negative override week is shown as a deduction, never hidden", async () => {
    renderStatement(doc({
      totals: { grossCommissionCents: 20000, overrideCents: -7500, overrideItemCount: 1, earnedCents: 12500 },
      payout: {
        earnedCents: 12500, reservePercent: 0, reserveCents: 0,
        netPayCents: 12500, reserveBalanceCents: 0, reserveCapCents: 250000, reserveAtCap: false,
      },
    }));
    await waitFor(() => expect(screen.getByText("Team overrides")).toBeTruthy());
    // Deductions render with a true minus sign (U+2212), not an ASCII hyphen —
    // the same treatment the chargeback holdback row gets.
    expect(screen.getByText("−$75.00")).toBeTruthy();
  });
});

describe("statement provenance on screen", () => {
  it("an OPEN week is labelled a preview, not an issued pay document", async () => {
    renderStatement(doc());
    await waitFor(() => expect(screen.getByText("Generated")).toBeTruthy());
    expect(screen.getByText("preview")).toBeTruthy();
    expect(screen.queryByText("Issued")).toBeNull();
  });

  it("a FINALIZED week is Issued, with no preview marker", async () => {
    renderStatement(doc({ statement: { ...doc().statement, status: "FINALIZED" }, isDraft: false }));
    await waitFor(() => expect(screen.getByText("Issued")).toBeTruthy());
    expect(screen.queryByText("Generated")).toBeNull();
    expect(screen.queryByText("preview")).toBeNull();
  });
});

describe("tenant wordmark on screen", () => {
  it("uses the tenant's own logo when configured", async () => {
    const uri = "data:image/png;base64,iVBORw0KGgo=";
    renderStatement(doc({ company: { ...doc().company, logoDataUri: uri } }));
    await waitFor(() => expect(screen.getByTestId("statement-logo")).toBeTruthy());
    expect(screen.getByTestId("statement-logo").getAttribute("src")).toBe(uri);
  });

  it("falls back to the bundled wordmark when the tenant has none", async () => {
    renderStatement(doc());
    await waitFor(() => expect(screen.getByTestId("statement-logo")).toBeTruthy());
    expect(screen.getByTestId("statement-logo").getAttribute("src")).toBe("/hfs-logo.png");
  });
});
