// Manager-written announcements — promos and app updates.
//
// The system-emitted kinds (sale, hot_streak) are built from facts and cannot
// say anything a human did not already do. These two are the only place in the
// feed where a person picks the words AND the text becomes a phone
// notification — so the limits here are about what an OS will render and what a
// floor will tolerate, not about tidiness.
import { describe, expect, it } from "vitest";
import {
  validateAuthoredAnnouncement, buildAuthoredAnnouncement,
  ANNOUNCEMENT_TITLE_MAX, ANNOUNCEMENT_BODY_MAX, visibleTo,
  type AuthoredAnnouncementInput,
} from "../../shared/teamFeed";

const ok = (over: Partial<AuthoredAnnouncementInput> = {}): AuthoredAnnouncementInput => ({
  kind: "promo", title: "Double spiffs tonight", body: "Every close after 5 PM pays twice.", ...over,
});

describe("what a manager may post", () => {
  it("accepts a well-formed promo and update", () => {
    expect(validateAuthoredAnnouncement(ok())).toBeNull();
    expect(validateAuthoredAnnouncement(ok({ kind: "update", amountCents: undefined }))).toBeNull();
  });

  it("refuses a kind the system owns", () => {
    // sale and hot_streak are derived from knock data. Letting a human post one
    // would put an unverifiable claim in the same visual register as a fact.
    expect(validateAuthoredAnnouncement(ok({ kind: "sale" as any }))).toMatch(/promo or update/);
  });

  it("requires both a headline and a body", () => {
    expect(validateAuthoredAnnouncement(ok({ title: "   " }))).toMatch(/headline/i);
    expect(validateAuthoredAnnouncement(ok({ body: "" }))).toMatch(/what it means/i);
  });

  it("caps the headline at what a phone will actually show", () => {
    // Not cosmetic: past ~80 characters the OS truncates mid-word, so the one
    // line a rep reads on a lock screen ends in an ellipsis and says nothing.
    expect(validateAuthoredAnnouncement(ok({ title: "x".repeat(ANNOUNCEMENT_TITLE_MAX) }))).toBeNull();
    expect(validateAuthoredAnnouncement(ok({ title: "x".repeat(ANNOUNCEMENT_TITLE_MAX + 1) })))
      .toMatch(/over 80 characters/);
    expect(validateAuthoredAnnouncement(ok({ body: "x".repeat(ANNOUNCEMENT_BODY_MAX + 1) })))
      .toMatch(/over 240 characters/);
  });

  it("refuses a four-figure promo - it goes to every phone in the org", () => {
    expect(validateAuthoredAnnouncement(ok({ amountCents: 100_000 }))).toBeNull();
    expect(validateAuthoredAnnouncement(ok({ amountCents: 100_001 }))).toMatch(/\$1,000/);
    expect(validateAuthoredAnnouncement(ok({ amountCents: -5 }))).toMatch(/whole number/);
    expect(validateAuthoredAnnouncement(ok({ amountCents: 12.5 as any }))).toMatch(/whole number/);
  });

  it("refuses nothing at all", () => {
    expect(validateAuthoredAnnouncement(null)).toMatch(/Nothing to post/);
    expect(validateAuthoredAnnouncement("promo" as any)).toMatch(/Nothing to post/);
  });
});

describe("what gets built", () => {
  it("trims the text and carries the amount through", () => {
    const a = buildAuthoredAnnouncement(
      ok({ title: "  Push tonight  ", body: "  Stay out till 8.  ", amountCents: 5_000 }),
      "Jalal Khan", 3,
    );
    expect(a.headline).toBe("Push tonight");
    expect(a.body).toBe("Stay out till 8.");
    expect(a.amountCents).toBe(5_000);
    expect(a.kind).toBe("promo");
    expect(a.actorName).toBe("Jalal K.");
  });

  it("falls back to the org name when the author is unknown", () => {
    expect(buildAuthoredAnnouncement(ok(), null, 1).actorName).toBe("A teammate");
  });

  it("is visible to EVERYONE, including the manager who wrote it", () => {
    // The "don't show me my own win" filter compares actorRepId to the viewer.
    // An authored post has no actor rep, so it must not accidentally match a
    // real rep id — otherwise a manager's promo would be hidden from exactly
    // one person, at random, forever.
    const a = buildAuthoredAnnouncement(ok(), "Boss", 1);
    expect(a.actorRepId).toBe(-1);
    for (const viewer of [null, 1, 7, 999]) expect(visibleTo(a, viewer)).toBe(true);
  });

  it("keys on a SEQUENCE, so the same promo can run twice", () => {
    // Two identical "Push tonight" promos on consecutive Fridays are both real
    // posts. Hashing the text would swallow the second one silently — a manager
    // types it, nothing appears, and they type it again.
    const friday1 = buildAuthoredAnnouncement(ok(), "Boss", 4);
    const friday2 = buildAuthoredAnnouncement(ok(), "Boss", 5);
    expect(friday1.dedupeKey).not.toBe(friday2.dedupeKey);
    // But a retried submit at the same sequence collides, as it should.
    expect(buildAuthoredAnnouncement(ok(), "Boss", 4).dedupeKey).toBe(friday1.dedupeKey);
  });

  it("keeps promo and update in separate key spaces", () => {
    expect(buildAuthoredAnnouncement(ok({ kind: "promo" }), "B", 1).dedupeKey)
      .not.toBe(buildAuthoredAnnouncement(ok({ kind: "update" }), "B", 1).dedupeKey);
  });
});
