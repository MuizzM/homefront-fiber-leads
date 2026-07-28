// ── Area labels on the map ────────────────────────────────────────────────────
// What a manager needs to read off an area without tapping it: whose it is, how
// long they've had it, and how far through they are.
//
// Kept DB-free and map-free so the wording and the truncation rules can be
// tested directly. MapView only decides the detail level from zoom and hands the
// rest over.

export type LabelDetail = "full" | "compact" | "name";

export interface TerritoryLabelInput {
  areaName?: string | null;
  repName?: string | null;
  /** ISO timestamp the area was handed to its current rep. */
  assignedAt?: string | null;
  knocked?: number | null;
  total?: number | null;
  status?: string | null;
  /** "Now", injected so tests aren't clock-dependent. */
  now?: string;
}

/** Areas nobody currently holds. */
function isPool(status?: string | null): boolean {
  return status === "unassigned" || status === "reclaimed";
}

/**
 * Percent of doors worked, floored.
 *
 * Floored rather than rounded on purpose: rounding shows "100%" at 99.6%, and a
 * rep who sees 100% stops walking. An area is only 100% when every door is done.
 */
export function knockedPct(knocked?: number | null, total?: number | null): number | null {
  const k = Number(knocked ?? 0);
  const t = Number(total ?? 0);
  if (!Number.isFinite(t) || t <= 0) return null;
  const pct = Math.floor((Math.max(0, Math.min(k, t)) / t) * 100);
  return Number.isFinite(pct) ? pct : null;
}

/**
 * "Mar 4" for this year, "Mar 4 '25" otherwise — a bare "Mar 4" on a two-year-old
 * assignment reads as recent, which is exactly the case a manager needs to spot.
 */
export function shortDate(iso?: string | null, now?: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const ref = now ? new Date(now) : new Date();
  const month = d.toLocaleDateString("en-US", { month: "short" });
  const base = `${month} ${d.getDate()}`;
  return d.getFullYear() === ref.getFullYear()
    ? base
    : `${base} '${String(d.getFullYear()).slice(2)}`;
}

/** First name only — map labels are tight, and the surname adds no clarity here. */
export function shortRep(name?: string | null): string {
  return (name ?? "").trim().split(/\s+/)[0] ?? "";
}

/**
 * Build the label.
 *
 *   full     Area name / Rep · Mar 4 / 40% knocked
 *   compact  Area name / Rep 40%
 *   name     Area name
 *
 * Detail drops as areas get small on screen: three lines over a block-sized
 * polygon is unreadable and collides with its neighbours, and an unreadable
 * label is worse than a short one.
 */
export function territoryLabel(input: TerritoryLabelInput, detail: LabelDetail = "full"): string {
  const areaName = (input.areaName ?? "").trim();
  if (detail === "name") return areaName;

  if (isPool(input.status)) {
    // Nobody holds it. Say so plainly — a stale rep name on a pooled area is how
    // an area quietly goes unworked for a month.
    return [areaName, "Unassigned"].filter(Boolean).join("\n");
  }

  const rep = shortRep(input.repName);
  const pct = knockedPct(input.knocked, input.total);

  if (input.status === "completed") {
    return [areaName, rep ? `Done — ${rep}` : "Done"].filter(Boolean).join("\n");
  }

  if (detail === "compact") {
    const line = [rep, pct != null ? `${pct}%` : ""].filter(Boolean).join("  ");
    return [areaName, line].filter(Boolean).join("\n");
  }

  const when = shortDate(input.assignedAt, input.now);
  const ownerLine = [rep, when].filter(Boolean).join(" · ");
  const progressLine = pct != null ? `${pct}% knocked` : "";
  return [areaName, ownerLine, progressLine].filter(Boolean).join("\n");
}

/**
 * Detail level from zoom. Below ~12 the whole county is on screen and only the
 * name survives; by ~14 a neighbourhood fills enough pixels for the full stack.
 */
export function detailForZoom(zoom: number): LabelDetail {
  if (!Number.isFinite(zoom) || zoom < 12) return "name";
  if (zoom < 14) return "compact";
  return "full";
}
