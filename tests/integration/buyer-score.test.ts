// Buyer score end to end: the job scores a tenant's open doors from existing
// columns, a sale next door in ANOTHER tenant never counts, closed and
// do-not-knock doors are removed rather than ranked low, scoring never bumps
// updated_at, the list sorts best buyers first with unscored doors last, the
// packed map pin carries the number, a knock refreshes it, and the rescore
// endpoint is a manager action.
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAP_PIN_WIRE_FIELDS } from "../../shared/mapPinsWire";

const TENANT_A = 1;
const TENANT_B = 2;

let server: Server;
let baseUrl: string;
let storage: any;
let rawDb: any;
let job: typeof import("../../server/buyerScoreJob");

type Fixture = { userId: number; memberId: number; session: string };

function person(name: string, loginRole: string, tenantId: number, memberRole = "rep"): Fixture {
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}.${tenantId}@buyer.example.test`;
  const member = storage.createTeamMember({ name, email, role: memberRole, active: true, reportsToId: null, tenantId });
  const user = storage.createUser({ name, email, role: loginRole, active: true, tenantId, teamMemberId: member.id });
  return { userId: user.id, memberId: member.id, session: storage.createSession(user.id).id };
}

// 1 m of latitude is about 1/111,320 degrees.
const M = 1 / 111_320;
const BASE_LAT = 35.6700, BASE_LNG = -80.4700;

let seq = 0;
function lead(tenantId: number, over: Record<string, unknown> = {}) {
  seq += 1;
  const row = storage.createLead({
    address: `${1800 + seq} Oak Ridge Dr`, city: "Salisbury", state: "NC", zip: "28146",
    lat: BASE_LAT, lng: BASE_LNG, tenantId, leadStatus: "prospect", ...over,
  });
  return storage.getLeadById(row.id);
}

function request(path: string, sessionId: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-session-id": sessionId, ...(init.headers ?? {}) },
  });
}

const col = (id: number, c: string) => (rawDb.prepare(`SELECT ${c} AS v FROM leads WHERE id = ?`).get(id) as any).v;

let mgr: Fixture, repA: Fixture, foreignRep: Fixture;
let hero: any, soldNextDoor: any, foreignSale: any, blocked: any, copper: any, farSale: any;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-buyer-score-"));
  process.env.NODE_ENV = "test";
  const storageModule = await import("../../server/storage");
  storageModule.runMigrations();
  storage = storageModule.storage;
  ({ rawDb } = await import("../../server/db"));
  job = await import("../../server/buyerScoreJob");

  rawDb.prepare(
    `INSERT OR IGNORE INTO tenants (id, slug, company_name, owner_name, owner_email, brand_name)
     VALUES (?, 'beacon-bs', 'Beacon Fiber', 'Owner B', 'owner-b@buyer.example.test', 'Beacon')`,
  ).run(TENANT_B);

  mgr = person("Bs Manager", "manager", TENANT_A, "manager");
  repA = person("Bs Rep A", "rep", TENANT_A);
  foreignRep = person("Bs Foreign", "rep", TENANT_B);

  const now = new Date().toISOString();
  // The canvas door: fresh fiber, nobody signed up, on cable, one sale 60 m away.
  hero = lead(TENANT_A, {
    householdSegmentType: "NEW FIBER", billingStatus: "N",
    competitorName: "Spectrum", competitorTech: "Cable", assignedRepId: repA.memberId,
  });
  soldNextDoor = lead(TENANT_A, { lat: BASE_LAT + 60 * M, leadStatus: "sold" });
  rawDb.prepare(`UPDATE leads SET last_outcome = 'sold', last_outcome_at = ? WHERE id = ?`).run(now, soldNextDoor.id);
  // A sale 40 m away in the OTHER tenant: closer, and must not count.
  foreignSale = lead(TENANT_B, { lat: BASE_LAT + 40 * M, leadStatus: "sold" });
  rawDb.prepare(`UPDATE leads SET last_outcome = 'sold', last_outcome_at = ? WHERE id = ?`).run(now, foreignSale.id);
  // A sale 400 m away in the same tenant: outside the radius.
  farSale = lead(TENANT_A, { lat: BASE_LAT + 400 * M, leadStatus: "sold" });
  rawDb.prepare(`UPDATE leads SET last_outcome = 'sold', last_outcome_at = ? WHERE id = ?`).run(now, farSale.id);
  blocked = lead(TENANT_A, { householdSegmentType: "NEW FIBER", billingStatus: "N", lat: BASE_LAT + 900 * M });
  rawDb.prepare(`UPDATE leads SET do_not_knock = 1 WHERE id = ?`).run(blocked.id);
  copper = lead(TENANT_A, { fiberStatus: "copper", techType: "DSL", maxDownloadMbps: 25, lat: BASE_LAT + 1200 * M });
  // Pin updated_at in the past so the test can prove scoring leaves it alone.
  rawDb.prepare(`UPDATE leads SET updated_at = '2026-01-01T00:00:00.000Z' WHERE tenant_id = ?`).run(TENANT_A);

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

afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

describe("buyer score job", () => {
  it("the rescore endpoint is a manager action", async () => {
    const asRep = await request("/api/buyer-score/run", repA.session, { method: "POST", body: "{}" });
    expect(asRep.status).toBe(403);
    const asMgr = await request("/api/buyer-score/run", mgr.session, { method: "POST", body: "{}" });
    expect(asMgr.status).toBe(200);
    const body = (await asMgr.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.tenantId).toBe(TENANT_A);
    // hero + copper scored; the two sales and the blocked door removed.
    expect(body.scored).toBe(2);
    expect(body.removed).toBe(3);
    expect(body.capped).toBe(false);
  });

  it("scores the hero door from existing columns: 5.0 + 1.6 fiber + 0.8 cable + 0.5 for ONE neighbour (the same-tenant sale 60 m away)", () => {
    expect(col(hero.id, "buyer_score")).toBe(7.9);
    const reasons = JSON.parse(col(hero.id, "buyer_score_reasons"));
    expect(reasons.map((r: any) => r.key)).toEqual(["base", "fiber", "competitor", "neighbors"]);
    expect(reasons.find((r: any) => r.key === "neighbors")).toEqual({ key: "neighbors", label: "A neighbor bought in the last 90 days", delta: 0.5 });
    expect(col(hero.id, "buyer_scored_at")).toBeTruthy();
  });

  it("never counts another tenant's sale, even when it is the closest door", () => {
    // The foreign sale sits 40 m away; if it leaked the neighbour delta would be 1.0.
    const reasons = JSON.parse(col(hero.id, "buyer_score_reasons"));
    expect(reasons.find((r: any) => r.key === "neighbors")?.delta).toBe(0.5);
    // And the foreign tenant's own rows were not touched by tenant A's run.
    expect(col(foreignSale.id, "buyer_scored_at")).toBeNull();
  });

  it("removes closed and do-not-knock doors instead of ranking them low, and ranks copper Unlikely", () => {
    expect(col(soldNextDoor.id, "buyer_score")).toBeNull();
    expect(col(soldNextDoor.id, "buyer_scored_at")).toBeTruthy();
    expect(col(blocked.id, "buyer_score")).toBeNull();
    expect(col(blocked.id, "buyer_score_reasons")).toBeNull();
    expect(col(copper.id, "buyer_score")).toBe(3.5);
  });

  it("scoring is not activity: updated_at is untouched", () => {
    expect(col(hero.id, "updated_at")).toBe("2026-01-01T00:00:00.000Z");
    expect(col(copper.id, "updated_at")).toBe("2026-01-01T00:00:00.000Z");
  });

  it("GET /api/leads?sort=buyer_desc puts the best buyers first and unscored doors last", async () => {
    const res = await request("/api/leads?sort=buyer_desc&limit=50", mgr.session);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const ids = body.leads.map((l: any) => l.id);
    expect(ids.slice(0, 2)).toEqual([hero.id, copper.id]);
    expect(body.leads[0].buyerScore).toBe(7.9);
    expect(body.leads[1].buyerScore).toBe(3.5);
    for (const l of body.leads.slice(2)) expect(l.buyerScore ?? null).toBeNull();
    // Tenant B's rows never appear, whatever the sort.
    expect(ids).not.toContain(foreignSale.id);
  });

  it("the packed map pin carries buyerScore for the rep's own door", async () => {
    const res = await request("/api/leads/map?format=packed", repA.session);
    expect(res.status).toBe(200);
    const packed = (await res.json()) as any;
    const idx = MAP_PIN_WIRE_FIELDS.indexOf("buyerScore");
    const row = packed.rows.find((r: unknown[]) => r[0] === hero.id);
    expect(row).toBeTruthy();
    expect(row[idx]).toBe(7.9);
  });

  it("a knock refreshes the door's score on the knock path: one no-answer costs 0.3", async () => {
    const res = await request(`/api/leads/${hero.id}/knock`, repA.session, {
      method: "POST",
      body: JSON.stringify({ outcome: "not_home", knockedAt: new Date().toISOString(), clientId: "bs-knock-1" }),
    });
    expect(res.status).toBe(201);
    // The rescore runs after the response on setImmediate.
    await new Promise((r) => setTimeout(r, 60));
    expect(col(hero.id, "buyer_score")).toBe(7.6);
    const reasons = JSON.parse(col(hero.id, "buyer_score_reasons"));
    expect(reasons.find((r: any) => r.key === "not_home")).toEqual({ key: "not_home", label: "Knocked once, nobody home", delta: -0.3 });
  });

  it("status reports bands for the caller's tenant only", async () => {
    const res = await request("/api/buyer-score/status", repA.session);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.bands).toEqual({ scored: 2, likely: 0, possible: 1, unlikely: 1 });
    expect(body.lastRun?.tenantId).toBe(TENANT_A);
    const foreign = await request("/api/buyer-score/status", foreignRep.session);
    expect(((await foreign.json()) as any).bands.scored).toBe(0);
  });

  it("the run cap walks the stalest rows first and reports capped:true, so a big tenant converges over runs", async () => {
    // Stamp the hero as freshly scored and the others as old; a cap of 1 must pick an old one.
    rawDb.prepare(`UPDATE leads SET buyer_scored_at = '2026-01-01T00:00:00.000Z' WHERE tenant_id = ? AND id != ?`).run(TENANT_A, hero.id);
    const summary = await job.rescoreTenant(TENANT_A, { cap: 1, batch: 1 });
    expect(summary?.capped).toBe(true);
    expect(summary!.scored + summary!.removed).toBe(1);
    // The hero (newest stamp) was not the one picked.
    expect(col(hero.id, "buyer_scored_at")).not.toBe(summary!.ranAt);
  });

  it("a background pass skips doors scored within maxAgeMs and spends its cap on the stale ones", async () => {
    const fresh = new Date().toISOString();
    rawDb.prepare(`UPDATE leads SET buyer_scored_at = ? WHERE tenant_id = ?`).run(fresh, TENANT_A);
    rawDb.prepare(`UPDATE leads SET buyer_scored_at = '2026-01-01T00:00:00.000Z' WHERE id = ?`).run(copper.id);
    const summary = await job.rescoreTenant(TENANT_A, { maxAgeMs: 20 * 60 * 60_000 });
    expect(summary!.scored + summary!.removed).toBe(1);
    expect(col(copper.id, "buyer_scored_at")).toBe(summary!.ranAt);
    expect(col(hero.id, "buyer_scored_at")).toBe(fresh);
  });

  it("refuses to race itself on the same tenant", async () => {
    const first = job.rescoreTenant(TENANT_A, { batch: 1 });
    const second = await job.rescoreTenant(TENANT_A, { batch: 1 });
    expect(second).toBeNull();
    expect(await first).not.toBeNull();
  });
});
