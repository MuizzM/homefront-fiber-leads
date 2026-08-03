// Fixture accounts are marked TRAINED. New accounts now owe training before the
// field opens (server/trainingGateStore.ts); these suites are about territory,
// RBAC, spiffs, and offboarding, so their people start on the far side of that
// gate rather than every assertion here re-testing it.
// Spiff routes — the security + money-safety contract:
//   * a rep sees ONLY their own feed; the team heat (algorithm data) is
//     manager+; approve / mark-paid are admin-only and audited,
//   * tenant walls hold (tenant 2 spiffs never appear in tenant 1 reads and
//     can't be approved by a tenant 1 admin),
//   * status transitions are enforced (earned → approved → paid; anything else 409),
//   * evaluating a sale for a spiff inserts into the spiffs ledger ONLY and never
//     touches the commission tables (proof the recognition path is money-safe),
//   * evaluation is idempotent on the sale ref.
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let server: Server;
let baseUrl: string;
let storage: (typeof import("../../server/storage"))["storage"];
let rawDb: import("better-sqlite3").Database;
let spiffStore: typeof import("../../server/spiffStore");

let repSession: string;
let managerSession: string;
let adminSession: string;
let foreignAdminSession: string;
let sellingAdminSession: string;
let repTmId: number;
let foreignTmId: number;
let sellingAdminTmId: number;

const realFetch = globalThis.fetch.bind(globalThis);

/** A full config for the store — the band form, not the legacy flat amount. */
function bandConfig(over: Partial<Record<string, number>> = {}): any {
  return {
    minAmountCents: 2500, maxAmountCents: 5000, incrementCents: 500,
    randomChancePct: 100, streakThresholdDays: 3, improvementPct: 50, milestoneEvery: 10,
    dailyCapPerRep: 5, dailyCapCentsPerRep: 100_000,
    ...over,
  };
}

function countRows(sql: string, ...params: any[]): number {
  try { return (rawDb.prepare(sql).get(...params) as any)?.n ?? 0; } catch { return 0; }
}
function insertSpiff(tenantId: number, repId: number, saleRef: string, status = "earned", reason = "random", amountCents = 5000): number {
  const info = rawDb.prepare(
    `INSERT INTO spiffs (tenant_id, rep_id, sale_ref, amount_cents, reason, status, created_at) VALUES (?,?,?,?,?,?,datetime('now'))`,
  ).run(tenantId, repId, saleRef, amountCents, reason, status);
  return Number(info.lastInsertRowid);
}

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-spiff-routes-"));
  process.env.NODE_ENV = "test";

  const storageModule = await import("../../server/storage");
  storageModule.runMigrations();
  storage = storageModule.storage;
  ({ rawDb } = await import("../../server/db"));
  spiffStore = await import("../../server/spiffStore");
  const { registerRoutes, registerSaasRoutes } = await import("../../server/routes");

  rawDb.prepare(
    "INSERT OR IGNORE INTO tenants (id, slug, company_name, owner_name, owner_email, brand_name) VALUES (1, 'tenant-a-spiff', 'Tenant A', 'Owner A', 'owner-a-spiff@example.com', 'Tenant A')",
  ).run();
  rawDb.prepare(
    "INSERT OR IGNORE INTO tenants (id, slug, company_name, owner_name, owner_email, brand_name) VALUES (2, 'tenant-b-spiff', 'Tenant B', 'Owner B', 'owner-b-spiff@example.com', 'Tenant B')",
  ).run();

  const repTm = storage.createTeamMember({ name: "Spiff Rep", role: "rep", active: true, tenantId: 1 } as any);
  const foreignTm = storage.createTeamMember({ name: "Foreign Rep", role: "rep", active: true, tenantId: 2 } as any);
  repTmId = repTm.id;
  foreignTmId = foreignTm.id;

  const rep = storage.createUser({ name: "Spiff Rep", email: "rep-spiff@example.com", role: "rep", active: true, tenantId: 1, teamMemberId: repTm.id } as any);
  rawDb?.prepare("UPDATE users SET training_required = 0 WHERE id = ?").run((rep as any).id);
  const manager = storage.createUser({ name: "Spiff Manager", email: "manager-spiff@example.com", role: "manager", active: true, tenantId: 1 } as any);
  rawDb?.prepare("UPDATE users SET training_required = 0 WHERE id = ?").run((manager as any).id);
  const admin = storage.createUser({ name: "Spiff Admin", email: "admin-spiff@example.com", role: "admin", active: true, tenantId: 1 } as any);
  rawDb?.prepare("UPDATE users SET training_required = 0 WHERE id = ?").run((admin as any).id);
  const foreignAdmin = storage.createUser({ name: "Foreign Admin", email: "admin-b-spiff@example.com", role: "admin", active: true, tenantId: 2 } as any);
  rawDb?.prepare("UPDATE users SET training_required = 0 WHERE id = ?").run((foreignAdmin as any).id);

  // An admin who ALSO sells — the segregation-of-duties case.
  const sellingAdminTm = storage.createTeamMember({ name: "Selling Admin", role: "rep", active: true, tenantId: 1 } as any);
  sellingAdminTmId = sellingAdminTm.id;
  const sellingAdmin = storage.createUser({ name: "Selling Admin", email: "selling-admin-spiff@example.com", role: "admin", active: true, tenantId: 1, teamMemberId: sellingAdminTm.id } as any);
  rawDb?.prepare("UPDATE users SET training_required = 0 WHERE id = ?").run((sellingAdmin as any).id);

  repSession = storage.createSession(rep.id).id;
  managerSession = storage.createSession(manager.id).id;
  adminSession = storage.createSession(admin.id).id;
  foreignAdminSession = storage.createSession(foreignAdmin.id).id;
  sellingAdminSession = storage.createSession(sellingAdmin.id).id;

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  server = createServer(app);
  registerRoutes(server, app);
  registerSaasRoutes(app); // the spiff routes live here (the SaaS route block)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
});

