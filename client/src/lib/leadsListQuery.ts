// ── The Leads list query, in one place ───────────────────────────────────────
// The paged lead list is read from three different angles and every one of them
// has to agree on the SAME key shape:
//
//   1. Leads.tsx mounts it (one entry per search/filter/page combination),
//   2. routePrefetch warms the default first page before the page mounts, and
//   3. the lead mutations invalidate it — and ONLY it. The bare ["/api/leads"]
//      prefix also matches per-lead subqueries (["/api/leads", id, "knocks"],
//      ["/api/leads", id, "enrichment"]), which have nothing to do with a row
//      moving in a list.
//
// Those three drifted before: the warm asked for a key nobody read, so every
// nav-intent downloaded a list page into a cache slot the page never looked at.
// Build the key (and the URL) here and that class of bug cannot come back.
import type { QueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import type { Lead } from "@shared/schema";

/** Rows per page — also the `limit` sent to the server. */
export const LEADS_PAGE_SIZE = 100;

export type LeadsListFilters = {
  search: string;
  status: string;
  city: string;
  state: string;
  rep: string;
  fiber: string;
  page: number;
};

/** The view a cold Leads page mounts with — what a route warm should fetch. */
export const LEADS_LIST_DEFAULTS: LeadsListFilters = {
  search: "",
  status: "all",
  city: "all",
  state: "all",
  rep: "all",
  fiber: "all",
  page: 0,
};

export type LeadsListResponse = { leads: Lead[]; total: number; limit: number; offset: number };

export type LeadsListKey = readonly [
  "/api/leads", string, string, string, string, string, string, number,
];

export function leadsListKey(filters: LeadsListFilters): LeadsListKey {
  return [
    "/api/leads",
    filters.search,
    filters.status,
    filters.city,
    filters.state,
    filters.rep,
    filters.fiber,
    filters.page,
  ] as const;
}

// Derived from the builder rather than written down, so adding a filter to the
// key can never leave the predicate matching the old length.
const LEADS_LIST_KEY_LENGTH = leadsListKey(LEADS_LIST_DEFAULTS).length;

/**
 * True only for a paged-list cache entry. Per-lead subqueries share the
 * "/api/leads" first segment but are 3 elements long, so they are left alone —
 * an open lead's enrichment does not need refetching because a row was renamed.
 */
export function isLeadsListKey(queryKey: unknown): boolean {
  return Array.isArray(queryKey)
    && queryKey.length === LEADS_LIST_KEY_LENGTH
    && queryKey[0] === "/api/leads";
}

/** A cached list key, decoded back into the filters that built it. */
export function parseLeadsListKey(queryKey: unknown): LeadsListFilters | null {
  if (!isLeadsListKey(queryKey)) return null;
  const [, search, status, city, state, rep, fiber, page] = queryKey as LeadsListKey;
  return { search, status, city, state, rep, fiber, page };
}

/**
 * Would the server include this lead in the view these filters describe?
 * Mirrors getLeadsPage/searchLeadsPage: exact status/fiber, case-insensitive
 * city/state, rep id or "unassigned", and the search LIKE over
 * address/city/zip/contactName (SQLite LIKE is ASCII case-insensitive, so a
 * lowercase containment check matches its verdict for this data; the query is
 * deliberately NOT trimmed — the server doesn't trim either). Pure, so the
 * optimistic insert and the post-save reconcile read the SAME rule and a row
 * can never be painted into a view the server would filter out.
 *
 * SCOPE INVARIANT: this mirrors the FILTERS only, not the caller's role
 * visibility scope. It is safe because the server guarantees a created lead is
 * always inside its creator's list scope — admin/manager see everything, and a
 * team_lead's create is auto-assigned to them (POST /api/leads). If a new
 * caller role can ever create leads outside its own list scope, this matcher
 * must learn about scope or the row will paint and then vanish on refetch.
 */
export function leadMatchesListFilters(
  lead: Pick<Lead, "leadStatus" | "city" | "state" | "zip" | "address"> &
    Partial<Pick<Lead, "contactName" | "assignedRepId" | "fiberStatus">>,
  filters: Omit<LeadsListFilters, "page">,
): boolean {
  if (filters.status !== "all" && lead.leadStatus !== filters.status) return false;
  if (filters.city !== "all" && (lead.city ?? "").toLowerCase() !== filters.city.toLowerCase()) return false;
  if (filters.state !== "all" && (lead.state ?? "").toLowerCase() !== filters.state.toLowerCase()) return false;
  if (filters.fiber !== "all" && lead.fiberStatus !== filters.fiber) return false;
  if (filters.rep !== "all") {
    if (filters.rep === "unassigned") {
      if (lead.assignedRepId != null) return false;
    } else if (lead.assignedRepId !== Number(filters.rep)) return false;
  }
  const q = filters.search.toLowerCase();
  if (q) {
    const hit = [lead.address, lead.city, lead.zip, lead.contactName]
      .some(v => (v ?? "").toLowerCase().includes(q));
    if (!hit) return false;
  }
  return true;
}

/**
 * Write ONE lead into every cached list view it belongs to — the targeted
 * alternative to invalidate-and-refetch after a create. Views the lead matches:
 * page 0 gets the row prepended (newest-first is the server's ORDER BY, so the
 * top of page 0 IS its real position); deeper pages only bump `total` and are
 * marked stale without a fetch (their row windows shifted). Views the lead
 * does not match are left untouched — a new lead cannot change their contents.
 * `replaceTempId` reconciles an optimistic row in place: same index, real id,
 * no remove-then-reinsert flash. If a concurrent refetch already wiped the temp
 * row, the lead is inserted instead, and a row already present (an SSE repaint,
 * a racing refetch that included it) is never duplicated.
 */
export function upsertLeadIntoLists(
  qc: QueryClient,
  lead: Lead,
  opts: { replaceTempId?: number } = {},
): void {
  const entries = qc.getQueriesData<LeadsListResponse>({ predicate: q => isLeadsListKey(q.queryKey) });
  const staleKeys: unknown[][] = [];
  for (const [key, data] of entries) {
    const filters = parseLeadsListKey(key);
    if (!filters || !data || !Array.isArray(data.leads)) continue;
    const withoutTemp = opts.replaceTempId != null && data.leads.some(l => l.id === opts.replaceTempId)
      ? data.leads : null;
    if (!leadMatchesListFilters(lead, filters)) {
      // A temp row painted here no longer belongs (the server normalized a
      // field out of this view) — drop it and hand back the optimistic +1.
      if (withoutTemp) {
        qc.setQueryData<LeadsListResponse>(key, {
          ...data,
          leads: data.leads.filter(l => l.id !== opts.replaceTempId),
          total: Math.max(0, data.total - 1),
        });
      }
      continue;
    }
    if (withoutTemp) {
      // In-place swap: the row keeps its index, so nothing moves on screen.
      qc.setQueryData<LeadsListResponse>(key, {
        ...data,
        leads: data.leads.map(l => (l.id === opts.replaceTempId ? lead : l)),
      });
    } else if (data.leads.some(l => l.id === lead.id)) {
      qc.setQueryData<LeadsListResponse>(key, {
        ...data,
        leads: data.leads.map(l => (l.id === lead.id ? lead : l)),
      });
    } else if (filters.page === 0) {
      qc.setQueryData<LeadsListResponse>(key, {
        ...data,
        leads: [lead, ...data.leads],
        total: data.total + 1,
      });
    } else {
      // Deeper pages: the row-window shifted server-side in a way the cache
      // can't reproduce, and a blind total bump would double-count across an
      // optimistic-insert + reconcile pair (each call sees no row to anchor
      // on). Leave the data untouched and let the next visit refetch.
      staleKeys.push([...key]);
    }
  }
  // Deeper pages refetch on their next visit — never now, never the whole list.
  for (const key of staleKeys) {
    void qc.invalidateQueries({ queryKey: key, exact: true, refetchType: "none" });
  }
}

/** The querystring the server expects for a given view (limit/offset included). */
export function leadsListSearchParams(filters: LeadsListFilters): string {
  const params = new URLSearchParams();
  if (filters.search) params.set("search", filters.search);
  if (filters.status !== "all") params.set("status", filters.status);
  if (filters.city !== "all") params.set("city", filters.city);
  if (filters.state !== "all") params.set("state", filters.state);
  if (filters.rep !== "all") params.set("assignedRepId", filters.rep);
  if (filters.fiber !== "all") params.set("fiberStatus", filters.fiber);
  params.set("limit", String(LEADS_PAGE_SIZE));
  params.set("offset", String(filters.page * LEADS_PAGE_SIZE));
  return params.toString();
}

/**
 * Key + fetcher for one view of the list. Spread into useQuery on the page and
 * handed to prefetchQuery by the route warm, so a warmed entry is byte-for-byte
 * the entry the mounted page asks for.
 */
export function leadsListQueryOptions(filters: LeadsListFilters) {
  return {
    queryKey: leadsListKey(filters),
    queryFn: async (): Promise<LeadsListResponse> => {
      const res = await apiRequest("GET", `/api/leads?${leadsListSearchParams(filters)}`);
      return res.json();
    },
  };
}
