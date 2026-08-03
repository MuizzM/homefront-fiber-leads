// ── HR / compliance checkpoints ───────────────────────────────────────────────
// The post-approval compliance gates a rep clears BEFORE their field profile is
// trusted for payroll: background check → drug screen → badge photo → confirmed
// in Gusto. This mirrors the linear document-signing pipeline (see
// shared/onboardingDocuments.ts) but is ORTHOGONAL to it — the two run in
// parallel after an application is approved, and both feed the same console.
//
// One source of truth: the server validates status transitions against this
// table and the client renders its selects/badges from it, so a drifted copy
// can never let the UI offer a status the server rejects.

export const HR_CHECKPOINT_KINDS = [
  "background_check",
  "drug_screen",
  "badge_photo",
  "gusto",
] as const;

export type HrCheckpointKind = (typeof HR_CHECKPOINT_KINDS)[number];

export type HrCheckpointStatus =
  | "not_started"
  | "ordered"
  | "pending"
  | "passed"
  | "failed"
  | "uploaded"
  | "approved"
  | "confirmed"
  | "na";

export interface HrCheckpointMeta {
  kind: HrCheckpointKind;
  label: string;
  description: string;
  order: number;
  required: boolean;
  /** Statuses a manager may set from the console for this kind. */
  statuses: readonly HrCheckpointStatus[];
  /** Terminal-good — counts toward "HR cleared". */
  clearedStatuses: readonly HrCheckpointStatus[];
  /** Terminal-bad — blocks the rep and flags the record. */
  failedStatuses: readonly HrCheckpointStatus[];
}

export const HR_CHECKPOINT_META: Record<HrCheckpointKind, HrCheckpointMeta> = {
  background_check: {
    kind: "background_check",
    label: "Background check",
    description: "Criminal / MVR screen ordered through the vendor.",
    order: 1,
    required: true,
    statuses: ["not_started", "ordered", "pending", "passed", "failed", "na"],
    clearedStatuses: ["passed", "na"],
    failedStatuses: ["failed"],
  },
  drug_screen: {
    kind: "drug_screen",
    label: "Drug screen",
    description: "Panel test completed at the collection site.",
    order: 2,
    required: true,
    statuses: ["not_started", "ordered", "pending", "passed", "failed", "na"],
    clearedStatuses: ["passed", "na"],
    failedStatuses: ["failed"],
  },
  badge_photo: {
    kind: "badge_photo",
    label: "Badge photo",
    description: "Field ID photo captured and approved for printing.",
    order: 3,
    required: true,
    statuses: ["not_started", "uploaded", "approved", "na"],
    clearedStatuses: ["approved", "na"],
    failedStatuses: [],
  },
  gusto: {
    kind: "gusto",
    label: "Confirmed in Gusto",
    description: "Employee record created and confirmed in payroll.",
    order: 4,
    required: true,
    statuses: ["not_started", "pending", "confirmed", "na"],
    clearedStatuses: ["confirmed", "na"],
    failedStatuses: [],
  },
};

export const HR_CHECKPOINT_KINDS_ORDERED: HrCheckpointKind[] = [...HR_CHECKPOINT_KINDS]
  .sort((a, b) => HR_CHECKPOINT_META[a].order - HR_CHECKPOINT_META[b].order);

export function isHrCheckpointKind(value: unknown): value is HrCheckpointKind {
  return typeof value === "string" && (HR_CHECKPOINT_KINDS as readonly string[]).includes(value);
}

export function isValidHrStatus(kind: HrCheckpointKind, status: unknown): status is HrCheckpointStatus {
  return typeof status === "string" && HR_CHECKPOINT_META[kind].statuses.includes(status as HrCheckpointStatus);
}

export function isHrCheckpointCleared(kind: HrCheckpointKind, status: HrCheckpointStatus): boolean {
  return HR_CHECKPOINT_META[kind].clearedStatuses.includes(status);
}

export function isHrCheckpointFailed(kind: HrCheckpointKind, status: HrCheckpointStatus): boolean {
  return HR_CHECKPOINT_META[kind].failedStatuses.includes(status);
}

/** Human label for a status pill — shared so server + client never drift. */
export function hrStatusLabel(status: HrCheckpointStatus): string {
  switch (status) {
    case "not_started": return "Not started";
    case "ordered": return "Ordered";
    case "pending": return "Pending";
    case "passed": return "Passed";
    case "failed": return "Failed";
    case "uploaded": return "Uploaded";
    case "approved": return "Approved";
    case "confirmed": return "Confirmed";
    case "na": return "N/A";
  }
}
