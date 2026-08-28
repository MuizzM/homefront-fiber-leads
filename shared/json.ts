// ── JSON value contract ──────────────────────────────────────────────────────
// The honest type for data that crossed a JSON boundary: exactly what
// JSON.parse can produce and JSON.stringify can round-trip. Server modules that
// wrap JSON.parse in a try/catch (audit payloads, guarded-action payloads,
// provider payloads) return this instead of `unknown`, so a caller knows the
// value is plain data — no functions, no class instances, no undefined — while
// still being forced to narrow before poking at its insides.
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
