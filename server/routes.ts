import path from "path";
import fs from "fs";
import multer from "multer";
import crypto from "crypto";
import nodemailer from "nodemailer";
import type { Express, Request, Response, NextFunction } from "express";
import type { Server } from "http";
import { storage } from "./storage";
import Database from "better-sqlite3";

// ── Apply SQLite performance pragmas on startup ──────────────────────────────
try {
  const _perfDb = new Database(process.env.DB_PATH ?? "./data.db");
  _perfDb.pragma("journal_mode = WAL");
  _perfDb.pragma("synchronous = NORMAL");
  _perfDb.pragma("cache_size = -65536");  // 64MB page cache
  _perfDb.pragma("temp_store = MEMORY");
  _perfDb.pragma("mmap_size = 268435456"); // 256MB mmap
  // Ensure indexes exist (idempotent)
  _perfDb.exec(`
    CREATE INDEX IF NOT EXISTS idx_leads_address ON leads(address);
    CREATE INDEX IF NOT EXISTS idx_leads_zip ON leads(zip);
    CREATE INDEX IF NOT EXISTS idx_leads_is_new_fiber ON leads(is_new_fiber);
    CREATE INDEX IF NOT EXISTS idx_leads_lat_lng ON leads(lat, lng);
    CREATE INDEX IF NOT EXISTS idx_leads_tenant ON leads(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(lead_status);
    CREATE INDEX IF NOT EXISTS idx_leads_assigned_rep ON leads(assigned_rep_id);
  `);
  _perfDb.close();
  console.log("[startup] SQLite WAL + indexes applied");
} catch (e: any) { console.warn("[startup] DB pragma warning:", e.message); }
import { insertLeadSchema, insertTeamMemberSchema, insertKnockSchema, insertTerritorySchema, insertCommissionSchema } from "@shared/schema";
import { scanAddress, NEW_FIBER_ZIPS, FCC_DEPLOYMENT_PERIODS, setManualToken, getTokenStatus, getAuthToken, refreshTokenFromApi } from "./scanner";
import { scanLimiter, ownerLookupLimiter, onboardingLimiter } from "./limiters";
import { KINETIC_ENVS, createCnsJob, getCnsJobs, getCnsJob, stopCnsJob, pauseCnsJob, resumeCnsJob } from "./cns-scanner";
import { getCityAddresses } from "./overpass";
import { harvestRockwellAddresses, harvestCityAddresses, getRockwellGridSize } from "./mapbox-addresses";
import { getCronStatus, triggerManualScan, startNightlyCron } from "./cron-scanner";
import { getProxyStatus } from "./proxy-fetch";

/**
 * Normalize an address string for dedup comparison.
 * Expands common street suffix abbreviations so "Bell Ridge Court"
 * matches "Bell Ridge Ct" in the pre-scan dedup set.
 * Also strips punctuation and collapses whitespace.
 */
function normalizeAddrForDedup(addr: string): string {
  const SUFFIX_MAP: Record<string, string> = {
    court: "ct", drive: "dr", street: "st", avenue: "ave",
    boulevard: "blvd", lane: "ln", road: "rd", place: "pl",
    circle: "cir", trail: "trl", way: "wy", terrace: "ter",
    parkway: "pkwy", highway: "hwy", loop: "lp",
  };
  return addr
    .toLowerCase()
    .trim()
    .replace(/[.,#]/g, "")
    .replace(/\s+/g, " ")
    .split(" ")
    .map(w => SUFFIX_MAP[w] ?? w)
    .join(" ");
}

// ── Email transporter (uses Gmail SMTP via env, falls back to Ethereal for dev) ──
async function sendOtpEmail(to: string, code: string, name: string) {
  // If SMTP env vars set, use them; otherwise log to console (dev mode)
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT ?? 587),
      secure: false,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    await transporter.sendMail({
      from: `"HomeFront Fiber" <${process.env.SMTP_USER}>`,
      to,
      subject: "Your login code — HomeFront Fiber",
      html: `<div style="font-family:sans-serif;max-width:420px;margin:auto;padding:36px;background:#0F2A44;color:#fff;border-radius:12px">
        <h2 style="color:#3EA394;margin:0 0 4px;font-size:20px">HomeFront Fiber</h2>
        <p style="color:#CBD4DD;font-size:12px;margin:0 0 28px">Field Sales Intelligence</p>
        <p style="color:#CBD4DD;margin:0 0 16px">Hi ${name}, here is your one-time login code:</p>
        <div style="font-size:40px;font-weight:700;letter-spacing:10px;color:#3EA394;padding:20px;background:#061624;border:1px solid rgba(62,163,148,0.3);border-radius:10px;text-align:center">${code}</div>
        <p style="color:#5A6B76;font-size:12px;margin:20px 0 0">Expires in 10 minutes. Never share this code with anyone. HomeFront Fiber will never ask for your code.</p>
      </div>`,
    });
  } else {
    // Dev fallback — print to server console so you can test without SMTP
    console.log(`\n══ OTP for ${to} (${name}): ${code} ══\n`);
  }
}

// ── Auth middleware ───────────────────────────────────────────────────────────────
function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.headers["x-session-id"] as string;
  if (!token) return res.status(401).json({ error: "Not authenticated" });
  const session = storage.getSession(token);
  if (!session) return res.status(401).json({ error: "Session expired" });
  const user = storage.getUserById(session.userId);
  if (!user || !user.active) return res.status(401).json({ error: "User not found" });
  (req as any).user = user;
  next();
}

function requireAdmin(req: Request, res: Response, next: NextFunction) {
  requireAuth(req, res, () => {
    const user = (req as any).user;
    if (user.role !== "admin") return res.status(403).json({ error: "Admin only" });
    next();
  });
}

// Team Lead or above (team_lead, manager, admin) can onboard reps
function requireTeamLead(req: Request, res: Response, next: NextFunction) {
  requireAuth(req, res, () => {
    const user = (req as any).user;
    const allowed = ["admin", "manager", "team_lead"];
    if (!allowed.includes(user.role)) return res.status(403).json({ error: "Team Lead or above required" });
    next();
  });
}

// Manager or above
function requireManager(req: Request, res: Response, next: NextFunction) {
  requireAuth(req, res, () => {
    const user = (req as any).user;
    const allowed = ["admin", "manager"];
    if (!allowed.includes(user.role)) return res.status(403).json({ error: "Manager or above required" });
    next();
  });
}

// ── Lead visibility scope (fail closed) ───────────────────────────────────────
// Admin / manager / team_lead see every lead in their tenant (undefined = no
// rep filter). A rep only sees leads assigned to their linked team member. A
// rep with no team-member link resolves to -1, which matches no lead, so they
// see NOTHING — never the whole table. This must never fail open to `undefined`.
function repLeadScope(user: any): number | undefined {
  if (user?.role !== "rep") return undefined;
  return user?.teamMemberId ?? -1;
}

// A rep may only read/act on a lead assigned to their own team member. Non-reps
// pass. Used to guard single-lead endpoints against IDOR (fetch-by-id).
function repCanAccessLead(user: any, lead: any): boolean {
  if (user?.role !== "rep") return true;
  return !!lead && lead.assignedRepId != null && lead.assignedRepId === user?.teamMemberId;
}

// ── Sanitize fiber result — strip proprietary vendor fields before sending to client ──
function sanitizeFiberResult(r: any) {
  return {
    address: r.address,
    lat: r.lat,
    lng: r.lng,
    fiberAvailable: r.fiberAvailable,
    isNewFiber: r.isNewFiber,
    isTenured: r.isTenured,
    fiberStatus: r.fiberStatus,
    techType: r.techType,
    speedTier: r.speedTier,
    maxDownloadMbps: r.maxDownloadMbps,
    // Intentionally omitted: rawResponse, householdSegmentType, billingStatus, apiSource,
    // competitorName, addressCatalogDate, confidence, notes
  };
}

// ── Live scanner state (FiberFocus-style) ───────────────────────────────────
// Mirrors FiberFocus's /api/coming-soon/state pattern:
// Real-time metrics polled every 3s by the frontend.
interface ScanWorkerState {
  isRunning: boolean;
  checksPerSec: number;      // rolling 10s average checks/sec
  concurrency: number;       // current parallel slots in use
  maxInFlight: number;       // configured concurrency cap
  lastHeartbeat: number;     // unix ms — staleness detection (>120s = stuck)
  totalChecked: number;      // cumulative checks this session
  diagHttpError: number;     // HTTP errors in last window
  diagSuccess: number;       // successful checks in last window
  diagNewFiber: number;      // new fiber found in last window
  diagFailed: number;        // failed/unknown in last window
  proxyEnabled: boolean;
}

const _scanWorkerState: ScanWorkerState = {
  isRunning: false,
  checksPerSec: 0,
  concurrency: 0,
  maxInFlight: 100,
  lastHeartbeat: Date.now(),
  totalChecked: 0,
  diagHttpError: 0,
  diagSuccess: 0,
  diagNewFiber: 0,
  diagFailed: 0,
  proxyEnabled: true,
};

// Rolling window for checksPerSec calculation
const _checkTimestamps: number[] = [];
const CHECKS_WINDOW_MS = 10000; // 10s rolling window

function recordCheck(isNewFiber = false, isError = false) {
  const now = Date.now();
  _checkTimestamps.push(now);
  // Purge old timestamps
  while (_checkTimestamps.length > 0 && now - _checkTimestamps[0] > CHECKS_WINDOW_MS) {
    _checkTimestamps.shift();
  }
  _scanWorkerState.checksPerSec = Math.round(_checkTimestamps.length / (CHECKS_WINDOW_MS / 1000) * 10) / 10;
  _scanWorkerState.totalChecked++;
  _scanWorkerState.lastHeartbeat = now;
  if (isNewFiber) _scanWorkerState.diagNewFiber++;
  if (isError) _scanWorkerState.diagHttpError++;
  else _scanWorkerState.diagSuccess++;
}

// ── Scan job store ────────────────────────────────────────────────────────────
interface ScanJob {
  tenantId?: number;
  id: string; city: string; zip: string;
  status: "running" | "done" | "error";
  total: number; done: number; results: any[];
  startedAt: string; completedAt?: string;
  bbox?: { minLat: number; maxLat: number; minLng: number; maxLng: number };
}
const scanJobs = new Map<string, ScanJob>();

// ── Rockwell address list — real streets in ZIP 28138 ────────────────────────
// Sources: Rowan County GIS, Census TIGER, OSM Overpass.
// Single range per street, step=4 (every other side). Bell Ridge Ct uses step=2.
// Kinetic returns AddressNotFound instantly for non-existent numbers — fast skip.
// ~4,600 addresses total; at ~80ms avg = ~6–10 minutes for a full scan.
// ── Real address pool — 1,248 parcels from Rowan County GIS (ZIP 28138) ───────────
// Source: gis.rowancountync.gov RowanTaxParcels — every address includes real centroid coords
import { readFileSync } from "fs";
import { join } from "path";

let _gisAddresses: { address: string; city: string; state: string; zip: string; lat: number; lng: number; }[] | null = null;
function loadGisAddresses() {
  if (_gisAddresses) return _gisAddresses;
  try {
    const filePath = join(__dirname, "rockwell_gis_addresses.json");
    _gisAddresses = JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    // Fallback if file not found (dev mode uses ts-node from different cwd)
    try {
      const filePath = join(process.cwd(), "server", "rockwell_gis_addresses.json");
      _gisAddresses = JSON.parse(readFileSync(filePath, "utf-8"));
    } catch {
      _gisAddresses = [];
    }
  }
  return _gisAddresses!;
}

function generateAddresses(zip = "28138", _city = "Rockwell") {
  // Return real parcel addresses with GIS coordinates
  return loadGisAddresses().filter(a => a.zip === zip);
}

// ── Background scanner — concurrent batch mode ────────────────────────────────
// Proxy pool has 20 persistent sockets (pipelining=1 per socket) → 20 true parallel slots.
// Set to 50 concurrent: undici queues the overflow and dispatches as sockets free up.
// At 50 concurrent + 60ms batch delay → ~833 addr/sec (vs previous 167 addr/sec at 10 conc).
// A full 10,500-address Rockwell scan completes in ~15 seconds with proxy.
// ── Multi-worker scan engine ─────────────────────────────────────────────────
// 200 concurrent + 0ms delay + 4 parallel zone workers = maximum throughput.
// Proxy pool: 200 connections × 2 pipeline = 400 slots.
// Kinetic API: ~100-200ms avg response → theoretical ceiling ~2,000 checks/sec.
// In practice with residential proxy overhead: ~300-800 checks/sec sustained.
const SCAN_BATCH_SIZE   = 200; // Fill all 400 proxy slots per batch
const SCAN_BATCH_DELAY_MS = 0; // No delay — continuous fire
const SCAN_ZONE_WORKERS = 4;   // Split address list into N zones processed in parallel

// ── Write queue: batch DB inserts every 500ms instead of one-by-one ─────────
// SQLite is fast but the upsertLeadByAddress call has overhead.
// Batching 50+ inserts per flush reduces I/O contention during high-throughput scans.
type LeadInsert = Parameters<typeof storage.upsertLeadByAddress>[0];
let _writeQueue: LeadInsert[] = [];
let _writeQueueTimer: ReturnType<typeof setInterval> | null = null;

function enqueueLeadWrite(lead: LeadInsert) {
  _writeQueue.push(lead);
  if (!_writeQueueTimer) {
    _writeQueueTimer = setInterval(flushWriteQueue, 500);
  }
}

function flushWriteQueue() {
  if (_writeQueue.length === 0) {
    if (_writeQueueTimer) { clearInterval(_writeQueueTimer); _writeQueueTimer = null; }
    return;
  }
  const batch = _writeQueue.splice(0, 200); // process up to 200 at a time
  for (const lead of batch) {
    try { storage.upsertLeadByAddress(lead); } catch (e: any) {
      console.error(`[write-queue] Insert error: ${e.message}`);
    }
  }
  // Bust map cache after every flush
  if (typeof (globalThis as any).__bustMapCache === "function") (globalThis as any).__bustMapCache();
}

async function scanOneBatch(
  jobId: string,
  batch: ReturnType<typeof generateAddresses>,
  job: ScanJob
) {
  if (!scanJobs.has(jobId)) return;

  await Promise.all(batch.map(async (a) => {
    if (!scanJobs.has(jobId)) return;
    try {
      const result = await scanAddress(a.address, a.city, a.state, a.zip);
      // Attach GIS coords if API didn't return geocoded coordinates
      if (!result.lat && (a as any).lat) result.lat = (a as any).lat;
      if (!result.lng && (a as any).lng) result.lng = (a as any).lng;
      job.results.push(result);

      // ── Record live worker metrics (FiberFocus-style) ─────────────────────
      const isNewFiberResult = result.isNewFiber && result.billingStatus === "N";
      recordCheck(isNewFiberResult, result.apiSource === "failed");
      _scanWorkerState.concurrency = Math.min(_scanWorkerState.concurrency + 1, SCAN_BATCH_SIZE);

      // ── SAVE ONLY: NEW FIBER + billingStatus N (not a current subscriber) ───
      // These are the actual door-knock targets — fiber just ran to the house,
      // resident doesn't know it exists yet.
      const isTarget = result.isNewFiber && result.billingStatus === "N" && result.fiberAvailable;
      if (isTarget) {
        // Non-blocking write queue — does not block the scan loop
        enqueueLeadWrite({
          address: result.address, city: result.city, state: result.state, zip: result.zip,
          lat: result.lat ?? (a as any).lat, lng: result.lng ?? (a as any).lng,
          fiberStatus: result.fiberStatus,
          householdSegmentType: result.householdSegmentType,
          billingStatus: result.billingStatus,
          isNewFiber: result.isNewFiber,
          isTenured: false,
          speedTier: result.speedTier,
          maxDownloadMbps: result.maxDownloadMbps,
          techType: result.techType,
          chipSetType: result.chipSetType,
          placement: result.placement,
          maxQual: result.maxQual,
          competitorName: result.competitorName,
          competitorSpeedMbps: result.competitorSpeedMbps,
          competitorTech: result.competitorTech,
          inCompetitorArea: result.inCompetitorArea,
          dfAddressId: result.dfAddressId,
          accessId: result.accessId,
          exchangeId: result.exchangeId,
          addressCatalogDate: result.addressCatalogDate,
          leadStatus: "prospect",
          leadTag: result.leadTag,
          leadScore: result.leadScore,
          deploymentNotes: result.notes,
        });
      }
    } catch {
      job.results.push({ ...a, fiberStatus: "unknown", apiSource: "failed" });
      recordCheck(false, true);
    }
    job.done = Math.min(job.done + 1, job.total);
  }));
  // Update concurrency after batch completes
  _scanWorkerState.concurrency = 0;
}

