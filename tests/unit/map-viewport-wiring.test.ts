// Viewport-mode cross-feature wiring — two seams the pure lib tests
// (map-viewport.test.ts) cannot see because they live in MapView itself.
//
// 1. INVALIDATION BRIDGE. Every shared mutation path — the saved-knock
//    reconciliation, the dead-knock auto-resolve in useKnockLogger, bulk lasso
//    actions, the one-tap add — signals "map cache is stale" with
//    invalidateQueries(["/api/leads/map"]). In full-feed mode that refetches;
//    in viewport mode that query is DISABLED, so the invalidate refetches
//    nothing and an optimistic write that needs pulling back to server truth
//    (e.g. the recolor of a knock later dropped as undeliverable) would sit
//    wrong until the next pan. MapView must translate the invalidate into a
//    window refetch.
//
// 2. SAMPLED-WINDOW LASSO HONESTY. A truncated (sampled) window means the
//    client holds only a thinned subset of the window's pins, and the lasso can
//    only select pins the client holds — so the id-based bulk actions (Assign /
//    Status / Mark) would silently skip every unsampled door inside the loop.
//    The panel must say so. Saving an Area stays safe either way: the polygon
//    is re-evaluated server-side over ALL leads (see /api/territories/assign-area).
//
// Source-level assertions in the same spirit as map-instant-actions.test.ts:
// MapView cannot be mounted without a live GL context.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const src = readFileSync(join(ROOT, "client/src/pages/MapView.tsx"), "utf8");

describe("viewport-mode invalidation bridge", () => {
  const subStart = src.indexOf("cache.subscribe(");
  const bridge = src.slice(src.lastIndexOf("useEffect(", subStart), src.indexOf("}, [qc]);", subStart));

  it("subscribes to the query cache and refetches the window on a map-key invalidate", () => {
    expect(subStart).toBeGreaterThan(-1);
    expect(bridge).toContain('event?.action?.type !== "invalidate"');
    expect(bridge).toContain("refreshViewportPinsRef.current()");
  });

  it("only acts in viewport mode and only on the exact map query key", () => {
    // Full-feed mode already refetches on invalidate — double-fetching there
    // would waste the multi-MB feed; and a prefix match would misfire on
    // sibling keys.
    expect(bridge).toContain("if (!viewportModeRef.current || !displayActiveRef.current) return;");
    expect(bridge).toContain('key.length !== 1 || key[0] !== "/api/leads/map"');
  });
});

describe("sampled-window lasso warning", () => {
  it("the lasso panel warns when the window is a sample, naming the id-based actions", () => {
    const warn = src.indexOf('data-testid="lasso-sample-warning"');
    expect(warn).toBeGreaterThan(-1);
    const block = src.slice(src.lastIndexOf("{sampledPins && lassoHasLeads && (", warn), src.indexOf("</span>", warn));
    expect(block).toContain("sampledPins && lassoHasLeads");
    expect(block).toContain("only to the doors loaded");
  });

  it("sampledPins derives from viewport mode + the truncated flag (server truth)", () => {
    expect(src).toContain("const sampledPins = viewportMode && !!mapPinData?.truncated;");
  });
});
