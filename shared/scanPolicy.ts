// ── scanPolicy — one place for the pool re-probe economics ────────────────────
// A pooled address that Kinetic keeps returning INCONCLUSIVE (no availability
// signal — typically a Mapbox-grid over-capture that isn't in Kinetic's address
// catalog, or a deterministic AddressNeedsFix) costs a real proxy probe every time
// it's re-checked and yields nothing. Left alone it stays `last_scanned_at IS NULL`
// forever, so the nightly re-scan and every manual sweep re-probe it in perpetuity.
//
// After this many inconclusive probes with NO conclusive answer in between, the row
// is "exhausted" and drops OUT of the never-scanned re-probe rotation. It stays
// distinguishable from a genuine Kinetic answer (last_scanned_at is still NULL, not
// stamped) and can be re-opened deliberately (a manual --retry-exhausted run, or a
// conclusive answer that resets the counter). This is a per-address circuit breaker,
// the item-level twin of the scheduler's run-level hard-backoff breaker.
//
// Kept deliberately small: a genuinely transient failure (a one-off timeout/5xx)
// almost never recurs 3 separate runs in a row on the same address, so the breaker
// only trips on the deterministic "Kinetic doesn't know this address" case.
export const INCONCLUSIVE_GIVEUP = 3;
