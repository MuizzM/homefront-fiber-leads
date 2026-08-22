// The reminder tick end to end against the real store: a timed callback 25
// minutes out (org timezone) is due exactly once; an untimed one never is.
// Push delivery itself is not exercised (no VAPID keys in test), so the tick
// reports `due`, and `sent` stays 0.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { localYmdParts } from "../../shared/workweek";

let storage: any;
let tick: (nowMs?: number) => Promise<{ due: number; sent: number }>;
let tzOf: (tenantId: number) => string;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-remind-"));
  process.env.NODE_ENV = "test";
  const mod = await import("../../server/storage");
  mod.runMigrations(); storage = mod.storage; tzOf = mod.orgTimezoneFor;
  ({ tickCallbackReminders: tick } = await import("../../server/callbackReminders"));
});

let seq = 0;
function rep(name: string) {
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}@remind.test`;
  const m = storage.createTeamMember({ name, email, role: "rep", active: true, tenantId: 1 } as any);
  storage.createUser({ name, email, role: "rep", active: true, tenantId: 1, teamMemberId: m.id } as any);
  return m.id;
}
function lead() {
  return storage.createLead({
    address: `${++seq} Reminder Way`, city: "Salisbury", state: "NC", zip: "28146",
    lat: 35.67, lng: -80.47, tenantId: 1, leadStatus: "prospect",
  } as any).id;
}
// A callback scheduled `minutes` from `nowMs`, expressed as the org-local date and HH:MM.
function scheduleAt(leadId: number, repId: number, nowMs: number, minutes: number, timed = true) {
  const tz = tzOf(1);
  const at = nowMs + minutes * 60_000;
  const { y, mo, d } = localYmdParts(at, tz);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(at));
  const hh = parts.find(p => p.type === "hour")!.value, mm = parts.find(p => p.type === "minute")!.value;
  const knockedAt = new Date(nowMs - 60_000).toISOString();
  storage.createKnock({
    leadId, repId, outcome: "follow_up", wasHome: true, knockedAt,
    callbackDate: `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
    callbackTime: timed ? `${hh}:${mm}` : null,
  } as any);
  storage.applyKnockOutcomeCas(leadId, "follow_up", "follow_up", knockedAt);
}

describe("tickCallbackReminders", () => {
  it("finds the timed visit 25 minutes out, once, and ignores the untimed one", async () => {
    // Anchor the clock at a whole minute so HH:MM round-trips exactly.
    const now = Math.floor(Date.now() / 60_000) * 60_000;
    const repId = rep("Rita Remind");
    scheduleAt(lead(), repId, now, 25);
    scheduleAt(lead(), repId, now, 25, false);
    scheduleAt(lead(), repId, now, 90);
    const first = await tick(now);
    expect(first.due).toBe(1);
    expect(first.sent).toBe(0);
    // Same tick again: already sent this process, nothing new.
    const again = await tick(now + 60_000);
    expect(again.due).toBe(0);
  });
});
