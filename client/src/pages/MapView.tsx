import { useEffect, useRef, useState, useCallback, useMemo } from "react";
// mapbox-gl loaded via CDN in index.html — do not bundle
declare const mapboxgl: any;
import {
  Play, Square, RefreshCw, AlertCircle, Pencil, X,
  DoorOpen, UserCheck, Zap, CalendarClock, PhoneOff, Map as MapIcon, ShieldCheck, Bell,
  ChevronRight, Home, Wifi, Signal, Users, Target, Search
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
  const assignedRep = team.find(m => m.id === lead.assignedRepId);
  const repOptions = team.filter(m => m.active)
    .map(m => `<option value="${m.id}" ${m.id === lead.assignedRepId ? "selected" : ""}>${escapeHtml(m.name)}</option>`)
    .join("");

  // Tap the address / Directions → open turn-by-turn (Maps app on mobile).
  const dest = (lead.lat && lead.lng)
    ? `${lead.lat},${lead.lng}`
    : encodeURIComponent(`${lead.address}, ${lead.city}, ${lead.state} ${lead.zip}`);
  const dirUrl = `https://www.google.com/maps/dir/?api=1&destination=${dest}`;
  const phone = lead.contactPhone ? String(lead.contactPhone).replace(/[^0-9+]/g, "") : "";

  const speedTag = lead.maxDownloadMbps
    ? `<span style="background:#0ea5e922;color:#38bdf8;border:1px solid #0ea5e944;border-radius:999px;padding:2px 8px;font-size:11px;font-weight:600;">${lead.maxDownloadMbps >= 1000 ? lead.maxDownloadMbps / 1000 + "G" : lead.maxDownloadMbps + "M"}</span>`
    : "";

  // Who a logged knock is credited to. Managers pick via the dropdown; reps are
  // always credited to themselves (no dropdown shown for them).
  const knockRep = canAssign ? "" : String(currentRepId ?? "");
  const knockHint = canAssign
    ? (assignedRep ? `Logs under ${escapeHtml(assignedRep.name)}` : "Pick a rep, then log")
    : "Logs under you";

  return `
    <div style="font-family:system-ui,sans-serif;font-size:13px;color:#e2e8f0;min-width:268px;max-width:300px;">
      <!-- Header -->
      <div style="display:flex;align-items:flex-start;gap:8px;margin-bottom:10px;">
        <div style="width:12px;height:12px;margin-top:3px;border-radius:50%;background:${pin.bg};border:2px solid ${pin.border};flex-shrink:0;box-shadow:0 0 8px ${pin.bg}80;"></div>
        <div style="min-width:0;">
          <div style="font-weight:700;font-size:14px;line-height:1.2;color:#f1f5f9;">${escapeHtml(lead.address)}</div>
          <div style="color:#94a3b8;font-size:11px;">${escapeHtml(lead.city)}, ${escapeHtml(lead.state)} ${escapeHtml(lead.zip)}</div>
        </div>
      </div>

      <!-- Status + fiber pills -->
      <div style="display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap;">
        <span style="background:${pin.bg}22;color:${pin.bg};border:1px solid ${pin.bg}44;border-radius:999px;padding:2px 9px;font-size:11px;font-weight:600;">${pin.label}</span>
        ${lead.fiberStatus === "new_fiber" ? `<span style="background:#22c55e22;color:#22c55e;border:1px solid #22c55e44;border-radius:999px;padding:2px 9px;font-size:11px;font-weight:600;">NEW FIBER</span>` : ""}
        ${speedTag}
        ${lead.competitorName ? `<span style="background:#f9731622;color:#fb923c;border:1px solid #f9731644;border-radius:999px;padding:2px 9px;font-size:11px;">vs ${escapeHtml(lead.competitorName)}</span>` : ""}
      </div>

      <!-- Primary actions: Directions + Call -->
      <div style="display:flex;gap:6px;margin-bottom:10px;">
        <a href="${dirUrl}" target="_blank" rel="noopener"
          style="flex:1;display:flex;align-items:center;justify-content:center;gap:5px;background:#5eead422;color:#5eead4;border:1px solid #5eead444;border-radius:7px;padding:8px;font-size:12px;font-weight:600;text-decoration:none;">
          🧭 Directions
        </a>
        ${phone ? `<a href="tel:${phone}"
          style="flex:1;display:flex;align-items:center;justify-content:center;gap:5px;background:#3b82f622;color:#60a5fa;border:1px solid #3b82f644;border-radius:7px;padding:8px;font-size:12px;font-weight:600;text-decoration:none;">
          📞 Call
        </a>` : ""}
      </div>

      <!-- Contact -->
      ${lead.contactName ? `<div style="color:#94a3b8;font-size:11px;margin-bottom:8px;">👤 ${escapeHtml(lead.contactName)}${lead.contactPhone ? ` · ${escapeHtml(lead.contactPhone)}` : ""}</div>` : ""}

      <!-- Assign rep (managers/team leads only) -->
      ${canAssign ? `<div style="margin-bottom:8px;">
        <div style="color:#94a3b8;font-size:10px;text-transform:uppercase;letter-spacing:.05em;margin-bottom:3px;">Assigned Rep</div>
        <div style="display:flex;gap:6px;">
          <select id="assign-rep-${lead.id}" style="flex:1;background:#1e2430;color:#e2e8f0;border:1px solid #334155;border-radius:6px;padding:6px;font-size:12px;">
            <option value="">— Unassigned —</option>
            ${repOptions}
          </select>
          <button onclick="window.__assignRep(${lead.id})"
            style="background:#f97316;color:white;border:none;border-radius:6px;padding:0 12px;font-size:12px;font-weight:600;cursor:pointer;">Save</button>
        </div>
      </div>` : ""}

      <!-- Visited banner — shows past visits so reps know it's already been hit -->
      ${lead.visited ? `<div style="display:flex;align-items:center;gap:7px;background:#0f172a;border:1px solid #1e3a2e;border-radius:8px;padding:6px 10px;margin-bottom:9px;font-size:11px;">
        <span style="color:#22c55e;font-weight:700;">✓ Visited${(lead.knockCount ?? 0) > 1 ? ` ${lead.knockCount}×` : ""}</span>
        <span style="color:#94a3b8;">last: ${escapeHtml(String(lead.lastOutcome ?? "").replace("_", " "))} · ${relTime(lead.lastKnockedAt)}</span>
      </div>` : ""}

      <!-- One-tap knock logging — big targets for one-handed field use -->
      <div style="margin-bottom:2px;">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px;">
          <span style="color:#e2e8f0;font-size:11px;font-weight:700;">${lead.visited ? "Update visit" : "Mark this visit"}</span>
          <span style="color:#64748b;font-size:10px;">${knockHint}</span>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
          ${OUTCOME_OPTIONS.map(o => `
            <button
              onclick="window.__knockLead(${lead.id}, '${o.val}', '${knockRep}')"
              style="background:${o.color}1f;color:${o.color};border:1px solid ${o.color}55;border-radius:8px;padding:11px 4px;font-size:13px;font-weight:700;cursor:pointer;text-align:center;transition:background .1s;"
              onmousedown="this.style.background='${o.color}44'" onmouseup="this.style.background='${o.color}1f'" ontouchstart="this.style.background='${o.color}44'" ontouchend="this.style.background='${o.color}1f'"
            >${o.label}</button>
          `).join("")}
        </div>
      </div>

      <!-- Notes -->
      ${lead.notes ? `<div style="color:#94a3b8;font-size:11px;font-style:italic;border-top:1px solid #1e2430;padding-top:6px;margin-top:8px;">"${escapeHtml(lead.notes)}"</div>` : ""}
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
  const [geocoding, setGeocoding] = useState(false); // street "go to" lookup in flight
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
  const isRep = user?.role === "rep";
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
          // Visited doors get a thicker white ring so "done" reads at a glance
          "circle-stroke-width": ["case", ["==", ["get", "visited"], 1], 3, 2],
          "circle-stroke-color": "rgba(255,255,255,0.95)",
          // Un-visited = bright; visited = dimmed so fresh doors pop
          "circle-opacity": ["case", ["==", ["get", "visited"], 1], 0.5, 0.95],
        },
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
          .setHTML(buildPopupHTML(lead, tm, { canAssign, currentRepId: user?.teamMemberId ?? null }))
          .addTo(map);
      });
      map.on("mouseenter", "lead-unclustered", () => { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", "lead-unclustered", () => { map.getCanvas().style.cursor = ""; });

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
          properties: { id: l.id, status: l.leadStatus, address: l.address, visited: l.visited ? 1 : 0 },
        })),
    });
  }, [leads, team, mapReady, filterStatus, filterRep, canAssign, territories, isAdmin, user, styleEpoch]);

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
  }, [territories, mapReady, showTerritories, styleEpoch]);

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
            "circle-radius": 8,
            "circle-stroke-width": ["case", ["==", ["get","visited"], 1], 3, 2],
            "circle-stroke-color": "rgba(255,255,255,0.95)",
            "circle-opacity": ["case", ["==", ["get","visited"], 1], 0.5, 0.95] },
        });
        map.addLayer({ id: "lead-visited-check", type: "symbol", source: "leads-cluster",
          filter: ["all", ["!", ["has","point_count"]], ["==", ["get","visited"], 1]], minzoom: 12,
          layout: { "text-field": "✓", "text-font": ["Arial Unicode MS Regular"], "text-size": 12, "text-offset": [0, -1.15], "text-allow-overlap": true, "text-ignore-placement": true },
          paint: { "text-color": "#ffffff", "text-halo-color": "#0f172a", "text-halo-width": 1.5 },
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
            .setLngLat(coords).setHTML(buildPopupHTML(lead, tm, { canAssign, currentRepId: user?.teamMemberId ?? null })).addTo(map);
        });
        map.on("mouseenter", "lead-unclustered", () => { map.getCanvas().style.cursor = "pointer"; });
        map.on("mouseleave", "lead-unclustered", () => { map.getCanvas().style.cursor = ""; });
      }
      lastRenderedCount.current = 0;
      // Re-trigger the lead-pin setData + territory render effects — the new
      // style starts with an empty source, so without this the pins vanish.
      setStyleEpoch(e => e + 1);
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
        try {
          if (map.getLayer("lasso-fill")) map.removeLayer("lasso-fill");
          if (map.getLayer("lasso-outline")) map.removeLayer("lasso-outline");
          if (map.getSource("lasso-polygon")) map.removeSource("lasso-polygon");
        } catch {}
        lassoLayerRef.current = false;
      }
      try { map.getCanvas().style.cursor = ""; } catch {}
      return;
    }

    try { map.getCanvas().style.cursor = "crosshair"; } catch {}

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
      // Defensive: on unmount the map may already be removed (getCanvas → undefined)
      try { map.off("click", onClick); } catch {}
      try { map.getCanvas().style.cursor = ""; } catch {}
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
    try { map.getCanvas().style.cursor = "crosshair"; map.dragPan.disable(); } catch {}

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
      try { map.getCanvas().style.cursor = ""; map.dragPan.enable(); } catch {}
    };

    map.on("mousedown", onDown); map.on("mousemove", onMove); map.on("mouseup", onUp);
    return () => {
      // Defensive: on unmount the map may already be removed (getCanvas → undefined)
      try { map.off("mousedown", onDown); map.off("mousemove", onMove); map.off("mouseup", onUp); } catch {}
      try { map.getCanvas().style.cursor = ""; map.dragPan.enable(); } catch {}
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
      new (window as any).mapboxgl.Popup({ offset: 14, className: "sr-popup", closeButton: true })
        .setLngLat(target)
        .setHTML(buildPopupHTML(lead, tm, { canAssign, currentRepId: user?.teamMemberId ?? null }))
        .addTo(m);
    }, 950);
  }, [canAssign, user]);

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

  // On-map search — top matches for the search box dropdown (address or city).
  const searchMatches = useMemo(() => {
    const q = sidebarSearch.trim().toLowerCase();
    if (!q) return [];
    return leads
      .filter(l => l.lat && l.lng && (l.address.toLowerCase().includes(q) || (l.city ?? "").toLowerCase().includes(q)))
      .sort((a, b) => (b.leadScore ?? 0) - (a.leadScore ?? 0))
      .slice(0, 8);
  }, [leads, sidebarSearch]);

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
            <span className="text-xs font-semibold text-teal-400">{newFiberCount}</span>
            <span className="text-xs text-muted-foreground hidden sm:inline"> fiber</span>
          </div>
          {!isRep && (
            <div className="flex items-center gap-1">
              <Users className="w-3 h-3 text-blue-400" />
              <span className="text-xs text-muted-foreground">{assignedCount} assigned</span>
            </div>
          )}
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
          {/* ── Action tools: assign · territory · scan (blue → purple → orange) ── */}
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
                  ? "border-blue-500 text-blue-400 bg-blue-500/10"
                  : "border-blue-500/40 text-blue-400 hover:bg-blue-500/10"
              }`}
              title="Lasso: click points around leads, then bulk-assign to rep"
            >
              <Pencil className="w-3 h-3 mr-1" />
              {lassoMode ? `Lasso (${lassoSelected.length} selected)` : "Lasso"}
            </Button>
          )}
          {canAssign && (
            <Button
              onClick={() => { setTerritoryDrawMode(!territoryDrawMode); setTerritoryPoints([]); setLassoMode(false); setDrawMode(false); }}
              disabled={!mapReady}
              size="sm" variant="outline"
              className={`h-7 text-xs ${territoryDrawMode ? "border-purple-500 text-purple-400 bg-purple-500/10" : "border-purple-500/40 text-purple-400 hover:bg-purple-500/10"}`}
              title="Territory: draw a polygon and assign it to a rep"
            ><ShieldCheck className="w-3 h-3 mr-1" />{territoryDrawMode ? "Drawing…" : "Territory"}</Button>
          )}
          {/* Draw a box → scan that area for new fiber (admin only) */}
          {isAdmin && (
            <Button
              onClick={() => { setDrawMode(!drawMode); setDrawnBBox(null); setTerritoryDrawMode(false); setLassoMode(false); }}
              disabled={!mapReady}
              size="sm" variant="outline"
              className={`h-7 text-xs ${drawMode ? "border-orange-500 text-orange-400 bg-orange-500/10" : "border-orange-500/40 text-orange-400 hover:bg-orange-500/10"}`}
              title="Scan Area: draw a box to scan for new fiber"
            ><Target className="w-3 h-3 mr-1" />{drawMode ? "Drawing…" : "Scan Area"}</Button>
          )}

          {/* Divider between action tools and view controls */}
          {(canAssign || isAdmin) && <div className="w-px h-5 bg-border mx-0.5" />}

          {/* ── View controls ── */}
          <Button
            size="sm" variant="outline"
            onClick={() => setMapStyleMode(m => m === "dark" ? "satellite" : "dark")}
            disabled={!mapReady}
            className="h-7 text-xs border-border text-muted-foreground hover:text-foreground"
            title={mapStyleMode === "satellite" ? "Switch to street" : "Switch to satellite"}
          >
            {mapStyleMode === "satellite" ? "🗺 Street" : "🛰 Satellite"}
          </Button>
          <Button
            size="sm" variant="outline"
            onClick={() => mapRef.current?.flyTo({ center: ROCKWELL_CENTER, zoom: 13, duration: 800 })}
            disabled={!mapReady}
            className="h-7 text-xs border-border text-muted-foreground hover:text-foreground"
            title="Reset map view"
          ><Home className="w-3 h-3" /></Button>
        </div>
      </div>

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
        <div className="px-3 py-2 bg-blue-500/10 border-b border-blue-500/30 flex flex-wrap items-center gap-2 flex-shrink-0">
          <span className="text-[11px] text-blue-400 font-medium">
            ■ Lasso active — click map to draw area
            {lassoPoints.length > 0 && ` (${lassoPoints.length} pts)`}
            {lassoSelected.length > 0 && ` → ${lassoSelected.length} leads selected`}
          </span>
          {lassoSelected.length > 0 && (
            <>
              <select
                value={lassoRepId}
                onChange={e => setLassoRepId(e.target.value)}
                className="bg-background border border-border rounded px-2 py-0.5 text-[11px] text-foreground focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                <option value="">Assign to rep…</option>
                {team.map((m: TeamMember) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
              <Button
                size="sm"
                disabled={!lassoRepId || bulkAssignMutation.isPending}
                onClick={() => bulkAssignMutation.mutate({ leadIds: lassoSelected.map(l => l.id), repId: Number(lassoRepId) })}
                className="h-6 text-[11px] px-2 bg-blue-600 hover:bg-blue-700 text-white"
              >
                {bulkAssignMutation.isPending ? "Assigning…" : `Assign ${lassoSelected.length}`}
              </Button>
            </>
          )}
          <Button
            size="sm" variant="ghost"
            className="text-blue-400/70 h-6 text-[11px] ml-auto"
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
            <Button size="sm" variant="ghost" className="text-blue-400/70 h-6 text-[11px]"
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
      </div>
    </div>
  );
}
