import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Never benchmark against the developer or production database. DATA_DIR must
// be set before importing the database-backed coordinator.
const explicitDataDir = process.env.LOAD_TEST_DATA_DIR?.trim();
const loadTestDataDir = explicitDataDir
  ? path.resolve(explicitDataDir)
  : fs.mkdtempSync(path.join(os.tmpdir(), "homefront-scanner-load-"));
fs.mkdirSync(loadTestDataDir, { recursive: true });
process.env.DATA_DIR = loadTestDataDir;

const [{ rawDb }, { AuthorizedTokenPool }, coordinatorModule] = await Promise.all([
  import("../server/db"),
  import("../server/authorizedTokenPool"),
  import("../server/distributedProviderCoordinator"),
]);
const { DistributedProviderCoordinator, ensureSchema } = coordinatorModule;

const quotaPerMinute = 100;
const simulatedMinuteMs = bounded(process.env.LOAD_TEST_RATE_WINDOW_MS, 250, 60_000, 6_000);
const uniqueChecks = bounded(process.env.LOAD_TEST_CHECKS, 101, 5_000, 200);
const duplicateCalls = bounded(process.env.LOAD_TEST_DUPLICATES, 1, uniqueChecks, 50);
const providerLatencyMs = bounded(process.env.LOAD_TEST_PROVIDER_LATENCY_MS, 1, 10_000, 8);
// The production pool intentionally clamps the early-refresh margin to at least
// one second. Keep synthetic tokens valid beyond that margin while making them
// refresh-due during the compressed multi-minute run.
const refreshMarginMs = 1_000;
const tokenLifetimeMs = simulatedMinuteMs + refreshMarginMs + 25;

ensureSchema();
rawDb.exec(`DELETE FROM provider_rate_events; DELETE FROM provider_admission_queue;
  DELETE FROM provider_address_locks; DELETE FROM provider_shared_result_cache;
  UPDATE provider_global_control SET halted=0,halt_reason=NULL,paused_until=NULL,next_start_at=0 WHERE id=1;`);

// Capacity phase: 100 anonymous token slots × 100 distinct addresses each.
let distributionActiveMints = 0;
let distributionPeakMints = 0;
let distributionMintedTokens = 0;
const distributionPool = new AuthorizedTokenPool({
  maxSize: 100,
  warmMinimum: 100,
  maxChecksPerToken: 100,
  maxLeasesPerToken: 1_000,
  maxConcurrentRefreshes: 2,
  refreshMarginMs: 1_000,
  mint: async slotId => {
    distributionActiveMints++;
    distributionPeakMints = Math.max(distributionPeakMints, distributionActiveMints);
    await delay(1);
    distributionActiveMints--;
    distributionMintedTokens++;
    return {
      token: `distribution-token-${slotId}`,
      expiresAt: Date.now() + 60_000,
    };
  },
});
const distributionCounts = Array.from({ length: 100 }, () => 0);
const distributionStarted = performance.now();
await Promise.all(Array.from({ length: 10_000 }, async (_, index) => {
  const lease = await distributionPool.lease(`unique-address-${index}`);
  distributionCounts[lease.slotId]++;
  lease.release();
}));
const distributionSnapshot = distributionPool.snapshot();
let capacityRejected = false;
try {
  await distributionPool.lease("unique-address-over-capacity");
} catch (error) {
  capacityRejected = String((error as Error).message).includes("BATCH_CAPACITY_EXHAUSTED");
}
const distributionElapsedMs = Math.round(performance.now() - distributionStarted);
distributionPool.stop();

let activeMints = 0;
let peakMints = 0;
let mintedTokens = 0;
const tokenPool = new AuthorizedTokenPool({
  maxSize: 20,
  warmMinimum: 4,
  refreshMarginMs,
  maxLeasesPerToken: 10,
  maxConcurrentRefreshes: 2,
  maxChecksPerToken: 100,
  maintenanceIntervalMs: 1_000,
  mint: async slotId => {
    activeMints++;
    peakMints = Math.max(peakMints, activeMints);
    await delay(2);
    activeMints--;
    mintedTokens++;
    return {
      token: `load-test-token-${slotId}-${mintedTokens}`,
      expiresAt: Date.now() + tokenLifetimeMs,
    };
  },
});

const coordinator = new DistributedProviderCoordinator<{ key: string }>({
  maxConcurrency: 50,
  maxRequestsPerMinute: quotaPerMinute,
  resultCacheTtlMs: simulatedMinuteMs * 3,
  rateWindowMs: simulatedMinuteMs,
  pollMs: 10,
});

