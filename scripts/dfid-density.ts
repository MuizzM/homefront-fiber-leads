// Empirical test of the "density / clustering" premise: do a city's real Kinetic
// df-ids sit in tight runs in the number line (→ a jump-scanner wins), or do they
// scatter uniformly (→ jumping would skip real houses)? Decided from actual data.
import "dotenv/config";
import { rawDb } from "../server/db";

const rows = rawDb.prepare(
  "SELECT lower(city) city, df_address_id df FROM scan_targets WHERE df_address_id LIKE '8000%' " +
  "UNION SELECT lower(city) city, df_address_id df FROM leads WHERE df_address_id LIKE '8000%'"
).all() as { city: string; df: string }[];

const byCity = new Map<string, bigint[]>();
for (const r of rows) {
  if (!/^\d{22}$/.test(r.df)) continue;
  if (!byCity.has(r.city)) byCity.set(r.city, []);
  byCity.get(r.city)!.push(BigInt(r.df));
}

const pct = (n: number, d: number) => d ? `${((100 * n) / d).toFixed(0)}%` : "—";
const fmt = (b: bigint) => b >= 1_000_000n ? `${(Number(b) / 1e6).toFixed(1)}M` : b >= 1000n ? `${(Number(b) / 1e3).toFixed(1)}k` : `${b}`;

console.log("city            n     span        meanGap    medianGap   gaps≤10  ≤100  ≤1k   ≤10k   |  clusters  probes/hit(jump vs full)");
console.log("─".repeat(118));

let totHits = 0, totClusterMembers = 0;
for (const [city, arr] of [...byCity.entries()].sort((a, b) => b[1].length - a[1].length)) {
  const ids = [...new Set(arr.map(String))].map(BigInt).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const n = ids.length;
  if (n < 40) continue;
  const gaps: bigint[] = [];
  for (let i = 1; i < n; i++) gaps.push(ids[i] - ids[i - 1]);
  const span = ids[n - 1] - ids[0];
  const meanGap = span / BigInt(n - 1);
  const sortedGaps = [...gaps].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const medianGap = sortedGaps[Math.floor(sortedGaps.length / 2)];
  const le = (t: bigint) => gaps.filter((g) => g <= t).length;
  // "Cluster" = a run of hits each within 2000 of the previous (a built-out block).
  const T = 2000n;
  let clusters = 0, clusterMembers = 0, inRun = false;
  for (const g of gaps) {
    if (g <= T) { if (!inRun) { clusters++; clusterMembers++; inRun = true; } clusterMembers++; }
    else inRun = false;
  }
  totHits += n; totClusterMembers += clusterMembers;
  // Probes to FIND all n: full sweep ≈ span; jump-scan ≈ (probe densely only inside
  // clusters + one sentinel per void). Rough model: clusterMembers dense probes +
  // (#voids × sentinel). Report probes-per-hit for each.
  const fullPerHit = Number(span) / n;
  const voids = n - clusterMembers; // isolated hits each need their own discovery
  const jumpPerHit = (clusterMembers * 1.2 + voids * 1) / n; // dense-in-cluster + 1 each isolated
  console.log(
    `${city.padEnd(14)} ${String(n).padStart(4)}  ${fmt(span).padStart(9)}  ${fmt(meanGap).padStart(9)}  ${fmt(medianGap).padStart(9)}   ` +
    `${pct(le(10n), gaps.length).padStart(5)} ${pct(le(100n), gaps.length).padStart(5)} ${pct(le(1000n), gaps.length).padStart(5)} ${pct(le(10000n), gaps.length).padStart(5)}  |  ` +
    `${pct(clusterMembers, n).padStart(5)} in ${clusters} runs   full≈${fullPerHit.toExponential(1)}  jump≈${jumpPerHit.toFixed(1)}`
  );
}

console.log("─".repeat(118));
console.log(`OVERALL: ${totHits} hits · ${pct(totClusterMembers, totHits)} sit in a tight run (≤2000 apart) vs isolated`);
console.log(`VERDICT: if 'gaps≤1k' and cluster-% are LOW, addresses SCATTER → a jump-scanner would skip real houses (do NOT build it).`);
console.log(`         if HIGH, addresses come in built-out blocks → jump-scan inside clusters, skip voids (big win).`);
process.exit(0);
