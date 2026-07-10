import { useEffect, useRef, useState, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { scanApi, type OppCluster } from "@/lib/scanApi";
import type { TeamMember } from "@shared/schema";
import { ArrowLeft, Loader2, Users, Sparkles, ChevronRight, X, MapPinned, ShieldQuestion } from "lucide-react";

// ── Opportunity Map — verified new-fiber as a deployable landscape ────────────
// The clusters (server-computed, scored, with convex-hull boundaries) render as
// coloured regions on the map. The ranked list on the side reads top-down; tap a
// cluster to fly to it and open the deploy panel, which drafts a real territory
// from its boundary and assigns it to a team — discovery straight into the field.

const CLUSTER_SRC = "opp-clusters";
// Ramp calibrated to the REAL score distribution (most clusters land 45–80), so
// the colour actually differentiates them instead of everything reading amber.
// Shared by the map fill/line AND the list chips + legend (one colour language).
const RAMP: Array<[number, string]> = [
  [25, "#64748b"], [42, "#0d9488"], [55, "#eab308"], [68, "#f97316"], [80, "#ef4444"],
];
const SCORE_COLOR = ["interpolate", ["linear"], ["get", "score"], ...RAMP.flat()] as any;
function scoreTint(score: number): string {
  let c = RAMP[0][1];
  for (const [thr, col] of RAMP) if (score >= thr) c = col;
  return c;
}

export function OpportunityMap({ focusCity, onBack }: { focusCity?: { city: string; state: string } | null; onBack: () => void }) {
  const mapContainer = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  const [ready, setReady] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [tokenFailed, setTokenFailed] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false); // phone cluster bottom-sheet

  // Scope to the market the operator picked (focusCity) so "open a market →
  // opportunity" shows THAT city, not the whole state.
  const { data, isLoading } = useQuery({
    queryKey: ["/api/scan/clusters", focusCity?.city ?? "all", focusCity?.state ?? ""],
    queryFn: () => scanApi.clusters({ minPoints: 5, city: focusCity?.city, state: focusCity?.state }),
    refetchInterval: 10000,
  });
  const clusters = useMemo(() => data?.clusters ?? [], [data]);
  const selected = clusters.find(c => c.id === selectedId) ?? null;

  // Token
  useEffect(() => {
    let cancelled = false;
    const init = () => {
      apiRequest("GET", "/api/config/map").then(r => r.json()).then((d: { token: string }) => {
        if (cancelled) return;
        if (d?.token) { (window as any).mapboxgl.accessToken = d.token; setToken(d.token); }
        else setTokenFailed(true);
      }).catch(() => { if (!cancelled) setTokenFailed(true); });
    };
    (window as any).__onMapboxReady ? (window as any).__onMapboxReady(init) : init();
    return () => { cancelled = true; };
  }, []);

  // Map init
  useEffect(() => {
    if (mapRef.current || !mapContainer.current || !token) return;
    const map = new (window as any).mapboxgl.Map({
      container: mapContainer.current,
      style: "mapbox://styles/mapbox/dark-v11",
      center: [-80.4, 35.4], zoom: 8,
    });
    mapRef.current = map;
    map.on("load", () => {
      map.addSource(CLUSTER_SRC, { type: "geojson", data: emptyFC() });
      map.addLayer({ id: "opp-fill", type: "fill", source: CLUSTER_SRC, paint: { "fill-color": SCORE_COLOR, "fill-opacity": ["case", ["boolean", ["feature-state", "selected"], false], 0.45, 0.2] } });
      map.addLayer({ id: "opp-line", type: "line", source: CLUSTER_SRC, paint: { "line-color": SCORE_COLOR, "line-width": ["case", ["boolean", ["feature-state", "selected"], false], 3, 1.5], "line-opacity": 0.9 } });
      map.addLayer({ id: "opp-label", type: "symbol", source: CLUSTER_SRC, layout: { "text-field": ["concat", ["get", "unworked"], " doors"], "text-size": 11, "text-font": ["DIN Pro Medium", "Arial Unicode MS Regular"], "text-allow-overlap": false }, paint: { "text-color": "#fff", "text-halo-color": "rgba(0,0,0,0.8)", "text-halo-width": 1.2 } });
      map.on("click", "opp-fill", (e: any) => { const id = e.features?.[0]?.properties?.id; if (id) setSelectedId(id); });
      map.on("mouseenter", "opp-fill", () => { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", "opp-fill", () => { map.getCanvas().style.cursor = ""; });
      setReady(true);
    });
    const ro = new ResizeObserver(() => map.resize());
    ro.observe(mapContainer.current);
    return () => { ro.disconnect(); map.remove(); mapRef.current = null; };
  }, [token]);

  // Feed clusters into the source
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const src = map.getSource(CLUSTER_SRC);
    if (!src) return;
    src.setData({
      type: "FeatureCollection",
      features: clusters.filter(c => c.hull.length >= 3).map(c => ({
        type: "Feature", id: c.id,
        geometry: { type: "Polygon", coordinates: [[...c.hull, c.hull[0]]] },
        properties: { id: c.id, score: c.score, unworked: c.unworked },
      })),
    });
    // Fit to focus city's clusters (or all) once.
    if (clusters.length && !map.__fitted) {
      const b = new (window as any).mapboxgl.LngLatBounds();
      for (const c of clusters) { b.extend([c.bbox.minLng, c.bbox.minLat]); b.extend([c.bbox.maxLng, c.bbox.maxLat]); }
      try { map.fitBounds(b, { padding: 60, maxZoom: 13, duration: 0 }); map.__fitted = true; } catch {}
    }
  }, [clusters, ready]);

  // Selected feature-state
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    for (const c of clusters) { try { map.setFeatureState({ source: CLUSTER_SRC, id: c.id }, { selected: c.id === selectedId }); } catch {} }
    if (selected) { try { map.flyTo({ center: [selected.centroid.lng, selected.centroid.lat], zoom: Math.max(map.getZoom(), 13), duration: 600 }); } catch {} }
  }, [selectedId, clusters, ready]);

  return (
    <div className="relative h-full w-full flex">
      {/* Map */}
      <div className="relative flex-1 min-w-0">
        <div ref={mapContainer} className="absolute inset-0" />
        {(tokenFailed) && <div className="absolute inset-0 flex items-center justify-center text-[13px] text-muted-foreground bg-card/80">Map token unavailable — set MAPBOX_PUBLIC_TOKEN.</div>}
        {isLoading && <div className="absolute top-3 left-3 flex items-center gap-2 text-[12px] text-white bg-black/60 rounded-lg px-3 py-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Reading opportunity…</div>}
        {!isLoading && clusters.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center p-6">
            <div className="max-w-xs text-center rounded-2xl bg-black/80 border border-white/10 p-6 text-white">
              <Sparkles className="w-6 h-6 mx-auto mb-2 text-orange-400" />
              <p className="text-sm font-semibold">No opportunity clusters yet</p>
              <p className="text-xs text-white/60 mt-1.5">Run a scan on a market to verify new fiber — concentrations appear here as deployable areas.</p>
            </div>
          </div>
        )}
        <button onClick={onBack} className="absolute top-3 left-3 h-9 pl-2.5 pr-3 rounded-lg bg-black/70 backdrop-blur border border-white/10 text-white text-[13px] font-medium flex items-center gap-1.5 hover:bg-black/80 z-10" data-testid="opp-back">
          <ArrowLeft className="w-4 h-4" /> Markets
        </button>

        {/* Legend — decodes the opportunity-score colour ramp. */}
        {clusters.length > 0 && (
          <div className="absolute bottom-3 left-3 rounded-lg bg-black/70 backdrop-blur border border-white/10 px-2.5 py-2 text-white z-10 md:bottom-3" style={{ bottom: "calc(env(safe-area-inset-bottom) + 0.75rem)" }}>
            <div className="text-[10px] uppercase tracking-wider text-white/60 font-semibold mb-1">Opportunity score</div>
            <div className="flex items-center gap-1.5">
              <div className="h-2 w-24 rounded-full" style={{ background: `linear-gradient(to right, ${RAMP.map(r => r[1]).join(",")})` }} />
            </div>
            <div className="flex justify-between text-[9px] text-white/50 mt-0.5 w-24"><span>low</span><span>high</span></div>
          </div>
        )}
      </div>

      {/* Ranked cluster list — a fixed side rail on desktop, a draggable bottom
          sheet on phone so the ranked opportunity is never hidden in the field. */}
      <aside className="hidden md:flex w-[300px] flex-shrink-0 border-l border-border bg-card flex-col">
        <div className="px-3 py-2.5 border-b border-border">
          <div className="text-[13px] font-semibold text-foreground">Opportunity clusters</div>
          <div className="text-[11px] text-muted-foreground">{clusters.length} found · strongest first</div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {clusters.map(c => <ClusterRow key={c.id} c={c} active={c.id === selectedId} onClick={() => setSelectedId(c.id)} />)}
        </div>
      </aside>

      {/* Phone: a bottom sheet the operator can expand — collapsed shows the top
          cluster, expanded is the full ranked list. Only when nothing is selected
          (the deploy panel takes over otherwise). */}
      {clusters.length > 0 && !selected && (
        <div className={`md:hidden absolute inset-x-0 bottom-0 z-20 bg-card border-t border-border rounded-t-2xl shadow-2xl transition-[max-height] duration-200 ${sheetOpen ? "max-h-[70%]" : "max-h-[124px]"} flex flex-col`}
          style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
          <button onClick={() => setSheetOpen(o => !o)} data-testid="opp-sheet-toggle"
            className="flex items-center gap-2 px-4 py-3 border-b border-border/60 min-h-[44px]" aria-expanded={sheetOpen}>
            <div className="w-9 h-1 rounded-full bg-white/25 absolute left-1/2 -translate-x-1/2 top-1.5" aria-hidden="true" />
            <span className="text-[13px] font-semibold text-foreground">Opportunity clusters</span>
            <span className="text-[11px] text-muted-foreground">{clusters.length} · strongest first</span>
            <ChevronRight className={`w-4 h-4 text-muted-foreground ml-auto transition-transform ${sheetOpen ? "-rotate-90" : "rotate-90"}`} />
          </button>
          <div className="flex-1 overflow-y-auto overscroll-contain">
            {(sheetOpen ? clusters : clusters.slice(0, 1)).map(c => <ClusterRow key={c.id} c={c} active={c.id === selectedId} onClick={() => setSelectedId(c.id)} />)}
          </div>
        </div>
      )}

      {/* Deploy panel */}
      {selected && <DeployPanel cluster={selected} onClose={() => setSelectedId(null)} />}
    </div>
  );
}

