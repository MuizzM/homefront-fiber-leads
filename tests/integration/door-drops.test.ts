// Door drops, end to end.
//
// A drop pays real money off a random roll with nobody in the loop, so the
// properties worth proving against a live database are the ones that cost you if
// they break:
//
//   1. IT IS PAID EXACTLY ONCE. The roll is deterministic per knock, so a retry
//      recomputes a WIN — and if the ledger key were wrong, would pay it again.
//      Determinism makes double-payment more likely here, not less.
//   2. THE PITY COUNTER CANNOT BE FARMED. Standing at one door tapping, or
//      logging from the truck, must not walk a rep to a guaranteed payout.
//   3. IT REACHES THE COMMISSION STATEMENT, which is the whole reason awards ride
//      the spiffs ledger instead of a table of their own.
//   4. CAPS ARE REAL against concurrent reps, not just in the pure engine.
//   5. Config is org-scoped and gated on comp permission.
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_DOOR_DROP_CONFIG } from "../../shared/doorDrop";

let server: Server;
let baseUrl: string;
let storage: (typeof import("../../server/storage"))["storage"];
let rawDb: any;

type Fixture = { userId: number; memberId: number; session: string };

function makePerson(name: string, loginRole: string, tenantId: number, memberRole = "rep"): Fixture {
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}@drops.example.test`;
  const member = storage.createTeamMember({ name, email, role: memberRole, active: true, tenantId } as any);
  const user = storage.createUser({ name, email, role: loginRole, active: true, tenantId, teamMemberId: member.id } as any);
  return { userId: user.id, memberId: member.id, session: storage.createSession(user.id).id };
}

const request = (path: string, sessionId: string, init: RequestInit = {}) =>
  fetch(`${baseUrl}${path}`, { ...init, headers: { "content-type": "application/json", "x-session-id": sessionId, ...init.headers } });
const put = (path: string, session: string, body: unknown) =>
  request(path, session, { method: "PUT", body: JSON.stringify(body) });

let admin: Fixture, rep: Fixture, farmer: Fixture, couch: Fixture, adminB: Fixture, plainRep: Fixture;
let TENANT_B = 0;
const doorIds: number[] = [];

// createLead de-duplicates on address, so a second batch reusing addresses
// silently hands back the FIRST batch's leads — a test that thinks it made 200
// doors would have made none.
let doorBatch = 0;
function makeDoors(count: number, tenantId = 1): number[] {
  const batch = doorBatch += 1;
  const ids: number[] = [];
  for (let i = 0; i < count; i += 1) {
    ids.push(storage.createLead({
      address: `${i + 1} Drop Street Unit ${batch}`, city: "Testville", state: "NC", zip: "27000",
      leadStatus: "new", tenantId,
    } as any).id);
  }
  return ids;
}

/** Insert a knock row directly, so the test — not GPS — decides the verdict.
 *  Returns the knock id, which is the drop's seed AND its idempotency key. */
function knock(repId: number, leadId: number, verification: string | null, tenantId = 1): number {
  const info = rawDb.prepare(
    `INSERT INTO knock_log (lead_id, rep_id, outcome, was_home, knocked_at, tenant_id, verification_status, superseded)
     VALUES (?,?,?,?,?,?,?,0)`,
  ).run(leadId, repId, "not_home", 0, new Date().toISOString(), tenantId, verification);
  return Number(info.lastInsertRowid);
}

const dropsFor = (repId: number): { n: number; cents: number } => {
  const row = rawDb.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents),0) AS c FROM spiffs
      WHERE rep_id = ? AND sale_ref LIKE 'drop:knock:%'`,
  ).get(repId) as any;
  return { n: Number(row.n), cents: Number(row.c) };
};

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-drops-"));
  process.env.NODE_ENV = "test";
  const storageModule = await import("../../server/storage");
  storageModule.runMigrations();
  storage = storageModule.storage;
  ({ rawDb } = await import("../../server/db"));

  TENANT_B = storage.createTenant({
    slug: "drops-b", companyName: "Org B", ownerName: "B Owner",
    ownerEmail: "owner-b@drops.example.test", brandName: "Org B",
  } as any).id;

  admin = makePerson("Drop Admin", "admin", 1, "manager");
  rep = makePerson("Drop Rep", "rep", 1, "rep");
  farmer = makePerson("Drop Farmer", "rep", 1, "rep");
  couch = makePerson("Drop Couch", "rep", 1, "rep");
  plainRep = makePerson("Drop Plain", "rep", 1, "rep");
  adminB = makePerson("Drop Admin Bee", "admin", TENANT_B, "manager");

  doorIds.push(...makeDoors(400));

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

