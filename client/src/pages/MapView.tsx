import {
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
  useReducer,
  useSyncExternalStore,
  useDeferredValue,
} from "react";
// mapbox-gl loaded via CDN in index.html — do not bundle
declare const mapboxgl: any;
import {
  Pencil,
  X,
  Map as MapIcon,
  Bell,
  Target,
  Search,
  LocateFixed,
  Menu,
  Lasso,
  Radar,
  Loader2,
  Layers,
  CheckCircle2,
  AlertCircle,
  List,
  Navigation,
  Plus,
  Crosshair,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest, getStoredSessionId } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { LeadCard, type CardProperty } from "@/components/LeadCard";
import { AddLeadSheet } from "@/components/AddLeadSheet";
import { reverseGeocode } from "@/lib/reverseGeocode";
import { useAuth } from "@/lib/auth";
import { useIsMobile } from "@/hooks/use-mobile";
import type { TeamMember, Territory } from "@shared/schema";
import { colorForRep } from "@shared/repColors";
import { TerritoryDetailPanel } from "@/components/TerritoryDetailPanel";
import { TerritoryActivityDrawer } from "@/components/TerritoryActivityDrawer";
import { LeadKnockSheet } from "@/components/LeadKnockSheet";
import { LeadsInViewPanel } from "@/components/LeadsInViewPanel";
import {
  getKnockQueue,
  type KnockQueue,
  type QueueSnapshot,
} from "@/lib/knockQueue";
import { captureFieldFix } from "@/lib/geoFix";
import {
  OUTCOME_TO_STATUS,
  OUTCOME_META,
  pinDisplayState,
  STATE_COLORS,
  STATE_LABELS,
  nearestUnworkedLead,
  summarizeByDisplayState,
  BULK_STATUS_OUTCOMES,
  type KnockOutcome,
  type RoutablePin,
  type PinDisplayState,
} from "@shared/knock";
import { STATUS_CONFIG, toLeadMapStatus } from "@shared/statusConfig";
import {
  saveLeadNote,
  flushPendingNotes,
  type NotePoster,
  type NoteSaveResult,
} from "@/lib/leadNotes";
import {
  UNCLUSTERED_PAINT,
  SELECTED_RING_SPEC,
  SELECTED_RING_FILTER,
  sheetPeekPaddingPx,
  moveCamera,
  STREET_ZOOM,
  pickRepStartCamera,
  readCachedFix,
  writeCachedFix,
  ensureHousenumLayer,
  isSheetDragActive,
} from "@/lib/mapPins";
import {
  createFollowState,
  ingestFix,
  stepFrame,
  filteredLngLat,
} from "@/lib/followCamera";
import {
  selectPointsInPolygon,
  pointInRing,
  bboxOfRing,
  type BBox2,
} from "@/lib/mapGeo";
import {
  registerPinImages,
  iconImageConcatExpression,
  spriteDataUrl,
  type StatusIconKey,
} from "@/lib/statusIcons";
import {
  reconcileLeadFeatures,
  type LeadFeatureCache,
} from "@/lib/leadGeoJson";
import { unpackMapPins } from "@shared/mapPinsWire";
import { useCan } from "@/lib/capabilities";
import { useDiscoveryJobs } from "@/hooks/use-discovery-jobs";
import {
  discoveryApi,
  discoveryIdempotencyKey,
  isActiveDiscoveryJob,
  isTerminalDiscoveryJob,
  type DiscoveryEvent,
} from "@/lib/discoveryApi";
import { dedupeLeads, leadKey } from "@/lib/dedupeLeads";
import {
  areaScanReducer,
  IDLE as AREA_SCAN_IDLE,
  toPersisted as toPersistedAreaScan,
  persistedRunningIsStale,
  type PersistedScan,
} from "@/lib/areaScanMachine";

// localStorage key for the field map's OWN scan lifecycle. Versioned so a
// schema change to PersistedScan never resurrects an incompatible record.
const AREA_SCAN_LS_KEY = "hf.areaScan.v1";

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
  assignedRepId: number | null;
  leadScore: number;
  leadTag?: string | null;
  freshConfidence?: string | null;
  carrier?: string | null;
  visited?: boolean;
  knockCount?: number;
  lastOutcome?: string | null;
  lastKnockedAt?: string | null;
  // Set by dedupeLeads when >1 record collapsed onto this house (survivor
  // carries every underlying lead id, itself first) so a popup can surface all.
  mergedLeadIds?: string[];
  mergedCount?: number;
}

// Mapbox token is fetched from /api/config/map at runtime — not in bundle

const ROCKWELL_CENTER: [number, number] = [-80.41, 35.545];

// Manager legend/search dots read the same canonical config as map pins/cards.
const PIN_COLORS: Record<
  string,
  { bg: string; border: string; label: string }
> = {
  prospect: {
    bg: STATUS_CONFIG.prospect.color,
    border: "#86efac",
    label: STATUS_CONFIG.prospect.label,
  },
  contacted: { bg: "#64748b", border: "#cbd5e1", label: "Contacted" }, // slate
  interested: {
    bg: STATUS_CONFIG.interested.color,
    border: "#c4b5fd",
    label: STATUS_CONFIG.interested.label,
  },
  follow_up: {
    bg: STATUS_CONFIG.follow_up.color,
    border: "#fdba74",
    label: STATUS_CONFIG.follow_up.label,
  },
  sold: {
    bg: STATUS_CONFIG.sold.color,
    border: "#86efac",
    label: STATUS_CONFIG.sold.label,
  },
  not_interested: {
    bg: STATUS_CONFIG.not_interested.color,
    border: "#fca5a5",
    label: STATUS_CONFIG.not_interested.label,
  },
};

// Search rows and the leads panel label pins by the TRUE display state
// (pinDisplayState → STATE_COLORS/STATE_LABELS from @shared/knock) — the
// PIN_COLORS map above keys on raw leadStatus (6 states) and can't represent
// callback/follow-up aliases and the last-knock-only Not Home state.

// The status-filter legend keys on raw leadStatus (PIN_COLORS); the glyph sprites
// key on PinDisplayState. Only "prospect"→"unworked" differs — the rest are 1:1.
// Used to draw the ACTUAL map glyph beside each legend row when glyph mode is on
// (a11y: glyph→meaning, not color alone).
const LEGEND_STATUS_TO_ICON: Record<string, StatusIconKey> = {
  prospect: "unworked",
  contacted: "contacted",
  interested: "interested",
  follow_up: "follow_up",
  sold: "sold",
  not_interested: "not_interested",
};

// One GPU symbol layer paints every door from the canonical six-status SVG set.
const STATUS_ICON_LAYER = "lead-status-icons";

// Native symbol pins are the production default. NEW_FIELD_MAP=0 remains an
// emergency device-level fallback to the old GPU circle layer.
function newFieldMap(): boolean {
  try {
    return localStorage.getItem("NEW_FIELD_MAP") !== "0";
  } catch {
    return true;
  }
}

// Minimal structural view of the Mapbox map — just the methods the icon layer
// touches. (map is `any` at the call sites, so this only keeps these helpers
// typed without pulling the CDN mapbox types.)
interface FieldIconMap {
  hasImage(id: string): boolean;
  addImage(
    id: string,
    image: HTMLImageElement | ImageBitmap | ImageData,
    options?: { pixelRatio?: number },
  ): void;
  loadImage(
    url: string,
    callback: (
      error?: Error | null,
      image?: HTMLImageElement | ImageBitmap | ImageData,
    ) => void,
  ): void;
  getLayer(id: string): unknown;
  addLayer(layer: unknown): void;
  setLayoutProperty(layer: string, name: string, value: unknown): void;
}

