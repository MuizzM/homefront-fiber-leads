// Promotion keeps the tree valid in BOTH directions.
//
// The demotion direction was always handled: drop someone's rank and their
// now-too-senior reports get re-homed. The promotion direction was not. The
// reports-to validation in PATCH /api/team/:id only fires when the caller
// SENDS a supervisor, so a role-only PATCH — `{ role: "manager" }` — left the
// promoted member pointing at whoever they reported to before.
//
// Promote a rep who reports to a team lead and you got a MANAGER whose
// supervisor is a TEAM LEAD: an edge isValidSupervisorRole would reject on
// sight. And it was not cosmetic. Override chains walk UPWARD from the seller,
// so that inverted edge let a team lead sitting BELOW the new manager keep
// collecting the team-lead override on their reps' sales. The last test here
// is the one that matters: it follows the money, not the column.
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { beforeAll, afterAll, describe, expect, it } from "vitest";

let server: Server;
let baseUrl: string;
let storage: (typeof import("../../server/storage"))["storage"];
let rawDb: import("better-sqlite3").Database;
let svc: typeof import("../../server/commissionService");
let ov: typeof import("../../server/overrideStore");

const TENANT = 1;
type Person = { userId: number; memberId: number; session: string };
let admin: Person;

let seq = 0;
function person(name: string, role: string, reportsToId: number | null = null): Person {
  seq += 1;
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}.${seq}@promotion.example.test`;
  const member = storage.createTeamMember({ name, email, role, active: true, reportsToId, tenantId: TENANT } as any);
  const user = storage.createUser({ name, email, role, active: true, tenantId: TENANT, teamMemberId: member.id } as any);
  rawDb.prepare("UPDATE users SET training_required = 0 WHERE id = ?").run((user as any).id);
  return { userId: user.id, memberId: member.id, session: storage.createSession(user.id).id };
}

function patchMember(id: number, session: string, body: Record<string, unknown>) {
  return fetch(`${baseUrl}/api/team/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-session-id": session, "x-csrf-token": session },
    body: JSON.stringify(body),
  });
}

const reportsToOf = (id: number): number | null =>
  (rawDb.prepare("SELECT reports_to_id AS r FROM team_members WHERE id = ?").get(id) as any)?.r ?? null;

let leadSeq = 7000;
function sell(repId: number): number {
  leadSeq += 1;
  svc.recordFieldSaleFromKnock({
    tenantId: TENANT, repId, leadId: leadSeq, knockId: leadSeq,
    soldAt: new Date(Date.now() - 60_000).toISOString(),
    serverReceivedAt: new Date().toISOString(), actorId: null,
  });
  const sale = rawDb.prepare("SELECT id FROM commission_sales WHERE tenant_id = ? AND external_id = ?")
    .get(TENANT, `lead:${leadSeq}`) as any;
  return sale.id;
}
const beneficiariesOf = (saleId: number): Array<{ b: number; role: string; cents: number }> =>
  rawDb.prepare(
    "SELECT beneficiary_rep_id AS b, beneficiary_role AS role, amount_cents AS cents FROM commission_overrides WHERE source_ref = ?",
  ).all(`sale:${saleId}`) as any[];

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-promotion-hierarchy-"));
  process.env.NODE_ENV = "test";
  const storageModule = await import("../../server/storage");
  storageModule.runMigrations();
  storage = storageModule.storage;
  ({ rawDb } = await import("../../server/db"));
  svc = await import("../../server/commissionService");
  ov = await import("../../server/overrideStore");

  // Install hold off; overrides on at the 25/75 split.
  rawDb.prepare(
    "INSERT OR REPLACE INTO tenant_pay_policy (tenant_id, require_install_confirm, hold_days, updated_at) VALUES (?, 0, 90, datetime('now'))",
  ).run(TENANT);
  svc.updateOrgConfig(TENANT, null, {
    overridesEnabled: true, overrideTeamLeadCents: 2500, overrideManagerCents: 7500,
  } as any);

  admin = person("Promo Admin", "admin");

  const { registerRoutes } = await import("../../server/routes");
  const app = express();
  app.use(express.json());
  server = createServer(app);
  registerRoutes(server, app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
});

