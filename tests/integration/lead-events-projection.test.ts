// ── Every write that changes a pin's display state emits a lead event ────────
// Owner ask: "if multiple reps are working the same area, one rep's marking
// should be instant on the other person's phone." The delivery walls (tenant +
// repCanAccessLead, bytes off the socket) are proven in lead-stream.test.ts;
// THIS file proves the other half of instant-and-correct:
//
//  1. EMISSION — the write paths a teammate must see (knock, central
//     disposition, bulk assign-mark, PATCH mark, bulk status) each put an
//     event in the ring, SYNCHRONOUSLY with the HTTP write: the event is
//     already there when the response resolves, so there is no polling
//     interval or debounce between the DB write and the SSE flush.
//  2. PROJECTION — each event carries the post-write row's display fields
//     (leadStatus / lastOutcome / lastOutcomeAt / assignMark), so
//     pinDisplayState on the receiving phone computes exactly the state the
//     sender sees. The knock path is asserted post-CAS: a stale offline knock
//     that LOSES the recency CAS must broadcast the surviving winner, never
//     the stale outcome it carried.
//  3. REFETCH BASELINE — /api/leads/map ships lastOutcomeAt (wire v7), the
//     same clock the events carry, so a client that refetches mid-stream can
//     re-run the server's CAS ordering against later pushes.
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unpackMapPins } from "../../shared/mapPinsWire";
import { pinDisplayState } from "../../shared/knock";

let server: Server;
let baseUrl: string;
let storage: (typeof import("../../server/storage"))["storage"];
let leadEvents: typeof import("../../server/leadEvents");

interface Person { memberId: number; userId: number; session: string }
let rep: Person;
let manager: Person;
let sharedArea: number;

const realFetch = globalThis.fetch.bind(globalThis);
let uniq = 0;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-lead-events-proj-"));
  process.env.NODE_ENV = "test";

  const storageModule = await import("../../server/storage");
  storageModule.runMigrations();
  storage = storageModule.storage;
  leadEvents = await import("../../server/leadEvents");

  rep = person("Ray Field", "rep", 1);
  manager = person("Meg Central", "manager", 1);
  sharedArea = storage.createTerritory({
    tenantId: 1, name: "Projection Area", repId: rep.memberId,
    polygon: JSON.stringify([[-80.41, 35.49], [-80.39, 35.49], [-80.39, 35.51], [-80.41, 35.51], [-80.41, 35.49]]),
    color: "#3EA394", status: "active", assigneeIds: JSON.stringify([rep.memberId]),
  } as any).id;

  const { registerRoutes } = await import("../../server/routes");
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  server = createServer(app);
  registerRoutes(server, app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server.close((e) => (e ? reject(e) : resolve()));
    server.closeAllConnections?.();
  });
});

