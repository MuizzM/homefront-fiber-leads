// ── The knock list ───────────────────────────────────────────────────────────
//
// Turns the Kinetic build-front classification into something a person can act
// on today: the hottest blocks, the ranked doors inside them, and those doors
// grouped into walkable territories with a route order.
//
// READ THIS BEFORE SENDING ANYONE OUT
// Unless a door is listed as confirmed_2026 it is a CANDIDATE. The newest FCC
// filing describes 2025-12-31, so the strongest thing this evidence supports is
// "Kinetic was actively building this block through the end of 2025 and some
// premises here still had no Kinetic fiber". That is a good reason to knock and
// not a promise of serviceability - the rep verifies at the door, or an
// authorized address qualification confirms it first.
//
// USAGE
//   tsx script/kinetic-2026-report.ts --tenant 1
//   tsx script/kinetic-2026-report.ts --tenant 1 --class likely_2026 --limit 40
//   tsx script/kinetic-2026-report.ts --tenant 1 --territories

import { writeFileSync } from "node:fs";
import { rawDb } from "../server/db";
import { runMigrations } from "../server/storage";
import { importedVintages, TARGET_COUNTY_FIPS } from "../server/fccImportStore";
import { buildSummary, rankedBuilds } from "../server/kineticBuildStore";
import { groupIntoTerritories, routeOrder } from "@shared/kineticBuildRanking";
import { vintageOf } from "@shared/fccVintage";
import type { KineticBuildClass } from "@shared/kineticBuild2026";

const argv = process.argv.slice(2);
const flag = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const TENANT = Number(flag("tenant") ?? NaN);
const LIMIT = Math.max(1, Math.min(500, Number(flag("limit")) || 25));
const CLASS = (flag("class") ?? "likely_2026") as KineticBuildClass;
const TERRITORIES = argv.includes("--territories");

if (!Number.isInteger(TENANT) || TENANT <= 0) {
  console.error("Required: --tenant <positive org id>");
  process.exit(1);
}

function main() {
  runMigrations();
  const vintages = importedVintages(TENANT);
  const latest = vintages[vintages.length - 1];

  console.log(`\n=== Kinetic build front, org ${TENANT} ===`);
  console.log(`Evidence through ${latest ? vintageOf(latest).label : "no import"} (FCC BDC ${vintages.join(" -> ")})`);
  console.log(`Everything below except confirmed_2026 is a CANDIDATE - verify at the door.\n`);

  console.log("Classified doors:");
  console.table(buildSummary(TENANT));

  // The blocks themselves, ranked by how much of them Kinetic just lit.
  const blocks = rawDb.prepare(`
    SELECT s.block_geoid AS blockGeoid, s.county_fips AS countyFips, s.city AS city,
           COUNT(*) AS doors,
           f.kinetic_locations - COALESCE(p.kinetic_locations, 0) AS added,
           f.kinetic_locations AS served,
           f.total_residential_locations AS premises
      FROM kinetic_build_state s
      JOIN fcc_block_footprint f
        ON f.tenant_id = s.tenant_id AND f.block_geoid = s.block_geoid AND f.vintage = ?
      LEFT JOIN fcc_block_footprint p
        ON p.tenant_id = s.tenant_id AND p.block_geoid = s.block_geoid AND p.vintage = ?
     WHERE s.tenant_id = ? AND s.classification = ?
     GROUP BY s.block_geoid
     ORDER BY (CAST(f.kinetic_locations - COALESCE(p.kinetic_locations,0) AS REAL)
               / NULLIF(f.total_residential_locations,0)) DESC, doors DESC
     LIMIT 15
  `).all(latest, vintages[vintages.length - 2], TENANT, CLASS) as any[];

  if (blocks.length) {
    console.log(`\nHottest blocks holding ${CLASS} doors (share of the block Kinetic just lit):`);
    console.table(blocks.map((b) => ({
      block: b.blockGeoid,
      county: TARGET_COUNTY_FIPS[b.countyFips] ?? b.countyFips,
      city: b.city,
      "our doors": b.doors,
      "newly lit": b.added,
      "premises": b.premises,
      "% lit": b.premises ? `${Math.round((b.added / b.premises) * 100)}%` : "n/a",
    })));
  }

  const ranked = rankedBuilds(TENANT, { limit: LIMIT, poolMax: 5_000, classifications: [CLASS] });
  console.log(`\nTop ${ranked.length} doors to knock (${CLASS}):`);
  console.table(ranked.map((r, i) => ({
    "#": i + 1,
    address: r.address,
    city: r.city,
    score: r.score,
    why: r.explanation[0] ?? "",
    leadId: r.leadId ?? "-",
  })));

  if (TERRITORIES) {
    const pool = rankedBuilds(TENANT, { limit: 500, poolMax: 5_000, classifications: [CLASS] })
      .filter((r) => r.lat != null && r.lng != null)
      .map((r) => ({ id: r.id, lat: r.lat as number, lng: r.lng as number }));
    const byId = new Map(pool.map((d) => [d.id, d]));
    const addressById = new Map(
      rankedBuilds(TENANT, { limit: 500, poolMax: 5_000, classifications: [CLASS] }).map((r) => [r.id, r.address]),
    );
    const groups = groupIntoTerritories(pool, { maxDoors: 60, maxRadiusM: 1_200 });
    console.log(`\n${groups.length} walkable territories from the top ${pool.length} doors:`);
    console.table(groups.slice(0, 12).map((g, i) => ({
      territory: i + 1,
      doors: g.doors.length,
      "radius m": g.radiusM,
      centre: `${g.centroid.lat.toFixed(4)}, ${g.centroid.lng.toFixed(4)}`,
      "starts at": addressById.get(routeOrder(g.doors.map((id) => byId.get(id)!))[0]) ?? "",
    })));
  }
  console.log("");
}

