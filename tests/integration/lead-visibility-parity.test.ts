// THE ANTI-DRIFT TEST.
//
// "Which doors may this rep work?" used to be answered twice — once as a
// predicate in routes.ts (the knock/read path) and once as SQL in storage.ts
// (the map). Nothing held them together, and they drifted: the SQL had no
// OPEN-FIELD branch, so a door with no rep and no territory was legal to knock
// and never rendered as a pin. A rep cannot knock a pin that was never drawn,
// so ~62k imported town doors were unreachable in the field.
//
// This test walks every ownership shape a lead can have and asserts the two
// answers AGREE — "can I open it" and "is it on my map" must never disagree
// again. It fails if either encoding changes without the other.
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
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}@parity.example.test`;
  const member = storage.createTeamMember({ name, email, role: memberRole, active: true, tenantId } as any);
  const user = storage.createUser({ name, email, role: loginRole, active: true, tenantId, teamMemberId: member.id } as any);
  return { userId: user.id, memberId: member.id, session: storage.createSession(user.id).id };
}

const get = (path: string, session: string) =>
  fetch(`${baseUrl}${path}`, { headers: { "x-session-id": session } });

let rep: Fixture, otherRep: Fixture;
let myArea = 0, theirArea = 0;

/** The ownership shapes a door can have, and whether OUR rep may work it. */
interface Shape { label: string; repId: number | null; territory: "mine" | "theirs" | null; workable: boolean }
const SHAPES: Shape[] = [
  { label: "assigned to me", repId: -1, territory: null, workable: true },
  { label: "assigned to me, inside my area", repId: -1, territory: "mine", workable: true },
  { label: "in MY area but another rep is the named primary", repId: -2, territory: "mine", workable: true },
  // Open field is OPT-IN and OFF by default, so an unowned door is nobody's to
  // work until an admin turns it on. What matters here is that BOTH encodings
  // agree about that — the parity assertion below covers it either way.
  { label: "OPEN FIELD - no rep, no area", repId: null, territory: null, workable: false },
  { label: "assigned to another rep", repId: -2, territory: null, workable: false },
  { label: "unassigned but inside ANOTHER team's area", repId: null, territory: "theirs", workable: false },
  { label: "another rep, inside their own area", repId: -2, territory: "theirs", workable: false },
];

const leadIdFor = new Map<string, number>();

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-parity-"));
  process.env.NODE_ENV = "test";
  const storageModule = await import("../../server/storage");
  storageModule.runMigrations();
  storage = storageModule.storage;
  ({ rawDb } = await import("../../server/db"));

  rep = makePerson("Parity Rep", "rep", 1, "rep");
  otherRep = makePerson("Parity Other", "rep", 1, "rep");

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

  const mkArea = (name: string, ownerId: number) => {
    const info = rawDb.prepare(
      `INSERT INTO territories (tenant_id, name, rep_id, assignee_ids, polygon, created_at)
       VALUES (1, ?, ?, ?, ?, datetime('now'))`,
    ).run(name, ownerId, JSON.stringify([ownerId]), JSON.stringify([[-80.7, 35.4], [-80.5, 35.4], [-80.5, 35.6], [-80.7, 35.6]]));
    return Number(info.lastInsertRowid);
  };
  myArea = mkArea("Parity Mine", rep.memberId);
  theirArea = mkArea("Parity Theirs", otherRep.memberId);

  SHAPES.forEach((shape, i) => {
    const lead = storage.createLead({
      address: `${200 + i} Parity Ln`, city: "Concord", state: "NC", zip: "28027",
      lat: 35.5 + i * 0.001, lng: -80.6 + i * 0.001,
      leadStatus: "not_contacted", tenantId: 1,
    } as any);
    const id = Number((lead as any).id);
    const repId = shape.repId === -1 ? rep.memberId : shape.repId === -2 ? otherRep.memberId : null;
    const territoryId = shape.territory === "mine" ? myArea : shape.territory === "theirs" ? theirArea : null;
    rawDb.prepare(`UPDATE leads SET assigned_rep_id = ?, assigned_territory_id = ? WHERE id = ?`)
      .run(repId, territoryId, id);
    leadIdFor.set(shape.label, id);
  });
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(e => (e ? reject(e) : resolve())));
});

describe("the access predicate and the map SQL answer the same question", () => {
  it.each(SHAPES)("$label → workable: $workable, and the map agrees", async (shape) => {
    const id = leadIdFor.get(shape.label)!;

    // (a) Can the rep OPEN the door? This is repCanAccessLead — the predicate
    //     that also gates knocking, notes, photos and history.
    const readable = (await get(`/api/leads/${id}`, rep.session)).status === 200;
    expect(readable, `read access for "${shape.label}"`).toBe(shape.workable);

    // (b) Is it on their MAP? This is mapScopeWhere — the SQL encoding.
    const pins = await (await get(`/api/leads/map?format=packed`, rep.session)).json() as any;
    const ids: number[] = (pins.pins ?? pins.rows ?? []).map((p: any) => Number(p.id ?? p[0]));
    const onMap = ids.includes(id);

    // The invariant: (a) and (b) are the same answer. The original defect was
    // exactly this pair disagreeing on the OPEN FIELD row.
    expect(onMap, `map visibility for "${shape.label}" must match read access`).toBe(readable);
  });

  it("REGRESSION: an unassigned door is NOT on a rep's map", async () => {
    // The owner's report: reps opened the app and saw the entire imported FCC
    // footprint. Unowned ground is not a rep's to work by default.
    const id = leadIdFor.get("OPEN FIELD - no rep, no area")!;
    const pins = await (await get(`/api/leads/map?format=packed`, rep.session)).json() as any;
    const ids: number[] = (pins.pins ?? pins.rows ?? []).map((p: any) => Number(p.id ?? p[0]));
    expect(ids).not.toContain(id);
  });

  it("the count endpoint counts exactly the pins the feed returns", async () => {
    // A count that disagrees with the feed drives the map into the wrong
    // loading mode, which is how a blank map happens at scale.
    const pins = await (await get(`/api/leads/map?format=packed`, rep.session)).json() as any;
    const feed = (pins.pins ?? pins.rows ?? []).length;
    const count = await (await get(`/api/leads/map/count`, rep.session)).json() as any;
    expect(count.total).toBe(feed);
  });

  it("another team's ground stays invisible - widening open field did not widen theft", async () => {
    const denied = ["assigned to another rep", "unassigned but inside ANOTHER team's area", "another rep, inside their own area"];
    const pins = await (await get(`/api/leads/map?format=packed`, rep.session)).json() as any;
    const ids: number[] = (pins.pins ?? pins.rows ?? []).map((p: any) => Number(p.id ?? p[0]));
    for (const label of denied) {
      expect(ids, label).not.toContain(leadIdFor.get(label)!);
    }
  });
});
