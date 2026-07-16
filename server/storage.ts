import crypto from "node:crypto";
import { db, rawDb } from "./db";
import {
  leads, fiberChecks, teamMembers, knockLog,
  users, sessions, otpCodes, territories, repApplications,
  territoryRequests, locationPings, clockSessions,
  commissions, commissionRates, activityLog, tenants,
  activityOverrides, leadPhotos,
  type LeadPhoto,
  type ActivityOverride,
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
import { eq, desc, or, and, gt, isNull, isNotNull, inArray, sql } from "drizzle-orm";
import { DEFAULT_GEO_CONFIG, type GeoConfig } from "@shared/geoVerify";
import { INCONCLUSIVE_GIVEUP } from "@shared/scanPolicy";

// Legacy scanner columns that exist in SQLite but predate the drizzle schema —
// upsertLeadByAddress still persists them when a scanner payload carries them.
type LegacyScanFields = { maxDownload?: number | null; isNewDeployment?: boolean | null };

// An open follow-up: a lead whose latest knock is a scheduled callback (see
// getOpenCallbacks). Display fields come from the lead; the schedule + note from
// the knock. No provider-internal ids are ever included.
export interface OpenCallback {
  leadId: number;
  address: string; city: string; state: string | null; zip: string | null;
  lat: number | null; lng: number | null;
  leadStatus: string; leadTag: string | null; leadScore: number | null;
  contactName: string | null;
  assignedRepId: number | null;
  repId: number;                 // the rep who scheduled the callback
  callbackDate: string;          // "YYYY-MM-DD"
  callbackTime: string | null;   // "HH:MM"
  notes: string | null;
  setAt: string;                 // when the callback was logged
}

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
  leadScore: number | null;
  leadTag: string | null;
  freshConfidence: string | null;
  knockCount: number | null;
  lastOutcome: string | null;
  lastKnockedAt: string | null;
}

