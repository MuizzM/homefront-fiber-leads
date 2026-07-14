import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let rawDb: import("better-sqlite3").Database;
let store: typeof import("../../server/addressDiscovery/store");

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-discovery-map-"));
  ({ rawDb } = await import("../../server/db"));
  const storage = await import("../../server/storage");
  storage.runMigrations();
  store = await import("../../server/addressDiscovery/store");
  rawDb.prepare(`INSERT OR IGNORE INTO users (id,name,email,role,active,tenant_id)
    VALUES (1,'Owner','owner@example.com','admin',1,1)`).run();
});

describe("discovery map event stream", () => {
  it("marks rooftop and provider outcomes without sending rep-visible map events", () => {
    const { job } = store.createDiscoveryJob({
      tenantId: 1,
      idempotencyKey: "map-event-contract",
      requestHash: "map-event-contract-hash",
      geometry: { type: "Polygon", coordinates: [[[-80.26, 35.81], [-80.25, 35.81], [-80.25, 35.82], [-80.26, 35.82], [-80.26, 35.81]]] },
      state: "NC",
      createdBy: 1,
    });
    const canonicalAddressId = Number(rawDb.prepare(`INSERT INTO canonical_addresses
      (tenant_id,canonical_key,full_address,house_number,street,city,state,postal_code,lat,lng)
      VALUES (1,'101-map-st-lexington-nc-27292','101 Map St','101','Map St','Lexington','NC','27292',35.815,-80.255)`)
      .run().lastInsertRowid);
    store.createQualificationCheck({ tenantId: 1, jobId: job.id, canonicalAddressId });

    expect(store.publishQualificationMapCandidates(job)).toBe(1);
    expect(store.publishQualificationMapCandidates(job)).toBe(0);
    expect(store.readDiscoveryEvents({ tenantId: 1, after: 0, jobId: job.id })
      .some((event) => event.eventType === "map.candidates")).toBe(false);

    rawDb.prepare(`UPDATE qualification_checks SET state='verified',result='no_service',checked_at=datetime('now')
      WHERE job_id=? AND canonical_address_id=?`).run(job.id, canonicalAddressId);
    expect(store.publishQualificationMapResults(job)).toBe(1);
    expect(store.publishQualificationMapResults(job)).toBe(0);
    expect(store.readDiscoveryEvents({ tenantId: 1, after: 0, jobId: job.id })
      .some((event) => event.eventType === "map.results")).toBe(false);
  });
});
