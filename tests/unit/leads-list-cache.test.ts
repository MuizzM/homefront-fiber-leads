// Targeted lead-list cache writes — the refetch-free create path.
//
// leadMatchesListFilters must agree with the SERVER's list filtering
// (getLeadsPage/searchLeadsPage), because it decides which cached views an
// optimistic or confirmed row is painted into. A row painted into a view the
// server would exclude is exactly the old appear-then-vanish flicker; a row
// withheld from a view the server would include is a silent loss.
import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import {
  LEADS_LIST_DEFAULTS, leadMatchesListFilters, leadsListKey, upsertLeadIntoLists,
  leadsListSearchParams, type LeadsListFilters,
} from "../../client/src/lib/leadsListQuery";

const baseLead = (over: Record<string, unknown> = {}) => ({
  id: 42, address: "99 Pine St", city: "Inman", state: "SC", zip: "29349",
  leadStatus: "prospect", fiberStatus: "no_service", assignedRepId: null,
  contactName: "Dana Shingle", createdAt: "2026-08-08T00:00:00Z", updatedAt: "2026-08-08T00:00:00Z",
  ...over,
}) as any;

const filters = (over: Partial<LeadsListFilters> = {}): LeadsListFilters =>
  ({ ...LEADS_LIST_DEFAULTS, ...over });

const listData = (leads: any[], total = leads.length) =>
  ({ leads, total, limit: 100, offset: 0 });

describe("leadMatchesListFilters mirrors the server's view rules", () => {
  it("matches the wide-open default view", () => {
    expect(leadMatchesListFilters(baseLead(), filters())).toBe(true);
  });
  it("status must equal exactly", () => {
    expect(leadMatchesListFilters(baseLead(), filters({ status: "sold" }))).toBe(false);
    expect(leadMatchesListFilters(baseLead({ leadStatus: "sold" }), filters({ status: "sold" }))).toBe(true);
  });
  it("city and state compare case-insensitively (server lower()s both sides)", () => {
    expect(leadMatchesListFilters(baseLead(), filters({ city: "INMAN", state: "sc" }))).toBe(true);
    expect(leadMatchesListFilters(baseLead(), filters({ city: "Rockwell" }))).toBe(false);
  });
  it("rep filter understands unassigned and specific ids", () => {
    expect(leadMatchesListFilters(baseLead(), filters({ rep: "unassigned" }))).toBe(true);
    expect(leadMatchesListFilters(baseLead({ assignedRepId: 7 }), filters({ rep: "unassigned" }))).toBe(false);
    expect(leadMatchesListFilters(baseLead({ assignedRepId: 7 }), filters({ rep: "7" }))).toBe(true);
    expect(leadMatchesListFilters(baseLead({ assignedRepId: 7 }), filters({ rep: "8" }))).toBe(false);
  });
  it("fiber status must equal exactly", () => {
    expect(leadMatchesListFilters(baseLead(), filters({ fiber: "new_fiber" }))).toBe(false);
    expect(leadMatchesListFilters(baseLead(), filters({ fiber: "no_service" }))).toBe(true);
  });
  it("recent-scan windows exclude unscanned and stale rows", () => {
    expect(leadMatchesListFilters(baseLead(), filters({ scanWindow: "24h" }))).toBe(false);
    expect(leadMatchesListFilters(baseLead({ lastScannedAt: new Date().toISOString() }), filters({ scanWindow: "24h" }))).toBe(true);
    expect(leadMatchesListFilters(baseLead({ lastScannedAt: new Date(Date.now() - 8 * 86_400_000).toISOString() }), filters({ scanWindow: "7d" }))).toBe(false);
  });
  it("search is a case-insensitive contains over address/city/zip/contact", () => {
    expect(leadMatchesListFilters(baseLead(), filters({ search: "pine" }))).toBe(true);
    expect(leadMatchesListFilters(baseLead(), filters({ search: "29349" }))).toBe(true);
    expect(leadMatchesListFilters(baseLead(), filters({ search: "dana" }))).toBe(true);
    expect(leadMatchesListFilters(baseLead(), filters({ search: "elm ave" }))).toBe(false);
  });
});

describe("lead-list scan query contract", () => {
  it("keys scan filters and sends only non-default scan parameters", () => {
    const recent = filters({ scanWindow: "7d", sort: "scanned_desc", page: 2 });
    expect(leadsListKey(recent)).toContain("7d");
    expect(leadsListKey(recent)).toContain("scanned_desc");
    const params = new URLSearchParams(leadsListSearchParams(recent));
    expect(params.get("scanWindow")).toBe("7d");
    expect(params.get("sort")).toBe("scanned_desc");
    expect(params.get("offset")).toBe("200");

    const defaults = new URLSearchParams(leadsListSearchParams(LEADS_LIST_DEFAULTS));
    expect(defaults.has("scanWindow")).toBe(false);
    expect(defaults.has("sort")).toBe(false);
  });
});

