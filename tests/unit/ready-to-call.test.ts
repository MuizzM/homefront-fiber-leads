import { describe, expect, it } from "vitest";
import {
  displayName, isResident, dialPhone, formatDialDisplay,
  callOutcomeMeta, isCallOutcome, CALL_OUTCOMES,
} from "../../shared/readyToCall";

describe("Ready-to-Call identity coalescers", () => {
  it("prefers owner name, then contact name, then 'Resident' — never a fake name", () => {
    expect(displayName({ ownerName: "Dana Owner", contactName: "x" })).toBe("Dana Owner");
    expect(displayName({ ownerName: " ", contactName: "Cara Contact" })).toBe("Cara Contact");
    expect(displayName({ ownerName: null, contactName: "" })).toBe("Resident");
    expect(isResident({ ownerName: "", contactName: "  " })).toBe(true);
    expect(isResident({ contactName: "Cara" })).toBe(false);
  });

  it("dials the first usable US number (contact then owner), normalized to E.164", () => {
    expect(dialPhone({ contactPhone: "(336) 555-0142" })).toBe("+13365550142");
    expect(dialPhone({ contactPhone: "1-336-555-0142" })).toBe("+13365550142");
    expect(dialPhone({ contactPhone: "  ", ownerPhone: "3365550142" })).toBe("+13365550142");
    expect(dialPhone({ contactPhone: "not a phone", ownerPhone: null })).toBeNull();
    expect(dialPhone({})).toBeNull();
  });

  it("formats E.164 for display", () => {
    expect(formatDialDisplay("+13365550142")).toBe("(336) 555-0142");
  });
});

describe("Ready-to-Call outcome vocabulary", () => {
  it("has exactly the ten required outcomes", () => {
    expect(CALL_OUTCOMES.map(o => o.code)).toEqual([
      "answered", "no_answer", "voicemail", "callback", "interested",
      "appointment", "sold", "already_has_service", "wrong_number", "do_not_call",
    ]);
  });
  it("marks the terminal + side-effect outcomes correctly", () => {
    expect(callOutcomeMeta("callback")?.requiresCallback).toBe(true);
    expect(callOutcomeMeta("do_not_call")?.setsDoNotCall).toBe(true);
    expect(callOutcomeMeta("do_not_call")?.terminal).toBe(true);
    expect(callOutcomeMeta("wrong_number")?.invalidatesPhone).toBe(true);
    // Canonical PAIR: "already has service" is stored as not_interested +
    // lastOutcome=already_customer — writing the bare status painted a
    // phone-confirmed customer as an unworked door on the map.
    expect(callOutcomeMeta("already_has_service")?.leadStatus).toBe("not_interested");
    expect(callOutcomeMeta("already_has_service")?.lastOutcome).toBe("already_customer");
    expect(callOutcomeMeta("callback")?.leadStatus).toBe("follow_up");
    expect(callOutcomeMeta("callback")?.lastOutcome).toBe("callback");
    // Attempts and bad numbers never rewrite the door's status.
    expect(callOutcomeMeta("no_answer")?.leadStatus).toBeUndefined();
    expect(callOutcomeMeta("wrong_number")?.leadStatus).toBeUndefined();
    expect(callOutcomeMeta("answered")?.terminal).toBe(false);
    expect(isCallOutcome("sold")).toBe(true);
    expect(isCallOutcome("banana")).toBe(false);
  });
});
