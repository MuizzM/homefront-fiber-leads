// ── Tenant pay policy + install-confirmation writes ───────────────────────────
// The persistence half of the install-gated commission hold (pure math lives in
// shared/commissionHold.ts). Kept in its own store so the feature's name never
// references a dead design; nothing here knows about routes or PDFs.

import { rawDb } from "./db";
import {
  DEFAULT_PAY_POLICY,
  clampHoldDays,
  type PayPolicyShape,
} from "@shared/commissionHold";

export function getTenantPayPolicy(tenantId: number): PayPolicyShape & { updatedAt: string | null } {
  const row = rawDb.prepare(
    `SELECT require_install_confirm AS requireInstallConfirm, hold_days AS holdDays, updated_at AS updatedAt
       FROM tenant_pay_policy WHERE tenant_id = ?`,
  ).get(tenantId) as any;
  if (!row) return { ...DEFAULT_PAY_POLICY, updatedAt: null };
  return {
    requireInstallConfirm: Number(row.requireInstallConfirm) === 1,
    holdDays: clampHoldDays(row.holdDays),
    updatedAt: row.updatedAt ?? null,
  };
}

export function upsertTenantPayPolicy(tenantId: number, patch: { requireInstallConfirm?: boolean; holdDays?: number }): PayPolicyShape & { updatedAt: string | null } {
  const current = getTenantPayPolicy(tenantId);
  const next = {
    requireInstallConfirm: patch.requireInstallConfirm ?? current.requireInstallConfirm,
    holdDays: patch.holdDays != null ? clampHoldDays(patch.holdDays) : current.holdDays,
  };
  rawDb.prepare(
    `INSERT INTO tenant_pay_policy (tenant_id, require_install_confirm, hold_days, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(tenant_id) DO UPDATE SET
       require_install_confirm = excluded.require_install_confirm,
       hold_days = excluded.hold_days,
       updated_at = excluded.updated_at`,
  ).run(tenantId, next.requireInstallConfirm ? 1 : 0, next.holdDays, new Date().toISOString());
  return getTenantPayPolicy(tenantId);
}

/** Manager confirms the install: stamps install_confirmed_at = now and
 *  payable_after = now + holdDays. Idempotent — an already-confirmed row is
 *  returned unchanged so a replay can never push the hold window out. */
export function confirmCommissionInstall(input: {
  id: number;
  tenantId: number;
  holdDays: number;
  confirmedAt: string;
  payableAfter: string;
}): { kind: "confirmed" | "already" | "not_found"; commission?: any } {
  const existing = rawDb.prepare(
    `SELECT * FROM commissions WHERE id = ? AND tenant_id = ?`,
  ).get(input.id, input.tenantId) as any;
  if (!existing) return { kind: "not_found" };
  if (existing.install_confirmed_at) return { kind: "already", commission: existing };
  rawDb.prepare(
    `UPDATE commissions SET install_confirmed_at = ?, payable_after = ? WHERE id = ? AND tenant_id = ?`,
  ).run(input.confirmedAt, input.payableAfter, input.id, input.tenantId);
  return {
    kind: "confirmed",
    commission: rawDb.prepare(`SELECT * FROM commissions WHERE id = ? AND tenant_id = ?`).get(input.id, input.tenantId),
  };
}
