// Academy endpoints — the security and durability contract.
//
//   * every read and write is OWN-scope: identity comes from the session, so a
//     rep can never reach another rep's coaching record,
//   * tenant walls hold: tenant 2 activity never appears in a tenant 1 read,
//     and a foreign user id reads as 404 rather than a refusal that confirms it,
//   * the supervisor surface is capability-gated, and returns counts and
//     averages rather than transcripts,
//   * progress and mid-activity state survive a round trip (resume),
//   * expired offers stop being quotable on their end date,
//   * role-play scores are recomputed SERVER-SIDE, so a client cannot post
//     itself a good report.
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PATH_STAGES } from "../../shared/academyPath";

let server: Server;
let baseUrl: string;
let storage: (typeof import("../../server/storage"))["storage"];
let rawDb: import("better-sqlite3").Database;

let repASession: string;
let repBSession: string;
let leadSession: string;
let managerSession: string;
let foreignManagerSession: string;
let repAUserId: number;
let repBUserId: number;
let foreignRepUserId: number;
const realFetch = globalThis.fetch.bind(globalThis);

/** A real activity of each shape, read off the authored path. */
const REFERENCE_ACTIVITY = PATH_STAGES[0].activities.find((a) => a.kind === "reference")!.id;
const SCORED_ACTIVITY = PATH_STAGES[0].activities.find((a) => a.passScore != null)!;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-academy-"));
  process.env.NODE_ENV = "test";

  const storageModule = await import("../../server/storage");
  storageModule.runMigrations();
  storage = storageModule.storage;
  ({ rawDb } = await import("../../server/db"));
  const { registerRoutes } = await import("../../server/routes");

  rawDb.prepare(
    "INSERT OR IGNORE INTO tenants (id, slug, company_name, owner_name, owner_email, brand_name) VALUES (2, 'tenant-b-academy', 'Tenant B', 'Owner B', 'owner-b-academy@example.com', 'Tenant B')",
  ).run();

  const repA = storage.createUser({ name: "Academy Rep A", email: "rep-a-academy@example.com", role: "rep", active: true, tenantId: 1 } as any);
  const repB = storage.createUser({ name: "Academy Rep B", email: "rep-b-academy@example.com", role: "rep", active: true, tenantId: 1 } as any);
  const lead = storage.createUser({ name: "Academy Lead", email: "lead-academy@example.com", role: "team_lead", active: true, tenantId: 1 } as any);
  const manager = storage.createUser({ name: "Academy Manager", email: "manager-academy@example.com", role: "manager", active: true, tenantId: 1 } as any);
  const foreignRep = storage.createUser({ name: "Tenant B Rep", email: "rep-b2-academy@example.com", role: "rep", active: true, tenantId: 2 } as any);
  const foreignManager = storage.createUser({ name: "Tenant B Manager", email: "manager-b2-academy@example.com", role: "manager", active: true, tenantId: 2 } as any);

  repAUserId = repA.id;
  repBUserId = repB.id;
  foreignRepUserId = foreignRep.id;
  repASession = storage.createSession(repA.id).id;
  repBSession = storage.createSession(repB.id).id;
  leadSession = storage.createSession(lead.id).id;
  managerSession = storage.createSession(manager.id).id;
  foreignManagerSession = storage.createSession(foreignManager.id).id;

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
  if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

function request(path: string, sessionId: string, init: RequestInit = {}) {
  return realFetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-session-id": sessionId, ...init.headers },
  });
}

/** A minimal but real role-play transcript, shaped as the engine emits it. */
function transcript(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    personaId: "busy_homeowner",
    market: "nc-lexington",
    stage: "ended",
    turns: [
      { role: "customer", text: "What is this about?", reason: "opening", index: 0 },
      { role: "rep", text: "Hi, my name is Sam, I'm with the Kinetic fiber crew on your street. Thirty seconds and I'm gone.", intents: ["identity", "reason"], signals: ["acknowledges_time"], violations: [], words: 20, index: 1 },
    ],
    patience: 2, warmth: 1, raised: [], openObjection: null, refusals: 0,
    outcome: "walked_away", signalsHit: ["acknowledges_time"], violations: [],
    ...over,
  };
}

