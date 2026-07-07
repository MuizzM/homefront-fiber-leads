import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// ── Tenants (SaaS white-label clients) ───────────────────────────────────────
export const tenants = sqliteTable("tenants", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  slug: text("slug").notNull().unique(),
  companyName: text("company_name").notNull(),
  ownerName: text("owner_name").notNull(),
  ownerEmail: text("owner_email").notNull().unique(),
  ownerPhone: text("owner_phone"),
  brandName: text("brand_name").notNull(),
  brandColor: text("brand_color").default("#3EA394"),
  brandLogo: text("brand_logo"),
  tagline: text("tagline").default("Field Sales Intelligence"),
  plan: text("plan").notNull().default("trial"),
  revenueSharePct: real("revenue_share_pct").default(0.20),
  monthlyFee: real("monthly_fee").default(0),
  trialEndsAt: text("trial_ends_at"),
  billingEmail: text("billing_email"),
  stripeCustomerId: text("stripe_customer_id"),
  status: text("status").notNull().default("active"),
  mapboxToken: text("mapbox_token"),
  scannerSecret: text("scanner_secret"),
  kfsAuthBasic: text("kfs_auth_basic"),
  allowedMarkets: text("allowed_markets"),
  maxReps: integer("max_reps").default(10),
  enrichmentApiKey: text("enrichment_api_key"),
  notes: text("notes"),
  createdAt: text("created_at").notNull().default(new Date().toISOString()),
  updatedAt: text("updated_at").notNull().default(new Date().toISOString()),
});
export const insertTenantSchema = createInsertSchema(tenants).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertTenant = z.infer<typeof insertTenantSchema>;
export type Tenant = typeof tenants.$inferSelect;


// ── Users (admin + reps with secure login) ───────────────────────────────────
export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash"),
  tenantId: integer("tenant_id"),              // null = HomeFront Fiber internal (super-admin)
  role: text("role").notNull().default("rep"), // "super_admin" | "admin" | "rep" | "team_lead" | "manager"
  teamMemberId: integer("team_member_id"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull().default(new Date().toISOString()),
});
export const insertUserSchema = createInsertSchema(users).omit({ id: true, createdAt: true });
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

// ── Sessions ─────────────────────────────────────────────────────────────────
export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  userId: integer("user_id").notNull(),
  createdAt: text("created_at").notNull().default(new Date().toISOString()),
  expiresAt: text("expires_at").notNull(),
});
export type Session = typeof sessions.$inferSelect;

// ── OTP codes ────────────────────────────────────────────────────────────────
export const otpCodes = sqliteTable("otp_codes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").notNull(),
  code: text("code").notNull(),
  expiresAt: text("expires_at").notNull(),
  used: integer("used", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull().default(new Date().toISOString()),
});
export type OtpCode = typeof otpCodes.$inferSelect;

// ── Territories ───────────────────────────────────────────────────────────────
export const territories = sqliteTable("territories", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tenantId: integer("tenant_id"),
  name: text("name").notNull(),
  repId: integer("rep_id").notNull(),
  polygon: text("polygon").notNull(),
  color: text("color").notNull().default("#3b82f6"),
  createdAt: text("created_at").notNull().default(new Date().toISOString()),
});
export const insertTerritorySchema = createInsertSchema(territories).omit({ id: true, createdAt: true });
export type InsertTerritory = z.infer<typeof insertTerritorySchema>;
export type Territory = typeof territories.$inferSelect;

