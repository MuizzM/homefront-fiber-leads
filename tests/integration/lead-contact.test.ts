// Door-captured contact identity — PATCH /api/leads/:id/contact.
//
// The endpoint mirrors the notes route's walls (lead.note.write gate, tenant
// 404, repCanAccessLead 404) and adds two of its own invariants:
//   (a) phone data is STRUCTURALLY refused — numbers enter through the Calling
//       compliance module or nowhere (same rule as POST /api/leads);
//   (b) only contact_name/contact_email can change — nothing else rides along.
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let server: Server; let baseUrl: string; let storage: any;
const fx: Record<string, any> = {};

function person(name: string, role: string, tenantId = 1) {
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}@ct.test`;
  const m = storage.createTeamMember({ name, email, role, active: true, tenantId } as any);
  const u = storage.createUser({ name, email, role, active: true, tenantId, teamMemberId: m.id } as any);
  return { userId: u.id, memberId: m.id, session: storage.createSession(u.id).id, name };
}
function req(path: string, session: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, { ...init, headers: {
    "content-type": "application/json", "x-session-id": session, "x-csrf-token": session, ...init.headers } });
}
const patchContact = (leadId: number, session: string, body: any) =>
  req(`/api/leads/${leadId}/contact`, session, { method: "PATCH", body: JSON.stringify(body) });

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-ct-"));
  process.env.NODE_ENV = "test";
  const mod = await import("../../server/storage");
  mod.runMigrations(); storage = mod.storage;
  fx.rep = person("Rita Rep", "rep");
  fx.otherRep = person("Omar Other", "rep");
  fx.manager = person("Mona Manager", "manager");
  const { registerRoutes, registerSaasRoutes } = await import("../../server/routes");
  const app = express(); app.use(express.json()); server = createServer(app);
  registerRoutes(server, app); registerSaasRoutes(app);
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(() => new Promise<void>(r => server.close(() => r())));

let seq = 0;
const seedLead = (over: any = {}) => storage.createLead({
  address: `${++seq} Contact Court`, city: "Conroe", state: "TX", zip: "77304",
  lat: 30.31 + seq * 1e-4, lng: -95.47, tenantId: 1, leadStatus: "prospect", ...over,
} as any).id;

describe("PATCH /api/leads/:id/contact", () => {
  it("a rep records the name the resident gave, and can add the email later", async () => {
    const lead = seedLead({ assignedRepId: fx.rep.memberId });
    const r1 = await patchContact(lead, fx.rep.session, { contactName: "  Dana Reyes " });
    expect(r1.status).toBe(200);
    expect(await r1.json()).toMatchObject({ contactName: "Dana Reyes", contactEmail: null });
    const r2 = await patchContact(lead, fx.rep.session, { contactEmail: "Dana@Example.COM" });
    expect(r2.status).toBe(200);
    // Email normalizes to lowercase; the earlier name survives a partial patch.
    expect(await r2.json()).toMatchObject({ contactName: "Dana Reyes", contactEmail: "dana@example.com" });
    const row = storage.getLeadById(lead);
    expect(row.contactName).toBe("Dana Reyes");
    expect(row.contactEmail).toBe("dana@example.com");
  });

  it("phone data is refused with the calling-module error, exactly like lead create", async () => {
    const lead = seedLead({ assignedRepId: fx.rep.memberId });
    for (const body of [
      { contactName: "X", contactPhone: "5551234567" },
      { ownerPhone: "5551234567" },
      { phone: "5551234567" },
    ]) {
      const r = await patchContact(lead, fx.rep.session, body);
      expect(r.status).toBe(400);
      expect((await r.json()).code).toBe("CALLING_MODULE_REQUIRED");
    }
    expect(storage.getLeadById(lead).contactName ?? null).toBeNull(); // nothing landed
  });

  it("validates: junk email 400s, clearing with null works, empty body 400s", async () => {
    const lead = seedLead({ assignedRepId: fx.rep.memberId });
    expect((await patchContact(lead, fx.rep.session, { contactEmail: "not-an-email" })).status).toBe(400);
    expect((await patchContact(lead, fx.rep.session, {})).status).toBe(400);
    await patchContact(lead, fx.rep.session, { contactName: "Temp Name" });
    const r = await patchContact(lead, fx.rep.session, { contactName: null });
    expect(r.status).toBe(200);
    expect(storage.getLeadById(lead).contactName ?? null).toBeNull();
  });

  it("scope wall: a rep cannot write another rep's door (404, never 403)", async () => {
    const lead = seedLead({ assignedRepId: fx.rep.memberId });
    const r = await patchContact(lead, fx.otherRep.session, { contactName: "Should Not Land" });
    expect(r.status).toBe(404);
    expect(storage.getLeadById(lead).contactName ?? null).toBeNull();
  });

  it("tenant wall: a manager in another tenant gets 404", async () => {
    const otherTenantMgr = person("Tessa Two", "manager", 2);
    const lead = seedLead({ assignedRepId: fx.rep.memberId }); // tenant 1
    const r = await patchContact(lead, otherTenantMgr.session, { contactName: "Cross Tenant" });
    expect(r.status).toBe(404);
    expect(storage.getLeadById(lead).contactName ?? null).toBeNull();
  });

  it("the card read returns what was captured (GET /api/leads/:id carries both fields)", async () => {
    const lead = seedLead({ assignedRepId: fx.rep.memberId });
    await patchContact(lead, fx.rep.session, { contactName: "Kim Vo", contactEmail: "kim@vo.example" });
    const detail = await (await req(`/api/leads/${lead}`, fx.rep.session)).json();
    expect(detail.contactName).toBe("Kim Vo");
    expect(detail.contactEmail).toBe("kim@vo.example");
  });
});
