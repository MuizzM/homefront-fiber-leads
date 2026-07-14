# Kinetic scanner performance profile

Measured July 14, 2026 on the local development machine. This benchmark isolates
application scheduler capacity; it does not call Kinetic and is not an upstream
quota or production-throughput claim.

Workload: 1,000 unique synthetic address checks, each with 10 ms simulated
provider latency and no result-cache hits.

| Scheduler | Concurrency | Elapsed | Scheduler throughput |
| --- | ---: | ---: | ---: |
| Previous FIFO default | 8 | 1,412 ms | 708 checks/s |
| Priority queue ceiling | 100 | 113 ms | 8,858 checks/s |

The isolated scheduler speedup was 12.51x. Production request starts are still
bounded by `SCAN_PROVIDER_RPS` (default 40), so sustainable live throughput is:

`min(SCAN_PROVIDER_RPS, SCAN_GLOBAL_CONCURRENCY / average_provider_latency_seconds)`

The strict rolling-window test verifies that all priorities combined stay below
the configured RPS ceiling. Manual and lasso work can move ahead of queued city,
market, and recheck work, but priority never bypasses the aggregate limit.

Verification coverage:

- 50 simultaneous distributed provider slots across app instances.
- One aggregate rolling RPS ceiling.
- Manual > lasso > Coming Soon/recheck > market > city priority.
- In-flight address coalescing and queued-priority upgrades.
- Conclusive-result cache with defensive clones.
- Three token refreshes on repeated 401 responses.
- Global queue pause and work preservation on 429 `Retry-After`.
- Global stop and alert state on 403.
- Existing cross-verification and one-lead idempotency gate.

## Distributed coordinator load profile

The current database queue, global semaphore, address lock, and result-cache
code was exercised with 200 unique checks per level and 60 ms simulated provider
latency. This test makes no external provider calls and uses no bearer tokens.

| Concurrency | Elapsed | Checks/s | End-to-end p95 | Failures | 429 rate | Proxy capacity |
| ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 10 | 2,530 ms | 79.1 | 2,343 ms | 0 | 0% | within |
| 25 | 1,934 ms | 103.4 | 1,819 ms | 0 | 0% | within |
| 40 | 2,193 ms | 91.2 | 1,925 ms | 0 | 0% | within |
| 50 | 2,047 ms | 97.7 | 1,845 ms | 0 | 0% | within |

With a 50-connection proxy pool and the acceptance threshold of p95 below two
seconds, no failures, and no more than 1% 429s, concurrency 50 was selected.
Live provider throughput remains bounded by `SCAN_PROVIDER_RPS` (default 40)
until a contract-authorized live profile is run in the deployment environment.