export interface IStorage {
  // ── Leads ──────────────────────────────────────────────────────────────────
  getLeads(tenantId?: number, assignedRep?: number | number[]): Lead[];
  getLeadFacets(tenantId?: number, repScope?: number[]): Array<{ city: string; state: string }>;
  getLeadsDataVersion(tenantId?: number): string;
  getLeadsForMap(tenantId?: number, assignedRep?: number | number[]): MapPinRow[];
  getFreshLeads(tenantId: number | undefined, assignedRep: number | number[] | undefined, opts: { city?: string; state?: string; days: number }): Array<{ id: number; lat: number | null; lng: number | null; leadStatus: string; competitorName: string | null; address: string; city: string; state: string; createdAt: string | null }>;
  getLeadsPage(
    tenantId: number | undefined,
    assignedRep: number | number[] | undefined,
    opts: { status?: string; zip?: string; city?: string; state?: string; assignedRepId?: number | "unassigned"; fiberStatus?: string; limit: number; offset: number },
  ): { rows: Lead[]; total: number };
  getLeadById(id: number): Lead | undefined;
  createLead(lead: InsertLead): Lead;
  upsertLeadByAddress(lead: InsertLead & LegacyScanFields): { lead: Lead; created: boolean };
  updateLead(id: number, updates: Partial<InsertLead>, tenantId?: number): Lead | undefined;
  deleteLead(id: number, tenantId?: number): boolean;
  searchLeads(query: string, tenantId?: number, assignedRep?: number | number[]): Lead[];
  searchLeadsPage(
    query: string,
    tenantId: number | undefined,
    assignedRep: number | number[] | undefined,
    opts: { status?: string; zip?: string; city?: string; state?: string; assignedRepId?: number | "unassigned"; fiberStatus?: string; limit: number; offset: number },
  ): { rows: Lead[]; total: number };
  // ── Fiber checks ───────────────────────────────────────────────────────────
  getFiberChecks(): FiberCheck[];
  createFiberCheck(check: InsertFiberCheck): FiberCheck;
  getRecentChecks(limit?: number, tenantId?: number): FiberCheck[];
  // ── Team members ───────────────────────────────────────────────────────────
  getTeamMembers(tenantId?: number): TeamMember[];
  getTeamMemberById(id: number): TeamMember | undefined;
  createTeamMember(member: InsertTeamMember): TeamMember;
  updateTeamMember(id: number, updates: Partial<InsertTeamMember>, tenantId?: number): TeamMember | undefined;
  deleteTeamMember(id: number, tenantId?: number): boolean;
  // ── Knock log ──────────────────────────────────────────────────────────────
  getKnocks(tenantId?: number): Knock[];
  getKnocksByLead(leadId: number): Knock[];
  getKnocksByRep(repId: number): Knock[];
  getOpenCallbacks(tenantId?: number): OpenCallback[];
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
  getActivityOverrides(knockId: number): ActivityOverride[];
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
  deleteSession(id: string): void;
  deleteSessionsByUser(userId: number): number;
  // ── OTP ────────────────────────────────────────────────────────────────────
  createOtp(email: string): string;
  verifyOtp(email: string, code: string): boolean;
  // ── Territories ────────────────────────────────────────────────────────────
  getTerritories(tenantId?: number): Territory[];
  getTerritoriesByRep(repId: number): Territory[];
  getTerritoryById(id: number): Territory | undefined;
  getLeadsByTerritory(territoryId: number): Lead[];
  addTerritoryEvent(territoryId: number, actorUserId: number | null, type: string, payload?: unknown): void;
  addLeadEvent(leadId: number, type: "assignment" | "note", actor: string | null, detail?: unknown): void;
  getLeadEvents(leadId: number, limit?: number): { id: number; leadId: number; type: string; actor: string | null; detail: any; at: string }[];
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
  getClockSessionsByRep(repId: number): ClockSession[];
  getAllClockSessions(date?: string, tenantId?: number): ClockSession[];
  wasDeepSeeded(city: string, state: string): boolean;
  markDeepSeeded(city: string, state: string, addressCount: number): void;
  // ── Scan targets (persistent address pool) ───────────────────────────────────
  upsertScanTargets(addrs: Array<{ address: string; city?: string; state?: string; zip?: string; lat?: number | null; lng?: number | null; source?: string; tenantId?: number | null; canonicalKey?: string | null; dfAddressId?: string | null; scannedNow?: boolean; fiberStatus?: string | null; isNewFiber?: boolean; billingStatus?: string | null }>): number;
  getScanTargetsToRescan(limit: number): any[];
  getScanTargetsByCity(city: string, state: string): any[];
  recordScanTargetResult(id: number, r: { fiberStatus?: string | null; fiberAvailable?: boolean; isNewFiber?: boolean; billingStatus?: string | null; dfAddressId?: string | null; convertedToLeadId?: number | null; availabilityStatus?: string | null; newlyLive?: boolean; customerSegment?: string; customerConfidence?: string; customerSignals?: string[] }): { prevIsNewFiber: boolean };
  bumpScanTargetInconclusive(ref: { id?: number; address?: string }): void;
  getScanTargetExhaustedCount(city?: string, zip?: string): number;
  getFirstSeenLive(sinceHours: number, limit?: number, tenantId?: number): any[];
  getScanTargetStats(): { total: number; scanned: number; neverScanned: number; newFiber: number; lastScannedAt: string | null };
  // ── Commissions ────────────────────────────────────────────────────────────
  getCommissions(tenantId?: number, repId?: number): Commission[];
  getCommissionById(id: number): Commission | undefined;
  createCommission(c: InsertCommission): Commission;
  updateCommission(id: number, updates: Partial<Commission>): Commission | undefined;
  removePendingCommissionsForLead(leadId: number): Commission[];
  getCommissionSummary(): { repId: number; repName: string; total: number; paid: number; pending: number; sales: number }[];
  // ── Commission Rates ───────────────────────────────────────────────────────
  getCommissionRates(): CommissionRate[];
  createCommissionRate(r: InsertCommissionRate): CommissionRate;
  updateCommissionRate(id: number, updates: Partial<CommissionRate>): CommissionRate | undefined;
  // ── Activity Log ───────────────────────────────────────────────────────────
  logActivity(userId: number | null, action: string, entityType?: string, entityId?: number, details?: object, ip?: string, tenantIdOverride?: number | null): void;
  getActivityLog(limit?: number, tenantId?: number): ActivityLogEntry[];
  // ── Tenants (SaaS) ────────────────────────────────────────────────────────
  getTenants(): Tenant[];
  getTenantById(id: number): Tenant | undefined;
  getTenantBySlug(slug: string): Tenant | undefined;
  getTenantByOwnerEmail(email: string): Tenant | undefined;
  createTenant(t: InsertTenant): Tenant;
  updateTenant(id: number, updates: Partial<Tenant>): Tenant | undefined;
  deleteTenant(id: number): void;
  getTenantStats(tenantId: number): { reps: number; leads: number; sold: number; territories: number };
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
    `ALTER TABLE commission_rates ADD COLUMN calc_type TEXT NOT NULL DEFAULT 'flat'`,
    `ALTER TABLE commission_rates ADD COLUMN percentage REAL NOT NULL DEFAULT 0`,
    `ALTER TABLE commission_rates ADD COLUMN tiers TEXT`,
    `ALTER TABLE commission_rates ADD COLUMN effective_from TEXT`,
    `ALTER TABLE commission_rates ADD COLUMN effective_to TEXT`,
    `ALTER TABLE commission_rates ADD COLUMN version INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE commission_rates ADD COLUMN updated_by TEXT`,
    `ALTER TABLE knock_log ADD COLUMN tenant_id INTEGER`,
    `ALTER TABLE clock_sessions ADD COLUMN tenant_id INTEGER`,
    // Audit stream is now tenant-scoped on read — stamp the actor's tenant at write.
    `ALTER TABLE activity_log ADD COLUMN tenant_id INTEGER`,
    `CREATE INDEX IF NOT EXISTS idx_activity_log_tenant ON activity_log(tenant_id, at)`,
    // Inbound rep applications carry the org they're joining (null = unrouted).
    // Bootstrap adopts existing null rows into the default tenant.
    `ALTER TABLE rep_applications ADD COLUMN tenant_id INTEGER`,
    `ALTER TABLE rep_applications ADD COLUMN invite_id INTEGER`,
    `ALTER TABLE rep_applications ADD COLUMN application_source TEXT NOT NULL DEFAULT 'public_join'`,
    `ALTER TABLE rep_applications ADD COLUMN desired_role TEXT`,
    `ALTER TABLE rep_applications ADD COLUMN login_email_id TEXT`,
    `ALTER TABLE rep_applications ADD COLUMN login_sent_at TEXT`,
    `ALTER TABLE rep_applications ADD COLUMN agreements_issued_at TEXT`,
    `ALTER TABLE rep_applications ADD COLUMN activated_at TEXT`,
    `CREATE INDEX IF NOT EXISTS idx_rep_applications_tenant_status_source ON rep_applications(tenant_id, status, application_source, created_at DESC)`,
    // Org hierarchy: which team_lead/manager a member reports to (null = top-level)
    `ALTER TABLE team_members ADD COLUMN reports_to_id INTEGER`,
    // Persistent address pool — harvest once, re-scan for fiber-status changes
    `CREATE TABLE IF NOT EXISTS scan_targets (id INTEGER PRIMARY KEY AUTOINCREMENT, address TEXT NOT NULL UNIQUE, city TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'NC', zip TEXT NOT NULL, lat REAL, lng REAL, tenant_id INTEGER, source TEXT, last_fiber_status TEXT, last_is_new_fiber INTEGER NOT NULL DEFAULT 0, last_billing_status TEXT, df_address_id TEXT, scan_count INTEGER NOT NULL DEFAULT 0, last_scanned_at TEXT, converted_to_lead_id INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
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
    `CREATE INDEX IF NOT EXISTS idx_leads_assigned_territory ON leads(assigned_territory_id)`,
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

    // ══ WEEKLY COMMISSION (Phase 2) — additive; isolated from the old commission system ══
    // Org workweek config on tenants (safe backfill via NOT NULL DEFAULT).
    `ALTER TABLE tenants ADD COLUMN commission_timezone TEXT NOT NULL DEFAULT 'America/New_York'`,
    `ALTER TABLE tenants ADD COLUMN commission_week_starts_on INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE tenants ADD COLUMN commission_week_start_local_time TEXT NOT NULL DEFAULT '00:00'`,
    `ALTER TABLE tenants ADD COLUMN commission_qualification_basis TEXT NOT NULL DEFAULT 'QUALIFIED_AT'`,
    `ALTER TABLE tenants ADD COLUMN commission_finalization_delay_hours INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE tenants ADD COLUMN commission_correction_window_days INTEGER NOT NULL DEFAULT 30`,
    `ALTER TABLE tenants ADD COLUMN commission_auto_finalize_enabled INTEGER NOT NULL DEFAULT 0`,

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
    // Field photo evidence attached to a door (see shared/schema.ts leadPhotos).
    `CREATE TABLE IF NOT EXISTS lead_photos (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER, lead_id INTEGER NOT NULL, user_id INTEGER, rep_id INTEGER, path TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE INDEX IF NOT EXISTS idx_lead_photos_lead ON lead_photos(lead_id)`,
    // Serves MAX(updated_at) per tenant for the map data-version (cross-process
    // ETag) without scanning the tenant's rows.
    `CREATE INDEX IF NOT EXISTS idx_leads_tenant_updated ON leads(tenant_id, updated_at)`,

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
       allowed_markets TEXT,               -- JSON — city/zip scope, null = any within tenant
       allowed_identifier_scope TEXT,      -- JSON — permitted provider id ranges/sets
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
       monitoring_policy TEXT,              -- JSON — cadence overrides
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
       state TEXT NOT NULL CHECK(state IN ('NC','SC')),
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
       state TEXT CHECK(state IN ('NC','SC')),
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

  ];
  for (const stmt of stmts) {
    try { raw.exec(stmt); } catch (e: any) {
      if (!e.message?.includes("duplicate column") && !e.message?.includes("already exists")) {
        console.warn("Migration warning:", e.message);
      }
    }
  }
  // Seed default commission rate if none exist
  try {
    const existing = raw.prepare("SELECT id FROM commission_rates LIMIT 1").get();
    if (!existing) {
      raw.prepare("INSERT INTO commission_rates (name, role, rate_per_sale, is_active) VALUES ('Standard Rep Rate', 'rep', 50.00, 1)").run();
      raw.prepare("INSERT INTO commission_rates (name, role, rate_per_sale, is_active) VALUES ('Team Lead Bonus', 'team_lead', 75.00, 1)").run();
    }
  } catch (_) {}

  bootstrapDefaultTenant(raw);
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

const SUFFIX_MAP_SHARED: Record<string, string> = {
  court: "ct", drive: "dr", street: "st", avenue: "ave",
  boulevard: "blvd", lane: "ln", road: "rd", place: "pl",
  circle: "cir", trail: "trl", way: "wy", terrace: "ter",
  parkway: "pkwy", highway: "hwy", loop: "lp",
};

function normalizeAddress(s: string): string {
  return s.trim().toLowerCase()
    .replace(/[.,#]/g, "")
    .replace(/\s+/g, " ")
    .split(" ")
    .map((w: string) => SUFFIX_MAP_SHARED[w] ?? w)
    .join(" ");
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
  getLeadById(id: number): Lead | undefined {
    return db.select().from(leads).where(eq(leads.id, id)).get();
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
    const row = (tenantId != null
      ? rawDb.prepare("SELECT COUNT(*) c, COALESCE(MAX(id),0) mx, COALESCE(MAX(updated_at),'') mu FROM leads WHERE tenant_id = ?").get(tenantId)
      : rawDb.prepare("SELECT COUNT(*) c, COALESCE(MAX(id),0) mx, COALESCE(MAX(updated_at),'') mu FROM leads").get()
    ) as { c: number; mx: number; mu: string };
    return `${row.c}.${row.mx}.${row.mu}`;
  }
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
  getLeadsForMap(tenantId?: number, assignedRep?: number | number[]): MapPinRow[] {
    const clauses: string[] = [];
    const params: number[] = [];
    if (tenantId != null) {
      clauses.push("l.tenant_id = ?");
      params.push(tenantId);
    }
    if (Array.isArray(assignedRep)) {
      if (!assignedRep.length) return [];
      clauses.push(`l.assigned_rep_id IN (${assignedRep.map(() => "?").join(",")})`);
      params.push(...assignedRep);
    } else if (assignedRep != null) {
      clauses.push("l.assigned_rep_id = ?");
      params.push(assignedRep);
    }
    const where = clauses.length ? clauses.join(" AND ") : "1 = 1";
    return rawDb.prepare(`
      WITH scoped AS MATERIALIZED (
        SELECT
          l.id, l.address, l.city, l.state, l.zip, l.lat, l.lng,
          l.lead_status AS leadStatus, l.fiber_status AS fiberStatus,
          l.assigned_rep_id AS assignedRepId, l.lead_score AS leadScore,
          l.lead_tag AS leadTag, l.fresh_confidence AS freshConfidence
        FROM leads l
        WHERE ${where} AND l.lat IS NOT NULL AND l.lng IS NOT NULL
      ), ranked_visits AS (
        SELECT
          k.lead_id AS leadId,
          k.outcome AS lastOutcome,
          k.knocked_at AS lastKnockedAt,
          COUNT(*) OVER (PARTITION BY k.lead_id) AS knockCount,
          ROW_NUMBER() OVER (
            PARTITION BY k.lead_id ORDER BY k.knocked_at DESC, k.id DESC
          ) AS rowNumber
        FROM knock_log k
        INNER JOIN scoped s ON s.id = k.lead_id
      )
      SELECT
        s.id, s.address, s.city, s.state, s.zip, s.lat, s.lng,
        s.leadStatus, s.fiberStatus, s.assignedRepId, s.leadScore,
        s.leadTag, s.freshConfidence,
        rv.knockCount, rv.lastOutcome, rv.lastKnockedAt
      FROM scoped s
      LEFT JOIN ranked_visits rv ON rv.leadId = s.id AND rv.rowNumber = 1
    `).all(...params) as MapPinRow[];
  }

  // Recently-discovered leads for the "fresh leads" feed: created within the last
  // `days`, tenant + rep-scope filtered, optionally narrowed to a city/state.
  // Newest first, capped. Slim projection — the map only needs point + status +
  // competitor. Same scoping model as getLeadsForMap (fail-closed for reps).
  getFreshLeads(
    tenantId: number | undefined,
    assignedRep: number | number[] | undefined,
    opts: { city?: string; state?: string; days: number; status?: "available" | "coming_soon" },
  ): Array<{ id: number; lat: number | null; lng: number | null; leadStatus: string; competitorName: string | null; address: string; city: string; state: string; createdAt: string | null }> {
    const days = Number.isFinite(opts.days) && opts.days > 0 ? Math.min(Math.floor(opts.days), 365) : 30;
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const conditions: any[] = [
      sql`${leads.createdAt} >= ${cutoff}`,
      eq(leads.leadTag, "fresh_fiber_confirmed"),
      eq(leads.freshConfidence, "cross_verified"),
      isNotNull(leads.sourceScanTargetId),
      isNotNull(leads.freshConfirmedAt),
    ];
    if (tenantId != null) conditions.push(eq(leads.tenantId, tenantId));
    if (Array.isArray(assignedRep)) {
      conditions.push(assignedRep.length ? inArray(leads.assignedRepId, assignedRep) : eq(leads.assignedRepId, -1));
    } else if (assignedRep != null) {
      conditions.push(eq(leads.assignedRepId, assignedRep));
    }
    if (opts.city) conditions.push(sql`lower(${leads.city}) = ${opts.city.toLowerCase()}`);
    if (opts.state) conditions.push(sql`lower(${leads.state}) = ${opts.state.toLowerCase()}`);
    // status filter: coming_soon = pre-launch fiber (leadTag), available = serviceable now.
    if (opts.status === "coming_soon") conditions.push(eq(leads.leadTag, "coming_soon"));
    else if (opts.status === "available") conditions.push(sql`(${leads.leadTag} IS NULL OR ${leads.leadTag} <> 'coming_soon')`);
    return db.select({
      id: leads.id, lat: leads.lat, lng: leads.lng, leadStatus: leads.leadStatus,
      competitorName: leads.competitorName, address: leads.address, city: leads.city,
      state: leads.state, createdAt: leads.createdAt,
    }).from(leads)
      .where(and(...conditions))
      .orderBy(sql`${leads.createdAt} DESC`)
      .limit(2000)
      .all();
  }

  // Paged list query for /api/leads — filters + ORDER BY + LIMIT/OFFSET pushed
  // into SQL (the route used to hydrate EVERY tenant row to serve a 200-row
  // page). Count runs the same WHERE. Scope conditions identical to getLeads.
  getLeadsPage(
    tenantId: number | undefined,
    assignedRep: number | number[] | undefined,
    opts: { status?: string; zip?: string; city?: string; state?: string; assignedRepId?: number | "unassigned"; fiberStatus?: string; limit: number; offset: number },
  ): { rows: Lead[]; total: number } {
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
    const where = conditions.length === 0 ? undefined
      : conditions.length === 1 ? conditions[0] : and(...conditions);
    const listQ = db.select().from(leads);
    const rows = (where ? listQ.where(where) : listQ)
      .orderBy(desc(leads.createdAt)).limit(opts.limit).offset(opts.offset).all();
    const countQ = db.select({ c: sql<number>`count(*)` }).from(leads);
    const total = Number((where ? countQ.where(where) : countQ).get()?.c ?? 0);
    return { rows, total };
  }
  createLead(lead: InsertLead): Lead {
    const now = new Date().toISOString();
    // Tenancy: never create a tenant-less lead — system paths (scanners, cron)
    // file under the default org; user paths stamp the actor's org in routes.
    const tenantId = (lead as any).tenantId ?? getDefaultTenantId();
    const row = db.insert(leads).values({ ...lead, tenantId, createdAt: now, updatedAt: now }).returning().get();
    bustPinCaches(row.tenantId);
    return row;
  }

  // Dedup-safe insert: returns existing lead if address already in DB, otherwise creates new one.
  // Uses indexed address lookup — O(log n) not O(n) full table scan.
  upsertLeadByAddress(lead: InsertLead & LegacyScanFields): { lead: Lead; created: boolean } {
    const normalizedAddr = normalizeAddress(lead.address ?? "");

    // ── Existence check — ALWAYS hit the DB (indexed on address). The in-memory
    // cache is only a warmup hint; it can be stale across processes (e.g. a
    // separate scan process) or after out-of-band inserts, so it must NOT gate
    // correctness — otherwise a cache miss inserts a DUPLICATE lead and fires a
    // false "went live" alert. ──────────────────────────────────────────────────
    const exactHit = rawDb.prepare("SELECT * FROM leads WHERE address = ? LIMIT 1").get(lead.address ?? "") as Lead | undefined;
    if (exactHit) return { lead: exactHit, created: false };
    const prefix = normalizedAddr.split(" ")[0];
    if (prefix) {
      const candidates = rawDb.prepare("SELECT * FROM leads WHERE address LIKE ? LIMIT 20").all(prefix + "%") as Lead[];
      const existingLead = candidates.find(l => normalizeAddress(l.address ?? "") === normalizedAddr);
      if (existingLead) return { lead: existingLead, created: false };
    }

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
        lead_tag, lead_score, tenant_id, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?, ?
      )
    `);
    const r = stmt.run(
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
      lead.tenantId ?? getDefaultTenantId(), // scans file under the default org
      now,
      now
    );
    const newLead = rawDb.prepare(`SELECT * FROM leads WHERE id = ?`).get(r.lastInsertRowid) as Lead;
    bustPinCaches(newLead.tenantId);
    return { lead: newLead, created: true };
  }
  updateLead(id: number, updates: Partial<InsertLead>, tenantId?: number): Lead | undefined {
    const condition = tenantId != null
      ? and(eq(leads.id, id), eq(leads.tenantId, tenantId))
      : eq(leads.id, id);
    const row = db.update(leads).set({ ...updates, updatedAt: new Date().toISOString() })
      .where(condition).returning().get();
    if (row) bustPinCaches(row.tenantId); // pins changed → cache + ETag version must move
    return row;
  }
  deleteLead(id: number, tenantId?: number): boolean {
    const condition = tenantId != null
      ? and(eq(leads.id, id), eq(leads.tenantId, tenantId))
      : eq(leads.id, id);
    const deleted = db.delete(leads).where(condition).run().changes > 0;
    if (deleted) bustPinCaches(tenantId); // undefined tenant → global bust
    return deleted;
  }
  searchLeads(query: string, tenantId?: number, assignedRep?: number | number[]): Lead[] {
    return this.searchLeadsPage(query, tenantId, assignedRep, { limit: 500, offset: 0 }).rows;
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
    opts: { status?: string; zip?: string; city?: string; state?: string; assignedRepId?: number | "unassigned"; fiberStatus?: string; limit: number; offset: number },
  ): { rows: Lead[]; total: number } {
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
    const where = conditions.length === 1 ? conditions[0] : and(...conditions);
    const rows = db.select().from(leads).where(where)
      .orderBy(desc(leads.createdAt)).limit(opts.limit).offset(opts.offset).all();
    const total = Number(db.select({ c: sql<number>`count(*)` }).from(leads).where(where).get()?.c ?? 0);
    return { rows, total };
  }

  // ── Fiber checks ───────────────────────────────────────────────────────────
  getFiberChecks(): FiberCheck[] {
    return db.select().from(fiberChecks).orderBy(desc(fiberChecks.checkedAt)).all();
  }
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
  getTeamMemberById(id: number): TeamMember | undefined {
    return db.select().from(teamMembers).where(eq(teamMembers.id, id)).get();
  }
  createTeamMember(member: InsertTeamMember): TeamMember {
    return db.insert(teamMembers).values({ ...member, createdAt: new Date().toISOString() }).returning().get();
  }
  updateTeamMember(id: number, updates: Partial<InsertTeamMember>, tenantId?: number): TeamMember | undefined {
    const condition = tenantId != null
      ? and(eq(teamMembers.id, id), eq(teamMembers.tenantId, tenantId))
      : eq(teamMembers.id, id);
    return db.update(teamMembers).set(updates).where(condition).returning().get();
  }
  deleteTeamMember(id: number, tenantId?: number): boolean {
    const condition = tenantId != null
      ? and(eq(teamMembers.id, id), eq(teamMembers.tenantId, tenantId))
      : eq(teamMembers.id, id);
    return db.delete(teamMembers).where(condition).run().changes > 0;
  }

  // ── Knock log ──────────────────────────────────────────────────────────────
  getKnocks(tenantId?: number): Knock[] {
    const q = db.select().from(knockLog);
    return (tenantId != null ? q.where(eq(knockLog.tenantId, tenantId)) : q)
      .orderBy(desc(knockLog.knockedAt)).all();
  }
  getKnocksByLead(leadId: number): Knock[] {
    return db.select().from(knockLog).where(eq(knockLog.leadId, leadId)).orderBy(desc(knockLog.knockedAt)).all();
  }
  getKnocksByRep(repId: number): Knock[] {
    return db.select().from(knockLog).where(eq(knockLog.repId, repId)).all();
  }
  // Open follow-ups: leads whose MOST-RECENT knock is a scheduled callback (the
  // rep asked to come back and hasn't re-worked the door since). Joins the lead
  // for display + tenant scope. The outer driver seeks scheduled-callback rows via
  // the partial idx_knock_log_open_callback; the correlated "latest knock" subquery
  // rides idx_knock_log_lead_time_desc (lead_id, knocked_at DESC, id DESC).
  // Rep-scoping is applied by the route.
  getOpenCallbacks(tenantId?: number): OpenCallback[] {
    const rows = rawDb.prepare(`
      SELECT
        l.id AS leadId, l.address AS address, l.city AS city, l.state AS state, l.zip AS zip,
        l.lat AS lat, l.lng AS lng, l.lead_status AS leadStatus, l.lead_tag AS leadTag,
        l.lead_score AS leadScore, l.contact_name AS contactName,
        l.assigned_rep_id AS assignedRepId,
        k.rep_id AS repId, k.callback_date AS callbackDate, k.callback_time AS callbackTime,
        k.notes AS notes, k.knocked_at AS setAt
      FROM knock_log k
      JOIN leads l ON l.id = k.lead_id
      WHERE k.id = (
        SELECT k2.id FROM knock_log k2
        WHERE k2.lead_id = k.lead_id
        ORDER BY k2.knocked_at DESC, k2.id DESC
        LIMIT 1
      )
      AND k.outcome = 'callback'
      AND k.callback_date IS NOT NULL
      ${tenantId != null ? "AND l.tenant_id = ?" : ""}
      ORDER BY k.callback_date ASC, COALESCE(k.callback_time, '99:99') ASC
    `).all(...(tenantId != null ? [tenantId] : [])) as OpenCallback[];
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
    return db.insert(knockLog).values({
      ...knock,
      tenantId,
      knockedAt: knock.knockedAt || new Date().toISOString(),
      ...(verdict ?? {}),
    }).returning().get();
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
  }
  // Effective geo thresholds: stored override → platform default → code default.
  getGeoConfig(tenantId?: number | null): GeoConfig {
    const d = Number(this.getSetting("geo.max_distance_m", tenantId));
    const a = Number(this.getSetting("geo.max_accuracy_m", tenantId));
    return {
      maxDistanceM: Number.isFinite(d) && d > 0 ? d : DEFAULT_GEO_CONFIG.maxDistanceM,
      maxAccuracyM: Number.isFinite(a) && a > 0 ? a : DEFAULT_GEO_CONFIG.maxAccuracyM,
    };
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
  getActivityOverrides(knockId: number): ActivityOverride[] {
    return db.select().from(activityOverrides).where(eq(activityOverrides.knockId, knockId)).orderBy(desc(activityOverrides.at)).all();
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
    const rows = rawDb.prepare(
      `SELECT leadId, count, lastAt, outcome AS lastOutcome FROM (
         SELECT knock_log.lead_id AS leadId, knock_log.outcome,
                COUNT(*)        OVER (PARTITION BY knock_log.lead_id) AS count,
                MAX(knocked_at) OVER (PARTITION BY knock_log.lead_id) AS lastAt,
                ROW_NUMBER()    OVER (PARTITION BY knock_log.lead_id ORDER BY knocked_at DESC, knock_log.id DESC) AS rn
         FROM knock_log ${tenantJoin}
       ) WHERE rn = 1`
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
    const reps = this.getTeamMembers(tenantId).filter(r => r.active);
    if (reps.length === 0) return [];
    // Local midnight — a 7am knock must count as "today".
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const w = (col = "") => `(@since IS NULL OR k.knocked_at >= @since) AND (@until IS NULL OR k.knocked_at <= @until)${col}`;
    const rows = rawDb.prepare(
      `SELECT k.rep_id AS repId,
         SUM(CASE WHEN ${w()} THEN 1 ELSE 0 END) AS knocks,
         SUM(CASE WHEN ${w(" AND k.was_home = 1")} THEN 1 ELSE 0 END) AS contacts,
         SUM(CASE WHEN ${w(" AND k.outcome = 'callback'")} THEN 1 ELSE 0 END) AS callbacks,
         SUM(CASE WHEN ${w(" AND k.outcome = 'sold'")} THEN 1 ELSE 0 END) AS sales,
         SUM(CASE WHEN k.knocked_at >= @midnight THEN 1 ELSE 0 END) AS knocksToday,
         SUM(CASE WHEN k.knocked_at >= @midnight AND k.outcome = 'sold' THEN 1 ELSE 0 END) AS salesToday
       FROM knock_log k JOIN team_members t ON t.id = k.rep_id
       WHERE (@tenantId IS NULL OR t.tenant_id = @tenantId) AND t.active = 1
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
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    return db.insert(sessions).values({ id, userId, expiresAt, createdAt: new Date().toISOString() }).returning().get();
  }
  getSession(id: string): Session | undefined {
    const now = new Date().toISOString();
    return db.select().from(sessions).where(and(eq(sessions.id, id), gt(sessions.expiresAt, now))).get();
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
  getTerritoriesByRep(repId: number): Territory[] {
    // A rep sees a territory if they're the primary repId OR in assignee_ids
    // (multi-rep/shared), and it isn't archived.
    return this.getTerritories().filter((t: any) => {
      if (t.status === "archived") return false;
      if (t.repId === repId) return true;
      try { return (JSON.parse(t.assigneeIds || "[]") as number[]).includes(repId); } catch { return false; }
    });
  }
  getTerritoryById(id: number): Territory | undefined {
    return db.select().from(territories).where(eq(territories.id, id)).get();
  }
  // Leads currently linked to a territory (area-sync). Used by reclaim.
  getLeadsByTerritory(territoryId: number): Lead[] {
    return db.select().from(leads).where(eq(leads.assignedTerritoryId, territoryId)).all();
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
    return db.insert(territories).values({ ...t, createdAt: new Date().toISOString() }).returning().get();
  }
  updateTerritory(id: number, updates: Partial<InsertTerritory>, tenantId?: number): Territory | undefined {
    const cond = tenantId != null ? and(eq(territories.id, id), eq(territories.tenantId, tenantId)) : eq(territories.id, id);
    return db.update(territories).set(updates).where(cond).returning().get();
  }
  deleteTerritory(id: number, tenantId?: number): boolean {
    const cond = tenantId != null ? and(eq(territories.id, id), eq(territories.tenantId, tenantId)) : eq(territories.id, id);
    return db.delete(territories).where(cond).run().changes > 0;
  }

  // ── Territory Requests ─────────────────────────────────────────────────────
  getTerritoryRequests(status?: string): TerritoryRequest[] {
    if (status) return db.select().from(territoryRequests).where(eq(territoryRequests.status, status)).all();
    return db.select().from(territoryRequests).all();
  }
  createTerritoryRequest(repId: number, userId: number, message?: string): TerritoryRequest {
    return db.insert(territoryRequests).values({ repId, userId, message: message || null, createdAt: new Date().toISOString() }).returning().get();
  }
  updateTerritoryRequest(id: number, status: string): TerritoryRequest | undefined {
    return db.update(territoryRequests).set({ status }).where(eq(territoryRequests.id, id)).returning().get();
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
    const allowed = tenantId != null
      ? new Set(this.getTeamMembers(tenantId).map(m => m.id))
      : null;
    // Get all pings, group by repId keeping most recent
    const all = db.select().from(locationPings).orderBy(desc(locationPings.pingAt)).all();
    const seen = new Set<number>();
    return all.filter(p => {
      if (allowed && !allowed.has(p.repId)) return false;
      if (seen.has(p.repId)) return false;
      seen.add(p.repId);
      return true;
    });
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
  getClockSessionsByRep(repId: number): ClockSession[] {
    return db.select().from(clockSessions).where(eq(clockSessions.repId, repId))
      .orderBy(desc(clockSessions.clockedIn)).all();
  }
  getAllClockSessions(date?: string, tenantId?: number): ClockSession[] {
    const conds = [] as any[];
    if (tenantId != null) conds.push(eq(clockSessions.tenantId, tenantId));
    if (date) conds.push(eq(clockSessions.date, date));
    const q = db.select().from(clockSessions);
    return (conds.length ? q.where(and(...conds)) : q).orderBy(desc(clockSessions.clockedIn)).all();
  }

  // ── Deep-seed marker — a town's one-time Mapbox-grid seed happened. ──────────
  wasDeepSeeded(city: string, state: string): boolean {
    const key = `${city.trim().toLowerCase()}|${state.trim().toLowerCase()}`;
    return !!rawDb.prepare("SELECT 1 FROM deep_seed_log WHERE city_key = ?").get(key);
  }
  markDeepSeeded(city: string, state: string, addressCount: number): void {
    const key = `${city.trim().toLowerCase()}|${state.trim().toLowerCase()}`;
    rawDb.prepare("INSERT OR REPLACE INTO deep_seed_log (city_key, city, state, address_count, seeded_at) VALUES (?,?,?,?,datetime('now'))")
      .run(key, city.trim(), state.trim().toUpperCase(), addressCount);
  }
  // ── Scan targets (persistent address pool) ───────────────────────────────────
  // Insert harvested addresses once; duplicates are ignored (address is UNIQUE),
  // so the pool grows without re-geocoding. Returns how many NEW rows were added.
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
    const tx = rawDb.transaction((rows: typeof addrs) => {
      let n = 0;
      for (const r of rows) {
        if (!r.address) continue;
        const scanned = !!r.scannedNow;
        const params = {
          address: r.address, city: r.city ?? "", state: r.state ?? "NC", zip: r.zip ?? "",
          lat: r.lat ?? null, lng: r.lng ?? null, source: r.source ?? null, tenantId: r.tenantId ?? null,
          canonicalKey: r.canonicalKey ?? null,
          df: r.dfAddressId ?? null,
          fs: scanned ? (r.fiberStatus ?? null) : null,
          nf: scanned && r.isNewFiber ? 1 : 0,
          bs: scanned ? (r.billingStatus ?? null) : null,
          scannedAt: scanned ? new Date().toISOString() : null,
          scanCount: scanned ? 1 : 0,
        };
        const inserted = insertStmt.run(params).changes;
        n += inserted;
        if (!inserted) {
          const key = { address: r.address, city: r.city ?? "", state: r.state ?? "NC" };
          // Backfill identity (df/coords/zip) — same-city only.
          if (r.dfAddressId || r.lat != null || r.lng != null || r.zip) {
            enrichStmt.run({ ...key, canonicalKey: r.canonicalKey ?? null, df: r.dfAddressId ?? null,
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
    return tx(addrs);
  }
  // Oldest-scanned (and never-scanned) targets first — the re-scan queue. Skips
  // never-scanned rows that have been probed inconclusive `INCONCLUSIVE_GIVEUP`+
  // times (exhausted — Kinetic doesn't recognize them; re-probing burns proxy $ for
  // nothing). Already-scanned rows are never parked — the nightly moat keeps
  // re-checking them so a real unavailable→live flip is still caught.
  getScanTargetsToRescan(limit: number): any[] {
    return rawDb.prepare(
      `SELECT * FROM scan_targets
         WHERE last_scanned_at IS NOT NULL OR inconclusive_attempts < ?
         ORDER BY (last_scanned_at IS NOT NULL), last_scanned_at ASC LIMIT ?`
    ).all(INCONCLUSIVE_GIVEUP, limit);
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
  recordScanTargetResult(id: number, r: { fiberStatus?: string | null; fiberAvailable?: boolean; isNewFiber?: boolean; billingStatus?: string | null; dfAddressId?: string | null; accessId?: string | null; serviceKey?: string | null; convertedToLeadId?: number | null; availabilityStatus?: string | null; newlyLive?: boolean; customerSegment?: string; customerConfidence?: string; customerSignals?: string[] }): { prevIsNewFiber: boolean } {
    const prev = rawDb.prepare("SELECT last_is_new_fiber FROM scan_targets WHERE id = ?").get(id) as any;
    rawDb.prepare(
      `UPDATE scan_targets SET last_fiber_status=@fs, last_is_new_fiber=@nf, last_billing_status=@bs,
         access_id=COALESCE(@accessId,access_id), service_key=COALESCE(@serviceKey,service_key),
         last_fiber_available=COALESCE(@fiberAvailable,last_fiber_available),
         last_customer_segment=COALESCE(@customerSegment,last_customer_segment),
         last_customer_confidence=COALESCE(@customerConfidence,last_customer_confidence),
         last_customer_signals=COALESCE(@customerSignals,last_customer_signals),
         df_address_id=COALESCE(@df, df_address_id),
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
         last_scanned_at=datetime('now'), scan_count=scan_count+1 WHERE id=@id`
    ).run({
      id, fs: r.fiberStatus ?? null, nf: r.isNewFiber ? 1 : 0, bs: r.billingStatus ?? null,
      df: r.dfAddressId ?? null, accessId: r.accessId ?? null, serviceKey: r.serviceKey ?? null,
      lead: r.convertedToLeadId ?? null,
      avail: r.availabilityStatus ?? null, newly: r.newlyLive ? 1 : 0,
      fiberAvailable: r.fiberAvailable == null ? null : (r.fiberAvailable ? 1 : 0),
      customerSegment: r.customerSegment ?? null,
      customerConfidence: r.customerConfidence ?? null,
      customerSignals: r.customerSignals ? JSON.stringify(r.customerSignals) : null,
    });
    return { prevIsNewFiber: !!(prev && prev.last_is_new_fiber) };
  }
  // Count ONE inconclusive probe against a pooled address (by id, or by its globally
  // unique address). At INCONCLUSIVE_GIVEUP the row is "exhausted" and the re-probe
  // selectors (getScanTargetsToRescan + loadCityPoolAddresses) skip it. No-op if the
  // address isn't pooled (e.g. a fringe candidate that never got persisted) or the
  // row was already conclusively answered (last_scanned_at set) — we never park a row
  // that has a real answer. Idempotent per (address, run): callers bump once per probe.
  bumpScanTargetInconclusive(ref: { id?: number; address?: string }): void {
    if (ref.id != null) {
      rawDb.prepare(
        `UPDATE scan_targets
           SET inconclusive_attempts = inconclusive_attempts + 1, last_inconclusive_at = datetime('now')
         WHERE id = ? AND last_scanned_at IS NULL`
      ).run(ref.id);
    } else if (ref.address) {
      rawDb.prepare(
        `UPDATE scan_targets
           SET inconclusive_attempts = inconclusive_attempts + 1, last_inconclusive_at = datetime('now')
         WHERE address = ? AND last_scanned_at IS NULL`
      ).run(ref.address);
    }
  }
  // How many pooled addresses are exhausted (parked out of re-probe) — for honest
  // "STILL QUEUED vs GIVEN UP" reporting so a silenced address is never a silent gap.
  getScanTargetExhaustedCount(city?: string, zip?: string): number {
    const where = ["last_scanned_at IS NULL", "inconclusive_attempts >= ?"];
    const args: any[] = [INCONCLUSIVE_GIVEUP];
    if (city) { where.push("lower(city) = lower(?)"); args.push(city); }
    if (zip) { where.push("(zip = ? OR zip IS NULL)"); args.push(zip); }
    return (rawDb.prepare(
      `SELECT COUNT(*) c FROM scan_targets WHERE ${where.join(" AND ")}`
    ).get(...args) as any).c;
  }
  // First-to-market feed: addresses that FLIPPED live within the window, newest
  // first. Indexed scan on first_seen_live_at; capped. Tenant-scoped when a
  // tenantId is given. Legacy unowned pool rows are deliberately excluded;
  // shared mutable scan state is never a safe multi-tenant read model.
  getFirstSeenLive(sinceHours: number, limit = 200, tenantId?: number): any[] {
    const scope = tenantId != null ? "AND tenant_id = ?" : "";
    const args: any[] = [`-${Math.max(1, Math.floor(sinceHours))} hours`];
    if (tenantId != null) args.push(tenantId);
    args.push(limit);
    return rawDb.prepare(
      `SELECT id, address, city, state, zip, lat, lng, first_seen_live_at AS firstSeenLiveAt,
              last_availability_status AS availabilityStatus, converted_to_lead_id AS leadId, last_scanned_at AS lastScannedAt
         FROM scan_targets
        WHERE first_seen_live_at IS NOT NULL
          AND first_seen_live_at >= datetime('now', ?) ${scope}
        ORDER BY first_seen_live_at DESC LIMIT ?`
    ).all(...args);
  }
  getScanTargetStats(): { total: number; scanned: number; neverScanned: number; newFiber: number; lastScannedAt: string | null } {
    const g = (q: string) => (rawDb.prepare(q).get() as any);
    const total = g("SELECT COUNT(*) c FROM scan_targets").c;
    const scanned = g("SELECT COUNT(*) c FROM scan_targets WHERE last_scanned_at IS NOT NULL").c;
    const newFiber = g("SELECT COUNT(*) c FROM scan_targets WHERE last_is_new_fiber = 1").c;
    const lastScannedAt = g("SELECT MAX(last_scanned_at) m FROM scan_targets").m ?? null;
    return { total, scanned, neverScanned: total - scanned, newFiber, lastScannedAt };
  }

  // ── Commissions ────────────────────────────────────────────────────────────
  getCommissions(tenantId?: number, repId?: number): Commission[] {
    const conds = [] as any[];
    if (tenantId != null) conds.push(eq(commissions.tenantId, tenantId));
    if (repId != null) conds.push(eq(commissions.repId, repId));
    const q = db.select().from(commissions);
    return (conds.length ? q.where(and(...conds)) : q).orderBy(desc(commissions.createdAt)).all();
  }
  getCommissionById(id: number): Commission | undefined {
    return db.select().from(commissions).where(eq(commissions.id, id)).get();
  }
  createCommission(c: InsertCommission): Commission {
    // Tenancy: a commission belongs to the REP's tenant (unless explicitly set).
    const tenantId = (c as any).tenantId ?? this.getTeamMemberById(c.repId)?.tenantId ?? null;
    return db.insert(commissions).values({ ...c, tenantId, createdAt: new Date().toISOString() }).returning().get();
  }
  updateCommission(id: number, updates: Partial<Commission>): Commission | undefined {
    return db.update(commissions).set(updates).where(eq(commissions.id, id)).returning().get();
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
  getCommissionSummary() {
    const reps = this.getTeamMembers().filter(r => r.active);
    return reps.map(rep => {
      const repCommissions = db.select().from(commissions).where(eq(commissions.repId, rep.id)).all();
      const total = repCommissions.reduce((sum, c) => sum + c.amount, 0);
      const paid = repCommissions.filter(c => c.status === "paid").reduce((sum, c) => sum + c.amount, 0);
      const pending = repCommissions.filter(c => c.status === "pending" || c.status === "approved").reduce((sum, c) => sum + c.amount, 0);
      return { repId: rep.id, repName: rep.name, total, paid, pending, sales: repCommissions.length };
    });
  }

  // ── Commission Rates ───────────────────────────────────────────────────────
  getCommissionRates(): CommissionRate[] {
    return db.select().from(commissionRates).where(eq(commissionRates.isActive, true)).all();
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
  getTenantByOwnerEmail(email: string): Tenant | undefined {
    return db.select().from(tenants).where(eq(tenants.ownerEmail, email)).get();
  }
  createTenant(t: InsertTenant): Tenant {
    return db.insert(tenants).values({ ...t, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }).returning().get();
  }
  updateTenant(id: number, updates: Partial<Tenant>): Tenant | undefined {
    return db.update(tenants).set({ ...updates, updatedAt: new Date().toISOString() }).where(eq(tenants.id, id)).returning().get();
  }
  deleteTenant(id: number): void {
    db.delete(tenants).where(eq(tenants.id, id)).run();
  }
  getTenantStats(tenantId: number): { reps: number; leads: number; sold: number; territories: number } {
    const reps = db.select().from(users).where(and(eq(users.tenantId, tenantId), eq(users.active, true))).all().length;
    const allLeads = db.select().from(leads).where(eq(leads.tenantId, tenantId)).all();
    const sold = allLeads.filter(l => l.leadStatus === 'sold').length;
    const terrs = db.select().from(territories).where(eq(territories.tenantId, tenantId)).all().length;
    return { reps, leads: allLeads.length, sold, territories: terrs };
  }
}

export const storage = new Storage();
