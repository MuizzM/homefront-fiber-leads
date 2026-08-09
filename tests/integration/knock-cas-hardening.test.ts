// KNOCK-CAS HARDENING regression tests — the 5-reviewer consensus wave:
//  C1  client knockedAt is clamped (forged-future/garbage can never poison the CAS)
//  C2  superseded is persisted on knock_log and returned on idempotent replay
//  C3  dedupe replay HEALS a mid-crash knock (money effects re-run idempotently)
//  C4  bulk-status stamps recency (a stale knock loses the CAS afterwards)
//  C5  POST /api/commissions on an existing pending returns {existed:true}, not a phantom create
//  C6  commission summary excludes 'superseded' rows
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let server: Server;
let baseUrl: string;
let storage: any;
let rawDb: any;

type Fixture = { userId: number; memberId: number; session: string };

function makePerson(name: string, loginRole: string, tenantId: number, memberRole = "rep"): Fixture {
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}@cas-hard.example.test`;
  const member = storage.createTeamMember({ name, email, role: memberRole, active: true, reportsToId: null, tenantId });
  const user = storage.createUser({ name, email, role: loginRole, active: true, tenantId, teamMemberId: member.id });
  return { userId: user.id, memberId: member.id, session: storage.createSession(user.id).id };
}

let leadSeq = 0;
function makeLead(tenantId: number, assignedRepId: number) {
  leadSeq += 1;
  const lead = storage.createLead({
    address: `${7000 + leadSeq} Cas Ave`, city: "Durham", state: "NC", zip: "27701",
    tenantId, leadStatus: "prospect",
  });
  storage.updateLead(lead.id, { assignedRepId });
  return storage.getLeadById(lead.id);
}

function request(path: string, sessionId: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-session-id": sessionId, ...(init.headers ?? {}) },
  });
}

let knockSeq = 0;
async function knock(leadId: number, session: string, outcome: string, knockedAt: string, extra: Record<string, unknown> = {}) {
  knockSeq += 1;
  const res = await request(`/api/leads/${leadId}/knock`, session, {
    method: "POST",
    body: JSON.stringify({ outcome, knockedAt, clientId: `cas-${knockSeq}`, ...extra }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

const pendingFor = (leadId: number) =>
  (rawDb.prepare("SELECT * FROM commissions WHERE lead_id = ? AND status = 'pending'").all(leadId) as any[]);

let mgr1: Fixture, rep1: Fixture, rep6: Fixture, rep7: Fixture, rep8: Fixture, rep9: Fixture;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-cas-hard-"));
  process.env.NODE_ENV = "test";
  const storageModule = await import("../../server/storage");
  storageModule.runMigrations();
  storage = storageModule.storage;
  ({ rawDb } = await import("../../server/db"));

  mgr1 = makePerson("Cas Mgr", "manager", 1);
  rep1 = makePerson("Cas Rep", "rep", 1);
  rep6 = makePerson("Cas Rep Six", "rep", 1);
  rep7 = makePerson("Cas Rep Seven", "rep", 1);
  rep8 = makePerson("Cas Rep Eight", "rep", 1);
  rep9 = makePerson("Cas Rep Nine", "rep", 1);

  const { registerRoutes, registerSaasRoutes } = await import("../../server/routes");
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  server = createServer(app);
  registerRoutes(server, app);
  registerSaasRoutes(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no bind");
  baseUrl = `http://127.0.0.1:${address.port}`;

  // Flat rate so sold knocks book a real pending commission.
  storage.createCommissionRate({
    name: "CAS Flat", calcType: "flat", ratePerSale: 100, percentage: 0, tiers: null,
    role: "rep", repId: null, isActive: true, effectiveFrom: "2020-01-01", effectiveTo: null,
    version: 1, updatedBy: "test", tenantId: 1,
  });
});

afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