// ── Zone worker: scans one slice of addresses ─────────────────────────────────
async function runZoneWorker(
  jobId: string,
  zone: ReturnType<typeof generateAddresses>,
  job: ScanJob
) {
  for (let i = 0; i < zone.length; i += SCAN_BATCH_SIZE) {
    if (!scanJobs.has(jobId)) return;
    const batch = zone.slice(i, i + SCAN_BATCH_SIZE);
    await scanOneBatch(jobId, batch, job);
    // 0ms delay — proxy pool handles backpressure natively
    if (SCAN_BATCH_DELAY_MS > 0 && i + SCAN_BATCH_SIZE < zone.length) {
      await new Promise(r => setTimeout(r, SCAN_BATCH_DELAY_MS));
    }
  }
}

async function runCityScan(jobId: string, addresses: ReturnType<typeof generateAddresses>) {
  const job = scanJobs.get(jobId)!;
  job.total = addresses.length;
  job.done = 0;

  _scanWorkerState.isRunning = true;
  _scanWorkerState.lastHeartbeat = Date.now();
  _scanWorkerState.diagNewFiber = 0;
  _scanWorkerState.diagHttpError = 0;
  _scanWorkerState.diagSuccess = 0;
  _scanWorkerState.diagFailed = 0;

  // ── Split into SCAN_ZONE_WORKERS zones and run all in parallel ─────────────
  // Zone 0: addresses[0], [N], [2N] ...   (every Nth address starting at 0)
  // Zone 1: addresses[1], [N+1], [2N+1] ... (interleaved, not contiguous)
  // Interleaving ensures geographic diversity across zones — avoids all zones
  // hitting the same street block simultaneously.
  const N = SCAN_ZONE_WORKERS;
  const zones: ReturnType<typeof generateAddresses>[] = Array.from({ length: N }, (_, zi) =>
    addresses.filter((_, idx) => idx % N === zi)
  );

  // Fire all zone workers in parallel — they share the same proxy pool
  await Promise.all(zones.map(zone => runZoneWorker(jobId, zone, job)));

  // Flush any remaining queued writes before marking done
  flushWriteQueue();
  if (typeof (globalThis as any).__bustMapCache === "function") (globalThis as any).__bustMapCache();
  job.status = "done";
  job.completedAt = new Date().toISOString();
  _scanWorkerState.isRunning = false;
  _scanWorkerState.checksPerSec = 0;
  _scanWorkerState.concurrency = 0;
  console.log(`[scan] Job ${jobId} complete: ${job.done} checked, ${_scanWorkerState.diagNewFiber} new fiber`);
}

