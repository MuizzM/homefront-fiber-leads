import { db, rawDb } from "./db";
import {
  leads, fiberChecks, teamMembers, knockLog,
  users, sessions, otpCodes, territories, repApplications,
  territoryRequests, locationPings, clockSessions,
  comingSoonAddresses, commissions, commissionRates, activityLog, tenants,
  activityOverrides,
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
  type ComingSoonAddress, type InsertComingSoon,
  type Commission, type InsertCommission,
  type CommissionRate, type InsertCommissionRate,
  type ActivityLogEntry,
  type Tenant, type InsertTenant,
} from "@shared/schema";
import { eq, desc, or, and, gt, isNull, inArray, sql } from "drizzle-orm";
import { DEFAULT_GEO_CONFIG, type GeoConfig } from "@shared/geoVerify";

// Legacy scanner columns that exist in SQLite but predate the drizzle schema —
// upsertLeadByAddress still persists them when a scanner payload carries them.
type LegacyScanFields = { maxDownload?: number | null; isNewDeployment?: boolean | null };

// Server-computed location verdict written alongside a knock (never client-set).
export type KnockVerdict = {
  serverTs: string;
  distanceM: number | null;
  verificationStatus: string;
  reviewReason: string | null;
};

// The 16 lead columns the map pin/popup actually uses — the narrow projection
// getLeadsForMap selects instead of all 53 columns.
export type MapPinRow = Pick<Lead,
  "id" | "address" | "city" | "state" | "zip" | "lat" | "lng" | "leadStatus" |
  "fiberStatus" | "isNewFiber" | "assignedRepId" | "maxDownloadMbps" |
  "competitorName" | "leadScore" | "contactName" | "contactPhone">;

