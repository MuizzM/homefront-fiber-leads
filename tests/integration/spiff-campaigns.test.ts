// A SPIFF campaign is a public promise that pays real money, so the properties
// worth an integration test are the ones that cost you if they break:
//
//   1. A campaign can only be launched by someone who may configure comp, and
//      only inside their own org. Another tenant's campaign reads as 404.
//   2. An award is booked EXACTLY ONCE. A retried knock, a double-tapped
//      submit, or an offline-queue replay must not pay twice — the idempotency
//      key is a UNIQUE index, and this is where that claim gets checked.
//   3. The campaign cap is a real ceiling, not a label. Once the org has paid
//      out the cap, nothing further is booked.
//   4. A rep only sees campaigns they are eligible for, with progress that
//      agrees with what actually got paid.
//   5. Awards land in the EXISTING spiffs ledger, so they inherit approval and
//      payroll rather than needing a parallel pipeline.
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
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}@campaigns.example.test`;
  const member = storage.createTeamMember({ name, email, role: memberRole, active: true, tenantId } as any);
  const user = storage.createUser({ name, email, role: loginRole, active: true, tenantId, teamMemberId: member.id } as any);
  return { userId: user.id, memberId: member.id, session: storage.createSession(user.id).id };
}

const request = (path: string, sessionId: string, init: RequestInit = {}) =>
  fetch(`${baseUrl}${path}`, { ...init, headers: { "content-type": "application/json", "x-session-id": sessionId, ...init.headers } });
const post = (path: string, session: string, body?: unknown) =>
  request(path, session, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

let TENANT_B = 0;
let admin: Fixture, rep: Fixture, otherRep: Fixture, plainRep: Fixture, adminB: Fixture;

/** Log `n` knocks straight into knock_log for `rep`, all landing this morning in
 *  the org's local day. Going through the store rather than the HTTP route keeps
 *  the counter fixture independent of lead assignment/geo policy — those have
 *  their own suites, and this one is about the money.
 *
 *  Each knock lands on its OWN door and carries a `verified` verdict, because
 *  the campaign counter is distinct GPS-confirmed doors — 40 taps on one house,
 *  or 40 doors the geo check could not confirm, are both worth zero. That rule
 *  has its own suite (tests/integration/knock-milestones.test.ts); here it just
 *  has to be satisfied so the contest logic is what is under test. */
let seedBatch = 0;
/**
 * `hourLocal` means the hour in the ORG'S timezone, not the process's.
 *
 * This used to be `new Date(); at.setHours(hourLocal, 0, 0, 0)`, and setHours
 * resolves against the CONTAINER's clock — which is UTC in CI and in the dev
 * image. The campaign counters, correctly, measure "today" in the tenant's
 * timezone (America/New_York by default).
 *
 * Between 20:00 and midnight Eastern — i.e. 00:00–04:00 UTC — those two
 * disagree about the DATE: setHours(9) produced tomorrow-09:00 UTC, which is
 * tomorrow 05:00 Eastern, so every seeded knock landed on the wrong local day
 * and the trigger counted zero. The suite passed all afternoon and failed at
 * night, which is the worst possible shape for a flake.
 *
 * The timezone-aware anchor fixed the DATE, but not the TIME OF DAY: between
 * local midnight and `hourLocal` (00:00–09:00 Eastern — 04:00–13:00 UTC) a
 * "9am today" stamp is hours in the FUTURE, and the counter's upper bound is
 * `min(cutoff, now)`, so every trigger read zero and no award booked. The
 * stamps must satisfy dayStart <= stamp < now at ANY run time, so the anchor
 * is clamped into today-and-past and the knocks walk BACKWARD one second each
 * from it. (Residual: a run starting in the first ~n seconds of the local day
 * cannot seed n knocks that are simultaneously today and past — a ~10-second
 * daily window, down from 9.5 hours.)
 */
function seedKnocks(repId: number, _unusedLeadId: number, n: number, hourLocal = 9): void {
  const tz = DEFAULT_WORKWEEK.timezone;
  const nowMs = Date.now();
  const { y, mo, d } = localYmdParts(nowMs, tz);
  const dayStartMs = localWallToUtcMs(y, mo, d, 0, 0, tz);
  const anchorMs = Math.min(
    Math.max(localWallToUtcMs(y, mo, d, hourLocal, 0, tz), dayStartMs + n * 1_000),
    nowMs - 1_000,
  );
  const batch = seedBatch += 1;
  for (let i = 0; i < n; i += 1) {
    const lead = storage.createLead({
      address: `${i + 1} Campaign Way Unit ${batch}`, city: "Testville", state: "NC", zip: "27000",
      leadStatus: "new", tenantId: 1,
    } as any);
    rawDb.prepare(
      `INSERT INTO knock_log (lead_id, rep_id, outcome, was_home, knocked_at, tenant_id, verification_status, superseded)
       VALUES (?,?,?,?,?,?,'verified',0)`,
    ).run(lead.id, repId, "not_home", 0, new Date(anchorMs - i * 1_000).toISOString(), 1);
  }
}

let leadId = 0;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-campaigns-"));
  process.env.NODE_ENV = "test";
  const storageModule = await import("../../server/storage");
  storageModule.runMigrations();
  storage = storageModule.storage;
  ({ rawDb } = await import("../../server/db"));

  TENANT_B = storage.createTenant({
    slug: "campaigns-b", companyName: "Org B", ownerName: "B Owner",
    ownerEmail: "owner-b@campaigns.example.test", brandName: "Org B",
  } as any).id;

  admin = makePerson("Camp Admin", "admin", 1, "manager");
  rep = makePerson("Camp Rep", "rep", 1, "rep");
  otherRep = makePerson("Camp Other", "rep", 1, "rep");
  plainRep = makePerson("Camp Plain", "rep", 1, "rep");
  adminB = makePerson("Camp Admin Bee", "admin", TENANT_B, "manager");

  const lead = storage.createLead({
    address: "1 Campaign Way", city: "Testville", state: "NC", zip: "27000",
    leadStatus: "new", tenantId: 1,
  } as any);
  leadId = lead.id;

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

describe("launching a campaign", () => {
  it("a rep cannot launch one", async () => {
    const res = await post("/api/spiff-campaigns", rep.session, {
      name: "Rep's own contest", startsAtMs: Date.now(), endsAtMs: Date.now() + 3_600_000,
      trigger: { kind: "per_sale" }, rewardCents: 5_000,
    });
    expect(res.status).toBe(403);
  });

  it("rejects a campaign the shared validator would refuse", async () => {
    // Same rule the launcher form enforces — a four-figure per-award spiff is a
    // fat finger, not an incentive.
    const res = await post("/api/spiff-campaigns", admin.session, {
      name: "Oops", startsAtMs: Date.now(), endsAtMs: Date.now() + 3_600_000,
      trigger: { kind: "per_sale" }, rewardCents: 500_000,
    });
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toMatch(/\$1,000/);
  });

  it("an admin launches one and every rep in the org can see it", async () => {
    const res = await post("/api/spiff-campaigns", admin.session, {
      name: "Morning grind", description: "Pure effort.",
      startsAtMs: Date.now() - 60_000, endsAtMs: Date.now() + 6 * 3_600_000,
      trigger: { kind: "knocks_by_time", knocks: 10, byHourLocal: 23 },
      rewardCents: 5_000,
    });
    expect(res.status).toBe(201);
    const { campaign } = await res.json() as any;
    expect(campaign.status).toBe("live");

    const mine = await request("/api/me/campaigns", rep.session);
    expect(mine.status).toBe(200);
    const cards = (await mine.json() as any).campaigns;
    expect(cards.map((c: any) => c.name)).toContain("Morning grind");
    // Nothing knocked yet: progress reads honestly rather than optimistically.
    const card = cards.find((c: any) => c.name === "Morning grind");
    expect(card.progress.met).toBe(false);
    expect(card.progress.current).toBe(0);
    expect(card.progress.target).toBe(10);
  });

  it("a targeted campaign is invisible to reps who are not on it", async () => {
    const res = await post("/api/spiff-campaigns", admin.session, {
      name: "Closers only", startsAtMs: Date.now() - 60_000, endsAtMs: Date.now() + 6 * 3_600_000,
      trigger: { kind: "per_sale" }, rewardCents: 2_500,
      eligibleRepIds: [otherRep.memberId],
    });
    expect(res.status).toBe(201);

    const names = async (s: string) =>
      ((await (await request("/api/me/campaigns", s)).json()) as any).campaigns.map((c: any) => c.name);
    expect(await names(otherRep.session)).toContain("Closers only");
    expect(await names(rep.session)).not.toContain("Closers only");
  });

  it("another tenant cannot see or touch this org's campaigns", async () => {
    const list = await request("/api/spiff-campaigns", adminB.session);
    expect(list.status).toBe(200);
    expect((await list.json() as any).campaigns).toHaveLength(0);

    // A foreign id is a 404, never a 403 — an out-of-scope resource must not
    // confirm it exists.
    const mine = await request("/api/spiff-campaigns", admin.session);
    const someId = (await mine.json() as any).campaigns[0].id;
    expect((await post(`/api/spiff-campaigns/${someId}/pause`, adminB.session)).status).toBe(404);
    expect((await request(`/api/spiff-campaigns/${someId}/liability`, adminB.session)).status).toBe(404);
  });
});

describe("awarding - the money path", () => {
  it("pays once when the trigger is met, and NEVER twice for the same day", async () => {
    const { awardCampaignsForRep, createCampaign } = await import("../../server/spiffCampaignStore");
    const campaign = createCampaign(1, admin.userId, {
      name: "Idempotency check",
      startsAtMs: Date.now() - 3_600_000, endsAtMs: Date.now() + 6 * 3_600_000,
      trigger: { kind: "knocks_by_time", knocks: 5, byHourLocal: 23 },
      rewardCents: 5_000, nowMs: Date.now(),
    });
    seedKnocks(plainRep.memberId, leadId, 5);

    const first = awardCampaignsForRep(1, plainRep.memberId, Date.now())
      .filter(a => a.campaignId === campaign.id);
    expect(first).toHaveLength(1);
    expect(first[0].inserted).toBe(true);
    expect(first[0].amountCents).toBe(5_000);

    // Three more evaluations — a retry, a replayed offline knock, a second
    // server. All of them see the trigger as still met, and none of them pay.
    for (let i = 0; i < 3; i += 1) {
      const again = awardCampaignsForRep(1, plainRep.memberId, Date.now())
        .filter(a => a.campaignId === campaign.id);
      expect(again[0]?.inserted).toBe(false);
    }

    const row = rawDb.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents),0) AS s FROM spiffs WHERE campaign_id = ? AND rep_id = ?`,
    ).get(campaign.id, plainRep.memberId) as any;
    expect(row.n).toBe(1);
    expect(row.s).toBe(5_000);
  });

  it("the campaign cap is a real ceiling - it trims, then stops", async () => {
    const { awardCampaignsForRep, createCampaign, campaignLiability } =
      await import("../../server/spiffCampaignStore");
    // $50 reward, $75 total cap: the first rep takes $50, the second takes the
    // $25 that is left (trimmed, not refused), and nobody after that is paid.
    const campaign = createCampaign(1, admin.userId, {
      name: "Capped contest",
      startsAtMs: Date.now() - 3_600_000, endsAtMs: Date.now() + 6 * 3_600_000,
      trigger: { kind: "knocks_by_time", knocks: 3, byHourLocal: 23 },
      rewardCents: 5_000, campaignCapCents: 7_500, nowMs: Date.now(),
    });
    seedKnocks(rep.memberId, leadId, 3);
    seedKnocks(otherRep.memberId, leadId, 3);

    const a = awardCampaignsForRep(1, rep.memberId, Date.now()).find(x => x.campaignId === campaign.id);
    const b = awardCampaignsForRep(1, otherRep.memberId, Date.now()).find(x => x.campaignId === campaign.id);
    expect(a?.amountCents).toBe(5_000);
    // Trimmed to what is left rather than refused outright — a rep $25 from the
    // ceiling gets $25, which is how the board stays honest.
    expect(b?.amountCents).toBe(2_500);

    // plainRep already has knocks from the previous test, so they clear the bar
    // too — and get nothing, because the cap is spent.
    const c = awardCampaignsForRep(1, plainRep.memberId, Date.now()).find(x => x.campaignId === campaign.id);
    expect(c).toBeUndefined();

    const liability = campaignLiability(1, campaign.id);
    expect(liability.awardedCents).toBe(7_500);
    expect(liability.remainingCents).toBe(0);
    expect(liability.awardCount).toBe(2);
  });

  it("an award is an ordinary spiff - it rides the existing approval ledger", async () => {
    const { createCampaign, awardCampaignsForRep } = await import("../../server/spiffCampaignStore");
    const campaign = createCampaign(1, admin.userId, {
      name: "Ledger check",
      startsAtMs: Date.now() - 3_600_000, endsAtMs: Date.now() + 6 * 3_600_000,
      trigger: { kind: "knocks_by_time", knocks: 3, byHourLocal: 23 },
      rewardCents: 3_000, nowMs: Date.now(),
    });
    awardCampaignsForRep(1, rep.memberId, Date.now());

    const spiff = rawDb.prepare(
      `SELECT * FROM spiffs WHERE campaign_id = ? AND rep_id = ?`,
    ).get(campaign.id, rep.memberId) as any;
    expect(spiff).toBeTruthy();
    expect(spiff.status).toBe("earned");
    expect(spiff.reason).toContain("Ledger check");

    // …and it shows up on the rep's normal spiff feed, not a parallel surface.
    const mine = await request("/api/spiffs/mine", rep.session);
    expect(mine.status).toBe(200);
    const feed = await mine.json() as any;
    expect(feed.spiffs.some((s: any) => s.id === spiff.id)).toBe(true);

    // The admin approves it through the SAME route every other spiff uses.
    expect((await post(`/api/spiffs/${spiff.id}/approve`, admin.session)).status).toBe(200);
    const after = rawDb.prepare(`SELECT status FROM spiffs WHERE id = ?`).get(spiff.id) as any;
    expect(after.status).toBe("approved");
  });

  it("a paused campaign stops paying, and resuming starts it again", async () => {
    const { createCampaign, awardCampaignsForRep } = await import("../../server/spiffCampaignStore");
    const campaign = createCampaign(1, admin.userId, {
      name: "Pausable",
      startsAtMs: Date.now() - 3_600_000, endsAtMs: Date.now() + 6 * 3_600_000,
      trigger: { kind: "knocks_by_time", knocks: 3, byHourLocal: 23 },
      rewardCents: 1_000, nowMs: Date.now(),
    });

    expect((await post(`/api/spiff-campaigns/${campaign.id}/pause`, admin.session)).status).toBe(200);
    expect(awardCampaignsForRep(1, otherRep.memberId, Date.now())
      .find(a => a.campaignId === campaign.id)).toBeUndefined();
    // …and it drops off the rep's board while paused, rather than sitting there
    // as a promise that silently no longer pays.
    const cards = ((await (await request("/api/me/campaigns", otherRep.session)).json()) as any).campaigns;
    expect(cards.map((c: any) => c.name)).not.toContain("Pausable");

    expect((await post(`/api/spiff-campaigns/${campaign.id}/resume`, admin.session)).status).toBe(200);
    expect(awardCampaignsForRep(1, otherRep.memberId, Date.now())
      .find(a => a.campaignId === campaign.id)?.inserted).toBe(true);
  });

  it("cancelling is terminal - a withdrawn promise cannot flicker back on", async () => {
    const { createCampaign } = await import("../../server/spiffCampaignStore");
    const campaign = createCampaign(1, admin.userId, {
      name: "Withdrawn",
      startsAtMs: Date.now() - 3_600_000, endsAtMs: Date.now() + 6 * 3_600_000,
      trigger: { kind: "per_sale" }, rewardCents: 1_000, nowMs: Date.now(),
    });
    expect((await post(`/api/spiff-campaigns/${campaign.id}/cancel`, admin.session)).status).toBe(200);
    const resumed = await post(`/api/spiff-campaigns/${campaign.id}/resume`, admin.session);
    expect(resumed.status).toBe(200);
    expect((await resumed.json() as any).campaign.status).toBe("cancelled");
  });
});

