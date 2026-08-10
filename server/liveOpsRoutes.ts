// ── Live field operations - HTTP surface ─────────────────────────────────────
//
// Two rules hold across every route here.
//
// SCOPE IS SERVER-SIDE, ALWAYS. No endpoint accepts a rep id, team or territory
// filter and trusts it. The caller's scope is resolved from their own roster
// seat (liveOpsScope) and applied in SQL; a client-supplied filter can only
// NARROW that set, never widen it. This is the gap the existing
// GET /api/location-pings/latest leaves open, where requireManager alone hands
// over every rep in the tenant.
//
// OUT OF SCOPE IS 404. Not 403 - a 403 confirms the row exists, which is itself
// a disclosure about someone the caller is not entitled to know about. Same
// convention as mileageRoutes.

import type { Express, Request, Response } from "express";
import { storage } from "./storage";
import { rawDb } from "./db";
import { recordAdminAudit, auditContext } from "./adminAudit";
import { liveOpsScope, repInLiveOpsScope, type ScopeMember } from "./liveOpsScope";
import * as store from "./liveOpsStore";
import {
  DOOR_ACTIVITY_ROW_CAP,
  FIELD_LOCATION_DISCLOSURE_VERSION,
  TRACK_HISTORY_ROW_CAP,
  VIEW_AUDIT_COALESCE_MS,
  type DeviceKind,
} from "@shared/liveOps";
import type { Capability } from "@shared/capabilities";

interface Deps {
  requireAuth: any;
  /** Typed as Capability, not string: a mistyped capability name is then a
   *  compile error rather than a route that 403s everyone at runtime. */
  requireCapability: (cap: Capability) => any;
}

/**
 * Mirrors the bbox parsing in routes.ts (parseMapBBox), which is a local
 * function inside registerRoutes and cannot be imported. Same clamps and the
 * same span guard; kept small deliberately rather than exported from a
 * 12,000-line module while another change is in flight there.
 */
const MAX_SPAN_DEG = 40;
function parseBBox(raw: unknown): { minLng: number; minLat: number; maxLng: number; maxLat: number } | null {
  if (typeof raw !== "string") return null;
  const parts = raw.split(",").map((n) => Number(n));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [a, b, c, d] = parts;
  const minLng = Math.max(-180, Math.min(a, c));
  const maxLng = Math.min(180, Math.max(a, c));
  const minLat = Math.max(-90, Math.min(b, d));
  const maxLat = Math.min(90, Math.max(b, d));
  if (maxLng - minLng > MAX_SPAN_DEG || maxLat - minLat > MAX_SPAN_DEG) return null;
  return { minLng, minLat, maxLng, maxLat };
}

/**
 * One audit row per viewer per window, not one per poll.
 *
 * A dashboard refreshing every ten seconds would otherwise file 360 rows an
 * hour per viewer, and an audit trail nobody can read is the same as no audit
 * trail. Process-local on purpose: the goal is to record that a person looked
 * at the board today, and a restart re-arming the log is the safe direction to
 * be wrong in.
 */
const lastViewLog = new Map<number, number>();
function logViewOnce(userId: number, tenantId: number | null, action: string, details?: any) {
  const now = Date.now();
  const prev = lastViewLog.get(userId) ?? 0;
  if (now - prev < VIEW_AUDIT_COALESCE_MS) return;
  lastViewLog.set(userId, now);
  try { storage.logActivity(userId, action, "live_ops", undefined, details, undefined, tenantId ?? undefined); }
  catch { /* audit must never break the read */ }
}

/** Coarse form factor from the client's own claim, bucketed to three values.
 *  Never the user agent: a bucket tells a supervisor "on the road"; a UA string
 *  is a fingerprint that outlives its purpose. */
function deviceKind(raw: unknown): DeviceKind {
  const v = String(raw ?? "").toLowerCase();
  if (v === "phone" || v === "tablet" || v === "desktop") return v;
  return "unknown";
}


// ── The live stream ──────────────────────────────────────────────────────────
//
// Modelled on /api/leads/events, and for the same reason: the frame carries NO
// location data. It says only "something in your org moved", and the client
// refetches through the normal scoped endpoint. That matters here more than it
// does for leads - if the frame carried positions, the stream would become a
// second read path that has to re-derive the branch scope, and a mistake there
// would push one manager's reps to another manager's browser. A data-free
// notification cannot widen anyone's visibility, whatever it gets wrong.
//
// Polling stays armed underneath. On a 503 (too many connections), a dropped
// socket, or a proxy that eats event-streams, the dashboard keeps refreshing
// on its interval and the only thing lost is immediacy.

