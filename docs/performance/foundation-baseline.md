# Foundation evidence — 2026-09-08

Baseline source `e64583d`; foundation branch `codex/saas-upgrade-foundations`.
Release state: local implementation under review, not production deployed.

## Reproduction and changes

The new queue-boundary suite reproduced 21 failures against baseline (plus one
passing capability denial): foreign actions succeeded, cached/null ownership
leaked, audit could fail after state mutation, and organization views were global.
The targeted old outbox tests reproduced both tenant retention failures. After
fixes, 83 focused tests across five files pass, including existing financial
ordering/retry/reconciliation coverage, two-tenant ownership, atomic audit failure,
retryable 503, a held writer longer than one second, partial cleanup and repeated
migration. The final full gate passed 7,973 tests across 648 files, both compilers, build, index check and deployment/harness controls. Local Docker Compose configuration validation was unavailable; the safety script reported that skip. No unresolved blocking review findings remain.

Run `npx tsx script/benchmark-saas-foundations.ts` from a clean dependency install.
This harness creates only in-memory synthetic SQLite tables, imports no app DB
or provider transport, and compares the same tenant query results before/after
adding the two indexes. It also invokes the actual retention helper and checks
its accounting and yield bounds. It is a scenario benchmark, not a production
load test; baseline schemas model the relevant existing indexes, not every
application table/trigger.

## Query sample

200,000 rows per table, two tenants, three warmups and 25 samples per query.
The same query and values run before and after. Runs are sequential, warm and
in-memory; no universal speed ratio or production percentile is claimed.

| Query | Before median | After median |
| --- | ---: | ---: |
| tenantAlertCount | 11.4057 ms | 0.0016 ms |
| tenantAlertCutoff | 13.4624 ms | 0.0011 ms |
| tenantEventBacklog | 3.3267 ms | 0.0016 ms |

All query results match. Index construction took 82.13 ms and
added 5,320,704 SQLite page bytes in this fixture; ongoing inserts and
status transitions incur index-maintenance cost. Disk-backed production builds
can be much slower and must be included in a release window.

The actual retention helper superseded 197,900 excess rows across 396 batches,
kept all 100 quiet-tenant alerts plus the busy tenant's newest 2,000, and made
zero changes on repeat. Maximum writes between yields: 500. Elapsed cleanup:
700.20 ms. This validates the new contract rather than
claiming total cleanup is faster than the old unfair global cutoff. The old
maximum mutation was 10,000 rows per batch; smaller batches trade total overhead
for shorter uninterrupted work.

[Raw aggregate results](2026-09-08-foundation-indexes.json) include plans,
percentiles, runtime and limits. [Budget policy](budgets.md) distinguishes hard
correctness/resource gates from future calibrated latency/SLO thresholds.
No email, provider, production data or live infrastructure was exercised.
