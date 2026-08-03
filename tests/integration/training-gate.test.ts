// A new rep finishes training before they touch the field.
//
// This is an ACCESS CONTROL, so the tests that matter are the ones an untrained
// rep (or a curious one) would actually try:
//
//   1. The lock is SERVER-SIDE. Hiding nav items is a courtesy; typing the URL,
//      replaying a saved request, or scripting the API must all be refused.
//   2. Admins, managers, and team leads are NEVER gated. Locking a manager out
//      of the team screen over a training counter is an outage, not a policy.
//   3. Existing people are not swept up. A rep who has been selling for months
//      does not lose their route because a policy shipped on a Tuesday.
//   4. Finishing actually opens it — without signing out.
//   5. A gated rep can still do the things that make them employable: their
//      profile, their W-9, their onboarding packet.
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TRAINING_LESSONS } from "../../shared/trainingContent";

let server: Server;
let baseUrl: string;
let storage: (typeof import("../../server/storage"))["storage"];
let rawDb: any;

type Fixture = { userId: number; memberId: number; session: string };

function makePerson(name: string, loginRole: string, tenantId: number, memberRole = "rep"): Fixture {
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}@gate.example.test`;
  const member = storage.createTeamMember({ name, email, role: memberRole, active: true, tenantId } as any);
  const user = storage.createUser({ name, email, role: loginRole, active: true, tenantId, teamMemberId: member.id } as any);
  return { userId: user.id, memberId: member.id, session: storage.createSession(user.id).id };
}

const request = (path: string, sessionId: string, init: RequestInit = {}) =>
  fetch(`${baseUrl}${path}`, { ...init, headers: { "content-type": "application/json", "x-session-id": sessionId, ...(init.headers ?? {}) } });
const post = (path: string, session: string, body?: unknown) =>
  request(path, session, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
const put = (path: string, session: string, body: unknown) =>
  request(path, session, { method: "PUT", body: JSON.stringify(body) });

/** A user who existed BEFORE the gate shipped — the grandfathering case. */
let veteran: Fixture;
let newRep: Fixture, secondNewRep: Fixture, lead: Fixture, mgr: Fixture, admin: Fixture;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-gate-"));
  process.env.NODE_ENV = "test";
  const storageModule = await import("../../server/storage");
  storageModule.runMigrations();
  storage = storageModule.storage;
  ({ rawDb } = await import("../../server/db"));

  // Created BEFORE the gate module runs its one-time backfill.
  veteran = makePerson("Vet Rep", "rep", 1, "rep");

  // Importing the store applies the schema + backfill, exactly as boot does.
  await import("../../server/trainingGateStore");

  // Everyone below is created AFTER the backfill, so they owe training —
  // which is precisely the "new rep" case.
  newRep = makePerson("New Rep", "rep", 1, "rep");
  secondNewRep = makePerson("Second New", "rep", 1, "rep");
  lead = makePerson("Gate Lead", "team_lead", 1, "team_lead");
  mgr = makePerson("Gate Manager", "manager", 1, "manager");
  admin = makePerson("Gate Admin", "admin", 1, "manager");

  const { registerRoutes, registerSaasRoutes } = await import("../../server/routes");
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  server = createServer(app);
  registerRoutes(server, app);
  registerSaasRoutes(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no bind");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(e => (e ? reject(e) : resolve())));
});

describe("a new rep is locked to training", () => {
  it("reports itself gated", async () => {
    const res = await request("/api/training/gate", newRep.session);
    expect(res.status).toBe(200);
    const gate = await res.json() as any;
    expect(gate.gated).toBe(true);
    expect(gate.progress.completed).toBe(0);
    expect(gate.progress.required).toBeGreaterThan(0);
    expect(gate.progress.headline).toMatch(/lessons? left to unlock/);
  });

  it("is refused the field, whatever URL they type", async () => {
    // Hiding the nav is a courtesy. THIS is the lock — a rep who types the URL,
    // replays a saved request, or scripts the API hits the same wall.
    for (const path of ["/api/leads", "/api/leads/map", "/api/leaderboard", "/api/spiffs/mine", "/api/followups"]) {
      const res = await request(path, newRep.session);
      expect(res.status, `${path} should be gated`).toBe(403);
      expect((await res.json() as any).code).toBe("TRAINING_REQUIRED");
    }
  });

  it("cannot log a knock — the whole point of the gate", async () => {
    const leadRow = storage.createLead({
      address: "1 Gate St", city: "Testville", state: "NC", zip: "27000",
      leadStatus: "new", tenantId: 1,
    } as any);
    const res = await post(`/api/leads/${leadRow.id}/knock`, newRep.session, { outcome: "not_home" });
    expect(res.status).toBe(403);
    expect((await res.json() as any).code).toBe("TRAINING_REQUIRED");
  });

  it("CAN still do training, and their own paperwork", async () => {
    // Locking someone out of the work is the policy; locking them out of
    // becoming employable would be a bug — they could never finish onboarding.
    expect((await request("/api/training/progress", newRep.session)).status).toBe(200);
    expect((await request("/api/training/gate", newRep.session)).status).toBe(200);
    for (const path of ["/api/me/w9", "/api/me/bank"]) {
      expect((await request(path, newRep.session)).status, `${path} should stay open`).not.toBe(403);
    }
  });

  it("can still sign out — never trap someone inside the app", async () => {
    const throwaway = storage.createSession(newRep.userId).id;
    expect((await post("/api/auth/logout", throwaway)).status).toBe(200);
  });
});

describe("who is never gated", () => {
  it("a team lead, a manager, and an admin all reach the field", async () => {
    for (const [label, who] of [["team_lead", lead], ["manager", mgr], ["admin", admin]] as const) {
      const res = await request("/api/leads", who.session);
      expect(res.status, `${label} must not be gated`).not.toBe(403);
      const gate = await (await request("/api/training/gate", who.session)).json() as any;
      expect(gate.gated, `${label} reports gated`).toBe(false);
    }
  });

  it("a rep who already existed keeps their route", async () => {
    // The grandfathering case: created before the gate shipped, so the one-time
    // backfill cleared their requirement. A veteran does not lose the map on a
    // Tuesday because a policy landed.
    const gate = await (await request("/api/training/gate", veteran.session)).json() as any;
    expect(gate.gated).toBe(false);
    expect(gate.trainingRequired).toBe(false);
    expect((await request("/api/leads", veteran.session)).status).not.toBe(403);
  });
});

describe("finishing opens it", () => {
  it("completing every required lesson unlocks the app without signing out", async () => {
    const before = await (await request("/api/training/gate", newRep.session)).json() as any;
    const required = before.progress.required as number;

    for (const lesson of TRAINING_LESSONS.slice(0, required)) {
      const res = await post(`/api/training/lessons/${lesson.id}/complete`, newRep.session, {});
      expect(res.status).toBe(200);
    }

    const after = await (await request("/api/training/gate", newRep.session)).json() as any;
    expect(after.gated).toBe(false);
    expect(after.progress.remaining).toBe(0);
    // Same session token — no re-login needed.
    expect((await request("/api/leads", newRep.session)).status).not.toBe(403);
  });

  it("partial progress does NOT open it", async () => {
    const gate = await (await request("/api/training/gate", secondNewRep.session)).json() as any;
    const required = gate.progress.required as number;
    // One short of the bar.
    for (const lesson of TRAINING_LESSONS.slice(0, required - 1)) {
      await post(`/api/training/lessons/${lesson.id}/complete`, secondNewRep.session, {});
    }
    const partial = await (await request("/api/training/gate", secondNewRep.session)).json() as any;
    expect(partial.gated).toBe(true);
    expect(partial.progress.remaining).toBe(1);
    expect((await request("/api/leads", secondNewRep.session)).status).toBe(403);
  });

  it("re-completing the same lesson cannot inflate the count", async () => {
    const lesson = TRAINING_LESSONS[0];
    const before = await (await request("/api/training/gate", secondNewRep.session)).json() as any;
    for (let i = 0; i < 3; i += 1) {
      await post(`/api/training/lessons/${lesson.id}/complete`, secondNewRep.session, {});
    }
    const after = await (await request("/api/training/gate", secondNewRep.session)).json() as any;
    // The count is DISTINCT lessons — tapping one lesson 90 times is not training.
    expect(after.progress.completed).toBe(before.progress.completed);
    expect(after.gated).toBe(true);
  });
});

describe("admin overrides", () => {
  it("an admin can clear the requirement for a rep who trained in person", async () => {
    expect((await request("/api/leads", secondNewRep.session)).status).toBe(403);
    const res = await post(`/api/training/gate/${secondNewRep.userId}`, admin.session, { required: false });
    expect(res.status).toBe(200);
    expect((await request("/api/leads", secondNewRep.session)).status).not.toBe(403);
  });

  it("and can put it back", async () => {
    expect((await post(`/api/training/gate/${secondNewRep.userId}`, admin.session, { required: true })).status).toBe(200);
    expect((await request("/api/leads", secondNewRep.session)).status).toBe(403);
  });

  it("a rep cannot unlock themselves", async () => {
    const res = await post(`/api/training/gate/${secondNewRep.userId}`, secondNewRep.session, { required: false });
    // Refused by the gate itself (the path is not on the allowlist), which is
    // the stronger outcome — they never even reach the admin check.
    expect(res.status).toBe(403);
    expect((await request("/api/leads", secondNewRep.session)).status).toBe(403);
  });

  it("a manager cannot either — the override sits with admin", async () => {
    expect((await post(`/api/training/gate/${secondNewRep.userId}`, mgr.session, { required: false })).status).toBe(403);
  });

  it("an admin can lower the bar for the whole org", async () => {
    // 91 lessons is a lot for a first week; the threshold is tunable without a
    // deploy so the policy can meet reality.
    const res = await put("/api/training/gate-threshold", admin.session, { requiredLessons: 3 });
    expect(res.status).toBe(200);
    expect((await res.json() as any).requiredLessons).toBe(3);

    // secondNewRep already has far more than 3 completed → immediately clear.
    const gate = await (await request("/api/training/gate", secondNewRep.session)).json() as any;
    expect(gate.gated).toBe(false);
  });

  it("rejects a threshold larger than the curriculum", async () => {
    const res = await put("/api/training/gate-threshold", admin.session, { requiredLessons: 99_999 });
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toMatch(/only \d+ lessons/);
  });

  it("the roster names who is still locked out", async () => {
    await put("/api/training/gate-threshold", admin.session, { requiredLessons: TRAINING_LESSONS.length });
    const fresh = makePerson("Roster Rep", "rep", 1, "rep");
    const res = await request("/api/training/gate/roster", mgr.session);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.reps.some((r: any) => r.userId === fresh.userId)).toBe(true);
    // A cleared veteran never appears.
    expect(body.reps.some((r: any) => r.userId === veteran.userId)).toBe(false);
  });
});

describe("tenant isolation", () => {
  it("an admin cannot unlock someone in another org", async () => {
    const otherTenant = storage.createTenant({
      slug: "gate-b", companyName: "Org B", ownerName: "B Owner",
      ownerEmail: "owner-b@gate.example.test", brandName: "Org B",
    } as any).id;
    const theirRep = makePerson("Their Rep", "rep", otherTenant, "rep");
    // Out of tenant reads as 404, never a refusal that confirms the id exists.
    const res = await post(`/api/training/gate/${theirRep.userId}`, admin.session, { required: false });
    expect(res.status).toBe(404);
    expect(rawDb.prepare(`SELECT training_required AS r FROM users WHERE id = ?`).get(theirRep.userId).r).toBe(1);
  });
});
