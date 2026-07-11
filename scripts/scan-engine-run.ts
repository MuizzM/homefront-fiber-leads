// Live runner for the closed-loop scan engine (kineticScheduler). Harvests each city
// (Overpass, free — zero Mapbox) into the pool if needed, then scans ALL cities'
// never-scanned addresses through ONE shared AIMD window and prints the settled block
// rate + per-city results.
//   npx tsx scripts/scan-engine-run.ts <City|City:zip> [more cities...] [--cap=N] [--budget=SEC]
import "dotenv/config";
import { runMigrations, getDefaultTenantId, storage } from "../server/storage";
runMigrations();
import { KineticScheduler } from "../server/kineticScheduler";
import { ManualCitySource, loadCityPoolAddresses } from "../server/scanSources";
import { getCityAddresses } from "../server/overpass";
import { INCONCLUSIVE_GIVEUP } from "../shared/scanPolicy";

// Known ZIPs for towns we scan (keeps neighboring-town spillover out).
const ZIPS: Record<string, string> = {
  harrisburg: "28075", lexington: "27292", tryon: "28782", pinebluff: "28373",
  wingate: "28174", sanford: "27330", albemarle: "28001", broadway: "27505",
  marshville: "28103", aberdeen: "28315", wadesboro: "28170", concord: "28025",
  // Spartanburg County, SC — Kinetic build zone
  inman: "29349", duncan: "29334", lyman: "29365", wellford: "29385",
  "boiling springs": "29316", chesnee: "29323", landrum: "29356",
  campobello: "29322", greer: "29650",
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const args = process.argv.slice(2);
const STATE = ((args.find((a) => a.startsWith("--state=")) ?? "").split("=")[1] || "NC").toUpperCase();
const CAP = Number((args.find((a) => a.startsWith("--cap=")) ?? "").split("=")[1] || 500);
const BUDGET_MS = Number((args.find((a) => a.startsWith("--budget=")) ?? "").split("=")[1] || 420) * 1000;
// --fringe or --fringe=radius:budget → flood-fill neighbors of every NEW FIBER hit.
// Stop after N consecutive hard-backoffs (bucket drained, not refilling) so a
// manual run doesn't grind on 403s — the rest stays queued for a later sweep.
// 0 disables the breaker (grind to budget). Default 8.
const MAXTHROTTLE = Number((args.find((a) => a.startsWith("--maxthrottle=")) ?? "").split("=")[1] || 8);
// Re-open addresses parked after repeated inconclusive probes (Kinetic doesn't
// recognize them). Off by default so a normal sweep doesn't re-buy answerless probes.
const RETRY_EXHAUSTED = args.includes("--retryexhausted");
const fringeArg = args.find((a) => a.startsWith("--fringe"));
const FRINGE = fringeArg
  ? (() => { const [r, b] = (fringeArg.split("=")[1] ?? "").split(":"); return { radius: Number(r) || 8, budget: Number(b) || 400 }; })()
  : undefined;
const cities = args.filter((a) => !a.startsWith("--")).map((a) => {
  const [c, z] = a.split(":");
  return { city: c, zip: z || ZIPS[c.toLowerCase()] };
});

async function harvestCity(city: string, zip?: string): Promise<void> {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const o = await getCityAddresses(city, STATE);
      let list = (o.addresses ?? []).filter((a: any) => a.address && a.lat);
      if (zip) list = list.filter((a: any) => !a.zip || a.zip === zip).map((a: any) => ({ ...a, zip }));
      const added = list.length
        ? storage.upsertScanTargets(list.map((a: any) => ({ address: a.address, city, state: STATE, zip: a.zip || zip, lat: a.lat, lng: a.lng, source: "harvest-overpass", tenantId: null })))
        : 0;
      console.log(`  harvest ${city}: overpass ${(o.addresses ?? []).length} → pooled ${added} new`);
      return;
    } catch (e: any) {
      const transient = /50\d|timeout|429|ECONN|network/i.test(e.message ?? "");
      console.log(`  harvest ${city}: overpass attempt ${attempt}/4 failed: ${e.message}`);
      if (!transient) return;
      if (attempt < 4) await sleep(attempt * 5000);
    }
  }
}

