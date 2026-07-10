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
const CONCURRENCY = 8;
const usd = (checks: number) => (checks * Number(process.env.SCAN_BYTES_PER_CHECK ?? 12000) / 1e9 * Number(process.env.SCAN_USD_PER_GB ?? 3)).toFixed(4);

const arg = (process.argv[2] || "all").toLowerCase();
const CAP = Math.max(1, Number(process.argv[3] ?? 100));
const ALLOW_MAPBOX = process.argv.includes("--mapbox");
const cities = arg === "all" ? NC_KINETIC : NC_KINETIC.filter(c => c.city.toLowerCase() === arg);
if (!cities.length) { console.error(`Unknown city "${arg}". NC Kinetic cities: ${NC_KINETIC.map(c => c.city).join(", ")}`); process.exit(1); }

async function resolveAddresses(city: string, zip: string): Promise<{ source: string; addrs: any[] }> {
  const pool = storage.getScanTargetsByCity(city, STATE);
  if (pool.length >= 25) return { source: "pool", addrs: pool.map((r: any) => ({ address: r.address, city: r.city, state: r.state, zip: r.zip || zip, lat: r.lat, lng: r.lng })) };
  try {
    const o = await getCityAddresses(city, STATE);
    if (o.addresses?.length) return { source: "overpass", addrs: o.addresses.map((a: any) => ({ address: a.address, city, state: STATE, zip: a.zip || zip, lat: a.lat, lng: a.lng })) };
  } catch (e: any) { console.log(`   overpass failed: ${e.message}`); }
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

async function scanCity(city: string, zip: string) {
  const { source, addrs } = await resolveAddresses(city, zip);
  const batch = addrs.slice(0, CAP);
  console.log(`\n▶ ${city}, NC — source=${source}, ${addrs.length} available, scanning ${batch.length} (cap ${CAP})`);
  if (!batch.length) return { city, source, checked: 0, newFiber: 0, comingSoon: 0, noService: 0, existing: 0, failed: 0, leads: 0 };

  const tenantId = getDefaultTenantId();
  let checked = 0, newFiber = 0, comingSoon = 0, noService = 0, existing = 0, failed = 0, leads = 0;
  const failReasons: Record<string, number> = {};
  let i = 0;
  async function worker() {
    while (i < batch.length) {
      const a = batch[i++];
      let r: any;
      try { r = await scanAddress(a.address, a.city, a.state, a.zip); } catch (e: any) { failed++; failReasons["exception:" + (e?.message ?? "?").slice(0, 40)] = (failReasons["exception:" + (e?.message ?? "?").slice(0, 40)] ?? 0) + 1; continue; }
      checked++;
      if (r.apiSource === "failed") { failed++; const k = (r.rawResponse?.validationResult ?? r.notes ?? "failed").slice(0, 60); failReasons[k] = (failReasons[k] ?? 0) + 1; continue; } // a non-answer is never a negative
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
        // In Kinetic's fabric, fiber coming/present but not a fresh no-subscriber
        // lead yet (a prospect build, or new fiber with an existing account) →
        // coming-soon watchlist so a future re-check catches it flipping to a lead.
        try { storage.createComingSoon({ tenantId, address: r.address, city: r.city, state: r.state, zip: r.zip, lat: r.lat ?? undefined, lng: r.lng ?? undefined, reason: seg === "PROSPECT" ? "prospect" : "has_fiber_subscribed", addedBy: null, lastChecked: new Date().toISOString() } as any); comingSoon++; } catch { /* dup — already watched */ }
        if (r.isNewFiber) newFiber++;
      } else if (r.fiberStatus === "no_service") noService++;
      else existing++;
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
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
