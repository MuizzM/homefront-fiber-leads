export const SUSPICIOUS_SHIFT_MINUTES = 16 * 60;

export function isSuspiciousShiftDuration(minutes: number | null | undefined): boolean {
  return Number.isFinite(minutes) && Number(minutes) > SUSPICIOUS_SHIFT_MINUTES;
}

export function elapsedShiftMinutes(startTime: string, nowMs = Date.now()): number {
  const startedAt = Date.parse(startTime);
  if (!Number.isFinite(startedAt)) return 0;
  return Math.max(0, Math.floor((nowMs - startedAt) / 60_000));
}
