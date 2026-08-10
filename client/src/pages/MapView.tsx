import {
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
  useReducer,
  useDeferredValue,
} from "react";
// mapbox-gl loaded via CDN in index.html — do not bundle
declare const mapboxgl: any;
import { X, Search, LocateFixed, Menu, LassoSelect, Radar, Loader2, Ellipsis, List, Plus, Crosshair, Users, Settings2, Landmark, Tag, Flag, Palette, Undo2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest, apiRequestIdempotent, getStoredSessionId } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useSustained } from "@/hooks/use-sustained";
import { LeadCard, type CardProperty } from "@/components/LeadCard";
import { AddLeadSheet, planExistingLead, type LeadVisibility } from "@/components/AddLeadSheet";
import { reverseGeocode } from "@/lib/reverseGeocode";
import { useAuth } from "@/lib/auth";
import { useIsMobile } from "@/hooks/use-mobile";
import type { TeamMember, Territory } from "@shared/schema";
import { colorForRep } from "@shared/repColors";
import { TerritoryDetailPanel } from "@/components/TerritoryDetailPanel";
import { TerritoryActivityDrawer } from "@/components/TerritoryActivityDrawer";
import { LeadKnockSheet, type SheetLead } from "@/components/LeadKnockSheet";
import { LeadsInViewPanel } from "@/components/LeadsInViewPanel";
import { useKnockLogger } from "@/lib/useKnockLogger";
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
import { toLeadMapStatus } from "@shared/statusConfig";
import {
  saveLeadNote,
  flushPendingNotes,
  type NotePoster,
  type NoteSaveResult,
} from "@/lib/leadNotes";
import {
  PIN_DS_COLOR,
  SELECTED_RING_SPEC,
  SELECTED_RING_FILTER,
  sheetPeekPaddingPx,
  moveCamera,
  STREET_ZOOM,
  pickRepStartCamera,
  readCachedFix,
  writeCachedFix,
  ensureHousenumLayer,
  removeHousenumLayer,
  readPersistedHouseNumbers,
  persistHouseNumbers,
  isSheetDragActive,
  decideAddModeTap,
  createRafCoalescedFlush,
  formatFilterCount,
  persistFilterStatus,
  readPersistedFilterStatus,
  persistMapCamera,
  readPersistedMapCamera,
  ensureDensityLayers,
  LEADS_CLUSTER_SOURCE_SPEC,
  clusterLayerSpecs,
  unclusteredLayerSpecs,
  PIN_DETAIL_MIN_ZOOM,
  DENSITY_SOURCE,
  DENSITY_CIRCLES_LAYER,
  DENSITY_LAYER_IDS,
  GRID_TIER_HIDDEN_LAYER_IDS,
  unclusteredOpacityExpr,
  iconOpacityExpr,
} from "@/lib/mapPins";
import {
  MAP_VIEWPORT_MODE_THRESHOLD,
  MAP_GRID_CACHE_TTL_MS,
  currentFetchWindow,
  keepRegion,
  bboxParam,
  bboxIntersects,
  cameraViewBBox,
  fullFeedEnabled,
  firstUseEmptyStateEnabled,
  viewportNotice,
  mergeViewportPins,
  viewportTierForWindow,
  type TruncationEvidence,
  clampToGridGuard,
  gridCacheKey,
  gridCellForSpan,
  gridCellsToGeoJson,
  sourceFilterToGridTag,
  sourceFilterToMapView,
  type MapGridResponse,
  type ViewportBBox,
} from "@/lib/mapViewport";
import {
  readMapPinsSnapshot,
  writeMapPinsSnapshot,
  pruneMapPinsSnapshots,
  MAP_PINS_SNAPSHOT_DEBOUNCE_MS,
  readPersistedViewportMode,
  writePersistedViewportMode,
  readMapWindowSnapshot,
  writeMapWindowSnapshot,
  pruneMapWindowSnapshots,
} from "@/lib/mapPinsSnapshot";
import {
  LEAD_SOURCE_OPTIONS,
  countLeadsBySource,
  leadMatchesSource,
  persistFilterSource,
  readPersistedFilterSource,
  type LeadSourceFilter,
} from "@/lib/leadSourceFilter";
import {
  createFollowState,
  ingestFix,
  stepFrame,
  filteredLngLat,
} from "@/lib/followCamera";
import { useTabActive } from "@/lib/tabActivity";
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
} from "@/lib/statusIcons";
import {
  reconcileLeadFeatures,
  repColorFor,
  type LeadFeatureCache,
  type LeadRepIdsFn,
} from "@/lib/leadGeoJson";
import {
  haloFeatureProps,
  haloLayerSpecs,
  haloBeforeId,
  repIdsForDoor,
  HALO_LAYER_IDS,
} from "@/lib/leadHalos";
import {
  dedupeVertices,
  simplifyRing,
  validateRing,
  crossesAntimeridian,
  type RingValidationFailure,
} from "@shared/polygonGeometry";
import { territoryPaint, territoryBeforeId, pickUnusedTerritoryColor } from "@/lib/territoryStyle";
import { lockGesturesForDrawing, lockDocumentPullToRefresh, mapGestureTarget } from "@/lib/lassoGestureLock";
import { AreaAssigneeBar } from "@/components/territory/AreaAssigneeBar";
import { resolveTerritoryTap } from "@/lib/territoryPick";
import { TERRITORY_SWATCHES } from "@/components/territory/TerritoryColorPicker";
import {
  subscribeLeadStream,
  createFetchEventSource,
  type LeadStreamEvent,
  type LeadStreamHandle,
} from "@/lib/leadStream";
import { mergePushedPin, pinFromPushedLead } from "@/lib/leadStreamMerge";
import { unpackMapPins } from "@shared/mapPinsWire";
import { LEAD_MARKS, LEAD_MARK_META, type LeadMark } from "@shared/leadMark";
import { useCan } from "@/lib/capabilities";
import { can as roleCan } from "@shared/permissions";
import { resolveCreditedRepId } from "@/features/knocking/savedKnockReconciliation";
import { territoryLabel, detailForZoom } from "@shared/territoryLabel";
import { RepPicker } from "@/components/territory/RepPicker";
import { MapFilterSheet } from "@/components/map/MapFilterSheet";
import { MapViewportNotice } from "@/components/map/MapViewportNotice";
import { MapLensNotice } from "@/components/map/MapLensNotice";
import { MapSettingsSheet } from "@/components/map/MapSettingsSheet";
import { MapLegend } from "@/components/map/MapLegend";
import { FOCUS } from "@/lib/a11y";

// ── Control-rail button grammar — ONE uniform rounded-square style for every
//    top-left map control (SalesRabbit rail). Active = solid primary.
const RAIL_BTN = `relative w-11 h-11 rounded-xl border shadow-sm flex items-center justify-center active:scale-95 transform-gpu transition ${FOCUS}`;
const RAIL_BTN_IDLE = "bg-card/95 border-border text-foreground hover:bg-card";
const RAIL_BTN_ACTIVE = "bg-primary border-primary text-primary-foreground";
import { chaikinSmooth } from "@shared/strokeSmoothing";
import { MAX_ACTIVE_AREAS_PER_REP } from "@shared/territory";
import { StartNextPassDialog } from "@/components/territory/StartNextPassDialog";
import { ReclaimAllDialog } from "@/components/territory/ReclaimAllDialog";
import { FccPurgeDialog } from "@/components/map/FccPurgeDialog";
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
  // Which AREA the door sits in. assignedRepId names one primary, but areas are
  // many-to-many (territories.assignee_ids) — this is the only handle the client
  // has on the full crew, and it is what the per-rep halo resolves against.
  assignedTerritoryId?: number | null;
  leadScore: number;
  leadTag?: string | null;
  freshConfidence?: string | null;
  // FCC/field-verification provenance — the source filter ("Fiber (FCC)" pill
  // row) and the card's verify-at-door chip read these straight off the pin.
  freshSources?: string | null;
  freshConfirmedAt?: string | null;
  carrier?: string | null;
  visited?: boolean;
  knockCount?: number;
  lastOutcome?: string | null;
  lastKnockedAt?: string | null;
  // The server outcome CAS clock (leads.last_outcome_at, or the knock time for
  // legacy rows) — the recency baseline the stream merge orders pushes by.
  // Distinct from lastKnockedAt: a central mark advances this with NO knock.
  lastOutcomeAt?: string | null;
  // Manager triage mark (priority/hold) — shown on the card chip; the stream
  // merge keeps it live so a mark set on one phone reaches the others.
  assignMark?: string | null;
  // Compliance block: the occupant asked us never to return.
  doNotKnock?: boolean;
  // Set by dedupeLeads when >1 record collapsed onto this house (survivor
  // carries every underlying lead id, itself first) so a popup can surface all.
  mergedLeadIds?: string[];
  mergedCount?: number;
}

// Mapbox token is fetched from /api/config/map at runtime — not in bundle

// ── Pin index (id → position) per pins-array identity ───────────────────────
// applyLeadEvent, the central mark, the one-tap add reconcile, and the delete
// path all need "where is lead X in old.pins" inside a setQueryData updater —
// previously an O(n) findIndex/find scan per event at the full-feed pin
// ceiling. A render-derived memo/ref CANNOT serve these updaters: a push
// landing between setQueryData and the next render would read indexes for the
// PREVIOUS array (double-appending a create-then-update burst for a new lead,
// or patching a stale index onto the WRONG lead after a delete's filter).
// Keying the index on the pins array identity itself — built lazily on first
// lookup, WeakMap so it dies with the array — makes staleness structurally
// impossible: a lookup always describes exactly the array being updated.
const PIN_INDEXES = new WeakMap<readonly { id: number }[], Map<number, number>>();
function pinIndexOf(pins: readonly { id: number }[], id: number): number {
  let byId = PIN_INDEXES.get(pins);
  if (!byId) {
    byId = new Map<number, number>();
    for (let i = 0; i < pins.length; i++) {
      const pid = pins[i].id;
      // First occurrence wins — exactly findIndex/find semantics.
      if (!byId.has(pid)) byId.set(pid, i);
    }
    PIN_INDEXES.set(pins, byId);
  }
  return byId.get(id) ?? -1;
}

const ROCKWELL_CENTER: [number, number] = [-80.41, 35.545];

// (The PIN_COLORS legend-dot map left with the floating dot-strip: search rows,
// the leads panel, and the legend's status rows all label pins by the TRUE
// display state — pinDisplayState → STATE_COLORS/STATE_LABELS from
// @shared/knock — which raw leadStatus keys couldn't represent anyway.)

// The status filter is keyed on the pin DISPLAY state — the rep filters what
// they SEE (a yellow Not Home pin) — which leadStatus alone can't express.
// Funnel order for the selector: fresh → worked → closed, extras last.
const FILTER_STATUS_ORDER: PinDisplayState[] = [
  "unworked",
  "follow_up",
  "interested",
  "sold",
  "not_home",
  "not_interested",
  "callback",
  "contacted",
  "already_customer",
];
const FILTERABLE_STATUSES: readonly string[] = FILTER_STATUS_ORDER;

// One GPU symbol layer paints every door from the canonical six-status SVG set.
const STATUS_ICON_LAYER = "lead-status-icons";

