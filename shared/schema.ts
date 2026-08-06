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
  // ── Chargeback reserve — ORG DEFAULTS (each rep may override, see teamMembers) ─
  // Whole-percent weekly holdback; 0 = disabled, so no tenant's payroll changes
  // until an operator opts in.
  commissionReservePercent: integer("commission_reserve_percent").notNull().default(0),
  // Ceiling the running reserve balance stops accruing at. NULL = fall back to
  // the product default ($2,500 — shared/commissionReserve.DEFAULT_RESERVE_CAP_CENTS);
  // 0 = deliberately UNCAPPED (the pre-cap behaviour).
  commissionReserveCapCents: integer("commission_reserve_cap_cents"),
  createdAt: text("created_at").notNull().default(new Date().toISOString()),
  updatedAt: text("updated_at").notNull().default(new Date().toISOString()),
});
export const insertTenantSchema = createInsertSchema(tenants).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertTenant = z.infer<typeof insertTenantSchema>;
export type Tenant = typeof tenants.$inferSelect;

// ── Billing: per-tenant lead-credit "banking" state (see shared/billing.ts) ───
// One row per tenant. Provider-agnostic — the payment provider is an adapter.
// DARK by default: no row = tenant is never metered or gated (live portal safe).
export const tenantBilling = sqliteTable("tenant_billing", {
  tenantId: integer("tenant_id").primaryKey(),
  planKey: text("plan_key").notNull().default("starter"),       // starter|growth|professional|enterprise
  state: text("state").notNull().default("trial"),              // trial|active|past_due|suspended|canceled
  cycleStart: text("cycle_start"),
  cycleEnd: text("cycle_end"),
  creditsIncluded: integer("credits_included").notNull().default(0),
  creditsUsed: integer("credits_used").notNull().default(0),
  creditsRollover: integer("credits_rollover").notNull().default(0),
  creditsPurchased: integer("credits_purchased").notNull().default(0),
  overageUsed: integer("overage_used").notNull().default(0),
  overageMode: text("overage_mode").notNull().default("stop"),  // stop|allow_overage|auto_purchase|require_approval
  unlimited: integer("unlimited", { mode: "boolean" }).notNull().default(false),
  seatsPaid: integer("seats_paid").notNull().default(0),
  trialEndsAt: text("trial_ends_at"),
  graceEndsAt: text("grace_ends_at"),
  provider: text("provider"),                                   // stripe|manual|null
  providerCustomerId: text("provider_customer_id"),
  providerSubscriptionId: text("provider_subscription_id"),
  createdAt: text("created_at").notNull().default(new Date().toISOString()),
  updatedAt: text("updated_at").notNull().default(new Date().toISOString()),
});

// Append-only credit ledger — one row per grant/consume/reset. dedupeKey makes a
// lead-delivery consume idempotent (a retried write can't double-charge a lead).
export const leadCreditLedger = sqliteTable("lead_credit_ledger", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tenantId: integer("tenant_id").notNull(),
  delta: integer("delta").notNull(),                            // -1 consume, +N grant/purchase/reset
  reason: text("reason").notNull(),                             // lead_delivered|grant|purchase|cycle_reset|adjustment
  leadId: integer("lead_id"),
  overage: integer("overage", { mode: "boolean" }).notNull().default(false),
  balanceAfter: integer("balance_after"),
  dedupeKey: text("dedupe_key"),
  actor: text("actor"),
  at: text("at").notNull().default(new Date().toISOString()),
});


