// SALE → COMMISSION PIPELINE, end to end, driven through the real HTTP routes.
//
// Owner's requirement, stated plainly: "when a rep marks a sale it should go to
// their commission, at the rate they are on, with status pending/approved/paid."
// This file is the executable version of that sentence. Nothing here asserts on
// mock data — every commission row is minted by a real POST /api/leads/:id/knock
// and every state change goes through PATCH /api/commissions/:id.
//
// What is pinned:
//   1. one sold knock → exactly ONE pending commission, credited to the knocker
//   2. the rate is FROZEN onto the row (structureId/structureVersion/calcType/
//      amount) — editing the plan afterwards never rewrites a booked payout
//   3. pickActiveStructure picks the right plan for that rep/role/date
//   4. pending→approved→paid is a MANAGER move; a rep cannot approve or pay
//      their own money; approvedBy / paidDate are recorded
//   5. tenant B can never read or mutate tenant A's commissions
//   6. idempotency — replays and re-flips must not mint a second payout
//
// One known DEFECT is documented as an `it.fails` at the bottom rather than
// asserted-as-correct: it will start failing loudly the day it is fixed.
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

type Person = { userId: number; memberId: number; session: string };

/** A login + its team-member row. `memberRole` is what pickActiveStructure reads
 *  for role-scoped plans; `loginRole` is what the capability middleware reads. */