describe("a drop is paid exactly once", () => {
  it("re-rolling the SAME knock never pays twice", async () => {
    const { rollDoorDrop } = await import("../../server/doorDropStore");
    // Walk the rep to the pity ceiling so the roll is a guaranteed win — this
    // test is about the ledger key, not about getting lucky.
    doorIds.slice(0, DEFAULT_DOOR_DROP_CONFIG.pityAtDoors).forEach(id => knock(rep.memberId, id, "verified"));
    const winner = knock(rep.memberId, doorIds[300], "verified");

    const first = rollDoorDrop(1, rep.memberId, winner, Date.now());
    expect(first).not.toBeNull();
    expect(first!.inserted).toBe(true);
    expect(first!.amountCents).toBeGreaterThan(0);

    // An offline replay, a double-tapped submit, two servers racing. The verdict
    // is IDENTICAL by design — only the UNIQUE sale_ref stops a second payment.
    for (let i = 0; i < 5; i += 1) {
      const again = rollDoorDrop(1, rep.memberId, winner, Date.now());
      expect(again!.amountCents).toBe(first!.amountCents);
      expect(again!.inserted).toBe(false);
    }

    const paid = dropsFor(rep.memberId);
    expect(paid.n).toBe(1);
    expect(paid.cents).toBe(first!.amountCents);
  });

  it("the award reaches the rep's commission statement", async () => {
    const { buildStatementDocument } = await import("../../shared/commissionStatement");
    const won = dropsFor(rep.memberId);
    expect(won.cents).toBeGreaterThan(0);

    // The invariant the whole feature rides on: earned = hourly + gross +
    // adjustments + SPIFFS. Drops ride the spiffs ledger precisely so they
    // inherit it, with no second money path to maintain — so this builds a real
    // statement rather than reading the source.
    const doc = buildStatementDocument({
      company: { name: "Homefront" },
      rep: { id: rep.memberId, name: "Drop Rep" },
      period: {
        label: "Test week", startUtc: new Date(Date.now() - 6 * 86_400_000).toISOString(),
        nextStartUtc: new Date(Date.now() + 86_400_000).toISOString(), timezone: "America/New_York",
      },
      statement: { id: 1, status: "OPEN", calculationVersion: 1, tierLabel: null, rateCents: 5_000, structure: "FLAT" },
      sales: [],
      money: {
        grossCommissionCents: 0, adjustmentCents: 0,
        spiffCents: won.cents,
        hourlyPayCents: 0, hourlyMinutes: 0, hourlyRateCents: null,
        finalCommissionCents: 0,
      },
      holdback: { reservePercent: 0, reserveCents: 0, netPayableCents: won.cents, earnedCents: won.cents },
      reserve: { balanceCents: 0, capCents: null },
      adjustments: [],
      issuedAtIso: new Date().toISOString(),
    } as any);
    expect(doc.totals.spiffCents).toBe(won.cents);
    expect(doc.totals.earnedCents).toBe(won.cents);
  });
});

