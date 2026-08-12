// ── The gate's rulebook, tested as rules ─────────────────────────────────────
//
// decideGate() and clampPolicy() are pure, so this suite asks the questions
// that decide whether the layer is a control or a decoration:
//
//   THE FLOOR      Can an organization configure a safeguard away? (No.)
//   MAGNITUDE      Does size change the answer for the same kind? (Yes.)
//   THE PROMISE    Is undo ever offered on a kind that cannot be undone? (No.)
//   THE CLAMP      Does a row written under older rules keep running under
//                  them? (No - the floor lives in the code.)

import { describe, expect, it } from "vitest";
import {
  GUARDED_ACTIONS, GUARDED_ACTION_KINDS, MAX_PENDING_EXPIRY_MINUTES,
  atLeast, clampPolicy, decideGate, defaultPolicy, undoAvailability,
  type GatePolicy,
} from "@shared/guardedActions";

const policyFor = (kind: (typeof GUARDED_ACTION_KINDS)[number], patch: Partial<GatePolicy> = {}): GatePolicy => ({
  ...defaultPolicy(kind),
  ...patch,
});

describe("the catalogue is internally consistent", () => {
  it("never ships a default looser than its own floor", () => {
    // The single invariant that makes `floor` meaningful. A default below the
    // floor would mean every organization starts out under a rule the code
    // claims is impossible.
    for (const kind of GUARDED_ACTION_KINDS) {
      const spec = GUARDED_ACTIONS[kind];
      expect(atLeast(spec.defaultMode, spec.floor), `${kind} default`).toBe(spec.defaultMode);
    }
  });

  it("gives irreversible kinds a zero undo ceiling", () => {
    for (const kind of GUARDED_ACTION_KINDS) {
      const spec = GUARDED_ACTIONS[kind];
      if (spec.reversibility === "irreversible") {
        expect(spec.maxUndoWindowMinutes, `${kind} ceiling`).toBe(0);
        expect(defaultPolicy(kind).undoWindowMinutes, `${kind} default window`).toBe(0);
      }
    }
  });

  it("pairs every kind with a request and an approve capability", () => {
    for (const kind of GUARDED_ACTION_KINDS) {
      expect(GUARDED_ACTIONS[kind].requestCapability).toBeTruthy();
      expect(GUARDED_ACTIONS[kind].approveCapability).toBeTruthy();
    }
  });
});

describe("the floor cannot be configured away", () => {
  it("refuses to drop a suppression lift to automatic", () => {
    // The whole point of the layer in one assertion. An admin sets "auto";
    // the clamp hands back "approval", because somebody replied STOP and no
    // organization gets to make overriding that a single click.
    const wishful = policyFor("contact.suppression.lift", { mode: "auto" });
    expect(clampPolicy(wishful).mode).toBe("approval");
    expect(decideGate("contact.suppression.lift", wishful, { magnitude: 1 }).outcome).toBe("approval");
  });

  it("still lets an organization tighten past the floor", () => {
    const stricter = policyFor("contact.suppression.lift", { mode: "deny" });
    expect(clampPolicy(stricter).mode).toBe("deny");
    expect(decideGate("contact.suppression.lift", stricter, { magnitude: 1 }).outcome).toBe("deny");
  });

  it("keeps a stored policy under the CURRENT floor, not the one it was saved under", () => {
    // Simulates a row written before the floor was raised. Reading it back must
    // not resurrect the looser rule.
    const stale = { ...defaultPolicy("contact.suppression.lift"), mode: "auto" as const };
    expect(clampPolicy(stale).mode).toBe("approval");
  });
});

describe("magnitude decides the same kind differently", () => {
  const kind = "lead.bulk_assign" as const;

  it("lets a routine selection through", () => {
    const verdict = decideGate(kind, policyFor(kind, { approvalAboveMagnitude: 200 }), { magnitude: 40 });
    expect(verdict.outcome).toBe("execute");
  });

  it("queues the one that moves somebody's whole book", () => {
    const verdict = decideGate(kind, policyFor(kind, { approvalAboveMagnitude: 200 }), { magnitude: 640 });
    expect(verdict.outcome).toBe("approval");
    // The reason is what the requester reads before they commit, so it names
    // the number and the limit rather than saying "not allowed".
    expect(verdict.reason).toContain("640");
    expect(verdict.reason).toContain("200");
  });

  it("treats exactly the threshold as still automatic", () => {
    // "above 200" means 200 passes. Off-by-one here is the difference between a
    // documented limit and a surprising one.
    expect(decideGate(kind, policyFor(kind, { approvalAboveMagnitude: 200 }), { magnitude: 200 }).outcome)
      .toBe("execute");
    expect(decideGate(kind, policyFor(kind, { approvalAboveMagnitude: 200 }), { magnitude: 201 }).outcome)
      .toBe("approval");
  });

  it("ignores the threshold once the mode is already approval", () => {
    const verdict = decideGate(kind, policyFor(kind, { mode: "approval", approvalAboveMagnitude: 10_000 }), { magnitude: 1 });
    expect(verdict.outcome).toBe("approval");
  });

  it("disables the magnitude rule when no threshold is set", () => {
    const verdict = decideGate(kind, policyFor(kind, { approvalAboveMagnitude: null }), { magnitude: 4_000 });
    expect(verdict.outcome).toBe("execute");
  });
});