async function addStatusIconLayer(map: FieldIconMap): Promise<void> {
  if (!newFieldMap()) {
    try {
      map.setLayoutProperty("lead-unclustered", "visibility", "visible");
    } catch {
      /* not ready */
    }
    return;
  }
  if (!map.getLayer(STATUS_ICON_LAYER)) {
    try {
      await registerPinImages(map);
    } catch {
      try {
        map.setLayoutProperty("lead-unclustered", "visibility", "visible");
      } catch {
        /* not ready */
      }
      return;
    }
    try {
      map.addLayer({
        id: STATUS_ICON_LAYER,
        type: "symbol",
        source: "leads-cluster",
        filter: ["!", ["has", "point_count"]],
        minzoom: 12,
        layout: {
          "icon-image": iconImageConcatExpression(),
          "icon-size": [
            "interpolate",
            ["linear"],
            ["zoom"],
            12,
            0.5,
            17,
            0.9,
            20,
            1.2,
          ],
          "icon-anchor": "bottom",
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
      });
    } catch {
      // Icon layer failed to add → keep the circle pins visible (never blank).
      try {
        map.setLayoutProperty("lead-unclustered", "visibility", "visible");
      } catch {
        /* not ready */
      }
      return;
    }
  }
  if (map.getLayer(STATUS_ICON_LAYER)) {
    try {
      map.setLayoutProperty("lead-unclustered", "visibility", "none");
    } catch {
      /* not ready */
    }
  }
}

// ── Optional map perf instrument (opt-in, prod-safe) ─────────────────────────
// The status-marker spec asks to observe map FPS / first-paint / frame p95.
// This stack has NO external metrics sink, so rather than fabricate one we expose
// a lightweight, OPT-IN sampler: turn it on with ?perf=1 or localStorage
// MAP_PERF="1". OFF = a no-op (zero overhead in normal use). ON = samples frame
// times via rAF (read-only — never writes the map, so it can't fight the
// follow-camera loop), records first paint (map 'idle'), and console.warns when
// the rolling p95 frame time blows the 20ms budget. Read live numbers from
// window.__mapPerf. Self-cleans on the map's 'remove' event.
interface MapPerf {
  firstPaintMs: number | null;
  frames: number;
  fps(): number;
  p95(): number;
  samples(): number[];
  reset(): void;
}
function startMapPerf(map: any): void {
  let enabled = false;
  try {
    enabled =
      new URLSearchParams(window.location.search).get("perf") === "1" ||
      localStorage.getItem("MAP_PERF") === "1";
  } catch {
    enabled = false;
  }
  if (
    !enabled ||
    typeof requestAnimationFrame !== "function" ||
    typeof performance === "undefined"
  )
    return;

  const start = performance.now();
  const N = 600; // ~10s of frames at 60fps
  const buf: number[] = [];
  let last = start;
  let raf = 0;
  let stopped = false;
  let firstPaintMs: number | null = null;
  let lastWarn = 0;

  const onIdle = () => {
    if (firstPaintMs == null) firstPaintMs = performance.now() - start;
  };
  try {
    map.on("idle", onIdle);
  } catch {
    /* ignore */
  }

  const p95 = (): number => {
    if (!buf.length) return 0;
    const s = [...buf].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
  };
  const tick = () => {
    if (stopped) return;
    const now = performance.now();
    const dt = now - last;
    last = now;
    // Skip the huge gap after a tab-hidden/background pause (not a real frame).
    if (dt > 0 && dt < 1000) {
      buf.push(dt);
      if (buf.length > N) buf.shift();
    }
    if (buf.length >= 60 && now - lastWarn > 5000) {
      const worst = p95();
      if (worst > 20) {
        lastWarn = now;
        const avg = buf.reduce((a, b) => a + b, 0) / buf.length;
        console.warn(
          `[mapPerf] p95 frame ${worst.toFixed(1)}ms > 20ms budget (fps≈${(avg > 0 ? 1000 / avg : 0).toFixed(0)}, n=${buf.length})`,
        );
      }
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  const api: MapPerf = {
    get firstPaintMs() {
      return firstPaintMs;
    },
    get frames() {
      return buf.length;
    },
    fps() {
      if (!buf.length) return 0;
      const avg = buf.reduce((a, b) => a + b, 0) / buf.length;
      return avg > 0 ? 1000 / avg : 0;
    },
    p95,
    samples() {
      return [...buf];
    },
    reset() {
      buf.length = 0;
      last = performance.now();
      lastWarn = 0;
    },
  };
  (window as any).__mapPerf = api;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(raf);
    try {
      map.off?.("idle", onIdle);
    } catch {
      /* ignore */
    }
    if ((window as any).__mapPerf === api) {
      try {
        delete (window as any).__mapPerf;
      } catch {
        /* ignore */
      }
    }
  };
  try {
    map.on("remove", stop);
  } catch {
    /* ignore */
  }
}

// ── Bbox type ─────────────────────────────────────────────────────────────────
interface BBox {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}
function inBBox(lat: number, lng: number, b: BBox) {
  return (
    lat >= b.minLat && lat <= b.maxLat && lng >= b.minLng && lng <= b.maxLng
  );
}

// Stable empty pin array — `mapPinData?.pins ?? EMPTY_PINS` must not allocate a
// fresh [] per render, or every downstream useMemo re-runs until data lands.
const EMPTY_PINS: MapPin[] = [];

const SEARCH_RESULT_SOURCE = "search-result";
const SEARCH_RESULT_HALO_LAYER = "search-result-halo";
const SEARCH_RESULT_POINT_LAYER = "search-result-point";
const SCAN_RESULTS_SOURCE = "scan-results";
const SCAN_RESULTS_CLUSTER_LAYER = "scan-results-clusters";
const SCAN_RESULTS_COUNT_LAYER = "scan-results-count";
const SCAN_RESULTS_POINT_LAYER = "scan-results-points";

const emptyFeatureCollection = () => ({
  type: "FeatureCollection" as const,
  features: [] as any[],
});

/**
 * Transient search + live-scan visuals share Mapbox's worker/WebGL pipeline.
 * This is intentionally idempotent because setStyle() removes custom sources.
 */
function ensureTransientMapLayers(map: any): void {
  if (!map.getSource(SEARCH_RESULT_SOURCE)) {
    map.addSource(SEARCH_RESULT_SOURCE, {
      type: "geojson",
      data: emptyFeatureCollection(),
    });
  }
  if (!map.getLayer(SEARCH_RESULT_HALO_LAYER)) {
    map.addLayer({
      id: SEARCH_RESULT_HALO_LAYER,
      type: "circle",
      source: SEARCH_RESULT_SOURCE,
      paint: {
        "circle-radius": 18,
        "circle-color": "rgba(20,184,166,0.18)",
        "circle-stroke-width": 2,
        "circle-stroke-color": "rgba(94,234,212,0.8)",
      },
    });
  }
  if (!map.getLayer(SEARCH_RESULT_POINT_LAYER)) {
    map.addLayer({
      id: SEARCH_RESULT_POINT_LAYER,
      type: "circle",
      source: SEARCH_RESULT_SOURCE,
      paint: {
        "circle-radius": 7,
        "circle-color": "#14b8a6",
        "circle-stroke-width": 3,
        "circle-stroke-color": "#ffffff",
      },
    });
  }

  if (!map.getSource(SCAN_RESULTS_SOURCE)) {
    map.addSource(SCAN_RESULTS_SOURCE, {
      type: "geojson",
      data: emptyFeatureCollection(),
      cluster: true,
      clusterRadius: 48,
      clusterMaxZoom: 14,
    });
  }
  if (!map.getLayer(SCAN_RESULTS_CLUSTER_LAYER)) {
    map.addLayer({
      id: SCAN_RESULTS_CLUSTER_LAYER,
      type: "circle",
      source: SCAN_RESULTS_SOURCE,
      filter: ["has", "point_count"],
      paint: {
        "circle-radius": ["step", ["get", "point_count"], 16, 20, 22, 100, 29],
        "circle-color": "#16a34a",
        "circle-opacity": 0.9,
        "circle-opacity-transition": { duration: 180, delay: 0 },
        "circle-stroke-width": 2,
        "circle-stroke-color": "#dcfce7",
      },
    });
  }
  if (!map.getLayer(SCAN_RESULTS_COUNT_LAYER)) {
    map.addLayer({
      id: SCAN_RESULTS_COUNT_LAYER,
      type: "symbol",
      source: SCAN_RESULTS_SOURCE,
      filter: ["has", "point_count"],
      layout: {
        "text-field": "{point_count_abbreviated}",
        "text-font": ["DIN Offc Pro Medium", "Arial Unicode MS Bold"],
        "text-size": 12,
        "text-allow-overlap": true,
      },
      paint: {
        "text-color": "#ffffff",
        "text-opacity": 1,
        "text-opacity-transition": { duration: 180, delay: 0 },
      },
    });
  }
  if (!map.getLayer(SCAN_RESULTS_POINT_LAYER)) {
    map.addLayer({
      id: SCAN_RESULTS_POINT_LAYER,
      type: "circle",
      source: SCAN_RESULTS_SOURCE,
      filter: [
        "all",
        ["!", ["has", "point_count"]],
        ["==", ["get", "scanStatus"], "fresh_confirmed"],
      ],
      paint: {
        "circle-radius": 8,
        "circle-opacity": 0.96,
        // Carrier color: Kinetic fresh = green, Frontier fresh = red.
        "circle-color": ["case", ["==", ["get", "carrier"], "frontier"], "#ef4444", "#22c55e"],
        "circle-stroke-width": 2,
        "circle-stroke-color": ["case", ["==", ["get", "carrier"], "frontier"], "#fecaca", "#dcfce7"],
        "circle-blur": 0.08,
        "circle-opacity-transition": { duration: 180, delay: 0 },
        "circle-radius-transition": { duration: 220, delay: 0 },
        "circle-color-transition": { duration: 220, delay: 0 },
      },
    });
  }
}

// Stable empty snapshot for useSyncExternalStore before the queue exists —
// a fresh object per call would loop the store subscription forever.
const EMPTY_QUEUE_SNAP: QueueSnapshot = {
  pendingCount: 0,
  deadCount: 0,
  byLead: {},
  online: true,
};

// Compact "3m ago / 2h ago / 4d ago" for the visited banner.

export default function MapView() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const geolocateRef = useRef<any>(null);
  const suspendFollowCameraRef = useRef<() => void>(() => {});
  const scanGeoJsonRef = useRef<any>(emptyFeatureCollection());
  const scanFeatureMapRef = useRef(new Map<string, any>());
  const scanFlushRafRef = useRef<number | null>(null);
  const publishedLeadIdsByJobRef = useRef(new Map<string, Set<string>>());
  const searchGeoJsonRef = useRef<any>(emptyFeatureCollection());
  const didAutoFitRef = useRef(false); // fit the map to leads once on first load
  // Any user/programmatic camera ownership change invalidates delayed GPS work.
  // The generation is read by the first-fix and iOS fallback callbacks, closing
  // the race where a late location fix could overwrite a search or zoom.
  const cameraGenerationRef = useRef(0);

  const [mapReady, setMapReady] = useState(false);
  const scanStartInFlightRef = useRef(false);
  const [scanSubmitting, setScanSubmitting] = useState(false);
  const terminalJobsHandledRef = useRef(new Set<string>());
  // The operator can minimize the scan sheet while their scan keeps running —
  // it collapses to a small progress pill (tap to re-open). Reset on submit
  // and when a scan reaches its terminal summary.
  const [scanSheetHidden, setScanSheetHidden] = useState(false);

  // ── Scan lifecycle — a completed scan is a first-class RESULT, not just the
  // absence of a spinner. `scanOutcome` drives the control's success / empty /
  // error / cancelled / stale states and the same-scope rescan guard.
  const [scanOutcome, setScanOutcome] = useState<{
    kind: "success" | "complete";
    found: number;
    at: number; // epoch ms when the scan ended
    boxKey: string | null; // scope identity for dedupe/stale
    checked?: number;
  } | null>(null);
  const boxKeyOf = (b: BBox | null) =>
    b
      ? [b.minLat, b.maxLat, b.minLng, b.maxLng]
          .map((v) => v.toFixed(5))
          .join(",")
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
  useEffect(() => {
    leadsOpenRef.current = leadsOpen;
  }, [leadsOpen]);
  const bboxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const layersBtnRef = useRef<HTMLButtonElement | null>(null); // focus returns here on layers close

  // Map style toggle
  const [mapStyleMode, setMapStyleMode] = useState<
    "dark" | "satellite" | "streets"
  >("satellite");
  const [showLeads, setShowLeads] = useState(true); // control-rail layer toggle
  // The style the map was actually created with. Prevents a redundant setStyle()
  // on first load (which would reload the whole style and blank the map).
  const appliedStyleRef = useRef<"dark" | "satellite" | "streets">("satellite");
  // Bumped after each style swap so lead pins + territories re-render onto the
  // fresh style (setStyle wipes all sources/layers).
  const [styleEpoch, setStyleEpoch] = useState(0);

  // Scan Map — tap the floating button to ARM a box selection, then drag a
  // rectangle over the houses to scan EXACTLY inside it. This is a simple two-
  // corner box, wholly separate from Assign Area's freehand lasso (untouched).
  // scanSubmissionRef pins a single in-flight submission (double-tap safe).
  const [scanDrawMode, setScanDrawMode] = useState(false);
  const scanBoxDrawingRef = useRef(false);
  const scanBoxStartRef = useRef<{ lng: number; lat: number } | null>(null);
  const scanSubmissionRef = useRef<{ boxKey: string; nonce: string } | null>(
    null,
  );

  // ── Live Test — trace ONE address through the full field-scanner pipeline
  // (fresh mint, no cache), right here on the map. Sanitized: never shows the
  // bearer token or proxy password. ──
  const [liveTestOpen, setLiveTestOpen] = useState(false);
  const [ltAddr, setLtAddr] = useState({ address: "", city: "", state: "NC", zip: "" });
  const [ltResult, setLtResult] = useState<any>(null);
  const [ltRunning, setLtRunning] = useState(false);
  const runLiveTest = useCallback(async () => {
    if (ltRunning || ltAddr.address.trim().length < 3) return;
    setLtRunning(true);
    setLtResult(null);
    try {
      const res = await apiRequest("POST", "/api/scan/live-test", {
        address: ltAddr.address.trim(), city: ltAddr.city.trim(),
        state: ltAddr.state.trim().toUpperCase() || "NC", zip: ltAddr.zip.trim(),
      });
      setLtResult(await res.json());
    } catch (e: any) {
      setLtResult({ error: String(e?.message ?? e) });
    } finally {
      setLtRunning(false);
    }
  }, [ltRunning, ltAddr]);

  // Filter
  const [filterStatus, setFilterStatus] = useState<string>("all");
  // Last non-"all" status the user filtered by — a LONG-PRESS on the legend
  // pill re-applies it in one tap ("show unworked again" mid-walk).
  const lastFilterStatusRef = useRef<string | null>(null);
  useEffect(() => {
    if (filterStatus !== "all") lastFilterStatusRef.current = filterStatus;
  }, [filterStatus]);
  const legendLongPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const legendLongPressFired = useRef(false);

  // Selected lead (highlighted after a search fly-to)
  const [selectedLeadId, setSelectedLeadId] = useState<number | null>(null);
  // Live peek height the open lead card measures + publishes — re-pads the map
  // camera when the sheet's real content height lands (varies per lead).
  const [sheetPeekPx, setSheetPeekPx] = useState<number | null>(null);
  const [legendOpen, setLegendOpen] = useState(false); // manager legend: collapsed dot-strip by default
  const [geocoding, setGeocoding] = useState(false); // street "go to" lookup in flight
  const [sidebarSearch, setSidebarSearch] = useState("");

  // Colored territory regions visibility toggle (rendered from saved territories)
  const [showTerritories, setShowTerritories] = useState(true);

  // Assign-Area (freehand draw) mode
  const [lassoMode, setLassoMode] = useState(false);
  // ── Add-lead / tap-a-house ──────────────────────────────────────────────────
  // addMode: a single map tap reverse-geocodes a rooftop into an address.
  // cardProperty: the property card sheet (from a tapped house or a scanned dot).
  // addLeadInitial: opens the manual add-lead form, prefilled from card/tap/blank.
  const [addMode, setAddMode] = useState(false);
  const [cardProperty, setCardProperty] = useState<CardProperty | null>(null);
  const [addLeadInitial, setAddLeadInitial] =
    useState<Partial<CardProperty> | null>(null);
  const [tapResolving, setTapResolving] = useState(false);
  const [lassoPoints, setLassoPoints] = useState<[number, number][]>([]);
  const [lassoSelected, setLassoSelected] = useState<MapPin[]>([]);
  const [lassoRepId, setLassoRepId] = useState("");
  const [lassoName, setLassoName] = useState(""); // optional custom area name; blank → "<Rep>'s area"
  // Sales Rabbit-style refine + action state. `lassoDisabled` = display states the
  // user toggled OUT of the action set (default empty = everything selected).
  // `lassoAction` = which bulk action the panel is showing.
  const [lassoDisabled, setLassoDisabled] = useState<Set<PinDisplayState>>(
    new Set(),
  );
  const [lassoAction, setLassoAction] = useState<"assign" | "status" | "area">(
    "assign",
  );
  const [lassoStatusOutcome, setLassoStatusOutcome] = useState<KnockOutcome>(
    BULK_STATUS_OUTCOMES[0],
  );
  const lassoLayerRef = useRef<boolean>(false);

  // Sidebar filters
  const [filterRep, setFilterRep] = useState<string>("all"); // "all" | "unassigned" | repId
  const territoryLayersRef = useRef<string[]>([]);

  const { toast } = useToast();
  const qc = useQueryClient();
  const { user } = useAuth();
  const canSubmitScan = useCan("scan.submit");
  // Owned-job isolation: background/nightly discovery jobs must not re-render
  // this 6k-line tree on every count tick — only the scan THIS operator owns
  // may. The ref mirrors scanState.jobId (assigned right after the reducer
  // below); the hook reads it per-event.
  const ownedJobIdRef = useRef<string | null>(null);
  const discovery = useDiscoveryJobs(!!user && canSubmitScan, ownedJobIdRef);
  // ── AREA SCAN STATE MACHINE — the field map OWNS exactly one scan (the box
  // the operator elected), identified by its jobId. "Scanning fiber" is driven
  // SOLELY by this machine, NEVER inferred from the tenant-wide discovery-job
  // feed. That feed also carries the server's around-the-clock hot-market /
  // frontier harvests and any crash-orphaned job the boot reconciler resumes;
  // inferring `scanning` from it lit the indicator on every launch and let Stop
  // cancel a background job. The machine cannot be turned on by any job but the
  // one this operator started this session (START → ATTACH its jobId).
  const [scanState, dispatchScan] = useReducer(areaScanReducer, AREA_SCAN_IDLE);
  ownedJobIdRef.current = scanState.jobId ?? null;
  const scanning = scanState.status === "running";
  // Mount reconcile — cold launch / navigation / remount / refresh / foreground
  // all replay HYDRATE. With no fresh persisted running scan this resolves to
  // idle, so the map never auto-starts or auto-resumes "Scanning fiber". A
  // recent persisted running scan resumes DISPLAY only — and is then VERIFIED
  // against the backend: persisted local state is never the sole source of
  // truth for "running". If the backend says the job finished/was cancelled
  // while the page was closed, the machine goes terminal/idle instead of
  // sitting on a phantom "Scanning fiber" panel; if the job no longer exists,
  // it resolves to idle. A stale persisted running scan is a zombie (its
  // process died) → idle, and we cancel its server job so the boot reconciler
  // stops resuming it and it can never light up again. Reconnecting NEVER
  // creates or starts a job — the only submit lives in startBoxScan.
  const scanHydratedRef = useRef(false);
  useEffect(() => {
    if (scanHydratedRef.current) return;
    scanHydratedRef.current = true;
    let persisted: PersistedScan | null = null;
    try {
      const raw = localStorage.getItem(AREA_SCAN_LS_KEY);
      if (raw) persisted = JSON.parse(raw) as PersistedScan;
    } catch {
      persisted = null;
    }
    const now = Date.now();
    dispatchScan({ type: "HYDRATE", persisted, now });
    if (persistedRunningIsStale(persisted, now) && persisted.jobId) {
      // eslint-disable-next-line no-console
      console.info("[areaScan] cancelling stale persisted scan", persisted.jobId);
      void discovery.cancel(persisted.jobId).catch(() => {});
      return;
    }
    // Reconnect verification for the fresh-resume path (read-only GET).
    const resumedJobId =
      persisted && persisted.status === "running" && persisted.jobId ? persisted.jobId : null;
    if (!resumedJobId) return;
    let disposed = false;
    void discoveryApi
      .get(resumedJobId)
      .then((job) => {
        if (disposed) return;
        const terminal = isTerminalDiscoveryJob(job)
          ? job.status === "failed"
            ? ("failed" as const)
            : job.status === "cancelled"
              ? ("cancelled" as const)
              : ("completed" as const)
          : undefined;
        // eslint-disable-next-line no-console
        console.info("[areaScan] reconnect verified", resumedJobId, job.status);
        dispatchScan({
          type: "JOB_UPDATE",
          jobId: resumedJobId,
          active: isActiveDiscoveryJob(job),
          terminal,
          found: job.newLeadsCount,
          checked: job.checkedCount,
        });
      })
      .catch(() => {
        if (disposed) return;
        // 404/error — the backend does not know this job. Phantom → idle.
        // eslint-disable-next-line no-console
        console.info("[areaScan] reconnect: job gone, resolving to idle", resumedJobId);
        dispatchScan({ type: "JOB_GONE", jobId: resumedJobId });
      });
    return () => {
      disposed = true;
    };
  }, [discovery.cancel]);
  // Persist identity/lifecycle only (never counts) so a refresh mid-scan can
  // resume the DISPLAY, and a terminal/idle state clears the record.
  useEffect(() => {
    try {
      const p = toPersistedAreaScan(scanState);
      if (p) localStorage.setItem(AREA_SCAN_LS_KEY, JSON.stringify(p));
      else localStorage.removeItem(AREA_SCAN_LS_KEY);
    } catch {
      /* private-mode / quota — the machine still works in-memory */
    }
  }, [scanState]);
  // The ONLY job that drives the machine: the one we own by jobId. A background
  // or unrelated job is structurally incapable of turning the indicator on
  // (the reducer ignores any JOB_UPDATE whose jobId ≠ the owned one).
  const ownedScanJob = useMemo(
    () => (scanState.jobId ? discovery.jobs.find((j) => j.id === scanState.jobId) ?? null : null),
    [scanState.jobId, discovery.jobs],
  );
  useEffect(() => {
    if (!ownedScanJob) return;
    const terminal = isTerminalDiscoveryJob(ownedScanJob)
      ? ownedScanJob.status === "failed"
        ? ("failed" as const)
        : ownedScanJob.status === "cancelled"
          ? ("cancelled" as const)
          : ("completed" as const)
      : undefined;
    dispatchScan({
      type: "JOB_UPDATE",
      jobId: ownedScanJob.id,
      active: isActiveDiscoveryJob(ownedScanJob),
      terminal,
      found: ownedScanJob.newLeadsCount,
      checked: ownedScanJob.checkedCount,
    });
  }, [ownedScanJob]);
  // The scan whose summary the compact sheet shows: ONLY the owned job — its
  // live counts while running, its terminal counts until the sheet dismisses.
  const scanSummaryJob = ownedScanJob;
  // Six-number field summary. discovered/checked/fresh/failed come straight off
  // the durable job; serviceActive/comingSoon are optional server-provided counts
  // (present once the job payload carries them) and default to 0 meanwhile.
  const scanSummary = useMemo(() => {
    const j = scanSummaryJob;
    if (!j) return null;
    return {
      // "OSM addresses" — every mapped address discovered inside the box.
      discovered: j.discoveredCount || j.uniqueCandidateCount || 0,
      checked: j.checkedCount || 0,
      // fresh = all confirmed fresh leads; split into brand-new vs re-confirmed.
      fresh: j.qualifiedCount || 0,
      newLeads: j.newLeadsCount || 0,
      stillFresh: j.stillFreshCount || 0,
      serviceActive: j.serviceActiveCount || 0, // former fresh lead that bought service
      comingSoon: j.comingSoonCount || 0,
      // Unresolved = failed attempts at addresses with NO confirmed lead. A
      // failed re-check of a known lead stays in the fresh buckets above.
      unresolved: j.unresolvedCount || 0,
      // Pending = discovered but not yet conclusively processed (queued or
      // retrying). NEVER shown as unresolved; the job cannot complete while
      // any remain (server terminal gate enforces discovered = checked + 0).
      pending: Math.max(0, (j.discoveredCount || j.uniqueCandidateCount || 0) - (j.checkedCount || 0) - (j.unresolvedCount || 0)),
      failed: j.failedCount || 0,
      coverage: j.coverageStatus || null,
    };
  }, [scanSummaryJob]);
  const isAdmin = user?.role === "admin";
  const isRep = user?.role === "rep";
  const canManage = user?.role === "admin" || user?.role === "manager";
  // Admin, manager, and team lead can carve out areas and assign them to reps.
  const canAssign =
    user?.role === "admin" ||
    user?.role === "manager" ||
    user?.role === "team_lead";

  // Tap-a-house wiring: the shared map click handler (set up once at init) reads
  // these window globals — the same pattern lasso/draw use — so toggling the mode
  // never re-registers the map listener.
  useEffect(() => {
    (window as any).__tapAddressMode = addMode;
    (window as any).__onTapAddress = async (lat: number, lng: number) => {
      setTapResolving(true);
      // In-flight feedback AT the tapped rooftop (not just the FAB spinner):
      // light the search-result halo on the exact point while we resolve.
      const map = mapRef.current;
      try {
        (map?.getSource(SEARCH_RESULT_SOURCE) as any)?.setData({
          type: "FeatureCollection",
          features: [{ type: "Feature", geometry: { type: "Point", coordinates: [lng, lat] }, properties: {} }],
        });
      } catch { /* transient layer state */ }
      let resolved: { address: string; city: string; state: string; zip: string; lat: number; lng: number } | null = null;
      try {
        const a = await reverseGeocode(lat, lng);
        resolved = { address: a.address, city: a.city, state: a.state, zip: a.zip, lat: a.lat, lng: a.lng };
      } catch {
        // Failure keeps the mode armed — the rep just aims again.
        toast({
          title: "No address there",
          description: "Tap directly on a rooftop and try again.",
          variant: "destructive",
        });
        setTapResolving(false);
        try { (map?.getSource(SEARCH_RESULT_SOURCE) as any)?.setData(emptyFeatureCollection()); } catch { /* noop */ }
        return;
      }

      // THE CORE ASK: tapping a house SCANS it for fiber (Kinetic via Decodo) and
      // drops a GREEN pin the instant it's a NEW FIBER + billing N lead — the rep
      // never leaves the map. Reps hold scan.submit; the server routes this at
      // IMMEDIATE priority so it never queues behind the statewide sweep.
      try {
        const scanRes = await apiRequest("POST", "/api/leads/scan-house", resolved);
        const verdict = await scanRes.json();
        if (verdict.isFreshLead && verdict.leadId != null) {
          // Optimistic green pin: insert the confirmed-fresh lead so it paints
          // immediately (fresh halo keyed on the fresh_fiber_confirmed tag),
          // then reconcile against the server. Select it + flash + haptic.
          qc.setQueryData(["/api/leads/map"], (old: any) => {
            if (!old?.pins || old.pins.some((pin: any) => pin.id === verdict.leadId)) return old;
            return {
              ...old,
              total: (old.total ?? old.pins.length) + 1,
              pins: [...old.pins, {
                id: verdict.leadId, address: resolved!.address, city: resolved!.city,
                state: resolved!.state, zip: resolved!.zip,
                lat: verdict.lat ?? resolved!.lat, lng: verdict.lng ?? resolved!.lng,
                leadStatus: "prospect", visited: false, assignedRepId: null,
                leadTag: "fresh_fiber_confirmed", fiberStatus: "new_fiber",
              }],
            };
          });
          qc.invalidateQueries({ queryKey: ["/api/leads/map"] });
          try { navigator.vibrate?.([12, 40, 12]); } catch { /* no haptics */ }
          setSelectedLeadId(verdict.leadId);
          try {
            ringFlashRef.current = { at: performance.now(), color: STATE_COLORS.sold };
          } catch { /* flash best-effort */ }
          toast({ title: "🟢 New fiber lead!", description: `${resolved.address} — added to the map` });
        } else if (verdict.unresolved) {
          // NEVER a false "no fiber": a throttle/timeout is unresolved — retry.
          toast({
            title: "Couldn't verify",
            description: "The check didn't complete. Tap the house again to retry.",
            variant: "destructive",
          });
        } else {
          // Conclusive, but not a fresh lead. If the rep can add leads, offer to
          // log it as an ordinary prospect (prefilled) so the tap is never a
          // dead end; a plain rep just sees the verdict.
          toast({
            title: verdict.label ?? "No fiber lead here",
            description: canAssign
              ? "Not a fresh-fiber lead. Opening add-lead so you can still log it."
              : "Not a fresh-fiber lead.",
          });
          if (canAssign) setAddLeadInitial({ ...resolved, source: "tap" });
        }
      } catch {
        // The scan call itself failed (network/gate) — keep the address; if the
        // rep can add leads, let them do it manually. Mode stays armed.
        toast({
          title: "Scan unavailable",
          description: canAssign
            ? "Couldn't reach the fiber check. Opening add-lead instead."
            : "Couldn't reach the fiber check. Try again.",
          variant: "destructive",
        });
        if (canAssign) setAddLeadInitial({ ...resolved, source: "tap" });
      } finally {
        setTapResolving(false);
        try {
          (map?.getSource(SEARCH_RESULT_SOURCE) as any)?.setData(emptyFeatureCollection());
        } catch { /* transient layer state */ }
      }
    };
    const map = mapRef.current;
    if (map) {
      try {
        map.getCanvas().style.cursor = addMode ? "crosshair" : "";
      } catch {}
    }
    return () => {
      (window as any).__tapAddressMode = false;
    };
  }, [addMode, toast, canAssign, qc]);

  // ── Rep knocking workflow (bottom sheet + offline queue + next door) ────────
  // Reps always get the sheet; admins/managers get it on mobile (desktop keeps
  // the pin popup with its assign-rep dropdown).
  const isMobile = useIsMobile();
  // ONE lead card for every role — reps, team leads, managers, admins all get
  // the same clean sheet (bottom on mobile, docked panel on desktop). The old
  // manager HTML popup is gone; assignment lives as a capability-gated row
  // inside the card itself.
  const useSheet = true;
  const gpsCenteredRef = useRef(false); // a live fix has positioned the camera — startup fallbacks stand down
  const firstFixSeenRef = useRef(false); // a real GPS fix has arrived (the follow control engaged) — gates the FAB fallback
  const didInitZoomRef = useRef(false); // the one-time zoom-to-street on the first fix has happened
  const recentIdsRef = useRef<number[]>([]); // ring buffer (10) — just-knocked doors exempt from the "unvisited" lens
  // One-shot "confirm pop" for the selected pin's ring, set on knock and consumed
  // by the selected-ring rAF below — the map twin of the card pill's tap-flash so
  // both surfaces confirm a disposition the same way. { at, color } or null.
  const ringFlashRef = useRef<{ at: number; color: string } | null>(null);

  // Territory requests (admin/manager)
  const { data: territoryRequests = [] } = useQuery<
    {
      id: number;
      repId: number;
      repName: string;
      currentTerritoryName: string | null;
      notes: string | null;
      status: string;
      createdAt: string;
    }[]
  >({
    queryKey: ["/api/territory-requests"],
    refetchInterval: 30000,
    enabled: canManage,
  });
  const pendingRequests = territoryRequests.filter(
    (r) => r.status === "pending",
  );
  const [showTerritoryRequests, setShowTerritoryRequests] = useState(false);

  const fulfillRequestMutation = useMutation({
    mutationFn: async ({
      id,
      action,
    }: {
      id: number;
      action: "fulfilled" | "dismissed";
    }) => {
      const res = await apiRequest("PATCH", `/api/territory-requests/${id}`, {
        status: action,
      });
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
    mutationFn: async ({
      polygon,
      repId,
      name,
    }: {
      polygon: [number, number][];
      repId: number;
      name?: string;
    }) => {
      const res = await apiRequest("POST", "/api/territories/assign-area", {
        polygon,
        repId,
        ...(name?.trim() ? { name: name.trim() } : {}),
      });
      return res.json();
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["/api/territories"] });
      qc.invalidateQueries({ queryKey: ["/api/territories/progress"] });
      qc.invalidateQueries({ queryKey: ["/api/leads/map"] });
      qc.invalidateQueries({ queryKey: ["/api/leads"] });
      const repName =
        team.find((m: TeamMember) => m.id === data.territory?.repId)?.name ??
        "rep";
      toast({
        title: `✓ ${data.assigned} leads assigned to ${repName} · territory saved`,
      });
      exitLasso();
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  // Lasso "Change Ownership" — reassign the REFINED selection (exact lead ids, so
  // status-refinement is honored) to a rep, without creating a saved territory.
  const bulkAssignMutation = useMutation({
    mutationFn: async ({
      leadIds,
      repId,
    }: {
      leadIds: number[];
      repId: number;
    }) => {
      const res = await apiRequest("POST", "/api/leads/bulk-assign", {
        leadIds,
        repId,
      });
      return res.json();
    },
    onSuccess: (data: { updated: number; skipped: number }) => {
      qc.invalidateQueries({ queryKey: ["/api/leads/map"] });
      qc.invalidateQueries({ queryKey: ["/api/leads"] });
      const repName =
        team.find((m: TeamMember) => m.id === Number(lassoRepId))?.name ??
        "rep";
      toast({
        title: `✓ ${data.updated} reassigned to ${repName}${data.skipped ? ` · ${data.skipped} skipped (out of scope)` : ""}`,
      });
      exitLasso();
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  // Lasso "Modify Status" — set the refined selection to one disposition at once
  // (a manager pipeline edit; no knock, no commission — see /api/leads/bulk-status).
  const bulkStatusMutation = useMutation({
    mutationFn: async ({
      leadIds,
      outcome,
    }: {
      leadIds: number[];
      outcome: KnockOutcome;
    }) => {
      const res = await apiRequest("POST", "/api/leads/bulk-status", {
        leadIds,
        outcome,
      });
      return res.json();
    },
    onSuccess: (data: {
      updated: number;
      skipped: number;
      outcome: KnockOutcome;
    }) => {
      qc.invalidateQueries({ queryKey: ["/api/leads/map"] });
      qc.invalidateQueries({ queryKey: ["/api/leads"] });
      const label = OUTCOME_META[data.outcome]?.label ?? "status";
      toast({
        title: `✓ ${data.updated} set to ${label}${data.skipped ? ` · ${data.skipped} skipped (out of scope)` : ""}`,
      });
      exitLasso();
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  // Lasso derived: the per-status breakdown (chips) and the REFINED active set
  // (what every bulk action operates on once statuses are toggled off).
  const lassoSummary = useMemo(
    () => summarizeByDisplayState(lassoSelected),
    [lassoSelected],
  );
  const lassoActive = useMemo(
    () => lassoSelected.filter((l) => !lassoDisabled.has(pinDisplayState(l))),
    [lassoSelected, lassoDisabled],
  );
  const lassoActiveIds = useMemo(
    () => lassoActive.map((l) => l.id),
    [lassoActive],
  );

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
  const [selectedTerritoryId, setSelectedTerritoryId] = useState<number | null>(
    null,
  );
  const [activityTerritoryId, setActivityTerritoryId] = useState<number | null>(
    null,
  ); // "View Activity" drawer

  // Hand an unassigned/reclaimed area to the next rep (recolors + re-links leads)
  const assignTerritoryMutation = useMutation({
    mutationFn: async ({ id, repId }: { id: number; repId: number }) => {
      const res = await apiRequest("POST", `/api/territories/${id}/assign`, {
        repId,
      });
      if (!res.ok) throw new Error((await res.json()).error || "Assign failed");
      return res.json();
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["/api/territories"] });
      qc.invalidateQueries({ queryKey: ["/api/territories/progress"] });
      qc.invalidateQueries({ queryKey: ["/api/leads/map"] });
      qc.invalidateQueries({ queryKey: ["/api/leads"] });
      const repName =
        team.find((m: TeamMember) => m.id === data.repId)?.name ?? "rep";
      toast({
        title: `✓ Area assigned to ${repName} · ${data.assigned} leads linked`,
      });
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  // Reclaim / pull-back an area with one of the 3 modes.
  const [reclaimMenuId, setReclaimMenuId] = useState<number | null>(null);
  // Two-tap territory delete: first × arms "Sure?" for 3s, second tap deletes.
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const confirmDeleteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const armDeleteConfirm = (id: number) => {
    if (confirmDeleteTimer.current) clearTimeout(confirmDeleteTimer.current);
    setConfirmDeleteId(id);
    confirmDeleteTimer.current = setTimeout(() => setConfirmDeleteId(null), 3000);
  };
  useEffect(() => () => {
    if (confirmDeleteTimer.current) clearTimeout(confirmDeleteTimer.current);
  }, []);
  const reclaimMutation = useMutation({
    mutationFn: async ({
      id,
      mode,
      newRepId,
    }: {
      id: number;
      mode: string;
      newRepId?: number;
    }) => {
      const res = await apiRequest("POST", `/api/territories/${id}/reclaim`, {
        mode,
        newRepId,
      });
      return res.json();
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["/api/territories"] });
      qc.invalidateQueries({ queryKey: ["/api/territories/progress"] });
      qc.invalidateQueries({ queryKey: ["/api/leads/map"] });
      qc.invalidateQueries({ queryKey: ["/api/leads"] });
      setReclaimMenuId(null);
      const label =
        data.mode === "return_to_pool"
          ? `${data.leadsAffected} leads returned to pool`
          : data.mode === "reassign"
            ? `reassigned (${data.leadsAffected} leads)`
            : "area reclaimed";
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
    setLassoDisabled(new Set());
    setLassoAction("assign");
    setLassoStatusOutcome(BULK_STATUS_OUTCOMES[0]);
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
  const { data: mapPinData } = useQuery<{ pins: MapPin[]; total: number }>({
    queryKey: ["/api/leads/map"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/leads/map?format=packed");
      return unpackMapPins<MapPin>(await res.json());
    },
    enabled: !!user,
    staleTime: 45_000, // toward the 60s poll — fewer redundant revalidations
    retry: 2,
    // Auto-refresh so leads added out-of-band (a scan, the nightly cron,
    // another rep) appear on the map without a manual reload. The server's
    // DB-derived ETag makes an unchanged poll a cheap 304, so this is nearly
    // free when nothing changed. Paused while the tab is hidden (battery/data),
    // and a return to the tab pulls fresh immediately.
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    // Reps flip between the app and the dialer/camera constantly while knocking —
    // a refetch on every return is wasteful; the 60s poll keeps them fresh enough.
    // Managers keep focus-refetch for near-real-time monitoring.
    refetchOnWindowFocus: !isRep,
  });

  // Reps have refetchOnWindowFocus OFF (they flip to the dialer/camera
  // constantly — a full refetch on every focus is wasteful). But if the
  // map-changed SSE dropped while backgrounded, a fresh lead could sit invisible
  // for up to 60s. A visibilitychange→visible invalidation closes that gap: the
  // /api/leads/map GET is ETag-backed (304 zero-body when unchanged), so a
  // foreground that changed nothing costs almost nothing. Managers already get
  // focus-refetch, so this is rep-only.
  useEffect(() => {
    if (!isRep) return;
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        void qc.invalidateQueries({ queryKey: ["/api/leads/map"] });
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [isRep, qc]);

  // Server-pushed invalidation keeps confirmed fresh-fiber territory leads from
  // waiting for the 60s safety poll. The stream contains no lead data; the
  // subsequent role-scoped GET remains the only source of map rows.
  useEffect(() => {
    if (!user) return;
    let stopped = false;
    let controller: AbortController | null = null;
    let reconnect: ReturnType<typeof setTimeout> | null = null;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    const connect = async () => {
      const sessionId = getStoredSessionId();
      if (stopped || !sessionId) return;
      controller = new AbortController();
      try {
        const response = await fetch("/api/leads/events", {
          headers: { "x-session-id": sessionId },
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok || !response.body)
          throw new Error(`lead event stream ${response.status}`);
        attempts = 0;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!stopped) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder
            .decode(value, { stream: true })
            .replace(/\r\n/g, "\n");
          for (;;) {
            const boundary = buffer.indexOf("\n\n");
            if (boundary < 0) break;
            const event = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            if (event.includes("event: map-changed")) {
              // Coalesce a burst of lead-created events into one durable-source
              // reconciliation. Discovery SSE already paints each new qualified
              // lead immediately, so a town scan never downloads the full map
              // once per address. While the operator's OWN area scan is live the
              // window widens 1s → 5s: the SSE dot bridge keeps painting every
              // hit incrementally, so the full refetch + re-cluster only needs
              // to reconcile occasionally instead of hitching the map every
              // second of a hot scan.
              if (refreshTimer) clearTimeout(refreshTimer);
              refreshTimer = setTimeout(() => {
                refreshTimer = null;
                void qc.invalidateQueries({ queryKey: ["/api/leads/map"] });
              }, ownedJobIdRef.current != null ? 5_000 : 1_000);
            }
          }
        }
      } catch (error: any) {
        if (stopped || error?.name === "AbortError") return;
      }
      if (!stopped) {
        const delay = Math.min(30_000, 1_000 * 2 ** Math.min(5, attempts++));
        reconnect = setTimeout(() => void connect(), delay);
      }
    };
    void connect();
    return () => {
      stopped = true;
      controller?.abort();
      if (reconnect) clearTimeout(reconnect);
      if (refreshTimer) clearTimeout(refreshTimer);
    };
  }, [user?.id, qc]);
  // Dedupe to ONE pin per physical house before anything renders (pins, the
  // in-view panel, and search all derive from this). Memoized so it only re-runs
  // when the fetched pin set actually changes, not every render.
  const rawLeads: MapPin[] = mapPinData?.pins ?? EMPTY_PINS;
  const leads: MapPin[] = useMemo(() => dedupeLeads(rawLeads), [rawLeads]);
  // O(1) id→lead map — the hot paths (pin tap, knock, card swap) never scan the
  // array. Declared HERE, above the effects that reference it (dep arrays are
  // read during render — a later declaration is a TDZ crash under native ESM).
  const leadById = useMemo(() => new Map(leads.map((l) => [l.id, l])), [leads]);
  // Manager-plane data stays OFF rep phones: team (popup/lasso/reassign) and
  // the 30s progress poll are never fetched in rep mode. Territories DO load
  // for reps — a one-shot, tiny payload — so their own area names render on
  // the map (managers name areas; reps navigate by them).
  const { data: team = [] } = useQuery<TeamMember[]>({
    queryKey: ["/api/team"],
    enabled: !!user && !isRep,
  });
  // O(1) rep-name lookup for search rows + the leads panel (team.find per row
  // is O(team) — the wrong pattern to copy anywhere a full list might render).
  // Declared AFTER `team` — dep arrays are read during render (TDZ under ESM).
  const repNameById = useMemo(
    () => new Map(team.map((m: TeamMember) => [m.id, m.name] as const)),
    [team],
  );
  const { data: territories = [] } = useQuery<Territory[]>({
    queryKey: ["/api/territories"],
    enabled: !!user,
    staleTime: 60_000,
  });
  const { data: territoryProgress = [] } = useQuery<
    Array<{
      id: number;
      knocked: number;
      total: number;
      pct: number;
      sold: number;
      // Location-verified fields (see /api/territories/progress).
      verifiedWorkedLeads: number;
      areaWorkedPct: number;
      verified: number;
      needsReview: number;
      invalid: number;
      avgDistanceM: number | null;
      maxObservedDistanceM: number | null;
      maxAllowedDistanceM: number;
      maxAllowedAccuracyM: number;
    }>
  >({
    queryKey: ["/api/territories/progress"],
    queryFn: async () =>
      (await apiRequest("GET", "/api/territories/progress")).json(),
    enabled: !!user && canAssign,
    refetchInterval: 30000,
  });
  // Expose globally so popup onclick handlers can access current data.
  // NOTE: these effects must stay after `team` is declared — their dependency
  // arrays are read during render, so referencing `team` earlier throws a TDZ
  // error under native ESM (dev), even though esbuild masks it in prod builds.
  useEffect(() => {
    (window as any).__allLeads = leads;
    (window as any).__leadById = leadById;
  }, [leads, leadById]);
  useEffect(() => {
    (window as any).__teamMembers = team;
  }, [team]);
  useEffect(() => {
    (window as any).__onTerritoryClick = (tid: number | null) =>
      setSelectedTerritoryId(tid);
    return () => {
      delete (window as any).__onTerritoryClick;
    };
  }, []);
  // Map→React bridge for the knock sheet (same pattern as __onTerritoryClick).
  // The pin click handler is bound once at map init; it checks this global at
  // call time, so sheet-vs-popup routing follows role/viewport without rebinds.
  useEffect(() => {
    if (!useSheet) return;
    (window as any).__openLeadSheet = (id: number) => setSelectedLeadId(id);
    return () => {
      delete (window as any).__openLeadSheet;
    };
  }, [useSheet]);
  useEffect(() => {
    (window as any).__closeLeadSheet = () => setSelectedLeadId(null);
    return () => {
      delete (window as any).__closeLeadSheet;
    };
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
        .then((r) => r.json())
        .then((d: { token: string }) => {
          if (cancelled) return;
          if (d?.token) {
            (window as any).mapboxgl.accessToken = d.token;
            setMapboxToken(d.token);
          } else {
            setMapTokenFailed(true);
          }
        })
        .catch(() => {
          if (!cancelled) setMapTokenFailed(true);
        });
    };
    (window as any).__onMapboxReady(init);
    return () => {
      cancelled = true;
    };
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
    startMapPerf(map); // opt-in FPS/first-paint sampler (?perf=1); no-op otherwise

    // Force resize once container is definitely painted
    setTimeout(() => map.resize(), 100);
    setTimeout(() => map.resize(), 400);

    map.addControl(
      new (window as any).mapboxgl.NavigationControl(),
      "top-right",
    );
    // ── "Locate me" + shake-free follow camera ───────────────────────────────
    // The GeolocateControl keeps its BRAIN (permission, watchPosition, and the
    // ACTIVE_LOCK↔BACKGROUND state machine) but we take over BOTH the camera and the
    // dot, so ONE smoothed point (see client/src/lib/followCamera) drives them
    // together — no raw-fix jitter reaching the map, no per-fix animation restart.
    const geolocate = new (window as any).mapboxgl.GeolocateControl({
      positionOptions: {
        enableHighAccuracy: true,
        maximumAge: 500,
        timeout: 10000,
      }, // freshest fixes for a moving car
      fitBoundsOptions: { maxZoom: STREET_ZOOM }, // used ONLY for the one-time first-fix zoom
      trackUserLocation: true,
      showUserLocation: false, // WE draw the puck → a single position source (no raw-vs-smoothed drift)
      showUserHeading: false, // heading rides on our puck arrow
    });
    map.addControl(geolocate, "top-right");
    geolocateRef.current = geolocate;

    // SINGLE WRITER: neutralise the control's own accuracy-fitBounds recenter. Without
    // this it fights our follow loop AND "breathes" the zoom on every fix. Guarded so a
    // future mapbox rename degrades to a no-op (the dev zoom-variance check catches it).
    if (typeof (geolocate as any)._updateCamera === "function")
      (geolocate as any)._updateCamera = () => {};
    else if (import.meta.env.DEV)
      console.warn(
        "[follow] GeolocateControl._updateCamera missing — single-writer guard inert",
      );

    // Our navigation puck: one GPU-composited Marker (vivid blue core + white ring +
    // glow + heading arrow). NO CSS transition on its transform — the rAF loop is the
    // sole smoother; a transition would rubber-band it behind the camera.
    const puckEl = document.createElement("div");
    puckEl.className = "hf-nav-puck";
    const puckArrow = document.createElement("div");
    puckArrow.className = "hf-nav-puck-arrow";
    puckEl.appendChild(puckArrow);
    const puck = new (window as any).mapboxgl.Marker({ element: puckEl });
    let puckOn = false;
    const placePuck = (ll: [number, number]) => {
      puck.setLngLat(ll);
      if (!puckOn) {
        puck.addTo(map);
        puckOn = true;
      }
    };

    // Follow state + lifecycle (all imperative — zero React renders per frame).
    const M = createFollowState();
    let following = false,
      interacting = false,
      rafId = 0;
    let locateGeneration = -1;
    let reduced = false;
    try {
      reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {}
    if (import.meta.env.DEV) {
      (window as any).__follow = M;
      (window as any).__geo = geolocate; // dev: drive follow via fire('geolocate', …) even where the browser blocks GPS
      (window as any).__followTick = (tms: number) => frame(tms); // dev: pump one frame where headless rAF is throttled
      (window as any).__followFeed = (fix: any) => ingestFix(M, fix); // dev: feed a synthetic fix with explicit tSec (clean-clock verification)
      (window as any).__followDbg = () => ({
        following,
        interacting,
        rafId,
        watch: (geolocate as any)._watchState,
        spd: M.spd,
        moving: M.moving,
      });
    }

    // The ONE render loop — the sole camera writer. jumpTo(center) and the puck get
    // the SAME smoothed point every frame, so the puck stays pinned to screen-centre.
    const frame = (tms: number) => {
      rafId = 0;
      if (!following || reduced) return;
      const out = stepFrame(M, tms / 1000);
      if (!out) return;
      if (!interacting)
        map.jumpTo({ center: out.center }, { geolocateSource: true }); // centre-only, tagged
      placePuck(out.center);
      if (out.headingDeg != null)
        puckArrow.style.transform = `rotate(${out.headingDeg}deg)`;
      if (out.parked) return; // converged → stop the loop (0 CPU); next fix re-wakes it
      rafId = requestAnimationFrame(frame);
    };
    const ensureLoop = () => {
      if (following && !reduced && !rafId) {
        M.lastFrame = 0;
        rafId = requestAnimationFrame(frame);
      }
    };
    const stopLoop = () => {
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
    };
    // Any camera move that is not an explicit Locate action must own the camera.
    // Search, lead selection, pan and zoom call this before moving so a pending
    // GPS frame can never overwrite the viewport on the next animation frame.
    const suspendFollow = () => {
      cameraGenerationRef.current += 1;
      following = false;
      interacting = false;
      stopLoop();
    };
    suspendFollowCameraRef.current = suspendFollow;

    // Each fix mutates the estimator ONLY; the loop integrates. Persist the fix
    // (throttled) so the NEXT launch opens on last-known location instantly.
    geolocate.on("geolocate", (e: any) => {
      try {
        const { firstFix } = ingestFix(M, {
          lat: e.coords.latitude,
          lon: e.coords.longitude,
          speed: typeof e.coords.speed === "number" ? e.coords.speed : null,
          heading:
            typeof e.coords.heading === "number" ? e.coords.heading : null,
          // perf clock, adjusted for GPS latency + maximumAge staleness
          tSec:
            performance.now() / 1000 -
            Math.max(0, (Date.now() - (e.timestamp || Date.now())) / 1000),
        });
        writeCachedFix(e.coords.latitude, e.coords.longitude, Date.now());
        gpsCenteredRef.current = true; // startup fallbacks stand down
        firstFixSeenRef.current = true; // the control engaged → FAB fallback stays off
        puckEl.classList.remove("hf-nav-puck-stale");
        const ll = filteredLngLat(M);
        if (
          firstFix &&
          following &&
          locateGeneration === cameraGenerationRef.current &&
          !didInitZoomRef.current &&
          ll
        ) {
          map.jumpTo(
            { center: ll, zoom: STREET_ZOOM },
            { geolocateSource: true },
          ); // one-time zoom-to-street
          didInitZoomRef.current = true;
        }
        if (reduced) {
          // No rAF under reduced-motion: hop the (filtered) position discretely.
          if (ll) {
            if (following && !interacting)
              map.jumpTo({ center: ll }, { geolocateSource: true });
            placePuck(ll);
          }
        } else if (!following) {
          if (ll) placePuck(ll); // exploring (BACKGROUND) — keep the puck on the rep
        } else {
          ensureLoop(); // re-wake a parked loop
        }
      } catch {}
    });

    // Surface failures instead of dying silently; a frozen puck reads as "searching".
    geolocate.on("error", (err: any) => {
      try {
        puckEl.classList.add("hf-nav-puck-stale");
      } catch {}
      const code = err?.code;
      const description =
        code === 1
          ? "Location is turned off for this app. On iPhone: Settings → Privacy & Security → Location Services → turn on, then find Safari/HomeFront and set “While Using.”"
          : code === 3
            ? "Getting a GPS fix timed out — step outside or try again."
            : "Couldn’t get your location. Make sure Location Services is on.";
      toast({
        title: "Location unavailable",
        description,
        variant: "destructive",
      });
    });

    // ── Interaction: lean on the control's native ACTIVE_LOCK/BACKGROUND machine. ──
    // Every user camera gesture means "I'm exploring". Follow remains off until
    // the user explicitly taps Locate again; zoom/rotate/pitch must never snap the
    // center back to GPS when the gesture ends.
    const onFollowStart = () => {
      locateGeneration = cameraGenerationRef.current + 1;
      cameraGenerationRef.current = locateGeneration;
      following = true;
      ensureLoop();
    };
    const onFollowEnd = () => {
      following = false;
      stopLoop();
    };
    geolocate.on("trackuserlocationstart", onFollowStart);
    geolocate.on("trackuserlocationend", onFollowEnd);
    const onDragStart = (ev: any) => {
      if (ev?.geolocateSource) return;
      didAutoFitRef.current = true;
      suspendFollow();
    };
    const onGestureStart = (ev: any) => {
      if (ev?.geolocateSource) return;
      didAutoFitRef.current = true;
      suspendFollow();
    };
    const onGestureEnd = (ev: any) => {
      if (ev?.geolocateSource) return;
      interacting = false;
    };
    map.on("dragstart", onDragStart);
    const gestureStarts = ["zoomstart", "rotatestart", "pitchstart"];
    const gestureEnds = ["dragend", "zoomend", "rotateend", "pitchend"];
    for (const evn of gestureStarts) map.on(evn, onGestureStart);
    for (const evn of gestureEnds) map.on(evn, onGestureEnd);

    // Honour prefers-reduced-motion live (never run the rAF; discrete filtered hops).
    let mmRM: MediaQueryList | null = null;
    let onRM: ((ev: MediaQueryListEvent) => void) | null = null;
    try {
      mmRM = window.matchMedia("(prefers-reduced-motion: reduce)");
      onRM = (ev: MediaQueryListEvent) => {
        reduced = ev.matches;
        if (reduced) stopLoop();
        else ensureLoop();
      };
      mmRM.addEventListener("change", onRM);
    } catch {}

    const setupMapLayers = async () => {
      // Draw bbox layers
      map.addSource("draw-bbox", {
        type: "geojson",
        data: emptyFeatureCollection(),
      });
      map.addLayer({
        id: "draw-bbox-fill",
        type: "fill",
        source: "draw-bbox",
        paint: { "fill-color": "#f97316", "fill-opacity": 0.1 },
      });
      map.addLayer({
        id: "draw-bbox-outline",
        type: "line",
        source: "draw-bbox",
        paint: {
          "line-color": "#f97316",
          "line-width": 2,
          "line-dasharray": [3, 2],
        },
      });

      // Search highlight + incremental scan hits stay in Mapbox's worker/WebGL
      // pipeline. No per-address DOM markers are created.
      ensureTransientMapLayers(map);

      // ── Lead cluster source (GeoJSON) — shows count bubbles when zoomed out ──
      map.addSource("leads-cluster", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
        cluster: true,
        clusterMaxZoom: 13, // collapse clusters below zoom 13
        clusterRadius: 50, // px radius to cluster within
        clusterProperties: { fresh_count: ["+", ["get", "fresh"]] },
      });

      // Cluster outer glow ring (behind main circle)
      map.addLayer({
        id: "lead-clusters-glow",
        type: "circle",
        source: "leads-cluster",
        filter: ["has", "point_count"],
        maxzoom: 13.5,
        paint: {
          "circle-color": [
            "step",
            ["get", "point_count"],
            "#0d9488",
            10,
            "#0f766e",
            30,
            "#115e59",
          ],
          "circle-radius": ["step", ["get", "point_count"], 26, 10, 33, 30, 42],
          "circle-opacity": 0.25,
          "circle-stroke-width": 0,
        },
      });

      // A confirmed-fresh ring makes the money layer visible without changing
      // the disposition color inside the cluster. The count is aggregated in
      // the Mapbox worker, so this remains one GeoJSON source and zero DOM pins.
      map.addLayer({
        id: "lead-fresh-cluster-ring",
        type: "circle",
        source: "leads-cluster",
        filter: [
          "all",
          ["has", "point_count"],
          [">", ["get", "fresh_count"], 0],
        ],
        maxzoom: 13.5,
        paint: {
          "circle-radius": [
            "+",
            ["step", ["get", "point_count"], 18, 10, 24, 30, 32],
            6,
          ],
          "circle-color": "rgba(0,0,0,0)",
          "circle-stroke-width": 3,
          "circle-stroke-color": "#22c55e",
          "circle-opacity": 0.95,
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
            "step",
            ["get", "point_count"],
            "#0d9488",
            10,
            "#0f766e",
            30,
            "#115e59",
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
          "text-size": ["step", ["get", "point_count"], 13, 10, 14, 30, 16],
          "text-allow-overlap": true,
        },
        paint: {
          "text-color": "#ffffff",
          "text-halo-color": "rgba(0,0,0,0.3)",
          "text-halo-width": 0.5,
        },
      });

      // True while any draw tool is armed — cluster zoom / popups / hover-cursor
      // must all stand down so they can't yank the map or fight the crosshair
      // mid-draw.
      const drawToolActive = () =>
        (window as any).__lassoActive ||
        (window as any).__territoryDrawActive ||
        (window as any).__drawModeActive;

      // Click cluster → zoom in
      map.on("click", "lead-clusters", (e: any) => {
        if (drawToolActive()) return;
        suspendFollow();
        const features = map.queryRenderedFeatures(e.point, {
          layers: ["lead-clusters"],
        });
        const clusterId = features[0]?.properties?.cluster_id;
        if (!clusterId) return;
        (map.getSource("leads-cluster") as any).getClusterExpansionZoom(
          clusterId,
          (err: any, zoom: number) => {
            if (err) return;
            map.easeTo({
              center: features[0].geometry.coordinates,
              zoom: zoom + 1,
            });
          },
        );
      });

      const hoverCursor = (c: string) => {
        if (!drawToolActive()) map.getCanvas().style.cursor = c;
      };
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

      map.addLayer(
        {
          id: "lead-fresh-confirmed-halo",
          type: "circle",
          source: "leads-cluster",
          filter: [
            "all",
            ["!", ["has", "point_count"]],
            ["==", ["get", "fresh"], 1],
          ],
          minzoom: 12,
          paint: {
            "circle-radius": [
              "interpolate",
              ["linear"],
              ["zoom"],
              12,
              10,
              18,
              16,
            ],
            "circle-color": ["case", ["==", ["get", "carrier"], "frontier"], "rgba(239,68,68,0.16)", "rgba(34,197,94,0.16)"],
            "circle-stroke-width": 2.5,
            // Carrier halo: Kinetic fresh = green ring, Frontier fresh = red ring.
            "circle-stroke-color": ["case", ["==", ["get", "carrier"], "frontier"], "#ef4444", "#22c55e"],
          },
        },
        "lead-unclustered",
      );

      // Worked-vs-unworked is color-only: knocked doors render in their status
      // hue (terminal states pre-dimmed) with a thicker white stroke — no glyph
      // badges on pins, per the field design language. (The per-pin glow layer
      // was removed — a 2nd fill draw under every pin; the zoom-scaled radius +
      // white stroke give enough pop at half the unclustered draw cost.)

      // Selected-pin ring — driven by setFilter (style-thread only, no setData).
      // Added last so it can never be occluded by pins/glow.
      map.addLayer(SELECTED_RING_SPEC);

      // Provider-native house numbers — fade in at z≥17.2, below our layers.
      ensureHousenumLayer(map, mapStyleMode);

      // Canonical status-icon layer; NEW_FIELD_MAP=0 is the emergency fallback.
      await addStatusIconLayer(map);

      // Click unclustered pin → show popup. Bound to BOTH the circle layer and
      // the NEW_FIELD_MAP icon layer so a tap opens the same card in either mode
      // (only one of the two is visible at a time). The icon-layer binding is
      // harmless when the layer is absent — it simply never fires.
      const onPinClick = (e: any) => {
        // No popups while a draw tool is active — a lasso stroke over a pin
        // must not open a card mid-draw.
        if (
          (window as any).__lassoActive ||
          (window as any).__territoryDrawActive ||
          (window as any).__drawModeActive
        )
          return;
        const props = e.features?.[0]?.properties;
        const coords = e.features?.[0]?.geometry?.coordinates?.slice() as [
          number,
          number,
        ];
        if (!props || !coords) return;
        const lead = (window as any).__leadById?.get(props.id); // O(1), never an array scan
        if (!lead) return;
        // Every role opens the same card. Checked at call time so role/
        // viewport changes never need a rebind.
        (window as any).__openLeadSheet?.(props.id);
      };
      map.on("click", "lead-unclustered", onPinClick);
      map.on("click", STATUS_ICON_LAYER, onPinClick);
      map.on("mouseenter", "lead-unclustered", () => hoverCursor("pointer"));
      map.on("mouseleave", "lead-unclustered", () => hoverCursor(""));
      map.on("mouseenter", STATUS_ICON_LAYER, () => hoverCursor("pointer"));
      map.on("mouseleave", STATUS_ICON_LAYER, () => hoverCursor(""));
      map.on("click", SCAN_RESULTS_CLUSTER_LAYER, (e: any) => {
        if (drawToolActive()) return;
        suspendFollow();
        const feature = e.features?.[0];
        const clusterId = feature?.properties?.cluster_id;
        if (clusterId == null) return;
        (map.getSource(SCAN_RESULTS_SOURCE) as any).getClusterExpansionZoom(
          clusterId,
          (err: any, zoom: number) => {
            if (!err)
              map.easeTo({ center: feature.geometry.coordinates, zoom });
          },
        );
      });
      map.on("click", SCAN_RESULTS_POINT_LAYER, (e: any) => {
        if (drawToolActive()) return;
        const p = e.features?.[0]?.properties;
        const coordinates = e.features?.[0]?.geometry?.coordinates;
        if (!p || !coordinates) return;
        setCardProperty({
          address: p.address,
          city: p.city,
          state: p.state,
          zip: p.zip,
          lat: coordinates[1],
          lng: coordinates[0],
          fiberStatus: p.fiberStatus,
          isNewFiber: p.isNewFiber === true || p.isNewFiber === "true",
          billingStatus: p.billingStatus || null,
          maxDownloadMbps:
            p.maxDownloadMbps == null ? null : Number(p.maxDownloadMbps),
          competitorName: p.competitorName || null,
          techType: p.techType || null,
          placement: p.placement || null,
          householdSegmentType: p.householdSegmentType || null,
          leadTag: p.leadTag || null,
          freshConfidence: p.freshConfidence || null,
          leadScore: p.leadScore == null ? null : Number(p.leadScore),
          source: "scan",
        });
      });
      map.on("mouseenter", SCAN_RESULTS_CLUSTER_LAYER, () =>
        hoverCursor("pointer"),
      );
      map.on("mouseleave", SCAN_RESULTS_CLUSTER_LAYER, () => hoverCursor(""));
      map.on("mouseenter", SCAN_RESULTS_POINT_LAYER, () =>
        hoverCursor("pointer"),
      );
      map.on("mouseleave", SCAN_RESULTS_POINT_LAYER, () => hoverCursor(""));

      // Tap a territory region → open its detail panel. Lead pins win over the
      // region beneath them; draw tools suppress it entirely.
      map.on("click", (e: any) => {
        // Tap-a-house: in add mode a single tap resolves the rooftop → address.
        if ((window as any).__tapAddressMode) {
          (window as any).__onTapAddress?.(e.lngLat.lat, e.lngLat.lng);
          return;
        }
        if (drawToolActive()) return;
        // Layer-filtered hit test: the old catch-all query walked EVERY style
        // layer (basemap labels/roads included) on each tap; we only ever act
        // on pins, clusters, and territory fills.
        const hitLayers = [
          "lead-unclustered",
          STATUS_ICON_LAYER,
          "lead-clusters",
          ...territoryLayersRef.current,
        ].filter((id) => {
          try {
            return !!map.getLayer(id);
          } catch {
            return false;
          }
        });
        const feats = hitLayers.length
          ? map.queryRenderedFeatures(e.point, { layers: hitLayers })
          : [];
        if (
          feats.some(
            (f: any) =>
              f.layer?.id === "lead-unclustered" ||
              f.layer?.id === STATUS_ICON_LAYER ||
              f.layer?.id === "lead-clusters",
          )
        )
          return;
        // Fat-finger forgiveness: pins are 16px dots — before treating this as an
        // empty-map tap, look for a pin within a ±16px box (a gloved/moving thumb
        // lands wider than a mouse). A near-miss opens the door the rep aimed at
        // instead of dismissing their sheet mid-flow.
        const openSheet = (window as any).__openLeadSheet;
        if (openSheet) {
          try {
            // Query whichever pin layer is live (icon layer only when it exists;
            // a hidden layer returns nothing, a missing one would throw).
            const pinLayers = map.getLayer(STATUS_ICON_LAYER)
              ? ["lead-unclustered", STATUS_ICON_LAYER]
              : ["lead-unclustered"];
            const near = map.queryRenderedFeatures(
              [
                [e.point.x - 16, e.point.y - 16],
                [e.point.x + 16, e.point.y + 16],
              ],
              { layers: pinLayers },
            );
            if (near.length) {
              openSheet(near[0].properties.id);
              return;
            }
          } catch {
            /* layer not ready */
          }
        }
        // Tapping empty map dismisses the knock sheet (its map stays interactive).
        (window as any).__closeLeadSheet?.();
        const terr = feats.find(
          (f: any) =>
            typeof f.layer?.id === "string" &&
            /^territory-\d+$/.test(f.layer.id),
        );
        const cb = (window as any).__onTerritoryClick;
        if (terr && cb) cb(Number(terr.layer.id.replace("territory-", "")));
        else if (cb) cb(null); // click on empty map closes the panel
      });

      mapRef.current = map;
      setMapReady(true);
      // Always re-trigger the lead-pin + territory data effects. setMapReady(true)
      // is a no-op re-render if a previous map instance (HMR / re-init) already
      // set it — the fresh source would then stay empty and no pins would show.
      setStyleEpoch((e) => e + 1);
    };

    // Run layer setup as soon as the STYLE is parsed — not on the full "load"
    // event (which waits for a complete tile render and can stall in some
    // environments, leaving the map stuck on "Loading map…"). Adding sources/
    // layers only requires the style, so this is both correct and more robust.
    if (map.isStyleLoaded()) void setupMapLayers();
    else
      map.once("style.load", () => {
        void setupMapLayers();
      });

    // ResizeObserver — whenever the container changes size, tell Mapbox to redraw
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => {
        map.resize();
      });
      ro.observe(el);
    }

    return () => {
      stopLoop(); // cancel the follow rAF
      suspendFollowCameraRef.current = () => {};
      try {
        if (mmRM && onRM) mmRM.removeEventListener("change", onRM);
      } catch {} // window-level, survives map.remove
      try {
        puck.remove();
      } catch {}
      ro?.disconnect();
      map.remove();
      mapRef.current = null; // map.remove() tears down its own listeners + control
    };
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
        if (Array.isArray(ring) && ring.length >= 3)
          rings.push({ ring, bbox: bboxOfRing(ring) });
      } catch {
        /* malformed polygon — skip, never crash the map */
      }
    }
    return rings.length ? rings : null;
  }, [territories, isAdmin, isRep, user?.teamMemberId]);

  // Territory clip — bbox-reject before the exact shared test (same shape as
  // the lasso path): O(n·t·v) exact-only → O(n·t + k·v).
  const territoryClippedLeads = useMemo(() => {
    if (!myTerritoryRings) return leads;
    return leads.filter((lead) => {
      if (!lead.lat || !lead.lng) return false;
      for (const { ring, bbox } of myTerritoryRings) {
        if (
          lead.lng < bbox.minLng ||
          lead.lng > bbox.maxLng ||
          lead.lat < bbox.minLat ||
          lead.lat > bbox.maxLat
        )
          continue;
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
    return territoryClippedLeads.filter((l) =>
      filterRep === "unassigned"
        ? !l.assignedRepId
        : l.assignedRepId === Number(filterRep),
    );
  }, [territoryClippedLeads, canAssign, filterRep]);

  // The EXACT set of leads currently painted on the map — territory-clip, then
  // rep filter, then status filter. Single source of truth for the pin layer,
  // the lasso AND the leads panel, so no surface can disagree with the pins.
  const visibleLeads = useMemo(() => {
    if (filterStatus === "all") return repFilteredLeads;
    return repFilteredLeads.filter((l) => l.leadStatus === filterStatus);
  }, [repFilteredLeads, filterStatus]);

  // Expose the visible set to the (ref-based) lasso handler.
  useEffect(() => {
    (window as any).__visibleLeads = visibleLeads;
  }, [visibleLeads]);

  // ID + content-signature cache survives API refetches, which necessarily
  // create new pin objects. A steady-state poll reuses all feature allocations.
  const featureCacheRef = useRef<LeadFeatureCache>(new Map());
  const geoJsonDataRef = useRef<any>({
    type: "FeatureCollection",
    features: [],
  });
  const featureByIdRef = useRef(new Map<number, any>());
  // Set by the knock handler after its imperative one-pin paint; consumed once
  // by the cluster reconcile effect to skip the duplicate full setData.
  const pendingKnockPaintRef = useRef<number | null>(null);

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
        setViewBBox({
          minLng: b.getWest(),
          minLat: b.getSouth(),
          maxLng: b.getEast(),
          maxLat: b.getNorth(),
        });
      } catch {
        /* map mid-teardown */
      }
    };
    const onMoveEnd = () => {
      if (!leadsOpenRef.current) return; // panel closed → no work
      if (bboxTimerRef.current) clearTimeout(bboxTimerRef.current);
      bboxTimerRef.current = setTimeout(readBounds, 150);
    };
    map.on("moveend", onMoveEnd);
    return () => {
      if (bboxTimerRef.current) clearTimeout(bboxTimerRef.current);
      try {
        map.off("moveend", onMoveEnd);
      } catch {}
    };
  }, [mapReady, styleEpoch]);

  // Prime bounds the instant the panel opens (no gesture required).
  useEffect(() => {
    if (!leadsOpen) return;
    const map = mapRef.current;
    if (!map) return;
    try {
      const b = map.getBounds();
      setViewBBox({
        minLng: b.getWest(),
        minLat: b.getSouth(),
        maxLng: b.getEast(),
        maxLat: b.getNorth(),
      });
    } catch {}
  }, [leadsOpen]);

  // What the map PAINTS (same truthiness predicate as the setData loop — a
  // 0,0 coord is excluded identically), then the in-viewport subset sorted
  // nearest-to-map-center: matches the operator's gaze, stable under small
  // pans, needs zero sort chrome. Equirectangular d² is exact enough for
  // ranking at county scale. O(n) filter + O(k log k) sort per debounced move.
  const mapTotalLeads = useMemo(
    () => visibleLeads.filter((l) => l.lat && l.lng),
    [visibleLeads],
  );
  const inViewLeads = useMemo(() => {
    if (!viewBBox) return mapTotalLeads;
    const cx = (viewBBox.minLng + viewBBox.maxLng) / 2;
    const cy = (viewBBox.minLat + viewBBox.maxLat) / 2;
    const cos = Math.cos((cy * Math.PI) / 180);
    return mapTotalLeads
      .filter((l) => inBBox(l.lat!, l.lng!, viewBBox))
      .map((l) => {
        const dx = (l.lng! - cx) * cos,
          dy = l.lat! - cy;
        return [dx * dx + dy * dy, l] as const;
      })
      .sort((a, b) => a[0] - b[0] || a[1].id - b[1].id)
      .map(([, l]) => l);
  }, [mapTotalLeads, viewBBox]);

  // ── Update cluster GeoJSON when leads/filter/territory changes ───────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const src = map.getSource("leads-cluster") as any;
    if (!src) return;

    // O(n) reconciliation. Stable rows reuse the same Feature + geometry;
    // changing one disposition allocates one replacement, then setData hands
    // the compact collection to Mapbox's worker for native GPU clustering.
    const reconciled = reconcileLeadFeatures(
      visibleLeads,
      featureCacheRef.current,
    );
    geoJsonDataRef.current = reconciled.data;
    featureByIdRef.current = reconciled.byId;
    // Knock skip-guard: the knock handler already recolored this ONE pin
    // imperatively (mutate + setData). When the optimistic query update rolls
    // back through here and the sole change is that same pin, the second full
    // setData + re-cluster is pure duplicate work — skip the paint, keep refs.
    const skipId = pendingKnockPaintRef.current;
    pendingKnockPaintRef.current = null;
    if (skipId == null || reconciled.soleChangedId !== skipId) {
      src.setData(reconciled.data);
    }
    // NOTE: this dep array must NEVER gain selection/sheet state — a pin tap must
    // rebuild zero GeoJSON. Selection is a setFilter on its own effect below.
    // It must also stay free of poll-churned identities (team, territories, user):
    // the memoized visibleLeads absorbs those upstream.
  }, [visibleLeads, mapReady, styleEpoch]);

  // ── Selected-pin ring — pure style-thread update, no setData, no re-cluster ──
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    try {
      map.setFilter("lead-selected-ring", SELECTED_RING_FILTER(selectedLeadId));
    } catch {}
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
    if (gpsCenteredRef.current) {
      didAutoFitRef.current = true;
      return;
    } // live GPS won the race
    // EVERY role opens where they're standing (Apple/Google-Maps behavior): paint
    // the last-known GPS fix instantly at street zoom while live GPS warms up.
    {
      const start = pickRepStartCamera(readCachedFix(), Date.now());
      if (start) {
        map.jumpTo({ center: start.center, zoom: start.zoom });
        didAutoFitRef.current = true;
        return;
      }
    }
    // No location signal yet (first run / cleared storage): frame the assigned
    // leads so the map is never a blank town center until the live fix lands.
    const pts = leads.filter((l) => l.lat && l.lng);
    if (pts.length === 0) return;
    try {
      const b = new (window as any).mapboxgl.LngLatBounds();
      pts.forEach((l) => b.extend([l.lng!, l.lat!]));
      map.fitBounds(b, {
        padding: 60,
        maxZoom: isRep ? STREET_ZOOM : 15,
        duration: 0,
      });
      didAutoFitRef.current = true;
    } catch {}
  }, [leads, mapReady, isRep, user]);

  // ── Render color-coded territory regions (area name + owner label) ─────────
  // Managers/team leads see EVERY area: rep-colored fill + a two-line centroid
  // label "Area name / Rep knocked/total". Reps see ONLY their own areas as a
  // quiet outline + the area name — enough to know where they're working
  // without cluttering the pins they knock.
  //
  // SPLIT into geometry vs label passes: the 30s progress poll used to key the
  // whole effect, tearing down and re-adding 5 layers/sources per territory on
  // every tick (a visible hitch on manager phones). Now geometry re-runs only
  // when the territory SET changes; progress/team ticks update the label
  // text-field in place — a pure style-thread write, no layer churn.
  const visibleTerritories = useMemo(() => {
    // Rep view: only areas they own (single or shared assignment).
    const myId = user?.teamMemberId ?? null;
    const mine = canAssign
      ? territories
      : territories.filter((t) => {
          if (myId == null) return false;
          if (t.repId === myId) return true;
          try {
            const a = JSON.parse((t as any).assigneeIds || "[]");
            return Array.isArray(a) && a.includes(myId);
          } catch {
            return false;
          }
        });
    return mine.filter((t) => {
      const status = (t as any).status ?? "active";
      if (status === "archived") return false; // archived areas never render
      if (
        !canAssign &&
        (status === "unassigned" ||
          status === "reclaimed" ||
          status === "completed")
      )
        return false;
      return true;
    });
  }, [territories, canAssign, user?.teamMemberId]);

  // Centroid label. Reps: the area NAME only. Managers: name + owner line
  // ("Rep knocked/total"); "Unassigned" once reclaimed (the old rep's name
  // must NOT linger on the area).
  const territoryLabelFor = (t: (typeof territories)[number]): string => {
    const status = (t as any).status ?? "active";
    const isPool = status === "unassigned" || status === "reclaimed";
    const isDone = status === "completed";
    const areaName = (t.name ?? "").trim();
    if (!canAssign) return areaName;
    const prog = territoryProgress.find((p) => p.id === t.id);
    const repName =
      team.find((m) => m.id === t.repId)?.name?.split(" ")[0] ?? "";
    const ownerLine = isPool
      ? "Unassigned"
      : isDone
        ? `Done — ${repName}`
        : prog
          ? `${repName}  ${prog.knocked}/${prog.total}`
          : repName;
    return areaName && ownerLine && areaName !== ownerLine
      ? `${areaName}\n${ownerLine}`
      : areaName || ownerLine;
  };
  const territoryLabelForRef = useRef(territoryLabelFor);
  territoryLabelForRef.current = territoryLabelFor;

  // Pass 1 — GEOMETRY: sources + fill/outline/label layers. Keyed on the
  // territory set only, never on the progress poll.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    // Remove old territory layers/sources (fill, outline, label + its source)
    territoryLayersRef.current.forEach((id) => {
      try {
        if (map.getLayer(id)) map.removeLayer(id);
      } catch {}
      try {
        if (map.getLayer(id + "-outline")) map.removeLayer(id + "-outline");
      } catch {}
      try {
        if (map.getLayer(id + "-label")) map.removeLayer(id + "-label");
      } catch {}
      try {
        if (map.getSource(id)) map.removeSource(id);
      } catch {}
      try {
        if (map.getSource(id + "-label-src"))
          map.removeSource(id + "-label-src");
      } catch {}
    });
    territoryLayersRef.current = [];

    // Managers can hide the layer from the rail; reps' own areas always show.
    if (canAssign && !showTerritories) return;

    visibleTerritories.forEach((t) => {
      try {
        const status = (t as any).status ?? "active";
        const coords = JSON.parse(t.polygon) as [number, number][];
        if (coords.length < 3) return;
        const closed = [...coords, coords[0]];
        // Status-aware styling: reclaimed/unassigned areas go GRAY and lose the
        // rep's name; completed areas keep the rep color but muted.
        const isPool = status === "unassigned" || status === "reclaimed";
        const isDone = status === "completed";
        const color = isPool ? "#94a3b8" : colorForRep(t.repId);
        const fillOpacity = !canAssign
          ? 0.05
          : isPool
            ? 0.1
            : isDone
              ? 0.08
              : 0.14;
        const srcId = `territory-${t.id}`;
        if (!map.getSource(srcId)) {
          map.addSource(srcId, {
            type: "geojson",
            data: {
              type: "Feature",
              geometry: { type: "Polygon", coordinates: [closed] },
              properties: { tid: t.id },
            },
          });
        }
        if (!map.getLayer(srcId)) {
          map.addLayer({
            id: srcId,
            type: "fill",
            source: srcId,
            paint: { "fill-color": color, "fill-opacity": fillOpacity },
          });
        }
        if (!map.getLayer(srcId + "-outline")) {
          map.addLayer({
            id: srcId + "-outline",
            type: "line",
            source: srcId,
            paint: {
              "line-color": color,
              "line-width": !canAssign ? 1.75 : isPool ? 2 : 2.5,
              "line-opacity": !canAssign ? 0.65 : isPool ? 0.7 : 0.9,
              ...(isPool ? { "line-dasharray": [3, 2] } : {}),
            },
          });
        }
        const cx = coords.reduce((s, p) => s + p[0], 0) / coords.length;
        const cy = coords.reduce((s, p) => s + p[1], 0) / coords.length;
        // Label layer is ALWAYS created (empty text renders nothing) so the
        // label pass below can fill it in the moment team/progress data lands
        // without ever re-running this geometry pass.
        if (!map.getSource(srcId + "-label-src")) {
          map.addSource(srcId + "-label-src", {
            type: "geojson",
            data: {
              type: "Feature",
              geometry: { type: "Point", coordinates: [cx, cy] },
              properties: {},
            },
          });
          map.addLayer({
            id: srcId + "-label",
            type: "symbol",
            source: srcId + "-label-src",
            layout: {
              "text-field": territoryLabelForRef.current(t),
              "text-size": 12,
              "text-line-height": 1.3,
              "text-font": ["DIN Offc Pro Medium", "Arial Unicode MS Bold"],
              "text-allow-overlap": false,
            },
            paint: {
              "text-color": "#ffffff",
              "text-halo-color": isPool ? "#475569" : color,
              "text-halo-width": 2,
              ...(canAssign ? {} : { "text-opacity": 0.9 }),
            },
          });
        }
        territoryLayersRef.current.push(srcId);
      } catch {}
    });
  }, [
    visibleTerritories,
    mapReady,
    showTerritories,
    canAssign,
    styleEpoch,
  ]);

  // Pass 2 — LABELS: progress/team ticks rewrite text-field in place.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    visibleTerritories.forEach((t) => {
      const layerId = `territory-${t.id}-label`;
      try {
        if (!map.getLayer(layerId)) return;
        map.setLayoutProperty(layerId, "text-field", territoryLabelForRef.current(t));
      } catch {}
    });
  }, [visibleTerritories, territoryProgress, team, mapReady, canAssign, styleEpoch]);

  // ── Lead-layer visibility (control-rail toggle) ─────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const vis = showLeads ? "visible" : "none";
    const fieldMap = newFieldMap();
    for (const id of [
      "lead-clusters",
      "lead-clusters-glow",
      "lead-fresh-cluster-ring",
      "lead-cluster-count",
      "lead-unclustered",
      "lead-fresh-confirmed-halo",
      "lead-unclustered-glow",
      "lead-visited-check",
      STATUS_ICON_LAYER,
    ]) {
      if (!map.getLayer(id)) continue;
      // NEW_FIELD_MAP swaps circle pins for status icons: the circle layer stays
      // hidden and the icon layer follows the show-leads toggle. Flag off → the
      // icon layer doesn't exist (skipped above) and this behaves exactly as today.
      let v = vis;
      if (fieldMap && id === "lead-unclustered") v = "none";
      else if (!fieldMap && id === STATUS_ICON_LAYER) v = "none";
      try {
        map.setLayoutProperty(id, "visibility", v);
      } catch {}
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
    const STYLE =
      mapStyleMode === "satellite"
        ? "mapbox://styles/mapbox/satellite-streets-v12" // hybrid
        : mapStyleMode === "streets"
          ? "mapbox://styles/mapbox/streets-v12" // street
          : "mapbox://styles/mapbox/dark-v11"; // dark
    // setStyle wipes all layers — re-add cluster source + layers after style loads
    map.once("style.load", async () => {
      // Re-add cluster source + layers after style swap
      if (!map.getSource("leads-cluster")) {
        map.addSource("leads-cluster", {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
          cluster: true,
          clusterMaxZoom: 13,
          clusterRadius: 50,
          clusterProperties: { fresh_count: ["+", ["get", "fresh"]] },
        });
        // Cluster glow
        map.addLayer({
          id: "lead-clusters-glow",
          type: "circle",
          source: "leads-cluster",
          filter: ["has", "point_count"],
          maxzoom: 13.5,
          paint: {
            "circle-color": [
              "step",
              ["get", "point_count"],
              "#0d9488",
              10,
              "#0f766e",
              30,
              "#115e59",
            ],
            "circle-radius": [
              "step",
              ["get", "point_count"],
              26,
              10,
              33,
              30,
              42,
            ],
            "circle-opacity": 0.25,
          },
        });
        map.addLayer({
          id: "lead-fresh-cluster-ring",
          type: "circle",
          source: "leads-cluster",
          filter: [
            "all",
            ["has", "point_count"],
            [">", ["get", "fresh_count"], 0],
          ],
          maxzoom: 13.5,
          paint: {
            "circle-radius": [
              "+",
              ["step", ["get", "point_count"], 18, 10, 24, 30, 32],
              6,
            ],
            "circle-color": "rgba(0,0,0,0)",
            "circle-stroke-width": 3,
            "circle-stroke-color": "#22c55e",
            "circle-opacity": 0.95,
          },
        });
        map.addLayer({
          id: "lead-clusters",
          type: "circle",
          source: "leads-cluster",
          filter: ["has", "point_count"],
          maxzoom: 13.5,
          paint: {
            "circle-color": [
              "step",
              ["get", "point_count"],
              "#0d9488",
              10,
              "#0f766e",
              30,
              "#115e59",
            ],
            "circle-radius": [
              "step",
              ["get", "point_count"],
              18,
              10,
              24,
              30,
              30,
            ],
            "circle-opacity": 0.9,
            "circle-stroke-width": 2.5,
            "circle-stroke-color": "#fff",
          },
        });
        map.addLayer({
          id: "lead-cluster-count",
          type: "symbol",
          source: "leads-cluster",
          filter: ["has", "point_count"],
          maxzoom: 13.5,
          layout: {
            "text-field": "{point_count_abbreviated}",
            "text-font": ["DIN Offc Pro Medium", "Arial Unicode MS Bold"],
            "text-size": 13,
          },
          paint: { "text-color": "#ffffff" },
        });
        // Unclustered individual pins — same shared paint consts as init, so the
        // two blocks can never drift again. (Glow layer removed — see init block.)
        map.addLayer({
          id: "lead-unclustered",
          type: "circle",
          source: "leads-cluster",
          filter: ["!", ["has", "point_count"]],
          minzoom: 12,
          paint: UNCLUSTERED_PAINT,
        });
        map.addLayer(
          {
            id: "lead-fresh-confirmed-halo",
            type: "circle",
            source: "leads-cluster",
            filter: [
              "all",
              ["!", ["has", "point_count"]],
              ["==", ["get", "fresh"], 1],
            ],
            minzoom: 12,
            paint: {
              "circle-radius": [
                "interpolate",
                ["linear"],
                ["zoom"],
                12,
                10,
                18,
                16,
              ],
              "circle-color": "rgba(34,197,94,0.16)",
              "circle-stroke-width": 2.5,
              "circle-stroke-color": "#22c55e",
            },
          },
          "lead-unclustered",
        );
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
          data: emptyFeatureCollection(),
        });
        map.addLayer({
          id: "draw-bbox-fill",
          type: "fill",
          source: "draw-bbox",
          paint: { "fill-color": "#f97316", "fill-opacity": 0.1 },
        });
        map.addLayer({
          id: "draw-bbox-outline",
          type: "line",
          source: "draw-bbox",
          paint: {
            "line-color": "#f97316",
            "line-width": 2,
            "line-dasharray": [3, 2],
          },
        });
      }
      ensureTransientMapLayers(map);
      (map.getSource(SEARCH_RESULT_SOURCE) as any)?.setData(
        searchGeoJsonRef.current,
      );
      (map.getSource(SCAN_RESULTS_SOURCE) as any)?.setData(
        scanGeoJsonRef.current,
      );
      lassoLayerRef.current = false;
      // House numbers are style layers too — re-enable on the fresh style with
      // the palette that suits it (white-on-imagery vs ink-on-streets).
      ensureHousenumLayer(map, mapStyleMode);
      // NEW_FIELD_MAP status-icon layer — re-add on the fresh style (setStyle
      // wiped its images + layer). Flag-gated + idempotent, so this stays in sync
      // with the init block and is a no-op when the flag is off.
      await addStatusIconLayer(map);
      // Re-trigger the lead-pin setData + territory render effects — the new
      // style starts with an empty source, so without this the pins vanish.
      setStyleEpoch((e) => e + 1);
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
      try {
        map.getCanvas().style.cursor = "";
      } catch {}
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
    let stroke: [number, number][] = []; // [lng, lat]
    let lastPx: { x: number; y: number } | null = null;
    let drawing = false;
    const MIN_PX_DIST = 5; // thin points: capture every ~5px of movement
    const MAX_POINTS = 800;

    const render = (closeRing: boolean) => {
      if (stroke.length < 2) return;
      // While dragging: a smooth OPEN line that grows with the finger (never a
      // flat filled sliver — that was the "starts with a flat line" bug). Only on
      // release do we close it into a filled polygon.
      const geojson =
        closeRing && stroke.length >= 3
          ? {
              type: "Feature" as const,
              geometry: {
                type: "Polygon" as const,
                coordinates: [[...stroke, stroke[0]]],
              },
              properties: {},
            }
          : {
              type: "Feature" as const,
              geometry: { type: "LineString" as const, coordinates: stroke },
              properties: {},
            };
      if (!lassoLayerRef.current) {
        try {
          map.addSource("lasso-polygon", { type: "geojson", data: geojson });
          map.addLayer({
            id: "lasso-fill",
            type: "fill",
            source: "lasso-polygon",
            paint: { "fill-color": "#2dd4bf", "fill-opacity": 0.14 },
          });
          map.addLayer({
            id: "lasso-outline",
            type: "line",
            source: "lasso-polygon",
            paint: {
              "line-color": "#5eead4",
              "line-width": 3,
              "line-cap": "round",
              "line-join": "round",
            },
          });
          lassoLayerRef.current = true;
        } catch {}
      } else {
        try {
          (map.getSource("lasso-polygon") as any).setData(geojson);
        } catch {}
      }
    };

    const start = (lngLat: any, point: any) => {
      drawing = true;
      stroke = [[lngLat.lng, lngLat.lat]];
      lastPx = { x: point.x, y: point.y };
      // A new stroke replaces the previous selection — also drop the prior loop's
      // status refinement so a fresh loop always starts with EVERY status included
      // (else re-drawing without Exit silently excludes the old loop's toggled-off
      // statuses from the new one — e.g. Prospect off in loop A drops all of B's).
      setLassoSelected([]);
      setLassoPoints([]);
      setLassoDisabled(new Set());
      clearPreview();
    };

    const move = (lngLat: any, point: any) => {
      if (!drawing || stroke.length >= MAX_POINTS || !lastPx) return;
      const dx = point.x - lastPx.x,
        dy = point.y - lastPx.y;
      if (dx * dx + dy * dy < MIN_PX_DIST * MIN_PX_DIST) return;
      lastPx = { x: point.x, y: point.y };
      stroke.push([lngLat.lng, lngLat.lat]);
      render(false);
    };

    const finish = () => {
      if (!drawing) return;
      drawing = false;
      // Too small to be a deliberate loop → treat as accidental tap, clear.
      if (stroke.length < 8) {
        stroke = [];
        clearPreview();
        return;
      }
      render(true);
      // Select from the VISIBLE set (territory-clip + rep + status filters), so
      // a lasso only ever selects leads the user can actually see and assign —
      // never a hidden lead. Falls back to all leads if the map hasn't published
      // a filtered set yet. Bbox-rejected O(n + k·v) (see lib/mapGeo.ts).
      const source: MapPin[] =
        (window as any).__visibleLeads ?? (window as any).__allLeads ?? [];
      const selected = selectPointsInPolygon(source, stroke);
      setLassoPoints(stroke);
      setLassoSelected(selected);
    };

    const cancelStroke = () => {
      drawing = false;
      stroke = [];
      clearPreview();
    };

    // Mouse
    const onMouseDown = (e: any) => start(e.lngLat, e.point);
    const onMouseMove = (e: any) => move(e.lngLat, e.point);
    const onMouseUp = () => finish();
    // Touch — single finger draws; a second finger cancels the stroke.
    const onTouchStart = (e: any) => {
      if (e.points && e.points.length > 1) {
        cancelStroke();
        return;
      }
      start(e.lngLat, e.point);
    };
    const onTouchMove = (e: any) => {
      if (e.points && e.points.length > 1) {
        cancelStroke();
        return;
      }
      move(e.lngLat, e.point);
    };
    const onTouchEnd = () => finish();

    map.on("mousedown", onMouseDown);
    map.on("mousemove", onMouseMove);
    map.on("mouseup", onMouseUp);
    map.on("touchstart", onTouchStart);
    map.on("touchmove", onTouchMove);
    map.on("touchend", onTouchEnd);

    return () => {
      (window as any).__lassoActive = false;
      // Defensive: on unmount the map may already be removed (getCanvas → undefined)
      try {
        map.off("mousedown", onMouseDown);
        map.off("mousemove", onMouseMove);
        map.off("mouseup", onMouseUp);
        map.off("touchstart", onTouchStart);
        map.off("touchmove", onTouchMove);
        map.off("touchend", onTouchEnd);
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
    return () => {
      document.head.removeChild(style);
    };
  }, []);

  // ── Scan Map box selection ────────────────────────────────────────────────
  // Render / clear the in-progress selection rectangle in the draw-bbox source.
  const updateDrawBox = useCallback((b: BBox) => {
    const src = mapRef.current?.getSource("draw-bbox") as any;
    src?.setData({
      type: "Feature",
      geometry: {
        type: "Polygon",
        coordinates: [[
          [b.minLng, b.minLat],
          [b.maxLng, b.minLat],
          [b.maxLng, b.maxLat],
          [b.minLng, b.maxLat],
          [b.minLng, b.minLat],
        ]],
      },
      properties: {},
    });
  }, []);
  const clearDrawBox = useCallback(() => {
    const src = mapRef.current?.getSource("draw-bbox") as any;
    src?.setData(emptyFeatureCollection());
  }, []);

  // Submit ONE Complete Scan of the SELECTED BOX. The server discovers every
  // address inside it (multi-source, ZIP-normalized, deduped), mints a fresh
  // authorized token, and qualifies each through the durable queue. The in-flight
  // ref + the active-scan check make a double-submit a guaranteed no-op.
  //
  // ELECTION-ONLY INVARIANT: this is the ONLY path that starts a field-map scan,
  // and its only caller is the box-draw release handler below — so a scan runs
  // if and only if the operator draws and releases an area. Nothing auto-scans
  // on mount, pan, or zoom. Do not add another caller (a viewport/auto scan);
  // the field map scans on election, never on its own.
  const startBoxScan = useCallback(
    async (bbox: BBox) => {
      // Duplicate-scan protection, layered: the in-flight ref stops a double
      // submit within one tick, `scanning` stops a second election while a scan
      // runs, and the reducer's START guard ignores a redundant START even if
      // both slip through. One elected scan at a time.
      if (!mapReady || scanStartInFlightRef.current || scanning || !canSubmitScan) return;
      scanStartInFlightRef.current = true;
      const scopeKey = boxKeyOf(bbox)!;
      // Explicit user action → enter `running` (optimistic, before the server
      // returns a jobId). This is the ONE and ONLY transition into running.
      dispatchScan({ type: "START", boxKey: scopeKey, at: Date.now() });
      // eslint-disable-next-line no-console
      console.info("[areaScan] START elected box", scopeKey);
      setScanSubmitting(true);
      setScanSheetHidden(false);
      const geometry = {
        type: "Polygon" as const,
        coordinates: [[
          [bbox.minLng, bbox.minLat],
          [bbox.maxLng, bbox.minLat],
          [bbox.maxLng, bbox.maxLat],
          [bbox.minLng, bbox.maxLat],
          [bbox.minLng, bbox.minLat],
        ]],
      };
      const existingSubmission =
        scanSubmissionRef.current?.boxKey === scopeKey
          ? scanSubmissionRef.current
          : null;
      const nonce =
        existingSubmission?.nonce ??
        (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
      scanSubmissionRef.current = { boxKey: scopeKey, nonce };
      setScanOutcome(null);
      let accepted = false;
      try {
        const job = await discovery.submit({
          geometry,
          // Re-check every discovered address, including existing leads, so a
          // fresh lead that has since bought service (→ now active) or a
          // coming-soon that just went live is caught on this pass.
          rescan: true,
          idempotencyKey: discoveryIdempotencyKey(geometry, user?.tenantId, nonce),
        });
        accepted = true;
        // Server accepted — we now OWN this jobId. Only updates for it can drive
        // the machine from here on.
        dispatchScan({ type: "ATTACH", jobId: job.id });
        // eslint-disable-next-line no-console
        console.info("[areaScan] ATTACH job", job.id);
      } catch {
        // The submit itself failed — surface it LOUDLY instead of silently
        // hiding the Scan button for 30s and announcing "complete" (a rep read
        // that as "the box had no leads"). A destructive toast + no phantom
        // outcome so the Scan Map button returns immediately for a retry.
        dispatchScan({ type: "SUBMIT_FAILED", error: "Scan could not start" });
        setScanOutcome(null);
        toast({
          title: "Scan couldn't start",
          description: "The area scan didn't launch. Draw the box again to retry.",
          variant: "destructive",
        });
      } finally {
        if (accepted) scanSubmissionRef.current = null;
        scanStartInFlightRef.current = false;
        setScanSubmitting(false);
      }
    },
    [mapReady, scanning, canSubmitScan, discovery.submit, user?.tenantId, toast],
  );

  // Box-draw capture — active only while Scan Map is armed. Drag two corners; on
  // release, scan exactly inside the rectangle. Pan/zoom are suspended during the
  // drag so the box tracks the pointer, then restored on teardown.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !scanDrawMode) return;
    scanBoxDrawingRef.current = false;
    scanBoxStartRef.current = null;
    (window as any).__scanDrawActive = true;
    try {
      map.getCanvas().style.cursor = "crosshair";
      map.dragPan.disable();
      map.touchZoomRotate.disable();
    } catch {}
    let startPx: { x: number; y: number } | null = null;
    const down = (lngLat: any, point: any) => {
      scanBoxDrawingRef.current = true;
      scanBoxStartRef.current = { lng: lngLat.lng, lat: lngLat.lat };
      startPx = { x: point.x, y: point.y };
    };
    const moveTo = (lngLat: any) => {
      const s = scanBoxStartRef.current;
      if (!scanBoxDrawingRef.current || !s) return;
      updateDrawBox({
        minLng: Math.min(s.lng, lngLat.lng),
        maxLng: Math.max(s.lng, lngLat.lng),
        minLat: Math.min(s.lat, lngLat.lat),
        maxLat: Math.max(s.lat, lngLat.lat),
      });
    };
    const up = (lngLat: any, point: any) => {
      const s = scanBoxStartRef.current;
      if (!scanBoxDrawingRef.current || !s) return;
      scanBoxDrawingRef.current = false;
      scanBoxStartRef.current = null;
      // A stray tap (<6px) is not a box — stay armed rather than scan a dot.
      if (startPx && Math.hypot(point.x - startPx.x, point.y - startPx.y) < 6) {
        clearDrawBox();
        return;
      }
      const bbox: BBox = {
        minLng: Math.min(s.lng, lngLat.lng),
        maxLng: Math.max(s.lng, lngLat.lng),
        minLat: Math.min(s.lat, lngLat.lat),
        maxLat: Math.max(s.lat, lngLat.lat),
      };
      setScanDrawMode(false);
      clearDrawBox();
      void startBoxScan(bbox);
    };
    const onDown = (e: any) => down(e.lngLat, e.point);
    const onMove = (e: any) => moveTo(e.lngLat);
    const onUp = (e: any) => up(e.lngLat, e.point);
    const onTDown = (e: any) => {
      if (e.points && e.points.length > 1) return;
      down(e.lngLat, e.point);
    };
    const onTMove = (e: any) => {
      if (e.points && e.points.length > 1) return;
      moveTo(e.lngLat);
    };
    const onTUp = (e: any) => up(e.lngLat, e.point);
    map.on("mousedown", onDown);
    map.on("mousemove", onMove);
    map.on("mouseup", onUp);
    map.on("touchstart", onTDown);
    map.on("touchmove", onTMove);
    map.on("touchend", onTUp);
    return () => {
      (window as any).__scanDrawActive = false;
      scanBoxDrawingRef.current = false;
      scanBoxStartRef.current = null;
      try {
        map.off("mousedown", onDown);
        map.off("mousemove", onMove);
        map.off("mouseup", onUp);
        map.off("touchstart", onTDown);
        map.off("touchmove", onTMove);
        map.off("touchend", onTUp);
      } catch {}
      try {
        map.getCanvas().style.cursor = "";
        map.dragPan.enable();
        map.touchZoomRotate.enable();
      } catch {}
    };
  }, [scanDrawMode, mapReady, updateDrawBox, clearDrawBox, startBoxScan]);

  // ── Discovery jobs + live lead batches ────────────────────────────────────
  // Events mutate a key-indexed feature map. One requestAnimationFrame flush
  // publishes the whole collection to Mapbox no matter how many SSE messages
  // arrived in that frame; replayed events replace their stable feature rather
  // than creating a duplicate dot or inflating the displayed lead count.
  const scheduleScanFeatureFlush = useCallback(() => {
    if (scanFlushRafRef.current != null) return;
    scanFlushRafRef.current = requestAnimationFrame(() => {
      scanFlushRafRef.current = null;
      scanGeoJsonRef.current = {
        type: "FeatureCollection",
        features: Array.from(scanFeatureMapRef.current.values()),
      };
      const source = mapRef.current?.getSource(SCAN_RESULTS_SOURCE) as any;
      source?.setData(scanGeoJsonRef.current);
    });
  }, []);

  useEffect(
    () => () => {
      if (scanFlushRafRef.current != null)
        cancelAnimationFrame(scanFlushRafRef.current);
    },
    [],
  );

  const addDiscoveryMapEvent = useCallback(
    (event: DiscoveryEvent) => {
      const type = event.eventType.toLowerCase();
      const payload = event.payload ?? {};
      // Field reps only receive operational leads. Rooftop candidates,
      // provisional results, negatives and provider failures stay server-side.
      if (type === "map.candidates" || type === "map.results") return;
      // During a rolling deploy the server may publish either a normalized lead
      // object or a ready-to-render GeoJSON feature. Accept both wire shapes, but
      // never infer a lead from an unrelated progress event.
      const feature =
        payload.feature?.type === "Feature" ? payload.feature : null;
      const row =
        payload.lead ??
        payload.result?.lead ??
        payload.result ??
        payload.candidate ??
        feature?.properties ??
        payload;
      const eventCreatesLead =
        type.includes("lead") &&
        (type.includes("created") ||
          type.includes("qualified") ||
          type.includes("published"));
      // Any projector-stamped confirmed lead paints live — cross_verified OR
      // the authoritative kinetic_new_fiber (NEW FIBER + billing N) publish.
      const explicitlyQualified =
        row.qualified === true ||
        row.fresh === true ||
        (row.isFreshFiber === true && row.freshFiberVerdict === "fresh") ||
        row.leadTag === "fresh_fiber_confirmed";
      if (!eventCreatesLead && !explicitlyQualified) return;
      if (row.leadTag !== "fresh_fiber_confirmed") return;

      const featureCoordinates = Array.isArray(feature?.geometry?.coordinates)
        ? feature.geometry.coordinates
        : [];
      const lat = Number(row.lat ?? row.latitude ?? featureCoordinates[1]);
      const lng = Number(row.lng ?? row.longitude ?? featureCoordinates[0]);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
      const canonicalId =
        row.canonicalAddressId ??
        row.canonical_address_id ??
        row.leadId ??
        row.lead_id ??
        row.id ??
        `${String(row.address ?? "unknown")
          .trim()
          .toLowerCase()}|${lat.toFixed(6)}|${lng.toFixed(6)}`;
      const key = `${event.jobId}:${canonicalId}`;
      const publishedId = String(
        row.leadId ?? row.lead_id ?? row.id ?? canonicalId,
      );
      const publishedForJob =
        publishedLeadIdsByJobRef.current.get(event.jobId) ?? new Set<string>();
      publishedForJob.add(publishedId);
      publishedLeadIdsByJobRef.current.set(event.jobId, publishedForJob);
      scanFeatureMapRef.current.set(key, {
        type: "Feature",
        id: key,
        geometry: { type: "Point", coordinates: [lng, lat] },
        properties: {
          jobId: event.jobId,
          leadId:
            row.leadId ??
            row.lead_id ??
            (row.leadTag === "fresh_fiber_confirmed" ? (row.id ?? null) : null),
          canonicalAddressId: String(canonicalId),
          receivedAt: Date.now(),
          scanStatus: "fresh_confirmed",
          carrier: String(row.carrier ?? "kinetic"),
          address: String(row.address ?? row.addressLine1 ?? "Address"),
          city: String(row.city ?? ""),
          state: String(row.state ?? ""),
          zip: String(row.zip ?? row.postalCode ?? ""),
          fiberStatus: String(
            row.fiberStatus ?? row.fiber_status ?? "new_fiber",
          ),
          isNewFiber: true,
          billingStatus: row.billingStatus ?? row.billing_status ?? null,
          householdSegmentType: row.householdSegmentType ?? null,
          techType: row.techType ?? row.tech ?? "fiber",
          placement: row.placement ?? null,
          maxDownloadMbps: row.maxDownloadMbps ?? row.max_mbps ?? null,
          competitorName: row.competitorName ?? row.competitor ?? null,
          leadTag: row.leadTag ?? "fresh_fiber_confirmed",
          freshConfidence: row.freshConfidence ?? "cross_verified",
          leadScore: row.leadScore ?? row.confidenceScore ?? null,
        },
      });
      scheduleScanFeatureFlush();
    },
    [scheduleScanFeatureFlush],
  );

  useEffect(
    () => discovery.subscribe(addDiscoveryMapEvent),
    [discovery.subscribe, addDiscoveryMapEvent],
  );

  // Incremental SSE pins are an instant visual bridge, not a second durable
  // lead layer. As soon as the normal tenant lead feed contains an id, remove
  // its temporary scan feature so the same rooftop is never painted twice.
  // Bound orphaned bridge features as a final guard during long field sessions.
  useEffect(() => {
    const durableIds = new Set(leads.map((lead) => Number(lead.id)));
    let changed = false;
    for (const [key, feature] of scanFeatureMapRef.current) {
      const leadId = Number(feature?.properties?.leadId);
      if (Number.isSafeInteger(leadId) && durableIds.has(leadId)) {
        scanFeatureMapRef.current.delete(key);
        changed = true;
      }
    }
    if (scanFeatureMapRef.current.size > 5_000) {
      const oldest = [...scanFeatureMapRef.current.entries()]
        .sort(
          (a, b) =>
            Number(a[1]?.properties?.receivedAt ?? 0) -
            Number(b[1]?.properties?.receivedAt ?? 0),
        )
        .slice(0, scanFeatureMapRef.current.size - 5_000);
      for (const [key] of oldest) scanFeatureMapRef.current.delete(key);
      changed = true;
    }
    if (changed) scheduleScanFeatureFlush();
  }, [leads, scheduleScanFeatureFlush]);

  // Terminal collapse to one field-friendly result — for the OWNED scan ONLY.
  // A background harvest or a crash-orphaned job reaching terminal must never
  // pop a summary sheet on this map; only the box THIS operator elected does.
  // Provider diagnostics, failures and inconclusive homes remain in the
  // server-side admin audit trail. No full-map refetch is triggered per event:
  // the SSE lead payload paints immediately and the normal stream/safety poll
  // reconciles the durable main lead source.
  useEffect(() => {
    const job = ownedScanJob;
    if (
      !job ||
      !isTerminalDiscoveryJob(job) ||
      terminalJobsHandledRef.current.has(job.id)
    )
      return;
    terminalJobsHandledRef.current.add(job.id);
    const checked = job.checkedCount + job.failedCount;
    const found = publishedLeadIdsByJobRef.current.get(job.id)?.size ?? 0;
    publishedLeadIdsByJobRef.current.delete(job.id);
    setScanSheetHidden(false); // a finished scan re-surfaces its summary
    setScanOutcome({
      kind: found > 0 ? "success" : "complete",
      found,
      checked,
      at: Date.now(),
      boxKey: scanState.boxKey,
    });
    // eslint-disable-next-line no-console
    console.info("[areaScan] terminal", job.id, job.status, { found, checked });
  }, [ownedScanJob, scanState.boxKey]);

  // Keep the finished summary up long enough to actually read the five counts,
  // then auto-clear so the Scan Map button returns (the sheet's X dismisses sooner).
  useEffect(() => {
    if (!scanOutcome || scanning) return;
    const timer = window.setTimeout(() => {
      setScanOutcome(null);
      dispatchScan({ type: "DISMISS" }); // machine → idle; clears persisted record
    }, 30_000);
    return () => window.clearTimeout(timer);
  }, [scanOutcome, scanning]);

  // ── Escape hatch — one keyboard path out of every map tool, in priority
  // order: open panel → armed lasso → armed/boxed scan. Search close returns
  // focus to the magnifier so keyboard users never lose their place. Defined
  // AFTER stopScan/exitLasso (deps evaluate at render — TDZ otherwise).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (searchOpen) {
        setSearchOpen(false);
        setSidebarSearch("");
        searchBtnRef.current?.focus();
      } else if (layersOpen) {
        setLayersOpen(false);
        layersBtnRef.current?.focus();
      } else if (leadsOpen) {
        setLeadsOpen(false);
        leadsBtnRef.current?.focus();
      } else if (lassoMode) {
        exitLasso();
      } else if (scanDrawMode) {
        setScanDrawMode(false);
        clearDrawBox();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    searchOpen,
    layersOpen,
    leadsOpen,
    lassoMode,
    scanDrawMode,
    clearDrawBox,
    exitLasso,
  ]);

  // Auto-focus the search field the instant the panel opens (next frame, after
  // the element mounts) — the magnifier is a search affordance, not a toggle.
  useEffect(() => {
    if (!searchOpen) return;
    const r = requestAnimationFrame(() => searchInputRef.current?.focus());
    return () => cancelAnimationFrame(r);
  }, [searchOpen]);

  // ── Legend items ──────────────────────────────────────────────────────────
  // When glyph mode is on, draw the EXACT map glyph beside each legend row (built
  // once via the shared spriteDataUrl → zero shape duplication). Empty when the
  // circle map is showing, so the legend keeps its color dots. Depends on mapReady
  // because the server rollout flag is hydrated before the map becomes ready.
  const legendGlyphs = useMemo<Record<string, string>>(() => {
    if (!newFieldMap()) return {};
    const dpr =
      typeof window !== "undefined" && window.devicePixelRatio > 0
        ? window.devicePixelRatio
        : 1;
    const out: Record<string, string> = {};
    for (const [status, icon] of Object.entries(LEGEND_STATUS_TO_ICON)) {
      const url = spriteDataUrl(icon, dpr);
      if (url) out[status] = url;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady]);

  // ── Fly to lead on map ────────────────────────────────────────────────────
  // Geocode an arbitrary street the user typed (admin only) and jump the map
  // there so they can draw a cut-out box + scan. Costs 1 Mapbox geocode call.
  const jumpToAddress = useCallback(
    async (q: string) => {
      const query = q.trim();
      if (!query || geocoding) return;
      setGeocoding(true);
      try {
        const res = await apiRequest(
          "GET",
          `/api/geocode?q=${encodeURIComponent(query)}`,
        );
        const data = await res.json();
        if (!res.ok || data.lng == null) {
          toast({
            title: data.error || "Address not found",
            variant: "destructive",
          });
          return;
        }
        const map = mapRef.current;
        if (map) {
          suspendFollowCameraRef.current();
          didAutoFitRef.current = true;
          map.stop();
          searchGeoJsonRef.current = {
            type: "FeatureCollection",
            features: [
              {
                type: "Feature",
                id: "address-search",
                geometry: { type: "Point", coordinates: [data.lng, data.lat] },
                properties: { placeName: data.placeName ?? query },
              },
            ],
          };
          (map.getSource(SEARCH_RESULT_SOURCE) as any)?.setData(
            searchGeoJsonRef.current,
          );
          map.flyTo({
            center: [data.lng, data.lat],
            zoom: 17.25,
            bearing: map.getBearing(),
            pitch: map.getPitch(),
            duration: 850,
            essential: true,
          });
        }
        setSidebarSearch("");
        setSearchOpen(false);
        toast({
          title: `Jumped to ${data.placeName}`,
          description: canSubmitScan
            ? "Draw a Scan-Area box here, then scan for new fiber."
            : undefined,
        });
      } catch (e: any) {
        toast({ title: "Address lookup failed", variant: "destructive" });
      } finally {
        setGeocoding(false);
      }
    },
    [geocoding, toast, canSubmitScan],
  );

  const flyToLead = useCallback((lead: MapPin) => {
    const map = mapRef.current;
    if (!map || !lead.lat || !lead.lng) return;
    const target: [number, number] = [lead.lng, lead.lat];
    suspendFollowCameraRef.current();
    didAutoFitRef.current = true;
    searchGeoJsonRef.current = emptyFeatureCollection();
    (map.getSource(SEARCH_RESULT_SOURCE) as any)?.setData(
      searchGeoJsonRef.current,
    );
    setSelectedLeadId(lead.id);
    // The card opens via selectedLeadId; camera padding keeps the pin visible
    // beside/above it (docked panel or bottom sheet).
    moveCamera(map, {
      center: target,
      zoom: Math.max(map.getZoom?.() ?? 16, 16.5),
      padding: { top: 0, left: 0, right: 0, bottom: sheetPeekPaddingPx() },
      duration: 600,
      essential: true,
    });
  }, []);

  // "Next door" — the map's next-best-property flow. Same routing brain as the
  // Today hero (shared nearestUnworkedLead): from where the rep is STANDING
  // (fresh/cached GPS via captureFieldFix — never rejects; falls back to the
  // map center), fly to the nearest unworked/not-home door, skipping the doors
  // just worked this session (recentIdsRef), and open its knock sheet.
  const nextBestDoor = useCallback(() => {
    const open = leads.filter((p) => {
      const s = pinDisplayState(p);
      return (
        (s === "unworked" || s === "not_home") && p.lat != null && p.lng != null
      );
    });
    if (!open.length) {
      toast({
        title: "Every door is worked",
        description: "No open doors on your map right now — nice work.",
      });
      return;
    }
    captureFieldFix().then((fix) => {
      const c = mapRef.current?.getCenter?.();
      const from =
        fix.repLat != null && fix.repLng != null
          ? { lat: fix.repLat, lng: fix.repLng }
          : c
            ? { lat: c.lat, lng: c.lng }
            : { lat: open[0].lat!, lng: open[0].lng! };
      const exclude = new Set(recentIdsRef.current);
      const next =
        (nearestUnworkedLead(
          from,
          open as unknown as RoutablePin[],
          exclude,
        ) as MapPin | null) ?? open[0];
      flyToLead(next);
    });
  }, [leads, flyToLead, toast]);

  // Leads-panel row tap — the SAME path a pin tap takes (flyToLead →
  // setSelectedLeadId → card/sheet). Phone closes the drawer to reveal the map.
  const onLeadsRowTap = useCallback(
    (id: number) => {
      const lead = leadById.get(id);
      if (!lead) return;
      if (!window.matchMedia("(min-width: 1024px)").matches)
        setLeadsOpen(false);
      flyToLead(lead);
    },
    [leadById, flyToLead],
  );

  // Fit the camera to every painted lead (the FILTERED set — fitting hidden
  // pins would frame an empty view). fitBounds fires moveend → list refreshes.
  const fitAllLeads = useCallback(() => {
    const map = mapRef.current;
    if (!map || mapTotalLeads.length === 0) return;
    try {
      const b = new (window as any).mapboxgl.LngLatBounds();
      for (const l of mapTotalLeads) b.extend([l.lng, l.lat]);
      map.fitBounds(b, { padding: 60, maxZoom: 15 });
    } catch {
      /* map mid-teardown */
    }
  }, [mapTotalLeads]);

  // Memoized so these full-array passes over all leads don't re-run on every
  // render (the map re-renders ~every 400ms during a scan). Counts read the
  // CURRENT LENS (territory clip + rep filter) so every legend row and the
  // filter pill state exactly what selecting that status will paint.
  const statusCounts = useMemo(() => {
    const acc: Record<string, number> = {};
    for (const s of Object.keys(PIN_COLORS)) acc[s] = 0;
    for (const l of repFilteredLeads)
      if (acc[l.leadStatus] !== undefined) acc[l.leadStatus]++;
    return acc;
  }, [repFilteredLeads]);

  // ── SalesRabbit-style disposition chips ─────────────────────────────────────
  // The status-filter bar over the map: "All" + one chip per disposition that has
  // pins, each with its pin color + live count. Order follows the canvassing
  // funnel (fresh → worked → closed). Tapping a chip filters the pins.
  const STATUS_ORDER = [
    "prospect",
    "follow_up",
    "interested",
    "sold",
    "not_interested",
    "contacted",
  ] as const;
  const statusChips = useMemo(
    () =>
      STATUS_ORDER.filter((k) => (statusCounts[k] ?? 0) > 0).map((k) => ({
        key: k as string,
        count: statusCounts[k] ?? 0,
        ...PIN_COLORS[k],
      })),
    [statusCounts],
  );
  const totalLeadCount = useMemo(
    () => repFilteredLeads.length,
    [repFilteredLeads],
  );

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
  // keystroke never re-lowercases 50k addresses. A NUL separates the two
  // fields so a query can't falsely match across the address/city boundary.
  const searchIndex = useMemo(
    () =>
      leads.map((l) => ({
        l,
        hay: (l.address + "\u0000" + (l.city ?? "")).toLowerCase(),
      })),
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
      while (
        i > 0 &&
        (rank(top[i - 1]) < rank(l) ||
          (rank(top[i - 1]) === rank(l) && top[i - 1].id < l.id))
      )
        i--;
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
      post: (url, body) => apiRequest("POST", url, body).then((r) => r.json()),
      patch: (url, body) =>
        apiRequest("PATCH", url, body).then((r) => r.json()),
      onSaved: (leadId: number) => {
        qc.invalidateQueries({ queryKey: ["/api/leaderboard"] });
        qc.invalidateQueries({ queryKey: ["/api/leads"] });
        // The card's History timeline shows the new entry as soon as the POST lands.
        qc.invalidateQueries({ queryKey: [`/api/leads/${leadId}/history`] });
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.teamMemberId, useSheet]);
  const subscribeQueue = useCallback(
    (cb: () => void) => (knockQueue ? knockQueue.subscribe(cb) : () => {}),
    [knockQueue],
  );
  const getQueueSnap = useCallback(
    () => (knockQueue ? knockQueue.getSnapshot() : EMPTY_QUEUE_SNAP),
    [knockQueue],
  );
  const queueSnap = useSyncExternalStore(subscribeQueue, getQueueSnap);

  const selectedLead =
    selectedLeadId != null ? (leadById.get(selectedLeadId) ?? null) : null;

  // One-tap disposition: optimistic pin recolor FIRST (marking a door must feel
  // instant in the field), then the offline-safe enqueue. The queue owns
  // retries/idempotency; react-query owns rollback via onSaved invalidations.
  // The card's chip, timestamp, and active pill all read from this same
  // optimistic pin data, so a single tap updates everything at once.
  const handleKnock = useCallback(
    (outcome: KnockOutcome) => {
      const lead =
        selectedLeadId != null ? leadById.get(selectedLeadId) : undefined;
      if (!lead || !knockQueue) return;
      const credit = isRep
        ? user?.teamMemberId
        : (lead.assignedRepId ?? user?.teamMemberId);
      if (!credit) {
        // Managers without a team-member row can't self-credit a knock; the
        // card's Assign menu (visible to lead.assign holders, right on this
        // sheet) is the one-tap fix — point straight at it.
        toast({
          title: "Pick a rep to credit first",
          description:
            "Use the Assign menu on this card, then tap the outcome again.",
          variant: "destructive",
        });
        return;
      }
      const at = new Date().toISOString();
      const nextLeadStatus = OUTCOME_TO_STATUS[outcome] ?? lead.leadStatus;
      const nextDisplayState = pinDisplayState({
        leadStatus: nextLeadStatus,
        visited: true,
        lastOutcome: outcome,
      });

      // Mutate exactly one GeoJSON feature and hand the same collection back to
      // Mapbox. The symbol icon swaps immediately; React does not rebuild 5,000
      // lead components because the pins are not components or HTML markers.
      const feature = featureByIdRef.current.get(lead.id);
      if (feature) {
        feature.properties.status = toLeadMapStatus(nextDisplayState);
        feature.properties.ds = nextDisplayState;
        feature.properties.visited = 1;
        try {
          (mapRef.current?.getSource("leads-cluster") as any)?.setData(
            geoJsonDataRef.current,
          );
          // This pin is now painted; let the reconcile effect skip its
          // duplicate full setData when the optimistic update lands.
          pendingKnockPaintRef.current = lead.id;
        } catch {
          /* source can disappear during a style switch; query cache still updates below */
        }
      }
      qc.setQueryData(["/api/leads/map"], (old: any) => {
        if (!old?.pins) return old;
        return {
          ...old,
          pins: old.pins.map((p: MapPin) =>
            p.id === lead.id
              ? {
                  ...p,
                  leadStatus: nextLeadStatus,
                  visited: true,
                  knockCount: (p.knockCount ?? 0) + 1,
                  lastOutcome: outcome,
                  lastKnockedAt: at,
                }
              : p,
          ),
        };
      });
      recentIdsRef.current = [...recentIdsRef.current.slice(-9), lead.id];
      // Fire the pin's confirm-flash in the SAME color the card pill flashes (both
      // derive from the shared palette), so tapping an outcome pops the map marker
      // and the card in lockstep. Visual only — the card's onKnock path already did
      // the haptic. The selected-ring rAF reads this ref on its next frame.
      try {
        ringFlashRef.current = {
          at: performance.now(),
          color: STATE_COLORS[nextDisplayState],
        };
      } catch {
        /* palette lookup is best-effort — no flash, pin still recolors */
      }
      // Capture WHERE the rep is standing at the tap so the server can verify the
      // work. Non-blocking: the pin already recolored above; we attach the fix and
      // enqueue when it resolves (a recent cached fix returns almost instantly, a
      // denied/absent one enqueues location-less → server marks it Needs Review).
      captureFieldFix().then((fix) => {
        knockQueue.enqueue({
          leadId: lead.id,
          repId: credit,
          outcome,
          callbackDate: null,
          callbackTime: null,
          ...fix,
        });
      });
      // Sold pays: the server auto-creates a pending commission with this knock.
      // Un-marking a sale reverses it. Refresh the Commission tab either way.
      if (outcome === "sold") {
        toast({
          title: "Sold — commission entry created",
          description: "Pending review in the Commission tab",
        });
        qc.invalidateQueries({ queryKey: ["/api/commissions"] });
        qc.invalidateQueries({ queryKey: ["/api/commissions/summary"] });
      } else if (lead.leadStatus === "sold") {
        // Was sold, now marked otherwise → the server drops its pending commission.
        toast({ title: "Sale removed — pending commission reversed" });
        qc.invalidateQueries({ queryKey: ["/api/commissions"] });
        qc.invalidateQueries({ queryKey: ["/api/commissions/summary"] });
      }
    },
    [leadById, selectedLeadId, knockQueue, isRep, user, qc, toast],
  );

  // Lead-level notes: the card owns typing; this owns persistence through the
  // offline-safe, conflict-aware pipeline in lib/leadNotes. Explicit leadId so
  // the card can flush the OUTGOING lead's pending note during a swap.
  const notePoster = useCallback<NotePoster>(
    (leadId, body) => apiRequest("PATCH", `/api/leads/${leadId}/notes`, body),
    [],
  );
  const handleSaveNote = useCallback(
    async (
      leadId: number,
      note: string,
      baseUpdatedAt: string | null,
    ): Promise<NoteSaveResult> => {
      const result = await saveLeadNote(
        notePoster,
        leadId,
        note,
        baseUpdatedAt,
      );
      if (result.status === "saved") {
        qc.invalidateQueries({ queryKey: [`/api/leads/${leadId}`] });
        qc.invalidateQueries({ queryKey: [`/api/leads/${leadId}/history`] }); // note event just landed
      }
      return result;
    },
    [notePoster, qc],
  );

  // Stashed offline notes flush the moment connectivity returns (and once on
  // mount, in case the app reloaded while offline notes were pending).
  useEffect(() => {
    const flush = () => {
      void flushPendingNotes(notePoster);
    };
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
    // Bottom pad reads sheetPeekPaddingPx(), which now tracks the card's LIVE
    // measured peek height (sheetPeekPx below is the effect trigger for it).
    let dockedPanel = false;
    try {
      dockedPanel = window.matchMedia("(min-width: 1024px)").matches;
    } catch {
      /* jsdom */
    }
    const openPad = dockedPanel
      ? { top: 0, left: 0, right: 396, bottom: 0 }
      : { top: 0, left: 0, right: 0, bottom: sheetPeekPaddingPx() };
    if (selectedLeadId != null) {
      sheetWasOpenRef.current = true;
      const lead = leadById.get(selectedLeadId);
      if (lead?.lat && lead?.lng) {
        moveCamera(map, {
          center: [lead.lng, lead.lat],
          padding: openPad,
          duration: 350,
          essential: true,
        });
      }
    } else if (sheetWasOpenRef.current) {
      sheetWasOpenRef.current = false;
      moveCamera(map, {
        padding: { top: 0, left: 0, right: 0, bottom: 0 },
        duration: 250,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLeadId, mapReady, useSheet, sheetPeekPx]);

  // No resume system — live GPS is the anchor. The rep opens the app where
  // they stand; the blue dot is always on and moves with the device.

  // Selected-pin pulse: a slow breathing halo on the ring layer so the active
  // door is findable at a glance — PLUS a one-shot "confirm pop" on knock that
  // mirrors the card pill's tap-flash (ring bursts outward in the new status
  // color, then eases back to breathing). ONE rAF is the sole writer of the ring
  // paint so the two never fight. Pure style-thread paint updates (no setData,
  // no React state per frame); disabled under prefers-reduced-motion — same as
  // the card, whose flash is also a no-op there.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || selectedLeadId == null) return;
    let reduce = false;
    try {
      reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      /* jsdom */
    }
    if (reduce) return;
    let raf = 0;
    const start = performance.now();
    const FLASH_MS = 380; // confirm-pop window (card flash is ~150ms; the ring reads best a touch longer)
    const DEFAULT_STROKE = "#ffffff";
    let strokeIsStatus = false; // avoid redundant per-frame stroke-color writes
    const setStroke = (c: string) => {
      map.setPaintProperty("lead-selected-ring", "circle-stroke-color", c);
    };
    let lastIdleFrame = 0;
    const tick = (now: number) => {
      const flash = ringFlashRef.current;
      const fe = flash ? (now - flash.at) / FLASH_MS : 1; // 0..1 through the pop
      // The rep dragging the knock sheet owns the frame budget — pause every
      // pulse paint-write for the whole drag (the ring simply freezes).
      if (isSheetDragActive()) {
        raf = requestAnimationFrame(tick);
        return;
      }
      // Full-rate rAF only during the ~380ms confirm-pop. The idle breathing is
      // a slow 2.8s ease — ~20fps is visually identical at a third of the
      // forced-GL-repaint cost on a phone.
      if (!(flash && fe < 1)) {
        if (now - lastIdleFrame < 50) {
          raf = requestAnimationFrame(tick);
          return;
        }
        lastIdleFrame = now;
      }
      try {
        if (flash && fe < 1) {
          const pop = Math.sin(fe * Math.PI); // 0→1→0 ease
          map.setPaintProperty(
            "lead-selected-ring",
            "circle-radius",
            14 + pop * 12,
          );
          map.setPaintProperty(
            "lead-selected-ring",
            "circle-stroke-opacity",
            1,
          );
          if (!strokeIsStatus) {
            setStroke(flash.color);
            strokeIsStatus = true;
          }
        } else {
          if (flash) ringFlashRef.current = null; // pop finished
          if (strokeIsStatus) {
            setStroke(DEFAULT_STROKE);
            strokeIsStatus = false;
          }
          const phase = (Math.sin((now - start) / 450) + 1) / 2; // 0..1, ~2.8s cycle
          map.setPaintProperty(
            "lead-selected-ring",
            "circle-radius",
            14 + phase * 6,
          );
          map.setPaintProperty(
            "lead-selected-ring",
            "circle-stroke-opacity",
            0.95 - phase * 0.45,
          );
        }
      } catch {
        /* layer mid-reload */
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      ringFlashRef.current = null; // don't carry a pending pop onto the next selected pin
      try {
        map.setPaintProperty("lead-selected-ring", "circle-radius", 14);
        map.setPaintProperty(
          "lead-selected-ring",
          "circle-stroke-opacity",
          0.95,
        );
        map.setPaintProperty(
          "lead-selected-ring",
          "circle-stroke-color",
          DEFAULT_STROKE,
        );
      } catch {
        /* map torn down */
      }
    };
  }, [selectedLeadId, mapReady, styleEpoch]);

  // noToken is true only after we confirmed the token is unavailable (never during load)
  const noToken = mapTokenFailed;

  // A viewport scan has no persisted drawn box, so a result is never "stale" —
  // it stays until the operator dismisses it (or the auto-clear timer fires).
  const scanStale = false;

  // ── bottomSlot — ONE bottom-center surface at a time ────────────────────────
  // The seven bottom-center surfaces used to each carry their own ad-hoc
  // exclusion flags, and pairs could still collide (scan sheet under an open
  // knock sheet; lasso bar over a running scan's sheet). One derived priority
  // decides who owns the bottom-center: knock sheet > lasso bar > scan sheet >
  // armed hints > Live Test > the resting Scan FAB pair.
  const bottomSlot: "knock" | "lasso" | "scan" | "hint" | "livetest" | "fabs" =
    selectedLeadId != null
      ? "knock"
      : lassoMode
        ? "lasso"
        : canSubmitScan && (scanSubmitting || scanning || (scanOutcome && !scanStale))
          ? "scan"
          : scanDrawMode || addMode
            ? "hint"
            : liveTestOpen && canSubmitScan
              ? "livetest"
              : "fabs";

  return (
    <div
      className="flex flex-col relative"
      style={{ flex: 1, minHeight: 0, overflow: "hidden" }}
    >
      {/* ── FULL-BLEED MAP (owner spec): no toolbar for ANY role. The rep
             filter lives in the legend panel; Assign Area + Scan Area live on
             the control rail; banners FLOAT over the map (the page root is
             relative, so this stack overlays the map below). ── */}
      {/* Screen-reader scan announcements — MILESTONES only (start + outcome),
          never the per-poll progress ticks that would spam a screen reader. */}
      <div
        className="sr-only"
        role="status"
        aria-live="polite"
        data-testid="scan-sr"
      >
        {scanning
          ? "Scanning the selected area."
          : scanOutcome && !scanStale
            ? scanOutcome.found > 0
              ? `${scanOutcome.found} new lead${scanOutcome.found === 1 ? "" : "s"} added.`
              : "Scan complete."
            : ""}
      </div>

      {/* ── Scan Map — a clear, floating, thumb-reachable control (Mobbin "search
             this area" pattern). Tap to arm, then drag a box over the houses to
             scan exactly inside it. Hidden while a scan/summary sheet is up and
             during Assign Area, so nothing collides. ── */}
      {canSubmitScan && bottomSlot === "fabs" && (
        <div
          style={{ bottom: "calc(env(safe-area-inset-bottom) + 1.25rem)" }}
          className="absolute left-1/2 z-30 flex -translate-x-1/2 items-center gap-2"
        >
          <button
            type="button"
            onClick={() => {
              exitLasso();
              setAddMode(false); // draw tools and add-mode are mutually exclusive
              setScanDrawMode(true);
            }}
            data-testid="scan-map-btn"
            aria-label="Scan an area of the map for new fiber"
            className="flex items-center gap-2 rounded-full border border-emerald-300/50 bg-emerald-500 px-6 py-3.5 text-[15px] font-bold text-[#04241f] shadow-xl shadow-emerald-950/40 backdrop-blur-xl transition hover:bg-emerald-400 active:scale-95"
          >
            <Radar className="h-[18px] w-[18px]" />
            Scan Map
          </button>
          <button
            type="button"
            onClick={() => { exitLasso(); setLiveTestOpen(true); }}
            data-testid="live-test-open"
            aria-label="Live Test one address"
            title="Live Test one address"
            className="glass-capsule grid h-[52px] w-[52px] place-items-center text-white/80 transition hover:text-white active:scale-95"
          >
            <Crosshair className="h-[18px] w-[18px]" />
          </button>
        </div>
      )}

      {/* Live Test panel — trace one address, right on the field scanner. */}
      {liveTestOpen && canSubmitScan && bottomSlot === "livetest" && (
        <div
          style={{ bottom: "calc(env(safe-area-inset-bottom) + 1.25rem)" }}
          className="absolute left-1/2 z-30 w-[min(456px,calc(100vw-24px))] -translate-x-1/2"
        >
          <div className="glass-surface flex flex-col gap-2 border-teal-300/40 p-3" data-testid="live-test-panel">
            <div className="flex items-center gap-2">
              <Crosshair className="h-4 w-4 text-emerald-400" />
              <span className="text-[13px] font-semibold text-white">Live Test — trace one address</span>
              <button onClick={() => { setLiveTestOpen(false); setLtResult(null); }} className="ml-auto grid h-11 w-11 place-items-center rounded-full text-white/60 hover:text-white" aria-label="Close"><X className="h-4 w-4" /></button>
            </div>
            <div className="grid grid-cols-[1fr_1fr_44px_72px] gap-1.5">
              <input value={ltAddr.address} onChange={e => setLtAddr({ ...ltAddr, address: e.target.value })} placeholder="123 Main St" className="h-11 rounded-lg bg-white/10 px-2.5 text-[13px] text-white placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-emerald-400/50" />
              <input value={ltAddr.city} onChange={e => setLtAddr({ ...ltAddr, city: e.target.value })} placeholder="City" className="h-11 rounded-lg bg-white/10 px-2.5 text-[13px] text-white placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-emerald-400/50" />
              <input value={ltAddr.state} onChange={e => setLtAddr({ ...ltAddr, state: e.target.value.toUpperCase().slice(0, 2) })} placeholder="NC" className="h-11 rounded-lg bg-white/10 px-1 text-center text-[13px] text-white placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-emerald-400/50" />
              <input value={ltAddr.zip} onChange={e => setLtAddr({ ...ltAddr, zip: e.target.value })} placeholder="ZIP" className="h-11 rounded-lg bg-white/10 px-2 text-[13px] text-white placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-emerald-400/50" />
            </div>
            <button disabled={ltRunning || ltAddr.address.trim().length < 3} onClick={() => void runLiveTest()} data-testid="live-test-run" className="h-11 rounded-lg bg-emerald-500 text-[13px] font-bold text-[#04241f] transition hover:bg-emerald-400 disabled:opacity-50">
              {ltRunning ? <Loader2 className="mx-auto h-4 w-4 animate-spin" /> : "Run Live Test (fresh mint · no cache)"}
            </button>
            {ltResult && (ltResult.stages ? (
              <div className="max-h-[42vh] space-y-1 overflow-y-auto">
                {ltResult.stages.map((s: any, i: number) => (
                  <div key={i} className="rounded-lg bg-white/[0.05] p-2">
                    <div className="flex items-center gap-1.5"><span className={`h-1.5 w-1.5 shrink-0 rounded-full ${s.ok ? "bg-emerald-400" : "bg-red-400"}`} /><span className="text-[11px] font-semibold text-white">{s.stage}</span></div>
                    <div className="mt-0.5 break-words font-mono text-[10px] text-white/55">{s.detail}</div>
                  </div>
                ))}
                <div className={`rounded-lg p-2 text-[11px] font-semibold ${ltResult.checked ? (ltResult.wouldSaveLead ? "bg-emerald-500/15 text-emerald-300" : "bg-sky-500/15 text-sky-300") : ltResult.pendingAuth ? "bg-amber-500/15 text-amber-300" : "bg-red-500/15 text-red-300"}`}>
                  {ltResult.checked ? `Checked ✓ — ${ltResult.classification}${ltResult.wouldSaveLead ? " → fresh lead" : ""}` : ltResult.pendingAuth ? "PENDING_AUTH — token/auth flow failed after retry. Address kept for retry, NOT a no-service verdict." : "Not checked — failed at the red stage (infra error, not a no-service verdict)."}
                </div>
              </div>
            ) : (
              <div className="rounded-lg bg-red-500/15 p-2 text-[11px] text-red-300">{ltResult.error || "Failed"}</div>
            ))}
          </div>
        </div>
      )}

      {/* Armed: drag-a-box hint + cancel, in the same bottom-center spot. */}
      {canSubmitScan && scanDrawMode && bottomSlot === "hint" && (
        <div
          style={{ bottom: "calc(env(safe-area-inset-bottom) + 1.25rem)" }}
          className="absolute left-1/2 z-30 flex -translate-x-1/2 items-center gap-2"
        >
          <div
            className="glass-capsule flex h-11 items-center gap-2 border-emerald-300/40 px-4 text-[13.5px] font-semibold text-white"
            data-testid="scan-map-hint"
          >
            <Radar className="h-4 w-4 shrink-0 text-emerald-400" />
            Drag a box over the houses
          </div>
          <button
            type="button"
            onClick={() => {
              setScanDrawMode(false);
              clearDrawBox();
            }}
            data-testid="scan-map-cancel"
            aria-label="Cancel scan-area selection"
            className="glass-capsule grid h-11 w-11 place-items-center text-white/70 transition hover:text-white active:scale-95"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* ── Compact scan sheet (Mobbin pattern) — a bottom-center card that shows
             live progress then the summary. Never a full-screen takeover; the
             map stays visible behind it. ── */}
      {/* Minimized: the scan keeps running server-side; a small pill restores the sheet. */}
      {scanSheetHidden && bottomSlot === "scan" && (scanning || scanSubmitting) && (
        <button
          type="button"
          onClick={() => setScanSheetHidden(false)}
          style={{ bottom: "calc(env(safe-area-inset-bottom) + 1.25rem)" }}
          className="glass-capsule absolute left-1/2 z-30 flex h-11 -translate-x-1/2 items-center gap-2 border-emerald-300/40 px-4 text-[13px] font-semibold text-white transition active:scale-95"
          data-testid="scan-minimized-pill"
          aria-label="Show scan progress"
        >
          <Loader2 className="h-4 w-4 animate-spin text-emerald-400" />
          {scanSummary && scanSummary.discovered > 0
            ? `Scanning ${scanSummary.checked.toLocaleString()}/${scanSummary.discovered.toLocaleString()}`
            : "Scanning…"}
        </button>
      )}

      {bottomSlot === "scan" &&
        !scanSheetHidden &&
        scanSummary && (
          <div
            style={{ bottom: "calc(env(safe-area-inset-bottom) + 1.25rem)" }}
            className="absolute left-1/2 z-30 w-[min(456px,calc(100vw-24px))] -translate-x-1/2 animate-in fade-in slide-in-from-bottom-2 duration-200"
            data-testid="scan-sheet"
          >
            {/* glass-surface already carries the panel radius (20px), hairline
                border, and shadow — no per-instance overrides, so this sheet
                matches the control cluster / layers / legend surfaces. */}
            <div className="glass-surface px-4 py-3.5">
              {/* Header: state + primary control */}
              <div className="flex items-center gap-2.5">
                {scanning || scanSubmitting ? (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-emerald-400" />
                ) : (
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-semibold leading-tight text-white">
                    {scanSubmitting
                      ? "Starting scan…"
                      : scanning
                        ? "Scanning fiber"
                        : "Scan complete"}
                  </div>
                  <div className="text-[11px] leading-tight tabular-nums text-white/55">
                    {scanSummary.discovered > 0
                      ? `${scanSummary.discovered.toLocaleString()} found · ${scanSummary.checked.toLocaleString()} checked · ${scanSummary.pending.toLocaleString()} pending`
                      : scanning || scanSubmitting
                        ? "Finding addresses via OpenStreetMap…"
                        : "No mapped addresses found here"}
                  </div>
                </div>
                {scanning || scanSubmitting ? (
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => {
                        // Optimistic cancel: flip the machine to `cancelled`
                        // immediately (indicator off at once), then durably
                        // cancel the owned server job so it stops consuming
                        // workers/proxies and is never resumed on next boot.
                        const id = scanState.jobId;
                        dispatchScan({ type: "STOP" });
                        // eslint-disable-next-line no-console
                        console.info("[areaScan] STOP", id);
                        if (id) void discovery.cancel(id).catch(() => {});
                      }}
                      className="h-11 shrink-0 rounded-full px-4 text-[12px] font-semibold text-red-300 transition hover:bg-red-500/10 hover:text-red-200"
                      data-testid="scan-stop"
                    >
                      Stop
                    </button>
                    <button
                      type="button"
                      onClick={() => setScanSheetHidden(true)}
                      aria-label="Minimize scan progress (scan keeps running)"
                      title="Minimize — the scan keeps running"
                      className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-white/55 transition hover:bg-white/10 hover:text-white"
                      data-testid="scan-minimize"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      // Dismiss the terminal summary → machine back to idle, and
                      // clear the outcome sheet. The Scan Map button returns.
                      dispatchScan({ type: "DISMISS" });
                      setScanOutcome(null);
                    }}
                    aria-label="Dismiss scan summary"
                    className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-white/55 transition hover:bg-white/10 hover:text-white"
                    data-testid="scan-dismiss"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>

              {/* Progress bar while running */}
              {(scanning || scanSubmitting) && (
                <div
                  className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/10"
                  role="progressbar"
                  aria-label="Scan progress"
                >
                  <div
                    className={`h-full rounded-full bg-emerald-500 transition-[width] duration-500 ${scanSummary.discovered > 0 ? "" : "animate-pulse"}`}
                    style={{
                      width:
                        scanSummary.discovered > 0
                          ? `${Math.max(4, Math.min(100, Math.round((scanSummary.checked / scanSummary.discovered) * 100)))}%`
                          : "30%",
                    }}
                  />
                </div>
              )}

              {/* Outcome counts (OSM addresses + checked are in the line above):
                  new · still fresh · now active · coming soon · unresolved.
                  ONE hairline-divided strip with single-line labels — the old
                  per-cell tiles wrapped their two-line ALL-CAPS labels unevenly.
                  Short labels carry a title with the full phrase. */}
              <div
                className="mt-3 grid grid-cols-5 divide-x divide-white/[0.08] overflow-hidden rounded-xl border border-white/[0.08] bg-white/[0.04]"
                data-testid="scan-summary"
              >
                {[
                  { label: "New", full: "New leads", value: scanSummary.newLeads, tone: "text-emerald-400" },
                  { label: "Fresh", full: "Still fresh", value: scanSummary.stillFresh, tone: "text-emerald-300" },
                  { label: "Active", full: "Already customers", value: scanSummary.serviceActive, tone: "text-sky-400" },
                  { label: "Soon", full: "Fiber coming soon", value: scanSummary.comingSoon, tone: "text-amber-400" },
                  { label: "Failed", full: "Unresolved — couldn't conclusively check", value: scanSummary.unresolved, tone: "text-white/50" },
                ].map((c) => (
                  <div
                    key={c.label}
                    title={c.full}
                    className="px-1 py-2 text-center"
                  >
                    <div
                      className={`text-[15px] font-semibold leading-none tabular-nums ${c.tone}`}
                    >
                      {c.value.toLocaleString()}
                    </div>
                    <div className="mt-1 whitespace-nowrap text-2xs font-medium uppercase leading-none tracking-wider text-white/45">
                      {c.label}
                    </div>
                  </div>
                ))}
              </div>

              {/* Coverage honesty — if OSM data was thin here, say so rather than
                  imply every property was found. */}
              {!scanning &&
                !scanSubmitting &&
                scanSummary.coverage &&
                ["partial_coverage", "sparse_source_data", "verification_required", "source_unavailable"].includes(
                  String(scanSummary.coverage),
                ) && (
                  <div className="mt-3 flex items-start gap-1.5 rounded-lg bg-amber-500/10 px-2.5 py-1.5 text-[10.5px] leading-snug text-amber-300/90" data-testid="scan-coverage-gap">
                    <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" />
                    <span>
                      OpenStreetMap coverage looks{" "}
                      {String(scanSummary.coverage) === "sparse_source_data" || String(scanSummary.coverage) === "source_unavailable"
                        ? "sparse"
                        : "partial"}{" "}
                      here — some properties may not be mapped yet, so this isn't guaranteed to be every address.
                    </span>
                  </div>
                )}
            </div>
          </div>
        )}

      {/* ── SalesRabbit-style disposition filter bar ─────────────────────────
             A horizontal, scrollable row of status chips over the top of the
             map — "All" + one colored chip per disposition with its live count.
             Tap to filter the pins to that status; tap again (or All) to clear.
             The right inset clears the top-right control cluster on manager
             roles. This is the canvasser's at-a-glance board of where the
             territory stands. ── */}
      {/* Status-chip row — MANAGER surface. On rep phones the top strip is
          passive: the same status filter lives in the bottom legend pill
          (thumb zone), and an active filter shows as the passive indicator
          below instead of a row of top-of-screen touch targets. */}
      {mapReady && leads.length > 0 && !lassoMode && !(isRep && isMobile) && (
        <div
          style={{
            // Same top inset as the floating menu button; the row is 44px tall
            // with centered 36px chips, so chip centers align with the menu.
            top: "calc(env(safe-area-inset-top) + 0.75rem)",
            right: isRep ? 12 : 76,
          }}
          // Starts to the RIGHT of the 44px menu button on phones (it used to
          // start at the screen edge and scroll underneath it, clipping counts
          // behind the button). ≥768px the menu button is hidden → left-3.
          className="absolute left-[60px] md:left-3 z-20 pointer-events-none"
          data-testid="status-filter-bar"
        >
          <div
            className="flex h-11 items-center gap-1.5 overflow-x-auto no-scrollbar pill-row-fade pointer-events-auto pr-3"
            role="tablist"
            aria-label="Filter leads by status"
          >
            <button
              type="button"
              role="tab"
              aria-selected={filterStatus === "all"}
              onClick={() => setFilterStatus("all")}
              data-testid="status-chip-all"
              className={`shrink-0 inline-flex items-center gap-1.5 h-9 pl-3 pr-2.5 rounded-full text-[12.5px] font-semibold whitespace-nowrap transition active:scale-[0.97] ${
                filterStatus === "all"
                  ? "bg-white text-slate-900 shadow"
                  : "glass-surface glass-opaque text-white/85 hover:text-white"
              }`}
            >
              All
              <span
                className={`tabular-nums text-[11px] rounded-full px-1.5 py-0.5 ${filterStatus === "all" ? "bg-slate-900/10 text-slate-900" : "bg-white/10 text-white/70"}`}
              >
                {totalLeadCount}
              </span>
            </button>
            {statusChips.map((c) => {
              const active = filterStatus === c.key;
              return (
                <button
                  key={c.key}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setFilterStatus(active ? "all" : c.key)}
                  data-testid={`status-chip-${c.key}`}
                  title={`${c.label} · ${c.count}`}
                  className={`shrink-0 inline-flex items-center gap-1.5 h-9 pl-2.5 pr-2 rounded-full text-[12.5px] font-semibold whitespace-nowrap transition active:scale-[0.97] glass-surface ${active ? "ring-2" : "glass-opaque text-white/85 hover:text-white"}`}
                  style={
                    active
                      ? {
                          boxShadow: `inset 0 0 0 1px ${c.bg}`,
                          background: `${c.bg}26`,
                          color: "#fff",
                          ["--tw-ring-color" as any]: `${c.bg}80`,
                        }
                      : undefined
                  }
                >
                  <span
                    className="w-2.5 h-2.5 rounded-full shrink-0"
                    style={{ background: c.bg, boxShadow: `0 0 5px ${c.bg}99` }}
                  />
                  {c.label}
                  <span className="tabular-nums text-[11px] rounded-full bg-white/12 px-1.5 py-0.5 text-white/80">
                    {c.count}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Rep phones: PASSIVE top-center filter indicator — display only, zero
          touch targets in the thumb-hostile strip. Renders only while a status
          filter is active; the interactive filter is the bottom legend pill. */}
      {mapReady && isRep && isMobile && !lassoMode && filterStatus !== "all" && (
        <div
          style={{ top: "calc(env(safe-area-inset-top) + 0.75rem)" }}
          className="glass-capsule glass-opaque absolute left-1/2 z-20 flex h-9 -translate-x-1/2 items-center gap-1.5 px-3 pointer-events-none"
          data-testid="rep-filter-indicator"
          aria-live="polite"
        >
          <span
            className="w-2.5 h-2.5 rounded-full shrink-0"
            style={{ background: PIN_COLORS[filterStatus]?.bg ?? "#0d9488" }}
          />
          <span className="text-[12px] font-semibold text-white whitespace-nowrap">
            Showing: {PIN_COLORS[filterStatus]?.label ?? filterStatus} ·{" "}
            {statusCounts[filterStatus] ?? 0}
          </span>
        </div>
      )}

      {/* On mobile: left-3 → right-[68px] so the banner clears the icon cluster
          in the top-right corner. On desktop: centered. */}
      <div
        style={{ top: "calc(env(safe-area-inset-top) + 6.75rem)" }}
        className="absolute left-3 right-[68px] md:top-16 md:left-1/2 md:right-auto md:-translate-x-1/2 md:w-[min(620px,calc(100vw-24px))] z-30 space-y-1.5 pointer-events-none [&>*]:pointer-events-auto"
      >
        {/* Scan Map is a floating button (below) — no armed/drawing hint here.
            Live progress + the summary live in the compact bottom sheet. */}
        {/* Lasso UI moved to a floating bottom action bar inside the map (below) */}

        {canManage && pendingRequests.length > 0 && (
          <div className="glass-surface glass-opaque border-amber-500/40 overflow-hidden">
            <button
              className="w-full flex items-center gap-2 px-3 min-h-[44px] text-[11px] font-medium text-amber-400 hover:bg-amber-500/10"
              onClick={() => setShowTerritoryRequests((v) => !v)}
            >
              <Bell className="w-3 h-3" />
              <span className="flex-1 text-left">
                {pendingRequests.length} territory request
                {pendingRequests.length !== 1 ? "s" : ""}
              </span>
              <span className="text-[10px] text-muted-foreground">
                {showTerritoryRequests ? "▲" : "▼"}
              </span>
            </button>
            {showTerritoryRequests && (
              <div className="px-3 pb-2 space-y-1.5">
                {pendingRequests.map((req) => (
                  <div
                    key={req.id}
                    className="flex flex-wrap items-center gap-2 bg-card/60 rounded px-2 py-1.5 border border-border text-[11px]"
                  >
                    <span className="font-semibold text-foreground flex-1">
                      {req.repName}
                    </span>
                    {req.notes && (
                      <span className="text-muted-foreground italic">
                        "{req.notes}"
                      </span>
                    )}
                    <Button
                      size="sm"
                      className="relative min-h-9 text-[12px] px-3 after:absolute after:-inset-1.5 bg-purple-600 hover:bg-purple-700 text-white"
                      disabled={fulfillRequestMutation.isPending && fulfillRequestMutation.variables?.id === req.id}
                      onClick={() =>
                        fulfillRequestMutation.mutate({
                          id: req.id,
                          action: "fulfilled",
                        })
                      }
                    >
                      Assign
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="relative min-h-9 text-[12px] px-3 after:absolute after:-inset-1.5 text-muted-foreground"
                      disabled={fulfillRequestMutation.isPending && fulfillRequestMutation.variables?.id === req.id}
                      onClick={() =>
                        fulfillRequestMutation.mutate({
                          id: req.id,
                          action: "dismissed",
                        })
                      }
                    >
                      Dismiss
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      {/* /floating banner stack */}

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
            <div
              ref={mapContainer}
              className={isMobile ? "rep-clean-map" : undefined}
              style={{ width: "100%", height: "100%" }}
            />
          </div>

          {!mapReady && !noToken && (
            <div className="absolute inset-0 flex items-center justify-center bg-card/80 z-10">
              <div className="text-center">
                <MapIcon className="w-8 h-8 text-muted-foreground mx-auto mb-2 animate-pulse" />
                <div className="text-sm text-muted-foreground">
                  Loading map…
                </div>
              </div>
            </div>
          )}
          {noToken && (
            <div className="absolute inset-0 flex items-center justify-center bg-card/95 z-10">
              <div className="text-center max-w-xs">
                <MapIcon className="w-10 h-10 text-muted-foreground mx-auto mb-3 opacity-40" />
                <div className="text-sm font-medium mb-1">
                  Mapbox token needed
                </div>
                <div className="text-xs text-muted-foreground">
                  Add MAPBOX_TOKEN to server .env
                </div>
              </div>
            </div>
          )}

          {/* Floating menu — the map is full-bleed (no header/tabs), so this is
              the ONE way back to the rest of the app on mobile. All roles. */}
          <button
            type="button"
            aria-label="Open navigation menu"
            data-testid="map-menu-button"
            onClick={() =>
              window.dispatchEvent(new CustomEvent("hfs:open-menu"))
            }
            style={{ top: "calc(env(safe-area-inset-top) + 0.75rem)" }}
            className="glass-capsule md:hidden absolute left-3 z-30 h-11 w-11 flex items-center justify-center text-white/90 active:scale-[0.97] transform-gpu transition"
          >
            <Menu
              className="w-4.5 h-4.5"
              style={{ width: 18, height: 18 }}
              aria-hidden="true"
            />
          </button>

          {/* First-use empty state — a brand-new org with no leads gets guidance,
              not a blank map over a random town. */}
          {mapReady && !isRep && leads.length === 0 && (
            <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none px-6">
              <div className="glass-surface pointer-events-none max-w-xs text-center p-6">
                <div className="w-12 h-12 rounded-2xl bg-primary/15 border border-primary/25 flex items-center justify-center mx-auto mb-3">
                  <MapIcon className="w-6 h-6 text-primary" />
                </div>
                <p className="text-sm font-semibold text-white">
                  No leads on the map yet
                </p>
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
              status filter still needs a visible, clearable indication. The
              disposition bar above carries that whenever it's on screen, so
              this minimal pill now shows ONLY while the bar is hidden (lasso
              mode) — before, both rendered stacked in the same top strip. */}
          {mapReady && !isRep && leads.length > 0 && filterStatus !== "all" && lassoMode && (
            <div
              style={{ top: "calc(env(safe-area-inset-top) + 0.75rem)" }}
              className="glass-capsule glass-opaque absolute left-[64px] md:left-3 md:top-3 z-10 flex items-center gap-2 pl-3 pr-1.5 min-h-[36px]"
            >
              <span
                className="w-1.5 h-1.5 rounded-full"
                style={{
                  background: PIN_COLORS[filterStatus]?.bg ?? "#0d9488",
                }}
              />
              <span className="text-[11px] font-medium text-white/80">
                {statusCounts[filterStatus] ?? 0}{" "}
                {PIN_COLORS[filterStatus]?.label ?? filterStatus}
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
          {mapReady && searchOpen && (
            <>
              <div
                className="absolute inset-0 z-20"
                onClick={() => {
                  setSearchOpen(false);
                  setSidebarSearch("");
                  searchBtnRef.current?.focus();
                }}
              />
              <div
                role="dialog"
                aria-label="Search locations"
                aria-modal="false"
                // Phone: BOTTOM-anchored above the keyboard — the input sits at
                // the thumb and results grow UPWARD (flex-col-reverse), nearest
                // match closest to the finger. Desktop keeps the top bar.
                className="absolute bottom-[calc(env(safe-area-inset-bottom)+0.75rem)] md:bottom-auto md:top-3 left-3 right-3 md:left-1/2 md:right-auto md:-translate-x-1/2 z-30 md:w-[min(440px,calc(100vw-24px))] flex flex-col-reverse md:flex-col gap-1.5"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/50" />
                  <input
                    ref={searchInputRef}
                    value={sidebarSearch}
                    onChange={(e) => setSidebarSearch(e.target.value)}
                    onKeyDown={(e) => {
                      if (
                        e.key === "Enter" &&
                        canSubmitScan &&
                        sidebarSearch.trim().length >= 3 &&
                        searchMatches.length === 0
                      ) {
                        e.preventDefault();
                        void jumpToAddress(sidebarSearch);
                      }
                    }}
                    placeholder="Search a street or address…"
                    aria-label="Search a street or address"
                    data-testid="map-search"
                    className="glass-surface w-full h-11 rounded-full pl-9 pr-10 text-sm text-white placeholder:text-white/55 focus:outline-none focus:ring-2 focus:ring-teal-400"
                  />
                  <button
                    onClick={() => {
                      setSearchOpen(false);
                      setSidebarSearch("");
                      searchBtnRef.current?.focus();
                    }}
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
                  // Phone: column-reverse puts the BEST match at the bottom,
                  // right above the input — one thumb-length away.
                  <div className="glass-surface glass-opaque overflow-hidden max-h-[min(60vh,360px)] overflow-y-auto flex flex-col-reverse md:flex-col">
                    {searchMatches.map((l) => {
                      // TRUE pin hue/label (pinDisplayState) — a callback door
                      // shows cyan "Callback" here exactly as painted on the map.
                      const ds = pinDisplayState(l);
                      const dsColor = STATE_COLORS[ds];
                      const repName = l.assignedRepId
                        ? repNameById.get(l.assignedRepId)
                        : null;
                      return (
                        <button
                          key={leadKey(l)}
                          onClick={() => {
                            flyToLead(l);
                            setSearchOpen(false);
                            setSidebarSearch("");
                            searchBtnRef.current?.focus();
                          }}
                          className="w-full flex items-center gap-2.5 px-3 py-2.5 min-h-[44px] text-left hover:bg-white/10 transition-colors border-b border-white/[0.08] last:border-0"
                        >
                          <span
                            className="w-2.5 h-2.5 rounded-full flex-shrink-0 mt-0.5"
                            style={{ background: dsColor }}
                            title={STATE_LABELS[ds]}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block text-[13px] text-white font-medium truncate">
                              {l.address}
                            </span>
                            <span className="block text-[11px] text-white/50 truncate">
                              {/* dot carries the hue; label stays neutral (11px raw hues fail AA on glass) */}
                              {l.city}, {l.state} ·{" "}
                              <span className="text-white/70">
                                {STATE_LABELS[ds]}
                              </span>
                              {repName ? ` · ${repName}` : " · Unassigned"}
                            </span>
                          </span>
                          {l.fiberStatus === "new_fiber" && (
                            <span className="text-[9px] font-bold text-teal-400 flex-shrink-0">
                              NEW
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
                {sidebarSearch.trim().length >= 3 &&
                  searchMatches.length === 0 && (
                    <div className="glass-surface glass-opaque overflow-hidden">
                      <div className="px-3 py-2.5 text-[12px] text-white/50">
                        No lead in your org matches “{sidebarSearch}”
                      </div>
                      {canSubmitScan && (
                        <button
                          onClick={() => jumpToAddress(sidebarSearch)}
                          disabled={geocoding}
                          data-testid="map-search-goto"
                          className="w-full flex items-center gap-2 px-3 py-2.5 text-left border-t border-white/10 hover:bg-white/10 text-[13px] text-teal-300 disabled:opacity-60"
                        >
                          <Target className="w-3.5 h-3.5 flex-shrink-0" />
                          {geocoding ? (
                            "Locating…"
                          ) : (
                            <>Go to “{sidebarSearch}” on the map</>
                          )}
                        </button>
                      )}
                    </div>
                  )}
                {sidebarSearch.trim().length > 0 &&
                  sidebarSearch.trim().length < 3 && (
                    <div className="glass-surface glass-opaque px-3 py-2 text-[12px] text-white/55">
                      Keep typing…
                    </div>
                  )}
              </div>
            </>
          )}

          {/* Rep mode has NO persistent map chrome — no HUD, no filter lenses,
              no counters. The map is pins only; every pin state reads by color. */}

          {/* Offline-queue badge — knocks waiting to sync. Hugs the edge on mobile
              rep screens where the Mapbox control stack is hidden. */}
          {useSheet && queueSnap.pendingCount > 0 && (
            <div
              data-testid="knock-pending-badge"
              // Safe-area aware (top-3 sat under the notch). Rep phones: drops
              // BELOW the status-chip row so the two never overlap; other
              // mobile roles: top strip, clear of the ~72px control cluster.
              style={{
                top:
                  isRep && isMobile
                    ? "calc(env(safe-area-inset-top) + 4rem)"
                    : "calc(env(safe-area-inset-top) + 0.75rem)",
              }}
              className={`glass-capsule glass-opaque absolute ${isRep && isMobile ? "right-3" : "right-[76px]"} z-20 flex items-center gap-1.5 h-9 px-3 border-amber-500/40 text-amber-300 text-xs font-semibold tabular-nums`}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
              {queueSnap.pendingCount} to sync
            </div>
          )}

          {/* ── Assign-Area floating action bar — bottom-center, thumb-reachable,
                 clear of the home-indicator gesture zone (safe-area). ── */}
          {lassoMode && bottomSlot === "lasso" && (
            <div
              style={{ bottom: "calc(env(safe-area-inset-bottom) + 1.5rem)" }}
              className="absolute left-1/2 -translate-x-1/2 z-30 max-w-[calc(100vw-24px)]"
            >
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
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              ) : (
                /* Drawn → Sales Rabbit-style: status breakdown (tap chips to
                   refine), then an action on the refined set — Assign owner, Set
                   status, or Save as area. */
                <div className="glass-surface flex flex-col gap-2.5 border-teal-300/40 px-3 py-2.5 animate-in fade-in slide-in-from-bottom-2 duration-200 w-[min(468px,calc(100vw-24px))]">
                  {/* Count + per-status breakdown; tap a chip to include/exclude it */}
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span
                      className="text-[14px] font-bold text-white whitespace-nowrap mr-0.5"
                      aria-live="polite"
                    >
                      {lassoActive.length}
                      <span className="text-white/55 font-medium">
                        /{lassoSelected.length}
                      </span>
                    </span>
                    {lassoSummary.map(({ ds, count }) => {
                      const on = !lassoDisabled.has(ds);
                      return (
                        <button
                          key={ds}
                          type="button"
                          aria-pressed={on}
                          onClick={() =>
                            setLassoDisabled((prev) => {
                              const n = new Set(prev);
                              if (n.has(ds)) n.delete(ds);
                              else n.add(ds);
                              return n;
                            })
                          }
                          data-testid={`lasso-chip-${ds}`}
                          className="h-11 inline-flex items-center gap-1.5 rounded-full pl-2.5 pr-3.5 text-[11px] font-semibold border transition"
                          style={
                            on
                              ? {
                                  background: `${STATE_COLORS[ds]}22`,
                                  borderColor: `${STATE_COLORS[ds]}88`,
                                  color: "#fff",
                                }
                              : {
                                  background: "transparent",
                                  borderColor: "rgba(255,255,255,0.12)",
                                  color: "rgba(255,255,255,0.4)",
                                }
                          }
                        >
                          <span
                            className="w-2 h-2 rounded-full"
                            style={{
                              background: STATE_COLORS[ds],
                              opacity: on ? 1 : 0.4,
                            }}
                          />
                          {STATE_LABELS[ds]} {count}
                        </button>
                      );
                    })}
                  </div>

                  {/* Action switcher */}
                  <div className="flex items-center gap-1 rounded-full bg-white/10 p-0.5">
                    {(
                      [
                        ["assign", "Assign"],
                        ["status", "Status"],
                        ["area", "Area"],
                      ] as const
                    ).map(([key, label]) => (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setLassoAction(key)}
                        data-testid={`lasso-action-${key}`}
                        aria-pressed={lassoAction === key}
                        className={`flex-1 h-11 rounded-full text-[12px] font-semibold transition ${lassoAction === key ? "bg-teal-500 text-[#04241f]" : "text-white/70 hover:text-white"}`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>

                  {/* Mode control + Apply + Exit */}
                  <div className="flex items-center gap-2">
                    {lassoAction === "assign" && (
                      <>
                        <select
                          value={lassoRepId}
                          onChange={(e) => setLassoRepId(e.target.value)}
                          data-testid="lasso-rep-select"
                          className="h-11 flex-1 min-w-0 rounded-full bg-white/10 text-white text-[13px] px-3 border-0 focus:outline-none focus:ring-2 focus:ring-teal-400/60"
                        >
                          <option value="" className="text-slate-900">
                            Assign to rep…
                          </option>
                          {team
                            .filter((m) => m.active)
                            .map((m: TeamMember) => (
                              <option
                                key={m.id}
                                value={m.id}
                                className="text-slate-900"
                              >
                                {m.name}
                              </option>
                            ))}
                        </select>
                        <Button
                          disabled={
                            !lassoRepId ||
                            !lassoActiveIds.length ||
                            bulkAssignMutation.isPending
                          }
                          onClick={() =>
                            bulkAssignMutation.mutate({
                              leadIds: lassoActiveIds,
                              repId: Number(lassoRepId),
                            })
                          }
                          data-testid="lasso-assign"
                          className="h-11 rounded-full bg-teal-500 hover:bg-teal-600 text-[#04241f] font-bold text-[13px] px-4 disabled:opacity-40"
                        >
                          {bulkAssignMutation.isPending
                            ? "…"
                            : `Assign ${lassoActiveIds.length}`}
                        </Button>
                      </>
                    )}
                    {lassoAction === "status" && (
                      <>
                        <select
                          value={lassoStatusOutcome}
                          onChange={(e) =>
                            setLassoStatusOutcome(
                              e.target.value as KnockOutcome,
                            )
                          }
                          data-testid="lasso-status-select"
                          className="h-11 flex-1 min-w-0 rounded-full bg-white/10 text-white text-[13px] px-3 border-0 focus:outline-none focus:ring-2 focus:ring-teal-400/60"
                        >
                          {BULK_STATUS_OUTCOMES.map((o) => (
                            <option
                              key={o}
                              value={o}
                              className="text-slate-900"
                            >
                              {OUTCOME_META[o].label}
                            </option>
                          ))}
                        </select>
                        <Button
                          disabled={
                            !lassoActiveIds.length ||
                            bulkStatusMutation.isPending
                          }
                          onClick={() =>
                            bulkStatusMutation.mutate({
                              leadIds: lassoActiveIds,
                              outcome: lassoStatusOutcome,
                            })
                          }
                          data-testid="lasso-set-status"
                          className="h-11 rounded-full bg-teal-500 hover:bg-teal-600 text-[#04241f] font-bold text-[13px] px-4 disabled:opacity-40"
                        >
                          {bulkStatusMutation.isPending
                            ? "…"
                            : `Set ${lassoActiveIds.length}`}
                        </Button>
                      </>
                    )}
                    {lassoAction === "area" && (
                      <>
                        <input
                          type="text"
                          value={lassoName}
                          onChange={(e) => setLassoName(e.target.value)}
                          maxLength={60}
                          data-testid="lasso-area-name"
                          placeholder={
                            lassoRepId
                              ? `"${team.find((m) => m.id === Number(lassoRepId))?.name ?? "Rep"}'s area"`
                              : "Area name…"
                          }
                          className="h-11 w-[116px] rounded-full bg-white/10 text-white text-[13px] px-3 border-0 placeholder:text-white/55 focus:outline-none focus:ring-2 focus:ring-teal-400/60"
                        />
                        <select
                          value={lassoRepId}
                          onChange={(e) => setLassoRepId(e.target.value)}
                          data-testid="lasso-area-rep-select"
                          className="h-11 flex-1 min-w-0 rounded-full bg-white/10 text-white text-[13px] px-3 border-0 focus:outline-none focus:ring-2 focus:ring-teal-400/60"
                        >
                          <option value="" className="text-slate-900">
                            Rep…
                          </option>
                          {team
                            .filter((m) => m.active)
                            .map((m: TeamMember) => (
                              <option
                                key={m.id}
                                value={m.id}
                                className="text-slate-900"
                              >
                                {m.name}
                              </option>
                            ))}
                        </select>
                        <Button
                          disabled={!lassoRepId || assignAreaMutation.isPending}
                          onClick={() =>
                            assignAreaMutation.mutate({
                              polygon: lassoPoints,
                              repId: Number(lassoRepId),
                              name: lassoName,
                            })
                          }
                          data-testid="lasso-assign"
                          className="h-11 rounded-full bg-teal-500 hover:bg-teal-600 text-[#04241f] font-bold text-[13px] px-4 disabled:opacity-40"
                        >
                          {assignAreaMutation.isPending ? "…" : "Save"}
                        </Button>
                      </>
                    )}
                    <button
                      onClick={exitLasso}
                      className="w-11 h-11 rounded-full flex items-center justify-center text-white/70 hover:text-white hover:bg-white/10 transition-colors flex-shrink-0"
                      title="Exit"
                      data-testid="lasso-exit"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>

                  {lassoAction === "area" && (
                    <span className="text-[10.5px] text-white/45 leading-tight">
                      Area assigns every house in the loop + saves a colored
                      territory. The refine chips apply to Assign &amp; Status.
                    </span>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ── Territory detail panel — opens when you tap a region ── */}
          {canAssign &&
            selectedTerritoryId != null &&
            (() => {
              const t = territories.find((x) => x.id === selectedTerritoryId);
              if (!t) return null;
              const prog = territoryProgress.find((p) => p.id === t.id);
              const status = (t as any).status ?? "active";
              const repIds = (() => {
                try {
                  const a = JSON.parse((t as any).assigneeIds || "[]");
                  return Array.isArray(a) && a.length
                    ? a
                    : status === "unassigned" || status === "reclaimed"
                      ? []
                      : [t.repId];
                } catch {
                  return [t.repId];
                }
              })();
              const teamNames = Object.fromEntries(
                team.map((m) => [m.id, m.name]),
              );
              const isPool = status === "unassigned" || status === "reclaimed";
              return (
                <div className="absolute top-16 left-3 z-30 animate-in fade-in slide-in-from-left-2 duration-200">
                  <div className="relative">
                    <button
                      onClick={() => setSelectedTerritoryId(null)}
                      className="glass-capsule glass-opaque absolute -top-2 -right-2 z-10 w-9 h-9 text-white/70 hover:text-white flex items-center justify-center"
                      title="Close"
                      aria-label="Close territory panel"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                    <TerritoryDetailPanel
                      territory={{
                        id: t.id,
                        name: t.name,
                        status,
                        repIds,
                        color: t.color,
                        leadCount: prog?.total ?? 0,
                        workedCount: prog?.knocked,
                      }}
                      currentUser={{ role: user?.role ?? "rep" }}
                      teamNames={teamNames}
                      progress={
                        prog
                          ? {
                              total: prog.total,
                              verifiedWorkedLeads: prog.verifiedWorkedLeads,
                              areaWorkedPct: prog.areaWorkedPct,
                              verified: prog.verified,
                              needsReview: prog.needsReview,
                              invalid: prog.invalid,
                              avgDistanceM: prog.avgDistanceM,
                              maxAllowedDistanceM: prog.maxAllowedDistanceM,
                            }
                          : undefined
                      }
                      onReclaim={
                        !isPool && canManage
                          ? () =>
                              setReclaimMenuId(
                                reclaimMenuId === t.id ? null : t.id,
                              )
                          : undefined
                      }
                      onRename={(name) =>
                        renameTerritoryMutation.mutate({ id: t.id, name })
                      }
                      onViewHistory={() => setActivityTerritoryId(t.id)}
                    />
                    {/* Assign-to-next-rep for unassigned/reclaimed areas */}
                    {isPool && (
                      <div className="mt-2 w-72 rounded-xl border border-border bg-card p-3">
                        <div className="text-[11px] font-semibold text-foreground mb-1.5">
                          Assign this area to the next rep
                        </div>
                        <select
                          data-testid="assign-next-rep"
                          defaultValue=""
                          onChange={(e) => {
                            if (e.target.value)
                              assignTerritoryMutation.mutate({
                                id: t.id,
                                repId: Number(e.target.value),
                              });
                          }}
                          className="w-full h-9 bg-secondary border border-border rounded-lg px-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                        >
                          <option value="">Choose a rep…</option>
                          {team
                            .filter((m) => m.active)
                            .map((m) => (
                              <option key={m.id} value={m.id}>
                                {m.name}
                              </option>
                            ))}
                        </select>
                      </div>
                    )}
                    {/* Inline reclaim 3-mode chooser (reuses the same mutation) */}
                    {reclaimMenuId === t.id && !isPool && (
                      <div
                        className="mt-2 w-72 rounded-xl border border-border bg-card p-2 flex flex-col gap-1"
                        data-testid={`panel-reclaim-menu-${t.id}`}
                      >
                        <button
                          data-testid="reclaim-mode-return_to_pool"
                          onClick={() =>
                            reclaimMutation.mutate({
                              id: t.id,
                              mode: "return_to_pool",
                            })
                          }
                          className="text-left text-xs text-foreground hover:bg-secondary rounded px-2 py-1.5"
                        >
                          ↩ Return leads to pool{" "}
                          <span className="text-muted-foreground">
                            (default)
                          </span>
                        </button>
                        <button
                          onClick={() =>
                            reclaimMutation.mutate({
                              id: t.id,
                              mode: "keep_leads",
                            })
                          }
                          className="text-left text-xs text-foreground hover:bg-secondary rounded px-2 py-1.5"
                        >
                          Reclaim area only{" "}
                          <span className="text-muted-foreground">
                            (keep leads)
                          </span>
                        </button>
                        <select
                          defaultValue=""
                          onChange={(e) => {
                            if (e.target.value)
                              reclaimMutation.mutate({
                                id: t.id,
                                mode: "reassign",
                                newRepId: Number(e.target.value),
                              });
                          }}
                          className="bg-secondary border border-border rounded px-2 py-1.5 text-xs text-foreground"
                        >
                          <option value="">Reassign to rep…</option>
                          {team
                            .filter((m) => m.active && m.id !== t.repId)
                            .map((m) => (
                              <option key={m.id} value={m.id}>
                                {m.name}
                              </option>
                            ))}
                        </select>
                      </div>
                    )}
                  </div>
                </div>
              );
            })()}

          {/* Territory activity History drawer (opened from the card's View Activity) */}
          {activityTerritoryId != null && (
            <TerritoryActivityDrawer
              territoryId={activityTerritoryId}
              onClose={() => setActivityTerritoryId(null)}
            />
          )}

          {/* ── ICON CONTROL CLUSTER — top-right, one coherent column. Every tool
                 is icon-only while inactive: magnifier · lasso · scan · layers.
                 44px targets, tooltips, aria, keyboard, active/disabled states.
                 The map stays uncluttered; panels open on demand. ── */}
          {mapReady && (
            <div
              className="absolute top-3 right-3 z-30 flex flex-col items-end"
              style={{ paddingTop: "env(safe-area-inset-top)" }}
              data-testid="map-control-cluster"
            >
              {/* One coherent glass panel — the icons read as a single instrument,
                 not four disconnected buttons. Each glyph is transparent until
                 active; the panel supplies the surface, blur, and lift. */}
              <div className="glass-surface flex flex-col gap-1 p-1.5">
                {/* Phones get the bottom-right Search FAB instead (thumb zone) —
                    same state, same focus-restore ref, one rendered at a time. */}
                {!isMobile && (
                  <MapIconBtn
                    icon={<Search className="w-5 h-5" />}
                    label="Search leads &amp; places"
                    testid="ctl-search"
                    active={searchOpen}
                    btnRef={searchBtnRef}
                    disclosure="dialog"
                    onClick={() => {
                      setSearchOpen((o) => !o);
                      setLayersOpen(false);
                      setLeadsOpen(false);
                    }}
                  />
                )}
                <MapIconBtn
                  icon={<List className="w-5 h-5" />}
                  label="Leads in view"
                  testid="ctl-leads"
                  active={leadsOpen}
                  btnRef={leadsBtnRef}
                  disclosure="region"
                  onClick={() => {
                    setLeadsOpen((o) => !o);
                    setSearchOpen(false);
                    setLayersOpen(false);
                  }}
                />
                {canAssign && (
                  <MapIconBtn
                    icon={<Lasso className="w-5 h-5" />}
                    label={
                      lassoMode
                        ? "Cancel area selection"
                        : "Select an area (lasso)"
                    }
                    testid="ctl-lasso"
                    active={lassoMode}
                    tone="teal"
                    onClick={() => {
                      if (lassoMode) {
                        exitLasso();
                      } else {
                        exitLasso();
                        setAddMode(false); // draw tools and add-mode are mutually exclusive
                        setLassoMode(true);
                        setSearchOpen(false);
                        setLayersOpen(false);
                      }
                    }}
                  />
                )}
                {/* Scan Map is a dedicated floating button (bottom-center),
                    not a control-cluster icon — see the Scan Map FAB below. */}
                {!isRep && (
                  <>
                    <div
                      className="glass-hairline mx-1 my-0.5"
                      aria-hidden="true"
                    />
                    <MapIconBtn
                      icon={<Layers className="w-5 h-5" />}
                      label="Map layers & style"
                      testid="ctl-layers"
                      active={layersOpen}
                      btnRef={layersBtnRef}
                      disclosure="menu"
                      onClick={() => {
                        setLayersOpen((o) => !o);
                        setSearchOpen(false);
                      }}
                    />
                  </>
                )}
              </div>

              {/* Layers popover — a group of switches + basemap radios (NOT a
                  role=menu, which would promise a keyboard menu model we don't
                  implement). Each control is a real button operable by Tab. */}
              {layersOpen && (
                <div
                  className="glass-surface absolute top-0 right-14 w-[172px] p-2.5 text-white"
                  role="group"
                  aria-label="Map layers and style"
                  data-testid="layers-popover"
                >
                  <div className="text-[10px] uppercase tracking-wider text-white/40 font-semibold mb-1.5">
                    Layers
                  </div>
                  {[
                    {
                      key: "leads",
                      label: "Leads",
                      on: showLeads,
                      toggle: () => setShowLeads((v) => !v),
                    },
                    ...(canAssign
                      ? [
                          {
                            key: "terr",
                            label: "Territories",
                            on: showTerritories,
                            toggle: () => setShowTerritories((v) => !v),
                          },
                        ]
                      : []),
                  ].map((l) => (
                    <button
                      key={l.key}
                      onClick={l.toggle}
                      data-testid={`layer-${l.key}`}
                      role="switch"
                      aria-checked={l.on}
                      aria-label={`${l.label} layer`}
                      className="w-full flex items-center justify-between min-h-[44px] py-1.5 text-[12.5px] text-white/90 hover:text-white"
                    >
                      <span>{l.label}</span>
                      <span
                        className={`w-8 h-4 rounded-full transition-colors relative ${l.on ? "bg-primary" : "bg-white/25"}`}
                      >
                        <span
                          className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all ${l.on ? "left-4" : "left-0.5"}`}
                        />
                      </span>
                    </button>
                  ))}
                  <div className="text-[10px] uppercase tracking-wider text-white/40 font-semibold mt-2 mb-1.5 pt-2 border-t border-white/10">
                    Basemap
                  </div>
                  <div className="grid grid-cols-3 gap-1">
                    {(
                      [
                        ["satellite", "Satellite"],
                        ["streets", "Street"],
                        ["dark", "Dark"],
                      ] as const
                    ).map(([mode, label]) => (
                      <button
                        key={mode}
                        onClick={() => setMapStyleMode(mode)}
                        data-testid={`mapmode-${mode}`}
                        disabled={!mapReady}
                        aria-pressed={mapStyleMode === mode}
                        aria-label={`${label} basemap`}
                        title={label}
                        className={`text-[10px] min-h-[44px] rounded-lg transition-colors ${mapStyleMode === mode ? "bg-primary text-white font-semibold" : "bg-white/10 text-white/80 hover:bg-white/20"}`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Locate-me FAB — EVERY role. Now that the map opens on your location
              with the blue dot (Apple/Google-Maps behavior), everyone gets the
              one-tap "recenter on me" thumb target too. Bottom-right. */}
          {mapReady && (
            <button
              onClick={() => {
                // This explicit user action starts a new camera intent. Any
                // search/pan/zoom that follows increments the generation and
                // invalidates the delayed iOS fallback below.
                const locateRequestGeneration = cameraGenerationRef.current + 1;
                cameraGenerationRef.current = locateRequestGeneration;
                // Primary path: the GeolocateControl enters ACTIVE_LOCK (blue dot +
                // live follow); each fix then drives the smooth follow-camera in the
                // geolocate handler, so the map tracks the rep like Apple/Google Maps.
                try {
                  geolocateRef.current?.trigger();
                } catch {}
                // Fallback for iOS standalone, where the control's state machine can
                // stall (the dot never appears): grab a direct fix in the SAME user
                // gesture — that keeps the permission prompt valid — but DEFER the
                // recenter and only do it if the control failed to engage.
                // CRITICAL: a live dot means the control is in ACTIVE_LOCK; an
                // untagged moveCamera here would fire a user-style movestart that
                // knocks the control straight to BACKGROUND and kills follow (the
                // "it doesn't track, it just jumps once and drifts off" bug). So we
                // recenter ourselves ONLY when there is no dot (control stalled).
                captureFieldFix(8000)
                  .then((fix) => {
                    if (fix.repLat == null || fix.repLng == null) return;
                    writeCachedFix(fix.repLat, fix.repLng, Date.now());
                    setTimeout(() => {
                      const m = mapRef.current;
                      // A real fix means the control engaged (we draw our own puck now, so
                      // there is no ".mapboxgl-user-location-dot" to probe). Only recenter
                      // ourselves when it truly stalled — never yank an engaged follow.
                      if (
                        !m ||
                        firstFixSeenRef.current ||
                        cameraGenerationRef.current !== locateRequestGeneration
                      )
                        return;
                      moveCamera(m, {
                        center: [fix.repLng, fix.repLat],
                        zoom: STREET_ZOOM,
                        duration: 900,
                        essential: true,
                      });
                    }, 1200);
                  })
                  .catch(() => {});
              }}
              aria-label="Center on my location"
              data-testid="locate-me"
              style={{
                height: 52,
                width: 52,
                // Rides the knock sheet's measured peek height so Locate stays
                // reachable above the sheet lip instead of buried behind it.
                bottom:
                  bottomSlot === "knock" && sheetPeekPx
                    ? `calc(env(safe-area-inset-bottom) + ${sheetPeekPx + 12}px)`
                    : "calc(env(safe-area-inset-bottom) + 2rem)",
                boxShadow: "var(--glass-shadow-1)",
              }}
              className="absolute right-3 z-20 rounded-full ring-1 ring-inset ring-white/[0.18] flex items-center justify-center active:scale-[0.97] transform-gpu transition-transform bg-primary text-white hover:bg-primary/90"
            >
              <LocateFixed className="w-6 h-6" />
            </button>
          )}

          {/* ── Add-lead FAB — team_lead+ (matches POST /api/leads permission).
                 Toggles tap-a-house: tap a rooftop → reverse-geocode → property
                 card → add. Stacked ABOVE the locate FAB (bottom-right). ── */}
          {mapReady && canSubmitScan && bottomSlot !== "knock" && (
            <button
              onClick={() => setAddMode((v) => !v)}
              aria-label={
                addMode ? "Cancel scan mode" : "Scan a house for fiber"
              }
              aria-pressed={addMode}
              data-testid="add-lead-fab"
              style={{
                height: 52,
                width: 52,
                bottom: "calc(env(safe-area-inset-bottom) + 6rem)",
                boxShadow: "var(--glass-shadow-1)",
              }}
              className={`absolute right-3 z-20 rounded-full ring-1 ring-inset flex items-center justify-center active:scale-[0.97] transform-gpu transition ${addMode ? "bg-orange-500 text-white ring-white/20" : "bg-primary text-white ring-white/[0.18] hover:bg-primary/90"}`}
            >
              {tapResolving ? (
                <Loader2 className="w-6 h-6 animate-spin" />
              ) : addMode ? (
                <Radar className="w-6 h-6" />
              ) : (
                <Plus className="w-6 h-6" />
              )}
            </button>
          )}

          {/* ── Search FAB — MOBILE ONLY, bottom-right stack above the Add FAB.
                 The top-right cluster button hides on phones; this is the same
                 toggle in thumb reach, opening the bottom-anchored search. ── */}
          {mapReady && isMobile && bottomSlot !== "knock" && (
            <button
              ref={searchBtnRef}
              onClick={() => {
                setSearchOpen((o) => !o);
                setLayersOpen(false);
                setLeadsOpen(false);
              }}
              aria-label="Search leads &amp; places"
              aria-pressed={searchOpen}
              data-testid="search-fab"
              style={{
                height: 52,
                width: 52,
                bottom: `calc(env(safe-area-inset-bottom) + ${canAssign ? "9.5rem" : "6rem"})`,
                boxShadow: "var(--glass-shadow-1)",
              }}
              className={`absolute right-3 z-20 rounded-full ring-1 ring-inset flex items-center justify-center active:scale-[0.97] transform-gpu transition ${searchOpen ? "bg-teal-500 text-[#04241f] ring-white/20" : "glass-capsule glass-opaque text-white/85 ring-white/[0.18]"}`}
            >
              <Search className="w-6 h-6" />
            </button>
          )}

          {/* Scan-a-house hint — shown while scan mode is ARMED (sticky: it stays
              armed across scans so a rep can walk a street door after door).
              Full-height segments, 44px targets. */}
          {mapReady && canSubmitScan && addMode && bottomSlot === "hint" && (
            <div
              className="absolute left-1/2 -translate-x-1/2 z-30 glass-surface glass-opaque flex items-stretch overflow-hidden text-[12.5px] text-white/85"
              style={{ bottom: "calc(env(safe-area-inset-bottom) + 5.5rem)" }}
              data-testid="tap-hint"
            >
              <div className="flex items-center gap-2 pl-3.5 pr-2 py-2 min-h-11">
                <Radar className="w-4 h-4 text-orange-400 shrink-0" />
                <span className="font-medium whitespace-nowrap">
                  Tap houses to scan for fiber
                </span>
              </div>
              {canAssign && (
                <button
                  className="min-h-11 px-3 font-semibold text-teal-300 hover:text-teal-200 hover:bg-white/[0.06] border-l border-white/10 transition"
                  data-testid="tap-hint-type-it"
                  onClick={() => {
                    setAddMode(false);
                    setAddLeadInitial({});
                  }}
                >
                  Type it
                </button>
              )}
              <button
                className="min-h-11 w-11 grid place-items-center text-white/60 hover:text-white hover:bg-white/[0.06] border-l border-white/10 transition"
                aria-label="Cancel scan mode"
                data-testid="tap-hint-cancel"
                onClick={() => setAddMode(false)}
              >
                <X className="w-4 h-4" />
              </button>
            </div>
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
              style={{
                height: 52,
                bottom: "calc(env(safe-area-inset-bottom) + 2rem)",
                boxShadow: "var(--glass-shadow-1)",
              }}
              className="glass-capsule glass-opaque absolute left-3 z-20 flex items-center gap-2 px-4 text-white font-semibold text-[14px] active:scale-[0.97] transform-gpu transition-transform"
            >
              <Navigation
                className="w-4.5 h-4.5 text-teal-300"
                style={{ width: 18, height: 18 }}
              />
              Next door
            </button>
          )}

          {/* Pin legend + filter — bottom left, ALL ROLES (the rep's status
                 filter lives here in the thumb zone; the manager panel adds
                 rep-select + assigned areas). Collapsed to a quiet dot-strip
                 by default; one tap expands. LONG-PRESS re-applies the last
                 status filter without opening the panel. Reps: anchored above
                 the Next-door pill. */}
          {mapReady && leads.length > 0 && !legendOpen && bottomSlot !== "knock" && (
            <button
              onClick={() => {
                if (legendLongPressFired.current) {
                  legendLongPressFired.current = false;
                  return; // long-press already acted — swallow the click
                }
                setLegendOpen(true);
              }}
              onPointerDown={() => {
                legendLongPressFired.current = false;
                if (legendLongPressTimer.current) clearTimeout(legendLongPressTimer.current);
                legendLongPressTimer.current = setTimeout(() => {
                  const last = lastFilterStatusRef.current;
                  if (!last) return;
                  legendLongPressFired.current = true;
                  setFilterStatus((cur) => (cur === last ? "all" : last));
                  try { navigator.vibrate?.(10); } catch { /* no haptics */ }
                }, 500);
              }}
              onPointerUp={() => {
                if (legendLongPressTimer.current) clearTimeout(legendLongPressTimer.current);
              }}
              onPointerLeave={() => {
                if (legendLongPressTimer.current) clearTimeout(legendLongPressTimer.current);
              }}
              data-testid="legend-collapsed"
              aria-label="Open legend and status filter"
              style={{
                bottom: `calc(env(safe-area-inset-bottom) + ${isRep ? "5.75rem" : "2rem"})`,
              }}
              className="glass-capsule absolute left-3 z-10 flex items-center gap-1.5 h-11 px-3 active:scale-[0.97] transform-gpu transition"
            >
              {Object.values(PIN_COLORS).map((pin, i) => (
                <span
                  key={i}
                  className="w-2 h-2 rounded-full"
                  style={{ background: pin.bg }}
                />
              ))}
              {(filterStatus !== "all" || filterRep !== "all") && (
                <span className="ml-1 text-[10px] font-semibold text-teal-200">
                  filtered
                </span>
              )}
            </button>
          )}
          {mapReady && legendOpen && bottomSlot !== "knock" && (
            <div
              style={{
                bottom: `calc(env(safe-area-inset-bottom) + ${isRep ? "5.75rem" : "2rem"})`,
                maxHeight: "min(60vh, 460px)",
              }}
              className="glass-surface absolute left-3 p-3 z-10 min-w-[170px] max-w-[240px] overflow-y-auto"
            >
              {/* Rep filter — moved here from the (removed) top bar */}
              {canAssign && (
                <div className="mb-2.5">
                  <span className="block text-[10px] text-white/40 uppercase tracking-wider font-semibold mb-1">
                    Rep
                  </span>
                  <select
                    value={filterRep}
                    onChange={(e) => setFilterRep(e.target.value)}
                    data-testid="map-filter-rep"
                    title="Show only leads for a rep"
                    className="w-full h-11 bg-white/10 border border-white/20 rounded-lg px-1.5 text-[12px] text-white focus:outline-none focus:ring-1 focus:ring-teal-400"
                  >
                    <option value="all">All reps</option>
                    <option value="unassigned">
                      Unassigned ({repLeadCounts.unassigned})
                    </option>
                    {team.map((m: TeamMember) => (
                      <option key={m.id} value={String(m.id)}>
                        {m.name} ({repLeadCounts.counts.get(m.id) ?? 0})
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] text-white/40 uppercase tracking-wider font-semibold">
                  Filter by status
                </span>
                <span className="flex items-center gap-2">
                  {filterStatus !== "all" && (
                    <button
                      onClick={() => setFilterStatus("all")}
                      className="relative text-[10px] text-teal-400 hover:text-teal-300 after:absolute after:-inset-3"
                    >
                      Clear
                    </button>
                  )}
                  <button
                    onClick={() => setLegendOpen(false)}
                    data-testid="legend-collapse"
                    aria-label="Collapse legend"
                    className="relative w-8 h-8 -my-1.5 inline-flex items-center justify-center rounded-lg text-white/70 hover:text-white hover:bg-white/10 text-sm leading-none after:absolute after:-inset-1.5"
                  >
                    ×
                  </button>
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
                    style={{
                      background: isActive ? pin.bg + "22" : "transparent",
                    }}
                  >
                    {legendGlyphs[status] ? (
                      <img
                        src={legendGlyphs[status]}
                        alt=""
                        aria-hidden="true"
                        className="w-[18px] h-[18px] flex-shrink-0 -my-0.5"
                        style={{
                          filter: isActive
                            ? `drop-shadow(0 0 4px ${pin.bg})`
                            : "none",
                        }}
                      />
                    ) : (
                      <span
                        className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                        style={{
                          background: pin.bg,
                          boxShadow: isActive ? `0 0 6px ${pin.bg}` : "none",
                        }}
                      />
                    )}
                    <span
                      className="text-[12px] flex-1"
                      style={{
                        color: isActive ? pin.bg : "#94a3b8",
                        fontWeight: isActive ? 700 : 400,
                      }}
                    >
                      {pin.label}
                    </span>
                    <span
                      className="text-[11px] tabular-nums"
                      style={{ color: count > 0 ? "#e2e8f0" : "#64748b" }}
                    >
                      {count}
                    </span>
                  </button>
                );
              })}
              {/* Rep basemap switch — reps had no Layers button (top-right is
                  manager chrome), so satellite↔streets lives here. Streets is
                  also the lighter GPU basemap on old phones. */}
              {isRep && (
                <div className="pt-2 mt-1 border-t border-white/10">
                  <span className="block text-[10px] text-white/40 uppercase tracking-wider font-semibold mb-1">
                    Basemap
                  </span>
                  <div className="flex items-center gap-1 rounded-full bg-white/10 p-0.5">
                    {(
                      [
                        ["satellite", "Satellite"],
                        ["streets", "Streets"],
                      ] as const
                    ).map(([key, label]) => (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setMapStyleMode(key)}
                        aria-pressed={mapStyleMode === key}
                        data-testid={`rep-basemap-${key}`}
                        className={`flex-1 h-11 rounded-full text-[12px] font-semibold transition ${mapStyleMode === key ? "bg-teal-500 text-[#04241f]" : "text-white/70 hover:text-white"}`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {canAssign && territories.length > 0 && (
                <div className="pt-2 mt-1 border-t border-white/10">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[10px] text-white/40 uppercase tracking-wider font-semibold">
                      Assigned areas
                    </span>
                    <button
                      onClick={() => setShowTerritories((v) => !v)}
                      className="relative text-[10px] text-white/50 hover:text-white/80 after:absolute after:-inset-3"
                    >
                      {showTerritories ? "Hide" : "Show"}
                    </button>
                  </div>
                  {territories.map((t) => {
                    const prog = territoryProgress.find((p) => p.id === t.id);
                    const status = (t as any).status ?? "active";
                    const isUnassigned =
                      status === "unassigned" || status === "reclaimed";
                    const color = isUnassigned
                      ? "#94a3b8"
                      : colorForRep(t.repId);
                    const repName = isUnassigned
                      ? "Unassigned"
                      : (team.find((m) => m.id === t.repId)?.name ?? t.name);
                    return (
                      <div key={t.id} className="mb-1.5 group">
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            data-testid={`territory-row-${t.id}`}
                            aria-label={`Open ${t.name} territory details`}
                            onClick={() => setSelectedTerritoryId(t.id)}
                            className="flex min-w-0 min-h-11 flex-1 items-center gap-2 rounded-lg px-1 text-left hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-400"
                          >
                            <span
                              className="w-2.5 h-2.5 rounded-full flex-shrink-0 border border-white/20"
                              style={{ background: color }}
                            />
                            <span className="text-[11px] truncate text-white/85">
                              {repName}
                            </span>
                            {status !== "active" && (
                              <span className="text-[9px] uppercase tracking-wide text-white/40">
                                {status}
                              </span>
                            )}
                            {prog && (
                              <span className="ml-auto text-[10px] text-white/50 tabular-nums">
                                {prog.knocked}/{prog.total}
                              </span>
                            )}
                          </button>
                          {canAssign && isUnassigned && (
                            <button
                              onClick={() =>
                                setReclaimMenuId(
                                  reclaimMenuId === t.id ? null : t.id,
                                )
                              }
                              aria-label={`Assign ${repName}'s area to a rep`}
                              className="relative opacity-100 sm:opacity-0 sm:group-hover:opacity-100 text-teal-400 w-9 h-9 inline-flex items-center justify-center rounded hover:bg-white/10 after:absolute after:-inset-1.5"
                              data-testid={`assign-${t.id}`}
                            >
                              ＋
                            </button>
                          )}
                          {canManage && !isUnassigned && (
                            <button
                              onClick={() =>
                                setReclaimMenuId(
                                  reclaimMenuId === t.id ? null : t.id,
                                )
                              }
                              aria-label={`Reclaim ${repName}'s area`}
                              className="relative opacity-100 sm:opacity-0 sm:group-hover:opacity-100 text-amber-400 w-9 h-9 inline-flex items-center justify-center rounded hover:bg-white/10 after:absolute after:-inset-1.5"
                              data-testid={`reclaim-${t.id}`}
                            >
                              ↩
                            </button>
                          )}
                          {canManage && (
                            // Two-tap destructive confirm: first tap arms
                            // "Sure?" (3s revert), second tap deletes. A stray
                            // thumb can no longer erase an area in one hit.
                            <button
                              onClick={() => {
                                if (confirmDeleteId === t.id) {
                                  setConfirmDeleteId(null);
                                  deleteTerritoryMutation.mutate(t.id);
                                } else {
                                  armDeleteConfirm(t.id);
                                }
                              }}
                              aria-label={
                                confirmDeleteId === t.id
                                  ? `Confirm deleting ${repName}'s area`
                                  : `Delete ${repName}'s area`
                              }
                              className={
                                confirmDeleteId === t.id
                                  ? "relative h-9 px-2 inline-flex items-center justify-center rounded-lg bg-red-500/20 text-red-300 text-[11px] font-bold after:absolute after:-inset-1.5"
                                  : "relative opacity-100 sm:opacity-0 sm:group-hover:opacity-100 text-red-400/80 hover:text-red-400 w-9 h-9 inline-flex items-center justify-center rounded hover:bg-white/10 after:absolute after:-inset-1.5"
                              }
                            >
                              {confirmDeleteId === t.id ? "Sure?" : "×"}
                            </button>
                          )}
                        </div>
                        {prog && prog.total > 0 && (
                          <div className="h-1 rounded-full bg-white/10 mt-0.5 overflow-hidden">
                            <div
                              className="h-full rounded-full"
                              style={{
                                width: `${prog.pct}%`,
                                background: color,
                              }}
                            />
                          </div>
                        )}
                        {/* Assign-to-next-rep chooser for reclaimed/unassigned areas */}
                        {reclaimMenuId === t.id && isUnassigned && (
                          <div
                            className="mt-1 ml-4 bg-white/[0.06] border border-white/[0.08] rounded-lg p-1.5"
                            data-testid={`assign-menu-${t.id}`}
                          >
                            <select
                              data-testid={`assign-select-${t.id}`}
                              defaultValue=""
                              onChange={(e) => {
                                if (e.target.value) {
                                  assignTerritoryMutation.mutate({
                                    id: t.id,
                                    repId: Number(e.target.value),
                                  });
                                  setReclaimMenuId(null);
                                }
                              }}
                              className="w-full bg-white/10 text-white text-[10px] rounded-lg px-1 py-1 border border-white/20"
                            >
                              <option value="" className="text-slate-900">
                                Assign to next rep…
                              </option>
                              {team
                                .filter((m) => m.active)
                                .map((m) => (
                                  <option
                                    key={m.id}
                                    value={m.id}
                                    className="text-slate-900"
                                  >
                                    {m.name}
                                  </option>
                                ))}
                            </select>
                          </div>
                        )}
                        {/* Reclaim 3-mode chooser (owned areas only) */}
                        {reclaimMenuId === t.id && !isUnassigned && (
                          <div
                            className="mt-1 ml-4 flex flex-col gap-1 bg-white/[0.06] border border-white/[0.08] rounded-lg p-1.5"
                            data-testid={`reclaim-menu-${t.id}`}
                          >
                            <button
                              onClick={() =>
                                reclaimMutation.mutate({
                                  id: t.id,
                                  mode: "return_to_pool",
                                })
                              }
                              className="text-left text-[10px] text-white/80 hover:text-white px-1.5 py-1 rounded hover:bg-white/10"
                            >
                              ↩ Return leads to pool{" "}
                              <span className="text-white/40">(default)</span>
                            </button>
                            <button
                              onClick={() =>
                                reclaimMutation.mutate({
                                  id: t.id,
                                  mode: "keep_leads",
                                })
                              }
                              className="text-left text-[10px] text-white/80 hover:text-white px-1.5 py-1 rounded hover:bg-white/10"
                            >
                              Reclaim area only{" "}
                              <span className="text-white/40">
                                (keep leads)
                              </span>
                            </button>
                            <div className="flex items-center gap-1">
                              <select
                                data-testid={`reassign-select-${t.id}`}
                                defaultValue=""
                                onChange={(e) => {
                                  if (e.target.value)
                                    reclaimMutation.mutate({
                                      id: t.id,
                                      mode: "reassign",
                                      newRepId: Number(e.target.value),
                                    });
                                }}
                                className="flex-1 bg-white/10 text-white text-[10px] rounded-lg px-1 py-1 border border-white/20"
                              >
                                <option value="" className="text-slate-900">
                                  Reassign to rep…
                                </option>
                                {team
                                  .filter((m) => m.active && m.id !== t.repId)
                                  .map((m) => (
                                    <option
                                      key={m.id}
                                      value={m.id}
                                      className="text-slate-900"
                                    >
                                      {m.name}
                                    </option>
                                  ))}
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
              onPeekHeight={setSheetPeekPx}
            />
          )}
        </div>

        {/* ── Leads-in-view panel — right rail (desktop) / slide-in drawer (phone).
               A flex SIBLING of the map div on ≥1024px: opening it shrinks the
               map, whose ResizeObserver fires resize → moveend → the viewport
               bounds (and therefore the list) self-correct.
               ALL ROLES: the rep List button used to be a dead control — the
               panel behind it was manager-gated. Row actions inside remain
               capability-gated. ── */}
        {(
          <LeadsInViewPanel
            open={leadsOpen}
            onClose={() => {
              setLeadsOpen(false);
              leadsBtnRef.current?.focus();
            }}
            leads={inViewLeads}
            totalOnMap={mapTotalLeads.length}
            orgTotal={mapPinData?.total ?? 0}
            filtered={mapTotalLeads.length !== (mapPinData?.total ?? 0)}
            showLeadsLayer={showLeads}
            onShowLeadsLayer={() => setShowLeads(true)}
            onRowTap={onLeadsRowTap}
            onFitAll={fitAllLeads}
            onClearFilters={() => {
              setFilterStatus("all");
              setFilterRep("all");
            }}
            repNameById={repNameById}
          />
        )}

        {/* Property card — opens from tapping a scanned dot or a house (tap mode).
            View + Copy for everyone; "Add as lead" only for team_lead+ (canAssign,
            matching POST /api/leads). */}
        <LeadCard
          property={cardProperty}
          canAdd={canAssign}
          onClose={() => setCardProperty(null)}
          onAddLead={(p) => {
            setCardProperty(null);
            setAddLeadInitial(p);
          }}
          onOpen={(id) => {
            setCardProperty(null);
            (window as any).__openLeadSheet?.(id);
          }}
        />
        {/* Manual add-lead form — prefilled from a tap/dot or blank ("Type it"). */}
        <AddLeadSheet
          initial={addLeadInitial}
          onClose={() => setAddLeadInitial(null)}
          onCreated={(leadId) => {
            // Confirmation the rep can SEE: select the new/existing pin, fly the
            // camera to it (padded above the knock sheet), pop the ring flash.
            // The pin itself is already in the map cache (optimistic insert or
            // the existing feature), so this is pure camera + selection work.
            setSelectedLeadId(leadId);
            try {
              ringFlashRef.current = {
                at: performance.now(),
                color: STATE_COLORS.unworked,
              };
            } catch { /* flash is best-effort */ }
            // The lead may not be in `leadById` yet (cache write settles this
            // tick) — retry the fly on the next frame with the fresh map data.
            requestAnimationFrame(() => {
              const pin =
                leadById.get(leadId) ??
                (qc.getQueryData<any>(["/api/leads/map"])?.pins ?? []).find(
                  (p: MapPin) => p.id === leadId,
                );
              if (pin?.lat && pin?.lng) flyToLead(pin);
            });
          }}
        />
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
  icon,
  label,
  testid,
  onClick,
  active = false,
  disabled = false,
  tone = "primary",
  badge,
  btnRef,
  disclosure,
}: {
  icon: React.ReactNode;
  label: string;
  testid: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  tone?: "primary" | "teal" | "orange" | "red";
  badge?: string;
  btnRef?: React.RefObject<HTMLButtonElement | null>;
  // A disclosure OPENS a panel — announce aria-expanded (plus aria-haspopup for
  // dialog/menu; a complementary "region" is neither, so it gets aria-expanded
  // only). Toggles (lasso/scan) omit this and use aria-pressed.
  disclosure?: "dialog" | "menu" | "region";
}) {
  // Active tints use the -600 shades so the white glyph clears the 3:1 non-text
  // contrast floor (WCAG 1.4.11) over map imagery.
  const activeBg =
    tone === "teal"
      ? "bg-teal-600 border-teal-300/70"
      : tone === "orange"
        ? "bg-orange-600 border-orange-300/70"
        : tone === "red"
          ? "bg-red-600 border-red-300/70"
          : "bg-primary border-primary";
  return (
    <div className="relative group">
      <button
        ref={btnRef as any}
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        {...(disclosure === "region"
          ? { "aria-expanded": active }
          : disclosure
            ? { "aria-haspopup": disclosure, "aria-expanded": active }
            : { "aria-pressed": active })}
        data-testid={testid}
        className={[
          "relative h-11 w-11 rounded-xl flex items-center justify-center border transition-all duration-150",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-400 focus-visible:ring-offset-1 focus-visible:ring-offset-black/40",
          "active:scale-95 disabled:opacity-40 disabled:pointer-events-none",
          // Idle icons are transparent — the surrounding glass panel is the
          // surface. Active tools fill with their tone and lift, so the armed
          // tool reads at a glance without any text label.
          active
            ? `${activeBg} text-white shadow-lg`
            : "border-transparent text-white/85 hover:text-white hover:bg-white/10",
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
      <span
        role="tooltip"
        className="glass-opaque pointer-events-none absolute right-full top-1/2 -translate-y-1/2 mr-2 whitespace-nowrap rounded-lg border border-white/10 px-2 py-1 text-[11px] font-medium text-white shadow-lg opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity hidden md:block"
      >
        {label}
      </span>
    </div>
  );
}