// ── Leads ─────────────────────────────────────────────────────────────────────
export const leads = sqliteTable("leads", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  address: text("address").notNull(),
  city: text("city").notNull(),
  state: text("state").notNull().default("NC"),
  tenantId: integer("tenant_id"),              // which tenant owns this lead
  zip: text("zip").notNull(),
  lat: real("lat"),
  lng: real("lng"),
  fiberStatus: text("fiber_status").notNull().default("unknown"),
  householdSegmentType: text("household_segment_type"),
  billingStatus: text("billing_status"),
  isNewFiber: integer("is_new_fiber", { mode: "boolean" }).default(false),
  isTenured: integer("is_tenured", { mode: "boolean" }).default(false),
  speedTier: text("speed_tier"),
  maxDownloadMbps: integer("max_download_mbps"),
  techType: text("tech_type"),
  chipSetType: text("chip_set_type"),
  placement: text("placement"),
  maxQual: text("max_qual"),
  competitorName: text("competitor_name"),
  competitorSpeedMbps: integer("competitor_speed_mbps"),
  competitorTech: text("competitor_tech"),
  inCompetitorArea: integer("in_competitor_area", { mode: "boolean" }).default(false),
  dfAddressId: text("df_address_id"),
  accessId: text("access_id"),
  exchangeId: text("exchange_id"),
  addressCatalogDate: text("address_catalog_date"),
  assignedRepId: integer("assigned_rep_id"),
  contactName: text("contact_name"),
  contactPhone: text("contact_phone"),
  contactEmail: text("contact_email"),
  leadStatus: text("lead_status").notNull().default("prospect"),
  // "prospect"|"contacted"|"interested"|"sold"|"not_interested"|"follow_up"
  notes: text("notes"),
  deploymentNotes: text("deployment_notes"),
  // ── Lead Scoring ──────────────────────────────────────────────────────────
  leadTag: text("lead_tag"),   // "hot_lead" | "coming_soon" | "upgrade_target" | null
  leadScore: integer("lead_score").default(0), // 0–100 priority score
  // ── Lead Enrichment ───────────────────────────────────────────────────────
  ownerName: text("owner_name"),
  ownerPhone: text("owner_phone"),
  ownerEmail: text("owner_email"),
  incomeRange: text("income_range"),        // e.g. "$45k–$60k"
  homeValue: text("home_value"),            // e.g. "$175,000–$200,000"
  yearsAtAddress: integer("years_at_address"),
  isHomeowner: integer("is_homeowner", { mode: "boolean" }),
  enrichedAt: text("enriched_at"),
  createdAt: text("created_at").notNull().default(new Date().toISOString()),
  updatedAt: text("updated_at").notNull().default(new Date().toISOString()),
});
export const insertLeadSchema = createInsertSchema(leads).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertLead = z.infer<typeof insertLeadSchema>;
export type Lead = typeof leads.$inferSelect;

// ── Fiber scan results ────────────────────────────────────────────────────────
export const fiberChecks = sqliteTable("fiber_checks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  address: text("address").notNull(),
  lat: real("lat"),
  lng: real("lng"),
  result: text("result").notNull(),
  fiberAvailable: integer("fiber_available", { mode: "boolean" }).default(false),
  isNewFiber: integer("is_new_fiber", { mode: "boolean" }).default(false),
  isTenured: integer("is_tenured", { mode: "boolean" }).default(false),
  householdSegmentType: text("household_segment_type"),
  billingStatus: text("billing_status"),
  techType: text("tech_type"),
  speedTier: text("speed_tier"),
  maxDownload: integer("max_download"),
  competitorName: text("competitor_name"),
  addressCatalogDate: text("address_catalog_date"),
  apiSource: text("api_source"),
  checkedAt: text("checked_at").notNull().default(new Date().toISOString()),
});
export const insertFiberCheckSchema = createInsertSchema(fiberChecks).omit({ id: true, checkedAt: true });
export type InsertFiberCheck = z.infer<typeof insertFiberCheckSchema>;
export type FiberCheck = typeof fiberChecks.$inferSelect;

// ── Team members ──────────────────────────────────────────────────────────────
export const teamMembers = sqliteTable("team_members", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  phone: text("phone"),
  tenantId: integer("tenant_id"),
  email: text("email"),
  role: text("role").notNull().default("rep"),
  // Supervisor in the org chart — another team_member (a team_lead or manager).
  // null = top-level (reports directly to Admin).
  reportsToId: integer("reports_to_id"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull().default(new Date().toISOString()),
});
export const insertTeamMemberSchema = createInsertSchema(teamMembers).omit({ id: true, createdAt: true });
export type InsertTeamMember = z.infer<typeof insertTeamMemberSchema>;
export type TeamMember = typeof teamMembers.$inferSelect;

// ── Knock log ─────────────────────────────────────────────────────────────────
export const knockLog = sqliteTable("knock_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  leadId: integer("lead_id").notNull(),
  repId: integer("rep_id").notNull(),
  knockedAt: text("knocked_at").notNull().default(new Date().toISOString()),
  wasHome: integer("was_home", { mode: "boolean" }).notNull(),
  outcome: text("outcome").notNull(),
  // "not_home"|"not_interested"|"interested"|"callback"|"sold"
  callbackDate: text("callback_date"),
  callbackTime: text("callback_time"),
  notes: text("notes"),
});
export const insertKnockSchema = createInsertSchema(knockLog).omit({ id: true });
export type InsertKnock = z.infer<typeof insertKnockSchema>;
export type Knock = typeof knockLog.$inferSelect;

