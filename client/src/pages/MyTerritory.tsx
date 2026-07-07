import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import {
  MapPin, CheckCircle2, XCircle, Phone, Home, Clock,
  ChevronRight, AlertTriangle, Navigation, Star, RefreshCw,
  MessageSquare, Send, Wifi, Users, BarChart2, Map
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type { Lead, Territory } from "@shared/schema";

const API_BASE = ("__PORT_5000__" as string).startsWith("__") ? "" : "__PORT_5000__";
const MAPBOX_TOKEN_KEY = "__mapbox_token__";

// Outcome options for door knocks
const OUTCOMES = [
  { value: "not_home",      label: "Not Home",      icon: "🚪", color: "text-slate-400" },
  { value: "not_interested",label: "Not Interested", icon: "❌", color: "text-red-400" },
  { value: "interested",    label: "Interested",     icon: "⭐", color: "text-amber-400" },
  { value: "callback",      label: "Set Callback",   icon: "📅", color: "text-blue-400" },
  { value: "sold",          label: "Sold!",          icon: "✅", color: "text-green-400" },
];

const STATUS_COLORS: Record<string, string> = {
  prospect:       "bg-slate-500/20 text-slate-300",
  contacted:      "bg-blue-500/20 text-blue-300",
  interested:     "bg-amber-500/20 text-amber-300",
  sold:           "bg-green-500/20 text-green-300",
  not_interested: "bg-red-500/20 text-red-300",
  follow_up:      "bg-purple-500/20 text-purple-300",
};

export default function MyTerritory() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null);
  const [knockOutcome, setKnockOutcome] = useState("");
  const [knockNotes, setKnockNotes] = useState("");
  const [callbackDate, setCallbackDate] = useState("");
  const [callbackTime, setCallbackTime] = useState("");
  const [wasHome, setWasHome] = useState<boolean | null>(null);
  const [requestMsg, setRequestMsg] = useState("");
  const [showRequestForm, setShowRequestForm] = useState(false);
  const mapRef = useRef<any>(null);
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const markersRef = useRef<any[]>([]);

  // ── Data fetching ──────────────────────────────────────────────────────────
  // /api/leads returns { leads, total, ... } — unwrap to the array
  const { data: leads = [] } = useQuery<Lead[]>({
    queryKey: ["/api/leads"],
    select: (d: any) => (Array.isArray(d) ? d : d?.leads ?? []),
  });
  const { data: territories = [] } = useQuery<Territory[]>({ queryKey: ["/api/territories"] });
  const { data: mapConfig } = useQuery<{ token: string }>({
    queryKey: ["/api/config/map"],
    queryFn: () => apiRequest("GET", "/api/config/map").then(r => r.json()),
  });
  const { data: pendingRequest } = useQuery({
    queryKey: ["/api/territory-requests", "my-pending"],
    queryFn: () => apiRequest("GET", "/api/territory-requests?status=pending").then(r => r.json()),
    enabled: user?.role === "rep" || user?.role === "team_lead",
  });

  // My territory (only for reps linked to a team member)
  const myTerritories = territories.filter(t =>
    user?.teamMemberId && t.repId === user.teamMemberId
  );

  // Leads inside my territory polygons
  function pointInPolygon(lat: number, lng: number, polygon: [number, number][]) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const xi = polygon[i][0], yi = polygon[i][1];
      const xj = polygon[j][0], yj = polygon[j][1];
      if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    return inside;
  }

  const myLeads = leads.filter(lead => {
    if (!lead.lat || !lead.lng) return false;
    if (myTerritories.length === 0) return lead.assignedRepId === user?.teamMemberId;
    return myTerritories.some(t => {
      try {
        const poly = JSON.parse(t.polygon) as [number, number][];
        return pointInPolygon(lead.lat!, lead.lng!, poly);
      } catch { return false; }
    });
  });

  const totalLeads = myLeads.length;
  const knocked = myLeads.filter(l => l.leadStatus !== "prospect").length;
  const sold = myLeads.filter(l => l.leadStatus === "sold").length;
  const interested = myLeads.filter(l => l.leadStatus === "interested").length;
  const pct = totalLeads > 0 ? Math.round((knocked / totalLeads) * 100) : 0;

  // ── Mutations ──────────────────────────────────────────────────────────────
  const knockMutation = useMutation({
    mutationFn: async () => {
      if (!selectedLead || wasHome === null || !knockOutcome) throw new Error("Fill all fields");
      // Log the knock — single endpoint handles status update too
      await apiRequest("POST", `/api/leads/${selectedLead.id}/knock`, {
        repId: user?.teamMemberId,
        wasHome,
        outcome: knockOutcome,
        callbackDate: callbackDate || null,
        callbackTime: callbackTime || null,
        notes: knockNotes || null,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/leads"] });
      toast({ title: knockOutcome === "sold" ? "Sale logged! 🎉" : "Knock logged" });
      setSelectedLead(null);
      setKnockOutcome("");
      setKnockNotes("");
      setWasHome(null);
      setCallbackDate("");
      setCallbackTime("");
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const requestMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/territory-requests", { message: requestMsg }).then(r => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/territory-requests", "my-pending"] });
      toast({ title: "Request sent", description: "Your admin has been notified." });
      setShowRequestForm(false);
      setRequestMsg("");
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  // ── Mapbox ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!mapConfig?.token || !mapContainerRef.current || mapRef.current) return;
    const token = mapConfig.token;

    // mapboxgl is loaded via CDN <script> in index.html — just wait for it
    const tryInit = () => {
      const mapboxgl = (window as any).mapboxgl;
      if (!mapboxgl) { setTimeout(tryInit, 150); return; }
      mapboxgl.accessToken = token;
      doInit(mapboxgl);
    };
    const doInit = (mapboxgl: any) => {

      const map = new mapboxgl.Map({
        container: mapContainerRef.current!,
        style: "mapbox://styles/mapbox/dark-v11",
        center: [-80.41, 35.55],
        zoom: 12,
      });

      mapRef.current = map;

      map.on("load", () => {
        // Draw territory polygons
        myTerritories.forEach(t => {
          try {
            const coords = JSON.parse(t.polygon) as [number, number][];
            const geojson = {
              type: "Feature" as const,
              geometry: { type: "Polygon" as const, coordinates: [coords.map(([lng, lat]) => [lng, lat])] },
              properties: {},
            };
            map.addSource(`my-terr-${t.id}`, { type: "geojson", data: geojson });
            map.addLayer({ id: `my-terr-fill-${t.id}`, type: "fill", source: `my-terr-${t.id}`,
              paint: { "fill-color": t.color || "#3b82f6", "fill-opacity": 0.1 } });
            map.addLayer({ id: `my-terr-line-${t.id}`, type: "line", source: `my-terr-${t.id}`,
              paint: { "line-color": t.color || "#3b82f6", "line-width": 2 } });
          } catch {}
        });

        // Add lead markers
        markersRef.current.forEach(m => m.remove());
        markersRef.current = [];

        myLeads.forEach(lead => {
          if (!lead.lat || !lead.lng) return;
          const statusColorMap: Record<string, string> = {
            prospect: "#60a5fa",
            interested: "#fbbf24",
            sold: "#34d399",
            not_interested: "#ef4444",
            follow_up: "#a78bfa",
            contacted: "#94a3b8",
          };
          const color = statusColorMap[lead.leadStatus] || "#60a5fa";
          const el = document.createElement("div");
          el.style.cssText = `width:12px;height:12px;border-radius:50%;background:${color};border:2px solid rgba(255,255,255,0.6);cursor:pointer;transition:transform .15s`;
          el.onmouseover = () => el.style.transform = "scale(1.6)";
          el.onmouseout = () => el.style.transform = "scale(1)";
          el.onclick = () => setSelectedLead(lead);

          const marker = new mapboxgl.Marker({ element: el })
            .setLngLat([lead.lng, lead.lat])
            .addTo(map);
          markersRef.current.push(marker);
        });

        // Fit bounds to territory
        if (myLeads.length > 0) {
          const lngs = myLeads.filter(l => l.lng).map(l => l.lng!);
          const lats = myLeads.filter(l => l.lat).map(l => l.lat!);
          map.fitBounds(
            [[Math.min(...lngs) - 0.01, Math.min(...lats) - 0.01],
             [Math.max(...lngs) + 0.01, Math.max(...lats) + 0.01]],
            { padding: 40, duration: 800 }
          );
        }
      });
    }; // end doInit
    tryInit();

    // Load mapbox CSS
    if (!document.getElementById("mapbox-css")) {
      const link = document.createElement("link");
      link.id = "mapbox-css";
      link.rel = "stylesheet";
      link.href = "https://api.mapbox.com/mapbox-gl-js/v3.3.0/mapbox-gl.css";
      document.head.appendChild(link);
    }
  }, [mapConfig]);

  // ── No territory state ─────────────────────────────────────────────────────
  if (myTerritories.length === 0 && myLeads.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-5 p-6 text-center">
        <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center">
          <MapPin className="w-8 h-8 text-primary" />
        </div>
        <div>
          <p className="font-bold text-foreground text-base mb-1">No territory assigned yet</p>
          <p className="text-sm text-muted-foreground max-w-xs">
            Your admin hasn't drawn your territory yet. Request one below and they'll assign it shortly.
          </p>
        </div>

        {!showRequestForm ? (
          <button
            onClick={() => setShowRequestForm(true)}
            className="flex items-center gap-2 bg-primary text-primary-foreground font-semibold px-5 py-3 rounded-xl text-sm"
            data-testid="button-request-territory"
          >
            <Send className="w-4 h-4" /> Request Territory
          </button>
        ) : (
          <div className="w-full max-w-sm space-y-3">
            <textarea
              value={requestMsg}
              onChange={e => setRequestMsg(e.target.value)}
              placeholder="Any notes for your admin? (optional)"
              rows={2}
              className="w-full bg-card border border-border rounded-xl px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground resize-none outline-none focus:border-primary/50"
            />
            <div className="flex gap-2">
              <button onClick={() => setShowRequestForm(false)}
                className="flex-1 border border-border text-muted-foreground text-sm py-2.5 rounded-xl">
                Cancel
              </button>
              <button
                onClick={() => requestMutation.mutate()}
                disabled={requestMutation.isPending}
                className="flex-1 bg-primary text-primary-foreground text-sm font-semibold py-2.5 rounded-xl"
              >
                {requestMutation.isPending ? "Sending…" : "Send Request"}
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">

      {/* ── Stats bar ── */}
      <div className="flex gap-3 p-4 pb-2 overflow-x-auto shrink-0">
        {[
          { label: "Total Leads", value: totalLeads, icon: <MapPin className="w-4 h-4" />, color: "text-blue-400" },
          { label: "Knocked", value: `${knocked} (${pct}%)`, icon: <Home className="w-4 h-4" />, color: "text-slate-400" },
          { label: "Interested", value: interested, icon: <Star className="w-4 h-4" />, color: "text-amber-400" },
          { label: "Sold", value: sold, icon: <CheckCircle2 className="w-4 h-4" />, color: "text-green-400" },
        ].map(s => (
          <div key={s.label} className="flex-shrink-0 bg-card border border-border rounded-xl px-3 py-2.5 min-w-[100px]">
            <div className={`flex items-center gap-1.5 mb-0.5 ${s.color}`}>{s.icon}<span className="text-[10px] font-bold uppercase tracking-wide">{s.label}</span></div>
            <div className="text-lg font-bold text-foreground">{s.value}</div>
          </div>
        ))}
      </div>

      {/* ── Progress bar ── */}
      <div className="px-4 pb-3 shrink-0">
        <div className="flex justify-between text-[11px] text-muted-foreground mb-1">
          <span>Territory progress</span>
          <span>{pct}%</span>
        </div>
        <div className="h-2 bg-secondary rounded-full overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-primary to-blue-400 rounded-full transition-all duration-500"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      {/* ── Map ── */}
      <div className="mx-4 mb-3 rounded-2xl overflow-hidden border border-border shrink-0" style={{ height: 220 }}>
        <div ref={mapContainerRef} style={{ width: "100%", height: "100%" }} />
        {!mapConfig && (
          <div className="flex items-center justify-center h-full text-muted-foreground text-xs gap-1">
            <RefreshCw className="w-3 h-3 animate-spin" /> Loading map…
          </div>
        )}
      </div>

      {/* ── Lead list ── */}
      <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-2">
        <div className="flex items-center justify-between mb-1">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            Your Leads — {myLeads.length} addresses
          </p>
          <button
            onClick={() => setShowRequestForm(true)}
            className="text-xs text-primary font-semibold flex items-center gap-1 hover:underline"
            data-testid="button-request-new-territory"
          >
            <Send className="w-3 h-3" /> Request New Territory
          </button>
        </div>

        {showRequestForm && (
          <div className="bg-card border border-primary/30 rounded-2xl p-4 space-y-3 mb-2">
            <p className="text-sm font-semibold text-foreground">Request a new territory</p>
            <textarea
              value={requestMsg}
              onChange={e => setRequestMsg(e.target.value)}
              placeholder="Any notes for your admin? e.g. 'Finished Lochshire area'"
              rows={2}
              className="w-full bg-secondary/50 border border-border rounded-xl px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground resize-none outline-none focus:border-primary/50"
            />
            <div className="flex gap-2">
              <button onClick={() => setShowRequestForm(false)}
                className="flex-1 border border-border text-muted-foreground text-sm py-2 rounded-xl">
                Cancel
              </button>
              <button
                onClick={() => requestMutation.mutate()}
                disabled={requestMutation.isPending}
                className="flex-1 bg-primary text-primary-foreground text-sm font-semibold py-2 rounded-xl"
                data-testid="button-send-territory-request"
              >
                {requestMutation.isPending ? "Sending…" : "Send Request"}
              </button>
            </div>
          </div>
        )}

        {myLeads.length === 0 && (
          <div className="text-center py-10 text-muted-foreground text-sm">
            No leads in your territory yet. Check back after your admin runs the scanner.
          </div>
        )}

        {myLeads
          .sort((a, b) => {
            // Sort: prospect first, then by status priority
            const order: Record<string, number> = { prospect: 0, follow_up: 1, interested: 2, contacted: 3, not_interested: 4, sold: 5 };
            return (order[a.leadStatus] ?? 3) - (order[b.leadStatus] ?? 3);
          })
          .map(lead => (
            <button
              key={lead.id}
              onClick={() => setSelectedLead(lead)}
              className={`w-full text-left bg-card border rounded-2xl p-3.5 transition-all hover:border-primary/40 active:scale-[.99] ${
                selectedLead?.id === lead.id ? "border-primary/60 bg-primary/5" : "border-border"
              }`}
              data-testid={`card-lead-${lead.id}`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-foreground text-sm truncate">{lead.address}</p>
                  <p className="text-xs text-muted-foreground">{lead.city}, {lead.state} {lead.zip}</p>
                  {lead.maxDownloadMbps && (
                    <p className="text-xs text-primary mt-0.5">{lead.maxDownloadMbps} Mbps fiber available</p>
                  )}
                </div>
                <div className="flex flex-col items-end gap-1.5 shrink-0">
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full capitalize ${STATUS_COLORS[lead.leadStatus] || "bg-secondary text-muted-foreground"}`}>
                    {lead.leadStatus.replace("_", " ")}
                  </span>
                  <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
                </div>
              </div>
            </button>
          ))}
      </div>

      {/* ── Knock logger drawer ── */}
      {selectedLead && (
        <div className="fixed inset-0 z-50 flex items-end" onClick={e => { if (e.target === e.currentTarget) setSelectedLead(null); }}>
          <div className="w-full bg-card border-t border-border rounded-t-3xl p-5 space-y-4 max-h-[85vh] overflow-y-auto animate-in slide-in-from-bottom duration-200">
            {/* Header */}
            <div className="flex items-start justify-between">
              <div>
                <p className="font-bold text-foreground">{selectedLead.address}</p>
                <p className="text-xs text-muted-foreground">{selectedLead.city}, {selectedLead.state} {selectedLead.zip}</p>
                {selectedLead.maxDownloadMbps && (
                  <div className="flex items-center gap-1 mt-1">
                    <Wifi className="w-3 h-3 text-primary" />
                    <span className="text-xs text-primary">{selectedLead.maxDownloadMbps} Mbps · {selectedLead.chipSetType || "Fiber"}</span>
                  </div>
                )}
              </div>
              <button onClick={() => setSelectedLead(null)} className="text-muted-foreground hover:text-foreground p-1">
                <XCircle className="w-5 h-5" />
              </button>
            </div>

            {/* Navigate button */}
            <a
              href={`https://maps.google.com/?q=${selectedLead.lat},${selectedLead.lng}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center gap-2 w-full border border-border text-muted-foreground text-sm py-2.5 rounded-xl hover:border-primary/40 hover:text-foreground transition-colors"
            >
              <Navigation className="w-4 h-4" /> Navigate to this address
            </a>

            {/* Was someone home? */}
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Was someone home?</p>
              <div className="flex gap-2">
                <button
                  onClick={() => setWasHome(true)}
                  className={`flex-1 py-2.5 rounded-xl text-sm font-semibold border transition-colors ${
                    wasHome === true ? "bg-green-500/15 border-green-500/40 text-green-300" : "border-border text-muted-foreground"
                  }`}
                  data-testid="button-was-home-yes"
                >
                  Yes
                </button>
                <button
                  onClick={() => setWasHome(false)}
                  className={`flex-1 py-2.5 rounded-xl text-sm font-semibold border transition-colors ${
                    wasHome === false ? "bg-red-500/10 border-red-500/30 text-red-400" : "border-border text-muted-foreground"
                  }`}
                  data-testid="button-was-home-no"
                >
                  No — Left Door
                </button>
              </div>
            </div>

            {/* Outcome */}
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Outcome</p>
              <div className="grid grid-cols-3 gap-2">
                {OUTCOMES.map(o => (
                  <button
                    key={o.value}
                    onClick={() => setKnockOutcome(o.value)}
                    className={`py-2.5 px-2 rounded-xl border text-center transition-colors ${
                      knockOutcome === o.value
                        ? "border-primary/60 bg-primary/10"
                        : "border-border hover:border-primary/30"
                    }`}
                    data-testid={`button-outcome-${o.value}`}
                  >
                    <div className="text-lg">{o.icon}</div>
                    <div className={`text-[10px] font-semibold mt-0.5 ${knockOutcome === o.value ? "text-primary" : "text-muted-foreground"}`}>
                      {o.label}
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {/* Callback fields */}
            {knockOutcome === "callback" && (
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <p className="text-[10px] text-muted-foreground mb-1">Callback Date</p>
                  <input type="date" value={callbackDate} onChange={e => setCallbackDate(e.target.value)}
                    className="w-full bg-secondary/50 border border-border rounded-xl px-3 py-2 text-sm text-foreground outline-none" />
                </div>
                <div>
                  <p className="text-[10px] text-muted-foreground mb-1">Callback Time</p>
                  <input type="time" value={callbackTime} onChange={e => setCallbackTime(e.target.value)}
                    className="w-full bg-secondary/50 border border-border rounded-xl px-3 py-2 text-sm text-foreground outline-none" />
                </div>
              </div>
            )}

            {/* Notes */}
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">Notes (optional)</p>
              <textarea
                value={knockNotes}
                onChange={e => setKnockNotes(e.target.value)}
                placeholder="e.g. Spoke with homeowner, interested in gig speed…"
                rows={2}
                className="w-full bg-secondary/50 border border-border rounded-xl px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground resize-none outline-none focus:border-primary/50"
                data-testid="input-knock-notes"
              />
            </div>

            {/* Log button */}
            <button
              onClick={() => knockMutation.mutate()}
              disabled={knockMutation.isPending || wasHome === null || !knockOutcome}
              className="w-full bg-primary disabled:bg-secondary disabled:text-muted-foreground text-primary-foreground font-bold py-4 rounded-2xl text-sm transition-colors"
              data-testid="button-log-knock"
            >
              {knockMutation.isPending ? "Logging…" : "Log Door Knock"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