describe("C1 - client knockedAt is clamped, never trusted for CAS", () => {
  it("a forged-future knockedAt cannot poison the lead", async () => {
    const lead = makeLead(1, rep1.memberId);
    // Attacker: sold knock dated in the future — the old exploit froze the lead forever.
    const evil = await knock(lead.id, rep1.session, "sold", "2099-01-01T00:00:00.000Z");
    expect(evil.status).toBe(201);
    const stored = rawDb.prepare("SELECT last_outcome_at FROM leads WHERE id = ?").get(lead.id) as any;
    // Clamped to ~server time, NOT 2099:
    expect(stored.last_outcome_at.startsWith("2099")).toBe(false);
    // A legitimate correction now WINS (no freeze):
    const fix = await knock(lead.id, rep1.session, "not_interested", new Date(Date.now() + 1000). toISOString());
    expect(fix.status).toBe(201);
    expect(fix.body.superseded).toBeFalsy(); // knock rows carry the superseded column (0 = applied)
    const after = storage.getLeadById(lead.id);
    expect(after.leadStatus).toBe("not_interested");
    expect(pendingFor(lead.id).length).toBe(0); // reversal worked — no phantom payout
  });

  it("garbage knockedAt falls back to server time", async () => {
    const lead = makeLead(1, rep1.memberId);
    const r = await knock(lead.id, rep1.session, "interested", "zzz-not-a-date");
    expect(r.status).toBe(201);
    const stored = rawDb.prepare("SELECT last_outcome_at FROM leads WHERE id = ?").get(lead.id) as any;
    expect(stored.last_outcome_at).not.toBe("zzz-not-a-date");
  });
});

describe("C2 - superseded persisted + replay marker", () => {
  it("the stale knock row carries superseded=1 and idempotent replay returns it", async () => {
    const lead = makeLead(1, rep1.memberId);
    const t2 = new Date(Date.now() + 60_000).toISOString();
    const t1 = new Date(Date.now() - 60_000).toISOString();
    const newer = await knock(lead.id, rep1.session, "not_interested", t2);
    expect(newer.status).toBe(201);
    const staleClient = `cas-stale-${lead.id}`;
    const res1 = await request(`/api/leads/${lead.id}/knock`, rep1.session, {
      method: "POST",
      body: JSON.stringify({ outcome: "sold", knockedAt: t1, clientId: staleClient }),
    });
    expect(res1.status).toBe(200);
    expect((await res1.json() as any).superseded).toBe(true);
    const row = rawDb.prepare("SELECT superseded FROM knock_log WHERE client_id = ?").get(staleClient) as any;
    expect(row.superseded).toBe(1);
    // Idempotent replay of the SAME knock returns the persisted marker:
    const res2 = await request(`/api/leads/${lead.id}/knock`, rep1.session, {
      method: "POST",
      body: JSON.stringify({ outcome: "sold", knockedAt: t1, clientId: staleClient }),
    });
    const body2 = (await res2.json()) as any;
    expect(body2.deduped).toBe(true);
    expect(body2.superseded).toBe(true);
  });
});

