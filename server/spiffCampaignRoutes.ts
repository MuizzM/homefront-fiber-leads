// ── SPIFF campaign API ───────────────────────────────────────────────────────
// Registered from routes.ts alongside registerCommissionRoutes with the same
// injected middleware. Three audiences, three gates:
//
//   manager+  (commission.structure.manage) launch / pause / resume / cancel
//   admin     (commission.read.all)         live liability on a running campaign
//   rep       (field.app.use)               their own cards, their own progress
//
// A campaign COMMITS MONEY, so launching it is gated on the same capability as
// editing the commission plan — not on a softer "manager can post announcements"
// permission. Tenant comes from the session, never the body; rep identity on the
// rep route comes from the session's teamMemberId, never the body. Out-of-tenant
// ids read as 404, never 403, matching the rest of the app.

import type { Express, Request, Response, NextFunction } from "express";
import { storage } from "./storage";
import {
  createCampaign, getCampaign, listCampaigns, setCampaignStatus,
  campaignLiability, repCampaignCards, awardedTotal,
} from "./spiffCampaignStore";
import {
  validateCampaignInput, describeTrigger, CAMPAIGN_TRIGGER_KINDS,
  type CampaignTrigger,
} from "@shared/spiffCampaign";
import { getLadder, setLadder, repMilestoneCard, milestoneExposure } from "./knockMilestoneStore";
import { validateLadder } from "@shared/knockMilestones";
import {
  getMomentumConfig, setMomentumConfig, repMomentumCard, momentumExposure,
} from "./momentumSpiffStore";
import { validateMomentumConfig } from "@shared/momentumSpiff";
import {
  getDoorDropConfig, setDoorDropConfig, repDoorDropCard, doorDropExposure,
} from "./doorDropStore";
import {
  getDoorDayConfig, setDoorDayConfig, repDoorDayCard, doorDayExposure,
} from "./genuineDoorBonusStore";
import { getRampConfig, setRampConfig, repRampCard, rampExposure } from "./rampBonusStore";
import {
  getAchievementConfig, setAchievementConfig, repAchievementCard, achievementExposure,
} from "./salesAchievementStore";

type Mw = (req: Request, res: Response, next: NextFunction) => void;
interface Deps { requireAuth: Mw; requireCapability: (cap: any) => Mw; }

/** Narrow the client's loose JSON into a trigger the pure engine accepts.
 *  Numbers arrive as strings from some form libraries; everything the rules
 *  branch on is coerced to an integer HERE so the engine never sees a string. */
function parseTrigger(raw: any): CampaignTrigger | null {
  const kind = String(raw?.kind ?? "");
  if (!(CAMPAIGN_TRIGGER_KINDS as readonly string[]).includes(kind)) return null;
  const int = (v: unknown) => Math.trunc(Number(v));
  switch (kind) {
    case "per_sale":       return { kind: "per_sale" };
    case "knocks_by_time": return { kind: "knocks_by_time", knocks: int(raw.knocks), byHourLocal: int(raw.byHourLocal) };
    case "sale_by_time":   return { kind: "sale_by_time", byHourLocal: int(raw.byHourLocal) };
    case "sales_in_day":   return { kind: "sales_in_day", sales: int(raw.sales) };
    case "knock_streak":   return { kind: "knock_streak", days: int(raw.days), knocksPerDay: int(raw.knocksPerDay) };
    default:               return null;
  }
}

