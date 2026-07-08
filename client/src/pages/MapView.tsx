import { useEffect, useRef, useState, useCallback, useMemo, useSyncExternalStore } from "react";
// mapbox-gl loaded via CDN in index.html — do not bundle
declare const mapboxgl: any;
import {
  Play, Square, RefreshCw, AlertCircle, Pencil, X,
  DoorOpen, UserCheck, Zap, CalendarClock, PhoneOff, Map as MapIcon, Bell,
  ChevronRight, Home, Wifi, Signal, Users, Target, Search, LocateFixed, Footprints,
  Satellite, Moon
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { useIsMobile } from "@/hooks/use-mobile";
import type { Lead, TeamMember, InsertKnock, Territory } from "@shared/schema";
import { colorForRep } from "@shared/repColors";
import { TerritoryDetailPanel } from "@/components/TerritoryDetailPanel";
import { LeadKnockSheet } from "@/components/LeadKnockSheet";
import { RepProgressHUD } from "@/components/RepProgressHUD";
import { getKnockQueue, type KnockQueue, type QueueSnapshot } from "@/lib/knockQueue";
import {
  OUTCOME_TO_STATUS, pinDisplayState, nearestUnworkedLead, distanceHint,
  haversineMeters, type KnockOutcome,
} from "@shared/knock";
import {
  UNCLUSTERED_PAINT, UNCLUSTERED_GLOW_PAINT, SELECTED_RING_SPEC,
  SELECTED_RING_FILTER, sheetPeekPaddingPx, moveCamera,
} from "@/lib/mapPins";

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
  visited?: boolean;
  knockCount?: number;
  lastOutcome?: string | null;
  lastKnockedAt?: string | null;
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

// Compact "3m ago / 2h ago / 4d ago" for the visited banner.
function relTime(iso?: string | null): string {
  if (!iso) return "";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// ── Inline popup HTML builder ─────────────────────────────────────────────────
// The field card that opens when a rep taps a pin. Built to be usable one-handed
// in the field: big Directions / Call actions up top, then one-tap knock logging.
function buildPopupHTML(
  lead: MapPin,
  team: TeamMember[],
  opts: { canAssign?: boolean; currentRepId?: number | null } = {}
): string {
  const { canAssign = true, currentRepId = null } = opts;
  const pin = PIN_COLORS[lead.leadStatus] ?? PIN_COLORS.prospect;
  const repOptions = team.filter(m => m.active)
    .map(m => `<option value="${m.id}" ${m.id === lead.assignedRepId ? "selected" : ""}>${escapeHtml(m.name)}</option>`)
    .join("");

  // Tap the address / Directions → open turn-by-turn (Maps app on mobile).
  const dest = (lead.lat && lead.lng)
    ? `${lead.lat},${lead.lng}`
    : encodeURIComponent(`${lead.address}, ${lead.city}, ${lead.state} ${lead.zip}`);
  const dirUrl = `https://www.google.com/maps/dir/?api=1&destination=${dest}`;
  const phone = lead.contactPhone ? String(lead.contactPhone).replace(/[^0-9+]/g, "") : "";

  // Who a logged knock is credited to. Managers pick via the dropdown; reps are
  // always credited to themselves (no dropdown shown for them).
  const knockRep = canAssign ? "" : String(currentRepId ?? "");
  const hot = (lead.leadScore ?? 0) >= 80;

  // Compact tags line — only what matters at a glance (NEW FIBER, hot). Status is
  // already the colored dot; contact/notes/competitor live in the Leads panel.
  const tags = [
    lead.fiberStatus === "new_fiber" ? `<span style="background:#22c55e22;color:#22c55e;border-radius:999px;padding:1px 7px;font-size:10px;font-weight:700;">NEW FIBER</span>` : "",
    hot ? `<span style="background:#f9731622;color:#fb923c;border-radius:999px;padding:1px 7px;font-size:10px;font-weight:700;">🔥 ${lead.leadScore}</span>` : "",
    lead.visited ? `<span style="background:#0f2a1e;color:#22c55e;border-radius:999px;padding:1px 7px;font-size:10px;font-weight:700;">✓ ${escapeHtml(String(lead.lastOutcome ?? "").replace("_", " "))} · ${relTime(lead.lastKnockedAt)}</span>` : "",
  ].filter(Boolean).join("");

  return `
    <div style="font-family:system-ui,sans-serif;color:#e2e8f0;width:228px;">
      <!-- Header: status dot + address -->
      <div style="display:flex;align-items:center;gap:7px;margin-bottom:${tags ? "7px" : "9px"};">
        <div style="width:11px;height:11px;border-radius:50%;background:${pin.bg};border:2px solid ${pin.border};flex-shrink:0;"></div>
        <div style="min-width:0;flex:1;">
          <div style="font-weight:700;font-size:13px;line-height:1.15;color:#f1f5f9;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(lead.address)}</div>
          <div style="color:#94a3b8;font-size:10.5px;">${escapeHtml(lead.city)}, ${escapeHtml(lead.state)} ${escapeHtml(lead.zip)}</div>
        </div>
      </div>

      ${tags ? `<div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:9px;">${tags}</div>` : ""}

      <!-- Directions + Call -->
      <div style="display:flex;gap:6px;margin-bottom:8px;">
        <a href="${dirUrl}" target="_blank" rel="noopener"
          style="flex:1;text-align:center;background:#5eead41f;color:#5eead4;border-radius:7px;padding:7px;font-size:12px;font-weight:600;text-decoration:none;">🧭 Directions</a>
        ${phone ? `<a href="tel:${phone}"
          style="flex:1;text-align:center;background:#3b82f61f;color:#60a5fa;border-radius:7px;padding:7px;font-size:12px;font-weight:600;text-decoration:none;">📞 Call</a>` : ""}
      </div>

      ${canAssign ? `<div style="display:flex;gap:6px;margin-bottom:8px;">
        <select id="assign-rep-${lead.id}" style="flex:1;background:#1e2430;color:#e2e8f0;border:1px solid #334155;border-radius:6px;padding:5px;font-size:11px;">
          <option value="">— Unassigned —</option>${repOptions}
        </select>
        <button onclick="window.__assignRep(${lead.id})" style="background:#f97316;color:white;border:none;border-radius:6px;padding:0 11px;font-size:11px;font-weight:600;cursor:pointer;">Save</button>
      </div>` : ""}

      <!-- One-tap outcome buttons -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:5px;">
        ${OUTCOME_OPTIONS.map(o => `<button
          onclick="window.__knockLead(${lead.id}, '${o.val}', '${knockRep}')"
          style="background:${o.color}1f;color:${o.color};border:1px solid ${o.color}44;border-radius:7px;padding:9px 4px;font-size:12px;font-weight:700;cursor:pointer;"
          onmousedown="this.style.background='${o.color}40'" onmouseup="this.style.background='${o.color}1f'" ontouchstart="this.style.background='${o.color}40'" ontouchend="this.style.background='${o.color}1f'"
        >${o.label}</button>`).join("")}
      </div>
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

// Stable empty snapshot for useSyncExternalStore before the queue exists —
// a fresh object per call would loop the store subscription forever.
const EMPTY_QUEUE_SNAP: QueueSnapshot = { pendingCount: 0, deadCount: 0, byLead: {}, online: true };
const RESUME_TTL_MS = 12 * 3600_000; // one shift boundary
const GPS_FRESH_MS = 120_000;

export default function MapView() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const geolocateRef = useRef<any>(null);
  const leadPopupRef = useRef<any>(null); // only one lead card open at a time
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
  const [mapStyleMode, setMapStyleMode] = useState<"dark" | "satellite" | "streets">("satellite");
  const [showLeads, setShowLeads] = useState(true); // control-rail layer toggle
  // The style the map was actually created with. Prevents a redundant setStyle()
  // on first load (which would reload the whole style and blank the map).
  const appliedStyleRef = useRef<"dark" | "satellite" | "streets">("satellite");
  // Bumped after each style swap so lead pins + territories re-render onto the
  // fresh style (setStyle wipes all sources/layers).
  const [styleEpoch, setStyleEpoch] = useState(0);

  // Draw mode
  const [drawMode, setDrawMode] = useState(false);
  const [drawnBBox, setDrawnBBox] = useState<BBox | null>(null);
  // Deep-scan (Mapbox grid) cost preview for the drawn box
  const [areaEstimate, setAreaEstimate] = useState<{ gridPoints: number; estAddresses: number; estCostUsd: number; withinFreeTier: boolean; overCap: boolean } | null>(null);
  const drawingRef = useRef(false);
  const drawStartRef = useRef<any>(null);

  // Filter
  const [filterStatus, setFilterStatus] = useState<string>("all");
  // Visit filter — the field rep's primary lens: what's left to knock.
  const [visitFilter, setVisitFilter] = useState<"all" | "unvisited" | "visited">("all");

  // Selected lead (highlighted after a search fly-to)
  const [selectedLeadId, setSelectedLeadId] = useState<number | null>(null);
  const [geocoding, setGeocoding] = useState(false); // street "go to" lookup in flight
  const [sidebarSearch, setSidebarSearch] = useState("");

  // Colored territory regions visibility toggle (rendered from saved territories)
  const [showTerritories, setShowTerritories] = useState(true);

  // Assign-Area (freehand draw) mode
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
  const isRep = user?.role === "rep";
  const canManage = user?.role === "admin" || user?.role === "manager";
  // Admin, manager, and team lead can carve out areas and assign them to reps.
  const canAssign = user?.role === "admin" || user?.role === "manager" || user?.role === "team_lead";

  // ── Rep knocking workflow (bottom sheet + offline queue + next door) ────────
  // Reps always get the sheet; admins/managers get it on mobile (desktop keeps
  // the pin popup with its assign-rep dropdown).
  const isMobile = useIsMobile();
  const useSheet = isRep || isMobile;
  const [hudMini, setHudMini] = useState(false);
  // Outcome just logged this session, per lead — drives the sheet's "done" phase.
  const [lastSaved, setLastSaved] = useState<{ leadId: number; outcome: KnockOutcome } | null>(null);
  const [resumeTarget, setResumeTarget] = useState<{ leadId: number; address: string } | null>(null);
  const lastFixRef = useRef<{ lat: number; lng: number; at: number } | null>(null); // GPS cache — ref, zero renders per tick
  const lastKnockedRef = useRef<{ lat: number; lng: number } | null>(null);         // where the rep physically stands
  const recentIdsRef = useRef<number[]>([]);   // ring buffer (10) — just-knocked/skipped doors Next Door must not bounce back to
  const visibleLeadsRef = useRef<MapPin[]>([]); // the filtered pin set the map currently shows (written by the setData effect)

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

  // Assign Area: create a rep-colored territory AND assign the enclosed leads in
  // one atomic call. The drawn polygon comes straight from the freehand stroke.
  const assignAreaMutation = useMutation({
    mutationFn: async ({ polygon, repId }: { polygon: [number, number][]; repId: number }) => {
      const res = await apiRequest("POST", "/api/territories/assign-area", { polygon, repId });
      return res.json();
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["/api/territories"] });
      qc.invalidateQueries({ queryKey: ["/api/territories/progress"] });
      qc.invalidateQueries({ queryKey: ["/api/leads/map"] });
      qc.invalidateQueries({ queryKey: ["/api/leads"] });
      const repName = team.find((m: TeamMember) => m.id === data.territory?.repId)?.name ?? "rep";
      toast({ title: `✓ ${data.assigned} leads assigned to ${repName} · territory saved` });
      exitLasso();
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const deleteTerritoryMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("DELETE", `/api/territories/${id}`);
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/territories"] });
      qc.invalidateQueries({ queryKey: ["/api/territories/progress"] });
    },
  });

  // Territory selected by tapping its region on the map → detail panel
  const [selectedTerritoryId, setSelectedTerritoryId] = useState<number | null>(null);

  // Hand an unassigned/reclaimed area to the next rep (recolors + re-links leads)
  const assignTerritoryMutation = useMutation({
    mutationFn: async ({ id, repId }: { id: number; repId: number }) => {
      const res = await apiRequest("POST", `/api/territories/${id}/assign`, { repId });
      if (!res.ok) throw new Error((await res.json()).error || "Assign failed");
      return res.json();
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["/api/territories"] });
      qc.invalidateQueries({ queryKey: ["/api/territories/progress"] });
      qc.invalidateQueries({ queryKey: ["/api/leads/map"] });
      qc.invalidateQueries({ queryKey: ["/api/leads"] });
      const repName = team.find((m: TeamMember) => m.id === data.repId)?.name ?? "rep";
      toast({ title: `✓ Area assigned to ${repName} · ${data.assigned} leads linked` });
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  // Reclaim / pull-back an area with one of the 3 modes.
  const [reclaimMenuId, setReclaimMenuId] = useState<number | null>(null);
  const reclaimMutation = useMutation({
    mutationFn: async ({ id, mode, newRepId }: { id: number; mode: string; newRepId?: number }) => {
      const res = await apiRequest("POST", `/api/territories/${id}/reclaim`, { mode, newRepId });
      return res.json();
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["/api/territories"] });
      qc.invalidateQueries({ queryKey: ["/api/territories/progress"] });
      qc.invalidateQueries({ queryKey: ["/api/leads/map"] });
      qc.invalidateQueries({ queryKey: ["/api/leads"] });
      setReclaimMenuId(null);
      const label = data.mode === "return_to_pool" ? `${data.leadsAffected} leads returned to pool`
        : data.mode === "reassign" ? `reassigned (${data.leadsAffected} leads)` : "area reclaimed";
      toast({ title: `✓ Area reclaimed — ${label}` });
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  // Single exit path for the lasso — clears mode, selection, and map layers.
  // Every button/mutation that leaves lasso mode goes through this so no shape
  // or state is ever left behind.
  const exitLasso = useCallback(() => {
    setLassoMode(false);
    setLassoPoints([]);
    setLassoSelected([]);
    setLassoRepId("");
    const map = mapRef.current;
    if (map) {
      try {
        if (map.getLayer("lasso-fill")) map.removeLayer("lasso-fill");
        if (map.getLayer("lasso-outline")) map.removeLayer("lasso-outline");
        if (map.getSource("lasso-polygon")) map.removeSource("lasso-polygon");
      } catch {}
      lassoLayerRef.current = false;
    }
  }, []);

  // ── Bulk assign mutation (lasso) ────────────────────────────────────────
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
  useEffect(() => {
    (window as any).__onTerritoryClick = (tid: number | null) => setSelectedTerritoryId(tid);
    return () => { delete (window as any).__onTerritoryClick; };
  }, []);
  // Map→React bridge for the knock sheet (same pattern as __onTerritoryClick).
  // The pin click handler is bound once at map init; it checks this global at
  // call time, so sheet-vs-popup routing follows role/viewport without rebinds.
  useEffect(() => {
    if (!useSheet) return;
    (window as any).__openLeadSheet = (id: number) => setSelectedLeadId(id);
    return () => { delete (window as any).__openLeadSheet; };
  }, [useSheet]);
  useEffect(() => {
    (window as any).__closeLeadSheet = () => setSelectedLeadId(null);
    return () => { delete (window as any).__closeLeadSheet; };
  }, []);
  // Reps default to ALL pins — a knocked door must never vanish from the map;
  // it stays visible in its new state (recolored + ✓) so coverage always reads.
  // "Left"/"Done"/"Follow-ups"/"Sold" are opt-in lenses via the filter chips.

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
    (window as any).__knockLead = async (leadId: number, outcome: string, presetRep?: string) => {
      // Resolve who the knock is credited to, in priority order:
      //   1. the rep dropdown (managers/team leads), if present + chosen
      //   2. presetRep passed from the button (reps → their own id)
      //   3. the current user's own teamMemberId (rep logging their own knock)
      const dropdown = (document.getElementById(`assign-rep-${leadId}`) as HTMLSelectElement)?.value;
      const repId = dropdown || presetRep || (user?.teamMemberId ? String(user.teamMemberId) : "");
      if (!repId) {
        toast({ title: "Assign a rep to this lead first, then log the knock", variant: "destructive" });
        return;
      }
      // Optimistic: recolor the pin + mark it visited (✓) INSTANTLY, before the
      // network round-trip — so marking a door feels immediate in the field.
      const outcomeToStatus: Record<string, string> = {
        sold: "sold", interested: "interested", callback: "follow_up",
        not_interested: "not_interested", not_home: "prospect",
      };
      qc.setQueryData(["/api/leads/map"], (old: any) => {
        if (!old?.pins) return old;
        return { ...old, pins: old.pins.map((p: MapPin) => p.id === leadId
          ? { ...p, leadStatus: outcomeToStatus[outcome] ?? p.leadStatus, visited: true, knockCount: (p.knockCount ?? 0) + 1, lastOutcome: outcome, lastKnockedAt: new Date().toISOString() }
          : p) };
      });
      popupsRef.current.get(leadId)?.remove();
      try {
        const wasHome = outcome !== "not_home";
        await apiRequest("POST", `/api/leads/${leadId}/knock`, {
          repId: Number(repId),
          wasHome,
          outcome,
          knockedAt: new Date().toISOString(),
        });
        toast({ title: outcome === "sold" ? "🎉 Sale logged!" : `✓ Marked: ${outcome.replace("_", " ")}` });
        qc.invalidateQueries({ queryKey: ["/api/leaderboard"] });
        qc.invalidateQueries({ queryKey: ["/api/leads"] });
      } catch (e: any) {
        toast({ title: "Couldn't save — reverting", variant: "destructive" });
        qc.invalidateQueries({ queryKey: ["/api/leads/map"] }); // roll back to server truth
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
  }, [toast, qc, user]);

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
    if (import.meta.env.DEV) {
      (window as any).__map = map; // debug handle (dev only)
      (window as any).__buildPopupHTML = buildPopupHTML;
    }

    // Force resize once container is definitely painted
    setTimeout(() => map.resize(), 100);
    setTimeout(() => map.resize(), 400);

    map.addControl(new (window as any).mapboxgl.NavigationControl(), "top-right");
    // "Locate me" — the core field control: center on the rep's position and
    // track it as they walk the street. Triggered by the big thumb FAB below.
    const geolocate = new (window as any).mapboxgl.GeolocateControl({
      positionOptions: { enableHighAccuracy: true },
      trackUserLocation: true,
      showUserHeading: true,
    });
    map.addControl(geolocate, "top-right");
    geolocateRef.current = geolocate;
    // Cache the last GPS fix in a ref — Next Door reads it, and a ~1/s tick must
    // cause zero React renders. Permission denied just never populates it.
    geolocate.on("geolocate", (e: any) => {
      try { lastFixRef.current = { lat: e.coords.latitude, lng: e.coords.longitude, at: Date.now() }; } catch {}
    });

    const setupMapLayers = () => {
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

      // True while any draw tool is armed — cluster zoom / popups / hover-cursor
      // must all stand down so they can't yank the map or fight the crosshair
      // mid-draw.
      const drawToolActive = () =>
        (window as any).__lassoActive || (window as any).__territoryDrawActive || (window as any).__drawModeActive;

      // Click cluster → zoom in
      map.on("click", "lead-clusters", (e: any) => {
        if (drawToolActive()) return;
        const features = map.queryRenderedFeatures(e.point, { layers: ["lead-clusters"] });
        const clusterId = features[0]?.properties?.cluster_id;
        if (!clusterId) return;
        (map.getSource("leads-cluster") as any).getClusterExpansionZoom(clusterId, (err: any, zoom: number) => {
          if (err) return;
          map.easeTo({ center: features[0].geometry.coordinates, zoom: zoom + 1 });
        });
      });

      const hoverCursor = (c: string) => { if (!drawToolActive()) map.getCanvas().style.cursor = c; };
      map.on("mouseenter", "lead-clusters", () => hoverCursor("pointer"));
      map.on("mouseleave", "lead-clusters", () => hoverCursor(""));
      map.on("mouseenter", "lead-clusters-glow", () => hoverCursor("pointer"));
      map.on("mouseleave", "lead-clusters-glow", () => hoverCursor(""));

      // ── Individual lead pins (GPU circle layer) — shown when zoomed in past clusterMaxZoom ──
      // Painted by displayState (`ds` prop): shared consts in @/lib/mapPins keep
      // this block and the style.load re-add block from ever drifting again.
      map.addLayer({
        id: "lead-unclustered",
        type: "circle",
        source: "leads-cluster",
        filter: ["!", ["has", "point_count"]],
        minzoom: 12,
        paint: UNCLUSTERED_PAINT,
      });

      // Visited ✓ badge — any pin that's been knocked (even "Not Home") shows a
      // check above it, so reps instantly see which doors they've already hit.
      map.addLayer({
        id: "lead-visited-check", type: "symbol", source: "leads-cluster",
        filter: ["all", ["!", ["has", "point_count"]], ["==", ["get", "visited"], 1]],
        minzoom: 12,
        layout: { "text-field": "✓", "text-font": ["Arial Unicode MS Regular"], "text-size": 12, "text-offset": [0, -1.15], "text-allow-overlap": true, "text-ignore-placement": true },
        paint: { "text-color": "#ffffff", "text-halo-color": "#0f172a", "text-halo-width": 1.5 },
      });

      // Glow ring for unclustered pins — inserted BENEATH the pin layer so the
      // 0.18-alpha halo never washes over the pin or its ✓ (matches the
      // style-reload block's order).
      map.addLayer({
        id: "lead-unclustered-glow",
        type: "circle",
        source: "leads-cluster",
        filter: ["!", ["has", "point_count"]],
        minzoom: 12,
        paint: UNCLUSTERED_GLOW_PAINT,
      }, "lead-unclustered");

      // Selected-pin ring — driven by setFilter (style-thread only, no setData).
      // Added last so it can never be occluded by pins/✓/glow.
      map.addLayer(SELECTED_RING_SPEC);

      // Click unclustered pin → show popup
      map.on("click", "lead-unclustered", (e: any) => {
        // No popups while a draw tool is active — a lasso stroke over a pin
        // must not open a card mid-draw.
        if ((window as any).__lassoActive || (window as any).__territoryDrawActive || (window as any).__drawModeActive) return;
        const props = e.features?.[0]?.properties;
        const coords = e.features?.[0]?.geometry?.coordinates?.slice() as [number, number];
        if (!props || !coords) return;
        const lead = (window as any).__allLeads?.find((l: any) => l.id === props.id);
        if (!lead) return;
        // Rep/mobile path: open the bottom knock sheet instead of the HTML popup.
        // Checked at call time so role/viewport changes never need a rebind.
        const openSheet = (window as any).__openLeadSheet;
        if (openSheet) { openSheet(props.id); return; }
        const tm = (window as any).__teamMembers ?? [];
        while (Math.abs(e.lngLat.lng - coords[0]) > 180) { coords[0] += e.lngLat.lng > coords[0] ? 360 : -360; }
        leadPopupRef.current?.remove();
        leadPopupRef.current = new (window as any).mapboxgl.Popup({ offset: 14, className: "sr-popup", closeButton: true })
          .setLngLat(coords)
          .setHTML(buildPopupHTML(lead, tm, { canAssign, currentRepId: user?.teamMemberId ?? null }))
          .addTo(map);
      });
      map.on("mouseenter", "lead-unclustered", () => hoverCursor("pointer"));
      map.on("mouseleave", "lead-unclustered", () => hoverCursor(""));

      // Tap a territory region → open its detail panel. Lead pins win over the
      // region beneath them; draw tools suppress it entirely.
      map.on("click", (e: any) => {
        if (drawToolActive()) return;
        const feats = map.queryRenderedFeatures(e.point);
        if (feats.some((f: any) => f.layer?.id === "lead-unclustered" || f.layer?.id === "lead-clusters")) return;
        // Fat-finger forgiveness: pins are 16px dots — before treating this as an
        // empty-map tap, look for a pin within a ±12px box. A near-miss opens the
        // door the rep aimed at instead of dismissing their sheet mid-flow.
        const openSheet = (window as any).__openLeadSheet;
        if (openSheet) {
          try {
            const near = map.queryRenderedFeatures(
              [[e.point.x - 12, e.point.y - 12], [e.point.x + 12, e.point.y + 12]],
              { layers: ["lead-unclustered"] },
            );
            if (near.length) { openSheet(near[0].properties.id); return; }
          } catch { /* layer not ready */ }
        }
        // Tapping empty map dismisses the knock sheet (its map stays interactive).
        (window as any).__closeLeadSheet?.();
        const terr = feats.find((f: any) => typeof f.layer?.id === "string" && /^territory-\d+$/.test(f.layer.id));
        const cb = (window as any).__onTerritoryClick;
        if (terr && cb) cb(Number(terr.layer.id.replace("territory-", "")));
        else if (cb) cb(null); // click on empty map closes the panel
      });

      mapRef.current = map;
      setMapReady(true);
      // Always re-trigger the lead-pin + territory data effects. setMapReady(true)
      // is a no-op re-render if a previous map instance (HMR / re-init) already
      // set it — the fresh source would then stay empty and no pins would show.
      setStyleEpoch(e => e + 1);
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
    }).setHTML(buildPopupHTML(lead, allTeam, { canAssign, currentRepId: user?.teamMemberId ?? null }));

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

    // Rep filter (admin/manager/team lead) — narrows the map pins, not just the list
    if (canAssign && filterRep !== "all") {
      leadsToShow = leadsToShow.filter(l =>
        filterRep === "unassigned" ? !l.assignedRepId : l.assignedRepId === Number(filterRep)
      );
    }

    if (filterStatus !== "all") leadsToShow = leadsToShow.filter(l => l.leadStatus === filterStatus);
    // Visit filter — "what's left to knock". Session-knocked doors (ring buffer)
    // are exempt from the unvisited lens: the pin the rep JUST marked must not
    // vanish from under their finger mid-sheet — it fades out on the next
    // re-filter instead. (Ref read, so the dep array stays selection-free.)
    if (visitFilter === "unvisited") leadsToShow = leadsToShow.filter(l => !l.visited || recentIdsRef.current.includes(l.id));
    else if (visitFilter === "visited") leadsToShow = leadsToShow.filter(l => l.visited);
    const visibleLeads = leadsToShow;
    visibleLeadsRef.current = visibleLeads; // Next Door candidates = what the rep can see

    // GPU-rendered circle layer — no DOM markers, handles 100k+ points.
    // `ds` = precomputed display state so circle-color stays a flat GPU match.
    src.setData({
      type: "FeatureCollection",
      features: visibleLeads
        .filter(l => l.lat && l.lng)
        .map(l => ({
          type: "Feature",
          geometry: { type: "Point", coordinates: [l.lng, l.lat] },
          properties: { id: l.id, status: l.leadStatus, address: l.address, visited: l.visited ? 1 : 0, ds: pinDisplayState(l) },
        })),
    });
    // NOTE: this dep array must NEVER gain selection/sheet state — a pin tap must
    // rebuild zero GeoJSON. Selection is a setFilter on its own effect below.
  }, [leads, team, mapReady, filterStatus, filterRep, visitFilter, canAssign, territories, isAdmin, user, styleEpoch]);

  // ── Selected-pin ring — pure style-thread update, no setData, no re-cluster ──
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    try { map.setFilter("lead-selected-ring", SELECTED_RING_FILTER(selectedLeadId)); } catch {}
  }, [selectedLeadId, mapReady, styleEpoch]); // styleEpoch: re-apply after style switch

  // ── Auto-fit to leads once on first load (Sales Rabbit density view) ──────────
  // Centers/zooms the map so pins are visible the moment you open it. Runs once,
  // so it never yanks the view around while you're scanning or panning.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || didAutoFitRef.current) return;
    const pts = leads.filter(l => l.lat && l.lng);
    if (pts.length === 0) return;
    // Resume-where-you-left-off: a rep returning within a shift gets their last
    // camera back (silent jumpTo) instead of the generic fit-all view.
    if (isRep && user?.teamMemberId != null) {
      try {
        const raw = localStorage.getItem(`hf.repResume.v1.${user.teamMemberId}`);
        if (raw) {
          const r = JSON.parse(raw);
          if (r?.camera && r?.at && Date.now() - Date.parse(r.at) < RESUME_TTL_MS) {
            map.jumpTo({ center: [r.camera.lng, r.camera.lat], zoom: r.camera.zoom });
            didAutoFitRef.current = true;
            return;
          }
        }
      } catch { /* storage blocked — fall through to fit-all */ }
    }
    try {
      const b = new (window as any).mapboxgl.LngLatBounds();
      pts.forEach(l => b.extend([l.lng!, l.lat!]));
      map.fitBounds(b, { padding: 60, maxZoom: 15, duration: 0 });
      didAutoFitRef.current = true;
    } catch {}
  }, [leads, mapReady, isRep, user]);

  // ── Render color-coded territory regions (per-rep color + name label) ──────
  // Each saved territory fills with its rep's stable color, a matching outline,
  // and a centered pill "<Rep>  knocked/total" so the team sees who owns what.
  // Only shown to admin/manager/team-lead (canAssign); reps get a clean map.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    // Remove old territory layers/sources (fill, outline, label + its source)
    territoryLayersRef.current.forEach(id => {
      try { if (map.getLayer(id)) map.removeLayer(id); } catch {}
      try { if (map.getLayer(id + "-outline")) map.removeLayer(id + "-outline"); } catch {}
      try { if (map.getLayer(id + "-label")) map.removeLayer(id + "-label"); } catch {}
      try { if (map.getSource(id)) map.removeSource(id); } catch {}
      try { if (map.getSource(id + "-label-src")) map.removeSource(id + "-label-src"); } catch {}
    });
    territoryLayersRef.current = [];

    if (!showTerritories || !canAssign) return;

    territories.forEach(t => {
      try {
        const status = (t as any).status ?? "active";
        if (status === "archived") return; // archived areas never render
        const coords = JSON.parse(t.polygon) as [number, number][];
        if (coords.length < 3) return;
        const closed = [...coords, coords[0]];
        // Status-aware styling: reclaimed/unassigned areas go GRAY and lose the
        // rep's name; completed areas keep the rep color but muted with a ✓.
        const isPool = status === "unassigned" || status === "reclaimed";
        const isDone = status === "completed";
        const color = isPool ? "#94a3b8" : colorForRep(t.repId);
        const fillOpacity = isPool ? 0.10 : isDone ? 0.08 : 0.14;
        const srcId = `territory-${t.id}`;
        if (!map.getSource(srcId)) {
          map.addSource(srcId, {
            type: "geojson",
            data: { type: "Feature", geometry: { type: "Polygon", coordinates: [closed] }, properties: { tid: t.id } }
          });
        }
        if (!map.getLayer(srcId)) {
          map.addLayer({ id: srcId, type: "fill", source: srcId,
            paint: { "fill-color": color, "fill-opacity": fillOpacity } });
        }
        if (!map.getLayer(srcId + "-outline")) {
          map.addLayer({ id: srcId + "-outline", type: "line", source: srcId,
            paint: { "line-color": color, "line-width": isPool ? 2 : 2.5, "line-opacity": isPool ? 0.7 : 0.9,
              ...(isPool ? { "line-dasharray": [3, 2] } : {}) } });
        }
        // Centroid label — rep name + progress while owned; "Unassigned" once
        // reclaimed (the old rep's name must NOT linger on the area).
        const cx = coords.reduce((s, p) => s + p[0], 0) / coords.length;
        const cy = coords.reduce((s, p) => s + p[1], 0) / coords.length;
        const prog = territoryProgress.find(p => p.id === t.id);
        const repName = team.find(m => m.id === t.repId)?.name?.split(" ")[0] ?? "";
        const label = isPool ? "Unassigned"
          : isDone ? `✓ ${repName}`
          : (prog ? `${repName}  ${prog.knocked}/${prog.total}` : repName);
        if (label && !map.getSource(srcId + "-label-src")) {
          map.addSource(srcId + "-label-src", {
            type: "geojson", data: { type: "Feature", geometry: { type: "Point", coordinates: [cx, cy] }, properties: {} }
          });
          map.addLayer({
            id: srcId + "-label", type: "symbol", source: srcId + "-label-src",
            layout: { "text-field": label, "text-size": 12, "text-font": ["DIN Offc Pro Medium", "Arial Unicode MS Bold"], "text-allow-overlap": false },
            paint: { "text-color": "#ffffff", "text-halo-color": isPool ? "#475569" : color, "text-halo-width": 2 },
          });
        }
        territoryLayersRef.current.push(srcId);
      } catch {}
    });
  }, [territories, territoryProgress, team, mapReady, showTerritories, canAssign, styleEpoch]);

  // ── Lead-layer visibility (control-rail toggle) ─────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const vis = showLeads ? "visible" : "none";
    for (const id of ["lead-clusters", "lead-clusters-glow", "lead-cluster-count", "lead-unclustered", "lead-unclustered-glow", "lead-visited-check"]) {
      try { if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", vis); } catch {}
    }
  }, [showLeads, mapReady, styleEpoch]);

  // ── Map style toggle ───────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    // Skip the redundant reload on initial load — the map is already showing this
    // style. Only re-style when the user actually toggles satellite ↔ street.
    if (appliedStyleRef.current === mapStyleMode) return;
    appliedStyleRef.current = mapStyleMode;
    const STYLE = mapStyleMode === "satellite"
      ? "mapbox://styles/mapbox/satellite-streets-v12"   // hybrid
      : mapStyleMode === "streets"
      ? "mapbox://styles/mapbox/streets-v12"             // street
      : "mapbox://styles/mapbox/dark-v11";              // dark
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
        // Unclustered individual pins — same shared paint consts as init, so the
        // two blocks can never drift again.
        map.addLayer({ id: "lead-unclustered-glow", type: "circle", source: "leads-cluster",
          filter: ["!", ["has", "point_count"]], minzoom: 12,
          paint: UNCLUSTERED_GLOW_PAINT,
        });
        map.addLayer({ id: "lead-unclustered", type: "circle", source: "leads-cluster",
          filter: ["!", ["has", "point_count"]], minzoom: 12,
          paint: UNCLUSTERED_PAINT,
        });
        map.addLayer({ id: "lead-visited-check", type: "symbol", source: "leads-cluster",
          filter: ["all", ["!", ["has","point_count"]], ["==", ["get","visited"], 1]], minzoom: 12,
          layout: { "text-field": "✓", "text-font": ["Arial Unicode MS Regular"], "text-size": 12, "text-offset": [0, -1.15], "text-allow-overlap": true, "text-ignore-placement": true },
          paint: { "text-color": "#ffffff", "text-halo-color": "#0f172a", "text-halo-width": 1.5 },
        });
        // Selected-pin ring — its filter is re-applied by the selection effect
        // (styleEpoch dep) right after this block bumps the epoch.
        map.addLayer(SELECTED_RING_SPEC);
        // NOTE: no map.on(...) here — layer-scoped click/hover handlers bound at
        // init SURVIVE setStyle (they live on the Map, not the style). Re-binding
        // them here stacked a duplicate handler per style toggle (N popups per
        // pin click after N toggles).
      }
      // setStyle also wiped the draw-bbox + lasso sources — re-add / reset so
      // Scan-Area and Lasso keep working after a satellite/street toggle.
      if (!map.getSource("draw-bbox")) {
        map.addSource("draw-bbox", {
          type: "geojson",
          data: { type: "Feature", geometry: { type: "Polygon", coordinates: [[]] }, properties: {} }
        });
        map.addLayer({ id: "draw-bbox-fill", type: "fill", source: "draw-bbox",
          paint: { "fill-color": "#f97316", "fill-opacity": 0.1 } });
        map.addLayer({ id: "draw-bbox-outline", type: "line", source: "draw-bbox",
          paint: { "line-color": "#f97316", "line-width": 2, "line-dasharray": [3, 2] } });
      }
      lassoLayerRef.current = false;
      lastRenderedCount.current = 0;
      // Re-trigger the lead-pin setData + territory render effects — the new
      // style starts with an empty source, so without this the pins vanish.
      setStyleEpoch(e => e + 1);
    });
    map.setStyle(STYLE);
  }, [mapStyleMode, mapReady]);

  // ── Assign-Area (freehand) — SalesRabbit-style draw → assign → colored region ─
  // Press and DRAG to draw a loop around leads; release to select. Map panning
  // is fully suspended while armed (no more grab-hand fighting the draw), and
  // drawing again replaces the previous selection. Works with mouse and touch.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const clearPreview = () => {
      try {
        if (map.getLayer("lasso-fill")) map.removeLayer("lasso-fill");
        if (map.getLayer("lasso-outline")) map.removeLayer("lasso-outline");
        if (map.getSource("lasso-polygon")) map.removeSource("lasso-polygon");
      } catch {}
      lassoLayerRef.current = false;
    };

    if (!lassoMode) {
      clearPreview(); // never leave a stale lasso shape under another tool
      try { map.getCanvas().style.cursor = ""; } catch {}
      return;
    }

    // Arm the tool: suspend every gesture that would move the map mid-draw.
    (window as any).__lassoActive = true; // suppresses pin popups while armed
    try {
      map.getCanvas().style.cursor = "crosshair";
      map.dragPan.disable();
      map.doubleClickZoom.disable();
      map.touchZoomRotate.disable();
      map.touchPitch?.disable();
    } catch {}

    function ptInPoly(lat: number, lng: number, poly: [number, number][]): boolean {
      let inside = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i], [xj, yj] = poly[j];
        if (((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
      }
      return inside;
    }

    // Stroke state lives in refs — zero React re-renders while the finger moves.
    let stroke: [number, number][] = [];        // [lng, lat]
    let lastPx: { x: number; y: number } | null = null;
    let drawing = false;
    const MIN_PX_DIST = 5;   // thin points: capture every ~5px of movement
    const MAX_POINTS = 800;

    const render = (closeRing: boolean) => {
      if (stroke.length < 2) return;
      // While dragging: a smooth OPEN line that grows with the finger (never a
      // flat filled sliver — that was the "starts with a flat line" bug). Only on
      // release do we close it into a filled polygon.
      const geojson = (closeRing && stroke.length >= 3)
        ? { type: "Feature" as const, geometry: { type: "Polygon" as const, coordinates: [[...stroke, stroke[0]]] }, properties: {} }
        : { type: "Feature" as const, geometry: { type: "LineString" as const, coordinates: stroke }, properties: {} };
      if (!lassoLayerRef.current) {
        try {
          map.addSource("lasso-polygon", { type: "geojson", data: geojson });
          map.addLayer({ id: "lasso-fill", type: "fill", source: "lasso-polygon",
            paint: { "fill-color": "#2dd4bf", "fill-opacity": 0.14 } });
          map.addLayer({ id: "lasso-outline", type: "line", source: "lasso-polygon",
            paint: { "line-color": "#5eead4", "line-width": 3, "line-cap": "round", "line-join": "round" } });
          lassoLayerRef.current = true;
        } catch {}
      } else {
        try { (map.getSource("lasso-polygon") as any).setData(geojson); } catch {}
      }
    };

    const start = (lngLat: any, point: any) => {
      drawing = true;
      stroke = [[lngLat.lng, lngLat.lat]];
      lastPx = { x: point.x, y: point.y };
      // A new stroke replaces the previous selection
      setLassoSelected([]); setLassoPoints([]);
      clearPreview();
    };

    const move = (lngLat: any, point: any) => {
      if (!drawing || stroke.length >= MAX_POINTS || !lastPx) return;
      const dx = point.x - lastPx.x, dy = point.y - lastPx.y;
      if (dx * dx + dy * dy < MIN_PX_DIST * MIN_PX_DIST) return;
      lastPx = { x: point.x, y: point.y };
      stroke.push([lngLat.lng, lngLat.lat]);
      render(false);
    };

    const finish = () => {
      if (!drawing) return;
      drawing = false;
      // Too small to be a deliberate loop → treat as accidental tap, clear.
      if (stroke.length < 8) { stroke = []; clearPreview(); return; }
      render(true);
      const allLeads: MapPin[] = (window as any).__allLeads ?? [];
      const selected = allLeads.filter(l => l.lat && l.lng && ptInPoly(l.lat, l.lng, stroke));
      setLassoPoints(stroke);
      setLassoSelected(selected);
    };

    const cancelStroke = () => { drawing = false; stroke = []; clearPreview(); };

    // Mouse
    const onMouseDown = (e: any) => start(e.lngLat, e.point);
    const onMouseMove = (e: any) => move(e.lngLat, e.point);
    const onMouseUp = () => finish();
    // Touch — single finger draws; a second finger cancels the stroke.
    const onTouchStart = (e: any) => {
      if (e.points && e.points.length > 1) { cancelStroke(); return; }
      start(e.lngLat, e.point);
    };
    const onTouchMove = (e: any) => {
      if (e.points && e.points.length > 1) { cancelStroke(); return; }
      move(e.lngLat, e.point);
    };
    const onTouchEnd = () => finish();

    map.on("mousedown", onMouseDown); map.on("mousemove", onMouseMove); map.on("mouseup", onMouseUp);
    map.on("touchstart", onTouchStart); map.on("touchmove", onTouchMove); map.on("touchend", onTouchEnd);

    return () => {
      (window as any).__lassoActive = false;
      // Defensive: on unmount the map may already be removed (getCanvas → undefined)
      try {
        map.off("mousedown", onMouseDown); map.off("mousemove", onMouseMove); map.off("mouseup", onMouseUp);
        map.off("touchstart", onTouchStart); map.off("touchmove", onTouchMove); map.off("touchend", onTouchEnd);
      } catch {}
      try {
        map.getCanvas().style.cursor = "";
        map.dragPan.enable();
        map.doubleClickZoom.enable();
        map.touchZoomRotate.enable();
        map.touchPitch?.enable();
      } catch {}
    };
    // styleEpoch: rebind after a style swap / map re-init (setStyle wipes the
    // lasso source; a re-created map instance needs fresh handlers)
  }, [lassoMode, mapReady, styleEpoch]);

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
    // Fresh session: clear any stale drag state from a mode toggled off mid-drag
    drawingRef.current = false;
    drawStartRef.current = null;
    (window as any).__drawModeActive = true;
    try { map.getCanvas().style.cursor = "crosshair"; map.dragPan.disable(); map.touchZoomRotate.disable(); } catch {}

    let startPx: { x: number; y: number } | null = null;

    const down = (lngLat: any, point: any) => { drawingRef.current = true; drawStartRef.current = lngLat; startPx = { x: point.x, y: point.y }; };
    const moveTo = (lngLat: any) => {
      if (!drawingRef.current || !drawStartRef.current) return;
      const s = drawStartRef.current, c = lngLat;
      updateDrawLayer({ minLng: Math.min(s.lng, c.lng), maxLng: Math.max(s.lng, c.lng), minLat: Math.min(s.lat, c.lat), maxLat: Math.max(s.lat, c.lat) });
    };
    const up = (lngLat: any, point: any) => {
      if (!drawingRef.current || !drawStartRef.current) return;
      drawingRef.current = false;
      // A stray tap (<6px drag) is not a box — ignore instead of committing a
      // degenerate zero-area bbox and bouncing the user out of the mode.
      if (startPx && Math.hypot(point.x - startPx.x, point.y - startPx.y) < 6) {
        drawStartRef.current = null; clearDrawLayer(); return;
      }
      const s = drawStartRef.current, c = lngLat;
      setDrawnBBox({ minLng: Math.min(s.lng, c.lng), maxLng: Math.max(s.lng, c.lng), minLat: Math.min(s.lat, c.lat), maxLat: Math.max(s.lat, c.lat) });
      drawStartRef.current = null;
      setDrawMode(false);
      try { map.getCanvas().style.cursor = ""; map.dragPan.enable(); map.touchZoomRotate.enable(); } catch {}
    };

    // Mouse + touch (single finger draws the box; multi-touch ignored)
    const onDown = (e: any) => down(e.lngLat, e.point);
    const onMove = (e: any) => moveTo(e.lngLat);
    const onUp = (e: any) => up(e.lngLat, e.point);
    const onTDown = (e: any) => { if (e.points && e.points.length > 1) return; down(e.lngLat, e.point); };
    const onTMove = (e: any) => { if (e.points && e.points.length > 1) return; moveTo(e.lngLat); };
    const onTUp = (e: any) => up(e.lngLat, e.point);

    map.on("mousedown", onDown); map.on("mousemove", onMove); map.on("mouseup", onUp);
    map.on("touchstart", onTDown); map.on("touchmove", onTMove); map.on("touchend", onTUp);
    return () => {
      (window as any).__drawModeActive = false;
      drawingRef.current = false;
      drawStartRef.current = null;
      // Defensive: on unmount the map may already be removed (getCanvas → undefined)
      try {
        map.off("mousedown", onDown); map.off("mousemove", onMove); map.off("mouseup", onUp);
        map.off("touchstart", onTDown); map.off("touchmove", onTMove); map.off("touchend", onTUp);
      } catch {}
      try { map.getCanvas().style.cursor = ""; map.dragPan.enable(); map.touchZoomRotate.enable(); } catch {}
    };
  }, [drawMode, mapReady, updateDrawLayer, clearDrawLayer, styleEpoch]);

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
        if (!r.lat || !r.lng) continue;
        if (bbox && !inBBox(r.lat, r.lng, bbox)) continue;
        // Only surface NEW FIBER with no current subscriber — the green hot-lead
        // pins. Everything else (tenured, copper, coming soon, upgrades) is skipped.
        if (!(r.isNewFiber && r.billingStatus === "N")) continue;
        addScanDot(r);
        found++;
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

  // When a box is drawn, fetch the deep-scan cost preview (grid points → $).
  useEffect(() => {
    if (!drawnBBox || !isAdmin) { setAreaEstimate(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const res = await apiRequest("POST", "/api/scan/area-estimate", {
          minLat: drawnBBox.minLat, maxLat: drawnBBox.maxLat, minLng: drawnBBox.minLng, maxLng: drawnBBox.maxLng,
        });
        const data = await res.json();
        if (!cancelled) setAreaEstimate(data);
      } catch { if (!cancelled) setAreaEstimate(null); }
    })();
    return () => { cancelled = true; };
  }, [drawnBBox, isAdmin]);

  // ── Legend items ──────────────────────────────────────────────────────────
  // ── Fly to lead on map ────────────────────────────────────────────────────
  // Geocode an arbitrary street the user typed (admin only) and jump the map
  // there so they can draw a cut-out box + scan. Costs 1 Mapbox geocode call.
  const jumpToAddress = useCallback(async (q: string) => {
    const query = q.trim();
    if (!query || geocoding) return;
    setGeocoding(true);
    try {
      const res = await apiRequest("GET", `/api/geocode?q=${encodeURIComponent(query)}`);
      const data = await res.json();
      if (!res.ok || data.lng == null) { toast({ title: data.error || "Address not found", variant: "destructive" }); return; }
      const map = mapRef.current;
      if (map) {
        map.flyTo({ center: [data.lng, data.lat], zoom: 16, duration: 900, essential: true });
        setTimeout(() => {
          const m = mapRef.current;
          if (m && (Math.abs(m.getCenter().lng - data.lng) > 0.001)) m.jumpTo({ center: [data.lng, data.lat], zoom: 16 });
        }, 950);
      }
      setSidebarSearch("");
      toast({ title: `Jumped to ${data.placeName}`, description: isAdmin ? "Draw a Scan-Area box here, then scan for new fiber." : undefined });
    } catch (e: any) {
      toast({ title: "Address lookup failed", variant: "destructive" });
    } finally {
      setGeocoding(false);
    }
  }, [geocoding, toast, isAdmin]);

  const flyToLead = useCallback((lead: MapPin) => {
    const map = mapRef.current;
    if (!map || !lead.lat || !lead.lng) return;
    const target: [number, number] = [lead.lng, lead.lat];
    setSelectedLeadId(lead.id);
    // Sheet path (reps / mobile): camera padding keeps the pin visible above the
    // peek sheet; the sheet itself opens via selectedLeadId — no popup.
    if (useSheet) {
      moveCamera(map, {
        center: target, zoom: Math.max(map.getZoom?.() ?? 16, 16.5),
        padding: { top: 0, left: 0, right: 0, bottom: sheetPeekPaddingPx() },
        duration: 600, essential: true,
      });
      return;
    }
    map.flyTo({ center: target, zoom: 17, duration: 900, essential: true });
    setTimeout(() => {
      if (!mapRef.current) return;
      const m = mapRef.current;
      // Fallback: if the animation was dropped (background tab, reduced motion),
      // snap to the target so the pin always ends up centered.
      const c = m.getCenter();
      if (Math.abs(c.lng - target[0]) > 0.0006 || Math.abs(c.lat - target[1]) > 0.0006) {
        m.jumpTo({ center: target, zoom: 17 });
      }
      const tm = (window as any).__teamMembers ?? [];
      leadPopupRef.current?.remove();
      leadPopupRef.current = new (window as any).mapboxgl.Popup({ offset: 14, className: "sr-popup", closeButton: true })
        .setLngLat(target)
        .setHTML(buildPopupHTML(lead, tm, { canAssign, currentRepId: user?.teamMemberId ?? null }))
        .addTo(m);
    }, 950);
  }, [canAssign, user, useSheet]);

  // Memoized so these full-array passes over all leads don't re-run on every
  // render (the map re-renders ~every 400ms during a scan).
  const statusCounts = useMemo(() => {
    const acc: Record<string, number> = {};
    for (const s of Object.keys(PIN_COLORS)) acc[s] = 0;
    for (const l of leads) if (acc[l.leadStatus] !== undefined) acc[l.leadStatus]++;
    return acc;
  }, [leads]);

  const newFiberCount = useMemo(
    () => leads.reduce((n, l) => n + (l.fiberStatus === "new_fiber" ? 1 : 0), 0),
    [leads],
  );
  const assignedCount = useMemo(
    () => leads.reduce((n, l) => n + (l.assignedRepId ? 1 : 0), 0),
    [leads],
  );
  const visitedCount = useMemo(() => leads.reduce((n, l) => n + (l.visited ? 1 : 0), 0), [leads]);
  const doorsLeft = leads.length - visitedCount;

  // On-map search — top matches for the search box dropdown (address or city).
  const searchMatches = useMemo(() => {
    const q = sidebarSearch.trim().toLowerCase();
    if (!q) return [];
    return leads
      .filter(l => l.lat && l.lng && (l.address.toLowerCase().includes(q) || (l.city ?? "").toLowerCase().includes(q)))
      .sort((a, b) => (b.leadScore ?? 0) - (a.leadScore ?? 0))
      .slice(0, 8);
  }, [leads, sidebarSearch]);

  // ── Knock queue — offline-first saves, idempotent via clientId ──────────────
  // Module-level singleton per rep: it keeps flushing queued knocks even if the
  // rep navigates away from the map, so we never destroy() it on unmount.
  const knockQueue: KnockQueue | null = useMemo(() => {
    if (!user || !useSheet) return null;
    return getKnockQueue({
      repId: user.teamMemberId ?? 0,
      post: (url, body) => apiRequest("POST", url, body).then(r => r.json()),
      patch: (url, body) => apiRequest("PATCH", url, body).then(r => r.json()),
      onSaved: () => {
        qc.invalidateQueries({ queryKey: ["/api/leaderboard"] });
        qc.invalidateQueries({ queryKey: ["/api/leads"] });
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.teamMemberId, useSheet]);
  const subscribeQueue = useCallback((cb: () => void) => knockQueue ? knockQueue.subscribe(cb) : () => {}, [knockQueue]);
  const getQueueSnap = useCallback(() => knockQueue ? knockQueue.getSnapshot() : EMPTY_QUEUE_SNAP, [knockQueue]);
  const queueSnap = useSyncExternalStore(subscribeQueue, getQueueSnap);

  const selectedLead = useMemo(() => leads.find(l => l.id === selectedLeadId) ?? null, [leads, selectedLeadId]);
  const sheetSaveState = selectedLeadId != null ? (queueSnap.byLead[selectedLeadId] ?? "idle") : "idle";
  const sheetSavedOutcome = lastSaved && lastSaved.leadId === selectedLeadId ? lastSaved.outcome : null;

  // Where the rep physically is, for Next Door: fresh GPS → selected door →
  // last knocked door → map center. Never a geocoding/directions API call.
  const knockOrigin = useCallback((): { lat: number; lng: number } => {
    const fix = lastFixRef.current;
    if (fix && Date.now() - fix.at < GPS_FRESH_MS) return { lat: fix.lat, lng: fix.lng };
    const sel = leads.find(l => l.id === selectedLeadId);
    if (sel?.lat && sel?.lng) return { lat: sel.lat, lng: sel.lng };
    if (lastKnockedRef.current) return lastKnockedRef.current;
    const c = mapRef.current?.getCenter?.();
    return { lat: c?.lat ?? 0, lng: c?.lng ?? 0 };
  }, [leads, selectedLeadId]);

  const writeResume = useCallback((leadId: number | null) => {
    if (user?.teamMemberId == null) return;
    try {
      const map = mapRef.current;
      const c = map?.getCenter?.();
      localStorage.setItem(`hf.repResume.v1.${user.teamMemberId}`, JSON.stringify({
        lastLeadId: leadId,
        camera: c ? { lng: c.lng, lat: c.lat, zoom: map.getZoom() } : null,
        at: new Date().toISOString(),
      }));
    } catch { /* storage blocked (sandboxed iframe) — resume simply won't offer */ }
  }, [user?.teamMemberId]);

  // One-tap knock: optimistic pin recolor FIRST (marking a door must feel
  // instant in the field), then the offline-safe enqueue. The queue owns
  // retries/idempotency; react-query owns rollback via onSaved invalidations.
  const handleKnock = useCallback((outcome: KnockOutcome, extra?: { callbackDate?: string; callbackTime?: string }) => {
    const lead = leads.find(l => l.id === selectedLeadId);
    if (!lead || !knockQueue) return;
    const credit = isRep ? user?.teamMemberId : (lead.assignedRepId ?? user?.teamMemberId);
    if (!credit) { toast({ title: "Assign a rep to this lead first, then log the knock", variant: "destructive" }); return; }
    const at = new Date().toISOString();
    qc.setQueryData(["/api/leads/map"], (old: any) => {
      if (!old?.pins) return old;
      return { ...old, pins: old.pins.map((p: MapPin) => p.id === lead.id
        ? { ...p, leadStatus: OUTCOME_TO_STATUS[outcome] ?? p.leadStatus, visited: true, knockCount: (p.knockCount ?? 0) + 1, lastOutcome: outcome, lastKnockedAt: at }
        : p) };
    });
    setLastSaved({ leadId: lead.id, outcome });
    if (lead.lat && lead.lng) lastKnockedRef.current = { lat: lead.lat, lng: lead.lng };
    recentIdsRef.current = [...recentIdsRef.current.slice(-9), lead.id];
    knockQueue.enqueue({ leadId: lead.id, repId: credit, outcome, callbackDate: extra?.callbackDate ?? null, callbackTime: extra?.callbackTime ?? null });
    writeResume(lead.id);
    setResumeTarget(null); // knocked this session — the resume offer is stale
    if (outcome === "sold") toast({ title: "🎉 Sale logged!" });
  }, [leads, selectedLeadId, knockQueue, isRep, user, qc, toast, writeResume]);

  const handleSaveNote = useCallback((note: string) => {
    if (selectedLeadId == null || !knockQueue) return;
    knockQueue.updateNote(selectedLeadId, note).then(r => {
      if (r === "not-found") toast({ title: "Couldn't attach note — log a knock first", variant: "destructive" });
    });
  }, [selectedLeadId, knockQueue, toast]);

  const handleRetrySave = useCallback(() => {
    if (selectedLeadId != null) knockQueue?.retryLead(selectedLeadId);
  }, [knockQueue, selectedLeadId]);

  const goNextDoor = useCallback(() => {
    const map = mapRef.current;
    const origin = knockOrigin();
    const pins = (visibleLeadsRef.current.length ? visibleLeadsRef.current : leads).filter(l => l.lat && l.lng) as any[];
    const exclude = new Set<number>([...recentIdsRef.current, ...(selectedLeadId != null ? [selectedLeadId] : [])]);
    // Retry without the ring buffer before declaring done — the buffer may be
    // masking the genuinely-last few doors.
    let next = nearestUnworkedLead(origin, pins, exclude);
    if (!next) next = nearestUnworkedLead(origin, pins, new Set(selectedLeadId != null ? [selectedLeadId] : []));
    // Inside the Done/Follow-ups/Sold lenses the visible set has zero routable
    // doors by definition — fall back to ALL pins and reset the lens so the rep
    // lands back in active-knocking view instead of a false "all worked".
    if (!next) {
      next = nearestUnworkedLead(origin, leads.filter(l => l.lat && l.lng) as any[], new Set(selectedLeadId != null ? [selectedLeadId] : []));
      if (next) { setVisitFilter("all"); setFilterStatus("all"); }
    }
    if (!next) { toast({ title: "All doors here are worked — nice job 🎉" }); return; }
    setSelectedLeadId(next.id);
    moveCamera(map, {
      center: [next.lng, next.lat], zoom: Math.max(map?.getZoom?.() ?? 16, 16.5),
      duration: 600, essential: true,
      padding: { top: 0, left: 0, right: 0, bottom: sheetPeekPaddingPx() },
    });
  }, [knockOrigin, leads, selectedLeadId, toast]);

  const handleSkip = useCallback(() => {
    if (selectedLeadId != null) recentIdsRef.current = [...recentIdsRef.current.slice(-9), selectedLeadId];
    goNextDoor();
  }, [selectedLeadId, goNextDoor]);

  const handleAssignRep = useCallback(async (repId: number | null) => {
    if (selectedLeadId == null) return;
    try {
      await apiRequest("POST", `/api/leads/${selectedLeadId}/assign`, { repId });
      toast({ title: repId ? "Lead assigned" : "Lead unassigned" });
      qc.invalidateQueries({ queryKey: ["/api/leads"] });
      qc.invalidateQueries({ queryKey: ["/api/leads/map"] });
    } catch { toast({ title: "Failed to assign", variant: "destructive" }); }
  }, [selectedLeadId, qc, toast]);

  // Next Door suggestion for the sheet button ("152 Maple St · 40m").
  const nextDoorSuggestion = useMemo(() => {
    if (!useSheet || !selectedLead?.lat || !selectedLead?.lng) return null;
    const pins = (visibleLeadsRef.current.length ? visibleLeadsRef.current : leads).filter(l => l.lat && l.lng) as any[];
    const exclude = new Set<number>([...recentIdsRef.current, selectedLead.id]);
    return nearestUnworkedLead({ lat: selectedLead.lat, lng: selectedLead.lng }, pins, exclude);
    // lastSaved dep: re-suggest after each knock (ring buffer grew)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useSheet, selectedLead, leads, lastSaved]);
  const nextDoorHint = nextDoorSuggestion && selectedLead?.lat && selectedLead?.lng
    ? `${(nextDoorSuggestion as any).address ?? ""} · ${distanceHint(haversineMeters({ lat: selectedLead.lat, lng: selectedLead.lng }, nextDoorSuggestion))}`
    : null;

  // Camera padding: keep the tapped pin visible above the peek sheet; restore
  // padding (never the center — the rep keeps their pan position) on close.
  const sheetWasOpenRef = useRef(false);
  useEffect(() => {
    if (!useSheet) return;
    const map = mapRef.current;
    if (!map || !mapReady) return;
    if (selectedLeadId != null) {
      sheetWasOpenRef.current = true;
      const lead = leads.find(l => l.id === selectedLeadId);
      if (lead?.lat && lead?.lng) {
        moveCamera(map, { center: [lead.lng, lead.lat], padding: { top: 0, left: 0, right: 0, bottom: sheetPeekPaddingPx() }, duration: 350, essential: true });
      }
    } else if (sheetWasOpenRef.current) {
      sheetWasOpenRef.current = false;
      moveCamera(map, { padding: { top: 0, left: 0, right: 0, bottom: 0 }, duration: 250 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLeadId, mapReady, useSheet]);

  // Resume chip — offered (never auto-opened) when a fresh last-worked door exists.
  const resumeCheckedRef = useRef(false);
  useEffect(() => {
    if (!isRep || resumeCheckedRef.current || user?.teamMemberId == null || leads.length === 0) return;
    resumeCheckedRef.current = true;
    try {
      const raw = localStorage.getItem(`hf.repResume.v1.${user.teamMemberId}`);
      if (!raw) return;
      const r = JSON.parse(raw);
      if (!r?.at || Date.now() - Date.parse(r.at) >= RESUME_TTL_MS) {
        localStorage.removeItem(`hf.repResume.v1.${user.teamMemberId}`);
        return;
      }
      const lead = r.lastLeadId ? leads.find(l => l.id === r.lastLeadId) : null;
      if (lead && pinDisplayState(lead) !== "sold") setResumeTarget({ leadId: lead.id, address: lead.address });
    } catch { /* storage blocked — no resume offer */ }
  }, [isRep, user?.teamMemberId, leads]);

  // HUD collapses to "{n} left" while the rep pans — tap to re-expand.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !isRep) return;
    const onMove = () => setHudMini(true);
    map.on("movestart", onMove);
    return () => { try { map.off("movestart", onMove); } catch {} };
  }, [mapReady, isRep]);

  // noToken is true only after we confirmed the token is unavailable (never during load)
  const noToken = mapTokenFailed;
  const tokenLoading = !mapboxToken && !mapTokenFailed;

  return (
    <div className="flex flex-col" style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>

      {/* ── Top bar ── (admin/manager/team-lead chrome; reps get the on-map HUD) */}
      {!isRep && (
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
            <span className="text-xs font-semibold text-teal-400">{newFiberCount}</span>
            <span className="text-xs text-muted-foreground hidden sm:inline"> fiber</span>
          </div>
          {!isRep && (
            <div className="flex items-center gap-1">
              <Users className="w-3 h-3 text-blue-400" />
              <span className="text-xs text-muted-foreground">{assignedCount} assigned</span>
            </div>
          )}
          {/* Doors left to knock — the field rep's key number */}
          <div className="flex items-center gap-1" title="Doors not yet knocked">
            <DoorOpen className="w-3 h-3 text-amber-400" />
            <span className="text-xs font-semibold text-amber-400">{doorsLeft.toLocaleString()}</span>
            <span className="text-xs text-muted-foreground hidden sm:inline">left</span>
          </div>
          {/* Visit filter — All / Left / Done */}
          <div className="flex items-center rounded-md border border-border overflow-hidden text-[11px]">
            {([["all", "All"], ["unvisited", "Left"], ["visited", "Done"]] as const).map(([v, label]) => (
              <button key={v} onClick={() => setVisitFilter(v)}
                className={`px-2 py-1 transition-colors ${visitFilter === v ? "bg-primary text-white" : "text-muted-foreground hover:text-foreground hover:bg-secondary"}`}
                data-testid={`visit-filter-${v}`}>
                {label}
              </button>
            ))}
          </div>
          {/* Filter map pins by rep — admin/manager/team lead */}
          {canAssign && (
            <select
              value={filterRep}
              onChange={e => setFilterRep(e.target.value)}
              data-testid="map-filter-rep"
              className="h-7 bg-secondary border border-border rounded-md px-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              title="Show only leads for a rep"
            >
              <option value="all">All reps</option>
              <option value="unassigned">Unassigned ({leads.filter(l => !l.assignedRepId).length})</option>
              {team.map((m: TeamMember) => (
                <option key={m.id} value={String(m.id)}>{m.name} ({leads.filter(l => l.assignedRepId === m.id).length})</option>
              ))}
            </select>
          )}
        </div>

        {/* Actions */}
        <div className="ml-auto flex items-center gap-1.5">
          {/* ── Action tools. Exactly ONE draw tool armed at a time. ──
                 Assign Area: draw a loop → pick a rep → assigns the leads inside
                 AND saves a color-coded territory for that rep.
                 Scan Area: draw a box → hit Kinetic → new leads. ── */}
          {canAssign && (
            <Button
              size="sm" variant="outline"
              onClick={() => {
                if (lassoMode) {
                  exitLasso();
                } else {
                  exitLasso(); // clear any prior shape before re-arming
                  setLassoMode(true);
                  setDrawMode(false); setDrawnBBox(null);
                }
              }}
              disabled={!mapReady}
              className={`h-7 text-xs ${
                lassoMode
                  ? "border-teal-500 text-teal-300 bg-teal-500/10"
                  : "border-teal-500/40 text-teal-400 hover:bg-teal-500/10"
              }`}
              title="Assign Area: drag a loop around leads, pick a rep — assigns them and color-codes the territory"
            >
              <Pencil className="w-3 h-3 mr-1" />
              {lassoMode ? (lassoSelected.length > 0 ? `Area (${lassoSelected.length})` : "Draw area…") : "Assign Area"}
            </Button>
          )}
          {/* Draw a box → scan that area for new fiber (admin only) */}
          {isAdmin && (
            <Button
              onClick={() => { setDrawMode(!drawMode); setDrawnBBox(null); exitLasso(); }}
              disabled={!mapReady}
              size="sm" variant="outline"
              className={`h-7 text-xs ${drawMode ? "border-orange-500 text-orange-400 bg-orange-500/10" : "border-orange-500/40 text-orange-400 hover:bg-orange-500/10"}`}
              title="Scan Area: draw a box to scan Kinetic for new fiber leads"
            ><Target className="w-3 h-3 mr-1" />{drawMode ? "Drawing…" : "Scan Area"}</Button>
          )}

          {/* Divider between action tools and view controls */}
          {(canAssign || isAdmin) && <div className="w-px h-5 bg-border mx-0.5" />}

          {/* ── View controls (map mode moved to the right control rail) ── */}
          <Button
            size="sm" variant="outline"
            onClick={() => mapRef.current?.flyTo({ center: ROCKWELL_CENTER, zoom: 13, duration: 800 })}
            disabled={!mapReady}
            className="h-7 text-xs border-border text-muted-foreground hover:text-foreground"
            title="Reset map view"
          ><Home className="w-3 h-3" /></Button>
        </div>
      </div>
      )}

      {/* Context banners — stay open after the box is drawn (drawMode flips off
          on mouse-up) so the scan buttons remain visible. */}
      {(drawMode || drawnBBox || scanning) && isAdmin && (
        <div className="px-3 py-2 bg-orange-500/10 border-b border-orange-500/30 flex flex-wrap items-center gap-2 flex-shrink-0">
          <span className="text-[11px] text-orange-400">
            {scanning ? `Scanning… ${done}/${total} · ${newFound} new fiber found`
              : drawnBBox ? "Box drawn — pick a scan below (green dots = new fiber)"
              : "Drag on the map to draw a box over the homes you want to scan"}
          </span>
          {drawnBBox && !scanning && (
            <>
              {/* Free: OpenStreetMap addresses in the box (fast, but rural coverage is thin) */}
              <Button size="sm" variant="outline"
                className="border-orange-500/40 text-orange-400 hover:bg-orange-500/10 h-6 text-[11px] px-2"
                onClick={() => startScan("/api/scan/area", {
                  minLat: drawnBBox.minLat, maxLat: drawnBBox.maxLat,
                  minLng: drawnBBox.minLng, maxLng: drawnBBox.maxLng,
                })}>
                <Target className="w-3 h-3 mr-1" /> Quick scan · free
              </Button>
              {/* Full coverage: Mapbox reverse-geocode grid → every home. Cost shown. */}
              <Button size="sm"
                disabled={!areaEstimate || areaEstimate.overCap}
                className="bg-orange-500 hover:bg-orange-600 text-white h-6 text-[11px] px-2 disabled:opacity-50"
                title={areaEstimate?.overCap ? "Box too big — draw a smaller box" : "Finds every address via Mapbox grid"}
                onClick={() => startScan("/api/scan/area", {
                  minLat: drawnBBox.minLat, maxLat: drawnBBox.maxLat,
                  minLng: drawnBBox.minLng, maxLng: drawnBBox.maxLng, deep: true,
                })}>
                <Target className="w-3 h-3 mr-1" />
                {areaEstimate
                  ? `Deep scan · ~${areaEstimate.estAddresses.toLocaleString()} addr · ${areaEstimate.withinFreeTier ? "free" : "$" + areaEstimate.estCostUsd}`
                  : "Deep scan…"}
              </Button>
              {areaEstimate && (
                <span className="text-[10px] text-orange-400/60">
                  {areaEstimate.overCap
                    ? `box too big (${areaEstimate.gridPoints.toLocaleString()} calls > cap) — draw smaller`
                    : `deep = ${areaEstimate.gridPoints.toLocaleString()} Mapbox calls`}
                </span>
              )}
            </>
          )}
          {scanning && (
            <Button size="sm" variant="ghost" className="text-red-400 h-6 text-[11px]" onClick={() => stopScan()}>Stop</Button>
          )}
          <Button size="sm" variant="ghost" className="text-muted-foreground h-6 text-[11px]"
            onClick={() => { setDrawMode(false); setDrawnBBox(null); if (scanning) stopScan(); }}>Cancel</Button>
        </div>
      )}
      {/* Lasso UI moved to a floating bottom action bar inside the map (below) */}

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
            {/* rep-clean-map hides the Mapbox zoom/compass/geolocate button stack on
                mobile rep screens — pinch-zoom + the locate FAB cover both, and the
                porch test says every leftover control is clutter. */}
            <div ref={mapContainer} className={isRep && isMobile ? "rep-clean-map" : undefined} style={{ width: "100%", height: "100%" }} />
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

          {/* Lead count chip — top left (reps get the progress HUD instead) */}
          {mapReady && leads.length > 0 && !isRep && (
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

          {/* ── On-map street/address search — flies to the matching lead ── */}
          {mapReady && (
            <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 w-[min(420px,70vw)]">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/50" />
                <input
                  value={sidebarSearch}
                  onChange={e => setSidebarSearch(e.target.value)}
                  placeholder="Search a street or address…"
                  data-testid="map-search"
                  className="w-full bg-black/80 backdrop-blur-md border border-white/15 rounded-lg pl-9 pr-8 py-2 text-sm text-white placeholder:text-white/40 focus:outline-none focus:ring-1 focus:ring-teal-400 shadow-lg"
                />
                {sidebarSearch && (
                  <button onClick={() => setSidebarSearch("")}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-white/40 hover:text-white text-sm">×</button>
                )}
              </div>
              {searchMatches.length > 0 && (
                <div className="mt-1 bg-black/90 backdrop-blur-md border border-white/10 rounded-lg overflow-hidden shadow-2xl max-h-72 overflow-y-auto">
                  {searchMatches.map(l => {
                    const pin = PIN_COLORS[l.leadStatus] ?? PIN_COLORS.prospect;
                    return (
                      <button
                        key={l.id}
                        onClick={() => { flyToLead(l); setSidebarSearch(""); }}
                        className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-white/10 transition-colors border-b border-white/5 last:border-0"
                      >
                        <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: pin.bg }} />
                        <span className="min-w-0 flex-1">
                          <span className="block text-[13px] text-white font-medium truncate">{l.address}</span>
                          <span className="block text-[11px] text-white/50 truncate">{l.city}, {l.state} {l.zip}</span>
                        </span>
                        {l.fiberStatus === "new_fiber" && <span className="text-[9px] font-bold text-teal-400 flex-shrink-0">NEW</span>}
                      </button>
                    );
                  })}
                </div>
              )}
              {sidebarSearch.trim().length >= 3 && searchMatches.length === 0 && (
                <div className="mt-1 bg-black/90 border border-white/10 rounded-lg overflow-hidden shadow-xl">
                  <div className="px-3 py-2 text-[12px] text-white/50">No existing lead matches “{sidebarSearch}”</div>
                  {isAdmin && (
                    <button
                      onClick={() => jumpToAddress(sidebarSearch)}
                      disabled={geocoding}
                      data-testid="map-search-goto"
                      className="w-full flex items-center gap-2 px-3 py-2 text-left border-t border-white/10 hover:bg-white/10 text-[13px] text-teal-300 disabled:opacity-60"
                    >
                      <Target className="w-3.5 h-3.5 flex-shrink-0" />
                      {geocoding ? "Locating…" : <>Go to “{sidebarSearch}” on the map <span className="text-white/40 text-[11px]">then draw a Scan-Area box</span></>}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ── Rep progress HUD — assigned/knocked/left/sold/follow-ups, client-derived ── */}
          {mapReady && isRep && leads.length > 0 && (
            <div className="absolute top-14 left-3 right-3 z-20 flex justify-start pointer-events-none [&>*]:pointer-events-auto">
              <RepProgressHUD pins={leads} mini={hudMini} onToggle={() => setHudMini(m => !m)} />
            </div>
          )}

          {/* ── Rep filter chips — one-tap lenses over the same pins. Radio-style;
                 knocked doors always stay on the map under "All" (default). ── */}
          {mapReady && isRep && (
            <div className="absolute top-[104px] left-3 right-3 z-20 flex gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden pb-0.5">
              {([
                ["all", "All", visitFilter === "all" && filterStatus === "all"],
                ["unworked", "Left", visitFilter === "unvisited" && filterStatus === "all"],
                ["worked", "Done", visitFilter === "visited" && filterStatus === "all"],
                ["followups", "Follow-ups", filterStatus === "follow_up"],
                ["sold", "Sold", filterStatus === "sold"],
              ] as const).map(([key, label, active]) => (
                <button
                  key={key}
                  data-testid={`filter-chip-${key}`}
                  aria-pressed={active}
                  onClick={() => {
                    if (key === "all") { setVisitFilter("all"); setFilterStatus("all"); }
                    else if (key === "unworked") { setVisitFilter("unvisited"); setFilterStatus("all"); }
                    else if (key === "worked") { setVisitFilter("visited"); setFilterStatus("all"); }
                    else if (key === "followups") { setVisitFilter("all"); setFilterStatus("follow_up"); }
                    else { setVisitFilter("all"); setFilterStatus("sold"); }
                  }}
                  // Active = SOLID teal (a 20% tint dies in direct sunlight over satellite)
                  className={`h-9 px-3 shrink-0 rounded-full text-xs font-semibold border shadow-lg transition-colors active:scale-95 flex items-center ${
                    active ? "bg-primary border-primary text-white" : "bg-black/80 backdrop-blur-sm border-white/15 text-white/70 hover:text-white"
                  }`}
                >
                  {/* Follow-ups/Sold chips teach the pin-color language with a dot */}
                  {key === "followups" && <span className={`w-1.5 h-1.5 rounded-full mr-1 inline-block ${active ? "bg-white/70" : ""}`} style={active ? undefined : { background: "#f59e0b" }} />}
                  {key === "sold" && <span className={`w-1.5 h-1.5 rounded-full mr-1 inline-block ${active ? "bg-white/70" : ""}`} style={active ? undefined : { background: "#10b981" }} />}
                  {label}
                </button>
              ))}
            </div>
          )}

          {/* Offline-queue badge — knocks waiting to sync. Hugs the edge on mobile
              rep screens where the Mapbox control stack is hidden. */}
          {useSheet && queueSnap.pendingCount > 0 && (
            <div data-testid="knock-pending-badge"
              className={`absolute top-3 ${isRep && isMobile ? "right-3" : "right-14"} z-20 flex items-center gap-1.5 h-8 px-3 rounded-full bg-amber-500/15 border border-amber-500/40 text-amber-300 text-xs font-semibold backdrop-blur-sm shadow-lg`}>
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
              {queueSnap.pendingCount} to sync
            </div>
          )}

          {/* Resume where you left off — offered, never auto-opened */}
          {mapReady && isRep && resumeTarget && selectedLeadId == null && (
            <div className="absolute left-1/2 -translate-x-1/2 z-30 flex items-center gap-1 rounded-full bg-[#0F2A43]/95 backdrop-blur-md border border-teal-400/30 shadow-2xl pl-4 pr-1.5 py-1.5"
              style={{ bottom: "calc(1.5rem + env(safe-area-inset-bottom))" }}>
              <button
                data-testid="resume-chip"
                onClick={() => {
                  const lead = leads.find(l => l.id === resumeTarget.leadId);
                  setResumeTarget(null);
                  if (lead) flyToLead(lead);
                }}
                className="flex items-center gap-2 text-[13px] font-semibold text-white"
              >
                <Footprints className="w-4 h-4 text-teal-400" />
                Resume · <span className="max-w-[160px] truncate font-medium text-white/85">{resumeTarget.address}</span>
              </button>
              <button
                data-testid="resume-chip-dismiss"
                onClick={() => setResumeTarget(null)}
                className="w-9 h-9 rounded-full flex items-center justify-center text-white/50 hover:text-white"
                title="Dismiss"
              ><X className="w-4 h-4" /></button>
            </div>
          )}

          {/* ── Assign-Area floating action bar — bottom-center, thumb-reachable ── */}
          {lassoMode && (
            <div className="absolute left-1/2 -translate-x-1/2 bottom-6 z-30 max-w-[calc(100vw-24px)]">
              {lassoSelected.length === 0 ? (
                /* Armed, nothing drawn yet → drawing hint */
                <div className="flex items-center gap-2.5 rounded-full bg-[#0F2A43]/95 backdrop-blur-md border border-teal-400/30 shadow-2xl pl-4 pr-2 py-2 animate-in fade-in slide-in-from-bottom-2 duration-200">
                  <Pencil className="w-4 h-4 text-teal-400 flex-shrink-0" />
                  <span className="text-[13px] font-medium text-white whitespace-nowrap">
                    Drag a loop around the area
                  </span>
                  <button
                    onClick={exitLasso}
                    className="w-9 h-9 rounded-full flex items-center justify-center text-white/60 hover:text-white hover:bg-white/10 transition-colors"
                    title="Exit"
                    data-testid="lasso-exit"
                  ><X className="w-4 h-4" /></button>
                </div>
              ) : (
                /* Drawn → count · rep picker · Assign (creates colored territory) */
                <div className="flex items-center gap-2.5 rounded-full bg-[#0F2A43]/95 backdrop-blur-md border border-teal-400/30 shadow-2xl pl-4 pr-2 py-2 animate-in fade-in slide-in-from-bottom-2 duration-200">
                  <span className="flex items-center gap-1.5 text-[14px] font-bold text-white whitespace-nowrap" aria-live="polite">
                    <span
                      className="w-2.5 h-2.5 rounded-full transition-colors"
                      style={{ background: colorForRep(lassoRepId ? Number(lassoRepId) : null), boxShadow: lassoRepId ? `0 0 8px ${colorForRep(Number(lassoRepId))}` : "none" }}
                    />
                    {lassoSelected.length}<span className="font-medium text-white/60 hidden sm:inline"> leads in area</span>
                  </span>
                  <select
                    value={lassoRepId}
                    onChange={e => setLassoRepId(e.target.value)}
                    data-testid="lasso-rep-select"
                    className="h-9 rounded-full bg-white/10 text-white text-[13px] px-3 border-0 focus:outline-none focus:ring-2 focus:ring-teal-400/60 max-w-[160px]"
                  >
                    <option value="" className="text-slate-900">Assign to rep…</option>
                    {team.filter(m => m.active).map((m: TeamMember) => (
                      <option key={m.id} value={m.id} className="text-slate-900">{m.name}</option>
                    ))}
                  </select>
                  <Button
                    disabled={!lassoRepId || assignAreaMutation.isPending}
                    onClick={() => assignAreaMutation.mutate({ polygon: lassoPoints, repId: Number(lassoRepId) })}
                    data-testid="lasso-assign"
                    className="h-9 rounded-full bg-teal-500 hover:bg-teal-600 text-[#04241f] font-bold text-[13px] px-4 disabled:opacity-40"
                  >
                    {assignAreaMutation.isPending ? "Assigning…" : `Assign ${lassoSelected.length}`}
                  </Button>
                  <button
                    onClick={exitLasso}
                    className="w-9 h-9 rounded-full flex items-center justify-center text-white/60 hover:text-white hover:bg-white/10 transition-colors flex-shrink-0"
                    title="Exit"
                    data-testid="lasso-exit"
                  ><X className="w-4 h-4" /></button>
                </div>
              )}
            </div>
          )}

          {/* ── Territory detail panel — opens when you tap a region ── */}
          {canAssign && selectedTerritoryId != null && (() => {
            const t = territories.find(x => x.id === selectedTerritoryId);
            if (!t) return null;
            const prog = territoryProgress.find(p => p.id === t.id);
            const status = (t as any).status ?? "active";
            const repIds = (() => { try { const a = JSON.parse((t as any).assigneeIds || "[]"); return Array.isArray(a) && a.length ? a : (status === "unassigned" || status === "reclaimed" ? [] : [t.repId]); } catch { return [t.repId]; } })();
            const teamNames = Object.fromEntries(team.map(m => [m.id, m.name]));
            const isPool = status === "unassigned" || status === "reclaimed";
            return (
              <div className="absolute top-16 left-3 z-30 animate-in fade-in slide-in-from-left-2 duration-200">
                <div className="relative">
                  <button onClick={() => setSelectedTerritoryId(null)} className="absolute -top-2 -right-2 z-10 w-6 h-6 rounded-full bg-card border border-border text-muted-foreground hover:text-foreground flex items-center justify-center shadow" title="Close"><X className="w-3.5 h-3.5" /></button>
                  <TerritoryDetailPanel
                    territory={{ id: t.id, name: t.name, status, repIds, color: t.color, leadCount: prog?.total ?? 0, workedCount: prog?.knocked }}
                    currentUser={{ role: (user?.role ?? "rep") }}
                    teamNames={teamNames}
                    onReclaim={!isPool && canManage ? () => setReclaimMenuId(reclaimMenuId === t.id ? null : t.id) : undefined}
                  />
                  {/* Assign-to-next-rep for unassigned/reclaimed areas */}
                  {isPool && (
                    <div className="mt-2 w-72 rounded-xl border border-border bg-card p-3">
                      <div className="text-[11px] font-semibold text-foreground mb-1.5">Assign this area to the next rep</div>
                      <select
                        data-testid="assign-next-rep"
                        defaultValue=""
                        onChange={e => { if (e.target.value) assignTerritoryMutation.mutate({ id: t.id, repId: Number(e.target.value) }); }}
                        className="w-full h-9 bg-secondary border border-border rounded-lg px-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                      >
                        <option value="">Choose a rep…</option>
                        {team.filter(m => m.active).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                      </select>
                    </div>
                  )}
                  {/* Inline reclaim 3-mode chooser (reuses the same mutation) */}
                  {reclaimMenuId === t.id && !isPool && (
                    <div className="mt-2 w-72 rounded-xl border border-border bg-card p-2 flex flex-col gap-1" data-testid={`panel-reclaim-menu-${t.id}`}>
                      <button onClick={() => reclaimMutation.mutate({ id: t.id, mode: "return_to_pool" })} className="text-left text-xs text-foreground hover:bg-secondary rounded px-2 py-1.5">↩ Return leads to pool <span className="text-muted-foreground">(default)</span></button>
                      <button onClick={() => reclaimMutation.mutate({ id: t.id, mode: "keep_leads" })} className="text-left text-xs text-foreground hover:bg-secondary rounded px-2 py-1.5">Reclaim area only <span className="text-muted-foreground">(keep leads)</span></button>
                      <select defaultValue="" onChange={e => { if (e.target.value) reclaimMutation.mutate({ id: t.id, mode: "reassign", newRepId: Number(e.target.value) }); }} className="bg-secondary border border-border rounded px-2 py-1.5 text-xs text-foreground">
                        <option value="">Reassign to rep…</option>
                        {team.filter(m => m.active && m.id !== t.repId).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                      </select>
                    </div>
                  )}
                </div>
              </div>
            );
          })()}

          {/* ── Right control rail — layers + map mode (SalesRabbit/SPOTIO style) ── */}
          {/* Admin/manager control rail — layer toggles + map modes. Reps get ONE
              button instead: nothing on their screen that doesn't speed up knocking. */}
          {mapReady && !isRep && (
            <div className="absolute top-[110px] right-3 z-20 w-40 rounded-xl bg-black/80 backdrop-blur-md border border-white/10 p-2.5 shadow-xl text-white">
              <div className="text-[9px] uppercase tracking-wider text-white/40 font-semibold mb-1.5">Layers</div>
              {[
                { key: "leads", label: "Leads", on: showLeads, toggle: () => setShowLeads(v => !v) },
                ...(canAssign ? [{ key: "terr", label: "Territories", on: showTerritories, toggle: () => setShowTerritories(v => !v) }] : []),
              ].map(l => (
                <button key={l.key} onClick={l.toggle} data-testid={`layer-${l.key}`}
                  className="w-full flex items-center justify-between py-1 text-[12px] text-white/85 hover:text-white">
                  <span>{l.label}</span>
                  <span className={`w-7 h-4 rounded-full transition-colors relative ${l.on ? "bg-primary" : "bg-white/15"}`}>
                    <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all ${l.on ? "left-3.5" : "left-0.5"}`} />
                  </span>
                </button>
              ))}
              <div className="text-[9px] uppercase tracking-wider text-white/40 font-semibold mt-2.5 mb-1.5">Map</div>
              <div className="grid grid-cols-3 gap-1">
                {([["satellite", "Sat"], ["streets", "Street"], ["dark", "Dark"]] as const).map(([mode, label]) => (
                  <button key={mode} onClick={() => setMapStyleMode(mode)} data-testid={`mapmode-${mode}`} disabled={!mapReady}
                    className={`text-[10px] py-1 rounded-md transition-colors ${mapStyleMode === mode ? "bg-primary text-white font-semibold" : "bg-white/10 text-white/70 hover:bg-white/20"}`}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Rep map-style button — one tap cycles Sat → Street → Dark. Fixed
              min-width so the pill never resizes between labels; the icon shows
              the CURRENT mode. */}
          {mapReady && isRep && (
            <button
              data-testid="rep-map-style"
              onClick={() => setMapStyleMode(m => m === "satellite" ? "streets" : m === "streets" ? "dark" : "satellite")}
              aria-label={`Map style: ${mapStyleMode === "satellite" ? "Satellite" : mapStyleMode === "streets" ? "Street" : "Dark"}. Tap to switch`}
              className="absolute top-[152px] right-3 z-20 h-9 min-w-[76px] px-3 rounded-full bg-black/80 backdrop-blur-sm border border-white/15 text-white/90 text-[11px] font-semibold shadow-lg flex items-center justify-center gap-1.5 active:scale-95 transition"
            >
              {mapStyleMode === "satellite" ? <Satellite className="w-3.5 h-3.5" />
                : mapStyleMode === "streets" ? <MapIcon className="w-3.5 h-3.5" />
                : <Moon className="w-3.5 h-3.5" />}
              {mapStyleMode === "satellite" ? "Sat" : mapStyleMode === "streets" ? "Street" : "Dark"}
            </button>
          )}

          {/* Locate-me FAB — big thumb target, bottom-right, above zoom controls */}
          {mapReady && (
            <button
              onClick={() => { try { geolocateRef.current?.trigger(); } catch {} }}
              title="Center on my location"
              data-testid="locate-me"
              className="absolute bottom-8 right-3 z-20 h-13 w-13 rounded-full bg-primary text-white shadow-xl flex items-center justify-center active:scale-95 transition-transform hover:bg-primary/90"
              style={{ height: 52, width: 52 }}
            >
              <LocateFixed className="w-6 h-6" />
            </button>
          )}

          {/* Next Door FAB — start (or continue) the route when the sheet is closed */}
          {mapReady && useSheet && isRep && selectedLeadId == null && leads.length > 0 && (
            <button
              onClick={goNextDoor}
              title="Take me to the nearest unworked door"
              data-testid="next-door-fab"
              className="absolute bottom-24 right-3 z-20 rounded-full bg-card border border-border text-foreground shadow-xl flex items-center justify-center active:scale-95 transition-transform hover:border-primary/50"
              style={{ height: 52, width: 52 }}
            >
              <DoorOpen className="w-6 h-6 text-primary" />
            </button>
          )}

          {/* Pin legend + filter — bottom left, admin/manager only. Reps get the
              chips instead on every viewport: two filter UIs writing the same
              state (legend can pick statuses the chips can't show) is confusion,
              not power. */}
          {mapReady && !isRep && (
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
              {canAssign && territories.length > 0 && (
                <div className="pt-2 mt-1 border-t border-white/10">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[10px] text-white/40 uppercase tracking-wider font-semibold">Assigned areas</span>
                    <button onClick={() => setShowTerritories(v => !v)} className="text-[10px] text-white/40 hover:text-white/70">{showTerritories ? "Hide" : "Show"}</button>
                  </div>
                  {territories.map(t => {
                    const prog = territoryProgress.find(p => p.id === t.id);
                    const status = (t as any).status ?? "active";
                    const isUnassigned = status === "unassigned" || status === "reclaimed";
                    const color = isUnassigned ? "#94a3b8" : colorForRep(t.repId);
                    const repName = isUnassigned ? "Unassigned" : (team.find(m => m.id === t.repId)?.name ?? t.name);
                    return (
                    <div key={t.id} className="mb-1.5 group">
                      <div className="flex items-center gap-2">
                        <div className="w-2.5 h-2.5 rounded-full flex-shrink-0 border border-white/20" style={{ background: color }} />
                        <span className="text-[11px] truncate text-white/85">{repName}</span>
                        {status !== "active" && <span className="text-[9px] uppercase tracking-wide text-white/40">{status}</span>}
                        {prog && <span className="ml-auto text-[10px] text-white/50 tabular-nums">{prog.knocked}/{prog.total}</span>}
                        {canAssign && isUnassigned && (
                          <button onClick={() => setReclaimMenuId(reclaimMenuId === t.id ? null : t.id)} title="Assign to next rep"
                            className="opacity-0 group-hover:opacity-100 text-teal-400 text-xs" data-testid={`assign-${t.id}`}>＋</button>
                        )}
                        {canManage && !isUnassigned && (
                          <button onClick={() => setReclaimMenuId(reclaimMenuId === t.id ? null : t.id)} title="Reclaim / pull back this area"
                            className="opacity-0 group-hover:opacity-100 text-amber-400 text-xs" data-testid={`reclaim-${t.id}`}>↩</button>
                        )}
                        {canManage && <button onClick={() => deleteTerritoryMutation.mutate(t.id)} title="Delete this area" className="opacity-0 group-hover:opacity-100 text-red-400/70 hover:text-red-400 text-xs">×</button>}
                      </div>
                      {prog && prog.total > 0 && (
                        <div className="h-1 rounded-full bg-white/10 mt-0.5 overflow-hidden">
                          <div className="h-full rounded-full" style={{ width: `${prog.pct}%`, background: color }} />
                        </div>
                      )}
                      {/* Assign-to-next-rep chooser for reclaimed/unassigned areas */}
                      {reclaimMenuId === t.id && isUnassigned && (
                        <div className="mt-1 ml-4 bg-black/40 rounded-md p-1.5" data-testid={`assign-menu-${t.id}`}>
                          <select data-testid={`assign-select-${t.id}`} defaultValue=""
                            onChange={e => { if (e.target.value) { assignTerritoryMutation.mutate({ id: t.id, repId: Number(e.target.value) }); setReclaimMenuId(null); } }}
                            className="w-full bg-black/50 text-white text-[10px] rounded px-1 py-1 border border-white/10">
                            <option value="" className="text-slate-900">Assign to next rep…</option>
                            {team.filter(m => m.active).map(m => <option key={m.id} value={m.id} className="text-slate-900">{m.name}</option>)}
                          </select>
                        </div>
                      )}
                      {/* Reclaim 3-mode chooser (owned areas only) */}
                      {reclaimMenuId === t.id && !isUnassigned && (
                        <div className="mt-1 ml-4 flex flex-col gap-1 bg-black/40 rounded-md p-1.5" data-testid={`reclaim-menu-${t.id}`}>
                          <button onClick={() => reclaimMutation.mutate({ id: t.id, mode: "return_to_pool" })}
                            className="text-left text-[10px] text-white/80 hover:text-white px-1.5 py-1 rounded hover:bg-white/10">
                            ↩ Return leads to pool <span className="text-white/40">(default)</span>
                          </button>
                          <button onClick={() => reclaimMutation.mutate({ id: t.id, mode: "keep_leads" })}
                            className="text-left text-[10px] text-white/80 hover:text-white px-1.5 py-1 rounded hover:bg-white/10">
                            Reclaim area only <span className="text-white/40">(keep leads)</span>
                          </button>
                          <div className="flex items-center gap-1">
                            <select data-testid={`reassign-select-${t.id}`} defaultValue=""
                              onChange={e => { if (e.target.value) reclaimMutation.mutate({ id: t.id, mode: "reassign", newRepId: Number(e.target.value) }); }}
                              className="flex-1 bg-black/50 text-white text-[10px] rounded px-1 py-1 border border-white/10">
                              <option value="" className="text-slate-900">Reassign to rep…</option>
                              {team.filter(m => m.active && m.id !== t.repId).map(m => <option key={m.id} value={m.id} className="text-slate-900">{m.name}</option>)}
                            </select>
                          </div>
                        </div>
                      )}
                    </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* ── Knock sheet — the rep's door-to-door workflow (reps always; admins on mobile) ── */}
          {useSheet && (
            <LeadKnockSheet
              lead={selectedLead}
              saveState={sheetSaveState}
              savedOutcome={sheetSavedOutcome}
              onKnock={handleKnock}
              onSaveNote={handleSaveNote}
              onRetrySave={handleRetrySave}
              onClose={() => setSelectedLeadId(null)}
              onNextDoor={goNextDoor}
              onSkip={handleSkip}
              nextDoorHint={nextDoorHint}
              hasNext={!!nextDoorSuggestion}
              canAssign={canAssign}
              reps={team.filter(m => m.active).map(m => ({ id: m.id, name: m.name }))}
              onAssignRep={handleAssignRep}
            />
          )}
        </div>
      </div>
    </div>
  );
}
