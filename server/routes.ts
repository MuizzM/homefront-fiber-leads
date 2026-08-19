import path from "path";
import fs from "fs";
import multer from "multer";
import crypto from "crypto";
import { sendMailResilient, mailFrom, adminInbox, emailShell, escapeHtml, logoAttachment, emailParagraph, emailCodeBox, emailNote } from "./mail";
import type { Express, Request, Response, NextFunction } from "express";
import type { Server } from "http";
import { storage, getDefaultTenantId, orgTimezoneFor, type MapPinRow, type MapPinWindow, type MapView, type TerritoryLeadWrite } from "./storage";
import { localWallToUtcMs, localYmdParts } from "@shared/workweek";
import { billingSummary, getCreditLedger, isBillingEnabled, ensureBilling, setBillingState, setPlan, grantCredits, getBilling, scanBlockReason } from "./billingStore";
import { PLANS as BILLING_PLANS, isBillingState, isOverageMode } from "@shared/billing";
import { stripeConfigured, webhookConfigured, verifyStripeSignature, createCheckoutSession, createPortalSession, processWebhookEvent } from "./stripeAdapter";
import Database from "better-sqlite3";
import { z } from "zod";
import { packMapPins, type PackedMapPins } from "@shared/mapPinsWire";
import { decideFreshFiber, type FreshFiberVerdict } from "@shared/freshFiberVerdict";
import { structuredLog } from "./structuredLog";
import { inlineScriptHashes } from "./cspHashes";
import {
  recordAdminAudit, auditContext, queryAdminAudit, adminAuditFacets, ADMIN_AUDIT_OUTCOMES,
} from "./adminAudit";
import {
  previewNextPass, startNextPass, listTerritoryPasses, currentPassOf,
} from "./territoryPass";
import { isTerritoryPassAction, type TerritoryPassAction } from "@shared/territoryPass";
import { rawDb } from "./db";
import {
  emitLeadEvent, onLeadEvent, eventsSince, leadEventsCursor, leadEventsEpoch,
  type LeadEvent, type LeadEventType,
} from "./leadEvents";
import * as readyToCall from "./readyToCallStore";
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
import { colorForRep, repColorOf } from "@shared/repColors";
import { isTrainingLessonId, TOTAL_TRAINING_LESSONS } from "@shared/trainingContent";
import { computeTerritoryMetrics } from "@shared/territoryMetrics";
import { repCanWorkLead } from "@shared/leadVisibility";
import { cachedScopeLookup } from "./territoryScopeCache";
import { polygonCovers, BOUNDARY_EPSILON_DEG } from "@shared/geo";
import { validateRing, crossesAntimeridian } from "@shared/polygonGeometry";
import { padHull, subdivideCluster, convexHull } from "@shared/opportunity";
import { can } from "@shared/permissions";
import { isLeadMarkOrClear, normalizeLeadMark } from "@shared/leadMark";
import { sameTenantRead, sameTenantWrite } from "./tenantGuard";
import { canReadScanJob } from "./scanJobScope";
import { canActOnMember, canHireRole, HIRABLE_ROLES as SHARED_HIRABLE_ROLES, wouldCreateReportsCycle, isValidSupervisorRole, hierarchyRank, branchOwnerOf } from "@shared/teamHierarchy";
import { unassignRep, reclaimTerritory, canRepTakeAnotherArea, territoryHeldByAny, territoryUnassigned, normalizeTerritoryColor, areaGrantedRepIds, parseAreaDeleteRepPolicy, parseAssigneeIds, MAX_ACTIVE_AREAS_PER_REP, MAX_AREA_ASSIGNEES, type ReclaimMode, type TerritoryState, type TerritoryStatus } from "@shared/territory";
import { OUTCOME_TO_STATUS, OUTCOME_META, deriveWasHome, isKnockOutcome, isBulkStatusOutcome, pinDisplayState, type KnockOutcome } from "@shared/knock";
import { classifyKnockLocation, countsAsWorked, type VerificationStatus } from "@shared/geoVerify";
import {
  calcCommission, pickActiveStructure, describeStructure,
  type CommissionStructure, type Tier, type CalcType,
} from "@shared/commission";
import type { CommissionRate, TeamMember } from "@shared/schema";
import { LEGACY_COMMISSION_STATUSES } from "@shared/legacyCommissionLifecycle";
import {
  can as hasCapability, capabilitiesFor, groupedCapabilities, rolesWithCapability, isHighRisk,
  type Capability, type Role,
} from "@shared/capabilities";
import { buildDiagnostics, APP_VERSION } from "@shared/diagnostics";
import { registerCommissionRoutes } from "./commissionRoutes";
import { registerCommissionOverrideRoutes } from "./commissionOverrideRoutes";
import { registerHourlyPayRoutes } from "./hourlyPayRoutes";
import { registerPayoutRoutes } from "./payoutRoutes";
import { registerPayRoutes } from "./payRoutes";
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
import {
  confirmCommissionInstall,
  getTenantPayPolicy,
  upsertTenantPayPolicy,
} from "./payPolicyStore";
import { isCommissionHeld, payableAfterFor, HOLD_DAYS_MAX } from "@shared/commissionHold";
import type { CommissionTier } from "@shared/commissionTiers";
import type { CommissionTerms } from "@shared/commissionTerms";
import { getHrCheckpoint, listHrCheckpoints, setHrCheckpoint, summariseHr } from "./onboardingHrStore";
import { verifyGustoConnection } from "./gustoAdapter";
import {
  HR_CHECKPOINT_META,
  isHrCheckpointKind,
  isValidHrStatus,
  type HrCheckpointKind,
} from "../shared/onboardingHr";
import { resendConfigured, sendResendEmail } from "./resendMail";
import * as commissionSvc from "./commissionService";
import * as spiffStore from "./spiffStore";
import { registerSpiffCampaignRoutes } from "./spiffCampaignRoutes";
import { registerMileageRoutes } from "./mileageRoutes";
import { registerLiveOpsRoutes, notifyLiveOpsChanged } from "./liveOpsRoutes";
import { registerRepMetricsRoutes } from "./repMetricsRoutes";
import { ingestFix, getLiveStates, clearLiveStateForRep } from "./liveOpsStore";
import { liveOpsScope } from "./liveOpsScope";
import { registerReferralRoutes } from "./referralRoutes";
import { pathAllowedWhileGated } from "@shared/trainingGate";
import {
  isUserTrainingGated, statusFor as trainingGateStatus, setTrainingRequired,
  requiredLessons, setRequiredLessons, trainingRoster,
} from "./trainingGateStore";
import { awardCampaignsForRep } from "./spiffCampaignStore";
import { awardMilestonesForRep } from "./knockMilestoneStore";
import { armMomentumOffer, convertMomentumOffer } from "./momentumSpiffStore";
import { rollDoorDrop } from "./doorDropStore";
import { awardDoorDayForRep } from "./genuineDoorBonusStore";
import { awardAchievementsForRep } from "./salesAchievementStore";
import { publishSale, publishStreak, publishAuthored, feedForUser, markRead, sentAuthored, deleteAuthored } from "./teamFeedStore";
import {
  postChatMessage, chatPageFor, markChatRead, deleteChatMessage,
  openDm, createGroup, myThreads, threadPageFor, postThreadMessage,
  markThreadRead, threadsUnreadTotal, updateGroupMembers, deleteGroupThread, leaveGroup,
} from "./floorChatStore";
import { GROUP_MEMBER_MAX } from "@shared/floorChat";
import { earningsToday } from "./earningsTodayStore";
import { emitAnnouncement, onAnnouncement } from "./announcementBus";
import { visibleTo, usd as feedUsd } from "@shared/teamFeed";
import {
  publicKey as pushPublicKey, saveSubscription, removeSubscription,
  pushToUsers, tenantUserIds, subscriptionCount,
} from "./pushStore";
import { isAllowedPushEndpoint } from "./webPush";
import { DEFAULT_SPIFF_CONFIG, spiffAmountBand, spiffAmountLadder, spiffTriggerGuide } from "@shared/spiffEngine";
import { registerAddressDiscoveryRoutes } from "./addressDiscovery/routes";
import { discoveryUploadBodyParser } from "./bodyParsers";
import { registerCallingRoutes } from "./calling/routes";
import { registerAreaSkipTraceRoutes } from "./areaSkipTraceRoutes";
import { tracedPhonesForLead, cancelAreaSkipTraceRuns } from "./areaSkipTrace";
import { closeAllAssignments, assignmentHistory } from "./territoryAssignments";
import { registerFiberOperationsRoutes } from "./fiberOperationsRoutes";
import { registerComingSoonRoutes } from "./comingSoonWatchlist";
import { registerLeadRankingRoutes } from "./leadRanking";
import { registerKineticScannerRoutes } from "./kineticScannerRoutes";
import { registerKineticBuildRoutes } from "./kineticBuildRoutes";
import { registerTrainingEngineRoutes, payRampBonus } from "./trainingEngine";
import { registerAcademyRoutes } from "./academyRoutes";
import { registerVendorOrderRoutes } from "./vendorOrderRoutes";
import { registerCommissionFileRoutes } from "./commissionFileRoutes";
import { registerGuardedActionRoutes } from "./guardedActionRoutes";
import { registerAddressPointRoutes } from "./addressPointRoutes";

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
import { authorizedScanAdmission, onboardingLimiter, geocodeLimiter, rescanPoolLimiter, chatPostLimiter, ipBucketKey } from "./limiters";
import { scanSseCaps } from "./scanSseCaps";
import { otpRateBuckets } from "./otpRateBuckets";
import { validateLeadPatch, rescanPoolPlan, clampActivityLogLimit, validateTerritoryRequestMessage, filterInChunks, RESCAN_POOL_MAX_TARGETS, RESCAN_POOL_CHUNK_SIZE as RESCAN_POOL_CHUNK } from "./routeInputPolicy";
import { sniffUploadedFile, uploadKindAllowed } from "./uploadSniff";
import * as scanSvc from "./scanService";
import {
  CORROBORATION_SOURCES, freshPoints, knockList, listMarkets, monitoringSummary,
  operationalMetrics, recordCorroboration, seedStateMarkets, syncMarketState, toCsv,
} from "./stateMonitorStore";
import { clusterFreshFiber } from "@shared/freshFiberClusters";
import { flushFreshOpportunityAlerts, getStateMonitorStatus, runStateMonitorTick, startStateMonitorScheduler } from "./stateMonitorScheduler";
import { announcementSourceStatus, pollAnnouncementsIfDue } from "./announcementWatcher";
import { CATALOG_OBSERVED_AT, KINETIC_DIRECTORY_URLS, KINETIC_MONITORED_STATES, refreshKineticLocationDirectory } from "./kineticMarketCatalog";
import * as sweepService from "./sweepService";
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

// The scan/import dedup sites only ever need the normalized-address set - one
// narrow single-column read instead of hydrating every ~45-column lead row
// (plus an ORDER BY nothing consumed) through storage.getLeads. No tenantId
// keeps the cross-tenant semantics the unscoped call sites had.
function existingAddrDedupSet(tenantId?: number): Set<string> {
  const rows = (tenantId != null
    ? rawDb.prepare(`SELECT address FROM leads WHERE tenant_id = ?`).all(tenantId)
    : rawDb.prepare(`SELECT address FROM leads`).all()) as Array<{ address: string | null }>;
  return new Set(rows.map((r) => normalizeAddrForDedup(r.address || "")));
}

// Bbox prefilter for the polygon-enclosure scans: candidates come from an
// indexed lat/lng window instead of hydrating every tenant lead, and
// polygonCovers then makes the exact call on the survivors only. Rings are
// stored [lng, lat] (shared/geo.ts). The box is padded by the same epsilon
// that makes a boundary door count, so a door sitting a hair outside the box
// but on the line is still tested. Rows with NULL coords fall out of BETWEEN
// exactly as the callers' `lat != null && lng != null` guards dropped them.
function leadsInRingBbox(polygon: [number, number][], tenantId: number | undefined, columns: string): any[] {
  if (!Array.isArray(polygon) || polygon.length < 3) return [];
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const p of polygon) {
    const lng = p?.[0], lat = p?.[1];
    if (lng < w) w = lng;
    if (lng > e) e = lng;
    if (lat < s) s = lat;
    if (lat > n) n = lat;
  }
  const pad = BOUNDARY_EPSILON_DEG;
  const tenantAnd = tenantId != null ? " AND tenant_id = ?" : "";
  return rawDb.prepare(
    `SELECT ${columns} FROM leads
      WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?${tenantAnd}`,
  ).all(s - pad, n + pad, w - pad, e + pad, ...(tenantId != null ? [tenantId] : []));
}

