// ── Mileage API — RBAC-gated, tenant-scoped ─────────────────────────────────
// Registered from routes.ts with the same injected middleware as every other
// money surface, so authorization is identical to the rest of the app.
//
// Three audiences, three gates:
//   rep       mileage.submit.self       their OWN trips, start/end/submit
//   manager   mileage.approve           the review queue, approve/reject
//   admin     mileage.settings.manage   the RATE and the reimbursement switch
//
// Two rules hold on every handler:
//   * tenant comes from the session, never the body;
//   * a rep's repId comes from the session's teamMemberId, never the body —
//     so no request can log a trip against someone else's pay.
//
// Out-of-scope ids read as 404, never 403, matching the rest of the app: a
// 403 confirms the row exists, which is itself a cross-tenant disclosure.

import type { Express, Request, Response, NextFunction } from "express";
import { can } from "@shared/capabilities";
import { downlineOf } from "@shared/teamHierarchy";
import { storage } from "./storage";
import * as store from "./mileageStore";
import {
  computeTripDistance, mayStartGpsTrip, mayChangeOwnConsent, parseMiles, parseRateDollars,
  summarizeMileage, formatMiles, formatRate, reimbursementCents, isGpsPolicy,
  MILEAGE_SOURCES, type MileageSource, type MileageStatus,
} from "@shared/mileage";

type Mw = (req: Request, res: Response, next: NextFunction) => void;
interface Deps { requireAuth: Mw; requireCapability: (cap: any) => Mw; }

/** The disclosure a worker accepts before any location is sampled. Versioned so
 *  a change re-prompts rather than silently inheriting an old consent. */
export const LOCATION_DISCLOSURE_VERSION = "2026-08-06.1";

/**
 * Which reps a caller may SEE, by capability. Mirrors commissionRoutes.readScope
 * exactly — one shape of answer, `null` meaning "no rep filter (whole org)" and
 * an EMPTY ARRAY meaning "nobody", which the store honours by returning no rows.
 */
function readScope(user: any): { repIds: number[] | null } {
  if (can(user?.role, "mileage.approve") || can(user?.role, "earnings.read.org")) return { repIds: null };
  if (can(user?.role, "mileage.read.team")) {
    const members = storage.getTeamMembers(user?.tenantId ?? undefined);
    const ids = user?.teamMemberId ? [user.teamMemberId, ...downlineOf(user.teamMemberId, members as any)] : [];
    return { repIds: [...new Set(ids)] };
  }
  return { repIds: user?.teamMemberId ? [user.teamMemberId] : [] };
}

function canReadRep(user: any, repId: number): boolean {
  const { repIds } = readScope(user);
  return repIds === null || repIds.includes(repId);
}

function fail(res: Response, e: unknown) {
  const msg = e instanceof Error ? e.message : "Internal error";
  // The store's error codes carry their own meaning; map the ones a client can
  // legitimately provoke to a status it can act on.
  if (msg.startsWith("INVALID_TRIP:")) return res.status(400).json({ error: msg.slice(13), code: "INVALID_TRIP" });
  if (msg === "MILEAGE_TRIP_NOT_FOUND") return res.status(404).json({ error: "Trip not found", code: msg });
  if (msg === "MILEAGE_CONSENT_LOCKED") {
    return res.status(403).json({
      error: "An administrator has locked this location setting. Ask them to unlock it to change it.",
      code: msg,
    });
  }
  if (msg === "MILEAGE_GPS_LOCKED_OFF") {
    return res.status(403).json({
      error: "Your organization has turned GPS trips off. You can still log trips by hand.",
      code: msg,
    });
  }
  if (msg === "MILEAGE_LOCKED") {
    return res.status(409).json({
      error: "This trip is approved and cannot be edited. Record a correction instead.",
      code: msg,
    });
  }
  if (msg.startsWith("MILEAGE_BAD_TRANSITION")) return res.status(409).json({ error: "Not a legal status change", code: msg });
  if (msg.startsWith("MILEAGE_")) return res.status(400).json({ error: msg, code: msg });
  return res.status(500).json({ error: msg });
}

