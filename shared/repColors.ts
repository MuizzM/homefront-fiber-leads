// Deterministic per-rep territory colors — the ONE source of truth shared by the
// server (persists territory.color) and the map (renders regions/labels), so a
// rep's color is identical everywhere with no DB column and no migration.
// 12 high-chroma, colorblind-aware hues chosen to stay legible over satellite.
export const REP_PALETTE = [
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
];

export function colorForRep(repId: number | null | undefined): string {
  if (!repId) return "#94a3b8"; // unassigned → slate
  const n = REP_PALETTE.length;
  return REP_PALETTE[((repId % n) + n) % n];
}
