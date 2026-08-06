// ── "What have I made today" ────────────────────────────────────────────────
//
// The number a rep opens the app to see, and the one the home screen currently
// cannot answer: Today shows doors, sales and doors-left, but nothing that adds
// up to money. Each incentive card knows its own slice; nothing sums them.
//
// ── THE DESIGN DECISION THAT MATTERS: BANKED vs PENDING ────────────────────
//
// It is tempting to add "commission on today's sales" into one big number. That
// number would be wrong, and wrong in the direction that destroys trust: a sale
// closed at 2pm is not money yet. It can fail qualification, sit behind a
// holdback, or charge back. A rep who sees "$340 today" and is paid $180 on
// Friday stops believing every number in the app — including the honest ones.
//
// So this returns TWO figures and never blends them:
//
//   bankedCents   hourly time already worked + spiffs already in the ledger.
//                 Both are certain. This is the headline.
//   pendingCents  an ESTIMATE of commission on today's sales, labelled as such,
//                 and only computed when the rep's active structure is a FLAT
//                 per-sale rate. Percentage and tiered structures depend on a
//                 sale amount and a running band that this cannot know without
//                 re-implementing the commission engine — so it returns null
//                 rather than a plausible guess.
//
// A null pending is a UI that says "3 sales today" without a dollar figure.
// That is the correct outcome: no number beats a wrong number.

import { rawDb } from "./db";
import { storage } from "./storage";
import { DEFAULT_WORKWEEK, localWallToUtcMs, localYmdParts } from "@shared/workweek";
import {
  pickActiveStructure, type CommissionStructure, type Tier, type CalcType,
} from "@shared/commission";

/** commission_rates row → CommissionStructure. Mirrors rateToStructure in
 *  routes.ts; the flat amount lives in `ratePerSale`, NOT a `flatAmount`
 *  column — reading the wrong one yields a silent zero rather than an error. */
function toStructure(r: any): CommissionStructure {
  let tiers: Tier[] = [];
  try { tiers = r.tiers ? (JSON.parse(r.tiers) as Tier[]) : []; } catch { /* corrupt → none */ }
  return {
    id: r.id,
    name: r.name,
    calcType: (r.calcType ?? "flat") as CalcType,
    flatAmount: r.ratePerSale,
    percentage: r.percentage ?? 0,
    tiers,
    role: r.role ?? null,
    repId: r.repId ?? null,
    // A null effectiveFrom is legacy for "always on" — the same reading
    // rateToStructure uses. Treating it as "never" would silently zero every
    // pre-migration structure.
    effectiveFrom: r.effectiveFrom ?? "0000-01-01",
    effectiveTo: r.effectiveTo ?? null,
    version: r.version ?? 1,
    isActive: r.isActive,
  };
}

function orgTimezone(tenantId: number): string {
  try {
    const row = rawDb.prepare(`SELECT commission_timezone AS tz FROM tenants WHERE id = ?`).get(tenantId) as any;
    return row?.tz || DEFAULT_WORKWEEK.timezone;
  } catch { return DEFAULT_WORKWEEK.timezone; }
}

/** UTC bounds of the org's LOCAL day. A day that rolls over at 8pm Eastern is
 *  not "today" to anyone holding the phone. */