// ── Rep Applications ──────────────────────────────────────────────────────────
export const repApplications = sqliteTable("rep_applications", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  fullName: text("full_name").notNull(),
  email: text("email").notNull(),
  phone: text("phone").notNull(),
  city: text("city").notNull(),
  zip: text("zip").notNull(),
  state: text("state").notNull().default("NC"),
  hasSalesExperience: integer("has_sales_experience", { mode: "boolean" }).notNull().default(false),
  salesExperienceDetails: text("sales_experience_details"),
  preferredCarriers: text("preferred_carriers").notNull(),
  referralSource: text("referral_source"),
  headshotPath: text("headshot_path"),
  licensePath: text("license_path"),
  status: text("status").notNull().default("pending"), // "pending"|"approved"|"rejected"
  reviewedBy: integer("reviewed_by"),
  reviewNotes: text("review_notes"),
  userId: integer("user_id"),
  createdAt: text("created_at").notNull().default(new Date().toISOString()),
  updatedAt: text("updated_at").notNull().default(new Date().toISOString()),
});
export const insertRepApplicationSchema = createInsertSchema(repApplications).omit({
  id: true, createdAt: true, updatedAt: true, reviewedBy: true,
  reviewNotes: true, userId: true, status: true,
});
export type InsertRepApplication = z.infer<typeof insertRepApplicationSchema>;
export type RepApplication = typeof repApplications.$inferSelect;

// ── Territory Requests ────────────────────────────────────────────────────────
export const territoryRequests = sqliteTable("territory_requests", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  repId: integer("rep_id").notNull(),
  userId: integer("user_id").notNull(),
  message: text("message"),
  status: text("status").notNull().default("pending"),
  createdAt: text("created_at").notNull().default(new Date().toISOString()),
});
export type TerritoryRequest = typeof territoryRequests.$inferSelect;

// ── GPS Location Pings ────────────────────────────────────────────────────────
// Real-time rep field tracking (pings every ~60s while clocked in)
export const locationPings = sqliteTable("location_pings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  repId: integer("rep_id").notNull(),           // teamMembers.id
  userId: integer("user_id").notNull(),           // users.id
  lat: real("lat").notNull(),
  lng: real("lng").notNull(),
  accuracy: real("accuracy"),                     // meters
  pingAt: text("ping_at").notNull().default(new Date().toISOString()),
});
export const insertLocationPingSchema = createInsertSchema(locationPings).omit({ id: true, pingAt: true });
export type InsertLocationPing = z.infer<typeof insertLocationPingSchema>;
export type LocationPing = typeof locationPings.$inferSelect;

// ── Clock Sessions ────────────────────────────────────────────────────────────
// Track rep field hours — clock in / clock out
export const clockSessions = sqliteTable("clock_sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  repId: integer("rep_id").notNull(),
  userId: integer("user_id").notNull(),
  clockedIn: text("clocked_in").notNull(),
  clockedOut: text("clocked_out"),             // null = still active
  durationMinutes: integer("duration_minutes"), // set on clock out
  notes: text("notes"),
  date: text("date").notNull(),                // "2026-07-06" for easy grouping
});
export const insertClockSessionSchema = createInsertSchema(clockSessions).omit({ id: true });
export type InsertClockSession = z.infer<typeof insertClockSessionSchema>;
export type ClockSession = typeof clockSessions.$inferSelect;

// ── Coming Soon Pipeline ──────────────────────────────────────────────────────
// Addresses where fiber isn't available yet — future lead pipeline
// Monitor these addresses for when Kinetic builds out to them
export const comingSoonAddresses = sqliteTable("coming_soon_addresses", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  address: text("address").notNull().unique(),
  city: text("city").notNull(),
  state: text("state").notNull().default("NC"),
  tenantId: integer("tenant_id"),              // which tenant owns this lead
  zip: text("zip").notNull(),
  lat: real("lat"),
  lng: real("lng"),
  // Why it's in this list
  reason: text("reason").notNull().default("no_service"),
  // "no_service" | "copper_only" | "competitor_only" | "coming_soon"
  lastChecked: text("last_checked"),
  // When fiber becomes available, this flips
  fiberAvailable: integer("fiber_available", { mode: "boolean" }).default(false),
  convertedToLeadId: integer("converted_to_lead_id"), // set when promoted to lead
  addedBy: integer("added_by"),                // users.id
  createdAt: text("created_at").notNull().default(new Date().toISOString()),
});
export const insertComingSoonSchema = createInsertSchema(comingSoonAddresses).omit({
  id: true, createdAt: true, fiberAvailable: true, convertedToLeadId: true
});
export type InsertComingSoon = z.infer<typeof insertComingSoonSchema>;
export type ComingSoonAddress = typeof comingSoonAddresses.$inferSelect;