describe("progress the rep sees agrees with what gets paid", () => {
  // The board is honest if a card that says MET turns into money on the rep's
  // very next knock. It is NOT a bug for a met card to be unpaid before then —
  // the award books when the rep acts, not when the query is read — so the
  // invariant is stated across an award pass rather than at an arbitrary
  // instant. The only legitimate way a met card stays unpaid afterwards is an
  // exhausted campaign cap, which is a ceiling the manager set on purpose.
  it("every met card turns into money on the next knock (or is cap-blocked)", async () => {
    const { awardCampaignsForRep, campaignLiability } = await import("../../server/spiffCampaignStore");

    const before = ((await (await request("/api/me/campaigns", rep.session)).json()) as any).campaigns;
    const met = before.filter((c: any) => c.progress.met);
    expect(met.length).toBeGreaterThan(0); // the assertion below would be vacuous otherwise

    awardCampaignsForRep(1, rep.memberId, Date.now()); // …the rep knocks

    for (const card of met) {
      const row = rawDb.prepare(
        `SELECT COALESCE(SUM(amount_cents),0) AS s FROM spiffs WHERE campaign_id = ? AND rep_id = ?`,
      ).get(card.id, rep.memberId) as any;
      const capped = campaignLiability(1, card.id).remainingCents === 0;
      expect(row.s > 0 || capped, `campaign ${card.id} (${card.name}) read as met but paid nothing`).toBe(true);
    }

    // …and the card's own earned figure matches the ledger it claims to reflect.
    const after = ((await (await request("/api/me/campaigns", rep.session)).json()) as any).campaigns;
    for (const card of after) {
      const row = rawDb.prepare(
        `SELECT COALESCE(SUM(amount_cents),0) AS s FROM spiffs WHERE campaign_id = ? AND rep_id = ?`,
      ).get(card.id, rep.memberId) as any;
      expect(card.earnedCents).toBe(row.s);
    }
  });
});
