import { describe, it, expect } from "vitest";
import { STATE_COLORS, type PinDisplayState } from "../../shared/knock";
import {
  STATUS_ICON,
  DISPLAY_STATES,
  ICON_PREFIX,
  iconImageMatchExpression,
  type StatusIconKey,
} from "../../client/src/lib/statusIcons";

// The display states, sourced the same way statusIcons derives them — from the
// canonical palette. If knock.ts adds a state, these tests fail until it has an
// icon, which is the point (the icon set can never silently omit a state).
const displayStates = Object.keys(STATE_COLORS) as PinDisplayState[];
const HEX = /^#[0-9a-f]{6}$/i;

describe("STATUS_ICON config", () => {
  it("covers every PinDisplayState", () => {
    for (const ds of displayStates) {
      const icon = STATUS_ICON[ds];
      expect(icon, `missing icon for "${ds}"`).toBeDefined();
      expect(icon.key).toBe(`${ICON_PREFIX}${ds}`);
      expect(typeof icon.glyph).toBe("string");
      expect(icon.glyph.length).toBeGreaterThan(0);
    }
  });

  it("has a neutral fallback entry", () => {
    expect(STATUS_ICON.neutral).toBeDefined();
    expect(STATUS_ICON.neutral.key).toBe(`${ICON_PREFIX}neutral`);
    expect(STATUS_ICON.neutral.glyph.length).toBeGreaterThan(0);
  });

  it("exposes DISPLAY_STATES matching the palette (no drift)", () => {
    expect([...DISPLAY_STATES].sort()).toEqual([...displayStates].sort());
  });

  it("every icon references a real STATE_COLORS color via its tint", () => {
    for (const key of Object.keys(STATUS_ICON) as StatusIconKey[]) {
      const tint = STATUS_ICON[key].tint;
      const color = STATE_COLORS[tint];
      expect(color, `icon "${key}" tint "${tint}" is not a STATE_COLORS key`).toBeDefined();
      expect(color).toMatch(HEX);
    }
  });

  it("uses unique, prefixed image keys", () => {
    const keys = Object.values(STATUS_ICON).map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(k.startsWith(ICON_PREFIX)).toBe(true);
  });

  it("keeps the spec glyph meanings", () => {
    expect(STATUS_ICON.unworked.glyph).toBe("home");
    expect(STATUS_ICON.not_home.glyph).toBe("door");
    expect(STATUS_ICON.interested.glyph).toBe("star");
    expect(STATUS_ICON.follow_up.glyph).toBe("clock");
    expect(STATUS_ICON.callback.glyph).toBe("phone");
    expect(STATUS_ICON.sold.glyph).toBe("check");
    expect(STATUS_ICON.not_interested.glyph).toBe("x");
    expect(STATUS_ICON.contacted.glyph).toBe("dot");
  });
});

describe("iconImageMatchExpression", () => {
  it("is a valid match on ['get','ds'] with a string fallback", () => {
    const expr = iconImageMatchExpression();
    expect(expr[0]).toBe("match");
    expect(expr[1]).toEqual(["get", "ds"]);

    const body = expr.slice(2);
    const fallback = body[body.length - 1];
    // A match's last element is the fallback — must be the neutral image so an
    // unknown/failed status still paints something.
    expect(typeof fallback).toBe("string");
    expect(fallback).toBe(STATUS_ICON.neutral.key);

    // Everything before the fallback is label/value pairs — even count.
    const pairs = body.slice(0, -1);
    expect(pairs.length % 2).toBe(0);
    expect(pairs.length / 2).toBe(displayStates.length);
  });

  it("maps every display state to its own image key", () => {
    const expr = iconImageMatchExpression();
    const pairs = expr.slice(2, -1);
    const seen = new Set<string>();
    for (let i = 0; i < pairs.length; i += 2) {
      const label = pairs[i] as PinDisplayState;
      const value = pairs[i + 1];
      expect(displayStates).toContain(label);
      expect(value).toBe(STATUS_ICON[label].key);
      seen.add(label);
    }
    // Exactly the display states, each once.
    expect([...seen].sort()).toEqual([...displayStates].sort());
  });

  it("contains no nested zoom expression (Mapbox top-level-zoom rule)", () => {
    // A zoom expression may only live at the TOP LEVEL of a paint/layout
    // property, never inside the icon-image match. Icon SIZE carries the zoom.
    expect(JSON.stringify(iconImageMatchExpression())).not.toContain("zoom");
  });
});