describe("C3 - dedupe replay: heal repairs, never resurrects, never bypasses the clamp", () => {
  it("heal repairs a knock whose money effects are missing", async () => {
    const lead = makeLead(1, rep1.memberId);
    const client = `cas-heal-${lead.id}`;
    const t = new Date().toISOString();
    const r1 = await request(`/api/leads/${lead.id}/knock`, rep1.session, {
      method: "POST",
      body: JSON.stringify({ outcome: "sold", knockedAt: t, clientId: client }),
    });
    expect(r1.status).toBe(201);
    // Simulate the strand (effects missing on an applied knock).
    rawDb.prepare("UPDATE commissions SET status = 'superseded' WHERE lead_id = ?").run(lead.id);
    expect(pendingFor(lead.id).length).toBe(0);
    // Replay the same clientId — the heal re-runs the FULL bundle idempotently.
    const r2 = await request(`/api/leads/${lead.id}/knock`, rep1.session, {
      method: "POST",
      body: JSON.stringify({ outcome: "sold", knockedAt: t, clientId: client }),
    });
    const body2 = (await r2.json()) as any;
    expect(body2.deduped).toBe(true);
    expect(pendingFor(lead.id).length).toBe(1); // healed — exactly one, not two
  });

  it("B1: heal NEVER resurrects a commission on a door whose sale was reversed", async () => {
    const lead = makeLead(1, rep1.memberId);
    const client = `cas-b1-${lead.id}`;
    const t1 = new Date(Date.now() - 60_000).toISOString();
    // Sold knock applies (commission booked).
    const sold = await request(`/api/leads/${lead.id}/knock`, rep1.session, {
      method: "POST",
      body: JSON.stringify({ outcome: "sold", knockedAt: t1, clientId: client }),
    });
    expect(sold.status).toBe(201);
    expect(pendingFor(lead.id).length).toBe(1);
    // A NEWER not_interested wins the CAS → sale reversed, commission removed.
    const t2 = new Date(Date.now() + 60_000).toISOString();
    const fix = await knock(lead.id, rep1.session, "not_interested", t2);
    expect(fix.status).toBe(201);
    expect(pendingFor(lead.id).length).toBe(0);
    // Ordinary offline-queue retry of the ORIGINAL sold knock: must re-supersede, book NOTHING.
    const replay = await request(`/api/leads/${lead.id}/knock`, rep1.session, {
      method: "POST",
      body: JSON.stringify({ outcome: "sold", knockedAt: t1, clientId: client }),
    });
    expect(replay.status).toBe(200);
    const body = (await replay.json()) as any;
    expect(body.deduped).toBe(true);
    expect(body.superseded).toBe(true);
    expect(pendingFor(lead.id).length).toBe(0); // nothing resurrected
    expect(storage.getLeadById(lead.id).leadStatus).toBe("not_interested");
  });

  it("B2: the clamp cannot be bypassed through the dedupe replay", async () => {
    const lead = makeLead(1, rep1.memberId);
    const t = new Date(Date.now() + 60_000).toISOString();
    await knock(lead.id, rep1.session, "not_interested", t);
    const client = `cas-b2-${lead.id}`;
    // First pass: forged 2099 knock is clamped → LOSES the CAS.
    const first = await request(`/api/leads/${lead.id}/knock`, rep1.session, {
      method: "POST",
      body: JSON.stringify({ outcome: "sold", knockedAt: "2099-01-01T00:00:00.000Z", clientId: client }),
    });
    expect(first.status).toBe(200);
    expect((await first.json() as any).superseded).toBe(true);
    // The row stored the CLAMPED timestamp (storage-level clamp) — replay can't smuggle 2099 back.
    const stored = rawDb.prepare("SELECT knocked_at FROM knock_log WHERE client_id = ?").get(client) as any;
    expect(stored.knocked_at.startsWith("2099")).toBe(false);
    // Replay: also superseded; the lead stays not_interested; nothing books.
    const replay = await request(`/api/leads/${lead.id}/knock`, rep1.session, {
      method: "POST",
      body: JSON.stringify({ outcome: "sold", knockedAt: "2099-01-01T00:00:00.000Z", clientId: client }),
    });
    expect(replay.status).toBe(200);
    expect((await replay.json() as any).superseded).toBe(true);
    expect(storage.getLeadById(lead.id).leadStatus).toBe("not_interested");
    expect(pendingFor(lead.id).length).toBe(0);
  });
});

describe("C4 - bulk-status advances the recency clock", () => {
  it("a stale knock loses the CAS after a manager bulk mark", async () => {
    const lead = makeLead(1, rep1.memberId);
    // Manager bulk-marks the door not_interested NOW:
    const bulk = await request(`/api/leads/bulk-status`, mgr1.session, {
      method: "POST",
      body: JSON.stringify({ leadIds: [lead.id], outcome: "not_interested" }),
    });
    expect(bulk.status).toBe(200);
    const stamped = rawDb.prepare("SELECT last_outcome_at FROM leads WHERE id = ?").get(lead.id) as any;
    expect(stamped.last_outcome_at).toBeTruthy();
    // Stale knock (older knockedAt) flushes late — must LOSE:
    const stale = await knock(lead.id, rep1.session, "sold", new Date(Date.now() - 3_600_000).toISOString());
    expect(stale.status).toBe(200);
    expect(stale.body.superseded).toBe(true);
    expect(storage.getLeadById(lead.id).leadStatus).toBe("not_interested");
    expect(pendingFor(lead.id).length).toBe(0);
  });
});

