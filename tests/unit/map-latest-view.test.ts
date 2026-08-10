// "Latest fiber" as the DEFAULT map view — the client wiring, pinned
// source-level (rendering MapView needs mapbox + ~8k lines; same pattern as
// map-zoom-tiers.test.ts / map-one-tap-add.test.ts). The pure predicates the
// wiring calls live in lead-source-filter.test.ts / map-grid.test.ts.
//
// The contract:
//   1. the count probe asks for the FILTERED total (?view=latest), so the
//      full-feed-vs-viewport decision compares ~51k — not ~174k — against the
//      60k threshold (the whole speed point of the lens)
//   2. every tier carries the lens server-side: full feed, bbox windows, grid
//   3. a lens switch busts every cache that could serve the other view
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fullFeedEnabled, MAP_VIEWPORT_MODE_THRESHOLD } from "@/lib/mapViewport";

const ROOT = join(__dirname, "..", "..");
const src = readFileSync(join(ROOT, "client/src/pages/MapView.tsx"), "utf8");

describe("the count probe drives the mode decision with the FILTERED total", () => {
  it("asks the server for the current lens's count (?view=latest)", () => {
    const block = src.slice(src.indexOf("const countView ="), src.indexOf("const mapPinCount ="));
    expect(block).toContain("sourceFilterToMapView(filterSource)");
    expect(block).toContain('?view=${countView}');
  });

  it("is keyed by view - a lens switch probes fresh, never reuses the other view's total", () => {
    expect(src).toContain('queryKey: ["/api/leads/map/count", countView ?? "all"]');
  });

  it("the lens still shrinks the scope; both totals now take windows", () => {
    // The lens's PURPOSE is unchanged - filtering shrinks the scope the map
    // must answer for - but the mode decision moved. Production 2026-08-10
    // measured the ~62k filtered scope (69,059 actual) taking the uncapped
    // full-feed path at 32,698ms per request, so the threshold is now tied to
    // the per-window cap (25k) and both of these take windows.
    expect(fullFeedEnabled({ signedIn: true, countIsError: false, countTotal: 62_000 })).toBe(false);
    expect(fullFeedEnabled({ signedIn: true, countIsError: false, countTotal: 184_000 })).toBe(false);
    // A genuinely small scope - one rep's territory - still gets the single feed.
    expect(fullFeedEnabled({ signedIn: true, countIsError: false, countTotal: 4_000 })).toBe(true);
    expect(62_000).toBeGreaterThan(MAP_VIEWPORT_MODE_THRESHOLD);
  });
});

describe("every tier carries the lens server-side", () => {
  it("the full feed passes ?view= (read from the ref at fetch time)", () => {
    const block = src.slice(src.indexOf('queryKey: ["/api/leads/map"],'), src.indexOf("unpackMapPins<MapPin>(await res.json())"));
    expect(block).toContain("sourceFilterToMapView(filterSourceRef.current)");
    expect(block).toContain("/api/leads/map?format=packed${view ? `&view=${view}` : \"\"}");
  });

  it("the bbox pin window passes ?view=", () => {
    const block = src.slice(src.indexOf("const fetchViewportPins = useCallback"), src.indexOf("const fetchViewportPinsRef"));
    expect(block).toContain("sourceFilterToMapView(filterSourceRef.current)");
    expect(block).toContain("&view=${mapView}");
  });

  it("the full-feed cache key stays [\"/api/leads/map\"] - one entry every writer targets", () => {
    // Optimistic updates, the viewport merge, and the SSE/visibility
    // invalidations all address this ONE key; the lens rides the URL and a
    // switch invalidates (below), so no writer needs to know the view.
    expect(src).toContain('queryKey: ["/api/leads/map"],');
    expect(src).not.toContain('queryKey: ["/api/leads/map",');
  });
});

describe("a lens switch busts every cache that could serve the other view", () => {
  const block = src.slice(
    src.indexOf("const prevFilterSourceRef = useRef(filterSource)"),
    src.indexOf("}, [filterSource, qc]);"),
  );

  it("clears the 60s grid cache (old-lens cells must not serve)", () => {
    expect(block).toContain("gridCacheRef.current.clear()");
  });

  it("refetches the active viewport window / invalidates the full feed", () => {
    expect(block).toContain("refreshViewportPinsRef.current()");
    expect(block).toContain('invalidateQueries({ queryKey: ["/api/leads/map"] })');
  });

  it("skips the first run (mount fetches already carry the initial lens)", () => {
    expect(block).toContain("if (prevFilterSourceRef.current === filterSource) return;");
  });
});

describe("the empty-map honesty paths account for the default lens", () => {
  it("the all-filtered-out Clear also resets the source lens (it can be the sole cause now)", () => {
    const at = src.indexOf('data-testid="map-all-filtered-clear"');
    const block = src.slice(Math.max(0, at - 600), at);
    expect(block).toContain('setFilterSource("all")');
  });
});