export interface IStorage {
  // ── Leads ──────────────────────────────────────────────────────────────────
  getLeads(tenantId?: number, assignedRep?: number | number[]): Lead[];
  getLeadsForMap(tenantId?: number, assignedRep?: number | number[]): MapPinRow[];
  getLeadsPage(
    tenantId: number | undefined,
    assignedRep: number | number[] | undefined,
    opts: { status?: string; zip?: string; city?: string; state?: string; limit: number; offset: number },
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
    opts: { status?: string; zip?: string; city?: string; state?: string; limit: number; offset: number },
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
  getKnocks(): Knock[];
  getKnocksByLead(leadId: number): Knock[];
  getKnocksByRep(repId: number): Knock[];
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
  getLeaderboard(): { rep: TeamMember; knocks: number; contacts: number; callbacks: number; sales: number; knocksToday: number; salesToday: number }[];
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
  getRepApplications(status?: string): RepApplication[];
  getRepApplicationById(id: number): RepApplication | undefined;
  createRepApplication(app: any): RepApplication;
  updateRepApplication(id: number, updates: Partial<RepApplication>): RepApplication | undefined;
  // ── GPS Location Pings ─────────────────────────────────────────────────────
  createLocationPing(ping: InsertLocationPing): LocationPing;
  getLatestPingPerRep(): LocationPing[];
  getPingsByRep(repId: number, limit?: number): LocationPing[];
  // ── Clock Sessions ─────────────────────────────────────────────────────────
  clockIn(repId: number, userId: number, notes?: string): ClockSession;
  clockOut(sessionId: number): ClockSession | undefined;
  getActiveClockSession(repId: number): ClockSession | undefined;
  getClockSessionsByRep(repId: number): ClockSession[];
  getAllClockSessions(date?: string): ClockSession[];
  // ── Coming Soon Pipeline ───────────────────────────────────────────────────
  getComingSoonAddresses(): ComingSoonAddress[];
  createComingSoon(addr: InsertComingSoon): ComingSoonAddress;
  updateComingSoon(id: number, updates: Partial<ComingSoonAddress>): ComingSoonAddress | undefined;
  deleteComingSoon(id: number): boolean;
  markComingSoonAvailable(id: number, leadId: number): ComingSoonAddress | undefined;
  markComingSoonChecked(id: number): ComingSoonAddress | undefined;
  // ── Scan targets (persistent address pool) ───────────────────────────────────
  upsertScanTargets(addrs: Array<{ address: string; city?: string; state?: string; zip?: string; lat?: number | null; lng?: number | null; source?: string; tenantId?: number | null }>): number;
  getScanTargetsToRescan(limit: number): any[];
  getScanTargetsByCity(city: string, state: string): any[];
  recordScanTargetResult(id: number, r: { fiberStatus?: string | null; isNewFiber?: boolean; billingStatus?: string | null; dfAddressId?: string | null; convertedToLeadId?: number | null; availabilityStatus?: string | null; newlyLive?: boolean }): { prevIsNewFiber: boolean };
  getFirstSeenLive(sinceHours: number, limit?: number, tenantId?: number): any[];
  getScanTargetStats(): { total: number; scanned: number; neverScanned: number; newFiber: number; lastScannedAt: string | null };
  // ── Commissions ────────────────────────────────────────────────────────────
  getCommissions(repId?: number): Commission[];
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
  logActivity(userId: number | null, action: string, entityType?: string, entityId?: number, details?: object, ip?: string): void;
  getActivityLog(limit?: number): ActivityLogEntry[];
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
    // Existing tables
    `CREATE TABLE IF NOT EXISTS team_members (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT, email TEXT, role TEXT NOT NULL DEFAULT 'rep', active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS knock_log (id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id INTEGER NOT NULL, rep_id INTEGER NOT NULL, knocked_at TEXT NOT NULL DEFAULT (datetime('now')), was_home INTEGER NOT NULL, outcome TEXT NOT NULL, callback_date TEXT, callback_time TEXT, notes TEXT)`,
    `ALTER TABLE leads ADD COLUMN assigned_rep_id INTEGER`,
    `ALTER TABLE leads ADD COLUMN assigned_by TEXT`,
    `ALTER TABLE leads ADD COLUMN billing_status TEXT`,
    `CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT, role TEXT NOT NULL DEFAULT 'rep', team_member_id INTEGER, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS otp_codes (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, code TEXT NOT NULL, expires_at TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS territories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, rep_id INTEGER NOT NULL, polygon TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#3b82f6', created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS territory_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, rep_id INTEGER NOT NULL, user_id INTEGER NOT NULL, message TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS rep_applications (id INTEGER PRIMARY KEY AUTOINCREMENT, full_name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT NOT NULL, city TEXT NOT NULL, zip TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'NC', has_sales_experience INTEGER NOT NULL DEFAULT 0, sales_experience_details TEXT, preferred_carriers TEXT NOT NULL, referral_source TEXT, headshot_path TEXT, license_path TEXT, status TEXT NOT NULL DEFAULT 'pending', reviewed_by INTEGER, review_notes TEXT, user_id INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    // New SaaS tables
    `CREATE TABLE IF NOT EXISTS location_pings (id INTEGER PRIMARY KEY AUTOINCREMENT, rep_id INTEGER NOT NULL, user_id INTEGER NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL, accuracy REAL, ping_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS clock_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, rep_id INTEGER NOT NULL, user_id INTEGER NOT NULL, clocked_in TEXT NOT NULL, clocked_out TEXT, duration_minutes INTEGER, notes TEXT, date TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS coming_soon_addresses (id INTEGER PRIMARY KEY AUTOINCREMENT, address TEXT NOT NULL UNIQUE, city TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'NC', zip TEXT NOT NULL, lat REAL, lng REAL, reason TEXT NOT NULL DEFAULT 'no_service', last_checked TEXT, fiber_available INTEGER DEFAULT 0, converted_to_lead_id INTEGER, added_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS commissions (id INTEGER PRIMARY KEY AUTOINCREMENT, rep_id INTEGER NOT NULL, lead_id INTEGER, knock_id INTEGER, amount REAL NOT NULL, status TEXT NOT NULL DEFAULT 'pending', sale_date TEXT NOT NULL, paid_date TEXT, notes TEXT, approved_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS commission_rates (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, role TEXT, rep_id INTEGER, rate_per_sale REAL NOT NULL, is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS activity_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, action TEXT NOT NULL, entity_type TEXT, entity_id INTEGER, details TEXT, ip TEXT, at TEXT NOT NULL DEFAULT (datetime('now')))`,
    // Lead scoring columns (safe to run on existing DB)
    `ALTER TABLE leads ADD COLUMN lead_tag TEXT`,
    `ALTER TABLE leads ADD COLUMN lead_score INTEGER DEFAULT 0`,
    // tenant_id support for multi-tenant tables (safe — duplicate column errors are swallowed)
    `ALTER TABLE team_members ADD COLUMN tenant_id INTEGER`,
    `ALTER TABLE territories ADD COLUMN tenant_id INTEGER`,
    `ALTER TABLE coming_soon_addresses ADD COLUMN tenant_id INTEGER`,
    `ALTER TABLE commissions ADD COLUMN tenant_id INTEGER`,
    // users/leads got tenant_id from drizzle-kit push in prod; these ALTERs make
    // a migrations-only DB (tests, fresh installs) match.
    `ALTER TABLE users ADD COLUMN tenant_id INTEGER`,
    `ALTER TABLE leads ADD COLUMN tenant_id INTEGER`,
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
    // Org hierarchy: which team_lead/manager a member reports to (null = top-level)
    `ALTER TABLE team_members ADD COLUMN reports_to_id INTEGER`,
    // Persistent address pool — harvest once, re-scan for fiber-status changes
    `CREATE TABLE IF NOT EXISTS scan_targets (id INTEGER PRIMARY KEY AUTOINCREMENT, address TEXT NOT NULL UNIQUE, city TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'NC', zip TEXT NOT NULL, lat REAL, lng REAL, tenant_id INTEGER, source TEXT, last_fiber_status TEXT, last_is_new_fiber INTEGER NOT NULL DEFAULT 0, last_billing_status TEXT, df_address_id TEXT, scan_count INTEGER NOT NULL DEFAULT 0, last_scanned_at TEXT, converted_to_lead_id INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `ALTER TABLE scan_targets ADD COLUMN first_seen_live_at TEXT`,
    `ALTER TABLE scan_targets ADD COLUMN last_availability_status TEXT`,
    `CREATE INDEX IF NOT EXISTS idx_scan_targets_scanned ON scan_targets(last_scanned_at)`,
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
      const res = raw.prepare(`UPDATE ${table} SET tenant_id = ? WHERE tenant_id IS NULL`).run(tenant.id);
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

// ── In-memory address cache for ultra-fast scan dedup ───────────────────────
// Loaded once on startup, updated on every insert. O(1) dedup — no DB hit.
let _addressCache: Set<string> | null = null;

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

function getAddressCache(): Set<string> {
  if (_addressCache) return _addressCache;
  const rows = rawDb.prepare("SELECT address FROM leads").all() as { address: string }[];
  _addressCache = new Set(rows.map(r => normalizeAddress(r.address ?? "")));
  console.log(`[storage] Address cache warmed: ${_addressCache.size} entries`);
  return _addressCache;
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

  // Map-pin projection: ONLY the 16 fields a pin/popup uses (leads has 53
  // columns) and NO ORDER BY — the map doesn't care about order, and dropping
  // it lets SQLite serve scoped reads straight off idx_leads_tenant_rep with
  // no temp B-tree. ~70% less row hydration than getLeads() at 50k.
  getLeadsForMap(tenantId?: number, assignedRep?: number | number[]): MapPinRow[] {
    const conditions = [];
    if (tenantId != null) conditions.push(eq(leads.tenantId, tenantId));
    if (Array.isArray(assignedRep)) {
      conditions.push(assignedRep.length ? inArray(leads.assignedRepId, assignedRep) : eq(leads.assignedRepId, -1));
    } else if (assignedRep != null) {
      conditions.push(eq(leads.assignedRepId, assignedRep));
    }
    const q = db.select({
      id: leads.id, address: leads.address, city: leads.city, state: leads.state,
      zip: leads.zip, lat: leads.lat, lng: leads.lng, leadStatus: leads.leadStatus,
      fiberStatus: leads.fiberStatus, isNewFiber: leads.isNewFiber,
      assignedRepId: leads.assignedRepId, maxDownloadMbps: leads.maxDownloadMbps,
      competitorName: leads.competitorName, leadScore: leads.leadScore,
      contactName: leads.contactName, contactPhone: leads.contactPhone,
    }).from(leads);
    return (conditions.length > 0
      ? q.where(conditions.length === 1 ? conditions[0] : and(...conditions))
      : q).all();
  }

  // Paged list query for /api/leads — filters + ORDER BY + LIMIT/OFFSET pushed
  // into SQL (the route used to hydrate EVERY tenant row to serve a 200-row
  // page). Count runs the same WHERE. Scope conditions identical to getLeads.
  getLeadsPage(
    tenantId: number | undefined,
    assignedRep: number | number[] | undefined,
    opts: { status?: string; zip?: string; city?: string; state?: string; limit: number; offset: number },
  ): { rows: Lead[]; total: number } {
    const conditions = [];
    if (tenantId != null) conditions.push(eq(leads.tenantId, tenantId));
    if (Array.isArray(assignedRep)) {
      conditions.push(assignedRep.length ? inArray(leads.assignedRepId, assignedRep) : eq(leads.assignedRepId, -1));
    } else if (assignedRep != null) {
      conditions.push(eq(leads.assignedRepId, assignedRep));
    }
    if (opts.status) conditions.push(eq(leads.leadStatus, opts.status));
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

    // ── In-memory cache check (O(1) — no DB hit) ──────────────────────────────
    const cache = getAddressCache();
    if (cache.has(normalizedAddr)) {
      // Cache hit — look up in DB only to return the full Lead object
      const exactHit = rawDb.prepare("SELECT * FROM leads WHERE address = ? LIMIT 1").get(lead.address ?? "") as Lead | undefined;
      if (exactHit) return { lead: exactHit, created: false };
      // Normalized fallback (suffix abbreviation diff)
      const prefix = normalizedAddr.split(" ")[0];
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
    // Update in-memory cache with newly inserted address
    if (_addressCache) _addressCache.add(normalizedAddr);
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
    opts: { status?: string; zip?: string; city?: string; state?: string; limit: number; offset: number },
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
  getRecentChecks(limit = 100, _tenantId?: number): FiberCheck[] {
    return db.select().from(fiberChecks).orderBy(desc(fiberChecks.checkedAt)).limit(limit).all();
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
  getKnocks(): Knock[] {
    return db.select().from(knockLog).orderBy(desc(knockLog.knockedAt)).all();
  }
  getKnocksByLead(leadId: number): Knock[] {
    return db.select().from(knockLog).where(eq(knockLog.leadId, leadId)).orderBy(desc(knockLog.knockedAt)).all();
  }
  getKnocksByRep(repId: number): Knock[] {
    return db.select().from(knockLog).where(eq(knockLog.repId, repId)).all();
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
  getLeaderboard() {
    const reps = this.getTeamMembers().filter(r => r.active);
    // Local midnight — a 7am knock must count as "today" in the rep's timezone.
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const midnightIso = midnight.toISOString();
    return reps.map(rep => {
      const repKnocks = this.getKnocksByRep(rep.id);
      const today = repKnocks.filter(k => k.knockedAt >= midnightIso);
      return {
        rep,
        knocks: repKnocks.length,
        contacts: repKnocks.filter(k => k.wasHome).length,
        callbacks: repKnocks.filter(k => k.outcome === "callback").length,
        sales: repKnocks.filter(k => k.outcome === "sold").length,
        knocksToday: today.length,
        salesToday: today.filter(k => k.outcome === "sold").length,
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
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    db.insert(otpCodes).values({ email: email.toLowerCase(), code, expiresAt, createdAt: new Date().toISOString() }).run();
    return code;
  }
  verifyOtp(email: string, code: string): boolean {
    const now = new Date().toISOString();
    const otp = db.select().from(otpCodes)
      .where(and(eq(otpCodes.email, email.toLowerCase()), eq(otpCodes.code, code),
        eq(otpCodes.used, false), gt(otpCodes.expiresAt, now))).get();
    if (!otp) return false;
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
  getRepApplications(status?: string): RepApplication[] {
    if (status) return db.select().from(repApplications).where(eq(repApplications.status, status)).all();
    return db.select().from(repApplications).all();
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
  getLatestPingPerRep(): LocationPing[] {
    // Get all pings, group by repId keeping most recent
    const all = db.select().from(locationPings).orderBy(desc(locationPings.pingAt)).all();
    const seen = new Set<number>();
    return all.filter(p => { if (seen.has(p.repId)) return false; seen.add(p.repId); return true; });
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
  getAllClockSessions(date?: string): ClockSession[] {
    if (date) return db.select().from(clockSessions).where(eq(clockSessions.date, date)).all();
    return db.select().from(clockSessions).orderBy(desc(clockSessions.clockedIn)).all();
  }

  // ── Coming Soon Pipeline ───────────────────────────────────────────────────
  getComingSoonAddresses(): ComingSoonAddress[] {
    return db.select().from(comingSoonAddresses).orderBy(desc(comingSoonAddresses.createdAt)).all();
  }
  createComingSoon(addr: InsertComingSoon): ComingSoonAddress {
    return db.insert(comingSoonAddresses).values({ ...addr, createdAt: new Date().toISOString() }).returning().get();
  }
  updateComingSoon(id: number, updates: Partial<ComingSoonAddress>): ComingSoonAddress | undefined {
    return db.update(comingSoonAddresses).set(updates).where(eq(comingSoonAddresses.id, id)).returning().get();
  }
  deleteComingSoon(id: number): boolean {
    return db.delete(comingSoonAddresses).where(eq(comingSoonAddresses.id, id)).run().changes > 0;
  }
  markComingSoonAvailable(id: number, leadId: number): ComingSoonAddress | undefined {
    return db.update(comingSoonAddresses)
      .set({ fiberAvailable: true, convertedToLeadId: leadId, lastChecked: new Date().toISOString() })
      .where(eq(comingSoonAddresses.id, id)).returning().get();
  }
  markComingSoonChecked(id: number): ComingSoonAddress | undefined {
    return db.update(comingSoonAddresses)
      .set({ lastChecked: new Date().toISOString() })
      .where(eq(comingSoonAddresses.id, id)).returning().get();
  }

  // ── Scan targets (persistent address pool) ───────────────────────────────────
  // Insert harvested addresses once; duplicates are ignored (address is UNIQUE),
  // so the pool grows without re-geocoding. Returns how many NEW rows were added.
  upsertScanTargets(addrs: Array<{ address: string; city?: string; state?: string; zip?: string; lat?: number | null; lng?: number | null; source?: string; tenantId?: number | null }>): number {
    if (!addrs.length) return 0;
    const stmt = rawDb.prepare(
      `INSERT OR IGNORE INTO scan_targets (address, city, state, zip, lat, lng, source, tenant_id, created_at)
       VALUES (@address, @city, @state, @zip, @lat, @lng, @source, @tenantId, datetime('now'))`
    );
    const tx = rawDb.transaction((rows: typeof addrs) => {
      let n = 0;
      for (const r of rows) {
        if (!r.address) continue;
        n += stmt.run({
          address: r.address, city: r.city ?? "", state: r.state ?? "NC", zip: r.zip ?? "",
          lat: r.lat ?? null, lng: r.lng ?? null, source: r.source ?? null, tenantId: r.tenantId ?? null,
        }).changes;
      }
      return n;
    });
    return tx(addrs);
  }
  // Oldest-scanned (and never-scanned) targets first — the re-scan queue.
  getScanTargetsToRescan(limit: number): any[] {
    return rawDb.prepare(
      `SELECT * FROM scan_targets ORDER BY (last_scanned_at IS NOT NULL), last_scanned_at ASC LIMIT ?`
    ).all(limit);
  }
  // Pool lookup by city — lets scans reuse already-harvested addresses instead
  // of re-geocoding (harvest once, re-scan free).
  getScanTargetsByCity(city: string, state: string): any[] {
    return rawDb.prepare(
      `SELECT address, city, state, zip, lat, lng FROM scan_targets
       WHERE lower(city) = lower(?) AND lower(state) = lower(?)`
    ).all(city.trim(), state.trim());
  }
  // Record a fresh scan result. Returns the PREVIOUS is_new_fiber so the caller
  // can detect a change (was not new fiber → now new fiber = new hot lead).
  recordScanTargetResult(id: number, r: { fiberStatus?: string | null; isNewFiber?: boolean; billingStatus?: string | null; dfAddressId?: string | null; convertedToLeadId?: number | null; availabilityStatus?: string | null; newlyLive?: boolean }): { prevIsNewFiber: boolean } {
    const prev = rawDb.prepare("SELECT last_is_new_fiber FROM scan_targets WHERE id = ?").get(id) as any;
    rawDb.prepare(
      `UPDATE scan_targets SET last_fiber_status=@fs, last_is_new_fiber=@nf, last_billing_status=@bs,
         df_address_id=COALESCE(@df, df_address_id),
         converted_to_lead_id=COALESCE(@lead, converted_to_lead_id),
         last_availability_status=COALESCE(@avail, last_availability_status),
         -- first-seen-live is stamped ONCE on the first newly_live flip, never overwritten
         first_seen_live_at=CASE WHEN @newly=1 AND first_seen_live_at IS NULL THEN datetime('now') ELSE first_seen_live_at END,
         last_scanned_at=datetime('now'), scan_count=scan_count+1 WHERE id=@id`
    ).run({
      id, fs: r.fiberStatus ?? null, nf: r.isNewFiber ? 1 : 0, bs: r.billingStatus ?? null,
      df: r.dfAddressId ?? null, lead: r.convertedToLeadId ?? null,
      avail: r.availabilityStatus ?? null, newly: r.newlyLive ? 1 : 0,
    });
    return { prevIsNewFiber: !!(prev && prev.last_is_new_fiber) };
  }
  // First-to-market feed: addresses that FLIPPED live within the window, newest
  // first. Indexed scan on first_seen_live_at; capped. Tenant-scoped when a
  // tenantId is given (shared platform-pool rows have tenant_id NULL and are
  // visible to all) so one org never sees another's flips/converted leads.
  getFirstSeenLive(sinceHours: number, limit = 200, tenantId?: number): any[] {
    const scope = tenantId != null ? "AND (tenant_id = ? OR tenant_id IS NULL)" : "";
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
  getCommissions(repId?: number): Commission[] {
    if (repId) return db.select().from(commissions).where(eq(commissions.repId, repId)).orderBy(desc(commissions.createdAt)).all();
    return db.select().from(commissions).orderBy(desc(commissions.createdAt)).all();
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
  logActivity(userId: number | null, action: string, entityType?: string, entityId?: number, details?: object, ip?: string): void {
    db.insert(activityLog).values({
      userId: userId ?? null,
      action,
      entityType: entityType ?? null,
      entityId: entityId ?? null,
      details: details ? JSON.stringify(details) : null,
      ip: ip ?? null,
      at: new Date().toISOString(),
    }).run();
  }
  getActivityLog(limit = 100): ActivityLogEntry[] {
    return db.select().from(activityLog).orderBy(desc(activityLog.at)).limit(limit).all();
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
