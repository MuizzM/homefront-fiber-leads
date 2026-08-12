// ── The opportunity-score overlay for a rep's route ───────────────────────────
// One hook over GET /api/leads/ranked (server/leadRanking.ts), reduced to the
// only shape the route needs: leadId -> { score, reasons }.
//
// The endpoint is already rep-facing and visibility-scoped server-side (a rep
// ranks their own book, a team lead their team's), so there is nothing to
// filter here. It scores ONLY confirmed-fresh leads, which is why this is an
// OVERLAY and not a route: most doors will be absent from the map, and
// shared/doorPriority.ts treats a missing entry as neutral.
//
// FAILURE IS NOT AN ERROR STATE. Today is the one screen a rep opens in a dead
// zone, and it worked before this overlay existed. So every failure path -
// offline, 403, 500, a payload that is not the shape we expect - collapses to
// an EMPTY map, and the route silently falls back to distance ordering. This
// hook deliberately exposes no isError: there is nothing for the rep to do
// about it and nothing to show them.

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import type { DoorRank } from "@shared/doorPriority";

/** One ranked lead as server/leadRanking.ts serialises it. */
interface RankedLeadRow {
  id: number;
  score: number;
  reasons: string[];
}
interface RankedResponse {
  count: number;
  limit: number;
  generatedAt: string;
  leads: RankedLeadRow[];
}

/** Well above the seven doors the screen shows, so the hero is ranked even when
 *  the rep's nearest doors sit far down the score order. Server clamps to 500. */
export const RANKED_LIMIT = 200;

const EMPTY: ReadonlyMap<number, DoorRank> = new Map();

export function useRankedDoors(): ReadonlyMap<number, DoorRank> {
  const { data } = useQuery<RankedResponse>({
    queryKey: ["/api/leads/ranked"],
    queryFn: () => apiRequest("GET", `/api/leads/ranked?limit=${RANKED_LIMIT}`).then((r) => r.json()),
    staleTime: 60_000,
    // A rep without the endpoint (403) or on a deployment without it (404) must
    // not retry on a loop in the background all shift. Same rule the
    // manager-side RankedLeads card uses, but read off ApiError's public
    // `status` rather than the class identity: this hook runs under an RTL
    // suite that module-mocks queryClient, where an `instanceof ApiError`
    // against an undefined export throws inside the retry predicate.
    retry: (count, err) => {
      const status = (err as { status?: unknown } | null)?.status;
      return status !== 404 && status !== 403 && count < 2;
    },
  });

  return useMemo(() => {
    const leads = data?.leads;
    if (!Array.isArray(leads) || leads.length === 0) return EMPTY;
    const map = new Map<number, DoorRank>();
    for (const lead of leads) {
      // Defensive: this payload crosses a network and feeds a sort comparator.
      // A NaN score would make the ordering non-deterministic rather than
      // merely wrong, so drop anything that is not a usable number.
      if (typeof lead?.id !== "number" || !Number.isFinite(lead.score)) continue;
      map.set(lead.id, {
        score: lead.score,
        reasons: Array.isArray(lead.reasons) ? lead.reasons.filter((r): r is string => typeof r === "string") : [],
      });
    }
    return map;
  }, [data]);
}
