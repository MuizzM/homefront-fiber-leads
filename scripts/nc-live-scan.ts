/**
 * Bounded LIVE scan of NC Kinetic-fiber cities — real Mapbox/Overpass + Decodo proxy.
 *
 * Scope: ONLY the NC cities where Kinetic actually builds fiber (its FCC market list).
 * Address source is cost-tiered: existing pool (zero cost) → free Overpass → bounded
 * Mapbox harvest (last resort). Every result is persisted so nothing is wasted:
 *   - NEW FIBER + billing N            → a fresh lead (deduped by address)
 *   - PROSPECT / planned (in-fabric)   → the coming-soon watchlist (re-check later)
 *   - anything found                    → the address pool (with its Kinetic df id)
 * HARD-CAPPED and METERED. Usage:
 *   npx tsx scripts/nc-live-scan.ts <City|all> <perCityCap> [--mapbox]
 */
import "dotenv/config";
import { storage, getDefaultTenantId } from "../server/storage";
import { rawDb } from "../server/db";
import { scanAddress } from "../server/scanner";
import { getCityAddresses } from "../server/overpass";
import { harvestCityAddresses } from "../server/mapbox-addresses";

const NC_KINETIC = [
  { city: "Rockwell", zip: "28138" }, { city: "Concord", zip: "28025" }, { city: "Kannapolis", zip: "28081" },
  { city: "Salisbury", zip: "28144" }, { city: "Statesville", zip: "28677" }, { city: "Lexington", zip: "27292" },
  { city: "Asheboro", zip: "27203" }, { city: "High Point", zip: "27262" }, { city: "Albemarle", zip: "28001" },
];
const STATE = "NC";
const CONCURRENCY = 3;             // gentle — avoid re-tripping Kinetic's rate limit
const PACE_MS = 120;               // small pause between checks per worker
const usd = (checks: number) => (checks * Number(process.env.SCAN_BYTES_PER_CHECK ?? 12000) / 1e9 * Number(process.env.SCAN_USD_PER_GB ?? 3)).toFixed(4);

const arg = (process.argv[2] || "all").toLowerCase();
const CAP = Math.max(1, Number(process.argv[3] ?? 100));
const ZIP_ARG = process.argv[4] && !process.argv[4].startsWith("--") ? process.argv[4] : "";
const ALLOW_MAPBOX = process.argv.includes("--mapbox");
const HARVEST_ONLY = process.argv.includes("--harvest-only"); // save addresses to the pool, don't scan
const FORCE_HARVEST = process.argv.includes("--force-harvest"); // ignore existing pool, re-pull from Overpass
// "all" → the 9 NC Kinetic cities; a known city → that one; ANY other name → an
// arbitrary NC city (optional zip as argv[4]) so we can scan a fresh town like Marshville.
const known = NC_KINETIC.find(c => c.city.toLowerCase() === arg);
const cities = arg === "all" ? NC_KINETIC : known ? [known] : [{ city: process.argv[2], zip: ZIP_ARG }];

async function resolveAddresses(city: string, zip: string): Promise<{ source: string; addrs: any[] }> {
  // Pool: never-scanned addresses FIRST so re-runs make progress on the backlog
  // instead of re-checking already-done ones.
  const pool = FORCE_HARVEST ? [] : rawDb.prepare(
    `SELECT address, city, state, zip, lat, lng FROM scan_targets
     WHERE lower(city)=lower(?) AND lower(state)=lower(?)
     ORDER BY (last_scanned_at IS NOT NULL), last_scanned_at ASC`
  ).all(city, STATE) as any[];
  if (pool.length >= 25) return { source: "pool", addrs: pool.map((r: any) => ({ address: r.address, city: r.city, state: r.state, zip: r.zip || zip, lat: r.lat, lng: r.lng })) };

  // Build the UNION of every source (deduped by street), for maximum completeness.
  const byKey = new Map<string, any>();
  const srcs = new Set<string>();
  const add = (a: any, src: string) => {
    const k = String(a.address ?? "").trim().toLowerCase();
    if (!k || !a.lat) return;
    if (!byKey.has(k)) { byKey.set(k, { address: a.address, city, state: STATE, zip: a.zip || zip, lat: a.lat, lng: a.lng }); srcs.add(src); }
  };

  // Overpass (free OSM) — actual addresses, not a grid. 504s are transient → retry.
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const o = await getCityAddresses(city, STATE);
      if (o.addresses?.length) { for (const a of o.addresses) add(a, "overpass"); console.log(`   overpass: ${o.addresses.length} addresses`); }
      break;
    } catch (e: any) {
      const transient = /50\d|timeout|429|ECONN|network/i.test(e.message ?? "");
      console.log(`   overpass attempt ${attempt}/4 failed: ${e.message}${transient && attempt < 4 ? " — retrying…" : ""}`);
      if (!transient) break;
      if (attempt < 4) await new Promise(r => setTimeout(r, attempt * 6000));
    }
  }
  // Mapbox reverse-geocode grid — fills addresses OSM missed. Costs geocoding
  // requests (bounded by MAPBOX_HARVEST_CAP); only runs with the explicit --mapbox flag.
  if (ALLOW_MAPBOX && process.env.MAPBOX_TOKEN) {
    try {
      const m: any = await harvestCityAddresses(city, STATE, process.env.MAPBOX_TOKEN);
      const list = (m.addresses ?? []) as any[];
      const before = byKey.size;
      for (const a of list) add(a, "mapbox");
      console.log(`   mapbox: ${list.length} harvested → +${byKey.size - before} net-new addresses`);
    } catch (e: any) { console.log(`   mapbox harvest failed: ${e.message}`); }
  }

  let all = [...byKey.values()];
  // The bboxes overshoot into neighboring towns (wrong ZIPs) which Kinetic rejects
  // as AddressNeedsFix. If a target ZIP was given, keep only that ZIP (or ZIP-less).
  if (zip) { const before = all.length; all = all.filter(a => !a.zip || a.zip === zip).map(a => ({ ...a, zip })); console.log(`   ZIP ${zip} filter: ${before} → ${all.length} (dropped ${before - all.length} neighboring)`); }
  return { source: all.length ? [...srcs].join("+") : "none", addrs: all };
}

