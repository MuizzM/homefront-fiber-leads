// ── Fiber Sales Academy HTTP surface ──────────────────────────────────────────
//
// Everything lives under /api/training so the training gate's allowlist
// (shared/trainingGate.ts TRAINING_GATE_ALLOWED_PREFIXES) already covers it: a
// new hire who has not cleared the gate must still be able to reach the thing
// that clears it.
//
// THE PRIVACY RULE, ENFORCED HERE
//   Coaching results are visible to the rep and to their chain of command, and
//   to nobody else. Concretely:
//     * every own-scope read takes its user id from the session, never a param;
//     * the team rollup returns counts and averages, not transcripts;
//     * a per-rep coaching read requires training.read.team AND a tenant match,
//       and 404s across a tenant wall rather than 403ing (a 403 confirms the
//       id exists);
//     * there is no endpoint that returns reps ordered by score. The team view
//       is sorted by name, and the gap analysis aggregates dimensions rather
//       than people. That is a product decision and it is enforced by shape.

import type { Express, NextFunction, Request, Response } from "express";
import { rawDb } from "./db";
import type { Capability } from "@shared/capabilities";
import {
  activeOffers, calendarDay, competitorOffers, expiredOffers, headlineOffer,
  type AcademyOffer, type CompetitorOffer,
} from "@shared/academyOffers";
import { getStage, isActivityId } from "@shared/academyPath";
import { isPersonaId } from "@shared/academyPersonas";
import { scoreSession } from "@shared/academyScoring";
import { certificationStatuses, computePathProgress, practiceAreas, teamGaps } from "@shared/academyProgress";
import { reclassifySession, type RolePlaySession } from "@shared/academyRolePlay";
import {
  clearActivityState, completeActivity, completeAssignment, createAssignment,
  deleteAssignment, getOfferCatalog, getRolePlaySession, listActivityProgress,
  listActivityStates, listAssignmentsFor, listRolePlayHistory, rolePlayScores,
  saveActivityState, saveOfferCatalog, saveRolePlaySession, teamProgress, teamScores,
  MAX_STATE_BYTES,
} from "./academyStore";

type Middleware = (req: Request, res: Response, next: NextFunction) => unknown;

export interface AcademyRouteDeps {
  requireAuth: Middleware;
  requireCapability: (capability: Capability) => Middleware;
}

function sessionUser(req: Request): { id: number; tenantId: number | null; role: string } {
  const user = (req as any).user ?? {};
  return {
    id: Number(user.id),
    tenantId: user.tenantId == null ? null : Number(user.tenantId),
    role: String(user.role ?? "rep"),
  };
}

/** The market a request is scoped to. Query param, else the tenant default. */
function marketOf(req: Request): string | undefined {
  const raw = req.query.market;
  if (typeof raw !== "string") return undefined;
  const clean = raw.trim().toLowerCase().slice(0, 64);
  return /^[a-z0-9][a-z0-9-]*$/.test(clean) ? clean : undefined;
}

/** Today, as a calendar date. A `day` query param is honoured only in test
 *  builds: a rep must never be able to time-travel past an expired promotion. */