function request(path: string, sessionId: string | null, init: RequestInit = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", ...(init.headers as any ?? {}) };
  if (sessionId) { headers["x-session-id"] = sessionId; headers["x-csrf-token"] = sessionId; }
  return realFetch(`${baseUrl}${path}`, { ...init, headers });
}

describe("GET /api/spiffs/mine", () => {
  it("requires auth", async () => {
    expect((await realFetch(`${baseUrl}/api/spiffs/mine`)).status).toBe(401);
  });

  it("returns the rep's own spiffs + heat, never another rep's", async () => {
    insertSpiff(1, repTmId, "seed:mine-1", "earned");
    insertSpiff(1, foreignTmId, "seed:other-1", "earned"); // different rep + tenant
    const res = await request("/api/spiffs/mine", repSession);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.spiffs.every((s: any) => s.repId === repTmId)).toBe(true);
    expect(body.spiffs.some((s: any) => s.saleRef === "seed:mine-1")).toBe(true);
    expect(typeof body.heat).toBe("number");
    expect(body.totals.count).toBeGreaterThanOrEqual(1);
  });
});

describe("GET /api/spiffs/team (algorithm data — manager+)", () => {
  it("a rep is forbidden", async () => {
    expect((await request("/api/spiffs/team", repSession)).status).toBe(403);
  });

  it("a manager sees per-rep heat, walled to their own tenant", async () => {
    const res = await request("/api/spiffs/team", managerSession);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(Array.isArray(body.reps)).toBe(true);
    // The foreign tenant's rep never appears.
    expect(body.reps.some((r: any) => r.repId === foreignTmId)).toBe(false);
    expect(body.reps.some((r: any) => r.repId === repTmId)).toBe(true);
    // pending queue is tenant-scoped too — nothing from tenant 2 leaks in.
    expect((body.pending as any[]).every((p) => p.tenantId === 1)).toBe(true);
  });
});

