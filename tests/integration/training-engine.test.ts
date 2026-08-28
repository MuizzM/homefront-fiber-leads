// CE-1 drill engine endpoints — the server contract:
//   * deck: due cards (due_at <= now) + new cards seeded at rung 1 from
//     completed lessons (training_progress is the seed signal), capped
//     30 due + 10 new with uncapped counts,
//   * reviews: validate-all-then-write batch; ladder computed SERVER-SIDE
//     from the stored rung with the CLIENT reviewedAt as the base (offline
//     sync must not shift dues); replay of the same batch is a no-op,
//   * coach-summary: due/new counts, consecutive-day streak from the
//     append-only review log, ladder coverage,
//   * own-scope + tenant-scoped everywhere; invalid card/grade → named 400s.
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildDrillDeck, type DrillCard } from "../../shared/trainingCards";
import { LADDER_DAYS, AGAIN_DELAY_MS } from "../../shared/trainingSchedule";

const DAY_MS = 86_400_000;
const DECK = buildDrillDeck();
const cardsFor = (lessonId: string): DrillCard[] => DECK.filter((c) => c.lessonId === lessonId);

let server: Server;
let baseUrl: string;
let rawDb: import("better-sqlite3").Database;

let repASession: string;
let repBSession: string;
let foreignRepSession: string;
let repAUserId: number;
let foreignRepUserId: number;
const realFetch = globalThis.fetch.bind(globalThis);

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-training-engine-"));
  process.env.NODE_ENV = "test";

  const storageModule = await import("../../server/storage");
  storageModule.runMigrations();
  const storage = storageModule.storage;
  ({ rawDb } = await import("../../server/db"));
  const { registerRoutes } = await import("../../server/routes");

  rawDb.prepare(
    "INSERT OR IGNORE INTO tenants (id, slug, company_name, owner_name, owner_email, brand_name) VALUES (2, 'tenant-b-engine', 'Tenant B', 'Owner B', 'owner-b-engine@example.com', 'Tenant B')",
  ).run();

  const repA = storage.createUser({
    name: "Engine Rep A", email: "rep-a-engine@example.com", role: "rep", active: true, tenantId: 1,
  } as any);
  const repB = storage.createUser({
    name: "Engine Rep B", email: "rep-b-engine@example.com", role: "rep", active: true, tenantId: 1,
  } as any);
  const foreignRep = storage.createUser({
    name: "Tenant B Engine Rep", email: "rep-foreign-engine@example.com", role: "rep", active: true, tenantId: 2,
  } as any);

  repAUserId = repA.id;
  foreignRepUserId = foreignRep.id;
  repASession = storage.createSession(repA.id).id;
  repBSession = storage.createSession(repB.id).id;
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

const postReviews = (sessionId: string, reviews: unknown) =>
  request("/api/training/reviews", sessionId, { method: "POST", body: JSON.stringify({ reviews }) });

const completeLesson = (sessionId: string, lessonId: string) =>
  request(`/api/training/lessons/${lessonId}/complete`, sessionId, { method: "POST", body: JSON.stringify({}) });

const isoDaysFromNow = (days: number, from = Date.now()) => new Date(from + days * DAY_MS).toISOString();

function logRowCount(): number {
  return (rawDb.prepare("SELECT COUNT(*) AS n FROM training_review_log").get() as { n: number }).n;
}

