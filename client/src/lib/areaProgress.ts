// ── Area Console shared vocabulary ────────────────────────────────────────────
// The Areas index and the Area detail screen read the SAME row off
// GET /api/territories/progress (list) and GET /api/territories/:id/progress
// (one area) — the server computes both from territoryProgressRow, so the shape
// is identical and there is exactly one type for it here.
//
// It extends the TerritoryProgress the map panel already uses rather than
// declaring a rival copy: that type was written when the panel only consumed
// half the row, so the operational figures are optional there. Widening it in
// one place keeps the map panel's contract untouched (no production screen
// changes behaviour) while giving these two screens the full row they render.
//
// NOTHING here recomputes a rate. Every percentage on the wire already divides
// by availableBase (total − unavailable − disqualified) per shared/
// territoryMetrics.ts; re-deriving one client-side is how two screens end up
// disagreeing about the same area.

import type { TerritoryProgress } from "@/components/TerritoryDetailPanel";

/** One row of GET /api/territories/progress (server/routes.ts territoryProgressRow). */
export interface AreaProgressRow extends TerritoryProgress {
  id: number;
  name: string;
  color: string | null;
  repId: number | null;
  /** territories.status — "active" | "unassigned" | "shared" | … (see shared/territory.ts). */
  status: string;
  /** Primary holder's display name, or "Unassigned" when nobody holds it. */
  repName: string;
  /** The WHOLE crew, primary first — an area is many-to-many. Optional because
   *  a cached response from before these fields existed is still a valid row;
   *  `areaHolders()` below is the one place that falls back. */
  repIds?: number[];
  repNames?: string[];
  knocked: number;
  sold: number;
  availableBase: number;
  untouched: number;
  attempts: number;
  contacted: number;
  notHome: number;
  followUp: number;
  unavailable: number;
  disqualified: number;
  penetrationRate: number;
  knockCompletionRate: number;
  contactRate: number;
  lastActivityAt: string | null;
  pct: number;
  maxObservedDistanceM: number | null;
  maxAllowedAccuracyM: number;
}

/** Closed passes for one area — GET /api/territories/:id/passes. */
export interface AreaPassesResponse {
  currentPass: number;
  passes: Array<{
    id: number;
    passNumber: number;
    closedAt: string;
    closedByName: string | null;
    territoryAction: string;
    leadsTotal: number;
    leadsReset: number;
    leadsFrozen: number;
    note: string | null;
    stats: {
      knocks: number; doorsAnswered: number; sold: number;
      interested: number; notInterested: number; notHome: number; callbacks: number;
    } | null;
  }>;
}

/** The single-area read (GET /api/territories/:id/progress) carries extras the
 *  list route deliberately omits: the boundary itself, the scan briefing that
 *  explains WHY this ground was cut, and the lifecycle stamps. All optional —
 *  a cached list row is still a valid AreaProgressRow. */
export interface AreaDetailRow extends AreaProgressRow {
  /** [lng,lat][] open ring — the area's stored boundary. */
  polygon?: [number, number][];
  /** Server-authored deploy briefing ("why this area"), when scan-created.
   *  Shape is buildDeployBriefing (server/routes.ts). */
  briefing?: {
    doors: number;
    unworked: number;
    avgScore: number;
    topCompetitor: { name: string; count: number } | null;
    competitorShare: number;
    newFiber: number;
    generatedAt: string;
  } | null;
  completionNotes?: string | null;
  currentPass?: number;
  assignedAt?: string | null;
  completedAt?: string | null;
  createdAt?: string | null;
}

/** One tenure row — GET /api/territories/:id/assignments (the roster ledger). */
export interface AreaAssignmentRow {
  id: number;
  repId: number;
  repName: string | null;
  roleInTerritory: string;
  assignedAt: string;
  assignedByName: string | null;
  unassignedAt: string | null;
  unassignedByName: string | null;
  reason: string | null;
}

/** One immutable territory_events row — GET /api/territories/:id/history.
 *  Field names match storage.getTerritoryEvents EXACTLY ({type, actorUserId,
 *  at}). This type used to describe a row the server never sent ({event,
 *  actorId, createdAt}), so the event log crashed on `ev.event.replace(...)`
 *  the moment an area had any history — which is every area that was ever
 *  created through the API, since creation itself writes an event. */
export interface AreaHistoryEvent {
  id: number;
  territoryId: number;
  actorUserId: number | null;
  type: string;
  payload?: unknown;
  at: string;
}

export interface AreaStatusMeta {
  /** What a human calls this state. "active" is jargon; the ground is ASSIGNED. */
  label: string;
  /** Chip tint — semantic, never decorative. */
  chip: string;
  /** Hero card surface + border for the same state. */
  hero: string;
  /** One line saying what the state MEANS, so the hero card explains itself. */
  blurb: string;
}

