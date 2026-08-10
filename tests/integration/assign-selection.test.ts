// POST /api/leads/assign-selection - assignment described by its RING rather
// than enumerated as ids.
//
// The lasso used to POST an id array, which capped it twice over: the 64 KB API
// body limit killed it around 8,000 doors (at the PARSER, so the friendly
// BULK_TOO_LARGE message never ran and the browser just showed a network
// failure), and the client can only enumerate pins it HOLDS, so past the
// sampling threshold Assign silently skipped every unsampled door inside the
// loop. See docs/architecture/BULK_ASSIGNMENT.md.
//
// What this pins:
//   - the ring resolves server-side, at a size no id payload could carry
//   - the payload does NOT grow with the door count
//   - doors outside the ring are never touched
//   - the status refinement is honoured, using the same display-state rule the
//     map is drawn from
//   - authority still holds: a team_lead cannot poach another team's doors
//   - the runaway guards refuse rather than silently truncating
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let server: Server;
let baseUrl: string;
let storage: (typeof import("../../server/storage"))["storage"];
let rawDb: import("better-sqlite3").Database;

type Person = { userId: number; memberId: number; session: string };
const fx: Record<string, Person> = {};

function person(name: string, role: string, tenantId = 1, reportsToId?: number): Person {
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}@assignsel.example.test`;
  const member = storage.createTeamMember({ name, email, role, active: true, tenantId, reportsToId } as any);
  const user = storage.createUser({ name, email, role, active: true, tenantId, teamMemberId: member.id } as any);
  return { userId: user.id, memberId: member.id, session: storage.createSession(user.id).id };
}

function post(path: string, session: string, body: unknown) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-session-id": session, "x-csrf-token": session },
    body: JSON.stringify(body),
  });
}

// A ring around (35.80..35.90, -80.30..-80.20). Deliberately a plain box so the
// "inside" and "outside" fixtures below are obvious by inspection.
const RING: [number, number][] = [
  [-80.30, 35.80], [-80.20, 35.80], [-80.20, 35.90], [-80.30, 35.90],
];

let addrSeq = 1000;
function seedLead(over: Record<string, unknown> = {}, tenantId = 1): number {
  return storage.createLead({
    address: `${addrSeq++} Selection Way`, city: "Lexington", state: "NC", zip: "27292",
    lat: 35.85, lng: -80.25, tenantId, leadStatus: "prospect",
    ...over,
  } as any).id;
}

const leadById = (id: number) => rawDb.prepare("SELECT * FROM leads WHERE id = ?").get(id) as any;
const eventCount = (id: number) =>
  (rawDb.prepare("SELECT COUNT(*) c FROM lead_events WHERE lead_id = ? AND type = 'assignment'").get(id) as any).c;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-assignsel-"));
  process.env.NODE_ENV = "test";
  const mod = await import("../../server/storage");
  mod.runMigrations();
  storage = mod.storage;
  ({ rawDb } = await import("../../server/db"));

  fx.manager = person("Mara Manager", "manager");
  fx.saad = person("Saad Rep", "rep");
  fx.other = person("Otto Rep", "rep");
  fx.lead = person("Lena Lead", "team_lead");
  fx.owned = person("Owen Owned", "rep", 1, fx.lead.memberId);

  const { registerRoutes, registerSaasRoutes } = await import("../../server/routes");
  const app = express();
  app.use(express.json({ limit: "64kb" })); // the SAME ceiling production applies
  server = createServer(app);
  registerRoutes(server, app);
  registerSaasRoutes(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const a = server.address();
  if (!a || typeof a === "string") throw new Error("no bind");
  baseUrl = `http://127.0.0.1:${a.port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
});

describe("ring-resolved assignment", () => {
  it("assigns a selection far larger than an id payload could carry", async () => {
    // 12,000 doors. As ids this is ~96 KB - past the 64 KB body limit, so the
    // old contract could not express this request at all.
    const inside: number[] = [];
    const tx = rawDb.transaction(() => {
      for (let i = 0; i < 12_000; i++) {
        inside.push(seedLead({ lat: 35.81 + (i % 100) * 0.0005, lng: -80.29 + Math.floor(i / 100) * 0.0005 }));
      }
    });
    tx();
    const outside = seedLead({ lat: 35.95, lng: -80.25 }); // north of the ring

    const body = { polygon: RING, repId: fx.saad.memberId };
    expect(JSON.stringify(body).length).toBeLessThan(2_000); // payload does not scale with doors

    const res = await post("/api/leads/assign-selection", fx.manager.session, body);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.assigned).toBe(12_000);
    expect(json.total).toBe(12_000);
    expect(json.skipped).toBe(0);

    expect(leadById(inside[0]).assigned_rep_id).toBe(fx.saad.memberId);
    expect(leadById(inside[11_999]).assigned_rep_id).toBe(fx.saad.memberId);
    // Every moved door carries its audit event, and the door outside the ring
    // is untouched in both tables.
    expect(eventCount(inside[0])).toBe(1);
    expect(leadById(outside).assigned_rep_id).toBeNull();
    expect(eventCount(outside)).toBe(0);
  }, 60_000);

  it("honours the status refinement using the map's display-state rule", async () => {
    const unworked = seedLead({ lat: 35.86, lng: -80.26 });
    // leadStatus not_interested + lastOutcome already_customer is the pair that
    // pinDisplayState reads as "already_customer", not "not_interested" - so a
    // refinement naming one must not catch the other.
    const alreadyCustomer = seedLead({
      lat: 35.86, lng: -80.261, leadStatus: "not_interested",
      lastOutcome: "already_customer", lastOutcomeAt: new Date().toISOString(),
    });

    const res = await post("/api/leads/assign-selection", fx.manager.session, {
      polygon: RING, repId: fx.other.memberId, includeStates: ["unworked"],
    });
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(leadById(unworked).assigned_rep_id).toBe(fx.other.memberId);
    expect(leadById(alreadyCustomer).assigned_rep_id).not.toBe(fx.other.memberId);
    expect(json.total).toBeGreaterThan(0);
  });

  it("returns a selection to the pool when repId is null", async () => {
    const id = seedLead({ lat: 35.87, lng: -80.27, assignedRepId: fx.saad.memberId });
    const res = await post("/api/leads/assign-selection", fx.manager.session, {
      polygon: RING, repId: null, includeStates: ["unworked"],
    });
    expect(res.status).toBe(200);
    expect(leadById(id).assigned_rep_id).toBeNull();
  });
});