function person(name: string, role: string, tenantId: number): Person {
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}@lead-events-proj.test`;
  const member = storage.createTeamMember({ name, email, role, active: true, tenantId } as any);
  const user = storage.createUser({ name, email, role, active: true, tenantId, teamMemberId: member.id } as any);
  return { memberId: member.id, userId: user.id, session: storage.createSession(user.id).id };
}

const door = (extra: Record<string, unknown> = {}) =>
  storage.createLead({
    address: `${++uniq} Projection St`, city: "Kannapolis", state: "NC", zip: "28081",
    lat: 35.5, lng: -80.4, tenantId: 1, assignedRepId: rep.memberId,
    assignedTerritoryId: sharedArea, leadStatus: "prospect", ...extra,
  } as any).id;

const req = async (path: string, session: string, init: RequestInit = {}) => {
  const res = await realFetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-session-id": session, ...init.headers },
  });
  return res;
};

/** Events for one lead emitted after `cursor`, straight from the ring the SSE
 *  endpoint replays from. Read AFTER the HTTP response resolves and with NO
 *  waiting: emission is required to be synchronous with the write. */
const eventsFor = (leadId: number, cursor: number) =>
  leadEvents.eventsSince(1, cursor).events.filter((e) => e.leadId === leadId);

describe("central disposition", () => {
  it("emits synchronously, with the projection another phone needs to recolor", async () => {
    const leadId = door();
    const cursor = leadEvents.leadEventsCursor(1);
    const res = await req(`/api/leads/${leadId}/central-disposition`, manager.session, {
      method: "POST", body: JSON.stringify({ outcome: "already_customer" }),
    });
    expect(res.status).toBe(200);
    const updated = await res.json();

    const evts = eventsFor(leadId, cursor);
    expect(evts.length).toBe(1);
    const evt = evts[0];
    expect(evt.type).toBe("outcome");
    expect(evt.lead).not.toBeNull();
    expect(evt.lead!.leadStatus).toBe("not_interested");
    expect(evt.lead!.lastOutcome).toBe("already_customer");
    // The CAS clock rides the event — without it the receiving phone cannot
    // order this push against its own state.
    expect(evt.lead!.lastOutcomeAt).toBe(updated.lastOutcomeAt);
    // The receiving phone's display authority computes the SAME state the
    // marking manager sees.
    expect(pinDisplayState({ leadStatus: evt.lead!.leadStatus!, visited: true, lastOutcome: evt.lead!.lastOutcome }))
      .toBe("already_customer");
  });
});

describe("assign-mark paths", () => {
  it("bulk-mark emits one event per changed lead, carrying the mark", async () => {
    const a = door();
    const b = door();
    const cursor = leadEvents.leadEventsCursor(1);
    const res = await req("/api/leads/bulk-mark", manager.session, {
      method: "POST", body: JSON.stringify({ leadIds: [a, b], mark: "priority" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).updated).toBe(2);
    for (const id of [a, b]) {
      const evts = eventsFor(id, cursor);
      expect(evts.length, `lead ${id} must emit`).toBe(1);
      expect(evts[0].lead?.assignMark).toBe("priority");
    }
  });

  it("clearing a mark also emits - a stale triage chip is a wrong pin too", async () => {
    const a = door();
    await req("/api/leads/bulk-mark", manager.session, {
      method: "POST", body: JSON.stringify({ leadIds: [a], mark: "hold" }),
    });
    const cursor = leadEvents.leadEventsCursor(1);
    const res = await req("/api/leads/bulk-mark", manager.session, {
      method: "POST", body: JSON.stringify({ leadIds: [a], mark: null }),
    });
    expect(res.status).toBe(200);
    const evts = eventsFor(a, cursor);
    expect(evts.length).toBe(1);
    expect(evts[0].lead?.assignMark).toBeNull();
  });

  it("a single-lead PATCH mark emits with the mark in the projection", async () => {
    const a = door();
    const cursor = leadEvents.leadEventsCursor(1);
    const res = await req(`/api/leads/${a}`, manager.session, {
      method: "PATCH", body: JSON.stringify({ assignMark: "priority" }),
    });
    expect(res.status).toBe(200);
    const evts = eventsFor(a, cursor);
    expect(evts.length).toBe(1);
    expect(evts[0].lead?.assignMark).toBe("priority");
  });
});

describe("knock path - post-CAS projection", () => {
  it("a winning knock broadcasts its own outcome and clock", async () => {
    const leadId = door();
    const knockedAt = new Date(Date.now() - 5_000).toISOString();
    const cursor = leadEvents.leadEventsCursor(1);
    const res = await req(`/api/leads/${leadId}/knock`, rep.session, {
      method: "POST", body: JSON.stringify({ outcome: "sold", knockedAt }),
    });
    expect(res.status).toBeLessThan(300);
    const evts = eventsFor(leadId, cursor);
    expect(evts.length).toBe(1);
    expect(evts[0].type).toBe("outcome");
    expect(evts[0].lead?.leadStatus).toBe("sold");
    expect(evts[0].lead?.lastOutcome).toBe("sold");
    expect(evts[0].lead?.lastOutcomeAt).toBe(knockedAt);
  });

  it("a knock that LOSES the recency CAS still emits - carrying the WINNER, not the stale outcome", async () => {
    const leadId = door();
    // Central mark now — this is the newest disposition on the door.
    const central = await req(`/api/leads/${leadId}/central-disposition`, manager.session, {
      method: "POST", body: JSON.stringify({ outcome: "not_interested" }),
    });
    const centralRow = await central.json();

    // A stale offline knock flushes late: tapped BEFORE the central mark.
    const staleAt = new Date(Date.now() - 60_000).toISOString();
    const cursor = leadEvents.leadEventsCursor(1);
    const res = await req(`/api/leads/${leadId}/knock`, rep.session, {
      method: "POST", body: JSON.stringify({ outcome: "sold", knockedAt: staleAt }),
    });
    expect(res.status).toBeLessThan(300);
    expect((await res.json()).superseded).toBe(true);

    // The teammate's phone still hears the door was worked — but the
    // projection is the post-CAS row, so applying it CANNOT repaint the door
    // to the stale "sold" the losing knock carried.
    const evts = eventsFor(leadId, cursor);
    expect(evts.length).toBe(1);
    expect(evts[0].lead?.leadStatus).toBe("not_interested");
    expect(evts[0].lead?.lastOutcome).toBe("not_interested");
    expect(evts[0].lead?.lastOutcomeAt).toBe(centralRow.lastOutcomeAt);
  });
});

describe("bulk status (lasso Modify Status)", () => {
  it("emits per changed lead with the new disposition and clock", async () => {
    const a = door();
    const cursor = leadEvents.leadEventsCursor(1);
    const res = await req("/api/leads/bulk-status", manager.session, {
      method: "POST", body: JSON.stringify({ leadIds: [a], outcome: "follow_up" }),
    });
    expect(res.status).toBe(200);
    const evts = eventsFor(a, cursor);
    expect(evts.length).toBe(1);
    expect(evts[0].lead?.leadStatus).toBe("follow_up");
    expect(evts[0].lead?.lastOutcome).toBe("follow_up");
    expect(evts[0].lead?.lastOutcomeAt).toBeTruthy();
  });
});

describe("map refetch carries the same CAS clock the stream uses (wire v7)", () => {
  it("a centrally marked, never-knocked door ships lastOutcomeAt on the packed pin", async () => {
    const leadId = door();
    const central = await req(`/api/leads/${leadId}/central-disposition`, manager.session, {
      method: "POST", body: JSON.stringify({ outcome: "follow_up" }),
    });
    const row = await central.json();

    const res = await req("/api/leads/map?format=packed", rep.session);
    expect(res.status).toBe(200);
    const { pins } = unpackMapPins<{ id: number; leadStatus: string; visited?: boolean; lastOutcome?: string; lastOutcomeAt?: string; lastKnockedAt?: string }>(await res.json());
    const pin = pins.find((p) => p.id === leadId);
    expect(pin, "the rep must see their area's door").toBeTruthy();
    expect(pin!.lastOutcome).toBe("follow_up");
    expect(pin!.visited).toBe(true);
    // The refetch baseline: identical to the clock the stream stamped, so a
    // later push older than this mark is ignored and a newer one recolors.
    expect(pin!.lastOutcomeAt).toBe(row.lastOutcomeAt);
    // No knock ever happened, and the wire must not pretend one did.
    expect(pin!.lastKnockedAt).toBeUndefined();
  });

  it("a knocked door's packed pin carries the knock's clock", async () => {
    const leadId = door();
    const knockedAt = new Date(Date.now() - 3_000).toISOString();
    await req(`/api/leads/${leadId}/knock`, rep.session, {
      method: "POST", body: JSON.stringify({ outcome: "interested", knockedAt }),
    });
    const res = await req("/api/leads/map?format=packed", rep.session);
    const { pins } = unpackMapPins<{ id: number; lastOutcomeAt?: string }>(await res.json());
    expect(pins.find((p) => p.id === leadId)?.lastOutcomeAt).toBe(knockedAt);
  });
});
