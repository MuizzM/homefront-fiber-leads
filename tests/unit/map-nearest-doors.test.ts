// The Nearest doors strip on the field map, pinned at the source level the
// way the other MapView contracts are (the page cannot mount without a GL
// context). These are the rules that keep the strip honest and quiet.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const src = readFileSync(join(ROOT, "client/src/pages/MapView.tsx"), "utf8");
const between = (from: string, to: string) => {
  const a = src.indexOf(from);
  expect(a, `missing ${from}`).toBeGreaterThan(-1);
  const b = src.indexOf(to, a);
  expect(b, `missing ${to}`).toBeGreaterThan(a);
  return src.slice(a, b);
};

describe("Nearest doors strip (MapView wiring)", () => {
  it("shows only on the rep map while nothing else owns the bottom of the map", () => {
    const gate = between("const nearestVisible =", ";");
    for (const term of ["mapReady", "isRep", "!nearestHidden", "!pinKeyOpen", "selectedLeadId == null", "!lassoMode", "!addMode"]) {
      expect(gate).toContain(term);
    }
  });

  it("ranks nothing from a loose fix and excludes the doors just worked", () => {
    const memo = between("const nearest = useMemo(", "}, [nearestVisible, repFix, leads]);");
    expect(memo).toContain("repFix.accuracy > 200");
    expect(memo).toContain("excludeIds: new Set(recentIdsRef.current)");
    expect(memo).toContain("rankNearestDoors");
  });

  it("refreshes slowly, pauses in a hidden tab, and is fed by the geolocate control", () => {
    // The same slow refresh also runs while a card is open: its Next door row
    // ranks from this fix, and a rep can stand at a door for minutes.
    expect(src).toContain("const fixWanted = nearestVisible || selectedLeadId != null;");
    const effect = between("if (!fixWanted) return;", "}, [fixWanted, noteRepFix]);");
    expect(effect).toContain('document.visibilityState === "hidden"');
    expect(effect).toContain("window.setInterval(refresh, 45_000)");
    expect(effect).toContain("captureFieldFix(3500)");
    // The geolocate handler feeds the same state (throttled in noteRepFix).
    const handler = between('geolocate.on("geolocate", (e: any) => {', "gpsCenteredRef.current = true");
    expect(handler).toContain("noteRepFix(");
    expect(between("const noteRepFix = useCallback(", "}, []);")).toContain("5_000");
  });

  it("replaces the Next-door FAB rather than stacking on it, and sits above the FAB row", () => {
    const strip = between("<NearestDoorsStrip", "/>");
    expect(strip).toContain('bottom: "calc(env(safe-area-inset-bottom) + 2rem + 64px)"');
    expect(strip).toContain("onHide={() => setNearestHidden(true)}");
    const fabGate = between('{mapReady && isRep && selectedLeadId == null && leads.length > 0 && !(', "<button");
    expect(fabGate).toContain("nearestVisible && nearest.doors.length > 0)");
  });

  it("never sends the device position anywhere: the fix only feeds local state", () => {
    const block = between("const [repFix, setRepFix]", "const [nearestHidden");
    expect(block).not.toMatch(/apiRequest|fetch\(/);
  });
});
