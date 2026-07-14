# Kinetic scanner performance profile

Measured July 14, 2026 with `npm run scanner:load-test`. The harness creates an
isolated temporary SQLite database and never calls Kinetic, Decodo, a bearer
token endpoint, or a resident address.

## Production admission policy

- `SCAN_PROVIDER_REQUESTS_PER_MINUTE=100` is one aggregate rolling-minute
  ceiling across every application instance, token, scan type, and proxy
  connection.
- A distributed cadence smooths starts while the rolling-window ledger remains
  authoritative. A 3% boundary guard absorbs scheduler-to-fetch timing jitter,
  keeping observed outbound starts at or below 100.
- `SCAN_GLOBAL_CONCURRENCY` independently caps simultaneous searches at 50.
- Priority is manual, lasso, Coming Soon, recheck/market, then city.
- Identical normalized addresses share a distributed lock and cached result.
- Token refresh is single-flight per slot and capped at two simultaneous
  refreshes across the entire in-process pool.

## Synthetic two-minute load result

The test compresses one minute to six seconds, submits 200 unique addresses plus
50 simultaneous duplicate callers, and forces token slots through an early
refresh boundary.

| Metric | Result |
| --- | ---: |
| Configured aggregate quota | 100/minute |
| Unique provider checks | 200 |
| Total callers | 250 |
| Duplicate provider requests | 0 |
| Lost jobs | 0 |
| Maximum starts in a rolling minute | 98 |
| Equivalent steady throughput | 97.4/minute |
| Maximum concurrent token refreshes | 2 |
| Quota violations | 0 |

The small difference between the configured ceiling and measured throughput is
intentional safety margin, not an application scan cap. Users may continuously
enqueue work; the shared queue preserves it and drains at the permissioned
aggregate rate. Live throughput can be lower when provider latency, `Retry-After`,
transport capacity, or a provider denial requires backoff.

## Verification coverage

- Actual token expiry parsing and refresh 60 seconds early.
- READY, REFRESHING, COOLDOWN, EXPIRED, DISABLED, and EMPTY lifecycle states.
- Least-loaded round-robin token leasing.
- Per-slot single-flight and pool-wide refresh-storm protection.
- Cross-instance concurrency and rolling-minute enforcement.
- Manual/lasso priority over Coming Soon and city work.
- Cross-instance address coalescing and conclusive-result caching.
- Three refresh attempts on 401, preserved work on 429, and global halt on 403.
- Clean-database schema initialization in CI.
