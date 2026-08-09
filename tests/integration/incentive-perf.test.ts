// Guards on the two incentive hot paths, so the work done here cannot silently
// regress back into the rep's tap-to-confirm latency.
//
// EVERY applied knock evaluates campaigns, milestones, and momentum. That work
// is on the critical path of the single most-repeated action in the product, so
// it is measured, not assumed. The first cut of the campaign counters cost
// 111ms per knock at 120k rows — most of it computing fields the active trigger
// never read, plus a per-day query loop 60 iterations deep.
//
// These tests assert the MECHANISM (only the relevant counter is populated; the
// streak lookback is bounded by the streak being chased) rather than a wall-clock
// number, because a timing assertion on shared CI is a flake generator. The
// mechanism is what makes it fast, and it is what a careless refactor would undo.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let storage: (typeof import("../../server/storage"))["storage"];
let rawDb: any;
let campaigns: typeof import("../../server/spiffCampaignStore");

const DAY = 86_400_000;
let repId = 0;
let leadIds: number[] = [];

/**
 * ONE evaluation clock for the whole file, at noon UTC of the current UTC date.
 *
 * Every fixture row is stamped relative to this and every counter is evaluated
 * at it, so the fixture and the assertion can never disagree about which local
 * day a knock belongs to.
 *
 * `Date.now()` cannot do that job. Knocks written at `now - k * 60_000` straddle
 * LOCAL MIDNIGHT whenever the suite runs in the first few minutes of an org's
 * day: at 00:02 America/New_York, three of the six knocks land at 23:59, 23:58
 * and 23:57 the PREVIOUS local day, today holds only three against a five-knock
 * bar, and a streak that should read 2 reads 0. Reproduced exactly — the failure
 * window is 00:00–00:03 local, which is how it stayed hidden until a CI run
 * happened to cross it.
 *
 * Noon UTC is morning in every US org timezone, so it is far from both
 * midnights AND before the 23:00-local cutoff the knocks_by_time test needs.
 * That test discovered the same hazard first and fixed it locally; this hoists
 * its fix to the whole file, which is where it always belonged.
 */
const ANCHOR = (() => {
  const t = new Date();
  return Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), 12, 0, 0);
})();

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-incperf-"));
  process.env.NODE_ENV = "test";
  const storageModule = await import("../../server/storage");
  storageModule.runMigrations();
  storage = storageModule.storage;
  ({ rawDb } = await import("../../server/db"));
  await import("../../server/spiffStore");       // owns the `spiffs` DDL
  await import("../../server/knockMilestoneStore"); // owns the composite index
  campaigns = await import("../../server/spiffCampaignStore");

  const member = storage.createTeamMember({
    name: "Perf Rep", email: "perf@incperf.example.test", role: "rep", active: true, tenantId: 1,
  } as any);
  repId = member.id;

  // 400 doors, 20 days of verified activity — enough that an unbounded scan
  // would be visibly different from a bounded one.
  for (let i = 0; i < 400; i += 1) {
    leadIds.push(storage.createLead({
      address: `${i} Perf Ln`, city: "Testville", state: "NC", zip: "27000",
      leadStatus: "new", tenantId: 1,
    } as any).id);
  }
  const now = ANCHOR;
  const ins = rawDb.prepare(
    `INSERT INTO knock_log (lead_id, rep_id, outcome, was_home, knocked_at, tenant_id, verification_status, superseded)
     VALUES (?,?,?,?,?,1,'verified',0)`);
  rawDb.transaction(() => {
    for (let d = 0; d < 20; d += 1) {
      for (let k = 0; k < 20; k += 1) {
        const lead = leadIds[(d * 20 + k) % leadIds.length];
        ins.run(lead, repId, k % 3 === 0 ? "interested" : "not_home", k % 3 === 0 ? 1 : 0,
          new Date(now - d * DAY - k * 60_000).toISOString());
      }
    }
  })();
});

afterAll(() => { /* temp DATA_DIR is disposable */ });

/** Count the SQL statements a block issues, so "only what the trigger needs" is
 *  an assertion rather than a comment. */
function countQueries(fn: () => void): number {
  let n = 0;
  const orig = rawDb.prepare.bind(rawDb);
  (rawDb as any).prepare = (sql: string) => {
    const stmt = orig(sql);
    for (const m of ["get", "all", "run"] as const) {
      const inner = stmt[m].bind(stmt);
      (stmt as any)[m] = (...args: any[]) => { n += 1; return inner(...args); };
    }
    return stmt;
  };
  try { fn(); } finally { (rawDb as any).prepare = orig; }
  return n;
}

function campaignWith(trigger: any, name: string) {
  const now = ANCHOR;
  return campaigns.createCampaign(1, null, {
    name, startsAtMs: now - 20 * DAY, endsAtMs: now + 7 * DAY,
    trigger, rewardCents: 1_000, nowMs: now,
  });
}

