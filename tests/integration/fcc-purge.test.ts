// FCC-import purge: bulk removal of UNWORKED fcc-tagged doors, made safe.
//
// GET /api/leads/fcc-purge/preview and POST /api/leads/fcc-purge are admin-only
// (same gate as the reclaim-all sweep). These tests pin the removal rule:
// only fcc-family tags ("fcc" or "fcc_<suffix>" — the underscore is escaped, so
// a "fccx1" tag can never ride the LIKE wildcard in), only the caller's tenant,
// and only doors with NO history of any kind: zero knocks, no recorded outcome,
// status still 'prospect', no commission/sale/photo rows, not do-not-knock.
// One audit row records the whole purge, and a second purge finds nothing.
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let server: Server;
let baseUrl: string;
let storage: (typeof import("../../server/storage"))["storage"];
let rawDb: import("better-sqlite3").Database;

type Person = { userId: number; memberId: number; session: string };
const fx: Record<string, Person> = {};

function person(name: string, role: string, tenantId = 1): Person {
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}@fccpurge.example.test`;
  const member = storage.createTeamMember({ name, email, role, active: true, tenantId } as any);
  const user = storage.createUser({ name, email, role, active: true, tenantId, teamMemberId: member.id } as any);
  return { userId: user.id, memberId: member.id, session: storage.createSession(user.id).id };
}

function req(path: string, session: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-session-id": session, "x-csrf-token": session, ...(init.headers ?? {}) },
  });
}

let addrSeq = 100;
function seedLead(over: Record<string, unknown> = {}, tenantId = 1): number {
  return storage.createLead({
    address: `${addrSeq++} Purge Ln`, city: "Testburg", state: "NC", zip: "28100",
    lat: 35.5, lng: -80.4, tenantId, leadStatus: "prospect",
    ...over,
  } as any).id;
}

const leadById = (id: number) => rawDb.prepare("SELECT * FROM leads WHERE id = ?").get(id) as any;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-fccpurge-"));
  process.env.NODE_ENV = "test";
  const mod = await import("../../server/storage");
  mod.runMigrations();
  storage = mod.storage;
  ({ rawDb } = await import("../../server/db"));

  fx.admin = person("Ada Admin", "admin");
  fx.manager = person("Mona Manager", "manager");
  fx.lead = person("Lee Lead", "team_lead");
  fx.rep = person("Rep Ann", "rep");

  // A second org whose FCC doors must never move under tenant 1's purge.
  storage.createTenant({ slug: "other", companyName: "Other", ownerName: "O", ownerEmail: "o@other.test", brandName: "Other", brandColor: "#111", plan: "trial", status: "active" } as any);
  fx.foreignAdmin = person("Zed Admin", "admin", 2);

  const { registerRoutes, registerSaasRoutes } = await import("../../server/routes");
  const app = express();
  app.use(express.json());
  server = createServer(app);
  registerRoutes(server, app);
  registerSaasRoutes(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const a = server.address();
  if (!a || typeof a === "string") throw new Error("no bind");
  baseUrl = `http://127.0.0.1:${a.port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
});

describe("who may purge", () => {
  it("a rep, a team lead, and a manager are all refused - preview and purge alike", async () => {
    for (const who of [fx.rep, fx.lead, fx.manager]) {
      expect((await req("/api/leads/fcc-purge/preview", who.session)).status).toBe(403);
      expect((await req("/api/leads/fcc-purge", who.session, { method: "POST", body: "{}" })).status).toBe(403);
    }
  });
});