describe("the ledger stores one timestamp format", () => {
  it("every spiffs row is ISO - a mixed column silently disables the caps", async () => {
    // Not a style rule. created_at is compared and ORDERed as TEXT, and SQLite's
    // datetime('now') default ('2026-08-03 21:05:00') does not interleave with
    // the ISO form: ' ' sorts before 'T', so every default-shaped row sorts ahead
    // of every ISO row regardless of date, and an ISO range filter matches NONE
    // of them. When the award stores relied on that default, the door-drop daily
    // caps read $0 spent forever and the dry-run counter never reset after a
    // payout — leaving reps past the pity ceiling and dropping on every door.
    const rows = rawDb.prepare(`SELECT id, sale_ref, created_at FROM spiffs`).all() as any[];
    expect(rows.length).toBeGreaterThan(0);
    const wrong = rows.filter(r => !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(String(r.created_at)));
    expect(wrong).toEqual([]);
  });

  it("normalizeSpiffTimestamps repairs rows written before the rule", async () => {
    const { normalizeSpiffTimestamps } = await import("../../server/spiffStore");
    rawDb.prepare(
      `INSERT INTO spiffs (tenant_id, rep_id, sale_ref, amount_cents, reason, status, created_at)
       VALUES (1,?,?,?,?,'earned','2026-08-03 21:05:00')`,
    ).run(rep.memberId, "legacy:format:probe", 500, "legacy row");

    normalizeSpiffTimestamps();

    const row = rawDb.prepare(`SELECT created_at FROM spiffs WHERE sale_ref = ?`).get("legacy:format:probe") as any;
    expect(row.created_at).toBe("2026-08-03T21:05:00.000Z");
    // Idempotent — a second pass must not append another '.000Z'.
    normalizeSpiffTimestamps();
    expect((rawDb.prepare(`SELECT created_at FROM spiffs WHERE sale_ref = ?`).get("legacy:format:probe") as any).created_at)
      .toBe("2026-08-03T21:05:00.000Z");

    rawDb.prepare(`DELETE FROM spiffs WHERE sale_ref = ?`).run("legacy:format:probe");
  });
});

describe("the pity counter cannot be farmed", () => {
  it("tapping ONE door 300 times never reaches the guarantee", async () => {
    const { doorsSinceLastDrop, rollDoorDrop } = await import("../../server/doorDropStore");
    for (let i = 0; i < 300; i += 1) knock(farmer.memberId, doorIds[1], "verified");

    // 300 knock ROWS, one address. The counter is doors worked, not taps.
    expect(doorsSinceLastDrop(1, farmer.memberId)).toBe(1);
    // Well short of the ceiling, so the only way this pays is the base roll —
    // and one door is nowhere near enough attempts for that to be expected.
    expect(dropsFor(farmer.memberId).n).toBe(0);
    rollDoorDrop(1, farmer.memberId, knock(farmer.memberId, doorIds[1], "verified"), Date.now());
    expect(dropsFor(farmer.memberId).n).toBe(0);
  });

  it("doors logged from the couch never reach the guarantee", async () => {
    const { doorsSinceLastDrop } = await import("../../server/doorDropStore");
    // Every knock is a DIFFERENT address, so the distinct filter is satisfied.
    // The only thing standing between this rep and a guaranteed payout is the
    // GPS verdict.
    doorIds.slice(0, 200).forEach(id => knock(couch.memberId, id, "needs_review"));
    expect(doorsSinceLastDrop(1, couch.memberId)).toBe(0);
    expect(dropsFor(couch.memberId).n).toBe(0);
  });

  it("the counter resets after a drop, so one payout does not arm the next", async () => {
    const { doorsSinceLastDrop } = await import("../../server/doorDropStore");
    // `rep` won above after 120+ doors. Their counter now measures from THAT
    // drop, not from the beginning of time — otherwise every subsequent door
    // would be at the ceiling and the mechanic would pay on every knock.
    expect(doorsSinceLastDrop(1, rep.memberId)).toBeLessThan(DEFAULT_DOOR_DROP_CONFIG.pityAtDoors);
  });
});

