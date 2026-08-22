// ── Appointment reminder selection ───────────────────────────────────────────
// PURE and framework-free: which timed callbacks are due a "30 minutes before"
// reminder at a given instant. Callback dates and times are org-local
// wall-clock strings, so the org timezone converts them to instants here.
// The server job (server/callbackReminders.ts) feeds it rows and sends pushes;
// tests feed it rows and a clock.
import { localWallToUtcMs } from "./workweek";

export const REMINDER_LEAD_MINUTES = 30;
export const REMINDER_WINDOW_MINUTES = 10;

export interface ReminderCandidate {
  tenantId: number;
  leadId: number;
  repId: number;
  address: string;
  callbackDate: string;        // YYYY-MM-DD, org-local
  callbackTime: string | null; // HH:MM, org-local; untimed callbacks never remind
}

export function reminderKey(c: Pick<ReminderCandidate, "leadId" | "callbackDate" | "callbackTime">): string {
  return `appt-${c.leadId}-${c.callbackDate}-${c.callbackTime ?? ""}`;
}

/** UTC instant of the appointment, or null when the row carries no usable time. */
export function appointmentUtcMs(c: Pick<ReminderCandidate, "callbackDate" | "callbackTime">, timeZone: string): number | null {
  if (!c.callbackTime) return null;
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(c.callbackDate);
  const tm = /^(\d{1,2}):(\d{2})/.exec(c.callbackTime);
  if (!dm || !tm) return null;
  const ms = localWallToUtcMs(Number(dm[1]), Number(dm[2]), Number(dm[3]), Number(tm[1]), Number(tm[2]), timeZone);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * PURE selection: the candidates whose appointment starts between
 * (lead - window) and lead minutes from `nowMs`, skipping keys already sent.
 */
export function selectDueReminders(
  candidates: ReminderCandidate[],
  nowMs: number,
  timeZoneOf: (tenantId: number) => string,
  sent: ReadonlySet<string> = new Set(),
  opts: { leadMinutes?: number; windowMinutes?: number } = {},
): Array<ReminderCandidate & { minutesAway: number }> {
  const lead = (opts.leadMinutes ?? REMINDER_LEAD_MINUTES) * 60_000;
  const window = (opts.windowMinutes ?? REMINDER_WINDOW_MINUTES) * 60_000;
  const out: Array<ReminderCandidate & { minutesAway: number }> = [];
  for (const c of candidates) {
    const at = appointmentUtcMs(c, timeZoneOf(c.tenantId));
    if (at == null) continue;
    const until = at - nowMs;
    if (until > lead || until <= lead - window) continue;
    if (sent.has(reminderKey(c))) continue;
    out.push({ ...c, minutesAway: Math.max(1, Math.round(until / 60_000)) });
  }
  return out;
}

