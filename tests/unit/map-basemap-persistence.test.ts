// The basemap choice has to survive a launch.
//
// Every other control in the Map settings sheet persists - the status filter
// (hf.mapFilterStatus.v1), the source lens (hf.mapFilterSource.v2), house
// numbers (hf.mapHouseNumbers.v2) - and the camera does too. The basemap did
// not: mapStyleMode was `useState("satellite")`, so a rep who works nights on
// Dark got thrown back to Satellite on every cold open and had to re-pick it.
import { beforeEach, describe, expect, it } from "vitest";
import {
  BASEMAP_MODE_LS_KEY,
  DEFAULT_BASEMAP_MODE,
  persistBasemapMode,
  readPersistedBasemapMode,
} from "@/lib/mapPins";

beforeEach(() => {
  localStorage.clear();
});

describe("readPersistedBasemapMode", () => {
  it("defaults to satellite when nothing was ever stored", () => {
    expect(readPersistedBasemapMode()).toBe("satellite");
    expect(DEFAULT_BASEMAP_MODE).toBe("satellite");
  });

  it("round-trips every mode the sheet can select", () => {
    for (const mode of ["satellite", "streets", "dark"] as const) {
      persistBasemapMode(mode);
      expect(readPersistedBasemapMode()).toBe(mode);
    }
  });

  it("falls back to the default on a value basemapStyle() has no tiles for", () => {
    // A hand-edited or stale key must never reach basemapStyle(), which would
    // index BASEMAP_TILES with undefined and throw on the map's first frame.
    localStorage.setItem(BASEMAP_MODE_LS_KEY, "terrain");
    expect(readPersistedBasemapMode()).toBe(DEFAULT_BASEMAP_MODE);
  });

  it("falls back to the default on an empty value", () => {
    localStorage.setItem(BASEMAP_MODE_LS_KEY, "");
    expect(readPersistedBasemapMode()).toBe(DEFAULT_BASEMAP_MODE);
  });
});

describe("storage-blocked degradation", () => {
  // Private mode / blocked storage must degrade to a session-only choice, the
  // same way readPersistedHouseNumbers and readPersistedFilterStatus do -
  // never throw on the map's boot path.
  const withBrokenStorage = (fn: () => void) => {
    const real = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("storage blocked");
      },
    });
    try {
      fn();
    } finally {
      if (real) Object.defineProperty(window, "localStorage", real);
    }
  };

  it("reads as the default instead of throwing", () => {
    withBrokenStorage(() => {
      expect(readPersistedBasemapMode()).toBe(DEFAULT_BASEMAP_MODE);
    });
  });

  it("writes silently instead of throwing", () => {
    withBrokenStorage(() => {
      expect(() => persistBasemapMode("dark")).not.toThrow();
    });
  });
});
