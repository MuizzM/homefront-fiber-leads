import { rawDb } from "./db";
import { startCitySweep } from "./sweepService";
import { getDefaultTenantId } from "./storage";
import { structuredLog } from "./structuredLog";

// EXPLORE_CITIES — ground-truth serviceability probes for rumored Kinetic
// territory that is NOT in the verified market catalog ("I heard there's
// Kinetic fiber near X"). Each listed city gets a bounded city sweep (OSM
// address harvest → Decodo-only qualification); the classifier verdicts are
// the evidence that promotes the city into the catalog — or rules it out.
//
// Spec: EXPLORE_CITIES="durham:nc,chapel hill:nc" (state defaults to NC).
// Idempotent per city: a city is skipped while any city sweep for it is
// running, or if one started within EXPLORE_REPEAT_HOURS (default 168 = 7d).
// At most EXPLORE_STARTS_PER_TICK (default 2) new sweeps start per tick so
// concurrent OSM harvests stay polite; the 15-minute cycle walks the rest of
// the list automatically. Checks per city bounded by EXPLORE_MAX_CHECKS
// (default 2500) — enough for a decisive served/unserved verdict without
// committing a full sweep to unverified territory; catalog promotion buys the
// full-coverage cadence afterwards.

export interface ExploreCity { city: string; state: "NC" | "SC" }
export interface ExploreDecision extends ExploreCity {
  action: "started" | "skipped_running" | "skipped_recent" | "deferred_tick_cap";
  sweepId?: string;
}

const EXPLORE_STATES = new Set(["NC", "SC"]);

export function parseExploreSpec(spec: string | undefined): ExploreCity[] {
  const seen = new Set<string>();
  const out: ExploreCity[] = [];
  for (const entry of String(spec ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const [cityRaw, stateRaw = "nc"] = entry.split(":").map((s) => s.trim());
    const city = cityRaw.toLowerCase();
    const state = stateRaw.toUpperCase();
    if (!city || !EXPLORE_STATES.has(state)) continue;
    const key = `${city}|${state}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ city, state: state as "NC" | "SC" });
  }
  return out;
}

export function runExploreBurst(
  env: NodeJS.ProcessEnv = process.env,
  start: typeof startCitySweep = startCitySweep,
  tenantId: number | null = getDefaultTenantId(),
): ExploreDecision[] {
  const cities = parseExploreSpec(env.EXPLORE_CITIES);
  if (!cities.length || tenantId == null) return [];
  const repeatHours = Math.max(1, Number(env.EXPLORE_REPEAT_HOURS ?? 168) || 168);
  const startsPerTick = Math.max(1, Number(env.EXPLORE_STARTS_PER_TICK ?? 2) || 2);
  const maxChecks = Math.max(200, Number(env.EXPLORE_MAX_CHECKS ?? 2500) || 2500);
  const recent = rawDb.prepare(
    `SELECT status FROM sweep_jobs
      WHERE kind='city' AND tenant_id=? AND lower(city)=? AND lower(state)=lower(?)
        AND (status='running' OR started_at > datetime('now', ?))
      ORDER BY (status='running') DESC LIMIT 1`,
  );
  const decisions: ExploreDecision[] = [];
  let started = 0;
  for (const c of cities) {
    const prior = recent.get(tenantId, c.city, c.state, `-${repeatHours} hours`) as { status: string } | undefined;
    if (prior) {
      decisions.push({ ...c, action: prior.status === "running" ? "skipped_running" : "skipped_recent" });
      continue;
    }
    if (started >= startsPerTick) {
      decisions.push({ ...c, action: "deferred_tick_cap" });
      continue;
    }
    const job = start({ tenantId, city: c.city, state: c.state, maxChecks });
    started += 1;
    decisions.push({ ...c, action: "started", sweepId: job.id });
    structuredLog("explore_city.started", { city: c.city, state: c.state, sweepId: job.id, maxChecks });
  }
  if (decisions.some((d) => d.action === "started")) {
    structuredLog("explore_city.tick", {
      started,
      deferred: decisions.filter((d) => d.action === "deferred_tick_cap").length,
      skipped: decisions.filter((d) => d.action.startsWith("skipped")).length,
    });
  }
  return decisions;
}

export function startExploreCycle(env: NodeJS.ProcessEnv = process.env): void {
  if (!parseExploreSpec(env.EXPLORE_CITIES).length) return;
  const tick = () => {
    try { runExploreBurst(env); } catch (e: any) { console.warn("[explore-cities] tick skipped:", e?.message); }
  };
  // Stagger past boot (web settles + token pool warms), then walk the list.
  const first = setTimeout(tick, 3 * 60_000);
  if (typeof (first as any).unref === "function") (first as any).unref();
  const cycle = setInterval(tick, 15 * 60_000);
  if (typeof (cycle as any).unref === "function") (cycle as any).unref();
}
