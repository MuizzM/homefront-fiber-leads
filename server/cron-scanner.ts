import { rawDb } from "./db";
import { startKineticRecheck } from "./kineticScannerWorkers";
import { structuredLog } from "./structuredLog";

export interface CronStatus { lastRunAt:string|null;lastRunResult:string|null;nextRunAt:string|null;isRunning:boolean;totalNewFiberFound:number;totalRunCount:number }
const status:CronStatus={lastRunAt:null,lastRunResult:null,nextRunAt:null,isRunning:false,totalNewFiberFound:0,totalRunCount:0};
let timer:NodeJS.Timeout|null=null;
function nextTwoAm():Date{const now=new Date(),next=new Date(now);next.setHours(2,0,0,0);if(next<=now)next.setDate(next.getDate()+1);return next;}
export function getCronStatus():CronStatus{return{...status};}
export function getEngineStatus():unknown{return{running:status.isRunning,cronRunning:status.isRunning,mode:"kinetic-address-recheck",nextRunAt:status.nextRunAt};}
export async function triggerManualScan():Promise<void>{
  if(status.isRunning)throw new Error("Kinetic nightly recheck is already running");status.isRunning=true;status.lastRunAt=new Date().toISOString();status.totalRunCount++;
  try{const tenants=rawDb.prepare(`SELECT id FROM tenants WHERE status='active'`).all()as Array<{id:number}>;let started=0,skipped=0;for(const tenant of tenants){try{startKineticRecheck({tenantId:tenant.id});started++;}catch{skipped++;}}status.lastRunResult=`Started ${started} Kinetic recheck worker(s); ${skipped} already active`;structuredLog("kinetic.nightly.started",{started,skipped});}
  catch(error){status.lastRunResult=error instanceof Error?error.message:String(error);throw error;}finally{status.isRunning=false;}
}
function schedule():void{const next=nextTwoAm();status.nextRunAt=next.toISOString();if(timer)clearTimeout(timer);timer=setTimeout(async()=>{try{await triggerManualScan();}catch(error){structuredLog("kinetic.nightly.failed",{error:error instanceof Error?error.message:String(error)},"error");}schedule();},Math.max(1000,next.getTime()-Date.now()));timer.unref?.();}
export function startNightlyCron():void{schedule();}
