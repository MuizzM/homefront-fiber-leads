// ── The consent gate, pinned ─────────────────────────────────────────────────
//
// This is the wall between a recovery queue and somebody's phone. Two
// properties matter more than any other:
//
//   1. IT IS FAIL-CLOSED AND HAS NO OVERRIDE. There is no argument to
//      evaluateContactGate that lets a suppression, an opt-out, or a missing
//      consent record be bypassed. The test below asserts that by construction:
//      an allowed input flipped one field at a time must always block.
//   2. IT REPORTS EVERY REASON, NOT THE FIRST. An admin who fixes consent
//      should not then discover the template was never approved either.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_MESSAGING_CAPS, DEFAULT_QUIET_HOURS, SMS_OPT_OUT_SENTENCE,
  bodyCarriesOptOut, detectOptIn, detectOptOut, evaluateContactGate,
  isPlausibleEmail, maskEmail, maskName, maskPhone, normalizeEmail, normalizePhoneE164,
  recipientLocalHour, stateFromAddressLine, timeZoneForState,
  type ContactGateInput,
} from "@shared/contactConsent";

/** An input where every gate passes. Each test below breaks exactly one thing. */
function allowed(over: Partial<ContactGateInput> = {}): ContactGateInput {
  return {
    channel: "sms",
    purpose: "transactional_service_update",
    featureEnabled: true,
    organizationApproved: true,
    identityResolved: true,
    destination: "+17045550142",
    suppressed: false,
    doNotContact: false,
    consentStatus: "granted",
    consentBasis: "express_written",
    templateApproved: true,
    senderConfigured: true,
    bodyHasOptOutLanguage: true,
    bodyHasUnsubscribe: true,
    bodyHasPostalAddress: true,
    recipientLocalHour: 14,
    quietHours: DEFAULT_QUIET_HOURS,
    sentToDestinationToday: 0,
    sentForCaseTotal: 0,
    hoursSinceLastOutreachToCase: null,
    caps: DEFAULT_MESSAGING_CAPS,
    ...over,
  };
}

