// ── Secret scrub (shared redaction vocabulary) ────────────────────────────────
// The global response sanitizer in server/index.ts owns ONE list of "what must
// never reach a browser". That sanitizer is process-wide middleware, so it only
// protects responses served by the real entrypoint — a route that is mounted
// directly (tests, embedded harnesses, a future sub-app) gets no cover from it.
//
// The patterns therefore live HERE, not inline in index.ts, so a route that
// hands untrusted upstream text to a lower-privilege audience (e.g. the
// run-scoped scan stage feed reps can read) can apply the SAME vocabulary at
// the point of projection instead of re-inventing a second, drifting copy.
// index.ts imports these; nothing here imports index.ts (that would boot a
// second server).

/** Object keys that must never be serialized into an API response. */
export const BLOCKED_RESPONSE_FIELDS: ReadonlySet<string> = new Set([
  "passwordHash", "password_hash", "password", "tempPassword",
  "stack", "trace", "errno", "syscall",
  "KFS_AUTH_BASIC", "SCANNER_SUBMIT_SECRET", "SMTP_PASS",
  "RESEND_API_KEY",
  "kfsAuthBasic", "scannerSecret", "mapboxToken", "enrichmentApiKey",
]);

/**
 * Substrings that must be redacted wherever they appear inside a string value:
 * the upstream provider's host/URL, HTTP Basic/Bearer credentials, raw JWTs and
 * Mapbox tokens. All are /g, so callers MUST reset lastIndex before reuse (see
 * scrubSecretText) — a shared /g regex is stateful across calls.
 */
export const SECRET_TEXT_PATTERNS: readonly RegExp[] = [
  /https?:\/\/[^\s"']*gokinetic[^\s"']*/gi,
  /gokinetic\.com/gi,
  /Basic [A-Za-z0-9+/=]{20,}/g,
  /Bearer eyJ[A-Za-z0-9._-]{20,}/g,
  /eyJ[A-Za-z0-9._-]{40,}/g,
  /pk\.eyJ[A-Za-z0-9._-]{20,}/g, // Mapbox public tokens — served via /api/config/map only
];

/** Redact every known secret shape from one free-text value. Never throws. */
export function scrubSecretText<T extends string | null | undefined>(value: T): T {
  if (typeof value !== "string" || value.length === 0) return value;
  let out: string = value;
  for (const re of SECRET_TEXT_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, "[redacted]");
  }
  return out as T;
}
