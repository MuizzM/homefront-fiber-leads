export const LEGACY_COMMISSION_STATUSES = [
  "pending",
  "approved",
  "paid",
  "disputed",
] as const;

export type LegacyCommissionStatus = typeof LEGACY_COMMISSION_STATUSES[number];

export interface LegacyCommissionSnapshot {
  status: string;
  paidDate: string | null;
  notes: string | null;
  approvedBy: number | null;
}

export interface LegacyCommissionTransitionCommand {
  expectedStatus: LegacyCommissionStatus;
  status: LegacyCommissionStatus;
  paidDate?: string;
  notes?: string | null;
}

export type LegacyCommissionLifecycleErrorCode =
  | "STALE_VERSION"
  | "INVALID_CURRENT_STATUS"
  | "ILLEGAL_TRANSITION"
  | "PAID_DATE_REQUIRED"
  | "INVALID_PAID_DATE"
  | "PAID_DATE_FORBIDDEN"
  | "PAID_TERMINAL";

export type LegacyCommissionTransitionPlan =
  | {
      ok: true;
      changed: boolean;
      next: {
        status: LegacyCommissionStatus;
        paidDate: string | null;
        notes: string | null;
        approvedBy: number | null;
      };
      changedFields: Array<"status" | "paidDate" | "notes" | "approvedBy">;
    }
  | {
      ok: false;
      code: LegacyCommissionLifecycleErrorCode;
      message: string;
    };

const LEGAL_TRANSITIONS: Record<LegacyCommissionStatus, ReadonlySet<LegacyCommissionStatus>> = {
  pending: new Set(["pending", "approved", "disputed"]),
  approved: new Set(["approved", "paid", "disputed"]),
  disputed: new Set(["disputed", "pending", "approved"]),
  paid: new Set(["paid"]),
};

export function isLegacyCommissionStatus(value: string): value is LegacyCommissionStatus {
  return (LEGACY_COMMISSION_STATUSES as readonly string[]).includes(value);
}

export function isStrictIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

/**
 * Canonical policy for the legacy dollar-denominated commission ledger.
 *
 * This function is pure: it validates optimistic-concurrency state, enforces
 * legal lifecycle movement, and derives all server-owned coherence fields.
 * Persistence and the mandatory audit record are committed together by the
 * storage command.
 */
export function planLegacyCommissionTransition(
  current: LegacyCommissionSnapshot,
  command: LegacyCommissionTransitionCommand,
  actorUserId: number,
): LegacyCommissionTransitionPlan {
  if (!isLegacyCommissionStatus(current.status)) {
    return {
      ok: false,
      code: "INVALID_CURRENT_STATUS",
      message: "Commission has an unsupported persisted status",
    };
  }
  if (current.status !== command.expectedStatus) {
    return {
      ok: false,
      code: "STALE_VERSION",
      message: "Commission status changed since it was loaded",
    };
  }
  if (!LEGAL_TRANSITIONS[current.status].has(command.status)) {
    return {
      ok: false,
      code: "ILLEGAL_TRANSITION",
      message: `Cannot move a commission from ${current.status} to ${command.status}`,
    };
  }

  if (command.status === "paid") {
    if (!command.paidDate) {
      return { ok: false, code: "PAID_DATE_REQUIRED", message: "Paid commissions require a paid date" };
    }
    if (!isStrictIsoDate(command.paidDate)) {
      return { ok: false, code: "INVALID_PAID_DATE", message: "Paid date must be a real YYYY-MM-DD date" };
    }
  } else if (command.paidDate !== undefined) {
    return { ok: false, code: "PAID_DATE_FORBIDDEN", message: "Only paid commissions may carry a paid date" };
  }

  // Paid is terminal. An exact retry is idempotent, but a same-state request
  // cannot use that allowance to rewrite the paid date, notes, or approver.
  if (current.status === "paid") {
    const notesMatch = command.notes === undefined || command.notes === current.notes;
    if (command.paidDate !== current.paidDate || !notesMatch) {
      return { ok: false, code: "PAID_TERMINAL", message: "Paid commissions are immutable" };
    }
    return {
      ok: true,
      changed: false,
      next: {
        status: "paid",
        paidDate: current.paidDate,
        notes: current.notes,
        approvedBy: current.approvedBy,
      },
      changedFields: [],
    };
  }

  const next = {
    status: command.status,
    paidDate: command.status === "paid" ? command.paidDate! : null,
    notes: command.notes === undefined ? current.notes : command.notes,
    approvedBy: deriveApprovedBy(current, command.status, actorUserId),
  };
  const changedFields: Array<"status" | "paidDate" | "notes" | "approvedBy"> = [];
  if (next.status !== current.status) changedFields.push("status");
  if (next.paidDate !== current.paidDate) changedFields.push("paidDate");
  if (next.notes !== current.notes) changedFields.push("notes");
  if (next.approvedBy !== current.approvedBy) changedFields.push("approvedBy");
  return { ok: true, changed: changedFields.length > 0, next, changedFields };
}

function deriveApprovedBy(
  current: LegacyCommissionSnapshot,
  nextStatus: LegacyCommissionStatus,
  actorUserId: number,
): number | null {
  if (nextStatus === "approved") {
    return current.status === "approved" ? current.approvedBy ?? actorUserId : actorUserId;
  }
  if (nextStatus === "paid") return current.approvedBy ?? actorUserId;
  return null;
}
