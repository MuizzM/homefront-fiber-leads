// MONEY-PLANE regression tests — verified defect board:
//  P0-2  PATCH /api/commissions/:id is tenant-walled (404 across orgs).
//  P0-3  commission_rates are per-org: CRUD scoped, POST repId validated, and
//        the sold-knock auto-commission scores with ONLY the knock's org's plans.
//  P0-4  /api/commissions/summary is tenant-scoped.
//  P0-6  saleAmount in the knock body is ignored (no rep-fabricated payouts).
//  P1-1  a stale offline knock (older knockedAt) loses the outcome CAS: no
//        status flip, no sale reversal, no commission removal → superseded marker.
//  P1-2  duplicate sold knocks on one lead produce exactly ONE pending commission.
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
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}@money-lane.example.test`;
  const member = storage.createTeamMember({
    name, email, role: memberRole, active: true, reportsToId: null, tenantId,
  } as any);
  const user = storage.createUser({
    name, email, role: loginRole, active: true, tenantId, teamMemberId: member.id,
  } as any);
  return { userId: user.id, memberId: member.id, session: storage.createSession(user.id).id };
}

let TENANT_B = 0;
let leadSeq = 0;
function makeLead(tenantId: number, assignedRepId: number) {
  leadSeq += 1;
  const lead = storage.createLead({
    address: `${9000 + leadSeq} Money Ln`, city: "Durham", state: "NC", zip: "27701",
    tenantId, leadStatus: "prospect",
  } as any);
  storage.updateLead(lead.id, { assignedRepId } as any);
  return storage.getLeadById(lead.id)!;
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
    body: JSON.stringify({ outcome, knockedAt, clientId: `ml-${knockSeq}`, ...extra }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

const pendingFor = (leadId: number) =>
  (rawDb.prepare("SELECT * FROM commissions WHERE lead_id = ? AND status = 'pending'").all(leadId) as any[]);

let mgr1: Fixture, rep1: Fixture, rep3: Fixture; // tenant 1 (default org)
let mgr2: Fixture, rep2: Fixture;                // tenant B

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-money-lane-"));
  process.env.NODE_ENV = "test";
  const storageModule = await import("../../server/storage");
  storageModule.runMigrations(); // creates + adopts the default tenant (id 1)
  storage = storageModule.storage;
  ({ rawDb } = await import("../../server/db"));

  TENANT_B = storage.createTenant({
    slug: "money-lane-b", companyName: "Org B", ownerName: "B Owner",
    ownerEmail: "owner-b@money-lane.example.test", brandName: "Org B",
  } as any).id;

  mgr1 = makePerson("Money Mgr One", "manager", 1);
  rep1 = makePerson("Money Rep One", "rep", 1);
  rep3 = makePerson("Money Rep Three", "rep", 1);
  mgr2 = makePerson("Money Mgr Two", "manager", TENANT_B);
  rep2 = makePerson("Money Rep Two", "rep", TENANT_B);

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
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

describe("P0-2 commission PATCH is tenant-walled", () => {
  it("a manager cannot PATCH another tenant's commission (404), own tenant works", async () => {
    const c = storage.createCommission({
      repId: rep2.memberId, leadId: null, amount: 100, saleDate: "2026-01-01",
      status: "pending", approvedBy: null, paidDate: null, notes: null,
    } as any);
    expect(c.tenantId).toBe(TENANT_B);

    const cross = await request(`/api/commissions/${c.id}`, mgr1.session, {
      method: "PATCH", body: JSON.stringify({ status: "approved" }),
    });
    expect(cross.status).toBe(404);
    // Untouched by the cross-tenant attempt.
    expect(storage.getCommissionById(c.id)!.status).toBe("pending");

    const own = await request(`/api/commissions/${c.id}`, mgr2.session, {
      method: "PATCH", body: JSON.stringify({ status: "approved" }),
    });
    expect(own.status).toBe(200);
    expect(storage.getCommissionById(c.id)!.status).toBe("approved");

    // Storage layer: the tenant predicate is on the UPDATE itself.
    expect(storage.updateCommission(c.id, { status: "paid" }, 1)).toBeUndefined();
    expect(storage.updateCommission(c.id, { status: "paid" }, TENANT_B)?.status).toBe("paid");
  });

  it("P0-4: earnings summary is scoped to the caller's org", async () => {
    const s1 = await (await request("/api/commissions/summary", mgr1.session)).json() as any[];
    const s2 = await (await request("/api/commissions/summary", mgr2.session)).json() as any[];
    expect(s1.some(r => r.repId === rep1.memberId)).toBe(true);
    expect(s1.some(r => r.repId === rep2.memberId)).toBe(false);
    expect(s2.some(r => r.repId === rep2.memberId)).toBe(true);
    expect(s2.some(r => r.repId === rep1.memberId)).toBe(false);
  });
});

describe("P0-3 commission_rates are per-org", () => {
  let rateA = 0, rateB = 0;

  it("POST stamps the caller's tenant; GET is scoped; cross-tenant PATCH 404s; cross-tenant repId 404s", async () => {
    const postA = await request("/api/commission-rates", mgr1.session, {
      method: "POST", body: JSON.stringify({ name: "Org A Flat", calcType: "flat", ratePerSale: 111 }),
    });
    expect(postA.status).toBe(200);
    const a = await postA.json() as any;
    rateA = a.id;
    expect(a.tenantId).toBe(1);

    const postB = await request("/api/commission-rates", mgr2.session, {
      method: "POST", body: JSON.stringify({ name: "Org B Rich", calcType: "flat", ratePerSale: 999, role: "rep" }),
    });
    expect(postB.status).toBe(200);
    const b = await postB.json() as any;
    rateB = b.id;
    expect(b.tenantId).toBe(TENANT_B);

    const listA = await (await request("/api/commission-rates", mgr1.session)).json() as any[];
    const listB = await (await request("/api/commission-rates", mgr2.session)).json() as any[];
    expect(listA.some(r => r.id === rateA)).toBe(true);
    expect(listA.some(r => r.id === rateB)).toBe(false);
    expect(listB.some(r => r.id === rateB)).toBe(true);
    expect(listB.some(r => r.id === rateA)).toBe(false);

    const crossPatch = await request(`/api/commission-rates/${rateA}`, mgr2.session, {
      method: "PATCH", body: JSON.stringify({ ratePerSale: 1 }),
    });
    expect(crossPatch.status).toBe(404);

    const badRep = await request("/api/commission-rates", mgr1.session, {
      method: "POST", body: JSON.stringify({ name: "IDOR", calcType: "flat", ratePerSale: 5, repId: rep2.memberId }),
    });
    expect(badRep.status).toBe(404);
  });

  it("sold-knock auto-commission scores with ONLY the knock's org's plans", async () => {
    // Org B's $999 plan must never price an org-A sale and vice versa.
    const leadA = makeLead(1, rep1.memberId);
    const leadB = makeLead(TENANT_B, rep2.memberId);
    const at = new Date().toISOString();

    const kA = await knock(leadA.id, rep1.session, "sold", at);
    expect(kA.status).toBe(201);
    const commA = pendingFor(leadA.id);
    expect(commA.length).toBe(1);
    expect(commA[0].amount).toBe(111); // org A's newest org-wide flat plan
    expect(commA[0].tenant_id).toBe(1);

    const kB = await knock(leadB.id, rep2.session, "sold", at);
    expect(kB.status).toBe(201);
    const commB = pendingFor(leadB.id);
    expect(commB.length).toBe(1);
    expect(commB[0].amount).toBe(999); // org B's role=rep plan
    expect(commB[0].tenant_id).toBe(TENANT_B);
  });
});

describe("P1-1 stale offline knock loses the outcome CAS", () => {
  it("older knockedAt → no status flip, no reversal, no commission removal, superseded marker", async () => {
    const lead = makeLead(1, rep1.memberId);
    const sold = await knock(lead.id, rep1.session, "sold", "2026-02-02T10:00:00.000Z");
    expect(sold.status).toBe(201);
    expect(pendingFor(lead.id).length).toBe(1);
    const saleRow = () => rawDb.prepare(
      "SELECT status FROM commission_sales WHERE tenant_id = 1 AND external_id = ?",
    ).get(`lead:${lead.id}`) as any;
    expect(saleRow()?.status).toBe("QUALIFIED");

    // Stale sync: tapped BEFORE the sold knock, flushed after it.
    const stale = await knock(lead.id, rep1.session, "not_interested", "2026-02-01T10:00:00.000Z");
    expect(stale.status).toBe(200);
    expect(stale.body.superseded).toBe(true);

    expect(storage.getLeadById(lead.id)!.leadStatus).toBe("sold");
    expect(pendingFor(lead.id).length).toBe(1);     // commission NOT removed
    expect(saleRow()?.status).toBe("QUALIFIED");    // weekly sale NOT reversed

    // A NEWER outcome still wins the CAS and unwinds the sale normally.
    const newer = await knock(lead.id, rep1.session, "not_interested", "2026-02-03T10:00:00.000Z");
    expect(newer.status).toBe(201);
    expect(newer.body.superseded).toBeUndefined();
    expect(storage.getLeadById(lead.id)!.leadStatus).toBe("not_interested");
    expect(pendingFor(lead.id).length).toBe(0);
    expect(saleRow()?.status).toBe("REVERSED");
  });
});

describe("P1-2 duplicate sold knocks book exactly one pending commission", () => {
  it("two distinct sold knocks for one lead → 1 pending commission row", async () => {
    const lead = makeLead(1, rep1.memberId);
    const first = await knock(lead.id, rep1.session, "sold", "2026-03-01T10:00:00.000Z");
    expect(first.status).toBe(201);
    // Offline retry with a FRESH clientId (bypasses the clientId dedupe) and a
    // newer timestamp (wins the CAS) — the DB unique index is the backstop.
    const dup = await knock(lead.id, rep1.session, "sold", "2026-03-01T10:05:00.000Z");
    expect(dup.status).toBe(201);
    expect(pendingFor(lead.id).length).toBe(1);
  });
});

describe("P0-6 saleAmount in the knock body is ignored", () => {
  it("a percentage plan scores $0 from a fabricated body saleAmount", async () => {
    const postPct = await request("/api/commission-rates", mgr1.session, {
      method: "POST",
      body: JSON.stringify({ name: "Org A 10pct", calcType: "percentage", percentage: 10, repId: rep3.memberId }),
    });
    expect(postPct.status).toBe(200);

    const lead = makeLead(1, rep3.memberId);
    const sold = await knock(lead.id, rep3.session, "sold", new Date().toISOString(), { saleAmount: 100000 });
    expect(sold.status).toBe(201);
    const comms = pendingFor(lead.id);
    expect(comms.length).toBe(1);
    // 10% of the client-supplied $100,000 would be $10,000 — the body is never
    // read, so the basis is 0 and the booked amount is $0 (manager corrects).
    expect(comms[0].amount).toBe(0);
    expect(comms[0].sale_amount).toBeNull();
  });
});
