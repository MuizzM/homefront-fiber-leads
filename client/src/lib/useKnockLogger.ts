// ── useKnockLogger — the one shared rep-logging hook ──────────────────────────
// Every field surface, including MapView, consumes THIS hook so the critical
// path (offline queue + GPS evidence + optimistic recolor + authoritative saved
// reconciliation) cannot drift between screens.
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { getKnockQueue, type QueueSnapshot } from "@/lib/knockQueue";
import { captureFieldFix } from "@/lib/geoFix";
import { OUTCOME_TO_STATUS, type KnockOutcome } from "@shared/knock";
import {
  createSavedKnockReconciliation,
  deriveFieldQueueOwnerKey,
  queryKeyMatchesApiPrefix,
  resolveCreditedRepId,
} from "@/features/knocking/savedKnockReconciliation";

const EMPTY_SNAP: QueueSnapshot = { pendingCount: 0, deadCount: 0, byLead: {}, online: true };
export interface LogLead { id: number; leadStatus: string; assignedRepId?: number | null }
export interface LogOpts { notes?: string | null; callbackDate?: string | null; callbackTime?: string | null }

export function useKnockLogger() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const { toast } = useToast();
  const queueOwnerKey = deriveFieldQueueOwnerKey(user);

  const reconcileSavedKnock = useMemo(
    () =>
      createSavedKnockReconciliation({
        notify: (message) => toast(message),
        invalidateQuery: (queryKey) => {
          void qc.invalidateQueries({ queryKey });
        },
        invalidatePrefix: (prefix) => {
          void qc.invalidateQueries({
            predicate: ({ queryKey }) =>
              queryKeyMatchesApiPrefix(queryKey, prefix),
          });
        },
      }),
    [qc, toast],
  );

  const queue = useMemo(() => {
    if (queueOwnerKey == null) return null;
    return getKnockQueue({
      // Registry/storage ownership is deliberately separate from the credited
      // real repId supplied on each enqueue.
      repId: queueOwnerKey,
      post: (url, body) => apiRequest("POST", url, body).then(r => r.json()),
      patch: (url, body) => apiRequest("PATCH", url, body).then(r => r.json()),
      onSaved: reconcileSavedKnock,
    });
  }, [queueOwnerKey, reconcileSavedKnock]);

  const snap = useSyncExternalStore(
    useCallback(cb => queue ? queue.subscribe(cb) : () => {}, [queue]),
    useCallback(() => queue ? queue.getSnapshot() : EMPTY_SNAP, [queue]),
  );

  // Returns true only after the tap is synchronously persisted. GPS enriches
  // the durable row before its normal flush; reload recovery can safely submit
  // the row without location instead of losing the representative's action.
  const log = useCallback((lead: LogLead, outcome: KnockOutcome, opts: LogOpts = {}): boolean => {
    const credit = resolveCreditedRepId(user, lead.assignedRepId);
    if (!credit) {
      toast({
        title:
          user?.role === "rep"
            ? "Your rep profile is not linked"
            : "This lead has no rep assigned",
        variant: "destructive",
      });
      return false;
    }
    if (!queue) {
      toast({ title: "Unable to save this outcome", variant: "destructive" });
      return false;
    }
    const at = new Date().toISOString();
    // Optimistic recolor on the SHARED map cache — the pin updates everywhere at once.
    qc.setQueryData(["/api/leads/map"], (old: any) => old?.pins
      ? { ...old, pins: old.pins.map((p: any) => p.id === lead.id
          ? { ...p, leadStatus: OUTCOME_TO_STATUS[outcome] ?? p.leadStatus, visited: true, knockCount: (p.knockCount ?? 0) + 1, lastOutcome: outcome, lastKnockedAt: at }
          : p) }
      : old);
    const staged = queue.stage({
      leadId: lead.id,
      repId: credit,
      outcome,
      notes: opts.notes ?? null,
      callbackDate: opts.callbackDate ?? null,
      callbackTime: opts.callbackTime ?? null,
      deviceTs: at,
      netState:
        typeof navigator === "undefined" || navigator.onLine !== false
          ? "online"
          : "offline",
    });
    void captureFieldFix().then((fix) => {
      queue.enrich(staged.clientId, fix);
      return queue.flush();
    });
    return true;
  }, [queue, user, qc, toast]);

  return { log, snap, queue };
}
