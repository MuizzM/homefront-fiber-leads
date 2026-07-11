import { useEffect, useRef, useState, useCallback, useMemo, useSyncExternalStore, useDeferredValue } from "react";
// mapbox-gl loaded via CDN in index.html — do not bundle
declare const mapboxgl: any;
import {
  AlertCircle, Pencil, X, Map as MapIcon, Bell, Target, Search, LocateFixed, Menu,
  Lasso, Radar, Loader2, Layers, RefreshCw, CheckCircle2, List, Navigation,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { useIsMobile } from "@/hooks/use-mobile";
import type { TeamMember, Territory } from "@shared/schema";
import { colorForRep } from "@shared/repColors";
import { TerritoryDetailPanel } from "@/components/TerritoryDetailPanel";
import { TerritoryActivityDrawer } from "@/components/TerritoryActivityDrawer";
import { LeadKnockSheet } from "@/components/LeadKnockSheet";
import { LeadsInViewPanel } from "@/components/LeadsInViewPanel";
import { getKnockQueue, type KnockQueue, type QueueSnapshot } from "@/lib/knockQueue";
import { captureFieldFix } from "@/lib/geoFix";
import { OUTCOME_TO_STATUS, pinDisplayState, STATE_COLORS, STATE_LABELS, nearestUnworkedLead, type KnockOutcome, type RoutablePin } from "@shared/knock";
import { saveLeadNote, flushPendingNotes, type NotePoster, type NoteSaveResult } from "@/lib/leadNotes";
import {
  UNCLUSTERED_PAINT, UNCLUSTERED_GLOW_PAINT, SELECTED_RING_SPEC,
  SELECTED_RING_FILTER, sheetPeekPaddingPx, moveCamera,
  STREET_ZOOM, pickRepStartCamera, readCachedFix, writeCachedFix,
  ensureHousenumLayer,
} from "@/lib/mapPins";
import { selectPointsInPolygon, pointInRing, bboxOfRing, type BBox2 } from "@/lib/mapGeo";

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
// Manager legend/search dots — same hues as the shared STATE_COLORS pin system
// (prospect orange, follow-up yellow, contacted slate) so the legend can never
// disagree with what the map paints.
const PIN_COLORS: Record<string, { bg: string; border: string; label: string }> = {
  prospect:       { bg: "#f97316", border: "#fdba74", label: "Prospect" },       // orange — unworked pool
  contacted:      { bg: "#64748b", border: "#cbd5e1", label: "Contacted" },      // slate
  interested:     { bg: "#8b5cf6", border: "#c4b5fd", label: "Interested" },     // purple
  follow_up:      { bg: "#eab308", border: "#fde047", label: "Follow-up" },      // yellow
  sold:           { bg: "#10b981", border: "#6ee7b7", label: "SOLD" },           // emerald
  not_interested: { bg: "#ef4444", border: "#fca5a5", label: "Not Interested" }, // red
};

// Search rows and the leads panel label pins by the TRUE display state
// (pinDisplayState → STATE_COLORS/STATE_LABELS from @shared/knock) — the
// PIN_COLORS map above keys on raw leadStatus (6 states) and can't represent
// callback (cyan) or not-home (blue).


// ── Bbox type ─────────────────────────────────────────────────────────────────
interface BBox { minLng: number; minLat: number; maxLng: number; maxLat: number }
function inBBox(lat: number, lng: number, b: BBox) {
  return lat >= b.minLat && lat <= b.maxLat && lng >= b.minLng && lng <= b.maxLng;
}

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

// HTML-escape untrusted text interpolated into scan-dot popups (XSS guard).
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

export default function MapView() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const geolocateRef = useRef<any>(null);
  const scanMarkersRef = useRef<any[]>([]);
  const lastRenderedCount = useRef(0);
  const pollTickRef = useRef(0);      // counts scan polls, to throttle live lead refreshes
  const didAutoFitRef = useRef(false); // fit the map to leads once on first load

  const [mapReady, setMapReady] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [total, setTotal] = useState(0);
  const [done, setDone] = useState(0);
  const [newFound, setNewFound] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Scan lifecycle — a completed scan is a first-class RESULT, not just the
  // absence of a spinner. `scanOutcome` drives the control's success / empty /
  // error / cancelled / stale states and the same-scope rescan guard.
  const [scanOutcome, setScanOutcome] = useState<{
    kind: "success" | "empty" | "error" | "cancelled";
    found: number; at: number;                 // epoch ms when the scan ended
    boxKey: string | null;                     // scope identity for dedupe/stale
  } | null>(null);
  const foundTotalRef = useRef(0);             // authoritative found-count across polls
  const boxKeyOf = (b: BBox | null) => b
    ? [b.minLat, b.maxLat, b.minLng, b.maxLng].map(v => v.toFixed(5)).join(",")
    : null;

  // ── Icon-cluster panels ──
  const [searchOpen, setSearchOpen] = useState(false);
  const [layersOpen, setLayersOpen] = useState(false);
  const searchBtnRef = useRef<HTMLButtonElement | null>(null); // focus returns here on close
  // Leads-in-view panel (right drawer/rail) — viewport bounds captured on a
  // debounced moveend; ref-guarded so a CLOSED panel costs zero React renders
  // while panning. leadsBtnRef gets focus back on Esc/close.
  const [leadsOpen, setLeadsOpen] = useState(false);
  const leadsBtnRef = useRef<HTMLButtonElement | null>(null);
  const [viewBBox, setViewBBox] = useState<BBox | null>(null);
  const leadsOpenRef = useRef(false);
  useEffect(() => { leadsOpenRef.current = leadsOpen; }, [leadsOpen]);
  const bboxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const layersBtnRef = useRef<HTMLButtonElement | null>(null); // focus returns here on layers close

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

  // Selected lead (highlighted after a search fly-to)
  const [selectedLeadId, setSelectedLeadId] = useState<number | null>(null);
  const [legendOpen, setLegendOpen] = useState(false); // manager legend: collapsed dot-strip by default
  const [geocoding, setGeocoding] = useState(false); // street "go to" lookup in flight
  const [sidebarSearch, setSidebarSearch] = useState("");

  // Colored territory regions visibility toggle (rendered from saved territories)
  const [showTerritories, setShowTerritories] = useState(true);

  // Assign-Area (freehand draw) mode
  const [lassoMode, setLassoMode] = useState(false);
  const [lassoPoints, setLassoPoints] = useState<[number, number][]>([]);
  const [lassoSelected, setLassoSelected] = useState<MapPin[]>([]);
  const [lassoRepId, setLassoRepId] = useState("");
  const [lassoName, setLassoName] = useState(""); // optional custom area name; blank → "<Rep>'s area"
  const lassoLayerRef = useRef<boolean>(false);

  // Sidebar filters
  const [filterRep, setFilterRep] = useState<string>("all"); // "all" | "unassigned" | repId
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
  // ONE lead card for every role — reps, team leads, managers, admins all get
  // the same clean sheet (bottom on mobile, docked panel on desktop). The old
  // manager HTML popup is gone; assignment lives as a capability-gated row
  // inside the card itself.
  const useSheet = true;
  const gpsCenteredRef = useRef(false);      // a live fix has positioned the camera — startup fallbacks stand down
  const geoAutoStartedRef = useRef(false);   // auto-trigger fired once for this rep session
  const recentIdsRef = useRef<number[]>([]);   // ring buffer (10) — just-knocked doors exempt from the "unvisited" lens

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
    mutationFn: async ({ polygon, repId, name }: { polygon: [number, number][]; repId: number; name?: string }) => {
      const res = await apiRequest("POST", "/api/territories/assign-area", { polygon, repId, ...(name?.trim() ? { name: name.trim() } : {}) });
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

  // Rename an area — the friendly name reps see on their map. Server keeps an
  // audit trail (territory "renamed" event) and custom names survive reassign.
  const renameTerritoryMutation = useMutation({
    mutationFn: async ({ id, name }: { id: number; name: string }) => {
      const res = await apiRequest("PATCH", `/api/territories/${id}`, { name });
      return res.json();
    },
    onSuccess: (t: { name?: string }) => {
      qc.invalidateQueries({ queryKey: ["/api/territories"] });
      toast({ title: `Area renamed to "${t?.name ?? "area"}"` });
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
  const [activityTerritoryId, setActivityTerritoryId] = useState<number | null>(null); // "View Activity" drawer

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
    setLassoName("");
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
  const { data: mapPinData } = useQuery<{ pins: MapPin[]; total: number }>(
    {
      queryKey: ["/api/leads/map"],
      queryFn: async () => {
        const res = await apiRequest("GET", "/api/leads/map");
        return res.json();
      },
      enabled: !!user,
      staleTime: 30_000,
      retry: 2,
      // Auto-refresh so leads added out-of-band (a scan, the nightly cron,
      // another rep) appear on the map without a manual reload. The server's
      // DB-derived ETag makes an unchanged poll a cheap 304, so this is nearly
      // free when nothing changed. Paused while the tab is hidden (battery/data),
      // and a return to the tab pulls fresh immediately.
      refetchInterval: 60_000,
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: true,
    }
  );
  const leads: MapPin[] = mapPinData?.pins ?? [];
  // O(1) id→lead map — the hot paths (pin tap, knock, card swap) never scan the
  // array. Declared HERE, above the effects that reference it (dep arrays are
  // read during render — a later declaration is a TDZ crash under native ESM).
  const leadById = useMemo(() => new Map(leads.map(l => [l.id, l])), [leads]);
  // Manager-plane data stays OFF rep phones: team (popup/lasso/reassign) and
  // the 30s progress poll are never fetched in rep mode. Territories DO load
  // for reps — a one-shot, tiny payload — so their own area names render on
  // the map (managers name areas; reps navigate by them).
  const { data: team = [] } = useQuery<TeamMember[]>({ queryKey: ["/api/team"], enabled: !!user && !isRep });
  // O(1) rep-name lookup for search rows + the leads panel (team.find per row
  // is O(team) — the wrong pattern to copy anywhere a full list might render).
  // Declared AFTER `team` — dep arrays are read during render (TDZ under ESM).
  const repNameById = useMemo(() => new Map(team.map((m: TeamMember) => [m.id, m.name] as const)), [team]);
  const { data: territories = [] } = useQuery<Territory[]>({ queryKey: ["/api/territories"], enabled: !!user, staleTime: 60_000 });
  const { data: territoryProgress = [] } = useQuery<Array<{
    id: number; knocked: number; total: number; pct: number; sold: number;
    // Location-verified fields (see /api/territories/progress).
    verifiedWorkedLeads: number; areaWorkedPct: number;
    verified: number; needsReview: number; invalid: number;
    avgDistanceM: number | null; maxObservedDistanceM: number | null;
    maxAllowedDistanceM: number; maxAllowedAccuracyM: number;
  }>>({
    queryKey: ["/api/territories/progress"],
    queryFn: async () => (await apiRequest("GET", "/api/territories/progress")).json(),
    enabled: !!user && canAssign,
    refetchInterval: 30000,
  });
  // Expose globally so popup onclick handlers can access current data.
  // NOTE: these effects must stay after `team` is declared — their dependency
  // arrays are read during render, so referencing `team` earlier throws a TDZ
  // error under native ESM (dev), even though esbuild masks it in prod builds.
  useEffect(() => { (window as any).__allLeads = leads; (window as any).__leadById = leadById; }, [leads, leadById]);
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
  // it stays visible in its new state (recolored) so coverage always reads.
  // "Left"/"Done"/"Follow-ups"/"Sold" are opt-in lenses via the filter chips.

  // ── Fetch Mapbox token from server (not in bundle) ──────────────────────────
  const [mapboxToken, setMapboxToken] = useState<string>("");
  const [mapTokenFailed, setMapTokenFailed] = useState(false);

  // Wait for mapboxgl CDN — uses onload callback from index.html, no polling
  useEffect(() => {
    let cancelled = false;
    const init = () => {
      if (cancelled) return;
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
    }

    // Force resize once container is definitely painted
    setTimeout(() => map.resize(), 100);
    setTimeout(() => map.resize(), 400);

    map.addControl(new (window as any).mapboxgl.NavigationControl(), "top-right");
    // "Locate me" — the core field control: center on the rep's position and
    // track it as they walk the street. Triggered by the big thumb FAB below.
    const geolocate = new (window as any).mapboxgl.GeolocateControl({
      // Fresh fixes only (≤1s cache), 10s timeout, high accuracy — the dot must
      // track the rep in real time, not replay a stale reading.
      positionOptions: { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 },
      // Street-level landing: the control's default maxZoom (15) is a block
      // overview — a rep needs to see individual doors when the fix centers.
      fitBoundsOptions: { maxZoom: STREET_ZOOM },
      trackUserLocation: true,
      showUserHeading: true,
    });
    map.addControl(geolocate, "top-right");
    geolocateRef.current = geolocate;
    // Persist the fix (throttled) so the NEXT launch opens on last-known
    // location instantly, before live GPS warms up. A ~1/s tick in follow mode
    // must cause zero React renders — refs and storage only, never state.
    geolocate.on("geolocate", (e: any) => {
      try {
        writeCachedFix(e.coords.latitude, e.coords.longitude, Date.now());
        // First live fix has centered the camera (trigger + trackUserLocation) —
        // the startup fallback effect must never yank the view after this.
        gpsCenteredRef.current = true;
      } catch {}
    });
    // Permission denied / no signal: nothing to do — the launch effect already
    // painted last-known/territory view, and the FAB can re-prompt any time.

    // Toggle a class the stylesheet uses to enable the user-dot glide only
    // while the camera is at rest (see index.css .map-camera-idle rules).
    el.classList.add("map-camera-idle");
    map.on("movestart", () => el.classList.remove("map-camera-idle"));
    map.on("moveend", () => el.classList.add("map-camera-idle"));

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
          "circle-color": ["step",["get","point_count"],"#0d9488",10,"#0f766e",30,"#115e59"],
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
          // Neutral teal DENSITY ramp — clusters mean "how many," never a status.
          // (green/red are reserved for sold/dead pins; reusing them here would
          // make the overview contradict the pin colors at close zoom.)
          "circle-color": [
            "step", ["get", "point_count"],
            "#0d9488", 10,
            "#0f766e", 30,
            "#115e59"
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

      // Worked-vs-unworked is color-only: knocked doors render in their status
      // hue (terminal states pre-dimmed) with a thicker white stroke — no glyph
      // badges on pins, per the field design language.

      // Glow ring for unclustered pins — inserted BENEATH the pin layer so the
      // 0.18-alpha halo never washes over the pin (matches the style-reload
      // block's order).
      map.addLayer({
        id: "lead-unclustered-glow",
        type: "circle",
        source: "leads-cluster",
        filter: ["!", ["has", "point_count"]],
        minzoom: 12,
        paint: UNCLUSTERED_GLOW_PAINT,
      }, "lead-unclustered");

      // Selected-pin ring — driven by setFilter (style-thread only, no setData).
      // Added last so it can never be occluded by pins/glow.
      map.addLayer(SELECTED_RING_SPEC);

      // Provider-native house numbers — fade in at z≥17.2, below our layers.
      ensureHousenumLayer(map, mapStyleMode);

      // Click unclustered pin → show popup
      map.on("click", "lead-unclustered", (e: any) => {
        // No popups while a draw tool is active — a lasso stroke over a pin
        // must not open a card mid-draw.
        if ((window as any).__lassoActive || (window as any).__territoryDrawActive || (window as any).__drawModeActive) return;
        const props = e.features?.[0]?.properties;
        const coords = e.features?.[0]?.geometry?.coordinates?.slice() as [number, number];
        if (!props || !coords) return;
        const lead = (window as any).__leadById?.get(props.id); // O(1), never an array scan
        if (!lead) return;
        // Every role opens the same card. Checked at call time so role/
        // viewport changes never need a rebind.
        (window as any).__openLeadSheet?.(props.id);
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
  }, [mapboxToken]); // re-run when the token arrives

  // ── Update cluster GeoJSON source when leads change ─────────────────────────
  // Cluster setData consolidated into the lead render effect below

  // Territory rings for mid-tier roles — polygons parsed ONCE per territories
  // identity, each with a precomputed bbox. The old code JSON.parsed every
  // polygon PER LEAD (O(n·t) parses — ~50k×t allocations per clip at scale).
  const myTerritoryRings = useMemo(() => {
    if (isAdmin || isRep || !user?.teamMemberId) return null;
    const rings: Array<{ ring: [number, number][]; bbox: BBox2 }> = [];
    for (const t of territories) {
      if (t.repId !== user.teamMemberId) continue;
      try {
        const ring = JSON.parse(t.polygon) as [number, number][];
        if (Array.isArray(ring) && ring.length >= 3) rings.push({ ring, bbox: bboxOfRing(ring) });
      } catch { /* malformed polygon — skip, never crash the map */ }
    }
    return rings.length ? rings : null;
  }, [territories, isAdmin, isRep, user?.teamMemberId]);

  // Territory clip — bbox-reject before the exact shared test (same shape as
  // the lasso path): O(n·t·v) exact-only → O(n·t + k·v).
  const territoryClippedLeads = useMemo(() => {
    if (!myTerritoryRings) return leads;
    return leads.filter(lead => {
      if (!lead.lat || !lead.lng) return false;
      for (const { ring, bbox } of myTerritoryRings) {
        if (lead.lng < bbox.minLng || lead.lng > bbox.maxLng || lead.lat < bbox.minLat || lead.lat > bbox.maxLat) continue;
        if (pointInRing(lead.lat, lead.lng, ring)) return true;
      }
      return false;
    });
  }, [leads, myTerritoryRings]);

  // Territory clip + rep filter — the current "lens" BEFORE the status filter.
  // Legend/status counts read this set, so each status row promises exactly
  // what tapping it will show.
  const repFilteredLeads = useMemo(() => {
    if (!(canAssign && filterRep !== "all")) return territoryClippedLeads;
    return territoryClippedLeads.filter(l =>
      filterRep === "unassigned" ? !l.assignedRepId : l.assignedRepId === Number(filterRep));
  }, [territoryClippedLeads, canAssign, filterRep]);

  // The EXACT set of leads currently painted on the map — territory-clip, then
  // rep filter, then status filter. Single source of truth for the pin layer,
  // the lasso AND the leads panel, so no surface can disagree with the pins.
  const visibleLeads = useMemo(() => {
    if (filterStatus === "all") return repFilteredLeads;
    return repFilteredLeads.filter(l => l.leadStatus === filterStatus);
  }, [repFilteredLeads, filterStatus]);

  // Expose the visible set to the (ref-based) lasso handler.
  useEffect(() => { (window as any).__visibleLeads = visibleLeads; }, [visibleLeads]);

  // GeoJSON Feature cache keyed on pin object identity (see the setData effect).
  const featureCacheRef = useRef(new WeakMap<MapPin, any>());

  // ── Leads panel: viewport bounds lifecycle ────────────────────────────────
  // Attach once per map instance ([mapReady, styleEpoch] — handlers survive
  // setStyle but a re-created map needs rebinding). Debounced 150ms so gesture
  // chains coalesce; the ref guard makes panning with the panel CLOSED free.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const readBounds = () => {
      try {
        const b = map.getBounds();
        setViewBBox({ minLng: b.getWest(), minLat: b.getSouth(), maxLng: b.getEast(), maxLat: b.getNorth() });
      } catch { /* map mid-teardown */ }
    };
    const onMoveEnd = () => {
      if (!leadsOpenRef.current) return;               // panel closed → no work
      if (bboxTimerRef.current) clearTimeout(bboxTimerRef.current);
      bboxTimerRef.current = setTimeout(readBounds, 150);
    };
    map.on("moveend", onMoveEnd);
    return () => {
      if (bboxTimerRef.current) clearTimeout(bboxTimerRef.current);
      try { map.off("moveend", onMoveEnd); } catch {}
    };
  }, [mapReady, styleEpoch]);

  // Prime bounds the instant the panel opens (no gesture required).
  useEffect(() => {
    if (!leadsOpen) return;
    const map = mapRef.current;
    if (!map) return;
    try {
      const b = map.getBounds();
      setViewBBox({ minLng: b.getWest(), minLat: b.getSouth(), maxLng: b.getEast(), maxLat: b.getNorth() });
    } catch {}
  }, [leadsOpen]);

  // What the map PAINTS (same truthiness predicate as the setData loop — a
  // 0,0 coord is excluded identically), then the in-viewport subset sorted
  // nearest-to-map-center: matches the operator's gaze, stable under small
  // pans, needs zero sort chrome. Equirectangular d² is exact enough for
  // ranking at county scale. O(n) filter + O(k log k) sort per debounced move.
  const mapTotalLeads = useMemo(() => visibleLeads.filter(l => l.lat && l.lng), [visibleLeads]);
  const inViewLeads = useMemo(() => {
    if (!viewBBox) return mapTotalLeads;
    const cx = (viewBBox.minLng + viewBBox.maxLng) / 2;
    const cy = (viewBBox.minLat + viewBBox.maxLat) / 2;
    const cos = Math.cos((cy * Math.PI) / 180);
    return mapTotalLeads
      .filter(l => inBBox(l.lat!, l.lng!, viewBBox))
      .map(l => { const dx = (l.lng! - cx) * cos, dy = l.lat! - cy; return [dx * dx + dy * dy, l] as const; })
      .sort((a, b) => a[0] - b[0] || a[1].id - b[1].id)
      .map(([, l]) => l);
  }, [mapTotalLeads, viewBBox]);

  // ── Update cluster GeoJSON when leads/filter/territory changes ───────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const src = map.getSource("leads-cluster") as any;
    if (!src) return;

    // GPU-rendered circle layer — no DOM markers, handles 100k+ points.
    // `ds` = precomputed display state so circle-color stays a flat GPU match.
    // Single pass, and Feature objects are cached per pin IDENTITY: a knock's
    // optimistic update replaces exactly one pin object, so the other 49,999
    // reuse their features instead of re-allocating ~150k objects per knock.
    // (Pin objects are immutable per identity — updates swap the object — so
    // the cache can never serve a stale feature; a refetch replaces every pin
    // identity and the WeakMap self-collects the orphaned generation.)
    const cache = featureCacheRef.current;
    const features: any[] = [];
    for (const l of visibleLeads) {
      if (!l.lat || !l.lng) continue;
      let f = cache.get(l);
      if (!f) {
        f = {
          type: "Feature",
          geometry: { type: "Point", coordinates: [l.lng, l.lat] },
          properties: { id: l.id, status: l.leadStatus, address: l.address, visited: l.visited ? 1 : 0, ds: pinDisplayState(l) },
        };
        cache.set(l, f);
      }
      features.push(f);
    }
    src.setData({ type: "FeatureCollection", features });
    // NOTE: this dep array must NEVER gain selection/sheet state — a pin tap must
    // rebuild zero GeoJSON. Selection is a setFilter on its own effect below.
    // It must also stay free of poll-churned identities (team, territories, user):
    // the memoized visibleLeads absorbs those upstream.
  }, [visibleLeads, mapReady, styleEpoch]);

  // ── Selected-pin ring — pure style-thread update, no setData, no re-cluster ──
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    try { map.setFilter("lead-selected-ring", SELECTED_RING_FILTER(selectedLeadId)); } catch {}
  }, [selectedLeadId, mapReady, styleEpoch]); // styleEpoch: re-apply after style switch

  // ── Field-mode launch: start where the rep is standing ────────────────────────
  // Live GPS is the ONLY anchor (SalesRabbit behavior) — the auto-triggered
  // GeolocateControl below shows the blue dot and keeps it moving with the
  // device. GPS takes seconds though, so paint the best instant guess ONCE:
  // last known GPS fix at street zoom, else lead bounds (managers always get
  // the bounds overview). The moment the live fix lands, the control centers
  // on it and this effect stands down for the session.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || didAutoFitRef.current) return;
    if (gpsCenteredRef.current) { didAutoFitRef.current = true; return; } // live GPS won the race
    if (isRep) {
      const start = pickRepStartCamera(readCachedFix(), Date.now());
      if (start) {
        map.jumpTo({ center: start.center, zoom: start.zoom });
        didAutoFitRef.current = true;
        return;
      }
    }
    // No location signal yet (first run / cleared storage) or manager view:
    // frame the assigned leads so the map is never a blank town center.
    const pts = leads.filter(l => l.lat && l.lng);
    if (pts.length === 0) return;
    try {
      const b = new (window as any).mapboxgl.LngLatBounds();
      pts.forEach(l => b.extend([l.lng!, l.lat!]));
      map.fitBounds(b, { padding: 60, maxZoom: isRep ? STREET_ZOOM : 15, duration: 0 });
      didAutoFitRef.current = true;
    } catch {}
  }, [leads, mapReady, isRep, user]);

  // ── Auto-start live location for reps (SalesRabbit launch behavior) ───────────
  // One trigger per session: prompts for permission if needed, shows the blue
  // dot immediately, centers at street zoom on the first fix, and follows the
  // rep as they walk (trackUserLocation). The Locate FAB re-triggers the same
  // control, so one tap always snaps back to current location.
  useEffect(() => {
    if (!mapReady || !isRep || geoAutoStartedRef.current) return;
    geoAutoStartedRef.current = true;
    try { geolocateRef.current?.trigger(); } catch { /* control not ready — FAB still works */ }
  }, [mapReady, isRep]);

  // ── Render color-coded territory regions (area name + owner label) ─────────
  // Managers/team leads see EVERY area: rep-colored fill + a two-line centroid
  // label "Area name / Rep knocked/total". Reps see ONLY their own areas as a
  // quiet outline + the area name — enough to know where they're working
  // without cluttering the pins they knock.
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

    // Managers can hide the layer from the rail; reps' own areas always show.
    if (canAssign && !showTerritories) return;

    // Rep view: only areas they own (single or shared assignment).
    const myId = user?.teamMemberId ?? null;
    const visible = canAssign ? territories : territories.filter(t => {
      if (myId == null) return false;
      if (t.repId === myId) return true;
      try { const a = JSON.parse((t as any).assigneeIds || "[]"); return Array.isArray(a) && a.includes(myId); } catch { return false; }
    });

    visible.forEach(t => {
      try {
        const status = (t as any).status ?? "active";
        if (status === "archived") return; // archived areas never render
        if (!canAssign && (status === "unassigned" || status === "reclaimed" || status === "completed")) return;
        const coords = JSON.parse(t.polygon) as [number, number][];
        if (coords.length < 3) return;
        const closed = [...coords, coords[0]];
        // Status-aware styling: reclaimed/unassigned areas go GRAY and lose the
        // rep's name; completed areas keep the rep color but muted.
        const isPool = status === "unassigned" || status === "reclaimed";
        const isDone = status === "completed";
        const color = isPool ? "#94a3b8" : colorForRep(t.repId);
        const fillOpacity = !canAssign ? 0.05 : isPool ? 0.10 : isDone ? 0.08 : 0.14;
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
            paint: { "line-color": color, "line-width": !canAssign ? 1.75 : isPool ? 2 : 2.5,
              "line-opacity": !canAssign ? 0.65 : isPool ? 0.7 : 0.9,
              ...(isPool ? { "line-dasharray": [3, 2] } : {}) } });
        }
        // Centroid label. Reps: the area NAME only. Managers: name + owner line
        // ("Rep knocked/total"); "Unassigned" once reclaimed (the old rep's
        // name must NOT linger on the area).
        const cx = coords.reduce((s, p) => s + p[0], 0) / coords.length;
        const cy = coords.reduce((s, p) => s + p[1], 0) / coords.length;
        const areaName = (t.name ?? "").trim();
        let label = areaName;
        if (canAssign) {
          const prog = territoryProgress.find(p => p.id === t.id);
          const repName = team.find(m => m.id === t.repId)?.name?.split(" ")[0] ?? "";
          const ownerLine = isPool ? "Unassigned"
            : isDone ? `Done — ${repName}`
            : (prog ? `${repName}  ${prog.knocked}/${prog.total}` : repName);
          label = areaName && ownerLine && areaName !== ownerLine ? `${areaName}\n${ownerLine}` : (areaName || ownerLine);
        }
        if (label && !map.getSource(srcId + "-label-src")) {
          map.addSource(srcId + "-label-src", {
            type: "geojson", data: { type: "Feature", geometry: { type: "Point", coordinates: [cx, cy] }, properties: {} }
          });
          map.addLayer({
            id: srcId + "-label", type: "symbol", source: srcId + "-label-src",
            layout: { "text-field": label, "text-size": 12, "text-line-height": 1.3,
              "text-font": ["DIN Offc Pro Medium", "Arial Unicode MS Bold"], "text-allow-overlap": false },
            paint: { "text-color": "#ffffff", "text-halo-color": isPool ? "#475569" : color, "text-halo-width": 2,
              ...(canAssign ? {} : { "text-opacity": 0.9 }) },
          });
        }
        territoryLayersRef.current.push(srcId);
      } catch {}
    });
  }, [territories, territoryProgress, team, mapReady, showTerritories, canAssign, user?.teamMemberId, styleEpoch]);

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
          paint: { "circle-color": ["step",["get","point_count"],"#0d9488",10,"#0f766e",30,"#115e59"],
            "circle-radius": ["step",["get","point_count"],26,10,33,30,42], "circle-opacity": 0.25 },
        });
        map.addLayer({
          id: "lead-clusters", type: "circle", source: "leads-cluster",
          filter: ["has", "point_count"], maxzoom: 13.5,
          paint: {
            "circle-color": ["step",["get","point_count"],"#0d9488",10,"#0f766e",30,"#115e59"],
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
      // House numbers are style layers too — re-enable on the fresh style with
      // the palette that suits it (white-on-imagery vs ink-on-streets).
      ensureHousenumLayer(map, mapStyleMode);
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

    // Point-in-polygon lives in lib/mapGeo.ts (bbox-rejected, unit-tested).

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
      // Select from the VISIBLE set (territory-clip + rep + status filters), so
      // a lasso only ever selects leads the user can actually see and assign —
      // never a hidden lead. Falls back to all leads if the map hasn't published
      // a filtered set yet. Bbox-rejected O(n + k·v) (see lib/mapGeo.ts).
      const source: MapPin[] = (window as any).__visibleLeads ?? (window as any).__allLeads ?? [];
      const selected = selectPointsInPolygon(source, stroke);
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
    return () => { document.head.removeChild(style); };
  }, []);

  // ── Draw bbox helpers ─────────────────────────────────────────────────────
  const updateDrawLayer = useCallback((bbox: BBox) => {
    const src = mapRef.current?.getSource("draw-bbox") as any;
    src?.setData({ type: "Feature", geometry: { type: "Polygon", coordinates: [[
      [bbox.minLng, bbox.minLat], [bbox.maxLng, bbox.minLat],
      [bbox.maxLng, bbox.maxLat], [bbox.minLng, bbox.maxLat],
      [bbox.minLng, bbox.minLat],
    ]] }, properties: {} });
  }, []);

  const clearDrawLayer = useCallback(() => {
    const src = mapRef.current?.getSource("draw-bbox") as any;
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

  // Belt-and-suspenders: kill the scan poll interval on unmount so a scan in
  // flight when the user navigates away can't keep firing setState/apiRequest
  // (and, if the job 404s post-GC, poll forever).
  useEffect(() => () => stopPolling(), [stopPolling]);

  // Transient scan dots are DOM markers (Mapbox repositions each on every map
  // move) — cap the count so a large fresh-build scan can't turn panning into
  // O(n) main-thread work. Found leads still land as GPU pins via the live
  // refresh; the dots are just an at-a-glance "found here" hint.
  const MAX_SCAN_DOTS = 400;
  const addScanDot = useCallback((row: ScanRow & { leadTag?: string | null; leadScore?: number }) => {
    const map = mapRef.current;
    if (!map || !row.lat || !row.lng) return;
    if (scanMarkersRef.current.length >= MAX_SCAN_DOTS) return; // bounded marker budget

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
      bg = "#22c55e"; border = "#86efac"; glow = "rgba(34,197,94,0.8)"; size = 12; label = "HOT LEAD";
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
      // ?since cursor: the server returns only rows we haven't rendered yet —
      // a long scan no longer re-downloads its whole cumulative result set
      // every 400ms (was O(total²) bytes + re-parse over the scan's lifetime).
      const res = await apiRequest("GET", `/api/scan/${id}?since=${lastRenderedCount.current}`);
      const status: ScanJobStatus & { resultCount?: number } = await res.json();
      setDone(status.done);
      setTotal(status.total);
      const newRows = status.results ?? [];
      lastRenderedCount.current = status.resultCount ?? (lastRenderedCount.current + newRows.length);
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
      if (found > 0) { foundTotalRef.current += found; setNewFound(p => p + found); }

      // Live lead refresh: pull newly-saved leads onto the map every ~25 polls
      // (~10s) while scanning. Found addresses already appear INSTANTLY as scan
      // dots (addScanDot above) — this refresh only converts them to assignable
      // pins, so 10s is invisible to the operator, while each refresh at 50k
      // leads costs a full payload + GeoJSON rebuild + re-cluster (was every ~3s).
      pollTickRef.current += 1;
      if (found > 0 && pollTickRef.current % 25 === 0) {
        qc.invalidateQueries({ queryKey: ["/api/leads/map"] });
      }

      if (status.status === "done") {
        stopPolling(); setScanning(false);
        setScanOutcome({ kind: foundTotalRef.current > 0 ? "success" : "empty", found: foundTotalRef.current, at: Date.now(), boxKey: boxKeyOf(bbox ?? null) });
        qc.invalidateQueries({ queryKey: ["/api/leads"] }); qc.invalidateQueries({ queryKey: ["/api/leads/map"] });
      } else if (status.status === "error") {
        // Previously unhandled: an errored job kept polling forever with the
        // control stuck on "scanning". Now it lands as an explicit error state.
        stopPolling(); setScanning(false);
        setScanOutcome({ kind: "error", found: foundTotalRef.current, at: Date.now(), boxKey: boxKeyOf(bbox ?? null) });
      }
    } catch { /* transient fetch hiccup — keep polling */ }
  }, [addScanDot, stopPolling, qc]);

  const startScan = useCallback(async (endpoint: string, body: object) => {
    if (!mapReady) return;
    scanMarkersRef.current.forEach(m => m.remove());
    scanMarkersRef.current = []; lastRenderedCount.current = 0; pollTickRef.current = 0;
    foundTotalRef.current = 0;
    setNewFound(0); setDone(0); setError(null); setScanOutcome(null);
    stopPolling(); setScanning(true);
    try {
      const res = await apiRequest("POST", endpoint, body);
      const { jobId: id, total: t } = await res.json();
      setJobId(id); setTotal(t);
      pollRef.current = setInterval(() => pollJob(id, drawnBBox ?? undefined), POLL_MS);
    } catch (e: any) {
      setScanning(false); setError(e.message);
      setScanOutcome({ kind: "error", found: 0, at: Date.now(), boxKey: boxKeyOf(drawnBBox) });
    }
  }, [mapReady, stopPolling, pollJob, drawnBBox]);

  const stopScan = useCallback(async () => {
    stopPolling();
    if (jobId) { try { await apiRequest("DELETE", `/api/scan/${jobId}`); } catch {} }
    setScanning(false);
    // Deliberate stop: keep whatever was found so far, say so explicitly.
    setScanOutcome({ kind: "cancelled", found: foundTotalRef.current, at: Date.now(), boxKey: boxKeyOf(drawnBBox) });
  }, [stopPolling, jobId, drawnBBox]);

  // ── Escape hatch — one keyboard path out of every map tool, in priority
  // order: open panel → armed lasso → armed/boxed scan. Search close returns
  // focus to the magnifier so keyboard users never lose their place. Defined
  // AFTER stopScan/exitLasso (deps evaluate at render — TDZ otherwise).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (searchOpen) {
        setSearchOpen(false); setSidebarSearch("");
        searchBtnRef.current?.focus();
      } else if (layersOpen) {
        setLayersOpen(false);
        layersBtnRef.current?.focus();
      } else if (leadsOpen) {
        setLeadsOpen(false);
        leadsBtnRef.current?.focus();
      } else if (lassoMode) {
        exitLasso();
      } else if (drawMode || drawnBBox) {
        setDrawMode(false); setDrawnBBox(null);
        if (scanning) void stopScan();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [searchOpen, layersOpen, leadsOpen, lassoMode, drawMode, drawnBBox, scanning, exitLasso, stopScan]);

  // Auto-focus the search field the instant the panel opens (next frame, after
  // the element mounts) — the magnifier is a search affordance, not a toggle.
  useEffect(() => {
    if (!searchOpen) return;
    const r = requestAnimationFrame(() => searchInputRef.current?.focus());
    return () => cancelAnimationFrame(r);
  }, [searchOpen]);

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
    // The card opens via selectedLeadId; camera padding keeps the pin visible
    // beside/above it (docked panel or bottom sheet).
    moveCamera(map, {
      center: target, zoom: Math.max(map.getZoom?.() ?? 16, 16.5),
      padding: { top: 0, left: 0, right: 0, bottom: sheetPeekPaddingPx() },
      duration: 600, essential: true,
    });
  }, []);

  // "Next door" — the map's next-best-property flow. Same routing brain as the
  // Today hero (shared nearestUnworkedLead): from where the rep is STANDING
  // (fresh/cached GPS via captureFieldFix — never rejects; falls back to the
  // map center), fly to the nearest unworked/not-home door, skipping the doors
  // just worked this session (recentIdsRef), and open its knock sheet.
  const nextBestDoor = useCallback(() => {
    const open = leads.filter(p => {
      const s = pinDisplayState(p);
      return (s === "unworked" || s === "not_home") && p.lat != null && p.lng != null;
    });
    if (!open.length) {
      toast({ title: "Every door is worked", description: "No open doors on your map right now — nice work." });
      return;
    }
    captureFieldFix().then(fix => {
      const c = mapRef.current?.getCenter?.();
      const from = fix.repLat != null && fix.repLng != null
        ? { lat: fix.repLat, lng: fix.repLng }
        : c ? { lat: c.lat, lng: c.lng } : { lat: open[0].lat!, lng: open[0].lng! };
      const exclude = new Set(recentIdsRef.current);
      const next = (nearestUnworkedLead(from, open as unknown as RoutablePin[], exclude) as MapPin | null) ?? open[0];
      flyToLead(next);
    });
  }, [leads, flyToLead, toast]);

  // Leads-panel row tap — the SAME path a pin tap takes (flyToLead →
  // setSelectedLeadId → card/sheet). Phone closes the drawer to reveal the map.
  const onLeadsRowTap = useCallback((id: number) => {
    const lead = leadById.get(id);
    if (!lead) return;
    if (!window.matchMedia("(min-width: 1024px)").matches) setLeadsOpen(false);
    flyToLead(lead);
  }, [leadById, flyToLead]);

  // Fit the camera to every painted lead (the FILTERED set — fitting hidden
  // pins would frame an empty view). fitBounds fires moveend → list refreshes.
  const fitAllLeads = useCallback(() => {
    const map = mapRef.current;
    if (!map || mapTotalLeads.length === 0) return;
    try {
      const b = new (window as any).mapboxgl.LngLatBounds();
      for (const l of mapTotalLeads) b.extend([l.lng, l.lat]);
      map.fitBounds(b, { padding: 60, maxZoom: 15 });
    } catch { /* map mid-teardown */ }
  }, [mapTotalLeads]);

  // Memoized so these full-array passes over all leads don't re-run on every
  // render (the map re-renders ~every 400ms during a scan). Counts read the
  // CURRENT LENS (territory clip + rep filter) so every legend row and the
  // filter pill state exactly what selecting that status will paint.
  const statusCounts = useMemo(() => {
    const acc: Record<string, number> = {};
    for (const s of Object.keys(PIN_COLORS)) acc[s] = 0;
    for (const l of repFilteredLeads) if (acc[l.leadStatus] !== undefined) acc[l.leadStatus]++;
    return acc;
  }, [repFilteredLeads]);

  // Per-rep lead tallies for the legend's rep dropdown — ONE counting pass,
  // memoized. The options used to run leads.filter(...) per rep per render:
  // O(n·reps) ≈ 2.5M predicate calls/render at 50k leads × 50 reps, at 400ms
  // render cadence during a scan. Counted over the territory-clipped lens so
  // each option states exactly what selecting it will paint.
  const repLeadCounts = useMemo(() => {
    const counts = new Map<number, number>();
    let unassigned = 0;
    for (const l of territoryClippedLeads) {
      if (l.assignedRepId == null) unassigned++;
      else counts.set(l.assignedRepId, (counts.get(l.assignedRepId) ?? 0) + 1);
    }
    return { counts, unassigned };
  }, [territoryClippedLeads]);

  // On-map search — lowercase haystack built ONCE per data load (O(n)), so a
  // keystroke never re-lowercases 50k addresses. " " separates the two
  // fields so a query can't falsely match across the address/city boundary.
  const searchIndex = useMemo(
    () => leads.map(l => ({ l, hay: (l.address + " " + (l.city ?? "")).toLowerCase() })),
    [leads],
  );
  // Deferred query: typing stays responsive; the scan lags a frame at worst.
  const deferredSearch = useDeferredValue(sidebarSearch);
  const searchMatches = useMemo(() => {
    const q = deferredSearch.trim().toLowerCase();
    if (!q) return [];
    // Single pass keeping the top 8 by leadScore — no full sort of every match
    // (a 1-char query can match tens of thousands of rows at scale). Ties
    // break on higher id (newer lead first) so truncation is deterministic —
    // the source array is unordered now that getLeadsForMap dropped ORDER BY.
    const rank = (p: MapPin) => p.leadScore ?? 0;
    const top: MapPin[] = [];
    for (const { l, hay } of searchIndex) {
      if (!l.lat || !l.lng || !hay.includes(q)) continue;
      let i = top.length;
      while (i > 0 && (rank(top[i - 1]) < rank(l) || (rank(top[i - 1]) === rank(l) && top[i - 1].id < l.id))) i--;
      if (i < 8) {
        top.splice(i, 0, l);
        if (top.length > 8) top.pop();
      }
    }
    return top;
  }, [searchIndex, deferredSearch]);

  // ── Knock queue — offline-first saves, idempotent via clientId ──────────────
  // Module-level singleton per rep: it keeps flushing queued knocks even if the
  // rep navigates away from the map, so we never destroy() it on unmount.
  const knockQueue: KnockQueue | null = useMemo(() => {
    if (!user || !useSheet) return null;
    return getKnockQueue({
      repId: user.teamMemberId ?? 0,
      post: (url, body) => apiRequest("POST", url, body).then(r => r.json()),
      patch: (url, body) => apiRequest("PATCH", url, body).then(r => r.json()),
      onSaved: (leadId: number) => {
        qc.invalidateQueries({ queryKey: ["/api/leaderboard"] });
        qc.invalidateQueries({ queryKey: ["/api/leads"] });
        // The card's History timeline shows the new entry as soon as the POST lands.
        qc.invalidateQueries({ queryKey: [`/api/leads/${leadId}/history`] });
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.teamMemberId, useSheet]);
  const subscribeQueue = useCallback((cb: () => void) => knockQueue ? knockQueue.subscribe(cb) : () => {}, [knockQueue]);
  const getQueueSnap = useCallback(() => knockQueue ? knockQueue.getSnapshot() : EMPTY_QUEUE_SNAP, [knockQueue]);
  const queueSnap = useSyncExternalStore(subscribeQueue, getQueueSnap);

  const selectedLead = selectedLeadId != null ? (leadById.get(selectedLeadId) ?? null) : null;

  // One-tap disposition: optimistic pin recolor FIRST (marking a door must feel
  // instant in the field), then the offline-safe enqueue. The queue owns
  // retries/idempotency; react-query owns rollback via onSaved invalidations.
  // The card's chip, timestamp, and active pill all read from this same
  // optimistic pin data, so a single tap updates everything at once.
  const handleKnock = useCallback((outcome: KnockOutcome) => {
    const lead = selectedLeadId != null ? leadById.get(selectedLeadId) : undefined;
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
    recentIdsRef.current = [...recentIdsRef.current.slice(-9), lead.id];
    // Capture WHERE the rep is standing at the tap so the server can verify the
    // work. Non-blocking: the pin already recolored above; we attach the fix and
    // enqueue when it resolves (a recent cached fix returns almost instantly, a
    // denied/absent one enqueues location-less → server marks it Needs Review).
    captureFieldFix().then(fix => {
      knockQueue.enqueue({ leadId: lead.id, repId: credit, outcome, callbackDate: null, callbackTime: null, ...fix });
    });
    // Sold pays: the server auto-creates a pending commission with this knock.
    // Un-marking a sale reverses it. Refresh the Commission tab either way.
    if (outcome === "sold") {
      toast({ title: "Sold — commission entry created", description: "Pending review in the Commission tab" });
      qc.invalidateQueries({ queryKey: ["/api/commissions"] });
      qc.invalidateQueries({ queryKey: ["/api/commissions/summary"] });
    } else if (lead.leadStatus === "sold") {
      // Was sold, now marked otherwise → the server drops its pending commission.
      toast({ title: "Sale removed — pending commission reversed" });
      qc.invalidateQueries({ queryKey: ["/api/commissions"] });
      qc.invalidateQueries({ queryKey: ["/api/commissions/summary"] });
    }
  }, [leadById, selectedLeadId, knockQueue, isRep, user, qc, toast]);

  // Lead-level notes: the card owns typing; this owns persistence through the
  // offline-safe, conflict-aware pipeline in lib/leadNotes. Explicit leadId so
  // the card can flush the OUTGOING lead's pending note during a swap.
  const notePoster = useCallback<NotePoster>(
    (leadId, body) => apiRequest("PATCH", `/api/leads/${leadId}/notes`, body),
    [],
  );
  const handleSaveNote = useCallback(async (leadId: number, note: string, baseUpdatedAt: string | null): Promise<NoteSaveResult> => {
    const result = await saveLeadNote(notePoster, leadId, note, baseUpdatedAt);
    if (result.status === "saved") {
      qc.invalidateQueries({ queryKey: [`/api/leads/${leadId}`] });
      qc.invalidateQueries({ queryKey: [`/api/leads/${leadId}/history`] }); // note event just landed
    }
    return result;
  }, [notePoster, qc]);

  // Stashed offline notes flush the moment connectivity returns (and once on
  // mount, in case the app reloaded while offline notes were pending).
  useEffect(() => {
    const flush = () => { void flushPendingNotes(notePoster); };
    flush();
    window.addEventListener("online", flush);
    return () => window.removeEventListener("online", flush);
  }, [notePoster]);

  // Stable identity so the memoized card never re-renders for MapView churn.
  const closeSheet = useCallback(() => setSelectedLeadId(null), []);

  // Rep assignment lives on the manager popup path (window.__assignRep) only —
  // the rep card carries zero admin actions.

  // Camera padding: keep the tapped pin visible above the peek sheet; restore
  // padding (never the center — the rep keeps their pan position) on close.
  const sheetWasOpenRef = useRef(false);
  useEffect(() => {
    if (!useSheet) return;
    const map = mapRef.current;
    if (!map || !mapReady) return;
    // ≥1024px the card docks right (380px panel) — pad that edge instead of
    // the bottom so the selected pin still sits in the visible map area.
    let dockedPanel = false;
    try { dockedPanel = window.matchMedia("(min-width: 1024px)").matches; } catch { /* jsdom */ }
    const openPad = dockedPanel
      ? { top: 0, left: 0, right: 396, bottom: 0 }
      : { top: 0, left: 0, right: 0, bottom: sheetPeekPaddingPx() };
    if (selectedLeadId != null) {
      sheetWasOpenRef.current = true;
      const lead = leadById.get(selectedLeadId);
      if (lead?.lat && lead?.lng) {
        moveCamera(map, { center: [lead.lng, lead.lat], padding: openPad, duration: 350, essential: true });
      }
    } else if (sheetWasOpenRef.current) {
      sheetWasOpenRef.current = false;
      moveCamera(map, { padding: { top: 0, left: 0, right: 0, bottom: 0 }, duration: 250 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLeadId, mapReady, useSheet]);

  // No resume system — live GPS is the anchor. The rep opens the app where
  // they stand; the blue dot is always on and moves with the device.

  // Selected-pin pulse: a slow breathing halo on the ring layer so the active
  // door is findable at a glance. Pure style-thread paint updates (no setData,
  // no React state per frame); disabled under prefers-reduced-motion.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || selectedLeadId == null) return;
    let reduce = false;
    try { reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { /* jsdom */ }
    if (reduce) return;
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const phase = (Math.sin((now - start) / 450) + 1) / 2; // 0..1, ~2.8s cycle
      try {
        map.setPaintProperty("lead-selected-ring", "circle-radius", 14 + phase * 6);
        map.setPaintProperty("lead-selected-ring", "circle-stroke-opacity", 0.95 - phase * 0.45);
      } catch { /* layer mid-reload */ }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      try {
        map.setPaintProperty("lead-selected-ring", "circle-radius", 14);
        map.setPaintProperty("lead-selected-ring", "circle-stroke-opacity", 0.95);
      } catch { /* map torn down */ }
    };
  }, [selectedLeadId, mapReady, styleEpoch]);

  // noToken is true only after we confirmed the token is unavailable (never during load)
  const noToken = mapTokenFailed;

  // A completed scan goes STALE when its box scope is cleared or redrawn — the
  // result no longer describes what's on the map. Drives the control's stale
  // state + the "rescan" affordance, and blocks a redundant same-box rescan.
  const scanStale = !!scanOutcome && scanOutcome.boxKey !== boxKeyOf(drawnBBox);

  return (
    <div className="flex flex-col relative" style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>

      {/* ── FULL-BLEED MAP (owner spec): no toolbar for ANY role. The rep
             filter lives in the legend panel; Assign Area + Scan Area live on
             the control rail; banners FLOAT over the map (the page root is
             relative, so this stack overlays the map below). ── */}
      {/* Screen-reader scan announcements — MILESTONES only (start + outcome),
          never the per-poll progress ticks that would spam a screen reader. */}
      <div className="sr-only" role="status" aria-live="polite" data-testid="scan-sr">
        {scanning ? "Scanning the selected area." : scanOutcome && !scanStale ? (
          scanOutcome.kind === "success" ? `Scan complete. ${scanOutcome.found} new-fiber lead${scanOutcome.found === 1 ? "" : "s"} found.`
          : scanOutcome.kind === "empty" ? "Scan complete. No new fiber found in this area."
          : scanOutcome.kind === "error" ? "Scan failed."
          : scanOutcome.kind === "cancelled" ? `Scan stopped. ${scanOutcome.found} found so far.` : ""
        ) : ""}
      </div>

      {/* On mobile: left-3 → right-[68px] so the banner clears the icon cluster
          in the top-right corner. On desktop: centered. */}
      <div style={{ top: "calc(env(safe-area-inset-top) + 6.75rem)" }} className="absolute left-3 right-[68px] md:top-16 md:left-1/2 md:right-auto md:-translate-x-1/2 md:w-[min(620px,calc(100vw-24px))] z-30 space-y-1.5 pointer-events-none [&>*]:pointer-events-auto">

      {/* ── Scan panel — the scan tool's full state surface. Scope is always the
             DRAWN BOX. Communicates: drawing → box drawn → scanning → a result
             (found / empty / error / cancelled) that goes stale if the box
             changes. A fresh same-box result offers Rescan, never auto-repeats
             the expensive scan. ── */}
      {(drawMode || drawnBBox || scanning || (scanOutcome && !scanStale)) && isAdmin && (() => {
        const freshSameBox = !!scanOutcome && !scanStale && scanOutcome.boxKey === boxKeyOf(drawnBBox);
        return (
        <div className={`glass-surface px-3 py-2 flex flex-wrap items-center gap-2 ${
          scanOutcome?.kind === "error" ? "border-red-500/50" : scanOutcome?.kind === "success" ? "border-emerald-500/40" : "border-orange-500/40"
        }`} data-testid="scan-panel">
          <span className="text-[11px] flex items-center gap-1.5 text-white/80">
            {scanning ? <><Loader2 className="w-3 h-3 animate-spin" /> Scanning {total ? `${done}/${total}` : ""} · {newFound} new fiber</>
              : freshSameBox && scanOutcome?.kind === "success" ? <><CheckCircle2 className="w-3 h-3 text-emerald-400" /> Found {scanOutcome.found} new-fiber lead{scanOutcome.found === 1 ? "" : "s"} in this area</>
              : freshSameBox && scanOutcome?.kind === "empty" ? <>No new fiber in this area right now</>
              : freshSameBox && scanOutcome?.kind === "error" ? <><AlertCircle className="w-3 h-3 text-red-400" /> Scan failed — try again</>
              : freshSameBox && scanOutcome?.kind === "cancelled" ? <>Scan stopped · {scanOutcome.found} found so far</>
              : scanStale ? <>Area changed — rescan for current results</>
              : drawnBBox ? "Box drawn — pick a scan (green dots = new fiber)"
              : "Drag a box over the homes to scan"}
          </span>
          {drawnBBox && !scanning && !freshSameBox && (
            <>
              <Button size="sm" variant="outline"
                className="border-orange-500/40 text-orange-400 hover:bg-orange-500/10 h-11 text-[12px] px-3 rounded-xl"
                onClick={() => startScan("/api/scan/area", { minLat: drawnBBox.minLat, maxLat: drawnBBox.maxLat, minLng: drawnBBox.minLng, maxLng: drawnBBox.maxLng })}>
                <Radar className="w-3 h-3 mr-1" /> Quick scan · free
              </Button>
              <Button size="sm"
                disabled={!areaEstimate || areaEstimate.overCap}
                className="bg-orange-500 hover:bg-orange-600 text-white h-11 text-[12px] px-3 rounded-xl disabled:opacity-50"
                title={areaEstimate?.overCap ? "Box too big — draw a smaller box" : "Finds every address via Mapbox grid"}
                onClick={() => startScan("/api/scan/area", { minLat: drawnBBox.minLat, maxLat: drawnBBox.maxLat, minLng: drawnBBox.minLng, maxLng: drawnBBox.maxLng, deep: true })}>
                <Radar className="w-3 h-3 mr-1" />
                {areaEstimate ? `Deep · ~${areaEstimate.estAddresses.toLocaleString()} · ${areaEstimate.withinFreeTier ? "free" : "$" + areaEstimate.estCostUsd}` : "Deep scan…"}
              </Button>
              {areaEstimate?.overCap && <span className="text-[10px] text-orange-400/60">box too big — draw smaller</span>}
            </>
          )}
          {/* Fresh result for THIS box → deliberate Rescan only (no silent repeat) */}
          {freshSameBox && drawnBBox && (
            <Button size="sm" variant="outline" className="border-white/20 text-white/80 hover:bg-white/10 h-11 text-[12px] px-3 rounded-xl"
              data-testid="scan-rescan"
              onClick={() => startScan("/api/scan/area", { minLat: drawnBBox.minLat, maxLat: drawnBBox.maxLat, minLng: drawnBBox.minLng, maxLng: drawnBBox.maxLng })}>
              <RefreshCw className="w-3 h-3 mr-1" /> Rescan
            </Button>
          )}
          {scanning && (
            <Button size="sm" variant="ghost" className="text-red-400 h-11 text-[12px] rounded-xl" onClick={() => stopScan()}>Stop</Button>
          )}
          <Button size="sm" variant="ghost" className="text-white/70 hover:text-white h-11 w-11 rounded-xl ml-auto" aria-label="Close scan"
            onClick={() => { setDrawMode(false); setDrawnBBox(null); setScanOutcome(null); if (scanning) stopScan(); }}>
            <X className="w-3.5 h-3.5" />
          </Button>
        </div>
        );
      })()}
      {/* Lasso UI moved to a floating bottom action bar inside the map (below) */}

      {error && (
        <div className="glass-surface glass-opaque px-3 py-2 border-red-500/40 text-[11px] text-red-400 flex items-center gap-2">
          <AlertCircle className="w-3 h-3" /> {error}
        </div>
      )}
      {canManage && pendingRequests.length > 0 && (
        <div className="glass-surface glass-opaque border-amber-500/40 overflow-hidden">
          <button className="w-full flex items-center gap-2 px-3 min-h-[44px] text-[11px] font-medium text-amber-400 hover:bg-amber-500/10" onClick={() => setShowTerritoryRequests(v => !v)}>
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

      </div>{/* /floating banner stack */}

      {/* ── Main: map + sidebar ── */}
      <div className="flex flex-1 min-h-0 overflow-hidden">

        {/* MAP */}
        <div className="relative flex-1 min-w-0">
          <div style={{ position: "absolute", inset: 0 }}>
            {/* rep-clean-map hides the native Mapbox zoom/compass/geolocate stack.
                On mobile it's hidden for EVERY role — the native stack lives in
                the same top-right corner as our icon cluster and would collide;
                pinch-zoom + the locate FAB cover its function. Desktop keeps the
                native zoom/compass (no cluster collision, useful for mouse). */}
            <div ref={mapContainer} className={isMobile ? "rep-clean-map" : undefined} style={{ width: "100%", height: "100%" }} />
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

          {/* Floating menu — the map is full-bleed (no header/tabs), so this is
              the ONE way back to the rest of the app on mobile. All roles. */}
          <button
            type="button"
            aria-label="Open navigation menu"
            data-testid="map-menu-button"
            onClick={() => window.dispatchEvent(new CustomEvent("hfs:open-menu"))}
            style={{ top: "calc(env(safe-area-inset-top) + 0.75rem)" }}
            className="glass-capsule md:hidden absolute left-3 z-30 h-11 w-11 flex items-center justify-center text-white/90 active:scale-[0.97] transform-gpu transition"
          >
            <Menu className="w-4.5 h-4.5" style={{ width: 18, height: 18 }} aria-hidden="true" />
          </button>

          {/* First-use empty state — a brand-new org with no leads gets guidance,
              not a blank map over a random town. */}
          {mapReady && !isRep && leads.length === 0 && (
            <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none px-6">
              <div className="glass-surface pointer-events-auto max-w-xs text-center p-6">
                <div className="w-12 h-12 rounded-2xl bg-primary/15 border border-primary/25 flex items-center justify-center mx-auto mb-3">
                  <MapIcon className="w-6 h-6 text-primary" />
                </div>
                <p className="text-sm font-semibold text-white">No leads on the map yet</p>
                <p className="text-xs text-white/60 mt-1.5 leading-relaxed">
                  {isAdmin
                    ? "Draw a box with the scan tool to find new-fiber homes, or import a list — they'll appear here as assignable pins."
                    : "Once your team is assigned leads or territories, they'll show up here."}
                </p>
              </div>
            </div>
          )}

          {/* The lead-count chip was removed — the map speaks for itself; a raw
              "3355 pins" tally added noise without operational value. An active
              status filter still needs a visible, clearable indication, so a
              minimal filter pill survives (only when a filter is applied). */}
          {mapReady && !isRep && leads.length > 0 && filterStatus !== "all" && (
            <div style={{ top: "calc(env(safe-area-inset-top) + 0.75rem)" }} className="glass-capsule glass-opaque absolute left-[64px] md:left-3 md:top-3 z-10 flex items-center gap-2 pl-3 pr-1.5 min-h-[36px]">
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: PIN_COLORS[filterStatus]?.bg ?? "#0d9488" }} />
              <span className="text-[11px] font-medium text-white/80">
                {statusCounts[filterStatus] ?? 0} {PIN_COLORS[filterStatus]?.label ?? filterStatus}
              </span>
              <button
                onClick={() => setFilterStatus("all")}
                aria-label="Clear filter"
                className="relative w-7 h-7 rounded-full flex items-center justify-center text-white/70 hover:text-white hover:bg-white/10 transition after:absolute after:-inset-2"
              >
                <X className="w-3 h-3" aria-hidden="true" />
              </button>
            </div>
          )}

          {/* ── Search PANEL — opens only from the magnifier (no permanent bar).
                 Scoped to the org's leads via the same /api/leads data the map
                 already loads (server tenant-filters it); admin street "go to"
                 uses the existing geocode fallback. Esc / × / backdrop close it
                 and return focus to the magnifier. ── */}
          {mapReady && !isRep && searchOpen && (
            <>
              <div className="absolute inset-0 z-20" onClick={() => { setSearchOpen(false); setSidebarSearch(""); searchBtnRef.current?.focus(); }} />
              <div
                role="dialog" aria-label="Search locations" aria-modal="false"
                // Phone: pinned left-3 → right-[72px] so the field AND its close
                // button clear the control cluster (they underlapped it — tapping
                // the ghosted × opened the leads drawer; review finding).
                className="absolute top-[60px] md:top-3 left-3 right-[72px] md:left-1/2 md:right-auto md:-translate-x-1/2 z-30 md:w-[min(440px,calc(100vw-24px))]"
                onClick={e => e.stopPropagation()}
              >
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/50" />
                  <input
                    ref={searchInputRef}
                    value={sidebarSearch}
                    onChange={e => setSidebarSearch(e.target.value)}
                    placeholder="Search a street or address…"
                    aria-label="Search a street or address"
                    data-testid="map-search"
                    className="glass-surface w-full h-11 rounded-full pl-9 pr-10 text-sm text-white placeholder:text-white/55 focus:outline-none focus:ring-2 focus:ring-teal-400"
                  />
                  <button
                    onClick={() => { setSearchOpen(false); setSidebarSearch(""); searchBtnRef.current?.focus(); }}
                    aria-label="Close search"
                    data-testid="map-search-close"
                    className="absolute right-1 top-1/2 -translate-y-1/2 h-9 w-9 flex items-center justify-center rounded-full text-white/70 hover:text-white hover:bg-white/10 after:absolute after:-inset-1"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
                {searchMatches.length > 0 && (
                  // glass-opaque: text-dense + keeps the worst-case simultaneous
                  // blur count at ≤5 surfaces (review measured 6 with it blurred).
                  <div className="glass-surface glass-opaque mt-1.5 overflow-hidden max-h-[min(60vh,360px)] overflow-y-auto">
                    {searchMatches.map(l => {
                      // TRUE pin hue/label (pinDisplayState) — a callback door
                      // shows cyan "Callback" here exactly as painted on the map.
                      const ds = pinDisplayState(l);
                      const dsColor = STATE_COLORS[ds];
                      const repName = l.assignedRepId ? repNameById.get(l.assignedRepId) : null;
                      return (
                        <button
                          key={l.id}
                          onClick={() => { flyToLead(l); setSearchOpen(false); setSidebarSearch(""); searchBtnRef.current?.focus(); }}
                          className="w-full flex items-center gap-2.5 px-3 py-2.5 min-h-[44px] text-left hover:bg-white/10 transition-colors border-b border-white/[0.08] last:border-0"
                        >
                          <span className="w-2.5 h-2.5 rounded-full flex-shrink-0 mt-0.5" style={{ background: dsColor }} title={STATE_LABELS[ds]} />
                          <span className="min-w-0 flex-1">
                            <span className="block text-[13px] text-white font-medium truncate">{l.address}</span>
                            <span className="block text-[11px] text-white/50 truncate">
                              {/* dot carries the hue; label stays neutral (11px raw hues fail AA on glass) */}
                              {l.city}, {l.state} · <span className="text-white/70">{STATE_LABELS[ds]}</span>
                              {repName ? ` · ${repName}` : " · Unassigned"}
                            </span>
                          </span>
                          {l.fiberStatus === "new_fiber" && <span className="text-[9px] font-bold text-teal-400 flex-shrink-0">NEW</span>}
                        </button>
                      );
                    })}
                  </div>
                )}
                {sidebarSearch.trim().length >= 3 && searchMatches.length === 0 && (
                  <div className="glass-surface glass-opaque mt-1.5 overflow-hidden">
                    <div className="px-3 py-2.5 text-[12px] text-white/50">No lead in your org matches “{sidebarSearch}”</div>
                    {isAdmin && (
                      <button
                        onClick={() => jumpToAddress(sidebarSearch)}
                        disabled={geocoding}
                        data-testid="map-search-goto"
                        className="w-full flex items-center gap-2 px-3 py-2.5 text-left border-t border-white/10 hover:bg-white/10 text-[13px] text-teal-300 disabled:opacity-60"
                      >
                        <Target className="w-3.5 h-3.5 flex-shrink-0" />
                        {geocoding ? "Locating…" : <>Go to “{sidebarSearch}” on the map</>}
                      </button>
                    )}
                  </div>
                )}
                {sidebarSearch.trim().length > 0 && sidebarSearch.trim().length < 3 && (
                  <div className="glass-surface glass-opaque mt-1.5 px-3 py-2 text-[12px] text-white/55">Keep typing…</div>
                )}
              </div>
            </>
          )}

          {/* Rep mode has NO persistent map chrome — no HUD, no filter lenses,
              no counters. The map is pins only; every pin state reads by color. */}

          {/* Offline-queue badge — knocks waiting to sync. Hugs the edge on mobile
              rep screens where the Mapbox control stack is hidden. */}
          {useSheet && queueSnap.pendingCount > 0 && (
            <div data-testid="knock-pending-badge"
              className={`glass-capsule glass-opaque absolute top-3 ${isRep && isMobile ? "right-3" : "right-14"} z-20 flex items-center gap-1.5 h-8 px-3 border-amber-500/40 text-amber-300 text-xs font-semibold`}>
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
              {queueSnap.pendingCount} to sync
            </div>
          )}

          {/* ── Assign-Area floating action bar — bottom-center, thumb-reachable,
                 clear of the home-indicator gesture zone (safe-area). ── */}
          {lassoMode && (
            <div style={{ bottom: "calc(env(safe-area-inset-bottom) + 1.5rem)" }} className="absolute left-1/2 -translate-x-1/2 z-30 max-w-[calc(100vw-24px)]">
              {lassoSelected.length === 0 ? (
                /* Armed, nothing drawn yet → drawing hint */
                <div className="glass-capsule flex items-center gap-2.5 border-teal-300/40 pl-4 pr-2 py-2 animate-in fade-in slide-in-from-bottom-2 duration-200">
                  <Pencil className="w-4 h-4 text-teal-400 flex-shrink-0" />
                  <span className="text-[13px] font-medium text-white whitespace-nowrap">
                    Drag a loop around the area
                  </span>
                  <button
                    onClick={exitLasso}
                    className="w-11 h-11 rounded-full flex items-center justify-center text-white/70 hover:text-white hover:bg-white/10 transition-colors"
                    title="Exit"
                    data-testid="lasso-exit"
                  ><X className="w-4 h-4" /></button>
                </div>
              ) : (
                /* Drawn → name it (optional) · pick rep · Assign (creates colored territory) */
                <div className="glass-surface flex flex-col gap-2 border-teal-300/40 px-3 py-2.5 animate-in fade-in slide-in-from-bottom-2 duration-200 w-[min(440px,calc(100vw-24px))]">
                  <input
                    type="text"
                    value={lassoName}
                    onChange={e => setLassoName(e.target.value)}
                    maxLength={60}
                    data-testid="lasso-area-name"
                    placeholder={lassoRepId
                      ? `Area name — leave blank for "${team.find(m => m.id === Number(lassoRepId))?.name ?? "Rep"}'s area"`
                      : "Area name (optional)"}
                    className="h-11 w-full rounded-xl bg-white/10 text-white text-[13px] px-3 border-0 placeholder:text-white/55 focus:outline-none focus:ring-2 focus:ring-teal-400/60"
                  />
                  <div className="flex items-center gap-2.5">
                    <span className="flex items-center gap-1.5 text-[14px] font-bold text-white whitespace-nowrap" aria-live="polite">
                      <span
                        className="w-2.5 h-2.5 rounded-full transition-colors"
                        style={{ background: colorForRep(lassoRepId ? Number(lassoRepId) : null), boxShadow: lassoRepId ? `0 0 8px ${colorForRep(Number(lassoRepId))}` : "none" }}
                      />
                      {lassoSelected.length}<span className="font-medium text-white/60 hidden sm:inline"> leads</span>
                      {(() => { const already = lassoSelected.filter(l => l.assignedRepId).length; return already > 0
                        ? <span className="font-normal text-[11px] text-amber-300/90 ml-0.5">({already} already assigned)</span> : null; })()}
                    </span>
                    <select
                      value={lassoRepId}
                      onChange={e => setLassoRepId(e.target.value)}
                      data-testid="lasso-rep-select"
                      className="h-11 flex-1 min-w-0 rounded-full bg-white/10 text-white text-[13px] px-3 border-0 focus:outline-none focus:ring-2 focus:ring-teal-400/60 max-w-[160px]"
                    >
                      <option value="" className="text-slate-900">Assign to rep…</option>
                      {team.filter(m => m.active).map((m: TeamMember) => (
                        <option key={m.id} value={m.id} className="text-slate-900">{m.name}</option>
                      ))}
                    </select>
                    <Button
                      disabled={!lassoRepId || assignAreaMutation.isPending}
                      onClick={() => assignAreaMutation.mutate({ polygon: lassoPoints, repId: Number(lassoRepId), name: lassoName })}
                      data-testid="lasso-assign"
                      className="h-11 rounded-full bg-teal-500 hover:bg-teal-600 text-[#04241f] font-bold text-[13px] px-4 disabled:opacity-40"
                    >
                      {assignAreaMutation.isPending ? "Assigning…" : `Assign ${lassoSelected.length}`}
                    </Button>
                    <button
                      onClick={exitLasso}
                      className="w-11 h-11 rounded-full flex items-center justify-center text-white/70 hover:text-white hover:bg-white/10 transition-colors flex-shrink-0"
                      title="Exit"
                      data-testid="lasso-exit"
                    ><X className="w-4 h-4" /></button>
                  </div>
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
                  <button onClick={() => setSelectedTerritoryId(null)} className="glass-capsule glass-opaque absolute -top-2 -right-2 z-10 w-9 h-9 text-white/70 hover:text-white flex items-center justify-center" title="Close" aria-label="Close territory panel"><X className="w-3.5 h-3.5" /></button>
                  <TerritoryDetailPanel
                    territory={{ id: t.id, name: t.name, status, repIds, color: t.color, leadCount: prog?.total ?? 0, workedCount: prog?.knocked }}
                    currentUser={{ role: (user?.role ?? "rep") }}
                    teamNames={teamNames}
                    progress={prog ? {
                      total: prog.total, verifiedWorkedLeads: prog.verifiedWorkedLeads, areaWorkedPct: prog.areaWorkedPct,
                      verified: prog.verified, needsReview: prog.needsReview, invalid: prog.invalid,
                      avgDistanceM: prog.avgDistanceM, maxAllowedDistanceM: prog.maxAllowedDistanceM,
                    } : undefined}
                    onReclaim={!isPool && canManage ? () => setReclaimMenuId(reclaimMenuId === t.id ? null : t.id) : undefined}
                    onRename={name => renameTerritoryMutation.mutate({ id: t.id, name })}
                    onViewHistory={() => setActivityTerritoryId(t.id)}
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

          {/* Territory activity History drawer (opened from the card's View Activity) */}
          {activityTerritoryId != null && (
            <TerritoryActivityDrawer territoryId={activityTerritoryId} onClose={() => setActivityTerritoryId(null)} />
          )}

          {/* ── ICON CONTROL CLUSTER — top-right, one coherent column. Every tool
                 is icon-only while inactive: magnifier · lasso · scan · layers.
                 44px targets, tooltips, aria, keyboard, active/disabled states.
                 The map stays uncluttered; panels open on demand. ── */}
          {mapReady && !isRep && (
            <div
              className="absolute top-3 right-3 z-30 flex flex-col items-end"
              style={{ paddingTop: "env(safe-area-inset-top)" }}
              data-testid="map-control-cluster"
            >
             {/* One coherent glass panel — the icons read as a single instrument,
                 not four disconnected buttons. Each glyph is transparent until
                 active; the panel supplies the surface, blur, and lift. */}
             <div className="glass-surface flex flex-col gap-1 p-1.5">
              <MapIconBtn
                icon={<Search className="w-5 h-5" />} label="Search leads &amp; places"
                testid="ctl-search" active={searchOpen} btnRef={searchBtnRef} disclosure="dialog"
                onClick={() => { setSearchOpen(o => !o); setLayersOpen(false); setLeadsOpen(false); }}
              />
              <MapIconBtn
                icon={<List className="w-5 h-5" />} label="Leads in view"
                testid="ctl-leads" active={leadsOpen} btnRef={leadsBtnRef} disclosure="region"
                onClick={() => { setLeadsOpen(o => !o); setSearchOpen(false); setLayersOpen(false); }}
              />
              {canAssign && (
                <MapIconBtn
                  icon={<Lasso className="w-5 h-5" />}
                  label={lassoMode ? "Cancel area selection" : "Select an area (lasso)"}
                  testid="ctl-lasso" active={lassoMode} tone="teal"
                  onClick={() => {
                    if (lassoMode) { exitLasso(); }
                    else { exitLasso(); setLassoMode(true); setDrawMode(false); setDrawnBBox(null); setSearchOpen(false); setLayersOpen(false); }
                  }}
                />
              )}
              {isAdmin && (
                <MapIconBtn
                  icon={
                    scanning ? <Loader2 className="w-5 h-5 animate-spin" />
                    : scanOutcome && !scanStale ? (scanOutcome.kind === "error" ? <AlertCircle className="w-5 h-5" /> : <Radar className="w-5 h-5" />)
                    : <Radar className="w-5 h-5" />
                  }
                  label={
                    scanning ? "Scanning — tap to stop"
                    : drawMode ? "Cancel scan-area drawing"
                    : "Scan an area for new fiber"
                  }
                  testid="ctl-scan"
                  active={drawMode || scanning || !!drawnBBox}
                  tone={scanOutcome?.kind === "error" ? "red" : "orange"}
                  badge={scanning ? "…" : scanOutcome && !scanStale && scanOutcome.kind === "success" ? String(scanOutcome.found) : undefined}
                  onClick={() => {
                    if (scanning) { void stopScan(); return; }
                    setDrawMode(v => !v); setDrawnBBox(null); exitLasso(); setSearchOpen(false); setLayersOpen(false);
                  }}
                />
              )}
              <div className="glass-hairline mx-1 my-0.5" aria-hidden="true" />
              <MapIconBtn
                icon={<Layers className="w-5 h-5" />} label="Map layers & style"
                testid="ctl-layers" active={layersOpen} btnRef={layersBtnRef} disclosure="menu"
                onClick={() => { setLayersOpen(o => !o); setSearchOpen(false); }}
              />
             </div>

              {/* Layers popover — a group of switches + basemap radios (NOT a
                  role=menu, which would promise a keyboard menu model we don't
                  implement). Each control is a real button operable by Tab. */}
              {layersOpen && (
                <div className="glass-surface absolute top-0 right-14 w-[172px] p-2.5 text-white" role="group" aria-label="Map layers and style" data-testid="layers-popover">
                  <div className="text-[10px] uppercase tracking-wider text-white/40 font-semibold mb-1.5">Layers</div>
                  {[
                    { key: "leads", label: "Leads", on: showLeads, toggle: () => setShowLeads(v => !v) },
                    ...(canAssign ? [{ key: "terr", label: "Territories", on: showTerritories, toggle: () => setShowTerritories(v => !v) }] : []),
                  ].map(l => (
                    <button key={l.key} onClick={l.toggle} data-testid={`layer-${l.key}`} role="switch" aria-checked={l.on} aria-label={`${l.label} layer`}
                      className="w-full flex items-center justify-between min-h-[44px] py-1.5 text-[12.5px] text-white/90 hover:text-white">
                      <span>{l.label}</span>
                      <span className={`w-8 h-4 rounded-full transition-colors relative ${l.on ? "bg-primary" : "bg-white/25"}`}>
                        <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all ${l.on ? "left-4" : "left-0.5"}`} />
                      </span>
                    </button>
                  ))}
                  <div className="text-[10px] uppercase tracking-wider text-white/40 font-semibold mt-2 mb-1.5 pt-2 border-t border-white/10">Basemap</div>
                  <div className="grid grid-cols-3 gap-1">
                    {([["satellite", "Satellite"], ["streets", "Street"], ["dark", "Dark"]] as const).map(([mode, label]) => (
                      <button key={mode} onClick={() => setMapStyleMode(mode)} data-testid={`mapmode-${mode}`} disabled={!mapReady}
                        aria-pressed={mapStyleMode === mode} aria-label={`${label} basemap`} title={label}
                        className={`text-[10px] min-h-[44px] rounded-lg transition-colors ${mapStyleMode === mode ? "bg-primary text-white font-semibold" : "bg-white/10 text-white/80 hover:bg-white/20"}`}>
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Locate-me FAB — REP-ONLY. A field rep walking a street needs to
              recenter on their blue dot constantly; a manager at a desk reviewing
              territory does not, and the button only crowded their map. Removed
              for non-rep roles per operator feedback; the GeolocateControl is
              still wired, so reps keep the thumb target. */}
          {mapReady && isRep && (
            <button
              onClick={() => { try { geolocateRef.current?.trigger(); } catch {} }}
              aria-label="Center on my location"
              data-testid="locate-me"
              style={{ height: 52, width: 52, bottom: "calc(env(safe-area-inset-bottom) + 2rem)", boxShadow: "var(--glass-shadow-1)" }}
              className="absolute right-3 z-20 rounded-full ring-1 ring-inset ring-white/[0.18] flex items-center justify-center active:scale-[0.97] transform-gpu transition-transform bg-primary text-white hover:bg-primary/90"
            >
              <LocateFixed className="w-6 h-6" />
            </button>
          )}

          {/* Next-door FAB — REP-ONLY, bottom-left (thumb reach, mirrors the
              locate FAB on the right). One tap: nearest unworked door from
              where the rep is standing → fly + open its knock sheet. Hidden
              while a sheet is open so it never covers the outcome buttons. */}
          {mapReady && isRep && selectedLeadId == null && leads.length > 0 && (
            <button
              onClick={nextBestDoor}
              aria-label="Go to the next unworked door"
              data-testid="next-door"
              style={{ height: 52, bottom: "calc(env(safe-area-inset-bottom) + 2rem)", boxShadow: "var(--glass-shadow-1)" }}
              className="glass-capsule glass-opaque absolute left-3 z-20 flex items-center gap-2 px-4 text-white font-semibold text-[14px] active:scale-[0.97] transform-gpu transition-transform"
            >
              <Navigation className="w-4.5 h-4.5 text-teal-300" style={{ width: 18, height: 18 }} />
              Next door
            </button>
          )}

          {/* Pin legend + filter — bottom left, admin/manager only. Collapsed
                 to a quiet dot-strip by default; one tap expands the full
                 status filter + assigned-areas manager panel. */}
          {mapReady && !isRep && leads.length > 0 && !legendOpen && (
            <button
              onClick={() => setLegendOpen(true)}
              data-testid="legend-collapsed"
              aria-label="Open legend, status filter and assigned areas"
              style={{ bottom: "calc(env(safe-area-inset-bottom) + 2rem)" }}
              className="glass-capsule absolute left-3 z-10 flex items-center gap-1.5 h-11 px-3 active:scale-[0.97] transform-gpu transition"
            >
              {Object.values(PIN_COLORS).map((pin, i) => (
                <span key={i} className="w-2 h-2 rounded-full" style={{ background: pin.bg }} />
              ))}
              {(filterStatus !== "all" || filterRep !== "all") && (
                <span className="ml-1 text-[10px] font-semibold text-teal-200">filtered</span>
              )}
            </button>
          )}
          {mapReady && !isRep && legendOpen && (
            <div style={{ bottom: "calc(env(safe-area-inset-bottom) + 2rem)", maxHeight: "min(60vh, 460px)" }} className="glass-surface absolute left-3 p-3 z-10 min-w-[170px] max-w-[240px] overflow-y-auto">
              {/* Rep filter — moved here from the (removed) top bar */}
              {canAssign && (
                <div className="mb-2.5">
                  <span className="block text-[10px] text-white/40 uppercase tracking-wider font-semibold mb-1">Rep</span>
                  <select
                    value={filterRep}
                    onChange={e => setFilterRep(e.target.value)}
                    data-testid="map-filter-rep"
                    title="Show only leads for a rep"
                    className="w-full h-9 bg-white/10 border border-white/20 rounded-lg px-1.5 text-[12px] text-white focus:outline-none focus:ring-1 focus:ring-teal-400"
                  >
                    <option value="all">All reps</option>
                    <option value="unassigned">Unassigned ({repLeadCounts.unassigned})</option>
                    {team.map((m: TeamMember) => (
                      <option key={m.id} value={String(m.id)}>{m.name} ({repLeadCounts.counts.get(m.id) ?? 0})</option>
                    ))}
                  </select>
                </div>
              )}
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] text-white/40 uppercase tracking-wider font-semibold">Filter by status</span>
                <span className="flex items-center gap-2">
                  {filterStatus !== "all" && (
                    <button onClick={() => setFilterStatus("all")} className="relative text-[10px] text-teal-400 hover:text-teal-300 after:absolute after:-inset-3">Clear</button>
                  )}
                  <button onClick={() => setLegendOpen(false)} data-testid="legend-collapse" aria-label="Collapse legend"
                    className="relative w-8 h-8 -my-1.5 inline-flex items-center justify-center rounded-lg text-white/70 hover:text-white hover:bg-white/10 text-sm leading-none after:absolute after:-inset-1.5">×</button>
                </span>
              </div>
              {Object.entries(PIN_COLORS).map(([status, pin]) => {
                const count = statusCounts[status] ?? 0;
                const isActive = filterStatus === status;
                return (
                  // Real toggle buttons (were click-only divs — no keyboard or
                  // AT path to the status filter at all; review finding), 44px.
                  <button
                    key={status}
                    type="button"
                    aria-pressed={isActive}
                    onClick={() => setFilterStatus(isActive ? "all" : status)}
                    className="w-full flex items-center gap-2 mb-0.5 cursor-pointer rounded-lg px-1.5 min-h-[44px] transition-all text-left focus-visible:ring-2 focus-visible:ring-teal-400 focus-visible:ring-inset focus:outline-none"
                    style={{ background: isActive ? pin.bg + "22" : "transparent" }}
                  >
                    <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: pin.bg, boxShadow: isActive ? `0 0 6px ${pin.bg}` : "none" }} />
                    <span className="text-[11px] flex-1" style={{ color: isActive ? pin.bg : "#94a3b8", fontWeight: isActive ? 700 : 400 }}>{pin.label}</span>
                    <span className="text-[10px] tabular-nums" style={{ color: count > 0 ? "#e2e8f0" : "#475569" }}>{count}</span>
                  </button>
                );
              })}
              {canAssign && territories.length > 0 && (
                <div className="pt-2 mt-1 border-t border-white/10">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[10px] text-white/40 uppercase tracking-wider font-semibold">Assigned areas</span>
                    <button onClick={() => setShowTerritories(v => !v)} className="relative text-[10px] text-white/50 hover:text-white/80 after:absolute after:-inset-3">{showTerritories ? "Hide" : "Show"}</button>
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
                          <button onClick={() => setReclaimMenuId(reclaimMenuId === t.id ? null : t.id)} aria-label={`Assign ${repName}'s area to a rep`}
                            className="opacity-100 sm:opacity-0 sm:group-hover:opacity-100 text-teal-400 w-7 h-7 inline-flex items-center justify-center rounded hover:bg-white/10" data-testid={`assign-${t.id}`}>＋</button>
                        )}
                        {canManage && !isUnassigned && (
                          <button onClick={() => setReclaimMenuId(reclaimMenuId === t.id ? null : t.id)} aria-label={`Reclaim ${repName}'s area`}
                            className="opacity-100 sm:opacity-0 sm:group-hover:opacity-100 text-amber-400 w-7 h-7 inline-flex items-center justify-center rounded hover:bg-white/10" data-testid={`reclaim-${t.id}`}>↩</button>
                        )}
                        {canManage && <button onClick={() => deleteTerritoryMutation.mutate(t.id)} aria-label={`Delete ${repName}'s area`} className="opacity-100 sm:opacity-0 sm:group-hover:opacity-100 text-red-400/80 hover:text-red-400 w-7 h-7 inline-flex items-center justify-center rounded hover:bg-white/10">×</button>}
                      </div>
                      {prog && prog.total > 0 && (
                        <div className="h-1 rounded-full bg-white/10 mt-0.5 overflow-hidden">
                          <div className="h-full rounded-full" style={{ width: `${prog.pct}%`, background: color }} />
                        </div>
                      )}
                      {/* Assign-to-next-rep chooser for reclaimed/unassigned areas */}
                      {reclaimMenuId === t.id && isUnassigned && (
                        <div className="mt-1 ml-4 bg-white/[0.06] border border-white/[0.08] rounded-lg p-1.5" data-testid={`assign-menu-${t.id}`}>
                          <select data-testid={`assign-select-${t.id}`} defaultValue=""
                            onChange={e => { if (e.target.value) { assignTerritoryMutation.mutate({ id: t.id, repId: Number(e.target.value) }); setReclaimMenuId(null); } }}
                            className="w-full bg-white/10 text-white text-[10px] rounded-lg px-1 py-1 border border-white/20">
                            <option value="" className="text-slate-900">Assign to next rep…</option>
                            {team.filter(m => m.active).map(m => <option key={m.id} value={m.id} className="text-slate-900">{m.name}</option>)}
                          </select>
                        </div>
                      )}
                      {/* Reclaim 3-mode chooser (owned areas only) */}
                      {reclaimMenuId === t.id && !isUnassigned && (
                        <div className="mt-1 ml-4 flex flex-col gap-1 bg-white/[0.06] border border-white/[0.08] rounded-lg p-1.5" data-testid={`reclaim-menu-${t.id}`}>
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
                              className="flex-1 bg-white/10 text-white text-[10px] rounded-lg px-1 py-1 border border-white/20">
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

          {/* ── Lead card — the rep's door-to-door workflow (reps always; admins on mobile) ── */}
          {useSheet && (
            <LeadKnockSheet
              lead={selectedLead}
              onKnock={handleKnock}
              onSaveNote={handleSaveNote}
              onClose={closeSheet}
              dockOffsetPx={leadsOpen ? 340 : 0}
            />
          )}
        </div>

        {/* ── Leads-in-view panel — right rail (desktop) / slide-in drawer (phone).
               A flex SIBLING of the map div on ≥1024px: opening it shrinks the
               map, whose ResizeObserver fires resize → moveend → the viewport
               bounds (and therefore the list) self-correct. ── */}
        {!isRep && (
          <LeadsInViewPanel
            open={leadsOpen}
            onClose={() => { setLeadsOpen(false); leadsBtnRef.current?.focus(); }}
            leads={inViewLeads}
            totalOnMap={mapTotalLeads.length}
            orgTotal={mapPinData?.total ?? 0}
            filtered={mapTotalLeads.length !== (mapPinData?.total ?? 0)}
            showLeadsLayer={showLeads}
            onShowLeadsLayer={() => setShowLeads(true)}
            onRowTap={onLeadsRowTap}
            onFitAll={fitAllLeads}
            onClearFilters={() => { setFilterStatus("all"); setFilterRep("all"); }}
            repNameById={repNameById}
          />
        )}
      </div>
    </div>
  );
}

// ── Icon-only map control ─────────────────────────────────────────────────────
// One consistent affordance for the whole cluster: 44×44 hit area, real <button>
// (keyboard + AT), tooltip via title AND aria-label, visible active/disabled/
// focus states, optional count badge. Tone tints the active state to match the
// tool (teal=lasso, orange/red=scan).
function MapIconBtn({
  icon, label, testid, onClick, active = false, disabled = false,
  tone = "primary", badge, btnRef, disclosure,
}: {
  icon: React.ReactNode; label: string; testid: string; onClick: () => void;
  active?: boolean; disabled?: boolean; tone?: "primary" | "teal" | "orange" | "red";
  badge?: string; btnRef?: React.RefObject<HTMLButtonElement | null>;
  // A disclosure OPENS a panel — announce aria-expanded (plus aria-haspopup for
  // dialog/menu; a complementary "region" is neither, so it gets aria-expanded
  // only). Toggles (lasso/scan) omit this and use aria-pressed.
  disclosure?: "dialog" | "menu" | "region";
}) {
  // Active tints use the -600 shades so the white glyph clears the 3:1 non-text
  // contrast floor (WCAG 1.4.11) over map imagery.
  const activeBg =
    tone === "teal" ? "bg-teal-600 border-teal-300/70"
    : tone === "orange" ? "bg-orange-600 border-orange-300/70"
    : tone === "red" ? "bg-red-600 border-red-300/70"
    : "bg-primary border-primary";
  return (
    <div className="relative group">
      <button
        ref={btnRef as any}
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        {...(disclosure === "region" ? { "aria-expanded": active }
          : disclosure ? { "aria-haspopup": disclosure, "aria-expanded": active }
          : { "aria-pressed": active })}
        data-testid={testid}
        className={[
          "relative h-11 w-11 rounded-xl flex items-center justify-center border transition-all duration-150",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-400 focus-visible:ring-offset-1 focus-visible:ring-offset-black/40",
          "active:scale-95 disabled:opacity-40 disabled:pointer-events-none",
          // Idle icons are transparent — the surrounding glass panel is the
          // surface. Active tools fill with their tone and lift, so the armed
          // tool reads at a glance without any text label.
          active ? `${activeBg} text-white shadow-lg` : "border-transparent text-white/85 hover:text-white hover:bg-white/10",
        ].join(" ")}
      >
        {icon}
        {badge != null && (
          <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-white text-black text-[10px] font-bold flex items-center justify-center shadow">
            {badge}
          </span>
        )}
      </button>
      {/* Styled hover/focus label (desktop) — a real tooltip beyond the native
          title, so the icon's meaning is one hover away. Touch users get the
          armed-state hint bars instead. */}
      <span role="tooltip"
        className="glass-opaque pointer-events-none absolute right-full top-1/2 -translate-y-1/2 mr-2 whitespace-nowrap rounded-lg border border-white/10 px-2 py-1 text-[11px] font-medium text-white shadow-lg opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity hidden md:block">
        {label}
      </span>
    </div>
  );
}