/** CSV formula-injection guard — same rule as the commission export: a leading
 *  = + - @ makes a cell executable in Excel/Sheets, and trip purposes and
 *  addresses are user-authored free text. */
function csvCell(v: string | number | null): string {
  const s = String(v ?? "");
  const guarded = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${guarded.replace(/"/g, '""')}"`;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const asDate = (v: unknown): string | null =>
  typeof v === "string" && ISO_DATE.test(v.trim()) ? v.trim() : null;

export function registerMileageRoutes(app: Express, deps: Deps) {
  const { requireCapability } = deps;
  const uid = (req: Request) => (req as any).user?.id ?? null;
  const tid = (req: Request) => (req as any).user?.tenantId as number;
  const meRep = (req: Request) => (req as any).user?.teamMemberId as number | null;
  const nowIso = () => new Date().toISOString();
  /** Today in the org's commission timezone — the same clock the workweek uses,
   *  so "no future trips" means the rep's today, not UTC's. */
  const todayIso = (req: Request) => {
    const tz = store.orgTimezone(tid(req));
    try {
      return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
        .format(new Date());
    } catch { return new Date().toISOString().slice(0, 10); }
  };

  // ── Consent ───────────────────────────────────────────────────────────────
  // Read before the tracker renders, so the disclosure sheet is shown when it
  // must be and never shown again once accepted.
  app.get("/api/mileage/consent", requireCapability("mileage.submit.self"), (req, res) => {
    const c = store.getConsent(tid(req), uid(req));
    const policy = store.getGpsPolicy(tid(req));
    res.json({
      ...c,
      currentVersion: LOCATION_DISCLOSURE_VERSION,
      gpsPolicy: policy,
      mayStartGpsTrip: mayStartGpsTrip(c, policy),
      // The UI needs to know WHETHER the toggle is the worker's to move, so it
      // can show a locked state instead of a control that 403s on tap.
      mayChangeOwnConsent: mayChangeOwnConsent(c, policy),
    });
  });

  app.post("/api/mileage/consent", requireCapability("mileage.submit.self"), (req, res) => {
    try {
      const accepted = req.body?.accepted === true;
      // Background sampling is a SECOND, explicit opt-in and defaults off. It only
      // ever applies while a trip the worker started is open; there is no state in
      // which this app samples location without one.
      const backgroundOptIn = req.body?.backgroundOptIn === true;
      store.setConsent({
        tenantId: tid(req), userId: uid(req), accepted, backgroundOptIn,
        version: LOCATION_DISCLOSURE_VERSION, nowIso: nowIso(),
      });
      res.json(store.getConsent(tid(req), uid(req)));
    } catch (e) { fail(res, e); }
  });

  // ── Admin: lock and unlock ────────────────────────────────────────────────
  // Two levers, and deliberately no third that forces tracking ON. An admin can
  // withdraw GPS from the whole org, or pin one person's setting where it
  // already stands — but consent an administrator can grant on someone else's
  // behalf is not consent, and would make the disclosure every rep is shown
  // false.
  app.put("/api/mileage/settings/gps-policy", requireCapability("mileage.settings.manage"), (req, res) => {
    try {
      const policy = req.body?.policy;
      if (!isGpsPolicy(policy)) {
        return res.status(400).json({ error: "policy must be REP_CHOICE or LOCKED_OFF", code: "INVALID_GPS_POLICY" });
      }
      store.setGpsPolicy(tid(req), policy, nowIso());
      storage.logActivity(uid(req), "mileage.gps_policy.changed", "tenant", tid(req), { policy });
      res.json({ gpsPolicy: store.getGpsPolicy(tid(req)) });
    } catch (e) { fail(res, e); }
  });

  app.put("/api/mileage/reps/:repId/consent-lock", requireCapability("mileage.settings.manage"), (req, res) => {
    try {
      const repId = Number(req.params.repId);
      if (!canReadRep((req as any).user, repId)) return res.status(404).json({ error: "Not found" });
      // The consent row is keyed by LOGIN, because that is who accepts a
      // disclosure; the roster is keyed by team member. Resolve one to the other
      // rather than letting a caller pass a user id directly, which would be a
      // cross-tenant lookup primitive.
      const linked = storage.getAllUsers(tid(req)).find((u: any) => u.teamMemberId === repId);
      if (!linked) return res.status(404).json({ error: "That member has no login", code: "NO_LOGIN" });

      const locked = req.body?.locked === true;
      store.setConsentLock({
        tenantId: tid(req), userId: linked.id, locked,
        actorUserId: uid(req), nowIso: nowIso(),
      });
      storage.logActivity(uid(req), locked ? "mileage.consent.locked" : "mileage.consent.unlocked", "team_member", repId, { locked });
      res.json(store.getConsent(tid(req), linked.id));
    } catch (e) { fail(res, e); }
  });

  // ── POST /api/mileage/trips — manual entry ────────────────────────────────
  app.post("/api/mileage/trips", requireCapability("mileage.submit.self"), (req, res) => {
    try {
      const repId = meRep(req);
      if (!repId) return res.status(400).json({ error: "No team member is linked to this login", code: "NO_REP" });

      const b = req.body ?? {};
      const source: MileageSource =
        (MILEAGE_SOURCES as readonly string[]).includes(b.source) ? b.source : "MANUAL";
      const milesHundredths = parseMiles(b.miles);
      if (milesHundredths == null) {
        return res.status(400).json({ error: "miles must be a number between 0 and 2000", code: "INVALID_MILES" });
      }
      const tripDate = asDate(b.tripDate);
      if (!tripDate) return res.status(400).json({ error: "tripDate must be YYYY-MM-DD", code: "INVALID_DATE" });

      const candidate = {
        tripDate,
        startLocation: b.startLocation ?? null, endLocation: b.endLocation ?? null,
        startLat: b.startLatitude ?? null, startLng: b.startLongitude ?? null,
        endLat: b.endLatitude ?? null, endLng: b.endLongitude ?? null,
        milesHundredths,
      };
      const duplicates = store.duplicatesFor(tid(req), repId, candidate);
      // A warning, not a refusal — a rep genuinely can drive the same route
      // twice in a day, and blocking it teaches people to fudge the address.
      if (duplicates.length > 0 && b.duplicateAck !== true) {
        return res.status(409).json({
          error: "This looks like a trip you already logged today.",
          code: "MILEAGE_DUPLICATE_SUSPECTED",
          duplicates: duplicates.map(d => ({ id: d.id, miles: formatMiles(d.milesHundredths), startLocation: d.startLocation, endLocation: d.endLocation })),
        });
      }

      const trip = store.createTrip({
        tenantId: tid(req), repId, userId: uid(req), tripDate,
        startLocation: b.startLocation ?? null, endLocation: b.endLocation ?? null,
        startLatitude: b.startLatitude ?? null, startLongitude: b.startLongitude ?? null,
        endLatitude: b.endLatitude ?? null, endLongitude: b.endLongitude ?? null,
        milesHundredths, distanceMethod: "MANUAL",
        purpose: b.purpose ?? null,
        customerOrLeadId: b.customerOrLeadId ?? null,
        territoryId: b.territoryId ?? null,
        vehicleId: b.vehicleId ?? null,
        notes: b.notes ?? null,
        source, clientId: b.clientId ?? null,
        duplicateAck: b.duplicateAck === true,
        nowIso: nowIso(), todayIso: todayIso(req),
      });
      res.status(201).json(trip);
    } catch (e) { fail(res, e); }
  });

  // ── POST /api/mileage/trips/:id/start — open a GPS trip ───────────────────
  // The id in the path is the CLIENT's trip id for an already-created draft;
  // posting to id 0 (or "new") opens a fresh one, which is what the mobile
  // tracker's single "Start trip" button does.
  app.post("/api/mileage/trips/:id/start", requireCapability("mileage.submit.self"), (req, res) => {
    try {
      const repId = meRep(req);
      if (!repId) return res.status(400).json({ error: "No team member is linked to this login", code: "NO_REP" });

      // Location is never sampled without an accepted disclosure. Checked
      // server-side as well as in the UI, because the UI is not the boundary.
      if (!mayStartGpsTrip(store.getConsent(tid(req), uid(req)), store.getGpsPolicy(tid(req)))) {
        return res.status(403).json({
          error: "Accept the location disclosure before starting a GPS trip.",
          code: "MILEAGE_CONSENT_REQUIRED",
          currentVersion: LOCATION_DISCLOSURE_VERSION,
        });
      }

      const open = store.openTripFor(tid(req), repId);
      // Returning the existing open trip rather than erroring makes a
      // double-tapped Start button harmless.
      if (open) return res.status(200).json(open);

      const b = req.body ?? {};
      const trip = store.createTrip({
        tenantId: tid(req), repId, userId: uid(req),
        tripDate: asDate(b.tripDate) ?? todayIso(req),
        startLocation: b.startLocation ?? null,
        startLatitude: b.latitude ?? null, startLongitude: b.longitude ?? null,
        milesHundredths: 0, distanceMethod: "STRAIGHT_LINE",
        purpose: b.purpose ?? null,
        territoryId: b.territoryId ?? null,
        vehicleId: b.vehicleId ?? null,
        source: "GPS", startedAt: nowIso(),
        clientId: b.clientId ?? null,
        nowIso: nowIso(), todayIso: todayIso(req),
      });
      res.status(201).json(trip);
    } catch (e) { fail(res, e); }
  });

  // ── POST /api/mileage/trips/:id/end ───────────────────────────────────────
  app.post("/api/mileage/trips/:id/end", requireCapability("mileage.submit.self"), (req, res) => {
    try {
      const id = Number(req.params.id);
      const trip = store.getTrip(tid(req), id);
      if (!trip || trip.repId !== meRep(req)) return res.status(404).json({ error: "Trip not found" });

      const b = req.body ?? {};
      const distance = computeTripDistance({
        // A rep's own odometer reading beats any provider — they drove it.
        manualMilesHundredths: b.miles != null ? parseMiles(b.miles) : null,
        routedMilesHundredths: b.routedMiles != null ? parseMiles(b.routedMiles) : null,
        start: trip.startLatitude != null && trip.startLongitude != null
          ? { lat: trip.startLatitude, lng: trip.startLongitude } : null,
        end: b.latitude != null && b.longitude != null ? { lat: b.latitude, lng: b.longitude } : null,
      });
      if (!distance) {
        return res.status(400).json({
          error: "No distance could be determined. Enter the miles manually.",
          code: "MILEAGE_NO_DISTANCE",
        });
      }

      const ended = store.endTrip({
        tenantId: tid(req), id,
        endLatitude: b.latitude ?? null, endLongitude: b.longitude ?? null,
        endLocation: b.endLocation ?? null,
        milesHundredths: distance.milesHundredths, distanceMethod: distance.method,
        nowIso: nowIso(),
      });
      res.json(ended);
    } catch (e) { fail(res, e); }
  });

  // ── PATCH /api/mileage/trips/:id ──────────────────────────────────────────
  app.patch("/api/mileage/trips/:id", requireCapability("mileage.submit.self"), (req, res) => {
    try {
      const id = Number(req.params.id);
      const trip = store.getTrip(tid(req), id);
      if (!trip) return res.status(404).json({ error: "Trip not found" });

      // A rep may edit only their own trip; a manager may edit any trip in
      // scope. Neither may edit a locked one — that path is an adjustment.
      const isOwn = trip.repId === meRep(req);
      if (!isOwn && !can((req as any).user?.role, "mileage.approve")) {
        return res.status(404).json({ error: "Trip not found" });
      }

      const b = req.body ?? {};
      const patch: any = {};
      if (b.startLocation !== undefined) patch.startLocation = b.startLocation;
      if (b.endLocation !== undefined) patch.endLocation = b.endLocation;
      if (b.purpose !== undefined) patch.purpose = b.purpose;
      if (b.notes !== undefined) patch.notes = b.notes;
      if (b.customerOrLeadId !== undefined) patch.customerOrLeadId = b.customerOrLeadId;
      if (b.territoryId !== undefined) patch.territoryId = b.territoryId;
      if (b.vehicleId !== undefined) patch.vehicleId = b.vehicleId;
      if (b.duplicateAck !== undefined) patch.duplicateAck = b.duplicateAck === true;
      if (b.miles !== undefined) {
        const miles = parseMiles(b.miles);
        if (miles == null) return res.status(400).json({ error: "miles must be a number between 0 and 2000", code: "INVALID_MILES" });
        patch.milesHundredths = miles;
      }
      res.json(store.patchTrip(tid(req), id, patch, nowIso()));
    } catch (e) { fail(res, e); }
  });

  app.delete("/api/mileage/trips/:id", requireCapability("mileage.submit.self"), (req, res) => {
    try {
      const id = Number(req.params.id);
      const trip = store.getTrip(tid(req), id);
      if (!trip || trip.repId !== meRep(req)) return res.status(404).json({ error: "Trip not found" });
      store.softDeleteTrip(tid(req), id, nowIso());
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // ── POST /api/mileage/trips/:id/submit ────────────────────────────────────
  app.post("/api/mileage/trips/:id/submit", requireCapability("mileage.submit.self"), (req, res) => {
    try {
      const id = Number(req.params.id);
      const trip = store.getTrip(tid(req), id);
      if (!trip || trip.repId !== meRep(req)) return res.status(404).json({ error: "Trip not found" });

      // A resubmission after a rejection is a distinct fact, so the event key
      // carries the attempt number. Derived from the row's own history rather
      // than a client counter, which could be replayed.
      const attempt = trip.rejectedAt ? 2 : 1;
      res.json(store.transitionTrip({
        tenantId: tid(req), id, to: "SUBMITTED",
        actorUserId: uid(req), nowIso: nowIso(), submitAttempt: attempt,
      }));
    } catch (e) { fail(res, e); }
  });

  // ── Approve / reject — the manager queue ──────────────────────────────────
  app.post("/api/mileage/trips/:id/approve", requireCapability("mileage.approve"), (req, res) => {
    try {
      const id = Number(req.params.id);
      const trip = store.getTrip(tid(req), id);
      if (!trip || !canReadRep((req as any).user, trip.repId)) {
        return res.status(404).json({ error: "Trip not found" });
      }
      // A manager approving their OWN trip is self-dealing. The rule matches
      // teamHierarchy's strictly-above principle: you cannot act on yourself.
      if (trip.repId === meRep(req)) {
        return res.status(403).json({
          error: "Your own mileage must be approved by someone above you.",
          code: "MILEAGE_SELF_APPROVAL",
        });
      }
      res.json(store.transitionTrip({
        tenantId: tid(req), id, to: "APPROVED", actorUserId: uid(req), nowIso: nowIso(),
      }));
    } catch (e) { fail(res, e); }
  });

  app.post("/api/mileage/trips/:id/reject", requireCapability("mileage.approve"), (req, res) => {
    try {
      const id = Number(req.params.id);
      const reason = String(req.body?.reason ?? "").trim();
      if (!reason) return res.status(400).json({ error: "A reason is required so the rep can fix it.", code: "REASON_REQUIRED" });
      const trip = store.getTrip(tid(req), id);
      if (!trip || !canReadRep((req as any).user, trip.repId)) {
        return res.status(404).json({ error: "Trip not found" });
      }
      res.json(store.transitionTrip({
        tenantId: tid(req), id, to: "REJECTED", actorUserId: uid(req), reason, nowIso: nowIso(),
      }));
    } catch (e) { fail(res, e); }
  });

  // ── Corrections against a locked trip ─────────────────────────────────────
  app.post("/api/mileage/trips/:id/adjustments", requireCapability("mileage.approve"), (req, res) => {
    try {
      const id = Number(req.params.id);
      const trip = store.getTrip(tid(req), id);
      if (!trip || !canReadRep((req as any).user, trip.repId)) {
        return res.status(404).json({ error: "Trip not found" });
      }
      const miles = req.body?.milesDelta != null ? parseMiles(Math.abs(Number(req.body.milesDelta))) : null;
      const signedMiles = miles == null ? 0 : (Number(req.body.milesDelta) < 0 ? -miles : miles);
      res.json(store.addAdjustment({
        tenantId: tid(req), tripId: id,
        milesHundredthsDelta: signedMiles,
        centsDelta: Number.isInteger(req.body?.centsDelta) ? req.body.centsDelta : 0,
        reason: String(req.body?.reason ?? ""),
        actorUserId: uid(req), nowIso: nowIso(),
      }));
    } catch (e) { fail(res, e); }
  });

  app.get("/api/mileage/trips/:id/adjustments", requireCapability("mileage.submit.self"), (req, res) => {
    const id = Number(req.params.id);
    const trip = store.getTrip(tid(req), id);
    if (!trip || (trip.repId !== meRep(req) && !canReadRep((req as any).user, trip.repId))) {
      return res.status(404).json({ error: "Trip not found" });
    }
    res.json(store.listAdjustments(tid(req), id));
  });

  // ── Lists ─────────────────────────────────────────────────────────────────
  app.get("/api/mileage/trips", requireCapability("mileage.submit.self"), (req, res) => {
    const user = (req as any).user;
    const requested = req.query.repId != null ? Number(req.query.repId) : null;
    let repIds: number[] | null;
    if (requested != null) {
      if (!canReadRep(user, requested)) return res.status(404).json({ error: "Not found" });
      repIds = [requested];
    } else if (req.query.scope === "team") {
      repIds = readScope(user).repIds;
    } else {
      // Default is always OWN trips. A widened default is how a rep ends up
      // looking at the org's mileage because they omitted a query param.
      repIds = meRep(req) ? [meRep(req) as number] : [];
    }
    res.json(store.listTrips(tid(req), {
      repIds,
      status: (req.query.status as MileageStatus) || null,
      from: asDate(req.query.from), to: asDate(req.query.to),
      territoryId: req.query.territoryId != null ? Number(req.query.territoryId) : null,
      limit: req.query.limit != null ? Number(req.query.limit) : 200,
      offset: req.query.offset != null ? Number(req.query.offset) : 0,
    }));
  });

  /** The manager's approval queue — everything SUBMITTED in scope, oldest first
   *  so the longest-waiting rep is paid first. */
  app.get("/api/mileage/queue", requireCapability("mileage.approve"), (req, res) => {
    const trips = store.listTrips(tid(req), {
      repIds: readScope((req as any).user).repIds, status: "SUBMITTED", limit: 500,
    });
    const members = storage.getTeamMembers(tid(req));
    const nameOf = new Map(members.map((m: any) => [m.id, m.name]));
    res.json(trips
      .sort((a, b) => (a.submittedAt ?? "") < (b.submittedAt ?? "") ? -1 : 1)
      .map(t => ({ ...t, repName: nameOf.get(t.repId) ?? `Rep ${t.repId}` })));
  });

  // ── GET /api/mileage/summary ──────────────────────────────────────────────
  app.get("/api/mileage/summary", requireCapability("mileage.submit.self"), (req, res) => {
    const user = (req as any).user;
    const scoped = req.query.scope === "team" ? readScope(user).repIds : (meRep(req) ? [meRep(req) as number] : []);
    const from = asDate(req.query.from);
    const to = asDate(req.query.to);
    const trips = store.listTrips(tid(req), { repIds: scoped, from, to, limit: 5000 });

    // A pending trip has no frozen rate yet, so its estimate is priced at the
    // rate effective on ITS OWN date — never today's, which would quietly
    // re-price the queue every time an admin changed the figure.
    const rows = trips.map(t => {
      if (t.reimbursementCents != null) {
        return { status: t.status, milesHundredths: t.milesHundredths + t.adjustmentMilesHundredths, reimbursementCents: t.reimbursementCents + t.adjustmentCents };
      }
      const rate = store.rateForDate(tid(req), t.tripDate);
      return {
        status: t.status,
        milesHundredths: t.milesHundredths,
        reimbursementCents: rate ? reimbursementCents(t.milesHundredths, rate.rateMilliCentsPerMile) : 0,
      };
    });

    const summary = summarizeMileage(rows);
    res.json({
      ...summary,
      totalMiles: formatMiles(summary.totalMilesHundredths),
      reimbursementEnabled: store.reimbursementEnabled(tid(req)),
      currentRate: (() => {
        const r = store.rateForDate(tid(req), to ?? todayIso(req));
        return r ? { rateMilliCentsPerMile: r.rateMilliCentsPerMile, label: formatRate(r.rateMilliCentsPerMile), effectiveFrom: r.effectiveFrom } : null;
      })(),
    });
  });

  // ── GET /api/mileage/export ───────────────────────────────────────────────
  // The file a bookkeeper or CPA actually works from. Every column a
  // contractor-mileage substantiation needs is present: date, endpoints,
  // distance, business purpose, the rate applied, and who approved it.
  app.get("/api/mileage/export", requireCapability("mileage.read.team"), (req, res) => {
    const user = (req as any).user;
    const requested = req.query.repId != null ? Number(req.query.repId) : null;
    if (requested != null && !canReadRep(user, requested)) return res.status(404).json({ error: "Not found" });

    const trips = store.listTrips(tid(req), {
      repIds: requested != null ? [requested] : readScope(user).repIds,
      status: (req.query.status as MileageStatus) || null,
      from: asDate(req.query.from), to: asDate(req.query.to),
      territoryId: req.query.territoryId != null ? Number(req.query.territoryId) : null,
      limit: 5000,
    });
    const nameOf = new Map(storage.getTeamMembers(tid(req)).map((m: any) => [m.id, m.name]));

    const header = [
      "Trip ID", "Worker", "Date", "Start", "End", "Miles", "Purpose",
      "Territory", "Source", "Distance method", "Status",
      "Rate per mile", "Reimbursement", "Adjustments", "Net", "Approved at",
    ];
    const lines = [header.map(csvCell).join(",")];
    for (const t of trips) {
      const net = (t.reimbursementCents ?? 0) + t.adjustmentCents;
      lines.push([
        t.id,
        nameOf.get(t.repId) ?? `Rep ${t.repId}`,
        t.tripDate,
        t.startLocation ?? "",
        t.endLocation ?? "",
        ((t.milesHundredths + t.adjustmentMilesHundredths) / 100).toFixed(2),
        t.purpose ?? "",
        t.territoryId ?? "",
        t.source,
        t.distanceMethod,
        t.status,
        t.rateMilliCentsPerMile != null ? (t.rateMilliCentsPerMile / 100_000).toFixed(3) : "",
        t.reimbursementCents != null ? (t.reimbursementCents / 100).toFixed(2) : "",
        (t.adjustmentCents / 100).toFixed(2),
        (net / 100).toFixed(2),
        t.approvedAt ?? "",
      ].map(csvCell).join(","));
    }

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="mileage-${asDate(req.query.from) ?? "all"}-to-${asDate(req.query.to) ?? "now"}.csv"`);
    res.send(lines.join("\n"));
  });

  // ── Admin settings: the rate and the money switch ─────────────────────────
  app.get("/api/mileage/settings", requireCapability("mileage.read.team"), (req, res) => {
    const rates = store.listRates(tid(req));
    res.json({
      reimbursementEnabled: store.reimbursementEnabled(tid(req)),
      gpsPolicy: store.getGpsPolicy(tid(req)),
      rates: rates.map(r => ({ ...r, label: formatRate(r.rateMilliCentsPerMile) })),
      currentRate: store.rateForDate(tid(req), todayIso(req)),
      disclosureVersion: LOCATION_DISCLOSURE_VERSION,
      // Surfaced so the settings screen can explain WHY the money is off,
      // rather than presenting an unexplained disabled switch.
      agreementNotice:
        "Contractor agreements issued before mileage reimbursement was introduced state that no expense reimbursement is provided. Re-issue the agreement (or an addendum) before enabling reimbursement, and have your CPA confirm the treatment of contractor mileage.",
    });
  });

  app.put("/api/mileage/settings/rate", requireCapability("mileage.settings.manage"), (req, res) => {
    try {
      const rate = parseRateDollars(req.body?.ratePerMile);
      if (rate == null) {
        return res.status(400).json({
          error: "ratePerMile must be dollars per mile, e.g. 0.655",
          code: "INVALID_RATE",
        });
      }
      const effectiveFrom = asDate(req.body?.effectiveFrom) ?? todayIso(req);
      const added = store.addRate({
        tenantId: tid(req), rateMilliCentsPerMile: rate, effectiveFrom,
        note: req.body?.note ?? null, createdBy: uid(req), nowIso: nowIso(),
      });
      res.json({ ...added, label: formatRate(added.rateMilliCentsPerMile) });
    } catch (e) { fail(res, e); }
  });

  app.put("/api/mileage/settings/reimbursement", requireCapability("mileage.settings.manage"), (req, res) => {
    const on = req.body?.enabled === true;
    // Turning the money ON is an explicit, acknowledged act — the client must
    // confirm the agreement question, so nobody flips it past the notice by
    // accident.
    if (on && req.body?.agreementAcknowledged !== true) {
      return res.status(400).json({
        error: "Confirm that contractor agreements permit expense reimbursement before enabling it.",
        code: "AGREEMENT_ACK_REQUIRED",
      });
    }
    store.setReimbursementEnabled(tid(req), on, nowIso());
    res.json({ reimbursementEnabled: store.reimbursementEnabled(tid(req)) });
  });

  // ── Vehicles ──────────────────────────────────────────────────────────────
  app.get("/api/mileage/vehicles", requireCapability("mileage.submit.self"), (req, res) => {
    res.json(store.listVehicles(tid(req), meRep(req) ?? 0));
  });

  app.post("/api/mileage/vehicles", requireCapability("mileage.submit.self"), (req, res) => {
    const repId = meRep(req);
    if (!repId) return res.status(400).json({ error: "No team member is linked to this login", code: "NO_REP" });
    const label = String(req.body?.label ?? "").trim();
    if (!label) return res.status(400).json({ error: "label is required", code: "INVALID_VEHICLE" });
    res.status(201).json(store.addVehicle({
      tenantId: tid(req), repId, label,
      make: req.body?.make ?? null, model: req.body?.model ?? null,
      year: Number.isInteger(req.body?.year) ? req.body.year : null,
      plateLast4: String(req.body?.plateLast4 ?? "").slice(0, 4) || null,
      nowIso: nowIso(),
    }));
  });
}
