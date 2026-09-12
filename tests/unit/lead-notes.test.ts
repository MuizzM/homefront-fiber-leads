import { activateWork, purgeWork } from "../../client/src/lib/workAuthority";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  saveLeadNote, flushPendingNotes, mergeNotes, pendingNoteCount, stashNote,
  type NotePoster,
} from "../../client/src/lib/leadNotes";

/**
 * CONTRACT (client/src/lib/leadNotes.ts): a committed note NEVER gets lost.
 * saved → server ack with new version; conflict → 409 surfaces the server copy
 * for a merge; network failure → durable stash, flushed when back online.
 */

const ok = (body: any) => ({ ok: true, status: 200, json: async () => body });
const conflict = (body: any) => ({ ok: false, status: 409, json: async () => body });

// The stash is module-level (in-memory fallback when localStorage is absent in
// the node test env) — drain it so entries never leak between tests.
beforeEach(() => {
  purgeWork(); localStorage.clear();
  activateWork({ userId: 10, tenantId: 1, teamMemberId: 20 }, "notes-test-session");
});

describe("saveLeadNote", () => {
  it("saved: returns the new version and clears any stash for that lead", async () => {
    stashNote(42, "stale", null);
    const post: NotePoster = vi.fn().mockResolvedValue(ok({ updatedAt: "2026-07-08T20:00:00Z" }));
    const r = await saveLeadNote(post, 42, "hello", "2026-07-08T19:00:00Z");
    expect(r).toEqual({ status: "saved", updatedAt: "2026-07-08T20:00:00Z" });
    expect(post).toHaveBeenCalledWith(42, { notes: "hello", baseUpdatedAt: "2026-07-08T19:00:00Z" });
    expect(pendingNoteCount()).toBe(0);
  });

  it("conflict: surfaces the server copy + version instead of overwriting", async () => {
    const post: NotePoster = vi.fn().mockResolvedValue(conflict({ serverNotes: "other device", updatedAt: "v2" }));
    const r = await saveLeadNote(post, 7, "mine", "v1");
    expect(r).toEqual({ status: "conflict", serverNotes: "other device", updatedAt: "v2" });
  });

  it("network failure: stashes durably and reports queued - the note is never dropped", async () => {
    const post: NotePoster = vi.fn().mockRejectedValue(new Error("offline"));
    const r = await saveLeadNote(post, 9, "field note", null);
    expect(r).toEqual({ status: "queued" });
    expect(pendingNoteCount()).toBe(1);
  });
});

describe("flushPendingNotes", () => {
  it("flushes every stashed note once the network returns; failures stay stashed", async () => {
    stashNote(1, "a", null);
    stashNote(2, "b", null);
    const post: NotePoster = vi.fn()
      .mockResolvedValueOnce(ok({ updatedAt: "x" }))
      .mockRejectedValueOnce(new Error("still offline"));
    const flushed = await flushPendingNotes(post);
    expect(flushed).toBe(1);
    expect(pendingNoteCount()).toBe(1); // the failed one survives for the next flush
    // Second attempt drains it.
    const post2: NotePoster = vi.fn().mockResolvedValue(ok({}));
    await flushPendingNotes(post2);
    expect(pendingNoteCount()).toBe(0);
  });

  it("last write per lead wins in the stash (no duplicate sends for one lead)", async () => {
    stashNote(5, "first", null);
    stashNote(5, "second", null);
    const post: NotePoster = vi.fn().mockResolvedValue(ok({}));
    await flushPendingNotes(post);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(5, { notes: "second", baseUpdatedAt: null });
  });
});

describe("mergeNotes - two-device merge", () => {
  it("keeps both sides when they diverge", () => {
    expect(mergeNotes("server text", "local text")).toBe("server text\nlocal text");
  });
  it("dedupes containment instead of duplicating paragraphs", () => {
    expect(mergeNotes("gate code 4411", "gate code 4411 and a dog")).toBe("gate code 4411 and a dog");
    expect(mergeNotes("gate code 4411 and a dog", "gate code 4411")).toBe("gate code 4411 and a dog");
  });
  it("handles empty sides", () => {
    expect(mergeNotes("", "only local")).toBe("only local");
    expect(mergeNotes("only server", "")).toBe("only server");
    expect(mergeNotes("same", "same")).toBe("same");
  });
});