function dayOf(req: Request): string {
  if (process.env.NODE_ENV === "test") {
    const raw = req.query.day;
    if (typeof raw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  }
  return calendarDay(new Date());
}

/** Active users in the caller's tenant, for the supervisor roster. */
function tenantUserIds(tenantId: number | null): number[] {
  if (tenantId == null) return [];
  return (rawDb.prepare(
    `SELECT id FROM users WHERE tenant_id = ? AND active = 1`,
  ).all(tenantId) as { id: number }[]).map((r) => r.id);
}

function userInTenant(tenantId: number | null, userId: number): boolean {
  if (tenantId == null) return false;
  const row = rawDb.prepare(
    `SELECT 1 AS ok FROM users WHERE id = ? AND tenant_id = ? AND active = 1`,
  ).get(userId, tenantId) as { ok: number } | undefined;
  return !!row;
}

export function registerAcademyRoutes(app: Express, deps: AcademyRouteDeps): void {
  const { requireAuth, requireCapability } = deps;
  const canReadTeam = requireCapability("training.read.team");
  const canManage = requireCapability("training.manage");

  // ── Offers ──────────────────────────────────────────────────────────────────
  // The rep-facing read. Returns only what may be quoted today in this market,
  // plus what has expired, so the UI can say "this market's promotion ended on
  // the 4th" rather than silently rendering nothing.
  app.get("/api/training/academy/offers", requireAuth, (req: Request, res: Response) => {
    const user = sessionUser(req);
    const catalog = getOfferCatalog(user.tenantId);
    const day = dayOf(req);
    const market = marketOf(req);
    const query = { day, market, provider: "kinetic" };
    res.json({
      day,
      market: market ?? null,
      version: catalog.version,
      offers: activeOffers(catalog, query),
      expired: expiredOffers(catalog, query),
      headline: headlineOffer(catalog, query),
      competitors: competitorOffers(catalog, { day, market }),
    });
  });

  // The supervisor's whole catalog, expired rows included, for editing.
  app.get("/api/training/academy/offers/catalog", canManage, (req: Request, res: Response) => {
    const user = sessionUser(req);
    res.json(getOfferCatalog(user.tenantId));
  });

  app.put("/api/training/academy/offers/catalog", canManage, (req: Request, res: Response) => {
    const user = sessionUser(req);
    const body = req.body ?? {};
    if (!Array.isArray(body.offers)) return res.status(400).json({ error: "offers must be a list" });
    if (body.offers.length > 200) return res.status(400).json({ error: "Too many offers" });
    const competitors: CompetitorOffer[] = Array.isArray(body.competitors) ? body.competitors.slice(0, 200) : [];
    const { catalog, errors } = saveOfferCatalog(
      user.tenantId,
      { offers: body.offers as AcademyOffer[], competitors },
      user.id,
    );
    if (errors.length) return res.status(400).json({ error: "Some offers could not be saved", details: errors });
    res.json(catalog);
  });

  // ── The rep's own path ──────────────────────────────────────────────────────
  app.get("/api/training/academy/progress", requireAuth, (req: Request, res: Response) => {
    const user = sessionUser(req);
    const records = listActivityProgress(user.id, user.tenantId);
    const scores = rolePlayScores(user.id, user.tenantId);
    const history = listRolePlayHistory(user.id, user.tenantId, 20);
    res.json({
      records,
      states: listActivityStates(user.id, user.tenantId),
      path: computePathProgress(records),
      certifications: certificationStatuses(records, scores),
      practiceAreas: practiceAreas(history.map((h) => h.score)),
      assignments: listAssignmentsFor(user.id, user.tenantId),
      rolePlayCount: scores.length,
      rolePlayAverage: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
    });
  });

  app.post("/api/training/academy/activities/:activityId/complete", requireAuth, (req: Request, res: Response) => {
    const user = sessionUser(req);
    const activityId = String(req.params.activityId ?? "");
    if (!isActivityId(activityId)) return res.status(400).json({ error: "Unknown activity id" });

    let score: number | null = null;
    const raw = (req.body ?? {}).score;
    if (raw !== undefined && raw !== null) {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        return res.status(400).json({ error: "score must be a number between 0 and 100" });
      }
      score = Math.round(n);
    }
    const record = completeActivity(user.id, user.tenantId, activityId, score);
    // Finishing the activity clears its half-done state: resuming into a quiz
    // you already passed is worse than starting it fresh.
    clearActivityState(user.id, user.tenantId, activityId);

    // Close any assignment this satisfies, so a rep never has to tick it off.
    const records = listActivityProgress(user.id, user.tenantId);
    for (const assignment of listAssignmentsFor(user.id, user.tenantId)) {
      if (assignment.completedAt) continue;
      const satisfied = assignment.targetKind === "activity"
        ? assignment.targetId === activityId
        : computePathProgress(records).stages.find((s) => s.stage.id === assignment.targetId)?.complete === true;
      if (satisfied) completeAssignment(user.tenantId, user.id, assignment.id);
    }
    res.json(record);
  });

  // Resume state. Saved constantly while a rep works through an activity, so
  // it is deliberately cheap: no validation of the blob's shape, only its size.
  app.put("/api/training/academy/activities/:activityId/state", requireAuth, (req: Request, res: Response) => {
    const user = sessionUser(req);
    const activityId = String(req.params.activityId ?? "");
    if (!isActivityId(activityId)) return res.status(400).json({ error: "Unknown activity id" });
    try {
      const saved = saveActivityState(user.id, user.tenantId, activityId, (req.body ?? {}).state ?? null);
      res.json(saved);
    } catch (e: any) {
      const tooBig = String(e?.message ?? "").includes("too large");
      res.status(tooBig ? 413 : 500).json({ error: tooBig ? `State must be under ${MAX_STATE_BYTES} bytes` : "Could not save" });
    }
  });

  app.delete("/api/training/academy/activities/:activityId/state", requireAuth, (req: Request, res: Response) => {
    const user = sessionUser(req);
    const activityId = String(req.params.activityId ?? "");
    if (!isActivityId(activityId)) return res.status(400).json({ error: "Unknown activity id" });
    clearActivityState(user.id, user.tenantId, activityId);
    res.json({ ok: true });
  });

  // ── Role-play ───────────────────────────────────────────────────────────────
  // The conversation itself runs entirely on the client (shared/academyRolePlay
  // is pure and offline-capable). This endpoint stores the finished transcript
  // and RE-SCORES it server-side rather than trusting the client's numbers: a
  // coaching record whose scores were computed by the thing being scored is not
  // a record. The same pure function runs in both places, so the honest client
  // sees no difference.
  app.post("/api/training/academy/roleplay", requireAuth, (req: Request, res: Response) => {
    const user = sessionUser(req);
    const body = req.body ?? {};
    const session = body.session as RolePlaySession | undefined;

    if (!session || typeof session !== "object") return res.status(400).json({ error: "session is required" });
    if (typeof session.id !== "string" || !session.id || session.id.length > 128) {
      return res.status(400).json({ error: "session.id is required" });
    }
    if (!isPersonaId(session.personaId)) return res.status(400).json({ error: "Unknown persona" });
    if (!Array.isArray(session.turns) || session.turns.length > 200) {
      return res.status(400).json({ error: "session.turns is invalid" });
    }

    const catalog = getOfferCatalog(user.tenantId);
    const offers = activeOffers(catalog, { day: dayOf(req), market: session.market || undefined, provider: "kinetic" });

    // Re-derive every rep turn's intents, signals and violations from its TEXT
    // before scoring. The turns arrive in a request body, so their annotations
    // are a claim, not evidence: a client posting `violations: []` beside a
    // pressure line would otherwise be handed a clean compliance score. The
    // reclassified transcript is what gets stored, so the coaching record and
    // the score it carries are derived from the same thing.
    const scored = reclassifySession(session, offers);
    const score = scoreSession(scored, { offers });

    try {
      const stored = saveRolePlaySession(user.id, user.tenantId, {
        session: scored, score, mode: String(body.mode ?? "text"),
      });
      res.json(stored);
    } catch (e: any) {
      const tooBig = String(e?.message ?? "").includes("too large");
      res.status(tooBig ? 413 : 500).json({ error: tooBig ? "Transcript too long" : "Could not save" });
    }
  });

  app.get("/api/training/academy/roleplay", requireAuth, (req: Request, res: Response) => {
    const user = sessionUser(req);
    res.json({ sessions: listRolePlayHistory(user.id, user.tenantId) });
  });

  app.get("/api/training/academy/roleplay/:sessionId", requireAuth, (req: Request, res: Response) => {
    const user = sessionUser(req);
    const stored = getRolePlaySession(user.id, user.tenantId, String(req.params.sessionId ?? ""));
    if (!stored) return res.status(404).json({ error: "Not found" });
    res.json(stored);
  });

  // ── Supervisor ──────────────────────────────────────────────────────────────
  // Counts and averages for the caller's tenant, ordered by NAME. There is no
  // score ordering here on purpose: see the header note.
  app.get("/api/training/academy/team", canReadTeam, (req: Request, res: Response) => {
    const user = sessionUser(req);
    const ids = tenantUserIds(user.tenantId);
    const members = teamProgress(user.tenantId, ids);
    const gaps = teamGaps(teamScores(user.tenantId, ids));
    res.json({ members, gaps });
  });

  // One rep's coaching detail. Requires team-read authority AND a tenant match;
  // a foreign id is a 404, which does not confirm the id exists.
  app.get("/api/training/academy/team/:userId", canReadTeam, (req: Request, res: Response) => {
    const user = sessionUser(req);
    const targetId = Number(req.params.userId);
    if (!Number.isInteger(targetId) || targetId <= 0) return res.status(400).json({ error: "Invalid user id" });
    if (!userInTenant(user.tenantId, targetId)) return res.status(404).json({ error: "Not found" });

    const records = listActivityProgress(targetId, user.tenantId);
    const history = listRolePlayHistory(targetId, user.tenantId, 20);
    res.json({
      userId: targetId,
      path: computePathProgress(records),
      certifications: certificationStatuses(records, history.map((h) => h.overall)),
      practiceAreas: practiceAreas(history.map((h) => h.score)),
      sessions: history,
      assignments: listAssignmentsFor(targetId, user.tenantId),
    });
  });

  app.post("/api/training/academy/assignments", canManage, (req: Request, res: Response) => {
    const user = sessionUser(req);
    const body = req.body ?? {};
    const targetUserId = Number(body.userId);
    if (!Number.isInteger(targetUserId) || targetUserId <= 0) return res.status(400).json({ error: "Invalid user id" });
    if (!userInTenant(user.tenantId, targetUserId)) return res.status(404).json({ error: "Not found" });

    const targetKind = body.targetKind === "stage" ? "stage" : "activity";
    const targetId = String(body.targetId ?? "");
    const known = targetKind === "activity" ? isActivityId(targetId) : !!getStage(targetId);
    if (!known) return res.status(400).json({ error: "Unknown assignment target" });

    let dueOn: string | null = null;
    if (body.dueOn) {
      const raw = String(body.dueOn);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return res.status(400).json({ error: "dueOn must be a yyyy-mm-dd date" });
      dueOn = raw;
    }
    const assignment = createAssignment(user.tenantId, {
      userId: targetUserId, targetId, targetKind,
      note: String(body.note ?? ""), assignedBy: user.id, dueOn,
    });
    res.status(201).json(assignment);
  });

  app.delete("/api/training/academy/assignments/:id", canManage, (req: Request, res: Response) => {
    const user = sessionUser(req);
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid id" });
    if (!deleteAssignment(user.tenantId, id)) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true });
  });
}
