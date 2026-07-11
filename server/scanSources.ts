// ── scanSources — WorkSource implementations for the kinetic scheduler ────────
// A WorkSource turns "a set of addresses to check" into tasks the scheduler pulls,
// and owns what happens to each result: persist to the pool, promote a lead, enroll a
// coming-soon watch, or (on a 403) re-queue for retry. This is the ONE place the
// "what a Kinetic answer means for our data" rules live, so the manual scan, the
// nightly cron and discovery all persist identically (killing the old per-copy drift).

import { storage } from "./storage";
import { rawDb } from "./db";
import type { WorkSource, ProbeTask } from "./kineticScheduler";
import type { ProbeOutcome } from "./kineticProbe";
import { fringeCandidates, normAddr } from "@shared/fringe";

const taskId = (t: ProbeTask): string => t.key.kind === "df" ? t.key.dfAddressId : t.key.address;

const getTargetId = (address: string, city: string): number | undefined =>
  (rawDb.prepare("SELECT id FROM scan_targets WHERE address=? AND lower(city)=lower(?) LIMIT 1").get(address, city) as any)?.id;

export interface ScanCounters {
  answered: number; newFiber: number; leads: number; comingSoon: number;
  noService: number; existing: number; blocked: number; inconclusive: number; dropped: number;
  fringeQueued: number; fringeLeads: number;
}
const zeroCounters = (): ScanCounters => ({
  answered: 0, newFiber: 0, leads: 0, comingSoon: 0, noService: 0, existing: 0, blocked: 0, inconclusive: 0, dropped: 0,
  fringeQueued: 0, fringeLeads: 0,
});

// Persist ONE answered/no_service result: pool row + lead-or-watchlist routing.
// Centralizes the rule that used to be copy-pasted in nc-live-scan/cron/discovery.
export function persistScanResult(r: any, tenantId: number | null, sourceTag: string, counters: ScanCounters): void {
  try {
    storage.upsertScanTargets([{
      address: r.address, city: r.city, state: r.state, zip: r.zip, lat: r.lat, lng: r.lng,
      source: `live-${sourceTag}`, tenantId: null, dfAddressId: r.dfAddressId,
      scannedNow: true, fiberStatus: r.fiberStatus, isNewFiber: r.isNewFiber, billingStatus: r.billingStatus,
    }]);
    const id = getTargetId(r.address, r.city);
    if (id) storage.recordScanTargetResult(id, {
      fiberStatus: r.fiberStatus, isNewFiber: r.isNewFiber, billingStatus: r.billingStatus,
      dfAddressId: r.dfAddressId, availabilityStatus: r.fiberStatus, newlyLive: false,
    });
  } catch { /* pool write is best-effort */ }

  const seg = (r.householdSegmentType ?? "").toUpperCase();
  if (r.isNewFiber && r.billingStatus === "N") {
    // NEW FIBER + no subscriber → a fresh lead (deduped by address).
    try {
      const up = storage.upsertLeadByAddress({
        tenantId, address: r.address, city: r.city, state: r.state, zip: r.zip,
        lat: r.lat ?? undefined, lng: r.lng ?? undefined,
        fiberStatus: "new_fiber", isNewFiber: true, isTenured: false, billingStatus: r.billingStatus,
        householdSegmentType: r.householdSegmentType, techType: r.techType, speedTier: r.speedTier,
        maxDownloadMbps: r.maxDownloadMbps, competitorName: r.competitorName, addressCatalogDate: r.addressCatalogDate,
        dfAddressId: r.dfAddressId, leadStatus: "prospect", deploymentNotes: `Live scan (${sourceTag}) — NEW FIBER, no subscriber.`,
      } as any);
      if (up?.created) counters.leads++;
    } catch { /* lead upsert best-effort */ }
    counters.newFiber++;
  } else if (r.dfAddressId && r.billingStatus === "N" && !["new_fiber", "existing_fiber", "tenured_fiber"].includes(r.fiberStatus)) {
    // In Kinetic's fabric, no subscriber, not yet on fiber → a FUTURE lead: watch it by
    // dfAddressId so the nightly recheck promotes it the instant it flips to NEW FIBER.
    const reason = seg === "PROSPECT" ? "prospect" : r.fiberStatus === "copper" ? "copper_only" : "no_service";
    try {
      storage.upsertComingSoonByDfAddressId({
        tenantId, address: r.address, city: r.city, state: r.state, zip: r.zip,
        lat: r.lat ?? undefined, lng: r.lng ?? undefined, reason, addedBy: null,
        dfAddressId: r.dfAddressId, householdSegmentType: r.householdSegmentType,
      } as any);
      counters.comingSoon++;
    } catch { /* already watched */ }
    if (r.isNewFiber) counters.newFiber++;
  } else if (r.fiberStatus === "no_service") {
    counters.noService++;
  } else {
    counters.existing++;
  }
}

