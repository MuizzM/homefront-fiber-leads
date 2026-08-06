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
