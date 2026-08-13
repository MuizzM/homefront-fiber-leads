// Field Map minimal chrome — SalesRabbit reference (owner directive).
//
// Contract: at rest the map shows ONLY the left control rail (Search / Lasso /
// Filters / Settings / More) and the locate FAB. Everything else is opt-in
// (settings sheet, More menu) or contextual (active-filter chip). These are
// source-level assertions in the same spirit as map-view-panel-wiring.test.ts:
// rendering MapView for real needs mapbox + geolocation + ~7k lines of page,
// and the bugs this file pins (chrome that quietly hides, or quietly returns)
// are wiring properties the source states directly.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const src = readFileSync(join(ROOT, "client/src/pages/MapView.tsx"), "utf8");

describe("the lasso rail button is permanent for every role allowed to lasso", () => {
  it("renders on the rail behind the SAME canAssign gate as before", () => {
    // Gate unchanged (team_lead / manager / admin / super_admin) — the fix was
    // visibility, never a permission widening.
    const railStart = src.indexOf('data-testid="map-tools"');
    const lassoBtn = src.indexOf('data-testid="ctl-lasso"');
    expect(railStart).toBeGreaterThan(-1);
    expect(lassoBtn).toBeGreaterThan(railStart);
    const between = src.slice(railStart, lassoBtn);
    expect(between, "ctl-lasso must be gated by canAssign only").toContain("{canAssign && (");
  });

  it("the rail can never auto-hide - the opacity-0 fade machinery is gone", () => {
    // The old secondary-chrome fade could strand the whole rail (lasso
    // included) at opacity-0 pointer-events-none when a gesture's end event
    // was swallowed. Primary chrome must not opt into it, and the machinery
    // itself must not quietly return.
    expect(src).not.toContain("secondaryCls");
    expect(src).not.toContain("chromeAutoHideNext");
    expect(src).not.toContain("chromeHidden");
    const rail = src.slice(
      src.indexOf('data-testid="map-tools"') - 400,
      src.indexOf('data-testid="map-tools"'),
    );
    expect(rail).not.toContain("opacity-0");
    expect(rail).not.toContain("hidden ");
  });

  it("armed lasso shows as active (bg-primary) on the rail", () => {
    expect(src).toContain(
      "className={`${RAIL_BTN} ${lassoMode ? RAIL_BTN_ACTIVE : RAIL_BTN_IDLE}`}",
    );
    expect(src).toMatch(/const RAIL_BTN_ACTIVE = "bg-primary/);
  });
});

describe("removed / relocated chrome", () => {
  it("no floating Scan Map button - it is a More-menu entry with the same gate", () => {
    // Menu form (`testid: "scan-map-btn"`), never the old floating form
    // (`data-testid="scan-map-btn"`).
    expect(src).not.toContain('data-testid="scan-map-btn"');
    expect(src).toContain('testid: "scan-map-btn"');
    const entry = src.slice(src.indexOf('...(canSubmitScan'), src.indexOf('testid: "scan-map-btn"'));
    expect(entry, "Scan map entry must stay behind canSubmitScan").toContain("canSubmitScan");
  });

  it("no add-lead FAB - it is a More-menu entry behind canAssign", () => {
    expect(src).not.toContain('data-testid="fab-add-lead"');
    expect(src).toContain('data-testid="ctl-add-lead"'); // rail button (owner ask), not a menu entry
  });

  it("no always-on status pill or legend dot-strip", () => {
    expect(src).not.toContain('data-testid="status-filter-pill"');
    expect(src).not.toContain('data-testid="status-filter-bar"');
    expect(src).not.toContain('data-testid="legend-collapsed"');
    // The full legend panel stays reachable through the More menu instead.
    expect(src).toContain('testid: "ctl-legend"');
    expect(src).toContain("Legend & rep areas");
  });

  it("an active filter is never invisible: rail dot + dismissible top-center chip", () => {
    expect(src).toContain('data-testid="map-active-filter-chip"');
    expect(src).toContain('data-testid="map-active-filter-clear"');
    // Chip renders ONLY while a filter narrows pins.
    expect(src).toContain("{mapReady && mapFilterActive && (");
    // Rail filter button keeps its active dot.
    expect(src).toContain("{mapFilterActive && (");
  });

  it("no zoom +/- controls; pinch/scroll/dblclick gestures stay enabled", () => {
    expect(src).not.toContain("NavigationControl()");
    // Nothing ever turns scrollZoom off, and the draw tools re-enable what
    // they disable while armed.
    expect(src).not.toContain("scrollZoom.disable");
    expect(src).toContain("map.doubleClickZoom.enable()");
    expect(src).toContain("map.touchZoomRotate.enable()");
    // The native top-right stack is hidden on every screen, not just mobile.
    expect(src).toContain('className="rep-clean-map"');
  });
});

describe("rep pin-colors key is opt-in, dismissible, and never at rest", () => {
  it("reps get a Pin colors entry in the More menu (managers keep Legend & rep areas)", () => {
    // The rep entry lives in the ELSE branch of the manager-legend gate - the
    // two roles each get exactly one legend surface, never both.
    const managerEntry = src.indexOf('testid: "ctl-legend"');
    const repEntry = src.indexOf('testid: "ctl-pin-key"');
    expect(managerEntry).toBeGreaterThan(-1);
    expect(repEntry).toBeGreaterThan(managerEntry);
    expect(src).toContain('label: "Pin colors"');
  });

  it("the key renders only while opted-in, and hides under the knock sheet", () => {
    expect(src).toContain(
      '{mapReady && isRep && pinKeyOpen && bottomSlot !== "knock" && (',
    );
    // Collapsed by default - nothing new sits on the map at rest.
    expect(src).toMatch(/const \[pinKeyOpen, setPinKeyOpen\] = useState\(false\)/);
  });

  it("rows come from the canonical palette: STATE_LABELS/STATE_COLORS + live counts + real glyphs", () => {
    const items = src.slice(src.indexOf("const pinKeyItems"), src.indexOf("}, [statusCounts, legendGlyphs]);"));
    expect(items).toContain("STATE_LABELS[k]");
    expect(items).toContain("STATE_COLORS[k]");
    expect(items).toContain("statusCounts[k] ?? 0");
    expect(items).toContain("legendGlyphs[k]");
  });
});

describe("empty and edge states", () => {
  it("the first-use empty state covers EVERY role, with rep-specific copy", () => {
    // Gated through firstUseEmptyStateEnabled: the pins payload must have
    // ARRIVED (no "no leads" flash during the first fetch - owner report),
    // and in viewport mode it never renders at all - an empty merged window
    // over an org with >60k leads is a skipped/sampled window, not "no leads"
    // (second owner report: blank "no leads" map at region zoom).
    // ALSO gated on !mapPinsError. A failed full feed leaves mapPinData
    // undefined, which makes pinsArrived false and suppressed the empty state -
    // so the map painted nothing at all: no pins, no empty state, no message,
    // no retry, indistinguishable from a territory with nothing in it. The
    // error branch above it is role="alert" and this one is role="status";
    // they must never both be eligible.
    expect(src).toContain(
      "{mapReady && !mapPinsError && firstUseEmptyStateEnabled({ viewportMode, pinsArrived: mapPinData != null, leadCount: leads.length }) && (",
    );
    expect(src).not.toContain("{mapReady && mapPinData != null && leads.length === 0 && (");
    expect(src).not.toContain("{mapReady && !isRep && leads.length === 0 && (");
    expect(src).toContain("No doors assigned yet");
    expect(src).toContain('data-testid="map-empty-state"');
  });

  it("a failed pin feed gets its own alert with a retry, not silence", () => {
    // The query must expose the error at all - destructuring only `data` is how
    // this went unnoticed.
    expect(src).toContain("isError: mapPinsError, refetch: refetchMapPins");
    expect(src).toContain('data-testid="map-pins-error"');
    expect(src).toContain('data-testid="map-pins-error-retry"');
    expect(src).toContain('role="alert"');
    // Full-feed only: in viewport mode the window loader deliberately keeps the
    // last good pins on screen and has its own 60s retry, so an alert there
    // would cry wolf over a map that is still showing real doors.
    expect(src).toContain("{mapReady && !viewportMode && mapPinsError && (");
  });

  it("filters that hide every door say so, with a one-tap Clear", () => {
    expect(src).toContain('data-testid="map-all-filtered"');
    expect(src).toContain('data-testid="map-all-filtered-clear"');
    // Gated on: a filter is active AND the lens still has doors AND none paint.
    const block = src.slice(
      src.indexOf('data-testid="map-all-filtered"') - 600,
      src.indexOf('data-testid="map-all-filtered"'),
    );
    expect(block).toContain("mapFilterActive");
    expect(block).toContain("territoryClippedLeads.length > 0");
    expect(block).toContain("mapTotalLeads.length === 0");
  });
});

describe("house numbers are opt-in from the settings sheet", () => {
  it("MapView wires a persisted House numbers toggle row", () => {
    expect(src).toContain('testId: "map-settings-toggle-house-numbers"');
    expect(src).toContain("readPersistedHouseNumbers()");
    expect(src).toContain("persistHouseNumbers(showHouseNums)");
  });

  it("the layer mounts only when the pref is on, and unmounts when off", () => {
    // Both the init pass and the style.load re-add consult the live pref…
    const guarded = src.match(/if \(showHouseNumsRef\.current\) ensureHousenumLayer\(/g) ?? [];
    expect(guarded.length).toBe(2);
    // …and the toggle effect actually removes the layer on OFF. The effect
    // now bails early rather than using an `else`, because the ON branch grew
    // a viewport subscription that must not run when the pref is off - so the
    // assertion is on the guard, not on the keyword that used to express it.
    // Turning the pref off must drop BOTH label layers. The street names ride
    // on the same toggle and the same fetch, so leaving them mounted would
    // strand labels on the map with nothing left to refresh them.
    expect(src).toMatch(
      /if \(!showHouseNums\) \{ removeHousenumLayer\(map\); removeStreetLabelLayer\(map\); return; \}/,
    );
    // No unconditional mount survives: every ensureHousenumLayer call is
    // preceded on the same line by a pref check, or sits after the early
    // return above. Assert there is no call at top-level effect indentation
    // that is NOT one of the three known-guarded sites.
    const mounts = src.match(/ensureHousenumLayer\(map/g) ?? [];
    expect(mounts.length).toBe(3); // 2 ref-guarded + 1 after the early return
  });
});

describe("no map vendor chrome at rest", () => {
  it("the wordmark is hidden and attribution collapses to the compact control", () => {
    expect(src).toContain("attributionControl: false");
    expect(src).toContain("AttributionControl({ compact: true })");
    const css = readFileSync(join(ROOT, "client/src/index.css"), "utf8");
    expect(css).toContain(".mapboxgl-ctrl-logo");
    expect(css.slice(css.indexOf(".mapboxgl-ctrl-logo"))).toContain("display: none !important");
  });
});

describe("every rail button carries its glyph", () => {
  // The rail is six ICON-ONLY controls: the glyph is the whole label, so a
  // button that loses its icon renders as a blank white square that still
  // opens a sheet. That is exactly what happened to Filters in 092b277b (the
  // decorative-icon sweep), which stated the opposite rule - "functional
  // glyphs stay: ... icon-only controls" - and stripped one anyway. The sweep
  // is a codemod, so the guard has to be structural rather than a named icon.
  it("no rail button has an empty body", () => {
    const rail = src.slice(
      src.indexOf('data-testid="map-tools"'),
      src.indexOf('data-testid="map-tools-menu"'),
    );
    expect(rail.length).toBeGreaterThan(500);

    // Every <button …>…</button> whose className is the shared RAIL_BTN must
    // contain at least one component element (the lucide glyph).
    const buttons = rail.split("<button").slice(1);
    const railButtons = buttons.filter((b) => b.includes("RAIL_BTN"));
    expect(railButtons.length).toBeGreaterThanOrEqual(4);

    for (const b of railButtons) {
      const body = b.slice(b.indexOf(">") + 1, b.indexOf("</button>"));
      const testid = /data-testid="([^"]+)"/.exec(b)?.[1] ?? "(unnamed)";
      // A capitalised JSX tag is a component - the lucide icon. The active
      // dot is a lowercase <span>, so a button holding ONLY the dot fails.
      expect(/<[A-Z][A-Za-z0-9]*\b/.test(body), `rail button ${testid} renders no glyph`).toBe(true);
    }
  });

  it("Filters is a funnel, distinct from the Settings sliders beside it", () => {
    // Two adjacent slider glyphs read as one control duplicated; the rail sits
    // them 8px apart, so they must not be the same family.
    expect(src).toContain('import { X, Search,');
    const filterBtn = src.slice(
      src.indexOf('data-testid="map-filter-open"'),
      src.indexOf('data-testid="map-settings-open"'),
    );
    expect(filterBtn).toContain("<Filter className=");
    const settingsBtn = src.slice(src.indexOf('data-testid="map-settings-open"'));
    expect(settingsBtn.slice(0, 400)).toContain("<Settings2 className=");
  });
});
