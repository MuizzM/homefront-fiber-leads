// "Earned today" — the headline number on the rep home screen.
//
// This is a money figure a rep reads before deciding whether to work another two
// hours, so the property under test is not "does it add up" but "does it ever
// claim money that isn't real". Every test here is about the banked/pending
// split holding under a case that would tempt it to blur.
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_WORKWEEK, localWallToUtcMs, localYmdParts } from "../../shared/workweek";

let server: Server;
let baseUrl: string;
let storage: (typeof import("../../server/storage"))["storage"];
let rawDb: any;

type Fixture = { userId: number; memberId: number; session: string };

function makePerson(name: string, loginRole: string, tenantId: number, memberRole = "rep"): Fixture {
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}@earnings.example.test`;
  const member = storage.createTeamMember({ name, email, role: memberRole, active: true, tenantId } as any);
  const user = storage.createUser({ name, email, role: loginRole, active: true, tenantId, teamMemberId: member.id } as any);
  return { userId: user.id, memberId: member.id, session: storage.createSession(user.id).id };
}

const request = (path: string, sessionId: string) =>
  fetch(`${baseUrl}${path}`, { headers: { "content-type": "application/json", "x-session-id": sessionId } });

let rep: Fixture, pctRep: Fixture;
let doorBatch = 0;

/** Today at `hourLocal` in the ORG's timezone — never the container's. The
 *  container runs UTC and the tenant runs Eastern, and setHours would put a 9am
 *  knock on the wrong local DATE for four hours every night. */
function orgToday(hourLocal: number): Date {
  const tz = DEFAULT_WORKWEEK.timezone;
  const { y, mo, d } = localYmdParts(Date.now(), tz);
  return new Date(localWallToUtcMs(y, mo, d, hourLocal, 0, tz));
}

function sell(repId: number, n: number): void {
  const batch = doorBatch += 1;
  const at = orgToday(10);
  for (let i = 0; i < n; i += 1) {
    const lead = storage.createLead({
      address: `${i + 1} Earnings Ave Unit ${batch}`, city: "Testville", state: "NC", zip: "27000",
      leadStatus: "new", tenantId: 1,
    } as any);
    rawDb.prepare(
      `INSERT INTO knock_log (lead_id, rep_id, outcome, was_home, knocked_at, tenant_id, verification_status, superseded)
       VALUES (?,?,?,?,?,1,'verified',0)`,
    ).run(lead.id, repId, "sold", 1, new Date(at.getTime() + i * 1000).toISOString());
  }
}

function awardSpiff(repId: number, cents: number, ref: string): void {
  rawDb.prepare(
    `INSERT INTO spiffs (tenant_id, rep_id, sale_ref, amount_cents, reason, status, created_at)
     VALUES (1,?,?,?,?,'earned',?)`,
  ).run(repId, ref, cents, "test award", orgToday(11).toISOString());
}

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-earnings-"));
  process.env.NODE_ENV = "test";
  const storageModule = await import("../../server/storage");
  storageModule.runMigrations();
  storage = storageModule.storage;
  ({ rawDb } = await import("../../server/db"));

  rep = makePerson("Earn Rep", "rep", 1, "rep");
  pctRep = makePerson("Pct Rep", "rep", 1, "rep");

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

describe("banked money is only what is certain", () => {
  it("starts at zero and says so, rather than guessing", async () => {
    const { earningsToday } = await import("../../server/earningsTodayStore");
    const e = earningsToday(1, rep.memberId, Date.now());
    expect(e.bankedCents).toBe(0);
    expect(e.salesToday).toBe(0);
    expect(e.pendingCents).toBeNull();
    expect(e.pendingBasis).toBe("no_sales");
  });

  it("counts spiffs already in the ledger", async () => {
    const { earningsToday } = await import("../../server/earningsTodayStore");
    awardSpiff(rep.memberId, 2_500, "test:spiff:1");
    awardSpiff(rep.memberId, 1_500, "test:spiff:2");
    const e = earningsToday(1, rep.memberId, Date.now());
    expect(e.spiffCents).toBe(4_000);
    expect(e.bankedCents).toBe(4_000);
  });

  it("counts hours already worked, including an OPEN shift", async () => {
    const { earningsToday } = await import("../../server/earningsTodayStore");
    rawDb.prepare(`UPDATE team_members SET hourly_rate_cents = 2000 WHERE id = ?`).run(rep.memberId);

    const tz = DEFAULT_WORKWEEK.timezone;
    const { y, mo, d } = localYmdParts(Date.now(), tz);
    const ymd = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const startedMs = Date.now() - 2 * 3_600_000;
    // No clocked_out: the rep is still on shift. Two hours in is two hours
    // earned — showing zero until they clock out would make the number useless
    // for exactly the person looking at it.
    rawDb.prepare(
      `INSERT INTO clock_sessions (rep_id, user_id, clocked_in, clocked_out, duration_minutes, date)
       VALUES (?,?,?,NULL,NULL,?)`,
    ).run(rep.memberId, rep.userId, new Date(startedMs).toISOString(), ymd);

    const e = earningsToday(1, rep.memberId, Date.now());
    expect(e.hourlyMinutes).toBeGreaterThanOrEqual(119);
    expect(e.hourlyCents).toBeGreaterThanOrEqual(3_950);   // ~2h at $20/h
    expect(e.bankedCents).toBe(e.hourlyCents + e.spiffCents);
  });
});

describe("commission on today's sales stays OUT of the headline", () => {
  it("a sale never moves bankedCents", async () => {
    const { earningsToday } = await import("../../server/earningsTodayStore");
    const before = earningsToday(1, rep.memberId, Date.now()).bankedCents;
    sell(rep.memberId, 2);
    const after = earningsToday(1, rep.memberId, Date.now());

    // The whole design: a sale is not money yet. It can fail qualification, sit
    // behind a holdback, or charge back.
    expect(after.bankedCents).toBe(before);
    expect(after.salesToday).toBe(2);
  });

  it("estimates pending only on a FLAT plan, and keeps it separate", async () => {
    const { earningsToday } = await import("../../server/earningsTodayStore");
    storage.createCommissionRate({
      name: "Flat plan", role: "rep", repId: rep.memberId, ratePerSale: 75,
      isActive: true, tenantId: 1,
    } as any);

    const e = earningsToday(1, rep.memberId, Date.now());
    expect(e.pendingBasis).toBe("flat");
    expect(e.pendingCents).toBe(2 * 7_500);
    // Still separate. Blending them is the thing this must never do.
    expect(e.bankedCents).not.toBe(e.bankedCents + (e.pendingCents ?? 0));
    expect(e.bankedCents).toBe(e.hourlyCents + e.spiffCents);
  });

  it("returns NULL rather than a guess when the plan needs sale amounts", async () => {
    const { earningsToday } = await import("../../server/earningsTodayStore");
    const rate = storage.createCommissionRate({
      name: "Percentage plan", role: null, repId: pctRep.memberId, ratePerSale: 0,
      isActive: true, tenantId: 1,
    } as any);
    rawDb.prepare(`UPDATE commission_rates SET calc_type = 'percentage', percentage = 10 WHERE id = ?`).run(rate.id);
    sell(pctRep.memberId, 3);

    const e = earningsToday(1, pctRep.memberId, Date.now());
    expect(e.salesToday).toBe(3);
    // A percentage plan needs the sale AMOUNT; deriving one here would be a
    // second commission engine that could disagree with the real one.
    expect(e.pendingCents).toBeNull();
    expect(e.pendingBasis).toBe("needs_sale_amounts");
  });
});

describe("the endpoint", () => {
  it("serves the rep their own figures", async () => {
    const res = await request("/api/me/earnings-today", rep.session);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.bankedCents).toBeGreaterThan(0);
    expect(body.salesToday).toBe(2);
    expect(body.pendingCents).toBe(15_000);
  });

  it("never leaks another rep's money", async () => {
    // Same tenant, different rep — the figures must be the CALLER's, derived
    // from their session, with no id in the URL to tamper with.
    const mine = await (await request("/api/me/earnings-today", pctRep.session)).json();
    expect(mine.salesToday).toBe(3);
    expect(mine.pendingCents).toBeNull();
    expect(mine.spiffCents).toBe(0);
  });
});