describe("upsertLeadIntoLists writes only where the row belongs", () => {
  it("prepends on page 0 of a matching view and bumps total", () => {
    const qc = new QueryClient();
    const key = leadsListKey(filters());
    qc.setQueryData(key, listData([baseLead({ id: 1, address: "1 Oak St" })], 5));
    upsertLeadIntoLists(qc, baseLead());
    const data = qc.getQueryData<any>(key);
    expect(data.leads.map((l: any) => l.id)).toEqual([42, 1]);
    expect(data.total).toBe(6);
  });

  it("leaves a non-matching view completely untouched", () => {
    const qc = new QueryClient();
    const key = leadsListKey(filters({ status: "sold" }));
    const before = listData([baseLead({ id: 1, leadStatus: "sold" })], 1);
    qc.setQueryData(key, before);
    upsertLeadIntoLists(qc, baseLead()); // a prospect
    expect(qc.getQueryData(key)).toEqual(before);
    expect(qc.getQueryState(key)?.isInvalidated).toBe(false);
  });

  it("deeper pages get a no-fetch stale mark only - no row, no total change", () => {
    // A blind total bump double-counted across the optimistic + reconcile
    // pair (each call sees no row to anchor on) — review finding. Deeper
    // pages now correct themselves on their next visit instead.
    const qc = new QueryClient();
    const key = leadsListKey(filters({ page: 2 }));
    const before = listData([baseLead({ id: 1, address: "1 Oak St" })], 201);
    qc.setQueryData(key, before);
    upsertLeadIntoLists(qc, baseLead());
    expect(qc.getQueryData(key)).toEqual(before);
    expect(qc.getQueryState(key)?.isInvalidated).toBe(true);
  });

  it("the optimistic-insert + reconcile PAIR is idempotent on totals", () => {
    // Exactly what a create runs: upsert(temp) at onMutate, then
    // upsert(server, {replaceTempId}) at onSuccess — page 0 nets +1 once,
    // deeper pages net zero, in BOTH cases with no duplicate row.
    const qc = new QueryClient();
    const page0 = leadsListKey(filters());
    const page2 = leadsListKey(filters({ page: 2 }));
    qc.setQueryData(page0, listData([baseLead({ id: 1, address: "1 Oak St" })], 201));
    qc.setQueryData(page2, listData([baseLead({ id: 2, address: "2 Oak St" })], 201));
    const tempId = -1754000000000;
    upsertLeadIntoLists(qc, baseLead({ id: tempId }));
    upsertLeadIntoLists(qc, baseLead(), { replaceTempId: tempId });
    const d0 = qc.getQueryData<any>(page0);
    expect(d0.leads.map((l: any) => l.id)).toEqual([42, 1]);
    expect(d0.total).toBe(202);
    const d2 = qc.getQueryData<any>(page2);
    expect(d2.leads.map((l: any) => l.id)).toEqual([2]);
    expect(d2.total).toBe(201);
  });

  it("replaceTempId swaps the optimistic row in place - same index, no total change", () => {
    const qc = new QueryClient();
    const key = leadsListKey(filters());
    qc.setQueryData(key, listData([
      baseLead({ id: -1754000000000, address: "99 Pine St" }),
      baseLead({ id: 1, address: "1 Oak St" }),
    ], 2));
    upsertLeadIntoLists(qc, baseLead(), { replaceTempId: -1754000000000 });
    const data = qc.getQueryData<any>(key);
    expect(data.leads.map((l: any) => l.id)).toEqual([42, 1]);
    expect(data.total).toBe(2);
  });

  it("withdraws a temp row from a view the CONFIRMED row does not match", () => {
    const qc = new QueryClient();
    const key = leadsListKey(filters({ status: "prospect" }));
    qc.setQueryData(key, listData([
      baseLead({ id: -1754000000000, leadStatus: "prospect" }),
      baseLead({ id: 1 }),
    ], 2));
    // Server normalized the row out of this view (e.g. duplicate resolved to a
    // sold lead) — the optimistic +1 is handed back with the row.
    upsertLeadIntoLists(qc, baseLead({ leadStatus: "sold" }), { replaceTempId: -1754000000000 });
    const data = qc.getQueryData<any>(key);
    expect(data.leads.map((l: any) => l.id)).toEqual([1]);
    expect(data.total).toBe(1);
  });

  it("never duplicates a row that a racing refetch already delivered", () => {
    const qc = new QueryClient();
    const key = leadsListKey(filters());
    qc.setQueryData(key, listData([baseLead(), baseLead({ id: 1, address: "1 Oak St" })], 2));
    upsertLeadIntoLists(qc, baseLead({ contactName: "Updated Name" }), { replaceTempId: -99 });
    const data = qc.getQueryData<any>(key);
    expect(data.leads.map((l: any) => l.id)).toEqual([42, 1]);
    expect(data.total).toBe(2);
    expect(data.leads[0].contactName).toBe("Updated Name");
  });
});
