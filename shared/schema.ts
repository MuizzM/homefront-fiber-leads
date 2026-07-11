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
  // ── Weekly commission workweek configuration (see shared/workweek.ts) ────────
  // Historical statements snapshot these values, so changing them here never
  // rewrites a past week (each statement keeps its own timezone + basis).
  commissionTimezone: text("commission_timezone").notNull().default("America/New_York"),
  commissionWeekStartsOn: integer("commission_week_starts_on").notNull().default(1), // 0=Sun..1=Mon
  commissionWeekStartLocalTime: text("commission_week_start_local_time").notNull().default("00:00"),
  commissionQualificationBasis: text("commission_qualification_basis").notNull().default("QUALIFIED_AT"),
  commissionFinalizationDelayHours: integer("commission_finalization_delay_hours").notNull().default(0),
  commissionCorrectionWindowDays: integer("commission_correction_window_days").notNull().default(30),
  commissionAutoFinalizeEnabled: integer("commission_auto_finalize_enabled", { mode: "boolean" }).notNull().default(false),
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
  repId: integer("rep_id").notNull(),           // primary assignee (back-compat)
  polygon: text("polygon").notNull(),
  color: text("color").notNull().default("#3b82f6"),
  status: text("status").notNull().default("active"), // draft|active|shared|completed|reclaimed|archived|unassigned
  assigneeIds: text("assignee_ids"),            // JSON int[] — multi-rep
  pastAssigneeIds: text("past_assignee_ids"),   // JSON int[] — reassignment history
  completionNotes: text("completion_notes"),
  hierarchyParentId: integer("hierarchy_parent_id"),
  updatedAt: text("updated_at"),
  completedAt: text("completed_at"),
  reclaimedAt: text("reclaimed_at"),
  archivedAt: text("archived_at"),
  // Scan-intelligence: "why this area" briefing captured at deploy time, the
  // field-outcome retrospective, and the scan run this territory came from.
  briefing: text("briefing"),               // JSON — deploy briefing
  outcomeSnapshot: text("outcome_snapshot"), // JSON — completion retrospective
  sourceRunId: text("source_run_id"),        // scan_runs.id this deploy came from
  createdAt: text("created_at").notNull().default(new Date().toISOString()),
});
export const insertTerritorySchema = createInsertSchema(territories).omit({ id: true, createdAt: true });
export type InsertTerritory = z.infer<typeof insertTerritorySchema>;
export type Territory = typeof territories.$inferSelect;

// ── Territory events (immutable history) ──────────────────────────────────────
export const territoryEvents = sqliteTable("territory_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  territoryId: integer("territory_id").notNull(),
  actorUserId: integer("actor_user_id"),
  type: text("type").notNull(),                  // created|assigned|shared|reclaimed|completed|archived|reassigned|lead_returned|renamed
  payload: text("payload"),                      // JSON
  at: text("at").notNull().default(new Date().toISOString()),
});
export type TerritoryEvent = typeof territoryEvents.$inferSelect;

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
  assignmentSource: text("assignment_source"),   // manual|lasso|territory-sync|direct|auto
  assignedTerritoryId: integer("assigned_territory_id"),
  assignedBy: text("assigned_by"),               // display name of the manager who assigned it
  assignedAt: text("assigned_at"),
  unassignedAt: text("unassigned_at"),
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
  tenantId: integer("tenant_id"),              // owning tenant — scopes reads
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
  tenantId: integer("tenant_id"),               // inherited from the lead at insert
  knockedAt: text("knocked_at").notNull().default(new Date().toISOString()),
  wasHome: integer("was_home", { mode: "boolean" }).notNull(),
  outcome: text("outcome").notNull(),
  // "not_home"|"not_interested"|"interested"|"callback"|"sold"
  callbackDate: text("callback_date"),
  callbackTime: text("callback_time"),
  notes: text("notes"),
  // Idempotency key from the offline knock queue; null for legacy rows. A retried
  // flush with the same clientId returns the existing row instead of double-logging.
  clientId: text("client_id"),
  // ── Location verification (see shared/geoVerify.ts) ──────────────────────────
  // OBSERVATIONS the device reports (client-supplied evidence — may be spoofed,
  // which is exactly what the verdict defends against):
  repLat: real("rep_lat"),
  repLng: real("rep_lng"),
  gpsAccuracy: real("gps_accuracy"),
  deviceTs: text("device_ts"),
  mockLocation: integer("mock_location", { mode: "boolean" }),
  netState: text("net_state"),
  appVersion: text("app_version"),
  deviceId: text("device_id"),
  // VERDICT — computed SERVER-SIDE only; never accepted from the client (omitted
  // from insertKnockSchema below) and only changed via an audited admin override.
  serverTs: text("server_ts"),
  distanceM: real("distance_m"),
  verificationStatus: text("verification_status"),
  reviewReason: text("review_reason"),
});
// The client may report its own GPS observations, but NEVER the verdict — those
// four fields are stamped by the server from classifyKnockLocation().
export const insertKnockSchema = createInsertSchema(knockLog).omit({
  id: true, serverTs: true, distanceM: true, verificationStatus: true, reviewReason: true,
});
export type InsertKnock = z.infer<typeof insertKnockSchema>;
export type Knock = typeof knockLog.$inferSelect;

