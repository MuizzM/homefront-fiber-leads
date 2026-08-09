// Central Mark history attribution.
//
// A status changed through Central Mark must read "Central Admin marked
// [status]" in the lead's History — NEVER a rep's name. If a lead was never
// assigned to a rep, that rep's name must never appear anywhere in its history.
// The bug: central-disposition stamped a knock with a DERIVED rep id
// (acting member → assigned rep → the tenant's first active member), and
// history rendered that rep's name. These tests pin the corrected attribution:
// the display actor is "Central Admin", the REAL actor is preserved in the
// audit log, and the write is idempotent.
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let server: Server; let baseUrl: string; let storage: any; let rawDb: any;
const fx: Record<string, any> = {};

function person(name: string, role: string, tenantId = 1) {
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}@cm.test`;
  const m = storage.createTeamMember({ name, email, role, active: true, tenantId } as any);
  const u = storage.createUser({ name, email, role, active: true, tenantId, teamMemberId: m.id } as any);
  return { userId: u.id, memberId: m.id, session: storage.createSession(u.id).id, name };
}
function req(path: string, session: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, { ...init, headers: {
    "content-type": "application/json", "x-session-id": session, "x-csrf-token": session, ...(init.headers ?? {}) } });
}
const hist = async (leadId: number, session: string) => (await req(`/api/leads/${leadId}/history`, session)).json();
const central = (leadId: number, session: string, body: any) =>
  req(`/api/leads/${leadId}/central-disposition`, session, { method: "POST", body: JSON.stringify(body) });

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-cm-"));
  process.env.NODE_ENV = "test";
  const mod = await import("../../server/storage");
  mod.runMigrations(); storage = mod.storage;
  ({ rawDb } = await import("../../server/db"));
  fx.manager = person("Mona Manager", "manager");
  fx.manager2 = person("Ravi Second", "manager");
  fx.assignedRep = person("Ann Rivera", "rep");
  const { registerRoutes, registerSaasRoutes } = await import("../../server/routes");
  const app = express(); app.use(express.json()); server = createServer(app);
  registerRoutes(server, app); registerSaasRoutes(app);
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(() => new Promise<void>(r => server.close(() => r())));

let seq = 0;
const seedLead = (over: any = {}) => storage.createLead({
  address: `${++seq} Abbie Avenue`, city: "High Point", state: "NC", zip: "27263",
  lat: 35.95, lng: -80.0, tenantId: 1, leadStatus: "prospect", ...over,
} as any).id;

// Any name of a real rep must not appear on a central-mark history row.
const allNames = () => ["Mona Manager", "Ravi Second", "Ann Rivera"];
function statusRow(rows: any[]) { return rows.find(r => r.type === "status_change"); }

describe("Central Mark attribution", () => {
  it("an UNASSIGNED lead shows 'Central Admin', never a rep's name", async () => {
    const lead = seedLead({ assignedRepId: null });
    expect((await central(lead, fx.manager.session, { outcome: "not_interested" })).status).toBe(200);
    const rows = await hist(lead, fx.manager.session);
    const row = statusRow(rows);
    expect(row).toBeTruthy();
    expect(row.status).toBe("not_interested");
    expect(row.actor).toBe("Central Admin");
    // No rep/manager name anywhere in the serialized history.
    const blob = JSON.stringify(rows);
    for (const n of allNames()) expect(blob).not.toContain(n);
  });

  it("an ASSIGNED lead central mark still shows 'Central Admin', not the assigned rep", async () => {
    const lead = seedLead({ assignedRepId: fx.assignedRep.memberId });
    await central(lead, fx.manager.session, { outcome: "sold" });
    const rows = await hist(lead, fx.manager.session);
    const row = statusRow(rows);
    expect(row.actor).toBe("Central Admin");
    expect(JSON.stringify(rows)).not.toContain("Ann Rivera");   // the assigned rep never appears
  });

  it("preserves the REAL actor in the audit log even though history says 'Central Admin'", async () => {
    const lead = seedLead({ assignedRepId: null });
    await central(lead, fx.manager.session, { outcome: "callback" });
    const audit = rawDb.prepare(
      `SELECT * FROM activity_log WHERE entity_type = 'lead' AND entity_id = ? AND action = 'lead.central_disposition'`,
    ).all(lead) as any[];
    expect(audit.length).toBeGreaterThan(0);
    expect(audit[0].user_id).toBe(fx.manager.userId);           // real initiating user, not "Central Admin"
  });

  it("a FIELD knock still attributes to the real rep (no regression)", async () => {
    const lead = seedLead({ assignedRepId: fx.assignedRep.memberId });
    // A genuine knock by the assigned rep.
    storage.createKnock({ leadId: lead, repId: fx.assignedRep.memberId, outcome: "interested", wasHome: true, knockedAt: new Date().toISOString() } as any);
    const rows = await hist(lead, fx.assignedRep.session);
    const row = statusRow(rows);
    expect(row.actor).toBe("Ann Rivera");                       // real field attribution kept
  });

  it("is idempotent - a double-tapped mark with the same key writes ONE event", async () => {
    const lead = seedLead({ assignedRepId: null });
    const body = { outcome: "sold", idempotencyKey: "cm-dup-1" };
    await central(lead, fx.manager.session, body);
    await central(lead, fx.manager.session, body);              // replay
    const rows = await hist(lead, fx.manager.session);
    expect(rows.filter((r: any) => r.type === "status_change").length).toBe(1);
  });

  it("two managers marking are two 'Central Admin' events, never a name collision", async () => {
    const lead = seedLead({ assignedRepId: null });
    await central(lead, fx.manager.session, { outcome: "not_home", idempotencyKey: "a" });
    await central(lead, fx.manager2.session, { outcome: "callback", idempotencyKey: "b" });
    const rows = await hist(lead, fx.manager.session);
    const statuses = rows.filter((r: any) => r.type === "status_change");
    expect(statuses.length).toBe(2);
    expect(statuses.every((r: any) => r.actor === "Central Admin")).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("Mona Manager");
    expect(JSON.stringify(rows)).not.toContain("Ravi Second");
  });
});

// ── The mark must SURVIVE the map read ────────────────────────────────────────
// The user-visible defect: Central Admin marks "Already a Customer" and the pin
// flips to "Not Interested" on the next refetch. "Already a customer" is stored
// as leadStatus=not_interested + lastOutcome=already_customer; the map query
// sourced lastOutcome from the knock_log join ONLY, and a central mark writes
// no knock row — so the disambiguating outcome vanished on every fresh load.
// The lead row's own last_outcome (kept monotonic by the knock CAS) is the
// authority; the knock join is a legacy fallback.
describe("central mark on the map read", () => {
  const pinOf = async (leadId: number) => {
    const body = await (await req("/api/leads/map", fx.manager.session)).json();
    return (body.pins as any[]).find(p => p.id === leadId);
  };

  it("already-customer on a NEVER-knocked lead survives a fresh map fetch", async () => {
    const leadId = seedLead();
    const r = await central(leadId, fx.manager.session, { outcome: "already_customer" });
    expect(r.status).toBe(200);
    const pin = await pinOf(leadId);
    expect(pin).toBeTruthy();
    expect(pin.leadStatus).toBe("not_interested");
    expect(pin.lastOutcome).toBe("already_customer");   // the disambiguator
  });

  it("a central mark NEWER than the last rep knock wins the pin", async () => {
    const leadId = seedLead();
    // A real knock yesterday (writes knock_log + the lead columns, as the CAS does).
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    rawDb.prepare(
      "INSERT INTO knock_log (lead_id, rep_id, outcome, was_home, knocked_at, notes) VALUES (?, ?, ?, 0, ?, NULL)",
    ).run(leadId, fx.assignedRep.memberId, "not_home", yesterday);
    storage.applyKnockOutcomeCas(leadId, "prospect", "not_home", yesterday);
    // Central mark today.
    const r = await central(leadId, fx.manager.session, { outcome: "already_customer" });
    expect(r.status).toBe(200);
    const pin = await pinOf(leadId);
    expect(pin.lastOutcome).toBe("already_customer");
    expect(pin.visited).toBe(true);                     // the knock still counts as a visit
  });

  it("legacy rows with knocks but no lead-level outcome still read the knock", async () => {
    const leadId = seedLead();
    const at = new Date(Date.now() - 3_600_000).toISOString();
    rawDb.prepare(
      "INSERT INTO knock_log (lead_id, rep_id, outcome, was_home, knocked_at, notes) VALUES (?, ?, ?, 1, ?, NULL)",
    ).run(leadId, fx.assignedRep.memberId, "interested", at);
    // Simulate a pre-CAS legacy row: knock exists, lead columns never written.
    rawDb.prepare("UPDATE leads SET last_outcome = NULL, last_outcome_at = NULL, lead_status = 'interested' WHERE id = ?").run(leadId);
    const pin = await pinOf(leadId);
    expect(pin.lastOutcome).toBe("interested");
  });
});