describe("evaluateContactGate", () => {
  it("allows only when everything passes", () => {
    const result = evaluateContactGate(allowed());
    expect(result.allowed).toBe(true);
    expect(result.blockedBy).toEqual([]);
  });

  it("blocks on each requirement independently", () => {
    const cases: [Partial<ContactGateInput>, string][] = [
      [{ featureEnabled: false }, "FEATURE_DISABLED"],
      [{ organizationApproved: false }, "ORG_NOT_APPROVED"],
      [{ identityResolved: false }, "IDENTITY_UNRESOLVED"],
      [{ destination: null }, "NO_DESTINATION"],
      [{ destination: "555" }, "INVALID_DESTINATION"],
      [{ suppressed: true }, "SUPPRESSED"],
      [{ doNotContact: true }, "DO_NOT_CONTACT"],
      [{ consentStatus: "revoked" }, "CONSENT_REVOKED"],
      [{ consentStatus: "never_granted" }, "CONSENT_MISSING"],
      [{ consentStatus: "unknown" }, "CONSENT_MISSING"],
      [{ consentBasis: null }, "CONSENT_BASIS_INSUFFICIENT"],
      [{ consentBasis: "none" }, "CONSENT_BASIS_INSUFFICIENT"],
      [{ templateApproved: false }, "TEMPLATE_NOT_APPROVED"],
      [{ senderConfigured: false }, "SENDER_NOT_CONFIGURED"],
      [{ bodyHasOptOutLanguage: false }, "MISSING_OPT_OUT_LANGUAGE"],
      [{ recipientLocalHour: 3 }, "QUIET_HOURS"],
      [{ recipientLocalHour: null }, "QUIET_HOURS"],
      [{ sentToDestinationToday: 1 }, "RATE_LIMIT_DAILY"],
      [{ sentForCaseTotal: 4 }, "RATE_LIMIT_CASE"],
      [{ hoursSinceLastOutreachToCase: 2 }, "RATE_LIMIT_COOLDOWN"],
    ];
    for (const [patch, reason] of cases) {
      const result = evaluateContactGate(allowed(patch));
      expect(result.allowed, `${reason} should block`).toBe(false);
      expect(result.blockedBy, reason).toContain(reason);
    }
  });

  it("blocks on an unknown recipient timezone rather than assuming one", () => {
    expect(evaluateContactGate(allowed({ recipientLocalHour: null })).blockedBy).toContain("QUIET_HOURS");
  });

  it("reports every failing rule at once", () => {
    const result = evaluateContactGate(allowed({
      featureEnabled: false, suppressed: true, templateApproved: false, consentStatus: "revoked",
    }));
    expect(result.blockedBy).toEqual(expect.arrayContaining([
      "FEATURE_DISABLED", "SUPPRESSED", "CONSENT_REVOKED", "TEMPLATE_NOT_APPROVED",
    ]));
  });

  it("never leaks the destination into the message a rep sees", () => {
    const result = evaluateContactGate(allowed({ suppressed: true }));
    expect(result.summary).not.toContain("7045550142");
    expect(result.summary).not.toContain("+1");
  });

  it("requires express written consent for marketing by text, but not for a service update", () => {
    const service = evaluateContactGate(allowed({ consentBasis: "existing_business_relationship" }));
    expect(service.allowed).toBe(true);

    const marketing = evaluateContactGate(allowed({
      purpose: "marketing", consentBasis: "existing_business_relationship",
    }));
    expect(marketing.blockedBy).toContain("CONSENT_BASIS_INSUFFICIENT");

    const marketingWritten = evaluateContactGate(allowed({ purpose: "marketing", consentBasis: "express_written" }));
    expect(marketingWritten.allowed).toBe(true);
  });

  it("holds email to unsubscribe and postal address instead of opt-out wording", () => {
    const email = (over: Partial<ContactGateInput> = {}) =>
      evaluateContactGate(allowed({ channel: "email", destination: "jane@example.com", ...over }));
    expect(email().allowed).toBe(true);
    expect(email({ bodyHasUnsubscribe: false }).blockedBy).toContain("MISSING_UNSUBSCRIBE");
    expect(email({ bodyHasPostalAddress: false }).blockedBy).toContain("MISSING_POSTAL_ADDRESS");
    // Opt-out WORDING is an SMS rule; an email without it is fine because the
    // unsubscribe link is the mechanism.
    expect(email({ bodyHasOptOutLanguage: false }).allowed).toBe(true);
  });

  it("honours a quiet-hours window that wraps midnight", () => {
    const window = { startHour: 22, endHour: 6 };
    expect(evaluateContactGate(allowed({ quietHours: window, recipientLocalHour: 23 })).allowed).toBe(true);
    expect(evaluateContactGate(allowed({ quietHours: window, recipientLocalHour: 2 })).allowed).toBe(true);
    expect(evaluateContactGate(allowed({ quietHours: window, recipientLocalHour: 12 })).blockedBy).toContain("QUIET_HOURS");
  });

  it("blocks everything when the window is empty", () => {
    const window = { startHour: 9, endHour: 9 };
    expect(evaluateContactGate(allowed({ quietHours: window, recipientLocalHour: 9 })).blockedBy).toContain("QUIET_HOURS");
  });
});

describe("phone and email normalization", () => {
  it("normalizes the formats a report actually carries", () => {
    for (const raw of ["(704) 555-0142", "704-555-0142", "7045550142", "+1 704 555 0142", "1-704-555-0142"]) {
      expect(normalizePhoneE164(raw)).toBe("+17045550142");
    }
  });

  it("refuses what is not a dialable US number", () => {
    for (const raw of ["", "123", "0045550142", "1115550142", "9115550142", "1111111111", null, undefined, "not a phone"]) {
      expect(normalizePhoneE164(raw as any)).toBeNull();
    }
  });

  it("accepts a plausible email and rejects a mis-mapped column", () => {
    expect(normalizeEmail("  Jane@Example.COM ")).toBe("jane@example.com");
    for (const raw of ["Jane Doe", "jane@", "@example.com", "jane@@example.com", "jane@example", "a b@c.com", ""]) {
      expect(isPlausibleEmail(raw), raw).toBe(false);
    }
  });
});