// Tints are the house semantics: emerald = someone is walking it, slate = nobody
// is, sky = finished, amber = pulled back and waiting for a decision. The
// `-600 dark:-400` pairing is the app's existing rule for tinted text so both
// themes stay legible (a bare -400 washes out on the light surface).
const ASSIGNED: AreaStatusMeta = {
  label: "Assigned",
  chip: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  hero: "border-emerald-500/30 from-emerald-500/10 to-transparent",
  blurb: "A rep holds this area and their doors are live in the field app.",
};

const AREA_STATUS_META: Record<string, AreaStatusMeta> = {
  active: ASSIGNED,
  assigned: ASSIGNED,
  shared: {
    label: "Shared",
    chip: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
    hero: "border-blue-500/30 from-blue-500/10 to-transparent",
    blurb: "More than one rep works this ground; every holder sees its doors.",
  },
  completed: {
    label: "Completed",
    chip: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
    hero: "border-sky-500/30 from-sky-500/10 to-transparent",
    blurb: "Marked done. Start another pass to put it back in rotation.",
  },
  reclaimed: {
    label: "Reclaimed",
    chip: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
    hero: "border-amber-500/30 from-amber-500/10 to-transparent",
    blurb: "Pulled back from its last rep and waiting to be handed out again.",
  },
  unassigned: {
    label: "Unassigned",
    chip: "bg-slate-500/15 text-slate-600 dark:text-slate-300",
    hero: "border-border from-muted/40 to-transparent",
    blurb: "Nobody holds this area - it sits in the pool until you assign it.",
  },
  archived: {
    label: "Archived",
    chip: "bg-slate-500/15 text-slate-600 dark:text-slate-400",
    hero: "border-border from-muted/40 to-transparent",
    blurb: "Retired from rotation. Its history is kept, but nobody knocks it.",
  },
  draft: {
    label: "Draft",
    chip: "bg-slate-500/15 text-slate-600 dark:text-slate-400",
    hero: "border-border from-muted/40 to-transparent",
    blurb: "Drawn but not yet in play.",
  },
};

/** Never returns undefined: an unknown status renders as itself, not a blank chip. */
export function areaStatusMeta(status: string | null | undefined): AreaStatusMeta {
  const key = String(status ?? "").toLowerCase();
  return AREA_STATUS_META[key] ?? {
    label: key ? key.replace(/_/g, " ") : "Unknown",
    chip: "bg-secondary text-muted-foreground",
    hero: "border-border from-muted/40 to-transparent",
    blurb: "This area's state isn't one the console knows about.",
  };
}

/** Statuses the index filter offers, in the order a manager triages them. */
export const AREA_STATUS_FILTERS = ["active", "shared", "unassigned", "reclaimed", "completed", "archived"] as const;

/** Nobody currently holds it. Mirrors shared/territoryLabel's pool rule. */
export function isPoolArea(row: Pick<AreaProgressRow, "status" | "repId">): boolean {
  return row.status === "unassigned" || row.status === "reclaimed" || row.repId == null;
}

export interface AreaHolder { id: number; name: string }

/**
 * Who works this area, primary first — the ONE way the Area Console answers
 * that, so the index card, the detail header and the remove control can never
 * disagree about who is on it.
 *
 * A pool area has no holders, full stop: `repId` deliberately still names the
 * LAST rep after a reclaim (it drives colour and history), and reading it as a
 * holder is how a reclaimed area gets handed straight back to the person it was
 * taken from. Falls back to the primary pair only for a row served before
 * repIds/repNames existed.
 */
export function areaHolders(row: AreaProgressRow): AreaHolder[] {
  if (isPoolArea(row)) return [];
  const ids = row.repIds;
  if (ids?.length) {
    const names = row.repNames ?? [];
    return ids.map((id, i) => ({ id, name: names[i] ?? `Rep #${id}` }));
  }
  return row.repId != null ? [{ id: row.repId, name: row.repName }] : [];
}

/** Initials for the owner avatar — two letters at most, "?" for a blank name. */
export function initialsOf(name: string | null | undefined): string {
  const parts = String(name ?? "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

/** True when a failed query is the server's out-of-scope 404 (never a 403 — the
 *  API deliberately refuses to confirm an area outside your scope exists). */
export function isNotFoundError(error: unknown): boolean {
  const e = error as { status?: number; message?: string } | null;
  if (!e) return false;
  if (e.status === 404) return true;
  return typeof e.message === "string" && /^404\b/.test(e.message);
}
