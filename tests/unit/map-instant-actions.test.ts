// Instant map actions — optimistic-before-network ordering (owner directive:
// "marking needs to be instant fast so the whole experience is smooth").
//
// Contract: handleCentralMark and handleDeleteLead update the pin (recolor /
// remove), the map cache, and the toast BEFORE their first `await` on the
// network, and both carry a rollback in the catch arm. Source-level assertions
// in the same spirit as map-chrome-minimal.test.ts: rendering MapView for real
// needs mapbox + ~8k lines of page, and "optimistic write precedes the await"
// is an ordering property the source states directly.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const src = readFileSync(join(ROOT, "client/src/pages/MapView.tsx"), "utf8");

// The body of a `const NAME = useCallback(` block, bounded by the next
// top-level `const ` declaration — coarse but stable for ordering assertions.
function callbackBody(name: string): string {
  const start = src.indexOf(`const ${name} = useCallback(`);
  expect(start, `${name} must exist`).toBeGreaterThan(-1);
  const end = src.indexOf("\n  const ", start + 10);
  return src.slice(start, end > start ? end : start + 6000);
}

describe("central mark is optimistic — recolor before the round-trip", () => {
  const body = callbackBody("handleCentralMark");
  const firstAwait = body.indexOf("await apiRequest");

  it("mutates the GeoJSON feature and re-clusters before the first await", () => {
    const recolor = body.indexOf("scheduleClusterSetData()");
    expect(recolor).toBeGreaterThan(-1);
    expect(recolor).toBeLessThan(firstAwait);
  });

  it("writes the map cache and fires the success toast before the first await", () => {
    const cacheWrite = body.indexOf('qc.setQueryData(["/api/leads/map"]');
    const successToast = body.indexOf('"Marked centrally"');
    expect(cacheWrite).toBeGreaterThan(-1);
    expect(cacheWrite).toBeLessThan(firstAwait);
    expect(successToast).toBeGreaterThan(-1);
    expect(successToast).toBeLessThan(firstAwait);
  });

  it("rolls the door back on failure (catch restores the prior pin state)", () => {
    const catchArm = body.indexOf("catch (e");
    expect(catchArm).toBeGreaterThan(firstAwait);
    const after = body.slice(catchArm);
    expect(after).toContain("prevProps");
    expect(after).toContain("reverted");
  });
});

describe("delete lead is optimistic — pin vanishes before the round-trip", () => {
  const body = callbackBody("handleDeleteLead");
  const firstAwait = body.indexOf("await apiRequest");

  it("removes the feature, updates the cache, and closes the card before the first await", () => {
    const featureDrop = body.indexOf("featureByIdRef.current.delete(lead.id)");
    const cacheWrite = body.indexOf('qc.setQueryData(["/api/leads/map"]');
    const cardClose = body.indexOf("setSelectedLeadId(null)");
    for (const [label, pos] of [["feature removal", featureDrop], ["cache write", cacheWrite], ["card close", cardClose]] as const) {
      expect(pos, `${label} must exist`).toBeGreaterThan(-1);
      expect(pos, `${label} must precede the network await`).toBeLessThan(firstAwait);
    }
  });

  it("restores the pin on failure (catch re-adds the snapshotted feature)", () => {
    const catchArm = body.indexOf("catch (e");
    expect(catchArm).toBeGreaterThan(firstAwait);
    const after = body.slice(catchArm);
    expect(after).toContain("prevFeature");
    expect(after).toContain("prevPin");
    expect(after).toContain("lead restored");
  });
});