(async () => {
  if (!cities.length) { console.error("usage: scan-engine-run <City|City:zip> [more...] [--cap=N] [--budget=SEC]"); process.exit(1); }
  await sleep(2000); // undici warmup

  console.log(`Harvesting ${cities.length} cities (Overpass, zero Mapbox)…`);
  for (const c of cities) await harvestCity(c.city, c.zip);

  const tenantId = getDefaultTenantId();
  // Keep each source paired with its city so the per-city report never misaligns.
  const built = cities.map((c) => {
    const addrs = loadCityPoolAddresses(c.city, c.zip, CAP, RETRY_EXHAUSTED);
    const parked = storage.getScanTargetExhaustedCount(c.city, c.zip);
    console.log(`  ${c.city}${c.zip ? ` ${c.zip}` : ""}: ${addrs.length} never-scanned queued${parked > 0 ? ` (+${parked} exhausted${RETRY_EXHAUSTED ? " — re-opened" : " — parked, use --retryexhausted"})` : ""}`);
    return { c, source: addrs.length ? new ManualCitySource(c.city, addrs, tenantId, c.city.toLowerCase(), 4, FRINGE) : null };
  }).filter((x): x is { c: typeof cities[number]; source: ManualCitySource } => x.source !== null);

  if (!built.length) { console.log("nothing queued to scan"); process.exit(0); }
  const sources = built.map((x) => x.source);

  console.log(`\nScanning ${sources.length} cities through ONE shared window (cap ${CAP}/city, budget ${BUDGET_MS / 1000}s${FRINGE ? `, fringe r${FRINGE.radius}/${FRINGE.budget}` : ""})…`);
  const sch = new KineticScheduler({
    timeBudgetMs: BUDGET_MS,
    stopAfterHardBackoffs: MAXTHROTTLE,
    onRound: (s) => { if (s.round % 8 === 0 || s.action !== "continue") console.log(`  r${s.round}: cwnd=${s.cwnd} ${s.action}  +${s.ok}ok/${s.blocked}blk  blockRate=${(s.blockRate * 100).toFixed(1)}%`); },
  });
  const sum = await sch.run(sources);

  console.log(`\n═══ ENGINE SUMMARY ═══`);
  console.log(`stop reason: ${sum.stopReason}${sum.stopReason === "throttled" ? " (Kinetic bucket drained — un-answered targets stay queued; re-run later to sweep)" : ""}`);
  console.log(`rounds=${sum.rounds}  checks: ${sum.totalOk} ok / ${sum.totalBlocked} blocked / ${sum.totalNeutral} neutral`);
  console.log(`BLOCK RATE = ${(sum.blockRate * 100).toFixed(1)}%  ·  cwnd max=${sum.maxCwnd} final=${sum.finalCwnd}  ·  ${sum.effChecksPerMin}/min  ·  refreshes=${sum.sessionRefreshes}  ·  ${(sum.elapsedMs / 1000).toFixed(0)}s`);
  let L = 0, NF = 0, CS = 0, FQ = 0, FL = 0;
  for (const { c, source } of built) {
    const k = source.counters;
    L += k.leads; NF += k.newFiber; CS += k.comingSoon; FQ += k.fringeQueued; FL += k.fringeLeads;
    console.log(`  ${c.city.padEnd(12)} leads=${k.leads} newFiber=${k.newFiber} comingSoon=${k.comingSoon} noService=${k.noService} existing=${k.existing}${FRINGE ? ` · fringe=${k.fringeQueued}q/${k.fringeLeads}✓` : ""} (blk=${k.blocked} incon=${k.inconclusive} drop=${k.dropped})`);
  }
  console.log(`TOTAL: ${L} new leads · ${NF} new-fiber · ${CS} coming-soon watched${FRINGE ? ` · fringe: ${FQ} neighbor-probes → ${FL} leads OSM would have MISSED` : ""}`);

  // What's still queued (never conclusively scanned) — so "get every lead" is a
  // known, resumable state, not a silent gap. Re-run the same command later. Parked
  // (exhausted) addresses are reported SEPARATELY so a silenced address is never a
  // silent gap — they're Kinetic-unrecognized, not "will answer if you retry".
  let remaining = 0, parked = 0;
  for (const { c } of built) {
    // never-scanned, not-yet-parked remaining in the pool for this city
    remaining += loadCityPoolAddresses(c.city, c.zip, 1_000_000).length;
    parked += storage.getScanTargetExhaustedCount(c.city, c.zip);
  }
  if (remaining > 0) {
    console.log(`STILL QUEUED: ${remaining} address(es) un-answered (blocked/inconclusive under throttle). Re-run to sweep — the Kinetic rolling window refills over time.`);
  } else {
    console.log(`POOL DRAINED: every harvestable address for these cities has a conclusive result${parked > 0 ? " (parked ones excluded)" : ""}.`);
  }
  if (parked > 0) {
    console.log(`GIVEN UP: ${parked} address(es) parked after ${INCONCLUSIVE_GIVEUP}+ inconclusive probes (Kinetic doesn't recognize them — likely Mapbox-grid over-capture). Excluded from re-probe; run with --retryexhausted to force a recheck.`);
  }
  process.exit(0);
})();