describe("POST /api/spiffs/:id/approve and /paid (admin-only, audited)", () => {
  it("a rep cannot approve", async () => {
    const id = insertSpiff(1, repTmId, "seed:approve-rep", "earned");
    expect((await request(`/api/spiffs/${id}/approve`, repSession, { method: "POST" })).status).toBe(403);
  });

  it("a manager cannot approve (approve/paid are admin-only)", async () => {
    const id = insertSpiff(1, repTmId, "seed:approve-mgr", "earned");
    expect((await request(`/api/spiffs/${id}/approve`, managerSession, { method: "POST" })).status).toBe(403);
  });

  it("an admin drives earned → approved → paid, and it is audited", async () => {
    const id = insertSpiff(1, repTmId, "seed:transition", "earned");
    const approve = await request(`/api/spiffs/${id}/approve`, adminSession, { method: "POST" });
    expect(approve.status).toBe(200);
    expect((await approve.json() as any).status).toBe("approved");

    const paid = await request(`/api/spiffs/${id}/paid`, adminSession, { method: "POST" });
    expect(paid.status).toBe(200);
    const paidBody = await paid.json() as any;
    expect(paidBody.status).toBe("paid");
    expect(paidBody.paidAt).toBeTruthy();

    const audit = countRows("SELECT COUNT(*) AS n FROM activity_log WHERE action IN ('spiff.approved','spiff.paid') AND entity_id = ?", id);
    expect(audit).toBe(2);
  });

  it("rejects an out-of-order transition (paid before approved) with 409", async () => {
    const id = insertSpiff(1, repTmId, "seed:bad-transition", "earned");
    expect((await request(`/api/spiffs/${id}/paid`, adminSession, { method: "POST" })).status).toBe(409);
  });

  it("tenant-walls approval: a tenant-1 admin cannot approve a tenant-2 spiff (404)", async () => {
    const id = insertSpiff(2, foreignTmId, "seed:cross-tenant", "earned");
    expect((await request(`/api/spiffs/${id}/approve`, adminSession, { method: "POST" })).status).toBe(404);
    // And the foreign admin CAN.
    expect((await request(`/api/spiffs/${id}/approve`, foreignAdminSession, { method: "POST" })).status).toBe(200);
  });
});

