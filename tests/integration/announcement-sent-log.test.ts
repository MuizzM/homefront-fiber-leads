// ── The sent log, and the sequence bug that shipping it would have caused ────
//
// A manager broadcasting to every phone in the org had no record of what they
// had already sent. The log is the fix; these tests pin the two things about it
// that are easy to get wrong and impossible to notice in review.
//
// THE SEQUENCE BUG is the interesting one. publishAuthored derives its dedupe
// key from a counter, and that counter used to be COUNT(*). Counting is stable
// only while nothing is ever removed — the moment retraction exists, deleting
// the newest post drops the count back, the NEXT post re-derives a key a
// deleted post already used, and the UNIQUE index swallows the insert. The
// manager types an announcement, watches nothing happen, and types it again.
//
// That failure is silent, it only appears after a delete, and it looks like a
// UI bug from the outside. It gets a test.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

let rawDb: any;
let store: any;
const T1 = 1;
const T2 = 2;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-sentlog-"));
  process.env.NODE_ENV = "test";
  const mod = await import("../../server/storage");
  mod.runMigrations();
  rawDb = (await import("../../server/db")).rawDb;
  store = await import("../../server/teamFeedStore");
});

let userSeq = 0;
function makeUser(tenantId: number, active = 1): number {
  const email = `u${++userSeq}@sentlog.test`;
  const info = rawDb.prepare(
    `INSERT INTO users (name, email, role, active, tenant_id, created_at)
     VALUES (?,?,?,?,?,datetime('now'))`,
  ).run(`User ${userSeq}`, email, "rep", active, tenantId);
  return Number(info.lastInsertRowid);
}

function post(tenantId: number, title: string, kind: "promo" | "update" = "promo") {
  return store.publishAuthored(tenantId, null, "Boss", { kind, title, body: "Body text." }, Date.now());
}

describe("the sent log", () => {
  it("carries only what a human sent, newest first", () => {
    const t = 100;
    post(t, "First promo");
    post(t, "Then an update", "update");
    // A sale is a record of something that happened, not something anybody
    // sent — it must not appear in a log of sent messages.
    store.publish(t, {
      kind: "sale", actorRepId: 7, actorName: "Marcus T.",
      headline: "Marcus T. just closed one", body: "3 on the board.",
      dedupeKey: "sale:knock:9001",
    }, Date.now());

    const items = store.sentAuthored(t);
    expect(items.map((i: any) => i.headline)).toEqual(["Then an update", "First promo"]);
    expect(items.some((i: any) => i.kind === "sale")).toBe(false);
  });

  it("counts who READ it, out of the active org", () => {
    const t = 101;
    const a = makeUser(t), b = makeUser(t);
    makeUser(t);           // never opened the feed
    makeUser(t, 0);        // deactivated — not part of the audience
    makeUser(T2);          // another org entirely

    const sent = post(t, "Double spiffs tonight");
    store.markRead(a, sent.id, Date.now());
    store.markRead(b, sent.id, Date.now());

    const [row] = store.sentAuthored(t);
    expect(row.readCount).toBe(2);
    expect(row.audience).toBe(3);
  });

  it("counts a reader who cleared PAST this post, not just exactly at it", () => {
    const t = 102;
    const u = makeUser(t);
    const first = post(t, "Earlier");
    const second = post(t, "Later");
    // Opening the bell clears everything up to the newest id, which is how a
    // reader ends up with last_read_id above an older announcement's id.
    store.markRead(u, second.id, Date.now());

    const items = store.sentAuthored(t);
    expect(items.find((i: any) => i.id === first.id).readCount).toBe(1);
    expect(items.find((i: any) => i.id === second.id).readCount).toBe(1);
  });
});

describe("retracting a post", () => {
  it("removes it from the feed and the log", () => {
    const t = 200;
    const sent = post(t, "Sent in error");
    expect(store.deleteAuthored(t, sent.id)).toBe(true);
    expect(store.sentAuthored(t)).toHaveLength(0);
    expect(store.feedFor(t, null).items.some((i: any) => i.id === sent.id)).toBe(false);
  });

  it("will not retract a sale", () => {
    const t = 201;
    const sale = store.publish(t, {
      kind: "sale", actorRepId: 7, actorName: "Marcus T.",
      headline: "Marcus T. just closed one", body: "3 on the board.",
      dedupeKey: "sale:knock:9002",
    }, Date.now());
    expect(store.deleteAuthored(t, sale.id)).toBe(false);
    expect(store.feedFor(t, null).items.some((i: any) => i.id === sale.id)).toBe(true);
  });

  it("will not reach across tenants", () => {
    const sent = post(300, "Ours");
    expect(store.deleteAuthored(301, sent.id)).toBe(false);
    expect(store.sentAuthored(300)).toHaveLength(1);
  });
});

describe("posting after a retraction", () => {
  // THE REGRESSION. Retracting a post from the MIDDLE of the log is what breaks
  // a counting sequence: the count drops by one, the next post re-derives the
  // key that the still-live NEWEST post is holding, and the UNIQUE index eats
  // the insert. Retracting the newest post hides this — it frees its own key on
  // the way out — so the ordering here is the whole point of the test.
  it("still publishes after a post is retracted from the middle of the log", () => {
    const t = 400;
    post(t, "One");
    const two = post(t, "Two");
    post(t, "Three");
    expect(store.deleteAuthored(t, two.id)).toBe(true);

    const four = post(t, "Four");
    expect(four).not.toBeNull();
    expect(four.headline).toBe("Four");
    expect(store.sentAuthored(t).map((i: any) => i.headline)).toEqual(["Four", "Three", "One"]);
  });

  it("still publishes after the newest post is retracted", () => {
    const t = 401;
    post(t, "One");
    const two = post(t, "Two");
    expect(store.deleteAuthored(t, two.id)).toBe(true);

    const three = post(t, "Three");
    expect(three).not.toBeNull();
    expect(store.sentAuthored(t).map((i: any) => i.headline)).toEqual(["Three", "One"]);
  });

  it("survives the whole log being cleared out", () => {
    const t = 402;
    const a = post(t, "A"), b = post(t, "B");
    store.deleteAuthored(t, a.id);
    store.deleteAuthored(t, b.id);

    const c = post(t, "C");
    expect(c).not.toBeNull();
    expect(store.sentAuthored(t).map((i: any) => i.headline)).toEqual(["C"]);
  });

  // Mixed kinds share one sequence, so retracting an update must not strand the
  // next promo either.
  it("still publishes when the retracted post was a different kind", () => {
    const t = 403;
    post(t, "Heads up", "update");
    const mid = post(t, "Bonus tonight");
    post(t, "One more thing", "update");
    expect(store.deleteAuthored(t, mid.id)).toBe(true);

    expect(post(t, "Final promo")).not.toBeNull();
    expect(store.sentAuthored(t)).toHaveLength(3);
  });

  it("keeps two identical posts distinct, which is why seq exists at all", () => {
    const t = 404;
    const friday1 = post(t, "Push tonight");
    const friday2 = post(t, "Push tonight");
    expect(friday2).not.toBeNull();
    expect(friday2.id).not.toBe(friday1.id);
    expect(store.sentAuthored(t)).toHaveLength(2);
  });
});