function person(name: string, loginRole: string, tenantId = 1, memberRole = loginRole): Person {
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}@commission-pipeline.example.test`;
  const member = storage.createTeamMember({ name, email, role: memberRole, active: true, reportsToId: null, tenantId } as any);
  const user = storage.createUser({ name, email, role: loginRole, active: true, tenantId, teamMemberId: member.id } as any);
  return { userId: user.id, memberId: member.id, session: storage.createSession(user.id).id };
}

function req(path: string, session: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-session-id": session, "x-csrf-token": session, ...(init.headers ?? {}) },
  });
}

let leadSeq = 0;
function makeLead(tenantId: number, assignedRepId: number) {
  leadSeq += 1;
  const lead = storage.createLead({
    address: `${4000 + leadSeq} Commission Way`, city: "Durham", state: "NC", zip: "27701",
    tenantId, leadStatus: "prospect",
  } as any);
  storage.updateLead(lead.id, { assignedRepId } as any);
  return storage.getLeadById(lead.id)!;
}

// Monotonically increasing, always in the PAST — the route clamps a future
// knockedAt to server time, and the outcome CAS is recency-ordered, so a
// hand-rolled clock keeps every knock in this file applying rather than
// superseding for reasons unrelated to what is under test.
let tsSeq = 0;
const nextTs = () => new Date(Date.now() - 3_600_000 + tsSeq++ * 1_000).toISOString();

let knockSeq = 0;
async function knock(
  leadId: number, session: string, outcome: string,
  extra: Record<string, unknown> = {},
): Promise<{ status: number; body: any }> {
  knockSeq += 1;
  const res = await req(`/api/leads/${leadId}/knock`, session, {
    method: "POST",
    body: JSON.stringify({ outcome, knockedAt: nextTs(), clientId: `cp-${knockSeq}`, ...extra }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

/** Ground truth, straight from the table — not from a route's projection. */
const commissionsFor = (leadId: number): any[] =>
  rawDb.prepare("SELECT * FROM commissions WHERE lead_id = ? ORDER BY id").all(leadId);

const today = () => new Date().toISOString().slice(0, 10);

/** Create a commission structure through the REAL route (tenant comes from the
 *  caller's session — never client-supplied). */
async function createRate(session: string, body: Record<string, unknown>): Promise<any> {
  const res = await req("/api/commission-rates", session, { method: "POST", body: JSON.stringify(body) });
  expect(res.status, `rate create failed: ${await res.clone().text()}`).toBe(200);
  return await res.json();
}

/** The commission list as a given session SEES it (the rep-facing surface). */
async function listCommissions(session: string, query = ""): Promise<{ status: number; rows: any[] }> {
  const res = await req(`/api/commissions${query}`, session);
  const body = res.status === 200 ? await res.json() : [];
  return { status: res.status, rows: Array.isArray(body) ? body : [] };
}

const TENANT_A = 1;
let TENANT_B = 0;
let TENANT_C = 0;

let mgrA: Person, leadRoleA: Person, repA: Person, repFreeze: Person, repExpired: Person;
let mgrB: Person, repB: Person;
let repC: Person;

let baseRateA: any;     // tenant A, role-scoped "rep", $100 flat
let freezeRate: any;    // tenant A, rep-specific to repFreeze, $150 flat
let expiredRate: any;   // tenant A, rep-specific to repExpired, $777, window closed in 2020
let rateB: any;         // tenant B, role-scoped "rep", $55 flat

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-commission-pipeline-"));
  process.env.NODE_ENV = "test";
  const mod = await import("../../server/storage");
  mod.runMigrations(); // creates + adopts the default tenant (id 1)
  storage = mod.storage;
  ({ rawDb } = await import("../../server/db"));

  TENANT_B = storage.createTenant({
    slug: "commission-pipeline-b", companyName: "Org B", ownerName: "B Owner",
    ownerEmail: "owner-b@commission-pipeline.example.test", brandName: "Org B",
  } as any).id;
  TENANT_C = storage.createTenant({
    slug: "commission-pipeline-c", companyName: "Org C", ownerName: "C Owner",
    ownerEmail: "owner-c@commission-pipeline.example.test", brandName: "Org C",
  } as any).id;

  mgrA = person("Pipe Mgr A", "manager", TENANT_A);
  leadRoleA = person("Pipe Lead A", "team_lead", TENANT_A);
  repA = person("Pipe Rep A", "rep", TENANT_A);
  repFreeze = person("Pipe Rep Freeze", "rep", TENANT_A);
  repExpired = person("Pipe Rep Expired", "rep", TENANT_A);
  mgrB = person("Pipe Mgr B", "manager", TENANT_B);
  repB = person("Pipe Rep B", "rep", TENANT_B);
  repC = person("Pipe Rep C", "rep", TENANT_C);

  const { registerRoutes, registerSaasRoutes } = await import("../../server/routes");
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  server = createServer(app);
  registerRoutes(server, app);
  registerSaasRoutes(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const a = server.address();
  if (!a || typeof a === "string") throw new Error("no bind");
  baseUrl = `http://127.0.0.1:${a.port}`;

  // Plans are published through the route, by a real manager, in a real org.
  baseRateA = await createRate(mgrA.session, {
    name: "A Standard Rep", calcType: "flat", ratePerSale: 100,
    role: "rep", effectiveFrom: "2020-01-01",
  });
  freezeRate = await createRate(mgrA.session, {
    name: "A Freeze Rep Plan", calcType: "flat", ratePerSale: 150,
    repId: repFreeze.memberId, effectiveFrom: "2020-01-01",
  });
  expiredRate = await createRate(mgrA.session, {
    name: "A Lapsed Plan", calcType: "flat", ratePerSale: 777,
    repId: repExpired.memberId, effectiveFrom: "2020-01-01", effectiveTo: "2020-12-31",
  });
  rateB = await createRate(mgrB.session, {
    name: "B Standard Rep", calcType: "flat", ratePerSale: 55,
    role: "rep", effectiveFrom: "2020-01-01",
  });
  // Tenant C deliberately has NO plans — a sale there must book nothing.
});

