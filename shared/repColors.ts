// Deterministic per-rep territory colors — the ONE source of truth shared by the
// server (persists territory.color) and the map (renders regions/labels), so a
// rep's color is identical everywhere with no DB column and no migration.
//
// The list is 24 long, and the second twelve are APPEND-ONLY on purpose. The
// allocation is repId % REP_PALETTE.length, so growing the list from the end
// leaves reps 1-11 on exactly the hue they have always had — no churn for the
// people most likely to be on the map today — while reps 12-23, who previously
// wrapped around and collided with reps 0-11, finally get one of their own.
//
// Why the collision mattered more than it looks: on a SHARED door the halo
// renders one ring per distinct hue, so two reps who landed on the same swatch
// collapsed into a single ring and the door became pixel-identical to one only
// a single rep works. Twelve hues meant that started happening at a dozen reps,
// which is a small sales team, not a large one.
//
// The first twelve are high-chroma; the second twelve are deliberately deeper
// and lower-luminance rather than more hues crammed into the same band, because
// at pin size over satellite imagery a light cyan and a slightly-different light
// cyan are the same color. Pairing each bright hue with a dark sibling keeps the
// two halves separable at a glance.
//
// Past 24 distinct reps hues repeat again. That is a real limit, not a solved
// problem: see haloColorsForLead, which collapses a genuine duplicate rather
// than painting two identical concentric rings and lying about the crew size.
export const REP_PALETTE = [
  // Bright band — reps 0-11. Order and values are frozen; changing any entry
  // repaints a working rep's territory for no reason.
  "#2563EB", // blue
  "#F97316", // orange
  "#16A34A", // green
  "#DB2777", // magenta
  "#06B6D4", // cyan
  "#EAB308", // amber-yellow
  "#8B5CF6", // violet
  "#EF4444", // red
  "#14B8A6", // teal
  "#EC4899", // pink
  "#84CC16", // lime
  "#A855F7", // purple
  // Deep band — reps 12-23. Same hue family as the sibling twelve above, dropped
  // in luminance so the pair never reads as the same dot on a phone in sunlight.
  "#1E3A8A", // navy
  "#9A3412", // burnt sienna
  "#065F46", // forest
  "#831843", // wine
  "#0E7490", // deep cyan
  "#854D0E", // bronze
  "#4C1D95", // indigo
  "#991B1B", // brick
  "#0F766E", // pine
  "#9D174D", // deep rose
  "#3F6212", // olive
  "#6B21A8", // deep violet
];

export function colorForRep(repId: number | null | undefined): string {
  if (!repId) return "#94a3b8"; // unassigned → slate
  const n = REP_PALETTE.length;
  return REP_PALETTE[((repId % n) + n) % n];
}
