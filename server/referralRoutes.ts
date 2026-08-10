// ── Referral API — RBAC-gated, tenant-scoped ────────────────────────────────
//
// Registered from routes.ts with the shared middleware, like every other money
// surface. Three audiences:
//
//   rep    referral.read.self        their own link, pipeline, and progress
//   org    referral.read.org         the whole program (manager+)
//   admin  referral.approve          releasing a reward
//          referral.settings.manage  threshold, amount, windows
//
// ── TWO PUBLIC ENDPOINTS, AND WHY THEY ARE SHAPED THIS WAY ──────────────────
// `track-click` and `apply` are reachable without a session, because the person
// using them does not have one yet. Both are therefore:
//   * rate-limited (a referral code is a short string; an unlimited endpoint is
//     a code-guessing oracle and a pipeline-spamming vector),
//   * silent about WHY an attribution failed on the public path — a caller
//     learning "that code is real but you already have an account" is being
//     handed other people's information,
//   * incapable of failing the underlying application: a declined attribution
//     returns `attributed: false`, never an error that would block a hire.

import type { Express, Request, Response, NextFunction } from "express";
import rateLimit from "express-rate-limit";
import { ipKeyGenerator } from "express-rate-limit";
import { can } from "@shared/capabilities";
import { storage } from "./storage";
import * as store from "./referralStore";
import {
  normalizeReferralCode, referralStageIndex, applicantStatusView,
  type ReferralStatus,
} from "@shared/referral";

/** The "nobody referred you" answer, shaped exactly like a real one so the
 *  client renders one component either way. */
const applicantEmptyStatus = () => applicantStatusView(null, null, false);

type Mw = (req: Request, res: Response, next: NextFunction) => void;
interface Deps { requireAuth: Mw; requireCapability: (cap: any) => Mw; }

/**
 * The public endpoints are the only unauthenticated surface this feature adds,
 * so they get their own limiter rather than inheriting a general one. Keyed by
 * IP via the helper that handles IPv6 correctly — a per-address /64 would
 * otherwise let one client walk the code space from a fresh address each time.
 */
const publicReferralLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? ""),
  message: { error: "Too many requests. Try again shortly." },
});

function fail(res: Response, e: unknown) {
  const msg = e instanceof Error ? e.message : "Internal error";
  if (msg === "REFERRAL_NOT_FOUND") return res.status(404).json({ error: "Referral not found", code: msg });
  if (msg === "REFERRAL_NOT_QUALIFIED") {
    return res.status(409).json({ error: "This referral does not meet the requirements right now.", code: msg });
  }
  if (msg.startsWith("REFERRAL_CLAWBACK_WINDOW_OPEN")) {
    return res.status(409).json({
      error: `The clawback window is still open (${msg.split(":")[1]} days remaining).`,
      code: "REFERRAL_CLAWBACK_WINDOW_OPEN",
      daysRemaining: Number(msg.split(":")[1]) || 0,
    });
  }
  if (msg.startsWith("REFERRAL_REFERRER_LOCKED")) {
    return res.status(403).json({ error: msg.split(":").slice(1).join(":"), code: "REFERRAL_REFERRER_LOCKED" });
  }
  if (msg.startsWith("REFERRAL_BAD_TRANSITION")) return res.status(409).json({ error: "Not a legal status change", code: msg });
  if (msg.startsWith("INVALID_REFERRAL_CONFIG")) return res.status(400).json({ error: msg.slice(24), code: "INVALID_CONFIG" });
  if (msg.startsWith("REFERRAL_")) return res.status(400).json({ error: msg, code: msg });
  return res.status(500).json({ error: msg });
}

