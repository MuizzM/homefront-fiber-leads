import type Database from "better-sqlite3";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import { retrySqliteOperation } from "./interactiveDb";

export const OUTBOX_PRUNE_BATCH = 500;
const OUTBOX_PRUNE_RETRY_MS = 15_000;

/** Finite, restart-safe retention for each organization's pending alerts.
 * Live deliveries win over retention; they may temporarily exceed the cap.
 * No payload is loaded, no notification is sent, and no row is deleted. */
export async function pruneTenantAlertBacklogs(db: Database.Database, keep: number): Promise<number> {
  if (!Number.isSafeInteger(keep) || keep < 1) throw new Error("Outbox retention must be a positive integer.");
  const snapshot = db.prepare("SELECT COALESCE(MAX(id),0) id, datetime('now') at FROM notification_outbox").get() as { id: number; at: string };
  const firstTenant = db.prepare(`SELECT tenant_id FROM notification_outbox
    WHERE kind='fresh_fiber' AND status='pending' AND id<=? ORDER BY tenant_id LIMIT 1`);
  const nextTenant = db.prepare(`SELECT tenant_id FROM notification_outbox
    WHERE kind='fresh_fiber' AND status='pending' AND tenant_id>? AND id<=? ORDER BY tenant_id LIMIT 1`);
  const cutoffFor = db.prepare(`SELECT id FROM notification_outbox
    WHERE kind='fresh_fiber' AND status='pending' AND tenant_id=? AND id<=?
    ORDER BY id DESC LIMIT 1 OFFSET ?`);
  const candidates = db.prepare(`SELECT id FROM notification_outbox
    WHERE kind='fresh_fiber' AND status='pending' AND tenant_id=? AND id<=? AND id>?
      AND (lease_expires_at IS NULL OR lease_expires_at<=?) ORDER BY id LIMIT ?`);
  let tenant = firstTenant.get(snapshot.id) as { tenant_id: number } | undefined;
  let total = 0;
  while (tenant) {
    const tenantId = tenant.tenant_id;
    const cutoff = cutoffFor.get(tenantId, snapshot.id, keep) as { id: number } | undefined;
    if (cutoff) {
      let afterId = 0;
      for (;;) {
        const ids = (candidates.all(tenantId, cutoff.id, afterId, snapshot.at, OUTBOX_PRUNE_BATCH) as { id: number }[]).map(row => row.id);
        if (!ids.length) break;
        const update = db.prepare(`UPDATE notification_outbox SET status='superseded',last_error='outbox backlog pruned',lease_owner=NULL,lease_expires_at=NULL
          WHERE tenant_id=? AND kind='fresh_fiber' AND status='pending'
            AND id IN (${ids.map(() => "?").join(",")})
            AND (lease_expires_at IS NULL OR lease_expires_at<=?)`);
        total += await retrySqliteOperation(db, () => update.run(tenantId, ...ids, snapshot.at).changes, OUTBOX_PRUNE_RETRY_MS);
        afterId = ids[ids.length - 1];
        await yieldToLoop();
      }
    }
    await yieldToLoop();
    tenant = nextTenant.get(tenantId, snapshot.id) as { tenant_id: number } | undefined;
  }
  return total;
}
