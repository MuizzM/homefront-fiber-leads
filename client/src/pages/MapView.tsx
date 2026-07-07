import { useEffect, useRef, useState, useCallback } from "react";
// mapbox-gl loaded via CDN in index.html — do not bundle
declare const mapboxgl: any;
import {
  Play, Square, RefreshCw, AlertCircle, Pencil, X,
  DoorOpen, UserCheck, Zap, CalendarClock, PhoneOff, Map as MapIcon, ShieldCheck, Bell,
  ChevronRight, Home, Wifi, Signal, Users, Target, Filter, SlidersHorizontal
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import type { Lead, TeamMember, InsertKnock, Territory } from "@shared/schema";

// Lean map-pin type from /api/leads/map — only fields needed for pins
interface MapPin {
  id: number;
  address: string;
  city: string;
  state: string;
  zip: string;
  lat: number;
  lng: number;
  leadStatus: string;
  fiberStatus: string;
  isNewFiber: boolean;
  assignedRepId: number | null;
  maxDownloadMbps: number | null;
  competitorName: string | null;
  leadScore: number;
  contactName: string | null;
  contactPhone: string | null;
}

// Mapbox token is fetched from /api/config/map at runtime — not in bundle

const ROCKWELL_CENTER: [number, number] = [-80.41, 35.545];

// ── Sales Rabbit pin colors by lead status ────────────────────────────────────
const PIN_COLORS: Record<string, { bg: string; border: string; label: string }> = {
  prospect:       { bg: "#22c55e", border: "#86efac", label: "Prospect" },       // green  — new fiber unworked
  contacted:      { bg: "#3b82f6", border: "#93c5fd", label: "Contacted" },      // blue
  interested:     { bg: "#8b5cf6", border: "#c4b5fd", label: "Interested" },     // purple
  follow_up:      { bg: "#f59e0b", border: "#fcd34d", label: "Follow-up" },      // amber
  sold:           { bg: "#10b981", border: "#6ee7b7", label: "SOLD" },           // emerald
  not_interested: { bg: "#ef4444", border: "#fca5a5", label: "Not Interested" }, // red
};

const OUTCOME_OPTIONS = [
  { val: "not_home",      label: "Not Home",      color: "#94a3b8" },
  { val: "not_interested",label: "Not Interested", color: "#ef4444" },
  { val: "interested",    label: "Interested",     color: "#8b5cf6" },
  { val: "callback",      label: "Callback",       color: "#f59e0b" },
  { val: "sold",          label: "SOLD 🎉",        color: "#10b981" },
];

// ── Bbox type ─────────────────────────────────────────────────────────────────
interface BBox { minLng: number; minLat: number; maxLng: number; maxLat: number }
function inBBox(lat: number, lng: number, b: BBox) {
  return lat >= b.minLat && lat <= b.maxLat && lng >= b.minLng && lng <= b.maxLng;
}

// Escape untrusted strings before injecting into popup innerHTML. Lead notes,
// owner names, addresses, and team-member names all originate from user input
// or external scan/enrichment data — without this, a value like
// `<img src=x onerror=…>` executes on popup open (stored XSS → session theft).
function escapeHtml(v: unknown): string {
  if (v == null) return "";
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── Inline popup HTML builder ─────────────────────────────────────────────────
function buildPopupHTML(lead: MapPin, team: TeamMember[], canAssign = true): string {
  const pin = PIN_COLORS[lead.leadStatus] ?? PIN_COLORS.prospect;
  const assignedRep = team.find(m => m.id === lead.assignedRepId);
  const repOptions = team.filter(m => m.active)
    .map(m => `<option value="${m.id}" ${m.id === lead.assignedRepId ? "selected" : ""}>${escapeHtml(m.name)}</option>`)
    .join("");

  // Tap the address → open turn-by-turn directions (Maps app on mobile).
  const dest = (lead.lat && lead.lng)
    ? `${lead.lat},${lead.lng}`
    : encodeURIComponent(`${lead.address}, ${lead.city}, ${lead.state} ${lead.zip}`);
  const dirUrl = `https://www.google.com/maps/dir/?api=1&destination=${dest}`;

  return `
    <div style="font-family:system-ui,sans-serif;font-size:13px;color:#e2e8f0;min-width:260px;max-width:300px;">
      <!-- Header -->
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
        <div style="width:14px;height:14px;border-radius:50%;background:${pin.bg};border:2px solid ${pin.border};flex-shrink:0;box-shadow:0 0 8px ${pin.bg}80;"></div>
        <div>
          <a href="${dirUrl}" target="_blank" rel="noopener" style="font-weight:700;font-size:13px;line-height:1.2;color:#5eead4;text-decoration:none;">${escapeHtml(lead.address)} ↗</a>
          <div style="color:#94a3b8;font-size:11px;">${escapeHtml(lead.city)}, ${escapeHtml(lead.state)} ${escapeHtml(lead.zip)} · <span style="color:#5eead4;">tap address for directions</span></div>
        </div>
      </div>

      <!-- Status + fiber -->
      <div style="display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap;">
        <span style="background:${pin.bg}22;color:${pin.bg};border:1px solid ${pin.bg}44;border-radius:4px;padding:2px 7px;font-size:11px;font-weight:600;">${pin.label}</span>
        ${lead.fiberStatus === "new_fiber" ? `<span style="background:#22c55e22;color:#22c55e;border:1px solid #22c55e44;border-radius:4px;padding:2px 7px;font-size:11px;">NEW FIBER</span>` : ""}
        ${lead.maxDownloadMbps ? `<span style="background:#0ea5e922;color:#38bdf8;border:1px solid #0ea5e944;border-radius:4px;padding:2px 7px;font-size:11px;">${lead.maxDownloadMbps >= 1000 ? lead.maxDownloadMbps/1000+"G" : lead.maxDownloadMbps+"M"}</span>` : ""}
      </div>

      <!-- Contact -->
      ${lead.contactName ? `<div style="color:#94a3b8;font-size:11px;margin-bottom:6px;">👤 ${escapeHtml(lead.contactName)}${lead.contactPhone ? ` · ${escapeHtml(lead.contactPhone)}` : ""}</div>` : ""}

      <!-- Assign rep (managers/team leads only) -->
      ${canAssign ? `<div style="margin-bottom:8px;">
        <div style="color:#94a3b8;font-size:10px;text-transform:uppercase;letter-spacing:.05em;margin-bottom:3px;">Assigned Rep</div>
        <select id="assign-rep-${lead.id}" style="width:100%;background:#1e2430;color:#e2e8f0;border:1px solid #334155;border-radius:5px;padding:4px 6px;font-size:12px;">
          <option value="">— Unassigned —</option>
          ${repOptions}
        </select>
      </div>` : ""}

      <!-- Quick knock buttons -->
      <div style="margin-bottom:8px;">
        <div style="color:#94a3b8;font-size:10px;text-transform:uppercase;letter-spacing:.05em;margin-bottom:5px;">Log Door Knock</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;">
          ${OUTCOME_OPTIONS.map(o => `
            <button
              onclick="window.__knockLead(${lead.id}, '${o.val}')"
              style="background:${o.color}18;color:${o.color};border:1px solid ${o.color}40;border-radius:5px;padding:5px 4px;font-size:11px;font-weight:600;cursor:pointer;text-align:center;"
            >${o.label}</button>
          `).join("")}
        </div>
      </div>

      <!-- Notes -->
      ${lead.notes ? `<div style="color:#94a3b8;font-size:11px;font-style:italic;border-top:1px solid #1e2430;padding-top:6px;">"${escapeHtml(lead.notes)}"</div>` : ""}

      <!-- Save assign button (managers/team leads only) -->
      ${canAssign ? `<button
        onclick="window.__assignRep(${lead.id})"
        style="width:100%;margin-top:8px;background:#f97316;color:white;border:none;border-radius:5px;padding:6px;font-size:12px;font-weight:600;cursor:pointer;"
      >Save Assignment</button>` : ""}
    </div>
  `;
}

// ── Scan types ────────────────────────────────────────────────────────────────
interface ScanRow {
  address: string; city: string; state: string; zip: string;
  fiberStatus: string; isNewFiber: boolean; billingStatus: string | null;
  householdSegmentType: string | null; techType: string | null;
  chipSetType: string | null; placement: string | null;
  maxDownloadMbps: number | null;
  competitorName: string | null; competitorSpeedMbps: number | null;
  lat: number | null; lng: number | null;
}
interface ScanJobStatus {
  id: string; status: "running" | "done" | "error";
  total: number; done: number; results: ScanRow[];
  summary: { new_fiber: number; scanned: number; remaining: number };
}

const POLL_MS = 400; // 400ms — scan dots appear almost instantly

export default function MapView() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const scanMarkersRef = useRef<any[]>([]);
  const leadMarkersRef = useRef<Map<number, any>>(new Map());
  const lastRenderedCount = useRef(0);
  const popupsRef = useRef<Map<number, any>>(new Map());
  const pollTickRef = useRef(0);      // counts scan polls, to throttle live lead refreshes
  const didAutoFitRef = useRef(false); // fit the map to leads once on first load

  const [mapReady, setMapReady] = useState(false);
  const [mapInitKey, setMapInitKey] = useState(0); // bumped to retry map init if container has no height yet
  const [scanning, setScanning] = useState(false);
  const [scanSource, setScanSource] = useState<string>("mapbox"); // "mapbox" | "overpass" | "gis"
  const [progress, setProgress] = useState(0);
  const [total, setTotal] = useState(0);
  const [done, setDone] = useState(0);
  const [newFound, setNewFound] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Map style toggle
  const [mapStyleMode, setMapStyleMode] = useState<"dark" | "satellite">("satellite");
  // The style the map was actually created with. Prevents a redundant setStyle()
  // on first load (which would reload the whole style and blank the map).
  const appliedStyleRef = useRef<"dark" | "satellite">("satellite");

  // Draw mode
  const [drawMode, setDrawMode] = useState(false);
  const [drawnBBox, setDrawnBBox] = useState<BBox | null>(null);
  const drawingRef = useRef(false);
  const drawStartRef = useRef<any>(null);

  // Filter
  const [filterStatus, setFilterStatus] = useState<string>("all");

  // Sidebar
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [selectedLeadId, setSelectedLeadId] = useState<number | null>(null);
  const [sidebarSearch, setSidebarSearch] = useState("");

  // Territory draw
  const [territoryDrawMode, setTerritoryDrawMode] = useState(false);
  const [territoryPoints, setTerritoryPoints] = useState<[number, number][]>([]);
  const [territoryName, setTerritoryName] = useState("");
  const [territoryRepId, setTerritoryRepId] = useState("");
  const [showTerritories, setShowTerritories] = useState(true);

  // Lasso (bulk select) mode
  const [lassoMode, setLassoMode] = useState(false);
  const [lassoPoints, setLassoPoints] = useState<[number, number][]>([]);
  const [lassoSelected, setLassoSelected] = useState<MapPin[]>([]);
  const [lassoRepId, setLassoRepId] = useState("");
  const lassoLayerRef = useRef<boolean>(false);

  // Sidebar filters
  const [filterRep, setFilterRep] = useState<string>("all"); // "all" | "unassigned" | repId
  const [filterUnassigned, setFilterUnassigned] = useState(false);
  const territoryLayersRef = useRef<string[]>([]);

  const { toast } = useToast();
  const qc = useQueryClient();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const canManage = user?.role === "admin" || user?.role === "manager";
  // Admin, manager, and team lead can carve out areas and assign them to reps.
  const canAssign = user?.role === "admin" || user?.role === "manager" || user?.role === "team_lead";

  // Territory requests (admin/manager)
  const { data: territoryRequests = [] } = useQuery<{
    id: number; repId: number; repName: string; currentTerritoryName: string | null;
    notes: string | null; status: string; createdAt: string;
  }[]>({
    queryKey: ["/api/territory-requests"],
    refetchInterval: 30000,
    enabled: canManage,
  });
  const pendingRequests = territoryRequests.filter(r => r.status === "pending");
  const [showTerritoryRequests, setShowTerritoryRequests] = useState(false);

  const fulfillRequestMutation = useMutation({
    mutationFn: async ({ id, action }: { id: number; action: "fulfilled" | "dismissed" }) => {
      const res = await apiRequest("PATCH", `/api/territory-requests/${id}`, { status: action });
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/territory-requests"] });
      toast({ title: "Territory request updated" });
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const saveTerritoryMutation = useMutation({
    mutationFn: async (data: { name: string; repId: number; polygon: string; color: string }) => {
      const res = await apiRequest("POST", "/api/territories", data);
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/territories"] });
      setTerritoryDrawMode(false);
      setTerritoryPoints([]);
      setTerritoryName("");
      setTerritoryRepId("");
      toast({ title: "Territory saved!" });
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const deleteTerritoryMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("DELETE", `/api/territories/${id}`);
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/territories"] }),
  });

  // ── Bulk assign mutation (lasso) ────────────────────────────────────────
  const bulkAssignMutation = useMutation({
    mutationFn: async ({ leadIds, repId }: { leadIds: number[]; repId: number | null }) => {
      const res = await apiRequest("POST", "/api/leads/bulk-assign", { leadIds, repId });
      return res.json();
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["/api/leads/map"] });
      qc.invalidateQueries({ queryKey: ["/api/leads"] });
      const repName = data.repId ? (team.find((m: TeamMember) => m.id === data.repId)?.name ?? "rep") : "unassigned";
      toast({ title: `✓ ${data.updated} leads assigned to ${repName}` });
      setLassoSelected([]);
      setLassoPoints([]);
      setLassoMode(false);
      setLassoRepId("");
      // Remove lasso layers
      const map = mapRef.current;
      if (map) {
        if (map.getLayer("lasso-fill")) map.removeLayer("lasso-fill");
        if (map.getLayer("lasso-outline")) map.removeLayer("lasso-outline");
        if (map.getSource("lasso-polygon")) map.removeSource("lasso-polygon");
      }
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  // Fetch ALL map pins from dedicated lean endpoint — only runs after auth is ready
  const { data: mapPinData, refetch: refetchLeads } = useQuery<{ pins: MapPin[]; total: number }>(
    {
      queryKey: ["/api/leads/map"],
      queryFn: async () => {
        const res = await apiRequest("GET", "/api/leads/map");
        return res.json();
      },
      enabled: !!user,
      staleTime: 30_000,
      retry: 2,
    }
  );
  const leads: MapPin[] = mapPinData?.pins ?? [];
  const { data: team = [] } = useQuery<TeamMember[]>({ queryKey: ["/api/team"], enabled: !!user });
  const { data: territories = [] } = useQuery<Territory[]>({ queryKey: ["/api/territories"], enabled: !!user });
  const { data: territoryProgress = [] } = useQuery<{ id: number; knocked: number; total: number; pct: number; sold: number }[]>({
    queryKey: ["/api/territories/progress"],
    queryFn: async () => (await apiRequest("GET", "/api/territories/progress")).json(),
    enabled: !!user,
    refetchInterval: 30000,
  });
  // Expose globally so popup onclick handlers can access current data.
  // NOTE: these effects must stay after `team` is declared — their dependency
  // arrays are read during render, so referencing `team` earlier throws a TDZ
  // error under native ESM (dev), even though esbuild masks it in prod builds.
  useEffect(() => { (window as any).__allLeads = leads; }, [leads]);
  useEffect(() => { (window as any).__teamMembers = team; }, [team]);

  // ── Fetch Mapbox token from server (not in bundle) ──────────────────────────
  const [mapboxToken, setMapboxToken] = useState<string>("");
  const [mapTokenFailed, setMapTokenFailed] = useState(false);
  const [mapboxReady, setMapboxReady] = useState(() => !!(window as any).__mapboxReady || typeof (window as any).mapboxgl !== "undefined");

  // Wait for mapboxgl CDN — uses onload callback from index.html, no polling
  useEffect(() => {
    let cancelled = false;
    const init = () => {
      if (cancelled) return;
      setMapboxReady(true);
      apiRequest("GET", "/api/config/map")
        .then(r => r.json())
        .then((d: { token: string }) => {
          if (cancelled) return;
          if (d?.token) {
            (window as any).mapboxgl.accessToken = d.token;
            setMapboxToken(d.token);
          } else { setMapTokenFailed(true); }
        })
        .catch(() => { if (!cancelled) setMapTokenFailed(true); });
    };
    (window as any).__onMapboxReady(init);
    return () => { cancelled = true; };
  }, []);

  // ── Expose global functions for popup button callbacks ────────────────────
  useEffect(() => {
    (window as any).__knockLead = async (leadId: number, outcome: string) => {
      const activeRep = (document.getElementById(`assign-rep-${leadId}`) as HTMLSelectElement)?.value;
      if (!activeRep) {
        toast({ title: "Select a rep first before logging a knock", variant: "destructive" });
        return;
      }
      try {
        const wasHome = outcome !== "not_home";
        await apiRequest("POST", `/api/leads/${leadId}/knock`, {
          repId: Number(activeRep),
          wasHome,
          outcome,
          knockedAt: new Date().toISOString(),
        });
        toast({ title: outcome === "sold" ? "🎉 Sale logged!" : `Knock logged: ${outcome.replace("_", " ")}` });
        qc.invalidateQueries({ queryKey: ["/api/leads"] }); qc.invalidateQueries({ queryKey: ["/api/leads/map"] });
        qc.invalidateQueries({ queryKey: ["/api/leaderboard"] });
        // Close popup
        popupsRef.current.get(leadId)?.remove();
      } catch (e: any) {
        toast({ title: "Failed to log knock", variant: "destructive" });
      }
    };

    (window as any).__assignRep = async (leadId: number) => {
      const sel = document.getElementById(`assign-rep-${leadId}`) as HTMLSelectElement;
      const repId = sel?.value ? Number(sel.value) : null;
      try {
        await apiRequest("POST", `/api/leads/${leadId}/assign`, { repId });
        toast({ title: repId ? "Lead assigned" : "Lead unassigned" });
        qc.invalidateQueries({ queryKey: ["/api/leads"] }); qc.invalidateQueries({ queryKey: ["/api/leads/map"] });
        popupsRef.current.get(leadId)?.remove();
      } catch {
        toast({ title: "Failed to assign", variant: "destructive" });
      }
    };

    return () => {
      delete (window as any).__knockLead;
      delete (window as any).__assignRep;
    };
  }, [toast, qc]);

  // ── Init Mapbox ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (mapRef.current || !mapContainer.current || !mapboxToken) return;

    // Initialize immediately — Mapbox tolerates a container that hasn't been
    // laid out yet (0px), and the ResizeObserver + resize() calls below redraw
    // once real dimensions arrive. (Previously this bailed until height>=50px and
    // retried on a timer, which could loop forever if the container measured 0
    // at mount — leaving the map stuck on "Loading map…".)
    const el = mapContainer.current;

    const map = new (window as any).mapboxgl.Map({
      container: el,
      style: "mapbox://styles/mapbox/satellite-streets-v12",
      center: ROCKWELL_CENTER,
      zoom: 13,
    });
    mapRef.current = map; // claim immediately so a re-render can't spawn a second map

    // Force resize once container is definitely painted
    setTimeout(() => map.resize(), 100);
    setTimeout(() => map.resize(), 400);

    map.addControl(new (window as any).mapboxgl.NavigationControl(), "top-right");

    const setupMapLayers = () => {
      // Territory draw click handler (for territory polygon mode, separate from scan bbox)
      map.on("click", (e) => {
        if ((window as any).__territoryDrawActive) {
          const pt: [number, number] = [e.lngLat.lng, e.lngLat.lat];
          (window as any).__addTerritoryPoint(pt);
        }
      });
      // Draw bbox layers
      map.addSource("draw-bbox", {
        type: "geojson",
        data: { type: "Feature", geometry: { type: "Polygon", coordinates: [[]] }, properties: {} }
      });
      map.addLayer({ id: "draw-bbox-fill", type: "fill", source: "draw-bbox",
        paint: { "fill-color": "#f97316", "fill-opacity": 0.1 } });
      map.addLayer({ id: "draw-bbox-outline", type: "line", source: "draw-bbox",
        paint: { "line-color": "#f97316", "line-width": 2, "line-dasharray": [3, 2] } });

      // ── Lead cluster source (GeoJSON) — shows count bubbles when zoomed out ──
      map.addSource("leads-cluster", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
        cluster: true,
        clusterMaxZoom: 13,   // collapse clusters below zoom 13
        clusterRadius: 50,    // px radius to cluster within
      });

      // Cluster outer glow ring (behind main circle)
      map.addLayer({
        id: "lead-clusters-glow",
        type: "circle",
        source: "leads-cluster",
        filter: ["has", "point_count"],
        maxzoom: 13.5,
        paint: {
          "circle-color": ["step",["get","point_count"],"#22c55e",10,"#f59e0b",30,"#ef4444"],
          "circle-radius": ["step",["get","point_count"],26,10,33,30,42],
          "circle-opacity": 0.25,
          "circle-stroke-width": 0,
        },
      });

      // Cluster circles — visible only when zoomed out (zoom < 13)
      map.addLayer({
        id: "lead-clusters",
        type: "circle",
        source: "leads-cluster",
        filter: ["has", "point_count"],
        maxzoom: 13.5,
        paint: {
          "circle-color": [
            "step", ["get", "point_count"],
            "#22c55e", 10,
            "#f59e0b", 30,
            "#ef4444"
          ],
          "circle-radius": ["step", ["get", "point_count"], 18, 10, 24, 30, 32],
          "circle-opacity": 0.92,
          "circle-stroke-width": 2.5,
          "circle-stroke-color": "rgba(255,255,255,0.9)",
        },
      });

      // Cluster count labels
      map.addLayer({
        id: "lead-cluster-count",
        type: "symbol",
        source: "leads-cluster",
        filter: ["has", "point_count"],
        maxzoom: 13.5,
        layout: {
          "text-field": "{point_count_abbreviated}",
          "text-font": ["DIN Offc Pro Medium", "Arial Unicode MS Bold"],
          "text-size": ["step",["get","point_count"],13,10,14,30,16],
          "text-allow-overlap": true,
        },
        paint: { "text-color": "#ffffff", "text-halo-color": "rgba(0,0,0,0.3)", "text-halo-width": 0.5 },
      });

      // Click cluster → zoom in
      map.on("click", "lead-clusters", (e: any) => {
        const features = map.queryRenderedFeatures(e.point, { layers: ["lead-clusters"] });
        const clusterId = features[0]?.properties?.cluster_id;
        if (!clusterId) return;
        (map.getSource("leads-cluster") as any).getClusterExpansionZoom(clusterId, (err: any, zoom: number) => {
          if (err) return;
          map.easeTo({ center: features[0].geometry.coordinates, zoom: zoom + 1 });
        });
      });

      map.on("mouseenter", "lead-clusters", () => { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", "lead-clusters", () => { map.getCanvas().style.cursor = ""; });
      map.on("mouseenter", "lead-clusters-glow", () => { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", "lead-clusters-glow", () => { map.getCanvas().style.cursor = ""; });

      // ── Individual lead pins (GPU circle layer) — shown when zoomed in past clusterMaxZoom ──
      map.addLayer({
        id: "lead-unclustered",
        type: "circle",
        source: "leads-cluster",
        filter: ["!", ["has", "point_count"]],
        minzoom: 12,
        paint: {
          "circle-color": [
            "match", ["get", "status"],
            "prospect",       "#22c55e",
            "contacted",      "#3b82f6",
            "interested",     "#8b5cf6",
            "follow_up",      "#f59e0b",
            "sold",           "#10b981",
            "not_interested", "#ef4444",
            "#22c55e"
          ],
          "circle-radius": 8,
          "circle-stroke-width": 2,
          "circle-stroke-color": "rgba(255,255,255,0.9)",
          "circle-opacity": 0.95,
        },
      });

      // Glow ring for unclustered pins
      map.addLayer({
        id: "lead-unclustered-glow",
        type: "circle",
        source: "leads-cluster",
        filter: ["!", ["has", "point_count"]],
        minzoom: 12,
        paint: {
          "circle-color": [
            "match", ["get", "status"],
            "prospect",       "#22c55e",
            "contacted",      "#3b82f6",
            "interested",     "#8b5cf6",
            "follow_up",      "#f59e0b",
            "sold",           "#10b981",
            "not_interested", "#ef4444",
            "#22c55e"
          ],
          "circle-radius": 14,
          "circle-opacity": 0.18,
          "circle-stroke-width": 0,
        },
      });

      // Click unclustered pin → show popup
      map.on("click", "lead-unclustered", (e: any) => {
        const props = e.features?.[0]?.properties;
        const coords = e.features?.[0]?.geometry?.coordinates?.slice() as [number, number];
        if (!props || !coords) return;
        const lead = (window as any).__allLeads?.find((l: any) => l.id === props.id);
        if (!lead) return;
        const tm = (window as any).__teamMembers ?? [];
        while (Math.abs(e.lngLat.lng - coords[0]) > 180) { coords[0] += e.lngLat.lng > coords[0] ? 360 : -360; }
        new (window as any).mapboxgl.Popup({ offset: 14, className: "sr-popup", closeButton: true })
          .setLngLat(coords)
          .setHTML(buildPopupHTML(lead, tm, canAssign))
          .addTo(map);
      });
      map.on("mouseenter", "lead-unclustered", () => { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", "lead-unclustered", () => { map.getCanvas().style.cursor = ""; });

      mapRef.current = map;
      setMapReady(true);
    };

    // Run layer setup as soon as the STYLE is parsed — not on the full "load"
    // event (which waits for a complete tile render and can stall in some
    // environments, leaving the map stuck on "Loading map…"). Adding sources/
    // layers only requires the style, so this is both correct and more robust.
    if (map.isStyleLoaded()) setupMapLayers();
    else map.once("style.load", setupMapLayers);

    // ResizeObserver — whenever the container changes size, tell Mapbox to redraw
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => { map.resize(); });
      ro.observe(el);
    }

    return () => { ro?.disconnect(); map.remove(); mapRef.current = null; };
  }, [mapboxToken, mapInitKey]); // re-run when token arrives or when we retry after container paints

  // ── Render lead pins on map (Sales Rabbit style) ───────────────────────────
  const renderLeadPin = useCallback((lead: MapPin, allTeam: TeamMember[]) => {
    const map = mapRef.current;
    if (!map || !lead.lat || !lead.lng) return;

    // Remove old marker for this lead if it exists
    leadMarkersRef.current.get(lead.id)?.remove();
    popupsRef.current.get(lead.id)?.remove();

    const pin = PIN_COLORS[lead.leadStatus] ?? PIN_COLORS.prospect;
    const assignedRep = allTeam.find(m => m.id === lead.assignedRepId);

    const el = document.createElement("div");
    el.style.cssText = `
      width: 32px; height: 40px; cursor: pointer; position: relative;
      transition: transform 0.15s;
    `;
    // House-shaped pin (SalesRabbit style) — roof + walls + door
    const iconGlyph: Record<string, string> = {
      prospect: "",           // clean house — unworked
      contacted: "✉",           // envelope
      interested: "★",           // star
      follow_up: "↺",           // callback arrow
      sold: "✓",                // checkmark
      not_interested: "✕",       // X
    };
    const glyph = iconGlyph[lead.leadStatus] ?? "";
    el.innerHTML = `
      <svg viewBox="0 0 32 40" fill="none" xmlns="http://www.w3.org/2000/svg" width="32" height="40">
        <!-- Drop shadow filter -->
        <defs><filter id="shadow-${lead.id}" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="rgba(0,0,0,0.55)"/>
        </filter></defs>
        <!-- House body -->
        <g filter="url(#shadow-${lead.id})">
          <!-- Roof triangle -->
          <polygon points="16,2 30,16 2,16" fill="${pin.bg}" stroke="${pin.border}" stroke-width="1.5" stroke-linejoin="round"/>
          <!-- Walls -->
          <rect x="5" y="15" width="22" height="16" rx="1" fill="${pin.bg}" stroke="${pin.border}" stroke-width="1.5"/>
          <!-- Door -->
          <rect x="12" y="23" width="8" height="8" rx="1" fill="rgba(0,0,0,0.25)"/>
          <!-- Chimney -->
          <rect x="22" y="6" width="4" height="6" fill="${pin.bg}" stroke="${pin.border}" stroke-width="1"/>
        </g>
        <!-- Status glyph -->
        ${glyph ? `<text x="16" y="22" text-anchor="middle" font-size="10" fill="white" font-weight="bold" font-family="system-ui">${glyph}</text>` : ""}
        <!-- Spike bottom -->
        <polygon points="13,31 16,40 19,31" fill="${pin.bg}" stroke="${pin.border}" stroke-width="1"/>
      </svg>
      ${assignedRep ? `
        <div style="
          position:absolute;top:-8px;right:-6px;
          background:${pin.bg};color:white;
          border-radius:50%;width:16px;height:16px;
          font-size:8px;font-weight:700;
          display:flex;align-items:center;justify-content:center;
          border:1.5px solid white;
          box-shadow:0 1px 3px rgba(0,0,0,0.4);
        ">${assignedRep.name.charAt(0)}</div>
      ` : ""}
    `;

    el.addEventListener("mouseenter", () => { el.style.transform = "scale(1.15)"; });
    el.addEventListener("mouseleave", () => { el.style.transform = "scale(1)"; });

    const popup = new (window as any).mapboxgl.Popup({
      offset: [0, -42], closeButton: true,
      className: "sr-popup",
      maxWidth: "320px",
    }).setHTML(buildPopupHTML(lead, allTeam, canAssign));

    popupsRef.current.set(lead.id, popup);

    const marker = new (window as any).mapboxgl.Marker({ element: el, anchor: "bottom" })
      .setLngLat([lead.lng, lead.lat])
      .setPopup(popup)
      .addTo(map);

    leadMarkersRef.current.set(lead.id, marker);
  }, []);

  // ── Territory polygon — point-in-polygon check ────────────────────────────
  function pointInPolygon(lat: number, lng: number, polygon: [number, number][]): boolean {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const xi = polygon[i][0], yi = polygon[i][1];
      const xj = polygon[j][0], yj = polygon[j][1];
      const intersect = ((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  // ── Update cluster GeoJSON source when leads change ─────────────────────────
  // Cluster setData consolidated into the lead render effect below

  // ── Update cluster GeoJSON when leads/filter/territory changes ───────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const src = map.getSource("leads-cluster") as any;
    if (!src) return;

    let leadsToShow = leads;
    const isRep = user?.role === "rep";
    if (!isAdmin && !isRep && user?.teamMemberId) {
      const myTerritories = territories.filter(t => t.repId === user.teamMemberId);
      if (myTerritories.length > 0) {
        leadsToShow = leads.filter(lead => {
          if (!lead.lat || !lead.lng) return false;
          return myTerritories.some(t => {
            try {
              const poly = JSON.parse(t.polygon) as [number, number][];
              return pointInPolygon(lead.lat!, lead.lng!, poly);
            } catch { return false; }
          });
        });
      }
    }

    const visibleLeads = filterStatus === "all"
      ? leadsToShow
      : leadsToShow.filter(l => l.leadStatus === filterStatus);

    // GPU-rendered circle layer — no DOM markers, handles 100k+ points
    src.setData({
      type: "FeatureCollection",
      features: visibleLeads
        .filter(l => l.lat && l.lng)
        .map(l => ({
          type: "Feature",
          geometry: { type: "Point", coordinates: [l.lng, l.lat] },
          properties: { id: l.id, status: l.leadStatus, address: l.address },
        })),
    });
  }, [leads, team, mapReady, filterStatus, territories, isAdmin, user]);

  // ── Auto-fit to leads once on first load (Sales Rabbit density view) ──────────
  // Centers/zooms the map so pins are visible the moment you open it. Runs once,
  // so it never yanks the view around while you're scanning or panning.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || didAutoFitRef.current) return;
    const pts = leads.filter(l => l.lat && l.lng);
    if (pts.length === 0) return;
    try {
      const b = new (window as any).mapboxgl.LngLatBounds();
      pts.forEach(l => b.extend([l.lng!, l.lat!]));
      map.fitBounds(b, { padding: 60, maxZoom: 15, duration: 0 });
      didAutoFitRef.current = true;
    } catch {}
  }, [leads, mapReady]);

  // ── Render territory polygons on map ─────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    // Remove old territory layers/sources
    territoryLayersRef.current.forEach(id => {
      try { if (map.getLayer(id)) map.removeLayer(id); } catch {}
      try { if (map.getLayer(id + "-outline")) map.removeLayer(id + "-outline"); } catch {}
      try { if (map.getSource(id)) map.removeSource(id); } catch {}
    });
    territoryLayersRef.current = [];

    if (!showTerritories) return;

    territories.forEach(t => {
      try {
        const coords = JSON.parse(t.polygon) as [number, number][];
        if (coords.length < 3) return;
        const closed = [...coords, coords[0]];
        const srcId = `territory-${t.id}`;
        if (!map.getSource(srcId)) {
          map.addSource(srcId, {
            type: "geojson",
            data: { type: "Feature", geometry: { type: "Polygon", coordinates: [closed] }, properties: {} }
          });
        }
        if (!map.getLayer(srcId)) {
          map.addLayer({ id: srcId, type: "fill", source: srcId,
            paint: { "fill-color": t.color, "fill-opacity": 0.12 } });
        }
        if (!map.getLayer(srcId + "-outline")) {
          map.addLayer({ id: srcId + "-outline", type: "line", source: srcId,
            paint: { "line-color": t.color, "line-width": 2, "line-opacity": 0.8 } });
        }
        territoryLayersRef.current.push(srcId);
      } catch {}
    });
  }, [territories, mapReady, showTerritories]);

  // ── Map style toggle ───────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    // Skip the redundant reload on initial load — the map is already showing this
    // style. Only re-style when the user actually toggles satellite ↔ street.
    if (appliedStyleRef.current === mapStyleMode) return;
    appliedStyleRef.current = mapStyleMode;
    const STYLE = mapStyleMode === "satellite"
      ? "mapbox://styles/mapbox/satellite-streets-v12"
      : "mapbox://styles/mapbox/dark-v11";
    // setStyle wipes all layers — re-add cluster source + layers after style loads
    map.once("style.load", () => {
      // Re-add cluster source + layers after style swap
      if (!map.getSource("leads-cluster")) {
        map.addSource("leads-cluster", {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
          cluster: true, clusterMaxZoom: 13, clusterRadius: 50,
        });
        // Cluster glow
        map.addLayer({ id: "lead-clusters-glow", type: "circle", source: "leads-cluster",
          filter: ["has", "point_count"], maxzoom: 13.5,
          paint: { "circle-color": ["step",["get","point_count"],"#22c55e",10,"#f59e0b",30,"#ef4444"],
            "circle-radius": ["step",["get","point_count"],26,10,33,30,42], "circle-opacity": 0.25 },
        });
        map.addLayer({
          id: "lead-clusters", type: "circle", source: "leads-cluster",
          filter: ["has", "point_count"], maxzoom: 13.5,
          paint: {
            "circle-color": ["step",["get","point_count"],"#22c55e",10,"#f59e0b",30,"#ef4444"],
            "circle-radius": ["step",["get","point_count"],18,10,24,30,30],
            "circle-opacity": 0.9, "circle-stroke-width": 2.5, "circle-stroke-color": "#fff",
          },
        });
        map.addLayer({
          id: "lead-cluster-count", type: "symbol", source: "leads-cluster",
          filter: ["has", "point_count"], maxzoom: 13.5,
          layout: { "text-field": "{point_count_abbreviated}", "text-font": ["DIN Offc Pro Medium","Arial Unicode MS Bold"], "text-size": 13 },
          paint: { "text-color": "#ffffff" },
        });
        // Unclustered individual pins
        map.addLayer({ id: "lead-unclustered-glow", type: "circle", source: "leads-cluster",
          filter: ["!", ["has", "point_count"]], minzoom: 12,
          paint: { "circle-color": ["match",["get","status"],"prospect","#22c55e","contacted","#3b82f6","interested","#8b5cf6","follow_up","#f59e0b","sold","#10b981","not_interested","#ef4444","#22c55e"],
            "circle-radius": 14, "circle-opacity": 0.18 },
        });
        map.addLayer({ id: "lead-unclustered", type: "circle", source: "leads-cluster",
          filter: ["!", ["has", "point_count"]], minzoom: 12,
          paint: { "circle-color": ["match",["get","status"],"prospect","#22c55e","contacted","#3b82f6","interested","#8b5cf6","follow_up","#f59e0b","sold","#10b981","not_interested","#ef4444","#22c55e"],
            "circle-radius": 8, "circle-stroke-width": 2, "circle-stroke-color": "rgba(255,255,255,0.9)", "circle-opacity": 0.95 },
        });
        map.on("click", "lead-clusters", (e: any) => {
          const features = map.queryRenderedFeatures(e.point, { layers: ["lead-clusters"] });
          const clusterId = features[0]?.properties?.cluster_id;
          if (!clusterId) return;
          (map.getSource("leads-cluster") as any).getClusterExpansionZoom(clusterId, (err: any, zoom: number) => {
            if (err) return;
            map.easeTo({ center: features[0].geometry.coordinates, zoom: zoom + 1 });
          });
        });
        map.on("click", "lead-unclustered", (e: any) => {
          const props = e.features?.[0]?.properties;
          const coords = e.features?.[0]?.geometry?.coordinates?.slice() as [number, number];
          if (!props || !coords) return;
          const lead = (window as any).__allLeads?.find((l: any) => l.id === props.id);
          if (!lead) return;
          const tm = (window as any).__teamMembers ?? [];
          new (window as any).mapboxgl.Popup({ offset: 14, className: "sr-popup", closeButton: true })
            .setLngLat(coords).setHTML(buildPopupHTML(lead, tm, canAssign)).addTo(map);
        });
        map.on("mouseenter", "lead-unclustered", () => { map.getCanvas().style.cursor = "pointer"; });
        map.on("mouseleave", "lead-unclustered", () => { map.getCanvas().style.cursor = ""; });
      }
      lastRenderedCount.current = 0;
    });
    map.setStyle(STYLE);
  }, [mapStyleMode, mapReady]);

  // ── Territory draw: expose addPoint callback + draw preview ──────────────
  useEffect(() => {
    if (territoryDrawMode) {
      (window as any).__territoryDrawActive = true;
      (window as any).__addTerritoryPoint = (pt: [number, number]) => {
        setTerritoryPoints(prev => {
          const next = [...prev, pt];
          // Draw preview on map
          const map = mapRef.current;
          if (map && next.length >= 2) {
            const coords = [...next, next[0]];
            try {
              if (map.getSource("territory-preview")) {
                (map.getSource("territory-preview") as any).setData({
                  type: "Feature", geometry: { type: "Polygon", coordinates: [coords] }, properties: {}
                });
              } else {
                map.addSource("territory-preview", {
                  type: "geojson",
                  data: { type: "Feature", geometry: { type: "Polygon", coordinates: [coords] }, properties: {} }
                });
                map.addLayer({ id: "territory-preview-fill", type: "fill", source: "territory-preview",
                  paint: { "fill-color": "#f97316", "fill-opacity": 0.2 } });
                map.addLayer({ id: "territory-preview-line", type: "line", source: "territory-preview",
                  paint: { "line-color": "#f97316", "line-width": 2, "line-dasharray": [3, 2] } });
              }
            } catch {}
          }
          return next;
        });
      };
    } else {
      (window as any).__territoryDrawActive = false;
      // Remove preview layers
      const map = mapRef.current;
      if (map) {
        try { if (map.getLayer("territory-preview-fill")) map.removeLayer("territory-preview-fill"); } catch {}
        try { if (map.getLayer("territory-preview-line")) map.removeLayer("territory-preview-line"); } catch {}
        try { if (map.getSource("territory-preview")) map.removeSource("territory-preview"); } catch {}
      }
    }
    return () => { (window as any).__territoryDrawActive = false; };
  }, [territoryDrawMode]);

  // ── Lasso mode — click to add polygon points, close to select leads ─────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    if (!lassoMode) {
      // Clean up layers when exiting lasso mode without saving
      if (lassoPoints.length === 0) {
        if (map.getLayer("lasso-fill")) map.removeLayer("lasso-fill");
        if (map.getLayer("lasso-outline")) map.removeLayer("lasso-outline");
        if (map.getSource("lasso-polygon")) map.removeSource("lasso-polygon");
        lassoLayerRef.current = false;
      }
      map.getCanvas().style.cursor = "";
      return;
    }

    map.getCanvas().style.cursor = "crosshair";

    // Point-in-polygon check for lasso
    function ptInPoly(lat: number, lng: number, poly: [number, number][]): boolean {
      let inside = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i], [xj, yj] = poly[j];
        if (((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
      }
      return inside;
    }

    const onClick = (e: any) => {
      if ((window as any).__territoryDrawActive) return;
      const pt: [number, number] = [e.lngLat.lng, e.lngLat.lat];
      setLassoPoints(prev => {
        const next = [...prev, pt];
        // Draw lasso polygon preview
        const closed = [...next, next[0]];
        const geojson = { type: "Feature" as const, geometry: { type: "Polygon" as const, coordinates: [closed.map(([lng, lat]) => [lng, lat])] }, properties: {} };
        if (!lassoLayerRef.current) {
          try {
            map.addSource("lasso-polygon", { type: "geojson", data: geojson });
            map.addLayer({ id: "lasso-fill", type: "fill", source: "lasso-polygon",
              paint: { "fill-color": "#f97316", "fill-opacity": 0.15 } });
            map.addLayer({ id: "lasso-outline", type: "line", source: "lasso-polygon",
              paint: { "line-color": "#f97316", "line-width": 2, "line-dasharray": [4, 2] } });
            lassoLayerRef.current = true;
          } catch {}
        } else {
          try { (map.getSource("lasso-polygon") as any).setData(geojson); } catch {}
        }
        // If 3+ points, compute which leads are inside
        if (next.length >= 3) {
          const selected = leads.filter(l => l.lat && l.lng && ptInPoly(l.lat, l.lng, next));
          setLassoSelected(selected);
        }
        return next;
      });
    };

    map.on("click", onClick);
    return () => {
      map.off("click", onClick);
      map.getCanvas().style.cursor = "";
    };
  }, [lassoMode, mapReady, leads]);

    // ── Popup custom styles ───────────────────────────────────────────────────
  useEffect(() => {
    const style = document.createElement("style");
    style.textContent = `
      .sr-popup .mapboxgl-popup-content {
        background: #0f1420;
        border: 1px solid #1e2e3d;
        border-radius: 10px;
        padding: 14px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.6);
      }
      .sr-popup .mapboxgl-popup-tip { border-top-color: #0f1420 !important; }
      .sr-popup .mapboxgl-popup-close-button {
        color: #64748b; font-size: 18px; top: 6px; right: 8px;
      }
      .sr-popup .mapboxgl-popup-close-button:hover { color: #e2e8f0; background: transparent; }
    `;
    document.head.appendChild(style);
    return () => document.head.removeChild(style);
  }, []);

  // ── Draw bbox helpers ─────────────────────────────────────────────────────
  const updateDrawLayer = useCallback((bbox: BBox) => {
    const src = mapRef.current?.getSource("draw-bbox") as mapboxgl.GeoJSONSource;
    src?.setData({ type: "Feature", geometry: { type: "Polygon", coordinates: [[
      [bbox.minLng, bbox.minLat], [bbox.maxLng, bbox.minLat],
      [bbox.maxLng, bbox.maxLat], [bbox.minLng, bbox.maxLat],
      [bbox.minLng, bbox.minLat],
    ]] }, properties: {} });
  }, []);

  const clearDrawLayer = useCallback(() => {
    const src = mapRef.current?.getSource("draw-bbox") as mapboxgl.GeoJSONSource;
    src?.setData({ type: "Feature", geometry: { type: "Polygon", coordinates: [[]] }, properties: {} });
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !drawMode) return;
    map.getCanvas().style.cursor = "crosshair";
    map.dragPan.disable();

    const onDown = (e: mapboxgl.MapMouseEvent) => { drawingRef.current = true; drawStartRef.current = e.lngLat; };
    const onMove = (e: mapboxgl.MapMouseEvent) => {
      if (!drawingRef.current || !drawStartRef.current) return;
      const s = drawStartRef.current, c = e.lngLat;
      updateDrawLayer({ minLng: Math.min(s.lng, c.lng), maxLng: Math.max(s.lng, c.lng), minLat: Math.min(s.lat, c.lat), maxLat: Math.max(s.lat, c.lat) });
    };
    const onUp = (e: mapboxgl.MapMouseEvent) => {
      if (!drawingRef.current || !drawStartRef.current) return;
      drawingRef.current = false;
      const s = drawStartRef.current, c = e.lngLat;
      setDrawnBBox({ minLng: Math.min(s.lng, c.lng), maxLng: Math.max(s.lng, c.lng), minLat: Math.min(s.lat, c.lat), maxLat: Math.max(s.lat, c.lat) });
      drawStartRef.current = null;
      setDrawMode(false);
      map.getCanvas().style.cursor = "";
      map.dragPan.enable();
    };

    map.on("mousedown", onDown); map.on("mousemove", onMove); map.on("mouseup", onUp);
    return () => {
      map.off("mousedown", onDown); map.off("mousemove", onMove); map.off("mouseup", onUp);
      map.getCanvas().style.cursor = ""; map.dragPan.enable();
    };
  }, [drawMode, mapReady, updateDrawLayer]);

  // ── Scan helpers ──────────────────────────────────────────────────────────
  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  const addScanDot = useCallback((row: ScanRow & { leadTag?: string | null; leadScore?: number }) => {
    const map = mapRef.current;
    if (!map || !row.lat || !row.lng) return;

    // Dot color + size logic based on fiber status + lead tag
    // 🟢 Green pulsing = HOT LEAD (NEW FIBER + billingStatus N, no subscriber)
    // 🟡 Yellow = COMING SOON (NEW FIBER + billingStatus Y, has subscriber)
    // 🔵 Blue = TENURED non-subscriber (upgrade target)
    // 🔴 Red = copper/no service
    // ⚪ Gray = unknown/tenured+subscriber
    const isHotLead = row.leadTag === "hot_lead" || (row.isNewFiber && row.billingStatus === "N");
    const isFiberSoon = row.householdSegmentType === "COMING_SOON"; // tracked by CNS scanner
    const isComingSoon = !isFiberSoon && (row.leadTag === "coming_soon" || (row.isNewFiber && row.billingStatus === "Y"));
    const isUpgradeTarget = row.leadTag === "upgrade_target";
    const isCopper = row.fiberStatus === "copper" || row.fiberStatus === "no_service";

    let bg: string, border: string, glow: string, size = 10, label: string;
    if (isHotLead) {
      bg = "#22c55e"; border = "#86efac"; glow = "rgba(34,197,94,0.8)"; size = 12; label = "🔥 HOT LEAD";
    } else if (isFiberSoon) {
      bg = "#a855f7"; border = "#d8b4fe"; glow = "rgba(168,85,247,0.7)"; size = 11; label = "📡 FIBER SOON";
    } else if (isComingSoon) {
      bg = "#f59e0b"; border = "#fcd34d"; glow = "rgba(245,158,11,0.7)"; size = 10; label = "⏳ COMING SOON";
    } else if (isUpgradeTarget) {
      bg = "#3b82f6"; border = "#93c5fd"; glow = "rgba(59,130,246,0.6)"; size = 9; label = "⬆️ UPGRADE TARGET";
    } else if (isCopper) {
      bg = "#ef4444"; border = "#fca5a5"; glow = "rgba(239,68,68,0.4)"; size = 7; label = "❌ No Fiber";
    } else {
      bg = "#94a3b8"; border = "#cbd5e1"; glow = "rgba(148,163,184,0.4)"; size = 8; label = row.fiberStatus;
    }

    // Determine if this is a new hit — pulse animation
    const isNew = isHotLead || isComingSoon || isFiberSoon;

    const el = document.createElement("div");
    el.style.cssText = [
      `width:${size}px;height:${size}px;border-radius:50%;`,
      `background:${bg};border:2px solid ${border};`,
      `box-shadow:0 0 ${isHotLead ? 10 : 6}px ${glow};`,
      `cursor:pointer;position:relative;transition:transform 0.15s;`,
    ].join("");

    // Pulse ring for hot leads
    if (isNew) {
      const ring = document.createElement("div");
      ring.style.cssText = [
        `position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);`,
        `width:${size + 8}px;height:${size + 8}px;border-radius:50%;`,
        `border:2px solid ${bg};opacity:0.6;`,
        `animation:hf-pulse 1.5s ease-out infinite;`,
      ].join("");
      el.appendChild(ring);
      // Inject pulse animation once
      if (!document.getElementById("hf-pulse-style")) {
        const style = document.createElement("style");
        style.id = "hf-pulse-style";
        style.textContent = `@keyframes hf-pulse{0%{transform:translate(-50%,-50%) scale(1);opacity:0.6}100%{transform:translate(-50%,-50%) scale(2.5);opacity:0}}`;
        document.head.appendChild(style);
      }
    }

    el.addEventListener("mouseenter", () => { el.style.transform = "scale(1.4)"; });
    el.addEventListener("mouseleave", () => { el.style.transform = "scale(1)"; });

    const popup = new (window as any).mapboxgl.Popup({ offset: 14, closeButton: false })
      .setHTML(`
        <div style="font-size:11px;color:#e2e8f0;max-width:220px;">
          <div style="font-weight:700;margin-bottom:2px;">${escapeHtml(row.address)}</div>
          <div style="color:${bg};font-weight:600;">${escapeHtml(label)}</div>
          ${row.techType ? `<div style="color:#94a3b8;">${escapeHtml(row.techType)} ${row.chipSetType ? "/ " + escapeHtml(row.chipSetType) : ""}</div>` : ""}
          ${row.maxDownloadMbps ? `<div style="color:#38bdf8;">Max: ${row.maxDownloadMbps >= 1000 ? (row.maxDownloadMbps/1000).toFixed(0)+"G" : row.maxDownloadMbps+"M"} Mbps</div>` : ""}
          ${row.competitorName ? `<div style="color:#f59e0b;">Competitor: ${escapeHtml(row.competitorName)}</div>` : ""}
        </div>
      `);
    const m = new (window as any).mapboxgl.Marker({ element: el }).setLngLat([row.lng, row.lat]).setPopup(popup).addTo(map);
    scanMarkersRef.current.push(m);
  }, []);

  const pollJob = useCallback(async (id: string, bbox?: BBox) => {
    try {
      const res = await apiRequest("GET", `/api/scan/${id}`);
      const status: ScanJobStatus = await res.json();
      setDone(status.done);
      setTotal(status.total);
      setProgress(status.total ? Math.round((status.done / status.total) * 100) : 0);
      const newRows = (status.results ?? []).slice(lastRenderedCount.current);
      lastRenderedCount.current = status.results?.length ?? 0;
      let found = 0;
      for (const r of newRows) {
        // Show ALL scan results as colored dots — not just new fiber
        // Green pulsing = hot lead, yellow = coming soon, blue = upgrade, red = copper
        if (!r.lat || !r.lng) continue;
        if (bbox && !inBBox(r.lat, r.lng, bbox)) continue;
        // Only skip tenured+subscriber and unknown (no dot spam)
        if (r.fiberStatus === "unknown" && !r.isNewFiber) continue;
        addScanDot(r);
        if (r.isNewFiber && r.billingStatus === "N") found++;
      }
      if (found > 0) setNewFound(p => p + found);

      // Live lead refresh: pull newly-saved leads onto the map every ~8 polls
      // (~3s) while scanning, so found leads appear as assignable pins in near
      // real time instead of only when the whole scan finishes.
      pollTickRef.current += 1;
      if (found > 0 && pollTickRef.current % 8 === 0) {
        qc.invalidateQueries({ queryKey: ["/api/leads/map"] });
      }

      if (status.status === "done") { stopPolling(); setScanning(false); qc.invalidateQueries({ queryKey: ["/api/leads"] }); qc.invalidateQueries({ queryKey: ["/api/leads/map"] }); }
    } catch { /* keep polling */ }
  }, [addScanDot, stopPolling, qc]);

  const startScan = useCallback(async (endpoint: string, body: object) => {
    if (!mapReady) return;
    scanMarkersRef.current.forEach(m => m.remove());
    scanMarkersRef.current = []; lastRenderedCount.current = 0; pollTickRef.current = 0;
    setNewFound(0); setDone(0); setProgress(0); setError(null);
    stopPolling(); setScanning(true);
    try {
      const res = await apiRequest("POST", endpoint, body);
      const { jobId: id, total: t, bbox, source } = await res.json();
      setScanSource(source ?? "mapbox");
      setJobId(id); setTotal(t);
      pollRef.current = setInterval(() => pollJob(id, drawnBBox ?? undefined), POLL_MS);
    } catch (e: any) { setScanning(false); setError(e.message); }
  }, [mapReady, stopPolling, pollJob, drawnBBox]);

  const stopScan = useCallback(async () => {
    stopPolling();
    if (jobId) { try { await apiRequest("DELETE", `/api/scan/${jobId}`); } catch {} }
    setScanning(false);
  }, [stopPolling, jobId]);

  // ── Legend items ──────────────────────────────────────────────────────────
  // ── Fly to lead on map ────────────────────────────────────────────────────
  const flyToLead = useCallback((lead: MapPin) => {
    if (!mapRef.current || !lead.lat || !lead.lng) return;
    setSelectedLeadId(lead.id);
    mapRef.current.flyTo({ center: [lead.lng, lead.lat], zoom: 17, duration: 900, essential: true });
    setTimeout(() => {
      // Show popup via map layer instead of DOM marker ref
      const map = mapRef.current;
      if (!map) return;
      const tm = (window as any).__teamMembers ?? [];
      new (window as any).mapboxgl.Popup({ offset: 14, className: "sr-popup", closeButton: true })
        .setLngLat([lead.lng, lead.lat])
        .setHTML(buildPopupHTML(lead, tm, canAssign))
        .addTo(map);
    }, 950);
  }, []);

  const statusCounts = Object.keys(PIN_COLORS).reduce((acc, s) => {
    acc[s] = leads.filter(l => l.leadStatus === s).length; return acc;
  }, {} as Record<string, number>);

  // Sidebar computed
  const sidebarLeads = leads.filter(l => {
    const matchStatus = filterStatus === "all" || l.leadStatus === filterStatus;
    const q = sidebarSearch.toLowerCase();
    const matchSearch = !q || l.address.toLowerCase().includes(q) || (l.city ?? "").toLowerCase().includes(q);
    const matchRep = filterRep === "all" ? true
      : filterRep === "unassigned" ? !l.assignedRepId
      : l.assignedRepId === Number(filterRep);
    return matchStatus && matchSearch && matchRep;
  }).sort((a, b) => (b.leadScore ?? 0) - (a.leadScore ?? 0));

  // noToken is true only after we confirmed the token is unavailable (never during load)
  const noToken = mapTokenFailed;
  const tokenLoading = !mapboxToken && !mapTokenFailed;

  return (
    <div className="flex flex-col" style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>

      {/* ── Top bar ── */}
      <div className="flex items-center gap-3 px-3 py-2 border-b border-border bg-card flex-shrink-0">
        {/* Stats */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full bg-green-400 shadow-[0_0_6px_rgba(34,197,94,0.8)]" />
            <span className="text-xs font-semibold text-foreground">{leads.length}</span>
            <span className="text-xs text-muted-foreground">leads</span>
          </div>
          <div className="flex items-center gap-1">
            <Wifi className="w-3 h-3 text-teal-400" />
            <span className="text-xs font-semibold text-teal-400">{leads.filter(l => l.fiberStatus === "new_fiber").length}</span>
            <span className="text-xs text-muted-foreground hidden sm:inline"> fiber</span>
          </div>
          <div className="flex items-center gap-1">
            <Users className="w-3 h-3 text-blue-400" />
            <span className="text-xs text-muted-foreground">{leads.filter(l => l.assignedRepId).length} assigned</span>
          </div>
        </div>

        {/* Actions */}
        <div className="ml-auto flex items-center gap-1.5">
          {/* Lasso / bulk select tool — admin, manager, team lead */}
          {canAssign && (
            <Button
              size="sm" variant="outline"
              onClick={() => {
                if (lassoMode) {
                  // Exit lasso, clear
                  setLassoMode(false);
                  setLassoPoints([]);
                  setLassoSelected([]);
                  setLassoRepId("");
                  const map = mapRef.current;
                  if (map) {
                    try { map.removeLayer("lasso-fill"); } catch {}
                    try { map.removeLayer("lasso-outline"); } catch {}
                    try { map.removeSource("lasso-polygon"); } catch {}
                    lassoLayerRef.current = false;
                  }
                } else {
                  setLassoMode(true);
                  setTerritoryDrawMode(false);
                }
              }}
              disabled={!mapReady}
              className={`h-7 text-xs ${
                lassoMode
                  ? "border-orange-500 text-orange-400 bg-orange-500/10"
                  : "border-orange-500/40 text-orange-400 hover:bg-orange-500/10"
              }`}
              title="Lasso: click points around leads, then bulk-assign to rep"
            >
              <Pencil className="w-3 h-3 mr-1" />
              {lassoMode ? `Lasso (${lassoSelected.length} selected)` : "Lasso"}
            </Button>
          )}
          {/* Satellite/street toggle */}
          <Button
            size="sm" variant="outline"
            onClick={() => setMapStyleMode(m => m === "dark" ? "satellite" : "dark")}
            disabled={!mapReady}
            className="h-7 text-xs border-border text-muted-foreground hover:text-foreground"
            title={mapStyleMode === "satellite" ? "Switch to street" : "Switch to satellite"}
          >
            {mapStyleMode === "satellite" ? "🗺 Street" : "🛰 Satellite"}
          </Button>
          {/* Reset view */}
          <Button
            size="sm" variant="outline"
            onClick={() => mapRef.current?.flyTo({ center: ROCKWELL_CENTER, zoom: 13, duration: 800 })}
            disabled={!mapReady}
            className="h-7 text-xs border-border text-muted-foreground hover:text-foreground"
            title="Reset map view"
          ><Home className="w-3 h-3" /></Button>
          {canAssign && (
            <Button
              onClick={() => { setTerritoryDrawMode(!territoryDrawMode); setTerritoryPoints([]); setLassoMode(false); }}
              disabled={!mapReady}
              size="sm" variant="outline"
              className={`h-7 text-xs ${territoryDrawMode ? "border-purple-500 text-purple-400 bg-purple-500/10" : "border-purple-500/40 text-purple-400 hover:bg-purple-500/10"}`}
            ><ShieldCheck className="w-3 h-3 mr-1" />{territoryDrawMode ? "Drawing…" : "Territory"}</Button>
          )}
          <Button size="sm" variant="ghost" className="h-7 px-2 text-muted-foreground" onClick={() => setSidebarOpen(v => !v)} title="Toggle lead list">
            <SlidersHorizontal className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>

      {/* Context banners */}
      {territoryDrawMode && canAssign && (
        <div className="px-3 py-2 bg-purple-500/10 border-b border-purple-500/30 flex flex-wrap items-center gap-2 flex-shrink-0">
          <span className="text-[11px] text-purple-400">Click map to add polygon points ({territoryPoints.length} pts, min 3)</span>
          <input value={territoryName} onChange={e => setTerritoryName(e.target.value)} placeholder="Territory name…"
            className="bg-background border border-border rounded px-2 py-0.5 text-[11px] text-foreground w-32 focus:outline-none focus:ring-1 focus:ring-purple-500" />
          <select value={territoryRepId} onChange={e => setTerritoryRepId(e.target.value)}
            className="bg-background border border-border rounded px-2 py-0.5 text-[11px] text-foreground w-32 focus:outline-none focus:ring-1 focus:ring-purple-500">
            <option value="">Assign rep…</option>
            {team.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          <Button size="sm" disabled={territoryPoints.length < 3 || !territoryName || !territoryRepId || saveTerritoryMutation.isPending}
            onClick={() => saveTerritoryMutation.mutate({ name: territoryName, repId: Number(territoryRepId), polygon: JSON.stringify(territoryPoints), color: "#8b5cf6" })}
            className="bg-purple-600 hover:bg-purple-700 text-white h-6 text-[11px] px-2">Save</Button>
          <Button size="sm" variant="ghost" className="text-muted-foreground h-6 text-[11px]" onClick={() => { setTerritoryDrawMode(false); setTerritoryPoints([]); }}>Cancel</Button>
          {territoryPoints.length > 0 && <Button size="sm" variant="ghost" className="text-red-400 h-6 text-[11px]" onClick={() => setTerritoryPoints([])}>Clear</Button>}
        </div>
      )}
      {/* ── Lasso bulk-assign banner ── */}
      {lassoMode && (
        <div className="px-3 py-2 bg-orange-500/10 border-b border-orange-500/30 flex flex-wrap items-center gap-2 flex-shrink-0">
          <span className="text-[11px] text-orange-400 font-medium">
            ■ Lasso active — click map to draw area
            {lassoPoints.length > 0 && ` (${lassoPoints.length} pts)`}
            {lassoSelected.length > 0 && ` → ${lassoSelected.length} leads selected`}
          </span>
          {lassoSelected.length > 0 && (
            <>
              <select
                value={lassoRepId}
                onChange={e => setLassoRepId(e.target.value)}
                className="bg-background border border-border rounded px-2 py-0.5 text-[11px] text-foreground focus:outline-none focus:ring-1 focus:ring-orange-500"
              >
                <option value="">Assign to rep…</option>
                {team.map((m: TeamMember) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
              <Button
                size="sm"
                disabled={!lassoRepId || bulkAssignMutation.isPending}
                onClick={() => bulkAssignMutation.mutate({ leadIds: lassoSelected.map(l => l.id), repId: Number(lassoRepId) })}
                className="h-6 text-[11px] px-2 bg-orange-600 hover:bg-orange-700 text-white"
              >
                {bulkAssignMutation.isPending ? "Assigning…" : `Assign ${lassoSelected.length}`}
              </Button>
            </>
          )}
          <Button
            size="sm" variant="ghost"
            className="text-orange-400/70 h-6 text-[11px] ml-auto"
            onClick={() => {
              setLassoMode(false); setLassoPoints([]); setLassoSelected([]); setLassoRepId("");
              const map = mapRef.current;
              if (map) {
                try { map.removeLayer("lasso-fill"); } catch {}
                try { map.removeLayer("lasso-outline"); } catch {}
                try { map.removeSource("lasso-polygon"); } catch {}
                lassoLayerRef.current = false;
              }
            }}
          >Cancel</Button>
          {lassoPoints.length > 0 && (
            <Button size="sm" variant="ghost" className="text-orange-400/70 h-6 text-[11px]"
              onClick={() => {
                setLassoPoints([]); setLassoSelected([]);
                const map = mapRef.current;
                if (map) {
                  try { map.removeLayer("lasso-fill"); } catch {}
                  try { map.removeLayer("lasso-outline"); } catch {}
                  try { map.removeSource("lasso-polygon"); } catch {}
                  lassoLayerRef.current = false;
                }
              }}
            >Clear points</Button>
          )}
        </div>
      )}

      {error && (
        <div className="px-3 py-1.5 bg-red-500/10 border-b border-red-500/30 text-[11px] text-red-400 flex items-center gap-2 flex-shrink-0">
          <AlertCircle className="w-3 h-3" /> {error}
        </div>
      )}
      {canManage && pendingRequests.length > 0 && (
        <div className="border-b border-amber-500/30 bg-amber-500/5 flex-shrink-0">
          <button className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] font-medium text-amber-400 hover:bg-amber-500/10" onClick={() => setShowTerritoryRequests(v => !v)}>
            <Bell className="w-3 h-3" />
            <span className="flex-1 text-left">{pendingRequests.length} territory request{pendingRequests.length !== 1 ? "s" : ""}</span>
            <span className="text-[10px] text-muted-foreground">{showTerritoryRequests ? "▲" : "▼"}</span>
          </button>
          {showTerritoryRequests && (
            <div className="px-3 pb-2 space-y-1.5">
              {pendingRequests.map(req => (
                <div key={req.id} className="flex flex-wrap items-center gap-2 bg-card/60 rounded px-2 py-1.5 border border-border text-[11px]">
                  <span className="font-semibold text-foreground flex-1">{req.repName}</span>
                  {req.notes && <span className="text-muted-foreground italic">"{req.notes}"</span>}
                  <Button size="sm" className="h-5 text-[10px] px-1.5 bg-purple-600 hover:bg-purple-700 text-white" disabled={fulfillRequestMutation.isPending}
                    onClick={() => fulfillRequestMutation.mutate({ id: req.id, action: "fulfilled" })}>Assign</Button>
                  <Button size="sm" variant="ghost" className="h-5 text-[10px] px-1.5 text-muted-foreground" disabled={fulfillRequestMutation.isPending}
                    onClick={() => fulfillRequestMutation.mutate({ id: req.id, action: "dismissed" })}>Dismiss</Button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Main: map + sidebar ── */}
      <div className="flex flex-1 min-h-0 overflow-hidden">

        {/* MAP */}
        <div className="relative flex-1 min-w-0">
          <div style={{ position: "absolute", inset: 0 }}>
            <div ref={mapContainer} style={{ width: "100%", height: "100%" }} />
          </div>

          {!mapReady && !noToken && (
            <div className="absolute inset-0 flex items-center justify-center bg-card/80 z-10">
              <div className="text-center">
                <MapIcon className="w-8 h-8 text-muted-foreground mx-auto mb-2 animate-pulse" />
                <div className="text-sm text-muted-foreground">Loading map…</div>
              </div>
            </div>
          )}
          {noToken && (
            <div className="absolute inset-0 flex items-center justify-center bg-card/95 z-10">
              <div className="text-center max-w-xs">
                <MapIcon className="w-10 h-10 text-muted-foreground mx-auto mb-3 opacity-40" />
                <div className="text-sm font-medium mb-1">Mapbox token needed</div>
                <div className="text-xs text-muted-foreground">Add MAPBOX_TOKEN to server .env</div>
              </div>
            </div>
          )}

          {/* Lead count chip — top left */}
          {mapReady && leads.length > 0 && (
            <div className="absolute top-3 left-3 bg-black/80 backdrop-blur-sm rounded-lg px-3 py-1.5 z-10 flex items-center gap-2 shadow-lg">
              <div className="w-2 h-2 rounded-full bg-green-400 shadow-[0_0_8px_rgba(34,197,94,1)] animate-pulse" />
              <span className="text-xs font-bold text-white">
                {filterStatus === "all" ? leads.length : (statusCounts[filterStatus] ?? 0)}
              </span>
              <span className="text-[11px] text-white/60">
                {filterStatus === "all" ? "pins" : (PIN_COLORS[filterStatus]?.label ?? filterStatus)}
              </span>
              {filterStatus !== "all" && (
                <button onClick={() => setFilterStatus("all")} className="text-white/40 hover:text-white text-xs leading-none ml-1">×</button>
              )}
            </div>
          )}

          {/* Pin legend + filter — bottom left, FiberFocus style */}
          {mapReady && (
            <div className="absolute bottom-8 left-3 bg-black/85 backdrop-blur-md rounded-xl p-3 z-10 min-w-[150px] shadow-xl border border-white/5">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] text-white/40 uppercase tracking-wider font-semibold">Filter by status</span>
                {filterStatus !== "all" && (
                  <button onClick={() => setFilterStatus("all")} className="text-[10px] text-teal-400 hover:text-teal-300">Clear</button>
                )}
              </div>
              {Object.entries(PIN_COLORS).map(([status, pin]) => {
                const count = statusCounts[status] ?? 0;
                const isActive = filterStatus === status;
                return (
                  <div
                    key={status}
                    onClick={() => setFilterStatus(isActive ? "all" : status)}
                    className="flex items-center gap-2 mb-1 cursor-pointer rounded-md px-1 py-0.5 transition-all"
                    style={{ background: isActive ? pin.bg + "22" : "transparent" }}
                  >
                    <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: pin.bg, boxShadow: isActive ? `0 0 6px ${pin.bg}` : "none" }} />
                    <span className="text-[11px] flex-1" style={{ color: isActive ? pin.bg : "#94a3b8", fontWeight: isActive ? 700 : 400 }}>{pin.label}</span>
                    <span className="text-[10px] tabular-nums" style={{ color: count > 0 ? "#e2e8f0" : "#475569" }}>{count}</span>
                  </div>
                );
              })}
              {territories.length > 0 && (
                <div className="pt-2 mt-1 border-t border-white/10">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[10px] text-white/40 uppercase tracking-wider font-semibold">Territories</span>
                    <button onClick={() => setShowTerritories(v => !v)} className="text-[10px] text-white/40 hover:text-white/70">{showTerritories ? "Hide" : "Show"}</button>
                  </div>
                  {territories.map(t => {
                    const prog = territoryProgress.find(p => p.id === t.id);
                    return (
                    <div key={t.id} className="mb-1.5 group">
                      <div className="flex items-center gap-2">
                        <div className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: t.color, opacity: 0.8 }} />
                        <span className="text-[11px] truncate" style={{ color: t.color }}>{t.name}</span>
                        {prog && <span className="ml-auto text-[10px] text-white/50 tabular-nums">{prog.knocked}/{prog.total} · {prog.pct}%</span>}
                        {canAssign && <button onClick={() => deleteTerritoryMutation.mutate(t.id)} className="opacity-0 group-hover:opacity-100 text-red-400 text-xs">×</button>}
                      </div>
                      {prog && prog.total > 0 && (
                        <div className="h-1 rounded-full bg-white/10 mt-0.5 overflow-hidden">
                          <div className="h-full rounded-full" style={{ width: `${prog.pct}%`, background: t.color }} />
                        </div>
                      )}
                    </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── LEAD SIDEBAR ── */}
        {sidebarOpen && (
          <div className="w-72 flex-shrink-0 flex flex-col border-l border-border bg-card overflow-hidden">

            {/* Sidebar header */}
            <div className="px-3 pt-3 pb-2 border-b border-border flex-shrink-0">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-bold text-foreground uppercase tracking-wide">Leads</span>
                <span className="text-[11px] text-muted-foreground">{sidebarLeads.length} shown</span>
              </div>
              {/* Search */}
              <div className="relative mb-2">
                <input
                  value={sidebarSearch}
                  onChange={e => setSidebarSearch(e.target.value)}
                  placeholder="Search address…"
                  className="w-full bg-background border border-border rounded-md pl-7 pr-2 py-1.5 text-[11px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                />
                <Filter className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground" />
              </div>
              {/* Rep filter chips */}
              {canManage && (
                <div className="flex flex-wrap gap-1">
                  {[
                    { id: "all", label: "All" },
                    { id: "unassigned", label: `Unassigned (${leads.filter(l => !l.assignedRepId).length})` },
                    ...team.map((m: TeamMember) => ({ id: String(m.id), label: `${m.name.split(" ")[0]} (${leads.filter(l => l.assignedRepId === m.id).length})` }))
                  ].map(opt => (
                    <button
                      key={opt.id}
                      onClick={() => setFilterRep(opt.id)}
                      className="text-[10px] px-2 py-0.5 rounded-full border transition-all"
                      style={{
                        background: filterRep === opt.id ? "#3EA394" : "transparent",
                        borderColor: filterRep === opt.id ? "#3EA394" : "#334155",
                        color: filterRep === opt.id ? "#fff" : "#64748b",
                        fontWeight: filterRep === opt.id ? 600 : 400,
                      }}
                    >{opt.label}</button>
                  ))}
                </div>
              )}
            </div>

            {/* Lead list */}
            <div className="flex-1 overflow-y-auto overscroll-contain" style={{ scrollbarWidth: "thin" }}>
              {sidebarLeads.length === 0 && (
                <div className="flex flex-col items-center justify-center h-32 text-center px-4">
                  <Target className="w-6 h-6 text-muted-foreground/40 mb-2" />
                  <p className="text-xs text-muted-foreground">No leads match filter</p>
                </div>
              )}
              {sidebarLeads.map(lead => {
                const pin = PIN_COLORS[lead.leadStatus] ?? PIN_COLORS.prospect;
                const rep = team.find(m => m.id === lead.assignedRepId);
                const isSelected = selectedLeadId === lead.id;
                const speed = lead.maxDownloadMbps ? (lead.maxDownloadMbps >= 1000 ? `${lead.maxDownloadMbps/1000}G` : `${lead.maxDownloadMbps}M`) : null;
                return (
                  <div
                    key={lead.id}
                    onClick={() => flyToLead(lead)}
                    className="px-3 py-2.5 border-b border-border cursor-pointer transition-colors"
                    style={{ background: isSelected ? pin.bg + "12" : "transparent" }}
                    onMouseEnter={e => { if (!isSelected) (e.currentTarget as HTMLDivElement).style.background = "#ffffff08"; }}
                    onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = isSelected ? pin.bg + "12" : "transparent"; }}
                  >
                    {/* Address row */}
                    <div className="flex items-start gap-2 mb-1">
                      <svg viewBox="0 0 18 24" width="10" height="14" className="flex-shrink-0 mt-0.5">
                        <path d="M9 0C4.029 0 0 4.029 0 9C0 15 9 24 9 24C9 24 18 15 18 9C18 4.029 13.971 0 9 0Z"
                          fill={pin.bg} stroke={pin.border} strokeWidth="1.5"/>
                        <circle cx="9" cy="9" r="3.5" fill="white" fillOpacity="0.9"/>
                      </svg>
                      <div className="flex-1 min-w-0">
                        <div className="text-[12px] font-semibold text-foreground leading-tight truncate">{lead.address}</div>
                        <div className="text-[10px] text-muted-foreground">{lead.city}, {lead.state} {lead.zip}</div>
                      </div>
                    </div>

                    {/* Badges row */}
                    <div className="flex items-center gap-1 flex-wrap ml-3.5">
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ background: pin.bg + "22", color: pin.bg }}>{pin.label}</span>
                      {lead.fiberStatus === "new_fiber" && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-teal-400/15 text-teal-400">NEW FIBER</span>
                      )}
                      {speed && <span className="px-1.5 py-0.5 rounded text-[10px] bg-sky-400/15 text-sky-400">{speed}</span>}
                      {lead.competitorName && <span className="px-1.5 py-0.5 rounded text-[10px] bg-amber-400/10 text-amber-400 truncate max-w-[70px]">{lead.competitorName}</span>}
                    </div>

                    {/* Rep row */}
                    {(rep || lead.leadScore >= 80) && (
                      <div className="flex items-center justify-between mt-1 ml-3.5">
                        {rep
                          ? <span className="text-[10px] text-blue-400 flex items-center gap-1"><Users className="w-2.5 h-2.5" />{rep.name}</span>
                          : <span />}
                        {lead.leadScore >= 80 && (
                          <span className="text-[10px] text-orange-400 font-semibold">🔥 Score {lead.leadScore}</span>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Sidebar footer stats */}
            <div className="px-3 py-2 border-t border-border flex-shrink-0 grid grid-cols-3 gap-1 text-center">
              <div>
                <div className="text-xs font-bold text-green-400">{leads.filter(l => l.fiberStatus === "new_fiber").length}</div>
                <div className="text-[9px] text-muted-foreground uppercase tracking-wide">New Fiber</div>
              </div>
              <div>
                <div className="text-xs font-bold text-blue-400">{leads.filter(l => l.assignedRepId).length}</div>
                <div className="text-[9px] text-muted-foreground uppercase tracking-wide">Assigned</div>
              </div>
              <div>
                <div className="text-xs font-bold text-orange-400">{leads.filter(l => (l.leadScore ?? 0) >= 80).length}</div>
                <div className="text-[9px] text-muted-foreground uppercase tracking-wide">Hot</div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}