describe("C5 - POST /api/commissions is honest about pre-existing pending", () => {
  it("returns {existed:true} instead of a phantom create", async () => {
    const lead = makeLead(1, rep1.memberId);
    const sold = await knock(lead.id, rep1.session, "sold", new Date().toISOString());
    expect(sold.status).toBe(201);
    expect(pendingFor(lead.id).length).toBe(1);
    // Manager tries to create a manual commission on the same lead:
    const res = await request(`/api/commissions`, mgr1.session, {
      method: "POST",
      body: JSON.stringify({ repId: rep1.memberId, leadId: lead.id, amount: 7777, saleDate: "2026-07-28" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.existed).toBe(true);
    expect(body.amount).toBe(100); // the EXISTING row's amount, not 7777
    expect(pendingFor(lead.id).length).toBe(1); // no duplicate booked
    const audit = rawDb.prepare(
      "SELECT action FROM activity_log WHERE action = 'commission.duplicate_skipped' ORDER BY id DESC LIMIT 1",
    ).get() as any;
    expect(audit).toBeTruthy();
  });
});

describe("C6 - summary excludes superseded rows", () => {
  it("superseded commissions do not inflate totals", async () => {
    // Fresh rep: baseline is exactly zero, so any superseded contribution is visible.
    const lead = makeLead(1, rep6.memberId);
    await knock(lead.id, rep6.session, "sold", new Date().toISOString());
    const before = await request(`/api/commissions/summary`, mgr1.session);
    const beforeRow = ((await before.json()) as any[]).find((r: any) => r.repId === rep6.memberId);
    expect(beforeRow.total).toBe(100);
    rawDb.prepare("UPDATE commissions SET status = 'superseded' WHERE lead_id = ?").run(lead.id);
    const res = await request(`/api/commissions/summary`, mgr1.session);
    const body = (await res.json()) as any[];
    const row = body.find((r: any) => r.repId === rep6.memberId);
    expect(row.total).toBe(0);
    expect(row.sales).toBe(0);
  });
});

describe("M7 - leaderboard excludes superseded sold knocks", () => {
  it("a superseded sold knock counts zero on the leaderboard", async () => {
    const lead = makeLead(1, rep7.memberId);
    const t2 = new Date(Date.now() + 60_000).toISOString();
    await knock(lead.id, rep7.session, "not_interested", t2);
    const t1 = new Date(Date.now() - 60_000).toISOString();
    const stale = await knock(lead.id, rep7.session, "sold", t1);
    expect(stale.body.superseded).toBe(true);
    const rows = rawDb.prepare(
      "SELECT SUM(CASE WHEN k.outcome = 'sold' THEN 1 ELSE 0 END) AS sales FROM knock_log k WHERE k.rep_id = ? AND k.superseded = 0",
    ).get(rep7.memberId) as any;
    expect(rows.sales).toBe(0);
  });
});

describe("M8 - a corrected sale leaves the leaderboard", () => {
  // The reported bug. M7 covers a sold knock that lost the CAS at write time
  // (superseded = 1). This is the OTHER order — the one reps actually hit:
  // mark sold by accident, then correct it with a NEWER knock. The sold row
  // keeps superseded = 0 (it did not lose any race when written), so a
  // flag-only leaderboard kept showing the sale forever while the commission
  // correctly reversed. The board and the pay disagreed, and the board was the
  // one lying.
  const board = () => storage.getLeaderboard(undefined, 1);
  const rowFor = (memberId: number) => board().find((r: any) => r.rep.id === memberId) as any;

  it("marking sold then correcting removes the sale but keeps both knocks", async () => {
    const lead = makeLead(1, rep8.memberId);
    const accidental = await knock(lead.id, rep8.session, "sold", new Date(Date.now() - 60_000).toISOString());
    expect(accidental.status).toBe(201);              // applied, NOT superseded
    expect(rowFor(rep8.memberId).sales).toBe(1);      // board shows the sale

    const fix = await knock(lead.id, rep8.session, "not_interested", new Date().toISOString());
    expect(fix.status).toBe(201);

    const row = rowFor(rep8.memberId);
    expect(row.sales).toBe(0);        // the phantom sale is gone…
    expect(row.knocks).toBe(2);       // …but the door-work history is not
    // The sold row itself is untouched history — the fix is read-side.
    const soldRow = rawDb.prepare(
      "SELECT superseded FROM knock_log WHERE lead_id = ? AND outcome = 'sold'").get(lead.id) as any;
    expect(soldRow.superseded).toBe(0);
  });

  it("'already a customer' correction also clears the sale", async () => {
    const lead = makeLead(1, rep8.memberId);
    await knock(lead.id, rep8.session, "sold", new Date(Date.now() - 60_000).toISOString());
    const fix = await knock(lead.id, rep8.session, "already_customer", new Date().toISOString());
    expect(fix.status).toBe(201);
    expect(rowFor(rep8.memberId).sales).toBe(0);
    // And the disposition landed as designed: shared status, distinct outcome.
    const fresh = storage.getLeadById(lead.id) as any;
    expect(fresh.leadStatus).toBe("not_interested");
    expect(fresh.lastOutcome).toBe("already_customer");
  });

  it("a manager status edit (no knock row) also clears the sale", async () => {
    // The second correction path: PATCH /api/leads/:id writes no knock, so
    // knock recency alone would still count the sold knock. The lead's own
    // status is the second gate.
    const lead = makeLead(1, rep9.memberId);
    await knock(lead.id, rep9.session, "sold", new Date().toISOString());
    expect(rowFor(rep9.memberId).sales).toBe(1);
    const res = await request(`/api/leads/${lead.id}`, mgr1.session, {
      method: "PATCH",
      body: JSON.stringify({ leadStatus: "prospect" }),
    });
    expect(res.status).toBe(200);
    expect(rowFor(rep9.memberId).sales).toBe(0);
  });

  it("a real, uncorrected sale still counts exactly once", async () => {
    const lead = makeLead(1, rep9.memberId);
    await knock(lead.id, rep9.session, "sold", new Date().toISOString());
    expect(rowFor(rep9.memberId).sales).toBe(1);
  });
});

describe("Central mark appears in History", () => {
  it("central-disposition records a 'Central Admin' status event, NOT a rep-credited knock", async () => {
    const lead = makeLead(1, rep1.memberId);
    const res = await request(`/api/leads/${lead.id}/central-disposition`, mgr1.session, {
      method: "POST",
      body: JSON.stringify({ outcome: "not_home" }),
    });
    expect(res.status).toBe(200);
    // A central mark must NOT write a knock_log row (that credited a rep and
    // showed a rep's name in history / counted on the leaderboard). It lands as
    // an explicit-actor lead_events status change instead.
    const knocks = rawDb.prepare("SELECT id FROM knock_log WHERE lead_id = ?").all(lead.id) as any[];
    expect(knocks.length).toBe(0);
    const evt = rawDb.prepare(
      "SELECT type, actor, detail FROM lead_events WHERE lead_id = ? AND type = 'status_change' ORDER BY id DESC LIMIT 1",
    ).get(lead.id) as any;
    expect(evt.actor).toBe("Central Admin");
    const detail = JSON.parse(evt.detail);
    expect(detail.source).toBe("central");
    expect(detail.outcome).toBe("not_home");
    expect(detail.actorUserId).toBe(mgr1.userId);   // real actor preserved in the event
    const fresh = storage.getLeadById(lead.id);
    expect(fresh.leadStatus).toBe("prospect");       // not_home is non-terminal
    expect(fresh.lastOutcome).toBe("not_home");
  });
});
