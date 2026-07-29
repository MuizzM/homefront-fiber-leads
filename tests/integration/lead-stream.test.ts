// ── GET /api/leads/stream — the server push channel ───────────────────────────
// /api/leads/events is a data-free ping, so its only authorization question is
// "which tenant". This stream carries the changed PIN, which means the socket
// re-answers "may this identity see this door" on every single frame — once at
// the handshake is not enough, because a rep's access changes underneath a
// connection that may live for a whole shift.
//
// Every assertion below reads BYTES OFF THE SOCKET rather than the in-process
// bus. That distinction is the point of the file: the bus is deliberately
// process-wide (every subscriber sees every tenant), so a test that asserts on
// what was emitted would stay green with the wire filter deleted.
//
// Negative assertions never rely on a sleep. Each one rides a POSITIVE CONTROL
// emitted AFTER the event that must not appear: once the control lands, the
// forbidden frame has already had its chance to arrive and been dropped. A bare
// timeout would pass just as happily against a stream that was simply slow.
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let server: Server;
let baseUrl: string;
let storage: (typeof import("../../server/storage"))["storage"];
let leadEvents: typeof import("../../server/leadEvents");

// tenant 1
let repA: Person;      // holds the shared area AND a private one
let repB: Person;      // second assignee on the shared area — the teammate case
let repC: Person;      // same org, different ground — the "no access" case
let manager: Person;   // org-wide, on no area at all
let caller: Person;    // calling_rep: authenticated, but no field.app.use
// tenant 2
let repZ: Person;

let sharedArea: number;
let privateArea: number;
let repCArea: number;
let foreignArea: number;

// Secret shapes that must not survive the projection: a JWT long enough to trip
// the shared scrubber, the provider URL an upstream error echoes, and PII a rep
// typed into a note. The note body is the sharper of the two — a phone number
// reaches this row through a field the pin allowlist simply never names.
const JWT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.LEADSTREAMSUPERSECRETJWTPAYLOADXXXXXXXXXXXX.sigQrStUv";
const PROVIDER_URL = "https://api.gokinetic.com/v3/availability?key=hunter2";
const CONTACT_PHONE = "704-555-0199";
const CONTACT_NAME = "Dolores Abernathy";

const realFetch = globalThis.fetch.bind(globalThis);

interface Person { memberId: number; userId: number; session: string }

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-lead-stream-"));
  process.env.NODE_ENV = "test";

  const storageModule = await import("../../server/storage");
  storageModule.runMigrations();
  storage = storageModule.storage;
  const { rawDb } = await import("../../server/db");

  rawDb.prepare(
    "INSERT OR IGNORE INTO tenants (id, slug, company_name, owner_name, owner_email, brand_name) VALUES (2, 'tenant-b-lead-stream', 'Tenant B', 'Owner B', 'owner-b-lead-stream@example.test', 'Tenant B')",
  ).run();

  repA = person("Ann Rivera", "rep", 1);
  repB = person("Bo Chen", "rep", 1);
  repC = person("Cam Ortiz", "rep", 1);
  manager = person("Mona Vance", "manager", 1);
  caller = person("Kit Dial", "calling_rep", 1);
  repZ = person("Zed Foreign", "rep", 2);

  // Many-to-many by design: the shared area is why lead access cannot hang on
  // leads.assigned_rep_id, which names exactly one person.
  sharedArea = area([repA.memberId, repB.memberId], 1);
  privateArea = area([repA.memberId], 1);
  repCArea = area([repC.memberId], 1);
  foreignArea = area([repZ.memberId], 2);

  leadEvents = await import("../../server/leadEvents");

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
    // An event stream never ends on its own, so a test that fails mid-stream
    // leaves a socket the server would wait on forever. Dropping them here keeps
    // a single assertion failure from surfacing as a hook timeout instead.
    server.closeAllConnections?.();
  });
});

