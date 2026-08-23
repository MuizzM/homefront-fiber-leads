// ── Doors that ALREADY have service ──────────────────────────────────────────
//
// Fiber being live at an address is not the same as the address being sellable.
// Measured live on Howard St / Hilbert Rd in Rockwell: of ten doors that came
// back NEW FIBER, eight already had an active account. A rep looking at the map
// could not tell those apart from an open door, because the lead projector only
// ever publishes NEW FIBER + billing N - so an already-served house is filtered
// out upstream and never becomes a pin at all.
//
// This is the read model for those houses. They are NOT leads and must never be
// mistaken for them: no lead row, no assignment, no knock queue. They exist so a
// rep can see, on the map, which houses are already taken.
//
// THE SIGNAL IS BILLING, NOT THE SEGMENT.
//
// The first version of this keyed on last_fiber_status='tenured_fiber' because
// it was numerically dominant (8,679 NC kinetic doors against 250 tagged
// existing_customer). That was wrong in a way that would have actively hurt:
// TENURED means Kinetic has plant and history at the address, NOT that anyone
// is paying for it. Measured across NC kinetic scan_targets:
//
//   the tenured-based predicate would paint blue .... 8,763
//   doors that actually carry active billing ........ 4,158
//   WRONGLY hidden from reps as already-sold ........ 5,839
//
// A live 40-door Rockwell run showed the same thing address by address: nine
// came back TENURED with billing N - fiber present, nobody on it - against two
// at TENURED billing A. Painting those nine blue tells a rep to walk past a
// door they could sell.
//
// So the test is active billing, an explicit existing_customer segment, or an
// account number on file. Nothing else.
import { rawDb } from "./db";

export interface ServedDoor {
  id: number;
  lat: number;
  lng: number;
  address: string;
  city: string;
  /** Why we believe this door is taken - shown to the rep, never inferred client-side. */
  reason: "active_billing" | "existing_customer" | "account_on_file";
}

export interface ServedDoorWindow {
  minLat: number; maxLat: number; minLng: number; maxLng: number;
}

/**
 * Served doors inside a viewport.
 *
 * `cap` bounds the response the same way the lead map does: fetch cap+1 so the
 * caller can honestly say it truncated rather than silently dropping pins.
 */
export function servedDoorsInBbox(
  tenantId: number,
  w: ServedDoorWindow,
  cap = 5_000,
): { doors: ServedDoor[]; truncated: boolean } {
  // Drive the window off cell_lat/cell_lng, which are generated ROUND(lat,2)
  // columns already covered by idx_scan_targets_cell (tenant_id, cell_lat,
  // cell_lng, ...). Filtering on raw lat/lng instead made the planner fall back
  // to a tenant-prefixed index and walk the table - measured 412 ms for one
  // Rockwell window, which does not hold on production's larger table. Adding a
  // second spatial index to an 18.8 GB table to fix that would be the expensive
  // way to buy something the existing index already gives.
  //
  // The cell bounds are widened by one cell because ROUND can move a point by
  // up to 0.005 either way; the exact lat/lng predicate below is what actually
  // defines the window, so the widening only costs a few extra candidate rows.
  const CELL = 0.01;
  const rows = rawDb.prepare(
    `SELECT id, lat, lng, address, city,
            CASE
              WHEN account_number IS NOT NULL                  THEN 'account_on_file'
              WHEN last_customer_segment = 'existing_customer' THEN 'existing_customer'
              ELSE 'active_billing'
            END AS reason
       FROM scan_targets
      WHERE tenant_id = ?
        AND cell_lat BETWEEN ? AND ? AND cell_lng BETWEEN ? AND ?
        AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?
        AND ( last_billing_status = 'A'
           OR last_customer_segment = 'existing_customer'
           OR account_number IS NOT NULL )
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
    doors: (truncated ? rows.slice(0, cap) : rows).map((r) => ({
      id: Number(r.id),
      lat: Number(r.lat),
      lng: Number(r.lng),
      address: String(r.address ?? ""),
      city: String(r.city ?? ""),
      reason: r.reason as ServedDoor["reason"],
    })),
  };
}
