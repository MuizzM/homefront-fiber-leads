// The text the customer reads on their lock screen.
//
// It's the rep writing from their own phone ten minutes after the doorstep, so
// it should sound like that rep. It also has to survive SMS encoding: ONE
// character outside the GSM-7 alphabet drops the whole message from 160 chars
// per segment to 70. "8:00–10:00 AM" with an en dash looks identical to a
// hyphen and silently triples the segment count of every text the company sends.
import { describe, expect, it } from "vitest";
import { buildAppointmentMessage, countSegments, toGsm7Safe } from "../../shared/smsMessage";

const VARS = {
  customerFirstName: "Dana", repName: "Rae", companyName: "Home Front",
  dateLabel: "Tue, Aug 4", timeWindowLabel: "8:00-10:00 AM",
};
const body = (v = VARS) => (buildAppointmentMessage(v) as any).body as string;

describe("one invisible character must not halve the message capacity", () => {
  it("transliterates the en dash that hides in a time window", () => {
    // The trap: "8:00–10:00" and "8:00-10:00" are indistinguishable on screen.
    expect(toGsm7Safe("8:00–10:00 AM")).toBe("8:00-10:00 AM");
    expect(countSegments(toGsm7Safe("8:00–10:00 AM")).encoding).toBe("GSM-7");
  });

  it("catches an en dash arriving through a caller's own label", () => {
    // The window label is passed IN. A caller formatting it with an en dash
    // would otherwise poison every message without touching this file.
    const out = body({ ...VARS, timeWindowLabel: "8:00–10:00 AM" });
    expect(out).toContain("8:00-10:00 AM");
    expect(countSegments(out).encoding).toBe("GSM-7");
  });

  it("transliterates curly quotes, em dashes and ellipses", () => {
    expect(toGsm7Safe("we’re — “set”…")).toBe("we're - \"set\"...");
    expect(countSegments(toGsm7Safe("we’re — “set”…")).encoding).toBe("GSM-7");
  });

  it("strips invisible characters that cost a segment and show nothing", () => {
    expect(toGsm7Safe("a b")).toBe("a b");   // non-breaking space
    expect(toGsm7Safe("a­b")).toBe("ab");    // soft hyphen
  });

  it("does NOT mangle a customer's name to save a segment", () => {
    // Zoë stays Zoë. Reporting the cost is right; corrupting a person's name is
    // not, and an emoji a rep deliberately added should survive too.
    expect(toGsm7Safe("Zoë")).toBe("Zoë");
    expect(toGsm7Safe("nice 👍")).toBe("nice 👍");
  });
});

describe("segment counting reflects what the carrier actually bills", () => {
  it("uses 160 for a single GSM-7 segment and 153 once concatenated", () => {
    expect(countSegments("a".repeat(160))).toMatchObject({ encoding: "GSM-7", segments: 1 });
    expect(countSegments("a".repeat(161))).toMatchObject({ encoding: "GSM-7", segments: 2 });
    expect(countSegments("a".repeat(306))).toMatchObject({ segments: 2 });
    expect(countSegments("a".repeat(307))).toMatchObject({ segments: 3 });
  });

  it("drops to 70 per segment the moment one character forces UCS-2", () => {
    const plain = countSegments("a".repeat(100));
    const withEmoji = countSegments("a".repeat(100) + "🎉");
    expect(plain.segments).toBe(1);
    expect(withEmoji.encoding).toBe("UCS-2");
    expect(withEmoji.segments).toBeGreaterThan(plain.segments);
  });

  it("counts an astral emoji as the two UTF-16 units it occupies", () => {
    expect(countSegments("🎉").units).toBe(2);
  });

  it("names the characters responsible so they can be removed", () => {
    expect(countSegments("hi – there 🎉").offenders).toEqual(expect.arrayContaining(["–", "🎉"]));
  });

  it("charges two septets for GSM-7 extension characters", () => {
    // { } [ ] ~ ^ \ | € are legal but cost double.
    expect(countSegments("€").units).toBe(2);
  });

  it("treats an empty message as one segment, never zero", () => {
    expect(countSegments("").segments).toBe(1);
  });
});

describe("the referral offer", () => {
  it("asks for referrals and names the reward", () => {
    const out = body({ ...VARS, referralRewardLabel: "$100 gift card" });
    expect(out).toMatch(/anyone who wants fiber/i);
    expect(out).toContain("$100 gift card");
  });

  it("states the condition, so nobody expects the card on the spot", () => {
    // This text is the only thing the customer will have in writing, and the
    // complaint about a misread offer lands on the rep who sent it.
    expect(body({ ...VARS, referralRewardLabel: "$100 gift card" }))
      .toMatch(/once they'?re installed/i);
  });

  it("leaves the ask out entirely when no reward is configured", () => {
    // A tenant not running the offer must never send a text promising one.
    const out = body(VARS);
    expect(out).not.toMatch(/gift card|refer/i);
    expect(out).toContain("Any questions, just reply here.");
  });

  it("ignores a blank reward rather than promising an empty prize", () => {
    expect(body({ ...VARS, referralRewardLabel: "   " })).not.toMatch(/you get a\s+once/i);
  });

  it("stays GSM-7 with the offer included", () => {
    expect(countSegments(body({ ...VARS, referralRewardLabel: "$100 gift card" })).encoding).toBe("GSM-7");
  });
});

describe("it reads like the rep, not like a billing system", () => {
  it("opens casually and by first name", () => {
    expect(body()).toMatch(/^Hey Dana, it's Rae from Home Front/);
  });

  it("uses contractions", () => {
    expect(body()).toMatch(/it's|You're|they're/);
  });

  it("names the rep before the date, since an unknown number reads as spam", () => {
    expect(body().indexOf("Rae")).toBeLessThan(body().indexOf("Aug 4"));
  });

  it("states the window, never a single time", () => {
    // An installer arriving inside a window is not late. A customer told
    // "8:00 AM" believes otherwise at 8:05, and that call lands on the rep.
    expect(body()).toContain("between 8:00-10:00 AM");
  });

  it("refuses to half-render, naming what is missing", () => {
    const r = buildAppointmentMessage({ ...VARS, repName: "", dateLabel: " " });
    expect(r.ok).toBe(false);
    expect((r as any).missing).toEqual(expect.arrayContaining(["repName", "dateLabel"]));
  });

  it("reports the segment cost so the UI can warn before sending", () => {
    const r = buildAppointmentMessage({ ...VARS, referralRewardLabel: "$100 gift card" });
    expect((r as any).segments.segments).toBeGreaterThanOrEqual(1);
    expect((r as any).segments.encoding).toBe("GSM-7");
  });
});
