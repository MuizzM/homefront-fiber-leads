// Who may create doors, and who may only see them.
//
// Creating leads is a MANAGEMENT action here, not a field one: a rep lassoing
// a subdivision would put thousands of doors into the org's pipeline that
// nobody planned, assigned or costed. So lasso-create sits behind the same
// guard as the manual "add a lead" form - team_lead and above.
//
// The house-number FEED is deliberately the opposite. Reps are the whole
// reason it exists: the numbers are what a rep reads off the map while
// standing on the street deciding which door is 412. Gating that to managers
// would blind the only people who use it, and it exposes nothing a rep cannot
// already see by looking at the houses.
//
// This suite exists because those two facts are one middleware apart and a
// copy-paste between them would be invisible in review.
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let server: Server;
let baseUrl: string;
let storage: (typeof import("../../server/storage"))["storage"];

type Person = { userId: number; session: string };
const fx: Record<string, Person> = {};

function person(name: string, role: string, tenantId = 1): Person {
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}@apauth.example.test`;
  const member = storage.createTeamMember({ name, email, role, active: true, tenantId } as any);
  const user = storage.createUser({ name, email, role, active: true, tenantId, teamMemberId: member.id } as any);
  return { userId: user.id, session: storage.createSession(user.id).id };
}

function post(path: string, session: string, body: unknown) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-session-id": session, "x-csrf-token": session },
    body: JSON.stringify(body),
  });
}
function get(path: string, session: string) {
  return fetch(`${baseUrl}${path}`, { headers: { "x-session-id": session } });
}

// A box over the seeded address points below.
const RING: [number, number][] = [
  [-80.31, 35.81], [-80.29, 35.81], [-80.29, 35.83], [-80.31, 35.83],
];

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-apauth-"));
  process.env.NODE_ENV = "test";
  const mod = await import("../../server/storage");
  mod.runMigrations();
  storage = mod.storage;

  const { upsertAddressPoints } = await import("../../server/addressPointStore");
  upsertAddressPoints(
    Array.from({ length: 5 }, (_, i) => ({
      source: "test", sourceId: `ap-${i}`,
      houseNumber: String(100 + i), street: `${100 + i} Authority Lane`,
      fullAddress: `${100 + i} Authority Lane, Lexington NC, 27292`,
      city: "Lexington", state: "NC", zip: "27292", county: "DAVIDSON",
      lat: 35.82, lng: -80.30 + i * 0.0001,
    })),
  );

  fx.admin = person("Ada Admin", "admin");
  fx.manager = person("Mara Manager", "manager");
  fx.teamLead = person("Lena Lead", "team_lead");
  fx.rep = person("Saad Rep", "rep");

  const { registerRoutes, registerSaasRoutes } = await import("../../server/routes");
  const app = express();
  app.use(express.json({ limit: "64kb" }));
  server = createServer(app);
  registerRoutes(server, app);
  registerSaasRoutes(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const a = server.address();
  if (!a || typeof a === "string") throw new Error("no bind");
  baseUrl = `http://127.0.0.1:${a.port}`;
});

afterAll(() => { server?.close(); });

describe("lasso-create authority", () => {
  it("a REP cannot create leads from a selection", async () => {
    const res = await post("/api/leads/create-from-selection", fx.rep.session, { polygon: RING });
    expect(res.status).toBe(403);
  });

  it("team_lead, manager and admin all can", async () => {
    // Sequential, not parallel: the route is idempotent by canonical key, so
    // the first caller creates and the rest legitimately find them existing.
    // Running them concurrently would race and tell us nothing about roles.
    const roles = ["teamLead", "manager", "admin"] as const;
    let firstCreated = -1;
    for (const role of roles) {
      const res = await post("/api/leads/create-from-selection", fx[role].session, { polygon: RING });
      expect(res.status, `${role} should be allowed`).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(5);
      if (firstCreated < 0) firstCreated = body.created;
    }
    // The first authorised caller did the creating; the rest saw them already
    // there. That is the idempotency contract, checked here so a future change
    // that makes creation non-idempotent fails loudly.
    expect(firstCreated).toBe(5);
    const last = await post("/api/leads/create-from-selection", fx.admin.session, { polygon: RING })
      .then((r) => r.json());
    expect(last.created).toBe(0);
    expect(last.existing).toBe(5);
  });

  it("an unauthenticated caller cannot", async () => {
    const res = await fetch(`${baseUrl}/api/leads/create-from-selection`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ polygon: RING }),
    });
    expect(res.status).toBe(401);
  });
});

describe("the house-number feed stays open to the field", () => {
  it("a REP can read address points - this is the layer they knock by", async () => {
    const res = await get("/api/address-points?bbox=-80.31,35.81,-80.29,35.83", fx.rep.session);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.points.length).toBe(5);
    // Triples, not objects: the payload shape this endpoint promises.
    expect(body.points[0]).toHaveLength(3);
  });

  it("but an unauthenticated caller still cannot", async () => {
    const res = await fetch(`${baseUrl}/api/address-points?bbox=-80.31,35.81,-80.29,35.83`);
    expect(res.status).toBe(401);
  });
});

describe("county import is admin-only", () => {
  it("a team_lead cannot trigger an import", async () => {
    const res = await post("/api/admin/address-points/import", fx.teamLead.session, { county: "Rowan" });
    expect(res.status).toBe(403);
  });

  it("a manager cannot either - this writes shared reference data", async () => {
    const res = await post("/api/admin/address-points/import", fx.manager.session, { county: "Rowan" });
    expect(res.status).toBe(403);
  });
});
