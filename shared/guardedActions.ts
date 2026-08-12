// ── Guarded actions - the gate every dangerous write passes through ──────────
//
// One choke point between "somebody asked for this" and "the database changed".
// A request enters as an INTENT; a policy decides whether it executes now, waits
// for a second person, or is refused outright; the execution is journaled with
// the inverse needed to reverse it; and for a bounded window an authorized actor
// can undo it.
//
// Four properties this module exists to guarantee, and the reasoning behind each.
//
// THE CATALOGUE IS A FLOOR, NOT A DEFAULT.
//   Every kind declares the LOOSEST gate it may ever run under (`floor`). Tenant
//   policy may tighten that - auto becomes approval, approval becomes deny - and
//   can never loosen it. Without a floor, "who may configure the policy" quietly
//   becomes "who may turn every safeguard off", and the whole layer reduces to a
//   setting. A misconfigured organization must still be a safe one.
//
// UNDO IS A PROMISE, SO IT IS DECLARED PER KIND.
//   Reversibility is a property of the ACTION, not of the policy. Reassigning a
//   door writes one column and can be put back. Lifting a suppression cannot:
//   the moment the block is gone a message may leave, and re-adding the row does
//   not un-send it. Kinds say which they are, and an irreversible kind is never
//   offered an undo no matter what window an admin configures. A layer that
//   offers undo it cannot honour is worse than one that offers none, because
//   people approve differently when they believe a mistake is recoverable.
//
// MAGNITUDE IS PART OF THE DECISION.
//   Reassigning one door and reassigning four hundred are the same kind and not
//   the same risk. Policy carries a magnitude threshold so an organization can
//   let routine work through and stop the bulk case, which is the case that
//   actually needs a second pair of eyes.
//
// THE DECISION IS PURE.
//   decideGate() takes a kind, a policy and a request, and returns a verdict. No
//   database, no clock, no session. That is what makes the rules testable as
//   rules, and what lets the client show the user which outcome to expect before
//   they commit - from this same function, never a re-derived guess.
//
// Composes with shared/capabilities.ts rather than replacing it: a capability
// says who may ASK, this layer says what happens when they do.

import type { Capability } from "./capabilities";

// ── Kinds ────────────────────────────────────────────────────────────────────

export const GUARDED_ACTION_KINDS = [
  "lead.reassign",
  "lead.bulk_assign",
  "recovery.case.assign",
  "contact.suppression.lift",
] as const;
export type GuardedActionKind = (typeof GUARDED_ACTION_KINDS)[number];

export function isGuardedActionKind(value: unknown): value is GuardedActionKind {
  return typeof value === "string" && (GUARDED_ACTION_KINDS as readonly string[]).includes(value);
}

/** How the gate may be configured. Ordered loosest to strictest - `atLeast`
 *  below relies on the index, so the order is load-bearing. */
export const GATE_MODES = ["auto", "approval", "deny"] as const;
export type GateMode = (typeof GATE_MODES)[number];

const MODE_RANK: Record<GateMode, number> = { auto: 0, approval: 1, deny: 2 };

/** The stricter of two modes. Policy is applied through this, which is the
 *  single line that makes a catalogue floor unloosenable. */
export function atLeast(a: GateMode, b: GateMode): GateMode {
  return MODE_RANK[a] >= MODE_RANK[b] ? a : b;
}

export type Reversibility = "reversible" | "irreversible";

export interface GuardedActionSpec {
  kind: GuardedActionKind;
  /** Operator-facing name. Rendered in the approval queue and the history. */
  label: string;
  /** What an approver is actually being asked to allow. Written for someone who
   *  did not submit it and has ten seconds. */
  describes: string;
  /** The capability required to SUBMIT. Mirrors the route's own gate, so the
   *  layer can never be the thing that widens access. */
  requestCapability: Capability;
  /** The capability required to APPROVE. Deliberately separate: submitting and
   *  approving are two authorities, and on the kinds that matter they are held
   *  by different people. */
  approveCapability: Capability;
  /** The loosest gate this kind may ever run under. Tenant policy tightens. */
  floor: GateMode;
  /** The gate a tenant gets before anyone configures anything. Never looser
   *  than `floor`; validated by the invariant test. */
  defaultMode: GateMode;
  reversibility: Reversibility;
  /** Ceiling on the undo window, in minutes. Ignored entirely when the kind is
   *  irreversible. Bounded because an inverse captured last month describes a
   *  world that no longer exists. */
  maxUndoWindowMinutes: number;
  /** What the magnitude number counts, for the UI to render a real sentence
   *  instead of a bare integer. */
  magnitudeUnit: string;
  /** Default magnitude above which even an `auto` tenant needs approval. null
   *  means magnitude does not gate this kind. */
  defaultApprovalAboveMagnitude: number | null;
}

/**
 * The registry. Adding a kind here is a deliberate act: it declares a new
 * capability pairing, a new floor and a new promise about reversibility, and
 * the invariant test below refuses several ways of getting it wrong.
 */
