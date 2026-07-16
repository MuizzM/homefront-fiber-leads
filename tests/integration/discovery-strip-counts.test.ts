import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let rawDb: import("better-sqlite3").Database;
let store: typeof import("../../server/addressDiscovery/store");
let publicJob: typeof import("../../server/addressDiscovery/routes").publicJob;
const TENANT = 1;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-strip-counts-"));
  ({ rawDb } = await import("../../server/db"));
  const storage = await import("../../server/storage");
  storage.runMigrations();
  store = await import("../../server/addressDiscovery/store");
  ({ publicJob } = await import("../../server/addressDiscovery/routes"));
  rawDb.prepare(`INSERT OR IGNORE INTO users (id,name,email,role,active,tenant_id)
    VALUES (1,'Owner','owner@example.com','admin',1,1)`).run();
});

function makeJob(key: string) {
  const { job } = store.createDiscoveryJob({
    tenantId: TENANT,
    idempotencyKey: key,
    requestHash: `${key}-hash`,
    geometry: { type: "Polygon", coordinates: [[[-82.081, 35.019], [-82.077, 35.019], [-82.077, 35.023], [-82.081, 35.023], [-82.081, 35.019]]] },
    state: "SC",
    createdBy: 1,
  });
  return job;
}

/** One enumerated address wired end-to-end: canonical → scan_target → check. */
function makeCheckedAddress(jobId: string, n: number, state: string) {
  const canonicalAddressId = Number(rawDb.prepare(`INSERT INTO canonical_addresses
    (tenant_id,canonical_key,full_address,house_number,street,city,state,postal_code,lat,lng)
    VALUES (?,?,?,?,'Strip St','Inman','SC','29349',35.02,-82.079)`)
    .run(TENANT, `${n}-strip-st-${jobId}`, `${n} Strip St`, String(n)).lastInsertRowid);
  const targetId = Number(rawDb.prepare(`INSERT INTO scan_targets (address,city,state,zip,lat,lng,tenant_id,source)
    VALUES (?,?,?,?,?,?,?,'osm')`).run(`${n} STRIP ST`, "Inman", "SC", "29349", 35.02, -82.079, TENANT).lastInsertRowid);
  store.createQualificationCheck({ tenantId: TENANT, jobId, canonicalAddressId, targetId });
  rawDb.prepare(`UPDATE qualification_checks SET state=?,scan_target_id=?,checked_at=datetime('now')
    WHERE job_id=? AND canonical_address_id=?`).run(state, targetId, jobId, canonicalAddressId);
  return targetId;
}

/** A confirmed fresh lead at the target — created BEFORE the job started. */
function makeExistingLead(targetId: number, address: string, confidence: string) {
  return Number(rawDb.prepare(`INSERT INTO leads
    (tenant_id,address,city,state,zip,lat,lng,lead_tag,fresh_confidence,fresh_confirmed_at,fresh_sources,source_scan_target_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,'fresh_fiber_confirmed',?,datetime('now','-1 hour'),json_array('kinetic'),?,datetime('now','-1 hour'),datetime('now','-1 hour'))`)
    .run(TENANT, address, "Inman", "SC", "29349", 35.02, -82.079, confidence, targetId).lastInsertRowid);
}

describe("Field Map strip counts — authoritative state, not this-run attempts", () => {
  it("fresh_found counts authoritative (kinetic_new_fiber) leads, not only cross_verified", () => {
    const job = makeJob("strip-authoritative");
    const t1 = makeCheckedAddress(job.id, 101, "verified");
    const t2 = makeCheckedAddress(job.id, 102, "verified");
    makeExistingLead(t1, "101 STRIP ST", "kinetic_new_fiber");
    makeExistingLead(t2, "102 STRIP ST", "cross_verified");
    store.reconcileQualificationJob(store.getDiscoveryJob(TENANT, job.id)!);
    const row = rawDb.prepare(`SELECT fresh_found FROM discovery_jobs WHERE id=?`).get(job.id) as any;
    expect(row.fresh_found).toBe(2); // was 1 before the fix — authoritative lead invisible
    // The published event carries the lead's REAL confidence, not a hardcoded one.
    const events = store.readDiscoveryEvents({ tenantId: TENANT, after: 0, jobId: job.id })
      .filter((e) => e.eventType === "lead.published");
    expect(events.length).toBe(2);
    const confidences = events.map((e: any) => e.payload?.lead?.freshConfidence).sort();
    expect(confidences).toEqual(["cross_verified", "kinetic_new_fiber"]);
  });

  it("failed re-checks of known leads report STILL FRESH, not UNRESOLVED (the '8 UNRESOLVED' screen)", () => {
    const job = makeJob("strip-failed-at-leads");
    for (let n = 201; n <= 208; n++) {
      const tid = makeCheckedAddress(job.id, n, "failed");
      makeExistingLead(tid, `${n} STRIP ST`, "kinetic_new_fiber");
    }
    store.reconcileQualificationJob(store.getDiscoveryJob(TENANT, job.id)!);
    const payload = publicJob(store.getDiscoveryJob(TENANT, job.id)!, true) as any;
    expect(payload.checkedCount).toBe(0);      // honest: no conclusive answer this run
    expect(payload.failedCount).toBe(8);       // honest: 8 attempts failed (diagnostics)
    expect(payload.stillFreshCount).toBe(8);   // authoritative state still visible
    expect(payload.unresolvedCount).toBe(0);   // known leads are NOT unknowns
  });

  it("failed checks at addresses with no confirmed lead are the true UNRESOLVED", () => {
    const job = makeJob("strip-failed-unknown");
    const tid = makeCheckedAddress(job.id, 301, "failed"); // known lead → not unresolved
    makeExistingLead(tid, "301 STRIP ST", "cross_verified");
    makeCheckedAddress(job.id, 302, "failed"); // unknown → unresolved
    makeCheckedAddress(job.id, 303, "failed"); // unknown → unresolved
    store.reconcileQualificationJob(store.getDiscoveryJob(TENANT, job.id)!);
    const payload = publicJob(store.getDiscoveryJob(TENANT, job.id)!, true) as any;
    expect(payload.failedCount).toBe(3);
    expect(payload.unresolvedCount).toBe(2);
    expect(payload.stillFreshCount).toBe(1);
  });
});
