/**
 * Pure input-validation policy for SEC-B hardening — no Express/DB imports so
 * the rules are unit-testable without booting the server. routes.ts wires
 * these into the scan/rescan-pool, activity-log, territory-requests, and
 * leads-PATCH handlers.
 */

// ── POST /api/scan/rescan-pool ──────────────────────────────────────────────
// One call re-qualifies stored pool addresses against the metered provider.
// The old ceiling (100k) let one request enqueue a fleet-scale spend and
// build a six-figure array synchronously on the event loop. 10k per call is a
// full city's pool; anything larger is several deliberate calls.
export const RESCAN_POOL_MAX_TARGETS = 10_000;
export const RESCAN_POOL_CHUNK_SIZE = 5_000;

export type RescanPoolPlan =
  | { ok: true; limit: number }
  | { ok: false; status: 400; error: string; code: "RESCAN_POOL_CAP"; max: number };

export function rescanPoolPlan(requested: unknown, max: number = RESCAN_POOL_MAX_TARGETS): RescanPoolPlan {
  // No explicit limit → the new cap, not the old 50k default.
  const n = requested == null || requested === "" ? max : Number(requested);
  if (!Number.isFinite(n) || n < 1) return { ok: true, limit: max };
  if (n > max) {
    return {
      ok: false,
      status: 400,
      error: `Pool re-scan is capped at ${max.toLocaleString()} targets per call. Split larger re-scans into multiple runs.`,
      code: "RESCAN_POOL_CAP",
      max,
    };
  }
  return { ok: true, limit: Math.floor(n) };
}

/**
 * Build the filtered scan list in setImmediate-sized chunks so a 10k-address
 * pool re-scan never wedges the event loop between ticks.
 */
export async function filterInChunks<T, R>(
  items: T[],
  chunkSize: number,
  fn: (item: T) => R | null,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    const end = Math.min(items.length, i + chunkSize);
    for (let j = i; j < end; j++) {
      const v = fn(items[j]);
      if (v !== null) out.push(v);
    }
    if (end < items.length) await new Promise((resolve) => setImmediate(resolve));
  }
  return out;
}

// ── GET /api/activity-log ───────────────────────────────────────────────────
// Match the sibling audit endpoint (/api/auth/login-attempts): clamp into a
// bounded range with a sane fallback instead of trusting the query string —
// ?limit=-5 or ?limit=99999999 used to flow straight into the storage read.
export const ACTIVITY_LOG_MAX_LIMIT = 500;
export function clampActivityLogLimit(raw: unknown, fallback = 100, max = ACTIVITY_LOG_MAX_LIMIT): number {
  const n = Number(raw ?? fallback);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(max, Math.max(1, Math.floor(n)));
}

// ── POST /api/territory-requests ────────────────────────────────────────────
// The message is interpolated into an admin-notification HTML email. Bound its
// length so a rep can't stuff an unbounded payload into a mailbox.
export const TERRITORY_MESSAGE_MAX = 2_000;
export type TerritoryMessageCheck =
  | { ok: true; message: string | null }
  | { ok: false; status: 400; error: string };

export function validateTerritoryRequestMessage(raw: unknown): TerritoryMessageCheck {
  if (raw == null || raw === "") return { ok: true, message: null };
  if (typeof raw !== "string") return { ok: false, status: 400, error: "message must be a string" };
  const trimmed = raw.trim();
  if (trimmed.length > TERRITORY_MESSAGE_MAX) {
    return { ok: false, status: 400, error: `Message is too long (max ${TERRITORY_MESSAGE_MAX} characters).` };
  }
  return { ok: true, message: trimmed || null };
}

// ── PATCH /api/leads/:id ────────────────────────────────────────────────────
// Canonical lead_status values (shared/knock.ts LeadStatus). Mirrored here as
// a runtime list because the type is compile-time only; keep in sync.
export const LEAD_STATUS_ALLOWLIST: readonly string[] = [
  "prospect", "contacted", "interested", "sold", "not_interested", "follow_up",
];

export const LEAD_NOTES_MAX = 4_000;

export type LeadPatchCheck =
  | { ok: true }
  | { ok: false; status: 400; error: string; code: string };

/**
 * Validate the value SHAPES that the allowlisted leads-PATCH fields carry.
 * Field allowlisting alone stops mass-assignment of internal columns, but a
 * manager session (or a script holding one) could still write nonsense into
 * the allowed columns — an unknown leadStatus breaks every status lens, and a
 * fractional/negative assignedRepId corrupts assignment joins.
 */
export function validateLeadPatch(body: Record<string, unknown>): LeadPatchCheck {
  if (Object.prototype.hasOwnProperty.call(body, "leadStatus")) {
    const v = body.leadStatus;
    if (typeof v !== "string" || !LEAD_STATUS_ALLOWLIST.includes(v)) {
      return { ok: false, status: 400, error: `leadStatus must be one of: ${LEAD_STATUS_ALLOWLIST.join(", ")}`, code: "INVALID_LEAD_STATUS" };
    }
  }
  if (Object.prototype.hasOwnProperty.call(body, "assignedRepId")) {
    const v = body.assignedRepId;
    const ok = v === null || (typeof v === "number" && Number.isInteger(v) && v > 0);
    if (!ok) {
      return { ok: false, status: 400, error: "assignedRepId must be a positive integer or null", code: "INVALID_ASSIGNED_REP" };
    }
  }
  if (Object.prototype.hasOwnProperty.call(body, "notes")) {
    const v = body.notes;
    if (v !== null && (typeof v !== "string" || v.length > LEAD_NOTES_MAX)) {
      return { ok: false, status: 400, error: `notes must be a string of at most ${LEAD_NOTES_MAX} characters`, code: "INVALID_NOTES" };
    }
  }
  return { ok: true };
}
