// ── RBAC / authorization audit ───────────────────────────────────────────────
//
// One organization with TWO independent teams (so cross-team writes are
// testable) plus the non-field identities (calling_rep, compliance_admin,
// auditor) and a second organization used only to probe the by-id lookups.
//
// ══ EXPECTED-RED (marked `it.fails`) — confirmed authorization gaps ══
//   R1. "GET /api/governance/user/:id/capabilities discloses another org's member"
//       server/routes.ts:6321 calls storage.getTeamMemberById(id) WITHOUT the
//       optional tenantId and never compares row.tenantId to the caller's, so a
//       tenant admin can walk the member-id space and read foreign names/roles.
//       (routes.ts:6324 also calls storage.getAllUsers() with no tenant filter.)
//   R2. "POST /api/territories/:id/complete accepts another team's area"
//       server/routes.ts:5081 is the ONE territory lifecycle route reachable by
//       team_lead that omits canManageTerritory(); every sibling (assign,
//       history, PATCH, DELETE) enforces it.
//
// Everything else here is GREEN and pins down the role/capability boundaries
// that currently hold.
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

const TENANT_A = 1;
const TENANT_B = 2;

type Person = { userId: number; memberId: number; session: string };
const who: Record<string, Person> = {};
const ids = {
  team1Territory: 0, team2Territory: 0,
  team1Lead: 0, team2Lead: 0, poolLead: 0,
  foreignMemberId: 0,
};

function req(path: string, sessionId: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-session-id": sessionId, ...(init.headers ?? {}) },
  });
}

