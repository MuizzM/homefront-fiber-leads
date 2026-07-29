// The rep's own phone sends the text.
//
// One tap opens their native Messages app with the customer's number and the
// whole message already written. Nothing is sent by the server, so there is no
// provider, no credentials, and no campaign registration — and the customer
// hears from the person who was just at their door, which is the number they
// will actually reply to.
//
// Two things in here are worth more than the rest of the file:
//
//   1. THE SEPARATOR. iOS wants sms:NUMBER&body=, Android wants ?body=. Get it
//      wrong and the composer opens with an EMPTY message on one platform only
//      — which a rep may well send anyway, to a customer, with nothing in it.
//   2. REFUSING TO RENDER. A half-filled template ("Hi , your install…") is
//      worse than a button that will not arm, because the rep is holding a
//      phone on a doorstep and will not always proofread.
import { describe, expect, it } from "vitest";
import {
  buildAppointmentMessage,
  buildSmsLink,
  detectSmsPlatform,
  normalizePhoneForSms,
} from "../../shared/smsDeepLink";

const VARS = {
  customerFirstName: "Dana",
  repName: "Rae",
  companyName: "Home Front",
  dateLabel: "Tue, Aug 4",
  timeWindowLabel: "8:00-10:00 AM",
};

describe("the separator differs per platform, and silently on one of them", () => {
  it("uses & on iOS", () => {
    const r = buildSmsLink({ phone: "+15551234567", body: "hello", platform: "ios" });
    expect(r.ok && r.href).toBe("sms:+15551234567&body=hello");
  });

  it("uses ? on Android", () => {
    const r = buildSmsLink({ phone: "+15551234567", body: "hello", platform: "android" });
    expect(r.ok && r.href).toBe("sms:+15551234567?body=hello");
  });

  it("never emits the other platform's separator", () => {
    // The actual regression: a shared "?" looks right, matches RFC 5724, works
    // in every Android test — and drops the body on every iPhone.
    const ios = buildSmsLink({ phone: "+15551234567", body: "x", platform: "ios" });
    const android = buildSmsLink({ phone: "+15551234567", body: "x", platform: "android" });
    expect(ios.ok && ios.href).not.toContain("?body=");
    expect(android.ok && android.href).not.toContain("&body=");
  });

  it("falls back to the RFC form on an unknown platform", () => {
    // Desktop and anything unrecognised get ?body= — the spec-compliant one.
    const r = buildSmsLink({ phone: "+15551234567", body: "x", platform: "other" });
    expect(r.ok && r.href).toContain("?body=");
  });
});

describe("the body survives the URL intact", () => {
  it("encodes a literal ampersand, which would otherwise truncate the message", () => {
    // On iOS the separator IS &, so an unencoded & in the body ends the text
    // right there — the customer gets half a sentence.
    const r = buildSmsLink({ phone: "5551234567", body: "Cable & fiber", platform: "ios" });
    expect(r.ok && r.href).toContain("Cable%20%26%20fiber");
  });

  it("encodes newlines rather than breaking the href", () => {
    const r = buildSmsLink({ phone: "5551234567", body: "one\ntwo", platform: "android" });
    expect(r.ok && r.href).toContain("%0A");
  });

  it("round-trips the exact message a rep would send", () => {
    const built = buildAppointmentMessage(VARS);
    expect(built.ok).toBe(true);
    const link = buildSmsLink({ phone: "+15551234567", body: (built as any).body, platform: "ios" });
    const decoded = decodeURIComponent((link as any).href.split("body=")[1]);
    expect(decoded).toBe((built as any).body);
  });
});

describe("the number a rep typed on a doorstep", () => {
  it("strips the punctuation humans use", () => {
    for (const raw of ["(555) 123-4567", "555.123.4567", " 555 123 4567 "]) {
      expect(normalizePhoneForSms(raw)).toBe("5551234567");
    }
  });

  it("keeps a leading + for E.164", () => {
    expect(normalizePhoneForSms("+1 (555) 123-4567")).toBe("+15551234567");
  });

  it("refuses something too short to be a phone number", () => {
    // Better a disabled button than a composer opening to "123".
    expect(normalizePhoneForSms("123")).toBeNull();
    expect(normalizePhoneForSms("")).toBeNull();
  });

  it("refuses something longer than E.164 allows", () => {
    expect(normalizePhoneForSms("1234567890123456")).toBeNull();
  });

  it("reports WHY the link could not be built", () => {
    // A bare empty string would render a button that looks armed and does
    // nothing. The caller needs to be able to say what is wrong.
    expect(buildSmsLink({ phone: "12", body: "x", platform: "ios" }))
      .toEqual({ ok: false, reason: "bad-phone" });
    expect(buildSmsLink({ phone: "5551234567", body: "   ", platform: "ios" }))
      .toEqual({ ok: false, reason: "empty-body" });
  });
});

describe("the message refuses to half-render", () => {
  it("names every missing variable rather than emitting a gap", () => {
    const r = buildAppointmentMessage({ ...VARS, customerFirstName: "", dateLabel: "  " });
    expect(r.ok).toBe(false);
    expect((r as any).missing).toEqual(expect.arrayContaining(["customerFirstName", "dateLabel"]));
  });

  it("never emits an empty slot when it does render", () => {
    const r = buildAppointmentMessage(VARS);
    expect(r.ok).toBe(true);
    expect((r as any).body).not.toMatch(/\s,|\[|\]|undefined|null/);
  });

  it("leads with who is texting, not with the date", () => {
    // An unknown number opening with an install date reads as spam. The rep's
    // name and the company are why the customer keeps reading.
    const body = (buildAppointmentMessage(VARS) as any).body;
    expect(body.indexOf("Rae")).toBeLessThan(body.indexOf("Aug 4"));
    expect(body).toContain("Home Front");
  });

  it("states the window, never a single time", () => {
    // An installer arriving inside a window is not late. A customer told
    // "8:00 AM" believes otherwise at 8:05, and that call lands on the rep.
    const body = (buildAppointmentMessage(VARS) as any).body;
    expect(body).toContain("between 8:00-10:00 AM");
  });

  it("includes the timezone when one is given, and reads cleanly without", () => {
    const withTz = buildAppointmentMessage({ ...VARS, timezoneLabel: "CT" });
    expect((withTz as any).body).toContain("8:00-10:00 AM CT");
    const withoutTz = (buildAppointmentMessage(VARS) as any).body;
    expect(withoutTz).not.toMatch(/AM\s{2,}/);
    expect(withoutTz).toContain("8:00-10:00 AM.");
  });

  it("invites a reply, because a text nobody can answer is a dead end", () => {
    expect((buildAppointmentMessage(VARS) as any).body).toMatch(/reply/i);
  });
});

describe("knowing which phone the rep is holding", () => {
  it("recognises Android and iPhone", () => {
    expect(detectSmsPlatform("Mozilla/5.0 (Linux; Android 14; Pixel 8)")).toBe("android");
    expect(detectSmsPlatform("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)")).toBe("ios");
  });

  it("catches an iPad pretending to be a Mac", () => {
    // iPadOS 13+ reports Macintosh. Touch points are what give it away, and an
    // iPad is a device that can text.
    const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)";
    expect(detectSmsPlatform(ua, 5)).toBe("ios");
    expect(detectSmsPlatform(ua, 0)).toBe("other");  // a real Mac
  });

  it("does not throw on a missing user agent", () => {
    expect(detectSmsPlatform("")).toBe("other");
    expect(detectSmsPlatform(undefined as any)).toBe("other");
  });
});
