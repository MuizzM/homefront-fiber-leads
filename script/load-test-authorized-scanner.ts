import { rawDb } from "../server/db";
import { DistributedProviderCoordinator } from "../server/distributedProviderCoordinator";

const levels = [10, 25, 40, 50];
const checks = bounded(process.env.LOAD_TEST_CHECKS, 50, 5_000, 200);
const providerLatencyMs = bounded(process.env.LOAD_TEST_PROVIDER_LATENCY_MS, 5, 10_000, 60);
const maxP95Ms = bounded(process.env.LOAD_TEST_MAX_P95_MS, 50, 60_000, 2_000);
const proxyConnections = bounded(process.env.PROXY_POOL_CONNECTIONS, 1, 100, 50);
const proxyPipelining = bounded(process.env.PROXY_PIPELINING, 1, 2, 1);
const proxyCapacity = proxyConnections * proxyPipelining;

interface Result {
  concurrency: number;
  elapsedMs: number;
  checksPerSecond: number;
  p95Ms: number;
  failures: number;
  rate429: number;
  peakProviderConcurrency: number;
  withinProxyCapacity: boolean;
}

const results: Result[] = [];
for (const level of levels) {
  rawDb.exec(`DELETE FROM provider_rate_events; DELETE FROM provider_admission_queue;
    DELETE FROM provider_address_locks; DELETE FROM provider_shared_result_cache;
    UPDATE provider_global_control SET halted=0,halt_reason=NULL,paused_until=NULL WHERE id=1;`);
  const coordinator = new DistributedProviderCoordinator<{ ok: true }>({
    maxConcurrency: level,
    maxRequestsPerSecond: 10_000,
    resultCacheTtlMs: 0,
  });
  let active = 0, peak = 0, failures = 0, rate429 = 0;
  const latencies: number[] = [];
  const suiteStarted = performance.now();
  await Promise.all(Array.from({ length: checks }, async (_, index) => {
    const started = performance.now();
    try {
      await coordinator.execute(`load-${level}-${index}`, index % 10 === 0 ? "manual" : "city", async () => {
        active++; peak = Math.max(peak, active);
        try {
          const jitter = (index * 17) % Math.max(1, Math.floor(providerLatencyMs / 2));
          await new Promise(resolve => setTimeout(resolve, providerLatencyMs + jitter));
          return { ok: true as const };
        } finally { active--; }
      }, { cacheable: () => false, serialize: JSON.stringify, deserialize: JSON.parse });
    } catch (error: any) {
      failures++;
      if (String(error?.message ?? error).includes("429")) rate429++;
    } finally { latencies.push(performance.now() - started); }
  }));
  const elapsedMs = performance.now() - suiteStarted;
  latencies.sort((a, b) => a - b);
  results.push({
    concurrency: level,
    elapsedMs: Math.round(elapsedMs),
    checksPerSecond: Number((checks / (elapsedMs / 1_000)).toFixed(1)),
    p95Ms: Math.round(latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * 0.95) - 1)] ?? 0),
    failures,
    rate429: checks ? Number((rate429 / checks).toFixed(4)) : 0,
    peakProviderConcurrency: peak,
    withinProxyCapacity: level <= proxyCapacity,
  });
}

const sustainable = results.filter(result =>
  result.failures === 0 && result.rate429 <= 0.01 && result.p95Ms <= maxP95Ms && result.withinProxyCapacity);
console.log(JSON.stringify({
  mode: "local-coordinator-load-test",
  note: "No external provider calls or bearer tokens are used by this test.",
  checksPerLevel: checks,
  simulatedProviderLatencyMs: providerLatencyMs,
  proxyCapacity,
  maxAcceptedP95Ms: maxP95Ms,
  results,
  selectedConcurrency: sustainable.at(-1)?.concurrency ?? null,
}, null, 2));

function bounded(value: string | undefined, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.floor(parsed))) : fallback;
}
