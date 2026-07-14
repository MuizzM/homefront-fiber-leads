import { apiRequest, getStoredSessionId } from "@/lib/queryClient";

const get = async <T>(url: string): Promise<T> => (await apiRequest("GET",url)).json();
const post = async <T>(url: string, body?: unknown): Promise<T> => (await apiRequest("POST",url,body)).json();

export interface CnsOpsAddress {
  id: number; scanTargetId: number; env: string; cns: number; formattedCns: string;
  address: string | null; city: string | null; state: string | null; zip: string | null;
  lat: number | null; lng: number | null; technology: string | null; maxQualification: number | null;
  classification: string; evidenceState: string; changeDetected: number; lastChecked: string;
  lastChanged: string | null; householdSegment: string | null; live: number | null; leadId: number | null;
}

export const cnsOpsApi = {
  dashboard: () => get<any>("/api/cns/ops/dashboard"),
  addresses: (params: URLSearchParams) => get<{items:CnsOpsAddress[];page:number;pageSize:number;total:number;pages:number}>(`/api/cns/ops/addresses?${params}`),
  map: () => get<any>("/api/cns/ops/map"),
  hotspots: (minimum=3) => get<{hotspots:any[]}>(`/api/cns/ops/hotspots?minimum=${minimum}`),
  changes: () => get<{items:any[]}>("/api/cns/ops/changes?limit=250"),
  evidence: (targetId:number) => get<any>(`/api/cns/ops/evidence/${targetId}`),
  leads: () => get<{items:any[]}>("/api/cns/ops/leads"),
  settings: () => get<any>("/api/cns/ops/settings"),
  saveSettings: (settings:Record<string,unknown>) => apiRequest("PATCH","/api/cns/ops/settings",settings).then(r=>r.json()),
  addRule: (rule:Record<string,unknown>) => post<any>("/api/cns/ops/rules",rule),
  control: (id:string,action:"pause"|"resume"|"stop") => post<any>(`/api/cns/jobs/${id}/${action}`,{}),
  archive: (id:string) => apiRequest("DELETE",`/api/cns/jobs/${id}`).then(r=>r.json()),
  start: (input:{env:string;startCns:number;endCns:number}) => post<any>("/api/cns/jobs",input),
  async downloadExport() {
    const response = await fetch("/api/cns/ops/export",{headers:{"x-session-id":getStoredSessionId() ?? ""}});
    if (!response.ok) throw new Error("Export failed");
    const blob = await response.blob();
    const disposition = response.headers.get("content-disposition") ?? "";
    const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? `cns-addresses-${Date.now()}.csv`;
    const url = URL.createObjectURL(blob); const anchor = document.createElement("a");
    anchor.href=url; anchor.download=filename; anchor.click(); setTimeout(()=>URL.revokeObjectURL(url),1000);
  },
};

