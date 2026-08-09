// Follow-camera freeze regression pins (field report: "the map won't change
// direction — it freezes, I can't move").
//
// Root cause: the follow loop issues map.jumpTo once per animation frame, and
// every external jumpTo runs map.stop() → HandlerManager.stop(), which resets
// in-progress gesture recognition. Unless jumpTo pauses while a finger is on
// the map, a pan/rotate can never cross its start threshold, so the
// dragstart/rotatestart break-out never fires and the map reads as frozen.
// `interacting` was the intended guard — it was READ in frame() but nothing
// ever set it. These are source-level assertions in the same spirit as
// map-instant-actions.test.ts: rendering MapView for real needs mapbox + ~8k
// lines of page, and "the guard has a writer / every disable has a matching
// re-enable" are properties the source states directly.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const src = readFileSync(join(ROOT, "client/src/pages/MapView.tsx"), "utf8");

// All match positions of a regex (global flag enforced).
function positions(re: RegExp): number[] {
  const flags = re.flags.includes("g") ? re.flags : re.flags + "g";
  const g = new RegExp(re.source, flags);
  const out: number[] = [];
  for (let m = g.exec(src); m; m = g.exec(src)) out.push(m.index);
  return out;
}

describe("user-is-interacting guard - the camera writer pauses under a finger", () => {
  it("a pointerdown listener on the map surface SETS interacting (the guard has a writer)", () => {
    // The historical bug: `interacting` was checked but never assigned true.
    const setter = src.match(
      /const onPointerDown = \(\) => \{[\s\S]{0,200}?interacting = true;/,
    );
    expect(setter, "onPointerDown must set interacting = true").toBeTruthy();
    expect(src).toContain(
      'gestureSurface.addEventListener("pointerdown", onPointerDown)',
    );
    expect(src).toContain("map.getCanvasContainer()");
  });

  it("pointerup AND pointercancel clear the flag only when the last pointer lifts", () => {
    const clearer = src.match(
      /const onPointerUp = \(\) => \{[\s\S]{0,300}?if \(pointersDown === 0\) interacting = false;/,
    );
    expect(clearer, "onPointerUp must clear interacting at zero pointers").toBeTruthy();
    expect(src).toContain('window.addEventListener("pointerup", onPointerUp)');
    expect(src).toContain('window.addEventListener("pointercancel", onPointerUp)');
  });

  it("the follow loop's jumpTo is gated on !interacting and tagged geolocateSource", () => {
    // frame(): `if (!interacting) map.jumpTo({ center: out.center }, { geolocateSource: true })`
    const gated = src.match(
      /if \(!interacting\)\s*\n\s*map\.jumpTo\(\{ center: out\.center \}, \{ geolocateSource: true \}\)/,
    );
    expect(gated, "frame() must skip jumpTo while interacting and tag the move").toBeTruthy();
  });

  it("the pointer listeners are removed in the map effect's cleanup", () => {
    expect(src).toContain(
      'gestureSurface.removeEventListener("pointerdown", onPointerDown)',
    );
    expect(src).toContain('window.removeEventListener("pointerup", onPointerUp)');
    expect(src).toContain(
      'window.removeEventListener("pointercancel", onPointerUp)',
    );
  });
});

describe("follow-break listeners - any user gesture breaks follow until re-tap", () => {
  it("dragstart plus zoom/rotate/pitch starts are wired to the break-out", () => {
    expect(src).toContain('map.on("dragstart", onDragStart)');
    const starts = src.match(
      /const gestureStarts = \[([^\]]*)\]/,
    );
    expect(starts).toBeTruthy();
    for (const evn of ["zoomstart", "rotatestart", "pitchstart"]) {
      expect(starts![1]).toContain(`"${evn}"`);
    }
    expect(src).toContain("for (const evn of gestureStarts) map.on(evn, onGestureStart)");
  });

  it("the geolocateSource tag test skips ONLY programmatic moves (not inverted, not broadened)", () => {
    // Both start handlers early-return on the tag and then suspend follow —
    // an inverted test (`if (!ev?.geolocateSource) return`) would classify
    // USER gestures as programmatic and never break follow.
    for (const name of ["onDragStart", "onGestureStart"]) {
      const body = src.match(
        new RegExp(
          `const ${name} = \\(ev: any\\) => \\{\\s*\\n\\s*if \\(ev\\?\\.geolocateSource\\) return;[\\s\\S]{0,300}?suspendFollow\\(\\);`,
        ),
      );
      expect(body, `${name} must gate on the tag then call suspendFollow`).toBeTruthy();
    }
    expect(src).not.toMatch(/if \(!ev\?\.geolocateSource\) return/);
  });

  it("suspendFollow actually turns follow off and stops the loop", () => {
    const body = src.match(
      /const suspendFollow = \(\) => \{[\s\S]{0,400}?following = false;[\s\S]{0,200}?stopLoop\(\);/,
    );
    expect(body).toBeTruthy();
  });

  it("desktop wheel breaks follow before the loop can cancel the wheel zoom", () => {
    expect(src).toMatch(
      /const onWheelBreak = \(\) => \{\s*\n\s*if \(following\) suspendFollow\(\);/,
    );
    expect(src).toContain(
      'gestureSurface.addEventListener("wheel", onWheelBreak, { passive: true })',
    );
  });
});

describe("gesture-handler disable/re-enable symmetry - no exit path leaves the map dead", () => {
  // Every draw tool that disables a mapbox gesture handler must re-enable it
  // on EVERY exit (the re-enables live in effect cleanups, which React runs on
  // completion, cancel, mode switch, style swap, and unmount alike).
  const handlers = ["dragPan", "doubleClickZoom", "touchZoomRotate", "touchPitch"];

  for (const h of handlers) {
    it(`${h}: every disable() is followed by a matching enable()`, () => {
      const disables = positions(new RegExp(`map\\.${h}\\??\\.disable\\(\\)`));
      const enables = positions(new RegExp(`map\\.${h}\\??\\.enable\\(\\)`));
      expect(disables.length, `${h} is expected to be disabled somewhere`).toBeGreaterThan(0);
      expect(enables.length, `${h} enable/disable counts must match`).toBe(disables.length);
      // Interleaving: each disable is re-enabled before the next disable, and
      // each enable sits in a cleanup (`return () => {`) after its disable.
      for (let i = 0; i < disables.length; i++) {
        expect(
          enables[i],
          `${h} disable #${i + 1} must have a subsequent enable`,
        ).toBeGreaterThan(disables[i]);
        if (i + 1 < disables.length) {
          expect(
            enables[i],
            `${h} enable #${i + 1} must precede the next disable (no overlap window)`,
          ).toBeLessThan(disables[i + 1]);
        }
        const between = src.slice(disables[i], enables[i]);
        expect(
          between.includes("return () => {"),
          `${h} enable #${i + 1} must live in an effect cleanup`,
        ).toBe(true);
      }
    });
  }
});

describe("mode exclusivity - draw tools and add-mode never stack", () => {
  it("arming the lasso stands add-mode AND scan-draw down", () => {
    const lassoArm = src.match(
      /exitLasso\(\);\s*\n\s*setAddMode\(false\); \/\/ draw tools and add-mode are mutually exclusive[\s\S]{0,900}?setLassoMode\(true\)/,
    );
    expect(lassoArm, "lasso arm branch must exist").toBeTruthy();
    expect(lassoArm![0]).toContain("setScanDrawMode(false)");
  });

  it("arming scan-draw stands the lasso and add-mode down", () => {
    const scanArm = src.match(
      /exitLasso\(\);\s*\n\s*setAddMode\(false\);[\s\S]{0,200}?setScanDrawMode\(true\)/,
    );
    expect(scanArm).toBeTruthy();
  });

  it("arming add-mode stands the lasso and scan-draw down", () => {
    const addArm = src.match(
      /if \(!addMode\) \{[\s\S]{0,200}?exitLasso\(\);[\s\S]{0,120}?setScanDrawMode\(false\);[\s\S]{0,120}?\}\s*\n\s*setAddMode\(!addMode\)/,
    );
    expect(addArm).toBeTruthy();
  });
});

describe("locate FAB reflects the real tracking state", () => {
  it("followEngaged mirrors every writer of the imperative `following` flag", () => {
    // Engage
    expect(src).toMatch(
      /following = true;\s*\n\s*setFollowEngaged\(true\);/,
    );
    // Both disengage paths (control end + user break-out)
    const offMirrors = positions(
      /following = false;\s*\n\s*setFollowEngaged\(false\);/,
    );
    expect(offMirrors.length).toBeGreaterThanOrEqual(2);
  });

  it("the FAB exposes the state via aria-pressed", () => {
    expect(src).toContain("aria-pressed={followEngaged}");
  });
});
