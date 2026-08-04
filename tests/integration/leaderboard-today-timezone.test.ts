// ── The leaderboard's "today" must be the ORG's today ───────────────────────
//
// knocksToday / salesToday were computed from `new Date().setHours(0,0,0,0)`,
// which is midnight in the CONTAINER's timezone. Production containers run UTC
// and the org runs America/New_York, so "today" started at 20:00 ET the
// PREVIOUS evening. That is wrong in both directions, and the damage is not
// symmetric:
//
//   00:00–20:00 ET  over-counts — last night's 8pm-onward knocks are folded
//                   into today's number.
//   20:00–24:00 ET  under-counts catastrophically — UTC midnight rolls while
//                   the rep is still working, so the whole day's knocking
//                   drops off the board mid-shift. A rep who knocked 60 doors
//                   watches their count reset to zero at 8pm.
//
// The evening case is the one that matters: the leaderboard defaults to Today,
// and evening is exactly when door-to-door reps are working.
//
// Six other stores already resolve the org timezone the same way
// (earningsTodayStore, spiffCampaignStore, momentumSpiffStore, doorDropStore,
// teamFeedStore, knockMilestoneStore). The leaderboard was the one that did not.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

let storage: any;
let rawDb: any;
const T1 = 1;
let rep: any;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-lbtz-"));
  process.env.NODE_ENV = "test";
  const mod = await import("../../server/storage");
  mod.runMigrations();
  storage = mod.storage;
  rawDb = (await import("../../server/db")).rawDb;
  rep = storage.createTeamMember({ name: "Eve", email: "eve@lbtz.test", role: "rep", active: true, tenantId: T1 });
});

afterEach(() => { vi.useRealTimers(); });

let seq = 0;
function knockAt(iso: string, outcome = "not_home") {
  const l = storage.createLead({
    address: `${++seq} Timezone Ave`, city: "Rockwell", state: "NC", zip: "28138",
    lat: 35.5 + seq * 0.0001, lng: -80.4, fiberStatus: "fiber",
    leadStatus: outcome === "sold" ? "sold" : "prospect", tenantId: T1,
  });
  rawDb.prepare(
    `INSERT INTO knock_log (lead_id, rep_id, outcome, was_home, knocked_at, tenant_id, pass_number, superseded)
     VALUES (?,?,?,1,?,?,1,0)`,
  ).run(l.id, rep.id, outcome, iso, T1);
  return l;
}

function todayCounts(nowIso: string) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(nowIso));
  const row = storage.getLeaderboard(undefined, T1).find((r: any) => r.rep.id === rep.id);
  return { knocksToday: row?.knocksToday ?? 0, salesToday: row?.salesToday ?? 0 };
}

describe("leaderboard 'today' is the org's local day, not the container's", () => {
  it("keeps a full day of knocking on the board after 8pm Eastern", () => {
    // now = Mon 2026-07-13 21:00 EDT. UTC has already rolled to Tuesday, so a
    // container-midnight window starts at 20:00 EDT and sees almost nothing.
    knockAt("2026-07-13T14:00:00.000Z");   // 10:00 EDT — squarely inside the rep's day
    knockAt("2026-07-13T19:30:00.000Z");   // 15:30 EDT
    knockAt("2026-07-13T23:00:00.000Z");   // 19:00 EDT — still before UTC midnight

    const { knocksToday } = todayCounts("2026-07-14T01:00:00.000Z");
    // Under the bug this was 0: every knock predates 2026-07-14T00:00Z.
    expect(knocksToday).toBe(3);
  });

  it("does not fold last night's knocks into this morning's count", () => {
    // now = Mon 2026-07-20 10:00 EDT. Container midnight (2026-07-20T00:00Z) is
    // 20:00 EDT on SUNDAY, so a Sunday-evening knock leaks into Monday.
    knockAt("2026-07-20T02:00:00.000Z");   // Sun 22:00 EDT — yesterday to the rep
    knockAt("2026-07-20T15:00:00.000Z");   // Mon 11:00 EDT — genuinely today

    const { knocksToday } = todayCounts("2026-07-20T16:00:00.000Z");
    // Under the bug this was 2 — the Sunday-night knock counted as Monday.
    expect(knocksToday).toBe(1);
  });

  it("applies the same local day to salesToday", () => {
    knockAt("2026-07-27T13:00:00.000Z", "sold");   // Mon 09:00 EDT
    const { salesToday } = todayCounts("2026-07-28T02:00:00.000Z");  // Mon 22:00 EDT
    // Under the bug: 0 — the sale fell behind UTC midnight while the rep was
    // still in the field, so the board showed no sale for the day they sold.
    expect(salesToday).toBe(1);
  });

  it("honors a tenant that is NOT Eastern", () => {
    rawDb.prepare(`UPDATE tenants SET commission_timezone = 'America/Los_Angeles' WHERE id = ?`).run(T1);
    try {
      // now = Tue 2026-08-04 21:00 PDT = 2026-08-05T04:00Z. A Pacific org's day
      // rolls three hours later than an Eastern one; both are wrong under UTC.
      knockAt("2026-08-04T17:00:00.000Z");        // 10:00 PDT — today in LA
      const { knocksToday } = todayCounts("2026-08-05T04:00:00.000Z");
      expect(knocksToday).toBe(1);
    } finally {
      vi.useRealTimers();
      rawDb.prepare(`UPDATE tenants SET commission_timezone = 'America/New_York' WHERE id = ?`).run(T1);
    }
  });
});
