// Training progress endpoints — the security contract:
//   * progress reads/writes are OWN-scope (identity comes from the session,
//     so rep A can never write rep B's rows),
//   * tenant walls hold (tenant 2 activity never leaks into tenant 1 reads
//     or the tenant 1 summary),
//   * lesson ids are validated against the shared curriculum (400 otherwise),
//   * the team summary is manager-gated.
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TOTAL_TRAINING_LESSONS } from "../../shared/trainingContent";

let server: Server;
let baseUrl: string;
let storage: (typeof import("../../server/storage"))["storage"];
let rawDb: import("better-sqlite3").Database;

let repASession: string;
let repBSession: string;
let managerSession: string;
let foreignRepSession: string;
let repAUserId: number;
let repBUserId: number;
let foreignRepUserId: number;
const realFetch = globalThis.fetch.bind(globalThis);

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-training-progress-"));
  process.env.NODE_ENV = "test";

  const storageModule = await import("../../server/storage");
  storageModule.runMigrations();
  storage = storageModule.storage;
  ({ rawDb } = await import("../../server/db"));
  const { registerRoutes } = await import("../../server/routes");

  rawDb.prepare(
    "INSERT OR IGNORE INTO tenants (id, slug, company_name, owner_name, owner_email, brand_name) VALUES (2, 'tenant-b-training', 'Tenant B', 'Owner B', 'owner-b-training@example.com', 'Tenant B')",
  ).run();

  const repA = storage.createUser({
    name: "Training Rep A", email: "rep-a-training@example.com", role: "rep", active: true, tenantId: 1,
  } as any);
  const repB = storage.createUser({
    name: "Training Rep B", email: "rep-b-training@example.com", role: "rep", active: true, tenantId: 1,
  } as any);
  const manager = storage.createUser({
    name: "Training Manager", email: "manager-training@example.com", role: "manager", active: true, tenantId: 1,
  } as any);
  const foreignRep = storage.createUser({
    name: "Tenant B Training Rep", email: "rep-b2-training@example.com", role: "rep", active: true, tenantId: 2,
  } as any);

  repAUserId = repA.id;
  repBUserId = repB.id;
  foreignRepUserId = foreignRep.id;
  repASession = storage.createSession(repA.id).id;
  repBSession = storage.createSession(repB.id).id;
  managerSession = storage.createSession(manager.id).id;
  foreignRepSession = storage.createSession(foreignRep.id).id;

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
    headers: {
      "content-type": "application/json",
      "x-session-id": sessionId,
      ...init.headers,
    },
  });
}

describe("training progress endpoints", () => {
  it("requires auth", async () => {
    const res = await realFetch(`${baseUrl}/api/training/progress`);
    expect(res.status).toBe(401);
  });

  it("starts empty and reports the curriculum total", async () => {
    const res = await request("/api/training/progress", repASession);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.totalLessons).toBe(TOTAL_TRAINING_LESSONS);
    expect(body.completed).toEqual([]);
  });

  it("rejects unknown lesson ids with 400", async () => {
    const res = await request("/api/training/lessons/m9-fake-lesson/complete", repASession, {
      method: "POST", body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(storage.getTrainingProgress(repAUserId, 1)).toHaveLength(0);
  });

  it("rejects out-of-range quiz scores with 400", async () => {
    // NOTE: NaN is not representable in JSON (it serializes to null, i.e. "no
    // score"), so the invalid-type case is exercised with a non-numeric string.
    for (const quizScore of [-1, 101, "ninety"]) {
      const res = await request("/api/training/lessons/m1-rejection-math/complete", repASession, {
        method: "POST", body: JSON.stringify({ quizScore }),
      });
      expect(res.status, `score ${String(quizScore)}`).toBe(400);
    }
    expect(storage.getTrainingProgress(repAUserId, 1)).toHaveLength(0);
  });

  it("records a completion with a quiz score, own-scope only", async () => {
    const res = await request("/api/training/lessons/m1-rejection-math/complete", repASession, {
      method: "POST", body: JSON.stringify({ quizScore: 67 }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ lessonId: "m1-rejection-math", quizScore: 67 });

    const mine = await (await request("/api/training/progress", repASession)).json() as any;
    expect(mine.completed).toHaveLength(1);
    expect(mine.completed[0]).toMatchObject({ lessonId: "m1-rejection-math", quizScore: 67 });

    // Rep A's write never appears in rep B's progress — identity comes from the
    // session, and there is no request surface to name another user.
    const theirs = await (await request("/api/training/progress", repBSession)).json() as any;
    expect(theirs.completed).toEqual([]);
  });

  it("upserts on re-completion: no duplicate row, score preserved when omitted, replaced when sent", async () => {
    // Re-complete without a score — earned score must survive.
    let res = await request("/api/training/lessons/m1-rejection-math/complete", repASession, {
      method: "POST", body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ lessonId: "m1-rejection-math", quizScore: 67 });

    // Re-complete with a better score — replaced.
    res = await request("/api/training/lessons/m1-rejection-math/complete", repASession, {
      method: "POST", body: JSON.stringify({ quizScore: 100 }),
    });
    expect(res.status).toBe(200);
    const rows = storage.getTrainingProgress(repAUserId, 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ lessonId: "m1-rejection-math", quizScore: 100 });
  });

  it("keeps tenant walls: tenant 2 completions never cross into tenant 1 reads", async () => {
    const res = await request("/api/training/lessons/m2-approach/complete", foreignRepSession, {
      method: "POST", body: JSON.stringify({ quizScore: 50 }),
    });
    expect(res.status).toBe(200);
    expect(storage.getTrainingProgress(foreignRepUserId, 2)).toHaveLength(1);
    expect(storage.getTrainingProgress(foreignRepUserId, 1)).toHaveLength(0);
  });

  it("gates the summary to manager+ (rep gets 403)", async () => {
    const res = await request("/api/training/summary", repASession);
    expect(res.status).toBe(403);
  });

  it("summarizes the manager's tenant only, including zero-progress reps", async () => {
    // Give rep B one completion so the counts differ.
    await request("/api/training/lessons/m1-identity-frames/complete", repBSession, {
      method: "POST", body: JSON.stringify({ quizScore: 33 }),
    });

    const res = await request("/api/training/summary", managerSession);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.totalLessons).toBe(TOTAL_TRAINING_LESSONS);

    const byId = new Map((body.reps as any[]).map((r) => [r.userId, r]));
    expect(byId.get(repAUserId)).toMatchObject({ completedCount: 1, avgQuizScore: 100 });
    expect(byId.get(repBUserId)).toMatchObject({ completedCount: 1, avgQuizScore: 33 });
    // The manager appears with zero progress rather than vanishing.
    const managerRow = (body.reps as any[]).find((r) => r.name === "Training Manager");
    expect(managerRow).toMatchObject({ completedCount: 0, avgQuizScore: null });
    // The foreign tenant's rep never appears.
    expect(byId.has(foreignRepUserId)).toBe(false);
  });
});