// ── Users (admin + reps with secure login) ───────────────────────────────────
export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash"),
  tenantId: integer("tenant_id"),              // null = HomeFront Fiber internal (super-admin)
  role: text("role").notNull().default("rep"), // "super_admin" | "admin" | "rep" | "team_lead" | "manager"
  // P0-1 (K3 swarm): immutable platform-apex identity, stamped at boot from
  // SUPER_ADMIN_EMAILS. The email string stays a login handle, never the gate.
  isSuperAdmin: integer("is_super_admin").notNull().default(0),
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
  // Which sweep this area is on. Declared here (not just as a raw ALTER) so it
  // is actually SELECTed and reaches the client — without it the map had no way
  // to label "Start pass 3".
  currentPass: integer("current_pass").notNull().default(1),
  hierarchyParentId: integer("hierarchy_parent_id"),
  updatedAt: text("updated_at"),
  completedAt: text("completed_at"),
  reclaimedAt: text("reclaimed_at"),
  // When this area was last handed to its current rep. Leads carried an
  // assignedAt but the AREA never did, so "who has this and since when" could
  // not be answered without digging through territory_events.
  assignedAt: text("assigned_at"),
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
  // Permanent, compliance-grade block: the occupant asked us never to return.
  // Survives every pass reset by design — there is no option that clears it.
  doNotKnock: integer("do_not_knock", { mode: "boolean" }).notNull().default(false),
  leadStatus: text("lead_status").notNull().default("prospect"),
  // "prospect"|"contacted"|"interested"|"sold"|"not_interested"|"follow_up"
  // ── Outcome recency (P1-1) — stamped by the knock CAS so a stale offline
  // knock (older knockedAt) can never overwrite a newer outcome's status or
  // undo its sale. The CAS compares these, never the client.
  lastOutcome: text("last_outcome"),
  lastOutcomeAt: text("last_outcome_at"),
  notes: text("notes"),
  deploymentNotes: text("deployment_notes"),
  // ── Lead Scoring ──────────────────────────────────────────────────────────
  leadTag: text("lead_tag"),   // "hot_lead" | "coming_soon" | "upgrade_target" | null
  leadScore: integer("lead_score").default(0), // 0–100 priority score
  // Manager/team-lead pre-assignment triage mark — "priority" | "hold" | null
  // (see shared/leadMark.ts). Independent of lead_status and assignment.
  assignMark: text("assign_mark"),
  // Confirmed-fresh provenance. These fields are only stamped by the
  // independent-evidence projector, never directly by a primary scan.
  sourceScanTargetId: integer("source_scan_target_id"),
  // Canonical dedup identity — a partial UNIQUE index on (tenant_id, canonical_key)
  // makes "one address = one lead = one pin" a DB invariant.
  canonicalKey: text("canonical_key"),
  freshConfirmedAt: text("fresh_confirmed_at"),
  freshConfidence: text("fresh_confidence"),
  freshSources: text("fresh_sources"),
  // ── Lead Enrichment ───────────────────────────────────────────────────────
  ownerName: text("owner_name"),
  // Owner name as a skip trace found it. Deliberately NOT owner_name, which the
  // GIS/parcel enrichment owns — a phone vendor must not silently rewrite
  // property data, and keeping them apart lets either be trusted on its own.
  tracedOwnerName: text("traced_owner_name"),
  tracedAt: text("traced_at"),
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
  // Persisted rep hue, assigned ONCE at creation (first REP_PALETTE colour not
  // worn by another active member of the tenant — see storage.createTeamMember).
  // NULL = legacy row or palette exhausted; both resolve through
  // repColorOf()'s repId-hash fallback, so nothing ever renders colourless.
  color: text("color"),
  // ── Per-rep chargeback-reserve overrides (set at onboarding / in the comp
  // editor). BOTH nullable — NULL means "inherit the org default", which is what
  // every existing row is, so nobody's pay changes until an admin sets one.
  reservePercent: integer("reserve_percent"),      // whole percent 0..100
  reserveCapCents: integer("reserve_cap_cents"),   // ceiling in integer cents; 0 = uncapped

  // Hourly pay (Sequifi-style hybrid hourly+commission). NULL rate = a
  // commission-only rep. Integer cents/hour — money is integer cents everywhere.
  // effectiveFrom gates which weeks a rate governs: a week's rate is the one
  // effective at the week's START (a mid-week change never re-prices the
  // running week). Full rate history is reconstructed from the
  // 'pay.hourly_rate.changed' audit events (see server/hourlyPay.ts).
  hourlyRateCents: integer("hourly_rate_cents"),
  hourlyRateEffectiveFrom: text("hourly_rate_effective_from"),

  // ── IMMUTABLE recruiting sponsor edge — set once at approval, from the
  // invite's inviter. Distinct from reportsToId (operational, mutable, re-homed
  // on offboard/demotion): the sponsor edge is recruiting metrics only, pay
  // follows reportsTo. A DB trigger refuses any re-point (see storage.ts).
  recruitedByMemberId: integer("recruited_by_member_id"),
  recruitedByUserId: integer("recruited_by_user_id"),
  recruitedAt: text("recruited_at"),
  // Per-seller override rates — what the team-lead / manager slots keep from
  // each of THIS member's qualified sales, chosen at invite time. NULL =
  // inherit the org default (tenants commission_override_* columns).
  overrideTeamLeadCents: integer("override_team_lead_cents"),
  overrideManagerCents: integer("override_manager_cents"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull().default(new Date().toISOString()),
});
// The recruited_by_* columns are omitted so POST /api/team mass-assignment can
// never forge a sponsor — the edge is only ever written by the approval route.
// The override_* rates are omitted for the same reason: money config enters
// through the invite/approval flow (validated), never a raw roster write.
export const insertTeamMemberSchema = createInsertSchema(teamMembers).omit({
  id: true, createdAt: true, recruitedByMemberId: true, recruitedByUserId: true, recruitedAt: true,
  overrideTeamLeadCents: true, overrideManagerCents: true,
});
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
  // Which sweep of the area this knock belongs to. Stamped server-side from the
  // lead's territory at insert (never client-supplied), so pass 1's history stays
  // distinguishable from pass 2's after the area is reset. Null = legacy pre-pass
  // row, backfilled to 1 by the migration.
  passNumber: integer("pass_number"),
  // Set when the outcome CAS LOST (a newer outcome already stood): the knock is
  // recorded as field history but applied NO status flip and NO money effects.
  // Persisted so retries, history, and counters can all tell the truth.
  superseded: integer("superseded").notNull().default(0),
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
  inviteId: integer("invite_id"),              // onboarding_recruiting_invites.id when entered through a secure invite
  applicationSource: text("application_source").notNull().default("public_join"),
  desiredRole: text("desired_role"),
  fullName: text("full_name").notNull(),
  email: text("email").notNull(),
  phone: text("phone").notNull(),
  city: text("city").notNull(),
  zip: text("zip").notNull(),
  state: text("state").notNull().default("NC"),
  hasSalesExperience: integer("has_sales_experience", { mode: "boolean" }).notNull().default(false),
  salesExperienceDetails: text("sales_experience_details"),
  // Nullable on purpose: null = the form never asked (careers site, legacy
  // rows), which must stay distinguishable from an explicit "No".
  hasReliableTransportation: integer("has_reliable_transportation", { mode: "boolean" }),
  preferredCarriers: text("preferred_carriers").notNull(),
  referralSource: text("referral_source"),
  headshotPath: text("headshot_path"),
  licensePath: text("license_path"),
  status: text("status").notNull().default("pending"), // "pending"|"approved"|"rejected"
  reviewedBy: integer("reviewed_by"),
  reviewNotes: text("review_notes"),
  userId: integer("user_id"),
  loginEmailId: text("login_email_id"),
  loginSentAt: text("login_sent_at"),
  agreementsIssuedAt: text("agreements_issued_at"),
  activatedAt: text("activated_at"),
  createdAt: text("created_at").notNull().default(new Date().toISOString()),
  updatedAt: text("updated_at").notNull().default(new Date().toISOString()),
});
export type RepApplication = typeof repApplications.$inferSelect;

