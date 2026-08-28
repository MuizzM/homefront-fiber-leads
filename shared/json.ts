// ── JSON value contract ──────────────────────────────────────────────────────
// The honest type for data that crossed a JSON boundary: exactly what
// JSON.parse can produce and JSON.stringify can round-trip. Server modules that
// wrap JSON.parse in a try/catch (audit payloads, guarded-action payloads,
// provider payloads) return this instead of `unknown`, so a caller knows the
// value is plain data — no functions, no class instances, no undefined — while
// still being forced to narrow before poking at its insides.
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

// NOT ADDED: a `JsonRecord = Record<string, JsonValue | undefined>` for
// storage.logActivity's `details?: object`. It was tried and backed out. The
// weakness is real - `object` accepts a Map or a class instance, which
// JSON.stringify renders as `{}`, silently losing an audit record - but the
// fix does not typecheck: TypeScript gives implicit index signatures to type
// ALIASES and not to INTERFACES, so 35 call sites passing perfectly
// serializable named interfaces (ClampRecord, MilestoneRung, GeoConfig,
// EvidenceIngestSummary...) were rejected. Making them pass would mean 35
// assertions, which is worse than the loose parameter it set out to tighten.
// Left as a known gap rather than laundered.
