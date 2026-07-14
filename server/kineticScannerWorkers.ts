import { rawDb } from "./db";
import { getKineticProviderAdapter } from "./kineticProviderAdapter";
import { createKineticJob, event, job, setScannerBounds, upsertKineticAddress } from "./kineticScannerStore";

type WorkerType = "scan" | "recheck";
interface Runtime { stopped:boolean; paused:boolean; controller:AbortController }
const runtimes = new Map<string,Runtime>();

const delay = (ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
const maxRange = ()=>Math.max(1,Math.min(1_000_000,Number(process.env.KINETIC_MAX_SCAN_RANGE)||100_000));
const rps = ()=>Math.max(0.1,Math.min(20,Number(process.env.KINETIC_REQUESTS_PER_SECOND)||1));

async function lookupWithRetry(key:{sequentialId:number}|{kineticAddressId:string},signal:AbortSignal) {
  const retries=Math.max(0,Math.min(5,Number(process.env.KINETIC_RETRY_COUNT)||3));
  let last:unknown;
  for(let attempt=0;attempt<=retries;attempt++){
    try{return await getKineticProviderAdapter().lookup(key,signal);}catch(error){
      last=error;
      if(signal.aborted||attempt===retries) break;
      await delay(Math.min(8_000,500*2**attempt+Math.floor(Math.random()*250)));
    }
  }
  throw last;
}

function heartbeat(id:string,updates:Record<string,unknown>={}):void{
  const keys=Object.keys(updates),set=keys.map(k=>`${k}=?`).join(",");
  rawDb.prepare(`UPDATE kinetic_scan_jobs SET ${set?`${set},`:""} last_heartbeat=datetime('now'),updated_at=datetime('now') WHERE id=?`).run(...keys.map(k=>updates[k]),id);
}

async function waitIfPaused(id:string,runtime:Runtime):Promise<void>{
  while(runtime.paused&&!runtime.stopped){heartbeat(id);await delay(500);}
}

async function runScan(id:string):Promise<void>{
  const runtime:Runtime={stopped:false,paused:false,controller:new AbortController()};runtimes.set(id,runtime);
  const record=job(id);if(!record){runtimes.delete(id);return;}
  rawDb.prepare(`UPDATE kinetic_scan_jobs SET status='running',started_at=COALESCE(started_at,datetime('now')),last_heartbeat=datetime('now') WHERE id=?`).run(id);
  event(record.tenant_id,id,"scan","started",{startSequentialId:record.start_sequential_id,endSequentialId:record.end_sequential_id});
  const start=Math.max(record.start_sequential_id,record.current_sequential_id||record.start_sequential_id);
  try{
    for(let sequentialId=start;sequentialId<=record.end_sequential_id;sequentialId++){
      await waitIfPaused(id,runtime);if(runtime.stopped)break;
      const tick=Date.now();let found=0,live=0,errors=0;
      try{
        const result=await lookupWithRetry({sequentialId},runtime.controller.signal);
        if(result){const stored=upsertKineticAddress(record.tenant_id,id,result);found=stored.inserted?1:0;live=result.isLive===true?1:0;}
      }catch(error){
        if(runtime.stopped)break;errors=1;
        heartbeat(id,{last_error:error instanceof Error?error.message:String(error)});
      }
      rawDb.prepare(`UPDATE kinetic_scan_jobs SET current_sequential_id=?,checked=checked+1,found=found+?,live=live+?,errors=errors+?,last_heartbeat=datetime('now'),updated_at=datetime('now') WHERE id=?`)
        .run(sequentialId,found,live,errors,id);
      setScannerBounds(record.tenant_id,sequentialId,record.end_sequential_id);
      const remaining=Math.ceil(1000/rps())-(Date.now()-tick);if(remaining>0)await delay(remaining);
    }
    const status=runtime.stopped?"stopped":"completed";
    rawDb.prepare(`UPDATE kinetic_scan_jobs SET status=?,completed_at=CASE WHEN ?='completed' THEN datetime('now') ELSE completed_at END,last_heartbeat=datetime('now'),updated_at=datetime('now') WHERE id=?`).run(status,status,id);
    event(record.tenant_id,id,"scan",status);
  }catch(error){
    rawDb.prepare(`UPDATE kinetic_scan_jobs SET status='failed',last_error=?,completed_at=datetime('now'),updated_at=datetime('now') WHERE id=?`).run(error instanceof Error?error.message:String(error),id);
    event(record.tenant_id,id,"scan","failed",{message:error instanceof Error?error.message:String(error)});
  }finally{runtimes.delete(id);}
}

async function runRecheck(id:string):Promise<void>{
  const runtime:Runtime={stopped:false,paused:false,controller:new AbortController()};runtimes.set(id,runtime);
  const record=job(id);if(!record){runtimes.delete(id);return;}
  rawDb.prepare(`UPDATE kinetic_scan_jobs SET status='running',started_at=COALESCE(started_at,datetime('now')),last_heartbeat=datetime('now') WHERE id=?`).run(id);
  event(record.tenant_id,id,"recheck","started");
  const rows=rawDb.prepare(`SELECT id,kinetic_address_id AS kineticAddressId FROM kinetic_addresses WHERE tenant_id=? AND kinetic_address_id IS NOT NULL ORDER BY last_checked_at ASC`).all(record.tenant_id) as any[];
  try{
    for(const row of rows){
      if(runtime.stopped)break;const tick=Date.now();let live=0,errors=0;
      try{const result=await lookupWithRetry({kineticAddressId:row.kineticAddressId},runtime.controller.signal);if(result){upsertKineticAddress(record.tenant_id,id,result);live=result.isLive===true?1:0;}}
      catch(error){if(runtime.stopped)break;errors=1;heartbeat(id,{last_error:error instanceof Error?error.message:String(error)});}
      rawDb.prepare(`UPDATE kinetic_scan_jobs SET checked=checked+1,live=live+?,errors=errors+?,last_heartbeat=datetime('now'),updated_at=datetime('now') WHERE id=?`).run(live,errors,id);
      const remaining=Math.ceil(1000/rps())-(Date.now()-tick);if(remaining>0)await delay(remaining);
    }
    const status=runtime.stopped?"stopped":"completed";
    rawDb.prepare(`UPDATE kinetic_scan_jobs SET status=?,completed_at=CASE WHEN ?='completed' THEN datetime('now') ELSE completed_at END,last_heartbeat=datetime('now'),updated_at=datetime('now') WHERE id=?`).run(status,status,id);
    event(record.tenant_id,id,"recheck",status);
  }catch(error){rawDb.prepare(`UPDATE kinetic_scan_jobs SET status='failed',last_error=?,completed_at=datetime('now') WHERE id=?`).run(error instanceof Error?error.message:String(error),id);}
  finally{runtimes.delete(id);}
}

function active(tenantId:number,type:WorkerType):any{return rawDb.prepare(`SELECT id FROM kinetic_scan_jobs WHERE tenant_id=? AND worker_type=? AND status IN ('queued','running','paused') LIMIT 1`).get(tenantId,type);}

export function startKineticScan(input:{tenantId:number;startSequentialId:number;endSequentialId:number;createdBy?:number|null}):string{
  if(input.endSequentialId<input.startSequentialId)throw new Error("End Sequential ID must be greater than or equal to Start Sequential ID");
  if(input.endSequentialId-input.startSequentialId+1>maxRange())throw new Error(`Sequential range exceeds ${maxRange().toLocaleString()} IDs`);
  if(active(input.tenantId,"scan"))throw new Error("A scan worker is already active");
  const id=createKineticJob({tenantId:input.tenantId,workerType:"scan",start:input.startSequentialId,end:input.endSequentialId,createdBy:input.createdBy});
  setScannerBounds(input.tenantId,input.startSequentialId,input.endSequentialId);void runScan(id);return id;
}
export function startKineticRecheck(input:{tenantId:number;createdBy?:number|null}):string{
  if(active(input.tenantId,"recheck"))throw new Error("A recheck worker is already active");
  const id=createKineticJob({tenantId:input.tenantId,workerType:"recheck",createdBy:input.createdBy});void runRecheck(id);return id;
}
export function pauseKineticScan(tenantId:number):boolean{const current=active(tenantId,"scan");if(!current)return false;const rt=runtimes.get(current.id);if(rt)rt.paused=true;rawDb.prepare(`UPDATE kinetic_scan_jobs SET status='paused',updated_at=datetime('now') WHERE id=?`).run(current.id);event(tenantId,current.id,"scan","paused");return true;}
export function resumeKineticScan(tenantId:number):boolean{const current=rawDb.prepare(`SELECT id FROM kinetic_scan_jobs WHERE tenant_id=? AND worker_type='scan' AND status='paused' ORDER BY updated_at DESC LIMIT 1`).get(tenantId) as any;if(!current)return false;const rt=runtimes.get(current.id);if(rt){rt.paused=false;rawDb.prepare(`UPDATE kinetic_scan_jobs SET status='running' WHERE id=?`).run(current.id);}else void runScan(current.id);event(tenantId,current.id,"scan","resumed");return true;}
export function stopKineticWorker(tenantId:number,type:WorkerType):boolean{const current=active(tenantId,type);if(!current)return false;const rt=runtimes.get(current.id);if(rt){rt.stopped=true;rt.controller.abort();}rawDb.prepare(`UPDATE kinetic_scan_jobs SET status='stopped',updated_at=datetime('now') WHERE id=?`).run(current.id);event(tenantId,current.id,type,"stop_requested");return true;}

export function resumeKineticWorkersAfterRestart():void{
  const interrupted=rawDb.prepare(`SELECT id,worker_type AS workerType,status FROM kinetic_scan_jobs WHERE status IN ('queued','running','paused')`).all() as any[];
  for(const row of interrupted){if(row.status==="paused")continue;setTimeout(()=>void(row.workerType==="scan"?runScan(row.id):runRecheck(row.id)),25);}
}