// A finite list of city addresses to check (manual scan / bounded run). A 403'd task
// is re-queued (bounded) so a throttle never loses an address; exhausted retries drop
// back to the pool for the nightly.
export class ManualCitySource implements WorkSource {
  kind = "manual";
  readonly counters: ScanCounters = zeroCounters();
  private pending: ProbeTask[];
  private attempts = new Map<string, number>();
  private seen: Set<string>;          // normalized addresses queued — dedup for fringe
  private fringeRemaining: number;    // remaining flood-fill probe budget

  constructor(
    public id: string,
    addrs: Array<{ address: string; city: string; state: string; zip: string }>,
    private tenantId: number | null,
    private sourceTag = "manual",
    private retryCap = 4,
    private fringe?: { radius: number; budget: number }, // enable subdivision flood-fill
  ) {
    this.pending = addrs.map((a) => ({ key: { kind: "addr", address: a.address, city: a.city, state: a.state, zip: a.zip } }));
    this.seen = new Set(addrs.map((a) => normAddr(a.address)));
    this.fringeRemaining = fringe?.budget ?? 0;
  }

  async next(n: number): Promise<ProbeTask[]> { return this.pending.splice(0, n); }
  remaining(): number { return this.pending.length; }

  onResult(task: ProbeTask, o: ProbeOutcome): void {
    if (o.kind === "blocked") {
      // 403 = the bucket was momentarily empty; the window will recover — retry it.
      this.counters.blocked++;
      const id = taskId(task);
      const a = (this.attempts.get(id) ?? 0) + 1;
      this.attempts.set(id, a);
      if (a < this.retryCap) this.pending.push(task); else this.counters.dropped++; // give up this run; stays queued
      return;
    }
    if (o.kind === "inconclusive") {
      // Timeout / soft-fail (mostly deterministic AddressNeedsFix): retrying the SAME
      // address just re-fails. Leave it un-scanned in the pool (last_scanned_at stays
      // NULL) for the nightly rather than spinning on it now.
      this.counters.inconclusive++;
      return;
    }
    this.counters.answered++;
    const beforeLeads = this.counters.leads;
    persistScanResult(o.result, this.tenantId, this.sourceTag, this.counters);
    if ((task.ctx as any)?.fringe && this.counters.leads > beforeLeads) this.counters.fringeLeads++;
    // FLOOD-FILL: a NEW FIBER hit is a live build → enqueue its street neighbors so a
    // subdivision OSM under-listed is fully found (bounded budget, deduped by `seen`,
    // recursive — a fringe hit expands again until the budget is spent).
    if (this.fringe && this.fringeRemaining > 0 && o.result.isNewFiber && o.result.address) {
      for (const c of fringeCandidates(o.result.address, this.fringe.radius, this.seen)) {
        if (this.fringeRemaining <= 0) break;
        this.seen.add(normAddr(c.address));
        this.pending.push({ key: { kind: "addr", address: c.address, city: o.result.city, state: o.result.state, zip: o.result.zip }, ctx: { fringe: true } });
        this.fringeRemaining--;
        this.counters.fringeQueued++;
      }
    }
  }
}

