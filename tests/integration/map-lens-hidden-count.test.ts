// REPRODUCTION — the owner assigned a block of FCC-footprint doors to a rep and
// the rep's map showed an empty street. Nothing was wrong with the assignment:
// the map's default source lens ("Latest fiber") drops every lead tagged
// `fcc_fiber_d25`, and it did so without saying a word. A filtered map and an
// assignment that never happened look identical from the field.
//
// GET /api/leads/map/count now reports `hiddenByView` — how many doors the
// active lens is suppressing INSIDE THE CALLER'S OWN SCOPE — so the client can
// offer the one tap that shows them.
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let server: Server;
let baseUrl: string;
let storage: (typeof import("../../server/storage"))["storage"];
let rawDb: any;

type Fixture = { userId: number; memberId: number; session: string };

function makePerson(name: string, loginRole: string, tenantId: number, memberRole = "rep"): Fixture {
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}@lens.example.test`;
  const member = storage.createTeamMember({ name, email, role: memberRole, active: true, tenantId } as any);
  const user = storage.createUser({ name, email, role: loginRole, active: true, tenantId, teamMemberId: member.id } as any);
  return { userId: user.id, memberId: member.id, session: storage.createSession(user.id).id };
}

const get = (path: string, session: string) =>
  fetch(`${baseUrl}${path}`, { headers: { "x-session-id": session } });

let admin: Fixture, rep: Fixture, otherRep: Fixture;

// The subdivision in the bug report: interior doors from the FCC footprint
// import, a handful of perimeter doors from an organic/fresh source.
const FOOTPRINT_DOORS = 12;
const OTHER_DOORS = 4;
const OTHER_REP_FOOTPRINT_DOORS = 7;

function seedDoor(tenantId: number, repId: number | null, tag: string | null, i: number) {
  const lead = storage.createLead({
    address: `${100 + i} Poplar View Dr NW`, city: "Concord", state: "NC", zip: "28027",
    lat: 35.42 + i * 0.0001, lng: -80.66 + i * 0.0001,
    leadStatus: "not_contacted", tenantId,
  } as any);
  rawDb.prepare(`UPDATE leads SET assigned_rep_id = ?, lead_tag = ? WHERE id = ?`)
    .run(repId, tag, (lead as any).id);
}

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-lens-"));
  process.env.NODE_ENV = "test";
  const storageModule = await import("../../server/storage");
  storageModule.runMigrations();
  storage = storageModule.storage;
  ({ rawDb } = await import("../../server/db"));

  admin = makePerson("Lens Admin", "admin", 1, "manager");
  rep = makePerson("Lens Rep", "rep", 1, "rep");
  otherRep = makePerson("Lens Other Rep", "rep", 1, "rep");

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

  let i = 0;
  for (let n = 0; n < FOOTPRINT_DOORS; n += 1) seedDoor(1, rep.memberId, "fcc_fiber_d25", i++);
  for (let n = 0; n < OTHER_DOORS; n += 1) seedDoor(1, rep.memberId, "fcc_fresh_block", i++);
  for (let n = 0; n < OTHER_REP_FOOTPRINT_DOORS; n += 1) seedDoor(1, otherRep.memberId, "fcc_fiber_d25", i++);
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(e => (e ? reject(e) : resolve())));
});

describe("the lens that hid an assignment", () => {
  it("REGRESSION: under ?view=latest the rep's assigned footprint doors vanish from the count", async () => {
    const latest = await (await get("/api/leads/map/count?view=latest", rep.session)).json() as any;
    // This is the bug as the rep experienced it: 16 doors assigned, 4 on screen.
    expect(latest.total).toBe(OTHER_DOORS);
    // …and now the response SAYS what it dropped, instead of leaving the rep to
    // conclude they were never assigned anything.
    expect(latest.hiddenByView).toBe(FOOTPRINT_DOORS);
  });

  it("with no lens the rep sees every door assigned to them, and nothing is reported hidden", async () => {
    const all = await (await get("/api/leads/map/count", rep.session)).json() as any;
    expect(all.total).toBe(FOOTPRINT_DOORS + OTHER_DOORS);
    expect(all.hiddenByView).toBe(0);
  });

  it("counts only the CALLER'S OWN hidden doors - never another rep's", async () => {
    // The other rep also holds footprint doors. Leaking them into this number
    // would tell a rep to go look for work that isn't theirs.
    const latest = await (await get("/api/leads/map/count?view=latest", rep.session)).json() as any;
    expect(latest.hiddenByView).toBe(FOOTPRINT_DOORS);
    expect(latest.hiddenByView).not.toBe(FOOTPRINT_DOORS + OTHER_REP_FOOTPRINT_DOORS);

    const otherLatest = await (await get("/api/leads/map/count?view=latest", otherRep.session)).json() as any;
    expect(otherLatest.hiddenByView).toBe(OTHER_REP_FOOTPRINT_DOORS);
  });

  it("an org-wide viewer gets the org-wide hidden total", async () => {
    const latest = await (await get("/api/leads/map/count?view=latest", admin.session)).json() as any;
    expect(latest.hiddenByView).toBe(FOOTPRINT_DOORS + OTHER_REP_FOOTPRINT_DOORS);
    expect(latest.total).toBe(OTHER_DOORS);
  });

  it("total + hiddenByView reconstructs the unfiltered scope exactly", async () => {
    // The invariant the chip's arithmetic rests on: nothing is double-counted
    // and nothing falls between the two numbers.
    for (const who of [rep, otherRep, admin]) {
      const latest = await (await get("/api/leads/map/count?view=latest", who.session)).json() as any;
      const all = await (await get("/api/leads/map/count", who.session)).json() as any;
      expect(latest.total + latest.hiddenByView).toBe(all.total);
    }
  });

  it("still rejects a malformed view instead of silently counting everything", async () => {
    const res = await get("/api/leads/map/count?view=nonsense", rep.session);
    expect(res.status).toBe(400);
  });
});