// ── HR / compliance checkpoints ───────────────────────────────────────────────
// One row per (application, kind). The post-approval compliance gates a rep
// clears in parallel with the document-signing pipeline: background check, drug
// screen, badge photo, and Gusto payroll confirmation. Status transitions are
// validated against shared/onboardingHr.ts. Uniqueness is (application_id, kind)
// so an upsert never creates duplicates for the same gate.
export const repHrCheckpoints = sqliteTable("rep_hr_checkpoints", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tenantId: integer("tenant_id"),
  applicationId: integer("application_id").notNull(),
  repId: integer("rep_id"),                       // teamMembers.id once the account exists
  kind: text("kind").notNull(),                   // HrCheckpointKind
  status: text("status").notNull().default("not_started"), // HrCheckpointStatus
  provider: text("provider"),                     // e.g. "checkr", "quest", "gusto"
  externalRef: text("external_ref"),              // vendor case id / Gusto employee id
  badgePhotoPath: text("badge_photo_path"),       // relative path under uploads/ for badge_photo
  notes: text("notes"),
  updatedBy: integer("updated_by"),               // users.id of the reviewer
  orderedAt: text("ordered_at"),
  completedAt: text("completed_at"),
  createdAt: text("created_at").notNull().default(new Date().toISOString()),
  updatedAt: text("updated_at").notNull().default(new Date().toISOString()),
});

