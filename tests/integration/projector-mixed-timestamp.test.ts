import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let rawDb: import("better-sqlite3").Database;
let projectConfirmedFreshLeads: typeof import("../../server/freshFiberProjector").projectConfirmedFreshLeads;
let storage: typeof import("../../server/storage").storage;
const TENANT = 1;

const SNAP_COLS = `(tenant_id,scan_target_id,run_id,checked_at,conclusive,fiber_available,fiber_status,household_segment_type,billing_status,customer_segment,customer_confidence,customer_signals,transition_status,fresh,api_source,evidence_hash,error,blocked,latency_ms)`;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-proj-ts-"));
  ({ rawDb } = await import("../../server/db"));
  const s = await import("../../server/storage");
  s.runMigrations();
  storage = s.storage;
  projectConfirmedFreshLeads = (await import("../../server/freshFiberProjector")).projectConfirmedFreshLeads;
});

describe("projector — mixed checked_at formats must not sink a Fresh Lead (Field Map ≡ Manual Check)", () => {
  it("a newer NEW FIBER snapshot wins over an OLDER ISO-format failed snapshot → one Fresh Lead", () => {
    const tid = Number(rawDb.prepare(`INSERT INTO scan_targets (address,city,state,zip,lat,lng,tenant_id,source) VALUES (?,?,?,?,?,?,?,'osm')`)
      .run("615 Nettie Dr", "Inman", "SC", "29349", 35.02, -82.08, TENANT).lastInsertRowid);

    // The discovery worker's conclusive NEW FIBER + billing N result.
    storage.recordScanTargetResult(tid, {
      fiberStatus: "new_fiber", fiberAvailable: true, isNewFiber: true, billingStatus: "N",
      availabilityStatus: "checked_available", newlyLive: false,
      customerSegment: "new_opportunity", customerConfidence: "high", customerSignals: [],
    });

    // OLDER failed snapshot in ISO format ("…T…Z") — chronologically EARLIER, but a raw
    // string sort places "T"(0x54) after " "(0x20), so the buggy query picked THIS one.
    rawDb.prepare(`INSERT INTO availability_snapshots ${SNAP_COLS}
      VALUES (?,?,NULL,'2026-07-16T14:56:24.230Z',0,NULL,'unknown',NULL,NULL,'unknown','low','[]','check_failed',0,'failed','h1','failed',0,NULL)`).run(TENANT, tid);
    // NEWER conclusive NEW FIBER snapshot in SQLite format (space) — chronologically LATER.
    rawDb.prepare(`INSERT INTO availability_snapshots ${SNAP_COLS}
      VALUES (?,?,NULL,'2026-07-16 15:06:15',1,1,'new_fiber','NEW FIBER','N','new_opportunity','high','[]','baseline_available',0,'kinetic_live','h2',NULL,0,NULL)`).run(TENANT, tid);

    // Sanity: the raw string sort DOES mis-rank the failed ISO snapshot as "latest".
    const strLatest = rawDb.prepare(`SELECT household_segment_type AS seg FROM availability_snapshots WHERE scan_target_id=? ORDER BY checked_at DESC, id DESC LIMIT 1`).get(tid) as any;
    expect(strLatest.seg).toBeNull(); // proves the bug exists in a naive string sort

    const res = projectConfirmedFreshLeads(TENANT, [tid]);
    expect(res.published).toBeGreaterThanOrEqual(1);
    const leads = rawDb.prepare(`SELECT lead_tag AS tag, billing_status AS b, household_segment_type AS seg FROM leads WHERE lower(address)='615 nettie dr'`).all() as any[];
    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({ tag: "fresh_fiber_confirmed", b: "N", seg: "NEW FIBER" });

    // Re-projecting is idempotent — no duplicate lead.
    projectConfirmedFreshLeads(TENANT, [tid]);
    expect((rawDb.prepare(`SELECT COUNT(*) n FROM leads WHERE lower(address)='615 nettie dr'`).get() as any).n).toBe(1);
  });
});
