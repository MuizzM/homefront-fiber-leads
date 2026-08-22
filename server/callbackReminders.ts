// ── Appointment reminders ─────────────────────────────────────────────────────
// A timed callback ("Sat 2 PM at 1842 Oak Ridge Dr") is a promise to a
// homeowner. This job pushes the owning rep a reminder 30 minutes before it,
// through the same web-push plumbing team sales and streaks already use.
//
// Shape, deliberately boring: a cheap 5-minute tick asks the DATABASE what is
// due (the db-prune pattern), so restarts and event-loop stalls cannot lose a
// reminder, only delay it to the next tick. A reminder is due once the
// appointment is between 20 and 30 minutes away in the ORG's timezone
// (callback dates and times are local wall-clock strings, never UTC). An
// in-memory set stops a tick from repeating itself; across a restart the push
// `tag` collapses a repeat on the device, so the worst case is one replaced
// notification, never a stack of them.
//
// Tenant scoping: one tenant-scoped read per tenant, and pushToUsers only ever
// reaches subscriptions stored under that tenant.
import { rawDb } from "./db";
import { storage, orgTimezoneFor } from "./storage";
import { pushToUsers } from "./pushStore";
import { selectDueReminders, reminderKey, REMINDER_LEAD_MINUTES, type ReminderCandidate } from "../shared/reminders";
import { structuredLog } from "./structuredLog";

export const REMINDER_TICK_MS = 5 * 60_000;

function fmtLocalTime(hhmm: string | null): string {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm ?? "");
  if (!m) return "";
  const h = Number(m[1]), mi = m[2];
  const ap = h >= 12 ? "PM" : "AM";
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr}:${mi} ${ap}`;
}

function userIdsForRep(repId: number): number[] {
  try {
    return (rawDb.prepare(`SELECT id FROM users WHERE team_member_id = ? AND active = 1`).all(repId) as any[])
      .map(r => Number(r.id)).filter(n => Number.isFinite(n));
  } catch { return []; }
}

// Keys pushed by this process. Bounded: entries older than a day are dropped
// on every tick so the set cannot grow for the life of the process.
const sentKeys = new Map<string, number>();

export async function tickCallbackReminders(nowMs = Date.now()): Promise<{ due: number; sent: number }> {
  for (const [k, at] of sentKeys) if (nowMs - at > 24 * 3_600_000) sentKeys.delete(k);
  const candidates: ReminderCandidate[] = [];
  for (const tenant of storage.getTenants()) {
    if ((tenant as any).status && (tenant as any).status !== "active") continue;
    for (const cb of storage.getOpenCallbacks(tenant.id)) {
      if (!cb.callbackTime || cb.repId == null) continue;
      candidates.push({
        tenantId: tenant.id, leadId: cb.leadId, repId: cb.repId, address: cb.address,
        callbackDate: cb.callbackDate, callbackTime: cb.callbackTime,
      });
    }
  }
  const due = selectDueReminders(candidates, nowMs, orgTimezoneFor, new Set(sentKeys.keys()));
  let sent = 0;
  for (const c of due) {
    const key = reminderKey(c);
    sentKeys.set(key, nowMs);
    const userIds = userIdsForRep(c.repId);
    if (!userIds.length) continue;
    try {
      const r = await pushToUsers(c.tenantId, userIds, {
        title: `Appointment in ${c.minutesAway} min`,
        body: `${c.address} at ${fmtLocalTime(c.callbackTime)}`,
        url: `/lead/${c.leadId}`,
        tag: key,
      });
      sent += r.sent;
    } catch (e: any) {
      structuredLog("callback_reminder.failed", { leadId: c.leadId, error: String(e?.message ?? e).slice(0, 200) }, "error");
    }
  }
  if (due.length) structuredLog("callback_reminder.tick", { due: due.length, sent });
  return { due: due.length, sent };
}

/** Wire the tick. Returns the interval so a caller can stop it. */
export function startCallbackReminders(shouldRun: () => boolean = () => true): NodeJS.Timeout {
  const tick = () => {
    if (!shouldRun()) return;
    void tickCallbackReminders().catch(e => {
      structuredLog("callback_reminder.failed", { error: String(e?.message ?? e).slice(0, 200) }, "error");
    });
  };
  setTimeout(tick, 60_000).unref?.();
  const interval = setInterval(tick, REMINDER_TICK_MS);
  if (typeof (interval as any).unref === "function") interval.unref();
  structuredLog("callback_reminder.scheduled", { leadMinutes: REMINDER_LEAD_MINUTES, tickEveryMin: REMINDER_TICK_MS / 60_000 });
  return interval;
}
