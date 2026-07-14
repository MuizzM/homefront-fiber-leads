import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

type CsvRow = Record<string, string>;

const STATES = [
  { state: "NC", fips: "37" },
  { state: "SC", fips: "45" },
] as const;

const ANNOUNCED_NC = new Map<string, { published: string; source: string }>([
  ["albemarle", { published: "2026-05-13", source: "https://investor.uniti.com/news-releases/news-release-details/north-carolina-benefits-7800-new-kinetic-fiber-builds" }],
  ["broadway", { published: "2026-05-13", source: "https://investor.uniti.com/news-releases/news-release-details/north-carolina-benefits-7800-new-kinetic-fiber-builds" }],
  ["concord", { published: "2026-05-13", source: "https://investor.uniti.com/news-releases/news-release-details/north-carolina-benefits-7800-new-kinetic-fiber-builds" }],
  ["indian trail", { published: "2026-05-13", source: "https://investor.uniti.com/news-releases/news-release-details/north-carolina-benefits-7800-new-kinetic-fiber-builds" }],
  ["kannapolis", { published: "2026-05-20", source: "https://investor.uniti.com/news-releases/news-release-details/kannapolis-now-gig-ready-community-kinetics-fiber-optic-network" }],
  ["lexington", { published: "2026-05-13", source: "https://investor.uniti.com/news-releases/news-release-details/north-carolina-benefits-7800-new-kinetic-fiber-builds" }],
  ["morven", { published: "2026-05-13", source: "https://investor.uniti.com/news-releases/news-release-details/north-carolina-benefits-7800-new-kinetic-fiber-builds" }],
  ["pinebluff", { published: "2026-05-13", source: "https://investor.uniti.com/news-releases/news-release-details/north-carolina-benefits-7800-new-kinetic-fiber-builds" }],
  ["tryon", { published: "2026-05-13", source: "https://investor.uniti.com/news-releases/news-release-details/north-carolina-benefits-7800-new-kinetic-fiber-builds" }],
  ["wingate", { published: "2026-05-13", source: "https://investor.uniti.com/news-releases/news-release-details/north-carolina-benefits-7800-new-kinetic-fiber-builds" }],
]);

function parseCsv(text: string): CsvRow[] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field.replace(/\r$/, "")); rows.push(row); row = []; field = ""; }
    else field += ch;
  }
  if (field || row.length) { row.push(field.replace(/\r$/, "")); rows.push(row); }
  const headers = rows.shift()?.map((h) => h.replace(/^\uFEFF/, "")) ?? [];
  return rows.filter((r) => r.some(Boolean)).map((values) => Object.fromEntries(headers.map((h, i) => [h, values[i] ?? ""])));
}

function parseTsv(text: string): CsvRow[] {
  const lines = text.trim().split(/\r?\n/);
  // Gazetteer files have used both pipe and tab delimiters across vintages.
  const delimiter = lines[0]?.includes("|") ? "|" : "\t";
  const headers = lines.shift()!.split(delimiter).map((h) => h.trim());
  return lines.map((line) => {
    const values = line.split(delimiter);
    return Object.fromEntries(headers.map((h, i) => [h, (values[i] ?? "").trim()]));
  });
}

async function download(url: string): Promise<string> {
  const response = await fetch(url, { headers: { "User-Agent": "HomeFrontFiber-MarketInventory/1.0 (operations@homefrontsolutions.com)" } });
  if (!response.ok) throw new Error(`Download failed ${response.status}: ${url}`);
  return response.text();
}

function cleanPlaceName(name: string): string {
  return name.replace(/\s+(city|town|village|borough)$/i, "").trim();
}

function csvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function main() {
  const outputRows: Record<string, unknown>[] = [];
  for (const { state, fips } of STATES) {
    const [estimateText, gazetteerText] = await Promise.all([
      download(`https://www2.census.gov/programs-surveys/popest/datasets/2020-2025/cities/totals/sub-est2025_${fips}.csv`),
      download(`https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2025_Gazetteer/2025_gaz_place_${fips}.txt`),
    ]);
    const estimates = parseCsv(estimateText);
    const gazetteer = parseTsv(gazetteerText);
    const coordinates = new Map(gazetteer.map((r) => [String(r.GEOID).padStart(7, "0"), r]));
    const counties = new Map(
      estimates.filter((r) => r.SUMLEV === "050").map((r) => [r.COUNTY.padStart(3, "0"), r.NAME.replace(/ County$/i, "")]),
    );
    const placeParts = new Map<string, CsvRow[]>();
    for (const row of estimates.filter((r) => r.SUMLEV === "157")) {
      const key = row.PLACE.padStart(5, "0");
      placeParts.set(key, [...(placeParts.get(key) ?? []), row]);
    }
    for (const row of estimates.filter((r) => r.SUMLEV === "162")) {
      const placeFips = row.PLACE.padStart(5, "0");
      const legalName = row.NAME.trim();
      const city = cleanPlaceName(legalName);
      const population = Number(row.POPESTIMATE2025 || row.POPESTIMATE2024 || 0);
      const parts = placeParts.get(placeFips) ?? [];
      const primary = parts.find((p) => p.PRIMGEO_FLAG === "1") ?? [...parts].sort((a, b) => Number(b.POPESTIMATE2025 || 0) - Number(a.POPESTIMATE2025 || 0))[0];
      const countyFips = primary?.COUNTY?.padStart(3, "0") ?? "";
      const allCounties = [...new Set(parts.map((p) => counties.get(p.COUNTY.padStart(3, "0"))).filter(Boolean))].sort();
      const geo = coordinates.get(`${fips}${placeFips}`);
      const announced = state === "NC" ? ANNOUNCED_NC.get(city.toLowerCase()) : undefined;
      const priorityClass = announced ? "critical" : population >= 50_000 ? "high" : population >= 10_000 ? "medium" : "low";
      const cadenceHours = priorityClass === "critical" ? 24 : priorityClass === "high" ? 48 : priorityClass === "medium" ? 168 : 336;
      const priorityScore = announced ? 100 : Math.min(90, Math.round(20 + Math.log10(Math.max(1, population)) * 14));
      outputRows.push({
        state, place_fips: placeFips, city, legal_name: legalName,
        county_fips: countyFips, county: counties.get(countyFips) ?? "",
        counties: allCounties.join("|"), population,
        lat: geo?.INTPTLAT ?? "", lng: geo?.INTPTLONG ?? "",
        priority_class: priorityClass, priority_score: priorityScore,
        priority_reason: announced ? `Official Kinetic/Uniti build announcement ${announced.published}` : `Population tier (${population.toLocaleString("en-US")})`,
        cadence_hours: cadenceHours, announcement_url: announced?.source ?? "",
        last_scanned: "", last_status: "unknown", fresh_flag: 0,
        source_vintage: "Census 2025 Subcounty Estimates + 2025 Gazetteer",
      });
    }
  }
  outputRows.sort((a, b) => String(a.state).localeCompare(String(b.state)) || Number(b.priority_score) - Number(a.priority_score) || String(a.city).localeCompare(String(b.city)));
  const headers = Object.keys(outputRows[0]);
  const csv = [headers.join(","), ...outputRows.map((row) => headers.map((h) => csvCell(row[h])).join(","))].join("\n") + "\n";
  const outDir = path.resolve(process.cwd(), "data");
  await mkdir(outDir, { recursive: true });
  const output = path.join(outDir, "nc_sc_kinetic_markets.csv");
  await writeFile(output, csv, "utf8");
  const counts = Object.fromEntries(STATES.map(({ state }) => [state, outputRows.filter((r) => r.state === state).length]));
  console.log(JSON.stringify({ output, total: outputRows.length, counts, critical: outputRows.filter((r) => r.priority_class === "critical").length }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