function localDay(tenantId: number, nowMs: number): { startIso: string; endIso: string; ymd: string } {
  const tz = orgTimezone(tenantId);
  const { y, mo, d } = localYmdParts(nowMs, tz);
  const startMs = localWallToUtcMs(y, mo, d, 0, 0, tz);
  return {
    startIso: new Date(startMs).toISOString(),
    endIso: new Date(startMs + 86_400_000).toISOString(),
    ymd: `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
  };
}

export interface EarningsToday {
  /** Certain money: hourly worked + spiffs already awarded. The headline. */
  bankedCents: number;
  hourlyCents: number;
  hourlyMinutes: number;
  spiffCents: number;
  /** Sales closed today (verified, not superseded). */
  salesToday: number;
  /**
   * Estimated commission on those sales, or null when it cannot be known
   * honestly. NEVER folded into bankedCents.
   */
  pendingCents: number | null;
  /** Why pending is null, for the UI to say something useful. */
  pendingBasis: "flat" | "unknown_structure" | "needs_sale_amounts" | "no_sales";
  /**
   * Downline override earnings booked today for this member as an UPLINE
   * (net of same-day clawbacks). Pending by nature — the downline sale can
   * still reverse or charge back — so it is its own labelled figure, folded
   * into neither bankedCents nor pendingCents. 0 for members with no downline.
   */
  overridePendingCents: number;
}

/** Minutes clocked today, including an OPEN session counted up to now — a rep
 *  four hours into a shift has earned four hours, not zero. */
function hourlyToday(repId: number, ymd: string, nowMs: number): number {
  const rows = rawDb.prepare(
    `SELECT clocked_in, clocked_out, duration_minutes FROM clock_sessions
      WHERE rep_id = ? AND date = ?`,
  ).all(repId, ymd) as any[];

  let minutes = 0;
  for (const r of rows) {
    if (r.duration_minutes != null) { minutes += Number(r.duration_minutes) || 0; continue; }
    const started = Date.parse(r.clocked_in);
    if (!Number.isFinite(started)) continue;
    const ended = r.clocked_out ? Date.parse(r.clocked_out) : nowMs;
    if (!Number.isFinite(ended) || ended <= started) continue;
    minutes += Math.floor((ended - started) / 60_000);
  }
  return minutes;
}

function hourlyRateCents(repId: number): number {
  try {
    const row = rawDb.prepare(
      `SELECT hourly_rate_cents AS c FROM team_members WHERE id = ?`,
    ).get(repId) as any;
    return Math.max(0, Math.trunc(Number(row?.c ?? 0) || 0));
  } catch { return 0; }
}

/** Spiffs awarded today — campaigns, milestones, momentum and door drops all
 *  land here, which is exactly why they share one ledger. */
function spiffsToday(tenantId: number, repId: number, startIso: string, endIso: string): number {
  const row = rawDb.prepare(
    `SELECT COALESCE(SUM(amount_cents), 0) AS c FROM spiffs
      WHERE tenant_id = ? AND rep_id = ?
        AND status IN ('earned','approved','paid')
        AND created_at >= ? AND created_at < ?`,
  ).get(tenantId, repId, startIso, endIso) as any;
  return Math.max(0, Number(row?.c ?? 0));
}

/** Net override cents booked today for this beneficiary. PAYABLE rows only —
 *  HELD money is inside an install hold and EXCEPTION money needs a human;
 *  quoting either as "today's earnings" would promise pay that may never come. */
function overridesToday(tenantId: number, repId: number, startIso: string, endIso: string): number {
  try {
    const row = rawDb.prepare(
      `SELECT COALESCE(SUM(amount_cents), 0) AS c FROM commission_overrides
        WHERE tenant_id = ? AND beneficiary_rep_id = ?
          AND status = 'PAYABLE' AND created_at >= ? AND created_at < ?`,
    ).get(tenantId, repId, startIso, endIso) as any;
    return Number(row?.c ?? 0);
  } catch { return 0; } // table self-creates on overrideStore import — absent ⇒ no overrides
}

function salesToday(tenantId: number, repId: number, startIso: string, endIso: string): number {
  const row = rawDb.prepare(
    `SELECT COUNT(*) AS n FROM knock_log k
       JOIN leads l ON l.id = k.lead_id
      WHERE k.rep_id = ? AND l.tenant_id = ?
        AND k.outcome = 'sold' AND COALESCE(k.superseded, 0) = 0
        AND k.knocked_at >= ? AND k.knocked_at < ?`,
  ).get(repId, tenantId, startIso, endIso) as any;
  return Math.max(0, Number(row?.n ?? 0));
}

export function earningsToday(tenantId: number, repId: number, nowMs: number): EarningsToday {
  const { startIso, endIso, ymd } = localDay(tenantId, nowMs);

  const hourlyMinutes = hourlyToday(repId, ymd, nowMs);
  const rate = hourlyRateCents(repId);
  const hourlyCents = Math.round((hourlyMinutes / 60) * rate);
  const spiffCents = spiffsToday(tenantId, repId, startIso, endIso);
  const sales = salesToday(tenantId, repId, startIso, endIso);

  let pendingCents: number | null = null;
  let pendingBasis: EarningsToday["pendingBasis"] = "no_sales";

  if (sales > 0) {
    pendingBasis = "unknown_structure";
    try {
      const member = storage.getTeamMemberById(repId);
      const today = new Date(nowMs).toISOString().slice(0, 10);
      // pickActiveStructure is the SAME selection the knock handler uses when it
      // records a sale's commission (shared/commission.ts, already tested).
      // Re-implementing rep-beats-role and the effective-date window here would
      // be a second answer to a question that already has one, and the two would
      // drift the first time either changed.
      const structures = storage.getCommissionRates(tenantId).map(toStructure);
      const active = pickActiveStructure(structures, repId, member?.role ?? null, today);

      if (active) {
        if (active.calcType === "flat") {
          // flatAmount is DOLLARS per sale; money on the wire is integer cents.
          const perSale = Math.round((Number(active.flatAmount) || 0) * 100);
          if (perSale > 0) {
            pendingCents = perSale * sales;
            pendingBasis = "flat";
          }
        } else {
          // Percentage and tiered both need the sale AMOUNT, and tiered also
          // needs the rep's running total within the band. Deriving either here
          // would be a second commission engine that could disagree with the
          // real one — so it says it does not know rather than guessing.
          pendingBasis = "needs_sale_amounts";
        }
      }
    } catch { /* an estimate must never break the home screen */ }
  }

  return {
    bankedCents: hourlyCents + spiffCents,
    hourlyCents, hourlyMinutes, spiffCents,
    salesToday: sales,
    pendingCents, pendingBasis,
    overridePendingCents: overridesToday(tenantId, repId, startIso, endIso),
  };
}
