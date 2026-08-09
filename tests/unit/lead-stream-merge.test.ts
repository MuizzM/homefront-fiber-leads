// ── mergePushedPin / pinFromPushedLead — what another rep's phone SHOWS ──────
// The stream gate (lead-stream.test.ts) proves ordering by seq; THIS file
// proves the field-level merge of an accepted push into the map-cache pin.
// pinDisplayState (shared/knock.ts) is the only display authority, so every
// "recolors / stays" assertion here is phrased through it — a merge that
// stores the right strings but computes the wrong display state is a failure.
//
// The defect this guards against (B3/B5): the old merge compared the push's
// lastOutcomeAt against the pin's lastKnockedAt — a physical KNOCK time a
// central mark never advances — and then wrote the outcome time INTO
// lastKnockedAt, corrupting the next comparison's baseline. The rewritten
// merge mirrors the server's CAS clock (leads.last_outcome_at) exactly:
// newer-or-equal recolors, older is ignored.
import { describe, expect, it } from "vitest";
import { mergePushedPin, pinFromPushedLead, type StreamMergeablePin } from "../../client/src/lib/leadStreamMerge";
import type { LeadStreamPin } from "../../client/src/lib/leadStream";
import { pinDisplayState } from "../../shared/knock";

const T = (min: number) => `2026-07-30T10:${String(min).padStart(2, "0")}:00.000Z`;

function localPin(over: Partial<StreamMergeablePin> = {}): StreamMergeablePin {
  return {
    id: 42,
    address: "12 Maple St",
    city: "Lexington",
    state: "NC",
    zip: "27292",
    lat: 35.8,
    lng: -80.25,
    leadStatus: "prospect",
    fiberStatus: "available",
    assignedRepId: 5,
    assignedTerritoryId: 12,
    leadScore: 70,
    ...over,
  };
}

function push(over: Partial<LeadStreamPin> = {}): LeadStreamPin {
  return {
    id: 42,
    address: "12 Maple St",
    city: "Lexington",
    state: "NC",
    zip: "27292",
    lat: 35.8,
    lng: -80.25,
    leadStatus: "prospect",
    fiberStatus: "available",
    leadTag: null,
    leadScore: 70,
    assignMark: null,
    doNotKnock: false,
    lastOutcome: null,
    lastOutcomeAt: null,
    assignedRepId: 5,
    assignedTerritoryId: 12,
    ...over,
  };
}

describe("outcome CAS ordering - the server's recency rule, mirrored", () => {
  it("a push with a NEWER lastOutcomeAt recolors the pin", () => {
    const prev = localPin({ leadStatus: "interested", visited: true, lastOutcome: "interested", lastOutcomeAt: T(0) });
    const next = mergePushedPin(prev, push({ leadStatus: "sold", lastOutcome: "sold", lastOutcomeAt: T(5) }));
    expect(pinDisplayState(next)).toBe("sold");
    expect(next.lastOutcomeAt).toBe(T(5));
  });

  it("a push with an OLDER lastOutcomeAt is ignored - the pin keeps the newer state", () => {
    // The race this encodes: phone B refetched the map AFTER a central mark
    // (baseline T5), then a stream frame for an earlier knock (T3) arrives
    // late over the network. The server's CAS already declared T5 the winner;
    // repainting T3 over it would show phone B a state the server does not hold.
    const prev = localPin({ leadStatus: "not_interested", visited: true, lastOutcome: "not_interested", lastOutcomeAt: T(5) });
    const next = mergePushedPin(prev, push({ leadStatus: "interested", lastOutcome: "interested", lastOutcomeAt: T(3) }));
    expect(pinDisplayState(next)).toBe("not_interested");
    expect(next.leadStatus).toBe("not_interested");
    expect(next.lastOutcome).toBe("not_interested");
    expect(next.lastOutcomeAt).toBe(T(5));
  });

  it("an EQUAL timestamp applies - mirrors the CAS's own self-tolerance on replay", () => {
    const prev = localPin({ leadStatus: "interested", visited: true, lastOutcome: "interested", lastOutcomeAt: T(5) });
    const next = mergePushedPin(prev, push({ leadStatus: "sold", lastOutcome: "sold", lastOutcomeAt: T(5) }));
    expect(pinDisplayState(next)).toBe("sold");
  });

  it("a pin with no recency clock at all has nothing to defend and takes the push", () => {
    const prev = localPin();
    const next = mergePushedPin(prev, push({ leadStatus: "sold", lastOutcome: "sold", lastOutcomeAt: T(1) }));
    expect(pinDisplayState(next)).toBe("sold");
    expect(next.visited).toBe(true);
  });

  it("legacy pins (knock join only, no lead-level clock) fall back to lastKnockedAt as the baseline", () => {
    const prev = localPin({ leadStatus: "sold", visited: true, lastOutcome: "sold", lastKnockedAt: T(10) });
    // Older than the legacy knock: ignored.
    const stale = mergePushedPin(prev, push({ leadStatus: "not_home", lastOutcome: "not_home", lastOutcomeAt: T(8) }));
    expect(pinDisplayState(stale)).toBe("sold");
    // Newer: applied.
    const fresh = mergePushedPin(prev, push({ leadStatus: "not_interested", lastOutcome: "not_interested", lastOutcomeAt: T(12) }));
    expect(pinDisplayState(fresh)).toBe("not_interested");
  });

  it("does NOT conflate the clocks: a merged push never rewrites lastKnockedAt", () => {
    // A central mark carries an outcome time but no knock happened. Writing it
    // into lastKnockedAt (the old behavior) both lied to the card's "last
    // knocked" line and poisoned the next merge's baseline.
    const prev = localPin({ leadStatus: "interested", visited: true, lastOutcome: "interested", lastKnockedAt: T(0), lastOutcomeAt: T(0) });
    const next = mergePushedPin(prev, push({ leadStatus: "not_interested", lastOutcome: "not_interested", lastOutcomeAt: T(5) }));
    expect(next.lastKnockedAt).toBe(T(0));
    expect(next.lastOutcomeAt).toBe(T(5));
  });

  it("central 'already customer' lands with its distinct display state", () => {
    const prev = localPin({ leadStatus: "prospect" });
    const next = mergePushedPin(prev, push({ leadStatus: "not_interested", lastOutcome: "already_customer", lastOutcomeAt: T(2) }));
    expect(pinDisplayState(next)).toBe("already_customer");
  });
});