describe("clampPolicy bounds what an admin can type", () => {
  it("caps the undo window at the kind's ceiling", () => {
    const spec = GUARDED_ACTIONS["lead.reassign"];
    const clamped = clampPolicy(policyFor("lead.reassign", { undoWindowMinutes: 999_999 }));
    expect(clamped.undoWindowMinutes).toBe(spec.maxUndoWindowMinutes);
  });

  it("forces the undo window to zero on an irreversible kind", () => {
    const clamped = clampPolicy(policyFor("contact.suppression.lift", { undoWindowMinutes: 240 }));
    expect(clamped.undoWindowMinutes).toBe(0);
  });

  it("rejects a nonsense magnitude threshold rather than storing it", () => {
    expect(clampPolicy(policyFor("lead.bulk_assign", { approvalAboveMagnitude: 0 })).approvalAboveMagnitude).toBeNull();
    expect(clampPolicy(policyFor("lead.bulk_assign", { approvalAboveMagnitude: -5 })).approvalAboveMagnitude).toBeNull();
    expect(clampPolicy(policyFor("lead.bulk_assign", { approvalAboveMagnitude: NaN })).approvalAboveMagnitude).toBeNull();
  });

  it("keeps the pending window inside a sane range", () => {
    expect(clampPolicy(policyFor("lead.reassign", { pendingExpiryMinutes: 0 })).pendingExpiryMinutes).toBe(5);
    expect(clampPolicy(policyFor("lead.reassign", { pendingExpiryMinutes: 10_000_000 })).pendingExpiryMinutes)
      .toBe(MAX_PENDING_EXPIRY_MINUTES);
  });

  it("defaults self-approval off", () => {
    expect(defaultPolicy("lead.bulk_assign").selfApproval).toBe(false);
    // Anything other than a literal true is off. A queue one person can clear
    // alone is a log with extra steps, so this is not a coercion to be relaxed.
    expect(clampPolicy({ ...defaultPolicy("lead.bulk_assign"), selfApproval: "yes" as any }).selfApproval).toBe(false);
  });
});

describe("undo is only offered where it can be honoured", () => {
  const executedAt = "2026-08-11T12:00:00.000Z";
  const within = new Date("2026-08-11T12:30:00.000Z");
  const after = new Date("2026-08-11T14:00:00.000Z");

  it("offers it inside the window on a reversible kind", () => {
    const result = undoAvailability({
      kind: "lead.reassign", state: "executed", executedAt,
      undoWindowMinutes: 60, hasInverse: true, now: within,
    });
    expect(result.available).toBe(true);
  });

  it("closes it once the window has passed", () => {
    const result = undoAvailability({
      kind: "lead.reassign", state: "executed", executedAt,
      undoWindowMinutes: 60, hasInverse: true, now: after,
    });
    expect(result).toEqual({ available: false, because: "expired" });
  });

  it("never offers it on an irreversible kind, whatever the window says", () => {
    // Even handed a generous window and a stored inverse, the answer is no.
    // Re-adding a suppression row restores the block; it does not recall the
    // message that went out while the block was down.
    const result = undoAvailability({
      kind: "contact.suppression.lift", state: "executed", executedAt,
      undoWindowMinutes: 1_440, hasInverse: true, now: within,
    });
    expect(result).toEqual({ available: false, because: "irreversible" });
  });

  it("refuses when no inverse was captured", () => {
    const result = undoAvailability({
      kind: "lead.reassign", state: "executed", executedAt,
      undoWindowMinutes: 60, hasInverse: false, now: within,
    });
    expect(result).toEqual({ available: false, because: "no_inverse" });
  });

  it("refuses twice on the same action", () => {
    const result = undoAvailability({
      kind: "lead.reassign", state: "undone", executedAt,
      undoWindowMinutes: 60, hasInverse: true, now: within,
    });
    expect(result).toEqual({ available: false, because: "already_undone" });
  });

  it("distinguishes a disabled window from an expired one", () => {
    // Different sentences to an operator: one is a setting they can change,
    // the other is a deadline they missed.
    const result = undoAvailability({
      kind: "lead.reassign", state: "executed", executedAt,
      undoWindowMinutes: 0, hasInverse: true, now: within,
    });
    expect(result).toEqual({ available: false, because: "disabled" });
  });

  it("never offers undo on an action that did not execute", () => {
    for (const state of ["pending", "rejected", "expired", "failed"] as const) {
      const result = undoAvailability({
        kind: "lead.reassign", state, executedAt: null,
        undoWindowMinutes: 60, hasInverse: true, now: within,
      });
      expect(result.available, state).toBe(false);
    }
  });
});
