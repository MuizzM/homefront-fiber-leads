// Appointment reminders (shared/reminders.ts): a timed callback is due a push
// once it is 20 to 30 minutes away in the ORG's timezone, once per key.
import { describe, expect, it } from "vitest";
import { appointmentUtcMs, reminderKey, selectDueReminders, type ReminderCandidate } from "../../shared/reminders";

const TZ = "America/New_York";
const tzOf = () => TZ;
const cand = (over: Partial<ReminderCandidate> = {}): ReminderCandidate => ({
  tenantId: 1, leadId: 42, repId: 7, address: "1842 Oak Ridge Dr",
  callbackDate: "2026-08-21", callbackTime: "14:00", ...over,
});

describe("appointmentUtcMs", () => {
  it("reads the local wall clock in the org timezone (EDT is UTC-4 in August)", () => {
    expect(appointmentUtcMs(cand(), TZ)).toBe(Date.UTC(2026, 7, 21, 18, 0));
    // Winter: EST is UTC-5.
    expect(appointmentUtcMs(cand({ callbackDate: "2026-01-15", callbackTime: "09:30" }), TZ)).toBe(Date.UTC(2026, 0, 15, 14, 30));
  });
  it("returns null for untimed or malformed callbacks", () => {
    expect(appointmentUtcMs(cand({ callbackTime: null }), TZ)).toBeNull();
    expect(appointmentUtcMs(cand({ callbackTime: "soon" }), TZ)).toBeNull();
    expect(appointmentUtcMs(cand({ callbackDate: "tomorrow" }), TZ)).toBeNull();
  });
});

describe("selectDueReminders", () => {
  const appt = Date.UTC(2026, 7, 21, 18, 0); // 2 PM EDT
  const min = 60_000;

  it("is due between 30 and 20 minutes before, and nowhere else", () => {
    const c = cand();
    expect(selectDueReminders([c], appt - 31 * min, tzOf)).toHaveLength(0);
    expect(selectDueReminders([c], appt - 30 * min, tzOf)).toHaveLength(1);
    expect(selectDueReminders([c], appt - 25 * min, tzOf)).toHaveLength(1);
    expect(selectDueReminders([c], appt - 20 * min, tzOf)).toHaveLength(0);
    expect(selectDueReminders([c], appt - 5 * min, tzOf)).toHaveLength(0);
    expect(selectDueReminders([c], appt + 5 * min, tzOf)).toHaveLength(0);
  });

  it("reports how many minutes away the visit is", () => {
    expect(selectDueReminders([cand()], appt - 28 * min, tzOf)[0].minutesAway).toBe(28);
  });

  it("never reminds an untimed callback, and never repeats a sent key", () => {
    const timed = cand(), untimed = cand({ leadId: 43, callbackTime: null });
    const now = appt - 25 * min;
    expect(selectDueReminders([timed, untimed], now, tzOf).map(c => c.leadId)).toEqual([42]);
    expect(selectDueReminders([timed], now, tzOf, new Set([reminderKey(timed)]))).toHaveLength(0);
  });

  it("uses each tenant's own timezone", () => {
    const east = cand({ tenantId: 1 });
    const west = cand({ tenantId: 2 });
    const zones: Record<number, string> = { 1: "America/New_York", 2: "America/Los_Angeles" };
    // 1:35 PM EDT: the eastern 2 PM visit is 25 min away; the western 2 PM is hours off.
    const due = selectDueReminders([east, west], appt - 25 * min, (t) => zones[t]);
    expect(due.map(c => c.tenantId)).toEqual([1]);
  });

  it("keys a reminder by door, date and time so a rescheduled visit reminds again", () => {
    expect(reminderKey(cand())).toBe("appt-42-2026-08-21-14:00");
    expect(reminderKey(cand({ callbackTime: "16:00" }))).not.toBe(reminderKey(cand()));
  });
});