// ── Scan targets — persistent address pool (FiberFocus model) ──────────────────
// Every address ever harvested is stored here ONCE (geocoded once), then
// re-scanned over time. Re-scans read from this pool instead of re-harvesting,
// so geocoding is a one-time cost, and comparing lastIsNewFiber against a fresh
// scan detects CHANGES (a home that just got fiber) → new hot lead.
export const scanTargets = sqliteTable("scan_targets", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  address: text("address").notNull().unique(),
  city: text("city").notNull(),
  state: text("state").notNull().default("NC"),
  zip: text("zip").notNull(),
  lat: real("lat"),
  lng: real("lng"),
  tenantId: integer("tenant_id"),
  source: text("source"),                                  // gis | overpass | mapbox | manual
  // Last-known scan result (null status = never scanned yet)
  lastFiberStatus: text("last_fiber_status"),
  lastIsNewFiber: integer("last_is_new_fiber", { mode: "boolean" }).notNull().default(false),
  lastBillingStatus: text("last_billing_status"),
  dfAddressId: text("df_address_id"),
  scanCount: integer("scan_count").notNull().default(0),
  lastScannedAt: text("last_scanned_at"),
  convertedToLeadId: integer("converted_to_lead_id"),      // set when a change promoted it to a lead
  createdAt: text("created_at").notNull().default(new Date().toISOString()),
});
export const insertScanTargetSchema = createInsertSchema(scanTargets).omit({ id: true, createdAt: true });
export type InsertScanTarget = z.infer<typeof insertScanTargetSchema>;
export type ScanTarget = typeof scanTargets.$inferSelect;

// ── Commissions ───────────────────────────────────────────────────────────────
// Track each sale's commission — admin sets rate, rep sees their earnings
export const commissions = sqliteTable("commissions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  repId: integer("rep_id").notNull(),           // teamMembers.id
  leadId: integer("lead_id"),                   // leads.id — which sale
  knockId: integer("knock_id"),                 // knockLog.id — which knock closed it
  amount: real("amount").notNull(),             // dollar amount
  status: text("status").notNull().default("pending"),
  // "pending" | "approved" | "paid" | "disputed"
  saleDate: text("sale_date").notNull(),
  paidDate: text("paid_date"),
  notes: text("notes"),
  approvedBy: integer("approved_by"),           // users.id
  createdAt: text("created_at").notNull().default(new Date().toISOString()),
});
export const insertCommissionSchema = createInsertSchema(commissions).omit({ id: true, createdAt: true });
export type InsertCommission = z.infer<typeof insertCommissionSchema>;
export type Commission = typeof commissions.$inferSelect;

// ── Activity Log ─────────────────────────────────────────────────────────────
// Immutable audit trail — every significant action is logged
export const activityLog = sqliteTable("activity_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id"),                  // who did it (null = system)
  action: text("action").notNull(),
  // e.g. "lead.created" | "lead.assigned" | "rep.clocked_in" | "territory.assigned"
  entityType: text("entity_type"),             // "lead" | "rep" | "territory" | "commission"
  entityId: integer("entity_id"),
  details: text("details"),                    // JSON stringified extra info
  ip: text("ip"),
  at: text("at").notNull().default(new Date().toISOString()),
});
export type ActivityLogEntry = typeof activityLog.$inferSelect;

// ── Commission Rate Plans ─────────────────────────────────────────────────────
// Admin can set different rates per role or per rep
export const commissionRates = sqliteTable("commission_rates", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),                // "Standard Rep", "Team Lead Bonus"
  role: text("role"),                          // null = applies to specific rep
  repId: integer("rep_id"),                    // null = applies to all of that role
  ratePerSale: real("rate_per_sale").notNull(), // $ per sale
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull().default(new Date().toISOString()),
});
export const insertCommissionRateSchema = createInsertSchema(commissionRates).omit({ id: true, createdAt: true });
export type InsertCommissionRate = z.infer<typeof insertCommissionRateSchema>;
export type CommissionRate = typeof commissionRates.$inferSelect;