// ── Fixtures ─────────────────────────────────────────────────────────────────
// A rep's visibility scope is derived from team_members, not users, so an
// identity without a linked member resolves to a scope that matches nothing.
function person(name: string, role: string, tenantId: number): Person {
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}@lead-stream.test`;
  const member = storage.createTeamMember({ name, email, role, active: true, tenantId } as any);
  const user = storage.createUser({ name, email, role, active: true, tenantId, teamMemberId: member.id } as any);
  return { memberId: member.id, userId: user.id, session: storage.createSession(user.id).id };
}

const SQUARE = [[-80.41, 35.49], [-80.39, 35.49], [-80.39, 35.51], [-80.41, 35.51], [-80.41, 35.49]];
let uniq = 0;

const area = (repIds: number[], tenantId: number) => storage.createTerritory({
  tenantId, name: `Area ${++uniq}`, repId: repIds[0], polygon: JSON.stringify(SQUARE), color: "#3EA394",
  status: repIds.length > 1 ? "shared" : "active", assigneeIds: JSON.stringify(repIds),
} as any).id;

// Addresses are canonicalized into a unique key on insert, so every door needs a
// distinct street number or createLead resolves to the existing row instead.
const door = (territoryId: number, repId: number, tenantId: number, extra: Record<string, unknown> = {}) =>
  storage.createLead({
    address: `${++uniq} Stream St`, city: "Kannapolis", state: "NC", zip: "28081", lat: 35.5, lng: -80.4,
    tenantId, assignedRepId: repId, assignedTerritoryId: territoryId, leadStatus: "prospect", ...extra,
  } as any).id;

// ── HTTP + SSE plumbing ──────────────────────────────────────────────────────
const headersFor = (session?: string) => ({
  "content-type": "application/json",
  ...(session ? { "x-session-id": session } : {}),
});

const knock = async (leadId: number, session: string, outcome = "sold") => {
  const res = await realFetch(`${baseUrl}/api/leads/${leadId}/knock`, {
    method: "POST", headers: headersFor(session), body: JSON.stringify({ outcome }),
  });
  // A write that silently 404'd would make every downstream "no frame arrived"
  // assertion vacuously true.
  expect(res.status, `knock on lead ${leadId} failed: ${await res.clone().text()}`).toBeLessThan(300);
  await res.text();
};

const writeNote = async (leadId: number, session: string, notes: string) => {
  const res = await realFetch(`${baseUrl}/api/leads/${leadId}/notes`, {
    method: "PATCH", headers: headersFor(session), body: JSON.stringify({ notes }),
  });
  expect(res.status).toBe(200);
  await res.text();
};

interface Frame { id?: string; event: string; data: any }

interface Stream {
  status: number;
  contentType: string;
  frames: Frame[];
  raw: () => string;
  leads: () => Frame[];
  leadIds: () => number[];
  ready: () => Promise<Frame>;
  awaitLead: (leadId: number, budgetMs?: number) => Promise<boolean>;
  close: () => Promise<void>;
}

/** One SSE block → a frame. Heartbeat comments (": ping") carry no event line
 *  and are dropped here so a keepalive can never be mistaken for a payload. */
function parseBlock(block: string): Frame | null {
  let id: string | undefined;
  let event = "";
  let data = "";
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("id: ")) id = line.slice(4);
    else if (line.startsWith("event: ")) event = line.slice(7);
    else if (line.startsWith("data: ")) data += line.slice(6);
  }
  if (!event) return null;
  return { id, event, data: data ? JSON.parse(data) : null };
}

/**
 * Open the real endpoint and decode frames as they land. Blocks are only parsed
 * once their terminating blank line has arrived — a chunk boundary mid-frame is
 * the normal case on a stream, and parsing a partial one would invent an event
 * that was never sent.
 */
async function open(session: string | undefined, query = "", extraHeaders: Record<string, string> = {}): Promise<Stream> {
  const ac = new AbortController();
  const res = await realFetch(`${baseUrl}/api/leads/stream${query}`, {
    headers: { ...headersFor(session), ...extraHeaders }, signal: ac.signal,
  });
  const frames: Frame[] = [];
  let raw = "";
  const contentType = res.headers.get("content-type") ?? "";

  if (res.status !== 200) {
    raw = await res.text().catch(() => "");
    ac.abort();
    return {
      status: res.status, contentType, frames, raw: () => raw, leads: () => [], leadIds: () => [],
      ready: async () => { throw new Error(`stream not open (${res.status})`); },
      awaitLead: async () => false,
      close: async () => { ac.abort(); },
    };
  }

  const reader = (res.body as any).getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        raw += chunk;
        buffered += chunk;
        for (let cut = buffered.indexOf("\n\n"); cut >= 0; cut = buffered.indexOf("\n\n")) {
          const frame = parseBlock(buffered.slice(0, cut));
          buffered = buffered.slice(cut + 2);
          if (frame) frames.push(frame);
        }
      }
    } catch { /* aborted by close() — the expected way this loop ends */ }
  })();

  const leads = () => frames.filter((f) => f.event === "lead");
  const stream: Stream = {
    status: res.status, contentType, frames, raw: () => raw,
    leads, leadIds: () => leads().map((f) => Number(f.data?.leadId)),
    ready: async () => {
      const got = await waitFor(() => frames.some((f) => f.event === "ready"));
      expect(got, "no ready frame — the client would paint nothing until the first write").toBe(true);
      return frames.find((f) => f.event === "ready")!;
    },
    awaitLead: (leadId, budgetMs) => waitFor(() => leads().some((f) => Number(f.data?.leadId) === leadId), budgetMs),
    close: async () => {
      ac.abort();
      await reader.cancel().catch(() => {});
      await pump.catch(() => {});
    },
  };
  return stream;
}

async function waitFor(predicate: () => boolean, budgetMs = 4000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (!predicate() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 15));
  return predicate();
}

/**
 * The listener count once the PREVIOUS test's sockets have finished tearing
 * down. Reading it directly races the teardown: an earlier stream still
 * detaching makes the baseline one too high, and then "a new stream attached"
 * can never be observed — the new listener merely replaces the departing one.
 */
async function settledListenerCount(): Promise<number> {
  let last = leadEvents.leadEventListenerCount();
  let stableSince = Date.now();
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
    const now = leadEvents.leadEventListenerCount();
    if (now !== last) { last = now; stableSince = Date.now(); continue; }
    if (Date.now() - stableSince >= 150) return now;
  }
  return last;
}

/** The live epoch, taken off the wire rather than out of the module — a resume
 *  cursor is only meaningful if a browser could have minted it from a frame. */
async function currentEpoch(): Promise<string> {
  const probe = await open(repA.session);
  const epoch = String((await probe.ready()).data.epoch);
  await probe.close();
  expect(epoch).toMatch(/^[A-Za-z0-9_-]+$/);
  return epoch;
}

describe("who may open the channel", () => {
  it("refuses an unauthenticated caller before any stream exists", async () => {
    const stream = await open(undefined);
    expect(stream.status).toBe(401);
    // A half-opened stream is worse than a refusal: the client would sit on a
    // socket that never delivers instead of falling back to polling.
    expect(stream.contentType).not.toContain("text/event-stream");
  });

  it("refuses an authenticated identity without field.app.use", async () => {
    // A calling_rep is a real session in the right tenant. Field capability is
    // what separates it from a door knocker, and the stream is field surface.
    const stream = await open(caller.session);
    expect(stream.status).toBe(403);
    expect(JSON.parse(stream.raw())).toMatchObject({ error: "Forbidden", need: "field.app.use" });
    expect(stream.contentType).not.toContain("text/event-stream");
  });

  it("opens for a rep and hands back a resume token immediately", async () => {
    const stream = await open(repA.session);
    expect(stream.status).toBe(200);
    expect(stream.contentType).toContain("text/event-stream");
    const ready = await stream.ready();
    // epoch.seq, not a bare number: the cursor has to carry the identity of the
    // seq space it was minted in, since seq restarts at 1 on every boot.
    expect(ready.data.since).toMatch(/^[A-Za-z0-9_-]+\.\d+$/);
    expect(ready.data.since.startsWith(`${ready.data.epoch}.`)).toBe(true);
    expect(ready.data.resync).toBe(false);
    await stream.close();
  });
});

describe("delivery is authorized per frame, not per connection", () => {
  it("a rep on a SHARED area receives a door another rep marked", async () => {
    // The bug this endpoint exists to avoid: two reps on one street, neither
    // seeing the other's work until a full refetch lands.
    const id = door(sharedArea, repA.memberId, 1);
    const stream = await open(repB.session);
    await stream.ready();

    await knock(id, repA.session);

    expect(await stream.awaitLead(id)).toBe(true);
    const frame = stream.leads().find((f) => Number(f.data.leadId) === id)!;
    expect(frame.data.type).toBe("outcome");
    expect(frame.data.tenantId).toBe(1);
    // The POST-write row: a pre-write projection would ship the old status and
    // the pin would repaint to the value the rep already had.
    expect(frame.data.lead.leadStatus).toBe("sold");
    expect(frame.data.lead.id).toBe(id);
    expect(frame.data.actorName).toBe("Ann Rivera");
    await stream.close();
  });

  it("a rep NOT on the area receives nothing for it — same tenant, same stream", async () => {
    // THE property. repC is a fully authorized field identity in the same org;
    // only the area assignment differs.
    const foreignDoor = door(privateArea, repA.memberId, 1);
    const ownDoor = door(repCArea, repC.memberId, 1);
    const stream = await open(repC.session);
    await stream.ready();

    await knock(foreignDoor, repA.session);   // must never arrive
    await knock(ownDoor, repC.session);       // control, emitted strictly after

    expect(await stream.awaitLead(ownDoor)).toBe(true);
    expect(stream.leadIds()).not.toContain(foreignDoor);
    expect(stream.raw()).not.toContain(`"leadId":${foreignDoor}`);
    await stream.close();
  });

  it("leadership receives it without holding the area", async () => {
    // Confirms the filter is repCanAccessLead and not a membership test — an
    // org-wide role is scope-less, so every door in the tenant is in scope.
    const id = door(privateArea, repA.memberId, 1);
    const stream = await open(manager.session);
    await stream.ready();
    await knock(id, repA.session);
    expect(await stream.awaitLead(id)).toBe(true);
    await stream.close();
  });
});

describe("tenant isolation", () => {
  it("a tenant-2 identity never receives a tenant-1 event", async () => {
    const t1Door = door(sharedArea, repA.memberId, 1);
    const t2Door = door(foreignArea, repZ.memberId, 2);
    // The tenant hint is supplied deliberately: the wall must come from the
    // session, so a client-named tenant has to change nothing at all.
    const stream = await open(repZ.session, "?tenantId=1&tenant_id=1");
    await stream.ready();

    await knock(t1Door, repA.session);
    await knock(t2Door, repZ.session);

    expect(await stream.awaitLead(t2Door)).toBe(true);
    expect(stream.leadIds()).not.toContain(t1Door);
    for (const frame of stream.leads()) expect(frame.data.tenantId).toBe(2);
    await stream.close();
  });

  it("a tenant-2 identity cannot resume into tenant 1's window", async () => {
    // Replay is the half of the channel that is easy to leave unguarded: live
    // delivery filtered, the reconnect window handed over whole.
    const epoch = await currentEpoch();
    const t1Door = door(privateArea, repA.memberId, 1);
    await knock(t1Door, repA.session);   // now sitting in the ring

    const stream = await open(repZ.session, `?since=${encodeURIComponent(`${epoch}.0`)}`);
    await stream.ready();
    // Seq 0 asks for everything the ring still holds; tenant 2's own history
    // comes back, tenant 1's does not.
    expect(await waitFor(() => stream.leads().length > 0)).toBe(true);
    for (const frame of stream.leads()) expect(frame.data.tenantId).toBe(2);
    expect(stream.leadIds()).not.toContain(t1Door);
    await stream.close();
  });

  it("a tenant-1 rep cannot open a stream scoped to another org's doors", async () => {
    // There is no addressing mode for "somebody else's tenant" — the only knob a
    // caller has is the cursor, and it is applied inside their own tenant slice.
    const epoch = await currentEpoch();
    const t2Door = door(foreignArea, repZ.memberId, 2);
    await knock(t2Door, repZ.session);

    const stream = await open(repC.session, `?since=${encodeURIComponent(`${epoch}.0`)}&tenantId=2`);
    expect(stream.status).toBe(200);
    await stream.ready();
    expect(await waitFor(() => stream.leadIds().includes(t2Door), 600)).toBe(false);
    for (const frame of stream.leads()) expect(frame.data.tenantId).toBe(1);
    await stream.close();
  });
});

describe("ordering and resume", () => {
  it("frames carry a strictly increasing seq matched by their id line", async () => {
    const ids = [door(privateArea, repA.memberId, 1), door(privateArea, repA.memberId, 1), door(privateArea, repA.memberId, 1)];
    const stream = await open(repA.session);
    const epoch = String((await stream.ready()).data.epoch);

    for (const id of ids) await knock(id, repA.session);
    expect(await stream.awaitLead(ids[2])).toBe(true);

    const seqs = stream.leads().map((f) => Number(f.data.seq));
    expect(seqs.length).toBeGreaterThanOrEqual(3);
    // Ordering is seq, never ts: two writes inside the same millisecond are
    // indistinguishable by timestamp and the client would apply them in either
    // order — which for an outcome flip is a wrong pin colour.
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    // The id line is what the browser echoes back as Last-Event-ID, so it must
    // name the same event the payload does.
    for (const frame of stream.leads()) expect(frame.id).toBe(`${epoch}.${frame.data.seq}`);
    await stream.close();
  });

  it("?since=<seq> replays only what came after that seq", async () => {
    const first = door(privateArea, repA.memberId, 1);
    const second = door(privateArea, repA.memberId, 1);

    const live = await open(repA.session);
    await live.ready();
    await knock(first, repA.session);
    expect(await live.awaitLead(first)).toBe(true);
    await knock(second, repA.session);
    expect(await live.awaitLead(second)).toBe(true);
    const cursor = Number(live.leads().find((f) => Number(f.data.leadId) === first)!.data.seq);
    await live.close();

    // A bare seq has no boot identity to check, so it can only mean "in the
    // current epoch" — which is exactly what a hand-rolled ?since= is.
    const resumed = await open(repA.session, `?since=${cursor}`);
    expect((await resumed.ready()).data.resync).toBe(false);
    expect(await resumed.awaitLead(second)).toBe(true);
    // Replay is oldest-first, so `first` would already have been written ahead
    // of `second` had the cursor been ignored.
    expect(resumed.leadIds()).not.toContain(first);
    await resumed.close();

    // Same cursor, same window, a rep who holds neither door: a cursor moves the
    // window, it never widens the scope. Replay is the half of the channel where
    // that is easy to lose — the events are already in hand by then, and handing
    // over the surviving tail is the obvious-looking implementation.
    const outsider = await open(repC.session, `?since=${cursor}`);
    await outsider.ready();
    expect(await waitFor(() => outsider.leads().length > 0, 600)).toBe(false);
    expect(outsider.leadIds()).not.toContain(second);
    await outsider.close();
  });

  it("accepts the qualified epoch.seq cursor identically", async () => {
    const epoch = await currentEpoch();
    const before = door(privateArea, repA.memberId, 1);
    const after = door(privateArea, repA.memberId, 1);

    const live = await open(repA.session);
    await live.ready();
    await knock(before, repA.session);
    expect(await live.awaitLead(before)).toBe(true);
    const cursor = Number(live.leads().find((f) => Number(f.data.leadId) === before)!.data.seq);
    await live.close();
    await knock(after, repA.session);

    const resumed = await open(repA.session, `?since=${encodeURIComponent(`${epoch}.${cursor}`)}`);
    expect((await resumed.ready()).data.resync).toBe(false);
    expect(await resumed.awaitLead(after)).toBe(true);
    expect(resumed.leadIds()).not.toContain(before);
    await resumed.close();
  });

  it("rejects a cursor minted in another epoch instead of silently applying it", async () => {
    const id = door(privateArea, repA.memberId, 1);
    await knock(id, repA.session);
    // A cursor from a restarted (or load-balanced-elsewhere) process names
    // completely different events under an identical-looking seq. Replaying
    // against it would skip real changes with nothing downstream able to tell.
    const stream = await open(repA.session, "?since=deadbeef-0000.0");
    const ready = await stream.ready();
    expect(ready.data.resync).toBe(true);
    expect(ready.data.epoch).not.toBe("deadbeef-0000");
    expect(await waitFor(() => stream.leads().length > 0, 600)).toBe(false);
    await stream.close();
  });

  it("a fresh connection tails instead of replaying a window it already has", async () => {
    // No cursor means the client just loaded the map through the role-scoped
    // endpoint, so replaying the ring would re-apply patches it already holds.
    const id = door(privateArea, repA.memberId, 1);
    await knock(id, repA.session);
    const stream = await open(repA.session);
    await stream.ready();
    expect(await waitFor(() => stream.leads().length > 0, 600)).toBe(false);
    await stream.close();
  });
});

describe("no secret material on the wire", () => {
  it("ships neither upstream credentials nor rep-typed PII", async () => {
    const id = door(privateArea, repA.memberId, 1, {
      address: `${++uniq} Token Ave ${PROVIDER_URL}`,
      contactName: CONTACT_NAME,
      contactPhone: CONTACT_PHONE,
      contactEmail: "dolores@example.test",
    });

    const stream = await open(repA.session);
    await stream.ready();
    // Both event types, because they carry the pin through different paths: the
    // note route hands over the updated row, the knock route re-reads it.
    await writeNote(id, repA.session, `called back, bearer ${JWT} via ${PROVIDER_URL}, ask for ${CONTACT_PHONE}`);
    await knock(id, repA.session);
    expect(await stream.awaitLead(id)).toBe(true);
    await waitFor(() => stream.leads().filter((f) => Number(f.data.leadId) === id).length >= 2);

    const raw = stream.raw();
    expect(raw).not.toMatch(/eyJ[A-Za-z0-9._-]{20,}/);          // JWT, any length
    expect(raw).not.toContain("LEADSTREAMSUPERSECRETJWTPAYLOAD");
    expect(raw).not.toContain("gokinetic");
    expect(raw).not.toContain("hunter2");
    expect(raw).not.toMatch(/https?:\/\//);                     // any upstream URL
    expect(raw).not.toMatch(/authorization|bearer|password/i);
    expect(raw).not.toContain(CONTACT_PHONE);
    expect(raw).not.toContain(CONTACT_NAME);

    for (const frame of stream.leads().filter((f) => Number(f.data.leadId) === id)) {
      // The address still arrives — scrubbed in place, not dropped, so the rep
      // can still tell which door moved.
      expect(frame.data.lead.address).toContain("Token Ave");
      expect(frame.data.lead.address).toContain("[redacted]");
      // Allowlist, not denylist: a column added to `leads` tomorrow must not
      // start shipping on its own.
      expect(Object.keys(frame.data.lead).sort()).toEqual([
        "address", "assignMark", "assignedRepId", "assignedTerritoryId", "city",
        "doNotKnock", "fiberStatus", "id", "lastOutcome", "lastOutcomeAt", "lat",
        "leadScore", "leadStatus", "leadTag", "lng", "state", "zip",
      ]);
    }
    // A "notes" frame says an open card should refetch; it never carries the
    // body, which is precisely where a customer's phone number ends up.
    const noteFrame = stream.leads().find((f) => Number(f.data.leadId) === id && f.data.type === "notes");
    expect(noteFrame, "no notes event — the PII assertion above proved nothing").toBeTruthy();
    expect(noteFrame!.data).not.toHaveProperty("notes");
    await stream.close();
  });
});

describe("connection lifecycle", () => {
  it("releases its bus subscription when the client hangs up", async () => {
    const baseline = await settledListenerCount();
    const stream = await open(repA.session);
    await stream.ready();
    expect(await waitFor(() => leadEvents.leadEventListenerCount() > baseline)).toBe(true);

    await stream.close();
    // Without this the process pays a repCanAccessLead scan per lead write for a
    // socket nobody is reading, forever — and the emitter's max-listeners
    // ceiling turns a leak into a warning long after the cause is gone.
    expect(await waitFor(() => leadEvents.leadEventListenerCount() === baseline)).toBe(true);
  });

  it("does not leak a listener across repeated connect/disconnect cycles", async () => {
    // A phone on a flaky LTE connection reconnects all shift. One retained
    // listener per drop is the shape that only shows up in production.
    const baseline = await settledListenerCount();
    for (let i = 0; i < 5; i++) {
      const stream = await open(repA.session);
      await stream.ready();
      await stream.close();
      expect(await waitFor(() => leadEvents.leadEventListenerCount() === baseline)).toBe(true);
    }
    expect(leadEvents.leadEventListenerCount()).toBe(baseline);
  }, 20_000);

  it("still delivers to the survivors after a peer disconnects", async () => {
    // Cleanup runs on both req and res close, and it is shared state (the
    // connection counter) it mutates — a cleanup that over-fired would take the
    // remaining streams' accounting with it.
    const id = door(sharedArea, repA.memberId, 1);
    const leaving = await open(repB.session);
    const staying = await open(repA.session);
    await leaving.ready();
    await staying.ready();
    await leaving.close();

    await knock(id, repA.session);
    expect(await staying.awaitLead(id)).toBe(true);
    expect(leaving.leadIds()).not.toContain(id);
    await staying.close();
  });
});
