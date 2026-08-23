// ── Scanned doors on the field map ───────────────────────────────────────────
//
// A door we have asked Kinetic about has an answer, and that answer is worth
// showing a rep even when it does not produce a lead. The lead projector only
// publishes NEW FIBER + billing N, so every other verdict was invisible: a rep
// standing on a street we had already scanned saw bare map.
//
// THE SIGNAL IS SEGMENT *AND* BILLING. NEITHER ALONE IS ENOUGH.
//
// TENURED means Kinetic has plant and history at the address. It does NOT mean
// anyone is paying. Measured across scanned NC targets:
//
//   tenured, active account ....... 2,962   taken, walk past
//   tenured, NO account ........... 6,574   fiber at the curb, nobody on it
//
// An earlier version of this file keyed the whole layer on
// last_fiber_status='tenured_fiber' and painted all 9,536 the same. That would
// have told reps to skip 6,574 doors that are workable. The tag below splits
// them, because the split is the entire value of the layer.
//
// That earlier version also tested `account_number IS NOT NULL`. That column is
// created on demand by ensureAccountSchema() in customerAccount.ts, which is
// called only from that module's own three functions - never at boot, and not
// by runMigrations(). So whether the query worked depended on whether some
// unrelated code path had happened to run first: it is absent from the repo's
// data.db and .dev-verify (where the query throws `no such column`, and the
// client's `if (!r.ok) return` swallows it), and present on every database a
// server has exercised. A read model must not be a coin flip on boot order, so
// only columns guaranteed by runMigrations() are used here.
import { rawDb } from "./db";

/** What a rep is looking at. Derived on the server so the client cannot drift. */
export type DoorTag = "new_fiber" | "tenured_active" | "fiber_open";

export interface ScannedDoor {
  id: number;
  lat: number;
  lng: number;
  address: string;
  city: string;
  tag: DoorTag;
  /** Short human label. Server-owned so the map, the card and the legend agree. */
  label: string;
  scannedAt: string | null;
  /** Set when the door already became a lead, so the card can link to it. */
  leadId: number | null;
}

export interface DoorWindow { minLat: number; maxLat: number; minLng: number; maxLng: number }

export const DOOR_TAG_LABEL: Record<DoorTag, string> = {
  new_fiber: "New Fiber",
  tenured_active: "Tenured",
  fiber_open: "Fiber, no account",
};

// Doors with no fiber verdict (copper, no_service) are deliberately NOT
// returned. They are 20,000+ of the scanned population and pin them and the
// street disappears under grey dots that mean "nothing here".
const TAG_SQL = `
  CASE
    WHEN last_is_new_fiber = 1 AND COALESCE(last_billing_status,'') <> 'A' THEN 'new_fiber'
    WHEN COALESCE(last_billing_status,'') = 'A'
      OR last_customer_segment = 'existing_customer'                       THEN 'tenured_active'
    ELSE 'fiber_open'
  END`;

const HAS_FIBER_VERDICT = `
  ( last_is_new_fiber = 1
 OR last_fiber_status IN ('tenured_fiber','new_fiber','existing_fiber')
 OR last_fiber_available = 1 )`;

/**
 * Scanned doors inside a viewport.
 *
 * `cap` bounds the response the way the lead map does: fetch cap+1 so the
 * caller can say honestly that it truncated rather than silently dropping pins.
 */
export function scannedDoorsInBbox(
  tenantId: number,
  w: DoorWindow,
  cap = 5_000,
): { doors: ScannedDoor[]; truncated: boolean } {
  // Drive the window off cell_lat/cell_lng, the generated ROUND(lat,2) columns
  // covered by idx_scan_targets_cell (tenant_id, cell_lat, cell_lng, ...).
  // Filtering on raw lat/lng made the planner fall back to a tenant-prefixed
  // index and walk the table: 412 ms for one Rockwell window, which will not
  // hold on production's larger table. The cell bounds are widened by one cell
  // because ROUND can move a point up to 0.005 either way; the exact lat/lng
  // predicate is what actually defines the window.
  const CELL = 0.01;
  const rows = rawDb.prepare(
    `SELECT id, lat, lng, address, city, last_scanned_at AS scannedAt,
            converted_to_lead_id AS leadId,
            ${TAG_SQL} AS tag
       FROM scan_targets
      WHERE tenant_id = ?
        AND cell_lat BETWEEN ? AND ? AND cell_lng BETWEEN ? AND ?
        AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?
        AND last_scanned_at IS NOT NULL
        AND ${HAS_FIBER_VERDICT}
      LIMIT ?`,
  ).all(
    tenantId,
    w.minLat - CELL, w.maxLat + CELL, w.minLng - CELL, w.maxLng + CELL,
    w.minLat, w.maxLat, w.minLng, w.maxLng,
    cap + 1,
  ) as any[];

  const truncated = rows.length > cap;
  return {
    truncated,
    doors: (truncated ? rows.slice(0, cap) : rows).map((r) => {
      const tag = r.tag as DoorTag;
      return {
        id: Number(r.id),
        lat: Number(r.lat),
        lng: Number(r.lng),
        address: String(r.address ?? ""),
        city: String(r.city ?? ""),
        tag,
        label: DOOR_TAG_LABEL[tag] ?? "Scanned",
        scannedAt: r.scannedAt ? String(r.scannedAt) : null,
        leadId: r.leadId == null ? null : Number(r.leadId),
      };
    }),
  };
}