describe("promotion revalidates the promoted member's OWN supervisor", () => {
  it("a rep promoted to manager leaves the team lead they used to report to", async () => {
    const mgr = person("Owner Mgr", "manager");
    const tl = person("Mid Lead", "team_lead", mgr.memberId);
    const rep = person("Rising Rep", "rep", tl.memberId);

    const res = await patchMember(rep.memberId, admin.session, { role: "manager" });
    expect(res.status).toBe(200);
    const body = await res.json() as any;

    // The tree: a manager can report to nobody, so they land top level.
    expect(reportsToOf(rep.memberId)).toBeNull();
    // The RESPONSE must say so too — it used to echo the stale supervisor.
    expect(body.reportsToId ?? null).toBeNull();

    const audit = rawDb.prepare(
      "SELECT details FROM activity_log WHERE action = 'team.member.role_changed' AND entity_id = ? ORDER BY id DESC LIMIT 1",
    ).get(String(rep.memberId)) as any;
    expect(JSON.parse(audit.details)).toMatchObject({ supervisorCleared: true, priorSupervisorId: tl.memberId });
  });

  it("a promotion the old supervisor still outranks keeps that supervisor", async () => {
    const mgr = person("Keeper Mgr", "manager");
    const rep = person("Steady Rep", "rep", mgr.memberId);

    // rep -> team_lead: a manager still outranks a team lead, so nothing moves.
    expect((await patchMember(rep.memberId, admin.session, { role: "team_lead" })).status).toBe(200);
    expect(reportsToOf(rep.memberId)).toBe(mgr.memberId);
  });

  it("an explicit supervisor in the same request is honored, not overwritten", async () => {
    const mgrA = person("Explicit Mgr A", "manager");
    const mgrB = person("Explicit Mgr B", "manager");
    const rep = person("Moving Rep", "rep", mgrA.memberId);

    const res = await patchMember(rep.memberId, admin.session, { role: "team_lead", reportsToId: mgrB.memberId });
    expect(res.status).toBe(200);
    expect(reportsToOf(rep.memberId)).toBe(mgrB.memberId);
  });

  it("demotion still re-homes reports that outgrew their supervisor", async () => {
    const mgr = person("Demo Mgr", "manager");
    const tl = person("Falling Lead", "team_lead", mgr.memberId);
    const rep = person("Orphan Risk", "rep", tl.memberId);

    expect((await patchMember(tl.memberId, admin.session, { role: "rep" })).status).toBe(200);
    // The rep cannot report to a rep — re-homed up to the demoted member's own
    // supervisor rather than left dangling.
    expect(reportsToOf(rep.memberId)).toBe(mgr.memberId);
  });
});

describe("THE MONEY: an inverted edge must not pay a team lead who sits below the manager", () => {
  it("after promotion, the old team lead stops earning on the new manager's reps", async () => {
    const topMgr = person("Top Mgr", "manager");
    const oldLead = person("Old Lead", "team_lead", topMgr.memberId);
    const promoted = person("Promoted Mgr", "rep", oldLead.memberId);
    const seller = person("Downline Seller", "rep", promoted.memberId);

    // BEFORE: seller -> promoted(rep) -> oldLead(team_lead) -> topMgr(manager).
    // The team lead legitimately earns here.
    const before = beneficiariesOf(sell(seller.memberId));
    expect(before.find(r => r.b === oldLead.memberId)?.cents).toBe(2500);
    expect(before.find(r => r.b === topMgr.memberId)?.cents).toBe(7500);

    // Promote the middle member to manager, role only — the exact PATCH that
    // used to leave `promoted.reports_to = oldLead`.
    expect((await patchMember(promoted.memberId, admin.session, { role: "manager" })).status).toBe(200);

    // AFTER: seller -> promoted(manager, top level). The chain stops at the new
    // manager. The old team lead is no longer above the seller, so they must
    // earn nothing — and no team lead fills that slot at all.
    const after = beneficiariesOf(sell(seller.memberId));
    expect(after.find(r => r.b === oldLead.memberId)).toBeUndefined();
    expect(after.find(r => r.b === topMgr.memberId)).toBeUndefined();
    expect(after.find(r => r.b === promoted.memberId)).toMatchObject({ role: "manager", cents: 7500 });
    expect(after.filter(r => r.role === "team_lead")).toHaveLength(0);
  });

  it("sales already earned keep paying the chain that was frozen onto them", () => {
    const mgr = person("Frozen Mgr", "manager");
    const lead = person("Frozen Lead", "team_lead", mgr.memberId);
    const rep = person("Frozen Rep", "rep", lead.memberId);

    const saleId = sell(rep.memberId);
    const earned = beneficiariesOf(saleId);
    expect(earned.find(r => r.b === lead.memberId)?.cents).toBe(2500);

    // Reshape the tree underneath that settled sale.
    rawDb.prepare("UPDATE team_members SET reports_to_id = NULL WHERE id = ?").run(rep.memberId);
    ov.syncOverridesForSale(TENANT, saleId, null,
      (rawDb.prepare("SELECT earned_week_start_utc AS w FROM commission_overrides WHERE sale_id = ? LIMIT 1").get(saleId) as any).w);

    // Untouched: the row carries its own frozen chain.
    expect(beneficiariesOf(saleId).find(r => r.b === lead.memberId)?.cents).toBe(2500);
  });
});
