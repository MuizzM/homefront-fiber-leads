import crypto from "node:crypto";
import { getDefaultTenantId, storage } from "./storage";
import { sendMailResilient, mailFrom, adminInbox } from "./mail";
import { rawDb } from "./db";
import { scanBlockReason } from "./billingStore";
import * as scanService from "./scanService";
import { dueMarkets, freshPoints, listMarkets, seedStateMarkets, syncMarketState } from "./stateMonitorStore";
import { getCityAddresses } from "./overpass";
import { clusterFreshFiber } from "@shared/freshFiberClusters";
import { structuredLog } from "./structuredLog";
import { pollAnnouncementsIfDue } from "./announcementWatcher";
import { refreshKineticLocationDirectory } from "./kineticMarketCatalog";

interface MonitorStatus {
  enabled: boolean;
  liveSpendEnabled: boolean;
  running: boolean;
  lastTickAt: string | null;
  lastResult: string;
  nextTickAt: string | null;
  currentRunId: string | null;
  pendingAlerts: number;
}

const status: MonitorStatus = {
  enabled: false, liveSpendEnabled: false, running: false, lastTickAt: null,
  lastResult: "not started", nextTickAt: null, currentRunId: null, pendingAlerts: 0,
};
let timer: NodeJS.Timeout | null = null;
let tickSequence = 0;
let catalogInitialized = false;

// ── Alert-outbox runaway guards (2026-07-19 incident) ─────────────────────────
// The fresh_fiber outbox grew to 1.25M+ pending rows (alert generation outran mail
// capacity for days), and draining it against the mail provider's dead quota
// ("550 10 req/sec" / "550 daily quota") spun the single JS thread hard enough to
// starve /api — the portal-down wedge. Three guards make that impossible again:
//   1. ENQUEUE CAP — never let pending grow past OUTBOX_PENDING_CAP; newest-first
//      alerts matter, a million stale ones don't.
//   2. DELIVERY CIRCUIT BREAKER — after OUTBOX_BREAKER_THRESHOLD consecutive send
//      failures, stop draining for OUTBOX_BREAKER_PAUSE_MS (quota exhaustion isn't
//      going to clear in the next 30s; retrying is pure CPU + log burn).
//   3. BOOT JANITOR (pruneAlertOutboxBacklog) — chunked, yielding sweep that
//      supersedes all but the newest OUTBOX_PENDING_CAP pending rows.
const OUTBOX_PENDING_CAP = Math.max(100, Number(process.env.OUTBOX_PENDING_CAP ?? 2_000) || 2_000);
const OUTBOX_BREAKER_THRESHOLD = Math.max(3, Number(process.env.OUTBOX_BREAKER_THRESHOLD ?? 10) || 10);
const OUTBOX_BREAKER_PAUSE_MS = Math.max(60_000, Number(process.env.OUTBOX_BREAKER_PAUSE_MS ?? 6 * 60 * 60_000) || 6 * 60 * 60_000);
let outboxFailStreak = 0;
let outboxPausedUntil = 0;

// The cluster's ONE outbox writer/drainer. HF_ROLE is set only by the cluster
// primary on fork ("control" for worker 0, "scan" otherwise); single-process
// deployments never set it → control. Draining from every worker would give each
// its own circuit-breaker budget (N× the intended failure burn) and race the
// janitor mid-prune.
const IS_OUTBOX_CONTROL = process.env.HF_ROLE ? process.env.HF_ROLE === "control" : true;

/** Supersede all but the newest `keep` pending fresh_fiber outbox rows, in bounded
 *  chunks with an event-loop yield between each so a million-row backlog can never
 *  block /api. Skips rows a live drain currently holds leased (their delivery
 *  outcome must win); retries a chunk through transient SQLITE_BUSY so one
 *  contended write can't kill the one-shot boot prune. Idempotent. */
