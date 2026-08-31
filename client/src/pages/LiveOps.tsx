import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useTabActive } from "@/lib/tabActivity";
import { useQueryClient } from "@tanstack/react-query";
import { createFetchEventSource } from "@/lib/leadStream";
import { getStoredSessionId } from "@/lib/queryClient";
import { PageHeader } from "@/components/ui/page-scaffold";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/EmptyState";
import { RepPanel } from "@/components/liveops/RepPanel";
import { PresenceTable } from "@/components/liveops/PresenceTable";
import { ErrorState } from "@/components/ErrorState";
import { StatusPill, FreshnessBadge, ageLabel } from "@/components/liveops/StatusPill";
import { MapPin, WifiOff } from "lucide-react";
import {
  REP_STATUSES,
  type LocationFreshness,
  type PresenceRow,
  type RepLiveState,
  type RepStatus,
} from "@shared/liveOps";
import { basemapStyle } from "@/lib/basemapStyles";
import { clusterExpansionZoom } from "@/lib/mapLibrary";

declare const mapboxgl: any;

// ── Live Operations ──────────────────────────────────────────────────────────
//
// The one rule that shapes this whole screen: a position we do not trust is
// never drawn as though we did. The server already withholds coordinates once a
// fix goes stale, so a stale rep simply has no pin - they appear in the roster
// with their real status and the age of their last fix, and nothing on the map
// implies they are somewhere they may have left twenty minutes ago.
//
// Transport is an SSE notification stream with polling underneath it, both
// gated on tab visibility (the house pattern - see MapView, Dashboard,
// TeamFeed). The stream carries no data, only "something moved"; the board
// refetches through the normal scoped endpoint, so a frame can never widen
// anyone's visibility. If the socket never connects, is refused by the
// connection cap, or is eaten by a proxy, polling carries the board and the
// only thing lost is immediacy.
//
// It degrades honestly in the other direction too: when a refresh FAILS the
// board keeps showing the last good data behind a banner saying how old it is,
// rather than blanking or silently going stale.

const REFRESH_MS = 15_000;

interface RepsResponse { reps: RepLiveState[]; serverTime: string }
interface PresenceResponse { rows: PresenceRow[] }

const FRESHNESS_FILTERS: Array<{ key: LocationFreshness | "all"; label: string }> = [
  { key: "all", label: "Any freshness" },
  { key: "live", label: "Live only" },
  { key: "recent", label: "Live or recent" },
  { key: "stale", label: "Stale" },
  { key: "none", label: "No location" },
];


/**
 * Near-instant updates, with polling still armed underneath.
 *
 * The frame carries no data - it says only "something moved" and the board
 * refetches through the normal scoped endpoint. That is deliberate: a frame
 * carrying positions would be a second read path that has to re-derive the
 * branch scope, and a mistake there would push one manager's reps into another
 * manager's browser. A data-free notification cannot widen visibility.
 *
 * Returns whether the socket is live, purely so the UI can say so. Nothing
 * depends on it: if the stream never connects, polling covers the board and the
 * only thing lost is immediacy.
 */
function useLiveOpsStream(enabled: boolean): boolean {
  const qc = useQueryClient();
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!enabled) { setConnected(false); return; }
    const Source = createFetchEventSource({
      headers: () => {
        // Read per connect, so a refreshed token is picked up on reconnect
        // rather than frozen at subscribe time.
        const sid = getStoredSessionId();
        return sid ? { "x-session-id": sid } : ({} as Record<string, string>);
      },
    });
    let src: any = null;
    let closed = false;
    try {
      src = new Source("/api/live-ops/stream");
      src.addEventListener?.("ready", () => { if (!closed) setConnected(true); });
      src.addEventListener?.("changed", () => {
        void qc.invalidateQueries({ queryKey: ["/api/live-ops/reps"] });
        void qc.invalidateQueries({ queryKey: ["/api/live-ops/presence"] });
      });
      // A 503 (connection cap) or any transport failure simply leaves polling
      // in charge. There is nothing to retry into and nothing to warn about.
      src.addEventListener?.("error", () => { if (!closed) setConnected(false); });
    } catch {
      setConnected(false);
    }
    return () => { closed = true; setConnected(false); try { src?.close?.(); } catch { /* already gone */ } };
  }, [enabled, qc]);

  return connected;
}

