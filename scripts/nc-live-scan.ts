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
const CONCURRENCY = 5;
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
  const pool = storage.getScanTargetsByCity(city, STATE);
  if (!FORCE_HARVEST && pool.length >= 25) return { source: "pool", addrs: pool.map((r: any) => ({ address: r.address, city: r.city, state: r.state, zip: r.zip || zip, lat: r.lat, lng: r.lng })) };
  // Overpass (free OSM) returns the ACTUAL addresses, not a wasteful grid — it's
  // the right source. 504s are transient overload, so retry a few times with backoff.
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const o = await getCityAddresses(city, STATE);
      if (o.addresses?.length) {
        let list = o.addresses.map((a: any) => ({ address: a.address, city, state: STATE, zip: a.zip || zip, lat: a.lat, lng: a.lng }));
        // The Overpass bbox overshoots into neighboring towns (wrong ZIPs, even
        // out-of-state) which Kinetic rejects as AddressNeedsFix. If a target ZIP
        // was given, keep only addresses in that ZIP (or ZIP-less), forcing it —
        // that's the real town, not its neighbors.
        if (zip) { const before = list.length; list = list.filter((a: any) => !a.zip || a.zip === zip).map((a: any) => ({ ...a, zip })); console.log(`   overpass: ${o.addresses.length} in bbox → ${list.length} in ZIP ${zip} (dropped ${before - list.length} neighboring)`); }
        if (list.length) return { source: "overpass", addrs: list };
      }
      break; // succeeded but empty — Overpass has no addresses here
    } catch (e: any) {
      const transient = /50\d|timeout|429|ECONN|network/i.test(e.message ?? "");
      console.log(`   overpass attempt ${attempt}/4 failed: ${e.message}${transient && attempt < 4 ? " — retrying…" : ""}`);
      if (!transient) break;
      if (attempt < 4) await new Promise(r => setTimeout(r, attempt * 6000));
    }
  }
  if (ALLOW_MAPBOX && process.env.MAPBOX_TOKEN) {
    try {
      const m: any = await harvestCityAddresses(city, STATE, process.env.MAPBOX_TOKEN);
      const list = (m.addresses ?? m ?? []) as any[];
      if (list.length) return { source: "mapbox", addrs: list.map((a: any) => ({ address: a.address, city, state: STATE, zip: a.zip || zip, lat: a.lat, lng: a.lng })) };
    } catch (e: any) { console.log(`   mapbox harvest failed: ${e.message}`); }
  }
  return { source: "none", addrs: [] };
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
      while (i < list.length) { const a = list[i++]; if (await processAddr(a) === "blocked") blockedOut.push(a); }
    }));
    return blockedOut;
  }

  let blocked = await drain(batch);
  // Retry pass: 403 = the proxy IP was blocked, not a real "no". Cool down to let
  // Decodo rotate the egress IP, then re-scan the blocked addresses ONCE so we
  // don't lose real coverage to a transient block.
  if (blocked.length) {
    console.log(`   ⏸ ${blocked.length} blocked (403) — cooling down 25s to rotate IP, then retrying…`);
    await sleep(25000);
    const stillBlocked = await drain(blocked);
    failed += stillBlocked.length; // whatever is still blocked after the retry is a real miss for this run
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
