import { db, rawDb } from "./db";
import {
  leads, fiberChecks, teamMembers, knockLog,
  users, sessions, otpCodes, territories, repApplications,
  territoryRequests, locationPings, clockSessions,
  comingSoonAddresses, commissions, commissionRates, activityLog, tenants,
  type Lead, type InsertLead,
  type FiberCheck, type InsertFiberCheck,
  type TeamMember, type InsertTeamMember,
  type Knock, type InsertKnock,
  type User, type InsertUser,
  type Session,
  type Territory, type InsertTerritory,
  type RepApplication, type InsertRepApplication,
  type TerritoryRequest,
  type LocationPing, type InsertLocationPing,
  type ClockSession, type InsertClockSession,
  type ComingSoonAddress, type InsertComingSoon,
  type Commission, type InsertCommission,
  type CommissionRate, type InsertCommissionRate,
  type ActivityLogEntry,
  type Tenant, type InsertTenant,
} from "@shared/schema";
import { eq, desc, like, or, and, gt, isNull } from "drizzle-orm";

export interface IStorage {
  // ── Leads ──────────────────────────────────────────────────────────────────
  getLeads(tenantId?: number, assignedRepId?: number): Lead[];
  getLeadById(id: number): Lead | undefined;
  createLead(lead: InsertLead): Lead;
  upsertLeadByAddress(lead: InsertLead): { lead: Lead; created: boolean };
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
  createKnock(knock: InsertKnock): Knock;
  // ── Leaderboard ────────────────────────────────────────────────────────────
  getLeaderboard(): { rep: TeamMember; knocks: number; contacts: number; callbacks: number; sales: number }[];
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
  // ── OTP ────────────────────────────────────────────────────────────────────
  createOtp(email: string): string;
  verifyOtp(email: string, code: string): boolean;
  // ── Territories ────────────────────────────────────────────────────────────
  getTerritories(tenantId?: number): Territory[];
  getTerritoriesByRep(repId: number): Territory[];
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
  // ── Commissions ────────────────────────────────────────────────────────────
  getCommissions(repId?: number): Commission[];
  getCommissionById(id: number): Commission | undefined;
  createCommission(c: InsertCommission): Commission;
  updateCommission(id: number, updates: Partial<Commission>): Commission | undefined;
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
    `ALTER TABLE knock_log ADD COLUMN tenant_id INTEGER`,
    `ALTER TABLE clock_sessions ADD COLUMN tenant_id INTEGER`,
    // Org hierarchy: which team_lead/manager a member reports to (null = top-level)
    `ALTER TABLE team_members ADD COLUMN reports_to_id INTEGER`,
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
  upsertLeadByAddress(lead: InsertLead): { lead: Lead; created: boolean } {
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
  createKnock(knock: InsertKnock): Knock {
    return db.insert(knockLog).values({ ...knock, knockedAt: new Date().toISOString() }).returning().get();
  }

  // ── Leaderboard ────────────────────────────────────────────────────────────
  getLeaderboard() {
    const reps = this.getTeamMembers().filter(r => r.active);
    return reps.map(rep => {
      const repKnocks = this.getKnocksByRep(rep.id);
      return {
        rep,
        knocks: repKnocks.length,
        contacts: repKnocks.filter(k => k.wasHome).length,
        callbacks: repKnocks.filter(k => k.outcome === "callback").length,
        sales: repKnocks.filter(k => k.outcome === "sold").length,
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
    return db.select().from(territories).where(eq(territories.repId, repId)).all();
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
