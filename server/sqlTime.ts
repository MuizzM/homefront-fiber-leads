// ── Comparing timestamps in SQLite when the columns disagree on format ──────
//
// This codebase stores timestamps two different ways:
//
//   `leads.created_at`          ISO-8601 from JS  →  "2026-08-04T13:28:23.283Z"
//   `scan_targets.created_at`   SQLite default    →  "2026-08-04 13:28:23"
//   `fiber_transitions`, `commissions`, …         →  SQLite default
//
// Both are TEXT and SQLite compares TEXT lexicographically, so the separator
// decides the result: 'T' is 0x54 and ' ' is 0x20, therefore ANY ISO string
// sorts after ANY SQLite-format string that shares its date.
//
// That makes `leads.created_at >= datetime('now','-7 days')` wrong. Not subtly
// wrong on ties — wrong for the whole boundary day:
//
//   threshold  datetime('now','-7 days')  =  "2026-07-28 13:28:39"
//   row        created 00:30 that morning =  "2026-07-28T00:30:00.000Z"
//
// The row is chronologically 7½ days old and belongs OUTSIDE a 7-day window,
// but 'T' > ' ' puts it inside. Every "fresh lead" window silently ran up to
// 24 hours wide at its edge.
//
// julianday() on both sides would also be correct, but it is a function call on
// the COLUMN — that discards the index and forces a scan. Formatting the
// THRESHOLD as ISO instead keeps the comparison a constant-vs-column test, so
// the index still applies and the result is right.
//
// Use these for ISO columns (leads). Columns written by SQLite's own default
// must keep using datetime() — mixing the two is what caused this.

/** ISO-formatted "N days ago", for comparison against ISO TEXT columns.
 *
 *  Emits the same shape as JS `toISOString()` — `%f` is `SS.SSS`, so the
 *  fractional seconds and the trailing Z line up and lexicographic order
 *  matches chronological order. */
export function isoDaysAgo(days: number): string {
  return `strftime('%Y-%m-%dT%H:%M:%fZ','now','-${intOrThrow(days)} days')`;
}

/** ISO-formatted "N hours ago". Same contract as isoDaysAgo. */
export function isoHoursAgo(hours: number): string {
  return `strftime('%Y-%m-%dT%H:%M:%fZ','now','-${intOrThrow(hours)} hours')`;
}

/** These build SQL by interpolation, so the value must be provably a plain
 *  integer. Every current caller passes a module constant, but a tuning knob
 *  that becomes request-driven later must not be able to carry SQL with it. */
function intOrThrow(n: number): number {
  if (!Number.isInteger(n) || n < 0 || n > 100_000) {
    throw new Error(`sqlTime: expected a non-negative integer offset, got ${String(n)}`);
  }
  return n;
}
