# Performance budgets: foundation policy

Hard gates currently protect behavior: tenant isolation, exact result/query-plan
compatibility, bounded queue writes, deadlines, migration safety and full tests.
The new index-definition check prevents conflicting literal DDL. Do not convert
three or five warm production samples into p95/p99 promises.

| Flow | Current evidence | Next measurable budget work |
| --- | --- | --- |
| Code request / verification | Released nonblocking contention fix; ~138ms median across three external synthetic requests | Separate browser response, server DB work and real code-delivery time; cold/warm, first/retry, degraded network and writer contention. |
| Dashboard / fresh/map reads | Indexed fixture and small live measurements in previous report | Named tenant row tiers, filter selectivity, concurrency and actual payload distributions. |
| UI | Lazy routes, bounded viewport feeds and virtual list already exist | Record initial/route/chunk compressed bytes, LCP/INP/error rates on named devices; calibrate before CI thresholds. |
| Jobs / DB | Fixed limits, role ownership, contention tests and prior multiprocess soak | Lag/throughput/retry/fairness under representative workload; writer-hold and event-loop distributions by process role. |
| New foundation queries | 200k-row synthetic query/index/retention harness | Review index build/storage and write overhead on production-sized snapshot before deployment. |

For each future hard threshold record scenario, fixture seed, runtime/host,
warmup, sample count, source revision, metric, permitted variance and responsible
owner. Compare before/after under the same conditions. Gate deterministic result,
plan, resource/accounting invariants immediately; report timing distributions
until runner noise and representative targets are established.

`npx tsx script/benchmark-saas-foundations.ts` is local-only and never imports
the application database/provider stack. [Evidence](foundation-baseline.md).
Reproducible versions of the older large benchmarks and safe browser CI are
separate [backlog](../upgrade-board.md) items. Production observability and load
work need an explicit workload and cost envelope.
