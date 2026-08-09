// The lead push channel must not leak past the boundary REST already defends.
//
// A stream is the easy place to get this wrong: the connection is authorized
// once, then events are pushed for the life of it. If delivery is filtered only
// by tenant, every rep in the org receives every door — including areas they
// were never assigned. These tests drive the real endpoint over real HTTP and
// assert on what actually arrives on the wire.
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let server: Server; let baseUrl: string; let storage: any;
const fx: Record<string, any> = {};

function person(name: string, role: string, tenantId = 1) {
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}@stream.test`;
  const m = storage.createTeamMember({ name, email, role, active: true, tenantId } as any);
  const u = storage.createUser({ name, email, role, active: true, tenantId, teamMemberId: m.id } as any);
  return { memberId: m.id, userId: u.id, session: storage.createSession(u.id).id };
}
const H = (s: string) => ({ "content-type": "application/json", "x-session-id": s, "x-csrf-token": s });

const SQ = [[-80.41, 35.49], [-80.39, 35.49], [-80.39, 35.51], [-80.41, 35.51], [-80.41, 35.49]];
let n = 0;
const area = (repIds: number[], tenantId = 1) => storage.createTerritory({
  tenantId, name: `A${++n}`, repId: repIds[0], polygon: JSON.stringify(SQ), color: "#3EA394",
  status: repIds.length > 1 ? "shared" : "active", assigneeIds: JSON.stringify(repIds),
} as any).id;
const door = (territoryId: number, repId: number, tenantId = 1) => storage.createLead({
  address: `${++n} Stream St`, city: "T", state: "NC", zip: "28100", lat: 35.5, lng: -80.4,
  tenantId, assignedRepId: repId, assignedTerritoryId: territoryId, leadStatus: "prospect",
} as any).id;

/**
 * Open the stream, run `act`, and return the raw frames received within `ms`.
 * Deliberately reads the WIRE rather than any in-process hook: what matters is
 * what reaches the socket, not what the bus thought it was doing.
 */
async function collect(session: string, act: () => Promise<void>, ms = 1200, since?: string) {
  const ac = new AbortController();
  const url = `${baseUrl}/api/leads/stream${since ? `?since=${encodeURIComponent(since)}` : ""}`;
  const res = await fetch(url, { headers: H(session), signal: ac.signal });
  if (res.status !== 200) { ac.abort(); return { status: res.status, text: "" }; }

  let text = "";
  const reader = (res.body as any).getReader();
  const dec = new TextDecoder();
  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += dec.decode(value, { stream: true });
      }
    } catch { /* aborted */ }
  })();

  await new Promise(r => setTimeout(r, 150)); // let "ready" land
  await act();
  await new Promise(r => setTimeout(r, ms));
  ac.abort();
  await pump.catch(() => {});
  return { status: 200, text };
}

const knock = (leadId: number, session: string) =>
  fetch(`${baseUrl}/api/leads/${leadId}/knock`, {
    method: "POST", headers: H(session),
    body: JSON.stringify({ outcome: "sold", wasHome: true }),
  }).then(() => undefined);

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-stream-authz-"));
  process.env.NODE_ENV = "test";
  const mod = await import("../../server/storage");
  mod.runMigrations(); storage = mod.storage;
  fx.manager = person("Mona Manager", "manager");
  fx.repA = person("Ann Rivera", "rep");
  fx.repB = person("Bo Chen", "rep");
  fx.outsider = person("Cam Outside", "rep");
  storage.createTenant({ slug: "t2-stream", companyName: "O", ownerName: "O",
    ownerEmail: "o@t2stream.test", brandName: "O", brandColor: "#111", plan: "trial", status: "active" } as any);
  fx.foreign = person("Zed Foreign", "rep", 2);

  const { registerRoutes, registerSaasRoutes } = await import("../../server/routes");
  const app = express(); app.use(express.json()); server = createServer(app);
  registerRoutes(server, app); registerSaasRoutes(app);
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(() => new Promise<void>(r => server.close(() => r())));

describe("who may open the stream", () => {
  it("refuses an unauthenticated caller", async () => {
    const res = await fetch(`${baseUrl}/api/leads/stream`);
    expect(res.status).toBe(401);
    res.body?.cancel?.();
  });

  it("opens for an authenticated rep and announces a resume token", async () => {
    const { status, text } = await collect(fx.repA.session, async () => {}, 300);
    expect(status).toBe(200);
    expect(text).toContain("event: ready");
    // epoch.seq — the cursor to resume with. The epoch is an opaque per-process
    // id (not a number): it exists so a cursor minted before a restart is not
    // silently applied to a fresh, lower seq space.
    expect(text).toMatch(/"since":"[A-Za-z0-9_-]+\.\d+"/);
  });
});

describe("delivery is filtered per event, not per tenant", () => {
  it("a rep on the SHARED area receives a door another rep marked", async () => {
    const a = area([fx.repA.memberId, fx.repB.memberId]);
    const id = door(a, fx.repA.memberId);
    const { text } = await collect(fx.repB.session, () => knock(id, fx.repA.session));
    expect(text).toContain("event: lead");
    expect(text).toContain(`"leadId":${id}`);
  });

  it("a rep NOT on the area receives nothing for it - same tenant", async () => {
    // THE property. Same org, same stream, no access → no event.
    const a = area([fx.repA.memberId]);
    const id = door(a, fx.repA.memberId);
    const { text } = await collect(fx.outsider.session, () => knock(id, fx.repA.session));
    expect(text).not.toContain(`"leadId":${id}`);
  });

  it("never crosses the tenant wall", async () => {
    const a = area([fx.repA.memberId]);
    const id = door(a, fx.repA.memberId);
    const { text } = await collect(fx.foreign.session, () => knock(id, fx.repA.session));
    expect(text).not.toContain(`"leadId":${id}`);
    expect(text).not.toContain("event: lead");
  });

  it("leadership sees it without being on the area", async () => {
    const a = area([fx.repA.memberId]);
    const id = door(a, fx.repA.memberId);
    const { text } = await collect(fx.manager.session, () => knock(id, fx.repA.session));
    expect(text).toContain(`"leadId":${id}`);
  });
});

describe("a roster move re-scopes a stream that is already open", () => {
  // Regression: the per-connection scope memo was invalidated only by a stamp
  // that /api/team writes moved. Approving a leader hire re-homes the picked
  // downline from /api/onboarding, so the stamp never moved and the memo — which
  // has no TTL — kept the pre-move roster for the life of the connection. The
  // scope is authority, not decoration: a stale one keeps streaming a moved
  // rep's doors, with full address and contact fields, to their former lead.
  it("stops delivering a rep's doors to the lead they were moved away from", async () => {
    const rep = person("Rex Moved", "rep");
    const from = person("Lee From", "team_lead");
    const to = person("Tay To", "team_lead");
    storage.updateTeamMember(rep.memberId, { reportsToId: from.memberId });

    const a = area([rep.memberId]);
    const primed = door(a, rep.memberId);
    const afterMove = door(a, rep.memberId);

    // Knocked BY the manager ON the rep's behalf: a freshly created rep still
    // owes training, and that 403 would make this test green for the wrong
    // reason. Leadership is exempt, so the event lands either way and what is
    // measured stays the lead's scope.
    const knockFor = (leadId: number) =>
      fetch(`${baseUrl}/api/leads/${leadId}/knock`, {
        method: "POST", headers: H(fx.manager.session),
        body: JSON.stringify({ outcome: "sold", wasHome: true, repId: rep.memberId }),
      }).then(() => undefined);

    const { text } = await collect(from.session, async () => {
      // PRIME first. The memo starts unresolved, so a move before any event
      // would be picked up by the initial resolve and prove nothing — this
      // knock is what puts the pre-move roster into the closure.
      await knockFor(primed);
      await new Promise(r => setTimeout(r, 200));
      // The write the approval route performs. Deliberately called on storage
      // rather than over /api/team: that is the whole point — the invalidation
      // must not depend on which route happened to make the change.
      storage.updateTeamMember(rep.memberId, { reportsToId: to.memberId });
      await knockFor(afterMove);
    }, 1500);

    // Proves the memo was live and delivering — without this the assertion
    // below could pass simply because nothing was ever streaming.
    expect(text).toContain(`"leadId":${primed}`);
    expect(text).not.toContain(`"leadId":${afterMove}`);
  });
});

describe("frames carry what a client needs to order and resume", () => {
  it("every lead frame has an id: of the form epoch.seq", async () => {
    const a = area([fx.repA.memberId]);
    const id = door(a, fx.repA.memberId);
    const { text } = await collect(fx.repA.session, () => knock(id, fx.repA.session));
    expect(text).toMatch(/^id: [A-Za-z0-9_-]+\.\d+$/m);
  });

  it("carries no secret material", async () => {
    const a = area([fx.repA.memberId]);
    const id = door(a, fx.repA.memberId);
    const { text } = await collect(fx.repA.session, () => knock(id, fx.repA.session));
    expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);        // JWT
    expect(text).not.toMatch(/authorization|bearer|password/i);
    expect(text).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)/);  // upstream URLs
  });

  it("replay through ?since is filtered by the SAME access check", async () => {
    // The leak that matters most: live delivery guarded, replay not.
    //
    // The cursor must carry the REAL epoch. A made-up one ("0.0") is treated as
    // stale, the server resyncs instead of replaying, and the test passes
    // without ever exercising the replay path — which is exactly what the first
    // version of this test did.
    const a = area([fx.repA.memberId]);
    const id = door(a, fx.repA.memberId);

    // Take a live epoch from a connection that is allowed to have one.
    const probe = await collect(fx.repA.session, async () => {}, 200);
    const epoch = probe.text.match(/"epoch":"([A-Za-z0-9_-]+)"/)?.[1];
    expect(epoch, "no epoch announced - replay cannot be tested").toBeTruthy();

    await knock(id, fx.repA.session);                 // now in the replay buffer

    // An authorized rep resuming from 0 DOES get it back — proves replay ran.
    const allowed = await collect(fx.repA.session, async () => {}, 600, `${epoch}.0`);
    expect(allowed.text).toContain(`"leadId":${id}`);

    // The unauthorized rep, same cursor, same buffer: nothing.
    const denied = await collect(fx.outsider.session, async () => {}, 600, `${epoch}.0`);
    expect(denied.text).not.toContain(`"leadId":${id}`);
  });
});