main();

// ── Route sheet export ───────────────────────────────────────────────────────
// `--json <path>` writes the full territory + door detail a rep needs in the
// field, rather than the console summary above. Addresses are the deliverable:
// they are stable across databases (dev and prod share the FCC-derived doors),
// so a sheet generated here is workable in the live app by address search.
export function writeRouteSheet(path: string, tenant: number, klass: KineticBuildClass, topTerritories: number) {
  const vintages = importedVintages(tenant);
  const latest = vintages[vintages.length - 1];
  const baseline = vintages[vintages.length - 2];

  const all = rankedBuilds(tenant, { limit: 500, poolMax: 5_000, classifications: [klass] });
  const byId = new Map(all.map((r) => [r.id, r]));
  const pool = all.filter((r) => r.lat != null && r.lng != null)
    .map((r) => ({ id: r.id, lat: r.lat as number, lng: r.lng as number }));

  const blockPct = new Map<string, number>();
  for (const row of rawDb.prepare(`
    SELECT f.block_geoid AS b,
           CAST(f.kinetic_locations - COALESCE(p.kinetic_locations,0) AS REAL)
             / NULLIF(f.total_residential_locations,0) AS pct
      FROM fcc_block_footprint f
      LEFT JOIN fcc_block_footprint p
        ON p.tenant_id=f.tenant_id AND p.block_geoid=f.block_geoid AND p.vintage=?
     WHERE f.tenant_id=? AND f.vintage=?
  `).all(baseline, tenant, latest) as any[]) blockPct.set(row.b, row.pct ?? 0);

  const detail = rawDb.prepare(`SELECT id, block_geoid AS b, address, city, zip, lat, lng, lead_id AS leadId FROM kinetic_build_state WHERE id = ?`);

  const territories = groupIntoTerritories(pool, { maxDoors: 60, maxRadiusM: 1_200 })
    .slice(0, topTerritories)
    .map((group, index) => {
      const ordered = routeOrder(group.doors.map((id) => pool.find((d) => d.id === id)!));
      const doors = ordered.map((id) => {
        const d = detail.get(id) as any;
        return {
          address: d.address, city: d.city, zip: d.zip,
          lat: d.lat, lng: d.lng, leadId: d.leadId,
          block: d.b,
          blockNewlyLitPct: Math.round((blockPct.get(d.b) ?? 0) * 100),
          score: byId.get(id)?.score ?? 0,
        };
      });
      return {
        name: `Territory ${index + 1}`,
        doorCount: doors.length,
        radiusM: group.radiusM,
        centroid: group.centroid,
        city: doors[0]?.city ?? "",
        doors,
      };
    });

  const payload = {
    generatedFor: `tenant ${tenant}`,
    classification: klass,
    evidenceThrough: latest ? vintageOf(latest).label : null,
    vintages,
    totals: buildSummary(tenant),
    territories,
  };
  writeFileSync(path, JSON.stringify(payload, null, 2));
  console.log(`route sheet -> ${path} (${territories.length} territories, ${territories.reduce((n, t) => n + t.doorCount, 0)} doors)`);
}

if (argv.includes("--json")) {
  writeRouteSheet(flag("json") ?? "route-sheet.json", TENANT, CLASS, Number(flag("territories-count")) || 10);
}
