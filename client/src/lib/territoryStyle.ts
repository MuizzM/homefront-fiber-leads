// How an area is painted on the map.
//
// This is extracted from MapView because the rendering here carried the bug that
// made assigned areas "not show up on the rep's phone". The old code branched on
// whether the viewer could ASSIGN territories:
//
//     const fillOpacity = !canAssign ? 0.05 : isPool ? 0.1 : isDone ? 0.08 : 0.14;
//
// Every rep fails `canAssign`, so a rep's own working boundary rendered at FIVE
// PERCENT fill with a 1.75px hairline. Over satellite imagery that is invisible.
// The polygon was fetched, added to the map, and painted too faintly to see —
// which is why it produced no error and why re-drawing the area never helped.
//
// It was also backwards. The person who needs the boundary most is the rep
// standing in it; the manager reviewing twenty areas at once is the one who
// benefits from restraint. Viewer ROLE is therefore not an input to this module
// at all. Density is handled where it belongs — the manager's show/hide toggle.
//
// The second bug lived one line above: the fill used colorForRep(repId), the
// rep's palette colour, discarding the colour the admin picked when drawing.
// territories.color was read in exactly one sidebar row and never for a polygon.

import { normalizeTerritoryColor } from "@shared/territory";

/** Fill opacities. The assigned case sits inside the 0.18–0.30 band that reads
 *  over satellite; "done" and "nobody's" are deliberately quieter because they
 *  are not ground anyone is being asked to walk right now. */
export const TERRITORY_FILL_OPACITY = { active: 0.22, completed: 0.12, pool: 0.1 } as const;
/** Border 2–3px at near-full opacity: the boundary is the thing a rep navigates
 *  by, so it stays crisp even where the fill is quiet. */
export const TERRITORY_LINE_WIDTH = { active: 2.5, completed: 2, pool: 2 } as const;
export const TERRITORY_LINE_OPACITY = { active: 0.95, completed: 0.85, pool: 0.7 } as const;

/** The "nobody owns this" slate, shared with colorForRep(null). */
export const TERRITORY_POOL_COLOR = "#94a3b8";

/** Dashes say "unclaimed" without needing a legend. */
export const TERRITORY_POOL_DASH: [number, number] = [3, 2];

export type TerritoryVisualStatus = "active" | "completed" | "pool";

export function territoryVisualStatus(status: string | null | undefined): TerritoryVisualStatus {
  if (status === "unassigned" || status === "reclaimed") return "pool";
  if (status === "completed") return "completed";
  return "active";
}

// Same validator the server accepts colours with, so a colour that saves is a
// colour that paints. See shared/territory.ts for why case is preserved.
const normalizeHex = normalizeTerritoryColor;

/**
 * The colour the area is actually painted.
 *
 * The stored colour WINS. It is what the admin chose while drawing, and the
 * whole point of choosing it is that everyone looking at the area sees the same
 * thing — a rep's own palette hue is a property of the rep, not of the ground.
 * `fallback` covers rows written before the colour was captured (and the pool,
 * which is nobody's and therefore has no owner colour to fall back to).
 */
export function territoryColor(
  territory: { color?: string | null; status?: string | null },
  fallback: string,
): string {
  if (territoryVisualStatus(territory.status) === "pool") return TERRITORY_POOL_COLOR;
  const stored = typeof territory.color === "string" ? normalizeHex(territory.color.trim()) : null;
  return stored ?? fallback;
}

/**
 * A darker version of the fill colour for the border — "a darker or fully
 * opaque version of that color". Multiplying each channel keeps the hue and only
 * drops luminance, so a green area keeps a green edge rather than drifting grey.
 * Unparseable input returns unchanged: a slightly-wrong border beats no border.
 */
export function darkenHex(hex: string, amount = 0.3): string {
  const normalized = normalizeHex(hex);
  if (!normalized) return hex;
  const factor = Math.max(0, Math.min(1, 1 - amount));
  const channel = (i: number) =>
    Math.round(parseInt(normalized.slice(1 + i * 2, 3 + i * 2), 16) * factor)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(0)}${channel(1)}${channel(2)}`;
}

export interface TerritoryPaint {
  fillColor: string;
  fillOpacity: number;
  lineColor: string;
  lineWidth: number;
  lineOpacity: number;
  lineDasharray?: [number, number];
}

/**
 * Everything needed to paint one area. Note the absence of a viewer argument —
 * that is the fix, not an oversight. Two people looking at the same area see the
 * same area.
 */
export function territoryPaint(
  territory: { color?: string | null; status?: string | null },
  fallbackColor: string,
): TerritoryPaint {
  const visual = territoryVisualStatus(territory.status);
  const fillColor = territoryColor(territory, fallbackColor);
  return {
    fillColor,
    fillOpacity: TERRITORY_FILL_OPACITY[visual],
    lineColor: darkenHex(fillColor),
    lineWidth: TERRITORY_LINE_WIDTH[visual],
    lineOpacity: TERRITORY_LINE_OPACITY[visual],
    ...(visual === "pool" ? { lineDasharray: TERRITORY_POOL_DASH } : {}),
  };
}

// ── Stacking ─────────────────────────────────────────────────────────────────
// Area layers were added with no beforeId, so they landed on TOP of every lead
// layer already on the map — a translucent sheet over the pins the rep came to
// tap. These are the lowest lead layers, in the order we would rather sit under;
// the first one present wins, and undefined (no lead layer yet) means "append",
// which is correct because the pins are added after us in that case.
export const TERRITORY_BEFORE_CANDIDATES = [
  "lead-clusters-glow",
  "lead-fresh-cluster-ring",
  "lead-clusters",
  "lead-cluster-count",
  "lead-unclustered",
  "lead-fresh-confirmed-halo",
];

export function territoryBeforeId(hasLayer: (id: string) => boolean): string | undefined {
  return TERRITORY_BEFORE_CANDIDATES.find((id) => {
    try {
      return !!hasLayer(id);
    } catch {
      return false; // map mid-teardown
    }
  });
}
