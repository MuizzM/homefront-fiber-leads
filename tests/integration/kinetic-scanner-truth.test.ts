import { beforeAll,describe,expect,it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let store:typeof import("../../server/kineticScannerStore");
let tenantId:number;

const result=(sequentialId:number,isLive:boolean,technologyType:string,version:number):import("../../server/kineticProviderAdapter").NormalizedKineticAddress=>({
  kineticAddressId:`KA-${sequentialId}`,sequentialId,address:`${sequentialId} Main St`,city:"Lexington",state:"NC",zip:"27292",latitude:35.824,longitude:-80.253,
  exchangeId:"LEX",technologyType,maximumQualification:isLive?2000:100,estimatedCompletionDate:null,isLive,isComingSoon:false,isCopperUpgradeCandidate:!isLive,
  rawResponse:{sequentialId,isLive,technologyType,version},responseHash:`hash-${sequentialId}-${version}`,
});

beforeAll(async()=>{
  process.env.DATA_DIR=mkdtempSync(join(tmpdir(),"hf-kinetic-truth-"));
  const storage=await import("../../server/storage");storage.runMigrations();tenantId=storage.getDefaultTenantId();
  store=await import("../../server/kineticScannerStore");store.ensureKineticScannerSchema();
});

describe("Kinetic scanner persistence truth",()=>{
  it("keeps first-seen fiber as a baseline",()=>{
    expect(store.upsertKineticAddress(tenantId,null,result(901,true,"Fiber",1))).toMatchObject({inserted:true,discoveryState:"BASELINE_FIBER",fresh:false,transitionAction:"BASELINE"});
  });

  it("requires a prior non-fiber baseline and repeat positive check",()=>{
    expect(store.upsertKineticAddress(tenantId,null,result(902,false,"Copper",1))).toMatchObject({discoveryState:"NON_FIBER",fresh:false});
    expect(store.upsertKineticAddress(tenantId,null,result(902,true,"FTTH Fiber",2))).toMatchObject({discoveryState:"CANDIDATE_FRESH",fresh:false,transitionAction:"OPEN_CANDIDATE"});
    expect(store.upsertKineticAddress(tenantId,null,result(902,true,"FTTH Fiber",3))).toMatchObject({discoveryState:"VERIFIED_FRESH",fresh:true,transitionAction:"VERIFY"});
    expect(store.upsertKineticAddress(tenantId,null,result(902,true,"FTTH Fiber",4))).toMatchObject({discoveryState:"VERIFIED_FRESH",fresh:true,transitionAction:"NO_CHANGE"});
  });
});
