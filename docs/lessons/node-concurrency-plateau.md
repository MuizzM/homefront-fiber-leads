# More parallelism ≠ more throughput on a single Node thread — find the plateau.
At 100 concurrent checks (each doing synchronous better-sqlite3 work), per-check latency
inflated ~10x to ~30s, throughput plateaued, and the HTTP server starved completely
(health 20s timeouts, reps locked out). Tuning to 64 global / 32 batch INCREASED
throughput (683→728 searches/5m) while health answered in 0.2s. SQLite is single-writer
and provider RTT dominates — parallelism past the plateau buys queueing latency, not
work. Concurrency knobs: SCAN_GLOBAL_CONCURRENCY / SCAN_BATCH_CONCURRENCY (compose env,
and .claude/launch.json for dev). This is capacity tuning, not rate limiting: measure
searches/5m before and after; if throughput drops, raise the knob.
