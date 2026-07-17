// ── Fiber Transitions — the permanent "what changed" feed ────────────────────
// Every conclusive Kinetic answer passes through storage.recordScanTargetResult,
// which calls recordTransition() with the previous and new classification. Any
// CHANGE is written here once: an address that WENT LIVE (dark → fiber), a
// COPPER UPGRADE (legacy copper → NEW FIBER — the highest-value migration lead),
// a COMING SOON sighting, or a regression. Reps and automations read the feed
// instead of diffing snapshots — nothing is ever missed, nothing is recomputed.
import { rawDb } from "./db";
import { structuredLog } from "./structuredLog";

export type TransitionKind = "went_live" | "copper_upgrade" | "coming_soon" | "lost_fiber";

let ready = false;
export function ensureTransitionSchema(): void {
  if (ready) return;
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS fiber_transitions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER,
      scan_target_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT,
      from_billing TEXT,
      to_billing TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_ft_feed ON fiber_transitions(tenant_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_ft_target ON fiber_transitions(scan_target_id, created_at);
  `);
  ready = true;
}

const FIBER_POSITIVE = (fs: string | null | undefined, nf: boolean) =>
  nf || ["new_fiber", "fiber", "available"].includes(String(fs ?? "").toLowerCase());
const COPPERISH = (fs: string | null | undefined) =>
  ["copper", "legacy", "dsl", "legacy_copper", "not_available", "none", "unavailable", "no_service"]
    .includes(String(fs ?? "").toLowerCase());

/** Record a classification change. Called on every conclusive provider answer;
 * no-ops instantly when nothing changed. */
export function recordTransition(scanTargetId: number, prev: {
  fiberStatus: string | null; isNewFiber: boolean; billingStatus: string | null;
}, next: {
  fiberStatus: string | null; isNewFiber: boolean; billingStatus: string | null;
  fiberAvailable?: boolean | null;
}): void {
  const wasFiber = FIBER_POSITIVE(prev.fiberStatus, prev.isNewFiber);
  const isFiber = FIBER_POSITIVE(next.fiberStatus, next.isNewFiber);
  const prevBilling = String(prev.billingStatus ?? "").toUpperCase();
  const nextBilling = String(next.billingStatus ?? "").toUpperCase();
  let kind: TransitionKind | null = null;
  if (!wasFiber && isFiber) {
    // A flip to fiber. Copper/legacy/dark origins are copper upgrades — Kinetic
    // just trenched fiber past an existing copper address: the #1 migration lead.
    kind = COPPERISH(prev.fiberStatus) || prev.fiberStatus == null ? "copper_upgrade" : "went_live";
  } else if (isFiber && !["N", ""].includes(nextBilling) && ["", "N"].includes(prevBilling)) {
    kind = "coming_soon"; // fiber present, account flipped to active/pending
  } else if (wasFiber && !isFiber) {
    kind = "lost_fiber"; // regression — keep visible, never silent
  }
  if (!kind) return;
  try {
    ensureTransitionSchema();
    rawDb.prepare(
      `INSERT INTO fiber_transitions (tenant_id, scan_target_id, kind, from_status, to_status, from_billing, to_billing)
       SELECT tenant_id, id, ?, ?, ?, ?, ? FROM scan_targets WHERE id=?`,
    ).run(kind, prev.fiberStatus, next.fiberStatus, prev.billingStatus, next.billingStatus, scanTargetId);
    structuredLog("fiber.transition", { scanTargetId, kind, from: prev.fiberStatus, to: next.fiberStatus });
  } catch (e: any) {
    structuredLog("fiber.transition_failed", { scanTargetId, error: String(e?.message ?? e).slice(0, 120) }, "warn");
  }
}

export interface FiberChange {
  id: number; scanTargetId: number; kind: TransitionKind;
  fromStatus: string | null; toStatus: string | null;
  address: string; city: string; state: string; zip: string;
  lat: number | null; lng: number | null; leadId: number | null; at: string;
}

export function getFiberChanges(tenantId: number | null, hours = 168, limit = 300): {
  count: number; wentLive: number; copperUpgrades: number; comingSoon: number; rows: FiberChange[];
} {
  ensureTransitionSchema();
  const scope = tenantId == null ? "" : "AND t.tenant_id = ?";
  const rows = rawDb.prepare(
    `SELECT t.id, t.scan_target_id AS scanTargetId, t.kind, t.from_status AS fromStatus, t.to_status AS toStatus,
            t.created_at AS at, s.address, s.city, s.state, s.zip, s.lat, s.lng, s.converted_to_lead_id AS leadId
       FROM fiber_transitions t JOIN scan_targets s ON s.id = t.scan_target_id
      WHERE t.created_at >= datetime('now', ?) ${scope}
      ORDER BY t.created_at DESC LIMIT ?`,
  ).all(...(tenantId == null ? [`-${hours} hours`, limit] : [`-${hours} hours`, tenantId, limit])) as any[];
  return {
    count: rows.length,
    wentLive: rows.filter((r) => r.kind === "went_live").length,
    copperUpgrades: rows.filter((r) => r.kind === "copper_upgrade").length,
    comingSoon: rows.filter((r) => r.kind === "coming_soon").length,
    rows: rows as FiberChange[],
  };
}

/** The copper-upgrade CANDIDATE POOL: addresses whose last answer was copper or
 * legacy — tomorrow's migration leads, being rechecked by the daily sweep. */
export function getCopperPool(tenantId: number | null): { total: number; byState: Array<{ state: string; n: number }> } {
  const scope = tenantId == null ? "" : "AND tenant_id = ?";
  const args: any[] = tenantId == null ? [] : [tenantId];
  const byState = rawDb.prepare(
    `SELECT state, COUNT(*) n FROM scan_targets
      WHERE COALESCE(last_is_new_fiber,0)=0
        AND lower(COALESCE(last_fiber_status,'')) IN ('copper','legacy','dsl','legacy_copper','not_available','none','unavailable','no_service')
        ${scope} GROUP BY state ORDER BY n DESC`,
  ).all(...args) as any[];
  return { total: byState.reduce((s, r) => s + Number(r.n), 0), byState };
}