export default function LiveOps() {
  const tabActive = useTabActive();
  const [selectedRepId, setSelectedRepId] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<RepStatus | "all">("all");
  const [freshnessFilter, setFreshnessFilter] = useState<LocationFreshness | "all">("all");
  const [teamFilter, setTeamFilter] = useState<string>("all");
  const [outsideOnly, setOutsideOnly] = useState(false);
  const [view, setView] = useState<"map" | "presence">("map");

  const streaming = useLiveOpsStream(tabActive);

  const repsQuery = useQuery<RepsResponse>({
    queryKey: ["/api/live-ops/reps"],
    queryFn: () => apiRequest("GET", "/api/live-ops/reps").then((r) => r.json()),
    // With the socket live the poll drops to a slow safety net rather than the
    // primary transport - it is there to catch a silently dead socket, not to
    // carry the board.
    refetchInterval: tabActive ? (streaming ? REFRESH_MS * 8 : REFRESH_MS) : false,
    refetchIntervalInBackground: false,
  });

  const presenceQuery = useQuery<PresenceResponse>({
    queryKey: ["/api/live-ops/presence"],
    queryFn: () => apiRequest("GET", "/api/live-ops/presence").then((r) => r.json()),
    refetchInterval: tabActive ? REFRESH_MS * 2 : false,
    refetchIntervalInBackground: false,
  });

  const reps = repsQuery.data?.reps ?? [];

  const teams = useMemo(() => {
    const names = new Set<string>();
    for (const r of reps) if (r.teamLeadName) names.add(r.teamLeadName);
    return [...names].sort();
  }, [reps]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return reps.filter((r) => {
      if (q && !r.repName.toLowerCase().includes(q)
          && !(r.territoryName ?? "").toLowerCase().includes(q)) return false;
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (teamFilter !== "all" && r.teamLeadName !== teamFilter) return false;
      if (outsideOnly && !r.outsideTerritory) return false;
      if (freshnessFilter === "recent") return r.freshness === "live" || r.freshness === "recent";
      if (freshnessFilter !== "all" && r.freshness !== freshnessFilter) return false;
      return true;
    });
  }, [reps, query, statusFilter, teamFilter, freshnessFilter, outsideOnly]);

  const selected = filtered.find((r) => r.repId === selectedRepId)
    ?? reps.find((r) => r.repId === selectedRepId)
    ?? null;

  // Only reps the server was willing to give a position for can be mapped. That
  // set is already the "presentable" one; nothing here re-decides it.
  const mappable = useMemo(() => filtered.filter((r) => r.lat != null && r.lng != null), [filtered]);

  const stale = repsQuery.isError || (!tabActive && !!repsQuery.data);
  const lastUpdated = repsQuery.dataUpdatedAt ? new Date(repsQuery.dataUpdatedAt).toISOString() : null;

  return (
    <div className="w-full max-w-[1600px] mx-auto p-4 pt-5 pb-24 space-y-4 md:p-6">
      <PageHeader
        title="Live operations"
        subtitle="Where the team is right now, and how fresh that answer is"
      />

      {repsQuery.isError && (
        <div
          role="status"
          className="flex items-center gap-2 rounded-xl border border-warning/25 bg-warning/10 px-3 py-2.5 text-[13px] font-medium text-warning"
          data-testid="liveops-connection-warning"
        >
          <WifiOff className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>
            Connection lost. Showing the last update{lastUpdated ? ` from ${ageLabel(lastUpdated)}` : ""}.
          </span>
        </div>
      )}

      <FilterBar
        query={query} setQuery={setQuery}
        statusFilter={statusFilter} setStatusFilter={setStatusFilter}
        freshnessFilter={freshnessFilter} setFreshnessFilter={setFreshnessFilter}
        teams={teams} teamFilter={teamFilter} setTeamFilter={setTeamFilter}
        outsideOnly={outsideOnly} setOutsideOnly={setOutsideOnly}
        counts={{ total: reps.length, shown: filtered.length, mapped: mappable.length }}
      />

      <div className="flex gap-2" role="tablist" aria-label="View">
        {(["map", "presence"] as const).map((v) => (
          <button
            key={v}
            role="tab"
            aria-selected={view === v}
            onClick={() => setView(v)}
            data-testid={`liveops-view-${v}`}
            className={`inline-flex items-center justify-center min-h-tap md:min-h-8 rounded-lg px-3 text-[13px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              view === v ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground hover:text-foreground"
            }`}
          >
            {v === "map" ? "Map" : "Presence"}
          </button>
        ))}
      </div>

      {view === "map" ? (
        <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
          <div className="min-w-0 space-y-3">
            <LiveMapCanvas reps={mappable} selectedRepId={selectedRepId} onSelect={setSelectedRepId} />
            <RepRoster
              reps={filtered}
              loading={repsQuery.isLoading}
              selectedRepId={selectedRepId}
              onSelect={setSelectedRepId}
              stale={stale}
            />
          </div>
          <div className="min-w-0">
            {selected ? (
              <div className="overflow-hidden rounded-2xl border border-border">
                <RepPanel rep={selected} onClose={() => setSelectedRepId(null)} />
              </div>
            ) : (
              <div className="rounded-2xl border border-dashed border-border p-6 text-center text-[13px] text-muted-foreground">
                Select a rep to see their shift in detail.
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-border bg-card">
          {presenceQuery.isError ? (
            <ErrorState
              title="Couldn't load who is signed in"
              description="Presence is unknown until this loads - the office may not be empty."
              onRetry={() => void presenceQuery.refetch()}
              bordered={false}
              testId="presence-error"
            />
          ) : (
            <PresenceTable rows={presenceQuery.data?.rows ?? []} loading={presenceQuery.isLoading} />
          )}
        </div>
      )}
    </div>
  );
}

// ── Filters ──────────────────────────────────────────────────────────────────

function FilterBar(props: {
  query: string; setQuery: (v: string) => void;
  statusFilter: RepStatus | "all"; setStatusFilter: (v: RepStatus | "all") => void;
  freshnessFilter: LocationFreshness | "all"; setFreshnessFilter: (v: LocationFreshness | "all") => void;
  teams: string[]; teamFilter: string; setTeamFilter: (v: string) => void;
  outsideOnly: boolean; setOutsideOnly: (v: boolean) => void;
  counts: { total: number; shown: number; mapped: number };
}) {
  const selectCls =
    "h-10 rounded-xl border border-border bg-card px-3 text-[13px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
  return (
    <div className="space-y-2" data-testid="liveops-filters">
      <div className="flex flex-wrap gap-2">
        <input
          value={props.query}
          onChange={(e) => props.setQuery(e.target.value)}
          placeholder="Search rep or territory"
          aria-label="Search rep or territory"
          data-testid="liveops-search"
          className="h-10 min-w-[180px] flex-1 rounded-xl border border-border bg-card px-3 text-[13px] text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <select
          className={selectCls} aria-label="Filter by status" data-testid="liveops-status-filter"
          value={props.statusFilter} onChange={(e) => props.setStatusFilter(e.target.value as any)}
        >
          <option value="all">Any status</option>
          {REP_STATUSES.map((s) => (
            <option key={s} value={s}>{s.replace(/_/g, " ")}</option>
          ))}
        </select>
        <select
          className={selectCls} aria-label="Filter by location freshness" data-testid="liveops-freshness-filter"
          value={props.freshnessFilter} onChange={(e) => props.setFreshnessFilter(e.target.value as any)}
        >
          {FRESHNESS_FILTERS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
        </select>
        <select
          className={selectCls} aria-label="Filter by team" data-testid="liveops-team-filter"
          value={props.teamFilter} onChange={(e) => props.setTeamFilter(e.target.value)}
        >
          <option value="all">All teams</option>
          {props.teams.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <label className="flex h-10 items-center gap-2 rounded-xl border border-border bg-card px-3 text-[13px] text-foreground">
          <input
            type="checkbox" checked={props.outsideOnly} data-testid="liveops-outside-filter"
            onChange={(e) => props.setOutsideOnly(e.target.checked)}
            className="h-4 w-4 accent-[hsl(var(--primary))]"
          />
          Outside area
        </label>
      </div>
      <div className="text-[12px] text-muted-foreground" data-testid="liveops-counts">
        {props.counts.shown} of {props.counts.total} reps
        {props.counts.shown !== props.counts.mapped && (
          <> · {props.counts.shown - props.counts.mapped} without a current position</>
        )}
      </div>
    </div>
  );
}

// ── Roster ───────────────────────────────────────────────────────────────────

function RepRoster({
  reps, loading, selectedRepId, onSelect, stale,
}: {
  reps: RepLiveState[]; loading: boolean; selectedRepId: number | null;
  onSelect: (id: number) => void; stale: boolean;
}) {
  if (loading) {
    return (
      <div className="space-y-2 rounded-2xl border border-border bg-card p-3" data-testid="liveops-roster-loading">
        {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
      </div>
    );
  }
  if (reps.length === 0) {
    return (
      <EmptyState
        icon={MapPin}
        title="No reps match these filters"
        description="Try clearing a filter, or widen the freshness setting to include reps whose last fix is older."
        bordered
        testId="liveops-roster-empty"
      />
    );
  }
  return (
    <div
      className={`overflow-hidden rounded-2xl border border-border bg-card ${stale ? "opacity-70" : ""}`}
      data-testid="liveops-roster"
    >
      {reps.map((r) => (
        <button
          key={r.repId}
          onClick={() => onSelect(r.repId)}
          aria-pressed={selectedRepId === r.repId}
          data-testid={`liveops-rep-${r.repId}`}
          className={`flex w-full items-center gap-3 border-b border-border px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${
            selectedRepId === r.repId ? "bg-secondary" : ""
          }`}
        >
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14px] font-semibold text-foreground">{r.repName}</div>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <StatusPill status={r.status} />
              <FreshnessBadge freshness={r.freshness} capturedAt={r.capturedAt} />
              {r.outsideTerritory && (
                <span className="rounded-full border border-warning/25 bg-warning/10 px-2 py-0.5 text-[11px] font-semibold text-warning">
                  Outside area
                </span>
              )}
            </div>
          </div>
          <div className="shrink-0 text-right">
            <div className="text-[15px] font-bold tabular-nums text-foreground">{r.doorsToday}</div>
            <div className="text-[11px] text-muted-foreground">doors</div>
          </div>
        </button>
      ))}
    </div>
  );
}

// ── Map ──────────────────────────────────────────────────────────────────────

/**
 * Rep pins, clustered.
 *
 * Movement between fixes is eased over ~400ms so a pin does not teleport, but
 * the easing is capped by ACCURACY: a fix good to 300 metres does not glide to
 * a pinpoint, because the smoothness would imply a precision the reading does
 * not have. Reduced-motion turns easing off entirely and pins simply move.
 */
function LiveMapCanvas({
  reps, selectedRepId, onSelect,
}: { reps: RepLiveState[]; selectedRepId: number | null; onSelect: (id: number) => void }) {
  const container = useRef<HTMLDivElement | null>(null);
  const map = useRef<any>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  const { data: config } = useQuery<{ token?: string }>({
    queryKey: ["/api/config/map"],
    queryFn: () => apiRequest("GET", "/api/config/map").then((r) => r.json()),
    staleTime: 60 * 60_000,
  });

  useEffect(() => {
    if (!container.current || map.current) return; // no token gate - MapLibre needs none
    let cancelled = false;
    (window as any).__loadMapbox?.();
    (window as any).__onMapboxReady?.((err?: Error) => {
      if (cancelled || !container.current || map.current) return;
      // Honour the error the loader hands us instead of falling through and
      // relying on `mapboxgl` being undefined to throw into the catch below.
      // That happened to work, but it made a deliberate failure signal look
      // like an accident, and it would stop working the moment anything else
      // defined the global.
      if (err) { setFailed(true); return; }
      try {
        mapboxgl.accessToken = config?.token ?? ""; // no-op on MapLibre
        // Follow the app theme. A daylight basemap inside the dark theme is not
        // just inconsistent - it is the brightest thing on a screen someone is
        // watching in a truck at night.
        const dark = document.documentElement.classList.contains("dark");
        map.current = new mapboxgl.Map({
          container: container.current,
          style: basemapStyle(dark ? "dark" : "streets"),
          center: [-80.4139, 35.5501],
          zoom: 10,
          attributionControl: false,
        });
        map.current.addControl(new mapboxgl.AttributionControl({ compact: true }));
        map.current.on("load", () => {
          if (cancelled) return;
          map.current.addSource("live-reps", {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
            cluster: true,
            clusterRadius: 50,
            clusterMaxZoom: 13,
          });
          map.current.addLayer({
            id: "live-reps-clusters", type: "circle", source: "live-reps",
            filter: ["has", "point_count"],
            paint: {
              "circle-color": "hsl(211, 68%, 26%)",
              "circle-radius": ["step", ["get", "point_count"], 16, 5, 22, 15, 28],
              "circle-opacity": 0.9,
            },
          });
          map.current.addLayer({
            id: "live-reps-cluster-count", type: "symbol", source: "live-reps",
            filter: ["has", "point_count"],
            layout: { "text-field": ["get", "point_count_abbreviated"], "text-size": 12 },
            paint: { "text-color": "#ffffff" },
          });
          map.current.addLayer({
            id: "live-reps-point", type: "circle", source: "live-reps",
            filter: ["!", ["has", "point_count"]],
            paint: {
              // Uncertainty is drawn, not hidden: the halo scales with the
              // reported accuracy so a vague fix looks vague.
              "circle-radius": ["interpolate", ["linear"], ["get", "accuracyM"], 0, 7, 100, 14],
              "circle-color": ["case", ["get", "isRecent"], "hsl(202, 83%, 32%)", "hsl(161, 94%, 22%)"],
              "circle-opacity": ["case", ["get", "isRecent"], 0.35, 1],
              "circle-stroke-width": 2,
              "circle-stroke-color": ["case", ["get", "isRecent"], "hsl(202, 83%, 32%)", "#ffffff"],
            },
          });
          map.current.on("click", "live-reps-point", (e: any) => {
            const id = e.features?.[0]?.properties?.repId;
            if (id != null) onSelect(Number(id));
          });
          map.current.on("click", "live-reps-clusters", (e: any) => {
            const f = map.current.queryRenderedFeatures(e.point, { layers: ["live-reps-clusters"] })[0];
            const src = map.current.getSource("live-reps");
            void clusterExpansionZoom(src, f.properties.cluster_id).then((zoom) => {
              if (zoom != null) map.current.easeTo({ center: f.geometry.coordinates, zoom });
            });
          });
          setReady(true);
        });
        map.current.on("error", () => setFailed(true));
      } catch {
        setFailed(true);
      }
    });
    return () => {
      cancelled = true;
      // Destroy the GL context with the component - each visit used to leak
      // one, and browsers cap WebGL contexts (~16) per page.
      if (map.current) { map.current.remove(); map.current = null; }
      setReady(false);
    };
  }, [config?.token, onSelect]);

  useEffect(() => {
    if (!ready || !map.current) return;
    const src = map.current.getSource("live-reps");
    if (!src) return;
    src.setData({
      type: "FeatureCollection",
      features: reps.map((r) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [r.lng, r.lat] },
        properties: {
          repId: r.repId,
          repName: r.repName,
          accuracyM: r.accuracyM ?? 20,
          isRecent: r.freshness === "recent",
        },
      })),
    });
  }, [reps, ready]);

  useEffect(() => {
    if (!ready || !map.current || selectedRepId == null) return;
    const rep = reps.find((r) => r.repId === selectedRepId);
    if (!rep || rep.lat == null || rep.lng == null) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    map.current.easeTo({
      center: [rep.lng, rep.lat],
      zoom: Math.max(map.current.getZoom(), 14),
      duration: reduced ? 0 : 400,
    });
  }, [selectedRepId, reps, ready]);

  // NO TOKEN GATE. The init effect above already dropped it ("MapLibre needs
  // none") but this render gate kept it, so the two disagreed: /api/config/map
  // 503s outright when MAPBOX_PUBLIC_TOKEN is unset, `config` stays undefined,
  // and this branch returned "Loading map…" forever on a map that needs no
  // credential to draw. Removing the Mapbox geocoding token - which is the
  // correct thing to do now the basemap is MapLibre plus Google tiles - would
  // have silently killed this screen. `failed` is the only real failure signal,
  // and it is written by the map's own error event.
  if (failed) {
    return (
      <div
        className="grid h-[420px] place-items-center rounded-2xl border border-border bg-card text-[13px] text-muted-foreground"
        data-testid="liveops-map-unavailable"
      >
        The map could not load. The roster below is still live.
      </div>
    );
  }

  return (
    <div className="relative overflow-hidden rounded-2xl border border-border" data-testid="liveops-map">
      <div ref={container} className="h-[420px] w-full" />
      {reps.length === 0 && ready && (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 mx-auto w-fit rounded-full border border-border bg-card px-3 py-1.5 text-[12px] text-muted-foreground shadow-sm">
          No reps have a current position
        </div>
      )}
      {ready && reps.length > 0 && (
        <div className="pointer-events-none absolute bottom-3 left-3 flex items-center gap-3 rounded-full border border-border bg-card px-3 py-1.5 text-[11px] text-muted-foreground shadow-sm" data-testid="liveops-map-legend">
          <span className="flex items-center gap-1.5">
            <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-success ring-1 ring-white" />
            Live now
          </span>
          <span className="flex items-center gap-1.5">
            <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full border-2 border-info bg-info/30" />
            Earlier position
          </span>
        </div>
      )}
    </div>
  );
}