// ── App settings (admin-configurable knobs: geo.max_distance_m, geo.max_accuracy_m) ─
export const appSettings = sqliteTable("app_settings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tenantId: integer("tenant_id"),
  key: text("key").notNull(),
  value: text("value"),
  updatedAt: text("updated_at").notNull().default(new Date().toISOString()),
  updatedBy: integer("updated_by"),
});
export type AppSetting = typeof appSettings.$inferSelect;

// ── Verification override audit (immutable — one row per admin verdict change) ─
export const activityOverrides = sqliteTable("activity_overrides", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  knockId: integer("knock_id").notNull(),
  actorUserId: integer("actor_user_id"),
  actorName: text("actor_name"),
  oldStatus: text("old_status"),
  newStatus: text("new_status").notNull(),
  reason: text("reason").notNull(),
  at: text("at").notNull().default(new Date().toISOString()),
});
export type ActivityOverride = typeof activityOverrides.$inferSelect;

// ── Rep Applications ──────────────────────────────────────────────────────────
export const repApplications = sqliteTable("rep_applications", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tenantId: integer("tenant_id"),              // which org this applicant is joining (null = unrouted inbound)
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
  tenantId: integer("tenant_id"),               // inherited from the rep at insert
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
  // Kinetic's own address key — enables the exact, fast nightly recheck by
  // dfAddressId (no address parsing). THIS is what catches "went live" the
  // moment it flips, so a rep can knock the day the installer leaves.
  dfAddressId: text("df_address_id"),
  householdSegmentType: text("household_segment_type"), // COMING SOON | PROSPECT | EXISTING COPPER | …
  buildStatus: text("build_status"),
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
  // First provable unavailable→live FLIP timestamp (first-to-market signal);
  // set once and never overwritten. null = never observed going live.
  firstSeenLiveAt: text("first_seen_live_at"),
  lastAvailabilityStatus: text("last_availability_status"), // classifier verdict
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
  tenantId: integer("tenant_id"),               // inherited from the rep at insert
  leadId: integer("lead_id"),                   // leads.id — which sale
  knockId: integer("knock_id"),                 // knockLog.id — which knock closed it
  amount: real("amount").notNull(),             // dollar amount (locked at sale time)
  status: text("status").notNull().default("pending"),
  // "pending" | "approved" | "paid" | "disputed"
  saleDate: text("sale_date").notNull(),
  paidDate: text("paid_date"),
  notes: text("notes"),
  approvedBy: integer("approved_by"),           // users.id
  // ── Structure lock (audit): which plan scored this sale, frozen forever ──
  structureId: integer("structure_id"),         // commissionRates.id used
  structureVersion: integer("structure_version"), // its version at sale time
  calcType: text("calc_type"),                  // "flat" | "percentage" | "tiered"
  saleAmount: real("sale_amount"),              // deal value the % / tier read
  createdAt: text("created_at").notNull().default(new Date().toISOString()),
});
export const insertCommissionSchema = createInsertSchema(commissions).omit({ id: true, createdAt: true });
export type InsertCommission = z.infer<typeof insertCommissionSchema>;
export type Commission = typeof commissions.$inferSelect;

// ── Lead Photos ───────────────────────────────────────────────────────────────
// Field evidence a rep attaches to a door (damage, competitor equipment, notes
// on paper, the house itself). Immutable like knocks; tenant inherited from the
// LEAD at insert (never client-supplied). Files live under DATA_DIR/uploads.
export const leadPhotos = sqliteTable("lead_photos", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tenantId: integer("tenant_id"),
  leadId: integer("lead_id").notNull(),
  userId: integer("user_id"),                  // uploader (users.id)
  repId: integer("rep_id"),                    // uploader's team_members.id (null = office)
  path: text("path").notNull(),                // server-relative under uploads/lead-photos
  createdAt: text("created_at").notNull().default(new Date().toISOString()),
});
export type LeadPhoto = typeof leadPhotos.$inferSelect;

