// Momentum spiffs, end to end.
//
// The mechanic is: a rep goes hot → an offer arms itself → they close inside the
// window → money. Every step is automatic, so the properties worth testing are
// the ones where an automatic system can quietly cheat someone:
//
//   1. THE OFFER IS HONOURED AS SHOWN. The amount and deadline freeze at arm
//      time. Retuning the config, or the rep cooling off, must not cheapen a
//      promise already on their phone.
//   2. ONE LIVE OFFER PER REP. Two concurrent knocks cannot arm two.
//   3. IT PAYS ONCE. A retried sale cannot collect the same promise twice.
//   4. AN EXPIRED OFFER PAYS NOTHING and is not re-armed by the sale itself.
//   5. The counters are verified distinct doors, like every other incentive here.
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
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}@momentum.example.test`;
  const member = storage.createTeamMember({ name, email, role: memberRole, active: true, tenantId } as any);
  const user = storage.createUser({ name, email, role: loginRole, active: true, tenantId, teamMemberId: member.id } as any);
  return { userId: user.id, memberId: member.id, session: storage.createSession(user.id).id };
}

const request = (path: string, sessionId: string, init: RequestInit = {}) =>
  fetch(`${baseUrl}${path}`, { ...init, headers: { "content-type": "application/json", "x-session-id": sessionId, ...(init.headers ?? {}) } });
const put = (path: string, session: string, body: unknown) =>
  request(path, session, { method: "PUT", body: JSON.stringify(body) });

let admin: Fixture, rep: Fixture, sprinter: Fixture, adminB: Fixture;
let TENANT_B = 0;

let batch = 0;
function makeDoors(count: number, tenantId = 1): number[] {
  const b = batch += 1;
  return Array.from({ length: count }, (_, i) =>
    storage.createLead({
      address: `${i + 1} Momentum Way Unit ${b}`, city: "Testville", state: "NC", zip: "27000",
      leadStatus: "new", tenantId,
    } as any).id);
}

/** A verified knock with a chosen outcome, at a chosen instant. */
function knock(repId: number, leadId: number, outcome: string, atMs: number): void {
  rawDb.prepare(
    `INSERT INTO knock_log (lead_id, rep_id, outcome, was_home, knocked_at, tenant_id, verification_status, superseded)
     VALUES (?,?,?,?,?,1,'verified',0)`,
  ).run(leadId, repId, outcome, outcome === "not_home" ? 0 : 1, new Date(atMs).toISOString());
}

/** Put `rep` genuinely hot inside the last hour: doors, conversations, interest. */
function goHot(repId: number, nowMs: number, doors = 26): void {
  const ids = makeDoors(doors);
  ids.forEach((id, i) => {
    // ~40% of doors open, 4 of them interested — a good live street.
    const outcome = i < 4 ? "interested" : i < 11 ? "follow_up" : "not_home";
    knock(repId, id, outcome, nowMs - (doors - i) * 60_000);
  });
}

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-momentum-"));
  process.env.NODE_ENV = "test";
  const storageModule = await import("../../server/storage");
  storageModule.runMigrations();
  storage = storageModule.storage;
  ({ rawDb } = await import("../../server/db"));

  TENANT_B = storage.createTenant({
    slug: "momentum-b", companyName: "Org B", ownerName: "B Owner",
    ownerEmail: "owner-b@momentum.example.test", brandName: "Org B",
  } as any).id;

  admin = makePerson("Mo Admin", "admin", 1, "manager");
  rep = makePerson("Mo Rep", "rep", 1, "rep");
  sprinter = makePerson("Mo Sprinter", "rep", 1, "rep");
  adminB = makePerson("Mo Admin Bee", "admin", TENANT_B, "manager");

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

describe("arming", () => {
  it("a speed-walker who talks to nobody never gets an offer", async () => {
    const { armMomentumOffer } = await import("../../server/momentumSpiffStore");
    const now = Date.now();
    // 40 doors, every one not_home. More activity than the hot rep, zero
    // conversation — the system must not pay this.
    makeDoors(40).forEach((id, i) => knock(sprinter.memberId, id, "not_home", now - (40 - i) * 60_000));
    expect(armMomentumOffer(1, sprinter.memberId, now)).toBeNull();
  });

  it("arms for a rep running hot on real conversations", async () => {
    const { armMomentumOffer } = await import("../../server/momentumSpiffStore");
    const now = Date.now();
    goHot(rep.memberId, now);

    const offer = armMomentumOffer(1, rep.memberId, now);
    expect(offer).not.toBeNull();
    expect(offer!.amountCents).toBeGreaterThan(0);
    expect(offer!.expiresAtMs).toBeGreaterThan(now);
    expect(offer!.callToAction).toMatch(/Close one in the next/);
  });

  it("does NOT arm a second offer while one is live", async () => {
    const { armMomentumOffer } = await import("../../server/momentumSpiffStore");
    // Still hot, still holding one. A second card would muddy which promise is
    // real, and the unique index refuses it regardless.
    expect(armMomentumOffer(1, rep.memberId, Date.now())).toBeNull();

    const live = rawDb.prepare(
      `SELECT COUNT(*) AS n FROM momentum_offers WHERE rep_id = ? AND status = 'live'`,
    ).get(rep.memberId) as any;
    expect(live.n).toBe(1);
  });

  it("the database itself refuses a second live offer", () => {
    // Belt and braces: even a caller that skips armMomentumOffer's guard cannot
    // create two live promises for one rep.
    expect(() => rawDb.prepare(
      `INSERT INTO momentum_offers (tenant_id, rep_id, armed_at_ms, expires_at_ms, amount_cents, score, status)
       VALUES (1, ?, ?, ?, 9999, 90, 'live')`,
    ).run(rep.memberId, Date.now(), Date.now() + 600_000)).toThrow(/UNIQUE|constraint/i);
  });

  it("the rep's card carries the live offer", async () => {
    const card = await (await request("/api/me/momentum", rep.session)).json() as any;
    expect(card.enabled).toBe(true);
    expect(card.offer).not.toBeNull();
    expect(card.offer.remainingMs).toBeGreaterThan(0);
    expect(card.score).toBeGreaterThanOrEqual(card.armAtScore);
  });
});

describe("converting", () => {
  it("pays the amount that was SHOWN, not a re-evaluation", async () => {
    const { convertMomentumOffer } = await import("../../server/momentumSpiffStore");
    const offerRow = rawDb.prepare(
      `SELECT * FROM momentum_offers WHERE rep_id = ? AND status = 'live'`,
    ).get(rep.memberId) as any;
    const shown = Number(offerRow.amount_cents);

    // Retune the config to something far stingier BEFORE the rep closes. The
    // promise already on their phone must be honoured at the old amount — this
    // is the property that makes the offer trustworthy.
    expect((await put("/api/spiff-momentum", admin.session, {
      enabled: true, armAtScore: 99,
      tiers: [{ atScore: 99, amountCents: 100 }],
    })).status).toBe(200);

    const won = convertMomentumOffer(1, rep.memberId, "knock:999", Date.now());
    expect(won).not.toBeNull();
    expect(won!.amountCents).toBe(shown);
    expect(won!.inserted).toBe(true);

    const spiff = rawDb.prepare(
      `SELECT * FROM spiffs WHERE rep_id = ? AND sale_ref = ?`,
    ).get(rep.memberId, `momentum:${offerRow.id}`) as any;
    expect(spiff).toBeTruthy();
    expect(spiff.amount_cents).toBe(shown);
    expect(spiff.status).toBe("earned");
  });

  it("a retried sale cannot collect the same promise twice", async () => {
    const { convertMomentumOffer } = await import("../../server/momentumSpiffStore");
    for (let i = 0; i < 3; i += 1) {
      expect(convertMomentumOffer(1, rep.memberId, "knock:999", Date.now())).toBeNull();
    }
    const row = rawDb.prepare(
      `SELECT COUNT(*) AS n FROM spiffs WHERE rep_id = ? AND sale_ref LIKE 'momentum:%'`,
    ).get(rep.memberId) as any;
    expect(row.n).toBe(1);
  });

  it("the award rides the normal spiff ledger and reaches the rep's feed", async () => {
    const mine = await (await request("/api/spiffs/mine", rep.session)).json() as any;
    const momentumRows = mine.spiffs.filter((s: any) => String(s.saleRef ?? "").startsWith("momentum:"));
    expect(momentumRows).toHaveLength(1);
    expect(momentumRows[0].reason).toMatch(/Hot streak/);

    // …and settles through the SAME approve route every other spiff uses.
    const res = await request(`/api/spiffs/${momentumRows[0].id}/approve`, admin.session, { method: "POST" });
    expect(res.status).toBe(200);
  });
});

describe("expiry", () => {
  it("an expired offer pays nothing", async () => {
    const { armMomentumOffer, convertMomentumOffer, expireStaleOffers } =
      await import("../../server/momentumSpiffStore");
    // Put the config back to something armable and go hot again.
    expect((await put("/api/spiff-momentum", admin.session, {
      enabled: true, armAtScore: 55, dryMinutes: 0,
      tiers: [{ atScore: 55, amountCents: 2_500 }],
    })).status).toBe(200);

    const now = Date.now();
    goHot(rep.memberId, now);
    const offer = armMomentumOffer(1, rep.memberId, now);
    expect(offer).not.toBeNull();

    // Fast-forward past the deadline.
    const after = offer!.expiresAtMs + 60_000;
    expireStaleOffers(1, after);
    expect(convertMomentumOffer(1, rep.memberId, "knock:1001", after)).toBeNull();

    const row = rawDb.prepare(`SELECT status FROM momentum_offers WHERE id = ?`).get(offer!.id) as any;
    expect(row.status).toBe("expired");
  });

  it("an expired offer is not shown to the rep as a live promise", async () => {
    const card = await (await request("/api/me/momentum", rep.session)).json() as any;
    // The card may legitimately have re-armed (the rep is still hot) — what must
    // never happen is the EXPIRED row coming back as live.
    if (card.offer) {
      expect(card.offer.remainingMs).toBeGreaterThan(0);
      const row = rawDb.prepare(`SELECT status FROM momentum_offers WHERE id = ?`).get(card.offer.id) as any;
      expect(row.status).toBe("live");
    }
  });
});

describe("configuring it", () => {
  it("a rep cannot retune what the org pays", async () => {
    const res = await put("/api/spiff-momentum", rep.session, {
      enabled: true, armAtScore: 1, tiers: [{ atScore: 1, amountCents: 100_000 }],
    });
    expect(res.status).toBe(403);
  });

  it("rejects a config the shared validator would refuse", async () => {
    const res = await put("/api/spiff-momentum", admin.session, {
      enabled: true, armAtScore: 55, tiers: [{ atScore: 80, amountCents: 2_500 }],
    });
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toMatch(/no offer can ever fire/);
  });

  it("switching it off stops arming and blanks the rep's card", async () => {
    const { armMomentumOffer } = await import("../../server/momentumSpiffStore");
    expect((await put("/api/spiff-momentum", admin.session, {
      enabled: false, armAtScore: 55, tiers: [{ atScore: 55, amountCents: 2_500 }],
    })).status).toBe(200);

    const card = await (await request("/api/me/momentum", rep.session)).json() as any;
    expect(card.enabled).toBe(false);
    expect(card.offer).toBeNull();
    expect(armMomentumOffer(1, rep.memberId, Date.now())).toBeNull();
  });

  it("another tenant keeps its own config", async () => {
    const theirs = await (await request("/api/spiff-momentum", adminB.session)).json() as any;
    // Org B never configured anything — it still has the shipped default, on.
    expect(theirs.config.enabled).toBe(true);
    expect(theirs.exposure.armedToday).toBe(0);
  });
});

describe("the admin can see whether it is working", () => {
  it("exposure reports armed / converted / expired and a conversion rate", async () => {
    const { momentumExposure } = await import("../../server/momentumSpiffStore");
    const e = momentumExposure(1, Date.now());
    expect(e.armedToday).toBeGreaterThan(0);
    expect(e.convertedToday).toBeGreaterThan(0);
    // The number that says whether the thresholds are set right: offers that
    // expire unclaimed mean the bar is too high or the window too short.
    expect(e.conversionRate).toBeGreaterThan(0);
    expect(e.conversionRate).toBeLessThanOrEqual(100);
    expect(e.armedToday).toBe(e.convertedToday + e.expiredToday + e.liveOffers);
  });
});
