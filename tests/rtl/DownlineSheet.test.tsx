// ── The downline override sheet ───────────────────────────────────────────────
//
// The console's third tab. Three things must hold: the rollup carries each
// member's DEPTH (an L1 direct report and an L2 grand-report are different
// facts about the same dollar amount); the view-as picker exists ONLY for
// commission.read.all holders (a team lead gets their own tree and no picker —
// unauthorized controls are omitted, never disabled); and "no downline" is a
// different empty state from "downline, but nobody sold".
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";

let canReadAll = false;
vi.mock("@/lib/capabilities", () => ({
  // The sheet only asks for commission.read.all (the tab gate lives in the
  // console); anything else defaults to true so the mock stays honest if a
  // new gate appears.
  useCan: (cap: string) => (cap === "commission.read.all" ? canReadAll : true),
}));
const apiRequest = vi.fn();
vi.mock("@/lib/queryClient", () => ({
  apiRequest: (...a: any[]) => apiRequest(...a),
  queryClient: undefined,
}));
// The sheet reads the viewer's own teamMemberId to know whether "my sheet" is
// even a meaningful default — an admin login without a field profile must get
// the picker, not a guaranteed-400 error card.
let authUser: any = { id: 1, role: "team_lead", teamMemberId: 5 };
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: authUser }) }));

import { DownlineSheet } from "../../client/src/components/DownlineSheet";

const SHEET = {
  bounds: { weekStartUtc: "2026-08-03T04:00:00.000Z", nextWeekStartUtc: "2026-08-10T04:00:00.000Z" },
  viewer: { repId: 5, repName: "Lena Lead" },
  totals: { rowCount: 3, payableCents: 5000, heldCents: 2500, settledCents: 0 },
  rows: [
    {
      id: 1, saleId: 11, soldAt: "2026-08-03T15:00:00.000Z", saleStatus: "QUALIFIED",
      downlineRepId: 7, downlineRepName: "Rex Rep", downlineRoleAtEarn: "rep", level: 1,
      basis: "FLAT_PER_SALE", entryType: "EARN", amountCents: 2500, status: "PAYABLE", holdPayableAfter: null,
    },
    {
      id: 2, saleId: 12, soldAt: "2026-08-04T15:00:00.000Z", saleStatus: "PENDING",
      downlineRepId: 7, downlineRepName: "Rex Rep", downlineRoleAtEarn: "rep", level: 1,
      basis: "FLAT_PER_SALE", entryType: "EARN", amountCents: 2500, status: "HELD", holdPayableAfter: "2026-08-20T00:00:00.000Z",
    },
    {
      id: 3, saleId: 13, soldAt: "2026-08-05T15:00:00.000Z", saleStatus: "REVERSED",
      downlineRepId: 8, downlineRepName: "Nia Nested", downlineRoleAtEarn: "rep", level: 2,
      basis: "FLAT_PER_SALE", entryType: "CLAWBACK", amountCents: -2500, status: "PAYABLE", holdPayableAfter: null,
    },
  ],
  rollup: [
    { repId: 7, repName: "Rex Rep", role: "rep", active: true, level: 1, saleCount: 2, payableCents: 2500, heldCents: 2500, settledCents: 0 },
    { repId: 8, repName: "Nia Nested", role: "rep", active: true, level: 2, saleCount: 1, payableCents: 2500, heldCents: 0, settledCents: 0 },
  ],
  exceptions: [],
};

const TREE = {
  rootRepId: 5,
  members: [
    { repId: 7, repName: "Rex Rep", role: "rep", active: true, level: 1, reportsToId: 5 },
    { repId: 8, repName: "Nia Nested", role: "rep", active: true, level: 2, reportsToId: 7 },
  ],
};

const TEAM = [
  { id: 5, name: "Lena Lead", role: "team_lead", active: true },
  { id: 6, name: "Mia Manager", role: "manager", active: true },
  { id: 7, name: "Rex Rep", role: "rep", active: true },
];

