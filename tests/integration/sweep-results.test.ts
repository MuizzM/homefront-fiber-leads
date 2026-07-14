import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let rawDb: import("better-sqlite3").Database;
let sweep: typeof import("../../server/sweepService");
const TENANT = 1, JOB = "sweep_fixture";
let TARGET_ID: number;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-sweep-results-"));
  ({ rawDb } = await import("../../server/db"));
  const storage = await import("../../server/storage"); storage.runMigrations();
  sweep = await import("../../server/sweepService");
  rawDb.prepare(`INSERT INTO sweep_jobs (id,tenant_id,query,city,state,max_checks,phase,status,started_at) VALUES (?,?,?,?,?,100,'complete','done',datetime('now','-1 hour'))`)
    .run(JOB,TENANT,"Lexington, NC","Lexington","NC");
  const target = rawDb.prepare(`INSERT INTO scan_targets
    (address,city,state,zip,lat,lng,tenant_id,last_fiber_available,last_fiber_status,last_customer_segment,last_customer_confidence,last_customer_signals,last_scanned_at,first_seen_fiber_at,last_availability_status)
    VALUES (?,?,?,?,?,?,?,1,'new_fiber','new_opportunity','medium','[]',datetime('now'),datetime('now'),'freshly_available')`)
    .run("100 Launch St","Lexington","NC","27292",35.824,-80.253,TENANT);
  const id = TARGET_ID = Number(target.lastInsertRowid);
  rawDb.prepare(`INSERT INTO sweep_job_targets (sweep_job_id,target_id,seq,state) VALUES (?,?,0,'done')`).run(JOB,id);
  rawDb.prepare(`INSERT INTO availability_snapshots
    (tenant_id,scan_target_id,run_id,conclusive,fiber_available,fiber_status,max_download_mbps,billing_status,customer_segment,customer_confidence,customer_signals,transition_status,fresh,api_source,evidence_hash)
    VALUES (?,?,?,1,1,'new_fiber',2000,'N','new_opportunity','medium','[]','freshly_available',1,'fixture','hash')`).run(TENANT,id,"run_fixture");
});

describe("persistent city-sweep results", () => {
  it("returns address-level freshness and customer evidence", () => {
    const result = sweep.getSweepResults(JOB,TENANT,{stage:"fresh",customer:"new_opportunity"})!;
    expect(result.total).toBe(1);
    expect(result.results[0]).toMatchObject({address:"100 Launch St",fiberAvailable:true,customerSegment:"new_opportunity",transitionStatus:"freshly_available",maxDownloadMbps:2000});
  });
  it("exports only independently confirmed fresh non-customer doors", () => {
    expect(sweep.getSweepKnockList(JOB,TENANT)!.count).toBe(0);
    rawDb.prepare(`INSERT INTO availability_corroboration
      (tenant_id,scan_target_id,source,source_record_id,observed_at,availability,technology,max_down_mbps,evidence_hash,import_batch_id)
      VALUES (?,?, 'fcc_bdc_licensed','fcc-fixture',datetime('now'),'available','Fiber to the Premises',1000,'fcc-fixture-hash','fixture')`)
      .run(TENANT, TARGET_ID);
    const list = sweep.getSweepKnockList(JOB,TENANT)!;
    expect(list.count).toBe(1);
    expect(list.rows[0]).toMatchObject({address:"100 Launch St",customer_segment:"new_opportunity",cluster_density:1});
    expect(list.csv).toContain("opportunity_score");
  });
  it("does not leak the sweep across tenants", () => {
    expect(sweep.getSweepResults(JOB,999)).toBeNull();
  });
});
