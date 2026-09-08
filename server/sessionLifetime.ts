// Default idle/absolute windows preserve a rep's existing offline workday.
const ttlHours = Math.min(720, Math.max(24, Number(process.env.SESSION_TTL_HOURS) || 24 * 7));
export const SESSION_TTL_MS = ttlHours * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_MAX_MS = Math.max(SESSION_TTL_MS,
  Math.min(365, Math.max(1, Number(process.env.SESSION_ABSOLUTE_MAX_DAYS) || 30)) * 24 * 60 * 60 * 1000);

/** Old rows use SQLite datetime('now'), which is UTC despite having no suffix.
 * Interpret only the two formats we persist, never the host's local timezone. */
export function sessionTimestamp(value: string): number {
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/.test(value)) {
    return Date.parse(`${value.replace(' ', 'T')}Z`);
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return Date.parse(value);
  return NaN;
}

export function sessionWithinLifetime(session: { createdAt: string; expiresAt: string }, now = Date.now()): boolean {
  const created = sessionTimestamp(session.createdAt);
  const expires = sessionTimestamp(session.expiresAt);
  return Number.isFinite(created) && Number.isFinite(expires)
    && created <= now && expires > now && created + SESSION_ABSOLUTE_MAX_MS > now;
}
