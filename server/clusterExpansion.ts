// ── Lead-triggered CRITICAL cluster expansion ─────────────────────────────────
// The revenue engine: the instant an address is confirmed a green FRESH_LEAD, we
// fan out CRITICAL availability checks OUTWARD from it by distance + lead density —
// nearest streets first, then the subdivision / ZIP, then adjacent corridors and
// nearby towns — following green leads as they appear and stopping after a
// configurable number of consecutive empty rings. Every address, check, lead, and
// expansion job is deduplicated; the originating lead + cluster chain is persisted
// so we can see which green lead discovered each cluster.
//
// It REUSES the existing pipeline: address inventory (scan_targets, continuously
// fed by the statewide sweep + New Build Radar's OSM/NC-OneMap discovery) plus a
// live OSM ring pull for addresses not yet in inventory, then enqueues through the
// SAME scanService.startTargetRun → Kinetic/Decodo worker under a CRITICAL run
// kind. Nothing here mints or searches; the shared Decodo-only transport does.
import { rawDb } from "./db";
import { storage, getDefaultTenantId } from "./storage";
import { startTargetRun } from "./scanService";
import { normalizeKineticAddressKey } from "./scanner";
import { haversineMeters } from "@shared/knock";
import { pullAddressesFromOverpass } from "./overpass";
import { structuredLog } from "./structuredLog";
import crypto from "node:crypto";

const CFG = {
  enabled: () => process.env.EXPANSION_ENABLED !== "off",
  ringM: () => bounded(process.env.EXPANSION_RING_M, 800, 100, 5000),          // ring width (~0.5mi)
  maxRings: () => bounded(process.env.EXPANSION_MAX_RINGS, 6, 1, 40),
  maxEmptyRings: () => bounded(process.env.EXPANSION_MAX_EMPTY_RINGS, 2, 1, 20), // stop after N empty rings
  ringBudget: () => bounded(process.env.EXPANSION_RING_BUDGET, 60, 5, 500),      // addresses/ring cap
  recheckMs: () => bounded(process.env.EXPANSION_RECHECK_MS, 6 * 3600_000, 60_000, 30 * 24 * 3600_000),
  // Concurrent active expansions. Each holds one in-flight CRITICAL run, so an
  // unbounded value lets expansion crowd the CRITICAL admission pool and slow the
  // core pipeline (address discovery, Field Map, manual checks). Kept low; excess
  // clusters are paused (not lost) and resumed as capacity frees.
  maxActive: () => bounded(process.env.EXPANSION_MAX_ACTIVE, 8, 1, 500),
  osm: () => process.env.EXPANSION_OSM !== "off",
  tickMs: () => bounded(process.env.EXPANSION_TICK_MS, 20_000, 3_000, 120_000),
};
function bounded(v: string | undefined, dflt: number, min: number, max: number): number {
  const n = Number(v); return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : dflt;
}

