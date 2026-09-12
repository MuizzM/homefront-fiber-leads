import type Database from "better-sqlite3";
import { interactiveTransaction } from "./interactiveDb";
import { scannerReliabilitySnapshot } from "./scannerReliability";
import { AssignmentOperationError, requireAssignmentOwner } from "./assignmentOperationStore";
import { recoveryActorAllowed } from "./recoveryAuthority";

export interface RecoveryItem {
  id: string; category: "login" | "notification" | "financial";
  status: string; attempts: number; at: string; guidance: string; replayable: boolean; eventType?: string;
}
/** Metadata only: never project message payloads, recipients or raw errors. */
export function recoverySnapshot(db: Database.Database, tenantId: number) {
  requireAssignmentOwner({ tenantId, userId: 1 });
  const login = db.prepare(`SELECT id,status,attempts,created_at FROM auth_delivery_outbox
    WHERE tenant_id=? AND status='failed' ORDER BY created_at DESC LIMIT 50`).all(tenantId) as Array<{ id: string; status: string; attempts: number; created_at: number }>;
  const notifications = db.prepare(`SELECT id,status,attempts,created_at FROM notification_outbox
    WHERE tenant_id=? AND status='failed' ORDER BY id DESC LIMIT 50`).all(tenantId) as Array<{ id: number; status: string; attempts: number; created_at: string }>;
  const financial = db.prepare(`SELECT s.event_id,e.type AS event_type,s.status,s.attempts,s.updated_at,
    COALESCE((SELECT last_event_id FROM event_subscriptions WHERE name=s.subscriber),0) AS cursor FROM event_processing_state s
    JOIN domain_events e ON e.id=s.event_id WHERE e.tenant_id=? AND s.subscriber='incentives'
      AND s.status IN ('failed','blocked','dead_lettered')
    ORDER BY (s.status='dead_lettered'),CASE WHEN s.status!='dead_lettered' THEN s.event_id END,s.event_id DESC
    LIMIT 50`).all(tenantId) as Array<{ event_id: number; event_type: string; cursor: number; status: string; attempts: number; updated_at: string }>;
  const items: RecoveryItem[] = [
    ...login.map(row => ({ id: row.id, category: "login" as const, status: row.status, attempts: row.attempts,
      at: new Date(row.created_at).toISOString(), guidance: "Request a fresh sign-in code. Previous codes cannot be replayed.", replayable: false })),
    ...notifications.map(row => ({ id: String(row.id), category: "notification" as const, status: row.status, attempts: row.attempts,
      at: row.created_at, guidance: "Delivery could be partially complete. Review the delivery history before sending a new alert.", replayable: false })),
    ...financial.map(row => ({ id: String(row.event_id), category: "financial" as const, status: row.status, attempts: row.attempts,
      at: row.updated_at, eventType: row.event_type,
      guidance: row.event_id <= row.cursor ? "The queue has advanced past this event. Review its financial effects with an administrator; replay is unavailable."
        : "Review the cause before retrying. Setting aside lets the queue advance without processing this event.", replayable: row.event_id > row.cursor })),
  ];
  const queue = db.prepare(`SELECT status,COUNT(*) AS count,MIN(created_at) AS oldestAt FROM auth_delivery_outbox WHERE tenant_id=? GROUP BY status`).all(tenantId);
  const assignments = db.prepare(`SELECT COUNT(*) AS operations,COALESCE(SUM(replays),0) AS replays FROM assignment_operations WHERE tenant_id=?`).get(tenantId);
  const pendingAssignments = db.prepare(`SELECT id,actor_user_id AS actorUserId,rep_id AS repId,created_at AS createdAt,state,total,updated,restored FROM assignment_operations
    WHERE tenant_id=? AND state IN ('running','undoing') ORDER BY created_at LIMIT 8`).all(tenantId);
  const countChecks = db.prepare(`SELECT run_id AS runId,checked_at AS checkedAt,verified,actual_verified AS actualVerified,failed,actual_failed AS actualFailed FROM scanner_count_checks WHERE tenant_id=? ORDER BY checked_at DESC LIMIT 50`).all(tenantId);
  return { items, queue, assignments, pendingAssignments, countChecks, scanners: scannerReliabilitySnapshot(db, tenantId), limitPerCategory: 50 };
}

export async function discardDelivery(db: Database.Database, owner: { tenantId: number; userId: number; sessionId?: string }, category: "login" | "notification", id: string, reason: string) {
  requireAssignmentOwner(owner);
  if (reason.trim().length < 5 || reason.length > 500) throw new AssignmentOperationError("REASON_REQUIRED", 400, "Explain why this item should be discarded");
  return interactiveTransaction(db, () => {
    if (!recoveryActorAllowed(db, owner)) throw new AssignmentOperationError("FORBIDDEN", 403, "Recovery access has changed");
    const table = category === "login" ? "auth_delivery_outbox" : "notification_outbox";
    const row = db.prepare(`SELECT status FROM ${table} WHERE id=? AND tenant_id=?`).get(id, owner.tenantId) as { status: string } | undefined;
    if (!row) throw new AssignmentOperationError("NOT_FOUND", 404, "Recovery item not found");
    if (row.status !== "failed") throw new AssignmentOperationError("STATE_CHANGED", 409, "This recovery item has changed. Refresh the list");
    db.prepare(`UPDATE ${table} SET status='discarded',payload=? WHERE id=? AND tenant_id=? AND status='failed'`)
      .run(category === "login" ? null : "{}", id, owner.tenantId);
    db.prepare(`INSERT INTO activity_log(tenant_id,user_id,action,entity_type,details,at) VALUES (?,?,'delivery.discard',?,?,?)`)
      .run(owner.tenantId, owner.userId, category, JSON.stringify({ operationId: id, reason: reason.trim() }), new Date().toISOString());
    return { discarded: true };
  });
}
