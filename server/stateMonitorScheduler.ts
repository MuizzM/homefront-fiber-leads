import { getDefaultTenantId, storage } from "./storage";
import { mailTransport, mailFrom, adminInbox } from "./mail";
import { rawDb } from "./db";
import { scanBlockReason } from "./billingStore";
import * as scanService from "./scanService";
import { dueMarkets, freshPoints, listMarkets, seedStateMarkets, syncMarketState } from "./stateMonitorStore";
import { getCityAddresses } from "./overpass";
import { clusterFreshFiber } from "@shared/freshFiberClusters";
import { structuredLog } from "./structuredLog";
import { pollAnnouncementsIfDue } from "./announcementWatcher";

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
  const delivered = await drainFreshAlerts();
  return { queued, delivered };
}

export async function runStateMonitorTick(options: { allowSpend?: boolean } = {}) {
  if (status.running) throw new Error("STATE_MONITOR_BUSY");
  status.running = true;
  status.lastTickAt = new Date().toISOString();
  try {
    const seeded = seedStateMarkets();
    syncMarketState();
    let announcementWatch: any = { status: "disabled", discovered: 0, prioritized: 0 };
    try { announcementWatch = await pollAnnouncementsIfDue(); }
    catch (error: any) { announcementWatch = { status: "failed", error: error.message }; }
    const tenantId = getDefaultTenantId() ?? 1;
    const alerts = enqueueFreshAlerts(tenantId);
    const delivered = await drainFreshAlerts();
    tickSequence++;
    const inventoryEvery = positiveInt("STATE_MONITOR_INVENTORY_EVERY_TICKS", 6, 168);
    const inventoryEnabled = process.env.ENABLE_STATE_ADDRESS_HARVEST === "true";
    const shouldHarvest = inventoryEnabled && tickSequence % inventoryEvery === 0;
    if (shouldHarvest) {
      const harvested = await harvestNextMarketInventory();
      if (harvested) {
        syncMarketState();
        status.lastResult = `harvested ${harvested.addresses} OSM addresses for ${harvested.city}, ${harvested.state}; provider scan deferred to next tick`;
        return { seeded, alertsQueued: alerts, alertsDelivered: delivered, inventoryHarvested: harvested, scanStarted: null };
      }
    }
    const allowSpend = options.allowSpend === true && process.env.ENABLE_STATE_MONITORING === "true" && process.env.STATE_MONITOR_LIVE === "true";
    if (!allowSpend) {
      status.lastResult = `inventory synced (${seeded.total} markets); ${alerts} alerts queued, ${delivered} delivered; live scans disabled`;
      return { seeded, announcementWatch, alertsQueued: alerts, alertsDelivered: delivered, scanStarted: null, liveSpendEnabled: false };
    }
    const billingBlock = scanBlockReason(tenantId);
    if (billingBlock) throw new Error(`STATE_MONITOR_BILLING_BLOCKED: ${billingBlock.message}`);
    const active = scanService.getRuns(tenantId).find((r: any) => r.status === "running" || r.active);
    if (active) {
      status.currentRunId = active.id;
      status.lastResult = `waiting for active scan ${active.id}`;
      return { seeded, alertsQueued: alerts, alertsDelivered: delivered, scanStarted: null, activeRunId: active.id };
    }
    const dailyLimit = positiveInt("STATE_MONITOR_DAILY_CHECK_BUDGET", 2_000, 100_000);
    const marketLimit = positiveInt("STATE_MONITOR_MARKET_BUDGET", 250, 10_000);
    const spent = (rawDb.prepare(`SELECT COALESCE(SUM(budget),0) AS n FROM scan_runs WHERE kind='state-monitor' AND started_at >= date('now')`).get() as any).n as number;
    const remaining = Math.max(0, dailyLimit - spent);
    if (!remaining) {
      status.lastResult = `daily check budget exhausted (${spent}/${dailyLimit})`;
      return { seeded, alertsQueued: alerts, alertsDelivered: delivered, scanStarted: null, budget: { spent, dailyLimit, remaining } };
    }
    const market = dueMarkets(25)[0] as any;
    if (!market) {
      if (inventoryEnabled) {
        const harvested = await harvestNextMarketInventory();
        if (harvested) {
          syncMarketState();
          status.lastResult = `harvested ${harvested.addresses} OSM addresses for ${harvested.city}, ${harvested.state}`;
          return { seeded, alertsQueued: alerts, alertsDelivered: delivered, inventoryHarvested: harvested, scanStarted: null };
        }
      }
      status.lastResult = "no due market with harvested address inventory";
      return { seeded, alertsQueued: alerts, alertsDelivered: delivered, scanStarted: null, inventoryPending: true };
    }
    const budget = Math.min(remaining, marketLimit, Number(market.address_count));
    const run = scanService.startMarketRun({
      tenantId, city: market.city, state: market.state, budget, rescan: true,
      runKind: "state-monitor", label: `State monitor · ${market.city}, ${market.state}`,
    });
    status.currentRunId = run.runId;
    status.lastResult = `started ${run.runId}: ${run.queued} checks in ${market.city}, ${market.state}`;
    structuredLog("state_monitor.scan_started", { runId: run.runId, city: market.city, state: market.state, checks: run.queued, dailyRemaining: remaining - run.queued });
    return { seeded, alertsQueued: alerts, alertsDelivered: delivered, scanStarted: run, budget: { spent, dailyLimit, remaining: remaining - run.queued } };
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
  const market = (listMarkets({ limit: 2_000 }) as any[]).find((m) => Number(m.address_count) === 0);
  if (!market) return null;
  structuredLog("state_monitor.inventory_started", { city: market.city, state: market.state });
  const result = await getCityAddresses(market.city, market.state);
  const inserted = storage.upsertScanTargets(result.addresses.map((a) => ({
    address: a.address, city: market.city, state: market.state, zip: a.zip ?? "",
    lat: a.lat, lng: a.lng, source: "osm-state-monitor",
  })));
  structuredLog("state_monitor.inventory_completed", { city: market.city, state: market.state, addresses: result.addresses.length, inserted });
  return { city: market.city, state: market.state, addresses: result.addresses.length, inserted };
}

export function startStateMonitorScheduler() {
  if (timer) return;
  status.enabled = process.env.ENABLE_STATE_MONITORING === "true";
  status.liveSpendEnabled = status.enabled && process.env.STATE_MONITOR_LIVE === "true";
  // Inventory seeding and dashboard synchronization are safe and free, so run
  // them even when paid provider checks are disabled.
  void runStateMonitorTick({ allowSpend: status.liveSpendEnabled }).catch((error) => console.error("[state-monitor] startup tick failed:", error.message));
  if (!status.enabled) {
    status.lastResult = "inventory initialized; scheduler disabled (ENABLE_STATE_MONITORING=false)";
    return;
  }
  const minutes = positiveInt("STATE_MONITOR_TICK_MINUTES", 60, 1_440);
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
  const clusters = clusterFreshFiber(freshPoints(tenantId, 7).filter((point) => point.customerSegment === "new_opportunity"));
  const insert = rawDb.prepare(`INSERT OR IGNORE INTO notification_outbox (tenant_id,dedupe_key,kind,payload,status) VALUES (?,?, 'fresh_fiber',?,'pending')`);
  let queued = 0;
  for (const cluster of clusters) {
    const key = `fresh-fiber:${tenantId}:${cluster.id}:${cluster.latestDetectedAt}`;
    queued += insert.run(tenantId, key, JSON.stringify({ cluster })).changes;
  }
  return queued;
}

async function drainFreshAlerts(): Promise<number> {
  const webhook = process.env.FRESH_FIBER_WEBHOOK_URL;
  const email = adminInbox();
  const emailReady = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS && email);
  if (!webhook && !emailReady) return 0;
  const rows = rawDb.prepare(`SELECT * FROM notification_outbox WHERE kind='fresh_fiber' AND status='pending' ORDER BY created_at LIMIT 25`).all() as any[];
  let sent = 0;
  for (const row of rows) {
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
        await mailTransport().sendMail({
          from: mailFrom(), to: email,
          subject: `Fresh Kinetic fiber: ${cluster.density} doors in ${cluster.city}, ${cluster.state}`,
          html: `<h2>Fresh fiber cluster detected</h2><p>Score ${cluster.score}/100 · ${cluster.confirmed} cross-verified · ${cluster.provisional} provisional</p><ul>${addresses}</ul><p><a href="${cluster.mapUrl}">Open cluster map</a></p>`,
        });
      }
      sent += rawDb.prepare(`UPDATE notification_outbox SET status='sent', attempts=attempts+1, sent_at=datetime('now') WHERE id=? AND status='pending'`).run(row.id).changes;
    } catch (error: any) {
      rawDb.prepare(`UPDATE notification_outbox SET attempts=attempts+1, status=CASE WHEN attempts>=7 THEN 'failed' ELSE status END WHERE id=?`).run(row.id);
      structuredLog("state_monitor.alert_failed", { outboxId: row.id, error: error.message });
    }
  }
  return sent;
}

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