describe("evaluateSpiffForSale is money-safe + idempotent", () => {
  it("awards a spiff row WITHOUT touching commission tables", async () => {
    // A dedicated rep with a clean slate, so seeded spiffs from earlier tests
    // don't consume the daily cap.
    const rep = storage.createTeamMember({ name: "Money Rep", role: "rep", active: true, tenantId: 1 } as any).id;
    // A committed sold knock the snapshot can read.
    rawDb.prepare(
      `INSERT INTO knock_log (lead_id, rep_id, knocked_at, was_home, outcome, superseded, tenant_id) VALUES (?,?,?,?,?,0,?)`,
    ).run(9001, rep, new Date().toISOString(), 1, "sold", 1);

    const commBefore = countRows("SELECT COUNT(*) AS n FROM commissions");
    const salesBefore = countRows("SELECT COUNT(*) AS n FROM commission_sales");
    const spiffBefore = countRows("SELECT COUNT(*) AS n FROM spiffs WHERE tenant_id = 1 AND rep_id = ?", rep);

    // Force an award (100% random chance) — the exact call the route hook makes.
    const result = spiffStore.evaluateSpiffForSale({
      tenantId: 1, repId: rep, saleRef: "knock:9001", nowMs: Date.now(),
      seed: "test-seed", actorId: null,
      config: bandConfig(),
    });
    // The amount is now a DRAW from the $25–$50 band, so assert the money
    // contract rather than a single hardcoded number.
    expect(result.spiff?.amountCents).toBeGreaterThanOrEqual(2500);
    expect(result.spiff?.amountCents).toBeLessThanOrEqual(5000);
    expect((result.spiff?.amountCents ?? 0) % 500).toBe(0);
    expect(Number.isInteger(result.spiff?.amountCents)).toBe(true);

    const commAfter = countRows("SELECT COUNT(*) AS n FROM commissions");
    const salesAfter = countRows("SELECT COUNT(*) AS n FROM commission_sales");
    const spiffAfter = countRows("SELECT COUNT(*) AS n FROM spiffs WHERE tenant_id = 1 AND rep_id = ?", rep);

    // Commission math is untouched; the spiff ledger grew by exactly one.
    expect(commAfter).toBe(commBefore);
    expect(salesAfter).toBe(salesBefore);
    expect(spiffAfter).toBe(spiffBefore + 1);
  });

  it("is idempotent on the sale ref (a replay awards no second row)", async () => {
    const before = countRows("SELECT COUNT(*) AS n FROM spiffs WHERE sale_ref = 'knock:9001'");
    const replay = spiffStore.evaluateSpiffForSale({
      tenantId: 1, repId: repTmId, saleRef: "knock:9001", nowMs: Date.now(),
      seed: "test-seed", actorId: null,
      config: bandConfig(),
    });
    expect(replay.duplicate).toBe(true);
    const after = countRows("SELECT COUNT(*) AS n FROM spiffs WHERE sale_ref = 'knock:9001'");
    expect(after).toBe(before);
  });

  // REGRESSION — the sale hook used to fold the wall clock into its seed
  // (`…:knock:<id>:<serverTs>`). Because a NON-award writes no ledger row, there
  // was nothing to make the replay idempotent against: the retry rolled a fresh
  // number and could award a spiff the original sale never earned. A seed built
  // only from stable identity makes the whole evaluation reproducible.
  it("a re-evaluation with the SAME identity seed reproduces the SAME outcome", () => {
    const rep = storage.createTeamMember({ name: "Seed Rep", role: "rep", active: true, tenantId: 1 } as any).id;
    const stableSeed = `1:${rep}:knock:9500`;
    // A 1% chance with a seed that rolls high: no award, no ledger row, nothing
    // to dedupe against on a retry.
    const cfg = bandConfig({ randomChancePct: 1, milestoneEvery: 0, streakThresholdDays: 0 });
    const first = spiffStore.evaluateSpiffForSale({ tenantId: 1, repId: rep, saleRef: "knock:9500", nowMs: Date.now(), seed: stableSeed, config: cfg });
    expect(first.spiff).toBeNull();
    for (let i = 0; i < 5; i++) {
      const retry = spiffStore.evaluateSpiffForSale({ tenantId: 1, repId: rep, saleRef: "knock:9500", nowMs: Date.now() + i * 1000, seed: stableSeed, config: cfg });
      expect(retry.decision.awarded).toBe(false);
    }
    expect(countRows("SELECT COUNT(*) AS n FROM spiffs WHERE sale_ref = 'knock:9500'")).toBe(0);
    // Proof the seed is what carries the determinism: a clock-derived seed rolls
    // a different number, which is exactly how the old bug awarded on retry.
    expect(spiffStore.seededRoll(stableSeed)).toBe(spiffStore.seededRoll(stableSeed));
    expect(spiffStore.seededRoll(`${stableSeed}:2026-08-03T00:00:00.000Z`)).not.toBe(spiffStore.seededRoll(stableSeed));
  });

  it("the daily CENTS cap stops a rep farming spiffs, whatever the amounts are", () => {
    const rep = storage.createTeamMember({ name: "Cap Rep", role: "rep", active: true, tenantId: 1 } as any).id;
    // $95 of mixed-size spiffs already today, cap $100, count cap wide open.
    insertSpiff(1, rep, "cap:a", "earned", "random", 2500);
    insertSpiff(1, rep, "cap:b", "earned", "streak", 3000);
    insertSpiff(1, rep, "cap:c", "earned", "milestone", 4000);
    const cfg = bandConfig({ dailyCapPerRep: 99, dailyCapCentsPerRep: 10000 });
    const res = spiffStore.evaluateSpiffForSale({
      tenantId: 1, repId: rep, saleRef: "cap:next", nowMs: Date.now(), seed: "cap-seed", config: cfg,
    });
    // $5 of room left — under the $25 floor, so nothing is awarded rather than a
    // token amount, and the day's spend stays at or under the cap.
    expect(res.decision.awarded).toBe(false);
    const spentToday = countRows(
      `SELECT COALESCE(SUM(amount_cents), 0) AS n FROM spiffs WHERE tenant_id = 1 AND rep_id = ? AND substr(created_at,1,10) = ?`,
      rep, new Date().toISOString().slice(0, 10),
    );
    expect(spentToday).toBeLessThanOrEqual(10000);
  });
});

