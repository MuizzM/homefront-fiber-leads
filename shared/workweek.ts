// ── Commission workweek — PURE, timezone-aware, DST-correct ───────────────────
// The commission week is a FIXED calendar week in the organization's IANA
// timezone (default Monday 00:00 → the following Monday 00:00), NOT a rolling
// 7×24h UTC window. Boundaries are half-open: [weekStartUtc, nextWeekStartUtc).
//
//   A sale at Sunday 23:59 local  → belongs to the CLOSING week.
//   A sale at Monday 00:00 local  → belongs to the NEW week.
//
// We never subtract a fixed number of UTC hours (that breaks across DST). We
// resolve local wall-clock ↔ UTC with Intl.DateTimeFormat, which carries the
// zone's offset rules including daylight-saving transitions. Pure + framework-
// free so the whole thing is unit-tested without a DB or a clock.

export interface WorkweekConfig {
  timezone: string;          // IANA, e.g. "America/New_York"
  weekStartsOn: number;      // 0=Sun … 1=Mon (default) … 6=Sat
  weekStartLocalTime: string; // "HH:MM" local, default "00:00"
}

export const DEFAULT_WORKWEEK: WorkweekConfig = {
  timezone: "America/New_York",
  weekStartsOn: 1,           // Monday
  weekStartLocalTime: "00:00",
};

export interface WeekBounds {
  weekStartUtc: string;      // ISO — inclusive start
  nextWeekStartUtc: string;  // ISO — EXCLUSIVE end (half-open)
  timezone: string;
  localWeekLabel: string;    // e.g. "Mar 3 – Mar 9, 2026"
}

// Offset (localWallMs − utcMs) for an instant in a zone, via Intl. DST-aware.
function tzOffsetMs(utcMs: number, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(new Date(utcMs))) if (part.type !== "literal") p[part.type] = part.value;
  let hour = Number(p.hour);
  if (hour === 24) hour = 0; // some engines emit "24" for midnight
  const asIfUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), hour, Number(p.minute), Number(p.second));
  return asIfUtc - utcMs;
}

// Convert a local wall-clock time in `timeZone` to the UTC epoch ms. Two-pass so
// a DST change between the naive guess and the real instant is corrected.
function zonedWallToUtcMs(y: number, mo: number, d: number, h: number, mi: number, timeZone: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0);
  const off1 = tzOffsetMs(guess, timeZone);
  let utc = guess - off1;
  const off2 = tzOffsetMs(utc, timeZone);
  if (off2 !== off1) utc = guess - off2; // landed in a different offset period → re-correct
  return utc;
}

// The calendar Y/M/D of an instant AS SEEN in the zone (date is offset-stable).
function localYmd(utcMs: number, timeZone: string): { y: number; mo: number; d: number } {
  const dtf = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(new Date(utcMs))) if (part.type !== "literal") p[part.type] = part.value;
  return { y: Number(p.year), mo: Number(p.month), d: Number(p.day) };
}

// Weekday of a calendar date (0=Sun..6=Sat) — timezone-independent for a date.
function calendarWeekday(y: number, mo: number, d: number): number {
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
}

// Shift a calendar date by N days (pure calendar arithmetic).
function addDays(y: number, mo: number, d: number, days: number): { y: number; mo: number; d: number } {
  const t = new Date(Date.UTC(y, mo - 1, d));
  t.setUTCDate(t.getUTCDate() + days);
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

function parseHm(hm: string): { h: number; mi: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec((hm || "").trim());
  return m ? { h: Number(m[1]), mi: Number(m[2]) } : { h: 0, mi: 0 };
}

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

/**
 * The commission-week bounds that CONTAIN `instantUtc`, in the org's timezone.
 * Returns a half-open [weekStartUtc, nextWeekStartUtc) interval — use it as:
 *   soldAt >= weekStartUtc AND soldAt < nextWeekStartUtc
 */
export function weekBoundsFor(instantUtc: Date | string | number, cfg: WorkweekConfig = DEFAULT_WORKWEEK): WeekBounds {
  const ms = instantUtc instanceof Date ? instantUtc.getTime() : typeof instantUtc === "number" ? instantUtc : Date.parse(instantUtc);
  const { h, mi } = parseHm(cfg.weekStartLocalTime);
  const startIdx = ((cfg.weekStartsOn % 7) + 7) % 7;

  // Local calendar day of the instant, then walk back to the week's start weekday.
  const { y, mo, d } = localYmd(ms, cfg.timezone);
  const wd = calendarWeekday(y, mo, d);
  let back = (wd - startIdx + 7) % 7;

  let startDate = addDays(y, mo, d, -back);
  let weekStartMs = zonedWallToUtcMs(startDate.y, startDate.mo, startDate.d, h, mi, cfg.timezone);
  // Edge: if the instant is BEFORE this week's start-of-day (e.g. weekStartLocalTime
  // is late and the instant is earlier that same weekday), it belongs to the prior week.
  if (ms < weekStartMs) {
    startDate = addDays(startDate.y, startDate.mo, startDate.d, -7);
    weekStartMs = zonedWallToUtcMs(startDate.y, startDate.mo, startDate.d, h, mi, cfg.timezone);
  }
  const nextDate = addDays(startDate.y, startDate.mo, startDate.d, 7);
  const nextWeekMs = zonedWallToUtcMs(nextDate.y, nextDate.mo, nextDate.d, h, mi, cfg.timezone);

  const endDate = addDays(startDate.y, startDate.mo, startDate.d, 6); // last local day (Sunday for Mon-start)
  const label = startDate.y === endDate.y
    ? `${MONTHS[startDate.mo - 1]} ${startDate.d} – ${MONTHS[endDate.mo - 1]} ${endDate.d}, ${endDate.y}`
    : `${MONTHS[startDate.mo - 1]} ${startDate.d}, ${startDate.y} – ${MONTHS[endDate.mo - 1]} ${endDate.d}, ${endDate.y}`;

  return {
    weekStartUtc: new Date(weekStartMs).toISOString(),
    nextWeekStartUtc: new Date(nextWeekMs).toISOString(),
    timezone: cfg.timezone,
    localWeekLabel: label,
  };
}

// True iff a sale instant falls in [weekStartUtc, nextWeekStartUtc). The single
// membership rule the DB query (soldAt >= start AND soldAt < next) mirrors.
export function isInWeek(instantUtc: Date | string | number, bounds: WeekBounds): boolean {
  const ms = instantUtc instanceof Date ? instantUtc.getTime() : typeof instantUtc === "number" ? instantUtc : Date.parse(instantUtc);
  return ms >= Date.parse(bounds.weekStartUtc) && ms < Date.parse(bounds.nextWeekStartUtc);
}
