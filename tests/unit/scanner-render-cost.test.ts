// The scanner pages were the last surfaces still paying per-event/per-render
// full-dataset costs while a live scan streams:
//
//  - CityScanner appended ONE result per setState (`[...prev.results, payload]`),
//    which is an O(n) array copy × n events = O(n²) across a run, plus a render
//    per address — and then re-ran an UNMEMOIZED filter().sort() over the whole
//    result set on every one of those renders (and on every 3s/8s poll tick).
//  - USAScanner rebuilt filter + group-by-state + THREE sorts of the market
//    catalog in the render body — per search keystroke, per SSE progress event,
//    per scanner-state poll — and re-sorted every open state's city list inside
//    the render map.
//  - MapView's lasso ran chaikinSmooth over the whole stroke once per accepted
//    pointer sample (up to 120Hz), when the canvas can only present one frame.
//
// Same rationale as lasso-geometry-wiring.test.ts: these pages can't be mounted
// cheaply (SSE, Mapbox), but each fix is a one-line edit away from silently
// reverting, so pin the WIRING at source level.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const city = readFileSync(join(process.cwd(), "client/src/pages/CityScanner.tsx"), "utf8");
const usa = readFileSync(join(process.cwd(), "client/src/pages/USAScanner.tsx"), "utf8");
const map = readFileSync(join(process.cwd(), "client/src/pages/MapView.tsx"), "utf8");

describe("CityScanner streams stay linear", () => {
  it("batches SSE result events instead of one setState per address", () => {
    // The O(n²) shape this guards: `results: [...prev.results, payload]`
    // executed once per streamed result line.
    expect(city).not.toMatch(/results:\s*\[\.\.\.prev\.results,\s*payload\]/);
    expect(city).toContain("resultBatch.push(payload)");
    // The batch must actually flush — once per chunk, and before the terminal
    // event replaces the whole status object.
    expect(city.match(/flushResults\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(city).toMatch(/prev\.results\.concat\(rows\)/);
  });

  it("memoizes the filtered+sorted result list (it was a bare render-body chain)", () => {
    expect(city).toMatch(/const filteredResults = useMemo\(/);
  });

  it("counts filter chips in one pass, not one filter() per verdict per render", () => {
    expect(city).toMatch(/const verdictCounts = useMemo\(/);
    expect(city).not.toMatch(/results\.filter\(r => verdictOf\(r\) === f\)\.length/);
  });
});

describe("USAScanner catalog passes stay off the render path", () => {
  it("filter/group/sort of the market catalog is memoized", () => {
    expect(usa).toMatch(/const \{ filtered, byState, states \} = useMemo\(/);
  });

  it("does not re-sort a state's city list inside the render map", () => {
    // Sorting belongs in the byState memo; `cityList.sort(` in JSX re-sorted
    // every open group on every render AND mutated the grouped arrays in place.
    expect(usa).not.toContain("cityList.sort(");
  });

  it("metric-strip tallies are a single memoized pass over the catalog", () => {
    expect(usa).toMatch(/const marketStats = useMemo\(/);
    expect(usa).not.toMatch(/markets\.reduce\(\(sum,m\)=>sum\+m\.addressCount,0\)/);
  });
});

describe("MapView lasso smoothing is frame-coalesced", () => {
  // Bound move() the same way lasso-geometry-wiring bounds finish().
  const moveBody = (() => {
    const at = map.indexOf("const move = (lngLat: any, point: any) => {");
    expect(at, "lasso move() not found in MapView — did the effect move?").toBeGreaterThan(-1);
    const end = map.indexOf("const finish = () => {", at);
    expect(end, "finish() not found after move() — cannot bound the body").toBeGreaterThan(at);
    return map.slice(at, end);
  })();

  it("move() schedules a coalesced repaint instead of smoothing per pointer sample", () => {
    expect(moveBody).toContain("scheduleStrokeRender()");
    expect(moveBody).not.toContain("render(false)");
  });

  it("the coalesced flush is guarded so it cannot repaint after finish/cancel", () => {
    expect(map).toMatch(
      /const scheduleStrokeRender = createRafCoalescedFlush\(\(\) => \{\s*if \(drawing\) render\(false\);/,
    );
  });
});
