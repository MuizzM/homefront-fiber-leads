/** Legacy in-memory jobs need the same tenant wall as durable run queries. */
export function canReadTenantJob(user: { tenantId?: number | null; isSuperAdmin?: number }, job: { tenantId?: number | null } | undefined): boolean {
  return !!job && (user.isSuperAdmin === 1 || (Number.isSafeInteger(user.tenantId)
    && Number(user.tenantId) > 0 && user.tenantId === job.tenantId));
}