export function registerReferralRoutes(app: Express, deps: Deps) {
  const { requireCapability } = deps;
  const uid = (req: Request) => (req as any).user?.id ?? null;
  const tid = (req: Request) => (req as any).user?.tenantId as number;
  const meRep = (req: Request) => (req as any).user?.teamMemberId as number | null;
  const nowIso = () => new Date().toISOString();

  /** The origin a referral link points at. Derived from the request rather than
   *  configured, so a white-labelled tenant's link carries their own host. */
  const baseUrl = (req: Request) => {
    const proto = (req.headers["x-forwarded-proto"] as string)?.split(",")[0] || req.protocol || "https";
    const host = (req.headers["x-forwarded-host"] as string)?.split(",")[0] || req.get("host") || "";
    return `${proto}://${host}`;
  };

  // ── Public: click tracking ────────────────────────────────────────────────
  // A counter bump only. Creating a referral row per anonymous click would be a
  // fraud vector (free pipeline inflation) and would fill the funnel with rows
  // that can never be attributed to a person.
  app.post("/api/referrals/track-click", publicReferralLimiter, (req, res) => {
    const code = normalizeReferralCode(req.body?.code);
    // A malformed code never reaches the database, and the response is the same
    // either way so the endpoint cannot be used to test which codes exist.
    if (code) {
      const now = nowIso();
      store.trackClick(code, store.clickDedupeKey({
        ip: req.ip ?? null,
        userAgent: String(req.headers["user-agent"] ?? "").slice(0, 256),
        dayIso: now.slice(0, 10),
      }), now);
    }
    // Always the same body, whatever happened — a caller must not be able to
    // learn from the response whether a code is real or whether their click
    // counted.
    res.json({ ok: true });
  });

  // ── Public: attribute an application ──────────────────────────────────────
  app.post("/api/referrals/apply", publicReferralLimiter, (req, res) => {
    const code = normalizeReferralCode(req.body?.code);
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    if (!code || !email.includes("@")) return res.json({ attributed: false });

    const link = store.linkByCode(code);
    if (!link) return res.json({ attributed: false });

    try {
      const { referral, rejected } = store.attributeApplication({
        tenantId: link.tenantId, linkCode: code, applicantEmail: email,
        applicationId: Number.isInteger(req.body?.applicationId) ? req.body.applicationId : null,
        nowIso: nowIso(),
      });
      // Deliberately opaque on the public path: telling an anonymous caller
      // that an address "already has an account" discloses membership.
      res.json({ attributed: !!referral && !rejected });
    } catch {
      // An attribution failure must NEVER fail the application itself.
      res.json({ attributed: false });
    }
  });

  // ── Rep: my link ──────────────────────────────────────────────────────────
  app.get("/api/referrals/my-link", requireCapability("referral.read.self"), (req, res) => {
    try {
      const repId = meRep(req);
      if (!repId) return res.status(400).json({ error: "No team member is linked to this login", code: "NO_REP" });
      const config = store.getConfig(tid(req));
      const link = store.ensureLink({
        tenantId: tid(req), referrerUserId: uid(req), referrerRepId: repId,
        baseUrl: baseUrl(req), nowIso: nowIso(),
      });
      res.json({
        ...link,
        programEnabled: config.enabled,
        rewardCents: config.rewardCents,
        requiredApprovedSales: config.requiredApprovedSales,
      });
    } catch (e) { fail(res, e); }
  });

  app.post("/api/referrals/links", requireCapability("referral.read.self"), (req, res) => {
    try {
      const repId = meRep(req);
      if (!repId) return res.status(400).json({ error: "No team member is linked to this login", code: "NO_REP" });
      // Minting is idempotent: a rep who taps "get my link" twice keeps ONE
      // code, because a second would split their own pipeline.
      res.status(201).json(store.ensureLink({
        tenantId: tid(req), referrerUserId: uid(req), referrerRepId: repId,
        baseUrl: baseUrl(req), nowIso: nowIso(),
      }));
    } catch (e) { fail(res, e); }
  });

  // ── The referred person's own status ──────────────────────────────────────
  // Identity comes from the SESSION. There is deliberately no :id on this route
  // and no id accepted in the body: an endpoint with no identifier to tamper
  // with cannot have an insecure direct object reference, which is a stronger
  // guarantee than checking one.
  //
  // Gated on referral.read.self, which every rep holds — this is the one
  // referral surface whose audience is the person the referral is ABOUT rather
  // than the person who earns from it.
  app.get("/api/referrals/my-status", requireCapability("referral.read.self"), (req, res) => {
    try {
      const repId = meRep(req);
      // No linked team member means nothing can be attributed to this login.
      // Answered as the ordinary empty state, not an error: "you were not
      // referred" is a legitimate answer, and a 400 here would make the page
      // look broken for most of the org.
      if (!repId) return res.json(applicantEmptyStatus());
      res.json(store.applicantStatusFor(tid(req), repId, nowIso()));
    } catch (e) { fail(res, e); }
  });

  // ── Pipelines ─────────────────────────────────────────────────────────────
  app.get("/api/referrals", requireCapability("referral.read.self"), (req, res) => {
    const user = (req as any).user;
    const scope = req.query.scope === "org" && can(user?.role, "referral.read.org")
      ? { repIds: null }
      : { repIds: meRep(req) ? [meRep(req) as number] : [] };

    const referrals = store.listReferrals(tid(req), {
      referrerRepIds: scope.repIds,
      status: (req.query.status as ReferralStatus) || null,
      limit: req.query.limit != null ? Number(req.query.limit) : 200,
    });
    const nameOf = new Map(storage.getTeamMembers(tid(req)).map((m: any) => [m.id, m.name]));

    res.json(referrals.map(r => ({
      ...r,
      referrerName: nameOf.get(r.referrerRepId) ?? `Rep ${r.referrerRepId}`,
      referredName: r.referredRepId ? nameOf.get(r.referredRepId) ?? null : null,
      stageIndex: referralStageIndex(r.status),
      // The pre-hire funnel identifies people only by email; masked so a
      // manager's pipeline view is not a contact-list export.
      referredEmail: r.referredEmail ? maskEmail(r.referredEmail) : null,
    })));
  });

  app.get("/api/referrals/:id/progress", requireCapability("referral.read.self"), (req, res) => {
    const id = Number(req.params.id);
    const snapshot = store.qualificationFor(tid(req), id, nowIso());
    if (!snapshot) return res.status(404).json({ error: "Referral not found" });
    const { referral, result, config, releasable } = snapshot;

    const user = (req as any).user;
    const mine = referral.referrerRepId === meRep(req);
    if (!mine && !can(user?.role, "referral.read.org")) {
      return res.status(404).json({ error: "Referral not found" });
    }

    res.json({
      referral: { ...referral, referredEmail: referral.referredEmail ? maskEmail(referral.referredEmail) : null },
      // The checklist and the award rule come from the SAME evaluation, so the
      // progress a rep stares at cannot promise something approval refuses.
      qualification: result,
      rewardCents: config.rewardCents,
      requiredApprovedSales: config.requiredApprovedSales,
      releasable,
    });
  });

  // Alias kept because the spec names both; one handler, no second definition
  // of what "qualified" means.
  app.get("/api/referrals/:id/qualification", requireCapability("referral.read.self"), (req, res) => {
    const snapshot = store.qualificationFor(tid(req), Number(req.params.id), nowIso());
    if (!snapshot) return res.status(404).json({ error: "Referral not found" });
    const mine = snapshot.referral.referrerRepId === meRep(req);
    if (!mine && !can((req as any).user?.role, "referral.read.org")) {
      return res.status(404).json({ error: "Referral not found" });
    }
    res.json(snapshot.result);
  });

  app.get("/api/referrals/:id/history", requireCapability("referral.read.org"), (req, res) => {
    const id = Number(req.params.id);
    if (!store.getReferral(tid(req), id)) return res.status(404).json({ error: "Referral not found" });
    res.json(store.eventsFor(tid(req), id));
  });

  // ── Admin decisions ───────────────────────────────────────────────────────
  app.post("/api/referrals/:id/approve", requireCapability("referral.approve"), (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!store.getReferral(tid(req), id)) return res.status(404).json({ error: "Referral not found" });
      res.json(store.approveReward({
        tenantId: tid(req), referralId: id, actorUserId: uid(req), nowIso: nowIso(),
        // Overriding the holding period is possible but never the default, and
        // it is recorded as an explicit choice in the referral's history.
        enforceClawbackWindow: req.body?.overrideClawbackWindow !== true,
      }));
    } catch (e) { fail(res, e); }
  });

  app.post("/api/referrals/:id/reject", requireCapability("referral.approve"), (req, res) => {
    try {
      const id = Number(req.params.id);
      const reason = String(req.body?.reason ?? "").trim();
      if (!reason) return res.status(400).json({ error: "A reason is required.", code: "REASON_REQUIRED" });
      if (!store.getReferral(tid(req), id)) return res.status(404).json({ error: "Referral not found" });
      res.json(store.rejectReferral({ tenantId: tid(req), referralId: id, actorUserId: uid(req), reason, nowIso: nowIso() }));
    } catch (e) { fail(res, e); }
  });

  app.post("/api/referrals/:id/referrer", requireCapability("referral.approve"), (req, res) => {
    try {
      const id = Number(req.params.id);
      const newReferrerRepId = Number(req.body?.referrerRepId);
      const reason = String(req.body?.reason ?? "").trim();
      if (!Number.isInteger(newReferrerRepId)) return res.status(400).json({ error: "referrerRepId is required" });
      if (!reason) return res.status(400).json({ error: "A reason is required.", code: "REASON_REQUIRED" });
      res.json(store.changeReferrer({
        tenantId: tid(req), referralId: id, newReferrerRepId,
        actorIsAdmin: can((req as any).user?.role, "referral.settings.manage"),
        actorUserId: uid(req), reason, nowIso: nowIso(),
      }));
    } catch (e) { fail(res, e); }
  });

  // ── Settings ──────────────────────────────────────────────────────────────
  // The program-state health read: lets an admin (or a monitor) see at a
  // glance that the $500-for-6 program is actually running here, with the
  // migration audit timestamp. Warns explicitly when it is off.
  app.get("/api/referrals/health", requireCapability("referral.read.org"), (req, res) => {
    res.json(store.referralProgramHealth(tid(req)));
  });

  app.get("/api/referrals/settings", requireCapability("referral.read.org"), (req, res) => {
    res.json({ ...store.getConfig(tid(req)), liability: store.orgReferralLiability(tid(req)) });
  });

  app.put("/api/referrals/settings", requireCapability("referral.settings.manage"), (req, res) => {
    try {
      const b = req.body ?? {};
      const patch: any = {};
      for (const key of [
        "rewardCents", "requiredApprovedSales", "qualificationWindowDays",
        "clawbackWindowDays", "attributionWindowDays",
      ]) if (b[key] !== undefined) patch[key] = Math.trunc(Number(b[key]));
      for (const key of ["enabled", "requireTrainingComplete", "requireActiveStatus"]) {
        if (b[key] !== undefined) patch[key] = b[key] === true;
      }
      res.json(store.setConfig(tid(req), patch, nowIso()));
    } catch (e) { fail(res, e); }
  });
}

/** `j••••@example.com` — enough to recognise your own applicant, not enough to
 *  turn a pipeline view into a contact export. */
function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "•••";
  const head = local.slice(0, 1);
  return `${head}${"•".repeat(Math.max(3, local.length - 1))}@${domain}`;
}