describe("campaign counters only compute what the trigger reads", () => {
  it("a knocks_by_time campaign does not touch sales or the streak", () => {
    const c = campaignWith({ kind: "knocks_by_time", knocks: 10, byHourLocal: 23 }, "By time");
    // Deterministic evaluation clock: noon UTC is morning in every US org
    // timezone, so the 23:00-local cutoff can NEVER have passed and the knocks
    // below always count. (Evaluating at Date.now() made this test go quiet
    // for the hour after 23:00 local each day — the fixture knocks, stamped at
    // "now", were then legitimately past the cutoff and the counter correctly
    // read 0.) Dedicated knocks on tail leads keep the count exact regardless
    // of which fixture rows share the local day.
    const noonUtc = ANCHOR;
    const ins = rawDb.prepare(
      `INSERT INTO knock_log (lead_id, rep_id, outcome, was_home, knocked_at, tenant_id, verification_status, superseded)
       VALUES (?,?,?,?,?,1,'verified',0)`);
    for (let k = 0; k < 3; k += 1) {
      ins.run(leadIds[leadIds.length - 1 - k], repId, "interested", 1, new Date(noonUtc - (k + 1) * 60_000).toISOString());
    }
    const counters = campaigns.buildCounters(1, c, repId, noonUtc);
    expect(counters.knocksBeforeCutoffToday).toBeGreaterThanOrEqual(3);
    // Untouched — a field this trigger cannot read must not cost a query.
    expect(counters.salesInWindow).toBe(0);
    expect(counters.salesToday).toBe(0);
    expect(counters.streakDaysMeetingBar).toBe(0);
    expect(counters.knocksInWindow).toBe(0);
  });

  it("a sales_in_day campaign does not scan knocks at all", () => {
    const c = campaignWith({ kind: "sales_in_day", sales: 2 }, "Two a day");
    const counters = campaigns.buildCounters(1, c, repId, ANCHOR);
    expect(counters.knocksBeforeCutoffToday).toBe(0);
    expect(counters.streakDaysMeetingBar).toBe(0);
  });

  it("a per_sale campaign reads sales in the window and nothing else", () => {
    const c = campaignWith({ kind: "per_sale" }, "Per sale");
    const counters = campaigns.buildCounters(1, c, repId, ANCHOR);
    expect(counters.knocksBeforeCutoffToday).toBe(0);
    expect(counters.streakDaysMeetingBar).toBe(0);
    expect(counters.salesToday).toBe(0);
  });

  it("every trigger issues a small, bounded number of queries", () => {
    // The regression this guards: the streak path used to issue one query PER
    // DAY of lookback (up to 60) on every knock. A handful is correct; dozens
    // means the per-day loop is back.
    for (const [label, trigger] of [
      ["per_sale", { kind: "per_sale" }],
      ["knocks_by_time", { kind: "knocks_by_time", knocks: 10, byHourLocal: 23 }],
      ["sale_by_time", { kind: "sale_by_time", byHourLocal: 23 }],
      ["sales_in_day", { kind: "sales_in_day", sales: 2 }],
      ["knock_streak", { kind: "knock_streak", days: 5, knocksPerDay: 5 }],
    ] as const) {
      const c = campaignWith(trigger, `Q ${label}`);
      const n = countQueries(() => campaigns.buildCounters(1, c, repId, ANCHOR));
      expect(n, `${label} issued ${n} queries`).toBeLessThanOrEqual(6);
    }
  });
});

describe("the streak lookback is bounded by the streak being chased", () => {
  it("a 5-day streak never reports more than 5, however long the real run is", () => {
    // The rep above has 20 consecutive qualifying days. A 5-day campaign has no
    // reason to count past 5 — and counting past it is what made this slow.
    const c = campaignWith({ kind: "knock_streak", days: 5, knocksPerDay: 5 }, "Five day");
    const counters = campaigns.buildCounters(1, c, repId, ANCHOR);
    expect(counters.streakDaysMeetingBar).toBe(5);
  });

  it("still reports a SHORT streak accurately - the bound must not inflate it", () => {
    // The bound is a ceiling, not a floor: a rep who has only cleared the bar
    // for a few days must still read as those few days, or the campaign would
    // pay early.
    const solo = storage.createTeamMember({
      name: "Short Streak", email: "short@incperf.example.test", role: "rep", active: true, tenantId: 1,
    } as any);
    const now = ANCHOR;
    const ins = rawDb.prepare(
      `INSERT INTO knock_log (lead_id, rep_id, outcome, was_home, knocked_at, tenant_id, verification_status, superseded)
       VALUES (?,?,'not_home',0,?,1,'verified',0)`);
    // Only today and yesterday clear a 5-knock bar.
    for (let d = 0; d < 2; d += 1) {
      for (let k = 0; k < 6; k += 1) {
        ins.run(leadIds[d * 6 + k], solo.id, new Date(now - d * DAY - k * 60_000).toISOString());
      }
    }
    const c = campaignWith({ kind: "knock_streak", days: 5, knocksPerDay: 5 }, "Five day short");
    expect(campaigns.buildCounters(1, c, solo.id, now).streakDaysMeetingBar).toBe(2);
  });
});

describe("the composite knock index exists", () => {
  it("the rep+time+verified index is created and actually chosen", () => {
    // Every incentive counter asks "this rep's verified doors between two
    // instants". Without the composite, SQLite picks the time-only index and
    // scans EVERY rep's knocks in the window — a cost that grows with headcount.
    const plan = rawDb.prepare(
      `EXPLAIN QUERY PLAN
       SELECT COUNT(DISTINCT k.lead_id) FROM knock_log k JOIN leads l ON l.id = k.lead_id
        WHERE k.rep_id = ? AND l.tenant_id = 1 AND k.knocked_at >= ? AND k.knocked_at < ?
          AND k.verification_status = 'verified' AND COALESCE(k.superseded,0) = 0`,
    ).all(repId, "2020-01-01", "2030-01-01") as any[];
    const detail = plan.map(r => String(r.detail)).join(" | ");
    expect(detail).toContain("idx_knock_log_rep_time_verified");
  });
});
