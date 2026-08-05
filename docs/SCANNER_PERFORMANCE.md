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
- The token cohort is capped at 100 tokens and 100 unique normalized address
  hashes per token lifecycle, for 10,000 checks of simultaneous batch capacity.

## Synthetic two-minute load result

The test first distributes 10,000 unique synthetic address hashes over 100
tokens. It then compresses one minute to six seconds, submits 200 unique
addresses plus 50 simultaneous duplicate callers, and forces token slots through
an early refresh boundary.

| Metric | Result |
| --- | ---: |
| Configured aggregate quota | 100/minute |
| Token cohort | 100 tokens |
| Unique checks per token | exactly 100 |
| Cohort checks distributed | 10,000 |
| Cohort distribution time | 209 ms |
| Unique provider checks | 200 |
| Total callers | 250 |
| Duplicate provider requests | 0 |
| Lost jobs | 0 |
| Maximum starts in a rolling minute | 98 |
| Equivalent steady throughput | 97.3/minute |
| Maximum concurrent token refreshes | 2 |
| Quota violations | 0 |

The small difference between the configured ceiling and measured throughput is
intentional safety margin, not an application scan cap. Users may continuously
enqueue work; the shared queue preserves it and drains at the permissioned
aggregate rate. Live throughput can be lower when provider latency, `Retry-After`,
transport capacity, or a provider denial requires backoff.

## Verification coverage

- Actual token expiry parsing and refresh 60 seconds early.
- EMPTY, READY, REFRESHING, and EXPIRED lifecycle states. There is no cooldown
  or disabled state: a failed slot returns to EMPTY and is re-minted on demand.
- Pool snapshots carry lifecycle and metrics only — never token material, since
  `GET /api/token-status` serves one to every authenticated caller.
- Least-loaded round-robin token leasing.
- Per-token health, in-flight count, checks-used, and checks-remaining metrics.
- Exact 10,000-address distribution with a hard over-capacity rejection.
- Per-slot single-flight and pool-wide refresh-storm protection.
- Cross-instance concurrency and rolling-minute enforcement.
- Manual/lasso priority over Coming Soon and city work.
- Cross-instance address coalescing and conclusive-result caching.
- Three refresh attempts on 401, preserved work on 429, and global halt on 403.
- Clean-database schema initialization in CI.