describe("display fields the wire pin carries beyond the outcome", () => {
  it("merges assignMark so a manager's triage mark reaches other phones", () => {
    const next = mergePushedPin(localPin(), push({ assignMark: "priority" }));
    expect(next.assignMark).toBe("priority");
  });

  it("clears assignMark on null - every emit path projects the FULL post-write row", () => {
    const next = mergePushedPin(localPin({ assignMark: "priority" }), push({ assignMark: null }));
    expect(next.assignMark).toBeNull();
  });

  it("merges doNotKnock in both directions - the compliance block must never lag", () => {
    expect(mergePushedPin(localPin(), push({ doNotKnock: true })).doNotKnock).toBe(true);
    expect(mergePushedPin(localPin({ doNotKnock: true }), push({ doNotKnock: false })).doNotKnock).toBe(false);
  });

  it("clears the assignment pair on null - the state that must drop a halo", () => {
    const next = mergePushedPin(localPin(), push({ assignedRepId: null, assignedTerritoryId: null }));
    expect(next.assignedRepId).toBeNull();
    expect(next.assignedTerritoryId).toBeNull();
  });
});

describe("what the merge must NOT touch", () => {
  it("never erases joined columns the event does not carry (knockCount et al ride through)", () => {
    const prev = { ...localPin({ leadStatus: "interested", visited: true, lastOutcome: "interested", lastOutcomeAt: T(0), lastKnockedAt: T(0) }), knockCount: 3, carrier: "kinetic", freshConfidence: "high" } as StreamMergeablePin & { knockCount: number; carrier: string; freshConfidence: string };
    const next = mergePushedPin(prev, push({ leadStatus: "sold", lastOutcome: "sold", lastOutcomeAt: T(4) })) as typeof prev;
    expect(next.knockCount).toBe(3);
    expect(next.carrier).toBe("kinetic");
    expect(next.freshConfidence).toBe("high");
  });

  it("returns the SAME object for a no-op push, so nothing re-renders or re-clusters", () => {
    const prev = localPin({ leadStatus: "sold", visited: true, lastOutcome: "sold", lastOutcomeAt: T(5) });
    expect(mergePushedPin(prev, push({ leadStatus: "sold", lastOutcome: "sold", lastOutcomeAt: T(5), doNotKnock: false }))).toBe(prev);
  });

  it("a rejected outcome group still lets the always-write fields land", () => {
    // Stale outcome + fresh assignment in one frame: the door changed hands
    // AND an old disposition rode along. The hand-off must paint, the stale
    // disposition must not.
    const prev = localPin({ leadStatus: "sold", visited: true, lastOutcome: "sold", lastOutcomeAt: T(9) });
    const next = mergePushedPin(prev, push({ leadStatus: "interested", lastOutcome: "interested", lastOutcomeAt: T(2), assignedRepId: 8, assignedTerritoryId: 30 }));
    expect(pinDisplayState(next)).toBe("sold");
    expect(next.assignedRepId).toBe(8);
    expect(next.assignedTerritoryId).toBe(30);
  });
});

describe("pinFromPushedLead - a door entering scope mid-shift", () => {
  it("carries the CAS clock and display fields, and leaves the knock clock unset", () => {
    const pin = pinFromPushedLead(push({
      leadStatus: "sold", lastOutcome: "sold", lastOutcomeAt: T(7),
      assignMark: "priority", doNotKnock: true,
    }));
    expect(pinDisplayState(pin)).toBe("sold");
    expect(pin.visited).toBe(true);
    expect(pin.lastOutcomeAt).toBe(T(7));
    expect(pin.lastKnockedAt).toBeUndefined();
    expect(pin.assignMark).toBe("priority");
    expect(pin.doNotKnock).toBe(true);
  });

  it("an unworked pushed door starts unworked", () => {
    const pin = pinFromPushedLead(push());
    expect(pinDisplayState(pin)).toBe("unworked");
    expect(pin.visited).toBe(false);
  });
});