// ── Exactly-once payment ──────────────────────────────────────────────────────
// The spiff ledger is the ONLY payment rail: nothing else in the codebase reads
// spiffs.amount_cents. So `approved → paid` is THE settlement, and it has to be
// unrepeatable under retries, double-clicks and concurrent admins.
describe("a spiff is payable exactly once", () => {
  it("end-to-end: approve once, pay once, and every repeat is a 409 no-op", async () => {
    const id = insertSpiff(1, repTmId, "once:e2e", "earned", "milestone", 4500);

    expect((await request(`/api/spiffs/${id}/approve`, adminSession, { method: "POST" })).status).toBe(200);
    expect((await request(`/api/spiffs/${id}/approve`, adminSession, { method: "POST" })).status).toBe(409);

    expect((await request(`/api/spiffs/${id}/paid`, adminSession, { method: "POST" })).status).toBe(200);
    for (let i = 0; i < 3; i++) {
      expect((await request(`/api/spiffs/${id}/paid`, adminSession, { method: "POST" })).status).toBe(409);
    }
    // A paid spiff can never be walked back to approved either.
    expect((await request(`/api/spiffs/${id}/approve`, adminSession, { method: "POST" })).status).toBe(409);

    const row = rawDb.prepare(`SELECT * FROM spiffs WHERE id = ?`).get(id) as any;
    expect(row.status).toBe("paid");
    expect(countRows("SELECT COUNT(*) AS n FROM activity_log WHERE action = 'spiff.paid' AND entity_id = ?", id)).toBe(1);
    expect(countRows("SELECT COUNT(*) AS n FROM activity_log WHERE action = 'spiff.approved' AND entity_id = ?", id)).toBe(1);
  });

  // REGRESSION — the transitions used to read the row, then UPDATE by id with no
  // status predicate. Anything that changed the row between those two statements
  // (a second admin, a retried request) was silently overwritten and the caller
  // was told it had succeeded → two payment events for one spiff. The UPDATE now
  // carries `AND status = <expected>` and the rowcount is checked.
  it("loses the race safely when another admin settles between our read and our write", () => {
    const id = insertSpiff(1, repTmId, "once:race", "approved", "streak", 3500);
    const prepare = rawDb.prepare.bind(rawDb);
    const spy = vi.spyOn(rawDb, "prepare").mockImplementation(((sql: string, ...rest: any[]) => {
      // The instant the settlement UPDATE is prepared, let "the other admin" land
      // first — the exact interleaving the compare-and-swap exists to survive.
      if (/UPDATE spiffs SET status = 'paid'/.test(sql)) {
        prepare(`UPDATE spiffs SET status = 'paid', paid_at = '2026-01-01T00:00:00.000Z' WHERE id = ?`).run(id);
      }
      return prepare(sql, ...rest);
    }) as any);
    try {
      const result = spiffStore.markSpiffPaid(1, id, Date.parse("2026-08-03T12:00:00.000Z"));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("invalid_transition");
    } finally {
      spy.mockRestore();
    }
    // The other admin's settlement stands, untouched — ours did not overwrite it.
    const row = rawDb.prepare(`SELECT * FROM spiffs WHERE id = ?`).get(id) as any;
    expect(row.status).toBe("paid");
    expect(row.paid_at).toBe("2026-01-01T00:00:00.000Z");
  });

  it("bulk mark-paid settles each id at most once, even with duplicates", () => {
    const a = insertSpiff(1, repTmId, "once:bulk-a", "approved", "random", 2500);
    const b = insertSpiff(1, repTmId, "once:bulk-b", "approved", "streak", 5000);
    const result = spiffStore.markSpiffsPaid(1, [a, b, a, b, a], Date.now());
    expect(result.changed.map((s) => s.id).sort()).toEqual([a, b].sort());
    expect(result.totalCents).toBe(7500);
    // A second submit of the same batch moves no money at all.
    const again = spiffStore.markSpiffsPaid(1, [a, b], Date.now());
    expect(again.changed).toHaveLength(0);
    expect(again.totalCents).toBe(0);
    expect(again.skipped.map((s) => s.reason)).toEqual(["invalid_transition", "invalid_transition"]);
  });

  it("the payable set is exactly the approved spiffs, and settling empties it", () => {
    const rep = storage.createTeamMember({ name: "Payable Rep", role: "rep", active: true, tenantId: 1 } as any).id;
    insertSpiff(1, rep, "payable:earned", "earned", "random", 2500);
    const approved = insertSpiff(1, rep, "payable:approved", "approved", "milestone", 5000);
    insertSpiff(1, rep, "payable:paid", "paid", "streak", 4000);

    const payable = spiffStore.getPayableSpiffs(1, [rep]);
    expect(payable.map((s) => s.id)).toEqual([approved]);

    spiffStore.markSpiffsPaid(1, [approved], Date.now());
    expect(spiffStore.getPayableSpiffs(1, [rep])).toHaveLength(0);
  });
});