afterAll(async () => {
  if (server) await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. A sold knock books exactly one pending commission for the knocking rep.
// ─────────────────────────────────────────────────────────────────────────────
describe("marking a sale mints exactly one pending commission for that rep", () => {
  it("books one row at the rep's rate, pending, credited to the knocker", async () => {
    const lead = makeLead(TENANT_A, repA.memberId);
    const sold = await knock(lead.id, repA.session, "sold");
    expect(sold.status).toBe(201);

    const rows = commissionsFor(lead.id);
    expect(rows).toHaveLength(1);
    const c = rows[0];
    expect(c.rep_id).toBe(repA.memberId);
    expect(c.tenant_id).toBe(TENANT_A);
    expect(c.status).toBe("pending");
    expect(c.amount).toBe(100);
    expect(c.knock_id).toBe(sold.body.id);
    expect(c.sale_date).toBe(today());
    expect(c.approved_by).toBeNull();
    expect(c.paid_date).toBeNull();
    expect(c.revision).toBe(1);
  });

  it("shows up on the rep's OWN commission feed", async () => {
    const lead = makeLead(TENANT_A, repA.memberId);
    await knock(lead.id, repA.session, "sold");
    const booked = commissionsFor(lead.id)[0];

    const { status, rows } = await listCommissions(repA.session);
    expect(status).toBe(200);
    const mine = rows.find((r) => r.id === booked.id);
    expect(mine, "a rep must be able to see their own earning").toBeDefined();
    expect(mine.status).toBe("pending");
    expect(mine.amount).toBe(100);
    expect(mine.calcType).toBe("flat");
    expect(mine.structureVersion).toBe(1);
    expect(mine.address).toBe(lead.address);
  });

  it("books nothing for an outcome that is not a sale", async () => {
    const lead = makeLead(TENANT_A, repA.memberId);
    expect((await knock(lead.id, repA.session, "interested")).status).toBe(201);
    expect(commissionsFor(lead.id)).toHaveLength(0);
  });

  it("credits the KNOCKER even when the body names a different rep", async () => {
    // A rep may only ever credit themselves — otherwise a rep could mint a
    // payout onto a colleague (or forge one for themselves off someone's door).
    const lead = makeLead(TENANT_A, repA.memberId);
    await knock(lead.id, repA.session, "sold", { repId: repFreeze.memberId });
    const rows = commissionsFor(lead.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].rep_id).toBe(repA.memberId);
    expect(rows[0].amount).toBe(100); // repA's plan, not repFreeze's $150
  });

  it("books nothing when no structure covers the rep — never a phantom payout", async () => {
    // Tenant C has no plans at all. A commission the server cannot explain must
    // not exist.
    const lead = makeLead(TENANT_C, repC.memberId);
    expect((await knock(lead.id, repC.session, "sold")).status).toBe(201);
    expect(commissionsFor(lead.id)).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. pickActiveStructure — the right plan for that rep / role / date.
// ─────────────────────────────────────────────────────────────────────────────
describe("the structure in effect for that rep on that date is the one that scores", () => {
  it("a rep-specific plan overrides the role plan", async () => {
    const lead = makeLead(TENANT_A, repFreeze.memberId);
    await knock(lead.id, repFreeze.session, "sold");
    const c = commissionsFor(lead.id)[0];
    expect(c.amount).toBe(150);
    expect(c.structure_id).toBe(freezeRate.id);
  });

  it("a plan whose window has closed is ignored, and the role plan takes over", async () => {
    const lead = makeLead(TENANT_A, repExpired.memberId);
    await knock(lead.id, repExpired.session, "sold");
    const c = commissionsFor(lead.id)[0];
    expect(c.structure_id).not.toBe(expiredRate.id);
    expect(c.structure_id).toBe(baseRateA.id);
    expect(c.amount).toBe(100);
  });

  it("scores with the KNOCK's org plans, never another org's", async () => {
    const lead = makeLead(TENANT_B, repB.memberId);
    await knock(lead.id, repB.session, "sold");
    const c = commissionsFor(lead.id)[0];
    expect(c.tenant_id).toBe(TENANT_B);
    expect(c.structure_id).toBe(rateB.id);
    expect(c.amount).toBe(55); // B's rate, not A's $100
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The rate is FROZEN onto the row. This is the audit property that matters.
// ─────────────────────────────────────────────────────────────────────────────
describe("the rate is frozen onto the commission at sale time", () => {
  let frozenId = 0;
  let frozenLeadId = 0;

  it("stamps structureId, structureVersion, calcType and amount at sale time", async () => {
    const lead = makeLead(TENANT_A, repFreeze.memberId);
    frozenLeadId = lead.id;
    await knock(lead.id, repFreeze.session, "sold");
    const c = commissionsFor(lead.id)[0];
    frozenId = c.id;
    expect(c.structure_id).toBe(freezeRate.id);
    expect(c.structure_version).toBe(1);
    expect(c.calc_type).toBe("flat");
    expect(c.amount).toBe(150);
  });

  it("editing the plan AFTERWARDS does not rewrite the booked commission", async () => {
    expect(frozenId, "the previous spec must have booked a row").toBeGreaterThan(0);

    const patched = await req(`/api/commission-rates/${freezeRate.id}`, mgrA.session, {
      method: "PATCH", body: JSON.stringify({ ratePerSale: 999 }),
    });
    expect(patched.status).toBe(200);
    const republished = await patched.json() as any;
    expect(republished.ratePerSale).toBe(999);
    expect(republished.version).toBe(2); // an edit PUBLISHES a new version

    // Re-read the row that was already booked — through the route a rep/manager
    // actually reads, and from the table underneath it.
    const { rows } = await listCommissions(mgrA.session);
    const served = rows.find((r) => r.id === frozenId);
    expect(served, "the booked commission must still be served").toBeDefined();
    expect(served.amount).toBe(150);
    expect(served.structureVersion).toBe(1);

    const stored = commissionsFor(frozenLeadId)[0];
    expect(stored.amount).toBe(150);
    expect(stored.structure_id).toBe(freezeRate.id);
    expect(stored.structure_version).toBe(1);
    expect(stored.calc_type).toBe("flat");
  });

  it("a NEW sale after the edit books at the NEW rate and version", async () => {
    // Guards the freeze assertion above against being vacuously true: the read
    // path IS live, it just does not rewrite history.
    const lead = makeLead(TENANT_A, repFreeze.memberId);
    await knock(lead.id, repFreeze.session, "sold");
    const c = commissionsFor(lead.id)[0];
    expect(c.amount).toBe(999);
    expect(c.structure_version).toBe(2);
    expect(c.structure_id).toBe(freezeRate.id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. pending → approved → paid, and who is allowed to move it.
// ─────────────────────────────────────────────────────────────────────────────
describe("status transitions are a management action, not a rep action", () => {
  /** A freshly booked pending commission owned by repA. */
  async function freshPending(): Promise<any> {
    const lead = makeLead(TENANT_A, repA.memberId);
    await knock(lead.id, repA.session, "sold");
    const rows = commissionsFor(lead.id);
    expect(rows).toHaveLength(1);
    return rows[0];
  }

  const patchCommission = (id: number, session: string, body: Record<string, unknown>) =>
    req(`/api/commissions/${id}`, session, { method: "PATCH", body: JSON.stringify(body) });

  it("a rep CANNOT approve their own commission", async () => {
    const c = await freshPending();
    const res = await patchCommission(c.id, repA.session, {
      expectedRevision: c.revision, expectedStatus: "pending", status: "approved",
    });
    expect(res.status).toBe(403);
    const after = commissionsFor(c.lead_id)[0];
    expect(after.status).toBe("pending");
    expect(after.approved_by).toBeNull();
    expect(after.revision).toBe(1);
  });

  it("a rep CANNOT mark their own commission paid", async () => {
    const c = await freshPending();
    const res = await patchCommission(c.id, repA.session, {
      expectedRevision: c.revision, expectedStatus: "pending", status: "paid", paidDate: "2026-01-15",
    });
    expect(res.status).toBe(403);
    expect(commissionsFor(c.lead_id)[0].status).toBe("pending");
  });

  it("a team lead cannot either — booking money starts at manager", async () => {
    const c = await freshPending();
    const res = await patchCommission(c.id, leadRoleA.session, {
      expectedRevision: c.revision, expectedStatus: "pending", status: "approved",
    });
    expect(res.status).toBe(403);
    expect(commissionsFor(c.lead_id)[0].status).toBe("pending");
  });

  it("a manager moves pending → approved and is recorded as the approver", async () => {
    const c = await freshPending();
    const res = await patchCommission(c.id, mgrA.session, {
      expectedRevision: c.revision, expectedStatus: "pending", status: "approved",
    });
    expect(res.status).toBe(200);
    const after = commissionsFor(c.lead_id)[0];
    expect(after.status).toBe("approved");
    expect(after.approved_by).toBe(mgrA.userId);
    expect(after.paid_date).toBeNull();
    expect(after.revision).toBe(2);
  });

  it("a manager moves approved → paid, recording the paid date and keeping the approver", async () => {
    const c = await freshPending();
    const approved = await patchCommission(c.id, mgrA.session, {
      expectedRevision: c.revision, expectedStatus: "pending", status: "approved",
    });
    expect(approved.status).toBe(200);
    const mid = commissionsFor(c.lead_id)[0];

    const paid = await patchCommission(c.id, mgrA.session, {
      expectedRevision: mid.revision, expectedStatus: "approved", status: "paid", paidDate: "2026-01-15",
    });
    expect(paid.status).toBe(200);
    const after = commissionsFor(c.lead_id)[0];
    expect(after.status).toBe("paid");
    expect(after.paid_date).toBe("2026-01-15");
    expect(after.approved_by).toBe(mgrA.userId);
    expect(after.revision).toBe(3);
  });

  it("paid is terminal — it cannot be walked back to approved", async () => {
    const c = await freshPending();
    const a = await patchCommission(c.id, mgrA.session, {
      expectedRevision: c.revision, expectedStatus: "pending", status: "approved",
    });
    expect(a.status).toBe(200);
    const mid = commissionsFor(c.lead_id)[0];
    const p = await patchCommission(c.id, mgrA.session, {
      expectedRevision: mid.revision, expectedStatus: "approved", status: "paid", paidDate: "2026-01-15",
    });
    expect(p.status).toBe(200);
    const done = commissionsFor(c.lead_id)[0];

    const back = await patchCommission(c.id, mgrA.session, {
      expectedRevision: done.revision, expectedStatus: "paid", status: "approved",
    });
    expect(back.status).toBe(409);
    expect(commissionsFor(c.lead_id)[0].status).toBe("paid");
  });

  it("pending cannot skip straight to paid", async () => {
    const c = await freshPending();
    const res = await patchCommission(c.id, mgrA.session, {
      expectedRevision: c.revision, expectedStatus: "pending", status: "paid", paidDate: "2026-01-15",
    });
    expect(res.status).toBe(409);
    expect((await res.json() as any).code).toBe("ILLEGAL_TRANSITION");
    expect(commissionsFor(c.lead_id)[0].status).toBe("pending");
  });

  it("a stale revision loses instead of silently overwriting", async () => {
    const c = await freshPending();
    const first = await patchCommission(c.id, mgrA.session, {
      expectedRevision: c.revision, expectedStatus: "pending", status: "approved",
    });
    expect(first.status).toBe(200);
    // Second actor still holding revision 1.
    const stale = await patchCommission(c.id, mgrA.session, {
      expectedRevision: c.revision, expectedStatus: "pending", status: "disputed",
    });
    expect(stale.status).toBe(409);
    expect((await stale.json() as any).code).toBe("STALE_VERSION");
    expect(commissionsFor(c.lead_id)[0].status).toBe("approved");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Tenant isolation.
// ─────────────────────────────────────────────────────────────────────────────
describe("one org can never read or mutate another org's commissions", () => {
  let aCommission: any;

  beforeAll(async () => {
    const lead = makeLead(TENANT_A, repA.memberId);
    await knock(lead.id, repA.session, "sold");
    aCommission = commissionsFor(lead.id)[0];
    expect(aCommission.tenant_id).toBe(TENANT_A);
  });

  it("a rep in org B never sees an org A row on their feed", async () => {
    const { status, rows } = await listCommissions(repB.session);
    expect(status).toBe(200);
    expect(rows.some((r) => r.id === aCommission.id)).toBe(false);
    expect(rows.every((r) => r.repId === repB.memberId)).toBe(true);
  });

  it("a MANAGER in org B — who can read every commission in their org — sees none of A's", async () => {
    const { status, rows } = await listCommissions(mgrB.session);
    expect(status).toBe(200);
    expect(rows.length).toBeGreaterThan(0); // B genuinely has commissions
    expect(rows.some((r) => r.id === aCommission.id)).toBe(false);
    expect(rows.some((r) => r.repId === repA.memberId)).toBe(false);
  });

  it("the ?repId filter is not a cross-tenant IDOR", async () => {
    const { status } = await listCommissions(mgrB.session, `?repId=${repA.memberId}`);
    expect(status).toBe(404);
  });

  it("a manager in org B cannot mutate an org A commission (404, not 403)", async () => {
    const res = await req(`/api/commissions/${aCommission.id}`, mgrB.session, {
      method: "PATCH",
      body: JSON.stringify({ expectedRevision: aCommission.revision, expectedStatus: "pending", status: "approved" }),
    });
    expect(res.status).toBe(404);
    expect(commissionsFor(aCommission.lead_id)[0].status).toBe("pending");
  });

  it("a rep in org B cannot mutate an org A commission", async () => {
    const res = await req(`/api/commissions/${aCommission.id}`, repB.session, {
      method: "PATCH",
      body: JSON.stringify({ expectedRevision: aCommission.revision, expectedStatus: "pending", status: "paid", paidDate: "2026-01-15" }),
    });
    expect(res.status).toBe(403);
    expect(commissionsFor(aCommission.lead_id)[0].status).toBe("pending");
  });

  it("org B's structures are invisible to org A and vice versa", async () => {
    const bRates = await (await req("/api/commission-rates", mgrB.session)).json() as any[];
    expect(bRates.some((r) => r.id === baseRateA.id)).toBe(false);
    const aRates = await (await req("/api/commission-rates", mgrA.session)).json() as any[];
    expect(aRates.some((r) => r.id === rateB.id)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Idempotency — a retry is not a second payday.
// ─────────────────────────────────────────────────────────────────────────────
describe("a sale cannot be paid twice", () => {
  it("replaying the SAME knock (offline retry, same clientId) books nothing new", async () => {
    const lead = makeLead(TENANT_A, repA.memberId);
    const clientId = `cp-replay-${lead.id}`;
    const at = nextTs();
    const first = await req(`/api/leads/${lead.id}/knock`, repA.session, {
      method: "POST", body: JSON.stringify({ outcome: "sold", knockedAt: at, clientId }),
    });
    expect(first.status).toBe(201);
    expect(commissionsFor(lead.id)).toHaveLength(1);

    const replay = await req(`/api/leads/${lead.id}/knock`, repA.session, {
      method: "POST", body: JSON.stringify({ outcome: "sold", knockedAt: at, clientId }),
    });
    expect(replay.status).toBe(200);
    expect((await replay.json() as any).deduped).toBe(true);
    expect(commissionsFor(lead.id)).toHaveLength(1);
  });

  it("a SECOND sold knock on the same door (fresh clientId) still yields one commission", async () => {
    const lead = makeLead(TENANT_A, repA.memberId);
    await knock(lead.id, repA.session, "sold");
    await knock(lead.id, repA.session, "sold");
    const rows = commissionsFor(lead.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
  });

  it("un-marking a sale pulls the PENDING commission, and re-marking books exactly one", async () => {
    const lead = makeLead(TENANT_A, repA.memberId);
    await knock(lead.id, repA.session, "sold");
    expect(commissionsFor(lead.id)).toHaveLength(1);

    await knock(lead.id, repA.session, "not_interested");
    expect(commissionsFor(lead.id)).toHaveLength(0);

    await knock(lead.id, repA.session, "sold");
    const rows = commissionsFor(lead.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
  });

  it("a stale (superseded) sold knock books nothing", async () => {
    const lead = makeLead(TENANT_A, repA.memberId);
    const fresh = new Date(Date.now() - 60_000).toISOString();
    const stale = new Date(Date.now() - 600_000).toISOString();
    const a = await req(`/api/leads/${lead.id}/knock`, repA.session, {
      method: "POST", body: JSON.stringify({ outcome: "not_interested", knockedAt: fresh, clientId: `cp-stale-a-${lead.id}` }),
    });
    expect(a.status).toBe(201);
    const b = await req(`/api/leads/${lead.id}/knock`, repA.session, {
      method: "POST", body: JSON.stringify({ outcome: "sold", knockedAt: stale, clientId: `cp-stale-b-${lead.id}` }),
    });
    expect(b.status).toBe(200);
    expect((await b.json() as any).superseded).toBe(true);
    expect(commissionsFor(lead.id)).toHaveLength(0);
  });

  // ── KNOWN DEFECT ───────────────────────────────────────────────────────────
  // The uniqueness guarantee behind "one sale, one payout" is the partial index
  // idx_commissions_tenant_lead_pending, which is scoped `WHERE status =
  // 'pending'`. Once a manager APPROVES the commission, the row leaves that
  // index — and a subsequent sold knock on the same door inserts a SECOND,
  // fully payable commission. The rep is paid twice for one sale.
  //
  // FIXED. The auto-create site now looks for a commission on this door in any
  // LIVE status (pending / approved / paid) and books nothing when one exists.
  // "superseded" and "disputed" are deliberately not live — those are the states
  // a replacement is legitimately allowed to follow.
  //
  // This spec was written as `it.fails` while the defect stood, so that fixing
  // it would break the suite loudly rather than let the bug freeze in. It is now
  // an ordinary regression guard.
  it("re-marking sold after approval does not mint a second payable commission", async () => {
    const lead = makeLead(TENANT_A, repA.memberId);
    await knock(lead.id, repA.session, "sold");
    const booked = commissionsFor(lead.id)[0];

    const approve = await req(`/api/commissions/${booked.id}`, mgrA.session, {
      method: "PATCH",
      body: JSON.stringify({ expectedRevision: booked.revision, expectedStatus: "pending", status: "approved" }),
    });
    expect(approve.status).toBe(200);

    await knock(lead.id, repA.session, "sold");

    const rows = commissionsFor(lead.id);
    // What SHOULD hold: one sale, one commission.
    expect(rows).toHaveLength(1);
  });

  it("keeps the approved row and its money, rather than replacing it", async () => {
    // The companion to the spec above. Suppressing the duplicate must not also
    // discard the original: the surviving row is the APPROVED one, the sale is
    // still worth exactly one commission, and the approval is not silently
    // rolled back to pending by a later knock.
    const lead = makeLead(TENANT_A, repA.memberId);
    await knock(lead.id, repA.session, "sold");
    const booked = commissionsFor(lead.id)[0];
    await req(`/api/commissions/${booked.id}`, mgrA.session, {
      method: "PATCH",
      body: JSON.stringify({ expectedRevision: booked.revision, expectedStatus: "pending", status: "approved" }),
    });
    await knock(lead.id, repA.session, "sold");

    const rows = commissionsFor(lead.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("approved");
    // One door, one sale, one payout — the whole point of the guard.
    expect(rows.reduce((s, r) => s + r.amount, 0)).toBe(100);
  });
});

// ── A paid door must still be able to earn again ────────────────────────────
// The double-pay guard originally blocked on pending | approved | PAID. That
// looked obviously right — a paid sale is credited, do not credit it twice —
// and it was worse than the bug it replaced.
//
// `paid` is TERMINAL in LEGAL_TRANSITIONS (paid → paid only). Neither escape the
// guard's comment named is reachable: paid→disputed is 409 ILLEGAL_TRANSITION,
// and "superseded" is written only by a one-time migration and is not a legal
// current status. So once a door's commission was paid, that door could never
// earn again. A genuine re-sale — new customer at the same address, or the same
// customer after a cancellation — booked NOTHING, returned HTTP 200, logged a
// line nobody reads, and no manager action could unblock it.
//
// Silent non-pay is worse than double-pay: double-pay is visible and clawable.
describe("a door that has already been paid can still earn again", () => {
  it("books a new commission after the previous one is paid", async () => {
    const lead = makeLead(TENANT_A, repA.memberId);
    await knock(lead.id, repA.session, "sold");
    const first = commissionsFor(lead.id)[0];

    const approve = await req(`/api/commissions/${first.id}`, mgrA.session, {
      method: "PATCH",
      body: JSON.stringify({ expectedRevision: first.revision, expectedStatus: "pending", status: "approved" }),
    });
    expect(approve.status).toBe(200);
    const approved = commissionsFor(lead.id)[0];
    const pay = await req(`/api/commissions/${first.id}`, mgrA.session, {
      method: "PATCH",
      body: JSON.stringify({ expectedRevision: approved.revision, expectedStatus: "approved", status: "paid", paidDate: "2026-02-01" }),
    });
    expect(pay.status).toBe(200);

    // The door sells again. This must produce a SECOND entitlement.
    await knock(lead.id, repA.session, "sold");

    const rows = commissionsFor(lead.id);
    expect(rows, "a paid door was permanently barred from earning").toHaveLength(2);
    expect(rows.map((r) => r.status).sort()).toEqual(["paid", "pending"]);
  });

  it("still blocks a duplicate while the first is only APPROVED", async () => {
    // The guard the fix narrowed must not be lost with it: an UNPAID
    // entitlement on this door still blocks. Asserted behaviourally rather than
    // by reading the constant, because importing server/storage statically runs
    // migrations before beforeAll sets DATA_DIR and silently skips the file.
    const lead = makeLead(TENANT_A, repA.memberId);
    await knock(lead.id, repA.session, "sold");
    const first = commissionsFor(lead.id)[0];
    await req(`/api/commissions/${first.id}`, mgrA.session, {
      method: "PATCH",
      body: JSON.stringify({ expectedRevision: first.revision, expectedStatus: "pending", status: "approved" }),
    });

    await knock(lead.id, repA.session, "sold");

    expect(commissionsFor(lead.id)).toHaveLength(1);
  });
});
