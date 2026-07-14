import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Loader2, MapPin } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { cnsOpsApi } from "@/lib/cnsOpsApi";
declare const mapboxgl: any;

export function CnsOperationsMap({ onOpen }: { onOpen:(targetId:number)=>void }) {
  const host = useRef<HTMLDivElement>(null); const mapRef=useRef<any>(null);
  const [token,setToken]=useState<string|null>(null); const [tokenFailed,setTokenFailed]=useState(false);
  const {data,isLoading,error}=useQuery({queryKey:["/api/cns/ops/map"],queryFn:cnsOpsApi.map,staleTime:15_000});
  useEffect(()=>{ apiRequest("GET","/api/config/map").then(r=>r.json()).then(d=>{if(d?.token){mapboxgl.accessToken=d.token;setToken(d.token)}else setTokenFailed(true)}).catch(()=>setTokenFailed(true)); },[]);
  useEffect(()=>{
    if(!token||!host.current||!data||mapRef.current)return;
    const first=data.features?.[0]?.geometry?.coordinates; const center=first??[-80.4,35.5];
    const map=new mapboxgl.Map({container:host.current,style:"mapbox://styles/mapbox/dark-v11",center,zoom:first?9:5,attributionControl:false}); mapRef.current=map;
    map.addControl(new mapboxgl.NavigationControl({showCompass:false}),"top-right");
    map.on("load",()=>{
      map.addSource("cns-addresses",{type:"geojson",data,cluster:true,clusterRadius:52,clusterMaxZoom:13});
      map.addLayer({id:"cns-clusters",type:"circle",source:"cns-addresses",filter:["has","point_count"],paint:{"circle-color":["step",["get","point_count"],"#2563eb",25,"#7c3aed",100,"#f59e0b"],"circle-radius":["step",["get","point_count"],18,25,24,100,31],"circle-stroke-width":2,"circle-stroke-color":"#0f172a"}});
      map.addLayer({id:"cns-cluster-count",type:"symbol",source:"cns-addresses",filter:["has","point_count"],layout:{"text-field":["get","point_count_abbreviated"],"text-size":12},paint:{"text-color":"#fff"}});
      map.addLayer({id:"cns-points",type:"circle",source:"cns-addresses",filter:["!",["has","point_count"]],paint:{"circle-radius":["case",["==",["get","changeDetected"],1],8,6],"circle-color":["case",["==",["get","evidenceState"],"historical_change_detected"],"#22c55e",["==",["get","classification"],"primary_fiber_match"],"#3b82f6","#8b5cf6"],"circle-stroke-width":2,"circle-stroke-color":"#e2e8f0","circle-opacity":.9}});
      map.on("click","cns-clusters",(event:any)=>{const feature=map.queryRenderedFeatures(event.point,{layers:["cns-clusters"]})[0];const source=map.getSource("cns-addresses");source.getClusterExpansionZoom(feature.properties.cluster_id,(err:any,zoom:number)=>{if(!err)map.easeTo({center:feature.geometry.coordinates,zoom})})});
      map.on("click","cns-points",(event:any)=>{const feature=event.features?.[0];const id=Number(feature?.properties?.scanTargetId);if(Number.isInteger(id))onOpen(id)});
      for(const layer of ["cns-clusters","cns-points"]){map.on("mouseenter",layer,()=>map.getCanvas().style.cursor="pointer");map.on("mouseleave",layer,()=>map.getCanvas().style.cursor="")}
    });
    return()=>{map.remove();mapRef.current=null};
  },[token,data,onOpen]);
  if(isLoading)return <div className="grid h-[520px] place-items-center rounded-2xl border border-border bg-card"><Loader2 className="h-5 w-5 animate-spin text-primary"/></div>;
  if(error||tokenFailed)return <div className="grid h-[520px] place-items-center rounded-2xl border border-border bg-card text-sm text-muted-foreground"><div className="text-center"><AlertTriangle className="mx-auto mb-2 h-5 w-5 text-amber-500"/>Map unavailable. Verify the Mapbox public token.</div></div>;
  if(!data?.features?.length)return <div className="grid h-[520px] place-items-center rounded-2xl border border-dashed border-border bg-card text-sm text-muted-foreground"><div className="text-center"><MapPin className="mx-auto mb-2 h-6 w-6 opacity-50"/>No geocoded CNS addresses yet.</div></div>;
  return <div className="relative overflow-hidden rounded-2xl border border-border"><div ref={host} className="h-[520px] w-full"/><div className="pointer-events-none absolute bottom-3 left-3 flex gap-2 rounded-xl border border-white/10 bg-slate-950/85 px-3 py-2 text-[10px] text-slate-200"><span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-blue-500"/>Primary</span><span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-violet-500"/>Observed</span><span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-emerald-500"/>Changed</span></div></div>;
}