// SHAPED GLYPH PINS ARE THE DEFAULT. A door-knocking map is read at arm's length
// in daylight while walking: shape and glyph survive that, a colour-only dot does
// not. The teardrop-vs-arrow silhouette and the $ / door / star / clock inside it
// are how a rep tells a sold house from a not-home one without stopping to
// compare hues — and colour alone fails outright for the ~8% of men with a
// colour-vision deficiency, for whom the sold green and the prospect green are
// the same dot.
//
// This shipped briefly as colour-only dots and the glyphs were reported missing
// within the day. NEW_FIELD_MAP=0 still opts a device OUT (the dots path is
// intact and tested); anything else, including unset, gets the glyphs.
function newFieldMap(): boolean {
  try {
    return localStorage.getItem("NEW_FIELD_MAP") !== "0";
  } catch {
    return true; // storage blocked (private mode) → the legible default
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
  setLayerZoomRange?(layer: string, minzoom: number, maxzoom: number): void;
}

// Circle pins across the full zoom range — the state whenever the glyph-icon
// layer is off or unavailable.
function showCirclePinsFullRange(map: FieldIconMap): void {
  try {
    map.setLayerZoomRange?.("lead-unclustered", 0, 24);
    map.setLayoutProperty("lead-unclustered", "visibility", "visible");
  } catch {
    /* not ready */
  }
}

async function addStatusIconLayer(map: FieldIconMap): Promise<void> {
  if (!newFieldMap()) {
    showCirclePinsFullRange(map);
    return;
  }
  if (!map.getLayer(STATUS_ICON_LAYER)) {
    try {
      await registerPinImages(map);
    } catch {
      showCirclePinsFullRange(map);
      return;
    }
    try {
      map.addLayer({
        id: STATUS_ICON_LAYER,
        type: "symbol",
        source: "leads-cluster",
        filter: ["!", ["has", "point_count"]],
        minzoom: PIN_DETAIL_MIN_ZOOM,
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
      showCirclePinsFullRange(map);
      return;
    }
  }
  if (map.getLayer(STATUS_ICON_LAYER)) {
    try {
      // Hand off, don't hide: circles carry z<12 (isolated leads have no
      // cluster to represent them there), icons carry 12+. setLayerZoomRange
      // is absent only on the minimal test doubles — they fall back to the
      // visibility flip, which those tests assert directly.
      if (map.setLayerZoomRange) {
        map.setLayerZoomRange("lead-unclustered", 0, PIN_DETAIL_MIN_ZOOM);
        map.setLayoutProperty("lead-unclustered", "visibility", "visible");
      } else {
        map.setLayoutProperty("lead-unclustered", "visibility", "none");
      }
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
/** Stable empty index for the closed-search case — a fresh [] each render would
 *  defeat the memo it feeds. */
const EMPTY_SEARCH_INDEX: { l: MapPin; hay: string }[] = [];

// ── Merging a pushed lead into a map pin ─────────────────────────────────────
// The merge itself lives in @/lib/leadStreamMerge (pure, unit-tested): it
// mirrors the server's outcome-recency CAS — pushed lastOutcomeAt vs the pin's
// own lastOutcomeAt (the same clock applyKnockOutcomeCas orders writes by) —
// and never spreads the narrower LeadStreamPin wholesale over a MapPin, which
// would erase the joined knockCount / freshConfidence / carrier columns.

const SEARCH_RESULT_SOURCE = "search-result";
const SEARCH_RESULT_HALO_LAYER = "search-result-halo";
const SEARCH_RESULT_POINT_LAYER = "search-result-point";
const SCAN_RESULTS_SOURCE = "scan-results";
const SCAN_RESULTS_CLUSTER_LAYER = "scan-results-clusters";
const SCAN_RESULTS_COUNT_LAYER = "scan-results-count";
const SCAN_RESULTS_POINT_LAYER = "scan-results-points";

// ── Lasso ring cleanup ────────────────────────────────────────────────────────────
/**
 * Douglas-Peucker tolerance for a freehand lasso stroke, in DEGREES.
 *
 * simplifyRing's invariant is that every point of the input lies within this
 * distance of the output boundary, so the constant is a hard ceiling on how far
 * the saved edge can move from the drawn one. 1e-5° is ~1.11 m of latitude
 * (~0.91 m of longitude at 35°N, where this product operates).
 *
 * Why that is below "visible": the stroke is sampled at MIN_PX_DIST = 5 screen
 * pixels, so the input itself has a ~5 px noise floor. Territories are drawn
 * between roughly z14 and z18, where a pixel is ~15 m down to ~0.5 m — a 1.11 m
 * ceiling is well under a tenth of a pixel at z14, half a pixel at z16, and
 * still barely two pixels at the deepest zoom anyone draws a whole area at.
 * In every case it is a fraction of the 5 px quantum the finger was digitised
 * at, so it can only collapse points that are already redundant along a
 * near-straight run; a corner the manager actually turned deviates far more
 * than a metre from its chord and Douglas-Peucker keeps it. The boundary does
 * not visibly move — the vertex count does.
 *
 * Going bigger (1e-4°, ~11 m) would start rounding off the notch a manager cuts
 * around a park, which is exactly the shape-fidelity guarantee territories are
 * sold on. Going smaller stops removing the noise it exists to remove.
 */
const LASSO_SIMPLIFY_TOLERANCE_DEG = 1e-5;

/**
 * What a rejected ring says to the person who drew it.
 *
 * validateRing reports a string union aimed at code. A manager standing on a
 * driveway needs to know what to do differently, so each reason maps to a plain
 * sentence — never the raw enum, which reads as a crash.
 */
const LASSO_RING_REJECTION: Record<
  RingValidationFailure,
  { title: string; description: string }
> = {
  "too-few-points": {
    title: "That shape wasn't a loop",
    description:
      "Fewer than three distinct corners came through, so there is no area to save. Draw a slower loop right around the ground you want.",
  },
  degenerate: {
    title: "That's a line, not an area",
    description:
      "The stroke went out and came back along itself without enclosing any ground. Draw a loop that curves around and closes.",
  },
  "self-intersecting": {
    title: "That loop crosses over itself",
    description:
      "Where the line crosses, there is no single inside - some doors would land outside the area you can see. Draw one clean loop without crossing back over your own line.",
  },
  "too-small": {
    title: "That area is too small to assign",
    description:
      "The loop came out under 100 m² - about the size of a single garage. Zoom out a little and draw around the doors you want to hand over.",
  },
};

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
  // Tools menu — the ONE floating button every secondary tool lives behind.
  const [toolsMenuOpen, setToolsMenuOpen] = useState(false);
  const toolsMenuBtnRef = useRef<HTMLButtonElement | null>(null);

  // (The pan/zoom auto-hide for the control rail was removed: its
  // interact-start transition hid the rail with NO pending reshow, so any
  // swallowed end event — e.g. a camera animation finished by a
  // geolocateSource-tagged follow move — left the rail, lasso included, stuck
  // at opacity-0. The rail is primary chrome and stays visible.)

  // Map style toggle
  const [mapStyleMode, setMapStyleMode] = useState<
    "dark" | "satellite" | "streets"
  >("satellite");
  const [showLeads, setShowLeads] = useState(true); // control-rail layer toggle
  // House numbers — OFF by default (owner's minimal-map directive); opt-in from
  // the Map settings sheet, persisted like the status filter. The ref lets the
  // once-bound init/style.load handlers read the live preference.
  const [showHouseNums, setShowHouseNums] = useState<boolean>(() =>
    readPersistedHouseNumbers(),
  );
  const showHouseNumsRef = useRef(showHouseNums);
  showHouseNumsRef.current = showHouseNums;
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

  // Filter — restored from the rep's last selection (localStorage), so a rep
  // working "just Not Home doors" keeps that lens across launches.
  const [filterStatus, setFilterStatus] = useState<string>(() =>
    readPersistedFilterStatus(FILTERABLE_STATUSES),
  );
  useEffect(() => {
    persistFilterStatus(filterStatus);
  }, [filterStatus]);
  // Source filter ("Fiber (FCC)") — a SECOND, independent lens that ANDs with
  // the status filter: both apply at once. Own localStorage key; the status
  // key above is never touched by it.
  const [filterSource, setFilterSource] = useState<LeadSourceFilter>(() =>
    readPersistedFilterSource(),
  );
  useEffect(() => {
    persistFilterSource(filterSource);
  }, [filterSource]);
  // The lens as a ref: fetch callbacks (count probe, full feed, bbox window,
  // density grid) read the CURRENT lens without re-subscribing. Declared with
  // the state so every query below can close over it.
  const filterSourceRef = useRef(filterSource);
  filterSourceRef.current = filterSource;
  // SalesRabbit-style bottom sheets — the Filters sheet is THE filter surface
  // (the old always-on pill/chip row is gone); Settings owns basemap + layers.
  const [mapFilterOpen, setMapFilterOpen] = useState(false);
  const [mapSettingsOpen, setMapSettingsOpen] = useState(false);

  // Selected lead (highlighted after a search fly-to)
  const [selectedLeadId, setSelectedLeadId] = useState<number | null>(null);
  // Live peek height the open lead card measures + publishes — re-pads the map
  // camera when the sheet's real content height lands (varies per lead).
  const [sheetPeekPx, setSheetPeekPx] = useState<number | null>(null);
  const [legendOpen, setLegendOpen] = useState(false); // manager legend: collapsed dot-strip by default
  // Rep pin-colors key — dismissible, opt-in from the More menu (never at rest).
  const [pinKeyOpen, setPinKeyOpen] = useState(false);
  const [geocoding, setGeocoding] = useState(false); // street "go to" lookup in flight
  const [sidebarSearch, setSidebarSearch] = useState("");

  // Colored territory regions visibility toggle (rendered from saved territories)
  const [showTerritories, setShowTerritories] = useState(true);

  // Assign-Area (freehand draw) mode
  const [lassoMode, setLassoMode] = useState(false);
  // Live mirror of the imperative follow-camera `following` flag, so the locate
  // FAB can show whether tracking is actually engaged (aria-pressed + ring).
  const [followEngaged, setFollowEngaged] = useState(false);
  // ── Add-lead / tap-a-house ──────────────────────────────────────────────────
  // addMode: a single map tap reverse-geocodes a rooftop into an address.
  // cardProperty: the property card sheet (from a tapped house or a scanned dot).
  // addLeadInitial: opens the manual add-lead form, prefilled from card/tap/blank.
  const [addMode, setAddMode] = useState(false);
  const [cardProperty, setCardProperty] = useState<CardProperty | null>(null);
  const [addLeadInitial, setAddLeadInitial] =
    useState<Partial<CardProperty> | null>(null);
  // (No tap-resolving state: one-tap add is optimistic — the pin IS the
  // feedback, so add mode never shows a spinner or "finding…" phase.)
  const [lassoPoints, setLassoPoints] = useState<[number, number][]>([]);
  const [lassoSelected, setLassoSelected] = useState<MapPin[]>([]);
  const [lassoRepId, setLassoRepId] = useState("");        // "Change Ownership" — one rep, one bulk move
  // The AREA crew, in pick order: the first is the primary. Separate from
  // lassoRepId above because they answer different questions — "hand this
  // selection to somebody" is one rep by definition, "who walks this ground"
  // is not.
  const [lassoRepIds, setLassoRepIds] = useState<number[]>([]);
  const toggleLassoRep = (repId: number) =>
    setLassoRepIds((prev) => (prev.includes(repId) ? prev.filter((r) => r !== repId) : [...prev, repId]));
  const [lassoName, setLassoName] = useState(""); // optional custom area name; blank → "<Rep>'s area"
  // Areas under an overlapping tap, awaiting "which one did you mean?".
  const [territoryPickIds, setTerritoryPickIds] = useState<number[]>([]);
  // Which areas are on this viewer's map right now. Read by the tap handler,
  // which is bound once at map init and so cannot close over the memo.
  const visibleTerritoryIdsRef = useRef<Set<number>>(new Set());
  // Colour chosen BEFORE the stroke, and saved with the area. It describes the
  // ground, so it must not follow whoever the area is handed to — which is what
  // the old colorForRep(repId) stamp did.
  const [lassoColor, setLassoColor] = useState<string>(TERRITORY_SWATCHES[0]);
  // The stroke handler is bound once at map init, so it cannot close over
  // lassoColor — it would paint whatever the colour was when the map loaded.
  const lassoColorRef = useRef<string>(TERRITORY_SWATCHES[0]);
  // Sales Rabbit-style refine + action state. `lassoDisabled` = display states the
  // user toggled OUT of the action set (default empty = everything selected).
  // `lassoAction` = which bulk action the panel is showing.
  const [lassoDisabled, setLassoDisabled] = useState<Set<PinDisplayState>>(
    new Set(),
  );
  // Drawing a shape means drawing an AREA. This defaulted to "assign", which is
  // bulk LEAD reassignment and saves no polygon at all — so the ordinary flow
  // (draw a loop, pick a rep, tap the button) moved the doors and created no
  // territory. Nothing appeared on the manager's map or the rep's, because
  // nothing had been created, and the only clue was that "Area" was the fourth
  // tab. The other three actions are still one tap away.
  const [lassoAction, setLassoAction] = useState<"assign" | "status" | "mark" | "area">(
    "area",
  );
  const [lassoStatusOutcome, setLassoStatusOutcome] = useState<KnockOutcome>(
    BULK_STATUS_OUTCOMES[0],
  );
  // Pre-assignment triage mark to apply to the lassoed selection. "" = clear.
  const [lassoMark, setLassoMark] = useState<LeadMark | "">(LEAD_MARKS[0]);
  const lassoLayerRef = useRef<boolean>(false);

  // Sidebar filters
  const [filterRep, setFilterRep] = useState<string>("all"); // "all" | "unassigned" | repId
  // ADMIN ASSIGNMENT VIEW (owner ask 2026-07-26): a map mode where every pin
  // takes its assigned rep's color so managers see at a glance WHO owns each
  // area; legend below lists reps with counts and click-to-filter.
  const [repColorMode, setRepColorMode] = useState<boolean>(false);
  const territoryLayersRef = useRef<string[]>([]);

  const { toast } = useToast();
  const qc = useQueryClient();
  const { user } = useAuth();
  // Keep-alive: this page stays mounted (hidden) after leaving /map. While
  // hidden, every poll below switches off — the tree stays warm for an instant
  // return, but a screen nobody is looking at spends no radio. staleTime makes
  // the return revalidate once, which replaces everything the pause skipped.
  const tabActive = useTabActive();
  // Ref mirror for rAF loops that must see activity changes without re-arming
  // their effects (the selected-ring pulse below reads it per frame).
  const tabActiveRef = useRef(true);
  tabActiveRef.current = tabActive;
  // Re-shown from display:none the GL canvas is stale: the container had zero
  // size while hidden, mapbox's own ResizeObserver fired with 0×0, and nothing
  // repaints when the stage flips back. One resize() against the now-laid-out
  // container restores the render loop; rAF-then-timeout because the stage's
  // display flip and this effect land in the same frame, before layout.
  useEffect(() => {
    if (!tabActive) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const raf = requestAnimationFrame(() => {
      t = setTimeout(() => { try { mapRef.current?.resize?.(); } catch { /* map not up yet — mount effect handles it */ } }, 0);
    });
    return () => { cancelAnimationFrame(raf); if (t) clearTimeout(t); };
  }, [tabActive]);
  // GPS while hidden: a Locate-armed GeolocateControl holds a HighAccuracy
  // watchPosition until map.remove() — which keep-alive never calls. Leaving
  // GPS hot behind a hidden tab drains a field phone, so deactivation pauses
  // an armed watch (trigger() from ACTIVE_LOCK/BACKGROUND stops it) and
  // reactivation re-arms it, restoring the follow experience the rep left on.
  // _watchState is the same private-but-stable field the follow debugger reads.
  const geoPausedByTabRef = useRef(false);
  useEffect(() => {
    const geolocate = geolocateRef.current;
    if (!geolocate) return;
    const watching = ["ACTIVE_LOCK", "BACKGROUND"].includes((geolocate as any)._watchState);
    if (!tabActive && watching) {
      geoPausedByTabRef.current = true;
      try { geolocate.trigger(); } catch { geoPausedByTabRef.current = false; }
    } else if (tabActive && geoPausedByTabRef.current) {
      geoPausedByTabRef.current = false;
      try { geolocate.trigger(); } catch { /* rep can re-tap Locate */ }
    }
  }, [tabActive]);
  const canSubmitScan = useCan("scan.submit");
  // Owned-job isolation: background/nightly discovery jobs must not re-render
  // this 6k-line tree on every count tick — only the scan THIS operator owns
  // may. The ref mirrors scanState.jobId (assigned right after the reducer
  // below); the hook reads it per-event.
  const ownedJobIdRef = useRef<string | null>(null);
  // tabActive: a hidden kept stage must not hold the discovery long-poll open
  // — the hook reconnects (and rehydrates) when the stage is shown again.
  const discovery = useDiscoveryJobs(!!user && canSubmitScan && tabActive, ownedJobIdRef);
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
  // Was a hard-coded admin||manager list, which silently outranked the permission
  // table: team leads gained reclaim/assign server-side but the UI kept hiding
  // every control from them. Ask the same source of truth the API does.
  const canManage = roleCan(user?.role, "assign_territory");
  const canReclaim = roleCan(user?.role, "reclaim_territory");
  const canResetPass = roleCan(user?.role, "reset_territory_pass");
  const canReclaimAll = roleCan(user?.role, "reclaim_all_territories");
  const canDelete = roleCan(user?.role, "delete_territory");
  // Admin, manager, and team lead can carve out areas and assign them to reps.
  const canAssign =
    user?.role === "super_admin" ||
    user?.role === "admin" ||
    user?.role === "manager" ||
    user?.role === "team_lead";

  // Tap-a-house wiring (__tapAddressMode / __onTapAddress) lives BELOW the
  // GeoJSON refs + scheduleClusterSetData it reconciles against — dep arrays
  // are read during render, so referencing them from up here would be a TDZ
  // crash. Search "ONE-TAP OPTIMISTIC ADD".

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
  // Stable handle to the reason-aware existing-lead handler (defined far below).
  // The one-tap __onTapAddress effect lives ABOVE that definition, so it calls
  // through this ref to avoid a temporal-dead-zone reference and to always run
  // the LATEST closure (fresh leadById/cache) without re-registering the effect.
  const openExistingLeadRef = useRef<
    (id: number, address: string, visibility?: LeadVisibility) => void
  >(() => {});

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
    refetchInterval: tabActive ? 30000 : false,
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
      repIds,
      name,
      color,
    }: {
      polygon: [number, number][];
      /** The COMPLETE crew, primary first — an area can be walked by several
       *  reps, and this is the call that creates it. */
      repIds: number[];
      name?: string;
      color?: string;
    }) => {
      const res = await apiRequest("POST", "/api/territories/assign-area", {
        polygon,
        repIds,
        ...(name?.trim() ? { name: name.trim() } : {}),
        // The colour chosen before the stroke. Omitted rather than sent empty so
        // the server's own default still applies for a caller that never picked.
        ...(color ? { color } : {}),
      });
      return res.json() as Promise<{ assigned: number; repNames?: string[]; territory: { repId: number } }>;
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["/api/territories"] });
      qc.invalidateQueries({ queryKey: ["/api/territories/progress"] });
      qc.invalidateQueries({ queryKey: ["/api/leads/map"] });
      qc.invalidateQueries({ queryKey: ["/api/leads"] });
      // Name everyone who just got the ground, not only the primary.
      const names = data.repNames?.length
        ? data.repNames
        : [team.find((m: TeamMember) => m.id === data.territory?.repId)?.name ?? "rep"];
      const who = names.length > 2 ? `${names[0]} +${names.length - 1}` : names.join(" and ");
      toast({
        title: `${data.assigned} leads assigned to ${who} · territory saved`, severity: "success",
      });
      exitLasso();
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  // Lasso "Change Ownership" — reassign the REFINED selection to a rep, without
  // creating a saved territory.
  //
  // Sends the RING, not the ids. Shipping ids capped the lasso twice over: the
  // 64 KB API body limit stopped it around 8,000 doors (as an unexplained
  // network failure, because the parser rejects before the route runs), and the
  // client can only enumerate pins it HOLDS — so past the sampling threshold
  // Assign silently skipped every unsampled door inside the loop. The server
  // resolves the ring itself with the same scoped query, projection and
  // pinDisplayState the map is drawn from. See docs/architecture/BULK_ASSIGNMENT.md.
  const bulkAssignMutation = useMutation({
    mutationFn: async ({
      polygon,
      repId,
      includeStates,
    }: {
      polygon: [number, number][];
      repId: number;
      /** Enabled display states, or undefined when nothing was refined out.
       *  Undefined must mean "every state" rather than "the states my sample
       *  happened to contain", or refining nothing would still drop the doors
       *  the client never received. */
      includeStates?: PinDisplayState[];
    }) => {
      // Idempotent by construction (same rep, same end state), so a connection
      // that dies mid-flight is retried rather than shown to the user.
      const res = await apiRequestIdempotent("POST", "/api/leads/assign-selection", {
        polygon,
        repId,
        ...(includeStates ? { includeStates } : {}),
        // The lens the pins were drawn under, so the server scopes identically.
        ...(sourceFilterToMapView(filterSource) ? { view: sourceFilterToMapView(filterSource) } : {}),
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
        title: `${data.updated} reassigned to ${repName}${data.skipped ? ` · ${data.skipped} skipped (out of scope)` : ""}`,
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
        title: `${data.updated} set to ${label}${data.skipped ? ` · ${data.skipped} skipped (out of scope)` : ""}`,
      });
      exitLasso();
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  // "Mark before assignment" — flag/clear a lassoed pool selection with a
  // priority/hold triage mark so it's ranked before a rep ever gets it.
  const bulkMarkMutation = useMutation({
    mutationFn: async ({ leadIds, mark }: { leadIds: number[]; mark: LeadMark | "" }) => {
      const res = await apiRequest("POST", "/api/leads/bulk-mark", { leadIds, mark: mark || null });
      return res.json();
    },
    onSuccess: (data: { updated: number; skipped: number; mark: LeadMark | null }) => {
      qc.invalidateQueries({ queryKey: ["/api/leads/map"] });
      qc.invalidateQueries({ queryKey: ["/api/leads"] });
      const label = data.mark ? LEAD_MARK_META[data.mark].label : "Cleared";
      toast({
        title: `${data.updated} ${data.mark ? `marked ${label}` : "cleared"}${data.skipped ? ` · ${data.skipped} skipped (out of scope)` : ""}`,
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
  // The refinement, expressed so the SERVER can apply it to doors this client
  // never received. Derived from the canonical state list minus what was toggled
  // off — NOT from the states present in the selection, which would silently
  // exclude every unsampled door in a state the sample happened to miss.
  // Undefined when nothing was refined out, which the server reads as "all".
  const lassoEnabledStates = useMemo<PinDisplayState[] | undefined>(
    () => (lassoDisabled.size
      ? (Object.keys(STATE_COLORS) as PinDisplayState[]).filter((ds) => !lassoDisabled.has(ds))
      : undefined),
    [lassoDisabled],
  );
  const lassoActive = useMemo(
    () => lassoSelected.filter((l) => !lassoDisabled.has(pinDisplayState(l))),
    [lassoSelected, lassoDisabled],
  );
  const lassoActiveIds = useMemo(
    () => lassoActive.map((l) => l.id),
    [lassoActive],
  );
  // A loop was drawn. This is what opens the action panel — NOT whether the loop
  // caught any leads. The panel used to branch on lassoSelected.length, so a loop
  // over ground with no doors in it (exactly what carving fresh territory looks
  // like) left the "Drag a loop around the area" hint up forever: the shape was
  // sitting in lassoPoints with no button anywhere on screen that could save it.
  const lassoDrawn = lassoPoints.length > 0;
  // Assign / Status / Mark all operate on lead IDs and are meaningless with an
  // empty selection. Area needs only the polygon and a rep, so an empty loop
  // resolves to it regardless of which tab was last used — otherwise the panel
  // would open on a tab whose only control is a disabled button.
  const lassoHasLeads = lassoSelected.length > 0;
  const lassoEffectiveAction = lassoHasLeads ? lassoAction : "area";

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

  // Recolour an area. The colour describes the ground, so it is the field a
  // manager is most likely to get wrong on the first pass — and until now it was
  // the one field with no edit path at all. Same PATCH the rename uses.
  const recolorTerritoryMutation = useMutation({
    mutationFn: async ({ id, color }: { id: number; color: string }) => {
      const res = await apiRequest("PATCH", `/api/territories/${id}`, { color });
      return res.json();
    },
    onSuccess: () => {
      // The polygon paints from territories.color, so the map must refetch for
      // the new colour to land; invalidating progress too keeps the panel swatch
      // and the region on screen in step.
      qc.invalidateQueries({ queryKey: ["/api/territories"] });
      qc.invalidateQueries({ queryKey: ["/api/territories/progress"] });
      toast({ title: "Area colour updated" });
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  // The map's two-tap delete. It shares the server default with the Area
  // Console's dialog (repAssignments=clear — the doors lose the area AND the rep
  // the area granted them), sent explicitly so the two surfaces can never drift
  // apart on the strength of a default. The map has no room for the keep/clear
  // choice; that lives in AreaDeleteDialog, on the Areas pages.
  const deleteTerritoryMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("DELETE", `/api/territories/${id}?repAssignments=clear`);
      return res.json() as Promise<{ detached: number; repCleared: number; clearedRepNames: string[] }>;
    },
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ["/api/territories"] });
      qc.invalidateQueries({ queryKey: ["/api/territories/progress"] });
      // The doors just changed hands. Without these the map keeps painting them
      // in the departed rep's colour until something else forces a refetch.
      qc.invalidateQueries({ queryKey: ["/api/leads"] });
      qc.invalidateQueries({ queryKey: ["/api/leads/map"] });
      const freed = result?.repCleared ?? 0;
      toast({
        title: "Area deleted",
        description: freed > 0
          ? `${freed} ${freed === 1 ? "door" : "doors"} unassigned from ${result.clearedRepNames?.join(", ") || "their rep"}.`
          : `${result?.detached ?? 0} ${result?.detached === 1 ? "door" : "doors"} went back to no area.`,
        severity: "success",
      });
    },
    onError: (e: any) => toast({ title: e?.message ?? "Couldn't delete the area", variant: "destructive" }),
  });

  // Mark an area done. POST /complete existed, was permission-tabled, and had
  // ZERO client callers — the panel's Complete button only renders when this
  // handler is passed, and nothing ever passed it, so the scan learning loop's
  // main trigger (recordTerritoryOutcome on completion) was unreachable from
  // the product. Two-tap confirm below, same pattern as delete: completing
  // stamps a field outcome into market memory and shouldn't fire on a mis-tap.
  const completeTerritoryMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/territories/${id}/complete`, {});
      return res.json() as Promise<{ ok: boolean; status: string }>;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/territories"] });
      qc.invalidateQueries({ queryKey: ["/api/territories/progress"] });
      toast({
        title: "Area marked complete",
        description: "Its outcome was recorded for future scan prioritisation.",
        severity: "success",
      });
    },
    onError: (e: any) => toast({
      title: "Couldn't complete the area",
      description: String(e?.message ?? e).slice(0, 160),
      variant: "destructive",
    }),
  });
  // Two-step Complete: first tap arms for 3s ("Sure?"), second commits.
  const [confirmCompleteId, setConfirmCompleteId] = useState<number | null>(null);
  const confirmCompleteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const armCompleteConfirm = (id: number) => {
    if (confirmCompleteTimer.current) clearTimeout(confirmCompleteTimer.current);
    setConfirmCompleteId(id);
    confirmCompleteTimer.current = setTimeout(() => setConfirmCompleteId(null), 3000);
  };
  useEffect(() => () => {
    if (confirmCompleteTimer.current) clearTimeout(confirmCompleteTimer.current);
  }, []);

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
        title: `Area assigned to ${repName} · ${data.assigned} leads linked`, severity: "success",
      });
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  // Reclaim / pull-back an area with one of the 3 modes.
  const [reclaimMenuId, setReclaimMenuId] = useState<number | null>(null);
  // The chooser dies with the panel that opened it. It used to survive: close
  // the panel with the chooser armed, reopen the same area, and the destructive
  // mode menu was already sitting open — stale armed state wearing the clothes
  // of a fresh panel. Selecting a different area (or none) disarms it.
  useEffect(() => {
    setReclaimMenuId(null);
  }, [selectedTerritoryId]);
  // Drives area-label detail (see detailForZoom). Starts at the full level so a
  // first paint before zoomend fires shows the complete label rather than a bare
  // name that then pops into detail.
  const [labelZoom, setLabelZoom] = useState(15);
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
  // Remove ONE rep from an area (the everyday operation reclaim can't express).
  // The panel hides its control unless this handler is passed — which is exactly
  // why the feature was invisible: it was built, tested and shipped, but never
  // wired here, so no user ever saw it.
  const [unassigningRepId, setUnassigningRepId] = useState<number | null>(null);
  const unassignRepMutation = useMutation({
    mutationFn: async ({ id, repId }: { id: number; repId: number }) => {
      const res = await apiRequest("POST", `/api/territories/${id}/unassign`, { repId });
      return res.json();
    },
    onMutate: ({ repId }) => setUnassigningRepId(repId),
    onSettled: () => setUnassigningRepId(null),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/territories"] });
      qc.invalidateQueries({ queryKey: ["/api/territories/progress"] });
      qc.invalidateQueries({ queryKey: ["/api/leads/map"] });
      qc.invalidateQueries({ queryKey: ["/api/leads"] });
    },
    // A failed removal used to end in silence: the chip un-dimmed and nothing
    // said why the rep was still there. Every sibling mutation here reports.
    onError: (e: any) => toast({
      title: "Couldn't remove the rep from this area",
      description: String(e?.message ?? e).slice(0, 160),
      variant: "destructive",
    }),
  });

  // Re-open an area for another sweep.
  const [nextPassTerritoryId, setNextPassTerritoryId] = useState<number | null>(null);
  const [reclaimAllOpen, setReclaimAllOpen] = useState(false);
  // Bulk-remove unworked FCC-imported doors (owner ask) — admin-only dialog,
  // opened from the More menu behind the same gate as reclaim-all.
  const [fccPurgeOpen, setFccPurgeOpen] = useState(false);
  const nextPassMutation = useMutation({
    mutationFn: async ({ id, ...body }: { id: number; territoryAction: string; newRepId?: number; keepPendingCallbacks?: boolean; note?: string }) => {
      const res = await apiRequest("POST", `/api/territories/${id}/next-pass`, body);
      return res.json();
    },
    onSuccess: (data: any) => {
      setNextPassTerritoryId(null);
      qc.invalidateQueries({ queryKey: ["/api/territories"] });
      qc.invalidateQueries({ queryKey: ["/api/territories/progress"] });
      qc.invalidateQueries({ queryKey: ["/api/leads/map"] });
      qc.invalidateQueries({ queryKey: ["/api/leads"] });
      // Server replies { ok, nextPass, leadsReset, leadsFrozen, ... }.
      toast({
        title: data?.nextPass != null ? `Pass ${data.nextPass} started` : "Next pass started",
        description: data?.leadsReset != null
          ? `${data.leadsReset} door${data.leadsReset === 1 ? "" : "s"} re-opened for the next sweep`
          : "Worked doors re-opened for the next sweep",
        severity: "success",
      });
    },
    // Without this a failed reset left the dialog open, the spinner gone, and
    // no explanation — indistinguishable from a button that does nothing.
    onError: (e: any) => toast({
      title: "Couldn't start the next pass",
      description: String(e?.message ?? e).slice(0, 160),
      variant: "destructive",
    }),
  });

  // Multiple reps on one area. /share takes the COMPLETE holder set, so the UI
  // sends who should be on it after the change — not a delta — and the two can
  // never disagree about what "who holds this area" means.
  const [shareTerritoryId, setShareTerritoryId] = useState<number | null>(null);
  const [shareRepIds, setShareRepIds] = useState<number[]>([]);
  const shareMutation = useMutation({
    mutationFn: async ({ id, repIds }: { id: number; repIds: number[] }) => {
      const res = await apiRequest("POST", `/api/territories/${id}/share`, { repIds });
      return res.json();
    },
    onSuccess: () => {
      setShareTerritoryId(null);
      qc.invalidateQueries({ queryKey: ["/api/territories"] });
      qc.invalidateQueries({ queryKey: ["/api/territories/progress"] });
      qc.invalidateQueries({ queryKey: ["/api/leads/map"] });
      qc.invalidateQueries({ queryKey: ["/api/leads"] });
    },
    onError: (e: any) => toast({
      title: "Could not update who works this area",
      description: String(e?.message ?? e).slice(0, 160),
      variant: "destructive",
    }),
  });
  // Escape closes the share dialog like every other modal on this page. Cancel
  // was the ONLY way out before — no scrim tap, no Escape — which on a phone
  // reads as "the dialog is stuck". Locked while the save is committing.
  useEffect(() => {
    if (shareTerritoryId == null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !shareMutation.isPending) setShareTerritoryId(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [shareTerritoryId, shareMutation.isPending]);

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
      toast({ title: `Area reclaimed - ${label}`, severity: "success" });
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });
  // Which reclaim mode is in flight, for per-control pending states: the row
  // the manager tapped shows the spinner; its siblings merely disable. (Also
  // the guard that stops a double-tap firing the reclaim POST twice.)
  const reclaimPendingMode = reclaimMutation.isPending
    ? (reclaimMutation.variables?.mode ?? null)
    : null;

  // Single exit path for the lasso — clears mode, selection, and map layers.
  // Every button/mutation that leaves lasso mode goes through this so no shape
  // or state is ever left behind.
  const exitLasso = useCallback(() => {
    setLassoMode(false);
    setLassoPoints([]);
    setLassoSelected([]);
    setLassoRepId("");
    setLassoRepIds([]);
    setLassoName("");
    setLassoDisabled(new Set());
    setLassoAction("area");
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

  // ── Pin-volume probe → full feed vs viewport (bbox) mode ─────────────────
  // One cheap scoped COUNT(*) decides the loading strategy. At ≤60k pins the
  // ETag'd full feed stays (single fetch, 304 polls — unchanged behaviour);
  // past it the map fetches only the pins inside the current viewport window
  // and merges them into the same query cache. If the probe fails the map
  // falls back to the full feed — never to an empty map.
  // The probe answers for the CURRENT lens: "latest" asks the server for the
  // FILTERED total (?view=latest), so the full-feed-vs-viewport decision
  // compares ~51k against the 60k threshold — one ETag'd feed of filtered
  // pins, exactly the speed win the lens exists for. Keyed by view so a lens
  // switch probes fresh instead of reusing the other view's total.
  const countView = sourceFilterToMapView(filterSource);
  const countQuery = useQuery<{ total: number; hiddenByView?: number }>({
    queryKey: ["/api/leads/map/count", countView ?? "all"],
    queryFn: async () =>
      (await apiRequest("GET", `/api/leads/map/count${countView ? `?view=${countView}` : ""}`)).json(),
    enabled: !!user,
    staleTime: 60_000,
    retry: 1,
  });
  const mapPinCount = countQuery.data;
  // Doors the ACTIVE LENS is suppressing inside this caller's own scope. The
  // lens is a speed tool, but a rep whose assigned FCC-footprint block is
  // filtered out sees a blank street and concludes they were never assigned
  // anything — so whenever the lens hides work, the map says so out loud with
  // one tap to show it.
  const hiddenByLens = countView ? (mapPinCount?.hiddenByView ?? 0) : 0;
  // Dismissal is per-LENS, not permanent: switching lens (or the count moving)
  // is a new fact about the map, and the field should be told again.
  const [lensNoticeDismissedFor, setLensNoticeDismissedFor] = useState<string | null>(null);
  const showLensNotice = hiddenByLens > 0 && lensNoticeDismissedFor !== filterSource;
  // No-waterfall boot: the last probe-CONFIRMED mode, persisted per identity
  // (versioned key, cross-user swept — see lib/mapPinsSnapshot). While the
  // probe is still in flight a returning big-map user runs in viewport mode
  // from this hint, so the first window fetch fires on map ready instead of
  // serializing behind the probe RTT. The probe remains the authority the
  // moment it answers (and on probe FAILURE the hint stands down — the full
  // feed is the never-an-empty-map fallback, exactly as before).
  const persistedViewportModeHint = useMemo(
    () => (user ? readPersistedViewportMode({ tenantId: user.tenantId, userId: user.id, view: countView }) : null),
    [user?.id, user?.tenantId, countView],
  );
  const viewportMode = mapPinCount != null
    ? mapPinCount.total > MAP_VIEWPORT_MODE_THRESHOLD
    : !countQuery.isError && (persistedViewportModeHint ?? false);
  const viewportModeRef = useRef(viewportMode);
  viewportModeRef.current = viewportMode;

  // Teach the NEXT cold open: persist only the probe's real answer (never the
  // hint), and when the answer is full-feed, drop any window snapshot — the
  // window family is meaningless (and would go permanently stale) there.
  useEffect(() => {
    if (!user || mapPinCount == null) return;
    const confirmed = mapPinCount.total > MAP_VIEWPORT_MODE_THRESHOLD;
    writePersistedViewportMode({ tenantId: user.tenantId, userId: user.id, view: countView }, confirmed);
    if (!confirmed) pruneMapWindowSnapshots();
  }, [mapPinCount?.total, user?.id, user?.tenantId, countView]);

  // ── Bulk assign mutation (lasso) ────────────────────────────────────────
  // Fetch ALL map pins from dedicated lean endpoint — only runs after auth is ready
  const { data: mapPinData } = useQuery<{ pins: MapPin[]; total: number; truncated?: boolean }>({
    // ONE cache entry per lens pair is deliberate: the key stays
    // ["/api/leads/map"] so every optimistic update / viewport merge / SSE
    // invalidation targets it unchanged; the lens rides the URL (read from
    // the ref at fetch time) and a lens switch INVALIDATES below, so a stale
    // other-view payload can never serve the new lens past one refetch — and
    // the client-side source predicate keeps the render honest during it.
    queryKey: ["/api/leads/map"],
    queryFn: async () => {
      const view = sourceFilterToMapView(filterSourceRef.current);
      const res = await apiRequest("GET", `/api/leads/map?format=packed${view ? `&view=${view}` : ""}`);
      return unpackMapPins<MapPin>(await res.json());
    },
    // Cold-open first frame: seed the cache from the last session's snapshot
    // (version-keyed + identity-scoped — see lib/mapPinsSnapshot) so pins
    // paint the moment the map can draw, with no fetch in the way…
    initialData: () =>
      readMapPinsSnapshot<MapPin>({ tenantId: user?.tenantId, userId: user?.id }) ?? undefined,
    // …and mark that seed ALREADY STALE so the normal fetch/ETag flow fires
    // immediately and replaces it — the snapshot is a paint hint, never truth.
    initialDataUpdatedAt: 0,
    // Viewport mode never downloads the full feed: the same cache entry is
    // written by the bbox-window merger below, and the optimistic-update
    // paths (knock / assignment / live push) target it unchanged. The gate is
    // the count PROBE, not the derived mode: while the probe is in flight
    // viewportMode is still false, and React Query would not cancel the
    // multi-MB fetch when it flipped — so the full feed stays parked until
    // the probe answers ≤threshold (or fails → today's fallback).
    enabled: fullFeedEnabled({
      signedIn: !!user,
      countIsError: countQuery.isError,
      countTotal: mapPinCount?.total,
    }),
    staleTime: 45_000, // toward the 60s poll — fewer redundant revalidations
    retry: 2,
    // Auto-refresh so leads added out-of-band (a scan, the nightly cron,
    // another rep) appear on the map without a manual reload. The server's
    // DB-derived ETag makes an unchanged poll a cheap 304, so this is nearly
    // free when nothing changed. Paused while the tab is hidden (battery/data),
    // and a return to the tab pulls fresh immediately.
    refetchInterval: tabActive ? 60_000 : false,
    refetchIntervalInBackground: false,
    // Reps flip between the app and the dialer/camera constantly while knocking —
    // a refetch on every return is wasteful; the 60s poll keeps them fresh enough.
    // Managers keep focus-refetch for near-real-time monitoring.
    refetchOnWindowFocus: !isRep,
  });

  // Late-hydration seed: if this hook mounted before auth resolved, the
  // initialData closure above saw no identity and returned nothing. The moment
  // the user lands, seed the still-empty cache from their snapshot and
  // immediately invalidate so the real fetch replaces it — identical contract
  // to the initialData path, one render later.
  useEffect(() => {
    if (!user || viewportMode) return;
    if (qc.getQueryData(["/api/leads/map"]) != null) return; // fetch/seed already won
    const snap = readMapPinsSnapshot<MapPin>({ tenantId: user.tenantId, userId: user.id });
    if (!snap) return;
    qc.setQueryData(["/api/leads/map"], snap);
    void qc.invalidateQueries({ queryKey: ["/api/leads/map"] }); // snapshot is stale by definition
  }, [user?.id, user?.tenantId, viewportMode, qc]);

  // Snapshot writer — debounced after the full feed settles, so the NEXT cold
  // open paints these pins on its first frame. Skipped entirely in viewportMode:
  // a bbox window is a partial slice of the map, and persisting it would paint
  // a misleading sliver somewhere else next launch. writeMapPinsSnapshot itself
  // drops temp negative-id pins and scopes the key by wire version + tenant +
  // user, so a stale version or another account can never replay.
  const snapshotTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!user || viewportMode) return;
    const pins = mapPinData?.pins;
    if (!pins?.length) return;
    const scope = { tenantId: user.tenantId, userId: user.id };
    if (snapshotTimerRef.current) clearTimeout(snapshotTimerRef.current);
    snapshotTimerRef.current = setTimeout(() => {
      snapshotTimerRef.current = null;
      writeMapPinsSnapshot(scope, pins);
    }, MAP_PINS_SNAPSHOT_DEBOUNCE_MS);
    return () => {
      if (snapshotTimerRef.current) clearTimeout(snapshotTimerRef.current);
    };
  }, [mapPinData, user, viewportMode]);

  // The org has outgrown the full feed (the count probe answered > threshold).
  // A persisted full-feed snapshot can never refresh again — viewport mode
  // never writes one — so left in place it would repaint an ever-staler full
  // map on every cold open. Worse, the seed it painted THIS open has no
  // replacement path in viewport mode: the full-feed fetch is disabled, and a
  // bbox merge can only add/replace the ids it fetched — it can never evict a
  // stale seeded row inside the window (sampled windows must not evict — see
  // mergeViewportPins). So on entering viewport mode: drop the stored snapshot,
  // and drop the seed when it is ALL the cache holds (dataUpdatedAt 0 is the
  // initialData stamp — no real fetch ever completed). A full feed that DID
  // complete this session (org crossed the threshold mid-session) is kept:
  // it is fresh data, and the keep-region prune bounds it.
  useEffect(() => {
    if (!viewportMode) return;
    pruneMapPinsSnapshots();
    const state = qc.getQueryState(["/api/leads/map"]);
    if (state && state.data != null && state.dataUpdatedAt === 0) {
      qc.setQueryData(["/api/leads/map"], { pins: [], total: 0 });
    }
  }, [viewportMode, qc]);

  // WINDOW-snapshot seed — instant first paint for viewport-mode cold opens.
  // The full-feed snapshot is banned in viewport mode (and pruned above), which
  // used to leave big-map orgs waiting a network round-trip before ANY pin
  // painted. If the last session persisted a complete fetched window AND the
  // persisted camera (the view the map is about to restore) intersects it,
  // seed the cache with those pins now — born stale by contract: the boot
  // window fetch fires immediately (no debounce — see the moveend effect) and
  // replaces them, evicting any seeded row the complete window disowned
  // (windowSeedRef → mergeViewportPins' evictWindow). A miss on any check just
  // means the old behavior: first paint waits for the fetch.
  const windowSeedRef = useRef<ViewportBBox | null>(null);
  useEffect(() => {
    if (!user || !viewportMode) return;
    const cached = qc.getQueryData(["/api/leads/map"]) as { pins?: MapPin[] } | undefined;
    if (cached?.pins?.length) return; // a fetch (or an earlier seed) already won
    const snap = readMapWindowSnapshot<MapPin>({ tenantId: user.tenantId, userId: user.id });
    if (!snap || !snap.pins.length) return;
    const cam = readPersistedMapCamera();
    if (!cam) return; // no persisted camera → no idea where the map opens
    const view = cameraViewBBox(
      cam.center,
      cam.zoom,
      typeof window !== "undefined" ? window.innerWidth || 390 : 390,
      typeof window !== "undefined" ? window.innerHeight || 844 : 844,
    );
    if (!bboxIntersects(view, snap.window)) return; // last window is elsewhere
    windowSeedRef.current = snap.window;
    qc.setQueryData(["/api/leads/map"], { pins: snap.pins, total: snap.pins.length });
  }, [user?.id, user?.tenantId, viewportMode, qc]);

  // Invalidation bridge: every shared mutation path (saved-knock
  // reconciliation, the dead-knock auto-resolve in useKnockLogger, bulk lasso
  // actions, one-tap add) says "map cache is stale" via
  // invalidateQueries(["/api/leads/map"]). In full-feed mode that refetches;
  // in viewport mode the full-feed query is DISABLED, so the invalidate
  // refetches nothing and an optimistic write that needs pulling back to
  // server truth (e.g. the recolor of a knock that was dropped as
  // undeliverable) would sit wrong until the next pan. Translate the
  // invalidate into a window refetch instead. The 60s grid cache is busted
  // too — an invalidate is a KNOWN write, so the density tier must not serve
  // its freshness window over it (same rule as the SSE/visibility paths).
  useEffect(() => {
    const cache = qc.getQueryCache();
    return cache.subscribe((event: any) => {
      if (!viewportModeRef.current) return;
      if (event?.type !== "updated" || event?.action?.type !== "invalidate") return;
      const key = event.query?.queryKey;
      if (!Array.isArray(key) || key.length !== 1 || key[0] !== "/api/leads/map") return;
      gridCacheRef.current.clear();
      refreshViewportPinsRef.current();
    });
  }, [qc]);

  // ── Viewport (bbox) window loader ─────────────────────────────────────────
  // Active only past MAP_VIEWPORT_MODE_THRESHOLD scoped pins. Fetches the
  // current view + 20% margin (debounced on moveend, in-flight aborted),
  // merges the window into the SAME ["/api/leads/map"] cache entry the full
  // feed writes — so dedupe, filters, the feature reconcile, and every
  // optimistic update path work identically in both modes — and prunes pins
  // outside a 3× keep region so a long session can't accumulate the whole
  // dataset anyway.
  const viewportAbortRef = useRef<AbortController | null>(null);
  const viewportTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // ── Two loading tiers, one map ────────────────────────────────────────────
  // The tier is a pure function of the fetch window (viewportTierForWindow):
  // at/under the 3° pin-tier boundary the pin window below runs (over-dense
  // windows come back as an even server-side sample — truncated:true → the
  // sample chip); past it the density grid (fetchViewportGrid) renders
  // aggregated count bubbles. There is no "zoom in to load pins" dead state:
  // territory is visible at EVERY zoom. React state here is owned by
  // refreshViewportPins (the ONE entry point); both fetch callbacks stay
  // React-state-free by contract (#87) — their only writes are setQueryData +
  // plain refs.
  const [viewportTier, setViewportTier] = useState<"pins" | "grid">("pins");
  const viewportTierRef = useRef<"pins" | "grid">("pins");
  // Handoff guards, one per crossing direction, so NEITHER crossover is ever
  // an empty gap. Set false when the tier flips INTO that tier, true when the
  // tier's first window resolves (inside the fetch callbacks — ref writes,
  // not React state):
  //   grid→pins: pinWindowLandedRef — density bubbles linger until the first
  //     pin window lands.
  //   pins→grid: gridWindowLandedRef — the stale pin clusters stay VISIBLE
  //     until the first grid window lands (and stay on if that fetch FAILS —
  //     a failed first grid fetch must never blank the map).
  const pinWindowLandedRef = useRef(true);
  const gridWindowLandedRef = useRef(true);
  // Layer visibility for the current tier — imperative map-thread work (same
  // category as scheduleClusterSetData), never React state, so the fetch
  // callbacks may call it the moment their data lands:
  //   pins tier: pin clusters visible; density lingers ONLY until the first
  //   pin window lands (pinWindowLandedRef).
  //   grid tier: density shows once its first window has landed
  //   (gridWindowLandedRef); until then the stale pin clusters stay UP — the
  //   crossing paints the old pins, never a blank round-trip, and a failed
  //   first grid fetch leaves those pins on screen instead of nothing.
  const syncViewportTierLayers = useCallback((map: any) => {
    if (!map) return;
    const gridActive = viewportModeRef.current && viewportTierRef.current === "grid";
    const showDensity = viewportModeRef.current && (gridActive ? gridWindowLandedRef.current : !pinWindowLandedRef.current);
    const showPins = !gridActive || !gridWindowLandedRef.current;
    for (const id of DENSITY_LAYER_IDS) {
      try { if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", showDensity ? "visible" : "none"); } catch {}
    }
    for (const id of GRID_TIER_HIDDEN_LAYER_IDS) {
      try { if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", showPins ? "visible" : "none"); } catch {}
    }
  }, []);

  // Identity for the window-snapshot writer below — a ref so fetchViewportPins
  // (deps: [qc] only) always writes under the CURRENT login, never a closure's.
  const snapshotScopeRef = useRef<{ tenantId: number | null | undefined; userId: number | null | undefined } | null>(null);
  snapshotScopeRef.current = user ? { tenantId: user.tenantId, userId: user.id } : null;
  const windowSnapshotTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Debounced WINDOW-snapshot write — the NEXT cold open's instant first
  // paint. COMPLETE windows only (callers gate on !truncated — a replayed
  // sample would paint a misleading thinned view); the debounce settles a pan
  // burst to ~one storage write. Storage + ref timer only — no React state —
  // and kept OUT of fetchViewportPins' body so the #87 purity scan
  // (map-one-tap-add.test.ts) keeps proving that fetch path chrome-free.
  const scheduleWindowSnapshotWrite = useCallback((pins: MapPin[], win: ViewportBBox) => {
    const scope = snapshotScopeRef.current;
    if (!scope || !pins.length) return;
    if (windowSnapshotTimerRef.current) clearTimeout(windowSnapshotTimerRef.current);
    windowSnapshotTimerRef.current = setTimeout(() => {
      windowSnapshotTimerRef.current = null;
      writeMapWindowSnapshot(scope, pins, win);
    }, MAP_PINS_SNAPSHOT_DEBOUNCE_MS);
  }, []);

  // Evidence from the last over-cap pin window ({area, windowCount} — see
  // TruncationEvidence). refreshViewportPins folds it into the tier decision
  // so an over-dense window renders the density grid's REAL counts instead of
  // a silently thinned pin sample; a complete pin window clears it. A ref by
  // contract (#87): the fetch callbacks may write it without flipping state.
  const truncationEvidenceRef = useRef<TruncationEvidence | null>(null);
  // Identity of the in-flight pin fetch — a refresh that resolves to the SAME
  // window+lens joins the in-flight request instead of abort-restarting it.
  // Boot used to fire a burst of a dozen identical fetches (probe flip, style
  // epoch, SSE resync, invalidation bridge all landing in one flush), each
  // aborting its predecessor: the client got its pins a full burst later, and
  // the server — whose query work is synchronous — paid for every corpse.
  const inFlightPinKeyRef = useRef<string | null>(null);

  // INVISIBLE by contract (#87): this function never flips React state — the
  // only writes are the setQueryData cache merge and plain refs. The tier
  // state is owned by refreshViewportPins below; chip visibility DERIVES from
  // mapPinData.truncated + effects.
  const fetchViewportPins = useCallback(() => {
    if (!viewportModeRef.current) return;
    const bounds = currentFetchWindow(mapRef.current);
    if (!bounds) return;
    const { view, window } = bounds;
    // Tier dispatch happens in refreshViewportPins — this callback only ever
    // runs in the pins tier. `nosample=1` tells the server an over-cap window
    // should come back EMPTY with its true count (we render the grid tier for
    // it) rather than as a thinned sample the map would have to lie with.
    const mapView = sourceFilterToMapView(filterSourceRef.current);
    const fetchKey = `${bboxParam(window)}|${mapView ?? ""}`;
    if (inFlightPinKeyRef.current === fetchKey && viewportAbortRef.current && !viewportAbortRef.current.signal.aborted) {
      return; // identical request already on the wire — let it land
    }
    viewportAbortRef.current?.abort();
    const controller = new AbortController();
    viewportAbortRef.current = controller;
    inFlightPinKeyRef.current = fetchKey;
    const sessionId = getStoredSessionId();
    fetch(`/api/leads/map?format=packed&nosample=1&bbox=${bboxParam(window)}${mapView ? `&view=${mapView}` : ""}`, {
      headers: sessionId ? { "x-session-id": sessionId } : {},
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`bbox pins ${res.status}`);
        return unpackMapPins<MapPin>(await res.json());
      })
      .then(({ pins: fetched, truncated, windowCount }) => {
        if (controller.signal.aborted) return;
        if (inFlightPinKeyRef.current === fetchKey) inFlightPinKeyRef.current = null;
        if (truncated) {
          // Over-cap window: the honest render is the density grid, not a
          // sample (nosample=1 means `fetched` is empty — nothing to merge).
          // Record the evidence and re-enter the tier decision; the flag
          // still lands in the cache so the lasso's partial-set honesty
          // gate (#92) knows the loaded pins under-cover this window.
          truncationEvidenceRef.current = {
            area: (window.maxLng - window.minLng) * (window.maxLat - window.minLat),
            windowCount: windowCount ?? Number.MAX_SAFE_INTEGER,
          };
          qc.setQueryData(["/api/leads/map"], (old: any) =>
            old?.truncated ? old : { pins: old?.pins ?? [], total: old?.pins?.length ?? 0, truncated: true });
          refreshViewportPinsRef.current();
          return;
        }
        // Complete window: any prediction evidence is stale — density changed
        // or we zoomed in under the cap. Cleared BEFORE the merge so the next
        // moveend re-tries pins immediately.
        truncationEvidenceRef.current = null;
        const keep = keepRegion(view);
        // The pin window landed: any lingering density bubbles from the grid
        // tier hand off NOW (imperative layer sync — not React state).
        pinWindowLandedRef.current = true;
        syncViewportTierLayers(mapRef.current);
        // A COMPLETE window replacing a cold-open snapshot seed may evict
        // seeded rows the server disowned; a truncated (sampled) window must
        // never evict (mergeViewportPins' standing rule).
        const evictWindow = windowSeedRef.current ? window : null;
        windowSeedRef.current = null; // seed fully reconciled
        qc.setQueryData(["/api/leads/map"], (old: any) => {
          const prev: MapPin[] = old?.pins ?? [];
          const merged = mergeViewportPins(prev, fetched, keep, evictWindow);
          // Nothing new and nothing pruned → keep the old reference so
          // structural sharing turns this into a no-op (no re-cluster) —
          // UNLESS the truncation flag moved, which the notice chip reads.
          if (merged.added === 0 && merged.pruned === 0 && old?.pins && !old?.truncated) return old;
          return {
            pins: merged.pins,
            total: merged.pins.length,
            // LATEST fetch wins: a complete window covering the viewport
            // +20% margin means what's on screen is the whole truth.
            truncated: false,
          };
        });
        // Persist this COMPLETE window (debounced, identity-scoped) so the
        // next cold open paints it instantly — see scheduleWindowSnapshotWrite.
        scheduleWindowSnapshotWrite(fetched, window);
      })
      .catch((err: any) => {
        if (err?.name === "AbortError") return; // superseded by a newer pan
        if (inFlightPinKeyRef.current === fetchKey) inFlightPinKeyRef.current = null;
        // A failed window fetch must never empty the map — keep what's there.
      });
  }, [qc, scheduleWindowSnapshotWrite]);
  const fetchViewportPinsRef = useRef(fetchViewportPins);
  fetchViewportPinsRef.current = fetchViewportPins;

  // ── Density grid loader (wide-zoom tier) ──────────────────────────────────
  // Same shape as the pin window loader: debounce/abort parity via the shared
  // moveend timer, in-flight aborted per new pan, failures never empty the
  // map. Responses cache 60s keyed by bbox+cell+tag so re-entering a recently
  // viewed region is free. The window is CLAMPED to the server's 15° grid
  // guard (centered) — zoomed out to a continent the fetch covers the central
  // 15° instead of 400ing. Writes: setQueryData + refs only (the #87 purity
  // contract, enforced by tests/unit/map-one-tap-add.test.ts).
  const gridAbortRef = useRef<AbortController | null>(null);
  const gridCacheRef = useRef(new Map<string, { ts: number; data: MapGridResponse }>());
  const fetchViewportGrid = useCallback(() => {
    if (!viewportModeRef.current) return;
    const bounds = currentFetchWindow(mapRef.current);
    if (!bounds) return;
    // Clamp about the CAMERA center, not the window's own midpoint: at world
    // zooms the margin-expanded window has been clamped to ±180/±90 (and the
    // mercator view itself is lat-clamped), so its midpoint drifts toward
    // 0°,0° — clamping about that fetched Greenwich-ocean density while the
    // user looked at their territory (an empty map with no explanation). The
    // camera is where they are looking at every zoom; the raw view midpoint
    // is the fallback if the camera read ever fails mid-teardown.
    const cam = (() => {
      try {
        const c = mapRef.current?.getCenter?.();
        return c && Number.isFinite(c.lng) && Number.isFinite(c.lat) ? { lng: c.lng, lat: c.lat } : null;
      } catch { return null; }
    })();
    const window = clampToGridGuard(bounds.window, undefined, cam ?? {
      lng: (bounds.view.minLng + bounds.view.maxLng) / 2,
      lat: (bounds.view.minLat + bounds.view.maxLat) / 2,
    });
    const span = Math.max(window.maxLng - window.minLng, window.maxLat - window.minLat);
    const cell = gridCellForSpan(span); // the server's ?cell=auto formula — keyed, not sent
    const tag = sourceFilterToGridTag(filterSourceRef.current);
    const view = sourceFilterToMapView(filterSourceRef.current);
    const key = gridCacheKey(window, cell, tag, view);
    const hit = gridCacheRef.current.get(key);
    if (hit && Date.now() - hit.ts < MAP_GRID_CACHE_TTL_MS) {
      // A cached window IS a landed window — release the pins→grid handoff
      // guard immediately (otherwise the stale pins would linger 60s).
      gridWindowLandedRef.current = true;
      syncViewportTierLayers(mapRef.current);
      qc.setQueryData(["/api/leads/map/grid"], hit.data);
      return;
    }
    gridAbortRef.current?.abort();
    const controller = new AbortController();
    gridAbortRef.current = controller;
    const sessionId = getStoredSessionId();
    fetch(`/api/leads/map/grid?bbox=${bboxParam(window)}&cell=${cell}${tag ? `&tag=${encodeURIComponent(tag)}` : ""}${view ? `&view=${view}` : ""}`, {
      headers: sessionId ? { "x-session-id": sessionId } : {},
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`bbox grid ${res.status}`);
        return (await res.json()) as MapGridResponse;
      })
      .then((data) => {
        if (controller.signal.aborted) return;
        // The grid window landed: the stale pin clusters that covered the
        // pins→grid crossing hand off NOW (imperative layer sync — not React
        // state). Success only — a failure must keep the pins showing.
        gridWindowLandedRef.current = true;
        syncViewportTierLayers(mapRef.current);
        if (gridCacheRef.current.size > 200) gridCacheRef.current.clear(); // bound pan churn
        gridCacheRef.current.set(key, { ts: Date.now(), data });
        qc.setQueryData(["/api/leads/map/grid"], data);
      })
      .catch((err: any) => {
        if (err?.name === "AbortError") return; // superseded by a newer pan
        // A failed grid fetch must never empty the map — keep what's there:
        // gridWindowLandedRef stays false on a FIRST-window failure, so the
        // pin clusters stay visible; re-sync defensively (a style swap could
        // have reset visibility mid-flight).
        syncViewportTierLayers(mapRef.current);
      });
  }, [qc]);
  const fetchViewportGridRef = useRef(fetchViewportGrid);
  fetchViewportGridRef.current = fetchViewportGrid;

  // The ONE entry point for "the map moved / data changed, refresh the
  // window": owns the tier state (change-only, so a steady pan flips nothing)
  // and delegates the fetch — which stays React-state-free. The tier folds in
  // the truncation evidence, so a window the server just declared over-cap
  // goes straight to the grid (real counts) and a zoom-in only re-tries pins
  // once the area-scaled estimate fits back under the cap.
  //
  // Same-tick calls COALESCE onto one microtask: boot flushes (probe flip +
  // style epoch + SSE resync + invalidation bridge landing together) used to
  // dispatch a dozen self-aborting fetches — one refresh serves them all, at
  // zero added latency (microtasks run before the browser paints).
  const refreshCoalescedRef = useRef(false);
  const refreshViewportPins = useCallback(() => {
    if (refreshCoalescedRef.current) return;
    refreshCoalescedRef.current = true;
    queueMicrotask(() => {
      refreshCoalescedRef.current = false;
      if (!viewportModeRef.current) return;
      const bounds = currentFetchWindow(mapRef.current);
      const tier = bounds
        ? viewportTierForWindow(bounds.window, truncationEvidenceRef.current)
        : viewportTierRef.current;
      if (tier === "pins" && viewportTierRef.current !== "pins") {
        // grid→pins crossing: density stays visible until the pin window lands.
        pinWindowLandedRef.current = false;
      }
      if (tier === "grid" && viewportTierRef.current !== "grid") {
        // pins→grid crossing: the stale pin clusters stay visible until the
        // FIRST grid window lands (and stay on if that fetch fails).
        gridWindowLandedRef.current = false;
      }
      viewportTierRef.current = tier;
      setViewportTier((prev) => (prev === tier ? prev : tier));
      if (tier === "grid") fetchViewportGridRef.current();
      else fetchViewportPinsRef.current();
    });
  }, []);
  const refreshViewportPinsRef = useRef(refreshViewportPins);
  refreshViewportPinsRef.current = refreshViewportPins;

  // Grid cells → the density source (imperative setData, coalesced by React's
  // own batching; ≤5k points is a trivial worker payload). Tier visibility is
  // synced separately so a style swap can't strand the wrong tier on screen.
  const { data: gridData } = useQuery<MapGridResponse>({
    queryKey: ["/api/leads/map/grid"],
    enabled: false, // cache subscription only — fetchViewportGrid writes here
  });
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const src = map.getSource(DENSITY_SOURCE) as any;
    if (!src) return;
    src.setData(gridData ? gridCellsToGeoJson(gridData.cells, gridData.cell) : emptyFeatureCollection());
  }, [gridData, mapReady, styleEpoch]);

  // Tier/visibility sync on every tier flip + style reload (setStyle wipes
  // layout properties, so the epoch dependency re-applies them).
  useEffect(() => {
    if (!mapReady) return;
    syncViewportTierLayers(mapRef.current);
  }, [viewportTier, mapReady, styleEpoch, syncViewportTierLayers]);

  // The source lens is server-side on EVERY tier now ("latest" → ?view= on
  // the count probe, full feed, bbox windows, and the grid; the FCC tag
  // lenses stay grid-only): switching sources busts the 60s grid cache,
  // refetches the active viewport window with the new lens, and invalidates
  // the full feed so its next fetch carries the new ?view= — the pins on
  // screen never mix lenses past one round-trip, and the client-side pin
  // predicate keeps the render honest DURING it. First run is skipped (the
  // mount fetches already carry the initial lens).
  const prevFilterSourceRef = useRef(filterSource);
  useEffect(() => {
    if (prevFilterSourceRef.current === filterSource) return;
    prevFilterSourceRef.current = filterSource;
    gridCacheRef.current.clear();
    // Over-cap evidence is per-lens (the "latest" density says nothing about
    // "all") — a stale carry-over would strand the new lens on the grid tier.
    truncationEvidenceRef.current = null;
    if (viewportModeRef.current) refreshViewportPinsRef.current();
    else void qc.invalidateQueries({ queryKey: ["/api/leads/map"] });
  }, [filterSource, qc]);

  // moveend → debounced 300ms window refetch. Bound per map instance; inactive
  // in full-feed mode (the ref guard makes every pan free there).
  // The debounce exists to coalesce PAN BURSTS — the FIRST fetch of a session
  // has no burst to coalesce, and on a cold open those 300ms sat directly on
  // the blank-map critical path (probe → mode → bind → debounce → fetch). So
  // the first bind fires the window fetch SYNCHRONOUSLY; every later bind
  // (style swap, mode re-flip) and every real moveend keeps the debounce.
  const firstViewportFetchRef = useRef(true);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !viewportMode) return;
    const onMoveEnd = () => {
      if (viewportTimerRef.current) clearTimeout(viewportTimerRef.current);
      viewportTimerRef.current = setTimeout(() => refreshViewportPinsRef.current(), 300);
    };
    map.on("moveend", onMoveEnd);
    if (firstViewportFetchRef.current) {
      firstViewportFetchRef.current = false;
      refreshViewportPinsRef.current(); // boot: no debounce on the first fetch
    } else {
      onMoveEnd(); // the mode may have flipped while the map sat still
    }
    return () => {
      if (viewportTimerRef.current) clearTimeout(viewportTimerRef.current);
      try { map.off("moveend", onMoveEnd); } catch {}
    };
  }, [mapReady, styleEpoch, viewportMode]);

  // Viewport-mode safety poll — the windowed twin of the full feed's 60s
  // refetchInterval. Windowed freshness otherwise hangs ENTIRELY off the SSE
  // streams + moveend: with a proxy that strips streaming (or a long SSE
  // outage), a stationary map never refetched, and a lead created out-of-band
  // stayed invisible until the user happened to pan. One window refetch a
  // minute is small (the common window is a few hundred KB), the grid tier's
  // 60s response cache absorbs it entirely, and hidden tabs pause it the same
  // way the full-feed poll pauses (tabActive gate).
  useEffect(() => {
    if (!viewportMode || !tabActive) return;
    const t = setInterval(() => refreshViewportPinsRef.current(), 60_000);
    return () => clearInterval(t);
  }, [viewportMode, tabActive]);

  // Persist the camera on every settled move (both modes, debounced) so the
  // next launch opens on the same territory and the first pins/grid fetch is
  // immediate — see readPersistedMapCamera at map init.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onMove = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        try {
          const c = map.getCenter();
          persistMapCamera([c.lng, c.lat], map.getZoom());
        } catch {}
      }, 500);
    };
    map.on("moveend", onMove);
    return () => {
      if (timer) clearTimeout(timer);
      try { map.off("moveend", onMove); } catch {}
    };
  }, [mapReady, styleEpoch]);

  // Amber viewport notice (truncated sample). Dismissible; dismissal resets
  // the moment the condition clears so the NEXT dense window warns again.
  // (There is no zoom-in-needed notice: the density grid covers wide zooms.)
  // sampledPins is ALSO the lasso panel's bulk-action honesty flag (#92) —
  // there it must reflect the raw truncated window regardless of tier, so the
  // tier gate lives only at the notice-chip call site below.
  const sampledPins = viewportMode && !!mapPinData?.truncated;
  const [sampleNoticeDismissed, setSampleNoticeDismissed] = useState(false);
  useEffect(() => { if (!sampledPins) setSampleNoticeDismissed(false); }, [sampledPins]);

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
        // Missed pings while hidden: bust the 60s grid cache too.
        gridCacheRef.current.clear();
        if (viewportModeRef.current) refreshViewportPinsRef.current();
        else void qc.invalidateQueries({ queryKey: ["/api/leads/map"] });
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [isRep, qc]);

  // Server-pushed invalidation keeps confirmed fresh-fiber territory leads from
  // waiting for the 60s safety poll. The stream contains no lead data; the
  // subsequent role-scoped GET remains the only source of map rows.
  useEffect(() => {
    // tabActive: the ping stream exists to freshen a map someone is LOOKING at;
    // hidden stages drop it and the re-show revalidation covers the gap.
    if (!user || !tabActive) return;
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
                // Viewport mode: the full feed is never fetched, so the
                // invalidation would be a no-op — refetch the current window.
                // The 60s grid cache must NOT absorb a known lead write.
                gridCacheRef.current.clear();
                if (viewportModeRef.current) refreshViewportPinsRef.current();
                else void qc.invalidateQueries({ queryKey: ["/api/leads/map"] });
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
  }, [user?.id, qc, tabActive]);
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

  // Each new area starts on a colour nothing else is wearing. Colour IS the
  // identifier on a map, so two areas sharing one read as a single region split
  // by a road — worse than any individual colour being unattractive. Still
  // overridable: this picks the starting point, the picker keeps the last word.
  const pickFreeColor = useCallback(
    () => pickUnusedTerritoryColor(territories.map((t) => (t as any).color), TERRITORY_SWATCHES),
    [territories],
  );
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
    // EVERY role: the server scopes the list (reps get only areas they hold),
    // and reps deserve the same penetration/completion read the office has.
    enabled: !!user,
    refetchInterval: tabActive ? 30000 : false,
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
  useEffect(() => { lassoColorRef.current = lassoColor; }, [lassoColor]);
  useEffect(() => {
    (window as any).__onTerritoryClick = (tid: number | null) =>
      setSelectedTerritoryId(tid);
    // Overlapping areas open a chooser rather than resolving to whichever
    // polygon happens to be on top — picking arbitrarily is how a manager pulls
    // back the wrong territory.
    (window as any).__onTerritoryPick = (ids: number[]) => {
      setSelectedTerritoryId(null);
      setTerritoryPickIds(ids);
    };
    return () => {
      delete (window as any).__onTerritoryClick;
      delete (window as any).__onTerritoryPick;
    };
  }, []);
  // Whether a tap on this area should open the management panel at all. The
  // server is the authority (every route re-checks); this only stops a rep's tap
  // from opening a panel whose every button would come back 403.
  useEffect(() => {
    // A rep taps their own area to read its numbers. visibleTerritories already
    // limits a rep to areas they actually hold, so anything they can see, they
    // may open — the panel itself hides every management control by role, and
    // the server re-checks each one regardless.
    (window as any).__canManageTerritory = (tid: number) =>
      canAssign || visibleTerritoryIdsRef.current.has(tid);
    return () => {
      delete (window as any).__canManageTerritory;
    };
  }, [canAssign]);
  // Map→React bridge for the knock sheet (same pattern as __onTerritoryClick).
  // The pin click handler is bound once at map init; it checks this global at
  // call time, so sheet-vs-popup routing follows role/viewport without rebinds.
  useEffect(() => {
    if (!useSheet) return;
    (window as any).__openLeadSheet = (id: number) => {
      // Temp optimistic pins (negative id — a one-tap add still reconciling)
      // must never open the knock sheet: every action inside it would target
      // an id the server has never heard of. Selection follows the reconcile
      // instead (the background add selects the REAL id when it lands).
      if (!(id > 0)) return;
      setSelectedLeadId(id);
    };
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
  // WHY the map is unavailable, so the card can say something true. "library"
  // means the Mapbox GL script never arrived (offline, captive portal, CDN
  // blocked) — a rep problem with a retry. "token" means the server has no
  // MAPBOX_TOKEN — an admin problem no retry will fix.
  const [mapFailureKind, setMapFailureKind] = useState<"library" | "token" | null>(null);
  // Bumping this re-runs the loader effect — the Retry affordance on the
  // failure card, so a rep who walked back into signal is one tap from a map.
  const [mapboxRetry, setMapboxRetry] = useState(0);
  const retryMapbox = useCallback(() => {
    setMapTokenFailed(false);
    setMapFailureKind(null);
    (window as unknown as { __retryMapbox?: () => void }).__retryMapbox?.();
    setMapboxRetry((n) => n + 1);
  }, []);

  // Wait for mapboxgl CDN — uses onload callback from index.html, no polling
  useEffect(() => {
    let cancelled = false;
    // The token is a trivial env read; fetch it IN PARALLEL with the ~230KB
    // mapbox-gl CDN download. Sequencing it inside the ready callback appended
    // a whole API round trip to the tail of the script load on every cold
    // open. Failures still surface only through init below, so the error UX
    // (and the retry path) is unchanged.
    const tokenPromise = apiRequest("GET", "/api/config/map")
      .then((r) => r.json())
      .then((d: { token: string }) => (d?.token ? String(d.token) : null))
      .catch(() => null);
    const init = (err?: Error) => {
      if (cancelled) return;
      // The library never arrived (CDN blocked, captive portal, dead LTE).
      // Surface it: this is the only writer of mapTokenFailed, and without it
      // the rep sat on an empty map container with no spinner and no error.
      if (err) { setMapFailureKind("library"); setMapTokenFailed(true); return; }
      void tokenPromise.then((token) => {
        if (cancelled) return;
        if (token) {
          (window as any).mapboxgl.accessToken = token;
          setMapboxToken(token);
        } else {
          setMapFailureKind("token");
          setMapTokenFailed(true);
        }
      });
    };
    (window as any).__onMapboxReady(init);
    // Belt and braces: a script tag that stalls without ever firing onload or
    // onerror (some captive portals hold the connection open) would otherwise
    // still hang forever. After 12s, call it.
    const stallTimer = window.setTimeout(() => {
      if (!cancelled && !(window as any).__mapboxReady && typeof (window as any).mapboxgl === "undefined") {
        setMapFailureKind("library");
        setMapTokenFailed(true);
      }
    }, 12_000);
    return () => {
      cancelled = true;
      window.clearTimeout(stallTimer);
    };
  }, [mapboxRetry]);

  // ── Init Mapbox ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (mapRef.current || !mapContainer.current || !mapboxToken) return;

    // Initialize immediately — Mapbox tolerates a container that hasn't been
    // laid out yet (0px), and the ResizeObserver + resize() calls below redraw
    // once real dimensions arrive. (Previously this bailed until height>=50px and
    // retried on a timer, which could loop forever if the container measured 0
    // at mount — leaving the map stuck before its first styled frame.)
    const el = mapContainer.current;

    // Reopen where the rep LEFT the map: the first viewport fetch (pins or
    // density grid) then targets real territory the moment the count probe
    // answers, instead of a default-city flash the geolocate has to correct.
    const savedCamera = readPersistedMapCamera();
    const map = new (window as any).mapboxgl.Map({
      container: el,
      style: "mapbox://styles/mapbox/satellite-streets-v12",
      center: savedCamera?.center ?? ROCKWELL_CENTER,
      zoom: savedCamera?.zoom ?? 13,
      // No wordmark, no attribution bar on the map (owner ask). The license
      // text stays reachable behind the compact "i" control added below —
      // Mapbox's terms require attribution to exist, not to sprawl.
      attributionControl: false,
    });
    try {
      map.addControl(new (window as any).mapboxgl.AttributionControl({ compact: true }), "bottom-right");
    } catch { /* attribution collapse is cosmetic — never block map boot */ }
    mapRef.current = map; // claim immediately so a re-render can't spawn a second map
    if (import.meta.env.DEV) {
      (window as any).__map = map; // debug handle (dev only)
    }
    startMapPerf(map); // opt-in FPS/first-paint sampler (?perf=1); no-op otherwise

    // Force resize once container is definitely painted
    setTimeout(() => map.resize(), 100);
    setTimeout(() => map.resize(), 400);

    // No NavigationControl: the minimal map (SalesRabbit reference) carries no
    // zoom/compass chrome — pinch, scroll-wheel, and double-click zoom stay
    // enabled (mapbox defaults; the draw tools disable/re-enable only their own
    // gestures while armed).
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
        "[follow] GeolocateControl._updateCamera missing - single-writer guard inert",
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
    // NOTE: `interacting` is NOT touched here — it mirrors physical pointer
    // state only (the pointerdown/pointerup counter below owns it).
    const suspendFollow = () => {
      cameraGenerationRef.current += 1;
      following = false;
      setFollowEngaged(false);
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
          ? "Location is turned off for this app. On iPhone: Settings > Privacy & Security > Location Services > turn on, then find Safari/HomeFront and set “While Using.”"
          : code === 3
            ? "Getting a GPS fix timed out - step outside or try again."
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
      setFollowEngaged(true);
      ensureLoop();
    };
    const onFollowEnd = () => {
      following = false;
      setFollowEngaged(false);
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
      // Belt-and-suspenders: clear a leaked interacting flag (e.g. a missed
      // pointerup outside the window) — but never mid-gesture while a finger
      // is still down (rotateend fires when the SECOND finger lifts first).
      if (pointersDown === 0) interacting = false;
    };
    map.on("dragstart", onDragStart);
    const gestureStarts = ["zoomstart", "rotatestart", "pitchstart"];
    const gestureEnds = ["dragend", "zoomend", "rotateend", "pitchend"];
    for (const evn of gestureStarts) map.on(evn, onGestureStart);
    for (const evn of gestureEnds) map.on(evn, onGestureEnd);

    // ── THE FREEZE FIX: pause the camera writer while a finger is down. ──────
    // Every external map.jumpTo runs map.stop() → HandlerManager.stop(), which
    // RESETS in-progress gesture recognition. With the follow loop issuing a
    // jumpTo per animation frame, a pan/rotate could never accumulate enough
    // movement to cross its start threshold: dragstart/rotatestart never fired,
    // the break-out above never ran, and the map read as frozen ("won't change
    // direction / can't move") the whole time the loop was live. `interacting`
    // was checked in frame() but nothing ever set it — this counter is the
    // missing writer. While a pointer is down the loop keeps running (the puck
    // stays live) but skips jumpTo, so mapbox can recognise the gesture and the
    // start handlers above break follow for real. A plain tap (down→up, no
    // gesture) leaves follow engaged — exactly the legit behavior.
    let pointersDown = 0;
    const onPointerDown = () => {
      pointersDown += 1;
      interacting = true;
    };
    const onPointerUp = () => {
      pointersDown = Math.max(0, pointersDown - 1);
      if (pointersDown === 0) interacting = false;
    };
    const gestureSurface = map.getCanvasContainer();
    gestureSurface.addEventListener("pointerdown", onPointerDown);
    // Window-level: the finger/mouse can lift OUTSIDE the canvas mid-gesture.
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    // Desktop wheel-zoom has no pointerdown: break follow on the wheel event
    // itself so the per-frame jumpTo can't cancel the wheel zoom before its
    // (untagged) zoomstart reaches the handlers above.
    const onWheelBreak = () => {
      if (following) suspendFollow();
    };
    gestureSurface.addEventListener("wheel", onWheelBreak, { passive: true });

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
      // Outline ONLY while dragging (SalesRabbit reference, owner directive):
      // the shape being drawn is a dashed boundary, never a live fill — the
      // box clears on release when the scan starts, so a fill layer here only
      // ever tinted the in-progress drag.
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

      // ── Density grid source (GeoJSON) — the wide-zoom aggregate tier ──────
      // Count bubbles from /api/leads/map/grid, visible only past the pin
      // path's span guard. Installed BEFORE the cluster source so during the
      // one-fetch tier handoff (both visible) the pins read on top.
      ensureDensityLayers(map);

      // ── Lead cluster source (GeoJSON) — count bubbles when zoomed out ──
      // Source + the four cluster layers come from ONE spec factory shared
      // with the style.load re-add block (the two hand-copied versions had
      // drifted; see clusterLayerSpecs in @/lib/mapPins for the zoom contract
      // that fixed the [13.5,14) dead band).
      map.addSource("leads-cluster", LEADS_CLUSTER_SOURCE_SPEC);
      for (const spec of clusterLayerSpecs()) map.addLayer(spec);

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

      // Tap a density bubble → zoom to exactly that cell (the cell pitch
      // rides on every feature). fitBounds lands well inside the pin tier, so
      // one tap takes a state view to working territory.
      map.on("click", DENSITY_CIRCLES_LAYER, (e: any) => {
        if (drawToolActive()) return;
        suspendFollow();
        const f = e.features?.[0];
        const coords = f?.geometry?.coordinates;
        if (!coords) return;
        const cell = Number(f?.properties?.cell) > 0 ? Number(f.properties.cell) : 0.25;
        const half = cell / 2;
        map.fitBounds(
          [
            [coords[0] - half, coords[1] - half],
            [coords[0] + half, coords[1] + half],
          ],
          { padding: 120, duration: 500, maxZoom: 14 },
        );
      });
      map.on("mouseenter", DENSITY_CIRCLES_LAYER, () => hoverCursor("pointer"));
      map.on("mouseleave", DENSITY_CIRCLES_LAYER, () => hoverCursor(""));

      // ── Individual lead pins (GPU circle layer) — every zoom, no floor ──
      // Painted by displayState (`ds` prop): shared spec factory in
      // @/lib/mapPins keeps this block and the style.load re-add block from
      // ever drifting again (and carries the no-minzoom isolated-lead fix).
      for (const spec of unclusteredLayerSpecs()) {
        const { before, ...layer } = spec;
        map.addLayer(layer, before);
      }

      // ── Per-rep colour halos ───────────────────────────────────────────────
      // Concentric rings UNDER the pin, one per rep who works the door, so a
      // shared area reads as shared without a tap. Specs come from
      // @/lib/leadHalos — same import in the style.load re-add block below, so
      // the two can never drift (the drift that silently reverted the Frontier
      // fresh-halo colour after a basemap toggle).
      for (const spec of haloLayerSpecs()) {
        map.addLayer(spec, haloBeforeId((id) => !!map.getLayer(id)));
      }

      // Worked-vs-unworked is color-only: knocked doors render in their status
      // hue (terminal states pre-dimmed) with a thicker white stroke — no glyph
      // badges on pins, per the field design language. (The per-pin glow layer
      // was removed — a 2nd fill draw under every pin; the zoom-scaled radius +
      // white stroke give enough pop at half the unclustered draw cost.)

      // Selected-pin ring — driven by setFilter (style-thread only, no setData).
      // Added last so it can never be occluded by pins/glow.
      map.addLayer(SELECTED_RING_SPEC);

      // Provider-native house numbers — fade in at z≥17.2, below our layers.
      // OPT-IN (settings sheet): the layer only mounts when the pref is on.
      if (showHouseNumsRef.current) ensureHousenumLayer(map, mapStyleMode);

      // Optional glyph-pin layer — opt-in via NEW_FIELD_MAP=1; default dots.
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
        // Tap-a-house: in add mode a single tap resolves the rooftop → address —
        // UNLESS the tap lands on an existing pin. Pins are hit-tested FIRST
        // with the same ±16px fat-finger box the empty-tap path uses below: a
        // tap (or gloved near-miss) on a pin opens that lead and never
        // reverse-geocodes + POSTs a duplicate pin 1-2m away.
        if ((window as any).__tapAddressMode) {
          let hitLeadId: number | null = null;
          try {
            // Query whichever pin layer is live (icon layer only when it
            // exists; a hidden layer returns nothing, a missing one throws).
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
            hitLeadId = near.length ? (near[0].properties.id as number) : null;
          } catch {
            /* layer not ready — fall through to add */
          }
          const decision = decideAddModeTap(hitLeadId);
          if (decision.action === "open-lead") {
            (window as any).__openLeadSheet?.(decision.leadId);
            return;
          }
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
        // Which area did they mean? Three things were wrong here.
        //
        // The old test was /^territory-\d+$/ against the layer id, which matches
        // the FILL layer and rejects `territory-42-outline` — so a tap on the
        // boundary was queried, found, and then thrown away. Managers aim at the
        // line, because the line is the thing they can see.
        //
        // It also took feats.find(), the first match, which on overlapping areas
        // is whichever happens to be drawn on top. Silently opening an arbitrary
        // polygon is how someone pulls back the wrong territory.
        //
        // And it ran for every role, so a rep's tap opened a panel whose every
        // button would 403.
        const cb = (window as any).__onTerritoryClick;
        const pick = (window as any).__onTerritoryPick;
        const outcome = resolveTerritoryTap(feats, (id) =>
          (window as any).__canManageTerritory?.(id) !== false,
        );
        if (outcome.kind === "select") cb?.(outcome.territoryId);
        else if (outcome.kind === "choose") pick?.(outcome.territoryIds);
        else cb?.(null); // empty map closes the panel
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
    // environments, leaving the map stuck pre-ready with no pins). Adding
    // sources/layers only requires the style, so this is both correct and more
    // robust.
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
      setFollowEngaged(false); // a re-created map starts with follow off
      suspendFollowCameraRef.current = () => {};
      try {
        if (mmRM && onRM) mmRM.removeEventListener("change", onRM);
      } catch {} // window-level, survives map.remove
      try {
        gestureSurface.removeEventListener("pointerdown", onPointerDown);
        gestureSurface.removeEventListener("wheel", onWheelBreak);
      } catch {}
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
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
  // rep filter, then source filter, then status filter. Single source of truth
  // for the pin layer, the lasso AND the leads panel, so no surface can
  // disagree with the pins. Source AND status compose: a rep can work
  // "FCC-fiber doors that are still unworked". The status filter matches the
  // pin's DISPLAY state (what the rep sees).
  const visibleLeads = useMemo(() => {
    const sourced =
      filterSource === "all"
        ? repFilteredLeads
        : repFilteredLeads.filter((l) => leadMatchesSource(l, filterSource));
    if (filterStatus === "all") return sourced;
    return sourced.filter((l) => pinDisplayState(l) === filterStatus);
  }, [repFilteredLeads, filterStatus, filterSource]);

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
  // Last styleEpoch this map's source was actually filled for. -1 = never, which
  // is also every fresh style: setStyle drops the source, so a "nothing changed"
  // reconcile must still repaint. See the guard in the reconcile effect.
  const paintedStyleEpochRef = useRef(-1);
  // One worker re-cluster + repaint per animation frame MAX. Disposition taps
  // mutate their single pin synchronously (instant feedback), then schedule
  // the full-collection setData here; back-to-back taps inside one frame
  // collapse into a single repaint of the latest data instead of each paying
  // a 5.5k-feature re-cluster at the rep's feedback moment.
  const scheduleClusterSetData = useMemo(
    () =>
      createRafCoalescedFlush(() => {
        try {
          (mapRef.current?.getSource("leads-cluster") as any)?.setData(
            geoJsonDataRef.current,
          );
        } catch {
          /* source can disappear during a style switch */
        }
      }),
    [],
  );

  // ── Tap-a-house wiring — ONE-TAP OPTIMISTIC ADD ───────────────────────────
  // The shared map click handler (bound once at init) reads these window
  // globals — the same pattern lasso/draw use — so toggling the mode never
  // re-registers the map listener.
  //
  // Owner directive: no loading, no syncing shown. The pin lands AT THE TAPPED
  // ROOFTOP on the very tap (temp negative id, unworked state, the same
  // optimistic cache-insert AddLeadSheet's submit uses); the halo flash is
  // pure confirmation on a short timer; the reverse-geocode + POST run
  // entirely in the background and reconcile the temp id to the real one in
  // BOTH the query cache and the live GeoJSON feature maps. Failure removes
  // the temp pin with ONE destructive toast naming the street.
  const tempPinIdRef = useRef(-1); // monotonic negatives — never collide with a server id
  useEffect(() => {
    (window as any).__tapAddressMode = addMode;
    (window as any).__onTapAddress = (lat: number, lng: number) => {
      // Confirmation halo AT the tapped rooftop — it lights instantly and
      // clears on its own timer. It is NOT a loading indicator: nothing here
      // waits on it, and the background work never extends it.
      try {
        (mapRef.current?.getSource(SEARCH_RESULT_SOURCE) as any)?.setData({
          type: "FeatureCollection",
          features: [{ type: "Feature", geometry: { type: "Point", coordinates: [lng, lat] }, properties: {} }],
        });
      } catch { /* transient layer state */ }
      window.setTimeout(() => {
        try { (mapRef.current?.getSource(SEARCH_RESULT_SOURCE) as any)?.setData(emptyFeatureCollection()); } catch { /* noop */ }
      }, 1400);

      if (!canAssign) {
        // No add rights: resolve in the background and report the address —
        // still no spinner, the mode stays armed either way.
        void reverseGeocode(lat, lng)
          .then((a) => toast({ title: "Address found", description: a.address }))
          .catch(() => toast({
            title: "No address there",
            description: "Tap directly on a rooftop and try again.",
            variant: "destructive",
          }));
        return;
      }

      // INSTANT: temp pin into the map cache BEFORE any network await. The
      // cluster reconcile effect paints it at the tapped rooftop this frame.
      const tempId = tempPinIdRef.current--;
      const tempPin: MapPin = {
        id: tempId, address: "", city: "", state: "", zip: "",
        lat, lng, leadStatus: "prospect", fiberStatus: "unknown",
        assignedRepId: null, leadScore: 0, visited: false,
      };
      qc.setQueryData(["/api/leads/map"], (old: any) => {
        const pins = old?.pins ?? [];
        return {
          ...(old ?? {}),
          total: (old?.total ?? pins.length) + 1,
          pins: [...pins, tempPin],
        };
      });
      try { navigator.vibrate?.(10); } catch { /* no haptics */ }

      // Shared failure/duplicate arm: pull the temp pin back out of the cache
      // AND the live GeoJSON maps (mirrors handleDeleteLead's removal).
      const removeTempPin = () => {
        featureByIdRef.current.delete(tempId);
        if (geoJsonDataRef.current?.features) {
          geoJsonDataRef.current = {
            ...geoJsonDataRef.current,
            features: geoJsonDataRef.current.features.filter(
              (f: any) => f.id !== tempId && f?.properties?.id !== tempId,
            ),
          };
          scheduleClusterSetData();
        }
        qc.setQueryData(["/api/leads/map"], (old: any) => {
          if (!old?.pins) return old;
          return {
            ...old,
            total: Math.max(0, (old.total ?? old.pins.length) - 1),
            pins: old.pins.filter((p: any) => p.id !== tempId),
          };
        });
      };

      // Everything below is BACKGROUND — the rep already has their pin.
      void (async () => {
        let resolved: { address: string; city: string; state: string; zip: string; lat: number; lng: number };
        try {
          const a = await reverseGeocode(lat, lng);
          resolved = { address: a.address, city: a.city, state: a.state, zip: a.zip, lat: a.lat, lng: a.lng };
        } catch {
          // ONE destructive toast; the mode stays armed — the rep aims again.
          removeTempPin();
          toast({
            title: "No address there",
            description: "Tap directly on a rooftop and try again.",
            variant: "destructive",
          });
          return;
        }
        try {
          const addRes = await apiRequest("POST", "/api/leads", {
            address: resolved.address, city: resolved.city, state: resolved.state,
            zip: resolved.zip, leadStatus: "prospect", lat: resolved.lat, lng: resolved.lng,
          });
          const added = await addRes.json();
          if (added?.id == null) throw new Error("lead create returned no id");
          const finalAddress = added.address ?? resolved.address;
          if (added.existed === true && added.adopted !== true) {
            // Duplicate path: drop the temp pin, then let the shared reason-aware
            // handler decide — flash the real pin when it genuinely renders, or
            // explain honestly (and open the lead by id) when it doesn't. NEVER
            // inject a fabricated pin for an ungeocoded/hidden/out-of-scope lead.
            removeTempPin();
            openExistingLeadRef.current(added.id, finalAddress, added.visibility as LeadVisibility | undefined);
          } else {
            // Fresh add OR FCC adopt-on-tap (#61): both return the rep's own live
            // pin at the tapped rooftop, so an adopted ghost (existed:true +
            // adopted:true) takes this SAME success path — reconcile the optimistic
            // temp pin to the real (adopted) id instead of dead-ending on the
            // honest-exists open-by-id above.
            // Reconcile temp id → real id in the query cache…
            qc.setQueryData(["/api/leads/map"], (old: any) => {
              if (!old?.pins) return old;
              const i = pinIndexOf(old.pins, tempId);
              if (i < 0) return old; // temp pin already gone — nothing to rename
              const pins = old.pins.slice();
              pins[i] = {
                ...pins[i],
                id: added.id,
                address: finalAddress,
                city: added.city ?? resolved.city,
                state: added.state ?? resolved.state,
                zip: added.zip ?? resolved.zip,
                lat: added.lat ?? pins[i].lat,
                lng: added.lng ?? pins[i].lng,
                leadStatus: added.leadStatus ?? "prospect",
                assignedRepId: added.assignedRepId ?? null,
              };
              return { ...old, pins };
            });
            // …and in the live GeoJSON feature maps, so the painted pin and
            // every id-keyed path (knock, delete, ring) agree immediately —
            // the reconcile effect then settles the definitive feature.
            const tempFeature = featureByIdRef.current.get(tempId);
            if (tempFeature) {
              featureByIdRef.current.delete(tempId);
              tempFeature.id = added.id;
              tempFeature.properties.id = added.id;
              tempFeature.properties.address = finalAddress;
              if (added.lat != null && added.lng != null) {
                tempFeature.geometry.coordinates = [added.lng, added.lat];
              }
              featureByIdRef.current.set(added.id, tempFeature);
              scheduleClusterSetData();
            }
            setSelectedLeadId(added.id);
            toast({ title: "Pin added", severity: "success", description: finalAddress });
          }
          // Durable reconcile for every other consumer (list, stats, map poll).
          //
          // The map feed is invalidated CONDITIONALLY. The duplicate/existed
          // path merged nothing above — its "flash the real pin" affordance can
          // depend on this refetch for a lead that entered scope inside the
          // last poll window — so it always invalidates. The fresh-add/adopted
          // path already reconciled the authoritative row into the query cache
          // AND the live feature maps above; in viewport mode the invalidate
          // bridge turns this into a cheap window refetch, so keep it, but in
          // full-feed mode it would re-download the whole packed feed (the add
          // bumped the data version, so the ETag cannot 304) just to re-learn
          // the row that was merged. The only fields the merged pin lacks are
          // server-joined extras (knockCount, freshConfidence, carrier), which
          // the standing 60s poll reconciles within a minute anyway — skip it.
          const mergedAuthoritativeRow = !(added.existed === true && added.adopted !== true);
          if (!mergedAuthoritativeRow || viewportModeRef.current) {
            qc.invalidateQueries({ queryKey: ["/api/leads/map"] });
          }
          qc.invalidateQueries({ queryKey: ["/api/leads"] });
        } catch {
          removeTempPin();
          toast({
            title: "Couldn't add the lead",
            description: `${resolved.address} didn't save - tap the house again to retry.`,
            variant: "destructive",
          });
        }
      })();
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
  }, [addMode, toast, canAssign, qc, scheduleClusterSetData]);

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
    // Area labels shed detail as they get small. Only the BUCKET is stored, not
    // the raw zoom: the label layer rebuilds when this changes, and storing a
    // continuous value would rebuild it on every wheel tick.
    const onZoomEnd = () => {
      try {
        const z = map.getZoom();
        setLabelZoom((prev) => (detailForZoom(prev) === detailForZoom(z) ? prev : z));
      } catch { /* map mid-teardown */ }
    };
    map.on("moveend", onMoveEnd);
    map.on("zoomend", onZoomEnd);
    onZoomEnd();
    return () => {
      if (bboxTimerRef.current) clearTimeout(bboxTimerRef.current);
      try {
        map.off("moveend", onMoveEnd);
        map.off("zoomend", onZoomEnd);
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

  // ── Who works this door → the per-rep halo ────────────────────────────────
  // Resolved ONCE PER AREA, never per lead. The naive shape here is
  // `territories.find(t => t.id === lead.assignedTerritoryId)` plus a
  // JSON.parse of assignee_ids inside the 5k-lead reconcile loop — the exact
  // O(leads x areas) + 5,000-JSON.parse pattern activeAreaCountByRep and
  // progressById were introduced to kill. This memo pays the parse once per
  // area (a few hundred, and only when the area list actually changes) and the
  // per-lead lookup below is a Map hit that usually returns a SHARED array, so
  // an entire street of doors in one area allocates nothing at all.
  const repIdsByArea = useMemo(() => {
    const byArea = new Map<number, number[]>();
    for (const t of territories as any[]) {
      // Primary first — the innermost ring hugging the pin is always the owner.
      byArea.set(t.id, repIdsForDoor(t.repId, t.assigneeIds));
    }
    return byArea;
  }, [territories]);

  const haloRepIdsFor = useCallback<LeadRepIdsFn>(
    (lead) => {
      const areaRepIds = lead.assignedTerritoryId != null
        ? repIdsByArea.get(lead.assignedTerritoryId)
        : undefined;
      // A door assigned to a rep but not to an area (direct assignment, or an
      // area the rep list has not caught up with) still shows its owner's ring.
      if (!areaRepIds) return lead.assignedRepId ? [lead.assignedRepId] : null;
      // Fast path — the door's owner IS the area's primary, which is what every
      // assignment path writes. Hand back the area's shared array untouched.
      if (!lead.assignedRepId || areaRepIds[0] === lead.assignedRepId) return areaRepIds;
      // Divergent (a reclaim, a per-lead reassignment inside a shared area):
      // the DOOR's owner takes the inner ring, the rest of the crew follows.
      return repIdsForDoor(lead.assignedRepId, areaRepIds);
    },
    [repIdsByArea],
  );
  // Read by the push handler, which lives far below and must not re-subscribe
  // the stream every time the area list is refetched.
  const haloRepIdsForRef = useRef(haloRepIdsFor);
  haloRepIdsForRef.current = haloRepIdsFor;

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
      haloRepIdsFor,
    );
    geoJsonDataRef.current = reconciled.data;
    featureByIdRef.current = reconciled.byId;
    // Knock skip-guard: the knock handler already recolored this ONE pin
    // imperatively (mutate + setData). When the optimistic query update rolls
    // back through here and the sole change is that same pin, the second full
    // setData + re-cluster is pure duplicate work — skip the paint, keep refs.
    const skipId = pendingKnockPaintRef.current;
    pendingKnockPaintRef.current = null;
    // Nothing created and nothing pruned means every surviving feature is the
    // SAME object as last pass — the painted set is identical and a setData
    // would re-cluster 5.5k features to produce the picture already on screen.
    // This is what lets haloRepIdsFor sit in the dep array below: an
    // /api/territories refetch that changed no assignment now costs one O(n)
    // signature pass instead of a full worker round-trip.
    //
    // The epoch check is NOT optional. setStyle wipes the source, so the run
    // triggered by the styleEpoch bump finds an EMPTY source and a fully warm
    // feature cache — created 0, removed 0 — and skipping it would leave every
    // pin off the map after a basemap toggle. Same on the first run for a map
    // instance. Only an epoch we have already painted may be skipped.
    const samePaintedStyle = paintedStyleEpochRef.current === styleEpoch;
    paintedStyleEpochRef.current = styleEpoch;
    const unchanged = samePaintedStyle && reconciled.created === 0 && reconciled.removed === 0;
    if (!unchanged && (skipId == null || reconciled.soleChangedId !== skipId)) {
      src.setData(reconciled.data);
    }
    // NOTE: this dep array must NEVER gain selection/sheet state — a pin tap must
    // rebuild zero GeoJSON. Selection is a setFilter on its own effect below.
    // It must also stay free of poll-churned identities (team, user): the
    // memoized visibleLeads absorbs those upstream. haloRepIdsFor is the one
    // exception and it has to be here — reassigning an area changes which reps
    // a door belongs to without touching the lead rows at all, so without this
    // dep a shared door would keep painting the previous crew's colours until
    // something unrelated happened to it. The `unchanged` guard above pays for it.
  }, [visibleLeads, mapReady, styleEpoch, haloRepIdsFor]);

  // Admin assignment view: recolor unclustered pins by repColor (or restore
  // the canonical status palette). Pure style-thread paint swap — no setData.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !canManage) return;
    try {
      if (repColorMode) {
        // AUDIT FIX: in the default icon-pin config the circle layer hands off
        // to icons at z12, so recoloring it alone changed NOTHING up close.
        // Swap layers: icons off, circles on at EVERY zoom in rep colors
        // (clusters stay status-colored — territory-level view).
        if (map.getLayer(STATUS_ICON_LAYER)) map.setLayoutProperty(STATUS_ICON_LAYER, "visibility", "none");
        if (map.getLayer("lead-unclustered")) {
          map.setLayerZoomRange?.("lead-unclustered", 0, 24);
          map.setLayoutProperty("lead-unclustered", "visibility", "visible");
          map.setPaintProperty("lead-unclustered", "circle-color", ["get", "repColor"]);
        }
      } else {
        if (map.getLayer("lead-unclustered")) {
          map.setPaintProperty("lead-unclustered", "circle-color", PIN_DS_COLOR);
          // The circle layer stays VISIBLE in icon mode: its zoom range hands
          // off to icons at z12 (addStatusIconLayer), and below that it is the
          // ONLY representation an isolated lead has — hiding it here was how
          // solo rural doors vanished at survey zooms.
          if (newFieldMap() && map.getLayer(STATUS_ICON_LAYER)) {
            map.setLayerZoomRange?.("lead-unclustered", 0, PIN_DETAIL_MIN_ZOOM);
          }
          map.setLayoutProperty("lead-unclustered", "visibility", showLeads ? "visible" : "none");
        }
        if (map.getLayer(STATUS_ICON_LAYER)) map.setLayoutProperty(STATUS_ICON_LAYER, "visibility", newFieldMap() ? (showLeads ? "visible" : "none") : "none");
      }
    } catch { /* style mid-load; styleEpoch re-fires this effect */ }
  }, [repColorMode, mapReady, styleEpoch, canManage, showLeads]);

  // ── Selected-pin ring + dimming — pure style-thread update, no setData, no
  //    re-cluster. With a lead selected, its pin keeps full color + the ring
  //    while every other unclustered pin dims to ~45% (restored on deselect,
  //    when the expression collapses back to the identity ds-opacity). ──
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    try {
      map.setFilter("lead-selected-ring", SELECTED_RING_FILTER(selectedLeadId));
      if (map.getLayer("lead-unclustered"))
        map.setPaintProperty(
          "lead-unclustered",
          "circle-opacity",
          unclusteredOpacityExpr(selectedLeadId),
        );
      if (map.getLayer(STATUS_ICON_LAYER))
        map.setPaintProperty(
          STATUS_ICON_LAYER,
          "icon-opacity",
          iconOpacityExpr(selectedLeadId),
        );
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

  // ── First authorized launch: center on the rep's LIVE fix exactly once ──────
  // The cached fix paints instantly (above); this one-shot swaps in the real
  // position the moment the browser grants it — then stands down for the whole
  // session. It NEVER follows movement: after this one recenter the camera
  // returns to the rep only when they tap Locate. A gesture (or an engaged
  // follow camera) before the fix lands cancels the swap via the generation
  // guard, so the map can never yank the viewport out from under the rep.
  const launchFixRequestedRef = useRef(false);
  useEffect(() => {
    if (!mapReady || launchFixRequestedRef.current) return;
    launchFixRequestedRef.current = true;
    const generation = cameraGenerationRef.current;
    captureFieldFix(8000)
      .then((fix) => {
        if (fix.repLat == null || fix.repLng == null) return;
        writeCachedFix(fix.repLat, fix.repLng, Date.now());
        const m = mapRef.current;
        if (
          !m ||
          gpsCenteredRef.current || // the follow control already engaged
          cameraGenerationRef.current !== generation // the rep took the camera
        )
          return;
        moveCamera(m, {
          center: [fix.repLng, fix.repLat],
          zoom: STREET_ZOOM,
          duration: 900,
          essential: true,
        });
        didAutoFitRef.current = true;
      })
      .catch(() => {});
  }, [mapReady]);

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

  useEffect(() => {
    visibleTerritoryIdsRef.current = new Set(visibleTerritories.map((t) => t.id));
  }, [visibleTerritories]);

  // Centroid label. Reps: the area NAME only. Managers: name + owner line
  // ("Rep knocked/total"); "Unassigned" once reclaimed (the old rep's name
  // must NOT linger on the area).
  // Whose area, since when, how far through — the three things a manager reads
  // off the map without tapping. Wording and truncation live in
  // @shared/territoryLabel so they're testable away from Mapbox; here we only
  // choose the detail level from zoom, since three lines over a block-sized
  // polygon collide with the neighbours and become unreadable.
  // O(1) progress lookup. territoryLabelFor runs once per territory and used
  // .find over the progress array, so painting N areas cost O(N × P) — at 200
  // areas that is 40,000 comparisons on every label repaint.
  const progressById = useMemo(
    () => new Map(territoryProgress.map((p: any) => [p.id, p] as const)),
    [territoryProgress],
  );

  // Active areas per rep, counted ONCE over the territory list instead of
  // re-scanning it per rep. The rep picker previously did
  // territories.filter(...) inside team.map(...) AND JSON.parsed assigneeIds on
  // every pair: O(reps × areas) parses — 40 reps × 200 areas = 8,000 JSON.parse
  // calls per render, on the phone, while the manager is mid-tap.
  const activeAreaCountByRep = useMemo(() => {
    const counts = new Map<number, number>();
    for (const t of territories as any[]) {
      if (t.status !== "active" && t.status !== "shared") continue;
      const seen = new Set<number>();
      if (t.repId != null) seen.add(t.repId);
      try {
        for (const id of JSON.parse(t.assigneeIds || "[]") as number[]) seen.add(id);
      } catch { /* legacy row */ }
      // A rep on an area as both primary and assignee still holds ONE area.
      for (const id of seen) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  }, [territories]);
  // Same tallies as a plain record — RepPicker's areaCounts prop takes
  // Record<number, number> and switches its rows to the assign-sheet grammar
  // (ring avatar + "Assigned to N areas" status line). One conversion, reused
  // by every RepPicker on this page.
  const repAreaCounts = useMemo(() => {
    const rec: Record<number, number> = {};
    for (const [id, n] of activeAreaCountByRep) rec[id] = n;
    return rec;
  }, [activeAreaCountByRep]);

  // ReclaimAllDialog props, memoized: these were built INLINE in the JSX, so
  // every MapView render while an admin had the page open (the map re-renders
  // ~every 400ms during a scan) re-JSON.parsed assigneeIds for EVERY territory
  // (hundreds of parses/render) and rebuilt the id→name record — with the
  // dialog closed. Now they re-derive only when territories/team change.
  const reclaimAllAreas = useMemo(
    () =>
      (territories as any[]).map((t) => {
        // Same holder rule as the detail panel: assignee_ids is
        // authoritative; a pool-status area with a stale repId is EMPTY.
        let ids: number[] = [];
        try {
          const a = JSON.parse(t.assigneeIds || "[]");
          ids = Array.isArray(a) && a.length
            ? a
            : t.status === "unassigned" || t.status === "reclaimed"
              ? []
              : [t.repId].filter(Boolean);
        } catch {
          ids = [t.repId].filter(Boolean);
        }
        return { id: t.id, repIds: ids, status: t.status ?? "active" };
      }),
    [territories],
  );
  const teamNameRecord = useMemo(
    () => Object.fromEntries(team.map((m) => [m.id, m.name])),
    [team],
  );
  // repId → persisted team_members.color. Without this the detail panel's rep
  // chips fell back to the legacy repId-hash hue and disagreed with the pins.
  const teamColorRecord = useMemo(
    () => Object.fromEntries(team.map((m) => [m.id, (m as any).color ?? null])),
    [team],
  );

  const territoryLabelFor = (t: (typeof territories)[number]): string => {
    const areaName = (t.name ?? "").trim();
    if (!canAssign) return areaName;
    const prog = progressById.get(t.id);
    return territoryLabel({
      areaName,
      repName: repNameById.get(t.repId) ?? "",
      assignedAt: (t as any).assignedAt ?? null,
      knocked: prog?.knocked ?? null,
      total: prog?.total ?? null,
      status: (t as any).status ?? "active",
    }, detailForZoom(labelZoom));
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
        // SalesHub-grade outlines: render-time Chaikin smoothing. Contraction-
        // only, so the displayed boundary never exceeds the drawn one — and the
        // STORED polygon (coverage, hit-tests, boundary rules) is untouched.
        const smoothRing = chaikinSmooth(coords.map(([x, y]) => ({ x, y })), 2, true)
          .map(pt => [pt.x, pt.y] as [number, number]);
        const closed = [...smoothRing, smoothRing[0]];
        // Status-aware styling: reclaimed/unassigned areas go GRAY and lose the
        // rep's name; completed areas keep the rep color but muted.
        const isPool = status === "unassigned" || status === "reclaimed";
        // The area's OWN colour, not the rep's palette hue — that is what the
        // admin picked while drawing, and it has to be the same on every phone
        // looking at this ground. colorForRep is only the fallback for rows
        // written before the colour was captured.
        const paint = territoryPaint({ color: (t as any).color, status }, colorForRep(t.repId));
        const color = paint.fillColor;
        const srcId = `territory-${t.id}`;
        // Areas go UNDER the pins. Without this they were appended on top of
        // every lead layer already present — a translucent sheet over the doors
        // the rep opened the map to tap.
        const beforeId = territoryBeforeId((id) => !!map.getLayer(id));
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
            paint: { "fill-color": paint.fillColor, "fill-opacity": paint.fillOpacity },
          }, beforeId);
        }
        if (!map.getLayer(srcId + "-outline")) {
          map.addLayer({
            id: srcId + "-outline",
            type: "line",
            source: srcId,
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
              "line-color": paint.lineColor,
              "line-width": paint.lineWidth,
              "line-opacity": paint.lineOpacity,
              ...(paint.lineDasharray ? { "line-dasharray": paint.lineDasharray } : {}),
            },
          }, beforeId);
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
      // The rep halos follow showLeads like every other lead layer — a ring
      // left floating under a hidden pin is worse than no ring at all. They are
      // NOT swapped out in NEW_FIELD_MAP mode: the halo sits under the glyph
      // pin exactly as it sits under the dot.
      ...HALO_LAYER_IDS,
      STATUS_ICON_LAYER,
    ]) {
      if (!map.getLayer(id)) continue;
      // NEW_FIELD_MAP swaps circle pins for status icons ABOVE z12 only: the
      // circle layer keeps its 0→12 zoom range (addStatusIconLayer's handoff)
      // and must stay VISIBLE — below z12 it is the only representation an
      // isolated, never-clustered lead has. Flag off → the icon layer doesn't
      // exist (skipped above) and this behaves exactly as today.
      let v = vis;
      if (!fieldMap && id === STATUS_ICON_LAYER) v = "none";
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
      // Density tier first (sits UNDER the pin clusters) — same idempotent
      // installer the init block uses, so the two can never drift.
      ensureDensityLayers(map);
      // Re-add cluster source + layers after style swap — the SAME spec
      // factories the init block uses, so the two can never drift again (the
      // old hand-copied duplicate had already diverged: different radius
      // steps, opacity, and count text sizing).
      if (!map.getSource("leads-cluster")) {
        map.addSource("leads-cluster", LEADS_CLUSTER_SOURCE_SPEC);
        for (const spec of clusterLayerSpecs()) map.addLayer(spec);
        for (const spec of unclusteredLayerSpecs()) {
          const { before, ...layer } = spec;
          map.addLayer(layer, before);
        }
        // Per-rep halos — identical specs to the init block (see @/lib/leadHalos).
        for (const spec of haloLayerSpecs()) {
          map.addLayer(spec, haloBeforeId((id: string) => !!map.getLayer(id)));
        }
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
        // Outline only — mirrors the init block (owner: no fill while drawing).
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
      // the palette that suits it (white-on-imagery vs ink-on-streets), but
      // only when the settings-sheet preference has them on.
      if (showHouseNumsRef.current) ensureHousenumLayer(map, mapStyleMode);
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

  // House-numbers toggle — mounts/unmounts the provider-native layer live and
  // persists the choice. styleEpoch keeps it correct across basemap swaps
  // (setStyle wipes layers; the style.load re-add above also checks the ref).
  useEffect(() => {
    persistHouseNumbers(showHouseNums);
    const map = mapRef.current;
    if (!map || !mapReady) return;
    if (showHouseNums) ensureHousenumLayer(map, mapStyleMode);
    else removeHousenumLayer(map);
  }, [showHouseNums, mapReady, mapStyleMode, styleEpoch]);

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
    // …and suspend the BROWSER's gestures too, which the four lines above are
    // what re-enable. Mapbox drives the canvas's touch-action from classes it
    // only applies while drag-pan + touch-zoom-rotate are on, so disabling them
    // drops the canvas to touch-action: auto and the finger starts scrolling the
    // page — a downward stroke from scroll top being the pull-to-refresh gesture,
    // which is the "it reloads when I finish a lasso" report. See
    // lib/lassoGestureLock.ts. Released in this effect's cleanup, so it lifts on
    // completion, cancel, unmount, style swap and error alike.
    const releaseCanvas = lockGesturesForDrawing(mapGestureTarget(map));
    const releaseRoot = lockDocumentPullToRefresh(typeof document === "undefined" ? null : document);
    const releaseGestures = () => {
      releaseCanvas();
      releaseRoot();
    };

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
        (() => {
          // Display-only smoothing: the rep's RAW stroke keeps driving the
          // selection hit-test; only what they SEE is the smoothed curve.
          const disp = stroke.length >= 3
            ? chaikinSmooth(stroke.map(([x, y]) => ({ x, y })), 2, closeRing)
                .map(pt => [pt.x, pt.y] as [number, number])
            : stroke;
          return closeRing && disp.length >= 3
            ? {
                type: "Feature" as const,
                geometry: {
                  type: "Polygon" as const,
                  coordinates: [[...disp, disp[0]]],
                },
                properties: {},
              }
            : {
                type: "Feature" as const,
                geometry: { type: "LineString" as const, coordinates: disp },
                properties: {},
              };
        })();
      if (!lassoLayerRef.current) {
        try {
          map.addSource("lasso-polygon", { type: "geojson", data: geojson });
          map.addLayer({
            id: "lasso-fill",
            type: "fill",
            source: "lasso-polygon",
            // The colour the area will actually be saved in, so the preview is
            // a preview of the thing rather than a generic teal smear.
            paint: { "fill-color": lassoColorRef.current, "fill-opacity": 0.2 },
          });
          map.addLayer({
            id: "lasso-outline",
            type: "line",
            source: "lasso-polygon",
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
              "line-color": lassoColorRef.current,
              "line-width": 4.5,
              // Zero-length dashes + round caps = the evenly-spaced dot
              // boundary (the SalesHub selection look), in the area's color.
              "line-dasharray": [0, 2.2],
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

    // Mid-draw repaints are rAF-coalesced: render(false) runs chaikinSmooth
    // over the WHOLE stroke (up to 800 pts, 2 iterations ≈ 3,200 point
    // allocations plus the map→object→map conversions) and it fired once per
    // accepted pointer sample — up to 120Hz on high-rate pointers — while the
    // canvas can only present one frame. One smooth + setData per frame; the
    // flush reads the live `stroke` at fire time so it always paints the
    // latest samples. finish()/cancelStroke run synchronously and flip
    // `drawing`, so a trailing scheduled flush no-ops instead of repainting
    // the open line over the closed ring.
    const scheduleStrokeRender = createRafCoalescedFlush(() => {
      if (drawing) render(false);
    });

    const move = (lngLat: any, point: any) => {
      if (!drawing || stroke.length >= MAX_POINTS || !lastPx) return;
      const dx = point.x - lastPx.x,
        dy = point.y - lastPx.y;
      if (dx * dx + dy * dy < MIN_PX_DIST * MIN_PX_DIST) return;
      lastPx = { x: point.x, y: point.y };
      stroke.push([lngLat.lng, lngLat.lat]);
      scheduleStrokeRender();
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

      // ── Clean the stroke before anyone treats it as a polygon ──────────────
      // A finger produces a stream of samples, not a ring: repeated coordinates
      // where it paused, a hairline doubling-back where it wobbled, and up to
      // MAX_POINTS vertices that every subsequent point-in-polygon call has to
      // walk. shared/polygonGeometry turns that into a ring — or says why it
      // cannot. Nothing below this point ever touches the raw `stroke` again.
      const deduped = dedupeVertices(stroke);

      // Screened before anything measures the ring: every routine here (and
      // pointInPolygon on the server) is planar, so an edge spanning >180° of
      // longitude is computed the long way round the world and the area, the
      // enclosure test and the rendered fill are all meaningless.
      if (crossesAntimeridian(deduped)) {
        stroke = [];
        clearPreview();
        setLassoPoints([]);
        setLassoSelected([]);
        toast({
          title: "That loop wrapped around the world",
          description:
            "The shape spans more than half the globe, which usually means the map jumped while you were drawing. Try drawing it again.",
          variant: "destructive",
        });
        return;
      }

      const cleaned = simplifyRing(deduped, LASSO_SIMPLIFY_TOLERANCE_DEG);

      const verdict = validateRing(cleaned);
      if (!verdict.ok) {
        stroke = [];
        clearPreview();
        setLassoPoints([]);
        setLassoSelected([]);
        const message = LASSO_RING_REJECTION[verdict.reason];
        toast({
          title: message.title,
          description: message.description,
          variant: "destructive",
        });
        return;
      }

      // The validated ring — not the raw stroke — is what gets previewed,
      // saved and selected against, so the shape on screen, the shape in the
      // database and the shape the doors were tested against are one shape.
      const ring = verdict.ring;
      stroke = ring;
      render(true);
      // Select from the VISIBLE set (territory-clip + rep + status filters), so
      // a lasso only ever selects leads the user can actually see and assign —
      // never a hidden lead. Falls back to all leads if the map hasn't published
      // a filtered set yet. Bbox-rejected O(n + k·v) (see lib/mapGeo.ts).
      const source: MapPin[] =
        (window as any).__visibleLeads ?? (window as any).__allLeads ?? [];
      const selected = selectPointsInPolygon(source, ring);
      setLassoPoints(ring);
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
      // Give the page its gestures back FIRST. If a later line throws (a map
      // already torn down by unmount), the browser must not be left unable to
      // scroll — that failure mode is worse than the bug this fixes.
      releaseGestures();
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
        // Re-enable gestures BEFORE touching the canvas: if getCanvas() throws
        // on a torn-down map the catch must not have swallowed the re-enables —
        // a map with dead pan/zoom is a worse failure than a stale cursor.
        map.dragPan.enable();
        map.doubleClickZoom.enable();
        map.touchZoomRotate.enable();
        map.touchPitch?.enable();
        map.getCanvas().style.cursor = "";
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
        // Gestures first, cursor second — same rationale as the lasso cleanup.
        map.dragPan.enable();
        map.touchZoomRotate.enable();
        map.getCanvas().style.cursor = "";
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
    // Keyed by pin DISPLAY state (the legend rows' keys) — spriteDataUrl folds
    // each onto the canonical six pin designs.
    for (const ds of Object.keys(STATE_COLORS) as PinDisplayState[]) {
      const url = spriteDataUrl(ds, dpr);
      if (url) out[ds] = url;
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
    if (!(lead.id > 0)) return; // temp optimistic pin — selection waits for the reconcile
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

  // ── Existing-lead surfacing (phantom-duplicate fix) ────────────────────────
  // POST /api/leads answers a duplicate address with {existed:true, visibility}.
  // The map draws a pin ONLY when the lead is geocoded, not in a suppressing
  // status, in the caller's scope, and in the viewport — so the old blind
  // "select + flash" flashed nothing when the existing lead failed any of those,
  // producing "it says it already exists but there's no pin".
  //
  // Reason-aware, HONEST behavior (never fabricates a pin or access):
  //   • visible      → genuinely on the map: select + flash + fly (today's path).
  //   • ungeocoded / hidden_status / out_of_scope → name WHY in plain words, and
  //     OPEN THE LEAD BY ID when the caller may access it (visibility.inYourScope
  //     — the same gate GET /api/leads/:id uses, so opening can't 404). A rep
  //     locked out of an out-of-scope lead gets the plain explanation only.
  const openExistingLead = useCallback(
    (id: number, address: string, visibility?: LeadVisibility) => {
      const plan = planExistingLead(address, visibility);
      // Open by id BEFORE the fly: the sheet loads detail from /api/leads/:id and
      // no longer requires a rendered pin (see the selectedLead fallback below).
      // `plan.open` is false only for a rep locked out of an out-of-scope lead,
      // so we never hand them a 404.
      if (plan.open) setSelectedLeadId(id);
      if (plan.flash) {
        try {
          ringFlashRef.current = { at: performance.now(), color: STATE_COLORS.unworked };
        } catch { /* flash is best-effort */ }
      }
      if (plan.fly) {
        // The pin exists — fly to it once the cache settles this tick.
        requestAnimationFrame(() => {
          const pin =
            leadById.get(id) ??
            (qc.getQueryData<any>(["/api/leads/map"])?.pins ?? []).find(
              (p: MapPin) => p.id === id,
            );
          if (pin?.lat && pin?.lng) flyToLead(pin as MapPin);
        });
      }
      toast({
        title: plan.toastTitle,
        description: plan.toastDescription,
        ...(plan.severity ? { severity: plan.severity } : {}),
      });
    },
    [leadById, qc, flyToLead, toast],
  );
  // Keep the above-defined one-tap effect pointed at the latest closure.
  openExistingLeadRef.current = openExistingLead;

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
        description: "No open doors on your map right now - nice work.",
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
  // Status counts keyed on the pin DISPLAY state (not raw leadStatus) so every
  // filter row promises exactly the pins selecting it will paint — Not Home is
  // a first-class row, not folded into Prospect. ONE counting pass.
  const statusCounts = useMemo(() => {
    const acc: Record<string, number> = {};
    for (const l of repFilteredLeads) {
      const ds = pinDisplayState(l);
      acc[ds] = (acc[ds] ?? 0) + 1;
    }
    return acc;
  }, [repFilteredLeads]);
  // Source-option counts over the SAME lens (pre-status-filter). Zero-count
  // options are omitted — lead_tag is null for most pins today, so the FCC
  // pills only appear once FCC data actually exists (no dead UI).
  const sourceCountsMap = useMemo(() => countLeadsBySource(repFilteredLeads), [repFilteredLeads]);

  // ── Disposition selector options ────────────────────────────────────────────
  // "All" + one row per disposition that has pins, each with its pin color +
  // live count, in canvassing-funnel order. Feeds the compact filter control
  // AND the manager legend's status rows (one source → they can't disagree).
  const statusOptions = useMemo(
    () =>
      FILTER_STATUS_ORDER.filter((k) => (statusCounts[k] ?? 0) > 0).map((k) => ({
        key: k as string,
        count: statusCounts[k] ?? 0,
        bg: STATE_COLORS[k],
        label: STATE_LABELS[k],
      })),
    [statusCounts],
  );
  const activeStatusOption = useMemo(
    () => statusOptions.find((o) => o.key === filterStatus) ?? null,
    [statusOptions, filterStatus],
  );
  // ── Rep pin-colors key rows ─────────────────────────────────────────────────
  // The SIX core field dispositions always (a new hire learns the palette even
  // on an all-unworked street), plus any extra display state that currently has
  // pins (callback / contacted / already_customer). Colors, labels, and glyphs
  // are the same canonical sources the pins themselves paint from.
  const pinKeyItems = useMemo(() => {
    const core: ReadonlySet<PinDisplayState> = new Set([
      "unworked", "not_home", "interested", "follow_up", "sold", "not_interested",
    ]);
    return FILTER_STATUS_ORDER.filter(
      (k) => core.has(k) || (statusCounts[k] ?? 0) > 0,
    ).map((k) => ({
      key: k as string,
      label: STATE_LABELS[k],
      color: STATE_COLORS[k],
      count: statusCounts[k] ?? 0,
      glyph: legendGlyphs[k],
    }));
  }, [statusCounts, legendGlyphs]);
  // Active-filter chip presentation — honest even when the persisted filter
  // currently matches zero pins (option absent): label/color fall back to the
  // canonical display-state maps, never a misleading "All".
  const filterPillLabel =
    filterStatus === "all"
      ? "All"
      : (activeStatusOption?.label ??
        STATE_LABELS[filterStatus as PinDisplayState] ??
        filterStatus);
  const filterPillBg =
    activeStatusOption?.bg ??
    (filterStatus !== "all"
      ? (STATE_COLORS[filterStatus as PinDisplayState] ?? "#ffffff")
      : "#ffffff");

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

  // ── Filter sheet inputs ──────────────────────────────────────────────────
  // Statuses with pins, in funnel order — same rule statusOptions applies, so
  // the sheet's chips and the legacy pill can never list different statuses.
  const filterSheetStatusOrder = useMemo(
    () => statusOptions.map((o) => o.key),
    [statusOptions],
  );
  // Rep rows for the filter sheet: manager chrome only. Counts come from the
  // same one-pass tally the legend's rep rows read (repLeadCounts).
  const filterSheetReps = useMemo(
    () =>
      !isRep && canAssign
        ? team
            .filter((m) => m.active)
            .map((m) => ({
              id: m.id,
              name: m.name,
              count: repLeadCounts.counts.get(m.id) ?? 0,
            }))
        : undefined,
    [isRep, canAssign, team, repLeadCounts],
  );
  const mapFilterActive = filterStatus !== "all" || filterRep !== "all" || filterSource !== "all";
  // Lenses the density grid CANNOT express (never silently under-filter):
  // status and rep are pin-level predicates the aggregate doesn't take, and
  // field-verified is provenance (freshConfirmedAt), not a tag. While the
  // grid tier is active the filter sheet names exactly what's deferred.
  const gridHiddenLenses = [
    filterStatus !== "all" ? "Status" : null,
    filterRep !== "all" ? "Rep" : null,
    filterSource === "field_verified" ? "Field-verified" : null,
  ].filter(Boolean) as string[];
  // Chip text: status label, rep name, source, or any combination —
  // "{label} · {n}" renders in the top-center chip whenever mapFilterActive
  // (state is never invisible).
  const activeFilterChipLabel = [
    filterStatus !== "all" ? filterPillLabel : null,
    filterRep !== "all"
      ? filterRep === "unassigned"
        ? "Unassigned"
        : (repNameById.get(Number(filterRep)) ?? "Rep filter")
      : null,
    filterSource !== "all"
      ? (LEAD_SOURCE_OPTIONS.find((o) => o.key === filterSource)?.label ?? filterSource)
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  // On-map search — lowercase haystack built ONCE per data load (O(n)), so a
  // keystroke never re-lowercases 50k addresses. A NUL separates the two
  // fields so a query can't falsely match across the address/city boundary.
  // Gated on searchOpen: "once per data load" is far more often than it sounds
  // — `leads` gets a new identity on every knock, every live push and every
  // viewport merge (i.e. every pan). Reps who never open search were paying an
  // object allocation and a toLowerCase per pin on every one of those, for an
  // index nothing was going to read. Opening the panel builds it once.
  const searchIndex = useMemo(
    () =>
      searchOpen
        ? leads.map((l) => ({
            l,
            hay: (l.address + "\u0000" + (l.city ?? "")).toLowerCase(),
          }))
        : EMPTY_SEARCH_INDEX,
    [leads, searchOpen],
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
  // Layout's FieldStatusBar mounts this canonical hook before page content.
  // MapView consumes the same authenticated-owner singleton instead of
  // registering another saved callback whose behavior depends on mount order.
  const { log: logKnock, snap: queueSnap } = useKnockLogger();
  // Sub-second online saves must not flash the "to sync" badge (owner report:
  // "why do I still see syncing"); it appears only when knocks have genuinely
  // been waiting — offline, or a delivery that isn't going through.
  const queueBacklog = useSustained(queueSnap.pendingCount > 0, 3000);

  // ── Live lead pushes ────────────────────────────────────────────────────────
  // GET /api/leads/stream carries server-authored, access-checked per-lead
  // changes. This is a strict upgrade on the data-free `map-changed` ping below
  // it, which can only say "something moved, refetch everything": a rep now
  // sees a teammate close the house next door as it happens, and a 5.5k-row
  // refetch is not the price of a one-pin change.
  //
  // Both channels stay wired on purpose. The stream patches; the 60s poll and
  // the map-changed invalidate remain the floor, and are the only thing running
  // when the stream is degraded (see onFallback).
  const canUseFieldApp = useCan("field.app.use");
  const [leadStream, setLeadStream] = useState<LeadStreamHandle | null>(null);
  const streamHoldsRef = useRef(new Map<number, () => void>());

  const applyLeadEvent = useCallback(
    (evt: LeadStreamEvent) => {
      const pushed = evt.lead;
      // No row left to project — the door was deleted. Same cache shape as
      // handleDeleteLead; the reconcile effect prunes the feature from the
      // rebuilt collection, so there is nothing to paint imperatively.
      if (!pushed) {
        qc.setQueryData(["/api/leads/map"], (old: any) => {
          if (!old?.pins || pinIndexOf(old.pins, evt.leadId) < 0) return old;
          return {
            ...old,
            total: Math.max(0, (old.total ?? old.pins.length) - 1),
            pins: old.pins.filter((p: MapPin) => p.id !== evt.leadId),
          };
        });
        return;
      }

      // Holder rather than a plain `let`: the updater runs inside setQueryData,
      // and TS narrows a closure-assigned local to its initializer.
      const out: { pin?: MapPin } = {};
      qc.setQueryData(["/api/leads/map"], (old: any) => {
        // Cache not warm yet: the first GET is still in flight and will carry
        // this row itself. Seeding a lone pin here would render a map of one.
        if (!old?.pins) return old;
        const index = pinIndexOf(old.pins, pushed.id);
        if (index < 0) {
          // A door that just entered this user's scope (assigned to their area,
          // or created by a scan). The server already ran repCanAccessLead
          // against the post-write row, so it is theirs to see.
          if (pushed.lat == null || pushed.lng == null) return old;
          out.pin = pinFromPushedLead(pushed);
          return { ...old, total: (old.total ?? old.pins.length) + 1, pins: [...old.pins, out.pin] };
        }
        const prev = old.pins[index] as MapPin;
        const next = mergePushedPin(prev, pushed);
        if (next === prev) return old; // no-op push — do not churn the cache
        out.pin = next;
        const pins = old.pins.slice();
        pins[index] = next;
        return { ...old, pins };
      });
      const merged = out.pin;
      if (!merged) return;

      // Paint the one pin NOW rather than waiting for the render the cache write
      // just scheduled, then let the reconcile effect skip its duplicate full
      // setData — the exact path handleKnock uses. There is no second repaint
      // mechanism here on purpose.
      const feature = featureByIdRef.current.get(pushed.id);
      if (!feature) return; // brand-new door — reconcile builds and paints it
      // EVERY feature property mergePushedPin can move is rewritten here, not
      // just the ones this event happened to change. The skip-guard below hands
      // Mapbox this mutated feature and then suppresses the rebuild's setData,
      // so the two representations must agree exactly — a prop the merge moved
      // but the mutation missed (a leadTag flipping to fresh, a geocode
      // correction) would sit unpainted until something unrelated forced a full
      // setData. Fields the merge moves that features do NOT carry
      // (assignMark / doNotKnock / lastOutcomeAt) live only in the cache pin
      // the card and the next merge read — nothing to paint for them.
      const ds = pinDisplayState(merged);
      const props = feature.properties;
      feature.geometry.coordinates = [merged.lng, merged.lat];
      props.status = toLeadMapStatus(ds);
      props.ds = ds;
      props.address = merged.address;
      props.visited = merged.visited ? 1 : 0;
      props.fresh = merged.leadTag === "fresh_fiber_confirmed" ? 1 : 0;
      props.assignedRepId = merged.assignedRepId ?? 0;
      props.repColor = repColorFor(merged.assignedRepId);
      // An assignment event is exactly the case the halo exists for, so the
      // rings have to move with it. Slots are written even when undefined:
      // leaving a stale halo1 behind on a door that lost a rep would paint a
      // ring for someone who no longer works it.
      const halo = haloFeatureProps(haloRepIdsForRef.current(merged));
      props.haloCount = halo.haloCount;
      props.halo0 = halo.halo0;
      props.halo1 = halo.halo1;
      props.halo2 = halo.halo2;
      pendingKnockPaintRef.current = pushed.id;
      scheduleClusterSetData(); // coalesced: ≤1 worker re-cluster per frame
    },
    [qc, scheduleClusterSetData],
  );
  // Kept behind a ref so the subscription below depends only on identity, not
  // on every render — reconnecting the stream costs a full replay window.
  const applyLeadEventRef = useRef(applyLeadEvent);
  applyLeadEventRef.current = applyLeadEvent;

  useEffect(() => {
    // Same gate the endpoint enforces (requireCapability("field.app.use")).
    // Opening a socket a calling-only role will be 403'd on is pure radio burn.
    // tabActive: a hidden kept map drops the socket too — Last-Event-ID replay
    // (or the onResync full refetch) reconciles on re-show.
    if (!user || !canUseFieldApp || !tabActive) return;
    const handle = subscribeLeadStream({
      // Sessions here are an x-session-id HEADER, which native EventSource
      // cannot send — it would 401 forever. Read per connect so a refreshed
      // token is picked up on reconnect instead of frozen at subscribe time.
      EventSourceImpl: createFetchEventSource({
        headers: (): Record<string, string> => {
          const sessionId = getStoredSessionId();
          return sessionId ? { "x-session-id": sessionId } : {};
        },
      }),
      onEvent: (evt) => applyLeadEventRef.current(evt),
      // The cursor is gone (evicted from the reconnect ring, or minted by a
      // process that has since restarted). Patching from here would leave holes
      // nothing downstream can detect, so the whole scope is refetched.
      onResync: () => {
        if (viewportModeRef.current) refreshViewportPinsRef.current();
        else void qc.invalidateQueries({ queryKey: ["/api/leads/map"] });
      },
      // Fallback = the pre-existing refetch behaviour is the only truth again.
      // It never stopped running, so there is nothing to switch on; what this
      // edge buys is immediacy. Going degraded pulls once so the map is not up
      // to 60s stale on the way down, and recovering pulls once to close the
      // window between the last poll and the first live frame.
      onFallback: () => {
        if (viewportModeRef.current) refreshViewportPinsRef.current();
        else void qc.invalidateQueries({ queryKey: ["/api/leads/map"] });
      },
    });
    setLeadStream(handle);
    return () => {
      handle.close();
      // Holds live inside the handle that just died; the map must not keep
      // release closures pointing at it.
      streamHoldsRef.current.clear();
      setLeadStream(null);
    };
  }, [user?.id, canUseFieldApp, qc, tabActive]);

  // ── Do not repaint a door the rep is still saving ───────────────────────────
  // A push applied over an in-flight knock shows the rep their own tap being
  // undone by their own network. The queue's byLead map is the right source for
  // "mine, unsettled": it is durable (rehydrated from localStorage on reload),
  // it already exists, and it cannot leak a hold the way a hand-wired
  // hold/release pair around each mutation would — knockQueue's dead-letter
  // path has no success callback at all.
  //
  // "error" (dead-lettered) deliberately does NOT hold. That knock is not
  // coming back on its own, and the optimistic recolor useKnockLogger wrote is
  // never rolled back — so continuing to defend it would pin a wrong colour on
  // the door indefinitely. Releasing lets the server's truth correct it.
  useEffect(() => {
    const held = streamHoldsRef.current;
    if (!leadStream) return;
    const byLead = queueSnap.byLead;
    const unsettled = (id: number) => byLead[id] === "saving" || byLead[id] === "queued";
    for (const [leadId, release] of held) {
      if (unsettled(leadId)) continue;
      release(); // delivers the newest push withheld while this door was busy
      held.delete(leadId);
    }
    for (const key of Object.keys(byLead)) {
      const leadId = Number(key);
      if (unsettled(leadId) && !held.has(leadId)) held.set(leadId, leadStream.hold(leadId));
    }
  }, [leadStream, queueSnap]);

  const selectedPin =
    selectedLeadId != null ? (leadById.get(selectedLeadId) ?? null) : null;
  // Phantom-duplicate fix: a lead surfaced via the existed handler may have NO
  // pin on this map (ungeocoded, held-back status, or off-viewport but IN the
  // caller's scope). The knock sheet mounts off the `lead` prop, which normally
  // comes only from the pin cache — so with no pin it never opened. When a
  // positive id is selected but absent from the pin cache, fetch its detail
  // (shares the SAME queryKey the sheet's own detailQuery uses, so no extra
  // request) and synthesize a minimal SheetLead so the sheet opens from the id
  // alone. This is the ONLY consumer of this fetch — the map pin pipeline is
  // untouched, no fabricated pin ever enters the map cache.
  const needsDetailFallback =
    selectedLeadId != null && selectedLeadId > 0 && selectedPin == null;
  const selectedDetailQuery = useQuery<any>({
    queryKey: [`/api/leads/${selectedLeadId}`],
    enabled: needsDetailFallback,
    staleTime: 30_000,
  });
  const selectedLead: SheetLead | null = selectedPin
    ? selectedPin
    : needsDetailFallback && selectedDetailQuery.data
      ? {
          id: selectedDetailQuery.data.id,
          address: selectedDetailQuery.data.address ?? "",
          city: selectedDetailQuery.data.city ?? null,
          state: selectedDetailQuery.data.state ?? null,
          zip: selectedDetailQuery.data.zip ?? null,
          lat: selectedDetailQuery.data.lat ?? null,
          lng: selectedDetailQuery.data.lng ?? null,
          leadStatus: selectedDetailQuery.data.leadStatus ?? "prospect",
          assignedRepId: selectedDetailQuery.data.assignedRepId ?? null,
          leadTag: selectedDetailQuery.data.leadTag ?? null,
        }
      : null;

  // One-tap disposition: optimistic pin recolor FIRST (marking a door must feel
  // instant in the field), then the offline-safe enqueue. useKnockLogger owns
  // retries, idempotency, and authoritative saved reconciliation.
  // The card's chip, timestamp, and active pill all read from this same
  // optimistic pin data, so a single tap updates everything at once.
  // CENTRAL MARK (owner ask 2026-07-26): managers mark an outcome on behalf of
  // the central team — no rep credit, no commission. Optimistic pin recolor,
  // same imperative paint path as a rep knock.
  const handleCentralMark = useCallback(
    async (outcome: KnockOutcome): Promise<boolean> => {
      const lead = selectedLeadId != null ? leadById.get(selectedLeadId) : undefined;
      if (!lead || !canManage) return false;
      // Recolor BEFORE the network — a central mark must feel as instant as a
      // rep knock. The expected state comes from the same outcome→status table
      // the server applies; the response reconciles below if it disagrees.
      const nextLeadStatus = OUTCOME_TO_STATUS[outcome] ?? lead.leadStatus;
      const optimisticDs = pinDisplayState({ leadStatus: nextLeadStatus, visited: true, lastOutcome: outcome });
      const feature = featureByIdRef.current.get(lead.id);
      const prevProps = feature
        ? { status: feature.properties.status, ds: feature.properties.ds, visited: feature.properties.visited }
        : null;
      if (feature) {
        feature.properties.status = toLeadMapStatus(optimisticDs);
        feature.properties.ds = optimisticDs;
        feature.properties.visited = 1;
        scheduleClusterSetData(); // coalesced: ≤1 worker re-cluster per frame
      }
      const snapPins = qc.getQueryData<any>(["/api/leads/map"])?.pins as MapPin[] | undefined;
      const prevPinIdx = snapPins ? pinIndexOf(snapPins, lead.id) : -1;
      const prevPin = prevPinIdx >= 0 ? snapPins![prevPinIdx] : undefined;
      // lastOutcomeAt mirrors the server's CAS clock (central-disposition
      // stamps last_outcome_at with its own now()) so the stream merge's
      // recency comparison holds the mark against any older push in flight.
      const optimisticAt = new Date().toISOString();
      qc.setQueryData(["/api/leads/map"], (old: any) => {
        if (!old?.pins) return old;
        const i = pinIndexOf(old.pins, lead.id);
        if (i < 0) return old; // door not in this window — nothing to recolor
        const pins = old.pins.slice();
        pins[i] = { ...pins[i], leadStatus: nextLeadStatus, visited: true, lastOutcome: outcome, lastOutcomeAt: optimisticAt };
        return { ...old, pins };
      });
      try { navigator.vibrate?.(10); } catch { /* */ }
      toast({ title: "Marked centrally", severity: "success", description: `${lead.address}: ${OUTCOME_META[outcome]?.label ?? outcome}` });
      try {
        const res = await apiRequest("POST", `/api/leads/${lead.id}/central-disposition`, { outcome });
        const updated = await res.json();
        // Reconcile: the server is authoritative on leadStatus (CAS ordering
        // can pick a different winner than the local table).
        const serverDs = pinDisplayState({ leadStatus: updated.leadStatus, visited: true, lastOutcome: outcome });
        if (feature && serverDs !== optimisticDs) {
          feature.properties.status = toLeadMapStatus(serverDs);
          feature.properties.ds = serverDs;
          scheduleClusterSetData();
        }
        // Reconcile the cache pin to the SERVER's row unconditionally — most
        // importantly its CAS clock. The optimistic lastOutcomeAt above was
        // the CLIENT clock; if this device runs ahead of the server, the pin
        // would defend its outcome with a future timestamp: the stream echo of
        // this very mark loses the recency comparison (mergePushedPin), and so
        // does every GENUINELY newer push (a teammate's later knock) until a
        // full refetch replaces the pin — which viewport mode never does
        // without a pan. Adopting the response's last_outcome_at re-anchors
        // the local clock to server truth the moment the write lands.
        qc.setQueryData(["/api/leads/map"], (old: any) => {
          if (!old?.pins) return old;
          const i = pinIndexOf(old.pins, lead.id);
          if (i < 0) return old;
          const pins = old.pins.slice();
          pins[i] = {
            ...pins[i],
            leadStatus: updated.leadStatus ?? nextLeadStatus,
            lastOutcome: updated.lastOutcome ?? outcome,
            lastOutcomeAt: updated.lastOutcomeAt ?? pins[i].lastOutcomeAt,
          };
          return { ...old, pins };
        });
        // The server writes a [central]-flagged knock row, so History HAS a new
        // entry — but the card fetched that query when it opened and nothing
        // told it to look again. Result: "No changes yet" under a mark you just
        // made. The knock path invalidates these; this path updated the pin and
        // the map cache and forgot the card it was rendered inside.
        qc.invalidateQueries({ queryKey: [`/api/leads/${lead.id}/history`] });
        qc.invalidateQueries({ queryKey: [`/api/leads/${lead.id}`] });
        // Same read models a saved knock refreshes — without these the Leads
        // list and Follow-ups kept the old state until a hard reload.
        qc.invalidateQueries({ queryKey: ["/api/leads"] });
        qc.invalidateQueries({ queryKey: ["/api/followups"] });
        return true;
      } catch (e: any) {
        // Roll the door back to exactly what the rep saw before the tap.
        if (feature && prevProps) {
          feature.properties.status = prevProps.status;
          feature.properties.ds = prevProps.ds;
          feature.properties.visited = prevProps.visited;
          scheduleClusterSetData();
        }
        if (prevPin) {
          qc.setQueryData(["/api/leads/map"], (old: any) => {
            if (!old?.pins) return old;
            const i = pinIndexOf(old.pins, lead.id);
            if (i < 0) return old;
            const pins = old.pins.slice();
            pins[i] = prevPin;
            return { ...old, pins };
          });
        }
        toast({ title: "Central mark failed - reverted", description: String(e?.message ?? e), variant: "destructive" });
        return false;
      }
    },
    [selectedLeadId, leadById, canManage, qc, toast, scheduleClusterSetData],
  );

  // DELETE LEAD (owner ask 2026-07-26): managers remove a manually-added pin
  // when the area turns out not to be new fiber. Pin vanishes from the map +
  // panel; the card closes.
  const handleDeleteLead = useCallback(
    async () => {
      const lead = selectedLeadId != null ? leadById.get(selectedLeadId) : undefined;
      if (!lead || !canManage) return;
      // Vanish BEFORE the network — the round-trip is the whole reason delete
      // felt slow. Snapshot enough to re-add the pin (not a wholesale GeoJSON
      // snapshot: other doors may legitimately change while this is in flight).
      const prevFeature = featureByIdRef.current.get(lead.id);
      const prevPin = (qc.getQueryData<any>(["/api/leads/map"])?.pins ?? []).find((p: any) => p.id === lead.id);
      featureByIdRef.current.delete(lead.id);
      if (geoJsonDataRef.current?.features) {
        geoJsonDataRef.current = {
          ...geoJsonDataRef.current,
          features: geoJsonDataRef.current.features.filter((f: any) => f.id !== lead.id && f?.properties?.id !== lead.id),
        };
        scheduleClusterSetData(); // coalesced: ≤1 worker re-cluster per frame
      }
      qc.setQueryData(["/api/leads/map"], (old: any) => {
        if (!old?.pins) return old;
        return { ...old, total: Math.max(0, (old.total ?? old.pins.length) - 1), pins: old.pins.filter((p: any) => p.id !== lead.id) };
      });
      setSelectedLeadId(null);
      toast({ title: "Lead removed", severity: "success", description: lead.address });
      try {
        await apiRequest("DELETE", `/api/leads/${lead.id}`);
        // Background reconcile so the Leads list and dashboards drop the row too.
        qc.invalidateQueries({ queryKey: ["/api/leads"] });
        qc.invalidateQueries({ queryKey: ["/api/stats"] });
      } catch (e: any) {
        // Put the door back exactly where it was.
        if (prevFeature) {
          featureByIdRef.current.set(lead.id, prevFeature);
          if (geoJsonDataRef.current?.features) {
            geoJsonDataRef.current = {
              ...geoJsonDataRef.current,
              features: [...geoJsonDataRef.current.features, prevFeature],
            };
            scheduleClusterSetData();
          }
        }
        if (prevPin) {
          qc.setQueryData(["/api/leads/map"], (old: any) => {
            if (!old?.pins || old.pins.some((p: any) => p.id === lead.id)) return old;
            return { ...old, total: (old.total ?? old.pins.length) + 1, pins: [...old.pins, prevPin] };
          });
        }
        toast({ title: "Delete failed - lead restored", description: String(e?.message ?? e), variant: "destructive" });
      }
    },
    [selectedLeadId, leadById, canManage, qc, toast, setSelectedLeadId, scheduleClusterSetData],
  );

  const handleKnock = useCallback(
    (outcome: KnockOutcome): boolean => {
      const lead =
        selectedLeadId != null ? leadById.get(selectedLeadId) : undefined;
      if (!lead) return false;
      // A tap with NOBODY to credit — Central Admin (no linked rep profile) on
      // an unassigned door — IS a central mark, not an error. The rep-credit
      // knock path exists to pay a rep, and there is no rep here; routing the
      // tap replaces the "This lead has no rep assigned" dead end from the
      // field report. Central mark shows its own success/failure toast and
      // updates the same caches the knock path would.
      if (canManage && resolveCreditedRepId(user, lead.assignedRepId) == null) {
        void handleCentralMark(outcome);
        return true;
      }
      if (!logKnock(lead, outcome)) return false;

      const nextLeadStatus = OUTCOME_TO_STATUS[outcome] ?? lead.leadStatus;
      const nextDisplayState = pinDisplayState({
        leadStatus: nextLeadStatus,
        visited: true,
        lastOutcome: outcome,
      });

      // Mutate exactly one GeoJSON feature and hand the same collection back to
      // Mapbox on the next animation frame (coalesced). React does not rebuild
      // 5,000 lead components because the pins are not components or HTML markers.
      const feature = featureByIdRef.current.get(lead.id);
      if (feature) {
        feature.properties.status = toLeadMapStatus(nextDisplayState);
        feature.properties.ds = nextDisplayState;
        feature.properties.visited = 1;
        // Coalesced repaint: the mutation above is synchronous, the worker
        // re-cluster rides the next animation frame (≤1 setData per frame).
        scheduleClusterSetData();
        // This pin's paint is scheduled; let the reconcile effect skip its
        // duplicate full setData when the optimistic update lands.
        pendingKnockPaintRef.current = lead.id;
      }
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
      return true;
    },
    [leadById, selectedLeadId, logKnock, scheduleClusterSetData, canManage, user, handleCentralMark],
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
      // Nobody is looking: skip the paint writes entirely. Browsers usually
      // pause rAF for a hidden tab, but Android WebViews and installed PWAs do
      // not always, and each accepted frame forces a full GL repaint of the map.
      // Same when the MAP STAGE is hidden by keep-alive (display:none never
      // pauses rAF — the browser tab is still visible): paint-writing a
      // hidden canvas is pure battery burn.
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        raf = requestAnimationFrame(tick);
        return;
      }
      if (!tabActiveRef.current) {
        raf = requestAnimationFrame(tick);
        return;
      }
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
  // armed hints > Live Test > nothing ("fabs" = the resting, empty state — the
  // Scan Map button moved into the More menu).
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

  // (No secondary-chrome fade: the control rail is primary chrome and stays
  // visible through every pan/zoom — the auto-hide machinery is gone.)

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

      {/* Scan Map moved off the map surface into the More (tools) popover —
          "Scan map" entry, same handler, same canSubmitScan gate. The armed
          hint, progress sheet, and summary below are unchanged. */}

      {/* Live Test panel — trace one address, right on the field scanner. */}
      {liveTestOpen && canSubmitScan && bottomSlot === "livetest" && (
        <div
          style={{ bottom: "calc(env(safe-area-inset-bottom) + 1.25rem)" }}
          className="absolute left-1/2 z-30 w-[min(456px,calc(100vw-24px))] -translate-x-1/2"
        >
          <div className="glass-surface flex flex-col gap-2 border-teal-300/40 p-3" data-testid="live-test-panel">
            <div className="flex items-center gap-2">
              
              <span className="text-[13px] font-semibold text-white">Live Test - trace one address</span>
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
                  {ltResult.checked ? `Checked - ${ltResult.classification}${ltResult.wouldSaveLead ? " (fresh lead)" : ""}` : ltResult.pendingAuth ? "PENDING_AUTH - token/auth flow failed after retry. Address kept for retry, NOT a no-service verdict." : "Not checked - failed at the red stage (infra error, not a no-service verdict)."}
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
                  null
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
                      title="Minimize - the scan keeps running"
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
                  { label: "Failed", full: "Unresolved - couldn't conclusively check", value: scanSummary.unresolved, tone: "text-white/50" },
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
                    
                    <span>
                      OpenStreetMap coverage looks{" "}
                      {String(scanSummary.coverage) === "sparse_source_data" || String(scanSummary.coverage) === "source_unavailable"
                        ? "sparse"
                        : "partial"}{" "}
                      here - some properties may not be mapped yet, so this isn't guaranteed to be every address.
                    </span>
                  </div>
                )}
            </div>
          </div>
        )}

      {/* The always-on status pill / chip row is gone (owner's minimal-map
          directive): the Filters sheet (rail button) is the one filter surface.
          An ACTIVE filter is never invisible - the rail button carries a dot and
          a dismissible top-center chip renders inside the map below. */}

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
              
              <span className="flex-1 text-left">
                {pendingRequests.length} territory request
                {pendingRequests.length !== 1 ? "s" : ""}
              </span>
              <span className="text-[10px] text-muted-foreground">
                {showTerritoryRequests ? "Hide" : "Show"}
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
            {/* rep-clean-map hides the native Mapbox top-right control stack on
                EVERY screen (owner's minimal directive): zoom is pinch/scroll/
                double-click, locate is our FAB — the GeolocateControl stays
                mounted for its state machine but never shows its own button. */}
            <div
              ref={mapContainer}
              className="rep-clean-map"
              style={{ width: "100%", height: "100%" }}
            />
          </div>

          {/* No blocking "loading" overlay while the GL map spins up: the map
              canvas itself is the initial state, and the snapshot-seeded pins
              paint on its first styled frame. The only full-cover state left
              is the unrecoverable missing-token config error below. */}
          {noToken && (
            <div className="absolute inset-0 flex items-center justify-center bg-card/95 z-10 px-6">
              <div className="text-center max-w-xs">
                
                {mapFailureKind === "library" ? (
                  <>
                    <div className="text-sm font-medium mb-1">Map couldn't load</div>
                    <div className="text-xs text-muted-foreground">
                      The map library didn't download. Check your signal - your leads and
                      knocks still work.
                    </div>
                    <button
                      type="button"
                      data-testid="map-retry-button"
                      onClick={retryMapbox}
                      className="mt-4 inline-flex min-h-11 items-center rounded-xl bg-primary px-4 text-[13px] font-semibold text-primary-foreground active:scale-[.98] transition"
                    >
                      Try again
                    </button>
                  </>
                ) : (
                  <>
                    <div className="text-sm font-medium mb-1">Mapbox token needed</div>
                    <div className="text-xs text-muted-foreground">
                      Add MAPBOX_TOKEN to server .env
                    </div>
                  </>
                )}
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

          {/* First-use empty state — EVERY role. A brand-new org (or a rep with
              nothing assigned yet) gets one line of guidance, not a blank map
              over a random town. Gated on the pins payload having ARRIVED
              (snapshot or fetch): while the first load is still in flight the
              map must not claim "no leads" for a few seconds (owner report).
              NEVER in viewport mode: there the cache is a window — empty means
              unfetched/over-water/sampled, and the mode itself proves the org
              has >threshold leads (the zoom/sample chips carry the truth). */}
          {mapReady && firstUseEmptyStateEnabled({ viewportMode, pinsArrived: mapPinData != null, leadCount: leads.length }) && (
            <div
              className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none px-6"
              data-testid="map-empty-state"
            >
              <div className="glass-surface pointer-events-none max-w-xs text-center p-6">
                
                <p className="text-sm font-semibold text-white">
                  {isRep ? "No doors assigned yet" : "No leads on the map yet"}
                </p>
                <p className="text-xs text-white/60 mt-1.5 leading-relaxed">
                  {isAdmin
                    ? "Draw a box with the scan tool to find new-fiber homes, or import a list - they'll appear here as assignable pins."
                    : isRep
                      ? "Doors assigned to you will appear here - check with your team lead."
                      : "Once your team is assigned leads or territories, they'll show up here."}
                </p>
              </div>
            </div>
          )}

          {/* All-filtered-out state — the filters currently hide EVERY door. A
              blank map with an active filter reads as "no leads"; say what
              happened in one line with the fix one tap away. */}
          {mapReady &&
            mapFilterActive &&
            territoryClippedLeads.length > 0 &&
            mapTotalLeads.length === 0 && (
              <div
                className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none px-6"
                data-testid="map-all-filtered"
              >
                <div className="glass-capsule glass-opaque pointer-events-auto flex items-stretch overflow-hidden">
                  <span className="flex items-center pl-4 pr-3 py-2 min-h-11 text-[13px] font-medium text-white tabular-nums whitespace-nowrap">
                    {formatFilterCount(territoryClippedLeads.length)} doors hidden by filters
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setFilterStatus("all");
                      setFilterRep("all");
                      // The source lens can be the SOLE cause of the empty map
                      // now that "latest" is the default (a footprint-only
                      // tenant) — a Clear that leaves it on would be dead UI.
                      setFilterSource("all");
                    }}
                    data-testid="map-all-filtered-clear"
                    className={`min-h-11 px-3.5 text-[13px] font-semibold text-teal-300 hover:text-teal-200 hover:bg-white/[0.06] border-l border-white/10 transition ${FOCUS}`}
                  >
                    Clear
                  </button>
                </div>
              </div>
            )}

          {/* ── Active-filter chip — the ONE piece of filter chrome on the map.
                 Renders only while a filter is narrowing pins ("{label} · {n}"
                 with an X that clears everything), top-center so filter state is
                 never invisible even though the pill/legend strips are gone. */}
          {mapReady && mapFilterActive && (
            <div
              style={{ top: "calc(env(safe-area-inset-top) + 0.75rem)" }}
              className="glass-capsule glass-opaque absolute left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 pl-3 pr-1 h-9 max-w-[70vw]"
              data-testid="map-active-filter-chip"
            >
              <span
                className="w-2 h-2 rounded-full shrink-0"
                aria-hidden="true"
                style={{
                  background: filterPillBg === "#ffffff" ? "#0d9488" : filterPillBg,
                }}
              />
              <span className="text-[12px] font-semibold text-white truncate whitespace-nowrap">
                {activeFilterChipLabel}
                <span className="text-white/60 font-medium">
                  {" "}
                  {/* Viewport mode holds only a WINDOW of the org's pins, so a
                      client-side count under-reports the lens badly (the pill
                      read "20.6k" while the lens held 62k). When the source
                      lens is the only active filter the probe's server total
                      is the truth; any status/rep narrowing falls back to the
                      loaded-window count — best available client-side. */}
                  · {formatFilterCount(
                    viewportMode && filterStatus === "all" && filterRep === "all" && mapPinCount?.total != null
                      ? mapPinCount.total
                      : mapTotalLeads.length,
                  )}
                </span>
              </span>
              <button
                type="button"
                onClick={() => {
                  setFilterStatus("all");
                  setFilterRep("all");
                  setFilterSource("all");
                }}
                aria-label="Clear map filters"
                data-testid="map-active-filter-clear"
                className="relative w-7 h-7 shrink-0 rounded-full flex items-center justify-center text-white/70 hover:text-white hover:bg-white/10 transition after:absolute after:-inset-2"
              >
                <X className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            </div>
          )}

          {/* ── Viewport-mode notice — the map is under-showing pins and the
                 user must know. Rare now: an over-cap window flips to the
                 density grid (real counts — nothing hidden, no notice), so
                 this only covers the transient where stale loaded pins are
                 known-partial while still on the pins tier. ── */}
          {mapReady && (() => {
            const notice = viewportNotice({
              viewportMode,
              truncated: !!mapPinData?.truncated,
              sampleDismissed: sampleNoticeDismissed,
              tier: viewportTier,
            });
            if (!notice) return null;
            return (
              <MapViewportNotice
                message={notice.message}
                onDismiss={() => setSampleNoticeDismissed(true)}
                testId={`map-viewport-${notice.kind}-notice`}
              />
            );
          })()}

          {/* ── Lens-hiding notice — the source lens is filtering doors out of
                 THIS viewer's own scope. Silent filtering is the failure this
                 fixes: an assigned FCC-footprint block behind the default
                 "Latest fiber" lens looked to the rep exactly like never having
                 been assigned anything at all. ── */}
          {mapReady && showLensNotice && (
            <MapLensNotice
              hiddenCount={hiddenByLens}
              lensLabel={LEAD_SOURCE_OPTIONS.find(o => o.key === filterSource)?.label ?? "this filter"}
              onShowAll={() => setFilterSource("all")}
              onDismiss={() => setLensNoticeDismissedFor(filterSource)}
            />
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

          {/* Offline-queue badge — knocks GENUINELY waiting (sustained 3s+,
              never the blip of a normal online save). Hugs the edge on mobile
              rep screens where the Mapbox control stack is hidden. */}
          {useSheet && queueBacklog && queueSnap.pendingCount > 0 && (
            <div
              data-testid="knock-pending-badge"
              // Safe-area aware (top-3 sat under the notch). Kept clear of the
              // top-center active-filter chip on every screen; the top-right
              // corner itself is otherwise chrome-free now.
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
              {!lassoDrawn ? (
                /* Armed, nothing drawn yet → drawing hint */
                <div className="glass-capsule flex items-center gap-2.5 border-teal-300/40 pl-4 pr-2 py-2 animate-in fade-in slide-in-from-bottom-2 duration-200">
                  
                  <span className="text-[13px] font-medium text-white whitespace-nowrap">
                    Drag a loop around the area
                  </span>
                  <button
                    type="button"
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
                <div className="glass-surface flex flex-col gap-2.5 border-teal-300/40 px-3 py-2.5 animate-in fade-in slide-in-from-bottom-2 duration-200 w-[min(468px,calc(100vw-24px))] max-h-[calc(100dvh-7rem)] overflow-y-auto">
                  {/* Count + per-status breakdown; tap a chip to include/exclude it.
                      With no doors in the loop there is nothing to break down and
                      nothing to refine — say so plainly instead of showing "0/0"
                      beside a row of chips that cannot exist. */}
                  {/* Headline — the refined selection count, plus the panel's
                      close control (SalesRabbit tile grammar). */}
                  <div className="flex items-center gap-2">
                    <span
                      className="flex-1 min-w-0 text-[15px] font-bold text-white tabular-nums"
                      aria-live="polite"
                    >
                      {lassoActive.length}{" "}
                      {lassoActive.length === 1 ? "door" : "doors"} selected
                      {lassoHasLeads &&
                        lassoActive.length !== lassoSelected.length && (
                          <span className="text-white/55 font-medium">
                            {" "}
                            of {lassoSelected.length}
                          </span>
                        )}
                    </span>
                    <button
                      type="button"
                      onClick={exitLasso}
                      className={`w-11 h-11 -my-1.5 rounded-full flex items-center justify-center text-white/70 hover:text-white hover:bg-white/10 transition-colors flex-shrink-0 ${FOCUS}`}
                      aria-label="Exit area selection"
                      title="Exit"
                      data-testid="lasso-exit"
                    >
                      <X className="w-4 h-4" aria-hidden="true" />
                    </button>
                  </div>

                  {/* Sampled-window honesty: past the viewport threshold a
                      wide zoom ships an even SAMPLE of the window's pins
                      (truncated:true), and the lasso can only ENUMERATE pins the
                      client holds — so any id-based action silently skips every
                      unsampled door inside the loop.
                      Assign no longer belongs in that list: it posts the RING to
                      /api/leads/assign-selection and the server resolves the
                      doors itself, exactly as saving an Area does. Status and
                      Mark are still id-based, so the warning names them and the
                      count beside it still reads low for every action. */}
                  {sampledPins && lassoHasLeads && (
                    <span
                      className="text-[12px] text-amber-300/90 leading-tight"
                      aria-live="polite"
                      data-testid="lasso-sample-warning"
                    >
                      The map is showing a sample of this area&apos;s pins -
                      Status and Mark apply only to the doors loaded. Assign
                      covers every door inside the loop. Zoom in to load them
                      all, or save the loop as an Area.
                    </span>
                  )}
                  {!lassoHasLeads ? (
                    <span
                      className="text-[12px] text-white/60 leading-tight"
                      aria-live="polite"
                      data-testid="lasso-empty-note"
                    >
                      No mapped doors inside this loop - it can still be saved as
                      an area.
                    </span>
                  ) : (
                  <div className="flex items-center gap-1.5 flex-wrap">
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
                  )}

                  {/* Action tiles — SalesRabbit grammar: icon over an 11px
                      label, outlined, one row of four. Each tile switches the
                      flow rendered below to its EXISTING controls; the wide
                      Clear tile exits, same as the headline X. Mark keeps its
                      tile so no existing bulk action loses its entry point. */}
                  <div className="grid grid-cols-4 gap-1.5">
                    {(
                      [
                        ["assign", "Assign", Users],
                        ["status", "Status", Tag],
                        ["mark", "Mark", Flag],
                        ["area", "Area", Landmark],
                      ] as const
                    ).map(([key, label]) => {
                      // Only "Area" works on an empty loop; the rest need lead IDs.
                      const disabled = !lassoHasLeads && key !== "area";
                      const active = lassoEffectiveAction === key;
                      return (
                        <button
                          key={key}
                          type="button"
                          disabled={disabled}
                          title={disabled ? "No doors in this loop" : undefined}
                          onClick={() => setLassoAction(key)}
                          data-testid={`lasso-action-${key}`}
                          aria-pressed={active}
                          className={`h-16 rounded-xl border flex flex-col items-center justify-center gap-1 active:scale-95 transition disabled:opacity-35 disabled:cursor-not-allowed ${
                            active
                              ? "border-teal-300/70 bg-teal-500/20 text-teal-100"
                              : "border-border text-white/80 hover:text-white hover:bg-white/[0.06]"
                          } ${FOCUS}`}
                        >
                          
                          <span className="text-[11px] font-semibold leading-none">
                            {label}
                          </span>
                        </button>
                      );
                    })}
                    <button
                      type="button"
                      onClick={exitLasso}
                      aria-label="Clear selection and exit"
                      data-testid="lasso-clear"
                      className={`col-span-4 h-16 rounded-xl border border-border flex flex-col items-center justify-center gap-1 text-white/80 hover:text-white hover:bg-white/[0.06] active:scale-95 transition ${FOCUS}`}
                    >
                      
                      <span className="text-[11px] font-semibold leading-none">
                        Clear
                      </span>
                    </button>
                  </div>

                  {/* Mode control + Apply — the active tile's secondary flow.
                      The Area flow gets its own labeled section below. */}
                  {lassoEffectiveAction !== "area" && (
                  <div className="flex items-center gap-2">
                    {lassoEffectiveAction === "assign" && (
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
                            !lassoDrawn ||
                            !lassoActiveIds.length ||
                            bulkAssignMutation.isPending
                          }
                          onClick={() =>
                            bulkAssignMutation.mutate({
                              polygon: lassoPoints,
                              repId: Number(lassoRepId),
                              includeStates: lassoEnabledStates,
                            })
                          }
                          type="button"
                          data-testid="lasso-assign"
                          className="h-11 rounded-full bg-teal-500 hover:bg-teal-600 text-[#04241f] font-bold text-[13px] px-4 disabled:opacity-40"
                        >
                          {bulkAssignMutation.isPending
                            ? "…"
                            : `Assign ${lassoActiveIds.length}`}
                        </Button>
                      </>
                    )}
                    {lassoEffectiveAction === "status" && (
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
                          type="button"
                          data-testid="lasso-set-status"
                          className="h-11 rounded-full bg-teal-500 hover:bg-teal-600 text-[#04241f] font-bold text-[13px] px-4 disabled:opacity-40"
                        >
                          {bulkStatusMutation.isPending
                            ? "…"
                            : `Set ${lassoActiveIds.length}`}
                        </Button>
                      </>
                    )}
                    {lassoEffectiveAction === "mark" && (
                      <>
                        <select
                          value={lassoMark}
                          onChange={(e) => setLassoMark(e.target.value as LeadMark | "")}
                          data-testid="lasso-mark-select"
                          className="h-11 flex-1 min-w-0 rounded-full bg-white/10 text-white text-[13px] px-3 border-0 focus:outline-none focus:ring-2 focus:ring-teal-400/60"
                        >
                          {LEAD_MARKS.map((m) => (
                            <option key={m} value={m} className="text-slate-900">
                              {LEAD_MARK_META[m].label}
                            </option>
                          ))}
                          <option value="" className="text-slate-900">
                            Clear mark
                          </option>
                        </select>
                        <Button
                          disabled={
                            !lassoActiveIds.length ||
                            bulkMarkMutation.isPending
                          }
                          onClick={() =>
                            bulkMarkMutation.mutate({
                              leadIds: lassoActiveIds,
                              mark: lassoMark,
                            })
                          }
                          type="button"
                          data-testid="lasso-set-mark"
                          className="h-11 rounded-full bg-teal-500 hover:bg-teal-600 text-[#04241f] font-bold text-[13px] px-4 disabled:opacity-40"
                        >
                          {bulkMarkMutation.isPending
                            ? "…"
                            : lassoMark
                              ? `Mark ${lassoActiveIds.length}`
                              : `Clear ${lassoActiveIds.length}`}
                        </Button>
                      </>
                    )}
                  </div>
                  )}

                  {/* Area flow — a bordered section with labeled rows: name,
                      color as ONE wrapped swatch row (never a stacked pile),
                      rep, then Save as the full-width primary. */}
                  {lassoEffectiveAction === "area" && (
                    <div
                      className="rounded-xl border border-border p-3 flex flex-col gap-3"
                      data-testid="lasso-area-section"
                    >
                      <div className="flex flex-col gap-1.5">
                        <label
                          htmlFor="lasso-area-name-input"
                          className="text-[11px] font-semibold uppercase tracking-wide text-white/60"
                        >
                          Area name
                        </label>
                        <input
                          id="lasso-area-name-input"
                          type="text"
                          value={lassoName}
                          onChange={(e) => setLassoName(e.target.value)}
                          maxLength={60}
                          data-testid="lasso-area-name"
                          placeholder={
                            // Mirrors the server's auto-name so the field shows
                            // what will actually be saved if left blank.
                            lassoRepIds.length
                              ? lassoRepIds.length === 1
                                ? `"${team.find((m) => m.id === lassoRepIds[0])?.name ?? "Rep"}'s area"`
                                : `"${team.find((m) => m.id === lassoRepIds[0])?.name ?? "Rep"} +${lassoRepIds.length - 1}"`
                              : "Area name…"
                          }
                          className="h-11 w-full rounded-lg bg-white/10 text-white text-[13px] px-3 border-0 placeholder:text-white/55 focus:outline-none focus:ring-2 focus:ring-teal-400/60"
                        />
                      </div>

                      <div className="flex flex-col gap-1.5">
                        <span
                          id="lasso-area-color-label"
                          className="text-[11px] font-semibold uppercase tracking-wide text-white/60"
                        >
                          Area color
                        </span>
                        <div
                          role="radiogroup"
                          aria-labelledby="lasso-area-color-label"
                          data-testid="lasso-color-swatches"
                          className="flex flex-wrap gap-2"
                        >
                          {TERRITORY_SWATCHES.map((color) => {
                            const isOn =
                              color.toLowerCase() === lassoColor.toLowerCase();
                            return (
                              <button
                                key={color}
                                type="button"
                                role="radio"
                                aria-checked={isOn}
                                aria-label={`Area color ${color}`}
                                disabled={assignAreaMutation.isPending}
                                onClick={() => setLassoColor(color)}
                                data-testid={`lasso-color-${color.replace("#", "").toLowerCase()}`}
                                className={`w-8 h-8 rounded-full border border-white/20 transition active:scale-95 disabled:opacity-40 ${
                                  isOn
                                    ? "ring-2 ring-white ring-offset-2 ring-offset-transparent"
                                    : ""
                                } ${FOCUS}`}
                                style={{ backgroundColor: color }}
                              />
                            );
                          })}
                        </div>
                      </div>

                      {/* The crew. An area is many-to-many everywhere else in
                          the product, but this — the control that CREATES one —
                          could only ever name one rep, so a two-person patch had
                          to be drawn and then shared as a second step. Tap to
                          add, tap again to drop; the first pick is the primary
                          (it drives the auto-name and the doors' rep). */}
                      <div className="flex flex-col gap-1.5">
                        <span
                          id="lasso-area-rep-label"
                          className="text-[11px] font-semibold uppercase tracking-wide text-white/60"
                        >
                          Assign to {lassoRepIds.length > 1 ? `${lassoRepIds.length} reps` : "rep"}
                        </span>
                        <div
                          role="group"
                          aria-labelledby="lasso-area-rep-label"
                          data-testid="lasso-area-rep-picker"
                          className="flex flex-wrap gap-1.5"
                        >
                          {team.filter((m) => m.active).map((m: TeamMember) => {
                            const idx = lassoRepIds.indexOf(m.id);
                            const on = idx >= 0;
                            return (
                              <button
                                key={m.id}
                                type="button"
                                aria-pressed={on}
                                disabled={assignAreaMutation.isPending}
                                data-testid={`lasso-area-rep-${m.id}`}
                                onClick={() => toggleLassoRep(m.id)}
                                className={`inline-flex h-11 items-center gap-1.5 rounded-full border px-3 text-[12px] font-semibold transition disabled:opacity-40 ${
                                  on
                                    ? "border-teal-400 bg-teal-500/25 text-white"
                                    : "border-white/15 bg-white/5 text-white/70 hover:bg-white/10"
                                } ${FOCUS}`}
                              >
                                {m.name}
                                {idx === 0 && lassoRepIds.length > 1 && (
                                  <span className="rounded-full bg-teal-400/30 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide">
                                    1st
                                  </span>
                                )}
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      <Button
                        disabled={!lassoRepIds.length || assignAreaMutation.isPending}
                        onClick={() =>
                          assignAreaMutation.mutate({
                            polygon: lassoPoints,
                            repIds: lassoRepIds,
                            name: lassoName,
                            color: lassoColor,
                          })
                        }
                        type="button"
                        data-testid="lasso-assign"
                        className="h-11 w-full rounded-lg bg-teal-500 hover:bg-teal-600 text-[#04241f] font-bold text-[13px] disabled:opacity-40"
                      >
                        {assignAreaMutation.isPending ? "…" : "Save area"}
                      </Button>

                      <span className="text-[11px] text-white/55 leading-tight">
                        Area assigns every house in the loop + saves a colored
                        territory.
                        {lassoHasLeads
                          ? " The refine chips apply to Assign & Status."
                          : " Doors added inside it later belong to the area too."}
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ── Who works this area, on the area ──
              Editing the holder set already existed, but only down a four-step
              path: tap the area, open the detail card, scroll to the bottom,
              "Who works this area", full-screen modal over the map you were
              looking at. This is the same decision made where it is made, with
              the polygon still visible above it. Same /share call, same complete
              holder-set contract; only the route to it is shorter. */}
          {selectedTerritoryId != null && canManage && !lassoMode && (() => {
            const t = territories.find((x) => x.id === selectedTerritoryId);
            if (!t) return null;
            const holders = repIdsForDoor((t as any).repId, (t as any).assigneeIds);
            if (!holders.length) return null; // pool areas assign via the card
            return (
              <AreaAssigneeBar
                areaName={territoryLabel(t)}
                color={territoryPaint(
                  { color: (t as any).color, status: (t as any).status },
                  colorForRep((t as any).repId),
                ).fillColor}
                assigneeIds={holders}
                pending={shareMutation.isPending}
                onClose={() => setSelectedTerritoryId(null)}
                onChange={(next) => shareMutation.mutate({ id: t.id, repIds: next })}
                reps={team.filter((m) => m.active).map((m) => {
                  const held = activeAreaCountByRep.get(m.id) ?? 0;
                  return { id: m.id, name: m.name, areaCount: held, atCap: held >= MAX_ACTIVE_AREAS_PER_REP };
                })}
              />
            );
          })()}

          {/* ── Overlapping areas: which one did you mean? ──
              Tapping where two territories overlap used to resolve to whichever
              was drawn on top, which is how you pull back the wrong area.
              Listing them costs one extra tap and removes the guess. */}
          {canAssign && territoryPickIds.length > 1 && (
            <div
              data-testid="territory-picker"
              role="dialog"
              aria-label="Choose an area"
              className="absolute bottom-28 left-1/2 -translate-x-1/2 z-40 w-[min(20rem,90vw)] glass-surface glass-opaque glass-ink-scope rounded-2xl p-3"
            >
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-2">
                {territoryPickIds.length} areas here
              </div>
              <ul className="space-y-1">
                {territoryPickIds.map((id) => {
                  const t = territories.find((x) => x.id === id);
                  if (!t) return null;
                  const status = (t as any).status ?? "active";
                  return (
                    <li key={id}>
                      <button
                        type="button"
                        data-testid={`territory-pick-${id}`}
                        onClick={() => {
                          setTerritoryPickIds([]);
                          setSelectedTerritoryId(id);
                        }}
                        className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left text-sm hover:bg-secondary transition"
                      >
                        <span
                          className="w-3 h-3 rounded-full flex-shrink-0 border border-white/20"
                          style={{
                            backgroundColor: territoryPaint(
                              { color: (t as any).color, status },
                              colorForRep(t.repId),
                            ).fillColor,
                          }}
                        />
                        <span className="truncate font-medium">{t.name}</span>
                        <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                          {status}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              <button
                type="button"
                onClick={() => setTerritoryPickIds([])}
                data-testid="territory-pick-cancel"
                className="mt-2 w-full h-9 rounded-lg text-[13px] text-muted-foreground hover:bg-secondary transition"
              >
                Cancel
              </button>
            </div>
          )}

          {/* ── Territory detail panel — opens when you tap a region ── */}
          {selectedTerritoryId != null &&
            (() => {
              const t = territories.find((x) => x.id === selectedTerritoryId);
              if (!t) return null;
              const prog = progressById.get(t.id);
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
              const teamNames = teamNameRecord;
              const isPool = status === "unassigned" || status === "reclaimed";
              // The assignee bar (bottom-center, same selected area) mounts
              // under this exact condition — mirror it so the panel leaves the
              // bar's strip free instead of scrolling underneath it.
              const assigneeBarShown = canManage && !lassoMode && repIds.length > 0;
              return (
                <div className="absolute top-16 left-[64px] z-30 animate-in fade-in slide-in-from-left-2 duration-200">
                  {/* The close X is a SIBLING of the scroll container, not a
                      child: inside it, its -top/-right offsets sat in clipped
                      overflow (half the button cut away) and it scrolled out of
                      reach the moment the panel was scrolled to the reclaim
                      chooser — an open panel whose close control had left the
                      screen. Pinned here it survives any scroll position. */}
                  <button
                    type="button"
                    onClick={() => setSelectedTerritoryId(null)}
                    className="glass-capsule glass-opaque absolute -top-2 -right-2 z-10 w-9 h-9 text-white/70 hover:text-white flex items-center justify-center"
                    title="Close"
                    aria-label="Close territory panel"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                  <div className={`${assigneeBarShown ? "max-h-[calc(100dvh-20rem)]" : "max-h-[calc(100dvh-9rem)]"} overflow-y-auto overscroll-contain rounded-2xl`}>
                    <div className="relative">
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
                      teamColors={teamColorRecord}
                      progress={
                        // The operational numbers were on the wire the whole
                        // time and this literal dropped them. /progress returns
                        // knocked, sold, availableBase and the three canonical
                        // rates from shared/territoryMetrics; only eight fields
                        // were copied across, and the panel gates its entire
                        // stats block on `progress.knocked != null`. So
                        // penetration and completion were defined, tested, and
                        // rendered nowhere in the product — the card showed
                        // "AREA WORKED 0.00%" and nothing else. Hand-picking
                        // fields is what made that possible; the shape is now
                        // carried whole and the type decides what is read.
                        prog
                          ? {
                              total: prog.total,
                              verifiedWorkedLeads: prog.verifiedWorkedLeads,
                              areaWorkedPct: prog.areaWorkedPct,
                              knocked: prog.knocked,
                              sold: prog.sold,
                              untouched: prog.untouched,
                              availableBase: prog.availableBase,
                              attempts: prog.attempts,
                              penetrationRate: prog.penetrationRate,
                              knockCompletionRate: prog.knockCompletionRate,
                              contactRate: prog.contactRate,
                              lastActivityAt: prog.lastActivityAt ?? null,
                              verified: prog.verified,
                              needsReview: prog.needsReview,
                              invalid: prog.invalid,
                              avgDistanceM: prog.avgDistanceM,
                              maxAllowedDistanceM: prog.maxAllowedDistanceM,
                            }
                          : undefined
                      }
                      onReclaim={
                        !isPool && canReclaim
                          ? () =>
                              setReclaimMenuId(
                                reclaimMenuId === t.id ? null : t.id,
                              )
                          : undefined
                      }
                      reclaimOpen={reclaimMenuId === t.id}
                      onComplete={
                        // Only an area somebody holds, still in play. The panel
                        // additionally gates on reclaim_territory, matching the
                        // server's canManageTerritory + requireTeamLead pair.
                        !isPool && canManage && status !== "completed" && status !== "archived"
                          ? () => {
                              if (confirmCompleteId === t.id) {
                                setConfirmCompleteId(null);
                                completeTerritoryMutation.mutate(t.id);
                              } else {
                                armCompleteConfirm(t.id);
                              }
                            }
                          : undefined
                      }
                      completeConfirming={confirmCompleteId === t.id}
                      completing={completeTerritoryMutation.isPending}
                      onRename={
                        canManage
                          ? (name) => renameTerritoryMutation.mutate({ id: t.id, name })
                          : undefined
                      }
                      onRecolor={
                        canManage
                          ? (color) => recolorTerritoryMutation.mutate({ id: t.id, color })
                          : undefined
                      }
                      onViewHistory={() => setActivityTerritoryId(t.id)}
                      onUnassignRep={
                        !isPool && canManage
                          ? (repId) => unassignRepMutation.mutate({ id: t.id, repId })
                          : undefined
                      }
                      unassigningRepId={unassigningRepId ?? undefined}
                      onStartNextPass={
                        canResetPass ? () => setNextPassTerritoryId(t.id) : undefined
                      }
                      currentPass={(t as any).currentPass ?? 1}
                      assignedAt={(t as any).assignedAt ?? null}
                      onEditAssignees={
                        canManage
                          ? () => { setShareRepIds(repIds); setShareTerritoryId(t.id); }
                          : undefined
                      }
                    />
                    {/* Assign-to-next-rep for unassigned/reclaimed areas.
                        canManage as well as isPool: this was gated on the area's
                        STATUS alone, so the one management control on the card
                        that did not check the viewer's role was the one that
                        hands an area to a rep. A rep is unlikely to have a pool
                        area in their list — /api/territories serves them only
                        what they hold — but "unlikely to be reachable" is not a
                        permission check, and every sibling control here already
                        makes the same test. The server refuses a rep either way
                        (requireTeamLead on /assign); this stops the UI offering
                        an action it knows will fail. */}
                    {isPool && canManage && (
                      <div className="mt-2 w-72 rounded-xl border border-border bg-card p-3">
                        <div className="text-[11px] font-semibold text-foreground mb-1.5">
                          Assign this area to the next rep
                        </div>
                        {/* Searchable, and shows how loaded each rep already is
                            — handing a seventh area to someone at the cap is the
                            mistake this control exists to prevent. */}
                        <RepPicker
                          reps={team.filter((m) => m.active).map((m) => {
                            const held = activeAreaCountByRep.get(m.id) ?? 0;
                            return { id: m.id, name: m.name, areaCount: held, atCap: held >= MAX_ACTIVE_AREAS_PER_REP };
                          })}
                          areaCounts={repAreaCounts}
                          disabled={assignTerritoryMutation.isPending}
                          onChange={(repId) =>
                            assignTerritoryMutation.mutate({ id: t.id, repId })
                          }
                        />
                      </div>
                    )}
                    {/* Inline reclaim 3-mode chooser (reuses the same mutation).
                        Rows disable together while one mode is committing —
                        the tapped row wears the spinner, so a double-tap can't
                        fire the POST twice and the wait is visibly owned by
                        the thing that was pressed, not the whole panel. */}
                    {reclaimMenuId === t.id && !isPool && (
                      <div
                        className="mt-2 w-72 rounded-xl border border-border bg-card p-2 flex flex-col gap-1"
                        data-testid={`panel-reclaim-menu-${t.id}`}
                        role="group"
                        aria-label={`Reclaim options for ${t.name}`}
                      >
                        <button
                          type="button"
                          data-testid="reclaim-mode-return_to_pool"
                          disabled={reclaimMutation.isPending}
                          onClick={() =>
                            reclaimMutation.mutate({
                              id: t.id,
                              mode: "return_to_pool",
                            })
                          }
                          className={`flex min-h-11 items-center gap-2 rounded-lg px-2 text-left text-xs text-foreground hover:bg-secondary disabled:opacity-50 ${FOCUS}`}
                        >
                          {reclaimPendingMode === "return_to_pool" ? (
                            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                          ) : (
                            null
                          )}
                          <span>
                            {reclaimPendingMode === "return_to_pool" ? "Reclaiming…" : "Return leads to pool"}{" "}
                            <span className="text-muted-foreground">
                              (default)
                            </span>
                          </span>
                        </button>
                        <button
                          type="button"
                          data-testid="reclaim-mode-keep_leads"
                          disabled={reclaimMutation.isPending}
                          onClick={() =>
                            reclaimMutation.mutate({
                              id: t.id,
                              mode: "keep_leads",
                            })
                          }
                          className={`flex min-h-11 items-center gap-2 rounded-lg px-2 text-left text-xs text-foreground hover:bg-secondary disabled:opacity-50 ${FOCUS}`}
                        >
                          {reclaimPendingMode === "keep_leads" ? (
                            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                          ) : (
                            null
                          )}
                          <span>
                            {reclaimPendingMode === "keep_leads" ? "Reclaiming…" : "Reclaim area only"}{" "}
                            <span className="text-muted-foreground">
                              (keep leads)
                            </span>
                          </span>
                        </button>
                        <select
                          defaultValue=""
                          aria-label="Reassign this area to another rep"
                          data-testid="panel-reassign-select"
                          disabled={reclaimMutation.isPending}
                          onChange={(e) => {
                            if (e.target.value)
                              reclaimMutation.mutate({
                                id: t.id,
                                mode: "reassign",
                                newRepId: Number(e.target.value),
                              });
                          }}
                          className={`min-h-11 bg-secondary border border-border rounded-lg px-2 text-xs text-foreground disabled:opacity-50 ${FOCUS}`}
                        >
                          <option value="">
                            {reclaimPendingMode === "reassign" ? "Reassigning…" : "Reassign to rep…"}
                          </option>
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
                </div>
              );
            })()}

          {/* Territory activity History drawer (opened from the card's View Activity) */}
          {/* Re-open an area for another sweep. Mounted once, outside the territory
              loop, so the preview fetch fires for the chosen area only. */}
          {/* Who works this area. Multi-select, because an area can legitimately be
              shared — the set you leave here IS the set that ends up on it. */}
          {shareTerritoryId != null && (
            <div role="dialog" aria-modal="true" aria-label="Who works this area"
                 className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
              {/* Scrim is a real close control, same grammar as ReclaimAllDialog
                  and StartNextPassDialog — a tap outside the card is Cancel,
                  not a dead zone. Locked while the save commits. */}
              <button
                type="button"
                aria-label="Close"
                data-testid="share-dialog-scrim"
                disabled={shareMutation.isPending}
                onClick={() => setShareTerritoryId(null)}
                className="absolute inset-0 bg-overlay"
              />
              <div className="relative w-full sm:max-w-md max-h-[85vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl bg-background border p-4 space-y-3">
                <h2 className="text-base font-semibold">Who works this area</h2>
                <p className="text-xs text-muted-foreground">
                  Tap to add or remove. Everyone selected shares the area; the first is the
                  primary and sets its colour on the map.
                </p>
                <RepPicker
                  multiple
                  selected={shareRepIds}
                  onToggle={(_id, next) => setShareRepIds(next)}
                  onChange={() => {}}
                  disabled={shareMutation.isPending}
                  reps={team.filter((m) => m.active).map((m) => {
                    const held = activeAreaCountByRep.get(m.id) ?? 0;
                    return { id: m.id, name: m.name, areaCount: held, atCap: held >= MAX_ACTIVE_AREAS_PER_REP };
                  })}
                  areaCounts={repAreaCounts}
                />
                <div className="flex justify-end gap-2 pt-1">
                  <button type="button" onClick={() => setShareTerritoryId(null)}
                          disabled={shareMutation.isPending}
                          className={`min-h-11 rounded-lg border px-4 py-2 text-sm font-medium disabled:opacity-50 ${FOCUS}`}>Cancel</button>
                  <button
                    type="button"
                    disabled={shareRepIds.length === 0 || shareMutation.isPending}
                    onClick={() => shareMutation.mutate({ id: shareTerritoryId, repIds: shareRepIds })}
                    className={`min-h-11 rounded-lg bg-primary text-primary-foreground px-4 py-2 text-sm font-medium disabled:opacity-50 inline-flex items-center gap-2 ${FOCUS}`}
                  >
                    {shareMutation.isPending && <Loader2 className="w-4 h-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
                    {shareMutation.isPending ? "Saving…" : "Save"}
                  </button>
                </div>
                {shareRepIds.length === 0 && (
                  // The API refuses an empty set; say why here rather than let them press
                  // Save and get an error. Emptying an area is Reclaim's job.
                  <p className="text-xs text-amber-500">
                    Pick at least one rep - to empty the area entirely, use Reclaim.
                  </p>
                )}
              </div>
            </div>
          )}

          {nextPassTerritoryId != null && (
            <StartNextPassDialog
              open
              territoryId={nextPassTerritoryId}
              busy={nextPassMutation.isPending}
              reps={team.filter((m) => m.active).map((m) => ({ id: m.id, name: m.name }))}
              fetchPreview={async (territoryId, keepPendingCallbacks) => {
                const res = await apiRequest(
                  "GET",
                  `/api/territories/${territoryId}/next-pass/preview?keepPendingCallbacks=${keepPendingCallbacks}`,
                );
                return res.json();
              }}
              onConfirm={(opts) =>
                nextPassMutation.mutate({ id: nextPassTerritoryId, ...opts })
              }
              onCancel={() => setNextPassTerritoryId(null)}
            />
          )}

          {activityTerritoryId != null && (
            <TerritoryActivityDrawer
              territoryId={activityTerritoryId}
              onClose={() => setActivityTerritoryId(null)}
            />
          )}

          {canReclaimAll && (
            <ReclaimAllDialog
              open={reclaimAllOpen}
              onClose={() => setReclaimAllOpen(false)}
              areas={reclaimAllAreas}
              teamNames={teamNameRecord}
            />
          )}

          {/* Bulk-remove unworked FCC imports — same gate as reclaim-all. */}
          {canReclaimAll && (
            <FccPurgeDialog
              open={fccPurgeOpen}
              onClose={() => setFccPurgeOpen(false)}
            />
          )}

          {/* ── Filter sheet — bottom sheet over the SAME filterStatus/filterRep
                 state the compact pill and the manager legend drive. Statuses
                 shown are exactly the ones with pins (statusOptions rule);
                 rep rows are manager chrome only. ── */}
          <MapFilterSheet
            open={mapFilterOpen}
            onClose={() => setMapFilterOpen(false)}
            statusOrder={filterSheetStatusOrder}
            statusCounts={statusCounts}
            activeStatus={filterStatus}
            onStatus={setFilterStatus}
            reps={filterSheetReps}
            unassignedCount={repLeadCounts.unassigned}
            activeRep={filterRep}
            onRep={setFilterRep}
            sources={LEAD_SOURCE_OPTIONS}
            sourceCounts={sourceCountsMap}
            activeSource={filterSource}
            onSource={setFilterSource}
            onClearAll={() => {
              setFilterStatus("all");
              setFilterRep("all");
              setFilterSource("all");
            }}
            // Honest lens note for the density tier: zoomed out, the bubbles
            // are tag-scoped counts — the server-side part of the FCC lens
            // applies, but status and field-verified are pin-level predicates
            // and only bite once the map is in the pins tier.
            zoomedOutNote={
              viewportMode && viewportTier === "grid" && gridHiddenLenses.length > 0
                ? `${gridHiddenLenses.join(", ")} ${gridHiddenLenses.length === 1 ? "filter applies" : "filters apply"} when zoomed in`
                : null
            }
            shown={mapTotalLeads.length}
            total={leads.length}
          />

          {/* ── Settings sheet — basemap + the REAL existing layer toggles
                 (leads layer for everyone; territories for team_lead+; rep
                 color mode for managers). The old layers popover is gone, so
                 this sheet owns all three basemaps, Dark included. ── */}
          <MapSettingsSheet
            open={mapSettingsOpen}
            onClose={() => setMapSettingsOpen(false)}
            basemap={{
              value: mapStyleMode,
              onChange: (v) => setMapStyleMode(v),
            }}
            toggles={[
              {
                key: "leads",
                label: "Show leads",
                description: "Lead pins on the map",
                on: showLeads,
                onToggle: () => setShowLeads((v) => !v),
                testId: "map-settings-toggle-leads",
              },
              {
                key: "house-numbers",
                label: "House numbers",
                description: "Street numbers beside rooftops when zoomed in",
                on: showHouseNums,
                onToggle: () => setShowHouseNums((v) => !v),
                testId: "map-settings-toggle-house-numbers",
              },
              ...(canAssign
                ? [
                    {
                      key: "areas",
                      label: "Display areas",
                      description: "Colored territory shapes over the map",
                      on: showTerritories,
                      onToggle: () => setShowTerritories((v) => !v),
                      testId: "map-settings-toggle-areas",
                    },
                  ]
                : []),
              ...(canManage
                ? [
                    {
                      key: "rep-colors",
                      label: "Color pins by rep",
                      description: "Each pin takes its assigned rep's color",
                      on: repColorMode,
                      onToggle: () => setRepColorMode((v) => !v),
                      testId: "map-settings-toggle-rep-colors",
                    },
                  ]
                : []),
            ]}
          />

          {/* ── CONTROL RAIL — ONE vertical stack of uniform rounded-square
                 buttons, top-left (SalesRabbit grammar): Search, Lasso
                 (managers), Filters, Settings, then the overflow tools menu.
                 Layers/basemap live in the settings sheet and the lasso has its
                 own rail button, so the popover keeps only entries with no
                 dedicated control. ALWAYS visible — primary chrome is never
                 auto-hidden (the pan/zoom fade could strand it at opacity-0,
                 which is how the lasso "disappeared"). On phones the rail
                 starts below the 44px nav-menu button. ── */}
          {mapReady && (
            <>
              {toolsMenuOpen && (
                <div
                  className="absolute inset-0 z-30"
                  onClick={() => setToolsMenuOpen(false)}
                />
              )}
              <div
                className="absolute left-3 top-[calc(env(safe-area-inset-top)+4rem)] md:top-[calc(env(safe-area-inset-top)+0.75rem)] z-40 flex flex-col items-start gap-2"
                data-testid="map-tools"
              >
                {/* Search — opens the search panel directly (was popover-only). */}
                <button
                  ref={searchBtnRef}
                  type="button"
                  onClick={() => {
                    setSearchOpen((o) => !o);
                    setToolsMenuOpen(false);
                    setLeadsOpen(false);
                  }}
                  aria-label="Search leads and places"
                  aria-pressed={searchOpen}
                  data-testid="map-search-open"
                  className={`${RAIL_BTN} ${searchOpen ? RAIL_BTN_ACTIVE : RAIL_BTN_IDLE}`}
                >
                  <Search className="w-5 h-5" aria-hidden="true" />
                </button>

                {/* Lasso — the draw-an-area mode toggle, managers only. */}
                {canAssign && (
                  <button
                    type="button"
                    onClick={() => {
                      setToolsMenuOpen(false);
                      if (lassoMode) {
                        exitLasso();
                      } else {
                        exitLasso();
                        setAddMode(false); // draw tools and add-mode are mutually exclusive
                        // Scan Map is a draw tool too: leaving it armed under the
                        // lasso double-binds mousedown (a stroke would ALSO submit
                        // an area scan) and its auto-exit re-enables dragPan mid-lasso.
                        setScanDrawMode(false);
                        // Start on a colour nothing else is using, so two areas never
                        // read as one region split by a road. The picker overrides it.
                        setLassoColor(pickFreeColor());
                        setLassoMode(true);
                        setSearchOpen(false);
                      }
                    }}
                    aria-label={
                      lassoMode
                        ? "Cancel area selection"
                        : "Select an area (lasso)"
                    }
                    aria-pressed={lassoMode}
                    data-testid="ctl-lasso"
                    className={`${RAIL_BTN} ${lassoMode ? RAIL_BTN_ACTIVE : RAIL_BTN_IDLE}`}
                  >
                    <LassoSelect className="w-5 h-5" aria-hidden="true" />
                  </button>
                )}

                {/* Add lead — direct rail button for admin/manager/team lead
                    (owner ask: one tap, not buried in the More menu). */}
                {canAssign && (
                  <button
                    type="button"
                    onClick={() => {
                      // Arming add-mode stands the draw tools down (and vice
                      // versa — see the lasso/scan handlers): the map click
                      // handler gives __tapAddressMode priority, so a lasso or
                      // scan box left armed underneath would double-handle
                      // every tap (stroke/box + reverse-geocode at once).
                      if (!addMode) {
                        exitLasso();
                        setScanDrawMode(false);
                      }
                      setAddMode(!addMode);
                    }}
                    aria-label={addMode ? "Cancel add-lead mode" : "Add a lead by tapping the map"}
                    aria-pressed={addMode}
                    data-testid="ctl-add-lead"
                    className={`${RAIL_BTN} ${addMode ? RAIL_BTN_ACTIVE : RAIL_BTN_IDLE}`}
                  >
                    <Plus className="w-5 h-5" aria-hidden="true" />
                  </button>
                )}

                {/* Filter sheet trigger — the SalesRabbit-style bottom sheet
                    over the SAME filterStatus/filterRep state as the pill and
                    the manager legend. Dot = a filter is narrowing pins. */}
                <button
                  type="button"
                  onClick={() => {
                    setMapFilterOpen(true);
                    setToolsMenuOpen(false);
                  }}
                  aria-label="Open filters"
                  aria-haspopup="dialog"
                  data-testid="map-filter-open"
                  className={`${RAIL_BTN} ${RAIL_BTN_IDLE}`}
                >
                  
                  {mapFilterActive && (
                    <span
                      className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-primary ring-2 ring-card"
                      aria-hidden="true"
                    />
                  )}
                </button>

                {/* Settings sheet trigger — basemap + layer toggles as a sheet. */}
                <button
                  type="button"
                  onClick={() => {
                    setMapSettingsOpen(true);
                    setToolsMenuOpen(false);
                  }}
                  aria-label="Map settings"
                  aria-haspopup="dialog"
                  data-testid="map-settings-open"
                  className={`${RAIL_BTN} ${RAIL_BTN_IDLE}`}
                >
                  <Settings2 className="w-5 h-5" aria-hidden="true" />
                </button>

                {/* Overflow tools — ONLY entries without a rail button of their
                    own (leads-in-view, Live Test) plus search by label. */}
                <button
                  ref={toolsMenuBtnRef}
                  type="button"
                  onClick={() => setToolsMenuOpen((o) => !o)}
                  aria-label="More map tools"
                  aria-expanded={toolsMenuOpen}
                  data-testid="map-tools-menu"
                  className={`${RAIL_BTN} ${toolsMenuOpen ? RAIL_BTN_ACTIVE : RAIL_BTN_IDLE}`}
                >
                  <Ellipsis className="w-5 h-5" aria-hidden="true" />
                </button>

                {toolsMenuOpen && (
                  <div
                    className="w-[220px] rounded-xl bg-card/95 border border-border shadow-sm p-1.5 text-foreground animate-in fade-in slide-in-from-top-1 duration-150"
                    role="group"
                    aria-label="Map tools"
                    data-testid="map-tools-popover"
                  >
                    {(
                      [
                        {
                          key: "search",
                          testid: "ctl-search",
                          icon: <Search className="w-4 h-4" />,
                          label: "Search leads & places",
                          active: searchOpen,
                          onClick: () => {
                            setSearchOpen((o) => !o);
                            setToolsMenuOpen(false);
                            setLeadsOpen(false);
                          },
                        },
                        {
                          key: "leads",
                          testid: "ctl-leads",
                          icon: <List className="w-4 h-4" />,
                          label: "Leads in view",
                          active: leadsOpen,
                          btnRef: leadsBtnRef,
                          onClick: () => {
                            setLeadsOpen((o) => !o);
                            setToolsMenuOpen(false);
                            setSearchOpen(false);
                          },
                        },
                        // "Map layers & style" and "Select an area (lasso)"
                        // left this menu — the settings sheet and the rail's
                        // lasso button own them now. Add-lead, Scan map, and
                        // the legend moved IN here off the map surface
                        // (owner's minimal directive), same handlers + gates.

                        ...(canSubmitScan
                          ? [
                              {
                                key: "scan-map",
                                testid: "scan-map-btn",
                                icon: <Radar className="w-4 h-4" />,
                                label: "Scan map",
                                active: scanDrawMode,
                                onClick: () => {
                                  exitLasso();
                                  setAddMode(false); // draw tools and add-mode are mutually exclusive
                                  setScanDrawMode(true);
                                  setToolsMenuOpen(false);
                                },
                              },
                            ]
                          : []),
                        ...(!isRep
                          ? [
                              {
                                key: "legend",
                                testid: "ctl-legend",
                                icon: <Users className="w-4 h-4" />,
                                label: "Legend & rep areas",
                                active: legendOpen,
                                onClick: () => {
                                  setLegendOpen((o) => !o);
                                  setToolsMenuOpen(false);
                                },
                              },
                            ]
                          : [
                              // Rep counterpart of the manager legend: a compact
                              // pin-colors key (STATE_COLORS/STATE_LABELS), so a
                              // new hire never has to guess what a color means.
                              {
                                key: "pin-key",
                                testid: "ctl-pin-key",
                                icon: <Palette className="w-4 h-4" />,
                                label: "Pin colors",
                                active: pinKeyOpen,
                                onClick: () => {
                                  setPinKeyOpen((o) => !o);
                                  setToolsMenuOpen(false);
                                },
                              },
                            ]),
                        // Bulk-remove unworked FCC-imported doors — admin
                        // chrome behind the SAME permission gate as the
                        // reclaim-all sweep (never wider than the server's
                        // requireAdmin). Opens the staged destructive dialog;
                        // nothing is removed from this menu tap itself.
                        ...(canReclaimAll
                          ? [
                              {
                                key: "fcc-purge",
                                testid: "ctl-fcc-purge",
                                icon: <Trash2 className="w-4 h-4" />,
                                label: "Remove FCC imports",
                                active: fccPurgeOpen,
                                onClick: () => {
                                  setFccPurgeOpen(true);
                                  setToolsMenuOpen(false);
                                },
                              },
                            ]
                          : []),
                        ...(canSubmitScan
                          ? [
                              {
                                key: "live-test",
                                testid: "live-test-open",
                                icon: <Crosshair className="w-4 h-4" />,
                                label: "Live Test one address",
                                active: liveTestOpen,
                                onClick: () => {
                                  exitLasso();
                                  setLiveTestOpen(true);
                                  setToolsMenuOpen(false);
                                },
                              },
                            ]
                          : []),
                      ] as const
                    ).map((item) => (
                      <button
                        key={item.key}
                        type="button"
                        ref={("btnRef" in item ? item.btnRef : null) as any}
                        onClick={item.onClick}
                        aria-label={item.label}
                        aria-pressed={item.active}
                        data-testid={item.testid}
                        className={`w-full flex items-center gap-2.5 min-h-[44px] px-2.5 rounded-lg text-[13px] text-left transition ${
                          item.active
                            ? "bg-primary text-primary-foreground font-semibold"
                            : "text-foreground hover:bg-secondary/60"
                        } ${FOCUS}`}
                      >
                        <span
                          className={`shrink-0 ${item.active ? "text-primary-foreground" : "text-muted-foreground"}`}
                          aria-hidden="true"
                        >
                          {item.icon}
                        </span>
                        {item.label}
                      </button>
                    ))}
                  </div>
                )}

              </div>
            </>
          )}

          {/* Locate-me FAB — EVERY role. Now that the map opens on your location
              with the blue dot (Apple/Google-Maps behavior), everyone gets the
              one-tap "recenter on me" thumb target too. Bottom-right. Hidden
              during Assign Area so it can never overlap the lasso panel. */}
          {mapReady && !lassoMode && (
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
              aria-pressed={followEngaged}
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
              // Ring brightens while follow is actually engaged (mirrors the
              // imperative `following` flag), so the FAB reads as ON/OFF truthfully.
              className={`absolute right-3 z-20 rounded-full ring-inset flex items-center justify-center active:scale-[0.97] transform-gpu transition-transform bg-primary text-primary-foreground hover:bg-primary/90 ${followEngaged ? "ring-2 ring-white/80" : "ring-1 ring-white/[0.18]"}`}
            >
              <LocateFixed className="w-6 h-6" />
            </button>
          )}

          {/* Add-lead moved off the map surface into the More (tools) popover
              ("Add lead", same handler + canAssign gate) per the owner's
              minimal directive. The armed state stays visible via the amber
              tap-hint bar below — hint only, never a loading state. */}

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
                {/* No resolving spinner — the tap drops its pin instantly and
                    the geocode reconciles in the background. */}
                
                <span className="font-medium whitespace-nowrap">
                  Tap a house to add a lead
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
              
              Next door
            </button>
          )}

          {/* Rep pin-colors key — bottom left, above the Next-door FAB, opened
                 from the More menu's "Pin colors" entry and dismissible. Hidden
                 while the knock sheet is up so it never covers the outcomes. */}
          {mapReady && isRep && pinKeyOpen && bottomSlot !== "knock" && (
            <MapLegend
              open
              onClose={() => setPinKeyOpen(false)}
              items={pinKeyItems}
              className="absolute left-3 z-10"
              style={{ bottom: "calc(env(safe-area-inset-bottom) + 6.5rem)" }}
            />
          )}

          {/* Pin legend + admin filter panel — bottom left, MANAGER chrome
                 (team_lead+). The floating dot-strip trigger is gone (minimal
                 map): this panel now opens from the More menu's
                 "Legend & rep areas" entry. Contents unchanged: rep-areas color
                 mode, rep filter, status rows, assigned areas. */}
          {mapReady && !isRep && legendOpen && bottomSlot !== "knock" && (
            <div
              style={{
                bottom: "calc(env(safe-area-inset-bottom) + 2rem)",
                maxHeight: "min(60vh, 460px)",
              }}
              className="glass-surface absolute left-3 p-3 z-10 min-w-[170px] max-w-[240px] overflow-y-auto"
            >
              {/* Rep filter — moved here from the (removed) top bar */}
              {canManage && (
                <button
                  type="button"
                  onClick={() => setRepColorMode((v) => !v)}
                  data-testid="map-rep-color-mode"
                  title="Color pins by assigned rep - see who owns each area"
                  className={`mb-2.5 w-full h-11 rounded-lg border text-[12px] font-semibold transition-colors ${
                    repColorMode
                      ? "bg-teal-500/30 border-teal-300/60 text-teal-100"
                      : "bg-white/10 border-white/20 text-white/70"
                  }`}
                >
                  <span className="inline-flex items-center gap-1.5">Rep areas: {repColorMode ? "ON" : "OFF"}</span>
                </button>
              )}
              {/* Org-wide sweep — admin only. Opens the safe bulk flow (impact
                  summary + mode + typed confirmation); never acts from here. */}
              {canReclaimAll && (
                <button
                  type="button"
                  onClick={() => { setReclaimAllOpen(true); setLegendOpen(false); }}
                  data-testid="map-reclaim-all"
                  title="Take every assigned area back from every rep"
                  className="mb-2.5 w-full h-11 rounded-lg border border-rose-400/40 bg-rose-500/15 text-rose-200 text-[12px] font-semibold transition-colors hover:bg-rose-500/25"
                >
                  Reclaim all areas
                </button>
              )}
              {canAssign && repColorMode ? (
                <div className="mb-2.5">
                  <span className="block text-[10px] text-white/40 uppercase tracking-wider font-semibold mb-1">
                    Assignments (tap to filter)
                  </span>
                  <button
                    type="button"
                    onClick={() => setFilterRep(filterRep === "unassigned" ? "all" : "unassigned")}
                    className={`w-full flex items-center gap-2 h-9 px-1.5 rounded-md text-[12px] text-left ${filterRep === "unassigned" ? "bg-white/20" : "hover:bg-white/10"}`}
                  >
                    <span className="inline-block w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: "#6b7280" }} />
                    <span className="text-white/80 flex-1 truncate">Unassigned</span>
                    <span className="text-white/40">{repLeadCounts.unassigned}</span>
                  </button>
                  {team.map((m: TeamMember) => {
                    const active = filterRep === String(m.id);
                    return (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => setFilterRep(active ? "all" : String(m.id))}
                        className={`w-full flex items-center gap-2 h-9 px-1.5 rounded-md text-[12px] text-left ${active ? "bg-white/20" : "hover:bg-white/10"}`}
                      >
                        <span className="inline-block w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: repColorFor(m.id) }} />
                        <span className="text-white/80 flex-1 truncate">{m.name}</span>
                        <span className="text-white/40">{repLeadCounts.counts.get(m.id) ?? 0}</span>
                      </button>
                    );
                  })}
                </div>
              ) : null}
              {canAssign && (
                <div className="mb-2.5" style={repColorMode ? { display: "none" } : undefined}>
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
                    className="relative w-8 h-8 -my-1.5 inline-flex items-center justify-center rounded-lg text-white/70 hover:text-white hover:bg-white/10 after:absolute after:-inset-1.5"
                  >
                    <X className="w-4 h-4" aria-hidden="true" />
                  </button>
                </span>
              </div>
              {statusOptions.map((opt) => {
                const count = opt.count;
                const isActive = filterStatus === opt.key;
                return (
                  // Real toggle buttons (were click-only divs — no keyboard or
                  // AT path to the status filter at all; review finding), 44px.
                  // Rows mirror the compact filter control exactly (same
                  // display-state options) so the two surfaces can't disagree.
                  <button
                    key={opt.key}
                    type="button"
                    aria-pressed={isActive}
                    onClick={() => setFilterStatus(isActive ? "all" : opt.key)}
                    className="w-full flex items-center gap-2 mb-0.5 cursor-pointer rounded-lg px-1.5 min-h-[44px] transition-all text-left focus-visible:ring-2 focus-visible:ring-teal-400 focus-visible:ring-inset focus:outline-none"
                    style={{
                      background: isActive ? opt.bg + "22" : "transparent",
                    }}
                  >
                    {legendGlyphs[opt.key] ? (
                      <img
                        src={legendGlyphs[opt.key]}
                        alt=""
                        aria-hidden="true"
                        className="w-[18px] h-[18px] flex-shrink-0 -my-0.5"
                        style={{
                          filter: isActive
                            ? `drop-shadow(0 0 4px ${opt.bg})`
                            : "none",
                        }}
                      />
                    ) : (
                      <span
                        className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                        style={{
                          background: opt.bg,
                          boxShadow: isActive ? `0 0 6px ${opt.bg}` : "none",
                        }}
                      />
                    )}
                    <span
                      className="text-[12px] flex-1"
                      style={{
                        color: isActive ? opt.bg : "#94a3b8",
                        fontWeight: isActive ? 700 : 400,
                      }}
                    >
                      {opt.label}
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
                    const prog = progressById.get(t.id);
                    const status = (t as any).status ?? "active";
                    const isUnassigned =
                      status === "unassigned" || status === "reclaimed";
                    const color = isUnassigned
                      ? "#94a3b8"
                      : colorForRep(t.repId);
                    const repName = isUnassigned
                      ? "Unassigned"
                      : (repNameById.get(t.repId) ?? t.name);
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
                            <span className="text-[12px] truncate text-white/85">
                              {repName}
                            </span>
                            {status !== "active" && (
                              <span className="text-[12px] uppercase tracking-wide text-white/40">
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
                              <Plus className="w-4 h-4" aria-hidden="true" />
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
                              <Undo2 className="w-4 h-4" aria-hidden="true" />
                            </button>
                          )}
                          {canDelete && (
                            // delete_territory (admin), NOT canManage: the API
                            // is requireAdmin, so showing this × to a team_lead
                            // promised an action the server answers with 403 —
                            // two taps ending in an error toast. Areas.tsx got
                            // this right; the map now checks the same row of
                            // the permission table the route enforces.
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
                              {confirmDeleteId === t.id ? (
                                "Sure?"
                              ) : (
                                <X className="w-4 h-4" aria-hidden="true" />
                              )}
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
                              className="w-full bg-white/10 text-white text-[12px] rounded-lg px-2 min-h-11 border border-white/20"
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
                              type="button"
                              disabled={reclaimMutation.isPending}
                              onClick={() =>
                                reclaimMutation.mutate({
                                  id: t.id,
                                  mode: "return_to_pool",
                                })
                              }
                              className="text-left text-[12px] text-white/80 hover:text-white px-2 min-h-11 inline-flex items-center gap-1.5 rounded hover:bg-white/10 disabled:opacity-50"
                            >
                              {reclaimPendingMode === "return_to_pool" ? (
                                <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                              ) : (
                                null
                              )}
                              <span>
                                Return leads to pool{" "}
                                <span className="text-white/40">(default)</span>
                              </span>
                            </button>
                            <button
                              type="button"
                              disabled={reclaimMutation.isPending}
                              onClick={() =>
                                reclaimMutation.mutate({
                                  id: t.id,
                                  mode: "keep_leads",
                                })
                              }
                              className="text-left text-[12px] text-white/80 hover:text-white px-2 min-h-11 inline-flex items-center rounded hover:bg-white/10 disabled:opacity-50"
                            >
                              {reclaimPendingMode === "keep_leads" && (
                                <Loader2 className="w-3.5 h-3.5 mr-1.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                              )}
                              Reclaim area only{" "}
                              <span className="text-white/40">
                                (keep leads)
                              </span>
                            </button>
                            <div className="flex items-center gap-1">
                              <select
                                data-testid={`reassign-select-${t.id}`}
                                defaultValue=""
                                disabled={reclaimMutation.isPending}
                                onChange={(e) => {
                                  if (e.target.value)
                                    reclaimMutation.mutate({
                                      id: t.id,
                                      mode: "reassign",
                                      newRepId: Number(e.target.value),
                                    });
                                }}
                                className="flex-1 bg-white/10 text-white text-[12px] rounded-lg px-2 min-h-11 border border-white/20 disabled:opacity-50"
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
              canManage={canManage}
              onCentralMark={handleCentralMark}
              onDelete={handleDeleteLead}
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
            // In viewport mode the merged cache total is just the accumulated
            // window subset — the honest org total is the count probe's.
            orgTotal={mapPinCount?.total ?? mapPinData?.total ?? 0}
            filtered={mapTotalLeads.length !== (mapPinCount?.total ?? mapPinData?.total ?? 0)}
            showLeadsLayer={showLeads}
            onShowLeadsLayer={() => setShowLeads(true)}
            onRowTap={onLeadsRowTap}
            onFitAll={fitAllLeads}
            onClearFilters={() => {
              setFilterStatus("all");
              setFilterRep("all");
              setFilterSource("all");
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
          onCreated={(leadId, opts) => {
            // DUPLICATE: hand off to the reason-aware handler — it flashes the
            // pin only when the lead truly renders, and otherwise explains WHY
            // it's off the map and opens it by id (no fabricated pin).
            if (opts?.existed) {
              openExistingLead(leadId, opts.address ?? "", opts.visibility);
              return;
            }
            // NEW lead: confirmation the rep can SEE: select the pin, fly the
            // camera to it (padded above the knock sheet), pop the ring flash.
            // The pin itself is already in the map cache (optimistic insert), so
            // this is pure camera + selection work.
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