// ── Territory Requests ────────────────────────────────────────────────────────
export const territoryRequests = sqliteTable("territory_requests", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // Tenant of the requesting rep. Was absent entirely, which made every
  // territory-request read and write cross-tenant (see storage.getTerritoryRequests).
  tenantId: integer("tenant_id"),
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

// ── Punch corrections (append-only time audit) ────────────────────────────────
// A manager's correction to a rep's recorded time. clock_sessions raw rows are
// NEVER edited — every fix lands here as an append-only audit row the hours
// aggregation folds into the weekly sum. minutes_delta is signed (+ missed
// punch, − over-counted time) and attributed to a UTC day (the session's
// clock-in day when sessionId is set, else the row's created_at day).
export const punchCorrections = sqliteTable("punch_corrections", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tenantId: integer("tenant_id").notNull(),
  repId: integer("rep_id").notNull(),
  sessionId: integer("session_id"),            // nullable — correction need not name a session
  kind: text("kind").notNull(),                // 'missed_in' | 'missed_out' | 'adjust'
  minutesDelta: integer("minutes_delta").notNull(),
  reason: text("reason").notNull(),
  actorUserId: integer("actor_user_id"),
  createdAt: text("created_at").notNull().default(new Date().toISOString()),
});

// ── Pay disputes (rep-facing) ─────────────────────────────────────────────────
// A rep disputes ONE line of one week's pay (the hourly block, the commission
// line, or a specific legacy commission row). Managers resolve from a tenant
// queue; an 'adjusted' resolution references an existing commission_adjustments
// row (money math is never duplicated here).
export const payDisputes = sqliteTable("pay_disputes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tenantId: integer("tenant_id").notNull(),
  repId: integer("rep_id").notNull(),
  weekStart: text("week_start").notNull(),     // canonical week_start_utc
  lineKind: text("line_kind").notNull(),       // 'hourly' | 'commission'
  commissionId: integer("commission_id"),      // set when disputing one commission row
  commissionPrevStatus: text("commission_prev_status"), // status before the dispute; restored on 'upheld'
  message: text("message").notNull(),
  status: text("status").notNull().default("open"), // 'open' | 'resolved'
  resolution: text("resolution"),              // 'upheld' | 'adjusted'
  resolutionNote: text("resolution_note"),
  adjustmentId: integer("adjustment_id"),
  resolvedBy: integer("resolved_by"),
  idemKey: text("idem_key"),                   // idempotency key (unique per tenant)
  createdAt: text("created_at").notNull().default(new Date().toISOString()),
  resolvedAt: text("resolved_at"),
});
export type ClockSession = typeof clockSessions.$inferSelect;