const getTargetId = (address: string, city: string) =>
  (rawDb.prepare("SELECT id FROM scan_targets WHERE address=? AND lower(city)=lower(?) LIMIT 1").get(address, city) as any)?.id as number | undefined;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function scanCity(city: string, zip: string) {
  const { source, addrs } = await resolveAddresses(city, zip);
  console.log(`\n▶ ${city}, NC — source=${source}, ${addrs.length} available`);
  if (!addrs.length) return { city, source, checked: 0, newFiber: 0, comingSoon: 0, noService: 0, existing: 0, failed: 0, leads: 0 };

  // GET ALL THE ADDRESSES: persist the WHOLE harvested set into the pool up front
  // (zero proxy — DB only), so nothing is lost even if scanning is rate-limited or
  // capped. Un-scanned rows sit in the pool for a later re-scan / the nightly.
  if (source !== "pool") {
    const added = storage.upsertScanTargets(addrs.map((a: any) => ({ address: a.address, city: a.city, state: a.state, zip: a.zip, lat: a.lat, lng: a.lng, source: `harvest-${source}`, tenantId: null })));
    console.log(`   pooled ${added} new address(es) (${addrs.length} total in ${city})`);
  }
  if (HARVEST_ONLY) { console.log(`   harvest-only: skipped scanning`); return { city, source, checked: 0, newFiber: 0, comingSoon: 0, noService: 0, existing: 0, failed: 0, leads: 0 }; }

  const batch = addrs.slice(0, CAP);
  console.log(`   scanning ${batch.length} (cap ${CAP})`);
  const tenantId = getDefaultTenantId();
  let checked = 0, newFiber = 0, comingSoon = 0, noService = 0, existing = 0, failed = 0, leads = 0;
  const failReasons: Record<string, number> = {};

  // Returns "ok" | "fail" | "blocked" (403 = proxy IP blocked → worth a retry pass).
  async function processAddr(a: any): Promise<"ok" | "fail" | "blocked"> {
    let r: any;
    try { r = await scanAddress(a.address, a.city, a.state, a.zip); }
    catch (e: any) { failReasons["exception:" + (e?.message ?? "?").slice(0, 40)] = (failReasons["exception:" + (e?.message ?? "?").slice(0, 40)] ?? 0) + 1; failed++; return "fail"; }
    checked++;
    if (r.apiSource === "failed") {
      const blocked = /blocked \(403\)/.test(r.notes ?? "");
      const k = (r.rawResponse?.validationResult ?? r.notes ?? "failed").slice(0, 60);
      failReasons[k] = (failReasons[k] ?? 0) + 1;
      if (blocked) return "blocked";          // retry after cooldown (proxy IP block)
      failed++;
      return "fail";                          // a non-answer is never a negative
    }
    // Persist to pool with the fresh status (baseline for new rows; enrich for existing).
    try {
      storage.upsertScanTargets([{ address: r.address, city: r.city, state: r.state, zip: r.zip, lat: r.lat, lng: r.lng, source: `nc-live-${source}`, tenantId: null, dfAddressId: r.dfAddressId, scannedNow: true, fiberStatus: r.fiberStatus, isNewFiber: r.isNewFiber, billingStatus: r.billingStatus }]);
      const id = getTargetId(r.address, r.city);
      if (id) storage.recordScanTargetResult(id, { fiberStatus: r.fiberStatus, isNewFiber: r.isNewFiber, billingStatus: r.billingStatus, dfAddressId: r.dfAddressId, availabilityStatus: r.fiberStatus, newlyLive: false });
    } catch { /* pool best-effort */ }

    const seg = (r.householdSegmentType ?? "").toUpperCase();
    if (r.isNewFiber && r.billingStatus === "N") {
      try { const up = storage.upsertLeadByAddress({ tenantId, address: r.address, city: r.city, state: r.state, zip: r.zip, lat: r.lat ?? undefined, lng: r.lng ?? undefined, fiberStatus: "new_fiber", isNewFiber: true, isTenured: false, billingStatus: r.billingStatus, householdSegmentType: r.householdSegmentType, techType: r.techType, speedTier: r.speedTier, maxDownloadMbps: r.maxDownloadMbps, competitorName: r.competitorName, addressCatalogDate: r.addressCatalogDate, dfAddressId: r.dfAddressId, leadStatus: "prospect", deploymentNotes: `NC live scan (${source}) — NEW FIBER, no subscriber.` } as any); if (up?.created) leads++; } catch {}
      newFiber++;
    } else if (seg === "PROSPECT" || (r.isNewFiber && r.billingStatus === "Y")) {
      try { storage.createComingSoon({ tenantId, address: r.address, city: r.city, state: r.state, zip: r.zip, lat: r.lat ?? undefined, lng: r.lng ?? undefined, reason: seg === "PROSPECT" ? "prospect" : "has_fiber_subscribed", addedBy: null, lastChecked: new Date().toISOString() } as any); comingSoon++; } catch { /* dup */ }
      if (r.isNewFiber) newFiber++;
    } else if (r.fiberStatus === "no_service") noService++;
    else existing++;
    return "ok";
  }

  // Drain a work-list with N concurrent workers; collect 403-blocked addresses.
  async function drain(list: any[]): Promise<any[]> {
    let i = 0; const blockedOut: any[] = [];
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      while (i < list.length) { const a = list[i++]; if (await processAddr(a) === "blocked") blockedOut.push(a); await sleep(PACE_MS); }
    }));
    return blockedOut;
  }

  // Kinetic rate-limits to ~40-50 checks per burst, then 403-blocks for minutes.
  // So scan in small BURSTs with a COOLDOWN whenever a burst gets blocked — this
  // works WITH the limit instead of hammering through it. Self-limits to a wall-
  // clock budget; whatever's unscanned stays queued in the pool for next time.
  const BURST = 40, COOLDOWN_MS = 60_000, TIME_BUDGET_MS = 7 * 60_000;
  const t0 = Date.now();
  for (let start = 0; start < batch.length; start += BURST) {
    if (Date.now() - t0 > TIME_BUDGET_MS) { console.log(`   ⏹ time budget reached — ${batch.length - start} left queued in pool`); break; }
    const chunk = batch.slice(start, start + BURST);
    const blocked = await drain(chunk);
    failed += blocked.length;
    console.log(`   burst ${Math.floor(start / BURST) + 1}: ${chunk.length - blocked.length} ok, ${blocked.length} blocked · running: ${leads} leads, ${newFiber} new-fiber`);
    if (start + BURST < batch.length) await sleep(blocked.length > chunk.length * 0.25 ? COOLDOWN_MS : 4000);
  }

  console.log(`   ✓ checked ${checked} · ${newFiber} new-fiber (${leads} new leads) · ${comingSoon} coming-soon · ${existing} existing · ${noService} no-service · ${failed} failed · ~$${usd(checked)}`);
  const topFails = Object.entries(failReasons).sort((a, b) => b[1] - a[1]).slice(0, 4);
  if (topFails.length) console.log(`     fail reasons: ${topFails.map(([k, v]) => `${v}×"${k}"`).join(" | ")}`);
  return { city, source, checked, newFiber, comingSoon, noService, existing, failed, leads };
}

(async () => {
  console.log(`NC Kinetic live scan — cities=[${cities.map(c => c.city).join(", ")}], perCityCap=${CAP}, mapbox=${ALLOW_MAPBOX}`);
  // proxy-fetch loads undici asynchronously at import; wait for it so the very
  // first probe goes through Decodo (never a fail-closed direct request).
  await new Promise(r => setTimeout(r, 2000));
  const results = [];
  for (const c of cities) results.push(await scanCity(c.city, c.zip));
  const T = results.reduce((s, r) => ({ checked: s.checked + r.checked, newFiber: s.newFiber + r.newFiber, comingSoon: s.comingSoon + r.comingSoon, noService: s.noService + r.noService, existing: s.existing + r.existing, failed: s.failed + r.failed, leads: s.leads + r.leads }), { checked: 0, newFiber: 0, comingSoon: 0, noService: 0, existing: 0, failed: 0, leads: 0 });
  console.log(`\n═══ TOTAL — ${T.checked} checked · ${T.newFiber} new-fiber (${T.leads} new leads) · ${T.comingSoon} coming-soon · ${T.existing} existing · ${T.noService} no-service · ${T.failed} failed · ~$${usd(T.checked)} proxy ═══`);
  process.exit(0);
})();