describe("the removal rule", () => {
  // The full matrix, seeded once so preview and purge read the same world.
  const ids: Record<string, number> = {};

  it("preview reports the exact split: every fcc door counted, only the untouched removable", async () => {
    // REMOVABLE — fcc family, nothing has ever happened at the door.
    ids.freshUnworked = seedLead({ leadTag: "fcc_fresh_block" });
    ids.fiberUnworked = seedLead({ leadTag: "fcc_fiber_d25" });
    ids.bareFcc = seedLead({ leadTag: "fcc" });

    // PROTECTED — fcc family, but the door has history.
    ids.knocked = seedLead({ leadTag: "fcc_fresh_block" });
    storage.createKnock({ leadId: ids.knocked, repId: fx.rep.memberId, wasHome: false, outcome: "not_home" } as any);
    ids.hasOutcome = seedLead({ leadTag: "fcc_fiber_d25", lastOutcome: "not_home", lastOutcomeAt: new Date().toISOString() });
    ids.sold = seedLead({ leadTag: "fcc_fresh_block", leadStatus: "sold" });
    ids.followUp = seedLead({ leadTag: "fcc_fiber_d25", leadStatus: "follow_up" });
    ids.dnk = seedLead({ leadTag: "fcc_fresh_block", doNotKnock: true });
    ids.commissioned = seedLead({ leadTag: "fcc_fiber_d25" });
    storage.createCommission({ repId: fx.rep.memberId, tenantId: 1, leadId: ids.commissioned, amount: 100, saleDate: new Date().toISOString(), status: "pending" } as any);
    ids.saleLedger = seedLead({ leadTag: "fcc_fresh_block" });
    rawDb.prepare(
      "INSERT INTO commission_sales (tenant_id, rep_id, external_id, status, sold_at, lead_id) VALUES (1, ?, 'ext-fcc-1', 'PENDING', ?, ?)",
    ).run(fx.rep.memberId, new Date().toISOString(), ids.saleLedger);
    ids.photographed = seedLead({ leadTag: "fcc" });
    rawDb.prepare("INSERT INTO lead_photos (tenant_id, lead_id, path) VALUES (1, ?, 'lead-photos/x.jpg')").run(ids.photographed);

    // NOT FCC AT ALL — never counted, never touched.
    ids.plainUnworked = seedLead({ leadTag: null });
    ids.hotLead = seedLead({ leadTag: "hot_lead" });
    // Underscore-wildcard leak guard: "fccx1" would match LIKE 'fcc_%' if the
    // underscore weren't escaped. It is not fcc-family and must stay invisible.
    ids.fccx = seedLead({ leadTag: "fccx1" });

    // FOREIGN TENANT — identical unworked fcc door, out of scope entirely.
    ids.foreign = seedLead({ leadTag: "fcc_fresh_block" }, 2);

    const r = await req("/api/leads/fcc-purge/preview", fx.admin.session);
    expect(r.status).toBe(200);
    const p = await r.json();
    // 3 removable + 8 protected = 11 fcc doors in tenant 1; fccx/plain/hot_lead
    // and the foreign door are not in ANY bucket.
    expect(p).toEqual({ total: 11, removable: 3, protected: 8 });

    // The other org's admin sees only their own door.
    const rf = await req("/api/leads/fcc-purge/preview", fx.foreignAdmin.session);
    expect(await rf.json()).toEqual({ total: 1, removable: 1, protected: 0 });
  });

  it("purge removes exactly the unworked fcc set, writes ONE audit row, and is idempotent", async () => {
    const r = await req("/api/leads/fcc-purge", fx.admin.session, { method: "POST", body: "{}" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ removed: 3 });

    // Removed: the three untouched fcc-family doors.
    expect(leadById(ids.freshUnworked)).toBeUndefined();
    expect(leadById(ids.fiberUnworked)).toBeUndefined();
    expect(leadById(ids.bareFcc)).toBeUndefined();

    // Everything with history survives — worked, dispositioned, sold,
    // follow-up, do-not-knock, money-linked, photographed.
    for (const key of ["knocked", "hasOutcome", "sold", "followUp", "dnk", "commissioned", "saleLedger", "photographed"]) {
      expect(leadById(ids[key]), `${key} must be protected`).toBeDefined();
    }
    // Non-fcc doors and the literal-underscore lookalike survive.
    for (const key of ["plainUnworked", "hotLead", "fccx"]) {
      expect(leadById(ids[key]), `${key} is not fcc-family`).toBeDefined();
    }
    // The other tenant's door never moved.
    expect(leadById(ids.foreign)).toBeDefined();

    // ONE audit row records the whole purge, with the count.
    const audits = rawDb.prepare("SELECT * FROM admin_audit WHERE action = 'lead.fcc_purged'").all() as any[];
    expect(audits).toHaveLength(1);
    expect(audits[0].tenant_id).toBe(1);
    expect(JSON.parse(audits[0].after_json)).toEqual({ removed: 3 });
    expect(JSON.parse(audits[0].before_json).removable).toBe(3);

    // Idempotent: a second purge finds nothing, and the preview agrees.
    const again = await req("/api/leads/fcc-purge", fx.admin.session, { method: "POST", body: "{}" });
    expect(await again.json()).toEqual({ removed: 0 });
    const p = await (await req("/api/leads/fcc-purge/preview", fx.admin.session)).json();
    expect(p).toEqual({ total: 8, removable: 0, protected: 8 });
  });
});