// ── Scan targets — persistent address pool ───────────────────────────────────
// Every address ever harvested is stored here ONCE (geocoded once), then
// re-scanned over time. Re-scans read from this pool instead of re-harvesting,
// so geocoding is a one-time cost, and comparing lastIsNewFiber against a fresh
// scan detects CHANGES (a home that just got fiber) → new hot lead.
export const scanTargets = sqliteTable("scan_targets", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  address: text("address").notNull().unique(),
  // Discovery's collision-safe identity. The legacy address-only UNIQUE
  // constraint remains for backward compatibility until the pool-v2 migration;
  // durable discovery surfaces any cross-city handoff collision instead of
  // attaching it to the wrong target.
  canonicalKey: text("canonical_key"),
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
  revision: integer("revision").notNull().default(1),
  saleDate: text("sale_date").notNull(),
  paidDate: text("paid_date"),
  notes: text("notes"),
  approvedBy: integer("approved_by"),           // users.id
  // ── Structure lock (audit): which plan scored this sale, frozen forever ──
  structureId: integer("structure_id"),         // commissionRates.id used
  structureVersion: integer("structure_version"), // its version at sale time
  calcType: text("calc_type"),                  // "flat" | "percentage" | "tiered"
  saleAmount: real("sale_amount"),              // deal value the % / tier read
  // ── Install-gated commission hold (tenant_pay_policy) ──
  // When the tenant requires install confirmation, a sold-knock commission
  // stays 'pending' with both columns NULL (install-hold) until a manager
  // confirms the install; payable_after = install_confirmed_at + hold_days.
  // The installHold flag is COMPUTED at read time (see shared/commissionHold.ts)
  // — never a persisted lifecycle status.
  installConfirmedAt: text("install_confirmed_at"),
  payableAfter: text("payable_after"),
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
  // P0-3: a structure belongs to ONE org. Nullable for legacy rows — the
  // bootstrapDefaultTenant adoption sweep files them under the default tenant.
  tenantId: integer("tenant_id"),
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

// ── Chargeback reserve ledger — APPEND-ONLY, the ONE source of a rep's balance ─
// Balance = SUM(amount_cents) computed in SQL, never folded in JS. Rows are
// NEVER updated or deleted (DB triggers ABORT both — see server/storage.ts);
// a correction is a NEW entry. Signs are enforced by trigger too:
//   hold      → weekly accrual, POSITIVE, at most one per (tenant, rep, week)
//   drawdown  → an admin applying a chargeback against the reserve, NEGATIVE
//   release   → an admin returning balance to the rep, NEGATIVE
// Both drawdown and release are MANUAL admin actions by product decision: the
// reserve never auto-draws on a chargeback and never auto-releases on a timer.
export const reserveEntries = sqliteTable("reserve_entries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tenantId: integer("tenant_id").notNull(),
  repId: integer("rep_id").notNull(),                    // teamMembers.id
  kind: text("kind").notNull(),                          // hold | drawdown | release
  amountCents: integer("amount_cents").notNull(),        // signed; never 0
  statementId: integer("statement_id"),                  // holds: the statement held from
  weekStartUtc: text("week_start_utc"),                  // holds: the week key (idempotency)
  weekLabel: text("week_label"),                         // holds: human week label
  reason: text("reason").notNull(),                      // required on every entry
  actorUserId: integer("actor_user_id"),
  createdAt: text("created_at").notNull().default(new Date().toISOString()),
});
export type ReserveEntry = typeof reserveEntries.$inferSelect;

// ── PAY-A2: contractor pay plane (banking, W-9, company DFI profile) ─────────
// APPEND-ONLY tables. Secrets (routing/account/TIN/EIN/DFI numbers) are stored
// AES-256-GCM ciphertext via server/payCrypto.ts — the *_enc columns. last4 is
// the only plaintext secret-derived value (display masking).

// One ACTIVE bank account per rep (rep_id is the PK). Self-service onboarding;
// reps can replace their own row (upsert), which re-encrypts the new numbers.
export const repBankDetails = sqliteTable("rep_bank_details", {
  repId: integer("rep_id").primaryKey(),                 // team_members.id
  tenantId: integer("tenant_id").notNull(),
  routingEnc: text("routing_enc").notNull(),             // AES-256-GCM ciphertext
  accountEnc: text("account_enc").notNull(),             // AES-256-GCM ciphertext
  accountType: text("account_type").notNull(),           // 'checking' | 'savings'
  last4: text("last4").notNull(),                        // display mask only
  status: text("status").notNull().default("active"),    // 'active' | 'disabled'
  createdAt: text("created_at").notNull().default(new Date().toISOString()),
  updatedAt: text("updated_at").notNull().default(new Date().toISOString()),
});