// ── Activity Log ─────────────────────────────────────────────────────────────
// Immutable audit trail — every significant action is logged
export const activityLog = sqliteTable("activity_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id"),                  // who did it (null = system)
  tenantId: integer("tenant_id"),              // resolved from the actor at write time (null = system/global)
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
  ratePerSale: real("rate_per_sale").notNull(), // legacy flat $/sale (= flatAmount)
  // ── Structure engine (see shared/commission.ts) ──
  calcType: text("calc_type").notNull().default("flat"), // "flat" | "percentage" | "tiered"
  percentage: real("percentage").notNull().default(0),   // percentage plans (0–100)
  tiers: text("tiers"),                         // JSON Tier[] for tiered plans
  effectiveFrom: text("effective_from"),        // ISO date; null = always-on (legacy)
  effectiveTo: text("effective_to"),            // ISO date; null = open-ended
  version: integer("version").notNull().default(1),
  updatedBy: text("updated_by"),                // actor name of last publish (audit)
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull().default(new Date().toISOString()),
});
export const insertCommissionRateSchema = createInsertSchema(commissionRates).omit({ id: true, createdAt: true });
export type InsertCommissionRate = z.infer<typeof insertCommissionRateSchema>;
export type CommissionRate = typeof commissionRates.$inferSelect;

// ════════════════════════════════════════════════════════════════════════════
// WEEKLY COMMISSION (Phase 2) — versioned plans, effective-dated assignments,
// a commissionable-sale ledger, and immutable weekly statements. DELIBERATELY
// ISOLATED from `commissions`/`commissionRates` above and from any MLM/payout-
// tree code: this is the retroactive-weekly rep-commission system driven by
// shared/workweek.ts + shared/commissionTiers.ts. All money is integer CENTS.
// ════════════════════════════════════════════════════════════════════════════

// A commission plan's stable identity. Financial rules live in immutable
// versions — the plan itself is just name/type/status.
export const commissionPlans = sqliteTable("commission_plans", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tenantId: integer("tenant_id").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  currency: text("currency").notNull().default("USD"),  // ISO 4217
  type: text("type").notNull().default("TIERED"),        // FLAT | TIERED
  tierMode: text("tier_mode").notNull().default("RETROACTIVE_WEEKLY"), // RETROACTIVE_WEEKLY | PROGRESSIVE
  status: text("status").notNull().default("DRAFT"),     // DRAFT | ACTIVE | ARCHIVED
  createdBy: integer("created_by"),
  createdAt: text("created_at").notNull().default(new Date().toISOString()),
  updatedAt: text("updated_at").notNull().default(new Date().toISOString()),
});
export type CommissionPlan = typeof commissionPlans.$inferSelect;

// Immutable version of a plan's financial rules. A rate/tier/type/basis change
// creates a NEW version — never an in-place edit of an ACTIVE version.
export const commissionPlanVersions = sqliteTable("commission_plan_versions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tenantId: integer("tenant_id").notNull(),
  commissionPlanId: integer("commission_plan_id").notNull(),
  versionNumber: integer("version_number").notNull(),
  flatRateCents: integer("flat_rate_cents"),             // FLAT plans only
  qualificationBasis: text("qualification_basis").notNull().default("QUALIFIED_AT"),
  effectiveFrom: text("effective_from").notNull(),        // ISO date
  effectiveTo: text("effective_to"),                     // null = open-ended
  rulesSnapshot: text("rules_snapshot"),                 // JSON: {type,tierMode,flatRateCents,tiers[]}
  changeSummary: text("change_summary"),
  createdBy: integer("created_by"),
  createdAt: text("created_at").notNull().default(new Date().toISOString()),
});
export type CommissionPlanVersion = typeof commissionPlanVersions.$inferSelect;

// Retroactive-weekly tiers for a plan version (validated by shared/commissionTiers.ts).
export const commissionTiers = sqliteTable("commission_tiers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tenantId: integer("tenant_id").notNull(),
  commissionPlanVersionId: integer("commission_plan_version_id").notNull(),
  position: integer("position").notNull(),
  label: text("label").notNull(),
  minimumSales: integer("minimum_sales").notNull(),      // whole ≥ 1
  maximumSales: integer("maximum_sales"),                // null = open-ended final tier
  rateCents: integer("rate_cents").notNull(),            // > 0
  createdAt: text("created_at").notNull().default(new Date().toISOString()),
});
export type CommissionTierRow = typeof commissionTiers.$inferSelect;

