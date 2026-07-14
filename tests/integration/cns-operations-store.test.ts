import {beforeAll,describe,expect,it} from "vitest";
import {mkdtempSync} from "node:fs";import {tmpdir} from "node:os";import {join} from "node:path";

let rawDb:import("better-sqlite3").Database;let store:typeof import("../../server/cnsOperationsStore");
beforeAll(async()=>{process.env.DATA_DIR=mkdtempSync(join(tmpdir(),"hf-cns-ops-"));({rawDb}=await import("../../server/db"));const storage=await import("../../server/storage");storage.runMigrations();store=await import("../../server/cnsOperationsStore")});

describe("durable CNS operations",()=>{
  it("persists a job, checkpoint progress, immutable observations, and replayable events",()=>{
    const job:any={tenantId:1,id:"cns_test",env:"PA",envLabel:"Pennsylvania",startCns:2,endCns:10,currentCns:2,status:"running",found:[],scanned:0,hits:0,newFiberHits:0,confirmedLeads:0,skipped:0,errors:0,retries:0,startedAt:new Date().toISOString(),ratePerMin:0};
    store.createPersistedCnsJob(job,undefined);
    const targetId=Number(rawDb.prepare(`INSERT INTO scan_targets(address,city,state,zip,tenant_id,df_address_id) VALUES ('2 Fiber St','Test','PA','17000',1,'PA0000002')`).run().lastInsertRowid);
    const result:any={env:"PA",cns:2,dfAddressId:"PA0000002",address:"2 Fiber St",city:"Test",state:"PA",zip:"17000",lat:40,lng:-76,householdSegmentType:"NEW FIBER",isNewFiber:true,techType:"FIBER",speedTier:"1gig",maxDownloadMbps:1000,billingStatus:"N",addressCatalogDate:null,competitorName:null,discoveredAt:new Date().toISOString()};
    job.found=[result];job.scanned=1;job.hits=1;job.newFiberHits=1;job.currentCns=2;job.ratePerMin=45;
    store.persistCnsObservation(job,result);store.persistCnsProgress(job,"job.progress");
    const persisted=store.loadPersistedCnsJobs().find(row=>row.id===job.id)!;
    expect(persisted).toMatchObject({tenantId:1,scanned:1,hits:1,newFiberHits:1,currentCns:2});
    expect(store.loadCnsResults(job.id)).toEqual([expect.objectContaining({dfAddressId:"PA0000002",isNewFiber:true})]);
    expect(store.readCnsEvents(1,job.id,0).map(event=>event.eventType)).toEqual(["job.started","address.primary_match","job.progress"]);
    expect(store.readCnsEvents(2,job.id,0)).toEqual([]);
    expect((rawDb.prepare(`SELECT scan_target_id AS targetId FROM cns_scan_observations WHERE job_id=?`).get(job.id) as any).targetId).toBe(targetId);
  });
  it("seeds safe scanner settings and the default NEW FIBER classification rule",()=>{
    expect(store.scannerSettings(1)).toMatchObject({defaultEnvironment:"MS",jobSizeLimit:100000,staleHeartbeatSeconds:120});
    store.seedClassificationRule(1);store.seedClassificationRule(1);
    expect((rawDb.prepare(`SELECT COUNT(*) AS count FROM cns_classification_rules WHERE tenant_id=1`).get() as any).count).toBe(1);
  });
});