export const GUARDED_ACTIONS: Record<GuardedActionKind, GuardedActionSpec> = {
  "lead.reassign": {
    kind: "lead.reassign",
    label: "Reassign a door",
    describes: "Move one door from its current rep to another",
    requestCapability: "lead.reassign",
    approveCapability: "lead.assign",
    // Single-door reassignment is ordinary floor work. The gate exists here so
    // the action is JOURNALED and reversible, not to slow it down.
    floor: "auto",
    defaultMode: "auto",
    reversibility: "reversible",
    maxUndoWindowMinutes: 24 * 60,
    magnitudeUnit: "door",
    defaultApprovalAboveMagnitude: null,
  },
  "lead.bulk_assign": {
    kind: "lead.bulk_assign",
    label: "Bulk assign doors",
    describes: "Move a selection of doors to one rep in a single action",
    requestCapability: "lead.assign",
    approveCapability: "lead.reassign",
    floor: "auto",
    defaultMode: "auto",
    reversibility: "reversible",
    maxUndoWindowMinutes: 24 * 60,
    magnitudeUnit: "doors",
    // The number that separates "a street" from "somebody's whole book". A
    // lasso of 200 doors is a normal territory move; 200 is where a second
    // person should look before a rep's pipeline changes hands.
    defaultApprovalAboveMagnitude: 200,
  },
  "recovery.case.assign": {
    kind: "recovery.case.assign",
    label: "Assign a recovery case",
    describes: "Hand a stalled order's case to a different rep",
    requestCapability: "recovery.manage",
    approveCapability: "recovery.manage",
    floor: "auto",
    defaultMode: "auto",
    reversibility: "reversible",
    maxUndoWindowMinutes: 24 * 60,
    magnitudeUnit: "case",
    defaultApprovalAboveMagnitude: null,
  },
  "contact.suppression.lift": {
    kind: "contact.suppression.lift",
    label: "Lift a contact suppression",
    describes: "Allow contact with someone who previously asked us to stop",
    requestCapability: "contact.suppression.manage",
    approveCapability: "contact.suppression.manage",
    // The one kind whose floor is not `auto`. Somebody replied STOP; undoing
    // that decision on their behalf is never routine, so no organization may
    // configure it down to a single click. The floor is the point of the layer.
    floor: "approval",
    defaultMode: "approval",
    // Re-inserting the suppression row restores the STATE, and restores nothing
    // else: between the lift and the re-add, a message may already have reached
    // a person who asked not to be reached. There is no undo for that, so this
    // kind is never offered one.
    reversibility: "irreversible",
    maxUndoWindowMinutes: 0,
    magnitudeUnit: "contact",
    defaultApprovalAboveMagnitude: null,
  },
};

export function guardedActionSpec(kind: GuardedActionKind): GuardedActionSpec {
  return GUARDED_ACTIONS[kind];
}

// ── States ───────────────────────────────────────────────────────────────────
//
//   pending  -> approved -> executed -> undone
//      |           |           |
//      |           |           +-> (stays executed; undo is optional)
//      |           +-> failed          (approved, execution threw)
//      +-> rejected
//      +-> expired                     (nobody decided in time)
//
// `executed` and `failed` are terminal for the request. `undone` is terminal for
// the effect. A rejected or expired action never touched the database.

export const GUARDED_ACTION_STATES = [
  "pending", "approved", "rejected", "expired", "executed", "failed", "undone",
] as const;
export type GuardedActionState = (typeof GUARDED_ACTION_STATES)[number];

/** States in which the action never reached the database. Used by the UI to
 *  decide whether to show an effect summary at all. */
export function hadEffect(state: GuardedActionState): boolean {
  return state === "executed" || state === "undone";
}

// ── Policy ───────────────────────────────────────────────────────────────────

export interface GatePolicy {
  kind: GuardedActionKind;
  mode: GateMode;
  /** Above this magnitude, an `auto` kind still needs approval. null disables
   *  the magnitude rule. Meaningless when mode is already approval or deny, and
   *  ignored there rather than erroring - an admin who tightens the mode should
   *  not have to also clear the threshold. */
  approvalAboveMagnitude: number | null;
  /** May the requester approve their own pending action? Off by default,
   *  because an approval queue one person can clear alone is a log, not a
   *  control. */
  selfApproval: boolean;
  /** Minutes an executed action stays reversible. Clamped to the kind's ceiling
   *  and forced to 0 for irreversible kinds. */
  undoWindowMinutes: number;
  /** Minutes a pending action waits before it expires unactioned. A pending
   *  action that lives forever is a decision nobody ever has to make. */
  pendingExpiryMinutes: number;
}

export const MAX_PENDING_EXPIRY_MINUTES = 30 * 24 * 60;

export function defaultPolicy(kind: GuardedActionKind): GatePolicy {
  const spec = GUARDED_ACTIONS[kind];
  return {
    kind,
    mode: spec.defaultMode,
    approvalAboveMagnitude: spec.defaultApprovalAboveMagnitude,
    selfApproval: false,
    undoWindowMinutes: spec.reversibility === "reversible" ? Math.min(60, spec.maxUndoWindowMinutes) : 0,
    pendingExpiryMinutes: 3 * 24 * 60,
  };
}