// ESIGN-compliant electronic W-9. TIN encrypted; signature evidence (typed
// name, date, IP, user agent, consent flag) retained with the generated PDF.
export const w9Forms = sqliteTable("w9_forms", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tenantId: integer("tenant_id").notNull(),
  repId: integer("rep_id").notNull(),                    // team_members.id
  legalName: text("legal_name").notNull(),
  businessName: text("business_name"),
  addressLine1: text("address_line1").notNull(),
  city: text("city").notNull(),
  state: text("state").notNull(),
  zip: text("zip").notNull(),
  tinEnc: text("tin_enc").notNull(),                     // AES-256-GCM ciphertext
  tinType: text("tin_type").notNull(),                   // 'ssn' | 'ein'
  // Line 3a — the signer's ACTUAL federal tax classification. Never assumed:
  // 'individual'|'c_corp'|'s_corp'|'partnership'|'trust_estate'|'llc'|'other'.
  taxClassification: text("tax_classification").notNull().default("individual"),
  llcTaxClass: text("llc_tax_class"),                    // 'C'|'S'|'P' when llc
  otherClassification: text("other_classification"),     // free text when 'other'
  foreignPartners: integer("foreign_partners").notNull().default(0), // Line 3b
  exemptPayeeCode: text("exempt_payee_code"),            // Line 4
  fatcaExemptionCode: text("fatca_exemption_code"),      // Line 4
  accountNumbers: text("account_numbers"),               // Line 7
  // Part II item 2 — 1 ⇒ the IRS notified the signer they ARE subject to backup
  // withholding, item 2 is struck on the issued PDF, and the pay lane must flag
  // the rep for 24% withholding.
  subjectToBackupWithholding: integer("subject_to_backup_withholding").notNull().default(0),
  signatureName: text("signature_name").notNull(),
  signatureDate: text("signature_date").notNull(),
  signatureIp: text("signature_ip"),
  signatureUa: text("signature_ua"),
  consent: integer("consent").notNull().default(0),      // 1 = ESIGN consent given
  // JSON {legalName,businessName,signatureName} of what was PRINTED when a
  // non-Latin name had to be transliterated (NULL when printed verbatim).
  renderedNames: text("rendered_names"),
  pdfPath: text("pdf_path"),                             // legacy; no longer written
  createdAt: text("created_at").notNull().default(new Date().toISOString()),
});
export type W9Form = typeof w9Forms.$inferSelect;

// Originating company profile for NACHA files (per tenant). The DFI account +
// EIN are encrypted; the DFI routing (bank's own transit number) and company id
// are operational identifiers left readable for file generation/ops.
export const companyProfile = sqliteTable("company_profile", {
  tenantId: integer("tenant_id").primaryKey(),
  legalName: text("legal_name").notNull(),
  einEnc: text("ein_enc").notNull(),                     // AES-256-GCM ciphertext
  dfiAccountEnc: text("dfi_account_enc").notNull(),      // AES-256-GCM ciphertext
  dfiRouting: text("dfi_routing").notNull(),             // ODFI transit (BofA)
  companyId: text("company_id").notNull(),               // NACHA company id (10)
  updatedAt: text("updated_at").notNull().default(new Date().toISOString()),
});

// ── Tenant pay policy — install-gated commission hold ────────────────────────
// Per-tenant knobs for the install hold. An absent row behaves as the defaults
// (require install confirm, 90-day hold), matching the SQL column defaults.
export const tenantPayPolicy = sqliteTable("tenant_pay_policy", {
  tenantId: integer("tenant_id").primaryKey(),
  requireInstallConfirm: integer("require_install_confirm").notNull().default(1),
  holdDays: integer("hold_days").notNull().default(90),
  updatedAt: text("updated_at").notNull().default(new Date().toISOString()),
});