// ── Segregation of duties + bulk tenancy ──────────────────────────────────────
describe("nobody signs off their own money", () => {
  // REGRESSION — approve only checked the admin ROLE. An admin who also carries a
  // team-member id (an owner who still sells) could approve the spiffs the
  // algorithm awarded them, with no second pair of eyes.
  it("an admin cannot approve their own spiff (403), but another admin can", async () => {
    const id = insertSpiff(1, sellingAdminTmId, "self:approve", "earned", "milestone", 5000);
    const self = await request(`/api/spiffs/${id}/approve`, sellingAdminSession, { method: "POST" });
    expect(self.status).toBe(403);
    expect(rawDb.prepare(`SELECT status FROM spiffs WHERE id = ?`).get(id)).toEqual({ status: "earned" });
    expect((await request(`/api/spiffs/${id}/approve`, adminSession, { method: "POST" })).status).toBe(200);
  });

  it("bulk approve skips a rep's own spiff while approving the rest", async () => {
    const mine = insertSpiff(1, sellingAdminTmId, "self:bulk-mine", "earned", "random", 2500);
    const theirs = insertSpiff(1, repTmId, "self:bulk-theirs", "earned", "streak", 3000);
    const res = await request(`/api/spiffs/bulk/approve`, sellingAdminSession, {
      method: "POST", body: JSON.stringify({ ids: [mine, theirs] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.changed.map((s: any) => s.id)).toEqual([theirs]);
    expect(body.totalCents).toBe(3000);
    expect(body.skipped).toEqual([{ id: mine, reason: "self_approval", from: "earned" }]);
  });
});

describe("bulk transitions stay tenant-walled and admin-only", () => {
  it("a rep and a manager are both forbidden", async () => {
    const id = insertSpiff(1, repTmId, "bulk:rbac", "earned");
    for (const s of [repSession, managerSession]) {
      const res = await request(`/api/spiffs/bulk/approve`, s, { method: "POST", body: JSON.stringify({ ids: [id] }) });
      expect(res.status).toBe(403);
    }
    expect(rawDb.prepare(`SELECT status FROM spiffs WHERE id = ?`).get(id)).toEqual({ status: "earned" });
  });

  it("a foreign tenant's spiff inside the id list is skipped, never approved", async () => {
    const ours = insertSpiff(1, repTmId, "bulk:ours", "earned", "random", 3500);
    const theirs = insertSpiff(2, foreignTmId, "bulk:theirs", "earned", "random", 5000);
    const res = await request(`/api/spiffs/bulk/approve`, adminSession, {
      method: "POST", body: JSON.stringify({ ids: [ours, theirs] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.changed.map((s: any) => s.id)).toEqual([ours]);
    expect(body.skipped).toEqual([{ id: theirs, reason: "not_found" }]);
    // The other tenant's row is untouched.
    expect(rawDb.prepare(`SELECT status FROM spiffs WHERE id = ?`).get(theirs)).toEqual({ status: "earned" });
  });

  it("rejects an empty or malformed id list with 400", async () => {
    for (const body of [{}, { ids: [] }, { ids: ["nope", -1, 0] }]) {
      const res = await request(`/api/spiffs/bulk/paid`, adminSession, { method: "POST", body: JSON.stringify(body) });
      expect(res.status).toBe(400);
    }
  });
});

describe("GET /api/spiffs/mine — money read model", () => {
  it("totals cover the whole ledger even though the feed is bounded", async () => {
    const rep = storage.createTeamMember({ name: "Long Tenure Rep", role: "rep", active: true, tenantId: 1 } as any).id;
    const user = storage.createUser({ name: "Long Tenure Rep", email: "long-spiff@example.com", role: "rep", active: true, tenantId: 1, teamMemberId: rep } as any);
    rawDb?.prepare("UPDATE users SET training_required = 0 WHERE id = ?").run((user as any).id);
    const session = storage.createSession(user.id).id;
    let expected = 0;
    for (let i = 0; i < 120; i++) {
      const cents = 2500 + (i % 6) * 500;
      expected += cents;
      insertSpiff(1, rep, `feed:${i}`, "earned", "random", cents);
    }
    const body = await (await request("/api/spiffs/mine", session)).json() as any;
    expect(body.spiffs.length).toBe(100);           // feed is bounded…
    expect(body.totals.count).toBe(120);            // …totals are not
    expect(body.totals.earnedCents).toBe(expected); // exact integer cents
    expect(Number.isInteger(body.totals.earnedCents)).toBe(true);
  });

  it("publishes the live award band so the rep UI can't hardcode the wrong numbers", async () => {
    const body = await (await request("/api/spiffs/mine", repSession)).json() as any;
    expect(body.band).toMatchObject({ minCents: 2500, maxCents: 5000, incrementCents: 500 });
    expect(body.band.ladderCents).toEqual([2500, 3000, 3500, 4000, 4500, 5000]);
    expect(body.band.triggers.map((t: any) => t.reason).sort()).toEqual(["improvement", "milestone", "random", "streak"]);
  });
});
