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

it.each([
  ["empty", "[]", false], ["other", "[999999]", false], ["numeric-string", '["REP"]', false],
  ["current", "[REP]", true], ["legacy-null", null, true], ["legacy-invalid", "invalid", true],
  ["legacy-object", "{}", true],
])("map SQL and hydrated access agree for %s assignees overriding the old primary", async (_label, value, expected) => {
  const { repVisibilitySql } = await import("../../shared/leadVisibility");
  const assignees = typeof value === "string" ? value.replace("REP", String(rep.memberId)) : value;
  const t = Number(rawDb.prepare("INSERT INTO territories(tenant_id,name,rep_id,assignee_ids,polygon) VALUES(1,?,?,?,'[]')").run(`Parity ${_label}`, rep.memberId, assignees).lastInsertRowid);
  const lead = storage.createLead({ tenantId: 1, address: `${t + 3000} Parity Lane`, city: "Concord", state: "NC", zip: "28027", assignedRepId: otherRep.memberId, assignedTerritoryId: t } as any);
  const visible = !!rawDb.prepare(`SELECT id FROM leads WHERE id=? AND ${repVisibilitySql([rep.memberId])}`).get(lead.id);
  expect(visible).toBe(expected);
  expect((await get(`/api/leads/${lead.id}`, rep.session)).status === 200).toBe(expected);
});

it("invalidates both the map ETag and cached body after another connection reclaims a territory", async () => {
  const { default: Database } = await import("better-sqlite3");
  const { dbPath } = await import("../../server/db");
  const writer = new Database(dbPath);
  const scopedId = leadIdFor.get("in MY area but another rep is the named primary")!;
  try {
    const before = await get("/api/leads/map?format=packed", rep.session);
    const etag = before.headers.get("etag")!;
    const firstBody = await before.json();
    const pins = firstBody.pins ?? firstBody.rows;
    expect(pins.some((p: any) => Number(p.id ?? p[0]) === scopedId)).toBe(true);
    writer.prepare("UPDATE territories SET assignee_ids='[]' WHERE id=?").run(myArea);
    const after = await fetch(`${baseUrl}/api/leads/map?format=packed`, { headers: { "x-session-id": rep.session, "if-none-match": etag } });
    expect(after.status).toBe(200); expect(after.headers.get("etag")).not.toBe(etag);
    expect(after.headers.get("x-map-cache")).toBe("miss");
    const afterBody = await after.json();
    expect((afterBody.pins ?? afterBody.rows).some((p: any) => Number(p.id ?? p[0]) === scopedId)).toBe(false);
    const unchanged = await fetch(`${baseUrl}/api/leads/map?format=packed`, { headers: { "x-session-id": rep.session, "if-none-match": after.headers.get("etag")! } });
    expect(unchanged.status).toBe(304);
  } finally { writer.close(); }
});

it("never publishes permissions from a transaction that later rolls back", async () => {
  const { cachedScopeLookup } = await import("../../server/territoryScopeCache");
  const read = () => cachedScopeLookup("rollback-fixture", () => new Set(rawDb.prepare("SELECT open_field_enabled v FROM tenants WHERE id=1").get().v ? [1] : []));
  rawDb.exec("UPDATE tenants SET open_field_enabled=0 WHERE id=1");
  expect(storage.openFieldEnabled(1)).toBe(false); expect([...read()]).toEqual([]);
  rawDb.exec("BEGIN IMMEDIATE; UPDATE tenants SET open_field_enabled=1 WHERE id=1");
  try { expect(storage.openFieldEnabled(1)).toBe(true); expect([...read()]).toEqual([1]); }
  finally { rawDb.exec("ROLLBACK"); }
  // Reuse the rolled-back version with a different permission value.
  rawDb.exec("UPDATE tenants SET open_field_enabled=0 WHERE id=1");
  expect(storage.openFieldEnabled(1)).toBe(false); expect([...read()]).toEqual([]);
});
