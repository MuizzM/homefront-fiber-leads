import { rawDb } from "./db";
import { startKineticRecheck } from "./kineticScannerWorkers";
import { runDailyMarketRefresh } from "./dailyMarketRefresh";
import { structuredLog } from "./structuredLog";
import { DEFAULT_WORKWEEK, localWallToUtcMs, localYmdParts } from "@shared/workweek";

export interface CronStatus { lastRunAt:string|null;lastRunResult:string|null;nextRunAt:string|null;isRunning:boolean;totalNewFiberFound:number;totalRunCount:number }
const status:CronStatus={lastRunAt:null,lastRunResult:null,nextRunAt:null,isRunning:false,totalNewFiberFound:0,totalRunCount:0};
let timer:NodeJS.Timeout|null=null;
// 2 AM in the OPERATING timezone, not the container's. `setHours(2)` means 02:00
// UTC in production — 10 PM Eastern, the middle of evening knocking. This job
// starts a kinetic recheck worker per tenant plus an OSM discovery diff, so it
// was putting the heaviest background load of the day on top of peak field use.
// The schedule is global (every tenant), so it runs on the default workweek zone
// as a house clock rather than on any single org's.
function nextTwoAm():Date{
  const tz=DEFAULT_WORKWEEK.timezone,now=Date.now();
  const {y,mo,d}=localYmdParts(now,tz);
  let at=localWallToUtcMs(y,mo,d,2,0,tz);
  if(at<=now)at=localWallToUtcMs(y,mo,d+1,2,0,tz);   // Date.UTC normalizes the day overflow
  return new Date(at);
}
export function getCronStatus():CronStatus{return{...status};}
export function getEngineStatus():unknown{return{running:status.isRunning,cronRunning:status.isRunning,mode:"kinetic-address-recheck",nextRunAt:status.nextRunAt};}
export async function triggerManualScan():Promise<void>{
  if(status.isRunning)throw new Error("Kinetic nightly recheck is already running");status.isRunning=true;status.lastRunAt=new Date().toISOString();status.totalRunCount++;
  try{const tenants=rawDb.prepare(`SELECT id FROM tenants WHERE status='active'`).all()as Array<{id:number}>;let started=0,skipped=0;for(const tenant of tenants){try{startKineticRecheck({tenantId:tenant.id});started++;}catch{skipped++;}
  // Daily OSM discovery diff — find + check NEW addresses per confirmed city.
  // Fire-and-forget alongside the recheck; the diff never blocks the recheck.
  void runDailyMarketRefresh(tenant.id).catch((e)=>structuredLog("daily_refresh.failed",{tenantId:tenant.id,error:e instanceof Error?e.message:String(e)},"error"));}status.lastRunResult=`Started ${started} Kinetic recheck worker(s) + daily OSM diff; ${skipped} already active`;structuredLog("kinetic.nightly.started",{started,skipped});}
  catch(error){status.lastRunResult=error instanceof Error?error.message:String(error);throw error;}finally{status.isRunning=false;}
}
function schedule():void{const next=nextTwoAm();status.nextRunAt=next.toISOString();if(timer)clearTimeout(timer);timer=setTimeout(async()=>{try{await triggerManualScan();}catch(error){structuredLog("kinetic.nightly.failed",{error:error instanceof Error?error.message:String(error)},"error");}schedule();},Math.max(1000,next.getTime()-Date.now()));timer.unref?.();}
export function startNightlyCron():void{schedule();}