export async function pruneAlertOutboxBacklog(keep = OUTBOX_PENDING_CAP): Promise<number> {
  const cutoff = rawDb.prepare(`SELECT id FROM notification_outbox WHERE kind='fresh_fiber' AND status='pending'
    ORDER BY id DESC LIMIT 1 OFFSET ?`).get(keep) as any;
  if (!cutoff?.id) return 0;
  const chunk = rawDb.prepare(`UPDATE notification_outbox SET status='superseded', last_error='outbox backlog pruned', lease_owner=NULL, lease_expires_at=NULL
    WHERE id IN (SELECT id FROM notification_outbox WHERE kind='fresh_fiber' AND status='pending' AND id<=?
      AND (lease_expires_at IS NULL OR lease_expires_at<=datetime('now')) LIMIT 10000)`);
  let total = 0;
  for (;;) {
    let changed = -1;
    for (let attempt = 0; attempt < 4; attempt++) {
      try { changed = chunk.run(cutoff.id).changes; break; }
      catch (e: any) {
        if (attempt === 3 || !/busy|locked/i.test(String(e?.message))) throw e;
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
    total += Math.max(0, changed);
    if (changed < 10000) break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  if (total > 0) structuredLog("state_monitor.outbox_pruned", { superseded: total, kept: keep });
  return total;
}

function positiveInt(name: string, fallback: number, max: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.min(max, Math.floor(n)) : fallback;
}

export function getStateMonitorStatus() { return { ...status }; }

/**
 * Queue and attempt delivery immediately after an operator sweep completes.
 * The outbox remains authoritative: when email/webhook delivery is not
 * configured, the deduplicated alert stays pending for a later scheduler tick.
 */
export async function flushFreshOpportunityAlerts(tenantId: number) {
  const queued = enqueueFreshAlerts(tenantId);
  const delivered = await drainFreshAlerts(tenantId);
  return { queued, delivered };
}

export async function runStateMonitorTick(options: { allowSpend?: boolean } = {}) {
  if (status.running) throw new Error("STATE_MONITOR_BUSY");
  status.running = true;
  status.lastTickAt = new Date().toISOString();
  try {
    const seeded = catalogInitialized
      ? { total: 0, insertedOrUpdated: 0, verifiedMarkets: (listMarkets({ eligibility: "verified", limit: 2_000 }) as any[]).length, expandingMarkets: 0, syntheticMarkets: 0 }
      : seedStateMarkets();
    catalogInitialized = true;
    syncMarketState();
    let announcementWatch: any = { status: "disabled", discovered: 0, prioritized: 0 };
    try { announcementWatch = await pollAnnouncementsIfDue(); }
    catch (error: any) { announcementWatch = { status: "failed", error: error.message }; }
    let directoryWatch: any = { status: "disabled", seen: 0, added: 0 };
    // On by default (unlimited budget posture); set ENABLE_KINETIC_DIRECTORY_WATCH=off to disable.
    if (process.env.ENABLE_KINETIC_DIRECTORY_WATCH !== "off") {
      try { directoryWatch = await refreshKineticLocationDirectory(false); }
      catch (error: any) { directoryWatch = { status: "failed", error: error.message }; }
    }
    const tenantId = getDefaultTenantId() ?? 1;
    const alerts = enqueueFreshAlerts(tenantId);
    const delivered = await drainFreshAlerts(tenantId);
    tickSequence++;
    const inventoryEvery = positiveInt("STATE_MONITOR_INVENTORY_EVERY_TICKS", 1, 168);
    const inventoryEnabled = process.env.ENABLE_STATE_ADDRESS_HARVEST !== "off"; // on by default
    const shouldHarvest = inventoryEnabled && tickSequence % inventoryEvery === 0;
    let inventoryHarvested: { city: string; state: string; addresses: number; inserted: number } | null = null;
    if (shouldHarvest) {
      inventoryHarvested = await harvestNextMarketInventory();
      if (inventoryHarvested) {
        syncMarketState();
      }
    }
    const allowSpend = options.allowSpend === true && process.env.ENABLE_STATE_MONITORING !== "off" && process.env.STATE_MONITOR_LIVE !== "off"; // live spend on by default
    if (!allowSpend) {
      status.lastResult = `${inventoryHarvested ? `harvested ${inventoryHarvested.addresses} addresses for ${inventoryHarvested.city}; ` : ""}inventory synced; ${alerts} alerts queued, ${delivered} delivered; live scans disabled`;
      return { seeded, announcementWatch, directoryWatch, alertsQueued: alerts, alertsDelivered: delivered, inventoryHarvested, scanStarted: null, liveSpendEnabled: false };
    }
    const billingBlock = scanBlockReason(tenantId);
    if (billingBlock) throw new Error(`STATE_MONITOR_BILLING_BLOCKED: ${billingBlock.message}`);
    // Wait only on the monitor's OWN in-flight run. Waiting on ANY running run made
    // this permanently idle — the continuous statewide sweep means some run is ALWAYS
    // running, so cadence market scans never fired. The weighted-fair admission
    // coordinator already arbitrates capacity between the monitor and other runs.
    const active = scanService.getRuns(tenantId).find((r: any) => (r.status === "running" || r.active) && String(r.kind ?? "").startsWith("state-monitor"));
    if (active) {
      status.currentRunId = active.id;
      status.lastResult = `waiting for active state-monitor scan ${active.id}`;
      return { seeded, alertsQueued: alerts, alertsDelivered: delivered, inventoryHarvested, scanStarted: null, activeRunId: active.id };
    }
    const dailyLimit = positiveInt("STATE_MONITOR_DAILY_CHECK_BUDGET", 1_000_000, 10_000_000); // effectively unlimited (~200x observed daily throughput)
    const marketLimit = positiveInt("STATE_MONITOR_MARKET_BUDGET", 10_000, 100_000); // unlimited-budget default (was 250/market)
    const spent = (rawDb.prepare(`SELECT COALESCE(SUM(budget),0) AS n FROM scan_runs WHERE kind='state-monitor' AND started_at >= date('now')`).get() as any).n as number;
    const remaining = Math.max(0, dailyLimit - spent);
    if (!remaining) {
      status.lastResult = `daily check budget exhausted (${spent}/${dailyLimit})`;
      return { seeded, alertsQueued: alerts, alertsDelivered: delivered, inventoryHarvested, scanStarted: null, budget: { spent, dailyLimit, remaining } };
    }
    const market = dueMarkets(25)[0] as any;
    if (!market) {
      if (inventoryEnabled && !inventoryHarvested) {
        const harvested = await harvestNextMarketInventory();
        if (harvested) {
          syncMarketState();
          status.lastResult = `harvested ${harvested.addresses} OSM addresses for ${harvested.city}, ${harvested.state}`;
          return { seeded, alertsQueued: alerts, alertsDelivered: delivered, inventoryHarvested: harvested, scanStarted: null };
        }
      }
      status.lastResult = "no due market with harvested address inventory";
      return { seeded, alertsQueued: alerts, alertsDelivered: delivered, inventoryHarvested, scanStarted: null, inventoryPending: true };
    }
    const budget = Math.min(remaining, marketLimit, Number(market.address_count));
    const run = scanService.startMarketRun({
      tenantId, city: market.city, state: market.state, budget, rescan: true,
      runKind: "state-monitor", label: `State monitor · ${market.city}, ${market.state}`,
    });
    status.currentRunId = run.runId;
    status.lastResult = `started ${run.runId}: ${run.queued} checks in ${market.city}, ${market.state}`;
    structuredLog("state_monitor.scan_started", { runId: run.runId, city: market.city, state: market.state, checks: run.queued, dailyRemaining: remaining - run.queued });
    return { seeded, alertsQueued: alerts, alertsDelivered: delivered, inventoryHarvested, scanStarted: run, budget: { spent, dailyLimit, remaining: remaining - run.queued } };
  } catch (error: any) {
    status.lastResult = `failed loudly: ${error.message}`;
    structuredLog("state_monitor.failed", { error: error.message });
    throw error;
  } finally {
    status.pendingAlerts = (rawDb.prepare(`SELECT COUNT(*) AS n FROM notification_outbox WHERE kind='fresh_fiber' AND status='pending'`).get() as any)?.n ?? 0;
    status.running = false;
  }
}

async function harvestNextMarketInventory(): Promise<{ city: string; state: string; addresses: number; inserted: number } | null> {
  const market = (listMarkets({ eligibility: "verified", limit: 2_000 }) as any[]).find((m) =>
    Number(m.address_count) === 0 && (!m.inventory_retry_at || Date.parse(String(m.inventory_retry_at).replace(" ", "T") + "Z") <= Date.now()),
  );
  if (!market) return null;
  structuredLog("state_monitor.inventory_started", { city: market.city, state: market.state });
  rawDb.prepare(`UPDATE state_fiber_markets SET inventory_status='harvesting',inventory_attempted_at=datetime('now'),updated_at=datetime('now') WHERE id=?`).run(market.id);
  try {
    const result = await getCityAddresses(market.city, market.state);
    const inserted = storage.upsertScanTargets(result.addresses.map((a) => ({
      address: a.address, city: market.city, state: market.state, zip: a.zip ?? "",
      lat: a.lat, lng: a.lng, source: "osm-state-monitor",
    })));
    rawDb.prepare(`UPDATE state_fiber_markets SET inventory_status=?,inventory_failures=0,
      inventory_retry_at=CASE WHEN ?=0 THEN datetime('now','+7 days') ELSE NULL END,
      coverage_gap=CASE WHEN ?=0 THEN 'address_inventory_empty' ELSE NULL END,updated_at=datetime('now') WHERE id=?`)
      .run(result.addresses.length ? "ready" : "empty", result.addresses.length, result.addresses.length, market.id);
    structuredLog("state_monitor.inventory_completed", { city: market.city, state: market.state, addresses: result.addresses.length, inserted });
    return { city: market.city, state: market.state, addresses: result.addresses.length, inserted };
  } catch (error: any) {
    const failures = Number(market.inventory_failures ?? 0) + 1;
    const hours = Math.min(168, 2 ** Math.min(7, failures));
    rawDb.prepare(`UPDATE state_fiber_markets SET inventory_status='failed',inventory_failures=?,
      inventory_retry_at=datetime('now',?),coverage_gap=?,updated_at=datetime('now') WHERE id=?`)
      .run(failures, `+${hours} hours`, `address_inventory_failed: ${String(error.message).slice(0, 160)}`, market.id);
    structuredLog("state_monitor.inventory_failed", { city: market.city, state: market.state, failures, retryHours: hours, error: error.message });
    throw error;
  }
}

export function startStateMonitorScheduler() {
  if (timer) return;
  // Avoid a scan-service/scheduler import cycle while still letting a completed
  // scan batch request an immediate, tenant-scoped outbox flush. CONTROL role only:
  // in the cluster every worker calls this via registerRoutes, and installing the
  // hook everywhere made every scan worker enqueue+drain per green snapshot — 4
  // independent circuit-breaker budgets and 4× the failure burn against a dead mail
  // quota. Call-sites guard `typeof hook === "function"`, so scan workers simply
  // skip the immediate flush; the control worker's own scan batches + ticks still
  // pick every green up from the DB. Single-process (HF_ROLE unset) is unchanged.
  if (IS_OUTBOX_CONTROL) (globalThis as any).__flushFreshFiberAlerts = flushFreshOpportunityAlerts;
  status.enabled = process.env.ENABLE_STATE_MONITORING !== "off"; // on by default
  status.liveSpendEnabled = status.enabled && process.env.STATE_MONITOR_LIVE !== "off";
  // Inventory seeding and dashboard synchronization are safe and free — but with
  // markets switched on nationwide the first tick grinds MINUTES of synchronous
  // better-sqlite3 + OSM-parse work at 100% CPU. Running it inline here (called
  // before httpServer.listen) froze boot past the deploy health window and forced
  // a rollback — a ~10-minute production outage on EVERY deploy. DELAY it well past
  // listen so the app is healthy in seconds; the tick then runs in the background.
  const startupDelayMs = Math.max(10_000, Number(process.env.STATE_MONITOR_STARTUP_DELAY_MS ?? 180_000));
  // Startup tick: control worker only — N workers each running the tick would run
  // N concurrent market syncs/enqueues (the tick was designed one-per-app).
  if (IS_OUTBOX_CONTROL) {
    const startupTick = setTimeout(() => {
      void runStateMonitorTick({ allowSpend: status.liveSpendEnabled }).catch((error) => console.error("[state-monitor] startup tick failed:", error.message));
    }, startupDelayMs);
    startupTick.unref();
  }
  if (!status.enabled) {
    status.lastResult = "inventory init scheduled; scheduler disabled (ENABLE_STATE_MONITORING=false)";
    return;
  }
  if (!IS_OUTBOX_CONTROL) {
    status.lastResult = "scheduler runs on the control worker only (this is a scan worker)";
    return;
  }
  const minutes = positiveInt("STATE_MONITOR_TICK_MINUTES", 15, 1_440); // full-speed default: 15 min (was 60)
  const intervalMs = minutes * 60_000;
  status.nextTickAt = new Date(Date.now() + intervalMs).toISOString();
  timer = setInterval(() => {
    status.nextTickAt = new Date(Date.now() + intervalMs).toISOString();
    void runStateMonitorTick({ allowSpend: status.liveSpendEnabled }).catch((error) => console.error("[state-monitor] tick failed:", error.message));
  }, intervalMs);
  timer.unref();
}

function enqueueFreshAlerts(tenantId: number): number {
  // Only the primary money segment triggers an operational knock alert. Fresh
  // infrastructure with an existing/unknown customer signal remains visible in
  // the dashboard, but is not sent to reps as a non-customer opportunity.
  // 'single_source_provisional' (one conclusive authoritative Kinetic answer) is the
  // SAME bar that publishes an assignable Fresh Lead pin — alerts must fire on it
  // too. Requiring only 'cross_verified' left this channel dead: no automated
  // corroboration source exists, so rep knock alerts never sent.
  // ENQUEUE CAP (per tenant — one tenant's dead backlog must never silence another
  // tenant's alerts): never grow this tenant's pending outbox past OUTBOX_PENDING_CAP.
  // On cap-hit, SUPERSEDE the oldest pending rows to make room rather than dropping
  // the new ones — for a real-time knock alert the NEWEST cluster revision is the one
  // with value; a months-old pending row is noise. Bounded cost: the cap is small.
  const pendingNow = Number((rawDb.prepare(`SELECT COUNT(*) n FROM notification_outbox WHERE kind='fresh_fiber' AND status='pending' AND tenant_id=?`).get(tenantId) as any)?.n ?? 0);
  if (pendingNow >= OUTBOX_PENDING_CAP) {
    const evicted = rawDb.prepare(`UPDATE notification_outbox SET status='superseded', last_error='evicted for newer alerts (cap)', lease_owner=NULL, lease_expires_at=NULL
      WHERE id IN (SELECT id FROM notification_outbox WHERE kind='fresh_fiber' AND status='pending' AND tenant_id=?
        AND (lease_expires_at IS NULL OR lease_expires_at<=datetime('now')) ORDER BY created_at ASC LIMIT 100)`).run(tenantId).changes;
    structuredLog("state_monitor.outbox_capped", { pending: pendingNow, cap: OUTBOX_PENDING_CAP, evictedOldest: evicted });
  }
  const clusters = clusterFreshFiber(freshPoints(tenantId, 7).filter((point) =>
    point.customerSegment === "new_opportunity" && (point.confidence === "cross_verified" || point.confidence === "single_source_provisional"),
  ));
  const insert = rawDb.prepare(`INSERT OR IGNORE INTO notification_outbox (tenant_id,dedupe_key,kind,payload,status) VALUES (?,?, 'fresh_fiber',?,'pending')`);
  let queued = 0;
  for (const cluster of clusters) {
    const revision = crypto.createHash("sha256").update(cluster.addresses
      .map((point) => `${point.id}:${point.firstSeenLiveAt}`).sort().join("|")).digest("hex").slice(0, 20);
    const key = `fresh-fiber:${tenantId}:${revision}`;
    const appOrigin = String(process.env.APP_ORIGIN ?? "").replace(/\/$/, "");
    const appMapUrl = appOrigin ? `${appOrigin}/#/map?freshCluster=${encodeURIComponent(revision)}` : cluster.mapUrl;
    queued += insert.run(tenantId, key, JSON.stringify({ cluster: { ...cluster, mapUrl: appMapUrl }, revision })).changes;
  }
  return queued;
}

async function drainFreshAlerts(tenantId: number): Promise<number> {
  const webhook = process.env.FRESH_FIBER_WEBHOOK_URL;
  const email = adminInbox();
  const emailReady = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS && email);
  if (!webhook && !emailReady) return 0;
  // ONE drainer in the cluster (control worker): N workers each draining would give
  // each its own breaker budget (N× the failure burn) and race the boot janitor.
  if (!IS_OUTBOX_CONTROL) return 0;
  // CIRCUIT BREAKER: when the provider is rejecting everything (rate limit / daily
  // quota exhausted), stop trying for a while instead of burning CPU + logs on
  // failures — the rows stay pending and deliver when the window/quota resets.
  if (Date.now() < outboxPausedUntil) return 0;
  // NEWEST-FIRST: a knock alert's value decays in hours. Draining oldest-first meant
  // that after any outage the recovered mail quota was spent re-sending stale
  // backlog while today's fresh clusters waited behind it.
  const rows = rawDb.prepare(`SELECT * FROM notification_outbox WHERE tenant_id=? AND kind='fresh_fiber' AND status='pending'
    AND (next_attempt_at IS NULL OR next_attempt_at<=datetime('now'))
    AND (lease_expires_at IS NULL OR lease_expires_at<=datetime('now')) ORDER BY created_at DESC LIMIT 25`).all(tenantId) as any[];
  let sent = 0;
  for (const row of rows) {
    const lease = crypto.randomUUID();
    const claimed = rawDb.prepare(`UPDATE notification_outbox SET lease_owner=?,lease_expires_at=datetime('now','+2 minutes')
      WHERE id=? AND status='pending' AND (lease_expires_at IS NULL OR lease_expires_at<=datetime('now'))`).run(lease, row.id);
    if (!claimed.changes) continue;
    try {
      const payload = JSON.parse(row.payload || "{}");
      const cluster = payload.cluster;
      if (webhook) {
        const response = await fetch(webhook, {
          method: "POST", headers: { "content-type": "application/json", "idempotency-key": row.dedupe_key },
          body: JSON.stringify({ event: "fresh_fiber", dedupeKey: row.dedupe_key, ...payload }), signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`webhook ${response.status}`);
      }
      if (emailReady) {
        const addresses = cluster.addresses.slice(0, 15).map((p: any) => `<li>${escapeHtml(p.address)}, ${escapeHtml(p.city)}, ${escapeHtml(p.state)} — ${escapeHtml(p.confidence)}</li>`).join("");
        await sendMailResilient({
          from: mailFrom(), to: email,
          subject: `Fresh Kinetic fiber: ${cluster.density} doors in ${cluster.city}, ${cluster.state}`,
          html: `<h2>Fresh fiber cluster detected</h2><p>Score ${cluster.score}/100 · ${cluster.confirmed} cross-verified · ${cluster.provisional} provisional</p><ul>${addresses}</ul><p><a href="${cluster.mapUrl}">Open cluster map</a></p>`,
        });
      }
      sent += rawDb.prepare(`UPDATE notification_outbox SET status='sent',attempts=attempts+1,sent_at=datetime('now'),
        lease_owner=NULL,lease_expires_at=NULL,last_error=NULL WHERE id=? AND status='pending' AND lease_owner=?`).run(row.id, lease).changes;
      outboxFailStreak = 0; // provider is accepting again — breaker resets
    } catch (error: any) {
      const attempts = Number(row.attempts ?? 0) + 1;
      const retrySeconds = Math.min(21_600, 30 * 2 ** Math.min(9, attempts - 1));
      rawDb.prepare(`UPDATE notification_outbox SET attempts=?,status=CASE WHEN ?>=8 THEN 'failed' ELSE 'pending' END,
        next_attempt_at=CASE WHEN ?>=8 THEN NULL ELSE datetime('now',?) END,last_error=?,lease_owner=NULL,lease_expires_at=NULL
        WHERE id=? AND lease_owner=?`).run(attempts, attempts, attempts, `+${retrySeconds} seconds`, String(error.message).slice(0, 500), row.id, lease);
      structuredLog("state_monitor.alert_failed", { outboxId: row.id, error: error.message });
      outboxFailStreak += 1;
      if (outboxFailStreak >= OUTBOX_BREAKER_THRESHOLD) {
        outboxPausedUntil = Date.now() + OUTBOX_BREAKER_PAUSE_MS;
        outboxFailStreak = 0;
        structuredLog("state_monitor.alert_drain_paused", { pauseMs: OUTBOX_BREAKER_PAUSE_MS, reason: String(error.message).slice(0, 160) });
        break; // stop this drain pass immediately — the provider is refusing everything
      }
    }
  }
  return sent;
}

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
