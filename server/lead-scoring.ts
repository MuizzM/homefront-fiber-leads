/**
 * Smart Lead Scoring — HomeFront Fiber
 *
 * Automatically tags and scores every lead based on Kinetic API response fields.
 *
 * Score: 0–100
 * Tags:
 *   "hot_lead"       — NEW FIBER + billingStatus=N (no subscriber, fresh fiber, BEST)
 *   "coming_soon"    — NEW FIBER + billingStatus=Y (has subscriber — might be new install by them)
 *   "upgrade_target" — TENURED + billingStatus=N (long-established fiber, non-subscriber)
 *   null             — everything else (copper/DSL, no service)
 */

import { isActiveBilling } from "@shared/billingStatus";

export interface LeadScoreResult {
  leadTag: string | null;
  leadScore: number;
  priority: "critical" | "high" | "medium" | "low";
  reason: string;
}

export function scoreLead(params: {
  householdSegmentType: string | null;
  billingStatus: string | null;
  techType: string | null;
  maxDownloadMbps: number | null;
  competitorName: string | null;
  inCompetitorArea?: boolean;
  addressCatalogDate?: string | null; // when address entered Kinetic fabric
}): LeadScoreResult {
  const {
    householdSegmentType: segment,
    billingStatus,
    techType,
    maxDownloadMbps,
    competitorName,
    inCompetitorArea,
    addressCatalogDate,
  } = params;

  // ── HOT LEAD: NEW FIBER + no subscriber (billingStatus N) ────────────────────
  // This is the crown jewel — fresh fiber build, nobody has service yet.
  if (segment === "NEW FIBER" && billingStatus === "N") {
    let score = 90;

    // Bonus: FTTP is better than FTTN
    if (techType === "FIBER") score = Math.min(100, score + 5);

    // Bonus: higher speed = better infrastructure
    if (maxDownloadMbps && maxDownloadMbps >= 1000) score = Math.min(100, score + 3);

    // Bonus: competitor present = motivated prospect (they want something better)
    if (competitorName) score = Math.min(100, score + 2);

    // Bonus: recently added to Kinetic fabric (within 90 days)
    if (addressCatalogDate) {
      const daysSince = Math.floor((Date.now() - new Date(addressCatalogDate).getTime()) / 86400000);
      if (daysSince <= 90) score = Math.min(100, score + 5);
    }

    return {
      leadTag: "hot_lead",
      leadScore: score,
      priority: "critical",
      reason: `NEW FIBER deployment, no existing subscriber. ${competitorName ? `Competitor: ${competitorName}.` : ""} Score: ${score}.`,
    };
  }

  // ── COMING SOON: NEW FIBER + has subscriber ──────────────────────────────────
  // Someone already has service here — likely a new customer on a newly built line.
  // Still worth knocking — they may want to upgrade speed tier or it's a household with multiple adults.
  if (segment === "NEW FIBER" && isActiveBilling(billingStatus)) {
    let score = 60;
    if (techType === "FIBER") score += 5;

    return {
      leadTag: "coming_soon",
      leadScore: score,
      priority: "high",
      reason: `NEW FIBER — has existing subscriber. Potential for upgrades or multi-household. Score: ${score}.`,
    };
  }

  // ── UPGRADE TARGET: TENURED + no subscriber ──────────────────────────────────
  // Long-established fiber address, but resident hasn't signed up.
  // These are "warm" leads — fiber exists, nobody took it. Classic door knock scenario.
  if (segment === "TENURED" && billingStatus === "N") {
    let score = 70;
    if (maxDownloadMbps && maxDownloadMbps >= 500) score += 5;
    if (competitorName) score += 5; // actively comparing services
    if (inCompetitorArea) score -= 10; // competitor territory suppression

    return {
      leadTag: "upgrade_target",
      leadScore: Math.max(0, score),
      priority: "high",
      reason: `TENURED fiber, non-subscriber. Long-established fiber at this address — prime upgrade candidate. Score: ${Math.max(0, score)}.`,
    };
  }

  // ── TENURED + subscriber — low priority ──────────────────────────────────────
  if (segment === "TENURED" && isActiveBilling(billingStatus)) {
    return {
      leadTag: null,
      leadScore: 20,
      priority: "low",
      reason: "TENURED fiber, existing subscriber. Customer already on Kinetic.",
    };
  }

  // ── Copper / DSL / no service ─────────────────────────────────────────────────
  const isFiber = techType === "FIBER" || (maxDownloadMbps !== null && maxDownloadMbps >= 300);
  if (!isFiber) {
    return {
      leadTag: null,
      leadScore: 5,
      priority: "low",
      reason: `Non-fiber address. Tech: ${techType ?? "unknown"}. Max: ${maxDownloadMbps ?? 0} Mbps.`,
    };
  }

  // ── Other fiber (PROSPECT, unknown segment) ────────────────────────────────
  return {
    leadTag: null,
    leadScore: 40,
    priority: "medium",
    reason: `Fiber available. Segment: ${segment ?? "unknown"}. billingStatus: ${billingStatus ?? "unknown"}.`,
  };
}
