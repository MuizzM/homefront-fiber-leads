import crypto from "node:crypto";
import { db, rawDb } from "./db";
import { normalizeKineticAddressKey, canonicalAddressPart, NORMALIZATION_VERSION } from "./addressKey";
import { streetKeyOf, addressIdentityIssues } from "@shared/addressKey";
import { evaluateSingleCompetitor } from "@shared/competitiveEligibility";
import { ensureAdminAuditSchema } from "./adminAudit";
import { runKineticBuildMigrations as ensureKineticBuildSchema } from "./kineticBuildMigrations";
import { runAcademyMigrations as ensureAcademySchema } from "./academyMigrations";
import { runLiveOpsMigrations as ensureLiveOpsSchema } from "./liveOpsMigrations";
import { runRepMetricsMigrations as ensureRepMetricsSchema } from "./repMetricsMigrations";
import { attachShiftAndDwell, markRepDayDirty } from "./repMetricsStore";
import { runVendorOrderMigrations as ensureVendorOrderSchema } from "./vendorOrderMigrations";
import { runCommissionFileMigrations as ensureCommissionFileSchema } from "./commissionFileMigrations";
import { runGuardedActionMigrations as ensureGuardedActionSchema } from "./guardedActionMigrations";
import { recordTransition } from "./fiberTransitions";
import {
  leads, scanTargets, fiberChecks, teamMembers, knockLog,
  users, sessions, otpCodes, territories, repApplications,
  territoryRequests, locationPings, clockSessions,
  commissions, commissionRates, activityLog, tenants,
  leadPhotos,
  type LeadPhoto,
  type Lead, type InsertLead,
  type FiberCheck, type InsertFiberCheck,
  type TeamMember, type InsertTeamMember,
  type Knock, type InsertKnock,
  type User, type InsertUser,
  type Session,
  type Territory, type InsertTerritory,
  type RepApplication,
  type TerritoryRequest,
  type LocationPing, type InsertLocationPing,
  type ClockSession,
  type Commission, type InsertCommission,
  type CommissionRate, type InsertCommissionRate,
  type ActivityLogEntry,
  type Tenant, type InsertTenant,
} from "@shared/schema";
import { eq, desc, or, and, gt, lt, isNull, inArray, sql } from "drizzle-orm";

/** Statuses that BLOCK a new commission on the same door.
 *
 *  "paid" is deliberately NOT here, and that is the whole subtlety. Including it
 *  looked obviously right — a paid sale is credited, so do not credit it twice —
 *  but `paid` is TERMINAL in LEGAL_TRANSITIONS (paid → paid only). There is no
 *  reachable escape: paid→disputed is 409 ILLEGAL_TRANSITION, and "superseded"
 *  is written only by a one-time migration and is not a legal current status.
 *  So blocking on `paid` meant that once a door's commission was paid, that door
 *  could NEVER earn again — a genuine re-sale after a chargeback silently booked
 *  nothing, HTTP 200, no error, no way for a manager to unblock it.
 *
 *  That is a worse bug than the double-pay it was meant to prevent: double-pay
 *  is visible and clawable, silent non-pay is neither. Pending and approved are
 *  enough, because those are the states in which an unpaid entitlement for this
 *  door is still outstanding. */
export const LIVE_COMMISSION_STATUSES = ["pending", "approved"] as const;
import { allocateRepColor, repColorOf } from "@shared/repColors";
import { DEFAULT_GEO_CONFIG, type GeoConfig } from "@shared/geoVerify";
import { territoryHeldByAny, parseAssigneeIds } from "@shared/territory";
import { repVisibilitySql } from "@shared/leadVisibility";
import { syncAssignments } from "./territoryAssignments";
import { bumpTerritoryVersion } from "./territoryScopeCache";
import { INCONCLUSIVE_GIVEUP } from "@shared/scanPolicy";
import { DEFAULT_WORKWEEK, localWallToUtcMs, localYmdParts } from "@shared/workweek";
import {
  planLegacyCommissionTransition,
  type LegacyCommissionLifecycleErrorCode,
  type LegacyCommissionStatus,
} from "@shared/legacyCommissionLifecycle";

// Legacy scanner columns that exist in SQLite but predate the drizzle schema —
// upsertLeadByAddress still persists them when a scanner payload carries them.
type LegacyScanFields = { maxDownload?: number | null; isNewDeployment?: boolean | null };

// ── Session lifetime ─────────────────────────────────────────────────────────
// Field reps work full shifts on weak signal; being bounced to the Login screen
// mid-knock is a data-loss-shaped event, so the window is generous AND SLIDING
// (storage.touchSession restarts the clock on every authenticated request).
// SESSION_TTL_MS is therefore "how long you may stay AWAY before signing in
// again", not "how long a shift may last" — comfortably covering a 24h day.
// Override per-deployment with SESSION_TTL_HOURS.
const SESSION_TTL_HOURS = Math.min(720, Math.max(24, Number(process.env.SESSION_TTL_HOURS) || 24 * 7));
export const SESSION_TTL_MS = SESSION_TTL_HOURS * 60 * 60 * 1000;
// Hard ceiling measured from login: renewal can extend a session repeatedly,
// but never past this, so a lost or stolen device eventually falls out.
export const SESSION_ABSOLUTE_MAX_MS = Math.max(
  SESSION_TTL_MS,
  Math.min(365, Math.max(1, Number(process.env.SESSION_ABSOLUTE_MAX_DAYS) || 30)) * 24 * 60 * 60 * 1000,
);
// Only rewrite expires_at once it has drifted at least this far, so a burst of
// knocks costs one write per hour rather than one per request.
const SESSION_RENEW_SLACK_MS = 60 * 60 * 1000;

// An open follow-up: a lead whose latest knock is a scheduled callback, OR a
// lead centrally/bulk-marked follow_up with no newer knock (see
// getOpenCallbacks). Display fields come from the lead; the schedule + note from
// the knock when one exists. No provider-internal ids are ever included.
export interface OpenCallback {
  leadId: number;
  address: string; city: string; state: string | null; zip: string | null;
  lat: number | null; lng: number | null;
  leadStatus: string; leadTag: string | null; leadScore: number | null;
  contactName: string | null;
  assignedRepId: number | null;
  // The rep who scheduled the callback; for a lead-level follow-up (no knock)
  // this is the door's current owner, which may be null (unassigned).
  repId: number | null;
  callbackDate: string;          // "YYYY-MM-DD" (derived from last_outcome_at for lead-level rows)
  callbackTime: string | null;   // "HH:MM"
  notes: string | null;
  setAt: string;                 // when the callback/mark was logged
}

export interface LegacyCommissionMutationCommand {
  id: number;
  tenantId: number;
  actorUserId: number;
  expectedRevision: number;
  expectedStatus: LegacyCommissionStatus;
  status: LegacyCommissionStatus;
  paidDate?: string;
  notes?: string | null;
  ip?: string;
}

export type LegacyCommissionMutationResult =
  | { kind: "updated"; commission: Commission }
  | { kind: "unchanged"; commission: Commission }
  | { kind: "not_found" }
  | { kind: "stale" }
  | { kind: "rejected"; code: Exclude<LegacyCommissionLifecycleErrorCode, "STALE_VERSION">; message: string }
  | {
      kind: "failed";
      code: "LEGACY_COMMISSION_TRANSACTION_FAILED";
      failureCategory: "transaction";
    };

// Server-computed location verdict written alongside a knock (never client-set).
export type KnockVerdict = {
  serverTs: string;
  distanceM: number | null;
  verificationStatus: string;
  reviewReason: string | null;
};

// The map projection intentionally excludes homeowner/contact PII. The card
// fetches that data lazily from /api/leads/:id only after a user opens a lead.
// Visit metadata is joined in this same scoped query so loading the map never
// performs a second tenant-wide knock-log scan.
export interface MapPinRow {
  id: number;
  address: string;
  city: string;
  state: string | null;
  zip: string | null;
  lat: number | null;
  lng: number | null;
  leadStatus: string;
  fiberStatus: string | null;
  assignedRepId: number | null;
  // The area the door belongs to. Carried purely so the client can resolve WHO
  // works this door — assignedRepId is one primary, but an area is many-to-many
  // (territories.assignee_ids), and the client already holds the territory list.
  assignedTerritoryId?: number | null;
  leadScore: number | null;
  leadTag: string | null;
  freshConfidence: string | null;
  /** Independent-evidence provenance (JSON list) + the field-verification
   *  stamp. Carried on the pin so the FCC source filter / "Field-verified"
   *  pill is a client-side computation, not a per-lead detail fetch. */
  freshSources?: string | null;
  freshConfirmedAt?: string | null;
  carrier?: string | null;
  assignMark?: string | null;
  /** Compliance block: the occupant asked us never to return. Raw SQLite
   *  0/1 — the pin builder normalizes truthy → `true` and omits otherwise. */
  doNotKnock?: number | boolean | null;
  /** The lead row's OWN disposition (CAS-ordered; written by knocks AND
   *  central marks). Preferred over the knock join when at least as new. */
  leadLastOutcome?: string | null;
  leadLastOutcomeAt?: string | null;
  knockCount: number | null;
  lastOutcome: string | null;
  lastKnockedAt: string | null;
}

/** Narrow lead row for the territory progress/activity math — just the fields
 * territoryProgressRow and the area activity feed actually read. SQLite booleans
 * arrive as 0/1 (callers already test both forms). */
export interface TerritoryProgressLead {
  id: number;
  address: string;
  city: string;
  state: string;
  zip: string;
  lat: number | null;
  lng: number | null;
  leadStatus: string;
  doNotKnock: number | boolean | null;
}

/** Narrow knock row for the territory progress metrics (order-independent math). */
export interface TerritoryProgressKnock {
  leadId: number;
  outcome: string;
  wasHome: number | boolean | null;
  knockedAt: string;
  verificationStatus: string | null;
  distanceM: number | null;
}

/** Knock row for the per-area verified-location activity feed. */
export interface TerritoryActivityKnock {
  id: number;
  leadId: number;
  repId: number | null;
  outcome: string;
  knockedAt: string;
  deviceTs: string | null;
  serverTs: string | null;
  verificationStatus: string | null;
  distanceM: number | null;
  gpsAccuracy: number | null;
  reviewReason: string | null;
  netState: string | null;
  repLat: number | null;
  repLng: number | null;
}

/** Narrow lead row for the /api/stats aggregation loop. */
export interface LeadStatsRow {
  leadStatus: string;
  fiberStatus: string;
  isNewFiber: number | boolean | null;
  isTenured: number | boolean | null;
  assignedRepId: number | null;
  city: string | null;
  state: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** Spatial/tag window for the bbox mode of /api/leads/map. When present the
 *  map query adds a lat/lng BETWEEN predicate (and an optional lead_tag
 *  exact-or-prefix match), orders by id, and hard-caps at `limit` rows. The
 *  tenant/rep scoping is UNCHANGED — the window narrows the same scoped set.
 *
 *  `sampleStep` (>1) additionally thins the window to rows whose id is a
 *  multiple of the step — the deterministic even sample the wide-zoom path
 *  uses when the window holds more rows than the cap. Modulo over id spreads
 *  the sample across insertion order (which correlates with geography
 *  per-scan), unlike ORDER BY id LIMIT whose prefix is the first-scanned
 *  town only. */
/** Map content views — a LENS over the same scoped pin set, never a deletion.
 *  "latest" hides the established-footprint FCC import (fcc_fiber_d25) so the
 *  map renders the newly-lit + field-verified + organic + manual-add pins
 *  (NULL tags included); the footprint stays one tap away via the unfiltered
 *  view. */
export type MapView = "latest" | "kinetic_2026";
/** The one tag the "latest" view excludes. */
export const MAP_LATEST_VIEW_EXCLUDED_TAG = "fcc_fiber_d25";
/** The tag promoted Kinetic 2026 builds carry (server/kineticBuildStore.ts).
 *  Named here as well so the lens predicate and the promoter cannot drift -
 *  the same belt-and-braces the LATEST_VIEW_EXCLUDED_TAG pair uses. */
export const MAP_KINETIC_2026_TAG = "kinetic_build_2026";

export interface MapPinWindow {
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
  tag?: string;
  view?: MapView;
  limit?: number;
  sampleStep?: number;
}

/** Density window for the aggregate tier of the field map (span wider than
 *  the pin path's 3° guard). `cell` is the grid pitch in degrees; rows are
 *  GROUP BY integer floor buckets of lat/lng over the SAME scoped set the pin
 *  window reads, so a zoom-in crossing never changes which doors exist — only
 *  how they're rendered. */
export interface MapGridWindow extends MapPinWindow {
  cell: number;
}

/** One aggregated density cell: `lat`/`lng` are the cell CENTER, `n` the
 *  number of scoped, pin-eligible leads inside the cell. */
export interface MapGridCell {
  lat: number;
  lng: number;
  n: number;
  /** Confirmed-fresh leads in the cell (lead_tag = 'fresh_fiber_confirmed' —
   *  the exact predicate the pin clusters' fresh_count sums). Omitted when 0. */
  fresh?: number;
}

// Result of a guarded lead delete. A lead with field history (knock_log /
// commissions / lead_photos rows) is REFUSED, not deleted — the probe runs in
// the same IMMEDIATE transaction as the delete, and even a residual FK
// constraint error is converted into the same refusal instead of a raw 500.
// "not_found" keeps the route's 404 semantics (absent row, or another
// tenant's row under the tenant predicate).
export type LeadDeleteResult =
  | { deleted: true }
  | { deleted: false; reason: "not_found" }
  | { deleted: false; reason: "has_history"; knocks: number; commissions: number; photos: number };

export type LeadListSort = "created_desc" | "scanned_desc";
export type LeadListOptions = {
  status?: string;
  zip?: string;
  city?: string;
  state?: string;
  assignedRepId?: number | "unassigned";
  fiberStatus?: string;
  /** ISO timestamp. When set, only rows backed by scan evidence at/after it are returned. */
  scannedSince?: string;
  sort?: LeadListSort;
  limit: number;
  offset: number;
};

// What a set-based territory lead write actually did.
//
//  changed — the TRUE changed-row count (SQLite's .changes), which is what the
//            routes hand back as leadsAffected/leadsReleased. It counts rows the
//            statement moved, never rows it merely considered: each primitive's
//            predicate IS the diff the per-lead loop used to walk, so a door
//            already in the target state is not selected and not counted.
//  leadIds — those same rows' ids, read in the same transaction as the write.
//            The loops these replaced emitted one live assignment event per
//            moved door; the caller replays exactly that set from this list.
export interface TerritoryLeadWrite { changed: number; leadIds: number[] }

export interface IStorage {
  // ── Leads ──────────────────────────────────────────────────────────────────
  getLeads(tenantId?: number, assignedRep?: number | number[]): Lead[];
  getLeadFacets(tenantId?: number, repScope?: number[]): Array<{ city: string; state: string }>;
  getLeadsDataVersion(tenantId?: number): string;
  getLeadsForMap(tenantId?: number, assignedRep?: number | number[], window?: MapPinWindow, view?: MapView): MapPinRow[];
  // SQL-side density aggregation over the exact map scope (tenant + rep
  // visibility + pin eligibility) — powers the wide-zoom tier where shipping
  // individual pins is impossible. Fetches limit+1 so the caller can flag
  // truncation, mirroring the pin window's contract.
  getLeadsMapGrid(tenantId: number | undefined, assignedRep: number | number[] | undefined, window: MapGridWindow): MapGridCell[];
  // Cheap COUNT over the exact map scope (tenant + rep visibility + pin
  // eligibility) — powers the client's full-feed-vs-viewport-mode decision
  // without downloading a single pin.
  getLeadsMapCount(tenantId?: number, assignedRep?: number | number[], view?: MapView): number;
  // COUNT over the SAME scoped + windowed predicate getLeadsForMap uses —
  // the wide-zoom sampler's step calculation (only runs when a window
  // overflows the row cap, so the extra indexed count stays rare).
  getLeadsMapWindowCount(tenantId: number | undefined, assignedRep: number | number[] | undefined, window: MapPinWindow): number;
  getLeadsPage(
    tenantId: number | undefined,
    assignedRep: number | number[] | undefined,
    opts: LeadListOptions,
  ): { rows: LeadListRow[]; total: number };
  getLeadById(id: number): Lead | undefined;
  findLeadByAddress(tenantId: number | null, address: string, city: string, state: string, zip: string): Lead | undefined;
  createLead(lead: InsertLead): Lead;
  upsertLeadByAddress(lead: InsertLead & LegacyScanFields): { lead: Lead; created: boolean };
  updateLead(id: number, updates: Partial<InsertLead>, tenantId?: number): Lead | undefined;
  // P1-1: CAS outcome flip — wins only when no outcome exists yet or this knock
  // is NEWER than the recorded one. Returns the updated lead, or undefined when
  // a newer outcome already exists (caller must skip ALL money side effects).
  applyKnockOutcomeCas(leadId: number, status: string, outcome: string, knockedAt: string): Lead | undefined;
  deleteLead(id: number, tenantId?: number): LeadDeleteResult;
  // ── FCC-import purge (admin bulk removal) ──────────────────────────────────
  // Preview counts + the delete itself share ONE SQL predicate (fccPurgeWhere)
  // so the numbers an admin confirmed are exactly the rows removed. Removable =
  // fcc-family tag AND completely unworked; everything else is protected.
  countFccPurge(tenantId?: number): { total: number; removable: number; protected: number };
  purgeFccLeads(tenantId?: number): number;
  // FCC adopt-on-tap (#61): atomically turn an UNWORKED fcc ghost into the
  // tapping rep's own live pin (retag off fcc, drop at the tapped rooftop,
  // assign to the rep). Guarded by the SAME "removable" predicate the purge
  // uses; returns the updated row, or undefined when the row is not adoptable
  // (worked/sold/non-fcc/foreign/another rep's) so the caller keeps honest-exists.
  adoptFccLead(leadId: number, tenantId: number, opts: { repId: number | null; lat?: number | null; lng?: number | null }): Lead | undefined;
  searchLeadsPage(
    query: string,
    tenantId: number | undefined,
    assignedRep: number | number[] | undefined,
    opts: LeadListOptions,
  ): { rows: LeadListRow[]; total: number };
  // ── Fiber checks ───────────────────────────────────────────────────────────
  createFiberCheck(check: InsertFiberCheck): FiberCheck;
  getRecentChecks(limit?: number, tenantId?: number): FiberCheck[];
  // ── Team members ───────────────────────────────────────────────────────────
  getTeamMembers(tenantId?: number): TeamMember[];
  getTeamMemberById(id: number): TeamMember | undefined;
  createTeamMember(member: InsertTeamMember): TeamMember;
  updateTeamMember(id: number, updates: Partial<InsertTeamMember>, tenantId?: number): TeamMember | undefined;
  deleteTeamMember(id: number, tenantId?: number): boolean;
  // ── Knock log ──────────────────────────────────────────────────────────────
  getKnocks(tenantId?: number, limit?: number): Knock[];
  getKnocksByLead(leadId: number): Knock[];
  /** Newest-first (id DESC) slice of a rep's knocks, LIMIT pushed into SQL —
   * the rep-activity card needs 50 rows, not the rep's full hydrated history. */
  getRecentKnocksByRep(repId: number, limit: number): Knock[];
  /** The rep's most recent GPS-located knock (impossible-travel reference),
   * picked by one indexed seek instead of hydrating + sorting every knock the
   * rep has ever logged on the hot knock-write path. */
  getLatestLocatedKnockByRep(repId: number): { repLat: number; repLng: number; deviceTs: string | null; knockedAt: string } | undefined;
  getOpenCallbacks(tenantId?: number, opts?: { repIds?: number[] }): OpenCallback[];
  /** Narrow tenant-scoped projections for the territory progress/activity
   * computations — same rows getLeads/getKnocks return, minus the wide-column
   * hydration those O(all-rows) reads paid on every request. */
  getLeadsForTerritoryProgress(tenantId?: number): TerritoryProgressLead[];
  getKnocksForTerritoryProgress(tenantId?: number): TerritoryProgressKnock[];
  /** Per-area activity feed rows, filtered in SQL to the given lead ids. */
  getKnocksForTerritoryActivity(tenantId: number | undefined, leadIds: number[]): TerritoryActivityKnock[];
  /** id → "address, city" pairs for a bounded id set (activity feed join). */
  getLeadAddressesByIds(ids: number[], tenantId?: number): Array<{ id: number; address: string; city: string }>;
  /** Narrow projection feeding /api/stats aggregation (same scoping as getLeads). */
  getLeadStatsRows(tenantId?: number, assignedRep?: number | number[]): LeadStatsRow[];
  // ── Lead photos ─────────────────────────────────────────────────────────────
  createLeadPhoto(p: { leadId: number; userId?: number | null; repId?: number | null; path: string }): LeadPhoto;
  getLeadPhotos(leadId: number): LeadPhoto[];
  getLeadPhotoById(id: number): LeadPhoto | undefined;
  createKnock(knock: InsertKnock, verdict?: KnockVerdict): Knock;
  getKnockById(id: number): Knock | undefined;
  getKnockByClientId(clientId: string): Knock | undefined;
  updateKnockNotes(id: number, notes: string): Knock | undefined;
  getSetting(key: string, tenantId?: number | null): string | undefined;
  setSetting(key: string, value: string, updatedBy?: number | null, tenantId?: number | null): void;
  getGeoConfig(tenantId?: number | null): GeoConfig;
  overrideKnockVerification(knockId: number, newStatus: string, reason: string, actorUserId: number | null, actorName: string | null): Knock | undefined;
  getVisitSummary(tenantId?: number): Map<number, { count: number; lastOutcome: string; lastAt: string }>;
  // ── Leaderboard ────────────────────────────────────────────────────────────
  getLeaderboard(window?: { since?: string; until?: string }): { rep: TeamMember; knocks: number; contacts: number; callbacks: number; sales: number; knocksToday: number; salesToday: number }[];
  // ── Users ──────────────────────────────────────────────────────────────────
  getUserByEmail(email: string): User | undefined;
  getUserById(id: number): User | undefined;
  getAllUsers(tenantId?: number): User[];
  createUser(user: InsertUser): User;
  updateUser(id: number, updates: Partial<InsertUser>, tenantId?: number): User | undefined;
  deleteUser(id: number, tenantId?: number): boolean;
  isFirstRun(): boolean;
  // ── Sessions ───────────────────────────────────────────────────────────────
  createSession(userId: number): Session;
  getSession(id: string): Session | undefined;
  /** Slide an authenticated session's expiry forward (see implementation). */
  touchSession(session: Session): Session;
  deleteSession(id: string): void;
  deleteSessionsByUser(userId: number): number;
  // ── OTP ────────────────────────────────────────────────────────────────────
  createOtp(email: string): string;
  verifyOtp(email: string, code: string): boolean;
  // ── Territories ────────────────────────────────────────────────────────────
  getTerritories(tenantId?: number): Territory[];
  getTerritoriesByRep(repId: number, tenantId?: number): Territory[];
  getTerritoryById(id: number): Territory | undefined;
  getLeadsByTerritory(territoryId: number): Lead[];
  /** Set-based territory hand-off: one UPDATE, one transaction, one cache
   * bust. Returns the changed-row count. */
  bulkAssignTerritoryLeads(opts: { territoryId: number; repId: number; at: string; assignmentSource?: string }): number;
  /** Set-based release of an area's doors back to the pool (rep +
   * assignment paperwork cleared; the territory link stays). Returns the
   * changed-row count. */
  bulkUnassignTerritoryLeads(opts: { territoryId: number; at: string }): number;
  /** Hand an area's doors to `repId` — EXCEPT the ones a rep in `keepRepIds`
   *  already holds, who keep theirs untouched. */
  bulkAssignTerritoryLeadsExcept(opts: {
    territoryId: number; repId: number; at: string; keepRepIds: number[];
    assignmentSource?: string; tenantId?: number;
  }): TerritoryLeadWrite;
  /** Empty an area: every door still held goes back to the open pool — no rep
   *  AND no area. */
  bulkReturnTerritoryLeadsToPool(opts: { territoryId: number; at: string; tenantId?: number }): TerritoryLeadWrite;
  /** Take ONE rep off an area's doors. The AREA keeps them. */
  bulkReleaseTerritoryLeadsFromRep(opts: { territoryId: number; repId: number; at: string; tenantId?: number }): TerritoryLeadWrite;
  addTerritoryEvent(territoryId: number, actorUserId: number | null, type: string, payload?: unknown): void;
  addLeadEvent(leadId: number, type: "assignment" | "note", actor: string | null, detail?: unknown): void;
  getLeadEvents(leadId: number, limit?: number): { id: number; leadId: number; type: string; actor: string | null; detail: any; at: string }[];
  recordLeadStatusEvent(input: { leadId: number; displayActor: string; source: string; outcome: string; newStatus: string; prevStatus: string | null; actorUserId: number | null; actorName: string | null; assignee: number | null; idemKey?: string | null; at?: string }): { inserted: boolean };
  getTerritoryEvents(territoryId: number): any[];
  createTerritory(t: InsertTerritory): Territory;
  updateTerritory(id: number, updates: Partial<InsertTerritory>): Territory | undefined;
  deleteTerritory(id: number): boolean;
  // ── Territory Requests ─────────────────────────────────────────────────────
  getTerritoryRequests(status?: string): TerritoryRequest[];
  createTerritoryRequest(repId: number, userId: number, message?: string): TerritoryRequest;
  updateTerritoryRequest(id: number, status: string): TerritoryRequest | undefined;
  // ── Rep Applications ───────────────────────────────────────────────────────
  getRepApplications(status?: string, tenantId?: number): RepApplication[];
  getRepApplicationById(id: number): RepApplication | undefined;
  createRepApplication(app: any): RepApplication;
  updateRepApplication(id: number, updates: Partial<RepApplication>): RepApplication | undefined;
  // ── GPS Location Pings ─────────────────────────────────────────────────────
  createLocationPing(ping: InsertLocationPing): LocationPing;
  getLatestPingPerRep(tenantId?: number): LocationPing[];
  getPingsByRep(repId: number, limit?: number): LocationPing[];
  // ── Clock Sessions ─────────────────────────────────────────────────────────
  clockIn(repId: number, userId: number, notes?: string): ClockSession;
  clockOut(sessionId: number): ClockSession | undefined;
  getActiveClockSession(repId: number): ClockSession | undefined;
  getAllClockSessions(date?: string, tenantId?: number): ClockSession[];
  // ── Scan targets (persistent address pool) ───────────────────────────────────
  upsertScanTargets(addrs: Array<{ address: string; city?: string; state?: string; zip?: string; lat?: number | null; lng?: number | null; source?: string; tenantId?: number | null; canonicalKey?: string | null; dfAddressId?: string | null; scannedNow?: boolean; fiberStatus?: string | null; isNewFiber?: boolean; billingStatus?: string | null }>): number;
  getScanTargetsToRescan(limit: number): any[];
  getScanTargetsByCity(city: string, state: string): any[];
  recordScanTargetResult(id: number, r: { fiberStatus?: string | null; fiberAvailable?: boolean; isNewFiber?: boolean; billingStatus?: string | null; dfAddressId?: string | null; convertedToLeadId?: number | null; availabilityStatus?: string | null; newlyLive?: boolean; customerSegment?: string; customerConfidence?: string; customerSignals?: string[] }): { prevIsNewFiber: boolean };
  /** Advance the needs-fix ledger; returns the updated count (0 when the
   * address already has a conclusive answer — the ledger only counts while
   * it has never been answered). */
  bumpScanTargetInconclusive(ref: { id?: number; address?: string }): number;
  getScanTargetStats(): { total: number; scanned: number; neverScanned: number; newFiber: number; lastScannedAt: string | null };
  // ── Commissions ────────────────────────────────────────────────────────────
  getCommissions(tenantId?: number, repId?: number): Commission[];
  /** A commission on this door that is still on the money path (pending,
   *  approved or paid) — the guard against paying one sale twice. */
  findLiveCommissionForLead(tenantId: number | null | undefined, leadId: number): Commission | undefined;
  getCommissionById(id: number, tenantId: number): Commission | undefined;
  createCommission(c: InsertCommission): Commission;
  transitionLegacyCommission(command: LegacyCommissionMutationCommand): LegacyCommissionMutationResult;
  removePendingCommissionsForLead(leadId: number): Commission[];
  getCommissionSummary(tenantId: number): { repId: number; repName: string; total: number; paid: number; pending: number; sales: number }[];
  // ── Commission Rates ───────────────────────────────────────────────────────
  getCommissionRates(tenantId?: number): CommissionRate[];
  createCommissionRate(r: InsertCommissionRate): CommissionRate;
  updateCommissionRate(id: number, updates: Partial<CommissionRate>): CommissionRate | undefined;
  // ── Activity Log ───────────────────────────────────────────────────────────
  logActivity(userId: number | null, action: string, entityType?: string, entityId?: number, details?: object, ip?: string, tenantIdOverride?: number | null): void;
  getActivityLog(limit?: number, tenantId?: number): ActivityLogEntry[];
  // ── Tenants (SaaS) ────────────────────────────────────────────────────────
  getTenants(): Tenant[];
  getTenantById(id: number): Tenant | undefined;
  getTenantBySlug(slug: string): Tenant | undefined;
  createTenant(t: InsertTenant): Tenant;
  updateTenant(id: number, updates: Partial<Tenant>): Tenant | undefined;
  deleteTenant(id: number): void;
  getTenantStats(tenantId: number): { reps: number; leads: number; sold: number; territories: number };
}

// Which sweep a knock belongs to: the current pass of the lead's area. A lead
// with no territory (unassigned, or worked off-map) is pass 1 — there is no area
// whose pass could have been advanced. Kept raw + defensive because knocks are
// written on the hot offline-flush path and must never fail on a legacy schema.
function currentPassForLead(leadId: number): number {
  try {
    const row = rawDb.prepare(
      `SELECT COALESCE(t.current_pass, 1) AS p
         FROM leads l LEFT JOIN territories t ON t.id = l.assigned_territory_id
        WHERE l.id = ?`,
    ).get(leadId) as { p?: number } | undefined;
    return Math.max(1, Number(row?.p ?? 1) || 1);
  } catch {
    return 1; // column not migrated yet — first pass by definition
  }
}

// ── Migrations ────────────────────────────────────────────────────────────────
export function runMigrations() {
  const raw = (db as any).driver ?? (db as any).$client;
  const stmts = [
    // ── tenants — MUST be first ────────────────────────────────────────────────
    // Historically this table only ever came from `drizzle-kit push`, so a fresh
    // deploy (build → start, no db:push) booted WITHOUT it: the `ALTER TABLE
    // tenants …` statements below and bootstrapDefaultTenant() both silently
    // failed ("no such table: tenants"), leaving the entire multi-tenant model
    // broken. Create the base table idempotently here; the ALTERs further down
    // add the remaining optional columns.
    `CREATE TABLE IF NOT EXISTS tenants (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, company_name TEXT NOT NULL, owner_name TEXT NOT NULL, owner_email TEXT NOT NULL UNIQUE, brand_name TEXT NOT NULL, tagline TEXT DEFAULT 'Field Sales Intelligence', plan TEXT NOT NULL DEFAULT 'trial', status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    // Existing tables
    `CREATE TABLE IF NOT EXISTS team_members (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT, email TEXT, role TEXT NOT NULL DEFAULT 'rep', active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS knock_log (id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id INTEGER NOT NULL, rep_id INTEGER NOT NULL, knocked_at TEXT NOT NULL DEFAULT (datetime('now')), was_home INTEGER NOT NULL, outcome TEXT NOT NULL, callback_date TEXT, callback_time TEXT, notes TEXT)`,
    `ALTER TABLE leads ADD COLUMN assigned_rep_id INTEGER`,
    `ALTER TABLE leads ADD COLUMN assigned_by TEXT`,
    `ALTER TABLE leads ADD COLUMN billing_status TEXT`,
    `CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT, role TEXT NOT NULL DEFAULT 'rep', team_member_id INTEGER, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS otp_codes (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, code TEXT NOT NULL, expires_at TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    // Per-code brute-force guard: count wrong guesses and burn the code after ~5, so
    // a 6-digit code can't be ground down within its window even across restarts /
    // instances (defense in depth beyond the in-memory per-email rate limiter).
    `ALTER TABLE otp_codes ADD COLUMN failed_attempts INTEGER NOT NULL DEFAULT 0`,
    // Persistent login-attempt audit (owner ask 2026-07-26): every OTP request and
    // verify outcome — who, when, IP, result — survives the nightly OTP purge.
    `CREATE TABLE IF NOT EXISTS login_attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, kind TEXT NOT NULL, success INTEGER NOT NULL DEFAULT 0, reason TEXT, ip TEXT, user_agent TEXT, tenant_id INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `ALTER TABLE login_attempts ADD COLUMN tenant_id INTEGER`,
    // P0-1 (K3 swarm): super-admin identity must be IMMUTABLE — an email string
    // is user-editable (see requireSuperAdmin). Column stamped once at boot
    // from the env list; the env list can only REMOVE the apex by restart+env,
    // never be claimed by editing a user row.
    `ALTER TABLE users ADD COLUMN is_super_admin INTEGER NOT NULL DEFAULT 0`,
    // Training gate: a NEW account owes training before the field opens. Defaults
    // ON so anyone created from here forward is gated; server/trainingGateStore.ts
    // runs a one-time backfill clearing it for everyone who already existed, so a
    // rep who has been selling for months keeps their route.
    `ALTER TABLE users ADD COLUMN training_required INTEGER NOT NULL DEFAULT 1`,
    `CREATE INDEX IF NOT EXISTS idx_login_attempts_email ON login_attempts(email, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_login_attempts_at ON login_attempts(created_at)`,
    `CREATE TABLE IF NOT EXISTS territories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, rep_id INTEGER NOT NULL, polygon TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#3b82f6', created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS territory_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, rep_id INTEGER NOT NULL, user_id INTEGER NOT NULL, message TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS rep_applications (id INTEGER PRIMARY KEY AUTOINCREMENT, full_name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT NOT NULL, city TEXT NOT NULL, zip TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'NC', has_sales_experience INTEGER NOT NULL DEFAULT 0, sales_experience_details TEXT, preferred_carriers TEXT NOT NULL, referral_source TEXT, headshot_path TEXT, license_path TEXT, status TEXT NOT NULL DEFAULT 'pending', reviewed_by INTEGER, review_notes TEXT, user_id INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    // New SaaS tables
    `CREATE TABLE IF NOT EXISTS location_pings (id INTEGER PRIMARY KEY AUTOINCREMENT, rep_id INTEGER NOT NULL, user_id INTEGER NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL, accuracy REAL, ping_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS clock_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, rep_id INTEGER NOT NULL, user_id INTEGER NOT NULL, clocked_in TEXT NOT NULL, clocked_out TEXT, duration_minutes INTEGER, notes TEXT, date TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS commissions (id INTEGER PRIMARY KEY AUTOINCREMENT, rep_id INTEGER NOT NULL, lead_id INTEGER, knock_id INTEGER, amount REAL NOT NULL, status TEXT NOT NULL DEFAULT 'pending', sale_date TEXT NOT NULL, paid_date TEXT, notes TEXT, approved_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    // Persistent marker: a town deep-Mapbox-grid-seeded into the pool. Its whole
    // job is to make the nightly deep-seed run ONCE per town, ever (the one-time
    // Mapbox cost), independent of pool row counts.
    `CREATE TABLE IF NOT EXISTS deep_seed_log (city_key TEXT PRIMARY KEY, city TEXT NOT NULL, state TEXT NOT NULL, address_count INTEGER NOT NULL DEFAULT 0, seeded_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS commission_rates (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, role TEXT, rep_id INTEGER, rate_per_sale REAL NOT NULL, is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS activity_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, action TEXT NOT NULL, entity_type TEXT, entity_id INTEGER, details TEXT, ip TEXT, at TEXT NOT NULL DEFAULT (datetime('now')))`,
    // Lead scoring columns (safe to run on existing DB)
    `ALTER TABLE leads ADD COLUMN lead_tag TEXT`,
    `ALTER TABLE leads ADD COLUMN lead_score INTEGER DEFAULT 0`,
    // Pre-assignment triage mark set by a manager/team-lead on a lead (usually
    // while it is still in the unassigned pool): "priority" (assign first) or
    // "hold" (don't assign yet). Orthogonal to lead_status and assignment — it
    // rides straight through a later assign. NULL = unmarked.
    `ALTER TABLE leads ADD COLUMN assign_mark TEXT`,
    `ALTER TABLE leads ADD COLUMN source_scan_target_id INTEGER`,
    `ALTER TABLE leads ADD COLUMN fresh_confirmed_at TEXT`,
    `ALTER TABLE leads ADD COLUMN fresh_confidence TEXT`,
    `ALTER TABLE leads ADD COLUMN fresh_sources TEXT`,
    // tenant_id support for multi-tenant tables (safe — duplicate column errors are swallowed)
    `ALTER TABLE team_members ADD COLUMN tenant_id INTEGER`,
    `ALTER TABLE territories ADD COLUMN tenant_id INTEGER`,
    // Coming-Soon lifecycle: recheck → promote or age-out, with archived history.
    `ALTER TABLE commissions ADD COLUMN tenant_id INTEGER`,
    // users/leads got tenant_id from drizzle-kit push in prod; these ALTERs make
    // a migrations-only DB (tests, fresh installs) match.
    `ALTER TABLE users ADD COLUMN tenant_id INTEGER`,
    `ALTER TABLE leads ADD COLUMN tenant_id INTEGER`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_confirmed_scan_target ON leads(tenant_id, source_scan_target_id) WHERE source_scan_target_id IS NOT NULL`,
    // Full drizzle-parity for migrations-only DBs (verified by schema diff):
    // lead-enrichment columns + fiber_checks.billing_status + tenant branding/
    // billing columns all originally came from drizzle-kit push.
    `ALTER TABLE leads ADD COLUMN owner_name TEXT`,
    `ALTER TABLE leads ADD COLUMN owner_phone TEXT`,
    `ALTER TABLE leads ADD COLUMN owner_email TEXT`,
    `ALTER TABLE leads ADD COLUMN income_range TEXT`,
    `ALTER TABLE leads ADD COLUMN home_value TEXT`,
    `ALTER TABLE leads ADD COLUMN years_at_address INTEGER`,
    `ALTER TABLE leads ADD COLUMN is_homeowner INTEGER`,
    `ALTER TABLE leads ADD COLUMN enriched_at TEXT`,
    // Legacy pre-drizzle scan columns upsertLeadByAddress still writes — present
    // in prod from the original schema, absent on migrations-only/fresh DBs.
    `ALTER TABLE leads ADD COLUMN max_download INTEGER`,
    `ALTER TABLE leads ADD COLUMN is_new_deployment INTEGER DEFAULT 0`,
    `ALTER TABLE fiber_checks ADD COLUMN billing_status TEXT`,
    `ALTER TABLE fiber_checks ADD COLUMN tenant_id INTEGER`,
    // dfAddressId watchlist — the moat: recheck these by Kinetic's own key nightly.
    // Address dedup for upsertLeadByAddress must hit the DB every time (cross-process
    // cache can't be trusted) — index it so that lookup stays cheap.
    `CREATE INDEX IF NOT EXISTS idx_leads_address ON leads(address)`,
    // Case/whitespace-insensitive address lookup — powers the green→lead link
    // backfill (find an existing lead for a scan_target by normalized address).
    `CREATE INDEX IF NOT EXISTS idx_leads_addr_ci ON leads(lower(trim(address)), lower(trim(city)))`,
    // Bbox windows on /api/leads/map (viewport mode for 100k+ pins): the
    // lat BETWEEN range scan must not degenerate into a full table scan per
    // moveend. Pure index add — additive, idempotent, no table rebuild.
    `CREATE INDEX IF NOT EXISTS idx_leads_lat_lng ON leads(lat, lng)`,
    // The MAP WINDOW index — tenant equality first (every windowed request is
    // tenant-scoped), then the lat range, then lng + the pin-eligibility
    // columns so the whole window PREDICATE evaluates in-index (only matched
    // rows pay a table lookup, and the density grid — which projects nothing
    // beyond lat/lng — runs as a COVERING scan). Measured on a 180k-lead
    // tenant: a street window (z17) 46ms → 0.3ms, neighborhood (z13) 66ms →
    // 11ms, grid 194ms → 133ms; wide windows are bounded by the 25k cap either
    // way. Without the tenant prefix SQLite chose idx_leads_tenant and walked
    // ALL of the tenant's rows per pan.
    `CREATE INDEX IF NOT EXISTS idx_leads_map_window ON leads(tenant_id, lat, lng, lead_status, lead_tag)`,
    `ALTER TABLE tenants ADD COLUMN owner_phone TEXT`,
    `ALTER TABLE tenants ADD COLUMN brand_color TEXT DEFAULT '#3EA394'`,
    `ALTER TABLE tenants ADD COLUMN brand_logo TEXT`,
    `ALTER TABLE tenants ADD COLUMN revenue_share_pct REAL DEFAULT 0.20`,
    `ALTER TABLE tenants ADD COLUMN monthly_fee REAL DEFAULT 0`,
    `ALTER TABLE tenants ADD COLUMN trial_ends_at TEXT`,
    `ALTER TABLE tenants ADD COLUMN billing_email TEXT`,
    `ALTER TABLE tenants ADD COLUMN stripe_customer_id TEXT`,
    `ALTER TABLE tenants ADD COLUMN mapbox_token TEXT`,
    `ALTER TABLE tenants ADD COLUMN scanner_secret TEXT`,
    `ALTER TABLE tenants ADD COLUMN kfs_auth_basic TEXT`,
    `ALTER TABLE tenants ADD COLUMN allowed_markets TEXT`,
    `ALTER TABLE tenants ADD COLUMN max_reps INTEGER DEFAULT 10`,
    `ALTER TABLE tenants ADD COLUMN enrichment_api_key TEXT`,
    `ALTER TABLE tenants ADD COLUMN notes TEXT`,
    // Structure lock + engine columns (additive; legacy flat rates still work).
    `ALTER TABLE commissions ADD COLUMN structure_id INTEGER`,
    `ALTER TABLE commissions ADD COLUMN structure_version INTEGER`,
    `ALTER TABLE commissions ADD COLUMN calc_type TEXT`,
    `ALTER TABLE commissions ADD COLUMN sale_amount REAL`,
    `ALTER TABLE commissions ADD COLUMN revision INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE commission_rates ADD COLUMN calc_type TEXT NOT NULL DEFAULT 'flat'`,
    `ALTER TABLE commission_rates ADD COLUMN percentage REAL NOT NULL DEFAULT 0`,
    `ALTER TABLE commission_rates ADD COLUMN tiers TEXT`,
    `ALTER TABLE commission_rates ADD COLUMN effective_from TEXT`,
    `ALTER TABLE commission_rates ADD COLUMN effective_to TEXT`,
    `ALTER TABLE commission_rates ADD COLUMN version INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE commission_rates ADD COLUMN updated_by TEXT`,
    // P0-3: commission structures are per-org (legacy NULLs are adopted into
    // the default tenant by bootstrapDefaultTenant, same as every other table).
    `ALTER TABLE commission_rates ADD COLUMN tenant_id INTEGER`,
    // P1-1: outcome-recency columns — the knock CAS compares last_outcome_at
    // so a stale offline knock can never clobber a newer outcome.
    `ALTER TABLE leads ADD COLUMN last_outcome TEXT`,
    `ALTER TABLE leads ADD COLUMN last_outcome_at TEXT`,
    // P1-2: one pending commission per (tenant, lead). Pre-existing duplicate
    // sold-knock rows would break the partial UNIQUE index, so keep the NEWEST
    // pending row per (tenant_id, lead_id) and mark the rest 'superseded'
    // BEFORE the index builds (idempotent: a no-op once deduped).
    `UPDATE commissions SET status = 'superseded'
      WHERE status = 'pending' AND lead_id IS NOT NULL
        AND id NOT IN (
          SELECT MAX(id) FROM commissions
           WHERE status = 'pending' AND lead_id IS NOT NULL
           GROUP BY tenant_id, lead_id
        )`,
    `ALTER TABLE knock_log ADD COLUMN superseded INTEGER NOT NULL DEFAULT 0`,
    // REVIEWER GATE (fin #6): backfill outcome recency for pre-migration leads —
    // without it, a stale offline knock flushed after deploy WINS the CAS over
    // a newer pre-deploy disposition (NULL last_outcome_at).
    `UPDATE leads SET last_outcome_at = (SELECT MIN(MAX(knocked_at), strftime('%Y-%m-%dT%H:%M:%fZ','now')) FROM knock_log WHERE knock_log.lead_id = leads.id) WHERE last_outcome_at IS NULL`,
    `CREATE INDEX IF NOT EXISTS idx_knock_log_superseded ON knock_log(lead_id, superseded)`,
    `ALTER TABLE knock_log ADD COLUMN tenant_id INTEGER`,
    `ALTER TABLE clock_sessions ADD COLUMN tenant_id INTEGER`,
    // Audit stream is now tenant-scoped on read — stamp the actor's tenant at write.
    `ALTER TABLE activity_log ADD COLUMN tenant_id INTEGER`,
    `CREATE INDEX IF NOT EXISTS idx_activity_log_tenant ON activity_log(tenant_id, at)`,
    // Inbound rep applications carry the org they're joining (null = unrouted).
    // Bootstrap adopts existing null rows into the default tenant.
    `ALTER TABLE rep_applications ADD COLUMN tenant_id INTEGER`,
    // Territory requests were tenant-blind: no column, so no wall was possible.
    // Backfilled from the requesting rep's own tenant (below) so existing rows
    // become visible only to the org that actually owns them.
    `ALTER TABLE territory_requests ADD COLUMN tenant_id INTEGER`,
    `CREATE INDEX IF NOT EXISTS idx_territory_requests_tenant ON territory_requests(tenant_id, status)`,
    `ALTER TABLE rep_applications ADD COLUMN invite_id INTEGER`,
    `ALTER TABLE rep_applications ADD COLUMN application_source TEXT NOT NULL DEFAULT 'public_join'`,
    `ALTER TABLE rep_applications ADD COLUMN desired_role TEXT`,
    `ALTER TABLE rep_applications ADD COLUMN login_email_id TEXT`,
    `ALTER TABLE rep_applications ADD COLUMN login_sent_at TEXT`,
    `ALTER TABLE rep_applications ADD COLUMN agreements_issued_at TEXT`,
    `ALTER TABLE rep_applications ADD COLUMN activated_at TEXT`,
    // Nullable: null = form never asked (careers/legacy), distinct from "No".
    `ALTER TABLE rep_applications ADD COLUMN has_reliable_transportation INTEGER`,
    // Ad attribution from the careers site: the one-line channel summary and
    // the full JSON (utm_*, click ids, Meta cookie ids, landing path). Null
    // for every application that predates the capture or arrived untagged.
    `ALTER TABLE rep_applications ADD COLUMN channel TEXT`,
    `ALTER TABLE rep_applications ADD COLUMN attribution TEXT`,
    `CREATE INDEX IF NOT EXISTS idx_rep_applications_tenant_status_source ON rep_applications(tenant_id, status, application_source, created_at DESC)`,
    // HR / compliance checkpoints — parallel post-approval gates (background
    // check, drug screen, badge photo, Gusto). One row per (application, kind);
    // the UNIQUE index makes setHrCheckpoint an idempotent upsert.
    `CREATE TABLE IF NOT EXISTS rep_hr_checkpoints (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER, application_id INTEGER NOT NULL, rep_id INTEGER, kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'not_started', provider TEXT, external_ref TEXT, badge_photo_path TEXT, notes TEXT, updated_by INTEGER, ordered_at TEXT, completed_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_rep_hr_checkpoints_app_kind ON rep_hr_checkpoints(application_id, kind)`,
    `CREATE INDEX IF NOT EXISTS idx_rep_hr_checkpoints_tenant ON rep_hr_checkpoints(tenant_id, application_id)`,
    // Org hierarchy: which team_lead/manager a member reports to (null = top-level)
    `ALTER TABLE team_members ADD COLUMN reports_to_id INTEGER`,
    // Persisted rep hue, allocated at creation (first free REP_PALETTE slot per
    // tenant — see createTeamMember). NULL = legacy row / palette exhausted →
    // repColorOf() falls back to the old repId-hash, so old rows keep their hue.
    `ALTER TABLE team_members ADD COLUMN color TEXT`,
    // Persistent address pool — harvest once, re-scan for fiber-status changes.
    // NOTE: no column-level UNIQUE(address). A global unique-by-address made a
    // real "104 Oak St, Broadway" collide with an existing "104 Oak St, Sanford"
    // — the second city's house was thrown away (route 409, sweep INSERT OR
    // IGNORE), losing a genuine NEW FIBER + N lead. Uniqueness is now
    // (address, city, state) via the functional index below; existing DBs with
    // the old constraint are rebuilt after the migration loop.
    `CREATE TABLE IF NOT EXISTS scan_targets (id INTEGER PRIMARY KEY AUTOINCREMENT, address TEXT NOT NULL, city TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'NC', zip TEXT NOT NULL, lat REAL, lng REAL, tenant_id INTEGER, source TEXT, last_fiber_status TEXT, last_is_new_fiber INTEGER NOT NULL DEFAULT 0, last_billing_status TEXT, df_address_id TEXT, scan_count INTEGER NOT NULL DEFAULT 0, last_scanned_at TEXT, converted_to_lead_id INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    // The UNIQUE-by-(address,city,state) index is created imperatively AFTER the
    // migration loop (migrateScanTargetsAddressUniqueness) — it must dedup the
    // existing case/whitespace-variant rows FIRST, or a UNIQUE index build fails.
    `ALTER TABLE scan_targets ADD COLUMN first_seen_live_at TEXT`,
    `ALTER TABLE scan_targets ADD COLUMN last_availability_status TEXT`,
    `CREATE INDEX IF NOT EXISTS idx_scan_targets_scanned ON scan_targets(last_scanned_at)`,
    // Per-address inconclusive circuit breaker (see shared/scanPolicy.ts). Counts
    // consecutive inconclusive probes with no conclusive answer; once it reaches the
    // give-up threshold the never-scanned row is "exhausted" and stops being re-probed
    // (nightly + manual), killing the recurring proxy-cost leak on addresses Kinetic
    // doesn't recognize. A conclusive answer resets the count to 0.
    `ALTER TABLE scan_targets ADD COLUMN inconclusive_attempts INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE scan_targets ADD COLUMN last_inconclusive_at TEXT`,
    // Partial-ish index for the re-probe selection (never-scanned, not-yet-exhausted).
    `CREATE INDEX IF NOT EXISTS idx_scan_targets_reprobe ON scan_targets(last_scanned_at, inconclusive_attempts)`,
    // Covering partial index for the confirmed-green-unlinked backfill predicate
    // (FRESH_LEAD_BOOT_BACKFILL): tenant + new_fiber + billing N + not yet a lead.
    // Without it that boot job full-scans scan_targets per tenant (unindexed) — a
    // synchronous stall on the grown DB. WHERE clause keeps the index tiny (only
    // unconverted greens).
    `CREATE INDEX IF NOT EXISTS idx_scan_targets_green_unlinked ON scan_targets(tenant_id, last_fiber_status, last_billing_status) WHERE converted_to_lead_id IS NULL`,
    // Cross-instance Kinetic provider admission. No bearer/proxy credentials are
    // stored: only hashed address keys, queue leases, rate timestamps, and a
    // short server-side normalized-result cache.
    `CREATE TABLE IF NOT EXISTS provider_admission_queue (id TEXT PRIMARY KEY,dedupe_key TEXT NOT NULL,source TEXT NOT NULL,priority INTEGER NOT NULL,instance_id TEXT NOT NULL,state TEXT NOT NULL,enqueued_at INTEGER NOT NULL,started_at INTEGER,lease_expires_at INTEGER,completed_at INTEGER,last_error TEXT,updated_at INTEGER NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_provider_admission_order ON provider_admission_queue(state,priority DESC,enqueued_at,id)`,
    `CREATE INDEX IF NOT EXISTS idx_provider_admission_lease ON provider_admission_queue(state,lease_expires_at)`,
    `CREATE TABLE IF NOT EXISTS provider_rate_events (id INTEGER PRIMARY KEY AUTOINCREMENT,work_id TEXT NOT NULL,started_at INTEGER NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_provider_rate_started ON provider_rate_events(started_at)`,
    `CREATE TABLE IF NOT EXISTS provider_address_locks (dedupe_key TEXT PRIMARY KEY,owner_id TEXT NOT NULL,expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS provider_shared_result_cache (dedupe_key TEXT PRIMARY KEY,payload TEXT NOT NULL,expires_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_provider_shared_cache_expiry ON provider_shared_result_cache(expires_at)`,
    `CREATE TABLE IF NOT EXISTS provider_global_control (id INTEGER PRIMARY KEY CHECK(id=1),next_start_at INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL)`,
    `INSERT OR IGNORE INTO provider_global_control (id,updated_at) VALUES (1,0)`,
    // Speed up knock lookups (leaderboard, territory progress, knock history)
    // ── Multi-pass knocking ───────────────────────────────────────────────────
    // An area can be swept more than once. current_pass tracks which sweep is
    // open; knock_log.pass_number attributes each knock to its sweep so a reset
    // re-opens the doors WITHOUT making pass 1's history ambiguous. do_not_knock
    // is a permanent compliance block that no reset clears.
    `ALTER TABLE territories ADD COLUMN current_pass INTEGER NOT NULL DEFAULT 1`,
    // When the area was last handed to its current rep (map label + panel).
    `ALTER TABLE territories ADD COLUMN assigned_at TEXT`,
    `ALTER TABLE knock_log ADD COLUMN pass_number INTEGER`,
    `ALTER TABLE leads ADD COLUMN do_not_knock INTEGER NOT NULL DEFAULT 0`,
    // Every knock that predates the concept belongs to the first sweep.
    `UPDATE knock_log SET pass_number = 1 WHERE pass_number IS NULL`,
    `CREATE INDEX IF NOT EXISTS idx_knock_log_pass ON knock_log(lead_id, pass_number)`,
    `CREATE INDEX IF NOT EXISTS idx_knock_log_lead ON knock_log(lead_id)`,
    `CREATE INDEX IF NOT EXISTS idx_knock_log_rep ON knock_log(rep_id)`,
    `CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(lead_status)`,

    // ── Territory ops: status lifecycle + multi-rep + history (SalesRabbit-grade) ──
    // status: unassigned | active | shared | completed | reclaimed | archived | draft
    `ALTER TABLE territories ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`,
    `ALTER TABLE territories ADD COLUMN assignee_ids TEXT`,        // JSON int[] — multi-rep (repId stays primary)
    `ALTER TABLE territories ADD COLUMN past_assignee_ids TEXT`,   // JSON int[] — reassignment history
    `ALTER TABLE territories ADD COLUMN completion_notes TEXT`,
    `ALTER TABLE territories ADD COLUMN hierarchy_parent_id INTEGER`, // future parent/child
    `ALTER TABLE territories ADD COLUMN updated_at TEXT`,
    `ALTER TABLE territories ADD COLUMN completed_at TEXT`,
    `ALTER TABLE territories ADD COLUMN reclaimed_at TEXT`,
    `ALTER TABLE territories ADD COLUMN archived_at TEXT`,
    // Lead assignment provenance — lets reclaim distinguish direct vs area-sync leads
    `ALTER TABLE leads ADD COLUMN assignment_source TEXT`,          // manual|lasso|territory-sync|direct|auto
    `ALTER TABLE leads ADD COLUMN assigned_territory_id INTEGER`,
    `ALTER TABLE leads ADD COLUMN assigned_at TEXT`,
    `ALTER TABLE leads ADD COLUMN unassigned_at TEXT`,
    // Immutable history — every territory lifecycle event is preserved forever
    `CREATE TABLE IF NOT EXISTS territory_events (id INTEGER PRIMARY KEY AUTOINCREMENT, territory_id INTEGER NOT NULL, actor_user_id INTEGER, type TEXT NOT NULL, payload TEXT, at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE INDEX IF NOT EXISTS idx_territory_events_terr ON territory_events(territory_id)`,
    `CREATE TABLE IF NOT EXISTS lead_events (id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id INTEGER NOT NULL, type TEXT NOT NULL, actor TEXT, detail TEXT, at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_lead_events_lead ON lead_events(lead_id)`,
    // Idempotency for status events (Central Mark): a UNIQUE (lead_id, idem_key)
    // collapses a double-tap / offline replay into one row — no duplicate or
    // contradictory history entries.
    `ALTER TABLE lead_events ADD COLUMN idem_key TEXT`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_lead_events_idem ON lead_events(lead_id, idem_key) WHERE idem_key IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_leads_assigned_territory ON leads(assigned_territory_id)`,
    // ── Skip-traced contacts ────────────────────────────────────────────────
    // What a Tracerfy trace + DNC scrub found for a door. One row per number.
    //
    // `scrubbed_at_ms` is the ONLY freshness record, and it is deliberately a
    // timestamp rather than a dnc boolean: shared/tracerfy.ts derives the
    // verdict from it against SCRUB_TTL_DAYS on every read, so a number whose
    // scrub ages out flips back to blocked with nothing written. Storing a
    // boolean would freeze a January answer into a permanent clearance.
    // NULL means never scrubbed, which reads as blocked, not as clear.
    `CREATE TABLE IF NOT EXISTS lead_traced_phones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER,
      lead_id INTEGER NOT NULL,
      number TEXT NOT NULL,
      line_type TEXT,
      confidence REAL NOT NULL DEFAULT 0,
      dnc_flags TEXT,
      scrubbed_at_ms INTEGER,
      dnc_source TEXT,
      traced_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_traced_phone_unique ON lead_traced_phones(lead_id, number)`,
    `CREATE INDEX IF NOT EXISTS idx_traced_phone_lead ON lead_traced_phones(tenant_id, lead_id)`,
    // Owner name from the trace. Kept separate from leads.owner_name, which the
    // GIS/parcel enrichment owns — overwriting that would let a phone vendor
    // silently rewrite property data.
    `ALTER TABLE leads ADD COLUMN traced_owner_name TEXT`,
    `ALTER TABLE leads ADD COLUMN traced_at TEXT`,
    // ── Area skip-trace runs ────────────────────────────────────────────────
    // The partial unique index is the concurrency control: a second run on the
    // same area fails at the DB rather than in a read-then-write race that
    // would double-spend. heartbeat_at lets the reaper tell a slow run from an
    // abandoned one — the driver is an in-process promise, so a restart
    // mid-run would otherwise wedge the area forever.
    `CREATE TABLE IF NOT EXISTS area_skip_trace_runs (
      id TEXT PRIMARY KEY,
      tenant_id INTEGER,
      territory_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      requested_by INTEGER,
      eligible_leads INTEGER NOT NULL DEFAULT 0,
      processed_leads INTEGER NOT NULL DEFAULT 0,
      failed_leads INTEGER NOT NULL DEFAULT 0,
      total_phones INTEGER NOT NULL DEFAULT 0,
      dialable_phones INTEGER NOT NULL DEFAULT 0,
      error_code TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      heartbeat_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_area_skip_trace_one_active
      ON area_skip_trace_runs(tenant_id, territory_id) WHERE status IN ('queued','running')`,
    `CREATE INDEX IF NOT EXISTS idx_area_skip_trace_recent
      ON area_skip_trace_runs(tenant_id, territory_id, started_at DESC)`,
    // Offline knock queue idempotency — a retried flush with the same client_id
    // must return the existing row, never double-log. Partial unique index so all
    // legacy NULL rows stay untouched (SQLite treats NULLs as distinct anyway).
    `ALTER TABLE knock_log ADD COLUMN client_id TEXT`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_knock_log_client_id ON knock_log(client_id) WHERE client_id IS NOT NULL`,

    // ── Location-verified lead activity (anti-fabrication audit trail) ──────────
    // Captured ONCE at createKnock and never rewritten by a rep-facing path — the
    // rep's position at tap time, GPS accuracy, both timestamps, the server-side
    // Haversine distance, and the verification verdict. distance_m/verification_*
    // are SERVER-COMPUTED; the client value is never trusted.
    `ALTER TABLE knock_log ADD COLUMN rep_lat REAL`,
    `ALTER TABLE knock_log ADD COLUMN rep_lng REAL`,
    `ALTER TABLE knock_log ADD COLUMN gps_accuracy REAL`,
    `ALTER TABLE knock_log ADD COLUMN device_ts TEXT`,
    `ALTER TABLE knock_log ADD COLUMN server_ts TEXT`,
    `ALTER TABLE knock_log ADD COLUMN distance_m REAL`,
    `ALTER TABLE knock_log ADD COLUMN verification_status TEXT`, // verified|needs_review|invalid|null(legacy)
    `ALTER TABLE knock_log ADD COLUMN review_reason TEXT`,       // ';'-joined reason keys
    `ALTER TABLE knock_log ADD COLUMN mock_location INTEGER`,    // device-reported mock flag (0/1)
    `ALTER TABLE knock_log ADD COLUMN net_state TEXT`,           // online|offline at tap
    `ALTER TABLE knock_log ADD COLUMN app_version TEXT`,
    `ALTER TABLE knock_log ADD COLUMN device_id TEXT`,           // opaque per-device identifier
    `CREATE INDEX IF NOT EXISTS idx_knock_log_verification ON knock_log(verification_status)`,

    // Key/value app settings — admin-configurable knobs (geo.max_distance_m,
    // geo.max_accuracy_m). Tenant-scoped; tenant_id NULL = platform default.
    `CREATE TABLE IF NOT EXISTS app_settings (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER, key TEXT NOT NULL, value TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')), updated_by INTEGER)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_app_settings_key ON app_settings(tenant_id, key)`,

    // Immutable override audit — every admin change to a verification verdict.
    // The original knock capture is NEVER mutated except its verdict fields, and
    // only through this logged path (reason + who + old/new required).
    `CREATE TABLE IF NOT EXISTS activity_overrides (id INTEGER PRIMARY KEY AUTOINCREMENT, knock_id INTEGER NOT NULL, actor_user_id INTEGER, actor_name TEXT, old_status TEXT, new_status TEXT NOT NULL, reason TEXT NOT NULL, at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE INDEX IF NOT EXISTS idx_activity_overrides_knock ON activity_overrides(knock_id)`,

    // ── Hot-path indexes (additive; SQLite ignores IF-NOT-EXISTS dupes) ──────────
    // Auth, rep-scoping, tenant-scoping, audit reads, clock/GPS/commission lookups.
    `CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_leads_assigned_rep ON leads(assigned_rep_id)`,
    `CREATE INDEX IF NOT EXISTS idx_leads_tenant ON leads(tenant_id)`,
    `CREATE INDEX IF NOT EXISTS idx_activity_log_at ON activity_log(at)`,
    `CREATE INDEX IF NOT EXISTS idx_activity_log_user ON activity_log(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_clock_sessions_rep ON clock_sessions(rep_id)`,
    `CREATE INDEX IF NOT EXISTS idx_location_pings_rep ON location_pings(rep_id, ping_at)`,
    `CREATE INDEX IF NOT EXISTS idx_commissions_rep ON commissions(rep_id)`,
    `CREATE INDEX IF NOT EXISTS idx_knock_log_knocked_at ON knock_log(knocked_at)`,
    // Partial expression index for the impossible-travel reference lookup on the
    // hot knock write (getLatestLocatedKnockByRep): seek the rep's newest
    // LOCATED knock by effective timestamp without touching unlocated rows.
    // Expression matches the query's COALESCE(device_ts, knocked_at) exactly.
    `CREATE INDEX IF NOT EXISTS idx_knock_log_rep_located ON knock_log(rep_id, COALESCE(device_ts, knocked_at) DESC) WHERE rep_lat IS NOT NULL AND rep_lng IS NOT NULL`,

    // ══ WEEKLY COMMISSION (Phase 2) — additive; isolated from the old commission system ══
    // Org workweek config on tenants (safe backfill via NOT NULL DEFAULT).
    `ALTER TABLE tenants ADD COLUMN commission_timezone TEXT NOT NULL DEFAULT 'America/New_York'`,
    `ALTER TABLE tenants ADD COLUMN commission_week_starts_on INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE tenants ADD COLUMN commission_week_start_local_time TEXT NOT NULL DEFAULT '00:00'`,
    `ALTER TABLE tenants ADD COLUMN commission_qualification_basis TEXT NOT NULL DEFAULT 'QUALIFIED_AT'`,
    `ALTER TABLE tenants ADD COLUMN commission_finalization_delay_hours INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE tenants ADD COLUMN commission_correction_window_days INTEGER NOT NULL DEFAULT 30`,
    `ALTER TABLE tenants ADD COLUMN commission_auto_finalize_enabled INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE tenants ADD COLUMN commission_reserve_percent INTEGER NOT NULL DEFAULT 0`,
    // What the COMPANY books for one qualified sale — the "house amount" on a
    // commission statement. 0 means the org has not set one, and the statement
    // then HIDES the column rather than printing $0.00 beside every door (which
    // reads as "this sale was worth nothing" instead of "not configured").
    `ALTER TABLE tenants ADD COLUMN commission_house_amount_cents INTEGER NOT NULL DEFAULT 0`,
    // SELF-SERVE OPEN FIELD — off by default, deliberately.
    // A door with no rep and no territory is unowned ground. Enabling this lets
    // any rep in the tenant see and work it. For an org that imported a whole
    // market's FCC footprint that means every rep opens the app to tens of
    // thousands of doors nobody handed them, which is how work stops being
    // distributed by assignment. Left available because the opposite org exists
    // — a small team told to go work the town — but it is an explicit choice.
    `ALTER TABLE tenants ADD COLUMN open_field_enabled INTEGER NOT NULL DEFAULT 0`,

    `CREATE TABLE IF NOT EXISTS commission_plans (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL, name TEXT NOT NULL, description TEXT, currency TEXT NOT NULL DEFAULT 'USD', type TEXT NOT NULL DEFAULT 'TIERED', tier_mode TEXT NOT NULL DEFAULT 'RETROACTIVE_WEEKLY', status TEXT NOT NULL DEFAULT 'DRAFT', created_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE INDEX IF NOT EXISTS idx_commission_plans_tenant ON commission_plans(tenant_id, status)`,

    `CREATE TABLE IF NOT EXISTS commission_plan_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL, commission_plan_id INTEGER NOT NULL, version_number INTEGER NOT NULL, flat_rate_cents INTEGER, qualification_basis TEXT NOT NULL DEFAULT 'QUALIFIED_AT', effective_from TEXT NOT NULL, effective_to TEXT, rules_snapshot TEXT, change_summary TEXT, created_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_cpv_plan_version ON commission_plan_versions(commission_plan_id, version_number)`,

    `CREATE TABLE IF NOT EXISTS commission_tiers (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL, commission_plan_version_id INTEGER NOT NULL, position INTEGER NOT NULL, label TEXT NOT NULL, minimum_sales INTEGER NOT NULL, maximum_sales INTEGER, rate_cents INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_tiers_version_min ON commission_tiers(commission_plan_version_id, minimum_sales)`,

    `CREATE TABLE IF NOT EXISTS rep_commission_assignments (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL, rep_id INTEGER NOT NULL, commission_plan_version_id INTEGER NOT NULL, effective_from TEXT NOT NULL, effective_to TEXT, assigned_by INTEGER, accepted_at TEXT, agreement_snapshot TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE INDEX IF NOT EXISTS idx_rca_tenant_rep_from ON rep_commission_assignments(tenant_id, rep_id, effective_from)`,

    `CREATE TABLE IF NOT EXISTS commission_sales (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL, rep_id INTEGER NOT NULL, external_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING', sold_at TEXT NOT NULL, qualified_at TEXT, installed_at TEXT, activated_at TEXT, reversed_at TEXT, disqualification_reason TEXT, lead_id INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_tenant_external ON commission_sales(tenant_id, external_id)`,
    `CREATE INDEX IF NOT EXISTS idx_sales_agg ON commission_sales(tenant_id, rep_id, status, qualified_at)`,
    // The FCC purge predicate (fccPurgeWhere) asks "does this lead have a
    // commission sale?" once per candidate row. Without this index that clause
    // is the only one of its four siblings that resolves as a full SCAN of
    // commission_sales, per candidate — measured at 26.4s of BLOCKED event loop
    // on 120k fcc leads x 10k sales, versus 0.07s with it (~375x). better-sqlite3
    // is synchronous, so that is the whole floor stalled while one admin opens
    // the purge dialog, which fires the count automatically on open.
    `CREATE INDEX IF NOT EXISTS idx_sales_lead ON commission_sales(lead_id)`,
    // Per-sale override of the org's house amount, for shops whose doors are not
    // all worth the same (different speeds/bundles). NULL = fall back to the org
    // default; the statement never invents a number for a door nobody priced.
    `ALTER TABLE commission_sales ADD COLUMN house_amount_cents INTEGER`,
    // IMMUTABLE qualification-basis snapshot — which timestamp places this sale
    // in a pay week. Stamped once from the plan version effective when the sale
    // first becomes commission-relevant, then frozen, so a later tenant-config
    // or plan change can never re-week a sale that already exists. NULL means a
    // row written before this column, which resolves through the documented
    // fallback (the plan version's basis) and therefore behaves exactly as it
    // did before. See the precedence note in server/commissionService.ts.
    `ALTER TABLE commission_sales ADD COLUMN qualification_basis TEXT`,

    `CREATE TABLE IF NOT EXISTS commission_statements (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL, rep_id INTEGER NOT NULL, week_start_utc TEXT NOT NULL, next_week_start_utc TEXT NOT NULL, timezone TEXT NOT NULL, local_week_label TEXT NOT NULL, qualification_basis TEXT NOT NULL, commission_plan_id INTEGER, commission_plan_version_id INTEGER, plan_version_number INTEGER, plan_snapshot TEXT, qualified_sale_count INTEGER NOT NULL DEFAULT 0, tier_id INTEGER, tier_label TEXT, rate_cents INTEGER NOT NULL DEFAULT 0, gross_commission_cents INTEGER NOT NULL DEFAULT 0, adjustment_cents INTEGER NOT NULL DEFAULT 0, final_commission_cents INTEGER NOT NULL DEFAULT 0, calculation_version INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'OPEN', calculated_at TEXT NOT NULL DEFAULT (datetime('now')), finalized_at TEXT, finalized_by INTEGER, paid_at TEXT, paid_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_statements_tenant_rep_week ON commission_statements(tenant_id, rep_id, week_start_utc)`,

    `CREATE TABLE IF NOT EXISTS commission_adjustments (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL, statement_id INTEGER NOT NULL, rep_id INTEGER NOT NULL, amount_cents INTEGER NOT NULL, type TEXT NOT NULL DEFAULT 'MANUAL', reason TEXT NOT NULL, related_sale_id INTEGER, status TEXT NOT NULL DEFAULT 'PENDING', created_by INTEGER, approved_by INTEGER, approved_at TEXT, rejected_by INTEGER, rejected_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE INDEX IF NOT EXISTS idx_adjustments_tenant_stmt_status ON commission_adjustments(tenant_id, statement_id, status)`,
    // Frozen snapshot of the exact sales that composed a FINALIZED/PAID statement,
    // so the drill-down always explains the locked number even if a door is later
    // reversed (which then surfaces as a REVERSED_AFTER_FINALIZE exception).
    `ALTER TABLE commission_statements ADD COLUMN contributing_sales TEXT`,

    // ── Scale indexes (50k+ leads/tenant) ──────────────────────────────────
    // Composite (tenant_id, assigned_rep_id): serves the scoped team_lead/rep
    // map + list queries in one index walk instead of tenant-scan-then-filter.
    `CREATE INDEX IF NOT EXISTS idx_leads_tenant_rep ON leads(tenant_id, assigned_rep_id)`,
    // (tenant_id, created_at DESC): the /api/leads list ORDER BY comes straight
    // off the index — kills the "USE TEMP B-TREE FOR ORDER BY" external sort.
    `CREATE INDEX IF NOT EXISTS idx_leads_tenant_created ON leads(tenant_id, created_at DESC)`,
    // (tenant_id, lead_status): status-filtered list pages without a tenant scan.
    `CREATE INDEX IF NOT EXISTS idx_leads_tenant_status ON leads(tenant_id, lead_status)`,
    // (tenant_id, state, city): getLeadFacets' DISTINCT city,state ORDER BY
    // state,city becomes an in-order covering index walk — no temp b-tree for
    // the DISTINCT and none for the sort.
    `CREATE INDEX IF NOT EXISTS idx_leads_tenant_state_city ON leads(tenant_id, state, city)`,
    // (lead_id, knocked_at): serves per-lead knock history reads.
    `CREATE INDEX IF NOT EXISTS idx_knock_log_lead_time ON knock_log(lead_id, knocked_at)`,
    // DESC-matched to the visit-summary window's ORDER BY (knocked_at DESC,
    // id DESC) — the ASC index above can't satisfy the mixed-direction sort
    // (EXPLAIN showed USE TEMP B-TREE); this one lets each partition stream
    // off the index in order.
    `CREATE INDEX IF NOT EXISTS idx_knock_log_lead_time_desc ON knock_log(lead_id, knocked_at DESC, id DESC)`,
    // Follow-ups (getOpenCallbacks): a partial index over just the scheduled-callback
    // rows so the outer query SEEKS candidates instead of scanning all of knock_log.
    `CREATE INDEX IF NOT EXISTS idx_knock_log_open_callback ON knock_log(lead_id) WHERE outcome = 'callback' AND callback_date IS NOT NULL`,
    // Widened covering variant: getOpenCallbacks' arm-1 driver reads knocked_at,
    // rep_id and the schedule columns off every scheduled-callback row, so the
    // scan of the partial index never touches the table for non-matching rows.
    `CREATE INDEX IF NOT EXISTS idx_knock_log_open_callback2 ON knock_log(lead_id, knocked_at, rep_id, callback_date, callback_time) WHERE outcome = 'callback' AND callback_date IS NOT NULL`,
    // Field photo evidence attached to a door (see shared/schema.ts leadPhotos).
    `CREATE TABLE IF NOT EXISTS lead_photos (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER, lead_id INTEGER NOT NULL, user_id INTEGER, rep_id INTEGER, path TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE INDEX IF NOT EXISTS idx_lead_photos_lead ON lead_photos(lead_id)`,
    // Serves MAX(updated_at) per tenant for the map data-version (cross-process
    // ETag) without scanning the tenant's rows.
    `CREATE INDEX IF NOT EXISTS idx_leads_tenant_updated ON leads(tenant_id, updated_at)`,
    // (tenant_id, assign_mark): the pre-assignment triage board / "marked leads"
    // filter seeks straight to a tenant's marked pool instead of scanning.
    `CREATE INDEX IF NOT EXISTS idx_leads_tenant_mark ON leads(tenant_id, assign_mark)`,
    // Tenant-scoped hot reads that lacked a covering index (filtered scans today,
    // linear in tenant count as the org multiplies). All additive + idempotent.
    `CREATE INDEX IF NOT EXISTS idx_team_members_tenant_name ON team_members(tenant_id, name)`,
    `CREATE INDEX IF NOT EXISTS idx_territories_tenant ON territories(tenant_id)`,
    `CREATE INDEX IF NOT EXISTS idx_knock_log_tenant_time ON knock_log(tenant_id, knocked_at DESC)`,
    // (tenant_id, lead_id): tenant-walled per-lead knock probes (territory
    // progress, dependent-row checks) without walking the tenant's whole
    // knock history in time order.
    `CREATE INDEX IF NOT EXISTS idx_knock_log_tenant_lead ON knock_log(tenant_id, lead_id)`,

    // ── SCAN INTELLIGENCE — persistent, resumable, budgeted verification runs ──
    // A scan is no longer an in-memory job that dies on restart. Each run is a
    // durable record of a budgeted proxy spend against the address pool, so an
    // operator can leave and return without losing progress, and the system
    // remembers what a market cost and what it yielded.
    `CREATE TABLE IF NOT EXISTS scan_runs (
       id TEXT PRIMARY KEY,
       tenant_id INTEGER NOT NULL,
       kind TEXT NOT NULL DEFAULT 'market',        -- market | area | rescan
       label TEXT NOT NULL,
       city TEXT, state TEXT DEFAULT 'NC',
       bbox TEXT,                                  -- JSON {minLat,maxLat,minLng,maxLng} for area runs
       budget INTEGER NOT NULL,                    -- addresses authorized to verify (= proxy spend cap)
       verified INTEGER NOT NULL DEFAULT 0,        -- Kinetic checks actually completed
       new_fiber INTEGER NOT NULL DEFAULT 0,       -- verified NEW FIBER + billing N hits
       newly_live INTEGER NOT NULL DEFAULT 0,      -- provable unavailable->live flips
       failed INTEGER NOT NULL DEFAULT 0,          -- timeouts/errors (NOT negatives)
       status TEXT NOT NULL DEFAULT 'running',     -- running | paused | done | error | cancelled
       error TEXT,
       est_bytes INTEGER NOT NULL DEFAULT 0,       -- proxy bytes billed (cost evidence)
       created_by INTEGER,
       started_at TEXT NOT NULL DEFAULT (datetime('now')),
       heartbeat_at TEXT,
       completed_at TEXT
     )`,
    `CREATE INDEX IF NOT EXISTS idx_scan_runs_tenant ON scan_runs(tenant_id, started_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_scan_runs_status ON scan_runs(status)`,
    // The exact target ids a run intends to verify, in priority order, with a
    // per-target lifecycle. This is what makes a run RESUMABLE: on restart we
    // re-dispatch the pending rows. queued -> verified | failed | skipped.
    `CREATE TABLE IF NOT EXISTS scan_run_targets (
       run_id TEXT NOT NULL,
       target_id INTEGER NOT NULL,
       seq INTEGER NOT NULL,                       -- priority order (0 = highest EV)
       state TEXT NOT NULL DEFAULT 'queued',       -- queued | verified | failed | skipped
       result TEXT,                                -- 'new_fiber' | 'other' | 'no_service' | 'failed'
       PRIMARY KEY (run_id, target_id)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_srt_run_state ON scan_run_targets(run_id, state, seq)`,
    // target-first index: powers cross-run dedup (is this address already pending in
    // another run?) and the claim-time recency-skip, which are keyed by target_id.
    `CREATE INDEX IF NOT EXISTS idx_srt_target_state ON scan_run_targets(target_id, state)`,
    // Partial index over ONLY pending rows so the global-backlog count (backpressure
    // gate) seeks a tiny index instead of full-scanning the never-pruned table.
    `CREATE INDEX IF NOT EXISTS idx_srt_pending ON scan_run_targets(state) WHERE state IN ('queued','inflight')`,
    // scan_targets learns from the field: an EV signal blended into priority so
    // markets/clusters that converted well get re-verified sooner. Nullable —
    // absence means "no field signal yet", never zero.
    `ALTER TABLE scan_targets ADD COLUMN opportunity_score REAL`,
    // Per-market memory of deployed outcomes (the learning loop). One row per
    // (tenant, city) accumulating what fieldwork taught us — feeds priority.
    `CREATE TABLE IF NOT EXISTS market_outcomes (
       tenant_id INTEGER NOT NULL,
       city TEXT NOT NULL,
       state TEXT NOT NULL DEFAULT 'NC',
       territories_worked INTEGER NOT NULL DEFAULT 0,
       doors INTEGER NOT NULL DEFAULT 0,
       knocks INTEGER NOT NULL DEFAULT 0,
       contacts INTEGER NOT NULL DEFAULT 0,
       sales INTEGER NOT NULL DEFAULT 0,
       last_deployed_at TEXT,
       updated_at TEXT NOT NULL DEFAULT (datetime('now')),
       PRIMARY KEY (tenant_id, city, state)
     )`,
    // Territory archive: a completed/reclaimed territory keeps its shape +
    // outcome instead of being hard-deleted (the old DELETE orphaned 2,855
    // leads and erased every lesson). Deploy briefing captured at assign time.
    `ALTER TABLE territories ADD COLUMN archived_at TEXT`,
    `ALTER TABLE territories ADD COLUMN outcome_snapshot TEXT`,
    `ALTER TABLE territories ADD COLUMN briefing TEXT`,
    `ALTER TABLE territories ADD COLUMN source_run_id TEXT`,
    // One-time retroactive cleanup of the OLD hard-delete orphan bug: leads whose
    // assigned_territory_id points at a territory that no longer exists. Deleting
    // a territory now detaches its leads, so going forward there are none; this
    // heals the ~2,800 rows left dangling before that fix. Idempotent (0 rows
    // once healed), keeps each lead's rep assignment — only clears the dead ref.
    `UPDATE leads SET assigned_territory_id = NULL WHERE assigned_territory_id IS NOT NULL AND assigned_territory_id NOT IN (SELECT id FROM territories)`,

    // ═══ MARKET BIRTH RADAR — transition-truth control plane ════════════════════
    // A monitoring control plane SEPARATE from the leads table: authorized
    // provider targets, an append-only observation ledger, per-target current
    // state (compare-and-set), transition episodes (OLD→NEW→OLD→NEW = 2), and a
    // transactional notification outbox for exactly-once alerts.

    // Authorized provider feeds — the ONLY thing we may monitor. Every target
    // must trace to one of these, with provenance + scope + expiry + budgets.
    `CREATE TABLE IF NOT EXISTS authorized_sources (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       tenant_id INTEGER NOT NULL,
       provider TEXT NOT NULL DEFAULT 'kinetic',
       source_type TEXT NOT NULL,          -- kfs_integration | licensed_feed | customer_import | partner
       provenance TEXT NOT NULL,           -- human/audit description of how we got authorization
       allowed_markets TEXT,               -- JSON - city/zip scope, null = any within tenant
       allowed_identifier_scope TEXT,      -- JSON - permitted provider id ranges/sets
       max_qps REAL NOT NULL DEFAULT 1,
       max_concurrency INTEGER NOT NULL DEFAULT 8,
       daily_budget INTEGER,
       monthly_budget INTEGER,
       authorization_starts_at TEXT,
       authorization_expires_at TEXT,
       active INTEGER NOT NULL DEFAULT 1,
       created_by INTEGER,
       created_at TEXT NOT NULL DEFAULT (datetime('now')),
       updated_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
    `CREATE INDEX IF NOT EXISTS idx_auth_sources_tenant ON authorized_sources(tenant_id, active)`,

    // The monitored authorized targets — the scheduler's work list.
    `CREATE TABLE IF NOT EXISTS monitor_targets (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       tenant_id INTEGER NOT NULL,
       authorized_source_id INTEGER NOT NULL,
       provider TEXT NOT NULL DEFAULT 'kinetic',
       provider_target_key TEXT NOT NULL,   -- e.g. dfAddressId (authorized)
       normalized_address TEXT,
       city TEXT, state TEXT, zip TEXT,
       lat REAL, lng REAL,
       coordinate_source TEXT,              -- provider | first_party | licensed_open | none
       coordinate_accuracy TEXT,
       active INTEGER NOT NULL DEFAULT 1,
       priority_class TEXT NOT NULL DEFAULT 'warm',  -- hot | warm | cold | retry | exploration
       priority_score REAL NOT NULL DEFAULT 0,
       monitoring_policy TEXT,              -- JSON - cadence overrides
       next_check_at TEXT,                  -- the scheduler orders by this
       last_attempt_at TEXT,
       last_successful_observation_at TEXT,
       lease_owner TEXT,
       lease_expires_at TEXT,
       created_at TEXT NOT NULL DEFAULT (datetime('now')),
       updated_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
    // Uniqueness is TENANT-SCOPED: two tenants legitimately monitor the same
    // provider address, and a global unique index would both block that and leak
    // a cross-tenant existence oracle. (Drop the earlier global index if present.)
    `DROP INDEX IF EXISTS idx_monitor_provider_key`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_monitor_provider_key ON monitor_targets(tenant_id, provider, provider_target_key)`,
    // Due-target selection: active targets ordered by next_check_at → O(log N + k).
    `CREATE INDEX IF NOT EXISTS idx_monitor_due ON monitor_targets(active, next_check_at)`,
    `CREATE INDEX IF NOT EXISTS idx_monitor_tenant ON monitor_targets(tenant_id, active)`,

    // Append-only ledger of EVERY attempt (success or failure). Idempotent by
    // attempt_key so a retry/replay can never double-record.
    `CREATE TABLE IF NOT EXISTS target_observations (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       target_id INTEGER NOT NULL,
       tenant_id INTEGER NOT NULL,
       attempt_key TEXT NOT NULL UNIQUE,    -- idempotency
       provider_observed_at TEXT,           -- provider's own 'as of' time
       ingested_at TEXT NOT NULL DEFAULT (datetime('now')),
       raw_segment TEXT,
       normalized_segment TEXT,             -- CanonicalState
       conclusive INTEGER NOT NULL DEFAULT 0,
       outcome TEXT NOT NULL,               -- TransitionAction outcome
       result_category TEXT,                -- ok | timeout | rate_limited | auth | challenge | server | malformed | heuristic
       latency_ms INTEGER,
       schema_version INTEGER NOT NULL DEFAULT 1,
       evidence_hash TEXT,                  -- sha256 of the raw evidence (tamper-evidence, no raw dump)
       response_reference TEXT,             -- pointer to fiber_checks row / evidence store
       schema_drift INTEGER NOT NULL DEFAULT 0,
       is_fixture INTEGER NOT NULL DEFAULT 0, -- labelled fixture evidence, never mixes with live
       created_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
    `CREATE INDEX IF NOT EXISTS idx_target_obs_target ON target_observations(target_id, ingested_at DESC)`,

    // One current-state row per target — compare-and-set via state_version so a
    // late/duplicate observation cannot overwrite newer truth.
    `CREATE TABLE IF NOT EXISTS target_state (
       target_id INTEGER PRIMARY KEY,
       tenant_id INTEGER NOT NULL,
       canonical_state TEXT NOT NULL DEFAULT 'UNKNOWN',
       discovery_state TEXT NOT NULL DEFAULT 'NON_NEW',
       state_version INTEGER NOT NULL DEFAULT 0,
       baseline_observed_at TEXT,
       last_non_new_observed_at TEXT,
       first_new_observed_at TEXT,
       verified_at TEXT,
       last_successful_observation_id INTEGER,
       last_conclusive_at TEXT,
       stale_after TEXT,
       is_fixture INTEGER NOT NULL DEFAULT 0, -- this target's evidence class (fixture vs live)
       updated_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,

    // Transition episodes — one per proven non-New→New flip; OLD→NEW→OLD→NEW = 2.
    `CREATE TABLE IF NOT EXISTS transition_episodes (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       tenant_id INTEGER NOT NULL,
       target_id INTEGER NOT NULL,
       episode_sequence INTEGER NOT NULL,
       previous_state TEXT,
       candidate_observation_id INTEGER,
       candidate_at TEXT,
       verification_rule TEXT,              -- JSON {n,m}
       confirmation_count INTEGER NOT NULL DEFAULT 1,
       verified_observation_id INTEGER,
       verified_at TEXT,
       regressed_at TEXT,
       status TEXT NOT NULL DEFAULT 'candidate', -- candidate | verified | regressed
       detection_from TEXT,                 -- interval-censored window start (last non-New)
       detection_to TEXT,                   -- window end (first New)
       evidence_summary TEXT,
       created_at TEXT NOT NULL DEFAULT (datetime('now')),
       updated_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_episode_target_seq ON transition_episodes(target_id, episode_sequence)`,
    `CREATE INDEX IF NOT EXISTS idx_episode_tenant_status ON transition_episodes(tenant_id, status, candidate_at DESC)`,

    // Transactional outbox — a state change and its alert commit together, so a
    // crash after the state write still delivers the alert exactly once.
    `CREATE TABLE IF NOT EXISTS notification_outbox (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       tenant_id INTEGER NOT NULL,
       dedupe_key TEXT NOT NULL UNIQUE,     -- exactly-once
       kind TEXT NOT NULL,                  -- primary_candidate_new | primary_reconfirmed_new | fresh_fiber
       target_id INTEGER,
       episode_id INTEGER,
       payload TEXT,                        -- JSON
       status TEXT NOT NULL DEFAULT 'pending', -- pending | sent | failed
       attempts INTEGER NOT NULL DEFAULT 0,
       created_at TEXT NOT NULL DEFAULT (datetime('now')),
       sent_at TEXT
     )`,
    `CREATE INDEX IF NOT EXISTS idx_outbox_pending ON notification_outbox(status, created_at)`,
    // Additive: fixture/live evidence isolation columns for DBs created before it.
    `ALTER TABLE target_observations ADD COLUMN is_fixture INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE target_state ADD COLUMN is_fixture INTEGER NOT NULL DEFAULT 0`,

    // ═══ BILLING — SaaS lead-credit "banking" (see shared/billing.ts) ════════════
    // Provider-agnostic: the payment provider is an adapter that only ever calls
    // setBillingState()/grantCredits(). Nothing here talks to Stripe. This is the
    // durable side of the pure engine — one billing row per tenant + an append-only
    // credit ledger. DARK by default: a tenant with NO billing row is never metered
    // or gated, so the live single-tenant portal is untouched until billing is set up.
    `CREATE TABLE IF NOT EXISTS tenant_billing (
       tenant_id INTEGER PRIMARY KEY,
       plan_key TEXT NOT NULL DEFAULT 'starter',      -- starter|growth|professional|enterprise
       state TEXT NOT NULL DEFAULT 'trial',           -- trial|active|past_due|suspended|canceled
       cycle_start TEXT,
       cycle_end TEXT,
       credits_included INTEGER NOT NULL DEFAULT 0,   -- this cycle's allowance
       credits_used INTEGER NOT NULL DEFAULT 0,       -- consumed this cycle
       credits_rollover INTEGER NOT NULL DEFAULT 0,   -- carried from last cycle
       credits_purchased INTEGER NOT NULL DEFAULT 0,  -- extra bought this cycle
       overage_used INTEGER NOT NULL DEFAULT 0,       -- delivered beyond allowance (billed later)
       overage_mode TEXT NOT NULL DEFAULT 'stop',     -- stop|allow_overage|auto_purchase|require_approval
       unlimited INTEGER NOT NULL DEFAULT 0,          -- enterprise custom (no credit cap)
       seats_paid INTEGER NOT NULL DEFAULT 0,
       trial_ends_at TEXT,
       grace_ends_at TEXT,                            -- past_due dunning deadline → suspend
       provider TEXT,                                 -- stripe|manual|null (adapter seam)
       provider_customer_id TEXT,
       provider_subscription_id TEXT,
       created_at TEXT NOT NULL DEFAULT (datetime('now')),
       updated_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
    // Ordering guard — ISO of the last-applied provider event.created, so a stale/
    // out-of-order webhook (Stripe doesn't guarantee delivery order) can't overwrite
    // newer state (e.g. a delayed payment_failed after the invoice was paid).
    `ALTER TABLE tenant_billing ADD COLUMN last_event_at TEXT`,
    // Append-only credit ledger — every grant (+), consume (-1), reset, purchase.
    // dedupe_key (consume:<tenantId>:lead:<leadId>) makes a lead-delivery consume
    // EXACTLY once: a retried lead write with the same key is a no-op, so a qualified
    // opportunity can never be double-charged. balance_after snapshots remaining
    // credits for audit/ROI.
    `CREATE TABLE IF NOT EXISTS lead_credit_ledger (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       tenant_id INTEGER NOT NULL,
       delta INTEGER NOT NULL,                        -- -1 consume, +N grant/purchase/reset
       reason TEXT NOT NULL,                          -- lead_delivered|grant|purchase|cycle_reset|adjustment
       lead_id INTEGER,                               -- the qualified opportunity, when reason=lead_delivered
       overage INTEGER NOT NULL DEFAULT 0,            -- 1 if this consume went into overage
       balance_after INTEGER,                         -- credits remaining after this event
       dedupe_key TEXT,                               -- idempotency (e.g. consume:lead:1234)
       actor TEXT,
       at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
    `CREATE INDEX IF NOT EXISTS idx_credit_ledger_tenant ON lead_credit_ledger(tenant_id, at DESC)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_ledger_dedupe ON lead_credit_ledger(dedupe_key) WHERE dedupe_key IS NOT NULL`,
    // Payment-provider webhook idempotency — Stripe re-delivers events, so every
    // event id is recorded once and re-deliveries are acked without re-applying.
    `CREATE TABLE IF NOT EXISTS billing_events (
       event_id TEXT PRIMARY KEY,
       provider TEXT NOT NULL DEFAULT 'stripe',
       type TEXT,
       tenant_id INTEGER,
       intent TEXT,
       processed_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,

    // ═══ REP PAYOUTS — Stripe Connect (see shared/payouts.ts + stripeConnect.ts) ══
    // One connected-account record per rep (KYC/bank on Stripe's hosted onboarding).
    `CREATE TABLE IF NOT EXISTS rep_payout_accounts (
       rep_id INTEGER PRIMARY KEY,                 -- team_members.id
       tenant_id INTEGER NOT NULL,
       provider TEXT NOT NULL DEFAULT 'stripe',
       stripe_account_id TEXT,
       onboarding_status TEXT NOT NULL DEFAULT 'none', -- none|pending|restricted|enabled
       payouts_enabled INTEGER NOT NULL DEFAULT 0,
       charges_enabled INTEGER NOT NULL DEFAULT 0,
       details_submitted INTEGER NOT NULL DEFAULT 0,
       disabled_reason TEXT,
       created_at TEXT NOT NULL DEFAULT (datetime('now')),
       updated_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_payout_acct_stripe ON rep_payout_accounts(stripe_account_id) WHERE stripe_account_id IS NOT NULL`,
    // Ordering guard — ISO of the last-applied account.updated event.created, so a
    // stale/out-of-order Connect webhook can't flip payouts_enabled back on.
    `ALTER TABLE rep_payout_accounts ADD COLUMN last_event_at TEXT`,
    // One payout row per Transfer. UNIQUE(statement_id) enforces ONE payout per
    // finalized statement — a double-click of "Pay reps" can never double-pay.
    `CREATE TABLE IF NOT EXISTS rep_payouts (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       tenant_id INTEGER NOT NULL,
       rep_id INTEGER NOT NULL,
       statement_id INTEGER,                        -- commission_statements.id (null = ad-hoc)
       amount_cents INTEGER NOT NULL,
       currency TEXT NOT NULL DEFAULT 'usd',
       status TEXT NOT NULL DEFAULT 'pending',      -- pending|processing|paid|failed|reversed
       stripe_transfer_id TEXT,
       destination_account_id TEXT,
       failure_reason TEXT,
       created_by INTEGER,
       created_at TEXT NOT NULL DEFAULT (datetime('now')),
       paid_at TEXT,
       updated_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_payout_statement ON rep_payouts(statement_id) WHERE statement_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_payout_tenant ON rep_payouts(tenant_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_payout_transfer ON rep_payouts(stripe_transfer_id)`,
    // ── First-party electronic onboarding agreements ───────────────────────
    // Each row stores the exact agreement snapshot, its SHA-256 digest, the
    // authenticated signing evidence, and the completed PDF. A partial unique
    // index prevents two managers from issuing the same active agreement.
    `CREATE TABLE IF NOT EXISTS onboarding_signing_documents (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       record_id TEXT NOT NULL UNIQUE,
       tenant_id INTEGER NOT NULL,
       rep_id INTEGER NOT NULL,
       document_type TEXT NOT NULL,
       document_version TEXT NOT NULL,
       document_title TEXT NOT NULL,
       document_snapshot_json TEXT NOT NULL,
       content_sha256 TEXT NOT NULL,
       status TEXT NOT NULL DEFAULT 'creating',
       signer_name TEXT NOT NULL,
       signer_email TEXT NOT NULL,
       sent_by INTEGER,
       invite_email_id TEXT,
       sent_at TEXT,
       delivered_at TEXT,
       completed_at TEXT,
       declined_at TEXT,
       voided_at TEXT,
       status_changed_at TEXT,
       signature_name TEXT,
       signature_sha256 TEXT,
       electronic_consent_version TEXT,
       electronic_consent_at TEXT,
       signed_user_id INTEGER,
       signed_ip TEXT,
       signed_user_agent TEXT,
       evidence_json TEXT,
       completed_pdf BLOB,
       completed_pdf_sha256 TEXT,
       completion_email_id TEXT,
       retention_until TEXT,
       failure_reason TEXT,
       created_at TEXT NOT NULL DEFAULT (datetime('now')),
       updated_at TEXT NOT NULL DEFAULT (datetime('now')),
       FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
       FOREIGN KEY (rep_id) REFERENCES team_members(id) ON DELETE CASCADE,
       FOREIGN KEY (sent_by) REFERENCES users(id) ON DELETE SET NULL
     )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_signing_doc_active
       ON onboarding_signing_documents(tenant_id, rep_id, document_type)
       WHERE status IN ('creating','sent','delivered')`,
    `CREATE INDEX IF NOT EXISTS idx_signing_doc_rep
       ON onboarding_signing_documents(tenant_id, rep_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_signing_doc_record
       ON onboarding_signing_documents(record_id)`,
    `CREATE TABLE IF NOT EXISTS onboarding_signature_events (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       document_id INTEGER NOT NULL,
       event_type TEXT NOT NULL,
       actor_user_id INTEGER,
       ip_address TEXT,
       user_agent TEXT,
       payload_json TEXT NOT NULL,
       payload_sha256 TEXT NOT NULL,
       previous_event_sha256 TEXT,
       event_sha256 TEXT NOT NULL UNIQUE,
       created_at TEXT NOT NULL,
       FOREIGN KEY (document_id) REFERENCES onboarding_signing_documents(id) ON DELETE RESTRICT,
       FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL
     )`,
    `CREATE INDEX IF NOT EXISTS idx_signature_events_document
       ON onboarding_signature_events(document_id, id)`,
    // The EXACT keystrokes the signer typed into the signature field. signature_name
    // stays the canonical profile name (back-compat, and what the matcher compared
    // against); this column preserves the literal string the human produced, so the
    // certificate can show the signature as written rather than a name the server
    // supplied for them.
    `ALTER TABLE onboarding_signing_documents ADD COLUMN signature_typed_name TEXT`,
    // ── Database-level immutability for the signature record ─────────────────
    // The app already refuses to re-sign a completed agreement, but "the app
    // refuses" is not the same guarantee as "the database refuses". A signed
    // agreement's evidence — the PDF, its digest, the evidence JSON, the bound
    // document/signature hashes, the frozen snapshot, and the signing time — is
    // the record a regulator would rely on, so SQLite itself rejects any change
    // to it once status='completed'. The completion UPDATE itself is unaffected:
    // it runs while the row is still 'sent'/'delivered', and OLD.status is what
    // the trigger tests. Post-completion bookkeeping (completion_email_id) still
    // passes because it touches none of the protected columns.
    `CREATE TRIGGER IF NOT EXISTS trg_onboarding_signed_document_immutable
       BEFORE UPDATE ON onboarding_signing_documents
       WHEN OLD.status = 'completed' AND (
         NEW.completed_pdf IS NOT OLD.completed_pdf
         OR NEW.completed_pdf_sha256 IS NOT OLD.completed_pdf_sha256
         OR NEW.evidence_json IS NOT OLD.evidence_json
         OR NEW.content_sha256 IS NOT OLD.content_sha256
         OR NEW.signature_sha256 IS NOT OLD.signature_sha256
         OR NEW.document_snapshot_json IS NOT OLD.document_snapshot_json
         OR NEW.completed_at IS NOT OLD.completed_at
         OR NEW.signature_name IS NOT OLD.signature_name
         OR NEW.signature_typed_name IS NOT OLD.signature_typed_name
         OR NEW.status IS NOT OLD.status
       )
       BEGIN SELECT RAISE(ABORT, 'a completed onboarding signature is immutable'); END`,
    // The hash chain is only evidence if links cannot be rewritten or dropped.
    `CREATE TRIGGER IF NOT EXISTS trg_onboarding_signature_events_no_update
       BEFORE UPDATE ON onboarding_signature_events
       BEGIN SELECT RAISE(ABORT, 'onboarding_signature_events is append-only'); END`,
    `CREATE TRIGGER IF NOT EXISTS trg_onboarding_signature_events_no_delete
       BEFORE DELETE ON onboarding_signature_events
       BEGIN SELECT RAISE(ABORT, 'onboarding_signature_events is append-only'); END`,
    // Recruiting invitations are sent before a candidate has an account. Keep
    // a tenant-scoped delivery record so managers can see what was sent and the
    // audit trail does not depend on transient Resend logs.
    `CREATE TABLE IF NOT EXISTS onboarding_recruiting_invites (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       record_id TEXT NOT NULL UNIQUE,
       tenant_id INTEGER NOT NULL,
       candidate_name TEXT NOT NULL,
       candidate_email TEXT NOT NULL,
       status TEXT NOT NULL DEFAULT 'creating',
       invited_by INTEGER,
       email_id TEXT,
       sent_at TEXT,
       failure_reason TEXT,
       created_at TEXT NOT NULL,
       updated_at TEXT NOT NULL,
       FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
       FOREIGN KEY (invited_by) REFERENCES users(id) ON DELETE SET NULL
     )`,
    `CREATE INDEX IF NOT EXISTS idx_recruiting_invites_tenant
       ON onboarding_recruiting_invites(tenant_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_recruiting_invites_email
       ON onboarding_recruiting_invites(tenant_id, candidate_email, created_at DESC)`,
    `ALTER TABLE onboarding_recruiting_invites ADD COLUMN token_sha256 TEXT`,
    `ALTER TABLE onboarding_recruiting_invites ADD COLUMN expires_at TEXT`,
    `ALTER TABLE onboarding_recruiting_invites ADD COLUMN application_id INTEGER`,
    `ALTER TABLE onboarding_recruiting_invites ADD COLUMN applied_at TEXT`,
    `ALTER TABLE onboarding_recruiting_invites ADD COLUMN approved_at TEXT`,
    `ALTER TABLE onboarding_recruiting_invites ADD COLUMN rejected_at TEXT`,
    `ALTER TABLE onboarding_recruiting_invites ADD COLUMN login_email_id TEXT`,
    `ALTER TABLE onboarding_recruiting_invites ADD COLUMN login_sent_at TEXT`,
    `ALTER TABLE onboarding_recruiting_invites ADD COLUMN agreements_issued_at TEXT`,
    `ALTER TABLE onboarding_recruiting_invites ADD COLUMN activated_at TEXT`,
    `ALTER TABLE onboarding_recruiting_invites ADD COLUMN delivery_attempts INTEGER NOT NULL DEFAULT 0`,
    // Comp terms chosen by the manager/admin/team-lead AT INVITE TIME. They ride
    // the invite → application → approval, where they seed the rep's commission
    // plan + chargeback reserve (assignStructureToRep). NULL = inherit org default.
    `ALTER TABLE onboarding_recruiting_invites ADD COLUMN commission_structure TEXT`,   // 'FLAT' | 'TIERED'
    `ALTER TABLE onboarding_recruiting_invites ADD COLUMN flat_rate_cents INTEGER`,     // per-sale rate when FLAT
    `ALTER TABLE onboarding_recruiting_invites ADD COLUMN reserve_percent INTEGER`,     // whole percent 0..100 held back
    `ALTER TABLE onboarding_recruiting_invites ADD COLUMN reserve_cap_cents INTEGER`,   // reserve ceiling in cents; 0 = uncapped
    // The TIER LADDER the manager picked at invite time, as JSON (a normalized
    // CommissionTier[]). Before this, an invite could say TIERED and carry
    // nothing behind it: the contract silently rendered the house ladder
    // (normalizeCommissionTerms substitutes DEFAULT_RETRO_TIERS for an empty
    // one) and approval silently assigned the house plan version, so a manager
    // who invited 1–6 at $175 watched the rep sign — and get paid — $150.
    // JSON, not a child table: every ladder read in this codebase is a
    // whole-ladder read, and an invite ladder is a PROPOSAL, not a payable plan
    // — it becomes a commission_plan_version only at approval. Same shape as
    // team_members.commission_terms. NULL = none proposed (inherit).
    // NOTE: once agreements are issued, saveRepCommissionTerms writes the rep
    // row, which outranks the invite from then on — re-sending paperwork does
    // NOT revert to this ladder, by design (last explicit decision wins).
    `ALTER TABLE onboarding_recruiting_invites ADD COLUMN commission_tiers_json TEXT`,
    // Role + upline chosen AT INVITE TIME, riding the invite → approval the
    // same way the comp terms above do. NULL role = legacy invite = 'rep';
    // NULL supervisor = top-level. (No FK — the application_id pattern.)
    `ALTER TABLE onboarding_recruiting_invites ADD COLUMN invited_role TEXT`,
    `ALTER TABLE onboarding_recruiting_invites ADD COLUMN invited_supervisor_id INTEGER`,
    // Per-hire override rates, ALSO chosen at invite time: what the team-lead
    // and manager slots keep from each of THIS hire's qualified sales. NULL =
    // inherit the org default (the tenants commission_override_* columns);
    // approval stamps them onto the new member's roster row. Never shown to
    // the candidate — the upline's cut is not part of what the hire signs.
    `ALTER TABLE onboarding_recruiting_invites ADD COLUMN invited_override_team_lead_cents INTEGER`,
    `ALTER TABLE onboarding_recruiting_invites ADD COLUMN invited_override_manager_cents INTEGER`,
    // A leader hire can bring their DOWNLINE with them: existing members the
    // hirer picked to be re-homed under the new team_lead/manager at approval.
    // JSON array of team_members ids; NULL/empty = nobody moves. Validated at
    // send AND re-validated at approval (members go stale between the two).
    `ALTER TABLE onboarding_recruiting_invites ADD COLUMN invited_downline_ids TEXT`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_recruiting_invites_token
       ON onboarding_recruiting_invites(token_sha256) WHERE token_sha256 IS NOT NULL`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_recruiting_invites_application
       ON onboarding_recruiting_invites(application_id) WHERE application_id IS NOT NULL`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_recruiting_invites_open_email
       ON onboarding_recruiting_invites(tenant_id, candidate_email)
       WHERE application_id IS NULL AND status IN ('creating','invited','failed')`,
    `CREATE INDEX IF NOT EXISTS idx_rep_applications_invite
       ON rep_applications(invite_id) WHERE invite_id IS NOT NULL`,

    // Complete NC/SC incorporated-place target inventory. This is planning
    // metadata only: it never substitutes city-level claims for address-level
    // availability. The address pool + observations remain the ground truth.
    `CREATE TABLE IF NOT EXISTS state_fiber_markets (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       state TEXT NOT NULL CHECK(state IN ('GA','NC','SC')),
       place_fips TEXT NOT NULL,
       city TEXT NOT NULL,
       legal_name TEXT NOT NULL,
       county_fips TEXT,
       county TEXT,
       counties_json TEXT NOT NULL DEFAULT '[]',
       population INTEGER NOT NULL DEFAULT 0,
       lat REAL,
       lng REAL,
       priority_class TEXT NOT NULL CHECK(priority_class IN ('critical','high','medium','low')),
       priority_score REAL NOT NULL DEFAULT 0,
       priority_reasons TEXT NOT NULL DEFAULT '[]',
       cadence_hours INTEGER NOT NULL,
       announcement_url TEXT,
       last_scanned_at TEXT,
       last_status TEXT NOT NULL DEFAULT 'unknown',
       fresh_flag INTEGER NOT NULL DEFAULT 0,
       next_scan_at TEXT,
       source_vintage TEXT NOT NULL,
       created_at TEXT NOT NULL DEFAULT (datetime('now')),
       updated_at TEXT NOT NULL DEFAULT (datetime('now')),
       UNIQUE(state, place_fips)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_state_markets_due ON state_fiber_markets(next_scan_at, priority_score DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_state_markets_state_priority ON state_fiber_markets(state, priority_class, priority_score DESC)`,
    // Market eligibility is evidence-backed. The Census place inventory remains
    // useful for discovery/planning, but it may not spend provider checks until
    // an official Kinetic directory or expansion source verifies the market.
    `ALTER TABLE state_fiber_markets ADD COLUMN kinetic_status TEXT NOT NULL DEFAULT 'unverified'`,
    `ALTER TABLE state_fiber_markets ADD COLUMN auto_scan_eligible INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE state_fiber_markets ADD COLUMN directory_url TEXT`,
    `ALTER TABLE state_fiber_markets ADD COLUMN evidence_checked_at TEXT`,
    `ALTER TABLE state_fiber_markets ADD COLUMN directory_last_seen_at TEXT`,
    `ALTER TABLE state_fiber_markets ADD COLUMN coverage_gap TEXT`,
    `ALTER TABLE state_fiber_markets ADD COLUMN inventory_status TEXT NOT NULL DEFAULT 'pending'`,
    `ALTER TABLE state_fiber_markets ADD COLUMN inventory_attempted_at TEXT`,
    `ALTER TABLE state_fiber_markets ADD COLUMN inventory_retry_at TEXT`,
    `ALTER TABLE state_fiber_markets ADD COLUMN inventory_failures INTEGER NOT NULL DEFAULT 0`,
    `CREATE INDEX IF NOT EXISTS idx_state_markets_eligible_due ON state_fiber_markets(auto_scan_eligible, next_scan_at, priority_score DESC)`,
    `CREATE TABLE IF NOT EXISTS market_evidence (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       market_id INTEGER NOT NULL REFERENCES state_fiber_markets(id) ON DELETE CASCADE,
       evidence_type TEXT NOT NULL CHECK(evidence_type IN ('official_directory','official_announcement','grant_award','licensed_import')),
       source_url TEXT NOT NULL,
       source_title TEXT,
       observed_at TEXT NOT NULL,
       content_hash TEXT NOT NULL,
       created_at TEXT NOT NULL DEFAULT (datetime('now')),
       UNIQUE(market_id, evidence_type, source_url)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_market_evidence_market ON market_evidence(market_id, observed_at DESC)`,

    // Independent/licensed verification evidence. A Kinetic result is only
    // cross-verified when a distinct source records address-level availability.
    `CREATE TABLE IF NOT EXISTS availability_corroboration (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       tenant_id INTEGER NOT NULL,
       scan_target_id INTEGER NOT NULL REFERENCES scan_targets(id) ON DELETE CASCADE,
       source TEXT NOT NULL,
       source_record_id TEXT,
       observed_at TEXT NOT NULL,
       availability TEXT NOT NULL CHECK(availability IN ('available','unavailable','unknown')),
       technology TEXT,
       max_down_mbps INTEGER,
       evidence_hash TEXT NOT NULL,
       reference_url TEXT,
       import_batch_id TEXT,
       created_at TEXT NOT NULL DEFAULT (datetime('now')),
       UNIQUE(tenant_id, scan_target_id, source, evidence_hash)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_corroboration_target ON availability_corroboration(tenant_id, scan_target_id, observed_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_corroboration_batch ON availability_corroboration(import_batch_id)`,

    // Announcement watch ledger. Sources are fetched conditionally and content
    // hashes prevent duplicate prioritization/alerts.
    `CREATE TABLE IF NOT EXISTS market_announcements (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       source_url TEXT NOT NULL,
       title TEXT NOT NULL,
       published_at TEXT,
       state TEXT CHECK(state IN ('GA','NC','SC')),
       locations_json TEXT NOT NULL DEFAULT '[]',
       content_hash TEXT NOT NULL UNIQUE,
       last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
       created_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
    `CREATE INDEX IF NOT EXISTS idx_market_announcements_state ON market_announcements(state, published_at DESC)`,
    `CREATE TABLE IF NOT EXISTS monitor_source_polls (
       source_url TEXT PRIMARY KEY,
       etag TEXT,
       last_modified TEXT,
       last_checked_at TEXT,
       last_success_at TEXT,
       next_poll_at TEXT,
       status TEXT NOT NULL DEFAULT 'never',
       error TEXT,
       updated_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
    `ALTER TABLE scan_targets ADD COLUMN last_fiber_available INTEGER`,
    `ALTER TABLE scan_targets ADD COLUMN first_seen_fiber_at TEXT`,
    `ALTER TABLE scan_targets ADD COLUMN access_id TEXT`,
    `ALTER TABLE scan_targets ADD COLUMN service_key TEXT`,
    `ALTER TABLE scan_targets ADD COLUMN last_customer_segment TEXT NOT NULL DEFAULT 'unknown'`,
    `ALTER TABLE scan_targets ADD COLUMN last_customer_confidence TEXT NOT NULL DEFAULT 'low'`,
    `ALTER TABLE scan_targets ADD COLUMN last_customer_signals TEXT NOT NULL DEFAULT '[]'`,
    `CREATE INDEX IF NOT EXISTS idx_scan_targets_fresh_opportunity ON scan_targets(first_seen_fiber_at, last_customer_segment)`,
    `CREATE TABLE IF NOT EXISTS availability_snapshots (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       tenant_id INTEGER NOT NULL,
       scan_target_id INTEGER NOT NULL REFERENCES scan_targets(id) ON DELETE CASCADE,
       run_id TEXT,
       checked_at TEXT NOT NULL DEFAULT (datetime('now')),
       conclusive INTEGER NOT NULL,
       fiber_available INTEGER,
       fiber_status TEXT,
       max_download_mbps INTEGER,
       service_status TEXT,
       household_segment_type TEXT,
       billing_status TEXT,
       customer_segment TEXT NOT NULL DEFAULT 'unknown',
       customer_confidence TEXT NOT NULL DEFAULT 'low',
       customer_signals TEXT NOT NULL DEFAULT '[]',
       transition_status TEXT NOT NULL,
       fresh INTEGER NOT NULL DEFAULT 0,
       api_source TEXT,
       evidence_hash TEXT NOT NULL,
       fiber_check_id INTEGER REFERENCES fiber_checks(id),
       error TEXT
     )`,
    // Obsolete: the raw-TEXT checked_at index mis-ordered mixed formats and is
    // fully superseded by idx_availability_snapshots_target_epoch (same leading
    // column, canonical epoch ordering). Dropped so no query can bind to it.
    `DROP INDEX IF EXISTS idx_availability_snapshots_target`,
    `CREATE INDEX IF NOT EXISTS idx_availability_snapshots_run ON availability_snapshots(run_id, checked_at)`,
    `ALTER TABLE availability_snapshots ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE availability_snapshots ADD COLUMN latency_ms INTEGER`,
    // ── Competitive eligibility (Spectrum-only gate). Persist the competitor
    //    evidence AND the canonical classifier's decision on every conclusive
    //    snapshot so the projector can gate publication + retract a lead when a
    //    later recheck reveals a fiber competitor. See shared/competitiveEligibility.ts.
    `ALTER TABLE availability_snapshots ADD COLUMN competitor_name TEXT`,
    `ALTER TABLE availability_snapshots ADD COLUMN competitor_tech TEXT`,
    `ALTER TABLE availability_snapshots ADD COLUMN competitive_decision TEXT`,
    `ALTER TABLE availability_snapshots ADD COLUMN competitive_version INTEGER`,
    // ── Canonical timestamp: epoch milliseconds (INTEGER). This is the ONLY column
    //    used for chronological ordering. The legacy TEXT checked_at was written in
    //    two formats (ISO 'T…Z' vs SQLite '… …'), and a raw text sort mis-ranked an
    //    older failed snapshot ahead of a newer conclusive one — sinking Fresh Leads.
    `ALTER TABLE availability_snapshots ADD COLUMN checked_at_epoch INTEGER`,
    // Backfill from the legacy TEXT (strftime handles both formats). Second precision
    // is sufficient — id DESC breaks any same-second tie.
    `UPDATE availability_snapshots SET checked_at_epoch = CAST(strftime('%s', checked_at) AS INTEGER)*1000 WHERE checked_at_epoch IS NULL AND checked_at IS NOT NULL`,
    // Constraint: no writer may EVER store a non-integer epoch — this is what makes a
    // mixed/text format impossible to reintroduce.
    `DROP TRIGGER IF EXISTS trg_availability_epoch_integer`,
    `CREATE TRIGGER IF NOT EXISTS trg_availability_epoch_integer BEFORE INSERT ON availability_snapshots
       WHEN NEW.checked_at_epoch IS NULL OR typeof(NEW.checked_at_epoch)<>'integer'
       BEGIN SELECT RAISE(ABORT,'availability_snapshot_checked_at_epoch_must_be_integer'); END`,
    `CREATE INDEX IF NOT EXISTS idx_availability_snapshots_target_epoch ON availability_snapshots(scan_target_id, checked_at_epoch DESC, id DESC)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_availability_snapshots_attempt ON availability_snapshots(tenant_id, run_id, scan_target_id) WHERE run_id IS NOT NULL`,
    // Defense in depth: even a future scanner or overlooked route cannot insert
    // a provider-fresh lead without the projector's complete provenance. Legacy
    // rows are left untouched; the UPDATE trigger fires only when a protected
    // classification/provenance column is explicitly changed.
    // A fresh-fiber lead is allowed by EITHER path: (a) cross-verified with >=2
    // independent sources — unchanged for every non-authoritative lead — OR (b) the
    // AUTHORITATIVE rule, Kinetic NEW FIBER + billing N, which publishes on Kinetic's
    // own new-build signal. DROP+CREATE so existing DBs pick up the loosened guard.
    `DROP TRIGGER IF EXISTS trg_leads_fresh_insert_guard`,
    `DROP TRIGGER IF EXISTS trg_leads_fresh_update_guard`,
    `CREATE TRIGGER IF NOT EXISTS trg_leads_fresh_insert_guard
       BEFORE INSERT ON leads
       WHEN (COALESCE(NEW.is_new_fiber,0)=1 OR lower(COALESCE(NEW.fiber_status,''))='new_fiber')
        AND NOT (
          NEW.source_scan_target_id IS NOT NULL AND NEW.fresh_confirmed_at IS NOT NULL
          AND NEW.lead_tag='fresh_fiber_confirmed'
          AND (
            (NEW.fresh_confidence='cross_verified' AND COALESCE(json_array_length(NEW.fresh_sources),0)>=2)
            OR (upper(COALESCE(NEW.household_segment_type,''))='NEW FIBER' AND upper(COALESCE(NEW.billing_status,''))='N')
          )
        )
       BEGIN SELECT RAISE(ABORT,'fresh_fiber_requires_cross_verification'); END`,
    `CREATE TRIGGER IF NOT EXISTS trg_leads_fresh_update_guard
       BEFORE UPDATE OF is_new_fiber,fiber_status,source_scan_target_id,fresh_confirmed_at,fresh_confidence,fresh_sources,lead_tag,household_segment_type,billing_status ON leads
       WHEN (COALESCE(NEW.is_new_fiber,0)=1 OR lower(COALESCE(NEW.fiber_status,''))='new_fiber')
        AND NOT (
          NEW.source_scan_target_id IS NOT NULL AND NEW.fresh_confirmed_at IS NOT NULL
          AND NEW.lead_tag='fresh_fiber_confirmed'
          AND (
            (NEW.fresh_confidence='cross_verified' AND COALESCE(json_array_length(NEW.fresh_sources),0)>=2)
            OR (upper(COALESCE(NEW.household_segment_type,''))='NEW FIBER' AND upper(COALESCE(NEW.billing_status,''))='N')
          )
        )
       BEGIN SELECT RAISE(ABORT,'fresh_fiber_requires_cross_verification'); END`,
    `ALTER TABLE notification_outbox ADD COLUMN next_attempt_at TEXT`,
    `ALTER TABLE notification_outbox ADD COLUMN last_error TEXT`,
    `ALTER TABLE notification_outbox ADD COLUMN lease_owner TEXT`,
    `ALTER TABLE notification_outbox ADD COLUMN lease_expires_at TEXT`,
    // Rename historical Radar-only kinds so no UI or worker can mistake
    // repeated observations from one provider for independent verification.
    `UPDATE notification_outbox SET kind='primary_candidate_new' WHERE kind='candidate_new'`,
    `UPDATE notification_outbox SET kind='primary_reconfirmed_new' WHERE kind='verified_new'`,
    `CREATE INDEX IF NOT EXISTS idx_outbox_delivery_due ON notification_outbox(kind, status, next_attempt_at, created_at)`,
    `CREATE TABLE IF NOT EXISTS sweep_jobs (
       id TEXT PRIMARY KEY,
       tenant_id INTEGER NOT NULL,
       kind TEXT NOT NULL DEFAULT 'city',
       query TEXT NOT NULL,
       city TEXT,
       state TEXT,
       radius_meters INTEGER,
       phase TEXT NOT NULL DEFAULT 'queued',
       status TEXT NOT NULL DEFAULT 'running',
       source TEXT,
       harvested INTEGER NOT NULL DEFAULT 0,
       queued INTEGER NOT NULL DEFAULT 0,
       checked INTEGER NOT NULL DEFAULT 0,
       failed INTEGER NOT NULL DEFAULT 0,
       fresh_found INTEGER NOT NULL DEFAULT 0,
       opportunities_found INTEGER NOT NULL DEFAULT 0,
       max_checks INTEGER NOT NULL,
       current_run_id TEXT,
       error TEXT,
       created_by INTEGER,
       started_at TEXT NOT NULL DEFAULT (datetime('now')),
       heartbeat_at TEXT,
       completed_at TEXT,
       updated_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
    `CREATE INDEX IF NOT EXISTS idx_sweep_jobs_tenant ON sweep_jobs(tenant_id, started_at DESC)`,
    `CREATE TABLE IF NOT EXISTS sweep_job_targets (
       sweep_job_id TEXT NOT NULL REFERENCES sweep_jobs(id) ON DELETE CASCADE,
       target_id INTEGER NOT NULL REFERENCES scan_targets(id) ON DELETE CASCADE,
       seq INTEGER NOT NULL,
       state TEXT NOT NULL DEFAULT 'queued',
       run_id TEXT,
       PRIMARY KEY(sweep_job_id, target_id)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_sweep_targets_queue ON sweep_job_targets(sweep_job_id, state, seq)`,

    // ── STATEWIDE SWEEP — an active-priority, run-now orchestration that drives
    // one city sweep at a time across every scan-eligible market in a state until
    // every discoverable address is checked. The checkpoints below exist ONLY for
    // crash recovery (resume a running sweep on boot); they never defer the work. ──
    `CREATE TABLE IF NOT EXISTS state_sweeps (
       id TEXT PRIMARY KEY,
       tenant_id INTEGER NOT NULL,
       state TEXT NOT NULL,
       status TEXT NOT NULL DEFAULT 'running',
       phase TEXT NOT NULL DEFAULT 'running',
       cities_total INTEGER NOT NULL DEFAULT 0,
       cities_completed INTEGER NOT NULL DEFAULT 0,
       current_city TEXT,
       checked INTEGER NOT NULL DEFAULT 0,
       fresh_found INTEGER NOT NULL DEFAULT 0,
       coming_soon INTEGER NOT NULL DEFAULT 0,
       retrying INTEGER NOT NULL DEFAULT 0,
       unresolved INTEGER NOT NULL DEFAULT 0,
       max_checks_per_city INTEGER,
       report_json TEXT,
       error TEXT,
       created_by INTEGER,
       started_at TEXT NOT NULL DEFAULT (datetime('now')),
       heartbeat_at TEXT,
       completed_at TEXT,
       updated_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
    `CREATE INDEX IF NOT EXISTS idx_state_sweeps_tenant ON state_sweeps(tenant_id, started_at DESC)`,
    `CREATE TABLE IF NOT EXISTS state_sweep_cities (
       state_sweep_id TEXT NOT NULL REFERENCES state_sweeps(id) ON DELETE CASCADE,
       city TEXT NOT NULL,
       state TEXT NOT NULL,
       seq INTEGER NOT NULL,
       status TEXT NOT NULL DEFAULT 'pending',
       sweep_job_id TEXT,
       checked INTEGER NOT NULL DEFAULT 0,
       fresh INTEGER NOT NULL DEFAULT 0,
       coming_soon INTEGER NOT NULL DEFAULT 0,
       failed INTEGER NOT NULL DEFAULT 0,
       error TEXT,
       started_at TEXT,
       completed_at TEXT,
       PRIMARY KEY(state_sweep_id, city)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_state_sweep_cities_queue ON state_sweep_cities(state_sweep_id, status, seq)`,
    // Per-city retry counter: a harvest timeout is TEMPORARY — the sweep retries
    // the city (bounded) instead of silently dropping a whole town's coverage.
    `ALTER TABLE state_sweep_cities ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0`,

    // ── ADDRESS DISCOVERY — durable, tenant-scoped enumeration before qualification ──
    // Discovery is deliberately separate from scan_runs. These tables answer
    // "which physical addresses exist here and how do we know?"; scan_runs then
    // perform paid fiber qualification, and freshFiberProjector remains the only
    // component allowed to publish a rep-facing fresh-fiber lead.
    `CREATE TABLE IF NOT EXISTS town_boundaries (
       id TEXT PRIMARY KEY,
       tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
       boundary_key TEXT NOT NULL,
       name TEXT NOT NULL,
       state TEXT NOT NULL,
       country_code TEXT NOT NULL DEFAULT 'US',
       geometry_json TEXT NOT NULL,
       bbox_json TEXT NOT NULL,
       centroid_json TEXT,
       source TEXT NOT NULL,
       source_ref TEXT,
       source_metadata_json TEXT NOT NULL DEFAULT '{}',
       fetched_at TEXT NOT NULL,
       expires_at TEXT NOT NULL,
       created_at TEXT NOT NULL DEFAULT (datetime('now')),
       updated_at TEXT NOT NULL DEFAULT (datetime('now')),
       UNIQUE(tenant_id, boundary_key)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_town_boundaries_expiry ON town_boundaries(tenant_id, expires_at)`,
    `CREATE TABLE IF NOT EXISTS discovery_jobs (
       id TEXT PRIMARY KEY,
       tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
       idempotency_key TEXT NOT NULL,
       request_hash TEXT NOT NULL DEFAULT '',
       requested_area_json TEXT,
       area_json TEXT,
       bbox_json TEXT,
       town_name TEXT,
       state TEXT NOT NULL DEFAULT 'NC',
       status TEXT NOT NULL DEFAULT 'queued',
       phase TEXT NOT NULL DEFAULT 'boundary',
       source_config_json TEXT NOT NULL DEFAULT '{}',
       total_tiles INTEGER NOT NULL DEFAULT 0,
       completed_tiles INTEGER NOT NULL DEFAULT 0,
       partial_tiles INTEGER NOT NULL DEFAULT 0,
       failed_tiles INTEGER NOT NULL DEFAULT 0,
       addresses_observed INTEGER NOT NULL DEFAULT 0,
       addresses_inferred INTEGER NOT NULL DEFAULT 0,
       addresses_qualified INTEGER NOT NULL DEFAULT 0,
       qualification_checked INTEGER NOT NULL DEFAULT 0,
       qualification_failed INTEGER NOT NULL DEFAULT 0,
       qualification_dispatch_completed_at TEXT,
       fresh_found INTEGER NOT NULL DEFAULT 0,
       no_service_found INTEGER NOT NULL DEFAULT 0,
       handoff_collisions INTEGER NOT NULL DEFAULT 0,
       cache_hits INTEGER NOT NULL DEFAULT 0,
       cache_misses INTEGER NOT NULL DEFAULT 0,
       last_scheduled_at TEXT,
       boundary_next_attempt_at TEXT,
       heartbeat_at TEXT,
       error_summary TEXT,
       cancelled_at TEXT,
       created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
       created_at TEXT NOT NULL DEFAULT (datetime('now')),
       started_at TEXT,
       completed_at TEXT,
       updated_at TEXT NOT NULL DEFAULT (datetime('now')),
       UNIQUE(tenant_id, idempotency_key)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_discovery_jobs_tenant ON discovery_jobs(tenant_id, created_at DESC)`,
    `ALTER TABLE discovery_jobs ADD COLUMN qualification_dispatch_completed_at TEXT`,
    `ALTER TABLE discovery_jobs ADD COLUMN request_hash TEXT NOT NULL DEFAULT ''`,
    `CREATE INDEX IF NOT EXISTS idx_discovery_jobs_schedule ON discovery_jobs(status, phase, last_scheduled_at, created_at)`,
    `ALTER TABLE discovery_jobs ADD COLUMN boundary_next_attempt_at TEXT`,
    `CREATE TABLE IF NOT EXISTS discovery_tiles (
       id TEXT PRIMARY KEY,
       job_id TEXT NOT NULL REFERENCES discovery_jobs(id) ON DELETE CASCADE,
       tile_key TEXT NOT NULL,
       sequence INTEGER NOT NULL,
       geometry_json TEXT NOT NULL,
       bbox_json TEXT NOT NULL,
       status TEXT NOT NULL DEFAULT 'queued',
       attempt_count INTEGER NOT NULL DEFAULT 0,
       max_attempts INTEGER NOT NULL DEFAULT 3,
       next_attempt_at TEXT,
       lease_owner TEXT,
       lease_expires_at TEXT,
       source_checkpoint_json TEXT NOT NULL DEFAULT '{}',
       source_errors_json TEXT NOT NULL DEFAULT '{}',
       observed_count INTEGER NOT NULL DEFAULT 0,
       inferred_count INTEGER NOT NULL DEFAULT 0,
       duplicate_count INTEGER NOT NULL DEFAULT 0,
       coverage_ratio REAL,
       coverage_class TEXT NOT NULL DEFAULT 'unknown',
       error TEXT,
       started_at TEXT,
       completed_at TEXT,
       updated_at TEXT NOT NULL DEFAULT (datetime('now')),
       UNIQUE(job_id, tile_key)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_discovery_tiles_claim ON discovery_tiles(status, next_attempt_at, lease_expires_at, sequence)`,
    `CREATE INDEX IF NOT EXISTS idx_discovery_tiles_job ON discovery_tiles(job_id, status, sequence)`,
    `CREATE TABLE IF NOT EXISTS canonical_addresses (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
       canonical_key TEXT NOT NULL,
       full_address TEXT NOT NULL,
       house_number TEXT,
       street TEXT,
       unit TEXT,
       city TEXT NOT NULL,
       state TEXT NOT NULL,
       postal_code TEXT,
       lat REAL,
       lng REAL,
       coordinate_quality TEXT NOT NULL DEFAULT 'unknown',
       validation_status TEXT NOT NULL DEFAULT 'observed',
       confidence REAL NOT NULL DEFAULT 0.5,
       inferred_only INTEGER NOT NULL DEFAULT 0,
       authoritative_sources INTEGER NOT NULL DEFAULT 0,
       independent_sources INTEGER NOT NULL DEFAULT 1,
       first_observed_at TEXT NOT NULL DEFAULT (datetime('now')),
       last_observed_at TEXT NOT NULL DEFAULT (datetime('now')),
       created_at TEXT NOT NULL DEFAULT (datetime('now')),
       updated_at TEXT NOT NULL DEFAULT (datetime('now')),
       UNIQUE(tenant_id, canonical_key)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_canonical_addresses_city ON canonical_addresses(tenant_id, state, city)`,
    `CREATE INDEX IF NOT EXISTS idx_canonical_addresses_point ON canonical_addresses(tenant_id, lat, lng)`,
    `CREATE INDEX IF NOT EXISTS idx_canonical_addresses_validation ON canonical_addresses(tenant_id, validation_status, inferred_only)`,
    `CREATE TABLE IF NOT EXISTS address_evidence (
       id TEXT PRIMARY KEY,
       tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
       canonical_address_id INTEGER NOT NULL REFERENCES canonical_addresses(id) ON DELETE CASCADE,
       source_id TEXT NOT NULL,
       source_record_id TEXT NOT NULL,
       evidence_kind TEXT NOT NULL DEFAULT 'address_point',
       authoritative INTEGER NOT NULL DEFAULT 0,
       observed INTEGER NOT NULL DEFAULT 1,
       inferred INTEGER NOT NULL DEFAULT 0,
       confidence REAL NOT NULL DEFAULT 0.5,
       license_name TEXT,
       license_url TEXT,
       raw_json TEXT NOT NULL,
       content_hash TEXT NOT NULL,
       observed_at TEXT NOT NULL,
       created_at TEXT NOT NULL DEFAULT (datetime('now')),
       UNIQUE(tenant_id, source_id, source_record_id, content_hash)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_address_evidence_canonical ON address_evidence(canonical_address_id, source_id)`,
    `CREATE TABLE IF NOT EXISTS coverage_evidence (
       id TEXT PRIMARY KEY,
       tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
       job_id TEXT NOT NULL REFERENCES discovery_jobs(id) ON DELETE CASCADE,
       tile_id TEXT NOT NULL REFERENCES discovery_tiles(id) ON DELETE CASCADE,
       source_id TEXT NOT NULL,
       source_record_id TEXT NOT NULL,
       evidence_kind TEXT NOT NULL,
       lat REAL,
       lng REAL,
       confidence REAL NOT NULL DEFAULT 0.5,
       license_name TEXT,
       license_url TEXT,
       raw_json TEXT NOT NULL,
       content_hash TEXT NOT NULL,
       created_at TEXT NOT NULL DEFAULT (datetime('now')),
       UNIQUE(tenant_id,source_id,source_record_id,content_hash)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_coverage_evidence_tile ON coverage_evidence(job_id,tile_id,evidence_kind)`,
    `CREATE TABLE IF NOT EXISTS address_aliases (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
       canonical_address_id INTEGER NOT NULL REFERENCES canonical_addresses(id) ON DELETE CASCADE,
       alias_key TEXT NOT NULL,
       alias_text TEXT NOT NULL,
       source_id TEXT NOT NULL,
       created_at TEXT NOT NULL DEFAULT (datetime('now')),
       UNIQUE(tenant_id, alias_key, canonical_address_id)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_address_alias_lookup ON address_aliases(tenant_id, alias_key)`,
    `CREATE TABLE IF NOT EXISTS address_units (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
       canonical_address_id INTEGER NOT NULL REFERENCES canonical_addresses(id) ON DELETE CASCADE,
       unit_key TEXT NOT NULL,
       unit_label TEXT NOT NULL,
       source_id TEXT NOT NULL,
       observed_at TEXT NOT NULL,
       UNIQUE(tenant_id, canonical_address_id, unit_key)
     )`,
    `CREATE TABLE IF NOT EXISTS address_coordinates (
       id TEXT PRIMARY KEY,
       tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
       canonical_address_id INTEGER NOT NULL REFERENCES canonical_addresses(id) ON DELETE CASCADE,
       source_id TEXT NOT NULL,
       lat REAL NOT NULL,
       lng REAL NOT NULL,
       quality TEXT NOT NULL,
       confidence REAL NOT NULL DEFAULT 0.5,
       observed_at TEXT NOT NULL,
       UNIQUE(tenant_id, canonical_address_id, source_id, lat, lng)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_address_coordinates_point ON address_coordinates(tenant_id, lat, lng)`,
    `CREATE TABLE IF NOT EXISTS discovery_job_addresses (
       job_id TEXT NOT NULL REFERENCES discovery_jobs(id) ON DELETE CASCADE,
       canonical_address_id INTEGER NOT NULL REFERENCES canonical_addresses(id) ON DELETE CASCADE,
       first_tile_id TEXT REFERENCES discovery_tiles(id) ON DELETE SET NULL,
       scan_target_id INTEGER REFERENCES scan_targets(id) ON DELETE SET NULL,
       first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
       PRIMARY KEY(job_id, canonical_address_id)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_discovery_job_addresses_target ON discovery_job_addresses(job_id, scan_target_id)`,
    `CREATE TABLE IF NOT EXISTS discovery_job_runs (
       job_id TEXT NOT NULL REFERENCES discovery_jobs(id) ON DELETE CASCADE,
       run_id TEXT NOT NULL REFERENCES scan_runs(id) ON DELETE CASCADE,
       sequence INTEGER NOT NULL,
       created_at TEXT NOT NULL DEFAULT (datetime('now')),
       PRIMARY KEY(job_id, run_id)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_discovery_job_runs_job ON discovery_job_runs(job_id, sequence)`,
    `CREATE TABLE IF NOT EXISTS qualification_checks (
       id TEXT PRIMARY KEY,
       tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
       job_id TEXT NOT NULL REFERENCES discovery_jobs(id) ON DELETE CASCADE,
       canonical_address_id INTEGER NOT NULL REFERENCES canonical_addresses(id) ON DELETE CASCADE,
       scan_target_id INTEGER REFERENCES scan_targets(id) ON DELETE SET NULL,
       run_id TEXT REFERENCES scan_runs(id) ON DELETE SET NULL,
       state TEXT NOT NULL DEFAULT 'queued',
       result TEXT,
       cache_reused INTEGER NOT NULL DEFAULT 0,
       lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
       checked_at TEXT,
       created_at TEXT NOT NULL DEFAULT (datetime('now')),
       updated_at TEXT NOT NULL DEFAULT (datetime('now')),
       UNIQUE(job_id, canonical_address_id)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_qualification_checks_job ON qualification_checks(job_id, state)`,
    `ALTER TABLE qualification_checks ADD COLUMN map_announced_at TEXT`,
    `ALTER TABLE qualification_checks ADD COLUMN map_result_reported_at TEXT`,
    `CREATE TABLE IF NOT EXISTS discovery_qualification_cache (
       tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
       canonical_key TEXT NOT NULL,
       scan_target_id INTEGER REFERENCES scan_targets(id) ON DELETE SET NULL,
       result TEXT NOT NULL,
       conclusive INTEGER NOT NULL DEFAULT 0,
       checked_at TEXT NOT NULL,
       expires_at TEXT NOT NULL,
       evidence_hash TEXT,
       PRIMARY KEY(tenant_id, canonical_key)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_discovery_qualification_cache_expiry ON discovery_qualification_cache(tenant_id, expires_at)`,
    `CREATE TABLE IF NOT EXISTS discovery_events (
       sequence INTEGER PRIMARY KEY AUTOINCREMENT,
       tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
       job_id TEXT NOT NULL REFERENCES discovery_jobs(id) ON DELETE CASCADE,
       event_type TEXT NOT NULL,
       payload_json TEXT NOT NULL DEFAULT '{}',
       created_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
    `CREATE INDEX IF NOT EXISTS idx_discovery_events_stream ON discovery_events(tenant_id, sequence)`,
    `CREATE INDEX IF NOT EXISTS idx_discovery_events_job ON discovery_events(job_id, sequence)`,
    `CREATE TABLE IF NOT EXISTS address_source_health (
       tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
       source_id TEXT NOT NULL,
       enabled INTEGER NOT NULL DEFAULT 1,
       priority INTEGER NOT NULL DEFAULT 100,
       health_status TEXT NOT NULL DEFAULT 'unknown',
       consecutive_failures INTEGER NOT NULL DEFAULT 0,
       last_success_at TEXT,
       last_failure_at TEXT,
       last_error TEXT,
       circuit_open_until TEXT,
       requests INTEGER NOT NULL DEFAULT 0,
       records INTEGER NOT NULL DEFAULT 0,
       updated_at TEXT NOT NULL DEFAULT (datetime('now')),
       PRIMARY KEY(tenant_id, source_id)
     )`,
    `CREATE TABLE IF NOT EXISTS address_source_cache (
       tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
       source_id TEXT NOT NULL,
       cache_key TEXT NOT NULL,
       payload_json TEXT NOT NULL,
       partial INTEGER NOT NULL DEFAULT 0,
       created_at TEXT NOT NULL,
       expires_at TEXT NOT NULL,
       PRIMARY KEY(tenant_id, source_id, cache_key)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_address_source_cache_expiry ON address_source_cache(expires_at)`,
    `CREATE TABLE IF NOT EXISTS address_source_uploads (
       id TEXT PRIMARY KEY,
       tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
       source_id TEXT NOT NULL,
       filename TEXT NOT NULL,
       format TEXT NOT NULL,
       content_hash TEXT NOT NULL,
       license_name TEXT,
       license_url TEXT,
       authoritative INTEGER NOT NULL DEFAULT 0,
       record_count INTEGER NOT NULL DEFAULT 0,
       rejected_count INTEGER NOT NULL DEFAULT 0,
       created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
       created_at TEXT NOT NULL DEFAULT (datetime('now')),
       UNIQUE(tenant_id, content_hash)
     )`,
    `CREATE TABLE IF NOT EXISTS uploaded_address_records (
       id TEXT PRIMARY KEY,
       upload_id TEXT NOT NULL REFERENCES address_source_uploads(id) ON DELETE CASCADE,
       tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
       source_id TEXT NOT NULL,
       source_record_id TEXT NOT NULL,
       authoritative INTEGER NOT NULL DEFAULT 0,
       full_address TEXT NOT NULL,
       city TEXT,
       state TEXT,
       postal_code TEXT,
       lat REAL,
       lng REAL,
       raw_json TEXT NOT NULL,
       created_at TEXT NOT NULL DEFAULT (datetime('now')),
       UNIQUE(upload_id, source_record_id)
     )`,
    `ALTER TABLE address_source_uploads ADD COLUMN authoritative INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE uploaded_address_records ADD COLUMN authoritative INTEGER NOT NULL DEFAULT 0`,
    `CREATE INDEX IF NOT EXISTS idx_uploaded_addresses_point ON uploaded_address_records(tenant_id, lat, lng)`,
    // Legacy scan_targets still has a historical UNIQUE(address) constraint.
    // canonical_key documents the collision-safe identity used by discovery; a
    // handoff collision is surfaced as partial instead of attaching the wrong
    // city's address to a qualification run.
    `ALTER TABLE scan_targets ADD COLUMN canonical_key TEXT`,
    `CREATE INDEX IF NOT EXISTS idx_scan_targets_canonical ON scan_targets(tenant_id, canonical_key)`,
    // leads.canonical_key: the durable, DB-enforced identity that makes duplicate
    // pins structurally impossible. Populated on every insert from the SAME
    // normalizeKineticAddressKey used by scan_targets, so "338 Farrell Road" and
    // "338 FARRELL RD" collapse to one lead. The UNIQUE index is created LATER,
    // inside migrateLeadsCanonicalKey(), only AFTER existing dupes are merged
    // (a UNIQUE index over still-duplicated rows would fail).
    `ALTER TABLE leads ADD COLUMN canonical_key TEXT`,

    // ── Fiber operations control plane ─────────────────────────────────────
    // Additive companions around scan_runs: the existing worker remains the
    // single execution engine while these tables make its state observable,
    // replayable and diagnosable across deploys and process crashes.
    `ALTER TABLE scan_runs ADD COLUMN provider TEXT NOT NULL DEFAULT 'kinetic'`,
    `ALTER TABLE scan_runs ADD COLUMN correlation_id TEXT`,
    `ALTER TABLE scan_runs ADD COLUMN current_checkpoint TEXT`,
    `ALTER TABLE scan_runs ADD COLUMN stop_requested_at TEXT`,
    `ALTER TABLE scan_runs ADD COLUMN updated_at TEXT`,
    `ALTER TABLE scan_run_targets ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE scan_run_targets ADD COLUMN next_attempt_at TEXT`,
    `ALTER TABLE scan_run_targets ADD COLUMN last_error_category TEXT`,
    `ALTER TABLE scan_run_targets ADD COLUMN last_error_message TEXT`,
    `CREATE TABLE IF NOT EXISTS fiber_job_events (
       sequence INTEGER PRIMARY KEY AUTOINCREMENT,
       tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
       run_id TEXT NOT NULL REFERENCES scan_runs(id) ON DELETE CASCADE,
       event_type TEXT NOT NULL,
       target_id INTEGER,
       correlation_id TEXT,
       payload_json TEXT NOT NULL DEFAULT '{}',
       created_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
    `CREATE INDEX IF NOT EXISTS idx_fiber_events_stream ON fiber_job_events(tenant_id, sequence)`,
    `CREATE INDEX IF NOT EXISTS idx_fiber_events_run ON fiber_job_events(tenant_id, run_id, sequence)`,
    `CREATE TABLE IF NOT EXISTS fiber_worker_heartbeats (
       worker_id TEXT PRIMARY KEY,
       tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
       run_id TEXT REFERENCES scan_runs(id) ON DELETE SET NULL,
       status TEXT NOT NULL,
       concurrency INTEGER NOT NULL DEFAULT 0,
       last_error TEXT,
       metadata_json TEXT NOT NULL DEFAULT '{}',
       started_at TEXT NOT NULL DEFAULT (datetime('now')),
       heartbeat_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
    `CREATE INDEX IF NOT EXISTS idx_fiber_worker_health ON fiber_worker_heartbeats(heartbeat_at DESC)`,
    `CREATE TABLE IF NOT EXISTS fiber_job_failures (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
       run_id TEXT NOT NULL REFERENCES scan_runs(id) ON DELETE CASCADE,
       target_id INTEGER,
       category TEXT NOT NULL,
       message TEXT NOT NULL,
       attempt INTEGER NOT NULL DEFAULT 1,
       retryable INTEGER NOT NULL DEFAULT 1,
       correlation_id TEXT,
       created_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
    `CREATE INDEX IF NOT EXISTS idx_fiber_failures_run ON fiber_job_failures(tenant_id, run_id, created_at DESC)`,
    `CREATE TABLE IF NOT EXISTS fiber_dead_letters (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
       run_id TEXT NOT NULL REFERENCES scan_runs(id) ON DELETE CASCADE,
       target_id INTEGER,
       category TEXT NOT NULL,
       message TEXT NOT NULL,
       attempts INTEGER NOT NULL,
       payload_json TEXT NOT NULL DEFAULT '{}',
       resolved_at TEXT,
       resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
       created_at TEXT NOT NULL DEFAULT (datetime('now')),
       UNIQUE(run_id, target_id)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_fiber_dead_letters_open ON fiber_dead_letters(tenant_id, resolved_at, created_at DESC)`,
    `CREATE TABLE IF NOT EXISTS fiber_job_checkpoints (
       run_id TEXT PRIMARY KEY REFERENCES scan_runs(id) ON DELETE CASCADE,
       tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
       last_sequence INTEGER NOT NULL DEFAULT 0,
       completed_targets INTEGER NOT NULL DEFAULT 0,
       checkpoint_json TEXT NOT NULL DEFAULT '{}',
       updated_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
    `CREATE TABLE IF NOT EXISTS provider_adapter_configs (
       tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
       provider TEXT NOT NULL,
       enabled INTEGER NOT NULL DEFAULT 0,
       display_name TEXT NOT NULL,
       mode TEXT NOT NULL DEFAULT 'authorized_http',
       rate_limit_per_minute INTEGER NOT NULL DEFAULT 30,
       health_status TEXT NOT NULL DEFAULT 'unknown',
       consecutive_failures INTEGER NOT NULL DEFAULT 0,
       last_success_at TEXT,
       last_failure_at TEXT,
       last_error TEXT,
       updated_at TEXT NOT NULL DEFAULT (datetime('now')),
       PRIMARY KEY(tenant_id, provider)
     )`,
    `CREATE TABLE IF NOT EXISTS fiber_freshness_scores (
       tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
       scan_target_id INTEGER NOT NULL REFERENCES scan_targets(id) ON DELETE CASCADE,
       score INTEGER NOT NULL,
       verification_state TEXT NOT NULL,
       formula_version TEXT NOT NULL,
       factors_json TEXT NOT NULL,
       explanation_json TEXT NOT NULL,
       calculated_at TEXT NOT NULL DEFAULT (datetime('now')),
       PRIMARY KEY(tenant_id, scan_target_id)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_fiber_freshness_rank ON fiber_freshness_scores(tenant_id, score DESC, calculated_at DESC)`,
    // ── Explicit address lifecycle ────────────────────────────────────────────
    // Durable per-address lifecycle written ONLY from CONCLUSIVE provider answers
    // by the ONE snapshot writer (server/availabilitySnapshot.ts). States:
    // UNAVAILABLE, COMING_SOON, NEWLY_LIT, FRESH_LEAD, STILL_FRESH, AGED.
    // lifecycle_changed_at is canonical EPOCH MILLISECONDS (INTEGER) — same
    // lesson as availability_snapshots.checked_at_epoch: never a sortable-maybe
    // text timestamp. It records when the state was last set OR re-affirmed by a
    // conclusive check (AGED = FRESH/STILL_FRESH not re-affirmed in N days).
    `ALTER TABLE scan_targets ADD COLUMN lifecycle_state TEXT`,
    `ALTER TABLE scan_targets ADD COLUMN lifecycle_changed_at INTEGER`,
    `CREATE INDEX IF NOT EXISTS idx_scan_targets_lifecycle ON scan_targets(lifecycle_state, lifecycle_changed_at)`,
    // ── Carrier dimension ─────────────────────────────────────────────────────
    // 'kinetic' (default) | 'frontier'. Frontier targets route to the Frontier
    // serviceability scanner and publish RED leads (Kinetic = green).
    `ALTER TABLE scan_targets ADD COLUMN carrier TEXT NOT NULL DEFAULT 'kinetic'`,
    `ALTER TABLE leads ADD COLUMN carrier TEXT NOT NULL DEFAULT 'kinetic'`,
    `CREATE INDEX IF NOT EXISTS idx_scan_targets_carrier_city ON scan_targets(carrier, lower(city), state)`,
    // The city/state join WITHOUT the carrier prefix. `syncMarketState` and
    // `listMarkets` (server/stateMonitorStore.ts) join scan_targets to
    // state_fiber_markets on `lower(s.city)=lower(m.city) AND s.state=m.state`
    // and never mention carrier, so the index above cannot be seeked — carrier
    // has two distinct values and is the leading column. Without this, each of
    // the seven correlated subqueries in syncMarketState's UPDATE walks all
    // ~474k rows once per market row (483 of them), and the NOT EXISTS branches
    // hit the worst case: a full scan to prove absence.
    // Measured on a 476k-row copy of live data (2026-08-07):
    //   no index                      170,829 ms   2 full SCANs + 2 wrong-index seeks
    //   (lower(city), state)              153 ms   SEARCH ... USING INDEX      (10.1 MB)
    //   + the four read columns             41 ms   SEARCH ... USING COVERING INDEX (12.7 MB)
    // The narrow index wins ~1,100x on its own; the extra four columns are what
    // make the plan COVERING, removing one table lookup per matching row for a
    // further ~3.7x at +2.6 MB. Both are kept: the narrow one is load-bearing
    // for other city/state lookups, and dropping it is a separate decision.
    `CREATE INDEX IF NOT EXISTS idx_scan_targets_city_state ON scan_targets(lower(city), state)`,
    `CREATE INDEX IF NOT EXISTS idx_scan_targets_market_sync ON scan_targets(lower(city), state, last_scanned_at, last_is_new_fiber, first_seen_fiber_at, first_seen_live_at)`,
    `ALTER TABLE scan_targets ADD COLUMN frontier_control TEXT`,
    `CREATE INDEX IF NOT EXISTS idx_scan_targets_frontier_control ON scan_targets(frontier_control)`,
    // ── Coming-Soon watchlist ─────────────────────────────────────────────────
    // One row per address the provider says is pre-launch (COMING SOON segment or
    // NEW FIBER + active billing — the existing scanner 'coming_soon' rule).
    // Upserted by the snapshot writer on every conclusive COMING_SOON answer;
    // consumed by server/comingSoonWatchlist.ts which rechecks rows on an urgency
    // cadence and marks them 'promoted' when the address flips live. Timestamps
    // are epoch ms. estimated_completion stays NULL unless the provider/new-build
    // radar actually supplied a date (kinetic_addresses.estimated_completion_date).
    `CREATE TABLE IF NOT EXISTS coming_soon_watchlist (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       tenant_id INTEGER NOT NULL,
       scan_target_id INTEGER NOT NULL UNIQUE,
       address_key TEXT NOT NULL,
       first_seen_at INTEGER NOT NULL,
       last_checked_at INTEGER,
       estimated_completion TEXT,
       source TEXT,
       confidence TEXT,
       cluster_id TEXT,
       status TEXT NOT NULL DEFAULT 'active',
       created_at INTEGER NOT NULL,
       updated_at INTEGER NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS idx_coming_soon_watch_tenant ON coming_soon_watchlist(tenant_id, status, last_checked_at)`,
    `CREATE INDEX IF NOT EXISTS idx_coming_soon_watch_due ON coming_soon_watchlist(status, last_checked_at)`,

    // ── Ready-to-Call workspace ────────────────────────────────────────────────
    // Calling consent is distinct from knocking consent (a Do-Not-Call is not a
    // Do-Not-Knock), so calling gets its own flag. last_call_* let the queue put
    // never-called leads first and drop terminally-dispositioned ones.
    `ALTER TABLE leads ADD COLUMN do_not_call INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE leads ADD COLUMN last_call_outcome TEXT`,
    `ALTER TABLE leads ADD COLUMN last_call_at TEXT`,
    // Phone dispositions live in their OWN log (never the knock/commission path).
    // client_id is the idempotency key — a double-tap or two-tab replay collapses.
    `CREATE TABLE IF NOT EXISTS call_log (
       id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL, lead_id INTEGER NOT NULL,
       rep_id INTEGER, user_id INTEGER, outcome TEXT NOT NULL, notes TEXT,
       callback_date TEXT, callback_time TEXT, dialed_e164 TEXT, client_id TEXT,
       created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_call_log_client ON call_log(tenant_id, client_id) WHERE client_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_call_log_lead ON call_log(tenant_id, lead_id, created_at DESC)`,
    // Advisory soft-lock so two reps don't unknowingly dial the same lead. TTL
    // lease (INSERT OR IGNORE winner-gating); a stuck holder self-clears at expiry.
    `CREATE TABLE IF NOT EXISTS calling_lead_locks (
       tenant_id INTEGER NOT NULL, lead_id INTEGER NOT NULL, owner_user_id INTEGER NOT NULL,
       owner_name TEXT, expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
       version INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (tenant_id, lead_id))`,
    `CREATE INDEX IF NOT EXISTS idx_calling_locks_exp ON calling_lead_locks(expires_at)`,

    // ── Training progress — D2D psychology & pitch curriculum ─────────────────
    // One row per (tenant, user, lesson). Lesson ids are authored in
    // shared/trainingContent.ts and validated by the route before any write.
    // tenant_id is normalized to 0 for legacy users with no tenant, so the
    // UNIQUE constraint (NULLs are distinct in SQLite) can never double-count.
    `CREATE TABLE IF NOT EXISTS training_progress (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       tenant_id INTEGER NOT NULL DEFAULT 0,
       user_id INTEGER NOT NULL,
       lesson_id TEXT NOT NULL,
       completed_at TEXT NOT NULL DEFAULT (datetime('now')),
       quiz_score INTEGER,
       UNIQUE(tenant_id, user_id, lesson_id))`,
    `CREATE INDEX IF NOT EXISTS idx_training_progress_user ON training_progress(tenant_id, user_id)`,

    // ── PAY-A2: contractor pay plane (banking, W-9, company DFI profile) ──────
    // APPEND-ONLY at the END of this list to minimize merge conflicts with
    // sibling pay lanes. Secrets live in *_enc columns as AES-256-GCM
    // ciphertext (server/payCrypto.ts); only last4-style masks are plaintext.
    `CREATE TABLE IF NOT EXISTS rep_bank_details (
       rep_id INTEGER PRIMARY KEY,
       tenant_id INTEGER NOT NULL,
       routing_enc TEXT NOT NULL,
       account_enc TEXT NOT NULL,
       account_type TEXT NOT NULL,
       last4 TEXT NOT NULL,
       status TEXT NOT NULL DEFAULT 'active',
       created_at TEXT NOT NULL DEFAULT (datetime('now')),
       updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE INDEX IF NOT EXISTS idx_rep_bank_details_tenant ON rep_bank_details(tenant_id)`,
    `CREATE TABLE IF NOT EXISTS w9_forms (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       tenant_id INTEGER NOT NULL,
       rep_id INTEGER NOT NULL,
       legal_name TEXT NOT NULL,
       business_name TEXT,
       address_line1 TEXT NOT NULL,
       city TEXT NOT NULL,
       state TEXT NOT NULL,
       zip TEXT NOT NULL,
       tin_enc TEXT NOT NULL,
       tin_type TEXT NOT NULL,
       signature_name TEXT NOT NULL,
       signature_date TEXT NOT NULL,
       signature_ip TEXT,
       signature_ua TEXT,
       consent INTEGER NOT NULL DEFAULT 0,
       pdf_path TEXT,
       created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE INDEX IF NOT EXISTS idx_w9_forms_rep ON w9_forms(tenant_id, rep_id)`,
    // W-9 hardening. These MUST exist in the raw DDL as well as shared/schema.ts
    // — a Drizzle-only column does not exist at runtime. ALTERs are idempotent
    // here (the "duplicate column" swallow below) so both a fresh CREATE above
    // and an already-deployed table converge on the same shape.
    // Line 3a: the signer's real federal tax classification. 'individual' is the
    // backfill for rows written before the classification was captured — it is
    // what those PDFs actually assert.
    `ALTER TABLE w9_forms ADD COLUMN tax_classification TEXT NOT NULL DEFAULT 'individual'`,
    `ALTER TABLE w9_forms ADD COLUMN llc_tax_class TEXT`,
    `ALTER TABLE w9_forms ADD COLUMN other_classification TEXT`,
    `ALTER TABLE w9_forms ADD COLUMN foreign_partners INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE w9_forms ADD COLUMN exempt_payee_code TEXT`,
    `ALTER TABLE w9_forms ADD COLUMN fatca_exemption_code TEXT`,
    `ALTER TABLE w9_forms ADD COLUMN account_numbers TEXT`,
    // Part II item 2 — struck on the PDF when 1; surfaced on the W-9 status so
    // the pay lane can flag the rep for 24% backup withholding.
    `ALTER TABLE w9_forms ADD COLUMN subject_to_backup_withholding INTEGER NOT NULL DEFAULT 0`,
    // What was PRINTED when a non-Latin legal name had to be transliterated.
    `ALTER TABLE w9_forms ADD COLUMN rendered_names TEXT`,
    `CREATE TABLE IF NOT EXISTS company_profile (
       tenant_id INTEGER PRIMARY KEY,
       legal_name TEXT NOT NULL,
       ein_enc TEXT NOT NULL,
       dfi_account_enc TEXT NOT NULL,
       dfi_routing TEXT NOT NULL,
       company_id TEXT NOT NULL,
       updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,

    // ══ CHARGEBACK RESERVE ══════════════════════════════════════════════════════
    // Per-rep overrides of the org reserve policy. BOTH nullable — NULL means
    // "inherit the org default", which every pre-existing row is, so no rep's pay
    // changes until an admin sets one. (Drizzle-only columns don't exist at
    // runtime; these ALTERs are what actually create them.)
    `ALTER TABLE team_members ADD COLUMN reserve_percent INTEGER`,
    `ALTER TABLE team_members ADD COLUMN reserve_cap_cents INTEGER`,
    // The FULL agreed comp structure (JSON CommissionTerms — rate or tier
    // ladder plus the reserve fields), stored when the paperwork is sent so the
    // agreement a rep signed and the plan the portal pays them under are the
    // same object. The two reserve columns above predate it and stay
    // authoritative for their own fields, so an existing override is never
    // silently dropped. NULL = nothing agreed yet; inherit.
    `ALTER TABLE team_members ADD COLUMN commission_terms TEXT`,
    // ── RECRUITING SPONSOR EDGE — IMMUTABLE ─────────────────────────────────
    // Who recruited this member, set ONCE at approval from invite.invited_by.
    // Distinct from reports_to_id, which is OPERATIONAL — mutable, re-homed on
    // offboard/demotion. The sponsor edge is recruiting metrics only; pay
    // follows the reports_to tree, never this. Both ids kept: the recruiter's
    // login always exists (invited_by), their roster row may not.
    `ALTER TABLE team_members ADD COLUMN recruited_by_member_id INTEGER`,
    `ALTER TABLE team_members ADD COLUMN recruited_by_user_id INTEGER`,
    `ALTER TABLE team_members ADD COLUMN recruited_at TEXT`,
    // Set-once, enforced by the DATABASE (the signed-document precedent): the
    // NULL → value write passes, any later re-point is refused no matter which
    // code path — present or future — attempts it. Approval retries are also
    // WHERE-guarded in the route, so they never even reach this trigger.
    `CREATE TRIGGER IF NOT EXISTS trg_team_members_recruiter_immutable
       BEFORE UPDATE ON team_members
       WHEN (OLD.recruited_by_member_id IS NOT NULL AND NEW.recruited_by_member_id IS NOT OLD.recruited_by_member_id)
         OR (OLD.recruited_by_user_id IS NOT NULL AND NEW.recruited_by_user_id IS NOT OLD.recruited_by_user_id)
       BEGIN SELECT RAISE(ABORT, 'the recruiting sponsor edge is immutable'); END`,
    // Per-SELLER override rates: what the team-lead / manager slots keep from
    // each of THIS member's qualified sales, chosen at invite time (or edited
    // later). NULL = inherit the org default. Resolved per sale by the
    // override engine; already-earned rows keep their frozen snapshot.
    `ALTER TABLE team_members ADD COLUMN override_team_lead_cents INTEGER`,
    `ALTER TABLE team_members ADD COLUMN override_manager_cents INTEGER`,
    // Org-level ceiling. NULL → the product default ($2,500); 0 → uncapped.
    `ALTER TABLE tenants ADD COLUMN commission_reserve_cap_cents INTEGER`,

    // The append-only reserve ledger — the ONE source of truth for a balance.
    // Balance = SUM(amount_cents) in SQL. holds are positive; drawdowns and
    // releases are negative. Nothing here is ever UPDATEd or DELETEd.
    `CREATE TABLE IF NOT EXISTS reserve_entries (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       tenant_id INTEGER NOT NULL,
       rep_id INTEGER NOT NULL,
       kind TEXT NOT NULL CHECK (kind IN ('hold','drawdown','release')),
       amount_cents INTEGER NOT NULL,
       statement_id INTEGER,
       week_start_utc TEXT,
       week_label TEXT,
       reason TEXT NOT NULL,
       actor_user_id INTEGER,
       created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE INDEX IF NOT EXISTS idx_reserve_entries_rep ON reserve_entries(tenant_id, rep_id, id)`,
    // IDEMPOTENT WEEKLY HOLD: at most ONE hold per (tenant, rep, week). This is
    // what makes recalculating / re-finalizing a statement unable to double-hold
    // — the second insert hits this index and is ignored, not applied twice.
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_reserve_entries_hold_week
       ON reserve_entries(tenant_id, rep_id, week_start_utc) WHERE kind = 'hold'`,
    // Append-only, enforced in the DB (same pattern as consent_records /
    // internal DNC in server/calling/migrations.ts): no code path — present or
    // future, app or console — can rewrite a rep's reserve history. Corrections
    // are new rows.
    `CREATE TRIGGER IF NOT EXISTS trg_reserve_entries_no_update
       BEFORE UPDATE ON reserve_entries
       BEGIN SELECT RAISE(ABORT,'reserve_entries_are_append_only'); END`,
    `CREATE TRIGGER IF NOT EXISTS trg_reserve_entries_no_delete
       BEFORE DELETE ON reserve_entries
       BEGIN SELECT RAISE(ABORT,'reserve_entries_are_append_only'); END`,
    // Sign + type discipline: money is INTEGER cents, a hold can only add, a
    // drawdown/release can only subtract, and no entry may be zero. A wrong-signed
    // row would silently invert a balance, so it can never be written at all.
    `CREATE TRIGGER IF NOT EXISTS trg_reserve_entries_amount_sign
       BEFORE INSERT ON reserve_entries
       WHEN typeof(NEW.amount_cents) <> 'integer'
         OR NEW.amount_cents = 0
         OR (NEW.kind = 'hold' AND NEW.amount_cents < 0)
         OR (NEW.kind IN ('drawdown','release') AND NEW.amount_cents > 0)
         OR length(trim(COALESCE(NEW.reason,''))) = 0
       BEGIN SELECT RAISE(ABORT,'reserve_entry_amount_or_reason_invalid'); END`,

    // ══ HOURLY PAY (Sequifi-style hybrid hourly+commission) — additive ════════
    // The rep's CURRENT hourly rate (integer cents/hour). NULL = commission-only.
    // effective_from gates which weeks it governs (a week's rate is the one
    // effective at week start); prior rates are reconstructed from the
    // 'pay.hourly_rate.changed' audit events.
    `ALTER TABLE team_members ADD COLUMN hourly_rate_cents INTEGER`,
    `ALTER TABLE team_members ADD COLUMN hourly_rate_effective_from TEXT`,
    // Append-only manager corrections to recorded time — clock_sessions raw rows
    // are NEVER edited. minutes_delta is signed and day-attributed (session's
    // clock-in day when session_id set, else created_at day) so the hours
    // aggregation can floor at 0/day and flag >16h days.
    `CREATE TABLE IF NOT EXISTS punch_corrections (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL, rep_id INTEGER NOT NULL, session_id INTEGER, kind TEXT NOT NULL, minutes_delta INTEGER NOT NULL, reason TEXT NOT NULL, actor_user_id INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE INDEX IF NOT EXISTS idx_punch_corrections_rep ON punch_corrections(tenant_id, rep_id, created_at)`,
    // Rep-facing pay disputes + manager queue. One disputed line per row;
    // 'adjusted' resolutions reference an existing commission_adjustments row.
    `CREATE TABLE IF NOT EXISTS pay_disputes (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL, rep_id INTEGER NOT NULL, week_start TEXT NOT NULL, line_kind TEXT NOT NULL, commission_id INTEGER, message TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', resolution TEXT, resolution_note TEXT, adjustment_id INTEGER, resolved_by INTEGER, idem_key TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), resolved_at TEXT)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_pay_disputes_idem ON pay_disputes(tenant_id, idem_key) WHERE idem_key IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_pay_disputes_tenant ON pay_disputes(tenant_id, status, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_pay_disputes_rep ON pay_disputes(tenant_id, rep_id, week_start)`,
    // The disputed commission's status BEFORE the dispute opened — an 'upheld'
    // resolution restores it through the lifecycle planner (no stranded rows).
    `ALTER TABLE pay_disputes ADD COLUMN commission_prev_status TEXT`,
    // Hourly block persisted on the weekly statement (computed at generation
    // with the rate effective at week start; recompute is truthful/idempotent).
    `ALTER TABLE commission_statements ADD COLUMN hourly_minutes INTEGER`,
    `ALTER TABLE commission_statements ADD COLUMN hourly_rate_cents INTEGER`,
    `ALTER TABLE commission_statements ADD COLUMN hourly_pay_cents INTEGER NOT NULL DEFAULT 0`,

    // ── PAY-A2: contractor pay plane (banking, W-9, company DFI profile) ──────
    // APPEND-ONLY at the END of this list to minimize merge conflicts with
    // sibling pay lanes. Secrets live in *_enc columns as AES-256-GCM
    // ciphertext (server/payCrypto.ts); only last4-style masks are plaintext.
    `CREATE TABLE IF NOT EXISTS rep_bank_details (
       rep_id INTEGER PRIMARY KEY,
       tenant_id INTEGER NOT NULL,
       routing_enc TEXT NOT NULL,
       account_enc TEXT NOT NULL,
       account_type TEXT NOT NULL,
       last4 TEXT NOT NULL,
       status TEXT NOT NULL DEFAULT 'active',
       created_at TEXT NOT NULL DEFAULT (datetime('now')),
       updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE INDEX IF NOT EXISTS idx_rep_bank_details_tenant ON rep_bank_details(tenant_id)`,
    `CREATE TABLE IF NOT EXISTS w9_forms (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       tenant_id INTEGER NOT NULL,
       rep_id INTEGER NOT NULL,
       legal_name TEXT NOT NULL,
       business_name TEXT,
       address_line1 TEXT NOT NULL,
       city TEXT NOT NULL,
       state TEXT NOT NULL,
       zip TEXT NOT NULL,
       tin_enc TEXT NOT NULL,
       tin_type TEXT NOT NULL,
       signature_name TEXT NOT NULL,
       signature_date TEXT NOT NULL,
       signature_ip TEXT,
       signature_ua TEXT,
       consent INTEGER NOT NULL DEFAULT 0,
       pdf_path TEXT,
       created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE INDEX IF NOT EXISTS idx_w9_forms_rep ON w9_forms(tenant_id, rep_id)`,
    `CREATE TABLE IF NOT EXISTS company_profile (
       tenant_id INTEGER PRIMARY KEY,
       legal_name TEXT NOT NULL,
       ein_enc TEXT NOT NULL,
       dfi_account_enc TEXT NOT NULL,
       dfi_routing TEXT NOT NULL,
       company_id TEXT NOT NULL,
       updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,

    // ── CE-1 drill engine: card state + review log ───────────────────────────
    // APPEND-ONLY at the END of this list to minimize merge conflicts with
    // sibling lanes. Card ids come from shared/trainingCards.ts and are
    // validated at the route before any write (same anti-junk rule as
    // training_progress lesson ids). tenant_id is normalized to 0 for legacy
    // users, matching the training_progress convention.
    // One row per (tenant, user, card): the rep's ladder position.
    `CREATE TABLE IF NOT EXISTS training_card_state (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       tenant_id INTEGER NOT NULL DEFAULT 0,
       user_id INTEGER NOT NULL,
       card_id TEXT NOT NULL,
       rung INTEGER NOT NULL DEFAULT 0,
       due_at TEXT,
       last_grade TEXT,
       reps INTEGER NOT NULL DEFAULT 0,
       lapses INTEGER NOT NULL DEFAULT 0,
       updated_at TEXT NOT NULL DEFAULT (datetime('now')),
       UNIQUE(tenant_id, user_id, card_id))`,
    `CREATE INDEX IF NOT EXISTS idx_training_card_state_due
       ON training_card_state(tenant_id, user_id, due_at)`,
    // Append-only event log: powers the streak computation and the debrief.
    // reviewed_at is the CLIENT clock (offline reviews keep their real time;
    // the server never rewrites it); the dedupe index makes a replayed batch
    // harmless — same card + same reviewed_at inserts once.
    `CREATE TABLE IF NOT EXISTS training_review_log (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       tenant_id INTEGER NOT NULL DEFAULT 0,
       user_id INTEGER NOT NULL,
       card_id TEXT NOT NULL,
       grade TEXT NOT NULL,
       rung_before INTEGER NOT NULL,
       rung_after INTEGER NOT NULL,
       reviewed_at TEXT NOT NULL,
       created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE INDEX IF NOT EXISTS idx_training_review_log_user
       ON training_review_log(tenant_id, user_id, reviewed_at)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_training_review_log_dedupe
       ON training_review_log(tenant_id, user_id, card_id, reviewed_at)`,

    // ══ ONBOARD INTEGRATOR: company counter-sign graft + install-gated ═══════
    // ══ commission hold — additive ALTERs, guarded trigger replacement. ══════
    //
    // Install-gated commission hold: NULL/NULL = held (when the tenant policy
    // requires install confirmation). Status stays 'pending' — the installHold
    // flag is computed at read time (shared/commissionHold.ts), never a new
    // lifecycle status.
    `ALTER TABLE commissions ADD COLUMN install_confirmed_at TEXT`,
    `ALTER TABLE commissions ADD COLUMN payable_after TEXT`,
    // Per-tenant pay policy knobs (absent row = defaults: require install
    // confirm, 90-day hold).
    `CREATE TABLE IF NOT EXISTS tenant_pay_policy (
       tenant_id INTEGER PRIMARY KEY,
       require_install_confirm INTEGER NOT NULL DEFAULT 1,
       hold_days INTEGER NOT NULL DEFAULT 90,
       updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    // Company counter-signature on the EXISTING signing chain. The rep's
    // signature still completes the document (status 'completed'); completion
    // now also flips counter_sign_status 'none' → 'pending', which queues the
    // document for a manager's company counter-signature (→ 'completed').
    // GRANDFATHERING: rows completed before this deploy keep the 'none'
    // default and behave exactly as before — they never enter the queue and
    // cannot be counter-signed (they were fully executed under the
    // then-current single-party ceremony).
    `ALTER TABLE onboarding_signing_documents ADD COLUMN company_signer_user_id INTEGER`,
    `ALTER TABLE onboarding_signing_documents ADD COLUMN company_signature_name TEXT`,
    `ALTER TABLE onboarding_signing_documents ADD COLUMN company_signed_at TEXT`,
    `ALTER TABLE onboarding_signing_documents ADD COLUMN counter_sign_status TEXT NOT NULL DEFAULT 'none'
       CHECK (counter_sign_status IN ('none','pending','completed'))`,
    `CREATE INDEX IF NOT EXISTS idx_signing_doc_counter_queue
       ON onboarding_signing_documents(tenant_id, counter_sign_status, completed_at)
       WHERE counter_sign_status = 'pending'`,
    // The immutability trigger must be REPLACED, not just created-if-missing:
    // existing DBs already carry the original predicate, and CREATE TRIGGER IF
    // NOT EXISTS would silently keep it. The counter-sign write (company
    // columns + the dual-stamped PDF) is the SOLE post-completion mutation the
    // new predicate permits — every rep-side evidence column stays frozen
    // unconditionally. See the full rationale on the trigger body itself.
    `DROP TRIGGER IF EXISTS trg_onboarding_signed_document_immutable`,
    `CREATE TRIGGER trg_onboarding_signed_document_immutable
       BEFORE UPDATE ON onboarding_signing_documents
       WHEN OLD.status = 'completed' AND (
         -- Rep-side evidence: frozen forever, no exceptions.
            NEW.status IS NOT OLD.status
         OR NEW.completed_at IS NOT OLD.completed_at
         OR NEW.evidence_json IS NOT OLD.evidence_json
         OR NEW.content_sha256 IS NOT OLD.content_sha256
         OR NEW.signature_sha256 IS NOT OLD.signature_sha256
         OR NEW.document_snapshot_json IS NOT OLD.document_snapshot_json
         OR NEW.signature_name IS NOT OLD.signature_name
         OR NEW.signature_typed_name IS NOT OLD.signature_typed_name
         OR (
           -- The completed PDF and the counter-sign columns may change
           -- post-completion ONLY as the single counter-sign transition
           -- ('pending' → 'completed', company fields NULL → set, dual-stamped
           -- PDF present). Any other write to them aborts.
              NEW.completed_pdf IS NOT OLD.completed_pdf
           OR NEW.completed_pdf_sha256 IS NOT OLD.completed_pdf_sha256
           OR NEW.counter_sign_status IS NOT OLD.counter_sign_status
           OR NEW.company_signer_user_id IS NOT OLD.company_signer_user_id
           OR NEW.company_signature_name IS NOT OLD.company_signature_name
           OR NEW.company_signed_at IS NOT OLD.company_signed_at
         ) AND NOT (
              OLD.counter_sign_status = 'pending'
           AND NEW.counter_sign_status = 'completed'
           AND OLD.company_signer_user_id IS NULL
           AND OLD.company_signature_name IS NULL
           AND OLD.company_signed_at IS NULL
           AND NEW.company_signer_user_id IS NOT NULL
           AND NEW.company_signature_name IS NOT NULL
           AND NEW.company_signed_at IS NOT NULL
           AND NEW.completed_pdf IS NOT NULL
           AND NEW.completed_pdf_sha256 IS NOT NULL
         )
       )
       BEGIN SELECT RAISE(ABORT, 'a completed onboarding signature is immutable'); END`,

    // One-time data-migration marks (see the guarded post-loop steps below —
    // e.g. the install-hold adoption, which must run exactly once per DB).
    `CREATE TABLE IF NOT EXISTS migration_marks (
       key TEXT PRIMARY KEY,
       applied_at TEXT NOT NULL)`,

    // ── DOWNLINE OVERRIDES — org config + statement fold columns ─────────────
    // The commission_overrides ledger itself self-creates in overrideStore.ts
    // (ensureOverrideSchema, the spiffStore pattern); these live here because
    // they extend EXISTING tables. Enabled by default but MONEY-dark: every
    // rate defaults to $0 and a $0 slot pays nobody, so no tenant's payroll
    // changes until someone sets a rate — in the console card, or per-hire on
    // an invite. The enabled flag stays as the org kill-switch. The *_bp
    // columns (basis points) are headroom for the PERCENT_OF_COMMISSION basis,
    // whose execution path is deliberately not built yet (validateOverridePatch
    // refuses it — the PROGRESSIVE tier-mode precedent).
    `ALTER TABLE tenants ADD COLUMN commission_override_enabled INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE tenants ADD COLUMN commission_override_basis TEXT NOT NULL DEFAULT 'FLAT_PER_SALE'`,
    `ALTER TABLE tenants ADD COLUMN commission_override_team_lead_cents INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE tenants ADD COLUMN commission_override_manager_cents INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE tenants ADD COLUMN commission_override_team_lead_bp INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE tenants ADD COLUMN commission_override_manager_bp INTEGER NOT NULL DEFAULT 0`,
    // Override block persisted on the weekly statement, exactly like hourly_*:
    // recomputed from the ledger on every calc, frozen at FINALIZE. Unlike
    // hourly it is INSIDE final_commission_cents (overrides are commission
    // money and must ride the ACH/1099/reserve rails); the dedicated columns
    // keep the CSV/PDF explainable and the no-op guard cheap.
    `ALTER TABLE commission_statements ADD COLUMN override_pay_cents INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE commission_statements ADD COLUMN override_item_count INTEGER NOT NULL DEFAULT 0`,
    // Frozen snapshot of the ledger rows inside a FINALIZED statement (mirrors
    // contributing_sales) so a locked week's drill-down stays truthful forever.
    `ALTER TABLE commission_statements ADD COLUMN contributing_overrides TEXT`,

  ];
  for (const stmt of stmts) {
    try { raw.exec(stmt); } catch (e: any) {
      if (!e.message?.includes("duplicate column") && !e.message?.includes("already exists")) {
        console.warn("Migration warning:", e.message);
      }
    }
  }
  // ── Install-hold adoption (one-time, guarded by migration_marks) ──────────
  // The install hold is default-ON for NEW sales (the owner's intent), but a
  // tenant's ALREADY-pending commissions must not silently freeze the moment
  // this ships: they were booked under the old payable-immediately contract.
  // So the FIRST boot after deploy stamps every pre-existing pending row with
  // install_confirmed_at = payable_after = created_at — released by
  // construction, payable exactly as it was. The migration_marks row freezes
  // the adoption instant on first boot (INSERT OR IGNORE no-ops after that),
  // and only rows created BEFORE it are released — commissions held after the
  // deploy keep their hold on every subsequent boot.
  try {
    raw.prepare("INSERT OR IGNORE INTO migration_marks (key, applied_at) VALUES ('install-hold.adopt.v1', ?)")
      .run(new Date().toISOString());
    const adoptMark = (raw.prepare("SELECT applied_at AS t FROM migration_marks WHERE key = 'install-hold.adopt.v1'").get() as any)?.t;
    if (adoptMark) {
      const released = raw.prepare(
        `UPDATE commissions
            SET install_confirmed_at = created_at, payable_after = created_at
          WHERE status = 'pending' AND install_confirmed_at IS NULL AND payable_after IS NULL
            AND replace(created_at, ' ', 'T') < ?`,
      ).run(adoptMark);
      if (released.changes) {
        console.log(`[migration] install-hold adoption: released ${released.changes} pre-existing pending commission(s)`);
      }
    }
  } catch (e: any) { console.warn("Migration warning (install-hold adoption):", e?.message); }

  // CHECK-constraint migration: tables created with state IN ('NC','SC') reject GA
  // rows, and SQLite can't alter a CHECK — rebuild any such table in place. The
  // new CREATE above is a no-op for existing DBs, so detect the old constraint
  // from sqlite_master and swap the table under a copy.
  for (const table of ["state_fiber_markets", "market_announcements"]) {
    try {
      const row = raw.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`).get(table) as any;
      if (row?.sql && row.sql.includes("CHECK(state IN ('NC','SC'))")) {
        const newSql = row.sql.replaceAll("CHECK(state IN ('NC','SC'))", "CHECK(state IN ('GA','NC','SC'))")
          .replace(`CREATE TABLE ${table}`, `CREATE TABLE ${table}_ga`);
        raw.transaction(() => {
          raw.exec(newSql);
          raw.exec(`INSERT INTO ${table}_ga SELECT * FROM ${table}`);
          raw.exec(`DROP TABLE ${table}`);
          raw.exec(`ALTER TABLE ${table}_ga RENAME TO ${table}`);
        })();
        console.log(`[migration] ${table}: rebuilt with GA in state CHECK`);
      }
    } catch (e: any) { console.warn(`Migration warning (${table} GA CHECK):`, e.message); }
  }
  // scan_targets UNIQUE(address) → UNIQUE(address, city, state). Dedups the
  // case/whitespace address variants first, so the new unique index can build.
  // HEAVY on large DBs (full table rebuild + 7 index builds): production defers
  // it via runDeferredMigrations() AFTER workers are up + healthy, so a slow
  // rebuild can never fail the deploy health gate again (observed live).
  if (process.env.DEFER_ADDR_UNIQUENESS_MIGRATION !== "on") {
    try { migrateScanTargetsAddressUniqueness(raw); }
    catch (e: any) { console.warn("[migration] scan_targets addr-city-state uniqueness:", e?.message); }
  }

  // Yield-rollup columns (street_key / neg_streak / generated cell cols) —
  // instant ADD COLUMNs only, inlined here like every other scan_targets
  // ALTER (a lazy require of yieldRollups breaks under the ESM transform, and
  // a static import would close an init-time module cycle). The heavy parts
  // (index builds, backfills) run POST-LISTEN in the primary's maintenance
  // loop (yieldRollups.ts), never here. The generated cells are EXACTLY the
  // ROUND(lat,2)/ROUND(lng,2) expressions the yield engine groups on.
  try {
    // table_xinfo, NOT table_info: plain table_info omits generated columns.
    const stCols = new Set(
      (raw.prepare(`PRAGMA table_xinfo(scan_targets)`).all() as Array<{ name: string }>).map((c) => c.name),
    );
    raw.exec(`CREATE TABLE IF NOT EXISTS yield_rollup_state (
      k TEXT PRIMARY KEY, v TEXT NOT NULL, updated_at INTEGER NOT NULL
    )`);
    if (!stCols.has("street_key")) raw.exec(`ALTER TABLE scan_targets ADD COLUMN street_key TEXT`);
    if (!stCols.has("address_review_reason")) raw.exec(`ALTER TABLE scan_targets ADD COLUMN address_review_reason TEXT`);
    if (!stCols.has("neg_streak")) raw.exec(`ALTER TABLE scan_targets ADD COLUMN neg_streak INTEGER NOT NULL DEFAULT 0`);
    if (!stCols.has("cell_lat")) raw.exec(`ALTER TABLE scan_targets ADD COLUMN cell_lat REAL GENERATED ALWAYS AS (ROUND(lat, 2)) VIRTUAL`);
    if (!stCols.has("cell_lng")) raw.exec(`ALTER TABLE scan_targets ADD COLUMN cell_lng REAL GENERATED ALWAYS AS (ROUND(lng, 2)) VIRTUAL`);
  } catch (e: any) { console.warn("[migration] yield rollup schema:", e?.message); }

  // Seed default commission rate if none exist
  try {
    const existing = raw.prepare("SELECT id FROM commission_rates LIMIT 1").get();
    if (!existing) {
      raw.prepare("INSERT INTO commission_rates (name, role, rate_per_sale, is_active) VALUES ('Standard Rep Rate', 'rep', 50.00, 1)").run();
      raw.prepare("INSERT INTO commission_rates (name, role, rate_per_sale, is_active) VALUES ('Team Lead Bonus', 'team_lead', 75.00, 1)").run();
    }
  } catch (_) {}

  // Duplicate-pin root fix: backfill canonical_key, MERGE existing duplicate
  // leads (preserving status history + child records), then add the UNIQUE index
  // so a duplicate can never be inserted again. Runs AFTER all column ALTERs.
  try { migrateLeadsCanonicalKey(raw); }
  catch (e: any) { console.warn("[migration] leads canonical_key merge failed:", e?.message); }

  // Competitive-eligibility backfill: suppress existing confirmed leads whose
  // stored competitor evidence now fails the Spectrum-only gate (a non-Kinetic
  // fiber competitor, or an unresolved competitor). Idempotent, tiny, boot-safe.
  try { backfillCompetitiveSuppression(raw); }
  catch (e: any) { console.warn("[migration] competitive suppression backfill:", e?.message); }

  // Kinetic-only NC/SC scope (owner directive 2026-07-23): suppress frontier-
  // carrier leads and out-of-footprint fresh leads from delivery — status flip
  // with lead_events audit, reversible, never deleted. SCOPE_KINETIC_NC_SC=off
  // skips (kill-switch; the map filter above is harmless either way).
  if (process.env.SCOPE_KINETIC_NC_SC !== "off") {
    try { backfillScopeSuppression(raw); }
    catch (e: any) { console.warn("[migration] scope suppression backfill:", e?.message); }
  }

  // ADDRESS_REVIEW backfill: existing leads whose identity is broken (no house
  // number, blank city/state, missing/invalid coordinates) leave the rep-ready
  // surfaces — status flip + audit, reversible, never deleted. Idempotent.
  try { backfillAddressReview(raw); }
  catch (e: any) { console.warn("[migration] address review backfill:", e?.message); }

  // Backfill territory_requests.tenant_id from the requesting rep's org. Runs
  // before tenant bootstrap adopts NULL rows, so a request lands in the SAME
  // tenant as its rep rather than being swept into the default org.
  try {
    raw.prepare(`UPDATE territory_requests SET tenant_id = (
      SELECT tm.tenant_id FROM team_members tm WHERE tm.id = territory_requests.rep_id
    ) WHERE tenant_id IS NULL`).run();
  } catch (e) { console.warn("[migration] territory_requests tenant backfill:", (e as any)?.message); }

  bootstrapDefaultTenant(raw);
  // GATE M6: a money invariant that can't build is a FAILED RELEASE, not a
  // quiet warning — the deploy health-gate rolls back instead of running
  // commission booking without its uniqueness guard.
  migrateCommissionsPendingDedupe(raw);

  // P0-1: stamp immutable super-admin identity from the env list (idempotent;
  // ONLY ever SETS the flag for listed emails and CLEARS it for unlisted ones
  // that were somehow stamped — identity comes from env+restart, never from a
  // mutable user row edit).
  try {
    const emails = (process.env.SUPER_ADMIN_EMAILS ?? "muizzm21@gmail.com")
      .split(",").map(e => e.trim().toLowerCase()).filter(Boolean);
    if (emails.length) {
      const placeholders = emails.map(() => "?").join(",");
      raw.prepare(`UPDATE users SET is_super_admin = 1 WHERE lower(email) IN (${placeholders})`).run(...emails);
      raw.prepare(`UPDATE users SET is_super_admin = 0 WHERE is_super_admin = 1 AND lower(email) NOT IN (${placeholders})`).run(...emails);
    }
  } catch (e: any) { console.warn("[migration] super-admin stamp:", e?.message); }

  // Admin history. Created through the normal migration path (IF NOT EXISTS +
  // append-only triggers) so a redeploy re-runs it and finds prior rows intact —
  // history surviving deployments is the whole point of the table.
  try {
    ensureAdminAuditSchema();
  } catch (e: any) { console.warn("[migration] admin audit schema:", e?.message); }

  // Kinetic 2026 builds: FCC vintage import staging + the per-address verdict
  // table. Lives in its own module (server/kineticBuildMigrations.ts) because
  // it is one self-contained transaction, the same way the calling schema is.
  // A failure here must not take the boot down — the feature is flagged off by
  // default and every read path treats a missing table as an empty layer.
  try {
    ensureKineticBuildSchema();
  } catch (e: any) { console.warn("[migration] kinetic build schema:", e?.message); }

  // Fiber Sales Academy: path activity progress, resume state, role-play
  // records, assignments and the market offer catalog. Own module for the same
  // reason as the kinetic schema above - one self-contained transaction - and
  // non-fatal for the same reason: every Academy read treats a missing table as
  // an empty result, so a failure here degrades the tab rather than the boot.
  try {
    ensureAcademySchema();
  } catch (e: any) { console.warn("[migration] academy schema:", e?.message); }

  // Live field operations: rep live state, per-org tracking policy, per-rep
  // consent, presence, and the additive columns location_pings should always
  // have carried. Non-fatal on the same terms as the two above - collection
  // ships OFF, so a failure here means the dashboard shows an empty board
  // rather than the boot failing. It must never mean location is collected
  // without the tables that record permission to collect it: every write path
  // checks policy and consent first and fails closed when they are unreadable.
  try {
    ensureLiveOpsSchema();
  } catch (e: any) { console.warn("[migration] live ops schema:", e?.message); }

  // Rep metrics and field performance: the daily rollups, the coaching insight
  // and note tables, the territory health rollup, the reclaim review audit, and
  // the door-arrival event that makes dwell time computable. Also the Field
  // Activity & Privacy columns on field_location_policy.
  //
  // Non-fatal on the same terms: every one of these is a REPORTING surface. A
  // failure here means the Metrics tab renders empty, never that a knock, a
  // shift, or a commission is lost - none of those write to any table created
  // in this module, which is exactly why the metrics layer was built on top of
  // the existing event tables rather than beside them.
  try {
    ensureRepMetricsSchema();
  } catch (e: any) { console.warn("[migration] rep metrics schema:", e?.message); }

  // Provider ORDER STATUS and recovery (PerfectVision "Total Submitted Orders
  // by Program", and any later carrier order feed): the import runs and their
  // rows, the order table and its immutable event stream, the recovery queue,
  // the outreach record, and the consent and suppression ledgers.
  //
  // Own module and own transaction, on the same terms as the planes above, and
  // non-fatal for a reason worth stating precisely: nothing in this plane can
  // send a message on its own. Messaging needs a process flag that ships off,
  // an organization-level approval, an approved template and a consent record,
  // so a missing table means an empty screen - never an unsupervised message.
  // The tables it needs in order to REFUSE (suppression, consent) are created
  // in the same transaction as the ones it needs in order to act, so there is
  // no state where the queue exists and the wall does not.
  try {
    ensureVendorOrderSchema();
  } catch (e: any) { console.warn("[migration] vendor order schema:", e?.message); }

  // The Commission File plane: provider-paid truth beside the order plane
  // above. Own module and transaction on the same terms, and non-fatal the
  // same way: a missing table here means an empty import screen and a
  // commission panel that keeps saying "no commission record yet" - money
  // never moves on this plane's say-so, so nothing unsafe can follow from
  // its absence.
  try {
    ensureCommissionFileSchema();
  } catch (e: any) { console.warn("[migration] commission file schema:", e?.message); }

  // The guarded-action gate: policy, the request queue, and the append-only
  // transition log behind it.
  //
  // Non-fatal on the same terms, and the failure mode is the safe one. The
  // whole plane is behind GUARDED_ACTIONS_ENABLED, which ships off, and every
  // route answers 404 without it. A missing table therefore means the approval
  // screen is unreachable - never that a write slips through ungated, because
  // with the flag down no call site routes through the gate in the first place.
  try {
    ensureGuardedActionSchema();
  } catch (e: any) { console.warn("[migration] guarded action schema:", e?.message); }
}

/**
 * P1-2 migration (ATOMIC — reviewer gate): dedupe pre-existing pending
 * commissions then build the uniqueness index in ONE transaction. A failed
 * index build rolls the dedupe back too (never a half-migrated invariant).
 * NULL tenant rows are coalesced to the default tenant (1) so they can't slip
 * the index (SQLite treats NULLs as distinct). Idempotent + re-runnable.
 */
function migrateCommissionsPendingDedupe(raw: import("better-sqlite3").Database): void {
  const tx = raw.transaction(() => {
    raw.prepare(
      `UPDATE commissions SET status = 'superseded'
        WHERE status = 'pending' AND lead_id IS NOT NULL
          AND id NOT IN (
            SELECT MAX(id) FROM commissions
             WHERE status = 'pending' AND lead_id IS NOT NULL
             GROUP BY COALESCE(tenant_id, 1), lead_id
          )`,
    ).run();
    raw.prepare(
      `UPDATE commissions SET tenant_id = COALESCE(tenant_id, 1)
        WHERE status = 'pending' AND lead_id IS NOT NULL AND tenant_id IS NULL`,
    ).run();
    raw.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_commissions_tenant_lead_pending
        ON commissions(tenant_id, lead_id) WHERE status = 'pending' AND lead_id IS NOT NULL`,
    );
    // The partial index above is UNIQUE and covers only status='pending', so it
    // cannot serve the double-pay guard, which asks "is there a live commission
    // on this door" across pending|approved|paid. Without this second, ordinary
    // index that lookup is a full scan of the tenant's ledger on every sold
    // knock — the cost grows with the money the company has ever earned, which
    // is the worst possible thing to put on the sale path.
    raw.exec(
      `CREATE INDEX IF NOT EXISTS idx_commissions_lead_status
        ON commissions(lead_id, status) WHERE lead_id IS NOT NULL`,
    );
    const idx = raw.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_commissions_tenant_lead_pending'",
    ).get();
    if (!idx) throw new Error("idx_commissions_tenant_lead_pending was NOT created");
  });
  tx.immediate();
}

// One-time-per-change, idempotent: re-evaluate confirmed fresh leads against the
// canonical competitive-eligibility classifier using their persisted competitor
// evidence, and retract (never delete) the ones that fail — so a fiber
// competitor or an ambiguous competitor leaves the rep map. Only touches leads
// that are still deliverable prospects (never sold / now_active / already
// suppressed). Re-runs cheaply once everything already matches.
function backfillCompetitiveSuppression(raw: import("better-sqlite3").Database): void {
  const cols = new Set((raw.prepare(`PRAGMA table_info(leads)`).all() as { name: string }[]).map(c => c.name));
  if (!cols.has("competitor_name") || !cols.has("lead_tag")) return;
  const rows = raw.prepare(
    `SELECT id, competitor_name, competitor_tech FROM leads
       WHERE lead_tag='fresh_fiber_confirmed'
         AND lead_status NOT IN ('sold','now_active','competitor_suppressed')`,
  ).all() as Array<{ id: number; competitor_name: string | null; competitor_tech: string | null }>;
  if (!rows.length) return;
  const suppress = raw.prepare(`UPDATE leads SET lead_status='competitor_suppressed', updated_at=datetime('now') WHERE id=?`);
  const hasEvents = !!raw.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='lead_events'`).get();
  const evt = hasEvents ? raw.prepare(`INSERT INTO lead_events (lead_id,type,actor,detail,at) VALUES (?,'status_change','Competitive Eligibility',?,datetime('now'))`) : null;
  let suppressed = 0;
  const tx = raw.transaction((list: typeof rows) => {
    for (const r of list) {
      const d = evaluateSingleCompetitor(r.competitor_name, r.competitor_tech).decision;
      if (d === "eligible") continue;
      suppress.run(r.id);
      evt?.run(r.id, JSON.stringify({ to: "competitor_suppressed", reason: d, competitor: r.competitor_name, competitorTech: r.competitor_tech }));
      suppressed++;
    }
  });
  tx(rows);
  if (suppressed > 0) console.log(`[migration] competitive suppression: retracted ${suppressed} lead(s) with a fiber/unresolved competitor`);
}

// Kinetic-only NC/SC delivery scope. Suppress (never delete) leads that are
// (a) frontier-carrier — any tag: frontier pins leave the map entirely — or
// (b) pipeline fresh leads outside NC/SC. Sold / now_active / already-
// suppressed leads are never touched. Reversal is a status flip guided by the
// lead_events audit rows this writes. Idempotent: suppressed rows no longer
// match the WHERE.
function backfillScopeSuppression(raw: import("better-sqlite3").Database): void {
  const cols = new Set((raw.prepare(`PRAGMA table_info(leads)`).all() as { name: string }[]).map(c => c.name));
  if (!cols.has("carrier") || !cols.has("lead_tag")) return;
  const rows = raw.prepare(
    `SELECT id, carrier, state, lead_tag FROM leads
       WHERE lead_status NOT IN ('sold','now_active','competitor_suppressed','scope_suppressed','address_review')
         AND (COALESCE(carrier,'kinetic') = 'frontier'
              OR (lead_tag = 'fresh_fiber_confirmed' AND upper(COALESCE(state,'')) NOT IN ('NC','SC')))`,
  ).all() as Array<{ id: number; carrier: string | null; state: string | null; lead_tag: string | null }>;
  if (!rows.length) return;
  const suppress = raw.prepare(`UPDATE leads SET lead_status='scope_suppressed', updated_at=datetime('now') WHERE id=?`);
  const hasEvents = !!raw.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='lead_events'`).get();
  const evt = hasEvents ? raw.prepare(`INSERT INTO lead_events (lead_id,type,actor,detail,at) VALUES (?,'status_change','Kinetic Scope',?,datetime('now'))`) : null;
  const tx = raw.transaction((list: typeof rows) => {
    for (const r of list) {
      const reason = (r.carrier ?? "kinetic") === "frontier" ? "frontier carrier" : `outside NC/SC (${r.state ?? "?"})`;
      suppress.run(r.id);
      evt?.run(r.id, JSON.stringify({ to: "scope_suppressed", reason, carrier: r.carrier, state: r.state }));
    }
  });
  tx(rows);
  console.log(`[migration] scope suppression: retracted ${rows.length} lead(s) (frontier carrier / outside NC-SC)`);
}

// Flag existing leads that fail the shared address-identity validation
// (@shared/addressKey addressIdentityIssues) as ADDRESS_REVIEW. Never touches
// closed business or already-suppressed rows; writes the reasons to
// lead_events for audit + release.
function backfillAddressReview(raw: import("better-sqlite3").Database): void {
  const rows = raw.prepare(
    `SELECT id, address, city, state, lat, lng FROM leads
      WHERE lead_status NOT IN ('sold','now_active','competitor_suppressed','scope_suppressed','address_review')`,
  ).all() as Array<{ id: number; address: string | null; city: string | null; state: string | null; lat: number | null; lng: number | null }>;
  if (!rows.length) return;
  const flip = raw.prepare(`UPDATE leads SET lead_status='address_review', updated_at=datetime('now') WHERE id=?`);
  const hasEvents = !!raw.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='lead_events'`).get();
  const evt = hasEvents ? raw.prepare(`INSERT INTO lead_events (lead_id,type,actor,detail,at) VALUES (?,'status_change','Address Review',?,datetime('now'))`) : null;
  let flagged = 0;
  const tx = raw.transaction((list: typeof rows) => {
    for (const r of list) {
      const issues = addressIdentityIssues(r);
      if (!issues.length) continue;
      flip.run(r.id);
      evt?.run(r.id, JSON.stringify({ to: "address_review", issues }));
      flagged++;
    }
  });
  tx(rows);
  if (flagged > 0) console.log(`[migration] address review: quarantined ${flagged} lead(s) with broken address identity`);
}

// ── scan_targets: one house per (address, city, state) ─────────────────────────
// The historical `address TEXT NOT NULL UNIQUE` made a real "104 Oak St,
// Broadway" collide with an existing "104 Oak St, Sanford" — the second city's
// house was thrown away (route 409 / sweep INSERT OR IGNORE), losing a genuine
// NEW FIBER + N lead. This drops that constraint and enforces uniqueness on
// (address, city, state) instead. Two steps, both required before the UNIQUE
// index can build on a live DB:
//   1. DEDUP the existing case/whitespace address variants (the audit found
//      ~28,525) down to one survivor per normalized (address, city, state),
//      keeping the row that already links to a lead, else the most-recently
//      scanned, else the lowest id.
//   2. Rebuild the table without UNIQUE(address) if it still carries it, then
//      create the UNIQUE index.
// Idempotent: once the index exists and the table has no old constraint, it's a
// no-op. Runs inside ONE transaction so a partial state is never observable.
function migrateScanTargetsAddressUniqueness(raw: import("better-sqlite3").Database): void {
  const tableRow = raw.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='scan_targets'`).get() as any;
  if (!tableRow?.sql) return; // table not created yet — a later boot handles it
  const hasOldUnique = /address\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(tableRow.sql);
  const hasIndex = !!raw.prepare(`SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_scan_targets_addr_city_state'`).get();
  if (!hasOldUnique && hasIndex) return; // already migrated

  const recreateIndexes = () => {
    raw.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_scan_targets_addr_city_state ON scan_targets(lower(trim(address)), lower(trim(city)), upper(trim(state)))`);
    raw.exec(`CREATE INDEX IF NOT EXISTS idx_scan_targets_scanned ON scan_targets(last_scanned_at)`);
    raw.exec(`CREATE INDEX IF NOT EXISTS idx_scan_targets_reprobe ON scan_targets(last_scanned_at, inconclusive_attempts)`);
    raw.exec(`CREATE INDEX IF NOT EXISTS idx_scan_targets_green_unlinked ON scan_targets(tenant_id, last_fiber_status, last_billing_status) WHERE converted_to_lead_id IS NULL`);
    raw.exec(`CREATE INDEX IF NOT EXISTS idx_scan_targets_fresh_opportunity ON scan_targets(first_seen_fiber_at, last_customer_segment)`);
    raw.exec(`CREATE INDEX IF NOT EXISTS idx_scan_targets_canonical ON scan_targets(tenant_id, canonical_key)`);
    raw.exec(`CREATE INDEX IF NOT EXISTS idx_scan_targets_lifecycle ON scan_targets(lifecycle_state, lifecycle_changed_at)`);
    // Must be recreated here too: the rebuild drops every index with the old
    // table, and losing this one silently returns syncMarketState to a
    // multi-minute full scan on the next scheduler tick.
    raw.exec(`CREATE INDEX IF NOT EXISTS idx_scan_targets_city_state ON scan_targets(lower(city), state)`);
    // Same reason, same blast radius: this is the one that makes the plan
    // COVERING. Losing it costs ~3.7x on every scheduler tick.
    raw.exec(`CREATE INDEX IF NOT EXISTS idx_scan_targets_market_sync ON scan_targets(lower(city), state, last_scanned_at, last_is_new_fiber, first_seen_fiber_at, first_seen_live_at)`);
  };

  raw.transaction(() => {
    // Step 1 — collapse duplicate spellings to ONE survivor per normalized
    // key (a lead-linked row wins, then most-recent scan, then lowest id).
    // ROW_NUMBER over a single partition sort is O(n log n); a correlated
    // per-row subquery was O(n^2) and hung the boot on 300k+ rows.
    const removed = raw.prepare(`
      DELETE FROM scan_targets WHERE id IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (
            PARTITION BY lower(trim(address)), lower(trim(city)), upper(trim(state))
            ORDER BY (converted_to_lead_id IS NOT NULL) DESC, last_scanned_at DESC, id ASC
          ) AS rn FROM scan_targets
        ) WHERE rn > 1
      )`).run().changes;
    if (removed > 0) console.log(`[migration] scan_targets: merged ${removed} duplicate address spellings`);

    if (hasOldUnique) {
      // Step 2 — rebuild without UNIQUE(address). newSql keeps the exact column
      // set (derived from the live table SQL) so INSERT ... SELECT * matches.
      const newSql = tableRow.sql
        .replace(/address\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i, "address TEXT NOT NULL")
        .replace(/CREATE TABLE\s+["'`]?scan_targets["'`]?/i, "CREATE TABLE scan_targets_rebuild");
      raw.exec(newSql);
      raw.exec(`INSERT INTO scan_targets_rebuild SELECT * FROM scan_targets`);
      raw.exec(`DROP TABLE scan_targets`);
      raw.exec(`ALTER TABLE scan_targets_rebuild RENAME TO scan_targets`);
      recreateIndexes();
      console.log("[migration] scan_targets: rebuilt without UNIQUE(address); now unique by (address, city, state)");
    } else {
      // Table already lacks the old constraint (fresh DB, or a prior partial
      // run) - just ensure the unique index exists now that dups are gone.
      recreateIndexes();
    }
  })();
}

// ── One-time (idempotent) duplicate-lead merge + canonical uniqueness ──────────
// Root cause of double pins: three lead-writer paths with no shared key and no DB
// uniqueness, so the same address became two leads. This (a) stamps a canonical
// address key on every existing lead, (b) merges duplicate groups - keeping the
// richest survivor, repointing every child FK, coalescing useful fields - and
// (c) adds a partial UNIQUE index so duplicates are structurally impossible.
// Idempotent + re-runnable: once merged, the group scan is a no-op.
function migrateLeadsCanonicalKey(raw: import("better-sqlite3").Database): void {
  const cols = new Set((raw.prepare(`PRAGMA table_info(leads)`).all() as { name: string }[]).map(c => c.name));
  if (!cols.has("canonical_key")) return; // ALTER didn't land yet - try next boot

  // Normalization-version gate: when the address alias table changes (e.g. a new
  // street-suffix synonym), existing keys were computed with the OLD rules and
  // must be re-derived so newly-equivalent addresses ("Oak Circle" ≡ "Oak Cir")
  // collapse. Re-keying ALL leads once per version bump is idempotent — the
  // stored version below guards against re-running.
  raw.exec(`CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  const storedVer = Number((raw.prepare(`SELECT value FROM schema_meta WHERE key='address_norm_version'`).get() as any)?.value ?? 0);
  const rekeyAll = storedVer < NORMALIZATION_VERSION;

  // (a) Derive canonical_key. Normally only rows missing it; on a normalization
  // bump, EVERY row (its old key is stale). CRITICAL ORDER: when there are keys
  // to (re)write, DROP the UNIQUE index first — otherwise setting the same key
  // on two duplicate rows violates a pre-existing index before the merge can
  // collapse them. The index is (re)built at the end, after dups are gone.
  // Steady-state boots (no bump, no NULLs) skip this block and leave the index.
  const needKey = raw.prepare(
    rekeyAll
      ? `SELECT id, address, city, state, zip FROM leads`
      : `SELECT id, address, city, state, zip FROM leads WHERE canonical_key IS NULL`,
  ).all() as Array<{ id: number; address: string; city: string; state: string; zip: string | null }>;
  if (needKey.length) {
    raw.exec(`DROP INDEX IF EXISTS idx_leads_canonical`);
    const setKey = raw.prepare(`UPDATE leads SET canonical_key=? WHERE id=?`);
    const backfill = raw.transaction((rows: typeof needKey) => {
      for (const r of rows) setKey.run(normalizeKineticAddressKey(r.address ?? "", r.city ?? "", r.state ?? "", r.zip ?? ""), r.id);
    });
    for (let i = 0; i < needKey.length; i += 2000) backfill(needKey.slice(i, i + 2000));
  }

  // (b) Find + merge duplicate groups. Key is (tenant_id, canonical_key) — ONE
  // address = ONE lead = ONE pin, regardless of carrier (Kinetic/Frontier is a
  // status on the single lead, not a second pin). NULL carrier would also make a
  // carrier-keyed UNIQUE index useless (NULLs compare distinct in SQLite).
  const groups = raw.prepare(
    `SELECT tenant_id AS tenantId, canonical_key AS ck, COUNT(*) n, GROUP_CONCAT(id) ids
       FROM leads WHERE canonical_key IS NOT NULL
      GROUP BY tenant_id, canonical_key HAVING COUNT(*) > 1`,
  ).all() as Array<{ tenantId: number; ck: string; n: number; ids: string }>;

  if (groups.length) {
    // lead_status seniority: a more-worked/sold row must win over a fresh prospect.
    // not_interested is a WORKED terminal state — without an entry it ranked 0 and
    // lost to a bare prospect copy, silently re-opening a closed door on merge.
    const statusRank: Record<string, number> = { sold: 6, now_active: 5, callback: 4, follow_up: 4, interested: 4, contacted: 3, not_interested: 3, prospect: 2, unworked: 1 };
    // "Already a Customer" is stored as lead_status=not_interested +
    // last_outcome=already_customer (see shared/knock.ts) — the door is served,
    // terminal, and must outrank every unworked/prospect copy.
    const rankOf = (r: any): number =>
      r?.last_outcome === "already_customer" ? 5 : (statusRank[r?.lead_status] ?? 0);
    // Child tables that reference leads.id — repoint loser→survivor to keep history.
    const childFks: Array<[string, string]> = [
      ["knock_log", "lead_id"], ["commissions", "lead_id"], ["lead_events", "lead_id"],
      ["commission_sales", "lead_id"], ["lead_photos", "lead_id"], ["lead_credit_ledger", "lead_id"],
      ["scan_targets", "converted_to_lead_id"], ["scan_queue_items", "lead_id"],
    ];
    const existingTables = new Set((raw.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map(t => t.name));
    const rowCols = (id: number) => raw.prepare(`SELECT * FROM leads WHERE id=?`).get(id) as any;
    const completeness = (r: any) => ["contact_name", "contact_phone", "contact_email", "owner_name", "owner_phone", "owner_email", "assigned_rep_id", "assigned_territory_id", "notes", "deployment_notes", "source_scan_target_id", "fresh_confirmed_at"].reduce((s, k) => s + (r[k] != null && r[k] !== "" ? 1 : 0), 0);

    let mergedGroups = 0, deletedRows = 0;
    const mergeOne = raw.transaction((ids: number[]) => {
      const rows = ids.map(rowCols).filter(Boolean);
      if (rows.length < 2) return;
      // Survivor: has source_scan_target_id (projector-authoritative) > higher
      // lead_status rank > more complete > lowest id.
      rows.sort((a, b) =>
        (b.source_scan_target_id != null ? 1 : 0) - (a.source_scan_target_id != null ? 1 : 0) ||
        rankOf(b) - rankOf(a) ||
        completeness(b) - completeness(a) ||
        a.id - b.id);
      const survivor = rows[0];
      const losers = rows.slice(1);
      for (const loser of losers) {
        for (const [table, col] of childFks) {
          if (!existingTables.has(table)) continue;
          try { raw.prepare(`UPDATE ${table} SET ${col}=? WHERE ${col}=?`).run(survivor.id, loser.id); } catch { /* col may not exist on this DB */ }
        }
        // Coalesce useful fields from loser onto survivor where survivor is empty.
        const coalesceCols = ["source_scan_target_id", "fresh_confirmed_at", "fresh_confidence", "fresh_sources", "contact_name", "contact_phone", "contact_email", "owner_name", "owner_phone", "owner_email", "assigned_rep_id", "assigned_territory_id", "notes", "deployment_notes", "lat", "lng"];
        for (const c of coalesceCols) {
          if (!cols.has(c)) continue;
          if ((survivor[c] == null || survivor[c] === "") && loser[c] != null && loser[c] !== "") {
            try { raw.prepare(`UPDATE leads SET ${c}=? WHERE id=?`).run(loser[c], survivor.id); survivor[c] = loser[c]; } catch { /* ignore */ }
          }
        }
        // Promote survivor status if the loser was more advanced — and carry the
        // DISPOSITION with it: lead_status alone is ambiguous (already_customer
        // vs not_interested, callback vs follow_up are told apart by
        // last_outcome on every surface), and the outcome CAS keys off
        // last_outcome_at, so a promoted status with stale/empty outcome columns
        // would both mislabel the pin and lose CAS ordering.
        if (rankOf(loser) > rankOf(survivor)) {
          if (cols.has("last_outcome") && cols.has("last_outcome_at")) {
            raw.prepare(`UPDATE leads SET lead_status=?, last_outcome=?, last_outcome_at=? WHERE id=?`)
              .run(loser.lead_status, loser.last_outcome ?? null, loser.last_outcome_at ?? null, survivor.id);
            survivor.last_outcome = loser.last_outcome;
            survivor.last_outcome_at = loser.last_outcome_at;
          } else {
            raw.prepare(`UPDATE leads SET lead_status=? WHERE id=?`).run(loser.lead_status, survivor.id);
          }
          survivor.lead_status = loser.lead_status;
        }
        // Keep the fresh_fiber_confirmed tag if any copy had it.
        if (cols.has("lead_tag") && loser.lead_tag === "fresh_fiber_confirmed" && survivor.lead_tag !== "fresh_fiber_confirmed") {
          raw.prepare(`UPDATE leads SET lead_tag='fresh_fiber_confirmed' WHERE id=?`).run(survivor.id);
        }
        raw.prepare(`DELETE FROM leads WHERE id=?`).run(loser.id);
        deletedRows++;
      }
      mergedGroups++;
    });
    for (const g of groups) {
      try { mergeOne(g.ids.split(",").map(Number)); }
      catch (e: any) { console.warn(`[migration] lead merge group ${g.ck} skipped:`, e?.message); }
    }
    console.log(`[migration] leads canonical merge: ${mergedGroups} groups, ${deletedRows} duplicate rows removed`);
  }

  // (c) Enforce uniqueness so a duplicate can never be inserted again. Partial
  // (WHERE canonical_key IS NOT NULL) mirrors idx_leads_confirmed_scan_target.
  raw.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_canonical ON leads(tenant_id, canonical_key) WHERE canonical_key IS NOT NULL`);
  const idxOk = raw.prepare(`SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_leads_canonical'`).get();
  if (!idxOk) console.warn("[migration] CRITICAL: idx_leads_canonical was NOT created - duplicate leads are still possible");
  else console.log("[migration] idx_leads_canonical UNIQUE index active - duplicate pins now structurally impossible");

  // Record the normalization version last — only after a clean re-key + merge +
  // index, so a crash mid-migration re-runs it next boot rather than skipping.
  if (rekeyAll) {
    raw.prepare(`INSERT INTO schema_meta (key, value) VALUES ('address_norm_version', ?)
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(NORMALIZATION_VERSION));
    console.log(`[migration] address normalization re-keyed to v${NORMALIZATION_VERSION}`);
  }
}

// ── Default-tenant bootstrap ─────────────────────────────────────────────────
// This app grew single-org and tenancy was bolted on: the original admin/users/
// leads all carry tenant_id NULL, which the (strictly tenant-scoped) commission
// engine can't work with. This seed makes "Home Front Solutions" the real
// default tenant and adopts every unowned row into it. Idempotent + additive:
// - Creates the tenant by SLUG if missing (never duplicates).
// - Backfills tenant_id ONLY where it is NULL — rows already owned by another
//   tenant are never touched, so future multi-tenant stays intact.
// - app_settings is EXCLUDED: tenant_id=0 there is the platform bucket.
export const DEFAULT_TENANT_SLUG = "home-front-solutions";

export function bootstrapDefaultTenant(raw: any): void {
  try {
    let tenant = raw.prepare("SELECT id FROM tenants WHERE slug = ?").get(DEFAULT_TENANT_SLUG) as { id: number } | undefined;
    if (!tenant) {
      const now = new Date().toISOString();
      const info = raw.prepare(
        `INSERT INTO tenants (slug, company_name, owner_name, owner_email, brand_name, tagline, plan, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      ).run(
        DEFAULT_TENANT_SLUG, "Home Front Solutions", "Muizz Muhammad", "muizzm21@gmail.com",
        "Home Front Solutions", "Direct to your door", "internal", "active", now, now,
      );
      tenant = { id: Number(info.lastInsertRowid) };
      console.log(`[tenant] Bootstrapped default tenant "Home Front Solutions" (id ${tenant.id})`);
    }

    // Adopt every unowned row (dynamic sweep — any table with a tenant_id column).
    const tables = (raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[])
      .map(t => t.name)
      .filter(name => name !== "app_settings" && name !== "tenants");
    let adopted = 0;
    for (const table of tables) {
      const cols = (raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name);
      if (!cols.includes("tenant_id")) continue;
      // activity_log: only adopt USER-attributed rows. System actions (user_id
      // NULL — nightly scans, cron, first-run) must stay tenant-less so they're
      // visible only to super_admin, matching logActivity's write-time contract.
      const where = table === "activity_log"
        ? "tenant_id IS NULL AND user_id IS NOT NULL"
        : "tenant_id IS NULL";
      const res = raw.prepare(`UPDATE ${table} SET tenant_id = ? WHERE ${where}`).run(tenant.id);
      adopted += res.changes;
    }
    if (adopted > 0) {
      console.log(`[tenant] Adopted ${adopted} unowned rows into "Home Front Solutions"`);
      raw.prepare(
        `INSERT INTO activity_log (user_id, action, entity_type, entity_id, details) VALUES (NULL, 'tenant.bootstrap', 'tenant', ?, ?)`
      ).run(tenant.id, JSON.stringify({ slug: DEFAULT_TENANT_SLUG, adoptedRows: adopted }));
    }
    _defaultTenantId = undefined; // re-resolve the cached default-tenant id
  } catch (e: any) {
    console.warn("[tenant] Default-tenant bootstrap skipped:", e?.message);
  }
}

// ── Default tenant lookup (cached) ───────────────────────────────────────────
// System-initiated writes (scanners, cron, first-run) have no acting user; they
// file under the default org. Resolved once — bootstrapDefaultTenant guarantees
// it exists on any real DB.
let _defaultTenantId: number | null | undefined;
export function getDefaultTenantId(): number | null {
  if (_defaultTenantId !== undefined) return _defaultTenantId;
  try {
    const row = rawDb.prepare("SELECT id FROM tenants WHERE slug = ?").get(DEFAULT_TENANT_SLUG) as { id: number } | undefined;
    _defaultTenantId = row?.id ?? null;
  } catch { _defaultTenantId = null; }
  return _defaultTenantId;
}

// Invalidate the map-pin cache + ETag data version (registered by routes.ts on
// globalThis). Called from the LEAD MUTATION CHOKE POINTS below (create/update/
// delete/upsert) so no route can mutate pins and forget to bust — a stale 304
// after an assignment would silently show a manager old pin data forever.
// Pass the row's tenantId when known so only that org's polls re-pay; an
// unknown tenant falls back to a global bust (never risks staleness).
function bustPinCaches(tenantId?: number | null) {
  const bust = (globalThis as any).__bustMapCache;
  if (typeof bust === "function") bust(tenantId ?? undefined);
}

// ── Leaderboard write epoch ──────────────────────────────────────────────────
// getLeaderboard's grouped aggregate walks the tenant's full applied-knock
// history; the Leaderboard page polls it every 30s PER VIEWER and the "/"
// prefetch adds more, so N viewers used to pay N identical full-history
// aggregates per window. The memo below shares one compute per (tenant,
// window) while nothing it reads has moved. "Moved" is tracked by this epoch,
// bumped UNCONDITIONALLY by every write that can change a board number:
// knock inserts, lead updates (a central disposition flips lead_status with
// no knock row — the sold gate reads it), the CAS outcome flip, and roster
// writes (active flags and new reps shape the returned rows). The short TTL
// bounds what the epoch cannot see (raw SQL writers, the org-midnight
// boundary drifting under the today counters).
let leaderboardEpoch = 0;
function bumpLeaderboardEpoch(): void {
  leaderboardEpoch++;
}

// Roster shape ONLY — who exists and who reports to whom. Deliberately separate
// from leaderboardEpoch, which every knock and lead-status write also moves: a
// consumer that re-derives a REPORTING TREE wants to recompute when the tree
// changes, not on every sale. routes.ts's SSE lead stream memoises each
// subscriber's leadVisibilityScope() against this, and that scope is authority
// (it decides which reps' leads reach a team_lead), so the bump lives on the
// storage writes rather than on any route: a reports_to edge moved by a route
// that nobody thought to instrument must still reach an open stream.
let teamRosterEpoch = 0;
function bumpTeamRosterEpoch(): void {
  teamRosterEpoch++;
}

/** UTC instant of midnight in the org's local day.
 *
 *  "Today" for a field rep is the day on the phone in their hand, not the day
 *  in the container. An org on Eastern rolls over five hours before UTC does,
 *  so any counter keyed off container midnight is wrong for the entire evening
 *  — which is prime knocking time.
 *
 *  Falls back to the default workweek zone when the tenant is unknown or the
 *  lookup fails, never to container-local time. */
function localDayStartMs(tenantId: number | undefined | null, nowMs: number): number {
  const tz = orgTimezoneFor(tenantId);
  const { y, mo, d } = localYmdParts(nowMs, tz);
  return localWallToUtcMs(y, mo, d, 0, 0, tz);
}

// ── Tenant-config memo ───────────────────────────────────────────────────────
// openFieldEnabled / orgTimezoneFor / getGeoConfig are each a cheap indexed
// point read, but together they run 3-5 times per hot request (map poll
// composes the scope predicate three times; every knock write reads the geo
// thresholds twice) for values that change only through a handful of admin
// writes. Same discipline as territoryScopeCache: ONE version stamp, bumped
// UNCONDITIONALLY by every tenant-config write path (updateTenant, setSetting,
// and commissionService's raw org-config UPDATE) — never "when the relevant
// field changed", because a bump that reasons about which fields matter is a
// bump that will eventually reason wrong. The short TTL is the backstop for
// writers this process cannot see (another process, a hand-run SQL fix): a
// stale answer can outlive a bypassed bump by at most a few seconds.
let tenantConfigVersion = 0;

/** Called by every tenant-config write. Cheap enough that "call it always" is
 *  the rule. */
export function bumpTenantConfigVersion(): void {
  tenantConfigVersion++;
}

interface TenantConfigEntry { version: number; at: number; tz?: string; openField?: boolean; geo?: GeoConfig }
const TENANT_CONFIG_TTL_MS = 5_000;
const TENANT_CONFIG_MAX_ENTRIES = 500;
const tenantConfigCache = new Map<number, TenantConfigEntry>();

function tenantConfigEntry(key: number): TenantConfigEntry {
  const now = Date.now();
  const hit = tenantConfigCache.get(key);
  const age = hit ? now - hit.at : Infinity;
  if (hit && hit.version === tenantConfigVersion && age >= 0 && age < TENANT_CONFIG_TTL_MS) return hit;
  // Full clear on overflow, mirroring territoryScopeCache: entries are only
  // valid for one version anyway, so clever eviction buys nothing.
  if (tenantConfigCache.size >= TENANT_CONFIG_MAX_ENTRIES) tenantConfigCache.clear();
  const fresh: TenantConfigEntry = { version: tenantConfigVersion, at: now };
  tenantConfigCache.set(key, fresh);
  return fresh;
}

/** The org's IANA timezone, or the default workweek zone when unknown.
 *
 *  Exported because date-range filters are built in the route layer and must
 *  agree with the aggregates computed here — a "today" that means one thing in
 *  the WHERE clause and another in the SELECT is worse than either alone. */
export function orgTimezoneFor(tenantId: number | undefined | null): string {
  if (tenantId == null) return DEFAULT_WORKWEEK.timezone;
  const entry = tenantConfigEntry(tenantId);
  let tz = entry.tz;
  if (tz === undefined) {
    try {
      const row = rawDb.prepare(`SELECT commission_timezone AS tz FROM tenants WHERE id = ?`).get(tenantId) as any;
      tz = String(row?.tz || DEFAULT_WORKWEEK.timezone);
      entry.tz = tz;
    } catch { return DEFAULT_WORKWEEK.timezone; } // transient failure — answer the default, never cache it
  }
  return tz;
}

// Wire DTO for the /api/leads list page: exactly the fields the list UI
// renders PLUS the two the edit dialog seeds from the LIST row (contactEmail,
// notes — LeadForm reads them off `initial`, so omitting them would blank
// stored values on the next save). The other ~38 columns — free-text blobs
// (deploymentNotes, freshSources), briefing and enrichment fields — ride only
// on /api/leads/:id, which the detail drawer already fetches. Cuts both the
// hydration and the response-sanitizer clone roughly 3x per page.
// A scan-backed lead points at its canonical scan_target. `fresh_confirmed_at`
// is the safe legacy fallback for older projected rows whose source link was
// not retained. Keep this as one SQL expression so filtering, sorting, and the
// value rendered by the client can never disagree about what "last scanned"
// means.
const LEAD_SCAN_AT_SQL = sql<string | null>`coalesce(${scanTargets.lastScannedAt}, ${leads.freshConfirmedAt})`;
const LEAD_SCAN_EPOCH_SQL = sql<number | null>`julianday(${LEAD_SCAN_AT_SQL})`;

const LEAD_LIST_COLUMNS = {
  id: leads.id, address: leads.address, city: leads.city, state: leads.state, zip: leads.zip,
  lat: leads.lat, lng: leads.lng, leadStatus: leads.leadStatus, fiberStatus: leads.fiberStatus,
  lastOutcome: leads.lastOutcome, leadScore: leads.leadScore,
  assignedRepId: leads.assignedRepId, assignedAt: leads.assignedAt, assignmentSource: leads.assignmentSource,
  contactName: leads.contactName, contactEmail: leads.contactEmail, notes: leads.notes,
  ownerName: leads.ownerName, ownerEmail: leads.ownerEmail,
  isNewFiber: leads.isNewFiber, maxDownloadMbps: leads.maxDownloadMbps, dfAddressId: leads.dfAddressId,
  lastScannedAt: LEAD_SCAN_AT_SQL.as("lastScannedAt"),
  createdAt: leads.createdAt, updatedAt: leads.updatedAt,
};
export type LeadListRow = Pick<Lead,
  "id" | "address" | "city" | "state" | "zip" | "lat" | "lng" | "leadStatus" | "fiberStatus" |
  "lastOutcome" | "leadScore" | "assignedRepId" | "assignedAt" | "assignmentSource" |
  "contactName" | "contactEmail" | "notes" | "ownerName" | "ownerEmail" |
  "isNewFiber" | "maxDownloadMbps" | "dfAddressId" | "createdAt" | "updatedAt"> & {
  lastScannedAt: string | null;
};

export class Storage implements IStorage {
  // ── Leads ──────────────────────────────────────────────────────────────────
  getLeads(tenantId?: number, assignedRep?: number | number[]): Lead[] {
    const conditions = [];
    if (tenantId != null) conditions.push(eq(leads.tenantId, tenantId));
    // Visibility scope: a single rep id (a rep sees only their own leads) OR a
    // SET of rep ids (a team lead sees their team's). An empty set matches
    // NOTHING (fail-closed) — never the whole table.
    if (Array.isArray(assignedRep)) {
      conditions.push(assignedRep.length ? inArray(leads.assignedRepId, assignedRep) : eq(leads.assignedRepId, -1));
    } else if (assignedRep != null) {
      conditions.push(eq(leads.assignedRepId, assignedRep));
    }
    const q = db.select().from(leads);
    return (conditions.length > 0
      ? q.where(conditions.length === 1 ? conditions[0] : and(...conditions))
      : q).orderBy(desc(leads.createdAt)).all();
  }
  // Tenant-aware by option: pass tenantId and the lookup is walled to that
  // tenant in SQL, so a new call site is cross-tenant-safe BY DEFAULT instead of
  // relying on the caller to remember an out-of-band `row.tenantId !== tid`
  // check. Omitting tenantId preserves the original unscoped behaviour (every
  // existing call site is unchanged). Mirrors updateTeamMember's shape.
  getLeadById(id: number, tenantId?: number): Lead | undefined {
    const condition = tenantId != null ? and(eq(leads.id, id), eq(leads.tenantId, tenantId)) : eq(leads.id, id);
    return db.select().from(leads).where(condition).get();
  }
  // Distinct city/state pairs for the Leads filter dropdowns — replaces fetching
  // the ENTIRE map pin set (every lead, hydrated) just to build two selects.
  // Same visibility semantics as getLeads: tenant wall + optional rep scope
  // (empty scope matches nothing, fail-closed).
  // Cheap cross-process data-version for the map ETag: changes whenever a lead is
  // inserted (COUNT + MAX id) or updated (MAX updated_at) by ANY process — the
  // scan runner, nightly cron, or another app instance. This is what lets the map
  // auto-refresh pick up scan-added leads (the in-memory epoch alone can't see
  // writes from a separate process). Index-served via idx_leads_tenant_updated.
  getLeadsDataVersion(tenantId?: number): string {
    // Memoised for one second. Three aggregates in one statement cannot each
    // use an index optimisation, so SQLite walks the whole tenant range —
    // measured ~5ms at 40k leads, and this runs BEFORE the ETag comparison, so
    // even the zero-body 304 path (the entire point of the ETag) paid a full
    // scan on every poll from every rep.
    //
    // Correctness is unchanged: the in-process epoch counters in routes.ts bust
    // the ETag instantly for this process's own writes. This value exists only
    // to catch CROSS-process writes (the scan runner, nightly cron), and a
    // one-second lag on those is invisible against the 8s map cache TTL.
    const key = tenantId ?? -1;
    const now = Date.now();
    const hit = this._leadsDataVersionCache.get(key);
    if (hit && now - hit.at < 1000) return hit.value;
    const row = (tenantId != null
      ? rawDb.prepare("SELECT COUNT(*) c, COALESCE(MAX(id),0) mx, COALESCE(MAX(updated_at),'') mu FROM leads WHERE tenant_id = ?").get(tenantId)
      : rawDb.prepare("SELECT COUNT(*) c, COALESCE(MAX(id),0) mx, COALESCE(MAX(updated_at),'') mu FROM leads").get()
    ) as { c: number; mx: number; mu: string };
    const value = `${row.c}.${row.mx}.${row.mu}`;
    this._leadsDataVersionCache.set(key, { value, at: now });
    return value;
  }
  private _leadsDataVersionCache = new Map<number, { value: string; at: number }>();
  getLeadFacets(tenantId?: number, repScope?: number[]): Array<{ city: string; state: string }> {
    const conds: string[] = [];
    const params: (number | string)[] = [];
    if (tenantId != null) { conds.push("tenant_id = ?"); params.push(tenantId); }
    if (Array.isArray(repScope)) {
      if (!repScope.length) return [];
      conds.push(`assigned_rep_id IN (${repScope.map(() => "?").join(",")})`);
      params.push(...repScope);
    }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    return rawDb.prepare(
      `SELECT DISTINCT city, state FROM leads ${where} ORDER BY state, city`
    ).all(...params) as Array<{ city: string; state: string }>;
  }

  // One scoped query returns map fields plus the latest visit/count. The
  // materialized scoped CTE limits the window to visible leads, making the
  // work O(L + K_scope), where L is visible leads and K_scope their knocks.
  // The ONE place the map's visibility predicate is built: tenant wall +
  // rep/area scope + pin eligibility (geocoded, not suppressed). getLeadsForMap
  // (full feed AND bbox windows) and getLeadsMapCount all compose from this so
  // a scoped read can never drift between the count, the full feed, and a
  // viewport window.
  //
  // The `view` lens composes HERE — at the scope layer mapWindowPred itself
  // extends — so the full feed, bbox windows, the count probe, and the
  // density grid all apply the identical "latest" predicate (no forked
  // builder). Absent view = the byte-stable unfiltered predicate.
  /** Does this tenant let reps work unowned ground? Off unless switched on.
   *  Memoised on the tenant-config version stamp — mapScopeWhere consults this
   *  up to three times per map request. */
  openFieldEnabled(tenantId?: number): boolean {
    if (tenantId == null) return false;
    const entry = tenantConfigEntry(tenantId);
    if (entry.openField === undefined) {
      try {
        const row = rawDb.prepare(`SELECT open_field_enabled AS v FROM tenants WHERE id = ?`).get(tenantId) as any;
        entry.openField = !!row?.v;
      } catch { return false; } // transient failure — fail closed, never cache it
    }
    return entry.openField;
  }

  private mapScopeWhere(tenantId?: number, assignedRep?: number | number[], view?: MapView): { where: string; params: any[] } {
    const clauses: string[] = [];
    const params: any[] = [];
    if (tenantId != null) {
      clauses.push("l.tenant_id = ?");
      params.push(tenantId);
    }
    if (view === "latest") {
      // "Latest fiber": everything EXCEPT the established-footprint import —
      // NULL tags (organic/manual adds), fcc_fresh_block, fresh-verified, and
      // any other tag all stay. NULL-safe: `<> 'fcc_fiber_d25'` alone would
      // silently drop every untagged lead (three-valued logic).
      clauses.push("(l.lead_tag IS NULL OR l.lead_tag <> ?)");
      params.push(MAP_LATEST_VIEW_EXCLUDED_TAG);
    }
    if (view === "kinetic_2026") {
      // "Kinetic 2026 builds": ONLY the doors an authorized qualification
      // confirmed, and that the FCC baseline proves were unserved before 2026.
      // A positive tag match, not an exclusion, so a new tag family added
      // later cannot leak into this lens by default.
      clauses.push("l.lead_tag = ?");
      params.push(MAP_KINETIC_2026_TAG);
    }
    if (Array.isArray(assignedRep)) {
      // ONE rule, shared with the per-request access check in routes.ts — see
      // shared/leadVisibility.ts. This used to be a second, hand-written copy
      // that had drifted: it omitted the OPEN-FIELD branch, so a door with no
      // rep and no territory was legal to knock and impossible to see. A rep
      // cannot knock a pin that was never drawn.
      //
      // Fail-closed on an empty scope: the helper returns the impossible
      // predicate, so a rep with no linked member sees zero pins, not all.
      clauses.push(repVisibilitySql(assignedRep, "l", this.openFieldEnabled(tenantId))!);
    } else if (assignedRep != null) {
      clauses.push(repVisibilitySql([assignedRep], "l", this.openFieldEnabled(tenantId))!);
    }
    const where = clauses.length ? clauses.join(" AND ") : "1 = 1";
    // Scope predicate shared by both statements below. The lead_status gate:
    //   - Competitive-eligibility: a lead retracted because a fiber competitor
    //     (or an unresolved competitor) was found is off the rep map.
    //   - Scope gate (Kinetic-only NC/SC): frontier-carrier and out-of-state
    //     leads are suppressed (status flip, audit-logged), never deleted.
    const scopePred = `${where} AND l.lat IS NOT NULL AND l.lng IS NOT NULL
          AND l.lead_status NOT IN ('competitor_suppressed','scope_suppressed','address_review')`;
    return { where: scopePred, params };
  }

  getLeadsMapCount(tenantId?: number, assignedRep?: number | number[], view?: MapView): number {
    // Empty team scope → empty map (same fail-closed rule as getLeadsForMap).
    if (Array.isArray(assignedRep) && !assignedRep.length) return 0;
    const { where, params } = this.mapScopeWhere(tenantId, assignedRep, view);
    const row = rawDb.prepare(`SELECT COUNT(*) AS c FROM leads l WHERE ${where}`).get(...params) as { c: number };
    return row.c;
  }

  // Bbox/tag window predicate: the SAME scoped set, narrowed spatially.
  // BETWEEN keeps the idx_leads_lat_lng range scan usable; the tag predicate
  // is an exact match OR an underscore-prefix match ("fcc" → fcc_fresh_block,
  // fcc_fiber_d25) so a family of tags filters with one param. The ONE place
  // the window predicate is built — getLeadsForMap, getLeadsMapWindowCount,
  // and getLeadsMapGrid (the density tier) all compose from it, so the
  // sampler's count and the aggregate's buckets can never drift from the rows
  // the sampled query would return.
  private mapWindowPred(scopePred: string, params: any[], window: MapPinWindow): string {
    scopePred += " AND l.lat BETWEEN ? AND ? AND l.lng BETWEEN ? AND ?";
    params.push(window.minLat, window.maxLat, window.minLng, window.maxLng);
    if (window.tag) {
      // LIKE metachars must match literally: escape \, %, _ in the tag with
      // a backslash (declared via ESCAPE), and escape the appended family
      // separator too so "fcc" matches fcc_fresh_block but a literal '_' in
      // a tag can never act as a wildcard.
      const esc = window.tag.replace(/[\\%_]/g, (c) => "\\" + c);
      scopePred += " AND (l.lead_tag = ? OR l.lead_tag LIKE ? ESCAPE '\\')";
      params.push(window.tag, `${esc}\\_%`);
    }
    // Deterministic even thinning for over-cap windows: keep every id that is
    // a multiple of the step. Stable across pans (same window → same rows),
    // spread across insertion order — which correlates with geography per
    // scan batch — so a state-wide sample shows every scanned town rather
    // than the ORDER BY id LIMIT prefix (= the first-scanned city only).
    // Tradeoff: modulo over id is not spatially uniform (dense scans keep
    // proportionally more pins), but it is cheap, index-friendly, and cannot
    // blank out a region the way prefix truncation does.
    const step = Math.floor(window.sampleStep ?? 1);
    if (step > 1) {
      scopePred += " AND (l.id % ?) = 0";
      params.push(step);
    }
    return scopePred;
  }

  getLeadsMapWindowCount(tenantId: number | undefined, assignedRep: number | number[] | undefined, window: MapPinWindow): number {
    // Empty team scope → empty map (same fail-closed rule as getLeadsForMap).
    if (Array.isArray(assignedRep) && !assignedRep.length) return 0;
    const { where, params } = this.mapScopeWhere(tenantId, assignedRep, window.view);
    const pred = this.mapWindowPred(where, params, window);
    const row = rawDb.prepare(`SELECT COUNT(*) AS c FROM leads l WHERE ${pred}`).get(...params) as { c: number };
    return row.c;
  }

  getLeadsMapGrid(tenantId: number | undefined, assignedRep: number | number[] | undefined, window: MapGridWindow): MapGridCell[] {
    const { where, params } = this.mapScopeWhere(tenantId, assignedRep, window.view);
    const scopePred = this.mapWindowPred(where, params, window);
    // Integer FLOOR buckets: lat/lng divided by the cell pitch, floored, then
    // grouped. FLOOR is exact on the float division (no ROUND-half drift), the
    // BETWEEN window keeps the idx_leads_lat_lng range scan doing the row
    // selection, and the aggregate is one pass over those rows — O(K_window),
    // never a sort of the pin projection. The bucket id round-trips to the
    // cell CENTER in JS ((bucket + 0.5) * cell) so the client never has to
    // reconstruct the grid pitch from coordinates. (sampleStep is a PIN-path
    // concept — the grid already IS the bounded wide-zoom answer — so it is
    // never set on a MapGridWindow.)
    // `fresh` mirrors the pin path's cluster ring EXACTLY: the feature prop
    // the cluster fresh_count sums is `leadTag === 'fresh_fiber_confirmed'`
    // (leadGeoJson.ts), so the grid must count the same predicate — nothing
    // cleverer — or the green ring would mean different things across the
    // tier crossing. One extra conditional in the same row pass, no join.
    const rows = rawDb.prepare(`
      SELECT FLOOR(l.lat / ?) AS latBucket, FLOOR(l.lng / ?) AS lngBucket,
             COUNT(*) AS n,
             SUM(CASE WHEN l.lead_tag = 'fresh_fiber_confirmed' THEN 1 ELSE 0 END) AS fresh
      FROM leads l
      WHERE ${scopePred}
      GROUP BY latBucket, lngBucket
      ORDER BY n DESC, latBucket ASC, lngBucket ASC
      LIMIT ?
    `).all(window.cell, window.cell, ...params, Math.max(1, Math.floor(window.limit ?? 5_000))) as Array<{ latBucket: number; lngBucket: number; n: number; fresh: number }>;
    const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
    return rows.map((r) => ({
      lat: r6((r.latBucket + 0.5) * window.cell),
      lng: r6((r.lngBucket + 0.5) * window.cell),
      n: r.n,
      ...(r.fresh > 0 ? { fresh: r.fresh } : {}),
    }));
  }

  getLeadsForMap(tenantId?: number, assignedRep?: number | number[], window?: MapPinWindow, view?: MapView): MapPinRow[] {
    // The view lens rides the window for bbox/grid callers and the explicit
    // arg for the windowless full feed — both land in the SAME mapScopeWhere
    // clause, so the feed can never drift from a window over the same view.
    const { where, params } = this.mapScopeWhere(tenantId, assignedRep, view ?? window?.view);
    let scopePred = where;
    if (window) scopePred = this.mapWindowPred(scopePred, params, window);
    const sampled = window != null && (window.sampleStep ?? 1) > 1;
    // The SAMPLED re-query keeps ORDER BY l.id (pinned contract — see below),
    // and on idx_leads_map_window that costs a full materialize + sort. Pin it
    // to idx_leads_tenant instead: a tenant-equality scan of that index yields
    // rows in rowid (= id) order, so the sort is free and LIMIT terminates
    // early — measured 461ms → 237ms at the 3° ceiling on a 180k-lead tenant.
    // Tenant-scoped only (without the equality the index is just a full walk);
    // the index is created unconditionally in migrations above.
    const fromHint = sampled && tenantId != null ? "INDEXED BY idx_leads_tenant" : "";
    // TWO statements merged via a JS Map, replacing the single CTE query whose
    // window pass sorted every scoped knock AND whose wide MATERIALIZED CTE was
    // re-scanned through an automatic index for the final join (measured
    // 283ms -> 172ms at 20k leads / 50k knocks; the window alone was ~125ms).
    //
    // Statement 1 — the wide pin projection, one index walk over leads.
    // The lead's OWN disposition columns ride along: the knock CAS keeps them
    // monotonic by last_outcome_at, and central marks write them with NO knock
    // row — so the pin's outcome must be able to come from here, not only from
    // the knock aggregate.
    const rows = rawDb.prepare(`
      SELECT
        l.id, l.address, l.city, l.state, l.zip, l.lat, l.lng,
        l.lead_status AS leadStatus, l.fiber_status AS fiberStatus,
        l.assigned_rep_id AS assignedRepId, l.assigned_territory_id AS assignedTerritoryId,
        l.lead_score AS leadScore,
        l.lead_tag AS leadTag, l.fresh_confidence AS freshConfidence, l.carrier AS carrier,
        l.fresh_sources AS freshSources, l.fresh_confirmed_at AS freshConfirmedAt,
        l.assign_mark AS assignMark, l.do_not_knock AS doNotKnock,
        l.last_outcome AS leadLastOutcome, l.last_outcome_at AS leadLastOutcomeAt
      FROM leads l ${fromHint}
      WHERE ${scopePred}
      ${window ? `${sampled ? "ORDER BY l.id " : ""}LIMIT ?` : ""}
    `).all(...(window ? [...params, Math.max(1, Math.floor(window.limit ?? 25_000))] : params)) as MapPinRow[];
    // ORDER BY rationale: only the SAMPLED re-query (sampleStep > 1) orders by
    // id — its id-ordered result is a pinned contract (deterministic, stable
    // across pans; see the 25k-cap sampling test). The plain windowed query
    // deliberately does NOT: its rows are either a COMPLETE window (order
    // irrelevant — the client merges by id) or an over-cap probe whose rows are
    // DISCARDED and re-fetched sampled, and dropping the sort lets the
    // idx_leads_map_window scan terminate at LIMIT instead of materializing +
    // sorting every row in a wide window (measured 395ms → 269ms at the 3°
    // pin-tier ceiling on a 180k-lead tenant).
    if (!rows.length) return rows;
    // Statement 2 — per-lead visit aggregate over EXACTLY the leads statement 1
    // returned (their ids ride in via json_each, so a rep-scoped call does
    // O(K_scope) work and never re-evaluates the scope predicate). The
    // correlated pick reads the latest knock's outcome with one indexed seek
    // per knocked lead (idx_knock_log_lead_time_desc), keeping the exact
    // deterministic tie-break the old window ORDER BY used
    // (knocked_at DESC, id DESC).
    const agg = rawDb.prepare(`
      SELECT k.lead_id AS leadId,
             COUNT(*) AS knockCount,
             MAX(k.knocked_at) AS lastKnockedAt,
             (SELECT k2.outcome FROM knock_log k2
               WHERE k2.lead_id = k.lead_id
               ORDER BY k2.knocked_at DESC, k2.id DESC
               LIMIT 1) AS lastOutcome
      FROM knock_log k
      WHERE k.lead_id IN (SELECT value FROM json_each(?))
      GROUP BY k.lead_id
    `).all(JSON.stringify(rows.map(r => r.id))) as Array<{ leadId: number; knockCount: number; lastKnockedAt: string; lastOutcome: string | null }>;
    const byLead = new Map(agg.map(a => [a.leadId, a]));
    for (const r of rows) {
      const a = byLead.get(r.id);
      r.knockCount = a?.knockCount ?? null;
      r.lastOutcome = a?.lastOutcome ?? null;
      r.lastKnockedAt = a?.lastKnockedAt ?? null;
    }
    return rows;
  }

  // Paged list query for /api/leads — filters + ORDER BY + LIMIT/OFFSET pushed
  // into SQL (the route used to hydrate EVERY tenant row to serve a 200-row
  // page). Count runs the same WHERE. Scope conditions identical to getLeads.
  getLeadsPage(
    tenantId: number | undefined,
    assignedRep: number | number[] | undefined,
    opts: LeadListOptions,
  ): { rows: LeadListRow[]; total: number } {
    const conditions = [];
    if (tenantId != null) conditions.push(eq(leads.tenantId, tenantId));
    if (Array.isArray(assignedRep)) {
      conditions.push(assignedRep.length ? inArray(leads.assignedRepId, assignedRep) : eq(leads.assignedRepId, -1));
    } else if (assignedRep != null) {
      conditions.push(eq(leads.assignedRepId, assignedRep));
    }
    if (opts.status) conditions.push(eq(leads.leadStatus, opts.status));
    if (opts.assignedRepId === "unassigned") conditions.push(isNull(leads.assignedRepId));
    else if (typeof opts.assignedRepId === "number") conditions.push(eq(leads.assignedRepId, opts.assignedRepId));
    if (opts.fiberStatus) conditions.push(eq(leads.fiberStatus, opts.fiberStatus));
    if (opts.zip) conditions.push(eq(leads.zip, opts.zip));
    if (opts.city) conditions.push(sql`lower(${leads.city}) = ${opts.city.toLowerCase()}`);
    if (opts.state) conditions.push(sql`lower(${leads.state}) = ${opts.state.toLowerCase()}`);
    if (opts.scannedSince) conditions.push(sql`${LEAD_SCAN_EPOCH_SQL} >= julianday(${opts.scannedSince})`);
    const where = conditions.length === 0 ? undefined
      : conditions.length === 1 ? conditions[0] : and(...conditions);
    const listQ = db.select(LEAD_LIST_COLUMNS).from(leads)
      .leftJoin(scanTargets, eq(leads.sourceScanTargetId, scanTargets.id));
    const order = opts.sort === "scanned_desc"
      ? [sql`${LEAD_SCAN_EPOCH_SQL} IS NULL`, desc(LEAD_SCAN_EPOCH_SQL), desc(leads.createdAt)]
      : [desc(leads.createdAt)];
    const rows = (where ? listQ.where(where) : listQ)
      .orderBy(...order).limit(opts.limit).offset(opts.offset).all();
    // The default list count is on every page load and needs no scan join.
    // Add that indexed PK join only when the recency predicate actually uses it.
    const countQ = opts.scannedSince
      ? db.select({ c: sql<number>`count(*)` }).from(leads)
          .leftJoin(scanTargets, eq(leads.sourceScanTargetId, scanTargets.id))
      : db.select({ c: sql<number>`count(*)` }).from(leads);
    const total = Number((where ? countQ.where(where) : countQ).get()?.c ?? 0);
    return { rows, total };
  }
  // Canonical-key lookup so a route can distinguish "already existed" from
  // "created" (createLead silently returns the existing row on duplicates).
  findLeadByAddress(tenantId: number | null, address: string, city: string, state: string, zip: string): Lead | undefined {
    const canonicalKey = normalizeKineticAddressKey(address ?? "", city ?? "", state ?? "", String(zip ?? ""));
    return rawDb.prepare("SELECT * FROM leads WHERE tenant_id IS ? AND canonical_key = ? LIMIT 1")
      .get(tenantId ?? getDefaultTenantId(), canonicalKey) as Lead | undefined;
  }
  createLead(lead: InsertLead): Lead {
    const now = new Date().toISOString();
    // Tenancy: never create a tenant-less lead — system paths (scanners, cron)
    // file under the default org; user paths stamp the actor's org in routes.
    const tenantId = (lead as any).tenantId ?? getDefaultTenantId();
    // One address = one lead: compute the canonical key, attach to an existing
    // lead if one shares it, and let the UNIQUE index be the final backstop so a
    // duplicate can never be inserted (a concurrent racer's insert throws
    // SQLITE_CONSTRAINT → resolve to the row that won).
    const canonicalKey = normalizeKineticAddressKey(lead.address ?? "", lead.city ?? "", lead.state ?? "", String((lead as any).zip ?? ""));
    const existing = rawDb.prepare("SELECT * FROM leads WHERE tenant_id IS ? AND canonical_key = ? LIMIT 1").get(tenantId, canonicalKey) as Lead | undefined;
    if (existing) return existing;
    try {
      const row = db.insert(leads).values({ ...lead, tenantId, canonicalKey, createdAt: now, updatedAt: now } as any).returning().get();
      bustPinCaches(row.tenantId);
      return row;
    } catch (e: any) {
      if (String(e?.message ?? "").includes("UNIQUE") || e?.code === "SQLITE_CONSTRAINT_UNIQUE" || e?.code === "SQLITE_CONSTRAINT") {
        const won = rawDb.prepare("SELECT * FROM leads WHERE tenant_id IS ? AND canonical_key = ? LIMIT 1").get(tenantId, canonicalKey) as Lead | undefined;
        if (won) return won;
      }
      throw e;
    }
  }

  // Dedup-safe insert: returns existing lead if address already in DB, otherwise creates new one.
  // Uses indexed address lookup — O(log n) not O(n) full table scan.
  upsertLeadByAddress(lead: InsertLead & LegacyScanFields): { lead: Lead; created: boolean } {
    const leadTenantId = lead.tenantId ?? getDefaultTenantId();
    // Canonical identity — the SAME key the UNIQUE index enforces, so "Farrell
    // Road" and "FARRELL RD" resolve to ONE lead. Check it FIRST (indexed) so
    // suffix/case variants attach instead of duplicating.
    const canonicalKey = normalizeKineticAddressKey(lead.address ?? "", lead.city ?? "Rockwell", lead.state ?? "NC", String(lead.zip ?? ""));
    const ckHit = rawDb.prepare("SELECT * FROM leads WHERE tenant_id IS ? AND canonical_key = ? LIMIT 1").get(leadTenantId, canonicalKey) as Lead | undefined;
    if (ckHit) return { lead: ckHit, created: false };

    // ── Existence check — ALWAYS hit the DB (indexed on address). The in-memory
    // cache is only a warmup hint; it can be stale across processes (e.g. a
    // separate scan process) or after out-of-band inserts, so it must NOT gate
    // correctness — otherwise a cache miss inserts a DUPLICATE lead and fires a
    // false "went live" alert. ──────────────────────────────────────────────────
    const exactHit = rawDb.prepare("SELECT * FROM leads WHERE tenant_id IS ? AND address = ? LIMIT 1")
      .get(leadTenantId, lead.address ?? "") as Lead | undefined;
    if (exactHit) return { lead: exactHit, created: false };
    // Case/whitespace-insensitive probe on the functional index idx_leads_addr_ci
    // (the expression must match the index's byte-for-byte). This replaces a
    // prefix-LIKE fallback that could not use ANY address index (case-insensitive
    // LIKE vs BINARY collation) and so walked the whole tenant on every net-new
    // insert — the scanner's hot path. Deliberate narrowing: the LIKE arm also
    // caught same-tenant street-SUFFIX variants ("Farrell Road" vs "FARRELL RD")
    // filed under a DIFFERENT city; the canonical-key probe above already folds
    // suffix/case variants whenever city+state agree, and the cross-city twin is
    // the projector's geo-guard's job, so that residual fuzzy match is dropped
    // rather than paid for with an O(tenant) walk per new address.
    const ciHit = rawDb.prepare(
      "SELECT * FROM leads WHERE tenant_id IS ? AND lower(trim(address)) = lower(trim(?)) LIMIT 1"
    ).get(leadTenantId, lead.address ?? "") as Lead | undefined;
    if (ciHit) return { lead: ciHit, created: false };

    // ── Insert: use raw prepared statement for reliability ──────────────────
    const now = new Date().toISOString();
    const stmt = rawDb.prepare(`
      INSERT INTO leads (
        address, city, state, zip, lat, lng,
        fiber_status, speed_tier, max_download,
        is_new_deployment, is_new_fiber, is_tenured,
        household_segment_type, billing_status, tech_type, chip_set_type,
        placement, max_qual, competitor_name, competitor_speed_mbps,
        competitor_tech, in_competitor_area, address_catalog_date,
        df_address_id, access_id, exchange_id, max_download_mbps,
        assigned_rep_id, lead_status, notes, deployment_notes,
        lead_tag, lead_score, tenant_id, canonical_key, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?
      )
      ON CONFLICT(tenant_id, canonical_key) WHERE canonical_key IS NOT NULL
        DO UPDATE SET updated_at=excluded.updated_at
      RETURNING id
    `);
    const r = stmt.get(
      lead.address ?? "",
      lead.city ?? "Rockwell",
      lead.state ?? "NC",
      lead.zip ?? "",
      lead.lat ?? null,
      lead.lng ?? null,
      lead.fiberStatus ?? "unknown",
      lead.speedTier ?? null,
      lead.maxDownload ?? null,
      lead.isNewDeployment ? 1 : 0,
      lead.isNewFiber ? 1 : 0,
      lead.isTenured ? 1 : 0,
      lead.householdSegmentType ?? null,
      lead.billingStatus ?? null,
      lead.techType ?? null,
      lead.chipSetType ?? null,
      lead.placement ?? null,
      lead.maxQual ?? null,
      lead.competitorName ?? null,
      lead.competitorSpeedMbps ?? null,
      lead.competitorTech ?? null,
      lead.inCompetitorArea ? 1 : 0,
      lead.addressCatalogDate ?? null,
      lead.dfAddressId ?? null,
      lead.accessId ?? null,
      lead.exchangeId ?? null,
      lead.maxDownloadMbps ?? null,
      lead.assignedRepId ?? null,
      lead.leadStatus ?? "prospect",
      lead.notes ?? null,
      lead.deploymentNotes ?? null,
      lead.leadTag ?? null,
      lead.leadScore ?? 0,
      leadTenantId, // scans file under the default org
      canonicalKey,
      now,
      now
    ) as { id: number } | undefined;
    // RETURNING id: on a canonical-key conflict this is the EXISTING row (attach,
    // never duplicate); on insert it is the new row. A concurrent scanner losing
    // the race resolves to the same survivor.
    const resolvedId = r?.id ?? (rawDb.prepare("SELECT id FROM leads WHERE tenant_id IS ? AND canonical_key = ? LIMIT 1").get(leadTenantId, canonicalKey) as { id: number } | undefined)?.id;
    const newLead = rawDb.prepare(`SELECT * FROM leads WHERE id = ?`).get(resolvedId) as Lead;
    // created ⇔ this call inserted the row: the insert stamps created_at=now,
    // while a conflict-attach leaves the survivor's older created_at untouched.
    const created = (newLead as any).createdAt === now || (newLead as any).created_at === now;
    bustPinCaches(newLead.tenantId);
    return { lead: newLead, created };
  }
  updateLead(id: number, updates: Partial<InsertLead>, tenantId?: number): Lead | undefined {
    const condition = tenantId != null
      ? and(eq(leads.id, id), eq(leads.tenantId, tenantId))
      : eq(leads.id, id);
    const row = db.update(leads).set({ ...updates, updatedAt: new Date().toISOString() })
      .where(condition).returning().get();
    if (row) {
      bustPinCaches(row.tenantId); // pins changed → cache + ETag version must move
      bumpLeaderboardEpoch(); // lead_status feeds the board's sold gate
    }
    return row;
  }
  // P1-1: compare-and-set outcome flip. A stale offline knock (knockedAt OLDER
  // than the lead's recorded last_outcome_at) loses the CAS — the update's WHERE
  // matches nothing — and the caller must then skip every side effect (status
  // was never flipped here, and reversal/commission-removal must not fire).
  applyKnockOutcomeCas(leadId: number, status: string, outcome: string, knockedAt: string): Lead | undefined {
    const now = new Date().toISOString();
    const row = db.update(leads).set({
      leadStatus: status,
      lastOutcome: outcome,
      lastOutcomeAt: knockedAt,
      updatedAt: now,
    }).where(and(
      eq(leads.id, leadId),
      or(
        isNull(leads.lastOutcomeAt),
        lt(leads.lastOutcomeAt, knockedAt),
        // GATE (heal): SELF-TOLERANCE — a replay of the knock that ALREADY owns
        // this exact outcome at this exact timestamp wins (idempotent re-apply
        // of its own money effects), while a DIFFERENT outcome owning the same
        // timestamp still supersedes it.
        and(
          eq(leads.lastOutcomeAt, knockedAt),
          eq(leads.leadStatus, status),
          eq(leads.lastOutcome, outcome),
        ),
      ),
    )).returning().get();
    if (row) {
      bustPinCaches(row.tenantId);
      bumpLeaderboardEpoch(); // the CAS flips lead_status — the sold gate reads it
    }
    return row;
  }
  deleteLead(id: number, tenantId?: number): LeadDeleteResult {
    // Dependent-row probe. knock_log / commissions / lead_photos hold the
    // field history (and money) for a door; deleting the lead underneath them
    // trips SQLITE_CONSTRAINT and used to surface as a raw 500. Counts are
    // returned so the route can tell the manager exactly what blocks it.
    const countDeps = () => ({
      knocks: (rawDb.prepare("SELECT COUNT(*) c FROM knock_log WHERE lead_id = ?").get(id) as { c: number }).c,
      commissions: (rawDb.prepare("SELECT COUNT(*) c FROM commissions WHERE lead_id = ?").get(id) as { c: number }).c,
      photos: (rawDb.prepare("SELECT COUNT(*) c FROM lead_photos WHERE lead_id = ?").get(id) as { c: number }).c,
    });
    // Probe + delete in ONE IMMEDIATE transaction: the write lock is taken up
    // front, so no knock/commission/photo can land between the check and the
    // delete and turn the guard itself into a FK 500.
    const tx = rawDb.transaction((): LeadDeleteResult => {
      const condition = tenantId != null
        ? and(eq(leads.id, id), eq(leads.tenantId, tenantId))
        : eq(leads.id, id);
      const exists = db.select({ id: leads.id }).from(leads).where(condition).get();
      if (!exists) return { deleted: false, reason: "not_found" };
      const deps = countDeps();
      if (deps.knocks > 0 || deps.commissions > 0 || deps.photos > 0) {
        return { deleted: false, reason: "has_history", ...deps };
      }
      return db.delete(leads).where(condition).run().changes > 0
        ? { deleted: true }
        : { deleted: false, reason: "not_found" };
    });
    let result: LeadDeleteResult;
    try {
      result = tx.immediate();
    } catch (e: any) {
      // Safety net: even with the probe, a dependent row family we don't count
      // (or a stricter FK in a migrated DB) can still trip the constraint.
      // Refuse with fresh counts — never let the manager see a raw 500.
      if (String(e?.code ?? "").startsWith("SQLITE_CONSTRAINT")) {
        return { deleted: false, reason: "has_history", ...countDeps() };
      }
      throw e;
    }
    if (result.deleted) bustPinCaches(tenantId); // undefined tenant → global bust
    return result;
  }

  // ── FCC-import purge ─────────────────────────────────────────────────────────
  // Bulk removal of FCC-imported doors (lead_tag family "fcc": exact "fcc" or
  // "fcc_<suffix>"). The underscore is a LIKE metachar, so it is escaped and
  // declared via ESCAPE exactly like mapWindowPred — "fccx" or "fcc-ish" tags can
  // never ride the wildcard in. The removal rule is CONSERVATIVE by design: a
  // door is removable only when NOTHING has ever happened at it —
  //   - lead_status still 'prospect' (the import-time initial status; a sold /
  //     follow-up / interested / not_interested / contacted door never matches),
  //   - no recorded outcome (last_outcome IS NULL),
  //   - zero knock_log rows (no field history, superseded or not),
  //   - no commission or commission-sale rows referencing it (money history),
  //   - no photos (field evidence = someone stood at that door),
  //   - not marked do-not-knock (a compliance record that must survive; deleting
  //     the row would let a future re-import resurrect the door).
  // When in doubt, a lead is PROTECTED. One WHERE, shared by the preview count
  // and the delete, so the numbers the admin confirmed are the rows removed.
  private fccPurgeWhere(tenantId?: number): { scope: string; fcc: string; removable: string; params: any[] } {
    const params: any[] = [];
    let scope = "1=1";
    if (tenantId != null) { scope = "l.tenant_id = ?"; params.push(tenantId); }
    const fcc = "(l.lead_tag = 'fcc' OR l.lead_tag LIKE 'fcc\\_%' ESCAPE '\\')";
    const removable = `
      l.lead_status = 'prospect'
      AND l.last_outcome IS NULL
      AND COALESCE(l.do_not_knock, 0) = 0
      AND NOT EXISTS (SELECT 1 FROM knock_log k WHERE k.lead_id = l.id)
      AND NOT EXISTS (SELECT 1 FROM commissions c WHERE c.lead_id = l.id)
      AND NOT EXISTS (SELECT 1 FROM commission_sales cs WHERE cs.lead_id = l.id)
      AND NOT EXISTS (SELECT 1 FROM lead_photos p WHERE p.lead_id = l.id)`;
    return { scope, fcc, removable, params };
  }

  countFccPurge(tenantId?: number): { total: number; removable: number; protected: number } {
    const { scope, fcc, removable, params } = this.fccPurgeWhere(tenantId);
    // One pass: total fcc-tagged doors in scope, with the removable subset
    // counted via the SAME correlated predicate the delete uses.
    const row = rawDb.prepare(`
      SELECT COUNT(*) AS total,
             COALESCE(SUM(CASE WHEN ${removable} THEN 1 ELSE 0 END), 0) AS removable
      FROM leads l
      WHERE ${scope} AND ${fcc}
    `).get(...params) as { total: number; removable: number };
    return { total: row.total, removable: row.removable, protected: row.total - row.removable };
  }

  purgeFccLeads(tenantId?: number): number {
    const { scope, fcc, removable, params } = this.fccPurgeWhere(tenantId);
    // One transaction, one set-based DELETE over the exact preview predicate.
    const removed = rawDb.transaction(() =>
      rawDb.prepare(`
        DELETE FROM leads
        WHERE id IN (
          SELECT l.id FROM leads l
          WHERE ${scope} AND ${fcc} AND ${removable}
        )
      `).run(...params).changes,
    )();
    // Pins changed → cache + ETag data version move, and the data-free
    // map-changed ping fires (same choke point deleteLead uses).
    if (removed > 0) bustPinCaches(tenantId);
    return removed;
  }

  // FCC adopt-on-tap (#61): a one-tap add onto an UNWORKED fcc-imported ghost
  // ADOPTS it — retags off fcc, drops it at the tapped rooftop, and hands it to
  // the tapping rep — instead of dead-ending on "already exists / no pin". The
  // guard is the EXACT "removable" notion the purge deletes with (fccPurgeWhere:
  // fcc-family tag + zero history), so a worked/sold/non-fcc/foreign row is left
  // untouched and the caller falls through to the honest-exists response.
  //
  // ATOMIC: one transaction, one UPDATE whose WHERE re-selects the row through
  // that same predicate (plus this lead's id, a tenant guard, and a "not another
  // rep's lead" guard) — so a non-adoptable row changes nothing and returns
  // undefined, and a second tap (now un-tagged) also matches nothing (idempotent,
  // no double-adopt). This is NOT a sale: no commission/statement/knock row is
  // read or written here.
  adoptFccLead(leadId: number, tenantId: number, opts: { repId: number | null; lat?: number | null; lng?: number | null }): Lead | undefined {
    const { scope, fcc, removable, params } = this.fccPurgeWhere(tenantId);
    return rawDb.transaction((): Lead | undefined => {
      const changed = rawDb.prepare(`
        UPDATE leads
        SET lead_tag = NULL,
            assigned_rep_id = ?,
            lat = COALESCE(?, lat),
            lng = COALESCE(?, lng),
            updated_at = ?
        WHERE id IN (
          SELECT l.id FROM leads l
          WHERE ${scope} AND ${fcc} AND ${removable}
            AND l.id = ?
            AND (l.assigned_rep_id IS NULL OR l.assigned_rep_id = ?)
        )
      `).run(
        opts.repId ?? null, opts.lat ?? null, opts.lng ?? null, new Date().toISOString(),
        ...params, leadId, opts.repId ?? null,
      ).changes;
      if (changed === 0) return undefined;
      // Pins changed (a ghost became a live, in-scope pin) → cache + ETag version
      // must move, same choke point every lead write uses.
      bustPinCaches(tenantId);
      return this.getLeadById(leadId, tenantId);
    })();
  }

  // Search with filters + pagination pushed into SQL. The filters MUST live in
  // the WHERE (not post-filter a capped set): a review proved the naive
  // `LIKE ... LIMIT 500` + JS-filter version silently returned 0 results for
  // search+status combos whose matches sorted past the first 500 rows, and
  // reported `total` capped at 500. ORDER BY makes truncation deterministic;
  // count(*) with the same WHERE keeps `total` exact.
  searchLeadsPage(
    query: string,
    tenantId: number | undefined,
    assignedRep: number | number[] | undefined,
    opts: LeadListOptions,
  ): { rows: LeadListRow[]; total: number } {
    // Escape LIKE wildcards in user input — a bare "%" must not match the table.
    const safe = query.replace(/[\\%_]/g, m => "\\" + m);
    const pat = `%${safe}%`;
    const esc = (col: any) => sql`${col} LIKE ${pat} ESCAPE '\\'`;
    const conditions: any[] = [or(esc(leads.address), esc(leads.city), esc(leads.zip), esc(leads.contactName))];
    if (tenantId != null) conditions.push(eq(leads.tenantId, tenantId));
    if (Array.isArray(assignedRep)) {
      conditions.push(assignedRep.length ? inArray(leads.assignedRepId, assignedRep) : eq(leads.assignedRepId, -1));
    } else if (assignedRep != null) {
      conditions.push(eq(leads.assignedRepId, assignedRep));
    }
    if (opts.status) conditions.push(eq(leads.leadStatus, opts.status));
    if (opts.assignedRepId === "unassigned") conditions.push(isNull(leads.assignedRepId));
    else if (typeof opts.assignedRepId === "number") conditions.push(eq(leads.assignedRepId, opts.assignedRepId));
    if (opts.fiberStatus) conditions.push(eq(leads.fiberStatus, opts.fiberStatus));
    if (opts.zip) conditions.push(eq(leads.zip, opts.zip));
    // ASCII lower() matches the JS toLowerCase for the A-Z names in this data;
    // if non-ASCII city names ever land, store a folded column instead.
    if (opts.city) conditions.push(sql`lower(${leads.city}) = ${opts.city.toLowerCase()}`);
    if (opts.state) conditions.push(sql`lower(${leads.state}) = ${opts.state.toLowerCase()}`);
    if (opts.scannedSince) conditions.push(sql`${LEAD_SCAN_EPOCH_SQL} >= julianday(${opts.scannedSince})`);
    const where = conditions.length === 1 ? conditions[0] : and(...conditions);
    const order = opts.sort === "scanned_desc"
      ? [sql`${LEAD_SCAN_EPOCH_SQL} IS NULL`, desc(LEAD_SCAN_EPOCH_SQL), desc(leads.createdAt)]
      : [desc(leads.createdAt)];
    const rows = db.select(LEAD_LIST_COLUMNS).from(leads)
      .leftJoin(scanTargets, eq(leads.sourceScanTargetId, scanTargets.id))
      .where(where).orderBy(...order).limit(opts.limit).offset(opts.offset).all();
    const countQ = opts.scannedSince
      ? db.select({ c: sql<number>`count(*)` }).from(leads)
          .leftJoin(scanTargets, eq(leads.sourceScanTargetId, scanTargets.id))
      : db.select({ c: sql<number>`count(*)` }).from(leads);
    const total = Number(countQ.where(where).get()?.c ?? 0);
    return { rows, total };
  }

  // ── Fiber checks ───────────────────────────────────────────────────────────
  createFiberCheck(check: InsertFiberCheck): FiberCheck {
    return db.insert(fiberChecks).values({ ...check, checkedAt: new Date().toISOString() }).returning().get();
  }
  getRecentChecks(limit = 100, tenantId?: number): FiberCheck[] {
    const q = db.select().from(fiberChecks);
    const scoped = tenantId != null ? q.where(eq(fiberChecks.tenantId, tenantId)) : q;
    return scoped.orderBy(desc(fiberChecks.checkedAt)).limit(limit).all();
  }

  // ── Team members ───────────────────────────────────────────────────────────
  getTeamMembers(tenantId?: number): TeamMember[] {
    const q = db.select().from(teamMembers);
    return (tenantId != null
      ? q.where(eq(teamMembers.tenantId, tenantId))
      : q).orderBy(teamMembers.name).all();
  }
  // Tenant-aware by option (see getLeadById). Omit tenantId → original behaviour.
  getTeamMemberById(id: number, tenantId?: number): TeamMember | undefined {
    const condition = tenantId != null ? and(eq(teamMembers.id, id), eq(teamMembers.tenantId, tenantId)) : eq(teamMembers.id, id);
    return db.select().from(teamMembers).where(condition).get();
  }
  createTeamMember(member: InsertTeamMember): TeamMember {
    // Rep colour is decided ONCE, here at creation, and persisted — RepPicker,
    // the map's rep tints, and a new area's default fill all read the stored
    // value through repColorOf(). Allocation: first REP_PALETTE hue not worn by
    // another ACTIVE member of the same tenant, where "worn" means the member's
    // EFFECTIVE colour (persisted ?? legacy hash) so pre-column rows keep their
    // hue reserved. Palette exhausted → NULL, and repColorOf degrades to the
    // hash exactly as it did before the column existed.
    const color = member.color != null ? member.color : this.allocateMemberColor(member.tenantId ?? null);
    const row = db.insert(teamMembers).values({ ...member, color, createdAt: new Date().toISOString() }).returning().get();
    bumpLeaderboardEpoch(); // the roster shapes the board's rows
    bumpTeamRosterEpoch(); // a new member can land under an existing lead
    return row;
  }
  private allocateMemberColor(tenantId: number | null): string | null {
    // Tenant wall in SQL (isNull matches the legacy tenant-less rows the JS
    // `?? null` compare used to keep), not a cross-tenant scan filtered here.
    const actives = tenantId == null
      ? db.select().from(teamMembers).where(and(eq(teamMembers.active, true), isNull(teamMembers.tenantId))).all()
      : db.select().from(teamMembers).where(and(eq(teamMembers.active, true), eq(teamMembers.tenantId, tenantId))).all();
    return allocateRepColor(actives.map((m) => repColorOf(m)));
  }
  updateTeamMember(id: number, updates: Partial<InsertTeamMember>, tenantId?: number): TeamMember | undefined {
    const condition = tenantId != null
      ? and(eq(teamMembers.id, id), eq(teamMembers.tenantId, tenantId))
      : eq(teamMembers.id, id);
    const row = db.update(teamMembers).set(updates).where(condition).returning().get();
    bumpLeaderboardEpoch(); // active flag / name changes reach the board
    bumpTeamRosterEpoch(); // reports_to moves re-shape a team_lead's scope
    return row;
  }
  deleteTeamMember(id: number, tenantId?: number): boolean {
    const condition = tenantId != null
      ? and(eq(teamMembers.id, id), eq(teamMembers.tenantId, tenantId))
      : eq(teamMembers.id, id);
    const deleted = db.delete(teamMembers).where(condition).run().changes > 0;
    if (deleted) { bumpLeaderboardEpoch(); bumpTeamRosterEpoch(); }
    return deleted;
  }
  /** Monotonic stamp of the roster's SHAPE — bumped by every create/update/
   *  delete above. Read by consumers that cache a derived reporting tree; a
   *  changed value means "re-derive", it carries no other meaning. */
  teamRosterEpoch(): number { return teamRosterEpoch; }

  // ── Knock log ──────────────────────────────────────────────────────────────
  // Default LIMIT pushed into SQL (mirrors getRecentKnocksByRep): knock_log
  // grows without bound, so an unbounded reader is a footgun every new call
  // site would inherit. Newest-first, so the cap keeps the recent slice.
  getKnocks(tenantId?: number, limit = 1000): Knock[] {
    const q = db.select().from(knockLog);
    return (tenantId != null ? q.where(eq(knockLog.tenantId, tenantId)) : q)
      .orderBy(desc(knockLog.knockedAt)).limit(limit).all();
  }
  getKnocksByLead(leadId: number): Knock[] {
    return db.select().from(knockLog).where(eq(knockLog.leadId, leadId)).orderBy(desc(knockLog.knockedAt)).all();
  }
  // LIMIT pushed into SQL: idx_knock_log_rep serves (rep_id = ?) and a reverse
  // scan of its rowid tail yields id DESC — the activity card reads 50 rows
  // instead of hydrating a season's worth of knocks per request.
  getRecentKnocksByRep(repId: number, limit: number): Knock[] {
    return db.select().from(knockLog).where(eq(knockLog.repId, repId))
      .orderBy(desc(knockLog.id)).limit(limit).all();
  }
  // The impossible-travel reference point for classifyKnockLocation: the rep's
  // newest located knock by effective timestamp (device_ts when present, else
  // knocked_at — matching the old JS `deviceTs ?? knockedAt` sort). Served by
  // the partial expression index idx_knock_log_rep_located, so the hot knock
  // write no longer hydrates + sorts the rep's entire history. Ties (identical
  // effective ts) break by id DESC; the old JS sort left tie order unspecified.
  getLatestLocatedKnockByRep(repId: number): { repLat: number; repLng: number; deviceTs: string | null; knockedAt: string } | undefined {
    return rawDb.prepare(
      `SELECT rep_lat AS repLat, rep_lng AS repLng, device_ts AS deviceTs, knocked_at AS knockedAt
         FROM knock_log
        WHERE rep_id = ? AND rep_lat IS NOT NULL AND rep_lng IS NOT NULL
        ORDER BY COALESCE(device_ts, knocked_at) DESC, id DESC
        LIMIT 1`
    ).get(repId) as { repLat: number; repLng: number; deviceTs: string | null; knockedAt: string } | undefined;
  }
  // Narrow projections for the territory progress/activity computations. Same
  // row sets as getLeads(tid)/getKnocks(tid) — the tenant wall is identical —
  // but selecting only the fields the math reads: the wide Drizzle hydration
  // was ~85% of the old /api/territories/progress latency (measured 596ms at
  // 20k leads + 50k knocks; these two reads were ~520ms of it).
  getLeadsForTerritoryProgress(tenantId?: number): TerritoryProgressLead[] {
    const where = tenantId != null ? "WHERE tenant_id = ?" : "";
    return rawDb.prepare(
      `SELECT id, address, city, state, zip, lat, lng,
              lead_status AS leadStatus, do_not_knock AS doNotKnock
         FROM leads ${where}`
    ).all(...(tenantId != null ? [tenantId] : [])) as TerritoryProgressLead[];
  }
  getKnocksForTerritoryProgress(tenantId?: number): TerritoryProgressKnock[] {
    const where = tenantId != null ? "WHERE tenant_id = ?" : "";
    // Six columns, no ORDER BY: the progress math is entirely order-independent
    // (counts, any-of flags, MAX timestamps) — the old full hydration paid a
    // sort plus ~25 extra columns per knock for nothing.
    return rawDb.prepare(
      `SELECT lead_id AS leadId, outcome, was_home AS wasHome,
              knocked_at AS knockedAt, verification_status AS verificationStatus,
              distance_m AS distanceM
         FROM knock_log ${where}`
    ).all(...(tenantId != null ? [tenantId] : [])) as TerritoryProgressKnock[];
  }
  // The per-area activity feed's knock rows — filtered IN SQL to the doors
  // inside the territory polygon (json_each carries the id set, so a 20k-lead
  // tenant doesn't hydrate 50k knocks to keep the ~1/territory-share it needs).
  // knocked_at DESC matches getKnocks' old ordering — the route's JS sort is
  // stable, so equal-timestamp rows keep the same relative order as before.
  getKnocksForTerritoryActivity(tenantId: number | undefined, leadIds: number[]): TerritoryActivityKnock[] {
    if (!leadIds.length) return [];
    const tenantAnd = tenantId != null ? "AND tenant_id = ?" : "";
    return rawDb.prepare(
      `SELECT id, lead_id AS leadId, rep_id AS repId, outcome,
              knocked_at AS knockedAt, device_ts AS deviceTs, server_ts AS serverTs,
              verification_status AS verificationStatus, distance_m AS distanceM,
              gps_accuracy AS gpsAccuracy, review_reason AS reviewReason,
              net_state AS netState, rep_lat AS repLat, rep_lng AS repLng
         FROM knock_log
        WHERE lead_id IN (SELECT value FROM json_each(?)) ${tenantAnd}
        ORDER BY knocked_at DESC`
    ).all(JSON.stringify(leadIds), ...(tenantId != null ? [tenantId] : [])) as TerritoryActivityKnock[];
  }
  // Address labels for a bounded id set (the 50-row activity card) — replaces
  // hydrating every lead in the tenant to read two columns off 50 of them.
  getLeadAddressesByIds(ids: number[], tenantId?: number): Array<{ id: number; address: string; city: string }> {
    if (!ids.length) return [];
    const ph = ids.map(() => "?").join(",");
    const tenantAnd = tenantId != null ? "AND tenant_id = ?" : "";
    return rawDb.prepare(
      `SELECT id, address, city FROM leads WHERE id IN (${ph}) ${tenantAnd}`
    ).all(...ids, ...(tenantId != null ? [tenantId] : [])) as Array<{ id: number; address: string; city: string }>;
  }
  // Narrow projection for /api/stats — identical scoping to getLeads (tenant
  // wall; array scope empty = match nothing, fail-closed), minus the full-row
  // hydration and the ORDER BY the aggregation loop never needed.
  getLeadStatsRows(tenantId?: number, assignedRep?: number | number[]): LeadStatsRow[] {
    const conds: string[] = [];
    const params: number[] = [];
    if (tenantId != null) { conds.push("tenant_id = ?"); params.push(tenantId); }
    if (Array.isArray(assignedRep)) {
      if (!assignedRep.length) return [];
      conds.push(`assigned_rep_id IN (${assignedRep.map(() => "?").join(",")})`);
      params.push(...assignedRep);
    } else if (assignedRep != null) {
      conds.push("assigned_rep_id = ?");
      params.push(assignedRep);
    }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    return rawDb.prepare(
      `SELECT lead_status AS leadStatus, fiber_status AS fiberStatus,
              is_new_fiber AS isNewFiber, is_tenured AS isTenured,
              assigned_rep_id AS assignedRepId, city, state,
              created_at AS createdAt, updated_at AS updatedAt
         FROM leads ${where}`
    ).all(...params) as LeadStatsRow[];
  }
  // Open follow-ups — TWO arms, because dispositions land in two places:
  //
  //  (1) Knock-scheduled callbacks: leads whose MOST-RECENT knock is a scheduled
  //      callback (the rep asked to come back and hasn't re-worked the door
  //      since). BUT central-disposition / bulk-status / PATCH write ONLY the
  //      leads row (no knock), so a knock callback is closed by a NEWER
  //      lead-level disposition (last_outcome_at > knocked_at) — unless that
  //      newer outcome is itself callback/follow_up, which re-affirms the debt
  //      and keeps the originally scheduled date.
  //  (2) Lead-level follow-ups: doors marked INTO follow_up centrally/bulk —
  //      lead_status='follow_up' with the lead columns newer than every knock
  //      (or no knocks at all). No schedule exists, so callbackDate derives
  //      from last_outcome_at's LOCAL date (falls in Today/Overdue, never
  //      vanishing from the date-grouped client); NULL-safe at every step.
  //
  // Arm 1's driver is the scheduled-callback partial index
  // (idx_knock_log_open_callback2): the CROSS JOIN pins the join order so the
  // few callback rows drive and leads is the inner PK seek — the planner used
  // to flip it and walk EVERY tenant lead per poll, probing knock_log per
  // lead. (CROSS JOIN is plain inner-join semantics in SQLite; only the order
  // is forced.) The correlated "latest knock" subquery rides
  // idx_knock_log_lead_time_desc (lead_id, knocked_at DESC, id DESC).
  // Rep-scoping by the door's CURRENT owner can be pushed into both arms via
  // opts.repIds (same predicate the route's JS filter applies: NULL owner
  // never matches, empty scope matches nothing — fail-closed).
  getOpenCallbacks(tenantId?: number, opts?: { repIds?: number[] }): OpenCallback[] {
    const repIds = opts?.repIds;
    if (repIds && repIds.length === 0) return [];
    const tenantAnd = tenantId != null ? "AND l.tenant_id = ?" : "";
    const repAnd = repIds ? `AND l.assigned_rep_id IN (${repIds.map(() => "?").join(",")})` : "";
    const armParams = [
      ...(tenantId != null ? [tenantId] : []),
      ...(repIds ?? []),
    ];
    const params = [...armParams, ...armParams];
    const rows = rawDb.prepare(`
      WITH open_knock_callbacks AS (
        SELECT
          k.lead_id AS leadId, k.rep_id AS repId, k.callback_date AS callbackDate,
          k.callback_time AS callbackTime, k.notes AS notes, k.knocked_at AS setAt
        FROM knock_log k
        CROSS JOIN leads l ON l.id = k.lead_id
        WHERE k.id = (
          SELECT k2.id FROM knock_log k2
          WHERE k2.lead_id = k.lead_id
          ORDER BY k2.knocked_at DESC, k2.id DESC
          LIMIT 1
        )
        AND k.outcome = 'callback'
        AND k.callback_date IS NOT NULL
        AND (
          l.last_outcome_at IS NULL
          OR l.last_outcome_at <= k.knocked_at
          OR l.last_outcome IN ('callback', 'follow_up')
        )
        ${tenantAnd}
        ${repAnd}
      )
      SELECT
        l.id AS leadId, l.address AS address, l.city AS city, l.state AS state, l.zip AS zip,
        l.lat AS lat, l.lng AS lng, l.lead_status AS leadStatus, l.lead_tag AS leadTag,
        l.lead_score AS leadScore, l.contact_name AS contactName,
        l.assigned_rep_id AS assignedRepId,
        c.repId, c.callbackDate, c.callbackTime, c.notes, c.setAt
      FROM open_knock_callbacks c
      JOIN leads l ON l.id = c.leadId
      UNION ALL
      SELECT
        l.id AS leadId, l.address AS address, l.city AS city, l.state AS state, l.zip AS zip,
        l.lat AS lat, l.lng AS lng, l.lead_status AS leadStatus, l.lead_tag AS leadTag,
        l.lead_score AS leadScore, l.contact_name AS contactName,
        l.assigned_rep_id AS assignedRepId,
        l.assigned_rep_id AS repId,
        COALESCE(date(l.last_outcome_at, 'localtime'), date('now', 'localtime')) AS callbackDate,
        NULL AS callbackTime,
        NULL AS notes,
        COALESCE(l.last_outcome_at, l.updated_at, l.created_at, datetime('now')) AS setAt
      FROM leads l
      WHERE l.lead_status = 'follow_up'
        ${tenantAnd}
        ${repAnd}
        -- Lead columns are the LATEST word on this door: no knock at all, or
        -- every knock is older than the lead-level disposition.
        AND NOT EXISTS (
          SELECT 1 FROM knock_log k WHERE k.lead_id = l.id
            AND (l.last_outcome_at IS NULL OR k.knocked_at >= l.last_outcome_at)
        )
        -- Already surfaced with its real schedule by arm 1 - never duplicate.
        AND l.id NOT IN (SELECT leadId FROM open_knock_callbacks)
    `).all(...params) as OpenCallback[];
    // Compound-SELECT ORDER BY can't use the COALESCE expression portably, and
    // the client sorts the same way — date asc, then time with nulls last.
    rows.sort((a, b) =>
      (a.callbackDate + (a.callbackTime ?? "99:99")).localeCompare(b.callbackDate + (b.callbackTime ?? "99:99")));
    return rows;
  }
  // ── Lead photos ─────────────────────────────────────────────────────────────
  // Tenancy comes from the LEAD (never client-supplied), same rule as knocks.
  createLeadPhoto(p: { leadId: number; userId?: number | null; repId?: number | null; path: string }): LeadPhoto {
    const tenantId = this.getLeadById(p.leadId)?.tenantId ?? null;
    return db.insert(leadPhotos).values({
      leadId: p.leadId, tenantId,
      userId: p.userId ?? null, repId: p.repId ?? null,
      path: p.path, createdAt: new Date().toISOString(),
    }).returning().get();
  }
  getLeadPhotos(leadId: number): LeadPhoto[] {
    return db.select().from(leadPhotos).where(eq(leadPhotos.leadId, leadId))
      .orderBy(desc(leadPhotos.createdAt)).all();
  }
  getLeadPhotoById(id: number): LeadPhoto | undefined {
    return db.select().from(leadPhotos).where(eq(leadPhotos.id, id)).get();
  }

  createKnock(knock: InsertKnock, verdict?: KnockVerdict): Knock {
    // Respect a client-supplied knockedAt — offline-queued knocks flush minutes or
    // hours after the tap, and the tap time is the truthful field timestamp.
    // The verdict fields (distance + verification) come ONLY from the server —
    // the client can never set them (insertKnockSchema omits them).
    // Tenancy: a knock belongs to its LEAD's tenant (never client-supplied).
    const tenantId = this.getLeadById(knock.leadId)?.tenantId ?? null;
    // GATE B2: timestamps are clamped at STORAGE level — garbage or
    // future-beyond-10min skew becomes server time. No code path (first-pass
    // CAS, dedupe replay, backfill) can ever see a poisoned value.
    const clientTs = typeof knock.knockedAt === "string" ? Date.parse(knock.knockedAt) : NaN;
    const safeTs = (Number.isFinite(clientTs) && clientTs <= Date.now() + 10 * 60_000)
      ? knock.knockedAt!
      : new Date().toISOString();
    // Pass attribution is derived the same way tenancy is — from the lead, at
    // insert, never from the client. Stamping it here rather than in the knock
    // route means every writer (online tap, offline queue flush, backfill) lands
    // in the right pass without having to know passes exist.
    const passNumber = currentPassForLead(knock.leadId);
    const row = db.insert(knockLog).values({
      ...knock,
      tenantId,
      passNumber,
      knockedAt: safeTs,
      ...(verdict ?? {}),
    }).returning().get();
    bumpLeaderboardEpoch();
    // Field-metrics attribution. Deliberately AFTER the knock is durable and
    // wrapped so nothing here can fail the disposition: a rep on a doorstep must
    // never lose a save because a reporting rollup had a bad day. Each of these
    // is separately try/caught inside its own module for the same reason.
    try {
      attachShiftAndDwell(row.id, knock.repId, knock.leadId, safeTs);
      markRepDayDirty(tenantId, knock.repId, Date.parse(safeTs) || Date.now());
    } catch { /* metrics are never load-bearing for a field write */ }
    return row;
  }
  getKnockById(id: number): Knock | undefined {
    return db.select().from(knockLog).where(eq(knockLog.id, id)).get();
  }
  // Idempotency lookup for the offline queue (see POST /api/leads/:id/knock).
  getKnockByClientId(clientId: string): Knock | undefined {
    return db.select().from(knockLog).where(eq(knockLog.clientId, clientId)).get();
  }
  // Note typed after the knock already flushed — only notes is writable.
  updateKnockNotes(id: number, notes: string): Knock | undefined {
    return db.update(knockLog).set({ notes }).where(eq(knockLog.id, id)).returning().get();
  }

  // ── App settings (KV) + geo verification config ─────────────────────────────
  // Platform-wide defaults live under the sentinel tenant bucket 0 so the unique
  // (tenant_id, key) index and upsert behave (SQLite treats NULLs as distinct).
  getSetting(key: string, tenantId?: number | null): string | undefined {
    const tid = tenantId ?? 0;
    if (tid !== 0) {
      const r = rawDb.prepare("SELECT value FROM app_settings WHERE key = ? AND tenant_id = ?").get(key, tid) as { value: string } | undefined;
      if (r) return r.value;
    }
    const g = rawDb.prepare("SELECT value FROM app_settings WHERE key = ? AND tenant_id = 0").get(key) as { value: string } | undefined;
    return g?.value;
  }
  setSetting(key: string, value: string, updatedBy?: number | null, tenantId?: number | null): void {
    const tid = tenantId ?? 0;
    rawDb.prepare(
      `INSERT INTO app_settings (tenant_id, key, value, updated_at, updated_by) VALUES (?,?,?,?,?)
       ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`
    ).run(tid, key, value, new Date().toISOString(), updatedBy ?? null);
    bumpTenantConfigVersion(); // always — see the memo's "bump always" rule
  }
  // Effective geo thresholds: stored override → platform default → code default.
  // Memoised on the tenant-config version stamp (setSetting bumps it) — this
  // runs two app_settings lookups on every knock write otherwise.
  getGeoConfig(tenantId?: number | null): GeoConfig {
    const entry = tenantConfigEntry(tenantId ?? 0);
    if (entry.geo === undefined) {
      const d = Number(this.getSetting("geo.max_distance_m", tenantId));
      const a = Number(this.getSetting("geo.max_accuracy_m", tenantId));
      entry.geo = {
        maxDistanceM: Number.isFinite(d) && d > 0 ? d : DEFAULT_GEO_CONFIG.maxDistanceM,
        maxAccuracyM: Number.isFinite(a) && a > 0 ? a : DEFAULT_GEO_CONFIG.maxAccuracyM,
      };
    }
    return entry.geo;
  }

  // ── Verification override (admin-only path; original capture is never mutated
  // except its verdict, and every change is logged immutably in activity_overrides). ─
  overrideKnockVerification(knockId: number, newStatus: string, reason: string, actorUserId: number | null, actorName: string | null): Knock | undefined {
    const prev = this.getKnockById(knockId);
    if (!prev) return undefined;
    rawDb.prepare(
      "INSERT INTO activity_overrides (knock_id, actor_user_id, actor_name, old_status, new_status, reason, at) VALUES (?,?,?,?,?,?,?)"
    ).run(knockId, actorUserId, actorName, prev.verificationStatus ?? null, newStatus, reason, new Date().toISOString());
    return db.update(knockLog)
      .set({ verificationStatus: newStatus, reviewReason: `override by ${actorName ?? "admin"}: ${reason}` })
      .where(eq(knockLog.id, knockId)).returning().get();
  }
  // Per-lead visit summary for the map: leadId → { count, lastOutcome, lastAt }.
  // Single window-function pass (was: a correlated subquery re-sorting each
  // lead's knocks per group — O(k·per-lead sort) and it scanned every tenant's
  // knocks on every map request). The window's mixed-direction ORDER BY is
  // served by idx_knock_log_lead_time_desc; optionally joined to one tenant.
  getVisitSummary(tenantId?: number): Map<number, { count: number; lastOutcome: string; lastAt: string }> {
    const tenantJoin = tenantId != null
      ? `JOIN leads ON leads.id = knock_log.lead_id AND leads.tenant_id = ?`
      : "";
    // Grouped aggregate + one indexed latest-row seek per lead, replacing the
    // window pass that sorted every knock (same rewrite as getLeadsForMap).
    // The correlated pick keeps the window's exact ordering — applied
    // (superseded = 0) rows first, then knocked_at DESC, id DESC.
    const rows = rawDb.prepare(
      `SELECT g.leadId, g.count, g.lastAt,
              (SELECT k2.outcome FROM knock_log k2
                WHERE k2.lead_id = g.leadId
                ORDER BY (k2.superseded = 0) DESC, k2.knocked_at DESC, k2.id DESC
                LIMIT 1) AS lastOutcome
         FROM (
           SELECT knock_log.lead_id AS leadId,
                  SUM(CASE WHEN knock_log.superseded = 0 THEN 1 ELSE 0 END) AS count,
                  MAX(knocked_at) AS lastAt
           FROM knock_log ${tenantJoin}
           GROUP BY knock_log.lead_id
         ) g`
    ).all(...(tenantId != null ? [tenantId] : [])) as any[];
    const m = new Map<number, { count: number; lastOutcome: string; lastAt: string }>();
    for (const r of rows) m.set(r.leadId, { count: r.count, lastOutcome: r.lastOutcome, lastAt: r.lastAt });
    return m;
  }

  // ── Leaderboard ────────────────────────────────────────────────────────────
  // ONE grouped aggregate scoped to the caller's tenant — no per-rep full-history
  // hydration, no cross-tenant scan (the old version SELECT *'d every knock of every
  // rep of EVERY tenant then filtered in JS on every poll). Uses idx_knock_log_rep.
  getLeaderboard(window?: { since?: string; until?: string }, tenantId?: number) {
    // Concurrent pollers share one compute per (tenant, window): valid while
    // the write epoch is unchanged AND the entry is young (see the epoch's
    // comment for what each leg covers). Callers never mutate the rows.
    const memoKey = `${tenantId ?? "all"}|${window?.since ?? ""}|${window?.until ?? ""}`;
    const now = Date.now();
    const hit = this._leaderboardCache.get(memoKey);
    if (hit && hit.epoch === leaderboardEpoch && now - hit.at >= 0 && now - hit.at < 10_000) return hit.value;
    const value = this.computeLeaderboard(window, tenantId);
    if (this._leaderboardCache.size >= 200) this._leaderboardCache.clear();
    this._leaderboardCache.set(memoKey, { epoch: leaderboardEpoch, at: now, value });
    return value;
  }
  private _leaderboardCache = new Map<string, { epoch: number; at: number; value: { rep: TeamMember; knocks: number; contacts: number; callbacks: number; sales: number; knocksToday: number; salesToday: number }[] }>();
  private computeLeaderboard(window?: { since?: string; until?: string }, tenantId?: number) {
    const reps = this.getTeamMembers(tenantId).filter(r => r.active);
    if (reps.length === 0) return [];
    // Midnight in the ORG's timezone, not the container's.
    //
    // This was `new Date().setHours(0,0,0,0)`, which is midnight wherever the
    // process happens to run — UTC in production, while the org runs Eastern.
    // That put the boundary at 20:00 ET the PREVIOUS evening, and the evening
    // half of that error is the damaging one: at 8pm ET, mid-shift, UTC midnight
    // rolls and the whole day's knocking drops off the board. A rep 60 doors
    // into their day watches the count reset to zero. (Before 8pm it errs the
    // other way, folding last night's knocks into today.)
    //
    // Same resolution every other "today" surface uses — earningsTodayStore,
    // spiffCampaignStore, momentumSpiffStore, doorDropStore, teamFeedStore and
    // knockMilestoneStore all read commission_timezone. A cross-tenant call
    // (tenantId undefined) has no single org day, so it falls back to the
    // default workweek zone rather than silently reverting to container time.
    const midnight = new Date(localDayStartMs(tenantId, Date.now()));
    const w = (col = "") => `(@since IS NULL OR k.knocked_at >= @since) AND (@until IS NULL OR k.knocked_at <= @until)${col}`;
    // A SALE only counts while it is still TRUE. `superseded = 0` alone is not
    // that: it records whether a knock lost the CAS when it was WRITTEN, so an
    // accidental "sold" corrected by a NEWER knock kept its flag — the rep fixed
    // the door, the commission reversed, and the leaderboard still showed the
    // sale. Two extra conditions close both correction paths:
    //   rn = 1                    — the sold knock is the lead's latest applied
    //                               knock (a corrective knock demotes it);
    //   l.lead_status = 'sold'    — the lead still IS sold (a manager status
    //                               edit writes no knock row, so recency alone
    //                               would miss it).
    // Knocks/contacts/callbacks intentionally still count every applied knock —
    // those are effort history, not live claims about the door's state.
    //
    // "Latest applied knock" (the old rn = 1) is now a NOT EXISTS probe instead
    // of a ROW_NUMBER window: the window sorted EVERY applied knock in the table
    // on every poll (~95ms of the call at 50k knocks) to compute a rank that
    // only 'sold' rows ever read. The probe asks the equivalent question — no
    // newer applied knock exists for this lead, ties broken by id exactly as
    // the window's ORDER BY did — and runs only for the rows whose CASE reaches
    // it, riding idx_knock_log_lead_time_desc (lead_id, knocked_at DESC, id DESC).
    const sold = (extra = "") =>
      `k.outcome = 'sold' AND l.lead_status = 'sold' AND NOT EXISTS (
         SELECT 1 FROM knock_log kn
          WHERE kn.lead_id = k.lead_id AND kn.superseded = 0
            AND (kn.knocked_at > k.knocked_at
                 OR (kn.knocked_at = k.knocked_at AND kn.id > k.id))
       )${extra}`;
    const rows = rawDb.prepare(
      `SELECT k.rep_id AS repId,
         SUM(CASE WHEN ${w()} THEN 1 ELSE 0 END) AS knocks,
         SUM(CASE WHEN ${w(" AND k.was_home = 1")} THEN 1 ELSE 0 END) AS contacts,
         SUM(CASE WHEN ${w(" AND k.outcome = 'callback'")} THEN 1 ELSE 0 END) AS callbacks,
         SUM(CASE WHEN ${w(` AND ${sold()}`)} THEN 1 ELSE 0 END) AS sales,
         SUM(CASE WHEN k.knocked_at >= @midnight THEN 1 ELSE 0 END) AS knocksToday,
         SUM(CASE WHEN k.knocked_at >= @midnight AND ${sold()} THEN 1 ELSE 0 END) AS salesToday
       FROM knock_log k
       JOIN team_members t ON t.id = k.rep_id
       LEFT JOIN leads l ON l.id = k.lead_id
       WHERE k.superseded = 0
         AND (@tenantId IS NULL OR t.tenant_id = @tenantId) AND t.active = 1
       GROUP BY k.rep_id`
    ).all({ since: window?.since ?? null, until: window?.until ?? null, midnight: midnight.toISOString(), tenantId: tenantId ?? null }) as any[];
    const byRep = new Map(rows.map(r => [r.repId, r]));
    return reps.map(rep => {
      const c: any = byRep.get(rep.id) ?? {};
      return {
        rep,
        knocks: c.knocks ?? 0, contacts: c.contacts ?? 0, callbacks: c.callbacks ?? 0,
        sales: c.sales ?? 0, knocksToday: c.knocksToday ?? 0, salesToday: c.salesToday ?? 0,
      };
    }).sort((a, b) => b.sales - a.sales || b.contacts - a.contacts || b.knocks - a.knocks);
  }

  // ── Users ──────────────────────────────────────────────────────────────────
  getUserByEmail(email: string): User | undefined {
    return db.select().from(users).where(eq(users.email, email.toLowerCase())).get();
  }
  getUserById(id: number): User | undefined {
    return db.select().from(users).where(eq(users.id, id)).get();
  }
  getAllUsers(tenantId?: number): User[] {
    const q = db.select().from(users);
    return (tenantId != null ? q.where(eq(users.tenantId, tenantId)) : q).all();
  }
  createUser(user: InsertUser): User {
    // Tenancy: a login account inherits its linked team member's tenant when the
    // caller didn't set one (covers syncLoginAccount + admin user creation).
    const tenantId = (user as any).tenantId
      ?? (user.teamMemberId != null ? this.getTeamMemberById(user.teamMemberId)?.tenantId ?? null : null);
    return db.insert(users).values({ ...user, tenantId, email: user.email.toLowerCase(), createdAt: new Date().toISOString() }).returning().get();
  }
  updateUser(id: number, updates: Partial<InsertUser>, tenantId?: number): User | undefined {
    const condition = tenantId != null
      ? and(eq(users.id, id), eq(users.tenantId, tenantId))
      : eq(users.id, id);
    return db.update(users).set(updates).where(condition).returning().get();
  }
  deleteUser(id: number, tenantId?: number): boolean {
    const condition = tenantId != null
      ? and(eq(users.id, id), eq(users.tenantId, tenantId))
      : eq(users.id, id);
    return db.delete(users).where(condition).run().changes > 0;
  }
  isFirstRun(): boolean {
    return !db.select().from(users).where(eq(users.role, "admin")).get();
  }

  // ── Sessions ───────────────────────────────────────────────────────────────
  createSession(userId: number): Session {
    const id = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    return db.insert(sessions).values({ id, userId, expiresAt, createdAt: new Date().toISOString() }).returning().get();
  }
  getSession(id: string): Session | undefined {
    const now = new Date().toISOString();
    return db.select().from(sessions).where(and(eq(sessions.id, id), gt(sessions.expiresAt, now))).get();
  }
  /** SLIDING RENEWAL — an app in active use must NEVER expire under the rep.
   * The original TTL was absolute from login, so a session minted 7 days ago
   * died at whatever moment the rep happened to be working: reliably mid-shift,
   * mid-knock. Every authenticated request now pushes the deadline back to a
   * full TTL ahead, so the only way to be signed out is genuinely not opening
   * the app for the whole window. Bounded two ways: an absolute cap from
   * createdAt (a lost/stolen device can't stay valid forever), and a slack
   * threshold so a burst of knocks doesn't turn every request into a DB write.
   * Best-effort: a failed renewal must never break an otherwise-valid request. */
  touchSession(session: Session): Session {
    try {
      const now = Date.now();
      const created = Date.parse(session.createdAt ?? "") || now;
      const target = Math.min(now + SESSION_TTL_MS, created + SESSION_ABSOLUTE_MAX_MS);
      const current = Date.parse(session.expiresAt) || 0;
      if (target - current <= SESSION_RENEW_SLACK_MS) return session;
      const expiresAt = new Date(target).toISOString();
      db.update(sessions).set({ expiresAt }).where(eq(sessions.id, session.id)).run();
      return { ...session, expiresAt };
    } catch {
      return session; // transient write contention — the session is still valid
    }
  }
  deleteSession(id: string): void {
    db.delete(sessions).where(eq(sessions.id, id)).run();
  }
  // Sign out everywhere — invalidate EVERY session for a user (logout-all-devices
  // / after a password or role change). Returns how many were revoked.
  deleteSessionsByUser(userId: number): number {
    return db.delete(sessions).where(eq(sessions.userId, userId)).run().changes;
  }

  // ── OTP ────────────────────────────────────────────────────────────────────
  createOtp(email: string): string {
    const normalized = email.toLowerCase();
    // Cryptographically-secure code (Math.random is a predictable non-CSPRNG whose
    // state is recoverable from prior outputs — unacceptable for a sole auth factor).
    const code = String(crypto.randomInt(100000, 1000000));
    // Invalidate any still-live prior codes for this email so only the newest code
    // is ever valid — re-requesting must not widen the guessable set.
    db.update(otpCodes).set({ used: true })
      .where(and(eq(otpCodes.email, normalized), eq(otpCodes.used, false))).run();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    db.insert(otpCodes).values({ email: normalized, code, expiresAt, createdAt: new Date().toISOString() }).run();
    return code;
  }
  verifyOtp(email: string, code: string): boolean {
    const now = new Date().toISOString();
    const em = email.toLowerCase();
    const otp = db.select().from(otpCodes)
      .where(and(eq(otpCodes.email, em), eq(otpCodes.code, code),
        eq(otpCodes.used, false), gt(otpCodes.expiresAt, now))).get();
    if (!otp) {
      // Wrong/expired guess: count it against the email's live codes and burn them
      // once too many misses accumulate, so the code can't be brute-forced within
      // its window (survives restarts / multi-instance, unlike the in-memory limiter).
      try {
        rawDb.prepare(`UPDATE otp_codes SET failed_attempts = failed_attempts + 1 WHERE email = ? AND used = 0 AND expires_at > ?`).run(em, now);
        rawDb.prepare(`UPDATE otp_codes SET used = 1 WHERE email = ? AND used = 0 AND failed_attempts >= 5`).run(em);
      } catch { /* pre-migration */ }
      return false;
    }
    db.update(otpCodes).set({ used: true }).where(eq(otpCodes.id, otp.id)).run();
    return true;
  }

  // ── Territories ────────────────────────────────────────────────────────────
  getTerritories(tenantId?: number): Territory[] {
    const q = db.select().from(territories);
    return (tenantId != null ? q.where(eq(territories.tenantId, tenantId)) : q).all();
  }
  getTerritoriesByRep(repId: number, tenantId?: number): Territory[] {
    // A rep sees a territory if they're the primary repId OR in assignee_ids
    // (multi-rep/shared), and it isn't archived.
    // The rule (assignee_ids authoritative, repId only for legacy rows) lives in
    // shared/territory.ts. It was written out longhand here and paraphrased in
    // two other places, and both paraphrases checked repId first — which hands a
    // reclaimed area back to the rep it was taken from, the exact guarantee
    // reclaim exists to provide. One definition, three callers.
    return this.getTerritories(tenantId).filter(
      (t: any) => t.status !== "archived" && territoryHeldByAny(t, [repId]),
    );
  }
  // Tenant-aware by option (see getLeadById). Omit tenantId → original behaviour.
  getTerritoryById(id: number, tenantId?: number): Territory | undefined {
    const condition = tenantId != null ? and(eq(territories.id, id), eq(territories.tenantId, tenantId)) : eq(territories.id, id);
    return db.select().from(territories).where(condition).get();
  }
  // Leads currently linked to a territory (area-sync). Full-row hydration, so
  // it is a READ helper, not the way to move an area's doors — the lifecycle
  // routes used to hydrate the whole area here only to diff it and write it
  // back one row at a time, and now use the set-based primitives below.
  getLeadsByTerritory(territoryId: number): Lead[] {
    return db.select().from(leads).where(eq(leads.assignedTerritoryId, territoryId)).all();
  }
  // Set-based territory hand-offs: ONE UPDATE inside one transaction, replacing
  // the per-lead updateLead loops the territory lifecycle routes ran — a
  // 2,000-door area used to pay 2,000 UPDATE..RETURNING statements plus 2,000
  // pin-cache busts on the synchronous thread. Field semantics mirror those
  // loops exactly:
  //   assign   — assigned_rep_id = repId, assignment_source (defaults to
  //              'territory-sync'), assigned_at = at; unassigned_at untouched.
  //   unassign — assigned_rep_id + assignment_source cleared, unassigned_at =
  //              at; assigned_at untouched, and the territory LINK kept —
  //              released doors STAY LINKED to the area (see /unassign's crew
  //              rule; only delete/reclaim-to-pool clears the link).
  // updated_at = at moves the cross-process leads data version the same way
  // updateLead's stamp does; the pin caches are busted ONCE, after the write,
  // with the rows' own tenant. Both ride idx_leads_assigned_territory and
  // return the changed-row count.
  bulkAssignTerritoryLeads(opts: { territoryId: number; repId: number; at: string; assignmentSource?: string }): number {
    const tx = rawDb.transaction((): { changes: number; tenantId: number | null | undefined } => {
      const owner = rawDb.prepare(
        `SELECT tenant_id AS tenantId FROM leads WHERE assigned_territory_id = ? LIMIT 1`
      ).get(opts.territoryId) as { tenantId: number | null } | undefined;
      const changes = rawDb.prepare(
        `UPDATE leads SET assigned_rep_id = @repId, assigned_territory_id = @territoryId,
                assignment_source = @source, assigned_at = @at, updated_at = @at
          WHERE assigned_territory_id = @territoryId`
      ).run({
        repId: opts.repId, territoryId: opts.territoryId,
        source: opts.assignmentSource ?? "territory-sync", at: opts.at,
      }).changes;
      return { changes, tenantId: owner?.tenantId };
    });
    const { changes, tenantId } = tx.immediate();
    if (changes > 0) bustPinCaches(tenantId);
    return changes;
  }
  bulkUnassignTerritoryLeads(opts: { territoryId: number; at: string }): number {
    const tx = rawDb.transaction((): { changes: number; tenantId: number | null | undefined } => {
      const owner = rawDb.prepare(
        `SELECT tenant_id AS tenantId FROM leads WHERE assigned_territory_id = ? LIMIT 1`
      ).get(opts.territoryId) as { tenantId: number | null } | undefined;
      const changes = rawDb.prepare(
        `UPDATE leads SET assigned_rep_id = NULL, assignment_source = NULL,
                unassigned_at = @at, updated_at = @at
          WHERE assigned_territory_id = @territoryId`
      ).run({ territoryId: opts.territoryId, at: opts.at }).changes;
      return { changes, tenantId: owner?.tenantId };
    });
    const { changes, tenantId } = tx.immediate();
    if (changes > 0) bustPinCaches(tenantId);
    return changes;
  }

  // ── Set-based territory lead writes, part two ────────────────────────────
  //
  // The two primitives above move an area's WHOLE door list. The three below
  // are the ones the lifecycle routes actually needed and could not express
  // with a blanket update, so each kept its per-lead `updateLead` loop:
  //
  //   share    — must not touch a co-assignee's doors (a blanket update steals
  //              them and resets their assigned_at);
  //   reclaim  — return_to_pool must also clear the AREA LINK, which
  //              bulkUnassignTerritoryLeads deliberately preserves;
  //   unassign — must reach ONE rep's doors, and retires the assignment
  //              paperwork (assigned_by/assigned_at) as well.
  //
  // All three share one shape: the WHERE clause IS the diff the loop used to
  // walk row by row, so the count is honest without inspecting anything twice.
  //
  // NO leaderboard bump, on purpose. `updateLead` bumps it because it can flip
  // lead_status, which the board's sold gate reads. computeLeaderboard groups
  // knock_log by rep_id and touches exactly one leads column — lead_status —
  // so moving an ASSIGNMENT cannot change a board number, and bumping would
  // throw away every viewer's memoised aggregate for nothing.
  //
  /** SELECT the doors that move, then move them in ONE UPDATE driven by those
   *  exact ids — both inside one transaction, so the ids the caller replays
   *  events from and the rows the statement wrote are the same set, and one
   *  pin-cache bust after it commits (never inside: a rollback would leave an
   *  announced change that never happened). json_each carries the id list as a
   *  single bound parameter, so a 20k-door area is still one statement. */
  private moveTerritoryLeads(spec: {
    where: string; whereParams: Record<string, unknown>;
    set: string; setParams: Record<string, unknown>;
  }): TerritoryLeadWrite {
    const tx = rawDb.transaction((): TerritoryLeadWrite & { owner?: number | null } => {
      const rows = rawDb.prepare(
        `SELECT id, tenant_id AS tenantId FROM leads WHERE ${spec.where}`
      ).all(spec.whereParams) as Array<{ id: number; tenantId: number | null }>;
      if (rows.length === 0) return { changed: 0, leadIds: [] };
      const leadIds = rows.map(r => r.id);
      const changed = rawDb.prepare(
        `UPDATE leads SET ${spec.set} WHERE id IN (SELECT value FROM json_each(@ids))`
      ).run({ ...spec.setParams, ids: JSON.stringify(leadIds) }).changes;
      return { changed, leadIds, owner: rows[0].tenantId };
    });
    const { changed, leadIds, owner } = tx.immediate();
    if (changed > 0) bustPinCaches(owner);
    return { changed, leadIds };
  }
  // Hand the area's doors to `repId` — but a door one of `keepRepIds` already
  // holds is NOT a hand-off, it is that rep's work, and re-stamping it would
  // both steal it and restart its "assigned since" clock. The crew that stays
  // on the area keeps exactly what it had.
  bulkAssignTerritoryLeadsExcept(opts: {
    territoryId: number; repId: number; at: string; keepRepIds: number[];
    assignmentSource?: string; tenantId?: number;
  }): TerritoryLeadWrite {
    const whereParams: Record<string, unknown> = {
      territoryId: opts.territoryId,
      keep: JSON.stringify(opts.keepRepIds.map(Number)),
    };
    if (opts.tenantId != null) whereParams.tenantId = opts.tenantId;
    return this.moveTerritoryLeads({
      // NOT IN never matches a NULL left operand, so an unheld door has to be
      // named on its own — and those are precisely the doors a hand-off picks up.
      where: `assigned_territory_id = @territoryId
                ${opts.tenantId != null ? "AND tenant_id = @tenantId" : ""}
                AND (assigned_rep_id IS NULL
                     OR assigned_rep_id NOT IN (SELECT value FROM json_each(@keep)))`,
      whereParams,
      set: `assigned_rep_id = @repId, assigned_territory_id = @territoryId,
            assignment_source = @source, assigned_at = @at, updated_at = @at`,
      setParams: {
        repId: Number(opts.repId), territoryId: opts.territoryId,
        source: opts.assignmentSource ?? "territory-sync", at: opts.at,
      },
    });
  }
  // Empty the area: every door somebody still holds goes back to the open pool
  // — no rep AND no area, because the area itself is being given up. (Contrast
  // bulkUnassignTerritoryLeads, which keeps the link: there the area lives on.)
  // A door already in the pool is not selected, so it keeps whatever link it
  // has and never inflates the count.
  bulkReturnTerritoryLeadsToPool(opts: { territoryId: number; at: string; tenantId?: number }): TerritoryLeadWrite {
    const whereParams: Record<string, unknown> = { territoryId: opts.territoryId };
    if (opts.tenantId != null) whereParams.tenantId = opts.tenantId;
    return this.moveTerritoryLeads({
      where: `assigned_territory_id = @territoryId AND assigned_rep_id IS NOT NULL
              ${opts.tenantId != null ? "AND tenant_id = @tenantId" : ""}`,
      whereParams,
      set: `assigned_rep_id = NULL, assigned_territory_id = NULL,
            assignment_source = NULL, unassigned_at = @at, updated_at = @at`,
      setParams: { at: opts.at },
    });
  }
  // Take ONE rep off the area's doors. The AREA KEEPS THEM: a shared patch the
  // co-assignees still walk must not lose ground because one person left, so
  // assigned_territory_id stays put and only the person goes. The assignment
  // paperwork goes with them — assigned_by/assigned_at name a hand-off that is
  // over, and left behind they print "assigned by Mona" under an empty owner.
  bulkReleaseTerritoryLeadsFromRep(opts: { territoryId: number; repId: number; at: string; tenantId?: number }): TerritoryLeadWrite {
    const whereParams: Record<string, unknown> = { territoryId: opts.territoryId, repId: Number(opts.repId) };
    if (opts.tenantId != null) whereParams.tenantId = opts.tenantId;
    return this.moveTerritoryLeads({
      where: `assigned_territory_id = @territoryId AND assigned_rep_id = @repId
              ${opts.tenantId != null ? "AND tenant_id = @tenantId" : ""}`,
      whereParams,
      set: `assigned_rep_id = NULL, assignment_source = NULL,
            assigned_by = NULL, assigned_at = NULL,
            unassigned_at = @at, updated_at = @at`,
      setParams: { at: opts.at },
    });
  }
  // Immutable territory history
  addTerritoryEvent(territoryId: number, actorUserId: number | null, type: string, payload?: unknown): void {
    try {
      rawDb.prepare("INSERT INTO territory_events (territory_id, actor_user_id, type, payload, at) VALUES (?,?,?,?,datetime('now'))")
        .run(territoryId, actorUserId ?? null, type, payload != null ? JSON.stringify(payload) : null);
    } catch (e: any) { console.warn("territory event log failed:", e.message); }
  }
  // Immutable lead history (assignment + note events; status changes live in
  // knock_log). Append-only O(1) writes; reads are index-backed and capped.
  addLeadEvent(leadId: number, type: "assignment" | "note", actor: string | null, detail?: unknown): void {
    try {
      rawDb.prepare("INSERT INTO lead_events (lead_id, type, actor, detail, at) VALUES (?,?,?,?,?)")
        .run(leadId, type, actor ?? null, detail != null ? JSON.stringify(detail) : null, new Date().toISOString());
    } catch (e: any) { console.warn("lead event log failed:", e.message); }
  }
  // Append-only STATUS event with EXPLICIT attribution — the store for a Central
  // Mark. `displayActor` is the customer-facing label ("Central Admin"); the
  // real actor + assignee live in `detail` for audit. Idempotent on idemKey:
  // INSERT OR IGNORE means a replay is a no-op. The display name is NEVER derived
  // from a rep id, cached user, prior event, or fallback identity.
  recordLeadStatusEvent(input: {
    leadId: number; displayActor: string; source: string; outcome: string; newStatus: string;
    prevStatus: string | null; actorUserId: number | null; actorName: string | null;
    assignee: number | null; idemKey?: string | null; at?: string;
  }): { inserted: boolean } {
    const detail = JSON.stringify({
      source: input.source, outcome: input.outcome, newStatus: input.newStatus, prevStatus: input.prevStatus,
      actorUserId: input.actorUserId, actorName: input.actorName, assignee: input.assignee,
    });
    const r = rawDb.prepare(
      `INSERT OR IGNORE INTO lead_events (lead_id, type, actor, detail, at, idem_key) VALUES (?,?,?,?,?,?)`,
    ).run(input.leadId, "status_change", input.displayActor, detail, input.at ?? new Date().toISOString(), input.idemKey ?? null);
    return { inserted: r.changes === 1 };
  }
  getLeadEvents(leadId: number, limit = 100): { id: number; leadId: number; type: string; actor: string | null; detail: any; at: string }[] {
    return (rawDb.prepare("SELECT id, lead_id AS leadId, type, actor, detail, at FROM lead_events WHERE lead_id = ? ORDER BY at DESC, id DESC LIMIT ?")
      .all(leadId, limit) as any[])
      .map((r: any) => ({ ...r, detail: r.detail ? (() => { try { return JSON.parse(r.detail); } catch { return null; } })() : null }));
  }
  getTerritoryEvents(territoryId: number): any[] {
    return rawDb.prepare("SELECT id, territory_id AS territoryId, actor_user_id AS actorUserId, type, payload, at FROM territory_events WHERE territory_id = ? ORDER BY at DESC, id DESC").all(territoryId)
      .map((r: any) => ({ ...r, payload: r.payload ? (() => { try { return JSON.parse(r.payload); } catch { return null; } })() : null }));
  }
  createTerritory(t: InsertTerritory): Territory {
    const row = db.insert(territories).values({ ...t, createdAt: new Date().toISOString() }).returning().get();
    // Unconditional: repCanAccessLead memoises on this stamp, and a bump that
    // reasons about which fields matter is a bump that will eventually reason
    // wrong — in the direction of granting access.
    bumpTerritoryVersion();
    recordAssigneeChange(row);
    return row;
  }
  updateTerritory(id: number, updates: Partial<InsertTerritory>, tenantId?: number): Territory | undefined {
    const cond = tenantId != null ? and(eq(territories.id, id), eq(territories.tenantId, tenantId)) : eq(territories.id, id);
    const row = db.update(territories).set(updates).where(cond).returning().get();
    bumpTerritoryVersion();
    // Only when the holder list was part of THIS write. Recording on every
    // update — a rename, a colour change — would be harmless but noisy, and
    // reading assignee_ids off a row the caller did not touch invites drift.
    if (row && "assigneeIds" in updates) recordAssigneeChange(row);
    return row;
  }
  deleteTerritory(id: number, tenantId?: number): boolean {
    const cond = tenantId != null ? and(eq(territories.id, id), eq(territories.tenantId, tenantId)) : eq(territories.id, id);
    const gone = db.delete(territories).where(cond).run().changes > 0;
    bumpTerritoryVersion();
    return gone;
  }

  // ── Territory Requests ─────────────────────────────────────────────────────
  // TENANT WALL. These three carried no tenant predicate at all, so any
  // manager could read every organization's requests (including rep-authored
  // free text) and flip another org's rows. The scope is enforced in SQL —
  // callers pass their session tenant and cannot widen it.
  getTerritoryRequests(status?: string, tenantId?: number): TerritoryRequest[] {
    const preds = [] as any[];
    if (status) preds.push(eq(territoryRequests.status, status));
    if (tenantId != null) preds.push(eq(territoryRequests.tenantId, tenantId));
    if (!preds.length) return db.select().from(territoryRequests).all();
    return db.select().from(territoryRequests).where(preds.length === 1 ? preds[0] : and(...preds)).all();
  }
  createTerritoryRequest(repId: number, userId: number, message?: string, tenantId?: number | null): TerritoryRequest {
    return db.insert(territoryRequests).values({ repId, userId, tenantId: tenantId ?? null, message: message || null, createdAt: new Date().toISOString() }).returning().get();
  }
  updateTerritoryRequest(id: number, status: string, tenantId?: number): TerritoryRequest | undefined {
    const where = tenantId != null
      ? and(eq(territoryRequests.id, id), eq(territoryRequests.tenantId, tenantId))
      : eq(territoryRequests.id, id);
    return db.update(territoryRequests).set({ status }).where(where).returning().get();
  }

  // ── Rep Applications ───────────────────────────────────────────────────────
  getRepApplications(status?: string, tenantId?: number): RepApplication[] {
    const conds = [] as any[];
    if (status) conds.push(eq(repApplications.status, status));
    if (tenantId != null) conds.push(eq(repApplications.tenantId, tenantId));
    const q = db.select().from(repApplications);
    return (conds.length ? q.where(and(...conds)) : q).all();
  }
  getRepApplicationById(id: number): RepApplication | undefined {
    return db.select().from(repApplications).where(eq(repApplications.id, id)).get();
  }
  createRepApplication(app: any): RepApplication {
    return db.insert(repApplications).values({ ...app, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }).returning().get();
  }
  updateRepApplication(id: number, updates: Partial<RepApplication>): RepApplication | undefined {
    return db.update(repApplications).set({ ...updates, updatedAt: new Date().toISOString() }).where(eq(repApplications.id, id)).returning().get();
  }

  // ── GPS Location Pings ─────────────────────────────────────────────────────
  createLocationPing(ping: InsertLocationPing): LocationPing {
    return db.insert(locationPings).values({ ...ping, pingAt: new Date().toISOString() }).returning().get();
  }
  getLatestPingPerRep(tenantId?: number): LocationPing[] {
    // location_pings has no tenant_id column — scope through the rep's tenant by
    // restricting to team members in that tenant, so one org never sees another
    // org's live rep locations.
    //
    // One indexed pick per rep (idx_location_pings_rep rides (rep_id, ping_at))
    // instead of hydrating and sorting the ENTIRE ping table on every poll —
    // pings accrete forever (~1/min/rep while clocked in), so the old full-scan
    // grew without bound (measured 125ms at 60k pings, and climbing). The
    // grouped MAX picks each rep's newest ping (id DESC breaks exact-timestamp
    // ties deterministically; the old sort left tie order unspecified), and the
    // outer ORDER BY preserves the previous newest-first output order.
    // Shift-length recency window. Without it, every rep who EVER pinged
    // rendered on the Live Map forever — a green "online" marker at a weeks-old
    // location ("4380h ago" was observed). 8 hours covers any live shift while
    // letting the map mean what its legend says.
    const freshCutoff = new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString();
    const tenantWhere = tenantId != null
      ? "AND g.rep_id IN (SELECT id FROM team_members WHERE tenant_id = ?)"
      : "";
    return rawDb.prepare(
      `SELECT p.id, p.rep_id AS repId, p.user_id AS userId, p.lat, p.lng,
              p.accuracy, p.ping_at AS pingAt
         FROM (SELECT rep_id FROM location_pings GROUP BY rep_id) g
         JOIN location_pings p ON p.id = (
           SELECT p2.id FROM location_pings p2
            WHERE p2.rep_id = g.rep_id
            ORDER BY p2.ping_at DESC, p2.id DESC
            LIMIT 1)
        WHERE p.ping_at >= ? ${tenantWhere}
        ORDER BY p.ping_at DESC`
    ).all(...(tenantId != null ? [freshCutoff, tenantId] : [freshCutoff])) as LocationPing[];
  }
  getPingsByRep(repId: number, limit = 50): LocationPing[] {
    return db.select().from(locationPings).where(eq(locationPings.repId, repId))
      .orderBy(desc(locationPings.pingAt)).limit(limit).all();
  }

  // ── Clock Sessions ─────────────────────────────────────────────────────────
  clockIn(repId: number, userId: number, notes?: string): ClockSession {
    const now = new Date().toISOString();
    const date = now.slice(0, 10);
    // Tenancy: a clock session belongs to the REP's tenant.
    const tenantId = this.getTeamMemberById(repId)?.tenantId ?? null;
    return db.insert(clockSessions).values({ repId, userId, tenantId, clockedIn: now, date, notes: notes || null }).returning().get();
  }
  clockOut(sessionId: number): ClockSession | undefined {
    const session = db.select().from(clockSessions).where(eq(clockSessions.id, sessionId)).get();
    if (!session || session.clockedOut) return undefined;
    const now = new Date().toISOString();
    const durationMinutes = Math.round((Date.now() - new Date(session.clockedIn).getTime()) / 60000);
    return db.update(clockSessions).set({ clockedOut: now, durationMinutes })
      .where(eq(clockSessions.id, sessionId)).returning().get();
  }
  getActiveClockSession(repId: number): ClockSession | undefined {
    return db.select().from(clockSessions)
      .where(and(eq(clockSessions.repId, repId), isNull(clockSessions.clockedOut))).get();
  }
  getAllClockSessions(date?: string, tenantId?: number): ClockSession[] {
    const conds = [] as any[];
    if (tenantId != null) conds.push(eq(clockSessions.tenantId, tenantId));
    if (date) conds.push(eq(clockSessions.date, date));
    const q = db.select().from(clockSessions);
    return (conds.length ? q.where(and(...conds)) : q).orderBy(desc(clockSessions.clockedIn)).all();
  }

  // ── Scan targets (persistent address pool) ───────────────────────────────────
  // Insert harvested addresses once; duplicates are ignored (unique by
  // address + city + state — a same-street-name house in ANOTHER city is now a
  // distinct row, not silently dropped), so the pool grows without re-geocoding.
  // Returns how many NEW rows were added.
  // Insert new pool addresses AND enrich existing ones. A row discovered from
  // Provider observations may arrive with an address identifier,
  // provider coords, and current status — so it lands complete and needs no
  // Mapbox geocode and no immediate re-scan. Re-harvesting an existing address
  // backfills any missing df_address_id / coords / zip (e.g. a Mapbox-seeded row
  // getting its real Kinetic id) but never clobbers status history — that stays
  // owned by recordScanTargetResult's vetted transition logic. Returns the count
  // of NET-NEW rows (enrichment of existing rows is not counted).
  upsertScanTargets(addrs: Array<{
    address: string; city?: string; state?: string; zip?: string;
    lat?: number | null; lng?: number | null; source?: string; tenantId?: number | null;
    canonicalKey?: string | null;
    dfAddressId?: string | null;
    // When the row came from an actual Kinetic probe, pass its result so the row
    // lands already-scanned (baseline) rather than needing a follow-up check.
    scannedNow?: boolean; fiberStatus?: string | null; isNewFiber?: boolean; billingStatus?: string | null;
  }>): number {
    if (!addrs.length) return 0;
    const insertStmt = rawDb.prepare(
      `INSERT OR IGNORE INTO scan_targets
         (address, city, state, zip, lat, lng, source, tenant_id, canonical_key, df_address_id,
          last_fiber_status, last_is_new_fiber, last_billing_status, last_scanned_at, scan_count, created_at)
       VALUES (@address,@city,@state,@zip,@lat,@lng,@source,@tenantId,@canonicalKey,@df,
               @fs,@nf,@bs,@scannedAt,@scanCount,datetime('now'))`
    );
    // Enrichment backfills identity fields ONLY when the stored value is absent —
    // first writer wins on everything, and status is never touched here. Matched
    // on (address, city, state) so a same-street-name row in ANOTHER city can
    // never have its df id / coords overwritten with the wrong city's data.
    const enrichStmt = rawDb.prepare(
      `UPDATE scan_targets SET
         df_address_id = COALESCE(df_address_id, @df),
         canonical_key = COALESCE(canonical_key, @canonicalKey),
         lat = COALESCE(lat, @lat),
         lng = COALESCE(lng, @lng),
         zip = CASE WHEN (zip IS NULL OR zip='') THEN @zip ELSE zip END
       WHERE address = @address AND lower(city) = lower(@city) AND lower(state) = lower(@state)`
    );
    // When a Kinetic probe answers an address that was pooled but NEVER scanned
    // (e.g. a Mapbox-seeded row), record that baseline result so the row counts as
    // scanned — otherwise the nightly re-probes an address Kinetic just answered
    // (double proxy spend) and market counts undercount. Only touches never-scanned
    // rows; an already-scanned row's status stays owned by recordScanTargetResult.
    const baselineStmt = rawDb.prepare(
      `UPDATE scan_targets SET
         last_fiber_status = @fs, last_is_new_fiber = @nf, last_billing_status = @bs,
         last_scanned_at = @scannedAt, scan_count = 1, inconclusive_attempts = 0
       WHERE address = @address AND lower(city) = lower(@city) AND lower(state) = lower(@state)
         AND last_scanned_at IS NULL`
    );
    // CANONICAL-TWIN guard — the #1 duplicate factory (forensics: 14,759 rows).
    // Two OSM-fed pipelines spell the same house differently ("New Cut Road" vs
    // "NEW CUT RD"); the raw-string unique index sees two strings and a second
    // row was minted. The canonical key folds spelling variants, so a re-spelled
    // house now ENRICHES the existing row instead of inserting a twin. The key
    // is computed HERE (callers can no longer forget it) and stamped on every
    // new row so the canonical lookup keeps getting stronger.
    const twinStmt = rawDb.prepare(
      `SELECT id FROM scan_targets WHERE tenant_id IS @tenantId AND canonical_key = @canonicalKey LIMIT 1`,
    );
    // POSTAL-CITY ALIAS twin (the Stonewyck Salisbury/Lexington split): the
    // SAME premise geocoded under two postal cities has two canonical keys
    // (city is in the key), so the guard above misses it and spend/coverage
    // split. Identity-first-geo-second: same normalized street (street_key) +
    // same state + same leading house number + coordinates within ~25m. Never
    // rounded-coordinate-only — genuine neighbors survive; distinct units
    // differ in street_key's retained unit token and never merge.
    const cityAliasTwinStmt = rawDb.prepare(
      `SELECT id FROM scan_targets
        WHERE tenant_id IS @tenantId AND street_key = @streetKey
          AND upper(trim(state)) = upper(trim(@state))
          AND (address = @houseNum OR address LIKE @houseNum || ' %')
          AND lat BETWEEN @lat - 0.00023 AND @lat + 0.00023
          AND lng BETWEEN @lng - 0.00028 AND @lng + 0.00028
        LIMIT 1`,
    );
    const enrichByIdStmt = rawDb.prepare(
      `UPDATE scan_targets SET
         df_address_id = COALESCE(df_address_id, @df),
         lat = COALESCE(lat, @lat),
         lng = COALESCE(lng, @lng),
         zip = CASE WHEN (zip IS NULL OR zip='') THEN @zip ELSE zip END
       WHERE id = @id`,
    );
    const baselineByIdStmt = rawDb.prepare(
      `UPDATE scan_targets SET
         last_fiber_status = @fs, last_is_new_fiber = @nf, last_billing_status = @bs,
         last_scanned_at = @scannedAt, scan_count = 1, inconclusive_attempts = 0
       WHERE id = @id AND last_scanned_at IS NULL`,
    );
    const tx = rawDb.transaction((rows: typeof addrs) => {
      let n = 0;
      for (const r of rows) {
        if (!r.address) continue;
        const scanned = !!r.scannedNow;
        // Compute the canonical identity in ONE place. A blank street part
        // yields a degenerate key ("|city|state") — never dedupe on that.
        const streetPart = canonicalAddressPart(r.address);
        const canonicalKey = streetPart
          ? (r.canonicalKey ?? normalizeKineticAddressKey(r.address, r.city ?? "", r.state ?? "NC", r.zip ?? ""))
          : (r.canonicalKey ?? null);
        const params = {
          address: r.address, city: r.city ?? "", state: r.state ?? "NC", zip: r.zip ?? "",
          lat: r.lat ?? null, lng: r.lng ?? null, source: r.source ?? null, tenantId: r.tenantId ?? null,
          canonicalKey,
          df: r.dfAddressId ?? null,
          fs: scanned ? (r.fiberStatus ?? null) : null,
          nf: scanned && r.isNewFiber ? 1 : 0,
          bs: scanned ? (r.billingStatus ?? null) : null,
          scannedAt: scanned ? new Date().toISOString() : null,
          scanCount: scanned ? 1 : 0,
        };
        // A canonical twin under a DIFFERENT raw spelling → enrich it, never
        // insert. (The raw-string INSERT OR IGNORE below only catches exact
        // spelling matches.)
        if (streetPart && canonicalKey) {
          const twin = twinStmt.get({ tenantId: r.tenantId ?? null, canonicalKey }) as { id: number } | undefined;
          if (twin) {
            if (r.dfAddressId || r.lat != null || r.lng != null || r.zip) {
              enrichByIdStmt.run({ id: twin.id, df: r.dfAddressId ?? null, lat: r.lat ?? null, lng: r.lng ?? null, zip: r.zip ?? "" });
            }
            if (scanned) baselineByIdStmt.run({ id: twin.id, fs: params.fs, nf: params.nf, bs: params.bs, scannedAt: params.scannedAt });
            continue;
          }
          // Same premise filed under an ALIAS postal city → attach, never insert.
          const houseNum = r.address.trim().split(/\s+/)[0] ?? "";
          if (/^\d+[A-Za-z]?$/.test(houseNum) && r.lat != null && r.lng != null) {
            try {
              const aliasTwin = cityAliasTwinStmt.get({
                tenantId: r.tenantId ?? null,
                streetKey: streetKeyOf(r.address),
                state: r.state ?? "NC",
                houseNum,
                lat: r.lat, lng: r.lng,
              }) as { id: number } | undefined;
              if (aliasTwin) {
                if (r.dfAddressId || r.zip) {
                  enrichByIdStmt.run({ id: aliasTwin.id, df: r.dfAddressId ?? null, lat: null, lng: null, zip: r.zip ?? "" });
                }
                if (scanned) baselineByIdStmt.run({ id: aliasTwin.id, fs: params.fs, nf: params.nf, bs: params.bs, scannedAt: params.scannedAt });
                continue;
              }
            } catch { /* street_key column absent on bare replay DBs — alias guard is best-effort */ }
          }
        }
        const inserted = insertStmt.run(params).changes;
        n += inserted;
        if (!inserted) {
          const key = { address: r.address, city: r.city ?? "", state: r.state ?? "NC" };
          // Backfill identity (df/coords/zip) — same-city only.
          if (r.dfAddressId || r.lat != null || r.lng != null || r.zip) {
            enrichStmt.run({ ...key, canonicalKey, df: r.dfAddressId ?? null,
              lat: r.lat ?? null, lng: r.lng ?? null, zip: r.zip ?? "" });
          }
          // Record a baseline status for a never-scanned existing row.
          if (scanned) {
            baselineStmt.run({ ...key, fs: params.fs, nf: params.nf, bs: params.bs, scannedAt: params.scannedAt });
          }
        }
      }
      return n;
    });
    return tx.immediate(addrs);
  }
  // Oldest-scanned (and never-scanned) targets first — the re-scan queue. Skips
  // never-scanned rows that have been probed inconclusive `INCONCLUSIVE_GIVEUP`+
  // times (exhausted — Kinetic doesn't recognize them; re-probing burns proxy $ for
  // nothing). Already-scanned rows are never parked — the nightly moat keeps
  // re-checking them so a real unavailable→live flip is still caught.
  // Two index-aligned arms replacing an OR predicate that forced a full-table
  // sort per planning call (the WAL-pinning shape yieldRollups.ts documents).
  // The predicate algebra is exact: (NULL ∧ attempts<giveup) ∪ (NOT NULL)
  // ≡ (NOT NULL ∨ attempts<giveup). Arm 1 rides idx_scan_targets_reprobe,
  // arm 2 idx_scan_targets_scanned; the outer ORDER BY re-sorts at most
  // 2×limit rows and pins the original ordering contract — never-scanned
  // first, then oldest-scanned ascending.
  getScanTargetsToRescan(limit: number): any[] {
    // The union sits inside a subselect because a compound SELECT's ORDER BY
    // may only name result columns, not expressions.
    return rawDb.prepare(
      `SELECT * FROM (
         SELECT * FROM (
           SELECT * FROM scan_targets
            WHERE last_scanned_at IS NULL AND inconclusive_attempts < ?
            ORDER BY last_scanned_at LIMIT ?)
         UNION ALL
         SELECT * FROM (
           SELECT * FROM scan_targets
            WHERE last_scanned_at IS NOT NULL
            ORDER BY last_scanned_at ASC LIMIT ?)
       ) ORDER BY (last_scanned_at IS NOT NULL), last_scanned_at ASC LIMIT ?`
    ).all(INCONCLUSIVE_GIVEUP, limit, limit, limit);
  }
  // Pool lookup by city — lets scans reuse already-harvested addresses instead
  // of re-geocoding (harvest once, re-scan free).
  getScanTargetsByCity(city: string, state: string): any[] {
    return rawDb.prepare(
      `SELECT address, city, state, zip, lat, lng FROM scan_targets
       WHERE lower(city) = lower(?) AND lower(state) = lower(?)`
    ).all(city.trim(), state.trim());
  }
  // Record a primary-provider scan result. Returns the previous classification so
  // callers can detect a change; publication still requires independent evidence.
  recordScanTargetResult(id: number, r: { fiberStatus?: string | null; fiberAvailable?: boolean; isNewFiber?: boolean; billingStatus?: string | null; dfAddressId?: string | null; accessId?: string | null; serviceKey?: string | null; convertedToLeadId?: number | null; availabilityStatus?: string | null; newlyLive?: boolean; customerSegment?: string; customerConfidence?: string; customerSignals?: string[]; frontierControl?: string | null }): { prevIsNewFiber: boolean } {
    const prev = rawDb.prepare("SELECT last_is_new_fiber, last_fiber_status, last_billing_status FROM scan_targets WHERE id = ?").get(id) as any;
    rawDb.prepare(
      `UPDATE scan_targets SET last_fiber_status=@fs, last_is_new_fiber=@nf, last_billing_status=@bs,
         access_id=COALESCE(@accessId,access_id), service_key=COALESCE(@serviceKey,service_key),
         last_fiber_available=COALESCE(@fiberAvailable,last_fiber_available),
         last_customer_segment=COALESCE(@customerSegment,last_customer_segment),
         last_customer_confidence=COALESCE(@customerConfidence,last_customer_confidence),
         last_customer_signals=COALESCE(@customerSignals,last_customer_signals),
         df_address_id=COALESCE(@df, df_address_id),
         frontier_control=COALESCE(@frontierControl, frontier_control),
         converted_to_lead_id=COALESCE(@lead, converted_to_lead_id),
         last_availability_status=COALESCE(@avail, last_availability_status),
         -- first-seen-LIVE marks a proven unavailable→fiber flip (the "Newly Lit" signal).
         first_seen_live_at=CASE WHEN @newly=1 AND first_seen_live_at IS NULL THEN datetime('now') ELSE first_seen_live_at END,
         -- first-seen-FIBER is stamped on a flip OR the first time Kinetic reports NEW
         -- FIBER (its own new-build signal), so NEW FIBER + billing N qualifies as a
         -- Fresh Lead candidate without waiting for a prior unavailable observation.
         first_seen_fiber_at=CASE WHEN (@newly=1 OR @nf=1) AND first_seen_fiber_at IS NULL THEN datetime('now') ELSE first_seen_fiber_at END,
         -- a conclusive answer clears the inconclusive streak (belt-and-suspenders:
         -- the row also leaves the never-scanned pool now that last_scanned_at is set)
         inconclusive_attempts=0,
         -- Unchanged-negative streak for the yield engine's adaptive recheck
         -- cadence (yieldRollups.ts): +1 per conclusive negative, reset by a
         -- conclusive positive, untouched otherwise. Maintained HERE - in the
         -- same UPDATE every conclusive result already flows through - so no
         -- separate query ever has to derive it from availability_snapshots.
         neg_streak=CASE WHEN @fiberAvailable=0 THEN neg_streak+1
                         WHEN @fiberAvailable=1 THEN 0
                         ELSE neg_streak END,
         last_scanned_at=datetime('now'), scan_count=scan_count+1 WHERE id=@id`
    ).run({
      id, fs: r.fiberStatus ?? null, nf: r.isNewFiber ? 1 : 0, bs: r.billingStatus ?? null,
      df: r.dfAddressId ?? null, accessId: r.accessId ?? null, serviceKey: r.serviceKey ?? null,
      frontierControl: r.frontierControl ?? null,
      lead: r.convertedToLeadId ?? null,
      avail: r.availabilityStatus ?? null, newly: r.newlyLive ? 1 : 0,
      fiberAvailable: r.fiberAvailable == null ? null : (r.fiberAvailable ? 1 : 0),
      customerSegment: r.customerSegment ?? null,
      customerConfidence: r.customerConfidence ?? null,
      customerSignals: r.customerSignals ? JSON.stringify(r.customerSignals) : null,
    });
    // Permanent transition feed: any classification CHANGE (dark→live, copper→
    // fiber, →coming soon, regressions) is recorded once. Cheap no-op when the
    // verdict is unchanged.
    try {
      recordTransition(id, {
        fiberStatus: prev?.last_fiber_status ?? null,
        isNewFiber: !!(prev && prev.last_is_new_fiber),
        billingStatus: prev?.last_billing_status ?? null,
      }, {
        fiberStatus: r.fiberStatus ?? prev?.last_fiber_status ?? null,
        isNewFiber: r.isNewFiber ?? !!(prev && prev.last_is_new_fiber),
        billingStatus: r.billingStatus ?? prev?.last_billing_status ?? null,
        fiberAvailable: r.fiberAvailable ?? null,
      });
    } catch { /* the feed must never break result recording */ }
    return { prevIsNewFiber: !!(prev && prev.last_is_new_fiber) };
  }
  // Count ONE inconclusive probe against a pooled address (by id, or by its globally
  // unique address). At INCONCLUSIVE_GIVEUP the row is "exhausted" and the re-probe
  // selectors (getScanTargetsToRescan + loadCityPoolAddresses) skip it. No-op if the
  // address isn't pooled (e.g. a fringe candidate that never got persisted) or the
  // row was already conclusively answered (last_scanned_at set) — we never park a row
  // that has a real answer. Idempotent per (address, run): callers bump once per probe.
  bumpScanTargetInconclusive(ref: { id?: number; address?: string }): number {
    // RETURNING gives the caller the truthful needs-fix count in the same
    // statement — the engine's address_not_found terminal counts THESE (real
    // needs-fix non-answers), never raw claim attempts, so throttle/fail-closed
    // retries can no longer inflate an address toward a terminal verdict.
    // .all() (never .get()) so the UPDATE fully completes even when the address
    // variant matches multiple rows — an early-reset RETURNING statement can
    // stop short of updating the rest.
    const sql = (where: string) =>
      `UPDATE scan_targets
         SET inconclusive_attempts = inconclusive_attempts + 1, last_inconclusive_at = datetime('now')
       WHERE ${where} AND last_scanned_at IS NULL
       RETURNING inconclusive_attempts`;
    const rows = (ref.id != null
      ? rawDb.prepare(sql("id = ?")).all(ref.id)
      : ref.address
        ? rawDb.prepare(sql("address = ?")).all(ref.address)
        : []) as Array<{ inconclusive_attempts: number }>;
    return rows.reduce((m, r) => Math.max(m, r.inconclusive_attempts), 0);
  }
  // One pass for the three counters (the unindexed last_is_new_fiber test made
  // the old shape pay a separate full table scan on top of the two index
  // walks); MAX stays its own statement so it keeps the O(log N) seek off
  // idx_scan_targets_scanned instead of joining the scan.
  getScanTargetStats(): { total: number; scanned: number; neverScanned: number; newFiber: number; lastScannedAt: string | null } {
    const agg = rawDb.prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(last_scanned_at IS NOT NULL), 0) AS scanned,
              COALESCE(SUM(last_is_new_fiber = 1), 0) AS newFiber
         FROM scan_targets`
    ).get() as { total: number; scanned: number; newFiber: number };
    const lastScannedAt = (rawDb.prepare("SELECT MAX(last_scanned_at) m FROM scan_targets").get() as any).m ?? null;
    return { total: agg.total, scanned: agg.scanned, neverScanned: agg.total - agg.scanned, newFiber: agg.newFiber, lastScannedAt };
  }

  // ── Commissions ────────────────────────────────────────────────────────────
  getCommissions(tenantId?: number, repId?: number): Commission[] {
    const conds = [] as any[];
    if (tenantId != null) conds.push(eq(commissions.tenantId, tenantId));
    if (repId != null) conds.push(eq(commissions.repId, repId));
    const q = db.select().from(commissions);
    return (conds.length ? q.where(and(...conds)) : q).orderBy(desc(commissions.createdAt)).all();
  }
  // Indexed lookup, not a scan: this runs on every sold knock, and getCommissions
  // would read the whole tenant's ledger to answer a single-row question.
  findLiveCommissionForLead(tenantId: number | null | undefined, leadId: number): Commission | undefined {
    const conds = [
      eq(commissions.leadId, leadId),
      inArray(commissions.status, LIVE_COMMISSION_STATUSES as unknown as string[]),
    ];
    if (tenantId != null) conds.push(eq(commissions.tenantId, tenantId));
    return db.select().from(commissions).where(and(...conds)).limit(1).get();
  }
  getCommissionById(id: number, tenantId: number): Commission | undefined {
    return db.select().from(commissions)
      .where(and(eq(commissions.id, id), eq(commissions.tenantId, tenantId)))
      .get();
  }
  createCommission(c: InsertCommission): Commission {
    // Tenancy: a commission belongs to the REP's tenant (unless explicitly set).
    const tenantId = (c as any).tenantId ?? this.getTeamMemberById(c.repId)?.tenantId ?? null;
    try {
      return db.insert(commissions).values({ ...c, tenantId, createdAt: new Date().toISOString() }).returning().get();
    } catch (e: any) {
      // P1-2: idx_commissions_tenant_lead_pending guarantees at most ONE pending
      // commission per (tenant, lead). A duplicate sold knock (offline retry with
      // a fresh clientId, double-tap) hits the index — return the EXISTING
      // pending row instead of fabricating a second payout.
      if (e?.message?.includes("UNIQUE constraint failed") && c.leadId != null) {
        const existing = db.select().from(commissions).where(and(
          eq(commissions.leadId, c.leadId),
          eq(commissions.status, "pending"),
          tenantId == null ? isNull(commissions.tenantId) : eq(commissions.tenantId, tenantId),
        )).get();
        if (existing) {
          // REVIEWER GATE: flag pre-existence so callers can answer honestly
          // (POST /api/commissions must not audit a phantom creation).
          return { ...existing, preExisting: true } as Commission & { preExisting?: boolean };
        }
      }
      throw e;
    }
  }
  transitionLegacyCommission(command: LegacyCommissionMutationCommand): LegacyCommissionMutationResult {
    const transact = rawDb.transaction((): LegacyCommissionMutationResult => {
      const existing = this.getCommissionById(command.id, command.tenantId);
      if (!existing) return { kind: "not_found" };
      if (existing.revision !== command.expectedRevision) return { kind: "stale" };

      const plan = planLegacyCommissionTransition(existing, command, command.actorUserId);
      if (!plan.ok) {
        if (plan.code === "STALE_VERSION") return { kind: "stale" };
        return { kind: "rejected", code: plan.code, message: plan.message };
      }
      if (!plan.changed) return { kind: "unchanged", commission: existing };

      const update = rawDb.prepare(
        `UPDATE commissions
            SET status = ?, paid_date = ?, notes = ?, approved_by = ?,
                revision = revision + 1
          WHERE id = ? AND tenant_id = ? AND status = ? AND revision = ?`,
      ).run(
        plan.next.status,
        plan.next.paidDate,
        plan.next.notes,
        plan.next.approvedBy,
        command.id,
        command.tenantId,
        command.expectedStatus,
        command.expectedRevision,
      );
      if (update.changes !== 1) return { kind: "stale" };

      // Money mutation and audit event are one durability boundary. If the
      // append fails for any reason, better-sqlite3 rolls this update back.
      rawDb.prepare(
        `INSERT INTO activity_log
          (user_id, tenant_id, action, entity_type, entity_id, details, ip, at)
         VALUES (?, ?, ?, 'commission', ?, ?, ?, ?)`,
      ).run(
        command.actorUserId,
        command.tenantId,
        plan.next.status === existing.status ? "commission.updated" : `commission.${plan.next.status}`,
        command.id,
        JSON.stringify({
          previousStatus: existing.status,
          status: plan.next.status,
          changedFields: plan.changedFields,
        }),
        command.ip ?? null,
        new Date().toISOString(),
      );

      const updated = this.getCommissionById(command.id, command.tenantId);
      if (!updated) throw new Error("LEGACY_COMMISSION_UPDATE_NOT_VISIBLE");
      return { kind: "updated", commission: updated };
    });

    try {
      return transact.immediate();
    } catch {
      return {
        kind: "failed",
        code: "LEGACY_COMMISSION_TRANSACTION_FAILED",
        failureCategory: "transaction",
      };
    }
  }
  // Un-marking a sale: drop the auto-created PENDING commission for a lead.
  // Approved/paid commissions are never auto-removed — a clawback is a manager
  // action. Returns how many pending rows were removed.
  removePendingCommissionsForLead(leadId: number): Commission[] {
    const pending = db.select().from(commissions)
      .where(and(eq(commissions.leadId, leadId), eq(commissions.status, "pending"))).all();
    if (pending.length) {
      db.delete(commissions).where(and(eq(commissions.leadId, leadId), eq(commissions.status, "pending"))).run();
    }
    return pending;
  }
  // ONE grouped aggregate + a Map join, replacing a full-hydration query per
  // rep. `status <> 'superseded'` matches drizzle ne()'s NULL-excluding
  // semantics; reps with no commission rows keep their zero-filled entry.
  getCommissionSummary(tenantId: number) {
    const rows = rawDb.prepare(
      `SELECT rep_id AS repId, COUNT(*) AS sales, COALESCE(SUM(amount), 0) AS total,
              COALESCE(SUM(CASE WHEN status = 'paid' THEN amount ELSE 0 END), 0) AS paid,
              COALESCE(SUM(CASE WHEN status IN ('pending','approved') THEN amount ELSE 0 END), 0) AS pending
         FROM commissions WHERE tenant_id = ? AND status <> 'superseded'
        GROUP BY rep_id`
    ).all(tenantId) as Array<{ repId: number; sales: number; total: number; paid: number; pending: number }>;
    const byRep = new Map(rows.map(r => [r.repId, r]));
    return this.getTeamMembers(tenantId).filter(r => r.active).map(rep => {
      const c = byRep.get(rep.id);
      return {
        repId: rep.id, repName: rep.name,
        total: c?.total ?? 0, paid: c?.paid ?? 0, pending: c?.pending ?? 0, sales: c?.sales ?? 0,
      };
    });
  }

  // ── Commission Rates ───────────────────────────────────────────────────────
  getCommissionRates(tenantId?: number): CommissionRate[] {
    // P0-3: structures are per-org. Tenant callers see ONLY their own plans;
    // undefined (super_admin) sees all. A NULL-tenant row (legacy, pre-adoption)
    // is never served to a tenant caller.
    const conds = [eq(commissionRates.isActive, true)];
    if (tenantId != null) conds.push(eq(commissionRates.tenantId, tenantId));
    return db.select().from(commissionRates).where(and(...conds)).all();
  }
  createCommissionRate(r: InsertCommissionRate): CommissionRate {
    return db.insert(commissionRates).values({ ...r, createdAt: new Date().toISOString() }).returning().get();
  }
  updateCommissionRate(id: number, updates: Partial<CommissionRate>): CommissionRate | undefined {
    return db.update(commissionRates).set(updates).where(eq(commissionRates.id, id)).returning().get();
  }

  // ── Activity Log ───────────────────────────────────────────────────────────
  logActivity(userId: number | null, action: string, entityType?: string, entityId?: number, details?: object, ip?: string, tenantIdOverride?: number | null): void {
    // Stamp the acting user's tenant so the audit stream can be read back
    // tenant-scoped (a manager only sees their own org's activity). System
    // actions (userId null) stay tenant-less (visible only to super_admin).
    const tenantId = tenantIdOverride !== undefined
      ? tenantIdOverride
      : (userId != null ? (this.getUserById(userId)?.tenantId ?? null) : null);
    db.insert(activityLog).values({
      userId: userId ?? null,
      tenantId,
      action,
      entityType: entityType ?? null,
      entityId: entityId ?? null,
      details: details ? JSON.stringify(details) : null,
      ip: ip ?? null,
      at: new Date().toISOString(),
    }).run();
  }
  // ── Login attempts (auth audit) ─────────────────────────────────────────────
  // QA GATE FIX (B1): tenant isolation. Tenant resolved from the target
  // user's record when available, else the caller's org.
  logLoginAttempt(email: string, kind: "request" | "verify", success: boolean, reason: string, ip?: string | null, userAgent?: string | null, tenantId?: number | null): void {
    try {
      let tid = tenantId ?? null;
      if (tid == null) {
        try { tid = this.getUserByEmail(String(email).toLowerCase())?.tenantId ?? null; } catch { /* */ }
      }
      rawDb.prepare(
        `INSERT INTO login_attempts (email, kind, success, reason, ip, user_agent, tenant_id) VALUES (?,?,?,?,?,?,?)`,
      ).run(String(email).toLowerCase().slice(0, 254), kind, success ? 1 : 0, reason.slice(0, 60), (ip ?? "").slice(0, 64) || null, (userAgent ?? "").slice(0, 200) || null, tid);
    } catch { /* auth audit must never break the login flow */ }
  }
  getLoginAttempts(limit = 200, email?: string, tenantId?: number | null): any[] {
    const where: string[] = [];
    const args: any[] = [];
    if (email) { where.push("email = ?"); args.push(String(email).toLowerCase()); }
    if (tenantId != null) { where.push("(tenant_id = ? OR tenant_id IS NULL)"); args.push(tenantId); }
    const sql = `SELECT * FROM login_attempts ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT ?`;
    return rawDb.prepare(sql).all(...args, limit) as any[];
  }
  getLoginAttemptSummary(tenantId?: number | null): any[] {
    const scoped = tenantId != null;
    return rawDb.prepare(
      `SELECT email, COUNT(*) AS attempts, SUM(success) AS successes, MAX(created_at) AS last_at,
              SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS failures
         FROM login_attempts ${scoped ? "WHERE tenant_id = ? OR tenant_id IS NULL" : ""} GROUP BY email ORDER BY last_at DESC`,
    ).all(...(scoped ? [tenantId] : [])) as any[];
  }

  getActivityLog(limit = 100, tenantId?: number): ActivityLogEntry[] {
    const q = db.select().from(activityLog);
    return (tenantId != null ? q.where(eq(activityLog.tenantId, tenantId)) : q)
      .orderBy(desc(activityLog.at)).limit(limit).all();
  }

  // ── Tenants ─────────────────────────────────────────────────────────────────
  getTenants(): Tenant[] {
    return db.select().from(tenants).orderBy(desc(tenants.createdAt)).all();
  }
  getTenantById(id: number): Tenant | undefined {
    return db.select().from(tenants).where(eq(tenants.id, id)).get();
  }
  getTenantBySlug(slug: string): Tenant | undefined {
    return db.select().from(tenants).where(eq(tenants.slug, slug)).get();
  }
  createTenant(t: InsertTenant): Tenant {
    return db.insert(tenants).values({ ...t, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }).returning().get();
  }
  updateTenant(id: number, updates: Partial<Tenant>): Tenant | undefined {
    const row = db.update(tenants).set({ ...updates, updatedAt: new Date().toISOString() }).where(eq(tenants.id, id)).returning().get();
    bumpTenantConfigVersion(); // always — see the memo's "bump always" rule
    return row;
  }
  deleteTenant(id: number): void {
    db.delete(tenants).where(eq(tenants.id, id)).run();
  }
  // Grouped aggregates, no hydration: the super-admin tenant listing calls this
  // once PER TENANT per page load, and the old shape drizzle-hydrated every
  // lead in the org to read one status column. The leads aggregate is a
  // covering read off idx_leads_tenant_status.
  getTenantStats(tenantId: number): { reps: number; leads: number; sold: number; territories: number } {
    const l = rawDb.prepare(
      `SELECT COUNT(*) AS leads, COALESCE(SUM(lead_status = 'sold'), 0) AS sold FROM leads WHERE tenant_id = ?`
    ).get(tenantId) as { leads: number; sold: number };
    const reps = (rawDb.prepare(`SELECT COUNT(*) c FROM users WHERE tenant_id = ? AND active = 1`).get(tenantId) as any).c;
    const terrs = (rawDb.prepare(`SELECT COUNT(*) c FROM territories WHERE tenant_id = ?`).get(tenantId) as any).c;
    return { reps, leads: l.leads, sold: l.sold, territories: terrs };
  }

  // ── Training progress (D2D curriculum) ──────────────────────────────────────
  // Own-scope reads/writes keyed by (tenant, user). tenantId is normalized to 0
  // for legacy users so the UNIQUE(tenant_id, user_id, lesson_id) upsert always
  // has a concrete conflict target (SQLite treats NULLs as distinct).

  getTrainingProgress(userId: number, tenantId?: number | null): Array<{ lessonId: string; completedAt: string; quizScore: number | null }> {
    return rawDb.prepare(
      `SELECT lesson_id AS lessonId, completed_at AS completedAt, quiz_score AS quizScore
         FROM training_progress WHERE tenant_id = ? AND user_id = ? ORDER BY completed_at ASC, id ASC`,
    ).all(tenantId ?? 0, userId) as Array<{ lessonId: string; completedAt: string; quizScore: number | null }>;
  }

  upsertLessonComplete(userId: number, tenantId: number | null | undefined, lessonId: string, quizScore?: number | null): { lessonId: string; completedAt: string; quizScore: number | null } {
    const tid = tenantId ?? 0;
    // Re-completing a lesson refreshes the timestamp; a new quiz score replaces
    // the old one, but a score-less re-complete never erases an earned score.
    rawDb.prepare(
      `INSERT INTO training_progress (tenant_id, user_id, lesson_id, completed_at, quiz_score)
       VALUES (?, ?, ?, datetime('now'), ?)
       ON CONFLICT(tenant_id, user_id, lesson_id) DO UPDATE SET
         completed_at = excluded.completed_at,
         quiz_score = COALESCE(excluded.quiz_score, training_progress.quiz_score)`,
    ).run(tid, userId, lessonId, quizScore ?? null);
    return rawDb.prepare(
      `SELECT lesson_id AS lessonId, completed_at AS completedAt, quiz_score AS quizScore
         FROM training_progress WHERE tenant_id = ? AND user_id = ? AND lesson_id = ?`,
    ).get(tid, userId, lessonId) as { lessonId: string; completedAt: string; quizScore: number | null };
  }

  // Per-team rollup for the manager view: every active login in the tenant with
  // how many lessons they have completed, their average quiz score, and their
  // last activity. LEFT JOIN so reps who have not started still appear at zero.
  getTrainingSummary(tenantId?: number | null): Array<{ userId: number; name: string; role: string; completedCount: number; avgQuizScore: number | null; lastCompletedAt: string | null }> {
    return rawDb.prepare(
      `SELECT u.id AS userId, u.name AS name, u.role AS role,
              COUNT(tp.lesson_id) AS completedCount,
              CAST(ROUND(AVG(tp.quiz_score)) AS INTEGER) AS avgQuizScore,
              MAX(tp.completed_at) AS lastCompletedAt
         FROM users u
         LEFT JOIN training_progress tp
           ON tp.user_id = u.id AND tp.tenant_id = ?
        WHERE COALESCE(u.tenant_id, 0) = ? AND u.active = 1
        GROUP BY u.id
        ORDER BY completedCount DESC, u.name ASC`,
    ).all(tenantId ?? 0, tenantId ?? 0) as Array<{ userId: number; name: string; role: string; completedCount: number; avgQuizScore: number | null; lastCompletedAt: string | null }>;
  }
}

// The assignment RECORD follows the holder list, wherever the list is written.
//
// territories.assignee_ids is written from seven different routes — draw-and-
// assign, scan-derived areas, share, assign, unassign, and both reclaim modes.
// Hooking each one would eventually miss a path, and a missed path is exactly
// how the array and the record silently diverge. Hooking the two functions that
// actually perform the write cannot be bypassed by a route that forgets.
//
// Deliberately best-effort: an area assignment must not fail because its audit
// row could not be written. The record is reconstructible from the array; the
// array is not reconstructible from anything.
function recordAssigneeChange(row: any): void {
  if (!row?.id) return;
  try {
    const repIds = parseAssigneeIds(row.assigneeIds);
    if (!repIds) return; // legacy row with no list — nothing authoritative to sync
    syncAssignments({
      tenantId: row.tenantId ?? null,
      territoryId: row.id,
      repIds,
      actorUserId: null, // storage has no session; routes that care pass their own
      primaryRepId: row.repId ?? null,
    });
  } catch {
    /* never let bookkeeping break an assignment */
  }
}

export const storage = new Storage();

/**
 * Deferred heavy migrations — called post-boot (workers already healthy).
 * Idempotent: each step no-ops fast when already applied.
 */
export function runDeferredMigrations(): void {
  // Kill switch: DEFERRED_MIGRATIONS=off skips heavy post-boot migrations.
  // The addr-city-state rebuild wedged production twice (event-loop/lock
  // starvation on 950k rows) — keep it off in prod until an offline window.
  if (process.env.DEFERRED_MIGRATIONS === "off") {
    console.log("[migration] deferred migrations disabled (DEFERRED_MIGRATIONS=off)");
    return;
  }
  const t0 = Date.now();
  try {
    rawDb.pragma("synchronous = OFF");
    rawDb.pragma("cache_size = -2000000"); // ~2GB page cache for the rebuild
    migrateScanTargetsAddressUniqueness(rawDb);
    console.log(`[migration] deferred addr-city-state uniqueness done in ${Date.now() - t0}ms`);
  } catch (e: any) {
    console.warn("[migration] deferred addr-city-state uniqueness:", e?.message);
  } finally {
    try { rawDb.pragma("synchronous = FULL"); } catch { /* */ }
  }
}