const STREAM_MAX_PER_TENANT = 250;
const liveOpsStreams = new Map<number, Set<Response>>();

/** Tell every listener in a tenant that state changed. Never called with data. */
export function notifyLiveOpsChanged(tenantId: number | null | undefined): void {
  const tid = Number(tenantId ?? 0);
  const clients = liveOpsStreams.get(tid);
  if (!clients?.size) return;
  for (const res of clients) {
    if (res.writableEnded) continue;
    try { res.write(`event: changed\ndata: {}\n\n`); } catch { /* dropped; close handler cleans up */ }
  }
}

export function registerLiveOpsRoutes(app: Express, deps: Deps) {
  const { requireAuth, requireCapability } = deps;
  const uid = (req: Request) => (req as any).user?.id ?? null;
  const tid = (req: Request) => ((req as any).user?.tenantId ?? null) as number | null;
  const actor = (req: Request) => (req as any).user ?? null;

  /** The tenant roster, in the shape the scope resolver needs. */
  const roster = (req: Request): ScopeMember[] =>
    (storage.getTeamMembers(tid(req) ?? undefined) as any[]).map((m) => ({
      id: Number(m.id),
      role: String(m.role ?? "rep"),
      reportsToId: m.reportsToId == null ? null : Number(m.reportsToId),
      active: m.active !== false && Number(m.active ?? 1) !== 0,
    }));

  const scopeOf = (req: Request) => liveOpsScope(actor(req), roster(req));

  // ── The board ──────────────────────────────────────────────────────────────

  app.get("/api/live-ops/reps", requireAuth, requireCapability("field.location.read.team"),
    (req: Request, res: Response) => {
      const scope = scopeOf(req);
      const reps = store.getLiveStates(tid(req), scope);
      logViewOnce(uid(req), tid(req), "liveops.viewed", { repCount: reps.length });
      res.json({ reps, serverTime: new Date().toISOString() });
    });

  app.get("/api/live-ops/presence", requireAuth, requireCapability("field.location.read.team"),
    (req: Request, res: Response) => {
      res.json({ rows: store.getPresenceRows(tid(req), scopeOf(req)) });
    });

  // ── Recent door activity ───────────────────────────────────────────────────
  // Bounded three ways: the caller's scope, a bounding box, and a hard row cap.
  // This is the one read here that could otherwise be large.
  app.get("/api/live-ops/door-activity", requireAuth, requireCapability("field.location.read.team"),
    (req: Request, res: Response) => {
      const scope = scopeOf(req);
      if (Array.isArray(scope) && scope.length === 0) return res.json({ events: [] });

      const bbox = parseBBox(req.query.bbox);
      const sinceRaw = String(req.query.since ?? "");
      const since = /^\d{4}-\d{2}-\d{2}T/.test(sinceRaw)
        ? sinceRaw
        : new Date(Date.now() - 4 * 60 * 60_000).toISOString();

      const where: string[] = [
        "k.knocked_at >= ?", "k.superseded = 0",
        "k.rep_lat IS NOT NULL", "k.rep_lng IS NOT NULL",
      ];
      const args: any[] = [since];
      const t = tid(req);
      if (t != null) { where.push("k.tenant_id = ?"); args.push(t); }
      if (scope !== null) {
        where.push(`k.rep_id IN (${scope.map(() => "?").join(",")})`);
        args.push(...scope);
      }
      if (bbox) {
        where.push("k.rep_lat BETWEEN ? AND ?", "k.rep_lng BETWEEN ? AND ?");
        args.push(bbox.minLat, bbox.maxLat, bbox.minLng, bbox.maxLng);
      }

      try {
        const events = rawDb
          .prepare(
            `SELECT k.id, k.rep_id AS repId, tm.name AS repName, k.outcome,
                    k.knocked_at AS knockedAt, k.rep_lat AS lat, k.rep_lng AS lng
               FROM knock_log k
               LEFT JOIN team_members tm ON tm.id = k.rep_id
              WHERE ${where.join(" AND ")}
              ORDER BY k.knocked_at DESC
              LIMIT ?`,
          )
          .all(...args, DOOR_ACTIVITY_ROW_CAP);
        res.json({ events, capped: (events as any[]).length >= DOOR_ACTIVITY_ROW_CAP });
      } catch {
        res.json({ events: [], capped: false });
      }
    });

  // ── History: the audited one ───────────────────────────────────────────────
  app.get("/api/live-ops/rep/:repId/track", requireAuth, requireCapability("field.location.export"),
    (req: Request, res: Response) => {
      const repId = Number(req.params.repId);
      if (!Number.isFinite(repId)) return res.status(400).json({ error: "Bad rep id" });

      // Tenant wall first, then scope. Both answer 404 so neither confirms that
      // a rep outside the caller's world exists.
      const member = storage.getTeamMemberById(repId, tid(req) ?? undefined);
      if (!member) return res.status(404).json({ error: "Not found" });
      if (!repInLiveOpsScope(actor(req), roster(req), repId)) {
        return res.status(404).json({ error: "Not found" });
      }

      const from = String(req.query.from ?? "");
      const to = String(req.query.to ?? "");
      if (!/^\d{4}-\d{2}-\d{2}T/.test(from) || !/^\d{4}-\d{2}-\d{2}T/.test(to)) {
        return res.status(400).json({ error: "from and to must be ISO timestamps" });
      }

      const points = store.getTrackHistory(repId, from, to, TRACK_HISTORY_ROW_CAP);

      // The append-only stream, not the activity log: pulling a person's
      // movement history is exactly what a compliance reviewer comes looking
      // for, and admin_audit is trigger-protected against edits and deletes.
      recordAdminAudit({
        ...auditContext(req),
        action: "liveops.location_exported",
        targetType: "team_member",
        targetId: repId,
        targetLabel: (member as any).name ?? String(repId),
        after: { from, to, rowCount: points.length },
        tenantId: tid(req),
        outcome: "success",
      });

      res.json({ repId, points, capped: points.length >= TRACK_HISTORY_ROW_CAP });
    });

  // ── The rep's own view of being tracked ────────────────────────────────────
  // Every field user may read this about THEMSELVES. It is the transparency
  // half of "default on": a rep can always see whether they are being tracked,
  // under which policy, and why not when they are not.
  app.get("/api/live-ops/me", requireAuth, requireCapability("field.app.use"),
    (req: Request, res: Response) => {
      const user = actor(req);
      const policy = store.getFieldLocationPolicy(tid(req));
      const consent = store.getFieldLocationConsent(uid(req));
      const repId = user?.teamMemberId ?? null;
      const session = repId ? storage.getActiveClockSession(repId) : undefined;
      const gate = store.trackingGate({ policy, consent, clockedIn: !!session });
      res.json({
        tracking: gate.allowed,
        reason: gate.reason,
        disclosureVersion: FIELD_LOCATION_DISCLOSURE_VERSION,
        needsDisclosure:
          policy.mode !== "off" &&
          consent?.disclosureVersion !== FIELD_LOCATION_DISCLOSURE_VERSION,
        paused: !!consent?.pausedAt,
        canPause: policy.allowRepPause,
        retentionDays: policy.retentionDays,
        clockedIn: !!session,
      });
    });

  app.post("/api/live-ops/consent/acknowledge", requireAuth, requireCapability("field.app.use"),
    (req: Request, res: Response) => {
      store.acknowledgeDisclosure(uid(req), tid(req));
      try {
        storage.logActivity(uid(req), "liveops.disclosure_acknowledged", "user", uid(req),
          { version: FIELD_LOCATION_DISCLOSURE_VERSION }, req.ip, tid(req) ?? undefined);
      } catch { /* best effort */ }
      res.json({ ok: true, version: FIELD_LOCATION_DISCLOSURE_VERSION });
    });

  app.post("/api/live-ops/consent/pause", requireAuth, requireCapability("field.app.use"),
    (req: Request, res: Response) => {
      const policy = store.getFieldLocationPolicy(tid(req));
      const paused = !!req.body?.paused;
      // Resuming is always allowed. Only PAUSING is a policy question, so an
      // org that has switched the control off cannot trap a rep in a paused
      // state they are not permitted to leave.
      if (paused && !policy.allowRepPause) {
        return res.status(403).json({ error: "Pausing is disabled by your organization" });
      }
      store.setTrackingPause(uid(req), paused, req.body?.reason ?? null);
      try {
        storage.logActivity(uid(req), paused ? "liveops.tracking_paused" : "liveops.tracking_resumed",
          "user", uid(req), undefined, req.ip, tid(req) ?? undefined);
      } catch { /* best effort */ }
      res.json({ ok: true, paused });
    });

  // ── Ingest ─────────────────────────────────────────────────────────────────
  // The ONE write path. Every gate lives in ingestFix; this route only shapes
  // the request and reports the refusal reason back so a rep's phone can stop
  // asking rather than retry forever.
  app.post("/api/live-ops/ping", requireAuth, requireCapability("field.app.use"),
    (req: Request, res: Response) => {
      const user = actor(req);
      const repId = user?.teamMemberId ?? null;
      if (repId == null) return res.status(404).json({ error: "Not found" });

      const lat = Number(req.body?.lat);
      const lng = Number(req.body?.lng);
      // A rep may report that they CANNOT locate. That is a status, not a
      // position, and it is how a denied-GPS rep shows as location_unavailable
      // instead of being frozen on their last known pin.
      if (req.body?.locationDenied) {
        return res.json({ stored: false, reason: "location-denied" });
      }
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        return res.status(400).json({ error: "lat and lng required" });
      }

      const result = store.ingestFix({
        repId, userId: uid(req), tenantId: tid(req),
        lat, lng,
        accuracyM: req.body?.accuracyM == null ? null : Number(req.body.accuracyM),
        capturedAt: req.body?.capturedAt ?? null,
        heading: req.body?.heading == null ? null : Number(req.body.heading),
        source: "ping",
      });
      // Only on an accepted fix. A rejected one changed nothing, so waking
      // every dashboard in the org would be pure noise - and at the dedupe
      // rates above, rejections are the common case.
      if (result.stored) notifyLiveOpsChanged(tid(req));
      res.json(result);
    });

  app.post("/api/live-ops/heartbeat", requireAuth, (req: Request, res: Response) => {
    store.recordPresence({
      userId: uid(req),
      tenantId: tid(req),
      appArea: typeof req.body?.appArea === "string" ? req.body.appArea.slice(0, 64) : null,
      deviceKind: deviceKind(req.body?.deviceKind),
      connection: req.body?.connection === "degraded" ? "degraded" : "online",
      appVersion: typeof req.body?.appVersion === "string" ? req.body.appVersion.slice(0, 32) : null,
    });
    res.json({ ok: true });
  });


  app.get("/api/live-ops/stream", requireAuth, requireCapability("field.location.read.team"),
    (req: Request, res: Response) => {
      const t = Number(tid(req) ?? 0);
      const clients = liveOpsStreams.get(t) ?? new Set<Response>();
      if (clients.size >= STREAM_MAX_PER_TENANT) {
        // Refuse rather than degrade everyone. The client falls back to polling.
        return res.status(503).json({ error: "Too many live connections; using polling instead." });
      }
      res.status(200);
      res.set({
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders();
      clients.add(res);
      liveOpsStreams.set(t, clients);
      res.write(`event: ready\ndata: {}\n\n`);

      const heartbeat = setInterval(() => {
        if (!res.writableEnded) { try { res.write(": keepalive\n\n"); } catch { res.end(); } }
      }, 25_000);
      heartbeat.unref();

      req.on("close", () => {
        clearInterval(heartbeat);
        clients.delete(res);
        if (!clients.size) liveOpsStreams.delete(t);
      });
    });

  // ── Policy administration ──────────────────────────────────────────────────
  app.get("/api/live-ops/policy", requireAuth, requireCapability("settings.manage.org"),
    (req: Request, res: Response) => {
      res.json(store.getFieldLocationPolicy(tid(req)));
    });

  app.patch("/api/live-ops/policy", requireAuth, requireCapability("settings.manage.org"),
    (req: Request, res: Response) => {
      const t = tid(req);
      if (t == null) return res.status(400).json({ error: "No organization context" });
      const before = store.getFieldLocationPolicy(t);
      const after = store.setFieldLocationPolicy(t, {
        mode: req.body?.mode,
        retentionDays: req.body?.retentionDays,
        allowRepPause: req.body?.allowRepPause,
      }, uid(req));

      // "Who switched on employee tracking, and when" is the first question
      // anyone will ask about this feature. It gets an append-only answer.
      recordAdminAudit({
        ...auditContext(req),
        action: "liveops.policy_changed",
        targetType: "tenant",
        targetId: t,
        before, after,
        tenantId: t,
        outcome: "success",
      });
      res.json(after);
    });
}