let _ready = false;
function ensureSchema(): void {
  if (_ready) return;
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS lead_expansions (
      id TEXT PRIMARY KEY,
      tenant_id INTEGER,
      origin_lead_id INTEGER, origin_target_id INTEGER,
      origin_address TEXT, origin_city TEXT, origin_state TEXT, origin_zip TEXT,
      origin_lat REAL, origin_lng REAL,
      status TEXT NOT NULL DEFAULT 'active',
      ring INTEGER NOT NULL DEFAULT 0,
      empty_streak INTEGER NOT NULL DEFAULT 0,
      addresses_checked INTEGER NOT NULL DEFAULT 0,
      fresh_found INTEGER NOT NULL DEFAULT 0,
      radius_m INTEGER NOT NULL DEFAULT 0,
      last_run_id TEXT, last_ring_size INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_expansion_status ON lead_expansions(status, updated_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_expansion_origin ON lead_expansions(origin_target_id);
    CREATE TABLE IF NOT EXISTS expansion_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      expansion_id TEXT NOT NULL,
      target_id INTEGER, address_key TEXT NOT NULL, address TEXT,
      distance_m INTEGER, ring INTEGER,
      became_lead INTEGER NOT NULL DEFAULT 0, lead_id INTEGER,
      created_at INTEGER NOT NULL,
      UNIQUE(expansion_id, address_key)
    );
    CREATE INDEX IF NOT EXISTS idx_expmember_key ON expansion_members(address_key);
    CREATE INDEX IF NOT EXISTS idx_expmember_exp ON expansion_members(expansion_id);
  `);
  _ready = true;
}

interface LeadSeed {
  targetId: number; leadId: number | null;
  address: string; city: string; state: string; zip: string;
  lat: number; lng: number;
}

// ── Trigger: an address just became a confirmed green FRESH_LEAD ───────────────
// Idempotent + deduplicated: never spawns a second expansion for the same origin,
// and if this lead was itself discovered by a nearby active cluster it EXTENDS that
// cluster (resets its empty streak) rather than starting a competing job.
export function onFreshLead(tenantId: number, seed: LeadSeed): { expansionId: string | null; action: string } {
  if (!CFG.enabled()) return { expansionId: null, action: "disabled" };
  ensureSchema();
  const now = Date.now();
  const key = normalizeKineticAddressKey(seed.address, seed.city, seed.state, seed.zip);

  // If this lead is already an active expansion origin → nothing to do.
  const existingOrigin = rawDb.prepare(`SELECT id FROM lead_expansions WHERE origin_target_id=?`).get(seed.targetId) as any;
  if (existingOrigin) return { expansionId: existingOrigin.id, action: "origin_exists" };

  // If this lead was discovered by an ACTIVE nearby cluster, it is already covered:
  // record it in that cluster's chain and reset its empty streak (density found →
  // keep expanding OUTWARD from the parent's frontier). Do NOT spawn a competing,
  // overlapping expansion — that is the "no duplicate active expansion jobs" rule.
  // A genuinely-new green lead beyond every active cluster's reach seeds its own.
  const member = rawDb.prepare(`SELECT em.expansion_id FROM expansion_members em
    JOIN lead_expansions e ON e.id=em.expansion_id
    WHERE em.address_key=? AND e.status='active' LIMIT 1`).get(key) as any;
  if (member) {
    rawDb.prepare(`UPDATE expansion_members SET became_lead=1, lead_id=? WHERE expansion_id=? AND address_key=?`).run(seed.leadId, member.expansion_id, key);
    rawDb.prepare(`UPDATE lead_expansions SET empty_streak=0, fresh_found=fresh_found+1, updated_at=? WHERE id=?`).run(now, member.expansion_id);
    return { expansionId: member.expansion_id, action: "attached" };
  }

  if (activeCount() >= CFG.maxActive()) return { expansionId: null, action: "at_active_cap" };

  const id = `exp_${tenantId}_${now.toString(36)}_${crypto.randomBytes(2).toString("hex")}`;
  rawDb.prepare(`INSERT INTO lead_expansions
    (id,tenant_id,origin_lead_id,origin_target_id,origin_address,origin_city,origin_state,origin_zip,origin_lat,origin_lng,status,ring,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?, 'active', 0, ?, ?)`)
    .run(id, tenantId, seed.leadId, seed.targetId, seed.address, seed.city, seed.state, seed.zip, seed.lat, seed.lng, now, now);
  // Kick off ring 0 immediately — nearest addresses first.
  void expandRing(id).catch((e) => structuredLog("expansion.ring_failed", { id, ring: 0, error: String(e?.message ?? e).slice(0, 120) }, "warn"));
  structuredLog("expansion.started", { id, origin: `${seed.address}, ${seed.city} ${seed.state}`, leadId: seed.leadId }, "info");
  return { expansionId: id, action: "started" };
}

function activeCount(): number {
  return Number((rawDb.prepare(`SELECT COUNT(*) c FROM lead_expansions WHERE status='active'`).get() as any).c);
}

// Ring discovery awaits OSM, so guard against the tick advancing (or re-entering)
// an expansion while its current ring is still being discovered + enqueued.
const _expanding = new Set<string>();

// ── Ring discovery + enqueue (CRITICAL) ───────────────────────────────────────
async function expandRing(expansionId: string): Promise<void> {
  ensureSchema();
  if (_expanding.has(expansionId)) return;
  _expanding.add(expansionId);
  try {
    await expandRingInner(expansionId);
  } finally {
    _expanding.delete(expansionId);
  }
}

async function expandRingInner(expansionId: string): Promise<void> {
  const exp = rawDb.prepare(`SELECT * FROM lead_expansions WHERE id=?`).get(expansionId) as any;
  if (!exp || exp.status !== "active") return;
  const ring = exp.ring;
  const inner = ring * CFG.ringM();
  const outer = (ring + 1) * CFG.ringM();
  const origin = { lat: exp.origin_lat, lng: exp.origin_lng };
  // Degrees per meter (lat ~111.32km/deg; lng scaled by cos(lat)).
  const dLat = outer / 111_320;
  const dLng = outer / (111_320 * Math.max(0.2, Math.cos((origin.lat * Math.PI) / 180)));
  const box = { minLat: origin.lat - dLat, maxLat: origin.lat + dLat, minLng: origin.lng - dLng, maxLng: origin.lng + dLng };

  // 1) Inventory candidates in the ring bbox (reuse the existing address pool).
  const invRows = rawDb.prepare(`SELECT id,address,city,state,zip,lat,lng,last_scanned_at FROM scan_targets
    WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?`).all(box.minLat, box.maxLat, box.minLng, box.maxLng) as any[];

  // 2) OSM ring pull for addresses not yet in inventory (upsert new ones).
  let osmRows: Array<{ address: string; city: string; state: string; zip: string; lat: number; lng: number }> = [];
  if (CFG.osm()) {
    try {
      osmRows = await pullAddressesFromOverpass(
        { south: box.minLat, west: box.minLng, north: box.maxLat, east: box.maxLng },
        exp.origin_city || "", exp.origin_state || "NC",
      );
    } catch { /* OSM best-effort; inventory still drives the ring */ }
    if (osmRows.length) {
      storage.upsertScanTargets(osmRows.map((a) => ({
        address: a.address, city: a.city, state: a.state, zip: a.zip, lat: a.lat, lng: a.lng,
        source: "lead_expansion", tenantId: exp.tenant_id,
        canonicalKey: normalizeKineticAddressKey(a.address, a.city, a.state, a.zip),
      })));
    }
  }

  // Merge candidates by normalized key, compute ring distance, dedup vs recency +
  // this expansion's existing members, order nearest-first, cap the ring budget.
  const recheckCut = Date.now() - CFG.recheckMs();
  const originKey = normalizeKineticAddressKey(exp.origin_address || "", exp.origin_city || "", exp.origin_state || "", exp.origin_zip || "");
  const seen = new Set<string>();
  const already = new Set<string>(
    (rawDb.prepare(`SELECT address_key FROM expansion_members WHERE expansion_id=?`).all(expansionId) as any[]).map((r) => r.address_key),
  );
  // Never re-check the origin lead itself.
  seen.add(originKey);
  type Cand = { targetId: number | null; key: string; address: string; city: string; state: string; zip: string; lat: number; lng: number; dist: number; lastMs: number | null };
  const cands: Cand[] = [];
  const addCand = (r: { id?: number; address: string; city: string; state: string; zip: string; lat: number | null; lng: number | null; lastScanned?: string | null }) => {
    if (r.lat == null || r.lng == null) return;
    const key = normalizeKineticAddressKey(r.address, r.city, r.state, r.zip ?? "");
    if (seen.has(key) || already.has(key)) return;
    const dist = haversineMeters(origin, { lat: r.lat, lng: r.lng });
    if (dist < inner || dist >= outer) return; // strictly this ring
    seen.add(key);
    const lastMs = r.lastScanned ? Date.parse(String(r.lastScanned).includes("T") ? r.lastScanned : `${r.lastScanned}Z`) : null;
    cands.push({ targetId: r.id ?? null, key, address: r.address, city: r.city, state: r.state, zip: r.zip ?? "", lat: r.lat, lng: r.lng, dist, lastMs });
  };
  for (const r of invRows) addCand({ id: r.id, address: r.address, city: r.city, state: r.state, zip: r.zip, lat: r.lat, lng: r.lng, lastScanned: r.last_scanned_at });
  for (const a of osmRows) addCand({ address: a.address, city: a.city, state: a.state, zip: a.zip, lat: a.lat, lng: a.lng });

  // Dedup vs recent conclusive checks — don't re-spend on a just-checked address.
  const fresh = cands.filter((c) => c.lastMs == null || c.lastMs < recheckCut);
  fresh.sort((a, b) => a.dist - b.dist); // nearest first
  const chosen = fresh.slice(0, CFG.ringBudget());

  if (chosen.length === 0) {
    // Empty ring — advance the stop counter; the tick will decide to stop/continue.
    rawDb.prepare(`UPDATE lead_expansions SET last_run_id=NULL, last_ring_size=0, radius_m=?, updated_at=? WHERE id=?`).run(outer, Date.now(), expansionId);
    return;
  }

  // Resolve/ensure scan_targets ids (OSM rows were upserted above).
  const idOf = rawDb.prepare(`SELECT id FROM scan_targets WHERE lower(address)=lower(?) LIMIT 1`);
  const targetIds: number[] = [];
  const now = Date.now();
  const insMember = rawDb.prepare(`INSERT OR IGNORE INTO expansion_members (expansion_id,target_id,address_key,address,distance_m,ring,created_at) VALUES (?,?,?,?,?,?,?)`);
  const tx = rawDb.transaction(() => {
    for (const c of chosen) {
      let tid = c.targetId;
      if (!tid) { const row = idOf.get(c.address) as any; tid = row?.id ?? null; }
      if (!tid) continue;
      targetIds.push(tid);
      insMember.run(expansionId, tid, c.key, `${c.address}, ${c.city}`, Math.round(c.dist), ring, now);
    }
  });
  tx();
  if (!targetIds.length) return;

  // Enqueue as CRITICAL (runKind 'lead_expansion' → new_build priority tier).
  let runId: string | null = null;
  try {
    const run = startTargetRun({
      tenantId: exp.tenant_id, city: exp.origin_city || exp.origin_state || "", state: exp.origin_state || "NC",
      targetIds, runKind: "lead_expansion", label: `Expansion r${ring} · ${exp.origin_address}`,
    });
    runId = run.runId;
  } catch (e: any) {
    structuredLog("expansion.enqueue_failed", { id: expansionId, error: String(e?.message ?? e).slice(0, 120) }, "warn");
  }
  rawDb.prepare(`UPDATE lead_expansions SET last_run_id=?, last_ring_size=?, radius_m=?, addresses_checked=addresses_checked+?, updated_at=? WHERE id=?`)
    .run(runId, targetIds.length, outer, targetIds.length, Date.now(), expansionId);
  structuredLog("expansion.ring", { id: expansionId, ring, enqueued: targetIds.length, radiusM: outer, runId }, "info");
}

// ── Tick: advance rings, apply the stop condition ─────────────────────────────
// For each active expansion whose current ring's run has drained, count the new
// leads it produced; if none → empty_streak++. Stop after maxEmptyRings or maxRings;
// otherwise expand the next (larger) ring outward.
// Keep concurrent active expansions at or below maxActive. Excess (least-productive
// first: fewest fresh leads, then oldest touch) is PAUSED — not lost — and its
// in-flight CRITICAL run is cancelled so its worker stops and its admission slots
// free for the core pipeline. Paused clusters resume when capacity opens. This is
// what winds the runaway (78 concurrent lead_expansion runs) back down to the cap.
function enforceActiveCap(): void {
  const cap = CFG.maxActive();
  const active = rawDb.prepare(`SELECT id, last_run_id FROM lead_expansions WHERE status='active' ORDER BY fresh_found ASC, updated_at ASC`).all() as any[];
  if (active.length <= cap) return;
  const excess = active.slice(cap);
  const now = Date.now();
  let cancelledRuns = 0;
  const tx = rawDb.transaction(() => {
    for (const e of excess) {
      rawDb.prepare(`UPDATE lead_expansions SET status='paused', updated_at=? WHERE id=?`).run(now, e.id);
      if (e.last_run_id) {
        const r = rawDb.prepare(`UPDATE scan_runs SET status='cancelled' WHERE id=? AND status='running'`).run(e.last_run_id);
        cancelledRuns += r.changes;
      }
    }
  });
  tx();
  structuredLog("expansion.capped", { cap, paused: excess.length, cancelledRuns }, "warn");
}

// When capacity frees, resume the oldest paused clusters (re-run their current ring;
// enqueue/check dedup makes re-entry safe). Bounded by open slots so we never exceed cap.
function resumePausedIfCapacity(): void {
  const cap = CFG.maxActive();
  const slots = cap - activeCount();
  if (slots <= 0) return;
  const paused = rawDb.prepare(`SELECT id FROM lead_expansions WHERE status='paused' ORDER BY updated_at ASC LIMIT ?`).all(slots) as any[];
  if (!paused.length) return;
  const now = Date.now();
  for (const p of paused) {
    rawDb.prepare(`UPDATE lead_expansions SET status='active', last_run_id=NULL, updated_at=? WHERE id=?`).run(now, p.id);
  }
  structuredLog("expansion.resumed", { resumed: paused.length }, "info");
}

export async function expansionTick(): Promise<void> {
  if (!CFG.enabled()) return;
  ensureSchema();
  enforceActiveCap();       // shed runaway first so the pipeline breathes
  resumePausedIfCapacity(); // then backfill freed slots from the paused backlog
  const active = rawDb.prepare(`SELECT * FROM lead_expansions WHERE status='active' ORDER BY updated_at ASC LIMIT 20`).all() as any[];
  for (const exp of active) {
    if (_expanding.has(exp.id)) continue; // its ring is still being discovered/enqueued
    // If a ring is in flight, wait until its run drains (all targets conclusive).
    if (exp.last_run_id) {
      const run = rawDb.prepare(`SELECT status,verified,failed,budget FROM scan_runs WHERE id=?`).get(exp.last_run_id) as any;
      const drained = !run || run.status !== "running" || (Number(run.verified) + Number(run.failed) >= Number(run.budget));
      if (!drained) continue;
    }
    // Count leads this ring's members produced (became_lead set by onFreshLead).
    // A ring that yields no new green leads — whether it had addresses that came
    // back not-fresh, or was simply empty — advances the stop counter.
    const ringLeads = Number((rawDb.prepare(`SELECT COUNT(*) c FROM expansion_members WHERE expansion_id=? AND ring=? AND became_lead=1`).get(exp.id, exp.ring) as any).c);
    const emptyStreak = ringLeads > 0 ? 0 : exp.empty_streak + 1;
    const nextRing = exp.ring + 1;
    const stop = emptyStreak >= CFG.maxEmptyRings() || nextRing >= CFG.maxRings();
    if (stop) {
      rawDb.prepare(`UPDATE lead_expansions SET status='exhausted', empty_streak=?, updated_at=? WHERE id=?`).run(emptyStreak, Date.now(), exp.id);
      structuredLog("expansion.exhausted", { id: exp.id, rings: exp.ring + 1, fresh: exp.fresh_found, emptyStreak }, "info");
      continue;
    }
    rawDb.prepare(`UPDATE lead_expansions SET ring=?, empty_streak=?, last_run_id=NULL, updated_at=? WHERE id=?`).run(nextRing, emptyStreak, Date.now(), exp.id);
    await expandRing(exp.id).catch((e) => structuredLog("expansion.ring_failed", { id: exp.id, ring: nextRing, error: String(e?.message ?? e).slice(0, 120) }, "warn"));
  }
}

let _timer: ReturnType<typeof setInterval> | null = null;
export function startExpansionEngine(): void {
  if (_timer || !CFG.enabled()) return;
  ensureSchema();
  // Shed any runaway from before this boot immediately (a prior process may have
  // left dozens of active expansions holding CRITICAL runs) so the core pipeline
  // regains admission headroom on deploy instead of waiting for the first tick.
  try { enforceActiveCap(); } catch (e: any) { structuredLog("expansion.boot_cap_failed", { error: String(e?.message ?? e).slice(0, 120) }, "warn"); }
  _timer = setInterval(() => { void expansionTick().catch(() => {}); }, CFG.tickMs());
  if (typeof (_timer as any).unref === "function") (_timer as any).unref();
  structuredLog("expansion.engine_started", { tickMs: CFG.tickMs(), ringM: CFG.ringM(), maxRings: CFG.maxRings(), maxEmptyRings: CFG.maxEmptyRings() }, "info");
}
export function stopExpansionEngine(): void { if (_timer) { clearInterval(_timer); _timer = null; } }

// Called from the scan engine right after projectConfirmedFreshLeads: any of the
// just-checked targets that are now green (new_fiber + billing N) seed expansion.
export function triggerExpansionForTargets(tenantId: number, targetIds: number[]): number {
  if (!CFG.enabled() || !targetIds.length) return 0;
  ensureSchema();
  const rows = rawDb.prepare(`SELECT id,address,city,state,zip,lat,lng,converted_to_lead_id lead FROM scan_targets
    WHERE id IN (${targetIds.map(() => "?").join(",")})
      AND last_fiber_status='new_fiber' AND last_billing_status='N' AND lat IS NOT NULL AND lng IS NOT NULL`).all(...targetIds) as any[];
  let started = 0;
  for (const r of rows) {
    const res = onFreshLead(tenantId, { targetId: r.id, leadId: r.lead ?? null, address: r.address, city: r.city, state: r.state, zip: r.zip, lat: r.lat, lng: r.lng });
    if (res.action === "started") started++;
  }
  return started;
}

// ── Read API (feed + chain) ───────────────────────────────────────────────────
export function getExpansions(opts: { limit?: number } = {}): {
  expansions: any[]; summary: { active: number; exhausted: number; freshFound: number; addressesChecked: number };
} {
  ensureSchema();
  const limit = Math.min(100, opts.limit ?? 30);
  const exps = rawDb.prepare(`SELECT * FROM lead_expansions ORDER BY updated_at DESC LIMIT ?`).all(limit) as any[];
  const expansions = exps.map((e) => {
    const members = rawDb.prepare(`SELECT address, distance_m, ring, became_lead, lead_id FROM expansion_members WHERE expansion_id=? ORDER BY became_lead DESC, distance_m ASC LIMIT 20`).all(e.id) as any[];
    return {
      id: e.id, origin: { leadId: e.origin_lead_id, address: e.origin_address, city: e.origin_city, state: e.origin_state, lat: e.origin_lat, lng: e.origin_lng },
      status: e.status, ring: e.ring, radiusM: e.radius_m, emptyStreak: e.empty_streak,
      addressesChecked: e.addresses_checked, freshFound: e.fresh_found,
      newLeads: members.filter((m) => m.became_lead).map((m) => ({ address: m.address, distanceM: m.distance_m, leadId: m.lead_id })),
      members: members.map((m) => ({ address: m.address, distanceM: m.distance_m, ring: m.ring, becameLead: !!m.became_lead })),
      updatedAt: e.updated_at,
    };
  });
  const agg = rawDb.prepare(`SELECT
      SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) active,
      SUM(CASE WHEN status='exhausted' THEN 1 ELSE 0 END) exhausted,
      SUM(fresh_found) fresh, SUM(addresses_checked) checked FROM lead_expansions`).get() as any;
  return { expansions, summary: { active: Number(agg?.active ?? 0), exhausted: Number(agg?.exhausted ?? 0), freshFound: Number(agg?.fresh ?? 0), addressesChecked: Number(agg?.checked ?? 0) } };
}

// Admin/verification: seed an expansion from an existing lead or target id.
export function triggerExpansionFromTarget(targetId: number): { expansionId: string | null; action: string } {
  ensureSchema();
  const tenantId = getDefaultTenantId();
  if (tenantId == null) return { expansionId: null, action: "no_tenant" };
  const r = rawDb.prepare(`SELECT id,address,city,state,zip,lat,lng,converted_to_lead_id lead FROM scan_targets WHERE id=? AND lat IS NOT NULL AND lng IS NOT NULL`).get(targetId) as any;
  if (!r) return { expansionId: null, action: "not_found_or_no_coords" };
  return onFreshLead(tenantId, { targetId: r.id, leadId: r.lead ?? null, address: r.address, city: r.city, state: r.state, zip: r.zip, lat: r.lat, lng: r.lng });
}
