// Follow-ups read model — lead-level dispositions must count.
//
// getOpenCallbacks used to decide "open" purely from knock_log (latest knock
// outcome='callback'). But central-disposition / bulk-status / PATCH write ONLY
// the leads row (no knock), so:
//   (a) a manager centrally closing a door (not_interested/sold) left the rep's
//       scheduled callback in Follow-ups forever;
//   (b) a central/bulk mark INTO follow_up could never appear in Follow-ups.
// Also: route scoping followed the KNOCKER (r.repId), so a reassigned door's
// follow-up stuck to the old rep instead of the current owner.
// And: the map projection dropped do_not_knock entirely.
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let server: Server; let baseUrl: string; let storage: any;
const fx: Record<string, any> = {};

function person(name: string, role: string, tenantId = 1) {
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}@fu.test`;
  const m = storage.createTeamMember({ name, email, role, active: true, tenantId } as any);
  const u = storage.createUser({ name, email, role, active: true, tenantId, teamMemberId: m.id } as any);
  return { userId: u.id, memberId: m.id, session: storage.createSession(u.id).id, name };
}
function req(path: string, session: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, { ...init, headers: {
    "content-type": "application/json", "x-session-id": session, "x-csrf-token": session, ...(init.headers ?? {}) } });
}
const followups = async (session: string) => (await req("/api/followups", session)).json() as Promise<any[]>;
const central = (leadId: number, session: string, body: any) =>
  req(`/api/leads/${leadId}/central-disposition`, session, { method: "POST", body: JSON.stringify(body) });

// Local-calendar date (matches shared/knock.ts todayISO) — callbackDate for a
// lead-level follow-up derives from last_outcome_at in LOCAL time.
function localDateOf(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-fu-"));
  process.env.NODE_ENV = "test";
  const mod = await import("../../server/storage");
  mod.runMigrations(); storage = mod.storage;
  fx.manager = person("Mona Manager", "manager");
  fx.repA = person("Alan Knocker", "rep");
  fx.repB = person("Bella Newowner", "rep");
  const { registerRoutes, registerSaasRoutes } = await import("../../server/routes");
  const app = express(); app.use(express.json()); server = createServer(app);
  registerRoutes(server, app); registerSaasRoutes(app);
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(() => new Promise<void>(r => server.close(() => r())));

let seq = 0;
const seedLead = (over: any = {}) => storage.createLead({
  address: `${++seq} Beacon Court`, city: "High Point", state: "NC", zip: "27263",
  lat: 35.95 + seq * 1e-4, lng: -80.0, tenantId: 1, leadStatus: "prospect", ...over,
} as any).id;

// A real field callback: knock row + the lead-column CAS the knock route runs.
function knockCallback(leadId: number, repId: number, knockedAt: string, callbackDate: string) {
  storage.createKnock({
    leadId, repId, outcome: "callback", wasHome: true, knockedAt,
    callbackDate, callbackTime: "14:00",
  } as any);
  storage.applyKnockOutcomeCas(leadId, "follow_up", "callback", knockedAt);
}

const yesterday = () => new Date(Date.now() - 86_400_000).toISOString();
const tomorrowDate = () => localDateOf(new Date(Date.now() + 86_400_000).toISOString());

describe("Follow-ups vs lead-level dispositions", () => {
  it("a centrally-closed door LEAVES Follow-ups", async () => {
    const lead = seedLead({ assignedRepId: fx.repA.memberId });
    knockCallback(lead, fx.repA.memberId, yesterday(), tomorrowDate());
    // Open before the central mark — for the rep AND the org-wide manager view.
    expect((await followups(fx.repA.session)).some(f => f.leadId === lead)).toBe(true);
    expect((await followups(fx.manager.session)).some(f => f.leadId === lead)).toBe(true);
    // Manager centrally closes the door — a leads-row-only write, no knock.
    expect((await central(lead, fx.manager.session, { outcome: "not_interested" })).status).toBe(200);
    expect((await followups(fx.manager.session)).some(f => f.leadId === lead)).toBe(false);
    expect((await followups(fx.repA.session)).some(f => f.leadId === lead)).toBe(false);
  });

  it("a newer lead-level callback/follow_up KEEPS the scheduled callback open", async () => {
    const lead = seedLead({ assignedRepId: fx.repA.memberId });
    const date = tomorrowDate();
    knockCallback(lead, fx.repA.memberId, yesterday(), date);
    // A newer central mark that is itself a follow-up must not close the door.
    expect((await central(lead, fx.manager.session, { outcome: "follow_up" })).status).toBe(200);
    const rows = (await followups(fx.repA.session)).filter(f => f.leadId === lead);
    expect(rows).toHaveLength(1);            // exactly one row — never a duplicate
    expect(rows[0].callbackDate).toBe(date); // the ORIGINAL scheduled date survives
  });

  it("a central mark INTO follow_up on a never-knocked lead APPEARS in Follow-ups", async () => {
    const lead = seedLead({ assignedRepId: fx.repA.memberId });
    expect((await central(lead, fx.manager.session, { outcome: "follow_up" })).status).toBe(200);
    const row = (await followups(fx.repA.session)).find(f => f.leadId === lead);
    expect(row).toBeTruthy();
    // No knock ever existed — callbackDate derives from the mark's own local
    // date so the row lands in Today (never undefined/vanishing).
    const marked = storage.getLeadById(lead);
    expect(row.callbackDate).toBe(localDateOf(marked.lastOutcomeAt));
    expect(row.leadStatus).toBe("follow_up");
  });

  it("a BULK mark into follow_up appears too, and records the outcome verbatim", async () => {
    const lead = seedLead({ assignedRepId: fx.repA.memberId });
    const r = await req("/api/leads/bulk-status", fx.manager.session, {
      method: "POST", body: JSON.stringify({ leadIds: [lead], outcome: "follow_up" }),
    });
    expect(r.status).toBe(200);
    expect((await r.json()).updated).toBe(1);
    expect(storage.getLeadById(lead).lastOutcome).toBe("follow_up"); // the request's outcome, not a re-derived status
    expect((await followups(fx.repA.session)).some(f => f.leadId === lead)).toBe(true);
  });

  it("a field-map appointment (follow_up/go_back knock WITH a date) keeps its real schedule", async () => {
    // The appointment composer rides ordinary follow_up / go_back knocks with
    // callback_date/time attached — the read model must surface the REP'S
    // chosen schedule, not a date derived from last_outcome_at.
    for (const outcome of ["follow_up", "go_back"] as const) {
      const lead = seedLead({ assignedRepId: fx.repA.memberId });
      const date = tomorrowDate();
      const at = yesterday();
      storage.createKnock({
        leadId: lead, repId: fx.repA.memberId, outcome, wasHome: true, knockedAt: at,
        callbackDate: date, callbackTime: "18:30",
      } as any);
      storage.applyKnockOutcomeCas(lead, "follow_up", outcome, at);
      const rows = (await followups(fx.repA.session)).filter(f => f.leadId === lead);
      expect(rows, `${outcome} appointment surfaces exactly once`).toHaveLength(1);
      expect(rows[0].callbackDate).toBe(date);
      expect(rows[0].callbackTime).toBe("18:30");
    }
  });

  it("a reassigned door's follow-up moves to the NEW owner (not the knocker)", async () => {
    const lead = seedLead({ assignedRepId: fx.repA.memberId });
    knockCallback(lead, fx.repA.memberId, yesterday(), tomorrowDate());
    expect((await followups(fx.repA.session)).some(f => f.leadId === lead)).toBe(true);
    // Manager hands the door to rep B — the callback debt goes with the door.
    storage.updateLead(lead, { assignedRepId: fx.repB.memberId }, 1);
    expect((await followups(fx.repB.session)).some(f => f.leadId === lead)).toBe(true);
    expect((await followups(fx.repA.session)).some(f => f.leadId === lead)).toBe(false);
  });
});

describe("map pins carry do_not_knock", () => {
  it("a DNK door's pin says doNotKnock: true; others omit the field", async () => {
    const dnk = seedLead();
    const plain = seedLead();
    storage.updateLead(dnk, { doNotKnock: true }, 1);
    const body = await (await req("/api/leads/map", fx.manager.session)).json();
    const pins = body.pins as any[];
    const dnkPin = pins.find(p => p.id === dnk);
    const plainPin = pins.find(p => p.id === plain);
    expect(dnkPin).toBeTruthy();
    expect(dnkPin.doNotKnock).toBe(true);
    expect(plainPin).toBeTruthy();
    expect("doNotKnock" in plainPin).toBe(false); // compact pins omit falsy fields
  });
});