// Effective-dated assignment of a plan VERSION to a rep. No overlapping active
// periods for a rep. Agreement acceptance snapshot captured on accept.
export const repCommissionAssignments = sqliteTable("rep_commission_assignments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tenantId: integer("tenant_id").notNull(),
  repId: integer("rep_id").notNull(),                    // team_members.id
  commissionPlanVersionId: integer("commission_plan_version_id").notNull(),
  effectiveFrom: text("effective_from").notNull(),        // ISO date
  effectiveTo: text("effective_to"),                     // null = open-ended
  assignedBy: integer("assigned_by"),
  acceptedAt: text("accepted_at"),
  agreementSnapshot: text("agreement_snapshot"),          // JSON, captured on acceptance
  createdAt: text("created_at").notNull().default(new Date().toISOString()),
});
export type RepCommissionAssignment = typeof repCommissionAssignments.$inferSelect;

// Commissionable-sale ledger. NEW table (not knock_log): knock_log is an
// append-only knock-event log with no sale-qualification lifecycle or
// attribution timestamps; coupling those in would be unsafe. Reversals retain
// the row (status flip), never a physical delete.
export const commissionSales = sqliteTable("commission_sales", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tenantId: integer("tenant_id").notNull(),
  repId: integer("rep_id").notNull(),                    // team_members.id
  externalId: text("external_id").notNull(),             // idempotency key (unique per tenant)
  status: text("status").notNull().default("PENDING"),   // PENDING|QUALIFIED|CANCELLED|REVERSED|DISQUALIFIED
  soldAt: text("sold_at").notNull(),
  qualifiedAt: text("qualified_at"),
  installedAt: text("installed_at"),
  activatedAt: text("activated_at"),
  reversedAt: text("reversed_at"),
  disqualificationReason: text("disqualification_reason"),
  leadId: integer("lead_id"),                            // optional link to leads
  createdAt: text("created_at").notNull().default(new Date().toISOString()),
  updatedAt: text("updated_at").notNull().default(new Date().toISOString()),
});
export type CommissionSale = typeof commissionSales.$inferSelect;

// Immutable weekly statement. Snapshots timezone/basis/plan so it never changes
// if org config changes later. finalCommissionCents = gross + adjustment.
export const commissionStatements = sqliteTable("commission_statements", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tenantId: integer("tenant_id").notNull(),
  repId: integer("rep_id").notNull(),
  weekStartUtc: text("week_start_utc").notNull(),         // inclusive
  nextWeekStartUtc: text("next_week_start_utc").notNull(), // exclusive
  timezone: text("timezone").notNull(),
  localWeekLabel: text("local_week_label").notNull(),
  qualificationBasis: text("qualification_basis").notNull(),
  commissionPlanId: integer("commission_plan_id"),
  commissionPlanVersionId: integer("commission_plan_version_id"),
  planVersionNumber: integer("plan_version_number"),
  planSnapshot: text("plan_snapshot"),                   // JSON — reproduces the calc
  qualifiedSaleCount: integer("qualified_sale_count").notNull().default(0),
  tierId: integer("tier_id"),
  tierLabel: text("tier_label"),
  rateCents: integer("rate_cents").notNull().default(0),
  grossCommissionCents: integer("gross_commission_cents").notNull().default(0),
  adjustmentCents: integer("adjustment_cents").notNull().default(0),
  finalCommissionCents: integer("final_commission_cents").notNull().default(0),
  calculationVersion: integer("calculation_version").notNull().default(1),
  status: text("status").notNull().default("OPEN"),      // OPEN|REVIEW|FINALIZED|PAID
  calculatedAt: text("calculated_at").notNull().default(new Date().toISOString()),
  finalizedAt: text("finalized_at"),
  finalizedBy: integer("finalized_by"),
  paidAt: text("paid_at"),
  paidBy: integer("paid_by"),
  createdAt: text("created_at").notNull().default(new Date().toISOString()),
  updatedAt: text("updated_at").notNull().default(new Date().toISOString()),
});
export type CommissionStatement = typeof commissionStatements.$inferSelect;

// Append-only adjustments. Only APPROVED adjustments feed adjustmentCents.
export const commissionAdjustments = sqliteTable("commission_adjustments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tenantId: integer("tenant_id").notNull(),
  statementId: integer("statement_id").notNull(),
  repId: integer("rep_id").notNull(),
  amountCents: integer("amount_cents").notNull(),        // + or − ; never 0
  type: text("type").notNull().default("MANUAL"),        // MANUAL|CLAWBACK|CORRECTION|BONUS
  reason: text("reason").notNull(),
  relatedSaleId: integer("related_sale_id"),
  status: text("status").notNull().default("PENDING"),   // PENDING|APPROVED|REJECTED
  createdBy: integer("created_by"),
  approvedBy: integer("approved_by"),
  approvedAt: text("approved_at"),
  rejectedBy: integer("rejected_by"),
  rejectedAt: text("rejected_at"),
  createdAt: text("created_at").notNull().default(new Date().toISOString()),
});
export type CommissionAdjustment = typeof commissionAdjustments.$inferSelect;
