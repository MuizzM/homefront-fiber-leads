// The freeze rules, tested without a database.
//
// These are the rules that decide whether a door a rep already sold gets handed
// back out as a fresh prospect, so they're worth pinning down at the unit level
// where every combination is cheap to enumerate.
import { describe, expect, it } from "vitest";
import {
  classifyLeadForPass, planPass, rollUpPass,
  FREEZE_REASON_LABELS, FREEZE_REASON_HELP,
  isTerritoryPassAction, PASS_RESET_FIELDS,
  type PassLeadInput,
} from "../../shared/territoryPass";

const lead = (over: Partial<PassLeadInput> = {}): PassLeadInput => ({ id: 1, leadStatus: "contacted", ...over });
const NOW = "2026-07-01T00:00:00.000Z";

describe("classifyLeadForPass", () => {
  it("re-opens an ordinary worked door", () => {
    for (const s of ["contacted", "not_interested", "follow_up", "prospect", "interested", null, ""]) {
      expect(classifyLeadForPass(lead({ leadStatus: s })).action).toBe("reset");
    }
  });

  it("freezes a sold door", () => {
    expect(classifyLeadForPass(lead({ leadStatus: "sold" }))).toMatchObject({ action: "freeze", reason: "sold" });
  });

  it("is not fooled by casing or padding on the status", () => {
    // Statuses arrive from imports and hand-edits as well as the app.
    for (const s of ["SOLD", " Sold ", "sOlD"]) {
      expect(classifyLeadForPass(lead({ leadStatus: s })).reason).toBe("sold");
    }
  });

  it("freezes on the commission ledger even when the status disagrees", () => {
    expect(classifyLeadForPass(lead({ leadStatus: "contacted", hasActiveSale: true })))
      .toMatchObject({ action: "freeze", reason: "commission_linked" });
  });

  it("reports 'sold' first when a door is both sold and do-not-knock", () => {
    // Precedence is a UX decision: the money reason is the one a manager must see.
    expect(classifyLeadForPass(lead({ leadStatus: "sold", doNotKnock: true })).reason).toBe("sold");
  });

  it("freezes do-not-knock regardless of options", () => {
    expect(classifyLeadForPass(lead({ doNotKnock: true }), { keepPendingCallbacks: false }))
      .toMatchObject({ action: "freeze", reason: "do_not_knock" });
  });

  it("only protects callbacks when asked, and only future ones", () => {
    const future = lead({ pendingCallbackAt: "2026-08-01T00:00:00.000Z" });
    const past = lead({ pendingCallbackAt: "2026-06-01T00:00:00.000Z" });

    // Off by default — the user's chosen semantics: reset everything but sold/DNK.
    expect(classifyLeadForPass(future, { now: NOW }).action).toBe("reset");
    expect(classifyLeadForPass(future, { keepPendingCallbacks: true, now: NOW }).reason).toBe("pending_callback");
    // A callback whose date has already passed is not a live commitment.
    expect(classifyLeadForPass(past, { keepPendingCallbacks: true, now: NOW }).action).toBe("reset");
  });
});

describe("planPass", () => {
  it("splits an area and counts the reasons", () => {
    const plan = planPass([
      lead({ id: 1, leadStatus: "not_interested" }),
      lead({ id: 2, leadStatus: "sold" }),
      lead({ id: 3, doNotKnock: true }),
      lead({ id: 4, hasActiveSale: true }),
      lead({ id: 5, leadStatus: "not_home" }),
    ], { now: NOW });

    expect(plan.reset).toEqual([1, 5]);
    expect(plan.totals).toEqual({ total: 5, reset: 2, frozen: 3 });
    expect(plan.frozenByReason).toMatchObject({ sold: 1, do_not_knock: 1, commission_linked: 1 });
  });

  it("counts callbacks it is about to drop", () => {
    const plan = planPass([
      lead({ id: 1, pendingCallbackAt: "2026-08-01T00:00:00.000Z" }),
      lead({ id: 2, pendingCallbackAt: "2026-06-01T00:00:00.000Z" }), // already past
      lead({ id: 3 }),
    ], { now: NOW });
    expect(plan.reset).toEqual([1, 2, 3]);
    expect(plan.callbacksAtRisk).toBe(1); // only the live one is a broken promise
  });

  it("reports nothing at risk once callbacks are protected", () => {
    const plan = planPass([lead({ id: 1, pendingCallbackAt: "2026-08-01T00:00:00.000Z" })],
      { keepPendingCallbacks: true, now: NOW });
    expect(plan.callbacksAtRisk).toBe(0);
    expect(plan.totals.reset).toBe(0);
  });

  it("handles an empty area", () => {
    const plan = planPass([], { now: NOW });
    expect(plan.totals).toEqual({ total: 0, reset: 0, frozen: 0 });
  });
});

describe("rollUpPass", () => {
  it("tallies outcomes and the reps who worked them", () => {
    const s = rollUpPass([
      { outcome: "sold", wasHome: true, repId: 7 },
      { outcome: "not_home", wasHome: false, repId: 7 },
      { outcome: "not_interested", wasHome: true, repId: 9 },
      { outcome: "callback", wasHome: true, repId: 9 },
      { outcome: "interested", wasHome: true, repId: 7 },
    ]);
    expect(s).toMatchObject({ knocks: 5, doorsAnswered: 4, sold: 1, notHome: 1, notInterested: 1, callbacks: 1, interested: 1 });
    expect(s.reps).toEqual([7, 9]);
  });

  it("counts a superseded knock as effort but not as an outcome", () => {
    // The rep really walked to the door, so it's a knock; but a newer outcome
    // won the CAS, so folding its outcome in would double-count the door.
    const s = rollUpPass([
      { outcome: "sold", wasHome: true, repId: 1, superseded: true },
      { outcome: "not_interested", wasHome: true, repId: 1 },
    ]);
    expect(s.knocks).toBe(2);
    expect(s.sold).toBe(0);
    expect(s.notInterested).toBe(1);
  });

  it("tolerates junk outcomes without throwing", () => {
    const s = rollUpPass([{ outcome: null }, { outcome: "" }, { outcome: "weird" }, {}]);
    expect(s.knocks).toBe(4);
    expect(s.sold).toBe(0);
  });
});

describe("contract details", () => {
  it("a reset clears exactly four fields - widening this must be deliberate", () => {
    // If this fails, someone widened the blast radius of a reset. That may be
    // correct, but it needs to be a decision, not a drive-by edit.
    expect(Object.keys(PASS_RESET_FIELDS).sort())
      .toEqual(["assignMark", "lastOutcome", "lastOutcomeAt", "leadStatus"]);
    expect(PASS_RESET_FIELDS.leadStatus).toBe("prospect");
  });

  it("every freeze reason has a label and a plain-language explanation", () => {
    for (const k of Object.keys(FREEZE_REASON_LABELS)) {
      expect(FREEZE_REASON_HELP[k as keyof typeof FREEZE_REASON_HELP]).toBeTruthy();
    }
    expect(Object.keys(FREEZE_REASON_HELP).sort()).toEqual(Object.keys(FREEZE_REASON_LABELS).sort());
  });

  it("validates the territory action instead of trusting the body", () => {
    for (const ok of ["return_to_pool", "keep", "reassign"]) expect(isTerritoryPassAction(ok)).toBe(true);
    for (const bad of ["delete", "", null, undefined, 1, {}, ["keep"]]) expect(isTerritoryPassAction(bad)).toBe(false);
  });
});
