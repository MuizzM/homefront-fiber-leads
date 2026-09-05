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
// TODO: verify usage: SCANNER_SUBMIT_SECRET is still documented but has no active
// verifier in this tree. Keep redacting legacy credentials until it is retired.
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
  /pk\.eyJ[A-Za-z0-9._-]{20,}/g, // Mapbox public tokens - served via /api/config/map only
];

// Cheap pre-filter markers: EVERY pattern in SECRET_TEXT_PATTERNS requires one
// of these substrings to match at all - "eyJ" (raw JWT, `Bearer eyJ…`, and the
// `pk.eyJ…` Mapbox token all contain it), "Basic " (HTTP Basic), or "gokinetic"
// (the upstream host/URL, case-insensitive). A string containing none of them
// cannot match any pattern, so the 6-regex pass is pure waste on it. Keep this
// list in lockstep with SECRET_TEXT_PATTERNS above.
const SECRET_MARKERS: readonly string[] = ["eyJ", "Basic "];

/** Redact every known secret shape from one free-text value. Never throws. */
export function scrubSecretText<T extends string | null | undefined>(value: T): T {
  if (typeof value !== "string" || value.length === 0) return value;
  // Fast path for the overwhelming majority of response strings (addresses,
  // names, statuses, notes): if no secret marker is present, NO pattern can
  // match, so skip the six /g regexes entirely. This is the same result the
  // full pass would produce - never weaker - at a fraction of the CPU, which
  // matters because the global response sanitizer runs this on every string of
  // every non-exempt response on the single Node thread (e.g. a 500-row lead
  // list is tens of thousands of strings). The `gokinetic` check is a
  // case-insensitive regex only reached when the two cheap includes() miss.
  if (!SECRET_MARKERS.some((m) => value.includes(m)) && !/gokinetic/i.test(value)) {
    return value;
  }
  let out: string = value;
  for (const re of SECRET_TEXT_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, "[redacted]");
  }
  return out as T;
}
