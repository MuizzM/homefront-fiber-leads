// ── Push subscriptions: storage, fan-out, and pruning ───────────────────────
// One row per DEVICE, not per user — a rep with a phone and a tablet has two,
// and both should buzz. The endpoint URL is the natural key: the push service
// mints a unique one per (device, origin, permission grant), so re-subscribing
// on the same phone updates the row instead of duplicating it.
//
// PRUNING IS NOT HOUSEKEEPING, IT IS CORRECTNESS. Push services return 404/410
// for a subscription that no longer exists — app deleted, permission revoked,
// device wiped. Left in the table those endpoints are attempted on every single
// send forever, and each one costs a full HTTPS round trip to Apple or Google
// before failing. A few hundred dead rows turn a fan-out into a timeout.

import { rawDb } from "./db";
import { sendPush, generateVapidKeys, type PushSubscription, type VapidKeys } from "./webPush";
import { storage } from "./storage";

export function ensurePushSchema(): void {
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      rep_id INTEGER,
      endpoint TEXT NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      user_agent TEXT,
      created_at TEXT NOT NULL,
      last_ok_at TEXT,
      fail_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_push_endpoint ON push_subscriptions(endpoint);
    CREATE INDEX IF NOT EXISTS idx_push_tenant ON push_subscriptions(tenant_id, user_id);
  `);
}
ensurePushSchema();

const VAPID_SETTING = "push.vapid";

/**
 * The org's VAPID keypair, generated once on first use.
 *
 * Stored rather than read from env because it must SURVIVE and stay stable: the
 * public key is baked into every live subscription, so regenerating it silently
 * invalidates every device that has already subscribed. Generating once and
 * persisting is what makes "it stopped working after a redeploy" impossible.
 */
export function vapidKeys(): VapidKeys | null {
  try {
    const raw = storage.getSetting(VAPID_SETTING, 0);
    if (raw) {
      const p = JSON.parse(raw);
      if (p?.publicKey && p?.privateKey) {
        return { publicKey: p.publicKey, privateKey: p.privateKey, subject: p.subject || defaultSubject() };
      }
    }
    const fresh = { ...generateVapidKeys(), subject: defaultSubject() };
    storage.setSetting(VAPID_SETTING, JSON.stringify(fresh), null, 0);
    return fresh;
  } catch { return null; }
}

function defaultSubject(): string {
  // Apple rejects a token whose `sub` is not a usable mailto:/https: contact.
  const configured = process.env.PUSH_CONTACT?.trim();
  if (configured && /^(mailto:|https:)/.test(configured)) return configured;
  return "mailto:support@homefrontsolutionsllc.com";
}

/** The key the browser needs to call pushManager.subscribe(). Public by design. */
export function publicKey(): string | null {
  return vapidKeys()?.publicKey ?? null;
}

/** Devices one user may keep registered. A rep has a phone, maybe a tablet;
 *  past that it is churn (reinstalls mint a NEW endpoint) or abuse. Uncapped,
 *  one account could register thousands of endpoints, and every fan-out then
 *  awaits a POST to each - the fan-out is the cost, not the row. */
export const MAX_SUBSCRIPTIONS_PER_USER = 12;

export function saveSubscription(input: {
  tenantId: number; userId: number; repId: number | null;
  endpoint: string; p256dh: string; auth: string; userAgent?: string | null;
}): void {
  // Evict oldest-first past the cap, AFTER the upsert below would have run -
  // done here so a re-subscribe of an existing endpoint (the common case, and
  // an UPDATE not an INSERT) can never evict anything.
  const existing = rawDb.prepare(
    `SELECT 1 FROM push_subscriptions WHERE endpoint = ?`,
  ).get(input.endpoint);
  if (!existing) {
    rawDb.prepare(
      `DELETE FROM push_subscriptions
        WHERE endpoint IN (
          SELECT endpoint FROM push_subscriptions
           WHERE tenant_id = ? AND user_id = ?
           ORDER BY created_at DESC
           LIMIT -1 OFFSET ?)`,
    ).run(input.tenantId, input.userId, MAX_SUBSCRIPTIONS_PER_USER - 1);
  }
  rawDb.prepare(
    `INSERT INTO push_subscriptions
       (tenant_id, user_id, rep_id, endpoint, p256dh, auth, user_agent, created_at)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(endpoint) DO UPDATE SET
       tenant_id = excluded.tenant_id,
       user_id   = excluded.user_id,
       rep_id    = excluded.rep_id,
       p256dh    = excluded.p256dh,
       auth      = excluded.auth,
       -- A device that re-subscribes is alive again; clear the failure count or
       -- it stays permanently one strike from being pruned.
       fail_count = 0`,
  ).run(input.tenantId, input.userId, input.repId, input.endpoint, input.p256dh, input.auth,
        input.userAgent ?? null, new Date().toISOString());
}

export function removeSubscription(endpoint: string): void {
  rawDb.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`).run(endpoint);
}