function ClusterRow({ c, active, onClick }: { c: OppCluster; active: boolean; onClick: () => void }) {
  const tint = scoreTint(c.score);
  return (
    <button onClick={onClick} data-testid={`opp-cluster-${c.id}`}
      className={`w-full text-left px-3 py-2.5 border-b border-border/60 flex items-start gap-2.5 transition-colors ${active ? "bg-primary/5" : "hover:bg-secondary/50"}`}>
      <div className="w-8 h-8 rounded-lg flex items-center justify-center text-[12px] font-bold flex-shrink-0" style={{ background: tint + "22", color: tint }}>{c.score}</div>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-semibold text-foreground">{c.unworked} unworked doors</div>
        <div className="text-[11px] text-muted-foreground truncate">{c.reasons[0] ?? `${c.size} verified`}</div>
        <div className="text-[10px] text-muted-foreground/70 mt-0.5">{c.confidence} confidence · {c.size} verified</div>
      </div>
      <ChevronRight className="w-4 h-4 text-muted-foreground/50 mt-1.5 flex-shrink-0" />
    </button>
  );
}

function DeployPanel({ cluster, onClose }: { cluster: OppCluster; onClose: () => void }) {
  const { user } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const canDeploy = user?.role === "admin" || user?.role === "manager" || user?.role === "team_lead";
  const { data: team = [] } = useQuery<TeamMember[]>({ queryKey: ["/api/team"], enabled: canDeploy });
  const reps = team.filter((m: any) => m.active);
  const [repId, setRepId] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const deploy = async () => {
    if (repId == null) return;
    setBusy(true);
    try {
      // Pass the cluster's MEMBER lead ids so the rep gets exactly the verified
      // new-fiber doors in the briefing — not every home the hull happens to
      // enclose, and not fewer because the hull clipped an edge.
      const out = await scanApi.deploy(cluster.hull, repId, { name: name.trim() || undefined, leadIds: cluster.points });
      toast({ title: "Territory deployed", description: `${out.assigned} doors assigned to ${reps.find((r: any) => r.id === repId)?.name}.` });
      qc.invalidateQueries({ queryKey: ["/api/leads/map"] });
      qc.invalidateQueries({ queryKey: ["/api/territories"] });
      onClose();
    } catch (e: any) {
      toast({ title: "Could not deploy", description: String(e?.message ?? "").replace(/^\d+:\s*/, "") || "Try again", variant: "destructive" });
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-40 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40" />
      <aside role="dialog" aria-label="Deploy cluster" onClick={e => e.stopPropagation()}
        className="relative w-full max-w-sm h-full bg-card border-l border-border shadow-2xl flex flex-col animate-in slide-in-from-right duration-200" data-testid="opp-deploy-panel">
        <header className="flex items-center gap-2 px-4 py-3 border-b border-border">
          <MapPinned className="w-4 h-4 text-primary" />
          <div className="text-[15px] font-semibold text-foreground flex-1">Deploy this cluster</div>
          <button onClick={onClose} aria-label="Close" className="w-9 h-9 rounded-lg hover:bg-secondary flex items-center justify-center text-muted-foreground"><X className="w-4 h-4" /></button>
        </header>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Briefing */}
          <div className="rounded-xl border border-primary/25 bg-primary/5 p-3 space-y-2">
            <div className="text-[11px] uppercase tracking-wide text-primary font-semibold">The briefing</div>
            <div className="grid grid-cols-2 gap-2">
              <Metric v={cluster.unworked} l="unworked doors" />
              <Metric v={cluster.size} l="verified new-fiber" />
              <Metric v={`${Math.round(cluster.competitorShare * 100)}%`} l="competitor-served" />
              <Metric v={cluster.avgScore} l="avg lead score" />
            </div>
            <ul className="space-y-1 pt-1">{cluster.reasons.map((r, i) => <li key={i} className="text-[12px] text-foreground/80 flex gap-1.5"><ChevronRight className="w-3 h-3 mt-0.5 text-primary flex-shrink-0" />{r}</li>)}</ul>
          </div>

          {canDeploy ? (
            <>
              <div>
                <label className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold block mb-1.5">Assign to</label>
                <select value={repId ?? ""} onChange={e => setRepId(e.target.value ? Number(e.target.value) : null)} data-testid="opp-deploy-rep"
                  className="w-full h-10 rounded-lg bg-secondary/60 border border-border px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40">
                  <option value="">Choose a rep…</option>
                  {reps.map((r: any) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </div>
              <div>
                <label className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold block mb-1.5">Area name (optional)</label>
                <input value={name} onChange={e => setName(e.target.value)} placeholder={repId ? `${reps.find((r: any) => r.id === repId)?.name}'s area` : "Auto-named"} maxLength={60}
                  className="w-full h-10 rounded-lg bg-secondary/60 border border-border px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40" />
              </div>
              <button onClick={deploy} disabled={repId == null || busy} data-testid="opp-deploy-confirm"
                className="w-full h-11 rounded-xl bg-primary hover:bg-primary/90 disabled:opacity-50 text-primary-foreground text-[14px] font-semibold flex items-center justify-center gap-2">
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Users className="w-4 h-4" />}
                Deploy {cluster.unworked} doors to the field
              </button>
              <p className="text-[11px] text-muted-foreground text-center">Creates a territory from this cluster's boundary and assigns every enclosed lead, with this briefing attached.</p>
            </>
          ) : (
            <div className="rounded-xl border border-border bg-secondary/40 p-4 text-center text-[13px] text-muted-foreground flex flex-col items-center gap-2">
              <ShieldQuestion className="w-5 h-5" /> Deploying a territory is a team-lead action.
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

function Metric({ v, l }: { v: React.ReactNode; l: string }) {
  return <div className="rounded-lg bg-card/60 p-2"><div className="text-[16px] font-bold text-foreground tabular-nums">{v}</div><div className="text-[10px] uppercase tracking-wide text-muted-foreground">{l}</div></div>;
}
function emptyFC() { return { type: "FeatureCollection", features: [] }; }
