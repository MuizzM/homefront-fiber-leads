// The standing door bonus, end to end.
//
// This ladder pays real money automatically, with no manager in the loop, so the
// properties that matter are the ones that would cost you if they broke:
//
//   1. THE COUNTER IS DISTINCT VERIFIED DOORS. Standing at one house and tapping
//      100 times earns nothing. Logging 100 knocks the GPS could not confirm
//      earns nothing. These are the two exploits that kill a per-door bonus on
//      day one, and they are the first two tests here.
//   2. A rung is paid EXACTLY ONCE per period. The 101st door does not re-earn
//      the 100-door rung.
//   3. Rungs stack — clearing 250 keeps the 100 already banked.
//   4. The award lands on the COMMISSION STATEMENT, which is the entire point of
//      routing it through the spiffs ledger.
//   5. Only someone who may configure comp can change the ladder, and only for
//      their own org.
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let server: Server;
let baseUrl: string;
let storage: (typeof import("../../server/storage"))["storage"];
let rawDb: any;

type Fixture = { userId: number; memberId: number; session: string };

function makePerson(name: string, loginRole: string, tenantId: number, memberRole = "rep"): Fixture {
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}@milestones.example.test`;
  const member = storage.createTeamMember({ name, email, role: memberRole, active: true, tenantId } as any);
  const user = storage.createUser({ name, email, role: loginRole, active: true, tenantId, teamMemberId: member.id } as any);
  return { userId: user.id, memberId: member.id, session: storage.createSession(user.id).id };
}

const request = (path: string, sessionId: string, init: RequestInit = {}) =>
  fetch(`${baseUrl}${path}`, { ...init, headers: { "content-type": "application/json", "x-session-id": sessionId, ...(init.headers ?? {}) } });
const put = (path: string, session: string, body: unknown) =>
  request(path, session, { method: "PUT", body: JSON.stringify(body) });

let admin: Fixture, rep: Fixture, farmer: Fixture, couch: Fixture, adminB: Fixture;
let TENANT_B = 0;
const doorIds: number[] = [];

/** Make `count` distinct doors available to knock on. Addresses carry a batch
 *  number because createLead de-duplicates on address — without it a second call
 *  silently hands back the FIRST batch's leads, and a test that thinks it added
 *  150 doors has added none. */
let doorBatch = 0;
function makeDoors(count: number, tenantId = 1): number[] {
  const batch = doorBatch += 1;
  const ids: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const lead = storage.createLead({
      address: `${i + 1} Milestone Ave Unit ${batch}`, city: "Testville", state: "NC", zip: "27000",
      leadStatus: "new", tenantId,
    } as any);
    ids.push(lead.id);
  }
  return ids;
}

/** Insert a knock row directly, so the test controls the verification verdict
 *  the server would otherwise compute from GPS. That verdict is exactly what
 *  these tests are about. */
function knock(repId: number, leadId: number, verification: string | null, at = new Date()): void {
  rawDb.prepare(
    `INSERT INTO knock_log (lead_id, rep_id, outcome, was_home, knocked_at, tenant_id, verification_status, superseded)
     VALUES (?,?,?,?,?,?,?,0)`,
  ).run(leadId, repId, "not_home", 0, at.toISOString(), 1, verification);
}

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-milestones-"));
  process.env.NODE_ENV = "test";
  const storageModule = await import("../../server/storage");
  storageModule.runMigrations();
  storage = storageModule.storage;
  ({ rawDb } = await import("../../server/db"));

  TENANT_B = storage.createTenant({
    slug: "milestones-b", companyName: "Org B", ownerName: "B Owner",
    ownerEmail: "owner-b@milestones.example.test", brandName: "Org B",
  } as any).id;

  admin = makePerson("Mile Admin", "admin", 1, "manager");
  rep = makePerson("Mile Rep", "rep", 1, "rep");
  farmer = makePerson("Mile Farmer", "rep", 1, "rep");
  couch = makePerson("Mile Couch", "rep", 1, "rep");
  adminB = makePerson("Mile Admin Bee", "admin", TENANT_B, "manager");

  doorIds.push(...makeDoors(120));

  const { registerRoutes, registerSaasRoutes } = await import("../../server/routes");
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  server = createServer(app);
  registerRoutes(server, app);
  registerSaasRoutes(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no bind");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(e => (e ? reject(e) : resolve())));
});

describe("the counter cannot be farmed", () => {
  it("tapping ONE door 150 times earns nothing", async () => {
    const { awardMilestonesForRep, verifiedDoorCount, periodWindow } =
      await import("../../server/knockMilestoneStore");
    for (let i = 0; i < 150; i += 1) knock(farmer.memberId, doorIds[0], "verified");

    const win = periodWindow(1, "week", Date.now());
    // 150 knock ROWS, one door. The count is doors worked, not buttons pressed.
    expect(verifiedDoorCount(1, farmer.memberId, win.startIso, win.endIso)).toBe(1);
    expect(awardMilestonesForRep(1, farmer.memberId, Date.now())).toEqual([]);

    const paid = rawDb.prepare(
      `SELECT COALESCE(SUM(amount_cents),0) AS s FROM spiffs WHERE rep_id = ? AND sale_ref LIKE 'milestone:%'`,
    ).get(farmer.memberId) as any;
    expect(paid.s).toBe(0);
  });

  it("120 doors logged from the couch earn nothing — only GPS-confirmed knocks count", async () => {
    const { awardMilestonesForRep, verifiedDoorCount, periodWindow } =
      await import("../../server/knockMilestoneStore");
    // Every knock is on a DIFFERENT door, so the distinct filter is satisfied —
    // the only thing stopping this is the verification verdict.
    doorIds.slice(0, 60).forEach(id => knock(couch.memberId, id, "needs_review"));
    doorIds.slice(60, 120).forEach(id => knock(couch.memberId, id, "invalid"));

    const win = periodWindow(1, "week", Date.now());
    expect(verifiedDoorCount(1, couch.memberId, win.startIso, win.endIso)).toBe(0);
    expect(awardMilestonesForRep(1, couch.memberId, Date.now())).toEqual([]);
  });

  it("a legacy knock with no verdict at all does not count either", async () => {
    const { verifiedDoorCount, periodWindow } = await import("../../server/knockMilestoneStore");
    const before = periodWindow(1, "week", Date.now());
    const start = verifiedDoorCount(1, couch.memberId, before.startIso, before.endIso);
    doorIds.slice(0, 30).forEach(id => knock(couch.memberId, id, null));
    expect(verifiedDoorCount(1, couch.memberId, before.startIso, before.endIso)).toBe(start);
  });

  it("a superseded knock does not count — it was applied to nothing", async () => {
    const { verifiedDoorCount, periodWindow } = await import("../../server/knockMilestoneStore");
    const win = periodWindow(1, "week", Date.now());
    const before = verifiedDoorCount(1, couch.memberId, win.startIso, win.endIso);
    rawDb.prepare(
      `INSERT INTO knock_log (lead_id, rep_id, outcome, was_home, knocked_at, tenant_id, verification_status, superseded)
       VALUES (?,?,?,?,?,?,'verified',1)`,
    ).run(doorIds[5], couch.memberId, "not_home", 0, new Date().toISOString(), 1);
    expect(verifiedDoorCount(1, couch.memberId, win.startIso, win.endIso)).toBe(before);
  });
});

describe("clearing rungs", () => {
  it("pays $25 at 100 verified doors, and does NOT re-pay on door 101", async () => {
    const { awardMilestonesForRep } = await import("../../server/knockMilestoneStore");

    doorIds.slice(0, 99).forEach(id => knock(rep.memberId, id, "verified"));
    expect(awardMilestonesForRep(1, rep.memberId, Date.now())).toEqual([]); // 99 — not yet

    knock(rep.memberId, doorIds[99], "verified"); // the hundredth door
    const first = awardMilestonesForRep(1, rep.memberId, Date.now());
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ doors: 100, amountCents: 2_500, inserted: true });

    // Door 101, 102, 103 — the rung re-evaluates as cleared every time and the
    // insert is ignored every time. This is the unique index doing the work.
    for (let i = 100; i < 103; i += 1) {
      knock(rep.memberId, doorIds[i], "verified");
      const again = awardMilestonesForRep(1, rep.memberId, Date.now());
      expect(again[0].inserted).toBe(false);
    }

    const row = rawDb.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents),0) AS s FROM spiffs
        WHERE rep_id = ? AND sale_ref LIKE 'milestone:%'`,
    ).get(rep.memberId) as any;
    expect(row.n).toBe(1);
    expect(row.s).toBe(2_500);
  });

  it("the rep's card agrees with the ledger, and names the next rung", async () => {
    const res = await request("/api/me/milestones", rep.session);
    expect(res.status).toBe(200);
    const card = await res.json() as any;
    expect(card.enabled).toBe(true);
    expect(card.progress.doors).toBe(103);
    expect(card.progress.earnedCents).toBe(2_500);
    expect(card.progress.target).toBe(250);
    expect(card.progress.headline).toBe("147 more verified doors this week for $50");
  });

  it("rungs STACK — clearing 250 keeps the 100 already banked", async () => {
    const { awardMilestonesForRep } = await import("../../server/knockMilestoneStore");
    const more = makeDoors(150);
    more.forEach(id => knock(rep.memberId, id, "verified")); // 103 + 150 = 253

    const awards = awardMilestonesForRep(1, rep.memberId, Date.now());
    const fresh = awards.filter(a => a.inserted);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({ doors: 250, amountCents: 5_000 });

    const row = rawDb.prepare(
      `SELECT COALESCE(SUM(amount_cents),0) AS s FROM spiffs WHERE rep_id = ? AND sale_ref LIKE 'milestone:%'`,
    ).get(rep.memberId) as any;
    expect(row.s).toBe(7_500); // $25 + $50, not $50
  });
});

