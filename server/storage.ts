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
import { eq, desc, like, or, and, gt, isNull } from "drizzle-orm";
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

export interface IStorage {
  // ── Leads ──────────────────────────────────────────────────────────────────
  getLeads(tenantId?: number, assignedRepId?: number): Lead[];
  getLeadById(id: number): Lead | undefined;
  createLead(lead: InsertLead): Lead;
  upsertLeadByAddress(lead: InsertLead & LegacyScanFields): { lead: Lead; created: boolean };
  updateLead(id: number, updates: Partial<InsertLead>, tenantId?: number): Lead | undefined;
  deleteLead(id: number, tenantId?: number): boolean;
  searchLeads(query: string, tenantId?: number, assignedRepId?: number): Lead[];
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
  getVisitSummary(): Map<number, { count: number; lastOutcome: string; lastAt: string }>;
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
  getFirstSeenLive(sinceHours: number, limit?: number): any[];
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

export class Storage implements IStorage {
  // ── Leads ──────────────────────────────────────────────────────────────────
  getLeads(tenantId?: number, assignedRepId?: number): Lead[] {
    const conditions = [];
    if (tenantId != null) conditions.push(eq(leads.tenantId, tenantId));
    // For reps: filter to only their assigned leads
    if (assignedRepId != null) conditions.push(eq(leads.assignedRepId, assignedRepId));
    const q = db.select().from(leads);
    return (conditions.length > 0
      ? q.where(conditions.length === 1 ? conditions[0] : and(...conditions))
      : q).orderBy(desc(leads.createdAt)).all();
  }
  getLeadById(id: number): Lead | undefined {
    return db.select().from(leads).where(eq(leads.id, id)).get();
  }
  createLead(lead: InsertLead): Lead {
    const now = new Date().toISOString();
    return db.insert(leads).values({ ...lead, createdAt: now, updatedAt: now }).returning().get();
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
      lead.tenantId ?? null,
      now,
      now
    );
    const newLead = rawDb.prepare(`SELECT * FROM leads WHERE id = ?`).get(r.lastInsertRowid) as Lead;
    // Update in-memory cache with newly inserted address
    if (_addressCache) _addressCache.add(normalizedAddr);
    return { lead: newLead, created: true };
  }
  updateLead(id: number, updates: Partial<InsertLead>, tenantId?: number): Lead | undefined {
    const condition = tenantId != null
      ? and(eq(leads.id, id), eq(leads.tenantId, tenantId))
      : eq(leads.id, id);
    return db.update(leads).set({ ...updates, updatedAt: new Date().toISOString() })
      .where(condition).returning().get();
  }
  deleteLead(id: number, tenantId?: number): boolean {
    const condition = tenantId != null
      ? and(eq(leads.id, id), eq(leads.tenantId, tenantId))
      : eq(leads.id, id);
    return db.delete(leads).where(condition).run().changes > 0;
  }
  searchLeads(query: string, tenantId?: number, assignedRepId?: number): Lead[] {
    const textFilter = or(
      like(leads.address, `%${query}%`), like(leads.city, `%${query}%`),
      like(leads.zip, `%${query}%`), like(leads.contactName, `%${query}%`)
    );
    const conditions = [textFilter];
    if (tenantId != null) conditions.push(eq(leads.tenantId, tenantId));
    if (assignedRepId != null) conditions.push(eq(leads.assignedRepId, assignedRepId));
    return db.select().from(leads).where(
      conditions.length === 1 ? conditions[0] : and(...conditions)
    ).all();
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
    return db.insert(knockLog).values({
      ...knock,
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
  // One grouped query; feeds the "visited" check + last-outcome on each pin.
  getVisitSummary(): Map<number, { count: number; lastOutcome: string; lastAt: string }> {
    const rows = rawDb.prepare(
      `SELECT lead_id AS leadId, COUNT(*) AS count, MAX(knocked_at) AS lastAt,
              (SELECT outcome FROM knock_log k2 WHERE k2.lead_id = k1.lead_id ORDER BY knocked_at DESC LIMIT 1) AS lastOutcome
       FROM knock_log k1 GROUP BY lead_id`
    ).all() as any[];
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
    return db.insert(users).values({ ...user, email: user.email.toLowerCase(), createdAt: new Date().toISOString() }).returning().get();
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
    return db.insert(clockSessions).values({ repId, userId, clockedIn: now, date, notes: notes || null }).returning().get();
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
  // first. Indexed scan on first_seen_live_at; capped.
  getFirstSeenLive(sinceHours: number, limit = 200): any[] {
    return rawDb.prepare(
      `SELECT id, address, city, state, zip, lat, lng, first_seen_live_at AS firstSeenLiveAt,
              last_availability_status AS availabilityStatus, converted_to_lead_id AS leadId, last_scanned_at AS lastScannedAt
         FROM scan_targets
        WHERE first_seen_live_at IS NOT NULL
          AND first_seen_live_at >= datetime('now', ?)
        ORDER BY first_seen_live_at DESC LIMIT ?`
    ).all(`-${Math.max(1, Math.floor(sinceHours))} hours`, limit);
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
    return db.insert(commissions).values({ ...c, createdAt: new Date().toISOString() }).returning().get();
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
