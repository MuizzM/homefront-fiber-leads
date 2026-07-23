// One place for the "is this row visible to this tenant?" rule, so the ~35
// hand-written `if (!row || (tid && row.tenantId !== tid))` walls stop drifting
// apart. Encodes the two nuances once:
//   • super_admin / internal callers have tid == null → they see everything.
//   • a row with a NULL tenant_id is legacy/system-adopted (see
//     bootstrapDefaultTenant) → allowed, matching the existing idiom's `tid &&`.
// Pair with the tenant-aware getById overloads (storage) so new routes are
// cross-tenant-safe by default instead of relying on remembering this check.
export function sameTenant(
  row: { tenantId?: number | null } | null | undefined,
  tid: number | null | undefined,
): boolean {
  if (!row) return false;
  if (tid == null) return true;                 // super_admin / internal → all tenants
  return row.tenantId == null || row.tenantId === tid;
}
