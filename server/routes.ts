import path from "path";
import fs from "fs";
import multer from "multer";
import crypto from "crypto";
import { sendMailResilient, mailFrom, adminInbox, emailShell, escapeHtml, logoAttachment, emailParagraph, emailCodeBox, emailNote } from "./mail";
import type { Express, Request, Response, NextFunction } from "express";
import type { Server } from "http";
import { storage, getDefaultTenantId } from "./storage";
import { billingSummary, getCreditLedger, isBillingEnabled, ensureBilling, setBillingState, setPlan, grantCredits, getBilling, scanBlockReason } from "./billingStore";
import { PLANS as BILLING_PLANS, isBillingState, isOverageMode } from "@shared/billing";
import { stripeConfigured, webhookConfigured, verifyStripeSignature, createCheckoutSession, createPortalSession, processWebhookEvent } from "./stripeAdapter";
import Database from "better-sqlite3";
import { z } from "zod";
import { packMapPins, type PackedMapPins } from "@shared/mapPinsWire";
import { decideFreshFiber, type FreshFiberVerdict } from "@shared/freshFiberVerdict";
import { structuredLog } from "./structuredLog";
import {
  recordAdminAudit, auditContext, queryAdminAudit, adminAuditFacets, ADMIN_AUDIT_OUTCOMES,
} from "./adminAudit";
import {
  previewNextPass, startNextPass, listTerritoryPasses, currentPassOf,
} from "./territoryPass";
import { isTerritoryPassAction, type TerritoryPassAction } from "@shared/territoryPass";
import { rawDb } from "./db";
import { persistKineticObservation, type PersistKineticObservationResult } from "./kineticObservation";
import type { ProviderRequestPriority } from "./providerRequestQueue";

// ── Apply SQLite performance pragmas on startup ──────────────────────────────
try {
  // Must resolve to the SAME file as server/db.ts: honor DATA_DIR (the volume
  // mount in production) — DB_PATH alone here once pointed this handle at a
  // second ./data.db in the container's cwd.
  const _perfDb = new Database(
    process.env.DB_PATH ?? path.join(process.env.DATA_DIR || process.cwd(), "data.db")
  );
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
import { insertLeadSchema, insertTeamMemberSchema, insertKnockSchema, insertTerritorySchema } from "@shared/schema";
import { colorForRep } from "@shared/repColors";
import { pointInPolygon } from "@shared/geo";
import { padHull, subdivideCluster, convexHull } from "@shared/opportunity";
import { can } from "@shared/permissions";
import { isLeadMarkOrClear, normalizeLeadMark } from "@shared/leadMark";
import { sameTenant } from "./tenantGuard";
import { canActOnMember, HIRABLE_ROLES as SHARED_HIRABLE_ROLES, wouldCreateReportsCycle, isValidSupervisorRole, hierarchyRank } from "@shared/teamHierarchy";
import { unassignRep, reclaimTerritory, canRepTakeAnotherArea, MAX_ACTIVE_AREAS_PER_REP, type ReclaimMode, type TerritoryState, type TerritoryStatus } from "@shared/territory";
import { OUTCOME_TO_STATUS, OUTCOME_META, deriveWasHome, isKnockOutcome, isBulkStatusOutcome, type KnockOutcome } from "@shared/knock";
import { classifyKnockLocation, countsAsWorked, type VerificationStatus } from "@shared/geoVerify";
import {
  calcCommission, pickActiveStructure, describeStructure,
  type CommissionStructure, type Tier, type CalcType,
} from "@shared/commission";
import type { CommissionRate } from "@shared/schema";
import {
  can as hasCapability, capabilitiesFor, groupedCapabilities, rolesWithCapability, isHighRisk,
  type Capability, type Role,
} from "@shared/capabilities";
import { buildDiagnostics, APP_VERSION } from "@shared/diagnostics";
import { registerCommissionRoutes } from "./commissionRoutes";
import { registerPayoutRoutes } from "./payoutRoutes";
import {
  issueOnboardingDocuments,
  onboardingAppOrigin,
  registerOnboardingDocumentRoutes,
  sendOnboardingWelcome,
} from "./onboardingDocumentRoutes";
import {
  getRecruitingInviteByApplication,
  markInviteAgreementsIssued,
  markInviteApproved,
  markInviteLoginSent,
  markInviteRejected,
} from "./onboardingRecruitingStore";
import { ApplicationIntakeError, submitPublicApplication } from "./onboardingApplicationService";
import { resendConfigured, sendResendEmail } from "./resendMail";
import * as commissionSvc from "./commissionService";
import { registerAddressDiscoveryRoutes } from "./addressDiscovery/routes";
import { registerCallingRoutes } from "./calling/routes";
import { registerFiberOperationsRoutes } from "./fiberOperationsRoutes";
import { registerComingSoonRoutes } from "./comingSoonWatchlist";
import { registerLeadRankingRoutes } from "./leadRanking";
import { registerKineticScannerRoutes } from "./kineticScannerRoutes";

type AddressScanner = typeof scanAddress;
let addressScanner: AddressScanner = scanAddress;

/** Test-only seam for exercising the full async scan route without network I/O. */
export function setAddressScannerForTest(scanner: AddressScanner): void {
  if (process.env.NODE_ENV !== "test") throw new Error("Address scanner overrides are test-only");
  addressScanner = scanner;
}

// Map a stored commission_rates row → the engine's CommissionStructure.
// Legacy flat rows (no effective_from) are treated as always-on flat plans.
function rateToStructure(r: CommissionRate): CommissionStructure {
  let tiers: Tier[] = [];
  try { tiers = r.tiers ? (JSON.parse(r.tiers) as Tier[]) : []; } catch { /* corrupt JSON → no tiers */ }
  return {
    id: r.id,
    name: r.name,
    calcType: ((r as any).calcType ?? "flat") as CalcType,
    flatAmount: r.ratePerSale,
    percentage: (r as any).percentage ?? 0,
    tiers,
    role: r.role ?? null,
    repId: r.repId ?? null,
    effectiveFrom: (r as any).effectiveFrom ?? "0000-01-01", // null legacy → always-on
    effectiveTo: (r as any).effectiveTo ?? null,
    version: (r as any).version ?? 1,
    isActive: r.isActive,
  };
}

function safeJson<T = number[]>(s: string | null | undefined): T | undefined {
  if (!s) return undefined;
  try { return JSON.parse(s) as T; } catch { return undefined; }
}

// Generic lead APIs are intentionally non-callable. Full phone values may
// only leave the server after the isolated Calling module has produced and
// atomically consumed a short-lived authorization. Provider internals remain
// visible only to leadership roles that need them for operations.
const PROVIDER_INTERNAL_FIELDS = ["dfAddressId", "accessId", "exchangeId"] as const;
function stripProviderIds<T extends Record<string, any>>(lead: T, user?: any): T {
  if (!lead) return lead;
  const clone: any = { ...lead };
  delete clone.contactPhone;
  delete clone.ownerPhone;
  const role = user?.role;
  if (role !== "admin" && role !== "manager" && role !== "super_admin") {
    for (const field of PROVIDER_INTERNAL_FIELDS) delete clone[field];
  }
  return clone;
}

// An area is "auto-named" if it follows the "<Rep>'s area" / "Unassigned area"
// convention we generate. Only those get renamed on reclaim/reassign so a rep's
// name never lingers on an area they no longer own — custom names are preserved.
function isAutoAreaName(name?: string | null): boolean {
  if (!name || !name.trim()) return true;
  const n = name.trim();
  return /'s area$/.test(n) || n === "Unassigned area";
}
import { scanAddress, setManualToken, getTokenStatus, forceFreshTokenFromApi, getAddressScanQueueStatus, liveTestAddress, pauseScanning, resumeScanning, isScanningPaused, type ScanResult } from "./scanner";
import { getInspectorSnapshot, getAddressTimeline, onScanEvent } from "./scanEvents";
import { scrubSecretText } from "./secretScrub";
import { getProxySessionId, isProxyConnected } from "./proxy-fetch";
import { runDailyMarketRefresh, getDailyRefreshStatus } from "./dailyMarketRefresh";
import { getComingSoonWatchlist } from "./comingSoonProgram";
import { getFiberChanges, getCopperPool } from "./fiberTransitions";
import { authorizedScanAdmission, ownerLookupLimiter, onboardingLimiter, geocodeLimiter } from "./limiters";
import * as scanSvc from "./scanService";
import {
  CORROBORATION_SOURCES, freshPoints, knockList, listMarkets, monitoringSummary,
  operationalMetrics, recordCorroboration, seedStateMarkets, syncMarketState, toCsv,
} from "./stateMonitorStore";
import { clusterFreshFiber } from "@shared/freshFiberClusters";
import { flushFreshOpportunityAlerts, getStateMonitorStatus, runStateMonitorTick, startStateMonitorScheduler } from "./stateMonitorScheduler";
import { announcementSourceStatus, pollAnnouncementsIfDue } from "./announcementWatcher";
import { CATALOG_OBSERVED_AT, KINETIC_DIRECTORY_URLS, refreshKineticLocationDirectory } from "./kineticMarketCatalog";
import * as sweepService from "./sweepService";
import * as radarStore from "./radarStore";
import { getCityAddresses, pullAddressesFromOverpass } from "./overpass";
import { harvestRockwellAddresses, harvestCityAddresses, getRockwellGridSize, harvestBboxAddresses, bboxGridSize } from "./mapbox-addresses";
import { validateScanBbox, adaptiveGridStep, pooledMap, backoffDelayMs, type BboxLL } from "./bboxScan";
import { mergeAreaAddressSources, planUnifiedAreaScan } from "./areaScanStrategy";
import { gatherCoverage, providerStatus, type BBox as CoverageBBox, type RawAddress } from "./providers";
import { createTileScanJob, runTileScan, type TileScanJob, type Tile } from "./tileScan";
import { getCronStatus, triggerManualScan, startNightlyCron, getEngineStatus } from "./cron-scanner";
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

// ── Email (Resend/SMTP via env — see server/mail.ts; dev console fallback) ──
function otpMessage(to: string, code: string, name: string) {
  const first = escapeHtml((name || "").trim().split(" ")[0] || "there");
  return {
    to,
    subject: "Your Home Front Solutions sign-in code",
    text: `Hi ${(name || "").split(" ")[0] || "there"}, your Home Front Solutions sign-in code is ${code}. It expires in 10 minutes. Never share this code — we will never ask for it.`,
    html: emailShell({
      preheader: `Your sign-in code is ${code} — expires in 10 minutes`,
      heading: "Your sign-in code",
      bodyHtml:
        emailParagraph(`Hi ${first}, use this one-time code to sign in:`) +
        emailCodeBox(code) +
        emailNote(`This code expires in <strong style="color:#4a5a68;">10 minutes</strong>. Never share it — Home Front Solutions will never ask you for it.`),
    }),
  };
}

async function sendOtpEmail(to: string, code: string, name: string): Promise<"email" | "console"> {
  const message = otpMessage(to, code, name);
  // 1) Resend HTTPS API (port 443), PRODUCTION ONLY. Hosts routinely block
  //    outbound SMTP (25/465/587) — 2026-07-16 both ports were refused from the
  //    prod box — but 443 egress always works. apiKey() reuses SMTP_PASS when
  //    SMTP_HOST is smtp.resend.com, so this needs no new env. Dev keeps the
  //    SMTP-then-console path so developmentCode logins still work offline.
  if (process.env.NODE_ENV === "production" && resendConfigured()) {
    try {
      const logoPath = logoAttachment();
      await sendResendEmail({
        ...message,
        idempotencyKey: `otp-${to.toLowerCase()}-${code}`,
        tags: [{ name: "category", value: "otp_login" }],
        attachments: logoPath
          ? [{ filename: logoPath.filename, content: fs.readFileSync(logoPath.path), contentId: logoPath.cid }]
          : [],
      });
      return "email";
    } catch (e: any) {
      console.warn(`[otp] Resend API send failed (${String(e?.message ?? e).slice(0, 140)}) — trying SMTP`);
    }
  }
  // 2) SMTP with 587↔465 port failover (production only). Development NEVER
  //    sends real mail: local logins use the console code (developmentCode in
  //    the response) — deterministic, offline-friendly, and no test codes in
  //    real inboxes.
  if (process.env.NODE_ENV !== "production") {
    console.log(`\n══ OTP for ${to} (${name}): ${code} ══\n`);
    return "console";
  }
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    try {
      await sendOtpViaSmtp(message);
      return "email";
    } catch {
      throw new Error("email_send_failed");
    }
  }
  // API failed and no SMTP configured — a prod login cannot silently no-op.
  throw new Error("email_send_failed");
}

async function sendOtpViaSmtp(message: ReturnType<typeof otpMessage>) {
  const logo = logoAttachment();
  // Port-failover sender: survives one SMTP port (587 or 465) going dark.
  await sendMailResilient({
      from: mailFrom(),
      ...message,
      attachments: logo ? [logo] : [],
  });
}

// ── Auth middleware ───────────────────────────────────────────────────────────────
function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.headers["x-session-id"] as string;
  if (!token) return res.status(401).json({ error: "Not authenticated" });
  const session = storage.getSession(token);
  if (!session) return res.status(401).json({ error: "Session expired" });
  const user = storage.getUserById(session.userId);
  if (!user || !user.active) return res.status(401).json({ error: "User not found" });
  // Keep an actively-used session alive: every authenticated request slides the
  // expiry forward, so a rep mid-shift is never signed out under their own taps.
  storage.touchSession(session);
  (req as any).user = user;
  next();
}

// super_admin is included in every tier below: can() grants it the full ADMIN
// capability set and the client Guards do the same, so a role-string guard that
// excludes it would lock the apex identity out of ordinary org operations.
function requireAdmin(req: Request, res: Response, next: NextFunction) {
  requireAuth(req, res, () => {
    const user = (req as any).user;
    if (user.role !== "admin" && user.role !== "super_admin") return res.status(403).json({ error: "Admin only" });
    next();
  });
}

// Team Lead or above (team_lead, manager, admin, super_admin) can onboard reps
function requireTeamLead(req: Request, res: Response, next: NextFunction) {
  requireAuth(req, res, () => {
    const user = (req as any).user;
    const allowed = ["admin", "manager", "team_lead", "super_admin"];
    if (!allowed.includes(user.role)) return res.status(403).json({ error: "Team Lead or above required" });
    next();
  });
}

// Manager or above
function requireManager(req: Request, res: Response, next: NextFunction) {
  requireAuth(req, res, () => {
    const user = (req as any).user;
    const allowed = ["admin", "manager", "super_admin"];
    if (!allowed.includes(user.role)) return res.status(403).json({ error: "Manager or above required" });
    next();
  });
}

// Scan-gate: block money-spending scans for a tenant whose billing state (or
// exhausted credits under `stop`) forbids it. Dark tenants (no billing row) are
// ALWAYS allowed, so the live portal is unaffected. Module-level so it's usable by
// every route (scan routes, /api/cron/trigger, /api/check-fiber). Runs after an
// auth middleware that sets req.user.
function requireScanningAllowed(_req: Request, _res: Response, next: NextFunction) {
  // Billing paywall removed by owner directive — scanning is never gated on
  // billing/credit state for any tenant.
  next();
}

// Capability gate — the enterprise permission unit. Authorizes against the
// shared capability map (same source the client UI gates read), so a named
// action is enforced identically on both sides. 403 names the missing cap.
function requireCapability(cap: Capability) {
  return (req: Request, res: Response, next: NextFunction) => {
    requireAuth(req, res, () => {
      if (!hasCapability((req as any).user?.role, cap)) {
        // Observable governance signal — the diagnostics panel surfaces denial
        // patterns (misconfigured access / probing) from this stream.
        storage.logActivity((req as any).user?.id ?? null, "permission.denied", "capability", undefined,
          { need: cap, path: req.path, role: (req as any).user?.role ?? null }, req.ip);
        return res.status(403).json({ error: "Forbidden", need: cap });
      }
      next();
    });
  };
}

// ── Lead visibility scope (fail closed) ───────────────────────────────────────
// The set of rep (team_member) ids whose leads a user may SEE/act on:
//   • admin / manager / super_admin → undefined = the whole tenant.
//   • team_lead → their own team: themselves + every rep reporting to them
//     (team_members.reportsToId === their teamMemberId). A lead with NO reps
//     still sees only their own assigned leads.
//   • rep → just their own linked member.
// Reps/leads with no linkage resolve to a set that matches nothing (never all).
// Enforced on the SERVER — the map, search, lasso, stats all pass through here.
function leadVisibilityScope(user: any): number | number[] | undefined {
  const role = user?.role;
  if (role === "admin" || role === "manager" || role === "super_admin") return undefined;
  if (role === "team_lead") {
    const selfTm = user?.teamMemberId ?? null;
    const reports = selfTm != null
      ? storage.getTeamMembers(user?.tenantId ?? undefined).filter((m: any) => m.reportsToId === selfTm).map((m: any) => m.id)
      : [];
    const ids = selfTm != null ? [selfTm, ...reports] : [];
    return ids.length ? [...new Set(ids)] : [-1]; // fail-closed
  }
  // rep
  return [user?.teamMemberId ?? -1];
}

// Is `repId` inside the caller's visibility scope? Used to guard WRITES
// (assign/reassign/territory) so a team_lead can only target their own team's
// reps, and can only act on leads owned within their scope. Admin/manager pass.
function repInVisibilityScope(user: any, repId: number | null | undefined): boolean {
  const scope = leadVisibilityScope(user);
  if (scope === undefined) return true;           // admin/manager — org-wide
  if (repId == null) return false;
  return (scope as number[]).includes(repId);
}

// A rep may only read/act on a lead assigned to their own team member; a
// team_lead only on leads within their team scope. Non-scoped roles pass.
// Guards single-lead endpoints against IDOR (fetch-by-id) AND cross-team writes.
function repCanAccessLead(user: any, lead: any): boolean {
  const scope = leadVisibilityScope(user);
  if (scope === undefined) return true;
  return !!lead && lead.assignedRepId != null && (scope as number[]).includes(lead.assignedRepId);
}

// May the caller REASSIGN this lead? A scoped role (team_lead) may claim an
// UNASSIGNED lead or move one already within their team — but may NOT steal a
// lead assigned to another team. Admin/manager pass. This is what makes the
// lasso/bulk-assign safe: a team lead can carve a fresh area for their reps
// without silently poaching another team's booked doors.
function canReassignLead(user: any, lead: any): boolean {
  const scope = leadVisibilityScope(user);
  if (scope === undefined) return true;             // admin/manager — org-wide
  if (!lead) return false;
  return lead.assignedRepId == null || (scope as number[]).includes(lead.assignedRepId);
}

// May the caller rename/delete this territory? A team_lead only owns areas
// belonging to their team (the area's rep or any assignee is in scope).
// Admin/manager pass. Guards the destructive territory routes against a
// team_lead renaming/deleting another team's area.
function canManageTerritory(user: any, terr: any): boolean {
  const scope = leadVisibilityScope(user);
  if (scope === undefined) return true;  // manager+ — unrestricted
  if (!terr) return false;
  let assignees: number[] = [];
  try { assignees = JSON.parse(terr.assigneeIds || "[]"); } catch { /* legacy */ }
  if ((terr.repId != null && (scope as number[]).includes(terr.repId))
      || assignees.some(id => (scope as number[]).includes(id))) return true;

  // An area nobody currently holds belongs to no team, so there is no team to
  // take it from. A team lead may pick one up out of the pool — the separate
  // repInVisibilityScope check on the target rep is what stops them handing it
  // to somebody else's rep. Without this, "team leads can assign" was false for
  // every freshly drawn or returned area, which is most of them.
  const status = String(terr.status ?? "");
  const unowned = assignees.length === 0
    && (status === "unassigned" || status === "reclaimed" || status === "draft");
  return unowned;
}

// Tenant wall for rep-targeting writes (clock, pings, manual commissions):
// a caller may only act on a team member inside their own org. Fail closed on
// a missing member; super_admin is exempt (cross-org support access).
function repInCallerTenant(user: any, repId: number): boolean {
  if (user?.role === "super_admin") return true;
  const member = storage.getTeamMemberById(repId);
  if (!member) return false;
  if (user?.tenantId == null || member.tenantId == null) return false;
  return member.tenantId === user.tenantId;
}

// ── Sanitize fiber result — strip proprietary vendor fields before sending to client ──
function evidenceBackedVerdict(r: any, persisted?: PersistKineticObservationResult | null) {
  const primary = decideFreshFiber(r);
  const confirmed = !!persisted && persisted.projection.confirmed > 0 && persisted.projection.leadIds.length > 0;
  if (confirmed) return {
    verdict: "fresh" as const,
    isFreshFiber: true,
    label: "Confirmed fresh fiber",
    message: "Unavailable-to-fiber transition independently confirmed at this address.",
    confirmation: "cross_verified" as const,
  };
  if (!persisted?.conclusive || primary.verdict === "unverified") return {
    verdict: "unverified" as const,
    isFreshFiber: false,
    label: "Couldn't verify",
    message: "The provider did not return a conclusive answer. Recheck later.",
    confirmation: "inconclusive" as const,
  };
  if (persisted.transition.fresh) return {
    verdict: "unverified" as const,
    isFreshFiber: false,
    label: "Confirmation pending",
    message: "A primary-source fiber flip was observed; independent address-level fiber evidence is still required.",
    confirmation: "single_source_provisional" as const,
  };
  if (primary.isFreshFiber) return {
    verdict: "unverified" as const,
    isFreshFiber: false,
    label: "Freshness unknown",
    message: "Fiber is available, but there is no earlier unavailable observation proving that it is fresh.",
    confirmation: "baseline_available" as const,
  };
  return {
    verdict: "not_fresh" as const,
    isFreshFiber: false,
    label: "Not fresh fiber",
    message: "The current conclusive result does not satisfy the fresh-fiber opportunity rule.",
    confirmation: "not_fresh" as const,
  };
}

function sanitizeFiberResult(r: any, persisted?: PersistKineticObservationResult | null) {
  const decision = evidenceBackedVerdict(r, persisted);
  return {
    address: { line1: r.address, city: r.city, state: r.state, zip: r.zip, lat: r.lat, lng: r.lng },
    verdict: decision.verdict,
    isFreshFiber: decision.isFreshFiber,
    label: decision.label,
    message: decision.message,
    confirmation: decision.confirmation,
    checkedAt: new Date().toISOString(),
    // Intentionally omitted: rawResponse, provider ids, segment, billing status,
    // competitor data, confidence, and transport diagnostics. Operators need the
    // server-authored business answer; evidence remains in fiber_checks.
  };
}

// ── Live address-scanner state ──────────────────────────────────────────────
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
  diagNewFiber: number;      // primary-provider NEW FIBER matches in last window
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
  summary?: ScanSummary;
}
const scanJobs = new Map<string, ScanJob>();

interface ScanSummary {
  fresh: number;
  not_fresh: number;
  unverified: number;
  new_fiber: number;
  tenured_fiber: number;
  existing_fiber: number;
  copper: number;
  no_service: number;
  unknown: number;
}

function emptyScanSummary(): ScanSummary {
  return {
    fresh: 0, not_fresh: 0, unverified: 0,
    new_fiber: 0, tenured_fiber: 0, existing_fiber: 0,
    copper: 0, no_service: 0, unknown: 0,
  };
}

function scanResultView(result: any, persisted?: PersistKineticObservationResult | null) {
  const decision = evidenceBackedVerdict(result, persisted);
  return {
    address: result.address,
    city: result.city,
    state: result.state,
    zip: result.zip,
    lat: result.lat ?? null,
    lng: result.lng ?? null,
    fiberStatus: result.fiberStatus ?? "unknown",
    isNewFiber: result.isNewFiber === true,
    fiberAvailable: result.fiberAvailable === true,
    freshFiberVerdict: decision.verdict,
    isFreshFiber: decision.isFreshFiber,
    verdictLabel: decision.label,
    verdictMessage: decision.message,
    confirmation: decision.confirmation,
  };
}

function countScanRow(summary: ScanSummary, row: any): void {
  const verdict: FreshFiberVerdict = row.freshFiberVerdict ?? decideFreshFiber(row).verdict;
  summary[verdict]++;
  const status = String(row.fiberStatus ?? "unknown") as keyof ScanSummary;
  if (status in summary && !["fresh", "not_fresh", "unverified"].includes(status)) summary[status]++;
}

function appendScanResult(job: ScanJob, result: any, persisted?: PersistKineticObservationResult | null): void {
  const row = scanResultView(result, persisted);
  job.results.push(row);
  job.summary ??= emptyScanSummary();
  countScanRow(job.summary, row);
}

function scanSummary(job: ScanJob): ScanSummary {
  if (!job.summary) {
    job.summary = emptyScanSummary();
    for (const row of job.results) countScanRow(job.summary, row);
  }
  return job.summary;
}

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

// ── Background scanner — bounded provider queue ──────────────────────────────
// Every route shares the process-wide queue in scanner.ts. The queue, adaptive
// backpressure, and configured authorization—not the socket pool—set throughput.
// Express 5 types req.params/query/header values as string | string[]; normalize
// to a plain string (first element for arrays, "" for absent) without changing
// behavior for the single-string case.
const qstr = (v: unknown): string => Array.isArray(v) ? String(v[0] ?? "") : typeof v === "string" ? v : "";

// ── Shared scan engine ───────────────────────────────────────────────────────
// The old continuous-fire, multi-zone city-scan path was removed because it
// blew past Kinetic's refilling rolling-window and
// self-throttled to ~90% 403s / 0 leads. The city scan now runs through the same
// bounded, backoff-aware qualifyAddressesViaKinetic() the tiled/box scans use.

// ── Provider observation persistence ─────────────────────────────────────────
// Route scanners do not create leads. Every provider answer becomes immutable
// evidence first; only freshFiberProjector may publish an operational door after
// an unavailable→fiber transition and independent address-level corroboration.
function persistRouteKineticObservation(
  source: string,
  tenantId: number,
  result: ScanResult,
  fallback: { lat?: number | null; lng?: number | null } = {},
  startedAtMs?: number,
): PersistKineticObservationResult {
  return persistKineticObservation({
    tenantId,
    source,
    latencyMs: startedAtMs == null ? undefined : Date.now() - startedAtMs,
    observation: {
      address: result.address,
      city: result.city,
      state: result.state,
      zip: result.zip,
      lat: result.lat ?? fallback.lat ?? null,
      lng: result.lng ?? fallback.lng ?? null,
      fiberStatus: result.fiberStatus,
      fiberAvailable: result.fiberAvailable,
      isNewFiber: result.isNewFiber,
      billingStatus: result.billingStatus,
      householdSegmentType: result.householdSegmentType,
      dfAddressId: result.dfAddressId,
      accessId: result.accessId,
      serviceKey: result.serviceKey,
      maxDownloadMbps: result.maxDownloadMbps,
      techType: result.techType,
      speedTier: result.speedTier,
      competitorName: result.competitorName,
      competitorTech: result.competitorTech,
      competitorSpeedMbps: result.competitorSpeedMbps,
      addressCatalogDate: result.addressCatalogDate,
      apiSource: result.apiSource,
      blocked: result.blocked,
      checkFailed: result.apiSource === "failed",
      discoveredAt: new Date().toISOString(),
      rawResponse: result.rawResponse,
    },
  });
}

function logObservationFailure(source: string, result: Pick<ScanResult, "address" | "city" | "state">, error: unknown): void {
  const addressKey = crypto.createHash("sha256")
    .update(`${result.address}|${result.city}|${result.state}`.toLowerCase())
    .digest("hex")
    .slice(0, 16);
  structuredLog("scan.observation_persist_failed", {
    source,
    addressKey,
    error: String((error as any)?.message ?? error),
  }, "error");
}

// (scanOneBatch + runZoneWorker removed — the continuous-fire city-scan path they
//  implemented self-throttled against Kinetic. runCityScan now uses the bounded,
//  backoff-aware qualifyAddressesViaKinetic() below.)

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

  // ── PACED qualification — bounded concurrency + 403 backoff ───────────────
  // The old zone-worker fan-out fired ~400 Kinetic calls in flight with ZERO
  // delay (SCAN_BATCH_SIZE 200 × zones), which blows straight past Kinetic's
  // refilling rolling-window → a wall of 403s → ~0 real checks and 0 leads
  // (verified live: a 5,843-address Lexington run got 4,600 HTTP errors, 470
  // successes, 0 fiber). Route through the SAME bounded qualifier the tiled/box
  // scans use (pooledMap cap + jittered backoff on throttle) so we stay inside
  // the window and actually harvest fiber. tenantId comes off the job stamp.
  try {
    await qualifyAddressesViaKinetic(addresses as any, job.tenantId ?? 1, {
      source: "route-city-scan",
      priority: "city",
      concurrency: Number(process.env.CITY_SCAN_CONCURRENCY ?? 8),
      shouldStop: () => job.status !== "running",
      onScanned: (result, scanned, leads, address, persisted) => {
        job.done = scanned;
        (job as any).newFiber = leads;
        _scanWorkerState.lastHeartbeat = Date.now();
        if (result) appendScanResult(job, result, persisted);
        else {
          appendScanResult(job, { ...address, fiberStatus: "unknown", isNewFiber: false, fiberAvailable: false, apiSource: "failed" });
          recordCheck(false, true);
        }
      },
    });
    job.status = "done";
  } catch (error) {
    job.status = "error";
    structuredLog("scan.city.stopped", { jobId, reason: String((error as any)?.message ?? error) }, "error");
  } finally {
    job.completedAt = new Date().toISOString();
    _scanWorkerState.isRunning = false;
    _scanWorkerState.checksPerSec = 0;
    _scanWorkerState.concurrency = 0;
  }
  console.log(`[scan] Job ${jobId} complete: ${job.done} checked, ${_scanWorkerState.diagNewFiber} primary matches`);
}

// ── Qualify a resolved address list through Kinetic (bounded + backoff) ───────
// Shared by the tiled region worker. Probes each address with capped concurrency,
// retries transient throttles, persists every answer as evidence, and returns
// only independently-confirmed publications. Does NOT touch scanJobs — the
// caller owns progress and the evidence projector owns lead creation.
async function qualifyAddressesViaKinetic(
  addresses: RawAddress[],
  tenantId: number,
  opts: {
    source?: string;
    priority?: ProviderRequestPriority;
    concurrency?: number;
    shouldStop?: () => boolean;
    onScanned?: (result: ScanResult | null, scanned: number, leads: number, address: RawAddress, persisted: PersistKineticObservationResult | null) => void;
  } = {},
): Promise<{ leads: number; scanned: number }> {
  const concurrency = opts.concurrency ?? Number(process.env.AREA_SCAN_CONCURRENCY ?? 10);
  const source = opts.source ?? "route-address-qualifier";
  const priority = opts.priority ?? (source.includes("area") || source.includes("tiled") ? "lasso" : source.includes("city") ? "city" : "market");
  let leads = 0, scanned = 0;
  await pooledMap(addresses, concurrency, async (a) => {
    if (opts.shouldStop?.()) return null; // cancelled → stop spending on new probes
    const startedAtMs = Date.now();
    let result: ScanResult | null = null;
    for (let attempt = 0; attempt <= 2; attempt++) {
      try { result = await addressScanner(a.address, a.city, a.state, a.zip || "", { source: priority }); }
      catch { result = null; }
      const throttled = !result || (result.apiSource === "failed" && result.blocked);
      if (!throttled) break;
      if (attempt < 2) await new Promise((r) => setTimeout(r, backoffDelayMs(attempt, { baseMs: 400, capMs: 3000 })));
    }
    scanned++;
    let persisted: PersistKineticObservationResult | null = null;
    if (result) {
      if (!result.lat && a.lat) result.lat = a.lat;
      if (!result.lng && a.lng) result.lng = a.lng;
      recordCheck(decideFreshFiber(result).isFreshFiber === true, result.apiSource === "failed");
      try {
        persisted = persistRouteKineticObservation(source, tenantId, result, a, startedAtMs);
        leads += persisted.projection.published;
      } catch (error) {
        // One malformed/colliding address must not abort a city or tiled scan,
        // but it also must never fall back to a direct lead write.
        logObservationFailure(source, result, error);
      }
    }
    opts.onScanned?.(result, scanned, leads, a, persisted); // caller-owned progress (city scan drives job.done + diag)
    return result;
  });
  return { leads, scanned };
}

// ── Drawn-box qualifier: bounded concurrency + backoff ────────────────────────
// A drawn box is a small, resolved address list (a subdivision, not a whole
// city), so it doesn't need the 4×200 city-scan fan-out — and MUST NOT open
// hundreds of simultaneous proxied Kinetic calls (that's how you trip a 429).
// pooledMap bounds in-flight calls; each call rotates the Decodo session and
// retries transient failures immediately — never waits, never drops an address.
const AREA_SCAN_CONCURRENCY = Number(process.env.AREA_SCAN_CONCURRENCY ?? 25); // unlimited budget: drawn-box scans run 25-wide (was 10)
// Upper bound on a single bulk lead operation (lasso assign / status). Each id
// runs synchronous SQLite work on the one event-loop thread, so this caps how
// long one request can monopolize it. A real lasso selection is well under this.
const MAX_BULK_LEADS = 500;
// Bulk ASSIGN is set-based + chunked (two statements per 500-lead chunk, with
// an event-loop yield between chunks), so it is not bound by the per-row cost
// that caps the other bulk routes. A rep can be handed a whole neighbourhood
// in one lasso. Still bounded — the payload itself must stay sane.
const MAX_BULK_ASSIGN_LEADS = Math.max(500, Number(process.env.MAX_BULK_ASSIGN_LEADS) || 25_000);
async function runAreaScan(jobId: string, addresses: ReturnType<typeof generateAddresses>) {
  const job = scanJobs.get(jobId);
  if (!job) return;
  job.total = addresses.length;
  job.done = 0;
  _scanWorkerState.isRunning = true;
  _scanWorkerState.lastHeartbeat = Date.now();
  _scanWorkerState.diagNewFiber = 0;
  _scanWorkerState.diagHttpError = 0;
  _scanWorkerState.diagSuccess = 0;
  _scanWorkerState.diagFailed = 0;

  try {
    await qualifyAddressesViaKinetic(addresses as any, job.tenantId ?? getDefaultTenantId() ?? 1, {
      source: "route-area-scan", priority: "lasso", concurrency: AREA_SCAN_CONCURRENCY,
      shouldStop: () => !scanJobs.has(jobId),
      onScanned: (result, scanned, leads, address, persisted) => {
        job.done = scanned;
        (job as any).newFiber = leads;
        _scanWorkerState.lastHeartbeat = Date.now();
        if (result) appendScanResult(job, result, persisted);
        else {
          appendScanResult(job, { ...address, fiberStatus: "unknown", isNewFiber: false, fiberAvailable: false, apiSource: "failed" });
          recordCheck(false, true);
        }
      },
    });
    if (scanJobs.has(jobId)) job.status = "done";
  } catch (error) {
    if (scanJobs.has(jobId)) job.status = "error";
    structuredLog("scan.area.stopped", { jobId, reason: String((error as any)?.message ?? error) }, "error");
  } finally {
    if (scanJobs.has(jobId)) job.completedAt = new Date().toISOString();
    _scanWorkerState.isRunning = false;
    _scanWorkerState.concurrency = 0;
  }
  console.log(`[scan] Area job ${jobId} complete: ${job.done}/${job.total} checked, ${_scanWorkerState.diagNewFiber} primary matches`);
}

// ── Routes ────────────────────────────────────────────────────────────────────
export function registerRoutes(_httpServer: Server, app: Express) {

  registerAddressDiscoveryRoutes(app, { requireAuth, requireCapability, requireScanningAllowed });
  registerCallingRoutes(app, { requireAuth, requireCapability });
  registerFiberOperationsRoutes(app, {
    requireAuth, requireCapability, requireScanningAllowed, scanAdmission: authorizedScanAdmission,
  });
  registerKineticScannerRoutes(app, {
    requireCapability, requireScanningAllowed, scanAdmission: authorizedScanAdmission,
  });
  // Coming-Soon watchlist (rep-facing) + ranked fresh leads — same injected-auth pattern.
  registerComingSoonRoutes(app, { requireAuth, requireManager });
  registerLeadRankingRoutes(app, { requireAuth });

  // ── Weekly commission (Phase 2) internal API — injects the shared auth
  // middleware so authorization matches the rest of the app. ────────────────────
  registerCommissionRoutes(app, { requireAuth, requireCapability });
  registerPayoutRoutes(app, { requireAuth, requireCapability });
  registerOnboardingDocumentRoutes(app, { requireAuth, requireCapability });

  // ── Health check — used by the hosting platform (Railway) to gate deploys ────
  // No auth, no secrets, and a cheap DB round-trip so a wedged SQLite handle
  // fails the check instead of serving a zombie app.
  // Liveness/readiness probe — exercises the DB, reports version + uptime. Safe
  // for uptime monitors and load balancers; carries NO secrets or PII.
  app.get("/api/health", (_req, res) => {
    try {
      storage.getSession("health-probe"); // any read exercises the DB connection
      res.json({
        ok: true,
        status: "healthy",
        version: APP_VERSION,
        db: "up",
        uptimeSec: Math.round(process.uptime()),
        time: new Date().toISOString(),
      });
    } catch {
      res.status(503).json({ ok: false, status: "unhealthy", db: "down", time: new Date().toISOString() });
    }
  });

  // Staged rollout of the status-marker glyph layer (see the flag in /config/map).
  // Default (env unset) enables it for admins/owners only — the spec's "internal/
  // admin tenant" canary — so a deploy ships it live for the owner to verify
  // without changing every rep's map. STATUS_MARKER_GLYPHS=all widens to 100% in
  // one env change; =off is an instant server-side kill-switch (no redeploy of code).
  function statusMarkerGlyphsEnabled(role: string | null | undefined): boolean {
    const env = String(process.env.STATUS_MARKER_GLYPHS ?? "").toLowerCase().trim();
    if (env === "off" || env === "0" || env === "false") return false;
    if (env === "all" || env === "on" || env === "1" || env === "true") return true;
    return role === "admin" || role === "super_admin";
  }

  // ── Map config — returns Mapbox token only to authenticated users ───────────
  // Token is NOT in the frontend bundle; fetched at runtime from the server.
  // App-level public config (no secrets): role lists the client must never
  // hardcode. AUDIT FIX: super-admin emails were hardcoded in TWO client files.
  app.get("/api/config/app", requireAdmin, (req: any, res: any) => {
    // P0-1 (reviewer B2): never disclose the apex email list — the caller only
    // needs to know if THEY are apex (from the immutable column).
    res.json({ youAreSuperAdmin: !!(req as any).user?.isSuperAdmin });
  });

  app.get("/api/config/map", requireAuth, (req: any, res) => {
    // The map basemap/pins use a PUBLIC token (pk.…) that is safe to send to the
    // browser — scope it in Mapbox to URL-restricted "styles:read/tiles:read" only,
    // NOT geocoding. The SECRET geocoding token (MAPBOX_TOKEN) stays server-side and
    // is NEVER a fallback here: shipping it to the browser would let any user run
    // unbounded paid geocoding on the owner's account (see the two billing incidents).
    const token = process.env.MAPBOX_PUBLIC_TOKEN ?? process.env.VITE_MAPBOX_TOKEN ?? "";
    if (!token) return res.status(503).json({ error: "Map not configured" });
    // Server-controlled feature flags. `statusMarkerGlyphs` gates the status-icon
    // pin layer (arrow/$/star/… glyphs vs plain circles) and rolls out in stages:
    // env unset → admins/owners only (canary); STATUS_MARKER_GLYPHS=all → everyone;
    // STATUS_MARKER_GLYPHS=off → hard kill-switch. The client can still force it on
    // or off per-device (localStorage NEW_FIELD_MAP) for its own testing.
    res.json({ token, flags: { statusMarkerGlyphs: statusMarkerGlyphsEnabled(req.user?.role) } });
  });

  // ── Geocode a single street/address → map coordinates (admin) ──────────────
  // ONE Mapbox forward-geocode per UNIQUE query — results are cached in memory
  // forever (street coordinates don't move), so repeat lookups cost nothing.
  // Mapbox includes 100k free geocoding requests/month; this uses a handful.
  const geocodeCache = new Map<string, { lng: number; lat: number; placeName: string }>();
  // ONE bounded, cache-first forward geocode for server-side use (lead create
  // fallback). Never a silent bulk path — a single call per unique address,
  // null on any failure (the caller keeps the lead without coordinates rather
  // than erroring). Shares the route cache above so repeats cost nothing.
  async function forwardGeocodeOnce(q: string): Promise<{ lng: number; lat: number; placeName: string } | null> {
    const trimmed = q.trim();
    if (trimmed.length < 3) return null;
    const key = trimmed.toLowerCase();
    const cached = geocodeCache.get(key);
    if (cached) return cached;
    const token = process.env.MAPBOX_TOKEN ?? process.env.MAPBOX_PUBLIC_TOKEN ?? "";
    if (!token) return null;
    try {
      const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(trimmed)}.json` +
        `?access_token=${token}&country=us&limit=1&types=address`;
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) return null;
      const data = await r.json();
      const f = data.features?.[0];
      if (!f) return null;
      const [lng, lat] = f.center;
      const result = { lng, lat, placeName: f.place_name ?? trimmed };
      geocodeCache.set(key, result);
      if (geocodeCache.size > 2000) geocodeCache.delete(geocodeCache.keys().next().value!); // FIFO bound
      return result;
    } catch {
      return null;
    }
  }
  app.get("/api/geocode", geocodeLimiter, requireCapability("scan.submit"), async (req, res) => {
    const q = String(req.query.q ?? "").trim();
    if (q.length < 3) return res.status(400).json({ error: "query too short" });
    const key = q.toLowerCase();
    const cached = geocodeCache.get(key);
    if (cached) return res.json({ ...cached, cached: true });
    const token = process.env.MAPBOX_TOKEN ?? process.env.MAPBOX_PUBLIC_TOKEN ?? "";
    if (!token) return res.status(503).json({ error: "Geocoding not configured" });
    try {
      const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q)}.json` +
        `?access_token=${token}&country=us&limit=1&types=address,neighborhood,locality,place`;
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) return res.status(502).json({ error: `Mapbox geocoding failed: ${r.status}` });
      const data = await r.json();
      const f = data.features?.[0];
      if (!f) return res.status(404).json({ error: `No match for “${q}”` });
      const [lng, lat] = f.center;
      const result = { lng, lat, placeName: f.place_name ?? q };
      geocodeCache.set(key, result);
      if (geocodeCache.size > 2000) geocodeCache.delete(geocodeCache.keys().next().value!); // FIFO bound
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Reverse geocode a tapped map point → an address (tap-a-house) ───────────
  // A rep taps a rooftop on the map; we turn the lat/lng into a street address so
  // they can add it as a lead without typing. Cached by ~11 m rounded point so
  // repeat taps on the same house cost nothing. requireAuth — any field user.
  const revGeocodeCache = new Map<string, { address: string; city: string; state: string; zip: string; lat: number; lng: number; placeName: string }>();
  // requireTeamLead: only roles that can actually CREATE a lead need tap-a-house,
  // and gating it (+ the global per-IP rate limit + ~11 m cache) bounds paid
  // Mapbox exposure per the billing guardrails.
  app.get("/api/geocode/reverse", requireTeamLead, async (req, res) => {
    const lat = Number(req.query.lat), lng = Number(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return res.status(400).json({ error: "valid lat & lng required" });
    }
    const key = `${lat.toFixed(4)},${lng.toFixed(4)}`; // ~11 m grid
    const cached = revGeocodeCache.get(key);
    if (cached) return res.json({ ...cached, cached: true });
    const token = process.env.MAPBOX_TOKEN ?? process.env.MAPBOX_PUBLIC_TOKEN ?? "";
    if (!token) return res.status(503).json({ error: "Geocoding not configured" });
    try {
      const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json` +
        `?access_token=${token}&country=us&types=address&limit=1`;
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) return res.status(502).json({ error: `Mapbox reverse geocode failed: ${r.status}` });
      const data = await r.json();
      const f = data.features?.[0];
      if (!f) return res.status(404).json({ error: "No address at that point" });
      const place: string = f.place_name ?? "";
      const parts = place.split(",").map((s: string) => s.trim());
      const zipMatch = place.match(/\b(\d{5})\b/);
      const ctx: any[] = f.context ?? [];
      const cityCtx = ctx.find((c) => String(c.id).startsWith("place"))?.text ?? (parts[1] ?? "");
      const stCtx = ctx.find((c) => String(c.id).startsWith("region"))?.short_code?.replace("US-", "") ?? "";
      const result = {
        address: parts[0] ?? place,
        city: cityCtx,
        state: stCtx || "NC",
        zip: zipMatch ? zipMatch[1] : "",
        lat: f.center?.[1] ?? lat, lng: f.center?.[0] ?? lng,
        placeName: place,
      };
      revGeocodeCache.set(key, result);
      if (revGeocodeCache.size > 4000) revGeocodeCache.delete(revGeocodeCache.keys().next().value!);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });


  // ── Evidence-backed NC/SC Kinetic market catalog ───────────────────────────
  // Never publish fabricated passings or generalize address availability from a
  // city. This is a planning/scheduling catalog; only address-level checks can
  // produce availability evidence and only cross-verified flips produce leads.
  app.get("/api/markets/kinetic", requireManager, (_req, res) => {
    syncMarketState();
    let rows = listMarkets({ eligibility: "verified", limit: 2_000 }) as any[];
    // Startup normally initializes the catalog. Keep this route independently
    // deployable without rewriting the 820-row Census catalog on every visit.
    if (!rows.length) {
      seedStateMarkets();
      syncMarketState();
      rows = listMarkets({ eligibility: "verified", limit: 2_000 }) as any[];
    }
    res.json({
      lastUpdated: CATALOG_OBSERVED_AT,
      source: "Kinetic official NC/SC fiber and other-high-speed location directories",
      sourceUrls: KINETIC_DIRECTORY_URLS,
      totalNewPassings: null,
      markets: rows.map((market) => ({
        state: market.state, city: market.city, zip: "",
        newPassings: 0, addressCount: Number(market.address_count ?? 0), freshWeek: Number(market.fresh_week ?? 0),
        priority: market.priority_class,
        buildStatus: market.kinetic_status === "verified_expanding" ? "active"
          : market.kinetic_status === "verified_legacy_service" ? "change_watch" : "complete",
        buildDate: market.evidence_checked_at ?? CATALOG_OBSERVED_AT,
        kineticStatus: market.kinetic_status, evidenceUrl: market.announcement_url ?? market.directory_url,
        inventoryStatus: market.inventory_status, coverageGap: market.coverage_gap,
      })),
    });
  });

  // ── Address-scanner state ──────────────────────────────────────────────────
  // Polled every 3s by the CityScanner UI to show live efficiency metrics.
  app.get("/api/scanner/state", requireManager, (_req, res) => {
    const activeJob = Array.from(scanJobs.values()).find(j => j.status === "running");
    const providerQueue = getAddressScanQueueStatus();
    const lastActivityAt = Math.max(_scanWorkerState.lastHeartbeat, providerQueue.lastActivityAt);
    const secondsSinceHeartbeat = Math.floor((Date.now() - lastActivityAt) / 1000);
    res.json({
      ..._scanWorkerState,
      isRunning: _scanWorkerState.isRunning || providerQueue.active > 0 || providerQueue.queued > 0,
      concurrency: providerQueue.active,
      maxInFlight: providerQueue.maxConcurrency,
      queueDepth: providerQueue.queued,
      providerQueue,
      isStuck: (_scanWorkerState.isRunning || providerQueue.active > 0) && secondsSinceHeartbeat > 120,
      secondsSinceHeartbeat,
      activeJob: activeJob ? {
        id: activeJob.id,
        city: activeJob.city,
        total: activeJob.total,
        done: activeJob.done,
        pct: activeJob.total ? Math.round(activeJob.done / activeJob.total * 100) : 0,
        newFiber: scanSummary(activeJob).fresh,
      } : null,
    });
  });

  // NOTE: the old /api/leads/live-clusters endpoint was REMOVED (2026-07-10):
  // zero client callers, and its `require("supercluster")` threw in BOTH
  // runtimes (dev ESM has no require; prod left the ESM-only package external),
  // so its catch silently returned raw UNCLUSTERED pins — the opposite of its
  // purpose. Clustering is GPU-side in Mapbox (client), which scales past 100k.

  // Leads CRUD
  // ── Map-optimized endpoint: returns ALL leads with only pin fields ─────────
  // Deliberately before /api/leads/:id so "/map" doesn't get caught as an :id
  // ── Map pin cache — avoids re-querying 50k+ leads on every poll ─────────────
  // Keyed PER TENANT (the old single-slot cache required !tenantId, and every
  // real user has a tenant since bootstrap — so it never hit in production).
  // Only the unscoped org-wide view per tenant is cached; scoped team_lead/rep
  // views are always computed fresh so role visibility can never leak via cache.
  interface MapPinCacheEntry {
    ts: number;
    pins: any[];
    ver?: string;
    dbMs: number;
    buildMs: number;
    packed?: PackedMapPins;
  }
  const _mapPinCache = new Map<string, MapPinCacheEntry>();
  const MAP_CACHE_TTL = 8_000; // 8s — fast enough for real-time feel
  // Monotonic data version — powers the /api/leads/map ETag so a steady-state
  // poll returns 304 for the cost of a string compare, not a query + 50k-row
  // serialize + gzip. Two tiers: a write whose tenant is KNOWN bumps only that
  // tenant's counter (other tenants keep their 304s); a write of unknown
  // tenancy bumps the global epoch, invalidating everyone — coarse can never
  // serve stale. The boot stamp makes cross-restart 304s impossible
  // (out-of-band DB edits while the server is down can't be version-tracked).
  const _leadsEtagBoot = Date.now().toString(36);
  let _leadsEpoch = 0;
  const _leadsBustByTenant = new Map<number, number>();
  const _leadMapStreams = new Map<number, Set<Response>>();

  function emitLeadMapChanged(tenantId?: number) {
    const groups = tenantId == null ? [..._leadMapStreams.values()] : [_leadMapStreams.get(tenantId)];
    const payload = `event: map-changed\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`;
    for (const clients of groups) for (const client of clients ?? []) {
      if (client.writableEnded || client.destroyed) clients?.delete(client);
      else { try { client.write(payload); } catch { clients?.delete(client); } }
    }
  }

  function getMapPins(tenantId?: number, repFilter?: number | number[], dataVer?: string): {
    entry: MapPinCacheEntry;
    cacheHit: boolean;
    scopeKey: string;
  } {
    const now = Date.now();
    // Cache EVERY scope, not just unscoped manager/admin views. A rep's scoped view
    // is the COMMON case and used to recompute both queries on every load + 60s poll
    // (the cache never fired for them). Key by tenant+scope so a rep can never read
    // another scope's pins; the dataVer guard busts it on any lead write (8s TTL
    // otherwise). Scopes are bounded (few reps/tenant); a soft cap bounds growth.
    const scopeKey = repFilter == null ? "all" : [repFilter].flat().sort((a, b) => a - b).join(",");
    const cacheKey = `${tenantId ?? 0}|${scopeKey}`;
    const hit = _mapPinCache.get(cacheKey);
    // Reuse only within TTL AND if the DB hasn't changed (a scan in another
    // process bumps dataVer) — never serve stale pins after new leads land.
    if (hit && now - hit.ts < MAP_CACHE_TTL && (dataVer == null || hit.ver === dataVer)) {
      return { entry: hit, cacheHit: true, scopeKey };
    }
    const dbStarted = performance.now();
    // Narrow projection + latest-visit metadata in one scoped SQL query.
    const all = storage.getLeadsForMap(tenantId, repFilter);
    const dbMs = performance.now() - dbStarted;
    const buildStarted = performance.now();
    const pins: any[] = [];
    // COMPACT pins: omit empty (null/false/0/"") fields and round lat/lng to 6dp
    // (~0.1m). Measured 35% smaller raw JSON (2.04MB → 1.33MB at 5.5k leads) → the
    // client parses far less on load. Safe: the map + card read every optional field
    // by truthiness, so an absent key behaves exactly like the old null/false/0.
    // id/lat/lng/leadStatus are always kept (geometry + dot color depend on them).
    for (const l of all) {
      if (!l.lat || !l.lng) continue;
      const pin: any = {
        id: l.id,
        lat: Math.round(l.lat * 1e6) / 1e6,
        lng: Math.round(l.lng * 1e6) / 1e6,
        leadStatus: l.leadStatus,
      };
      for (const k in l) {
        if (k === "id" || k === "lat" || k === "lng" || k === "leadStatus" ||
            k === "knockCount" || k === "lastOutcome" || k === "lastKnockedAt") continue;
        const val = (l as any)[k];
        if (val !== null && val !== false && val !== 0 && val !== "") pin[k] = val;
      }
      if (l.knockCount) {
        pin.visited = true;
        pin.knockCount = l.knockCount;
        if (l.lastOutcome) pin.lastOutcome = l.lastOutcome;
        if (l.lastKnockedAt) pin.lastKnockedAt = l.lastKnockedAt;
      }
      pins.push(pin);
    }
    const entry: MapPinCacheEntry = {
      ts: Date.now(), pins, ver: dataVer, dbMs,
      buildMs: performance.now() - buildStarted,
    };
    if (_mapPinCache.size > 500) _mapPinCache.clear(); // soft cap — bound stale-scope accumulation
    _mapPinCache.set(cacheKey, entry);
    return { entry, cacheHit: false, scopeKey };
  }

  // Distinct city/state pairs for the Leads filter dropdowns — a two-column
  // DISTINCT instead of the whole hydrated pin set. Same visibility scope as
  // the list/map reads.
  app.get("/api/leads/facets", requireAuth, (req: any, res: any) => {
    const user = req.user;
    const tid = user?.tenantId ?? undefined;
    const scope = leadVisibilityScope(user);
    const repScope = Array.isArray(scope) ? scope : (scope != null ? [scope] : undefined);
    res.json({ facets: storage.getLeadFacets(tid, repScope) });
  });

  app.get("/api/leads/map", requireAuth, (req: any, res: any) => {
    const parsedQuery = z.object({ format: z.enum(["object", "packed"]).default("object") })
      .safeParse(req.query);
    if (!parsedQuery.success) return res.status(400).json({ error: "format must be object or packed" });
    const format = parsedQuery.data.format;
    const user = req.user;
    const tid = user?.tenantId ?? undefined;
    const repFilter = leadVisibilityScope(user); // team_lead → their team; rep → self
    // Data-version ETag, checked BEFORE any DB work: an unchanged poll returns
    // 304 for the cost of a string compare. The scope key keeps role scoping
    // airtight — a rep's 304 token can never validate a manager's payload.
    const scopeKey = repFilter == null ? "all" : [repFilter].flat().sort((a, b) => a - b).join(",");
    // DB-derived version makes the ETag change on ANY cross-process lead write
    // (scan runner, nightly cron) — not just this process's own mutations. Without
    // it, a browser holding the pre-scan ETag would 304 forever and never see the
    // new leads. The in-memory epoch stays for instant same-process busts.
    const dbVer = storage.getLeadsDataVersion(tid);
    const ver = `${_leadsEpoch}.${_leadsBustByTenant.get(tid ?? 0) ?? 0}.${dbVer}`;
    const etag = `W/"pins-${format}-${_leadsEtagBoot}-${tid ?? 0}-${scopeKey}-${ver}"`;
    // This endpoint overrides the global no-store policy with private no-cache:
    // browsers may retain it only for conditional revalidation, never reuse it
    // without the ETag check. That turns unchanged polls into a zero-body 304.
    res.set("Cache-Control", "private, no-cache");
    res.set("ETag", etag);
    if (req.headers["if-none-match"] === etag) return res.status(304).end();
    const result = getMapPins(tid, repFilter, dbVer);
    const packStarted = performance.now();
    const payload = format === "packed"
      ? (result.entry.packed ??= packMapPins(result.entry.pins))
      : { pins: result.entry.pins, total: result.entry.pins.length };
    const packMs = format === "packed" ? performance.now() - packStarted : 0;
    res.set("X-Map-Cache", result.cacheHit ? "hit" : "miss");
    res.set("Server-Timing", [
      `leads_db;dur=${result.cacheHit ? 0 : result.entry.dbMs.toFixed(2)}`,
      `leads_build;dur=${result.cacheHit ? 0 : result.entry.buildMs.toFixed(2)}`,
      `leads_pack;dur=${packMs.toFixed(2)}`,
    ].join(", "));
    structuredLog("perf.leads_map", {
      requestId: String(req.id ?? "").slice(0, 8),
      tenantId: tid ?? 0,
      scope: result.scopeKey === "all" ? "all" : "scoped",
      format,
      cache: result.cacheHit ? "hit" : "miss",
      rows: result.entry.pins.length,
      dbMs: Number((result.cacheHit ? 0 : result.entry.dbMs).toFixed(2)),
      buildMs: Number((result.cacheHit ? 0 : result.entry.buildMs).toFixed(2)),
      packMs: Number(packMs.toFixed(2)),
      complexity: "O(L + K_scope)",
    });
    res.json(payload);
  });

  // Tenant-scoped invalidation stream. It carries no lead/address data: clients
  // refetch through the normal role-scoped map endpoint, so an event can never
  // widen visibility. The 60s ETag poll remains a reconnect fallback.
  app.get("/api/leads/events", requireAuth, (req: any, res: Response) => {
    const tenantId = Number(req.user?.tenantId ?? 0);
    const clients = _leadMapStreams.get(tenantId) ?? new Set<Response>();
    if (clients.size >= 250) return res.status(503).json({ error: "Too many live map connections; use the polling fallback." });
    res.status(200);
    res.set({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    clients.add(res);
    _leadMapStreams.set(tenantId, clients);
    res.write(`event: ready\ndata: {}\n\n`);
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) { try { res.write(": keepalive\n\n"); } catch { res.end(); } }
    }, 25_000);
    heartbeat.unref();
    req.on("close", () => {
      clearInterval(heartbeat);
      clients.delete(res);
      if (!clients.size) _leadMapStreams.delete(tenantId);
    });
  });

  // GET /api/leads/fresh — confirmed fresh-fiber leads published within the last
  // ?days (default 30, clamped 1..365), as slim GeoJSON for map pins. Row-level
  // scoped exactly like /api/leads/map (reps see only their own). ?city & ?state
  // narrow it (e.g. Lexington, NC). Properties are intentionally minimal:
  // {id, status, competitor_flag} — the detail comes from GET /api/leads/:id on tap.
  app.get("/api/leads/fresh", requireAuth, (req: any, res: any) => {
    const user = req.user;
    const tid = user?.tenantId ?? undefined;
    const repFilter = leadVisibilityScope(user);
    const q = req.query ?? {};
    const city = typeof q.city === "string" && q.city.trim() ? String(q.city).trim().slice(0, 60) : undefined;
    const state = typeof q.state === "string" && q.state.trim() ? String(q.state).trim().slice(0, 20) : undefined;
    const daysN = Number(q.days);
    const days = Number.isFinite(daysN) && daysN > 0 ? Math.min(Math.floor(daysN), 365) : 30;
    const status = q.status === "available" || q.status === "coming_soon" ? q.status : undefined;
    // carrier filter: 'kinetic' (default view for a Kinetic operation) | 'frontier' |
    // omitted (all). Keeps Frontier a real line while never letting it read as Kinetic.
    const carrier = typeof q.carrier === "string" && q.carrier.trim() ? String(q.carrier).trim().toLowerCase().slice(0, 20) : undefined;
    const rows = storage.getFreshLeads(tid, repFilter, { city, state, days, status, carrier });
    const features = rows
      .filter((r) => r.lat != null && r.lng != null)
      .map((r) => ({
        type: "Feature" as const,
        geometry: { type: "Point" as const, coordinates: [r.lng, r.lat] },
        properties: { id: r.id, status: r.leadStatus, competitor_flag: r.competitorName ? 1 : 0, carrier: r.carrier ?? "kinetic" },
      }));
    res.json({ type: "FeatureCollection", features, count: features.length, days, city: city ?? null, state: state ?? null, status: status ?? null });
  });

  app.get("/api/leads", requireAuth, (req, res) => {
    const { search, limit, offset, status, zip, city, state, assignedRepId, fiberStatus } = req.query;
    const user = (req as any).user;
    const tid = user?.tenantId ?? undefined;
    // Reps only see leads assigned to them; managers/admins see all
    const repFilter = leadVisibilityScope(user); // team_lead → their team; rep → self

    // Sanitize BEFORE SQL: NaN/negatives must never reach LIMIT/OFFSET —
    // SQLite treats a negative LIMIT as unbounded, which would let any
    // malformed query param force a full-table hydration.
    const limN = Number(limit), offN = Number(offset);
    const lim = Number.isFinite(limN) && limN > 0 ? Math.min(Math.floor(limN), 500) : 200;
    const off = Number.isFinite(offN) && offN > 0 ? Math.floor(offN) : 0;

    const filterOpts = {
      status: status && status !== "all" ? String(status) : undefined,
      zip: zip ? String(zip) : undefined,
      city: city && city !== "all" ? String(city) : undefined,
      state: state && state !== "all" ? String(state) : undefined,
      assignedRepId: assignedRepId === "unassigned"
        ? "unassigned" as const
        : (assignedRepId && Number.isInteger(Number(assignedRepId)) && Number(assignedRepId) > 0 ? Number(assignedRepId) : undefined),
      fiberStatus: fiberStatus && fiberStatus !== "all" ? String(fiberStatus) : undefined,
      limit: lim, offset: off,
    };

    // Both paths: filters + ORDER BY + LIMIT/OFFSET + exact count pushed into
    // SQL — the old code hydrated every tenant row (53 cols × 50k) to serve a
    // 200-row page, and the interim search path capped BEFORE filtering
    // (dropping real matches — review finding).
    const { rows, total } = search
      ? storage.searchLeadsPage(String(search), tid, repFilter, filterOpts)
      : storage.getLeadsPage(tid, repFilter, filterOpts);
    res.json({ leads: rows.map(r => stripProviderIds(r, user)), total, limit: lim, offset: off });
  });
  app.get("/api/leads/:id", requireAuth, (req, res) => {
    const lead = storage.getLeadById(Number(req.params.id));
    const user = (req as any).user;
    const tid = user?.tenantId;
    // Verify the lead belongs to the caller’s tenant
    if (!lead || (tid && lead.tenantId !== tid)) return res.status(404).json({ error: "Not found" });
    // Reps can only view leads assigned to them — 404 (not 403) to avoid leaking existence
    if (!repCanAccessLead(user, lead)) return res.status(404).json({ error: "Not found" });
    res.json(stripProviderIds(lead, user));
  });
  // Team lead+ can create leads; manager+ can update status/delete
  // Helper to bust map pin cache after any lead mutation
  function bustMapCache(tenantId?: number) {
    if (tenantId != null) {
      // Keys are now `${tenantId}|${scope}` — drop EVERY scope for this tenant.
      const prefix = `${tenantId}|`;
      for (const k of _mapPinCache.keys()) if (k.startsWith(prefix)) _mapPinCache.delete(k);
      _leadsBustByTenant.set(tenantId, (_leadsBustByTenant.get(tenantId) ?? 0) + 1);
    } else {
      // Unknown tenancy → invalidate everyone (never risk a stale 304).
      _mapPinCache.clear();
      _leadsEpoch++;
    }
    emitLeadMapChanged(tenantId);
  }
  // Expose globally so the evidence projector can invalidate map pins only when
  // a confirmed operational lead is actually published.
  (globalThis as any).__bustMapCache = bustMapCache;

  app.post("/api/leads", requireTeamLead, async (req: any, res: any) => {
    if (req.body?.contactPhone != null || req.body?.ownerPhone != null) {
      return res.status(400).json({
        error: "Phone data must be added through the Calling compliance module.",
        code: "CALLING_MODULE_REQUIRED",
      });
    }
    const parsed = insertLeadSchema.safeParse(req.body);
    if (!parsed.success) {
      // A human-readable first issue ("zip: String must contain at least 5
      // character(s)"), never the raw ZodError object — the client used to
      // render "[object Object]" in the toast.
      const issue = parsed.error.issues[0];
      const field = issue?.path?.length ? `${issue.path.join(".")}: ` : "";
      return res.status(400).json({ error: `${field}${issue?.message ?? "Invalid lead"}` });
    }
    // Fresh-fiber provenance is server-authored by freshFiberProjector only.
    // A browser-created ordinary prospect must never forge the confirmation
    // badge, evidence sources, source target, or a provider-fresh classification.
    const protectedFreshFields = ["sourceScanTargetId", "freshConfirmedAt", "freshConfidence", "freshSources"];
    if (protectedFreshFields.some((field) => Object.prototype.hasOwnProperty.call(req.body ?? {}, field)) ||
        req.body?.leadTag === "fresh_fiber_confirmed" || req.body?.isNewFiber === true ||
        String(req.body?.fiberStatus ?? "").toLowerCase() === "new_fiber") {
      return res.status(400).json({ error: "Fresh-fiber leads can only be created by the cross-verified scan pipeline." });
    }
    // Tenancy is never client-supplied: the lead belongs to the creator's org.
    const tenantId = req.user?.tenantId ?? getDefaultTenantId();
    // Duplicate address → 200 + existed:true with the winning row, so the map
    // can fly to the existing pin instead of ghost-inserting a second feature.
    const existing = storage.findLeadByAddress(
      tenantId,
      parsed.data.address ?? "",
      parsed.data.city ?? "",
      parsed.data.state ?? "",
      String((parsed.data as any).zip ?? ""),
    );
    if (existing) {
      return res.status(200).json({ ...stripProviderIds(existing, req.user), existed: true });
    }
    const safeLead = {
      ...parsed.data,
      tenantId,
      isNewFiber: false,
      sourceScanTargetId: undefined,
      freshConfirmedAt: undefined,
      freshConfidence: undefined,
      freshSources: undefined,
    };
    // Invisible-pin fix: a typed-in lead with no coordinates never rendered on
    // the map (the pin feed skips null lat/lng). ONE bounded forward geocode
    // fills them; on failure the lead still saves (list views show it).
    if ((safeLead as any).lat == null || (safeLead as any).lng == null) {
      const q = [safeLead.address, safeLead.city, safeLead.state, (safeLead as any).zip]
        .filter(Boolean).join(", ");
      const geo = await forwardGeocodeOnce(q);
      if (geo) {
        (safeLead as any).lat = geo.lat;
        (safeLead as any).lng = geo.lng;
      }
    }
    res.status(201).json(stripProviderIds(storage.createLead(safeLead as any), req.user));
  });
  app.patch("/api/leads/:id", requireManager, (req, res) => {
    // Allowlist only safe fields — prevent mass-assignment of internal fields
    const ALLOWED_LEAD_FIELDS = new Set([
      "leadStatus", "assignedRepId", "ownerName", "ownerEmail",
      "notes", "incomeRange", "homeValue", "yearsAtAddress", "isHomeowner",
      "deploymentNotes", "assignMark",
    ]);
    // A bad assignMark value is rejected rather than silently stored, so the
    // column only ever holds a known mark or null.
    if (Object.prototype.hasOwnProperty.call(req.body, "assignMark") && !isLeadMarkOrClear(req.body.assignMark)) {
      return res.status(400).json({ error: "Invalid mark", code: "INVALID_LEAD_MARK" });
    }
    const safeUpdate: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(req.body)) {
      if (ALLOWED_LEAD_FIELDS.has(k)) safeUpdate[k] = k === "assignMark" ? normalizeLeadMark(v) : v;
    }
    const tid = (req as any).user?.tenantId ?? undefined;
    // REVIEWER GATE (fin #3 / authz #2): a manager status edit advances the
    // outcome clock — without it, a stale offline knock could clobber the
    // manager's newer decision via the CAS.
    if (typeof (safeUpdate as any).leadStatus === "string" && !(safeUpdate as any).lastOutcomeAt) {
      (safeUpdate as any).lastOutcome = (safeUpdate as any).leadStatus;
      (safeUpdate as any).lastOutcomeAt = new Date().toISOString();
    }
    const updated = storage.updateLead(Number(req.params.id), safeUpdate as any, tid);
    if (!updated) return res.status(404).json({ error: "Not found" });
    res.json(stripProviderIds(updated, (req as any).user));
  });
  app.delete("/api/leads/:id", requireManager, (req, res) => {
    const tid = (req as any).user?.tenantId ?? undefined;
    if (!storage.deleteLead(Number(req.params.id), tid)) return res.status(404).json({ error: "Not found" });
    res.json({ success: true });
  });

  // ══ BILLING — SaaS lead-credit "banking" (see shared/billing.ts + billingStore.ts) ══
  // DARK by default: a tenant without a tenant_billing row reports enabled:false +
  // full access, so nothing here disturbs the live portal until billing is set up.
  // Reads are tenant-admin scoped; mutations are PLATFORM-OWNER-only (same gate as
  // the /api/sa tenant-management routes — an owner-email allow-list, since the
  // owner runs as role "admin", not a distinct super_admin role).
  function requireBillingOwner(req: Request, res: Response, next: NextFunction) {
    requireAuth(req, res, () => {
      const u = (req as any).user;
      // P0-1 (reviewer B1): billing apex also reads the immutable column —
      // never the mutable email string.
      if (!u || !["admin", "super_admin"].includes(u.role) || !u.isSuperAdmin) {
        return res.status(403).json({ error: "Platform owner only" });
      }
      next();
    });
  }
  // Which tenant a billing call targets. A tenant admin is pinned to their own org
  // (can never touch another's billing); a super_admin may target any via ?tenantId.
  function billingTenantId(req: Request): number {
    const u = (req as any).user;
    if (u?.tenantId != null) return u.tenantId;
    const q = Number((req.query?.tenantId ?? (req.body as any)?.tenantId));
    return Number.isFinite(q) && q > 0 ? q : (getDefaultTenantId() ?? 1);
  }
  // Provision (the ONLY row-creating path) must target an EXPLICIT tenant — never
  // the implicit default. This stops a super_admin's empty-body call from flipping
  // the live single-tenant org from dark → metered by accident (the whole point of
  // dark-by-default). A tenant admin is implicitly explicit (their own org).
  function explicitBillingTenantId(req: Request): number | null {
    const u = (req as any).user;
    if (u?.tenantId != null) return u.tenantId;
    const q = Number((req.query?.tenantId ?? (req.body as any)?.tenantId));
    return Number.isFinite(q) && q > 0 ? q : null;
  }

  // Plan catalog (prices are null until the owner sets them — UI shows "Contact us").
  app.get("/api/billing/plans", requireAuth, (_req, res) => {
    res.json({ plans: Object.values(BILLING_PLANS) });
  });
  // This tenant's billing snapshot (credits, state, access, usage level).
  app.get("/api/billing", requireAdmin, (req, res) => {
    res.json(billingSummary(billingTenantId(req)));
  });
  // Recent credit-ledger events for the usage panel.
  app.get("/api/billing/ledger", requireAdmin, (req, res) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    res.json({ events: getCreditLedger(billingTenantId(req), limit) });
  });
  // Provision billing for a tenant (dark → metered). Idempotent. Super-admin ops.
  // Requires an EXPLICIT tenantId and validates every enum so a tenant can never be
  // written into an unrecoverable state (an invalid `state` has no legal transition
  // out — it would brick the org).
  app.post("/api/billing/provision", requireBillingOwner, (req, res) => {
    const { planKey, state, overageMode, trialEndsAt } = req.body ?? {};
    const tenantId = explicitBillingTenantId(req);
    if (tenantId == null) return res.status(400).json({ error: "explicit tenantId required" });
    if (planKey != null && !(planKey in BILLING_PLANS)) return res.status(400).json({ error: "Unknown plan" });
    if (state != null && !isBillingState(state)) return res.status(400).json({ error: "Invalid billing state" });
    if (overageMode != null && !isOverageMode(overageMode)) return res.status(400).json({ error: "Invalid overage mode" });
    if (trialEndsAt != null && (typeof trialEndsAt !== "string" || Number.isNaN(Date.parse(trialEndsAt)))) {
      return res.status(400).json({ error: "Invalid trialEndsAt" });
    }
    const row = ensureBilling(tenantId, { planKey, state, overageMode, trialEndsAt });
    res.status(201).json(billingSummary(row.tenantId));
  });
  // Move a tenant through the billing state machine (validated transition).
  app.post("/api/billing/state", requireBillingOwner, (req, res) => {
    const to = String(req.body?.state ?? "");
    if (!isBillingEnabled(billingTenantId(req))) return res.status(404).json({ error: "Billing not provisioned" });
    const r = setBillingState(billingTenantId(req), to as any, `super_admin:${(req as any).user?.id}`);
    if (!r.ok) return res.status(409).json({ error: r.reason });
    res.json(billingSummary(billingTenantId(req)));
  });
  // Change plan (swaps allowance). Super-admin ops until self-serve upgrade ships.
  app.post("/api/billing/plan", requireBillingOwner, (req, res) => {
    const planKey = String(req.body?.planKey ?? "");
    if (!(planKey in BILLING_PLANS)) return res.status(400).json({ error: "Unknown plan" });
    if (!isBillingEnabled(billingTenantId(req))) return res.status(404).json({ error: "Billing not provisioned" });
    setPlan(billingTenantId(req), planKey as any, `super_admin:${(req as any).user?.id}`);
    res.json(billingSummary(billingTenantId(req)));
  });
  // Grant/purchase extra credits (adapter/admin top-up).
  app.post("/api/billing/credits", requireBillingOwner, (req, res) => {
    const amount = Math.floor(Number(req.body?.amount));
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: "amount must be > 0" });
    if (!isBillingEnabled(billingTenantId(req))) return res.status(404).json({ error: "Billing not provisioned" });
    grantCredits(billingTenantId(req), amount, "grant", `super_admin:${(req as any).user?.id}`);
    res.json(billingSummary(billingTenantId(req)));
  });

  // ── Access status — ANY authenticated user (drives the paywall banner). Cheap:
  // dark tenants report full access, so reps/managers are never gated by this. ──
  app.get("/api/billing/access", requireAuth, (req, res) => {
    const tid = (req as any).user?.tenantId ?? getDefaultTenantId() ?? 1;
    const s = billingSummary(tid);
    res.json({
      enabled: s.enabled, state: s.state, access: s.access,
      scanningAllowed: s.scanningAllowed, level: s.level,
      creditsRemaining: s.creditsRemaining, usagePct: s.usagePct,
      stripe: stripeConfigured(),
    });
  });

  // ── Self-serve checkout (tenant admin, own org) — returns a Stripe hosted URL.
  app.post("/api/billing/checkout", requireAdmin, async (req, res) => {
    if (!stripeConfigured()) return res.status(503).json({ error: "Payments are not enabled yet." });
    const planKey = String(req.body?.planKey ?? "");
    if (!(planKey in BILLING_PLANS) || planKey === "enterprise") return res.status(400).json({ error: "Choose Starter, Growth, or Professional." });
    const tid = (req as any).user?.tenantId ?? getDefaultTenantId() ?? 1;
    const origin = (req.headers.origin as string) || `https://${req.headers.host}`;
    const row = getBilling(tid);
    try {
      const session = await createCheckoutSession({
        tenantId: tid, planKey: planKey as any,
        successUrl: `${origin}/#/billing?checkout=success`,
        cancelUrl: `${origin}/#/billing?checkout=cancel`,
        customerId: row?.providerCustomerId ?? null,
        customerEmail: (req as any).user?.email ?? null,
      });
      res.json({ url: session.url });
    } catch (e: any) {
      res.status(502).json({ error: e.message || "Could not start checkout" });
    }
  });

  // ── Manage subscription — opens the Stripe billing portal for the tenant.
  app.post("/api/billing/portal", requireAdmin, async (req, res) => {
    if (!stripeConfigured()) return res.status(503).json({ error: "Payments are not enabled yet." });
    const tid = (req as any).user?.tenantId ?? getDefaultTenantId() ?? 1;
    const row = getBilling(tid);
    if (!row?.providerCustomerId) return res.status(409).json({ error: "No Stripe customer on file yet." });
    const origin = (req.headers.origin as string) || `https://${req.headers.host}`;
    try {
      const session = await createPortalSession(row.providerCustomerId, `${origin}/#/billing`);
      res.json({ url: session.url });
    } catch (e: any) {
      res.status(502).json({ error: e.message || "Could not open billing portal" });
    }
  });

  // ── Stripe webhook — NO session auth: authenticated by HMAC signature. Verifies
  // the signature against the raw body, is idempotent per event id (Stripe retries),
  // and dispatches to billingStore. Inert (503) until STRIPE_WEBHOOK_SECRET is set.
  app.post("/api/billing/webhook/stripe", (req, res) => {
    // Gate on BOTH keys — a billing-mutating webhook has no business running before
    // the account's secret key is set (avoids the write-path going live on the
    // webhook secret alone during setup).
    if (!stripeConfigured() || !webhookConfigured()) return res.status(503).json({ error: "billing not configured" });
    const raw = (req as any).rawBody;
    const sig = req.headers["stripe-signature"] as string | undefined;
    if (!raw || !verifyStripeSignature(raw, sig)) return res.status(400).json({ error: "invalid signature" });
    const event = req.body;
    if (!event?.id) return res.status(400).json({ error: "missing event id" });
    try {
      // Atomic: idempotency check + apply + record in one transaction.
      const result = processWebhookEvent(event);
      // Unresolvable (event before the tenant row exists) → 422 so Stripe retries.
      if (result.retriable) return res.status(422).json({ received: false, reason: "unresolved — will retry" });
      res.json({ received: true, applied: result.applied, kind: result.kind, duplicate: !!result.duplicate });
    } catch (e: any) {
      console.error(`[billing] webhook ${event.type} error: ${e.message}`);
      res.status(500).json({ error: "handler error" });
    }
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

  // Live Test — trace ONE address through the full pipeline (fresh mint, no
  // cache) and return each stage sanitized (never the bearer token or proxy
  // password). Admin-only; for diagnosing the live checker.
  app.post("/api/scan/live-test", requireAdmin, async (req, res) => {
    const parsed = z.object({
      address: z.string().trim().min(3).max(200),
      city: z.string().trim().max(120).default(""),
      state: z.string().trim().regex(/^[A-Za-z]{2}$/).default("NC"),
      zip: z.string().trim().max(10).default(""),
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid address", issues: parsed.error.issues });
    try {
      const { address, city, state, zip } = parsed.data;
      res.json(await liveTestAddress(address, city, state.toUpperCase(), zip));
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message ?? e) });
    }
  });

  // ── Scan Inspector (admin-only) ─────────────────────────────────────────────
  // Live per-address pipeline observability. Diagnostics are SAFE ONLY — masked
  // proxy session id + token last-4, HTTP status, latency, attempts, retry reason.
  // Full tokens / proxy credentials / auth headers are NEVER emitted.
  function inspectorHealth() {
    const token = getTokenStatus();
    return {
      decodoConnected: isProxyConnected(),
      proxySessionId: getProxySessionId(),           // masked "decodo-sN"
      tokenReady: token.hasToken,
      tokenExpiresIn: token.expiresIn,               // seconds
      tokenPool: { ready: token.readySessions, size: token.configuredSessions },
      paused: isScanningPaused(),
      queue: getAddressScanQueueStatus(),
    };
  }

  // Log-notation contract: every inspector event carries a stable per-address
  // correlation id (correlationId = the addressKey hash used across the pipeline)
  // plus an ISO timestamp, so one address is traceable end-to-end
  // queued→minting→token_ready→searching→parsing→saving→classified. Tokens and
  // credentials never appear — events carry only the masked decodo session id and
  // token last-4.
  const withCorrelation = <T extends { addressKey?: string; tsEpoch?: number }>(e: T) => ({
    ...e,
    correlationId: e.addressKey,
    ts: typeof e.tsEpoch === "number" ? new Date(e.tsEpoch).toISOString() : undefined,
  });
  app.get("/api/scan/inspector", requireAdmin, (req, res) => {
    const runId = typeof req.query.runId === "string" ? req.query.runId : null;
    const limit = Math.min(500, Math.max(10, Number(req.query.limit) || 200));
    const snap = getInspectorSnapshot({ runId, limit });
    res.json({ ...snap, rows: (snap.rows as any[])?.map(withCorrelation) ?? snap.rows, health: inspectorHealth() });
  });

  app.get("/api/scan/inspector/timeline/:key", requireAdmin, (req, res) => {
    res.json({ correlationId: String(req.params.key), timeline: getAddressTimeline(String(req.params.key), 80).map(withCorrelation) });
  });

  // SSE — streams each stage event as it happens. Never polls static counters.
  app.get("/api/scan/inspector/stream", requireAdmin, (req, res) => {
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();
    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    // Initial snapshot so a fresh/refreshed client paints immediately.
    send("snapshot", { ...getInspectorSnapshot({ limit: 200 }), health: inspectorHealth() });
    const unsub = onScanEvent((evt) => send("stage", evt));
    // Heartbeat + periodic health so "blocked stage" detection has a clock and the
    // Decodo/token status stays live even when no address is moving.
    const hb = setInterval(() => {
      try { res.write(`: ping\n\n`); send("health", inspectorHealth()); } catch { /* closed */ }
    }, 5000);
    req.on("close", () => { clearInterval(hb); unsub(); });
  });

  // Controls — Pause / Resume / Retry failed / Stop. Act on the shared provider
  // admission queue + active runs, so they govern every scan source at once.
  app.post("/api/scan/inspector/control", requireAdmin, async (req: any, res) => {
    const action = String(req.body?.action ?? "");
    try {
      if (action === "pause") { pauseScanning(); }
      else if (action === "resume") { resumeScanning(); }
      else if (action === "retry-failed") {
        const { listRuns, resetInflightTargets } = await import("./scanIntelStore");
        let requeued = 0;
        for (const r of listRuns(tid(req), 20)) {
          if (r.status === "running" || r.status === "paused") requeued += resetInflightTargets(r.id);
        }
        resumeScanning();
        return res.json({ ok: true, action, requeued });
      }
      else if (action === "stop") {
        const { listRuns } = await import("./scanIntelStore");
        const { controlRun } = await import("./scanService");
        let stopped = 0;
        for (const r of listRuns(tid(req), 20)) {
          if (r.status === "running" || r.status === "paused") { controlRun(r.id, tid(req), "cancel"); stopped++; }
        }
        pauseScanning();
        return res.json({ ok: true, action, stopped });
      }
      else return res.status(400).json({ error: "unknown action" });
      res.json({ ok: true, action, paused: isScanningPaused() });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message ?? e) });
    }
  });

  // ── Run-scoped stage feed (FIELD-facing) ────────────────────────────────────
  // The inspector above is requireAdmin, which left the person who actually
  // STARTED an area scan — a rep or manager standing on the street — with a
  // progress bar and no explanation when it stalls. These two routes expose the
  // SAME telemetry narrowed to ONE run the caller's tenant owns.
  //
  // Why a sibling route instead of adding a `runId` filter to
  // /api/scan/inspector/stream: that stream's payload is not just stage events —
  // every snapshot and every 5s heartbeat carries inspectorHealth(), i.e. the
  // proxy session id, token readiness/expiry and pool size. Loosening its gate
  // would widen an operational surface for everyone, and a per-audience payload
  // switch inside one handler is exactly the kind of branch that leaks the wrong
  // branch after a refactor. Instead these routes REUSE the existing store
  // (getInspectorSnapshot already accepts `runId`) and the existing in-process
  // relay (onScanEvent) — no new query, no new bus, no second event pipeline —
  // and project through a strict allowlist that cannot grow accidentally.
  //
  // Bounds: the snapshot is already capped at one row per address (latest stage);
  // we clamp harder than the admin cap because this is a phone on LTE, and there
  // is no `offset`, so the endpoint can never be walked to pull the whole table.
  const FIELD_STAGE_LIMIT_DEFAULT = 100;
  const FIELD_STAGE_LIMIT_MAX = 200;
  // Each SSE client pins one relay listener that every scan event must fan out
  // to, so concurrency is capped rather than left to the socket count.
  const FIELD_STAGE_MAX_STREAMS = 24;
  let fieldStageStreams = 0;

  // Field projection = ALLOWLIST, not a denylist. sessionId ("decodo-sN") and
  // tokenSuffix (JWT last-4) are already masked at the bus, but they are proxy/
  // credential *infrastructure* detail that answers nothing a rep can act on, so
  // they are dropped outright here — the safest handling of a masked secret is to
  // not ship it at all. detail/retryReason are the only free-text fields and they
  // originate upstream (provider error strings), so they go through the shared
  // secret scrubber: this route must be safe even when mounted without the global
  // response sanitizer in server/index.ts (tests and embedded harnesses are).
  //
  // Two input shapes flow through here and must produce ONE stable row contract,
  // so the client never branches on which transport delivered a row: a derived
  // InspectorRow from the snapshot (startedAt/updatedAt) and a raw bus event from
  // the live relay (tsEpoch). Both normalize to tsEpoch + startedAt.
  const fieldSafeStage = (e: any) => {
    const at = typeof e.tsEpoch === "number" ? e.tsEpoch : (typeof e.updatedAt === "number" ? e.updatedAt : null);
    return {
      // Same correlation contract as the admin inspector, so one address is
      // traceable across both surfaces.
      correlationId: e.addressKey ?? null,
      address: e.address ?? null, city: e.city ?? null, state: e.state ?? null, zip: e.zip ?? null,
      runId: e.runId ?? null,
      source: e.source ?? null,
      stage: e.stage, status: e.status ?? null,
      attempt: e.attempt ?? 1,
      httpStatus: e.httpStatus ?? null,
      latencyMs: e.latencyMs ?? null,
      retryReason: scrubSecretText(e.retryReason ?? null),
      classification: e.classification ?? null,
      detail: scrubSecretText(e.detail ?? null),
      startedAt: typeof e.startedAt === "number" ? e.startedAt : null,
      tsEpoch: at,
      ts: at == null ? null : new Date(at).toISOString(),
    };
  };

  // Run header a rep may see. Deliberately omits budget/estBytes/costUsd — spend
  // is an owner concern and /api/scan/runs/:id (requireManager) already serves it.
  const fieldSafeRun = (r: any) => ({
    id: r.id, label: r.label, kind: r.kind, city: r.city, state: r.state,
    status: r.status, active: r.active, pct: r.pct,
    verified: r.verified, failed: r.failed, newFiber: r.newFiber, newlyLive: r.newlyLive,
    queued: r.queued,
  });

  // Tenant wall. Resolved SERVER-side from the session's tenant — never from a
  // query param — and a run belonging to another tenant is reported as 404, not
  // 403, so this endpoint can't be used to probe which run ids exist elsewhere.
  // Returns the run on success, or null after having already sent the response.
  function resolveOwnRun(req: any, res: Response): any | null {
    const tenantId = req.user?.tenantId ?? null;
    if (tenantId == null) { res.status(403).json({ error: "Organization membership required" }); return null; }
    const runId = String(req.params.runId ?? "");
    // getRunStatus → getRun(runId, tenantId): the tenant predicate is in the SQL,
    // so a cross-tenant id simply doesn't resolve.
    const run = runId ? scanSvc.getRunStatus(runId, tenantId) : null;
    if (!run) { res.status(404).json({ error: "Run not found" }); return null; }
    return run;
  }

  app.get("/api/scan/runs/:runId/stages", requireCapability("scan.submit"), (req: any, res) => {
    const run = resolveOwnRun(req, res);
    if (!run) return;
    const requested = Number(req.query.limit);
    const limit = Math.min(FIELD_STAGE_LIMIT_MAX, Math.max(10, Number.isFinite(requested) && requested > 0 ? requested : FIELD_STAGE_LIMIT_DEFAULT));
    const snap = getInspectorSnapshot({ runId: run.id, limit });
    res.json({
      run: fieldSafeRun(run),
      // Global scan pause is the single most common answer to "why is my scan
      // sitting still", and it is not sensitive.
      paused: isScanningPaused(),
      counters: snap.counters,
      limit,
      stages: snap.rows.map(fieldSafeStage),
    });
  });

  // SSE variant — same gate, same projection, filtered to this run in the relay
  // callback so a tenant never receives another tenant's run events even though
  // the underlying relay is process-wide.
  app.get("/api/scan/runs/:runId/stages/stream", requireCapability("scan.submit"), (req: any, res) => {
    const run = resolveOwnRun(req, res);
    if (!run) return;
    if (fieldStageStreams >= FIELD_STAGE_MAX_STREAMS) {
      return res.status(503).json({ error: "Too many live scan streams open. Retry shortly." });
    }
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();
    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    const snap = getInspectorSnapshot({ runId: run.id, limit: FIELD_STAGE_LIMIT_DEFAULT });
    send("snapshot", { run: fieldSafeRun(run), paused: isScanningPaused(), counters: snap.counters, stages: snap.rows.map(fieldSafeStage) });

    fieldStageStreams++;
    // The relay is in-process and already fed by the batched persister, so this
    // adds ZERO database work per event on the scan hot path — it is a filter on
    // an EventEmitter callback.
    const unsub = onScanEvent((evt) => {
      if (evt.runId !== run.id) return;
      try { send("stage", fieldSafeStage(evt)); } catch { /* socket gone; close handler cleans up */ }
    });
    // 15s (vs the admin stream's 5s) — a phone on LTE pays radio wakeups for
    // every keepalive, and this stream has no periodic health payload to push.
    const hb = setInterval(() => { try { res.write(`: ping\n\n`); } catch { /* closed */ } }, 15_000);
    let closed = false;
    const cleanup = () => {
      if (closed) return;              // 'close' can fire alongside an error path
      closed = true;
      clearInterval(hb);
      unsub();                          // MUST run, or the relay listener leaks
      fieldStageStreams = Math.max(0, fieldStageStreams - 1);
    };
    req.on("close", cleanup);
    res.on("close", cleanup);
  });

  // ── New Build Radar ─────────────────────────────────────────────────────────
  // Live feed of newly-appearing NC/SC addresses/buildings flowing into Fiber
  // Intelligence. Reps see ONLY actionable leads; admins see all (incl. unverified
  // construction + addressless monitored buildings). Per-county source coverage +
  // gaps are admin-visible.
  app.get("/api/newbuilds/live", requireAuth, async (req: any, res) => {
    const { getNewBuildFeed } = await import("./newBuildRadar");
    const role = req.user?.role;
    const isStaff = role === "admin" || role === "manager" || role === "team_lead";
    const hours = Math.min(720, Math.max(1, Number(req.query.hours) || 72));
    // Reps only ever get actionable (fresh-fiber) leads — never raw construction.
    const feed = getNewBuildFeed({ hours, actionableOnly: !isStaff, limit: 300 });
    res.json(feed);
  });

  app.get("/api/newbuilds/coverage", requireManager, async (_req, res) => {
    const { getSourceCoverage } = await import("./newBuildRadar");
    res.json(getSourceCoverage());
  });

  // ── Lead-triggered cluster expansion ────────────────────────────────────────
  // Live view of expansions fanning out from confirmed green FRESH_LEADs, with the
  // origin→cluster chain. Staff-visible.
  app.get("/api/expansions/live", requireManager, async (_req, res) => {
    const { getExpansions } = await import("./clusterExpansion");
    res.json(getExpansions({ limit: 40 }));
  });
  // Admin: manually seed an expansion from an existing green lead's scan_target id
  // (ops + verification). Automatic seeding happens on every confirmed fresh lead.
  app.post("/api/expansions/trigger", requireAdmin, async (req: any, res) => {
    try {
      const { triggerExpansionFromTarget } = await import("./clusterExpansion");
      const targetId = Number(req.body?.targetId);
      if (!Number.isInteger(targetId)) return res.status(400).json({ error: "targetId required" });
      res.json(triggerExpansionFromTarget(targetId));
    } catch (e: any) { res.status(500).json({ error: String(e?.message ?? e) }); }
  });

  // Admin: run one radar tick right now (advances the round-robin scope), OR force
  // a bounded poll of a specific NC county for its most-recent real addresses.
  app.post("/api/newbuilds/tick", requireAdmin, async (req: any, res) => {
    try {
      const { runRadarTick, radarPollCounty } = await import("./newBuildRadar");
      const county = typeof req.body?.county === "string" ? req.body.county.trim() : null;
      if (county) {
        const lookback = Math.min(50, Math.max(1, Number(req.body?.lookback) || 10));
        return res.json(await radarPollCounty(county, lookback));
      }
      res.json(await runRadarTick());
    } catch (e: any) { res.status(500).json({ error: String(e?.message ?? e) }); }
  });

  // Daily confirmed-market refresh — OSM diff (new addresses) + live-check the new
  // ones, across every confirmed NC/SC Kinetic city. Also runs nightly (cron).
  app.post("/api/scan/daily-refresh", requireAdmin, requireScanningAllowed, authorizedScanAdmission, (req: any, res) => {
    void runDailyMarketRefresh(tid(req)).catch(() => {});
    res.status(202).json(getDailyRefreshStatus());
  });
  app.get("/api/scan/daily-refresh", requireManager, (_req, res) => {
    res.json(getDailyRefreshStatus());
  });

  // Internal use only — not exposed to frontend
  // Token is stored server-side; never returned to client
  app.post("/api/internal/refresh-token", requireAdmin, async (_req, res) => {
    try {
      // Mint a genuinely fresh Braze token on demand (admin action — force, not
      // reuse). There is no halt/wedge to clear — scanning self-heals via
      // per-run mint + per-401 remint + AIMD pacing.
      await forceFreshTokenFromApi();
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: `Refresh failed: ${e.message}` });
    }
  });

  // Manager+ can run fiber checks and scans
  app.post("/api/check-fiber", requireManager, requireScanningAllowed, authorizedScanAdmission, async (req, res) => {
    const parsed = z.object({
      address: z.string().trim().min(3).max(180),
      city: z.string().trim().min(2).max(100),
      state: z.string().trim().length(2).transform(value => value.toUpperCase()).default("NC"),
      zip: z.string().trim().regex(/^\d{5}(?:-\d{4})?$/),
    }).strict().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Enter a valid street address, city, two-letter state, and ZIP code." });
    const { address, city, state, zip } = parsed.data;

    const startedAtMs = Date.now();
    const result = await addressScanner(address, city, state, zip, { source: "manual" });
    const tenantId = (req as any).user?.tenantId ?? getDefaultTenantId();

    // Log to history — stamped with the caller's tenant so reads can be scoped.
    storage.createFiberCheck({
      tenantId,
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

    let persisted: PersistKineticObservationResult;
    try {
      persisted = persistRouteKineticObservation("route-manual-check", tenantId, result, {}, startedAtMs);
    } catch (error) {
      // Do not present a provider answer as durable when the evidence write
      // failed. In particular, never fall back to the old direct lead insert.
      logObservationFailure("route-manual-check", result, error);
      const code = String((error as any)?.message ?? "");
      return res.status(code.includes("TENANT_CONFLICT") || code.includes("ADDRESS_COLLISION") ? 409 : 500).json({
        error: "The provider answered, but the result could not be recorded safely. No lead was created.",
      });
    }

    // Strip internal/proprietary fields before sending to client
    res.json(sanitizeFiberResult(result, persisted));
  });

  // ── Field-map per-house scan — the rep taps a rooftop and gets a live fiber
  // verdict + a green pin if it's a FRESH_LEAD. Gated on scan.submit (reps hold
  // it), NOT requireManager, so a field rep can qualify a door in the field.
  // Routes through addressScanner (source "manual" → IMMEDIATE priority with the
  // CRITICAL reservation, + the in-process/SQLite result cache) so a rep's tap
  // never queues behind the statewide sweep and a repeat tap of the same house
  // returns instantly. Persists via the same canonical writer + projector as
  // every other surface — the pin is a real, cross-verified lead, never a direct
  // insert. The tapped coords are the geo fallback so a lead can't be dropped by
  // the null-lat/lng pin filter.
  app.post("/api/leads/scan-house", requireCapability("scan.submit"), requireScanningAllowed, authorizedScanAdmission, async (req: any, res) => {
    const parsed = z.object({
      address: z.string().trim().min(3).max(180),
      city: z.string().trim().min(2).max(100),
      state: z.string().trim().length(2).transform(value => value.toUpperCase()).default("NC"),
      zip: z.string().trim().regex(/^\d{5}(?:-\d{4})?$/),
      lat: z.number().finite().optional(),
      lng: z.number().finite().optional(),
    }).strict().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Enter a valid street address, city, two-letter state, and ZIP code." });
    const { address, city, state, zip, lat, lng } = parsed.data;

    const startedAtMs = Date.now();
    const result = await addressScanner(address, city, state, zip, { source: "manual" });
    const tenantId = req.user?.tenantId ?? getDefaultTenantId();

    storage.createFiberCheck({
      tenantId,
      address: `${address}, ${city}, ${state} ${zip}`,
      lat: result.lat ?? lat ?? null, lng: result.lng ?? lng ?? null,
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

    let persisted: PersistKineticObservationResult;
    try {
      // Pass the tapped coords as the geo fallback so a confirmed lead always
      // has a location and can never be filtered out of the map-pin feed.
      persisted = persistRouteKineticObservation("route-field-scan", tenantId, result, { lat: lat ?? null, lng: lng ?? null }, startedAtMs);
    } catch (error) {
      logObservationFailure("route-field-scan", result, error);
      const code = String((error as any)?.message ?? "");
      return res.status(code.includes("TENANT_CONFLICT") ? 409 : 500).json({
        error: "The provider answered, but the result could not be recorded safely. No lead was created.",
      });
    }

    const decision = sanitizeFiberResult(result, persisted);
    // A blocked/failed provider answer is UNRESOLVED, never "no fiber" — the rep
    // must see Retry, not a false negative that reads as "not a lead".
    const unresolved = result.blocked === true || result.apiSource === "failed" || !persisted.conclusive;
    const leadId = persisted.projection.leadIds[0] ?? null;
    res.json({
      ...decision,
      // The rep-facing extras the sanitized business verdict omits: enough to
      // drop the optimistic pin and show a clear result, nothing proprietary.
      unresolved,
      leadId,
      isFreshLead: decision.isFreshFiber && leadId != null,
      lat: result.lat ?? lat ?? null,
      lng: result.lng ?? lng ?? null,
    });
  });

  // Draw-area scan — accepts a bounding box {minLat, maxLat, minLng, maxLng}
  // Filters the master address list to addresses whose streets are in that area
  // then starts a background scan job just like /api/scan/start
  // Serve the GIS address list to the browser scanner (requireAuth — any logged-in user)


  app.get("/api/scan/addresses", requireAuth, (_req, res) => {
    res.json(loadGisAddresses());
  });

  // Deprecated compatibility endpoint for older clients. The field map no
  // longer calls this or asks the operator to choose a mode; the server selects
  // the bounded unified strategy automatically when /api/scan/area starts.
  app.post("/api/scan/area-estimate", requireAdmin, (req, res) => {
    const v = validateScanBbox(req.body ?? {});
    if (!v.ok) return res.status(400).json({ error: v.message, reason: v.code });
    const bbox = v.bbox;
    const cap = Number(process.env.MAPBOX_HARVEST_CAP ?? 5000);
    // Match the actual harvest: adaptive step (dense for a tight box), so the
    // quoted cost/overCap gate reflects the grid we'd really run, not a fixed one.
    const step = adaptiveGridStep(bbox, { minSamplesPerSide: 6, maxPoints: cap });
    const gridPoints = bboxGridSize(bbox, step);
    // Mapbox: 100k free geocoding/mo, then ~$0.75 per 1,000
    const overFree = Math.max(0, gridPoints - 100_000);
    const estCostUsd = (overFree / 1000) * 0.75;
    res.json({
      deprecated: true,
      strategy: "unified",
      gridPoints,
      mapboxCalls: gridPoints,
      estCostUsd: Number(estCostUsd.toFixed(2)),
      withinFreeTier: overFree === 0,
      overCap: gridPoints > cap,
      cap,
      estAddresses: Math.round(gridPoints * 0.75), // ~0.75 real addresses per grid pt (measured)
    });
  });

  app.post("/api/scan/area", requireAdmin, requireScanningAllowed, authorizedScanAdmission, async (req, res) => {
    const { city = "", state = "NC" } = req.body ?? {};

    // ── Step 1: validate + normalize the outgoing bbox ───────────────────────
    // A malformed / lat-first / zero-area box used to slip through and enumerate
    // nothing, which then read as "no homes here". Reject it explicitly instead.
    const v = validateScanBbox(req.body ?? {});
    if (!v.ok) {
      console.warn(`[scan/area] rejected bbox (${v.code}):`, JSON.stringify(req.body ?? {}));
      return res.status(400).json({ error: v.message, reason: v.code });
    }
    const bbox: BboxLL = v.bbox;
    console.log(`[scan/area] bbox=[${bbox.west},${bbox.south},${bbox.east},${bbox.north}] ~${v.approxKm2.toFixed(3)}km² strategy=unified${v.corrected ? " (order-corrected)" : ""}`);

    const token = process.env.MAPBOX_TOKEN ?? process.env.MAPBOX_PUBLIC_TOKEN ?? "";
    const plan = planUnifiedAreaScan(bbox, {
      hasMapboxToken: Boolean(token),
      autoGridMaxPoints: Number(process.env.AREA_AUTO_GRID_POINTS ?? 900),
      harvestCap: Number(process.env.MAPBOX_HARVEST_CAP ?? 5000),
    });

    // ── Step 2: resolve addresses INSIDE the box (enumeration, not forward
    //    geocoding). The single field strategy always unions mapped sources and,
    //    for a normal-sized box, a dense capped Mapbox grid. Running the network
    //    sources together keeps auto-start fast; either source may fail without
    //    discarding candidates from the other.
    const gisAddresses = generateAddresses("28138", "Rockwell").filter((a: any) =>
      a.lat >= bbox.south && a.lat <= bbox.north && a.lng >= bbox.west && a.lng <= bbox.east);
    const [overpassResult, mapboxResult] = await Promise.allSettled([
      pullAddressesFromOverpass(bbox, city || "", state),
      plan.gridEnabled
        ? harvestBboxAddresses(bbox, state, token, undefined, plan.gridStep)
        : Promise.resolve([]),
    ]);
    const overpassAddresses = overpassResult.status === "fulfilled" ? overpassResult.value : [];
    const mapboxAddresses = mapboxResult.status === "fulfilled" ? mapboxResult.value : [];
    if (overpassResult.status === "rejected") {
      console.warn(`[scan/area] Overpass unavailable; continuing with other sources: ${String(overpassResult.reason?.message ?? overpassResult.reason)}`);
    }
    if (mapboxResult.status === "rejected") {
      console.warn(`[scan/area] Mapbox augmentation unavailable; continuing with mapped sources: ${String(mapboxResult.reason?.message ?? mapboxResult.reason)}`);
    }

    const addresses = mergeAreaAddressSources(
      [overpassAddresses, gisAddresses, mapboxAddresses],
      { city: city || "", state },
    );
    const sources = {
      overpass: overpassAddresses.length,
      gis: gisAddresses.length,
      mapbox: mapboxAddresses.length,
    };
    const source = `unified:${Object.entries(sources).filter(([, count]) => count > 0).map(([name]) => name).join("+") || "none"}`;
    console.log(`[scan/area] unified enumeration addresses=${addresses.length} overpass=${sources.overpass} gis=${sources.gis} mapbox=${sources.mapbox} grid=${plan.gridEnabled ? plan.gridPoints : "skipped"}`);

    // ── Step 3: distinguish the two empty states ─────────────────────────────
    // "0 addresses" is a DATA GAP (map hasn't caught up to a new street) — never
    // claim there are no homes. Separate from "addresses found but none qualified
    // by Kinetic", which is a completed scan that finishes with 0 leads (below).
    if (addresses.length === 0) {
      return res.status(400).json({
        reason: "no_addresses",
        strategy: "unified",
        error: "No addresses could be resolved inside this box. Try drawing a slightly larger area around the street.",
        sources,
        gridAugmented: plan.gridEnabled,
        gridPoints: plan.gridEnabled ? plan.gridPoints : 0,
      });
    }

    const tenantId = (req as any).user?.tenantId ?? getDefaultTenantId();

    // Persist to the tenant-owned pool (geocoded once → re-scannable for free later).
    // persistKineticObservation is deliberately fail-closed on tenant ownership,
    // so every authenticated harvest must stamp the same tenant before scanning.
    try {
      storage.upsertScanTargets(addresses.map((a: any) => ({
        address: a.address, city: a.city ?? city, state: a.state ?? state,
        zip: a.zip ?? "", lat: a.lat ?? null, lng: a.lng ?? null, source, tenantId,
      })));
    } catch {}

    // Dedup against existing leads so we don't re-scan/re-create known addresses.
    const existingSet = new Set(storage.getLeads(tenantId).map((l: any) => normalizeAddrForDedup(l.address)));
    const newAddrs = addresses.filter((a: any) => !existingSet.has(normalizeAddrForDedup(a.address || "")));

    // Homes ARE here, but every one is already in leads — a real, non-error state.
    // Return it explicitly (no empty scan job) so the UI can say so honestly.
    if (newAddrs.length === 0) {
      return res.json({
        jobId: null,
        total: 0,
        harvested: addresses.length,
        alreadyKnown: addresses.length,
        source,
        strategy: "unified",
        sources,
        gridAugmented: plan.gridEnabled,
        gridPoints: plan.gridEnabled ? plan.gridPoints : 0,
        reason: "all_known",
        bbox: { minLat: bbox.south, maxLat: bbox.north, minLng: bbox.west, maxLng: bbox.east },
      });
    }

    const jobId = `scan_${Date.now()}`;
    scanJobs.set(jobId, {
      // Stamp the job's org so the poll (GET) and Cancel (DELETE) tenant checks
      // resolve — without it a tenant-scoped admin 404s on cancel and the
      // qualifier keeps hitting Kinetic after "Cancel scan".
      tenantId,
      id: jobId, city: city || "Drawn area", zip: "", status: "running",
      total: newAddrs.length, done: 0, results: [],
      startedAt: new Date().toISOString(),
      bbox: { minLat: bbox.south, maxLat: bbox.north, minLng: bbox.west, maxLng: bbox.east },
    });
    // Bounded-concurrency qualifier (keeps outbound Kinetic under a ceiling).
    runAreaScan(jobId, newAddrs);
    res.json({
      jobId,
      total: newAddrs.length,
      harvested: addresses.length,   // addresses resolved inside the box
      alreadyKnown: addresses.length - newAddrs.length, // dedup'd against existing leads
      source,
      strategy: "unified",
      sources,
      gridAugmented: plan.gridEnabled,
      gridPoints: plan.gridEnabled ? plan.gridPoints : 0,
      bbox: { minLat: bbox.south, maxLat: bbox.north, minLng: bbox.west, maxLng: bbox.east },
    });
  });

  // ── Coverage preview — how complete is our address enumeration here? ─────────
  // FREE by default: runs the parcel/rooftop/overpass providers (no paid Mapbox
  // grid unless includeMapbox=true, admin). Shows the coverageRatio + how many
  // fresh new-builds the primary enumerator would miss — so a gap is visible
  // BEFORE spending on a scan. Zero Kinetic, zero proxy.
  app.get("/api/coverage/providers", requireManager, (_req, res) => res.json({ providers: providerStatus() }));
  app.post("/api/coverage/preview", requireAdmin, async (req, res) => {
    const v = validateScanBbox(req.body ?? {});
    if (!v.ok) return res.status(400).json({ error: v.message, reason: v.code });
    const includeMapbox = req.body?.includeMapbox === true;
    const bbox: CoverageBBox = { south: v.bbox.south, north: v.bbox.north, west: v.bbox.west, east: v.bbox.east };
    const include = includeMapbox ? undefined : (["parcel", "rooftop", "overpass"] as const).slice();
    try {
      const rep = await gatherCoverage(bbox, { state: req.body?.state ?? "NC", include: include as any });
      // Lean payload — counts + classification + a sample of new-build candidates.
      res.json({
        bbox, coverageRatio: rep.coverageRatio, classification: rep.classification,
        estimated: rep.estimated, knownCount: rep.knownCount, primaryCount: rep.primaryCount,
        mergedCount: rep.merged.length, newBuildCount: rep.newBuildCandidates.length,
        providers: rep.providers,
        newBuildSample: rep.newBuildCandidates.slice(0, 25).map((a) => ({ address: a.address, city: a.city, sources: a.sources })),
      });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // ── Tiled region scan — cover a whole region without missing new builds ──────
  // Admin-only. Splits the region into tiles; each tile enumerates via the
  // providers and qualifies through Kinetic with bounded concurrency + retry.
  // Cost discipline (honors the Mapbox billing guardrails):
  //   • FREE by default (parcel/rooftop/overpass). The paid Mapbox grid runs ONLY
  //     with explicit deep:true, and its total call count is estimated + capped
  //     up front — never a silent metro-wide harvest.
  //   • Kinetic spend is bounded by `budget` (max addresses qualified) + a
  //     job-level dedupe set (each address scanned once, never re-scanned across
  //     overlapping tiles or against existing leads).
  //   • Cancel stops qualification immediately (no more proxy probes).
  const tiledJobs = new Map<string, { job: TileScanJob; tenantId: number; cancelled: boolean }>();
  let tiledJobSeq = 0;
  app.post("/api/scan/tiled", requireAdmin, requireScanningAllowed, authorizedScanAdmission, async (req, res) => {
    const v = validateScanBbox(req.body ?? {});
    if (!v.ok) return res.status(400).json({ error: v.message, reason: v.code });
    const region: CoverageBBox = { south: v.bbox.south, north: v.bbox.north, west: v.bbox.west, east: v.bbox.east };
    const tileDeg = Math.min(0.05, Math.max(0.008, Number(req.body?.tileDeg ?? 0.02)));
    const state = String(req.body?.state ?? "NC");
    const deep = req.body?.deep === true; // include the paid Mapbox grid (finds new builds)
    const budget = Math.max(1, Math.min(20000, Number(req.body?.budget ?? 4000))); // Kinetic probe ceiling
    const tenantId = (req as any).user?.tenantId ?? getDefaultTenantId();

    const id = `tiled_${Date.now()}_${++tiledJobSeq}`; // unique even within one ms
    const job = createTileScanJob(id, region, { tileDeg });

    // Guard 1: refuse an absurd tile count.
    const MAX_TILES = Number(process.env.MAX_TILE_SCAN_TILES ?? 400);
    if (job.tiles.length > MAX_TILES) {
      return res.status(400).json({ error: `Region too large: ${job.tiles.length} tiles (cap ${MAX_TILES}). Draw a smaller region or raise tileDeg.`, reason: "too_many_tiles", tiles: job.tiles.length });
    }
    // Guard 2: when deep, estimate the total Mapbox reverse-geocode calls and cap
    // BEFORE running — cost is explicit, never silent (the guardrail from the two
    // prior billing incidents).
    let estMapboxCalls = 0;
    if (deep) {
      for (const t of job.tiles) estMapboxCalls += bboxGridSize(t.bbox, adaptiveGridStep(t.bbox, { minSamplesPerSide: 6, maxPoints: 5000 }));
      const CAP = Number(process.env.MAX_TILE_MAPBOX_CALLS ?? 8000);
      if (estMapboxCalls > CAP) {
        return res.status(400).json({ error: `Deep tiled scan would cost ~${estMapboxCalls.toLocaleString()} Mapbox calls (cap ${CAP.toLocaleString()}). Use a smaller region, a larger tileDeg, or free mode (deep:false).`, reason: "mapbox_over_cap", estMapboxCalls, cap: CAP });
      }
    }

    const entry = { job, tenantId, cancelled: false };
    tiledJobs.set(id, entry);
    res.json({ jobId: id, tiles: job.tiles.length, region, tileDeg, deep, budget, estMapboxCalls });

    // Job-level dedupe: never re-scan an address across overlapping tile edges or
    // one already in leads — kills the cross-tile double-spend + inflated totals.
    const seen = new Set<string>(storage.getLeads().map((l: any) => normalizeAddrForDedup(l.address || "")));
    let remaining = budget;
    const include = deep ? undefined : (["parcel", "rooftop", "overpass"] as const).slice();

    runTileScan(job, {
      gather: (bbox) => gatherCoverage(bbox, { state, include: include as any }),
      qualify: async (addresses) => {
        if (entry.cancelled || remaining <= 0) return { leads: 0, scanned: 0 };
        const fresh: RawAddress[] = [];
        for (const a of addresses) {
          if (fresh.length >= remaining) break;
          const key = normalizeAddrForDedup(a.address || "");
          if (!key || seen.has(key)) continue;
          seen.add(key); fresh.push(a);
        }
        remaining -= fresh.length;
        return qualifyAddressesViaKinetic(fresh, tenantId, {
          source: "route-tiled-scan",
          concurrency: Number(process.env.TILE_QUALIFY_CONCURRENCY ?? 6),
          shouldStop: () => entry.cancelled || remaining < 0,
        });
      },
      cancelled: () => entry.cancelled,
    }, { tileDeg, tileConcurrency: Number(process.env.TILE_CONCURRENCY ?? 2), maxAttempts: 3 })
      .catch((e) => { job.status = "error"; console.error(`[tiled-scan] ${id} failed:`, e?.message); });
  });
  app.get("/api/scan/tiled/:id", requireManager, (req, res) => {
    const entry = tiledJobs.get(qstr(req.params.id));
    const tid = (req as any).user?.tenantId;
    if (!entry || (tid != null && entry.tenantId !== tid)) return res.status(404).json({ error: "Not found" });
    const { job } = entry;
    res.json({
      id: job.id, status: entry.cancelled ? "cancelled" : job.status, region: job.region,
      totals: job.totals,
      tiles: job.tiles.map((t: Tile) => ({ id: t.id, status: t.status, coverage: t.coverage, addressCount: t.addressCount, newBuildCount: t.newBuildCount, leadCount: t.leadCount, bbox: t.bbox })),
      startedAt: job.startedAt, completedAt: job.completedAt,
    });
  });
  app.post("/api/scan/tiled/:id/cancel", requireAdmin, (req, res) => {
    const entry = tiledJobs.get(qstr(req.params.id));
    const tid = (req as any).user?.tenantId;
    if (!entry || (tid != null && entry.tenantId !== tid)) return res.status(404).json({ error: "Not found" });
    entry.cancelled = true;
    res.json({ ok: true });
  });

  // City scan — start. Free sources by default (pool → GIS → Overpass);
  // the Mapbox grid (~2k billable requests for Rockwell) requires an explicit
  // useMapbox:true from an ADMIN — it is never the default.
  // Running a scan hits the Kinetic API through the paid residential proxy, so
  // only ADMIN can trigger scans (managers/team leads can still view + assign).
  app.post("/api/scan/start", requireAdmin, requireScanningAllowed, authorizedScanAdmission, async (req, res) => {
    const { city = "Rockwell", zip = "28138", state = "NC", useMapbox = false } = req.body;
    const jobId = `scan_${Date.now()}`;
    const mapboxToken = process.env.MAPBOX_TOKEN ?? "";

    let addresses: { address: string; city: string; state: string; zip: string; lat: number; lng: number }[];
    const isRockwell = city.toLowerCase().includes("rockwell");
    const isAdminUser = (req as any).user?.role === "admin";

    if (isRockwell && useMapbox === true && isAdminUser && mapboxToken) {
      // Start job immediately with estimated total, harvest addresses in background
      const estimatedTotal = getRockwellGridSize() * 3; // ~3 addresses per grid point
      scanJobs.set(jobId, {
        // Stamp the job's org so the poll (GET) and Cancel (DELETE) tenant checks
        // resolve — without it a tenant-scoped admin 404s on poll/cancel and the
        // qualifier keeps hitting Kinetic after "Cancel scan".
        tenantId: (req as any).user?.tenantId ?? getDefaultTenantId(),
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
      // Free path: pool (already harvested) → Overpass → GIS fallback
      const pooled = storage.getScanTargetsByCity(city, state);
      if (pooled.length >= 25) {
        addresses = pooled as any;
      } else {
        try {
          const overpass = await getCityAddresses(city, state);
          addresses = overpass.addresses.length > 0 ? overpass.addresses as any : generateAddresses(zip, city) as any;
        } catch {
          addresses = generateAddresses(zip, city) as any;
        }
      }
      scanJobs.set(jobId, {
        // Stamp the job's org so the poll (GET) and Cancel (DELETE) tenant checks
        // resolve — without it a tenant-scoped admin 404s on poll/cancel and the
        // qualifier keeps hitting Kinetic after "Cancel scan".
        tenantId: (req as any).user?.tenantId ?? getDefaultTenantId(),
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
  // Cost model: geocode ONCE, then reuse forever. Order of preference:
  //   1. scan_targets pool (already harvested → $0)
  //   2. Overpass / OpenStreetMap ($0)
  //   3. Local GIS parcel file, Rockwell only ($0)
  //   4. Mapbox reverse-geocode grid — ONLY on explicit ?source=mapbox (admin),
  //      never as a silent fallback. One big-city grid = 10k–100k+ billable
  //      requests; silent fallbacks here are what caused a 1.1M-request bill.
  app.get("/api/scan/city-addresses", requireManager, async (req, res) => {
    const { city, state } = req.query;
    if (!city || typeof city !== "string") return res.status(400).json({ error: "city required" });
    const st = typeof state === "string" ? state : "NC";
    const isRockwell = city.trim().toLowerCase().includes("rockwell");
    const mbToken = process.env.MAPBOX_TOKEN ?? "";
    const wantMapbox = req.query.source === "mapbox";
    const tenantId = (req as any).user?.tenantId ?? getDefaultTenantId();

    // Cache a pulled set to the address pool, keyed on the SEARCHED city/state so
    // the follow-up scan (/api/scan/start-city) re-reads the identical set from the
    // pool instantly — the client never has to POST the (huge) array back, which is
    // what tripped the "request too large" (413) body limit on a whole-city pull.
    const cacheToPool = (addrs: any[], src: string) => {
      try {
        storage.upsertScanTargets(addrs.map((a: any) => ({
          address: a.address, city: city.trim(), state: st.trim(),
          zip: a.zip ?? "", lat: a.lat ?? null, lng: a.lng ?? null, source: src, tenantId,
        })));
      } catch { /* pool cache is best-effort — never block the pull */ }
    };

    try {
      // 1) Pool — free, instant
      const pooled = storage.getScanTargetsByCity(city.trim(), st.trim());
      if (!wantMapbox && pooled.length >= 25) {
        return res.json({
          count: pooled.length, cityName: `${city.trim()}, ${st}`, source: "pool",
          center: null, bbox: null, addresses: pooled,
        });
      }

      // 4) Explicit Mapbox harvest — admin only, costs real money
      if (wantMapbox) {
        if ((req as any).user?.role !== "admin") {
          return res.status(403).json({ error: "Mapbox harvest is admin-only (it costs per request)" });
        }
        if (!mbToken) return res.status(400).json({ error: "MAPBOX_TOKEN not set" });
        const addrs = isRockwell
          ? await harvestRockwellAddresses(mbToken)
          : (await harvestCityAddresses(city.trim(), st.trim(), mbToken)).addresses;
        cacheToPool(addrs, "mapbox");
        return res.json({ count: addrs.length, cityName: `${city.trim()}, ${st}`, source: "mapbox", center: null, bbox: null, addresses: addrs });
      }

      // 2) Overpass (free)
      let result: { addresses: any[]; cityName: string; center: any; bbox: any } | null = null;
      try { result = await getCityAddresses(city.trim(), st.trim()); } catch { result = null; }
      if (result && result.addresses.length > 0) {
        cacheToPool(result.addresses, "overpass");
        return res.json({
          count: result.addresses.length, cityName: result.cityName, source: "overpass",
          center: result.center, bbox: result.bbox, addresses: result.addresses,
        });
      }

      // 3) GIS parcel file (free, Rockwell only)
      if (isRockwell) {
        const gis = loadGisAddresses();
        if (gis.length > 0) {
          cacheToPool(gis, "gis");
          return res.json({ count: gis.length, cityName: "Rockwell, NC", source: "gis", center: null, bbox: null, addresses: gis });
        }
      }

      // Small pool is better than nothing — still free
      if (pooled.length > 0) {
        return res.json({ count: pooled.length, cityName: `${city.trim()}, ${st}`, source: "pool", center: null, bbox: null, addresses: pooled });
      }

      res.status(404).json({
        error: "No free address source found for this city. OpenStreetMap returned nothing — try again (public Overpass is flaky), or an admin can pass source=mapbox to run a paid Mapbox harvest once.",
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/scan/start-city — scan with pre-pulled addresses or pull them fresh
  app.post("/api/scan/start-city", requireAdmin, requireScanningAllowed, authorizedScanAdmission, async (req, res) => {
    const { city, state, addresses: providedAddresses } = req.body;
    if (!city) return res.status(400).json({ error: "city required" });
    const st = state ?? "NC";
    const isRockwell = city.trim().toLowerCase().includes("rockwell");
    const mbToken = process.env.MAPBOX_TOKEN ?? "";
    const tenantId = (req as any).user?.tenantId ?? getDefaultTenantId();

    // Address source, ordered for low cost. Free sources ONLY by default:
    //   pool (already harvested) → live OSM → GIS parcel file (Rockwell).
    // The paid Mapbox grid never runs as a silent fallback — it needs an
    // explicit { source: "mapbox" } from an ADMIN. (A single big-city grid is
    // tens of thousands of billable geocoding requests.)
    const preferMapbox = req.body.source === "mapbox";
    if (preferMapbox && (req as any).user?.role !== "admin") {
      return res.status(403).json({ error: "Mapbox harvest is admin-only (it costs per request)" });
    }
    let addresses: any[] = [];
    let usedSource = "overpass";
    try {
      if (providedAddresses && Array.isArray(providedAddresses) && providedAddresses.length > 0) {
        addresses = providedAddresses; usedSource = "manual";
      } else if (preferMapbox && mbToken) {
        addresses = isRockwell
          ? await harvestRockwellAddresses(mbToken)
          : (await harvestCityAddresses(city.trim(), st.trim(), mbToken)).addresses;
        usedSource = "mapbox";
      } else {
        // 1) Pool — free, instant, already geocoded
        const pooled = storage.getScanTargetsByCity(city.trim(), st.trim());
        if (pooled.length >= 25) {
          addresses = pooled; usedSource = "pool";
        }
        // 2) Live OSM (free) — fails fast (~28s) so it can't hang the scan.
        if (addresses.length === 0) {
          try {
            const result = await getCityAddresses(city.trim(), st.trim());
            addresses = result.addresses ?? [];
          } catch { addresses = []; }
        }
        // 3) GIS parcel file — free, Rockwell only.
        if (addresses.length === 0 && isRockwell) { addresses = loadGisAddresses(); usedSource = "gis"; }
        // 4) Small pool beats nothing — still free.
        if (addresses.length === 0 && pooled.length > 0) { addresses = pooled; usedSource = "pool"; }
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
        zip: a.zip ?? "", lat: a.lat ?? null, lng: a.lng ?? null, source: src, tenantId,
      })));
    } catch {}

    // Dedup against existing leads (normalize suffixes for Court/Ct, Drive/Dr, etc.)
    const existingSet = new Set(storage.getLeads(tenantId).map((l: any) => normalizeAddrForDedup(l.address)));
    const newAddrs = addresses.filter((a: any) => !existingSet.has(normalizeAddrForDedup(a.address || "")));

    const jobId = `city_${city.toLowerCase().replace(/\s+/g, "_")}_${Date.now()}`;
    const job: ScanJob = {
      // Stamp the org so poll/cancel/list resolve (without it a tenant-scoped
      // admin 404s on this job and can't see or stop it while Kinetic spends).
      tenantId,
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

  // ═══ SCAN INTELLIGENCE ═══════════════════════════════════════════════════════
  // The market-discovery system: read markets + clusters (manager+, no spend),
  // and run/control budgeted scans (admin only — every check spends proxy money).
  const tid = (req: any) => req.user?.tenantId ?? getDefaultTenantId();

  // ═══ NC/SC KINETIC STATE MONITOR ═══════════════════════════════════════════
  // Planning targets are city-level; every fresh/knock output below is sourced
  // exclusively from time-stamped address-level transitions.
  const marketQuerySchema = z.object({
    state: z.enum(["NC", "SC"]).optional(),
    priority: z.enum(["critical", "high", "medium", "low"]).optional(),
    eligibility: z.enum(["verified", "unverified", "all"]).default("verified"),
    due: z.enum(["true", "false"]).optional(),
    limit: z.coerce.number().int().min(1).max(2_000).default(1_000),
  });
  const freshQuerySchema = z.object({
    days: z.coerce.number().int().min(1).max(365).default(30),
    confidence: z.enum(["cross_verified", "single_source_provisional"]).optional(),
    format: z.enum(["json", "csv"]).default("json"),
  });
  const corroborationSchema = z.object({
    rows: z.array(z.object({
      scanTargetId: z.number().int().positive(), source: z.enum(CORROBORATION_SOURCES),
      sourceRecordId: z.string().trim().max(200).nullable().optional(),
      observedAt: z.string().datetime(), availability: z.enum(["available", "unavailable", "unknown"]),
      technology: z.string().trim().max(100).nullable().optional(),
      maxDownMbps: z.number().int().min(0).max(1_000_000).nullable().optional(),
      referenceUrl: z.string().url().max(2_000).nullable().optional(),
      importBatchId: z.string().trim().max(200).nullable().optional(),
    })).min(1).max(5_000),
  }).superRefine((value, ctx) => {
    const futureLimit = Date.now() + 5 * 60_000;
    value.rows.forEach((row, index) => {
      if (Date.parse(row.observedAt) > futureLimit) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["rows", index, "observedAt"], message: "Evidence timestamp cannot be in the future" });
    });
  });
  const citySweepSchema = z.object({
    city: z.string().trim().min(2).max(120), state: z.enum(["NC", "SC"]),
    maxChecks: z.number().int().min(1).max(100_000).optional(),
  });
  const addressSearchSchema = z.object({
    query: z.string().trim().min(5).max(250), radiusMeters: z.coerce.number().int().min(50).max(5_000).default(500),
  });
  const addressSweepSchema = addressSearchSchema.extend({
    maxChecks: z.number().int().min(1).max(100_000).optional(),
  });

  app.post("/api/sweeps/city", requireAdmin, requireScanningAllowed, authorizedScanAdmission, (req: any, res) => {
    const parsed = citySweepSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid city sweep", issues: parsed.error.issues });
    const job = sweepService.startCitySweep({ tenantId: tid(req), createdBy: req.user?.id, ...parsed.data });
    storage.logActivity(req.user?.id ?? null, "sweep.city_started", "sweep_job", undefined, { sweepId: job.id, city: job.city, state: job.state, maxChecks: job.maxChecks });
    res.status(202).json(job);
  });

  // ── Statewide sweep — run NOW, city by city, until the whole state is checked.
  // These MUST be registered before GET /api/sweeps/:id so "/state" isn't parsed
  // as a sweep id. Active-priority only: no deferral/nightly path exists here. ──
  const stateSweepSchema = z.object({
    state: z.enum(["NC", "SC"]),
    maxChecksPerCity: z.coerce.number().int().min(1).max(100_000).optional(),
  });

  app.post("/api/sweeps/state", requireAdmin, requireScanningAllowed, authorizedScanAdmission, (req: any, res) => {
    const parsed = stateSweepSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid state sweep", issues: parsed.error.issues });
    const job = sweepService.startStateSweep({ tenantId: tid(req), createdBy: req.user?.id, ...parsed.data });
    storage.logActivity(req.user?.id ?? null, "sweep.state_started", "state_sweep", undefined, { stateSweepId: job.id, state: job.state, cities: job.citiesTotal });
    res.status(202).json(job);
  });

  app.get("/api/sweeps/state", requireManager, (req: any, res) => {
    res.json({ sweeps: sweepService.listStateSweeps(tid(req), Number(req.query.limit) || 10) });
  });

  app.get("/api/sweeps/state/:id", requireManager, (req: any, res) => {
    const job = sweepService.getStateSweep(qstr(req.params.id), tid(req));
    if (!job) return res.status(404).json({ error: "State sweep not found" });
    res.json(job);
  });

  app.post("/api/sweeps/state/:id/cancel", requireAdmin, (req: any, res) => {
    const ok = sweepService.cancelStateSweep(qstr(req.params.id), tid(req));
    if (!ok) return res.status(404).json({ error: "State sweep not found or already finished" });
    storage.logActivity(req.user?.id ?? null, "sweep.state_cancelled", "state_sweep", undefined, { stateSweepId: qstr(req.params.id) });
    res.json({ cancelled: true });
  });

  app.get("/api/sweeps/address-search", requireManager, async (req: any, res) => {
    const parsed = addressSearchSchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: "Invalid address search", issues: parsed.error.issues });
    try { res.json(await sweepService.searchAddressArea({ tenantId: tid(req), ...parsed.data })); }
    catch (error: any) { res.status(error.message === "ADDRESS_NOT_FOUND" ? 404 : 502).json({ error: error.message }); }
  });

  app.post("/api/sweeps/address", requireAdmin, requireScanningAllowed, authorizedScanAdmission, (req: any, res) => {
    const parsed = addressSweepSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid address sweep", issues: parsed.error.issues });
    const job = sweepService.startAddressSweep({ tenantId: tid(req), createdBy: req.user?.id, ...parsed.data });
    storage.logActivity(req.user?.id ?? null, "sweep.address_started", "sweep_job", undefined, { sweepId: job.id, query: parsed.data.query, radiusMeters: parsed.data.radiusMeters, maxChecks: job.maxChecks });
    res.status(202).json(job);
  });

  app.get("/api/sweeps", requireManager, (req: any, res) => {
    res.json({ sweeps: sweepService.listSweeps(tid(req), Number(req.query.limit) || 30) });
  });

  app.get("/api/sweeps/:id", requireManager, (req: any, res) => {
    const job = sweepService.getSweep(qstr(req.params.id), tid(req));
    if (!job) return res.status(404).json({ error: "Sweep not found" });
    res.json(job);
  });

  app.get("/api/sweeps/:id/results", requireManager, (req: any, res) => {
    const query = z.object({
      stage: z.enum(["fresh", "available", "unavailable"]).optional(),
      customer: z.enum(["new_opportunity", "existing_customer", "unknown"]).optional(),
      limit: z.coerce.number().int().min(1).max(5_000).default(500), offset: z.coerce.number().int().min(0).default(0),
    }).safeParse(req.query);
    if (!query.success) return res.status(400).json({ error: "Invalid results query", issues: query.error.issues });
    const result = sweepService.getSweepResults(qstr(req.params.id), tid(req), query.data);
    if (!result) return res.status(404).json({ error: "Sweep not found" });
    res.json(result);
  });

  app.get("/api/sweeps/:id/knock-list", requireManager, (req: any, res) => {
    const result = sweepService.getSweepKnockList(qstr(req.params.id), tid(req));
    if (!result) return res.status(404).json({ error: "Sweep not found" });
    res.json({ job: result.job, count: result.count, clusters: result.clusters, rows: result.rows });
  });

  app.get("/api/sweeps/:id/fresh", requireManager, (req: any, res) => {
    const result = sweepService.getSweepResults(qstr(req.params.id), tid(req), {
      stage: "fresh", customer: "new_opportunity", limit: 5_000,
    });
    if (!result) return res.status(404).json({ error: "Sweep not found" });
    const confirmed = result.results.filter((row: any) => row.crossVerified === true);
    res.json({ ...result, total: confirmed.length, results: confirmed, confirmation: "cross_verified" });
  });

  app.get("/api/sweeps/:id/knock-list.csv", requireManager, (req: any, res) => {
    const result = sweepService.getSweepKnockList(qstr(req.params.id), tid(req));
    if (!result) return res.status(404).json({ error: "Sweep not found" });
    res.type("text/csv").attachment(`knock-list-${qstr(req.params.id)}.csv`).send(result.csv);
  });

  app.post("/api/sweeps/:id/cancel", requireAdmin, (req: any, res) => {
    if (!sweepService.cancelSweep(qstr(req.params.id), tid(req))) return res.status(404).json({ error: "Running sweep not found" });
    res.json({ cancelled: true });
  });

  app.get("/api/monitor/markets", requireManager, (req: any, res) => {
    const parsed = marketQuerySchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: "Invalid market query", issues: parsed.error.issues });
    syncMarketState();
    res.json({
      sourceVintage: "Kinetic official NC/SC fiber + other-high-speed directories (carrier eligibility) + Census/GNIS enrichment",
      carrierDirectoryObservedAt: CATALOG_OBSERVED_AT,
      markets: listMarkets({
      ...parsed.data, due: parsed.data.due === "true",
      }),
    });
  });

  app.get("/api/monitor/markets.csv", requireManager, (_req: any, res) => {
    syncMarketState();
    res.type("text/csv").attachment("nc-sc-kinetic-markets.csv").send(toCsv(listMarkets({ eligibility: "verified", limit: 2_000 }) as any));
  });

  app.get("/api/monitor/summary", requireManager, (req: any, res) => {
    const days = z.coerce.number().int().min(1).max(365).default(7).safeParse(req.query.days);
    if (!days.success) return res.status(400).json({ error: "Invalid days" });
    syncMarketState();
    res.json(monitoringSummary(tid(req), days.data));
  });

  app.get("/api/monitor/operations", requireManager, (req: any, res) => {
    const hours = z.coerce.number().int().min(1).max(24 * 30).default(24).safeParse(req.query.hours);
    if (!hours.success) return res.status(400).json({ error: "Invalid operations window" });
    res.json({ generatedAt: new Date().toISOString(), ...operationalMetrics(tid(req), hours.data) });
  });

  app.get("/api/monitor/fresh", requireManager, (req: any, res) => {
    const parsed = freshQuerySchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: "Invalid fresh-fiber query", issues: parsed.error.issues });
    const rows = freshPoints(tid(req), parsed.data.days).filter((p) => !parsed.data.confidence || p.confidence === parsed.data.confidence);
    if (parsed.data.format === "csv") {
      const clusterByTarget = new Map(clusterFreshFiber(rows).flatMap((c) => c.addresses.map((p) => [p.id, c] as const)));
      const csvRows = rows.map((p) => ({ ...p, sources: p.sources.join("|"), cluster_score: clusterByTarget.get(p.id)?.score ?? 0, cluster_density: clusterByTarget.get(p.id)?.density ?? 1 }));
      return res.type("text/csv").attachment("fresh-kinetic-fiber.csv").send(toCsv(csvRows as any));
    }
    res.json({ generatedAt: new Date().toISOString(), count: rows.length, addresses: rows });
  });

  app.get("/api/monitor/clusters", requireManager, (req: any, res) => {
    const days = z.coerce.number().int().min(1).max(365).default(30).safeParse(req.query.days);
    const radius = z.coerce.number().min(25).max(1_000).default(250).safeParse(req.query.radiusMeters);
    if (!days.success || !radius.success) return res.status(400).json({ error: "Invalid cluster query" });
    const points = freshPoints(tid(req), days.data);
    res.json({ points: points.length, clusters: clusterFreshFiber(points, { radiusMeters: radius.data }) });
  });

  app.get("/api/monitor/knock-list.csv", requireManager, (req: any, res) => {
    const days = z.coerce.number().int().min(1).max(365).default(30).safeParse(req.query.days);
    if (!days.success) return res.status(400).json({ error: "Invalid days" });
    res.type("text/csv").attachment("fresh-fiber-knock-list.csv").send(toCsv(knockList(tid(req), days.data) as any));
  });

  app.get("/api/monitor/schedule", requireManager, (_req: any, res) => {
    syncMarketState();
    res.json({ scheduler: getStateMonitorStatus(), due: listMarkets({ due: true, eligibility: "verified", limit: 100 }) });
  });

  app.get("/api/monitor/sources", requireManager, (_req: any, res) => {
    res.json({
      announcementWatch: announcementSourceStatus(),
      addressAvailability: {
        primary: "kinetic_authorized_lookup",
        independentAccepted: CORROBORATION_SOURCES,
        confirmationRule: "A Kinetic-only transition is provisional until a recent independent address-level available observation is imported.",
      },
    });
  });

  app.post("/api/monitor/announcements/poll", requireAdmin, async (_req: any, res) => {
    try { res.json(await pollAnnouncementsIfDue(true)); }
    catch (error: any) { res.status(502).json({ error: error.message }); }
  });

  app.post("/api/monitor/directory/poll", requireAdmin, async (_req: any, res) => {
    try { res.json(await refreshKineticLocationDirectory(true)); }
    catch (error: any) { res.status(502).json({ error: error.message }); }
  });

  app.post("/api/monitor/corroboration", requireAdmin, async (req: any, res) => {
    const parsed = corroborationSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid corroboration batch", issues: parsed.error.issues });
    try {
      const result = recordCorroboration(tid(req), parsed.data.rows);
      const alerts = await flushFreshOpportunityAlerts(tid(req));
      storage.logActivity(req.user?.id ?? null, "fiber.corroboration_import", "scan_target", undefined, { ...result, alerts, sources: [...new Set(parsed.data.rows.map((r) => r.source))] });
      res.status(201).json({ ...result, alerts });
    } catch (error: any) {
      res.status(409).json({ error: error.message });
    }
  });

  app.post("/api/monitor/tick", requireAdmin, requireScanningAllowed, async (_req: any, res) => {
    try { res.json(await runStateMonitorTick({ allowSpend: true })); }
    catch (error: any) { res.status(409).json({ error: error.message }); }
  });

  app.post("/api/monitor/seed", requireAdmin, (_req: any, res) => {
    const result = seedStateMarkets();
    syncMarketState();
    res.json(result);
  });

  // Markets grid — every harvested city scored as an opportunity. Pure DB read,
  // ZERO proxy. Manager+ so leadership can decide where to launch.
  app.get("/api/scan/markets", requireManager, (req: any, res) => {
    res.json(scanSvc.getMarkets(tid(req)));
  });

  // One market's detail + suggested budget tiers with up-front cost.
  app.get("/api/scan/markets/:city", requireManager, (req: any, res) => {
    const state = qstr(req.query.state) || "NC";
    const detail = scanSvc.getMarketDetail(tid(req), qstr(req.params.city), state);
    if (!detail) return res.status(404).json({ error: "No such market in the pool" });
    res.json(detail);
  });

  // Opportunity clusters over verified new-fiber — the spatial "where to deploy"
  // layer. Pure DB + in-memory clustering, ZERO proxy. Manager+.
  app.get("/api/scan/clusters", requireManager, (req: any, res) => {
    const { minLat, maxLat, minLng, maxLng, minPoints, city, state } = req.query;
    const bbox = minLat != null && maxLat != null && minLng != null && maxLng != null
      ? { minLat: Number(minLat), maxLat: Number(maxLat), minLng: Number(minLng), maxLng: Number(maxLng) }
      : undefined;
    res.json(scanSvc.getClusters(tid(req), bbox, {
      minPoints: minPoints != null ? Number(minPoints) : undefined,
      city: city ? qstr(city) : undefined,
      state: state ? qstr(state) : undefined,
    }));
  });

  // ═══ MARKET BIRTH RADAR — transition intelligence (read; manager+, tenant-scoped) ═══
  // The command-center overview: monitored targets, freshness, and how many
  // addresses are baseline / candidate / verified New Fiber. ZERO proxy.
  app.get("/api/radar/overview", requireManager, (req: any, res) => {
    res.json(radarStore.radarOverview(tid(req)));
  });
  // The "what changed" feed — transition episodes with their honest
  // interval-censored detection window. Never leaks provider ids/credentials.
  app.get("/api/radar/transitions", requireManager, (req: any, res) => {
    res.json({ transitions: radarStore.radarTransitions(tid(req), { status: qstr(req.query.status) || undefined, limit: req.query.limit ? Number(req.query.limit) : undefined }) });
  });
  app.get("/api/radar/transitions/:id", requireManager, (req: any, res) => {
    const ep = radarStore.radarTransition(tid(req), Number(req.params.id));
    if (!ep) return res.status(404).json({ error: "Transition not found" });
    res.json(ep);
  });

  // Preview a budgeted run's cost — how many addresses would be verified and what
  // it would cost. NO spend. Estimate-first is a hard product rule (two prior
  // billing incidents). Admin only (it reveals spend controls).
  app.post("/api/scan/runs/preview", requireAdmin, (req: any, res) => {
    const { city, state = "NC", budget, rescan } = req.body ?? {};
    if (!city || budget == null) return res.status(400).json({ error: "city and budget required" });
    try {
      res.json(scanSvc.previewMarketRun({ tenantId: tid(req), city: String(city), state: String(state), budget: Number(budget), rescan: !!rescan }));
    } catch (e: any) { res.status(400).json({ error: e.message }); }
  });

  // Start a budgeted scan — the ONLY money-spending create path. Admin +
  // authorizedScanAdmission. Returns immediately; the run is persisted + resumable.
  app.post("/api/scan/runs", requireAdmin, requireScanningAllowed, authorizedScanAdmission, (req: any, res) => {
    const { city, state = "NC", budget, rescan } = req.body ?? {};
    if (!city || budget == null) return res.status(400).json({ error: "city and budget required" });
    try {
      const out = scanSvc.startMarketRun({ tenantId: tid(req), city: String(city), state: String(state), budget: Number(budget), rescan: !!rescan, createdBy: req.user?.id });
      res.json(out);
    } catch (e: any) {
      const code = /^(NO_POOL|NOTHING_TO_VERIFY)/.test(e.message) ? 409 : 400;
      res.status(code).json({ error: e.message });
    }
  });

  // Run list (recent budgeted scans, with real measured cost). Manager+ (read).
  app.get("/api/scan/runs", requireManager, (req: any, res) => {
    res.json({ runs: scanSvc.getRuns(tid(req)) });
  });

  // Change feed — "what changed since yesterday". Combines the first-to-market
  // signal (addresses that FLIPPED unavailable->live) with recent scan-run
  // yields, so leadership sees fresh opportunity the moment it appears. Manager+,
  // ZERO proxy. Honest empty state when nothing has flipped yet.
  app.get("/api/scan/changes", requireManager, (req: any, res) => {
    const hours = Math.min(Math.max(Number(req.query.hours) || 24, 1), 24 * 30);
    const cutoff = Date.now() - hours * 3_600_000;
    const newlyLive = freshPoints(tid(req), Math.ceil(hours / 24) + 1)
      .filter((point) => Date.parse(point.firstSeenLiveAt) >= cutoff)
      .slice(0, 200);
    const runs = scanSvc.getRuns(tid(req)).filter((r: any) =>
      r.completedAt && (Date.now() - (Date.parse(r.completedAt + "Z") || Date.parse(r.completedAt))) <= hours * 3600_000);
    res.json({
      windowHours: hours,
      newlyLive: {
        count: newlyLive.length,
        confirmed: newlyLive.filter((r: any) => r.confidence === "cross_verified").length,
        provisional: newlyLive.filter((r: any) => r.confidence === "single_source_provisional").length,
        readyToAssign: newlyLive.filter((r: any) => r.confidence === "cross_verified" && r.leadId != null).length,
        addresses: newlyLive,
      },
      recentRuns: runs.map((r: any) => ({ id: r.id, label: r.label, verified: r.verified, newFiber: r.newFiber, newlyLive: r.newlyLive, completedAt: r.completedAt, costUsd: r.costUsd })),
      primaryMatches: runs.reduce((s: number, r: any) => s + r.newFiber, 0),
      confirmedFresh: newlyLive.filter((r: any) => r.confidence === "cross_verified").length,
    });
  });

  // Live run status — the resumable progress poll. Manager+ (read/watch).
  app.get("/api/scan/runs/:id", requireManager, (req: any, res) => {
    const status = scanSvc.getRunStatus(qstr(req.params.id), tid(req));
    if (!status) return res.status(404).json({ error: "Run not found" });
    res.json(status);
  });

  // Pause / resume / cancel a running spend. Admin only — this controls money.
  app.post("/api/scan/runs/:id/:action", requireAdmin, (req: any, res) => {
    const action = qstr(req.params.action);
    if (!["pause", "resume", "cancel"].includes(action)) return res.status(400).json({ error: "bad action" });
    // RESUME re-dispatches proxy spend, so it's gated like the create route; pause/
    // cancel stay reachable so a blocked tenant can still stop a run.
    if (action === "resume") {
      const block = scanBlockReason((req as any).user?.tenantId ?? getDefaultTenantId() ?? 1);
      if (block) return res.status(402).json({ error: block.message, reasonCode: block.code, state: block.state });
    }
    const ok = scanSvc.controlRun(qstr(req.params.id), tid(req), action as any);
    if (!ok) return res.status(404).json({ error: "Run not found" });
    res.json({ ok: true, action });
  });

  // Server-authored "why this area" briefing from a parcel's real leads.
  function buildDeployBriefing(leads: any[], visits: Map<number, any>) {
    const scores = leads.map(l => l.leadScore ?? 0);
    const competitors = new Map<string, number>();
    let unworked = 0;
    for (const l of leads) {
      if (l.competitorName) competitors.set(l.competitorName, (competitors.get(l.competitorName) ?? 0) + 1);
      if (!visits.get(l.id)) unworked++;
    }
    const topCompetitor = [...competitors.entries()].sort((a, b) => b[1] - a[1])[0];
    return {
      doors: leads.length, unworked,
      avgScore: Math.round(scores.reduce((s, x) => s + x, 0) / Math.max(1, scores.length)),
      topCompetitor: topCompetitor ? { name: topCompetitor[0], count: topCompetitor[1] } : null,
      competitorShare: Math.round((leads.filter(l => l.competitorName).length / leads.length) * 100),
      newFiber: leads.filter(l => l.leadTag === "fresh_fiber_confirmed" && l.freshConfidence === "cross_verified").length,
      generatedAt: new Date().toISOString(),
    };
  }

  // Deploy an opportunity cluster as a TERRITORY assigned to a rep — the step
  // that turns discovery into fieldwork. Takes the cluster's boundary polygon +
  // a rep, creates the area, assigns every enclosed reassignable lead, and
  // captures a server-AUTHORED briefing ("why this area") so the rep understands
  // the opportunity immediately. team_lead+ with the same scope guards as a
  // lasso assign — this does NOT spend proxy money.
  app.post("/api/scan/deploy", requireTeamLead, (req: any, res) => {
    const user = req.user;
    const t = user?.tenantId ?? undefined;
    const { polygon, repId, repIds, name, sourceRunId, leadIds } = req.body ?? {};
    if (!Array.isArray(polygon) || polygon.length < 3) return res.status(400).json({ error: "polygon (>=3 points) required" });

    // One rep, or a SPLIT across several reps (the "field N reps" flow).
    const reps: number[] = Array.isArray(repIds) && repIds.length
      ? repIds.map(Number).filter(Number.isFinite)
      : (repId != null ? [Number(repId)] : []);
    if (reps.length === 0) return res.status(400).json({ error: "repId or repIds required" });

    // Validate every rep up front — scope + capacity — so a split is all-or-nothing.
    for (const rid of reps) {
      const rp = storage.getTeamMemberById(rid);
      // Tenant wall FIRST: even an org-wide admin/manager can only deploy to a
      // rep in their own tenant — 404 (not 403) so a foreign rep id can't be
      // probed. Then the team-scope check for team_leads.
      if (!rp || !repInCallerTenant(user, rid)) return res.status(404).json({ error: `rep ${rid} not found` });
      if (!repInVisibilityScope(user, rid)) return res.status(403).json({ error: "A chosen rep is not on your team", code: "OUT_OF_SCOPE" });
      const active = storage.getTerritoriesByRep(rid).filter((x: any) => x.status === "active" || x.status === "shared").length;
      if (!canRepTakeAnotherArea(active)) return res.status(409).json({ error: `${rp.name} already has ${active} active areas (max ${MAX_ACTIVE_AREAS_PER_REP}).` });
    }

    // AUTHORITATIVE member set: exactly the cluster's leads (never over-enclose a
    // hull, never drop a boundary door). Fallback for lasso callers: padded ring.
    const memberIds: number[] = Array.isArray(leadIds) ? leadIds.map(Number).filter(Number.isFinite) : [];
    let enclosed: any[];
    if (memberIds.length > 0) {
      const idset = new Set(memberIds);
      enclosed = storage.getLeads(t).filter((l: any) => idset.has(l.id) && l.lat != null && l.lng != null && canReassignLead(user, l));
    } else {
      const padded = padHull(polygon as [number, number][], 40);
      enclosed = storage.getLeads(t).filter((l: any) =>
        l.lat != null && l.lng != null && pointInPolygon(l.lat, l.lng, padded) && canReassignLead(user, l));
    }
    if (enclosed.length === 0) return res.status(409).json({ error: "No assignable leads inside this cluster" });

    const visits = storage.getVisitSummary(t);
    const at = new Date().toISOString();

    // Partition members into one parcel per rep (compact, contiguous, balanced).
    // One rep → one parcel (all members). N reps → subdivideCluster by geography.
    const parcelIdLists = reps.length === 1
      ? [enclosed.map((l: any) => l.id)]
      : subdivideCluster(enclosed.map((l: any) => ({ id: l.id, lat: l.lat, lng: l.lng })), reps.length);

    const results: Array<{ territory: any; repId: number; assigned: number; briefing: any }> = [];
    parcelIdLists.forEach((ids, i) => {
      const rid = reps[Math.min(i, reps.length - 1)];
      const rp = storage.getTeamMemberById(rid)!;
      const leadsInParcel = enclosed.filter((l: any) => ids.includes(l.id));
      if (leadsInParcel.length === 0) return;
      const hull = padHull(convexHull(leadsInParcel.map((l: any) => [l.lng, l.lat] as [number, number])), 40);
      const briefing = buildDeployBriefing(leadsInParcel, visits);
      const territory = storage.createTerritory({
        tenantId: t ?? null,
        name: reps.length > 1 ? `${rp.name}'s area` : ((name && String(name).trim()) || `${rp.name}'s area`),
        repId: rid, polygon: JSON.stringify(hull.length >= 3 ? hull : polygon), color: colorForRep(rid),
        status: "active", assigneeIds: JSON.stringify([rid]),
        briefing: JSON.stringify(briefing), sourceRunId: sourceRunId ? String(sourceRunId) : null, updatedAt: at,
      } as any);
      storage.addTerritoryEvent(territory.id, user?.id ?? null, "created", { repId: rid, name: territory.name, fromScan: true, sourceRunId: sourceRunId ?? null, split: reps.length > 1 });
      let assigned = 0;
      for (const l of leadsInParcel) {
        if (storage.updateLead(l.id, { assignedRepId: rid, assignedTerritoryId: territory.id, assignmentSource: "scan-deploy", assignedBy: user?.name ?? null, assignedAt: at } as any, t)) {
          assigned++;
          storage.addLeadEvent(l.id, "assignment", user?.name ?? null, { assignedTo: rp.name, assignedBy: user?.name ?? null });
        }
      }
      storage.addTerritoryEvent(territory.id, user?.id ?? null, "assigned", { repId: rid, assigned });
      results.push({ territory, repId: rid, assigned, briefing });
    });

    if (typeof (globalThis as any).__bustMapCache === "function") (globalThis as any).__bustMapCache(t);
    // Back-compat single-rep shape; multi-rep adds `deployments`.
    const primary = results[0];
    res.status(201).json({
      territory: primary?.territory, assigned: results.reduce((s, r) => s + r.assigned, 0),
      briefing: primary?.briefing,
      deployments: results.map(r => ({ territoryId: r.territory.id, repId: r.repId, assigned: r.assigned })),
    });
  });

  // GET /api/scan/first-seen-live — the first-to-market feed: addresses that
  // FLIPPED from unavailable to live within the window (default 24h), newest
  // first, each tagged with whether it's already been turned into a lead.
  // This is the core "New Fiber Today / First Seen Live" manager surface.
  // GET /api/fiber/changes — the permanent transition feed: every dark→live flip,
  // copper→fiber upgrade, coming-soon sighting and regression, newest first.
  app.get("/api/fiber/changes", requireManager, (req: any, res) => {
    try {
      const tenantId = req.user?.tenantId ?? getDefaultTenantId();
      const hours = Math.min(24 * 90, Math.max(1, Number(req.query.hours) || 168));
      const limit = Math.min(2_000, Math.max(1, Number(req.query.limit) || 300));
      res.json(getFiberChanges(tenantId, hours, limit));
    } catch (error: any) { res.status(500).json({ error: String(error?.message ?? error) }); }
  });

  // GET /api/fiber/copper-pool — the copper-upgrade candidate pool: addresses whose
  // last answer was copper/legacy, rechecked daily by the copper-upgrade sweep.
  app.get("/api/fiber/copper-pool", requireManager, (req: any, res) => {
    try {
      const tenantId = req.user?.tenantId ?? getDefaultTenantId();
      res.json(getCopperPool(tenantId));
    } catch (error: any) { res.status(500).json({ error: String(error?.message ?? error) }); }
  });

  // GET /api/coming-soon/program — the Coming Soon PROGRAM surface (opportunity-
  // weighted worker + counters). The canonical watchlist board lives at
  // /api/coming-soon/watchlist (comingSoonWatchlist.ts).
  app.get("/api/coming-soon/program", requireManager, (req: any, res) => {
    try {
      const tenantId = req.user?.tenantId ?? getDefaultTenantId();
      res.json(getComingSoonWatchlist(tenantId));
    } catch (error: any) {
      res.status(500).json({ error: String(error?.message ?? error) });
    }
  });

  app.get("/api/scan/first-seen-live", requireManager, (req: any, res) => {
    const hours = Math.min(Math.max(Number(req.query.hours) || 24, 1), 24 * 30);
    const tenantId = req.user?.tenantId ?? getDefaultTenantId();
    const cutoff = Date.now() - hours * 3_600_000;
    const rows = freshPoints(tenantId, Math.ceil(hours / 24) + 1)
      .filter((point) => Date.parse(point.firstSeenLiveAt) >= cutoff)
      .slice(0, 200);
    res.json({
      windowHours: hours,
      count: rows.length,
      confirmed: rows.filter(r => r.confidence === "cross_verified").length,
      provisional: rows.filter(r => r.confidence === "single_source_provisional").length,
      readyToAssign: rows.filter(r => r.confidence === "cross_verified" && r.leadId != null).length,
      addresses: rows,
    });
  });

  // POST /api/scan/rescan-pool — re-scan the stored address pool for CHANGES.
  // Uses zero geocoding (addresses are already stored), dedups against existing
  // leads, records address-level changes, and lets the shared projector publish
  // only independently confirmed fresh fiber. This is the cheap repeatable pass.
  app.post("/api/scan/rescan-pool", requireAdmin, requireScanningAllowed, authorizedScanAdmission, (req, res) => {
    const limit = Math.min(Number(req.body?.limit) || 50000, 100000);
    const targets = storage.getScanTargetsToRescan(limit);
    if (!targets.length) {
      return res.status(400).json({ error: "Address pool is empty. Run a city scan first to build it." });
    }
    // Only re-check addresses that aren't already leads; confirmed transitions
    // are published by the evidence projector, never by this route.
    const existingSet = new Set(storage.getLeads().map((l: any) => normalizeAddrForDedup(l.address)));
    const toScan = targets
      .filter((t: any) => !existingSet.has(normalizeAddrForDedup(t.address || "")))
      .map((t: any) => ({ address: t.address, city: t.city, state: t.state, zip: t.zip, lat: t.lat, lng: t.lng }));
    if (!toScan.length) {
      return res.json({ jobId: null, total: 0, source: "pool", message: "Every pooled address is already a lead — nothing new to check." });
    }
    const jobId = `rescan_${Date.now()}`;
    const job: ScanJob = {
      tenantId: (req as any).user?.tenantId ?? getDefaultTenantId(), // poll/cancel/list must resolve
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
    const jobId = qstr(req.params.jobId);
    const job = scanJobs.get(jobId);
    // Tenant guard — mirror GET/DELETE :jobId. Without it any manager could stream
    // another org's live scan results (addresses/coords) by guessing the jobId.
    const _sseTid = (req as any).user?.tenantId;
    if (!job || (_sseTid && job.tenantId !== _sseTid)) return res.status(404).json({ error: "Job not found" });

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
      const counts = scanSummary(r);
      const progress = {
        jobId: r.id, status: r.status, done: r.done, total: r.total,
        summary: {
          ...counts,
          eligible: counts.fresh,
          scanned: r.done,
          remaining: Math.max(0, r.total - r.done),
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
    const job = scanJobs.get(qstr(req.params.jobId));
    const _sjTid = (req as any).user?.tenantId;
    if (!job || (_sjTid && job.tenantId !== _sjTid)) return res.status(404).json({ error: "Not found" });
    const r = job.results;
    // ?since=N cursor: return only results[N..] — the 400ms poll used to
    // re-download the FULL cumulative array every tick (O(total²) bytes over a
    // scan; a 10k-address deep scan ends at ~2MB × 2.5/s of re-parse on a
    // phone). resultCount carries the new cursor. One summary pass, not seven.
    const since = Math.max(0, Number(req.query.since) || 0);
    const summary = scanSummary(job);
    res.json({
      ...job,
      results: since > 0 ? r.slice(since) : r,
      resultCount: r.length,
      summary: {
        ...summary,
        // Eligible means cross-verified fresh fiber published by the projector.
        eligible: summary.fresh,
        scanned: job.done,
        remaining: job.total - job.done,
      }
    });
  });

  app.delete("/api/scan/:jobId", requireManager, (req, res) => {
    // Tenant-scoped: only cancel a job in your own org (was globally deletable).
    const job = scanJobs.get(qstr(req.params.jobId));
    const _tid = (req as any).user?.tenantId;
    if (!job || (_tid && job.tenantId !== _tid)) return res.status(404).json({ error: "Not found" });
    scanJobs.delete(qstr(req.params.jobId));
    res.json({ success: true });
  });

  app.get("/api/scan", requireManager, (req, res) => {
    // Tenant-scoped list (was every tenant's jobs).
    const _tid = (req as any).user?.tenantId;
    res.json(Array.from(scanJobs.values())
      .filter(j => _tid == null || j.tenantId === _tid)
      .map(j => ({
        id: j.id, city: j.city, zip: j.zip, status: j.status,
        total: j.total, done: j.done, startedAt: j.startedAt, completedAt: j.completedAt,
      })));
  });

  // Fiber check history
  // Recent raw checks are an ops/debug log carrying full provider payloads — gate
  // to manager+, scope to the caller's tenant, and NEVER return the raw provider
  // `result` blob (it embeds dfAddressId/accessId/exchangeId + competitor intel).
  app.get("/api/fiber-checks", requireManager, (req, res) => {
    const rows = storage.getRecentChecks(100, (req as any).user?.tenantId);
    res.json(rows.map(({ result, ...safe }: any) => safe));
  });

  // ── Team Members ─────────────────────────────────────────────────────────────
  app.get("/api/team", requireCapability("field.app.use"), (req, res) => {
    const user = (req as any).user;
    const tid = user?.tenantId ?? undefined;
    const members = storage.getTeamMembers(tid);
    // Reps need names to resolve "assigned to …" and rankings, but NOT the
    // roster's phones/emails/org structure — project those away for reps.
    if (user?.role === "rep") {
      return res.json(members.map((m: any) => ({ id: m.id, name: m.name, role: m.role, active: m.active, tenantId: m.tenantId ?? null })));
    }
    // A team_lead's roster is their own team (self + direct reports) — this also
    // scopes the map's rep-filter + lasso-assign dropdowns to their reps only.
    if (user?.role === "team_lead") {
      const scope = leadVisibilityScope(user);
      const ids = Array.isArray(scope) ? new Set(scope) : null;
      return res.json(ids ? members.filter((m: any) => ids.has(m.id)) : members);
    }
    res.json(members);
  });
  // Which member roles each account role may create/promote to.
  // Admin hires managers; managers hire team leads + reps; team leads hire reps only.
  // Single source of truth in @shared/teamHierarchy — the client renders from
  // the same map, so the UI never offers a hire the API refuses.
  const HIRABLE_ROLES: Record<string, readonly string[]> = SHARED_HIRABLE_ROLES;
  // Team lead, manager, and admin can add/edit reps
  // Team members with an email automatically get a login account (OTP by email).
  // The Team page is the ONE place to manage people — no separate Accounts page.
  class TeamLoginSyncError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
      this.name = "TeamLoginSyncError";
    }
  }

  const normalizeTeamEmail = (email: unknown): string | null => {
    if (email == null) return null;
    if (typeof email !== "string") throw new TeamLoginSyncError("INVALID_TEAM_EMAIL", "A valid email is required.");
    const normalized = email.trim().toLowerCase();
    return normalized || null;
  };

  /** Validate the login claim before the team row is changed. A same-tenant,
   * unlinked account may be adopted only when its role already matches; foreign
   * accounts and accounts linked to another member are never moved or relinked. */
  function teamLoginEmailConflict(input: {
    tenantId: number;
    memberId?: number;
    memberRole: string;
    email: string | null;
  }): TeamLoginSyncError | null {
    if (!input.email) return null;
    const byEmail = storage.getUserByEmail(input.email);
    if (!byEmail) return null;
    if (byEmail.tenantId !== input.tenantId) {
      return new TeamLoginSyncError(
        "LOGIN_EMAIL_OTHER_ORGANIZATION",
        "That email belongs to a login in another organization.",
      );
    }
    if (byEmail.teamMemberId != null && byEmail.teamMemberId !== input.memberId) {
      return new TeamLoginSyncError(
        "LOGIN_EMAIL_ALREADY_LINKED",
        "That email is already linked to another team member.",
      );
    }
    const linked = input.memberId == null
      ? undefined
      : storage.getAllUsers(input.tenantId).find((user) => user.teamMemberId === input.memberId);
    if (linked && linked.id !== byEmail.id) {
      return new TeamLoginSyncError(
        "LOGIN_EMAIL_IN_USE",
        "That email is already used by another login.",
      );
    }
    if (byEmail.teamMemberId == null && byEmail.role !== input.memberRole) {
      return new TeamLoginSyncError(
        "LOGIN_EMAIL_ROLE_CONFLICT",
        "That email belongs to an existing login with a different role.",
      );
    }
    return null;
  }

  function syncLoginAccount(member: { id: number; name: string; email?: string | null; role: string; active: boolean; tenantId?: number | null }) {
    const tenantId = member.tenantId;
    if (!Number.isInteger(tenantId)) {
      throw new TeamLoginSyncError("TEAM_TENANT_REQUIRED", "Organization context is required to synchronize a login.");
    }
    const email = normalizeTeamEmail(member.email);
    const conflict = teamLoginEmailConflict({ tenantId: tenantId!, memberId: member.id, memberRole: member.role, email });
    if (conflict) throw conflict;

    // KICKED MEANS SIGNED OUT — everywhere, immediately. Deactivating a login
    // without dropping its live sessions left a removed member working from an
    // already-open app until their session lapsed; with sliding renewal that
    // window no longer closes on its own. Every path that ends with an INACTIVE
    // login revokes here, so the rule holds for the dedicated offboard routes
    // and for any future caller that merely flips a member inactive.
    // Returned to the caller so a route that also reports a revocation count
    // (offboard) stays truthful about the total rather than reporting 0 just
    // because this layer got there first.
    let sessionsRevoked = 0;
    const revokeIfDeactivated = (userId: number) => {
      if (member.active) return;
      const revoked = storage.deleteSessionsByUser(userId);
      sessionsRevoked += revoked;
      if (revoked > 0) {
        structuredLog("auth.sessions_revoked", { userId, teamMemberId: member.id, reason: "member_deactivated", revoked });
      }
    };

    const linked = storage.getAllUsers(tenantId!).find((user) => user.teamMemberId === member.id);
    if (email) {
      if (linked) {
        const updated = storage.updateUser(linked.id, {
          name: member.name, email, role: member.role, active: member.active,
        } as any, tenantId!);
        if (!updated) throw new Error("Tenant-scoped login update failed");
        revokeIfDeactivated(linked.id);
      } else {
        const byEmail = storage.getUserByEmail(email);
        if (byEmail) {
          const updated = storage.updateUser(byEmail.id, {
            teamMemberId: member.id, name: member.name, role: member.role, active: member.active,
          } as any, tenantId!);
          if (!updated) throw new Error("Tenant-scoped login adoption failed");
          revokeIfDeactivated(byEmail.id);
        } else {
          storage.createUser({
            name: member.name,
            email,
            role: member.role,
            active: member.active,
            teamMemberId: member.id,
            tenantId: tenantId!,
          } as any);
        }
      }
    } else if (linked) {
      // Email removed → login disabled (account kept for history). The tenant
      // predicate ensures a corrupt foreign link can never be modified here.
      const updated = storage.updateUser(linked.id, { active: false } as any, tenantId!);
      if (!updated) throw new Error("Tenant-scoped login disable failed");
      // Disabled login = no live sessions, regardless of the member's own flag.
      const revoked = storage.deleteSessionsByUser(linked.id);
      sessionsRevoked += revoked;
      if (revoked > 0) {
        structuredLog("auth.sessions_revoked", { userId: linked.id, teamMemberId: member.id, reason: "login_email_removed", revoked });
      }
    }
    return { sessionsRevoked };
  }

  const sendTeamLoginSyncError = (res: Response, error: unknown) => {
    if (error instanceof TeamLoginSyncError) {
      return res.status(error.code === "INVALID_TEAM_EMAIL" ? 400 : 409).json({ error: error.message, code: error.code });
    }
    console.error("[team-sync] login account sync failed:", (error as any)?.message ?? error);
    return res.status(500).json({ error: "Could not synchronize the team login." });
  };

  app.post("/api/team", requireTeamLead, (req, res) => {
    const parsed = insertTeamMemberSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error });
    const creatorRole = (req as any).user.role as string;
    const newRole = parsed.data.role ?? "rep";
    if (!(HIRABLE_ROLES[creatorRole] ?? []).includes(newRole)) {
      return res.status(403).json({ error: `Your role cannot create a ${newRole.replace("_", " ")}` });
    }
    const tenantId = (req as any).user?.tenantId;
    if (!Number.isInteger(tenantId)) return res.status(403).json({ error: "Organization context required" });
    let email: string | null;
    try { email = normalizeTeamEmail(parsed.data.email); }
    catch (error) { return sendTeamLoginSyncError(res, error); }
    const conflict = teamLoginEmailConflict({ tenantId, memberRole: newRole, email });
    if (conflict) return sendTeamLoginSyncError(res, conflict);
    // SUPERVISOR VALIDATION — same rule as PATCH: the reports-to edge must stay
    // inside the creator's tenant and point at an active member who ranks
    // strictly above the new member. (A new member has no subordinates, so a
    // cycle is impossible here.)
    if (parsed.data.reportsToId != null) {
      const supervisor = storage.getTeamMembers(tenantId).find((member) => member.id === Number(parsed.data.reportsToId));
      if (!supervisor || !supervisor.active) {
        return res.status(400).json({ error: "Supervisor must be an active member of your organization", code: "INVALID_SUPERVISOR" });
      }
      if (!isValidSupervisorRole(newRole, supervisor.role)) {
        return res.status(400).json({ error: "A supervisor must rank above the member they manage", code: "INVALID_SUPERVISOR" });
      }
    }
    // Tenancy is NEVER client-supplied: a new member always joins the creator's
    // org (overrides any tenantId smuggled into the body).
    try {
      const tx = rawDb.transaction(() => {
        const member = storage.createTeamMember({ ...parsed.data, email, tenantId });
        syncLoginAccount(member as any);
        return member;
      });
      res.status(201).json(tx.immediate());
    } catch (error) {
      return sendTeamLoginSyncError(res, error);
    }
  });
  app.patch("/api/team/:id", requireTeamLead, (req, res) => {
    const tenantId = (req as any).user?.tenantId;
    if (!Number.isInteger(tenantId)) return res.status(403).json({ error: "Organization context required" });
    const id = Number(req.params.id);
    // Scope guard: a team_lead may only edit members on their own team — NOT any
    // member in the tenant. Without this, a team_lead could PATCH a victim's `email`
    // (which syncs to their login) and hijack the account via OTP. Managers/admins
    // keep org-wide edit; the scope helper returns true for them.
    if (!repInVisibilityScope((req as any).user, id)) {
      return res.status(403).json({ error: "That member is not on your team", code: "OUT_OF_SCOPE" });
    }
    // A member cannot report to themselves
    if (req.body?.reportsToId != null && Number(req.body.reportsToId) === id) {
      return res.status(400).json({ error: "A member cannot report to themselves" });
    }
    const actor = (req as any).user;
    const members = storage.getTeamMembers(tenantId);
    const existing = members.find((member) => member.id === id);
    if (!existing) return res.status(404).json({ error: "Not found" });
    // HIERARCHY: you may only edit members strictly below your own rank —
    // peers can never edit each other (a manager cannot rewrite a fellow
    // manager's email/role/status), and nobody edits upward. The one
    // exception is your own row, restricted to harmless profile fields below.
    const isSelfEdit = actor.teamMemberId === id;
    // Authority is decided by the member's EFFECTIVE role (max of field role and
    // linked login role) so a low field-role can never shield a higher login.
    if (!isSelfEdit && !canActOnMember(actor.role, effectiveMemberRole(tenantId, existing))) {
      return res.status(403).json({ error: "You can only manage members below your own role", code: "HIERARCHY_FORBIDDEN" });
    }
    // Activation is NOT a PATCH field: flipping `active` here would disable the
    // linked login without revoking sessions, re-homing reports, or checking the
    // last-admin guard (a manager could PATCH the sole admin's member inactive
    // and lock the org out). Status changes go through /offboard and /reactivate.
    if (Object.prototype.hasOwnProperty.call(req.body ?? {}, "active")) {
      return res.status(400).json({
        error: "Use Offboard or Reactivate to change a member's status",
        code: "USE_LIFECYCLE_ENDPOINT",
      });
    }
    // Role changes obey the same hiring hierarchy as creation
    if (req.body?.role) {
      if (!(HIRABLE_ROLES[actor.role as string] ?? []).includes(req.body.role)) {
        return res.status(403).json({ error: `Your role cannot set a member to ${String(req.body.role).replace("_", " ")}` });
      }
    }
    // Allowlist fields — tenantId is NEVER client-settable (mass-assignment of it
    // would move a member/login into another tenant = cross-tenant takeover). Match
    // the /api/leads and /api/users PATCH pattern. Self-edits are limited to
    // profile fields: changing your own role/supervisor (or login email, which a
    // hijacked session could use to make a takeover permanent) requires someone
    // above you.
    const ALLOWED_TEAM_FIELDS = new Set(isSelfEdit
      ? ["name", "phone"]
      : ["name", "phone", "email", "role", "reportsToId"]);
    const rejectedSelfFields = isSelfEdit
      ? Object.keys(req.body ?? {}).filter((k) => ["email", "role", "reportsToId"].includes(k))
      : [];
    if (rejectedSelfFields.length > 0) {
      return res.status(403).json({
        error: "You cannot change your own role, supervisor, or login email — ask someone above you",
        code: "SELF_LIFECYCLE_FORBIDDEN",
      });
    }
    const safeUpdate: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(req.body ?? {})) {
      if (ALLOWED_TEAM_FIELDS.has(k)) safeUpdate[k] = v;
    }
    if (Object.keys(safeUpdate).length === 0) {
      return res.status(400).json({ error: "No valid fields to update" });
    }
    // SUPERVISOR VALIDATION — a reports-to edge must stay inside the tenant
    // (the roster lookup above is tenant-scoped), point at an active member
    // who ranks strictly above this member, and never close a reporting loop.
    if (Object.prototype.hasOwnProperty.call(safeUpdate, "reportsToId") && safeUpdate.reportsToId != null) {
      const supervisorId = Number(safeUpdate.reportsToId);
      const supervisor = members.find((member) => member.id === supervisorId);
      const roleAfterUpdate = typeof safeUpdate.role === "string" ? safeUpdate.role : existing.role;
      if (!supervisor || !supervisor.active) {
        return res.status(400).json({ error: "Supervisor must be an active member of your organization", code: "INVALID_SUPERVISOR" });
      }
      if (!isValidSupervisorRole(roleAfterUpdate, supervisor.role)) {
        return res.status(400).json({ error: "A supervisor must rank above the member they manage", code: "INVALID_SUPERVISOR" });
      }
      const chain = new Map<number, number | null>(members.map((member) => [member.id, (member as any).reportsToId ?? null]));
      if (wouldCreateReportsCycle(id, supervisorId, chain)) {
        return res.status(400).json({ error: "That change would create a reporting loop", code: "REPORTS_TO_CYCLE" });
      }
    }
    let email: string | null;
    try { email = normalizeTeamEmail(Object.prototype.hasOwnProperty.call(safeUpdate, "email") ? safeUpdate.email : existing.email); }
    catch (error) { return sendTeamLoginSyncError(res, error); }
    if (Object.prototype.hasOwnProperty.call(safeUpdate, "email")) safeUpdate.email = email;
    const memberRole = typeof safeUpdate.role === "string" ? safeUpdate.role : existing.role;
    // LOGIN-RETARGET GUARD: changing the member email rewrites the linked LOGIN's
    // email via syncLoginAccount — after which the editor could OTP into the
    // victim's account with the audit trail under the victim's name. So an email
    // retarget is refused unless the caller ranks STRICTLY ABOVE the linked
    // login's role (admin > manager > team_lead > rep): a manager can never
    // retarget a fellow manager's or an admin's login, even where the general
    // edit guard above would otherwise let the edit through. No linked login →
    // the member's own (effective) role governs, matching the edit guard.
    const oldEmail = normalizeTeamEmail(existing.email);
    const emailRetargeted = Object.prototype.hasOwnProperty.call(safeUpdate, "email") && email !== oldEmail;
    const linkedLogin = storage.getAllUsers(tenantId).find((user) => user.teamMemberId === id);
    if (emailRetargeted && !isSelfEdit) {
      const actorRank = hierarchyRank(actor.role) ?? -1;
      const loginRank = hierarchyRank(linkedLogin?.role ?? effectiveMemberRole(tenantId, existing)) ?? -1;
      if (loginRank >= actorRank) {
        return res.status(403).json({
          error: "You cannot change the login email of a member at or above your own role",
          code: "LOGIN_RETARGET_FORBIDDEN",
        });
      }
    }
    const conflict = teamLoginEmailConflict({ tenantId, memberId: id, memberRole, email });
    if (conflict) return sendTeamLoginSyncError(res, conflict);
    try {
      const tx = rawDb.transaction(() => {
        const updated = storage.updateTeamMember(id, safeUpdate, tenantId);
        if (!updated) return null;
        syncLoginAccount(updated as any);
        // A demotion can leave direct reports pointing at a supervisor who no
        // longer outranks them (reps reporting to a rep). Re-home those
        // subordinates to the edited member's own supervisor so the org chart
        // never holds an invalid edge.
        if (typeof safeUpdate.role === "string" && safeUpdate.role !== existing.role) {
          const invalidated = members.filter((member) =>
            (member as any).reportsToId === id && !isValidSupervisorRole(member.role, safeUpdate.role as string));
          for (const subordinate of invalidated) {
            storage.updateTeamMember(subordinate.id, { reportsToId: (existing as any).reportsToId ?? null } as any, tenantId);
          }
        }
        return updated;
      });
      const updated = tx.immediate();
      if (!updated) return res.status(404).json({ error: "Not found" });
      // Audit every login-email retarget with old + new + actor: this is the
      // trail that distinguishes a legitimate mailbox fix from a hijack.
      if (emailRetargeted) {
        storage.logActivity(actor.id, "team.login_email_retargeted", "team_member", id, {
          oldEmail, newEmail: email, actorRole: actor.role, linkedUserId: linkedLogin?.id ?? null,
        }, req.ip);
      }
      res.json(updated);
    } catch (error) {
      return sendTeamLoginSyncError(res, error);
    }
  });

  /** The role that actually governs authority over a member: the HIGHER of
   * their field role (team_members.role) and their linked login role
   * (users.role). A member row can read "rep" while its login is an admin
   * (e.g. an admin who also carries a field profile) — the authority decision
   * must use the login's real power, or a manager could offboard/edit an admin
   * by exploiting the low field-role. Falls back to the field role. */
  function effectiveMemberRole(tenantId: number, member: { id: number; role: string }): string {
    const login = storage.getAllUsers(tenantId).find((u) => u.teamMemberId === member.id);
    const memberRank = hierarchyRank(member.role) ?? -1;
    const loginRank = hierarchyRank(login?.role) ?? -1;
    return loginRank > memberRank ? (login!.role as string) : member.role;
  }

  /** Last-line-of-defense: refuse a lifecycle action that would leave the
   * organization without a single active admin login. */
  function wouldOrphanTenantAdmins(tenantId: number, targetMemberId: number): boolean {
    const users = storage.getAllUsers(tenantId);
    const linked = users.find((u) => u.teamMemberId === targetMemberId);
    if (!linked || linked.role !== "admin" || !linked.active) return false;
    const activeAdmins = users.filter((u) => u.role === "admin" && u.active);
    return activeAdmins.length <= 1;
  }

  // ── OFFBOARDING — the hierarchy "kick" ──────────────────────────────────────
  // Team leads offboard their reps; managers offboard team leads (and reps);
  // admins offboard managers (and below). Strictly-above only: peers can never
  // remove each other, nobody removes upward, and nobody offboards themselves.
  // Offboarding is a soft removal that keeps every record: the member is
  // deactivated, their login is disabled, every live session is revoked so
  // access ends NOW (not at next login), and their direct reports are re-homed
  // to the offboarded member's own supervisor. Fully audited.
  app.post("/api/team/:id/offboard", requireTeamLead, (req, res) => {
    const actor = (req as any).user;
    const tenantId = actor?.tenantId;
    if (!Number.isInteger(tenantId)) return res.status(403).json({ error: "Organization context required" });
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid member id" });
    // Team leads may only act inside their own team; managers/admins pass org-wide.
    if (!repInVisibilityScope(actor, id)) {
      return res.status(403).json({ error: "That member is not on your team", code: "OUT_OF_SCOPE" });
    }
    const members = storage.getTeamMembers(tenantId);
    const target = members.find((member) => member.id === id);
    if (!target) return res.status(404).json({ error: "Not found" });
    if (actor.teamMemberId === id) {
      return res.status(400).json({ error: "You cannot offboard yourself", code: "CANNOT_OFFBOARD_SELF" });
    }
    if (!canActOnMember(actor.role, effectiveMemberRole(tenantId, target))) {
      return res.status(403).json({ error: "You can only offboard members below your own role", code: "HIERARCHY_FORBIDDEN" });
    }
    if (!target.active) {
      return res.status(409).json({ error: "That member is already offboarded", code: "ALREADY_INACTIVE" });
    }
    if (wouldOrphanTenantAdmins(tenantId, id)) {
      return res.status(409).json({ error: "The organization must keep at least one active admin", code: "LAST_ADMIN" });
    }
    try {
      const tx = rawDb.transaction(() => {
        const updated = storage.updateTeamMember(id, { active: false } as any, tenantId);
        if (!updated) return null;
        // Mirrors active:false onto the linked login (or leaves it absent) and
        // revokes its sessions as part of that mirror.
        const sync = syncLoginAccount(updated as any);
        // Re-home direct reports to the offboarded member's own supervisor so
        // nobody is left reporting to a deactivated member.
        const newSupervisorId = (target as any).reportsToId ?? null;
        const reassigned = rawDb.prepare(
          "UPDATE team_members SET reports_to_id = ? WHERE reports_to_id = ? AND tenant_id = ?",
        ).run(newSupervisorId, id, tenantId).changes;
        // Kill every live session immediately — a kicked member's open app
        // stops working on the next request, not at the next login.
        const linked = storage.getAllUsers(tenantId).find((u) => u.teamMemberId === id);
        const sessionsRevoked = sync.sessionsRevoked + (linked ? storage.deleteSessionsByUser(linked.id) : 0);
        return { updated, reassigned, loginDisabled: Boolean(linked), sessionsRevoked };
      });
      const result = tx.immediate();
      if (!result) return res.status(404).json({ error: "Not found" });
      storage.logActivity(actor.id, "team.member.offboarded", "team_member", id, {
        name: target.name, role: target.role, by: actor.role,
        reassignedReports: result.reassigned, sessionsRevoked: result.sessionsRevoked,
      }, req.ip);
      res.json({
        success: true,
        member: result.updated,
        reassignedReports: result.reassigned,
        loginDisabled: result.loginDisabled,
        sessionsRevoked: result.sessionsRevoked,
      });
    } catch (error) {
      return sendTeamLoginSyncError(res, error);
    }
  });

  // Reactivation follows the same authority rule as the kick: only someone
  // strictly above the member can bring them back, inside their scope.
  app.post("/api/team/:id/reactivate", requireTeamLead, (req, res) => {
    const actor = (req as any).user;
    const tenantId = actor?.tenantId;
    if (!Number.isInteger(tenantId)) return res.status(403).json({ error: "Organization context required" });
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid member id" });
    if (!repInVisibilityScope(actor, id)) {
      return res.status(403).json({ error: "That member is not on your team", code: "OUT_OF_SCOPE" });
    }
    const target = storage.getTeamMembers(tenantId).find((member) => member.id === id);
    if (!target) return res.status(404).json({ error: "Not found" });
    if (!canActOnMember(actor.role, effectiveMemberRole(tenantId, target))) {
      return res.status(403).json({ error: "You can only reactivate members below your own role", code: "HIERARCHY_FORBIDDEN" });
    }
    if (target.active) {
      return res.status(409).json({ error: "That member is already active", code: "ALREADY_ACTIVE" });
    }
    try {
      const tx = rawDb.transaction(() => {
        const updated = storage.updateTeamMember(id, { active: true } as any, tenantId);
        if (!updated) return null;
        syncLoginAccount(updated as any); // re-enables the linked login when an email exists
        return updated;
      });
      const updated = tx.immediate();
      if (!updated) return res.status(404).json({ error: "Not found" });
      storage.logActivity(actor.id, "team.member.reactivated", "team_member", id,
        { name: target.name, role: target.role, by: actor.role }, req.ip);
      res.json({ success: true, member: updated });
    } catch (error) {
      return sendTeamLoginSyncError(res, error);
    }
  });

  // Only manager+ can hard-delete members — and only members strictly below
  // their own rank (a manager cannot delete a fellow manager). The row is
  // removed but knock history stays; the login is disabled and its live
  // sessions are revoked, and direct reports are re-homed first.
  app.delete("/api/team/:id", requireManager, (req, res) => {
    const actor = (req as any).user;
    const tenantId = actor?.tenantId;
    if (!Number.isInteger(tenantId)) return res.status(403).json({ error: "Organization context required" });
    const id = Number(req.params.id);
    const target = storage.getTeamMembers(tenantId).find((member) => member.id === id);
    if (!target) return res.status(404).json({ error: "Not found" });
    if (actor.teamMemberId === id) {
      return res.status(400).json({ error: "You cannot remove yourself", code: "CANNOT_REMOVE_SELF" });
    }
    if (!canActOnMember(actor.role, effectiveMemberRole(tenantId, target))) {
      return res.status(403).json({ error: "You can only remove members below your own role", code: "HIERARCHY_FORBIDDEN" });
    }
    if (wouldOrphanTenantAdmins(tenantId, id)) {
      return res.status(409).json({ error: "The organization must keep at least one active admin", code: "LAST_ADMIN" });
    }
    const tx = rawDb.transaction(() => {
      const reassigned = rawDb.prepare(
        "UPDATE team_members SET reports_to_id = ? WHERE reports_to_id = ? AND tenant_id = ?",
      ).run((target as any).reportsToId ?? null, id, tenantId).changes;
      if (!storage.deleteTeamMember(id, tenantId)) return null;
      // Member removed → disable their login (account kept for knock history)
      // and revoke live sessions so access ends immediately.
      let sessionsRevoked = 0;
      const linked = storage.getAllUsers(tenantId).find(u => u.teamMemberId === id);
      if (linked) {
        storage.updateUser(linked.id, { active: false } as any, tenantId);
        sessionsRevoked = storage.deleteSessionsByUser(linked.id);
      }
      return { reassigned, sessionsRevoked };
    });
    const result = tx.immediate();
    if (!result) return res.status(404).json({ error: "Not found" });
    storage.logActivity(actor.id, "team.member.removed", "team_member", id,
      { name: target.name, role: target.role, by: actor.role, reassignedReports: result.reassigned }, req.ip);
    res.json({ success: true, reassignedReports: result.reassigned, sessionsRevoked: result.sessionsRevoked });
  });

  // ── Lead → Assign rep ─────────────────────────────────────────────────────────
  // Team lead+ can assign leads
  app.post("/api/leads/:id/assign", requireCapability("lead.assign"), (req, res) => {
    const { repId } = req.body;
    const user = (req as any).user;
    const tid = user?.tenantId ?? undefined;
    // Scope: a team_lead may only target their own reps and may not steal
    // another team's lead. Admin/manager pass.
    if (repId != null && !repInVisibilityScope(user, Number(repId))) return res.status(403).json({ error: "That rep is not on your team", code: "OUT_OF_SCOPE" });
    const existingLead = storage.getLeadById(Number(req.params.id));
    if (existingLead && (tid == null || existingLead.tenantId === tid) && !canReassignLead(user, existingLead)) {
      return res.status(403).json({ error: "That lead belongs to another team", code: "OUT_OF_SCOPE" });
    }
    // Provenance: reps see WHO routed each door to them, and when.
    const updated = storage.updateLead(Number(req.params.id), {
      assignedRepId: repId ?? null,
      assignedBy: repId ? (user?.name ?? null) : null,
      assignedAt: repId ? new Date().toISOString() : null,
    }, tid);
    if (!updated) return res.status(404).json({ error: "Not found" });
    if (repId) {
      const repName = storage.getTeamMemberById(Number(repId))?.name ?? `rep #${repId}`;
      storage.addLeadEvent(updated.id, "assignment", user?.name ?? null, { assignedTo: repName, assignedBy: user?.name ?? null });
    }
    res.json(stripProviderIds(updated, user));
  });

  // ── Bulk assign leads to a rep (lasso selection) ────────────────────────────
  // POST /api/leads/bulk-assign  { leadIds: number[], repId: number | null }
  app.post("/api/leads/bulk-assign", requireCapability("lead.assign"), async (req, res) => {
    const { leadIds, repId } = req.body as { leadIds: number[]; repId: number | null };
    if (!Array.isArray(leadIds) || leadIds.length === 0) return res.status(400).json({ error: "leadIds required" });
    // WHOLE-TERRITORY ASSIGNMENT. The old per-id loop ran ~3 synchronous
    // statements per lead (SELECT + UPDATE + INSERT) on the one event-loop
    // thread, so it had to be capped at 500 or a big lasso stalled the portal
    // for every user. This path is SET-BASED instead: two statements per chunk
    // regardless of chunk size, so 10,000 leads costs ~40 statements rather
    // than 30,000. Chunks yield the event loop between them, so the portal
    // stays responsive while a whole neighbourhood is handed to a rep.
    if (leadIds.length > MAX_BULK_ASSIGN_LEADS) {
      return res.status(400).json({ error: `Too many leads — select at most ${MAX_BULK_ASSIGN_LEADS.toLocaleString()} at a time`, code: "BULK_TOO_LARGE" });
    }
    const user = (req as any).user;
    const tid = user?.tenantId ?? undefined;
    if (repId != null && !repInVisibilityScope(user, Number(repId))) return res.status(403).json({ error: "That rep is not on your team", code: "OUT_OF_SCOPE" });
    const assignedAt = repId ? new Date().toISOString() : null;
    const assignedBy = repId ? (user?.name ?? null) : null;
    const repName = repId ? (storage.getTeamMemberById(Number(repId))?.name ?? `rep #${repId}`) : null;
    // The same authority rule canReassignLead() enforces per row, expressed
    // once in SQL: admin/manager (undefined scope) may move anything; a
    // team_lead may move only unassigned or own-team leads.
    const scope = leadVisibilityScope(user);
    const scopeSql = scope === undefined
      ? "1=1"
      : `(assigned_rep_id IS NULL${(scope as number[]).length ? ` OR assigned_rep_id IN (${(scope as number[]).map((n) => Number(n) | 0).join(",")})` : ""})`;
    const tenantSql = tid == null ? "1=1" : `tenant_id = ${Number(tid) | 0}`;
    const ids = [...new Set(leadIds.map((v) => Number(v)).filter(Number.isInteger))];
    const eventDetail = JSON.stringify({ assignedTo: repName, assignedBy });
    const CHUNK = 500;
    let updated = 0;

    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => "?").join(",");
      // One transaction per chunk: a stall can never exceed one chunk, and a
      // failure leaves whole chunks applied rather than a half-written row.
      const applyChunk = rawDb.transaction(() => {
        // Assignment events first — they must see the PRE-update rows, and
        // only for leads this caller is actually allowed to move.
        if (repName) {
          rawDb.prepare(
            `INSERT INTO lead_events (lead_id, type, actor, detail, at)
             SELECT id, 'assignment', ?, ?, datetime('now') FROM leads
              WHERE id IN (${placeholders}) AND ${tenantSql} AND ${scopeSql}`,
          ).run(user?.name ?? null, eventDetail, ...chunk);
        }
        return rawDb.prepare(
          `UPDATE leads SET assigned_rep_id = ?, assigned_by = ?, assigned_at = ?,
                  unassigned_at = CASE WHEN ? IS NULL THEN datetime('now') ELSE unassigned_at END,
                  updated_at = datetime('now')
            WHERE id IN (${placeholders}) AND ${tenantSql} AND ${scopeSql}`,
        ).run(repId ?? null, assignedBy, assignedAt, repId ?? null, ...chunk).changes;
      });
      updated += applyChunk.immediate() as number;
      // Yield so /api/health, the Field Map, and every other request keep
      // flowing while a large territory assignment completes.
      if (i + CHUNK < ids.length) await new Promise((resolve) => setImmediate(resolve));
    }
    const skipped = ids.length - updated;
    if (updated > 0) {
      bustMapCache(tid);
      storage.logActivity(user?.id ?? null, "lead.bulk_assign", "lead", undefined,
        { repId, repName, requested: ids.length, updated, skipped }, req.ip);
    }
    res.json({ updated, skipped, repId });
  });

  // POST /api/leads/bulk-status  { leadIds: number[], outcome: KnockOutcome }
  // Sales Rabbit "Modify Status" for a lassoed selection: set many leads to one
  // disposition at once. This is a MANAGER pipeline edit — a plain leadStatus
  // write, tenant + per-lead access scoped like bulk-assign. It deliberately does
  // NOT create a knock (no GPS/history), does NOT create or reverse commissions,
  // and only accepts leadStatus-pure outcomes (see BULK_STATUS_OUTCOMES) so the
  // map always reflects the change.
  app.post("/api/leads/bulk-status", requireCapability("lead.disposition.update"), (req, res) => {
    const { leadIds, outcome } = req.body as { leadIds: number[]; outcome: string };
    if (!Array.isArray(leadIds) || leadIds.length === 0) return res.status(400).json({ error: "leadIds required" });
    if (leadIds.length > MAX_BULK_LEADS) return res.status(400).json({ error: `Too many leads — select at most ${MAX_BULK_LEADS} at a time`, code: "BULK_TOO_LARGE" });
    if (!isBulkStatusOutcome(outcome)) return res.status(400).json({ error: "outcome not allowed for bulk edit" });
    const newStatus = OUTCOME_TO_STATUS[outcome as KnockOutcome];
    const user = (req as any).user;
    const tid = user?.tenantId ?? undefined;
    const apply = rawDb.transaction(() => {
      let updated = 0, skipped = 0;
      for (const raw of leadIds) {
        const id = Number(raw);
        const lead = storage.getLeadById(id);
        // Silently skip cross-tenant or out-of-scope leads (don't leak, don't act) —
        // count them so the UI can be honest about what changed.
        if (!lead || (tid != null && lead.tenantId !== tid) || !repCanAccessLead(user, lead)) { skipped++; continue; }
        if (storage.updateLead(id, { leadStatus: newStatus, lastOutcome: newStatus, lastOutcomeAt: new Date().toISOString() } as any, tid)) updated++;
      }
      return { updated, skipped };
    });
    const { updated, skipped } = apply.immediate();
    if (updated > 0) {
      bustMapCache(tid);
      storage.logActivity(user?.id ?? null, "lead.bulk_status", "lead", undefined, { outcome, leadStatus: newStatus, updated, skipped }, req.ip);
    }
    res.json({ updated, skipped, outcome, leadStatus: newStatus });
  });

  // POST /api/leads/bulk-mark  { leadIds: number[], mark: "priority"|"hold"|null }
  // "Mark leads BEFORE assignment": a manager/team-lead triages a lassoed
  // selection (usually still in the unassigned pool) with a priority/hold mark,
  // or clears it (mark null/""). An assigner action (lead.assign, team_lead+),
  // scoped exactly like bulk-assign (canReassignLead so you can't mark another
  // team's leads), bounded, and atomic. Orthogonal to status/assignment.
  app.post("/api/leads/bulk-mark", requireCapability("lead.assign"), (req, res) => {
    const { leadIds, mark } = req.body as { leadIds: number[]; mark: unknown };
    if (!Array.isArray(leadIds) || leadIds.length === 0) return res.status(400).json({ error: "leadIds required" });
    // Cap the batch: each id runs synchronous SQLite work on the one event-loop
    // thread, so an unbounded array would stall the server for every user.
    if (leadIds.length > 500) return res.status(400).json({ error: "Too many leads — select at most 500 at a time", code: "BULK_TOO_LARGE" });
    if (!isLeadMarkOrClear(mark)) return res.status(400).json({ error: "Invalid mark", code: "INVALID_LEAD_MARK" });
    const value = normalizeLeadMark(mark);
    const user = (req as any).user;
    const tid = user?.tenantId ?? undefined;
    const apply = rawDb.transaction(() => {
      let updated = 0, skipped = 0;
      for (const raw of leadIds) {
        const id = Number(raw);
        const lead = storage.getLeadById(id);
        // Skip cross-tenant / out-of-scope leads silently (don't leak, don't act);
        // sameTenant is the shared tenant wall, canReassignLead the bulk-assign scope.
        if (!sameTenant(lead, tid) || !canReassignLead(user, lead!)) { skipped++; continue; }
        if (storage.updateLead(id, { assignMark: value } as any, tid)) updated++;
      }
      return { updated, skipped };
    });
    const { updated, skipped } = apply.immediate();
    if (updated > 0) {
      bustMapCache(tid);
      storage.logActivity(user?.id ?? null, "lead.bulk_mark", "lead", undefined, { mark: value, updated, skipped }, req.ip);
    }
    res.json({ updated, skipped, mark: value });
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
    storage.updateLead(lead.id, enrichmentUpdate as any);

    res.json({
      ownerName: ownerName ?? lead.ownerName ?? null,
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
    const { ownerName, ownerEmail, yearsAtAddress, isHomeowner } = req.body;
    if (req.body?.ownerPhone != null || req.body?.contactPhone != null) {
      return res.status(400).json({
        error: "Phone data must be added through the Calling compliance module.",
        code: "CALLING_MODULE_REQUIRED",
      });
    }
    const lead = storage.getLeadById(Number(req.params.id));
    const _euser = (req as any).user;
    const _etid = _euser?.tenantId;
    if (!lead || (_etid && lead.tenantId !== _etid)) return res.status(404).json({ error: "Not found" });
    // Team scope: a team_lead may only enrich leads they can access (own team) —
    // matches the enrichment GET's scope; managers/admins pass.
    if (!repCanAccessLead(_euser, lead)) return res.status(404).json({ error: "Not found" });
    const updated = storage.updateLead(lead.id, {
      ownerName: ownerName ?? lead.ownerName,
      ownerEmail: ownerEmail ?? lead.ownerEmail,
      yearsAtAddress: yearsAtAddress ?? lead.yearsAtAddress,
      isHomeowner: isHomeowner ?? lead.isHomeowner,
    } as any);
    if (!updated) return res.status(404).json({ error: "Not found" });
    res.json(stripProviderIds(updated, (req as any).user));
  });

  // ── Knock log ────────────────────────────────────────────────────────────────
  app.get("/api/leads/:id/knocks", requireCapability("field.app.use"), (req, res) => {
    const user = (req as any).user;
    // Tenant wall for EVERY role (a manager/team_lead of tenant A must not read
    // tenant B's knock history by guessing an id), then rep-scope on top.
    const _ktid = user?.tenantId;
    const _klead = storage.getLeadById(Number(req.params.id));
    if (!_klead || (_ktid && _klead.tenantId !== _ktid)) return res.status(404).json({ error: "Not found" });
    if (!repCanAccessLead(user, _klead)) return res.status(404).json({ error: "Not found" });
    // History rows carry who made the change — the card renders "Sold · 3:12 PM
    // · M. Muhammad" without a second round-trip per row.
    const rows = storage.getKnocksByLead(Number(req.params.id)).map(k => ({
      ...k,
      repName: (k.repId != null ? storage.getTeamMemberById(k.repId)?.name : null) ?? null,
    }));
    res.json(rows);
  });

  // Lead-level notes, rep-writable. The manager PATCH /api/leads/:id stays
  // manager-only; this narrow endpoint writes ONLY `notes`, guarded the same
  // fail-closed way as every other rep lead access (404, never 403).
  // Conflict-safe: the client sends the lead `updatedAt` it loaded (base
  // version); if another device saved a different note since, respond 409 with
  // the server copy so the client can merge instead of silently overwriting.
  app.patch("/api/leads/:id/notes", requireCapability("lead.note.write"), (req, res) => {
    const user = (req as any).user;
    const notes = req.body?.notes;
    const baseUpdatedAt = typeof req.body?.baseUpdatedAt === "string" ? req.body.baseUpdatedAt : null;
    if (typeof notes !== "string" || notes.length > 2000) return res.status(400).json({ error: "notes must be a string ≤2000 chars" });
    const lead = storage.getLeadById(Number(req.params.id));
    const _ntid = user?.tenantId;
    // Tenant wall for EVERY role — this is a WRITE; a cross-tenant note edit must 404.
    if (!lead || (_ntid && lead.tenantId !== _ntid)) return res.status(404).json({ error: "Not found" });
    if (!repCanAccessLead(user, lead)) return res.status(404).json({ error: "Not found" });
    if (notes === (lead.notes ?? "")) return res.json({ id: lead.id, notes, updatedAt: lead.updatedAt }); // no-op: no write, no event
    if (baseUpdatedAt && lead.updatedAt && lead.updatedAt > baseUpdatedAt && (lead.notes ?? "") !== "") {
      return res.status(409).json({ error: "conflict", serverNotes: lead.notes ?? "", updatedAt: lead.updatedAt });
    }
    const updated = storage.updateLead(lead.id, { notes });
    // Note events join the lead's unified history with a short preview.
    const preview = notes.trim().slice(0, 100);
    if (preview) storage.addLeadEvent(lead.id, "note", user?.name ?? null, { preview });
    storage.logActivity(user?.id ?? null, "lead.note_updated", "lead", lead.id, {}, req.ip);
    res.json({ id: lead.id, notes: updated?.notes ?? notes, updatedAt: updated?.updatedAt ?? null });
  });

  // ── Unified lead history — one timeline for the card ────────────────────────
  // status_change rows come from knock_log; assignment + note rows from
  // lead_events. Merged, newest first, capped — append-only sources make each
  // read one indexed scan per table, no joins.
  app.get("/api/leads/:id/history", requireCapability("field.app.use"), (req, res) => {
    const user = (req as any).user;
    const lead = storage.getLeadById(Number(req.params.id));
    const _htid = user?.tenantId;
    // Tenant wall for EVERY role (history leaks rep GPS + outcomes cross-tenant).
    if (!lead || (_htid && lead.tenantId !== _htid)) return res.status(404).json({ error: "Not found" });
    if (!repCanAccessLead(user, lead)) return res.status(404).json({ error: "Not found" });
    // One indexed team scan → O(1) name lookups per row (not a query per knock).
    const repNames = new Map(storage.getTeamMembers().map(m => [m.id, m.name]));
    const statusRows = storage.getKnocksByLead(lead.id).map(k => ({
      id: `k${k.id}`,
      knockId: k.id,
      type: "status_change" as const,
      actor: (k.repId != null ? repNames.get(k.repId) : null) ?? null,
      changedAt: k.knockedAt,
      status: k.outcome,
      // ── Location verification (distance WHEN MARKED — never recomputed live) ──
      verification: k.verificationStatus ?? null,        // verified|needs_review|invalid|null(legacy)
      distanceM: k.distanceM ?? null,                    // metres from the lead at mark time
      gpsAccuracyM: k.gpsAccuracy ?? null,
      reviewReason: k.reviewReason ?? null,
      deviceTs: k.deviceTs ?? null,
      serverTs: k.serverTs ?? null,
      netState: k.netState ?? null,
      // Coordinate pair for the History map preview (rep pin + lead pin + line).
      repLat: k.repLat ?? null, repLng: k.repLng ?? null,
      leadLat: lead.lat ?? null, leadLng: lead.lng ?? null,
    }));
    const eventRows = storage.getLeadEvents(lead.id).map(e => ({
      id: `e${e.id}`,
      type: e.type as "assignment" | "note",
      actor: e.actor,
      changedAt: e.at,
      assignedTo: e.detail?.assignedTo ?? undefined,
      assignedBy: e.detail?.assignedBy ?? undefined,
      notePreview: e.detail?.preview ?? undefined,
    }));
    // Legacy bridge: leads noted before lead_events existed still surface their
    // note in the timeline (the composer UI clears the field after save, so
    // history is the ONLY place a note is read).
    if ((lead.notes ?? "").trim() && !eventRows.some(e => e.type === "note")) {
      eventRows.push({
        id: "legacy-note",
        type: "note" as const,
        actor: null,
        changedAt: lead.updatedAt ?? lead.createdAt ?? new Date(0).toISOString(),
        assignedTo: undefined,
        assignedBy: undefined,
        notePreview: (lead.notes ?? "").trim().slice(0, 100),
      });
    }
    const merged = [...statusRows, ...eventRows]
      .sort((a, b) => (a.changedAt < b.changedAt ? 1 : a.changedAt > b.changedAt ? -1 : 0))
      .slice(0, 100);
    res.json(merged);
  });
  // CENTRAL DISPOSITION (owner ask 2026-07-26): managers/team-leads/admins mark
  // a lead's outcome on behalf of the CENTRAL team — no rep credit, no knock
  // row, no commission. For the field workflow where management adds pins and
  // later clears/qualifies them centrally (e.g. area turned out not to be new
  // fiber). Server-authoritative status flip + activity audit.
  app.post("/api/leads/:id/central-disposition", requireManager, (req, res) => {
    const u = (req as any).user;
    const lead = storage.getLeadById(Number(req.params.id));
    if (!lead) return res.status(404).json({ error: "Not found" });
    if (u?.role !== "super_admin" && u?.tenantId != null && lead.tenantId != null && lead.tenantId !== u.tenantId) {
      return res.status(404).json({ error: "Not found" });
    }
    if (!isKnockOutcome(req.body?.outcome)) return res.status(400).json({ error: "invalid outcome" });
    const outcome = req.body.outcome as KnockOutcome;
    const newStatus = OUTCOME_TO_STATUS[outcome];
    const at = new Date().toISOString();
    const updated = storage.updateLead(lead.id, {
      leadStatus: newStatus,
      lastOutcome: outcome,
      lastOutcomeAt: at,
    } as any, u?.tenantId ?? undefined);
    if (!updated) return res.status(500).json({ error: "Update failed" });
    // Owner ask: a central mark MUST appear in the lead's History timeline.
    // Record a knock row flagged as central (no door contact — wasHome false),
    // credited to the acting manager's member id (or the lead's assigned rep,
    // or the tenant's first active member as a last resort).
    try {
      let centralRepId: number | null = u?.teamMemberId ?? lead.assignedRepId ?? null;
      if (centralRepId == null) {
        centralRepId = storage.getTeamMembers(lead.tenantId ?? u?.tenantId ?? undefined).find((m: any) => m.active)?.id ?? null;
      }
      if (centralRepId != null) {
        storage.createKnock({
          leadId: lead.id,
          repId: centralRepId,
          outcome,
          wasHome: false,
          notes: `[central] ${u?.name ?? "central"}`,
          knockedAt: at,
        } as any);
      }
    } catch (e: any) { console.warn("[central] history knock row skipped:", e?.message); }
    try {
      storage.logActivity(u?.id ?? null, "lead.central_disposition", "lead", lead.id,
        { outcome, newStatus, markedBy: u?.name ?? "central", address: lead.address }, req.ip, u?.tenantId ?? null);
    } catch { /* audit is best-effort */ }
    res.json({ ...updated, central: true });
  });

  // Any authenticated rep can log a knock
  app.post("/api/leads/:id/knock", requireCapability("lead.disposition.update"), (req, res) => {
    const _knu = (req as any).user;
    // Tenant wall for EVERY role (super_admin exempt): you can only knock leads
    // in your own org — a manager must not flip another tenant's lead.
    {
      const _knl = storage.getLeadById(Number(req.params.id));
      if (!_knl) return res.status(404).json({ error: "Not found" });
      if (_knu?.role !== "super_admin" && _knu?.tenantId != null && _knl.tenantId != null && _knl.tenantId !== _knu.tenantId) {
        return res.status(404).json({ error: "Not found" });
      }
      // Reps can only log knocks on leads assigned to them
      if (!repCanAccessLead(_knu, _knl)) return res.status(404).json({ error: "Not found" });
    }
    // Idempotency: the offline queue retries with the same clientId after a lost
    // response. If we've already logged this knock, return the existing row and
    // skip ALL side effects (status flip, cache bust, commission, activity log).
    // better-sqlite3 is synchronous per-process so SELECT-then-INSERT is race-free;
    // the partial unique index on client_id is the backstop.
    // GATE (heal rework): the WHOLE money bundle is one reusable immediate
    // transaction, shared by the first-pass path and the dedupe-replay heal.
    // It is idempotent end-to-end: self-tolerant CAS + ledger upsert +
    // unique-catch commission + conditional removal.
    const runMoneyBundle = (leadId: number, knockRow: any, outcome: KnockOutcome, knockedAt: string) => rawDb.transaction(() => {
      const flipStatus = OUTCOME_TO_STATUS[outcome];
      let sup = false;
      if (flipStatus) {
        sup = !storage.applyKnockOutcomeCas(leadId, flipStatus, outcome, knockedAt);
      }
      // ── WEEKLY COMMISSION ENGINE (authoritative pay system) ────────────────
      if (!sup && knockRow.repId) {
        const saleTenant = knockRow.tenantId ?? (req as any).user?.tenantId ?? getDefaultTenantId();
        if (saleTenant != null) {
          if (outcome === "sold") {
            commissionSvc.recordFieldSaleFromKnock({
              tenantId: saleTenant, repId: knockRow.repId, leadId,
              knockId: knockRow.id, soldAt: knockRow.knockedAt || serverTs, actorId: (req as any).user?.id ?? null,
            });
          } else {
            commissionSvc.reverseFieldSale(saleTenant, leadId, (req as any).user?.id ?? null);
          }
        }
      }
      // Auto-create pending commission when outcome = sold (rate snapshot frozen
      // onto the record; P0-3 org-scoped rates; P0-6 server-fixed basis 0).
      if (!sup && outcome === "sold" && knockRow.repId) {
        const rep = storage.getTeamMemberById(knockRow.repId);
        const saleDate = new Date().toISOString().slice(0, 10);
        const rateTenant = knockRow.tenantId ?? (req as any).user?.tenantId ?? getDefaultTenantId() ?? undefined;
        const structures = storage.getCommissionRates(rateTenant).map(rateToStructure);
        const active = pickActiveStructure(structures, knockRow.repId, rep?.role ?? null, saleDate);
        if (active) {
          const saleAmount = 0;
          const calc = calcCommission(active, saleAmount);
          storage.createCommission({
            repId: knockRow.repId,
            leadId,
            knockId: knockRow.id,
            amount: calc.amount,
            saleDate,
            status: "pending",
            notes: `Auto: knock #${knockRow.id} · ${describeStructure(active)}`,
            approvedBy: null,
            paidDate: null,
            structureId: active.id,
            structureVersion: active.version,
            calcType: calc.calcType,
            saleAmount: saleAmount || null,
          } as any);
        }
      } else if (!sup && knockRow.repId) {
        // Un-marking a sale: pull the auto-created PENDING commission.
        // Approved/paid rows are left alone (a clawback is a manager action).
        storage.removePendingCommissionsForLead(leadId);
      }
      return sup;
    });
    const serverTs = new Date().toISOString();
    const clientId = typeof req.body?.clientId === "string" && req.body.clientId ? req.body.clientId : null;
    if (clientId) {
      const existing = storage.getKnockByClientId(clientId);
      if (existing) {
        // GATE (heal rework): the replay re-runs the FULL money bundle — the same
        // immediate transaction as the first pass (self-tolerant CAS + ledger +
        // commission + removal). A mid-crash knock heals completely; a knock
        // that was legitimately superseded by a newer outcome re-supersedes and
        // resurrects NOTHING.
        if (existing.leadId !== Number(req.params.id)) return res.status(404).json({ error: "Not found" });
        try {
          const healed = runMoneyBundle(Number(req.params.id), existing, (existing as any).outcome as KnockOutcome, (existing as any).knockedAt || serverTs).immediate();
          if (healed !== !!(existing as any).superseded) {
            rawDb.prepare("UPDATE knock_log SET superseded = ? WHERE id = ?").run(healed ? 1 : 0, existing.id);
          }
          return res.status(200).json({ ...existing, deduped: true, superseded: healed || undefined });
        } catch (e: any) {
          console.warn("[knock] dedupe-heal failed:", e?.message);
          return res.status(200).json({ ...existing, deduped: true, superseded: (existing as any).superseded ? true : undefined });
        }
      }
    }
    if (!isKnockOutcome(req.body?.outcome)) return res.status(400).json({ error: "invalid outcome" });
    // wasHome is DERIVED from the outcome — never trust the client's value.
    // A rep can ONLY ever credit THEMSELVES: force repId to their own team-member
    // id so a rep can never log a knock (or its commission) for another person.
    // Managers/leads/admins may still credit any rep (bulk logging, ride-alongs).
    const forcedRepId = _knu?.role === "rep" ? _knu.teamMemberId : req.body?.repId;
    // A non-rep may credit ANOTHER rep (ride-alongs / bulk logging) but only within
    // their tenant AND visibility scope — a team_lead can't credit another team's
    // rep, and nobody can credit a rep in another tenant (would forge that rep's
    // activity + commission).
    if (_knu?.role !== "rep" && forcedRepId != null &&
        !(repInCallerTenant(_knu, Number(forcedRepId)) && repInVisibilityScope(_knu, Number(forcedRepId)))) {
      return res.status(403).json({ error: "You can't log a knock for that rep" });
    }
    const parsed = insertKnockSchema.safeParse({
      ...req.body,
      leadId: Number(req.params.id),
      wasHome: deriveWasHome(req.body.outcome),
      clientId,
      repId: forcedRepId,
    });
    if (!parsed.success) return res.status(400).json({ error: parsed.error });

    // ── Location verification (server-authoritative — the client's GPS is only
    // evidence; distance + verdict are computed HERE and cannot be forged). ────
    const lead = storage.getLeadById(Number(req.params.id));
    const b = req.body ?? {};
    const geoConfig = storage.getGeoConfig((req as any).user?.tenantId ?? null);
    // The rep's previous located knock, for impossible-travel detection.
    const repId = parsed.data.repId;
    let prev: { lat: number; lng: number; at: string } | null = null;
    if (typeof repId === "number") {
      const prior = storage.getKnocksByRep(repId)
        .filter(k => k.repLat != null && k.repLng != null && (k.deviceTs || k.knockedAt))
        .sort((a, z) => ((z.deviceTs ?? z.knockedAt) < (a.deviceTs ?? a.knockedAt) ? -1 : 1))[0];
      if (prior) prev = { lat: prior.repLat as number, lng: prior.repLng as number, at: (prior.deviceTs ?? prior.knockedAt) as string };
    }
    const verdict = classifyKnockLocation({
      repLat: typeof b.repLat === "number" ? b.repLat : null,
      repLng: typeof b.repLng === "number" ? b.repLng : null,
      gpsAccuracyM: typeof b.gpsAccuracy === "number" ? b.gpsAccuracy : null,
      leadLat: lead?.lat ?? null,
      leadLng: lead?.lng ?? null,
      deviceTs: typeof b.deviceTs === "string" ? b.deviceTs : parsed.data.knockedAt ?? null,
      serverTs,
      mockLocation: b.mockLocation === true,
      netState: b.netState === "offline" ? "offline" : b.netState === "online" ? "online" : null,
      prev,
    }, geoConfig);

    const knock = storage.createKnock(parsed.data, {
      serverTs,
      distanceM: verdict.distanceM,
      verificationStatus: verdict.status,
      reviewReason: verdict.reasons.length ? verdict.reasons.join(";") : null,
    });
    // Update lead status to match knock outcome — shared map covers all 7 outcomes
    // (incl. follow_up→follow_up, needs_verification→contacted) and cannot drift
    // from the client, which imports the same module.
    //
    // P1-1: the flip is a COMPARE-AND-SET on outcome recency. A stale offline
    // knock (its knockedAt predates the lead's last_outcome_at) LOSES the CAS:
    // no status flip and NONE of the money side effects below fire (no sale
    // reversal, no commission removal, no new commission). The knock row itself
    // is still recorded as field history; the response carries
    // `superseded: true` so the client can distinguish it from an applied knock.
    // REVIEWER GATE (all 5 reviewers, unanimous): the CAS clock must never come
    // raw from the client. A forged-future knockedAt (or skewed phone) used to
    // win every future CAS on the lead — freezing it sold with an irreversible
    // commission. Clamp: valid ISO, not future beyond 10min skew (geoVerify's
    // constant), else fall back to server time.
    const clientTs = typeof parsed.data.knockedAt === "string" ? Date.parse(parsed.data.knockedAt) : NaN;
    const knockedAtTs = (Number.isFinite(clientTs) && clientTs <= Date.now() + 10 * 60_000)
      ? parsed.data.knockedAt!
      : serverTs;
    let superseded = false;
    // REVIEWER GATE (concurrency BLOCKER + dedupe-heal): the outcome CAS and
    // every money side effect run as ONE immediate transaction — no crash or
    // cross-process interleaving can strand a commission on an un-sold door
    // (both proven live by the red team). The same bundle is reused by the
    // dedupe-replay path below, which is how a mid-crash knock HEALS on retry
    // instead of dying unrepairable.

    try {
      superseded = runMoneyBundle(Number(req.params.id), knock, parsed.data.outcome as KnockOutcome, knockedAtTs).immediate();
    } catch (e: any) {
      // The bundle is atomic — a money-engine failure rolls the CAS back too,
      // so nothing is half-applied. The knock row stands as history; the client
      // retry re-runs the whole bundle idempotently.
      console.warn("[knock] money bundle failed:", e?.message);
      return res.status(503).json({ error: "Could not apply the outcome — retry", retryable: true });
    }
    // A knock changes the pin's visited state even when leadStatus is unchanged
    // (not_home) — bust this org's map layer explicitly.
    bustMapCache((req as any).user?.tenantId ?? undefined);
    // ── Commission audit (post-commit; never blocks the knock) ───────────────
    if (!superseded && parsed.data.outcome === "sold" && parsed.data.repId) {
      try {
        const rep = storage.getTeamMemberById(parsed.data.repId);
        const rateTenant = knock.tenantId ?? (req as any).user?.tenantId ?? getDefaultTenantId() ?? undefined;
        const structures = storage.getCommissionRates(rateTenant).map(rateToStructure);
        const active = pickActiveStructure(structures, parsed.data.repId, rep?.role ?? null, new Date().toISOString().slice(0, 10));
        if (active) {
          storage.logActivity((req as any).user?.id ?? null, "commission.auto_created", "knock", knock.id,
            { repId: parsed.data.repId, leadId: Number(req.params.id), structureId: active.id, version: active.version }, req.ip);
        } else {
          storage.logActivity((req as any).user?.id ?? null, "commission.no_structure", "knock", knock.id,
            { repId: parsed.data.repId, leadId: Number(req.params.id) }, req.ip);
        }
      } catch { /* audit is best-effort */ }
    }
    // REVIEWER GATE: persist the CAS result ON the knock row — retries,
    // history, and counters can all tell the truth (it was previously
    // ephemeral: only the live response knew it).
    rawDb.prepare("UPDATE knock_log SET superseded = ? WHERE id = ?").run(superseded ? 1 : 0, knock.id);
    storage.logActivity((req as any).user?.id ?? null, `knock.${parsed.data.outcome}`, "knock", knock.id,
      { leadId: Number(req.params.id), repId: parsed.data.repId, verification: verdict.status, distanceM: verdict.distanceM, serverTs, superseded }, req.ip);
    // P1-1: a superseded (stale) knock is recorded as history but applied to
    // NOTHING — 200 + marker distinguishes it from an applied knock (201).
    if (superseded) return res.status(200).json({ ...knock, superseded: true });
    res.status(201).json(knock);
  });

  // Note typed AFTER the knock saved — attaches to the existing knock row without
  // re-picking the outcome. Only `notes` is writable; reps can only annotate
  // their own knocks (fail-closed 404, same shape as the lead guard).
  app.patch("/api/knocks/:id", requireCapability("lead.note.write"), (req, res) => {
    const user = (req as any).user;
    const notes = req.body?.notes;
    if (typeof notes !== "string" || notes.length > 2000) return res.status(400).json({ error: "notes must be a string ≤2000 chars" });
    const knock = storage.getKnockById(Number(req.params.id));
    if (!knock) return res.status(404).json({ error: "Not found" });
    // Tenant wall for EVERY role (this is a WRITE and the row carries rep GPS):
    // resolve the knock's lead and 404 across tenants.
    const _ktid = user?.tenantId;
    const _klead = knock.leadId != null ? storage.getLeadById(knock.leadId) : null;
    if (_ktid && _klead && _klead.tenantId !== _ktid) return res.status(404).json({ error: "Not found" });
    if (user?.role === "rep" && knock.repId !== user.teamMemberId) return res.status(404).json({ error: "Not found" });
    const updated = storage.updateKnockNotes(knock.id, notes);
    storage.logActivity(user?.id ?? null, "knock.note_updated", "knock", knock.id, { leadId: knock.leadId }, req.ip);
    res.json(updated);
  });

  // ── Leaderboard ──────────────────────────────────────────────────────────────
  app.get("/api/leaderboard", requireAuth, (req, res) => {
    // Date-range filter: ?range=7d|30d|1y|today|all (presets), or a custom window
    // ?since=YYYY-MM-DD&until=YYYY-MM-DD. Computed server-side so the client only
    // sends intent; counts below reflect the chosen window (all-time by default).
    const window = (() => {
      const range = String(req.query.range ?? "").toLowerCase();
      const dayMs = 86400000;
      const now = Date.now();
      const back = (days: number) => new Date(now - days * dayMs).toISOString();
      if (range === "today") { const m = new Date(); m.setHours(0, 0, 0, 0); return { since: m.toISOString() }; }
      if (range === "7d") return { since: back(7) };
      if (range === "30d") return { since: back(30) };
      if (range === "1y") return { since: back(365) };
      if (range === "custom" || req.query.since || req.query.until) {
        const s = String(req.query.since ?? ""), u = String(req.query.until ?? "");
        const ok = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);
        return {
          since: ok(s) ? new Date(s + "T00:00:00").toISOString() : undefined,
          until: ok(u) ? new Date(u + "T23:59:59.999").toISOString() : undefined,
        };
      }
      return undefined; // all-time
    })();
    // Scope to the caller's tenant and project to non-PII fields ONLY — the
    // leaderboard is visible to reps, so it must never carry email/phone/org
    // structure. Rankings need id/name/role + the counts, nothing more.
    const tid = (req as any).user?.tenantId ?? undefined;
    const rows = storage.getLeaderboard(window, tid)   // tenant-scoped in SQL now
      .map(r => ({
        rep: { id: r.rep.id, name: r.rep.name, role: (r.rep as any).role ?? "rep" },
        knocks: r.knocks, contacts: r.contacts, callbacks: r.callbacks, sales: r.sales,
        knocksToday: r.knocksToday, salesToday: r.salesToday,
      }));
    res.json(rows);
  });

  // ── Follow-ups — open scheduled callbacks the caller owns ────────────────────
  // Closes the loop the OutcomeSheet opens: every "callback" a rep schedules
  // surfaces here (grouped Overdue/Today/Upcoming client-side) until the door is
  // re-worked. Tenant-scoped in SQL; then rep-scoped so a rep sees only callbacks
  // they set or on leads assigned to them, and a team_lead only their team's.
  app.get("/api/followups", requireAuth, (req, res) => {
    const user = (req as any).user;
    const tid = user?.tenantId ?? undefined; // super_admin (null) = all tenants
    const rows = storage.getOpenCallbacks(tid);
    const scope = leadVisibilityScope(user); // undefined = org-wide (admin/manager)
    const scoped = Array.isArray(scope)
      ? rows.filter(r => scope.includes(r.repId) || (r.assignedRepId != null && scope.includes(r.assignedRepId)))
      : rows;
    res.json(scoped);
  });

  // ── Rep activity — the dashboard's rep card ──────────────────────────────────
  // Recent dispositions for one rep, timestamped, with the door they happened
  // at. Reps may read ONLY their own activity; team lead+ may read anyone's
  // (fail-closed 404, matching every other rep-scoped read).
  app.get("/api/team/:id/activity", requireAuth, (req, res) => {
    const user = (req as any).user;
    const repId = Number(req.params.id);
    const isSelf = user?.teamMemberId === repId;
    const canViewOthers = ["admin", "manager", "team_lead"].includes(user?.role);
    if (!isSelf && !canViewOthers) return res.status(404).json({ error: "Not found" });
    // Viewing another rep must stay inside the caller's tenant AND (for a
    // team_lead) their own team — otherwise repId is an incrementing IDOR that
    // discloses any rep's identity + knock outcomes across orgs.
    if (!isSelf) {
      if (!repInCallerTenant(user, repId)) return res.status(404).json({ error: "Not found" });
      if (!repInVisibilityScope(user, repId)) return res.status(404).json({ error: "Not found" });
    }
    const rep = storage.getTeamMemberById(repId);
    if (!rep) return res.status(404).json({ error: "Not found" });
    // Capped, newest-first (getKnocksByRep is unordered — id desc = insertion
    // order reversed, no date parsing); one pass to join addresses via a Map.
    const knocks = storage.getKnocksByRep(repId).sort((a, b) => b.id - a.id).slice(0, 50);
    const leadIds = new Set(knocks.map(k => k.leadId));
    const addr = new Map(
      storage.getLeads(user?.tenantId ?? undefined)
        .filter(l => leadIds.has(l.id))
        .map(l => [l.id, `${l.address}, ${l.city}`]),
    );
    res.json({
      rep: { id: rep.id, name: rep.name, role: rep.role },
      events: knocks.map(k => ({
        id: k.id,
        outcome: k.outcome,
        at: k.knockedAt,
        address: addr.get(k.leadId) ?? null,
      })),
    });
  });

  // Stats
  app.get("/api/stats", requireAuth, (req, res) => {
    const _su = (req as any).user;
    const all = storage.getLeads(_su?.tenantId ?? undefined, leadVisibilityScope(_su));
    const stats: any = {
      total: all.length,
      assigned: 0,
      unassigned: 0,
      qualified: 0,
      stale: 0,
      byStatus: {},
      byFiberStatus: {},
      byRep: {},
      byTerritory: {},
      newFiber: 0,
      tenured: 0,
      sold: 0,
    };
    const staleBefore = Date.now() - 14 * 86_400_000;
    for (const l of all) {
      stats.byStatus[l.leadStatus] = (stats.byStatus[l.leadStatus] || 0) + 1;
      stats.byFiberStatus[l.fiberStatus] = (stats.byFiberStatus[l.fiberStatus] || 0) + 1;
      if (l.isNewFiber) stats.newFiber++;
      if (l.isTenured) stats.tenured++;
      if (l.leadStatus === "sold") stats.sold++;
      if (l.assignedRepId == null) stats.unassigned++;
      else {
        stats.assigned++;
        stats.byRep[String(l.assignedRepId)] = (stats.byRep[String(l.assignedRepId)] || 0) + 1;
      }
      if (l.leadStatus === "interested" || l.leadStatus === "sold") stats.qualified++;
      const activityAt = Date.parse(l.updatedAt || l.createdAt || "");
      if (Number.isFinite(activityAt) && activityAt < staleBefore && !["sold", "not_interested"].includes(l.leadStatus)) stats.stale++;
      const territory = [l.city, l.state].filter(Boolean).join(", ");
      if (territory) stats.byTerritory[territory] = (stats.byTerritory[territory] || 0) + 1;
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
    // Set when the session is intact but the ACCOUNT was deactivated — a rep the
    // team lead / manager / admin kicked. This endpoint is the client's
    // authority on "is my session still real?", so it must apply the SAME active
    // check requireAuth does: reporting a kicked member as signed-in would leave
    // them in an app where every action 401s but nothing sends them to Login.
    // Distinguishing it from a plain expiry also lets the client say why.
    let accessRevoked = false;
    if (token) {
      const session = storage.getSession(token);
      if (session) {
        const u = storage.getUserById(session.userId);
        // isSuperAdmin ships WITH the user on every hydration. The Central Admin
        // route gated on the email string matched against a SEPARATELY fetched
        // allowlist, so after a refresh the console vanished (or flashed and
        // redirected) whenever that second request was slow, failed, or had been
        // evicted from cache — the identity the server already knew was simply
        // never told to the client. It is now part of the session payload.
        if (u && u.active) {
          currentUser = {
            id: u.id, name: u.name, email: u.email, role: u.role,
            teamMemberId: u.teamMemberId, tenantId: (u as any).tenantId ?? null,
            isSuperAdmin: Boolean((u as any).isSuperAdmin),
          };
        } else if (u) {
          accessRevoked = true;
          // Self-healing: a deactivated account should not keep session rows
          // alive. Converges even if some future path forgets to revoke.
          storage.deleteSessionsByUser(u.id);
        }
      }
    }
    res.json({ isFirstRun, currentUser, accessRevoked });
  });

  // ── Current tenant (org) — name/branding for the caller's organization ──────
  app.get("/api/tenant/me", requireAuth, (req, res) => {
    const user = (req as any).user;
    const tenantId = user?.tenantId ?? getDefaultTenantId();
    const t = tenantId != null ? storage.getTenantById(tenantId) : undefined;
    if (!t) return res.json({ tenant: null });
    // Branding only — never billing/keys/secrets.
    res.json({ tenant: { id: t.id, companyName: t.companyName, brandName: t.brandName, brandColor: t.brandColor, tagline: t.tagline, plan: t.plan } });
  });

  // ── Rate limiting maps (in-memory, per IP + per email) ───────────────────────
  // Tracks: { attempts, firstAttempt, lockedUntil }
  const otpRequestLimiter = new Map<string, { count: number; windowStart: number; lockedUntil: number }>();
  const otpVerifyLimiter  = new Map<string, { count: number; windowStart: number; lockedUntil: number }>();

  const OTP_REQUEST_EMAIL_MAX = 5;  // strict account-specific send cap
  const OTP_VERIFY_EMAIL_MAX  = 5;  // strict account-specific guess cap
  const OTP_REQUEST_IP_MAX   = 50;  // shared office/cellular NAT safety
  const OTP_VERIFY_IP_MAX    = 50;
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
    const ip = (req.ip ?? req.socket.remoteAddress ?? "unknown");
    const ipCheck = checkRateLimit(otpRequestLimiter, `ip:${ip}`, OTP_REQUEST_IP_MAX);
    const emailCheck = checkRateLimit(otpRequestLimiter, `email:${cleanEmail}`, OTP_REQUEST_EMAIL_MAX);
    if (!ipCheck.allowed || !emailCheck.allowed) {
      const retryAfter = Math.max(ipCheck.retryAfter ?? 0, emailCheck.retryAfter ?? 0);
      res.setHeader("Retry-After", String(retryAfter));
      storage.logLoginAttempt(cleanEmail, "request", false, "rate_limited", ip, req.headers["user-agent"] as string, (req as any).user?.tenantId ?? null);
      return res.status(429).json({ error: `Too many requests. Try again in ${Math.ceil(retryAfter / 60)} minutes.` });
    }
    // Owner's decision (2026-07-08): this is a closed internal team tool, so an
    // unknown email gets an explicit 404 ("contact your manager") instead of the
    // neutral anti-enumeration response — field reps kept assuming a silent
    // "sent" meant a mail delay. The enumeration surface stays bounded by the
    // dual per-IP AND per-email rate limits above; a public-facing app should
    // flip this back to the constant response.
    const user = storage.getUserByEmail(cleanEmail);
    if (!user || !user.active) {
      storage.logLoginAttempt(cleanEmail, "request", false, user ? "account_inactive" : "unknown_email", ip, req.headers["user-agent"] as string, user?.tenantId ?? null);
      // Neutral response — do NOT reveal whether an email is registered/active
      // (account enumeration). A real user gets a code; anyone else gets the same
      // "sent" with no email actually dispatched.
      return res.json({ sent: true });
    }
    const code = storage.createOtp(cleanEmail);
    let delivery: "email" | "console" | "failed" = "failed";
    try {
      delivery = await sendOtpEmail(cleanEmail, code, user.name);
    } catch (mailErr: any) {
      // Mail delivery down (e.g. provider daily-quota 429). Do NOT hard-block login:
      // the code is ALREADY generated and stored, and email is only the DELIVERY
      // channel. A 502 here strands every user on the email step with no code field
      // (Login.tsx only advances to code entry on a 2xx) — a mail outage becomes a
      // total lockout. Advance the flow instead (sent:true, emailDelivered:false) so a
      // code obtained through any working channel still verifies, and the client can
      // warn that the email may be delayed. The code is NEVER returned in the API
      // response in production — email remains the only automated delivery path.
      console.warn("[otp] mail delivery failed; advancing login flow anyway:", mailErr?.message);
      storage.logLoginAttempt(cleanEmail, "request", true, "code_created_mail_failed", ip, req.headers["user-agent"] as string, user?.tenantId ?? null);
      return res.json({ sent: true, emailDelivered: false });
    }
    storage.logLoginAttempt(cleanEmail, "request", true, "code_sent", ip, req.headers["user-agent"] as string, user?.tenantId ?? null);
    // Localhost must remain usable without a paid mail account. The code is
    // returned only in non-production when delivery fell back to the console;
    // production can never expose an authentication secret in an API response.
    res.json({
      sent: true,
      emailDelivered: true,
      ...(process.env.NODE_ENV !== "production" && delivery === "console" ? { developmentCode: code } : {}),
    });
  });

  // Step 2: Verify OTP code
  app.post("/api/auth/otp/verify", (req, res) => {
    const { email, code } = req.body;
    if (!email || typeof email !== "string" || email.length > 254) return res.status(400).json({ error: "Invalid request" });
    if (!code || typeof code !== "string" || !/^\d{6}$/.test(code.trim())) return res.status(400).json({ error: "Code must be 6 digits" });
    const cleanEmail = email.trim().toLowerCase();
    // Rate limit verify attempts per email
    const ip = (req.ip ?? req.socket.remoteAddress ?? "unknown");
    const ipCheck = checkRateLimit(otpVerifyLimiter, `ip:${ip}`, OTP_VERIFY_IP_MAX);
    const emailCheck = checkRateLimit(otpVerifyLimiter, `email:${cleanEmail}`, OTP_VERIFY_EMAIL_MAX);
    if (!ipCheck.allowed || !emailCheck.allowed) {
      const retryAfter = Math.max(ipCheck.retryAfter ?? 0, emailCheck.retryAfter ?? 0);
      res.setHeader("Retry-After", String(retryAfter));
      storage.logLoginAttempt(cleanEmail, "verify", false, "rate_limited", ip, req.headers["user-agent"] as string, (req as any).user?.tenantId ?? null);
      return res.status(429).json({ error: `Too many attempts. Try again in ${Math.ceil(retryAfter / 60)} minutes.` });
    }
    const ok = storage.verifyOtp(cleanEmail, code.trim());
    if (!ok) {
      storage.logLoginAttempt(cleanEmail, "verify", false, "bad_code", ip, req.headers["user-agent"] as string, storage.getUserByEmail(cleanEmail)?.tenantId ?? null);
      return res.status(401).json({ error: "Invalid or expired code. Check your email and try again." });
    }
    const user = storage.getUserByEmail(cleanEmail);
    if (!user || !user.active) {
      storage.logLoginAttempt(cleanEmail, "verify", false, "account_inactive", ip, req.headers["user-agent"] as string, user?.tenantId ?? null);
      return res.status(401).json({ error: "Account not active. Contact your administrator." });
    }
    storage.logLoginAttempt(cleanEmail, "verify", true, "success", ip, req.headers["user-agent"] as string, user?.tenantId ?? null);
    // Reset verify limiter on success
    otpVerifyLimiter.delete(`email:${cleanEmail}`);
    otpVerifyLimiter.delete(`ip:${ip}`);
    otpRequestLimiter.delete(`email:${cleanEmail}`);
    const session = storage.createSession(user.id);
    res.json({ sessionId: session.id, user: { id: user.id, name: user.name, email: user.email, role: user.role, teamMemberId: user.teamMemberId } });
  });

  // Login-attempt audit (owner ask 2026-07-26): managers read the persistent
  // auth trail — recent attempts or the per-email summary. Requires manager+.
  app.get("/api/auth/login-attempts", requireManager, (req: any, res) => {
    const email = typeof req.query.email === "string" ? req.query.email.trim().toLowerCase() : "";
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
    // QA GATE FIX (B1): never read another tenant's auth trail.
    const scope = req.user?.role === "super_admin" ? null : (req.user?.tenantId ?? -1);
    try {
      if (req.query.summary === "1") return res.json({ summary: storage.getLoginAttemptSummary(scope) });
      res.json({ attempts: storage.getLoginAttempts(limit, email || undefined, scope) });
    } catch (e: any) {
      console.error("[login-attempts] read failed:", e?.message);
      res.status(500).json({ error: "Audit read failed" });
    }
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

  // Logout from ALL devices — revoke every session for the current user. Audited.
  app.post("/api/auth/logout-all", requireAuth, (req, res) => {
    const user = (req as any).user;
    const revoked = storage.deleteSessionsByUser(user.id);
    storage.logActivity(user.id, "auth.logout_all", "user", user.id, { sessionsRevoked: revoked }, req.ip);
    res.json({ success: true, sessionsRevoked: revoked });
  });

  // First-run admin setup (OTP-only — no password)
  app.post("/api/auth/setup", async (req, res) => {
    if (!storage.isFirstRun()) return res.status(403).json({ error: "Setup already completed" });
    const { name, email } = req.body;
    if (!name || typeof name !== "string" || name.trim().length < 2 || name.length > 100)
      return res.status(400).json({ error: "Valid name required" });
    if (!email || typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ error: "Valid email required" });
    // First admin belongs to the default org (bootstrapped at migration time).
    const user = storage.createUser({ name: name.trim(), email: email.trim().toLowerCase(), passwordHash: "", role: "admin", active: true, tenantId: getDefaultTenantId() } as any);
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

  const LOGIN_ROLES = [
    "admin", "manager", "team_lead", "rep",
    "calling_rep", "calling_manager", "compliance_admin", "auditor",
  ] as const;

  const validateLoginTeamMember = (teamMemberId: number | null | undefined, tenantId: number) => {
    if (teamMemberId == null) return null;
    const member = storage.getTeamMemberById(teamMemberId);
    return member?.tenantId === tenantId ? null : {
      error: "The selected rep profile is not part of this organization.",
      code: "TEAM_MEMBER_TENANT_MISMATCH",
    };
  };

  // Admin: create a tenant-scoped login account. Calling/audit roles are kept
  // separate from the field-team hierarchy and receive only named capabilities.
  app.post("/api/users", requireAdmin, async (req, res) => {
    const parsed = z.object({
      name: z.string().trim().min(2).max(100),
      email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
      role: z.enum(LOGIN_ROLES).default("rep"),
      teamMemberId: z.number().int().positive().nullable().optional(),
    }).strict().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid account", issues: parsed.error.issues });
    const { name, email, role, teamMemberId } = parsed.data;
    const tenantId = (req as any).user?.tenantId;
    if (!Number.isInteger(tenantId)) return res.status(403).json({ error: "Organization context required" });
    const memberError = validateLoginTeamMember(teamMemberId, tenantId);
    if (memberError) return res.status(409).json(memberError);
    const existing = storage.getUserByEmail(email);
    if (existing) return res.status(409).json({ error: "Email already in use" });
    // New account always joins the creating admin's org. The membership check
    // above prevents an arbitrary foreign teamMemberId from becoming an account
    // link (and, transitively, a commission/payout identity).
    const user = storage.createUser({
      name, email, role, active: true, teamMemberId: teamMemberId ?? null,
      tenantId,
    } as any);
    res.status(201).json({ id: user.id, name: user.name, email: user.email, role: user.role });
  });

  // Admin: update user — allowlisted fields only (no passwordHash injection)
  app.patch("/api/users/:id", requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid user id" });
    const tenantId = (req as any).user?.tenantId;
    if (!Number.isInteger(tenantId)) return res.status(403).json({ error: "Organization context required" });
    // Check the target before validating linked ids so a tenant admin cannot use
    // this endpoint to probe or mutate another organization's login.
    const target = storage.getAllUsers(tenantId).find((user) => user.id === id);
    if (!target) return res.status(404).json({ error: "Not found" });

    const ALLOWED_USER_FIELDS = new Set(["name", "email", "role", "active", "teamMemberId"]);
    const safeUpdate: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(req.body)) {
      if (ALLOWED_USER_FIELDS.has(k)) safeUpdate[k] = v;
    }
    if (Object.keys(safeUpdate).length === 0) {
      return res.status(400).json({ error: "No valid fields to update" });
    }
    // P0-1 (K3 swarm): nobody may claim a platform-apex email. The apex lives in
    // the immutable is_super_admin column now; setting one of the apex emails on
    // any account is reserved for an existing apex admin only.
    if (safeUpdate.email && typeof safeUpdate.email === "string") {
      const apex = (process.env.SUPER_ADMIN_EMAILS ?? "muizzm21@gmail.com").split(",").map(e => e.trim().toLowerCase());
      if (apex.includes(safeUpdate.email.trim().toLowerCase()) && !(req as any).user?.isSuperAdmin) {
        return res.status(403).json({ error: "That email is reserved for platform ownership" });
      }
    }
    // Validate role if provided
    if (safeUpdate.role && !(LOGIN_ROLES as readonly string[]).includes(safeUpdate.role as string)) {
      return res.status(400).json({ error: "Invalid role" });
    }
    if (Object.prototype.hasOwnProperty.call(safeUpdate, "teamMemberId")) {
      const teamMemberId = safeUpdate.teamMemberId;
      if (teamMemberId !== null && (!Number.isInteger(teamMemberId) || Number(teamMemberId) <= 0)) {
        return res.status(400).json({ error: "Invalid teamMemberId" });
      }
      const memberError = validateLoginTeamMember(teamMemberId as number | null, tenantId);
      if (memberError) return res.status(409).json(memberError);
    }
    const updated = storage.updateUser(id, safeUpdate as any, tenantId);
    if (!updated) return res.status(404).json({ error: "Not found" });
    // Deactivating a login here must end it NOW, not whenever the session would
    // have lapsed — same rule the team-offboard path enforces.
    if (Object.prototype.hasOwnProperty.call(safeUpdate, "active") && !updated.active) {
      const revoked = storage.deleteSessionsByUser(updated.id);
      storage.logActivity((req as any).user?.id ?? null, "auth.login_deactivated", "user", updated.id, { sessionsRevoked: revoked }, req.ip);
    }
    res.json({ id: updated.id, name: updated.name, email: updated.email, role: updated.role, active: updated.active });
  });

  // Admin-only destructive identity action. Managers can manage field work, but
  // cannot delete logins (especially admins/compliance/auditor identities).
  app.delete("/api/users/:id", requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid user id" });
    const actor = (req as any).user;
    const tenantId = actor?.tenantId;
    if (!Number.isInteger(tenantId)) return res.status(403).json({ error: "Organization context required" });
    const target = storage.getAllUsers(tenantId).find((user) => user.id === id);
    if (!target) return res.status(404).json({ error: "Not found" });
    if (target.id === actor.id) {
      return res.status(409).json({ error: "You cannot delete your own login.", code: "CANNOT_DELETE_SELF" });
    }
    if (target.role === "admin" && target.active) {
      const activeAdmins = storage.getAllUsers(tenantId).filter((user) => user.role === "admin" && user.active);
      if (activeAdmins.length <= 1) {
        return res.status(409).json({ error: "The organization must retain an active admin.", code: "LAST_ACTIVE_ADMIN" });
      }
    }
    // Drop live sessions with the account. requireAuth already fails closed on a
    // missing user, but leaving orphaned session rows behind is avoidable debt —
    // and revoking first means the deletion is never observable as "still in".
    const sessionsRevoked = storage.deleteSessionsByUser(id);
    const ok = storage.deleteUser(id, tenantId);
    if (!ok) return res.status(404).json({ error: "Not found" });
    storage.logActivity(actor.id, "auth.login_deleted", "user", id, { sessionsRevoked }, req.ip);
    res.json({ success: true });
  });

  // ── TERRITORIES ───────────────────────────────────────────────────────────

  app.get("/api/territories", requireCapability("field.app.use"), (req, res) => {
    const user = (req as any).user;
    // Admins and managers see all territories in their tenant
    if (user.role === "admin" || user.role === "manager" || user.role === "team_lead") {
      return res.json(storage.getTerritories(user.tenantId ?? undefined));
    }
    // Reps only see territories assigned to them — NEVER others' territories
    // If teamMemberId is null (not linked to a team member yet), return empty
    if (!user.teamMemberId || typeof user.teamMemberId !== "number") return res.json([]);
    return res.json(storage.getTerritoriesByRep(user.teamMemberId, user.tenantId ?? undefined));
  });

  app.post("/api/territories", requireTeamLead, (req, res) => {
    const parsed = insertTerritorySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error });
    // Actor's org wins — a client-supplied tenantId is ignored (anti-spoofing).
    const tenantId = (req as any).user?.tenantId ?? getDefaultTenantId();
    res.status(201).json(storage.createTerritory({ ...parsed.data, tenantId } as any));
  });

  // POST /api/territories/assign-area — the SalesRabbit move: draw an area, pick
  // a rep, and in ONE atomic action (a) save the polygon as a rep-colored
  // territory and (b) assign every enclosed lead to that rep.
  // Body: { polygon: [lng,lat][], repId: number, name?: string }
  app.post("/api/territories/assign-area", requireTeamLead, (req, res) => {
    const user = (req as any).user;
    const tid = user?.tenantId ?? undefined;
    const { polygon, repId, name } = req.body as { polygon: [number, number][]; repId: number; name?: string };
    if (!Array.isArray(polygon) || polygon.length < 3) return res.status(400).json({ error: "polygon needs ≥3 points" });
    if (typeof repId !== "number") return res.status(400).json({ error: "repId required" });
    const rep = storage.getTeamMemberById(repId);
    if (!rep || (tid && rep.tenantId !== tid)) return res.status(404).json({ error: "rep not found" });
    // A team_lead may only assign an area to one of their own reps.
    if (!repInVisibilityScope(user, repId)) return res.status(403).json({ error: "That rep is not on your team", code: "OUT_OF_SCOPE" });

    // Max-active-areas guard (company rule; recommended 3–5)
    const activeForRep = storage.getTerritoriesByRep(repId).filter((t: any) => t.status === "active" || t.status === "shared").length;
    if (!canRepTakeAnotherArea(activeForRep)) {
      return res.status(409).json({ error: `${rep.name} already has ${activeForRep} active areas (max ${MAX_ACTIVE_AREAS_PER_REP}). Reclaim one first.` });
    }

    const at = new Date().toISOString();
    const color = colorForRep(repId);
    const territory = storage.createTerritory({
      tenantId: tid ?? null, name: (name && name.trim()) || `${rep.name}'s area`,
      repId, polygon: JSON.stringify(polygon), color,
      status: "active", assigneeIds: JSON.stringify([repId]), updatedAt: at,
    } as any);
    storage.addTerritoryEvent(territory.id, user?.id ?? null, "created", { repId, name: territory.name });

    // Only leads the caller may reassign (unassigned or own-team for a team_lead;
    // all for admin/manager) — an area draw never poaches another team's doors.
    const enclosed = storage.getLeads(tid).filter((l: any) =>
      l.lat != null && l.lng != null && pointInPolygon(l.lat, l.lng, polygon) && canReassignLead(user, l));
    let assigned = 0;
    for (const l of enclosed) {
      if (storage.updateLead(l.id, { assignedRepId: repId, assignedTerritoryId: territory.id, assignmentSource: "territory-sync", assignedBy: user?.name ?? null, assignedAt: at } as any, tid)) {
        assigned++;
        storage.addLeadEvent(l.id, "assignment", user?.name ?? null, { assignedTo: rep.name, assignedBy: user?.name ?? null });
      }
    }
    storage.addTerritoryEvent(territory.id, user?.id ?? null, "assigned", { repId, assigned });

    res.status(201).json({ territory, assigned, total: enclosed.length });
  });

  // ── Territory lifecycle: reclaim / complete / share / archive / history ──────
  // POST /api/territories/:id/reclaim  { mode: "keep_leads"|"return_to_pool"|"reassign", newRepId? }
  // ── Multi-pass knocking ─────────────────────────────────────────────────────
  // "Knock this area again." Closing a pass re-opens the doors that were worked
  // and leaves everything that actually happened exactly where it is: knock_log
  // is append-only and untouched, and each closed pass gets an immutable
  // territory_passes row. History is the point of the feature, not a side effect.
  //
  // manager+ (reclaim_territory), because a reset clears the outcomes an entire
  // team recorded — heavier than a single unassign, which is team_lead+.

  // Dry run. Same rules as the real thing, zero writes, so the dialog can show
  // the manager exactly which doors survive and why BEFORE anything happens.
  app.get("/api/territories/:id/next-pass/preview", requireManager, (req, res) => {
    const user = (req as any).user;
    const tid = user?.tenantId ?? undefined;
    if (!can(user?.role, "reset_territory_pass")) return res.status(403).json({ error: "not allowed" });
    const t = storage.getTerritoryById(Number(req.params.id));
    // 404 not 403 on a foreign area: a manager should not be able to probe which
    // territory ids exist in another org.
    if (!t || (tid && t.tenantId != null && t.tenantId !== tid)) return res.status(404).json({ error: "not found" });

    const keepPendingCallbacks = req.query.keepPendingCallbacks === "true";
    const preview = previewNextPass(t.id, tid ?? null, { keepPendingCallbacks });
    // Only counts and reasons cross the wire. The frozen[] array carries lead ids
    // and the client has no use for them here.
    const { frozen, reset, ...rest } = preview;
    res.json({ ...rest, territoryName: t.name });
  });

  // Close the current pass and open the next one.
  app.post("/api/territories/:id/next-pass", requireManager, (req, res) => {
    const user = (req as any).user;
    const tid = user?.tenantId ?? undefined;
    const audit = auditContext(req);
    if (!can(user?.role, "reset_territory_pass")) {
      recordAdminAudit({ ...audit, action: "territory.next_pass", targetType: "territory",
        targetId: String(req.params.id), outcome: "denied", reason: "missing reset_territory_pass" });
      return res.status(403).json({ error: "not allowed" });
    }
    const t = storage.getTerritoryById(Number(req.params.id));
    if (!t || (tid && t.tenantId != null && t.tenantId !== tid)) return res.status(404).json({ error: "not found" });

    const action: TerritoryPassAction = isTerritoryPassAction(req.body?.territoryAction)
      ? req.body.territoryAction : "keep";
    const newRepId = action === "reassign" ? Number(req.body?.newRepId) : null;
    if (action === "reassign" && !Number.isFinite(newRepId as number)) {
      return res.status(400).json({ error: "newRepId required for reassign" });
    }
    // A rep from another org must never end up owning this area.
    if (newRepId != null && !repInCallerTenant(user, newRepId)) {
      return res.status(404).json({ error: "rep not found" });
    }
    const note = typeof req.body?.note === "string" ? req.body.note.slice(0, 500) : null;
    const keepPendingCallbacks = req.body?.keepPendingCallbacks === true;

    const at = new Date().toISOString();
    const before = { pass: currentPassOf(t.id), repId: t.repId, status: (t as any).status };

    let result;
    try {
      result = startNextPass({
        territoryId: t.id, tenantId: tid ?? null,
        actorUserId: user?.id ?? null, actorName: user?.name ?? user?.username ?? null,
        action, newRepId, note, keepPendingCallbacks, now: at,
        // Runs inside the same transaction as the lead reset: the area's
        // assignment and its doors can never disagree about which pass they're in.
        applyTerritoryAction: () => {
          if (action === "keep") return;
          const nextRepIds = action === "reassign" && newRepId != null ? [newRepId] : [];
          const past = Array.from(new Set([
            ...(safeJson<number[]>((t as any).pastAssigneeIds) ?? []), t.repId,
          ].filter(Boolean)));
          let newName = t.name;
          if (isAutoAreaName(t.name)) {
            const nr = newRepId != null ? storage.getTeamMemberById(newRepId) : null;
            newName = nr ? `${nr.name}'s area` : "Unassigned area";
          }
          const newPrimary = nextRepIds[0] ?? t.repId;
          storage.updateTerritory(t.id, {
            status: action === "reassign" ? "active" : "unassigned",
            repId: newPrimary, name: newName,
            assigneeIds: JSON.stringify(nextRepIds),
            pastAssigneeIds: JSON.stringify(past),
            color: colorForRep(newPrimary),
            reclaimedAt: action === "return_to_pool" ? at : (t as any).reclaimedAt ?? null,
            updatedAt: at,
          } as any, tid);

          // Detach the doors from the departing rep. Their knock history stays
          // attributed to them forever — this only changes who works it next.
          for (const l of storage.getLeadsByTerritory(t.id)) {
            storage.updateLead(l.id, {
              assignedRepId: newRepId ?? null,
              assignedTerritoryId: t.id,
              assignmentSource: newRepId != null ? "territory-sync" : null,
              [newRepId != null ? "assignedAt" : "unassignedAt"]: at,
            } as any, tid);
          }
        },
      });
    } catch (e: any) {
      recordAdminAudit({ ...audit, action: "territory.next_pass", targetType: "territory",
        targetId: t.id, targetLabel: t.name, outcome: "failure", reason: String(e?.message ?? e).slice(0, 200) });
      return res.status(500).json({ error: "could not start next pass" });
    }

    recordAdminAudit({
      ...audit, action: "territory.next_pass", targetType: "territory",
      targetId: t.id, targetLabel: t.name, outcome: "success",
      before, after: { pass: result.nextPass, territoryAction: action, newRepId,
        leadsReset: result.leadsReset, leadsFrozen: result.leadsFrozen },
    });
    storage.addTerritoryEvent(t.id, user?.id ?? null, `next_pass:${action}`, {
      passClosed: result.passNumber, passOpened: result.nextPass,
      leadsReset: result.leadsReset, leadsFrozen: result.leadsFrozen,
    });

    res.json({ ok: true, ...result });
  });

  // Closed passes for an area — the history that must not go away.
  // team_lead+ so a lead can see what their own area already went through.
  app.get("/api/territories/:id/passes", requireTeamLead, (req, res) => {
    const user = (req as any).user;
    const tid = user?.tenantId ?? undefined;
    const t = storage.getTerritoryById(Number(req.params.id));
    if (!t || (tid && t.tenantId != null && t.tenantId !== tid)) return res.status(404).json({ error: "not found" });
    if (!canManageTerritory(user, t)) return res.status(403).json({ error: "not your area" });
    res.json({
      currentPass: currentPassOf(t.id),
      passes: listTerritoryPasses(t.id, tid ?? null, Number(req.query.limit) || 50),
    });
  });

  app.post("/api/territories/:id/reclaim", requireTeamLead, (req, res) => {
    const user = (req as any).user;
    const tid = user?.tenantId ?? undefined;
    if (!can(user?.role, "reclaim_territory")) return res.status(403).json({ error: "not allowed" });
    const t = storage.getTerritoryById(Number(req.params.id));
    if (!t || (tid && t.tenantId != null && t.tenantId !== tid)) return res.status(404).json({ error: "not found" });
    // Scope, not rank, is what keeps a team lead honest here: they may pull back
    // an area their OWN reps hold, never one belonging to another team. Managers
    // and admins have an undefined scope and pass straight through.
    if (!canManageTerritory(user, t)) return res.status(404).json({ error: "not found" });

    const mode = (req.body?.mode ?? "return_to_pool") as ReclaimMode;
    const newRepId = req.body?.newRepId ?? req.body?.reassignToRepId ?? undefined;
    if (mode === "reassign" && !newRepId) return res.status(400).json({ error: "newRepId required for reassign mode" });

    const at = new Date().toISOString();
    // Build the pure TerritoryState from DB rows, run the shared transition,
    // then diff it back to the DB — the rules live in @shared/territory (tested).
    const before = storage.getLeadsByTerritory(t.id);
    const prev: TerritoryState = {
      id: t.id,
      status: ((t as any).status ?? "active") as TerritoryStatus,
      repIds: safeJson((t as any).assigneeIds) ?? [t.repId],
      color: t.color,
      leads: before.map((l: any) => ({ id: l.id, assignedRepId: l.assignedRepId })),
      history: [],
    };
    const next = reclaimTerritory(prev, mode, { actorId: user?.id ?? null, at, newRepId });

    // Persist territory: keep repId as the last/new primary owner for color+history
    const newPrimary = next.repIds[0] ?? t.repId;
    const past = Array.from(new Set([...(safeJson<number[]>((t as any).pastAssigneeIds) ?? []), t.repId].filter(Boolean)));
    // Drop the old rep's name from an auto-named area: back to the pool → "Unassigned area";
    // reassigned → the new owner's name. Custom names are left untouched.
    let newName = t.name;
    if (isAutoAreaName(t.name)) {
      const nr = next.repIds.length ? storage.getTeamMemberById(next.repIds[0]) : null;
      newName = nr ? `${nr.name}'s area` : "Unassigned area";
    }
    storage.updateTerritory(t.id, {
      status: next.status, repId: newPrimary, name: newName,
      assigneeIds: JSON.stringify(next.repIds), pastAssigneeIds: JSON.stringify(past),
      color: colorForRep(newPrimary), reclaimedAt: at, updatedAt: at,
    } as any, tid);

    // Persist only the leads whose rep actually changed
    const beforeById = new Map(before.map((l: any) => [l.id, l.assignedRepId]));
    let leadsAffected = 0;
    for (const l of next.leads) {
      if (beforeById.get(l.id) !== l.assignedRepId) {
        storage.updateLead(l.id, {
          assignedRepId: l.assignedRepId,
          assignedTerritoryId: l.assignedRepId == null ? null : t.id,
          assignmentSource: l.assignedRepId == null ? null : "territory-sync",
          [l.assignedRepId == null ? "unassignedAt" : "assignedAt"]: at,
        } as any, tid);
        leadsAffected++;
      }
    }
    storage.addTerritoryEvent(t.id, user?.id ?? null, `reclaim:${mode}`, { fromRepId: t.repId, newRepId: newPrimary, leadsAffected });

    res.json({ ok: true, mode, status: next.status, leadsAffected });
  });

  // POST /api/territories/:id/assign { repId } — hand an (unassigned/reclaimed)
  // area to the next rep: recolors it, re-links the UNASSIGNED leads inside its
  // polygon to the new rep, and logs the event. Never steals another rep's leads.
  app.post("/api/territories/:id/assign", requireTeamLead, (req, res) => {
    const user = (req as any).user;
    const tid = user?.tenantId ?? undefined;
    if (!can(user?.role, "assign_territory")) return res.status(403).json({ error: "not allowed" });
    const t = storage.getTerritoryById(Number(req.params.id));
    if (!t || (tid && t.tenantId != null && t.tenantId !== tid)) return res.status(404).json({ error: "not found" });
    // Scope: a team_lead may only manage their own areas + assign to their own reps
    // (mirrors /assign-area). Prevents cross-team territory hijack + lead vacuuming.
    if (!canManageTerritory(user, t)) return res.status(404).json({ error: "not found" });
    const repId = Number(req.body?.repId);
    if (!repId) return res.status(400).json({ error: "repId required" });
    const rep = storage.getTeamMemberById(repId);
    if (!rep || (tid && rep.tenantId !== tid)) return res.status(404).json({ error: "rep not found" });
    if (!repInVisibilityScope(user, repId)) return res.status(403).json({ error: "That rep is not on your team", code: "OUT_OF_SCOPE" });

    // Max-active-areas guard
    const activeForRep = storage.getTerritoriesByRep(repId).filter((x: any) => x.status === "active" || x.status === "shared").length;
    if (!canRepTakeAnotherArea(activeForRep)) {
      return res.status(409).json({ error: `${rep.name} already has ${activeForRep} active areas (max ${MAX_ACTIVE_AREAS_PER_REP}).` });
    }

    const at = new Date().toISOString();
    let polygon: [number, number][] = [];
    try { polygon = JSON.parse(t.polygon); } catch {}

    // Assign only leads inside the area that are currently UNASSIGNED — direct
    // assignments and other reps' pipelines are never touched.
    let assigned = 0;
    if (polygon.length >= 3) {
      const inside = storage.getLeads(tid).filter((l: any) =>
        l.lat != null && l.lng != null && l.assignedRepId == null && pointInPolygon(l.lat, l.lng, polygon));
      for (const l of inside) {
        if (storage.updateLead(l.id, { assignedRepId: repId, assignedTerritoryId: t.id, assignmentSource: "territory-sync", assignedBy: (req as any).user?.name ?? null, assignedAt: at } as any, tid)) {
          assigned++;
          storage.addLeadEvent(l.id, "assignment", (req as any).user?.name ?? null, { assignedTo: rep.name, assignedBy: (req as any).user?.name ?? null });
        }
      }
    }

    // Re-badge an auto-named area with the new owner's name (custom names kept).
    const newName = isAutoAreaName(t.name) ? `${rep.name}'s area` : t.name;
    storage.updateTerritory(t.id, {
      repId, assigneeIds: JSON.stringify([repId]), status: "active", name: newName,
      color: colorForRep(repId), updatedAt: at,
    } as any, tid);
    storage.addTerritoryEvent(t.id, user?.id ?? null, "assigned", { repId, assigned });

    res.json({ ok: true, repId, assigned, status: "active" });
  });

  // POST /api/territories/:id/complete { notes? }
  app.post("/api/territories/:id/complete", requireTeamLead, (req, res) => {
    const user = (req as any).user;
    const tid = user?.tenantId ?? undefined;
    const t = storage.getTerritoryById(Number(req.params.id));
    if (!t || (tid && (t as any).tenantId != null && (t as any).tenantId !== tid)) return res.status(404).json({ error: "not found" });
    // Every other team_lead-reachable territory route (PATCH/DELETE/assign/history)
    // gates on ownership; this one did not, so a lead could complete a RIVAL
    // team's active area and stamp a market-learning outcome from work they
    // never did. 404 (not 403) keeps it from confirming the area exists.
    if (!canManageTerritory(user, t)) return res.status(404).json({ error: "not found" });
    if (((t as any).status ?? "active") === "archived") return res.status(409).json({ error: "cannot complete an archived area" });
    const at = new Date().toISOString();
    // LEARNING LOOP: capture the field outcome and roll it into the market's
    // memory so a proven area lifts its market's priority next scan.
    const outcome = scanSvc.recordTerritoryOutcome(tid ?? getDefaultTenantId(), t.id, (t as any).createdAt ?? null);
    storage.updateTerritory(t.id, { status: "completed", completedAt: at, updatedAt: at, completionNotes: req.body?.notes ?? null, outcomeSnapshot: outcome ? JSON.stringify(outcome) : null } as any, tid);
    storage.addTerritoryEvent(t.id, user?.id ?? null, "completed", { notes: req.body?.notes ?? null, outcome });
    res.json({ ok: true, status: "completed", outcome });
  });

  // POST /api/territories/:id/share { repIds: number[] } — multi-rep assignment
  app.post("/api/territories/:id/share", requireTeamLead, (req, res) => {
    const user = (req as any).user;
    const tid = user?.tenantId ?? undefined;
    if (!can(user?.role, "assign_territory")) return res.status(403).json({ error: "not allowed" });
    const t = storage.getTerritoryById(Number(req.params.id));
    if (!t || (tid && (t as any).tenantId != null && (t as any).tenantId !== tid)) return res.status(404).json({ error: "not found" });
    // The target reps were already scoped below, but the AREA was not: without
    // this a team lead could share another team's area to their own reps, which
    // is a territory grab wearing an assignment's clothes.
    if (!canManageTerritory(user, t)) return res.status(404).json({ error: "not found" });
    const repIds: number[] = Array.isArray(req.body?.repIds) ? req.body.repIds.map(Number) : [];
    // Every OTHER rep-taking territory route validates its input reps; this one
    // did not, so a foreign rep id could be written into assignee_ids — and
    // getTerritoriesByRep then served this org's area (name, polygon, briefing)
    // to that other tenant's rep. Validate tenant AND visibility scope.
    for (const r of repIds) {
      if (!Number.isInteger(r) || r <= 0) return res.status(400).json({ error: "invalid repIds" });
      if (!repInCallerTenant(user, r) || !repInVisibilityScope(user, r)) {
        return res.status(404).json({ error: "rep not found" });
      }
    }
    const merged = Array.from(new Set([t.repId, ...repIds].filter(Boolean)));
    const at = new Date().toISOString();
    storage.updateTerritory(t.id, { status: merged.length > 1 ? "shared" : "active", assigneeIds: JSON.stringify(merged), updatedAt: at } as any, tid);
    storage.addTerritoryEvent(t.id, user?.id ?? null, "shared", { repIds: merged });
    res.json({ ok: true, assigneeIds: merged });
  });

  // POST /api/territories/:id/unassign { repId, releaseLeads? }
  //
  // Remove ONE rep from an area and take the work out of their app. `reclaim`
  // is all-or-nothing (empty the area, or hand it to a single new owner), so a
  // manager had no way to revoke one person from a SHARED area — the everyday
  // case when a rep leaves a patch or changes teams. Removing them also returns
  // their leads inside the polygon to the pool, because an area the rep can no
  // longer see is worthless if the doors stay assigned to them.
  app.post("/api/territories/:id/unassign", requireTeamLead, (req, res) => {
    const user = (req as any).user;
    const tid = user?.tenantId ?? undefined;
    const t = storage.getTerritoryById(Number(req.params.id), tid);
    if (!t) return res.status(404).json({ error: "not found" });
    // Same ownership gate the other team_lead lifecycle routes use.
    if (!canManageTerritory(user, t)) return res.status(404).json({ error: "not found" });
    if (((t as any).status ?? "active") === "archived") {
      return res.status(409).json({ error: "cannot change assignees on an archived area", code: "ARCHIVED" });
    }

    const repId = Number(req.body?.repId);
    if (!Number.isInteger(repId) || repId <= 0) return res.status(400).json({ error: "repId required" });
    // Never let this become a cross-tenant or cross-team write, and never let it
    // confirm that a foreign rep id exists.
    if (!repInCallerTenant(user, repId) || !repInVisibilityScope(user, repId)) {
      return res.status(404).json({ error: "rep not found" });
    }

    const at = new Date().toISOString();
    const before = storage.getLeadsByTerritory(t.id);
    const prev: TerritoryState = {
      id: t.id,
      status: ((t as any).status ?? "active") as TerritoryStatus,
      repIds: safeJson<number[]>((t as any).assigneeIds) ?? [t.repId],
      color: t.color,
      leads: before.map((l: any) => ({ id: l.id, assignedRepId: l.assignedRepId })),
      history: [],
    };
    if (!prev.repIds.includes(repId)) {
      return res.status(409).json({ error: "that rep is not assigned to this area", code: "NOT_ASSIGNED" });
    }

    const next = unassignRep(prev, repId, {
      actorId: user?.id ?? null, at,
      releaseLeads: req.body?.releaseLeads !== false,
    });

    // Keep repId (the primary owner used for colour/history) pointing at someone
    // who is still on the area; fall back to the removed rep only when nobody is
    // left, so history still shows who last held it.
    const newPrimary = next.repIds[0] ?? t.repId;
    const past = Array.from(new Set([...(safeJson<number[]>((t as any).pastAssigneeIds) ?? []), repId].filter(Boolean)));
    let newName = t.name;
    if (isAutoAreaName(t.name)) {
      const nr = next.repIds.length ? storage.getTeamMemberById(next.repIds[0], tid) : null;
      newName = nr ? `${nr.name}'s area` : "Unassigned area";
    }
    storage.updateTerritory(t.id, {
      status: next.status, repId: newPrimary, name: newName,
      assigneeIds: JSON.stringify(next.repIds), pastAssigneeIds: JSON.stringify(past),
      color: colorForRep(newPrimary), updatedAt: at,
    } as any, tid);

    // Persist only the leads whose rep actually changed (the removed rep's).
    const beforeById = new Map(before.map((l: any) => [l.id, l.assignedRepId]));
    let leadsReleased = 0;
    for (const l of next.leads) {
      if (beforeById.get(l.id) !== l.assignedRepId) {
        storage.updateLead(l.id, {
          assignedRepId: l.assignedRepId,
          assignedTerritoryId: l.assignedRepId == null ? null : t.id,
          assignmentSource: l.assignedRepId == null ? null : "territory-sync",
          unassignedAt: l.assignedRepId == null ? at : null,
        } as any, tid);
        leadsReleased++;
      }
    }

    const removed = storage.getTeamMemberById(repId, tid);
    storage.addTerritoryEvent(t.id, user?.id ?? null, "unassigned", { repId, repName: removed?.name ?? null, leadsReleased });
    recordAdminAudit({
      ...auditContext(req),
      action: "territory.rep_unassigned", targetType: "territory", targetId: t.id,
      targetLabel: t.name,
      before: { repIds: prev.repIds, status: prev.status },
      after: { repIds: next.repIds, status: next.status, leadsReleased },
      tenantId: tid ?? null, outcome: "success",
    });

    res.json({ ok: true, repId, status: next.status, assigneeIds: next.repIds, leadsReleased });
  });

  // POST /api/territories/:id/archive
  app.post("/api/territories/:id/archive", requireManager, (req, res) => {
    const user = (req as any).user;
    const tid = user?.tenantId ?? undefined;
    const t = storage.getTerritoryById(Number(req.params.id));
    if (!t || (tid && (t as any).tenantId != null && (t as any).tenantId !== tid)) return res.status(404).json({ error: "not found" });
    const at = new Date().toISOString();
    const outcome = scanSvc.recordTerritoryOutcome(tid ?? getDefaultTenantId(), t.id, (t as any).createdAt ?? null);
    storage.updateTerritory(t.id, { status: "archived", archivedAt: at, updatedAt: at, outcomeSnapshot: outcome ? JSON.stringify(outcome) : null } as any, tid);
    storage.addTerritoryEvent(t.id, user?.id ?? null, "archived", { outcome });
    res.json({ ok: true, status: "archived", outcome });
  });

  // GET /api/territories/:id/history — full immutable event log
  app.get("/api/territories/:id/history", requireTeamLead, (req, res) => {
    const tid = (req as any).user?.tenantId ?? undefined;
    const t = storage.getTerritoryById(Number(req.params.id));
    // Tenant + scope guard — the event log carries rep ids + outcome numbers; a
    // team_lead may only read areas they manage (sibling lifecycle routes do the same).
    if (!t || (tid && (t as any).tenantId != null && (t as any).tenantId !== tid) || !canManageTerritory((req as any).user, t)) {
      return res.status(404).json({ error: "Not found" });
    }
    res.json(storage.getTerritoryEvents(Number(req.params.id)));
  });

  // PATCH /api/territories/:id { name } — rename an area. Whitelisted to name
  // only: lifecycle changes go through their dedicated routes above. Custom
  // names survive reclaim/reassign (see isAutoAreaName) and reps see them on
  // their own map.
  app.patch("/api/territories/:id", requireTeamLead, (req, res) => {
    const ttid = (req as any).user?.tenantId ?? undefined;
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    if (!name || name.length > 60) return res.status(400).json({ error: "Area name must be 1–60 characters" });
    const id = Number(req.params.id);
    const prev = storage.getTerritories(ttid).find(t => t.id === id);
    if (!prev) return res.status(404).json({ error: "Not found" });
    if (!canManageTerritory((req as any).user, prev)) return res.status(404).json({ error: "Not found" }); // 404, don't leak existence
    const updated = storage.updateTerritory(id, { name, updatedAt: new Date().toISOString() } as any, ttid);
    storage.addTerritoryEvent(id, (req as any).user?.id ?? null, "renamed", { from: prev.name, to: name });
    res.json(updated);
  });

  app.delete("/api/territories/:id", requireTeamLead, (req, res) => {
    const ttid = (req as any).user?.tenantId ?? undefined;
    const id = Number(req.params.id);
    const terr = storage.getTerritories(ttid).find(t => t.id === id);
    if (!terr || !canManageTerritory((req as any).user, terr)) return res.status(404).json({ error: "Not found" });
    // LEARNING LOOP + orphan fix: teach the market from this area's outcome, then
    // DETACH its leads (clear their territory ref, keep the rep) BEFORE deleting —
    // the old hard-delete left leads pointing at a ghost territory (2,855 orphans).
    scanSvc.recordTerritoryOutcome(ttid ?? getDefaultTenantId(), id, (terr as any).createdAt ?? null);
    const detached = scanSvc.detachTerritoryLeads(id);
    if (!storage.deleteTerritory(id, ttid)) return res.status(404).json({ error: "Not found" });
    if (typeof (globalThis as any).__bustMapCache === "function") (globalThis as any).__bustMapCache(ttid);
    res.json({ success: true, detached });
  });

  // GET /api/territories/progress — canvassing progress per assigned area.
  // For each territory polygon: how many leads fall inside, and how many have
  // been knocked (≥1 door knock logged) → "X/Y doors done". No scanning.
  app.get("/api/territories/progress", requireCapability("field.app.use"), (req, res) => {
    const user = (req as any).user;
    const tid = user?.tenantId ?? undefined;
    // Reps only see their own territory's progress; managers/admins see all.
    const scope = leadVisibilityScope(user);
    if (Array.isArray(scope) && !scope.length) return res.json([]);
    const territories = Array.isArray(scope)
      ? storage.getTerritories(tid).filter((territory) => territory.repId != null && scope.includes(territory.repId))
      : storage.getTerritories(tid);
    if (territories.length === 0) return res.json([]);

    const leads = storage.getLeads(tid).filter((l: any) => l.lat != null && l.lng != null);
    const members = storage.getTeamMembers(tid);
    const geoConfig = storage.getGeoConfig(tid ?? null);

    // Group knocks by lead once (O(knocks)) so each territory is O(leads-inside).
    // Tenant-scoped so a shared DB doesn't load every org's knocks to discard them.
    const knocksByLead = new Map<number, any[]>();
    for (const k of storage.getKnocks(tid)) {
      const arr = knocksByLead.get(k.leadId); if (arr) arr.push(k); else knocksByLead.set(k.leadId, [k]);
    }
    // Is this a WORKED outcome (door done for the pass)? Mirrors OUTCOME_META.
    const isWorkedOutcome = (o: string) => !!OUTCOME_META[o as KnockOutcome]?.worked;

    const inside = pointInPolygon;

    const result = territories.map((t: any) => {
      let poly: [number, number][] = [];
      try { poly = JSON.parse(t.polygon); } catch { poly = []; }
      const within = poly.length >= 3 ? leads.filter((l: any) => inside(l.lat, l.lng, poly)) : [];
      const total = within.length;
      const sold = within.filter((l: any) => l.leadStatus === "sold").length;

      // Per-territory verification rollup. "knocked" = any activity; "verifiedWorked"
      // = distinct leads with a VERIFIED worked knock (the only thing that counts).
      let knocked = 0, verifiedWorkedLeads = 0;
      let verified = 0, needsReview = 0, invalid = 0;
      let distSum = 0, distCount = 0, maxDist = 0;
      for (const l of within) {
        const ks = knocksByLead.get(l.id) ?? [];
        if (ks.length) knocked++;
        let leadHasVerifiedWork = false;
        for (const k of ks) {
          const status = (k.verificationStatus ?? null) as VerificationStatus | null;
          if (status === "verified") verified++;
          else if (status === "invalid") invalid++;
          else if (status === "needs_review") needsReview++;
          if (typeof k.distanceM === "number") {
            maxDist = Math.max(maxDist, k.distanceM);
            if (status === "verified") { distSum += k.distanceM; distCount++; }
          }
          if (status === "verified" && isWorkedOutcome(k.outcome) && countsAsWorked(status)) leadHasVerifiedWork = true;
        }
        if (leadHasVerifiedWork) verifiedWorkedLeads++;
      }
      const areaWorkedPct = total ? Math.round((verifiedWorkedLeads / total) * 10000) / 100 : 0;

      return {
        id: t.id, name: t.name, color: t.color, repId: t.repId, status: (t as any).status ?? "active",
        repName: members.find((m: any) => m.id === t.repId)?.name ?? "Unassigned",
        total, knocked, sold,
        // Back-compat: old clients read pct/knocked (integer % of any-knocked).
        pct: total ? Math.round((knocked / total) * 100) : 0,
        // New: location-verified progress.
        verifiedWorkedLeads,
        areaWorkedPct,
        verified, needsReview, invalid,
        avgDistanceM: distCount ? Math.round(distSum / distCount) : null,
        maxObservedDistanceM: distCount || needsReview || invalid ? Math.round(maxDist) : null,
        maxAllowedDistanceM: geoConfig.maxDistanceM,
        maxAllowedAccuracyM: geoConfig.maxAccuracyM,
      };
    });
    res.json(result);
  });

  // GET /api/territories/:id/activity — the location-verified History feed for a
  // territory: every lead-marking activity with its distance-when-marked, GPS
  // accuracy, verdict, and both coordinate pairs for the map preview. Reps see
  // only their own territory; managers/admins see any in their tenant.
  app.get("/api/territories/:id/activity", requireCapability("field.app.use"), (req, res) => {
    const user = (req as any).user;
    const tid = user?.tenantId ?? undefined;
    const territory = storage.getTerritories(tid).find(t => t.id === Number(req.params.id));
    if (!territory) return res.status(404).json({ error: "Not found" });
    const scope = leadVisibilityScope(user);
    if (Array.isArray(scope) && (territory.repId == null || !scope.includes(territory.repId))) {
      return res.status(404).json({ error: "Not found" });
    }
    let poly: [number, number][] = [];
    try { poly = JSON.parse(territory.polygon); } catch { poly = []; }
    const within = poly.length >= 3
      ? storage.getLeads(tid).filter((l: any) => l.lat != null && l.lng != null && pointInPolygon(l.lat, l.lng, poly))
      : [];
    const leadById = new Map(within.map((l: any) => [l.id, l]));
    const repNames = new Map(storage.getTeamMembers(tid).map(m => [m.id, m.name]));
    const activities = storage.getKnocks(tid)
      .filter(k => leadById.has(k.leadId))
      .map(k => {
        const l: any = leadById.get(k.leadId);
        return {
          knockId: k.id, leadId: k.leadId,
          leadName: l.address, address: `${l.address}, ${l.city} ${l.state} ${l.zip ?? ""}`.trim(),
          rep: k.repId != null ? (repNames.get(k.repId) ?? null) : null,
          outcome: k.outcome, knockedAt: k.knockedAt, deviceTs: k.deviceTs ?? null, serverTs: k.serverTs ?? null,
          verification: k.verificationStatus ?? null, distanceM: k.distanceM ?? null, gpsAccuracyM: k.gpsAccuracy ?? null,
          reviewReason: k.reviewReason ?? null, netState: k.netState ?? null,
          repLat: k.repLat ?? null, repLng: k.repLng ?? null, leadLat: l.lat, leadLng: l.lng,
        };
      })
      .sort((a, z) => (a.knockedAt < z.knockedAt ? 1 : a.knockedAt > z.knockedAt ? -1 : 0))
      .slice(0, 300);
    res.json({
      territoryId: territory.id, name: territory.name,
      maxAllowedDistanceM: storage.getGeoConfig(tid ?? null).maxDistanceM,
      activities,
    });
  });

  // ── Geo verification config ─────────────────────────────────────────────────
  // Manager+ can read the thresholds; ONLY admins can change them (spec: only
  // authorized admins may change max distance). Every change is audited.
  app.get("/api/settings/geo", requireManager, (req, res) => {
    res.json(storage.getGeoConfig((req as any).user?.tenantId ?? null));
  });
  app.patch("/api/settings/geo", requireAdmin, (req, res) => {
    const tid = (req as any).user?.tenantId ?? null;
    const uid = (req as any).user?.id ?? null;
    const prev = storage.getGeoConfig(tid);
    const { maxDistanceM, maxAccuracyM } = (req.body ?? {}) as { maxDistanceM?: unknown; maxAccuracyM?: unknown };
    if (maxDistanceM != null) {
      const d = Number(maxDistanceM);
      if (!Number.isFinite(d) || d < 5 || d > 5000) return res.status(400).json({ error: "maxDistanceM must be 5–5000 metres" });
      storage.setSetting("geo.max_distance_m", String(Math.round(d)), uid, tid);
    }
    if (maxAccuracyM != null) {
      const a = Number(maxAccuracyM);
      if (!Number.isFinite(a) || a < 5 || a > 1000) return res.status(400).json({ error: "maxAccuracyM must be 5–1000 metres" });
      storage.setSetting("geo.max_accuracy_m", String(Math.round(a)), uid, tid);
    }
    const next = storage.getGeoConfig(tid);
    storage.logActivity(uid, "settings.geo.update", "settings", undefined, { from: prev, to: next }, req.ip);
    recordAdminAudit({
      ...auditContext(req),
      action: "settings.geo.update", targetType: "settings", targetId: "geo",
      targetLabel: "Geo verification thresholds",
      before: prev, after: next, tenantId: tid, outcome: "success",
    });
    res.json(next);
  });

  // ── Verification override (admin-only, fully audited) ───────────────────────
  // The captured coordinates/timestamp/distance are NEVER changed — only the
  // verdict, and only through this logged path with a mandatory reason.
  app.post("/api/knocks/:id/override", requireAdmin, (req, res) => {
    const { status, reason } = (req.body ?? {}) as { status?: string; reason?: string };
    if (status !== "verified" && status !== "needs_review" && status !== "invalid") {
      return res.status(400).json({ error: "status must be verified | needs_review | invalid" });
    }
    if (typeof reason !== "string" || reason.trim().length < 3) {
      return res.status(400).json({ error: "A reason (min 3 characters) is required for every override" });
    }
    const user = (req as any).user;
    // Tenant wall: an admin of tenant A must not override (or read back) tenant B's
    // knock by guessing an id — the id space is enumerable and the row leaks rep GPS.
    const _ovKnock = storage.getKnockById(Number(req.params.id));
    const _ovLead = _ovKnock ? storage.getLeadById(_ovKnock.leadId) : null;
    if (!_ovLead || (user?.tenantId && _ovLead.tenantId !== user.tenantId)) {
      return res.status(404).json({ error: "Activity not found" });
    }
    const updated = storage.overrideKnockVerification(Number(req.params.id), status, reason.trim(), user?.id ?? null, user?.name ?? null);
    if (!updated) return res.status(404).json({ error: "Activity not found" });
    storage.logActivity(user?.id ?? null, "verification.override", "knock", Number(req.params.id), { newStatus: status, reason: reason.trim() }, req.ip);
    res.json(updated);
  });
  // Immutable override history for one activity (manager+).
  app.get("/api/knocks/:id/overrides", requireManager, (req, res) => {
    const user = (req as any).user;
    const _ohKnock = storage.getKnockById(Number(req.params.id));
    const _ohLead = _ohKnock ? storage.getLeadById(_ohKnock.leadId) : null;
    if (!_ohLead || (user?.tenantId && _ohLead.tenantId !== user.tenantId)) {
      return res.status(404).json({ error: "Not found" });
    }
    res.json(storage.getActivityOverrides(Number(req.params.id)));
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
    // Stamp the requesting rep's tenant so the row is walled from creation.
    const request = storage.createTerritoryRequest(member.id, user.id, message, (member as any).tenantId ?? user?.tenantId ?? null);

    // Email admin
    if (process.env.SMTP_USER && adminInbox()) {
      sendMailResilient({
        from: mailFrom(),
        to: adminInbox()!,
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
    // Tenant scope on the requests AND on both enrichment reads — the joins
    // leaked foreign rep names and area names even when the rows were filtered.
    const tid = (req as any).user?.tenantId ?? undefined;
    const requests = storage.getTerritoryRequests(status, tid);
    const team = storage.getTeamMembers(tid);
    const territories = storage.getTerritories(tid);
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
    const updated = storage.updateTerritoryRequest(Number(req.params.id), status, (req as any).user?.tenantId ?? undefined);
    if (!updated) return res.status(404).json({ error: "Not found" });
    res.json(updated);
  });

  // ── Public /join page — serve the HomeFront application form ────────────────
  // Two shapes: bare `/join` (routes to the default org) and `/join/:slug`
  // (routes applicants to a SPECIFIC tenant — this is the per-tenant recruiting
  // link a manager shares). The slug is injected into the form and travels back
  // on submit; the apply endpoint resolves it to a tenant.
  const serveJoinForm = (req: Request, res: Response, orgSlug: string | string[] | undefined) => {
    // __dirname is defined under the CJS prod bundle but NOT under the tsx/ESM dev
    // runtime — guard with typeof (never throws) so both the packaged and dev paths
    // resolve. The cwd path is the primary; the bundle‑relative one is the fallback.
    // Dev serves from the repo root (join-form/); the prod build copies it to
    // dist/join-form/, and the container ships only dist — so check BOTH, or /join
    // 404s in production (cwd=/app has no join-form, only dist/join-form).
    const candidates = [
      path.join(process.cwd(), "join-form", "index.html"),          // dev (repo root)
      path.join(process.cwd(), "dist", "join-form", "index.html"),  // prod (cwd=/app → /app/dist/join-form)
    ];
    if (typeof __dirname !== "undefined") {
      candidates.push(path.join(__dirname, "join-form", "index.html"));       // prod bundle: dist/index.cjs → dist/join-form
      candidates.push(path.join(__dirname, "..", "join-form", "index.html")); // dev bundle fallback
    }
    const resolved = candidates.find(p => fs.existsSync(p));
    if (!resolved) {
      return res.status(404).send("Join form not found");
    }
    // Inject the server URL (so the form submits to itself) + the org slug.
    let html = fs.readFileSync(resolved, "utf-8");
    const serverUrl = `${req.protocol}://${req.get("host")}`;
    // Slug is [a-z0-9-] only (matches tenant slugs) — strip anything else so it
    // can't break out of the injected JS string literal.
    const safeSlug = String(orgSlug || "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 64);
    html = html
      .replace("FIBER_SCOUT_SERVER_PLACEHOLDER", serverUrl)
      .replace("FIBER_SCOUT_ORG_PLACEHOLDER", safeSlug);
    res.setHeader("Content-Type", "text/html");
    res.send(html);
  };
  app.get("/join", (req: Request, res: Response) => serveJoinForm(req, res, ""));
  app.get("/join/:slug", (req: Request, res: Response) => serveJoinForm(req, res, req.params.slug));

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
      destination: (_req, file, cb) => {
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
    // lead-photos/ has its OWN tenant-walled route (GET /api/photos/:id/file).
    // Block it here so a tenant admin can't read another tenant's photo through
    // the untenanted static path if a filename ever leaks.
    if (req.path.startsWith("/lead-photos/")) return res.status(404).json({ error: "File not found" });
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

  // ── Lead photos — field evidence attached to a door ─────────────────────────
  // Same visibility wall as every single-lead read: tenant + repCanAccessLead
  // (rep = own doors, team_lead = team, manager/admin = tenant). 404 not 403 so
  // existence never leaks. Files live OUTSIDE the admin-only /uploads route and
  // are streamed through an authed endpoint — an <img src> can't carry the
  // session header, so the client fetches blobs (see PropertyDetail AuthedImg).
  const leadPhotosDir = path.join(uploadsDir, "lead-photos");
  if (!fs.existsSync(leadPhotosDir)) fs.mkdirSync(leadPhotosDir, { recursive: true });
  const LEAD_PHOTO_CAP = 24; // per lead — plenty for field evidence, bounds disk
  const photoUpload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, leadPhotosDir),
      filename: (_req, file, cb) => cb(null, crypto.randomUUID() + path.extname(file.originalname).toLowerCase()),
    }),
    // The route consumes NO text fields — fields:0/parts:2 stops a multipart body
    // of unlimited buffered-in-RAM text parts (which bypass the 64kb json limit)
    // from OOMing the process before the file handler runs.
    limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 0, parts: 2, fieldSize: 1024 },
    fileFilter: (_req, file, cb) => {
      const ok = [".jpg", ".jpeg", ".png", ".webp"].includes(path.extname(file.originalname).toLowerCase());
      if (ok) cb(null, true);
      else cb(new Error("Only JPG, PNG or WebP photos"));
    },
  });
  // Wrap so multer validation errors (wrong type, too big, too many parts) become
  // clean 4xx with a usable message instead of a generic 500 from the global
  // handler — a rep needs to know WHY the upload was rejected.
  const runPhotoUpload = (req: Request, res: Response, next: NextFunction) =>
    photoUpload.single("photo")(req as any, res as any, (err: any) => {
      if (!err) return next();
      const tooBig = err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE";
      return res.status(tooBig ? 413 : 400).json({ error: err.message || "Upload rejected" });
    });

  // Guard shared by all three photo routes. Returns the lead or responds 404.
  const photoLeadOr404 = (req: Request, res: Response): any | null => {
    const user = (req as any).user;
    const lead = storage.getLeadById(Number(req.params.id));
    const tid = user?.tenantId;
    if (!lead || (tid && lead.tenantId !== tid)) { res.status(404).json({ error: "Not found" }); return null; }
    if (!repCanAccessLead(user, lead)) { res.status(404).json({ error: "Not found" }); return null; }
    return lead;
  };

  app.get("/api/leads/:id/photos", requireAuth, (req, res) => {
    const lead = photoLeadOr404(req as any, res);
    if (!lead) return;
    const names = new Map(storage.getTeamMembers((req as any).user?.tenantId ?? undefined).map(m => [m.id, m.name]));
    res.json(storage.getLeadPhotos(lead.id).map(p => ({
      id: p.id, createdAt: p.createdAt,
      takenBy: (p.repId != null ? names.get(p.repId) : null) ?? null,
    })));
  });

  app.post("/api/leads/:id/photos", requireAuth, runPhotoUpload, (req, res) => {
    const user = (req as any).user;
    const lead = photoLeadOr404(req as any, res);
    if (!lead) { if (req.file) try { fs.unlinkSync(req.file.path); } catch {} return; }
    if (!req.file) return res.status(400).json({ error: "Attach a photo file" });
    // Bound disk use per door — an authed account can't fill the volume.
    if (storage.getLeadPhotos(lead.id).length >= LEAD_PHOTO_CAP) {
      try { fs.unlinkSync(req.file.path); } catch {}
      return res.status(400).json({ error: `Up to ${LEAD_PHOTO_CAP} photos per property` });
    }
    const photo = storage.createLeadPhoto({
      leadId: lead.id, userId: user.id, repId: user.teamMemberId ?? null,
      path: "lead-photos/" + req.file.filename,
    });
    storage.logActivity(user.id, "lead.photo_added", "lead", lead.id, { photoId: photo.id }, req.ip);
    res.status(201).json({ id: photo.id, createdAt: photo.createdAt });
  });

  app.get("/api/photos/:photoId/file", requireAuth, (req, res) => {
    const photo = storage.getLeadPhotoById(Number(req.params.photoId));
    if (!photo) return res.status(404).json({ error: "Not found" });
    // Authorize through the photo's LEAD with the same wall as the list route.
    (req as any).params.id = String(photo.leadId);
    const lead = photoLeadOr404(req as any, res);
    if (!lead) return;
    // Path is server-built (uuid + ext under lead-photos/) — resolve + verify
    // anyway so a tampered DB row can never traverse out of the uploads dir.
    const abs = path.resolve(uploadsDir, photo.path);
    if (!abs.startsWith(leadPhotosDir + path.sep)) return res.status(400).json({ error: "Invalid path" });
    if (!fs.existsSync(abs)) return res.status(404).json({ error: "File missing" });
    res.setHeader("Content-Disposition", "inline");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, max-age=3600"); // photos are immutable
    res.sendFile(abs);
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
              salesExperienceDetails, preferredCarriers, referralSource, orgSlug, inviteToken,
              applicationSource, desiredRole, consent } = req.body;

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
      if (applicationSource === "careers" && consent !== "true" && consent !== true) {
        cleanupUploads(files);
        return res.status(400).json({ error: "Consent is required before submitting a careers application." });
      }

      const headshotFile = files?.headshot?.[0];
      const licenseFile = files?.license?.[0];
      let app2: any;
      try {
        app2 = submitPublicApplication({
          fullName, email, phone, city, zip, state: state || "NC",
          hasSalesExperience: hasSalesExperience === "true" || hasSalesExperience === true,
          salesExperienceDetails: typeof salesExperienceDetails === "string" ? salesExperienceDetails.slice(0, 4_000) : null,
          preferredCarriers: Array.isArray(preferredCarriers) ? preferredCarriers.join(",") : String(preferredCarriers),
          referralSource: typeof referralSource === "string" ? referralSource.slice(0, 200) : null,
          desiredRole: typeof desiredRole === "string" ? desiredRole : null,
          requestedSource: typeof applicationSource === "string" ? applicationSource : null,
          orgSlug: typeof orgSlug === "string" ? orgSlug : null,
          inviteToken: typeof inviteToken === "string" && inviteToken.length > 20 ? inviteToken : null,
          headshotPath: headshotFile ? "/uploads/headshots/" + headshotFile.filename : null,
          licensePath: licenseFile ? "/uploads/licenses/" + licenseFile.filename : null,
          actorIp: req.ip,
        });
      } catch (error) {
        cleanupUploads(files);
        const status = error instanceof ApplicationIntakeError ? error.status : 500;
        return res.status(status).json({ error: error instanceof Error ? error.message : "Application could not be submitted." });
      }

      // Email admin notification
      const owningTenant: any = app2.tenantId != null ? storage.getTenantById(app2.tenantId) : null;
      const adminEmail = owningTenant?.ownerEmail || process.env.MAIL_ADMIN || process.env.SMTP_USER;
      if (adminEmail) {
        // HTML-escape helper — prevents injection of HTML from public form fields into admin email
        const esc = (s: string) => String(s)
          .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
        const subject = `New Rep Application — ${String(fullName).replace(/[\r\n]/g, " ").slice(0, 120)}`;
        const html = `
            <h2>New Rep Application Received</h2>
            <table style="border-collapse:collapse;font-family:sans-serif;font-size:14px;">
              <tr><td style="padding:6px 12px;font-weight:bold;">Name</td><td style="padding:6px 12px;">${esc(fullName)}</td></tr>
              <tr><td style="padding:6px 12px;font-weight:bold;">Email</td><td style="padding:6px 12px;">${esc(email)}</td></tr>
              <tr><td style="padding:6px 12px;font-weight:bold;">Phone</td><td style="padding:6px 12px;">${esc(phone)}</td></tr>
              <tr><td style="padding:6px 12px;font-weight:bold;">City/Zip</td><td style="padding:6px 12px;">${esc(city)}, ${esc(state || "NC")} ${esc(zip)}</td></tr>
              <tr><td style="padding:6px 12px;font-weight:bold;">Carriers</td><td style="padding:6px 12px;">${esc(Array.isArray(preferredCarriers) ? preferredCarriers.join(", ") : preferredCarriers)}</td></tr>
              <tr><td style="padding:6px 12px;font-weight:bold;">Sales Exp.</td><td style="padding:6px 12px;">${hasSalesExperience === "true" ? "Yes" : "No"}${salesExperienceDetails ? " — " + esc(salesExperienceDetails) : ""}</td></tr>
              <tr><td style="padding:6px 12px;font-weight:bold;">Referred by</td><td style="padding:6px 12px;">${esc(referralSource || "—")}</td></tr>
              <tr><td style="padding:6px 12px;font-weight:bold;">Source</td><td style="padding:6px 12px;">${esc(app2.applicationSource)}</td></tr>
              <tr><td style="padding:6px 12px;font-weight:bold;">Role</td><td style="padding:6px 12px;">${esc(app2.desiredRole || "Field Representative")}</td></tr>
              <tr><td style="padding:6px 12px;font-weight:bold;">Headshot</td><td style="padding:6px 12px;">${headshotFile ? "✓ Uploaded" : "Not uploaded"}</td></tr>
              <tr><td style="padding:6px 12px;font-weight:bold;">License</td><td style="padding:6px 12px;">${licenseFile ? "✓ Uploaded" : "Not uploaded"}</td></tr>
            </table>
            <p style="margin-top:16px;color:#666;">Log in to Fiber Scout to approve or reject this application.</p>
          `;
        const delivery = resendConfigured()
          ? sendResendEmail({
              to: adminEmail,
              subject,
              html,
              text: `New rep application from ${fullName} (${email}) for ${app2.desiredRole || "Field Representative"}. Open the recruiting portal to review it.`,
              idempotencyKey: `application-admin-notice-${app2.id}`,
              tags: [{ name: "category", value: "application_admin_notice" }],
            })
          : process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS
            ? sendMailResilient({ from: mailFrom(), to: adminEmail, subject, html })
            : null;
        delivery?.catch((e: any) => console.error("Email error:", e));
      }

      res.status(201).json({
        success: true,
        applicationId: app2.id,
        message: "Application received. We will review it and be in touch shortly.",
      });
    }
  );

  // GET /api/onboarding/applications — admin/manager only, tenant-scoped
  // (super_admin sees all orgs' inbound; a tenant admin sees only their own).
  app.get("/api/onboarding/applications", requireManager, (req, res) => {
    const tid = (req as any).user?.tenantId ?? undefined;
    const status = req.query.status as string | undefined;
    res.json(storage.getRepApplications(status, tid));
  });

  // GET /api/onboarding/join-link — the caller's per-tenant recruiting link.
  // Applicants who use it are routed straight to this org. Falls back to the
  // default tenant's slug (or bare /join) so there's always a usable link.
  app.get("/api/onboarding/join-link", requireManager, (req, res) => {
    const user = (req as any).user;
    const tenantId = user?.tenantId ?? getDefaultTenantId();
    const tenant = tenantId != null ? storage.getTenantById(tenantId) : undefined;
    const slug = tenant?.slug ?? "";
    const origin = onboardingAppOrigin(req);
    res.json({
      slug,
      companyName: tenant?.companyName ?? null,
      path: slug ? `/join/${slug}` : "/join",
      url: slug ? `${origin}/join/${slug}` : `${origin}/join`,
    });
  });
  // PATCH /api/onboarding/applications/:id — approve or reject
  app.patch("/api/onboarding/applications/:id", requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    const { status, reviewNotes, commission } = req.body;
    if (!["approved", "rejected"].includes(status)) {
      return res.status(400).json({ error: "status must be 'approved' or 'rejected'" });
    }
    if (status === "rejected" && (typeof reviewNotes !== "string" || reviewNotes.trim().length < 3)) {
      return res.status(400).json({ error: "A rejection reason is required." });
    }

    const application = storage.getRepApplicationById(id);
    if (!application) return res.status(404).json({ error: "Application not found" });
    if (application.status === "rejected" && status === "approved") return res.status(409).json({ error: "A rejected application cannot be approved without reopening it." });
    if (application.status === "approved" && status === "rejected") return res.status(409).json({ error: "An approved application cannot be rejected." });
    if (!['pending', status].includes(application.status)) return res.status(409).json({ error: "This application has already been reviewed" });
    if (application.status === "rejected" && status === "rejected") return res.json(application);
    const approvalRetry = application.status === "approved" && status === "approved";

    const sessionId = req.headers["x-session-id"] as string;
    const sessionObj = storage.getSession(sessionId);
    const reviewer = (req as any).user ?? (sessionObj ? storage.getUserById(sessionObj.userId) : null);
    // The application already owns its tenant through an invite token or the
    // server-owned careers source. Never derive it from the applicant, and never
    // let an unscoped reviewer adopt it implicitly.
    const tenantId = (reviewer as any)?.tenantId ?? null;
    if (tenantId == null) return res.status(403).json({ error: "Your administrator account is not assigned to an organization." });
    if (application.tenantId !== tenantId) {
      return res.status(404).json({ error: "Application not found" });
    }
    const existingAccount = status === "approved" ? storage.getUserByEmail(application.email) : undefined;
    // `NULL` means pre-membership and is safe to claim during approval. A real,
    // different tenant remains a hard conflict.
    if (existingAccount && existingAccount.tenantId != null && existingAccount.tenantId !== tenantId) {
      return res.status(409).json({ error: "That email already belongs to an account in another organization." });
    }
    if (existingAccount && existingAccount.role !== "rep") {
      return res.status(409).json({ error: "That email already belongs to a staff account and cannot be converted into a rep account." });
    }
    const existingLinkedRep = existingAccount?.teamMemberId ? storage.getTeamMemberById(existingAccount.teamMemberId) : undefined;
    const linkedRepBelongsToAnotherTenant = Boolean(
      existingLinkedRep?.tenantId != null && existingLinkedRep.tenantId !== tenantId,
    );
    // A tenant-less login that still points at a real foreign profile is not an
    // orphan: that profile is ownership evidence. Do not let a public
    // application claim it. The safe auto-repair below is limited to a login
    // already owned by this tenant (or a dangling profile id with no owner).
    if (existingAccount?.tenantId == null && linkedRepBelongsToAnotherTenant) {
      return res.status(409).json({ error: "That email is linked to a rep profile in another organization." });
    }
    // A legacy login can be correctly assigned to this tenant while its stale
    // team_member_id points at a deleted profile or a profile in another tenant.
    // Never move that foreign profile (it may own knocks, sales, and payouts).
    // Detach only the bad login link below, then reuse/create a clean profile in
    // the approving tenant. This repairs the account without crossing history.
    const linkedRepNeedsRepair = Boolean(existingAccount?.teamMemberId && (
      !existingLinkedRep || linkedRepBelongsToAnotherTenant
    ));
    const repairedFromRepId = linkedRepNeedsRepair ? existingAccount?.teamMemberId ?? null : null;

    let userId: number | undefined;
    let teamMemberId: number | null = null;
    let commissionResult: any = null;
    let commissionWarning: string | null = null;
    let onboardingDocuments: any = null;
    let onboardingWarning: string | null = null;
    let welcomeEmailId: string | null = null;
    let welcomeWarning: string | null = null;
    const recruitingInvite = getRecruitingInviteByApplication(application.id);
    if (recruitingInvite && status === "approved") markInviteApproved(recruitingInvite.id);

    if (status === "approved") {
      // Create user account — OTP-only, no passwords stored or emailed
      const existing = existingAccount;
      if (existing) {
        userId = existing.id;
        // Claim only an unassigned pre-membership login; never move an account
        // from another tenant. A stale/foreign rep link is detached, not moved.
        // P0-1: apex emails are reserved even via public applications.
        const apex = (process.env.SUPER_ADMIN_EMAILS ?? "muizzm21@gmail.com").split(",").map(e => e.trim().toLowerCase());
        if (apex.includes(String(application.email ?? "").trim().toLowerCase())) {
          return res.status(400).json({ error: "That email is reserved for platform ownership" });
        }
        // Keep login active so the applicant can sign.
        storage.updateUser(existing.id, {
          active: true,
          tenantId,
          ...(linkedRepNeedsRepair ? { teamMemberId: null } : {}),
        } as any);
        if (existingLinkedRep && existingLinkedRep.tenantId == null) {
          storage.updateTeamMember(existingLinkedRep.id, { tenantId } as any);
        }
      } else {
        const newUser = storage.createUser({
          name: application.fullName,
          email: application.email,
          passwordHash: "",   // OTP-only system — no password
          role: "rep",
          active: true,
          tenantId: tenantId ?? undefined,
        } as any);
        userId = newUser.id;
      }

      // Approval also makes the applicant a first-class TEAM MEMBER (the entity
      // leads + commissions reference) and links the login account to it, then
      // assigns the commission structure the manager chose (flat vs tiered).
      // Best-effort: a commission hiccup must never block account creation.
      try {
        const linkedUser = userId != null ? storage.getUserById(userId) : null;
        teamMemberId = (linkedUser as any)?.teamMemberId ?? null;
        if (!teamMemberId) {
          // Reuse an existing team member with this email in the tenant if present.
          const roster = storage.getTeamMembers(tenantId ?? undefined);
          const match = roster.find((m: any) => (m.email || "").toLowerCase() === application.email.toLowerCase());
          const member = match ?? storage.createTeamMember({
            name: application.fullName,
            phone: application.phone || null,
            email: application.email,
            role: "rep",
            active: false,
            tenantId: tenantId ?? undefined,
          } as any);
          teamMemberId = member.id;
          if (userId != null) storage.updateUser(userId, { teamMemberId } as any);
        }
        if (teamMemberId != null) storage.updateTeamMember(teamMemberId, { active: false }, tenantId ?? undefined);

        if (linkedRepNeedsRepair && userId != null && teamMemberId != null) {
          storage.logActivity(reviewer?.id ?? null, "onboarding.rep_profile_link_repaired", "user", userId, {
            applicationId: application.id,
            detachedRepId: repairedFromRepId,
            linkedRepId: teamMemberId,
            reason: existingLinkedRep ? "foreign_tenant_profile" : "missing_profile",
          }, req.ip, tenantId);
        }

        if (commission && tenantId != null && teamMemberId != null) {
          const structure = commission.structure === "FLAT" ? "FLAT" : "TIERED";
          const rawRateCents = commission.flatRateCents != null
            ? Number(commission.flatRateCents)
            : commission.flatRateDollars != null
              ? Math.round(Number(commission.flatRateDollars) * 100)
              : 0;
          const flatRateCents = structure === "FLAT" ? Math.round(rawRateCents) : undefined;
          commissionResult = commissionSvc.assignStructureToRep(tenantId, reviewer?.id ?? null, {
            repId: teamMemberId, structure, flatRateCents,
            commissionPlanVersionId: commission.commissionPlanVersionId ?? null,
            effectiveFrom: commission.effectiveFrom || undefined,
          });
        } else if (commission && tenantId == null) {
          commissionWarning = "Account created, but no organization is set on your login, so a commission plan could not be assigned.";
        }
      } catch (e: any) {
        // Surface the reason but keep the approval — the manager can fix the plan later.
        commissionWarning = e?.message || "Commission structure could not be assigned.";
        console.error("Onboarding commission assignment failed:", e?.message);
      }

      // Send the first login code through the same Resend HTTP path as the
      // document invitation and await acceptance before issuing agreements.
      if (!(application.loginSentAt || recruitingInvite?.loginSentAt)) {
        try {
          const otp = storage.createOtp(application.email);
          const welcome = await sendOnboardingWelcome({
            email: application.email,
            name: application.fullName,
            otp,
            origin: onboardingAppOrigin(req),
          });
          welcomeEmailId = welcome.id;
          storage.updateRepApplication(application.id, { loginEmailId: welcome.id, loginSentAt: new Date().toISOString() } as any);
          if (recruitingInvite) markInviteLoginSent(recruitingInvite.id, welcome.id);
          storage.logActivity(reviewer?.id ?? null, "onboarding.welcome.sent", "rep_application", application.id, {
            candidateEmail: application.email.toLowerCase(),
            emailProvider: "resend",
            emailId: welcome.id,
          }, req.ip);
        } catch (e: any) {
          welcomeWarning = e?.message || "Account created, but the first sign-in code could not be emailed.";
          storage.logActivity(reviewer?.id ?? null, "onboarding.welcome.failed", "rep_application", application.id, {
            candidateEmail: application.email.toLowerCase(),
            emailProvider: "resend",
            reason: welcomeWarning,
          }, req.ip);
        }
      } else {
        welcomeEmailId = application.loginEmailId ?? recruitingInvite?.loginEmailId ?? null;
      }

      // Account + team profile now exist and the first login code has been
      // attempted, so issue exactly the complete four-agreement pack.
      if (tenantId != null && teamMemberId != null) {
        try {
          onboardingDocuments = await issueOnboardingDocuments({
            tenantId,
            repId: teamMemberId,
            sentBy: reviewer?.id ?? null,
            actorIp: String(req.ip || req.socket.remoteAddress || "unknown").slice(0, 100),
            actorUserAgent: String(req.headers["user-agent"] ?? "unknown").slice(0, 500),
            origin: onboardingAppOrigin(req),
          });
          const failedCount = onboardingDocuments.results.filter((result: any) => result.failed).length;
          if (failedCount) onboardingWarning = `Account created, but ${failedCount} onboarding document${failedCount === 1 ? "" : "s"} could not be emailed.`;
          else {
            storage.updateRepApplication(application.id, { agreementsIssuedAt: application.agreementsIssuedAt ?? new Date().toISOString() } as any);
            if (recruitingInvite) markInviteAgreementsIssued(recruitingInvite.id);
          }
        } catch (e: any) {
          onboardingWarning = e?.message || "Account created, but onboarding documents could not be issued.";
          console.error("Automatic onboarding document issuance failed:", e?.message);
        }
      } else {
        onboardingWarning = "Account created, but the rep profile was not linked, so onboarding documents were not issued.";
      }
    }

    const updated = storage.updateRepApplication(id, {
      status,
      reviewNotes: reviewNotes || null,
      reviewedBy: reviewer?.id ?? null,
      userId: userId ?? null,
    });
    if (recruitingInvite && status === "rejected") markInviteRejected(recruitingInvite.id);
    storage.logActivity(reviewer?.id ?? null, approvalRetry ? "onboarding.application.approval_retried" : `onboarding.application.${status}`, "rep_application", application.id, {
      tenantId,
      source: application.applicationSource,
      inviteId: recruitingInvite?.id ?? null,
      userId: userId ?? null,
      repId: teamMemberId,
      loginCodeSent: Boolean(welcomeEmailId),
      agreementsCreated: onboardingDocuments?.createdCount ?? 0,
      agreementsFailed: onboardingDocuments?.results?.filter((result: any) => result.failed).length ?? 0,
    }, req.ip);

    res.json({
      ...updated,
      commission: commissionResult,
      commissionWarning,
      onboardingDocuments,
      onboardingWarning,
      welcomeEmailId,
      welcomeWarning,
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// NEW SAAS ROUTES — GPS, Clock, Coming Soon, Commissions, Activity Log
// These are appended below existing registerRoutes exports
// ═══════════════════════════════════════════════════════════════════════════════

export function registerSaasRoutes(app: any) {
  // ── GPS Location Pings ──────────────────────────────────────────────────────
  // POST /api/location-pings — rep sends their GPS position
  app.post("/api/location-pings", requireCapability("field.app.use"), (req: Request, res: Response) => {
    const user = (req as any).user;
    const { lat, lng, accuracy, repId } = req.body;
    if (!lat || !lng) return res.status(400).json({ error: "lat/lng required" });
    const resolvedRepId = user.role === "rep" ? user.teamMemberId : (repId ?? user.teamMemberId);
    if (!resolvedRepId) return res.status(400).json({ error: "No rep ID" });
    if (!repInCallerTenant(user, resolvedRepId)) return res.status(404).json({ error: "Rep not found" });
    if (!repInVisibilityScope(user, resolvedRepId)) return res.status(403).json({ error: "Forbidden" });
    const ping = storage.createLocationPing({ repId: resolvedRepId, userId: user.id, lat, lng, accuracy });
    res.json(ping);
  });

  // GET /api/location-pings/latest — latest ping per rep (admin/manager view)
  // Tenant-scoped: an org only ever sees its OWN reps' live locations.
  app.get("/api/location-pings/latest", requireManager, (req: Request, res: Response) => {
    const user = (req as any).user;
    const tid = user.tenantId ?? undefined; // super_admin (null) sees all
    const pings = storage.getLatestPingPerRep(tid);
    const members = storage.getTeamMembers(tid);
    const result = pings.map(p => ({
      ...p,
      repName: members.find(m => m.id === p.repId)?.name ?? "Unknown",
    }));
    res.json(result);
  });

  // GET /api/location-pings/:repId — history for a specific rep
  app.get("/api/location-pings/:repId", requireCapability("field.app.use"), (req: Request, res: Response) => {
    const user = (req as any).user;
    const repId = Number(req.params.repId);
    // Reps can only view their own; a scoped role only within their team; and
    // NO role may cross the tenant wall (IDOR on an incrementing repId).
    if (user.role === "rep" && user.teamMemberId !== repId) {
      return res.status(403).json({ error: "Forbidden" });
    }
    if (!repInCallerTenant(user, repId)) return res.status(404).json({ error: "Rep not found" });
    if (!repInVisibilityScope(user, repId)) return res.status(403).json({ error: "Forbidden" });
    res.json(storage.getPingsByRep(repId, 100));
  });

  // ── Clock Sessions ──────────────────────────────────────────────────────────
  // POST /api/clock/in — clock in
  app.post("/api/clock/in", requireCapability("field.app.use"), (req: Request, res: Response) => {
    const user = (req as any).user;
    // A rep can ONLY clock themselves in/out — never another rep. Higher roles
    // may clock a specific rep (ride-alongs) via body.repId.
    const repId = user.role === "rep" ? user.teamMemberId : (req.body.repId ?? user.teamMemberId);
    if (!repId) return res.status(400).json({ error: "No rep ID linked to your account" });
    if (!repInCallerTenant(user, repId)) return res.status(404).json({ error: "Rep not found" });
    if (!repInVisibilityScope(user, repId)) return res.status(403).json({ error: "Forbidden" });
    const existing = storage.getActiveClockSession(repId);
    if (existing) return res.status(400).json({ error: "Already clocked in", session: existing });
    const session = storage.clockIn(repId, user.id, req.body.notes);
    storage.logActivity(user.id, "rep.clocked_in", "clock_session", session.id, { repId }, req.ip);
    res.json(session);
  });

  // POST /api/clock/out — clock out
  app.post("/api/clock/out", requireCapability("field.app.use"), (req: Request, res: Response) => {
    const user = (req as any).user;
    // A rep can ONLY clock themselves in/out — never another rep. Higher roles
    // may clock a specific rep (ride-alongs) via body.repId.
    const repId = user.role === "rep" ? user.teamMemberId : (req.body.repId ?? user.teamMemberId);
    if (!repId) return res.status(400).json({ error: "No rep ID linked to your account" });
    if (!repInCallerTenant(user, repId)) return res.status(404).json({ error: "Rep not found" });
    if (!repInVisibilityScope(user, repId)) return res.status(403).json({ error: "Forbidden" });
    const active = storage.getActiveClockSession(repId);
    if (!active) return res.status(400).json({ error: "Not clocked in" });
    const session = storage.clockOut(active.id);
    storage.logActivity(user.id, "rep.clocked_out", "clock_session", session?.id, { repId, durationMinutes: session?.durationMinutes }, req.ip);
    res.json(session);
  });

  // GET /api/clock/status — current clock status for the logged-in rep
  app.get("/api/clock/status", requireCapability("field.app.use"), (req: Request, res: Response) => {
    const user = (req as any).user;
    const repId = user.teamMemberId;
    if (!repId) return res.json({ clockedIn: false, session: null });
    const session = storage.getActiveClockSession(repId);
    res.json({ clockedIn: !!session, session: session ?? null });
  });

  // GET /api/clock/sessions — all sessions (admin/manager) or own (rep)
  app.get("/api/clock/sessions", requireCapability("field.app.use"), (req: Request, res: Response) => {
    const user = (req as any).user;
    const date = req.query.date as string | undefined;
    const tid = user.tenantId ?? undefined; // super_admin (null) sees all
    const scope = leadVisibilityScope(user);
    let sessions = storage.getAllClockSessions(date, tid);
    if (Array.isArray(scope)) {
      const visibleRepIds = new Set(scope);
      sessions = sessions.filter((session) => visibleRepIds.has(session.repId));
    }
    const members = storage.getTeamMembers(tid);
    const result = sessions.map(s => ({
      ...s,
      repName: members.find(m => m.id === s.repId)?.name ?? "Unknown",
    }));
    res.json(result);
  });

  // ── Commissions ──────────────────────────────────────────────────────────────
  // GET /api/commissions — admin sees all, rep sees own
  app.get("/api/commissions", requireCapability("field.app.use"), (req: Request, res: Response) => {
    const user = (req as any).user;
    const tid = user.tenantId ?? undefined; // super_admin (null) = all tenants
    let repId: number | undefined;
    const canReadAll = hasCapability(user.role, "commission.read.all");
    const canReadTeam = hasCapability(user.role, "commission.read.team");
    if (!canReadAll && !canReadTeam) {
      repId = user.teamMemberId ?? -1;
    } else if (req.query.repId) {
      repId = Number(req.query.repId);
      // The ?repId filter must not become a cross-tenant IDOR — a manager may
      // only target a rep inside their own org.
      if (!repInCallerTenant(user, repId)) return res.status(404).json({ error: "Rep not found" });
      if (!canReadAll && !repInVisibilityScope(user, repId)) return res.status(403).json({ error: "Forbidden" });
    }
    // Tenant-scoped: a manager/admin never receives another org's payout ledger.
    let comms = storage.getCommissions(tid, repId);
    if (!canReadAll && canReadTeam && repId == null) {
      const scope = leadVisibilityScope(user);
      const visibleRepIds = new Set(Array.isArray(scope) ? scope : []);
      comms = comms.filter((commission) => commission.repId != null && visibleRepIds.has(commission.repId));
    }
    // Mobile entries read "sold date · rep · address, city" — enrich once here
    // (two Map builds, O(1) per row) instead of N client round-trips.
    const repNames = new Map(storage.getTeamMembers(tid).map(m => [m.id, m.name]));
    const leadIds = new Set(comms.map(c => c.leadId).filter((id): id is number => id != null));
    const leadAddr = new Map(
      storage.getLeads(user?.tenantId ?? undefined)
        .filter(l => leadIds.has(l.id))
        .map(l => [l.id, { address: l.address, city: l.city }]),
    );
    res.json(comms.map(c => ({
      ...c,
      repName: (c.repId != null ? repNames.get(c.repId) : null) ?? null,
      address: (c.leadId != null ? leadAddr.get(c.leadId)?.address : null) ?? null,
      city: (c.leadId != null ? leadAddr.get(c.leadId)?.city : null) ?? null,
      // calcType / structureVersion travel with each row so a rep can SEE how
      // their payout was scored without exposing the editable structure config.
      calcType: (c as any).calcType ?? "flat",
      structureVersion: (c as any).structureVersion ?? null,
    })));
  });

  // POST /api/commissions — create a commission (manager/admin; auto-created on sale knock)
  app.post("/api/commissions", requireManager, (req: Request, res: Response) => {
    const user = (req as any).user;
    const { repId, leadId, knockId, amount, saleDate, notes } = req.body;
    if (!repId || !amount || !saleDate) return res.status(400).json({ error: "repId, amount, saleDate required" });
    if (!repInCallerTenant(user, Number(repId))) return res.status(404).json({ error: "Rep not found" });
    const comm = storage.createCommission({ repId, leadId, knockId, amount, saleDate, notes, status: "pending", approvedBy: null, paidDate: null });
    // REVIEWER GATE: if the unique index returned a PRE-EXISTING pending row,
    // say so — never audit a phantom creation with the manager's values.
    if ((comm as any)?.preExisting) {
      storage.logActivity((req as any).user?.id ?? null, "commission.duplicate_skipped", "commission", (comm as any).id,
        { leadId, requestedAmount: amount, existingAmount: (comm as any).amount }, req.ip);
      return res.status(200).json({ ...comm, existed: true });
    }
    storage.logActivity(user.id, "commission.created", "commission", comm.id, { repId, amount }, req.ip);
    res.json(comm);
  });

  // PATCH /api/commissions/:id — update status (approve, mark paid, dispute)
  app.patch("/api/commissions/:id", requireManager, (req: Request, res: Response) => {
    const user = (req as any).user;
    const id = Number(req.params.id);
    // P0-2: tenant wall on the WRITE — a commission outside the caller's org is
    // indistinguishable from a missing one (404, no existence leak), and the
    // UPDATE itself carries the tenant predicate as a second line of defense.
    const tid: number | undefined = user?.role === "super_admin" ? undefined : (user?.tenantId ?? undefined);
    const existing = storage.getCommissionById(id);
    if (!existing || (tid != null && existing.tenantId !== tid)) {
      return res.status(404).json({ error: "Not found" });
    }
    const { status, paidDate, notes } = req.body;
    const updates: any = {};
    if (status) updates.status = status;
    if (paidDate) updates.paidDate = paidDate;
    if (notes !== undefined) updates.notes = notes;
    if (status === "approved" || status === "paid") updates.approvedBy = user.id;
    const updated = storage.updateCommission(id, updates, tid);
    if (!updated) return res.status(404).json({ error: "Not found" });
    storage.logActivity(user.id, `commission.${status}`, "commission", id, { status }, req.ip);
    res.json(updated);
  });

  // GET /api/commissions/summary — earnings summary per rep (admin/manager)
  app.get("/api/commissions/summary", requireManager, (req: Request, res: Response) => {
    // P0-4: scoped to the caller's org (super_admin = platform-wide).
    const user = (req as any).user;
    const tid: number | undefined = user?.role === "super_admin" ? undefined : (user?.tenantId ?? undefined);
    res.json(storage.getCommissionSummary(tid));
  });

  // GET /api/commission-rates — structure plans. Management-only: reps see
  // their commission RESULTS (via /api/commissions), never the structure config.
  app.get("/api/commission-rates", requireCapability("commission.structure.manage"), (req: Request, res: Response) => {
    // P0-3: scoped to the caller's org (super_admin = all orgs).
    const user = (req as any).user;
    const tid: number | undefined = user?.role === "super_admin" ? undefined : (user?.tenantId ?? undefined);
    res.json(storage.getCommissionRates(tid));
  });

  // POST /api/commission-rates — create a commission structure (Admin/Manager/
  // Team Lead). Accepts flat | percentage | tiered with effective-date windows;
  // the actor is stamped for the audit trail.
  app.post("/api/commission-rates", requireCapability("commission.structure.manage"), (req: Request, res: Response) => {
    const user = (req as any).user;
    const b = req.body ?? {};
    const calcType: CalcType = ["flat", "percentage", "tiered"].includes(b.calcType) ? b.calcType : "flat";
    if (!b.name) return res.status(400).json({ error: "name required" });
    // Per-type validation — never book a structure that can't be scored.
    if (calcType === "flat" && !(Number(b.ratePerSale) > 0)) return res.status(400).json({ error: "flat plan needs ratePerSale > 0" });
    if (calcType === "percentage" && !(Number(b.percentage) > 0)) return res.status(400).json({ error: "percentage plan needs percentage > 0" });
    let tiersJson: string | null = null;
    if (calcType === "tiered") {
      const tiers = Array.isArray(b.tiers) ? b.tiers.filter((t: any) => Number.isFinite(t?.minBasis) && Number.isFinite(t?.amount)) : [];
      if (tiers.length === 0) return res.status(400).json({ error: "tiered plan needs at least one tier" });
      tiersJson = JSON.stringify(tiers as Tier[]);
    }
    // P0-3: a rep-specific structure may only target a rep in the caller's org.
    if (b.repId != null && !repInCallerTenant(user, Number(b.repId))) {
      return res.status(404).json({ error: "Rep not found" });
    }
    const rate = storage.createCommissionRate({
      // The structure's org is the CALLER's org — never client-supplied.
      // super_admin (tenantId null) creates a platform-wide structure.
      tenantId: user?.role === "super_admin" ? null : (user?.tenantId ?? null),
      name: String(b.name), role: b.role ?? null, repId: b.repId != null ? Number(b.repId) : null,
      ratePerSale: Number(b.ratePerSale) || 0,
      calcType, percentage: Number(b.percentage) || 0, tiers: tiersJson,
      effectiveFrom: typeof b.effectiveFrom === "string" ? b.effectiveFrom : new Date().toISOString().slice(0, 10),
      effectiveTo: typeof b.effectiveTo === "string" ? b.effectiveTo : null,
      version: 1, updatedBy: user?.name ?? null, isActive: true,
    } as any);
    storage.logActivity(user?.id ?? null, "commission_structure.created", "commission_rate", rate.id,
      { name: rate.name, calcType, by: user?.name ?? null }, req.ip);
    res.json(rate);
  });

  // PATCH /api/commission-rates/:id — edit a structure. Editing PUBLISHES a new
  // version (bumps `version`, re-stamps actor); commissions already booked keep
  // the version they were sold under, so payouts are never silently rewritten.
  app.patch("/api/commission-rates/:id", requireCapability("commission.structure.manage"), (req: Request, res: Response) => {
    const user = (req as any).user;
    const id = Number(req.params.id);
    // P0-3: scoped lookup — another org's structure is a 404, never an edit.
    const tid: number | undefined = user?.role === "super_admin" ? undefined : (user?.tenantId ?? undefined);
    const existing = storage.getCommissionRates(tid).find(r => r.id === id);
    if (!existing) return res.status(404).json({ error: "Not found" });
    // Allowlist — never let the body set id/createdAt/isActive/etc. (mass-assignment
    // of the PK would break structure refs; isActive would drop the row from payout
    // calc). Mirror the /api/leads + /api/users PATCH pattern.
    const ALLOWED_RATE_FIELDS = new Set(["name", "role", "repId", "ratePerSale", "calcType", "percentage", "tiers", "effectiveFrom", "effectiveTo"]);
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(req.body ?? {})) if (ALLOWED_RATE_FIELDS.has(k)) patch[k] = v;
    if (Array.isArray(patch.tiers)) patch.tiers = JSON.stringify(patch.tiers);
    // REVIEWER GATE (authz #3): retargeting repId must re-validate tenancy —
    // the POST path validates, the PATCH path didn't.
    if (patch.repId != null && !repInCallerTenant(user, Number(patch.repId))) {
      return res.status(404).json({ error: "Not found" });
    }
    patch.version = ((existing as any).version ?? 1) + 1; // publish = new version
    patch.updatedBy = user?.name ?? null;
    const updated = storage.updateCommissionRate(id, patch as any);
    if (!updated) return res.status(404).json({ error: "Not found" });
    storage.logActivity(user?.id ?? null, "commission_structure.updated", "commission_rate", id,
      { version: (patch.version as number), by: user?.name ?? null }, req.ip);
    res.json(updated);
  });

  // ── Admin diagnostics / observability (Phase 2) ─────────────────────────────
  // A read-model over the append-only activity stream: health cards, categorized
  // failures, and the permission-denial feed. Gated on audit.read.org.
  app.get("/api/diagnostics", requireCapability("audit.read.org"), (req: Request, res: Response) => {
    const tid = (req as any).user?.tenantId ?? undefined; // super_admin (null) = platform-wide
    const windowHours = Math.min(Math.max(Number(req.query.hours) || 24, 1), 168);
    // Pull a generous slice; buildDiagnostics windows + caps it. Cheap: one
    // indexed desc scan, no per-row joins. Tenant-scoped — a manager's health
    // cards reflect only their own org's activity.
    const raw = storage.getActivityLog(1000, tid).map(e => ({
      action: e.action, at: e.at, userId: e.userId,
      details: e.details ? (() => { try { return JSON.parse(e.details as string); } catch { return null; } })() : null,
    }));
    res.json({ ...buildDiagnostics(raw, Date.now(), windowHours), appVersion: APP_VERSION });
  });

  // ── Capability governance (Phase 2) ─────────────────────────────────────────
  // The role×capability matrix as first-class governance objects: grouped by
  // domain, high-risk flagged, "who can do this". Read straight from the shared
  // map so it can never drift from what the middleware enforces.
  app.get("/api/governance/capabilities", requireCapability("settings.manage.org"), (_req: Request, res: Response) => {
    const roles: Role[] = ["rep", "team_lead", "manager", "admin"];
    res.json({
      roles,
      groups: groupedCapabilities().map(g => ({
        domain: g.domain,
        capabilities: g.capabilities.map(c => ({
          capability: c,
          highRisk: isHighRisk(c),
          roles: rolesWithCapability(c).filter(r => roles.includes(r)),
        })),
      })),
    });
  });

  // Effective permissions PREVIEW BY USER — pick a person, see exactly what
  // their role grants, grouped by domain with high-risk flagged. Same shared
  // map as the middleware, so the preview is the real effective permission.
  app.get("/api/governance/user/:id/capabilities", requireCapability("settings.manage.org"), (req: Request, res: Response) => {
    // Tenant-scoped lookup: this walked the dense team_members id space and
    // returned foreign members' names + effective roles — a clean org-chart
    // enumeration primitive for any tenant admin.
    const govTid = (req as any).user?.tenantId ?? undefined;
    const member = storage.getTeamMemberById(Number(req.params.id), govTid);
    if (!member) return res.status(404).json({ error: "Not found" });
    // A team member's login role lives on the linked user (fallback: member.role).
    const linked = storage.getAllUsers(govTid).find(u => u.teamMemberId === member.id);
    const role = (linked?.role ?? member.role ?? "rep") as Role;
    const granted = new Set(capabilitiesFor(role));
    res.json({
      user: { id: member.id, name: member.name, role },
      grantedCount: granted.size,
      groups: groupedCapabilities().map(g => ({
        domain: g.domain,
        capabilities: g.capabilities.map(c => ({ capability: c, highRisk: isHighRisk(c), granted: granted.has(c) })),
      })),
    });
  });

  // ── Activity Log ──────────────────────────────────────────────────────────────
  app.get("/api/activity-log", requireManager, (req: Request, res: Response) => {
    const tid = (req as any).user?.tenantId ?? undefined; // super_admin (null) = all tenants
    const limit = Number(req.query.limit ?? 100);
    // Tenant-scoped audit stream — a manager never reads another org's actions,
    // actor names, or client IPs.
    const entries = storage.getActivityLog(limit, tid);
    const users = storage.getAllUsers(tid);
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
    const repScope = leadVisibilityScope(user); // rep→self, team_lead→team, mgr/admin→all
    // A set of rep ids to aggregate over for the scoped roles (rep/team_lead);
    // null for org-wide (admin/manager). Keeps knocks/commissions/hours scoped
    // to exactly the same reps as the leads above.
    const scopeIds = Array.isArray(repScope) ? repScope : null;

    // Reps see their own stats; team leads their team's; admins/managers tenant-wide.
    // EVERY source is tenant-scoped so the org-wide (scopeIds===null) path can never
    // aggregate another tenant's knocks/commissions/hours/pipeline into this dashboard.
    const tid = user?.tenantId ?? undefined; // super_admin (null) = platform-wide
    const leads = storage.getLeads(tid, repScope);
    const members = storage.getTeamMembers(tid).filter(m => m.active);
    const scopedMembers = scopeIds ? members.filter(m => scopeIds.includes(m.id)) : members;
    const allKnocks = storage.getKnocks(tid);
    const knocks = scopeIds ? allKnocks.filter((k: any) => scopeIds.includes(k.repId)) : allKnocks;
    const kineticAddresses = tid == null
      ? rawDb.prepare(`SELECT COUNT(*) AS total,SUM(CASE WHEN is_live=1 THEN 1 ELSE 0 END) AS live FROM kinetic_addresses`).get() as any
      : rawDb.prepare(`SELECT COUNT(*) AS total,SUM(CASE WHEN is_live=1 THEN 1 ELSE 0 END) AS live FROM kinetic_addresses WHERE tenant_id=?`).get(tid) as any;
    const allCommissions = storage.getCommissions(tid);
    const commissions = scopeIds ? allCommissions.filter((c: any) => scopeIds.includes(c.repId)) : allCommissions;
    const allSessions = storage.getAllClockSessions(undefined, tid);
    const sessions = scopeIds ? allSessions.filter(s => scopeIds.includes(s.repId)) : allSessions;

    const today = new Date().toISOString().slice(0, 10);
    const todayKnocks = knocks.filter(k => k.knockedAt.slice(0, 10) === today);
    const todaySales = todayKnocks.filter(k => k.outcome === "sold").length;
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const weekSales = knocks.filter(k => k.outcome === "sold" && k.knockedAt > weekAgo).length;

    const totalRevenue = commissions.filter(c => c.status === "paid").reduce((s, c) => s + c.amount, 0);
    const pendingPayout = commissions.filter(c => c.status === "approved").reduce((s, c) => s + c.amount, 0);

    const activeClockedIn = (scopeIds ? scopedMembers : members).filter(m => storage.getActiveClockSession(m.id)).length;

    res.json({
      leads: {
        total: leads.length,
        newFiber: leads.filter(l => l.leadTag === "fresh_fiber_confirmed" && l.freshConfidence === "cross_verified").length,
        sold: leads.filter(l => l.leadStatus === "sold").length,
        unassigned: leads.filter(l => !l.assignedRepId).length,
      },
      team: isRep ? { total: 1, activeClockedIn } : { total: scopedMembers.length, activeClockedIn },
      knocks: { total: knocks.length, today: todayKnocks.length, todaySales, weekSales },
      kinetic: { total: Number(kineticAddresses?.total ?? 0), live: Number(kineticAddresses?.live ?? 0) },
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
  void (process.env.SUPER_ADMIN_EMAILS); // apex identity now lives in users.is_super_admin (see requireSuperAdmin)
  function requireSuperAdmin(req: Request, res: Response, next: NextFunction) {
    const user = (req as any).user;
    // P0-1 (K3 swarm): identity is the IMMUTABLE is_super_admin column (stamped
    // at boot from env), never the user-editable email string — a tenant admin
    // could previously self-promote by PATCHing their email to the apex value.
    if (!user || user.role !== "admin" || !(user as any).isSuperAdmin) {
      return res.status(403).json({ error: "Super-admin only" });
    }
    next();
  }

  // GET  /api/sa/tenants           — list all tenants
  app.get("/api/sa/tenants", requireAuth, requireSuperAdmin, (_req: Request, res: Response) => {
    const allTenants = storage.getTenants();
    const enriched = allTenants.map(t => ({
      ...t,
      kfsAuthBasic: undefined,      // never expose keys in list
      enrichmentApiKey: undefined,
      stats: storage.getTenantStats(t.id),
    }));
    res.json(enriched);
  });

  // GET  /api/sa/billing           — cross-tenant billing overview (ops dashboard)
  // One row per tenant with its live billing summary (dark tenants report
  // enabled:false). Reuses billingSummary so it always matches the tenant's own
  // /api/billing view.
  app.get("/api/sa/billing", requireAuth, requireSuperAdmin, (_req: Request, res: Response) => {
    const tenants = storage.getTenants().map(t => ({
      tenantId: t.id,
      companyName: t.companyName,
      slug: t.slug,
      ...billingSummary(t.id),
    }));
    res.json({ plans: Object.values(BILLING_PLANS), tenants });
  });

  // POST /api/sa/tenants           — create a new tenant
  app.post("/api/sa/tenants", requireAuth, requireSuperAdmin, (req: Request, res: Response) => {
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
      recordAdminAudit({
        ...auditContext(req),
        action: "tenant.created", targetType: "tenant", targetId: tenant.id,
        targetLabel: tenant.brandName ?? tenant.companyName,
        // No `before` — the row did not exist. `after` is the created state
        // (secrets redacted by the encoder).
        after: { slug: tenant.slug, companyName: tenant.companyName, ownerEmail: tenant.ownerEmail, plan: tenant.plan, monthlyFee: tenant.monthlyFee, maxReps: tenant.maxReps, status: tenant.status },
        tenantId: tenant.id, outcome: "success",
      });
      res.status(201).json({ tenant, adminUser: { ...adminUser, passwordHash: undefined } });
    } catch (e: any) {
      recordAdminAudit({
        ...auditContext(req), action: "tenant.created", targetType: "tenant",
        targetLabel: String(req.body?.slug ?? req.body?.companyName ?? "").slice(0, 120) || null,
        outcome: "failure", reason: String(e?.message ?? e).slice(0, 200), tenantId: null,
      });
      res.status(400).json({ error: e.message });
    }
  });

  // GET  /api/sa/tenants/:id       — single tenant detail (includes secrets)
  app.get("/api/sa/tenants/:id", requireAuth, requireSuperAdmin, (req: Request, res: Response) => {
    const tenant = storage.getTenantById(Number(req.params.id));
    if (!tenant) return res.status(404).json({ error: "Not found" });
    res.json({ ...tenant, stats: storage.getTenantStats(tenant.id) });
  });

  // GET /api/admin/history — the operations console's history feed.
  //
  // VISIBILITY: a super admin reads platform-wide (every tenant plus
  // tenant-less platform actions); any other admin/manager is walled to their
  // own organization IN SQL, so no filter argument can widen their scope.
  app.get("/api/admin/history", requireManager, (req: Request, res: Response) => {
    const user = (req as any).user;
    const isSuper = Boolean(user?.isSuperAdmin) && user?.role === "admin";
    // Non-super callers MUST have a tenant: an unscoped read would be global.
    const tenantId = isSuper ? null : (user?.tenantId ?? null);
    if (!isSuper && tenantId == null) {
      return res.status(403).json({ error: "Organization context required", code: "TENANT_REQUIRED" });
    }
    // A super admin may narrow to one tenant; nobody else may widen.
    const requested = req.query.tenantId != null ? Number(req.query.tenantId) : null;
    const scope = isSuper && Number.isInteger(requested) ? requested : tenantId;

    const outcome = typeof req.query.outcome === "string" && (ADMIN_AUDIT_OUTCOMES as readonly string[]).includes(req.query.outcome)
      ? (req.query.outcome as any) : undefined;
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 120) : undefined);
    const result = queryAdminAudit({
      tenantId: scope,
      action: str(req.query.action),
      actorUserId: Number.isInteger(Number(req.query.actorUserId)) && req.query.actorUserId != null
        ? Number(req.query.actorUserId) : undefined,
      targetType: str(req.query.targetType),
      outcome,
      from: str(req.query.from),
      to: str(req.query.to),
      q: str(req.query.q),
      limit: Number(req.query.limit ?? 50),
      offset: Number(req.query.offset ?? 0),
    });
    res.json({ ...result, scope: isSuper ? (scope == null ? "platform" : `tenant:${scope}`) : `tenant:${scope}` });
  });

  // Filter facets for the console's menus — same scoping rules as the feed.
  app.get("/api/admin/history/facets", requireManager, (req: Request, res: Response) => {
    const user = (req as any).user;
    const isSuper = Boolean(user?.isSuperAdmin) && user?.role === "admin";
    const tenantId = isSuper ? null : (user?.tenantId ?? null);
    if (!isSuper && tenantId == null) {
      return res.status(403).json({ error: "Organization context required", code: "TENANT_REQUIRED" });
    }
    res.json({ ...adminAuditFacets(tenantId), outcomes: ADMIN_AUDIT_OUTCOMES, canSeeAllTenants: isSuper });
  });

  // PATCH /api/sa/tenants/:id      — update tenant settings
  app.patch("/api/sa/tenants/:id", requireAuth, requireSuperAdmin, (req: Request, res: Response) => {
    // Allowlist — never let the body set id/createdAt (mass-assignment of the PK
    // would remap the tenant and orphan every tenant_id FK).
    const ALLOWED_TENANT_FIELDS = new Set([
      "companyName", "ownerName", "ownerEmail", "ownerPhone", "brandName", "brandColor", "brandLogo",
      "tagline", "plan", "status", "revenueSharePct", "monthlyFee", "trialEndsAt", "billingEmail",
      "maxReps", "allowedMarkets", "notes", "mapboxToken", "scannerSecret", "kfsAuthBasic", "enrichmentApiKey",
    ]);
    const safeTenant: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(req.body ?? {})) if (ALLOWED_TENANT_FIELDS.has(k)) safeTenant[k] = v;
    const id = Number(req.params.id);
    // Read the CURRENT row first so history records real before/after values,
    // not just which field names were touched. Only the fields this request
    // actually changed are recorded — an unchanged field is not history.
    const previous = storage.getTenantById(id);
    const updated = storage.updateTenant(id, safeTenant);
    if (!updated) {
      recordAdminAudit({
        ...auditContext(req), action: "tenant.updated", targetType: "tenant", targetId: id,
        outcome: "failure", reason: "Tenant not found", tenantId: null,
      });
      return res.status(404).json({ error: "Not found" });
    }
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const key of Object.keys(safeTenant)) {
      const was = (previous as any)?.[key];
      const now = (updated as any)?.[key];
      if (was !== now) { before[key] = was; after[key] = now; }
    }
    storage.logActivity((req as any).user.id, "tenant.updated", "tenant", updated.id, { fields: Object.keys(after) });
    recordAdminAudit({
      ...auditContext(req),
      action: "tenant.updated", targetType: "tenant", targetId: updated.id,
      targetLabel: updated.brandName ?? updated.companyName ?? updated.slug,
      before, after,
      // File under the tenant that was CHANGED so that org can see its own
      // history, not under the platform admin who made the change.
      tenantId: updated.id,
      outcome: "success",
    });
    res.json(updated);
  });

  // DELETE /api/sa/tenants/:id     — suspend/delete tenant
  app.delete("/api/sa/tenants/:id", requireAuth, requireSuperAdmin, (req: Request, res: Response) => {
    const tenant = storage.getTenantById(Number(req.params.id));
    if (!tenant) return res.status(404).json({ error: "Not found" });
    const updated = storage.updateTenant(tenant.id, { status: "cancelled" });
    storage.logActivity((req as any).user.id, "tenant.cancelled", "tenant", tenant.id, {});
    recordAdminAudit({
      ...auditContext(req),
      action: "tenant.cancelled", targetType: "tenant", targetId: tenant.id,
      targetLabel: tenant.brandName ?? tenant.companyName ?? tenant.slug,
      before: { status: tenant.status }, after: { status: updated?.status ?? "cancelled" },
      tenantId: tenant.id, outcome: "success",
    });
    res.json({ ok: true });
  });

  // GET  /api/sa/revenue           — revenue summary across all tenants
  app.get("/api/sa/revenue", requireAuth, requireSuperAdmin, (_req: Request, res: Response) => {
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

  // Legacy owner lookup is permanently closed. It bypassed contract approval,
  // budgets, identity matching, DNC, phone validation, encryption, and the
  // Calling authorization boundary. Approved providers are configured and
  // invoked only inside /api/v1/calling.
  app.post("/api/leads/:id/owner-lookup", requireAuth, ownerLookupLimiter, (_req: Request, res: Response) => {
    res.status(410).json({
      error: "Legacy owner lookup has been retired. Use the Calling compliance module.",
      code: "CALLING_MODULE_REQUIRED",
    });
  });



  // ── Nightly Cron Status + Manual Trigger ──────────────────────────────────────
  app.get("/api/cron/status", requireManager, (_req: Request, res: Response) => {
    res.json(getCronStatus());
  });

  // Live closed-loop scan engine status — the AIMD window, block rate, effective
  // throughput, and session refreshes of whatever scan is currently draining.
  app.get("/api/scan/engine-status", requireManager, (_req: Request, res: Response) => {
    res.json(getEngineStatus());
  });

  app.post("/api/cron/trigger", requireAdmin, requireScanningAllowed, async (_req: Request, res: Response) => {
    try {
      await triggerManualScan();
      res.json({ success: true, message: "Nightly scan triggered manually" });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── Proxy Status ──────────────────────────────────────────────────────────────
  app.get("/api/proxy/status", requireAdmin, (_req: Request, res: Response) => {
    res.json(getProxyStatus());
  });

  // Start nightly cron at server boot
  startNightlyCron();
  startStateMonitorScheduler();

}