describe("masking", () => {
  it("keeps only the last four digits of a phone", () => {
    expect(maskPhone("+17045550142")).toBe("***-***-0142");
    expect(maskPhone("704 555 0142")).toBe("***-***-0142");
    expect(maskPhone("abc")).toBeNull();
  });

  it("hides an email without hiding that it exists", () => {
    const masked = maskEmail("jane.doe@example.com")!;
    expect(masked.startsWith("j")).toBe(true);
    expect(masked).toContain("@");
    expect(masked).toContain(".com");
    expect(masked).not.toContain("jane.doe");
    expect(masked).not.toContain("example");
  });

  it("shortens a name for a supervisory list", () => {
    expect(maskName("Jane Doe")).toBe("Jane D.");
    expect(maskName("Prince")).toBe("Prince");
    expect(maskName("")).toBeNull();
  });
});

describe("inbound opt-out", () => {
  it("detects the standard keywords whatever the casing or trailing punctuation", () => {
    for (const body of ["STOP", "stop", " Stop. ", "UNSUBSCRIBE", "quit!", "opt out", "Cancel"]) {
      expect(detectOptOut(body), body).toBeTruthy();
    }
  });

  it("does NOT suppress a customer who used the word in a sentence", () => {
    for (const body of [
      "please stop by on Thursday",
      "can you stop the tech from coming at 8",
      "I want to cancel the 2pm and rebook",
      "no need to stop, we are home all day",
    ]) {
      expect(detectOptOut(body), body).toBeNull();
    }
  });

  it("detects a re-subscribe keyword separately", () => {
    expect(detectOptIn("START")).toBe("start");
    expect(detectOptIn("yes")).toBe("yes");
    expect(detectOptIn("yes please send it")).toBeNull();
  });

  it("recognises the opt-out sentence a template must carry", () => {
    expect(bodyCarriesOptOut(`Hi there. ${SMS_OPT_OUT_SENTENCE}`)).toBe(true);
    expect(bodyCarriesOptOut("Text STOP to opt out")).toBe(true);
    expect(bodyCarriesOptOut("Hi there, call us back")).toBe(false);
  });
});

describe("recipient local time", () => {
  it("resolves a state that sits in one timezone", () => {
    expect(timeZoneForState("NC")).toBe("America/New_York");
    expect(timeZoneForState("ca")).toBe("America/Los_Angeles");
  });

  it("refuses a state that spans two timezones", () => {
    for (const state of ["FL", "TX", "TN", "KY", "IN", "MI", "ND", "SD", "NE", "KS", "ID", "OR", "AK"]) {
      expect(timeZoneForState(state), state).toBeNull();
    }
  });

  it("returns null rather than a guess for an unknown state", () => {
    expect(timeZoneForState(null)).toBeNull();
    expect(timeZoneForState("XX")).toBeNull();
    expect(recipientLocalHour("XX", new Date())).toBeNull();
  });

  it("computes the local hour for a resolvable state", () => {
    // 2026-08-11T15:00Z is 11:00 in New York (EDT) and 08:00 in Los Angeles.
    const at = new Date("2026-08-11T15:00:00Z");
    expect(recipientLocalHour("NC", at)).toBe(11);
    expect(recipientLocalHour("CA", at)).toBe(8);
  });

  it("reads the state off a free-text service address", () => {
    expect(stateFromAddressLine("123 N MAIN ST, CONCORD NC 28025")).toBe("NC");
    expect(stateFromAddressLine("456 Oak Ave, Rock Hill SC")).toBe("SC");
    expect(stateFromAddressLine("")).toBeNull();
  });
});