describe("the money lands on the commission report", () => {
  it("a milestone award is a spiff, so the statement's spiff column carries it", async () => {
    const rows = rawDb.prepare(
      `SELECT * FROM spiffs WHERE rep_id = ? AND sale_ref LIKE 'milestone:%' ORDER BY amount_cents`,
    ).all(rep.memberId) as any[];
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.status === "earned")).toBe(true);
    // The reason is what the rep reads on their statement six weeks later, so it
    // has to say what they DID, not name an internal rung id.
    expect(rows.map(r => r.reason)).toEqual([
      "100 verified doors in a week",
      "250 verified doors in a week",
    ]);

    // …and it shows up on their ordinary spiff feed, not a parallel surface.
    const mine = await (await request("/api/spiffs/mine", rep.session)).json() as any;
    const ids = new Set(mine.spiffs.map((s: any) => s.id));
    expect(rows.every(r => ids.has(r.id))).toBe(true);
  });

  it("the statement builder folds it into earned pay", async () => {
    const { buildStatementDocument } = await import("../../shared/commissionStatement");
    // The invariant this whole feature rides on: earned = hourly + gross +
    // adjustments + SPIFFS. If a refactor ever drops spiffCents from that sum,
    // every milestone silently stops reaching the rep's check — so assert it by
    // building a real statement, not by reading the source.
    const doc = buildStatementDocument({
      company: { name: "Homefront" },
      rep: { id: rep.memberId, name: "Mile Rep" },
      period: { label: "Test week", startUtc: new Date(Date.now() - 6 * 86_400_000).toISOString(), nextStartUtc: new Date(Date.now() + 86_400_000).toISOString(), timezone: "America/New_York" },
      statement: { id: 1, status: "OPEN", calculationVersion: 1, tierLabel: null, rateCents: 5_000, structure: "FLAT" },
      sales: [],
      money: {
        grossCommissionCents: 0, adjustmentCents: 0,
        spiffCents: 7_500,           // the two milestone awards above
        hourlyPayCents: 0, hourlyMinutes: 0, hourlyRateCents: null,
        finalCommissionCents: 0,
      },
      holdback: { reservePercent: 0, reserveCents: 0, netPayableCents: 7_500, earnedCents: 7_500 },
      reserve: { balanceCents: 0, capCents: null },
      adjustments: [],
      issuedAtIso: new Date().toISOString(),
    });
    expect(doc.totals.spiffCents).toBe(7_500);
    expect(doc.totals.earnedCents).toBe(7_500);
  });
});

