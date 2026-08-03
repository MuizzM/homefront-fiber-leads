// ── useKnockLogger — the one shared rep-logging hook ──────────────────────────
// Every field surface, including MapView, consumes THIS hook so the critical
// path (offline queue + GPS evidence + optimistic recolor + authoritative saved
// reconciliation) cannot drift between screens.
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { getKnockQueue, type QueueSnapshot } from "@/lib/knockQueue";
import { installPendingKnockOverlay, mergePendingOutcomes } from "@/lib/pendingKnockOverlay";
import { captureFieldFix } from "@/lib/geoFix";
import { type KnockOutcome, type QueuedKnock } from "@shared/knock";
import {
  createSavedKnockReconciliation,
  deriveFieldQueueOwnerKey,
  queryKeyMatchesApiPrefix,
  resolveCreditedRepId,
} from "@/features/knocking/savedKnockReconciliation";
import {
  droppedKnockToast,
  isKnockableLeadId,
} from "@/features/knocking/knockFailurePolicy";

const EMPTY_SNAP: QueueSnapshot = { pendingCount: 0, deadCount: 0, deadItems: [], byLead: {}, online: true, pendingOutcomes: {} };
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

  // A knock the server can NEVER accept (lead deleted, temp id from an old
  // session, payload an old app version wrote) auto-resolves out of the queue:
  // one honest toast naming the door, then the optimistic recolor is pulled
  // back to server truth. The queue already console.error-logs it for support;
  // the destructive toast also lands in the durable error center.
  const resolveDroppedKnock = useCallback(
    (item: QueuedKnock, reason: string) => {
      const pins = (qc.getQueryData(["/api/leads/map"]) as { pins?: Array<{ id: number; address?: string }> } | undefined)?.pins;
      const address = pins?.find((p) => p.id === item.leadId)?.address ?? null;
      toast({ ...droppedKnockToast(address, reason), variant: "destructive" });
      void qc.invalidateQueries({ queryKey: ["/api/leads/map"] });
      void qc.invalidateQueries({ queryKey: ["/api/leads"] });
      void qc.invalidateQueries({ queryKey: ["/api/followups"] });
      void qc.invalidateQueries({ queryKey: [`/api/leads/${item.leadId}`] });
    },
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
      onResolved: resolveDroppedKnock,
    });
  }, [queueOwnerKey, reconcileSavedKnock, resolveDroppedKnock]);

  // Re-apply unsent knocks after every server read of the map, so a poll, the
  // map-changed stream, or a tab refocus can no longer revert a pin the rep has
  // already tapped. The overlay is derived from the queue's DURABLE pending set,
  // so it survives reload and clears itself the moment the knock lands.
  useEffect(() => {
    if (!queue) return;
    return installPendingKnockOverlay(qc, () => queue.getSnapshot().pendingOutcomes);
  }, [queue, qc]);

  const snap = useSyncExternalStore(
    useCallback(cb => queue ? queue.subscribe(cb) : () => {}, [queue]),
    useCallback(() => queue ? queue.getSnapshot() : EMPTY_SNAP, [queue]),
  );

  // Returns true only after the tap is synchronously persisted. GPS enriches
  // the durable row before its normal flush; reload recovery can safely submit
  // the row without location instead of losing the representative's action.
  const log = useCallback((lead: LogLead, outcome: KnockOutcome, opts: LogOpts = {}): boolean => {
    // SOURCE GUARD (owner report: permanently stuck "needs attention"): a temp
    // optimistic pin (negative id from the one-tap add, surfaced via the shared
    // map cache on Today/anywhere) must never enqueue a knock — the server has
    // never heard of that id, so delivery could only ever 404 forever.
    if (!isKnockableLeadId(lead.id)) {
      toast({
        title: "This door is still saving",
        description: "The pin hasn't finished syncing yet — give it a second, then log the outcome again.",
        variant: "destructive",
      });
      return false;
    }
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
    // lastOutcomeAt mirrors the server's CAS clock (the knock's knockedAt IS
    // what applyKnockOutcomeCas writes to last_outcome_at), so a teammate's
    // OLDER push arriving after this tap loses the stream merge's recency
    // comparison exactly like it loses the server CAS.
    // Instant feedback for THIS tap. The knockCount bump is applied only here —
    // the overlay deliberately does not increment, because it re-runs on every
    // read and a per-read increment would climb without bound.
    qc.setQueryData(["/api/leads/map"], (old: any) => {
      const bumped = old?.pins
        ? { ...old, pins: old.pins.map((p: any) => p.id === lead.id
            ? { ...p, knockCount: (p.knockCount ?? 0) + 1 }
            : p) }
        : old;
      // Same merge the overlay uses, so the immediate patch and every later
      // re-application can never disagree about what the pin should look like.
      return mergePendingOutcomes(bumped, { [lead.id]: { outcome, at } });
    });
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
