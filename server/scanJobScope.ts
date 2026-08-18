export type ScanJobScopeActor = {
  tenantId?: number | null;
  role?: string | null;
  isSuperAdmin?: boolean | number | null;
};

/**
 * Tenant wall for process-local scan jobs.
 *
 * Normal leadership users need an explicit organization match. A missing
 * tenant is never interpreted as platform-wide access: only an identity with
 * explicit super-admin authority may inspect a job from another organization.
 */
export function canReadScanJob(
  actor: ScanJobScopeActor | null | undefined,
  job: { tenantId?: number | null } | null | undefined,
): boolean {
  if (!actor || !job) return false;
  if (actor.isSuperAdmin === true || actor.isSuperAdmin === 1) return true;
  const actorTenantId = actor.tenantId ?? null;
  const jobTenantId = job.tenantId ?? null;
  return actorTenantId != null && jobTenantId != null && actorTenantId === jobTenantId;
}