describe("authority", () => {
  it("a team_lead moves their own team's doors and never another team's", async () => {
    // Lena leads Owen. Her ring may move Owen's door to herself; Otto is on
    // nobody's team but her own reps', so his door is untouchable.
    const ownTeam = seedLead({ lat: 35.88, lng: -80.28, assignedRepId: fx.owned.memberId });
    const foreign = seedLead({ lat: 35.88, lng: -80.281, assignedRepId: fx.other.memberId });

    const res = await post("/api/leads/assign-selection", fx.lead.session, {
      polygon: RING, repId: fx.lead.memberId,
    });
    expect(res.status).toBe(200);

    expect(leadById(ownTeam).assigned_rep_id).toBe(fx.lead.memberId);
    expect(leadById(foreign).assigned_rep_id).toBe(fx.other.memberId);
  });

  it("a team_lead's ring is bounded by what their map actually shows", async () => {
    // With open-field OFF (the default) an unassigned, un-territoried door is
    // not visible to a team_lead - repVisibilitySql omits it - so their lasso
    // cannot select it and neither can this endpoint. canReassignLead would
    // permit the claim; visibility is the tighter of the two rules and wins.
    // The id-based path had the same property for the same reason: the client
    // could only ever enumerate pins it was shown.
    const invisible = seedLead({ lat: 35.885, lng: -80.285 });

    const res = await post("/api/leads/assign-selection", fx.lead.session, {
      polygon: RING, repId: fx.owned.memberId,
    });
    expect(res.status).toBe(200);
    expect(leadById(invisible).assigned_rep_id).toBeNull();

    // A manager, whose scope is org-wide, sweeps up the very same door.
    const mgr = await post("/api/leads/assign-selection", fx.manager.session, {
      polygon: RING, repId: fx.owned.memberId, includeStates: ["unworked"],
    });
    expect(mgr.status).toBe(200);
    expect(leadById(invisible).assigned_rep_id).toBe(fx.owned.memberId);
  });

  it("refuses a rep outside the caller's team", async () => {
    const res = await post("/api/leads/assign-selection", fx.lead.session, {
      polygon: RING, repId: fx.other.memberId,
    });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("OUT_OF_SCOPE");
  });
});

describe("input guards", () => {
  it("rejects a degenerate ring", async () => {
    const res = await post("/api/leads/assign-selection", fx.manager.session, {
      polygon: [[-80.3, 35.8], [-80.2, 35.8]], repId: fx.saad.memberId,
    });
    expect(res.status).toBe(400);
  });

  it("rejects non-numeric ring points rather than coercing them", async () => {
    const res = await post("/api/leads/assign-selection", fx.manager.session, {
      polygon: [[-80.3, 35.8], ["x", 35.8], [-80.2, 35.9]], repId: fx.saad.memberId,
    });
    expect(res.status).toBe(400);
  });

  it("rejects an over-large deselect list instead of becoming the id path again", async () => {
    const res = await post("/api/leads/assign-selection", fx.manager.session, {
      polygon: RING, repId: fx.saad.memberId,
      excludeLeadIds: Array.from({ length: 5_001 }, (_, i) => i + 1),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("TOO_MANY_EXCLUDES");
  });

  it("omits a manually deselected door", async () => {
    const keep = seedLead({ lat: 35.89, lng: -80.29 });
    const drop = seedLead({ lat: 35.89, lng: -80.291 });
    const res = await post("/api/leads/assign-selection", fx.manager.session, {
      polygon: RING, repId: fx.saad.memberId,
      includeStates: ["unworked"], excludeLeadIds: [drop],
    });
    expect(res.status).toBe(200);
    expect(leadById(keep).assigned_rep_id).toBe(fx.saad.memberId);
    expect(leadById(drop).assigned_rep_id).toBeNull();
  });
});

describe("bulk-assign's cap is now reachable", () => {
  // The point of the corrected cap: a caller that sends too many ids gets the
  // route's own message, not a body-parser rejection it cannot interpret.
  it("answers BULK_TOO_LARGE within the body limit", async () => {
    const res = await post("/api/leads/bulk-assign", fx.manager.session, {
      leadIds: Array.from({ length: 6_001 }, (_, i) => i + 1),
      repId: fx.saad.memberId,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("BULK_TOO_LARGE");
  });
});
