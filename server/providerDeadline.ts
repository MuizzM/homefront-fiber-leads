/** Shared bounded budgets for local/distributed admission and token waiting. */
export function providerAdmissionWaitMs(value = Number(process.env.PROVIDER_ADMISSION_MAX_WAIT_MS ?? 120_000)): number {
  return Number.isFinite(value) ? Math.min(600_000, Math.max(100, Math.floor(value))) : 120_000;
}
export function providerTaskWaitMs(): number {
  const value = Number(process.env.PROVIDER_TASK_MAX_MS ?? 180_000);
  return Number.isFinite(value) ? Math.min(600_000, Math.max(60_000, Math.floor(value))) : 180_000;
}
export function providerAborted(abort?: () => boolean): boolean {
  try { return abort?.() ?? false; } catch { return true; }
}
