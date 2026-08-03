// ── HR / compliance checkpoint store ──────────────────────────────────────────
// Persistence for the post-approval compliance gates. One row per
// (application, kind); listHrCheckpoints() MATERIALISES the full set so a
// never-touched gate reads as "not_started" without a row having to exist.
// setHrCheckpoint() is an idempotent upsert keyed by the UNIQUE(application_id,
// kind) index created in runMigrations().
import { rawDb } from "./db";
import {
  HR_CHECKPOINT_KINDS_ORDERED,
  HR_CHECKPOINT_META,
  isHrCheckpointCleared,
  isHrCheckpointFailed,
  type HrCheckpointKind,
  type HrCheckpointStatus,
} from "../shared/onboardingHr";

export interface HrCheckpoint {
  kind: HrCheckpointKind;
  status: HrCheckpointStatus;
  provider: string | null;
  externalRef: string | null;
  badgePhotoPath: string | null;
  hasBadgePhoto: boolean;
  notes: string | null;
  cleared: boolean;
  failed: boolean;
  orderedAt: string | null;
  completedAt: string | null;
  updatedAt: string | null;
}

export interface HrSummary {
  cleared: number;
  total: number;
  allClear: boolean;
  anyFailed: boolean;
}

interface HrRow {
  kind: string;
  status: string;
  provider: string | null;
  external_ref: string | null;
  badge_photo_path: string | null;
  notes: string | null;
  ordered_at: string | null;
  completed_at: string | null;
  updated_at: string | null;
}

function rowToCheckpoint(kind: HrCheckpointKind, row: HrRow | undefined): HrCheckpoint {
  const status = (row?.status ?? "not_started") as HrCheckpointStatus;
  const badgePhotoPath = row?.badge_photo_path ?? null;
  return {
    kind,
    status,
    provider: row?.provider ?? null,
    externalRef: row?.external_ref ?? null,
    badgePhotoPath,
    hasBadgePhoto: Boolean(badgePhotoPath),
    notes: row?.notes ?? null,
    cleared: isHrCheckpointCleared(kind, status),
    failed: isHrCheckpointFailed(kind, status),
    orderedAt: row?.ordered_at ?? null,
    completedAt: row?.completed_at ?? null,
    updatedAt: row?.updated_at ?? null,
  };
}

/** The full, ordered checkpoint set for an application — materialised. */
export function listHrCheckpoints(tenantId: number, applicationId: number): HrCheckpoint[] {
  const rows = rawDb
    .prepare("SELECT * FROM rep_hr_checkpoints WHERE tenant_id IS ? AND application_id = ?")
    .all(tenantId, applicationId) as HrRow[];
  const byKind = new Map<string, HrRow>();
  for (const row of rows) byKind.set(row.kind, row);
  return HR_CHECKPOINT_KINDS_ORDERED.map(kind => rowToCheckpoint(kind, byKind.get(kind)));
}

export function summariseHr(checkpoints: HrCheckpoint[]): HrSummary {
  const required = checkpoints.filter(c => HR_CHECKPOINT_META[c.kind].required);
  const cleared = required.filter(c => c.cleared).length;
  return {
    cleared,
    total: required.length,
    allClear: required.length > 0 && cleared === required.length,
    anyFailed: checkpoints.some(c => c.failed),
  };
}

export function hrSummary(tenantId: number, applicationId: number): HrSummary {
  return summariseHr(listHrCheckpoints(tenantId, applicationId));
}

export interface SetHrCheckpointInput {
  status?: HrCheckpointStatus;
  provider?: string | null;
  externalRef?: string | null;
  badgePhotoPath?: string | null;
  notes?: string | null;
  repId?: number | null;
  updatedBy?: number | null;
}

const nowIso = () => new Date().toISOString();

/**
 * Idempotent upsert of one gate. Stamps ordered_at the first time a gate moves
 * off "not_started", and completed_at whenever it lands in a cleared/failed
 * terminal state (cleared back to null if it moves out of terminal again).
 */
export function setHrCheckpoint(
  tenantId: number,
  applicationId: number,
  kind: HrCheckpointKind,
  patch: SetHrCheckpointInput,
): HrCheckpoint {
  const existing = rawDb
    .prepare("SELECT * FROM rep_hr_checkpoints WHERE application_id = ? AND kind = ?")
    .get(applicationId, kind) as (HrRow & { id: number; ordered_at: string | null }) | undefined;

  const status = (patch.status ?? existing?.status ?? "not_started") as HrCheckpointStatus;
  const terminal = isHrCheckpointCleared(kind, status) || isHrCheckpointFailed(kind, status);
  const orderedAt = existing?.ordered_at ?? (status !== "not_started" ? nowIso() : null);
  const completedAt = terminal ? (existing?.completed_at ?? nowIso()) : null;

  // Only overwrite optional columns the caller actually supplied (undefined =
  // leave as-is); an explicit null clears the column.
  const provider = patch.provider !== undefined ? patch.provider : existing?.provider ?? null;
  const externalRef = patch.externalRef !== undefined ? patch.externalRef : existing?.external_ref ?? null;
  const badgePhotoPath = patch.badgePhotoPath !== undefined ? patch.badgePhotoPath : existing?.badge_photo_path ?? null;
  const notes = patch.notes !== undefined ? patch.notes : existing?.notes ?? null;

  if (existing) {
    rawDb
      .prepare(
        `UPDATE rep_hr_checkpoints
            SET tenant_id = COALESCE(tenant_id, ?), rep_id = COALESCE(?, rep_id),
                status = ?, provider = ?, external_ref = ?, badge_photo_path = ?, notes = ?,
                updated_by = COALESCE(?, updated_by), ordered_at = ?, completed_at = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(
        tenantId, patch.repId ?? null, status, provider, externalRef, badgePhotoPath, notes,
        patch.updatedBy ?? null, orderedAt, completedAt, nowIso(), existing.id,
      );
  } else {
    rawDb
      .prepare(
        `INSERT INTO rep_hr_checkpoints
           (tenant_id, application_id, rep_id, kind, status, provider, external_ref, badge_photo_path, notes, updated_by, ordered_at, completed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        tenantId, applicationId, patch.repId ?? null, kind, status, provider, externalRef, badgePhotoPath, notes,
        patch.updatedBy ?? null, orderedAt, completedAt, nowIso(), nowIso(),
      );
  }

  const row = rawDb
    .prepare("SELECT * FROM rep_hr_checkpoints WHERE application_id = ? AND kind = ?")
    .get(applicationId, kind) as HrRow;
  return rowToCheckpoint(kind, row);
}

export function getHrCheckpoint(applicationId: number, kind: HrCheckpointKind): HrCheckpoint {
  const row = rawDb
    .prepare("SELECT * FROM rep_hr_checkpoints WHERE application_id = ? AND kind = ?")
    .get(applicationId, kind) as HrRow | undefined;
  return rowToCheckpoint(kind, row);
}
