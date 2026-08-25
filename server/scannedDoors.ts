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
import { ensureComingLedgerSchema } from "./comingLedger";

/** What a rep is looking at. Derived on the server so the client cannot drift. */
export type DoorTag = "new_fiber" | "fiber_open" | "tenured_active" | "coming_soon" | "unverified";

export interface ScannedDoor {
  id: number;
  lat: number;
  lng: number;
  address: string;
  city: string;
  tag: DoorTag;
  /** Short human label. Server-owned so the map, the card and the legend agree. */
  label: string;
  /** When we last asked the provider about this door. */
  scannedAt: string | null;
  /** Provider-stated turn-on date (YYYY-MM-DD), only ever the carrier's own. */
  promisedDate: string | null;
  /** How precise the promise is: hot / soon / watch. */
  band: string | null;
  /** The carrier's own words, so a date on the map can always be audited. */
  providerQuote: string | null;
  /** Set when the door already became a lead, so the card can link to it. */
  leadId: number | null;
}

export interface DoorWindow { minLat: number; maxLat: number; minLng: number; maxLng: number }

export const DOOR_TAG_LABEL: Record<DoorTag, string> = {
  new_fiber: "New Fiber",
  fiber_open: "Fiber, no account",
  tenured_active: "Already a customer",
  coming_soon: "Coming soon",
  unverified: "Not verified",
};

// Doors with no fiber verdict (copper, no_service) are deliberately NOT
// returned. They are 20,000+ of the scanned population and pin them and the
// street disappears under grey dots that mean "nothing here".
// COMING SOON WINS. A door the carrier has promised is a date to work, and it
// is frequently NOT serviceable yet - so the promise is tested before any
// current-availability clause, or a planned build would read as "no fiber" and
// be dropped by the verdict gate below.
const TAG_SQL = `
  CASE
    WHEN w.scan_target_id IS NOT NULL                                       THEN 'coming_soon'
    -- A CUSTOMER IS A CUSTOMER ON EITHER VALUE. Kinetic returns BOTH 'Y' and
    -- 'A' for an address with an active account (live-verified: 4051 Dakeita
    -- Cir answers 'A'). Testing only 'A' left every billing-'Y' household
    -- painted as a workable pin, which is a rep knocking a door already sold.
    WHEN COALESCE(s.last_billing_status,'') IN ('Y','A')
      OR s.last_customer_segment = 'existing_customer'                      THEN 'tenured_active'
    -- A LEAD PIN CLAIMS SELLABLE TODAY, so it needs BOTH halves: nobody on the
    -- door AND fiber actually qualified. last_fiber_status cannot carry the
    -- second half by itself - it is derived from the household segment
    -- (server/scanner.ts takes its TENURED branch before it ever consults
    -- parsed.fiberQualified), which is how 49 China Grove doors read as lit
    -- while the only body we hold for them says NOV-2026.
    WHEN s.last_fiber_available = 1 AND s.last_is_new_fiber = 1             THEN 'new_fiber'
    WHEN s.last_fiber_available = 1                                        THEN 'fiber_open'
    -- Answered and fiber-shaped, but with no qualification on record. Still
    -- drawn, because hiding it would silently shrink a street a rep already
    -- walked - just never as a lead. The ledger's weekly lane resolves these.
    ELSE 'unverified'
  END`;

// A door earns a pin by having fiber TODAY, or by the carrier having promised
// it. Copper and no_service without a promise stay off the map - they are
// 20,000+ grey dots that mean "nothing here".
const HAS_FIBER_VERDICT = `
  ( s.last_is_new_fiber = 1
 OR s.last_fiber_status IN ('tenured_fiber','new_fiber','existing_fiber')
 OR s.last_fiber_available = 1
 OR w.scan_target_id IS NOT NULL )`;

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
  // promised_date, band and provider_quote are added by ensureComingLedgerSchema,
  // not by runMigrations - so on a database no coming-soon code has touched they
  // do not exist and this query throws `no such column`. That is exactly the
  // failure that left the previous version of this layer silently drawing
  // nothing, so the read model asks for the schema instead of assuming it.
  ensureComingLedgerSchema();
  // Drive the window off cell_lat/cell_lng, the generated ROUND(lat,2) columns
  // covered by idx_scan_targets_cell (tenant_id, cell_lat, cell_lng, ...).
  // Filtering on raw lat/lng made the planner fall back to a tenant-prefixed
  // index and walk the table: 412 ms for one Rockwell window, which will not
  // hold on production's larger table. The cell bounds are widened by one cell
  // because ROUND can move a point up to 0.005 either way; the exact lat/lng
  // predicate is what actually defines the window.
  const CELL = 0.01;
  const rows = rawDb.prepare(
    `SELECT s.id, s.lat, s.lng, s.address, s.city, s.last_scanned_at AS scannedAt,
            s.converted_to_lead_id AS leadId,
            w.promised_date AS promisedDate, w.band AS band, w.provider_quote AS providerQuote,
            ${TAG_SQL} AS tag
       FROM scan_targets s
       -- Only an OPEN promise counts. A closed or already-promoted watch row is
       -- history, and painting it as "coming soon" would send a rep to a door
       -- the carrier already turned on or gave up on.
       LEFT JOIN coming_soon_watchlist w
              ON w.scan_target_id = s.id AND w.tenant_id = s.tenant_id
             AND COALESCE(w.status,'active') IN ('active','now_active')
      WHERE s.tenant_id = ?
        AND s.cell_lat BETWEEN ? AND ? AND s.cell_lng BETWEEN ? AND ?
        AND s.lat BETWEEN ? AND ? AND s.lng BETWEEN ? AND ?
        AND (s.last_scanned_at IS NOT NULL OR w.scan_target_id IS NOT NULL)
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
        promisedDate: r.promisedDate ? String(r.promisedDate) : null,
        band: r.band ? String(r.band) : null,
        providerQuote: r.providerQuote ? String(r.providerQuote) : null,
        leadId: r.leadId == null ? null : Number(r.leadId),
      };
    }),
  };
}