describe("training engine endpoints", () => {
  it("requires auth on all three routes", async () => {
    expect((await realFetch(`${baseUrl}/api/training/deck`)).status).toBe(401);
    expect((await realFetch(`${baseUrl}/api/training/reviews`, { method: "POST" })).status).toBe(401);
    expect((await realFetch(`${baseUrl}/api/training/coach-summary`)).status).toBe(401);
  });

  it("starts with an empty deck and zeroed summary", async () => {
    const deck = await (await request("/api/training/deck", repASession)).json() as any;
    expect(deck.due).toEqual([]);
    expect(deck.new).toEqual([]);
    expect(deck.counts).toEqual({ due: 0, new: 0, dueReturned: 0, newReturned: 0 });

    const summary = await (await request("/api/training/coach-summary", repASession)).json() as any;
    expect(summary).toEqual({
      dueCount: 0,
      newCount: 0,
      streakDays: 0,
      ladderCoverage: { "0": 0, "1": 0, "2": 0, "3": 0, "4": 0 },
      totalCards: DECK.length,
      cardsReviewedTotal: 0,
    });
  });

  it("seeds new cards at rung 1 when the source lesson is completed", async () => {
    const lessonCards = cardsFor("m1-rejection-math");
    expect(lessonCards.length).toBeGreaterThan(0);
    await completeLesson(repASession, "m1-rejection-math");

    const deck = await (await request("/api/training/deck", repASession)).json() as any;
    expect(deck.due).toEqual([]);
    expect(deck.counts.new).toBe(lessonCards.length);
    expect(deck.new).toHaveLength(lessonCards.length);
    expect(deck.new.map((e: any) => e.card.id).sort()).toEqual(lessonCards.map((c) => c.id).sort());
    for (const entry of deck.new) expect(entry.rung).toBe(1);

    const summary = await (await request("/api/training/coach-summary", repASession)).json() as any;
    expect(summary.newCount).toBe(lessonCards.length);
    expect(summary.dueCount).toBe(0);
  });

  it("moves cards along the ladder per grade, computed server-side from the stored rung", async () => {
    const [again, hard, good, easy] = cardsFor("m1-rejection-math");
    // Captured once so the exact due math below is deterministic; using "now"
    // (not a fixed calendar date) keeps these reviews on today's streak day.
    const base = new Date();
    const res = await postReviews(repASession, [
      { cardId: again.id, grade: "again", reviewedAt: base.toISOString() },
      { cardId: hard.id, grade: "hard", reviewedAt: base.toISOString() },
      { cardId: good.id, grade: "good", reviewedAt: base.toISOString() },
      { cardId: easy.id, grade: "easy", reviewedAt: base.toISOString(), rungBefore: 99 }, // never trusted
    ]);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.applied).toBe(4);
    expect(body.duplicates).toBe(0);

    const byCard = new Map(body.results.map((r: any) => [r.cardId, r]));
    // All four were seeded new cards → server-computed rungBefore 1.
    expect(byCard.get(again.id)).toMatchObject({
      rungBefore: 1, rungAfter: 0,
      dueAt: new Date(base.getTime() + AGAIN_DELAY_MS).toISOString(),
    });
    expect(byCard.get(hard.id)).toMatchObject({
      rungBefore: 1, rungAfter: 1,
      dueAt: new Date(base.getTime() + LADDER_DAYS[1] * DAY_MS).toISOString(),
    });
    expect(byCard.get(good.id)).toMatchObject({
      rungBefore: 1, rungAfter: 2,
      dueAt: new Date(base.getTime() + LADDER_DAYS[2] * DAY_MS).toISOString(),
    });
    expect(byCard.get(easy.id)).toMatchObject({
      rungBefore: 1, rungAfter: 3,
      dueAt: new Date(base.getTime() + LADDER_DAYS[3] * DAY_MS).toISOString(),
    });

    // Second pass on the easy card: stored rung 3 + easy → clamped at rung 4.
    const res2 = await postReviews(repASession, [
      { cardId: easy.id, grade: "easy", reviewedAt: new Date(base.getTime() + 60_000).toISOString() },
    ]);
    const body2 = await res2.json() as any;
    expect(body2.results[0]).toMatchObject({
      rungBefore: 3, rungAfter: 4,
      dueAt: new Date(base.getTime() + 60_000 + LADDER_DAYS[4] * DAY_MS).toISOString(),
    });

    const summary = await (await request("/api/training/coach-summary", repASession)).json() as any;
    expect(summary.cardsReviewedTotal).toBe(4);
    expect(summary.ladderCoverage).toMatchObject({ "0": 1, "1": 1, "2": 1, "4": 1 });
  });

  it("honors the client reviewedAt as the ladder base (offline sync must not shift dues)", async () => {
    const card = cardsFor("m1-rejection-math")[4];
    const offline = new Date(Date.now() - 4 * DAY_MS); // taken offline 4 days ago
    const res = await postReviews(repASession, [{ cardId: card.id, grade: "good", reviewedAt: offline.toISOString() }]);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    // good from rung 1 → rung 2, due 3 days after the REVIEW, not after the sync.
    const expectedDue = new Date(offline.getTime() + LADDER_DAYS[2] * DAY_MS).toISOString();
    expect(body.results[0].dueAt).toBe(expectedDue);
    expect(new Date(expectedDue).getTime()).toBeLessThan(Date.now());

    // …so the card is already due again and lands in the due bucket.
    const deck = await (await request("/api/training/deck", repASession)).json() as any;
    expect(deck.counts.due).toBe(1);
    expect(deck.due[0].card.id).toBe(card.id);
    expect(deck.due[0]).toMatchObject({ rung: 2, dueAt: expectedDue, lastGrade: "good", reps: 1, lapses: 0 });
  });

  it("replays an identical batch as a no-op: same state, no double log", async () => {
    const lessonCards = cardsFor("m1-rejection-math");
    const batch = [
      { cardId: lessonCards[5].id, grade: "hard", reviewedAt: new Date(Date.now() - 60_000).toISOString() },
      { cardId: lessonCards[0].id, grade: "good", reviewedAt: new Date(Date.now() - 30_000).toISOString() },
    ];
    const before = logRowCount();

    const first = await (await postReviews(repASession, batch)).json() as any;
    expect(first.applied).toBe(2);
    expect(first.duplicates).toBe(0);
    expect(logRowCount()).toBe(before + 2);

    const replay = await (await postReviews(repASession, batch)).json() as any;
    expect(replay.applied).toBe(0);
    expect(replay.duplicates).toBe(2);
    expect(replay.results.every((r: any) => r.duplicate)).toBe(true);
    expect(logRowCount()).toBe(before + 2);

    // State rows unchanged by the replay: the ladder is not re-stepped.
    // lessonCards[5] got its first ever review in this batch → reps 1, rung 1
    // (hard from seeded rung 1). lessonCards[0] was already reviewed once in
    // the ladder test → reps 2, rung 1 (good from rung 0).
    const stateOf = (cardId: string) => rawDb.prepare(
      "SELECT rung, reps, last_grade AS lastGrade FROM training_card_state WHERE tenant_id = 1 AND user_id = ? AND card_id = ?",
    ).get(repAUserId, cardId) as any;
    expect(stateOf(lessonCards[5].id)).toMatchObject({ rung: 1, reps: 1, lastGrade: "hard" });
    expect(stateOf(lessonCards[0].id)).toMatchObject({ rung: 1, reps: 2, lastGrade: "good" });
  });

  it("buckets due vs new and caps each side with uncapped counts", async () => {
    // New-side cap: two completed lessons → 11 new cards > NEW_CAP of 10.
    const seededLessons = ["m1-rejection-math", "m1-identity-frames"];
    for (const lessonId of seededLessons) await completeLesson(repBSession, lessonId);
    const seededCount = seededLessons.reduce((n, l) => n + cardsFor(l).length, 0);
    expect(seededCount).toBeGreaterThan(10);

    let deck = await (await request("/api/training/deck", repBSession)).json() as any;
    expect(deck.new).toHaveLength(10);
    expect(deck.counts).toMatchObject({ new: seededCount, newReturned: 10, due: 0 });

    // Due-side cap: complete enough further lessons to exceed 30 due cards,
    // then grade 31 of them "again" with a past reviewedAt (due +10min from
    // the review → all due now).
    const seen = new Set(seededLessons);
    const extra: string[] = [];
    let available = seededCount;
    for (const card of DECK) {
      if (available >= 32) break;
      if (!seen.has(card.lessonId)) {
        seen.add(card.lessonId);
        extra.push(card.lessonId);
        available += cardsFor(card.lessonId).length;
      }
    }
    for (const lessonId of extra) await completeLesson(repBSession, lessonId);

    const dueBatch = DECK.filter((c) => seen.has(c.lessonId)).slice(0, 31)
      .map((c) => ({ cardId: c.id, grade: "again", reviewedAt: isoDaysFromNow(-1) }));
    const res = await postReviews(repBSession, dueBatch);
    expect((await res.json() as any).applied).toBe(31);

    deck = await (await request("/api/training/deck", repBSession)).json() as any;
    expect(deck.due).toHaveLength(30);
    expect(deck.counts).toMatchObject({ due: 31, dueReturned: 30, new: available - 31 });
    // Oldest dues first.
    const dues = deck.due.map((e: any) => e.dueAt);
    expect([...dues].sort()).toEqual(dues);
    // "again" reviews lapse and sit at rung 0.
    expect(deck.due[0]).toMatchObject({ rung: 0, lastGrade: "again", lapses: 1, reps: 1 });

    const summary = await (await request("/api/training/coach-summary", repBSession)).json() as any;
    expect(summary.dueCount).toBe(31);
    expect(summary.newCount).toBe(available - 31);
    expect(summary.cardsReviewedTotal).toBe(31);
    expect(summary.ladderCoverage["0"]).toBe(31);
  });

  it("computes the streak from consecutive review-log days; a gap resets it", async () => {
    // Rep A already reviewed today (idempotency batch). Add the two days
    // before → 3 consecutive days. Fresh cards keep the log appends real.
    await completeLesson(repASession, "m2-approach");
    const [c1, c2] = cardsFor("m2-approach");
    await postReviews(repASession, [
      { cardId: c1.id, grade: "good", reviewedAt: isoDaysFromNow(-1) },
      { cardId: c2.id, grade: "good", reviewedAt: isoDaysFromNow(-2) },
    ]);
    let summary = await (await request("/api/training/coach-summary", repASession)).json() as any;
    // today (idempotency batch) + yesterday + the day before. The offline
    // fidelity review 4 days ago does NOT extend the streak — day -3 is a gap.
    expect(summary.streakDays).toBe(3);

    // A rep whose newest review is older than yesterday has no live streak.
    // "easy" → due 7 days out, so this old review never lands in the due bucket.
    const foreign = cardsFor("m1-rejection-math")[0];
    await completeLesson(foreignRepSession, "m1-rejection-math");
    await postReviews(foreignRepSession, [
      { cardId: foreign.id, grade: "easy", reviewedAt: isoDaysFromNow(-3) },
    ]);
    summary = await (await request("/api/training/coach-summary", foreignRepSession)).json() as any;
    expect(summary.streakDays).toBe(0);

    // Rep B reviewed only yesterday (the due-cap batch) → streak alive at 1.
    summary = await (await request("/api/training/coach-summary", repBSession)).json() as any;
    expect(summary.streakDays).toBe(1);
  });

  it("keeps tenant walls: tenant 2 activity never crosses into tenant 1 reads", async () => {
    const repADeck = await (await request("/api/training/deck", repASession)).json() as any;
    const foreignDeck = await (await request("/api/training/deck", foreignRepSession)).json() as any;

    // The foreign rep's seeded cards + review exist only in tenant 2.
    expect(foreignDeck.counts.new).toBe(cardsFor("m1-rejection-math").length - 1);
    expect(foreignDeck.counts.due).toBe(0); // their one review is not due yet

    const foreignLog = rawDb.prepare(
      "SELECT COUNT(*) AS n FROM training_review_log WHERE tenant_id = 2 AND user_id = ?",
    ).get(foreignRepUserId) as { n: number };
    const tenant1Log = rawDb.prepare(
      "SELECT COUNT(*) AS n FROM training_review_log WHERE tenant_id = 1",
    ).get() as { n: number };
    expect(foreignLog.n).toBe(1);
    expect(tenant1Log.n).toBeGreaterThan(1);
    // The foreign rep's state row is written under tenant 2, never tenant 1.
    const foreignState = rawDb.prepare(
      "SELECT COUNT(*) AS n FROM training_card_state WHERE tenant_id = 1 AND user_id = ?",
    ).get(foreignRepUserId) as { n: number };
    expect(foreignState.n).toBe(0);

    // Rep A's deck is untouched by the foreign rep's identical lesson.
    expect(repADeck.counts).toEqual((await (await request("/api/training/deck", repASession)).json() as any).counts);
  });

  it("rejects invalid input with named 400s and writes nothing", async () => {
    const good = { cardId: cardsFor("m2-approach")[2].id, grade: "good", reviewedAt: new Date().toISOString() };
    const before = logRowCount();

    const cases: Array<[unknown, string]> = [
      [[], "INVALID_REVIEWS"],
      [[{ ...good, cardId: "not-a-card" }], "INVALID_CARD_ID"],
      [[{ ...good, cardId: "card:m9-fake-lesson:takeaway:0" }], "UNKNOWN_CARD_ID"],
      [[{ ...good, grade: "meh" }], "INVALID_GRADE"],
      [[{ ...good, reviewedAt: "yesterday-ish" }], "INVALID_REVIEWED_AT"],
      // A valid review followed by an invalid one: the whole batch fails.
      [[good, { ...good, cardId: "card:xx:takeaway:0" }], "UNKNOWN_CARD_ID"],
    ];
    for (const [reviews, code] of cases) {
      const res = await postReviews(repASession, reviews);
      expect(res.status, code).toBe(400);
      expect((await res.json() as any).code).toBe(code);
    }
    expect(logRowCount()).toBe(before);
  });
});