// ── Email (Resend/SMTP via env — see server/mail.ts; dev console fallback) ──
function otpMessage(to: string, code: string, name: string) {
  const first = escapeHtml((name || "").trim().split(" ")[0] || "there");
  return {
    to,
    subject: "Your Home Front Solutions sign-in code",
    text: `Hi ${(name || "").split(" ")[0] || "there"}, your Home Front Solutions sign-in code is ${code}. It expires in 10 minutes. Never share this code - we will never ask for it.`,
    html: emailShell({
      preheader: `Your sign-in code is ${code} - expires in 10 minutes`,
      heading: "Your sign-in code",
      bodyHtml:
        emailParagraph(`Hi ${first}, use this one-time code to sign in:`) +
        emailCodeBox(code) +
        emailNote(`This code expires in <strong style="color:#4a5a68;">10 minutes</strong>. Never share it - Home Front Solutions will never ask you for it.`),
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
      console.warn(`[otp] Resend API send failed (${String(e?.message ?? e).slice(0, 140)}) - trying SMTP`);
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
  // The training gate rides HERE rather than being registered separately,
  // because every authenticated route in the app reaches auth through this
  // function (directly, or via requireAdmin/requireTeamLead/requireManager/
  // requireCapability, which all delegate to it). Hanging the gate off one
  // choke point is the only way to be sure a route added next month is covered
  // by default instead of by whoever remembers to add it.
  //
  // The org-status gate rides the same choke point, and runs FIRST: an org that
  // has been suspended stops being able to use the app whether or not the person
  // holding the session has finished training.
  return orgStatusGate(req, res, () => trainingGate(req, res, next));
}

// ── Organization status gate ────────────────────────────────────────────────
// A SUSPENDED or CANCELLED organization loses access — including sessions that
// were minted before the flip, which is exactly why this rides on requireAuth
// rather than on login alone. Before this existed, `tenants.status` was written
// by the super-admin console (`DELETE /api/sa/tenants/:id`) and read by nothing
// at request time, so every user of a cancelled org kept working indefinitely.
//
// Deliberately scoped to cancelled/suspended ONLY. Billing state lives on a
// different column (`tenant_billing.state`) and is NEVER a gate here — see the
// owner directive on requireScanningAllowed.
//
// Fail-OPEN on an internal error, for the same reason the training gate does: a
// bug in this lookup must never lock an entire floor out of the app mid-shift.
// A cancelled org retaining access for an hour is a far smaller problem than
// every live org losing the app at once.
const ORG_BLOCKING_STATUSES: ReadonlySet<string> = new Set(["cancelled", "suspended"]);

// The org gate gets its OWN allowlist rather than borrowing the training gate's.
// That list answers a different question — "what does an untrained rep need in
// order to become employable" — and includes the whole recruiting plane:
// /api/onboarding sends invitations and approval emails on the platform's own
// mail domain and mints user accounts. A suspended organization must not keep
// hiring. This list is only what the lock screen itself needs: know who you are,
// read the notice, sign out.
const ORG_GATE_ALLOWED_PREFIXES: readonly string[] = [
  "/api/auth",           // session read + logout — never trap someone signed in
  "/api/health",
  "/api/notifications",  // the "your organization is inactive" notice has to arrive
];
const orgGateAllows = (path: string): boolean => {
  const p = String(path ?? "");
  return ORG_GATE_ALLOWED_PREFIXES.some(prefix => p === prefix || p.startsWith(`${prefix}/`));
};

function orgStatusGate(req: Request, res: Response, next: NextFunction) {
  const user = (req as any).user;
  if (!user) return next();
  // The platform owner administers organizations from outside all of them —
  // gating them on a tenant status would lock the only identity that can undo it.
  if (user.isSuperAdmin || user.tenantId == null) return next();
  // Never trap a signed-in person without a route to read who they are, see the
  // notice, or sign out — but nothing wider than that (see ORG_GATE_ALLOWED_PREFIXES).
  if (orgGateAllows(req.path)) return next();
  try {
    const tenant = storage.getTenantById(user.tenantId);
    const status = String(tenant?.status ?? "active").toLowerCase();
    if (!ORG_BLOCKING_STATUSES.has(status)) return next();
    return res.status(403).json({
      error: "This organization is no longer active. Contact your administrator.",
      code: "ORGANIZATION_INACTIVE",
    });
  } catch (e: any) {
    console.warn("[org-status-gate] check failed, allowing through:", e?.message);
    return next();
  }
}

// ── Training gate ───────────────────────────────────────────────────────────
// A new rep finishes training before they touch the field. This middleware is
// what makes that a LOCK rather than a hidden menu: it runs after requireAuth on
// every /api route, so a gated rep who types a URL, replays a saved request, or
// drives the app from a script is refused exactly as if they had tapped.
//
// It reads the same predicate the client nav reads (shared/trainingGate.ts), so
// what a rep can see and what the server will answer cannot drift apart.
//
// Deliberately fail-OPEN on an internal error. A crash in the gate must not lock
// the whole floor out of the app mid-shift; an untrained rep reaching the map for
// an hour is a far smaller problem than every rep losing the map at once.
function trainingGate(req: Request, res: Response, next: NextFunction) {
  const user = (req as any).user;
  if (!user) return next();
  if (pathAllowedWhileGated(req.path)) return next();
  try {
    if (!isUserTrainingGated(user)) return next();
  } catch (e: any) {
    console.warn("[training-gate] check failed, allowing through:", e?.message);
    return next();
  }
  return res.status(403).json({
    error: "Finish your training to unlock this.",
    code: "TRAINING_REQUIRED",
  });
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
// Areas a scoped caller works — as primary OR as one of several assignees.
// Cached per request-ish by callers that need it in a loop; cheap enough here
// (one indexed scan) that correctness beats micro-optimisation.
/**
 * The colour an area keeps when it changes hands.
 *
 * Every reassignment route used to stamp colorForRep(newPrimary), on the theory
 * that the fill told you who was working the ground. That theory is spent: the
 * per-rep halos on the pins say who, and an area can be held by three people at
 * once, so one fill cannot name them. What the fill says now is WHICH AREA this
 * is — the colour the admin chose while drawing it — and that must not change
 * because the area was handed to someone else. Draw it green, share it, it is
 * still green.
 *
 * colorForRep remains the fallback for rows with no stored colour (created
 * before the colour was captured) so nothing renders colourless.
 */
function retainedAreaColor(territory: unknown, fallbackRepId: number | null | undefined): string {
  const stored = normalizeTerritoryColor((territory as any)?.color);
  if (stored) return stored;
  // Fallback follows the rep's PERSISTED colour (team_members.color) when the
  // member row exists; repColorOf degrades to the legacy hash for NULL columns,
  // and a dangling rep id keeps the old hash behaviour verbatim.
  const member = fallbackRepId != null ? storage.getTeamMemberById(fallbackRepId) : undefined;
  return member ? repColorOf(member) : colorForRep(fallbackRepId ?? null);
}

function territoryIdsForScope(scope: number[], tenantId?: number | null): Set<number> {
  // Memoised on a version stamp every territory write bumps. This is asked once
  // per SSE event PER SUBSCRIBER, and the uncached form is a full territory scan
  // with a JSON.parse per row — 53.86ms and 200k parses at 200 areas / 10
  // subscribers / 100 events. The stamp is what keeps it safe: a reclaim bumps
  // it, so a rep cannot keep reading doors in an area taken from them.
  return cachedScopeLookup(`${tenantId ?? "-"}:${scope.join(",")}`, () =>
    computeTerritoryIdsForScope(scope, tenantId));
}

function computeTerritoryIdsForScope(scope: number[], tenantId?: number | null): Set<number> {
  const out = new Set<number>();
  for (const t of storage.getTerritories(tenantId ?? undefined) as any[]) {
    // territoryHeldByAny, not a repId check first. This used to test repId before
    // falling back to assignee_ids, and repId still names the last holder after a
    // reclaim — so a rep who had an area taken off them kept reading its doors.
    if (territoryHeldByAny(t, scope)) out.add(t.id);
  }
  return out;
}

// An area can be worked by SEVERAL reps. Lead access therefore cannot hang on
// leads.assigned_rep_id alone — that column names ONE rep, so on a shared area
// exactly one assignee could see the doors and everyone else got a 404 for
// ground they were assigned to. Access now also passes when the caller holds the
// lead's TERRITORY, which is where "who works this" is already many-to-many.
//
// OPEN FIELD (owner report: ~62k imported town leads carry assigned_rep_id=NULL
// AND assigned_territory_id=NULL, and reps in the field could not log a single
// knock on them): a lead owned by NOBODY — no rep, no territory — is unworked
// ground in the tenant pool, so ANY scoped rep in the tenant may access it
// (self-serve). A lead assigned to ANOTHER rep, sitting in an area another
// team holds, or belonging to another tenant stays denied exactly as before.
//
// Caller audit — every call site is a read or a field-disposition path, so the
// open-field rule is correct in each: single-lead/knock/history/notes/photo/
// enrichment reads, the SSE stream's per-event wall, the add-lead duplicate
// "inYourScope" hint, the knock route itself, bulk-status, and the
// ready-to-call claim/outcome pair. Management semantics live in SEPARATE
// predicates and are deliberately NOT widened: reassignment (canReassignLead)
// stays team-lead-of-the-team/manager, territory admin (canManageTerritory)
// unchanged, and central-disposition is requireManager before any scope check.
// Knocking an open-field lead never ASSIGNS it — access, not ownership.
//
// The tenant wall is unaffected: callers reach this only after the lead's tenant
// has been checked, and the territory scan is tenant-filtered too.
// The rule itself lives in shared/leadVisibility.ts and is expressed there
// TWICE — as this predicate and as the SQL the map's set queries compose. They
// used to be two independent hand-written copies, and they had drifted: the SQL
// omitted the open-field branch, so a door with no rep and no territory was
// legal to knock here and never rendered as a pin. A rep cannot knock a pin
// that was never drawn. Both encodings are pinned against each other by tests.
function repCanAccessLead(user: any, lead: any): boolean {
  const scope = leadVisibilityScope(user);
  if (scope === undefined) return true;
  if (!lead) return false;
  return repCanWorkLead(
    lead,
    scope as number[],
    territoryIdsForScope(scope as number[], user?.tenantId),
    storage.openFieldEnabled(user?.tenantId),
  );
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
// The max-active-areas cap, in one place. /assign checked it inline while
// reclaim(reassign), share and next-pass(reassign) handed out areas without
// asking — so the cap was advisory on every path except the least-used one.
// Returns an error message when the rep is full, null when they have room.
//
// Areas the rep ALREADY holds are excluded: re-sharing or re-confirming an area
// they're on is not a new area, and counting it would refuse a no-op.
// tenantId caps the COUNT to the caller's org: without it the scan crossed
// tenants, so a rep id that happened to collide with a busy rep in another org
// read as "at cap" here while genuinely holding nothing in this one.
function repAtAreaCap(repId: number, excludeTerritoryId?: number, tenantId?: number): string | null {
  const active = storage.getTerritoriesByRep(repId, tenantId).filter((x: any) =>
    (x.status === "active" || x.status === "shared") && x.id !== excludeTerritoryId);
  if (canRepTakeAnotherArea(active.length)) return null;
  const rep = storage.getTeamMemberById(repId);
  return `${rep?.name ?? "That rep"} already has ${active.length} active areas (max ${MAX_ACTIVE_AREAS_PER_REP}).`;
}

function canManageTerritory(user: any, terr: any): boolean {
  const scope = leadVisibilityScope(user);
  if (scope === undefined) return true;  // manager+ — unrestricted
  if (!terr) return false;
  // territoryHeldByAny is THE holder rule (assignee_ids authoritative, repId
  // legacy fallback only). This block was the fourth hand-rolled paraphrase of
  // it — the shape that twice leaked reclaimed areas back to their old rep.
  if (territoryHeldByAny(terr, scope as number[])) return true;
  const assignees = parseAssigneeIds(terr.assigneeIds) ?? [];

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

// ── Live lead events: the one way a completed write reaches GET /api/leads/stream ──
// Every call site below is one line so that adding a lead mutation and forgetting
// the live update look different in a diff. Three rules the helpers encode once:
//
//  • POST-WRITE ROW, always. The stream authorizes each event by running
//    repCanAccessLead() against the projection the event carries, so a pre-write
//    row would address the update using assignment state that no longer exists —
//    i.e. deliver it to the previous holder and nobody else.
//  • AFTER COMMIT, never inside a transaction. Several call sites wrap their loop
//    in rawDb.transaction(); emitting in there would announce a change a rollback
//    then erases, and the ring has no retraction.
//  • BEST-EFFORT. emitLeadEvent never throws and returns null for input it cannot
//    wall, so a notification problem can never change a write's outcome or shape
//    its response. The durable record is the leads table; this is the edge.
function emitLeadChange(type: LeadEventType, lead: any, actor: any, tenantIdFallback?: number | null): void {
  if (lead?.id == null) return;
  emitLeadEvent({
    // The row's own tenant first: on the territory paths the caller may be an
    // org-wide admin whose session tenant is not the door's.
    tenantId: Number(lead.tenantId ?? tenantIdFallback ?? actor?.tenantId ?? 0),
    leadId: Number(lead.id),
    type,
    actorId: actor?.id ?? null,
    actorName: actor?.name ?? null,
    lead,
  });
}

// Same contract for the write paths that hand back a count or a boolean instead
// of the row — the bulk loops and every raw-SQL UPDATE. One indexed point-read
// per CHANGED lead (never per candidate id) buys the state the subscriber has to
// authorize against; without it the event carries no pin and every scoped rep
// fails the access check on it.
function emitLeadChangeById(type: LeadEventType, leadId: number, actor: any, tenantIdFallback?: number | null): void {
  const fresh = storage.getLeadById(Number(leadId));
  if (fresh) emitLeadChange(type, fresh, actor, tenantIdFallback);
}

// A lasso or an area reset can move more doors than the event ring holds (25k is
// a legal bulk-assign). Past a point, per-lead events stop helping and start
// hurting: they evict the reconnect window of every OTHER tenant sharing the
// process, while the client they were meant for is told `gapped` and refetches
// anyway. So a bulk path emits up to this many and then stops. The bound is the
// module's own per-replay cap, so one bulk action can never overflow a single
// replay call; the rest is covered by the tenant-wide map-changed ping that all
// of these paths already fire through bustMapCache — one refetch instead of tens
// of thousands of frames.
const LEAD_EVENT_BULK_MAX = 200;

function emitLeadChangesBulk(type: LeadEventType, leadIds: number[], actor: any, tenantIdFallback?: number | null): void {
  for (let i = 0; i < leadIds.length && i < LEAD_EVENT_BULK_MAX; i++) {
    emitLeadChangeById(type, leadIds[i], actor, tenantIdFallback);
  }
}

// Version stamp for each lead stream's memoised access inputs (visibility
// scope roster + open-field flag) — same pattern as cachedScopeLookup: bumped
// UNCONDITIONALLY on every team write and tenant-config write, never by
// reasoning about which fields matter. Uncached, a team_lead subscriber
// re-hydrated the tenant roster on EVERY event delivered — 200-400 DB reads
// per second of pure fan-out on a busy floor with the stream cap full.
// Module-level: the team routes live in registerRoutes, the tenant PATCH in
// registerSaasRoutes, and both must move the same stamp.
let streamAccessVersion = 1;
function bumpStreamAccessVersion(): void { streamAccessVersion++; }

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

// Tenancy of knock-booked money comes from the KNOCK ROW (itself derived from
// the lead at insert) — NEVER from the caller's session. Falling back to the
// requester's tenant cross-books a sale into whatever org the requester sits
// in. The adopted-row default is the only legitimate NULL fallback; when even
// that is absent the sale is unbookable (the route answers 409, never a
// cross-tenant booking).
export function resolveKnockSaleTenant(
  knockTenantId: number | null | undefined,
  defaultTenantId: number | null,
): number | null {
  return knockTenantId ?? defaultTenantId ?? null;
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
// Bulk ASSIGN is set-based + chunked (two statements per chunk, with an
// event-loop yield between chunks), so it is not bound by the per-row cost that
// caps the other bulk routes.
//
// THIS CAP IS THE BODY LIMIT, not a work limit. The global API JSON parser
// accepts 64 KB (server/index.ts) and a production lead id costs ~8 bytes on the
// wire, so a request larger than this dies at the PARSER - before the route, and
// therefore before the friendly BULK_TOO_LARGE message. The old default of
// 25,000 was unreachable by roughly 3x and turned into an unexplained network
// failure in the browser. 6,000 ids is ~48 KB, which leaves headroom for the
// envelope and for ids that grow another digit.
//
// Callers with more doors than this do not need a bigger body: they should send
// the RING to /api/leads/assign-selection, whose payload does not grow with the
// door count at all.
const MAX_BULK_ASSIGN_LEADS = Math.max(500, Number(process.env.MAX_BULK_ASSIGN_LEADS) || 6_000);
// Doors written per transaction. Bounds two separate things: how long the write
// lock is held (a checkpoint collision can stall at most one chunk) and how long
// the event loop goes unyielded. Far below SQLite's 32,766 bound variables.
const ASSIGN_CHUNK = Math.max(100, Math.min(5_000, Number(process.env.ASSIGN_CHUNK) || 1_000));
// Runaway guard on a resolved selection. Not a payload limit - assign-selection
// ships a ring, so the request is a couple of KB either way.
const MAX_ASSIGN_SELECTION = Math.max(1_000, Number(process.env.MAX_ASSIGN_SELECTION) || 250_000);
// Bbox candidates examined before the exact ring test. Exceeding it REFUSES the
// request rather than truncating: a dropped bbox row is a door inside the ring
// that silently never got assigned.
const MAX_ASSIGN_BBOX_CANDIDATES = Math.max(10_000, Number(process.env.MAX_ASSIGN_BBOX_CANDIDATES) || 400_000);
// A freehand stroke is already validated and simplified client-side; this only
// stops a hand-written caller from posting a ring that costs more to test than
// the doors it encloses.
const MAX_ASSIGN_RING_POINTS = 10_000;
// Manual deselects are small by nature. Bounded so assign-selection can never
// quietly become the id-shipping path this route exists to replace.
const MAX_ASSIGN_EXCLUDES = 5_000;
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

  registerAddressDiscoveryRoutes(app, { requireAuth, requireCapability, requireScanningAllowed, uploadBodyParser: discoveryUploadBodyParser });
  registerCallingRoutes(app, { requireAuth, requireCapability });
  // Area skip trace reuses the SAME ownership rule as every other territory
  // action, so a team lead can trace their own areas and nobody else's.
  registerAreaSkipTraceRoutes(app, {
    requireAuth,
    requireCapability,
    canManageArea: (req: any, territoryId: number) =>
      canManageTerritory(req.user, storage.getTerritoryById(territoryId, req.user?.tenantId ?? undefined)),
  });
  registerFiberOperationsRoutes(app, {
    requireAuth, requireCapability, requireScanningAllowed, scanAdmission: authorizedScanAdmission,
  });
  registerKineticScannerRoutes(app, {
    requireCapability, requireScanningAllowed, scanAdmission: authorizedScanAdmission,
  });
  // Coming-Soon watchlist (rep-facing) + ranked fresh leads — same injected-auth pattern.
  registerComingSoonRoutes(app, { requireAuth, requireManager });
  registerLeadRankingRoutes(app, { requireAuth, visibilityScope: leadVisibilityScope });
  // Kinetic 2026 builds: FCC vintage import + the field-map layer. The whole
  // surface 404s unless KINETIC_2026_BUILDS is enabled, so registering it is
  // safe on every deployment.
  registerKineticBuildRoutes(app, { requireAuth, requireCapability });

  // ── Weekly commission (Phase 2) internal API — injects the shared auth
  // middleware so authorization matches the rest of the app. ────────────────────
  registerCommissionRoutes(app, { requireAuth, requireCapability });
  // Downline override sheet + exceptions console — same injected auth.
  registerCommissionOverrideRoutes(app, { requireAuth, requireCapability });
  // Hourly pay plane (rates, punch corrections, pay disputes) — same injected auth.
  registerHourlyPayRoutes(app, { requireAuth, requireCapability });
  registerPayoutRoutes(app, { requireAuth, requireCapability });
  registerOnboardingDocumentRoutes(app, { requireAuth, requireCapability });
  // ── PAY-A2: contractor banking + W-9 + NACHA ACH export ─────────────────────
  registerPayRoutes(app, { requireAuth, requireCapability });
  // Manager-launched SPIFF contests — awards land in the existing spiffs ledger.
  registerSpiffCampaignRoutes(app, { requireAuth, requireCapability });
  // Mileage: trip logging, the approval queue, and the org rate. Reimbursement
  // MONEY stays behind mileage.reimbursement_enabled (off for every org until an
  // operator turns it on) — see the note in server/mileageStore.ts.
  registerMileageRoutes(app, { requireAuth, requireCapability });
  registerLiveOpsRoutes(app, { requireAuth, requireCapability });
  // Rep metrics and field performance. Registered alongside live ops because
  // the two share a scope resolver and a privacy contract: live ops answers
  // "where is everyone right now", metrics answers "how is everyone doing", and
  // keeping them on separate route modules is what stops the second quietly
  // becoming a way to reach the first without an audit row.
  registerRepMetricsRoutes(app, { requireAuth, requireCapability });
  // Rep-referral program. Ships DARK (referral.program.enabled = false), so the
  // link and pipeline render but no attribution is accepted and no reward is
  // ever created until an admin turns it on.
  registerReferralRoutes(app, { requireAuth, requireCapability });
  // CE-1 drill engine — due deck, review capture, coach summary. Lives under
  // /api/training, so the training gate's allowlist already covers it.
  registerTrainingEngineRoutes(app, { requireAuth });
  // Fiber Sales Academy — guided path, role-play coaching, pitch lab and the
  // market offer catalog. Also under /api/training, for the same gate reason:
  // a new hire who has not cleared training must be able to reach the thing
  // that clears it.
  registerAcademyRoutes(app, { requireAuth, requireCapability });
  // Provider order status + recovery (PerfectVision submitted orders). Safe to
  // register unconditionally: automated retrieval and automated messaging are
  // both behind process flags that ship off, and every route is capability-
  // gated, so an organization that has never uploaded a report sees an empty
  // screen rather than a missing one.
  registerVendorOrderRoutes(app, { requireAuth, requireCapability });
  // The Commission File plane (PerfectVision provider-paid truth). Safe to
  // register unconditionally for the same reason: uploads are capability-
  // gated, there is no automated retrieval at all, and until a file is
  // imported the plane is empty tables behind an admin screen.
  registerCommissionFileRoutes(app, { requireAuth, requireCapability });

  // The guarded-action gate: the approval queue and undo journal in front of
  // dangerous writes. Registered unconditionally and inert by default - every
  // route in it checks GUARDED_ACTIONS_ENABLED first and answers 404 without
  // it, so mounting the surface changes nothing until the flag is turned on.
  registerGuardedActionRoutes(app, { requireAuth, requireCapability });

  // County E911 address points: the house-number layer's data source, and the
  // thing that lets a lasso create a lead for every door inside it rather than
  // only select the ones that already existed.
  registerAddressPointRoutes(app, {
    requireAuth, requireTeamLead, requireAdmin,
    // The lasso-create route assigns leads, so it needs the same scope and
    // tenant rules /assign-selection applies. Injected so there is ONE
    // implementation of each and they cannot drift apart.
    repInVisibilityScope, repInCallerTenant,
  });

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


  // ── Evidence-backed multi-state Kinetic market catalog ─────────────────────
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
      source: "Kinetic official FL/GA/IA/KY/NC/SC fiber and other-high-speed location directories",
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
    const stateUser = (_req as any).user;
    const activeJob = Array.from(scanJobs.values()).find(j =>
      j.status === "running" && canReadScanJob(stateUser, j));
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
    /** Serialized object-format body, memoised the same way `packed` is. The
     *  packed form already cached its build; the object form handed the raw
     *  array to res.json, so JSON.stringify re-ran over every pin on every
     *  cache HIT — ~27ms of blocked single-thread time on a 20k-pin tenant,
     *  paid by every rep's home screen and every map poll. Entries are dropped
     *  wholesale by bustMapCache, so this string can never go stale. */
    json?: string;
    /** Same memo for the packed format's serialized body. */
    packedJson?: string;
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

  function getMapPins(tenantId?: number, repFilter?: number | number[], dataVer?: string, view?: MapView): {
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
    // The view lens keys the cache too: a "latest" entry can never serve the
    // unfiltered feed (or vice versa) — same rule as the scope key.
    const scopeKey = repFilter == null ? "all" : [repFilter].flat().sort((a, b) => a - b).join(",");
    const cacheKey = `${tenantId ?? 0}|${scopeKey}|${view ?? ""}`;
    const hit = _mapPinCache.get(cacheKey);
    // Reuse only within TTL AND if the DB hasn't changed (a scan in another
    // process bumps dataVer) — never serve stale pins after new leads land.
    if (hit && now - hit.ts < MAP_CACHE_TTL && (dataVer == null || hit.ver === dataVer)) {
      return { entry: hit, cacheHit: true, scopeKey };
    }
    const dbStarted = performance.now();
    // Narrow projection + latest-visit metadata in one scoped SQL query.
    const all = storage.getLeadsForMap(tenantId, repFilter, undefined, view);
    const dbMs = performance.now() - dbStarted;
    const buildStarted = performance.now();
    const pins = buildMapPins(all);
    const entry: MapPinCacheEntry = {
      ts: Date.now(), pins, ver: dataVer, dbMs,
      buildMs: performance.now() - buildStarted,
    };
    if (_mapPinCache.size > 500) _mapPinCache.clear(); // soft cap — bound stale-scope accumulation
    _mapPinCache.set(cacheKey, entry);
    return { entry, cacheHit: false, scopeKey };
  }

  // Rows → compact wire pins. Shared by the cached full feed (getMapPins) and
  // the uncached bbox-window path so both formats of BOTH modes carry the
  // identical projection.
  // COMPACT pins: omit empty (null/false/0/"") fields and round lat/lng to 6dp
  // (~0.1m). Measured 35% smaller raw JSON (2.04MB → 1.33MB at 5.5k leads) → the
  // client parses far less on load. Safe: the map + card read every optional field
  // by truthiness, so an absent key behaves exactly like the old null/false/0.
  // id/lat/lng/leadStatus are always kept (geometry + dot color depend on them).
  function buildMapPins(all: MapPinRow[]): any[] {
    const pins: any[] = [];
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
            k === "knockCount" || k === "lastOutcome" || k === "lastKnockedAt" ||
            k === "leadLastOutcome" || k === "leadLastOutcomeAt" || k === "doNotKnock") continue;
        const val = (l as any)[k];
        if (val !== null && val !== false && val !== 0 && val !== "") pin[k] = val;
      }
      // SQLite stores the compliance block as 0/1 — normalize to boolean `true`
      // on the wire (compact pins omit falsy fields entirely).
      if (l.doNotKnock) pin.doNotKnock = true;
      if (l.knockCount) {
        pin.visited = true;
        pin.knockCount = l.knockCount;
        if (l.lastKnockedAt) pin.lastKnockedAt = l.lastKnockedAt;
      }
      // The pin's disposition comes from the LEAD ROW when it's at least as
      // new as the last knock (the knock CAS keeps last_outcome_at monotonic;
      // central marks write it with NO knock row). Gating the outcome on
      // knockCount erased "Already a Customer" — stored as not_interested +
      // lastOutcome=already_customer — back to "Not Interested" on every
      // refetch of a never-knocked door. The knock join remains ONLY as the
      // fallback for legacy rows that predate the lead-level columns.
      const leadOutcome = (l as any).leadLastOutcome as string | null;
      const leadOutcomeAt = (l as any).leadLastOutcomeAt as string | null;
      const leadRowWins = leadOutcome && (!l.lastKnockedAt || (leadOutcomeAt != null && leadOutcomeAt >= l.lastKnockedAt));
      const outcome = leadRowWins ? leadOutcome : l.lastOutcome;
      if (outcome) {
        pin.lastOutcome = outcome;
        // A door with ANY disposition is worked — a central mark writes no
        // knock row, and gating visited on knockCount alone made the pin's
        // "worked" ring thin back to unworked on the next refetch.
        pin.visited = true;
        // The recency clock the outcome above was ORDERED by — the lead row's
        // CAS clock when it won, the knock join's time for legacy rows that
        // predate the lead-level columns. The live lead stream stamps every
        // push with the same clock (LeadEventPin.lastOutcomeAt), so shipping
        // it here is what lets the client apply the server's exact CAS rule
        // when a pushed event and a refetched pin disagree: newer wins, older
        // is ignored. Without it a central mark left the pin with only
        // lastKnockedAt (or nothing), and a late-arriving older push could
        // repaint the door backwards.
        const outcomeAt = leadRowWins ? leadOutcomeAt : l.lastKnockedAt;
        if (outcomeAt) pin.lastOutcomeAt = outcomeAt;
      }
      pins.push(pin);
    }
    return pins;
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

  // ── Cheap scoped pin count — the client's full-feed-vs-viewport switch ─────
  // One indexed COUNT(*) over the exact map scope (tenant + rep visibility +
  // pin eligibility). Registered BEFORE /api/leads/map so it can never be
  // shadowed; deliberately NOT ETag'd — the response is three digits.
  app.get("/api/leads/map/count", requireAuth, (req: any, res: any) => {
    const user = req.user;
    const tid = user?.tenantId ?? undefined;
    const repFilter = leadVisibilityScope(user);
    // The mode-decision probe answers for the REQUESTED view: with
    // ?view=latest the client compares the FILTERED total against the full-
    // feed threshold (51k < 60k → one ETag'd feed, not viewport windows).
    const view = parseMapView(req.query.view);
    if (view && typeof view === "object") return res.status(400).json({ error: view.error });
    res.set("Cache-Control", "no-store");
    const total = storage.getLeadsMapCount(tid, repFilter, view);
    // How many doors IN THIS CALLER'S SCOPE the active lens is suppressing.
    // A lens that quietly removes assigned work is indistinguishable from an
    // assignment that never happened — an owner assigned a block of FCC
    // footprint doors to a rep, the rep's default "Latest fiber" lens filtered
    // every one of them out, and the map simply looked empty. The client turns
    // this number into a one-tap "N doors hidden — show all", so filtering is
    // always something the field can SEE, never something it has to guess.
    // Costs one extra indexed COUNT(*), and only when a lens is actually on.
    const hiddenByView = view ? Math.max(0, storage.getLeadsMapCount(tid, repFilter) - total) : 0;
    res.json({ total, hiddenByView });
  });

  // bbox window: minLng,minLat,maxLng,maxLat — clamped to world bounds, span-
  // guarded only against MALFORMED requests: 40° per axis covers any zoom the
  // field map can meaningfully ask for (all of NC+SC is under 10°); wider is a
  // bug or a probe, and a 400 beats a full-table scan. Under the ceiling an
  // over-dense window is answered with a bounded even SAMPLE (below), never
  // rejected — the old 3° rejection left the owner a blank "no leads" map at
  // region zoom over territory with thousands of doors.
  const MAP_BBOX_MAX_SPAN_DEG = 40;
  // Hard row cap per window. The query fetches cap+1 so the response can SAY
  // it truncated (the client shows "sample", never silently drops pins).
  const MAP_BBOX_ROW_CAP = 25_000;
  function parseMapBBox(raw: unknown, maxSpanDeg: number = MAP_BBOX_MAX_SPAN_DEG): MapPinWindow | { error: string } | null {
    if (raw == null || raw === "") return null;
    if (typeof raw !== "string") return { error: "bbox must be minLng,minLat,maxLng,maxLat" };
    const parts = raw.split(",").map((p) => Number(p.trim()));
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
      return { error: "bbox must be four finite numbers: minLng,minLat,maxLng,maxLat" };
    }
    // World-bounds clamp (Web Mercator never paints past ±85° lat, but the
    // guard is the span, not the pole) then min/max normalization.
    let [minLng, minLat, maxLng, maxLat] = parts;
    minLng = Math.max(-180, Math.min(180, minLng));
    maxLng = Math.max(-180, Math.min(180, maxLng));
    minLat = Math.max(-90, Math.min(90, minLat));
    maxLat = Math.max(-90, Math.min(90, maxLat));
    if (minLng > maxLng) [minLng, maxLng] = [maxLng, minLng];
    if (minLat > maxLat) [minLat, maxLat] = [maxLat, minLat];
    // Float-dust tolerance on the span guard: an exactly-guard-wide window
    // (the client clamps to the guard, rounds to 5dp, and we re-parse binary
    // doubles) can subtract to e.g. 15.000000000000002 — that is a legitimate
    // request, not a malformed one, and rejecting it silently blanked the
    // density tier in production. Real violations are whole zoom levels past
    // the guard, so a 1e-6° (≈10cm) allowance changes nothing else.
    const SPAN_GUARD_EPS = 1e-6;
    if (maxLng - minLng > maxSpanDeg + SPAN_GUARD_EPS || maxLat - minLat > maxSpanDeg + SPAN_GUARD_EPS) {
      return { error: `bbox span too large (max ${maxSpanDeg}° per axis)` };
    }
    return { minLng, minLat, maxLng, maxLat };
  }
  function parseMapTag(raw: unknown): string | undefined | { error: string } {
    if (raw == null || raw === "") return undefined;
    if (typeof raw !== "string" || raw.length > 64 || !/^[a-z0-9_\-]+$/i.test(raw)) {
      return { error: "tag must be a lead_tag value or prefix (letters, digits, _, -)" };
    }
    return raw;
  }
  // ?view=latest — the "Latest fiber" lens: the map WITHOUT the established-
  // footprint import (lead_tag = 'fcc_fiber_d25'), so a newly-lit-heavy org
  // renders ~51k pins instead of ~174k. A speed/relevance LENS, never a
  // deletion: every endpoint composes it into the SAME scope predicate, and
  // an absent view keeps the exact current (byte-stable) behaviour — the
  // footprint is one tap away. "all" is accepted as the explicit no-op.
  function parseMapView(raw: unknown): MapView | undefined | { error: string } {
    if (raw == null || raw === "" || raw === "all") return undefined;
    if (raw === "latest") return "latest";
    if (raw === "kinetic_2026") return "kinetic_2026";
    return { error: "view must be 'latest' or 'kinetic_2026' (or 'all')" };
  }

  // ── Density grid — the wide-zoom aggregate tier ───────────────────────────
  // When the viewport is wider than the pin path's 3° span guard, shipping
  // pins is impossible (a state view at 174k leads would be the full table),
  // so this endpoint ships COUNTS bucketed into grid cells instead: the SAME
  // mapScopeWhere scoping + tag filter, GROUPed BY integer floor buckets of
  // lat/lng, one indexed range scan, no pin projection. Registered BEFORE
  // /api/leads/map for the same reason /count is.
  //
  // The grid's own span guard is 15°/axis — past that even an aggregate stops
  // being meaningful territory (continent views), and the client never asks
  // (it clamps its fetch window to the guard). Cell pitch:
  //   auto (default): span/24 snapped to 0.01° steps, clamped to [0.01°, 5°]
  //     — ~24 cells across the view, so the density tier reads like a cluster
  //     map (WHERE in a city the leads sit, not just that they exist) while
  //     the count stays viewport-bounded: ~24² core cells + fetch margin is
  //     always far under the cell cap, at every span. (Was span/12 on an
  //     0.05° lattice — at city spans, where over-cap pin windows now flip to
  //     this tier, that painted a dozen ~5km bubbles: honest counts, useless
  //     geometry.)
  //   explicit ?cell=<deg>: snapped to the same 0.01° lattice so every
  //     requester agrees on cell identity (client cache keys depend on it).
  // Hard-capped at 5k cells (fetched cap+1) with a truncated flag — the
  // mirror of the pin window's 25k row cap contract.
  const MAP_GRID_MAX_SPAN_DEG = 15;
  const MAP_GRID_CELL_CAP = 5_000;
  const MAP_GRID_CELL_STEP = 0.01;
  function gridCellForSpan(spanDeg: number): number {
    const snapped = Math.round(spanDeg / 24 / MAP_GRID_CELL_STEP) * MAP_GRID_CELL_STEP;
    return Math.min(5, Math.max(MAP_GRID_CELL_STEP, Number(snapped.toFixed(2))));
  }
  function parseGridCell(raw: unknown, spanDeg: number): number | { error: string } {
    if (raw == null || raw === "" || raw === "auto") return gridCellForSpan(spanDeg);
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0 || n > 5) {
      return { error: "cell must be 'auto' or a size in degrees (0.01-5)" };
    }
    // Snap to the 0.01° lattice (same rule as auto) so cell identity — and
    // therefore the client's 60s response cache keys — is requester-independent.
    return Math.min(5, Math.max(MAP_GRID_CELL_STEP, Number((Math.round(n / MAP_GRID_CELL_STEP) * MAP_GRID_CELL_STEP).toFixed(2))));
  }

  app.get("/api/leads/map/grid", requireAuth, (req: any, res: any) => {
    const user = req.user;
    const tid = user?.tenantId ?? undefined;
    const repFilter = leadVisibilityScope(user); // identical scoping to the pin path
    const bbox = parseMapBBox(req.query.bbox, MAP_GRID_MAX_SPAN_DEG);
    if (!bbox) return res.status(400).json({ error: "grid requires bbox=minLng,minLat,maxLng,maxLat" });
    if ("error" in bbox) return res.status(400).json({ error: bbox.error });
    const tag = parseMapTag(req.query.tag);
    if (tag && typeof tag === "object") return res.status(400).json({ error: (tag as { error: string }).error });
    const view = parseMapView(req.query.view);
    if (view && typeof view === "object") return res.status(400).json({ error: view.error });
    const span = Math.max(bbox.maxLng - bbox.minLng, bbox.maxLat - bbox.minLat);
    const cell = parseGridCell(req.query.cell, span);
    if (typeof cell !== "number") return res.status(400).json({ error: cell.error });
    const started = performance.now();
    const rows = storage.getLeadsMapGrid(tid, repFilter, {
      ...bbox, cell, tag: tag as string | undefined, view: view as MapView | undefined, limit: MAP_GRID_CELL_CAP + 1,
    });
    const truncated = rows.length > MAP_GRID_CELL_CAP;
    if (truncated) rows.length = MAP_GRID_CELL_CAP;
    res.set("Cache-Control", "no-store");
    structuredLog("perf.leads_map", {
      requestId: String(req.id ?? "").slice(0, 8),
      tenantId: tid ?? 0,
      scope: repFilter == null ? "all" : "scoped",
      format: "grid", cache: "bbox",
      rows: rows.length, truncated,
      dbMs: Number((performance.now() - started).toFixed(2)),
      complexity: "O(K_window)",
    });
    res.json({ cells: rows, cell, truncated });
  });

  app.get("/api/leads/map", requireAuth, (req: any, res: any) => {
    const parsedQuery = z.object({ format: z.enum(["object", "packed"]).default("object") })
      .safeParse(req.query);
    if (!parsedQuery.success) return res.status(400).json({ error: "format must be object or packed" });
    const format = parsedQuery.data.format;
    const user = req.user;
    const tid = user?.tenantId ?? undefined;
    const repFilter = leadVisibilityScope(user); // team_lead → their team; rep → self

    // ── Bbox window mode (viewport loading for 100k+ pins) ──────────────────
    // Same role scoping as the full feed, narrowed spatially, ordered by id,
    // hard-capped (over-cap windows get an even deterministic sample — see
    // below). UNCACHED and NOT ETag'd on purpose: windows are nearly
    // unique per pan, so the pin cache/ETag machinery would only churn — the
    // full-feed path below is untouched for existing clients: same ETag/304
    // semantics (the wire SCHEMA evolved v7→v8, and the ETag busts on redeploy,
    // so no client can 304 a v7 payload into a v8 reader).
    const bbox = parseMapBBox(req.query.bbox);
    if (bbox && "error" in bbox) return res.status(400).json({ error: bbox.error });
    const tag = parseMapTag(req.query.tag);
    if (tag && typeof tag === "object") return res.status(400).json({ error: (tag as { error: string }).error });
    const view = parseMapView(req.query.view);
    if (view && typeof view === "object") return res.status(400).json({ error: view.error });
    if (bbox) {
      const started = performance.now();
      // ?nosample=1 — the honest-window contract (new clients): an over-cap
      // window returns EMPTY pins + the true windowCount instead of a thinned
      // sample. The client renders its density-grid tier for that window
      // (real aggregate counts), so no lead is ever silently missing — a
      // sampled pin map is indistinguishable from a map with fewer doors.
      // Also skips the sampled re-query entirely: no multi-MB corpse
      // serialized for a response the client would refuse to paint as pins.
      const nosample = req.query.nosample === "1";
      const win = { ...bbox, tag: tag as string | undefined, view: view as MapView | undefined };
      let rows = storage.getLeadsForMap(tid, repFilter, { ...win, limit: MAP_BBOX_ROW_CAP + 1 });
      const truncated = rows.length > MAP_BBOX_ROW_CAP;
      let sampleStep = 1;
      let windowCount: number | undefined;
      if (truncated) {
        // One indexed COUNT over the same predicate (rare — only over-cap
        // windows pay it): the true row count, shipped so the client can
        // render honest aggregate counts and predict when a zoomed-in window
        // will fit under the cap without paying a throwaway fetch.
        windowCount = storage.getLeadsMapWindowCount(tid, repFilter, win);
        if (nosample) {
          rows = [];
        } else {
          // Legacy clients still get the even deterministic id % step sample
          // (ORDER BY id LIMIT would keep the LOWEST ids — the first-scanned
          // city — so a state-zoom "sample" would all be one town). Stable
          // across pans, spread across insertion order; see
          // Storage.mapWindowPred for the bias tradeoff. truncated stays true
          // so the client's "Showing a sample" chip tells the truth.
          sampleStep = Math.max(2, Math.ceil(windowCount / MAP_BBOX_ROW_CAP));
          rows = storage.getLeadsForMap(tid, repFilter, { ...win, limit: MAP_BBOX_ROW_CAP, sampleStep });
        }
      }
      const pins = buildMapPins(rows);
      res.set("Cache-Control", "no-store");
      const payload = format === "packed"
        ? packMapPins(pins, { truncated, windowCount })
        : { pins, total: pins.length, truncated, ...(truncated && windowCount != null ? { windowCount } : {}) };
      structuredLog("perf.leads_map", {
        requestId: String(req.id ?? "").slice(0, 8),
        tenantId: tid ?? 0,
        scope: repFilter == null ? "all" : "scoped",
        format, cache: "bbox",
        rows: pins.length, truncated, sampleStep,
        ...(windowCount != null ? { windowCount } : {}),
        ...(nosample ? { nosample: true } : {}),
        dbMs: Number((performance.now() - started).toFixed(2)),
        complexity: "O(window + K_window)",
      });
      return res.json(payload);
    }

    // Data-version ETag, checked BEFORE any DB work: an unchanged poll returns
    // 304 for the cost of a string compare. The scope key keeps role scoping
    // airtight — a rep's 304 token can never validate a manager's payload.
    const scopeKey = repFilter == null ? "all" : [repFilter].flat().sort((a, b) => a - b).join(",");
    // The view lens joins the ETag's scope segment ONLY when present — an
    // unfiltered request's token stays byte-identical to before, and a
    // "latest" 304 can never validate the unfiltered payload.
    const viewKey = view === "latest" ? "-latest" : "";
    // DB-derived version makes the ETag change on ANY cross-process lead write
    // (scan runner, nightly cron) — not just this process's own mutations. Without
    // it, a browser holding the pre-scan ETag would 304 forever and never see the
    // new leads. The in-memory epoch stays for instant same-process busts.
    const dbVer = storage.getLeadsDataVersion(tid);
    const ver = `${_leadsEpoch}.${_leadsBustByTenant.get(tid ?? 0) ?? 0}.${dbVer}`;
    const etag = `W/"pins-${format}-${_leadsEtagBoot}-${tid ?? 0}-${scopeKey}${viewKey}-${ver}"`;
    // This endpoint overrides the global no-store policy with private no-cache:
    // browsers may retain it only for conditional revalidation, never reuse it
    // without the ETag check. That turns unchanged polls into a zero-body 304.
    res.set("Cache-Control", "private, no-cache");
    res.set("ETag", etag);
    if (req.headers["if-none-match"] === etag) return res.status(304).end();
    const result = getMapPins(tid, repFilter, dbVer, view as MapView | undefined);
    const packStarted = performance.now();
    const body = format === "packed"
      ? (result.entry.packedJson ??= JSON.stringify(result.entry.packed ??= packMapPins(result.entry.pins)))
      : (result.entry.json ??= JSON.stringify({ pins: result.entry.pins, total: result.entry.pins.length }));
    const packMs = performance.now() - packStarted;
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
    res.type("application/json").send(body);
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

  // ── Per-lead live stream (FIELD-facing) ─────────────────────────────────────
  // /api/leads/events above is a data-free ping, so every change costs the client
  // a full role-scoped map refetch. That is the right fallback and it stays, but
  // it is also why a SHARED area feels dead: two reps working the same street see
  // nothing of each other until a refetch lands. This stream carries the one pin
  // that changed so the map can patch it in place.
  //
  // Carrying lead identity means this endpoint owns an authorization decision the
  // ping never had to make. Two walls, and BOTH are re-applied per event because
  // the bus is process-wide — same shape as the run-stage feed's `evt.runId !==
  // run.id` filter, for the same reason: subscribing tells you nothing about who
  // the event belongs to.
  //   1. Tenant, resolved from the SESSION. Never a query param.
  //   2. repCanAccessLead — the SAME predicate every single-lead read uses, fed
  //      the assignedRepId/assignedTerritoryId the event carries for exactly this
  //      purpose. Areas are many-to-many, so a rep-column check here would hide
  //      every door from every assignee but one.
  //
  // Deliberately NOT covered: a rep who just LOST a door receives nothing, since
  // the post-write row no longer authorizes them, so their pin lingers until the
  // next refetch. That case belongs to the data-free map-changed ping — every
  // path that moves an assignment busts the map cache — and it is the safe
  // direction to fail: a late removal costs one stale pin, whereas addressing the
  // event to the PREVIOUS holder would hand lead data to someone who just lost
  // access to it.
  //
  // Concurrency is capped process-wide (the run-stage feed's shape) rather than
  // per tenant, because the cost this bounds is process-wide: every lead write
  // fans out to every listener, and each listener answers repCanAccessLead, which
  // for a scoped rep is a tenant-filtered territory scan. 200 sits under the
  // bus's 500 max-listeners ceiling, so the cap trips before the leak warning
  // that ceiling exists to raise.
  const LEAD_STREAM_MAX = 200;
  let leadStreams = 0;

  app.get("/api/leads/stream", requireCapability("field.app.use"), (req: any, res: Response) => {
    const user = req.user;
    // A session with no org cannot be walled at all, so it is refused rather than
    // defaulted to 0 — the bus drops tenant-less events for the same reason.
    const tenantId = Number(user?.tenantId ?? 0);
    if (!Number.isInteger(tenantId) || tenantId <= 0) {
      return res.status(403).json({ error: "Organization membership required" });
    }
    // Checked BEFORE any header is written: past the cap the caller gets a clean
    // 503 + JSON and falls back to polling, never a half-opened stream.
    if (leadStreams >= LEAD_STREAM_MAX) {
      return res.status(503).json({ error: "Too many live lead streams open; use the polling fallback." });
    }

    // Resume cursor. The SSE frame id is `<epoch>.<seq>`, not a bare number, so
    // Last-Event-ID carries the identity of the seq space it was minted in: seq
    // restarts at 1 on every boot, and a cursor from the previous process (or
    // another node behind the balancer) would otherwise look perfectly valid
    // while naming completely different events.
    //
    // Header before ?since= — the browser resends Last-Event-ID by itself, so
    // when both arrive the header is the fresher of the two. Either source may
    // carry either form: the full frame id we minted, or a bare seq, which has no
    // boot identity to check and can therefore only mean "in the current epoch".
    const rawCursor = String(req.headers["last-event-id"] ?? req.query.since ?? "").trim();
    const dot = rawCursor.lastIndexOf(".");
    const epoch = leadEventsEpoch();
    const cursorSeq = Number(dot > 0 ? rawCursor.slice(dot + 1) : rawCursor);
    let cursor = Number.isSafeInteger(cursorSeq) && cursorSeq >= 0 ? cursorSeq : 0;
    // `resync` is the client's instruction to drop its cursor and refetch the
    // scope through /api/leads/map. It is never inferred from silence.
    let resync = dot > 0 && rawCursor.slice(0, dot) !== epoch;
    // No cursor at all → TAIL, don't replay. A fresh connection has just loaded
    // the map through the role-scoped endpoint, so the window holds changes it
    // already has. Tenant-local by construction: the global counter would leak
    // every other tenant's write volume to anyone with a browser.
    if (rawCursor === "") cursor = leadEventsCursor(tenantId);

    res.status(200);
    res.set({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();

    const send = (event: string, data: unknown, id?: string) => {
      // The id line goes FIRST so a browser that drops mid-frame never records a
      // cursor for an event it did not finish reading.
      if (id) res.write(`id: ${id}\n`);
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // The subscriber's scope roster and open-field flag are resolved ONCE at
    // connect and reused per event, re-resolved only when the version stamp
    // moves (team write / tenant-config write). The predicate itself is the
    // same repCanAccessLead chain; territoryIdsForScope keeps its own
    // territory-write stamp. Staleness beyond the stamps stays bounded by the
    // existing safety net: the data-free map-changed ping + ETag poll re-apply
    // full scoping on every refetch.
    let accessVersion = -1;
    let accessRosterEpoch = -1;
    let accessScope: number | number[] | undefined;
    let accessOpenField = false;
    const deliver = (evt: LeadEvent) => {
      if (evt.tenantId !== tenantId) return;
      // Two stamps, because the /api/team middleware below is not the only way
      // a reports_to edge moves: approving a leader hire re-homes the picked
      // downline from /api/onboarding, which that middleware never sees. The
      // roster epoch is bumped inside storage's team-member writes, so it
      // covers any route — including ones written after this memo. Without it
      // a lead keeps streaming a moved rep's doors for the life of the
      // connection, and this scope is authority, not decoration.
      const rosterEpoch = storage.teamRosterEpoch();
      if (accessVersion !== streamAccessVersion || accessRosterEpoch !== rosterEpoch) {
        accessVersion = streamAccessVersion;
        accessRosterEpoch = rosterEpoch;
        accessScope = leadVisibilityScope(user);
        accessOpenField = storage.openFieldEnabled(user?.tenantId);
      }
      if (accessScope !== undefined) {
        if (!evt.lead) return;
        if (!repCanWorkLead(
          evt.lead,
          accessScope as number[],
          territoryIdsForScope(accessScope as number[], user?.tenantId),
          accessOpenField,
        )) return;
      }
      send("lead", evt, `${evt.epoch}.${evt.seq}`);
    };

    // Drain the reconnect window into a list BEFORE writing anything, so the
    // opening frame can tell the client whether its cursor survived. A client
    // that learns "resync" only after applying 200 patches has done the work
    // twice. eventsSince() caps each call, hence the loop; the ring is finite so
    // it terminates in a couple of passes, and the bound is only there so a
    // future ring resize cannot turn this into a spin.
    const replay: LeadEvent[] = [];
    for (let pass = 0; !resync && pass < 8; pass++) {
      const batch = eventsSince(tenantId, cursor);
      // A gap means events this client needed are already evicted. Reported, not
      // papered over: replaying the surviving tail would leave a hole nothing
      // downstream can detect — a sold door silently missing from a map.
      if (batch.gapped) { resync = true; break; }
      if (batch.events.length === 0 || batch.nextSeq === cursor) break;
      replay.push(...batch.events);
      cursor = batch.nextSeq;
    }
    if (resync) { replay.length = 0; cursor = leadEventsCursor(tenantId); }

    // Immediate first frame — a fresh or refreshed client paints without waiting
    // for the first lead write. `since` is the resume token to send back if this
    // connection ends before any lead frame does.
    send("ready", { epoch, since: `${epoch}.${cursor}`, resync });
    for (const evt of replay) deliver(evt);

    // Subscribing AFTER the replay is race-free without a buffer: emitLeadEvent
    // and this handler are both synchronous, so nothing can be emitted between
    // the last replayed event and this line. The seq guard covers the reverse —
    // the ring hands out the same frozen object to replay and to listeners.
    const unsub = onLeadEvent((evt) => {
      if (evt.seq <= cursor) return;
      cursor = evt.seq;
      try { deliver(evt); } catch { /* socket gone; the close handler cleans up */ }
    });

    // ── Team announcements ride THIS connection ─────────────────────────────
    // A second SSE stream would mean a second socket, a second TLS session and a
    // second 15s keepalive on a phone that is already on LTE all day. The
    // connection is authenticated and tenant-checked above, so the only extra
    // rule an announcement needs is the one the feed query applies: do not tell
    // a rep about their own win.
    //
    // No cursor and no replay, unlike lead frames: announcements are durable in
    // team_announcements and the client refetches /api/announcements on mount,
    // so a dropped frame costs nothing a reload does not fix.
    const unsubAnnounce = onAnnouncement((evt) => {
      if (evt.tenantId !== tenantId) return;
      if (!visibleTo(evt.announcement, user?.teamMemberId ?? null)) return;
      try { send("announcement", evt.announcement); } catch { /* socket gone */ }
    });
    leadStreams++;

    // 15s, matching the field-facing scan feed: a phone on LTE pays a radio
    // wakeup for every keepalive, and this stream has no periodic payload to
    // piggyback on.
    const hb = setInterval(() => {
      if (!res.writableEnded) { try { res.write(`: ping\n\n`); } catch { /* closed */ } }
    }, 15_000);
    hb.unref();   // a keepalive must never be the reason the process won't exit

    let closed = false;
    const cleanup = () => {
      if (closed) return;      // 'close' fires on req AND res, and alongside error paths
      closed = true;
      clearInterval(hb);
      unsub();                 // MUST run, or every lead write pays this listener forever
      unsubAnnounce();         // ditto — a leaked listener here outlives the socket
      leadStreams = Math.max(0, leadStreams - 1);
    };
    req.on("close", cleanup);
    res.on("close", cleanup);
  });

  // GET /api/me/earnings-today — the number the home screen opens with.
  // Returns BANKED (certain) and PENDING (estimated) separately and never blends
  // them; see server/earningsTodayStore.ts for why that split is the whole point.
  app.get("/api/me/earnings-today", requireCapability("field.app.use"), (req: any, res: Response) => {
    const tenantId = req.user?.tenantId;
    const repId = req.user?.teamMemberId;
    if (tenantId == null || repId == null) {
      return res.json({
        bankedCents: 0, hourlyCents: 0, hourlyMinutes: 0, spiffCents: 0,
        salesToday: 0, pendingCents: null, pendingBasis: "no_sales",
      });
    }
    res.json(earningsToday(Number(tenantId), Number(repId), Date.now()));
  });

  // ── Team announcements ──────────────────────────────────────────────────────
  // The durable side of what the SSE stream pushes live. A phone that was asleep,
  // offline, or simply not running when a teammate closed one catches up here,
  // which is why the live frames need no replay window of their own.
  //
  // requireAuth rather than a field capability: a manager watching the floor has
  // as much reason to see the feed as the rep standing on it.
  app.get("/api/announcements", requireAuth, (req: any, res: Response) => {
    const tenantId = req.user?.tenantId;
    const userId = Number(req.user?.id);
    if (tenantId == null || !Number.isFinite(userId)) return res.json({ items: [], unread: 0, latestId: 0 });
    const limit = Number(req.query.limit);
    res.json(feedForUser(
      Number(tenantId), userId, req.user?.teamMemberId ?? null,
      Number.isFinite(limit) ? limit : 40,
    ));
  });

  // POST /api/announcements — a manager posts a promo or an app update.
  //
  // Gated on commission.structure.manage (team_lead+): this writes to every
  // phone in the org, so it sits with the other "spend the org's attention"
  // powers rather than with ordinary rep actions.
  app.post("/api/announcements", requireCapability("commission.structure.manage"), async (req: any, res: Response) => {
    const tenantId = req.user?.tenantId;
    if (tenantId == null) return res.status(403).json({ error: "Organization required" });
    try {
      const stored = publishAuthored(
        Number(tenantId), req.user?.id ?? null, req.user?.name ?? null,
        {
          kind: req.body?.kind,
          title: String(req.body?.title ?? ""),
          body: String(req.body?.body ?? ""),
          amountCents: req.body?.amountCents == null ? undefined : Math.trunc(Number(req.body.amountCents)),
        },
        Date.now(),
      );
      emitAnnouncement(Number(tenantId), stored);

      // A PROMO interrupts — there is money attached and a rep should act now.
      // An UPDATE does not: it is news, and news that buzzes a phone mid-pitch
      // is exactly how people learn to turn notifications off. Both land in the
      // feed either way.
      if (stored && stored.kind === "promo") {
        void pushToUsers(
          Number(tenantId), tenantUserIds(Number(tenantId)),
          { title: stored.headline, body: stored.body, url: "/incentives", tag: `promo-${stored.id}` },
        ).catch(() => { /* best effort */ });
      }
      res.status(201).json(stored);
    } catch (e: any) {
      res.status(e?.httpStatus === 400 ? 400 : 500).json({ error: e?.message ?? "Could not post" });
    }
  });

  // GET /api/announcements/sent — the manager's own sent log.
  //
  // Same capability as posting, not requireAuth: this is the only surface that
  // reports how many people READ a given announcement, and per-person attention
  // data on the floor belongs with the people who decide what to send, not with
  // everyone who receives it.
  app.get("/api/announcements/sent", requireCapability("commission.structure.manage"), (req: any, res: Response) => {
    const tenantId = req.user?.tenantId;
    if (tenantId == null) return res.json({ items: [] });
    const limit = Number(req.query.limit);
    res.json({ items: sentAuthored(Number(tenantId), Number.isFinite(limit) ? limit : 30) });
  });

  // DELETE /api/announcements/:id — retract a post.
  //
  // Pulls it from the feed for everyone who has not opened it yet. It does NOT
  // recall a push that already went out — nothing can — and the UI says so
  // rather than letting a manager believe the message was unsent.
  app.delete("/api/announcements/:id", requireCapability("commission.structure.manage"), (req: any, res: Response) => {
    const tenantId = req.user?.tenantId;
    if (tenantId == null) return res.status(403).json({ error: "Organization required" });
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Bad id" });
    if (!deleteAuthored(Number(tenantId), id)) {
      return res.status(404).json({ error: "Not found, or not a post you can retract" });
    }
    storage.logActivity(req.user?.id ?? null, "announcement.deleted", "tenant", Number(tenantId), { id }, undefined);
    res.json({ ok: true });
  });

  // POST /api/announcements/read { upToId } — clears the bell.
  // Monotonic in the store, so a stale request from a second device cannot
  // un-read what the first already cleared.
  app.post("/api/announcements/read", requireAuth, (req: any, res: Response) => {
    const userId = Number(req.user?.id);
    if (!Number.isFinite(userId)) return res.status(401).json({ error: "Unauthenticated" });
    res.json({ lastReadId: markRead(userId, Number(req.body?.upToId ?? 0), Date.now()) });
  });

  // ── Floor chat ──────────────────────────────────────────────────────────────
  // The two-way room next to the one-way feed. Every route here is gated on
  // field.app.use, NOT bare requireAuth — deliberately stricter than GET
  // /api/announcements. The feed admits desk roles because a broadcast is for
  // everyone; the chat is the floor talking, and a calling/compliance identity
  // that can never open the hub page should not be able to post into it from a
  // script either. (Training-gated reps are refused upstream by the gate that
  // rides requireAuth — a rep who hasn't finished training isn't on the floor
  // yet, and hearing the room before then is a distraction, not an onboarding.)

  // GET /api/chat?limit=&after=&before= — the room, plus this viewer's unread
  // count. `after` is the polling cursor (a quiet poll returns zero rows, not
  // a page); `before` pages backwards through history, which is what keeps
  // the whole-room unread count an honest promise rather than a number bigger
  // than anything the API would hand back.
  app.get("/api/chat", requireCapability("field.app.use"), (req: any, res: Response) => {
    const tenantId = req.user?.tenantId;
    const userId = Number(req.user?.id);
    if (tenantId == null || !Number.isFinite(userId)) {
      return res.json({ items: [], unread: 0, latestId: 0 });
    }
    const limit = Number(req.query.limit);
    const afterId = Number(req.query.after);
    const beforeId = Number(req.query.before);
    res.json({
      ...chatPageFor(Number(tenantId), userId, {
        limit: Number.isFinite(limit) ? limit : undefined,
        afterId: Number.isFinite(afterId) ? afterId : undefined,
        beforeId: Number.isFinite(beforeId) ? beforeId : undefined,
      }),
      // Everything unread across DMs and groups, riding the poll the nav
      // badge already makes — one request, one number, no second poll.
      threadsUnread: threadsUnreadTotal(Number(tenantId), userId),
    });
  });

  // POST /api/chat { body } — say something to the floor.
  //
  // No push and no announcementBus frame: the house rule is that only money
  // buzzes a phone (see the promo/update split above), and a chat message is
  // conversation, not a "drop everything". The room updates by polling.
  app.post("/api/chat", chatPostLimiter, requireCapability("field.app.use"), (req: any, res: Response) => {
    const tenantId = req.user?.tenantId;
    if (tenantId == null) return res.status(403).json({ error: "Organization required" });
    try {
      const msg = postChatMessage(
        Number(tenantId),
        { userId: Number(req.user.id), memberId: req.user?.teamMemberId ?? null, name: req.user?.name ?? null },
        req.body?.body, Date.now(),
      );
      // Your own message is not news to you: advance the watermark past it so
      // the badge never counts what you just typed.
      markChatRead(Number(req.user.id), msg.id, Date.now());
      res.status(201).json(msg);
    } catch (e: any) {
      res.status(e?.httpStatus === 400 ? 400 : 500).json({ error: e?.message ?? "Couldn't send" });
    }
  });

  // POST /api/chat/read { upToId } — clears the room's badge. Monotonic in the
  // store, same second-device contract as the announcement watermark.
  app.post("/api/chat/read", requireCapability("field.app.use"), (req: any, res: Response) => {
    const userId = Number(req.user?.id);
    if (!Number.isFinite(userId)) return res.status(401).json({ error: "Unauthenticated" });
    res.json({ lastReadId: markChatRead(userId, Number(req.body?.upToId ?? 0), Date.now()) });
  });

  // DELETE /api/chat/:id — remove a message: yours always, anyone's if you
  // hold the same capability that moderates the feed. 404 (not 403) when the
  // WHERE clause misses, so existence in another tenant is never confirmed.
  app.delete("/api/chat/:id", requireCapability("field.app.use"), (req: any, res: Response) => {
    const tenantId = req.user?.tenantId;
    if (tenantId == null) return res.status(403).json({ error: "Organization required" });
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Bad id" });
    const canModerate = hasCapability(req.user?.role, "commission.structure.manage");
    const deleted = deleteChatMessage(Number(tenantId), id, Number(req.user.id), canModerate);
    if (!deleted) {
      return res.status(404).json({ error: "Not found, or not a message you can remove" });
    }
    // Removing someone's words from a SHARED room is a governance act — logged
    // like the feed's retractions, with WHOSE words were removed (a hard
    // delete leaves the audit row as the only answer to that question). The
    // body is deliberately NOT logged: chat content must not outlive the
    // room's own delete inside an activity log with different readers.
    //
    // A DM delete is NOT logged at all. It is always a self-delete (nobody
    // else may touch a DM), so it is not governance — and a row carrying the
    // DM's threadId would let a log reader pair up who talks privately to
    // whom, the exact metadata the un-logged DM-creation path refuses to
    // collect. Two careful rows and a join undo that refusal.
    if (deleted.room !== "dm") {
      storage.logActivity(req.user?.id ?? null, "chat.message.deleted", "tenant", Number(tenantId), {
        id,
        threadId: deleted.threadId,
        authorUserId: deleted.authorUserId,
        authorName: deleted.authorName,
        moderated: deleted.authorUserId !== Number(req.user.id),
      }, undefined);
    }
    res.json({ ok: true });
  });

  // ── Chat threads — DMs and groups next to the floor ────────────────────────
  // Same field.app.use boundary as the floor. Membership is checked in the
  // STORE's SQL on every read/write, and a miss is always 404, never 403 —
  // a thread id must not confirm that somebody else's conversation exists.

  // Compiled once — the member-resolution loops below would otherwise pay a
  // statement compile per array element on client-controlled input.
  const chatUserStmt = rawDb.prepare(
    `SELECT id, role FROM users
      WHERE tenant_id = ? AND team_member_id = ? AND active = 1 LIMIT 1`,
  );

  /** The user behind a roster row. The client picks people from /api/team
   *  (team_members), but a thread member is a LOGIN — resolve or refuse. */
  const chatUserByMemberId = (tenantId: number, memberId: number): { id: number; role: string } | null => {
    const row = chatUserStmt.get(tenantId, Math.trunc(Number(memberId) || 0)) as any;
    if (!row) return null;
    // The room is the floor's: a target who can never open the page must not
    // be enrollable into conversations they cannot see.
    if (!hasCapability(String(row.role), "field.app.use")) return null;
    return { id: Number(row.id), role: String(row.role) };
  };

  /** Bound and dedupe a client-sent member-id array BEFORE any lookup — each
   *  element costs a synchronous SELECT on the one thread the org shares, and
   *  no legitimate request names more people than a group may hold. Null
   *  means "too many", which the caller turns into a 400. */
  const boundedMemberIds = (raw: unknown): number[] | null => {
    if (!Array.isArray(raw)) return [];
    if (raw.length > GROUP_MEMBER_MAX) return null;
    return [...new Set(raw.map(v => Math.trunc(Number(v) || 0)).filter(v => v > 0))];
  };

  /** Resolve every pick or refuse the request. Silently dropping the picks
   *  that can't chat builds a group missing people its creator counted on —
   *  a "Lexington crew" that quietly excludes half the crew. */
  const resolveMemberIdsOrFail = (
    tenantId: number, memberIds: number[], res: Response,
  ): number[] | null => {
    const pairs = memberIds.map(m => ({ m, u: chatUserByMemberId(tenantId, m) }));
    const dropped = pairs.filter(p => !p.u).map(p => p.m);
    if (dropped.length) {
      res.status(400).json({ error: "Some of those picks can't use chat yet.", memberIds: dropped });
      return null;
    }
    return pairs.map(p => p.u!.id);
  };

  // GET /api/chat/threads — this viewer's conversations, newest activity first.
  app.get("/api/chat/threads", requireCapability("field.app.use"), (req: any, res: Response) => {
    const tenantId = req.user?.tenantId;
    const userId = Number(req.user?.id);
    if (tenantId == null || !Number.isFinite(userId)) return res.json({ threads: [] });
    res.json({ threads: myThreads(Number(tenantId), userId) });
  });

  // POST /api/chat/threads — open a DM or create a group.
  //
  //   { kind: "dm", memberId }              → any field user. Idempotent: the
  //     pair's room is UNIQUE, so "message Bo" from two screens is one room.
  //     Deliberately NOT activity-logged — who talks privately to whom is
  //     metadata the org has no business collecting.
  //   { kind: "group", name, memberIds[] }  → the floor's megaphone holders
  //     (commission.structure.manage), because naming a crew and pulling
  //     people into a room is org communication structure, not field work.
  app.post("/api/chat/threads", requireCapability("field.app.use"), (req: any, res: Response) => {
    const tenantId = req.user?.tenantId;
    const meUserId = Number(req.user?.id);
    if (tenantId == null) return res.status(403).json({ error: "Organization required" });
    const kind = String(req.body?.kind ?? "");

    if (kind === "dm") {
      const target = chatUserByMemberId(Number(tenantId), Number(req.body?.memberId));
      if (!target) return res.status(400).json({ error: "They can't use chat yet." });
      if (target.id === meUserId) return res.status(400).json({ error: "That's you." });
      const { threadId, created } = openDm(Number(tenantId), meUserId, target.id, Date.now());
      return res.status(created ? 201 : 200).json({ threadId, kind: "dm" });
    }

    if (kind === "group") {
      if (!hasCapability(req.user?.role, "commission.structure.manage")) {
        storage.logActivity(meUserId, "permission.denied", "capability", undefined,
          { need: "commission.structure.manage", path: req.path, role: req.user?.role ?? null }, req.ip);
        return res.status(403).json({ error: "Forbidden", need: "commission.structure.manage" });
      }
      const wanted = boundedMemberIds(req.body?.memberIds);
      if (!wanted) return res.status(400).json({ error: `A group tops out at ${GROUP_MEMBER_MAX} people - past that, use the floor.` });
      const resolved = resolveMemberIdsOrFail(Number(tenantId), wanted, res);
      if (!resolved) return; // 400 already written, naming the bad picks
      try {
        const { threadId, name } = createGroup(Number(tenantId), meUserId, req.body?.name, resolved, Date.now());
        storage.logActivity(meUserId, "chat.group.created", "tenant", Number(tenantId),
          { threadId, name, members: resolved.length + 1 }, undefined);
        return res.status(201).json({ threadId, kind: "group", name });
      } catch (e: any) {
        return res.status(e?.httpStatus === 400 ? 400 : 500).json({ error: e?.message ?? "Couldn't create it" });
      }
    }

    return res.status(400).json({ error: "Pick dm or group." });
  });

  // GET /api/chat/threads/:id — one conversation, same page contract as the
  // floor (limit / after / before).
  app.get("/api/chat/threads/:id", requireCapability("field.app.use"), (req: any, res: Response) => {
    const tenantId = req.user?.tenantId;
    const userId = Number(req.user?.id);
    const threadId = Number(req.params.id);
    if (tenantId == null || !Number.isFinite(threadId)) return res.status(404).json({ error: "Not found" });
    const limit = Number(req.query.limit);
    const afterId = Number(req.query.after);
    const beforeId = Number(req.query.before);
    const page = threadPageFor(Number(tenantId), threadId, userId, {
      limit: Number.isFinite(limit) ? limit : undefined,
      afterId: Number.isFinite(afterId) ? afterId : undefined,
      beforeId: Number.isFinite(beforeId) ? beforeId : undefined,
    });
    if (!page) return res.status(404).json({ error: "Not found" });
    res.json(page);
  });

  // POST /api/chat/threads/:id { body } — say something in a conversation.
  // Same per-user post budget as the floor; the room changes, the thumb doesn't.
  app.post("/api/chat/threads/:id", chatPostLimiter, requireCapability("field.app.use"), (req: any, res: Response) => {
    const tenantId = req.user?.tenantId;
    const threadId = Number(req.params.id);
    if (tenantId == null) return res.status(403).json({ error: "Organization required" });
    if (!Number.isFinite(threadId)) return res.status(404).json({ error: "Not found" });
    try {
      const msg = postThreadMessage(
        Number(tenantId), threadId,
        { userId: Number(req.user.id), memberId: req.user?.teamMemberId ?? null, name: req.user?.name ?? null },
        req.body?.body, Date.now(),
      );
      if (!msg) return res.status(404).json({ error: "Not found" });
      res.status(201).json(msg);
    } catch (e: any) {
      res.status(e?.httpStatus === 400 ? 400 : 500).json({ error: e?.message ?? "Couldn't send" });
    }
  });

  // POST /api/chat/threads/:id/read { upToId } — clears one conversation's
  // badge. Membership-checked like every other thread touch.
  app.post("/api/chat/threads/:id/read", requireCapability("field.app.use"), (req: any, res: Response) => {
    const tenantId = req.user?.tenantId;
    const userId = Number(req.user?.id);
    const threadId = Number(req.params.id);
    if (tenantId == null || !Number.isFinite(threadId)) return res.status(404).json({ error: "Not found" });
    // Reuse the page gate for the membership check — one rule, one place.
    if (!threadPageFor(Number(tenantId), threadId, userId, { limit: 1 })) {
      return res.status(404).json({ error: "Not found" });
    }
    res.json({ lastReadId: markThreadRead(userId, threadId, Number(req.body?.upToId ?? 0), Date.now()) });
  });

  // POST /api/chat/threads/:id/members { addMemberIds[], removeUserIds[] } —
  // re-crew a group. Structural, so it takes the group-management capability
  // but not membership: fixing a room's roster doesn't read the room.
  app.post("/api/chat/threads/:id/members", requireCapability("commission.structure.manage"), (req: any, res: Response) => {
    const tenantId = req.user?.tenantId;
    const threadId = Number(req.params.id);
    if (tenantId == null || !Number.isFinite(threadId)) return res.status(404).json({ error: "Not found" });
    const wanted = boundedMemberIds(req.body?.addMemberIds);
    if (!wanted) return res.status(400).json({ error: `A group tops out at ${GROUP_MEMBER_MAX} people - past that, use the floor.` });
    const add = wanted.length ? resolveMemberIdsOrFail(Number(tenantId), wanted, res) : [];
    if (!add) return; // 400 already written
    const remove = (Array.isArray(req.body?.removeUserIds) ? req.body.removeUserIds : [])
      .slice(0, GROUP_MEMBER_MAX)
      .map((v: unknown) => Math.trunc(Number(v) || 0))
      .filter((v: number) => v > 0);
    try {
      const members = updateGroupMembers(Number(tenantId), threadId, add, remove, Number(req.user.id), Date.now());
      if (!members) return res.status(404).json({ error: "Not found" });
      storage.logActivity(req.user?.id ?? null, "chat.group.members_changed", "tenant", Number(tenantId),
        { threadId, added: add.length, removed: remove.length }, undefined);
      res.json({ members });
    } catch (e: any) {
      res.status(e?.httpStatus === 400 ? 400 : 500).json({ error: e?.message ?? "Couldn't change the crew" });
    }
  });

  // POST /api/chat/threads/:id/leave — walk out of a group yourself. No
  // capability needed: staying in a room is the member's choice, not
  // management's. Group only (the store refuses DMs), 404 on any miss, and
  // the last one out dissolves the room rather than orphaning it.
  app.post("/api/chat/threads/:id/leave", requireCapability("field.app.use"), (req: any, res: Response) => {
    const tenantId = req.user?.tenantId;
    const threadId = Number(req.params.id);
    if (tenantId == null || !Number.isFinite(threadId)) return res.status(404).json({ error: "Not found" });
    if (!leaveGroup(Number(tenantId), threadId, Number(req.user.id))) {
      return res.status(404).json({ error: "Not found" });
    }
    res.json({ ok: true });
  });

  // DELETE /api/chat/threads/:id — dissolve a group (messages and all).
  // Group only: a DM is its two members' history, and no third party — with
  // any capability — gets to erase it.
  app.delete("/api/chat/threads/:id", requireCapability("commission.structure.manage"), (req: any, res: Response) => {
    const tenantId = req.user?.tenantId;
    const threadId = Number(req.params.id);
    if (tenantId == null || !Number.isFinite(threadId)) return res.status(404).json({ error: "Not found" });
    if (!deleteGroupThread(Number(tenantId), threadId)) {
      return res.status(404).json({ error: "Not found, or not a group" });
    }
    storage.logActivity(req.user?.id ?? null, "chat.group.deleted", "tenant", Number(tenantId), { threadId }, undefined);
    res.json({ ok: true });
  });

  // ── Phone notifications ─────────────────────────────────────────────────────
  // The public VAPID key. Public by design — it is the applicationServerKey the
  // browser needs to call pushManager.subscribe(), and it identifies us to the
  // push service without authorizing anything.
  app.get("/api/push/key", requireAuth, (_req: any, res: Response) => {
    res.json({ publicKey: pushPublicKey() });
  });

  app.post("/api/push/subscribe", requireAuth, (req: any, res: Response) => {
    const tenantId = req.user?.tenantId, userId = Number(req.user?.id);
    const { endpoint, p256dh, auth, userAgent } = req.body ?? {};
    if (tenantId == null || !Number.isFinite(userId)) return res.status(403).json({ error: "Organization required" });
    // isAllowedPushEndpoint, not a scheme test. The endpoint is a URL this
    // server will later POST to from inside the production container, so
    // "starts with https://" was never a control - it let any signed-in rep
    // aim the box at an arbitrary host. See webPush.ts for the allowlist and
    // the PUSH_EXTRA_ENDPOINT_HOSTS escape hatch.
    if (!isAllowedPushEndpoint(endpoint) || !p256dh || !auth) {
      return res.status(400).json({ error: "A valid push subscription is required" });
    }
    saveSubscription({
      tenantId: Number(tenantId), userId, repId: req.user?.teamMemberId ?? null,
      endpoint, p256dh: String(p256dh), auth: String(auth),
      userAgent: typeof userAgent === "string" ? userAgent.slice(0, 300) : null,
    });
    res.json({ ok: true, devices: subscriptionCount(Number(tenantId), userId) });
  });

  app.post("/api/push/unsubscribe", requireAuth, (req: any, res: Response) => {
    const endpoint = req.body?.endpoint;
    // No ownership check needed: an endpoint is an unguessable, push-service-
    // minted URL, and deleting one only stops that device receiving.
    if (typeof endpoint === "string" && endpoint) removeSubscription(endpoint);
    res.json({ ok: true });
  });

  app.get("/api/leads", requireAuth, (req, res) => {
    const { search, limit, offset, status, zip, city, state, assignedRepId, fiberStatus, sort, scanWindow } = req.query;
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
    const sortMode = sort === "scanned_desc" ? "scanned_desc" as const : "created_desc" as const;
    const scanDays = scanWindow === "24h" ? 1 : scanWindow === "7d" ? 7 : scanWindow === "30d" ? 30 : null;

    const filterOpts = {
      status: status && status !== "all" ? String(status) : undefined,
      zip: zip ? String(zip) : undefined,
      city: city && city !== "all" ? String(city) : undefined,
      state: state && state !== "all" ? String(state) : undefined,
      assignedRepId: assignedRepId === "unassigned"
        ? "unassigned" as const
        : (assignedRepId && Number.isInteger(Number(assignedRepId)) && Number(assignedRepId) > 0 ? Number(assignedRepId) : undefined),
      fiberStatus: fiberStatus && fiberStatus !== "all" ? String(fiberStatus) : undefined,
      scannedSince: scanDays == null ? undefined : new Date(Date.now() - scanDays * 86_400_000).toISOString(),
      sort: sortMode,
      limit: lim, offset: off,
    };

    // Both paths: filters + ORDER BY + LIMIT/OFFSET + exact count pushed into
    // SQL — the old code hydrated every tenant row (53 cols × 50k) to serve a
    // 200-row page, and the interim search path capped BEFORE filtering
    // (dropping real matches — review finding).
    const dbStarted = performance.now();
    const { rows, total } = search
      ? storage.searchLeadsPage(String(search), tid, repFilter, filterOpts)
      : storage.getLeadsPage(tid, repFilter, filterOpts);
    // DB vs API split, DevTools-visible — same convention as /api/leads/map.
    res.set("Server-Timing", `leads_db;dur=${(performance.now() - dbStarted).toFixed(2)}`);
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
    // Skip-traced contacts ride along so the knock sheet and the map card can
    // show WHO lives here and which numbers are dialable. `phones` carries the
    // raw flags + scrub time, never a stored verdict — shared/tracerfy.ts
    // derives that on the client, so a scrub that ages out re-blocks a number
    // with nothing written anywhere.
    const phones = tid ? tracedPhonesForLead(tid, lead.id) : [];
    res.json({
      ...stripProviderIds(lead, user),
      ownerName: (lead as any).tracedOwnerName ?? (lead as any).ownerName ?? null,
      phones,
    });
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
    const handlerStarted = performance.now(); // Server-Timing: DB vs API split
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
      // FCC adopt-on-tap (#61): a one-tap add onto an UNWORKED fcc-imported
      // "ghost" must NOT dead-end on "already exists / no pin". Adopt it instead
      // — retag off fcc, drop it at the tapped rooftop, and hand it to the
      // tapping rep so it becomes their live, in-scope, knockable pin. The guard
      // lives in storage.adoptFccLead: it re-selects the row through the EXACT
      // purge "removable" predicate (fcc-family tag + zero history), the caller's
      // tenant, and a "not another rep's lead" check, all inside one transaction.
      // A worked/sold/non-fcc/foreign row matches nothing → undefined → we fall
      // through to today's honest-exists response below, unchanged. Adoption is
      // NOT a sale: no commission/statement row is created or touched here.
      //
      // The adopted pin lives at the tapped rooftop (parsed.data.lat/lng); if the
      // tap carried no coords we keep the ghost's own (COALESCE in the update),
      // and only if it has none either do we forward-geocode once, exactly like
      // the create path below.
      const repId = req.user?.teamMemberId ?? null;
      let adoptLat = (parsed.data as any).lat ?? null;
      let adoptLng = (parsed.data as any).lng ?? null;
      if ((adoptLat == null || adoptLng == null) &&
          (existing as any).lat == null && (existing as any).lng == null) {
        const q = [parsed.data.address, parsed.data.city, parsed.data.state, (parsed.data as any).zip]
          .filter(Boolean).join(", ");
        const geo = await forwardGeocodeOnce(q);
        if (geo) { adoptLat = geo.lat; adoptLng = geo.lng; }
      }
      const adoptedRow = storage.adoptFccLead(existing.id, tenantId, { repId, lat: adoptLat, lng: adoptLng });
      if (adoptedRow) {
        // A ghost just became a live door → same projection the create path emits
        // so the map can draw it without a refetch (repCanAccessLead authorizes
        // it: the lead is now assigned to the tapping rep, i.e. in their scope).
        emitLeadChange("status", adoptedRow, req.user, tenantId);
        recordAdminAudit({
          ...auditContext(req),
          action: "lead.fcc_adopted", targetType: "lead", targetId: adoptedRow.id,
          targetLabel: parsed.data.address ?? String(adoptedRow.id),
          before: { leadTag: (existing as any).lead_tag ?? null, assignedRepId: (existing as any).assigned_rep_id ?? null },
          after: { leadTag: adoptedRow.leadTag ?? null, assignedRepId: adoptedRow.assignedRepId ?? null },
          tenantId, outcome: "success",
        });
        const assignedRepName = repId != null
          ? (storage.getTeamMemberById(repId)?.name ?? null)
          : (req.user?.name ?? null);
        return res.status(200).json({
          ...stripProviderIds(adoptedRow, req.user),
          existed: true,
          adopted: true,
          visibility: { geocoded: true, hiddenStatus: null, inYourScope: true, assignedRepName, reason: "visible" },
        });
      }
      // Honest surfacing (phantom-duplicate fix): the map only draws a pin when
      // the lead is geocoded, NOT in a suppressing status, IN the caller's scope,
      // and in the viewport. When the existing row fails any of the first three,
      // the old {existed:true} response let the client "select a pin" that never
      // rendered → "exists but no pin". `visibility` (ADDITIVE, does not change
      // what counts as a duplicate) tells the client WHY the caller can't see it
      // so it can explain + open the lead by id instead of flashing a ghost.
      //
      // Fetch the camelCase row (findLeadByAddress returns raw snake_case) so the
      // SAME scope predicate the map/single-lead reads use (repCanAccessLead)
      // applies unchanged.
      const camel = storage.getLeadById(existing.id, tenantId);
      const HIDDEN_STATUSES = new Set(["competitor_suppressed", "scope_suppressed", "address_review"]);
      const geocoded = camel?.lat != null && camel?.lng != null;
      const hiddenStatus = camel && HIDDEN_STATUSES.has(String(camel.leadStatus)) ? String(camel.leadStatus) : null;
      // inYourScope is AUTHORITATIVE — identical to GET /api/leads/:id's gate, so
      // the client can trust it to decide whether opening the lead would 404.
      // Admin/manager => true; team_lead/rep => assigned to them/their team,
      // holds the lead's territory, or (repCanAccessLead) unassigned-in-scope.
      const inYourScope = camel ? repCanAccessLead(req.user, camel) : false;
      const reason: "ungeocoded" | "hidden_status" | "out_of_scope" | "visible" =
        !geocoded ? "ungeocoded"
        : hiddenStatus ? "hidden_status"
        : !inYourScope ? "out_of_scope"
        : "visible";
      // NEVER leak another team's rep name to a rep who shouldn't see it: only
      // when the caller may access the lead (inYourScope is already true for
      // manager+, whose scope is org-wide).
      const assignedRepName = camel?.assignedRepId != null && inYourScope
        ? (storage.getTeamMemberById(camel.assignedRepId)?.name ?? null)
        : null;
      return res.status(200).json({
        ...stripProviderIds(existing, req.user),
        existed: true,
        visibility: { geocoded, hiddenStatus, inYourScope, assignedRepName, reason },
      });
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
    // An explicit assignedRepId must be a rep of the caller's tenant — the
    // POST path used to pass it straight to the insert with none of the
    // validation /assign and PATCH apply (cross-tenant hand-off via create).
    if ((safeLead as any).assignedRepId != null) {
      const targetRep = Number((safeLead as any).assignedRepId);
      if (!Number.isInteger(targetRep) || targetRep <= 0) return res.status(400).json({ error: "Invalid assignedRepId" });
      if (!repInCallerTenant(req.user, targetRep)) return res.status(404).json({ error: "Rep not found" });
    } else if (String(req.user?.role ?? "") === "team_lead" && req.user?.teamMemberId != null) {
      // A team_lead's manual create defaults to THEIR door. Their list reads
      // are scoped to self + reports (leadVisibilityScope), so an unassigned
      // create would save and then be INVISIBLE to its creator — the client
      // confirms it into the list and the next refetch silently drops it
      // (review finding). Admin/manager creates stay in the unassigned pool;
      // their visibility is org-wide.
      (safeLead as any).assignedRepId = req.user.teamMemberId;
      (safeLead as any).assignedAt = new Date().toISOString();
    }
    // GEOCODE IS OFF THE CRITICAL PATH. A typed-in address (no client coords)
    // used to block this response on a synchronous Mapbox call (up to an 8s
    // timeout), which gated the pin AND the card that opens on the returned id —
    // the "add-lead card is slow" report. We now insert and RESPOND immediately;
    // when coords are missing we forward-geocode in the BACKGROUND and repaint
    // the pin live (SSE) once it resolves. Tap-a-house / use-my-location already
    // carry coords, so their pin is instant; a typed address lands its pin a
    // beat later instead of freezing the card. On geocode failure the lead still
    // saves (list views show it), exactly as before.
    const needsGeocode = (safeLead as any).lat == null || (safeLead as any).lng == null;
    const insertStarted = performance.now();
    const created = storage.createLead(safeLead as any);
    const insertMs = performance.now() - insertStarted;
    // A brand-new door is a pin appearing, not a pin changing — "status" is the
    // closest the wire type gets, and the projection tells the map everything it
    // needs to draw it without a refetch.
    emitLeadChange("status", created, req.user, tenantId);
    // "Adds then disappears" fix: GET /api/leads/map serves from _mapPinCache,
    // and the client re-fetches the map the instant this POST returns. Without
    // busting the cache here, that re-fetch returns the STALE pre-add list and
    // wipes the optimistic pin (it only came back later via SSE, or not at all
    // for a coords-present tap/locate add). Bust now so the immediate re-fetch
    // already includes the new pin — it stays put.
    bustMapCache(tenantId);
    // lead_insert = the SQLite write alone; lead_total = the whole handler
    // (auth already ran) — the gap between them is validation + dedupe + cache
    // busts. Geocode is backgrounded below and never appears in either number.
    res.set("Server-Timing", [
      `lead_insert;dur=${insertMs.toFixed(2)}`,
      `lead_total;dur=${(performance.now() - handlerStarted).toFixed(2)}`,
    ].join(", "));
    res.status(201).json(stripProviderIds(created, req.user));
    if (needsGeocode) {
      const q = [safeLead.address, safeLead.city, safeLead.state, (safeLead as any).zip]
        .filter(Boolean).join(", ");
      void (async () => {
        try {
          const geo = await forwardGeocodeOnce(q);
          if (!geo) return; // lead still saved; a later edit can place it
          const patched = storage.updateLead(created.id, { lat: geo.lat, lng: geo.lng } as any, tenantId);
          if (patched) {
            // Live-repaint the now-placed pin (SSE) and drop the map-pin cache so
            // any fresh /api/leads/map fetch includes it too.
            emitLeadChange("status", patched, req.user, tenantId);
            bustMapCache(tenantId);
          }
        } catch { /* geocode is best-effort; the lead is already durable */ }
      })();
    }
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
    // SEC-B: validate the VALUES of allowlisted fields too — allowlisting
    // stops mass-assignment of internal columns but used to let an unknown
    // leadStatus, a fractional assignedRepId, or a megabyte of notes through.
    const patchCheck = validateLeadPatch(req.body ?? {});
    if (!patchCheck.ok) return res.status(patchCheck.status).json({ error: patchCheck.error, code: patchCheck.code });
    const safeUpdate: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(req.body)) {
      if (ALLOWED_LEAD_FIELDS.has(k)) safeUpdate[k] = k === "assignMark" ? normalizeLeadMark(v) : v;
    }
    const tid = (req as any).user?.tenantId ?? undefined;
    // Assignment through the PATCH allowlist must pass the SAME tenant
    // validation as /api/leads/:id/assign and bulk-assign — a foreign member id
    // is a 404, never a cross-tenant hand-off.
    if (Object.prototype.hasOwnProperty.call(safeUpdate, "assignedRepId") && safeUpdate.assignedRepId != null) {
      const targetRep = Number(safeUpdate.assignedRepId);
      if (!Number.isInteger(targetRep) || targetRep <= 0) return res.status(400).json({ error: "Invalid assignedRepId" });
      if (!repInCallerTenant((req as any).user, targetRep)) return res.status(404).json({ error: "Rep not found" });
    }
    // REVIEWER GATE (fin #3 / authz #2): a manager status edit advances the
    // outcome clock — without it, a stale offline knock could clobber the
    // manager's newer decision via the CAS.
    if (typeof (safeUpdate as any).leadStatus === "string" && !(safeUpdate as any).lastOutcomeAt) {
      (safeUpdate as any).lastOutcome = (safeUpdate as any).leadStatus;
      (safeUpdate as any).lastOutcomeAt = new Date().toISOString();
    }
    const updated = storage.updateLead(Number(req.params.id), safeUpdate as any, tid);
    if (!updated) return res.status(404).json({ error: "Not found" });
    // One PATCH is three different stories to a client: who owns the door, what
    // happened at it, or what someone wrote about it. Classify from what was
    // actually allowlisted in, so a note edit doesn't make every open map repaint.
    emitLeadChange(
      "assignedRepId" in safeUpdate ? "assignment" : "leadStatus" in safeUpdate ? "status" : "notes",
      updated, (req as any).user, tid,
    );
    res.json(stripProviderIds(updated, (req as any).user));
  });
  app.delete("/api/leads/:id", requireManager, (req, res) => {
    const tid = (req as any).user?.tenantId ?? undefined;
    const result = storage.deleteLead(Number(req.params.id), tid);
    if (!result.deleted && result.reason === "not_found") return res.status(404).json({ error: "Not found" });
    if (!result.deleted) {
      // History-bearing lead: the delete was refused, not attempted (and a
      // residual FK constraint error lands here too — never a raw 500). Tell
      // the manager exactly what blocks it and what to do instead.
      const parts = [
        `${result.knocks} knock${result.knocks === 1 ? "" : "s"}`,
        `${result.commissions} commission${result.commissions === 1 ? "" : "s"}`,
      ];
      if (result.photos > 0) parts.push(`${result.photos} photo${result.photos === 1 ? "" : "s"}`);
      return res.status(409).json({
        error: `This lead has field history (${parts.join(", ")}) and can't be deleted. Ask a manager to mark it not-interested / suppressed instead.`,
        code: "LEAD_HAS_HISTORY",
        knocks: result.knocks, commissions: result.commissions, photos: result.photos,
      });
    }
    // No projection: after the row is gone there is nothing left to authorize
    // against, and shipping the PRE-delete pin would hand every subscriber a
    // patch that re-draws the door it is telling them to forget. Managers (whose
    // scope is org-wide) still receive it; a scoped rep learns the pin vanished
    // from the data-free map-changed ping deleteLead already fires.
    emitLeadEvent({
      tenantId: Number(tid ?? 0), leadId: Number(req.params.id), type: "status",
      actorId: (req as any).user?.id ?? null, actorName: (req as any).user?.name ?? null, lead: null,
    });
    res.json({ success: true });
  });

  // ── FCC-import purge — bulk-remove UNWORKED FCC-imported doors ──────────────
  // Owner ask: "the option to remove the FCC added leads." Admin-only behind the
  // SAME gate as the org-wide territory sweep (requireAdmin + the
  // reclaim_all_territories permission): deleting an entire import class is a
  // reorganization, not everyday lead management. The removal rule lives in ONE
  // place (storage.fccPurgeWhere) and is conservative: fcc-family tag ("fcc" or
  // "fcc_<suffix>", underscore LIKE-escaped) AND zero knock history AND no
  // recorded outcome AND status still 'prospect' AND no commission/sale/photo
  // rows AND not do-not-knock. A worked, sold, or in-any-way-touched door is
  // PROTECTED and stays.
  app.get("/api/leads/fcc-purge/preview", requireAdmin, (req, res) => {
    const user = (req as any).user;
    if (!can(user?.role, "reclaim_all_territories")) return res.status(403).json({ error: "not allowed" });
    const tid = user?.tenantId ?? undefined;
    // { total, removable, protected } — the dialog's blast radius, computed by
    // the exact predicate the POST below deletes with.
    res.json(storage.countFccPurge(tid));
  });

  app.post("/api/leads/fcc-purge", requireAdmin, (req, res) => {
    const user = (req as any).user;
    if (!can(user?.role, "reclaim_all_territories")) return res.status(403).json({ error: "not allowed" });
    const tid = user?.tenantId ?? undefined;
    const before = storage.countFccPurge(tid);
    // purgeFccLeads busts the pin caches + ETag data version and fires the
    // data-free map-changed ping through the deleteLead choke point — no
    // per-lead projection is emitted (same reasoning as DELETE /api/leads/:id:
    // there is nothing left to authorize a projection against).
    const removed = storage.purgeFccLeads(tid);

    // ONE audit row for the whole purge, like territory.bulk_reclaimed.
    recordAdminAudit({
      ...auditContext(req),
      action: "lead.fcc_purged", targetType: "lead",
      targetLabel: `${removed} FCC lead${removed === 1 ? "" : "s"}`,
      before: { total: before.total, removable: before.removable, protected: before.protected },
      after: { removed },
      tenantId: tid ?? null, outcome: "success",
    });

    res.json({ removed });
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
      if (result.retriable) return res.status(422).json({ received: false, reason: "unresolved - will retry" });
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
  const inspectorScope = (req: any) => {
    const city = typeof req.query.city === "string" ? req.query.city.trim().slice(0, 120) : "";
    const stateRaw = typeof req.query.state === "string" ? req.query.state.trim().toUpperCase() : "";
    const state = /^[A-Z]{2}$/.test(stateRaw) ? stateRaw : "";
    const runId = typeof req.query.runId === "string" ? req.query.runId.trim().slice(0, 160) : "";
    return { city: city || null, state: state || null, runId: runId || null };
  };
  const eventMatchesInspectorScope = (evt: any, scope: ReturnType<typeof inspectorScope>) =>
    (!scope.runId || evt.runId === scope.runId)
    && (!scope.city || String(evt.city ?? "").trim().toLowerCase() === scope.city.toLowerCase())
    && (!scope.state || String(evt.state ?? "").trim().toUpperCase() === scope.state);
  app.get("/api/scan/inspector", requireAdmin, (req, res) => {
    const scope = inspectorScope(req);
    const limit = Math.min(500, Math.max(10, Number(req.query.limit) || 200));
    const snap = getInspectorSnapshot({ ...scope, limit });
    res.json({ ...snap, scope, rows: (snap.rows as any[])?.map(withCorrelation) ?? snap.rows, health: inspectorHealth() });
  });

  app.get("/api/scan/inspector/timeline/:key", requireAdmin, (req, res) => {
    res.json({ correlationId: String(req.params.key), timeline: getAddressTimeline(String(req.params.key), 80).map(withCorrelation) });
  });

  // SSE — streams each stage event as it happens. Never polls static counters.
  app.get("/api/scan/inspector/stream", requireAdmin, (req, res) => {
    const scope = inspectorScope(req);
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
    send("snapshot", { ...getInspectorSnapshot({ ...scope, limit: 200 }), scope, health: inspectorHealth() });
    const unsub = onScanEvent((evt) => {
      if (eventMatchesInspectorScope(evt, scope)) send("stage", withCorrelation(evt));
    });
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
      techType: result.