/**
 * Force a stored or submitted policy back inside the catalogue's rules.
 *
 * Called on every read as well as every write, deliberately. A row written
 * before a kind's floor was tightened must not keep running under the old,
 * looser rule just because it is already in the database - the floor is a
 * property of the code, and the code is what is deployed.
 */
export function clampPolicy(input: GatePolicy): GatePolicy {
  const spec = GUARDED_ACTIONS[input.kind];
  const undoCeiling = spec.reversibility === "reversible" ? spec.maxUndoWindowMinutes : 0;
  const threshold = input.approvalAboveMagnitude;
  return {
    kind: input.kind,
    mode: atLeast(input.mode, spec.floor),
    approvalAboveMagnitude:
      threshold == null || !Number.isFinite(threshold) || threshold < 1 ? null : Math.floor(threshold),
    selfApproval: input.selfApproval === true,
    undoWindowMinutes: Math.max(0, Math.min(Math.floor(input.undoWindowMinutes || 0), undoCeiling)),
    pendingExpiryMinutes: Math.max(
      5,
      Math.min(Math.floor(input.pendingExpiryMinutes || 0) || 5, MAX_PENDING_EXPIRY_MINUTES),
    ),
  };
}

// ── The decision ─────────────────────────────────────────────────────────────

export interface GateRequest {
  /** How much this action moves. Rows, doors, cases. Always >= 1. */
  magnitude: number;
}

export type GateVerdict =
  | { outcome: "execute"; reason: string }
  | { outcome: "approval"; reason: string }
  | { outcome: "deny"; reason: string };

/**
 * The whole rulebook, in one pure function.
 *
 * Returns the REASON as well as the outcome because the reason is what the UI
 * shows the requester before they commit and what the audit row records after.
 * A gate that says no without saying why trains people to route around it.
 */
export function decideGate(
  kind: GuardedActionKind,
  policy: GatePolicy,
  request: GateRequest,
): GateVerdict {
  const spec = GUARDED_ACTIONS[kind];
  const effective = clampPolicy(policy);
  const magnitude = Number.isFinite(request.magnitude) ? Math.max(1, Math.floor(request.magnitude)) : 1;

  if (effective.mode === "deny") {
    return { outcome: "deny", reason: `${spec.label} is turned off for this organization.` };
  }
  if (effective.mode === "approval") {
    // Distinguish a floor from a choice. An approver reading the queue should
    // know whether their organization opted into this or whether the action is
    // one that always waits.
    const reason = spec.floor === "approval"
      ? `${spec.label} always needs a second approver.`
      : `This organization requires approval for ${spec.label.toLowerCase()}.`;
    return { outcome: "approval", reason };
  }

  const threshold = effective.approvalAboveMagnitude;
  if (threshold != null && magnitude > threshold) {
    return {
      outcome: "approval",
      reason: `${magnitude} ${spec.magnitudeUnit} is over the ${threshold} ${spec.magnitudeUnit} limit for automatic approval.`,
    };
  }
  return { outcome: "execute", reason: "Within this organization's automatic limits." };
}

/**
 * Whether an executed action is still reversible right now.
 *
 * Three ways to be past it, and they are different answers to a user: the kind
 * never offered undo, the organization set the window to zero, or the window
 * ran out. The caller renders the difference.
 */
export type UndoAvailability =
  | { available: true; deadline: string }
  | { available: false; because: "irreversible" | "disabled" | "expired" | "already_undone" | "no_inverse" };

export function undoAvailability(input: {
  kind: GuardedActionKind;
  state: GuardedActionState;
  executedAt: string | null;
  undoWindowMinutes: number;
  hasInverse: boolean;
  now?: Date;
}): UndoAvailability {
  const spec = GUARDED_ACTIONS[input.kind];
  if (spec.reversibility === "irreversible") return { available: false, because: "irreversible" };
  if (input.state === "undone") return { available: false, because: "already_undone" };
  if (input.state !== "executed" || !input.executedAt) return { available: false, because: "expired" };
  if (!input.hasInverse) return { available: false, because: "no_inverse" };

  const window = Math.min(input.undoWindowMinutes, spec.maxUndoWindowMinutes);
  if (window <= 0) return { available: false, because: "disabled" };

  const executed = Date.parse(input.executedAt);
  if (!Number.isFinite(executed)) return { available: false, because: "expired" };
  const deadline = executed + window * 60_000;
  const now = (input.now ?? new Date()).getTime();
  return now <= deadline
    ? { available: true, deadline: new Date(deadline).toISOString() }
    : { available: false, because: "expired" };
}

/** Why an undo is unavailable, in words an operator can act on. */
export function undoUnavailableReason(because: Exclude<UndoAvailability, { available: true }>["because"]): string {
  switch (because) {
    case "irreversible":
      return "This action cannot be undone. It was gated before it ran for exactly that reason.";
    case "disabled":
      return "This organization does not keep an undo window for this action.";
    case "expired":
      return "The undo window for this action has closed.";
    case "already_undone":
      return "This action has already been reversed.";
    case "no_inverse":
      return "No reversal was recorded for this action, so it cannot be undone safely.";
  }
}