// ── StreamSource — the generic WorkSource the nightly jobs compose ────────────
// A source is just (a) a lazy puller of tasks and (b) a handler for each real
// result. 403'd tasks are optionally re-queued (bounded); the DOMAIN logic
// (harvest, promote, transition-detect) lives in the caller's `handler`, so the
// manual scan, CNS sweep, watchlist recheck and pool re-scan all share ONE window
// yet keep their own result semantics. No pacing lives here — the scheduler owns it.
export class StreamSource implements WorkSource {
  private retryQueue: ProbeTask[] = [];
  private attempts = new Map<string, number>();
  private exhausted = false;

  constructor(
    public id: string,
    public kind: string,
    private puller: (n: number) => ProbeTask[],
    private handler: (task: ProbeTask, o: ProbeOutcome) => void | Promise<void>,
    private retryBlockedCap = 0,
    private estimateRemaining?: () => number,
  ) {}

  async next(n: number): Promise<ProbeTask[]> {
    const out: ProbeTask[] = [];
    while (out.length < n && this.retryQueue.length) out.push(this.retryQueue.shift()!);
    if (out.length < n && !this.exhausted) {
      const fresh = this.puller(n - out.length);
      if (!fresh.length) this.exhausted = true;
      else out.push(...fresh);
    }
    return out;
  }

  async onResult(task: ProbeTask, o: ProbeOutcome): Promise<void> {
    if (o.kind === "blocked") {
      // A 403 is a momentary empty bucket — retry (bounded); never a demotion.
      if (this.retryBlockedCap > 0) {
        const id = taskId(task);
        const a = (this.attempts.get(id) ?? 0) + 1;
        this.attempts.set(id, a);
        if (a <= this.retryBlockedCap) { this.retryQueue.push(task); return; }
      }
      return; // give up on this task's block this run
    }
    await this.handler(task, o); // answered | no_service | inconclusive
  }

  remaining(): number {
    return this.retryQueue.length + (this.exhausted ? 0 : (this.estimateRemaining?.() ?? 1));
  }
}

// Pull tasks from a materialized list (watchlist rows, pool targets, city addresses).
export function arrayPuller(tasks: ProbeTask[]): (n: number) => ProbeTask[] {
  let i = 0;
  return (n) => tasks.slice(i, (i += n));
}

// Lazily generate df-id tasks over a CNS number window, skipping recently-missed
// numbers above the frontier (still-unassigned), carrying {cns,env} context.
export function cnsRangePuller(env: string, start: number, end: number, skipAbove: Set<number>, frontier: number): (n: number) => ProbeTask[] {
  let cur = start;
  return (n) => {
    const out: ProbeTask[] = [];
    while (out.length < n && cur <= end) {
      const cns = cur++;
      if (cns > frontier && skipAbove.has(cns)) continue;
      out.push({ key: { kind: "df", dfAddressId: `${env}${String(cns).padStart(7, "0")}` }, ctx: { cns, env } });
    }
    return out;
  };
}

export function dfTasksFromRows(rows: any[]): ProbeTask[] {
  return rows.filter((r) => r.dfAddressId).map((r) => ({ key: { kind: "df", dfAddressId: r.dfAddressId }, ctx: r }));
}
export function addrTasksFromTargets(targets: any[]): ProbeTask[] {
  return targets.map((t) => ({ key: { kind: "addr", address: t.address, city: t.city, state: t.state, zip: t.zip }, ctx: t }));
}

// Load never-scanned pool addresses for a city (optionally constrained to a ZIP),
// oldest-first. Zero proxy — the pool is the free address source.
export function loadCityPoolAddresses(
  city: string, zip: string | undefined, limit: number,
): Array<{ address: string; city: string; state: string; zip: string }> {
  const rows = zip
    ? rawDb.prepare("SELECT address, city, state, zip FROM scan_targets WHERE lower(city)=lower(?) AND (zip=? OR zip IS NULL) AND last_scanned_at IS NULL ORDER BY id LIMIT ?").all(city, zip, limit)
    : rawDb.prepare("SELECT address, city, state, zip FROM scan_targets WHERE lower(city)=lower(?) AND last_scanned_at IS NULL ORDER BY id LIMIT ?").all(city, limit);
  return (rows as any[]).map((r) => ({ address: r.address, city: r.city, state: r.state, zip: r.zip ?? zip ?? "" }));
}