const keys = Array.from({ length: uniqueChecks }, (_, index) => `load-${index}`);
const calls = [
  ...keys.map((key, index) => ({ key, source: index % 10 === 0 ? "manual" as const : "city" as const })),
  ...keys.slice(0, duplicateCalls).map(key => ({ key, source: "lasso" as const })),
];
let providerCalls = 0;
let activeSearches = 0;
let peakSearches = 0;
const providerStarts: number[] = [];
const latencies: number[] = [];
const suiteStarted = performance.now();

await Promise.all(calls.map(async ({ key, source }) => {
  const started = performance.now();
  await coordinator.execute(key, source, async () => {
    providerCalls++;
    providerStarts.push(Date.now());
    activeSearches++;
    peakSearches = Math.max(peakSearches, activeSearches);
    const lease = await tokenPool.lease(key);
    try {
      await delay(providerLatencyMs);
      return { key };
    } finally {
      lease.release();
      activeSearches--;
    }
  }, {
    cacheable: () => true,
    serialize: JSON.stringify,
    deserialize: value => JSON.parse(value) as { key: string },
  });
  latencies.push(performance.now() - started);
}));

tokenPool.stop();
latencies.sort((a, b) => a - b);
const maxStartsInWindow = maximumStartsInWindow(providerStarts, simulatedMinuteMs);
const elapsedMs = Math.round(performance.now() - suiteStarted);
const equivalentChecksPerMinute = Number((providerCalls / (elapsedMs / simulatedMinuteMs)).toFixed(1));
const assertions = {
  distributedAllTenThousand: distributionSnapshot.checksUsed === 10_000,
  exactlyOneHundredPerToken: distributionCounts.every(count => count === 100),
  capacityEnforced: capacityRejected,
  noQuotaViolations: maxStartsInWindow <= quotaPerMinute,
  sustainedAtLeast95Percent: maxStartsInWindow >= quotaPerMinute * 0.95,
  noDuplicateProviderRequests: providerCalls === uniqueChecks,
  noLostJobs: calls.length === uniqueChecks + duplicateCalls,
  noRefreshStorm: peakMints <= 2 && distributionPeakMints <= 2,
  poolRedacted: tokenPool.snapshot().states.DISABLED > 0,
};

console.log(JSON.stringify({
  mode: "local-authorized-scanner-load-test",
  note: "No external provider, proxy, bearer token, or resident address is used. The rolling minute is time-compressed for deterministic CI execution.",
  configuredQuotaPerMinute: quotaPerMinute,
  simulatedMinuteMs,
  tokenCapacity: {
    configuredTokens: 100,
    checksPerToken: 100,
    uniqueAddresses: distributionSnapshot.checksUsed,
    minimumPerToken: Math.min(...distributionCounts),
    maximumPerToken: Math.max(...distributionCounts),
    elapsedMs: distributionElapsedMs,
    mintedTokens: distributionMintedTokens,
    peakConcurrentRefreshes: distributionPeakMints,
    capacityRejected,
  },
  uniqueChecks,
  totalCallers: calls.length,
  duplicateCalls,
  providerCalls,
  deduplicatedCalls: calls.length - providerCalls,
  elapsedMs,
  p95Ms: percentile(latencies, 0.95),
  peakSearches,
  maxStartsInRollingWindow: maxStartsInWindow,
  equivalentChecksPerMinute,
  mintedTokens,
  peakConcurrentTokenRefreshes: peakMints,
  assertions,
}, null, 2));

const failed = Object.values(assertions).some(value => !value);
rawDb.close();
if (!explicitDataDir) fs.rmSync(loadTestDataDir, { recursive: true, force: true });
if (failed) process.exitCode = 1;

function maximumStartsInWindow(starts: number[], windowMs: number): number {
  const sorted = [...starts].sort((a, b) => a - b);
  let left = 0, maximum = 0;
  for (let right = 0; right < sorted.length; right++) {
    while (sorted[left] <= sorted[right] - windowMs) left++;
    maximum = Math.max(maximum, right - left + 1);
  }
  return maximum;
}

function percentile(values: number[], ratio: number): number {
  if (!values.length) return 0;
  return Math.round(values[Math.min(values.length - 1, Math.ceil(values.length * ratio) - 1)]);
}

function bounded(value: string | undefined, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.floor(parsed))) : fallback;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
