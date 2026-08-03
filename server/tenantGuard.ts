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

// ── WRITE rule (stricter than the read idiom above) ──────────────────────────
// The read idiom lets every tenant SEE a NULL-tenant (legacy/system-adopted)
// row. Writes are different: a NULL-tenant row was adopted by the DEFAULT
// tenant at bootstrap (see bootstrapDefaultTenant), so mutating it is a
// default-org operation — only an ADMIN of the default tenant (or a
// super_admin) may write it. Every other tenant's users get the wall, and
// non-admin roles never inherit write rights over adopted rows.
// Rows that DO carry a tenant follow the same strict equality as the read
// idiom's `tid &&` branch.
export function sameTenantWrite(
  row: { tenantId?: number | null } | null | undefined,
  user: { tenantId?: number | null; role?: string | null } | null | undefined,
  defaultTenantId: number | null,
): boolean {
  if (!row) return false;
  if (user?.role === "super_admin") return true; // apex support access
  const tid = user?.tenantId ?? null;
  if (tid == null) return false;                 // writes need an org context
  if (row.tenantId != null) return row.tenantId === tid;
  return user?.role === "admin" && defaultTenantId != null && tid === defaultTenantId;
}

// READ companion for routes that fetch a row by id without a storage-level
// tenant filter: a NULL-tenant row reads as owned by the DEFAULT tenant —
// invisible to every other tenant, same wall shape as the sameTenant idiom.
export function sameTenantRead(
  row: { tenantId?: number | null } | null | undefined,
  tid: number | null | undefined,
  defaultTenantId: number | null,
): boolean {
  if (!row) return false;
  if (tid == null) return true;                  // super_admin / internal → all tenants
  const effective = row.tenantId ?? defaultTenantId;
  return effective != null && effective === tid;
}
