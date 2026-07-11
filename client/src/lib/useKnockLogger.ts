// ── useKnockLogger — the one shared rep-logging hook ──────────────────────────
// Both Today and Property Detail log through THIS, so the critical path (offline
// queue + GPS evidence + optimistic recolor + sold/commission side-effects) can
// never drift between screens. Wraps getKnockQueue (client/src/lib/knockQueue.ts)
// exactly the way MapView does; the queue is a per-rep singleton, so every screen
// shares one queue + one sync state.
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { getKnockQueue, type QueueSnapshot } from "@/lib/knockQueue";
import { captureFieldFix } from "@/lib/geoFix";
import { OUTCOME_TO_STATUS, type KnockOutcome } from "@shared/knock";

const EMPTY_SNAP: QueueSnapshot = { pendingCount: 0, deadCount: 0, byLead: {}, online: true };
export interface LogLead { id: number; leadStatus: string; assignedRepId?: number | null }
export interface LogOpts { notes?: string | null; callbackDate?: string | null; callbackTime?: string | null }

export function useKnockLogger() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const { toast } = useToast();
  const isRep = user?.role === "rep";

  const queue = useMemo(() => {
    if (!user?.teamMemberId) return null;
    return getKnockQueue({
      repId: user.teamMemberId,
      post: (url, body) => apiRequest("POST", url, body).then(r => r.json()),
      patch: (url, body) => apiRequest("PATCH", url, body).then(r => r.json()),
      onSaved: (leadId: number) => {
        qc.invalidateQueries({ queryKey: ["/api/leaderboard"] });
        qc.invalidateQueries({ queryKey: ["/api/leads"] });
        qc.invalidateQueries({ queryKey: [`/api/leads/${leadId}`] });
        qc.invalidateQueries({ queryKey: [`/api/leads/${leadId}/history`] });
      },
    });
  }, [user?.teamMemberId, qc]);

  const snap = useSyncExternalStore(
    useCallback(cb => queue ? queue.subscribe(cb) : () => {}, [queue]),
    useCallback(() => queue ? queue.getSnapshot() : EMPTY_SNAP, [queue]),
  );

  // Returns true if the tap was accepted (optimistically applied + enqueued).
  const log = useCallback((lead: LogLead, outcome: KnockOutcome, opts: LogOpts = {}): boolean => {
    if (!queue) return false;
    const credit = isRep ? user?.teamMemberId : (lead.assignedRepId ?? user?.teamMemberId);
    if (!credit) { toast({ title: "This lead has no rep assigned", variant: "destructive" }); return false; }
    const at = new Date().toISOString();
    const wasSold = lead.leadStatus === "sold";
    // Optimistic recolor on the SHARED map cache — the pin updates everywhere at once.
    qc.setQueryData(["/api/leads/map"], (old: any) => old?.pins
      ? { ...old, pins: old.pins.map((p: any) => p.id === lead.id
          ? { ...p, leadStatus: OUTCOME_TO_STATUS[outcome] ?? p.leadStatus, visited: true, knockCount: (p.knockCount ?? 0) + 1, lastOutcome: outcome, lastKnockedAt: at }
          : p) }
      : old);
    captureFieldFix().then(fix => queue.enqueue({
      leadId: lead.id, repId: credit, outcome,
      notes: opts.notes ?? null, callbackDate: opts.callbackDate ?? null, callbackTime: opts.callbackTime ?? null, ...fix,
    }));
    if (outcome === "sold") toast({ title: "Sold 🎉 — commission logged", description: "Pending review on your Commission tab" });
    else if (wasSold) toast({ title: "Sale removed — pending commission reversed" });
    else toast({ title: "Outcome logged" });
    return true;
  }, [queue, isRep, user?.teamMemberId, qc, toast]);

  return { log, snap, queue };
}