function person(name: string, memberRole: string, opts: { loginRole?: string; reportsToId?: number | null; tenantId?: number } = {}): Person {
  const tenantId = opts.tenantId ?? TENANT_A;
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}.${tenantId}@rbac.example.test`;
  const member = storage.createTeamMember({
    name, email, role: memberRole, active: true, tenantId, reportsToId: opts.reportsToId ?? null,
  } as any);
  const user = storage.createUser({
    name, email, role: opts.loginRole ?? memberRole, active: true, tenantId, teamMemberId: member.id,
  } as any);
  return { userId: user.id, memberId: member.id, session: storage.createSession(user.id).id };
}

const mkLead = (address: string, repId: number | null) =>
  storage.createLead({
    address, city: "Kannapolis", state: "NC", zip: "28081", lat: 35.49, lng: -80.62,
    fiberStatus: "available", leadStatus: "new", tenantId: TENANT_A, assignedRepId: repId,
  } as any).id;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-rbac-audit-"));
  process.env.NODE_ENV = "test";

  const storageModule = await import("../../server/storage");
  storageModule.runMigrations();
  storage = storageModule.storage;
  ({ rawDb } = await import("../../server/db"));

  rawDb.prepare(
    `INSERT OR IGNORE INTO tenants (id, slug, company_name, owner_name, owner_email, brand_name)
     VALUES (?, 'beacon-rbac', 'Beacon Fiber', 'Owner B', 'owner-b@rbac.example.test', 'Beacon')`,
  ).run(TENANT_B);

  // Org chart, tenant A:
  //   admin, manager
  //   teamLead1 → rep1        teamLead2 → rep2      (two independent teams)
  //   plus the non-field identities
  who.admin = person("Org Admin", "manager", { loginRole: "admin" });
  who.manager = person("Org Manager", "manager");
  who.teamLead1 = person("Lead One", "team_lead");
  who.teamLead2 = person("Lead Two", "team_lead");
  who.rep1 = person("Rep One", "rep", { reportsToId: who.teamLead1.memberId });
  who.rep2 = person("Rep Two", "rep", { reportsToId: who.teamLead2.memberId });
  who.callingRep = person("Caller Cass", "rep", { loginRole: "calling_rep" });
  who.complianceAdmin = person("Compliance Cal", "rep", { loginRole: "compliance_admin" });
  who.auditor = person("Auditor Ada", "rep", { loginRole: "auditor" });

  // A second organization — only used as an id-space probe target.
  who.foreignAdmin = person("Beacon Admin", "manager", { loginRole: "admin", tenantId: TENANT_B });
  ids.foreignMemberId = who.foreignAdmin.memberId;

  // Leads: one per team plus an unassigned pool lead.
  ids.team1Lead = mkLead("100 Oak St", who.rep1.memberId);
  ids.team2Lead = mkLead("101 Oak St", who.rep2.memberId);
  ids.poolLead = mkLead("102 Oak St", null);

  const square = (dx: number) => JSON.stringify([
    [-80.7 + dx, 35.4], [-80.6 + dx, 35.4], [-80.6 + dx, 35.5], [-80.7 + dx, 35.5],
  ]);
  ids.team1Territory = storage.createTerritory({
    tenantId: TENANT_A, name: "Team One area", repId: who.rep1.memberId, polygon: square(0),
    color: "#111", status: "active", assigneeIds: JSON.stringify([who.rep1.memberId]),
  } as any).id;
  ids.team2Territory = storage.createTerritory({
    tenantId: TENANT_A, name: "Team Two area", repId: who.rep2.memberId, polygon: square(1),
    color: "#222", status: "active", assigneeIds: JSON.stringify([who.rep2.memberId]),
  } as any).id;

  const { registerRoutes, registerSaasRoutes } = await import("../../server/routes");
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  server = createServer(app);
  registerRoutes(server, app);
  registerSaasRoutes(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

// ═══════════════════════════════════════════════════════════════════════════
// EXPECTED-RED — confirmed authorization gaps.
// ═══════════════════════════════════════════════════════════════════════════
describe("CONFIRMED AUTHORIZATION GAPS (expected red until fixed)", () => {
  it("R1: GET /api/governance/user/:id/capabilities must 404 on another org's member", async () => {
    const res = await req(`/api/governance/user/${ids.foreignMemberId}/capabilities`, who.admin.session);
    expect(res.status).toBe(404);
    const body = await res.json().catch(() => ({}));
    expect(JSON.stringify(body)).not.toContain("Beacon Admin");
  });

  it("R2: POST /api/territories/:id/complete must refuse another team's area", async () => {
    const res = await req(`/api/territories/${ids.team2Territory}/complete`, who.teamLead1.session, {
      method: "POST", body: JSON.stringify({ notes: "closed by the wrong team" }),
    });
    expect(res.status).toBe(404);
    expect((storage.getTerritoryById(ids.team2Territory) as any).status).toBe("active");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// GREEN — boundaries that currently hold.
// ═══════════════════════════════════════════════════════════════════════════
describe("unauthenticated and revoked sessions fail closed", () => {
  it("no session → 401 on representative read/write routes", async () => {
    for (const path of ["/api/leads", "/api/team", "/api/commissions", "/api/activity-log"]) {
      const res = await fetch(`${baseUrl}${path}`);
      expect(res.status).toBe(401);
    }
  });

  it("a deactivated login's live session stops working immediately", async () => {
    const doomed = person("Temp Tina", "rep", { reportsToId: who.teamLead1.memberId });
    expect((await req("/api/leads", doomed.session)).status).toBe(200);
    storage.updateUser(doomed.userId, { active: false } as any, TENANT_A);
    expect((await req("/api/leads", doomed.session)).status).toBe(401);
  });
});

describe("reps are fail-closed on everything above their grade", () => {
  const denied: Array<[string, string, RequestInit?]> = [
    ["GET", "/api/users"],
    ["GET", "/api/activity-log"],
    ["GET", "/api/settings/geo"],
    ["GET", "/api/commission-rates"],
    ["GET", "/api/governance/capabilities"],
    ["GET", "/api/diagnostics"],
    ["GET", "/api/territory-requests"],
    ["GET", "/api/location-pings/latest"],
    ["POST", "/api/leads/bulk-assign", { body: JSON.stringify({ leadIds: [1], repId: 1 }) }],
    ["POST", "/api/leads/bulk-mark", { body: JSON.stringify({ leadIds: [1], mark: "priority" }) }],
    ["POST", "/api/territories", { body: JSON.stringify({ name: "x", polygon: "[]" }) }],
  ];
  for (const [method, path, init] of denied) {
    it(`${method} ${path} → 403 for a rep`, async () => {
      const res = await req(path, who.rep1.session, { method, ...(init ?? {}) });
      expect(res.status).toBe(403);
    });
  }

  it("a rep reads only their own doors — a teammate's lead is a 404, not a 403", async () => {
    expect((await req(`/api/leads/${ids.team1Lead}`, who.rep1.session)).status).toBe(200);
    expect((await req(`/api/leads/${ids.team2Lead}`, who.rep1.session)).status).toBe(404);
    // OPEN FIELD is OPT-IN and off for this tenant, so an unowned door is not
    // a rep's to read either — the same 404 as a teammate's lead. With the
    // tenant flag on it becomes readable; that path is covered end-to-end in
    // knock-open-field.test.ts, which switches it on.
    expect((await req(`/api/leads/${ids.poolLead}`, who.rep1.session)).status).toBe(404);
    const list = await (await req("/api/leads", who.rep1.session)).json();
    expect(list.leads.map((l: any) => l.id)).toEqual([ids.team1Lead]);
  });

  it("a rep cannot log a knock on a door that is not theirs", async () => {
    const res = await req(`/api/leads/${ids.team2Lead}/knock`, who.rep1.session, {
      method: "POST", body: JSON.stringify({ outcome: "sold", knockedAt: new Date().toISOString() }),
    });
    expect(res.status).toBe(404);
  });

  it("a rep cannot clock in another rep", async () => {
    const res = await req("/api/clock/in", who.rep1.session, {
      method: "POST", body: JSON.stringify({ repId: who.rep2.memberId }),
    });
    // The route pins a rep to themselves, so this clocks rep1 in — never rep2.
    expect(res.status).toBeLessThan(500);
    expect(storage.getActiveClockSession(who.rep2.memberId)).toBeUndefined();
  });
});

describe("team leads are bounded to their own team", () => {
  it("a team lead's roster and lead list stop at their team", async () => {
    const roster = await (await req("/api/team", who.teamLead1.session)).json();
    const rosterIds = roster.map((m: any) => m.id);
    expect(rosterIds).toContain(who.rep1.memberId);
    expect(rosterIds).not.toContain(who.rep2.memberId);

    const list = await (await req("/api/leads", who.teamLead1.session)).json();
    expect(list.leads.map((l: any) => l.id)).not.toContain(ids.team2Lead);
  });

  it("a team lead cannot assign a lead to a rep on another team", async () => {
    const res = await req(`/api/leads/${ids.poolLead}/assign`, who.teamLead1.session, {
      method: "POST", body: JSON.stringify({ repId: who.rep2.memberId }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("OUT_OF_SCOPE");
  });

  it("a team lead cannot steal a lead already owned by another team", async () => {
    const res = await req(`/api/leads/${ids.team2Lead}/assign`, who.teamLead1.session, {
      method: "POST", body: JSON.stringify({ repId: who.rep1.memberId }),
    });
    expect(res.status).toBe(403);
    expect(storage.getLeadById(ids.team2Lead)!.assignedRepId).toBe(who.rep2.memberId);
  });

  it("bulk-assign leaves another team's leads untouched", async () => {
    const res = await req("/api/leads/bulk-assign", who.teamLead1.session, {
      method: "POST",
      body: JSON.stringify({ leadIds: [ids.poolLead, ids.team2Lead], repId: who.rep1.memberId }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.updated).toBe(1);
    expect(body.skipped).toBe(1);
    expect(storage.getLeadById(ids.team2Lead)!.assignedRepId).toBe(who.rep2.memberId);
  });

  it("a team lead cannot rename or delete another team's area", async () => {
    expect((await req(`/api/territories/${ids.team2Territory}`, who.teamLead1.session, {
      method: "PATCH", body: JSON.stringify({ name: "seized" }),
    })).status).toBe(404);
    expect((await req(`/api/territories/${ids.team2Territory}`, who.teamLead1.session, { method: "DELETE" })).status).toBe(404);
    expect((await req(`/api/territories/${ids.team2Territory}/history`, who.teamLead1.session)).status).toBe(404);
    expect(storage.getTerritoryById(ids.team2Territory)!.name).toBe("Team Two area");
  });

  it("a team lead cannot edit or offboard a peer team lead (strictly-above rule)", async () => {
    const patch = await req(`/api/team/${who.teamLead2.memberId}`, who.teamLead1.session, {
      method: "PATCH", body: JSON.stringify({ email: "hijack@rbac.example.test" }),
    });
    expect(patch.status).toBe(403);
    const kick = await req(`/api/team/${who.teamLead2.memberId}/offboard`, who.teamLead1.session, {
      method: "POST", body: "{}",
    });
    expect(kick.status).toBe(403);
    expect(storage.getTeamMemberById(who.teamLead2.memberId)!.active).toBe(true);
  });

  it("a team lead cannot hard-delete a member at all (manager+ only)", async () => {
    expect((await req(`/api/team/${who.rep1.memberId}`, who.teamLead1.session, { method: "DELETE" })).status).toBe(403);
  });
});

describe("non-field identities never inherit the field app", () => {
  for (const role of ["callingRep", "complianceAdmin", "auditor"] as const) {
    it(`${role} is refused field.app.use surfaces`, async () => {
      for (const path of ["/api/team", "/api/territories", "/api/commissions", "/api/clock/status"]) {
        const res = await req(path, who[role].session);
        expect(res.status).toBe(403);
        expect((await res.json()).need).toBe("field.app.use");
      }
    });
  }

  it("an auditor may read org audit but never write commission structure or pay", async () => {
    expect((await req("/api/diagnostics", who.auditor.session)).status).toBe(200);
    expect((await req("/api/commission-rates", who.auditor.session)).status).toBe(403);
    expect((await req("/api/payouts/week/pay", who.auditor.session, { method: "POST", body: "{}" })).status).toBe(403);
    expect((await req("/api/governance/capabilities", who.auditor.session)).status).toBe(403);
  });

  it("a compliance identity reading /api/leads gets an EMPTY scope, not the org", async () => {
    const res = await req("/api/leads", who.complianceAdmin.session);
    expect(res.status).toBe(200);
    expect((await res.json()).leads).toEqual([]);
  });
});

describe("money authority is narrower than oversight", () => {
  it("a manager may preview payouts but may NOT execute them (payouts.pay is admin-only)", async () => {
    const pay = await req("/api/payouts/week/pay", who.manager.session, { method: "POST", body: "{}" });
    expect(pay.status).toBe(403);
    expect((await pay.json()).need).toBe("payouts.pay");
  });

  it("a team lead cannot set their OWN commission structure (self-deal guard)", async () => {
    const res = await req("/api/commission/assign-structure", who.teamLead1.session, {
      method: "POST",
      body: JSON.stringify({ repId: who.teamLead1.memberId, structure: "FLAT", flatRateCents: 50_000 }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("COMMISSION_SELF_DEAL");
  });

  it("a team lead cannot set a commission structure for a rep outside their team", async () => {
    const res = await req("/api/commission/assign-structure", who.teamLead1.session, {
      method: "POST",
      body: JSON.stringify({ repId: who.rep2.memberId, structure: "FLAT", flatRateCents: 50_000 }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("UNAUTHORIZED_COMMISSION_ACTION");
  });

  it("a rep reads only their OWN commission rows", async () => {
    const res = await req("/api/commissions", who.rep1.session);
    expect(res.status).toBe(200);
    const rows = (await res.json()) as any[];
    expect(rows.every((c) => c.repId === who.rep1.memberId)).toBe(true);
  });
});

describe("platform-owner surfaces reject an ordinary tenant admin", () => {
  it("the /api/sa tenant console is super-admin only", async () => {
    for (const path of ["/api/sa/tenants", "/api/sa/billing", "/api/sa/revenue", `/api/sa/tenants/${TENANT_B}`]) {
      expect((await req(path, who.admin.session)).status).toBe(403);
    }
  });

  it("billing mutations are platform-owner only", async () => {
    const res = await req("/api/billing/credits", who.admin.session, {
      method: "POST", body: JSON.stringify({ credits: 1000 }),
    });
    expect(res.status).toBe(403);
  });

  it("a tenant admin cannot claim the reserved platform-apex email", async () => {
    const apex = (process.env.SUPER_ADMIN_EMAILS ?? "muizzm21@gmail.com").split(",")[0].trim();
    const res = await req(`/api/users/${who.manager.userId}`, who.admin.session, {
      method: "PATCH", body: JSON.stringify({ email: apex }),
    });
    expect(res.status).toBe(403);
  });

  it("/api/admin/history is walled to the caller's own organization", async () => {
    const res = await req(`/api/admin/history?tenantId=${TENANT_B}`, who.admin.session);
    expect(res.status).toBe(200);
    // A non-super caller can never widen the filter to another org.
    expect((await res.json()).scope).toBe(`tenant:${TENANT_A}`);
  });
});