// ── Routes ────────────────────────────────────────────────────────────────────
export function registerRoutes(httpServer: Server, app: Express) {

  // ── Map config — returns Mapbox token only to authenticated users ───────────
  // Token is NOT in the frontend bundle; fetched at runtime from the server.
  app.get("/api/config/map", requireAuth, (_req, res) => {
    const token = process.env.MAPBOX_TOKEN ?? process.env.VITE_MAPBOX_TOKEN ?? "";
    if (!token) return res.status(503).json({ error: "Map not configured" });
    res.json({ token });
  });

  // Scanner submit secret — served only to authenticated managers/admins, never in client bundle
  app.get("/api/config/scanner-secret", requireManager, (_req, res) => {
    const secret = process.env.SCANNER_SUBMIT_SECRET ?? "";
    if (!secret) return res.status(503).json({ error: "Scanner secret not configured" });
    res.json({ secret });
  });

  // ── FCC-sourced Kinetic active build markets ───────────────────────────────
  // Active build zones from FCC BDC Jan 2025 → Jun 2025 delta analysis.
  // These are markets where Kinetic added NEW fiber passings in last 6 months.
  // Sorted by estimated new passings (desc) — highest activity first.
  app.get("/api/markets/kinetic", requireManager, (_req, res) => {
    res.json({
      lastUpdated: "FCC BDC Jun 2025",
      totalNewPassings: 298000,
      markets: [
        // ── NC (Home market) ─────────────────────────────────────────
        { state:"NC", city:"Rockwell",       zip:"28138", newPassings: 4200, priority:"critical", buildStatus:"active",    buildDate:"Q4 2025" },
        { state:"NC", city:"Concord",        zip:"28025", newPassings: 8700, priority:"critical", buildStatus:"active",    buildDate:"Q3 2025" },
        { state:"NC", city:"Kannapolis",     zip:"28081", newPassings: 6300, priority:"critical", buildStatus:"active",    buildDate:"Q3 2025" },
        { state:"NC", city:"Salisbury",      zip:"28144", newPassings: 5100, priority:"high",     buildStatus:"active",    buildDate:"Q4 2025" },
        { state:"NC", city:"Statesville",    zip:"28677", newPassings: 3900, priority:"high",     buildStatus:"active",    buildDate:"Q1 2026" },
        { state:"NC", city:"Lexington",      zip:"27292", newPassings: 3200, priority:"high",     buildStatus:"active",    buildDate:"Q1 2026" },
        { state:"NC", city:"Asheboro",       zip:"27203", newPassings: 2800, priority:"medium",   buildStatus:"planned",   buildDate:"Q2 2026" },
        { state:"NC", city:"High Point",     zip:"27262", newPassings: 7200, priority:"high",     buildStatus:"active",    buildDate:"Q4 2025" },
        { state:"NC", city:"Albemarle",      zip:"28001", newPassings: 2100, priority:"medium",   buildStatus:"active",    buildDate:"Q2 2026" },
        // ── TX (Largest Kinetic market) ──────────────────────────────
        { state:"TX", city:"Lubbock",        zip:"79401", newPassings:18400, priority:"critical", buildStatus:"active",    buildDate:"Q3 2025" },
        { state:"TX", city:"Amarillo",       zip:"79101", newPassings:14200, priority:"critical", buildStatus:"active",    buildDate:"Q3 2025" },
        { state:"TX", city:"Midland",        zip:"79701", newPassings: 9800, priority:"critical", buildStatus:"active",    buildDate:"Q4 2025" },
        { state:"TX", city:"Odessa",         zip:"79760", newPassings: 8300, priority:"high",     buildStatus:"active",    buildDate:"Q4 2025" },
        { state:"TX", city:"Abilene",        zip:"79601", newPassings: 7100, priority:"high",     buildStatus:"active",    buildDate:"Q1 2026" },
        { state:"TX", city:"Wichita Falls",  zip:"76301", newPassings: 5900, priority:"high",     buildStatus:"active",    buildDate:"Q1 2026" },
        { state:"TX", city:"Tyler",          zip:"75701", newPassings: 6800, priority:"high",     buildStatus:"active",    buildDate:"Q4 2025" },
        { state:"TX", city:"Longview",       zip:"75601", newPassings: 4200, priority:"medium",   buildStatus:"active",    buildDate:"Q2 2026" },
        { state:"TX", city:"Andrews",        zip:"79714", newPassings: 2100, priority:"medium",   buildStatus:"active",    buildDate:"Q1 2026" },
        // ── KY (Strong mid-size builds) ───────────────────────────────
        { state:"KY", city:"Lexington",      zip:"40502", newPassings:11200, priority:"critical", buildStatus:"active",    buildDate:"Q3 2025" },
        { state:"KY", city:"Louisville",     zip:"40201", newPassings: 9300, priority:"critical", buildStatus:"active",    buildDate:"Q3 2025" },
        { state:"KY", city:"Elizabethtown",  zip:"42701", newPassings: 4800, priority:"high",     buildStatus:"active",    buildDate:"Q4 2025" },
        { state:"KY", city:"Bowling Green",  zip:"42101", newPassings: 5200, priority:"high",     buildStatus:"active",    buildDate:"Q4 2025" },
        { state:"KY", city:"Bullitt County", zip:"40165", newPassings: 3100, priority:"high",     buildStatus:"active",    buildDate:"Q1 2026" },
        { state:"KY", city:"Covington",      zip:"41011", newPassings: 4100, priority:"high",     buildStatus:"planned",   buildDate:"Q2 2026" },
        // ── OH (Large urban builds) ──────────────────────────────────
        { state:"OH", city:"Columbus",       zip:"43215", newPassings:16800, priority:"critical", buildStatus:"active",    buildDate:"Q3 2025" },
        { state:"OH", city:"Toledo",         zip:"43601", newPassings:12100, priority:"critical", buildStatus:"active",    buildDate:"Q3 2025" },
        { state:"OH", city:"Canton",         zip:"44701", newPassings: 7200, priority:"high",     buildStatus:"active",    buildDate:"Q4 2025" },
        { state:"OH", city:"Akron",          zip:"44301", newPassings: 8900, priority:"high",     buildStatus:"active",    buildDate:"Q4 2025" },
        { state:"OH", city:"Lima",           zip:"45801", newPassings: 3800, priority:"medium",   buildStatus:"active",    buildDate:"Q1 2026" },
        { state:"OH", city:"Youngstown",     zip:"44501", newPassings: 5100, priority:"high",     buildStatus:"active",    buildDate:"Q1 2026" },
        // ── NE (Active rural expansion) ───────────────────────────────
        { state:"NE", city:"Lincoln",        zip:"68501", newPassings:13200, priority:"critical", buildStatus:"active",    buildDate:"Q3 2025" },
        { state:"NE", city:"Omaha",          zip:"68101", newPassings:10800, priority:"critical", buildStatus:"active",    buildDate:"Q3 2025" },
        { state:"NE", city:"Grand Island",   zip:"68801", newPassings: 4100, priority:"high",     buildStatus:"active",    buildDate:"Q4 2025" },
        { state:"NE", city:"Kearney",        zip:"68847", newPassings: 2900, priority:"medium",   buildStatus:"active",    buildDate:"Q1 2026" },
        { state:"NE", city:"Beatrice",       zip:"68310", newPassings: 1800, priority:"medium",   buildStatus:"active",    buildDate:"Q1 2026" },
        { state:"NE", city:"York",           zip:"68467", newPassings: 1400, priority:"medium",   buildStatus:"active",    buildDate:"Q2 2026" },
        // ── MO (Active CAB builds) ────────────────────────────────────
        { state:"MO", city:"Doniphan",       zip:"63935", newPassings: 2200, priority:"high",     buildStatus:"active",    buildDate:"Q1 2026" },
        { state:"MO", city:"Poplar Bluff",   zip:"63901", newPassings: 3800, priority:"high",     buildStatus:"active",    buildDate:"Q1 2026" },
        { state:"MO", city:"Springfield",    zip:"65801", newPassings: 9200, priority:"critical", buildStatus:"active",    buildDate:"Q4 2025" },
        { state:"MO", city:"Joplin",         zip:"64801", newPassings: 5600, priority:"high",     buildStatus:"active",    buildDate:"Q4 2025" },
        { state:"MO", city:"Cape Girardeau", zip:"63701", newPassings: 3100, priority:"medium",   buildStatus:"planned",   buildDate:"Q2 2026" },
        // ── OK ───────────────────────────────────────────────────────────
        { state:"OK", city:"Oklahoma City",  zip:"73101", newPassings:14600, priority:"critical", buildStatus:"active",    buildDate:"Q3 2025" },
        { state:"OK", city:"Tulsa",          zip:"74101", newPassings:11400, priority:"critical", buildStatus:"active",    buildDate:"Q3 2025" },
        { state:"OK", city:"Lawton",         zip:"73501", newPassings: 4200, priority:"high",     buildStatus:"active",    buildDate:"Q4 2025" },
        { state:"OK", city:"Norman",         zip:"73069", newPassings: 6800, priority:"high",     buildStatus:"active",    buildDate:"Q4 2025" },
        // ── GA / SC / AL / FL ───────────────────────────────────────────
        { state:"GA", city:"Augusta",        zip:"30901", newPassings: 8200, priority:"critical", buildStatus:"active",    buildDate:"Q4 2025" },
        { state:"GA", city:"Columbus",       zip:"31901", newPassings: 7100, priority:"high",     buildStatus:"active",    buildDate:"Q1 2026" },
        { state:"SC", city:"Greenville",     zip:"29601", newPassings: 9400, priority:"critical", buildStatus:"active",    buildDate:"Q4 2025" },
        { state:"SC", city:"Spartanburg",    zip:"29301", newPassings: 6200, priority:"high",     buildStatus:"active",    buildDate:"Q4 2025" },
        { state:"SC", city:"Columbia",       zip:"29201", newPassings: 8100, priority:"critical", buildStatus:"active",    buildDate:"Q4 2025" },
        { state:"AL", city:"Huntsville",     zip:"35801", newPassings:12300, priority:"critical", buildStatus:"active",    buildDate:"Q3 2025" },
        { state:"AL", city:"Madison",        zip:"35758", newPassings: 5800, priority:"high",     buildStatus:"active",    buildDate:"Q4 2025" },
        { state:"FL", city:"Pensacola",      zip:"32501", newPassings: 9700, priority:"critical", buildStatus:"active",    buildDate:"Q4 2025" },
        { state:"FL", city:"Panama City",    zip:"32401", newPassings: 6100, priority:"high",     buildStatus:"active",    buildDate:"Q1 2026" },
        // ── PA / NY ────────────────────────────────────────────────────
        { state:"PA", city:"Pittsburgh",     zip:"15201", newPassings:11800, priority:"critical", buildStatus:"active",    buildDate:"Q4 2025" },
        { state:"PA", city:"Scranton",       zip:"18501", newPassings: 6400, priority:"high",     buildStatus:"active",    buildDate:"Q1 2026" },
        { state:"NY", city:"Syracuse",       zip:"13201", newPassings: 8900, priority:"critical", buildStatus:"active",    buildDate:"Q4 2025" },
        { state:"NY", city:"Binghamton",     zip:"13901", newPassings: 4200, priority:"high",     buildStatus:"active",    buildDate:"Q1 2026" },
        // ── IA / MN / MS / AR / NM ──────────────────────────────────────
        { state:"IA", city:"Des Moines",     zip:"50301", newPassings:13100, priority:"critical", buildStatus:"active",    buildDate:"Q3 2025" },
        { state:"IA", city:"Cedar Rapids",   zip:"52401", newPassings: 8700, priority:"high",     buildStatus:"active",    buildDate:"Q4 2025" },
        { state:"MN", city:"Rochester",      zip:"55901", newPassings: 7200, priority:"high",     buildStatus:"active",    buildDate:"Q4 2025" },
        { state:"MS", city:"Jackson",        zip:"39201", newPassings: 6800, priority:"high",     buildStatus:"active",    buildDate:"Q4 2025" },
        { state:"AR", city:"Little Rock",    zip:"72201", newPassings: 9100, priority:"critical", buildStatus:"active",    buildDate:"Q4 2025" },
        { state:"NM", city:"Albuquerque",    zip:"87101", newPassings:10200, priority:"critical", buildStatus:"active",    buildDate:"Q3 2025" },
        { state:"NM", city:"Las Cruces",     zip:"88001", newPassings: 4800, priority:"high",     buildStatus:"active",    buildDate:"Q1 2026" },
      ],
    });
  });

  // ── FiberFocus-style scanner state ───────────────────────────────────────────────
  // Polled every 3s by the CityScanner UI to show live efficiency metrics.
  app.get("/api/scanner/state", requireManager, (req, res) => {
    const activeJob = Array.from(scanJobs.values()).find(j => j.status === "running");
    const secondsSinceHeartbeat = Math.floor((Date.now() - _scanWorkerState.lastHeartbeat) / 1000);
    res.json({
      ..._scanWorkerState,
      isStuck: _scanWorkerState.isRunning && secondsSinceHeartbeat > 120,
      secondsSinceHeartbeat,
      activeJob: activeJob ? {
        id: activeJob.id,
        city: activeJob.city,
        total: activeJob.total,
        done: activeJob.done,
        pct: activeJob.total ? Math.round(activeJob.done / activeJob.total * 100) : 0,
        newFiber: activeJob.results.filter(r => r.isNewFiber && r.billingStatus === "N").length,
      } : null,
    });
  });

  // ── Server-side lead clusters (FiberFocus-style /api/kinetic-scanner/live-clusters) ──
  // Returns pre-clustered pins for the current map viewport.
  // Frontend sends zoom + bbox, server returns clusters — reduces client CPU.
  app.get("/api/leads/live-clusters", requireAuth, (req, res) => {
    const user = (req as any).user;
    const tid = user?.tenantId ?? undefined;
    const repFilter = repLeadScope(user);
    const { zoom, west, south, east, north } = req.query;

    const all = storage.getLeads(tid, repFilter)
      .filter(l => l.lat && l.lng);

    const z = zoom ? Math.min(Math.max(Number(zoom), 0), 20) : 10;

    // If bbox provided, filter to viewport for efficiency
    let pins = all;
    if (west && south && east && north) {
      const w = Number(west), s = Number(south), e = Number(east), n = Number(north);
      pins = all.filter(l => l.lng! >= w && l.lng! <= e && l.lat! >= s && l.lat! <= n);
    }

    // Build GeoJSON features for supercluster
    const features = pins.map(l => ({
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [l.lng!, l.lat!] },
      properties: {
        id: l.id, address: l.address, city: l.city, zip: l.zip,
        leadStatus: l.leadStatus, fiberStatus: l.fiberStatus,
        isNewFiber: l.isNewFiber, assignedRepId: l.assignedRepId,
        leadScore: l.leadScore,
      },
    }));

    // Import supercluster dynamically (CJS)
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Supercluster = require("supercluster");
      const index = new Supercluster({ radius: 60, maxZoom: 18 });
      index.load(features);
      const bbox: [number, number, number, number] = [
        Number(west ?? -180), Number(south ?? -90),
        Number(east ?? 180),  Number(north ?? 90),
      ];
      const clusters = index.getClusters(bbox, z);
      res.json({ clusters, total: features.length });
    } catch (e: any) {
      // Fallback: return raw pins without clustering
      res.json({ clusters: features, total: features.length });
    }
  });

  // Leads CRUD
  // ── Map-optimized endpoint: returns ALL leads with only pin fields ─────────
  // Deliberately before /api/leads/:id so "/map" doesn't get caught as an :id
  // ── Map pin cache — avoids re-querying 2k+ leads on every poll ──────────────
  let _mapPinCache: { ts: number; pins: any[] } | null = null;
  const MAP_CACHE_TTL = 8_000; // 8s — fast enough for real-time feel

  function getMapPins(tenantId?: number, repFilter?: number) {
    const now = Date.now();
    if (!repFilter && !tenantId && _mapPinCache && now - _mapPinCache.ts < MAP_CACHE_TTL) {
      return _mapPinCache.pins; // cache hit for admin/manager (no per-user filter)
    }
    const all = storage.getLeads(tenantId, repFilter);
    const pins = all
      .filter((l: any) => l.lat && l.lng)
      .map((l: any) => ({
        id: l.id,
        address: l.address,
        city: l.city,
        state: l.state,
        zip: l.zip,
        lat: l.lat,
        lng: l.lng,
        leadStatus: l.leadStatus,
        fiberStatus: l.fiberStatus,
        isNewFiber: l.isNewFiber,
        assignedRepId: l.assignedRepId,
        maxDownloadMbps: l.maxDownloadMbps,
        competitorName: l.competitorName,
        leadScore: l.leadScore,
        contactName: l.contactName,
        contactPhone: l.contactPhone,
      }));
    if (!repFilter && !tenantId) _mapPinCache = { ts: Date.now(), pins };
    return pins;
  }

  app.get("/api/leads/map", requireAuth, (req: any, res: any) => {
    const user = req.user;
    const tid = user?.tenantId ?? undefined;
    const repFilter = repLeadScope(user);
    const pins = getMapPins(tid, repFilter);
    res.json({ pins, total: pins.length });
  });

  app.get("/api/leads", requireAuth, (req, res) => {
    const { search, limit, offset, status, zip } = req.query;
    const user = (req as any).user;
    const tid = user?.tenantId ?? undefined;
    // Reps only see leads assigned to them; managers/admins see all
    const repFilter = repLeadScope(user);

    let leads = search
      ? storage.searchLeads(String(search), tid, repFilter)
      : storage.getLeads(tid, repFilter);

    // Server-side filters
    if (status && status !== "all") leads = leads.filter(l => l.leadStatus === String(status));
    if (zip) leads = leads.filter(l => l.zip === String(zip));

    // Pagination
    const total = leads.length;
    const lim = limit ? Math.min(Number(limit), 500) : 200;
    const off = offset ? Number(offset) : 0;
    const page = leads.slice(off, off + lim);

    res.json({ leads: page, total, limit: lim, offset: off });
  });
  app.get("/api/leads/:id", requireAuth, (req, res) => {
    const lead = storage.getLeadById(Number(req.params.id));
    const user = (req as any).user;
    const tid = user?.tenantId;
    // Verify the lead belongs to the caller’s tenant
    if (!lead || (tid && lead.tenantId !== tid)) return res.status(404).json({ error: "Not found" });
    // Reps can only view leads assigned to them — 404 (not 403) to avoid leaking existence
    if (!repCanAccessLead(user, lead)) return res.status(404).json({ error: "Not found" });
    res.json(lead);
  });
  // Team lead+ can create leads; manager+ can update status/delete
  // Helper to bust map pin cache after any lead mutation
  function bustMapCache() { _mapPinCache = null; }
  // Expose globally so write queue (module scope) can call it
  (globalThis as any).__bustMapCache = bustMapCache;

  app.post("/api/leads", requireTeamLead, (req: any, res: any) => {
    const parsed = insertLeadSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error });
    res.status(201).json(storage.createLead(parsed.data));
  });
  app.patch("/api/leads/:id", requireManager, (req, res) => {
    // Allowlist only safe fields — prevent mass-assignment of internal fields
    const ALLOWED_LEAD_FIELDS = new Set([
      "leadStatus", "assignedRepId", "ownerName", "ownerPhone", "ownerEmail",
      "notes", "incomeRange", "homeValue", "yearsAtAddress", "isHomeowner",
      "deploymentNotes",
    ]);
    const safeUpdate: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(req.body)) {
      if (ALLOWED_LEAD_FIELDS.has(k)) safeUpdate[k] = v;
    }
    const tid = (req as any).user?.tenantId ?? undefined;
    const updated = storage.updateLead(Number(req.params.id), safeUpdate as any, tid);
    if (!updated) return res.status(404).json({ error: "Not found" });
    res.json(updated);
  });
  app.delete("/api/leads/:id", requireManager, (req, res) => {
    const tid = (req as any).user?.tenantId ?? undefined;
    if (!storage.deleteLead(Number(req.params.id), tid)) return res.status(404).json({ error: "Not found" });
    res.json({ success: true });
  });

  // Manual token injection — user pastes JWT from their browser
  // Set Kinetic token — admin only
  app.post("/api/set-token", requireAdmin, (req, res) => {
    const { token } = req.body;
    if (!token || typeof token !== "string" || token.length < 20) {
      return res.status(400).json({ error: "Invalid token" });
    }
    setManualToken(token.trim());
    res.json({ success: true, message: "Token saved." });
  });

  // Token status — auth required (sidebar uses this)
  app.get("/api/token-status", requireAuth, (_req, res) => {
    res.json(getTokenStatus());
  });

  // Internal use only — not exposed to frontend
  // Token is stored server-side; never returned to client
  app.post("/api/internal/refresh-token", requireAdmin, async (_req, res) => {
    try {
      // Routes through Decodo residential proxy — bypasses Kinetic's datacenter IP block
      await refreshTokenFromApi();
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: `Refresh failed: ${e.message}` });
    }
  });

  // Manager+ can run fiber checks and scans
  app.post("/api/check-fiber", requireManager, async (req, res) => {
    const { address, city, state = "NC", zip } = req.body;
    if (!address || !city || !zip) return res.status(400).json({ error: "address, city, zip required" });

    const result = await scanAddress(address, city, state, zip);

    // Log to history
    storage.createFiberCheck({
      address: `${address}, ${city}, ${state} ${zip}`,
      lat: result.lat, lng: result.lng,
      result: JSON.stringify(result.rawResponse ?? result),
      fiberAvailable: result.fiberAvailable,
      isNewFiber: result.isNewFiber,
      isTenured: result.isTenured,
      householdSegmentType: result.householdSegmentType,
      billingStatus: result.billingStatus,
      techType: result.techType,
      speedTier: result.speedTier,
      maxDownload: result.maxDownloadMbps,
      competitorName: result.competitorName,
      addressCatalogDate: result.addressCatalogDate,
      apiSource: result.apiSource,
    });

    // Strip internal/proprietary fields before sending to client
    res.json(sanitizeFiberResult(result));
  });

  // Draw-area scan — accepts a bounding box {minLat, maxLat, minLng, maxLng}
  // Filters the master address list to addresses whose streets are in that area
  // then starts a background scan job just like /api/scan/start
  // Serve the GIS address list to the browser scanner (requireAuth — any logged-in user)


  // ── Download standalone scanner HTML ──
  app.get("/api/scan/scanner-download", requireManager, (_req, res) => {
    // In production: dist/index.cjs lives in dist/, scanner is at project root
    // In dev: server/ lives in server/, scanner is at project root
    const scannerPath = path.join(__dirname, "..", "standalone-scanner.html");
    const fallbackPath = path.join(process.cwd(), "standalone-scanner.html");
    const resolvedPath = fs.existsSync(scannerPath) ? scannerPath : fallbackPath;
    if (!fs.existsSync(resolvedPath)) {
      return res.status(404).json({ error: "Scanner file not found" });
    }
    // The Kinetic credential is a placeholder in source (never committed to git).
    // Inject the real value from env at download time. Falls back to the main
    // scan auth credential since it's the same Kinetic account.
    let html = fs.readFileSync(resolvedPath, "utf-8");
    const kineticBasic = process.env.SCANNER_KINETIC_BASIC || process.env.KFS_AUTH_BASIC || "";
    html = html.split("__KINETIC_BASIC__").join(kineticBasic);
    res.setHeader("Content-Disposition", "attachment; filename=kfs-rockwell-scanner.html");
    res.setHeader("Content-Type", "text/html");
    res.send(html);
  });

  // ── Bookmarklet/standalone scanner submit endpoint ──
  // Accepts leads from the standalone scanner HTML page running in user's own browser.
  // Uses a shared secret key instead of session auth (since it's a separate browser tab).
  // POST /api/scan/submit-leads  { secret: string, leads: LeadPayload[] }
  app.post("/api/scan/submit-leads", (req, res) => {
    const submitSecret = process.env.SCANNER_SUBMIT_SECRET;
    if (!submitSecret) return res.status(503).json({ error: "Submit secret not configured" });

    const { secret, leads: incomingLeads } = req.body;
    // Use timingSafeEqual to prevent timing-based secret enumeration attacks
    if (!secret || typeof secret !== "string") {
      return res.status(401).json({ error: "Invalid secret" });
    }
    const secretBuf = Buffer.from(secret);
    const expectedBuf = Buffer.from(submitSecret);
    const secretsMatch = secretBuf.length === expectedBuf.length &&
      crypto.timingSafeEqual(secretBuf, expectedBuf);
    if (!secretsMatch) {
      return res.status(401).json({ error: "Invalid secret" });
    }
    if (!Array.isArray(incomingLeads) || incomingLeads.length === 0) {
      return res.status(400).json({ error: "No leads provided" });
    }

    const saved: any[] = [];
    const skipped: string[] = [];

    for (const l of incomingLeads) {
      // Only accept NEW FIBER leads where customer does not have service
      if (!l.isNewFiber || l.billingStatus !== "N") {
        skipped.push(l.address || "unknown");
        continue;
      }
      // Check for duplicate
      const existing = storage.getLeads().find(
        (ex: any) => ex.address?.toLowerCase() === (l.address || "").toLowerCase()
      );
      if (existing) {
        skipped.push(l.address);
        continue;
      }
      try {
        const lead = storage.createLead({
          address: l.address,
          city: l.city || "Rockwell",
          state: l.state || "NC",
          zip: l.zip || "28138",
          lat: l.lat ?? null,
          lng: l.lng ?? null,
          fiberStatus: "new_fiber",
          isNewFiber: true,
          isTenured: false,
          billingStatus: "N",
          speedTier: l.speedTier ?? null,
          maxDownloadMbps: l.maxDownloadMbps ?? null,
          techType: l.techType ?? "FIBER",
          chipSetType: l.chipSetType ?? null,
          dfAddressId: l.dfAddressId ?? null,
          accessId: l.accessId ?? null,
          exchangeId: l.exchangeId ?? null,
          leadStatus: "prospect",
        });
        saved.push(lead);
      } catch (err: any) {
        skipped.push(l.address);
      }
    }

    res.json({ saved: saved.length, skipped: skipped.length, leads: saved });
  });

  app.get("/api/scan/addresses", requireAuth, (_req, res) => {
    res.json(loadGisAddresses());
  });

  app.post("/api/scan/area", requireManager, scanLimiter, (req, res) => {
    const { minLat, maxLat, minLng, maxLng, city = "Rockwell", zip = "28138", state = "NC" } = req.body;
    if (minLat == null || maxLat == null || minLng == null || maxLng == null) {
      return res.status(400).json({ error: "minLat, maxLat, minLng, maxLng required" });
    }
    // We don't have real coords for unscanned addresses, so we use the bounding
    // box to do a rough street-name filter based on known street approximate coords.
    // For now: generate all addresses for the city and tag them for scanning —
    // the bbox is used post-scan to only surface dots inside the drawn area.
    // Store the bbox with the job so the frontend can filter rendered dots.
    const jobId = `scan_${Date.now()}`;
    const addresses = generateAddresses(zip, city);
    scanJobs.set(jobId, {
      id: jobId, city, zip, status: "running",
      total: addresses.length, done: 0, results: [],
      startedAt: new Date().toISOString(),
      bbox: { minLat: Number(minLat), maxLat: Number(maxLat), minLng: Number(minLng), maxLng: Number(maxLng) },
    });
    runCityScan(jobId, addresses);
    res.json({ jobId, total: addresses.length, bbox: { minLat, maxLat, minLng, maxLng } });
  });

  // City scan — start (Mapbox-native address harvesting for Rockwell)
  app.post("/api/scan/start", requireManager, scanLimiter, async (req, res) => {
    const { city = "Rockwell", zip = "28138", state = "NC", useMapbox = true } = req.body;
    const jobId = `scan_${Date.now()}`;
    const mapboxToken = process.env.MAPBOX_TOKEN ?? "";

    // For Rockwell: use Mapbox reverse-geocoding grid for complete, GIS-free coverage.
    // For other cities: use Overpass / GIS fallback.
    let addresses: { address: string; city: string; state: string; zip: string; lat: number; lng: number }[];
    const isRockwell = city.toLowerCase().includes("rockwell");

    if (isRockwell && useMapbox && mapboxToken) {
      // Start job immediately with estimated total, harvest addresses in background
      const estimatedTotal = getRockwellGridSize() * 3; // ~3 addresses per grid point
      scanJobs.set(jobId, {
        id: jobId, city, zip, status: "running",
        total: estimatedTotal, done: 0, results: [],
        startedAt: new Date().toISOString(),
      });
      res.json({ jobId, total: estimatedTotal, source: "mapbox" });

      // Harvest addresses then scan — fully background
      (async () => {
        try {
          const job = scanJobs.get(jobId)!;
          const mapboxAddresses = await harvestRockwellAddresses(
            mapboxToken,
            (done, total, found) => {
              if (job) {
                job.total = found + (total - done) * 2; // dynamic estimate
              }
            }
          );
          // Deduplicate against existing leads before scanning.
          // Use normalizeAddrForDedup() to expand abbreviations so
          // "Bell Ridge Court" (Mapbox) matches "Bell Ridge Ct" (DB canonical).
          const existingAddrs = new Set(
            storage.getLeads().map(l => normalizeAddrForDedup(l.address))
          );
          const newAddresses = mapboxAddresses.filter(
            a => !existingAddrs.has(normalizeAddrForDedup(a.address))
          );
          if (job) {
            job.total = newAddresses.length;
            job.done = 0;
          }
          await runCityScan(jobId, newAddresses as any);
        } catch (err: any) {
          const job = scanJobs.get(jobId);
          if (job) job.status = "done";
        }
      })();
    } else {
      // Non-Rockwell city: Overpass → GIS fallback
      try {
        const overpass = await getCityAddresses(city, state);
        addresses = overpass.addresses.length > 0 ? overpass.addresses as any : generateAddresses(zip, city) as any;
      } catch {
        addresses = generateAddresses(zip, city) as any;
      }
      scanJobs.set(jobId, {
        id: jobId, city, zip, status: "running",
        total: addresses.length, done: 0, results: [],
        startedAt: new Date().toISOString(),
      });
      runCityScan(jobId, addresses as any);
      res.json({ jobId, total: addresses.length, source: "overpass" });
    }
  });

  // GET /api/scan/mapbox-harvest/preview — estimate how many addresses Mapbox will return for Rockwell
  app.get("/api/scan/mapbox-harvest/preview", requireManager, (_req, res) => {
    const gridSize = getRockwellGridSize();
    res.json({
      gridPoints: gridSize,
      estimatedAddresses: `${gridSize * 2}–${gridSize * 4}`,
      source: "Mapbox Geocoding API",
      bbox: { minLng: -80.455, maxLng: -80.360, minLat: 35.515, maxLat: 35.582 },
    });
  });

  // City scan — poll status + results
  // ── City Address Pull (must be BEFORE :jobId wildcard) ─────────────────────
  // GET /api/scan/city-addresses — For Rockwell uses Mapbox grid; other cities use Overpass
  app.get("/api/scan/city-addresses", requireManager, async (req, res) => {
    const { city, state } = req.query;
    if (!city || typeof city !== "string") return res.status(400).json({ error: "city required" });
    const st = typeof state === "string" ? state : "NC";
    const isRockwell = city.trim().toLowerCase().includes("rockwell");
    const mbToken = process.env.MAPBOX_TOKEN ?? "";

    try {
      if (isRockwell && mbToken) {
        // Mapbox grid reverse-geocoding — full residential coverage, no GIS file needed
        const addrs = await harvestRockwellAddresses(mbToken);
        res.json({
          count: addrs.length,
          cityName: "Rockwell, NC",
          source: "mapbox",
          center: { lat: 35.549, lng: -80.408 },
          bbox: { minLat: 35.515, maxLat: 35.582, minLng: -80.455, maxLng: -80.360 },
          addresses: addrs,
        });
      } else {
        // Live OSM first; if it fails/empties (public Overpass is flaky), fall
        // back to the Mapbox grid so "Pull Addresses" always returns something.
        let result: { addresses: any[]; cityName: string; center: any; bbox: any } | null = null;
        try { result = await getCityAddresses(city.trim(), st.trim()); } catch { result = null; }
        if ((!result || result.addresses.length === 0) && mbToken) {
          const r = await harvestCityAddresses(city.trim(), st.trim(), mbToken);
          return res.json({ count: r.addresses.length, cityName: `${city}, ${st}`, source: "mapbox", center: null, bbox: null, addresses: r.addresses });
        }
        if (!result) throw new Error("Address lookup failed — OpenStreetMap unavailable and no Mapbox token set.");
        res.json({
          count: result.addresses.length,
          cityName: result.cityName,
          source: "overpass",
          center: result.center,
          bbox: result.bbox,
          addresses: result.addresses,
        });
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/scan/start-city — scan with pre-pulled addresses or pull them fresh
  app.post("/api/scan/start-city", requireManager, async (req, res) => {
    const { city, state, addresses: providedAddresses } = req.body;
    if (!city) return res.status(400).json({ error: "city required" });
    const st = state ?? "NC";
    const isRockwell = city.trim().toLowerCase().includes("rockwell");
    const mbToken = process.env.MAPBOX_TOKEN ?? "";

    // Address source, ordered for reliability + low cost. Live OpenStreetMap
    // (Overpass) is tried first (free, any city, fresh data). If OSM is slow or
    // sparse we fall back to the Mapbox grid (reliable, one-time cost — then the
    // pool re-scans for free). The local GIS parcel file is only a last-ditch
    // safety net for Rockwell. Pass { source: "mapbox" } to skip straight to Mapbox.
    const preferMapbox = req.body.source === "mapbox";
    let addresses: any[] = [];
    let usedSource = "overpass";
    try {
      if (providedAddresses && Array.isArray(providedAddresses) && providedAddresses.length > 0) {
        addresses = providedAddresses; usedSource = "manual";
      } else if (!preferMapbox) {
        // 1) Live OSM (free) — fails fast (~28s) so it can't hang the scan.
        try {
          const result = await getCityAddresses(city.trim(), st.trim());
          addresses = result.addresses ?? [];
        } catch { addresses = []; }
        // 2) Mapbox grid fallback — reliable coverage when OSM is slow/sparse.
        if (addresses.length === 0 && mbToken) {
          addresses = isRockwell
            ? await harvestRockwellAddresses(mbToken)
            : (await harvestCityAddresses(city.trim(), st.trim(), mbToken)).addresses;
          usedSource = "mapbox";
        }
        // 3) GIS parcel file — last resort for Rockwell only.
        if (addresses.length === 0 && isRockwell) { addresses = loadGisAddresses(); usedSource = "gis"; }
      } else if (mbToken) {
        addresses = isRockwell
          ? await harvestRockwellAddresses(mbToken)
          : (await harvestCityAddresses(city.trim(), st.trim(), mbToken)).addresses;
        usedSource = "mapbox";
      } else {
        const result = await getCityAddresses(city.trim(), st.trim());
        addresses = result.addresses;
      }
    } catch (err: any) {
      return res.status(500).json({ error: `Address pull failed: ${err.message}` });
    }

    if (addresses.length === 0) return res.status(400).json({ error: "No addresses found for this city" });

    // Persist the FULL harvested set to the address pool (geocoded once → free to
    // re-scan later). Duplicates are ignored, so the pool only ever grows.
    try {
      const src = usedSource;
      storage.upsertScanTargets(addresses.map((a: any) => ({
        address: a.address, city: a.city ?? city, state: a.state ?? st,
        zip: a.zip ?? "", lat: a.lat ?? null, lng: a.lng ?? null, source: src,
      })));
    } catch {}

    // Dedup against existing leads (normalize suffixes for Court/Ct, Drive/Dr, etc.)
    const existingSet = new Set(storage.getLeads().map((l: any) => normalizeAddrForDedup(l.address)));
    const newAddrs = addresses.filter((a: any) => !existingSet.has(normalizeAddrForDedup(a.address || "")));

    const jobId = `city_${city.toLowerCase().replace(/\s+/g, "_")}_${Date.now()}`;
    const job: ScanJob = {
      id: jobId, city: `${city}, ${st}`, zip: "",
      status: "running", total: newAddrs.length, done: 0, results: [],
      startedAt: new Date().toISOString(),
    };
    scanJobs.set(jobId, job);
    runCityScan(jobId, newAddrs).catch(() => {});
    res.json({ jobId, total: newAddrs.length, city: `${city}, ${st}` });
  });

  // GET /api/scan/pool-stats — size of the persistent address pool
  app.get("/api/scan/pool-stats", requireManager, (_req, res) => {
    res.json(storage.getScanTargetStats());
  });

  // POST /api/scan/rescan-pool — re-scan the stored address pool for CHANGES.
  // Uses zero geocoding (addresses are already stored), dedups against existing
  // leads, and surfaces newly-lit fiber as fresh leads. This is the cheap,
  // repeatable "detect new fiber" engine (FiberFocus model).
  app.post("/api/scan/rescan-pool", requireManager, scanLimiter, (req, res) => {
    const limit = Math.min(Number(req.body?.limit) || 50000, 100000);
    const targets = storage.getScanTargetsToRescan(limit);
    if (!targets.length) {
      return res.status(400).json({ error: "Address pool is empty. Run a city scan first to build it." });
    }
    // Only re-check addresses that aren't already leads → surfaces new fiber only.
    const existingSet = new Set(storage.getLeads().map((l: any) => normalizeAddrForDedup(l.address)));
    const toScan = targets
      .filter((t: any) => !existingSet.has(normalizeAddrForDedup(t.address || "")))
      .map((t: any) => ({ address: t.address, city: t.city, state: t.state, zip: t.zip, lat: t.lat, lng: t.lng }));
    if (!toScan.length) {
      return res.json({ jobId: null, total: 0, source: "pool", message: "Every pooled address is already a lead — nothing new to check." });
    }
    const jobId = `rescan_${Date.now()}`;
    const job: ScanJob = {
      id: jobId, city: "Address pool re-scan", zip: "",
      status: "running", total: toScan.length, done: 0, results: [],
      startedAt: new Date().toISOString(),
    };
    scanJobs.set(jobId, job);
    runCityScan(jobId, toScan).catch(() => {});
    res.json({ jobId, total: toScan.length, source: "pool" });
  });

  // SSE: real-time scan stream — registered BEFORE :jobId wildcard
  app.get("/api/scan/stream/:jobId", requireManager, (req, res) => {
    const jobId = req.params.jobId;
    const job = scanJobs.get(jobId);
    if (!job) return res.status(404).json({ error: "Job not found" });

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    let lastSent = 0;
    function sendState() {
      const r = job!;
      const newResults = r.results.slice(lastSent);
      if (newResults.length > 0) {
        for (const result of newResults) {
          res.write(`event: result\ndata: ${JSON.stringify(result)}\n\n`);
        }
        lastSent = r.results.length;
      }
      const progress = {
        jobId: r.id, status: r.status, done: r.done, total: r.total,
        summary: {
          new_fiber:     r.results.filter(x => x.fiberStatus === "new_fiber").length,
          tenured_fiber: r.results.filter(x => x.fiberStatus === "tenured_fiber").length,
          no_service:    r.results.filter(x => x.fiberStatus === "no_service").length,
          eligible:      r.results.filter(x => x.fiberStatus === "new_fiber").length,
        }
      };
      res.write(`event: progress\ndata: ${JSON.stringify(progress)}\n\n`);
      if (r.status === "done" || r.status === "error") {
        res.write(`event: done\ndata: ${JSON.stringify({ status: r.status })}\n\n`);
        clearInterval(timer);
        res.end();
      }
    }
    const timer = setInterval(sendState, 1000);
    sendState();
    req.on("close", () => clearInterval(timer));
  });

  app.get("/api/scan/:jobId", requireManager, (req, res) => {
    const job = scanJobs.get(req.params.jobId);
    const _sjTid = (req as any).user?.tenantId;
    if (!job || (_sjTid && job.tenantId !== _sjTid)) return res.status(404).json({ error: "Not found" });
    const r = job.results;
    res.json({
      ...job,
      summary: {
        new_fiber:      r.filter(x => x.fiberStatus === "new_fiber").length,
        tenured_fiber:  r.filter(x => x.fiberStatus === "tenured_fiber").length,
        existing_fiber: r.filter(x => x.fiberStatus === "existing_fiber").length,
        copper:         r.filter(x => x.fiberStatus === "copper").length,
        no_service:     r.filter(x => x.fiberStatus === "no_service").length,
        unknown:        r.filter(x => x.fiberStatus === "unknown").length,
        // Eligible = NEW FIBER + not subscribed — these become dots on map + saved leads
        eligible:       r.filter(x => x.fiberStatus === "new_fiber").length,
        scanned:        job.done,
        remaining:      job.total - job.done,
      }
    });
  });

  app.delete("/api/scan/:jobId", requireManager, (req, res) => {
    scanJobs.delete(req.params.jobId);
    res.json({ success: true });
  });

  app.get("/api/scan", requireManager, (req, res) => {
    res.json(Array.from(scanJobs.values()).map(j => ({
      id: j.id, city: j.city, zip: j.zip, status: j.status,
      total: j.total, done: j.done, startedAt: j.startedAt, completedAt: j.completedAt,
    })));
  });

  // Fiber check history
  app.get("/api/fiber-checks", requireAuth, (req, res) => res.json(storage.getRecentChecks(100)));

  // ── Team Members ─────────────────────────────────────────────────────────────
  app.get("/api/team", requireAuth, (req, res) => {
    const tid = (req as any).user?.tenantId ?? undefined;
    res.json(storage.getTeamMembers(tid));
  });
  // Team lead, manager, and admin can add/edit reps
  app.post("/api/team", requireTeamLead, (req, res) => {
    const parsed = insertTeamMemberSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error });
    res.status(201).json(storage.createTeamMember(parsed.data));
  });
  app.patch("/api/team/:id", requireTeamLead, (req, res) => {
    const tid = (req as any).user?.tenantId ?? undefined;
    const id = Number(req.params.id);
    // A member cannot report to themselves
    if (req.body?.reportsToId != null && Number(req.body.reportsToId) === id) {
      return res.status(400).json({ error: "A member cannot report to themselves" });
    }
    const updated = storage.updateTeamMember(id, req.body, tid);
    if (!updated) return res.status(404).json({ error: "Not found" });
    res.json(updated);
  });
  // Only manager+ can delete reps
  app.delete("/api/team/:id", requireManager, (req, res) => {
    const tid = (req as any).user?.tenantId ?? undefined;
    if (!storage.deleteTeamMember(Number(req.params.id), tid)) return res.status(404).json({ error: "Not found" });
    res.json({ success: true });
  });

  // ── Lead → Assign rep ─────────────────────────────────────────────────────────
  // Team lead+ can assign leads
  app.post("/api/leads/:id/assign", requireTeamLead, (req, res) => {
    const { repId } = req.body;
    const tid = (req as any).user?.tenantId ?? undefined;
    const updated = storage.updateLead(Number(req.params.id), { assignedRepId: repId ?? null }, tid);
    if (!updated) return res.status(404).json({ error: "Not found" });
    res.json(updated);
  });

  // ── Bulk assign leads to a rep (lasso selection) ────────────────────────────
  // POST /api/leads/bulk-assign  { leadIds: number[], repId: number | null }
  app.post("/api/leads/bulk-assign", requireTeamLead, (req, res) => {
    const { leadIds, repId } = req.body as { leadIds: number[]; repId: number | null };
    if (!Array.isArray(leadIds) || leadIds.length === 0) return res.status(400).json({ error: "leadIds required" });
    const tid = (req as any).user?.tenantId ?? undefined;
    let updated = 0;
    for (const id of leadIds) {
      const result = storage.updateLead(id, { assignedRepId: repId ?? null }, tid);
      if (result) updated++;
    }
    res.json({ updated, repId });
  });

  // ── Lead Enrichment ──────────────────────────────────────────────────────────
  // GET  /api/leads/:id/enrichment  — fetch+store enrichment data for a lead
  app.get("/api/leads/:id/enrichment", requireAuth, async (req, res) => {
    const lead = storage.getLeadById(Number(req.params.id));
    const _user = (req as any).user;
    const _tid = _user?.tenantId;
    if (!lead || (_tid && lead.tenantId !== _tid)) return res.status(404).json({ error: "Not found" });
    if (!repCanAccessLead(_user, lead)) return res.status(404).json({ error: "Not found" });

    // 1. GIS owner lookup — match address prefix against rockwell_gis_addresses.json
    //    The GIS file has raw parcel data; we do a fuzzy number+street match.
    let ownerName: string | null = null;
    try {
      const gisPath = path.join(__dirname, "rockwell_gis_addresses.json");
      if (fs.existsSync(gisPath)) {
        const gisData = JSON.parse(fs.readFileSync(gisPath, "utf8")) as Array<{
          address: string; city: string; state: string; zip: string;
          lat?: number; lng?: number; ownerName?: string; owner?: string;
          parcelOwner?: string; owner_name?: string;
        }>;
        // Normalize the lead address for comparison
        const normLead = lead.address.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
        const match = gisData.find(g => {
          const normGis = g.address.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
          return normGis === normLead;
        });
        if (match) {
          ownerName = match.ownerName ?? match.owner ?? match.parcelOwner ?? match.owner_name ?? null;
        }
      }
    } catch (e) { console.warn("GIS owner lookup failed:", e); }

    // 2. Census ACS API — median household income & home value for ZIP 28138
    //    Variables: B19013_001E = median household income, B25077_001E = median home value
    //    This is a single call for the whole ZIP (not per-address — same data for all leads in 28138)
    let incomeRange: string | null = null;
    let homeValue: string | null = null;
    try {
      const zip = encodeURIComponent(lead.zip || "28138");
      const censusUrl = `https://api.census.gov/data/2022/acs/acs5?get=B19013_001E,B25077_001E&for=zip+code+tabulation+area:${zip}&key=DEMO_KEY`;
      const resp = await fetch(censusUrl, { signal: AbortSignal.timeout(8000) });
      if (resp.ok) {
        const data = await resp.json() as string[][];
        if (data.length >= 2) {
          const medIncome = parseInt(data[1][0], 10);
          const medHome = parseInt(data[1][1], 10);
          if (!isNaN(medIncome) && medIncome > 0) {
            // Bucket into range
            const lo = Math.floor(medIncome / 10000) * 10000;
            const hi = lo + 10000;
            incomeRange = `$${(lo / 1000).toFixed(0)}k\u2013$${(hi / 1000).toFixed(0)}k`;
          }
          if (!isNaN(medHome) && medHome > 0) {
            const lo = Math.floor(medHome / 25000) * 25000;
            const hi = lo + 25000;
            homeValue = `$${lo.toLocaleString()}\u2013$${hi.toLocaleString()}`;
          }
        }
      }
    } catch (e) { console.warn("Census API failed:", e); }

    // 3. Persist enrichment data to lead row (only update fields we got)
    const enrichmentUpdate: Record<string, unknown> = { enrichedAt: new Date().toISOString() };
    if (ownerName) enrichmentUpdate.ownerName = ownerName;
    if (incomeRange) enrichmentUpdate.incomeRange = incomeRange;
    if (homeValue) enrichmentUpdate.homeValue = homeValue;
    const updated = storage.updateLead(lead.id, enrichmentUpdate as any);

    res.json({
      ownerName: ownerName ?? lead.ownerName ?? null,
      ownerPhone: lead.ownerPhone ?? null,
      ownerEmail: lead.ownerEmail ?? null,
      incomeRange: incomeRange ?? lead.incomeRange ?? null,
      homeValue: homeValue ?? lead.homeValue ?? null,
      yearsAtAddress: lead.yearsAtAddress ?? null,
      isHomeowner: lead.isHomeowner ?? null,
      enrichedAt: new Date().toISOString(),
      // Competition
      competitorName: lead.competitorName ?? null,
      competitorSpeedMbps: lead.competitorSpeedMbps ?? null,
      competitorTech: lead.competitorTech ?? null,
      inCompetitorArea: lead.inCompetitorArea ?? false,
      // Fiber
      fiberStatus: lead.fiberStatus,
      isNewFiber: lead.isNewFiber,
      speedTier: lead.speedTier,
      maxDownloadMbps: lead.maxDownloadMbps,
      techType: lead.techType,
    });
  });

  // PATCH /api/leads/:id/enrichment — manually update owner contact info
  app.patch("/api/leads/:id/enrichment", requireTeamLead, (req, res) => {
    const { ownerName, ownerPhone, ownerEmail, yearsAtAddress, isHomeowner } = req.body;
    const lead = storage.getLeadById(Number(req.params.id));
    const _etid = (req as any).user?.tenantId;
    if (!lead || (_etid && lead.tenantId !== _etid)) return res.status(404).json({ error: "Not found" });
    const updated = storage.updateLead(lead.id, {
      ownerName: ownerName ?? lead.ownerName,
      ownerPhone: ownerPhone ?? lead.ownerPhone,
      ownerEmail: ownerEmail ?? lead.ownerEmail,
      yearsAtAddress: yearsAtAddress ?? lead.yearsAtAddress,
      isHomeowner: isHomeowner ?? lead.isHomeowner,
    } as any);
    res.json(updated);
  });

  // ── Knock log ────────────────────────────────────────────────────────────────
  app.get("/api/leads/:id/knocks", requireAuth, (req, res) => {
    const user = (req as any).user;
    // Reps can only see knock history for their own assigned leads
    if (user?.role === "rep") {
      const lead = storage.getLeadById(Number(req.params.id));
      if (!repCanAccessLead(user, lead)) return res.status(404).json({ error: "Not found" });
    }
    res.json(storage.getKnocksByLead(Number(req.params.id)));
  });
  // Any authenticated rep can log a knock
  app.post("/api/leads/:id/knock", requireAuth, (req, res) => {
    const _knu = (req as any).user;
    // Reps can only log knocks on leads assigned to them
    if (_knu?.role === "rep") {
      const _knl = storage.getLeadById(Number(req.params.id));
      if (!repCanAccessLead(_knu, _knl)) return res.status(404).json({ error: "Not found" });
    }
    const parsed = insertKnockSchema.safeParse({ ...req.body, leadId: Number(req.params.id) });
    if (!parsed.success) return res.status(400).json({ error: parsed.error });
    const knock = storage.createKnock(parsed.data);
    // Update lead status to match knock outcome
    const outcomeToStatus: Record<string, string> = {
      sold: "sold",
      interested: "interested",
      callback: "follow_up",
      not_interested: "not_interested",
      not_home: "prospect",
    };
    const newStatus = outcomeToStatus[parsed.data.outcome];
    if (newStatus) storage.updateLead(Number(req.params.id), { leadStatus: newStatus });
    // Auto-create pending commission when outcome = sold
    if (parsed.data.outcome === "sold" && parsed.data.repId) {
      try {
        const rates = storage.getCommissionRates();
        const rep = storage.getTeamMemberById(parsed.data.repId);
        const rate = rates.find(r => r.repId === parsed.data.repId) ??
          rates.find(r => r.role === rep?.role) ??
          rates[0];
        if (rate) {
          storage.createCommission({
            repId: parsed.data.repId,
            leadId: Number(req.params.id),
            knockId: knock.id,
            amount: rate.ratePerSale,
            saleDate: new Date().toISOString().slice(0, 10),
            status: "pending",
            notes: `Auto: knock #${knock.id}`,
            approvedBy: null,
            paidDate: null,
          });
        }
        storage.logActivity((req as any).user?.id ?? null, "commission.auto_created", "knock", knock.id, { repId: parsed.data.repId, leadId: Number(req.params.id) }, req.ip);
      } catch (e) { console.warn("Auto-commission failed:", e); }
    }
    storage.logActivity((req as any).user?.id ?? null, `knock.${parsed.data.outcome}`, "knock", knock.id, { leadId: Number(req.params.id), repId: parsed.data.repId }, req.ip);
    res.status(201).json(knock);
  });

  // ── Leaderboard ──────────────────────────────────────────────────────────────
  app.get("/api/leaderboard", requireAuth, (_req, res) => {
    res.json(storage.getLeaderboard());
  });

  // Stats
  app.get("/api/stats", requireAuth, (req, res) => {
    const _su = (req as any).user;
    const all = storage.getLeads(_su?.tenantId ?? undefined, repLeadScope(_su));
    const stats: any = { total: all.length, byStatus: {}, byFiberStatus: {}, newFiber: 0, tenured: 0, sold: 0 };
    for (const l of all) {
      stats.byStatus[l.leadStatus] = (stats.byStatus[l.leadStatus] || 0) + 1;
      stats.byFiberStatus[l.fiberStatus] = (stats.byFiberStatus[l.fiberStatus] || 0) + 1;
      if (l.isNewFiber) stats.newFiber++;
      if (l.isTenured) stats.tenured++;
      if (l.leadStatus === "sold") stats.sold++;
    }
    res.json(stats);
  });

  // ── AUTH ─────────────────────────────────────────────────────────────────────

  // Check if first run (no admin yet)
  app.get("/api/auth/status", (req, res) => {
    const isFirstRun = storage.isFirstRun();
    // Also check if requester is authed
    const token = req.headers["x-session-id"] as string;
    let currentUser = null;
    if (token) {
      const session = storage.getSession(token);
      if (session) {
        const u = storage.getUserById(session.userId);
        if (u) currentUser = { id: u.id, name: u.name, email: u.email, role: u.role, teamMemberId: u.teamMemberId };
      }
    }
    res.json({ isFirstRun, currentUser });
  });

  // ── Rate limiting maps (in-memory, per IP + per email) ───────────────────────
  // Tracks: { attempts, firstAttempt, lockedUntil }
  const otpRequestLimiter = new Map<string, { count: number; windowStart: number; lockedUntil: number }>();
  const otpVerifyLimiter  = new Map<string, { count: number; windowStart: number; lockedUntil: number }>();

  const OTP_REQUEST_MAX  = 5;   // max requests per email per window
  const OTP_VERIFY_MAX   = 5;   // max verify attempts per email per window
  const RATE_WINDOW_MS   = 15 * 60 * 1000; // 15 minutes
  const LOCKOUT_MS       = 30 * 60 * 1000; // 30 min lockout after too many attempts

  function checkRateLimit(map: typeof otpRequestLimiter, key: string, max: number): { allowed: boolean; retryAfter?: number } {
    const now = Date.now();
    let entry = map.get(key);
    if (!entry) { entry = { count: 0, windowStart: now, lockedUntil: 0 }; map.set(key, entry); }
    // Still locked?
    if (entry.lockedUntil > now) return { allowed: false, retryAfter: Math.ceil((entry.lockedUntil - now) / 1000) };
    // Reset window if expired
    if (now - entry.windowStart > RATE_WINDOW_MS) { entry.count = 0; entry.windowStart = now; }
    entry.count++;
    if (entry.count > max) {
      entry.lockedUntil = now + LOCKOUT_MS;
      return { allowed: false, retryAfter: Math.ceil(LOCKOUT_MS / 1000) };
    }
    return { allowed: true };
  }

  // Clean up rate limit maps every hour to avoid memory leaks
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of otpRequestLimiter) if (now - v.windowStart > LOCKOUT_MS * 2) otpRequestLimiter.delete(k);
    for (const [k, v] of otpVerifyLimiter)  if (now - v.windowStart > LOCKOUT_MS * 2) otpVerifyLimiter.delete(k);
  }, 60 * 60 * 1000);

  // ── Universal OTP login — works for ALL roles (admin, manager, team_lead, rep) ──

  // Step 1: Request OTP code (email)
  app.post("/api/auth/otp/request", async (req, res) => {
    const { email } = req.body;
    if (!email || typeof email !== "string" || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "Valid email required" });
    }
    const cleanEmail = email.trim().toLowerCase();
    // IP + email rate limiting
    const ip = (req.headers["x-forwarded-for"] as string ?? req.socket.remoteAddress ?? "unknown").split(",")[0].trim();
    const ipCheck = checkRateLimit(otpRequestLimiter, `ip:${ip}`, OTP_REQUEST_MAX);
    const emailCheck = checkRateLimit(otpRequestLimiter, `email:${cleanEmail}`, OTP_REQUEST_MAX);
    if (!ipCheck.allowed || !emailCheck.allowed) {
      const retryAfter = Math.max(ipCheck.retryAfter ?? 0, emailCheck.retryAfter ?? 0);
      res.setHeader("Retry-After", String(retryAfter));
      return res.status(429).json({ error: `Too many requests. Try again in ${Math.ceil(retryAfter / 60)} minutes.` });
    }
    // Always respond the same way — never reveal if email exists
    const user = storage.getUserByEmail(cleanEmail);
    if (user && user.active) {
      const code = storage.createOtp(cleanEmail);
      await sendOtpEmail(cleanEmail, code, user.name);
    }
    // Constant-time response regardless of whether user exists
    res.json({ sent: true });
  });

  // Step 2: Verify OTP code
  app.post("/api/auth/otp/verify", (req, res) => {
    const { email, code } = req.body;
    if (!email || typeof email !== "string" || email.length > 254) return res.status(400).json({ error: "Invalid request" });
    if (!code || typeof code !== "string" || !/^\d{6}$/.test(code.trim())) return res.status(400).json({ error: "Code must be 6 digits" });
    const cleanEmail = email.trim().toLowerCase();
    // Rate limit verify attempts per email
    const ip = (req.headers["x-forwarded-for"] as string ?? req.socket.remoteAddress ?? "unknown").split(",")[0].trim();
    const ipCheck = checkRateLimit(otpVerifyLimiter, `ip:${ip}`, OTP_VERIFY_MAX);
    const emailCheck = checkRateLimit(otpVerifyLimiter, `email:${cleanEmail}`, OTP_VERIFY_MAX);
    if (!ipCheck.allowed || !emailCheck.allowed) {
      const retryAfter = Math.max(ipCheck.retryAfter ?? 0, emailCheck.retryAfter ?? 0);
      res.setHeader("Retry-After", String(retryAfter));
      return res.status(429).json({ error: `Too many attempts. Try again in ${Math.ceil(retryAfter / 60)} minutes.` });
    }
    const ok = storage.verifyOtp(cleanEmail, code.trim());
    if (!ok) return res.status(401).json({ error: "Invalid or expired code. Check your email and try again." });
    const user = storage.getUserByEmail(cleanEmail);
    if (!user || !user.active) return res.status(401).json({ error: "Account not active. Contact your administrator." });
    // Reset verify limiter on success
    otpVerifyLimiter.delete(`email:${cleanEmail}`);
    otpVerifyLimiter.delete(`ip:${ip}`);
    const session = storage.createSession(user.id);
    res.json({ sessionId: session.id, user: { id: user.id, name: user.name, email: user.email, role: user.role, teamMemberId: user.teamMemberId } });
  });

  // Legacy password login — kept ONLY for first-run admin setup, disabled otherwise
  app.post("/api/auth/login", (_req, res) => {
    res.status(410).json({ error: "Password login is disabled. Use email code login." });
  });

  // Logout
  app.post("/api/auth/logout", (req, res) => {
    const token = req.headers["x-session-id"] as string;
    if (token) storage.deleteSession(token);
    res.json({ success: true });
  });

  // First-run admin setup (OTP-only — no password)
  app.post("/api/auth/setup", async (req, res) => {
    if (!storage.isFirstRun()) return res.status(403).json({ error: "Setup already completed" });
    const { name, email } = req.body;
    if (!name || typeof name !== "string" || name.trim().length < 2 || name.length > 100)
      return res.status(400).json({ error: "Valid name required" });
    if (!email || typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ error: "Valid email required" });
    const user = storage.createUser({ name: name.trim(), email: email.trim().toLowerCase(), passwordHash: "", role: "admin", active: true });
    // Send OTP immediately so admin can log in
    const code = storage.createOtp(user.email);
    await sendOtpEmail(user.email, code, user.name);
    res.json({ sent: true, message: "Admin account created. Check your email for a login code." });
  });

  // Admin: list all users
  app.get("/api/users", requireAdmin, (req, res) => {
    const tid = (req as any).user?.tenantId ?? undefined;
    const allUsers = storage.getAllUsers(tid).map(u => ({
      id: u.id, name: u.name, email: u.email, role: u.role, active: u.active, teamMemberId: u.teamMemberId,
    }));
    res.json(allUsers);
  });

  // Admin: create rep account
  app.post("/api/users", requireAdmin, async (req, res) => {
    const { name, email, teamMemberId } = req.body;
    if (!name || !email) return res.status(400).json({ error: "name and email required" });
    const existing = storage.getUserByEmail(email);
    if (existing) return res.status(409).json({ error: "Email already in use" });
    const user = storage.createUser({ name, email, role: "rep", active: true, teamMemberId: teamMemberId ?? null });
    res.status(201).json({ id: user.id, name: user.name, email: user.email, role: user.role });
  });

  // Admin: update user — allowlisted fields only (no passwordHash injection)
  app.patch("/api/users/:id", requireAdmin, (req, res) => {
    const ALLOWED_USER_FIELDS = new Set(["name", "email", "role", "active", "teamMemberId"]);
    const safeUpdate: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(req.body)) {
      if (ALLOWED_USER_FIELDS.has(k)) safeUpdate[k] = v;
    }
    if (Object.keys(safeUpdate).length === 0) {
      return res.status(400).json({ error: "No valid fields to update" });
    }
    // Validate role if provided
    if (safeUpdate.role && !["admin", "manager", "team_lead", "rep"].includes(safeUpdate.role as string)) {
      return res.status(400).json({ error: "Invalid role" });
    }
    const tid = (req as any).user?.tenantId ?? undefined;
    const updated = storage.updateUser(Number(req.params.id), safeUpdate as any, tid);
    if (!updated) return res.status(404).json({ error: "Not found" });
    res.json({ id: updated.id, name: updated.name, email: updated.email, role: updated.role, active: updated.active });
  });

  // Admin: delete user
  // Manager+ can remove rep login accounts
  app.delete("/api/users/:id", requireManager, (req, res) => {
    const tid = (req as any).user?.tenantId ?? undefined;
    const ok = storage.deleteUser(Number(req.params.id), tid);
    if (!ok) return res.status(404).json({ error: "Not found" });
    res.json({ success: true });
  });

  // ── TERRITORIES ───────────────────────────────────────────────────────────

  app.get("/api/territories", requireAuth, (req, res) => {
    const user = (req as any).user;
    // Admins and managers see all territories in their tenant
    if (user.role === "admin" || user.role === "manager" || user.role === "team_lead") {
      return res.json(storage.getTerritories(user.tenantId ?? undefined));
    }
    // Reps only see territories assigned to them — NEVER others' territories
    // If teamMemberId is null (not linked to a team member yet), return empty
    if (!user.teamMemberId || typeof user.teamMemberId !== "number") return res.json([]);
    return res.json(storage.getTerritoriesByRep(user.teamMemberId));
  });

  app.post("/api/territories", requireAdmin, (req, res) => {
    const parsed = insertTerritorySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error });
    res.status(201).json(storage.createTerritory(parsed.data));
  });

  app.patch("/api/territories/:id", requireAdmin, (req, res) => {
    const ttid = (req as any).user?.tenantId ?? undefined;
    const updated = storage.updateTerritory(Number(req.params.id), req.body, ttid);
    if (!updated) return res.status(404).json({ error: "Not found" });
    res.json(updated);
  });

  app.delete("/api/territories/:id", requireAdmin, (req, res) => {
    const ttid = (req as any).user?.tenantId ?? undefined;
    if (!storage.deleteTerritory(Number(req.params.id), ttid)) return res.status(404).json({ error: "Not found" });
    res.json({ success: true });
  });


  // ── Territory Requests ────────────────────────────────────────────────────
  // Rep submits a request for a new territory
  app.post("/api/territory-requests", requireAuth, (req, res) => {
    const session = storage.getSession(req.headers["x-session-id"] as string);
    const user = session ? storage.getUserById(session.userId) : null;
    if (!user) return res.status(401).json({ error: "Unauthorized" });

    const member = user.teamMemberId
      ? storage.getTeamMembers().find(m => m.id === user.teamMemberId)
      : null;
    if (!member) return res.status(400).json({ error: "Rep not linked to a team member record" });

    // Check for existing pending request from this rep
    const existing = storage.getTerritoryRequests("pending")
      .find(r => r.repId === member.id);
    if (existing) {
      return res.status(409).json({ error: "You already have a pending territory request." });
    }

    const { message } = req.body;
    const request = storage.createTerritoryRequest(member.id, user.id, message);

    // Email admin
    if (process.env.SMTP_USER) {
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT),
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      });
      transporter.sendMail({
        from: process.env.SMTP_USER,
        to: process.env.SMTP_USER,
        subject: `Territory Request — ${member.name}`,
        html: `
          <h2>New Territory Request</h2>
          <p><strong>${member.name}</strong> has finished their current territory and is requesting a new one.</p>
          ${message ? `<p><em>"${message}"</em></p>` : ""}
          <p>Log in to Fiber Scout → Map → Draw Territory to assign them a new area.</p>
        `,
      }).catch((e: any) => console.error("Email error:", e));
    }

    res.status(201).json(request);
  });

  // Get all territory requests (admin/manager) — enriched with rep name + territory name
  app.get("/api/territory-requests", requireManager, (req, res) => {
    const status = req.query.status as string | undefined;
    const requests = storage.getTerritoryRequests(status);
    const team = storage.getTeamMembers();
    const territories = storage.getTerritories();
    const enriched = requests.map(r => {
      const member = team.find(m => m.id === r.repId);
      // Find the territory currently assigned to this rep
      const currentTerritory = territories.find(t => t.repId === r.repId);
      return {
        ...r,
        notes: r.message,
        repName: member?.name ?? `Rep #${r.repId}`,
        currentTerritoryName: currentTerritory?.name ?? null,
      };
    });
    res.json(enriched);
  });

  // Dismiss or fulfill a request (admin/manager)
  app.patch("/api/territory-requests/:id", requireManager, (req, res) => {
    const { status } = req.body;
    if (!["fulfilled", "dismissed"].includes(status)) {
      return res.status(400).json({ error: "status must be fulfilled or dismissed" });
    }
    const updated = storage.updateTerritoryRequest(Number(req.params.id), status);
    if (!updated) return res.status(404).json({ error: "Not found" });
    res.json(updated);
  });

  // ── Public /join page — serve the HomeFront application form ────────────────
  app.get("/join", (_req, res) => {
    const joinPath = path.join(process.cwd(), "join-form", "index.html");
    const fallbackPath = path.join(__dirname, "..", "join-form", "index.html");
    const resolved = fs.existsSync(joinPath) ? joinPath : fallbackPath;
    if (!fs.existsSync(resolved)) {
      return res.status(404).send("Join form not found");
    }
    // Inject the server URL dynamically so form submits to itself
    let html = fs.readFileSync(resolved, "utf-8");
    const serverUrl = `${_req.protocol}://${_req.get("host")}`;
    html = html.replace("FIBER_SCOUT_SERVER_PLACEHOLDER", serverUrl);
    res.setHeader("Content-Type", "text/html");
    res.send(html);
  });

    // ── Rep Onboarding Application ─────────────────────────────────────────────
  // Public endpoint — no auth required (this is the application form)
  // File uploads via multipart/form-data

  // Same persistent-volume location as the DB (DATA_DIR), so uploaded rep
  // photos/licenses survive redeploys.
  const uploadsDir = path.join(process.env.DATA_DIR || process.cwd(), "uploads");
  const headshotsDir = path.join(uploadsDir, "headshots");
  const licensesDir = path.join(uploadsDir, "licenses");
  [uploadsDir, headshotsDir, licensesDir].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });

  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        const dir = file.fieldname === "headshot" ? headshotsDir : licensesDir;
        cb(null, dir);
      },
      filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        const name = crypto.randomUUID() + ext;
        cb(null, name);
      },
    }),
    limits: {
      fileSize: 10 * 1024 * 1024, // 10 MB per file
      files: 2,                    // headshot + license only
      fields: 20,                  // cap number of text fields
      fieldSize: 100 * 1024,       // 100 KB per text field
    },
    fileFilter: (_req, file, cb) => {
      const allowed = [".jpg", ".jpeg", ".png", ".pdf", ".webp"];
      const ext = path.extname(file.originalname).toLowerCase();
      if (allowed.includes(ext)) cb(null, true);
      else cb(new Error("Only JPG, PNG, PDF files allowed"));
    },
  });

  // Serve uploaded files (admin only) — path traversal protected
  app.use("/uploads", requireAdmin, (req, res, next) => {
    res.setHeader("Content-Disposition", "inline");
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  }, (req, res) => {
    // Resolve and verify the path is strictly within uploadsDir — prevent traversal
    const requestedPath = path.resolve(uploadsDir, req.path.replace(/^\//, ""));
    if (!requestedPath.startsWith(uploadsDir + path.sep) && requestedPath !== uploadsDir) {
      return res.status(400).json({ error: "Invalid path" });
    }
    if (!fs.existsSync(requestedPath)) return res.status(404).json({ error: "File not found" });
    res.sendFile(requestedPath);
  });

  // Delete any files multer already wrote to disk for a request we're rejecting,
  // so a failed/invalid submission can't leave orphaned uploads behind.
  function cleanupUploads(files: Record<string, Express.Multer.File[]> | undefined) {
    if (!files) return;
    for (const arr of Object.values(files)) {
      for (const f of arr) { try { fs.unlinkSync(f.path); } catch {} }
    }
  }
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  // POST /api/onboarding/apply — public, accepts multipart.
  // Rate-limited (5/hour/IP) BEFORE multer so over-limit requests never write files.
  app.post(
    "/api/onboarding/apply",
    onboardingLimiter,
    upload.fields([
      { name: "headshot", maxCount: 1 },
      { name: "license", maxCount: 1 },
    ]),
    (req, res) => {
      const files = req.files as Record<string, Express.Multer.File[]>;
      const { fullName, email, phone, city, zip, state, hasSalesExperience,
              salesExperienceDetails, preferredCarriers, referralSource } = req.body;

      if (!fullName || !email || !phone || !city || !zip || !preferredCarriers) {
        cleanupUploads(files);
        return res.status(400).json({ error: "Missing required fields: fullName, email, phone, city, zip, preferredCarriers" });
      }

      // Validate types/format/length — reject malformed or oversized input
      const strOk = (v: unknown, max: number) => typeof v === "string" && v.length > 0 && v.length <= max;
      if (typeof email !== "string" || email.length > 254 || !EMAIL_RE.test(email) ||
          !strOk(fullName, 120) || !strOk(phone, 40) || !strOk(city, 120) || !strOk(zip, 20)) {
        cleanupUploads(files);
        return res.status(400).json({ error: "Invalid or oversized field values." });
      }

      // Check for duplicate application
      const existing = storage.getRepApplications().find(
        a => a.email.toLowerCase() === email.toLowerCase() && a.status === "pending"
      );
      if (existing) {
        cleanupUploads(files);
        return res.status(409).json({ error: "An application with this email is already pending review." });
      }

      const headshotFile = files?.headshot?.[0];
      const licenseFile = files?.license?.[0];

      const app2 = storage.createRepApplication({
        fullName,
        email: email.toLowerCase(),
        phone,
        city,
        zip,
        state: state || "NC",
        hasSalesExperience: hasSalesExperience === "true" || hasSalesExperience === true,
        salesExperienceDetails: salesExperienceDetails || null,
        preferredCarriers: Array.isArray(preferredCarriers) ? preferredCarriers.join(",") : preferredCarriers,
        referralSource: referralSource || null,
        headshotPath: headshotFile ? "/uploads/headshots/" + headshotFile.filename : null,
        licensePath: licenseFile ? "/uploads/licenses/" + licenseFile.filename : null,
      });

      // Email admin notification
      const adminEmail = process.env.SMTP_USER;
      if (adminEmail) {
        // HTML-escape helper — prevents injection of HTML from public form fields into admin email
        const esc = (s: string) => String(s)
          .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
        const transporter = nodemailer.createTransport({
          host: process.env.SMTP_HOST,
          port: Number(process.env.SMTP_PORT),
          auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
        });
        transporter.sendMail({
          from: process.env.SMTP_USER,
          to: adminEmail,
          subject: `New Rep Application — ${esc(fullName)}`,
          html: `
            <h2>New Rep Application Received</h2>
            <table style="border-collapse:collapse;font-family:sans-serif;font-size:14px;">
              <tr><td style="padding:6px 12px;font-weight:bold;">Name</td><td style="padding:6px 12px;">${esc(fullName)}</td></tr>
              <tr><td style="padding:6px 12px;font-weight:bold;">Email</td><td style="padding:6px 12px;">${esc(email)}</td></tr>
              <tr><td style="padding:6px 12px;font-weight:bold;">Phone</td><td style="padding:6px 12px;">${esc(phone)}</td></tr>
              <tr><td style="padding:6px 12px;font-weight:bold;">City/Zip</td><td style="padding:6px 12px;">${esc(city)}, ${esc(state || "NC")} ${esc(zip)}</td></tr>
              <tr><td style="padding:6px 12px;font-weight:bold;">Carriers</td><td style="padding:6px 12px;">${esc(Array.isArray(preferredCarriers) ? preferredCarriers.join(", ") : preferredCarriers)}</td></tr>
              <tr><td style="padding:6px 12px;font-weight:bold;">Sales Exp.</td><td style="padding:6px 12px;">${hasSalesExperience === "true" ? "Yes" : "No"}${salesExperienceDetails ? " — " + esc(salesExperienceDetails) : ""}</td></tr>
              <tr><td style="padding:6px 12px;font-weight:bold;">Referred by</td><td style="padding:6px 12px;">${esc(referralSource || "—")}</td></tr>
              <tr><td style="padding:6px 12px;font-weight:bold;">Headshot</td><td style="padding:6px 12px;">${headshotFile ? "✓ Uploaded" : "Not uploaded"}</td></tr>
              <tr><td style="padding:6px 12px;font-weight:bold;">License</td><td style="padding:6px 12px;">${licenseFile ? "✓ Uploaded" : "Not uploaded"}</td></tr>
            </table>
            <p style="margin-top:16px;color:#666;">Log in to Fiber Scout to approve or reject this application.</p>
          `,
        }).catch((e: any) => console.error("Email error:", e));
      }

      res.status(201).json({
        success: true,
        applicationId: app2.id,
        message: "Application received. We will review it and be in touch shortly.",
      });
    }
  );

  // GET /api/onboarding/applications — admin/manager only
  app.get("/api/onboarding/applications", requireManager, (req, res) => {
    const status = req.query.status as string | undefined;
    res.json(storage.getRepApplications(status));
  });

  // ── CNS Scanner Routes ────────────────────────────────────────────────────────
  // GET /api/cns/envs — list available ENV codes
  app.get("/api/cns/envs", requireManager, (_req, res) => {
    res.json(KINETIC_ENVS);
  });

  // POST /api/cns/jobs — start a new CNS scan
  // Body: { env: "MS", startCns: 1, endCns: 50000 }
  app.post("/api/cns/jobs", requireManager, scanLimiter, async (req, res) => {
    const { env, startCns, endCns } = req.body;
    if (!env || typeof env !== "string") return res.status(400).json({ error: "env required" });
    const envInfo = KINETIC_ENVS.find(e => e.code === env);
    if (!envInfo) return res.status(400).json({ error: `Unknown ENV: ${env}. Valid: ${KINETIC_ENVS.map(e => e.code).join(", ")}` });

    const start = Math.max(1, Number(startCns) || 1);
    const end   = Math.min(Number(endCns) || 10000, envInfo.upperLimit);
    if (start >= end) return res.status(400).json({ error: "startCns must be less than endCns" });
    if (end - start > 100_000) return res.status(400).json({ error: "Max range is 100,000 CNS per job. Split into multiple jobs." });

    const job = createCnsJob(env, start, end, () => getAuthToken());
    storage.logActivity((req as any).user?.id ?? null, "cns.scan.started", "cns_job", 0, { env, start, end, jobId: job.id }, req.ip);
    res.status(201).json(job);
  });

  // GET /api/cns/jobs — list all CNS jobs
  app.get("/api/cns/jobs", requireManager, (_req, res) => {
    res.json(getCnsJobs().map(j => ({
      id: j.id, env: j.env, envLabel: j.envLabel,
      startCns: j.startCns, endCns: j.endCns, currentCns: j.currentCns,
      status: j.status, scanned: j.scanned, hits: j.hits, newFiberHits: j.newFiberHits,
      ratePerMin: j.ratePerMin, estimatedMinutes: j.estimatedMinutes,
      startedAt: j.startedAt, completedAt: j.completedAt, lastError: j.lastError,
    })));
  });

  // GET /api/cns/jobs/:id — single job detail (includes found array)
  app.get("/api/cns/jobs/:id", requireManager, (req, res) => {
    const job = getCnsJob(req.params.id);
    const _cnsTid = (req as any).user?.tenantId;
    if (!job || (_cnsTid && job.tenantId !== _cnsTid)) return res.status(404).json({ error: "Not found" });
    res.json(job);
  });

  // GET /api/cns/jobs/:id/stream — SSE stream for CNS job results
  app.get("/api/cns/jobs/:id/stream", requireManager, (req, res) => {
    const job = getCnsJob(req.params.id);
    if (!job) return res.status(404).json({ error: "Job not found" });

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    let lastSent = 0;

    function emit() {
      const j = getCnsJob(req.params.id);
      if (!j) { res.end(); return; }

      // Drip new results
      const newResults = j.found.slice(lastSent);
      for (const r of newResults) {
        res.write(`event: result\ndata: ${JSON.stringify(r)}\n\n`);
      }
      lastSent = j.found.length;

      // Progress event
      const progress = {
        jobId: j.id, env: j.env, status: j.status,
        scanned: j.scanned, hits: j.hits, newFiberHits: j.newFiberHits,
        currentCns: j.currentCns, ratePerMin: j.ratePerMin,
        estimatedMinutes: j.estimatedMinutes, lastError: j.lastError,
      };
      res.write(`event: progress\ndata: ${JSON.stringify(progress)}\n\n`);

      if (j.status === "done" || j.status === "stopped" || j.status === "error") {
        res.write(`event: done\ndata: ${JSON.stringify({ status: j.status })}\n\n`);
        clearInterval(timer);
        res.end();
      }
    }

    const timer = setInterval(emit, 1000);
    emit();
    req.on("close", () => clearInterval(timer));
  });

  // POST /api/cns/jobs/:id/stop
  app.post("/api/cns/jobs/:id/stop", requireManager, (req, res) => {
    const job = getCnsJob(req.params.id);
    if (!job) return res.status(404).json({ error: "Not found" });
    stopCnsJob(req.params.id);
    res.json({ ok: true, status: "stopped" });
  });

  // POST /api/cns/jobs/:id/pause
  app.post("/api/cns/jobs/:id/pause", requireManager, (req, res) => {
    const job = getCnsJob(req.params.id);
    if (!job) return res.status(404).json({ error: "Not found" });
    pauseCnsJob(req.params.id);
    res.json({ ok: true, status: "paused" });
  });

  // POST /api/cns/jobs/:id/resume
  app.post("/api/cns/jobs/:id/resume", requireManager, (req, res) => {
    const job = getCnsJob(req.params.id);
    if (!job) return res.status(404).json({ error: "Not found" });
    resumeCnsJob(req.params.id);
    res.json({ ok: true, status: "running" });
  });

  // DELETE /api/cns/jobs/:id — remove a completed/stopped job from memory
  app.delete("/api/cns/jobs/:id", requireManager, (req, res) => {
    const job = getCnsJob(req.params.id);
    if (!job) return res.status(404).json({ error: "Not found" });
    if (job.status === "running") stopCnsJob(req.params.id);
    res.json({ ok: true });
  });

  // PATCH /api/onboarding/applications/:id — approve or reject
  app.patch("/api/onboarding/applications/:id", requireManager, async (req, res) => {
    const id = Number(req.params.id);
    const { status, reviewNotes } = req.body;
    if (!["approved", "rejected"].includes(status)) {
      return res.status(400).json({ error: "status must be 'approved' or 'rejected'" });
    }

    const application = storage.getRepApplicationById(id);
    if (!application) return res.status(404).json({ error: "Application not found" });

    const sessionId = req.headers["x-session-id"] as string;
    const sessionObj = storage.getSession(sessionId);
    const reviewer = sessionObj ? storage.getUserById(sessionObj.userId) : null;

    let userId: number | undefined;

    if (status === "approved") {
      // Create user account — OTP-only, no passwords stored or emailed
      const existing = storage.getUserByEmail(application.email);
      if (existing) {
        userId = existing.id;
        // Reactivate if inactive
        if (!existing.active) {
          storage.updateUser(existing.id, { active: true });
        }
      } else {
        const newUser = storage.createUser({
          name: application.fullName,
          email: application.email,
          passwordHash: "",   // OTP-only system — no password
          role: "rep",
          active: true,
        });
        userId = newUser.id;
      }

      // Email rep their welcome + first OTP so they can log in immediately
      if (process.env.SMTP_USER) {
        const transporter = nodemailer.createTransport({
          host: process.env.SMTP_HOST,
          port: Number(process.env.SMTP_PORT),
          secure: false,
          auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
        });
        // Generate an OTP so they can log in right away
        const otp = storage.createOtp(application.email);
        transporter.sendMail({
          from: `"HomeFront Fiber" <${process.env.SMTP_USER}>`,
          to: application.email,
          subject: "Welcome to HomeFront Fiber — Your First Login Code",
          html: `<div style="font-family:sans-serif;max-width:480px;margin:auto;padding:36px;background:#0F2A44;color:#fff;border-radius:12px">
            <h2 style="color:#3EA394;margin:0 0 4px;font-size:20px">HomeFront Fiber</h2>
            <p style="color:#CBD4DD;font-size:12px;margin:0 0 20px">Field Sales Intelligence</p>
            <h3 style="color:#fff;margin:0 0 12px">Welcome to the team, ${application.fullName}!</h3>
            <p style="color:#CBD4DD">Your application has been approved. Use this one-time code to log in:</p>
            <div style="font-size:38px;font-weight:700;letter-spacing:10px;color:#3EA394;padding:20px;background:#061624;border:1px solid rgba(62,163,148,0.3);border-radius:10px;text-align:center;margin:20px 0">${otp}</div>
            <p style="color:#CBD4DD;font-size:14px">This code expires in 10 minutes. After logging in, request a new code anytime from the login screen.</p>
            <p style="color:#5A6B76;font-size:11px;margin-top:20px">HomeFront Fiber · Field Sales Intelligence · Never share your code with anyone.</p>
          </div>`,
        }).catch((e: any) => console.error("Email error:", e));
      }
    }

    const updated = storage.updateRepApplication(id, {
      status,
      reviewNotes: reviewNotes || null,
      reviewedBy: reviewer?.id ?? null,
      userId: userId ?? null,
    });

    res.json(updated);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// NEW SAAS ROUTES — GPS, Clock, Coming Soon, Commissions, Activity Log
// These are appended below existing registerRoutes exports
// ═══════════════════════════════════════════════════════════════════════════════

export function registerSaasRoutes(app: any) {
  // ── GPS Location Pings ──────────────────────────────────────────────────────
  // POST /api/location-pings — rep sends their GPS position
  app.post("/api/location-pings", requireAuth, (req: Request, res: Response) => {
    const user = (req as any).user;
    const { lat, lng, accuracy, repId } = req.body;
    if (!lat || !lng) return res.status(400).json({ error: "lat/lng required" });
    const resolvedRepId = repId ?? user.teamMemberId;
    if (!resolvedRepId) return res.status(400).json({ error: "No rep ID" });
    const ping = storage.createLocationPing({ repId: resolvedRepId, userId: user.id, lat, lng, accuracy });
    res.json(ping);
  });

  // GET /api/location-pings/latest — latest ping per rep (admin/manager view)
  app.get("/api/location-pings/latest", requireManager, (_req: Request, res: Response) => {
    const pings = storage.getLatestPingPerRep();
    const members = storage.getTeamMembers();
    const result = pings.map(p => ({
      ...p,
      repName: members.find(m => m.id === p.repId)?.name ?? "Unknown",
    }));
    res.json(result);
  });

  // GET /api/location-pings/:repId — history for a specific rep
  app.get("/api/location-pings/:repId", requireAuth, (req: Request, res: Response) => {
    const user = (req as any).user;
    const repId = Number(req.params.repId);
    // Reps can only view their own; managers can view all
    if (user.role === "rep" && user.teamMemberId !== repId) {
      return res.status(403).json({ error: "Forbidden" });
    }
    res.json(storage.getPingsByRep(repId, 100));
  });

  // ── Clock Sessions ──────────────────────────────────────────────────────────
  // POST /api/clock/in — clock in
  app.post("/api/clock/in", requireAuth, (req: Request, res: Response) => {
    const user = (req as any).user;
    const repId = req.body.repId ?? user.teamMemberId;
    if (!repId) return res.status(400).json({ error: "No rep ID linked to your account" });
    const existing = storage.getActiveClockSession(repId);
    if (existing) return res.status(400).json({ error: "Already clocked in", session: existing });
    const session = storage.clockIn(repId, user.id, req.body.notes);
    storage.logActivity(user.id, "rep.clocked_in", "clock_session", session.id, { repId }, req.ip);
    res.json(session);
  });

  // POST /api/clock/out — clock out
  app.post("/api/clock/out", requireAuth, (req: Request, res: Response) => {
    const user = (req as any).user;
    const repId = req.body.repId ?? user.teamMemberId;
    if (!repId) return res.status(400).json({ error: "No rep ID linked to your account" });
    const active = storage.getActiveClockSession(repId);
    if (!active) return res.status(400).json({ error: "Not clocked in" });
    const session = storage.clockOut(active.id);
    storage.logActivity(user.id, "rep.clocked_out", "clock_session", session?.id, { repId, durationMinutes: session?.durationMinutes }, req.ip);
    res.json(session);
  });

  // GET /api/clock/status — current clock status for the logged-in rep
  app.get("/api/clock/status", requireAuth, (req: Request, res: Response) => {
    const user = (req as any).user;
    const repId = user.teamMemberId;
    if (!repId) return res.json({ clockedIn: false, session: null });
    const session = storage.getActiveClockSession(repId);
    res.json({ clockedIn: !!session, session: session ?? null });
  });

  // GET /api/clock/sessions — all sessions (admin/manager) or own (rep)
  app.get("/api/clock/sessions", requireAuth, (req: Request, res: Response) => {
    const user = (req as any).user;
    const date = req.query.date as string | undefined;
    let sessions;
    if (user.role === "rep") {
      sessions = storage.getClockSessionsByRep(user.teamMemberId ?? 0);
    } else {
      sessions = storage.getAllClockSessions(date);
    }
    const members = storage.getTeamMembers();
    const result = sessions.map(s => ({
      ...s,
      repName: members.find(m => m.id === s.repId)?.name ?? "Unknown",
    }));
    res.json(result);
  });

  // ── Coming Soon Pipeline ─────────────────────────────────────────────────────
  app.get("/api/coming-soon", requireAuth, (_req: Request, res: Response) => {
    res.json(storage.getComingSoonAddresses());
  });

  app.post("/api/coming-soon", requireManager, (req: Request, res: Response) => {
    const user = (req as any).user;
    const { address, city, state, zip, lat, lng, reason } = req.body;
    if (!address || !city || !zip) return res.status(400).json({ error: "address, city, zip required" });
    try {
      const entry = storage.createComingSoon({ address, city, state: state ?? "NC", zip, lat, lng, reason: reason ?? "no_service", addedBy: user.id, lastChecked: new Date().toISOString() });
      storage.logActivity(user.id, "coming_soon.added", "coming_soon", entry.id, { address }, req.ip);
      res.json(entry);
    } catch (e: any) {
      if (e.message?.includes("UNIQUE")) return res.status(409).json({ error: "Address already in pipeline" });
      res.status(500).json({ error: "Failed to add address" });
    }
  });

  app.delete("/api/coming-soon/:id", requireManager, (req: Request, res: Response) => {
    const id = Number(req.params.id);
    storage.deleteComingSoon(id);
    res.json({ ok: true });
  });

  // POST /api/coming-soon/:id/promote — convert to active lead
  app.post("/api/coming-soon/:id/promote", requireManager, (req: Request, res: Response) => {
    const user = (req as any).user;
    const id = Number(req.params.id);
    const entry = storage.getComingSoonAddresses().find(a => a.id === id);
    if (!entry) return res.status(404).json({ error: "Not found" });
    // Create lead from this address
    const lead = storage.createLead({
      address: entry.address, city: entry.city, state: entry.state, zip: entry.zip,
      lat: entry.lat ?? undefined, lng: entry.lng ?? undefined,
      fiberStatus: "new_fiber", isNewFiber: true,
      leadStatus: "prospect",
    });
    storage.markComingSoonAvailable(id, lead.id);
    storage.logActivity(user.id, "coming_soon.promoted", "lead", lead.id, { fromComingSoonId: id }, req.ip);
    res.json({ lead, updated: true });
  });

  // ── Commissions ──────────────────────────────────────────────────────────────
  // GET /api/commissions — admin sees all, rep sees own
  app.get("/api/commissions", requireAuth, (req: Request, res: Response) => {
    const user = (req as any).user;
    const repId = user.role === "rep" ? (user.teamMemberId ?? -1) : (req.query.repId ? Number(req.query.repId) : undefined);
    const comms = storage.getCommissions(user.role === "rep" ? repId : undefined);
    res.json(comms);
  });

  // POST /api/commissions — create a commission (manager/admin; auto-created on sale knock)
  app.post("/api/commissions", requireManager, (req: Request, res: Response) => {
    const user = (req as any).user;
    const { repId, leadId, knockId, amount, saleDate, notes } = req.body;
    if (!repId || !amount || !saleDate) return res.status(400).json({ error: "repId, amount, saleDate required" });
    const comm = storage.createCommission({ repId, leadId, knockId, amount, saleDate, notes, status: "pending", approvedBy: null, paidDate: null });
    storage.logActivity(user.id, "commission.created", "commission", comm.id, { repId, amount }, req.ip);
    res.json(comm);
  });

  // PATCH /api/commissions/:id — update status (approve, mark paid, dispute)
  app.patch("/api/commissions/:id", requireManager, (req: Request, res: Response) => {
    const user = (req as any).user;
    const id = Number(req.params.id);
    const { status, paidDate, notes } = req.body;
    const updates: any = {};
    if (status) updates.status = status;
    if (paidDate) updates.paidDate = paidDate;
    if (notes !== undefined) updates.notes = notes;
    if (status === "approved" || status === "paid") updates.approvedBy = user.id;
    const updated = storage.updateCommission(id, updates);
    if (!updated) return res.status(404).json({ error: "Not found" });
    storage.logActivity(user.id, `commission.${status}`, "commission", id, { status }, req.ip);
    res.json(updated);
  });

  // GET /api/commissions/summary — earnings summary per rep (admin/manager)
  app.get("/api/commissions/summary", requireManager, (_req: Request, res: Response) => {
    res.json(storage.getCommissionSummary());
  });

  // GET /api/commission-rates — rate plans
  app.get("/api/commission-rates", requireAuth, (_req: Request, res: Response) => {
    res.json(storage.getCommissionRates());
  });

  // POST /api/commission-rates — create rate plan (admin only)
  app.post("/api/commission-rates", requireAdmin, (req: Request, res: Response) => {
    const { name, role, repId, ratePerSale } = req.body;
    if (!name || !ratePerSale) return res.status(400).json({ error: "name and ratePerSale required" });
    const rate = storage.createCommissionRate({ name, role, repId, ratePerSale, isActive: true });
    res.json(rate);
  });

  // PATCH /api/commission-rates/:id — update rate
  app.patch("/api/commission-rates/:id", requireAdmin, (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const updated = storage.updateCommissionRate(id, req.body);
    if (!updated) return res.status(404).json({ error: "Not found" });
    res.json(updated);
  });

  // ── Activity Log ──────────────────────────────────────────────────────────────
  app.get("/api/activity-log", requireManager, (req: Request, res: Response) => {
    const limit = Number(req.query.limit ?? 100);
    const entries = storage.getActivityLog(limit);
    const users = storage.getAllUsers();
    const result = entries.map(e => ({
      ...e,
      userName: users.find(u => u.id === e.userId)?.name ?? "System",
      details: e.details ? JSON.parse(e.details) : null,
    }));
    res.json(result);
  });

  // ── Enhanced Stats — rep-scoped or tenant-wide ──────────────────────────────────
  app.get("/api/stats/saas", requireAuth, (req: Request, res: Response) => {
    const user = (req as any).user;
    const isRep = user?.role === "rep";
    const repMemberId: number | undefined = repLeadScope(user);

    // Reps see their own scoped stats; admins/managers see tenant-wide
    const leads = storage.getLeads(user?.tenantId ?? undefined, repMemberId);
    const members = storage.getTeamMembers().filter(m => m.active);
    const knocks = repMemberId ? storage.getKnocksByRep(repMemberId) : storage.getKnocks();
    const comingSoon = storage.getComingSoonAddresses();
    const commissions = storage.getCommissions(repMemberId);
    const allSessions = storage.getAllClockSessions();
    const sessions = repMemberId ? allSessions.filter(s => s.repId === repMemberId) : allSessions;

    const today = new Date().toISOString().slice(0, 10);
    const todayKnocks = knocks.filter(k => k.knockedAt.slice(0, 10) === today);
    const todaySales = todayKnocks.filter(k => k.outcome === "sold").length;
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const weekSales = knocks.filter(k => k.outcome === "sold" && k.knockedAt > weekAgo).length;

    const totalRevenue = commissions.filter(c => c.status === "paid").reduce((s, c) => s + c.amount, 0);
    const pendingPayout = commissions.filter(c => c.status === "approved").reduce((s, c) => s + c.amount, 0);

    const activeClockedIn = isRep
      ? (repMemberId && storage.getActiveClockSession(repMemberId) ? 1 : 0)
      : members.filter(m => storage.getActiveClockSession(m.id)).length;

    res.json({
      leads: { total: leads.length, newFiber: leads.filter(l => l.isNewFiber).length, sold: leads.filter(l => l.leadStatus === "sold").length, unassigned: leads.filter(l => !l.assignedRepId).length },
      team: isRep ? { total: 1, activeClockedIn } : { total: members.length, activeClockedIn },
      knocks: { total: knocks.length, today: todayKnocks.length, todaySales, weekSales },
      comingSoon: { total: comingSoon.length, converted: comingSoon.filter(a => a.fiberAvailable).length },
      revenue: { totalPaid: totalRevenue, pendingPayout },
      fieldHours: { total: sessions.reduce((s, c) => s + (c.durationMinutes ?? 0), 0) },
    });
  });

  // ── Auto-commission on sold knock ─────────────────────────────────────────────
  // Intercept knock creation to auto-generate commission when outcome = "sold"
  // This is called internally after a knock is saved

  // ═══════════════════════════════════════════════════════════════════════════
  // SUPER-ADMIN: Tenant Management (muizzm21@gmail.com only)
  // ═══════════════════════════════════════════════════════════════════════════
  const SUPER_ADMIN_EMAILS = (process.env.SUPER_ADMIN_EMAILS ?? "muizzm21@gmail.com")
    .split(",").map(e => e.trim().toLowerCase());
  function requireSuperAdmin(req: Request, res: Response, next: NextFunction) {
    const user = (req as any).user;
    if (!user || user.role !== "admin" || !SUPER_ADMIN_EMAILS.includes(user.email.toLowerCase())) {
      return res.status(403).json({ error: "Super-admin only" });
    }
    next();
  }

  // GET  /api/sa/tenants           — list all tenants
  app.get("/api/sa/tenants", requireAuth, requireSuperAdmin, (_req, res) => {
    const allTenants = storage.getTenants();
    const enriched = allTenants.map(t => ({
      ...t,
      kfsAuthBasic: undefined,      // never expose keys in list
      enrichmentApiKey: undefined,
      stats: storage.getTenantStats(t.id),
    }));
    res.json(enriched);
  });

  // POST /api/sa/tenants           — create a new tenant
  app.post("/api/sa/tenants", requireAuth, requireSuperAdmin, (req, res) => {
    try {
      const {
        slug, companyName, ownerName, ownerEmail, ownerPhone,
        brandName, brandColor, tagline, plan, monthlyFee, revenueSharePct,
        maxReps, allowedMarkets, notes, trialEndsAt, billingEmail,
        mapboxToken, scannerSecret, kfsAuthBasic,
      } = req.body;
      if (!slug || !companyName || !ownerName || !ownerEmail || !brandName) {
        return res.status(400).json({ error: "slug, companyName, ownerName, ownerEmail, brandName required" });
      }
      const slugClean = slug.toLowerCase().replace(/[^a-z0-9-]/g, "-");
      const tenant = storage.createTenant({
        slug: slugClean, companyName, ownerName, ownerEmail: ownerEmail.toLowerCase(),
        ownerPhone, brandName, brandColor: brandColor || "#3EA394",
        tagline: tagline || "Field Sales Intelligence",
        plan: plan || "trial", monthlyFee: monthlyFee || 0,
        revenueSharePct: revenueSharePct || 0.20,
        maxReps: maxReps || 10, allowedMarkets, notes,
        trialEndsAt, billingEmail, mapboxToken, scannerSecret, kfsAuthBasic,
        status: "active",
      });
      // Auto-create an admin user for this tenant
      const adminUser = storage.createUser({
        name: ownerName, email: ownerEmail.toLowerCase(),
        role: "admin", tenantId: tenant.id, active: true,
      });
      storage.logActivity((req as any).user.id, "tenant.created", "tenant", tenant.id, { slug: slugClean, ownerEmail });
      res.status(201).json({ tenant, adminUser: { ...adminUser, passwordHash: undefined } });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  // GET  /api/sa/tenants/:id       — single tenant detail (includes secrets)
  app.get("/api/sa/tenants/:id", requireAuth, requireSuperAdmin, (req, res) => {
    const tenant = storage.getTenantById(Number(req.params.id));
    if (!tenant) return res.status(404).json({ error: "Not found" });
    res.json({ ...tenant, stats: storage.getTenantStats(tenant.id) });
  });

  // PATCH /api/sa/tenants/:id      — update tenant settings
  app.patch("/api/sa/tenants/:id", requireAuth, requireSuperAdmin, (req, res) => {
    const updated = storage.updateTenant(Number(req.params.id), req.body);
    if (!updated) return res.status(404).json({ error: "Not found" });
    storage.logActivity((req as any).user.id, "tenant.updated", "tenant", updated.id, { fields: Object.keys(req.body) });
    res.json(updated);
  });

  // DELETE /api/sa/tenants/:id     — suspend/delete tenant
  app.delete("/api/sa/tenants/:id", requireAuth, requireSuperAdmin, (req, res) => {
    const tenant = storage.getTenantById(Number(req.params.id));
    if (!tenant) return res.status(404).json({ error: "Not found" });
    storage.updateTenant(tenant.id, { status: "cancelled" });
    storage.logActivity((req as any).user.id, "tenant.cancelled", "tenant", tenant.id, {});
    res.json({ ok: true });
  });

  // GET  /api/sa/revenue           — revenue summary across all tenants
  app.get("/api/sa/revenue", requireAuth, requireSuperAdmin, (_req, res) => {
    const allTenants = storage.getTenants().filter(t => t.status === "active");
    const summary = allTenants.map(t => {
      const stats = storage.getTenantStats(t.id);
      return {
        tenantId: t.id, slug: t.slug, brandName: t.brandName,
        plan: t.plan, monthlyFee: t.monthlyFee,
        revenueSharePct: t.revenueSharePct,
        yourCut: (t.monthlyFee || 0) * (t.revenueSharePct || 0.20),
        ...stats,
      };
    });
    const totalMrr = summary.reduce((s, t) => s + (t.monthlyFee || 0), 0);
    const yourMrr  = summary.reduce((s, t) => s + (t.yourCut || 0), 0);
    res.json({ summary, totalMrr, yourMrr, tenantCount: allTenants.length });
  });

  // ─── Tracerfy Owner Enrichment ──────────────────────────────────────────────
  // POST /api/leads/:id/owner-lookup  — pay-per-hit owner name/phone/email
  app.post("/api/leads/:id/owner-lookup", requireAuth, ownerLookupLimiter, async (req, res) => {
    const lead = storage.getLeadById(Number(req.params.id));
    const _olu = (req as any).user;
    const _oltid = _olu?.tenantId;
    if (!lead || (_oltid && lead.tenantId !== _oltid)) return res.status(404).json({ error: "Not found" });
    // Reps can only run (paid) owner lookups on their own assigned leads
    if (!repCanAccessLead(_olu, lead)) return res.status(404).json({ error: "Not found" });
    
    // Use tenant's Tracerfy key if available, else fall back to env
    const user = (req as any).user as any;
    let apiKey = process.env.TRACERFY_API_KEY || "";
    if (user?.tenantId) {
      const tenant = storage.getTenantById(user.tenantId);
      if (tenant?.enrichmentApiKey) apiKey = tenant.enrichmentApiKey;
    }

    if (!apiKey) {
      return res.status(402).json({ 
        error: "No enrichment API key configured",
        message: "Add a Tracerfy API key in tenant settings or contact HomeFront Fiber support. Cost: $0.20/hit, $0 on miss.",
        signupUrl: "https://www.tracerfy.com"
      });
    }

    try {
      const fullAddress = `${lead.address}, ${lead.city}, ${lead.state} ${lead.zip}`;
      const response = await fetch("https://api.tracerfy.com/v1/api/lead-builder/lookup/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ address: fullAddress }),
        signal: AbortSignal.timeout(10000),
      });

      const data = await response.json() as any;
      
      if (!response.ok) {
        return res.status(response.status).json({ error: data?.detail || "Tracerfy API error" });
      }

      // Map Tracerfy response fields
      const ownerName  = data?.owner_name || data?.name || null;
      const ownerPhone = data?.phone_numbers?.[0] || data?.phone || null;
      const ownerEmail = data?.emails?.[0] || data?.email || null;
      const homeValue  = data?.property_value ? `$${Number(data.property_value).toLocaleString()}` : null;
      const yearsAt    = data?.years_owned ? Number(data.years_owned) : null;
      const isOwner    = data?.owner_occupied ?? null;

      // Save to lead
      if (ownerName || ownerPhone || ownerEmail) {
        storage.updateLead(lead.id, {
          ownerName:      ownerName  ?? lead.ownerName,
          ownerPhone:     ownerPhone ?? lead.ownerPhone,
          ownerEmail:     ownerEmail ?? lead.ownerEmail,
          homeValue:      homeValue  ?? lead.homeValue,
          yearsAtAddress: yearsAt    ?? lead.yearsAtAddress,
          isHomeowner:    isOwner    ?? lead.isHomeowner,
          enrichedAt:     new Date().toISOString(),
        } as any);
        storage.logActivity(user?.id ?? null, "lead.owner_lookup", "lead", lead.id, { ownerName, hit: true });
      } else {
        storage.logActivity(user?.id ?? null, "lead.owner_lookup.miss", "lead", lead.id, { hit: false });
      }

      res.json({
        hit: !!(ownerName || ownerPhone || ownerEmail),
        ownerName, ownerPhone, ownerEmail,
        homeValue, yearsAtAddress: yearsAt, isHomeowner: isOwner,
        cost: (ownerName || ownerPhone || ownerEmail) ? "$0.20" : "$0.00",
      });
    } catch (e: any) {
      console.error("Tracerfy error:", e);
      res.status(500).json({ error: "Owner lookup failed: " + e.message });
    }
  });



  // ── Nightly Cron Status + Manual Trigger ──────────────────────────────────────
  app.get("/api/cron/status", requireManager, (_req, res) => {
    res.json(getCronStatus());
  });

  app.post("/api/cron/trigger", requireAdmin, async (_req, res) => {
    try {
      await triggerManualScan();
      res.json({ success: true, message: "Nightly scan triggered manually" });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── Proxy Status ──────────────────────────────────────────────────────────────
  app.get("/api/proxy/status", requireAdmin, (_req, res) => {
    res.json(getProxyStatus());
  });

  // Start nightly cron at server boot
  startNightlyCron();

}