export function subscriptionCount(tenantId: number, userId?: number): number {
  const row = userId != null
    ? rawDb.prepare(`SELECT COUNT(*) AS n FROM push_subscriptions WHERE tenant_id = ? AND user_id = ?`).get(tenantId, userId)
    : rawDb.prepare(`SELECT COUNT(*) AS n FROM push_subscriptions WHERE tenant_id = ?`).get(tenantId);
  return Number((row as any)?.n ?? 0);
}

export interface PushMessage {
  title: string;
  body: string;
  /** Where tapping it lands. Relative path. */
  url?: string;
  /** Collapse key — a newer message with the same tag REPLACES the older one on
   *  the device rather than stacking. "Power Hour, 20 min left" should overwrite
   *  "Power Hour, 40 min left", not sit beneath it. */
  tag?: string;
}

/**
 * Send to every device belonging to these users, except `exceptUserId`.
 *
 * Fire-and-forget from the caller's point of view: a knock must never wait on
 * Apple's servers. Failures prune or count; they never propagate.
 */
export async function pushToUsers(
  tenantId: number, userIds: number[], msg: PushMessage, exceptUserId?: number | null,
): Promise<{ sent: number; pruned: number }> {
  const keys = vapidKeys();
  const targets = userIds.filter(u => u !== exceptUserId);
  if (!keys || targets.length === 0) return { sent: 0, pruned: 0 };

  const placeholders = targets.map(() => "?").join(",");
  const rows = rawDb.prepare(
    `SELECT * FROM push_subscriptions WHERE tenant_id = ? AND user_id IN (${placeholders})`,
  ).all(tenantId, ...targets) as any[];
  if (!rows.length) return { sent: 0, pruned: 0 };

  const payload = JSON.stringify({
    title: msg.title, body: msg.body, url: msg.url ?? "/", tag: msg.tag ?? "hfs",
  });
  const now = Date.now();

  let sent = 0, pruned = 0;
  const results = await Promise.all(rows.map(async r => {
    const sub: PushSubscription = { endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth };
    const res = await sendPush(sub, payload, keys, now);
    return { endpoint: r.endpoint, res };
  }));

  for (const { endpoint, res } of results) {
    if (res.ok) {
      sent += 1;
      rawDb.prepare(`UPDATE push_subscriptions SET last_ok_at = ?, fail_count = 0 WHERE endpoint = ?`)
        .run(new Date(now).toISOString(), endpoint);
    } else if (res.gone) {
      // Definitive: the push service says this subscription no longer exists.
      removeSubscription(endpoint);
      pruned += 1;
    } else {
      // A transient failure (network blip, 500 at the provider) only counts.
      // Pruning here would delete every device during an outage.
      const row = rawDb.prepare(
        `UPDATE push_subscriptions SET fail_count = fail_count + 1 WHERE endpoint = ?
         RETURNING fail_count AS n`,
      ).get(endpoint) as any;
      if (Number(row?.n ?? 0) >= 10) { removeSubscription(endpoint); pruned += 1; }
    }
  }
  return { sent, pruned };
}

/** Every user in the tenant who could receive a broadcast. */
export function tenantUserIds(tenantId: number): number[] {
  return (rawDb.prepare(
    `SELECT DISTINCT user_id AS id FROM push_subscriptions WHERE tenant_id = ?`,
  ).all(tenantId) as any[]).map(r => Number(r.id));
}
