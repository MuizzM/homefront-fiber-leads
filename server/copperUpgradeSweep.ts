// ── Copper-Upgrade Sweep — first-to-know on legacy-copper → fiber transitions ──
// Kinetic keeps upgrading legacy-copper neighborhoods to fiber. The address that
// answered "copper / no fiber" last month can answer NEW FIBER tomorrow — and the
// first team to knock wins it. This sweep rechecks every known non-fiber address
// on a rolling 7-day cadence through the normal durable scan pipeline, so the
// moment one flips to NEW FIBER + billing inactive it publishes as a deduplicated
// green assignable Fresh Lead with nearby expansion — zero operator action.
import { rawDb } from "./db";
import * as scanService from "./scanService";
import { structuredLog } from "./structuredLog";
import { registerFootprintSqlFunctions, warmFootprintGate } from "./footprintGate";

const STALE_DAYS = Math.max(1, Number(process.env.COPPER_UPGRADE_STALE_DAYS) || 7);
const BATCH = Math.max(1_000, Number(process.env.COPPER_UPGRADE_BATCH) || 20_000);


let carrierColKnown: boolean | null = null;
function hasCarrierColumn(): boolean {
  if (carrierColKnown != null) return carrierColKnown;
  try {
    carrierColKnown = (rawDb.prepare(`PRAGMA table_xinfo(scan_targets)`).all() as Array<{ name: string }>)
      .some((c) => c.name === "carrier");
  } catch { carrierColKnown = false; }
  return carrierColKnown;
}

export function runCopperUpgradeSweep(tenantId: number): { queued: number } {
  // Every target whose last conclusive answer was NOT new-fiber — copper, legacy
  // service, no service, unavailable — and that hasn't been checked within the
  // staleness window. Fresh-lead targets and already-converted addresses are
  // excluded (they're covered by the fresh-lead pipeline and lead workflow).
  //
  // FOOTPRINT-GATED: a copper address outside the Kinetic footprint can never
  // flip to Kinetic fiber, yet ungated inventory (e.g. the 37k-address
  // Hillsborough harvest — Frontier/AT&T territory) was diluting this sweep's
  // daily budget and stretching the real copper towns' effective cadence far
  // past STALE_DAYS. footprint_city() fails OPEN if the market table is absent,
  // so a bare replay/test DB sweeps everything exactly as before.
  registerFootprintSqlFunctions();
  warmFootprintGate();
  // Kinetic-only NC/SC scope. Column-defensive like the footprint gate: a bare
  // replay/test DB without the carrier column sweeps everything as before.
  const kineticOnly = hasCarrierColumn() ? `AND COALESCE(carrier,'kinetic')='kinetic' AND upper(state) IN ('NC','SC')` : "";
  const rows = rawDb.prepare(
    `SELECT id FROM scan_targets
     WHERE tenant_id=? AND converted_to_lead_id IS NULL
       ${kineticOnly}
       AND COALESCE(last_is_new_fiber, 0) = 0
       AND last_fiber_status IS NOT NULL
       AND footprint_city(state, city)=1
       AND (last_scanned_at IS NULL OR last_scanned_at < datetime('now', ?))
     ORDER BY last_scanned_at ASC LIMIT ?`,
  ).all(tenantId, `-${STALE_DAYS} days`, BATCH) as any[];
  const ids = rows.map((r) => Number(r.id));
  let queued = 0;
  for (let i = 0; i < ids.length; i += 5_000) {
    const batch = ids.slice(i, i + 5_000);
    scanService.startTargetRun({
      tenantId, city: "(copper-upgrade)", state: "", targetIds: batch,
      runKind: "copper_upgrade", label: `Copper-upgrade sweep (${batch.length})`,
    });
    queued += batch.length;
  }
  if (queued) structuredLog("copper_upgrade.sweep", { tenantId, queued, staleDays: STALE_DAYS });
  return { queued };
}