function renderSheet({ sheet = SHEET, tree = TREE }: { sheet?: any; tree?: any } = {}) {
  apiRequest.mockImplementation((...args: any[]) => {
    const url = args.find(a => typeof a === "string" && a.startsWith("/")) ?? "";
    if (url.includes("/api/commission/overrides/sheet")) return Promise.resolve({ json: () => Promise.resolve(sheet) });
    if (url.includes("/api/commission/downline")) return Promise.resolve({ json: () => Promise.resolve(tree) });
    if (url.includes("/api/team")) return Promise.resolve({ json: () => Promise.resolve(TEAM) });
    return Promise.resolve({ json: () => Promise.resolve([]) });
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <DownlineSheet weekRef="2026-08-05T12:00:00.000Z" weekLabel="Aug 3 – Aug 9, 2026" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiRequest.mockReset();
  canReadAll = false;
  authUser = { id: 1, role: "team_lead", teamMemberId: 5 };
});

describe("the downline override sheet", () => {
  it("splits payable / held / settled into separate tiles", async () => {
    renderSheet();
    await screen.findByTestId("override-totals");
    expect(screen.getByTestId("tile-override-payable").textContent).toContain("$50");
    expect(screen.getByTestId("tile-override-held").textContent).toContain("$25");
    expect(screen.getByTestId("tile-override-settled").textContent).toContain("$0");
  });

  it("rolls up per member with a depth chip — L1 direct vs L2 nested", async () => {
    renderSheet();
    const direct = await screen.findByTestId("rollup-row-7");
    expect(direct.textContent).toContain("Rex Rep");
    expect(direct.textContent).toContain("L1");
    expect(direct.textContent).toContain("2 sales");
    const nested = screen.getByTestId("rollup-row-8");
    expect(nested.textContent).toContain("Nia Nested");
    expect(nested.textContent).toContain("L2");
  });

  it("expands a member row into its per-sale ledger rows, claws shown signed", async () => {
    renderSheet();
    const nested = await screen.findByTestId("rollup-row-8");
    expect(screen.queryByTestId("override-row-3")).toBeNull();
    fireEvent.click(nested);
    const row = await screen.findByTestId("override-row-3");
    expect(row.textContent).toContain("Nia Nested");
    expect(row.textContent).toContain("reversed");   // SaleChip
    expect(row.textContent).toContain("−$25");        // clawback carries its sign
    expect(row.textContent).toContain("Payable");     // override ledger status
  });

  it("shows the view-as picker ONLY with commission.read.all", async () => {
    canReadAll = true;
    renderSheet();
    await screen.findByTestId("downline-sheet");
    expect(screen.getByTestId("downline-viewas")).toBeInTheDocument();
  });

  it("omits the picker entirely for a plain team lead — omitted, not disabled", async () => {
    canReadAll = false;
    renderSheet();
    await screen.findByTestId("downline-sheet");
    expect(screen.queryByTestId("downline-viewas")).toBeNull();
  });

  it("no downline at all → the assign-reps empty state, not a $0 sheet", async () => {
    renderSheet({
      sheet: { ...SHEET, totals: { rowCount: 0, payableCents: 0, heldCents: 0, settledCents: 0 }, rows: [], rollup: [] },
      tree: { rootRepId: 5, members: [] },
    });
    const empty = await screen.findByTestId("downline-empty");
    expect(empty.textContent).toMatch(/No downline yet/i);
    expect(empty.textContent).toMatch(/Team page/i);
    expect(screen.queryByTestId("override-totals")).toBeNull();
  });

  it("downline but nobody sold → totals at $0 and 'no override earnings this week'", async () => {
    renderSheet({
      sheet: { ...SHEET, totals: { rowCount: 0, payableCents: 0, heldCents: 0, settledCents: 0 }, rows: [], rollup: [] },
    });
    await screen.findByTestId("override-totals");
    expect(screen.getByTestId("tile-override-payable").textContent).toContain("$0");
    expect(screen.getByTestId("downline-no-rows").textContent).toMatch(/No override earnings this week/i);
    expect(screen.queryByTestId("downline-empty")).toBeNull();
  });

  it("an admin login with no field profile gets the picker and a pick-a-leader prompt, never a 400 error card", async () => {
    canReadAll = true;
    authUser = { id: 1, role: "admin", teamMemberId: null };
    renderSheet();
    await screen.findByTestId("downline-pick-target");
    // The picker is reachable (it IS the way forward), the error card is not,
    // and no sheet query fired for a target that cannot exist.
    expect(screen.getByTestId("downline-viewas")).toBeInTheDocument();
    expect(screen.queryByTestId("downline-error")).toBeNull();
    const sheetCalls = apiRequest.mock.calls.filter(c =>
      c.some((a: any) => typeof a === "string" && a.includes("/api/commission/overrides/sheet")));
    expect(sheetCalls).toHaveLength(0);
    // (Opening the Radix Select needs real pointer events jsdom lacks; the
    // fetch-once-a-target-exists path is covered by every other test here,
    // which renders with a viewer that has a field profile.)
  });
});
