// Every map surface must go through the loader's failure contract.
//
// mapLibrary.ts exists because "the library never arrived" used to be SILENCE:
// on a blocked CDN, a captive portal or a dropped LTE fetch the callback simply
// never fired, and the screen sat on its spinner forever with nothing to say
// why and nothing to retry with. Its header calls this out in capitals -
// FAILURE IS A STATE, NOT SILENCE - and it invokes callbacks WITH an Error so
// callers can render that state.
//
// LiveMap did not use it. It polled for the global instead:
//
//     const tryInit = () => {
//       const mgl = (window as any).mapboxgl;
//       if (!mgl) { setTimeout(tryInit, 150); return; }
//       ...
//
// which has no bail (it spins behind the skeleton forever on a failed load) and
// no cleanup (unmounting mid-load left a pending timer that then constructed a
// map into a null container). This pins the fix, and pins the pattern for the
// next surface someone adds.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const SURFACES = [
  "client/src/pages/LiveMap.tsx",
  "client/src/components/area/AreaMiniMap.tsx",
];

describe.each(SURFACES)("%s", (path) => {
  const src = read(path);

  it("registers through __onMapboxReady rather than polling for the global", () => {
    expect(src).toContain("__onMapboxReady");
    // The self-rescheduling poll is the anti-pattern: no bail, no cleanup.
    expect(src).not.toMatch(/setTimeout\(\s*tryInit/);
  });

  it("guards the async init against unmount", () => {
    // Otherwise a late callback builds a map into a container React already
    // detached, or calls setState on a dead component.
    expect(src).toContain("cancelled = true");
    expect(src).toMatch(/if \(cancelled/);
  });

  it("renders a terminal failure state instead of an endless placeholder", () => {
    expect(src).toMatch(/setMapUnavailable\(true\)|setState\("unavailable"\)/);
  });
});

describe("LiveMap retry actually rebuilds the map", () => {
  const src = read("client/src/pages/LiveMap.tsx");

  it("clears the loader latch AND re-registers the ready callback", () => {
    // __retryMapbox() refetches the library, but the callback list was already
    // flushed with the error - so clearing the latch alone loads a library that
    // nothing then uses. The retry counter re-runs the effect, which
    // re-registers init.
    expect(src).toContain("__retryMapbox");
    expect(src).toContain("setLibRetry(n => n + 1)");
    expect(src).toContain("}, [config?.token, libRetry]);");
  });

  it("does not short-circuit the rebuild on a stale map ref", () => {
    // The effect's own guard is `mapRef.current` - a failed load never set it,
    // so a retry is free to proceed.
    expect(src).toContain("if (cancelled || mapRef.current) return;");
  });
});