// ── Auth ──────────────────────────────────────────────────────────────────────

describe("authentication", () => {
  it("refuses every academy endpoint without a session", async () => {
    for (const path of [
      "/api/training/academy/progress",
      "/api/training/academy/offers",
      "/api/training/academy/roleplay",
      "/api/training/academy/team",
      "/api/training/academy/offers/catalog",
    ]) {
      const res = await realFetch(`${baseUrl}${path}`);
      expect(res.status, path).toBe(401);
    }
  });
});

// ── Own-scope progress ────────────────────────────────────────────────────────

describe("activity progress", () => {
  it("starts empty and reports the whole path", async () => {
    const res = await request("/api/training/academy/progress", repASession);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.records).toEqual([]);
    expect(body.path.done).toBe(0);
    expect(body.path.total).toBeGreaterThan(0);
    expect(body.path.resume.activity.id).toBe(PATH_STAGES[0].activities[0].id);
  });

  it("rejects an unknown activity id with 400 and writes nothing", async () => {
    const res = await request("/api/training/academy/activities/act-not-real/complete", repASession, {
      method: "POST", body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const count = rawDb.prepare("SELECT COUNT(*) AS n FROM academy_activity_progress WHERE user_id = ?").get(repAUserId) as any;
    expect(count.n).toBe(0);
  });

  it("rejects an out-of-range score with 400", async () => {
    for (const score of [-1, 101, "ninety"]) {
      const res = await request(`/api/training/academy/activities/${REFERENCE_ACTIVITY}/complete`, repASession, {
        method: "POST", body: JSON.stringify({ score }),
      });
      expect(res.status, String(score)).toBe(400);
    }
  });

  it("persists a completion and reflects it in the path rollup", async () => {
    const post = await request(`/api/training/academy/activities/${REFERENCE_ACTIVITY}/complete`, repASession, {
      method: "POST", body: JSON.stringify({}),
    });
    expect(post.status).toBe(200);

    const body = await (await request("/api/training/academy/progress", repASession)).json() as any;
    expect(body.records.map((r: any) => r.activityId)).toContain(REFERENCE_ACTIVITY);
    expect(body.path.done).toBe(1);
    // Resume has moved past it.
    expect(body.path.resume.activity.id).not.toBe(REFERENCE_ACTIVITY);
  });

  it("keeps the BEST score when an activity is repeated, so practising cannot cost a rep", async () => {
    const url = `/api/training/academy/activities/${SCORED_ACTIVITY.id}/complete`;
    await request(url, repASession, { method: "POST", body: JSON.stringify({ score: 90 }) });
    await request(url, repASession, { method: "POST", body: JSON.stringify({ score: 40 }) });

    const body = await (await request("/api/training/academy/progress", repASession)).json() as any;
    const row = body.records.find((r: any) => r.activityId === SCORED_ACTIVITY.id);
    expect(row.score).toBe(90);
  });

  it("never leaks one rep's progress into another's read", async () => {
    const a = await (await request("/api/training/academy/progress", repASession)).json() as any;
    const b = await (await request("/api/training/academy/progress", repBSession)).json() as any;
    expect(a.records.length).toBeGreaterThan(0);
    expect(b.records).toEqual([]);
  });
});

// ── Resume state ──────────────────────────────────────────────────────────────

describe("resume state", () => {
  const activityId = PATH_STAGES[0].activities.find((a) => a.kind === "scenario")!.id;

  it("round-trips mid-activity state so a rep resumes where they stopped", async () => {
    const put = await request(`/api/training/academy/activities/${activityId}/state`, repBSession, {
      method: "PUT", body: JSON.stringify({ state: { answers: { 0: 1, 1: 2 } } }),
    });
    expect(put.status).toBe(200);

    const body = await (await request("/api/training/academy/progress", repBSession)).json() as any;
    const saved = body.states.find((s: any) => s.activityId === activityId);
    expect(saved.state).toEqual({ answers: { 0: 1, 1: 2 } });
  });

  it("keeps saved state private to the rep who saved it", async () => {
    const body = await (await request("/api/training/academy/progress", repASession)).json() as any;
    expect(body.states.find((s: any) => s.activityId === activityId)).toBeUndefined();
  });

  it("rejects state for an unknown activity", async () => {
    const res = await request("/api/training/academy/activities/act-nope/state", repBSession, {
      method: "PUT", body: JSON.stringify({ state: {} }),
    });
    expect(res.status).toBe(400);
  });

  it("refuses an oversized blob with 413 rather than storing it", async () => {
    const res = await request(`/api/training/academy/activities/${activityId}/state`, repBSession, {
      method: "PUT", body: JSON.stringify({ state: { junk: "x".repeat(20_000) } }),
    });
    expect(res.status).toBe(413);
  });

  it("clears state when the activity is completed, so a finished quiz does not resume", async () => {
    await request(`/api/training/academy/activities/${activityId}/complete`, repBSession, {
      method: "POST", body: JSON.stringify({ score: 100 }),
    });
    const body = await (await request("/api/training/academy/progress", repBSession)).json() as any;
    expect(body.states.find((s: any) => s.activityId === activityId)).toBeUndefined();
  });
});

// ── Offers ────────────────────────────────────────────────────────────────────

describe("offers", () => {
  it("serves the seeded catalog to a rep with no configuration", async () => {
    const body = await (await request("/api/training/academy/offers", repASession)).json() as any;
    expect(body.offers.length).toBeGreaterThan(0);
    expect(body.headline).toBeTruthy();
    expect(body.expired).toEqual([]);
  });

  it("refuses catalog reads and writes to a rep", async () => {
    expect((await request("/api/training/academy/offers/catalog", repASession)).status).toBe(403);
    const write = await request("/api/training/academy/offers/catalog", repASession, {
      method: "PUT", body: JSON.stringify({ offers: [] }),
    });
    expect(write.status).toBe(403);
  });

  it("rejects an invalid offer wholesale rather than saving half a catalog", async () => {
    const res = await request("/api/training/academy/offers/catalog", managerSession, {
      method: "PUT",
      body: JSON.stringify({
        offers: [{ id: "Bad Id", provider: "kinetic", market: "*", name: "X", downloadMbps: 0, uploadMbps: 100, priceCents: 100, promoPriceCents: null, promoMonths: null, termMonths: 0, equipmentCents: 0, installCents: 0, unlimitedData: true, effectiveFrom: "2026-01-01", effectiveTo: null, disclosures: [] }],
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.details.join(" ")).toContain("id must be");
  });

  it("stops quoting an offer the day after it expires", async () => {
    const save = await request("/api/training/academy/offers/catalog", managerSession, {
      method: "PUT",
      body: JSON.stringify({
        offers: [{
          id: "summer-promo", provider: "kinetic", market: "*", name: "Summer Promo",
          downloadMbps: 1000, uploadMbps: 1000, priceCents: 6999,
          promoPriceCents: 4999, promoMonths: 12, termMonths: 0,
          equipmentCents: 0, installCents: 0, unlimitedData: true,
          effectiveFrom: "2026-01-01", effectiveTo: "2026-08-10", disclosures: ["Confirmed at the address."],
        }],
        competitors: [],
      }),
    });
    expect(save.status).toBe(200);

    // On the last day it is live.
    const live = await (await request("/api/training/academy/offers?day=2026-08-10", repASession)).json() as any;
    expect(live.offers.map((o: any) => o.id)).toEqual(["summer-promo"]);
    expect(live.expired).toEqual([]);

    // The next day it is gone from everything quotable.
    const after = await (await request("/api/training/academy/offers?day=2026-08-11", repASession)).json() as any;
    expect(after.offers).toEqual([]);
    expect(after.headline).toBeNull();
    expect(after.expired.map((o: any) => o.id)).toEqual(["summer-promo"]);
  });

  it("walls the catalog by tenant", async () => {
    const foreignSession = storage.createSession(foreignRepUserId).id;
    const foreign = await (await request("/api/training/academy/offers?day=2026-08-10", foreignSession)).json() as any;
    // Tenant 2 never saw the tenant 1 save, so it is still on the seed.
    expect(foreign.offers.map((o: any) => o.id)).not.toContain("summer-promo");
    expect(foreign.offers.length).toBeGreaterThan(0);
  });

  it("filters by market", async () => {
    await request("/api/training/academy/offers/catalog", managerSession, {
      method: "PUT",
      body: JSON.stringify({
        offers: [
          { id: "lex-only", provider: "kinetic", market: "nc-lexington", name: "Lexington Gig", downloadMbps: 1000, uploadMbps: 1000, priceCents: 6999, promoPriceCents: null, promoMonths: null, termMonths: 0, equipmentCents: 0, installCents: 0, unlimitedData: true, effectiveFrom: "2026-01-01", effectiveTo: null, disclosures: [] },
          { id: "everywhere", provider: "kinetic", market: "*", name: "Base Gig", downloadMbps: 500, uploadMbps: 500, priceCents: 5499, promoPriceCents: null, promoMonths: null, termMonths: 0, equipmentCents: 0, installCents: 0, unlimitedData: true, effectiveFrom: "2026-01-01", effectiveTo: null, disclosures: [] },
        ],
        competitors: [],
      }),
    });
    const lex = await (await request("/api/training/academy/offers?market=nc-lexington&day=2026-08-10", repASession)).json() as any;
    expect(lex.offers.map((o: any) => o.id)).toEqual(["lex-only", "everywhere"]);

    const other = await (await request("/api/training/academy/offers?market=sc-camden&day=2026-08-10", repASession)).json() as any;
    expect(other.offers.map((o: any) => o.id)).toEqual(["everywhere"]);
  });
});

// ── Role-play ─────────────────────────────────────────────────────────────────

describe("role-play sessions", () => {
  it("rejects a session with no id or an unknown persona", async () => {
    const noId = await request("/api/training/academy/roleplay", repASession, {
      method: "POST", body: JSON.stringify({ session: { personaId: "gamer", turns: [] } }),
    });
    expect(noId.status).toBe(400);

    const badPersona = await request("/api/training/academy/roleplay", repASession, {
      method: "POST", body: JSON.stringify({ session: transcript("rp-1", { personaId: "landlord" }) }),
    });
    expect(badPersona.status).toBe(400);
  });

  it("scores server-side and ignores any score the client sent", async () => {
    const res = await request("/api/training/academy/roleplay", repASession, {
      method: "POST",
      body: JSON.stringify({
        session: transcript("rp-server-scored"),
        // A client claiming a perfect report. The server must not take it.
        score: { overall: 100, dimensions: [], coaching: [], strengths: [], flags: [] },
        mode: "text",
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.score.dimensions).toHaveLength(11);
    // The transcript never closed and never asked a question, so it cannot be
    // a perfect run whatever the client claimed.
    expect(body.score.overall).toBeLessThan(100);
  });

  it("re-derives violations from the text, so a client cannot post itself a clean sheet", async () => {
    // The turn is annotated as harmless: no violations, no signals, an innocent
    // intent. The words say otherwise, and the words are what count.
    const res = await request("/api/training/academy/roleplay", repASession, {
      method: "POST",
      body: JSON.stringify({
        session: transcript("rp-launder", {
          turns: [
            { role: "customer", text: "How much?", reason: "opening", index: 0 },
            {
              role: "rep",
              text: "Come on, this is your last chance, I can do $22 a month and I guarantee your bill goes down.",
              intents: ["price"], signals: [], violations: [], words: 19, index: 1,
            },
          ],
        }),
        mode: "text",
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;

    const kinds = body.transcript.turns[1].violations.map((v: any) => v.kind);
    expect(kinds).toContain("pressure");
    expect(kinds).toContain("unsupported_claim");

    const compliance = body.score.dimensions.find((d: any) => d.dimension === "compliance");
    const professionalism = body.score.dimensions.find((d: any) => d.dimension === "professionalism");
    const accuracy = body.score.dimensions.find((d: any) => d.dimension === "accuracy");
    expect(compliance.score).toBeLessThan(75);
    expect(professionalism.score).toBeLessThan(100);
    expect(accuracy.score).toBeLessThan(100);
    expect(body.score.flags.length).toBeGreaterThan(0);
  });

  it("keeps a state-derived violation the client sent, since the text cannot prove it", async () => {
    const res = await request("/api/training/academy/roleplay", repASession, {
      method: "POST",
      body: JSON.stringify({
        session: transcript("rp-ignored-no", {
          turns: [
            { role: "customer", text: "Not interested.", reason: "objection", index: 0 },
            {
              role: "rep", text: "But hear me out.", intents: [], signals: [], words: 4, index: 1,
              violations: [{ kind: "ignored_no", fragment: "But hear me out.", message: "They said no twice." }],
            },
          ],
        }),
      }),
    });
    const body = await res.json() as any;
    expect(body.transcript.turns[1].violations.map((v: any) => v.kind)).toContain("ignored_no");
  });

  it("is idempotent on a replayed submit, so a retry does not double-count", async () => {
    const payload = JSON.stringify({ session: transcript("rp-replay"), mode: "text" });
    await request("/api/training/academy/roleplay", repASession, { method: "POST", body: payload });
    await request("/api/training/academy/roleplay", repASession, { method: "POST", body: payload });

    const history = await (await request("/api/training/academy/roleplay", repASession)).json() as any;
    expect(history.sessions.filter((s: any) => s.sessionId === "rp-replay")).toHaveLength(1);
  });

  it("keeps a rep's transcripts private to them", async () => {
    const mine = await (await request("/api/training/academy/roleplay/rp-replay", repASession)).json() as any;
    expect(mine.sessionId).toBe("rp-replay");

    // Rep B asking for rep A's session by id gets a 404, not the transcript.
    const theirs = await request("/api/training/academy/roleplay/rp-replay", repBSession);
    expect(theirs.status).toBe(404);
  });

  it("rejects an absurd turn count rather than storing it", async () => {
    const turns = Array.from({ length: 300 }, (_, i) => ({ role: "rep", text: "hi", intents: [], signals: [], violations: [], words: 1, index: i }));
    const res = await request("/api/training/academy/roleplay", repASession, {
      method: "POST", body: JSON.stringify({ session: transcript("rp-huge", { turns }) }),
    });
    expect(res.status).toBe(400);
  });
});

// ── Supervisor surface ────────────────────────────────────────────────────────

describe("the supervisor surface", () => {
  it("is closed to reps", async () => {
    expect((await request("/api/training/academy/team", repASession)).status).toBe(403);
    expect((await request(`/api/training/academy/team/${repBUserId}`, repASession)).status).toBe(403);
  });

  it("is open to a team lead and a manager", async () => {
    expect((await request("/api/training/academy/team", leadSession)).status).toBe(200);
    expect((await request("/api/training/academy/team", managerSession)).status).toBe(200);
  });

  it("returns counts and averages, and no transcripts, in the roster", async () => {
    const body = await (await request("/api/training/academy/team", managerSession)).json() as any;
    expect(body.members.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("transcript");
    expect(serialized).not.toContain("Thirty seconds and I'm gone");
    for (const member of body.members) {
      expect(Object.keys(member).sort()).toEqual([
        "activitiesDone", "lastActivityAt", "name", "role", "rolePlayAverage", "rolePlayCount", "userId",
      ]);
    }
  });

  it("orders the roster by name, never by score", async () => {
    const body = await (await request("/api/training/academy/team", managerSession)).json() as any;
    const names = body.members.map((m: any) => m.name);
    expect([...names].sort((a: string, b: string) => a.localeCompare(b))).toEqual(names);
  });

  it("aggregates team weakness by dimension rather than by person", async () => {
    const body = await (await request("/api/training/academy/team", managerSession)).json() as any;
    for (const gap of body.gaps) {
      expect(Object.keys(gap).sort()).toEqual(["average", "dimension", "label", "repsBelow", "suggestion"]);
    }
  });

  it("never lists another tenant's reps", async () => {
    const body = await (await request("/api/training/academy/team", managerSession)).json() as any;
    expect(body.members.map((m: any) => m.userId)).not.toContain(foreignRepUserId);
  });

  it("404s a cross-tenant rep lookup rather than refusing it", async () => {
    const res = await request(`/api/training/academy/team/${foreignRepUserId}`, managerSession);
    expect(res.status).toBe(404);
  });

  it("shows a manager one of their own reps in full", async () => {
    const body = await (await request(`/api/training/academy/team/${repAUserId}`, managerSession)).json() as any;
    expect(body.userId).toBe(repAUserId);
    expect(body.path.total).toBeGreaterThan(0);
    expect(Array.isArray(body.sessions)).toBe(true);
  });

  it("hides a tenant 1 rep from a tenant 2 manager", async () => {
    const res = await request(`/api/training/academy/team/${repAUserId}`, foreignManagerSession);
    expect(res.status).toBe(404);
  });
});

// ── Assignments ───────────────────────────────────────────────────────────────

describe("assignments", () => {
  it("is closed to reps", async () => {
    const res = await request("/api/training/academy/assignments", repASession, {
      method: "POST", body: JSON.stringify({ userId: repBUserId, targetId: "stage-product", targetKind: "stage" }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects an unknown target", async () => {
    const res = await request("/api/training/academy/assignments", managerSession, {
      method: "POST", body: JSON.stringify({ userId: repAUserId, targetId: "stage-nonsense", targetKind: "stage" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a malformed due date", async () => {
    const res = await request("/api/training/academy/assignments", managerSession, {
      method: "POST",
      body: JSON.stringify({ userId: repAUserId, targetId: "stage-product", targetKind: "stage", dueOn: "next tuesday" }),
    });
    expect(res.status).toBe(400);
  });

  it("refuses to assign across a tenant wall", async () => {
    const res = await request("/api/training/academy/assignments", managerSession, {
      method: "POST", body: JSON.stringify({ userId: foreignRepUserId, targetId: "stage-product", targetKind: "stage" }),
    });
    expect(res.status).toBe(404);
  });

  it("lands on the rep's own payload with the supervisor's note", async () => {
    const created = await request("/api/training/academy/assignments", managerSession, {
      method: "POST",
      body: JSON.stringify({
        userId: repAUserId, targetId: "stage-field", targetKind: "stage",
        note: "Read the never-say list before Monday.", dueOn: "2026-09-01",
      }),
    });
    expect(created.status).toBe(201);

    const body = await (await request("/api/training/academy/progress", repASession)).json() as any;
    const assignment = body.assignments.find((a: any) => a.targetId === "stage-field");
    expect(assignment.note).toBe("Read the never-say list before Monday.");
    expect(assignment.dueOn).toBe("2026-09-01");
    expect(assignment.completedAt).toBeNull();
  });

  it("closes itself when the rep finishes the assigned activity", async () => {
    const activity = PATH_STAGES[1].activities[0];
    const created = await request("/api/training/academy/assignments", managerSession, {
      method: "POST",
      body: JSON.stringify({ userId: repBUserId, targetId: activity.id, targetKind: "activity", note: "Start here." }),
    });
    expect(created.status).toBe(201);

    await request(`/api/training/academy/activities/${activity.id}/complete`, repBSession, {
      method: "POST", body: JSON.stringify({}),
    });

    const body = await (await request("/api/training/academy/progress", repBSession)).json() as any;
    const assignment = body.assignments.find((a: any) => a.targetId === activity.id);
    expect(assignment.completedAt).not.toBeNull();
  });

  it("lets a manager withdraw an assignment, and 404s an id from another tenant", async () => {
    const created = await (await request("/api/training/academy/assignments", managerSession, {
      method: "POST", body: JSON.stringify({ userId: repAUserId, targetId: "stage-field", targetKind: "stage" }),
    })).json() as any;

    expect((await request(`/api/training/academy/assignments/${created.id}`, foreignManagerSession, { method: "DELETE" })).status).toBe(404);
    expect((await request(`/api/training/academy/assignments/${created.id}`, managerSession, { method: "DELETE" })).status).toBe(200);
  });
});