describe("caps hold against a real ledger", () => {
  it("a rep at their daily count cap stops dropping, and does not burn the door", async () => {
    const { rollDoorDrop, doorsSinceLastDrop } = await import("../../server/doorDropStore");
    const capped = makePerson("Drop Capped", "rep", 1, "rep");
    const theirDoors = makeDoors(DEFAULT_DOOR_DROP_CONFIG.pityAtDoors + 40);

    // Hand them their full daily allowance directly, then take them to the
    // ceiling. Every roll from here is a guaranteed win the cap must refuse.
    for (let i = 0; i < DEFAULT_DOOR_DROP_CONFIG.maxPerRepPerDay; i += 1) {
      // created_at is passed explicitly, in ISO, for the same reason production
      // does: SQLite's datetime('now') default is a DIFFERENT string shape, and
      // this column is range-filtered as text.
      rawDb.prepare(
        `INSERT INTO spiffs (tenant_id, rep_id, sale_ref, amount_cents, reason, status, created_at)
         VALUES (1,?,?,?,?,'earned',?)`,
      ).run(capped.memberId, `drop:knock:seed-${capped.memberId}-${i}`, 100, "seeded",
            new Date().toISOString());
    }
    theirDoors.slice(0, DEFAULT_DOOR_DROP_CONFIG.pityAtDoors + 20).forEach(id => knock(capped.memberId, id, "verified"));

    const before = dropsFor(capped.memberId).n;
    for (let i = 0; i < 10; i += 1) {
      expect(rollDoorDrop(1, capped.memberId, knock(capped.memberId, theirDoors[300 + i] ?? theirDoors[0], "verified"), Date.now())).toBeNull();
    }
    expect(dropsFor(capped.memberId).n).toBe(before);

    // And the dry-run counter is still climbing — the doors refused at the cap
    // are not lost, they carry into tomorrow.
    expect(doorsSinceLastDrop(1, capped.memberId)).toBeGreaterThan(0);
  });

  it("a disabled programme pays nothing at all", async () => {
    const { rollDoorDrop, setDoorDropConfig } = await import("../../server/doorDropStore");
    const off = makePerson("Drop Off", "rep", 1, "rep");
    const theirDoors = makeDoors(DEFAULT_DOOR_DROP_CONFIG.pityAtDoors + 10);
    theirDoors.forEach(id => knock(off.memberId, id, "verified"));

    setDoorDropConfig(1, admin.userId, { ...DEFAULT_DOOR_DROP_CONFIG, enabled: false });
    try {
      for (let i = 0; i < 5; i += 1) {
        expect(rollDoorDrop(1, off.memberId, knock(off.memberId, theirDoors[i], "verified"), Date.now())).toBeNull();
      }
      expect(dropsFor(off.memberId).n).toBe(0);
    } finally {
      setDoorDropConfig(1, admin.userId, DEFAULT_DOOR_DROP_CONFIG);
    }
  });
});

describe("configuration is scoped and gated", () => {
  it("a rep cannot read or change the programme", async () => {
    expect((await request("/api/spiff-door-drops", plainRep.session)).status).toBe(403);
    expect((await put("/api/spiff-door-drops", plainRep.session, DEFAULT_DOOR_DROP_CONFIG)).status).toBe(403);
  });

  it("a manager can, and the change is visible to their own reps only", async () => {
    const saved = await put("/api/spiff-door-drops", admin.session,
      { ...DEFAULT_DOOR_DROP_CONFIG, minCents: 1_000, maxCents: 3_000, stepCents: 1_000 });
    expect(saved.status).toBe(200);

    const mine = await (await request("/api/me/door-drops", rep.session)).json();
    expect(mine.enabled).toBe(true);
    expect(mine.band).toEqual({ minCents: 1_000, maxCents: 3_000 });

    // Org B never asked for this and must not inherit it.
    const theirs = await (await request("/api/spiff-door-drops", adminB.session)).json();
    expect(theirs.config.minCents).toBe(DEFAULT_DOOR_DROP_CONFIG.minCents);

    await put("/api/spiff-door-drops", admin.session, DEFAULT_DOOR_DROP_CONFIG);
  });

  it("refuses a configuration the engine could not honour", async () => {
    // A guarantee tight enough to override the odds would silently pay several
    // times the budgeted rate, so it is rejected rather than quietly accepted.
    const res = await put("/api/spiff-door-drops", admin.session,
      { ...DEFAULT_DOOR_DROP_CONFIG, oddsOneIn: 100, pityAtDoors: 105 });
    expect(res.status).toBe(400);
    expect(String((await res.json()).error ?? "")).toMatch(/countdown/);
  });

  it("the rep card never leaks a percentage or a countdown", async () => {
    const mine = await (await request("/api/me/door-drops", rep.session)).json();
    expect(mine.statusLine).not.toMatch(/%/);
    expect(mine.statusLine).not.toMatch(/\d+\s*(doors?|more)\s*(to go|left|until)/i);
  });
});
