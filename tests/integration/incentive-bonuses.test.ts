// The three new incentive engines, end to end against a real database.
//
// The pure decision logic is unit-tested elsewhere (genuine-doors,
// ramp-bonus, sales-achievements). What can only be proven HERE is everything
// the pure layer deliberately cannot see:
//
//   1. WHICH CLOCK a door is timed by — the unforgeable server stamp for a live
//      knock, the device stamp only for one that genuinely sat in the offline
//      queue. This is the load-bearing choice in the whole feature: get it
//      wrong one way and a fabricated day pays, wrong the other way and the rep
//      working the worst coverage in the market is the one who never earns.
//   2. IDEMPOTENCY. Every one of these fires on every knock, every sale, and
//      every review batch. If a second call pays a second time, the bonus is a
//      money bug, not a feature.
//   3. That the money lands where the rep will look for it: the spiff ledger,
//      which is what carries it onto the commission statement.
//   4. Tenant isolation and the config gate.
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WORKWEEK, localWallToUtcMs, localYmdParts } from "@shared/workweek";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let server: Server;
let baseUrl: string;
let storage: (typeof import("../../server/storage"))["storage"];
let rawDb: any;

type Fixture = { userId: number; memberId: number; session: string };

function makePerson(name: string, loginRole: string, tenantId: number, memberRole = "rep"): Fixture {
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}@bonuses.example.test`;
  const member = storage.createTeamMember({ name, email, role: memberRole, active: true, tenantId } as any);
  const user = storage.createUser({ name, email, role: loginRole, active: true, tenantId, teamMemberId: member.id } as any);
  return { userId: user.id, memberId: member.id, session: storage.createSession(user.id).id };
}

const request = (path: string, sessionId: string, init: RequestInit = {}) =>
  fetch(`${baseUrl}${path}`, { ...init, headers: { "content-type": "application/json", "x-session-id": sessionId, ...init.headers } });
const put = (path: string, session: string, body: unknown) =>
  request(path, session, { method: "PUT", body: JSON.stringify(body) });

let admin: Fixture, walker: Fixture, sprinter: Fixture, spoofer: Fixture;
let offliner: Fixture, closer: Fixture, newHire: Fixture, adminB: Fixture;
let TENANT_B = 0;
const doorIds: number[] = [];

let doorBatch = 0;
function makeDoors(count: number, tenantId = 1): number[] {
  const batch = doorBatch += 1;
  const ids: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const lead = storage.createLead({
      address: `${i + 1} Bonus Way Unit ${batch}`, city: "Testville", state: "NC", zip: "27000",
      leadStatus: "new", tenantId,
    } as any);
    ids.push(lead.id);
  }
  return ids;
}

/**
 * Insert a verified knock with BOTH clocks under the test's control.
 *
 * `serverAt` is what the server stamped; `deviceAt` is what the phone claimed.
 * Passing them apart is how an offline flush is simulated — and how the
 * fabricated version of the same day is simulated too.
 */
function knockAt(
  repId: number, leadId: number, serverAt: Date,
  opts: { deviceAt?: Date; verification?: string } = {},
): void {
  const deviceAt = opts.deviceAt ?? serverAt;
  rawDb.prepare(
    `INSERT INTO knock_log (lead_id, rep_id, outcome, was_home, knocked_at, tenant_id,
                            verification_status, superseded, server_ts, device_ts)
     VALUES (?,?,?,?,?,?,?,0,?,?)`,
  ).run(
    leadId, repId, "not_home", 0, deviceAt.toISOString(), 1,
    opts.verification ?? "verified", serverAt.toISOString(), deviceAt.toISOString(),
  );
}

/** A qualified sale, the same shape the money bundle writes on a sold knock. */
function sale(repId: number, leadId: number, at: Date, tenantId = 1): void {
  const iso = at.toISOString();
  rawDb.prepare(
    `INSERT INTO commission_sales (tenant_id, rep_id, external_id, status, sold_at, qualified_at, lead_id, created_at, updated_at)
     VALUES (?,?,?, 'QUALIFIED', ?,?,?,?,?)`,
  ).run(tenantId, repId, `lead:${leadId}`, iso, iso, leadId, iso, iso);
}

const ledgerCents = (repId: number, prefix: string): number => Number(rawDb.prepare(
  `SELECT COALESCE(SUM(amount_cents),0) AS s FROM spiffs WHERE rep_id = ? AND sale_ref LIKE ?`,
).get(repId, `${prefix}%`).s);

const ledgerRows = (repId: number, prefix: string): number => Number(rawDb.prepare(
  `SELECT COUNT(*) AS n FROM spiffs WHERE rep_id = ? AND sale_ref LIKE ?`,
).get(repId, `${prefix}%`).n);

/**
 * A fixed mid-morning start, anchored to the ORG's timezone rather than the test
 * host's.
 *
 * `new Date(); setHours(9,…)` anchors to the HOST's calendar day, which is not
 * the day the card endpoints bucket by — they use the org's
 * commission_timezone (America/New_York). The two agree on a New York host and
 * diverge on a UTC one for the four hours after midnight UTC, because UTC has
 * already rolled to tomorrow while New York is still on today. CI runs in UTC,
 * so a 02:48 UTC run stamped its sales on Aug 7 org-local and then asked the
 * card for Aug 6 — which correctly answered zero.
 *
 * Deriving the anchor through the same timezone helpers the app uses makes this
 * suite host-independent, which is what the original comment intended.
 */
const ORG_TZ = DEFAULT_WORKWEEK.timezone;
const { y: ORG_Y, mo: ORG_MO, d: ORG_D } = localYmdParts(Date.now(), ORG_TZ);
const DAY_START = new Date(localWallToUtcMs(ORG_Y, ORG_MO, ORG_D, 9, 0, ORG_TZ));
const at = (minutes: number) => new Date(DAY_START.getTime() + minutes * 60_000);

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-bonuses-"));
  process.env.NODE_ENV = "test";
  const storageModule = await import("../../server/storage");
  storageModule.runMigrations();
  storage = storageModule.storage;
  ({ rawDb } = await import("../../server/db"));

  TENANT_B = storage.createTenant({
    slug: "bonuses-b", companyName: "Org B", ownerName: "B Owner",
    ownerEmail: "owner-b@bonuses.example.test", brandName: "Org B",
  } as any).id;

  admin = makePerson("Bonus Admin", "admin", 1, "manager");
  walker = makePerson("Bonus Walker", "rep", 1, "rep");
  sprinter = makePerson("Bonus Sprinter", "rep", 1, "rep");
  spoofer = makePerson("Bonus Spoofer", "rep", 1, "rep");
  offliner = makePerson("Bonus Offliner", "rep", 1, "rep");
  closer = makePerson("Bonus Closer", "rep", 1, "rep");
  newHire = makePerson("Bonus Newbie", "rep", 1, "rep");
  adminB = makePerson("Bonus Admin Bee", "admin", TENANT_B, "manager");

  // The achievement ladder hands new hires to the ramp bonus instead, so the
  // rep those tests are about has to be past their first fortnight. Everyone
  // else keeps today's hire date.
  rawDb.prepare(`UPDATE team_members SET created_at = ? WHERE id IN (?,?,?,?)`)
    .run(new Date(Date.now() - 60 * 86_400_000).toISOString(),
         closer.memberId, sprinter.memberId, spoofer.memberId, offliner.memberId);

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

// ── The genuine-day bonus ────────────────────────────────────────────────────

describe("60 genuine doors pays $50", () => {
  it("pays an honest five-hour shift", async () => {
    const { awardDoorDayForRep } = await import("../../server/genuineDoorBonusStore");
    // 60 doors, one every five minutes, each stamped live by the server.
    doorIds.slice(0, 60).forEach((id, i) => knockAt(walker.memberId, id, at(i * 5)));

    const award = awardDoorDayForRep(1, walker.memberId, at(300).getTime());
    expect(award?.amountCents).toBe(5_000);
    expect(award?.inserted).toBe(true);
    expect(ledgerCents(walker.memberId, "doorday:")).toBe(5_000);
  });

  it("pays exactly once, however many more doors land", async () => {
    const { awardDoorDayForRep } = await import("../../server/genuineDoorBonusStore");
    doorIds.slice(60, 80).forEach((id, i) => knockAt(walker.memberId, id, at(305 + i * 5)));

    // Every extra door re-evaluates the same day. The unique key does the work.
    for (let i = 0; i < 5; i += 1) {
      const again = awardDoorDayForRep(1, walker.memberId, at(410).getTime());
      expect(again?.inserted).toBe(false);
    }
    expect(ledgerCents(walker.memberId, "doorday:")).toBe(5_000);
    expect(ledgerRows(walker.memberId, "doorday:")).toBe(1);
  });

  it("refuses a 60-door burst logged from a list in twenty minutes", async () => {
    const { awardDoorDayForRep, evaluateDoorDayForRep } = await import("../../server/genuineDoorBonusStore");
    // Distinct addresses, all GPS-verified — only the CLOCK betrays this day.
    doorIds.slice(100, 160).forEach((id, i) => knockAt(sprinter.memberId, id, at(i / 3)));

    expect(awardDoorDayForRep(1, sprinter.memberId, at(60).getTime())).toBeNull();
    expect(ledgerCents(sprinter.memberId, "doorday:")).toBe(0);

    // And the rep is told which rule stopped it, not left with a silent zero.
    const e = evaluateDoorDayForRep(1, sprinter.memberId, at(60).getTime());
    expect(e.decision.count.counted).toBeLessThan(60);
    expect(e.decision.count.rejected.hour_cap + e.decision.count.rejected.too_fast).toBeGreaterThan(0);
  });

  it("pays the rep who walked all day with no signal", async () => {
    const { awardDoorDayForRep, evaluateDoorDayForRep } = await import("../../server/genuineDoorBonusStore");
    // The honest offline day: doors spread across five hours on the DEVICE
    // clock, every one of them received in a single 5pm flush. On the server
    // clock alone this is indistinguishable from the burst above — which is
    // exactly why the store does not use the server clock alone.
    const flush = at(360);
    doorIds.slice(200, 260).forEach((id, i) =>
      knockAt(offliner.memberId, id, flush, { deviceAt: at(i * 5) }));

    const e = evaluateDoorDayForRep(1, offliner.memberId, at(365).getTime());
    expect(e.deviceTimed).toBe(60);       // recorded, so an "always offline" rep is visible
    expect(e.decision.qualifies).toBe(true);
    expect(awardDoorDayForRep(1, offliner.memberId, at(365).getTime())?.amountCents).toBe(5_000);
  });

  it("withholds the whole day when the phone was caught lying", async () => {
    const { awardDoorDayForRep, evaluateDoorDayForRep } = await import("../../server/genuineDoorBonusStore");
    // A full honest-looking shift…
    doorIds.slice(300, 360).forEach((id, i) => knockAt(spoofer.memberId, id, at(i * 5)));
    // …plus one knock the server rated `invalid` (mock location, impossible
    // travel, a clock reporting the future).
    knockAt(spoofer.memberId, doorIds[399], at(30), { verification: "invalid" });

    const e = evaluateDoorDayForRep(1, spoofer.memberId, at(305).getTime());
    expect(e.decision.blockedBy).toBe("tamper");
    expect(e.decision.needsReview).toBe(true);
    // Not "the clean 60 still count" — that is the loophole.
    expect(awardDoorDayForRep(1, spoofer.memberId, at(305).getTime())).toBeNull();
    expect(ledgerCents(spoofer.memberId, "doorday:")).toBe(0);
  });

  it("lands on the rep's card with the counter's own numbers", async () => {
    const res = await request("/api/me/door-day", walker.session);
    expect(res.status).toBe(200);
    const card = await res.json();
    expect(card.enabled).toBe(true);
    expect(card.target).toBe(60);
    expect(card.earned).toBe(true);
    expect(card.rewardCents).toBe(5_000);
  });
});

// ── The achievement ladder ───────────────────────────────────────────────────

describe("achievement bonuses pay for reachable sales counts", () => {
  it("pays nothing for one sale, $25 for two", async () => {
    const { awardAchievementsForRep } = await import("../../server/salesAchievementStore");
    sale(closer.memberId, doorIds[0], at(10));
    expect(awardAchievementsForRep(1, closer.memberId, at(11).getTime())).toEqual([]);

    sale(closer.memberId, doorIds[1], at(20));
    const awards = awardAchievementsForRep(1, closer.memberId, at(21).getTime());
    expect(awards.map(a => a.amountCents)).toEqual([2_500]);
    expect(awards[0].reason).toBe("2 sales in a day");
  });

  it("stacks the $50 rung on top rather than replacing it", async () => {
    const { awardAchievementsForRep } = await import("../../server/salesAchievementStore");
    sale(closer.memberId, doorIds[2], at(30));
    sale(closer.memberId, doorIds[3], at(40));
    const awards = awardAchievementsForRep(1, closer.memberId, at(41).getTime());
    // The 2-rung is re-proposed and ignored by the index; only the 4 is new.
    expect(awards.filter(a => a.inserted).map(a => a.amountCents)).toEqual([5_000]);
    expect(ledgerCents(closer.memberId, "achv:")).toBe(7_500);
  });

  it("pays each rung once, however many times the day is re-evaluated", async () => {
    const { awardAchievementsForRep } = await import("../../server/salesAchievementStore");
    for (let i = 0; i < 5; i += 1) awardAchievementsForRep(1, closer.memberId, at(50).getTime());
    expect(ledgerCents(closer.memberId, "achv:")).toBe(7_500);
    expect(ledgerRows(closer.memberId, "achv:")).toBe(2);
  });

  it("skips a rep still inside their ramp window - they are on the other bonus", async () => {
    const { awardAchievementsForRep } = await import("../../server/salesAchievementStore");
    // Same four sales, a rep hired today. The ladder pays them nothing because
    // the ramp bonus is already paying them $50 a day to train.
    [10, 11, 12, 13].forEach((n, i) => sale(newHire.memberId, doorIds[n], at(10 + i * 10)));
    expect(awardAchievementsForRep(1, newHire.memberId, at(45).getTime())).toEqual([]);
    expect(ledgerCents(newHire.memberId, "achv:")).toBe(0);
  });

  it("shows the rep the next rung in sales, not percentages", async () => {
    const res = await request("/api/me/achievements", closer.session);
    const card = await res.json();
    expect(card.enabled).toBe(true);
    expect(card.dailySales).toBe(4);
    expect(card.earnedTodayCents).toBe(7_500);
    expect(card.headline).toContain("career sales");
  });
});

// ── The new-hire ramp bonus ──────────────────────────────────────────────────

describe("the ramp bonus pays a new hire to train", () => {
  it("reads tenure from the hire date, so a fresh rep is on day 1", async () => {
    const { tenureDay } = await import("../../server/rampBonusStore");
    expect(tenureDay(1, newHire.memberId, Date.now())).toBe(1);
  });

  // ── Which date is the hire date ───────────────────────────────────────────
  // The roster row is written when the agreement packet is ISSUED, so it is not
  // a start date: a rep who takes nine days to sign would burn nine days of a
  // fourteen-day window before they could log in once. The pipeline already
  // records the real moment.
  it("prefers portal activation over the roster row", async () => {
    const { hireDateFor, tenureDay } = await import("../../server/rampBonusStore");
    // Rostered 10 days ago (packet issued), activated 2 days ago (signed).
    const rostered = new Date(Date.now() - 10 * 86_400_000).toISOString();
    const activated = new Date(Date.now() - 2 * 86_400_000).toISOString();
    rawDb.prepare(`UPDATE team_members SET created_at = ? WHERE id = ?`).run(rostered, sprinter.memberId);
    rawDb.prepare(
      `INSERT INTO rep_applications
         (tenant_id, full_name, email, phone, city, zip, state, preferred_carriers,
          status, user_id, activated_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,'approved',?,?,?,?)`,
    ).run(1, "Bonus Sprinter", "sprinter@bonuses.example.test", "3365550100", "T", "27000", "NC",
          "kinetic", sprinter.userId, activated, rostered, activated);

    const hired = hireDateFor(1, sprinter.memberId);
    expect(hired.source).toBe("portal_activation");
    expect(hired.iso).toContain(activated.slice(0, 10));
    // Day 3, not day 11 — the eight days spent waiting on a signature are not
    // days on the job.
    expect(tenureDay(1, sprinter.memberId, Date.now())).toBe(3);
  });

  it("falls back to the last signature when nothing stamped an activation", async () => {
    const { hireDateFor } = await import("../../server/rampBonusStore");
    const rostered = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const signedAt = new Date(Date.now() - 4 * 86_400_000).toISOString();
    rawDb.prepare(`UPDATE team_members SET created_at = ? WHERE id = ?`).run(rostered, spoofer.memberId);
    // A `delivered` document is paperwork sitting in an inbox — only a
    // `completed` one is evidence of a start date.
    for (const [type, status, at] of [
      ["independent_contractor", "completed", new Date(Date.now() - 6 * 86_400_000).toISOString()],
      ["commission_agreement", "completed", signedAt],
      ["confidentiality", "delivered", null],
    ] as const) {
      rawDb.prepare(
        `INSERT INTO onboarding_signing_documents
           (record_id, tenant_id, rep_id, document_type, document_version, document_title,
            document_snapshot_json, content_sha256, status, signer_name, signer_email, completed_at)
         VALUES (?,?,?,?,'v1','T','{}','sha',?,?,?,?)`,
      ).run(`rec-${spoofer.memberId}-${type}`, 1, spoofer.memberId, type, status,
            "Bonus Spoofer", "spoofer@bonuses.example.test", at);
    }

    const hired = hireDateFor(1, spoofer.memberId);
    expect(hired.source).toBe("last_signature");
    // The LAST completed signature, not the first and not the undelivered one.
    expect(hired.iso).toContain(signedAt.slice(0, 10));
  });

  it("does not start the clock for a rep whose packet is still unsigned", async () => {
    const { hireDateFor, tenureDay, awardRampForRep } = await import("../../server/rampBonusStore");
    // Packet issued a week ago, nothing completed. They cannot even log in yet
    // (activation is what flips `active`), so the ramp has not begun — handing
    // them the roster date would open their app on day 8 of 14.
    const issued = new Date(Date.now() - 7 * 86_400_000).toISOString();
    rawDb.prepare(`UPDATE team_members SET created_at = ? WHERE id = ?`).run(issued, closer.memberId);
    rawDb.prepare(
      `INSERT INTO onboarding_signing_documents
         (record_id, tenant_id, rep_id, document_type, document_version, document_title,
          document_snapshot_json, content_sha256, status, signer_name, signer_email, completed_at)
       VALUES (?,?,?,'independent_contractor','v1','T','{}','sha','delivered',?,?,NULL)`,
    ).run(`rec-unsigned-${closer.memberId}`, 1, closer.memberId, "Bonus Closer", "closer@bonuses.example.test");

    const hired = hireDateFor(1, closer.memberId);
    expect(hired.source).toBe("not_activated");
    expect(hired.iso).toBeNull();
    expect(tenureDay(1, closer.memberId, Date.now())).toBe(0);
    // …and nothing pays while there is no clock.
    storage.upsertLessonComplete(closer.userId, 1, "m1l1", null);
    expect(awardRampForRep({ tenantId: 1, userId: closer.userId, repId: closer.memberId }, Date.now())
      .find(a => a.kind === "day")).toBeUndefined();
  });

  it("still gives a rep who predates the pipeline a window off the roster row", async () => {
    const { hireDateFor } = await import("../../server/rampBonusStore");
    const hired = hireDateFor(1, offliner.memberId);
    expect(hired.source).toBe("roster_created");
    expect(hired.iso).toBeTruthy();
  });

  it("tells the rep's card which clock the window is running on", async () => {
    const res = await request("/api/me/ramp-bonus", newHire.session);
    const card = await res.json();
    expect(card.hiredAt.source).toBe("roster_created");
    expect(card.hiredAt.iso).toBeTruthy();
  });

  it("pays a day-one hire who finished lessons with nothing left due", async () => {
    const { awardRampForRep } = await import("../../server/rampBonusStore");
    // The drill deck seeds from completed lessons, so day one is a lesson day.
    storage.upsertLessonComplete(newHire.userId, 1, "m1l1", null);

    const awards = awardRampForRep({ tenantId: 1, userId: newHire.userId, repId: newHire.memberId }, Date.now());
    const day = awards.find(a => a.kind === "day");
    expect(day?.amountCents).toBe(5_000);
    expect(day?.inserted).toBe(true);
    expect(ledgerCents(newHire.memberId, "ramp:")).toBe(5_000);
  });

  it("pays that day exactly once, however many review batches land", async () => {
    const { awardRampForRep } = await import("../../server/rampBonusStore");
    for (let i = 0; i < 4; i += 1) {
      awardRampForRep({ tenantId: 1, userId: newHire.userId, repId: newHire.memberId }, Date.now());
    }
    expect(ledgerCents(newHire.memberId, "ramp:")).toBe(5_000);
    expect(ledgerRows(newHire.memberId, "ramp:")).toBe(1);
  });

  it("does not pay a rep past the two-week window", async () => {
    const { awardRampForRep, tenureDay } = await import("../../server/rampBonusStore");
    // Backdate the hire date past the window — the only thing that changes.
    rawDb.prepare(`UPDATE team_members SET created_at = ? WHERE id = ?`)
      .run(new Date(Date.now() - 40 * 86_400_000).toISOString(), walker.memberId);
    expect(tenureDay(1, walker.memberId, Date.now())).toBeGreaterThan(14);

    storage.upsertLessonComplete(walker.userId, 1, "m1l1", null);
    const awards = awardRampForRep({ tenantId: 1, userId: walker.userId, repId: walker.memberId }, Date.now());
    expect(awards.find(a => a.kind === "day")).toBeUndefined();
    expect(ledgerCents(walker.memberId, "ramp:")).toBe(0);
  });

  it("pays the completion bonus once the whole curriculum is done", async () => {
    const { awardRampForRep, curriculumLessonCount } = await import("../../server/rampBonusStore");
    const { TRAINING_MODULES } = await import("../../shared/trainingContent");
    for (const m of TRAINING_MODULES) {
      for (const lesson of m.lessons) storage.upsertLessonComplete(newHire.userId, 1, lesson.id, null);
    }
    expect(curriculumLessonCount()).toBeGreaterThan(0);

    const awards = awardRampForRep({ tenantId: 1, userId: newHire.userId, repId: newHire.memberId }, Date.now());
    const done = awards.find(a => a.kind === "completion");
    // $50 for finishing, plus $50 for finishing inside the ramp window.
    expect(done?.amountCents).toBe(10_000);
    expect(ledgerCents(newHire.memberId, "ramp-complete:")).toBe(10_000);

    // …and never again.
    awardRampForRep({ tenantId: 1, userId: newHire.userId, repId: newHire.memberId }, Date.now());
    expect(ledgerRows(newHire.memberId, "ramp-complete:")).toBe(1);
  });

  it("shows the new hire their window and their progress", async () => {
    const res = await request("/api/me/ramp-bonus", newHire.session);
    const card = await res.json();
    expect(card.visible).toBe(true);
    expect(card.inWindow).toBe(true);
    expect(card.windowDays).toBe(14);
    expect(card.completion.paid).toBe(true);
  });
});

// ── The money path and the gates ─────────────────────────────────────────────

describe("the money lands on the commission statement", () => {
  it("an approved bonus is summed into the rep's pay week", async () => {
    const { sumWeekSpiffsByRep } = await import("../../server/hourlyPay");
    // The ledger books `earned`; a human approves before payroll sees it. That
    // approval gate is the backstop behind every anti-gaming rule above.
    rawDb.prepare(`UPDATE spiffs SET status = 'approved' WHERE rep_id = ? AND sale_ref LIKE 'doorday:%'`)
      .run(offliner.memberId);

    const weekStart = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const weekEnd = new Date(Date.now() + 86_400_000).toISOString();
    expect(sumWeekSpiffsByRep(1, weekStart, weekEnd).get(offliner.memberId)).toBe(5_000);
  });

  it("an unapproved bonus stays off payroll", async () => {
    const { sumWeekSpiffsByRep } = await import("../../server/hourlyPay");
    const weekStart = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const weekEnd = new Date(Date.now() + 86_400_000).toISOString();
    // The closer's achievement money is still `earned`, so it is not on the run.
    expect(sumWeekSpiffsByRep(1, weekStart, weekEnd).get(closer.memberId) ?? 0).toBe(0);
  });
});

describe("configuration is gated and tenant-scoped", () => {
  it("a rep cannot read or change any of the three configs", async () => {
    for (const path of ["/api/incentives/door-day", "/api/incentives/ramp", "/api/incentives/achievements"]) {
      expect((await request(path, closer.session)).status).toBe(403);
      expect((await put(path, closer.session, { enabled: false })).status).toBe(403);
    }
  });

  it("an admin can retune the door bonus, and the rep's card follows", async () => {
    const res = await put("/api/incentives/door-day", admin.session, {
      enabled: true, doors: 40, rewardCents: 3_000,
      minSpanMinutes: 120, maxPerRollingHour: 20, minGapSeconds: 30, voidOnTamper: true,
    });
    expect(res.status).toBe(200);
    const { config, exposure } = await res.json();
    expect(config.doors).toBe(40);
    expect(exposure.perRepCents).toBe(3_000);

    const card = await (await request("/api/me/door-day", sprinter.session)).json();
    expect(card.target).toBe(40);
    expect(card.rewardCents).toBe(3_000);
  });

  it("refuses a rule nobody could ever satisfy", async () => {
    const res = await put("/api/incentives/door-day", admin.session, {
      enabled: true, doors: 500, rewardCents: 5_000,
      minSpanMinutes: 180, maxPerRollingHour: 1, minGapSeconds: 20, voidOnTamper: true,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("cannot fit in a day");
  });

  it("refuses a bonus larger than any incentive should be", async () => {
    const res = await put("/api/incentives/ramp", admin.session, {
      enabled: true, windowDays: 14, rewardCents: 500_000,
      minCardsPerDay: 10, minLessonsPerDay: 1, minSpanMinutes: 5, requireQueueCleared: true,
      completionEnabled: true, completionRewardCents: 5_000, completionInWindowBonusCents: 5_000,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("$1,000");
  });

  it("one org's ladder does not touch another's", async () => {
    await put("/api/incentives/achievements", adminB.session, {
      enabled: true,
      daily: [{ sales: 3, rewardCents: 9_900 }],
      career: [{ sales: 10, rewardCents: 2_500 }],
      excludeRampReps: true, maxCentsPerRepPerDay: 20_000,
    });
    const mine = await (await request("/api/incentives/achievements", admin.session)).json();
    expect(mine.config.daily[0].sales).toBe(2);
    expect(mine.config.daily[0].rewardCents).toBe(2_500);
  });
});