export function registerSpiffCampaignRoutes(app: Express, deps: Deps) {
  const { requireCapability } = deps;
  const tid = (req: Request): number | null => {
    const n = Number((req as any).user?.tenantId);
    return Number.isInteger(n) && n > 0 ? n : null;
  };
  const uid = (req: Request) => (req as any).user?.id ?? null;

  // ── Standing knock milestones ─────────────────────────────────────────────
  // The always-on ladder, distinct from the time-boxed contests above: nobody
  // launches it, it pays into the commission statement, and it is the thing a
  // rep with a cold week can still chase on a Wednesday.
  app.get("/api/me/milestones", requireCapability("field.app.use"), (req, res) => {
    const tenantId = tid(req);
    const repId = (req as any).user?.teamMemberId;
    if (tenantId == null || repId == null) {
      return res.json({ enabled: false, period: "week", periodLabel: "", rungs: [], progress: null });
    }
    res.json(repMilestoneCard(tenantId, Number(repId), Date.now()));
  });

  app.get("/api/spiff-milestones", requireCapability("commission.structure.manage"), (req, res) => {
    const tenantId = tid(req);
    if (tenantId == null) return res.status(403).json({ error: "Organization required" });
    res.json({ ladder: getLadder(tenantId), exposure: milestoneExposure(tenantId, Date.now()) });
  });

  app.put("/api/spiff-milestones", requireCapability("commission.structure.manage"), (req, res) => {
    const tenantId = tid(req);
    if (tenantId == null) return res.status(403).json({ error: "Organization required" });
    const b = req.body ?? {};
    const ladder = {
      enabled: b.enabled !== false,
      period: b.period === "day" ? "day" : "week",
      rungs: Array.isArray(b.rungs)
        ? b.rungs.map((r: any) => ({ doors: Math.trunc(Number(r?.doors)), rewardCents: Math.trunc(Number(r?.rewardCents)) }))
        : [],
    } as const;
    // ONE validator, shared with the admin form, so the server and the UI cannot
    // disagree about what a sane ladder is.
    const problem = validateLadder(ladder);
    if (problem) return res.status(400).json({ error: problem });
    const saved = setLadder(tenantId, uid(req), ladder as any);
    res.json({ ladder: saved, exposure: milestoneExposure(tenantId, Date.now()) });
  });

  // ── Momentum: the offer that arms itself when a rep goes hot ──────────────
  // The card is served even when COLD, carrying the live score, because a
  // hidden mechanic motivates nobody — a rep who watches the meter climb learns
  // what the system rewards, which is the behaviour we want more of.
  app.get("/api/me/momentum", requireCapability("field.app.use"), (req, res) => {
    const tenantId = tid(req);
    const repId = (req as any).user?.teamMemberId;
    if (tenantId == null || repId == null) {
      return res.json({ enabled: false, offer: null, score: 0 });
    }
    res.json(repMomentumCard(tenantId, Number(repId), Date.now()));
  });

  app.get("/api/spiff-momentum", requireCapability("commission.structure.manage"), (req, res) => {
    const tenantId = tid(req);
    if (tenantId == null) return res.status(403).json({ error: "Organization required" });
    res.json({ config: getMomentumConfig(tenantId), exposure: momentumExposure(tenantId, Date.now()) });
  });

  app.put("/api/spiff-momentum", requireCapability("commission.structure.manage"), (req, res) => {
    const tenantId = tid(req);
    if (tenantId == null) return res.status(403).json({ error: "Organization required" });
    const b = req.body ?? {};
    const int = (v: unknown, d: number) => (v == null ? d : Math.trunc(Number(v)));
    const current = getMomentumConfig(tenantId);
    const cfg = {
      ...current,
      enabled: b.enabled !== false,
      windowMinutes: int(b.windowMinutes, current.windowMinutes),
      offerMinutes: int(b.offerMinutes, current.offerMinutes),
      dryMinutes: int(b.dryMinutes, current.dryMinutes),
      minDoorsInWindow: int(b.minDoorsInWindow, current.minDoorsInWindow),
      minConversationsInWindow: int(b.minConversationsInWindow, current.minConversationsInWindow),
      minInterestSignals: int(b.minInterestSignals, current.minInterestSignals),
      paceRatio: b.paceRatio == null ? current.paceRatio : Number(b.paceRatio),
      armAtScore: int(b.armAtScore, current.armAtScore),
      tiers: Array.isArray(b.tiers)
        ? b.tiers.map((t: any) => ({ atScore: Math.trunc(Number(t?.atScore)), amountCents: Math.trunc(Number(t?.amountCents)) }))
        : current.tiers,
      maxOffersPerRepPerDay: int(b.maxOffersPerRepPerDay, current.maxOffersPerRepPerDay),
      maxCentsPerRepPerDay: int(b.maxCentsPerRepPerDay, current.maxCentsPerRepPerDay),
      maxCentsPerOrgPerDay: int(b.maxCentsPerOrgPerDay, current.maxCentsPerOrgPerDay),
    };
    // ONE validator, shared with the admin form.
    const problem = validateMomentumConfig(cfg);
    if (problem) return res.status(400).json({ error: problem });
    const saved = setMomentumConfig(tenantId, uid(req), cfg as any);
    res.json({ config: saved, exposure: momentumExposure(tenantId, Date.now()) });
  });

  // ── Door drops: any verified door can pay a small surprise ────────────────
  app.get("/api/me/door-drops", requireCapability("field.app.use"), (req, res) => {
    const tenantId = tid(req);
    const repId = (req as any).user?.teamMemberId;
    if (tenantId == null || repId == null) return res.json({ enabled: false, statusLine: "" });
    res.json(repDoorDropCard(tenantId, Number(repId), Date.now()));
  });

  app.get("/api/spiff-door-drops", requireCapability("commission.structure.manage"), (req, res) => {
    const tenantId = tid(req);
    if (tenantId == null) return res.status(403).json({ error: "Organization required" });
    const doors = Number(req.query.doorsPerRepPerDay);
    res.json({
      config: getDoorDropConfig(tenantId),
      exposure: doorDropExposure(tenantId, Date.now(), Number.isFinite(doors) && doors > 0 ? doors : 70),
    });
  });

  app.put("/api/spiff-door-drops", requireCapability("commission.structure.manage"), (req, res) => {
    const tenantId = tid(req);
    if (tenantId == null) return res.status(403).json({ error: "Organization required" });
    const b = req.body ?? {};
    const current = getDoorDropConfig(tenantId);
    const int = (v: unknown, d: number) => (v == null ? d : Math.trunc(Number(v)));
    try {
      const saved = setDoorDropConfig(tenantId, uid(req), {
        ...current,
        enabled: b.enabled !== false,
        oddsOneIn: int(b.oddsOneIn, current.oddsOneIn),
        pityAtDoors: int(b.pityAtDoors, current.pityAtDoors),
        minCents: int(b.minCents, current.minCents),
        maxCents: int(b.maxCents, current.maxCents),
        stepCents: int(b.stepCents, current.stepCents),
        maxPerRepPerDay: int(b.maxPerRepPerDay, current.maxPerRepPerDay),
        maxCentsPerRepPerDay: int(b.maxCentsPerRepPerDay, current.maxCentsPerRepPerDay),
        maxCentsPerOrgPerDay: int(b.maxCentsPerOrgPerDay, current.maxCentsPerOrgPerDay),
      });
      res.json({ config: saved, exposure: doorDropExposure(tenantId, Date.now()) });
    } catch (e: any) {
      res.status(e?.httpStatus === 400 ? 400 : 500).json({ error: e?.message ?? "Could not save" });
    }
  });

  // ── The genuine-day bonus: 60 real doors in a day ─────────────────────────
  // The card is served even before the rep has knocked, because the whole point
  // is that they know the number they are chasing at 9am — and it shows what
  // did NOT count and why, so a counter that credits 54 of 61 logged doors
  // reads as a rule rather than a bug.
  app.get("/api/me/door-day", requireCapability("field.app.use"), (req, res) => {
    const tenantId = tid(req);
    const repId = (req as any).user?.teamMemberId;
    if (tenantId == null || repId == null) return res.json({ enabled: false, counted: 0, target: 0 });
    res.json(repDoorDayCard(tenantId, Number(repId), Date.now()));
  });

  app.get("/api/incentives/door-day", requireCapability("commission.structure.manage"), (req, res) => {
    const tenantId = tid(req);
    if (tenantId == null) return res.status(403).json({ error: "Organization required" });
    res.json({ config: getDoorDayConfig(tenantId), exposure: doorDayExposure(tenantId, Date.now()) });
  });

  app.put("/api/incentives/door-day", requireCapability("commission.structure.manage"), (req, res) => {
    const tenantId = tid(req);
    if (tenantId == null) return res.status(403).json({ error: "Organization required" });
    const b = req.body ?? {};
    const current = getDoorDayConfig(tenantId);
    const int = (v: unknown, d: number) => (v == null ? d : Math.trunc(Number(v)));
    try {
      const saved = setDoorDayConfig(tenantId, uid(req), {
        ...current,
        enabled: b.enabled !== false,
        doors: int(b.doors, current.doors),
        rewardCents: int(b.rewardCents, current.rewardCents),
        minSpanMinutes: int(b.minSpanMinutes, current.minSpanMinutes),
        maxPerRollingHour: int(b.maxPerRollingHour, current.maxPerRollingHour),
        minGapSeconds: int(b.minGapSeconds, current.minGapSeconds),
        voidOnTamper: b.voidOnTamper !== false,
      });
      res.json({ config: saved, exposure: doorDayExposure(tenantId, Date.now()) });
    } catch (e: any) {
      res.status(e?.httpStatus === 400 ? 400 : 500).json({ error: e?.message ?? "Could not save" });
    }
  });

  // ── The ramp bonus: a new hire's first two weeks ──────────────────────────
  // Needs BOTH identities — the user id owns the training rows, the
  // team-member id gets paid — and both come from the session, never the body.
  app.get("/api/me/ramp-bonus", requireCapability("field.app.use"), (req, res) => {
    const tenantId = tid(req);
    const user = (req as any).user;
    const repId = user?.teamMemberId;
    if (tenantId == null || repId == null) return res.json({ visible: false });
    res.json(repRampCard({ tenantId, userId: Number(user.id), repId: Number(repId) }, Date.now()));
  });

  app.get("/api/incentives/ramp", requireCapability("commission.structure.manage"), (req, res) => {
    const tenantId = tid(req);
    if (tenantId == null) return res.status(403).json({ error: "Organization required" });
    res.json({ config: getRampConfig(tenantId), exposure: rampExposure(tenantId, Date.now()) });
  });

  app.put("/api/incentives/ramp", requireCapability("commission.structure.manage"), (req, res) => {
    const tenantId = tid(req);
    if (tenantId == null) return res.status(403).json({ error: "Organization required" });
    const b = req.body ?? {};
    const current = getRampConfig(tenantId);
    const int = (v: unknown, d: number) => (v == null ? d : Math.trunc(Number(v)));
    try {
      const saved = setRampConfig(tenantId, uid(req), {
        ...current,
        enabled: b.enabled !== false,
        windowDays: int(b.windowDays, current.windowDays),
        rewardCents: int(b.rewardCents, current.rewardCents),
        minCardsPerDay: int(b.minCardsPerDay, current.minCardsPerDay),
        minLessonsPerDay: int(b.minLessonsPerDay, current.minLessonsPerDay),
        minSpanMinutes: int(b.minSpanMinutes, current.minSpanMinutes),
        requireQueueCleared: b.requireQueueCleared !== false,
        completionEnabled: b.completionEnabled !== false,
        completionRewardCents: int(b.completionRewardCents, current.completionRewardCents),
        completionInWindowBonusCents: int(b.completionInWindowBonusCents, current.completionInWindowBonusCents),
      });
      res.json({ config: saved, exposure: rampExposure(tenantId, Date.now()) });
    } catch (e: any) {
      res.status(e?.httpStatus === 400 ? 400 : 500).json({ error: e?.message ?? "Could not save" });
    }
  });

  // ── The achievement ladder: the reachable sales bonus ────────────────────
  app.get("/api/me/achievements", requireCapability("field.app.use"), (req, res) => {
    const tenantId = tid(req);
    const repId = (req as any).user?.teamMemberId;
    if (tenantId == null || repId == null) return res.json({ enabled: false, daily: [], career: [] });
    res.json(repAchievementCard(tenantId, Number(repId), Date.now()));
  });

  app.get("/api/incentives/achievements", requireCapability("commission.structure.manage"), (req, res) => {
    const tenantId = tid(req);
    if (tenantId == null) return res.status(403).json({ error: "Organization required" });
    res.json({ config: getAchievementConfig(tenantId), exposure: achievementExposure(tenantId, Date.now()) });
  });

  app.put("/api/incentives/achievements", requireCapability("commission.structure.manage"), (req, res) => {
    const tenantId = tid(req);
    if (tenantId == null) return res.status(403).json({ error: "Organization required" });
    const b = req.body ?? {};
    const current = getAchievementConfig(tenantId);
    // Numbers arrive as strings from some form libraries; everything the ladder
    // branches on is coerced to an integer HERE so the engine never sees one.
    const rungs = (raw: any, fallback: typeof current.daily) => (Array.isArray(raw)
      ? raw.map((r: any) => ({ sales: Math.trunc(Number(r?.sales)), rewardCents: Math.trunc(Number(r?.rewardCents)) }))
      : fallback);
    try {
      const saved = setAchievementConfig(tenantId, uid(req), {
        ...current,
        enabled: b.enabled !== false,
        daily: rungs(b.daily, current.daily),
        career: rungs(b.career, current.career),
        excludeRampReps: b.excludeRampReps !== false,
        maxCentsPerRepPerDay: b.maxCentsPerRepPerDay == null
          ? current.maxCentsPerRepPerDay
          : Math.trunc(Number(b.maxCentsPerRepPerDay)),
      });
      res.json({ config: saved, exposure: achievementExposure(tenantId, Date.now()) });
    } catch (e: any) {
      res.status(e?.httpStatus === 400 ? 400 : 500).json({ error: e?.message ?? "Could not save" });
    }
  });

  // ── Rep surface ───────────────────────────────────────────────────────────
  // The card the rep stares at between doors. Progress is computed live from
  // knock_log/commission_sales, so it moves the moment they knock — a bar that
  // only updates on refresh does not change behaviour.
  app.get("/api/me/campaigns", requireCapability("field.app.use"), (req, res) => {
    const tenantId = tid(req);
    const repId = (req as any).user?.teamMemberId;
    // No org or no sales identity → no campaigns. Never another rep's.
    if (tenantId == null || repId == null) return res.json({ campaigns: [] });
    res.json({ campaigns: repCampaignCards(tenantId, Number(repId), Date.now()) });
  });

  // ── Manager surface ───────────────────────────────────────────────────────
  app.get("/api/spiff-campaigns", requireCapability("commission.structure.manage"), (req, res) => {
    const tenantId = tid(req);
    if (tenantId == null) return res.status(403).json({ error: "Organization required" });
    const campaigns = listCampaigns(tenantId, Date.now()).map(c => ({
      ...c,
      summary: `$${(c.rewardCents / 100).toFixed(2)} ${describeTrigger(c.trigger)}`.trim(),
      awardedCents: awardedTotal(tenantId, c.id),
    }));
    res.json({ campaigns });
  });

  app.post("/api/spiff-campaigns", requireCapability("commission.structure.manage"), (req, res) => {
    const tenantId = tid(req);
    if (tenantId == null) return res.status(403).json({ error: "Organization required" });

    const b = req.body ?? {};
    const trigger = parseTrigger(b.trigger);
    const input = {
      name: b.name,
      description: typeof b.description === "string" ? b.description.slice(0, 400) : "",
      startsAtMs: Number(b.startsAtMs),
      endsAtMs: Number(b.endsAtMs),
      trigger: trigger ?? undefined,
      rewardCents: Math.trunc(Number(b.rewardCents)),
      perRepCapCents: b.perRepCapCents == null ? 0 : Math.trunc(Number(b.perRepCapCents)),
      campaignCapCents: b.campaignCapCents == null ? 0 : Math.trunc(Number(b.campaignCapCents)),
    };
    // ONE validator, shared with the launcher form, so the server and the UI
    // cannot disagree about what a sane campaign is.
    const problem = validateCampaignInput(input as any);
    if (problem) return res.status(400).json({ error: problem });

    // A targeted campaign may only name reps in the caller's own org. A foreign
    // id is dropped rather than 404'd — the list is a filter, not a lookup, and
    // echoing "that rep is not yours" leaks another tenant's roster.
    let eligibleRepIds: number[] | null = null;
    if (Array.isArray(b.eligibleRepIds) && b.eligibleRepIds.length) {
      eligibleRepIds = b.eligibleRepIds
        .map(Number)
        .filter((n: number) => Number.isInteger(n) && n > 0)
        .filter((n: number) => (storage.getTeamMemberById(n) as any)?.tenantId === tenantId);
      if (!eligibleRepIds!.length) {
        return res.status(400).json({ error: "None of the selected reps are in your organization." });
      }
    }

    const created = createCampaign(tenantId, uid(req), {
      name: String(input.name),
      description: input.description,
      startsAtMs: input.startsAtMs,
      endsAtMs: input.endsAtMs,
      trigger: trigger!,
      rewardCents: input.rewardCents,
      eligibleRepIds,
      perRepCapCents: input.perRepCapCents,
      campaignCapCents: input.campaignCapCents,
      nowMs: Date.now(),
    });
    res.status(201).json({ campaign: created });
  });

  // Pause / resume / cancel. One handler, three verbs — the store enforces that
  // cancelled is terminal and that a finished window cannot be resumed.
  for (const [verb, next] of [["pause", "paused"], ["resume", "live"], ["cancel", "cancelled"]] as const) {
    app.post(`/api/spiff-campaigns/:id/${verb}`, requireCapability("commission.structure.manage"), (req, res) => {
      const tenantId = tid(req);
      if (tenantId == null) return res.status(403).json({ error: "Organization required" });
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid campaign id" });
      const updated = setCampaignStatus(tenantId, uid(req), id, next, Date.now());
      if (!updated) return res.status(404).json({ error: "Not found" });
      res.json({ campaign: updated });
    });
  }

  // What this promise has cost so far, live. A manager who launched "$75 a sale"
  // on a Saturday should be able to watch the bill climb before it surprises
  // them in payroll.
  app.get("/api/spiff-campaigns/:id/liability", requireCapability("commission.read.all"), (req, res) => {
    const tenantId = tid(req);
    if (tenantId == null) return res.status(403).json({ error: "Organization required" });
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid campaign id" });
    const campaign = getCampaign(tenantId, id);
    if (!campaign) return res.status(404).json({ error: "Not found" });
    res.json({ campaign, ...campaignLiability(tenantId, id) });
  });
}
