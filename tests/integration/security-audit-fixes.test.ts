// Regression tests for the security-audit fixes:
//  1. Commission self-dealing — nobody may set their OWN commission via the
//     write routes, even though their own record is inside their read scope.
//  2. Bulk lead operations are bounded (no unbounded array → event-loop stall).
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let server: Server;
let baseUrl: string;
let storage: (typeof import("../../server/storage"))["storage"];

type Fixture = { userId: number; memberId: number; session: string };

function makePerson(name: string, role: string, opts: { reportsToId?: number | null; loginRole?: string } = {}): Fixture {
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}@sec-audit.example.test`;
  const member = storage.createTeamMember({
    name, email, role, active: true, reportsToId: opts.reportsToId ?? null, tenantId: 1,
  } as any);
  const user = storage.createUser({
    name, email, role: opts.loginRole ?? role, active: true, tenantId: 1, teamMemberId: member.id,
  } as any);
  return { userId: user.id, memberId: member.id, session: storage.createSession(user.id).id };
}

function request(path: string, sessionId: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-session-id": sessionId, ...init.headers },
  });
}

let manager: Fixture;
let lead: Fixture;
let rep: Fixture;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-sec-audit-"));
  process.env.NODE_ENV = "test";
  const storageModule = await import("../../server/storage");
  storageModule.runMigrations();
  storage = storageModule.storage;

  manager = makePerson("Sec Manager", "manager");
  lead = makePerson("Sec Lead", "team_lead", { reportsToId: manager.memberId });
  rep = makePerson("Sec Rep", "rep", { reportsToId: lead.memberId });

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

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

describe("commission self-dealing is refused", () => {
  const assign = (repId: number, session: string) =>
    request("/api/commission/assign-structure", session, {
      method: "POST",
      body: JSON.stringify({ repId, structure: "FLAT", flatRateDollars: 500, closeExisting: true }),
    });

  it("a team lead cannot set their OWN commission structure", async () => {
    const res = await assign(lead.memberId, lead.session);
    expect(res.status).toBe(403);
    expect((await res.json() as any).code).toBe("COMMISSION_SELF_DEAL");
  });

  it("a manager cannot set their OWN commission structure (even with org-wide read scope)", async () => {
    const res = await assign(manager.memberId, manager.session);
    expect(res.status).toBe(403);
    expect((await res.json() as any).code).toBe("COMMISSION_SELF_DEAL");
  });

  it("a team lead CAN still set a direct report's commission (guard is self-only)", async () => {
    const res = await assign(rep.memberId, lead.session);
    // The self-deal guard does not fire for a subordinate; the write succeeds.
    expect(res.status).toBe(201);
    expect((await res.json() as any)).toBeTruthy();
  });

  it("a team lead can still READ their own commission structure", async () => {
    const res = await request(`/api/commission/reps/${lead.memberId}/structure`, lead.session);
    expect(res.status).toBe(200); // reads are unaffected by the self-deal write guard
  });
});

describe("bulk lead operations are bounded", () => {
  const bigList = Array.from({ length: 501 }, (_, i) => i + 1);

  it("bulk-assign ACCEPTS a whole-neighbourhood selection (set-based + chunked)", async () => {
    // The 500 cap existed because the old path ran ~3 synchronous statements
    // per lead. It is now two statements per 500-lead chunk with an
    // event-loop yield between chunks, so a lasso can hand a rep an entire
    // neighbourhood. (Ids that do not exist simply count as skipped.)
    const res = await request("/api/leads/bulk-assign", manager.session, {
      method: "POST", body: JSON.stringify({ leadIds: bigList, repId: rep.memberId }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.updated + body.skipped).toBe(bigList.length);
  });

  it("bulk-assign still refuses an absurd payload (defense in depth)", async () => {
    // Two independent guards: the JSON body limit (413) fires first at this
    // size, and MAX_BULK_ASSIGN_LEADS (400 BULK_TOO_LARGE) backs it up. Either
    // refusal is correct — what matters is that it is never accepted.
    const absurd = Array.from({ length: 25_001 }, (_, i) => i + 1);
    const res = await request("/api/leads/bulk-assign", manager.session, {
      method: "POST", body: JSON.stringify({ leadIds: absurd, repId: rep.memberId }),
    });
    expect([400, 413]).toContain(res.status);
  });

  it("bulk-status refuses an over-large selection", async () => {
    const res = await request("/api/leads/bulk-status", manager.session, {
      method: "POST", body: JSON.stringify({ leadIds: bigList, outcome: "not_interested" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as any).code).toBe("BULK_TOO_LARGE");
  });

  it("a normal-size bulk-status selection still works", async () => {
    const res = await request("/api/leads/bulk-status", manager.session, {
      method: "POST", body: JSON.stringify({ leadIds: [999999], outcome: "not_interested" }),
    });
    // 999999 doesn't exist → skipped, but the request itself is accepted.
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body).toMatchObject({ updated: 0 });
  });
});