describe("configuring the ladder", () => {
  it("a rep cannot change what the org pays", async () => {
    const res = await put("/api/spiff-milestones", rep.session, {
      enabled: true, period: "week", rungs: [{ doors: 1, rewardCents: 100_000 }],
    });
    expect(res.status).toBe(403);
  });

  it("rejects a ladder the shared validator would refuse", async () => {
    const res = await put("/api/spiff-milestones", admin.session, {
      enabled: true, period: "week", rungs: [{ doors: 100, rewardCents: 500_000 }],
    });
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toMatch(/\$1,000/);
  });

  it("an admin retunes it, and the rep's card follows immediately", async () => {
    const res = await put("/api/spiff-milestones", admin.session, {
      enabled: true, period: "week", rungs: [{ doors: 50, rewardCents: 1_000 }, { doors: 400, rewardCents: 7_500 }],
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ladder.rungs).toEqual([
      { doors: 50, rewardCents: 1_000 }, { doors: 400, rewardCents: 7_500 },
    ]);
    // The exposure figure a manager needs BEFORE saving: per-rep ceiling × reps.
    expect(body.exposure.perRepCeilingCents).toBe(8_500);
    expect(body.exposure.activeReps).toBeGreaterThan(0);
    expect(body.exposure.worstCaseCents).toBe(8_500 * body.exposure.activeReps);

    const card = await (await request("/api/me/milestones", rep.session)).json() as any;
    expect(card.rungs).toEqual(body.ladder.rungs);
    expect(card.progress.target).toBe(400); // rep is at 253
  });

  it("switching it off makes the rep's card render nothing at all", async () => {
    expect((await put("/api/spiff-milestones", admin.session, {
      enabled: false, period: "week", rungs: [],
    })).status).toBe(200);
    const card = await (await request("/api/me/milestones", rep.session)).json() as any;
    expect(card.enabled).toBe(false);

    const { awardMilestonesForRep } = await import("../../server/knockMilestoneStore");
    expect(awardMilestonesForRep(1, rep.memberId, Date.now())).toEqual([]);
  });

  it("another tenant's ladder is untouched by this org's changes", async () => {
    const theirs = await (await request("/api/spiff-milestones", adminB.session)).json() as any;
    // Org B never configured anything, so it still has the shipped default —
    // the setting is tenant-scoped, not global.
    expect(theirs.ladder.enabled).toBe(true);
    expect(theirs.ladder.rungs[0]).toEqual({ doors: 100, rewardCents: 2_500 });
  });
});
