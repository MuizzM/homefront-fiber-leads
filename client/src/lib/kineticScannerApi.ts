import { apiRequest,getStoredSessionId } from "@/lib/queryClient";
const get=async<T>(url:string):Promise<T>=>(await apiRequest("GET",url)).json();
const post=async<T>(url:string,body:unknown={}):Promise<T>=>(await apiRequest("POST",url,body)).json();
export interface KineticAddress{id:number;kineticAddressId:string|null;sequentialId:number|null;address:string|null;city:string|null;state:string|null;zip:string|null;latitude:number|null;longitude:number|null;exchangeId:string|null;technologyType:string|null;maximumQualification:number|null;estimatedCompletionDate:string|null;isLive:number|null;isComingSoon:number|null;isCopperUpgradeCandidate:number|null;leadId:number|null;contactEnrichmentStatus:string;lastChecked:string;lastStatusChange:string|null;canonicalState?:"FIBER_LIVE"|"NON_FIBER"|null;discoveryState?:"BASELINE_FIBER"|"NON_FIBER"|"CANDIDATE_FRESH"|"VERIFIED_FRESH"|"REGRESSED"|"SOURCE_ERROR"|null;confirmationCount?:number;verifiedAt?:string|null}
export const kineticScannerApi={
  ping:()=>get<any>("/api/kinetic-scanner/ping"),state:()=>get<any>("/api/kinetic-scanner/state"),stats:()=>get<any>("/api/kinetic-scanner/stats"),
  addresses:(params:URLSearchParams)=>get<{items:KineticAddress[];page:number;limit:number;total:number;pages:number}>(`/api/kinetic-scanner/addresses?${params}`),
  detail:(id:number)=>get<any>(`/api/kinetic-scanner/addresses/${id}`),contacts:(id:number)=>get<any>(`/api/kinetic-scanner/addresses/${id}/contacts`),
  map:()=>get<any>("/api/kinetic-scanner/addresses/map"),hotspots:()=>get<any>("/api/kinetic-scanner/hotspots"),changes:()=>get<any>("/api/kinetic-scanner/changes"),
  startScan:(startSequentialId:number,endSequentialId:number)=>post<any>("/api/kinetic-scanner/start-scan",{startSequentialId,endSequentialId}),
  controlScan:(action:"pause"|"resume"|"stop")=>post<any>(`/api/kinetic-scanner/${action}-scan`),startRecheck:()=>post<any>("/api/kinetic-scanner/start-recheck"),stopRecheck:()=>post<any>("/api/kinetic-scanner/stop-recheck"),
  recheck:(id:number)=>post<any>(`/api/kinetic-scanner/addresses/${id}/recheck`),refreshContacts:(id:number)=>post<any>(`/api/kinetic-scanner/addresses/${id}/contacts/refresh`),convert:(id:number)=>post<any>(`/api/kinetic-scanner/addresses/${id}/convert-lead`),
  backfill:()=>post<any>("/api/kinetic-scanner/backfill-copper-upgrade"),
  async downloadExport(){const response=await fetch("/api/kinetic-scanner/export",{headers:{"x-session-id":getStoredSessionId()??""}});if(!response.ok)throw new Error("Export failed");const blob=await response.blob(),url=URL.createObjectURL(blob),anchor=document.createElement("a");anchor.href=url;anchor.download=`kinetic-addresses-${new Date().toISOString().slice(0,10)}.csv`;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);},
};
