import { apiRequest } from "@/lib/queryClient";

export interface SweepJob { id:string; kind:"city"|"address"; query:string; city:string|null; state:"NC"|"SC"|null; radiusMeters:number|null; phase:string; status:string; source:string|null; harvested:number; queued:number; checked:number; failed:number; freshFound:number; opportunitiesFound:number; maxChecks:number; currentRunId:string|null; error:string|null; startedAt:string; completedAt:string|null }
export interface SweepResult { id:number; address:string; city:string; state:string; zip:string; lat:number|null; lng:number|null; fiberStatus:string|null; fiberAvailable:boolean|null; firstSeenFiberAt:string|null; customerSegment:"new_opportunity"|"existing_customer"|"unknown"; customerConfidence:"medium"|"low"; customerSignals:string[]; checkedAt:string|null; transitionStatus:string|null; maxDownloadMbps:number|null; billingStatus:string|null; crossVerified:boolean; conclusive:number|null; error:string|null }
const json = async <T>(method:string,url:string,body?:unknown):Promise<T> => (await apiRequest(method,url,body)).json();
export const sweepApi = {
  list: () => json<{sweeps:SweepJob[]}>("GET","/api/sweeps"),
  get: (id:string) => json<SweepJob>("GET",`/api/sweeps/${id}`),
  start: (body:{city:string;state:"NC"|"SC";maxChecks:number}) => json<SweepJob>("POST","/api/sweeps/city",body),
  startAddress: (body:{query:string;radiusMeters:number;maxChecks:number}) => json<SweepJob>("POST","/api/sweeps/address",body),
  results: (id:string,filters?:{stage?:string;customer?:string}) => {
    const q=new URLSearchParams(); if(filters?.stage)q.set("stage",filters.stage); if(filters?.customer)q.set("customer",filters.customer);
    return json<{job:SweepJob;total:number;results:SweepResult[]}>("GET",`/api/sweeps/${id}/results?${q}`);
  },
  knockList: (id:string) => json<{job:SweepJob;count:number;clusters:any[];rows:any[]}>("GET",`/api/sweeps/${id}/knock-list`),
  searchAddress: (query:string,radiusMeters:number) => json<any>("GET",`/api/sweeps/address-search?query=${encodeURIComponent(query)}&radiusMeters=${radiusMeters}`),
  cancel: (id:string) => json<{cancelled:boolean}>("POST",`/api/sweeps/${id}/cancel`),
};
