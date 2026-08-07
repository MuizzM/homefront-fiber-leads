// A role change has to land EVERYWHERE, at once.
//
// Demoting a team lead to rep touches three separate things, and until they all
// move together the person is in two states at the same time:
//
//   1. team_members.role   — the org chart / hierarchy authority
//   2. users.role          — the LOGIN role, which is what shared/capabilities.ts
//                            authorizes against on every request
//   3. their live sessions — and, through them, whatever the already-open app
//                            is still rendering from
//
// The reported symptom was a demoted team lead still showing as a team lead in
// Training. requireAuth re-reads users.role on every request, so a stale (2)
// grants real team-lead POWER, not just a stale label — and a stale (3) means
// the app in their hand keeps offering it even after (2) is fixed.
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { can } from "@shared/capabilities";

let server: Server;
let baseUrl: string;
let storage: (typeof import("../../server/storage"))["storage"];
let rawDb: import("better-sqlite3").Database;

const TENANT = 1;
type Person = { userId: number; memberId: number; session: string; email: string };
let admin: Person;

let seq = 0;
function person(name: string, role: string, reportsToId: number | null = null, withLogin = true): Person {
  seq += 1;
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}.${seq}@rolechange.example.test`;
  const member = storage.createTeamMember({ name, email, role, active: true, reportsToId, tenantId: TENANT } as any);
  if (!withLogin) return { userId: 0, memberId: member.id, session: "", email };
  const user = storage.createUser({ name, email, role, active: true, tenantId: TENANT, teamMemberId: member.id } as any);
  rawDb.prepare("UPDATE users SET training_required = 0 WHERE id = ?").run((user as any).id);
  return { userId: user.id, memberId: member.id, session: storage.createSession(user.id).id, email };
}

function patchMember(id: number, session: string, body: Record<string, unknown>) {
  return fetch(`${baseUrl}/api/team/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-session-id": session, "x-csrf-token": session },
    body: JSON.stringify(body),
  });
}

const memberRole = (id: number): string =>
  (rawDb.prepare("SELECT role FROM team_members WHERE id = ?").get(id) as any)?.role;
const loginRole = (userId: number): string =>
  (rawDb.prepare("SELECT role FROM users WHERE id = ?").get(userId) as any)?.role;
const liveSessions = (userId: number): number =>
  (rawDb.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?").get(userId) as any)?.n ?? 0;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-rolechange-"));
  process.env.NODE_ENV = "test";
  storage = (await import("../../server/storage")).storage;
  (await import("../../server/storage")).runMigrations();
  ({ rawDb } = await import("../../server/db"));

  const app = express();
  app.use(express.json());
  server = createServer(app);
  (await import("../../server/routes")).registerRoutes(server, app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;

  admin = person("Role Admin", "admin");
});

afterAll(() => { server?.close(); });

describe("demoting a team lead to rep", () => {
  it("moves the org-chart role, the LOGIN role, and revokes live sessions together", async () => {
    const saad = person("Saad Demo", "team_lead");
    // The person is mid-shift with the app open — that is the whole point.
    expect(liveSessions(saad.userId)).toBe(1);
    expect(can(loginRole(saad.userId), "commission.read.downline")).toBe(true);

    const res = await patchMember(saad.memberId, admin.session, { role: "rep" });
    expect(res.status).toBe(200);

    expect(memberRole(saad.memberId)).toBe("rep");
    // The one that actually grants power: capabilities authorize against
    // users.role, so a stale login role is real team-lead authority, not a label.
    expect(loginRole(saad.userId)).toBe("rep");
    // And the app already open in their hand must stop offering it.
    expect(liveSessions(saad.userId)).toBe(0);
  });

  it("strips every team-lead capability", async () => {
    const saad = person("Saad Caps", "team_lead");
    await patchMember(saad.memberId, admin.session, { role: "rep" });

    const after = loginRole(saad.userId);
    for (const cap of [
      "commission.read.team", "commission.read.downline", "commission.structure.manage",
      "lead.assign", "lead.reassign", "lead.read.all",
      "scan.submit", "lead.skip_trace.request",
      "dashboard.read.team", "audit.read.team",
      // The new surfaces have to follow the same rule, or a demotion leaves a
      // rep able to see their old branch's trips and earnings.
      "earnings.read.team", "training.read.team", "mileage.read.team",
    ] as const) {
      expect(can(after, cap), `${cap} should be gone after demotion`).toBe(false);
    }
    // …while everything a rep legitimately keeps is untouched.
    for (const cap of ["field.app.use", "commission.read.self", "mileage.submit.self", "referral.read.self"] as const) {
      expect(can(after, cap), `${cap} should survive demotion`).toBe(true);
    }
  });

  it("the demoted session cannot be used to act as a team lead afterwards", async () => {
    const saad = person("Saad Session", "team_lead");
    const staleSession = saad.session;
    await patchMember(saad.memberId, admin.session, { role: "rep" });

    // The old session id is dead, so the request is refused outright rather
    // than being evaluated against a role that no longer applies.
    const res = await fetch(`${baseUrl}/api/commission/plans`, {
      headers: { "x-session-id": staleSession },
    });
    expect(res.status).toBe(401);
  });
});

describe("promotion propagates the same way", () => {
  it("grants the new role's authority through the login, not just the chart", async () => {
    const rising = person("Rising Star", "rep");
    const res = await patchMember(rising.memberId, admin.session, { role: "team_lead" });
    expect(res.status).toBe(200);

    expect(memberRole(rising.memberId)).toBe("team_lead");
    expect(loginRole(rising.userId)).toBe("team_lead");
    expect(can(loginRole(rising.userId), "commission.read.downline")).toBe(true);
    // A promotion re-authorizes too: signing back in is what makes the new
    // capabilities appear in the app rather than only on the server.
    expect(liveSessions(rising.userId)).toBe(0);
  });
});

describe("edits that are not role changes", () => {
  it("do NOT sign the person out", async () => {
    const steady = person("Steady Eddie", "team_lead");
    const res = await patchMember(steady.memberId, admin.session, { name: "Steady Edward" });
    expect(res.status).toBe(200);
    // Only a role change re-authorizes. Signing someone out because a manager
    // fixed a typo in their name would make the roster unusable mid-shift.
    expect(liveSessions(steady.userId)).toBe(1);
  });
});
